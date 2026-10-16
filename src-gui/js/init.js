// SPDX-License-Identifier: GPL-3.0-or-later
/* === Entry point: load, bind, start === */

// Inline-SVG capability probe. Icons ship as inline SVG (never font glyphs);
// every icon carries a hidden emoji fallback (.ico .fb). If SVG ever fails
// to render — hostile CSP, stripped build, exotic sandbox — this flips the
// root to .no-svg and CSS swaps every fallback in at once.
(function svgProbe() {
  try {
    const el = document.createElement("div");
    el.innerHTML = '<svg width="8" height="8"><rect width="8" height="8"/></svg>';
    el.style.position = "absolute";
    el.style.opacity = "0";
    document.body.appendChild(el);
    const r = el.firstChild.getBoundingClientRect();
    el.remove();
    if (!(r.width > 0 && r.height > 0)) markNoSvg();
  } catch {
    markNoSvg();
  }
  function markNoSvg() {
    const root = document.documentElement;
    if (root && root.classList && typeof root.classList.add === "function") root.classList.add("no-svg");
  }
})();

// Theme
applyTheme();
$("#theme").addEventListener("click", cycleTheme);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

// Sticky header/toolbar
const hdr = document.querySelector("header");
const tbar = document.querySelector(".toolbar");
window.addEventListener("scroll", () => {
  const sc = window.scrollY > 8;
  if (hdr) hdr.classList.toggle("scrolled", sc);
  if (tbar) tbar.classList.toggle("scrolled", sc);
}, { passive: true });

// Filters
$("#filters").addEventListener("click", (e) => {
  const btn = e.target.closest(".fpill");
  if (!btn) return;
  activeFilter = activeFilter === btn.dataset.sev ? null : btn.dataset.sev;
  document.querySelectorAll(".fpill").forEach((b) => b.classList.toggle("active", b.dataset.sev === activeFilter));
  syncGroupsOpen();
  applyFilters();
});
$("#search").addEventListener("input", applyFilters);
$("#clearbtn").addEventListener("click", () => {
  activeFilter = "all";
  $("#search").value = "";
  document.querySelectorAll(".fpill").forEach((b) => b.classList.toggle("active", b.dataset.sev === activeFilter));
  syncGroupsOpen();
  applyFilters();
});

// Expand all
$("#expandall").addEventListener("click", () => {
  const anyClosed = [...document.querySelectorAll("#report .group, #report .card, #report .crow")].some((el) => !el.open);
  setAllOpen(anyClosed);
  syncAutoPausedUI();
});

// Export dropdown
(function setupExportDropdown() {
  const dd = $("#export-dropdown");
  const trigger = $("#export-trigger");
  if (!dd || !trigger) return;
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = dd.classList.toggle("open");
    trigger.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", () => {
    dd.classList.remove("open");
    trigger.setAttribute("aria-expanded", "false");
  });
  const menuItems = () => [...dd.querySelectorAll(".dropdown-item")];
  const closeMenu = (focusTrigger) => {
    dd.classList.remove("open");
    trigger.setAttribute("aria-expanded", "false");
    if (focusTrigger) trigger.focus();
  };
  dd.querySelectorAll(".dropdown-item").forEach(btn => {
    btn.addEventListener("click", () => closeMenu(true));
  });
  dd.addEventListener("keydown", (e) => {
    if (!dd.classList.contains("open")) return;
    const list = menuItems();
    const i = list.indexOf(document.activeElement);
    // Stop the global card-navigation handler on document from also acting.
    if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); (list[i + 1] || list[0])?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); (list[i - 1] || list[list.length - 1])?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); e.stopPropagation(); list[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); e.stopPropagation(); list[list.length - 1]?.focus(); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dd.classList.contains("open")) {
      closeMenu(true);
      e.stopImmediatePropagation();
    }
  });
})();

