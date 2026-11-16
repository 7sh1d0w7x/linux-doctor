// SPDX-License-Identifier: GPL-3.0-or-later
import { lines, plural } from "../utils.js";
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";
import { pkgInstall } from "../distro.js";

/**
 * Network connectivity: default route and DNS resolution. This is the #1
 * reason people reach for a diagnostic tool, and it was missing entirely.
 * Every command is bounded by ctx.run's timeout so a hung resolver or a
 * half-configured interface cannot stall the whole report.
 */

export const network = defineCheck({
  id: "network",
  title: "Network connectivity and DNS",
  category: "network",
  async run(ctx) {
    const findings = [];

    const [ipBin, addr, route] = await Promise.all([
      // `ip` missing is not "no route". run() only sets `missing` when the
      // spawn itself fails, and these commands go through a shell, so a missing
      // binary looked like an empty route table: minimal Debian, Fedora and
      // Ubuntu images ship without iproute2 and got a medium "No default
      // network route" on a machine with a perfectly good route.
      ctx.run("command -v ip 2>/dev/null"),
      ctx.run("ip -brief addr show 2>/dev/null"),
      ctx.run("ip route show default 2>/dev/null"),
    ]);
    if (!(ipBin.ok && ipBin.stdout.trim() !== "")) {
      findings.push(finding({
        severity: "info",
        code: "network/skipped",
        title: "Network check skipped",
        detail: "`ip` (iproute2) is not available on this system, so network connectivity could not be checked.",
        evidence: "ip: not found",
        fix: `Install iproute2 (${pkgInstall(ctx.dist, { fedora: "iproute", "*": "iproute2" })}) and re-run.`,
        confidence: "high",
      }));
      return findings;
    }

    const interfaces = lines(addr.stdout).filter((l) => / UP /.test(l));
    const ifaceNames = interfaces.length ? interfaces.map((l) => l.split(/\s+/)[0]).join(", ") : "none";

    if (!route.ok || route.stdout.trim() === "") {
      findings.push(finding({
        severity: "medium",
        code: "network/no-route",
        title: "No default network route",
        detail:
          "The system has no default gateway, so it cannot reach the internet. " +
          (interfaces.length
            ? `Active ${plural(interfaces.length, "interface")}: ${ifaceNames}.`
            : "No network interface is up."),
        evidence: `interfaces: ${ifaceNames}\nroute: none`,
        fix: interfaces.length
          ? `Reconnect to your network, e.g. \`nmcli device connect ${interfaces[0].split(/\s+/)[0]}\` (NetworkManager), or check your router/wifi.`
          : "Bring an interface up: `nmcli device status` to see what is available, then `nmcli device connect <iface>`.",
        confidence: "medium",
      }));
      return findings;
    }

    // DNS is only meaningful when there is a route. Time the resolution to
    // catch slow resolvers — the most common "net is slow" complaint.
    const t0 = Date.now();
    // 2>&1 (not 2>/dev/null): a missing `getent` (musl/minimal images) prints
    // "not found", which must be a skip, not a false "DNS is failing".
    const dns = await ctx.run("getent ahostsv4 kernel.org 2>&1 | head -1");
    const dnsMs = Date.now() - t0;
    if (/not found|no such file/i.test(dns.stdout || "") || dns.missing) {
      findings.push(finding({
        severity: "info",
        code: "network/skipped",
        title: "DNS check skipped (getent not available)",
        detail: "`getent` is not installed on this system (common on musl/minimal images), so DNS resolution could not be tested.",
        evidence: "getent: not found",
        fix: null,
        confidence: "medium",
      }));
      return findings;
    }
    if (!dns.ok || dns.stdout.trim() === "") {
      findings.push(finding({
        severity: "medium",
        code: "network/dns",
        title: "DNS resolution is failing",
        detail:
          "There is a default route, but the system resolver could not look up kernel.org. " +
          "Web browsing and many services will not work.",
        evidence: "getent ahostsv4 kernel.org → no result",
        fix: "Check /etc/resolv.conf, re-apply your connection (`nmcli device reapply <iface>`), and if you use a VPN check its DNS settings.",
        confidence: "medium",
      }));
      return findings;
    }

    if (dnsMs > (ctx.thresholds.dnsSlowMs ?? 500)) {
      findings.push(finding({
        severity: "medium",
        code: "network/dns-slow",
        title: `DNS resolution is slow (${dnsMs}ms)` ,
        detail:
          `kernel.org resolved in ${dnsMs}ms — normal is under 100ms. ` +
          "Slow DNS makes every web request feel sluggish.",
        evidence: `getent ahostsv4 kernel.org → ${dns.stdout.trim().split("\n")[0]} (${dnsMs}ms)`,
        fix: "Check /etc/resolv.conf for slow or misconfigured nameservers. Consider switching to a faster resolver (e.g. 1.1.1.1 or 8.8.8.8).",
        confidence: "high",
      }));
    }

    // Netfilter conntrack: NAT/Docker/Kubernetes hosts drop new connections
    // when the table fills, and the kernel only says so once packets are being
    // dropped. The files do not exist unless the module is loaded, which is the
    // normal desktop case — absence is silence, not health.
    const [ctCount, ctMax] = await Promise.all([
      ctx.run("cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null"),
      ctx.run("cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null"),
    ]);
    const count = Number(String(ctCount.stdout || "").trim());
    const max = Number(String(ctMax.stdout || "").trim());
    if (ctCount.ok && ctMax.ok && Number.isFinite(count) && Number.isFinite(max) && max > 0) {
      const ratio = count / max;
      const pct = Math.round(ratio * 100);
      const high = ratio >= (ctx.thresholds.conntrackHighRatio ?? 0.95);
      if (high || ratio >= (ctx.thresholds.conntrackWarnRatio ?? 0.8)) {
        findings.push(finding({
          severity: high ? "high" : "medium",
          code: "network/conntrack",
          title: `Connection tracking is ${pct}% full`,
          detail: `The netfilter conntrack table holds ${count.toLocaleString("en-US")} of ${max.toLocaleString("en-US")} entries. When it fills, the kernel drops new connections and logs "nf_conntrack: table full, dropping packet" — NAT, Docker and Kubernetes hosts reach it first because every forwarded connection takes a slot.`,
          evidence: `nf_conntrack_count=${count} / nf_conntrack_max=${max} (${pct}%)`,
          fix: `Raise the limit with \`sudo sysctl -w net.netfilter.nf_conntrack_max=${Math.max(max * 2, 262144)}\` and persist it in /etc/sysctl.d/. If the count keeps climbing, look for leaked connections: \`conntrack -S\` and \`ss -tan state established | wc -l\`.`,
          confidence: "high",
        }));
        return findings;
      }
    }

    findings.push(finding({
      severity: "info",
      code: "network/ok",
      title: "Network and DNS look healthy",
      detail: `There is a default route and the system resolver works (kernel.org resolved in ${dnsMs}ms).`,
      evidence: route.stdout.trim().split("\n")[0],
      fix: null,
      confidence: "high",
    }));
    return findings;
  },
});
