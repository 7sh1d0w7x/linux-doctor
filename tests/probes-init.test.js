// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Probes that must see the world the way it is, not the way systemd does.
 *
 * Two classes of bug, both found by auditing the checks against primary distro
 * docs (internal/research-firewall-trim-locales-flatpak.md):
 *
 *  - a probe that can never succeed, whose failure a `catch` then swallows
 *    (`flatpak uninstall --dry-run` has never existed), and
 *  - a probe that only knows one init system, so a working mechanism is
 *    reported as absent (`fstrim.timer` on OpenRC/runit hosts that trim via
 *    cron, or openSUSE's Btrfs trim timer).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { detectDistro } from "../src/distro.js";
import { loadThresholds } from "../src/thresholds.js";
import { fstrim } from "../src/checks/fstrim.js";
import { flatpak } from "../src/checks/flatpak.js";
import { security } from "../src/checks/security.js";
import { orphans } from "../src/checks/orphans.js";

function stubCtx(map, osRelease = { id: "ubuntu", id_like: "debian" }) {
  return {
    osRelease,
    dist: detectDistro(osRelease),
    thresholds: loadThresholds({}),
    run: async (cmd) => {
      const entry = map[cmd];
      if (entry === undefined) return { ok: false, code: 1, stdout: "", stderr: "" };
      if (entry && typeof entry === "object") return entry;
      return { ok: true, code: 0, stdout: String(entry), stderr: "" };
    },
  };
}

const SSD = { "lsblk -dno NAME,ROTA 2>/dev/null": "nvme0n1 0\n" };
const NO_DISCARD = { "findmnt -no OPTIONS -t ext4,xfs,btrfs,f2fs 2>/dev/null": "" };
const CRON_PROBE = "grep -rl fstrim /etc/cron.d /etc/cron.daily /etc/cron.weekly /etc/cron.hourly /etc/periodic/weekly 2>/dev/null";
const NO_SYSTEMD = { ok: false, code: 127, stdout: "", stderr: "", missing: true };

// ------------------------------------------------------------------ fstrim ----

test("fstrim: a cron entry is a TRIM mechanism, not a missing one", async () => {
  const ctx = stubCtx({
    ...SSD,
    ...NO_DISCARD,
    "systemctl is-enabled fstrim.timer 2>/dev/null": NO_SYSTEMD,
    "systemctl is-enabled btrfs-trim.timer 2>/dev/null": NO_SYSTEMD,
    [CRON_PROBE]: "/etc/cron.weekly/fstrim\n",
  }, { id: "gentoo" });
  const codes = (await fstrim.run(ctx)).map((f) => f.code);
  assert.ok(codes.includes("fstrim/ok"), `expected a healthy TRIM finding, got ${codes.join(",")}`);
  assert.ok(!codes.includes("fstrim/disabled"), "a cron fstrim is a working TRIM mechanism");
});

test("fstrim: openSUSE's Btrfs trim timer counts as scheduled", async () => {
  const ctx = stubCtx({
    ...SSD,
    ...NO_DISCARD,
    "systemctl is-enabled fstrim.timer 2>/dev/null": "disabled\n",
    "systemctl is-enabled btrfs-trim.timer 2>/dev/null": "enabled\n",
  }, { id: "opensuse-tumbleweed", id_like: "suse" });
  const codes = (await fstrim.run(ctx)).map((f) => f.code);
  assert.ok(codes.includes("fstrim/ok"), `expected a healthy TRIM finding, got ${codes.join(",")}`);
});

test("fstrim: with no systemd and nothing scheduled, the finding must not name systemctl", async () => {
  const ctx = stubCtx({
    ...SSD,
    ...NO_DISCARD,
    "systemctl is-enabled fstrim.timer 2>/dev/null": NO_SYSTEMD,
    "systemctl is-enabled btrfs-trim.timer 2>/dev/null": NO_SYSTEMD,
    [CRON_PROBE]: "",
  }, { id: "gentoo" });
  const disabled = (await fstrim.run(ctx)).find((f) => f.code === "fstrim/disabled");
  assert.ok(disabled, "an SSD with no TRIM mechanism at all is still a real finding");
  assert.ok(!/systemctl/.test(disabled.fix || ""), `fix must not prescribe systemd: ${disabled.fix}`);
});

test("fstrim: the systemd timer still counts as scheduled", async () => {
  const ctx = stubCtx({
    ...SSD,
    ...NO_DISCARD,
    "systemctl is-enabled fstrim.timer 2>/dev/null": "enabled\n",
    "systemctl show fstrim.timer -p LastTriggerUSec --value 2>/dev/null": "Sun 2026-09-14 00:00:00 UTC\n",
  });
  const codes = (await fstrim.run(ctx)).map((f) => f.code);
  assert.ok(codes.includes("fstrim/ok"), `expected a healthy TRIM finding, got ${codes.join(",")}`);
});

// ----------------------------------------------------------------- flatpak ----

const FP_UPDATES = { "flatpak remote-ls --updates --columns=application,version 2>/dev/null": "" };
const LIST_APPS = "flatpak list --app --columns=application,runtime 2>/dev/null";
const LIST_RUNTIMES = "flatpak list --runtime --columns=ref 2>/dev/null";

test("flatpak: unused runtimes are not claimed, because the CLI cannot answer read-only", async () => {
  // Real data: this shell approximation reported "30 unused" on a box where
  // `flatpak uninstall --unused` says "Nothing unused to uninstall" — the
  // difference is extensions, which are not any app's `runtime` column. So the
  // check must not claim it, even when the listings look like they say so.
  const ctx = stubCtx({
    ...FP_UPDATES,
    [LIST_APPS]: "org.mozilla.firefox\torg.gnome.Platform/x86_64/46\n",
    [LIST_RUNTIMES]: "org.gnome.Platform/x86_64/46\norg.freedesktop.Platform.VAAPI.Intel/x86_64/25.08\n",
  });
  const codes = (await flatpak.run(ctx)).map((f) => f.code);
  assert.ok(!codes.includes("flatpak/unused-runtimes"), `must not claim unused runtimes: ${codes.join(",")}`);
});

test("flatpak: no uninstall command is ever run as a probe", async () => {
  const seen = [];
  const ctx = stubCtx({ ...FP_UPDATES, [LIST_APPS]: "", [LIST_RUNTIMES]: "" });
  const run = ctx.run;
  ctx.run = async (cmd) => { seen.push(cmd); return run(cmd); };
  await flatpak.run(ctx);
  assert.ok(!seen.some((c) => /uninstall/.test(c)), `an uninstall command is not a read-only probe: ${seen.join(" | ")}`);
});

// -------------------------------------------------------- finding wording ----

test("security/no-firewall: the fix points at the distro's tool, not a shell command", async () => {
  const ctx = stubCtx({
    "nft list ruleset 2>/dev/null | head -5": "",
  });
  const fw = (await security.run(ctx)).find((f) => f.code === "security/no-firewall");
  assert.ok(fw, "no firewall service and an empty ruleset is the no-firewall case");
  // Naming the tools is fine; handing over a runnable command is not — it
  // would be wrong for every family whose front end is not the one chosen.
  assert.ok(!/\bsudo\b|`/.test(fw.fix || ""), `must not be a runnable command: ${fw.fix}`);
});

test("orphans: the openSUSE finding must not name dnf", async () => {
  const ctx = stubCtx({
    "zypper packages --unneeded 2>/dev/null": "i | libfoo\n i | libbar\n i | libbaz\n",
  }, { id: "opensuse-leap", id_like: "suse" });
  const [f] = await orphans.run(ctx);
  assert.equal(f.code, "orphans/some");
  assert.ok(!/\bdnf\b/.test(f.fix || ""), `openSUSE has no dnf: ${f.fix}`);
});
