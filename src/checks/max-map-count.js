// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `vm.max_map_count`: the number of memory-map areas one process may have.
 * Distributions default it to 65530, which is fine for a desktop and too low
 * for some games under Proton/Wine — the failure is a crash with
 * "max_map_count too low" or a game that dies at startup with no useful message.
 *
 * Only reported on machines that actually show gaming: flagging every laptop
 * because a sysctl is at its distribution default would be noise, and the
 * number is irrelevant to anything that is not a Windows game.
 */
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";

const SYSCTL = "cat /proc/sys/vm/max_map_count 2>/dev/null";

// Any of these means games run here: Steam (native or Flatpak), Lutris, Heroic,
// or a Proton/Wine process right now.
const GAMING = [
  "command -v steam lutris heroic 2>/dev/null",
  "flatpak list --app 2>/dev/null | grep -icE 'steam|lutris|heroic|bottles'",
  "pgrep -c -f '[p]roton|[w]ine(64|server)?' 2>/dev/null",
];

export const maxMapCount = defineCheck({
  id: "max-map-count",
  title: "Memory-map limit (vm.max_map_count)",
  category: "performance",
  appliesTo: ["desktop", "laptop"],
  async run(ctx) {
    const res = await ctx.run(SYSCTL);
    const value = Number(String(res.stdout || "").trim());
    const wanted = ctx.thresholds.maxMapCount ?? 1048576;
    if (!res.ok || !Number.isFinite(value) || value <= 0) return [];
    if (value >= wanted) return [];

    const [bins, flatpak, procs] = await Promise.all(GAMING.map((cmd) => ctx.run(cmd)));
    const nativeBins = bins.ok ? bins.stdout.trim().split("\n").filter(Boolean) : [];
    const flatpakCount = Number(String(flatpak.stdout || "").trim()) || 0;
    const procCount = Number(String(procs.stdout || "").trim()) || 0;
    const gaming = nativeBins.length > 0 || flatpakCount > 0 || procCount > 0;
    if (!gaming) return [];

    const sources = [];
    if (nativeBins.length) sources.push(nativeBins.map((p) => p.split("/").pop()).join(", "));
    if (flatpakCount > 0) sources.push(`${flatpakCount} Flatpak game app(s)`);
    if (procCount > 0) sources.push(`${procCount} Proton/Wine process(es) running`);

    return [finding({
      severity: "medium",
      code: "max-map-count/low",
      title: `vm.max_map_count is ${value.toLocaleString("en-US")}`,
      detail: `Games running under Proton/Wine can need more memory-map areas than this. When the limit is reached the game crashes, often at startup and often without a message that mentions the limit. This machine shows gaming (${sources.join("; ")}), so the default is worth raising.`,
      evidence: `vm.max_map_count=${value} · ${sources.join(" · ")}`,
      fix: `Raise it for the current boot with \`sudo sysctl -w vm.max_map_count=${wanted}\`, and persist it: \`echo "vm.max_map_count=${wanted}" | sudo tee /etc/sysctl.d/99-max-map-count.conf\`. On an immutable distribution use the image's own mechanism or a systemd unit.`,
      confidence: "medium",
    })];
  },
});
