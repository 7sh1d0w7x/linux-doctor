// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Linux-only release policy.
 *
 * The product ships Linux desktop bundles and nothing else. That is a product
 * decision, so it should fail the build when someone adds a macOS/Windows
 * runner or a non-Linux bundle format — not when a document merely mentions
 * Windows.
 *
 * This guard reads the two places that actually decide what gets built:
 *   - src-tauri/tauri.conf.json  → bundle.targets
 *   - .github/workflows/release.yml → every runs-on and every --target
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const LINUX_BUNDLES = new Set(["deb", "rpm", "appimage"]);
const LINUX_RUNNER = /^ubuntu-/;
const LINUX_TRIPLE = /-linux-gnu/;

test("release bundles are Linux formats only", () => {
  const conf = JSON.parse(readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
  const targets = conf?.bundle?.targets;
  assert.ok(Array.isArray(targets) && targets.length > 0, "bundle.targets must list the shipped formats");
  for (const t of targets) {
    assert.ok(LINUX_BUNDLES.has(t), `unsupported bundle target "${t}" — shipped formats are ${[...LINUX_BUNDLES].join(", ")}`);
  }
  assert.equal(conf?.bundle?.active, true, "bundle.active must stay true, or no desktop artifact is produced");
});

test("every release job runs on Linux", () => {
  const wf = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const runners = [...wf.matchAll(/runs-on:\s*([^\s#]+)/g)].map((m) => m[1].replace(/["']/g, ""));
  assert.ok(runners.length > 0, "release.yml should define at least one runner");
  for (const r of runners) {
    assert.match(r, LINUX_RUNNER, `release job runs on "${r}" — only Linux runners are supported`);
  }
});

test("no release step cross-compiles to a non-Linux target", () => {
  const wf = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const targets = [...wf.matchAll(/--target[=\s]+([^\s"']+)/g)].map((m) => m[1]);
  for (const t of targets) {
    assert.match(t, LINUX_TRIPLE, `release builds --target ${t} — only Linux triples are supported`);
  }
});
