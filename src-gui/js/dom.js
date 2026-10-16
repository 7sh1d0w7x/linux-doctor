// SPDX-License-Identifier: GPL-3.0-or-later
/* === DOM helpers === */
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/* Fix strings quote commands in backticks. The interface shows them as code,
   not as backticks — and a stray one after a slice never reaches the screen. */
function cmdCode(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/`/g, "");
}
/* JS smooth-scrolls bypass the CSS reduced-motion guard, so gate the behavior here. */
function prefersReducedMotion() {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}
const scrollBehavior = () => (prefersReducedMotion() ? "auto" : "smooth");
let lastReportData = null;
let lastData = null;
