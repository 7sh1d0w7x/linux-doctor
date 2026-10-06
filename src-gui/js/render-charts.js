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
  const W = 240, H = 44, pad = 4;
  const scores = data.map((r) => r.score);
  const min = Math.min(...scores), max = Math.max(...scores);
  const span = Math.max(1, max - min);
  const X = (i) => pad + (i * (W - 2 * pad)) / (scores.length - 1);
  const Y = (s) => H - pad - ((s - min) / span) * (H - 2 * pad);
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
    '<circle data-idx="' + i + '" cx="' + p[0] + '" cy="' + p[1] + '" r="5" fill="transparent" class="hist-dot" tabindex="0" role="button" aria-label="Run ' + (i + 1) + " of " + scores.length + ": " + scores[i] + "/100, " + fmtWhen(data[i].at) + ' — open the diff">' +
    '<title>' + scores[i] + "/100 · " + fmtWhen(data[i].at) + ' — click to show diff</title></circle>').join("");
  const end = pts[pts.length - 1];
  const thresh = (min < 50 && max > 50)
    ? '<line x1="' + pad + '" y1="' + Y(50).toFixed(1) + '" x2="' + (W - pad) + '" y2="' + Y(50).toFixed(1) + '" stroke="var(--muted2)" stroke-width="1" stroke-dasharray="3 3" opacity="0.5"/>'
    : "";
  // Hero for history: large score + direction
  const hero = '<div class="trend-hero"><div class="trend-hero-score"><span class="trend-hero-num ' + dir.cls + '">' + last + '</span><span class="trend-hero-out">/100</span></div>' +
    '<div class="trend-hero-meta"><span class="trend-direction ' + dir.cls + '">' + dir.icon + ' ' + dir.txt + '</span><span class="trend-hero-range">' + range + '</span></div></div>';
  return '<div class="trendchart">' +
    hero +
    '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Health score trend">' +
    thresh + '<path d="' + area + '" fill="' + dir.col + '" opacity="0.10"/>' +
    '<polyline points="' + line + '" fill="none" stroke="' + dir.col + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
    dots + '<circle cx="' + end[0] + '" cy="' + end[1] + '" r="2.5" fill="' + dir.col + '" stroke="var(--card)" stroke-width="1.5"/></svg>' +
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
    const tip = "high: " + c.high + " · medium: " + c.medium + " · info: " + c.info + (fmtWhen(c.at) ? " · " + fmtWhen(c.at) : "");
    return '<g data-idx="' + i + '" class="hist-bar" tabindex="0" role="button" aria-label="Run ' + (i + 1) + ": " + tip + ' — open the diff">' +
      '<rect x="' + x + '" y="' + yInfo + '" width="' + bw.toFixed(1) + '" height="' + iH.toFixed(1) + '" rx="2" fill="var(--blue)" opacity="0.7"><title>' + tip + ' — click</title></rect>' +
      '<rect x="' + x + '" y="' + yMed + '" width="' + bw.toFixed(1) + '" height="' + mH.toFixed(1) + '" rx="2" fill="var(--yellow)" opacity="0.85"><title>' + tip + '</title></rect>' +
      '<rect x="' + x + '" y="' + yHigh + '" width="' + bw.toFixed(1) + '" height="' + hH.toFixed(1) + '" rx="2" fill="var(--red)" opacity="0.9"><title>' + tip + '</title></rect></g>';
  }).join("");
  return '<div class="trendchart">' +
    '<div class="trendtitle" style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;color:var(--muted2)">Findings by severity</div>' +
    '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Severity over time">' + bars + '</svg>' +
    '<div class="sevlegend"><span class="lg high"></span>needs attention <span class="lg medium"></span>warnings <span class="lg info"></span>observations</div>' +
    '</div>';
}
