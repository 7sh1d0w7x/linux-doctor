// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * JSON Schema (draft-07) for `linux-doctor --json` output, schemaVersion 1.
 * `linux-doctor --schema` prints this document, so fleet servers, monitoring
 * integrations, and CI pipelines can validate reports before consuming them.
 *
 * Versioning policy: ADDITIVE changes — new optional properties, never a
 * new requirement and never a narrowed type — do NOT bump schemaVersion.
 * Consumers must ignore unknown properties; producers must keep every
 * emitted top-level key documented here (enforced by
 * tests/output-drift.test.js). Incompatible shape changes bump the version
 * and update this document in the same change.
 */
export const reportSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "linux-doctor report",
  description: "Output of `linux-doctor --json` (schemaVersion 1).",
  type: "object",
  required: ["schemaVersion", "tool", "version", "generatedAt", "findings"],
  properties: {
    schemaVersion: { const: 1 },
    tool: { const: "linux-doctor" },
    version: { type: "string", description: "linux-doctor package version" },
    generatedAt: { type: "string", format: "date-time" },
    durationMs: { type: "number", minimum: 0 },
    durations: {
      type: "object",
      description: "per-check wall-clock milliseconds; present only with --profile",
      additionalProperties: { type: "number", minimum: 0 },
    },
    newCount: { type: "integer", minimum: 0 },
    fixedCount: { type: "integer", minimum: 0 },
    unchanged: { type: "integer", minimum: 0, description: "top-level mirror of diffSinceLast.unchanged (current findings also present in the previous run)" },
    ignoredCount: { type: "integer", minimum: 0, description: "findings hidden by ignore patterns this run" },
    checksRun: { type: "integer", minimum: 0, description: "how many checks actually ran" },
    checksSkipped: { type: "integer", minimum: 0, description: "checks skipped by appliesTo gating (full runs only)" },
    score: { type: "integer", minimum: 0, maximum: 100 },
    scoreBreakdown: {
      type: "array",
      description: "per-finding penalty behind the health score, in finding order; info findings are listed with penalty 0. `100 − Σpenalty === score` holds by construction.",
      items: {
        type: "object",
        required: ["severity", "penalty"],
        properties: {
          code: { type: ["string", "null"], description: "stable finding code, or null when the source carried none" },
          severity: { enum: ["high", "medium", "info"] },
          title: { type: ["string", "null"] },
          penalty: { type: "integer", minimum: 0 },
        },
      },
    },
    scoreDelta: { type: ["integer", "null"], description: "score minus the previous run's score; null when there is no history or history is disabled (can be negative)" },
    previousScore: { type: ["integer", "null"], minimum: 0, description: "the most recent stored run's score, or null" },
    lastRunAt: { type: ["string", "null"], format: "date-time", description: "when the previous recorded run happened, or null" },
    cleanStreak: { type: "integer", minimum: 0, description: "consecutive trailing clean runs including this one; 0 when this run has high/medium findings or history is off" },
    checkErrors: {
      type: "array",
      description: "checks that threw while running; the run continued without them",
      items: {
        type: "object",
        required: ["check", "error"],
        properties: {
          check: { type: "string" },
          error: { type: "string" },
        },
      },
    },
    counts: {
      type: "object",
      properties: {
        high: { type: "integer", minimum: 0 },
        medium: { type: "integer", minimum: 0 },
        info: { type: "integer", minimum: 0 },
      },
    },
    diffSinceLast: {
      type: "object",
      properties: {
        added: { type: "array", items: { $ref: "#/definitions/briefFinding" } },
        fixed: { type: "array", items: { $ref: "#/definitions/briefFinding" } },
        unchanged: { type: "integer", minimum: 0, description: "current findings whose key also appeared in the previous run" },
        firstRun: { type: "boolean", description: "true when there was no previous run to compare against, so added/fixed/unchanged are all zero" },
      },
    },
    historyDisabled: {
      type: "boolean",
      description: "true when --no-history / LINUX_DOCTOR_NO_HISTORY suppressed history read+write this run",
    },
    changeMessage: {
      type: ["string", "null"],
      description: "human one-liner summarizing the change since the last run, or null when nothing changed",
    },
    nextAction: {
      type: ["object", "null"],
      description: "the ▶ START HERE pick as data — highest-severity finding that comes with a fix; the dashboard renders this instead of recomputing. null when nothing has a fix.",
      required: ["severity", "title"],
      properties: {
        code: { type: ["string", "null"] },
        severity: { enum: ["high", "medium", "info"] },
        title: { type: "string" },
        fix: { type: ["string", "null"] },
      },
    },
    skippedChecks: {
      type: "array",
      description: "checks that were intentionally skipped (not failed) with a reason — e.g. not applicable on an immutable system",
      items: {
        type: "object",
        required: ["id", "title", "reason"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    checksAtomicSkipped: {
      type: "integer",
      minimum: 0,
      description: "checks skipped because they do not apply to an immutable/atomic system",
    },
    system: {
      type: "object",
      properties: {
        distro: { type: "string" },
        family: { type: "string" },
        kind: { enum: ["desktop", "laptop", "server"] },
        kernel: { type: "string" },
        cores: { type: ["integer", "string"], description: "CPU core count (string when nproc is unavailable)" },
        uptime: { type: "string" },
        arch: { type: ["string", "null"], description: "machine architecture from uname -m" },
        hostname: { type: ["string", "null"], description: "system hostname (local-only detail, also surfaced in alerts)" },
        cpuModel: { type: ["string", "null"], description: "CPU model name from /proc/cpuinfo" },
        memTotalBytes: { type: ["integer", "null"], description: "total RAM in bytes from /proc/meminfo" },
        desktop: { type: ["string", "null"], description: "desktop environment from XDG_CURRENT_DESKTOP/DESKTOP_SESSION" },
        sessionType: { type: ["string", "null"], description: "session type from XDG_SESSION_TYPE (wayland/x11/tty…)" },
        immutable: { type: "boolean" },
        imageBased: { type: "boolean" },
        hasSystemd: { type: "boolean", description: "true when the running init is systemd (/run/systemd/system exists); some fix commands are systemd-only and are withheld when false" },
        atomicVariant: { type: ["string", "null"], description: "specific atomic variant (bazzite, silverblue, ...) or null" },
        osRelease: {
          type: "object",
          description: "parsed /etc/os-release key/value pairs, as emitted by the runtime",
          additionalProperties: { type: "string" },
        },
        atomic: {
          type: "object",
          description: "structured immutable/atomic profile so consumers adapt once",
          properties: {
            immutable: { type: "boolean" },
            imageBased: { type: "boolean" },
            bootc: { type: "boolean" },
            variant: { type: ["string", "null"] },
            pkg: { type: "string" },
          },
        },
      },
    },
    findings: { type: "array", items: { $ref: "#/definitions/finding" } },
  },
  definitions: {
    finding: {
      type: "object",
      required: ["id", "check", "code", "severity", "title"],
      properties: {
        id: { type: "integer", minimum: 1 },
        check: { type: "string", description: "which check produced this finding" },
        code: { type: "string", description: "stable machine key for scripting and ignore rules" },
        dedupeKey: { type: "string", description: "root cause shared with another check's finding" },
        severity: { enum: ["high", "medium", "info"] },
        title: { type: "string" },
        detail: { type: ["string", "null"] },
        evidence: { type: ["string", "null"] },
        fix: { type: ["string", "null"] },
        confidence: { enum: ["high", "medium", "low"] },
        isNew: { type: "boolean" },
      },
    },
    briefFinding: {
      type: "object",
      required: ["severity", "title"],
      properties: {
        severity: { enum: ["high", "medium", "info"] },
        title: { type: "string" },
        code: { type: "string", description: "stable identity used for new/fixed change detection" },
      },
    },
  },
};
