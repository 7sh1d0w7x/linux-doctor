#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Build script for the Linux Doctor dashboard.
 *
 * Concatenates src-gui/css/*.css and src-gui/js/*.js into a single
 * index.html. The output is what web.js, Tauri, and --html all consume.
 *
 * ORDER MATTERS: the JS files share one <script> scope. Function
 * declarations are hoisted across the whole script, but top-level
 * let/const are not — so every module that declares load-time state
 * must come before init.js (the entry point), and dom.js (shared
 * helpers + report state) must come first.
 *
 * Usage:  npm run build:gui
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src-gui");
const OUT = join(SRC, "index.html");

const CSS_ORDER = [
  "base.css",        // variables, reset, typography
  "layout.css",      // header, status hero, toolbar, groups, footer
  "cards.css",       // finding cards, evidence, fix
  "components.css",  // toast, thresholds, history, charts, start-here
  "responsive.css",  // mobile breakpoints
  "wide.css",        // ≥1200px: fluid desktop shell (uncapped, dense hero)
  "print.css",       // print styles
];

const JS_ORDER = [
  "dom.js",            // $, esc + shared report state — MUST be first
  "state.js",          // shared constants (SEV, POLL_MS, …)
  "api.js",            // fetchReport/History/Checks, STATIC_DATA flag
  "clipboard.js",      // copyText
  "ui-toast.js",
  "ui-modal.js",       // shared modal shell (checks matrix, help)
  "ui-theme.js",
  "ui-keyboard.js",
  "ui-filters.js",     // activeFilter state + filter/search logic
  "ui-polling.js",     // pollTimer, autoRefresh state
  "ui-notify.js",
  "ui-schedule.js",    // daily-check strip (read-only schedule state)
  "ui-thresholds.js",
  "ui-history.js",     // statusTimer + trend rendering
  "ui-sidebar.js",     // overview sidebar: breakdown bars + nav counts
  "ui-views.js",       // Overview / History / Checks app views
  "ui-wide.js",        // wide-desktop mode (>=1200px): html.wide + open groups
  "ui-detailpane.js",  // wide master-detail: findings list + pinned detail pane
  "ui-checks.js",      // all-checks matrix modal + jump-to-finding
  "export.js",
  "render-charts.js",
  "render-findings.js",
  "render-sections.js",
  "render-status.js",
  "ui-system.js",      // System view (machine facts from the payload)
  "render.js",         // render orchestrator
  "init.js",           // entry point (runs at load) — MUST be last
];

function readOrdered(dir, order, ext) {
  const onDisk = readdirSync(dir).filter((f) => f.endsWith(ext));
  const unknown = onDisk.filter((f) => !order.includes(f));
  if (unknown.length) {
    throw new Error(`Unlisted ${ext} file(s) in ${dir}: ${unknown.join(", ")}\nAdd them to the order array in scripts/build-gui.mjs.`);
  }
  const missing = order.filter((f) => !onDisk.includes(f));
  if (missing.length) {
    throw new Error(`Listed ${ext} file(s) missing from ${dir}: ${missing.join(", ")}`);
  }
  return order.map((f) => `/* ── ${f} ── */\n` + readFileSync(join(dir, f), "utf8")).join("\n\n");
}

const css = readOrdered(join(SRC, "css"), CSS_ORDER, ".css");
const js = readOrdered(join(SRC, "js"), JS_ORDER, ".js");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#080a11">
<title>Linux Doctor</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M2 13h4l2.5-7 4 12 3-8 1.5 3H22' fill='none' stroke='%233ee29a' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<style>
${css}
</style>
</head>
<body>
<a class="skip-link" href="#report">Skip to findings</a>
<div class="wrap">
  <header>
    <a id="brand" class="brand" href="#overview" aria-label="Linux Doctor — go to Overview">
      <span class="logo" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M2 13h4l2.5-7 4 12 3-8 1.5 3H22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      <h1>Linux Doctor</h1>
    </a>
    <div>
      <div class="sysinfo" id="sysinfo" role="status">Loading…</div>
    </div>
    <div class="actions">
      <button id="notifybtn" title="Enable desktop notifications when health degrades" aria-label="Enable desktop notifications when health degrades"><span class="ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="15" height="15"><path d="M12 3a6 6 0 0 0-6 6v3.5L4.5 16h15L18 12.5V9a6 6 0 0 0-6-6Zm-2 15a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="fb">🔔</span></span></button>
      <button id="theme" title="Toggle theme" aria-label="Toggle theme"><span class="ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg><span class="fb">🌓</span></span></button>
      <div class="dropdown" id="export-dropdown">
        <button id="export-trigger" class="toolbtn" aria-haspopup="true" aria-expanded="false" aria-controls="export-menu" title="Export report">Export ▾</button>
        <div class="dropdown-menu" id="export-menu" role="menu">
          <button class="dropdown-item" id="export" role="menuitem" title="Copy the report as Markdown (scrubbed)">📝 Copy as Markdown</button>
          <button class="dropdown-item" id="export-md-file" role="menuitem" title="Save scrubbed Markdown to file">💾 Save as Markdown file</button>
          <button class="dropdown-item" id="copyjson" role="menuitem" title="Copy the raw JSON report">{ } Copy JSON</button>
          <button class="dropdown-item" id="pdfbtn" role="menuitem" title="Export as PDF (print)">🖨 Save as PDF</button>
        </div>
      </div>
      <button id="helpbtn" title="Keyboard shortcuts (press ?)" aria-label="Keyboard shortcuts"><span class="ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/><text x="12" y="16.5" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">?</text></svg><span class="fb">❓</span></span></button>
      <button id="rerun" class="primary">↻ Re-run checks</button>
    </div>
  </header>
  <div id="status" class="status running" aria-live="polite" role="status">
    <span class="spinner" aria-hidden="true"></span>Reading your system…
  </div>
  <div class="layout">
    <aside id="sidebar" class="sidebar" hidden aria-label="Report overview">
      <section class="sb-block sb-views">
        <h2>Views</h2>
        <nav id="viewtabs" class="viewtabs" role="tablist" aria-label="Views">
          <button class="viewtab active" role="tab" aria-selected="true" data-view="overview"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="3" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="3" y="13" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="13" y="13" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>Overview</button>
          <button class="viewtab" role="tab" aria-selected="false" data-view="history" tabindex="-1"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M3 20h18M5 16l4-5 3 3 4-6 3 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>History <span class="tabbadge" id="tabbadge-history" hidden></span></button>
          <button class="viewtab" role="tab" aria-selected="false" data-view="checks" tabindex="-1"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 6l1.5 1.5L8 5m4 1h8M4 12l1.5 1.5L8 11m4 1h8M4 18l1.5 1.5L8 17m4 1h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Checks <span class="tabbadge" id="tabbadge-checks" hidden></span></button>
          <button class="viewtab" role="tab" aria-selected="false" data-view="system" tabindex="-1"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>System</button>
          <button class="viewtab" role="tab" aria-selected="false" data-view="schedule" tabindex="-1"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3.5 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Schedule</button>
        </nav>
      </section>
      <section class="sb-block">
        <h2>Why this score</h2>
        <div id="sb-breakdown"></div>
      </section>
      <section class="sb-block">
        <h2>Severity</h2>
        <nav id="sb-sevnav" class="sb-nav"></nav>
      </section>
      <section class="sb-block">
        <h2>Categories</h2>
        <nav id="sb-catnav" class="sb-nav"></nav>
      </section>
    </aside>
    <div class="maincol">
    <div id="view-overview" class="view" role="tabpanel" aria-label="Overview">
      <div class="toolbar" role="toolbar" aria-label="Report controls">
        <div class="seg" role="group" aria-label="Group findings by">
          <button class="segbtn active" data-groupby="severity">Severity</button>
          <button class="segbtn" data-groupby="category">Category</button>
        </div>
        <div class="filters" id="filters" role="group" aria-label="Severity filter"></div>
        <input id="search" type="search" placeholder="Filter findings…  (code:disk/full)" autocomplete="off" spellcheck="false" aria-label="Filter findings — prefix with code: to filter by stable code">
    <button id="autorefresh" class="toolbtn on" title="Auto-refresh every 5s">Auto</button>
    <button id="expandall" class="toolbtn">Expand all</button>
    <button id="densitybtn" class="toolbtn" title="Toggle compact density" aria-pressed="false">Density</button>
    <button id="checksmatrixbtn" class="toolbtn" title="See every check and its result">Checks</button>
        <button id="clearbtn" class="toolbtn" type="button" disabled>Clear</button>
        <button id="threshbtn" class="toolbtn" title="Edit thresholds" aria-label="Edit thresholds"><svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="15" cy="6" r="2.6" fill="currentColor"/><circle cx="8" cy="12" r="2.6" fill="currentColor"/><circle cx="17" cy="18" r="2.6" fill="currentColor"/></svg></button>
      </div>
      <div id="threshpanel" class="thresh-panel" hidden>
        <div class="thresh-head">Thresholds <span class="thresh-sub">— tune when to flag</span> <button id="threshclose" class="toolbtn" style="margin-left:auto; padding:2px 8px;" aria-label="Close">×</button></div>
        <div id="threshbody" class="thresh-body"></div>
        <div class="thresh-actions">
          <button id="threshsave" class="primary" style="padding:6px 12px; font-size:12px;">Save</button>
          <button id="threshcopy" class="toolbtn">Copy JSON</button>
          <span id="threshmsg" style="font-size:11px; color:var(--muted); margin-left:8px;"></span>
        </div>
      </div>
      <main class="content">
        <div id="nexthep" hidden></div>
        <div id="notices" hidden>
          <div id="schedstrip" class="sched" hidden></div>
          <div id="security-posture" hidden></div>
        </div>
        <div class="reportgrid">
          <div id="drillhint" class="empty" hidden></div>
          <div id="report"><div class="empty">Reading your system…</div></div>
          <div id="nomatch" class="empty" hidden></div>
          <aside id="detailpane" class="detailpane" hidden aria-live="polite" aria-label="Finding detail"></aside>
        </div>
        <details id="fixed" class="group" hidden>
          <summary>Fixed since last check · <b id="fixed-count"></b><span class="chev">▸</span></summary>
          <div class="group-body" id="fixed-body"></div>
        </details>
        <details id="skipped" class="group" hidden>
          <summary>Skipped checks <b id="skipped-count"></b><span class="chev">▸</span></summary>
          <div class="group-body" id="skipped-body"></div>
        </details>
        <details id="checkerrors" class="group" hidden>
          <summary>Failed checks · <b id="checkerrors-count"></b><span class="chev">▸</span></summary>
          <div class="group-body" id="checkerrors-body"></div>
        </details>
        <details id="diff" class="group" hidden>
          <summary>Changes since last run · <b id="diff-count"></b> <span class="diff-sub">new vs fixed</span><span class="chev">▸</span></summary>
          <div class="group-body" id="diff-body"></div>
        </details>
      </main>
    </div>
  <div id="view-history" class="view" role="tabpanel" aria-label="History" hidden>
  <section id="history" class="history" hidden>
    <details class="hist-details">
      <summary class="hist-summary">History <span class="hist-sub">score &amp; findings across recent runs</span><span class="chev">▸</span></summary>
      <div id="trend"></div>
      <div id="runledger"></div>
    </details>
  </section>
  </div>
  <div id="view-checks" class="view" role="tabpanel" aria-label="All checks" hidden>
    <div id="checksview"></div>
  </div>
  <div id="view-system" class="view" role="tabpanel" aria-label="System" hidden>
    <div id="systemview"></div>
  </div>
  <div id="view-schedule" class="view" role="tabpanel" aria-label="Schedule" hidden>
    <div id="schedview"></div>
  </div>
    </div>
  </div>
  <footer>
    <span id="sbar-view" class="sbar-view">Overview</span>
    <span id="sbar-check" class="sbar-check" hidden></span>
    <span class="sbar-note">Linux Doctor only reads system information — it never modifies anything.</span>
    <span class="sbar-hints"><kbd>↑</kbd> <kbd>↓</kbd> navigate · <kbd>Enter</kbd> open/close · <kbd>/</kbd> search · <kbd>1</kbd>–<kbd>5</kbd> views · <kbd>Esc</kbd> clear</span>
  </footer>
</div>
<div id="toast-wrap" aria-live="polite" aria-atomic="true"></div>
<div id="modal" class="modal" hidden role="dialog" aria-modal="true" aria-label="Details">
  <div class="modal-card">
    <button id="modal-x" class="modal-x" title="Close (Esc)" aria-label="Close">×</button>
    <div id="modal-body"></div>
  </div>
</div>
<script>
${js}
</script>
</body>
</html>
`;

writeFileSync(OUT, html);
console.log(`✓ Built src-gui/index.html (${html.length} bytes, ${html.split("\n").length} lines)`);
