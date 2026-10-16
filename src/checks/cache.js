// SPDX-License-Identifier: GPL-3.0-or-later
import { lines, num, fmtBytes } from "../utils.js";
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";

/**
 * User cache and trash bloat.
 * `~/.cache` and `~/.local/share/Trash` grow silently for months
 * (browser caches, thumbnails, Flatpak, pip, npm). They are the
 * second most common cause of "disk full" on desktops after old
 * kernels — and `disk` only reports the final consequence.
 */
const CACHE_WARN = 5 * 1024 ** 3; // 5 GB
const CACHE_HIGH = 10 * 1024 ** 3; // 10 GB
const TRASH_WARN = 2 * 1024 ** 3; // 2 GB
const FLATPAK_SHOWN = 3;

/**
 * Parse `du -sb <dir>...` output ("<bytes>\t<path>") into the Flatpak app
 * caches, biggest first. Flatpak keeps one cache per app under
 * ~/.var/app/<id>/cache, and on a Flatpak-heavy distro (Bazzite) that is
 * often the larger half of what a user can reclaim.
 */
function flatpakCaches(stdout) {
  return lines(stdout)
    .map((l) => l.split("\t"))
    .filter((p) => p.length === 2 && /^\d+$/.test(p[0].trim()) && /\/\.var\/app\/[^/]+\/cache$/.test(p[1].trim()))
    .map((p) => ({ bytes: num(p[0]), path: p[1].trim() }))
    .sort((a, b) => b.bytes - a.bytes);
}

export const cache = defineCheck({
  id: "cache",
  title: "Cache and trash",
  category: "system",
  appliesTo: ["desktop", "laptop"],
  async run(ctx) {
    const findings = [];

    const [cacheRes, trashRes, flatpakRes] = await Promise.all([
      ctx.run("du -sb \"$HOME/.cache\" 2>/dev/null | cut -f1"),
      ctx.run("du -sb \"$HOME/.local/share/Trash\" 2>/dev/null | cut -f1"),
      // Flatpak's per-app caches live outside ~/.cache, so measuring only
      // ~/.cache under-reported on exactly the distros that ship Flatpak by
      // default: the report said "cache is getting large" while the real
      // reclaimable space sat in ~/.var/app.
      ctx.run("du -sb \"$HOME/.var/app\"/*/cache 2>/dev/null"),
    ]);

    const cacheBytes = num(cacheRes.stdout);
    const trashBytes = num(trashRes.stdout);
    const flatpak = flatpakCaches(flatpakRes.stdout);
    const flatpakBytes = flatpak.reduce((sum, d) => sum + d.bytes, 0);
    const totalCache = cacheBytes + flatpakBytes;

    // Filter out empty/missing dirs (du prints nothing when dir absent)
    const hasCache = cacheRes.ok && cacheRes.stdout.trim() !== "" && cacheBytes >= 0;
    const hasTrash = trashRes.ok && trashRes.stdout.trim() !== "" && trashBytes >= 0;

    if (!hasCache && !hasTrash && flatpak.length === 0) return findings;

    const cacheEvidence = [];
    if (hasCache) cacheEvidence.push(`~/.cache: ${fmtBytes(cacheBytes)}`);
    if (flatpak.length > 0) {
      cacheEvidence.push(`Flatpak app caches: ${fmtBytes(flatpakBytes)}`);
      for (const d of flatpak.slice(0, FLATPAK_SHOWN)) cacheEvidence.push(`  ${fmtBytes(d.bytes)}  ${d.path}`);
    }

    if (totalCache >= CACHE_HIGH) {
      findings.push(finding({
        severity: "medium",
        code: "cache/large",
        title: `User caches are very large (${fmtBytes(totalCache)})`,
        detail: `Caches are using ${fmtBytes(totalCache)}${flatpak.length > 0 ? `, ${fmtBytes(flatpakBytes)} of it in Flatpak app caches` : ""}. Browser caches, thumbnails, and build caches (pip, npm) accumulate in ~/.cache for months, and Flatpak keeps one cache per app under ~/.var/app, so they silently fill the disk.`,
        evidence: cacheEvidence.join("\n"),
        fix: "Review both with `du -xh -d1 ~/.cache 2>/dev/null | sort -rh | head -20` and `du -sh ~/.var/app/*/cache 2>/dev/null | sort -rh | head -20` (the second lists Flatpak app caches only). `rm -rf ~/.cache/thumbnails/*` is always safe. A Flatpak app's cache is regenerable, but close the app first, and expect it to re-download what it needs: `rm -rf ~/.var/app/<app-id>/cache/*`. Browser caches are best cleared from inside the browser.",
        confidence: "high",
      }));
    } else if (totalCache >= CACHE_WARN) {
      findings.push(finding({
        severity: "info",
        code: "cache/large",
        title: `User caches are getting large (${fmtBytes(totalCache)})`,
        detail: `Caches are using ${fmtBytes(totalCache)}${flatpak.length > 0 ? `, ${fmtBytes(flatpakBytes)} of it in Flatpak app caches` : ""}. Not urgent yet, but worth a glance if disk space is tight.`,
        evidence: cacheEvidence.join("\n"),
        fix: "Check `du -xh -d1 ~/.cache 2>/dev/null | sort -rh | head -20` and `du -sh ~/.var/app/*/cache 2>/dev/null | sort -rh | head -20`, then remove what you no longer need.",
        confidence: "high",
      }));
    }

    if (hasTrash && trashBytes >= TRASH_WARN) {
      findings.push(finding({
        severity: trashBytes >= CACHE_HIGH ? "medium" : "info",
        code: "cache/trash",
        title: `Trash is using ${fmtBytes(trashBytes)}`,
        detail: `Your trash at ~/.local/share/Trash holds ${fmtBytes(trashBytes)}. Files in the trash still occupy disk space until you empty it.`,
        evidence: `~/.local/share/Trash: ${fmtBytes(trashBytes)}`,
        fix: "Empty it from your file manager or with `gio trash --empty` / `rm -rf ~/.local/share/Trash/*`.",
        confidence: "high",
      }));
    }

    if (findings.length === 0 && (hasCache || hasTrash || flatpak.length > 0)) {
      const parts = [];
      if (hasCache || flatpak.length > 0) parts.push(`cache ${fmtBytes(totalCache)}`);
      if (hasTrash) parts.push(`trash ${fmtBytes(trashBytes)}`);
      findings.push(finding({
        severity: "info",
        code: "cache/ok",
        title: "Cache and trash look fine",
        detail: `User cache and trash are modest (${parts.join(", ")}).`,
        evidence: parts.join(" · "),
        fix: null,
        confidence: "high",
      }));
    }

    return findings;
  },
});
