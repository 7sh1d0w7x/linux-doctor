// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checks } from "../src/checks/index.js";
import { memory } from "../src/checks/memory.js";
import { zram } from "../src/checks/zram.js";
import { fstrim } from "../src/checks/fstrim.js";
import { load } from "../src/checks/load.js";
import { disk } from "../src/checks/disk.js";
import { inodes } from "../src/checks/inodes.js";
import { services } from "../src/checks/services.js";
import { timers } from "../src/checks/timers.js";
import { ntp } from "../src/checks/ntp.js";
import { journal } from "../src/checks/journal.js";
import { gpu } from "../src/checks/gpu.js";
import { updates } from "../src/checks/updates.js";
import { security } from "../src/checks/security.js";
import { secureboot } from "../src/checks/secureboot.js";
import { firmware } from "../src/checks/firmware.js";
import { flatpak } from "../src/checks/flatpak.js";
import { boot } from "../src/checks/boot.js";
import { thermal } from "../src/checks/thermal.js";
import { processes } from "../src/checks/processes.js";
import { certs } from "../src/checks/certs.js";
import { ports } from "../src/checks/ports.js";
import { suspend } from "../src/checks/suspend.js";
import { battery } from "../src/checks/battery.js";
import { bluetooth } from "../src/checks/bluetooth.js";
import { bringup } from "../src/checks/bringup.js";
import { wayland } from "../src/checks/wayland.js";
import { backup } from "../src/checks/backup.js";
import { hardware } from "../src/checks/hardware.js";
import { packages } from "../src/checks/packages.js";
import { smart } from "../src/checks/smart.js";
import { luks } from "../src/checks/luks.js";
import { audio } from "../src/checks/audio.js";
import { containers } from "../src/checks/containers.js";
import { containerdisk } from "../src/checks/containerdisk.js";
import { crash } from "../src/checks/crash.js";
import { network } from "../src/checks/network.js";
import { reboot, versionGt } from "../src/checks/reboot.js";
import { journald } from "../src/checks/journald.js";
import { parseSize } from "../src/utils.js";
import { countBySeverity } from "../src/report.js";
import { detectDistro } from "../src/distro.js";
import { loadThresholds } from "../src/thresholds.js";

// The updates check caches its result; the existing tests exercise the
// command parsing, so disable the cache for this file's default env. The
// cache behavior itself is tested below with a dedicated temp directory.
const prevUpdatesTtl = process.env.LINUX_DOCTOR_UPDATES_TTL_MS;
process.env.LINUX_DOCTOR_UPDATES_TTL_MS = "0";
test.after(() => {
  if (prevUpdatesTtl === undefined) delete process.env.LINUX_DOCTOR_UPDATES_TTL_MS;
  else process.env.LINUX_DOCTOR_UPDATES_TTL_MS = prevUpdatesTtl;
});

/**
 * Build a stub ctx.run from a map of command → stdout string. The distro
 * profile comes from the given os-release (default: Bazzite, image-based)
 * and thresholds default to the shipped values.
 */
function stubCtx(map, osRelease = { id: "bazzite", id_like: "fedora" }) {
  return {
    osRelease,
    dist: detectDistro(osRelease),
    thresholds: loadThresholds({}),
    run: async (cmd) => {
      // Fixture keys are written unquoted; the checks quote interpolated
      // values (shq), so strip quotes before lookup.
      const entry = map[cmd] ?? map[cmd.replaceAll("'", "")];
      if (entry === undefined) return { ok: false, code: 1, stdout: "", stderr: "" };
      return { ok: true, code: 0, stdout: entry, stderr: "" };
    },
  };
}

test("memory: flags low available memory as high severity", async () => {
  const ctx = stubCtx({
    "free -b": `              total        used        free      shared  buff/cache   available\nMem:    16106127360 12884901888   500000000    500000000  4718592000   1500000000\nSwap:   8267812045 2362232012 5905580033`,
    "swapon --show --bytes": `NAME      TYPE      SIZE      USED      PRIO\n/dev/zram0 partition 8267812045 2362232012  100`,
  });
  const findings = await memory.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "high");
  assert.match(findings[0].title, /low on usable memory/i);
  assert.ok(findings[0].fix, "high-severity findings should include a fix");
});

test("memory: healthy system produces no finding", async () => {
  const ctx = stubCtx({
    "free -b": `              total        used        free      shared  buff/cache   available\nMem:    16106127360  4000000000 1000000000  300000000  7000000000  11000000000\nSwap:   8267812045         0 8267812045`,
    "swapon --show --bytes": "",
  });
  const findings = await memory.run(ctx);
  assert.equal(findings.length, 0);
});

test("memory: configurable thresholds are honored", async () => {
  const ctx = stubCtx({
    "free -b": `              total        used        free      shared  buff/cache   available\nMem:    16106127360  4000000000 1000000000  300000000  7000000000  11000000000\nSwap:   8267812045         0 8267812045`,
    "swapon --show --bytes": "",
  });
  // 11/16 GB available ≈ 0.68 — normally fine; a raised warn ratio flags it.
  ctx.thresholds = { ...ctx.thresholds, memWarnRatio: 0.7 };
  const findings = await memory.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
});

test("load: overloaded CPU is flagged", async () => {
  const ctx = stubCtx({
    "cat /proc/loadavg": "8.50 6.00 4.00 2/300 1234",
    nproc: "4",
  });
  const findings = await load.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "high");
  assert.match(findings[0].title, /overloaded/i);
});

test("disk: composefs (immutable) root is NOT reported as full", async () => {
  const ctx = stubCtx({
    "df -P -B1 --exclude-type=tmpfs --exclude-type=devtmpfs --exclude-type=squashfs --exclude-type=overlay --exclude-type=proc --exclude-type=sysfs --exclude-type=cgroup2": `Filesystem     1024-blocks        Used   Available Capacity Mounted on\ncomposefs      60000000    60000000          0    100% /\n/dev/sda3     957000000000 350000000000 600000000000   37% /var/home`,
  });
  const findings = await disk.run(ctx);
  assert.equal(findings.length, 0, "a full composefs root must be ignored");
});

test("disk: AppImage runtime mounts (always 100% by design) are NOT reported as full", async () => {
  const ctx = stubCtx({
    "df -P -B1 --exclude-type=tmpfs --exclude-type=devtmpfs --exclude-type=squashfs --exclude-type=overlay --exclude-type=proc --exclude-type=sysfs --exclude-type=cgroup2": `Filesystem     1024-blocks        Used   Available Capacity Mounted on\nLinux.Doctor_0.3.5_amd64.AppImage     79822848     79822848            0    100% /tmp/.mount_Linux.icbcpE\n/dev/sda3     957000000000 350000000000 600000000000   37% /var/home`,
  });
  const findings = await disk.run(ctx);
  assert.equal(findings.length, 0, "a 100% AppImage FUSE mount is a fixed-size image, not a filling disk");
});

test("inodes: AppImage runtime mounts are NOT reported as inode-exhausted", async () => {
  const ctx = stubCtx({
    "df -iP --exclude-type=tmpfs --exclude-type=devtmpfs --exclude-type=squashfs --exclude-type=overlay --exclude-type=proc --exclude-type=sysfs --exclude-type=cgroup2": `Filesystem     Inodes IUsed IFree IUse% Mounted on\nLinux.Doctor_0.3.5_amd64.AppImage     100 100 0 100% /tmp/.mount_Linux.icbcpE\n/dev/sda3     1000000 100000 900000   10% /var/home`,
  });
  const findings = await inodes.run(ctx);
  assert.equal(findings.length, 0, "same AppImage exemption as the disk check");
});

test("disk: configurable thresholds are honored", async () => {
  const ctx = stubCtx({
    "df -P -B1 --exclude-type=tmpfs --exclude-type=devtmpfs --exclude-type=squashfs --exclude-type=overlay --exclude-type=proc --exclude-type=sysfs --exclude-type=cgroup2": `Filesystem     1024-blocks        Used   Available Capacity Mounted on\n/dev/sda1     100000000000  85000000000  15000000000    85% /data\n`,
  });
  ctx.thresholds = { ...ctx.thresholds, diskFullPct: 80 };
  const findings = await disk.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "high");
  assert.match(findings[0].title, /nearly full/);
});

test("disk: a real partition at 95% is reported as high", async () => {
  const ctx = stubCtx({
    "df -P -B1 --exclude-type=tmpfs --exclude-type=devtmpfs --exclude-type=squashfs --exclude-type=overlay --exclude-type=proc --exclude-type=sysfs --exclude-type=cgroup2": `Filesystem     1024-blocks        Used   Available Capacity Mounted on\n/dev/sda1     100000000000  95000000000   5000000000    95% /data`,
  });
  const findings = await disk.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "high");
  assert.match(findings[0].title, /nearly full/i);
});

test("disk: two mounts on the same device (btrfs subvolumes) share one dedupeKey", async () => {
  const ctx = stubCtx({
    "df -P -B1 --exclude-type=tmpfs --exclude-type=devtmpfs --exclude-type=squashfs --exclude-type=overlay --exclude-type=proc --exclude-type=sysfs --exclude-type=cgroup2": `Filesystem     1024-blocks        Used   Available Capacity Mounted on\n/dev/sda2     100000000000  95000000000   5000000000    95% /\n/dev/sda2     100000000000  95000000000   5000000000    95% /home`,
  });
  const findings = await disk.run(ctx);
  assert.equal(findings.length, 2, "both mounts are reported...");
  assert.ok(findings.every((f) => f.dedupeKey === "disk:/dev/sda2"), "same device → same dedupeKey, so dedupe collapses them into one");
});

test("services: system-scope failures are high severity", async () => {
  const ctx = stubCtx({
    "systemctl --failed --no-legend --plain": `NetworkManager.service loaded failed failed`,
    "systemctl --user --failed --no-legend --plain": "",
  });
  const findings = await services.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "high");
  assert.equal(findings[0].code, "services/failed");
  assert.match(findings[0].detail, /NetworkManager/i);
  assert.match(findings[0].fix, /systemctl status NetworkManager/i);
});

test("services: only user-scope failures are medium, not high", async () => {
  const ctx = stubCtx({
    "systemctl --failed --no-legend --plain": "",
    "systemctl --user --failed --no-legend --plain": `bitwarden.service loaded failed failed\npicom.service loaded failed failed\nclamav.service loaded failed failed\ncustom-thing.service loaded failed failed\napp.service loaded failed failed`,
  });
  const findings = await services.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].title, /5 services failed to start/);
});

test("timers: a timer whose start condition is unmet is not a broken schedule", async () => {
  // Bazzite (immutable): dnf-makecache.timer is enabled, has never run and is
  // not scheduled, because its start condition is unmet by design on an atomic
  // system (systemctl status says "Condition: start condition unmet"). Calling
  // that a broken schedule blames the user for a timer that cannot run at all.
  const cols = (vals) => vals.map((v) => String(v).padEnd(20)).join("");
  const ctx = stubCtx({
    "systemctl list-timers --all --no-pager --plain 2>/dev/null": [
      cols(["NEXT", "LEFT", "LAST", "PASSED", "UNIT", "ACTIVATES"]),
      cols(["-", "-", "-", "-", "dnf-makecache.timer", "dnf-makecache.service"]),
      "",
    ].join("\n"),
    "systemctl is-enabled dnf-makecache.timer 2>/dev/null": "enabled\n",
    "systemctl show dnf-makecache.timer -p ConditionResult --value 2>/dev/null": "no\n",
  });
  const findings = await timers.run(ctx);
  assert.ok(
    !findings.some((f) => f.code === "timers/broken"),
    `a timer that cannot run is not broken: ${JSON.stringify(findings.map((f) => f.code))}`
  );
});

test("timers: an enabled timer with no condition problem is still broken", async () => {
  const cols = (vals) => vals.map((v) => String(v).padEnd(20)).join("");
  const ctx = stubCtx({
    "systemctl list-timers --all --no-pager --plain 2>/dev/null": [
      cols(["NEXT", "LEFT", "LAST", "PASSED", "UNIT", "ACTIVATES"]),
      cols(["-", "-", "-", "-", "backup.timer", "backup.service"]),
      "",
    ].join("\n"),
    "systemctl is-enabled backup.timer 2>/dev/null": "enabled\n",
    "systemctl show backup.timer -p ConditionResult --value 2>/dev/null": "yes\n",
  });
  const findings = await timers.run(ctx);
  assert.ok(findings.some((f) => f.code === "timers/broken"), "keep the real signal");
});

test("network: no iproute2 is a skip, not 'no default route'", async () => {
  // Debian, Fedora and Ubuntu minimal images do not ship `ip`. run() only sets
  // `missing` when the spawn itself fails, and these commands go through a
  // shell, so a missing `ip` looked like an empty route table: the check
  // reported a medium "No default network route" on a machine with a perfectly
  // good route.
  const ctx = stubCtx({}); // nothing stubbed: `command -v ip` finds nothing
  const findings = await network.run(ctx);
  assert.equal(findings.length, 1, `expected one skip finding: ${JSON.stringify(findings.map((f) => f.code))}`);
  assert.equal(findings[0].code, "network/skipped");
  assert.ok(!findings.some((f) => f.code === "network/no-route"), "a missing tool is not a missing route");
});

test("load: inside a container the check is skipped, not called overloaded", async () => {
  // /proc/loadavg is not namespaced: in a container it is the HOST's load
  // average while nproc reports the container's CPUs, so the ratio invents an
  // overloaded system out of an idle container (all five test images did it).
  const ctx = stubCtx({
    "test -f /.dockerenv -o -f /run/.containerenv && echo container 2>/dev/null": "container\n",
    "cat /proc/loadavg": "6.00 5.50 5.00 1/200 4242\n",
    "nproc": "2\n",
  });
  const findings = await load.run(ctx);
  assert.ok(findings.some((f) => f.code === "load/skipped"), `expected a skip: ${JSON.stringify(findings.map((f) => f.code))}`);
  assert.ok(!findings.some((f) => f.code === "load/overloaded"), "the host's load is not this container's");
});

test("load: a real host with a high load is still reported", async () => {
  const ctx = stubCtx({
    "cat /proc/loadavg": "6.00 5.50 5.00 1/200 4242\n",
    "nproc": "2\n",
  });
  const findings = await load.run(ctx);
  assert.ok(findings.some((f) => f.code === "load/overloaded"), "keep the real signal");
});

test("processes: a missing ps is an explicit skip, not 'no consumers'", async () => {
  // `ps ... | head` exits 0 through head even when ps is absent, so the empty
  // result looked like a healthy machine. procps is not installed on minimal
  // Debian and Fedora images.
  const ctx = {
    osRelease: { id: "debian", id_like: "" },
    dist: detectDistro({ id: "debian", id_like: "" }),
    thresholds: {},
    run: async (cmd) => (cmd.startsWith("ps ") ? { ok: false, code: 127, stdout: "", stderr: "", missing: true } : { ok: false, code: 1, stdout: "", stderr: "" }),
  };
  const findings = await processes.run(ctx);
  assert.equal(findings.length, 1, `expected one skip: ${JSON.stringify(findings.map((f) => f.code))}`);
  assert.equal(findings[0].code, "processes/skipped");
  assert.match(findings[0].fix, /procps/);
});

