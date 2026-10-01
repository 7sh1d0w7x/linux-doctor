// SPDX-License-Identifier: GPL-3.0-or-later
/* === Finding cards and groups — premium diagnostic storytelling === */
function durFor(check) {
  try {
    if (!check || typeof lastReportData === 'undefined' || !lastReportData) return null;
    const d = lastReportData.durations || lastReportData.checkDurations || lastReportData.durationsMap;
    if (!d) return null;
    if (Array.isArray(d)) { const hit = d.find(x => x.check === check); return hit ? hit.ms : null; }
    if (typeof d === 'object') return d[check] ?? null;
  } catch {}
  return null;
}
function renderCard(f, sev) {
  const sevIcon = SEV_ICONS[sev] || "";
  // Only quiet code + NEW in header — durpill/checkid/lowconf moved to body to reduce chrome
  const codeBadge = f.code ? '<button class="codepill" data-copy="' + esc(f.code) + '" title="Copy ' + esc(f.code) + ' — type code:' + esc(f.code) + ' in search to filter">' + esc(f.code) + '</button>' : "";
  const badges = codeBadge + (f.isNew ? '<span class="newbadge">NEW</span>' : "");
  const dur = durFor(f.check);
  const SEV_COST = { high: "15 points", medium: "8 points", info: "info" };
  // Informational findings render as compact rows (Uptime Kuma / alert-list
  // pattern): dot + title + code, scannable in a second, full body on open.
  // The .card class stays so every selector, counter, and keyboard flow that
  // targets cards keeps working unchanged.
  let html = '<details class="card ' + SEV[sev].cls + (sev === "info" ? " crow" : "") + '" tabindex="0" data-code="' + esc(f.code || "") + '"' +
    (f.check ? ' data-check="' + esc(f.check) + '"' : "") + ">";
  html += '<summary><span class="sevicon" data-sev="' + sev + '" aria-hidden="true" title="' + esc(SEV_NAMES[sev] + " — " + (SEV_COST[sev] || "")) + '">' + sevIcon + '</span><h3>' + esc(f.title) + '</h3>' + badges + '<span class="chev" aria-hidden="true">▸</span></summary>';
  html += '<div class="card-body">';

  // Problem — what happened (detail first sentence)
  if (f.detail) {
    const firstDot = f.detail.indexOf(". ");
    const problem = firstDot > 30 ? f.detail.slice(0, firstDot + 1) : f.detail.split("\n")[0];
    const rest = firstDot > 30 ? f.detail.slice(firstDot + 2) : "";
    html += '<div class="detail"><b>What happened:</b> ' + esc(problem) + '</div>';
    if (rest) html += '<div class="detail" style="margin-top:8px;color:var(--muted)"><span style="font-weight:600;color:var(--text)">Why it matters:</span> ' + esc(rest) + '</div>';
    if (f.confidence === "low") html += '<div style="font-size:11px;color:var(--muted2);margin-top:6px;display:flex;gap:6px;align-items:center"><span style="width:6px;height:6px;border-radius:50%;background:var(--yellow);display:inline-block"></span> Low confidence — may be a false positive</div>';
  }

  if (f.evidence) {
    const evId = "ev-" + (f.id || f.code || Math.random().toString(36).slice(2));
    const evLines = String(f.evidence).split("\n").length;
    html += '<details class="ev"><summary>Evidence — how we detected it · ' + evLines + (evLines === 1 ? " line" : " lines") + "</summary>" +
      '<div class="evidence" id="' + evId + '">' + esc(f.evidence) + '</div>' +
      '<div style="display:flex; gap:6px; margin:6px 12px 10px; flex-wrap:wrap;">' +
      '<button class="ev-expand" data-ev="' + evId + '" hidden>Show more</button>' +
      '<button class="ev-copy" data-evcopy="' + evId + '">Copy evidence</button>' +
      (dur != null ? '<span class="durpill" style="margin-left:auto" title="Check time">' + dur + 'ms</span>' : '') +
      '</div></details>';
  } else if (dur != null) {
    html += '<div style="font-family:var(--mono);font-size:10px;color:var(--muted2);margin-top:2px">' + dur + 'ms</div>';
  }

  html += '<div class="fix">';
  html += '<div class="fix-label">Recommended next step</div>';
  if (f.fix) html += '<div class="fixtext">' + esc(f.fix) + '</div>';
  else html += '<div class="fixtext" style="color:var(--muted2)">No automated fix — review details above.</div>';
  html += '<button data-copy="' + esc(f.fix || f.detail || f.title) + '">Copy fix</button>';
  html += '<button data-ignore="' + esc(f.title) + '" title="Hide this finding in future runs">Dismiss</button>';
  html += '<a class="reportbtn" href="' + wrongUrl(f) + '" target="_blank" rel="noopener">Report</a>';
  html += '</div>';

  html += "</div></details>";
  return html;
}

