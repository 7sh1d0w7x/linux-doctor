// SPDX-License-Identifier: GPL-3.0-or-later
import { lines } from "../utils.js";
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";

/**
 * Orphaned / unneeded packages — the #1 "how to free space on Arch"
 * answer on r/archlinux (`pacman -Rns $(pacman -Qtdq)`). Other families
 * have the same concept (dnf autoremove, apt autoremove). A pile of
 * orphans is not a fault, but a latent disk/bloat risk that `disk`
 * only catches after the fact.
 */
export const orphans = defineCheck({
  id: "orphans",
  title: "Orphaned packages",
  category: "system",
  async run(ctx) {
    const { pkg, family } = ctx.dist || {};
    let count = 0;
    let evidence = "";
    let sample = "";

    if (pkg === "pacman" || family === "arch") {
      // `pacman -Qtdq` exits 1 when there are no orphans, so the exit status
      // cannot gate this one (it is 1 in the normal empty case). A real failure
      // prints to stderr instead, which `2>&1` folds in so it can be told apart
      // from the empty "no orphans" result.
      const res = await ctx.run("pacman -Qtdq 2>&1");
      if (/\berror\b/i.test(res.stdout)) return [];
      const pkgs = lines(res.stdout);
      count = pkgs.length;
      sample = pkgs.slice(0, 5).join(", ");
      evidence = pkgs.slice(0, 5).join("\n") || "pacman -Qtdq: none";
    } else if (pkg === "apt" || family === "debian") {
      // No `| grep`: the pipeline's exit status is grep's, so a failed apt
      // (dpkg lock, broken state) printed nothing and the check reported a tidy
      // database. Read the simulation and filter in JS, and if it did not run,
      // say nothing — the same bug the dnf branch was fixed for.
      const res = await ctx.run("apt-get -s autoremove 2>/dev/null");
      if (!res.ok) return [];
      const pkgs = lines(res.stdout).filter((l) => /^Remv /i.test(l));
      count = pkgs.length;
      sample = pkgs.slice(0, 3).join("\n");
      evidence = `apt autoremove --dry-run: ${count} removable`;
      if (sample) evidence += `\n${sample}`;
    } else if (pkg === "dnf" || family === "fedora") {
      // dnf5: `dnf repoquery --unneeded` ; dnf4: `package-cleanup --orphans`
      // No `| wc -l` / `| head`: those statuses belong to wc/head, so a failed
      // query printed "0" and the check reported a tidy database on a machine
      // it never managed to read (verified: unprivileged dnf exits 1). Count
      // and slice in JS, and if neither query runs, say nothing.
      const res = await ctx.run("dnf repoquery --unneeded --qf '%{name}' 2>/dev/null");
      if (res.ok) {
        const pkgs = lines(res.stdout).filter(Boolean);
        count = pkgs.length;
        sample = pkgs.slice(0, 3).join(", ");
        evidence = `dnf repoquery --unneeded: ${count} orphaned`;
        if (sample) evidence += `\n${sample}`;
      } else {
        const fallback = await ctx.run("dnf autoremove --assumeno 2>&1 | grep -E '^ Package '");
        if (!fallback.ok && !String(fallback.stdout || "").trim()) return [];
        count = lines(fallback.stdout).filter(Boolean).length;
        evidence = `dnf autoremove --assumeno: ${count} removable`;
      }
    } else if (pkg === "zypper" || family === "suse") {
      // No `| grep -c`: grep exits 0 on empty input, so a failed zypper printed
      // "0" and read as a tidy database. Count in JS after checking it ran.
      const res = await ctx.run("zypper --non-interactive packages --unneeded 2>/dev/null");
      if (!res.ok) return [];
      count = lines(res.stdout).filter((l) => /^i/.test(l)).length;
      evidence = `zypper packages --unneeded: ${count} orphaned`;
    } else {
      // Unknown package manager — nothing to say (not a fault)
      return [];
    }

    if (count === 0) {
      return [finding({
        severity: "info",
        code: "orphans/none",
        title: "No orphaned packages",
        detail: "No unneeded/orphaned packages were found. The package database is tidy.",
        evidence: evidence || "0 orphaned",
        fix: null,
        confidence: "high",
      })];
    }

    if (count >= 10) {
      return [finding({
        severity: "medium",
        code: "orphans/many",
        title: `${count} orphaned packages are installed`,
        detail: `${count} packages are installed as dependencies but no longer required by any package. They waste disk space and slow down updates. This is especially common on Arch after removing a desktop environment or kernel.`,
        evidence: sample ? `${evidence}\n${sample}` : evidence,
        fix: family === "arch" ? "Remove them with `sudo pacman -Rns $(pacman -Qtdq)` (review the list first with `pacman -Qtd`)."
          : family === "debian" ? "Remove them with `sudo apt autoremove`."
          : family === "fedora" ? "Remove them with `sudo dnf autoremove`."
          : family === "suse" ? "openSUSE has no bulk autoremove. Remove packages one at a time with `sudo zypper rm -u <package>`, which also cleans up the dependencies they pulled in."
          : "Remove them with your package manager's autoremove command.",
        confidence: "high",
      })];
    }

    return [finding({
      severity: "info",
      code: "orphans/some",
      title: `${count} orphaned package${count === 1 ? "" : "s"} installed`,
      detail: `${count} package${count === 1 ? " is" : "s are"} installed as dependencies but no longer required. Not urgent, but worth cleaning up.`,
      evidence: sample ? `${evidence}\n${sample}` : evidence,
      fix: family === "arch" ? "Remove with `sudo pacman -Rns $(pacman -Qtdq)` after reviewing `pacman -Qtd`."
        : family === "debian" ? "Remove with `sudo apt autoremove`."
        : family === "fedora" ? "Remove with `sudo dnf autoremove`."
        : family === "suse" ? "openSUSE has no bulk autoremove. Remove one at a time with `sudo zypper rm -u <package>`."
        : "Remove with your package manager's autoremove command.",
      confidence: "high",
    })];
  },
});
