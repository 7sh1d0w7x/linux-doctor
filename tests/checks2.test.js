// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDistro } from "../src/distro.js";
import { loadThresholds } from "../src/thresholds.js";
import { ssh } from "../src/checks/ssh.js";
import { snap } from "../src/checks/snap.js";
import { zram } from "../src/checks/zram.js";
import { locales } from "../src/checks/locales.js";
import { autologin } from "../src/checks/autologin.js";
import { fstrim } from "../src/checks/fstrim.js";
import { kernel } from "../src/checks/kernel.js";
import { network } from "../src/checks/network.js";
import { inotify } from "../src/checks/inotify.js";
import { gpuErrors } from "../src/checks/gpu-errors.js";

function stubCtx(map, osRelease = { id: "bazzite", id_like: "fedora" }) {
  return {
    dist: detectDistro(osRelease),
    thresholds: loadThresholds({}),
    run: async (cmd) => {
      const entry = map[cmd];
      if (entry === undefined) return { ok: false, code: 1, stdout: "", stderr: "" };
      return { ok: true, code: 0, stdout: entry, stderr: "" };
    },
  };
}

const SSH_CFG = "grep -rhE '^\\s*(PermitRootLogin|PasswordAuthentication)\\s+' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/ 2>/dev/null";

test("ssh: silent when no SSH server is installed", async () => {
  const ctx = stubCtx({});
  assert.deepEqual(await ssh.run(ctx), []);
});

test("ssh: root login with password is high severity", async () => {
  const ctx = stubCtx({
    "systemctl is-active sshd 2>/dev/null": "active",
    [SSH_CFG]: "PermitRootLogin yes\nPasswordAuthentication yes\n",
  });
  const findings = await ssh.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "high");
  assert.match(findings[0].code, /ssh\/root-password/);
});

test("ssh: root login key-only still allows password mode is medium", async () => {
  const ctx = stubCtx({
    "systemctl is-active sshd 2>/dev/null": "active",
    [SSH_CFG]: "PermitRootLogin yes\nPasswordAuthentication no\n",
  });
  const findings = await ssh.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].code, /ssh\/root-login/);
});

test("ssh: last drop-in wins (prohibit-password overrides earlier yes)", async () => {
  const ctx = stubCtx({
    "systemctl is-active sshd 2>/dev/null": "active",
    [SSH_CFG]: "PermitRootLogin yes\nPermitRootLogin prohibit-password\n",
  });
  const findings = await ssh.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].code, /ssh\/ok/);
});

test("ssh: sane config (or defaults) is informational", async () => {
  const ctx = stubCtx({ "systemctl is-active sshd 2>/dev/null": "active" });
  const findings = await ssh.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].code, /ssh\/ok/);
});

test("snap: silent when snap is not installed", async () => {
  const ctx = stubCtx({});
  assert.deepEqual(await snap.run(ctx), []);
});

test("snap: pending refreshes with an active timer are informational", async () => {
  const ctx = stubCtx({
    "command -v snap 2>/dev/null": "/usr/bin/snap",
    "snap refresh --list 2>/dev/null": "Name          Version   Rev    Publisher     Notes\ncore20        2/2026    2285   canonical**    -\nfirefox       140/2026  3797   mozilla       -\n",
    "systemctl list-timers snapd.* --no-pager 2>/dev/null": "NEXT                         LEFT       LAST                         PASSED    UNIT\nMon 2026-08-24 00:00:00 UTC  4 days     N/A                          N/A       snapd.refresh.timer",
  });
  const findings = await snap.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].code, /snap\/pending/);
});

test("snap: a large backlog is medium severity", async () => {
  const ctx = stubCtx({
    "command -v snap 2>/dev/null": "/usr/bin/snap",
    "snap refresh --list 2>/dev/null": "Name          Version   Rev    Publisher\ncore20        1\ncore22        1\nfirefox       1\nspotify       1\nvlc           1\ngimp          1\n",
    "systemctl list-timers snapd.* --no-pager 2>/dev/null": "NEXT  LAST  UNIT\nMon 2026-08-24 00:00:00 UTC N/A  snapd.refresh.timer",
  });
  const findings = await snap.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
});

test("snap: disabled refresh timer is flagged even with zero pending", async () => {
  const ctx = stubCtx({
    "command -v snap 2>/dev/null": "/usr/bin/snap",
    "snap refresh --list 2>/dev/null": "",
    "snap list 2>/dev/null": "Name  Version  Rev  Tracking\nfirefox 140 3797 latest/stable",
  });
  const findings = await snap.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].code, /snap\/no-timer/);
});

