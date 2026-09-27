// SPDX-License-Identifier: GPL-3.0-or-later
import { lines, pct } from "../utils.js";
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";

/**
 * Boot partition and bootloader health.
 * A full /boot is the #1 reason `dnf/apt upgrade` fails with
 * "No space left on device" even when the root is fine (old kernels
 * pile up). A missing grub.cfg means the next reboot may not find an
 * entry. Both are read-only checks.
 */
export const boot = defineCheck({
  id: "boot",
  title: "Boot partition",
  category: "system",
  async run(ctx) {
    const findings = [];

    // Skip on image-based systems where /boot is the deployed ostree image
    if (ctx.dist && ctx.dist.imageBased) return findings;

    // Check /boot and /boot/efi usage via df -P (POSIX, one line per FS)
    // No `| tail`: the pipeline's exit status is tail's, so a failed df looked
    // successful. df prints a header line first, so the data row is taken in JS.
    const bootDf = await ctx.run("df -P /boot 2>/dev/null");
    const efiDf = await ctx.run("df -P /boot/efi 2>/dev/null");

    for (const [df, label, mount] of [
      [bootDf, "Boot partition (/boot)", "/boot"],
      [efiDf, "EFI partition (/boot/efi)", "/boot/efi"],
    ]) {
      if (!df.ok || !df.stdout.trim()) continue;
      const p = df.stdout.trim().split("\n").pop().trim().split(/\s+/);
      if (p.length < 6) continue;
      // `df -P /boot` prints the ROOT filesystem row when /boot is just a
      // directory on /, with the same columns as a real boot partition. Trust
      // the row only when it describes the mount we asked about, or a 95%-full
      // root becomes a high "Boot partition (/boot) is nearly full".
      if (p[5] !== mount) continue;
      const use = pct(p[4]);
      const fs = p[0];
      // Skip pseudo mounts that df reports for /boot/efi when not mounted
      if (fs === "tmpfs" || fs === "efivarfs") continue;
      // /boot/efi is tiny (100-600M); 80% is already critical
      const warn = mount === "/boot/efi" ? 70 : 80;
      const crit = mount === "/boot/efi" ? 85 : 90;
      if (use >= crit) {
        findings.push(finding({
          severity: "high",
          code: "boot/full",
          dedupeKey: `boot:${mount}`,
          title: `${label} is nearly full (${use}% used)`,
          detail: `${label} is ${use}% full. Kernel updates write to ${mount} and will fail with "No space left on device" when it fills up. Old kernels are the usual culprit.`,
          evidence: df.stdout.trim(),
          fix: mount === "/boot/efi"
            ? "Do not delete EFI files manually. Check `df -h /boot/efi` and remove stale vendor dirs only if you know what they are, or enlarge the partition."
            : "Remove old kernels: `sudo dnf remove --oldinstallonly --setopt installonly_limit=2 kernel` (Fedora) or `sudo apt autoremove --purge` (Debian/Ubuntu), then `df -h /boot`.",
          confidence: "high",
        }));
      } else if (use >= warn) {
        findings.push(finding({
          severity: "medium",
          code: "boot/full",
          dedupeKey: `boot:${mount}`,
          title: `${label} is getting full (${use}% used)`,
          detail: `${label} is ${use}% full. It will block the next kernel update if it keeps growing.`,
          evidence: df.stdout.trim(),
          fix: "Clean old kernels (`sudo dnf remove --oldinstallonly` / `sudo apt autoremove --purge`) and re-check `df -h ${mount}`.",
          confidence: "high",
        }));
      }
    }

    // Bootloader config presence — a missing grub.cfg means the next reboot
    // may drop to a grub rescue prompt. Check both grub and grub2 layouts.
    const grub = await ctx.run("ls /boot/grub/grub.cfg /boot/grub2/grub.cfg /boot/loader/entries/*.conf 2>/dev/null | head -1");
    const efi = await ctx.run("ls /boot/efi/EFI/*/grub*.cfg /boot/efi/EFI/*/grubx64.efi 2>/dev/null | head -1");
    const hasGrub = grub.ok && grub.stdout.trim() !== "";
    const hasEfi = efi.ok && efi.stdout.trim() !== "";
    // Also check if /boot even exists (containers/chroots may have no /boot)
    const hasBoot = await ctx.run("test -d /boot 2>/dev/null && echo yes");
    if (!hasBoot.ok || hasBoot.stdout.trim() !== "yes") return findings;
    // If we already reported a full boot partition, don't add noise
    if (findings.length > 0) return findings;
    if (!hasGrub && !hasEfi) {
      // Only flag on systems that actually have a /boot with kernels
      const hasKernel = await ctx.run("ls /boot/vmlinuz-* 2>/dev/null | head -1");
      if (hasKernel.ok && hasKernel.stdout.trim() !== "") {
        findings.push(finding({
          severity: "medium",
          code: "boot/no-config",
          title: "No bootloader config found",
          detail: "No grub.cfg or systemd-boot entry was found under /boot. If this is a BIOS/UEFI install, the next reboot may fail to find a boot entry.",
          evidence: "checked /boot/grub/grub.cfg, /boot/grub2/grub.cfg, /boot/loader/entries/, /boot/efi/EFI/*",
          fix: "Regenerate it: `sudo grub2-mkconfig -o /boot/grub2/grub.cfg` (Fedora) or `sudo grub-mkconfig -o /boot/grub/grub.cfg` (Debian/Arch). For systemd-boot: `sudo bootctl install`.",
          confidence: "medium",
        }));
      }
    }

    if (findings.length === 0) {
      // Emit a healthy signal only when we actually saw /boot — containers
      // with no boot at all stay silent (they would have returned earlier).
      const anyDf = (bootDf.ok && bootDf.stdout.trim()) || (efiDf.ok && efiDf.stdout.trim());
      if (anyDf) {
        findings.push(finding({
          severity: "info",
          code: "boot/ok",
          title: "Boot partition looks healthy",
          detail: "The boot partition has free space and a bootloader config is present.",
          evidence: (bootDf.stdout.trim() || efiDf.stdout.trim()).split("\n")[0],
          fix: null,
          confidence: "high",
        }));
      }
    }

    return findings;
  },
});
