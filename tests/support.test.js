// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSupportBundle,
  writeSupportBundle,
  defaultBundlePath,
  supportMessage,
  scrub,
  scrubFinding,
  scrubDeep,
  redactionTargets,
  PRIVACY_EXCLUDED,
  BUNDLE_HISTORY_LIMIT,
} from "../src/support.js";

test("scrub: redacts IPv4 and IPv6 literals", () => {
  assert.equal(scrub("connected to 192.168.1.42 port 22"), "connected to <ip-redacted> port 22");
  assert.equal(scrub("peer fe80::1ff:fe23:4567:890a up"), "peer <ip-redacted> up");
  assert.equal(scrub(null), null);
  assert.equal(scrub("no address here"), "no address here");
});

test("scrub: redacts home-directory usernames but keeps path context", () => {
  assert.equal(scrub("config at /home/alice/.config/linux-doctor/config.json"), "config at /home/<user-redacted>/.config/linux-doctor/config.json");
  assert.equal(scrub("/Users/bob/Library/Logs/app.log"), "/Users/<user-redacted>/Library/Logs/app.log");
  // /home itself (no user segment) is untouched; /run/user/<uid> is redacted.
  assert.equal(scrub("/home is a mountpoint"), "/home is a mountpoint");
  assert.equal(scrub("XDG_RUNTIME_DIR=/run/user/1000/bus"), "XDG_RUNTIME_DIR=/run/user/<uid-redacted>/bus");
});

test("buildSupportBundle: privacy-safe system subset and metadata", () => {
  const b = buildSupportBundle({
    system: { distro: "Fedora 40", family: "fedora", kernel: "6.8.9", cores: "4", uptime: "1h", immutable: true, imageBased: true, atomicVariant: "bazzite", osRelease: { SECRET: "x" } },
    findings: [],
    score: 80,
  });
  assert.equal(b.kind, "support-bundle");
  assert.equal(b.tool, "linux-doctor");
  assert.equal(b.score, 80);
  assert.deepEqual(Object.keys(b.system).sort(), ["atomicVariant", "cores", "distro", "family", "imageBased", "immutable", "kernel", "uptime"]);
  assert.equal(b.system.osRelease, undefined, "raw os-release must never be included");
  assert.deepEqual(b.privacy.excluded, PRIVACY_EXCLUDED);
});

test("buildSupportBundle: findings are scrubbed, history tail is codes-only", () => {
  const b = buildSupportBundle({
    system: { distro: "Fedora", family: "fedora", kernel: "6.8", cores: "4", uptime: "1h" },
    findings: [{ title: "ssh from 10.0.0.5", detail: "saw 10.0.0.5", evidence: "log 10.0.0.5", fix: "reboot" }],
    history: [
      { at: "t1", score: 90, counts: { high: 1 } },
      { at: "t2", score: 85, counts: { high: 0 }, findings: [{ code: "x" }] },
    ],
  });
  assert.equal(b.findings[0].title, "ssh from <ip-redacted>");
  assert.equal(b.findings[0].evidence, "log <ip-redacted>");
  assert.equal(b.history.length, 2);
  // only score/counts carried over — not the historical findings
  assert.equal(b.history[0].findings, undefined);
});

test("buildSupportBundle: history tail is capped at BUNDLE_HISTORY_LIMIT", () => {
  const history = Array.from({ length: 20 }, (_, i) => ({ at: String(i), score: i }));
  const b = buildSupportBundle({ system: { distro: "d", family: "f", kernel: "k", cores: "1", uptime: "1h" }, history });
  assert.equal(b.history.length, BUNDLE_HISTORY_LIMIT);
  assert.equal(b.history[b.history.length - 1].at, "19");
});

test("writeSupportBundle: writes a valid JSON file atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-sup-"));
  try {
    const bundle = buildSupportBundle({ system: { distro: "d", family: "f", kernel: "k", cores: "1", uptime: "1h" } });
    const path = join(dir, "bundle.json");
    const written = writeSupportBundle(bundle, path);
    assert.equal(written, path);
    assert.equal(existsSync(path), true);
    assert.equal(existsSync(`${path}.tmp`), false, "no temp residue");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(parsed.kind, "support-bundle");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeSupportBundle: returns null when it cannot write", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-sup-"));
  const blocker = join(dir, "blocker");
  try {
    // A blocker *file* as the parent path forces ENOTDIR (matches history.js's
    // own unwritable-location test) so we exercise the null-return path.
    writeFileSync(blocker, "");
    const file = join(blocker, "bundle.json");
    assert.equal(writeSupportBundle({ kind: "support-bundle" }, file), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultBundlePath: timestamped name in the given dir", () => {
  const p = defaultBundlePath("/tmp/x");
  assert.ok(p.startsWith("/tmp/x/linux-doctor-support-"));
  assert.ok(p.endsWith(".json"));
});

test("supportMessage: tells the user what to do with the file", () => {
  const m = supportMessage("/tmp/b.json");
  assert.ok(m.includes("/tmp/b.json"));
  assert.ok(/forum|issue|support/i.test(m));
});

test("scrub: linear-time on colon runs (ReDoS regression)", () => {
  const input = "x".repeat(16) + ":".repeat(100_000) + " ";
  const t0 = performance.now();
  scrub(input);
  const ms = performance.now() - t0;
  assert.ok(ms < 500, `scrub() took ${Math.round(ms)}ms on a 100k colon run (must stay linear)`);
});

