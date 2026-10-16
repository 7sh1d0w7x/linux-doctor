// SPDX-License-Identifier: GPL-3.0-or-later
/* === All-checks matrix ===
   A diagnostic tool earns trust by showing what it looked AT, not only
   what it found. This modal lists every registered check with its live
   outcome on this machine: findings (worst severity first), clean,
   not-applicable for this profile, atomic skips, or runtime errors.
   Rows with findings deep-link back to their cards in the report. */

/* Result states — a fixed vocabulary, not free prose. The three finding
   words are the ones the report and the severity legend already use, so a
   result column reads the same everywhere in the product. */
const MX_STATE = {
  high: "needs attention", medium: "warning", info: "observation",
  ok: "clean", na: "not applicable", skip: "skipped", err: "failed to run",
};
const MX_CLS = { high: "high", medium: "medium", info: "info", ok: "ok", na: "na", skip: "na", err: "err" };

/* Build the matrix once, returned in parts: the view frames it with its own
   header and column rule, the modal keeps the "All checks" heading. */
function checksMatrixBody(data, checks, opts) {
  const problemsOnly = !!(opts && opts.problemsOnly);
  const findingsByCheck = new Map();
  for (const f of data.findings || []) {
    if (!findingsByCheck.has(f.check)) findingsByCheck.set(f.check, []);
    findingsByCheck.get(f.check).push(f);
  }
  const errors = new Map((data.checkErrors || []).map((e) => [e.check, e.error]));
  const atomic = new Set((data.skippedChecks || []).map((s) => s.id));

  const SEV_RANK = { high: 0, medium: 1, info: 2 };
  const dot = (cls) => '<span class="sev-dot ' + cls + '"></span>';
  function statusOf(c) {
    if (errors.has(c.id)) return { rank: 0, key: "err", icon: dot("err"), why: esc(errors.get(c.id) || "failed to run") };
    const fs = findingsByCheck.get(c.id) || [];
    if (fs.length) {
      fs.sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9));
      const sev = fs[0].severity;
      return { rank: 1, key: sev, icon: dot(sev), why: fs.length > 1 ? fs.length + " findings" : "", goto: true };
    }
    if (!c.appliesHere) return { rank: 3, key: "na", icon: dot("na"), why: "runs on: " + (c.appliesTo || []).join(", ") };
    if (c.skipOnAtomic || atomic.has(c.id)) return { rank: 3, key: "skip", icon: dot("atomic"), why: c.atomicReason || "skipped on immutable/atomic systems" };
    return { rank: 2, key: "ok", icon: dot("ok"), why: "" };
  }

  const cats = new Map();
  for (const c of checks) {
    const cat = c.category || "other";
    if (!cats.has(cat)) cats.set(cat, []);
    cats.get(cat).push(c);
  }

  // Stats are computed over the whole registry, so the summary never changes
  // shape when the "problems only" filter is on.
  const all = new Map();
  let problemCount = 0, errorCount = 0, cleanCount = 0, naCount = 0;
  for (const [cat, list] of cats) {
    const rows = list.map((c) => ({ c, s: statusOf(c) }))
      .sort((a, b) => a.s.rank - b.s.rank || a.c.id.localeCompare(b.c.id));
    for (const { s } of rows) {
      if (s.rank === 1) problemCount++;
      else if (s.rank === 0) errorCount++;
      else if (s.rank === 2) cleanCount++;
      else naCount++;
    }
    all.set(cat, rows);
  }

  let body = "";
  for (const cat of CATEGORY_ORDER) {
    const rows = (all.get(cat) || []).filter((r) => !problemsOnly || r.s.rank <= 1);
    if (!rows.length) continue;
    body += '<div class="mx-cat">' + catIcon(cat, 12) + " " + esc(CATEGORY_LABELS[cat] || cat) +
      '<span class="mx-cat-n">' + rows.length + "</span></div>";
    for (const { c, s } of rows) {
      const gotoAttr = s.goto
        ? ' data-goto-code="' + esc(((findingsByCheck.get(c.id) || [])[0] || {}).code || "") + '" data-goto-check="' + esc(c.id) + '" tabindex="0" role="button" aria-label="Show ' + esc(c.id) + ' finding"'
        : "";
      const why = s.why ? '<span class="mx-why" title="' + esc(s.why) + '">' + s.why + "</span>" : "";
      const cls = MX_CLS[s.key];
      body += '<div class="mx-row' + (s.goto ? " link" : "") + '"' + gotoAttr + ">" +
        '<span class="mx-st" aria-hidden="true">' + s.icon + '</span>' +
        '<span class="mx-id">' + esc(c.id) + '</span>' +
        '<span class="mx-title">' + esc(c.title) + '</span>' +
        '<span class="mx-res ' + cls + '"><span class="mx-state ' + cls + '">' + MX_STATE[s.key] + "</span>" + why + "</span></div>";
    }
  }

  const total = checks.length;
  const summary = total + " registered \u00b7 " +
    problemCount + " with findings \u00b7 " +
    cleanCount + " clean \u00b7 " +
    (errorCount ? errorCount + " failed to run \u00b7 " : "") +
    naCount + " not applicable here" +
    (STATIC_DATA ? " \u00b7 static report: live check list unavailable" : "");
  return { body, summary, problems: problemCount + errorCount };
}

function checksMatrixHtml(data, checks, opts) {
  const m = checksMatrixBody(data, checks, opts);
  const head = opts && opts.head === false ? "" : '<div class="mx-head">All checks</div>';
  return head + '<div class="mx-sub">' + m.summary + "</div>" + m.body;
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

/* Checks view: the same matrix, inline and framed as its own view. The
   inventory needs to be scannable (a real column rule), countable (a count
   per category), and quietable (a filter that drops everything clean).
   Cached so the filter repaints without another fetch. */
let lastChecks = null;
let checksProblemsOnly = false;

function paintChecksView() {
  const box = $("#checksview");
  if (!box) return;
  const data = lastReportData || {};
  const checks = lastChecks || [];
  const m = checksMatrixBody(data, checks, { problemsOnly: checksProblemsOnly });
  const empty = checksProblemsOnly && m.problems === 0
    ? '<div class="mx-none">Nothing needs attention — every check came back clean.</div>'
    : "";
  box.innerHTML =
    '<div class="mx-tools">' +
      '<div class="mx-sub">All checks \u00b7 ' + m.summary + "</div>" +
      '<button class="fpill mx-filter' + (checksProblemsOnly ? " active" : "") + '" id="mx-problems" type="button" aria-pressed="' + (checksProblemsOnly ? "true" : "false") + '">Problems only <span class="mx-fcount">' + m.problems + "</span></button>" +
    "</div>" +
    '<div class="mx-cols" aria-hidden="true"><span>Check</span><span>Result</span></div>' +
    empty +
    '<div class="mx-list">' + m.body + "</div>";
}

async function renderChecksView() {
  const box = $("#checksview");
  if (!box) return;
  const checks = STATIC_DATA ? [] : await fetchChecks();
  lastChecks = checks;
  paintChecksView();
}

function setupChecksView() {
  // Deep-link rows inside the Checks view: same goto as the modal, but the
  // finding lives in Overview, so switch views first. Bound once.
  const cv = $("#view-checks");
  if (cv && !cv.dataset.bound) {
    cv.dataset.bound = "1";
    cv.addEventListener("click", (e) => {
      if (e.target.closest("#mx-problems")) {
        checksProblemsOnly = !checksProblemsOnly;
        paintChecksView();
        return;
      }
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
