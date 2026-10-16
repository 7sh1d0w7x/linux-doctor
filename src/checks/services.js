// SPDX-License-Identifier: GPL-3.0-or-later
import { lines, plural, shq } from "../utils.js";

import { defineCheck } from "./define.js";
import { finding } from "../findings.js";
import { svcCmd, svcLogs } from "../distro.js";

export const services = defineCheck({
  id: "services",
  title: "Failed services",
  category: "software",
  async run(ctx) {
    const findings = [];
    const [sys, user] = await Promise.all([
      ctx.run("systemctl --failed --no-legend --plain"),
      ctx.run("systemctl --user --failed --no-legend --plain"),
    ]);

    const failed = [];
    for (const [res, scope] of [[sys, "system"], [user, "user"]]) {
      if (!res.ok) continue;
      for (const l of lines(res.stdout)) {
        const name = l.split(/\s+/)[0];
        if (name) failed.push({ name, scope });
      }
    }

    if (failed.length > 0) {
      // Scope matters, not just count: a failed system service (network,
      // display, a daemon) is a real fault; user autostart failures are the
      // user's own apps and rarely worth a scary "high".
      const hasSystemFailure = failed.some((f) => f.scope === "system");
      findings.push(finding({
        severity: hasSystemFailure ? "high" : "medium",
        code: "services/failed",
        title: `${failed.length} service${failed.length > 1 ? "s" : ""} failed to start`,
        detail: `These ${plural(failed.length, "service")} are in a failed state: ${failed.map((f) => `\`${f.name}\` (${f.scope})`).join(", ")}. A failed service usually means a broken package, a bad configuration, or a hook that errored.`,
        evidence: failed.map((f) => `${f.name}\t${f.scope}`).join("\n"),
        fix: `Inspect one with \`${svcCmd(ctx.dist, "status", failed[0].name)}\`${(ctx.dist?.init || "systemd") === "systemd" ? ` (user services: \`systemctl --user status ${failed[0].name}\`)` : ""}. If it is not something you need, stop it with \`${svcCmd(ctx.dist, "stop", failed[0].name)}\`.`,
        confidence: "high",
      }));
    } else if (sys.missing && user.missing) {
      // Non-systemd distros (Alpine/OpenRC, Void/runit, Gentoo/OpenRC) have no
      // systemctl; say so instead of silently skipping.
      const init = await ctx.run("ps -p 1 -o comm= 2>/dev/null");
      findings.push(finding({
        severity: "info",
        code: "services/skipped",
        title: "Non-systemd system — services check skipped",
        detail: `This system does not run systemd (init: ${init.stdout.trim() || "unknown"}), so the failed-services check does not apply.`,
        evidence: init.stdout.trim() || "init unknown",
        fix: null,
        confidence: "high",
      }));
      return findings;
    }

    // Restart loops: a unit in "auto-restart" substate is "active" but never
    // actually stays up — systemd keeps restarting it after every crash. It hides
    // behind a green status, which is exactly the blind spot monitoring misses.
    const loopUnits = await ctx.run(
      "systemctl list-units --type=service --no-legend --plain 2>/dev/null | grep -i 'auto-restart'"
    );
    if (loopUnits.ok && loopUnits.stdout.trim()) {
      const looping = [];
      for (const l of lines(loopUnits.stdout)) {
        const name = l.split(/\s+/)[0];
        if (!name) continue;
        const nr = await ctx.run(`systemctl show ${shq(name)} -p NRestarts --value 2>/dev/null`);
        const n = parseInt((nr.stdout || "").trim(), 10) || 0;
        looping.push(n >= 3 ? `${name} (${n} restarts)` : name);
      }
      if (looping.length > 0) {
        findings.push(finding({
          severity: "high",
          code: "services/restart-loop",
          title: `${looping.length} service${looping.length > 1 ? "s" : ""} stuck in a restart loop`,
          detail: `These units are in an "auto-restart" loop — systemd keeps restarting them because they keep exiting: ${looping.join(", ")}. A green "active" status hides the fact that they never stay up. This is usually a broken config, a missing dependency, or an out-of-memory kill (exit 137).`,
          evidence: looping.join("\n"),
          fix: `Find the root error with \`${svcLogs(ctx.dist, looping[0].split(" ")[0])}\`. Fix the cause, then restart it with \`${svcCmd(ctx.dist, "restart", looping[0].split(" ")[0])}\`.`,
          confidence: "high",
        }));
      }
    }
    return findings;
  },
});
