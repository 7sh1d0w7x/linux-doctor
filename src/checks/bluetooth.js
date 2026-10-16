// SPDX-License-Identifier: GPL-3.0-or-later
import { lines } from "../utils.js";
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";
import { svcCmd, svcLogs } from "../distro.js";

/**
 * Checks Bluetooth health: whether any controller exists, whether the
 * Bluetooth service is in a failed state, and whether the daemon process is
 * actually running. All reads are from sysfs or process state — we deliberately
 * avoid `bluetoothctl`, because talking to it can auto-activate a socket-started
 * daemon (a side effect), and its power state is often a deliberate user choice
 * anyway.
 */

export const bluetooth = defineCheck({
  id: "bluetooth",
  title: "Bluetooth",
  category: "hardware",
  appliesTo: ["desktop", "laptop"],
  async run(ctx) {
    const findings = [];

    const [controllers, isFailed, daemon] = await Promise.all([
      ctx.run("ls /sys/class/bluetooth 2>/dev/null"),
      ctx.run("systemctl is-failed bluetooth 2>/dev/null"),
      ctx.run("pgrep -x bluetoothd 2>/dev/null"),
    ]);

    const ctrls = lines(controllers.stdout);

    if (ctrls.length === 0) {
      findings.push(finding({
        severity: "info",
        code: "bluetooth/none",
        title: "No Bluetooth hardware detected",
        detail: "No Bluetooth controllers were found. This is normal on desktops and most servers — the Bluetooth check does not apply.",
        evidence: "no /sys/class/bluetooth entries",
        fix: null,
        confidence: "high",
      }));
      return findings;
    }

    if (isFailed.ok && isFailed.stdout.trim() === "failed") {
      findings.push(finding({
        severity: "medium",
        code: "bluetooth/failed",
        title: "Bluetooth service is in a failed state",
        detail: `The Bluetooth service failed to start, even though the controller (${ctrls[0]}) is present. Bluetooth will not work until this is fixed.`,
        evidence: "systemctl is-failed bluetooth → failed",
        fix: `See why it failed with \`${svcCmd(ctx.dist, "status", "bluetooth")}\` and \`${svcLogs(ctx.dist, "bluetooth")}\`, then fix the cause and restart it with \`${svcCmd(ctx.dist, "restart", "bluetooth")}\`.`,
        confidence: "high",
      }));
      return findings;
    }

    if (!(daemon.ok && daemon.stdout.trim() !== "")) {
      findings.push(finding({
        severity: "medium",
        code: "bluetooth/stopped",
        title: "Bluetooth service is not running",
        detail: `A Bluetooth controller (${ctrls[0]}) is present, but the bluetoothd daemon is not running, so Bluetooth devices cannot connect.`,
        evidence: "controller: " + ctrls[0] + "\nbluetoothd: not running",
        fix: `Start it with \`${svcCmd(ctx.dist, "enable-now", "bluetooth")}\`.`,
        confidence: "high",
      }));
      return findings;
    }

    findings.push(finding({
      severity: "info",
      code: "bluetooth/ok",
      title: "Bluetooth is working",
      detail: `The Bluetooth service is running and the controller (${ctrls.join(", ")}) is available.`,
      evidence: "controller: " + ctrls.join(", ") + "\nbluetoothd: running",
      fix: null,
      confidence: "high",
    }));
    return findings;
  },
});
