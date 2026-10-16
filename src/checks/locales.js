// SPDX-License-Identifier: GPL-3.0-or-later
import { lines } from "../utils.js";
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";

/* Generating a locale is a different act on every family — and on an
   image-based desktop even a language pack is a layered change. */
function localeFix(dist) {
  if (dist?.pkg === "rpm-ostree") return "Install the language pack with `sudo rpm-ostree install langpacks-<lang>`, then reboot — the base image already carries Fedora's languages, so this is usually only about extra fonts.";
  if (dist?.family === "fedora") return "Install it with `sudo dnf install langpacks-<lang>`, then pick the language again in Settings.";
  if (dist?.family === "debian") return "Generate it: enable it in `/etc/locale.gen`, then `sudo locale-gen` and `sudo update-locale`.";
  if (dist?.family === "arch") return "Generate it: uncomment it in `/etc/locale.gen`, then `sudo locale-gen`.";
  return "Generate the locale with your distribution's locale tool, then log out and back in.";
}

/**
 * Locale sanity. A missing locale manifests as "Failed to set locale" or
 * "Cannot set LC_*" on every login — one of the most common confusing
 * breakages on minimal distro installs.
 */

export const locales = defineCheck({
  id: "locales",
  title: "Locale configuration",
  category: "system",
  async run(ctx) {
    const findings = [];

    // run() pins LC_ALL=C for deterministic parsing — which would mask the
    // exact error this check looks for. Unset it for this one command so the
    // user's real LANG/LC_* are evaluated.
    const res = await ctx.run("env -u LC_ALL locale 2>&1");
    const output = `${res.stdout}\n${res.stderr}`;
    if (!/failed to set locale|cannot set LC_/i.test(output)) return findings;

    findings.push(finding({
      severity: "medium",
      code: "locales/broken",
      title: "System locale is broken",
      detail: "The configured locale is not generated on this system, so programs fall back to English (or fail to start) and date/number formatting is inconsistent.",
      evidence: lines(output).filter((l) => /locale|LC_/i.test(l)).slice(0, 3).join("\n") || output.trim(),
      fix: localeFix(ctx.dist),
      confidence: "high",
    }));
    return findings;
  },
});