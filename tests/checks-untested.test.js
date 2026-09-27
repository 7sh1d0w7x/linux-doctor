// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Behavior tests for checks that previously had none (analysis §7): oom, wifi,
 * orphans, packages, fs, cache. They ran only through the generic all-fail
 * path, so a parser regression would have been invisible. (boot/hardware are
 * already covered in tests/checks.test.js.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { detectDistro } from "../src/distro.js";
import { loadThresholds } from "../src/thresholds.js";
import { oom } from "../src/checks/oom.js";
import { wifi } from "../src/checks/wifi.js";
import { orphans } from "../src/checks/orphans.js";
import { backup } from "../src/checks/backup.js";
import { foreignLockHolders, packages } from "../src/checks/packages.js";
import { fs } from "../src/checks/fs.js";
import { cache } from "../src/checks/cache.js";

function stubCtx(map, osRelease = { id: "ubuntu", id_like: "debian" }) {
  return {
    osRelease,
    dist: detectDistro(osRelease),
    thresholds: loadThresholds({}),
    run: async (cmd) => {
      const entry = map[cmd];
      if (entry === undefined) return { ok: false, code: 1, stdout: "", stderr: "" };
      return { ok: true, code: 0, stdout: entry, stderr: "" };
    },
  };
}

// ---------------------------------------------------------------- oom ---------

test("oom: one kill (two log lines, same pid) is a single medium finding", async () => {
  const ctx = stubCtx({
    "command -v journalctl 2>/dev/null": "/usr/bin/journalctl\n",
    "command -v dmesg 2>/dev/null": "/usr/bin/dmesg\n",
    "journalctl -k --no-pager -n 500 2>/dev/null | grep -iE 'Out of memory|Killed process|oom-killer|oom_reaper' | tail -n 20": "Out of memory: Killed process 1234 (chrome)\noom_reaper: reaped process 1234 (chrome)\n",
    "dmesg 2>/dev/null | grep -iE 'Out of memory|Killed process|oom-killer' | tail -n 20": "",
  });
  const findings = await oom.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "oom/kills");
  assert.equal(findings[0].severity, "medium", "a single kill must not be a 'pattern'");
  assert.match(findings[0].title, /1 OOM kill/);
});

test("oom: two kills (two pids) are high", async () => {
  const ctx = stubCtx({
    "command -v journalctl 2>/dev/null": "/usr/bin/journalctl\n",
    "command -v dmesg 2>/dev/null": "/usr/bin/dmesg\n",
    "journalctl -k --no-pager -n 500 2>/dev/null | grep -iE 'Out of memory|Killed process|oom-killer|oom_reaper' | tail -n 20": "Out of memory: Killed process 1234 (chrome)\nOut of memory: Killed process 5678 (firefox)\n",
    "dmesg 2>/dev/null | grep -iE 'Out of memory|Killed process|oom-killer' | tail -n 20": "",
  });
  const findings = await oom.run(ctx);
  assert.equal(findings[0].severity, "high");
  assert.match(findings[0].title, /2 OOM kill/);
});

// --------------------------------------------------------------- wifi ---------

test("wifi: soft-blocked is medium", async () => {
  const ctx = stubCtx({
    "rfkill list wifi 2>/dev/null; rfkill list wlan 2>/dev/null": "0: phy0: Wireless LAN\n\tSoft blocked: yes\n\tHard blocked: no\n",
    "nmcli radio wifi 2>/dev/null; nmcli device status 2>/dev/null | grep -i wifi": "enabled\n",
    "lspci -nn 2>/dev/null | grep -iE 'network|wireless|wlan'": "0b:00.0 Network controller: Intel\n",
  });
  const findings = await wifi.run(ctx);
  assert.equal(findings[0].code, "wifi/blocked");
  assert.equal(findings[0].severity, "medium");
});

