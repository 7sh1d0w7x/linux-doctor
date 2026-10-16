// SPDX-License-Identifier: GPL-3.0-or-later
/* === Command palette (Ctrl/Cmd+K) ===
   One keystroke to jump anywhere: views, actions and findings, filtered as
   you type. Arrow keys move, Enter runs, Esc closes. Linear's signature,
   wired to the same functions the toolbar already calls. */
let paletteItems = [];
let paletteSel = 0;

function isPaletteOpen() {
  const el = $("#palette");
  return !!el && !el.hidden;
}

/* Every entry is { group, label, hint, run }. Findings come from the report
   that is already in memory; nothing extra is fetched. */
function paletteCommands() {
  const cmds = [];
  for (const v of VIEWS) {
    const label = v.charAt(0).toUpperCase() + v.slice(1);
    cmds.push({ group: "Views", label, hint: "Open", run: () => switchView(v) });
  }
  cmds.push({ group: "Actions", label: "Re-run checks", run: () => $("#rerun")?.click() });
  cmds.push({ group: "Actions", label: "Toggle theme", run: () => $("#theme")?.click() });
  cmds.push({ group: "Actions", label: "Expand all findings", run: () => setAllOpen(true) });
  cmds.push({ group: "Actions", label: "Collapse all findings", run: () => setAllOpen(false) });
  cmds.push({ group: "Actions", label: "Toggle compact density", run: () => $("#densitybtn")?.click() });
  cmds.push({ group: "Actions", label: "Open the all-checks matrix", run: () => $("#checksmatrixbtn")?.click() });
  cmds.push({ group: "Actions", label: "Edit thresholds", run: () => $("#threshbtn")?.click() });
  cmds.push({ group: "Actions", label: "Export report", run: () => $("#export-trigger")?.click() });
  cmds.push({ group: "Actions", label: "Keyboard shortcuts", run: () => openHelp() });

  const findings = (typeof lastReportData !== "undefined" && lastReportData && lastReportData.findings) || [];
  for (const f of findings) {
    cmds.push({
      group: "Findings",
      label: f.title || f.code || "Finding",
      hint: (f.code ? f.code + " · " : "") + (SEV_NAMES[f.severity] || f.severity || ""),
      run: () => jumpToFinding(f),
    });
  }
  return cmds;
}

function jumpToFinding(f) {
  switchView("overview");
  const el = [...document.querySelectorAll("#report .card")].find((c) => (c.dataset.code || "") === (f.code || ""));
  if (!el) return;
  el.setAttribute("open", "");
  if (typeof wideModeOn === "function" && wideModeOn() && typeof selectFinding === "function") selectFinding(el);
  el.scrollIntoView({ block: "center" });
  el.focus({ preventScroll: true });
}

function paletteFilter(q) {
  const all = paletteCommands();
  const needle = q.trim().toLowerCase();
  if (!needle) return all.slice(0, 40);
  const out = [];
  for (const c of all) {
    const hay = (c.label + " " + (c.hint || "") + " " + c.group).toLowerCase();
    if (hay.includes(needle)) out.push(c);
  }
  return out.slice(0, 40);
}

function renderPalette(q) {
  paletteItems = paletteFilter(q);
  if (paletteSel >= paletteItems.length) paletteSel = 0;
  const list = $("#palette-list");
  if (!list) return;
  if (!paletteItems.length) {
    list.innerHTML = '<div class="pal-empty">Nothing matches \u201c' + esc(q.trim()) + "\u201d</div>";
    return;
  }
  let html = "";
  let last = "";
  paletteItems.forEach((c, i) => {
    if (c.group !== last) { html += '<div class="pal-group">' + esc(c.group) + "</div>"; last = c.group; }
    html += '<button type="button" class="pal-item' + (i === paletteSel ? " on" : "") + '" data-i="' + i + '" role="option">' +
      '<span class="pal-label">' + esc(c.label) + "</span>" +
      (c.hint ? '<span class="pal-hint">' + esc(c.hint) + "</span>" : "") +
      "</button>";
  });
  list.innerHTML = html;
}

function movePalette(d) {
  if (!paletteItems.length) return;
  paletteSel = (paletteSel + d + paletteItems.length) % paletteItems.length;
  const list = $("#palette-list");
  list.querySelectorAll(".pal-item").forEach((el, i) => el.classList.toggle("on", i === paletteSel));
  list.querySelector(".pal-item.on")?.scrollIntoView({ block: "nearest" });
}

function runPalette(i) {
  const cmd = paletteItems[i == null ? paletteSel : i];
  closePalette();
  if (cmd) setTimeout(() => cmd.run(), 0);
}

function openPalette() {
  const el = $("#palette");
  if (!el) return;
  el.hidden = false;
  paletteSel = 0;
  const input = $("#palette-input");
  if (input) input.value = "";
  renderPalette("");
  input?.focus();
}

function closePalette() {
  const el = $("#palette");
  if (el) el.hidden = true;
}

function setupPalette() {
  const el = $("#palette");
  if (!el) return;
  el.addEventListener("click", (e) => { if (e.target === el) closePalette(); });
  const input = $("#palette-input");
  const list = $("#palette-list");
  input?.addEventListener("input", (e) => { paletteSel = 0; renderPalette(e.target.value); });
  input?.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); movePalette(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); movePalette(-1); }
    else if (e.key === "Enter") { e.preventDefault(); runPalette(); }
    else if (e.key === "Escape") { e.preventDefault(); closePalette(); }
  });
  list?.addEventListener("click", (e) => {
    const item = e.target.closest(".pal-item");
    if (item) runPalette(Number(item.dataset.i));
  });
}
