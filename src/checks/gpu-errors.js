// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * GPU errors in the kernel log: NVIDIA `Xid`, AMDGPU ring timeouts and GPU
 * resets, Intel GPU hangs, and protection faults.
 *
 * These are the failures a gaming or compute desktop actually feels — a
 * compositor stutter, a game that closes, a machine that comes back to a black
 * screen — and they never show up as "the GPU is missing" (gpu.js) or "VRAM is
 * full" (gpu-usage.js). Xid 79 is the classic: the GPU fell off the bus, which
 * is power or seating far more often than software.
 *
 * Read-only: journalctl -k for seven days, dmesg as the fallback. One finding
 * per class, with the count, because "37 Xid 13" is a different situation from
 * one.
 */
import { journalLines } from "../utils.js";
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";

const PATTERN = "'NVRM: Xid|amdgpu.*ring .*timeout|amdgpu.*GPU reset|GPU reset failed|VM_L2_PROTECTION_FAULT|GPU HANG|i915.*(GPU HANG|resetting)'";
const FROM_JOURNAL = `journalctl -k --since "-7 days" --no-pager -o short 2>/dev/null | grep -iE ${PATTERN} | tail -n 60`;
const FROM_DMESG = `dmesg 2>/dev/null | grep -iE ${PATTERN} | tail -n 60`;

/** Xid codes that mean the card is gone or its memory is failing, not a driver bug. */
const HIGH_XID = new Set([79, 94, 95]);

/** One classifier per failure class, so a burst of one does not hide the other. */
function classify(line) {
  const xid = /Xid(?:\s*\([^)]*\))?:\s*(\d+)/i.exec(line);
  if (xid) return { id: "xid", xid: Number(xid[1]) };
  if (/GPU reset failed/i.test(line)) return { id: "reset-failed" };
  if (/amdgpu.*ring .*timeout/i.test(line)) return { id: "ring-timeout" };
  if (/VM_L2_PROTECTION_FAULT/i.test(line)) return { id: "fault" };
  if (/GPU HANG/i.test(line)) return { id: "hang" };
  return null;
}

const META = {
  "reset-failed": {
    title: "GPU reset failed",
    detail: "The kernel tried to recover the GPU with a reset and the reset itself failed. After this the driver is usually unusable until reboot, which is why the screen or the game stays broken.",
    fix: "Reboot to clear the state, then check `journalctl -k -b -1 | grep -iE 'amdgpu|drm'` around the event. If it repeats, try a newer kernel or Mesa first; a card that keeps failing to reset is often a power or thermal problem.",
  },
  "ring-timeout": {
    title: "AMDGPU ring timeout",
    detail: "A GPU command ring stopped responding and the kernel had to reset it. One occurrence is usually a driver or firmware bug; repeated ones point at the card, its power, or overheating.",
    fix: "Capture the event with `journalctl -k --since \"-1 hour\" | grep -iE 'amdgpu|ring|reset'` and check `sensors` for the GPU temperature. A newer kernel/Mesa fixes many of these; repeated timeouts on a hot card do not.",
  },
  fault: {
    title: "GPU memory protection fault",
    detail: "The GPU tried to touch memory it was not allowed to (VM_L2_PROTECTION_FAULT). The kernel recovers, but the process that owned the buffer usually does not — this is a common way a game or a compute job dies.",
    fix: "Note which program was running and whether it uses Vulkan or ROCm. Update Mesa/the compute stack first; if one application triggers it consistently, that is a bug in the application, not in the card.",
  },
  hang: {
    title: "Intel GPU hang",
    detail: "The Intel GPU stopped making progress and the kernel reset it. The desktop usually recovers with a flicker, but the application that was rendering loses its work.",
    fix: "Update the kernel and Mesa first. If it repeats, the kernel log carries an error state that upstream asks for — keep `journalctl -k` output from the moment it happened.",
  },
};

