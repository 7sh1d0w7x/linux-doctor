// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliBin, installTimer, renderService, renderTimer, systemdPresent, timerStatus, unitPaths, uninstallTimer } from "../src/units.js";

/** A fake systemctl that logs its arguments and always succeeds. */
function fakeSystemctl(dir) {
  const log = join(dir, "systemctl.log");
  const bin = join(dir, "systemctl");
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`, { mode: 0o755 });
  return { dir, bin, log, calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}

const realSystemd = () => true;
const fakeHome = () => mkdtempSync(join(tmpdir(), "ld-units-"));

test("renderService: ExecStart quotes node + bin and carries --notify", () => {
  const unit = renderService({ node: "/usr/bin/node", bin: "/opt/linux-doctor/bin/doctor.js" });
  assert.match(unit, /^\[Unit\]/m);
  assert.match(unit, /^\[Service\]/m);
  assert.match(unit, /^Type=oneshot$/m);
  assert.match(unit, /^ExecStart="\/usr\/bin\/node" "\/opt\/linux-doctor\/bin\/doctor\.js" --notify$/m);
  assert.match(unit, /--uninstall-timer/, "the unit documents its own removal");
});

test("renderTimer: boots after 10min, daily cadence, persistent", () => {
  const unit = renderTimer();
  assert.match(unit, /^OnBootSec=10min$/m);
  assert.match(unit, /^OnUnitActiveSec=24h$/m);
  assert.match(unit, /^Persistent=true$/m);
  assert.match(unit, /^WantedBy=timers\.target$/m);
});

test("cliBin: resolves this package's real bin/doctor.js", () => {
  assert.match(cliBin(), /bin[\\/]doctor\.js$/);
  assert.ok(existsSync(cliBin()));
});

test("systemdPresent: /run/systemd/system is the probe", () => {
  assert.equal(systemdPresent((p) => p === "/run/systemd/system"), true);
  assert.equal(systemdPresent(() => false), false);
});

test("unitPaths: LINUX_DOCTOR_USER_UNITS overrides the user dir", () => {
  const prev = process.env.LINUX_DOCTOR_USER_UNITS;
  try {
    process.env.LINUX_DOCTOR_USER_UNITS = "/tmp/units-here";
    const paths = unitPaths();
    assert.equal(paths.dir, "/tmp/units-here");
    assert.equal(paths.service, "/tmp/units-here/linux-doctor.service");
    assert.equal(paths.timer, "/tmp/units-here/linux-doctor.timer");
  } finally {
    if (prev === undefined) delete process.env.LINUX_DOCTOR_USER_UNITS;
    else process.env.LINUX_DOCTOR_USER_UNITS = prev;
  }
});

test("installTimer: without systemd it fails honestly, writes nothing", () => {
  const dir = fakeHome();
  try {
    const prev = process.env.LINUX_DOCTOR_USER_UNITS;
    process.env.LINUX_DOCTOR_USER_UNITS = dir;
    try {
      const res = installTimer({ exists: () => false });
      assert.equal(res.ok, false);
      assert.match(res.error, /systemd is not running/);
      assert.equal(existsSync(join(dir, "linux-doctor.service")), false);
    } finally {
      if (prev === undefined) delete process.env.LINUX_DOCTOR_USER_UNITS;
      else process.env.LINUX_DOCTOR_USER_UNITS = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installTimer: writes both units, daemon-reloads, enables the timer", () => {
  const home = fakeHome();
  const shim = fakeSystemctl(fakeHome());
  try {
    const prev = process.env.LINUX_DOCTOR_USER_UNITS;
    process.env.LINUX_DOCTOR_USER_UNITS = join(home, ".config", "systemd", "user");
    try {
      const res = installTimer({ systemctl: shim.bin, exists: (p) => p === "/run/systemd/system" || existsSync(p) });
      assert.equal(res.ok, true);
      const service = readFileSync(res.paths.service, "utf8");
      assert.match(service, /^ExecStart=".*" ".*" --notify$/m, "ExecStart resolves node + bin with --notify");
      const timer = readFileSync(res.paths.timer, "utf8");
      assert.match(timer, /^Persistent=true$/m);
      assert.deepEqual(shim.calls(), [
        "--user daemon-reload",
        "--user enable --now linux-doctor.timer",
      ]);
      assert.match(res.message, /--uninstall-timer/);
    } finally {
      if (prev === undefined) delete process.env.LINUX_DOCTOR_USER_UNITS;
      else process.env.LINUX_DOCTOR_USER_UNITS = prev;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test("uninstallTimer: disables, removes units, survives a second run", () => {
  const home = fakeHome();
  const shim = fakeSystemctl(fakeHome());
  try {
    const prev = process.env.LINUX_DOCTOR_USER_UNITS;
    process.env.LINUX_DOCTOR_USER_UNITS = join(home, ".config", "systemd", "user");
    try {
      const first = installTimer({ systemctl: shim.bin, exists: (p) => p === "/run/systemd/system" || existsSync(p) });
      assert.equal(first.ok, true);
      // A failing disable (timer already off elsewhere) must not break removal.
      rmSync(shim.log, { force: true });
      const res = uninstallTimer({ systemctl: shim.bin, exists: (p) => p === "/run/systemd/system" || existsSync(p) });
      assert.equal(res.ok, true);
      assert.match(res.message, /removed and disabled/);
      assert.equal(existsSync(first.paths.service), false);
      assert.equal(existsSync(first.paths.timer), false);
      assert.ok(shim.calls().some((c) => c.includes("disable --now linux-doctor.timer")));
      assert.ok(shim.calls().some((c) => c.includes("daemon-reload")));
      // Idempotent: on a real box the second disable fails (no unit) — with a
      // failing systemctl and no files left, nothing is reported as removed.
      const failBin = join(shim.bin, "..", "systemctl-fail");
      writeFileSync(failBin, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const again = uninstallTimer({ systemctl: failBin, exists: () => false });
      assert.equal(again.ok, true);
      assert.match(again.message, /nothing to remove|No user timer/i);
    } finally {
      if (prev === undefined) delete process.env.LINUX_DOCTOR_USER_UNITS;
      else process.env.LINUX_DOCTOR_USER_UNITS = prev;
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test("timerStatus: no unit files reads as not installed, never throws", () => {
  const prev = process.env.LINUX_DOCTOR_USER_UNITS;
  process.env.LINUX_DOCTOR_USER_UNITS = join(tmpdir(), "ld-units-absent-" + Date.now());
  try {
    const st = timerStatus({ exists: () => false, exec: () => { throw new Error("nope"); } });
    assert.deepEqual(st, { installed: false, enabled: false, active: false, systemd: false });
  } finally {
    if (prev === undefined) delete process.env.LINUX_DOCTOR_USER_UNITS;
    else process.env.LINUX_DOCTOR_USER_UNITS = prev;
  }
});

test("timerStatus: installed + enabled + active timer", () => {
  const dir = fakeHome();
  const prev = process.env.LINUX_DOCTOR_USER_UNITS;
  process.env.LINUX_DOCTOR_USER_UNITS = dir;
  try {
    writeFileSync(join(dir, "linux-doctor.service"), "x");
    writeFileSync(join(dir, "linux-doctor.timer"), "x");
    const exists = (p) => p === "/run/systemd/system" || existsSync(p);
    const exec = (cmd, args) => (args.includes("is-enabled") ? "enabled\n" : "active\n");
    assert.deepEqual(timerStatus({ exists, exec }), { installed: true, enabled: true, active: true, systemd: true });
  } finally {
    if (prev === undefined) delete process.env.LINUX_DOCTOR_USER_UNITS;
    else process.env.LINUX_DOCTOR_USER_UNITS = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timerStatus: installed but failing systemctl reads as inactive, never throws", () => {
  const dir = fakeHome();
  const prev = process.env.LINUX_DOCTOR_USER_UNITS;
  process.env.LINUX_DOCTOR_USER_UNITS = dir;
  try {
    writeFileSync(join(dir, "linux-doctor.service"), "x");
    writeFileSync(join(dir, "linux-doctor.timer"), "x");
    const exists = (p) => p === "/run/systemd/system" || existsSync(p);
    const st = timerStatus({ exists, exec: () => { throw new Error("systemctl failed"); } });
    assert.deepEqual(st, { installed: true, enabled: false, active: false, systemd: true });
  } finally {
    if (prev === undefined) delete process.env.LINUX_DOCTOR_USER_UNITS;
    else process.env.LINUX_DOCTOR_USER_UNITS = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timerStatus: unit files without systemd read as installed but inert", () => {
  const dir = fakeHome();
  const prev = process.env.LINUX_DOCTOR_USER_UNITS;
  process.env.LINUX_DOCTOR_USER_UNITS = dir;
  try {
    writeFileSync(join(dir, "linux-doctor.service"), "x");
    writeFileSync(join(dir, "linux-doctor.timer"), "x");
    let called = false;
    const st = timerStatus({ exists: (p) => p !== "/run/systemd/system" && existsSync(p), exec: () => { called = true; return ""; } });
    assert.equal(st.installed, true);
    assert.equal(st.systemd, false);
    assert.equal(st.enabled, false);
    assert.equal(st.active, false);
    assert.equal(called, false, "no systemctl probe without systemd");
  } finally {
    if (prev === undefined) delete process.env.LINUX_DOCTOR_USER_UNITS;
    else process.env.LINUX_DOCTOR_USER_UNITS = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The CLI's exit codes are a public contract (docs/compatibility.md): 0 = nothing
 * serious, 1 = high/medium findings, 2 = errors. The timer's ExecStart carries
 * --notify, so a run that FINDS something exits 1 — which systemd reads as a
 * failed unit. A watchdog that reported a real problem did its job; without
 * this, the unit sits in "failed" whenever the machine has any finding at all.
 */
test("renderService: exit 1 (findings) counts as success, not failure", () => {
  const unit = renderService({ node: "/usr/bin/node", bin: "/opt/doctor.js" });
  assert.match(
    unit,
    /SuccessExitStatus=1/,
    "--notify exits 1 when it has something to report; systemd must not call that a failure"
  );
  assert.match(unit, /Type=oneshot/);
});
