// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The package-manager lock. Two properties matter: tasks never overlap, and a
 * task that rejects does not wedge the queue (a failing check must not deadlock
 * every check after it).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createLock } from "../src/lock.js";
import { collectReport } from "../src/cli.js";
import { loadThresholds } from "../src/thresholds.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("lock: tasks run one at a time, in call order", async () => {
  const lock = createLock();
  const events = [];
  const task = (name) => async () => {
    events.push(`start ${name}`);
    await sleep(15);
    events.push(`end ${name}`);
    return name;
  };
  const results = await Promise.all([
    lock.run(task("a")),
    lock.run(task("b")),
    lock.run(task("c")),
  ]);
  assert.deepEqual(results, ["a", "b", "c"]);
  assert.deepEqual(events, [
    "start a", "end a",
    "start b", "end b",
    "start c", "end c",
  ]);
});

test("lock: a rejected task does not block the next one", async () => {
  const lock = createLock();
  const failed = lock.run(async () => {
    throw new Error("boom");
  });
  await assert.rejects(failed, /boom/);
  assert.equal(await lock.run(async () => "after"), "after");
});

// The wiring, not just the primitive: collectReport must actually use the lock
// for the three checks that touch apt/dnf/zypper.
function fakeCheck(id, state) {
  return {
    id,
    title: id,
    category: "system",
    appliesTo: ["desktop"],
    async run() {
      state.active += 1;
      state.max = Math.max(state.max, state.active);
      await sleep(25);
      state.active -= 1;
      return [];
    },
  };
}

function fakeRun() {
  return async () => ({ ok: true, code: 0, stdout: "", stderr: "" });
}

const SYSTEM = { osRelease: { id: "fedora" }, immutable: false, kind: "desktop" };

test("collectReport: packages, updates and orphans never overlap", async () => {
  const state = { active: 0, max: 0 };
  await collectReport({
    checkIds: [],
    checks: [fakeCheck("packages", state), fakeCheck("updates", state), fakeCheck("orphans", state)],
    ignorePatterns: [],
    ignoreCodes: [],
    thresholds: loadThresholds({}),
    run: fakeRun(),
    system: SYSTEM,
    profile: { kind: "desktop" },
  });
  assert.equal(state.max, 1, "package-manager checks must be serialized");
});

test("collectReport: unrelated checks still run in parallel", async () => {
  const state = { active: 0, max: 0 };
  await collectReport({
    checkIds: [],
    checks: [fakeCheck("packages", state), fakeCheck("memory", state), fakeCheck("disk", state)],
    ignorePatterns: [],
    ignoreCodes: [],
    thresholds: loadThresholds({}),
    run: fakeRun(),
    system: SYSTEM,
    profile: { kind: "desktop" },
  });
  assert.ok(state.max >= 2, `checks outside the lock should overlap, saw max ${state.max}`);
});