test("wifi: disabled in NetworkManager is medium", async () => {
  const ctx = stubCtx({
    "rfkill list wifi 2>/dev/null; rfkill list wlan 2>/dev/null": "0: phy0: Wireless LAN\n\tSoft blocked: no\n",
    "nmcli radio wifi 2>/dev/null; nmcli device status 2>/dev/null | grep -i wifi": "disabled\n",
    "lspci -nn 2>/dev/null | grep -iE 'network|wireless|wlan'": "0b:00.0 Network controller: Intel\n",
  });
  const findings = await wifi.run(ctx);
  assert.equal(findings[0].code, "wifi/disabled");
});

test("wifi: no adapter at all is informational", async () => {
  const findings = await wifi.run(stubCtx({}));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "wifi/no-adapter");
  assert.equal(findings[0].severity, "info");
});

// ------------------------------------------------------------ orphans ---------

test("orphans: 12 removable apt packages is medium", async () => {
  const remv = Array.from({ length: 12 }, (_, i) => `Remv lib${i} [1.0]`).join("\n") + "\n";
  const ctx = stubCtx({ "apt-get -s autoremove 2>/dev/null": remv });
  const findings = await orphans.run(ctx);
  assert.equal(findings[0].code, "orphans/many");
  assert.equal(findings[0].severity, "medium");
  assert.match(findings[0].fix, /apt autoremove/);
});

test("orphans: none is informational", async () => {
  const ctx = stubCtx({ "apt-get -s autoremove 2>/dev/null": "" });
  const findings = await orphans.run(ctx);
  assert.equal(findings[0].code, "orphans/none");
});

test("orphans: a couple of arch orphans is informational", async () => {
  const ctx = stubCtx({ "pacman -Qtdq 2>/dev/null": "libfoo\nlibbar\n" }, { id: "arch" });
  const findings = await orphans.run(ctx);
  assert.equal(findings[0].code, "orphans/some");
  assert.equal(findings[0].severity, "info");
});

// ----------------------------------------------------------- packages ---------

// The dpkg lock probe exactly as src/checks/packages.js builds it. It compares
// process groups, so a holder inside linux-doctor's own group (its own
// `apt-get check`, or the `updates` / `orphans` probes) is not reported as
// another process. That self-accusation was #24.
const LOCK_PROBE =
  "printf 'self %s\\n' \"$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')\"; " +
  "for pid in $(fuser /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock 2>/dev/null); do " +
  'printf \'%s %s\\n\' "$pid" "$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d \' \')"; done';


test("packages: a broken dpkg database is high", async () => {
  const ctx = stubCtx({
    "dpkg --audit 2>&1 | head -20": "The following packages are in a mess due to serious problems during installation:\n libfoo\n",
    "apt-get check 2>&1 | head -20": "",
    [LOCK_PROBE]: "",
  });
  const findings = await packages.run(ctx);
  assert.equal(findings[0].code, "packages/broken");
  assert.equal(findings[0].severity, "high");
});

test("packages: a held apt lock is medium, and the evidence is the PID alone", async () => {
  const ctx = stubCtx({
    "dpkg --audit 2>&1 | head -20": "",
    "apt-get check 2>&1 | head -20": "",
    [LOCK_PROBE]: "self 77\n4242 5150\n",
  });
  const findings = await packages.run(ctx);
  assert.equal(findings[0].code, "packages/locked");
  assert.equal(findings[0].severity, "medium");
  // The probe prints PIDs only, so a lock path can never reach the evidence as
  // if it were the holder.
  assert.equal(findings[0].evidence, "lock held by PID 4242");
});

test("packages: an unheld lock file is not a lock", async () => {
  // The old probe listed the lock paths and tested the whole output for a
  // digit, so anything numeric-looking could pass as a holder. Only PIDs count.
  const ctx = stubCtx({
    "dpkg --audit 2>&1 | head -20": "",
    "apt-get check 2>&1 | head -20": "",
    [LOCK_PROBE]: "self 77\n/var/lib/dpkg/lock\n/var/lib/apt/lists/lock\n",
  });
  const findings = await packages.run(ctx);
  assert.equal(findings[0].code, "packages/ok");
});

