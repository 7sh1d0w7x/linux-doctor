// SPDX-License-Identifier: GPL-3.0-or-later
import { journalLines } from "../utils.js";
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";
import { classifyHardwareLine } from "./shared.js";

/**
 * Checks the kernel log for hardware errors: machine check exceptions (MCE —
 * uncorrected, serious) and corrected ECC/memory errors (EDC — the hardware
 * caught and fixed a bit flip, which repeated often means a failing DIMM).
 * Read-only; same journalctl separator filtering as the other log checks.
 */

export const hardware = defineCheck({
  id: "hardware",
  title: "Hardware errors (MCE/ECC)",
  category: "hardware",
  async run(ctx) {
    const findings = [];

    // Two different questions: "is there a kernel log I can read" and "does it
    // contain anything worth classifying". The content grep below exits 1 when
    // nothing matches, so its status means "found something", not "could read
    // the log" — and using it as the readability gate made the healthy case
    // silent on a machine with no MCE/EDAC line at all.
    const readable = await ctx.run("command -v journalctl 2>/dev/null");
    const logReadable = readable.ok && readable.stdout.trim() !== "";
    if (!logReadable) {
      findings.push(finding({
        severity: "info",
        code: "hardware/skipped",
        title: "Hardware error check skipped",
        detail: "`journalctl` is not available (this is not a systemd system), so the kernel log could not be read for MCE/ECC errors.",
        evidence: "journalctl: not found",
        fix: null,
        confidence: "high",
      }));
      return findings;
    }

    // The shell grep is deliberately wide (it is one cheap read): the words
    // "mce" and "edac" are also carried by routine boot lines, so the
    // classification happens in JS where a benign line can be rejected instead
    // of becoming a finding. See classifyHardwareLine.
    const ker = await ctx.run(
      'journalctl -k --since "-7 days" --no-pager -o short 2>/dev/null | grep -iE "mce|machine check|hardware error|edac|corrected error|ecc error"'
    );
    const all = journalLines(ker.stdout, { tail: 40 });
    const mceLines = all.filter((l) => classifyHardwareLine(l) === "mce").slice(-5);
    const edcAll = all.filter((l) => classifyHardwareLine(l) === "ecc");
    const edcLines = edcAll.slice(-5);

    if (mceLines.length > 0) {
      findings.push(finding({
        severity: "high",
        code: "hardware/mce",
        title: "Machine check exceptions detected",
        detail: "The kernel recorded machine check exceptions — uncorrected hardware errors. These are a strong sign of failing CPU, memory, or a motherboard issue, and they can corrupt data.",
        evidence: mceLines.join("\n"),
        fix: "Back up your data now, then test the hardware: run a memory test (e.g. Memtest86+ from your boot menu) and check the CPU temperature and cooling. If the errors persist, replace the suspect component.",
        confidence: "high",
      }));
    } else if (edcLines.length > 0) {
      // EDAC reports three very different situations with the same vocabulary.
      // A UE went uncorrected (data loss). Repeated CEs mean a DIMM is going.
      // One CE in a week is ECC doing its job, and our own detail said so
      // while the severity disagreed: it dropped 8 points for normal
      // operation, the kind of grading that teaches people to stop reading.
      const uncorrected = edcLines.some((l) => /\bUE\b|uncorrected|unrecoverable/i.test(l));
      const repeated = edcAll.length >= 2;
      findings.push(finding({
        severity: uncorrected ? "high" : repeated ? "medium" : "info",
        code: "hardware/ecc",
        title: uncorrected
          ? "Uncorrected memory errors (ECC)"
          : repeated
            ? "Repeated corrected memory errors (ECC)"
            : "A corrected memory error (ECC)",
        detail: uncorrected
          ? "The memory controller reported an uncorrected error: a bit flip it could not fix. Whatever that memory held was wrong, and the module is the suspect. Treat this as data loss, not as a warning to watch."
          : repeated
            ? "The memory controller corrected several bit-flip errors in the last week. ECC handled them, but a rising rate points at a DIMM on its way out, so worth a memory test rather than a wait."
            : "The memory controller corrected one bit-flip error in the last week. A single one is ECC doing its job, not a fault. It is listed so you can see it if it starts repeating.",
        evidence: edcLines.join("\n"),
        fix: uncorrected
          ? "Back up your data now. Run a memory test (Memtest86+ from your boot menu), reseat the suspect DIMM, and replace it if the test fails."
          : repeated
            ? "Test the memory (Memtest86+), then reseat or replace the suspect DIMM."
            : null,
        confidence: uncorrected ? "high" : "medium",
      }));
    } else if (logReadable) {
      findings.push(finding({
        severity: "info",
        code: "hardware/ok",
        title: "No hardware errors logged",
        detail: "No machine check exceptions or corrected memory errors were found in the last 7 days of kernel logs.",
        evidence: "mce: none · edac/ecc: none",
        fix: null,
        confidence: "high",
      }));
    }

    return findings;
  },
});
