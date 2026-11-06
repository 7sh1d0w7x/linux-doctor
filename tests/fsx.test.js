// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * File-safety contracts for the state files Linux Doctor owns (audit M3/M8).
 * atomicWrite must: create 0600 files in 0700 dirs, replace atomically, never
 * follow a planted symlink, and leave no temp siblings behind.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWrite } from "../src/fsx.js";
import { loadConfig } from "../src/config.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "ld-fsx-"));
}

test("atomicWrite: 0600 file inside a 0700 dir, atomic replace, no temp left", () => {
  const dir = tmp();
  try {
    const file = join(dir, "sub", "config.json");
    assert.equal(atomicWrite(file, "{}\n"), true);
    assert.equal(statSync(file).mode & 0o777, 0o600, "file must be 0600");
    assert.equal(statSync(join(dir, "sub")).mode & 0o777, 0o700, "dir must be 0700");
    assert.equal(readFileSync(file, "utf8"), "{}\n");
    assert.equal(atomicWrite(file, '{"a":1}\n'), true, "overwrite must succeed");
    assert.deepEqual(readdirSync(join(dir, "sub")), ["config.json"], "no .tmp siblings");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWrite: replaces a planted symlink instead of writing through it", () => {
  const dir = tmp();
  try {
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "original");
    const link = join(dir, "config.json");
    symlinkSync(victim, link);
    assert.equal(atomicWrite(link, "hijacked\n"), true);
    assert.equal(readFileSync(victim, "utf8"), "original", "symlink target must be untouched");
    assert.equal(readFileSync(link, "utf8"), "hijacked\n", "the link itself is replaced by a real file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig: a corrupt file warns instead of disappearing silently", (t) => {
  const dir = tmp();
  try {
    const file = join(dir, "config.json");
    writeFileSync(file, "{ not json");
    const spy = t.mock.method(console, "error", () => {});
    assert.deepEqual(loadConfig(file), {}, "defaults still apply");
    assert.ok(spy.mock.callCount() >= 1, "corruption must be surfaced once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWrite: a procfs path fails fast instead of hanging", () => {
  // Node's recursive mkdirSync spins forever on procfs instead of returning
  // EACCES, so a bad XDG_CACHE_HOME under /proc hung the whole scan. The guard
  // must return false immediately, like any other unwritable directory.
  const started = Date.now();
  assert.equal(atomicWrite("/proc/linux-doctor-test/x.json", "{}\n"), false);
  assert.equal(atomicWrite("/sys/linux-doctor-test/x.json", "{}\n"), false);
  assert.ok(Date.now() - started < 1000, "must not hang");
});