test("certs: a missing openssl is an explicit skip", async () => {
  const ctx = stubCtx({});
  const findings = await certs.run(ctx);
  assert.equal(findings.length, 1, `expected one skip: ${JSON.stringify(findings.map((f) => f.code))}`);
  assert.equal(findings[0].code, "certs/skipped");
  assert.match(findings[0].fix, /openssl/);
});

test("ports: a missing ss is an explicit skip", async () => {
  // ss is iproute2, which minimal Debian and Fedora images do not ship. The
  // check used to return silently, so a machine exposing a database on 0.0.0.0
  // got no signal that the check had not run.
  const ctx = {
    osRelease: { id: "debian", id_like: "" },
    dist: detectDistro({ id: "debian", id_like: "" }),
    thresholds: {},
    run: async (cmd) => (cmd.startsWith("ss ") ? { ok: false, code: 127, stdout: "", stderr: "", missing: true } : { ok: false, code: 1, stdout: "", stderr: "" }),
  };
  const findings = await ports.run(ctx);
  assert.equal(findings.length, 1, `expected one skip: ${JSON.stringify(findings.map((f) => f.code))}`);
  assert.equal(findings[0].code, "ports/skipped");
  assert.match(findings[0].fix, /iproute2/);
});

test("memory: a missing free is an explicit skip (the .missing flag now fires)", async () => {
  const ctx = {
    osRelease: { id: "debian", id_like: "" },
    dist: detectDistro({ id: "debian", id_like: "" }),
    thresholds: {},
    run: async (cmd) => (cmd.startsWith("free ") ? { ok: false, code: 127, stdout: "", stderr: "", missing: true } : { ok: false, code: 1, stdout: "", stderr: "" }),
  };
  const findings = await memory.run(ctx);
  assert.equal(findings.length, 1, `expected one skip: ${JSON.stringify(findings.map((f) => f.code))}`);
  assert.equal(findings[0].code, "memory/skipped");
});


test("memory: a container is an explicit skip, not the host's RAM", async () => {
  // /proc/meminfo is not namespaced: a 256MB-limited container's `free -b`
  // reports the host's 15GB. That is the same lie `load` used to tell.
  const ctx = stubCtx({
    "test -f /.dockerenv -o -f /run/.containerenv && echo container 2>/dev/null": "container\n",
    "free -b": "Mem: 16106127360 1000 2000 0 3000 14000000000\n",
  });
  const findings = await memory.run(ctx);
  assert.equal(findings[0].code, "memory/skipped", `expected a container skip: ${JSON.stringify(findings.map((f) => f.code))}`);
  assert.match(findings[0].title, /container/i);
});

test("zram: a container is an explicit skip, not the host's swap", async () => {
  const ctx = stubCtx({ "test -f /.dockerenv -o -f /run/.containerenv && echo container 2>/dev/null": "container\n" });
  const findings = await zram.run(ctx);
  assert.equal(findings[0].code, "zram/skipped", `expected a container skip: ${JSON.stringify(findings.map((f) => f.code))}`);
});

test("fstrim: a container is an explicit skip, not the host's disks", async () => {
  const ctx = stubCtx({ "test -f /.dockerenv -o -f /run/.containerenv && echo container 2>/dev/null": "container\n" });
  const findings = await fstrim.run(ctx);
  assert.equal(findings[0].code, "fstrim/skipped", `expected a container skip: ${JSON.stringify(findings.map((f) => f.code))}`);
});


test("reboot: a container is an explicit skip, not 'no reboot needed'", async () => {
  // A container has no kernels of its own; the old check read an empty /boot
  // list and concluded "No reboot needed".
  const ctx = stubCtx({
    "test -f /.dockerenv -o -f /run/.containerenv && echo container 2>/dev/null": "container\n",
    "uname -r 2>/dev/null": "6.12.0\n",
  }, { id: "alpine", id_like: "" });
  const findings = await reboot.run(ctx);
  assert.equal(findings[0].code, "reboot/skipped", `expected a container skip: ${JSON.stringify(findings.map((f) => f.code))}`);
});

test("reboot: no readable kernel list is silence, not 'no reboot needed'", async () => {
  const ctx = stubCtx({ "uname -r 2>/dev/null": "6.12.0\n" }, { id: "debian", id_like: "" });
  assert.deepEqual(await reboot.run(ctx), [], "cannot compare kernels → say nothing");
});
test("journal: known noise is filtered into an informational finding", async () => {
  const ctx = stubCtx({
    "journalctl -p err --since \"-24 hours\" --no-pager -o short 2>/dev/null": `Aug 15 14:32:47 bazzite systemd-udevd[465]: /usr/lib/udev/rules.d/50-udev-default.rules:105 Failed to resolve group 'disk', ignoring: Unknown group\nAug 15 14:33:01 bazzite setroubleshoot[1807]: SELinux is preventing bootupctl from read access on the directory /proc.\nAug 15 14:36:58 bazzite cupsd[1512]: Returning IPP client-error-bad-request for Create-Printer-Subscriptions (ipp://localhost/) from localhost.`,
  });
  const findings = await journal.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /routine noise/i);
});

test("journal: the KDE screen locker's retry message is noise, not a fault", async () => {
  // kscreenlocker_greet logs "[PAM worker kde] Authentication attempt too soon"
  // when you retype a wrong password quickly, and repeats it a few times. Our
  // /Authentication attempt too soon/ pattern read that as a recognized error,
  // so a normal desktop got a medium "6 recognized errors" worth 8 points on
  // the health score. Seen on the maintainer's own Bazzite box.
  const ctx = stubCtx({
    "journalctl -p err --since \"-24 hours\" --no-pager -o short 2>/dev/null": [
      "Sep 22 16:41:02 bazzite kscreenlocker_greet[12697]: [PAM worker kde] Authentication attempt too soon.",
      "Sep 22 16:41:05 bazzite kscreenlocker_greet[12697]: [PAM worker kde] Authentication attempt too soon.",
      "Sep 22 16:41:09 bazzite kscreenlocker_greet[12697]: [PAM worker kde] Authentication attempt too soon.",
    ].join("\n") + "\n",
  });
  const findings = await journal.run(ctx);
  assert.ok(
    !findings.some((f) => f.code === "journal/errors"),
    `a screen-locker retry is not a system error: ${JSON.stringify(findings.map((f) => f.code))}`
  );
});

test("journal: 'Authentication attempt too soon' outside the screen locker is still an error", async () => {
  // The signal the pattern exists for: something hammering authentication.
  const ctx = stubCtx({
    "journalctl -p err --since \"-24 hours\" --no-pager -o short 2>/dev/null": "Sep 22 16:41:02 bazzite sshd[9001]: pam_unix(sshd:auth): Authentication attempt too soon.\n",
  });
  const findings = await journal.run(ctx);
  assert.ok(findings.some((f) => f.code === "journal/errors"), "keep the brute-force signal");
});

test("journal: system-sleep failures are deferred to the suspend check", async () => {
  const ctx = stubCtx({
    "journalctl -p err --since \"-24 hours\" --no-pager -o short 2>/dev/null": `Aug 15 15:49:09 bazzite (system-sleep)[11514]: /usr/lib/systemd/system-sleep/fw-fanctrl-suspend failed with exit status 1.`,
  });
  const findings = await journal.run(ctx);
  assert.equal(findings.length, 0, "the suspend check owns system-sleep failures");
});

test("journal: MCE lines are deferred to the hardware check", async () => {
  const ctx = stubCtx({
    "journalctl -p err --since \"-24 hours\" --no-pager -o short 2>/dev/null": `Aug 13 03:11:22 bazzite kernel: mce: [Hardware Error]: Machine check events logged`,
  });
  const findings = await journal.run(ctx);
  assert.equal(findings.length, 0, "the hardware check owns MCE lines");
});

test("journal: unit failures are deferred to the services check", async () => {
  const ctx = stubCtx({
    "journalctl -p err --since \"-24 hours\" --no-pager -o short 2>/dev/null": `Aug 15 16:02:11 bazzite systemd[1]: homebrew.clamav.service: Failed with result 'exit-code'.\nAug 15 16:02:11 bazzite systemd[1]: Failed to start Homebrew ClamAV.`,
  });
  const findings = await journal.run(ctx);
  assert.equal(findings.length, 0, "the services check owns unit failures — one problem, one finding");
});

test("journal: missing journalctl (non-systemd) is explained, not silent", async () => {
  const ctx = stubCtx({});
  ctx.run = async () => ({ ok: false, code: -1, stdout: "", stderr: "", missing: true });
  const findings = await journal.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /log check skipped/i);
});

test("gpu: NVIDIA present but no driver loaded → medium", async () => {
  const ctx = stubCtx({
    "lspci -nn 2>/dev/null | grep -iE 'vga|3d|display'": "01:00.0 VGA compatible controller [0300]: NVIDIA Corporation GA106 [GeForce RTX 3060] [10de:2503]",
    "lsmod 2>/dev/null | awk '{print $1}' | grep -iE '^(nvidia|nouveau|amdgpu|i915|xe)$'": "",
    "ls /dev/dri/ 2>/dev/null": "card0\nrenderD128",
    "glxinfo -B 2>/dev/null | grep -i 'renderer string'": "",
  });
  const findings = await gpu.run(ctx);
  const med = findings.find((f) => f.severity === "medium");
  assert.ok(med, "expected a medium-severity finding");
  assert.match(med.title, /no driver is loaded/i);
});

test("gpu: NVIDIA with proprietary driver → info", async () => {
  const ctx = stubCtx({
    "lspci -nn 2>/dev/null | grep -iE 'vga|3d|display'": "01:00.0 VGA compatible controller [0300]: NVIDIA Corporation GA106 [10de:2503]",
    "lsmod 2>/dev/null | awk '{print $1}' | grep -iE '^(nvidia|nouveau|amdgpu|i915|xe)$'": "nvidia",
    "ls /dev/dri/ 2>/dev/null": "card0\nrenderD128",
    "glxinfo -B 2>/dev/null | grep -i 'renderer string'": "",
    "cat /proc/driver/nvidia/version 2>/dev/null": "NVRM version: NVIDIA UNIX x86_64 Kernel Module  570.124",
  });
  const findings = await gpu.run(ctx);
  const info = findings.find((f) => f.severity === "info");
  assert.ok(info);
  assert.match(info.title, /proprietary driver is loaded/i);
  assert.match(info.evidence, /570\.124/);
});

test("gpu: NVIDIA with nouveau → medium", async () => {
  const ctx = stubCtx({
    "lspci -nn 2>/dev/null | grep -iE 'vga|3d|display'": "01:00.0 VGA compatible controller [0300]: NVIDIA Corporation GA106 [10de:2503]",
    "lsmod 2>/dev/null | awk '{print $1}' | grep -iE '^(nvidia|nouveau|amdgpu|i915|xe)$'": "nouveau",
    "ls /dev/dri/ 2>/dev/null": "card0\nrenderD128",
    "glxinfo -B 2>/dev/null | grep -i 'renderer string'": "",
  });
  const findings = await gpu.run(ctx);
  const med = findings.find((f) => f.severity === "medium");
  assert.ok(med);
  assert.match(med.title, /nouveau/i);
});

test("gpu: AMD with amdgpu driver → info", async () => {
  const ctx = stubCtx({
    "lspci -nn 2>/dev/null | grep -iE 'vga|3d|display'": "06:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Navi 22 [Radeon RX 6700 XT]",
    "lsmod 2>/dev/null | awk '{print $1}' | grep -iE '^(nvidia|nouveau|amdgpu|i915|xe)$'": "amdgpu",
    "ls /dev/dri/ 2>/dev/null": "card0\nrenderD128",
    "glxinfo -B 2>/dev/null | grep -i 'renderer string'": "",
  });
  const findings = await gpu.run(ctx);
  const info = findings.find((f) => f.severity === "info");
  assert.ok(info);
  assert.match(info.title, /driver is working/i);
});

test("gpu: AMD with built-in amdgpu (not in lsmod) is NOT a missing driver", async () => {
  // amdgpu is often compiled INTO the kernel, so lsmod shows nothing even
  // though the driver is active. A working display means it is fine.
  const ctx = stubCtx({
    "lspci -nn 2>/dev/null | grep -iE 'vga|3d|display'": "06:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Navi 22 [Radeon RX 6700 XT]",
    "lsmod 2>/dev/null | awk '{print $1}' | grep -iE '^(nvidia|nouveau|amdgpu|i915|xe)$'": "",
    "ls /dev/dri/ 2>/dev/null": "card0\nrenderD128",
    "glxinfo -B 2>/dev/null | grep -i 'renderer string'": "renderer string: AMD Radeon RX 6700 XT (RADV NAVI22)",
  });
  const findings = await gpu.run(ctx);
  assert.ok(!findings.some((f) => f.severity === "medium"), "built-in amdgpu must not be reported as 'driver not loaded'");
  const info = findings.find((f) => f.severity === "info");
  assert.ok(info, "expected an informational driver finding");
});

test("gpu: AMD GPU with no working driver is medium", async () => {
  // No DRI and no usable renderer → the driver really is not driving the card.
  const ctx = stubCtx({
    "lspci -nn 2>/dev/null | grep -iE 'vga|3d|display'": "06:00.0 VGA compatible controller [0300]: Advanced Micro Devices, Inc. [AMD/ATI] Navi 22 [Radeon RX 6700 XT]",
    "lsmod 2>/dev/null | awk '{print $1}' | grep -iE '^(nvidia|nouveau|amdgpu|i915|xe)$'": "",
    "ls /dev/dri/ 2>/dev/null": "",
    "glxinfo -B 2>/dev/null | grep -i 'renderer string'": "renderer string: llvmpipe (LLVM 19.1.4, 256 bits)",
  });
  const findings = await gpu.run(ctx);
  const med = findings.find((f) => f.severity === "medium");
  assert.ok(med, "expected a medium finding when the driver genuinely is not working");
  assert.match(med.title, /amdgpu driver is not loaded/i);
});

test("gpu: software rendering (llvmpipe) → medium", async () => {
  const ctx = stubCtx({
    "lspci -nn 2>/dev/null | grep -iE 'vga|3d|display'": "00:02.0 VGA compatible controller [0300]: Intel Corporation UHD Graphics",
    "lsmod 2>/dev/null | awk '{print $1}' | grep -iE '^(nvidia|nouveau|amdgpu|i915|xe)$'": "i915",
    "ls /dev/dri/ 2>/dev/null": "card0\nrenderD128",
    "glxinfo -B 2>/dev/null | grep -i 'renderer string'": "renderer string: llvmpipe (LLVM 19.1.4, 256 bits)",
  });
  const findings = await gpu.run(ctx);
  const med = findings.find((f) => f.severity === "medium");
  assert.ok(med, "software rendering must be flagged");
  assert.match(med.title, /software rendering/i);
});

