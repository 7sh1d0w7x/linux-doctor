// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Kernel taint flags: `/proc/sys/kernel/tainted` is a bitmask the kernel sets
 * when it is no longer a clean upstream build — a proprietary module, an
 * out-of-tree driver, a forced load, a machine check. It is the first thing a
 * kernel developer asks for, and it is the usual reason a bug report comes back
 * with "please reproduce on a clean kernel".
 *
 * Severity is **info on purpose**. Every NVIDIA desktop carries the proprietary
 * bit, most immutable distributions carry the out-of-tree bit, and a permanent
 * medium on a healthy machine is exactly how a report teaches people to stop
 * reading it. A real fault behind a taint (machine check, bad page, oops) is
 * already reported by the hardware and crash checks, which read the same events
 * with the evidence attached. This finding answers "why was my bug report
 * ignored", not "what is broken".
 */
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";

/** Bit → meaning, from include/linux/panic.h (TAINT_*). */
const FLAGS = [
  [0, "proprietary module loaded"],
  [1, "module force-loaded"],
  [2, "CPU out of specification"],
  [3, "module force-unloaded"],
  [4, "machine check exception"],
  [5, "bad page"],
  [6, "user-requested taint"],
  [7, "kernel oops or die"],
  [8, "ACPI table overridden"],
  [9, "kernel warning"],
  [10, "staging driver"],
  [11, "firmware workaround"],
  [12, "out-of-tree module"],
  [13, "unsigned module"],
  [14, "soft lockup"],
  [15, "livepatch"],
  [16, "auxiliary taint"],
  [17, "randstruct plugin"],
  [18, "test module"],
];

const KNOWN_MASK = FLAGS.reduce((mask, [bit]) => mask | (1 << bit), 0);

export function decodeTaint(value) {
  const reasons = FLAGS.filter(([bit]) => (value & (1 << bit)) !== 0).map(([, label]) => label);
  // Bits newer than this table are reported by number rather than dropped: the
  // number is still useful to whoever reads the bug report.
  let rest = value & ~KNOWN_MASK;
  for (let bit = 0; rest !== 0 && bit < 32; bit += 1) {
    if (rest & (1 << bit)) {
      reasons.push(`unknown taint bit ${bit}`);
      rest &= ~(1 << bit);
    }
  }
  return reasons;
}

export const kernel = defineCheck({
  id: "kernel",
  title: "Kernel taint flags",
  category: "system",
  async run(ctx) {
    const res = await ctx.run("cat /proc/sys/kernel/tainted 2>/dev/null");
    if (!res.ok) return [];
    const raw = String(res.stdout).trim();
    if (!/^\d+$/.test(raw)) return [];
    const value = Number(raw);
    if (value === 0) return [];

    const reasons = decodeTaint(value);
    return [finding({
      severity: "info",
      code: "kernel/tainted",
      title: `Kernel is tainted (${reasons.length} flag${reasons.length === 1 ? "" : "s"})`,
      detail: `The running kernel has set ${reasons.length === 1 ? "a taint flag" : "taint flags"}: ${reasons.join(", ")}. Taint does not mean the kernel is broken — it means this is not a clean upstream build, and a bug report to the kernel developers will usually be closed unless the problem reproduces without these. Your distribution still supports the kernel.`,
      evidence: `tainted=${value}\n${reasons.join("\n")}`,
      fix: null,
      confidence: "high",
    })];
  },
});
