// SPDX-License-Identifier: GPL-3.0-or-later
/* === System view: the machine wiki ===
   A complete, readable profile from the report payload — no new probes, no
   new endpoints. Sections mirror how admins actually ask about a box: what
   OS, what hardware, what session. Rendered on every report so the view
   never goes stale behind Overview. */

function fmtGB(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return null;
  return (bytes / 1024 ** 3).toFixed(1) + " GB";
}

function systemType(sys) {
  if (sys.atomicVariant) return "immutable (" + sys.atomicVariant + ")";
  if (sys.imageBased || sys.immutable) return "immutable";
  return "classic";
}

/* A fact row. Values that are identifiers (kernel, hostname, version, the
   profile, the desktop) are mono and copyable — clicking copies, the same
   delegated data-copy handler the findings use. */
function systemFactsHtml(data) {
  const sys = data.system || {};
  const counts = { high: 0, medium: 0, info: 0 };
  for (const f of data.findings || []) counts[f.severity] = (counts[f.severity] || 0) + 1;
  const fact = (k, v, opts) => {
    opts = opts || {};
    const val = v == null || v === "" ? "\u2014" : String(v);
    const cell = opts.copy
      ? '<button class="idval" type="button" data-copy="' + esc(val) + '" title="Copy ' + esc(val) + '" aria-label="Copy ' + esc(k) + '">' + esc(val) + "</button>"
      : '<span' + (opts.mono ? ' class="mono"' : "") + ">" + esc(val) + "</span>";
    return '<div class="sysfact"><span class="sysfact-k">' + k + '</span><span class="sysfact-v">' + cell + "</span></div>";
  };
  const sub = (t, d) => '<div class="sys-sub">' + t + (d ? '<span class="sys-sub-d">' + d + "</span>" : "") + "</div>";
  const rows = (n) => '<span class="vsec-count">' + n + (n === 1 ? " fact" : " facts") + "</span>";
  const group = (label, n, body) => '<section class="vsec"><div class="vsec-head">' + label + rows(n) + "</div>" + body + "</section>";

  const mem = fmtGB(sys.memTotalBytes);
  const cpu = [sys.cpuModel, sys.cores && sys.cores !== "unknown" ? sys.cores + " cores" : null]
    .filter(Boolean).join(" \u00b7 ") || null;

  const os = sub("Operating system", "what software this machine runs") +
    fact("Distribution", sys.distro) +
    fact("Version", (sys.osRelease || {}).VERSION_ID, { copy: true }) +
    fact("Family", sys.family) +
    fact("Architecture", sys.arch, { mono: true }) +
    fact("Kernel", sys.kernel, { copy: true }) +
    fact("System type", systemType(sys)) +
    fact("Package manager", (sys.atomic || {}).pkg, { mono: true });
  const hw = sub("Hardware", "What this machine is") +
    fact("CPU", cpu) +
    fact("Memory", mem, { mono: true }) +
    fact("Hostname", sys.hostname, { copy: true });

  const session = sub("Session", "how this machine is running right now") +
    fact("Uptime", sys.uptime) +
    fact("Profile", sys.kind, { copy: true }) +
    fact("Desktop", sys.desktop, { copy: true }) +
    fact("Session type", sys.sessionType);
  const report = sub("This report", "how this run turned out") +
    fact("Health score", typeof data.score === "number" ? data.score + "/100" : "\u2014", { mono: true }) +
    fact("Findings", counts.high + " high \u00b7 " + counts.medium + " medium \u00b7 " + counts.info + " info") +
    fact("Checks", (data.checksRun != null ? data.checksRun + " ran" : "\u2014") +
      (data.checksSkipped ? " \u00b7 " + data.checksSkipped + " skipped" : "")) +
    fact("Generated", data.generatedAt, { mono: true });

  return group("Read once \u2014 what this machine is", 10, os + hw) +
    group("Read when something's wrong", 8, session + report);
}

function renderSystemView(data) {
  const box = $("#systemview");
  if (!box) return;
  box.innerHTML = systemFactsHtml(data || {});
}