test("countBySeverity buckets findings", () => {
  const counts = countBySeverity([
    { severity: "high" },
    { severity: "high" },
    { severity: "medium" },
    { severity: "info" },
  ]);
  assert.deepEqual(counts, [
    { severity: "high", count: 2 },
    { severity: "medium", count: 1 },
    { severity: "info", count: 1 },
  ]);
});

test("updates: apt counts pending updates correctly", async () => {
  const ctx = stubCtx({
    "apt-get -s upgrade 2>&1": "Inst libssl3 [3.0.13-1] (3.0.14-1 Debian:stable-updates [amd64])\nInst firefox [130.0] (131.0 Debian:stable [amd64])\nInst vim [9.0] (9.1 Debian:stable [amd64])\n",
  });
  ctx.osRelease = { id: "debian", id_like: "" };
  ctx.dist = detectDistro(ctx.osRelease);
  const findings = await updates.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /3 update/i);
  assert.match(findings[0].fix, /apt upgrade/);
});

test("updates: apt lock/error is silent, never 'up to date'", async () => {
  const ctx = stubCtx({
    "apt-get -s upgrade 2>&1": "E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 123 (unattended-upgr)\n",
  });
  ctx.osRelease = { id: "debian", id_like: "" };
  ctx.dist = detectDistro(ctx.osRelease);
  const findings = await updates.run(ctx);
  assert.equal(findings.length, 0, "a locked apt must not be reported as 'up to date'");
});

test("updates: dnf exit code 100 (updates available) is counted", async () => {
  const ctx = {
    osRelease: { id: "fedora", id_like: "fedora" },
    dist: detectDistro({ id: "fedora", id_like: "fedora" }),
    run: async (cmd) => {
      if (cmd.startsWith("dnf check-update")) {
        return { ok: false, code: 100, stdout: "kernel.x86_64 6.9.0-1 fedora\nfirefox.x86_64 130.0-1 fedora\n", stderr: "" };
      }
      return { ok: false, code: 1, stdout: "", stderr: "" };
    },
  };
  const findings = await updates.run(ctx);
  assert.equal(findings.length, 1);
  assert.match(findings[0].title, /2 update/i);
});

// Regression: `dnf check-update` prints a "Upgrades" header, an indented
// continuation line under "Obsoleting packages", and one entry per enabled
// repo — with updates + updates-archive that is the same package twice. The old
// fallback counted all of it, so 2 real updates read as 6.
test("updates: dnf counts unique packages, not headers/continuations/repo duplicates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-updates-dnf-"));
  const prevCache = process.env.LINUX_DOCTOR_CACHE;
  const prevTtl = process.env.LINUX_DOCTOR_UPDATES_TTL_MS;
  process.env.LINUX_DOCTOR_CACHE = dir;
  process.env.LINUX_DOCTOR_UPDATES_TTL_MS = "3600000";
  try {
    const stdout = [
      "Upgrades",
      "firefox.x86_64                    130.0-1.fc44        updates",
      "firefox.x86_64                    130.0-1.fc44        updates-archive",
      "kernel.x86_64                     6.9.0-1.fc44        updates",
      "kernel.x86_64                     6.9.0-1.fc44        updates-archive",
      "Obsoleting packages",
      "    oldpkg.x86_64                 1.0-1.fc44          updates",
    ].join("\n") + "\n";
    const ctx = {
      osRelease: { id: "fedora", id_like: "fedora" },
      dist: detectDistro({ id: "fedora", id_like: "fedora" }),
      run: async (cmd) => {
        if (cmd.startsWith("dnf check-update")) return { ok: false, code: 100, stdout, stderr: "" };
        return { ok: false, code: 1, stdout: "", stderr: "" };
      },
    };
    const findings = await updates.run(ctx);
    assert.equal(findings.length, 1);
    assert.match(findings[0].title, /2 update/i);
  } finally {
    if (prevCache === undefined) delete process.env.LINUX_DOCTOR_CACHE;
    else process.env.LINUX_DOCTOR_CACHE = prevCache;
    if (prevTtl === undefined) delete process.env.LINUX_DOCTOR_UPDATES_TTL_MS;
    else process.env.LINUX_DOCTOR_UPDATES_TTL_MS = prevTtl;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updates: a failed check stays silent instead of claiming up to date", async () => {
  const ctx = {
    osRelease: { id: "debian", id_like: "" },
    dist: detectDistro({ id: "debian", id_like: "" }),
    run: async () => ({ ok: false, code: 100, stdout: "", stderr: "" }),
  };
  const findings = await updates.run(ctx);
  assert.equal(findings.length, 0);
});

test("updates: unknown distro family is skipped with info", async () => {
  const ctx = stubCtx({});
  ctx.osRelease = { id: "plan9", id_like: "" };
  ctx.dist = detectDistro(ctx.osRelease);
  const findings = await updates.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /skipped/i);
});

test("updates: rpm-ostree (Bazzite) reports an available image update", async () => {
  const ctx = {
    osRelease: { id: "bazzite", id_like: "fedora" },
    dist: detectDistro({ id: "bazzite", id_like: "fedora" }),
    run: async (cmd) => {
      if (cmd.startsWith("rpm-ostree upgrade --check")) {
        return { ok: true, code: 0, stdout: "Note: --check and --preview may be unreliable.\nAvailable update: 42.20260815.0 (checksum 1a2b3c)\n", stderr: "" };
      }
      return { ok: false, code: 1, stdout: "", stderr: "" };
    },
  };
  const findings = await updates.run(ctx);
  assert.equal(findings.length, 1);
  assert.match(findings[0].title, /1 update/i);
  assert.match(findings[0].fix, /rpm-ostree upgrade/);
  assert.match(findings[0].fix, /Reboot/);
});

test("updates: rpm-ostree with no update available is up to date", async () => {
  const ctx = {
    osRelease: { id: "bazzite", id_like: "fedora" },
    dist: detectDistro({ id: "bazzite", id_like: "fedora" }),
    run: async (cmd) => ({ ok: true, code: 0, stdout: "No updates available.\n", stderr: "" }),
  };
  const findings = await updates.run(ctx);
  assert.equal(findings.length, 1);
  assert.match(findings[0].title, /up to date/i);
});

test("updates: openSUSE (zypper) counts pending updates", async () => {
  const ctx = {
    osRelease: { id: "opensuse-tumbleweed", id_like: "suse" },
    dist: detectDistro({ id: "opensuse-tumbleweed", id_like: "suse" }),
    run: async (cmd) => {
      if (cmd.startsWith("zypper -q lu")) {
        return { ok: true, code: 0, stdout:
          "S  | Repository                 | Name     | Current Version | Available Version | Arch\n" +
          "---+----------------------------+----------+-----------------+-------------------+-------\n" +
          "v  | openSUSE-Tumbleweed-Oss    | aaa_base | 1.0-1           | 1.1-1             | x86_64\n" +
          "v  | openSUSE-Tumbleweed-Oss    | bbb      | 1.0-1           | 1.1-1             | x86_64\n" +
          "v  | openSUSE-Tumbleweed-Oss    | ccc      | 1.0-1           | 1.1-1             | x86_64\n" +
          "v  | openSUSE-Tumbleweed-Oss    | ddd      | 1.0-1           | 1.1-1             | x86_64\n", stderr: "" };
      }
      return { ok: false, code: 1, stdout: "", stderr: "" };
    },
  };
  const findings = await updates.run(ctx);
  assert.equal(findings.length, 1);
  assert.match(findings[0].title, /4 update/i);
  assert.match(findings[0].fix, /zypper update/);
});

test("updates: the apk header is not counted as a package", async () => {
  // `apk version -l '<'` always prints "Installed: ... Available:" first. Counting
  // every non-empty line would make an up-to-date Alpine report "1 update".
  const ctx = {
    osRelease: { id: "alpine", id_like: "" },
    dist: detectDistro({ id: "alpine", id_like: "" }),
    run: async (cmd) => {
      if (cmd.startsWith("apk version -l")) return { ok: true, code: 0, stdout: "Installed:                                Available:\n", stderr: "" };
      return { ok: false, code: 1, stdout: "", stderr: "" };
    },
  };
  const findings = await updates.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "updates/none", `header must not become a finding: ${JSON.stringify(findings)}`);
});

test("updates: Void (xbps) counts pending updates", async () => {
  // Void had no update branch at all, so a machine with 54 pending updates was
  // silently skipped and scored as if it were current.
  const ctx = {
    osRelease: { id: "void", id_like: "" },
    dist: detectDistro({ id: "void", id_like: "" }),
    run: async (cmd) => {
      if (cmd.startsWith("xbps-install -un")) {
        return { ok: true, code: 0, stdout:
          "acl-2.4.0_1 update x86_64 https://repo-default.voidlinux.org/current 43080 20653\n" +
          "attr-2.6.0_1 update x86_64 https://repo-default.voidlinux.org/current 27348 9495\n" +
          "bzip2-1.0.8_2 update x86_64 https://repo-default.voidlinux.org/current 150551 61517\n", stderr: "" };
      }
      return { ok: false, code: 1, stdout: "", stderr: "" };
    },
  };
  const findings = await updates.run(ctx);
  assert.equal(findings.length, 1);
  assert.match(findings[0].title, /3 update/i);
  assert.match(findings[0].fix, /xbps-install -Su/);
});

test("updates: apt with an empty index says 'could not check', not 'up to date'", async () => {
  // A fresh minimal image (and a machine that never ran `apt update`) answers
  // "0 upgraded" with a zero exit status. That is not being up to date, and
  // reporting it as such is the dangerous direction of being wrong.
  const ctx = stubCtx({
    "apt-get -s upgrade 2>&1": "Reading state information...\nCalculating upgrade...\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n",
  });
  ctx.osRelease = { id: "debian", id_like: "" };
  ctx.dist = detectDistro(ctx.osRelease);
  const findings = await updates.run(ctx);
  assert.equal(findings[0].code, "updates/stale", `an empty index is not 'up to date': ${JSON.stringify(findings)}`);
  assert.match(findings[0].fix, /apt update/);
});

test("updates: results are cached within the TTL (second run does not re-exec)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-updates-cache-"));
  const prevCache = process.env.LINUX_DOCTOR_CACHE;
  const prevTtl = process.env.LINUX_DOCTOR_UPDATES_TTL_MS;
  process.env.LINUX_DOCTOR_CACHE = dir;
  process.env.LINUX_DOCTOR_UPDATES_TTL_MS = "3600000";
  try {
    let calls = 0;
    const ctx = {
      osRelease: { id: "fedora", id_like: "fedora" },
      dist: detectDistro({ id: "fedora", id_like: "fedora" }),
      run: async (cmd) => {
        calls += 1;
        if (cmd.startsWith("dnf check-update")) {
          return { ok: false, code: 100, stdout: "firefox.x86_64 130.0-1 fedora\n", stderr: "" };
        }
        return { ok: false, code: 1, stdout: "", stderr: "" };
      },
    };
    const first = await updates.run(ctx);
    assert.match(first[0].title, /1 update/);
    assert.equal(calls, 1);
    const second = await updates.run(ctx);
    assert.match(second[0].title, /1 update/);
    assert.equal(calls, 1, "second run must come from the cache, not re-exec");
  } finally {
    if (prevCache === undefined) delete process.env.LINUX_DOCTOR_CACHE;
    else process.env.LINUX_DOCTOR_CACHE = prevCache;
    if (prevTtl === undefined) delete process.env.LINUX_DOCTOR_UPDATES_TTL_MS;
    else process.env.LINUX_DOCTOR_UPDATES_TTL_MS = prevTtl;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updates: a failed check is not cached (next run retries)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-updates-cache-"));
  const prevCache = process.env.LINUX_DOCTOR_CACHE;
  const prevTtl = process.env.LINUX_DOCTOR_UPDATES_TTL_MS;
  process.env.LINUX_DOCTOR_CACHE = dir;
  process.env.LINUX_DOCTOR_UPDATES_TTL_MS = "3600000";
  try {
    let calls = 0;
    const ctx = {
      osRelease: { id: "fedora", id_like: "fedora" },
      dist: detectDistro({ id: "fedora", id_like: "fedora" }),
      run: async () => {
        calls += 1;
        return { ok: false, code: 1, stdout: "", stderr: "" };
      },
    };
    const first = await updates.run(ctx);
    assert.equal(first.length, 0);
    const second = await updates.run(ctx);
    assert.equal(second.length, 0);
    // A failed determination is not cached, so the second run re-executes
    // instead of serving a stale "up to date" from the cache.
    assert.equal(calls, 2);
  } finally {
    if (prevCache === undefined) delete process.env.LINUX_DOCTOR_CACHE;
    else process.env.LINUX_DOCTOR_CACHE = prevCache;
    if (prevTtl === undefined) delete process.env.LINUX_DOCTOR_UPDATES_TTL_MS;
    else process.env.LINUX_DOCTOR_UPDATES_TTL_MS = prevTtl;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updates: Alpine (apk) counts upgradable packages", async () => {
  const ctx = {
    osRelease: { id: "alpine", id_like: "" },
    dist: detectDistro({ id: "alpine", id_like: "" }),
    run: async (cmd) => {
      if (cmd.startsWith("apk version -l")) {
        return { ok: true, code: 0, stdout:
          "Installed:                                Available:\n" +
          "musl-1.2.4-r2                            < 1.2.5-r0\n" +
          "openssl-3.0.1-r0                         < 3.0.2-r0\n" +
          "busybox-1.36.0-r0                        < 1.36.1-r0\n", stderr: "" };
      }
      return { ok: false, code: 1, stdout: "", stderr: "" };
    },
  };
  const findings = await updates.run(ctx);
  assert.equal(findings.length, 1);
  assert.match(findings[0].title, /3 update/i);
  assert.match(findings[0].fix, /apk upgrade/);
});

test("security: active firewall and SELinux enforcing are reported", async () => {
  const ctx = stubCtx({
    "systemctl is-active firewalld 2>/dev/null": "active\n",
    "systemctl is-active ufw 2>/dev/null": "inactive\n",
    "nft list ruleset 2>/dev/null | head -5": "",
    "getenforce 2>/dev/null": "Enforcing\n",
    "systemctl is-active packagekit 2>/dev/null || systemctl is-active dnf-makecache 2>/dev/null": "inactive\n",
  });
  const findings = await security.run(ctx);
  const titles = findings.map((f) => f.title).join(" ");
  assert.match(titles, /Firewall is active/);
  assert.match(titles, /SELinux is enforcing/);
  assert.ok(!findings.some((f) => f.severity === "medium"), "no medium finding when the firewall is up");
});

