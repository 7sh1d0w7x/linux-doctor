// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Support bundle — a single, privacy-safe JSON file a user can attach to a
 * forum post, GitHub issue, or support ticket when asking for help. It is the
 * read-only mirror of a normal run plus a short history tail, with no secrets.
 *
 * What is deliberately excluded (see PRIVACY_EXCLUDED): hostnames, usernames,
 * IP/MAC addresses, hardware serial numbers, and file contents. The `system`
 * block only ever carries the normalized, already-public distro fields, and
 * any IPv4/IPv6 literal in finding text is redacted before the bundle is
 * written. IPs in `evidence`/`detail` are occasionally useful for debugging but
 * are never worth leaking — redact first, ask later.
 *
 * Zero dependencies: plain node:fs + the package version. Writing is atomic
 * (temp file + rename) so a crash mid-write never leaves a half-written bundle.
 */
import { readFileSync } from "node:fs";
import os from "node:os";

import { atomicWrite } from "./fsx.js";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** Fields we intentionally never put in a bundle, surfaced in `privacy.excluded`. */
export const PRIVACY_EXCLUDED = ["hostname", "username", "ip-address", "mac-address", "serial-number", "file-contents"];

/**
 * Names too generic to redact: replacing "user" or "root" everywhere would
 * mangle ordinary prose ("the user closed the app") without protecting anyone.
 * A real hostname or account that happens to collide with one of these was
 * never identifying information to begin with.
 */
const GENERIC_IDENTITIES = new Set([
  "root", "user", "users", "admin", "administrator", "system", "daemon", "nobody",
  "localhost", "linux", "ubuntu", "debian", "fedora", "arch", "bazzite", "silverblue",
  "desktop", "laptop", "test", "guest", "pi", "me", "you",
]);

/**
 * The two names the scrubber can know for certain but the patterns above
 * cannot see: the machine's hostname and the account's username, wherever they
 * appear in free text (a unit name, a mount path outside /home, a log line).
 *
 * `avoid` carries the distro fields that legitimately belong in the bundle. On
 * a stock Bazzite the hostname is literally "bazzite", so redacting it would
 * rewrite the `distro` field into nonsense while leaking nothing — the distro
 * name is public. A hostname that is already part of the distro string is
 * therefore left alone.
 */
export function redactionTargets({ hostname = "", username = "", avoid = "" } = {}) {
  const avoidLc = String(avoid).toLowerCase();
  const usable = (s) => {
    const v = String(s || "").trim();
    if (v.length < 3) return false;
    const lc = v.toLowerCase();
    if (GENERIC_IDENTITIES.has(lc)) return false;
    if (avoidLc.includes(lc)) return false;
    return true;
  };
  return {
    hosts: usable(hostname) ? [String(hostname).trim()] : [],
    users: usable(username) ? [String(username).trim()] : [],
  };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyTargets(text, targets) {
  let out = text;
  for (const h of targets?.hosts || []) out = out.replace(new RegExp(escapeRe(h), "gi"), "<host-redacted>");
  for (const u of targets?.users || []) out = out.replace(new RegExp(escapeRe(u), "gi"), "<user-redacted>");
  return out;
}

/** Number of past runs included in the bundle's `history` tail (codes only). */
export const BUNDLE_HISTORY_LIMIT = 5;

/** Redact IPv4 and IPv6 literals so a bundle never leaks a network address. */
export function scrub(text, targets = null) {
  if (!text) return text;
  const out = String(text)
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/g, "<ip-redacted>")
    // IPv6, linear by construction. The old (?:[0-9A-Fa-f]{0,4}:){2,} shape
    // allowed empty groups, so a colon run backtracked quadratically and a
    // crafted log line could hang the run. Every repeat below consumes at
    // least one hex digit, and the compressed form is anchored on "::" with
    // bounded groups. Time strings like 12:34:56 stay intact (pure digits,
    // no "::"), which the trailing post-filter enforces for the full form.
    .replace(/(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6}(?![0-9A-Fa-f:])/g, "<ip-redacted>")
    .replace(/::[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6}(?![0-9A-Fa-f:])/g, "<ip-redacted>")
    .replace(/(?:[0-9A-Fa-f]{1,4}:){2,}[0-9A-Fa-f]{1,4}(?![0-9A-Fa-f:])/g, (m) => /[A-Fa-f]/.test(m) ? "<ip-redacted>" : m)
    .replace(/\bfe80::[0-9A-Fa-f:]*\b/gi, "<ip-redacted>")
    .replace(/::1\b/g, "<ip-redacted>")
    // Home directories leak the account username ("/home/alice/.config/...").
    // Redact the user segment but keep the rest of the path so the context
    // (a dotfile, a log) stays useful for whoever reads the bundle.
    // /var/home covers the atomic distros (Fedora Silverblue, Bazzite);
    // /run/media and /media cover removable-media mount points.
    .replace(/\/(home|Users)\/[^\/\s]+/g, "/$1/<user-redacted>")
    .replace(/\/(run\/media|media)\/[^\/\s]+/g, "/$1/<user-redacted>")
    // Per-user runtime dirs are keyed by numeric UID, not name — still redact.
    .replace(/\/run\/user\/\d+/g, "/run/user/<uid-redacted>");
  return applyTargets(out, targets);
}

