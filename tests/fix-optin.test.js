// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The opt-in gate for `--fix --yes`, tested without touching the host.
 *
 * `fix-dryrun.test.js` proves the default is a dry run; it deliberately never
 * runs the `--yes` path because that path executes real system commands. This
 * file closes that gap safely:
 *
 *   - a user plugin emits findings whose codes exist in the safe-fix catalog,
 *     so the plan is deterministic and needs no real system state;
 *   - PATH is prefixed with stub `systemctl` / `podman` / `docker` scripts that
 *     only append their arguments to a log, so nothing real is executed;
 *   - the assertions are about *what was invoked*, not about system state.
 *
 * Guarantees checked:
 *   1. `--fix` without `--yes` invokes no fix command at all.
 *   2. `--fix --yes` invokes the `[apply]` commands.
 *   3. `--fix --yes` never invokes `[manual]` commands.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

const PLUGIN = `export default {
  id: "zz-fixprobe",
  title: "fix probe",
  async run() {
    return [
      {
        severity: "medium",
        code: "services/failed",
        title: "1 service failed to start",
        detail: "probe",
        evidence: "zz-fixprobe.service user",
        fix: "probe",
        confidence: "high",
      },
      {
        severity: "medium",
        code: "containerdisk/high",
        title: "container storage is large",
        detail: "probe",
        evidence: "probe",
        fix: "probe",
        confidence: "high",
      },
    ];
  },
};
`;

/** A stub that records its arguments instead of doing anything. */
function stub(dir, name, logName) {
  const file = join(dir, name);
  writeFileSync(
    file,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${join(dir, logName)}"\nexit 0\n`,
    "utf8",
  );
  chmodSync(file, 0o755);
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ld-optin-"));
  const plugins = join(dir, "plugins");
  const bin = join(dir, "bin");
  mkdirSync(plugins);
  mkdirSync(bin);
  writeFileSync(join(plugins, "zz-fixprobe.js"), PLUGIN, "utf8");
  stub(bin, "systemctl", "systemctl.log");
  stub(bin, "podman", "podman.log");
  stub(bin, "docker", "docker.log");
  return { dir, plugins, bin, logs: join(dir) };
}

function runFix({ plugins, bin, dir }, extraArgs) {
  return spawnSync(process.execPath, ["bin/doctor.js", "--fix", ...extraArgs], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      LINUX_DOCTOR_PLUGINS: plugins,
      LINUX_DOCTOR_NO_HISTORY: "1",
      LINUX_DOCTOR_CONFIG: join(dir, "config.json"),
      LINUX_DOCTOR_CACHE: join(dir, "cache"),
    },
  });
}

function readLog(dir, name) {
  const file = join(dir, name);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

test("--fix without --yes executes no fix command", () => {
  const ctx = setup();
  const r = runFix(ctx, ["--check", "zz-fixprobe"]);

  assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /dry run — nothing was executed/);
  assert.match(r.stdout, /\[apply\].*systemctl --user reset-failed/, "the plan should list the apply command");

  assert.equal(readLog(ctx.bin, "systemctl.log"), "", "systemctl must not run on a dry run");
  assert.equal(readLog(ctx.bin, "podman.log"), "", "podman must not run on a dry run");
  assert.equal(readLog(ctx.bin, "docker.log"), "", "docker must not run on a dry run");
});

test("--fix --yes executes the [apply] commands", () => {
  const ctx = setup();
  const r = runFix(ctx, ["--yes", "--check", "zz-fixprobe"]);

  assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);

  const calls = readLog(ctx.bin, "systemctl.log");
  assert.match(calls, /--user reset-failed zz-fixprobe\.service/);
  assert.match(calls, /--user restart zz-fixprobe\.service/);
});

test("--fix --yes never executes [manual] commands", () => {
  const ctx = setup();
  const r = runFix(ctx, ["--yes", "--check", "zz-fixprobe"]);

  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  // containerdisk/high is tier "manual": it is printed, never run.
  assert.match(r.stdout, /\[manual\]/, "the manual entry should still be printed");
  assert.equal(readLog(ctx.bin, "podman.log"), "", "manual podman command must not run");
  assert.equal(readLog(ctx.bin, "docker.log"), "", "manual docker command must not run");
});
