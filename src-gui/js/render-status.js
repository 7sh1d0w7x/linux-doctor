// SPDX-License-Identifier: GPL-3.0-or-later
/* === Status zone: gauge, score, status message — PREMIUM HIERARCHY === */
const SCORE_RING_R = 26;
const SCORE_RING_C = 2 * Math.PI * SCORE_RING_R;

function renderGauge(score, size) {
  const s = size || 96;
  const scoreColor = score >= 80 ? "var(--green)" : score >= 50 ? "var(--yellow)" : "var(--red)";
  return '<div class="gauge' + (s > 96 ? ' large' : '') + '" style="width:' + s + 'px;height:' + s + 'px">' +
    '<svg viewBox="0 0 62 62" role="img" aria-label="Health score ' + score + ' of 100">' +
    '<circle class="track" cx="31" cy="31" r="' + SCORE_RING_R + '"></circle>' +
    '<circle class="ring" id="scorering" cx="31" cy="31" r="' + SCORE_RING_R + '" ' +
    'transform="rotate(-90 31 31)" stroke="' + scoreColor + '" ' +
    'stroke-dasharray="' + SCORE_RING_C + '" stroke-dashoffset="' + SCORE_RING_C + '"></circle>' +
    '</svg>' +
    '<div class="gauge-center"><div class="scorenum" id="scorenum">0</div><div class="scoreout">/100</div></div>' +
    '</div>';
}

