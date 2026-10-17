// SPDX-License-Identifier: GPL-3.0-or-later
import { lines, run as realRun, TIMEOUT_MS } from "../utils.js";
import { readCache, writeCache } from "../cache.js";
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";

/**
 * A full depsolve of every installed package — `dnf check` here takes ~15 s of
 * CPU on a 2 900-package Fedora image, and `apt-get check` is the same kind of
 * work. It is the single longest probe in a run: everything else finishes in
 * under two seconds, so this one check decides how long "Re-run" takes.
 *
 * The answer only changes when a package transaction leaves the database
 * inconsistent, so a CLEAN result is cached for 10 minutes (override
 * LINUX_DOCTOR_PACKAGES_TTL_MS; 0 disables). Bad news is never cached: a
 * broken or locked database is re-probed on every run, so a fix shows up on
 * the next click instead of trailing a stale high for the length of the TTL.
 * Same contract as the `updates` check's metadata cache — a bonus, never a
 * dependency: an unwritable cache means the probe simply runs.
 */
const PACKAGES_CACHE_MS = 10 * 60 * 1000;

function packagesCacheTtl() {
  const ttl = Number(process.env.LINUX_DOCTOR_PACKAGES_TTL_MS || PACKAGES_CACHE_MS);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
}

/** Cache only a clean result; writeCache never throws. */
function remember(findings, ttlMs) {
  if (ttlMs && findings.every((f) => f.severity === "info")) writeCache("packages", findings);
  return findings;
}

/**
 * The cache is for real scans only. Tests and fixture replays hand the check a
 * stub runner, and a cache shared with them would make their assertions depend
 * on the developer's machine (and let a fixture's "healthy" land in the real
 * cache). Identity against the imported runner is the one signal the check has.
 */
function cacheTtlFor(ctx) {
  return ctx.run === realRun ? packagesCacheTtl() : 0;
}

/**
 * `apt-get check` refusing the dpkg frontend lock. These lines say nothing
 * about dependency health — only that the run was unprivileged.
 */
const APT_NEEDS_ROOT = /are you root|permission denied|could not open lock|unable to acquire/i;

/**
 * `dnf check` refusing to run without root. Unprivileged dnf cannot create its
 * cache and exits 1 with "filesystem error: cannot create directories:
 * Permission denied" — a line that says nothing about dependency health.
 * Verified in a Fedora container as a non-root user.
 */
const DNF_NEEDS_ROOT = /are you root|permission denied|cannot create directories|has to be run with superuser/i;

/**
 * Lock holders that belong to something other than this run.
 *
 * Checks run concurrently (`RUN_CONCURRENCY` in cli.js) and `packages`,
 * `updates` and `orphans` all shell out to apt, so one of our own apt-get
 * processes can hold the dpkg lock while this probe reads it. Those share our
 * process group and are not "another process" (#24).
 *
 * Input is one row per line: a leading `self <pgid>` for this run, then
 * `<pid> <pgid>` per holder. A holder whose group could not be read exited
 * between `fuser` and `ps` and is holding nothing. If our own group is unknown
 * nothing can be attributed, so nothing is reported: calling every holder
 * foreign there would reinstate the false positive this removed.
 */
export function foreignLockHolders(stdout) {
  const rows = lines(stdout || "")
    .map((l) => l.trim().split(/\s+/))
    .filter((r) => r[0]);
  const ours = rows.find((r) => r[0] === "self")?.[1];
  if (!ours) return [];
  return rows.filter((r) => /^\d+$/.test(r[0]) && r[1] && r[1] !== ours).map((r) => r[0]);
}

/**
 * Package manager health — detects a broken/locked package system that
 * makes `updates` lie ("up to date" when apt/dnf is actually blocked).
 * Checks dpkg audit, apt lock, and dnf/rpm DB. Read-only.
 */
