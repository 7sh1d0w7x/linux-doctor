// SPDX-License-Identifier: GPL-3.0-or-later
import { journalLines, plural } from "../utils.js";
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";
import { classifyHardwareLine } from "./shared.js";

/**
 * Messages that look scary but are routine noise on most distros.
 * We suppress them from the report so the doctor only surfaces what matters.
 */
const NOISE_PATTERNS = [
  /SELinux is preventing/i,
  /setroubleshoot/i,
  /Failed to resolve group/i,
  /Failed to resolve user/i,
  /Remote address changed/i,
  /All features that should not exist/i,
  /already exists and is not a directory/i,
  /Create-Printer-Subscriptions/i,
  /client-error-bad-request/i,
  /failed to retrieve rpm info/i,
  /busno=/i,
  /TDX not supported by the host platform/i,
  // KDE's lock screen writes this when you retype a wrong password too fast,
  // a few times in a row (seen on the maintainer's Bazzite box: 6 lines that
  // became a medium "6 recognized errors" on a healthy desktop). The generic
  // pattern stays meaningful, since the same string from sshd is worth seeing.
  /kscreenlocker_greet.*Authentication attempt too soon/i,
  // Common benign kernel/firmware messages that reach priority err but are
  // routine on most distros — present on nearly every machine.
  /problem loading x\.509 certificate/i,
  /elf object binary architecture/i,
  /invalid 7-bit i2c address/i,
  /failed to query container image base metadata/i,
  /module libseccomp/i,
  // PipeWire loses an ALSA device when the monitor sleeps (HDMI/S-PDIF):
  // "iec958:0p: snd_pcm_drop: No such device" on a desktop whose audio works.
  /spa\.alsa:.*No such device/i,
  // dbus-broker cannot activate NetworkManager's dispatcher during early boot.
  // It retries and succeeds; the line still reaches priority err.
  /Activation request for 'org\.freedesktop\.nm_dispatcher' failed/i,
];

/**
 * Entries that have their own dedicated check. Reporting them here too would
 * show the same root cause twice (and double the health-score penalty), so
 * they are filtered out entirely and left to the specialized check.
 */
const DEFERRED_PATTERNS = [
  /system-sleep.*failed/i, // → suspend check
  /failed to start|failed with result|entered failed state/i, // → services check
  // MCE/ECC lines are deferred to the hardware check via classifyHardwareLine
  // (called in the loop below), which also rejects the routine boot lines that
  // merely mention "mce"/"edac".
];

const MEANINGFUL_PATTERNS = [
  /pam_unix\([^)]*\):.*could not identify/i,
  /Authentication attempt too soon/i,
  /oom[-_](?:kill|reap)|\bout of memory\b/i,
  /i\/o error/i,
  /read-only file system/i,
  /corrupt/i,
  /segfault/i,
  /kernel panic/i,
];