// `apt-get check` above, plus the `updates` and `orphans` checks, take the same
// dpkg lock while this check runs. A plain `fuser` therefore reported
// linux-doctor itself as "another process": run as root on a healthy machine,
// the user was told to wait for, or kill, the tool they were running (#24).
//
// The probe reports groups (`self <pgid>`, then `<pid> <pgid>`) and
// `foreignLockHolders` applies the rule, so these assert the behaviour rather
// than the spelling of the shell pipeline.

test("packages: a holder in linux-doctor's own process group is not a lock (#24)", async () => {
  const ctx = stubCtx({
    "dpkg --audit 2>&1 | head -20": "",
    "apt-get check 2>&1 | head -20": "",
    [LOCK_PROBE]: "self 77\n4242 77\n",
  });
  const findings = await packages.run(ctx);
  assert.equal(findings[0].code, "packages/ok", "the tool must not report itself as a lock holder");
});

test("packages: a holder whose process group cannot be read is not a lock", async () => {
  // No group means it exited between `fuser` and `ps`, so it holds nothing.
  const ctx = stubCtx({
    "dpkg --audit 2>&1 | head -20": "",
    "apt-get check 2>&1 | head -20": "",
    [LOCK_PROBE]: "self 77\n4242\n",
  });
  const findings = await packages.run(ctx);
  assert.equal(findings[0].code, "packages/ok");
});

test("packages: an unreadable own process group reports nothing rather than guessing", async () => {
  // Without `ps -o pgid=` every holder would look foreign — which is exactly
  // the false positive #24 removed. Stay quiet instead of reinstating it.
  const ctx = stubCtx({
    "dpkg --audit 2>&1 | head -20": "",
    "apt-get check 2>&1 | head -20": "",
    [LOCK_PROBE]: "self\n4242 5150\n",
  });
  const findings = await packages.run(ctx);
  assert.equal(findings[0].code, "packages/ok");
});

test("foreignLockHolders: keeps outside pids and drops our own", () => {
  assert.deepEqual(foreignLockHolders("self 77\n4242 5150\n9001 77\n"), ["4242"]);
  assert.deepEqual(foreignLockHolders("self 77\n"), []);
  assert.deepEqual(foreignLockHolders(""), []);
});

// Regression for #14: `apt-get check` needs the dpkg frontend lock, which an
// unprivileged run cannot take. `2>&1` folds its refusal into the same string,
// and the bare `E:` / `error` predicate then read that refusal as broken
// dependencies — so every non-root run on a perfectly healthy Debian box got a
// high "Package manager reports broken dependencies" whose evidence was apt
// complaining it is not root.
const APT_LOCK_REFUSAL =
  "E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\n" +
  "E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?\n";

test("packages: a non-root apt lock refusal is not a broken package", async () => {
  const ctx = stubCtx({
    "dpkg --audit 2>&1 | head -20": "",
    "apt-get check 2>&1 | head -20": APT_LOCK_REFUSAL,
    [LOCK_PROBE]: "",
  });
  const findings = await packages.run(ctx);
  assert.equal(findings[0].code, "packages/ok");
  assert.equal(findings[0].severity, "info");
});

test("packages: the healthy finding records that apt-get check needed root", async () => {
  const ctx = stubCtx({
    "dpkg --audit 2>&1 | head -20": "",
    "apt-get check 2>&1 | head -20": APT_LOCK_REFUSAL,
    [LOCK_PROBE]: "",
  });
  const findings = await packages.run(ctx);
  // Claiming "apt-get check: ok" would be a lie — it never ran.
  assert.match(findings[0].evidence, /needs root/i);
  assert.doesNotMatch(findings[0].evidence, /apt-get check: ok/);
});

