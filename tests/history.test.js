// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { score, scoreBreakdown, historyFile, loadHistory, saveRun, newFindings, diffSinceLast, changeMessage, isHistoryDisabled } from "../src/history.js";

test("score: healthy system is 100", () => {
  assert.equal(score([]), 100);
  assert.equal(score([{ severity: "info" }, { severity: "info" }]), 100);
});

test("score: flat penalties for small counts, floors at 0", () => {
  assert.equal(score([{ severity: "high" }]), 85);
  assert.equal(score([{ severity: "medium" }]), 92);
  assert.equal(score([{ severity: "high" }, { severity: "medium" }]), 77); // tiers don't interact
  assert.equal(score([{ severity: "medium" }, { severity: "medium" }, { severity: "medium" }]), 76); // first three flat
  const many = Array.from({ length: 20 }, () => ({ severity: "high" }));
  assert.equal(score(many), 0);
});

test("score: penalties escalate within a tier so criticals stand apart", () => {
  // 4 high: 15+20+25+30 = 90 — must be clearly worse than any medium pile.
  assert.equal(score(Array.from({ length: 4 }, () => ({ severity: "high" }))), 10);
  // 2 high: 15+20.
  assert.equal(score(Array.from({ length: 2 }, () => ({ severity: "high" }))), 65);
  // 7 medium: 8·3 + (9+10+11+12) = 66 — a pile of minors starts to bite, but stays above the critical case.
  assert.equal(score(Array.from({ length: 7 }, () => ({ severity: "medium" }))), 34);
  assert.ok(score(Array.from({ length: 7 }, () => ({ severity: "medium" }))) > score(Array.from({ length: 4 }, () => ({ severity: "high" }))));
});

test("score: escalation is order-independent", () => {
  const a = [{ severity: "high" }, { severity: "medium" }, { severity: "high" }, { severity: "high" }];
  const b = [...a].reverse();
  assert.equal(score(a), score(b));
});

// ---------------------------------------------------------------------------
// Phase 5: the score's arithmetic is auditable — score() is derived from
// scoreBreakdown(), so the invariant holds by construction and these tests
// pin it against accidental divergence.

test("scoreBreakdown: invariant 100 − Σpenalty === score, across shuffled inputs", () => {
  const findings = [
    { code: "disk/full", severity: "high", title: "Disk nearly full" },
    { code: "memory/low", severity: "medium", title: "Low memory" },
    { code: "services/failed", severity: "high", title: "Services failed" },
    { code: "zram/ok", severity: "info", title: "zram is enabled" },
    { code: "updates/pending", severity: "medium", title: "Updates pending" },
    { code: "thermal/warm", severity: "medium", title: "CPU running warm" },
  ];
  for (let i = 0; i < 20; i += 1) {
    const shuffled = [...findings].sort(() => Math.random() - 0.5);
    const total = scoreBreakdown(shuffled).reduce((acc, b) => acc + b.penalty, 0);
    assert.equal(100 - total, score(shuffled), `invariant broke on permutation ${i}`);
  }
});

test("scoreBreakdown: escalation ladder matches the documented per-ordinal values", () => {
  // High: 15, 20, 25 — mediums stay flat 8 through the third, the fourth pays 9.
  const rows = scoreBreakdown([
    { code: "a/x", severity: "high", title: "A" },
    { code: "b/y", severity: "medium", title: "B" },
    { code: "c/z", severity: "high", title: "C" },
    { code: "d/w", severity: "high", title: "D" },
    { code: "e/v", severity: "medium", title: "E" },
    { code: "f/u", severity: "medium", title: "F" },
    { code: "g/t", severity: "medium", title: "G" },
  ]);
  assert.deepEqual(rows.map((r) => r.penalty), [15, 8, 20, 25, 8, 8, 9]);
});

test("scoreBreakdown: info is free but listed; identity prefers code over title", () => {
  const rows = scoreBreakdown([
    { code: "zram/ok", severity: "info", title: "zram is enabled" },
    { severity: "info", title: "legacy plugin note" },
  ]);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.penalty, 0);
  assert.deepEqual(
    rows.map((r) => [r.code, r.title]),
    [["zram/ok", "zram is enabled"], [null, "legacy plugin note"]]
  );
});

test("newFindings: flags findings whose title is not in the previous run", () => {
  const runs = [{ findings: [{ title: "Disk nearly full" }, { title: "Old issue" }] }];
  const current = [
    { title: "Disk nearly full" },
    { title: "New issue appeared" },
    { title: "Another new one" },
  ];
  const fresh = newFindings(current, runs);
  assert.deepEqual(
    fresh.map((f) => f.title),
    ["New issue appeared", "Another new one"]
  );
});

