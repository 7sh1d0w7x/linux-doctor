// SPDX-License-Identifier: GPL-3.0-or-later
import { lines, num, fmtBytes } from "../utils.js";
import { pkgInstall } from "../distro.js";

import { defineCheck } from "./define.js";
import { finding } from "../findings.js";
import { detectContainer } from "./shared.js";

export const memory = defineCheck({
  id: "memory",
  title: "Memory pressure",
  category: "system",
  async run(ctx) {
    const findings = [];
    const t = ctx.thresholds;

    // `/proc/meminfo` is not namespaced: inside a container `free` reports the
    // HOST's memory, not this container's. Reporting it as the container's is
    // the same lie `load` used to tell, so the check stays quiet there.
    const { inContainer, virtType } = await detectContainer(ctx);
    if (inContainer) {
      findings.push(finding({
        severity: "info",
        code: "memory/skipped",
        title: "Memory check skipped (container)",
        detail: "`/proc/meminfo` is not namespaced: inside a container `free` reports the HOST's memory, not this container's. The container's real limit is its cgroup, which this check does not model, so it stays quiet. Run it on the host for a real number.",
        evidence: `container detected: ${virtType && virtType !== "none" ? virtType : "container marker"}`,
        fix: null,
        confidence: "high",
      }));
      return findings;
    }

    const mem = await ctx.run("free -b");
    if (mem.missing) {
      findings.push(finding({
        severity: "info",
        code: "memory/skipped",
        title: "Memory check skipped",
        detail: "`free` is not available on this system, so memory pressure could not be checked.",
        evidence: "free: not found",
        fix: `Install procps (${pkgInstall(ctx.dist, { fedora: "procps-ng", arch: "procps-ng", "*": "procps" })}) and re-run.`,
        confidence: "high",
      }));
      return findings;
    }
    if (!mem.ok) return findings;

    const memLine = lines(mem.stdout).find((l) => l.startsWith("Mem:"));
    if (!memLine) return findings;
    const header = lines(mem.stdout)[0] || "";
    const parts = memLine.split(/\s+/);
    const total = num(parts[1]);
    if (total === 0) return findings;
    // `available` exists in procps-ng's free (the header says so). BusyBox and
    // older free lack it, so field 6 would be `cached` — fall back to the
    // kernel's MemAvailable instead of computing a ratio from the wrong field.
    let available = /\bavailable\b/i.test(header) ? num(parts[6]) : null;
    if (available === null) {
      const ma = await ctx.run("grep -m1 '^MemAvailable:' /proc/meminfo 2>/dev/null");
      const kb = num(String(ma.stdout).trim().split(/\s+/)[1]);
      if (ma.ok && kb > 0) available = kb * 1024;
    }
    if (available === null) {
      findings.push(finding({
        severity: "info",
        code: "memory/skipped",
        title: "Memory check skipped (no availability figure)",
        detail: "Neither `free` nor /proc/meminfo reported available memory on this system, so memory pressure could not be computed.",
        evidence: "no available/MemAvailable field",
        fix: null,
        confidence: "medium",
      }));
      return findings;
    }
    const used = total - available;

    const availRatio = available / total;
    let severity = null;
    if (availRatio < t.memLowRatio) severity = "high";
    else if (availRatio < t.memWarnRatio) severity = "medium";

    const swap = await ctx.run("swapon --show --bytes");
    let swapUsed = 0;
    let swapTotal = 0;
    const swapDevices = [];
    if (swap.ok) {
      for (const l of lines(swap.stdout).slice(1)) {
        const p = l.split(/\s+/);
        if (p[0]) swapDevices.push(p[0]);
        swapTotal += num(p[2]);
        swapUsed += num(p[3]);
      }
    }
    // zram is compressed RAM, not a disk. "Being pushed to swap" describes disk
    // I/O pressure that is not happening, and the same report already says the
    // zram is healthy — two sentences contradicting each other.
    const zramOnly = swapDevices.length > 0 && swapDevices.every((d) => /zram/i.test(d));

    const swapped = swapUsed > 0
      ? zramOnly
        ? ` and ${fmtBytes(swapUsed)} is held in compressed zram swap`
        : ` and ${fmtBytes(swapUsed)} is being pushed to swap`
      : "";
    if (severity) {
      findings.push(finding({
        severity,
        code: "memory/low",
        title: "System is low on usable memory",
        detail: `Your system has ${fmtBytes(total)} of RAM, but only ${fmtBytes(available)} is usable right now (${fmtBytes(used)} in use${swapped}). Low memory is the most common cause of a sluggish Linux desktop.`,
        evidence: lines(mem.stdout).slice(0, 2).join("\n"),
        fix: "Close apps you are not using (especially browsers with many tabs), then re-run this check. If it stays low, consider adding RAM or enabling zram.",
        confidence: "high",
      }));
    } else if (swapUsed > 0) {
      findings.push(finding({
        severity: "info",
        code: "memory/swap",
        title: "Swap is in use",
        detail: zramOnly
          ? `${fmtBytes(swapUsed)} of ${fmtBytes(swapTotal)} compressed zram swap is in use. zram lives in RAM, so this is compression, not disk I/O.`
          : `${fmtBytes(swapUsed)} of ${fmtBytes(swapTotal)} swap is in use. Some swap activity is normal, but sustained swapping means the system is tight on memory.`,
        evidence: lines(swap.stdout).join("\n"),
        fix: "If apps feel slow, close memory-heavy apps and re-run this check.",
        confidence: "high",
      }));
    }
    return findings;
  },
});