test("scrub: IPv6 forms redacted, times and code kept", () => {
  assert.equal(scrub("time 12:34:56"), "time 12:34:56");
  assert.equal(scrub("2026-09-10T12:34:56Z"), "2026-09-10T12:34:56Z");
  assert.equal(scrub("fe80::1"), "<ip-redacted>");
  assert.equal(scrub("2001:db8::1"), "<ip-redacted>");
  assert.equal(scrub("aa:bb:cc:dd:ee:ff"), "<ip-redacted>");
  assert.equal(scrub("::1"), "<ip-redacted>");
  assert.equal(scrub("192.168.1.1/24"), "<ip-redacted>");
  // Careful: the old pattern also redacted C++ scope chains.
  assert.equal(scrub("std::vector"), "std::vector");
  assert.equal(scrub("ports 443:8443"), "ports 443:8443");
});

test("scrubFinding/scrubDeep: every text field is redacted", () => {
  const f = scrubFinding({
    title: "t 10.0.0.1",
    detail: "d /home/alice/.config",
    evidence: "e fe80::1",
    fix: "f 192.168.0.1",
    code: "x/y",
  });
  const s = JSON.stringify(f);
  assert.ok(!s.includes("10.0.0.1") && !s.includes("/home/alice") && !s.includes("fe80::1") && !s.includes("192.168.0.1"));
  assert.equal(f.code, "x/y", "non-text fields are untouched");

  const deep = scrubDeep({ a: "1.2.3.4", nested: { b: ["/home/bob/x", "plain"] }, n: 5, keep: false });
  assert.equal(deep.a, "<ip-redacted>");
  assert.equal(deep.nested.b[0], "/home/<user-redacted>/x");
  assert.equal(deep.nested.b[1], "plain");
  assert.equal(deep.n, 5);
  assert.equal(deep.keep, false);
});

test("buildSupportBundle: unknown finding fields are scrubbed too", () => {
  const b = buildSupportBundle({
    findings: [
      { title: "t", detail: "d", evidence: "e", fix: "f", customField: "leak 192.168.9.9 /home/zoe/x", confidence: "high" },
    ],
  });
  const s = JSON.stringify(b);
  assert.ok(!s.includes("192.168.9.9"), "a plugin's extra field must not leak an IP");
  assert.ok(!s.includes("/home/zoe"), "a plugin's extra field must not leak a home path");
});

test("buildSupportBundle: never carries the hostname or a license key", () => {
  const b = buildSupportBundle({ system: { hostname: "secret-host", distro: "X", kernel: "6" }, findings: [] });
  const s = JSON.stringify(b);
  assert.ok(!s.includes("secret-host"), "hostname must be excluded");
  assert.ok(!s.toLowerCase().includes("licensekey"), "the config (license key) is never included");
});

// The patterns above can only see shapes (an IP, a home path). The two names
// the tool knows for certain — the hostname and the account name — leaked in
// free text: a unit name, a mount path outside /home, a log line. The bundle
// claims "no hostnames, usernames", so the claim has to be true.

test("redactionTargets: keeps real identities, drops generic ones", () => {
  assert.deepEqual(
    redactionTargets({ hostname: "my-laptop-7x", username: "alice", avoid: "Bazzite 45 fedora" }),
    { hosts: ["my-laptop-7x"], users: ["alice"] },
  );
  // Too short, or a word that would mangle ordinary prose.
  assert.deepEqual(redactionTargets({ hostname: "pi", username: "user", avoid: "" }), { hosts: [], users: [] });
});

test("redactionTargets: a hostname that is the distro name is not a secret", () => {
  // On stock Bazzite the hostname is literally "bazzite". Redacting it would
  // rewrite `distro: "Bazzite 45"` into nonsense while leaking nothing.
  assert.deepEqual(
    redactionTargets({ hostname: "bazzite", username: "alice", avoid: "Bazzite 45 fedora bazzite" }),
    { hosts: [], users: ["alice"] },
  );
});

test("scrub: the hostname and username are redacted wherever they appear", () => {
  const targets = redactionTargets({ hostname: "my-laptop-7x", username: "alice", avoid: "" });
  assert.equal(
    scrub("systemd[1]: my-laptop-7x.service failed", targets),
    "systemd[1]: <host-redacted>.service failed",
  );
  assert.equal(scrub("permission denied for /srv/alice/data", targets), "permission denied for /srv/<user-redacted>/data");
  // Case-insensitive, and absent targets leave text untouched (the GUI export
  // shares this function and has no os.hostname()).
  assert.equal(scrub("MY-LAPTOP-7X is up", targets), "<host-redacted> is up");
  assert.equal(scrub("systemd[1]: my-laptop-7x.service failed"), "systemd[1]: my-laptop-7x.service failed");
});

test("buildSupportBundle: system.hostname is redacted in finding text", () => {
  const b = buildSupportBundle({
    system: { distro: "Fedora 40", family: "fedora", hostname: "alice-desktop" },
    findings: [{ code: "services/failed", title: "alice-desktop unit failed", detail: "see alice-desktop", evidence: "alice-desktop", fix: null }],
  });
  assert.match(b.findings[0].title, /<host-redacted>/);
  assert.match(b.findings[0].detail, /<host-redacted>/);
  assert.match(b.findings[0].evidence, /<host-redacted>/);
});

test("buildSupportBundle: a hostname equal to the distro name leaves distro intact", () => {
  const b = buildSupportBundle({
    system: { distro: "Bazzite 45", family: "fedora", atomicVariant: "bazzite", hostname: "bazzite" },
    findings: [],
  });
  assert.equal(b.system.distro, "Bazzite 45");
  assert.equal(b.system.atomicVariant, "bazzite");
});
