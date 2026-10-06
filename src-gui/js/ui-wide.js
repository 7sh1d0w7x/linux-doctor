// SPDX-License-Identifier: GPL-3.0-or-later
/* === Wide-desktop mode (>=1200px) ===
   A PC canvas gets desktop behavior: the shell uncaps (wide.css) and the
   findings groups open — a workbench shows its data, an accordion hides
   it. Below 1200px nothing changes. Guarded so environments without
   matchMedia (headless test sandboxes) keep the narrow behavior. */
const WIDE_QUERY = "(min-width: 1200px)";

function isWide() {
  try { return typeof matchMedia === "function" && matchMedia(WIDE_QUERY).matches; }
  catch { return false; }
}

/* The wide class is the single source of truth for CSS; the query drives
   it. Guarded: the headless test sandbox has no documentElement. */
function wideModeOn() {
  const el = document.documentElement;
  return !!(el && el.classList && el.classList.contains("wide"));
}

/* Groups: all open at wide (severity AND category — a workbench shows its
   data); at narrow, restore the syncGroupsOpen policy. */
function applyWideGroups() {
  const wide = wideModeOn();
  document.querySelectorAll("#report .group").forEach((g) => {
    if (wide) g.setAttribute("open", "");
    else if (g.dataset.type === "sev") g.open = activeFilter === g.dataset.key || (activeFilter === "all" && g.dataset.key === "high");
  });
}

/* Hook for the master-detail pane (phase 2): a real syncDetailPane()
   declared later in the bundle replaces this no-op by hoisting. */
function syncDetailPane() {}

function setupWideMode() {
  let mq = null;
  try { mq = typeof matchMedia === "function" ? matchMedia(WIDE_QUERY) : null; } catch { mq = null; }
  if (!mq) return;
  const apply = () => {
    const root = document.documentElement;
    // Guarded like wideModeOn(): headless sandboxes have no documentElement.
    if (root && root.classList) root.classList.toggle("wide", !!mq.matches);
    applyWideGroups();
    syncDetailPane();
  };
  mq.addEventListener("change", apply);
  apply();
}