test("security: no firewall detected → informational finding", async () => {
  const ctx = stubCtx({
    "systemctl is-active firewalld 2>/dev/null": "inactive\n",
    "systemctl is-active ufw 2>/dev/null": "inactive\n",
    "nft list ruleset 2>/dev/null | head -5": "",
    "getenforce 2>/dev/null": "",
    "cat /sys/kernel/security/apparmor/profiles 2>/dev/null | head -3": "",
    "systemctl is-active packagekit 2>/dev/null || systemctl is-active dnf-makecache 2>/dev/null": "inactive\n",
  });
  const findings = await security.run(ctx);
  const info = findings.find((f) => f.title.includes("No active firewall"));
  assert.ok(info, "expected a firewall finding");
  assert.equal(info.severity, "info", "absence of optional hardening is informational, not a fault");
});

test("security: AppArmor is reported on Debian-family systems", async () => {
  const ctx = stubCtx({
    "systemctl is-active firewalld 2>/dev/null": "active\n",
    "systemctl is-active ufw 2>/dev/null": "inactive\n",
    "nft list ruleset 2>/dev/null | head -5": "",
    "getenforce 2>/dev/null": "",
    "cat /sys/kernel/security/apparmor/profiles 2>/dev/null | head -3": "docker-default (enforce)\nsnap.discord.discord (enforce)\n",
    "systemctl is-active packagekit 2>/dev/null || systemctl is-active dnf-makecache 2>/dev/null": "inactive\n",
  });
  const findings = await security.run(ctx);
  const aa = findings.find((f) => f.title.includes("AppArmor"));
  assert.ok(aa, "expected an AppArmor finding");
  assert.equal(aa.severity, "info");
  assert.match(aa.evidence, /docker-default/);
});

test("security: unreadable nftables without root is 'unknown', not 'no firewall'", async () => {
  const ctx = stubCtx({
    "systemctl is-active firewalld 2>/dev/null": "inactive\n",
    "systemctl is-active ufw 2>/dev/null": "inactive\n",
    "systemctl is-active nftables 2>/dev/null": "inactive\n",
    // The binary is there; reading the ruleset needs CAP_NET_ADMIN, so the
    // nft command itself fails. (The probe used to end in `| head -5`, whose
    // exit code is 0 — so this case used to read as "readable and empty",
    // i.e. "no firewall".)
    "command -v nft 2>/dev/null": "/usr/sbin/nft\n",
    // `nft list ruleset 2>/dev/null` intentionally unstubbed: it fails without root.
    "getenforce 2>/dev/null": "",
    "cat /sys/kernel/security/apparmor/profiles 2>/dev/null | head -3": "",
    "systemctl is-active packagekit 2>/dev/null || systemctl is-active dnf-makecache 2>/dev/null": "inactive\n",
  });
  const findings = await security.run(ctx);
  const unknown = findings.find((f) => f.code === "security/firewall-unknown");
  assert.ok(unknown, "expected a firewall-unknown finding");
  assert.equal(unknown.severity, "info");
  assert.equal(unknown.fix, null, "unknown must never carry a fix that could enable a firewall");
  assert.ok(!findings.some((f) => f.code === "security/no-firewall"), "must not claim there is no firewall");
});

test("security: nftables not installed is a determinate 'no firewall', not 'unknown'", async () => {
  const ctx = stubCtx({
    "systemctl is-active firewalld 2>/dev/null": "inactive\n",
    "systemctl is-active ufw 2>/dev/null": "inactive\n",
    "systemctl is-active nftables 2>/dev/null": "inactive\n",
    "command -v nft 2>/dev/null": "",
    "getenforce 2>/dev/null": "",
    "cat /sys/kernel/security/apparmor/profiles 2>/dev/null | head -3": "",
    "systemctl is-active packagekit 2>/dev/null || systemctl is-active dnf-makecache 2>/dev/null": "inactive\n",
  });
  const findings = await security.run(ctx);
  assert.ok(findings.some((f) => f.code === "security/no-firewall"), "no nftables and no service is a determinate answer");
  assert.ok(!findings.some((f) => f.code === "security/firewall-unknown"), "a missing tool is not an unreadable ruleset");
});

test("security: a readable, non-empty ruleset counts as an active firewall", async () => {
  const ctx = stubCtx({
    "systemctl is-active firewalld 2>/dev/null": "inactive\n",
    "systemctl is-active ufw 2>/dev/null": "inactive\n",
    "systemctl is-active nftables 2>/dev/null": "inactive\n",
    "command -v nft 2>/dev/null": "/usr/sbin/nft\n",
    "nft list ruleset 2>/dev/null": "table inet filter {\n\tchain input {\n\t\ttype filter hook input priority 0; policy drop;\n\t}\n}\n",
    "getenforce 2>/dev/null": "",
    "cat /sys/kernel/security/apparmor/profiles 2>/dev/null | head -3": "",
    "systemctl is-active packagekit 2>/dev/null || systemctl is-active dnf-makecache 2>/dev/null": "inactive\n",
  });
  const findings = await security.run(ctx);
  const fw = findings.find((f) => f.code === "security/firewall");
  assert.ok(fw, "rules present means the firewall is active");
  assert.match(fw.evidence, /nftables rules present/);
});

test("processes: a single app over 20% of RAM is flagged medium", async () => {
  const ctx = stubCtx({
    // ps -o rss reports KiB: 4000000 KiB ≈ 3.8 GB of 15 GB (~25%).
    "command -v ps 2>/dev/null": "/usr/bin/ps\n",
    "ps -eo rss,args 2>/dev/null": `4000000 brave\n800000 firefox\n500000 plasma\n`,
    "free -b": `              total        used        free      shared  buff/cache   available\nMem:    16106127360 12000000000   500000000    500000000  4718592000   1500000000\nSwap:   8267812045         0 8267812045`,
  });
  const findings = await processes.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].title, /using a lot of memory/);
});

test("processes: a single app over 40% of RAM is flagged medium", async () => {
  const ctx = stubCtx({
    // 8000000 KiB ≈ 7.6 GB of 15 GB (~50%).
    "command -v ps 2>/dev/null": "/usr/bin/ps\n",
    "ps -eo rss,args 2>/dev/null": `8000000 brave\n800000 firefox\n500000 plasma\n`,
    "free -b": `              total        used        free      shared  buff/cache   available\nMem:    16106127360 14000000000   500000000    500000000  4718592000   1500000000\nSwap:   8267812045         0 8267812045`,
  });
  const findings = await processes.run(ctx);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].title, /huge amount of memory/);
});


test("processes: RSS is summed per app, so a multi-process app is not split", async () => {
  // Brave spreads its memory across processes that share one binary. The check
  // listed "brave" twice and reported the largest process as if it were the
  // app. Summed: 3M + 1.5M KiB = 4.5M KiB ≈ 28.6% of 16GB. One process alone
  // (19.1%) stayed under the warn threshold, so the split hid the footprint.
  const ctx = stubCtx({
    "command -v ps 2>/dev/null": "/usr/bin/ps\n",
    "ps -eo rss,args 2>/dev/null": `3000000 brave --type=renderer\n1500000 brave\n800000 firefox\n`,
    "free -b": `              total        used        free      shared  buff/cache   available\nMem:    16106127360 12000000000   500000000    500000000  4718592000   1500000000\nSwap:   8267812045         0 8267812045`,
  });
  const findings = await processes.run(ctx);
  assert.equal(findings[0].code, "processes/warn", `expected the summed app: ${JSON.stringify(findings.map((f) => f.code))}`);
  const braveRows = findings[0].evidence.split("\n").filter((l) => /^brave\t/.test(l));
  assert.equal(braveRows.length, 1, `brave must appear once: ${findings[0].evidence}`);
});


test("processes: a large app on a box with free RAM is informational, not a warning", async () => {
  // The false alarm a 15GB box got: Brave at ~19% while 9.4GB was free. Here
  // the top app is 5M KiB ≈ 32% of RAM, over the 20% warn threshold, but 58%
  // of RAM is available — so it is the top consumer, not a problem.
  const ctx = stubCtx({
    "command -v ps 2>/dev/null": "/usr/bin/ps\n",
    "ps -eo rss,args 2>/dev/null": `5000000 brave\n800000 firefox\n`,
    "free -b": `              total        used        free      shared  buff/cache   available\nMem:    16106127360  6000000000  5000000000    147000000  4900000000   9400000000\nSwap:   8267812045         0 8267812045`,
  });
  const findings = await processes.run(ctx);
  assert.equal(findings[0].code, "processes/ok", `a big app with free RAM is not a warning: ${JSON.stringify(findings.map((f) => f.code))}`);
  assert.equal(findings[0].severity, "info");
});

test("processes: healthy memory usage produces an info finding", async () => {
  const ctx = stubCtx({
    "command -v ps 2>/dev/null": "/usr/bin/ps\n",
    "ps -eo rss,args 2>/dev/null": `500000 plasma\n400000 firefox\n300000 brave\n`,
    "free -b": `              total        used        free      shared  buff/cache   available\nMem:    16106127360  5000000000 1000000000  300000000  7000000000  11000000000\nSwap:   8267812045         0 8267812045`,
  });
  const findings = await processes.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /Top memory consumers/);
});

test("suspend: failing system-sleep hooks are surfaced as medium", async () => {
  const ctx = stubCtx({
    "journalctl -g \"system-sleep.*failed\" --since \"-7 days\" --no-pager -o short 2>/dev/null": `Aug 10 22:11:03 bazzite (system-sleep)[11514]: /usr/lib/systemd/system-sleep/fw-fanctrl-suspend failed with exit status 1.\nAug 11 07:30:12 bazzite (system-sleep)[11514]: /usr/lib/systemd/system-sleep/fw-fanctrl-suspend failed with exit status 1.`,
  });
  const findings = await suspend.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].evidence, /fw-fanctrl-suspend/);
});

test("suspend: clean log produces no finding", async () => {
  const ctx = stubCtx({
    "journalctl -g \"system-sleep.*failed\" --since \"-7 days\" --no-pager -o short 2>/dev/null": "",
  });
  const findings = await suspend.run(ctx);
  assert.equal(findings.length, 0);
});

test("suspend: boot separators alone are NOT a failing hook", async () => {
  // journalctl -g prints "-- Boot ... --" separators for every boot in the
  // window even when nothing matched — this used to produce a false positive.
  const ctx = stubCtx({
    "journalctl -g \"system-sleep.*failed\" --since \"-7 days\" --no-pager -o short 2>/dev/null": "",
  });
  const findings = await suspend.run(ctx);
  assert.equal(findings.length, 0, "separator-only output must not be a finding");
});

test("journal: benign kernel noise (i2c address) is not an error finding", async () => {
  const ctx = stubCtx({
    "journalctl -p err --since \"-24 hours\" --no-pager -o short 2>/dev/null": `Aug 15 14:32:47 bazzite kernel: i2c i2c-1: Invalid 7-bit I2C address 0xffff`,
  });
  const findings = await journal.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /routine noise/i);
  assert.ok(!findings.some((f) => /recognized error|unrecognized log entry/i.test(f.title)), "known noise must not be reported as an error");
});

test("journal: unrecognized entries stay informational, not medium", async () => {
  const ctx = stubCtx({
    "journalctl -p err --since \"-24 hours\" --no-pager -o short 2>/dev/null": `Aug 15 14:32:47 bazzite app[123]: Something unknown and weird happened\nAug 15 14:33:01 bazzite app[456]: Another unknown message\n`,
  });
  const findings = await journal.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info", "unrecognized entries must not escalate to medium");
  assert.match(findings[0].title, /unrecognized log entr/i);
});

// Regression: `-o short` prints a crash and its stack trace as one timestamped
// head line followed by indented continuation lines. Counting every
// continuation as its own entry turned a handful of crashes into a
// "3062 unrecognized log entries" finding.
test("journal: a multi-line entry counts once, not once per stack line", async () => {
  const ctx = stubCtx({
    "journalctl -p err --since \"-24 hours\" --no-pager -o short 2>/dev/null":
      "Aug 15 14:32:47 bazzite plasmashell[123]: Something unknown happened\n" +
      "                                          Stack trace of thread 123:\n" +
      "                                          #0  0x7f0 in __syscall_cancel_arch (libc.so.6)\n" +
      "                                          #1  0x7f0 in start_thread (libc.so.6)\n",
  });
  const findings = await journal.run(ctx);
  assert.equal(findings.length, 1);
  assert.match(findings[0].title, /^1 unrecognized log entry/);
});

test("battery: low battery is flagged medium", async () => {
  const ctx = stubCtx({
    "ls /sys/class/power_supply/ 2>/dev/null": "AC\nBAT0\n",
    "cat /sys/class/power_supply/BAT0/type 2>/dev/null": "Battery\n",
    "cat /sys/class/power_supply/BAT0/capacity 2>/dev/null": "12\n",
    "cat /sys/class/power_supply/BAT0/status 2>/dev/null": "Discharging\n",
  });
  const findings = await battery.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].title, /very low/);
});

test("battery: healthy battery is informational", async () => {
  const ctx = stubCtx({
    "ls /sys/class/power_supply/ 2>/dev/null": "AC\nBAT0\n",
    "cat /sys/class/power_supply/BAT0/type 2>/dev/null": "Battery\n",
    "cat /sys/class/power_supply/BAT0/capacity 2>/dev/null": "87\n",
    "cat /sys/class/power_supply/BAT0/status 2>/dev/null": "Charging\n",
  });
  const findings = await battery.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].detail, /87%/);
});

test("battery: desktop with no battery is skipped with info", async () => {
  const ctx = stubCtx({
    "ls /sys/class/power_supply/ 2>/dev/null": "AC\n",
  });
  const findings = await battery.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /No battery detected/);
});

test("services: non-systemd system explains why the check is skipped", async () => {
  const ctx = {
    osRelease: { id: "alpine", id_like: "" },
    run: async (cmd) => {
      if (cmd.startsWith("systemctl")) return { ok: false, code: -1, stdout: "", stderr: "", missing: true };
      if (cmd.startsWith("ps -p 1")) return { ok: true, code: 0, stdout: "openrc\n", stderr: "" };
      return { ok: false, code: 1, stdout: "", stderr: "" };
    },
  };
  const findings = await services.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /Non-systemd/);
  assert.match(findings[0].detail, /openrc/);
});

test("firmware: pending fwupd updates are reported as medium", async () => {
  const ctx = stubCtx({
    "command -v fwupdmgr 2>/dev/null": "/usr/bin/fwupdmgr\n",
    "systemctl is-active fwupd 2>/dev/null": "active\n",
    "fwupdmgr get-updates 2>/dev/null": "• System Firmware has updates: 1.2.3 → 1.2.4\n",
  });
  const findings = await firmware.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].title, /1 firmware update/);
  assert.match(findings[0].fix, /fwupdmgr update/);
});

test("firmware: no pending updates is informational", async () => {
  const ctx = stubCtx({
    "command -v fwupdmgr 2>/dev/null": "/usr/bin/fwupdmgr\n",
    "systemctl is-active fwupd 2>/dev/null": "active\n",
    "fwupdmgr get-updates 2>/dev/null": "No updates available\n",
  });
  const findings = await firmware.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /up to date/i);
});

