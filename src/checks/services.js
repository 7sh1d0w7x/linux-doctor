// SPDX-License-Identifier: GPL-3.0-or-later
import { lines, shq } from "../utils.js";

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
      const first = failed[0];
      const init = ctx.dist?.init || "systemd";
      // A unit's scope decides which systemctl answers for it. Printing the
      // --user form for a system unit sends the reader to a command that cannot
      // show the unit at all, and the other way round is just as useless.
      const isUser = first.scope === "user" && init === "systemd";
      const status = isUser
        ? `systemctl --user status ${first.name}`
        : svcCmd(ctx.dist, "status", first.name);
      const logs = isUser ? `journalctl --user -u ${first.name} -b` : svcLogs(ctx.dist, first.name);
      // `reset-failed` clears the mark without changing what the unit does, so
      // it is the honest answer to "this failed once and I have read why".
      // systemd only — the other inits have no equivalent — and a user unit is
      // cleared by the user manager, without sudo.
      const clear = init !== "systemd"
        ? null
        : isUser
          ? `systemctl --user reset-failed ${first.name}`
          : `sudo systemctl reset-failed ${first.name}`;
      // "These 1 service are" is the kind of thing that makes a report read as
      // machine-written, and it was the first sentence a user saw here.
      const subject = failed.length === 1
        ? `This service is in a failed state: ${failed[0].name} (${failed[0].scope}).`
        : `These ${failed.length} services are in a failed state: ${failed.map((f) => `\`${f.name}\` (${f.scope})`).join(", ")}.`;
      findings.push(finding({
        severity: hasSystemFailure ? "high" : "medium",
        code: "services/failed",
        title: `${failed.length} service${failed.length > 1 ? "s" : ""} failed to start`,
        detail: `${subject} The state is a fact, not a diagnosis — read the unit's log before concluding anything. Oneshot units and timer-driven ones often fail once on a transient problem (a network fetch, a resource someone else was holding) and keep the mark until it is cleared, while a unit that exits over and over is a real fault.`,
        evidence: failed.map((f) => `${f.name}\t${f.scope}`).join("\n"),
        fix: `Read why it failed: \`${logs}\`. Then \`${status}\`.${clear ? ` Once you understand it, \`${clear}\` clears the failed mark without changing what the unit does.` : ""} Do not disable a unit you have not read — a refresh timer that failed on a network error still does work you want.`,
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