export const packages = defineCheck({
  id: "packages",
  title: "Package manager health",
  category: "system",
  async run(ctx) {
    const findings = [];
    const { pkg, family } = ctx.dist || {};
    const ttlMs = cacheTtlFor(ctx);
    const cached = ttlMs ? readCache("packages", ttlMs) : null;

    // Immutable / atomic systems (Bazzite, Silverblue, bootc): the installed
    // package set is a signed, pre-solved image, and layered packages arrive
    // through rpm-ostree, which refuses a transaction it cannot solve. A full
    // depsolve of ~3 000 packages (`dnf check`, 15 s here) can only re-confirm
    // what the image build already guaranteed — while being slow enough to hit
    // the command cap and answer nothing at all. Verify the database itself,
    // which takes half a second, and say exactly what was not run.
    if (ctx.dist && ctx.dist.imageBased) {
      if (cached) return cached;
      const verify = await ctx.run("rpm --verifydb 2>&1");
      if (!verify.ok) return findings; // unreadable database: claim nothing
      findings.push(finding({
        severity: "info",
        code: "packages/ok",
        title: "Package database is intact",
        detail: "This is an immutable system: packages come from a pre-solved image and rpm-ostree refuses transactions it cannot solve, so the full dependency check is not run. The local RPM database verified clean.",
        evidence: "rpm --verifydb: ok \u00b7 dependency check: not run on immutable systems",
        fix: null,
        confidence: "high",
      }));
      return remember(findings, ttlMs);
    }

    // Debian/Ubuntu family
    if (pkg === "apt" || family === "debian") {
      // The lock is a live, seconds-long fact and costs ~40 ms, so it is
      // probed before the cache lookup: a Re-run while apt is busy must say
      // so even when the (cached) depsolve is still fresh.
      const lockRes = await ctx.run(
        // Holders in our own process group are skipped: `apt-get check` below
        // takes the same frontend lock, and the `updates` and `orphans` checks
        // take it too, so a plain `fuser` reported linux-doctor as "another
        // process". Run as root on a healthy machine that produced a medium
        // "locked by another process" naming linux-doctor itself (#24). The
        // probe reports groups and `foreignLockHolders` decides, so the rule
        // is unit-testable instead of living in the shell's comparison.
        "printf 'self %s\\n' \"$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')\"; " +
          "for pid in $(fuser /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock 2>/dev/null); do " +
          'printf \'%s %s\\n\' "$pid" "$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d \' \')"; done'
      );
      const holders = foreignLockHolders(lockRes.stdout);
      if (lockRes.ok && holders.length > 0) {
        findings.push(finding({
          severity: "medium",
          code: "packages/locked",
          title: "Package manager is locked by another process",
          detail: "Another apt/dpkg process is holding the package lock. Updates cannot run until it finishes.",
          evidence: `lock held by PID ${holders.join(" ")}`,
          fix: "Wait for the other apt process to finish, or if it is stuck, check `ps aux | grep -E 'apt|dpkg'` and close it.",
          confidence: "medium",
        }));
        return findings;
      }

      if (cached) return cached;

      const [dpkgAudit, aptCheck] = await Promise.all([
        ctx.run("dpkg --audit 2>&1 | head -20"),
        // A depsolve of every installed package: the default 8 s cap is the
        // package-manager budget, not the generic one (see TIMEOUT_MS).
        ctx.run("apt-get check 2>&1 | head -20", { timeoutMs: TIMEOUT_MS.PKGMGR }),
      ]);

      const auditOut = (dpkgAudit.stdout || "").trim();
      const checkOut = (aptCheck.stdout || "").trim();
      const hasAudit = auditOut !== "" && !/no packages/i.test(auditOut);
      // `apt-get check` takes the dpkg frontend lock, which an unprivileged run
      // cannot get. `2>&1` folds that refusal into the same string, and a bare
      // `E:` / `error` predicate read it as broken dependencies — so every
      // non-root run on a healthy system produced a high whose evidence was apt
      // saying it is not root. Drop the refusal and require an actual dependency
      // diagnostic (a real one reads "E: Unmet dependencies.").
      const checkNeedsRoot = APT_NEEDS_ROOT.test(checkOut);
      const checkDiag = lines(checkOut).filter((l) => !APT_NEEDS_ROOT.test(l)).join("\n");
      const hasCheckError = /unmet dependencies|broken packages/i.test(checkDiag);

      if (hasAudit) {
        findings.push(finding({
          severity: "high",
          code: "packages/broken",
          title: "Package database has broken packages",
          detail: "`dpkg --audit` reports packages in a broken state. Updates and installs will fail until this is fixed.",
          evidence: lines(auditOut).slice(0, 3).join("\n"),
          fix: "Fix with `sudo dpkg --configure -a` then `sudo apt --fix-broken install`.",
          confidence: "high",
        }));
        return findings;
      }

      if (hasCheckError) {
        findings.push(finding({
          severity: "high",
          code: "packages/broken",
          title: "Package manager reports broken dependencies",
          detail: "`apt-get check` reports broken packages or unmet dependencies.",
          evidence: lines(checkDiag).slice(0, 3).join("\n"),
          fix: "Fix with `sudo apt --fix-broken install` and `sudo apt update`.",
          confidence: "high",
        }));
        return findings;
      }

      // Check for dpkg interrupted flag
      const interrupted = await ctx.run("test -f /var/lib/dpkg/updates/tmp.i 2>/dev/null && echo interrupted; dpkg --audit 2>&1 | grep -q 'half-installed\\|unpacked' && echo half");
      if (interrupted.ok && interrupted.stdout.trim() !== "") {
        findings.push(finding({
          severity: "high",
          code: "packages/broken",
          title: "Package manager was interrupted",
          detail: "A previous apt/dpkg run was interrupted and left packages half-installed.",
          evidence: "dpkg: half-installed / unpacked packages found",
          fix: "Fix with `sudo dpkg --configure -a` then `sudo apt --fix-broken install`.",
          confidence: "high",
        }));
        return findings;
      }

      // Healthy — only claim it when we actually saw the data source
      if (!dpkgAudit.ok && !aptCheck.ok && !lockRes.ok) return findings;
      findings.push(finding({
        severity: "info",
        code: "packages/ok",
        title: "Package manager is healthy",
        detail: "No broken packages or locks were found. apt/dpkg is ready for updates.",
        evidence: `dpkg --audit: clean · apt-get check: ${checkNeedsRoot ? "skipped (needs root)" : "ok"}`,
        fix: null,
        confidence: "high",
      }));
      return remember(findings, ttlMs);
    }

    // Fedora/RHEL family — check dnf. (`rpm -Va` was run here too and its
    // result never used; two full rpmdb verifications were pure dead work
    // that almost always exceeded the timeout.)
    if (pkg === "dnf" || family === "fedora") {
      if (cached) return cached;
      // No `| head`: the exit status would belong to head, so the guard below
      // could never fire and a failed dnf looked successful. Slice in JS.
      const dnfCheck = await ctx.run("dnf check 2>&1", { timeoutMs: TIMEOUT_MS.PKGMGR });
      const out = String(dnfCheck.stdout || "");
      // An unprivileged dnf cannot create its cache. Its refusal was read as a
      // broken package database (high) on a healthy machine — the same false
      // positive the apt lock refusal used to cause. It is "could not check".
      const needsRoot = DNF_NEEDS_ROOT.test(out);
      const diag = lines(out).filter((l) => !DNF_NEEDS_ROOT.test(l)).join("\n");

      if (!needsRoot && /error|broken|conflict|missing dependency/i.test(diag.toLowerCase()) && diag.trim() !== "") {
        findings.push(finding({
          severity: "high",
          code: "packages/broken",
          title: "Package manager reports problems",
          detail: "`dnf check` reports package problems that may block updates.",
          evidence: lines(diag).slice(0, 3).join("\n"),
          fix: "Check `sudo dnf check` and `sudo dnf distro-sync --assumeno` to see details.",
          confidence: "medium",
        }));
        return findings;
      }

      // Only claim health when the check actually ran — or when the reason it
      // did not is missing root, which the evidence then says out loud.
      if (!dnfCheck.ok && !needsRoot) return findings;
      findings.push(finding({
        severity: "info",
        code: "packages/ok",
        title: "Package manager is healthy",
        detail: "No package problems were found. dnf/rpm is ready for updates.",
        evidence: `dnf check: ${needsRoot ? "skipped (needs root)" : "ok"}`,
        fix: null,
        confidence: "high",
      }));
      return remember(findings, ttlMs);
    }

    // Arch — check pacman DB
    if (pkg === "pacman" || family === "arch") {
      // No `| head`: that made `pacmanCheck.ok` the exit status of head, so the
      // guard below could never fire. `pacman -Dk` does not need root (verified:
      // it exits 0 unprivileged), which is why the dead gate was harmless here,
      // but a gate that cannot fail is not a gate. Slice the output in JS.
      const pacmanCheck = await ctx.run("pacman -Dk 2>&1");
      // `pacman -Dk` prints "No database errors have been found!" when the
      // database is fine. A bare /error/ matched that sentence, so a clean Arch
      // system got a high "Pacman database has errors" whose evidence was the
      // sentence saying there are none. Drop the success line and require an
      // actual diagnostic (a real one reads "error: package x: missing ...").
      const out = (pacmanCheck.stdout || "")
        .split("\n")
        .filter((l) => !/No database errors have been found!/i.test(l))
        .join("\n");
      if (/\berror\b|missing|mismatch/i.test(out) && out.trim() !== "") {
        findings.push(finding({
          severity: "high",
          code: "packages/broken",
        title: "Pacman database has errors",
        detail: "`pacman -Dk` reports database errors.",
        evidence: lines(out).slice(0, 3).join("\n"),
        fix: "Check `pacman -Dk` and `sudo pacman -Syy` to refresh the database.",
        confidence: "high",
      }));
        return findings;
      }
      if (!pacmanCheck.ok) return findings;
      findings.push(finding({
        severity: "info",
        code: "packages/ok",
        title: "Package manager is healthy",
        detail: "Pacman database looks healthy.",
        evidence: "pacman -Dk: ok",
        fix: null,
        confidence: "high",
      }));
      return findings;
    }

    // openSUSE — verify installed package dependencies. `-D` is the dry run;
    // without it zypper would try to fix what it finds.
    if (pkg === "zypper" || family === "suse") {
      const verify = await ctx.run("zypper --non-interactive verify -D 2>&1");
      const diag = lines(verify.stdout || "")
        .filter((l) => !/are satisfied|loading repository data|reading installed packages/i.test(l))
        .join("\n");
      if (/not satisfied|broken|nothing provides|conflict|missing/i.test(diag) && diag.trim() !== "") {
        findings.push(finding({
          severity: "high",
          code: "packages/broken",
          title: "Package manager reports broken dependencies",
          detail: "`zypper verify` reports unmet dependencies, which block updates.",
          evidence: diag.split("\n").slice(0, 3).join("\n"),
          fix: "Check `sudo zypper verify` (without -D) to see and fix the details.",
          confidence: "medium",
        }));
        return findings;
      }
      if (!verify.ok) return findings;
      findings.push(finding({
        severity: "info",
        code: "packages/ok",
        title: "Package manager is healthy",
        detail: "Dependencies of all installed packages are satisfied. zypper is ready for updates.",
        evidence: "zypper verify: ok",
        fix: null,
        confidence: "high",
      }));
      return findings;
    }

    // Void — xbps package database consistency. Read-only.
    if (pkg === "xbps" || family === "void") {
      const pkgdb = await ctx.run("xbps-pkgdb -a 2>&1");
      const out = String(pkgdb.stdout || "");
      if (/error|broken|mismatch|missing/i.test(out) && out.trim() !== "") {
        findings.push(finding({
          severity: "high",
          code: "packages/broken",
          title: "Package database has errors",
          detail: "`xbps-pkgdb -a` reports inconsistencies in the package database.",
          evidence: lines(out).slice(0, 3).join("\n"),
          fix: "Check `xbps-pkgdb -a` and reinstall the affected packages.",
          confidence: "medium",
        }));
        return findings;
      }
      if (!pkgdb.ok) return findings;
      findings.push(finding({
        severity: "info",
        code: "packages/ok",
        title: "Package manager is healthy",
        detail: "The xbps package database is consistent.",
        evidence: "xbps-pkgdb -a: ok",
        fix: null,
        confidence: "high",
      }));
      return findings;
    }

    // Alpine — `apk fix --simulate` is the dry run: it reports what it would
    // repair (missing files, broken dependencies) and changes nothing. It runs
    // unprivileged (verified).
    if (pkg === "apk" || family === "alpine") {
      const fix = await ctx.run("apk fix --simulate 2>&1");
      const diag = lines(fix.stdout || "")
        .filter((l) => !/^OK:/i.test(l))
        .join("\n");
      if (/error|broken|missing|failed|repair/i.test(diag) && diag.trim() !== "") {
        findings.push(finding({
          severity: "high",
          code: "packages/broken",
          title: "Package manager reports problems",
          detail: "`apk fix --simulate` reports packages that need repair.",
          evidence: diag.split("\n").slice(0, 3).join("\n"),
          fix: "Check `sudo apk fix` to see and repair the details.",
          confidence: "medium",
        }));
        return findings;
      }
      if (!fix.ok) return findings;
      findings.push(finding({
        severity: "info",
        code: "packages/ok",
        title: "Package manager is healthy",
        detail: "apk reports nothing to repair.",
        evidence: "apk fix --simulate: ok",
        fix: null,
        confidence: "high",
      }));
      return findings;
    }

    // Unknown family — nothing to say
    return findings;
  },
});
