// SPDX-License-Identifier: GPL-3.0-or-later
/* === Detail pane (wide desktop): list + pinned detail ===
   On >=1440px the Overview becomes a two-pane workbench: the findings list
   stays put on the left, the selected finding's full body renders in a
   sticky pane on the right — the desktop master-detail pattern. Same
   vocabulary, same delegated handlers (data-copy / data-ignore / ev-copy
   keep working inside the pane); no renderer changes. Below 1440px the
   pane never exists and cards expand in place, exactly as before. */
let paneSelectedCode = null;

function detailPane() { return document.getElementById("detailpane"); }

function findingByCode(code) {
  const all = (typeof lastData !== "undefined" && lastData && lastData.findings) || [];
  return all.find((f) => f.code === code) || null;
}

function paneFindingHtml(f) {
  const sev = f.severity || "info";
  const badges =
    (f.code ? '<button class="codepill" data-copy="' + esc(f.code) + '" title="Copy ' + esc(f.code) + '">' + esc(f.code) + "</button>" : "") +
    (f.isNew ? '<span class="newbadge">NEW</span>' : "");
  const dur = durFor(f.check);
  let html = '<div class="dp-head"><span class="sevicon" data-sev="' + esc(sev) + '" aria-hidden="true">' + (SEV_ICONS[sev] || "") + "</span>" +
    "<h3>" + esc(f.title) + "</h3>" + badges + "</div>";
  html += '<div class="dp-body">';
  if (f.detail) {
    html += '<div class="detail"><b>What happened:</b> ' + esc(f.detail) + "</div>";
    if (f.confidence === "low") {
      html += '<div class="dp-lowconf"><span class="sev-dot medium" aria-hidden="true"></span> Low confidence — may be a false positive</div>';
    }
  }
  if (f.evidence) {
    const evId = "evp-" + (f.code || f.check || "x").replace(/[^a-z0-9-]/gi, "");
    html += '<details class="ev" open><summary>Evidence</summary>' +
      '<div class="evidence" id="' + evId + '">' + esc(f.evidence) + "</div>" +
      '<div class="dp-evrow"><button class="ev-copy" data-evcopy="' + evId + '">Copy evidence</button>' +
      (dur != null ? '<span class="durpill" style="display:inline-flex;margin-left:auto" title="Check time">' + esc(String(dur)) + "ms</span>" : "") +
      "</div></details>";
  }
  html += '<div class="fix"><div class="fix-label">Recommended next step</div>' +
    '<div class="fixtext">' + cmdCode(f.fix || "No automated fix — review details above.") + "</div>" +
    '<button data-copy="' + esc(f.fix || f.detail || f.title) + '">Copy fix</button>' +
    '<button data-ignore="' + esc(f.title) + '" title="Hide this finding in future runs">Dismiss</button>' +
    '<a class="reportbtn" href="' + wrongUrl(f) + '" target="_blank" rel="noopener">Report</a></div>';
  html += "</div>";
  return html;
}

function selectFinding(card) {
  const pane = detailPane();
  if (!pane) return;
  const code = card && card.dataset.code ? card.dataset.code : "";
  const f = code ? findingByCode(code) : null;
  paneSelectedCode = f ? f.code : null;
  document.querySelectorAll("#report details.card.selected").forEach((c) => c.classList.remove("selected"));
  if (card && f) {
    card.classList.add("selected");
    pane.hidden = false;
    pane.innerHTML =
      '<div class="dp-kicker"><span class="dp-tag">Detail</span><span class="dp-sev">' +
      esc(SEV_NAMES[f.severity] || "") + "</span></div>" + paneFindingHtml(f);
  } else {
    pane.hidden = true;
    pane.innerHTML = "";
  }
}

/* Pick a sensible selection after data/filter changes: keep the current
   pick while it stays visible, else first visible high → medium → first. */
function autoSelectFinding() {
  const pane = detailPane();
  if (!pane || !isWide()) return;
  const cards = [...document.querySelectorAll("#report details.card")];
  const visible = cards.filter((c) => c.style.display !== "none" && !c.closest("[hidden]"));
  if (!visible.length) { selectFinding(null); return; }
  const current = visible.find((c) => c.dataset.code === paneSelectedCode);
  if (current) { selectFinding(current); return; }
  const pick = visible.find((c) => c.classList.contains("high")) ||
    visible.find((c) => c.classList.contains("medium")) || visible[0];
  selectFinding(pick);
}

function syncDetailPane() {
  const pane = detailPane();
  if (!pane) return;
  const wide = wideModeOn();
  pane.hidden = !wide;
  // START HERE is the narrow-screen guide; at wide the pane takes over
  // (the selected row + its detail is the guidance). renderNextStep keeps
  // setting hidden=false on every render, so re-assert while wide.
  const nh = $("#nexthep");
  if (nh && wide) nh.hidden = true;
  if (wide) autoSelectFinding();
  else if (paneSelectedCode !== null) {
    paneSelectedCode = null;
    document.querySelectorAll("#report details.card.selected").forEach((c) => c.classList.remove("selected"));
    if (typeof lastData !== "undefined" && lastData && typeof renderNextStep === "function") renderNextStep(lastData);
  }
}

function setupDetailPane() {
  // Click a row at wide → select into the pane (no inline expansion).
  // Only the card's own summary triggers selection; codepill, buttons and
  // the evidence disclosure keep their own behavior.
  document.addEventListener("click", (e) => {
    if (!wideModeOn()) return;
    const sum = e.target.closest("#report details.card > summary");
    if (!sum) return;
    if (e.target.closest(".codepill")) return;
    e.preventDefault();
    selectFinding(sum.parentElement);
  });
}
