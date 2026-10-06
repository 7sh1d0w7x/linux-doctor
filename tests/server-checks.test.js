// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { raid } from "../src/checks/raid.js";
import { containers } from "../src/checks/containers.js";
import { services } from "../src/checks/services.js";
import { detectDistro } from "../src/distro.js";
import { loadThresholds } from "../src/thresholds.js";

/** Minimal ctx stub: maps command string → stdout, like tests/checks.test.js. */
function stubCtx(map, osRelease = { id: "fedora", id_like: "fedora" }) {
  return {
    osRelease,
    dist: detectDistro(osRelease),
    thresholds: loadThresholds({}),
    run: async (cmd) => {
      const entry = map[cmd] ?? map[cmd.replaceAll("'", "")];
      if (entry === undefined) return { ok: false, code: 1, stdout: "", stderr: "" };
      return { ok: true, code: 0, stdout: entry, stderr: "" };
    },
  };
}

// ---------------------------------------------------------------- raid ----------------------------------------------------------------

test("raid: a degraded mdadm array is high severity", async () => {
  const ctx = stubCtx({
    "cat /proc/mdstat 2>/dev/null":
      "Personalities : [raid1]\nmd0 : active raid1 sda1[0] sdb1[1]\n      1048576 blocks super 1.2 [2/1] [U_]\n",
    "command -v zpool 2>/dev/null": "",
  });
  const findings = await raid.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "high");
  assert.equal(findings[0].code, "raid/degraded");
  assert.match(findings[0].title, /degraded/);
});

test("raid: a degraded ZFS pool is high severity", async () => {
  const ctx = stubCtx({
    "cat /proc/mdstat 2>/dev/null": "",
    "command -v zpool 2>/dev/null": "/usr/sbin/zpool\n",
    "zpool list -H -o name 2>/dev/null": "tank\n",
    "zpool status tank 2>/dev/null": "  pool: tank\n  state: DEGRADED\n",
  });
  const findings = await raid.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "high");
  assert.equal(findings[0].code, "raid/degraded");
  assert.match(findings[0].evidence, /zpool:tank/);
});

// Regression: only the word "degraded" was recognised, so a pool that is
// FAULTED, UNAVAIL, REMOVED, OFFLINE or SUSPENDED fell through to
// "RAID arrays are healthy" — the worst thing this check can say.
for (const state of ["FAULTED", "UNAVAIL", "REMOVED", "SUSPENDED"]) {
  test(`raid: a ZFS pool in ${state} state is high, not healthy`, async () => {
    const ctx = stubCtx({
      "cat /proc/mdstat 2>/dev/null": "",
      "command -v zpool 2>/dev/null": "/usr/sbin/zpool\n",
      "zpool list -H -o name 2>/dev/null": "tank\n",
      "zpool status tank 2>/dev/null": `  pool: tank\n  state: ${state}\n`,
    });
    const findings = await raid.run(ctx);
    assert.equal(findings[0].code, "raid/degraded");
    assert.equal(findings[0].severity, "high");
    assert.match(findings[0].evidence, new RegExp(state));
  });
}

// A plain scrub is routine maintenance with redundancy intact; only a resilver
// or recovery is the case where the array has no redundancy while it runs.
test("raid: a running scrub is not reported as rebuilding", async () => {
  const ctx = stubCtx({
    "cat /proc/mdstat 2>/dev/null": "",
    "command -v zpool 2>/dev/null": "/usr/sbin/zpool\n",
    "zpool list -H -o name 2>/dev/null": "tank\n",
    "zpool status tank 2>/dev/null": "  pool: tank\n  state: ONLINE\n  scan: scrub in progress since Sun\n",
  });
  const findings = await raid.run(ctx);
  assert.ok(!findings.some((f) => f.code === "raid/rebuilding"), "a scrub must not be a rebuild");
});

test("raid: a healthy array reports ok (info)", async () => {
  const ctx = stubCtx({
    "cat /proc/mdstat 2>/dev/null":
      "md0 : active raid1 sda1[0] sdb1[1]\n      1048576 blocks super 1.2 [2/2] [UU]\n",
    "command -v zpool 2>/dev/null": "",
  });
  const findings = await raid.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.equal(findings[0].code, "raid/ok");
});

test("raid: rebuilding (resync) array is medium", async () => {
  const ctx = stubCtx({
    "cat /proc/mdstat 2>/dev/null":
      "md0 : active raid1 sda1[0] sdb1[1]\n      1048576 blocks super 1.2 [2/2] [UU]\n      [>....]  recovery = 12.3% (12345/1048576) finish=10.0min\n",
    "command -v zpool 2>/dev/null": "",
  });
  const findings = await raid.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.equal(findings[0].code, "raid/rebuilding");
});

test("raid: no arrays and no zpool stays silent", async () => {
  const ctx = stubCtx({
    "cat /proc/mdstat 2>/dev/null": "Personalities : [linear] [raid0]\nunused devices: <none>\n",
    "command -v zpool 2>/dev/null": "",
  });
  const findings = await raid.run(ctx);
  assert.equal(findings.length, 0);
});

// ------------------------------------------------------------ containers ------------------------------------------------------------

