// SPDX-License-Identifier: GPL-3.0-or-later
import { lines } from "../utils.js";
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";
import { detectFirewall } from "./shared.js";
import { pkgInstall, svcCmd } from "../distro.js";

/**
 * Risky services listening on non-loopback interfaces. A database that
 * answers on 0.0.0.0 is one missing firewall rule away from the public
 * internet — and the firewall is exactly what this cross-checks against,
 * using the same signals as the security check (firewalld, ufw, nftables).
 *
 * Deliberately a whitelist, not a blacklist: only well-known risky service
 * ports are flagged, so an intentionally-exposed web server stays quiet.
 * TCP only — the risky services below all speak TCP.
 */

const RISKY = {
  21: "FTP",
  23: "Telnet",
  3306: "MySQL",
  5432: "PostgreSQL",
  6379: "Redis",
  11211: "Memcached",
  27017: "MongoDB",
  9200: "Elasticsearch",
};

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export const ports = defineCheck({
  id: "ports",
  title: "Exposed network services",
  category: "security",
  appliesTo: ["server"],
  async run(ctx) {
    const findings = [];

    const ss = await ctx.run("ss -tlnH 2>/dev/null");
    if (ss.missing) {
      findings.push(finding({
        severity: "info",
        code: "ports/skipped",
        title: "Exposed-services check skipped",
        detail: "`ss` (iproute2) is not available on this system, so listening services could not be listed.",
        evidence: "ss: not found",
        fix: `Install iproute2 (${pkgInstall(ctx.dist, { fedora: "iproute", "*": "iproute2" })}) and re-run.`,
        confidence: "high",
      }));
      return findings;
    }
    if (!ss.ok) return findings;

    let listening = 0;
    const exposed = [];
    for (const l of lines(ss.stdout)) {
      const local = l.split(/\s+/)[3] || "";
      const cut = local.lastIndexOf(":");
      if (cut < 0) continue;
      const addr = local.slice(0, cut).replace(/^\[|\]$/g, "");
      const port = Number(local.slice(cut + 1));
      if (!Number.isFinite(port)) continue;
      listening += 1;
      if (RISKY[port] && !LOOPBACK.has(addr)) {
        exposed.push({ addr: addr === "0.0.0.0" || addr === "::" ? "all interfaces" : addr, port, svc: RISKY[port] });
      }
    }

    if (exposed.length === 0) {
      if (listening > 0) {
        findings.push(finding({
          severity: "info",
          code: "ports/ok",
          title: "No risky services exposed",
          detail: `${listening} listening TCP socket${listening > 1 ? "s" : ""} checked — none of the commonly-abused service ports is reachable from outside this machine.`,
          evidence: `${listening} listening sockets, 0 risky exposed`,
          fix: null,
          confidence: "high",
        }));
      }
      return findings;
    }

    const fw = await detectFirewall(ctx);

    if (fw.active) {
      findings.push(finding({
        severity: "info",
        code: "ports/ok",
        title: "Risky services are firewalled",
        detail: `These services listen on non-loopback interfaces but a firewall is active, so exposure is controlled: ${exposed.map((e) => `${e.svc} :${e.port}`).join(", ")}. Verify the firewall rules actually restrict them if this machine faces the internet.`,
        evidence: exposed.map((e) => `${e.svc}\t:${e.port}\t${e.addr}`).join("\n"),
        fix: null,
        confidence: "medium",
      }));
      return findings;
    }

    if (!fw.determined) {
      // Exposure is real, but the firewall cannot be read without root — do
      // not claim "no firewall" (that false negative also drove the ufw fix).
      findings.push(finding({
        severity: "medium",
        code: "ports/exposed-risky",
        title: `${exposed.length} risky service${exposed.length > 1 ? "s" : ""} exposed — firewall status unknown`,
        detail: `These services accept connections from outside this machine: ${exposed.map((e) => `${e.svc} on :${e.port} (${e.addr})`).join(", ")}. The firewall state could not be read without root, so exposure may or may not be restricted. Re-run with \`sudo linux-doctor\` to confirm.`,
        evidence: exposed.map((e) => `${e.svc}\t:${e.port}\t${e.addr}`).join("\n"),
        fix: "Bind each service to 127.0.0.1 in its own config, or re-run with `sudo linux-doctor` to verify the firewall rules.",
        confidence: "medium",
      }));
      return findings;
    }

    findings.push(finding({
      severity: "medium",
      code: "ports/exposed-risky",
      title: `${exposed.length} risky service${exposed.length > 1 ? "s" : ""} exposed with no firewall`,
      detail: `These services accept connections from outside this machine and no active firewall was detected: ${exposed.map((e) => `${e.svc} on :${e.port} (${e.addr})`).join(", ")}. Databases and plaintext protocols on a public interface are a routine entry point for automated attacks.`,
      evidence: exposed.map((e) => `${e.svc}\t:${e.port}\t${e.addr}`).join("\n"),
      fix: (ctx.dist?.init || "systemd") === "systemd"
        ? `Bind each service to 127.0.0.1 in its own config, or enable a firewall (\`${svcCmd(ctx.dist, "enable-now", "firewalld")}\`, \`sudo ufw enable\`) and allow only what you need.`
        : "Bind each service to 127.0.0.1 in its own config, or set up a firewall (`awall` on Alpine, `nftables` anywhere) and allow only what you need.",
      confidence: "medium",
    }));
    return findings;
  },
});
