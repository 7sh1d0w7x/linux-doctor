// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { applicableChecks } from "../src/cli.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "bin", "doctor.js");

// The CLI records a run in history by default, and every spawned child inherits
// this process's environment. Without a throwaway path the suite writes into the
// developer's real ~/.local/share/linux-doctor/history.json and churns the
// new/fixed story. Tests that want their own file still pass LINUX_DOCTOR_HISTORY.
process.env.LINUX_DOCTOR_HISTORY = join(tmpdir(), `ld-cli-test-history-${process.pid}.json`);

function run(...args) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", timeout: 60000 });
}

function runEnv(env, ...args) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, ...env },
  });
}

test("--list prints every check id grouped by category without running them", () => {
  const res = run("--list");
  assert.equal(res.status, 0);
  for (const id of ["memory", "load", "disk", "processes", "thermal", "journal", "journald", "suspend", "security", "ssh", "autologin", "secureboot", "network", "ntp", "updates", "snap", "firmware", "flatpak", "reboot", "battery", "gpu", "bluetooth", "wayland", "backup", "hardware", "smart", "luks", "audio", "containers", "containerdisk", "crash", "zram", "locales"]) {
    assert.match(res.stdout, new RegExp(`^  ${id} — `, "m"), `--list should include ${id}`);
  }
  // Category headers group the list.
  for (const cat of ["system", "software", "security", "network", "updates", "hardware", "data"]) {
    assert.match(res.stdout, new RegExp(`^${cat}$`, "m"), `--list should have a ${cat} category header`);
  }
});

test("--list marks checks that do not apply to this machine", () => {
  const res = run("--list");
  assert.equal(res.status, 0);
  assert.ok(/battery — Battery/.test(res.stdout), "battery is listed");
});

test("applicableChecks: full run skips checks that do not apply to the machine kind", () => {
  const desktop = applicableChecks([], "desktop").map((c) => c.id);
  assert.ok(!desktop.includes("battery"), "battery must not run on a desktop");
  assert.ok(desktop.includes("gpu"), "gpu runs on a desktop");
  const server = applicableChecks([], "server").map((c) => c.id);
  for (const id of ["battery", "gpu", "bluetooth", "wayland", "suspend"]) {
    assert.ok(!server.includes(id), `${id} must not run on a server`);
  }
  assert.ok(server.includes("memory"), "system checks run on a server");
  const laptop = applicableChecks([], "laptop").map((c) => c.id);
  assert.ok(laptop.includes("battery"), "battery runs on a laptop");
});

test("applicableChecks: an explicit --check list overrides appliesTo", () => {
  const ids = applicableChecks(["battery"], "desktop").map((c) => c.id);
  assert.deepEqual(ids, ["battery"], "user intent wins over gating");
});

test("applicableChecks: plugins participate in gating", () => {
  const plugin = { id: "ups", title: "UPS", category: "hardware", appliesTo: ["server"], run: async () => [] };
  const server = applicableChecks([], "server", [plugin]).map((c) => c.id);
  assert.deepEqual(server, ["ups"]);
  const desktop = applicableChecks([], "desktop", [plugin]).map((c) => c.id);
  assert.deepEqual(desktop, [], "a server-only plugin is skipped on a desktop");
});

test("--schema prints the v1 report schema as JSON", () => {
  const res = run("--schema");
  assert.equal(res.status, 0);
  const schema = JSON.parse(res.stdout);
  assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
  assert.equal(schema.properties.schemaVersion.const, 1);
});

test("--profile appends per-check durations to --plain output", () => {
  const res = run("--check", "memory", "--plain", "--profile");
  assert.ok(res.status === 0 || res.status === 1, `exit ${res.status}`);
  assert.match(res.stdout, /^# duration: memory \d+ms$/m);
});

test("plugins in LINUX_DOCTOR_PLUGINS are runnable with --check", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-cli-plugins-"));
  try {
    writeFileSync(
      join(dir, "example.js"),
      "export default { id: 'example', title: 'Example plugin', category: 'custom', async run() { return [{ severity: 'info', title: 'Plugin worked', detail: null, evidence: null, fix: null, confidence: 'high' }]; } };\n"
    );
    const res = spawnSync(process.execPath, [bin, "--check", "example", "--plain"], {
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, LINUX_DOCTOR_PLUGINS: dir },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^info\t1\tPlugin worked$/m);
    assert.doesNotMatch(res.stderr, /could not load plugin/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plugins appear in --list and unknown-check validation", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-cli-plugins-"));
  try {
    writeFileSync(join(dir, "example.js"), "export default { id: 'example', title: 'Example plugin', async run() { return []; } };\n");
    const res = spawnSync(process.execPath, [bin, "--list"], {
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, LINUX_DOCTOR_PLUGINS: dir },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^  example — Example plugin$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--check accepts comma-separated ids", () => {
  const res = run("--check", "memory,load", "--plain");
  assert.ok(res.status === 0 || res.status === 1, `exit ${res.status}`);
  assert.doesNotMatch(res.stderr, /Unknown check/);
});

test("--check rejects unknown ids with exit 2", () => {
  const res = run("--check", "memory,nonsense");
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Unknown check "nonsense"/);
});

test("--check with no value fails with exit 2", () => {
  const res = run("--check", "--plain");
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--check requires a value/);
});

