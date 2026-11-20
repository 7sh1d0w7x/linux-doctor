// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The digest is a reading of the history file, so its failure modes are
 * statistical: calling a recurring finding "new" because it was cleaned once,
 * letting `ok` findings into the chronic list, or reporting a trend from a
 * single run. These pin the rules.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDigest, renderDigest } from "../src/digest.js";

const DAY = 86400000;
const NOW = Date.parse("2026-11-20T12:00:00Z");

function run(daysAgo, score, codes) {
  return {
    at: new Date(NOW - daysAgo * DAY).toISOString(),
    score,
    findings: codes.map(([code, severity = "medium"]) => ({ code, severity, title: `title ${code}` })),
  };
}

test("digest: no history says so instead of printing empty sections", () => {
  const d = buildDigest([], { now: NOW });
  assert.equal(d.runs, 0);
  assert.match(renderDigest(d), /No runs stored yet/);
});

test("digest: only high/medium findings count", () => {
  const d = buildDigest([
    run(5, 100, [["fs/ok", "info"], ["memory/low", "medium"]]),
    run(4, 92, [["fs/ok", "info"], ["memory/low", "medium"]]),
    run(3, 92, [["fs/ok", "info"], ["memory/low", "medium"]]),
  ], { now: NOW });
  assert.deepEqual(d.chronic.map((c) => c.code), ["memory/low"]);
  assert.ok(!d.chronic.some((c) => c.code === "fs/ok"));
});

test("digest: a finding in half the runs is chronic, one bad run is not", () => {
  const runs = [
    run(6, 92, [["memory/low"]]),
    run(5, 92, [["memory/low"]]),
    run(4, 92, [["disk/full", "high"]]),
    run(3, 100, []),
  ];
  const d = buildDigest(runs, { now: NOW });
  assert.deepEqual(d.chronic.map((c) => c.code), ["memory/low"], "2 of 4 is the threshold; 1 of 4 is not");
});

test("digest: one run is not a history — nothing is called chronic", () => {
  const d = buildDigest([run(1, 92, [["memory/low"]])], { now: NOW });
  assert.deepEqual(d.chronic, []);
});

test("digest: a chronic finding that was cleaned once is not 'new'", () => {
  const d = buildDigest([
    run(5, 100, []), // cache cleaned
    run(4, 92, [["cache/large"]]),
    run(3, 92, [["cache/large"]]),
    run(2, 92, [["cache/large"]]),
    run(1, 92, [["cache/large"]]),
  ], { now: NOW });
  assert.deepEqual(d.chronic.map((c) => c.code), ["cache/large"]);
  assert.deepEqual(d.added.map((c) => c.code), [], "recurring, not new");
});

test("digest: added and fixed compare the ends of the window, and skip the chronic set", () => {
  const d = buildDigest([
    run(5, 84, [["backup/stale"], ["memory/low"]]),
    run(4, 84, [["memory/low"]]),
    run(3, 84, [["memory/low"]]),
    run(2, 84, [["memory/low"], ["gpu-errors/xid", "high"]]),
    run(1, 92, [["gpu-errors/xid", "high"]]),
  ], { now: NOW });
  assert.deepEqual(d.added.map((c) => c.code), ["gpu-errors/xid"]);
  assert.deepEqual(d.fixed.map((c) => c.code), ["backup/stale"], "chronic memory/low is neither new nor fixed");
});

test("digest: score trend spans first, last, min and max", () => {
  const d = buildDigest([run(3, 100, []), run(2, 57, []), run(1, 92, [])], { now: NOW });
  assert.deepEqual(d.score, { now: 92, first: 100, min: 57, max: 100 });
});

test("digest: an empty window falls back to all stored runs and says so", () => {
  const d = buildDigest([run(30, 92, []), run(29, 100, [])], { now: NOW });
  assert.equal(d.usedAll, true);
  assert.equal(d.runs, 2);
  assert.match(renderDigest(d), /all 2 stored run/);
});

test("digest: the rendered text names the recurring finding and its ratio", () => {
  const d = buildDigest([
    run(3, 92, [["memory/low"]]),
    run(2, 92, [["memory/low"]]),
    run(1, 92, [["memory/low"]]),
  ], { now: NOW });
  const text = renderDigest(d);
  assert.match(text, /Keeps coming back/);
  assert.match(text, /3\/3 {2}memory\/low/);
  assert.match(text, /92\/100 now/);
});