test("packages: real unmet dependencies are still high", async () => {
  const ctx = stubCtx({
    "dpkg --audit 2>&1 | head -20": "",
    "apt-get check 2>&1 | head -20":
      "Reading package lists...\nBuilding dependency tree...\n" +
      "E: Unmet dependencies. Try 'apt --fix-broken install' with no packages (or specify a solution).\n",
    [LOCK_PROBE]: "",
  });
  const findings = await packages.run(ctx);
  assert.equal(findings[0].code, "packages/broken");
  assert.equal(findings[0].severity, "high");
});

test("packages: a lock refusal does not mask a genuinely broken dpkg database", async () => {
  const ctx = stubCtx({
    "dpkg --audit 2>&1 | head -20": "The following packages are in a mess due to serious problems during installation:\n libfoo\n",
    "apt-get check 2>&1 | head -20": APT_LOCK_REFUSAL,
    [LOCK_PROBE]: "",
  });
  const findings = await packages.run(ctx);
  assert.equal(findings[0].code, "packages/broken");
  assert.equal(findings[0].severity, "high");
});

// Regression: `pacman -Dk` prints "No database errors have been found!" on a
// clean database. A bare /error/ matched that sentence, so a clean Arch system
// was reported as "Pacman database has errors" (high) with the success line as
// its evidence. Found by the clean-image baseline gate on its first run.
test("packages: pacman reporting no database errors is informational", async () => {
  const ctx = stubCtx({
    "pacman -Dk 2>&1":
      "warning: database file for 'core' does not exist (use '-Sy' to download)\n" +
      "warning: database file for 'extra' does not exist (use '-Sy' to download)\n" +
      "No database errors have been found!\n",
  }, { id: "arch" });
  const findings = await packages.run(ctx);
  assert.equal(findings[0].code, "packages/ok");
  assert.equal(findings[0].severity, "info");
});

test("packages: a real pacman database error is still high", async () => {
  const ctx = stubCtx({
    "pacman -Dk 2>&1": "error: package libfoo: missing 'libbar' dependency\n",
  }, { id: "arch" });
  const findings = await packages.run(ctx);
  assert.equal(findings[0].code, "packages/broken");
  assert.equal(findings[0].severity, "high");
});

test("packages: a healthy apt database is informational", async () => {
  const ctx = stubCtx({
    "dpkg --audit 2>&1 | head -20": "",
    "apt-get check 2>&1 | head -20": "",
    [LOCK_PROBE]: "",
  });
  const findings = await packages.run(ctx);
  assert.equal(findings[0].code, "packages/ok");
});

// ----------------------------------------------------------------- fs ---------

test("fs: a read-only remount is high", async () => {
  const ctx = stubCtx({
    "command -v journalctl 2>/dev/null": "/usr/bin/journalctl\n",
    "command -v dmesg 2>/dev/null": "",
    "journalctl -k --no-pager -n 500 2>/dev/null | grep -iE 'EXT4-fs error|I/O error|buffer I/O error|BTRFS.*(error|critical|failed|corrupt)|XFS.*error|I/O stall' | tail -n 20": "",
    "dmesg 2>/dev/null | grep -iE 'EXT4-fs error|I/O error|buffer I/O error|BTRFS.*(error|critical|failed|corrupt)|XFS.*error|Remounting filesystem read-only' | tail -n 20": "EXT4-fs error (device sda2): remounting filesystem read-only\n",
    "dmesg 2>/dev/null | grep -i 'Remounting filesystem read-only' | tail -n 5": "EXT4-fs (sda2): Remounting filesystem read-only\n",
  });
  const findings = await fs.run(ctx);
  assert.equal(findings[0].code, "fs/readonly-remount");
  assert.equal(findings[0].severity, "high");
});

