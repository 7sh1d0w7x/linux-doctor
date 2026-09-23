// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Local web dashboard. `doctor --web` serves a dark, card-based report in the
 * browser at 127.0.0.1. Zero dependencies: plain node:http + inline HTML/CSS/JS.
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { atomicWrite } from "./fsx.js";
import { exec } from "node:child_process";
import { dirname } from "node:path";
import { addIgnore } from "./ignore.js";
import { loadConfig, configFile } from "./config.js";
import { DEFAULT_THRESHOLDS, coerceThreshold } from "./thresholds.js";
import { timerStatus } from "./units.js";
import { shq } from "./utils.js";

/**
 * Start the dashboard. `collect` must return { system, findings, generatedAt }.
 * `render` post-processes the report before it is served at /api/report — pass
 * one to make the endpoint emit the same versioned envelope as --json.
 * `quiet` suppresses the URL banner on stdout — needed when embedding the
 * server in tests, where stdout must stay a clean TAP stream.
 */

// The only hostnames the dashboard accepts in the Host header. Binding to
// 127.0.0.1 alone does not stop a DNS-rebinding attack: a page at
// http://evil.example (resolving to 127.0.0.1) would otherwise be served with
// an attacker-chosen Host header and could read the report from the victim's
// browser. Rejecting non-loopback Host headers closes that hole.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** "127.0.0.1:43901" / "[::1]:43901" → loopback? Missing Host → not allowed. */
function isLoopbackHost(hostHeader) {
  if (!hostHeader) return false;
  const h = String(hostHeader).trim().toLowerCase();
  const name = h.startsWith("[") ? h.slice(1, h.indexOf("]")) : h.replace(/:\d+$/, "");
  return LOOPBACK_HOSTS.has(name);
}

/**
 * Browsers always send Origin on POST requests; curl/scripts do not. A POST
 * whose Origin names a non-loopback site is a cross-site request forged
 * against the config-writing endpoints (/api/ignore, /api/thresholds) and is
 * rejected. No Origin header means a non-browser client — allowed.
 */
function isLoopbackOrigin(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return LOOPBACK_HOSTS.has(u.hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

export async function startWeb({ collect, history = () => [], checkList = async () => [], schedule = () => timerStatus(), port = 43901, open = true, quiet = false, render = (d) => d, reportTtlMs = 10000 }) {
  // A short report cache with single-flight. GETs need no Origin, so without
  // this any web page could <img src="127.0.0.1:43901/api/report"> and force
  // a full scan per request. Concurrent/repeated hits share one scan; the
  // dashboard's explicit "Re-run" sends ?refresh=1 to bypass the TTL.
  const REPORT_TTL_MS = reportTtlMs;
  let reportCache = { at: 0, body: null };
  let reportInflight = null;
  const server = http.createServer(async (req, res) => {
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden — the dashboard answers to loopback Host headers only");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers.origin && !isLoopbackOrigin(req.headers.origin)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden — cross-origin requests are not accepted");
      return;
    }
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/report") {
      try {
        const refresh = url.searchParams.get("refresh") === "1";
        // save=1 comes from an explicit Re-run; it must record history and
        // therefore never be served from (or stored as) a plain poll cache.
        const save = url.searchParams.get("save") === "1";
        const hasCache = reportCache.body !== null;
        const fresh = hasCache && Date.now() - reportCache.at < REPORT_TTL_MS;
        let body;
        if (!refresh && !save && fresh) {
          body = reportCache.body;
        } else if (save) {
          // An explicit Re-run records history and must never be satisfied by
          // an in-flight background poll, which does not save: run it on its
          // own, then refresh the cache.
          const data = await collect(true);
          const out = render(data);
          body = typeof out === "string" ? out : JSON.stringify(out);
          reportCache = { at: Date.now(), body };
        } else if (!refresh && hasCache) {
          // Stale-while-revalidate: a background poll answers instantly with
          // the last report and regenerates behind it, so the UI never waits on
          // a full scan. The next poll picks up the new report.
          body = reportCache.body;
          if (!reportInflight) {
            reportInflight = (async () => {
              const data = await collect(false);
              const out = render(data);
              reportCache = { at: Date.now(), body: typeof out === "string" ? out : JSON.stringify(out) };
            })().catch(() => {}).finally(() => { reportInflight = null; });
          }
        } else {
          // First paint or an explicit non-saving refresh: single-flight scan.
          if (!reportInflight) {
            reportInflight = (async () => {
              const data = await collect(false);
              const out = render(data);
              return typeof out === "string" ? out : JSON.stringify(out);
            })().finally(() => { reportInflight = null; });
          }
          body = await reportInflight;
          reportCache = { at: Date.now(), body };
        }
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(body);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    if (url.pathname === "/api/history" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ runs: history() }));
      return;
    }
    if (url.pathname === "/api/checks" && req.method === "GET") {
      try {
        const checks = await checkList();
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ checks }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    // Read-only schedule state for the dashboard's "Daily check" strip:
    // whether the user timer is installed/enabled/active. No actions here —
    // installing stays a CLI decision (linux-doctor --install-timer).
    if (url.pathname === "/api/schedule" && req.method === "GET") {
      try {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ schedule: schedule() }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    if (url.pathname === "/api/ignore" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const pattern = JSON.parse(body || "{}").pattern;
        const ok = addIgnore(pattern);
        res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
      }
      return;
    }
    if (url.pathname === "/api/thresholds" && req.method === "GET") {
      try {
        const cfg = loadConfig();
        const thresholds = { ...DEFAULT_THRESHOLDS, ...(cfg.thresholds || {}) };
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ thresholds, defaults: DEFAULT_THRESHOLDS }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    if (url.pathname === "/api/thresholds" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const incoming = JSON.parse(body || "{}").thresholds || JSON.parse(body || "{}");
        const cfg = loadConfig();
        const next = { ...cfg, thresholds: { ...(cfg.thresholds || {}), ...incoming } };
        // only allow known keys; drop non-numeric values (e.g. "90%")
        const clean = {};
        for (const k of Object.keys(DEFAULT_THRESHOLDS)) if (k in next.thresholds) {
          const v = coerceThreshold(next.thresholds[k]);
          if (v !== null) clean[k] = v;
        }
        next.thresholds = clean;
        const file = configFile();
        if (!atomicWrite(file, JSON.stringify(next, null, 2) + "\n")) throw new Error("could not write " + file);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, thresholds: clean }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  // The default port (43901) gives the dashboard a stable, predictable URL —
  // it survives across runs and across browsers. If it is already taken (a
  // second instance), fall back to a random free port instead of crashing.
  const listen = (p) =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(p, "127.0.0.1", resolve);
    });
  try {
    await listen(port);
  } catch {
    await listen(0);
  }
  const url = `http://127.0.0.1:${server.address().port}`;

  if (open) {
    try {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? 'start ""' : "xdg-open";
      exec(`${opener} ${shq(url)} >/dev/null 2>&1 &`, () => {});
    } catch {
      /* browser may not exist; the printed URL is enough */
    }
  }
  if (!quiet) console.log(`🩺 Linux Doctor dashboard: ${url}  (Ctrl+C to stop)`);
  return server;
}

const PAGE = readFileSync(new URL("../src-gui/index.html", import.meta.url), "utf8");
