/**
 * Golden snapshots — the full-output regression net.
 *
 * Each state from docs/output-parity.md's matrix is rendered through all
 * three text channels and compared byte-for-byte against the committed
 * snapshot. A wording change, an ordering change, a dropped line: anything
 * fails here with a reviewable diff instead of slipping out silently.
 *
 * Snapshots update ONLY via `npm run goldens:update` — never by hand — so a
 * snapshot change always shows up as a reviewable diff in the PR that
 * intentionally changed the output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { SCENARIOS, renderChannels } from "./scenarios.mjs";

const SNAPSHOTS = join(dirname(fileURLToPath(import.meta.url)), "snapshots");

function firstDiff(expected, actual) {
  const e = expected.split("\n");
  const a = actual.split("\n");
  for (let i = 0; i < Math.max(e.length, a.length); i += 1) {
    if (e[i] !== a[i]) {
      return `  line ${i + 1}:\n  expected: ${JSON.stringify(e[i])}\n  actual:   ${JSON.stringify(a[i])}`;
    }
  }
  return "  (length differs only)";
}

for (const state of Object.keys(SCENARIOS)) {
  for (const channel of ["pretty", "plain", "json", "md"]) {
    test(`golden[${state}/${channel}]: matches the committed snapshot`, async () => {
      const rendered = await renderChannels(state);
      const file = join(SNAPSHOTS, `${state}.${channel}.txt`);
      let committed;
      try {
        committed = readFileSync(file, "utf8");
      } catch {
        assert.fail(`snapshot missing: ${file}\nRun \`npm run goldens:update\` and review the diff.`);
      }
      assert.equal(
        rendered[channel],
        committed,
        `output drifted for ${state}/${channel}.\n${firstDiff(committed, rendered[channel])}\nIf this change is INTENTIONAL, run \`npm run goldens:update\` and commit the diff.`
      );
    });
  }
}
