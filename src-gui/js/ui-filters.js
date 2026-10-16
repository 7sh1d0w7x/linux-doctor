// SPDX-License-Identifier: GPL-3.0-or-later
/* === Severity filters + search === */
let activeFilter = "all";

const PILL_ICONS = { all: ICON_ALL, high: SEV_ICONS.high, medium: SEV_ICONS.medium, info: SEV_ICONS.info };

function renderFilters(counts) {
  const total = counts.high + counts.medium + counts.info;
  const defs = [
    { sev: "all", label: "All" + (total ? " (" + total + ")" : ""), icon: PILL_ICONS.all },
    { sev: "high", label: "High" + (counts.high ? " (" + counts.high + ")" : ""), icon: PILL_ICONS.high },
    { sev: "medium", label: "Medium" + (counts.medium ? " (" + counts.medium + ")" : ""), icon: PILL_ICONS.medium },
    { sev: "info", label: "Info" + (counts.info ? " (" + counts.info + ")" : ""), icon: PILL_ICONS.info },
  ];
  const empty = (sev) => sev !== "all" && (counts[sev] || 0) === 0;
  if (empty(activeFilter)) activeFilter = "all";
  $("#filters").innerHTML = defs.map((d) =>
    '<button class="fpill ' + d.sev + (activeFilter === d.sev ? " active" : "") + '" data-sev="' + d.sev + '"' +
    (empty(d.sev) ? " disabled" : "") + '><span class="pill-icon" aria-hidden="true">' + d.icon + '</span> ' + d.label + '</button>'
  ).join("");
  syncClear();
}

let filterTimer = null;
function applyFilters() {
  // Debounce: typing "network" shouldn't re-layout 40 cards 7 times
  if (filterTimer) clearTimeout(filterTimer);
  filterTimer = setTimeout(() => applyFiltersNow(), 60);
}
function applyFiltersNow() {
  const report = $("#report");
  const hint = $("#drillhint");
  report.hidden = !activeFilter;
  hint.hidden = !!activeFilter;
  if (activeFilter) {
    hint.textContent = "";
  } else {
    hint.textContent = groupBy === "category"
      ? "Select a category to see findings."
      : "Select a severity to see findings.";
  }
  const qRaw = $("#search").value.trim();
  const q = qRaw.toLowerCase();
  // code: prefix → filter by stable code only (e.g. "code:network/" or "code:disk/full")
  const codeFilter = q.startsWith("code:") ? q.slice(5).trim() : null;
  let visible = 0;
  document.querySelectorAll("#report .group").forEach((g) => {
    let any = false;
    g.querySelectorAll(".card, .crow").forEach((c) => {
      const sevOk = activeFilter === "all" || c.classList.contains(activeFilter);
      let match = sevOk;
      if (match && q) {
        if (codeFilter !== null) {
          const code = (c.dataset.code || "").toLowerCase();
          match = code.includes(codeFilter);
        } else {
          match = c.textContent.toLowerCase().includes(q);
        }
      }
      c.style.display = match ? "" : "none";
      if (match) {
        any = true;
        highlightMatches(c, codeFilter !== null ? "" : qRaw);
      } else {
        highlightMatches(c, "");
      }
    });
    if (!qRaw) g.querySelectorAll(".card, .crow").forEach(c => highlightMatches(c, ""));
    g.hidden = !any;
    if (any) visible++;
  });
  const nomatch = $("#nomatch");
  nomatch.hidden = !(activeFilter && qRaw && visible === 0);
  if (!nomatch.hidden) {
    nomatch.innerHTML = '<div class="empty-big">No findings match \u201c' + esc(qRaw) + '\u201d</div>' +
      '<button type="button" class="empty-cta" data-clear-filters>Clear filters</button>';
  }
  // Wide: if the pane's selection was filtered out, pick the next visible
  // one; while it stays visible the pane is left alone (no scroll churn).
  if (typeof wideModeOn === "function" && wideModeOn()) {
    const sel = document.querySelector("#report details.card.selected");
    if (!sel || sel.style.display === "none") autoSelectFinding();
  }
  syncClear();
  syncAutoPausedUI();
  syncUrlState();
}

function syncClear() {
  const clear = $("#clearbtn");
  const hasFilter = activeFilter && activeFilter !== "all";
  const hasSearch = $("#search").value.trim().length > 0;
  clear.disabled = !(hasFilter || hasSearch);
}

function highlightMatches(card, q) {
  card.querySelectorAll("mark.hl").forEach(m => {
    const t = document.createTextNode(m.textContent);
    m.replaceWith(t);
  });
  card.normalize();
  if (!q) return;
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return;
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (n.parentElement && n.parentElement.closest("button, a")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("(" + terms.map(escRe).join("|") + ")", "gi");
  for (const n of nodes) {
    if (!re.test(n.nodeValue)) continue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    const txt = n.nodeValue;
    while ((m = re.exec(txt)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(txt.slice(last, m.index)));
      const mark = document.createElement("mark");
      mark.className = "hl";
      mark.textContent = m[0];
      frag.appendChild(mark);
      last = m.index + m[0].length;
    }
    if (last < txt.length) frag.appendChild(document.createTextNode(txt.slice(last, txt.length)));
    n.replaceWith(frag);
  }
}

function syncGroupsOpen() {
  // Wide mode is a workbench: every group stays open, filtering never
  // collapses data the user can see at a glance. (wideModeOn is hoisted
  // from ui-wide.js; guarded for the headless sandbox.)
  const wideEl = typeof document !== "undefined" ? document.documentElement : null;
  if (wideEl && wideEl.classList && wideEl.classList.contains("wide")) {
    document.querySelectorAll("#report .group").forEach((g) => g.setAttribute("open", ""));
    syncAutoPausedUI();
    return;
  }
  // Severity mode: filtering reveals the group — open it so findings are
  // visible right away. On "All", only High opens (progressive disclosure:
  // Informational can hold dozens of items); a specific severity opens its
  // own group. Category mode: leave expansion to the user.
  document.querySelectorAll("#report .group").forEach((g) => {
    if (g.dataset.type === "cat") return;
    g.open = activeFilter === g.dataset.key || (activeFilter === "all" && g.dataset.key === "high");
  });
  syncAutoPausedUI();
}