test("newFindings: no previous run means nothing is new", () => {
  assert.deepEqual(newFindings([{ title: "X" }], []), []);
});

test("diffSinceLast: reports added and fixed findings (title fallback when no code)", () => {
  const runs = [{ findings: [{ severity: "medium", title: "Old issue" }, { severity: "info", title: "Still here" }] }];
  const current = [
    { severity: "high", title: "Still here" },
    { severity: "medium", title: "Brand new" },
  ];
  const diff = diffSinceLast(current, runs);
  assert.deepEqual(diff.added, [{ code: "Brand new", severity: "medium", title: "Brand new" }]);
  assert.deepEqual(diff.fixed, [{ code: "Old issue", severity: "medium", title: "Old issue" }]);
});

test("diffSinceLast: matches by stable code, so a volatile count in the title does not churn", () => {
  const runs = [{ findings: [{ severity: "medium", code: "services/failed", title: "3 services failed to start" }] }];
  const current = [{ severity: "medium", code: "services/failed", title: "2 services failed to start" }];
  const diff = diffSinceLast(current, runs);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.fixed, []);
});

test("newFindings: matches by code when present, so volatile titles do not churn", () => {
  const runs = [{ findings: [{ code: "updates/pending", title: "5 updates available" }] }];
  const current = [
    { code: "updates/pending", title: "7 updates available" },
    { code: "services/failed", title: "1 service failed to start" },
  ];
  const fresh = newFindings(current, runs);
  assert.deepEqual(fresh.map((f) => f.title), ["1 service failed to start"]);
});

test("diffSinceLast: no previous run is a first run, not everything unchanged", () => {
  // The first run used to report "34 unchanged" on a machine with no history at
  // all. "unchanged" means "also present in the previous run" (schema.js says
  // exactly that), so with no previous run the only honest count is zero.
  assert.deepEqual(diffSinceLast([{ title: "X" }], []), { added: [], fixed: [], unchanged: 0, firstRun: true });
});

test("diffSinceLast: reports unchanged as the third count", () => {
  const runs = [{ findings: [{ severity: "medium", code: "a", title: "A" }, { severity: "info", code: "b", title: "B" }] }];
  const current = [
    { severity: "medium", code: "a", title: "A" },
    { severity: "high", code: "c", title: "C" },
  ];
  const diff = diffSinceLast(current, runs);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.fixed.length, 1);
  assert.equal(diff.unchanged, 1);
});

test("changeMessage: null when nothing changed", () => {
  assert.equal(changeMessage({ newCount: 0, fixedCount: 0 }), null);
  assert.equal(changeMessage({}), null);
});

test("changeMessage: human one-liner for new and fixed", () => {
  assert.equal(changeMessage({ newCount: 1, fixedCount: 0 }), "Since last run: 1 new issue.");
  assert.equal(changeMessage({ newCount: 2, fixedCount: 1 }), "Since last run: 2 new issues, 1 fixed.");
  assert.equal(changeMessage({ newCount: 0, fixedCount: 3 }), "Since last run: 3 fixed.");
});

test("isHistoryDisabled: false by default, true via env or flag", () => {
  assert.equal(isHistoryDisabled(), false);
  assert.equal(isHistoryDisabled({ cliFlag: true }), true);
  process.env.LINUX_DOCTOR_NO_HISTORY = "1";
  try {
    assert.equal(isHistoryDisabled(), true);
  } finally {
    delete process.env.LINUX_DOCTOR_NO_HISTORY;
  }
});

