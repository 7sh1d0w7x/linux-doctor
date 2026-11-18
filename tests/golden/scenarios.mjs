/**
 * Golden fixture harness — shared by the test AND the update script.
 *
 * One renderer, two consumers: `renderChannels(state)` produces exactly what
 * both sides compare, so the write path and the verify path can never drift.
 * Determinism rules applied here:
 *   - timestamps/version become placeholders (they differ every run);
 *   - durationMs/durations are dropped (wall-clock noise);
 *   - ANSI escapes are stripped (report.js branches on TTY at import time;
 *     stripping makes snapshots identical whether this runs in a terminal,
 *     in CI, or through a pipe).
 */
import { renderReport, renderPlain, renderJson } from "../../src/report.js";
import { renderMarkdown } from "../../src/markdown.js";

/** The four states from docs/output-parity.md's verification matrix. */
export const SCENARIOS = {
  mixed: {
    findings: [
      { id: 1, check: "disk", code: "disk/full", severity: "high", title: "/home partition is 91% full", detail: "Only 12 GB free of 466 GB.", evidence: "/dev/nvme0n1p3  91% USED  466G", fix: "Clean old snapshots: `sudo snapper list`.", isNew: false },
      { id: 2, check: "services", code: "services/failed", severity: "medium", title: "2 services failed to start", detail: null, evidence: "app-picom.service loaded failed", fix: "Inspect with `systemctl status app-picom`.", isNew: true },
      { id: 3, check: "updates", code: "updates/pending", severity: "info", title: "5 package updates available", detail: null, evidence: null, fix: "Run your system updater.", isNew: false },
    ],
    opts: {
      system: { distro: "Bazzite 44", kernel: "6.1.0", cores: 16, uptime: "2h" },
      score: 77,
      scoreBreakdown: [
        { code: "disk/full", severity: "high", title: "/home partition is 91% full", penalty: 15 },
        { code: "services/failed", severity: "medium", title: "2 services failed to start", penalty: 8 },
        { code: "updates/pending", severity: "info", title: "5 package updates available", penalty: 0 },
      ],
      scoreDelta: -23,
      previousScore: 100,
      newCount: 1,
      fixedCount: 0,
      unchanged: 2,
      diffSinceLast: {
        added: [{ code: "services/failed", severity: "medium", title: "2 services failed to start" }],
        fixed: [],
        unchanged: 2,
      },
      lastRunAt: "2026-08-21T09:00:00Z",
      cleanStreak: 0,
      checksRun: 36,
      checksSkipped: 1,
      checkErrors: [{ check: "smart", error: "smartctl unavailable" }],
      categoryByCheck: new Map([["disk", "storage"], ["services", "system"], ["updates", "packages"]]),
      historyRuns: [
        { at: "2026-08-19T09:00:00Z", score: 100, counts: { high: 0, medium: 0, info: 1 } },
        { at: "2026-08-20T09:00:00Z", score: 92, counts: { high: 0, medium: 1, info: 2 } },
        { at: "2026-08-21T09:00:00Z", score: 100, counts: { high: 0, medium: 0, info: 3 } },
      ],
    },
  },

  "healthy-streak": {
    findings: [],
    opts: {
      system: { distro: "Fedora 43", kernel: "6.12.0", cores: 8, uptime: "3d" },
      score: 100,
      scoreBreakdown: [],
      scoreDelta: 0,
      previousScore: 100,
      newCount: 0,
      fixedCount: 0,
      unchanged: 0,
      diffSinceLast: { added: [], fixed: [], unchanged: 0 },
      lastRunAt: "2026-08-22T08:00:00Z",
      cleanStreak: 5,
      checksRun: 36,
      checksSkipped: 1,
      checkErrors: [],
      historyRuns: [
        { at: "2026-08-18T08:00:00Z", score: 100, counts: { high: 0, medium: 0, info: 0 } },
        { at: "2026-08-19T08:00:00Z", score: 100, counts: { high: 0, medium: 0, info: 0 } },
        { at: "2026-08-20T08:00:00Z", score: 100, counts: { high: 0, medium: 0, info: 1 } },
        { at: "2026-08-21T08:00:00Z", score: 100, counts: { high: 0, medium: 0, info: 0 } },
        { at: "2026-08-22T08:00:00Z", score: 100, counts: { high: 0, medium: 0, info: 0 } },
      ],
    },
  },

  "info-only": {
    findings: [
      { id: 1, check: "zram", code: "zram/ok", severity: "info", title: "zram swap is enabled", detail: null, evidence: "zram0: 8 GB", fix: null, isNew: false },
    ],
    opts: {
      system: { distro: "Ubuntu 25.04", kernel: "6.14.0", cores: 4, uptime: "6h" },
      score: 100,
      scoreBreakdown: [{ code: "zram/ok", severity: "info", title: "zram swap is enabled", penalty: 0 }],
      scoreDelta: null,
      previousScore: 100,
      newCount: 0,
      fixedCount: 1,
      unchanged: 0,
      diffSinceLast: {
        added: [],
        fixed: [{ code: "memory/low", severity: "medium", title: "System was low on memory" }],
        unchanged: 0,
      },
      lastRunAt: "2026-08-22T10:00:00Z",
      cleanStreak: 1,
      checksRun: 36,
      checksSkipped: 2,
      checkErrors: [],
      historyRuns: [{ at: "2026-08-22T10:00:00Z", score: 92, counts: { high: 0, medium: 1, info: 0 } }],
    },
  },

  "first-run": {
    findings: [
      { id: 1, check: "memory", code: "memory/low", severity: "medium", title: "System is low on usable memory", detail: "2.2 GB pushed to swap.", evidence: "MemAvailable: 2.9G / 15G", fix: "Close unused browser tabs, then re-run this check.", isNew: false },
    ],
    opts: {
      system: { distro: "Arch Linux", kernel: "6.16.1", cores: 12, uptime: "40m" },
      score: 92,
      scoreBreakdown: [{ code: "memory/low", severity: "medium", title: "System is low on usable memory", penalty: 8 }],
      scoreDelta: null,
      previousScore: null,
      newCount: 1,
      fixedCount: 0,
      unchanged: 0,
      diffSinceLast: {
        added: [{ code: "memory/low", severity: "medium", title: "System is low on usable memory" }],
        fixed: [],
        unchanged: 0,
      },
      lastRunAt: null,
      cleanStreak: 0,
      checksRun: 36,
      checksSkipped: 0,
      checkErrors: [],
      historyRuns: [],
    },
  },
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Normalize one rendered channel into its deterministic snapshot form. */
function normalize(text) {
  return text.replace(ANSI_RE, "");
}

function normalizeJson(jsonText) {
  const payload = JSON.parse(jsonText);
  payload.generatedAt = "<generatedAt>";
  if (typeof payload.version === "string") payload.version = "<version>";
  delete payload.durationMs;
  delete payload.durations;
  return JSON.stringify(payload, null, 2) + "\n";
}

/**
 * Render one state through all three text channels, normalized for
 * comparison. Exported so the update script writes EXACTLY what the test
 * expects.
 */
export async function renderChannels(name) {
  const { findings, opts } = SCENARIOS[name];
  // Mirror the cli.js call sites exactly: the internal field is historyRuns,
  // renderers receive it as `history`. Skipping this mapping would silently
  // drop TREND/spark sections from every snapshot.
  const { historyRuns, categoryByCheck, system, ...serialized } = opts;
  const renderOpts = { ...opts, history: historyRuns };
  const pretty = await renderReport(findings, renderOpts);
  const plain = renderPlain(findings, renderOpts);
  const json = renderJson(
    findings.map((f) => ({ ...f })),
    system,
    { ...serialized, generatedAt: new Date().toISOString() }
  );
  // `--md` is a fourth channel: same findings, scrubbed, and pinned for the same
  // reason as the others (a wording change must show up as a diff). The version
  // is a placeholder like in the JSON snapshot, so a release bump does not
  // rewrite every markdown golden.
  const md = renderMarkdown(findings, { ...renderOpts, version: "<version>" });
  return { pretty: `${normalize(pretty)}\n`, plain: `${normalize(plain)}\n`, json: normalizeJson(json), md: `${normalize(md)}\n` };
}