test("firmware: inactive daemon skips fwupdmgr and explains", async () => {
  const ran = [];
  const ctx = {
    osRelease: { id: "bazzite", id_like: "fedora" },
    run: async (cmd) => {
      ran.push(cmd);
      if (cmd === "command -v fwupdmgr 2>/dev/null") return { ok: true, code: 0, stdout: "/usr/bin/fwupdmgr\n", stderr: "" };
      if (cmd === "systemctl is-active fwupd 2>/dev/null") return { ok: true, code: 0, stdout: "inactive\n", stderr: "" };
      return { ok: false, code: 1, stdout: "", stderr: "" };
    },
  };
  const findings = await firmware.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /not checked/);
  assert.match(findings[0].fix, /enable --now fwupd/);
  assert.ok(!ran.some((c) => c.startsWith("fwupdmgr get-updates")), "fwupdmgr must not run when the daemon is inactive");
});

test("firmware: fwupd not installed stays silent", async () => {
  const ctx = {
    osRelease: { id: "bazzite", id_like: "fedora" },
    run: async (cmd) =>
      cmd.startsWith("fwupdmgr")
        ? { ok: false, code: -1, stdout: "", stderr: "", missing: true }
        : { ok: false, code: 1, stdout: "", stderr: "" },
  };
  const findings = await firmware.run(ctx);
  assert.equal(findings.length, 0);
});

// Regression: `df -P /boot` prints the ROOT filesystem row when /boot is just a
// directory on /, with the same columns as a real boot partition. A 95%-full
// root therefore became a high "Boot partition (/boot) is nearly full". The row
// is only trusted when its mount point is the one we asked about.
test("boot: a plain /boot directory on the root filesystem is not a boot partition", async () => {
  const ctx = stubCtx({
    "df -P /boot 2>/dev/null": "Filesystem  Size Used Avail Use% Mounted on\n/dev/nvme0n1p2  100G  90G  5G  95% /\n",
    "df -P /boot/efi 2>/dev/null": "Filesystem  Size Used Avail Use% Mounted on\n/dev/nvme0n1p1  511M  10M  501M  2% /boot/efi\n",
    "ls /boot/grub/grub.cfg /boot/grub2/grub.cfg /boot/loader/entries/*.conf 2>/dev/null | head -1": "/boot/grub2/grub.cfg\n",
    "ls /boot/efi/EFI/*/grub*.cfg /boot/efi/EFI/*/grubx64.efi 2>/dev/null | head -1": "/boot/efi/EFI/fedora/grubx64.efi\n",
    "test -d /boot 2>/dev/null && echo yes": "yes\n",
    "ls /boot/vmlinuz-* 2>/dev/null | head -1": "/boot/vmlinuz-6.9\n",
  }, { id: "debian", id_like: "debian" });
  const findings = await boot.run(ctx);
  assert.ok(!findings.some((f) => f.code === "boot/full"), "the root filesystem must not be reported as /boot");
});

test("boot: a full separate /boot is high", async () => {
  const ctx = stubCtx({
    "df -P /boot 2>/dev/null": "Filesystem  Size Used Avail Use% Mounted on\n/dev/sda2  500M  480M  20M  96% /boot\n",
    "df -P /boot/efi 2>/dev/null | tail -1": "",
    "ls /boot/grub/grub.cfg /boot/grub2/grub.cfg /boot/loader/entries/*.conf 2>/dev/null | head -1": "/boot/grub/grub.cfg\n",
    "test -d /boot 2>/dev/null && echo yes": "yes\n",
  }, { id: "debian", id_like: "debian" });
  const findings = await boot.run(ctx);
  assert.equal(findings[0].code, "boot/full");
  assert.equal(findings[0].severity, "high");
  assert.match(findings[0].evidence, /\/boot$/);
});

test("secureboot: UEFI with Secure Boot enabled and TPM is informational", async () => {
  const ctx = stubCtx({
    "ls /sys/firmware/efi 2>/dev/null | head -1": "efi\n",
    "od -An -tu1 /sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c 2>/dev/null": "8 0 0 0 1\n",
    "mokutil --sb-state 2>/dev/null": "SecureBoot enabled\n",
    "ls /sys/class/tpm/tpm0 2>/dev/null": "tpm0\n",
  });
  const findings = await secureboot.run(ctx);
  const titles = findings.map((f) => f.title).join(" ");
  assert.match(titles, /Secure Boot is enabled/);
  assert.match(titles, /TPM is present/);
  assert.ok(!findings.some((f) => f.severity === "medium"));
});

test("secureboot: disabled Secure Boot and missing TPM are informational", async () => {
  const ctx = stubCtx({
    "ls /sys/firmware/efi 2>/dev/null | head -1": "efi\n",
    "mokutil --sb-state 2>/dev/null": "SecureBoot disabled\n",
  });
  const findings = await secureboot.run(ctx);
  const infos = findings.filter((f) => f.severity === "info");
  assert.equal(infos.length, 2, "absence of optional hardening is informational, not a fault");
  assert.match(infos.map((f) => f.title).join(" "), /Secure Boot is disabled/);
  assert.match(infos.map((f) => f.title).join(" "), /No TPM detected/);
});

test("secureboot: legacy BIOS boot is informational", async () => {
  const ctx = stubCtx({});
  const findings = await secureboot.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /Legacy BIOS/);
});

test("thermal: 95°C CPU is flagged high", async () => {
  const ctx = stubCtx({
    'for z in /sys/class/thermal/thermal_zone*; do [ -f "$z/type" ] && [ -f "$z/temp" ] && echo "$(cat "$z/type"):$(cat "$z/temp")"; done 2>/dev/null': "x86_pkg_temp:95000\nacpitz:51000\n",
  });
  const findings = await thermal.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "high");
  assert.match(findings[0].title, /very hot/);
  assert.match(findings[0].evidence, /95°C/);
});

test("thermal: normal temperature is informational", async () => {
  const ctx = stubCtx({
    'for z in /sys/class/thermal/thermal_zone*; do [ -f "$z/type" ] && [ -f "$z/temp" ] && echo "$(cat "$z/type"):$(cat "$z/temp")"; done 2>/dev/null': "x86_pkg_temp:58000\n",
  });
  const findings = await thermal.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /look fine/);
});

test("thermal: throttling events in the journal are medium", async () => {
  const ctx = stubCtx({
    'for z in /sys/class/thermal/thermal_zone*; do [ -f "$z/type" ] && [ -f "$z/temp" ] && echo "$(cat "$z/type"):$(cat "$z/temp")"; done 2>/dev/null': "x86_pkg_temp:45000\n",
    'journalctl -g "clock throttl" --since "-24 hours" --no-pager -o short 2>/dev/null': "Aug 15 10:00:00 bazzite kernel: CPU3: Core temperature above threshold, cpu clock throttled\n",
  });
  const findings = await thermal.run(ctx);
  const throttle = findings.find((f) => /throttling/i.test(f.title));
  assert.ok(throttle, "expected a throttling finding");
  assert.equal(throttle.severity, "medium");
});

test("thermal: app-level messages containing 'throttle' are NOT CPU throttling", async () => {
  // The old pattern `-g "throttl"` also matched app messages like
  // "setStartupThrottle" (Roblox, Chromium) — a false positive.
  const ctx = stubCtx({
    'for z in /sys/class/thermal/thermal_zone*; do [ -f "$z/type" ] && [ -f "$z/temp" ] && echo "$(cat "$z/type"):$(cat "$z/temp")"; done 2>/dev/null': "x86_pkg_temp:45000\n",
    'journalctl -g "clock throttl" --since "-24 hours" --no-pager -o short 2>/dev/null': "Aug 18 13:39:06 bazzite flatpak[143639]: info: Roblox: ... setStartupThrottle: false\n",
  });
  const findings = await thermal.run(ctx);
  assert.ok(!findings.some((f) => f.title.includes("throttling")), "app-level throttle messages must not be reported as CPU throttling");
});

test("thermal: journalctl boot separators alone are NOT throttling", async () => {
  const ctx = stubCtx({
    'journalctl -g "clock throttl" --since "-24 hours" --no-pager -o short 2>/dev/null': "",
  });
  const findings = await thermal.run(ctx);
  assert.ok(!findings.some((f) => f.title.includes("throttling")), "separator-only output must not be a throttling finding");
});

test("flatpak: pending updates are counted", async () => {
  const ctx = stubCtx({
    "flatpak remote-ls --updates --columns=application,version 2>/dev/null": "org.mozilla.firefox\t115.0\norg.gnome.Calculator\t46.0\norg.videolan.VLC\t3.0.20\n",
  });
  const findings = await flatpak.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /3 Flatpak update/);
  assert.match(findings[0].fix, /flatpak update/);
});

test("flatpak: up to date is informational", async () => {
  const ctx = stubCtx({
    "flatpak remote-ls --updates --columns=application,version 2>/dev/null": "",
  });
  const findings = await flatpak.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /up to date/);
});

test("flatpak: not installed stays silent", async () => {
  const ctx = {
    osRelease: { id: "bazzite", id_like: "fedora" },
    run: async () => ({ ok: false, code: -1, stdout: "", stderr: "", missing: true }),
  };
  const findings = await flatpak.run(ctx);
  assert.equal(findings.length, 0);
});

// Regression: `flatpak remote-ls --updates` prints a column table whose fields
// contain no "/", so counting lines with "/" read zero and reported "Flatpak
// apps are up to date" on a machine with pending updates. `--columns` is used
// now; this keeps the fallback honest on flatpak versions without it.
test("flatpak: a flatpak without --columns still counts the table rows", async () => {
  const ctx = stubCtx({
    // The --columns probe is unknown to this stub, so it fails, which is exactly
    // how an older flatpak behaves.
    "flatpak remote-ls --updates 2>/dev/null":
      "Minecraft Bedrock Launcher\tio.mrarm.mcpelauncher\tv1.8.3\tstable\tx86_64\n" +
      "Obsidian\tmd.obsidian.Obsidian\t1.13.7\tstable\tx86_64\n",
  });
  const findings = await flatpak.run(ctx);
  assert.equal(findings.length, 1);
  assert.match(findings[0].title, /2 Flatpak update/);
});

test("bluetooth: no controller is informational and skips the rest", async () => {
  const ctx = stubCtx({
    "ls /sys/class/bluetooth 2>/dev/null": "",
  });
  const findings = await bluetooth.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /No Bluetooth hardware/);
});

test("bluetooth: controller + running daemon is healthy", async () => {
  const ctx = stubCtx({
    "ls /sys/class/bluetooth 2>/dev/null": "hci0\n",
    "systemctl is-failed bluetooth 2>/dev/null": "inactive\n",
    "pgrep -x bluetoothd 2>/dev/null": "1234\n",
  });
  const findings = await bluetooth.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /Bluetooth is working/);
  assert.match(findings[0].evidence, /hci0/);
});

test("bluetooth: failed service is medium", async () => {
  const ctx = stubCtx({
    "ls /sys/class/bluetooth 2>/dev/null": "hci0\n",
    "systemctl is-failed bluetooth 2>/dev/null": "failed\n",
  });
  const findings = await bluetooth.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].title, /failed state/);
  assert.ok(findings[0].fix, "failed services should include a fix");
});

test("bluetooth: controller present but daemon down is medium", async () => {
  const ctx = stubCtx({
    "ls /sys/class/bluetooth 2>/dev/null": "hci0\n",
    "systemctl is-failed bluetooth 2>/dev/null": "inactive\n",
    "pgrep -x bluetoothd 2>/dev/null": "",
  });
  const findings = await bluetooth.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].title, /not running/);
  assert.match(findings[0].fix, /systemctl enable --now bluetooth/);
});

test("wayland: no graphical session is informational", async () => {
  const ctx = stubCtx({
    'loginctl list-sessions --no-legend 2>/dev/null | grep -m1 -E "(^|[[:space:]])seat[0-9]+([[:space:]]|$)" | cut -d" " -f1': "",
  });
  const findings = await wayland.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /No graphical session/);
});

test("wayland: X11 session is informational", async () => {
  const ctx = stubCtx({
    'loginctl list-sessions --no-legend 2>/dev/null | grep -m1 -E "(^|[[:space:]])seat[0-9]+([[:space:]]|$)" | cut -d" " -f1': "2\n",
    "loginctl show-session 2 -p Type -p Desktop 2>/dev/null": "Type=x11\nDesktop=KDE\n",
  });
  const findings = await wayland.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /X11 session/);
});

test("wayland: healthy Wayland session with running compositor is informational", async () => {
  const ctx = stubCtx({
    'loginctl list-sessions --no-legend 2>/dev/null | grep -m1 -E "(^|[[:space:]])seat[0-9]+([[:space:]]|$)" | cut -d" " -f1': "3\n",
    "loginctl show-session 3 -p Type -p Desktop 2>/dev/null": "Type=wayland\nDesktop=gnome\n",
    "pgrep -a -f 'kwin_[w]ayland|gnome-[s]hell|[s]way|[h]yprland|[r]iver|[w]ayfire|[l]abwc|[n]iri|cosmic-[c]omp|[m]utter|[w]eston|[c]age' 2>/dev/null | head -1": "1234 gnome-shell\n",
  });
  const findings = await wayland.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /Wayland session looks healthy/);
  assert.match(findings[0].evidence, /gnome-shell/);
});

test("wayland: Wayland session without a compositor is medium", async () => {
  const ctx = stubCtx({
    'loginctl list-sessions --no-legend 2>/dev/null | grep -m1 -E "(^|[[:space:]])seat[0-9]+([[:space:]]|$)" | cut -d" " -f1': "3\n",
    "loginctl show-session 3 -p Type -p Desktop 2>/dev/null": "Type=wayland\nDesktop=gnome\n",
    "pgrep -a -f 'kwin_[w]ayland|gnome-[s]hell|[s]way|[h]yprland|[r]iver|[w]ayfire|[l]abwc|[n]iri|cosmic-[c]omp|[m]utter|[w]eston|[c]age' 2>/dev/null | head -1": "",
  });
  const findings = await wayland.run(ctx);
  const mediums = findings.filter((f) => f.severity === "medium");
  assert.equal(mediums.length, 1);
  assert.match(mediums[0].title, /no compositor process/);
});

