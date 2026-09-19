// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Urgency is not severity.
 *
 * Severity says how bad a finding is; urgency says whether a human has to act
 * on it now. Feedback that started this (Mastodon, @netappblackbox): "a RAID
 * scrub summary or one corrected media error is routine, a broken disk with no
 * spare is a 3am call... grade by 'does this need a human in the next hour',
 * not by distance from normal, otherwise everything reads critical and people
 * stop looking."
 *
 * So: the set is explicit (a code joins it after review, never because its
 * severity happens to be high), an unknown code can never be "now", and the
 * report shows the whole set instead of one action. The score is untouched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { urgencyOf, needsYouNow } from "../src/severities.js";
import { renderReport } from "../src/report.js";

const f = (code, severity, extra = {}) => ({ id: 1, check: code.split("/")[0], code, severity, title: `${code} (${severity})`, detail: null, evidence: null, fix: `fix ${code}`, ...extra });

test("urgency: data-loss grades are 'now'", () => {
  assert.equal(urgencyOf(f("raid/degraded", "high")), "now");
  assert.equal(urgencyOf(f("disk/full", "high")), "now");
  assert.equal(urgencyOf(f("smart/failing", "high")), "now");
  assert.equal(urgencyOf(f("hardware/ecc", "high")), "now", "an uncorrected error is data loss");
});

test("urgency: the same code one grade down is 'watch', not 'now'", () => {
  assert.equal(urgencyOf(f("disk/full", "medium")), "watch", "90% full is this week, not this hour");
  assert.equal(urgencyOf(f("hardware/ecc", "medium")), "watch", "repeated corrected errors are a watch item");
  assert.equal(urgencyOf(f("hardware/ecc", "info")), "fyi", "one corrected error is routine");
});

test("urgency: informational findings are never urgent", () => {
  assert.equal(urgencyOf(f("updates/pending", "info")), "fyi");
  assert.equal(urgencyOf(f("flatpak/pending", "info")), "fyi");
});

test("urgency: an unknown (plugin) code is never 'now'", () => {
  // The safety property: "now" is opt-in per code. A finding from a plugin,
  // however alarming its own wording, cannot claim a deadline this project
  // never reviewed for it.
  assert.equal(urgencyOf(f("myplugin/whatever", "high")), "watch");
  assert.equal(urgencyOf(f("raid/scrub-stuck", "high")), "watch");
});

test("urgency: needsYouNow returns the whole set, in report order", () => {
  const findings = [
    f("disk/full", "high"),
    f("services/failed", "medium"),
    f("raid/degraded", "high"),
    f("hardware/ecc", "info"),
  ];
  assert.deepEqual(needsYouNow(findings).map((x) => x.code), ["disk/full", "raid/degraded"]);
  assert.deepEqual(needsYouNow([]), []);
});

test("urgency: the report shows every 'now' finding, not just the first", async () => {
  const findings = [
    f("disk/full", "high", { fix: "Free space." }),
    f("raid/degraded", "high", { fix: "Replace the disk." }),
    f("updates/pending", "medium"),
  ];
  const report = await renderReport(findings, {
    system: { distro: "Bazzite 44", kernel: "6.1.0", cores: 8, uptime: "1h" },
    score: 62,
  });
  assert.match(report, /NEEDS YOU NOW/);
  assert.match(report, /#1 disk\/full \(high\)/);
  assert.match(report, /#2 raid\/degraded \(high\)/);
});

test("urgency: a single 'now' finding needs no second callout (START HERE covers it)", async () => {
  const findings = [f("disk/full", "high", { fix: "Free space." }), f("updates/pending", "medium")];
  const report = await renderReport(findings, {
    system: { distro: "Bazzite 44", kernel: "6.1.0", cores: 8, uptime: "1h" },
    score: 77,
  });
  assert.match(report, /START HERE/);
  assert.ok(!/NEEDS YOU NOW/.test(report), "one finding is already the START HERE line");
});

test("urgency: changing urgency never changes the score", async () => {
  // The score is the run-over-run memory; urgency must not re-grade it.
  const findings = [f("raid/degraded", "high", { severity: "high", code: "raid/degraded" })];
  const report = await renderReport(findings, {
    system: { distro: "x", kernel: "y", cores: 1, uptime: "0h" },
    score: 85,
    scoreBreakdown: [{ code: "raid/degraded", severity: "high", title: "raid", penalty: 15 }],
  });
  assert.match(report, /health 85\/100/);
  assert.match(report, /85\/100 = 100 −15 raid\/degraded/);
});
