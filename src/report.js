// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";

import { SEV_ORDER, SEV_LABEL, countBySeverity } from "./severities.js";
import { cleanStreak } from "./history.js";

export { SEV_ORDER, SEV_LABEL, countBySeverity };

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** ANSI color codes — only used when stdout is a TTY, never in --plain. */
const A = { red: "\x1b[31m", yellow: "\x1b[33m", blue: "\x1b[34m", cyan: "\x1b[36m", bold: "\x1b[1m", dim: "\x1b[2m", reset: "\x1b[0m", green: "\x1b[32m" };
const SEV_COLOR = { high: A.red, medium: A.yellow, info: A.blue };
const isTTY = process.stdout?.isTTY;

const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** How many past runs the TREND sparkline shows at most. */
const TREND_WINDOW = 20;

/** Long START HERE hints get one line — truncate with an ellipsis. */
function clamp(text, max = 110) {
  const s = String(text || "");
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/**
 * Score sparkline over past runs, e.g. "▂▃▄▅". Fixed 0–100 scale so the shape
 * is honest across windows: two runs at 91 and 92 render as near-flat bars —
 * which is exactly what the numbers say. Pure and exported for tests.
 */
export function spark(scores) {
  const vals = (scores || []).filter((s) => typeof s === "number");
  if (vals.length === 0) return "";
  return vals.map((s) => SPARK_CHARS[Math.max(0, Math.min(SPARK_CHARS.length - 1, Math.round((s / 100) * (SPARK_CHARS.length - 1))))]).join("");
}

/**
 * The single most useful thing to do first: the highest-severity finding (in
 * report order — severity sections, then clustered by category exactly like
 * the printed report) that comes with an action. Identity-only shape (no
 * display numbers), so the same pick can travel in --json (`nextAction`) and
 * drive the dashboard's banner without recomputing client-side. Pure.
 */
export function pickNextFinding(findings, categoryByCheck = null) {
  const cat = (f) => (categoryByCheck && f.check ? categoryByCheck.get(f.check) || "" : "");
  for (const sev of SEV_ORDER) {
    const group = findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    const hit = [...group].sort((a, b) => cat(a).localeCompare(cat(b))).find((f) => f.fix);
    if (hit) return { code: hit.code ?? null, severity: hit.severity, title: hit.title, fix: hit.fix };
  }
  return null;
}

/**
 * The single most useful thing to do first: the highest-severity finding (in
 * report order) that comes with an action. Returns { n, finding } or null.
 * Pure and exported so --todo and tests share the same pick.
 */
export function pickNextAction(ordered) {
  const idx = ordered.findIndex((f) => f.fix);
  return idx >= 0 ? { n: idx + 1, finding: ordered[idx] } : null;
}

/** First sentence of a fix suggestion, for one-line displays. */
function firstSentence(text) {
  return String(text || "").split(/(?<=\.)\s/)[0].trim();
}

/** Render the full terminal report in American English. */
export async function renderReport(findings, { aiSummary, system, score, scoreDelta, scoreBreakdown = [], newCount, fixedCount, unchanged = 0, ignoredCount = 0, checkErrors = [], checksRun, checksSkipped, checksAtomicSkipped = 0, skippedChecks = [], historyDisabled = false, changeMessage = null, history = [], categoryByCheck = null } = {}) {
  // system is required — the caller (cli.js) always has it; re-running
  // systemInfo() here would waste a handful of subprocess spawns.
  const info = system;
  const out = [];

  out.push("🩺 Linux Doctor");
  out.push("==============");
  out.push(`System: ${info.distro} · Kernel ${info.kernel} · ${info.cores} core(s) · up ${info.uptime}`);
  if (info.immutable) out.push(`Note: this is an immutable (${info.atomic?.variant || "ostree"}) system; the root filesystem is virtual, so a 100% root is expected and normal. Updates apply atomically via ${info.atomic?.pkg === "rpm-ostree" ? "rpm-ostree" : "the image system"}.`);
  out.push("");

  if (aiSummary) {
    out.push(aiSummary);
    out.push("");
  }

  const counts = countBySeverity(findings);
  const high = counts.find((c) => c.severity === "high").count;
  const med = counts.find((c) => c.severity === "medium").count;
  const inf = counts.find((c) => c.severity === "info").count;

  if (high === 0 && med === 0) {
    // Healthy state gets the premium treatment, not a bare "OK": name what
    // IS present (informational notes) and reward momentum when history
    // shows a streak of clean runs.
    const streak = cleanStreak((history || []).filter((r) => typeof r.score === "number")) + 1;
    if (findings.length === 0) {
      out.push(streak >= 2
        ? `✅ Everything is clean — ${streak} clean run(s) in a row. Keep it up.`
        : "✅ Everything is clean. No issues found.");
    } else {
      out.push(`✅ No high or medium issues — ${inf} informational note${inf === 1 ? "" : "s"} below.`);
    }
  } else {
    out.push(`Found ${high} high-severity, ${med} medium-severity, and ${inf} informational finding(s).`);
  }
  if (typeof score === "number") {
    // Delta mirrors --plain's "# score: N/100 (+d)" convention — recovery and
    // regression read identically in every text channel.
    const delta = typeof scoreDelta === "number" ? (scoreDelta >= 0 ? ` (+${scoreDelta})` : ` (${scoreDelta})`) : "";
    out.push(`STATUS   ${high} high, ${med} medium, ${inf} info · health ${score}/100${delta}`);
    // The score's arithmetic, in one auditable line: which finding cost what.
    // Derived data (scoreBreakdown) — never recomputed here, so the line and
    // the number can never disagree.
    const penalized = [...scoreBreakdown].filter((b) => b.penalty > 0).sort((a, b) => b.penalty - a.penalty);
    if (penalized.length > 0) {
      const shown = penalized.slice(0, 3).map((b) => `−${b.penalty} ${b.code ?? b.title}`);
      const more = penalized.length > 3 ? ` (+${penalized.length - 3} more)` : "";
      out.push(`SCORE     ${score}/100 = 100 ${shown.join(" ")}${more}`);
    }
  }
  // Score trend over recent runs — visible momentum is what keeps people
  // running the tool. The CURRENT run is part of the series (otherwise the
  // line always lags one run behind and reads backwards). Only shown with at
  // least two scored points; capped to a readable window (the newest ones).
  const scoredAll = (history || []).filter((r) => typeof r.score === "number");
  const scored = scoredAll.slice(-(TREND_WINDOW - 1));
  if (!historyDisabled && typeof score === "number") scored.push({ score });
  if (scored.length >= 2) {
    const first = scored[0].score;
    const last = scored[scored.length - 1].score;
    const dir = last > first ? "▲" : last < first ? "▼" : "·";
    out.push(`TREND    ${spark(scored.map((r) => r.score))}  last ${scored.length} run(s) · ${first} → ${last} ${dir}`);
  }
  // Lead with change — the product's differentiator: what's new, fixed, same.
  if (!historyDisabled) {
    const chg = [];
    if (newCount > 0) chg.push(`${newCount} new`);
    if (fixedCount > 0) chg.push(`${fixedCount} fixed`);
    if (unchanged > 0) chg.push(`${unchanged} unchanged`);
    out.push(chg.length ? `SINCE LAST RUN   ${chg.join(" · ")}` : "SINCE LAST RUN   no change");
  } else if (changeMessage) {
    out.push(changeMessage);
  }
  if (historyDisabled) {
    out.push("History tracking is off (--no-history); new/fixed comparison is skipped.");
  }
  if (ignoredCount > 0) {
    out.push(`${ignoredCount} finding(s) hidden by your ignore patterns.`);
  }
  if (checkErrors.length > 0) {
    out.push(`⚠ ${checkErrors.length} check(s) failed to run: ${checkErrors.map((e) => e.check).join(", ")}.`);
  }
  if (skippedChecks.length > 0) {
    out.push(`⚠ ${skippedChecks.length} check(s) skipped as not applicable on this immutable system (${skippedChecks.map((s) => s.id).join(", ")}).`);
  }
  if (typeof checksRun === "number") {
    const bits = [`Ran ${checksRun} check(s)`];
    if (checksSkipped > 0) bits.push(`${checksSkipped} skipped`);
    if (checksAtomicSkipped > 0) bits.push(`${checksAtomicSkipped} not applicable`);
    if (checkErrors.length > 0) bits.push(`${checkErrors.length} failed`);
    out.push(bits.length > 1 ? `${bits[0]} (${bits.slice(1).join(", ")}).` : `${bits[0]}.`);
  }
  out.push("");

  // Print order: severity first (high → medium → info), then clustered by
  // category so related findings sit together. Stable sort keeps the checks'
  // own order inside a cluster.
  const cat = (f) => (categoryByCheck && f.check ? categoryByCheck.get(f.check) || "" : "");
  const ordered = [];
  let n = 0;
  for (const sev of SEV_ORDER) {
    const group = findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    const label = SEV_LABEL[sev];
    out.push(isTTY ? `${SEV_COLOR[sev]}${A.bold}${label}${A.reset}` : label);
    out.push("-".repeat(label.length));
    out.push("");
    for (const f of [...group].sort((a, b) => cat(a).localeCompare(cat(b)))) {
      ordered.push(f);
      n += 1;
      const badge = f.isNew ? (isTTY ? `${A.bold}${A.cyan}🆕 NEW${A.reset}` : "🆕 NEW") : "";
      const tag = cat(f) ? `[${cat(f)}] ` : "";
      out.push(`${n}. ${tag}${f.title}${badge ? `  ${badge}` : ""}`);
      if (f.confidence === "low") out.push("   ⚠ Low confidence — this finding may be a false positive.");
      if (f.detail) out.push(`   ${f.detail}`);
      if (f.evidence) {
        out.push("");
        out.push("   Evidence:");
        for (const line of String(f.evidence).split("\n").slice(0, 8)) out.push(`     $ ${line}`);
      }
      if (f.fix) {
        out.push("");
        out.push(`   How to fix: ${f.fix}`);
      }
      out.push("");
    }
  }

  // The single most useful action, called out between the summary and the
  // details: status → change → act.
  const next = pickNextAction(ordered);
  if (next) {
    const label = isTTY ? `${A.green}${A.bold}▶ START HERE${A.reset}` : "▶ START HERE";
    const step = `#${next.n} ${next.finding.title}`;
    const hint = clamp(firstSentence(next.finding.fix));
    // First severity-section header is where the details begin; everything
    // before it is the summary block. When no section exists (no findings),
    // pickNextAction already returned null.
    const firstSectionIdx = out.findIndex((l) => l.startsWith(SEV_LABEL[ordered[0].severity]));
    out.splice(firstSectionIdx >= 0 ? firstSectionIdx : out.length, 0, `${label}   ${step}`, `${" ".repeat(13)}${hint}`, "");
  }

  out.push("──────────────────────────────");
  out.push("Linux Doctor only reads system information — it never modifies anything.");
  out.push("Report bugs or request checks at: github.com/7sh1d0w7x/linux-doctor");
  return out.join("\n");
}

/**
 * --todo: a flat, numbered, severity-ordered list of the actionable steps —
 * just the findings that come with a fix. One line per step, copy-pasteable,
 * so a user gets "what do I run, in order" without reading the full report.
 */
export function renderTodo(findings) {
  const out = [];
  out.push("# linux-doctor --todo");
  out.push("# Steps to fix the issues found, in priority order.");
  out.push("");
  let n = 0;
  for (const sev of SEV_ORDER) {
    for (const f of findings.filter((x) => x.severity === sev)) {
      if (!f.fix) continue;
      n += 1;
      out.push(`${n}. [${sev}] ${f.title}`);
      out.push(`   ${f.fix}`);
      out.push("");
    }
  }
  if (n === 0) out.push("Nothing to fix — no findings came with an action.");
  return out.join("\n");
}

/**
 * Render findings as plain, tab-separated lines — no colors, no emoji, no
 * box drawing — so the output plays well with grep/awk and dumb terminals.
 * Metadata goes to `#` comment lines; each finding is one row of
 * `severity<TAB>number<TAB>title`, with `detail`/`fix` rows right after it.
 */
export function renderPlain(findings, { system, score, scoreBreakdown = [], scoreDelta, newCount, fixedCount, unchanged = 0, ignoredCount = 0, checkErrors = [], checksRun, checksSkipped, checksAtomicSkipped = 0, skippedChecks = [], historyDisabled = false, history = [] } = {}) {
  const flat = (s) => String(s ?? "").replace(/\t/g, " ").replace(/\s*\n\s*/g, " | ").trim();
  const out = [];
  out.push("# linux-doctor");
  if (system) out.push(`# system: ${system.distro} · kernel ${system.kernel} · ${system.cores} core(s) · up ${system.uptime}`);
  if (typeof score === "number") {
    const delta = typeof scoreDelta === "number" ? (scoreDelta >= 0 ? ` (+${scoreDelta})` : ` (${scoreDelta})`) : "";
    out.push(`# score: ${score}/100${delta}`);
  }
  const penalizedPlain = [...scoreBreakdown].filter((b) => b.penalty > 0).sort((a, b) => b.penalty - a.penalty);
  if (penalizedPlain.length > 0) out.push(`# score-breakdown: ${penalizedPlain.map((b) => `-${b.penalty} ${b.code ?? b.title}`).join(" | ")}`);
  const scoredAllPlain = (history || []).filter((r) => typeof r.score === "number");
  const scoredPlain = scoredAllPlain.slice(-(TREND_WINDOW - 1));
  if (!historyDisabled && typeof score === "number") scoredPlain.push({ score });
  if (scoredPlain.length >= 2) out.push(`# trend: ${spark(scoredPlain.map((r) => r.score))} (${scoredPlain[0].score} → ${scoredPlain[scoredPlain.length - 1].score})`);
  if (newCount > 0) out.push(`# new: ${newCount}`);
  if (fixedCount > 0) out.push(`# fixed: ${fixedCount}`);
  if (historyDisabled) out.push("# history: disabled (--no-history)");
  else if (newCount > 0 || fixedCount > 0 || unchanged > 0) out.push(`# since: ${newCount} new, ${fixedCount} fixed, ${unchanged} unchanged`);
  if (ignoredCount > 0) out.push(`# ignored: ${ignoredCount}`);
  if (typeof checksRun === "number") out.push(`# checks: ${checksRun}${checksSkipped > 0 ? ` (${checksSkipped} skipped)` : ""}${checksAtomicSkipped > 0 ? ` (${checksAtomicSkipped} not-applicable)` : ""}`);
  for (const e of checkErrors) out.push(`# failed: ${e.check} — ${flat(e.error)}`);
  for (const s of skippedChecks) out.push(`# skipped: ${s.id} — ${flat(s.reason)}`);
  const counts = countBySeverity(findings);
  const high = counts.find((c) => c.severity === "high").count;
  const med = counts.find((c) => c.severity === "medium").count;
  const inf = counts.find((c) => c.severity === "info").count;
  out.push(`# summary: ${high} high, ${med} medium, ${inf} info`);
  out.push("");

  let n = 0;
  for (const sev of SEV_ORDER) {
    for (const f of findings.filter((x) => x.severity === sev)) {
      n += 1;
      out.push(`${sev}\t${n}\t${flat(f.title)}${f.isNew ? " (new)" : ""}`);
      if (f.detail) out.push(`detail\t${n}\t${flat(f.detail)}`);
      if (f.fix) out.push(`fix\t${n}\t${flat(f.fix)}`);
    }
  }
  return out.join("\n");
}

/**
 * Render findings as JSON (machine-readable), with system info when
 * available. The payload is versioned (schemaVersion) so scripts can rely on
 * its shape; if the shape ever changes incompatibly the version is bumped.
 * `extra` may carry generatedAt (from the run), score, newCount, counts and
 * durationMs — cli.js passes them all.
 */
export function renderJson(findings, system = null, extra = {}) {
  const payload = {
    schemaVersion: 1,
    tool: "linux-doctor",
    version: pkg.version,
    generatedAt: new Date().toISOString(),
    findings,
    ...extra,
  };
  if (system) payload.system = system;
  return JSON.stringify(payload, null, 2);
}

/**
 * JSON safe to embed inside an inline `<script>`. JSON.stringify leaves `<`
 * untouched, so a finding field containing "</script>" (a crafted journal
 * line, container or unit name) would close the tag early and turn the
 * exported report into executable markup. Escaping `<` as \u003c keeps the
 * data byte-identical after parsing — it is a valid JSON escape — while no
 * "</script" sequence can survive in the file.
 */
export function jsonForInlineScript(json) {
  return json.replace(/</g, "\\u003c");
}