test("zram: healthy zram is informational", async () => {
  const ctx = stubCtx({
    "cat /proc/sys/vm/swappiness": "60",
    "swapon --show --bytes": "NAME       TYPE      SIZE        USED      PRIO\n/dev/zram0 partition 8388608000 1048576000 100",
  });
  const findings = await zram.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].code, /zram\/ok/);
});

test("zram: compressed swap nearly full is medium", async () => {
  const ctx = stubCtx({
    "cat /proc/sys/vm/swappiness": "60",
    "swapon --show --bytes": "NAME       TYPE      SIZE        USED      PRIO\n/dev/zram0 partition 8388608000 7717519360 100",
  });
  const findings = await zram.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].code, /zram\/full/);
});

test("zram: no zram but very high swappiness is informational", async () => {
  const ctx = stubCtx({
    "cat /proc/sys/vm/swappiness": "100",
  });
  const findings = await zram.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].code, /zram\/swappiness/);
});

test("zram: no zram and sane swappiness is silent", async () => {
  const ctx = stubCtx({ "cat /proc/sys/vm/swappiness": "60" });
  assert.deepEqual(await zram.run(ctx), []);
});

test("locales: broken locale is medium", async () => {
  const ctx = stubCtx({
    "env -u LC_ALL locale 2>&1": "locale: Cannot set LC_CTYPE to default locale: No such file or directory\nLANG=en_US.UTF-8\nLC_ALL=\n",
  });
  const findings = await locales.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].code, /locales\/broken/);
});

test("locales: healthy locale is silent", async () => {
  const ctx = stubCtx({
    "env -u LC_ALL locale 2>&1": "LANG=en_US.UTF-8\nLC_CTYPE=\"en_US.UTF-8\"\nLC_ALL=\n",
  });
  assert.deepEqual(await locales.run(ctx), []);
});

// The check greps widely and decides in JS, so the raw matches include things
// that are not autologin: commented examples that ship in the default GDM
// config, an explicit `false`, and a bare `[Autologin]` section header. All
// three used to be reported as "Automatic login is enabled".
const AUTOLOGIN_GREP =
  "grep -rEn 'AutomaticLoginEnable|AutologinUser|autologin-user|\\[Autologin\\]|^[[:space:]]*User[[:space:]]*=' /etc/gdm /etc/gdm3 /etc/sddm.conf /etc/sddm.conf.d/ /etc/lightdm/ /etc/lxdm/ 2>/dev/null";

// Debian/Ubuntu/Mint keep the GDM config in /etc/gdm3 (Red Hat uses /etc/gdm),
// so a check that only listed /etc/gdm never read an enabled autologin there.
test("autologin: the Debian GDM path (/etc/gdm3) is read", async () => {
  const ctx = stubCtx({
    [AUTOLOGIN_GREP]:
      "/etc/gdm3/daemon.conf:3:AutomaticLoginEnable=true\n/etc/gdm3/daemon.conf:4:AutomaticLogin=jane\n",
  });
  const findings = await autologin.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
});

// The file Debian ships is full of commented examples, including
// "#  AutomaticLoginEnable = true". Adding the path is only safe together with
// the comment filter above.
test("autologin: the commented example in Debian's daemon.conf is not enabled", async () => {
  const ctx = stubCtx({
    [AUTOLOGIN_GREP]: "/etc/gdm3/daemon.conf:10:#  AutomaticLoginEnable = true\n/etc/gdm3/daemon.conf:11:#  AutomaticLogin = user1\n",
  });
  assert.deepEqual(await autologin.run(ctx), []);
});

test("autologin: enabled automatic login is medium", async () => {
  const ctx = stubCtx({
    [AUTOLOGIN_GREP]: "/etc/sddm.conf.d/autologin.conf:3:AutologinUser=jane\n",
  });
  const findings = await autologin.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].code, /security\/autologin/);
});

test("autologin: a commented example is not enabled", async () => {
  const ctx = stubCtx({
    [AUTOLOGIN_GREP]: "/etc/gdm/custom.conf:12:# AutomaticLoginEnable=true\n",
  });
  assert.deepEqual(await autologin.run(ctx), []);
});