test("fs: a clean kernel log is informational", async () => {
  const ctx = stubCtx({
    "command -v journalctl 2>/dev/null": "/usr/bin/journalctl\n",
    "command -v dmesg 2>/dev/null": "",
    "journalctl -k --no-pager -n 500 2>/dev/null | grep -iE 'EXT4-fs error|I/O error|buffer I/O error|BTRFS.*(error|critical|failed|corrupt)|XFS.*error|I/O stall' | tail -n 20": "",
    "dmesg 2>/dev/null | grep -iE 'EXT4-fs error|I/O error|buffer I/O error|BTRFS.*(error|critical|failed|corrupt)|XFS.*error|Remounting filesystem read-only' | tail -n 20": "",
    "dmesg 2>/dev/null | grep -i 'Remounting filesystem read-only' | tail -n 5": "",
  });
  const findings = await fs.run(ctx);
  assert.equal(findings[0].code, "fs/ok");
  assert.equal(findings[0].severity, "info");
});

// Regression for #13: "Btrfs loaded, zoned=yes, fsverity=yes" is the module load
// banner. The kernel prints it at every boot on any build with btrfs compiled in,
// whether or not a btrfs filesystem is mounted — so it is neither an error nor
// evidence that btrfs is in use.

test("fs: the btrfs module load banner is not a filesystem error", async () => {
  const osRelease = { id: "ubuntu", id_like: "debian" };
  const ctx = {
    osRelease,
    dist: detectDistro(osRelease),
    thresholds: loadThresholds({}),
    // Force the banner through whichever log grep the check uses, so this stays
    // an assertion about the check's logic rather than about one command string.
    run: async (cmd) => {
      if (cmd.startsWith("command -v")) return { ok: true, code: 0, stdout: "/usr/bin/dmesg\n", stderr: "" };
      if (cmd.includes("tail -n 5")) return { ok: true, code: 0, stdout: "", stderr: "" };
      return { ok: true, code: 0, stdout: "[    2.446464] Btrfs loaded, zoned=yes, fsverity=yes\n", stderr: "" };
    },
  };
  const findings = await fs.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "fs/ok", "the module load banner must not be read as an error");
  assert.equal(findings[0].severity, "info");
});

test("fs: a real btrfs error is still reported as high", async () => {
  const ctx = stubCtx({
    "command -v journalctl 2>/dev/null": "/usr/bin/journalctl\n",
    "command -v dmesg 2>/dev/null": "",
    "journalctl -k --no-pager -n 500 2>/dev/null | grep -iE 'EXT4-fs error|I/O error|buffer I/O error|BTRFS.*(error|critical|failed|corrupt)|XFS.*error|I/O stall' | tail -n 20":
      "BTRFS error (device sda2): bdev /dev/sda2 errs: wr 0, rd 0, flush 0, corrupt 12, gen 0\n" +
      "BTRFS critical (device sda2): corrupt leaf: root=5 block=12345 slot=0\n" +
      "BTRFS: failed to read chunk tree on sda2\n",
    "dmesg 2>/dev/null | grep -iE 'EXT4-fs error|I/O error|buffer I/O error|BTRFS.*(error|critical|failed|corrupt)|XFS.*error|Remounting filesystem read-only' | tail -n 20": "",
    "dmesg 2>/dev/null | grep -i 'Remounting filesystem read-only' | tail -n 5": "",
  });
  const findings = await fs.run(ctx);
  assert.equal(findings[0].code, "fs/btrfs-errors");
  assert.equal(findings[0].severity, "high");
  // "critical" and "failed" carry no literal "error" — the corruption case must
  // survive the banner fix, not just the lines that happen to say "error".
  assert.match(findings[0].evidence, /BTRFS critical/);
  assert.match(findings[0].evidence, /failed to read chunk tree/);
});

