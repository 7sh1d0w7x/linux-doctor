// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync, writeFileSync } from "node:fs";
import { atomicWrite } from "./fsx.js";
import { run, runPool, lines, withDeadline, setDebug } from "./utils.js";
import { normalizeFindings, invalidFindings } from "./findings.js";
import { checks as CHECKS } from "./checks/index.js";
import { systemInfo } from "./checks/system.js";
import { isPro, proInfo } from "./license.js";
import { loadProModule } from "./pro.js";
import { shouldAlert, buildAlert, sendAlert } from "./alert.js";
import { pingHeartbeat } from "./heartbeat.js";
import { renderReport, renderJson, renderPlain, renderTodo, SEV_ORDER, countBySeverity, pickNextFinding, jsonForInlineScript } from "./report.js";
import { renderMarkdown } from "./markdown.js";
import { aiSummary } from "./llm.js";
import { pushReport, validatePushUrl, redactUrl } from "./fleet.js";
import { startWeb } from "./web.js";
import { score, scoreBreakdown, loadHistory, diffSinceLast, saveRun, previousScore, changeMessage, isHistoryDisabled, cleanStreak } from "./history.js";
import { buildSupportBundle, writeSupportBundle, supportMessage, scrub, scrubFinding, scrubDeep } from "./support.js";
import { createRecorder, recordPath } from "./record.js";
import { loadIgnore, loadIgnoreCodes, isIgnored, isCodeIgnored, addIgnore, addIgnoreCode, removeIgnore, removeIgnoreCode } from "./ignore.js";
import { loadConfig } from "./config.js";
import { loadThresholds, DEFAULT_THRESHOLDS, coerceThreshold } from "./thresholds.js";
import { detectDistro } from "./distro.js";
import { detectProfile } from "./profile.js";
import { dedupe } from "./dedupe.js";
import { parseArgs } from "./args.js";
import { reportSchema } from "./schema.js";
import { loadPlugins } from "./plugins.js";
import { configFile } from "./config.js";
import { planFixes, formatPlan } from "./fix.js";
import { runInteractive } from "./interactive.js";
import { canNotify, sendNotification, shouldNotify, notificationFor } from "./notify.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// How many checks may run at once. Checks spawn subprocesses internally, so
// an unbounded Promise.all over 26 checks would launch dozens of commands
// simultaneously; 4 keeps a full run fast without hammering the machine.
const RUN_CONCURRENCY = 4;

// Wall-clock cap for a single check. A check with many sequential commands
// (one per device/timer/pool) must not be able to stretch a run unboundedly;
// on expiry it is recorded in checkErrors and the run continues.
const CHECK_DEADLINE_MS = 45000;

/** Group checks by category, preserving first-appearance order. */
function groupByCategory(checks) {
  const groups = new Map();
  for (const c of checks) {
    if (!groups.has(c.category)) groups.set(c.category, []);
    groups.get(c.category).push(c);
  }
  return groups;
}

/** "category\n  id — title" blocks, used by --help and --list. */
function formatChecks(checks) {
  const lines = [];
  for (const [cat, list] of groupByCategory(checks)) {
    lines.push(`${cat}`);
    for (const c of list) lines.push(`  ${c.id} — ${c.title}${c.premium ? "  (Pro)" : ""}`);
  }
  return lines.join("\n");
}

/** Like formatChecks, but marks checks that do not apply to this machine. */
function formatChecksForSystem(checks, profile) {
  const lines = [];
  for (const [cat, list] of groupByCategory(checks)) {
    lines.push(`${cat}`);
    for (const c of list) {
      const applies = c.appliesTo.includes(profile.kind);
      lines.push(`  ${c.id} — ${c.title}${c.premium ? "  (Pro)" : ""}${applies ? "" : `  (n/a on ${profile.kind})`}`);
    }
  }
  return lines.join("\n");
}

/** --self-test: explain the environment — distro, profile, tools, and which
 * checks will actually run (and why others will not). Read-only, no run. */
async function runSelfTest(checks) {
  await loadProModule();
  const [system, profile] = await Promise.all([systemInfo(), detectProfile()]);
  const out = [];
  out.push("# linux-doctor --self-test");
  out.push("");
  out.push(`Distro: ${system.distro} (family: ${system.family}${system.imageBased ? ", image-based: yes" : ""})`);
  out.push(`Profile: ${profile.kind}`);
  out.push(`Pro: ${proInfo().active ? "active" : "not active (premium checks and features disabled)"}`);
  out.push(`Kernel: ${system.kernel} · ${system.cores} core(s) · up ${system.uptime}`);

  const toolsRes = await run(
    "for t in systemctl journalctl coredumpctl loginctl timedatectl lspci lsblk smartctl free nproc glxinfo pactl ip nft podman docker dnf apt pacman zypper rpm-ostree snap sshd borg restic; do command -v \"$t\" 2>/dev/null; done"
  );
  const present = lines(toolsRes.stdout).map((p) => p.split("/").pop()).filter(Boolean);
  out.push(`Tools present: ${present.length > 0 ? present.join(", ") : "(none found)"}`);
  out.push("");

  const willRun = [];
  const skipped = [];
  for (const c of checks) {
    (c.appliesTo.includes(profile.kind) ? willRun : skipped).push(c);
  }
  out.push(`Checks: ${willRun.length} will run here, ${skipped.length} will not.`);
  out.push("");
  if (skipped.length > 0) {
    out.push("Checks that will NOT run on this machine:");
    for (const c of skipped) out.push(`  ${c.id} — ${c.title} (applies to ${c.appliesTo.join("/")})`);
    out.push("");
  }
  out.push(`Checks that will run:\n  ${willRun.map((c) => c.id).join(", ")}`);
  return out.join("\n");
}

/**
 * Starter config with the shipped thresholds — written by --init-config
 * (and the --init wizard). Values come from DEFAULT_THRESHOLDS
 * (src/thresholds.js) so the example can never drift from the defaults;
 * unset keys keep the defaults at load.
 */
export function starterConfig() {
  return JSON.stringify({
    // Linux Doctor Pro license key (optional): read by the installed Pro
    // add-on. Setting LINUX_DOCTOR_LICENSE overrides this file.
    licenseKey: "",
    // Hide findings whose title contains this text (case-insensitive substring match).
    ignore: [],
    // Hide findings by stable code (exact match, e.g. "services/failed").
    ignoreCodes: [],
    // Severity thresholds — override defaults. Remove lines to keep defaults.
    thresholds: { ...DEFAULT_THRESHOLDS },
  }, null, 2) + "\n";
}

