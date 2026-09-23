// SPDX-License-Identifier: GPL-3.0-or-later
/* === All-checks matrix ===
   A diagnostic tool earns trust by showing what it looked AT, not only
   what it found. This modal lists every registered check with its live
   outcome on this machine: findings (worst severity first), clean,
   not-applicable for this profile, atomic skips, or runtime errors.
   Rows with findings deep-link back to their cards in the report. */

function checksMatrixHtml(data, checks) {
  const findingsByCheck = new Map();
  for (const f of data.findings || []) {
    if (!findingsByCheck.has(f.check)) findingsByCheck.set(f.check, []);
    findingsByCheck.get(f.check).push(f);
  }
  const errors = new Map((data.checkErrors || []).map((e) => [e.check, e.error]));
  const atomic = new Set((data.skippedChecks || []).map((s) => s.id));

  const SEV_RANK = { high: 0, medium: 1, info: 2 };
  const dot = (cls) => '<span class="sev-dot ' + cls + '"></span>';
  const ST = {
    err:    { i: dot("err"),    t: "failed" },
    ok:     { i: dot("ok"),     t: "clean" },
    na:     { i: dot("na"),     t: "" },
    atomic: { i: dot("atomic"), t: "" },
  };
  function statusOf(c) {
    if (errors.has(c.id)) return { rank: 0, icon: ST.err.i, cls: "err", note: esc(errors.get(c.id) || "failed to run") };
    const fs = findingsByCheck.get(c.id) || [];
    if (fs.length) {
      fs.sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9));
      return { rank: 1, icon: dot(fs[0].severity), cls: fs[0].severity, note: fs.length + " finding" + (fs.length > 1 ? "s" : ""), goto: true };
    }
    if (!c.appliesHere) return { rank: 3, icon: ST.na.i, cls: "na", note: "runs on: " + (c.appliesTo || []).join(", ") };
    if (c.skipOnAtomic || atomic.has(c.id)) return { rank: 3, icon: ST.atomic.i, cls: "na", note: c.atomicReason || "skipped on immutable/atomic systems" };
    return { rank: 2, icon: ST.ok.i, cls: "ok", note: "clean" };
  }

  const cats = new Map();
  for (const c of checks) {
    const cat = c.category || "other";
    if (!cats.has(cat)) cats.set(cat, []);
    cats.get(cat).push(c);
  }

  let problemCount = 0, errorCount = 0, cleanCount = 0, naCount = 0;
  let body = "";
  for (const cat of CATEGORY_ORDER) {
    const list = cats.get(cat);
    if (!list || !list.length) continue;
    const rows = list.map((c) => ({ c, s: statusOf(c) }))
      .sort((a, b) => a.s.rank - b.s.rank || a.c.id.localeCompare(b.c.id));
    body += '<div class="mx-cat">' + catIcon(cat, 12) + " " + esc(CATEGORY_LABELS[cat] || cat) + "</div>";
    for (const { c, s } of rows) {
      if (s.rank === 1) problemCount++;
      else if (s.rank === 0) errorCount++;
      else if (s.rank === 2) cleanCount++;
      else naCount++;
      const gotoAttr = s.goto
        ? ' data-goto-code="' + esc(((findingsByCheck.get(c.id) || [])[0] || {}).code || "") + '" data-goto-check="' + esc(c.id) + '" tabindex="0" role="button" aria-label="Show ' + esc(c.id) + ' finding"'
        : "";
      body += '<div class="mx-row' + (s.goto ? " link" : "") + '"' + gotoAttr + ">" +
        '<span class="mx-st" aria-hidden="true">' + s.icon + '</span>' +
        '<span class="mx-id">' + esc(c.id) + '</span>' +
        '<span class="mx-title">' + esc(c.title) + '</span>' +
        '<span class="mx-note ' + s.cls + '">' + s.note + "</span></div>";
    }
  }

  const total = checks.length;
  return '<div class="mx-head">All checks</div>' +
    '<div class="mx-sub">' + total + " registered \u00b7 " +
    problemCount + " with findings \u00b7 " +
    cleanCount + " clean \u00b7 " +
    (errorCount ? errorCount + " failed to run \u00b7 " : "") +
    naCount + " not applicable here" +
    (STATIC_DATA ? " \u00b7 static report: live check list unavailable" : "") + "</div>" +
    body;
}