test("fs: the dmesg grep never matches BTRFS on its own", async () => {
  const seen = [];
  const osRelease = { id: "ubuntu", id_like: "debian" };
  const ctx = {
    osRelease,
    dist: detectDistro(osRelease),
    thresholds: loadThresholds({}),
    run: async (cmd) => {
      seen.push(cmd);
      return { ok: true, code: 0, stdout: "", stderr: "" };
    },
  };
  await fs.run(ctx);
  const dmesgGrep = seen.find((c) => c.startsWith("dmesg") && c.includes("tail -n 20"));
  assert.ok(dmesgGrep, "the check must still grep dmesg for errors");
  assert.ok(
    !/\|BTRFS\|/.test(dmesgGrep),
    "a bare BTRFS alternation matches the harmless module load banner",
  );
  assert.match(
    dmesgGrep,
    /BTRFS\.\*\((?=[^)]*error)(?=[^)]*critical)(?=[^)]*failed)(?=[^)]*corrupt)[^)]*\)/,
    "BTRFS must be qualified by the severity keywords, not dropped entirely",
  );
});

// -------------------------------------------------------------- cache ---------

test("cache: a 12 GB user cache is medium", async () => {
  const ctx = stubCtx({
    'du -sb "$HOME/.cache" 2>/dev/null | cut -f1': "12000000000\n",
    'du -sb "$HOME/.local/share/Trash" 2>/dev/null | cut -f1': "",
  });
  const findings = await cache.run(ctx);
  assert.equal(findings[0].code, "cache/large");
  assert.equal(findings[0].severity, "medium");
});

test("cache: a small cache is silent (no false positive)", async () => {
  const ctx = stubCtx({
    'du -sb "$HOME/.cache" 2>/dev/null | cut -f1': "100000000\n",
    'du -sb "$HOME/.local/share/Trash" 2>/dev/null | cut -f1': "",
  });
  const findings = await cache.run(ctx);
  assert.ok(!findings.some((f) => /medium|high/.test(f.severity)), "a 100 MB cache must not alarm");
});

// ------------------------------------------------- packages: dnf needs root --

test("packages: dnf without root is 'skipped (needs root)', not a broken database", async () => {
  // On Fedora an unprivileged `dnf check` cannot create its cache and exits 1
  // with "filesystem error: cannot create directories: Permission denied".
  // The old probe piped through `head`, so the exit status belonged to head,
  // the failure looked successful, the /error/ predicate matched that line and
  // a healthy machine got a HIGH "package manager reports problems" — the same
  // false positive the apt lock refusal used to cause. Verified in a Fedora
  // container as a non-root user.
  const ctx = stubCtx({
    "dnf check 2>&1": "filesystem error: cannot create directories: Permission denied [/.local/state]\n",
  }, { id: "fedora", id_like: "fedora" });
  const findings = await packages.run(ctx);
  assert.ok(!findings.some((f) => f.code === "packages/broken"), `a permission refusal is not a broken database: ${JSON.stringify(findings.map((f) => f.code))}`);
  assert.equal(findings[0].code, "packages/ok");
  assert.match(findings[0].evidence, /skipped \(needs root\)/);
});

test("packages: a failed pacman check stays silent instead of claiming health", async () => {
  // `pacman -Dk` does not need root (verified: it exits 0 unprivileged), so the
  // dead exit-status gate here was benign — but a silent guard belongs in the
  // tests, so a future edit cannot turn a failure into "database is healthy".
  const ctx = stubCtx({
  }, { id: "arch", id_like: "arch" });
  const findings = await packages.run(ctx);
  assert.deepEqual(findings, []);
});

// ------------------------------------------------------- orphans: dnf query --


test("orphans: a failed apt query is not 'no orphaned packages'", async () => {
  // The pipeline's exit status was grep's, so a locked/failed apt printed
  // nothing and the check called the database tidy. Silence, not a clean bill.
  const ctx = stubCtx({}, { id: "debian", id_like: "debian" });
  assert.deepEqual(await orphans.run(ctx), []);
});

test("orphans: a failed zypper query is not 'no orphaned packages'", async () => {
  const ctx = stubCtx({}, { id: "opensuse-tumbleweed", id_like: "suse" });
  assert.deepEqual(await orphans.run(ctx), []);
});