test("autologin: an explicit false is not enabled", async () => {
  const ctx = stubCtx({
    [AUTOLOGIN_GREP]: "/etc/gdm/custom.conf:12:AutomaticLoginEnable=false\n",
  });
  assert.deepEqual(await autologin.run(ctx), []);
});

test("autologin: a bare [Autologin] section header sets nothing", async () => {
  const ctx = stubCtx({
    [AUTOLOGIN_GREP]: "/etc/sddm.conf.d/autologin.conf:1:[Autologin]\n",
  });
  assert.deepEqual(await autologin.run(ctx), []);
});

test("autologin: SDDM User= inside an [Autologin] section is medium", async () => {
  const ctx = stubCtx({
    [AUTOLOGIN_GREP]:
      "/etc/sddm.conf.d/autologin.conf:1:[Autologin]\n/etc/sddm.conf.d/autologin.conf:2:User=jane\n",
  });
  const findings = await autologin.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].evidence, /User=jane/);
});

test("autologin: no autologin config is silent", async () => {
  const ctx = stubCtx({});
  assert.deepEqual(await autologin.run(ctx), []);
});
test("fstrim: weekly timer enabled is informational", async () => {
  const ctx = stubCtx({
    "lsblk -dno NAME,ROTA 2>/dev/null": "sda 1\nnvme0n1 0\n",
    "systemctl is-enabled fstrim.timer 2>/dev/null": "enabled\n",
    "systemctl show fstrim.timer -p LastTriggerUSec --value 2>/dev/null": "Mon 2026-08-17 00:12:44 EEST\n",
  });
  const findings = await fstrim.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].code, /fstrim\/ok$/);
});

test("fstrim: continuous discard mount covers without a timer", async () => {
  const ctx = stubCtx({
    "lsblk -dno NAME,ROTA 2>/dev/null": "nvme0n1 0\n",
    "systemctl is-enabled fstrim.timer 2>/dev/null": "disabled\n",
    "findmnt -no OPTIONS -t ext4,xfs,btrfs,f2fs 2>/dev/null": "rw,relatime,discard=async,ssd\n",
  });
  const findings = await fstrim.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info");
  assert.match(findings[0].code, /discard/);
});

test("fstrim: HDD-only system stays silent", async () => {
  const ctx = stubCtx({
    "lsblk -dno NAME,ROTA 2>/dev/null": "sda 1\nsdb 1\n",
  });
  assert.deepEqual(await fstrim.run(ctx), []);
});

test("fstrim: SSD with no TRIM mechanism is medium with an enable fix", async () => {
  const ctx = stubCtx({
    "lsblk -dno NAME,ROTA 2>/dev/null": "nvme0n1 0\nsda 1\n",
    "systemctl is-enabled fstrim.timer 2>/dev/null": "disabled\n",
  });
  const findings = await fstrim.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].fix, /systemctl enable --now fstrim\.timer/);
});

test("fstrim: zram/loop ROTA=0 devices are not treated as SSDs", async () => {
  const ctx = stubCtx({ "lsblk -dno NAME,ROTA 2>/dev/null": "zram0 0\nloop0 0\n" });
  const findings = await fstrim.run(ctx);
  assert.equal(findings.length, 0, "no trimmable storage means TRIM is not applicable");
});

test("zram: substantial compressed swap in use is described honestly, not called healthy", async () => {
  // 4.6 GiB of 7.7 GiB is 60%: normal over a long uptime, so the severity must
  // not be inflated (that would be grading by distance from normal). But
  // "healthy" hides that the kernel is compressing a lot of memory and the
  // machine can feel slow because of it, and says nothing about what to do.
  const ctx = stubCtx({
    "cat /proc/sys/vm/swappiness": "60",
    "swapon --show --bytes": "NAME       TYPE      SIZE        USED      PRIO\n/dev/zram0 partition 8271224832 4939212390 100",
  });
  const findings = await zram.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "info", "60% is not a risk level; do not inflate it");
  assert.ok(!/healthy/i.test(findings[0].title), `do not call 60% occupancy healthy: ${findings[0].title}`);
  assert.match(findings[0].detail, /processes|cache|reclaimable|compressing/i, "point at what is actionable");
});

// ---------------------------------------------------------------- kernel taint --

const KERNEL = "cat /proc/sys/kernel/tainted 2>/dev/null";

test("kernel: a clean kernel produces no finding", async () => {
  assert.deepEqual(await kernel.run(stubCtx({ [KERNEL]: "0\n" })), []);
});

