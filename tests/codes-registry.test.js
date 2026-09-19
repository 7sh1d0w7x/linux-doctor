// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Finding-code registry — the drift guard for Phase 1 (findings trust).
 *
 * Pins every built-in finding code to its allowed severity set and its
 * check's category. A new code, a removed code, or a severity drifting
 * outside the pinned set fails the suite — exactly the "unannounced change"
 * the rubric (docs/severity.md) forbids.
 *
 * It also enforces the static authoring rules:
 *   - every `code:` in a builtin check is a string literal (ternaries of
 *     literals are fine; dynamic expressions are not) matching
 *     ^[a-z0-9-]+/[a-z0-9-]+$
 *   - literal titles carry no trailing period and stay short enough that a
 *     prepended count cannot push the rendered line past readability
 *   - `evidence: null` appears only on the reviewed data-absence allowlist
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../src/checks/", import.meta.url).pathname;
const CODE_RE = /^[a-z0-9-]+\/[a-z0-9-]+$/;

/**
 * The registry. `sev` lists every severity the code may legitimately emit
 * (conditional checks list more than one). `cat` is the check's category.
 * Derived from a full source sweep on 2026-08-22; see docs/severity.md.
 *
 * Exported so sibling tests can pin their own contracts against it (the
 * safe-fix catalog test checks catalog ↔ registry consistency) — the
 * registry stays THE single source of truth for code identity.
 */