test("orphans: a failed pacman query is not 'no orphaned packages'", async () => {
  const ctx = stubCtx({}, { id: "arch", id_like: "arch" });
  assert.deepEqual(await orphans.run(ctx), []);
});

test("orphans: a failed dnf query is not 'no orphaned packages'", async () => {
  // `dnf repoquery --unneeded | wc -l` always exits 0 (wc's status), so a
  // failed query printed 0 and the check reported a tidy database. Verified
  // in a Fedora container: unprivileged dnf exits 1 and prints the same
  // permission error. "Could not determine" must be silence, not a clean bill.
  const ctx = stubCtx({
  }, { id: "fedora", id_like: "fedora" });
  const findings = await orphans.run(ctx);
  assert.deepEqual(findings, [], "if neither query ran, say nothing");
});


test("backup: no systemctl is 'could not check', not 'nothing scheduled'", async () => {
  // A non-systemd system with a backup tool got a false "nothing is scheduled":
  // the timer probe was empty because systemctl is absent, not because the
  // backup is unscheduled.
  const ctx = stubCtx({
    'for t in borg restic rclone duplicity timeshift pika-backup backintime deja-dup; do command -v "$t" 2>/dev/null; done': "/usr/bin/restic\n",
  }, { id: "alpine", id_like: "" });
  const findings = await backup.run(ctx);
  assert.equal(findings[0].code, "backup/unknown", `expected 'could not check': ${JSON.stringify(findings.map((f) => f.code))}`);
  assert.ok(!findings.some((f) => f.code === "backup/unscheduled"), "must not claim unscheduled");
});

// ------------------------------------------------- cache: Flatpak caches -----

test("cache: Flatpak app caches are measured too, not just ~/.cache", async () => {
  // Seen on a Bazzite box: ~/.cache held 3.7 GB while ~/.var/app held 5 GB of
  // per-app Flatpak caches (a game launcher at 2.6 GB, a chat app at 1.8 GB)
  // that the check never looked at. So the report said "cache is getting
  // large" while the real reclaimable space was invisible.
  const ctx = stubCtx({
    'du -sb "$HOME/.cache" 2>/dev/null | cut -f1': String(3 * 1024 ** 3) + "\n",
    'du -sb "$HOME/.local/share/Trash" 2>/dev/null | cut -f1': "0\n",
    'du -sb "$HOME/.var/app"/*/cache 2>/dev/null': [
      `${Math.round(2.6 * 1024 ** 3)}\t/home/u/.var/app/org.vinegarhq.Sober/cache`,
      `${Math.round(1.8 * 1024 ** 3)}\t/home/u/.var/app/com.ktechpit.whatsie/cache`,
      "",
    ].join("\n"),
  });
  const findings = await cache.run(ctx);
  const large = findings.find((f) => f.code === "cache/large");
  assert.ok(large, `a 4.4 GB Flatpak cache must not be invisible: ${JSON.stringify(findings.map((f) => f.code))}`);
  assert.match(large.evidence, /Sober/, "name the biggest offender");
});

test("cache: Flatpak caches count toward the size thresholds", async () => {
  // ~/.cache alone is under the warn threshold; with the Flatpak caches it is
  // over it, so the finding must appear.
  const ctx = stubCtx({
    'du -sb "$HOME/.cache" 2>/dev/null | cut -f1': String(1 * 1024 ** 3) + "\n",
    'du -sb "$HOME/.local/share/Trash" 2>/dev/null | cut -f1': "0\n",
    'du -sb "$HOME/.var/app"/*/cache 2>/dev/null': `${Math.round(6 * 1024 ** 3)}\t/home/u/.var/app/com.example.App/cache\n`,
  });
  const findings = await cache.run(ctx);
  assert.ok(findings.some((f) => f.code === "cache/large"), "1 GB + 6 GB is over the warn threshold");
});