/**
 * The shared option fields for every renderJson call site (--json, --html and
 * the dashboard's /api/report) so the three payloads can never drift apart.
 * Site-specific extras (durationMs, durations) merge on top.
 */
function jsonOptions(r, extra = {}) {
  return {
    generatedAt: r.generatedAt,
    score: r.score,
    // Per-finding penalties — the score's arithmetic, auditable in every channel.
    scoreBreakdown: r.scoreBreakdown,
    scoreDelta: r.scoreDelta,
    previousScore: r.previousScore,
    newCount: r.newCount,
    fixedCount: r.fixedCount,
    unchanged: r.unchanged,
    lastRunAt: r.lastRunAt,
    diffSinceLast: r.diffSinceLast,
    counts: r.counts,
    checkErrors: r.checkErrors,
    ignoredCount: r.ignoredCount,
    checksRun: r.checksRun,
    checksSkipped: r.checksSkipped,
    checksAtomicSkipped: r.checksAtomicSkipped,
    skippedChecks: r.skippedChecks,
    historyDisabled: r.historyDisabled,
    changeMessage: r.changeMessage,
    cleanStreak: r.cleanStreak,
    // The ▶ START HERE pick, as data — the dashboard renders this instead of
    // recomputing it, so banner and report can never disagree.
    nextAction: pickNextFinding(r.findings, r.categoryByCheck ?? null),
    ...extra,
  };
}

/**
 * The run pipeline, shared by a normal run and --compare so the two can never
 * drift apart: same context, same concurrency, same normalization, same
 * ignore and dedupe rules. `skipStaleIgnoreWarning` silences the "pattern
 * matched nothing" check for --compare (whose stderr is reserved for the diff).
 */
/**
 * Run the checks and build the report. Exported (and injectable) so a recorded
 * machine fixture can replay through the real pipeline — applicability, atomic
 * skips, ignore rules, dedupe — instead of a reimplementation that would drift.
 * `run`, `system` and `profile` default to the real probes.
 */
export async function collectReport({ checkIds, checks, ignorePatterns, ignoreCodes, thresholds, skipStaleIgnoreWarning = false, run: runFn = run, system: injectedSystem, profile: injectedProfile }) {
  const [system, profile] =
    injectedSystem && injectedProfile ? [injectedSystem, injectedProfile] : await Promise.all([systemInfo(), detectProfile()]);
  const cctx = { run: runFn, osRelease: system.osRelease, dist: detectDistro(system.osRelease), thresholds, profile };
  const selected = applicableChecks(checkIds, profile.kind, checks);
  // Atomic/immutable systems (Bazzite, Silverblue, rpm-ostree, bootc): some
  // checks draw conclusions that are false positives there (e.g. comparing the
  // booted kernel against /boot). They declare `skipOnAtomic`, and we drop them
  // centrally here — recording a clear reason instead of silently emitting
  // nothing — so the skip is visible in the report and JSON. Computed before
  // the run pool so `selectedChecks` is the list actually executed.
  const atomic = !!system.immutable;
  const { selected: selectedChecks, skipped: skippedChecks } = skippedOnAtomic(selected, atomic);
  const checkDurations = [];
  const checkErrors = [];
  const results = await runPool(selectedChecks, RUN_CONCURRENCY, async (c) => {
    const t0 = Date.now();
    // A check that throws must never take down the whole report: it is
    // recorded in checkErrors and the run continues without it.
    try {
      const out = (await withDeadline(() => c.run(cctx), CHECK_DEADLINE_MS, `check ${c.id}`)).map((f) => ({ ...f, check: c.id }));
      checkDurations.push({ check: c.id, ms: Date.now() - t0 });
      return out;
    } catch (err) {
      checkErrors.push({ check: c.id, error: err && err.message ? err.message : String(err) });
      checkDurations.push({ check: c.id, ms: Date.now() - t0 });
      return [];
    }
  });
  // Normalize identities FIRST (explicit code wins, then dedupeKey, then a
  // slug), so --ignore-code and history see the same stable key the report
  // uses. Ignore comes next (user intent wins), then dedupe collapses findings
  // that report the same root cause (e.g. software rendering is detected by
  // both the gpu and wayland checks) so one problem never counts twice.
  const normalized = normalizeFindings(results.flat());
  // A malformed finding (broken plugin, future bug) must never reach the
  // report: warn on stderr and drop it, the same way a throwing check is
  // recorded in checkErrors instead of aborting the run.
  const malformed = invalidFindings(normalized);
  for (const m of malformed) {
    console.error(`linux-doctor: finding from "${m.check}" is malformed (${m.errors.join(", ")}) — dropped`);
  }
  const all = normalized.filter((_, i) => !malformed.some((m) => m.index === i));
  const kept = all.filter((f) => !isIgnored(f.title, ignorePatterns) && !isCodeIgnored(f.code, ignoreCodes));
  const findings = dedupe(kept).map((f, i) => ({ id: i + 1, ...f }));
  // Tell the user when an ignore pattern is stale — a silent no-op means
  // the pattern will rot unnoticed as finding titles change. Skipped in web
  // mode: the dashboard re-runs checks constantly and would spam the log.
  if (!skipStaleIgnoreWarning) {
    for (const p of new Set(ignorePatterns)) {
      if (!all.some((f) => isIgnored(f.title, [p]))) {
        console.error(`linux-doctor: ignore pattern "${p}" matched nothing — finding titles may have changed`);
      }
    }
  }
  // selectedChecks (computed above) replaces selected for the run count;
  // selected is kept only so appliesTo-based checksSkipped can be computed.
  const checksRun = selectedChecks.length;
  const checksSkipped = checkIds.length ? 0 : checks.length - selected.length;
  const checksAtomicSkipped = skippedChecks.length;
  return {
    generatedAt: new Date().toISOString(),
    system: { ...system, kind: profile.kind },
    findings,
    checkDurations,
    checkErrors,
    ignoredCount: all.length - kept.length,
    checksRun,
    checksSkipped,
    checksAtomicSkipped,
    skippedChecks,
  };
}

