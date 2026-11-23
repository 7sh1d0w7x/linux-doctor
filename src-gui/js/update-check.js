/* === Update indicator ===
   The desktop tray says when a release exists; the dashboard and the --web page
   did not. One unauthenticated GitHub API call per page load (60/hour per IP,
   and this runs once, not on every poll). Any failure is silent: a version
   check must never take the dashboard down with it. */
function versionParts(v) {
  return String(v || "")
    .replace(/^v/, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
}

function isNewerVersion(candidate, current) {
  const a = versionParts(candidate);
  const b = versionParts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function fetchLatestRelease() {
  try {
    const r = await fetch("https://api.github.com/repos/7sh1d0w7x/linux-doctor/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const version = String(j.tag_name || "").replace(/^v/, "");
    if (!version) return null;
    return { version, url: j.html_url };
  } catch {
    return null;
  }
}

async function showUpdateIndicator(currentVersion) {
  if (!currentVersion) return;
  const latest = await fetchLatestRelease();
  if (!latest || !isNewerVersion(latest.version, currentVersion)) return;
  const info = document.querySelector(".sysinfo");
  if (!info || info.querySelector(".updatechip")) return;
  const a = document.createElement("a");
  a.className = "updatechip";
  a.href = latest.url;
  a.target = "_blank";
  a.rel = "noopener";
  a.title = "A newer release is available";
  a.textContent = "v" + latest.version + " available";
  info.appendChild(document.createTextNode(" · "));
  info.appendChild(a);
}
