// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Output drift guard — Phase 5's structural contract.
 *
 * Builds a payload through the REAL runtime path (the spawned binary, real
 * system probing) and asserts every key it emits is documented in
 * src/schema.js — top level and in the nested objects scripts consume. A new
 * user-facing field without a schema entry fails here, at CI time, instead of
 * surprising a fleet server or jq pipeline in the wild.
 *
 * Zero dependencies: this is key-set comparison against reportSchema, not a
 * JSON-Schema validator. Type checking stays the schema test's job.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { reportSchema } from "../src/schema.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "bin", "doctor.js");

/** Run the real binary against a throwaway config/history/cache state. */
function runRealDoctor(...args) {
  const dir = mkdtempSync(join(tmpdir(), "ld-drift-"));
  try {
    return spawnSync(process.execPath, [bin, ...args], {
      encoding: "utf8",
      timeout: 120000,
      env: {
        ...process.env,
        LINUX_DOCTOR_CONFIG: join(dir, "config.json"),
        LINUX_DOCTOR_HISTORY: join(dir, "history.json"),
        LINUX_DOCTOR_CACHE: join(dir, "cache"),
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function payloadKeys(payload) {
  return Object.keys(payload).sort();
}

test("drift: every top-level key the runtime emits is documented in the schema", () => {
  const res = runRealDoctor("--json");
  assert.equal(res.status === 0 || res.status === 1, true, `doctor exited oddly: ${res.stderr}`);
  const payload = JSON.parse(res.stdout);

  const allowed = new Set(Object.keys(reportSchema.properties));
  const undocumented = payloadKeys(payload).filter((k) => !allowed.has(k));
  assert.deepEqual(
    undocumented,
    [],
    `undocumented top-level keys (add them to src/schema.js or stop emitting them):\n${undocumented.join("\n")}`
  );

  // And the contract's mandatory half: the required keys really ship.
  for (const k of reportSchema.required) {
    assert.ok(k in payload, `payload must carry required key ${k}`);
  }
});

test("drift: nested object keys match their schema sections too", () => {
  const res = runRealDoctor("--json");
  const payload = JSON.parse(res.stdout);

  if (payload.system) {
    const sysAllowed = new Set(Object.keys(reportSchema.properties.system.properties));
    const bad = Object.keys(payload.system).filter((k) => !sysAllowed.has(k));
    assert.deepEqual(bad, [], `system keys not in schema: ${bad.join(", ")}`);
  }
  if (payload.diffSinceLast) {
    // Derived from the schema, not hardcoded: a hardcoded list silently drifts
    // from the schema it is supposed to check (it rejected `firstRun` while
    // schema.js already declared it).
    const diffAllowed = new Set(Object.keys(reportSchema.properties.diffSinceLast.properties));
    const bad = Object.keys(payload.diffSinceLast).filter((k) => !diffAllowed.has(k));
    assert.deepEqual(bad, [], `diffSinceLast keys not in schema: ${bad.join(", ")}`);
  }
  for (const f of payload.findings || []) {
    const fAllowed = new Set(Object.keys(reportSchema.definitions.finding.properties));
    const bad = Object.keys(f).filter((k) => !fAllowed.has(k));
    assert.deepEqual(bad, [], `finding keys not in schema: ${bad.join(", ")}`);
  }
  for (const b of payload.scoreBreakdown || []) {
    const bAllowed = new Set(["code", "severity", "title", "penalty"]);
    const bad = Object.keys(b).filter((k) => !bAllowed.has(k));
    assert.deepEqual(bad, [], `scoreBreakdown item keys not in schema: ${bad.join(", ")}`);
  }
});

test("drift: nextAction, when present, matches its documented shape", () => {
  const res = runRealDoctor("--json");
  const payload = JSON.parse(res.stdout);
  const na = payload.nextAction;
  if (na !== null && na !== undefined) {
    // Exactly the fields the dashboard renders — no more, no less.
    assert.deepEqual(Object.keys(na).sort(), ["code", "fix", "severity", "title"]);
    assert.ok(["high", "medium", "info"].includes(na.severity));
  }
});