export const journal = defineCheck({
  id: "journal",
  title: "System log errors (last 24 hours)",
  category: "software",
  async run(ctx) {
    const findings = [];
    // Strip journalctl's "-- Boot ... --" separators: they appear once per
    // boot even when there are no errors, and counting them would inflate the
    // error count on systems that rebooted within the window.
    //
    // The capture ceiling is raised to 64 MB: a noisy system easily exceeds
    // the 4 MB default, and losing that output silently would make the exact
    // machine this check exists for look "clean". Truncated output is still
    // processed — the partial lines we did capture are real errors.
    const res = await ctx.run(`journalctl -p err --since "-24 hours" --no-pager -o short 2>/dev/null`, { maxBuffer: 64 * 1024 * 1024 });
    if (res.missing) {
      findings.push(finding({
        severity: "info",
        code: "journal/skipped",
        title: "System log check skipped",
        detail: "`journalctl` is not available on this system (no systemd journal), so log errors could not be inspected.",
        evidence: "journalctl: not found",
        fix: null,
        confidence: "high",
      }));
      return findings;
    }
    if (!res.ok && !res.truncated) return findings;
    if (!res.stdout.trim()) return findings;

    // `-o short` prints a multi-line message (a crash and its stack trace) as
    // one timestamped head line followed by indented continuation lines. Only
    // the head lines are entries: counting the continuation lines once turned a
    // handful of crashes into a "3062 unrecognized log entries" finding. The
    // fallback keeps the check alive if a future journalctl drops the prefix
    // instead of silently reporting nothing.
    const ENTRY_RE = /^[A-Z][a-z]{2} \d{2} \d{2}:\d{2}:\d{2} /;
    const raw = journalLines(res.stdout);
    const entries = raw.filter((l) => ENTRY_RE.test(l));
    const logLines = entries.length > 0 ? entries : raw;
    const noise = [];
    const meaningful = [];
    const unknown = [];
    for (const l of logLines) {
      if (classifyHardwareLine(l) !== null) {
        continue; // owned by the hardware check
      }
      if (DEFERRED_PATTERNS.some((re) => re.test(l))) {
        continue; // owned by a dedicated check (suspend, services)
      }
      if (NOISE_PATTERNS.some((re) => re.test(l))) {
        noise.push(l);
        continue;
      }
      if (MEANINGFUL_PATTERNS.some((re) => re.test(l))) {
        meaningful.push(l);
        continue;
      }
      // Not recognized as either benign or suspicious. These are counted but
      // never escalate the severity — an unrecognized message is more likely
      // our filter missing a benign pattern than a real fault.
      unknown.push(l);
    }

    // The count/evidence above is driven only by entries we recognize as
    // suspicious. Unrecognized ones get their own low-key informational row.
    if (meaningful.length > 0) {
      // Aggregate duplicates so 60 copies of the same message become one line.
      const counts = new Map();
      for (const l of meaningful) {
        const key = l.replace(/^[A-Z][a-z]{2} \d{2} \d{2}:\d{2}:\d{2} \S+ /, "").slice(0, 90);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const top = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([msg, count]) => `${msg}  (×${count})`);
      const extra = unknown.length > 0 ? ` Plus ${plural(unknown.length, "unrecognized entry")} (possibly benign).` : "";
      findings.push(finding({
        severity: meaningful.length > 3 ? "medium" : "info",
        code: "journal/errors",
        title: `${plural(meaningful.length, "recognized error")} in the last 24 hours (${counts.size} unique)`,
        detail: `These log entries match patterns that usually indicate a real problem.${extra} Use \`journalctl -p err -b\` to investigate.`,
        evidence: top.join("\n"),
        fix: "Look up the exact message on your distro's docs or forums. For suspend/resume failures, see the 'Suspend hooks are failing' finding.",
        confidence: "low",
      }));
    } else if (unknown.length > 0) {
      // Aggregate duplicates so 60 copies of the same message become one line.
      const counts = new Map();
      for (const l of unknown) {
        const key = l.replace(/^[A-Z][a-z]{2} \d{2} \d{2}:\d{2}:\d{2} \S+ /, "").slice(0, 90);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      const top = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([msg, count]) => `${msg}  (×${count})`);
      findings.push(finding({
        severity: "info",
        code: "journal/unknown",
        title: `${unknown.length} unrecognized log ${unknown.length === 1 ? "entry" : "entries"} in the last 24 hours`,
        detail: "These error-level entries are not recognized as either routine noise or a known problem. Most are benign, but it is worth a glance if one stands out.",
        evidence: top.join("\n"),
        fix: null,
        confidence: "low",
      }));
    }

    if (noise.length > 0 && meaningful.length === 0 && unknown.length === 0) {
      findings.push(finding({
        severity: "info",
        code: "journal/no-noise",
        title: "No significant errors — only routine noise",
        detail: `The last 24 hours of the error log contain only messages we recognize as normal on most systems (SELinux noise, udev messages, printer discovery, and similar). Nothing to worry about.`,
        evidence: `Filtered out ${noise.length} known-benign entries.`,
        fix: null,
        confidence: "high",
      }));
    }
    return findings;
  },
});