test("kernel: an unreadable taint file stays silent", async () => {
  assert.deepEqual(await kernel.run(stubCtx({})), [], "absence of the file is not a taint");
  assert.deepEqual(await kernel.run(stubCtx({ [KERNEL]: "not-a-number\n" })), []);
});

test("kernel: the proprietary bit is decoded", async () => {
  const f = (await kernel.run(stubCtx({ [KERNEL]: "1\n" })))[0];
  assert.equal(f.code, "kernel/tainted");
  assert.equal(f.severity, "info", "an NVIDIA desktop is not a fault");
  assert.match(f.evidence, /proprietary module loaded/);
  assert.equal(f.fix, null);
});

test("kernel: several flags are all named, out-of-tree included", async () => {
  // 1 (proprietary) | 12 (out-of-tree, 4096) | 13 (unsigned, 8192)
  const f = (await kernel.run(stubCtx({ [KERNEL]: String(1 + 4096 + 8192) + "\n" })))[0];
  assert.match(f.evidence, /proprietary module loaded/);
  assert.match(f.evidence, /out-of-tree module/);
  assert.match(f.evidence, /unsigned module/);
  assert.match(f.title, /3 flags/);
});

test("kernel: a bit newer than the table is reported by number, not dropped", async () => {
  const f = (await kernel.run(stubCtx({ [KERNEL]: String(1 << 25) + "\n" })))[0];
  assert.match(f.evidence, /unknown taint bit 25/);
});

// ---------------------------------------------------------------- conntrack --

const NET_BASE = {
  "command -v ip 2>/dev/null": "/usr/sbin/ip\n",
  "ip -brief addr show 2>/dev/null": "wlan0            UP             192.168.1.5/24\n",
  "ip route show default 2>/dev/null": "default via 192.168.1.1 dev wlan0 proto dhcp metric 600\n",
  "getent ahostsv4 kernel.org 2>&1 | head -1": "151.101.1.69     STREAM kernel.org\n",
};

test("network: no conntrack module is silence, not a finding", async () => {
  const findings = await network.run(stubCtx(NET_BASE));
  assert.deepEqual(findings.map((f) => f.code), ["network/ok"]);
});

test("network: a conntrack table at 85% is medium", async () => {
  const findings = await network.run(stubCtx({
    ...NET_BASE,
    "cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null": "87040\n",
    "cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null": "102400\n",
  }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "network/conntrack");
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].title, /85% full/);
  assert.match(findings[0].evidence, /count=87040 .*max=102400/);
});

test("network: a conntrack table at 96% is high", async () => {
  const findings = await network.run(stubCtx({
    ...NET_BASE,
    "cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null": "98304\n",
    "cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null": "102400\n",
  }));
  assert.equal(findings[0].code, "network/conntrack");
  assert.equal(findings[0].severity, "high");
});

// ------------------------------------------------------------------ inotify --

const LIM = "cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null";
const LIMI = "cat /proc/sys/fs/inotify/max_user_instances 2>/dev/null";
const LIMQ = "cat /proc/sys/fs/inotify/max_queued_events 2>/dev/null";
const USED = "grep -h '^inotify wd:' /proc/[0-9]*/fdinfo/* 2>/dev/null | wc -l";
const USEDI = "grep -l '^inotify wd:' /proc/[0-9]*/fdinfo/* 2>/dev/null | wc -l";

test("inotify: without the limit files there is nothing to say", async () => {
  assert.deepEqual(await inotify.run(stubCtx({})), []);
});

test("inotify: a healthy machine stays silent", async () => {
  const findings = await inotify.run(stubCtx({
    [LIM]: "1000\n", [LIMI]: "100\n", [LIMQ]: "16384\n", [USED]: "100\n", [USEDI]: "10\n",
  }));
  assert.deepEqual(findings, []);
});

test("inotify: watches at 85% are medium, instances stay quiet", async () => {
  const findings = await inotify.run(stubCtx({
    [LIM]: "1000\n", [LIMI]: "100\n", [LIMQ]: "16384\n", [USED]: "850\n", [USEDI]: "10\n",
  }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "inotify/watches-low");
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].evidence, /max_user_watches=1000 .* in use 850 \(85%\)/);
});

test("inotify: watches at 96% are high", async () => {
  const findings = await inotify.run(stubCtx({
    [LIM]: "1000\n", [LIMI]: "100\n", [LIMQ]: "16384\n", [USED]: "960\n", [USEDI]: "10\n",
  }));
  assert.equal(findings[0].code, "inotify/watches-low");
  assert.equal(findings[0].severity, "high");
});

