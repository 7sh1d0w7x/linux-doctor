// SPDX-License-Identifier: GPL-3.0-or-later
/* === SVG charts: score sparkline + severity bars — premium, compact, diagnostic === */
function fmtWhen(at) {
  const d = new Date(at);
  if (isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return (d.getMonth() + 1) + "/" + d.getDate() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/* Tiny inline sparkline for the hero meta row */
function miniSpark(data) {
  const W = 80, H = 18, pad = 2;
  const scores = data.map((r) => r.score);
  if (scores.length < 2) return "";
  const min = Math.min(...scores), max = Math.max(...scores);
  const span = Math.max(1, max - min);
  const X = (i) => pad + (i * (W - 2 * pad)) / (scores.length - 1);
  const Y = (s) => H - pad - ((s - min) / span) * (H - 2 * pad);
  const line = scores.map((s, i) => X(i).toFixed(1) + "," + Y(s).toFixed(1)).join(" ");
  const last = scores[scores.length - 1], first = scores[0];
  const color = last > first ? "var(--green)" : last < first ? "var(--red)" : "var(--muted2)";
  return '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Trend, last ' + scores.length + ' runs">' +
    '<polyline points="' + line + '" fill="none" stroke="' + color + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function scoreChart(data) {
  const W = 240, H = 34, pad = 4;
  const scores = data.map((r) => r.score);
  const min = Math.min(...scores), max = Math.max(...scores);
  const span = Math.max(1, max - min);
  /* A flat series has no shape to show; pin it to the middle of the trace
     instead of drawing a hairline along the floor, which reads as a border.
     "Middle" is the score's own height though: a flat 100 belongs at the top
     of the plot, a flat 60 just above the floor. */
  const flat = max === min;
  const X = (i) => pad + (i * (W - 2 * pad)) / (scores.length - 1);
  const Y = (s) => (flat
    ? H - pad - (Math.max(0, Math.min(100, s)) / 100) * (H - 2 * pad)
    : H - pad - ((s - min) / span) * (H - 2 * pad));
  const pts = scores.map((s, i) => [X(i).toFixed(1), Y(s).toFixed(1)]);
  const last = scores[scores.length - 1];
  const first = scores[0];
  const dir = last > first ? { txt: "Improving", icon: "↗", cls: "up", col: "var(--green)" }
    : last < first ? { txt: "Declining", icon: "↘", cls: "down", col: "var(--red)" }
    : { txt: "Stable", icon: "→", cls: "flat", col: "var(--muted2)" };
  const range = scores.length + " runs · " + first + " → " + last;
  const line = pts.map((p) => p.join(",")).join(" ");
  const area = "M" + line.replace(/ /g, " L") + " L" + (W - pad) + "," + (H - pad) + " L" + pad + "," + (H - pad) + " Z";
  const dots = pts.map((p, i) =>
    // A flat series has no shape, so each run gets a visible mark: twelve
    // readings in a row read as twelve readings, not as a stray line. The
    // mark is decorative; the transparent circle on top is the control.
    (flat ? '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="2.2" fill="' + dir.col + '" opacity="0.75" class="hist-dotmark" pointer-events="none"/>' : "") +
    '<circle data-idx="' + i + '" cx="' + p[0] + '" cy="' + p[1] + '" r="5" fill="transparent" class="hist-dot" tabindex="0" role="button" aria-label="Run ' + (i + 1) + " of " + scores.length + ": " + scores[i] + "/100, " + fmtWhen(data[i].at) + ' — open the diff">' +
    '<title>' + scores[i] + "/100 · " + fmtWhen(data[i].at) + ' — click to show diff</title></circle>').join("");
  const end = pts[pts.length - 1];
  const thresh = (min < 50 && max > 50)
    ? '<line x1="' + pad + '" y1="' + Y(50).toFixed(1) + '" x2="' + (W - pad) + '" y2="' + Y(50).toFixed(1) + '" stroke="var(--muted2)" stroke-width="1" stroke-dasharray="3 3" opacity="0.5"/>'
    : "";
  // A floor under the trace: without it a flat series (same score every run)
  // draws a line in mid-air and reads as a divider rather than a reading.
  const floor = '<line x1="' + pad + '" y1="' + (H - pad) + '" x2="' + (W - pad) + '" y2="' + (H - pad) + '" stroke="var(--border)" stroke-width="1"/>';
  // Hero for history: large score + direction, and the trace directly under
  // it — one instrument, the same shape-from-data language as the rail's
  // vitals pulse. The run window is printed under the severity chart beside
  // it, so the trace does not repeat it.
  const hero = '<div class="trend-hero"><div class="trend-hero-score"><span class="trend-hero-num ' + dir.cls + '">' + last + '</span><span class="trend-hero-out">/100</span></div>' +
    '<div class="trend-hero-meta"><span class="trend-direction ' + dir.cls + '">' + dir.icon + ' ' + dir.txt + '</span><span class="trend-hero-range">' + range + '</span></div></div>';
  const from = data[0] && fmtWhen(data[0].at);
  const to = data[data.length - 1] && fmtWhen(data[data.length - 1].at);
  return '<div class="trendchart">' +
    hero +
    '<div class="hist-trace"><svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Health score trend, ' + from + ' to ' + to + '">' +
    (flat ? "" : floor + thresh + '<path d="' + area + '" fill="' + dir.col + '" opacity="0.10"/>') +
    '<polyline points="' + line + '" fill="none" stroke="' + dir.col + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
    dots + '<circle cx="' + end[0] + '" cy="' + end[1] + '" r="2.5" fill="' + dir.col + '" stroke="var(--card)" stroke-width="1.5"/></svg></div>' +
    '<div class="trendtitle" style="margin-top:6px"><b>' + last + '/100</b> <span class="' + dir.cls + '">' + dir.txt + '</span> <span class="trendrange">' + range + '</span></div>' +
    '</div>';
}

function severityChart(data) {
  const W = 280, H = 52, spad = 6, sgap = 3;
  const counts = data.map((r) => ({
    high: (r.counts && r.counts.high) || 0,
    medium: (r.counts && r.counts.medium) || 0,
    info: (r.counts && r.counts.info) || 0,
    at: r.at,
  }));
  const maxTotal = Math.max(1, ...counts.map((c) => c.high + c.medium + c.info));
  const n = counts.length;
  const bw = (W - 2 * spad - (n - 1) * sgap) / n;
  const totalH = H - 2 * spad;
  const bars = counts.map((c, i) => {
    const x = (spad + i * (bw + sgap)).toFixed(1);
    const iH = totalH * c.info / maxTotal;
    const mH = totalH * c.medium / maxTotal;
    const hH = totalH * c.high / maxTotal;
    const yInfo = (H - spad - iH).toFixed(1);
    const yMed = (H - spad - iH - mH).toFixed(1);
    const yHigh = (H - spad - iH - mH - hH).toFixed(1);
    const tip = "high: " + c.high + " · medium: " + c.medium + " · info: " + c.info;
    const when = fmtWhen(c.at);
    // Every run is one bar and every bar is dated: the segments carry the
    // counts, and a full-height transparent target on top of them makes the
    // whole column hoverable — a run with one observation is a 6-pixel bar,
    // which is not a target anyone can point at. The date leads the tooltip
    // because "which run is this?" is the question the chart cannot answer
    // by itself.
    return '<g data-idx="' + i + '" class="hist-bar" tabindex="0" role="button" aria-label="Run ' + (i + 1) + ": " + tip + (when ? " · " + when : "") + ' — open the diff">' +
      '<rect class="sev-seg" x="' + x + '" y="' + yInfo + '" width="' + bw.toFixed(1) + '" height="' + iH.toFixed(1) + '" rx="2" fill="var(--blue)" opacity="0.7"/>' +
      '<rect class="sev-seg" x="' + x + '" y="' + yMed + '" width="' + bw.toFixed(1) + '" height="' + mH.toFixed(1) + '" rx="2" fill="var(--yellow)" opacity="0.85"/>' +
      '<rect class="sev-seg" x="' + x + '" y="' + yHigh + '" width="' + bw.toFixed(1) + '" height="' + hH.toFixed(1) + '" rx="2" fill="var(--red)" opacity="0.9"/>' +
      '<rect class="sev-hit" x="' + x + '" y="' + spad + '" width="' + bw.toFixed(1) + '" height="' + totalH.toFixed(1) + '" fill="transparent" pointer-events="all">' +
      "<title>" + (when ? when + " \u00b7 " : "") + tip + " \u2014 click to show the diff</title></rect></g>";
  }).join("");
  const oldest = counts.length ? fmtWhen(counts[0].at) : "";
  const newest = counts.length ? fmtWhen(counts[counts.length - 1].at) : "";
  const axis = (oldest || newest)
    ? '<div class="sev-axis"><span>' + (oldest || "\u2014") + "</span><span>" + (newest || "\u2014") + "</span></div>"
    : "";
  return '<div class="trendchart">' +
    '<div class="trendtitle" style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;color:var(--muted2)">Findings by severity</div>' +
    '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Severity over time">' + bars + '</svg>' +
    axis +
    '<div class="sevlegend"><span class="lg high"></span>needs attention <span class="lg medium"></span>warnings <span class="lg info"></span>observations</div>' +
    '</div>';
}
