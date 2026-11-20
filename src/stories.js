// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Correlation layer: one story per problem instead of one fact per check.
 *
 * A per-check tool tells you "memory is low" and separately "brave is using
 * 8 GB". Those are the same problem, and the user has to do the joining. Here
 * the findings that describe one problem are collapsed into a single finding
 * that carries the story, with the individual findings kept underneath in
 * `children` so nothing is lost and `--json` consumers can still see the parts.
 *
 * Rules that keep this honest:
 *
 *  - Only real problems are correlated (high and medium). Informational
 *    findings stay where they are: merging `zram/ok` into a memory story would
 *    turn a healthy check into a symptom.
 *  - A story needs at least two findings. One finding is a fact, not a story,
 *    and wrapping it would change its code for no benefit.
 *  - The story takes the worst member's severity, category (via `check`) and
 *    fix, so the health score and the "start here" line still point at the
 *    single most useful action.
 *  - Members keep their own identity inside `children`; dedupe, ignore rules and
 *    history all run before this layer, so the codes stay stable.
 *
 * Applied only to a full run. `--check <id>` asks for one check's facts and
 * gets exactly that.
 */
import { SEV_ORDER } from "./severities.js";

/**
 * Each story lists the checks whose high/medium findings describe the same
 * underlying problem. `lead` is the sentence the reader gets instead of having
 * to infer the connection.
 */
export const STORIES = [
  {
    id: "memory",
    title: "Memory pressure",
    checks: ["memory", "processes", "zram"],
    lead: "More than one check sees the same memory problem: the machine does not have enough usable RAM for what is running.",
  },
  {
    id: "disk",
    title: "Storage pressure",
    checks: ["disk", "inodes", "cache", "journald", "containerdisk", "boot"],
    lead: "More than one check sees storage running out. They are the same disk seen from different sides.",
  },
  {
    id: "services",
    title: "Services are not running",
    checks: ["services", "timers"],
    lead: "More than one check sees units that are not running as they should. Treat them as one startup problem.",
  },
];

const CHECK_TO_STORY = new Map();
for (const story of STORIES) {
  for (const check of story.checks) CHECK_TO_STORY.set(check, story);
}

/**
 * The story a finding belongs to, whether or not it was folded: "memory",
 * "disk", "services", or null. Exposed in the JSON so a consumer can group even
 * when a story has one member and did not collapse.
 */
export function storyOf(code) {
  const check = String(code || "").split("/")[0];
  if (check === "story") return String(code).slice("story/".length) || null;
  return CHECK_TO_STORY.get(check)?.id ?? null;
}

/** Severity levels that describe a problem worth correlating. */
const PROBLEM = new Set(["high", "medium"]);

function firstLine(text, max = 140) {
  const line = String(text || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function worstOf(members) {
  return members
    .slice()
    .sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity))[0];
}

function buildStory(story, members) {
  const worst = worstOf(members);
  return {
    severity: worst.severity,
    code: `story/${story.id}`,
    title: story.title,
    // The lead names the shared problem; the parts are in `evidence` (and in
    // `children`), so repeating their titles here only produced a run-on
    // sentence that read like two headings glued together.
    detail: story.lead,
    evidence: members
      .map((m) => `[${m.severity}] ${m.code}: ${firstLine(m.evidence || m.detail || m.title)}`)
      .join("\n"),
    fix: worst.fix ?? null,
    confidence: worst.confidence ?? "high",
    check: worst.check,
    children: members.map(({ id, ...rest }) => rest),
  };
}

/**
 * Collapse the findings that belong to one story. Returns a new array with
 * stable order: a story appears where its first member appeared, the other
 * members are removed, and every finding is renumbered from 1.
 */
export function applyStories(findings) {
  if (!Array.isArray(findings) || findings.length < 2) return findings;

  const groups = new Map();
  for (const f of findings) {
    if (!PROBLEM.has(f.severity)) continue;
    const check = String(f.code || "").split("/")[0];
    const story = CHECK_TO_STORY.get(check);
    if (!story) continue;
    if (!groups.has(story.id)) groups.set(story.id, { story, members: [] });
    groups.get(story.id).members.push(f);
  }

  const storyAt = new Map(); // id of the first member -> story finding
  const absorbed = new Set(); // ids of the members folded into a story
  for (const { story, members } of groups.values()) {
    if (members.length < 2) continue;
    storyAt.set(members[0].id, buildStory(story, members));
    for (const m of members.slice(1)) absorbed.add(m.id);
  }
  if (storyAt.size === 0) return findings;

  const out = [];
  for (const f of findings) {
    if (absorbed.has(f.id)) continue;
    const story = storyAt.get(f.id);
    out.push(story ? { ...story, id: out.length + 1 } : { ...f, id: out.length + 1 });
  }
  return out;
}
