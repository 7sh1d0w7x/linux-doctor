// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Correlation layer: findings that describe one problem become one finding.
 * The two failure modes to guard against are folding too little (the feature
 * does nothing) and folding too much (a healthy `ok` finding disappears into a
 * problem story, or two unrelated areas collapse into one).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { applyStories, STORIES } from "../src/stories.js";
import { urgencyOf } from "../src/severities.js";

const f = (id, code, severity, extra = {}) => ({
  id,
  code,
  severity,
  title: `title ${code}`,
  detail: `detail ${code}`,
  evidence: `evidence ${code}`,
  fix: null,
  confidence: "high",
  check: code.split("/")[0],
  ...extra,
});

test("stories: two problems in one area become one finding, children intact", () => {
  const out = applyStories([
    f(1, "memory/low", "medium"),
    f(2, "processes/high", "medium"),
    f(3, "fs/ok", "info"),
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].code, "story/memory");
  assert.equal(out[0].severity, "medium");
  assert.equal(out[0].children.length, 2);
  assert.deepEqual(out[0].children.map((c) => c.code), ["memory/low", "processes/high"]);
  // The parts keep their own identity for anyone reading the JSON.
  assert.ok(out[0].children.every((c) => c.title && c.detail && c.evidence));
  // Ids are contiguous after the collapse.
  assert.deepEqual(out.map((x) => x.id), [1, 2]);
  assert.equal(out[1].code, "fs/ok");
});

test("stories: the story takes the worst severity and that member's fix", () => {
  const out = applyStories([
    f(1, "disk/full", "high", { fix: "delete something" }),
    f(2, "cache/large", "medium", { fix: "clear the cache" }),
  ]);
  assert.equal(out[0].code, "story/disk");
  assert.equal(out[0].severity, "high");
  assert.equal(out[0].fix, "delete something", "the next step is the worst member's");
});

test("stories: a single finding is a fact, not a story", () => {
  const out = applyStories([f(1, "disk/full", "high"), f(2, "fs/ok", "info")]);
  assert.deepEqual(out.map((x) => x.code), ["disk/full", "fs/ok"]);
});

test("stories: informational findings are never folded into a problem", () => {
  // zram/ok next to memory/low must stay a separate, healthy note.
  const out = applyStories([f(1, "memory/low", "medium"), f(2, "zram/ok", "info")]);
  assert.deepEqual(out.map((x) => x.code), ["memory/low", "zram/ok"]);
  // Two info findings in one area do not form a story either.
  const infos = applyStories([f(1, "zram/ok", "info"), f(2, "memory/swap", "info")]);
  assert.deepEqual(infos.map((x) => x.code), ["zram/ok", "memory/swap"]);
});

test("stories: different areas do not collapse into each other", () => {
  const out = applyStories([
    f(1, "memory/low", "medium"),
    f(2, "disk/full", "high"),
    f(3, "services/failed", "medium"),
    f(4, "timers/broken", "medium"),
  ]);
  assert.deepEqual(out.map((x) => x.code), ["memory/low", "disk/full", "story/services"]);
});

test("stories: order is stable, the story sits where its first member was", () => {
  const out = applyStories([
    f(1, "fs/ok", "info"),
    f(2, "processes/high", "medium"),
    f(3, "disk/full", "high"),
    f(4, "memory/low", "medium"),
  ]);
  assert.deepEqual(out.map((x) => x.code), ["fs/ok", "story/memory", "disk/full"]);
});

test("stories: folding a high finding does not demote its urgency", () => {
  // disk/full is a "now" code; story/disk is not in NOW_CODES, so the story
  // must inherit urgency from its children or the callout quietly disappears.
  const out = applyStories([
    f(1, "disk/full", "high"),
    f(2, "journald/large", "medium"),
  ]);
  assert.equal(out[0].code, "story/disk");
  assert.equal(urgencyOf(out[0]), "now");
  assert.equal(urgencyOf(f(9, "memory/low", "medium")), "watch");
});

test("stories: every story id maps to at least two checks", () => {
  for (const s of STORIES) {
    assert.ok(s.checks.length >= 2, `${s.id} can never fire with fewer than two checks`);
    assert.match(s.id, /^[a-z0-9-]+$/);
  }
});