export const REGISTRY = {
  // audio
  "audio/no-output": { sev: ["medium"], cat: "audio" },
  "audio/no-server": { sev: ["medium"], cat: "audio" },
  "audio/ok": { sev: ["info"], cat: "audio" },
  "audio/sinks-skipped": { sev: ["info"], cat: "audio" },
  // security / autologin
  "security/autologin": { sev: ["medium"], cat: "security" },
  "security/apparmor": { sev: ["info"], cat: "security" },
  "security/auto-update": { sev: ["info"], cat: "security" },
  "security/firewall": { sev: ["info"], cat: "security" },
  "security/no-firewall": { sev: ["info"], cat: "security" }, // documented exception, docs/severity.md
  "security/firewall-unknown": { sev: ["info"], cat: "security" },
  "security/selinux": { sev: ["info"], cat: "security" },
  // backup
  "backup/none": { sev: ["info"], cat: "backup" },
  "backup/ok": { sev: ["info"], cat: "backup" },
  "backup/stale": { sev: ["medium"], cat: "backup" },
  "backup/unknown": { sev: ["info"], cat: "backup" },
  "backup/unscheduled": { sev: ["info"], cat: "backup" },
  // certs
  "certs/critical": { sev: ["high"], cat: "security" },
  "certs/expiring": { sev: ["medium"], cat: "security" },
  "certs/ok": { sev: ["info"], cat: "security" },
  "certs/skipped": { sev: ["info"], cat: "security" },
  // ports
  "ports/exposed-risky": { sev: ["medium"], cat: "security" },
  "ports/ok": { sev: ["info"], cat: "security" },
  "ports/skipped": { sev: ["info"], cat: "security" },
  // fds
  "fds/exhausted": { sev: ["high", "medium"], cat: "system" },
  // battery
  "battery/low": { sev: ["medium"], cat: "hardware" },
  "battery/none": { sev: ["info"], cat: "hardware" }, // evidence: null allowed (data absence IS the finding)
  "battery/status": { sev: ["info"], cat: "hardware" },
  "battery/wear": { sev: ["info", "medium"], cat: "hardware" },
  // bluetooth
  "bluetooth/failed": { sev: ["medium"], cat: "hardware" },
  "bluetooth/none": { sev: ["info"], cat: "hardware" },
  "bluetooth/ok": { sev: ["info"], cat: "hardware" },
  "bluetooth/stopped": { sev: ["medium"], cat: "hardware" },
  // containerdisk / containers
  "containerdisk/high": { sev: ["high"], cat: "containers" },
  "containerdisk/ok": { sev: ["info"], cat: "containers" },
  "containerdisk/skipped": { sev: ["info"], cat: "containers" },
  "containerdisk/warn": { sev: ["medium"], cat: "containers" },
  "containers/docker-stopped": { sev: ["medium"], cat: "containers" },
  "containers/none": { sev: ["info"], cat: "containers" },
  "containers/ok": { sev: ["info"], cat: "containers" },
  "containers/oom": { sev: ["high"], cat: "containers" },
  "containers/dead": { sev: ["medium"], cat: "containers" },
  "containers/restarting": { sev: ["medium"], cat: "containers" },
  "containers/podman-failed": { sev: ["medium"], cat: "containers" },
  // crash
  "crash/coredumps": { sev: ["high", "medium"], cat: "stability" },
  "crash/panic": { sev: ["high"], cat: "stability" },
  "crash/reboots": { sev: ["info", "medium", "high"], cat: "stability" },
  "crash/skipped": { sev: ["info"], cat: "stability" },
  // boot / cache
  "boot/full": { sev: ["high", "medium"], cat: "system" },
  "boot/no-config": { sev: ["medium"], cat: "system" },
  "boot/ok": { sev: ["info"], cat: "system" },
  "cache/large": { sev: ["info", "medium"], cat: "system" },
  "cache/ok": { sev: ["info"], cat: "system" },
  "cache/trash": { sev: ["info", "medium"], cat: "system" },
  // disk / fs / inodes
  "disk/full": { sev: ["high", "medium"], cat: "storage" },
  "disk/skipped": { sev: ["info"], cat: "storage" },
  "raid/degraded": { sev: ["high"], cat: "storage" },
  "raid/rebuilding": { sev: ["medium"], cat: "storage" },
  "raid/ok": { sev: ["info"], cat: "storage" },
  "fs/btrfs-errors": { sev: ["high"], cat: "storage" },
  "fs/io-errors": { sev: ["high"], cat: "storage" },
  "fs/ok": { sev: ["info"], cat: "storage" },
  "fs/readonly-remount": { sev: ["high"], cat: "storage" },
  "inodes/full": { sev: ["high", "medium"], cat: "storage" },
  "inodes/skipped": { sev: ["info"], cat: "storage" },
  // firmware / flatpak / fstrim
  "firmware/none": { sev: ["info"], cat: "system" },
  "firmware/not-checked": { sev: ["info"], cat: "system" },
  "firmware/pending": { sev: ["medium"], cat: "system" },
  "flatpak/none": { sev: ["info"], cat: "packages" },
  "flatpak/pending": { sev: ["info", "medium"], cat: "packages" },
  // flatpak/unused-runtimes is intentionally absent: the CLI exposes no
  // read-only way to know which runtimes are unused (see src/checks/flatpak.js).
  "fstrim/disabled": { sev: ["medium"], cat: "storage" },
  "fstrim/ok": { sev: ["info"], cat: "storage" },
  "fstrim/ok-discard": { sev: ["info"], cat: "storage" },
  "fstrim/skipped": { sev: ["info"], cat: "storage" },
  // gpu
  "gpu/amd": { sev: ["info"], cat: "graphics" },
  "gpu/amd-missing": { sev: ["medium"], cat: "graphics" },
  "gpu/driver": { sev: ["info"], cat: "graphics" },
  "gpu/none": { sev: ["info"], cat: "graphics" },
  "gpu-usage/vram-full": { sev: ["medium"], cat: "graphics" },
  "gpu-usage/active": { sev: ["info"], cat: "graphics" },
  "gpu/nouveau": { sev: ["medium"], cat: "graphics" },
  "gpu/nvidia": { sev: ["info"], cat: "graphics" },
  "gpu/nvidia-missing": { sev: ["medium"], cat: "graphics" },
  "gpu/skipped": { sev: ["info"], cat: "graphics" }, // evidence: null allowed (data absence)
  "gpu/software-rendering": { sev: ["medium"], cat: "graphics" },
  // hardware
  "hardware/ecc": { sev: ["info", "medium", "high"], cat: "hardware" },
  "hardware/mce": { sev: ["high"], cat: "hardware" },
  "hardware/ok": { sev: ["info"], cat: "hardware" },
  "hardware/skipped": { sev: ["info"], cat: "hardware" },
  // journald / journal
  "journald/large": { sev: ["medium"], cat: "system" },
  "journald/ok": { sev: ["info"], cat: "system" },
  "journald/skipped": { sev: ["info"], cat: "system" },
  "journal/errors": { sev: ["info", "medium"], cat: "stability" },
  "journal/no-noise": { sev: ["info"], cat: "stability" },
  "journal/skipped": { sev: ["info"], cat: "stability" },
  "journal/unknown": { sev: ["info"], cat: "stability" },
  // load / locales / luks
  "load/busy": { sev: ["info"], cat: "performance" },
  "load/overloaded": { sev: ["medium", "high"], cat: "performance" },
  "load/skipped": { sev: ["info"], cat: "performance" },
  "locales/broken": { sev: ["medium"], cat: "system" },
  "luks/encrypted": { sev: ["info"], cat: "security" },
  "luks/none": { sev: ["info"], cat: "security" },
  // memory
  "memory/low": { sev: ["medium", "high"], cat: "performance" },
  "memory/skipped": { sev: ["info"], cat: "performance" },
  "memory/swap": { sev: ["info"], cat: "performance" },
  // network / ntp
  "network/dns": { sev: ["medium"], cat: "network" },
  "network/dns-slow": { sev: ["medium"], cat: "network" },
  "network/no-route": { sev: ["medium"], cat: "network" },
  "network/ok": { sev: ["info"], cat: "network" },
  "network/skipped": { sev: ["info"], cat: "network" },
  "ntp/ok": { sev: ["info"], cat: "system" },
  "ntp/pending": { sev: ["medium"], cat: "system" },
  "ntp/skipped": { sev: ["info"], cat: "system" },
  "ntp/unsynced": { sev: ["medium"], cat: "system" },
  // oom / orphans / processes
  "oom/kills": { sev: ["medium", "high"], cat: "stability" },
  "oom/ok": { sev: ["info"], cat: "stability" },
  "orphans/many": { sev: ["medium"], cat: "system" },
  "orphans/none": { sev: ["info"], cat: "system" },
  "orphans/some": { sev: ["info"], cat: "system" },
  "processes/high": { sev: ["medium"], cat: "performance" }, // degradation, not data risk — docs/severity.md rule 3
  "processes/ok": { sev: ["info"], cat: "performance" },
  "processes/skipped": { sev: ["info"], cat: "performance" },
  "processes/warn": { sev: ["medium"], cat: "performance" },
  // packages
  "packages/broken": { sev: ["high"], cat: "system" },
  "packages/locked": { sev: ["medium"], cat: "system" },
  "packages/ok": { sev: ["info"], cat: "system" },
  // reboot
  "reboot/skipped": { sev: ["info"], cat: "system" },
  "reboot/ok": { sev: ["info"], cat: "system" },
  "reboot/required": { sev: ["medium"], cat: "system" },
  // secureboot
  "secureboot/bios": { sev: ["info"], cat: "security" },
  "secureboot/disabled": { sev: ["info"], cat: "security" },
  "secureboot/enabled": { sev: ["info"], cat: "security" },
  "secureboot/no-tpm": { sev: ["info"], cat: "security" },
  "secureboot/tpm": { sev: ["info"], cat: "security" },
  // services / smart / snap / ssh / suspend
  "services/failed": { sev: ["medium", "high"], cat: "system" },
  "services/restart-loop": { sev: ["high"], cat: "system" },
  "services/skipped": { sev: ["info"], cat: "system" },
  "smart/failing": { sev: ["high"], cat: "storage" },
  "smart/good": { sev: ["info"], cat: "storage" },
  "smart/needs-root": { sev: ["info"], cat: "storage" },
  "smart/skipped": { sev: ["info"], cat: "storage" },
  "snap/no-timer": { sev: ["medium"], cat: "packages" },
  "snap/ok": { sev: ["info"], cat: "packages" },
  "snap/pending": { sev: ["info", "medium"], cat: "packages" },
  "ssh/ok": { sev: ["info"], cat: "security" },
  "ssh/root-login": { sev: ["medium"], cat: "security" },
  "ssh/root-password": { sev: ["high"], cat: "security" },
  "suspend/failed": { sev: ["medium"], cat: "system" },
  // thermal / timers / updates / wayland / zram
  "thermal/hot": { sev: ["high"], cat: "hardware" }, // sustained >95°C risks hardware damage
  "thermal/ok": { sev: ["info"], cat: "hardware" },
  "thermal/skipped": { sev: ["info"], cat: "hardware" },
  "thermal/throttle": { sev: ["medium"], cat: "hardware" },
  "thermal/warm": { sev: ["medium"], cat: "hardware" },
  "timers/broken": { sev: ["medium"], cat: "system" },
  "timers/ok": { sev: ["info"], cat: "system" },
  "timers/skipped": { sev: ["info"], cat: "system" },
  "updates/none": { sev: ["info"], cat: "packages" },
  "updates/pending": { sev: ["info", "medium"], cat: "packages" },
  "updates/stale": { sev: ["info"], cat: "updates" },
  "updates/skipped": { sev: ["info"], cat: "packages" },
  "wayland/healthy": { sev: ["info"], cat: "desktop" },
  // wifi
  "wifi/blocked": { sev: ["medium"], cat: "network" },
  "wifi/disabled": { sev: ["medium"], cat: "network" },
  "wifi/no-adapter": { sev: ["info"], cat: "network" },
  "wifi/ok": { sev: ["info"], cat: "network" },
  "wayland/loginctl-missing": { sev: ["info"], cat: "desktop" },
  "wayland/no-compositor": { sev: ["medium"], cat: "desktop" },
  "wayland/no-session": { sev: ["info"], cat: "desktop" },
  "wayland/not-graphical": { sev: ["info"], cat: "desktop" },
  "wayland/software-rendering": { sev: ["medium"], cat: "desktop" },
  "wayland/x11": { sev: ["info"], cat: "desktop" },
  "zram/full": { sev: ["medium"], cat: "performance" },
  "zram/ok": { sev: ["info"], cat: "performance" },
  "zram/skipped": { sev: ["info"], cat: "performance" },
  "zram/swappiness": { sev: ["info"], cat: "performance" },
};

