// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The version comparator behind the dashboard's update chip. A wrong answer
 * here either hides a release or nags about an old one, so the cases are
 * spelled out rather than left to string comparison.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function load() {
  const src = readFileSync(join(ROOT, "src-gui", "js", "update-check.js"), "utf8");
  const ctx = vm.createContext({});
  vm.runInContext(`${src}\n;globalThis.__isNewer = isNewerVersion;`, ctx);
  return ctx.__isNewer;
}

test("update-check: compares numerically, not as strings", () => {
  const isNewer = load();
  assert.equal(isNewer("0.10.0", "0.9.0"), true, "0.10 is newer than 0.9");
  assert.equal(isNewer("0.9.1", "0.9.0"), true);
  assert.equal(isNewer("0.9.0", "0.9.0"), false);
  assert.equal(isNewer("0.9.0", "0.10.0"), false);
  assert.equal(isNewer("v1.0.0", "0.99.9"), true);
  assert.equal(isNewer("0.9", "0.9.0"), false, "a short version is not newer");
});
