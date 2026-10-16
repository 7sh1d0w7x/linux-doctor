// SPDX-License-Identifier: GPL-3.0-or-later
import { lines } from "../utils.js";
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";
import { svcCmd } from "../distro.js";

/**
 * SSH server posture. Read-only: greps sshd_config (and conf.d drop-ins),
 * which is safe without root — unlike `sshd -T`. Last match wins, mirroring
 * how sshd actually merges drop-ins.
 */

export const ssh = defineCheck({
  id: "ssh",
  title: "SSH server configuration",
  category: "security",
  async run(ctx) {
    const findings = [];

    const active = await ctx.run("systemctl is-active sshd 2>/dev/null");
    const sshdRunning = active.ok && active.stdout.trim() === "active";
    if (!sshdRunning) {
      const installed = await ctx.run("command -v sshd 2>/dev/null");
      if (!installed.ok) return findings;
    }

    const cfg = await ctx.run("grep -rhE '^\\s*(PermitRootLogin|PasswordAuthentication)\\s+' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/ 2>/dev/null");
    const cfgLines = lines(cfg.stdout);
    const get = (key) => {
      const vals = cfgLines.filter((l) => new RegExp(`^\\s*${key}\\s`).test(l)).map((l) => l.trim().split(/\s+/)[1]);
      return vals.length ? vals[vals.length - 1].toLowerCase() : null;
    };

    // OpenSSH defaults: root login key-only, password auth on.
    const rootLogin = get("PermitRootLogin") ?? "prohibit-password";
    const pwAuth = get("PasswordAuthentication") ?? "yes";

    if (rootLogin === "yes" && pwAuth === "yes") {
      findings.push(finding({
        severity: "high",
        code: "ssh/root-password",
        title: "SSH allows root login with a password",
        detail: "The SSH server permits direct root logins with password authentication, so a brute-force attack on port 22 can target root itself.",
        evidence: cfg.stdout.trim() || "defaults (PermitRootLogin yes, PasswordAuthentication yes)",
        fix: `In /etc/ssh/sshd_config (or a drop-in in sshd_config.d) set \`PermitRootLogin no\` (or \`prohibit-password\` to keep key-only root logins), then \`${svcCmd(ctx.dist, "restart", "sshd")}\`.`,
        confidence: "high",
      }));
    } else if (rootLogin === "yes") {
      findings.push(finding({
        severity: "medium",
        code: "ssh/root-login",
        title: "SSH allows direct root login",
        detail: "Direct root logins over SSH are allowed. Key-only root access is safer — a leaked password then cannot log in as root.",
        evidence: cfg.stdout.trim() || "defaults",
        fix: `Set \`PermitRootLogin prohibit-password\` (SSH keys still work) in /etc/ssh/sshd_config, then \`${svcCmd(ctx.dist, "restart", "sshd")}\`.`,
        confidence: "high",
      }));
    } else {
      findings.push(finding({
        severity: "info",
        code: "ssh/ok",
        title: "SSH server is configured reasonably",
        detail: "Root login over SSH is restricted" + (pwAuth === "yes" ? ", and password authentication stays available for normal users." : " and password authentication is off."),
        evidence: cfg.stdout.trim() || "defaults",
        fix: null,
        confidence: "medium",
      }));
    }
    return findings;
  },
});