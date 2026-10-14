// SPDX-License-Identifier: GPL-3.0-or-later
import { lines } from "../utils.js";
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";
import { svcCmd } from "../distro.js";

/**
 * Time synchronization. A drifting clock silently breaks HTTPS, cron jobs,
 * and time-based tokens — and "no NTP daemon" is one of the most common
 * causes. Reads only; skipped on systems without timedatectl (non-systemd).
 */

export const ntp = defineCheck({
  id: "ntp",
  title: "Time synchronization",
  category: "network",
  async run(ctx) {
    const findings = [];

    const td = await ctx.run("timedatectl show -p NTPSynchronized 2>/dev/null");
    if (td.missing) {
      findings.push(finding({
        severity: "info",
        code: "ntp/skipped",
        title: "Time sync check skipped",
        detail: "`timedatectl` is not available on this system (non-systemd), so clock synchronization could not be checked.",
        evidence: "timedatectl: not found",
        fix: null,
        confidence: "high",
      }));
      return findings;
    }
    if (!td.ok || td.stdout.trim() === "") return findings;

    const synced = /^NTPSynchronized=yes$/im.test(td.stdout);

    if (synced) {
      findings.push(finding({
        severity: "info",
        code: "ntp/ok",
        title: "Time is synchronized",
        detail: "The system clock is kept in sync over the network (NTP).",
        evidence: td.stdout.trim(),
        fix: null,
        confidence: "high",
      }));
      return findings;
    }

    // Not synchronized: is any NTP daemon even running? (is-active with
    // multiple units prints one line per unit; any "active" means one is.)
    const daemon = await ctx.run("systemctl is-active systemd-timesyncd chronyd ntpd 2>/dev/null || true");
    const daemonActive = daemon.ok && /^active$/m.test(daemon.stdout);

    if (!daemonActive) {
      findings.push(finding({
        severity: "medium",
        code: "ntp/unsynced",
        title: "Clock is not kept in sync",
        detail:
          "No NTP client (systemd-timesyncd, chronyd, or ntpd) is running, so the clock will drift. A wrong clock breaks HTTPS, cron jobs, and time-based tokens.",
        evidence: "no active NTP daemon",
        fix: (ctx.dist?.init || "systemd") === "systemd"
          ? `Enable one: \`${svcCmd(ctx.dist, "enable-now", "systemd-timesyncd")}\` (most systems) or \`${svcCmd(ctx.dist, "enable-now", "chronyd")}\` (Fedora/RHEL).`
          : `Enable a time daemon: \`${svcCmd(ctx.dist, "enable-now", "chronyd")}\`.`,
        confidence: "high",
      }));
    } else {
      findings.push(finding({
        severity: "medium",
        code: "ntp/pending",
        title: "NTP daemon is running but time is not synchronized yet",
        detail:
          "An NTP client is active, but the clock has not synchronized yet — it may need a few minutes after boot, or the NTP servers may be unreachable.",
        evidence: td.stdout.trim(),
        fix: "Check `timedatectl timesync-status` and `timedatectl status`. If it stays unsynchronized, check DNS and that UDP/123 is not blocked.",
        confidence: "medium",
      }));
    }
    return findings;
  },
});
