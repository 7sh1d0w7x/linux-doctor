// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Output parity — the Phase 2 contract: history numbers are computed ONCE
 * (attachHistory) and every channel renders exactly those numbers. The CLI
 * text report, --plain, and --json must agree; the dashboard consumes the
 * same JSON payload, so parity with --json is parity with the dashboard.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReport, renderPlain, renderJson, pickNextFinding } from "../src/report.js";
import { score, scoreBreakdown } from "../src/history.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SYSTEM = { distro: "Test 1", kernel: "6.1.0", cores: 4, uptime: "1h" };

const FINDINGS = [
  { id: 1, check: "services", code: "services/failed", severity: "medium", title: "2 services failed to start", detail: null, evidence: null, fix: "restart them", isNew: false },
  { id: 2, check: "disk", code: "disk/full", severity: "high", title: "Disk nearly full", detail: null, evidence: null, fix: "clean space", isNew: true },
];

const DIFF = {
  added: [{ code: "disk/full", severity: "high", title: "Disk nearly full" }],
  fixed: [{ code: "audio/no-server", severity: "medium", title: "old issue gone" }],
  unchanged: 1,
};

const OPTS = {
  system: SYSTEM,
  score: 77,
  scoreDelta: 5,
  newCount: DIFF.added.length,
  fixedCount: DIFF.fixed.length,
  unchanged: DIFF.unchanged,
  diffSinceLast: DIFF,
};