/**
 * --compare: show what changed between a previous report and the current run.
 * The previous report is the JSON file passed as the argument; the current
 * report is what a fresh run produces. Differences are grouped by severity.
 * Runs the same pipeline as a normal run (plugins, ignore patterns, dedupe)
 * so the diff compares apples to apples.
 */
async function runCompare(previous, checks, ignorePatterns, ignoreCodes, thresholds) {
  const report = await collectReport({
    checkIds: [],
    checks,
    ignorePatterns,
    ignoreCodes,
    thresholds,
    skipStaleIgnoreWarning: true,
  });
  const current = report.findings;

  const prevCodes = new Set((previous.findings || []).map((f) => f.code));
  const curCodes = new Set(current.map((f) => f.code));
  const added = current.filter((f) => !prevCodes.has(f.code));
  const fixed = (previous.findings || []).filter((f) => !curCodes.has(f.code));

  if (added.length === 0 && fixed.length === 0) {
    console.log("No changes since the previous report.");
    return 0;
  }

  const out = [];
  if (added.length > 0) {
    out.push(`🔴 ${added.length} new finding(s):`);
    for (const f of added) out.push(`   [${f.severity}] ${f.title}`);
  }
  if (fixed.length > 0) {
    out.push(`🟢 ${fixed.length} fixed finding(s):`);
    for (const f of fixed) out.push(`   [${f.severity}] ${f.title}`);
  }
  console.log(out.join("\n"));
  return added.some((f) => f.severity === "high" || f.severity === "medium") ? 1 : 0;
}

/**
 * Which checks run. An explicit --check list always wins (user intent); a
 * full run skips checks whose appliesTo does not include the machine kind
 * (e.g. the battery check on a desktop). `checks` defaults to the built-in
 * registry; callers with plugins pass the merged list.
 */
export function applicableChecks(checkIds, kind, checks = CHECKS) {
  const base = checkIds.length ? checks.filter((c) => checkIds.includes(c.id)) : checks;
  return checkIds.length ? base : base.filter((c) => c.appliesTo.includes(kind));
}

/**
 * Split a check list into what runs and what is intentionally skipped because
 * this is an immutable/atomic system. Pure and exported so it can be tested
 * without running subprocesses. `skipOnAtomic` checks declare they are
 * meaningless on ostree/bootc (e.g. reboot's kernel comparison against /boot);
 * each skipped check carries its `atomicReason` so the skip is transparent in
 * the report and JSON rather than silently yielding zero findings.
 */
export function skippedOnAtomic(checks, atomic) {
  if (!atomic) return { selected: checks, skipped: [] };
  const skipped = [];
  const selected = checks.filter((c) => {
    if (c.skipOnAtomic) {
      skipped.push({ id: c.id, title: c.title, reason: c.atomicReason || "Not applicable on an immutable/atomic system." });
      return false;
    }
    return true;
  });
  return { selected, skipped };
}

/** "⏱ Check durations" section for --profile (text output). */
function formatDurations(durations) {
  const sorted = [...durations].sort((a, b) => b.ms - a.ms);
  const lines = ["", "⏱ Check durations:"];
  for (const d of sorted) lines.push(`  ${d.check.padEnd(16)} ${d.ms}ms`);
  return lines.join("\n");
}

/** "# duration: <id> <ms>ms" rows for --profile --plain. */
function formatPlainDurations(durations) {
  return [...durations].sort((a, b) => b.ms - a.ms).map((d) => `# duration: ${d.check} ${d.ms}ms`).join("\n");
}

export const HELP = `🩺 Linux Doctor — plain-English health checks for your Linux system.

USAGE
  linux-doctor [options]

OPTIONS
  --check <id>   run only the given check(s), comma-separated or repeated
  --list         list the checks without running them
  --check-list   list checks as JSON (id, title, category, appliesTo)
  --history-json print run history as JSON (used by the desktop app)
  --thresholds-json  print current thresholds + defaults as JSON
  --thresholds-set <j> merge known thresholds from a JSON payload into the config
  --json         print findings as JSON (machine-readable)
  --plain        print plain, tab-separated text (no colors/emoji; grep-friendly)
  --summary      one-liner: score + severity counts (for cron/scripts)
   --todo         numbered, copy-pasteable list of what to run, in order
   --fix          dry run: show the safe-fix commands for the findings found
   --fix --yes    execute the [apply] safe-fix commands ([manual] never runs)
   --interactive  browse findings in the terminal (arrows, details, copy)
   --notify       desktop notification (notify-send) when new issues appear
  --self-test    explain the environment: distro, profile, which checks run
  --web          open the visual dashboard in your browser (recommended)
  --ai           add an AI summary in plain English (needs LLM_API_KEY)
  --ai-local     same, but use a local Ollama model (no cloud, fully private)
  --html <path>  save a standalone HTML report (open in any browser)
  --md <path>    save a share-ready Markdown report (IPs and home paths redacted)
  --compare <f>  diff a previous JSON report against the current run
  --push <url>   post the report to a fleet server (FLEET_API_KEY optional)
  --severity <s> show only findings at this severity (high, medium, info)
   --ignore <txt> hide findings whose title contains <txt>
   --ignore-code <c> hide findings by stable code (e.g. services/failed)
   --ignore-add <v>  persistently ignore a code or title fragment (saved to config)
   --ignore-remove <v> remove a previously ignored code or title fragment
   --ignore-list  show configured ignore patterns and exit
   --ignore-list-json  same, as JSON (used by the desktop app)
  --init         guided first-run setup (config, daily timer, notification test)
  --init-config  create a starter config file at ~/.config/linux-doctor/config.json
  --schema       print the JSON Schema for --json output (v1)
  --profile      append per-check durations to the report
  --support      write a privacy-safe support bundle (JSON) for issues/forums
  --no-history   do not read or write run history (no new/fixed tracking)
  --history-clear clear stored run history
  --install-timer    install the user systemd timer (daily run + --notify, no sudo)
  --uninstall-timer  remove and disable the user timer installed by --install-timer
  --license      show the Linux Doctor Pro add-on status and exit
  --alert <url>  POST an alert webhook when the machine degrades [Pro]
  --heartbeat <url> ping a dead-man's switch after every run [Pro]
  --allow-private-endpoint  let --push/--alert/--heartbeat/--ai target private/LAN addresses
  --debug        trace every command and its result to stderr (or LINUX_DOCTOR_DEBUG=1)
  --daemon       run continuously, re-checking every --interval seconds [Pro]
  --interval <s> seconds between --daemon runs (default 3600) [Pro]
  --help         show this help
  --version      show the version

PRO ADD-ON
  Linux Doctor Pro (premium checks, alerting, scheduled agent, advanced AI)
  ships as a separate proprietary package — it is intentionally NOT part of
  this repository. Free users never see it listed; buyers install it over
  this edition. Tiers & distribution: COMMERCIAL-LICENSE.md.

CHECKS (grouped by category)
${formatChecks(CHECKS)}

Linux Doctor is read-only by default. The only commands it ever runs itself
come from the built-in safe-fix catalog (src/fix.js) and only with --fix --yes.
`;

