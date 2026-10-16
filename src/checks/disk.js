// SPDX-License-Identifier: GPL-3.0-or-later
import { lines, pct, num } from "../utils.js";
import { finding } from "../findings.js";
import { pkgCacheClean } from "../distro.js";
import { defineCheck } from "./define.js";

/**
 * Real partitions only. We deliberately exclude pseudo-filesystems and the
 * composefs/ostree root on immutable distros (Bazzite, Fedora Atomic, ...),
 * where the root always reports 100% full and that is completely normal.
 */
const EXCLUDED_FS = new Set([
  "tmpfs", "devtmpfs", "squashfs", "overlay", "proc", "sysfs",
  "cgroup2", "efivarfs", "securityfs", "debugfs", "tracefs", "fusectl",
  "devpts", "mqueue", "configfs", "binfmt_misc", "autofs", "ramfs",
  "bpf", "pstore", "hugetlbfs",
]);

/**
 * Build the high/medium finding for one mount point, or null when it is fine.
 * `device` is the backing filesystem (the df source column): on btrfs and ZFS
 * several mounts share one pool, so findings for the same device are collapsed
 * by dedupe — one pool, one penalty, not one per subvolume/dataset.
 */
function diskFinding({ mount, use, avail, evidence, root = false, t, device, dist }) {
  const label = root ? "Root partition" : `Partition ${mount}`;
  const free = `${Math.round(avail / 1024 ** 3)} GB free`;
  if (use >= t.diskFullPct) {
    return finding({
      severity: "high",
      code: "disk/full",
      dedupeKey: `disk:${device}`,
      title: `${label} is nearly full`,
      detail: `${root ? "The root partition (/) " : `The partition mounted at ${mount} `}is ${use}% full with only ${free}. A full disk can slow the system and break updates.`,
      evidence,
      fix: root
        ? `Free up space: \`sudo journalctl --vacuum-size=500M\`, then ${pkgCacheClean(dist)}, and find large files with \`du -xh -d1 / 2>/dev/null | sort -rh | head -20\`.`
        : `Find large files with \`du -xh -d1 ${mount} 2>/dev/null | sort -rh | head -20\` and delete or move what you no longer need.`,
      confidence: "high",
    });
  }
  if (use >= t.diskWarnPct) {
    return finding({
      severity: "medium",
      code: "disk/full",
      dedupeKey: `disk:${device}`,
      title: `${label} is getting full`,
      detail: `${root ? "The root partition (/) " : `The partition mounted at ${mount} `}is ${use}% full (${free}). It is not urgent yet, but it is worth cleaning up.`,
      evidence,
      fix: `Check \`du -xh -d1 ${mount} 2>/dev/null | sort -rh | head -20\` and clean up large files or logs.`,
      confidence: "high",
    });
  }
  return null;
}

export const disk = defineCheck({
  id: "disk",
  title: "Disk space",
  category: "system",
  async run(ctx) {
    const findings = [];
    const t = ctx.thresholds;
    const res = await ctx.run("df -P -B1 --exclude-type=tmpfs --exclude-type=devtmpfs --exclude-type=squashfs --exclude-type=overlay --exclude-type=proc --exclude-type=sysfs --exclude-type=cgroup2");
    if (!res.ok) {
      // BusyBox/minimal `df` rejects the GNU flags: say the check was skipped
      // instead of silently reporting nothing (a silent core check is worse).
      return [finding({
        severity: "info",
        code: "disk/skipped",
        title: "Disk space check skipped",
        detail: "`df` is not available or does not support the required flags on this system (BusyBox/minimal images), so disk usage could not be checked.",
        evidence: (res.stderr || "df: unusable output").trim().slice(0, 200),
        fix: null,
        confidence: "medium",
      })];
    }

    for (const l of lines(res.stdout).slice(1)) {
      const p = l.split(/\s+/);
      if (p.length < 6) continue;
      const mount = p[5];
      // AppImage runtime mounts (fuse-mounted squashfs at /tmp/.mount_*,
      // device named *.AppImage) always report 100% by design — a fixed-size
      // image, not a filling disk. Same false-positive class as the excluded
      // squashfs/overlay layers above; df cannot exclude them by type because
      // the fstype embeds the app name (fuse.Foo.AppImage), so skip by shape.
      if (p[0].includes(".AppImage") || mount.includes("/.mount_")) continue;
      const use = pct(p[4]);
      const avail = num(p[3]);
      if (use <= 0 || mount === "/") continue; // root handled separately below
      const f = diskFinding({ mount, use, avail, evidence: l, t, device: p[0], dist: ctx.dist });
      if (f) findings.push(f);
    }

    // Root mount: skip composefs/ostree layers (immutable distros), keep real roots.
    const rootLine = lines(res.stdout).find((l) => l.split(/\s+/)[5] === "/");
    if (rootLine) {
      const p = rootLine.split(/\s+/);
      const fs = p[0];
      const isVirtualRoot = fs.includes("composefs") || fs.includes("ostree") || EXCLUDED_FS.has(fs);
      if (!isVirtualRoot) {
        const f = diskFinding({ mount: "/", use: pct(p[4]), avail: num(p[3]), evidence: rootLine, root: true, t, device: p[0], dist: ctx.dist });
        if (f) findings.push(f);
      }
    }
    return findings;
  },
});
