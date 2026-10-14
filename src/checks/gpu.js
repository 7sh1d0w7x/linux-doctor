// SPDX-License-Identifier: GPL-3.0-or-later
import { lines } from "../utils.js";
import { detectSoftwareRenderer } from "./shared.js";

import { defineCheck } from "./define.js";
import { finding } from "../findings.js";

/* The NVIDIA driver is not a package you install on an image-based desktop:
   it is baked into the image, and you switch images by rebasing. Telling a
   Bazzite user to run `dnf install akmod-nvidia` is the classic wrong move. */
function nvidiaDriverFix(dist, tail) {
  const suffix = tail ? " " + tail : "";
  if (dist?.imageBased) {
    return "The driver is not installed with a package manager on an image-based desktop — it ships with the image. Rebase to the NVIDIA image instead (Bazzite: `sudo rpm-ostree rebase ostree-image-signed:docker://ghcr.io/ublue-os/bazzite-nvidia:stable`), then reboot." + suffix;
  }
  const p = dist?.pkg;
  let cmd = "your distribution's NVIDIA driver package";
  if (p === "apt") cmd = "`sudo apt install nvidia-driver` (enable contrib non-free first)";
  else if (p === "pacman") cmd = "`sudo pacman -S nvidia`";
  else if (p === "dnf") cmd = "`sudo dnf install akmod-nvidia` (enable RPM Fusion first)";
  return "Install the proprietary driver from your distro: " + cmd + "." + suffix;
}