test("saveRun: writes atomically via temp file and leaves no residue", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-hist-"));
  const file = join(dir, "history.json");
  process.env.LINUX_DOCTOR_HISTORY = file;
  try {
    saveRun({ at: "t1", score: 90, findings: [] }, file);
    saveRun({ at: "t2", score: 80, findings: [] }, file);
    assert.equal(existsSync(`${file}.tmp`), false, "no temp file left behind");
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(parsed.runs.length, 2);
    assert.equal(parsed.runs[1].at, "t2");
  } finally {
    delete process.env.LINUX_DOCTOR_HISTORY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("historyFile: respects LINUX_DOCTOR_HISTORY override", () => {
  process.env.LINUX_DOCTOR_HISTORY = "/tmp/ld-test-history.json";
  try {
    assert.equal(historyFile(), "/tmp/ld-test-history.json");
  } finally {
    delete process.env.LINUX_DOCTOR_HISTORY;
  }
});

test("saveRun/loadHistory: round-trips and keeps only the last 50 runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-hist-"));
  const file = join(dir, "history.json");
  process.env.LINUX_DOCTOR_HISTORY = file;
  try {
    for (let i = 0; i < 55; i += 1) {
      saveRun({ at: String(i), score: i, counts: {}, findings: [] }, file);
    }
    const runs = loadHistory(file);
    assert.equal(runs.length, 50, "history is capped at 50 runs");
    assert.equal(runs[0].at, "5", "oldest kept run is the 6th");
    assert.equal(runs[49].at, "54");
  } finally {
    delete process.env.LINUX_DOCTOR_HISTORY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveRun: unwritable location fails silently", () => {
  // A path whose parent is a regular file fails fast with ENOTDIR (avoids
  // slow/hanging mkdir on special filesystems like /proc).
  const dir = mkdtempSync(join(tmpdir(), "ld-hist-"));
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "");
  process.env.LINUX_DOCTOR_HISTORY = join(blocker, "history.json");
  try {
    assert.doesNotThrow(() => saveRun({ findings: [] }));
  } finally {
    delete process.env.LINUX_DOCTOR_HISTORY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadHistory: missing or corrupt file returns an empty list", () => {
  assert.deepEqual(loadHistory("/nonexistent/path/history.json"), []);
  const dir = mkdtempSync(join(tmpdir(), "ld-hist-"));
  const file = join(dir, "bad.json");
  try {
    process.env.LINUX_DOCTOR_HISTORY = file;
    writeFileSync(file, "{ not json !!");
    assert.deepEqual(loadHistory(file), []);
  } finally {
    delete process.env.LINUX_DOCTOR_HISTORY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("history v2: saveRun writes a versioned wrapper", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-hist-v2-"));
  const file = join(dir, "history.json");
  try {
    saveRun({ at: "2026-08-22T00:00:00Z", score: 80, counts: {}, findings: [{ code: "a/b", severity: "info", title: "t" }] }, file);
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(parsed.version, 2);
    assert.equal(loadHistory(file).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("history repair-on-read: malformed entries drop, well-formed survive", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-hist-fix-"));
  const file = join(dir, "history.json");
  try {
    writeFileSync(file, JSON.stringify({
      version: 2,
      runs: [
        null,
        { at: "no-score" },
        { at: "2026-08-21T00:00:00Z", score: 90, findings: [{ code: "a/b", severity: "info", title: "ok" }, null, 42] },
        { at: "2026-08-22T00:00:00Z", score: "garbage", findings: [] },
        "not-an-object",
      ],
    }));
    const runs = loadHistory(file);
    assert.equal(runs.length, 1, "only the well-formed run survives");
    assert.equal(runs[0].findings.length, 1, "broken finding entries are dropped, not the run");
    // Truncated JSON → no history at all, never a throw.
    writeFileSync(file, '{"version": 2, "runs": [{"at": "2026-08');
    assert.deepEqual(loadHistory(file), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upgrade path: v1 title-only history bridges where titles survive", () => {
  const prevRuns = [{
    at: "2026-08-01T00:00:00Z",
    score: 70,
    findings: [{ title: "3 services failed to start" }, { title: "Disk is getting full" }],
  }];
  const current = [
    { code: "services/failed", severity: "medium", title: "2 services failed to start" }, // reworded → surfaces ONCE
    { code: "disk/full", severity: "high", title: "Disk is getting full" }, // same wording → seamless
    { code: "memory/low", severity: "high", title: "Low memory" }, // genuinely new
  ];
  const diff = diffSinceLast(current, prevRuns);
  // Not an all-storm: identical-title legacy entries keep their identity…
  assert.ok(diff.added.some((f) => f.code === "disk/full") === false);
  // …while genuinely-new and REWORDED issues show up — bounded to the one
  // transition run, never repeated afterwards (both sides now carry codes).
  assert.deepEqual(diff.added.map((f) => f.code).sort(), ["memory/low", "services/failed"]);
  assert.deepEqual(diff.fixed.map((f) => f.title), ["3 services failed to start"]);
  assert.equal(diff.unchanged, 1);

  // Once BOTH sides carry codes, identity is the code alone: a rewritten
  // title with the same code stays unchanged forever.
  const codedPrev = [{ at: "x", score: 70, findings: [{ code: "services/failed", severity: "medium", title: "old wording" }] }];
  const d2 = diffSinceLast([{ code: "services/failed", severity: "medium", title: "brand new wording" }], codedPrev);
  assert.deepEqual(d2.added, []);
  assert.deepEqual(d2.fixed, []);
  assert.equal(d2.unchanged, 1);
});
