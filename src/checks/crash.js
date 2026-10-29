// SPDX-License-Identifier: GPL-3.0-or-later
import { lines } from "../utils.js";
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";
import { classifyHardwareLine } from "./shared.js";

/**
 * Crash and reboot history: unexpected restarts and coredumps are the #1
 * reason people reach for diagnostic tools after "my system just restarted".
 * Reads `journalctl --list-boots` for restart frequency and `coredumpctl list`
 * for recent crashes. Read-only.
 *
 * Boot count alone is a weak instability signal: image-based distros (Bazzite,
 * Fedora Atomic, …) reboot for every automatic update, and plenty of people
 * reboot on purpose. So a high boot count only becomes a finding after we look
 * for real crash evidence (kernel panics, oopses, machine-check/hardware
 * errors) and check whether an automatic-update mechanism explains the reboots.
 */
export const crash = defineCheck({
  id: "crash",
  title: "Crash and reboot history",
  category: "system",
  async run(ctx) {
    const findings = [];

    // --- Unexpected reboots: many boots in a short window ---
    // `journalctl --list-boots --since` is IGNORED by journalctl (--since does
    // not apply to --list-boots), so the JSON form is used and filtered here:
    // each entry carries first_entry/last_entry as µs since the epoch.
    const boots = await ctx.run('journalctl --list-boots -o json --no-pager 2>/dev/null');

    if (boots.missing) {
      findings.push(finding({
        severity: "info",
        code: "crash/skipped",
        title: "Crash history check skipped",
        detail: "`journalctl` is not available on this system (non-systemd), so crash and reboot history could not be checked.",
        evidence: "journalctl: not found",
        fix: null,
        confidence: "high",
      }));
      return findings;
    }

    if (boots.ok) {
      // Boots that overlapped the last 7 days. Fail-safe: if the JSON cannot
      // be parsed, count 0 rather than falling back to the lifetime table
      // (which produced a scary, wrong "N reboots in the last 7 days").
      const cutoffUs = (Date.now() - 7 * 24 * 60 * 60 * 1000) * 1000;
      let bootCount = 0;
      try {
        const entries = JSON.parse(boots.stdout);
        if (Array.isArray(entries)) {
          bootCount = entries.filter((b) => Number.isFinite(b?.last_entry) && b.last_entry >= cutoffUs).length;
        }
      } catch {
        bootCount = 0;
      }

      // 7–14 boots/week is normal (reboots for updates, kernel switches);
      // >14 is worth explaining. Only then do we pay for the extra commands.
      if (bootCount > 14) {
        // Real crash evidence, not the "Registered … planes with drm panic"
        // notifier lines that a plain `grep -i panic` would match.
        const kernelLog = await ctx.run(
          'journalctl -k --since "7 days ago" --no-pager 2>/dev/null | grep -iE "Kernel panic|Oops:|BUG: kernel|kernel BUG|machine check|Hardware Error|watchdog: BUG"'
        );
        const crashLines = kernelLog.ok && kernelLog.stdout.trim()
          ? lines(kernelLog.stdout)
              // "Intel machine check reporting enabled on CPU#N" is a per-CPU
              // boot banner, and the hardware check already knows how to reject
              // it. Without this filter a reboot-heavy Intel machine reported
              // crash/panic (high) with a boot banner as its evidence.
              .filter((l) => classifyHardwareLine(l) !== null || !/machine check|hardware error/i.test(l))
              .slice(0, 3)
          : [];

        const autoUpdate = await detectAutoUpdate(ctx);

        if (crashLines.length > 0) {
          findings.push(finding({
            severity: "high",
            code: "crash/panic",
            title: `Kernel or hardware errors detected in the last 7 days`,
            detail: `The kernel log contains panic/oops or hardware-error messages from the past week (the system rebooted ${bootCount} times in the same window). These are the events worth investigating — a crash, not an update, is the likely culprit.`,
            evidence: crashLines.join("\n"),
            fix: "Inspect the most recent event: `journalctl -k -b -1 | tail -120`. Machine-check/hardware errors usually mean bad RAM or overheating (run `memtest86+`); a `BUG:`/`Oops:` may be a kernel bug — check for a newer kernel. Software crash? Look at `coredumpctl info <PID>` below.",
            confidence: "high",
          }));
        } else if (autoUpdate.active) {
          // On atomic/image-based distros every applied update needs a reboot,
          // so many boots + no crash evidence = expected behavior.
          findings.push(finding({
            severity: bootCount > 20 ? "medium" : "info",
            code: "crash/reboots",
            title: `${bootCount} reboots in the last 7 days`,
            detail: `The system rebooted ${bootCount} times in the past week, which lines up with automatic updates (${autoUpdate.evidence}). No kernel panic or hardware error was found in the log — on an image-based distro each update applies on reboot, so this is expected rather than a sign of instability.`,
            evidence: `journalctl --list-boots --since "7 days ago" → ${bootCount} entries · no kernel panic / hardware errors found`,
            fix: "If the reboots were not actually caused by updates (or were not intentional), check `journalctl -b -1 -p err` for the reason behind the most recent one.",
            confidence: "high",
          }));
        } else if (bootCount > 20) {
          findings.push(finding({
            severity: "high",
            code: "crash/reboots",
            title: `${bootCount} reboots in the last 7 days`,
            detail: `The system rebooted ${bootCount} times in the past week — far more than the typical 7–14 from updates and kernel switches. Frequent reboots usually point to a kernel panic, a failing power supply, or an overheating CPU.`,
            evidence: `journalctl --list-boots --since "7 days ago" → ${bootCount} entries`,
            fix: "Check `journalctl -b -1 -p err` for the reason behind the most recent unexpected reboot, and look for kernel panics in `journalctl -k --since \"7 days ago\" | grep -i \"kernel panic\"`.",
            confidence: "high",
          }));
        } else {
          findings.push(finding({
            severity: "medium",
            code: "crash/reboots",
            title: `${bootCount} reboots in the last 7 days`,
            detail: `The system rebooted ${bootCount} times in the past week. This is above the typical range and may indicate an issue — but it could also be normal if you installed several kernel updates.`,
            evidence: `journalctl --list-boots --since "7 days ago" → ${bootCount} entries`,
            fix: "If reboots were not intentional, check `journalctl -b -1 -p err` for the cause of the most recent one.",
            confidence: "medium",
          }));
        }
      }
    }

    // --- Coredumps: crashes in the last 24 hours ---
    // `--json=short` first: the text table ends with a SIZE column and its EXE
    // path may contain spaces, so grouping by column is guesswork. Older
    // systemd has no --json; the table stays as a fallback.
    const coreJson = await ctx.run(
      'coredumpctl list --json=short --since "24 hours ago" --no-pager 2>/dev/null'
    );
    const core = await ctx.run(
      'coredumpctl list --since "24 hours ago" --no-pager 2>/dev/null | tail -n +2'
    );

    // SIGTRAP comes from debuggers and ptrace-based tools (gdb, some
    // emulators/JITs) — an intentional signal, not a crash. Everything else
    // (SIGSEGV, SIGABRT, SIGBUS, SIGILL, …) is a genuine crash.
    const SIGTRAP = 5;
    let exes = [];
    let rawRows = [];
    if (coreJson.ok && coreJson.stdout.trim().startsWith("[")) {
      try {
        exes = JSON.parse(coreJson.stdout)
          .filter((r) => r && r.sig !== SIGTRAP)
          .map((r) => String(r.exe || "unknown"));
      } catch {
        exes = [];
      }
    }
    if (!exes.length && core.ok && core.stdout.trim()) {
      rawRows = lines(core.stdout)
        .filter((l) => !/^TIME\s/.test(l))
        .filter((l) => !/\sSIGTRAP\s/.test(` ${l} `));
      // In `coredumpctl list` the executable is the field after COREFILE
      // (present/none/missing/error), followed by the size.
      exes = rawRows.map((l) => {
        const m = l.match(/\s(?:present|none|missing|error)\s+(.+?)(?:\s+[\d.]+[KMG]?)?$/);
        return m ? m[1] : l;
      });
    }

    if (exes.length) {
      const byExe = new Map();
      for (const e of exes) {
        const name = e.split("/").pop() || e;
        byExe.set(name, (byExe.get(name) || 0) + 1);
      }
      const ranked = [...byExe.entries()].sort((a, b) => b[1] - a[1]);
      const [topName, topCount] = ranked[0];
      // Crashes concentrated in one executable are that program's problem.
      // Crashes spread across unrelated programs are the pattern that hints at
      // a shared library, an update, or the hardware — which is the only case
      // where telling someone to test their RAM is fair. 60% rather than 80%:
      // a real machine also crashes a few unrelated things (a portal during
      // logout, a keyring daemon), and 26 of 33 is plainly one program.
      const concentrated = ranked.length === 1 || topCount >= Math.max(3, exes.length * 0.6);
      const summary = ranked.slice(0, 5).map(([name, n]) => `${n}\t${name}`).join("\n");
      const evidence = rawRows.length ? `${summary}\n\n${rawRows.slice(0, 2).join("\n")}` : summary;
      const others = ranked.slice(1, 4).map(([name, n]) => `${name} (${n})`).join(", ");

      if (exes.length > 5) {
        findings.push(finding({
          severity: "high",
          code: "crash/coredumps",
          title: `${exes.length} application crashes in the last 24 hours`,
          detail: concentrated
            ? `${exes.length} programs dumped core in the last 24 hours, ${topCount} of them from \`${topName}\`${others ? ` — the rest: ${others}` : ""}. One program failing over and over points at that program or the way it was started (its packaging, its libraries, a missing device), not at the hardware.`
            : `${exes.length} programs dumped core in the last 24 hours, spread across ${ranked.length} different executables (${others || topName}). Crashes spread across unrelated programs are the pattern that points at a shared library, a faulty update, or bad RAM.`,
          evidence,
          fix: concentrated
            ? `Inspect one with \`coredumpctl info <PID>\` and read the signal and the backtrace. A program that fails the same way every time is a bug in that program or its packaging; if it is a bundled app (AppImage, Flatpak), try a different build before suspecting the system.`
            : "Inspect the most recent crash with `coredumpctl info <PID>`, then test the memory with `memtest86+` — crashes across unrelated programs are the one pattern where bad RAM is worth ruling out.",
          confidence: "high",
        }));
      } else {
        findings.push(finding({
          severity: "medium",
          code: "crash/coredumps",
          title: `${exes.length} application crash(es) in the last 24 hours`,
          detail: `${exes.length} program(s) dumped core recently${concentrated ? `, all from \`${topName}\`` : ""}. Occasional crashes are normal, but a pattern may indicate a problem.`,
          evidence,
          fix: "Check `coredumpctl info <PID>` for the most recent crash to see which program failed and why.",
          confidence: "high",
        }));
      }
    }

    return findings;
  },
});

// Is there an automatic-update mechanism that would explain reboots? Image
// based (rpm-ostree/uupd, PackageKit offline updates) and classic distros
// (dnf-automatic, apt-daily-upgrade, unattended-upgrades) all apply updates on
// or around reboot. Timer units are the stable cross-distro signal; uupd and
// rpm-ostree binaries confirm the image-based case.
async function detectAutoUpdate(ctx) {
  const timers = await ctx.run(
    'systemctl list-timers --all --no-pager 2>/dev/null | grep -ioE "uupd\\.timer|rpm-ostree-autoupdate\\.timer|packagekit[a-z-]*\\.service|dnf-automatic[a-z-]*\\.timer|apt-daily[-a-z]*\\.timer|unattended-upgrades\\.service"'
  );
  const bins = await ctx.run("command -v uupd rpm-ostree 2>/dev/null");
  const evidence = [];
  if (timers.ok && timers.stdout.trim()) evidence.push(timers.stdout.trim().split("\n")[0].trim().toLowerCase());
  if (bins.ok && bins.stdout.trim()) evidence.push(lines(bins.stdout).join(", "));
  return { active: evidence.length > 0, evidence: [...new Set(evidence)].join(", ") || "automatic update timers" };
}
