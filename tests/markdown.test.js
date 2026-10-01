// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { renderMarkdown } from "../src/markdown.js";
import { parseArgs } from "../src/args.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "bin", "doctor.js");

const finding = (over = {}) => ({
  check: "memory",
  code: "memory/swap",
  severity: "medium",
  title: "Swap is nearly full",
  detail: "Swap is at 98% capacity.",
  evidence: "free -m",
  fix: "Close unused apps, then re-run this check.",
  ...over,
});

const meta = (over = {}) => ({
  system: { distro: "Bazzite 44", kernel: "6.1.0", cores: 16, uptime: "2h" },
  score: 74,
  scoreDelta: 3,
  scoreBreakdown: [{ code: "memory/swap", penalty: 8 }],
  newCount: 1,
  fixedCount: 0,
  unchanged: 18,
  checksRun: 44,
  checksSkipped: 0,
  checksAtomicSkipped: 2,
  checkErrors: [],
  skippedChecks: [{ id: "battery", reason: "no battery on a desktop" }],
  ...over,
});

test("renderMarkdown: full structure — header, since-last-run, severity sections, footer", () => {
  const md = renderMarkdown([finding()], meta());
  assert.match(md, /^# Linux Doctor report/m);
  assert.match(md, /\*\*System:\*\* Bazzite 44 · kernel 6\.1\.0 · 16 core\(s\) · up 2h/m);
  assert.match(md, /\*\*Health score:\*\* 74\/100 \(\+3\) · 0 high, 1 medium, 0 info/m);
  assert.match(md, /- −8 memory\/swap/m, "score breakdown travels as bullet list");
  assert.match(md, /## Since last run/m);
  assert.match(md, /1 new · 18 unchanged/m, "zero counts are omitted like in the terminal report");
  assert.match(md, /## Medium severity/m);
  assert.match(md, /1\. \*\*Swap is nearly full\*\* `memory\/swap`/m);
  assert.match(md, /\*How to fix:\* Close unused apps/m);
  assert.match(md, /## Skipped \(not applicable on this system\)/m);
  assert.match(md, /\*\*battery\*\* — no battery on a desktop/m);
  assert.match(md, /IPs and home paths are redacted/m, "the footer promises the redaction");
  assert.match(md, /Linux Doctor\]\(https:\/\/github\.com\/7sh1d0w7x\/linux-doctor\) v/m);
});

test("renderMarkdown: START HERE points at the first finding that has a fix", () => {
  const md = renderMarkdown([
    finding({ title: "No fix attached", fix: "" }),
    finding({ title: "Firewall off", severity: "high", code: "security/no-firewall", fix: "Run `sudo ufw enable`." }),
  ], meta());
  // High severity renders first, so the fixable firewall finding is #1.
  assert.match(md, /▶ START HERE → finding 1 \(Firewall off\)/m);
  assert.match(md, /## High severity/, "high section exists");
});

test("renderMarkdown: every text field is scrubbed — IPs, home paths, UIDs", () => {
  const md = renderMarkdown([
    finding({
      title: "NTP server 192.168.1.55 unreachable",
      detail: "Cannot reach /home/alice/.config/ntp.conf via 10.0.0.7",
      evidence: "ping 192.168.1.55 && ls /run/user/1000",
      fix: "Edit /home/alice/.config/ntp.conf and retry ::1",
    }),
  ], meta({ system: { distro: "Fedora 44 (user bob)", kernel: "6.1.0", cores: 8, uptime: "1h" } }));
  assert.doesNotMatch(md, /192\.168\.1\.55/);
  assert.doesNotMatch(md, /10\.0\.0\.7/);
  assert.doesNotMatch(md, /::1\b/);
  assert.doesNotMatch(md, /\/home\/alice/);
  assert.doesNotMatch(md, /\/run\/user\/1000/);
  assert.match(md, /<ip-redacted>/);
  assert.match(md, /\/home\/<user-redacted>/);
  assert.match(md, /\/run\/user\/<uid-redacted>/);
});

test("renderMarkdown: evidence becomes a fenced block, line-prefixed", () => {
  const md = renderMarkdown([finding({ evidence: "free -m\nswapon --show" })], meta());
  assert.match(md, /```text\n   \$ free -m\n   \$ swapon --show\n   ```/m);
});

test("renderMarkdown: clean run reads clean, with no empty sections", () => {
  const md = renderMarkdown([], meta({ newCount: 0, unchanged: 0, skippedChecks: [] }));
  assert.doesNotMatch(md, /## Since last run/);
  assert.match(md, /## Findings\n\nNothing found/m);
  assert.doesNotMatch(md, /START HERE/, "nothing to start with on a clean run");
});

test("renderMarkdown: historyDisabled is stated honestly", () => {
  const md = renderMarkdown([finding()], meta({ historyDisabled: true }));
  assert.match(md, /History tracking was off for this run \(--no-history\)/m);
});

test("parseArgs: --md requires and captures a path", () => {
  const out = parseArgs(["node", "bin/doctor.js", "--md", "report.md"]);
  assert.equal(out.mdPath, "report.md");
  assert.match(parseArgs(["node", "bin/doctor.js", "--md"]).error, /--md requires a value/);
});

test("cli --md writes a scrubbed file and exits 0/1 like the report", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-md-"));
  const file = join(dir, "report.md");
  try {
    const res = spawnSync(process.execPath, [bin, "--check", "memory", "--md", file, "--no-history"], {
      encoding: "utf8",
      timeout: 120000,
    });
    assert.ok(res.status === 0 || res.status === 1, `exit ${res.status}: ${res.stderr}`);
    const md = readFileSync(file, "utf8");
    assert.match(md, /^# Linux Doctor report/m);
    assert.match(res.stdout, /Report saved to /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
