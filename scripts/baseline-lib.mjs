// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Rules shared by the two things that check the engine against recorded or
 * synthetic machines:
 *
 *   - scripts/baseline-gate.mjs — runs inside a distro image in CI
 *   - tests/fixtures.test.js    — replays a recorded machine fixture
 *
 * Both must apply the same judgement to the same finding codes, so the lists
 * live here rather than in either caller.
 */

/** A refreshed expectation that nobody has justified yet. */
export const TODO = "TODO";

/**
 * Codes that must never appear on a clean image, whatever an expectation map
 * says. A bare container has no ECC memory to correct and no mounted filesystem
 * to corrupt, so one of these firing is the check lying about the machine. They
 * are the false positives this suite has actually shipped (#13, #16).
 */
export const NEVER_ON_CLEAN = [
  "hardware/ecc",
  "hardware/mce",
  "fs/btrfs-errors",
  "fs/readonly-remount",
  "smart/failing",
];

/**
 * Codes whose truth depends on the host rather than the image — inside a
 * container `memory/low` reads the host's memory, so pinning it would make CI
 * flap with whatever else the runner is doing. Tolerated in both directions:
 * never pinned, never failing.
 */
export const ENVIRONMENT = new Set([
  "memory/low",
  "load/busy",
  "load/overloaded",
  "oom/kills",
  "crash/coredumps",
  "updates/pending",
  "network/no-route",
  // The container inherits the runner's disks: /__t is the Actions workspace and
  // sat at 83% on #68 while the image under test was nearly empty. The finding
  // was true about the host and useless about the distro — and it passed on a
  // re-run, which is the definition of host-dependent.
  "disk/full",
  // A latency threshold measured on shared hardware: 2.2s on one runner, well
  // under the limit on another, same image, same code.
  "network/dns-slow",
]);

/** High/medium codes present in a finding list, first occurrence wins. */
export function highMediumCodes(findings) {
  const codes = new Map();
  for (const f of findings ?? []) {
    if (f.severity === "high" || f.severity === "medium") {
      if (!codes.has(f.code)) codes.set(f.code, f);
    }
  }
  return codes;
}

/**
 * Compare findings against an `expected` map of code → reason. Returns the
 * observed map plus the four verdicts a caller reports on: hardware codes that
 * must never appear, findings with no justification, justifications that are
 * still TODO (including non-string ones), and entries that no longer fire.
 */
export function compareFindings(findings, expected = {}) {
  const observed = highMediumCodes(findings);
  return {
    observed,
    never: [...observed.keys()].filter((c) => NEVER_ON_CLEAN.includes(c)),
    unexpected: [...observed.entries()].filter(([c]) => !(c in expected) && !ENVIRONMENT.has(c)),
    unjustified: Object.entries(expected)
      .filter(([, reason]) => typeof reason !== "string" || reason.startsWith(TODO))
      .map(([c]) => c),
    stale: Object.keys(expected).filter((c) => !observed.has(c)),
  };
}
