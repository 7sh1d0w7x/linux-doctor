// SPDX-License-Identifier: GPL-3.0-or-later
import { lines, plural, shq } from "../utils.js";
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";
import { pkgInstall, svcCmd } from "../distro.js";

/**
 * TLS certificate expiry: the classic silent outage. ACME automation works
 * almost all the time — the cases where it doesn't (a renewal that quietly
 * failed after a DNS change, a service still serving the old cert) are the
 * ones that page you at 3am.
 *
 * Two read-only sources, both via openssl (no root needed):
 *  - on-disk certbot state: /etc/letsencrypt/live/<domain>/cert.pem
 *  - the actually-deployed cert: s_client against locally-listening TLS
 *    ports (443, 8443), which catches "renewed on disk but never reloaded".
 * A missing openssl binary means silence, not health.
 */

const TLS_PORTS = [443, 8443];

function daysLeft(notAfter, nowMs) {
  const end = Date.parse(String(notAfter || "").replace(/^notAfter=/, "").trim());
  if (!Number.isFinite(end)) return null;
  return Math.floor((end - nowMs) / 86400000);
}

export const certs = defineCheck({
  id: "certs",
  title: "TLS certificate expiry",
  category: "security",
  appliesTo: ["server"],
  async run(ctx) {
    const findings = [];
    const warnDays = ctx.thresholds.certWarnDays ?? 30;
    const critDays = ctx.thresholds.certCritDays ?? 7;
    const nowMs = Date.now();

    const openssl = await ctx.run("command -v openssl 2>/dev/null");
    if (!openssl.ok || !openssl.stdout.trim()) {
      findings.push(finding({
        severity: "info",
        code: "certs/skipped",
        title: "Certificate check skipped",
        detail: "`openssl` is not available on this system, so certificate expiry could not be checked.",
        evidence: "openssl: not found",
        fix: `Install openssl (${pkgInstall(ctx.dist, { fedora: "openssl", "*": "openssl" })}) and re-run.`,
        confidence: "high",
      }));
      return findings;
    }

    const found = []; // { name, days }

    // --- on-disk certbot certs ---
    const live = await ctx.run("for d in /etc/letsencrypt/live/*/cert.pem; do [ -f \"$d\" ] && echo \"$d\"; done 2>/dev/null");
    if (live.ok) {
      for (const p of lines(live.stdout)) {
        const end = await ctx.run(`openssl x509 -in ${shq(p)} -noout -enddate 2>/dev/null`);
        if (!end.ok) continue;
        const d = daysLeft(end.stdout, nowMs);
        if (d === null) continue;
        const name = p.split("/").slice(-2, -1)[0] || p;
        found.push({ name, days: d, where: "certbot" });
      }
    }

    // --- actually-deployed certs on locally-listening TLS ports ---
    const ss = await ctx.run("ss -tlnH 2>/dev/null");
    if (ss.ok) {
      const listening = new Set();
      for (const l of lines(ss.stdout)) {
        const local = l.split(/\s+/)[3] || "";
        const port = Number(local.slice(local.lastIndexOf(":") + 1));
        if (TLS_PORTS.includes(port)) listening.add(port);
      }
      for (const port of [...listening].sort((a, b) => a - b)) {
        // -servername sends SNI so multi-cert hosts answer correctly; the
        // echo pipe closes stdin so s_client can't hang waiting on a TTY.
        const probe = await ctx.run(
          `echo | openssl s_client -connect 127.0.0.1:${shq(String(port))} -servername localhost 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null`,
          { timeoutMs: 5000 }
        );
        if (!probe.ok) continue;
        const d = daysLeft(probe.stdout, nowMs);
        if (d === null) continue;
        found.push({ name: `localhost:${port}`, days: d, where: "live" });
      }
    }

    if (found.length === 0) return findings;

    const expired = found.filter((c) => c.days < 0);
    const critical = found.filter((c) => c.days >= 0 && c.days <= critDays);
    const expiring = found.filter((c) => c.days > critDays && c.days <= warnDays);
    const fmt = (c) => `${c.name} (${c.days < 0 ? `expired ${-c.days}d ago` : `${c.days}d left`})`;

    if (expired.length > 0 || critical.length > 0) {
      const bad = [...expired, ...critical];
      findings.push(finding({
        severity: "high",
        code: "certs/critical",
        title: `${plural(bad.length, "TLS certificate")} expiring or expired`,
        detail: `These certificates are expired or expire within ${critDays} days: ${bad.map(fmt).join(", ")}. An expired certificate takes the service behind it offline for every browser and API client — this is a leading cause of "it worked yesterday" outages.`,
        evidence: bad.map((c) => `${c.name}\t${c.days}d\t${c.where}`).join("\n"),
        fix: `Renew now (\`sudo certbot renew --force-renewal\`), then reload the service serving the cert (\`${svcCmd(ctx.dist, "reload", "nginx")}\` / \`${svcCmd(ctx.dist, "reload", "apache2")}\` / your reverse proxy) so the new cert is actually deployed.`,
        confidence: "high",
      }));
    } else if (expiring.length > 0) {
      findings.push(finding({
        severity: "medium",
        code: "certs/expiring",
        title: `${plural(expiring.length, "TLS certificate")} expiring soon`,
        detail: `These certificates expire within ${warnDays} days: ${expiring.map(fmt).join(", ")}. Automatic renewal usually handles this — this finding means it hasn't yet, so verify before it becomes urgent.`,
        evidence: expiring.map((c) => `${c.name}\t${c.days}d\t${c.where}`).join("\n"),
        fix: "Test renewal without changing anything: `sudo certbot renew --dry-run`. If that fails, fix the reported error (often a DNS or port-80 challenge problem).",
        confidence: "high",
      }));
    } else {
      findings.push(finding({
        severity: "info",
        code: "certs/ok",
        title: "TLS certificates are healthy",
        detail: `${plural(found.length, "certificate")} checked, all with more than ${warnDays} days left.`,
        evidence: found.map((c) => `${c.name}\t${c.days}d`).join("\n"),
        fix: null,
        confidence: "high",
      }));
    }
    return findings;
  },
});
