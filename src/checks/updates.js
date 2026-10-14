// SPDX-License-Identifier: GPL-3.0-or-later
import { lines, plural, TIMEOUT_MS } from "../utils.js";
import { readCache, writeCache } from "../cache.js";
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";

/**
 * Counts pending updates using the distro's package manager.
 * Only read-only commands are used (check-update / simulation).
 * The distro → package-manager mapping lives in src/distro.js; this check
 * only picks the command for the profile it is given.
 *
 * Refreshing dnf metadata is the single slowest thing in a full run (~5s), so
 * the result is cached for 30 minutes (override LINUX_DOCTOR_UPDATES_TTL_MS;
 * 0 disables the cache). The TTL is read at call time so tests can control it.
 */
const UPDATES_CACHE_MS = 30 * 60 * 1000;

export const updates = defineCheck({
  id: "updates",
  title: "Pending updates",
  category: "updates",
  async run(ctx) {
    const findings = [];
    const { pkg, id: distroId, family } = ctx.dist;

    const ttlMs = Number(process.env.LINUX_DOCTOR_UPDATES_TTL_MS || UPDATES_CACHE_MS);
    const useCache = Number.isFinite(ttlMs) && ttlMs > 0;
    if (useCache) {
      const cached = readCache("updates", ttlMs);
      if (cached) return cached;
    }

    let cmd = null;
    let label = "";
    if (pkg === "rpm-ostree") {
      cmd = "rpm-ostree upgrade --check 2>&1";
      label = "rpm-ostree";
    } else if (pkg === "dnf") {
      cmd = "dnf check-update --quiet 2>/dev/null";
      label = "dnf";
    } else if (pkg === "apt") {
      // 2>&1 so apt's failure messages (dpkg lock, E: ...) are visible — a
      // locked or broken apt must NOT look like "0 updates".
      cmd = "apt-get -s upgrade 2>&1";
      label = "apt";
    } else if (pkg === "zypper") {
      // Raw output, parsed in JS. The old pipeline (| awk 'NR>4 && NF' | wc -l)
      // depended on awk being installed: on a minimal openSUSE image it is not,
      // so the pipeline produced nothing and the check reported "up to date"
      // with thirteen lines of updates on screen.
      cmd = "zypper -q lu 2>/dev/null";
      label = "zypper";
    } else if (pkg === "apk") {
      // `apk info -u` is not a valid command (it exits 1 with "unrecognized
      // option 'u'"), and the empty output was read as "no updates", so Alpine
      // silently reported nothing at all. `apk version -l '<'` is the real one.
      cmd = "apk version -l '<' 2>/dev/null";
      label = "apk";
    } else if (pkg === "xbps") {
      // Void had no update check. `-un` is the dry run: list what would be
      // updated, from the local index, without syncing or changing anything.
      cmd = "xbps-install -un 2>/dev/null";
      label = "xbps";
    } else if (pkg === "pacman") {
      cmd = "checkupdates 2>/dev/null || pacman -Qu 2>/dev/null";
      label = "pacman";
    }

    if (!cmd) {
      findings.push(finding({
        severity: "info",
        code: "updates/skipped",
        title: "Update check skipped",
        detail: `No update check exists for this distro family ("${distroId || "unknown"}", family "${family}").`,
        evidence: null,
        fix: null,
        confidence: "medium",
      }));
      if (useCache) writeCache("updates", findings);
      return findings;
    }

    const res = await ctx.run(cmd, { timeoutMs: label === "rpm-ostree" ? TIMEOUT_MS.OSTREE : TIMEOUT_MS.PKGMGR });
    if (res.missing) {
      findings.push(finding({
        severity: "info",
        code: "updates/skipped",
        title: "Update check skipped",
        detail: `The package manager (${label}) is not installed on this system, so pending updates could not be checked.`,
        evidence: `${label}: not found`,
        fix: null,
        confidence: "high",
      }));
      if (useCache) writeCache("updates", findings);
      return findings;
    }
    // dnf exits with 100 when updates are available (0 = up to date);
    // rpm-ostree exits 77 even on a successful check. Any other failure means
    // we could not determine the state, so stay silent instead of falsely
    // reporting "up to date". apt simulation reports errors as text even on a
    // zero exit code, so scan for those too.
    const aptError = label === "apt" && /could not get lock|^E:|^dpkg:|apt-get: error/i.test(res.stdout);
    const ok =
      (res.ok ||
      (label === "dnf" && res.code === 100) ||
      (label === "rpm-ostree" && /Available update:|No updates available\./.test(res.stdout))) &&
      !aptError;
    // Only cache a *successful* determination. A failed command is not
    // cached, so the next run retries instead of repeating a stale result.
    if (!ok) return findings;

    let count;
    if (label === "apt") {
      count = lines(res.stdout).filter((l) => /^Inst /i.test(l)).length;
    } else if (label === "zypper") {
      // One line per update, first column "v" (a package with an update).
      count = String(res.stdout).split("\n").filter((l) => /^\s*v\s*\|/.test(l)).length;
    } else if (label === "apk") {
      // A fixed "Installed: ... Available:" header, then one line per package.
      count = lines(res.stdout).filter((l) => l.trim() !== "" && !/^Installed:/i.test(l)).length;
    } else if (label === "xbps") {
      // One line per pending update.
      count = lines(res.stdout).filter((l) => l.trim() !== "").length;
    } else if (label === "rpm-ostree") {
      // Image updates are atomic: either a new image is available or not.
      count = /Available update:/.test(res.stdout) ? 1 : 0;
    } else if (label === "dnf") {
      // `dnf check-update` is a report, not a clean list: a bare "Upgrades"
      // header, an "Obsoleting packages" section whose continuation lines are
      // indented, and — when a repo pair like updates/updates-archive is
      // enabled — the same package once per repo. Counting every non-"0" line
      // (the old fallback) read 314 real updates as 630 on a Bazzite box. Only
      // a package name, once per run, is an update. Split the raw stdout so
      // the indentation is still visible (lines() trims it away).
      const pkgs = new Set();
      for (const raw of String(res.stdout).split("\n")) {
        if (!raw.trim() || /^\s/.test(raw)) continue; // blank or indented continuation
        const cols = raw.trim().split(/\s+/);
        if (cols.length < 3) continue; // "Upgrades" / "Obsoleting packages"
        pkgs.add(cols[0]);
      }
      count = pkgs.size;
    } else {
      count = lines(res.stdout).filter((l) => l !== "0").length;
    }

    // apt works from the local package lists. If they were never fetched, the
    // simulation answers "0 upgraded" with a zero exit status, and that is not
    // "up to date" — it is "no idea". The difference matters: the fix is to
    // fetch the index, not to do nothing.
    if (label === "apt" && count === 0) {
      const lists = await ctx.run("ls /var/lib/apt/lists 2>/dev/null");
      const listFiles = lines(lists.stdout).filter((l) => l.trim() !== "").length;
      if (listFiles === 0) {
        findings.push(finding({
          severity: "info",
          code: "updates/stale",
          title: "Could not check for updates",
          detail: "The package index has never been fetched on this system, so there is no way to know what updates are available. That is not the same as being up to date.",
          evidence: "apt: /var/lib/apt/lists is empty",
          fix: "Fetch the index with: `sudo apt update`, then run the check again.",
          confidence: "high",
        }));
        if (useCache) writeCache("updates", findings);
        return findings;
      }
    }

    // openSUSE Tumbleweed is rolling and `zypper up` is the wrong verb there
    // (`dup` is the supported full upgrade); Leap keeps `up`. Alpine wants the
    // index refreshed in the same breath as the upgrade.
    const zypperVerb = ctx.dist?.id === "opensuse-tumbleweed" ? "zypper dup" : "zypper update";
    const fixCmd = label === "apt" ? "apt upgrade" : label === "pacman" ? "pacman -Syu" : label === "rpm-ostree" ? "rpm-ostree upgrade" : label === "zypper" ? zypperVerb : label === "apk" ? "apk update && apk upgrade" : label === "xbps" ? "xbps-install -Su" : "dnf upgrade";
    const rebootNote = label === "rpm-ostree" ? " Reboot to activate it." : "";

    if (count === 0) {
      findings.push(finding({
        severity: "info",
        code: "updates/none",
        title: "System is up to date",
        detail: `No pending updates found via ${label}.`,
        evidence: `${label}: 0 updates`,
        fix: null,
        confidence: "high",
      }));
    } else if (count <= 10) {
      findings.push(finding({
        severity: "info",
        code: "updates/pending",
        title: `${plural(count, "update")} available`,
        detail: `There ${count === 1 ? "is" : "are"} ${count} package update${count > 1 ? "s" : ""} waiting. Updating regularly keeps security fixes current.`,
        evidence: `${label}: ${count} pending`,
        fix: `Apply ${count === 1 ? "it" : "them"} with: \`sudo ${fixCmd}\`${rebootNote}`,
        confidence: "high",
      }));
    } else {
      findings.push(finding({
        severity: "medium",
        code: "updates/pending",
        title: `${count} updates available`,
        detail: `There are ${count} package updates waiting. A large backlog means security fixes are also pending.`,
        evidence: `${label}: ${count} pending`,
        fix: `Apply them with: \`sudo ${fixCmd}\`${rebootNote}`,
        confidence: "high",
      }));
    }
    if (useCache) writeCache("updates", findings);
    return findings;
  },
});
