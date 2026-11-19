// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Recorded machine fixtures.
 *
 * A fixture is a real machine's command outputs (captured with
 * LINUX_DOCTOR_RECORD, see CONTRIBUTING.md) replayed through the real pipeline.
 * The clean-image gate in CI covers bare containers; these cover the desktops
 * and laptops those images cannot represent — the case where a check fires
 * because of what a real system printed, not because of what we assumed.
 *
 * A fixture is a promise about behaviour, so it fails on:
 *   - a hardware-fault code appearing (scripts/baseline-lib.mjs NEVER_ON_CLEAN);
 *   - a high/medium finding with no justification in `expected`;
 *   - an expectation that still carries a TODO reason.
 * Host-dependent codes (memory/load/updates) are tolerated, same list as the gate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { collectReport } from "../src/cli.js";
import { checks as CHECKS } from "../src/checks/index.js";
import { loadThresholds } from "../src/thresholds.js";
import { cassetteRun } from "../src/record.js";
import { compareFindings } from "../scripts/baseline-lib.mjs";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadFixture(file) {
  const raw = readFileSync(join(DIR, file));
  const text = file.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  return JSON.parse(text);
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".json") || f.endsWith(".json.gz"));

assert.ok(files.length > 0, "expected at least one recorded fixture in tests/fixtures/");

for (const file of files) {
  test(`fixture: ${file} replays to the same findings`, async () => {
    const fixture = loadFixture(file);
    assert.equal(fixture.kind, "linux-doctor-fixture", `${file} is not a fixture`);

    // Replay through the real pipeline: applicability, atomic skips, ignore
    // rules and dedupe all run as they do on a live machine. system/profile are
    // injected from the fixture, so no real probe is executed.
    const report = await collectReport({
      checkIds: [],
      checks: CHECKS,
      ignorePatterns: [],
      ignoreCodes: [],
      thresholds: loadThresholds({}),
      run: cassetteRun(fixture.commands),
      system: fixture.system,
      profile: { kind: fixture.system.kind },
    });

    assert.deepEqual(report.checkErrors, [], `${file}: a check threw while replaying`);

    // The correlation layer must actually be wired into the pipeline. Without
    // this, deleting the applyStories() call would keep every test green: the
    // fixture only *permits* story/services, it never requires it.
    if (file.startsWith("bazzite-44")) {
      assert.ok(
        report.findings.some((f) => f.code === "story/services"),
        `${file}: services/failed + timers/broken must fold into story/services`,
      );
    }

    const { never, unexpected, unjustified, stale } = compareFindings(report.findings, fixture.expected);
    const line = (f) => `    ${f.code} [${f.severity}] ${f.title}\n      evidence: ${String(f.evidence ?? "").split("\n")[0]}`;

    assert.deepEqual(never, [], `${file}: hardware-fault code(s) on a recorded machine: ${never.join(", ")}`);
    assert.deepEqual(
      unexpected.map(([, f]) => f.code),
      [],
      `${file}: finding(s) with no justification in the fixture:\n${unexpected.map(([, f]) => line(f)).join("\n")}\n` +
        `    if the check is wrong, fix it; if the machine really has this, add a reason to "expected" in the fixture.`,
    );
    assert.deepEqual(unjustified, [], `${file}: expectation(s) still carry a TODO reason: ${unjustified.join(", ")}`);

    if (stale.length) {
      console.log(`note: ${file} no longer produces ${stale.join(", ")} — re-record to refresh the fixture`);
    }
  });
}