test("wayland: software rendering in a Wayland session is medium", async () => {
  const ctx = stubCtx({
    'loginctl list-sessions --no-legend 2>/dev/null | grep -m1 -E "(^|[[:space:]])seat[0-9]+([[:space:]]|$)" | cut -d" " -f1': "3\n",
    "loginctl show-session 3 -p Type -p Desktop 2>/dev/null": "Type=wayland\nDesktop=hyprland\n",
    "pgrep -a -f 'kwin_[w]ayland|gnome-[s]hell|[s]way|[h]yprland|[r]iver|[w]ayfire|[l]abwc|[n]iri|cosmic-[c]omp|[m]utter|[w]eston|[c]age' 2>/dev/null | head -1": "42 Hyprland\n",
    "glxinfo -B 2>/dev/null | grep -i 'renderer string'": "OpenGL renderer string: llvmpipe (LLVM 17.0.6, 256 bits)\n",
  });
  const findings = await wayland.run(ctx);
  const mediums = findings.filter((f) => f.severity === "medium");
  assert.equal(mediums.length, 1);
  assert.match(mediums[0].title, /software rendering/);
  assert.match(mediums[0].evidence, /llvmpipe/);
});

test("backup: nothing detected is informational", async () => {
  const ctx = stubCtx({
    'for t in borg restic rclone duplicity timeshift pika-backup backintime deja-dup; do command -v "$t" 2>/dev/null; done': "",
    "ls /etc/snapper/configs 2>/dev/null": "",
    "[ -f /etc/timeshift/timeshift.json ] && echo configured": "",
    "systemctl list-timers --all --no-pager 2>/dev/null | grep -iE 'backup|borg|restic|timeshift|snapper|pika|deja' | grep -oE '[A-Za-z0-9_.@-]+\\.timer' | sort -u": "",
  });
  const findings = await backup.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info", "no backup tool is a setup choice, not a fault");
  assert.match(findings[0].title, /No backup or snapshot tool/);
  assert.ok(findings[0].fix, "missing backups should include a fix");
});

test("backup: tools installed but nothing scheduled is informational", async () => {
  const ctx = stubCtx({
    'for t in borg restic rclone duplicity timeshift pika-backup backintime deja-dup; do command -v "$t" 2>/dev/null; done': "/usr/bin/borg\n/usr/bin/restic\n",
    "systemctl list-timers --all --no-pager 2>/dev/null | grep -iE 'backup|borg|restic|timeshift|snapper|pika|deja' | grep -oE '[A-Za-z0-9_.@-]+\\.timer' | sort -u": "",
    "command -v systemctl 2>/dev/null": "/usr/bin/systemctl\n",
  });
  const findings = await backup.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info", "unscheduled backups are informational, not a detected fault");
  assert.match(findings[0].title, /nothing is scheduled/);
  assert.match(findings[0].evidence, /borg/);
});

test("backup: tools plus a scheduled timer is informational", async () => {
  const ctx = stubCtx({
    'for t in borg restic rclone duplicity timeshift pika-backup backintime deja-dup; do command -v "$t" 2>/dev/null; done': "/usr/bin/borg\n",
    "systemctl list-timers --all --no-pager 2>/dev/null | grep -iE 'backup|borg|restic|timeshift|snapper|pika|deja' | grep -oE '[A-Za-z0-9_.@-]+\\.timer' | sort -u": "borg-backup.timer\n",
  });
  const findings = await backup.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /Backups are set up/);
  assert.match(findings[0].evidence, /borg-backup.timer/);
});

test("backup: snapper configs count as a snapshot system", async () => {
  const ctx = stubCtx({
    "ls /etc/snapper/configs 2>/dev/null": "home\nroot\n",
    "systemctl list-timers --all --no-pager 2>/dev/null | grep -iE 'backup|borg|restic|timeshift|snapper|pika|deja' | grep -oE '[A-Za-z0-9_.@-]+\\.timer' | sort -u": "snapper-timeline.timer\n",
  });
  const findings = await backup.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /Backups are set up/);
  assert.match(findings[0].evidence, /snapper/);
});

test("hardware: machine check exceptions are high", async () => {
  const ctx = stubCtx({
    "command -v journalctl 2>/dev/null": "/usr/bin/journalctl\n",
    'journalctl -k --since "-7 days" --no-pager -o short 2>/dev/null | grep -iE "mce|machine check|hardware error|edac|corrected error|ecc error"': "Aug 13 03:11:22 bazzite kernel: mce: [Hardware Error]: Machine check events logged\n",
  });
  const findings = await hardware.run(ctx);
  const high = findings.filter((f) => f.severity === "high");
  assert.equal(high.length, 1);
  assert.match(high[0].title, /Machine check exceptions/);
  assert.ok(high[0].fix, "MCE findings should include a fix");
});

// EDAC's own vocabulary: a UE is *uncorrected*. The check used to report every
// EDAC line as "Corrected hardware errors ... medium", i.e. it filed a lost bit
// as a routine correction. Here the same line must now be high.
test("hardware: an uncorrected (UE) memory error is high, not medium", async () => {
  const ctx = stubCtx({
    "command -v journalctl 2>/dev/null": "/usr/bin/journalctl\n",
    'journalctl -k --since "-7 days" --no-pager -o short 2>/dev/null | grep -iE "mce|machine check|hardware error|edac|corrected error|ecc error"': "Aug 14 09:41:05 bazzite kernel: EDAC mc0: UE row 2, channel-a 0\n",
  });
  const findings = await hardware.run(ctx);
  const high = findings.filter((f) => f.severity === "high");
  assert.equal(high.length, 1);
  assert.equal(high[0].code, "hardware/ecc");
  assert.match(high[0].title, /Uncorrected memory errors/);
  assert.match(high[0].evidence, /UE/);
});

test("hardware: clean kernel log is informational", async () => {
  const ctx = stubCtx({
    "command -v journalctl 2>/dev/null": "/usr/bin/journalctl\n",
    "command -v journalctl 2>/dev/null": "/usr/bin/journalctl\n",
    'journalctl -k --since "-7 days" --no-pager -o short 2>/dev/null | grep -iE "mce|machine check|hardware error|edac|corrected error|ecc error"': "",
  });
  const findings = await hardware.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /No hardware errors/);
});

test("hardware: a readable log with no matches is 'no errors', not silence", async () => {
  // `journalctl -k ... | grep ...` exits 1 when nothing matches, so `.ok` meant
  // "grep found nothing", not "I could not read the log". On a healthy machine
  // with no MCE/EDAC line at all, the check said nothing instead of reporting
  // "No hardware errors logged". (A benign EDAC banner made grep exit 0 on the
  // maintainer's box, which hid this.)
  const ctx = stubCtx({
    "command -v journalctl 2>/dev/null": "/usr/bin/journalctl\n",
    // the grep itself is left unstubbed: it fails with no output, exactly like
    // the real command when nothing matches
  });
  const findings = await hardware.run(ctx);
  assert.equal(findings.length, 1, `a readable log must produce an answer: ${JSON.stringify(findings.map((f) => f.code))}`);
  assert.equal(findings[0].code, "hardware/ok");
});

test("hardware: boot separators alone are NOT hardware errors", async () => {
  // journalctl -k -g prints "-- Boot ... --" separators even with no matches.
  const ctx = stubCtx({
    "command -v journalctl 2>/dev/null": "/usr/bin/journalctl\n",
    'journalctl -k --since "-7 days" --no-pager -o short 2>/dev/null | grep -iE "mce|machine check|hardware error|edac|corrected error|ecc error"': "",
    "command -v journalctl 2>/dev/null": "/usr/bin/journalctl\n",
    'journalctl -k --since "-7 days" --no-pager -o short 2>/dev/null | grep -iE "mce|machine check|hardware error|edac|corrected error|ecc error"': "",
  });
  const findings = await hardware.run(ctx);
  assert.ok(!findings.some((f) => f.severity === "high" || f.severity === "medium"), "separator-only output must not be an error finding");
});

// Regression: "mce: CPU supports N MCE banks" is printed once per CPU at boot
// on every Intel machine. A bare /mce/ match read it as a machine check
// exception, i.e. a permanent high finding on healthy hardware.
test("hardware: the MCE banks boot line is not a machine check exception", async () => {
  const ctx = stubCtx({
    "command -v journalctl 2>/dev/null": "/usr/bin/journalctl\n",
    "command -v journalctl 2>/dev/null": "/usr/bin/journalctl\n",
    'journalctl -k --since "-7 days" --no-pager -o short 2>/dev/null | grep -iE "mce|machine check|hardware error|edac|corrected error|ecc error"': [
      "Aug 13 03:11:22 bazzite kernel: mce: CPU supports 32 MCE banks",
      "Aug 13 03:11:22 bazzite kernel: mce: CPU supports 32 MCE banks",
      "Aug 13 03:11:22 bazzite kernel: EDAC MC: Ver: 3.0.0",
      "Aug 13 03:11:22 bazzite kernel: EDAC ie31200: No ECC support",
    ].join("\n") + "\n",
  });
  const findings = await hardware.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "hardware/ok", "routine MCE/EDAC init lines must not be a hardware fault");
  assert.equal(findings[0].severity, "info");
});

test("hardware: a single corrected (CE) memory error is routine, not a penalty", async () => {
  // One corrected bit flip over seven days is ECC doing its job. Reporting it
  // at medium made the score drop for normal operation, which is how a report
  // teaches people to stop reading it. It is still shown, as a note to watch.
  const ctx = stubCtx({
    "command -v journalctl 2>/dev/null": "/usr/bin/journalctl\n",
    'journalctl -k --since "-7 days" --no-pager -o short 2>/dev/null | grep -iE "mce|machine check|hardware error|edac|corrected error|ecc error"': "Aug 14 09:41:05 bazzite kernel: EDAC MC0: 1 CE memory read error on CPU_SrcID#0_MC#0_Chan#0_DIMM#0\n",
  });
  const findings = await hardware.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "hardware/ecc");
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /corrected/i);
  assert.equal(findings[0].fix, null, "a routine correction is not an action");
});

test("hardware: repeated corrected (CE) memory errors are a medium finding", async () => {
  // "Occasional ones are normal, but frequent ones suggest a DIMM is starting
  // to fail" — the check's own words. Two in a week is no longer occasional.
  const ctx = stubCtx({
    "command -v journalctl 2>/dev/null": "/usr/bin/journalctl\n",
    'journalctl -k --since "-7 days" --no-pager -o short 2>/dev/null | grep -iE "mce|machine check|hardware error|edac|corrected error|ecc error"': [
      "Aug 14 09:41:05 bazzite kernel: EDAC MC0: 1 CE memory read error on CPU_SrcID#0_MC#0_Chan#0_DIMM#0",
      "Aug 15 11:02:44 bazzite kernel: EDAC MC0: 1 CE memory read error on CPU_SrcID#0_MC#0_Chan#0_DIMM#0",
    ].join("\n") + "\n",
  });
  const findings = await hardware.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "hardware/ecc");
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].fix, /Memtest/i);
});

test("luks: encrypted system is informational", async () => {
  const ctx = stubCtx({
    "lsblk -o NAME,FSTYPE,TYPE -n 2>/dev/null": "sda2 crypto_LUKS part\nluks-fedora crypto_LUKS crypt\n",
  });
  const findings = await luks.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /encryption is active/);
});

test("luks: unencrypted system is informational", async () => {
  const ctx = stubCtx({
    "lsblk -o NAME,FSTYPE,TYPE -n 2>/dev/null": "sda1 vfat part\nsda2 ext4 part\n",
  });
  const findings = await luks.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info", "unencrypted is a setup choice, not a detected fault");
  assert.match(findings[0].title, /No full-disk encryption/);
  assert.ok(findings[0].fix, "missing encryption should include a fix");
});

test("luks: no lsblk stays silent", async () => {
  const ctx = {
    osRelease: { id: "bazzite", id_like: "fedora" },
    dist: detectDistro({ id: "bazzite", id_like: "fedora" }),
    run: async () => ({ ok: false, code: -1, stdout: "", stderr: "", missing: true }),
  };
  const findings = await luks.run(ctx);
  assert.equal(findings.length, 0);
});

test("network: no default route is medium", async () => {
  const ctx = stubCtx({
    "command -v ip 2>/dev/null": "/usr/sbin/ip\n",
    "ip -brief addr show 2>/dev/null": "lo               UNKNOWN        127.0.0.1/8 ::1/128\nwlan0            UP             192.168.1.5/24\n",
    "ip route show default 2>/dev/null": "",
  });
  const findings = await network.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].title, /No default network route/);
  assert.match(findings[0].detail, /wlan0/);
  assert.ok(findings[0].fix);
});

test("network: DNS failure is medium when a route exists", async () => {
  const ctx = stubCtx({
    "command -v ip 2>/dev/null": "/usr/sbin/ip\n",
    "ip -brief addr show 2>/dev/null": "wlan0            UP             192.168.1.5/24\n",
    "ip route show default 2>/dev/null": "default via 192.168.1.1 dev wlan0 proto dhcp metric 600\n",
    "getent ahostsv4 kernel.org 2>&1 | head -1": "",
  });
  const findings = await network.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].title, /DNS resolution is failing/);
  assert.ok(findings[0].fix);
});

test("network: route + working DNS is informational", async () => {
  const ctx = stubCtx({
    "command -v ip 2>/dev/null": "/usr/sbin/ip\n",
    "ip -brief addr show 2>/dev/null": "wlan0            UP             192.168.1.5/24\n",
    "ip route show default 2>/dev/null": "default via 192.168.1.1 dev wlan0 proto dhcp metric 600\n",
    "getent ahostsv4 kernel.org 2>&1 | head -1": "151.101.1.69     STREAM kernel.org\n",
  });
  const findings = await network.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /Network and DNS look healthy/);
});

test("network: missing iproute2 is an explicit skip, not silence", async () => {
  const ctx = {
    osRelease: { id: "bazzite", id_like: "fedora" },
    dist: detectDistro({ id: "bazzite", id_like: "fedora" }),
    run: async () => ({ ok: false, code: -1, stdout: "", stderr: "", missing: true }),
  };
  const findings = await network.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /network check skipped/i);
});

test("reboot: newer installed kernel than booted is medium", async () => {
  const ctx = stubCtx({
    "uname -r 2>/dev/null": "6.8.9-300.fc40.x86_64\n",
    "for f in /boot/vmlinuz-*; do readlink -f \"$f\"; done 2>/dev/null | sort -u | sed 's|.*/vmlinuz-||'": "6.8.9-300.fc40.x86_64\n6.9.12-200.fc40.x86_64\n",
    "[ -f /var/run/reboot-required ] && cat /var/run/reboot-required 2>/dev/null": "",
  }, { id: "fedora", id_like: "fedora" });
  const findings = await reboot.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].title, /reboot is required/i);
  assert.match(findings[0].evidence, /6\.9\.12/);
  assert.ok(findings[0].fix);
});

test("reboot: /var/run/reboot-required alone is medium", async () => {
  const ctx = stubCtx({
    "uname -r 2>/dev/null": "6.8.9-300.fc40.x86_64\n",
    "for f in /boot/vmlinuz-*; do readlink -f \"$f\"; done 2>/dev/null | sort -u | sed 's|.*/vmlinuz-||'": "6.8.9-300.fc40.x86_64\n",
    "[ -f /var/run/reboot-required ] && cat /var/run/reboot-required 2>/dev/null": "*** System restart required ***\n",
  }, { id: "debian", id_like: "" });
  const findings = await reboot.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].detail, /reboot-required/);
});