test("parity: a first run says so instead of claiming everything is unchanged", async () => {
  // First contact with the tool: no history, so nothing can be "unchanged".
  const pretty = await renderReport(FINDINGS, { ...OPTS, firstRun: true });
  const plain = renderPlain(FINDINGS, { ...OPTS, firstRun: true });
  assert.match(pretty, /SINCE LAST RUN   first run — no baseline to compare against/);
  assert.match(plain, /^# since: first run \(no baseline\)$/m);
});

test("parity: CLI, --plain and --json carry the same new/fixed/unchanged", async () => {
  const pretty = await renderReport(FINDINGS, { ...OPTS });
  const plain = renderPlain(FINDINGS, { ...OPTS });
  const json = JSON.parse(renderJson(FINDINGS, SYSTEM, { ...OPTS, generatedAt: "2026-08-22T00:00:00Z" }));

  // Header line in the pretty report.
  assert.match(pretty, /SINCE LAST RUN   1 new · 1 fixed · 1 unchanged/);
  // # comment lines in plain.
  assert.match(plain, /^# since: 1 new, 1 fixed, 1 unchanged$/m);
  assert.match(plain, /^# new: 1$/m);
  assert.match(plain, /^# fixed: 1$/m);
  // Structured fields in JSON.
  assert.equal(json.newCount, 1);
  assert.equal(json.fixedCount, 1);
  assert.equal(json.unchanged, 1);
  assert.deepEqual(json.diffSinceLast.added.map((f) => f.code), ["disk/full"]);
});

test("parity: NEW badge appears on exactly the added findings in both text channels", async () => {
  const pretty = await renderReport(FINDINGS, { ...OPTS });
  const plain = renderPlain(FINDINGS, { ...OPTS });
  assert.match(pretty, /Disk nearly full\s+🆕 NEW/);
  assert.doesNotMatch(pretty, /failed to start\s+🆕 NEW/);
  assert.match(plain, /^high\t1\tDisk nearly full \(new\)$/m);
  assert.match(plain, /^medium\t2\t2 services failed to start$/m);
});

test("parity: score is severity-driven only — history content cannot bend it", () => {
  // The score function takes findings alone; runs/diffs are never an input.
  // A pathological history cannot change today's verdict for same findings.
  const a = score([{ severity: "high" }, { severity: "medium" }]);
  const b = score([{ severity: "medium" }, { severity: "high" }]);
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// Phase 5: the score's arithmetic travels with the report — same numbers in
// every channel, derived once from scoreBreakdown.

test("parity: score breakdown agrees across CLI, --plain and --json", async () => {
  const bd = scoreBreakdown(FINDINGS);
  const opts = { ...OPTS, scoreBreakdown: bd };
  const pretty = await renderReport(FINDINGS, { ...opts });
  const plain = renderPlain(FINDINGS, { ...opts });
  const json = JSON.parse(renderJson(FINDINGS, SYSTEM, { ...opts, generatedAt: "2026-08-22T00:00:00Z" }));

  // The fixture itself must be internally consistent: penalties sum to the
  // score's distance from 100.
  const total = bd.reduce((acc, b) => acc + b.penalty, 0);
  assert.equal(100 - total, OPTS.score);

  // Display order (most expensive first) and content agree everywhere.
  assert.match(pretty, /SCORE     77\/100 = 100 −15 disk\/full −8 services\/failed/);
  // Score delta uses the same "(+N)" convention in pretty and plain.
  assert.match(pretty, /health 77\/100 \(\+5\)/);
  assert.match(plain, /^# score: 77\/100 \(\+5\)$/m);
  assert.match(plain, /^# score-breakdown: -15 disk\/full \| -8 services\/failed$/m);
  assert.deepEqual(
    json.scoreBreakdown.map((b) => [b.code, b.penalty]),
    [["services/failed", 8], ["disk/full", 15]] // data keeps input order
  );
});

test("scoreBreakdown: clean system renders no SCORE line at all", async () => {
  const pretty = await renderReport([], { system: SYSTEM, score: 100, scoreBreakdown: [], newCount: 0, fixedCount: 0, unchanged: 0 });
  assert.ok(!pretty.includes("SCORE "), "no arithmetic line when nothing was penalized");
});

test("trend: the current run is part of the sparkline, not one run behind", async () => {
  const history = [
    { at: "a", score: 61, counts: { high: 1, medium: 2, info: 0 } },
    { at: "b", score: 67, counts: { high: 0, medium: 3, info: 0 } },
  ];
  // Current verdict is 76 — the trend must END at 76, not trail at 67.
  const pretty = await renderReport([], { system: SYSTEM, score: 76, newCount: 0, fixedCount: 0, unchanged: 0, history });
  assert.match(pretty, /TREND    ▅▆▆  last 3 run\(s\) · 61 → 76 ▲/);
});

// ---------------------------------------------------------------------------
// Phase 4: shared vocabulary + nextAction agreement.

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src-gui", "index.html"), "utf8");

test("vocabulary: the same phrases exist in CLI output and the dashboard HTML", async () => {
  const mixed = [
    { id: 1, check: "disk", code: "disk/full", severity: "high", title: "Disk nearly full", fix: "clean space" },
    { id: 2, check: "zram", code: "zram/ok", severity: "info", title: "zram is enabled" },
  ];
  const pretty = await renderReport(mixed, { system: SYSTEM, score: 70, newCount: 0, fixedCount: 0, unchanged: 2, checksRun: 30, skippedChecks: [{ id: "reboot", title: "Reboot", reason: "Not applicable on an immutable/atomic system." }], checkErrors: [{ check: "smart", error: "smartctl unavailable" }] });
  // Info-only systems read the honest "notes below" line…
  const infoOnly = await renderReport(
    [{ id: 2, check: "zram", code: "zram/ok", severity: "info", title: "zram is enabled" }],
    { system: SYSTEM, score: 100, newCount: 0, fixedCount: 0, unchanged: 1 }
  );
  // …while a spotless machine with history earns the streak phrasing.
  const streaky = await renderReport([], {
    system: SYSTEM, score: 100, newCount: 0, fixedCount: 0, unchanged: 0,
    history: [
      { at: "a", score: 100, counts: { high: 0, medium: 0, info: 0 } },
      { at: "b", score: 100, counts: { high: 0, medium: 0, info: 0 } },
    ],
  });

  const phrases = [
    ["SINCE LAST RUN", pretty, /SINCE LAST RUN/],
    ["Changes since last run (GUI)", null, /Changes since last run/],
    ["START HERE (CLI)", pretty, /START HERE/],
    ["START HERE (GUI)", null, /START HERE/],
    ["No high or medium issues (CLI)", infoOnly, /No high or medium issues/],
    ["No high or medium issues (GUI)", null, /No high or medium issues/],
    ["Skipped checks (CLI)", pretty, /not applicable on this immutable/],
    ["checkErrors (CLI)", pretty, /failed to run: smart/],
    ["Skipped checks (GUI)", null, /Skipped checks/],
    ["Failed checks (CLI)", pretty, /failed to run|failed\(/],
    ["Failed checks (GUI)", null, /Failed checks/],
    ["clean run streak (CLI)", streaky, /3 clean run\(s\) in a row/],
    ["clean run streak (GUI)", null, /clean run/],
    ["humanized group labels (GUI)", null, /issues need attention/],
    ["card actions (GUI)", null, /Copy fix/],
    ["dismiss action (GUI)", null, /Dismiss/],
    ["recommended next step (GUI)", null, /Recommended next step/],
    ["what happened (GUI)", null, /What happened/],
    ["evidence label (GUI)", null, /Evidence — how we detected it/],
    ["inspect action (GUI)", null, /Inspect details/],
    ["view tabs (GUI)", null, /data-view="overview"/],
    ["brand home-link (GUI)", null, /id="brand"/],
    ["views panels (GUI)", null, /id="view-history"/],
    ["all five views (GUI)", null, /data-view="schedule"/],
    ["system view (GUI)", null, /Operating system/],
    ["system wiki hardware (GUI)", null, /What this machine is/],
    ["schedule view (GUI)", null, /Scheduled checks/],
    ["run ledger (GUI)", null, /Past runs/],
  ];
  for (const [name, text, re] of phrases) {
    if (text !== null) assert.ok(re.test(text), `CLI report missing "${name}"`);
    else assert.ok(re.test(HTML), `dashboard HTML missing "${name}"`);
  }
});

test("nextAction: --json pick matches the ▶ START HERE line in the report", async () => {
  const cat = new Map([["services", "system"], ["memory", "performance"]]);
  const findings = [
    { id: 1, check: "services", code: "services/failed", severity: "medium", title: "Services failed", fix: "restart them" },
    { id: 2, check: "memory", code: "memory/low", severity: "medium", title: "Low memory", fix: "close apps" },
    { id: 3, check: "disk", code: "disk/full", severity: "high", title: "Disk nearly full", fix: "clean space" },
  ];
  const next = pickNextFinding(findings, cat);
  assert.equal(next.code, "disk/full");

  const pretty = await renderReport(findings, { system: SYSTEM, score: 60, categoryByCheck: cat });
  const startLine = pretty.split("\n").find((l) => l.includes("▶ START HERE"));
  assert.match(startLine, new RegExp("#\\d+ " + next.title.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")));

  // And exactly what --json ships (renderJson is a pass-through for extra).
  const json = JSON.parse(renderJson(findings, SYSTEM, { nextAction: next }));
  assert.equal(json.nextAction.title, next.title);
  assert.equal(json.nextAction.fix, "clean space");
});

test("nextAction: null when nothing has a fix (banner hides too)", async () => {
  assert.equal(pickNextFinding([{ id: 1, code: "x/y", severity: "high", title: "t" }]), null);
});