function groupSummaryHtml(icon, label, count, sev) {
  const ds = sev ? ' data-sev="' + sev + '"' : "";
  // Human language per brief: distinguish issues needing action
  let humanLabel = label;
  if (sev === "high") humanLabel = (count === 1 ? "1 issue needs attention" : count + " issues need attention");
  else if (sev === "medium") humanLabel = count + " " + (count === 1 ? "finding" : "findings") + " — review soon";
  else if (sev === "info") humanLabel = count + " observation" + (count === 1 ? "" : "s");
  return '<summary><span class="sevicon"' + ds + ' aria-hidden="true">' + icon + '</span> ' + esc(humanLabel) + ' <span style="margin-left:6px;font-weight:400;color:var(--muted2);font-size:11px">' + esc(label) + '</span><span class="chev" aria-hidden="true">▸</span></summary>';
}

function wrapGroup(cls, type, key, summaryInner, cardsHtml, open) {
  return '<details class="group ' + cls + '"' + (open ? " open" : "") +
    ' data-type="' + type + '" data-key="' + esc(key) + '">' +
    summaryInner + '<div class="group-body">' + cardsHtml + "</div></details>";
}

/* Severity mode: high first, high pre-opened — but info collapsed by default to reduce noise */
function renderReportBySeverity(findings) {
  let html = "";
  for (const sev of SEV_ORDER) {
    const group = findings.filter((f) => f.severity === sev);
    if (!group.length) continue;
    const cards = group.map((f) => renderCard(f, sev)).join("");
    const isInfo = sev === "info";
    html += wrapGroup(SEV[sev].cls, "sev", sev,
      groupSummaryHtml(SEV_ICONS[sev] || "", SEV_NAMES[sev], group.length, sev), cards, sev === "high" && !isInfo);
  }
  return html;
}

/* Category mode */
function renderReportByCategory(findings) {
  const buckets = new Map();
  for (const f of findings) {
    const cat = checksCategoryMap.get(f.check) || "other";
    if (!buckets.has(cat)) buckets.set(cat, []);
    buckets.get(cat).push(f);
  }
  let html = "";
  for (const cat of CATEGORY_ORDER) {
    const group = buckets.get(cat);
    if (!group || !group.length) continue;
    group.sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
    const cards = group.map((f) => renderCard(f, f.severity)).join("");
    html += wrapGroup("", "cat", cat,
      groupSummaryHtml(catIcon(cat), CATEGORY_LABELS[cat] || cat, group.length), cards, false);
  }
  return html;
}

function renderReport(findings) {
  const html = groupBy === "category"
    ? renderReportByCategory(findings)
    : renderReportBySeverity(findings);
  return html || "";
}

function categoryOf(f) {
  return checksCategoryMap.get(f.check) || "other";
}

function wrongUrl(f) {
  return "https://github.com/7sh1d0w7x/linux-doctor/issues/new?" +
    "title=" + encodeURIComponent("Wrong finding: " + (f.code || f.title)) +
    "&body=" + encodeURIComponent(
      "**Finding:** " + (f.title || "") + "\n" +
      "**Severity:** " + (f.severity || "") + "\n" +
      "**Check:** " + (f.check || "") + "\n" +
      "**Code:** " + (f.code || "") + "\n" +
      "**Version:** " + (typeof lastReportData !== "undefined" && lastReportData ? lastReportData.version || "" : "") + "\n\n" +
      "This finding looks wrong because:\n\n[describe what you expected]\n\n---\n" +
      "Full report: `linux-doctor --json`");
}