test("reboot: newest kernel already booted is informational", async () => {
  const ctx = stubCtx({
    "uname -r 2>/dev/null": "6.9.12-200.fc40.x86_64\n",
    "for f in /boot/vmlinuz-*; do readlink -f \"$f\"; done 2>/dev/null | sort -u | sed 's|.*/vmlinuz-||'": "6.9.12-200.fc40.x86_64\n",
    "[ -f /var/run/reboot-required ] && cat /var/run/reboot-required 2>/dev/null": "",
  }, { id: "fedora", id_like: "fedora" });
  const findings = await reboot.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /No reboot needed/);
});

test("reboot: image-based (ostree) distros stay silent", async () => {
  const ctx = stubCtx({
    "uname -r 2>/dev/null": "6.8.9-300.fc40.x86_64\n",
  });
  const findings = await reboot.run(ctx);
  assert.equal(findings.length, 0);
});

test("reboot: versionGt compares kernel versions numerically", () => {
  assert.equal(versionGt("6.9.12-200.fc40.x86_64", "6.8.9-300.fc40.x86_64"), true);
  assert.equal(versionGt("6.8.9-300.fc40.x86_64", "6.9.12-200.fc40.x86_64"), false);
  assert.equal(versionGt("6.8.9", "6.8.9"), false);
  assert.equal(versionGt("6.1.0-28-amd64", "6.1.0-26-amd64"), true);
});

test("journald: large journal is medium", async () => {
  const ctx = stubCtx({
    "journalctl --disk-usage 2>/dev/null": "Archived and active journals take up 3.2G in the file system.\n",
  });
  const findings = await journald.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].title, /journal is large/i);
  assert.match(findings[0].fix, /vacuum/);
});

test("journald: small journal is informational", async () => {
  const ctx = stubCtx({
    "journalctl --disk-usage 2>/dev/null": "Archived and active journals take up 18.2M in the file system.\n",
  });
  const findings = await journald.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /Journal size is fine/);
});

test("journald: no systemd journal is an explicit skip, not silence", async () => {
  const ctx = {
    osRelease: { id: "bazzite", id_like: "fedora" },
    dist: detectDistro({ id: "bazzite", id_like: "fedora" }),
    run: async () => ({ ok: false, code: -1, stdout: "", stderr: "", missing: true }),
  };
  const findings = await journald.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /journal size check skipped/i);
});

test("journald: parseSize handles units", () => {
  assert.equal(parseSize("512.0M"), 512 * 1024 ** 2);
  assert.equal(parseSize("3.2G"), Math.round(3.2 * 1024 ** 3));
  assert.equal(parseSize("1024B"), 1024);
  assert.equal(parseSize("garbage"), 0);
});

test("smart: failing drive is high", async () => {
  const ctx = stubCtx({
    "smartctl --scan 2>/dev/null": "/dev/sda -d scsi # /dev/sda, SCSI device\n",
    "smartctl -H -c /dev/sda 2>/dev/null": "SMART overall-health self-assessment test result: FAILED!\n",
  });
  const findings = await smart.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "high");
  assert.match(findings[0].title, /failing SMART health/);
  assert.ok(findings[0].fix);
});

test("smart: healthy drives are informational", async () => {
  const ctx = stubCtx({
    "smartctl --scan 2>/dev/null": "/dev/sda -d scsi # /dev/sda, SCSI device\n/dev/nvme0 -d nvme # /dev/nvme0, NVMe device\n",
    "smartctl -H -c /dev/sda 2>/dev/null": "SMART overall-health self-assessment test result: PASSED\n",
    "smartctl -H -c /dev/nvme0 2>/dev/null": "SMART overall-health self-assessment test result: PASSED\n",
  });
  const findings = await smart.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /Disk health is good/);
  assert.match(findings[0].detail, /2 disk/);
});

test("smart: smartctl not installed is an explicit skip, not silence", async () => {
  const ctx = {
    osRelease: { id: "bazzite", id_like: "fedora" },
    dist: detectDistro({ id: "bazzite", id_like: "fedora" }),
    run: async () => ({ ok: false, code: -1, stdout: "", stderr: "", missing: true }),
  };
  const findings = await smart.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /smartmontools missing/i);
});

// systemd pads header and rows to the same fixed columns, so the parser
// slices by the header's column offsets. Rows are built with matching widths
// (short values glue to the next column with a single space, like real output).
const timerRow = (next, left, last, passed, unit, activates) =>
  [next.padEnd(34), left.padEnd(11), last.padEnd(34), passed.padEnd(12), unit.padEnd(28), activates].join("");
const TIMER_HEADER = timerRow("NEXT", "LEFT", "LAST", "PASSED", "UNIT", "ACTIVATES");

test("timers: an enabled timer that never fires is medium", async () => {
  const ctx = stubCtx({
    "systemctl list-timers --all --no-pager --plain 2>/dev/null":
      TIMER_HEADER + "\n" +
      timerRow("Mon 2026-08-18 19:00:00 EEST", "1h 30min left", "Mon 2026-08-18 08:00:00 EEST", "9h ago", "dnf-makecache.timer", "dnf-makecache.service") + "\n" +
      timerRow("-", "n/a", "-", "n/a", "borg-backup.timer", "borg-backup.service") + "\n\n2 timers listed.",
    "systemctl is-enabled borg-backup.timer 2>/dev/null": "enabled\n",
  });
  const findings = await timers.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].title, /enabled but never running/);
  assert.match(findings[0].evidence, /borg-backup\.timer/);
  assert.ok(findings[0].fix);
});

test("timers: disabled timers showing '-' are NOT broken", async () => {
  const ctx = stubCtx({
    "systemctl list-timers --all --no-pager --plain 2>/dev/null":
      TIMER_HEADER + "\n" + timerRow("-", "n/a", "-", "n/a", "old-thing.timer", "old-thing.service") + "\n",
    "systemctl is-enabled old-thing.timer 2>/dev/null": "disabled\n",
  });
  const findings = await timers.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /healthy/);
});

test("timers: healthy timers are informational", async () => {
  const ctx = stubCtx({
    "systemctl list-timers --all --no-pager --plain 2>/dev/null":
      TIMER_HEADER + "\n" +
      timerRow("Mon 2026-08-18 19:00:00 EEST", "1h 30min left", "Mon 2026-08-18 08:00:00 EEST", "9h ago", "dnf-makecache.timer", "dnf-makecache.service") + "\n\n1 timers listed.",
  });
  const findings = await timers.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /healthy/);
});

test("timers: non-systemd stays silent", async () => {
  const ctx = {
    osRelease: { id: "alpine", id_like: "" },
    dist: detectDistro({ id: "alpine", id_like: "" }),
    thresholds: loadThresholds({}),
    run: async () => ({ ok: false, code: -1, stdout: "", stderr: "", missing: true }),
  };
  const findings = await timers.run(ctx);
  assert.equal(findings.length, 1, `a non-systemd system is an explicit skip: ${JSON.stringify(findings.map((f) => f.code))}`);
  assert.equal(findings[0].code, "timers/skipped");
});

test("ntp: synchronized clock is informational", async () => {
  const ctx = stubCtx({
    "timedatectl show -p NTPSynchronized 2>/dev/null": "NTPSynchronized=yes\n",
  });
  const findings = await ntp.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /synchronized/);
});

test("ntp: no NTP daemon is medium", async () => {
  const ctx = stubCtx({
    "timedatectl show -p NTPSynchronized 2>/dev/null": "NTPSynchronized=no\n",
    "systemctl is-active systemd-timesyncd chronyd ntpd 2>/dev/null || true": "inactive\ninactive\ninactive\n",
  });
  const findings = await ntp.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].title, /not kept in sync/);
  assert.ok(findings[0].fix);
});

test("ntp: daemon active but unsynchronized is medium", async () => {
  const ctx = stubCtx({
    "timedatectl show -p NTPSynchronized 2>/dev/null": "NTPSynchronized=no\n",
    "systemctl is-active systemd-timesyncd chronyd ntpd 2>/dev/null || true": "active\n",
  });
  const findings = await ntp.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].title, /not synchronized yet/);
});

test("ntp: no timedatectl (non-systemd) is an explicit skip, not silence", async () => {
  const ctx = {
    osRelease: { id: "alpine", id_like: "" },
    dist: detectDistro({ id: "alpine", id_like: "" }),
    thresholds: loadThresholds({}),
    run: async () => ({ ok: false, code: -1, stdout: "", stderr: "", missing: true }),
  };
  const findings = await ntp.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /time sync check skipped/i);
});

test("battery: heavy wear is medium", async () => {
  const ctx = stubCtx({
    "ls /sys/class/power_supply/ 2>/dev/null": "AC\nBAT0\n",
    "cat /sys/class/power_supply/BAT0/type 2>/dev/null": "Battery\n",
    "cat /sys/class/power_supply/BAT0/capacity 2>/dev/null": "60\n",
    "cat /sys/class/power_supply/BAT0/status 2>/dev/null": "Discharging\n",
    "cat /sys/class/power_supply/BAT0/charge_full 2>/dev/null": "3000000\n",
    "cat /sys/class/power_supply/BAT0/charge_full_design 2>/dev/null": "5000000\n",
  });
  const findings = await battery.run(ctx);
  const wear = findings.find((f) => /lost a lot of capacity/.test(f.title));
  assert.ok(wear, "expected a wear finding");
  assert.equal(wear.severity, "medium");
  assert.match(wear.evidence, /40% wear/);
});

test("battery: moderate wear is informational", async () => {
  const ctx = stubCtx({
    "ls /sys/class/power_supply/ 2>/dev/null": "AC\nBAT0\n",
    "cat /sys/class/power_supply/BAT0/type 2>/dev/null": "Battery\n",
    "cat /sys/class/power_supply/BAT0/capacity 2>/dev/null": "87\n",
    "cat /sys/class/power_supply/BAT0/status 2>/dev/null": "Charging\n",
    "cat /sys/class/power_supply/BAT0/charge_full 2>/dev/null": "4000000\n",
    "cat /sys/class/power_supply/BAT0/charge_full_design 2>/dev/null": "5000000\n",
  });
  const findings = await battery.run(ctx);
  const wear = findings.find((f) => /showing wear/.test(f.title));
  assert.ok(wear, "expected a wear info finding");
  assert.equal(wear.severity, "info");
});

test("battery: no wear data produces no wear finding", async () => {
  const ctx = stubCtx({
    "ls /sys/class/power_supply/ 2>/dev/null": "AC\nBAT0\n",
    "cat /sys/class/power_supply/BAT0/type 2>/dev/null": "Battery\n",
    "cat /sys/class/power_supply/BAT0/capacity 2>/dev/null": "87\n",
    "cat /sys/class/power_supply/BAT0/status 2>/dev/null": "Charging\n",
  });
  const findings = await battery.run(ctx);
  assert.equal(findings.length, 1, "only the status finding, no wear");
  assert.equal(findings[0].severity, "info");
});

test("smart: unreadable devices without root are explained, not silent", async () => {
  const ctx = {
    osRelease: { id: "bazzite", id_like: "fedora" },
    dist: detectDistro({ id: "bazzite", id_like: "fedora" }),
    run: async (cmd) => {
      if (cmd === "smartctl --scan 2>/dev/null") return { ok: true, code: 0, stdout: "/dev/sda -d scsi # /dev/sda, SCSI device\n", stderr: "" };
      if (cmd.startsWith("smartctl -H -c")) return { ok: false, code: 4, stdout: "", stderr: "smartctl: Permission denied\n" };
      return { ok: false, code: 1, stdout: "", stderr: "" };
    },
  };
  const findings = await smart.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /needs root/);
});

test("memory: missing free is an explicit skip, not a silent all-clear", async () => {
  const ctx = stubCtx({});
  ctx.run = async () => ({ ok: false, code: -1, stdout: "", stderr: "", missing: true });
  const findings = await memory.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /memory check skipped/i);
});

test("ntp: missing timedatectl (non-systemd) is an explicit skip", async () => {
  const ctx = stubCtx({});
  ctx.run = async () => ({ ok: false, code: -1, stdout: "", stderr: "", missing: true });
  const findings = await ntp.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /time sync check skipped/i);
});

test("updates: package manager missing is an explicit skip, not silence", async () => {
  const ctx = stubCtx({});
  ctx.osRelease = { id: "debian", id_like: "" };
  ctx.dist = detectDistro(ctx.osRelease);
  ctx.run = async () => ({ ok: false, code: -1, stdout: "", stderr: "", missing: true });
  const findings = await updates.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /update check skipped/i);
});

test("smart: missing smartctl is an explicit skip with an install hint", async () => {
  const ctx = stubCtx({});
  ctx.run = async () => ({ ok: false, code: -1, stdout: "", stderr: "", missing: true });
  const findings = await smart.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /smartmontools missing/i);
  assert.match(findings[0].fix, /smartmontools/);
});

test("thermal: no thermal zones is an explicit skip", async () => {
  const ctx = stubCtx({});
  const findings = await thermal.run(ctx);
  assert.ok(findings.some((f) => /temperature check skipped/i.test(f.title)), "explains why temperatures are unknown");
});

test("audio: no sound server running is a medium finding with a distro-aware fix", async () => {
  const ctx = {
    osRelease: { id: "fedora", id_like: "fedora" },
    dist: detectDistro({ id: "fedora", id_like: "fedora" }),
    thresholds: {},
    run: async () => ({ ok: true, code: 0, stdout: "down\n", stderr: "" }),
  };
  const findings = await audio.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].title, /No sound server is running/);
  assert.match(findings[0].fix, /dnf install pipewire/);
});

test("audio: server up with a real sink is healthy; dummy sink is not", async () => {
  const makeCtx = (sinksOut) => ({
    osRelease: { id: "ubuntu", id_like: "debian" },
    dist: detectDistro({ id: "ubuntu", id_like: "debian" }),
    thresholds: {},
    run: async (cmd) => {
      if (cmd.includes("pgrep -x pipewire")) return { ok: true, code: 0, stdout: "up\n", stderr: "" };
      if (cmd.includes("command -v pactl")) return { ok: true, code: 0, stdout: "yes\n", stderr: "" };
      if (cmd.includes("pactl list sinks short")) return { ok: true, code: 0, stdout: sinksOut, stderr: "" };
      return { ok: true, code: 0, stdout: "down\n", stderr: "" };
    },
  });
  const healthy = await audio.run(makeCtx("0\talsa_output.pci-0000_00_1f.3.analog-stereo\tRUNNING\n"));
  assert.equal(healthy.length, 1);
  assert.match(healthy[0].title, /Audio is working/);
  assert.equal(healthy[0].severity, "info");

  const dummy = await audio.run(makeCtx("0\tauto_null\tRUNNING\n"));
  assert.equal(dummy.length, 1);
  assert.equal(dummy[0].severity, "medium");
  assert.match(dummy[0].title, /No audio output device detected/);
});