test("inotify: instances at 90% are reported separately", async () => {
  const findings = await inotify.run(stubCtx({
    [LIM]: "1000\n", [LIMI]: "100\n", [LIMQ]: "16384\n", [USED]: "100\n", [USEDI]: "90\n",
  }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "inotify/instances-low");
  assert.equal(findings[0].severity, "medium");
});

// --------------------------------------------------------------- gpu errors --

function gpuCtx(journal, dmesg = "", { bin = true } = {}) {
  return {
    dist: detectDistro({ id: "bazzite", id_like: "fedora" }),
    thresholds: loadThresholds({}),
    run: async (cmd) => {
      if (cmd.includes("command -v journalctl")) return bin ? { ok: true, code: 0, stdout: "/usr/bin/journalctl\n" } : { ok: false, code: 127, stdout: "" };
      if (cmd.includes("command -v dmesg")) return bin ? { ok: true, code: 0, stdout: "/usr/bin/dmesg\n" } : { ok: false, code: 127, stdout: "" };
      if (cmd.includes("journalctl -k --since")) return { ok: true, code: 0, stdout: journal };
      if (cmd.includes("dmesg 2>/dev/null | grep")) return { ok: true, code: 0, stdout: dmesg };
      return { ok: false, code: 1, stdout: "", stderr: "" };
    },
  };
}

test("gpu-errors: Xid 79 is high — the card fell off the bus", async () => {
  const f = (await gpuErrors.run(gpuCtx("Nov 18 10:00:01 host kernel: NVRM: Xid (PCI:0000:01:00): 79, pid=1234\n")))[0];
  assert.equal(f.code, "gpu-errors/xid");
  assert.equal(f.severity, "high");
  assert.match(f.title, /Xid 79/);
  assert.match(f.fix, /power|PSU|seating/i);
});

test("gpu-errors: a recoverable Xid is medium and keeps the code", async () => {
  const f = (await gpuErrors.run(gpuCtx("Nov 18 10:00:01 host kernel: NVRM: Xid (PCI:0000:01:00): 13, pid=99\n")))[0];
  assert.equal(f.severity, "medium");
  assert.match(f.title, /Xid 13/);
});

test("gpu-errors: an AMDGPU ring timeout is its own finding", async () => {
  const f = (await gpuErrors.run(gpuCtx("Nov 18 10:00:01 host kernel: amdgpu 0000:03:00.0: ring gfx_0.0.0 timeout, signaled seq=1\n")))[0];
  assert.equal(f.code, "gpu-errors/ring");
  assert.equal(f.severity, "medium");
});

test("gpu-errors: a failed GPU reset is reported, not hidden behind the timeout", async () => {
  const f = (await gpuErrors.run(gpuCtx("Nov 18 10:00:02 host kernel: amdgpu: GPU reset failed\n")))[0];
  assert.equal(f.code, "gpu-errors/reset");
});

test("gpu-errors: Intel GPU hang is caught", async () => {
  const f = (await gpuErrors.run(gpuCtx("Nov 18 10:00:03 host kernel: i915 0000:00:02.0: GPU HANG: ecode 12:1:85dffffb\n")))[0];
  assert.equal(f.code, "gpu-errors/hang");
});

test("gpu-errors: the same fault with a journal prefix and a dmesg prefix counts once", async () => {
  // Real shape: journalctl prints "Nov 18 10:00:01 host kernel: ..." and dmesg
  // prints "[  123.456] ...". Comparing raw lines would count the event twice.
  const f = (await gpuErrors.run(gpuCtx(
    "Nov 18 10:00:01 host kernel: NVRM: Xid (PCI:0000:01:00): 13, pid=99\n",
    "[  123.456] NVRM: Xid (PCI:0000:01:00): 13, pid=99\n",
  )))[0];
  assert.match(f.title, /1 event/, `the same fault twice is one event: ${f.title}`);
});

test("gpu-errors: a clean log is an explicit ok, not silence", async () => {
  const f = (await gpuErrors.run(gpuCtx("")))[0];
  assert.equal(f.code, "gpu-errors/ok");
  assert.equal(f.severity, "info");
});

test("gpu-errors: no log tools is an explicit skip", async () => {
  const f = (await gpuErrors.run(gpuCtx("", "", { bin: false })))[0];
  assert.equal(f.code, "gpu-errors/skipped");
});
