// SPDX-License-Identifier: GPL-3.0-or-later
/* === Main render orchestrator === */

function render(data) {
  lastReportData = data;
  lastData = data;
  const { findings = [] } = data;

  const counts = renderStatus(data);
  renderFilters(counts);
  renderSidebar(data, counts);

  // "35 checks · 2 skipped" chip — same vocabulary as the CLI's Checks line.
  const chip = $("#checkschip");
  if (chip) {
    if (data.checksRun != null) {
      chip.textContent = data.checksRun + " checks" + (data.checksSkipped ? " \u00b7 " + data.checksSkipped + " skipped" : "");
      chip.hidden = false;
      chip.title = "Open the all-checks matrix";
    } else {
      chip.hidden = true;
    }
  }

  if (data.generatedAt) {
    setStatus(data.generatedAt);
    clearInterval(statusTimer);
    statusTimer = setInterval(() => setStatus(data.generatedAt), 30000);
  }

  const reportHtml = renderReport(findings);
  if (reportHtml) {
    $("#report").innerHTML = reportHtml;
  } else if (counts.high + counts.medium === 0) {
    // Celebratory all-clean state — earned, so show it properly.
    $("#report").innerHTML =
      '<div class="cleanhero"><div class="ch-icon" aria-hidden="true">\u2713</div><div>' +
      '<div class="ch-title">Everything is clean</div>' +
      '<div class="ch-sub">' + (data.cleanStreak >= 2
        ? esc(String(data.cleanStreak)) + " clean runs in a row. Keep it up."
        : "No issues found on this machine.") + "</div></div></div>";
  } else {
    $("#report").innerHTML = '<div class="empty">Nothing to show.</div>';
  }

  document.querySelectorAll(".evidence").forEach(ev => {
    const btn = ev.parentElement.querySelector(".ev-expand");
    if (!btn) return;
    if (ev.textContent.length > 500 || ev.scrollHeight > 228) btn.hidden = false;
  });

  applyFilters();
  refreshSchedule();
  renderSystemView(data);
  updateChecksBadge(data);
  renderSecurityPosture(data);
  renderNextStep(data);
  renderCheckErrors(data);
  renderFixed(data);
  renderDiff(data);
  maybeNotify(data);
  renderTrend(counts.score);
  renderSkipped();
  applyWideGroups();
  syncDetailPane();
}
