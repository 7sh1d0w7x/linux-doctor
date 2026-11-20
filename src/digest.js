// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `--digest`: the history file, read back as a story instead of a list.
 *
 * The report answers "what is wrong now"; the history answers "what keeps
 * happening". Those are different questions, and until now the only way to ask
 * the second was to open history.json. This module folds the stored runs into
 * four facts: the score trend, the findings that keep coming back, the ones
 * that appeared, and the ones that stopped.
 *
 * Pure functions over the run list: no filesystem, no clock of its own.
 */

const DAY_MS = 86400000;
const PROBLEM = new Set(["high", "medium"]);

function codeMap(run) {
  const map = new Map();
  for (const f of run.findings || []) {
    if (!PROBLEM.has(f.severity)) continue;
    if (!map.has(f.code)) map.set(f.code, f);
  }
  return map;
}

/**
 * Build the digest. `days` is the window; when no run falls inside it, the
 * whole stored history is used and reported as such (a fresh install has one
 * run, and an empty digest is less useful than the truth about that run).
 */
export function buildDigest(runs, { now = Date.now(), days = 7 } = {}) {
  const all = (Array.isArray(runs) ? runs : []).filter((r) => r && typeof r.at === "string");
  const since = now - days * DAY_MS;
  const inWindow = all.filter((r) => {
    const t = Date.parse(r.at);
    return Number.isFinite(t) && t >= since;
  });
  const used = inWindow.length ? inWindow : all;
  if (used.length === 0) return { runs: 0, windowDays: days, usedAll: true };

  const first = used[0];
  const last = used[used.length - 1];
  const scores = used.map((r) => r.score).filter((s) => typeof s === "number" && Number.isFinite(s));

  const lastCodes = codeMap(last);
  const firstCodes = codeMap(first);

  // A finding is chronic when it is in at least half the runs (and there are
  // enough runs for "half" to mean something). One bad afternoon is not a
  // pattern, and a single run is not a history.
  const seen = new Map();
  for (const run of used) {
    for (const [code, f] of codeMap(run)) {
      if (!seen.has(code)) seen.set(code, { code, title: f.title, severity: f.severity, count: 0 });
      seen.get(code).count += 1;
    }
  }
  const chronic = used.length >= 3
    ? [...seen.values()]
        .filter((s) => s.count >= Math.max(2, used.length * 0.5))
        .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    : [];

  // A chronic finding can also be missing from the first run (it was cleaned
  // once and came back). Calling that "new" contradicts the section above it,
  // so the chronic set wins.
  const chronicCodes = new Set(chronic.map((c) => c.code));

  const added = [...lastCodes.entries()]
    .filter(([code]) => !firstCodes.has(code) && !chronicCodes.has(code))
    .map(([code, f]) => ({ code, title: f.title, severity: f.severity }));

  const fixed = [...firstCodes.entries()]
    .filter(([code]) => !lastCodes.has(code) && !chronicCodes.has(code))
    .map(([code, f]) => ({ code, title: f.title, severity: f.severity }));

  return {
    runs: used.length,
    windowDays: days,
    usedAll: inWindow.length === 0,
    from: first.at,
    to: last.at,
    score: scores.length
      ? { now: scores[scores.length - 1], first: scores[0], min: Math.min(...scores), max: Math.max(...scores) }
      : null,
    chronic,
    added,
    fixed,
  };
}

function day(iso) {
  return String(iso || "").slice(0, 10);
}

/** Plain text, no colour: the digest is meant to be pasted into a note or a bug report. */
export function renderDigest(d) {
  if (!d || d.runs === 0) return "No runs stored yet. Run `linux-doctor` once and try again.";
  const out = [];
  const window = d.usedAll
    ? `all ${d.runs} stored run(s), ${day(d.from)} → ${day(d.to)}`
    : `last ${d.windowDays} days (${d.runs} run(s), ${day(d.from)} → ${day(d.to)})`;
  out.push(`Linux Doctor digest — ${window}`, "");

  if (d.score) {
    const s = d.score;
    const trend = s.now === s.first ? "flat" : s.now > s.first ? `+${s.now - s.first}` : String(s.now - s.first);
    out.push(`Score   ${s.now}/100 now · ${s.first} → ${s.now} over the window (${trend}) · range ${s.min}–${s.max}`);
    out.push("");
  }

  if (d.chronic.length) {
    out.push("Keeps coming back");
    for (const c of d.chronic) out.push(`  ${c.count}/${d.runs}  ${c.code} — ${c.title}`);
    out.push("");
  }
  if (d.added.length) {
    out.push("New since the window opened");
    for (const c of d.added) out.push(`  ${c.code} — ${c.title}`);
    out.push("");
  }
  if (d.fixed.length) {
    out.push("No longer reported");
    for (const c of d.fixed) out.push(`  ${c.code} — ${c.title}`);
    out.push("");
  }

  if (!d.chronic.length && !d.added.length && !d.fixed.length) {
    out.push("No recurring high or medium findings in this window.");
    out.push("");
  }
  return out.join("\n").trimEnd();
}