function animateScore(target) {
  const num = $("#scorenum");
  const live = $("#scorering");
  const dot = $("#pulsedot");
  if (!num) return;
  let reduce = false;
  try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch {}
  /* The trace is drawn up to the score and ends in a dot — the machine's own
     vital sign. pathLength="100" makes the dash arithmetic trivial. */
  const setPulse = (v) => {
    if (live) live.style.strokeDashoffset = String(100 - v);
    if (dot) dot.setAttribute("cx", String((120 * v) / 100));
  };
  if (reduce) {
    num.textContent = target;
    setPulse(target);
    return;
  }
  const t0 = performance.now();
  const dur = 900;
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const v = target * (1 - Math.pow(1 - p, 3));
    num.textContent = Math.round(v);
    setPulse(v);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* The product's own motif: a heartbeat, not a dashboard gauge. Same waveform
   as the brand mark and the favicon, but the shape comes from the report —
   a steady monitoring rhythm, with one taller beat for every finding that
   needs attention (taller still for a high severity). A clean machine draws
   the rhythm alone. */
function pulsePath(w, amps) {
  const mid = 14;
  if (!amps.length) return "M0 " + mid + " H" + w;
  const step = w / amps.length;
  let d = "M0 " + mid;
  amps.forEach((amp, i) => {
    const a = 3.5 + 9 * amp;
    const peak = 16 - a;
    const trough = peak + a * 0.6 + 3;
    d += " H" + (i * step + step * 0.42).toFixed(1);
    d += " l2 2 l1 " + (-a).toFixed(1) + " l1 " + (a * 0.6 + 3).toFixed(1) + " l2 " + (-(trough - mid)).toFixed(1);
    d += " H" + ((i + 1) * step).toFixed(1);
  });
  return d;
}

/* What the trace is made of: a fixed monitoring rhythm, with the beats that
   carry a finding made taller in proportion to its severity. */
function pulseTrace(findings) {
  const high = findings.filter((f) => f.severity === "high").length;
  const med = findings.filter((f) => f.severity === "medium").length;
  const issues = Math.min(5, high + med);
  const amp = high ? 1 : med ? 0.55 : 0;
  return pulsePath(120, [1, 2, 3, 4, 5].map((_, i) => (i < issues ? amp : 0.16)));
}

function renderStatusMessage(findings) {
  const high = findings.filter((f) => f.severity === "high").length;
  const med = findings.filter((f) => f.severity === "medium").length;
  const inf = findings.filter((f) => f.severity === "info").length;
  let headline, sublabel, level;
  if (high + med === 0) {
    if (findings.length === 0) {
      headline = "Healthy";
      sublabel = "No high or medium issues — no issues detected";
    } else {
      headline = "Healthy";
      sublabel = "No high or medium issues — " + inf + " informational " + (inf === 1 ? "note" : "notes") + " — no action needed";
    }
    level = "ok";
  } else if (high > 0) {
    headline = high === 1 ? "Needs attention" : "Needs attention";
    sublabel = high + " high-severity " + (high === 1 ? "issue" : "issues") + (med ? " · " + med + " warnings" : "");
    level = "critical";
  } else {
    headline = "Needs attention";
    sublabel = med + " " + (med === 1 ? "issue needs" : "issues need") + " attention";
    level = "warn";
  }
  return { headline, sublabel, level, high, med, inf };
}

function renderStatus(data) {
  const { findings = [], system = {} } = data;
  const ver = (data.version || "").replace(/^v/, "");
  $(".sysinfo").innerHTML =
    [esc(system.distro), esc(system.kernel), esc((system.cores || "?") + " core(s)"), "up " + esc(system.uptime)].filter(Boolean).join(" · ") +
    (ver ? ' · <span class="ver">v' + esc(ver) + "</span>" : "");

  const high = findings.filter((f) => f.severity === "high").length;
  const med = findings.filter((f) => f.severity === "medium").length;
  const inf = findings.filter((f) => f.severity === "info").length;

  const { headline, sublabel } = renderStatusMessage(findings);

  const scoreDelta = typeof data.scoreDelta === "number" ? data.scoreDelta : null;
  const deltaCls = scoreDelta === null ? "" : scoreDelta > 0 ? "delta-up" : scoreDelta < 0 ? "delta-down" : "delta-flat";
  const deltaIcon = scoreDelta === null ? "" : scoreDelta > 0 ? "↗" : scoreDelta < 0 ? "↘" : "→";
  const deltaTxt = scoreDelta === null ? "no baseline yet" : (scoreDelta > 0 ? "+" + scoreDelta : String(scoreDelta)) + " since last check";
  const score = typeof data.score === "number" ? data.score : 0;

  const chips =
    (data.newCount > 0 ? '<span class="newbadge">NEW ' + data.newCount + "</span>" : "") +
    (data.fixedCount > 0 ? '<span class="fixedbadge">FIXED ' + data.fixedCount + "</span>" : "");

  const status = $("#status");
  /* The score lives in the rail now: a compact Health block — number, a
     progress hairline, the headline and one counts line. No gauge, no KPI
     tiles: those belong to a dashboard, and this is an application. */
  const band = score >= 80 ? "ok" : score >= 50 ? "warn" : "bad";
  status.className = "status " + band;
  const deltaShort = scoreDelta === null ? "" : (scoreDelta > 0 ? "+" + scoreDelta : String(scoreDelta));
  const trace = pulseTrace(findings);

  status.innerHTML =
    '<div class="sr-head">' +
      '<span class="sr-k">Health</span>' +
      (scoreDelta === null ? "" :
        '<span class="scoredelta ' + deltaCls + '" title="' + esc(deltaTxt) + '">' + deltaIcon + " " + deltaShort + "</span>") +
    "</div>" +
    '<div class="sr-score"><span class="sr-num" id="scorenum">0</span><span class="sr-out">/100</span></div>' +
    '<div class="sr-pulse" role="img" aria-label="Health score ' + score + " of 100\">" +
      '<svg viewBox="0 0 120 22" preserveAspectRatio="none" aria-hidden="true">' +
        '<path class="pulse-track" d="' + trace + '" pathLength="100" vector-effect="non-scaling-stroke"></path>' +
        '<path class="pulse-live" id="scorering" d="' + trace + '" pathLength="100" vector-effect="non-scaling-stroke" style="stroke-dashoffset:100"></path>' +
      "</svg>" +
      '<span class="pulse-dot" id="pulsedot" aria-hidden="true" style="left:' + score + '%"></span>' +
    "</div>" +
    '<div class="sr-msg status-headline">' + esc(headline) + "</div>" +
    '<div class="sr-line">' +
      (high + med > 0
        ? '<b>' + high + "</b> high · <b>" + med + "</b> medium" + (inf ? " · " + inf + " info" : "")
        : esc(sublabel)) +
    "</div>" +
    '<div class="sr-meta">' +
      chips +
      '<span id="hero-spark" class="chip-trend" hidden></span>' +
      '<button id="checkschip" type="button" class="lowbadge" hidden></button>' +
    "</div>" +
    '<div class="sr-foot">' +
      '<span class="sr-fresh"><span class="dot" id="statusdot"></span> <span id="statuspill-txt"></span></span>' +
    "</div>";

  animateScore(score);
  return { high, medium: med, info: inf, score };
}