// Re-run
async function load({ saveHistory = false } = {}) {
  const status = $("#status");
  const report = $("#report");
  const rerun = $("#rerun");
  status.className = "status running";
  status.innerHTML = '<span class="spinner" aria-hidden="true"></span>Reading your system\u2026';
  $("#expandall").textContent = "\u229e Expand all";
  report.innerHTML = '<div class="skel-hero"></div><div class="skel-card"></div><div class="skel-card"></div><div class="skel-card"></div>';
  rerun.disabled = true;
  rerun.textContent = "↻ Running…";
  try {
    // Category grouping needs the check→category map; fetch it once before
    // the first render. Never fatal — grouping falls back to "Other".
    await loadCategoryMap();
    // Explicit load (first paint / Re-run) asks for a fresh scan; only an
    // explicit Re-run records the run in history — background polling never
    // does (it would churn the trend).
    render(await fetchReport({ refresh: true, save: saveHistory }));
    if (saveHistory) showToast("\u2713 Run recorded in history");
  } catch (err) {
    status.className = "status warn";
    status.innerHTML = "";
    status.textContent = "\u26a0\ufe0f Could not run checks: " + (err && err.message ? err.message : err);
    report.innerHTML = '<div class="empty">Run failed \u2014 see the message above. ' +
      (isDesktop()
        ? "The desktop app ships its own Node runtime, so a reinstall usually fixes a broken install."
        : "Make sure the dashboard server is still running, then press Re-run checks.") +
      "</div>";
  } finally {
    rerun.disabled = false;
    rerun.textContent = "↻ Re-run checks";
  }
}
$("#rerun").addEventListener("click", () => load({ saveHistory: true }));

// PDF export
const pdfBtn = $("#pdfbtn");
if (pdfBtn) {
  pdfBtn.addEventListener("click", () => {
    document.querySelectorAll(".group, .card, .crow, details.ev").forEach(el => el.setAttribute("open", ""));
    setTimeout(() => window.print(), 120);
    showToast("Print dialog opened \u2014 save as PDF");
  });
}

// Markdown export — scrubbed, share-ready (same scrub() as CLI --md)
$("#export").addEventListener("click", async () => {
  if (!lastData) return;
  await copyText(reportMarkdown(lastData));
  const btn = $("#export");
  const old = btn.textContent;
  btn.textContent = "\u2713 Copied";
  showToast("\u2713 Report copied as Markdown (scrubbed)");
  setTimeout(() => (btn.textContent = old), 1200);
});
$("#export-md-file")?.addEventListener("click", () => {
  if (!lastData) return;
  downloadMarkdown(lastData);
  showToast("\u2713 Markdown file downloaded (scrubbed)");
});

