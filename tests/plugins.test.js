// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugins, loadPluginEntries, pluginDir } from "../src/plugins.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ld-plugins-"));
}

test("loadPlugins: missing directory returns an empty list", async () => {
  assert.deepEqual(await loadPlugins("/nonexistent/plugins"), []);
});

test("loadPlugins: loads every valid plugin file (default or named export)", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "ups.js"), "export default { id: 'ups', title: 'UPS', async run() { return []; } };\n");
    writeFileSync(join(dir, "vpn.js"), "export const vpn = { id: 'vpn', title: 'VPN', async run() { return []; } };\n");
    const checks = await loadPlugins(dir);
    assert.deepEqual(checks.map((c) => c.id).sort(), ["ups", "vpn"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPlugins: a broken plugin is skipped with a warning, others load", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "bad.js"), "throw new Error('boom');\n");
    writeFileSync(join(dir, "good.js"), "export default { id: 'good', title: 'Good', async run() { return []; } };\n");
    const errs = [];
    const origError = console.error;
    console.error = (msg) => errs.push(msg);
    try {
      const checks = await loadPlugins(dir);
      assert.deepEqual(checks.map((c) => c.id), ["good"]);
    } finally {
      console.error = origError;
    }
    assert.ok(errs.some((e) => /bad\.js/.test(e)), "a warning was printed for the broken plugin");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPlugins: a file without { id, run } is skipped", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "nope.js"), "export default { notACheck: true };\n");
    const errs = [];
    const origError = console.error;
    console.error = (msg) => errs.push(msg);
    try {
      const checks = await loadPlugins(dir);
      assert.deepEqual(checks, []);
    } finally {
      console.error = origError;
    }
    assert.ok(errs.some((e) => /does not export/.test(e)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPluginEntries: keeps the absolute source file for every plugin", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "ups.js"), "export default { id: 'ups', title: 'UPS', async run() { return []; } };\n");
    writeFileSync(join(dir, "bad.js"), "throw new Error('boom');\n");
    const entries = await loadPluginEntries(dir);
    const ok = entries.find((e) => e.kind === "ok");
    assert.equal(ok.check.id, "ups");
    assert.equal(ok.name, "ups.js");
    assert.equal(ok.file, join(dir, "ups.js"));
    assert.ok(ok.file.startsWith("/"), "the reported path is absolute");
    const bad = entries.find((e) => e.name === "bad.js");
    assert.equal(bad.kind, "error");
    assert.equal(bad.file, join(dir, "bad.js"));
    assert.match(bad.warning, /could not load plugin bad\.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPluginEntries: missing directory returns no entries", async () => {
  assert.deepEqual(await loadPluginEntries("/nonexistent/plugins"), []);
});

test("pluginDir: honors LINUX_DOCTOR_PLUGINS override", () => {
  process.env.LINUX_DOCTOR_PLUGINS = "/tmp/ld-custom-plugins";
  try {
    assert.equal(pluginDir(), "/tmp/ld-custom-plugins");
  } finally {
    delete process.env.LINUX_DOCTOR_PLUGINS;
  }
});