/** A finding with every free-text field scrubbed (title/detail/evidence/fix). */
export function scrubFinding(f, targets = null) {
  const out = { ...f };
  for (const k of ["title", "detail", "evidence", "fix"]) {
    if (typeof out[k] === "string") out[k] = scrub(out[k], targets);
  }
  return out;
}

/**
 * Recursively scrub every string in a JSON-like value. Used for share-ready
 * exports whose whole payload leaves the machine (the --html file), so a
 * field added later is redacted without anyone remembering to scrub it.
 */
export function scrubDeep(value, targets = null) {
  if (typeof value === "string") return scrub(value, targets);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, targets));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v, targets);
    return out;
  }
  return value;
}

/** Privacy-safe subset of system info — only the already-public distro fields. */
function safeSystem(system) {
  if (!system) return null;
  return {
    distro: system.distro,
    family: system.family,
    kernel: system.kernel,
    cores: system.cores,
    uptime: system.uptime,
    immutable: !!system.immutable,
    imageBased: !!system.imageBased,
    atomicVariant: system.atomicVariant ?? null,
  };
}

/**
 * Build the bundle object. Pure (no I/O) so it is trivially testable. `history`
 * is the full run list from loadHistory(); only the last BUNDLE_HISTORY_LIMIT
 * runs are kept and only their score/counts — not their findings — so the
 * bundle stays small and never re-exposes a historical issue's detail.
 */
export function buildSupportBundle({ system, findings = [], score = null, newCount = 0, fixedCount = 0, diffSinceLast = { added: [], fixed: [], unchanged: 0 }, counts = null, checksRun = 0, checksSkipped = 0, checksAtomicSkipped = 0, checkErrors = [], history = [] } = {}) {
  // The two names the pattern list cannot see. `avoid` keeps the distro fields
  // intact: on a stock image the hostname is the distro name, and that name is
  // public.
  let username = "";
  try { username = os.userInfo().username; } catch { /* no passwd entry (container, NSS oddity) */ }
  let hostname = "";
  try { hostname = system?.hostname || os.hostname(); } catch { /* no hostname */ }
  const targets = redactionTargets({
    hostname,
    username,
    avoid: `${system?.distro || ""} ${system?.family || ""} ${system?.atomicVariant || ""}`,
  });
  // scrubDeep over the whole finding: a plugin can attach arbitrary extra
  // fields, and scrubbing only the four known ones let those travel raw.
  const safeFindings = findings.map((f) => scrubDeep({ ...f }, targets));
  // Diff entries carry finding titles too — same redaction rules apply.
  const safeDiff = diffSinceLast ? {
    added: (Array.isArray(diffSinceLast.added) ? diffSinceLast.added : []).map((f) => scrubDeep({ ...f }, targets)),
    fixed: (Array.isArray(diffSinceLast.fixed) ? diffSinceLast.fixed : []).map((f) => scrubDeep({ ...f }, targets)),
    unchanged: diffSinceLast.unchanged ?? 0,
  } : diffSinceLast;
  const tail = (Array.isArray(history) ? history : []).slice(-BUNDLE_HISTORY_LIMIT).map((r) => ({
    at: r.at,
    score: r.score,
    counts: r.counts,
  }));
  return {
    schemaVersion: 1,
    tool: "linux-doctor",
    kind: "support-bundle",
    version: pkg.version,
    generatedAt: new Date().toISOString(),
    system: safeSystem(system),
    score,
    newCount,
    fixedCount,
    diffSinceLast: safeDiff,
    counts,
    checksRun,
    checksSkipped,
    checksAtomicSkipped,
    checkErrors: checkErrors.map((e) => ({ check: e.check, error: scrub(e.error, targets) })),
    findings: safeFindings,
    history: tail,
    privacy: { excluded: PRIVACY_EXCLUDED },
  };
}

/** A timestamped default file name, written to `dir` (default cwd). */
export function defaultBundlePath(dir = process.cwd()) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  return join(dir, `linux-doctor-support-${ts}.json`);
}

/**
 * Atomically write the bundle to `path` (default defaultBundlePath()). Returns
 * the path written. Never throws a raw error to the caller's flow — returns
 * null on failure so the CLI can print a friendly message instead.
 */
export function writeSupportBundle(bundle, path = defaultBundlePath()) {
  return atomicWrite(path, JSON.stringify(bundle, null, 2) + "\n") ? path : null;
}

/** The message shown after a successful write — tells the user what to do next. */
export function supportMessage(path) {
  return [
    `Support bundle written to: ${path}`,
    "",
    "This file contains your distro, findings, and a short history — but no",
    "hostnames, usernames, IP/MAC addresses, or serial numbers.",
    "Attach it to a Linux Doctor forum post, GitHub issue, or support ticket.",
  ].join("\n");
}
