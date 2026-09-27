// SPDX-License-Identifier: GPL-3.0-or-later
import { lines, shq } from "../utils.js";
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";

/**
 * Checks whether this system has any backup or snapshot mechanism set up:
 * common backup tools on PATH, Snapper (btrfs) configs, a Timeshift config,
 * and any scheduled backup systemd timers. All reads only — nothing is
 * mounted, created, or modified.
 */

export const backup = defineCheck({
  id: "backup",
  title: "Backups and snapshots",
  category: "data",
  async run(ctx) {
    const findings = [];

    const [tools, snapper, timeshift, timers, sysctlBin] = await Promise.all([
      ctx.run("for t in borg restic rclone duplicity timeshift pika-backup backintime deja-dup; do command -v \"$t\" 2>/dev/null; done"),
      ctx.run("ls /etc/snapper/configs 2>/dev/null"),
      ctx.run("[ -f /etc/timeshift/timeshift.json ] && echo configured"),
      ctx.run("systemctl list-timers --all --no-pager 2>/dev/null | grep -iE 'backup|borg|restic|timeshift|snapper|pika|deja' | grep -oE '[A-Za-z0-9_.@-]+\\.timer' | sort -u"),
      ctx.run("command -v systemctl 2>/dev/null"),
    ]);
    // Without systemctl the timer list is empty for a reason that is not "no
    // schedule": a non-systemd system (Alpine, Void) with a backup tool used to
    // get a false "nothing is scheduled".
    const canCheckSchedule = sysctlBin.ok && sysctlBin.stdout.trim() !== "";

    const toolsFound = lines(tools.stdout).map((p) => p.split("/").pop()).filter(Boolean);
    const extras = [];
    if (lines(snapper.stdout).length > 0) extras.push("snapper");
    if (timeshift.ok && timeshift.stdout.trim() !== "") extras.push("timeshift");
    const present = [...toolsFound, ...extras];
    const timerNames = lines(timers.stdout);

    if (present.length === 0) {
      // No backup tool is a deliberate setup choice, not a detected fault —
      // informational so the health score is not penalized for it.
      findings.push(finding({
        severity: "info",
        code: "backup/none",
        title: "No backup or snapshot tool detected",
        detail: "No backup tool (Borg, Restic, Timeshift, …) and no snapshot system (Snapper, Timeshift) was found. If this disk fails, the data on it is gone.",
        evidence: "tools: none · snapper configs: none · timeshift: none",
        fix: "Install one, e.g. `sudo dnf install timeshift` (Fedora/Bazzite), `sudo apt install timeshift` (Debian/Ubuntu), or a file-level tool like Borg (`sudo dnf install borgbackup`) and point it at an external disk.",
        confidence: "high",
      }));
      return findings;
    }

    if (timerNames.length === 0) {
      if (!canCheckSchedule) {
        findings.push(finding({
          severity: "info",
          code: "backup/unknown",
          title: "Backup scheduling could not be checked",
          detail: `${present.join(", ")} ${present.length > 1 ? "are" : "is"} installed, but \`systemctl\` is not available (this is not a systemd system), so whether the backup actually runs could not be verified.`,
          evidence: "scheduled: could not check (no systemctl)",
          fix: null,
          confidence: "high",
        }));
        return findings;
      }
      findings.push(finding({
        severity: "info",
        code: "backup/unscheduled",
        title: "Backup tools are installed, but nothing is scheduled",
        detail: `${present.join(", ")} ${present.length > 1 ? "are" : "is"} installed, but no backup systemd timer or cron job was found. A backup only protects you if it actually runs.`,
        evidence: "tools: " + present.join(", ") + "\nscheduled: none",
        fix: "Create a timer or cron job that runs the backup regularly, e.g. daily with a systemd timer, or use the tool's built-in scheduling (Timeshift/Snapper schedule their own snapshots).",
        confidence: "high",
      }));
      return findings;
    }

    // A scheduled backup that never actually ran is the most expensive
    // silent failure in self-hosting ("stopped in March, found in
    // September"). LastTriggerUSec is 0 for a timer that never triggered;
    // an unreadable value (non-systemd) means "unknown", never "stale".
    const staleLimit = ctx.thresholds.backupStaleDays ?? 30;
    const stale = [];
    for (const name of timerNames) {
      const show = await ctx.run(`systemctl show ${shq(name)} -p LastTriggerUSec --value 2>/dev/null`);
      if (!show.ok) continue;
      const usec = Number(show.stdout.trim());
      if (!Number.isFinite(usec)) continue;
      if (usec === 0) {
        stale.push(`${name} (scheduled but never ran)`);
      } else {
        const days = (Date.now() - usec / 1000) / 86400000;
        if (days > staleLimit) stale.push(`${name} (last ran ${Math.floor(days)} days ago)`);
      }
    }
    if (stale.length > 0) {
      findings.push(finding({
        severity: "medium",
        code: "backup/stale",
        title: "Scheduled backups are not running",
        detail: `A backup timer exists but the backup behind it is not happening: ${stale.join(", ")}. A backup that never runs protects nothing — this is usually a broken timer unit or a job that fails silently.`,
        evidence: stale.join("\n"),
        fix: `Check the timer state with \`systemctl status ${stale[0].split(" ")[0]}\` and its last error with \`journalctl -u ${stale[0].split(" ")[0]} --since "7 days ago"\`.`,
        confidence: "high",
      }));
      return findings;
    }

    findings.push(finding({
      severity: "info",
      code: "backup/ok",
      title: "Backups are set up",
      detail: `${present.join(", ")} ${present.length > 1 ? "are" : "is"} available and scheduled backup timer${timerNames.length > 1 ? "s" : ""} (${timerNames.join(", ")}) ${timerNames.length > 1 ? "are" : "is"} active.`,
      evidence: "tools: " + present.join(", ") + "\ntimers: " + timerNames.join(", "),
      fix: null,
      confidence: "high",
    }));
    return findings;
  },
});