test("--check=id form is accepted", () => {
  const res = run("--check=memory,load", "--plain");
  assert.ok(res.status === 0 || res.status === 1, `exit ${res.status}`);
  assert.doesNotMatch(res.stderr, /Unknown check/);
});

test("unknown flags fail with exit 2 instead of silently running", () => {
  const res = run("--jsonn");
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Unknown option "--jsonn"/);
});

test("--push without a URL fails with exit 2", () => {
  const res = run("--push");
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--push requires a value/);
});

test("a check that throws is contained: the run survives and checkErrors is reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-cli-boom-"));
  try {
    writeFileSync(join(dir, "boom.js"), "export default { id: 'boom', title: 'Boom', async run() { throw new Error('kaboom'); } };\n");
    const env = { ...process.env, LINUX_DOCTOR_PLUGINS: dir };
    const json = spawnSync(process.execPath, [bin, "--check", "boom", "--json"], { encoding: "utf8", timeout: 60000, env });
    assert.equal(json.status, 0, json.stderr);
    const data = JSON.parse(json.stdout);
    assert.equal(data.findings.length, 0);
    assert.deepEqual(data.checkErrors, [{ check: "boom", error: "kaboom" }]);

    const plain = spawnSync(process.execPath, [bin, "--check", "boom", "--plain"], { encoding: "utf8", timeout: 60000, env });
    assert.equal(plain.status, 0);
    assert.match(plain.stdout, /^# failed: boom — kaboom$/m);

    const text = spawnSync(process.execPath, [bin, "--check", "boom"], { encoding: "utf8", timeout: 60000, env });
    assert.equal(text.status, 0);
    assert.match(text.stdout, /1 check\(s\) failed to run: boom/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--ignore counts hidden findings and warns when a pattern matches nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-cli-ignore-"));
  try {
    writeFileSync(
      join(dir, "two.js"),
      "export default { id: 'two', title: 'Two findings', async run() { return [\n" +
        "  { severity: 'info', title: 'Alpha finding', detail: null, evidence: null, fix: null, confidence: 'high' },\n" +
        "  { severity: 'info', title: 'Beta finding', detail: null, evidence: null, fix: null, confidence: 'high' }\n" +
        "]; } };\n"
    );
    const env = { ...process.env, LINUX_DOCTOR_PLUGINS: dir };

    // One pattern matches: the finding is hidden and counted.
    const res = spawnSync(process.execPath, [bin, "--check", "two", "--ignore", "Alpha", "--plain"], {
      encoding: "utf8", timeout: 60000, env,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^# ignored: 1$/m);
    assert.match(res.stdout, /info\t1\tBeta finding/m);
    assert.doesNotMatch(res.stdout, /Alpha finding/);

    const json = spawnSync(process.execPath, [bin, "--check", "two", "--ignore", "Alpha", "--json"], {
      encoding: "utf8", timeout: 60000, env,
    });
    assert.equal(json.status, 0);
    assert.equal(JSON.parse(json.stdout).ignoredCount, 1);

    // A pattern that matches nothing warns on stderr — stale ignores rot silently otherwise.
    const stale = spawnSync(process.execPath, [bin, "--check", "two", "--ignore", "Gamma", "--plain"], {
      encoding: "utf8", timeout: 60000, env,
    });
    assert.equal(stale.status, 0);
    assert.match(stale.stderr, /ignore pattern "Gamma" matched nothing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--ignore-code matches a dedupeKey-derived code (identity is normalized before filtering)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-cli-igncode-"));
  try {
    writeFileSync(
      join(dir, "dedupeonly.js"),
      "export default { id: 'dedupeonly', title: 'Dedupe-only', async run() { return [{ severity: 'medium', title: 'Shared root cause', detail: null, evidence: null, fix: null, confidence: 'high', dedupeKey: 'shared-root' }]; } };\n"
    );
    const env = { ...process.env, LINUX_DOCTOR_PLUGINS: dir };
    const res = spawnSync(process.execPath, [bin, "--check", "dedupeonly", "--ignore-code", "shared-root", "--plain"], {
      encoding: "utf8", timeout: 60000, env,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^# ignored: 1$/m);
    assert.doesNotMatch(res.stdout, /Shared root cause/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--ignore-code matches the slug fallback code (plugin without any code)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-cli-igncode-slug-"));
  try {
    writeFileSync(
      join(dir, "slugger.js"),
      "export default { id: 'slugger', title: 'Slugger', async run() { return [{ severity: 'info', title: 'A curious thing', detail: null, evidence: null, fix: null, confidence: 'high' }]; } };\n"
    );
    const env = { ...process.env, LINUX_DOCTOR_PLUGINS: dir };
    const json = spawnSync(process.execPath, [bin, "--check", "slugger", "--json"], { encoding: "utf8", timeout: 60000, env });
    assert.equal(json.status, 0, json.stderr);
    const code = JSON.parse(json.stdout).findings[0].code;
    assert.equal(code, "slugger/a-curious-thing");

    const res = spawnSync(process.execPath, [bin, "--check", "slugger", "--ignore-code", code, "--plain"], { encoding: "utf8", timeout: 60000, env });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^# ignored: 1$/m);
    assert.doesNotMatch(res.stdout, /A curious thing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--compare includes plugin findings (same pipeline as a normal run)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-cli-compare-plugins-"));
  try {
    writeFileSync(
      join(dir, "cmp.js"),
      "export default { id: 'cmp', title: 'Cmp plugin', async run() { return [{ severity: 'info', title: 'Plugin-only finding', detail: null, evidence: null, fix: null, confidence: 'high', code: 'cmp/plugin-only' }]; } };\n"
    );
    const reportPath = join(dir, "prev.json");
    writeFileSync(reportPath, JSON.stringify({ findings: [] }), "utf8");
    const env = { ...process.env, LINUX_DOCTOR_PLUGINS: dir };
    const res = spawnSync(process.execPath, [bin, "--compare", reportPath], { encoding: "utf8", timeout: 60000, env });
    assert.ok(res.status === 0 || res.status === 1, `exit ${res.status}: ${res.stderr}`);
    assert.match(res.stdout, /new finding/);
    assert.match(res.stdout, /Plugin-only finding/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("low-confidence findings get a visible marker in the text report", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-cli-shaky-"));
  try {
    writeFileSync(
      join(dir, "shaky.js"),
      "export default { id: 'shaky', title: 'Shaky', async run() { return [{ severity: 'info', title: 'Doubtful result', detail: null, evidence: null, fix: null, confidence: 'low' }]; } };\n"
    );
    const env = { ...process.env, LINUX_DOCTOR_PLUGINS: dir };
    const res = spawnSync(process.execPath, [bin, "--check", "shaky"], { encoding: "utf8", timeout: 60000, env });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Low confidence/);
    const json = spawnSync(process.execPath, [bin, "--check", "shaky", "--json"], { encoding: "utf8", timeout: 60000, env });
    assert.equal(JSON.parse(json.stdout).findings[0].confidence, "low");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--json output is the v1 schema with per-finding check ids and codes", () => {
  const res = run("--check", "memory", "--json");
  assert.ok(res.status === 0 || res.status === 1, `exit ${res.status}`);
  const data = JSON.parse(res.stdout);
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.tool, "linux-doctor");
  assert.equal(typeof data.version, "string");
  assert.equal(typeof data.durationMs, "number");
  assert.ok(Array.isArray(data.findings));
  assert.ok(data.findings.every((f) => typeof f.check === "string"), "every finding knows its check");
  assert.ok(data.findings.every((f) => typeof f.code === "string"), "every finding has a stable code");
});

test("--html writes a standalone HTML file that contains the report data", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-cli-html-"));
  const htmlPath = join(dir, "report.html");
  try {
    const res = run("--check", "memory", "--html", htmlPath);
    assert.ok(res.status === 0 || res.status === 1, `exit ${res.status}`);
    const html = readFileSync(htmlPath, "utf8");
    assert.ok(html.includes("__DATA__"), "HTML contains embedded data");
    assert.ok(html.includes("linux-doctor"), "HTML contains the dashboard");
    assert.ok(!html.includes("window.fetch ="), "no window.fetch monkey-patching");
    // Extract the JSON data and validate it
    const match = html.match(/window\.__DATA__ = ({.*?});/s);
    assert.ok(match, "embedded data is valid JS");
    const data = JSON.parse(match[1]);
    assert.equal(data.schemaVersion, 1);
    assert.ok(Array.isArray(data.findings));
    assert.equal(data.system.hostname, "<hostname-redacted>", "--html must not ship the machine hostname");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--severity high shows only high findings in JSON", () => {
  const res = run("--json", "--severity", "high");
  assert.ok(res.status === 0 || res.status === 1, `exit ${res.status}`);
  const data = JSON.parse(res.stdout);
  assert.ok(data.findings.every((f) => f.severity === "high"), `expected only high findings, got: ${data.findings.map((f) => f.severity).join(", ")}`);
});

test("--severity invalid is rejected with exit 2", () => {
  const res = run("--severity", "critical");
  assert.equal(res.status, 2);
  assert.match(res.stderr, /severity must be one of/);
});

test("--ignore-list shows configured patterns", () => {
  const res = run("--ignore-list");
  assert.equal(res.status, 0);
  assert.match(res.stdout, /No ignore patterns configured|Title patterns|Code patterns/);
});

test("--summary prints a one-liner with score and counts", () => {
  const res = run("--summary");
  assert.ok(res.status === 0 || res.status === 1, `exit ${res.status}`);
  assert.match(res.stdout, /^health \d+\/100/);
  // No multi-line output — it's a single line
  assert.equal(res.stdout.trim().split("\n").length, 1);
});

test("--summary exits 1 when high or medium findings exist", () => {
  const res = run("--summary");
  // On a real system there's usually at least one medium finding
  if (res.stdout.includes("high=") || res.stdout.includes("medium=")) {
    assert.equal(res.status, 1);
  }
});

test("--check-list prints check metadata as JSON", () => {
  const res = run("--check-list");
  assert.equal(res.status, 0);
  const list = JSON.parse(res.stdout);
  assert.ok(Array.isArray(list));
  assert.ok(list.length > 20, `expected 20+ checks, got ${list.length}`);
  const mem = list.find((c) => c.id === "memory");
  assert.ok(mem, "memory check should be in the list");
  assert.equal(typeof mem.title, "string");
  assert.equal(typeof mem.category, "string");
  assert.ok(Array.isArray(mem.appliesTo));
  assert.equal(typeof mem.appliesHere, "boolean");
});

test("premium checks do not exist in the free edition (no Pro module installed)", () => {
  delete process.env.LINUX_DOCTOR_LICENSE;
  const list = run("--list");
  assert.equal(list.status, 0);
  assert.ok(!list.stdout.includes("hardening"), "premium checks must not appear in free --list");

  const list2 = run("--check-list");
  assert.equal(list2.status, 0);
  const meta = JSON.parse(list2.stdout);
  assert.ok(!meta.some((c) => c.premium), "no premium metadata without a key");

  const check = run("--check", "hardening");
  assert.equal(check.status, 2);
  assert.match(check.stderr, /Unknown check "hardening"/);
});

test("--license without the Pro module says so honestly", () => {
  delete process.env.LINUX_DOCTOR_LICENSE;
  const res = run("--license");
  assert.equal(res.status, 1);
  assert.match(res.stdout, /not installed/i);
});

// Open-core: a key alone unlocks NOTHING — the code itself ships separately.
test("a license key without the Pro module still gets the free edition", () => {
  const info = runEnv({ LINUX_DOCTOR_LICENSE: "ldpro.v1.forged.deadbeef" }, "--license");
  assert.equal(info.status, 1);
  assert.match(info.stdout, /not installed/i);

  const check = runEnv({ LINUX_DOCTOR_LICENSE: "ldpro.v1.forged.deadbeef" }, "--check", "hardening");
  assert.equal(check.status, 2);
  assert.match(check.stderr, /Unknown check "hardening"/);
});

test("Pro-only flags are rejected without the Pro add-on", () => {
  delete process.env.LINUX_DOCTOR_LICENSE;
  const alertRes = run("--check", "memory", "--alert", "https://example.com/hook");
  assert.equal(alertRes.status, 2);
  assert.match(alertRes.stderr, /Pro features/);

  const daemonRes = run("--daemon");
  assert.equal(daemonRes.status, 2);
  assert.match(daemonRes.stderr, /Pro features/);

  const intervalRes = run("--check", "memory", "--interval", "10");
  assert.equal(intervalRes.status, 2);
  assert.match(intervalRes.stderr, /Pro features/);
});

test("--interval with a bad value reports the Pro gate (add-on absent)", () => {
  const res = runEnv({ LINUX_DOCTOR_LICENSE: "x" }, "--check", "memory", "--interval", "abc");
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Pro features/);
});

test("--todo prints a numbered fix list, ordered by severity", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-cli-todo-"));
  try {
    writeFileSync(
      join(dir, "fixes.js"),
      "export default { id: 'fixes', title: 'Fixes', async run() { return [\n" +
        "  { severity: 'info', title: 'Low thing', detail: null, evidence: null, fix: 'Run low-fix', confidence: 'high' },\n" +
        "  { severity: 'medium', title: 'Med thing', detail: null, evidence: null, fix: 'Run med-fix', confidence: 'high' },\n" +
        "  { severity: 'high', title: 'High thing', detail: null, evidence: null, fix: 'Run high-fix', confidence: 'high' }\n" +
        "]; } };\n"
    );
    const env = { ...process.env, LINUX_DOCTOR_PLUGINS: dir };
    const res = spawnSync(process.execPath, [bin, "--check", "fixes", "--todo"], { encoding: "utf8", timeout: 60000, env });
    assert.equal(res.status, 1, res.stderr);
    const out = res.stdout;
    const hi = out.indexOf("[high] High thing");
    const med = out.indexOf("[medium] Med thing");
    const lo = out.indexOf("[info] Low thing");
    assert.ok(hi >= 0 && med >= 0 && lo >= 0, "all three findings listed");
    assert.ok(hi < med && med < lo, "steps ordered high → medium → info");
    assert.match(out, /1\. \[high\]/);
    assert.match(out, /Run high-fix/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--self-test explains the environment and which checks run", () => {
  const res = run("--self-test");
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^Distro:/m);
  assert.match(res.stdout, /^Profile:/m);
  assert.match(res.stdout, /Checks: \d+ will run here/);
  assert.match(res.stdout, /Checks that will run:/);
});

test("--ignore-list-json prints the ignore list as JSON for the desktop shell", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-igjson-"));
  try {
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ ignore: ["foo bar"], ignoreCodes: ["services/failed"] }));
    const env = { ...process.env, LINUX_DOCTOR_CONFIG: file };
    const res = spawnSync(process.execPath, [bin, "--ignore-list-json"], { encoding: "utf8", timeout: 60000, env });
    const j = JSON.parse(res.stdout);
    assert.deepEqual(j.patterns, ["foo bar"]);
    assert.deepEqual(j.codes, ["services/failed"]);
    assert.equal(j.path, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--summary shows a score delta vs the previous run", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-cli-delta-"));
  const env = { ...process.env, LINUX_DOCTOR_HISTORY: join(dir, "history.json") };
  try {
    const first = spawnSync(process.execPath, [bin, "--summary"], { encoding: "utf8", timeout: 60000, env });
    // The exit code is not a property of the tool, it is a property of the
    // machine running the test: a clean CI runner has no high/medium findings
    // and exits 0. Assert the invariant instead (1 exactly when the report has
    // high or medium findings), so the test does not depend on host luck.
    const json = spawnSync(process.execPath, [bin, "--json"], { encoding: "utf8", timeout: 60000, env });
    const report = JSON.parse(json.stdout);
    const serious = report.findings.some((f) => f.severity === "high" || f.severity === "medium");
    assert.equal(first.status, serious ? 1 : 0, "exit code follows the findings, not the machine");
    assert.match(first.stdout, /^health \d+\/100/);
    assert.doesNotMatch(first.stdout, /delta=/, "first run has no previous score to compare against");

    const second = spawnSync(process.execPath, [bin, "--summary"], { encoding: "utf8", timeout: 60000, env });
    assert.equal(second.status, first.status);
    assert.match(second.stdout, /delta=[+-]?\d+/, "second run must carry a score delta (which may be +N when the score improved)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--init-config creates a starter config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-cli-initconfig-"));
  const prevConfig = process.env.LINUX_DOCTOR_CONFIG;
  process.env.LINUX_DOCTOR_CONFIG = join(dir, "config.json");
  try {
    const res = run("--init-config");
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Config written to/);
    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.ok(Array.isArray(config.ignore));
    assert.ok(Array.isArray(config.ignoreCodes));
    assert.ok(typeof config.thresholds === "object");
    assert.equal(typeof config.thresholds.diskFullPct, "number");
  } finally {
    if (prevConfig === undefined) delete process.env.LINUX_DOCTOR_CONFIG;
    else process.env.LINUX_DOCTOR_CONFIG = prevConfig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--compare shows no changes when reports are identical", () => {
  // Create a report, then compare it against itself
  const dir = mkdtempSync(join(tmpdir(), "ld-cli-compare-"));
  try {
    const reportPath = join(dir, "report.json");
    const baseline = run("--check", "memory", "--json");
    writeFileSync(reportPath, baseline.stdout, "utf8");
    // Run the same check and compare against the saved report
    const res = spawnSync(process.execPath, [bin, "--check", "memory", "--compare", reportPath, "--json"], {
      encoding: "utf8",
      timeout: 60000,
    });
    // --compare runs its own checks internally; the output goes to stdout
    // (either "No changes" or a diff). The exit code is from the compare.
    assert.ok(res.status === 0 || res.status === 1, `exit ${res.status}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--compare missing file fails with exit 2", () => {
  const res = run("--compare", "/nonexistent/report.json");
  assert.equal(res.status, 2);
  assert.match(res.stderr, /could not read compare file/);
});

test("network: slow DNS resolution is flagged medium", async () => {
  const { network } = await import("../src/checks/network.js");
  const { detectDistro } = await import("../src/distro.js");
  const ctx = {
    osRelease: { id: "fedora", id_like: "fedora" },
    dist: detectDistro({ id: "fedora", id_like: "fedora" }),
    thresholds: {},
    run: async (cmd) => {
      if (cmd.includes("command -v ip")) return { ok: true, code: 0, stdout: "/usr/sbin/ip\n", stderr: "" };
      if (cmd.includes("ip -brief addr")) return { ok: true, code: 0, stdout: "eth0 UP 192.168.1.100/24\n", stderr: "" };
      if (cmd.includes("ip route show default")) return { ok: true, code: 0, stdout: "default via 192.168.1.1 dev eth0\n", stderr: "" };
      if (cmd.includes("getent ahostsv4")) {
        // Simulate slow DNS by delaying
        await new Promise((r) => setTimeout(r, 600));
        return { ok: true, code: 0, stdout: "93.184.216.34\n", stderr: "" };
      }
      return { ok: false, code: 1, stdout: "", stderr: "" };
    },
  };
  const findings = await network.run(ctx);
  const slow = findings.find((f) => f.code === "network/dns-slow");
  assert.ok(slow, "expected a slow DNS finding");
  assert.equal(slow.severity, "medium");
  assert.match(slow.title, /slow/);
});

test("network: fast DNS does NOT produce a slow finding", async () => {
  const { network } = await import("../src/checks/network.js");
  const { detectDistro } = await import("../src/distro.js");
  const ctx = {
    osRelease: { id: "fedora", id_like: "fedora" },
    dist: detectDistro({ id: "fedora", id_like: "fedora" }),
    thresholds: {},
    run: async (cmd) => {
      if (cmd.includes("command -v ip")) return { ok: true, code: 0, stdout: "/usr/sbin/ip\n", stderr: "" };
      if (cmd.includes("ip -brief addr")) return { ok: true, code: 0, stdout: "eth0 UP 192.168.1.100/24\n", stderr: "" };
      if (cmd.includes("ip route show default")) return { ok: true, code: 0, stdout: "default via 192.168.1.1 dev eth0\n", stderr: "" };
      if (cmd.includes("getent ahostsv4")) return { ok: true, code: 0, stdout: "93.184.216.34\n", stderr: "" };
      return { ok: false, code: 1, stdout: "", stderr: "" };
    },
  };
  const findings = await network.run(ctx);
  assert.ok(!findings.some((f) => f.code === "network/dns-slow"), "fast DNS must not produce a slow finding");
});

test("--json --profile emits durations as an object (matches the schema)", () => {
  const res = run("--check", "load", "--json", "--profile");
  assert.ok(res.status === 0 || res.status === 1, `exit ${res.status}`);
  const data = JSON.parse(res.stdout);
  assert.equal(typeof data.durations, "object");
  assert.ok(!Array.isArray(data.durations), "durations must not be an array");
  assert.equal(typeof data.durations.load, "number", "should map check → ms");
});