/** Codes whose findings may ship with evidence explicitly null (data-absence findings). */
const EVIDENCE_NULL_ALLOWLIST = new Set([
  "battery/none", // no power supply classed as battery — absence is the finding
  "gpu/skipped", // no GPU info available on this machine
  "updates/skipped", // package manager unavailable/unreadable — absence is the finding
]);

function listFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else if (e.name.endsWith(".js") && !["index.js", "define.js", "shared.js"].includes(e.name)) out.push(p);
  }
  return out;
}

/** All `code:` value expressions inside finding() call sites of one file. */
function codeExpressions(text) {
  const out = [];
  const starts = [...text.matchAll(/\bfinding\(\{/g)].map((m) => m.index);
  for (let i = 0; i < starts.length; i += 1) {
    // Window up to the next finding() call (or end): avoids brace-matching
    // fragility around template literals while staying within one call site.
    const chunk = text.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : undefined);
    for (const m of chunk.matchAll(/^.*?\bcode:\s*([^,\n]+)/gm)) out.push(m[1].trim());
  }
  return out;
}

test("registry: every builtin code is registered with a valid shape", () => {
  const problems = [];
  for (const [code, meta] of Object.entries(REGISTRY)) {
    if (!CODE_RE.test(code)) problems.push(`bad code format: ${code}`);
    if (!Array.isArray(meta.sev) || meta.sev.length === 0 || meta.sev.some((s) => !["high", "medium", "info"].includes(s))) {
      problems.push(`bad severities for ${code}: ${JSON.stringify(meta.sev)}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("source: every code expression is a literal (or ternary of literals) in the registry", () => {
  const offenders = [];
  const seen = new Set();
  for (const file of listFiles(ROOT)) {
    const rel = file.replace(ROOT, "");
    const text = readFileSync(file, "utf8");
    for (const expr of codeExpressions(text)) {
      const literals = [...expr.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      // After removing the string literals, only a ternary condition made of
      // plain identifiers may remain ("isBtrfs ? "a/x" : "a/y""). Anything
      // with operators, calls, or member access is a dynamic code → reject.
      const stripped = expr.replace(/"[^"]*"/g, "").replace(/[?\s:]/g, "");
      if (literals.length === 0 || !/^[A-Za-z0-9_.]*$/.test(stripped)) {
        offenders.push(`${rel}: dynamic code expression → ${expr}`);
        continue;
      }
      for (const lit of literals) {
        seen.add(lit);
        if (!CODE_RE.test(lit)) offenders.push(`${rel}: code "${lit}" violates ${CODE_RE}`);
        if (!REGISTRY[lit]) offenders.push(`${rel}: unregistered code "${lit}" — add it to tests/codes-registry.test.js`);
      }
    }
  }
  assert.deepEqual(offenders, [], `code discipline violations:\n${offenders.join("\n")}`);

  // Two-way completeness: registry entries must exist in source too (catches typos AND dead entries).
  const missing = Object.keys(REGISTRY).filter((c) => !seen.has(c));
  assert.deepEqual(missing, [], `registry entries not found in any check: ${missing.join(", ")}`);
});

test("source: literal titles have no trailing period and stay short", () => {
  const offenders = [];
  for (const file of listFiles(ROOT)) {
    const rel = file.replace(ROOT, "");
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/title:\s*"([^"]+)"/g)) {
      const t = m[1];
      if (t.endsWith(".")) offenders.push(`${rel}: title ends with "." → "${t}"`);
      if (t.length > 90) offenders.push(`${rel}: title longer than 90 chars → "${t.slice(0, 40)}…"`);
    }
  }
  assert.deepEqual(offenders, [], `title hygiene violations:\n${offenders.join("\n")}`);
});

test("source: evidence:null only on the reviewed data-absence allowlist", () => {
  const offenders = [];
  for (const file of listFiles(ROOT)) {
    const rel = file.replace(ROOT, "");
    const text = readFileSync(file, "utf8");
    // Scan each finding block for an explicit null evidence and its code.
    for (const m of text.matchAll(/finding\(\{[\s\S]*?\}\)/g)) {
      const block = m[0];
      if (!/evidence:\s*null/.test(block)) continue;
      const codes = [...block.matchAll(/code:\s*"([^"]+)"/g)].map((x) => x[1]);
      for (const c of codes) {
        if (!EVIDENCE_NULL_ALLOWLIST.has(c)) {
          offenders.push(`${rel}: evidence:null on "${c}" — add it to EVIDENCE_NULL_ALLOWLIST with a reason, or provide evidence`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `evidence-null violations:\n${offenders.join("\n")}`);
});

test("normalizeFindings: slug fallback exists only as plugin escape hatch", async () => {
  const { normalizeFindings } = await import("../src/findings.js");
  const [derived] = normalizeFindings([{ check: "myplugin", severity: "info", title: "Hello World" }]);
  assert.equal(derived.code, "myplugin/hello-world");
  const [explicit] = normalizeFindings([{ check: "x", severity: "info", title: "t", code: "x/explicit" }]);
  assert.equal(explicit.code, "x/explicit");
});
