// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * rpm-ostree deployment health, for image-based systems (Silverblue, Kinoite,
 * Bazzite, CoreOS, bootc hosts that still use rpm-ostree).
 *
 * Two facts matter and neither is visible from `updates`:
 *
 *  - an update can be **staged** and waiting for a reboot. The system is not
 *    running it yet, so "up to date" in the report and "the fix is not active"
 *    are both true at once.
 *  - the **booted image can be old** — a machine that never reboots (a kiosk, a
 *    server) keeps running a deployment from months ago while newer ones exist.
 *
 * Read-only: `rpm-ostree status --json` needs no privileges.
 */
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";

const STATUS = "rpm-ostree status --json 2>/dev/null";
const DAY_MS = 86400000;

function daysSince(unixSeconds) {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return null;
  return Math.floor((Date.now() - unixSeconds * 1000) / DAY_MS);
}

export const ostree = defineCheck({
  id: "ostree",
  title: "Image deployment health",
  category: "updates",
  async run(ctx) {
    const bin = await ctx.run("command -v rpm-ostree 2>/dev/null");
    if (!bin.ok || !bin.stdout.trim()) return [];

    const res = await ctx.run(STATUS);
    if (!res.ok || !res.stdout.trim().startsWith("{")) return [];

    let deployments = [];
    try {
      deployments = JSON.parse(res.stdout).deployments || [];
    } catch {
      return [];
    }
    if (!Array.isArray(deployments) || deployments.length === 0) return [];

    const booted = deployments.find((d) => d.booted) || null;
    const staged = deployments.find((d) => d.staged) || null;

    if (staged) {
      const bootedVersion = booted?.version || "unknown";
      return [finding({
        severity: "info",
        code: "ostree/staged",
        title: `Image update ${staged.version || ""} is staged — reboot to apply`.trim(),
        detail: `A newer deployment is downloaded and staged, but the system is still running the previous one (${bootedVersion}). Until the reboot, fixes and package changes in the new image are not active — "up to date" and "not applied" are both true here.`,
        evidence: `booted: ${bootedVersion}\nstaged: ${staged.version || "unknown"}`,
        fix: "Reboot when convenient: `systemctl reboot`. On a server, `sudo rpm-ostree apply-live` can apply parts of the update without a reboot, but a reboot is the supported path.",
        confidence: "high",
      })];
    }

    const age = daysSince(booted?.timestamp);
    const limit = ctx.thresholds.ostreeStaleDays ?? 30;
    if (age !== null && age > limit) {
      return [finding({
        severity: "medium",
        code: "ostree/stale",
        title: `Booted image is ${age} days old`,
        detail: `The running deployment was created ${age} days ago and nothing newer is staged. Image-based systems only change on reboot, so a machine that stays up keeps running an old image — including old kernel, drivers, and security fixes.`,
        evidence: `booted: ${booted.version || "unknown"} · ${age} days old`,
        fix: "Update and reboot: `sudo rpm-ostree upgrade && systemctl reboot`. If the machine must not reboot, check whether an update is available first with `rpm-ostree upgrade --check`.",
        confidence: "high",
      })];
    }

    return [];
  },
});