// Banner buttons: copy fix / jump to finding
document.addEventListener("click", async (e) => {
  // NH copy
  const copyBtn = e.target.closest("[data-nhcopy]");
  if (copyBtn) {
    await copyText(copyBtn.dataset.nhcopy);
    showToast("\u2713 Fix copied to clipboard");
    return;
  }
  // NH jump
  const jumpBtn = e.target.closest("[data-nhjump]");
  if (jumpBtn) {
    const code = jumpBtn.dataset.nhjump;
    activeFilter = "all";
    document.querySelectorAll(".fpill").forEach((b) => b.classList.toggle("active", b.dataset.sev === "all"));
    syncGroupsOpen();
    applyFilters();
    const card = code ? document.querySelector('#report details[data-code="' + code.replace(/"/g, '\\"') + '"]') : null;
    if (card) {
      card.setAttribute("open", "");
      card.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
      setTimeout(() => { card.classList.remove("flash"); }, 50);
      const nh = $("#nexthep");
      if (nh) nh.classList.add("flash");
      setTimeout(() => nh && nh.classList.remove("flash"), 1700);
    }
    return;
  }
  // Evidence copy
  if (e.target.classList.contains("ev-copy")) {
    const id = e.target.dataset.evcopy;
    const ev = document.getElementById(id);
    if (ev) {
      await copyText(ev.textContent);
      const old = e.target.textContent;
      e.target.textContent = "\u2713 Copied";
      showToast("\u2713 Evidence copied");
      setTimeout(() => e.target.textContent = old, 1200);
    }
    return;
  }
  // Evidence expand
  if (e.target.classList.contains("ev-expand")) {
    const id = e.target.dataset.ev;
    const ev = document.getElementById(id);
    if (ev) {
      const expanded = ev.classList.toggle("expanded");
      e.target.textContent = expanded ? "Show less" : "Show more";
    }
    return;
  }
  // Generic copy
  if (e.target.dataset.copy !== undefined) {
    // A code pill lives inside the card <summary>: copying must not also
    // toggle the finding open/closed.
    if (e.target.closest && e.target.closest(".codepill")) e.preventDefault();
    await copyText(e.target.dataset.copy);
    const old = e.target.textContent;
    e.target.textContent = "\u2713 Copied";
    showToast("\u2713 Copied to clipboard");
    setTimeout(() => (e.target.textContent = old), 1200);
  }
  // Ignore
  if (e.target.dataset.ignore !== undefined) {
    await ignoreFinding(e.target.dataset.ignore, e.target);
  }
  // Undo
  if (e.target.dataset.undo !== undefined) {
    if (lastUndo && lastData) {
      lastData.findings = [...lastUndo.findings];
      render(lastData);
      showToast("\u21a9 Restored");
      lastUndo = null;
    }
  }
});

// Ignore finding
let lastUndo = null;
async function ignoreFinding(title, btn) {
  const payload = JSON.stringify({ pattern: title });
  const tryPost = async (url) => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
    return res.ok;
  };
  let ok = false;
  try { ok = await tryPost("http://127.0.0.1:17321/api/ignore"); } catch { ok = false; }
  if (!ok) { try { ok = await tryPost("/api/ignore"); } catch { ok = false; } }
  btn.disabled = true;
  btn.textContent = ok ? "\u2713 Ignored" : "\u2717 Could not save";
  if (ok && lastData) {
    lastUndo = { findings: [...lastData.findings], title };
    lastData.findings = lastData.findings.filter((f) => f.title !== title);
    render(lastData);
    showToast('Ignored "' + esc(title).slice(0, 40) + (title.length > 40 ? "\u2026" : "") + '" <button data-undo>Undo</button>', 4000);
    setTimeout(() => { if (lastUndo && lastUndo.title === title) lastUndo = null; }, 4200);
  } else if (!ok) {
    showToast("\u2717 Could not save \u2014 check permissions");
  }
}

// Setup modules
setupKeyboard();
setupPalette();
setupPolling();
setupThresholds();
setupNotifyButton();
setupSidebar();
setupModal();
setupChecksMatrix();
setupChecksView();
setupUrlSync();
setupViews();
setupBrand();

// JSON export — the same versioned envelope /api/report serves.
$("#copyjson")?.addEventListener("click", async () => {
  if (!lastData) return;
  await copyText(JSON.stringify(lastData, null, 2));
  showToast("\u2713 JSON report copied");
});

// Keyboard shortcuts help (?)
$("#helpbtn")?.addEventListener("click", openHelp);
/* Empty-state escape hatches: the filtered-out message and any future one
   carry a control, so a dead end is always one click from resolving. */
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-clear-filters]")) $("#clearbtn")?.click();
});

// The hero "N checks" chip opens the matrix too.
$("#checkschip")?.addEventListener("click", openChecksMatrix);

// Density toggle: compact card spacing, remembered across sessions.
// Technical users get compact by default (more findings per viewport, less scroll).
const densityBtn = $("#densitybtn");
if (densityBtn) {
  try {
    const pref = localStorage.getItem("ld-density");
    if (pref === "compact" || pref === null) document.body.classList.add("compact");
  } catch { document.body.classList.add("compact"); }
  const syncDensityBtn = () => {
    const compact = document.body.classList.contains("compact");
    densityBtn.setAttribute("aria-pressed", String(compact));
    densityBtn.title = compact ? "Density: compact — click for comfortable" : "Density: comfortable — click for compact";
  };
  syncDensityBtn();
  densityBtn.addEventListener("click", () => {
    const compact = document.body.classList.toggle("compact");
    try { localStorage.setItem("ld-density", compact ? "compact" : "comfortable"); } catch {}
    syncDensityBtn();
    showToast(compact ? "Compact density" : "Comfortable density");
  });
}

// Initial load
setupWideMode();
setupDetailPane();
if (STATIC_DATA) {
  render(STATIC_DATA);
  const rerun = $("#rerun");
  if (rerun) { rerun.disabled = true; rerun.title = "Static report \u2014 regenerate with linux-doctor --html <path>"; }
} else {
  load();
  startPolling();
}
