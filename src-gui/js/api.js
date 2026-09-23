// SPDX-License-Identifier: GPL-3.0-or-later
/* === Data fetching === */
/* Desktop detection must not rely on the injected Tauri global alone: on this
   stack (wry + WebKitGTK) it has been reported missing, and the page is served
   from tauri://localhost regardless. Any of these signals is enough. */
const isDesktop = () => {
  if (typeof window === "undefined") return false;
  if (window.__TAURI_INTERNALS__ || window.__TAURI__) return true;
  try {
    return location.protocol === "tauri:" || location.hostname === "tauri.localhost";
  } catch {
    return false;
  }
};
const STATIC_DATA = typeof window !== "undefined" && window.__DATA__ ? window.__DATA__ : null;

/* Ask the desktop shell's loopback service. Its errors carry the real reason
   (missing CLI, bad resource copy) — surface them, never swallow them. */
async function desktopFetch(path, q = "") {
  let res;
  try {
    res = await fetch("http://127.0.0.1:17321" + path + q, { cache: "no-store" });
  } catch {
    throw new Error("the Linux Doctor service is not reachable on 127.0.0.1:17321 (is the app still starting?)");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let msg = body;
    try { msg = JSON.parse(body).error || body; } catch {}
    throw new Error(msg || `report service error (HTTP ${res.status})`);
  }
  return res.json();
}

/* refresh=true forces a fresh scan; save=true records the run in history.
   Background polling passes neither (the servers serve a short cached report,
   and machine history only advances on an explicit run). */
async function fetchReport({ refresh = false, save = false } = {}) {
  if (STATIC_DATA) return STATIC_DATA;
  const p = new URLSearchParams();
  if (refresh) p.set("refresh", "1");
  if (save) p.set("save", "1");
  const q = p.toString() ? `?${p}` : "";
  if (isDesktop()) return desktopFetch("/report", q);
  const res = await fetch("/api/report" + q, { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

async function fetchHistory() {
  if (STATIC_DATA) return [];
  if (isDesktop()) {
    try {
      const res = await fetch("http://127.0.0.1:17321/history", { cache: "no-store" });
      if (res.ok) return (await res.json()).runs || [];
    } catch {}
  }
  try {
    const res = await fetch("/api/history", { cache: "no-store" });
    if (res.ok) return (await res.json()).runs || [];
  } catch {}
  return [];
}

async function fetchChecks() {
  if (STATIC_DATA) return [];
  if (isDesktop()) {
    try {
      const res = await fetch("http://127.0.0.1:17321/checks", { cache: "no-store" });
      if (res.ok) return (await res.json()).checks || [];
    } catch {}
  }
  try {
    const res = await fetch("/api/checks", { cache: "no-store" });
    if (res.ok) return (await res.json()).checks || [];
  } catch {}
  return [];
}

/* check id → category map, fetched once and reused across renders.
   Fills the shared checksCategoryMap; never throws. */
async function loadCategoryMap() {
  try {
    const list = await fetchChecks();
    checksCategoryMap = new Map(list.map((c) => [c.id, c.category || "other"]));
  } catch {
    checksCategoryMap = new Map();
  }
  return checksCategoryMap;
}

/* Ignore list + history clearing. The desktop shell's loopback service answers
   the same shapes on 17321; in the browser the dashboard serves them directly.
   Both are best-effort: a missing route leaves the section empty, never throws. */
async function fetchIgnore() {
  if (STATIC_DATA) return { patterns: [], codes: [], path: "" };
  if (isDesktop()) {
    try {
      const res = await fetch("http://127.0.0.1:17321/api/ignore", { cache: "no-store" });
      if (res.ok) return await res.json();
    } catch {}
  }
  try {
    const res = await fetch("/api/ignore", { cache: "no-store" });
    if (res.ok) return await res.json();
  } catch {}
  return { patterns: [], codes: [], path: "" };
}

async function postJson(url, payload) {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return res.ok && (await res.json()).ok !== false;
  } catch {
    return false;
  }
}

async function editIgnore(payload) {
  if (isDesktop() && await postJson("http://127.0.0.1:17321/api/ignore", payload)) return true;
  return postJson("/api/ignore", payload);
}

async function clearHistoryApi() {
  const tryPost = async (url) => {
    try {
      const res = await fetch(url, { method: "POST" });
      return res.ok && (await res.json()).ok !== false;
    } catch {
      return false;
    }
  };
  if (isDesktop() && await tryPost("http://127.0.0.1:17321/api/history/clear")) return true;
  return tryPost("/api/history/clear");
}
