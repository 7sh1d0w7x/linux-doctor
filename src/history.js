// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Report history and health score.
 *
 * Every run is appended to a small JSON file (default:
 * ~/.local/share/linux-doctor/history.json, override with LINUX_DOCTOR_HISTORY)
 * so we can show a health score, "new since last check", and a trend over
 * time. History is a bonus, never a dependency: if the file cannot be read or
 * written, every function here fails silently.
 */
import { readFileSync, rmSync } from "node:fs";

import { atomicWrite } from "./fsx.js";
import { historyFile } from "./paths.js";
import { SEV_PENALTY, SEV_ESCALATION, SEV_ESCALATE_FROM, SEV_ORDER } from "./severities.js";

export { historyFile };

/** Keep only this many runs so the history file stays tiny. */
export const HISTORY_LIMIT = 50;

/** Wrapper schema version. v2 guarantees per-finding `code`; v1 files predate it. */
export const HISTORY_VERSION = 2;

/**
 * Per-finding penalty breakdown, in input order. The n-th finding of a tier
 * pays SEV_PENALTY + SEV_ESCALATION × max(0, n − (SEV_ESCALATE_FROM − 1)) —
 * the same escalation ladder score() sums. Info findings are listed with a 0
 * penalty so consumers can render the full picture. Identity mirrors the
 * diff's briefFinding shape (code when present, else title), so repeated
 * codes ("disk/full" on several partitions) stay distinguishable via title.
 *
 * score() is DERIVED from this list: one formula, two views — they can never
 * diverge, and `100 − Σpenalty === score(findings)` holds by construction.
 */
export function scoreBreakdown(findings) {
  const ordinals = {};
  const rows = [];
  for (const f of findings || []) {
    if (!SEV_ORDER.includes(f.severity)) continue;
    const n = (ordinals[f.severity] = (ordinals[f.severity] || 0) + 1);
    const base = SEV_PENALTY[f.severity] ?? 0;
    const step = SEV_ESCALATION[f.severity] ?? 0;
    const from = SEV_ESCALATE_FROM[f.severity] ?? Number.POSITIVE_INFINITY;
    rows.push({
      code: typeof f.code === "string" ? f.code : null,
      severity: f.severity,
      title: typeof f.title === "string" ? f.title : null,
      penalty: base + Math.max(0, n - from + 1) * step,
    });
  }
  return rows;
}

/**
 * 0-100 health score: start at 100 and subtract the penalty per finding
 * (15 per high-severity, 8 per medium-severity), floor at 0.
 * Informational findings are free. Penalties live in src/severities.js.
 *
 * Problems compound, so penalties escalate within a tier (see SEV_ESCALATION):
 * the n-th high costs 15 + 5·(n−1) — four criticals must not land near a pile
 * of annoyances — and mediums past the third cost +1 each. Derived from
 * scoreBreakdown(), whose per-ordinal surcharges sum to the same closed form
 * over per-tier counts — so the score never depends on input order.
 */
export function score(findings) {
  const total = scoreBreakdown(findings).reduce((acc, b) => acc + b.penalty, 0);
  return Math.max(0, 100 - total);
}

/**
 * Shape-check one stored run. Returns a cleaned copy, or null when the run is
 * too broken to use. Individual findings missing BOTH code and title are
 * dropped rather than invalidating the whole run — partial corruption should
 * lose as little history as possible.
 */
function coerceRun(run) {
  if (!run || typeof run !== "object") return null;
  if (typeof run.at !== "string" || run.at === "") return null;
  if (typeof run.score !== "number" || !Number.isFinite(run.score)) return null;
  if (!Array.isArray(run.findings)) return null;
  const findings = run.findings.filter(
    (f) => f && typeof f === "object" && (typeof f.code === "string" || typeof f.title === "string")
  );
  return { ...run, findings };
}

/** Load the list of past runs (oldest first). Never throws.
 *
 * Corruption policy: a truncated or garbage file yields [] (history is a
 * bonus), but a file with SOME malformed entries keeps the well-formed ones —
 * repair-on-read loses as little continuity as possible.
 */
export function loadHistory(file = historyFile()) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && Array.isArray(parsed.runs)) {
      // v2 files carry { version: 2, runs }; v1 files are just { runs }.
      // Both are read the same way — the marker documents what writers emit.
      return parsed.runs.map(coerceRun).filter(Boolean);
    }
  } catch {
    /* missing or corrupt file — treat as no history */
  }
  return [];
}

/**
 * Append a run to the history file. Never throws. Written via a temp file +
 * rename so a crash mid-write can never leave a truncated history behind.
 */
export function saveRun(run, file = historyFile()) {
  try {
    const runs = loadHistory(file);
    runs.push(run);
    const trimmed = runs.slice(-HISTORY_LIMIT);
    atomicWrite(file, JSON.stringify({ version: HISTORY_VERSION, runs: trimmed }, null, 2) + "\n");
  } catch {
    /* history is optional — never fail a check run because of it */
  }
}

/** Remove the history file entirely. Never throws; returns true on success. */
export function clearHistory(file = historyFile()) {
  try {
    rmSync(file, { force: true });
    // Also try to remove empty parent dir (best-effort)
    return true;
  } catch {
    return false;
  }
}

