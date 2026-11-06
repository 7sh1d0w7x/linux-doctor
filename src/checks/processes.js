// SPDX-License-Identifier: GPL-3.0-or-later
import { lines, num, fmtBytes } from "../utils.js";
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";
import { pkgInstall } from "../distro.js";

/** Friendly names for common app processes. */
const FRIENDLY = {
  brave: "the Brave browser",
  firefox: "the Firefox browser",
  chromium: "the Chromium browser",
  chrome: "the Chrome browser",
  telegram: "Telegram",
  "QtWebEngineProcess": "an embedded web view (often part of a desktop app)",
  code: "VS Code",
  node: "a Node.js process",
  steam: "Steam",
  discord: "Discord",
  plasma: "the KDE desktop shell",
  gnome: "the GNOME desktop shell",
};

export const processes = defineCheck({
  id: "processes",
  title: "Top memory consumers",
  category: "system",
  async run(ctx) {
    const findings = [];
    const t = ctx.thresholds;
    const [psRes, memRes, pssRes] = await Promise.all([
      ctx.run(`ps -eo pid=,rss=,args= 2>/dev/null`),
      ctx.run(`free -b`),
      // `Pss` is share-aware: a page mapped by twenty renderers is divided
      // between them instead of counted twenty times. smaps_rollup is readable
      // for the caller's own processes — exactly where a browser's footprint
      // lives — and anything unreadable falls back to RSS below.
      ctx.run(`grep -m1 -H '^Pss:' /proc/[0-9]*/smaps_rollup 2>/dev/null`),
    ]);
    if (psRes.missing) {
      findings.push(finding({
        severity: "info",
        code: "processes/skipped",
        title: "Memory-consumer check skipped",
        detail: "`ps` is not available on this system, so the top memory consumers could not be listed.",
        evidence: "ps: not found",
        fix: `Install procps (${pkgInstall(ctx.dist, { fedora: "procps-ng", arch: "procps-ng", "*": "procps" })}) and re-run.`,
        confidence: "high",
      }));
      return findings;
    }
    if (!psRes.ok) return findings;

    // A multi-process app (Brave, Chrome, Firefox) spreads its memory across
    // processes that share one binary, so the app's footprint is the sum over
    // its processes — but summing RSS counted every shared page once per
    // process. On a real machine 64 Brave processes summed to 8.19 GB of
    // resident memory while their unique footprint (PSS) was 4.16 GB: almost
    // exactly 2x, and enough to cross the 40% threshold on its own. PSS is
    // used whenever the kernel exposes it; RSS is the per-process fallback for
    // processes smaps_rollup will not open (another user's, or an old kernel).
    const pssByPid = new Map();
    for (const l of lines(pssRes.stdout || "")) {
      const m = /^\/proc\/(\d+)\/smaps_rollup:Pss:\s*(\d+)\s*kB/.exec(l.trim());
      if (m) pssByPid.set(m[1], Number(m[2]) * 1024);
    }
    const byApp = new Map();
    for (const l of lines(psRes.stdout)) {
      const parts = l.trim().split(/\s+/);
      // pid first, args last: `args` is the full command line and may contain
      // spaces, and args-last is the only order that works on both procps and
      // busybox. busybox ignores the column after `args=`, so `args=,rss`
      // dropped the number and Alpine read the command's last word as rss.
      // `ps` reports rss in KiB; convert to bytes so the ratio vs `free -b`
      // (bytes) is correct and fmtBytes displays real units.
      const pid = parts[0];
      if (!/^\d+$/.test(pid || "")) continue;
      const rss = num(parts[1]) * 1024;
      const bytes = pssByPid.has(pid) ? pssByPid.get(pid) : rss;
      if (bytes <= 0) continue;
      // The binary is the first token of args, not truncated the way `comm` is
      // ("QtWebEngineProcess" would arrive as "QtWebEngineProc").
      const bin = parts[2] ? parts[2].split("/").pop() : "unknown";
      const name = bin || "unknown";
      byApp.set(name, (byApp.get(name) || 0) + bytes);
    }
    const rows = [...byApp.entries()]
      .map(([name, bytes]) => ({ name, bytes }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 3);
    if (rows.length === 0) return findings;

    const memOut = lines(memRes.stdout || "");
    const memLine = memOut.find((l) => l.startsWith("Mem:"));
    const header = memOut[0] || "";
    const total = memLine ? num(memLine.split(/\s+/)[1]) : 0;
    // `available` is the kernel's estimate of what a new app could use. procps
    // prints it; busybox's `free` does not, so when it is absent we do not
    // claim pressure (availRatio 1).
    const available = /\bavailable\b/i.test(header) && memLine ? num(memLine.split(/\s+/)[6]) : 0;
    const availRatio = total > 0 && available > 0 ? available / total : 1;
    // A large app is only a problem when the system is short on memory: with
    // half the RAM still available the top consumer is just the top consumer.
    // This is the false alarm a 15GB box got for a browser at ~19% while 9GB
    // was free.
    const tight = availRatio < t.memWarnRatio;
    const top = rows[0];
    const ratio = total > 0 ? top.bytes / total : 0;

    if (tight && top.bytes > 0 && ratio > t.procHighRatio) {
      findings.push(finding({
        severity: "medium",
        code: "processes/high",
        title: "A single app is using a huge amount of memory",
        detail: `${FRIENDLY[top.name] || `The \`${top.name}\` process`} is using ${fmtBytes(top.bytes)}, which is more than 40% of your total RAM. This is very likely why the system feels slow.`,
        evidence: rows.map((r) => `${r.name}\t${fmtBytes(r.bytes)}`).join("\n"),
        fix: "Close unused tabs or quit that app now, then re-run this check.",
        confidence: "high",
      }));
    } else if (tight && top.bytes > 0 && ratio > t.procWarnRatio) {
      findings.push(finding({
        severity: "medium",
        code: "processes/warn",
        title: "A single app is using a lot of memory",
        detail: `${FRIENDLY[top.name] || `The \`${top.name}\` process`} is using ${fmtBytes(top.bytes)}, which is more than 20% of your total RAM. This is the most likely reason the system feels slow.`,
        evidence: rows.map((r) => `${r.name}\t${fmtBytes(r.bytes)}`).join("\n"),
        fix: "Close unused tabs or quit that app and re-run this check.",
        confidence: "high",
      }));
    } else {
      findings.push(finding({
        severity: "info",
        code: "processes/ok",
        title: "Top memory consumers",
        detail: "The largest memory users right now are listed below. This is normal unless the system is under pressure.",
        evidence: rows.map((r) => `${r.name}\t${fmtBytes(r.bytes)}`).join("\n"),
        fix: null,
        confidence: "high",
      }));
    }
    return findings;
  },
});