export async function main(argv) {
  const args = parseArgs(argv);

  if (args.error) {
    console.error(`linux-doctor: ${args.error}`);
    return 2;
  }
  setDebug(args.debug);
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (args.version) {
    console.log(`${pkg.name} ${pkg.version}`);
    return 0;
  }
  if (args.severity && !SEV_ORDER.includes(args.severity)) {
    console.error(`linux-doctor: --severity must be one of: high, medium, info (got "${args.severity}")`);
    return 2;
  }

  // Plugins are user-provided checks from ~/.config/linux-doctor/checks/ (or
  // $LINUX_DOCTOR_PLUGINS). A broken or colliding plugin is skipped with a
  // warning — it must never take down a run. Loaded before the --compare and
  // run branches so both use the same merged check list.
  const config = loadConfig();
  // Pro checks are merged in only when a valid license key is configured —
  // in the free edition they do not exist: not run, not listed, not known to
  // --check. The key can live in LINUX_DOCTOR_LICENSE or config.licenseKey.
  // Load the optional Pro add-on first — isPro() reflects what it reports.
  const proState = await loadProModule();
  const pro = isPro();
  const builtinIds = new Set(CHECKS.map((c) => c.id));
  const plugins = (await loadPlugins()).filter((p) => {
    if (builtinIds.has(p.id)) {
      console.error(`linux-doctor: plugin "${p.id}" collides with a built-in check — skipping`);
      return false;
    }
    return true;
  });
  const checks = [...CHECKS, ...(pro ? proState.checks : []), ...plugins];

  // --license: report the Pro add-on status and exit.
  if (args.license) {
    const info = proInfo();
    console.log(info.active ? `Linux Doctor Pro active (sub: ${info.sub ?? "?"})` : `Linux Doctor Pro: ${info.reason}`);
    return info.active ? 0 : 1;
  }

  // --ignore <text> adds a pattern for this run only; the config file
  // (~/.config/linux-doctor/config.json) holds the persistent list.
  const ignorePatterns = [...loadIgnore(), ...args.ignore];
  const ignoreCodes = [...loadIgnoreCodes(), ...args.ignoreCodes];
  const thresholds = loadThresholds(config);

  // Pro-only flags are rejected up front in the free edition — the premium
  // features simply do not exist without a key.
  if ((args.alertUrl || args.daemon || args.interval || args.heartbeatUrl) && !pro) {
    console.error("linux-doctor: --alert, --daemon, --heartbeat and --interval are Linux Doctor Pro features — install the Pro add-on to use them (see README #tiers)");
    return 2;
  }
  if (args.interval !== null && (!Number.isInteger(Number(args.interval)) || Number(args.interval) < 1)) {
    console.error(`linux-doctor: --interval must be a positive number of seconds (got "${args.interval}")`);
    return 2;
  }
  // A mistyped fleet URL should fail fast with a clear message, not with a
  // generic fetch error after a full check run (or mid-daemon-cycle).
  // The apiKey is passed so the guard can refuse plaintext HTTP to a
  // non-loopback host — a Bearer token must never leave the machine in the
  // clear. pushReport/sendAlert re-check the same rule at send time.
  if ((args.pushUrl || args.alertUrl || args.heartbeatUrl)) {
    const apiKey = process.env.FLEET_API_KEY;
    for (const [flag, url] of [["--push", args.pushUrl], ["--alert", args.alertUrl], ["--heartbeat", args.heartbeatUrl]]) {
      if (!url) continue;
      const err = validatePushUrl(url, { apiKey });
      if (err) {
        console.error(`linux-doctor: ${flag}: ${err.replace(/^--push /, "")}`);
        return 2;
      }
    }
  }

  // --install-timer / --uninstall-timer: manage the user systemd timer and
  // exit — management commands never run checks (same contract as
  // --init-config and --history-clear).
  if (args.installTimer || args.uninstallTimer) {
    if (args.installTimer && args.uninstallTimer) {
      console.error("linux-doctor: choose either --install-timer or --uninstall-timer, not both");
      return 2;
    }
    const units = await import("./units.js");
    const res = args.installTimer ? units.installTimer() : units.uninstallTimer();
    if (res.ok) {
      console.log(res.message);
      return 0;
    }
    console.error(`linux-doctor: ${res.error}`);
    return 2;
  }

  // --init: guided first-run setup, then exit (never runs checks).
  if (args.init) {
    const { runWizard } = await import("./wizard.js");
    return runWizard();
  }

  // --init-config: create a starter config file and exit.
  if (args.initConfig) {
    const file = configFile();
    try {
      if (!atomicWrite(file, starterConfig())) throw new Error("could not write " + file);
      console.log(`Config written to ${file}`);
    } catch (err) {
      console.error(`linux-doctor: could not write config: ${err.message}`);
      return 2;
    }
    return 0;
  }

  /** Shared renderer for the persistent ignore lists — one vocabulary everywhere. */
function printIgnoreLists(titles, codes) {
  if (titles.length === 0 && codes.length === 0) {
    console.log("No ignore patterns configured.");
    return;
  }
  if (titles.length > 0) {
    console.log("Title patterns:");
    for (const p of titles) console.log(`  - ${p}`);
  }
  if (codes.length > 0) {
    console.log("Code patterns:");
    for (const c of codes) console.log(`  - ${c}`);
  }
}

// --ignore-add / --ignore-remove: manage the persistent ignore list from
  // the CLI (the dashboard's Ignore button writes the same config keys).
  // A value shaped like a stable code ("check/reason") targets ignoreCodes
  // (exact match); anything else is a title fragment (substring match).
  if (args.ignoreAdd !== null || args.ignoreRemove !== null) {
    const looksLikeCode = (v) => /^[a-z0-9-]+\/[a-z0-9-]+$/.test(v);
    let ok = true;
    for (const [mode, value] of [["add", args.ignoreAdd], ["remove", args.ignoreRemove]]) {
      if (value === null || value === undefined) continue;
      const isCode = looksLikeCode(value);
      const res = mode === "add"
        ? (isCode ? addIgnoreCode(value) : addIgnore(value))
        : (isCode ? removeIgnoreCode(value) : removeIgnore(value));
      const kind = isCode ? "code" : "title pattern";
      if (res) {
        console.log(`${mode === "add" ? "✓ Added" : "✓ Removed"} ${kind}: ${value}`);
      } else {
        ok = false;
        console.error(mode === "add"
          ? `linux-doctor: could not add ${kind} "${value}" (config file not writable?)`
          : `linux-doctor: ${kind} "${value}" was not in the ignore list`);
      }
    }
    const titles = loadIgnore();
    const codes = loadIgnoreCodes();
    if (titles.length === 0 && codes.length === 0) {
      console.log("Ignore list is now empty.");
    } else {
      printIgnoreLists(titles, codes);
    }
    return ok ? 0 : 2;
  }

  // --compare: diff two JSON report files and exit.
  if (args.comparePath) {
    try {
      const other = JSON.parse(readFileSync(args.comparePath, "utf8"));
      return await runCompare(other, checks, ignorePatterns, ignoreCodes, thresholds);
    } catch (err) {
      console.error(`linux-doctor: could not read compare file: ${err.message}`);
      return 2;
    }
  }

  if (args.schema) {
    console.log(JSON.stringify(reportSchema, null, 2));
    return 0;
  }

  // --ignore-list: show configured ignore patterns and exit.
  if (args.ignoreList) {
    printIgnoreLists(loadIgnore(), loadIgnoreCodes());
    return 0;
  }

  // --ignore-list-json: the same data, machine-readable. The desktop shell's
  // dashboard reads it for its ignored-findings section (--ignore-list is text).
  if (args.ignoreListJson) {
    console.log(JSON.stringify({ patterns: loadIgnore(), codes: loadIgnoreCodes(), path: configFile() }));
    return 0;
  }

  // --check-list: print check metadata as JSON and exit.
  if (args.checkList) {
    const profile = await detectProfile();
    const list = checks.map((c) => ({
      id: c.id,
      title: c.title,
      category: c.category,
      appliesTo: c.appliesTo,
      appliesHere: c.appliesTo.includes(profile.kind),
      skipOnAtomic: !!c.skipOnAtomic,
      atomicReason: c.skipOnAtomic ? (c.atomicReason || "") : "",
      premium: !!c.premium,
    }));
    console.log(JSON.stringify(list, null, 2));
    return 0;
  }

  // Machine-facing endpoints for the desktop shell (src-tauri serves them on
  // loopback). Hidden from --help: users reach these through the app UI.
  if (args.historyJson) {
    console.log(JSON.stringify({ runs: loadHistory() }));
    return 0;
  }

  if (args.historyClear) {
    const { clearHistory } = await import("./history.js");
    const ok = clearHistory();
    console.log(ok ? "History cleared." : "No history to clear.");
    return 0;
  }

  if (args.thresholdsJson) {
    console.log(JSON.stringify({ thresholds: loadThresholds(loadConfig()), defaults: DEFAULT_THRESHOLDS }));
    return 0;
  }

  if (args.thresholdsSet != null) {
    try {
      const parsed = JSON.parse(args.thresholdsSet || "{}");
      const incoming = parsed.thresholds || parsed;
      const cfg = loadConfig();
      // Merge over the saved values, then keep only known keys (same policy
      // as the web dashboard's POST /api/thresholds).
      const merged = { ...(cfg.thresholds || {}), ...incoming };
      const clean = {};
      for (const k of Object.keys(DEFAULT_THRESHOLDS)) if (k in merged) {
        const v = coerceThreshold(merged[k]);
        if (v !== null) clean[k] = v;
      }
      const next = { ...cfg, thresholds: clean };
      const file = configFile();
      if (!atomicWrite(file, JSON.stringify(next, null, 2) + "\n")) throw new Error("could not write " + file);
      console.log(JSON.stringify({ ok: true, thresholds: clean }));
      return 0;
    } catch (err) {
      console.log(JSON.stringify({ ok: false, error: err.message }));
      return 2;
    }
  }

  if (args.list) {
    const profile = await detectProfile();
    console.log(formatChecksForSystem(checks, profile));
    return 0;
  }

  if (args.selfTest) {
    console.log(await runSelfTest(checks));
    return 0;
  }

  const unknown = args.checkIds.find((id) => !checks.some((c) => c.id === id));
  if (unknown) {
    console.error(`Unknown check "${unknown}". Run with --help to list checks.`);
    return 2;
  }

  // LINUX_DOCTOR_RECORD=<path>: capture every command output so this run can be
  // replayed later as a regression fixture. A contribution tool (CONTRIBUTING.md),
  // not part of the normal surface; it changes nothing a check sees.
  const recorder = recordPath() ? createRecorder(run) : null;

  const collect = async () => {
    const report = await collectReport({
      checkIds: args.checkIds,
      checks,
      ignorePatterns,
      ignoreCodes,
      thresholds,
      run: recorder ? recorder.run : run,
      // Web mode skips the stale-ignore warning: the dashboard re-runs checks
      // constantly and would otherwise spam the log.
      skipStaleIgnoreWarning: args.web || args.daemon,
    });
    if (recorder) {
      const target = recorder.write(recordPath(), { report });
      if (target) {
        console.error(
          `linux-doctor: recorded ${recorder.commandCount} command(s) to ${target} — review and justify it before committing`,
        );
      } else {
        console.error("linux-doctor: could not write the recorded fixture (check the path's directory).");
      }
    }
    return report;
  };

  // Attach health score, severity counts, and "new since last check" flags.
  // In web mode we do NOT save a history entry (the dashboard may re-run the
  // checks many times; only CLI/desktop runs move the history forward).
  // Defined before the --daemon branch: the agent loop calls it every cycle.
  const attachHistory = (data, { save = true } = {}) => {
    const historyOff = isHistoryDisabled({ cliFlag: args.noHistory });
    const sc = score(data.findings);
    const counts = Object.fromEntries(countBySeverity(data.findings).map(({ severity, count }) => [severity, count]));

    // History off (--no-history / LINUX_DOCTOR_NO_HISTORY) or a subset run
    // (--check): neither moves history forward nor claims new/fixed. Both stay
    // predictable — a clean, neutral report with historyDisabled flagged only
    // when history was explicitly turned off.
    if (historyOff || args.checkIds.length > 0) {
      return {
        ...data,
        score: sc,
        scoreBreakdown: scoreBreakdown(data.findings),
        scoreDelta: null,
        previousScore: null,
        counts,
        newCount: 0,
        fixedCount: 0,
        unchanged: 0,
        diffSinceLast: { added: [], fixed: [], unchanged: data.findings.length },
        historyDisabled: historyOff,
        changeMessage: null,
        historyRuns: [],
        cleanStreak: 0,
        categoryByCheck,
        findings: data.findings.map((f) => ({ ...f, isNew: false })),
      };
    }

    const runs = loadHistory();
    const prevSc = previousScore(runs);
    const scoreDelta = typeof sc === "number" && typeof prevSc === "number" ? sc - prevSc : null;

    const diff = diffSinceLast(data.findings, runs);
    const prevAt = runs.length ? runs[runs.length - 1].at : null;
    // LINUX_DOCTOR_NO_SAVE is set by the desktop shell: its dashboard polls
    // /report every 20s, and every poll recording a history entry would churn
    // the new/fixed story. Polls still READ history (the diff stays honest),
    // they just never advance it — same as the --web dashboard.
    if (save && !process.env.LINUX_DOCTOR_NO_SAVE) {
      saveRun({
        at: new Date().toISOString(),
        score: sc,
        counts,
        findings: data.findings.map((f) => ({ code: f.code, severity: f.severity, title: f.title })),
      });
    }
    // Match by stable code, not title — volatile titles ("3 services failed"
    // vs "2 services failed") must not churn the new/fixed markers.
    const addedKeys = new Set(diff.added.map((f) => f.code));
    const curClean = counts.high === 0 && counts.medium === 0;
    return {
      ...data,
      score: sc,
      scoreBreakdown: scoreBreakdown(data.findings),
      scoreDelta,
      previousScore: prevSc,
      counts,
      newCount: diff.added.length,
      fixedCount: diff.fixed.length,
      unchanged: diff.unchanged,
      lastRunAt: prevAt,
      diffSinceLast: diff,
      historyDisabled: false,
      changeMessage: changeMessage({ newCount: diff.added.length, fixedCount: diff.fixed.length }),
      historyRuns: runs,
      cleanStreak: curClean ? cleanStreak(runs) + 1 : 0,
      categoryByCheck,
      findings: data.findings.map((f) => ({ ...f, isNew: addedKeys.has(f.code) })),
    };
  };

  // check id → category, for clustering and tagging findings in the report.
  const categoryByCheck = new Map(checks.map((c) => [c.id, c.category]));

  // --daemon: the scheduled agent. Re-runs the full report every --interval
  // seconds, pushing to the fleet server and/or alerting the webhook when
  // configured. Run it under systemd (see packaging/README.md) and it becomes
  // the "scheduled reporting" half of Pro.
  // --support: write a single, privacy-safe JSON bundle for forums / issues /
  // support, then exit. Read-only — it collects a normal run (without moving
  // history forward) and packages it with a short history tail.
  if (args.support) {
    const report = attachHistory(await collect(), { save: false });
    const bundle = buildSupportBundle({
      system: report.system,
      findings: report.findings,
      score: report.score,
      newCount: report.newCount,
      fixedCount: report.fixedCount,
      diffSinceLast: report.diffSinceLast,
      counts: report.counts,
      checksRun: report.checksRun,
      checksSkipped: report.checksSkipped,
      checksAtomicSkipped: report.checksAtomicSkipped,
      checkErrors: report.checkErrors,
      history: loadHistory(),
    });
    const path = writeSupportBundle(bundle);
    if (!path) {
      console.error("linux-doctor: could not write the support bundle (check write permissions for the current directory).");
      return 2;
    }
    console.log(supportMessage(path));
    return 0;
  }

  if (args.daemon) {
    const intervalMs = Number(args.interval ?? 3600) * 1000;
    process.on("SIGINT", () => process.exit(0));
    process.on("SIGTERM", () => process.exit(0));
    console.log(`linux-doctor agent: checking every ${intervalMs / 1000}s${args.pushUrl ? `, pushing to ${redactUrl(args.pushUrl)}` : ""}${args.alertUrl ? `, alerting ${redactUrl(args.alertUrl)}` : ""}${args.heartbeatUrl ? `, heartbeat ${redactUrl(args.heartbeatUrl)}` : ""}`);
    for (;;) {
      const t0 = Date.now();
      try {
        const report = attachHistory(await collect());
        console.log(`${new Date().toISOString()} score=${report.score} high=${report.counts.high} medium=${report.counts.medium} info=${report.counts.info} new=${report.newCount} (${Date.now() - t0}ms)`);
        if (args.notify && canNotify() && shouldNotify(report)) {
          sendNotification(notificationFor(report));
        }
        if (args.pushUrl) {
          try {
          await pushReport(args.pushUrl, {
            system: report.system,
            findings: report.findings.map(scrubFinding),
            score: report.score,
            newCount: report.newCount,
            fixedCount: report.fixedCount,
            diffSinceLast: report.diffSinceLast,
            skippedChecks: report.skippedChecks,
            checksAtomicSkipped: report.checksAtomicSkipped,
            changeMessage: report.changeMessage,
          }, { apiKey: process.env.FLEET_API_KEY, allowPrivate: args.allowPrivateEndpoint });
          } catch (err) {
            console.error(`linux-doctor: could not send report: ${err.message}`);
          }
        }
        if (args.alertUrl && shouldAlert(report)) {
          try {
            await sendAlert(args.alertUrl, buildAlert(report), { apiKey: process.env.FLEET_API_KEY, allowPrivate: args.allowPrivateEndpoint });
            console.log(`Alert sent to ${redactUrl(args.alertUrl)}`);
          } catch (err) {
            console.error(`linux-doctor: could not send alert: ${err.message}`);
          }
        }
        if (args.heartbeatUrl) {
          try {
            await pingHeartbeat(args.heartbeatUrl, { allowPrivate: args.allowPrivateEndpoint });
          } catch (err) {
            console.error(`linux-doctor: could not ping heartbeat: ${err.message}`);
          }
        }
      } catch (err) {
        console.error(`linux-doctor: agent cycle failed: ${err && err.message ? err.message : err}`);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  if (args.web) {
    const server = await startWeb({
      // `save` is passed by an explicit Re-run from the dashboard; background
      // polls call without it and must not advance machine history.
      collect: async (save = false) => attachHistory(await collect(), { save: !!save }),
      history: loadHistory,
      checkList: async () => {
        const profile = await detectProfile();
        return checks.map((c) => ({
          id: c.id,
          title: c.title,
          category: c.category,
          appliesTo: c.appliesTo,
          appliesHere: c.appliesTo.includes(profile.kind),
          skipOnAtomic: !!c.skipOnAtomic,
          atomicReason: c.skipOnAtomic ? (c.atomicReason || "") : "",
          premium: !!c.premium,
        }));
      },
      // The dashboard endpoint serves the same versioned payload as --json,
      // so scripts that read /api/report get schemaVersion/tool/version too.
      // Include durations for the technical dashboard (compact + per-card ms).
      render: (data) => renderJson(data.findings, data.system, jsonOptions(data, {
        durations: Object.fromEntries((data.checkDurations || []).map(d => [d.check, d.ms])),
        checkDurations: data.checkDurations,
      })),
    });
    await new Promise((resolve) => {
      const stop = () => { server.close(); resolve(0); };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
    return 0;
  }

  const t0 = Date.now();
  const report = attachHistory(await collect());
  const durationMs = Date.now() - t0;
  const { findings, system, score: sc, newCount } = report;

  // --notify: best-effort desktop notification when NEW medium/high findings
  // appeared (same degradation rule as webhooks, but local). Never fatal.
  if (args.notify && canNotify() && shouldNotify(report)) {
    sendNotification(notificationFor(report));
  }

  // --fix: build the safe-fix plan from this run's findings. Without --yes it
  // is a pure dry run (print + exit); with --yes the [apply] commands execute
  // one by one, each echoed before it runs. [manual] commands are never run.
  if (args.fix) {
    const plan = planFixes(findings, { system });
    if (!args.yes) {
      console.log(formatPlan(plan, { dryRun: true }));
      return 0;
    }
    console.log(formatPlan(plan, { dryRun: false }));
    let failed = 0;
    for (const entry of plan) {
      for (const c of entry.commands) {
        if (c.tier !== "apply") continue;
        console.log(`\n$ ${c.cmd}`);
        const res = await run(c.cmd, { timeoutMs: 300000 });
        const tail = res.stdout.trim().split("\n").filter(Boolean).slice(-3);
        if (tail.length) console.log(tail.map((l) => `  ${l}`).join("\n"));
        if (!res.ok) {
          failed += 1;
          console.error(`  ✗ command failed (exit ${res.code}${res.timedOut ? ", timed out" : ""})${res.stderr.trim() ? `: ${res.stderr.trim().split("\n")[0]}` : ""}`);
        }
      }
    }
    if (plan.length === 0) return 0;
    console.log(failed > 0 ? `\nDone with ${failed} failure(s). Re-run linux-doctor to see the effect.` : "\nDone. Re-run linux-doctor to see the effect.");
    return failed > 0 ? 1 : 0;
  }

  // --interactive: browse the findings in a terminal UI. Falls back to the
  // printed report when there is no TTY (pipes, CI).
  if (args.interactive) {
    try {
      await runInteractive(findings, { plan: planFixes(findings, { system }) });
      return findings.some((f) => f.severity === "high" || f.severity === "medium") ? 1 : 0;
    } catch (err) {
      console.error(`linux-doctor: ${err.message} — printing the report instead.`);
    }
  }

  // --summary: one-liner for cron/scripts — score + counts, no findings.
  if (args.summary) {
    const { high, medium, info } = report.counts;
    const parts = [`health ${sc}/100`];
    if (typeof report.scoreDelta === "number") {
      parts.push(report.scoreDelta > 0 ? `delta=+${report.scoreDelta}` : `delta=${report.scoreDelta}`);
    }
    if (newCount > 0) parts.push(`new=${newCount}`);
    if (report.fixedCount > 0) parts.push(`fixed=${report.fixedCount}`);
    if (report.unchanged > 0) parts.push(`unchanged=${report.unchanged}`);
    if (high > 0) parts.push(`high=${high}`);
    if (medium > 0) parts.push(`medium=${medium}`);
    if (info > 0) parts.push(`info=${info}`);
    // A report from a partially-broken run must not look clean — a score with
    // failed checks is not a verdict on the whole system.
    if (report.checkErrors.length > 0) parts.push(`errors=${report.checkErrors.length}`);
    console.log(parts.join(" · "));
    return findings.some((f) => f.severity === "high" || f.severity === "medium") ? 1 : 0;
  }

  // --todo: just the fix steps, numbered, in priority order.
  if (args.todo) {
    console.log(renderTodo(findings));
    return findings.some((f) => f.severity === "high" || f.severity === "medium") ? 1 : 0;
  }

  // --severity filters what is DISPLAYED but does not affect scoring or
  // fleet push — the score and --push reflect the full picture.
  const displayFindings = args.severity
    ? findings.filter((f) => f.severity === args.severity)
    : findings;

  let summary = null;
  if (args.aiLocal) {
    // Point the existing OpenAI-compatible client at a local Ollama instance.
    // Ollama serves an OpenAI-compatible API at <host>/v1 and accepts any key,
    // so the same code path works fully offline — no data leaves the machine.
    process.env.LLM_BASE_URL = process.env.LLM_BASE_URL || "http://localhost:11434/v1";
    process.env.LLM_MODEL = process.env.LLM_MODEL || "llama3.2";
    process.env.LLM_API_KEY = process.env.LLM_API_KEY || "ollama";
  }
  if (args.ai || args.aiLocal) {
    summary = await aiSummary(findings, { premium: pro, allowPrivate: args.allowPrivateEndpoint });
  }

  if (args.pushUrl) {
    try {
      await pushReport(args.pushUrl, {
        system,
        findings: findings.map(scrubFinding),
        summary: summary ? scrub(summary) : summary,
        score: sc,
        newCount,
        fixedCount: report.fixedCount,
        diffSinceLast: report.diffSinceLast,
        skippedChecks: report.skippedChecks,
        checksAtomicSkipped: report.checksAtomicSkipped,
        changeMessage: report.changeMessage,
      }, { apiKey: process.env.FLEET_API_KEY, allowPrivate: args.allowPrivateEndpoint });
      console.log(`Report sent to ${redactUrl(args.pushUrl)}`);
    } catch (err) {
      console.error(`linux-doctor: could not send report to fleet server: ${err.message}`);
      return 2;
    }
  }

  // --alert: POST a webhook only when the machine actually degraded (a
  // high-severity finding, or a new medium/high since the last run). Best
  // effort — a failed webhook is a warning, never a changed exit code.
  if (args.alertUrl) {
    try {
      if (shouldAlert(report)) {
        await sendAlert(args.alertUrl, buildAlert(report), { apiKey: process.env.FLEET_API_KEY, allowPrivate: args.allowPrivateEndpoint });
        console.log(`Alert sent to ${args.alertUrl}`);
      }
    } catch (err) {
      console.error(`linux-doctor: could not send alert: ${err.message}`);
    }
  }

  // --heartbeat: ping the dead-man's switch after every completed run, so
  // silence itself becomes the alert. Best effort, like --alert.
  if (args.heartbeatUrl) {
    try {
      await pingHeartbeat(args.heartbeatUrl, { allowPrivate: args.allowPrivateEndpoint });
    } catch (err) {
      console.error(`linux-doctor: could not ping heartbeat: ${err.message}`);
    }
  }

  if (args.htmlPath) {
    try {
      // --html is a share-shaped artifact, so it gets the same privacy pass as
      // --md: scrubDeep() redacts IPs and home paths in every field of the
      // payload (including nextAction/diff/checkErrors), and the hostname is
      // never shipped. scrubDeep walks the whole object, so a field added
      // later is covered without anyone remembering to scrub it.
      const payload = scrubDeep(JSON.parse(renderJson(findings, system, jsonOptions(report, { durationMs }))));
      if (payload.system) payload.system.hostname = "<hostname-redacted>";
      const jsonPayload = JSON.stringify(payload, null, 2);
      const dashboard = readFileSync(new URL("../src-gui/index.html", import.meta.url), "utf8");
      // Embed the payload as window.__DATA__ (the dashboard prefers it over
      // the network) instead of overriding window.fetch — no monkey-patching
      // of browser globals, and POST buttons fail honestly in a static file.
      // jsonForInlineScript(): a "</script>" in any finding field must not
      // close the tag (stored-XSS in a report users share).
      const html = `<script>\nwindow.__DATA__ = ${jsonForInlineScript(jsonPayload)};\n</script>\n${dashboard}`;
      writeFileSync(args.htmlPath, html, "utf8");
      console.log(`Report saved to ${args.htmlPath}`);
    } catch (err) {
      console.error(`linux-doctor: could not write HTML report: ${err.message}`);
      return 2;
    }
    return findings.some((f) => f.severity === "high" || f.severity === "medium") ? 1 : 0;
  }

  // --md: write the share-ready Markdown export and exit. Same contract as
  // --html: file written, path echoed, exit code still reflects the FULL
  // finding set so the flag stays cron/script-safe.
  if (args.mdPath) {
    try {
      const md = renderMarkdown(displayFindings, {
        system,
        version: pkg.version,
        score: sc,
        scoreBreakdown: report.scoreBreakdown,
        scoreDelta: report.scoreDelta,
        newCount,
        fixedCount: report.fixedCount,
        unchanged: report.unchanged,
        ignoredCount: report.ignoredCount,
        checkErrors: report.checkErrors,
        checksRun: report.checksRun,
        checksSkipped: report.checksSkipped,
        checksAtomicSkipped: report.checksAtomicSkipped,
        skippedChecks: report.skippedChecks,
        historyDisabled: report.historyDisabled,
      });
      writeFileSync(args.mdPath, md, "utf8");
      console.log(`Report saved to ${args.mdPath}`);
    } catch (err) {
      console.error(`linux-doctor: could not write Markdown report: ${err.message}`);
      return 2;
    }
    return findings.some((f) => f.severity === "high" || f.severity === "medium") ? 1 : 0;
  }

  if (args.json) {
    console.log(renderJson(displayFindings, system, jsonOptions(report, {
      durationMs,
      // The schema documents `durations` as a check→ms object (the dashboard
      // already serves it that way); emit the same shape here so the two
      // machine channels agree.
      ...(args.profile ? { durations: Object.fromEntries((report.checkDurations || []).map((d) => [d.check, d.ms])) } : {}),
    })));
    return findings.some((f) => f.severity === "high" || f.severity === "medium") ? 1 : 0;
  }

  if (args.plain) {
    let out = renderPlain(displayFindings, { system, score: sc, scoreBreakdown: report.scoreBreakdown, scoreDelta: report.scoreDelta, newCount, fixedCount: report.fixedCount, unchanged: report.unchanged, ignoredCount: report.ignoredCount, checkErrors: report.checkErrors, checksRun: report.checksRun, checksSkipped: report.checksSkipped, checksAtomicSkipped: report.checksAtomicSkipped, skippedChecks: report.skippedChecks, historyDisabled: report.historyDisabled, history: report.historyRuns });
    if (args.profile) out += "\n" + formatPlainDurations(report.checkDurations);
    console.log(out);
    return findings.some((f) => f.severity === "high" || f.severity === "medium") ? 1 : 0;
  }

  let out = await renderReport(displayFindings, { aiSummary: summary, system, score: sc, scoreBreakdown: report.scoreBreakdown, scoreDelta: report.scoreDelta, newCount, fixedCount: report.fixedCount, unchanged: report.unchanged, ignoredCount: report.ignoredCount, checkErrors: report.checkErrors, checksRun: report.checksRun, checksSkipped: report.checksSkipped, checksAtomicSkipped: report.checksAtomicSkipped, skippedChecks: report.skippedChecks, historyDisabled: report.historyDisabled, changeMessage: report.changeMessage, history: report.historyRuns, categoryByCheck });
  if (args.profile) out += "\n" + formatDurations(report.checkDurations);
  console.log(out);
  return findings.some((f) => f.severity === "high" || f.severity === "medium") ? 1 : 0;
}

// NOTE: exit code always reflects the FULL finding set (not the --severity
// filter), so `--severity info` on a system with a high finding still exits 1.