// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * --md: share-ready Markdown export for forums, GitHub issues, and chat.
 * The paste-on-forum successor of "run inxi and paste the output": the file
 * tells a reader the same story as the terminal report (START HERE, findings
 * with evidence and fixes, what changed since last run) but in plain Markdown
 * that renders anywhere.
 *
 * Privacy by default: every text field goes through the same scrub() as the
 * support bundle — IP literals, /home/<user> paths, and /run/user/<uid> are
 * redacted before the file is written, because a share-ready file is by
 * definition destined for the public.
 *
 * Pure renderer (no fs): tests assert the text; cli.js owns the write.
 */
import { readFileSync } from "node:fs";

import { scrub } from "./support.js";
import { SEV_ORDER, SEV_LABEL, countBySeverity } from "./severities.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const SEV_HEADING = { high: "## High severity", medium: "## Medium severity", info: "## Informational" };

/**
 * Render the report as Markdown. Same option shape as renderPlain, plus
 * `version` (defaults to the package version) — cli.js passes its report
 * context so --md, --plain and the terminal report can never tell different
 * stories about the same run.
 */
export function renderMarkdown(findings, {
  system = null,
  score,
  scoreBreakdown = [],
  scoreDelta,
  newCount,
  fixedCount,
  unchanged = 0,
  ignoredCount = 0,
  checkErrors = [],
  checksRun,
  checksSkipped,
  checksAtomicSkipped = 0,
  skippedChecks = [],
  historyDisabled = false,
  version,
} = {}) {
  const s = (t) => scrub(t) ?? "";
  const out = [];
  out.push("# Linux Doctor report");
  out.push("");
  if (system) {
    out.push(`**System:** ${s(system.distro)} · kernel ${s(system.kernel)} · ${system.cores} core(s) · up ${s(system.uptime)}`);
  }
  const counts = countBySeverity(findings);
  const high = counts.find((c) => c.severity === "high").count;
  const med = counts.find((c) => c.severity === "medium").count;
  const inf = counts.find((c) => c.severity === "info").count;
  const summary = `${high} high, ${med} medium, ${inf} info`;
  if (typeof score === "number") {
    const delta = typeof scoreDelta === "number" ? (scoreDelta >= 0 ? ` (+${scoreDelta})` : ` (${scoreDelta})`) : "";
    out.push(`**Health score:** ${score}/100${delta} · ${summary}`);
    // The score's arithmetic, as a readable list — auditable in the paste, too.
    const penalized = [...scoreBreakdown].filter((b) => b.penalty > 0).sort((a, b) => b.penalty - a.penalty);
    if (penalized.length > 0) {
      for (const b of penalized) out.push(`- −${b.penalty} ${s(b.code ?? b.title)}`);
    }
  } else {
    out.push(`**Summary:** ${summary}`);
  }
  if (typeof checksRun === "number") {
    const bits = [`${checksRun} check(s) ran`];
    if (checksSkipped > 0) bits.push(`${checksSkipped} skipped`);
    if (checksAtomicSkipped > 0) bits.push(`${checksAtomicSkipped} not applicable`);
    if (checkErrors.length > 0) bits.push(`${checkErrors.length} failed`);
    out.push(`**Checks:** ${bits.join(", ")}`);
  }
  if (ignoredCount > 0) out.push(`*${ignoredCount} finding(s) hidden by ignore patterns.*`);
  out.push("");

  if (historyDisabled) {
    out.push("*History tracking was off for this run (--no-history); new/fixed comparison is skipped.*");
    out.push("");
  } else if (newCount > 0 || fixedCount > 0 || unchanged > 0) {
    out.push("## Since last run");
    out.push("");
    const chg = [];
    if (newCount > 0) chg.push(`${newCount} new`);
    if (fixedCount > 0) chg.push(`${fixedCount} fixed`);
    if (unchanged > 0) chg.push(`${unchanged} unchanged`);
    out.push(chg.join(" · "));
    out.push("");
  }

  if (checkErrors.length > 0) {
    out.push("## Checks that failed to run");
    out.push("");
    for (const e of checkErrors) out.push(`- **${e.check}** — ${s(e.error)}`);
    out.push("");
    out.push("*A report with failed checks is not a clean verdict — treat the score as incomplete.*");
    out.push("");
  }

  // Findings: severity sections in report order; each item carries its stable
  // code in backticks so a helper can reference it exactly (ignore-code, docs).
  let n = 0;
  const numbered = [];
  for (const sev of SEV_ORDER) {
    const group = findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    out.push(SEV_HEADING[sev]);
    out.push("");
    for (const f of group) {
      n += 1;
      numbered.push(f);
      const badge = f.isNew ? " — 🆕 NEW" : "";
      const code = f.code ? ` \`${f.code}\`` : "";
      out.push(`${n}. **${s(f.title)}**${code}${badge}`);
      if (f.detail) out.push(`   ${s(f.detail)}`);
      if (f.confidence === "low") out.push("   *⚠ Low confidence — may be a false positive.*");
      if (f.evidence) {
        out.push("   *Evidence:*");
        out.push("   ```text");
        for (const line of String(f.evidence).split("\n").slice(0, 8)) out.push(`   $ ${s(line)}`);
        out.push("   ```");
      }
      if (f.fix) out.push(`   *How to fix:* ${s(f.fix)}`);
      out.push("");
    }
  }
  if (n === 0) {
    out.push("## Findings");
    out.push("");
    out.push("Nothing found — no high, medium, or informational issues.");
    out.push("");
  }

  // START HERE, after the findings it points into — the anchor still guides
  // the reader without the layout gymnastics the terminal report needs.
  // The title is scrubbed here too: this line is the most likely one to be
  // quoted in a forum reply, and scrub() must have no exceptions.
  const firstFix = numbered.findIndex((f) => f.fix);
  if (firstFix >= 0) {
    out.push("---");
    out.push("");
    out.push(`**▶ START HERE → finding ${firstFix + 1} (${s(numbered[firstFix].title)}).** Everything is a suggestion: Linux Doctor only reads your system — run each fix yourself.`);
    out.push("");
  }

  if (skippedChecks.length > 0) {
    out.push("## Skipped (not applicable on this system)");
    out.push("");
    for (const sc of skippedChecks) out.push(`- **${sc.id}** — ${s(sc.reason)}`);
    out.push("");
  }

  const v = version || pkg.version;
  out.push("---");
  out.push("");
  out.push(`<sub>Generated by [Linux Doctor](https://github.com/7sh1d0w7x/linux-doctor) v${v} — read-only diagnostics for Linux. IPs and home paths are redacted.</sub>`);
  return out.join("\n");
}
