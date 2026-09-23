// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { checks, byId } from "../src/checks/index.js";
import { ALL_KINDS } from "../src/checks/define.js";

test("registry: every check has the defineCheck shape", () => {
  assert.ok(checks.length >= 20, `expected a healthy number of checks, got ${checks.length}`);
  for (const c of checks) {
    assert.equal(typeof c.id, "string", "id");
    assert.equal(typeof c.title, "string", "title");
    assert.equal(typeof c.category, "string", "category");
    assert.ok(Array.isArray(c.appliesTo) && c.appliesTo.length > 0, "appliesTo is a non-empty list");
    assert.equal(typeof c.run, "function", "run");
  }
});

test("registry: ids are unique", () => {
  const ids = checks.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate check ids");
});

test("registry: appliesTo only contains known kinds", () => {
  for (const c of checks) {
    for (const k of c.appliesTo) {
      assert.ok(ALL_KINDS.includes(k), `check ${c.id} uses unknown kind "${k}"`);
    }
  }
});

test("registry: byId maps every check", () => {
  for (const c of checks) assert.equal(byId.get(c.id), c);
});

test("registry: the gated checks are exactly the expected ones", () => {
  const gated = checks.filter((c) => c.appliesTo.length < ALL_KINDS.length).map((c) => c.id).sort();
  assert.deepEqual(gated, ["audio", "battery", "bluetooth", "bringup", "cache", "certs", "fds", "gpu", "ports", "raid", "suspend", "wayland", "wifi"]);
});

test("registry: gpu runs before wayland (dedupe tie-break relies on it)", () => {
  const order = checks.map((c) => c.id);
  assert.ok(order.indexOf("gpu") < order.indexOf("wayland"), "gpu must precede wayland");
});
