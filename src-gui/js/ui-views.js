// SPDX-License-Identifier: GPL-3.0-or-later
/* === App views: Overview / History / Checks ===
   One page was growing into a long scroll (hero, findings, fixed, skipped,
   history…). Views give every area a home without rewriting any renderer:
   Overview keeps today's report exactly as-is (the default, zero
   retraining); History hosts the trend section; Checks renders the
   all-checks matrix inline. Choice persists across sessions. */

const VIEWS = ["overview", "history", "checks", "system", "schedule"];
let activeView = "overview";
// Set when the URL supplied ?view= — setupViews() must then not clobber the
// deep link with the remembered view.
let urlViewApplied = false;

/* === URL state (deep-linkable desktop state) ===
   view / severity filter / group / theme / density travel in the query
   string, so a refresh or a bookmark restores the workbench. replaceState
   only — no history spam while typing.

   The free-text search is deliberately NOT written here: #search holds
   system-derived strings (hostnames, unit/container names, paths), and
   baking those into the browser history conflicts with the tool's
   local-only promise. ?q= is still READ (an explicitly crafted link can
   pre-filter), it is just never produced automatically. */
function syncUrlState() {
  try {
    if (typeof history === "undefined" || !history.replaceState) return;
    const p = new URLSearchParams();
    if (activeView !== "overview") p.set("view", activeView);
    if (typeof activeFilter !== "undefined" && activeFilter && activeFilter !== "all") p.set("sev", activeFilter);
    if (groupBy === "category") p.set("group", "category");
    const th = typeof currentTheme === "function" ? currentTheme() : "auto";
    if (th && th !== "auto") p.set("theme", th);
    if (document.body && !document.body.classList.contains("compact")) p.set("d", "cozy");
    const s = p.toString();
    history.replaceState(null, "", s ? "?" + s : location.pathname);
  } catch {}
}

function readUrlState() {
  try {
    if (typeof location === "undefined" || !location.search) return null;
    const p = new URLSearchParams(location.search);
    const out = {};
    const view = p.get("view");
    if (view && VIEWS.includes(view)) out.view = view;
    const sev = p.get("sev");
    if (sev && ["all", "high", "medium", "info"].includes(sev)) out.sev = sev;
    const q = p.get("q");
    if (q) out.q = q.slice(0, 200);
    const group = p.get("group");
    if (group === "severity" || group === "category") out.group = group;
    const theme = p.get("theme");
    if (theme && typeof THEME_ORDER !== "undefined" && THEME_ORDER.includes(theme)) out.theme = theme;
    const d = p.get("d");
    if (d === "cozy" || d === "compact") out.d = d;
    return out;
  } catch { return null; }
}

function applyUrlState() {
  const st = readUrlState();
  if (!st) return;
  if (st.view) {
    activeView = st.view;
    urlViewApplied = true;
    // Persist so the next plain load lands on the same view (URL wins and
    // sticks, matching how group/theme already behave).
    try { localStorage.setItem("ld-view", st.view); } catch {}
  }
  if (st.sev !== undefined && typeof activeFilter !== "undefined") activeFilter = st.sev;
  // Read-only: an explicit ?q= link pre-filters. syncUrlState never writes it.
  if (st.q) { const s = $("#search"); if (s) s.value = st.q; }
  if (st.group) {
    groupBy = st.group;
    try { localStorage.setItem("ld-groupby", st.group); } catch {}
    document.querySelectorAll(".segbtn").forEach((b) => {
      const on = b.dataset.groupby === st.group;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }
  if (st.theme) {
    try { localStorage.setItem("ld-theme", st.theme); } catch {}
    if (typeof applyTheme === "function") applyTheme();
  }
  if (st.d) {
    try { localStorage.setItem("ld-density", st.d === "cozy" ? "comfortable" : "compact"); } catch {}
    if (document.body) document.body.classList.toggle("compact", st.d === "compact");
  }
}

function setupUrlSync() {
  applyUrlState();
  try {
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("popstate", () => {
        const st = readUrlState();
        applyUrlState();
        switchView(activeView);
        document.querySelectorAll(".fpill").forEach((b) =>
          b.classList.toggle("active", b.dataset.sev === (activeFilter || "all")));
        if (typeof applyFilters === "function") applyFilters();
        // applyUrlState set groupBy directly (no re-render) — repaint here.
        if (st && st.group && typeof lastData !== "undefined" && lastData) render(lastData);
      });
    }
  } catch {}
}

const VIEW_LABELS = { overview: "Overview", history: "History", checks: "Checks", system: "System", schedule: "Schedule" };

function viewTabs() {
  return [...document.querySelectorAll("#viewtabs .viewtab")];
}

function switchView(name, { focusTab = false } = {}) {
  if (!VIEWS.includes(name)) return;
  activeView = name;
  try { localStorage.setItem("ld-view", name); } catch {}
  for (const id of VIEWS) {
    const pane = document.getElementById("view-" + id);
    if (pane) pane.hidden = id !== name;
  }
  // The sidebar itself is persistent, but the report sections inside it
  // (breakdown, severity, categories) only make sense on Overview. The
  // Health block is global — it stays on every view.
  document.querySelectorAll("#sidebar .sb-block:not(.sb-views):not(.sb-health)").forEach((b) => {
    b.hidden = name !== "overview";
  });
  viewTabs().forEach((b) => {
    const on = b.dataset.view === name;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focusTab) b.focus();
  });
  // Status bar (wide desktop chrome) mirrors the active view.
  const sbarView = document.getElementById("sbar-view");
  if (sbarView) sbarView.textContent = VIEW_LABELS[name] || name;
  if (name === "checks") renderChecksView();
  if (name === "schedule") renderScheduleView();
  if (name === "overview") {
    // Coming back: keep the report exactly where the filters left it.
    syncGroupsOpen();
    applyFilters();
  }
  syncUrlState();
  syncAutoPausedUI();
}

/* The two notice rows (schedule strip, security posture) share a 2-column
   grid under the full-width START HERE card; when only one is visible it
   spans the full width instead of leaving a half-empty column. Called from
   both renderers (async schedule fetch and sync posture/next-step). */
function syncNoticeGrid() {
  const grid = $("#notices");
  if (!grid || !grid.children) return;
  const visible = [...grid.children].filter((k) => !k.hidden);
  grid.classList.toggle("single", visible.length < 2);
}

/* Brand home-link: logo + title go to Overview and back to top. The
   sidebar stays exactly where it is — only the main view switches. */
function setupBrand() {
  const brand = document.getElementById("brand");
  if (!brand || brand.dataset.bound) return;
  brand.dataset.bound = "1";
  brand.addEventListener("click", (e) => {
    e.preventDefault();
    switchView("overview");
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
  });
}

function setupViews() {
  // Restore the last view before first paint settles — unless the URL
  // already named one (?view= wins over the remembered preference).
  if (!urlViewApplied) {
    try {
      const saved = localStorage.getItem("ld-view");
      if (VIEWS.includes(saved)) activeView = saved;
    } catch {}
  }
  const bar = document.getElementById("viewtabs");
  if (!bar) return;
  bar.addEventListener("click", (e) => {
    const btn = e.target.closest(".viewtab");
    if (btn) switchView(btn.dataset.view);
  });
  // Roving tabindex: arrows move between tabs, like a native tablist.
  bar.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const tabs = viewTabs();
    let i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    i = (i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
    tabs[i].focus();
    switchView(tabs[i].dataset.view);
  });
  if (activeView !== "overview") switchView(activeView);
}