test("containers: a podman container killed by OOM (exit 137) is high", async () => {
  const ctx = stubCtx({
    "command -v podman 2>/dev/null": "/usr/bin/podman\n",
    "systemctl is-active docker 2>/dev/null": "inactive\n",
    "podman info >/dev/null 2>&1 && echo ok || echo fail": "ok\n",
    "podman ps -a --format '{{.Names}} {{.Status}}' 2>/dev/null": "web1 Exited (137) 2 hours ago\n",
  });
  const findings = await containers.run(ctx);
  const oom = findings.find((f) => f.code === "containers/oom");
  assert.ok(oom, "expected a containers/oom finding");
  assert.equal(oom.severity, "high");
});

test("containers: a podman container that exited non-zero is medium", async () => {
  const ctx = stubCtx({
    "command -v podman 2>/dev/null": "/usr/bin/podman\n",
    "systemctl is-active docker 2>/dev/null": "inactive\n",
    "podman info >/dev/null 2>&1 && echo ok || echo fail": "ok\n",
    "podman ps -a --format '{{.Names}} {{.Status}}' 2>/dev/null": "api Exited (1) 5 minutes ago\n",
  });
  const findings = await containers.run(ctx);
  const dead = findings.find((f) => f.code === "containers/dead");
  assert.ok(dead, "expected a containers/dead finding");
  assert.equal(dead.severity, "medium");
});

test("containers: a docker container stuck restarting is medium", async () => {
  const ctx = stubCtx({
    "command -v podman 2>/dev/null": "",
    "command -v docker 2>/dev/null": "/usr/bin/docker\n",
    "systemctl is-active docker 2>/dev/null": "active\n",
    "docker ps -a --format '{{.Names}} {{.Status}}' 2>/dev/null": "db Restarting (1) 5 seconds ago\n",
  });
  const findings = await containers.run(ctx);
  const restarting = findings.find((f) => f.code === "containers/restarting");
  assert.ok(restarting, "expected a containers/restarting finding");
  assert.equal(restarting.severity, "medium");
});

test("containers: healthy running containers report ok", async () => {
  const ctx = stubCtx({
    "command -v podman 2>/dev/null": "/usr/bin/podman\n",
    "systemctl is-active docker 2>/dev/null": "inactive\n",
    "podman info >/dev/null 2>&1 && echo ok || echo fail": "ok\n",
    "podman ps -a --format '{{.Names}} {{.Status}}' 2>/dev/null": "web1 Up 3 hours\n",
  });
  const findings = await containers.run(ctx);
  const ok = findings.find((f) => f.code === "containers/ok");
  assert.ok(ok, "expected a containers/ok finding when all containers are healthy");
  assert.ok(!findings.some((f) => f.code === "containers/dead"), "a clean exit must not be flagged dead");
});

// ------------------------------------------------------------- services -------------------------------------------------------------

test("services: a unit in auto-restart loop is high severity", async () => {
  const ctx = stubCtx({
    "systemctl --failed --no-legend --plain": "",
    "systemctl --user --failed --no-legend --plain": "",
    "systemctl list-units --type=service --no-legend --plain 2>/dev/null | grep -i 'auto-restart'":
      "myapp.service loaded active auto-restart  myapp.service\n",
    "systemctl show myapp.service -p NRestarts --value 2>/dev/null": "5\n",
  });
  const findings = await services.run(ctx);
  const loop = findings.find((f) => f.code === "services/restart-loop");
  assert.ok(loop, "expected a services/restart-loop finding");
  assert.equal(loop.severity, "high");
  assert.match(loop.evidence, /myapp.service/);
});

test("services: no failed and no looping units produces no finding", async () => {
  const ctx = stubCtx({
    "systemctl --failed --no-legend --plain": "",
    "systemctl --user --failed --no-legend --plain": "",
    "systemctl list-units --type=service --no-legend --plain 2>/dev/null | grep -i 'auto-restart'": "",
  });
  const findings = await services.run(ctx);
  assert.equal(findings.length, 0);
});

/**
 * 143 is 128 + 15: the SIGTERM a plain `podman stop`, a `systemctl stop` or an
 * orderly shutdown sends. A container that stopped when it was told to stopped
 * cleanly, and this check is not a monitor — calling that "did not exit cleanly"
 * put a medium finding (8 points) on every machine with a deliberately stopped
 * container.
 */
test("containers: exit 143 is a plain stop, not a failure", async () => {
  const ctx = stubCtx({
    "command -v podman 2>/dev/null": "/usr/bin/podman\n",
    "systemctl is-active docker 2>/dev/null": "inactive\n",
    "podman info >/dev/null 2>&1 && echo ok || echo fail": "ok\n",
    "podman ps -a --format '{{.Names}} {{.Status}}' 2>/dev/null": "n8n Exited (143) 44 hours ago\n",
  });
  const findings = await containers.run(ctx);
  assert.ok(
    !findings.some((f) => f.code === "containers/dead"),
    "143 is SIGTERM — the signal `podman stop` sends"
  );
});

test("containers: exit 130 (Ctrl-C / SIGINT) is also a plain stop", async () => {
  const ctx = stubCtx({
    "command -v podman 2>/dev/null": "/usr/bin/podman\n",
    "systemctl is-active docker 2>/dev/null": "inactive\n",
    "podman info >/dev/null 2>&1 && echo ok || echo fail": "ok\n",
    "podman ps -a --format '{{.Names}} {{.Status}}' 2>/dev/null": "tmp Exited (130) 2 hours ago\n",
  });
  const findings = await containers.run(ctx);
  assert.ok(!findings.some((f) => f.code === "containers/dead"), "130 is SIGINT");
});
