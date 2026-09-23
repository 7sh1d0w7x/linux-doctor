// SPDX-License-Identifier: GPL-3.0-or-later
/* === Central state store === */
const SEV = { high: { label: "High", cls: "high" }, medium: { label: "Medium", cls: "medium" }, info: { label: "Info", cls: "info" } };

/* Severity markers as inline SVG (theme-colored via CSS), not emoji —
   identical rendering everywhere, no font dependency, crisp at any scale.
   Inside filter pills they inherit currentColor so active states invert. */
/* Severity markers as pure CSS dots — no glyphs, no SVG, nothing that can
   render as a missing-glyph box in any WebView/font stack. */
const SEV_ICONS = {
  high: '<span class="sev-dot high"></span>',
  medium: '<span class="sev-dot medium"></span>',
  info: '<span class="sev-dot info"></span>',
};
const ICON_ALL = '<span class="sev-dot all"></span>';

const SEV_ORDER = ["high", "medium", "info"];

/* Category icons — small stroke SVGs, each with its own accent color so the
   sidebar, matrix and category groups are scannable at a glance. */
const CAT_ICONS = {
  system:   { c: "#5eb1ff", d: "M3 6h18M3 12h18M3 18h18M7 4v4M15 10v4M9 16v4" },
  software: { c: "#c08bff", d: "M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3Zm0 0v9m8-4.5L12 12 4 7.5" },
  security: { c: "#3ee29a", d: "M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3Zm-2.5 9l2 2 3.5-4" },
  network:  { c: "#74acff", d: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-9 9h18M12 3c-5 5.5-5 12.5 0 18 5-5.5 5-12.5 0-18Z" },
  updates:  { c: "#ffce5a", d: "M20 12a8 8 0 1 1-2.3-5.6M20 3v4h-4" },
  hardware: { c: "#ff9d66", d: "M8 8h8v8H8V8Zm-3 3H3m18 0h-2M11 5V3m2 18v-2M5 11H3m18 0h-2M11 19v2m2-18v2M8.5 3.5v1m7-1v1m-7 15v1m7-1v1M3.5 8.5h1m-1 7h1m15-7h1m-1 7h1" },
  data:     { c: "#4dd0e1", d: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" },
  other:    { c: "#8a93a6", d: "M12 4v16M4 12h16" },
};
function catIcon(cat, size) {
  const s = size || 13;
  const ic = CAT_ICONS[cat] || CAT_ICONS.other;
  return '<svg class="cat-ic" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="' + ic.d + '" fill="none" stroke="' + ic.c + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}
const SEV_NAMES = { high: "High severity", medium: "Medium severity", info: "Informational" };
const THEME_ORDER = ["light", "dark", "terminal", "auto"];
const POLL_MS = 5000;
/* Category grouping: known check categories in display order; anything
   unmapped (plugins, older payloads) lands under "other". */
const CATEGORY_ORDER = ["system", "software", "security", "network", "updates", "hardware", "data", "other"];
const CATEGORY_LABELS = {
  system: "System", software: "Software", security: "Security",
  network: "Network", updates: "Updates", hardware: "Hardware",
  data: "Data", other: "Other",
};
/* Security posture: the checks that together describe the machine's
   security hygiene. Shown as a dedicated "Security posture" grouping in the
   report and sidebar — presentation grouping, not a new check. */
const SECURITY_POSTURE_CHECKS = ["security", "ssh", "autologin", "secureboot", "luks"];
function isSecurityPosture(checkId) { return SECURITY_POSTURE_CHECKS.includes(checkId); }
function securityPostureFindings(findings) {
  return (findings || []).filter((f) => isSecurityPosture(f.check));
}
/* How findings are grouped in the report: "severity" | "category". */
let groupBy = "severity";
/* check id → category, filled from /api/checks before the first render. */
let checksCategoryMap = new Map();
