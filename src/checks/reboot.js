// SPDX-License-Identifier: GPL-3.0-or-later
import { lines } from "../utils.js";
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";
import { detectContainer } from "./shared.js";

/** Split a kernel version into its numeric parts, e.g. "6.8.9-300.fc40" → [6, 8, 9, 300, 40]. */
export function parseKernelVersion(v) {
  const nums = [];
  for (const m of String(v).match(/\d+/g) || []) nums.push(Number(m));
  return nums;
}

/** True if kernel version a is newer than b (numeric, part by part). */
export function versionGt(a, b) {
  const A = parseKernelVersion(a);
  const B = parseKernelVersion(b);
  const len = Math.max(A.length, B.length);
  for (let i = 0; i < len; i += 1) {
    const x = A[i] ?? 0;
    const y = B[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Reboot status: is the newest installed kernel actually booted, and does
 * /var/run/reboot-required say a restart is pending? A running an old kernel
 * with a newer one installed is the most common reason a "fully updated"
 * system is still vulnerable — the fix is a reboot, and nobody tells you.
 *
 * Image-based (ostree) distros are skipped: they update atomically via
 * rpm-ostree (see the "updates" check) and /boot only shows the deployed
 * kernel, so a version comparison would be meaningless.
 */
export const reboot = defineCheck({
  id: "reboot",
  title: "Reboot required / kernel updates",
  category: "updates",
  // Atomic (ostree/bootc) systems deploy a single image and /boot only shows
  // the deployed kernel, so comparing the booted kernel to installed ones is
  // meaningless — the "updates" check covers image upgrades instead.
  skipOnAtomic: true,
  atomicReason: "Atomic systems deploy a single image; kernel comparison against /boot is meaningless (see the 'updates' check for image upgrades).",
  async run(ctx) {
    const findings = [];

    // The runner already skips this via `skipOnAtomic` on atomic systems and
    // records a reason; this guard is a belt-and-suspenders so the check is
    // also self-contained (e.g. when called directly in tests or by plugins).
    if (ctx.dist.imageBased) return findings;

    // A container has no /boot of its own and no reboot concept: the kernel
    // list is empty because it is the host's, so comparing against it printed
    // "No reboot needed" on a machine that cannot reboot at all.
    const { inContainer, virtType } = await detectContainer(ctx);
    if (inContainer) {
      findings.push(finding({
        severity: "info",
        code: "reboot/skipped",
        title: "Reboot check skipped (container)",
        detail: "This is a container: it has no kernels of its own to compare against and no reboot concept, so the check stays quiet.",
        evidence: `container detected: ${virtType && virtType !== "none" ? virtType : "container marker"}`,
        fix: null,
        confidence: "high",
      }));
      return findings;
    }

    const [bootedRes, kernelsRes, rebootFile] = await Promise.all([
      ctx.run("uname -r 2>/dev/null"),
      ctx.run("for f in /boot/vmlinuz-*; do readlink -f \"$f\"; done 2>/dev/null | sort -u | sed 's|.*/vmlinuz-||'"),
      ctx.run("[ -f /var/run/reboot-required ] && cat /var/run/reboot-required 2>/dev/null"),
    ]);
    if (!bootedRes.ok || !bootedRes.stdout.trim()) return findings;

    const booted = bootedRes.stdout.trim();
    const installed = lines(kernelsRes.stdout);
    const newer = installed.find((v) => versionGt(v, booted)) || null;
    const rebootRequired = rebootFile.ok && rebootFile.stdout.trim() !== "";

    // No installed kernel could be read (an unmounted /boot, a chroot): we
    // cannot say the running kernel is the newest, so stay silent.
    if (installed.length === 0 && !rebootRequired) return findings;

    if (!newer && !rebootRequired) {
      findings.push(finding({
        severity: "info",
        code: "reboot/ok",
        title: "No reboot needed",
        detail: "The running kernel is the newest installed, and no restart is pending.",
        evidence: `booted: ${booted}`,
        fix: null,
        confidence: "high",
      }));
      return findings;
    }

    const parts = [];
    if (newer) {
      parts.push(`A newer kernel (${newer}) is installed, but the system is running ${booted}.`);
    }
    if (rebootRequired) {
      parts.push("/var/run/reboot-required indicates a restart is needed to finish applying updates.");
    }

    findings.push(finding({
      severity: "medium",
      code: "reboot/required",
      title: "A reboot is required",
      detail: parts.join(" "),
      evidence: [`booted: ${booted}`, newer ? `newest installed: ${newer}` : null, rebootRequired ? "reboot-required: yes" : null]
        .filter(Boolean)
        .join("\n"),
      fix: "Reboot when convenient to activate the new kernel. Check what changed after booting with `journalctl -b -1 | head`.",
      confidence: "high",
    }));
    return findings;
  },
});
