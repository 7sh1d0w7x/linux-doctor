// SPDX-License-Identifier: GPL-3.0-or-later
import { lines } from "../utils.js";
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";

/**
 * WiFi health — the #1 "it doesn't work after install" on r/linux4noobs.
 * Checks rfkill (soft/hard block), NetworkManager wifi state, and whether
 * any wireless adapter is even present (lspci). Desktop/laptop only.
 */
export const wifi = defineCheck({
  id: "wifi",
  title: "WiFi",
  category: "network",
  appliesTo: ["desktop", "laptop"],
  async run(ctx) {
    const findings = [];

    const [rfkillRes, nmRes, lspciRes] = await Promise.all([
      ctx.run("rfkill list wifi 2>/dev/null; rfkill list wlan 2>/dev/null"),
      ctx.run("nmcli radio wifi 2>/dev/null; nmcli device status 2>/dev/null | grep -i wifi"),
      ctx.run("lspci -nn 2>/dev/null | grep -iE 'network|wireless|wlan'"),
    ]);

    const rfkillOut = (rfkillRes.stdout || "").toLowerCase();
    const softBlocked = /soft blocked:\s*yes/.test(rfkillOut);
    const hardBlocked = /hard blocked:\s*yes/.test(rfkillOut);

    const nmOut = (nmRes.stdout || "").toLowerCase();
    const nmDisabled = /disabled/.test(nmOut);

    const hasAdapter = lspciRes.ok && lspciRes.stdout.trim() !== "";
    const hasWifiDevice = /wifi/.test(nmOut);

    // No wireless hardware at all — info, not a fault (many desktops)
    if (!hasAdapter && !hasWifiDevice && !rfkillOut.trim()) {
      findings.push(finding({
        severity: "info",
        code: "wifi/no-adapter",
        title: "No WiFi adapter detected",
        detail: "No wireless network adapter was found. This is normal on desktops without WiFi hardware — the WiFi check does not apply.",
        evidence: "lspci: no wireless adapter · rfkill: no device",
        fix: null,
        confidence: "high",
      }));
      return findings;
    }

    if (hardBlocked) {
      findings.push(finding({
        severity: "medium",
        code: "wifi/blocked",
        title: "WiFi is hard-blocked (physical switch or BIOS)",
        detail: "The wireless adapter is hard-blocked — a physical switch, keyboard toggle (Fn+F2 etc.), or BIOS setting is disabling it. Software cannot override a hard block.",
        evidence: lines(rfkillRes.stdout).filter((l) => /blocked/i.test(l)).slice(0, 3).join("\n") || "rfkill: hard blocked: yes",
        fix: "Check the physical WiFi switch on the laptop, try `Fn+F2` (or your laptop's WiFi key), and check BIOS for a wireless toggle. Then run `rfkill unblock wifi`.",
        confidence: "high",
      }));
      return findings;
    }

    if (softBlocked) {
      findings.push(finding({
        severity: "medium",
        code: "wifi/blocked",
        title: "WiFi is soft-blocked",
        detail: "The wireless adapter is soft-blocked (disabled in software). WiFi will not scan or connect until it is unblocked.",
        evidence: lines(rfkillRes.stdout).filter((l) => /blocked/i.test(l)).slice(0, 3).join("\n") || "rfkill: soft blocked: yes",
        fix: "Unblock it with `rfkill unblock wifi` and `nmcli radio wifi on`, then re-check.",
        confidence: "high",
      }));
      return findings;
    }

    if (nmDisabled) {
      findings.push(finding({
        severity: "medium",
        code: "wifi/disabled",
        title: "WiFi is disabled in NetworkManager",
        detail: "NetworkManager reports WiFi as disabled, so no networks are scanned even though the adapter is present and unblocked.",
        evidence: nmRes.stdout.trim().split("\n")[0] || "nmcli radio wifi: disabled",
        fix: "Enable it with `nmcli radio wifi on` or via your desktop's network settings.",
        confidence: "high",
      }));
      return findings;
    }

    // Repeated deauthentications: the adapter is fine and unblocked, but the
    // link keeps dropping. Kernel and wpa_supplicant both record it; counting
    // both is the only way to see it on drivers that log in either place.
    if (hasAdapter || hasWifiDevice) {
      const [kDeauth, wDeauth] = await Promise.all([
        ctx.run('journalctl -k --since "24 hours ago" --no-pager 2>/dev/null | grep -icE "deauthenticat|disassociat"'),
        ctx.run('journalctl -u wpa_supplicant --since "24 hours ago" --no-pager 2>/dev/null | grep -icE "deauthenticat|disassociated|CTRL-EVENT-DISCONNECTED"'),
      ]);
      const kernelHits = Number(String(kDeauth.stdout || "").trim()) || 0;
      const wpaHits = Number(String(wDeauth.stdout || "").trim()) || 0;
      const total = kernelHits + wpaHits;
      const limit = ctx.thresholds.wifiDeauthCount ?? 10;
      if ((kDeauth.ok || wDeauth.ok) && total >= limit) {
        findings.push(finding({
          severity: "medium",
          code: "wifi/deauth",
          title: `WiFi disconnected ${total} times in 24 hours`,
          detail: "The adapter is present and not blocked, but the link keeps dropping: the kernel or wpa_supplicant recorded repeated deauthentications. Weak signal, aggressive power saving, a roaming conflict with another access point, or a driver problem all look like this from the log.",
          evidence: `deauth events in 24h: ${total} (kernel ${kernelHits}, wpa_supplicant ${wpaHits})`,
          fix: "Check the signal where it drops (`iw dev <iface> link`), then try disabling power saving for a day (`sudo iw dev <iface> set power_save off`). If only one network drops and others do not, it is the access point, not the card.",
          confidence: "medium",
        }));
        return findings;
      }
    }

    // WiFi looks healthy (adapter present, not blocked, NM enabled)
    if (hasAdapter || hasWifiDevice) {
      findings.push(finding({
        severity: "info",
        code: "wifi/ok",
        title: "WiFi is enabled",
        detail: "A wireless adapter is present, not blocked, and NetworkManager reports WiFi as enabled.",
        evidence: hasAdapter ? lspciRes.stdout.trim().split("\n")[0] : "nmcli: wifi enabled",
        fix: null,
        confidence: "high",
      }));
    }

    return findings;
  },
});