export const gpuErrors = defineCheck({
  id: "gpu-errors",
  title: "GPU errors in the log",
  category: "graphics",
  async run(ctx) {
    const [hasJournal, hasDmesg] = await Promise.all([
      ctx.run("command -v journalctl 2>/dev/null"),
      ctx.run("command -v dmesg 2>/dev/null"),
    ]);
    if (!(hasJournal.ok || hasDmesg.ok)) {
      return [finding({
        severity: "info",
        code: "gpu-errors/skipped",
        title: "GPU error check skipped",
        detail: "Neither `journalctl` nor `dmesg` is available, so the kernel log could not be read for GPU errors.",
        evidence: "journalctl: not found · dmesg: not found",
        fix: null,
        confidence: "high",
      })];
    }

    const [kmsg, dmsg] = await Promise.all([ctx.run(FROM_JOURNAL), ctx.run(FROM_DMESG)]);
    // The same event reaches journalctl with a syslog prefix ("Nov 18 10:00:01
    // host kernel:") and dmesg with an uptime prefix ("[  123.456]"). Stripping
    // both before deduping keeps one kernel fault from being counted twice.
    const signature = (line) =>
      line
        .replace(/^<[0-9]+>/, "")
        .replace(/^\[[^\]]*\]\s*/, "")
        .replace(/^\w{3}\s+\d+\s+[\d:]+\s+\S+\s+/, "")
        .replace(/^kernel:\s*/, "")
        .trim();
    const seen = new Set();
    const logs = [];
    for (const line of [...journalLines(kmsg.stdout), ...journalLines(dmsg.stdout)]) {
      const t = line.trim();
      const sig = signature(t);
      if (!t || !sig || seen.has(sig)) continue;
      seen.add(sig);
      logs.push(t);
    }

    const groups = new Map();
    for (const line of logs) {
      const hit = classify(line);
      if (!hit) continue;
      if (!groups.has(hit.id)) groups.set(hit.id, { lines: [], xids: new Set() });
      const g = groups.get(hit.id);
      g.lines.push(line);
      if (hit.xid !== undefined) g.xids.add(hit.xid);
    }

    if (groups.size === 0) {
      return [finding({
        severity: "info",
        code: "gpu-errors/ok",
        title: "No GPU errors in the recent log",
        detail: "The kernel log has no NVIDIA Xid, AMDGPU ring timeout or reset, Intel GPU hang, or GPU memory fault in the last seven days.",
        evidence: "journalctl -k + dmesg: no GPU error signature",
        fix: null,
        confidence: "high",
      })];
    }

    const findings = [];
    for (const [id, g] of groups) {
      const n = g.lines.length;
      const sample = g.lines.slice(0, 3).join("\n");
      if (id === "xid") {
        const codes = [...g.xids].sort((a, b) => a - b);
        const high = codes.some((c) => HIGH_XID.has(c));
        findings.push(finding({
          severity: high ? "high" : "medium",
          code: "gpu-errors/xid",
          title: `NVIDIA Xid ${codes.join(", ")} (${n} event${n === 1 ? "" : "s"} in 7 days)`,
          detail: high
            ? "The NVIDIA driver logged an Xid that means the GPU stopped responding or its memory reported an uncorrectable error. This is not a rendering glitch: the card usually needs a reboot, and repeated occurrences point at power, seating, or the card itself."
            : "The NVIDIA driver logged Xid errors. Most codes are driver or application faults that the driver recovers from; a few mean the card is in trouble. The code number is what identifies which.",
          evidence: sample,
          fix: high
            ? "Check the card's power connectors and seating, and the PSU's headroom; Xid 79/94/95 are hardware signals, not driver bugs. If it happens under load only, test with a lower power limit."
            : "Note the Xid code and what was running. Update the driver first (`akmod-nvidia` on Fedora, the distribution package elsewhere); a code that repeats with one application is that application's bug.",
          confidence: high ? "high" : "medium",
        }));
        continue;
      }
      const meta = META[id];
      if (!meta) continue;
      const base = {
        severity: "medium",
        title: `${meta.title} (${n} event${n === 1 ? "" : "s"} in 7 days)`,
        detail: meta.detail,
        evidence: sample,
        fix: meta.fix,
        confidence: "high",
      };
      // Literal codes, one per branch: the registry guard rejects a computed
      // code, and a typo in a class name should fail the suite, not ship.
      if (id === "reset-failed") {
        findings.push(finding({
          ...base,
          code: "gpu-errors/reset",
        }));
      } else if (id === "ring-timeout") {
        findings.push(finding({
          ...base,
          code: "gpu-errors/ring",
        }));
      } else if (id === "fault") {
        findings.push(finding({
          ...base,
          code: "gpu-errors/fault",
        }));
      } else if (id === "hang") {
        findings.push(finding({
          ...base,
          code: "gpu-errors/hang",
        }));
      }
    }

    return findings;
  },
});
