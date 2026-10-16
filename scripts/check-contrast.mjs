import { readFileSync } from "node:fs";
const css = readFileSync(new URL("../src-gui/css/base.css", import.meta.url), "utf8");

function themeVars(sel) {
  const i = css.indexOf(sel);
  if (i < 0) throw new Error("theme not found: " + sel);
  const block = css.slice(i, css.indexOf("}", i));
  const out = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2];
  return out;
}
const themes = {
  dark: themeVars(":root {"),
  light: themeVars(':root[data-theme="light"]'),
  terminal: themeVars(':root[data-theme="terminal"]'),
};

const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = lin(((n >> 16) & 255) / 255), g = lin(((n >> 8) & 255) / 255), b = lin((n & 255) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/* [foreground, background, minimum, what it is] */
const PAIRS = [
  ["text", "bg", 4.5, "body text on window"],
  ["text", "card", 4.5, "row text"],
  ["text", "bg2", 4.5, "text on chrome"],
  ["muted", "card", 4.5, "secondary text"],
  ["muted", "bg", 4.5, "secondary text on window"],
  ["muted", "bg2", 4.5, "secondary text on chrome"],
  ["muted2", "bg2", 3.0, "rail section labels"],
  ["muted2", "card", 3.0, "helper text"],
  ["muted2", "bg", 3.0, "status bar text"],
  ["accent", "card", 3.0, "accent on surface"],
  ["accent", "bg2", 3.0, "accent on chrome"],
  ["red", "card", 4.5, "high severity text"],
  ["red", "bg2", 4.5, "high severity in rail"],
  ["yellow", "card", 4.5, "medium severity text"],
  ["yellow", "bg2", 4.5, "medium severity in rail"],
  ["green", "card", 4.5, "fixed / positive text"],
  ["blue", "card", 4.5, "info text"],
  ["purple", "card", 4.5, "NEW badge text"],
];

const WHITE = "#ffffff";
let fails = 0;
for (const [name, v] of Object.entries(themes)) {
  console.log("\n=== " + name + " ===");
  for (const [fg, bg, min, what] of PAIRS) {
    if (!v[fg] || !v[bg]) continue;
    const r = ratio(v[fg], v[bg]);
    const ok = r >= min;
    if (!ok) fails++;
    console.log(
      (ok ? "  ok  " : "  FAIL") +
        " " + r.toFixed(2).padStart(5) + " (min " + min + ")  " + fg + " on " + bg + "  — " + what
    );
  }
  for (const [ink, fill, what] of [["on-accent", "accent", "primary button"], ["on-ok", "green", "recommended-action button"]]) {
    if (!v[ink] || !v[fill]) continue;
    const r = ratio(v[ink], v[fill]);
    const ok = r >= 4.5;
    if (!ok) fails++;
    console.log((ok ? "  ok  " : "  FAIL") + " " + r.toFixed(2).padStart(5) + " (min 4.5)  " + ink + " on " + fill + "  — " + what);
  }
}
console.log("\nfailures: " + fails);