test("containers: no runtime installed is informational with an install hint", async () => {
  const ctx = {
    osRelease: { id: "debian", id_like: "" },
    dist: detectDistro({ id: "debian", id_like: "" }),
    thresholds: {},
    run: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
  };
  const findings = await containers.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /No container runtime installed/);
  assert.match(findings[0].fix, /apt install podman/);
});

test("containers: docker installed but daemon stopped is medium", async () => {
  const ctx = {
    osRelease: { id: "fedora", id_like: "fedora" },
    dist: detectDistro({ id: "fedora", id_like: "fedora" }),
    thresholds: {},
    run: async (cmd) => {
      if (cmd === "command -v podman 2>/dev/null") return { ok: false, code: 1, stdout: "", stderr: "" };
      if (cmd === "command -v docker 2>/dev/null") return { ok: true, code: 0, stdout: "/usr/bin/docker\n", stderr: "" };
      if (cmd.startsWith("systemctl is-active docker")) return { ok: true, code: 0, stdout: "inactive\n", stderr: "" };
      return { ok: false, code: 1, stdout: "", stderr: "" };
    },
  };
  const findings = await containers.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].title, /Docker daemon is not running/);
  assert.match(findings[0].fix, /systemctl enable --now docker/);
});

test("containers: podman usable is reported healthy", async () => {
  const ctx = {
    osRelease: { id: "bazzite", id_like: "fedora" },
    dist: detectDistro({ id: "bazzite", id_like: "fedora" }),
    thresholds: {},
    run: async (cmd) => {
      if (cmd === "command -v podman 2>/dev/null") return { ok: true, code: 0, stdout: "/usr/bin/podman\n", stderr: "" };
      if (cmd === "command -v docker 2>/dev/null") return { ok: false, code: 1, stdout: "", stderr: "" };
      if (cmd.startsWith("podman info")) return { ok: true, code: 0, stdout: "ok\n", stderr: "" };
      return { ok: false, code: 1, stdout: "", stderr: "" };
    },
  };
  const findings = await containers.run(ctx);
  assert.equal(findings.length, 1);
  assert.match(findings[0].title, /Container runtimes are ready/);
});

test("containerdisk: large podman image storage is flagged medium", async () => {
  const ctx = stubCtx({});
  ctx.thresholds = { containerWarnGB: 20, containerHighGB: 50 };
  ctx.run = async (cmd) => {
    if (cmd === "podman system df 2>/dev/null") return { ok: true, code: 0, stdout: "TYPE           TOTAL   ACTIVE  SIZE      RECLAIMABLE\nImages             25      3    25.0GB    22.0GB (88%)\nContainers         4      1     150MB     100MB (66%)\nLocal Volumes      3      1     200MB      50MB (25%)\n", stderr: "" };
    return { ok: false, code: 1, stdout: "", stderr: "" };
  };
  const findings = await containerdisk.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].title, /25\.0 GB/);
});

test("containerdisk: no runtime installed is an info skip", async () => {
  const ctx = stubCtx({});
  ctx.thresholds = { containerWarnGB: 20, containerHighGB: 50 };
  const findings = await containerdisk.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].title, /container storage check skipped/i);
});

test("crash: many reboots in a week is flagged", async () => {
  const ctx = stubCtx({});
  ctx.run = async (cmd) => {
    if (cmd.includes("--list-boots")) {
      const lines = JSON.stringify(Array.from({ length: 25 }, (_, i) => ({ index: -i, boot_id: "b" + i, first_entry: (Date.now() - i * 60000) * 1000, last_entry: (Date.now() - i * 60000) * 1000 })));
      return { ok: true, code: 0, stdout: lines + "\n", stderr: "" };
    }
    if (cmd.includes("coredumpctl")) return { ok: false, code: 1, stdout: "", stderr: "" };
    return { ok: false, code: 1, stdout: "", stderr: "" };
  };
  const findings = await crash.run(ctx);
  assert.ok(findings.length > 0, "expected at least one finding");
  assert.match(findings[0].title, /reboot/i);
  assert.equal(findings[0].severity, "high");
});

// Regression: "Intel machine check reporting enabled on CPU#N" is a per-CPU boot
// banner on Intel machines and it matches the crash grep's "machine check"
// alternative. A reboot-heavy Intel box therefore reported crash/panic (high)
// with a boot banner as its evidence. The hardware check already rejects that
// line; the crash check now defers to the same classifier.
test("crash: the Intel machine-check boot banner is not a kernel panic", async () => {
  const ctx = stubCtx({});
  ctx.run = async (cmd) => {
    if (cmd.includes("--list-boots")) {
      const boots = JSON.stringify(
        Array.from({ length: 25 }, (_, i) => ({ index: -i, boot_id: "b" + i, first_entry: (Date.now() - i * 60000) * 1000, last_entry: (Date.now() - i * 60000) * 1000 })),
      );
      return { ok: true, code: 0, stdout: boots + "\n", stderr: "" };
    }
    if (cmd.includes("coredumpctl")) return { ok: false, code: 1, stdout: "", stderr: "" };
    if (cmd.includes("journalctl -k")) {
      return { ok: true, code: 0, stdout: "Aug 13 03:11:22 host kernel: mce: Machine check reporting enabled on CPU#0\n", stderr: "" };
    }
    return { ok: false, code: 1, stdout: "", stderr: "" };
  };
  const findings = await crash.run(ctx);
  assert.ok(
    !findings.some((f) => f.code === "crash/panic"),
    "a boot banner must not be reported as a kernel panic",
  );
});

test("crash: many reboots explained by an auto-update mechanism are not alarming", async () => {
  const ctx = stubCtx({});
  ctx.run = async (cmd) => {
    if (cmd.includes("--list-boots")) {
      const l = JSON.stringify(Array.from({ length: 25 }, (_, i) => ({ index: -i, boot_id: "b" + i, first_entry: (Date.now() - i * 60000) * 1000, last_entry: (Date.now() - i * 60000) * 1000 })));
      return { ok: true, code: 0, stdout: l + "\n", stderr: "" };
    }
    if (cmd.includes("journalctl -k")) return { ok: true, code: 0, stdout: "", stderr: "" };
    if (cmd.includes("systemctl list-timers")) return { ok: true, code: 0, stdout: "  uupd.timer ...\n", stderr: "" };
    if (cmd.includes("command -v uupd")) return { ok: true, code: 0, stdout: "/usr/bin/uupd\n/usr/bin/rpm-ostree\n", stderr: "" };
    if (cmd.includes("coredumpctl")) return { ok: false, code: 1, stdout: "", stderr: "" };
    return { ok: false, code: 1, stdout: "", stderr: "" };
  };
  const findings = await crash.run(ctx);
  assert.equal(findings.length, 1);
  assert.notEqual(findings[0].severity, "high");
  assert.match(findings[0].title, /reboot/i);
  assert.match(findings[0].detail, /automatic updates/);
});

test("crash: a real kernel panic is high even when an auto-update mechanism exists", async () => {
  const ctx = stubCtx({});
  ctx.run = async (cmd) => {
    if (cmd.includes("--list-boots")) {
      const l = JSON.stringify(Array.from({ length: 25 }, (_, i) => ({ index: -i, boot_id: "b" + i, first_entry: (Date.now() - i * 60000) * 1000, last_entry: (Date.now() - i * 60000) * 1000 })));
      return { ok: true, code: 0, stdout: l + "\n", stderr: "" };
    }
    if (cmd.includes("journalctl -k")) return { ok: true, code: 0, stdout: "Aug 19 10:00:00 host kernel: Kernel panic - not syncing: Fatal exception\n", stderr: "" };
    if (cmd.includes("systemctl list-timers")) return { ok: true, code: 0, stdout: "  uupd.timer ...\n", stderr: "" };
    if (cmd.includes("coredumpctl")) return { ok: false, code: 1, stdout: "", stderr: "" };
    return { ok: false, code: 1, stdout: "", stderr: "" };
  };
  const findings = await crash.run(ctx);
  const panic = findings.find((f) => f.code === "crash/panic");
  assert.ok(panic, "expected a panic finding");
  assert.equal(panic.severity, "high");
  assert.match(panic.evidence, /Kernel panic/);
});

test("crash: coredumps are reported", async () => {
  const ctx = stubCtx({});
  ctx.run = async (cmd) => {
    if (cmd.includes("--list-boots")) return { ok: true, code: 0, stdout: "  0  ...\n", stderr: "" };
    if (cmd.includes("coredumpctl")) return { ok: true, code: 0, stdout: "TIME                          PID   UID   GID   SIG     EXE\nMon 2026-08-18 10:00:00      1234  1000  1000  SIGSEGV  /usr/bin/foo\nMon 2026-08-18 11:00:00      5678  1000  1000  SIGABRT  /usr/bin/bar\n", stderr: "" };
    return { ok: false, code: 1, stdout: "", stderr: "" };
  };
  const findings = await crash.run(ctx);
  assert.ok(findings.some((f) => /crash/i.test(f.title)), "expected a crash finding");
});

// Trust budget: SIGTRAP cores come from debuggers/ptrace (gdb, emulators) —
// an intentional signal, not a crash. Pinned here so a future refactor cannot
// silently turn a gdb session into a "your system is crashing" finding.
test("crash: SIGTRAP coredumps (debuggers/emulators) are NOT crashes", async () => {
  const ctx = stubCtx({});
  ctx.run = async (cmd) => {
    if (cmd.includes("--list-boots")) return { ok: true, code: 0, stdout: "  0  ...\n", stderr: "" };
    if (cmd.includes("coredumpctl")) return { ok: true, code: 0, stdout: "TIME                          PID   UID   GID   SIG     EXE\nMon 2026-08-18 10:00:00      1234  1000  1000  SIGTRAP  /usr/bin/gdb\nMon 2026-08-18 10:05:00      1235  1000  1000  SIGTRAP  /usr/bin/qemu-system-x86\n", stderr: "" };
    return { ok: false, code: 1, stdout: "", stderr: "" };
  };
  const findings = await crash.run(ctx);
  assert.ok(!findings.some((f) => /crash/i.test(f.title)), "debugger SIGTRAP cores must not be reported as crashes");
});

test("crash: real crash signals (SIGSEGV/SIGABRT/SIGBUS) are still crashes", async () => {
  const ctx = stubCtx({});
  ctx.run = async (cmd) => {
    if (cmd.includes("--list-boots")) return { ok: true, code: 0, stdout: "  0  ...\n", stderr: "" };
    if (cmd.includes("coredumpctl")) return { ok: true, code: 0, stdout: "TIME                          PID   UID   GID   SIG     EXE\nMon 2026-08-18 10:00:00      1234  1000  1000  SIGSEGV  /usr/bin/foo\nMon 2026-08-18 10:02:00      1235  1000  1000  SIGBUS   /usr/bin/bar\nMon 2026-08-18 10:04:00      1236  1000  1000  SIGABRT  /usr/bin/baz\n", stderr: "" };
    return { ok: false, code: 1, stdout: "", stderr: "" };
  };
  const findings = await crash.run(ctx);
  const finding = findings.find((f) => /crash/i.test(f.title));
  assert.ok(finding, "expected a crash finding for real signals");
  assert.doesNotMatch(finding.evidence, /SIGTRAP/, "SIGTRAP cores must not appear in crash evidence");
  assert.match(finding.evidence, /SIGBUS|SIGSEGV/, "real crash signals must remain visible");
});

test("stable codes: every built-in check emits findings with an explicit code", async () => {
  for (const check of checks) {
    const findings = await check.run(stubCtx({}));
    for (const f of findings) {
      assert.ok(
        typeof f.code === "string" && f.code.length > 0,
        `${check.id} finding "${f.title}" must carry a stable code`
      );
    }
  }
});

test("stable codes: every built-in findings.push block declares a code", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "checks");
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".js")) continue;
    const src = readFileSync(join(dir, file), "utf8");
    const re = /findings\.push\(\{([\s\S]*?)\}\);/g;
    let m;
    while ((m = re.exec(src))) {
      if (/severity:/.test(m[1]) && !/code:/.test(m[1])) {
        assert.fail(`${file}: findings.push block without a code`);
      }
    }
  }
});

// Real smartctl exits non-zero when the drive is FAILING (status bit 3), so
// the health string must be read before the !ok branch — otherwise a dying
// disk is silently skipped.
test("smart: FAILED health with a non-zero smartctl exit is still reported", async () => {
  const ctx = stubCtx({});
  ctx.run = async (cmd) => {
    if (cmd === "smartctl --scan 2>/dev/null") return { ok: true, code: 0, stdout: "/dev/sda -d scsi # /dev/sda\n", stderr: "" };
    if (cmd.includes("smartctl -H -c")) return { ok: false, code: 8, stdout: "SMART overall-health self-assessment test result: FAILED!\n", stderr: "" };
    return { ok: false, code: 1, stdout: "", stderr: "" };
  };
  const findings = await smart.run(ctx);
  const failing = findings.find((f) => f.code === "smart/failing");
  assert.ok(failing, "a failing disk must be reported even when smartctl exits non-zero");
  assert.equal(failing.severity, "high");
});

test("crash: many boots outside the window are not flagged", async () => {
  const ctx = stubCtx({});
  ctx.run = async (cmd) => {
    if (cmd.includes("--list-boots")) {
      const old = Array.from({ length: 25 }, (_, i) => ({
        index: -i,
        boot_id: "b" + i,
        first_entry: (Date.now() - (30 + i) * 86400000) * 1000,
        last_entry: (Date.now() - (30 + i) * 86400000) * 1000,
      }));
      return { ok: true, code: 0, stdout: JSON.stringify(old), stderr: "" };
    }
    return { ok: false, code: 1, stdout: "", stderr: "" };
  };
  const findings = await crash.run(ctx);
  assert.ok(!findings.some((f) => /reboot/i.test(f.title)), "lifetime boot count must not be reported as recent reboots");
});

test("network: missing getent is a skip, not a false DNS failure", async () => {
  const ctx = stubCtx({
    "ip route show default 2>/dev/null": "default via 192.168.1.1 dev wlan0\n",
    "getent ahostsv4 kernel.org 2>&1 | head -1": "/bin/sh: 1: getent: not found\n",
  });
  const findings = await network.run(ctx);
  const skip = findings.find((f) => f.code === "network/skipped");
  assert.ok(skip, "expected a network/skipped finding");
  assert.equal(skip.severity, "info");
  assert.ok(!findings.some((f) => f.code === "network/dns"), "must not claim DNS is failing when getent is absent");
});

test("disk: an unusable df is an explicit skip, not silence", async () => {
  const findings = await disk.run(stubCtx({}));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "disk/skipped");
  assert.equal(findings[0].severity, "info");
});

test("inodes: an unusable df -i is an explicit skip, not silence", async () => {
  const findings = await inodes.run(stubCtx({}));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "inodes/skipped");
  assert.equal(findings[0].severity, "info");
});