export const gpu = defineCheck({
  id: "gpu",
  title: "Graphics / GPU",
  category: "hardware",
  appliesTo: ["desktop", "laptop"],
  async run(ctx) {
    const findings = [];
    const [lspci, lsmod, dri] = await Promise.all([
      ctx.run("lspci -nn 2>/dev/null | grep -iE 'vga|3d|display'"),
      ctx.run("lsmod 2>/dev/null | awk '{print $1}' | grep -iE '^(nvidia|nouveau|amdgpu|i915|xe)$'"),
      ctx.run("ls /dev/dri/ 2>/dev/null"),
    ]);

    const hardware = lines(lspci.stdout).join("\n");
    const loaded = lines(lsmod.stdout).join(" ");
    const hasDri = dri.ok && lines(dri.stdout).length > 0;

    const hasNvidia = /nvidia/i.test(hardware);
    const hasAmd = /amd|advanced micro devices/i.test(hardware);
    const hasIntel = /intel/i.test(hardware);
    const nvidiaMod = /\bnvidia\b/.test(loaded);
    const nouveauMod = /\bnouveau\b/.test(loaded);
    const amdMod = /\bamdgpu\b/.test(loaded);
    const intelMod = /\bi915\b|\bxe\b/.test(loaded);

    if (!lspci.ok) {
      findings.push(finding({
        severity: "info",
        code: "gpu/skipped",
        title: "GPU check skipped",
        detail: "`lspci` is not available, so we could not inspect the graphics hardware.",
        evidence: null,
        fix: null,
        confidence: "medium",
      }));
      return findings;
    }

    if (!hasNvidia && !hasAmd && !hasIntel && !hasDri) {
      findings.push(finding({
        severity: "info",
        code: "gpu/none",
        title: "No GPU detected",
        detail: "No VGA/3D controller was found. This is normal on headless servers or virtual machines.",
        evidence: hardware || "(no output)",
        fix: null,
        confidence: "high",
      }));
      return findings;
    }

    // Software rendering is the silent killer: the desktop "works" but is very
    // slow. Detected once here because the driver branches below need it to
    // tell a missing driver apart from a built-in one.
    const swRenderer = await detectSoftwareRenderer(ctx);

    // NVIDIA is the most common source of pain, so it gets the detailed logic.
    if (hasNvidia) {
      if (nvidiaMod) {
        const ver = await ctx.run("cat /proc/driver/nvidia/version 2>/dev/null");
        findings.push(finding({
          severity: "info",
          code: "gpu/nvidia",
          title: "NVIDIA proprietary driver is loaded",
          detail: "The NVIDIA proprietary driver is active, which is the right setup for gaming and CUDA workloads.",
          evidence: ver.ok && ver.stdout.trim() ? ver.stdout.trim() : "module: nvidia",
          fix: null,
          confidence: "high",
        }));
      } else if (nouveauMod) {
        findings.push(finding({
          severity: "medium",
          code: "gpu/nouveau",
          title: "NVIDIA GPU is using the open-source nouveau driver",
          detail: "Your NVIDIA card is running on the open nouveau driver. It works for the desktop, but performance and CUDA support are limited — games and GPU compute will underperform.",
          evidence: "hardware: " + (hardware || "nvidia") + "\nmodule: nouveau",
          fix: nvidiaDriverFix(ctx.dist, ""),
          confidence: "high",
        }));
      } else {
        findings.push(finding({
          severity: "medium",
          code: "gpu/nvidia-missing",
          title: "NVIDIA GPU detected but no driver is loaded",
          detail: "Your system has an NVIDIA card, but neither the proprietary driver nor nouveau is loaded. Graphics will fall back to slow software rendering.",
          evidence: "hardware: " + (hardware || "nvidia") + "\nloaded modules: " + (loaded || "none"),
          fix: nvidiaDriverFix(ctx.dist, "Then reboot."),
          confidence: "high",
        }));
      }
    } else if (hasAmd && !amdMod) {
      // amdgpu is often compiled INTO the kernel, in which case lsmod shows
      // nothing even though the driver is active. A working display (DRI
      // present, no software rendering) means it is fine — only flag the
      // missing driver when the GPU is genuinely not driving the display.
      if (hasDri && !swRenderer) {
        findings.push(finding({
          severity: "info",
          code: "gpu/amd",
          title: "Graphics driver is working",
          detail: "Your AMD GPU is using the open-source amdgpu driver (in-kernel, no proprietary module needed).",
          evidence: "hardware: " + (hardware || "integrated") + "\nmodule: amdgpu (built-in)",
          fix: null,
          confidence: "high",
        }));
      } else {
        findings.push(finding({
          severity: "medium",
          code: "gpu/amd-missing",
          title: "AMD GPU detected but the amdgpu driver is not loaded",
          detail: "An AMD card is present but the amdgpu kernel driver is not active. Graphics are falling back to software rendering.",
          evidence: "hardware: " + hardware + (swRenderer ? `\nrenderer: ${swRenderer}` : "\nrenderer: unknown"),
          fix: "Reboot the system; if the problem persists, check your kernel command line for a `nomodeset` option and remove it.",
          confidence: "medium",
        }));
      }
    } else if ((hasAmd || hasIntel) && (amdMod || intelMod)) {
      findings.push(finding({
        severity: "info",
        code: "gpu/driver",
        title: "Graphics driver is working",
        detail: `Your ${hasAmd ? "AMD" : "Intel"} GPU is using the standard open-source driver (${amdMod ? "amdgpu" : "i915/xe"}), which is the well-supported default.`,
        evidence: "hardware: " + (hardware || "integrated") + "\nmodule: " + (amdMod ? "amdgpu" : "i915/xe"),
        fix: null,
        confidence: "high",
      }));
    }

    if (swRenderer) {
      findings.push(finding({
        severity: "medium",
        code: "gpu/software-rendering",
        title: "GPU acceleration is not active (software rendering)",
        detail: "Graphics are being rendered in software (llvmpipe), not by your GPU. Everything visual will feel slow — video playback, scrolling, games. This usually means the GPU driver is missing or misconfigured.",
        evidence: "renderer: " + swRenderer,
        fix: "Install the correct driver for your GPU (see the other GPU findings), then reboot.",
        confidence: "high",
        // The wayland check detects the same root cause; dedupe() keeps this
        // one (gpu is the authoritative check and runs first).
        dedupeKey: "software-rendering",
      }));
    }
    return findings;
  },
});
