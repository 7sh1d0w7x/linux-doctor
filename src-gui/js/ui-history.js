// SPDX-License-Identifier: GPL-3.0-or-later
/* === History section + chart interaction === */
let statusTimer = null;

function setStatus(generatedAt) {
  const txt = $("#statuspill-txt");
  const dot = $("#statusdot");
  if (!txt || !dot) return;
  const ms = Date.now() - new Date(generatedAt).getTime();
  const secs = Math.max(0, Math.round(ms / 1000));
  let label;
  if (secs < 5) label = "checked just now";
  else if (secs < 60) label = "checked " + secs + "s ago";
  else if (secs < 3600) label = "checked " + Math.floor(secs / 60) + "m ago";
  else if (secs < 86400) label = "checked " + Math.floor(secs / 3600) + "h ago";
  else label = "checked " + Math.floor(secs / 86400) + "d ago";
  txt.textContent = label;
  dot.className = "dot" + (secs >= 3600 ? " stale" : "");
  // Status bar (wide desktop chrome) mirrors the hero's freshness line.
  const sbar = document.getElementById("sbar-check");
  if (sbar) {
    sbar.textContent = label;
    sbar.hidden = false;
    sbar.classList.toggle("stale", secs >= 3600);
  }
}

async function renderTrend(currentScore) {
  if (STATIC_DATA) return;
  const trend = $("#trend");
  const runs = await fetchHistory();
  const data = runs.filter((r) => typeof r.score === "number").slice(-12);
  const histEl = $("#history");
  const ledger = $("#runledger");
  if (ledger) ledger.innerHTML = "";
  if (data.length < 2) {
    /* First recorded run: a bare hidden section reads as "broken". Explain
       what will grow here instead, using the score we already have. */
    if (data.length === 1 && !STATIC_DATA) {
      histEl.hidden = false;
      const det = histEl.querySelector(".hist-details");
      if (det) det.open = true;
      trend.innerHTML =
        '<div class="hist-empty">Only one run on record so far \u2014 it scored <b>' + data[0].score + "/100</b>." +
        "Run another check and your health-score trend appears here.</div>";
    } else {
      histEl.hidden = true;
    }
    return;
  }
  histEl.hidden = false;
  renderHistoryLedger(data);
  updateHistoryBadge(data.length);

  // Hero mini-sparkline: the score's recent direction, visible at a glance.
  const spark = $("#hero-spark");
  if (spark) {
    spark.innerHTML = miniSpark(data);
    spark.hidden = false;
  }

  trend.innerHTML = '<div class="trend-wrap">' + scoreChart(data) + severityChart(data) + '</div>';

  if (typeof currentScore === "number" && currentScore < 80) {
    const det = document.querySelector(".hist-details");
    if (det) det.open = true;
  }

  setTimeout(() => {
    const histData = data;
    const showRun = (idx) => {
      const r = histData[idx];
      if (!r) return;
      const prev = idx > 0 ? histData[idx - 1] : null;
      let msg = "Run " + (idx + 1) + "/" + histData.length + " \u00b7 " + fmtWhen(r.at) + " \u00b7 score " + r.score + "/100";
      if (prev) msg += " (prev " + prev.score + ")";
      showToast(msg + " \u2014 opening Changes");
      const diffEl = $("#diff");
      if (diffEl) { diffEl.hidden = false; diffEl.open = true; diffEl.scrollIntoView({ behavior: scrollBehavior(), block: "start" }); }
      const det = document.querySelector(".hist-details");
      if (det) det.open = true;
    };
    // Keyboard parity: the chart marks are role="button", so Enter and Space
    // must do what the click does — the finding cards behave the same way.
    const activate = (el) => {
      const idx = Number(el.dataset.idx || el.closest("[data-idx]")?.dataset.idx);
      if (Number.isFinite(idx)) showRun(idx);
    };
    trend.querySelectorAll(".hist-dot, .hist-bar").forEach(el => {
      el.addEventListener("click", () => activate(el));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
          e.preventDefault();
          activate(el);
        }
      });
    });
  }, 80);
}

/* Run ledger: every recorded run as a row — date, score, delta vs the
   previous run, severity counts. Newest first. Pure-ish (string building
   only) so dashboard-state.test.js can pin the vocabulary. */
function historyLedgerHtml(runs) {
  const rows = (runs || []).filter((r) => typeof r.score === "number").slice(-12);
  if (rows.length < 2) return "";
  let html = '<div class="ledger-head">Past runs <span class="ledger-sub">newest first</span></div><div class="ledger">';
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i];
    const prev = i > 0 ? rows[i - 1] : null;
    const d = prev ? r.score - prev.score : null;
    const dCls = d === null ? "" : d > 0 ? "up" : d < 0 ? "down" : "flat";
    const dTxt = d === null ? "—" : (d > 0 ? "+" + d : String(d));
    const c = r.counts || {};
    html += '<div class="ledger-row"><span class="ledger-when">' + esc(fmtWhen(r.at) || "—") + "</span>" +
      '<span class="ledger-score">' + r.score + "/100</span>" +
      '<span class="ledger-delta ' + dCls + '">' + dTxt + "</span>" +
      '<span class="ledger-counts">' + (c.high || 0) + " high · " + (c.medium || 0) + " med · " + (c.info || 0) + " info</span></div>";
  }
  return html + "</div>";
}

function renderHistoryLedger(runs) {
  const box = $("#runledger");
  if (!box) return;
  box.innerHTML = historyLedgerHtml(runs);
}

function setTabBadge(id, text) {
  const b = document.getElementById(id);
  if (!b) return;
  if (text) { b.textContent = text; b.hidden = false; }
  else { b.textContent = ""; b.hidden = true; }
}

function updateHistoryBadge(n) {
  setTabBadge("tabbadge-history", n >= 2 ? String(n) : "");
}

/* Checks-tab badge: findings with a problem (high/medium) on this report. */
function updateChecksBadge(data) {
  const n = (data.findings || []).filter((f) => f.severity === "high" || f.severity === "medium").length;
  setTabBadge("tabbadge-checks", n > 0 ? String(n) : "");
}