/** Score of the most recent previous run, or null when there is no history. */
export function previousScore(runs) {
  const prev = runs[runs.length - 1];
  if (!prev || typeof prev.score !== "number") return null;
  return prev.score;
}

/**
 * Match sets built from a previous run's findings. v2 entries carry a stable
 * `code`; entries saved before codes existed (v1 history) are indexed by
 * title so a version upgrade never reads as "everything new + everything
 * fixed at once". Title matching applies ONLY to codeless previous entries —
 * among coded entries, identity is the code alone, so volatile titles
 * ("3 services failed" → "2 services failed") never churn the diff.
 */
function matchSets(prevFindings) {
  const codes = new Set();
  const titles = new Set();
  for (const f of prevFindings) {
    if (typeof f.code === "string" && f.code !== "") codes.add(f.code);
    else if (typeof f.title === "string") titles.add(f.title);
  }
  return { codes, titles };
}

/** Does the current finding exist in the previous run's match sets? */
function hadFinding(f, sets) {
  if (typeof f.code === "string" && f.code !== "" && sets.codes.has(f.code)) return true;
  return sets.titles.has(f.title); // legacy title fallback (codeless prev entries)
}

/**
 * Findings whose identity did not appear in the most recent previous run.
 * Returns the full finding objects so callers can badge them.
 */
export function newFindings(findings, runs) {
  const prev = runs[runs.length - 1];
  if (!prev || !Array.isArray(prev.findings)) return [];
  const sets = matchSets(prev.findings);
  return findings.filter((f) => !hadFinding(f, sets));
}

/**
 * What changed since the most recent previous run, compared by stable key
 * (code when present, else title): `added` = findings present now but not
 * before, `fixed` = findings present before but gone now, `unchanged` = the
 * number of current findings whose key also appeared in the previous run (so
 * the three counts sum to the current finding total). The keyed objects keep
 * the stable identity so callers can badge current findings without
 * recomputing it.
 */
export function diffSinceLast(findings, runs) {
  const prev = runs[runs.length - 1];
  // No previous run: nothing can be "unchanged", because unchanged means "also
  // present in the previous run". Returning findings.length here made the very
  // first run print "SINCE LAST RUN 34 unchanged" on a machine with no history —
  // a false statement in the first output a new user ever sees. schema.js
  // already defines the field that way.
  if (!prev || !Array.isArray(prev.findings)) {
    return { added: [], fixed: [], unchanged: 0, firstRun: true };
  }
  const sets = matchSets(prev.findings);
  return {
    added: findings.filter((f) => !hadFinding(f, sets)).map((f) => ({ code: f.code ?? f.title, severity: f.severity, title: f.title })),
    fixed: prev.findings
      .filter((p) => {
        // A previous entry is "fixed" when NO current finding matches it:
        // by code for coded entries, by title for legacy codeless ones.
        if (typeof p.code === "string" && p.code !== "") {
          return !findings.some((f) => f.code === p.code);
        }
        return !findings.some((f) => f.title === p.title);
      })
      .map((f) => ({ code: f.code ?? f.title, severity: f.severity, title: f.title })),
    unchanged: findings.filter((f) => hadFinding(f, sets)).length,
  };
}

/**
 * One human sentence summarizing the change since the last run, used
 * consistently in the CLI, JSON, and the dashboard. Returns null when there is
 * nothing to say (first run, history disabled, or no change) so callers can
 * render it conditionally and never print an empty "Since last run: ".
 */
export function changeMessage({ newCount = 0, fixedCount = 0 } = {}) {
  if (newCount <= 0 && fixedCount <= 0) return null;
  const parts = [];
  if (newCount > 0) parts.push(`${newCount} new issue${newCount === 1 ? "" : "s"}`);
  if (fixedCount > 0) parts.push(`${fixedCount} fixed`);
  return `Since last run: ${parts.join(", ")}.`;
}

/**
 * How many consecutive trailing runs were clean (zero high AND zero medium),
 * oldest-break-first: the streak stops at the most recent non-clean run.
 * Callers add the current run themselves when it is also clean. Pure,
 * exported for tests; a healthy machine earns a visible "N clean runs" so
 * the good state feels rewarded, not silent.
 */
export function cleanStreak(runs) {
  let n = 0;
  for (let i = (runs || []).length - 1; i >= 0; i -= 1) {
    const c = runs[i] && runs[i].counts;
    if (c && c.high === 0 && c.medium === 0) n += 1;
    else break;
  }
  return n;
}

/**
 * Whether history is explicitly turned off. `LINUX_DOCTOR_NO_HISTORY=1` is the
 * env override (handy in CI/cron where a writable data dir may not exist); the
 * CLI `--no-history` flag is OR-ed in by the caller. When disabled, runs are
 * neither read for diffing nor written — new/fixed tracking is simply silent.
 */
export function isHistoryDisabled({ cliFlag = false } = {}) {
  return cliFlag || /^(1|true|yes)$/i.test(process.env.LINUX_DOCTOR_NO_HISTORY || "");
}
