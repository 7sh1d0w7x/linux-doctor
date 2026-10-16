// SPDX-License-Identifier: GPL-3.0-or-later
import { lines, plural, TIMEOUT_MS } from "../utils.js";
import { readCache, writeCache } from "../cache.js";
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";
import { svcCmd } from "../distro.js";

const FIRMWARE_CACHE_MS = 30 * 60 * 1000;

/**
 * Checks for pending firmware (BIOS/UEFI/device) updates via fwupd.
 * Only read-only commands are used: fwupdmgr get-updates just lists what is
 * available; applying updates is left to the user (and needs a reboot).
 * fwupdmgr talks to the fwupd daemon, which can block for a long time when it
 * is not running — so we check the daemon state first and skip the call.
 */

export const firmware = defineCheck({
  id: "firmware",
  title: "Firmware updates (fwupd)",
  category: "updates",
  async run(ctx) {
    const ttlMs = Number(process.env.LINUX_DOCTOR_UPDATES_TTL_MS || FIRMWARE_CACHE_MS);
    const isTest = process.argv.includes("--test") || process.env.NODE_ENV === "test" || !!process.env.VITEST || !!process.env.NODE_TEST_CONTEXT;
    const useCache = Number.isFinite(ttlMs) && ttlMs > 0 && !isTest;
    if (useCache) {
      const cached = readCache("firmware", ttlMs);
      if (cached) return cached;
    }
    const findings = [];

    const [daemon, fwupdmgrBin] = await Promise.all([
      ctx.run("systemctl is-active fwupd 2>/dev/null"),
      ctx.run("command -v fwupdmgr 2>/dev/null"),
    ]);

    if (fwupdmgrBin.missing || !fwupdmgrBin.stdout.trim()) {
      if (useCache) writeCache("firmware", findings);
      return findings;
    }

    if (!(daemon.ok && daemon.stdout.trim() === "active")) {
      findings.push(finding({
        severity: "info",
        code: "firmware/not-checked",
        title: "Firmware updates not checked",
        detail: "The fwupd service is not running, so we could not look for firmware updates.",
        evidence: daemon.stdout.trim() || "fwupd inactive",
        fix: `Start it with: \`${svcCmd(ctx.dist, "enable-now", "fwupd")}\``,
        confidence: "medium",
      }));
      if (useCache) writeCache("firmware", findings);
      return findings;
    }

    const updates = await ctx.run("fwupdmgr get-updates 2>/dev/null", { timeoutMs: TIMEOUT_MS.DAEMON });

    const text = updates.stdout || "";
    if (/no updates? available/i.test(text) || /no updatable devices/i.test(text)) {
      findings.push(finding({
        severity: "info",
        code: "firmware/none",
        title: "Firmware is up to date",
        detail: "No pending firmware updates were found.",
        evidence: lines(text).slice(0, 2).join("\n"),
        fix: null,
        confidence: "high",
      }));
      if (useCache) writeCache("firmware", findings);
      return findings;
    }

    // Each pending update looks like "• System Firmware has updates: 1.2.3 → 1.2.4".
    const pending = lines(text).filter((l) => /has updates|→/.test(l));
    if (pending.length > 0) {
      findings.push(finding({
        severity: "medium",
        code: "firmware/pending",
        title: `${plural(pending.length, "firmware update")} available`,
        detail: "Firmware updates fix hardware bugs and security issues that packages cannot. They are applied in the firmware tool and need a reboot.",
        evidence: pending.slice(0, 4).join("\n"),
        fix: "Apply them with: `sudo fwupdmgr update` (then reboot)",
        confidence: "high",
      }));
      if (useCache) writeCache("firmware", findings);
      return findings;
    }

    // fwupdmgr ran but we could not interpret the output — stay silent.
    if (useCache) writeCache("firmware", findings);
    return findings;
  },
});