/* The persistent state the GUI can otherwise only set (Dismiss) lives here:
   the ignore list, with a remove for each entry and the config path. */
function ignoredSectionHtml(ig) {
  const rows = [];
  for (const p of ig.patterns || []) rows.push({ kind: "title", v: p });
  for (const c of ig.codes || []) rows.push({ kind: "code", v: c });
  const list = rows.length
    ? rows.map((r) =>
        '<div class="ig-row"><span class="ig-v">' + esc(r.v) + '</span>' +
        '<span class="ig-kind">' + (r.kind === "code" ? "code" : "title") + '</span>' +
        '<button class="ig-remove" data-ig-remove="' + esc(r.v) + '" data-ig-kind="' + r.kind + '">Remove</button></div>'
      ).join("")
    : '<div class="mx-sub">Nothing is ignored. Dismiss a finding to hide it here.</div>';
  return '<div class="mx-head" style="margin-top:20px">Ignored findings</div>' +
    '<div class="mx-sub">Dismissed findings and patterns, saved to <code>' + esc(ig.path || "~/.config/linux-doctor/config.json") + '</code></div>' + list;
}

async function openChecksMatrix() {
  openModal('<div class="mx-head">All checks</div><div class="mx-sub">Loading\u2026</div>', "All checks");
  const checks = STATIC_DATA ? [] : await fetchChecks();
  const ignore = await fetchIgnore();
  openModal(checksMatrixHtml(lastReportData || {}, checks) + ignoredSectionHtml(ignore), "All checks");
}

function gotoFinding(check, code) {
  closeModal();
  activeFilter = "all";
  document.querySelectorAll(".fpill").forEach((b) => b.classList.toggle("active", b.dataset.sev === "all"));
  syncGroupsOpen();
  applyFilters();
  const card = (code && document.querySelector('#report details[data-code="' + code.replace(/"/g, '\\"') + '"]'))
    || document.querySelector('#report details[data-check="' + check.replace(/"/g, '\\"') + '"]');
  if (card) {
    card.setAttribute("open", "");
    card.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
    if (card.tabIndex >= 0) card.focus({ preventScroll: true });
    showToast("Showing " + check);
  }
}

function setupChecksMatrix() {
  $("#checksmatrixbtn")?.addEventListener("click", openChecksMatrix);
  // Deep-link rows: mouse and keyboard share one persistent handler.
  const body = $("#modal-body");
  if (!body) return;
  body.addEventListener("click", async (e) => {
    const rm = e.target.closest("[data-ig-remove]");
    if (rm && isModalOpen()) {
      rm.disabled = true;
      const payload = rm.dataset.igKind === "code"
        ? { code: rm.dataset.igRemove, remove: true }
        : { pattern: rm.dataset.igRemove, remove: true };
      const ok = await editIgnore(payload);
      showToast(ok ? "Removed from ignore list" : "Could not remove");
      if (ok) openChecksMatrix();
      return;
    }
    const row = e.target.closest("[data-goto-check]");
    if (!row || !isModalOpen()) return;
    gotoFinding(row.dataset.gotoCheck, row.dataset.gotoCode);
  });
  body.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest("[data-goto-check]");
    if (!row || !isModalOpen()) return;
    e.preventDefault();
    gotoFinding(row.dataset.gotoCheck, row.dataset.gotoCode);
  });
}

/* Checks view: the same matrix, inline instead of in a modal. Rendered
   lazily on every activation so it never goes stale behind the report. */
async function renderChecksView() {
  const box = $("#checksview");
  if (!box) return;
  const checks = STATIC_DATA ? [] : await fetchChecks();
  box.innerHTML = checksMatrixHtml(lastReportData || {}, checks);
}

function setupChecksView() {
  // Deep-link rows inside the Checks view: same goto as the modal, but the
  // finding lives in Overview, so switch views first. Bound once.
  const cv = $("#view-checks");
  if (cv && !cv.dataset.bound) {
    cv.dataset.bound = "1";
    cv.addEventListener("click", (e) => {
      const row = e.target.closest("[data-goto-check]");
      if (!row) return;
      switchView("overview");
      gotoFinding(row.dataset.gotoCheck, row.dataset.gotoCode);
    });
    cv.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const row = e.target.closest("[data-goto-check]");
      if (!row) return;
      e.preventDefault();
      switchView("overview");
      gotoFinding(row.dataset.gotoCheck, row.dataset.gotoCode);
    });
  }
}
