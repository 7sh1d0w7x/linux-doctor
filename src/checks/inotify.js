// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * inotify limits: `fs.inotify.max_user_watches` and `max_user_instances` are
 * per-user ceilings that almost nobody knows about. When they are reached, file
 * watchers stop working silently — an editor stops noticing saves, a sync
 * client stops uploading, a dev server stops rebuilding — and nothing in the
 * logs says why.
 *
 * Usage is measured for the invoking user only: `/proc/<pid>/fdinfo` is readable
 * for your own processes, and the limits are per UID anyway. Processes running
 * as another user are invisible to this v1, so the number is a floor, not a
 * total — which is the safe direction for an alarm: it can miss a problem, it
 * cannot invent one.
 */
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";

const MAX_WATCHES = "cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null";
const MAX_INSTANCES = "cat /proc/sys/fs/inotify/max_user_instances 2>/dev/null";
const MAX_EVENTS = "cat /proc/sys/fs/inotify/max_queued_events 2>/dev/null";

// One grep over every readable fdinfo: each inotify watch is an "inotify wd:"
// line, and each file that has at least one is an instance.
const USED_WATCHES = "grep -h '^inotify wd:' /proc/[0-9]*/fdinfo/* 2>/dev/null | wc -l";
const USED_INSTANCES = "grep -l '^inotify wd:' /proc/[0-9]*/fdinfo/* 2>/dev/null | wc -l";

function limit(res) {
  const n = Number(String(res.stdout || "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function severityFor(ratio, warn, high) {
  if (ratio >= high) return "high";
  if (ratio >= warn) return "medium";
  return null;
}

export const inotify = defineCheck({
  id: "inotify",
  title: "File watcher limits (inotify)",
  category: "system",
  async run(ctx) {
    const [wRes, iRes, eRes] = await Promise.all([ctx.run(MAX_WATCHES), ctx.run(MAX_INSTANCES), ctx.run(MAX_EVENTS)]);
    const maxWatches = limit(wRes);
    const maxInstances = limit(iRes);
    if (maxWatches === null && maxInstances === null) return [];

    const [uw, ui] = await Promise.all([ctx.run(USED_WATCHES), ctx.run(USED_INSTANCES)]);
    const usedWatches = Number(String(uw.stdout || "").trim());
    const usedInstances = Number(String(ui.stdout || "").trim());
    if (!Number.isFinite(usedWatches) || !Number.isFinite(usedInstances)) return [];

    const findings = [];
    const warn = ctx.thresholds.inotifyWarnRatio ?? 0.8;
    const high = ctx.thresholds.inotifyHighRatio ?? 0.95;
    const queued = String(eRes.stdout || "").trim() || "unknown";

    if (maxWatches !== null) {
      const ratio = usedWatches / maxWatches;
      const severity = severityFor(ratio, warn, high);
      if (severity) {
        findings.push(finding({
          severity,
          code: "inotify/watches-low",
          title: `inotify watches are ${Math.round(ratio * 100)}% used`,
          detail: `This user is using ${usedWatches.toLocaleString("en-US")} of ${maxWatches.toLocaleString("en-US")} inotify watches. When the limit is reached, new file watchers fail with ENOSPC and the programs that rely on them stop noticing changes — an editor stops reacting to saves, a sync client stops uploading — usually with no message anywhere. Editors, IDEs, sync clients and dev servers are the usual consumers.`,
          evidence: `max_user_watches=${maxWatches} · in use ${usedWatches} (${Math.round(ratio * 100)}%) · max_queued_events=${queued}`,
          fix: `Raise it for the whole system: \`sudo sysctl -w fs.inotify.max_user_watches=${Math.max(maxWatches * 4, 524288)}\` and persist it in /etc/sysctl.d/99-inotify.conf. To see which processes are watching the most, \`grep -c '^inotify wd:' /proc/*/fdinfo/* 2>/dev/null | sort -t: -k2 -rn | head\`.`,
          confidence: "high",
        }));
      }
    }

    if (maxInstances !== null) {
      const ratio = usedInstances / maxInstances;
      const severity = severityFor(ratio, warn, high);
      if (severity) {
        findings.push(finding({
          severity,
          code: "inotify/instances-low",
          title: `inotify instances are ${Math.round(ratio * 100)}% used`,
          detail: `This user has ${usedInstances} of ${maxInstances} inotify instances open. Each program that watches files takes one or more; when the limit is reached, new instances fail with ENOSPC and those programs silently stop watching.`,
          evidence: `max_user_instances=${maxInstances} · in use ${usedInstances} (${Math.round(ratio * 100)}%)`,
          fix: `Raise it: \`sudo sysctl -w fs.inotify.max_user_instances=${Math.max(maxInstances * 4, 1024)}\` and persist it in /etc/sysctl.d/99-inotify.conf.`,
          confidence: "high",
        }));
      }
    }

    return findings;
  },
});
