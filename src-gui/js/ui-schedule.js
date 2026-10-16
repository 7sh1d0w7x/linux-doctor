// SPDX-License-Identifier: GPL-3.0-or-later
/* === Schedule strip: is the daily check actually scheduled? ===
   The dashboard used to know only "Re-run now". This strip answers the
   follow-up question — will the machine check itself tomorrow? Read-only:
   installing stays a CLI decision; the strip shows state plus the exact
   command to copy. Hidden when the backend has no schedule to report
   (static --html exports, unreachable API). */

async function fetchSchedule() {
  if (STATIC_DATA) return null;
  try {
    const res = await fetch("/api/schedule", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()).schedule || null;
  } catch {
    return null;
  }
}

function browserNotifyState() {
  try {
    if (!("Notification" in window)) return "unavailable";
    if (Notification.permission === "granted") return "on";
    return "off";
  } catch {
    return "unavailable";
  }
}

/* Pure (string in, string out) so dashboard-state.test.js can pin it. */
function scheduleHtml(s, notify) {
  if (!s) return "";
  const dot = (on) => '<span class="dot' + (on ? "" : " stale") + '" aria-hidden="true"></span>';
  // Dot and label wrap as one unit — a separator stranded at line end reads
  // as a dangling bullet on narrow screens.
  const notifyBit = notify === "unavailable" ? ""
    : '<span class="sched-note"><span class="sched-sep" aria-hidden="true">·</span><span>' + dot(notify === "on") +
      "Browser alerts " + (notify === "on" ? "on" : "off") + "</span></span>";
  if (!s.installed) {
    return dot(false) + "<span><b>Daily check off</b> — install the timer and the machine notifies you only when something new breaks.</span>" +
      '<button class="toolbtn" data-copy="linux-doctor --install-timer">Copy setup command</button>' + notifyBit;
  }
  if (s.active) {
    return dot(true) + "<span><b>Daily check on</b> — runs after boot, then daily · notifies only on new findings.</span>" + notifyBit;
  }
  return dot(false) + "<span><b>Daily check needs attention</b> — timer units exist but the timer isn't active. Re-run <span class=\"mono\">linux-doctor --install-timer</span>.</span>" +
    '<button class="toolbtn" data-copy="linux-doctor --install-timer">Copy setup command</button>' + notifyBit;
}

/* The shared notices row is visible when at least one notice is. Both
   renderers call this after updating, so async schedule fetches and sync
   posture renders converge on the same visibility. */
function syncNotices() {
  const wrap = $("#notices");
  if (!wrap) return;
  const kids = [...wrap.children];
  wrap.hidden = kids.length === 0 || kids.every((k) => k.hidden);
  syncNoticeGrid();
}

function renderSchedule(s) {
  const el = $("#schedstrip");
  if (!el) return;
  const html = scheduleHtml(s, browserNotifyState());
  if (!html) { el.hidden = true; el.innerHTML = ""; }
  else { el.hidden = false; el.innerHTML = html; }
  syncNotices();
}

/* Schedule view: the full picture — last run, next run, timer state, and the
   exact commands as recipes. Pure builders kept separate for tests. */

/* Coarse relative freshness for the "last run" cell. */
function schedAgo(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "\u2014";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

/* The command IS the information, so it is printed, not hidden behind a
   button: an accent-ruled mono slip — the same recipe language as the
   findings' Recommended next step — with a quiet copy next to it. */
function recipeHtml(cmd, primary) {
  return '<div class="recipe"><code class="recipe-cmd">' + esc(cmd) + "</code>" +
    '<button class="recipe-copy' + (primary ? " primary" : "") + '" type="button" data-copy="' + esc(cmd) + '" title="Copy this command">Copy</button></div>';
}

function scheduleViewHtml(s, notify, generatedAt) {
  const notifyBit = notify === "unavailable" ? ""
    : '<span class="sched-note"><span class="sched-sep" aria-hidden="true">\u00b7</span><span>Browser alerts ' + (notify === "on" ? "on" : "off") + "</span></span>";
  if (!s) {
    return '<section class="vsec"><div class="vsec-head">Scheduled checks</div>' +
      '<div class="sched-none">Schedule state is unavailable (static export or unreachable API).</div></section>';
  }
  const on = !!s.active;
  const needs = s.installed && !s.active;
  const state = on ? "on" : needs ? "needs attention" : "off";
  const lastMs = Date.parse(generatedAt || "");
  const nextTxt = on && Number.isFinite(lastMs)
    ? "by " + fmtWhen(new Date(lastMs + 86400000).toISOString())
    : "\u2014";
  const nextTitle = "The installed timer runs 24h after its last activation; Persistent catches up runs missed while the machine was off.";
  const instr =
    '<div class="sched-instr">' +
      '<div class="si"><span class="si-k">Last run</span><span class="si-v">' + esc(schedAgo(generatedAt)) + "</span></div>" +
      '<div class="si"><span class="si-k">Next run</span><span class="si-v" title="' + esc(nextTitle) + '">' + esc(nextTxt) + "</span></div>" +
      '<div class="si"><span class="si-k">Timer</span><span class="si-v"><span class="dot' + (on ? "" : " stale") + '" aria-hidden="true"></span>' + esc(state) + "</span></div>" +
    "</div>" +
    '<div class="sched-cap">shortly after boot, then every 24h \u00b7 Persistent \u2014 catches up runs missed while the machine was off' + notifyBit + "</div>";
  const idle = on
    ? '<p class="sched-idle">Nothing to do \u2014 the timer runs the checks by itself and speaks up only when something new breaks.</p>'
    : "";
  const setup = on ? "" :
    '<section class="vsec"><div class="vsec-head">Set it up</div>' + recipeHtml("linux-doctor --install-timer", true) + "</section>";
  const manage = '<section class="vsec"><div class="vsec-head">Manage</div>' +
    recipeHtml("linux-doctor --install-timer") +
    recipeHtml("linux-doctor --uninstall-timer") + "</section>";
  const pro = '<section class="vsec"><div class="vsec-head">Remote delivery <span class="vsec-sub">[Pro]</span></div>' +
    recipeHtml("linux-doctor --alert https://ntfy.sh/your-topic") +
    recipeHtml("linux-doctor --heartbeat https://hc-ping.com/your-uuid") + "</section>";
  return '<section class="vsec"><div class="vsec-head">Scheduled checks</div>' + instr + idle + "</section>" + setup + manage + pro;
}

async function renderScheduleView() {
  const box = $("#schedview");
  if (!box) return;
  box.innerHTML = scheduleViewHtml(await fetchSchedule(), browserNotifyState(), (lastReportData || {}).generatedAt);
}

function refreshSchedule() {
  fetchSchedule().then(renderSchedule);
}
