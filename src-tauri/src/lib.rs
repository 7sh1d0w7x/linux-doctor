// SPDX-License-Identifier: GPL-3.0-or-later
//! Linux Doctor desktop shell.
//!
//! This crate is intentionally thin: it renders the shared dashboard
//! (`src-gui/index.html`) in a native window and runs the existing Node CLI
//! (`bin/doctor.js --json`) to produce the report. All health-check logic
//! lives in the Node side — the Rust code only shells out to it.
//!
//! ## Why a loopback HTTP server instead of Tauri IPC?
//!
//! Tauri's IPC relies on initialization scripts injected into the webview
//! (`window.__TAURI_INTERNALS__`). With wry 0.55 + WebKitGTK 2.52 these
//! injected scripts do not work: `__TAURI_INTERNALS__` is never defined, and
//! enabling `withGlobalTauri` breaks the page's own scripts entirely. Serving
//! the report over `127.0.0.1` is a small, dependency-free workaround — the
//! dashboard already fetches its data over HTTP in browser mode (`--web`).
//!
//! Every Node child process strips LD_LIBRARY_PATH/LD_PRELOAD: inside the
//! AppImage those point at the bundled libraries, and the host's `node`
//! would otherwise load them and abort (symbol/version mismatch).

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};

use tauri::Manager;
use tauri_plugin_autostart::ManagerExt;

/// Loopback port the report server listens on. Fixed so the frontend can find
/// it without any IPC. Must match the URL in `src-gui/index.html`.
const REPORT_PORT: u16 = 17321;

/// A report may be served from cache for this long unless `?refresh=1`.
const REPORT_TTL: Duration = Duration::from_secs(10);
/// Check metadata is static; cache it far longer.
const CHECKS_TTL: Duration = Duration::from_secs(300);

type Cache = Arc<Mutex<Option<(Instant, Vec<u8>)>>>;

/// TTL cache with single-flight: the mutex is held for the entire collection,
/// so a burst of requests (a drive-by page, repeated polls) triggers exactly
/// one scan — the others wait and then read the fresh cache. `refresh`
/// bypasses a still-fresh entry for an explicit "Re-run checks".
fn cached_collect(
    slot: &Cache,
    ttl: Duration,
    refresh: bool,
    collect: impl FnOnce() -> Result<Vec<u8>, String>,
) -> Result<Vec<u8>, String> {
    let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
    if !refresh {
        if let Some((at, data)) = guard.as_ref() {
            if at.elapsed() < ttl {
                return Ok(data.clone());
            }
        }
    }
    let data = collect()?;
    *guard = Some((Instant::now(), data.clone()));
    Ok(data)
}

/// Where the linux-doctor Node CLI lives, in priority order:
/// 1. `$LINUX_DOCTOR_ROOT` — explicit override.
/// 2. Bundled resources — production installs (see `bundle.resources`).
/// 3. The current working directory — `tauri dev` runs from the project root.
fn repo_root(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(root) = std::env::var("LINUX_DOCTOR_ROOT") {
        let p = PathBuf::from(&root);
        if !root.is_empty() && p.join("bin").join("doctor.js").exists() {
            return p;
        }
    }
    if let Ok(dir) = app.path().resource_dir() {
        // tauri-build's glob mapping only preserves file names, so a partial
        // or stale copy is possible; require a nested file too, not just
        // `bin/doctor.js`, or we'd silently run a broken CLI.
        let candidate = dir.join("bin").join("doctor.js");
        let checks_ok = dir.join("src").join("checks").join("memory.js").exists();
        if candidate.exists() && checks_ok {
            return dir;
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if cwd.join("bin").join("doctor.js").exists() {
            return cwd;
        }
    }
    // Last resort — let node report the missing file.
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Resolves the Node interpreter used to run the CLI, in priority order:
/// 1. `$LINUX_DOCTOR_NODE` — explicit override for custom installs.
/// 2. `<resources>/runtime/node` — a bundled runtime shipped inside the
///    package (release packaging can drop a Node binary there so end users
///    need nothing on their PATH).
/// 3. `LINUX_DOCTOR_NODE=nodejs` fallback — Debian/Ubuntu sometimes ships
///    the binary as `nodejs` instead of `node`.
/// 4. Plain `"node"` from PATH — the common case today.
fn node_bin(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("LINUX_DOCTOR_NODE") {
        let b = PathBuf::from(&p);
        if !p.is_empty() && b.is_file() {
            return b;
        }
        // Allow bare command name in LINUX_DOCTOR_NODE (e.g. "nodejs")
        if !p.is_empty() && !p.contains('/') {
            return PathBuf::from(p);
        }
    }
    if let Ok(dir) = app.path().resource_dir() {
        let b = dir.join("runtime").join("node");
        if b.is_file() {
            return b;
        }
        // Also accept runtime/nodejs
        let b2 = dir.join("runtime").join("nodejs");
        if b2.is_file() {
            return b2;
        }
    }
    // Try `node`, fall back to `nodejs` if `node` is not on PATH but `nodejs` is.
    if which("node").is_some() {
        return PathBuf::from("node");
    }
    if which("nodejs").is_some() {
        return PathBuf::from("nodejs");
    }
    PathBuf::from("node")
}

fn which(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let p = dir.join(bin);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Runs every check via the Node CLI and returns the raw JSON report bytes.
/// Exit code 0 (healthy) and 1 (findings found) are both valid reports.
/// `save` is false for the dashboard's background polls (which must not churn
/// the new/fixed story) and true for an explicit Re-run from the UI.
fn collect_report(root: &PathBuf, node: &PathBuf, save: bool) -> Result<Vec<u8>, String> {
    let mut command = Command::new(node);
    command
        .args(["bin/doctor.js", "--json"])
        .current_dir(root)
        .env_remove("LD_LIBRARY_PATH")
        .env_remove("LD_PRELOAD")
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH");
    if !save {
        command.env("LINUX_DOCTOR_NO_SAVE", "1");
    }
    let out = command
        .output()
        .map_err(|e| {
            format!(
                "Could not run Node.js ({e}). Linux Doctor needs Node.js >= 20.\n\
                 Try: `node --version` — if `node` is missing but `nodejs` exists, set LINUX_DOCTOR_NODE=nodejs,\n\
                 or install Node 20+ (https://nodejs.org) and ensure `node` is on your PATH.\n\
                 AppImage users: the bundle will use <resources>/runtime/node if present — see README #download."
            )
        })?;
    let code = out.status.code().unwrap_or(-1);
    if code != 0 && code != 1 {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        return Err(format!(
            "linux-doctor exited with code {code}.\n{stderr}\n{stdout}"
        ));
    }
    Ok(out.stdout)
}

/// Runs the CLI's check catalog (`--check-list`) and wraps it as
/// `{"checks": [...]}` — the shape the dashboard expects from `/checks`.
/// Used for check→category grouping and the checks matrix. Static metadata,
/// no system scanning, so this is cheap.
fn collect_checks(root: &PathBuf, node: &PathBuf) -> Result<Vec<u8>, String> {
    let out = Command::new(node)
        .args(["bin/doctor.js", "--check-list"])
        .current_dir(root)
        .env_remove("LD_LIBRARY_PATH")
        .env_remove("LD_PRELOAD")
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .output()
        .map_err(|e| {
            format!(
                "Could not run Node.js ({e}). Linux Doctor needs Node.js >= 20 with `node` on your PATH — or set LINUX_DOCTOR_NODE to a Node binary."
            )
        })?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "linux-doctor --check-list exited with code {}.\n{stderr}",
            out.status.code().unwrap_or(-1)
        ));
    }
    let list: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("Could not parse the check list: {e}"))?;
    serde_json::to_vec(&serde_json::json!({ "checks": list }))
        .map_err(|e| format!("Could not serialize the check list: {e}"))
}

/// Runs the Node CLI with the given arguments and returns (exit_code, stdout, stderr).
/// A spawn failure (no Node) is reported as exit code 127 with the OS error text.
fn run_cli(root: &PathBuf, node: &PathBuf, args: &[&str]) -> (i32, String, String) {
    match Command::new(node).args(args).current_dir(root).env_remove("LD_LIBRARY_PATH").env_remove("LD_PRELOAD").env_remove("NODE_OPTIONS").env_remove("NODE_PATH").output() {
        Ok(out) => (
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ),
        Err(e) => (
            127,
            String::new(),
            format!(
                "Could not run Node.js ({e}). Linux Doctor needs Node.js >= 20 with `node` on your PATH — or set LINUX_DOCTOR_NODE to a Node binary."
            ),
        ),
    }
}

/// Serves the dashboard API (and CORS preflight) on loopback. Runs in a
/// background thread; each connection is handled on its own thread so
/// "Re-run checks" can overlap safely (all checks are read-only; the POST
/// endpoints only write the app's own config/history files).
///
/// Requests are guarded like the CLI dashboard's server (src/web.js):
/// loopback Host headers only (anti DNS-rebinding), cross-origin writes
/// refused (CSRF), and CORS reads allowed only for our own origins — never
/// a wildcard, so no website can read the report from the user's browser.
fn serve_report(root: PathBuf, node: PathBuf) {
    thread::spawn(move || {
        let listener = match TcpListener::bind(("127.0.0.1", REPORT_PORT)) {
            Ok(listener) => listener,
            Err(err) => {
                eprintln!("⚠️  Could not start the report server on port {REPORT_PORT}: {err}");
                return;
            }
        };
        eprintln!("🩺 Linux Doctor report server: http://127.0.0.1:{REPORT_PORT}/report");
        let report_cache: Cache = Arc::new(Mutex::new(None));
        let checks_cache: Cache = Arc::new(Mutex::new(None));
        for stream in listener.incoming().flatten() {
            let root = root.clone();
            let node = node.clone();
            let rc = report_cache.clone();
            let cc = checks_cache.clone();
            thread::spawn(move || handle_client(stream, &root, &node, &rc, &cc));
        }
    });
}

/// Extracts Content-Length from raw request head bytes (0 when absent/invalid).
fn content_length(head: &[u8]) -> usize {
    let head = String::from_utf8_lossy(head);
    for line in head.lines() {
        let mut parts = line.splitn(2, ':');
        let name = parts.next().unwrap_or("").trim().to_ascii_lowercase();
        if name == "content-length" {
            return parts.next().unwrap_or("").trim().parse().unwrap_or(0);
        }
    }
    0
}

/// Extracts one request header value from the raw request head
/// (case-insensitive on both name and value handling; skips the request
/// line). First match wins.
fn request_header(head: &str, name: &str) -> Option<String> {
    let wanted = name.trim().to_ascii_lowercase();
    head.lines().skip(1).find_map(|line| {
        let mut parts = line.splitn(2, ':');
        let field = parts.next().unwrap_or("").trim().to_ascii_lowercase();
        (field == wanted)
            .then(|| parts.next().unwrap_or("").trim().to_string())
            .filter(|v| !v.is_empty())
    })
}

/// Hostnames a Host header or Origin authority must carry to be trusted.
/// Loopback only — same rule as the CLI dashboard server (`src/web.js`):
/// binding to 127.0.0.1 alone does not stop DNS rebinding, because a page at
/// http://evil.example (resolving to 127.0.0.1) arrives with an attacker-chosen
/// Host header and would otherwise be served the victim's report.
const LOOPBACK_HOSTS: [&str; 3] = ["127.0.0.1", "localhost", "::1"];

/// Origins the desktop dashboard may talk cross-origin from. The Tauri webview
/// serves the frontend from `tauri://localhost` (Linux) or
/// `http(s)://tauri.localhost` (Windows), so its authority is `tauri.localhost`
/// — plus the loopback names for opening the report URL in a local browser.
const ALLOWED_ORIGIN_HOSTS: [&str; 4] = ["127.0.0.1", "localhost", "::1", "tauri.localhost"];

/// "127.0.0.1:43901" / "[::1]:43901" / "evil.example" → bare hostname.
fn host_name(header_value: &str) -> Option<String> {
    let h = header_value.trim().to_ascii_lowercase();
    if h.is_empty() {
        return None;
    }
    if let Some(rest) = h.strip_prefix('[') {
        return rest.find(']').map(|i| rest[..i].to_string());
    }
    // A bare IPv6 literal contains several colons; exact-match before any
    // port stripping would mangle it.
    if LOOPBACK_HOSTS.contains(&h.as_str()) {
        return Some(h);
    }
    h.rsplit_once(':')
        .map(|(name, _)| name.to_string())
        .or(Some(h))
}

fn is_loopback_host(header_value: &str) -> bool {
    host_name(header_value).is_some_and(|n| LOOPBACK_HOSTS.contains(&n.as_str()))
}

/// Is this Origin one the dashboard may answer cross-origin?
/// Requires a scheme://authority shape; the scheme must be one of ours and
/// the authority's host in the allowlist. Anything else — any public website —
/// is refused on writes and gets no CORS read permission.
fn origin_allowed(origin: &str) -> bool {
    let Some((scheme, rest)) = origin.trim().split_once("://") else {
        return false;
    };
    // Explicit scheme allowlist — "ftp://localhost" is not ours either.
    if !matches!(scheme, "http" | "https" | "tauri") {
        return false;
    }
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    host_name(&rest[..authority_end]).is_some_and(|n| ALLOWED_ORIGIN_HOSTS.contains(&n.as_str()))
}

/// Builds the HTTP response head. `cors` is either empty or a full block
/// of CRLF-terminated CORS lines; either way, the blank line that ends the
/// headers comes exactly once, after Connection — never in the middle
/// (a stray CRLF once leaked Content-Length/Connection into the body and
/// broke every JSON parse in the dashboard).
fn response_head(status: &str, cors: &str, body_len: usize) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n{cors}Content-Length: {body_len}\r\nConnection: close\r\n\r\n"
    )
}

fn handle_client(
    mut stream: TcpStream,
    root: &PathBuf,
    node: &PathBuf,
    report_cache: &Cache,
    checks_cache: &Cache,
) {
    // A client that opens a socket and never finishes its request must not
    // pin a thread forever (slowloris).
    let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
    // Read the full request head, then any POST body (the config-writing
    // endpoints carry small JSON payloads). Capped well below any sane size.
    let mut data: Vec<u8> = Vec::with_capacity(4096);
    let mut buf = [0u8; 4096];
    let head_end = loop {
        if let Some(pos) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            let need = pos + 4 + content_length(&data[..pos]);
            if data.len() >= need {
                break Some(pos);
            }
        }
        if data.len() > 256 * 1024 {
            break None;
        }
        let n = stream.read(&mut buf).unwrap_or(0);
        if n == 0 {
            break None;
        }
        data.extend_from_slice(&buf[..n]);
    };

    let (method, path, body, head) = match head_end {
        Some(pos) => {
            let head = String::from_utf8_lossy(&data[..pos]).to_string();
            let mut parts = head.lines().next().unwrap_or("").split_whitespace();
            let method = parts.next().unwrap_or("").to_string();
            let path = parts.next().unwrap_or("").to_string();
            let cl = content_length(&data[..pos]).min(256 * 1024);
            let end = (pos + 4 + cl).min(data.len());
            let body = String::from_utf8_lossy(&data[pos + 4..end]).to_string();
            (method, path, body, head)
        }
        None => (String::new(), String::new(), String::new(), String::new()),
    };

    // Guard 1 — anti DNS-rebinding: only requests addressed at loopback are
    // answered, whatever socket they arrive on (same rule as src/web.js).
    // Guard 2 — CSRF: browsers always send Origin on cross-site writes; a
    // POST/OPTIONS naming any other site is forged against the config-writing
    // endpoints (/thresholds, /api/ignore) and is refused outright. No Origin
    // header means a non-browser client — allowed.
    let origin = request_header(&head, "origin");
    let origin_allowed = origin.as_deref().map(origin_allowed).unwrap_or(false);
    if !request_header(&head, "host")
        .map(|h| is_loopback_host(&h))
        .unwrap_or(false)
    {
        respond_text(
            &mut stream,
            "403 Forbidden",
            "Forbidden — the report API answers to loopback Host headers only",
        );
        return;
    }
    if method != "GET" && method != "HEAD" && origin.is_some() && !origin_allowed {
        respond_text(
            &mut stream,
            "403 Forbidden",
            "Forbidden — cross-origin requests are not accepted",
        );
        return;
    }

    // CORS, dynamically scoped: echo the Origin back only when it is one of
    // ours (the webview's tauri://localhost or loopback). Never "*": a public
    // website must not be able to read the report from the victim's browser.
    let cors = match (&origin, origin_allowed) {
        (Some(o), true) => format!("Access-Control-Allow-Origin: {o}\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nVary: Origin\r\n"),
        _ => String::new(),
    };

    // Shells out to the CLI; exit 0 → 200 with stdout, exit 1 → 400 with
    // stdout (the CLI prints {ok:false,...}), anything else → 500.
    let cli_json = |args: &[&str]| -> (&'static str, Vec<u8>) {
        let (code, stdout, stderr) = run_cli(root, node, args);
        match code {
            0 => ("200 OK", stdout.into_bytes()),
            1 => ("400 Bad Request", stdout.into_bytes()),
            _ => (
                "500 Internal Server Error",
                serde_json::to_vec(&serde_json::json!({ "error": stderr })).unwrap_or_default(),
            ),
        }
    };

    // Split the query string off the route so ?refresh=1 can bypass the cache.
    let (route, query) = match path.split_once('?') {
        Some((r, q)) => (r, q),
        None => (path.as_str(), ""),
    };
    let refresh = query.split('&').any(|kv| kv == "refresh=1");
    // save=1 comes from an explicit Re-run: it records history and must never
    // be served from (or masked by) the poll cache.
    let save = query.split('&').any(|kv| kv == "save=1");

    let (status, body) = match (method.as_str(), route) {
        ("OPTIONS", _) => ("204 No Content", Vec::new()),
        ("GET", "/report") | ("GET", "/report/") => {
            match cached_collect(report_cache, REPORT_TTL, refresh || save, || {
                collect_report(root, node, save)
            }) {
                Ok(bytes) => ("200 OK", bytes),
                Err(msg) => (
                    "500 Internal Server Error",
                    serde_json::to_vec(&serde_json::json!({ "error": msg })).unwrap_or_default(),
                ),
            }
        }
        ("GET", "/checks") | ("GET", "/checks/") => {
            match cached_collect(checks_cache, CHECKS_TTL, false, || {
                collect_checks(root, node)
            }) {
                Ok(bytes) => ("200 OK", bytes),
                Err(msg) => (
                    "500 Internal Server Error",
                    serde_json::to_vec(&serde_json::json!({ "error": msg })).unwrap_or_default(),
                ),
            }
        }
        ("GET", "/history") | ("GET", "/history/") => {
            cli_json(&["bin/doctor.js", "--history-json"])
        }
        ("GET", "/api/ignore") | ("GET", "/api/ignore/") => {
            cli_json(&["bin/doctor.js", "--ignore-list-json"])
        }
        ("POST", "/api/history/clear") | ("POST", "/api/history/clear/") => {
            let (code, _out, _err) = run_cli(root, node, &["bin/doctor.js", "--history-clear"]);
            if code == 0 {
                (
                    "200 OK",
                    serde_json::to_vec(&serde_json::json!({ "ok": true })).unwrap_or_default(),
                )
            } else {
                (
                    "500 Internal Server Error",
                    serde_json::to_vec(&serde_json::json!({ "ok": false })).unwrap_or_default(),
                )
            }
        }
        ("GET", "/thresholds") | ("GET", "/thresholds/") => {
            cli_json(&["bin/doctor.js", "--thresholds-json"])
        }
        ("POST", "/thresholds") | ("POST", "/thresholds/") => {
            cli_json(&["bin/doctor.js", "--thresholds-set", &body])
        }
        ("POST", "/api/ignore") | ("POST", "/api/ignore/") => {
            let pattern = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v.get("pattern").and_then(|p| p.as_str()).map(String::from));
            match pattern {
                Some(p) if !p.is_empty() => {
                    let (status, bytes) = cli_json(&["bin/doctor.js", "--ignore-add", &p]);
                    if status == "200 OK" {
                        (
                            "200 OK",
                            serde_json::to_vec(&serde_json::json!({ "ok": true }))
                                .unwrap_or_default(),
                        )
                    } else {
                        (status, bytes)
                    }
                }
                _ => (
                    "400 Bad Request",
                    serde_json::to_vec(&serde_json::json!({ "ok": false })).unwrap_or_default(),
                ),
            }
        }
        _ => (
            "404 Not Found",
            serde_json::to_vec(&serde_json::json!({ "error": "Not found" })).unwrap_or_default(),
        ),
    };

    let _ = write!(stream, "{}", response_head(status, &cors, body.len()));
    let _ = stream.write_all(&body);
}

/// Minimal plain-text response, used by the request guards.
fn respond_text(stream: &mut TcpStream, status: &str, message: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{message}",
        message.len()
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    disable_webkit_dmabuf();
    software_gl_fallback();
    tauri::Builder::default()
        // Must be the first registered plugin: the callback runs when a
        // second instance starts — instead of a second window (and a second
        // report server that would lose the fixed port), the existing one
        // surfaces.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        // Auto-update (analysis "app needs" P0-2): the updater and the native
        // prompt are driven from Rust, like the tray — Tauri's JS IPC does not
        // work on this stack.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let root = repo_root(app.handle());
            let node = node_bin(app.handle());
            serve_report(root.clone(), node.clone());
            // Fail-soft on purpose: libappindicator loads dynamically and
            // PANICS when the system has no tray library at all. A missing
            // tray must never cost the user the app — log and continue.
            // (Packages ship appindicator as a dependency; this is for
            // minimal-shaped systems.)
            let tray_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                build_tray(app, &root, &node)
            }));
            match tray_result {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    eprintln!("⚠️  linux-doctor: tray unavailable ({e}) — continuing without it")
                }
                Err(_) => {
                    eprintln!("⚠️  linux-doctor: no system tray library — continuing without it")
                }
            }
            fit_window(app);
            // Quiet startup update check a few seconds in, so it never races
            // the first paint or the initial scan. Opt out with
            // LINUX_DOCTOR_NO_UPDATE=1 (also useful in tests/dev).
            if std::env::var("LINUX_DOCTOR_NO_UPDATE").is_err() {
                let handle = app.handle().clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_secs(12));
                    check_for_updates(&handle, false);
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Linux Doctor");
}

/// Check GitHub Releases for a newer signed build and, with the user's
/// consent, install it and restart. Runs on Tauri's async runtime; the dialog
/// is non-blocking so the event loop is never stalled. Any failure is a log
/// line — an update check must never disturb a running diagnostic.
fn check_for_updates(app: &tauri::AppHandle, user_initiated: bool) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    use tauri_plugin_updater::UpdaterExt;

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(u) => u,
            Err(e) => {
                eprintln!("linux-doctor: updater unavailable: {e}");
                return;
            }
        };
        match updater.check().await {
            Ok(Some(update)) => {
                let version = update.version.clone();
                let app_after = app.clone();
                app.dialog()
                    .message(format!(
                        "Linux Doctor {version} is available. Install it now and restart?"
                    ))
                    .title("Update available")
                    .kind(MessageDialogKind::Info)
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "Install".to_string(),
                        "Later".to_string(),
                    ))
                    .show(move |install| {
                        if !install {
                            return;
                        }
                        let app_install = app_after.clone();
                        tauri::async_runtime::spawn(async move {
                            match update.download_and_install(|_, _| {}, || {}).await {
                                Ok(()) => {
                                    eprintln!("linux-doctor: update installed — restarting");
                                    app_install.restart();
                                }
                                Err(e) => eprintln!("linux-doctor: update install failed: {e}"),
                            }
                        });
                    });
            }
            Ok(None) => {
                if user_initiated {
                    app.dialog()
                        .message("Linux Doctor is up to date.")
                        .title("No updates")
                        .kind(MessageDialogKind::Info)
                        .show(|_| {});
                }
            }
            Err(e) => {
                eprintln!("linux-doctor: update check failed: {e}");
                if user_initiated {
                    app.dialog()
                        .message(format!("Could not check for updates: {e}"))
                        .title("Update check failed")
                        .kind(MessageDialogKind::Warning)
                        .show(|_| {});
                }
            }
        }
    });
}

/// Tray icon with the desktop-app actions (app-needs research P1-3/P1-4):
/// presence with Open / Run checks now / Start at login / Quit. Everything
/// is handled Rust-side — Tauri IPC does not work in this stack, so the
/// menu never touches the webview.
fn build_tray(
    app: &tauri::App,
    root: &Path,
    node: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
    use tauri::tray::TrayIconBuilder;

    // Owned copies: the menu-event closure is 'static (registered for the
    // app's lifetime), so borrowed parameters cannot outlive this call.
    let root = root.to_path_buf();
    let node = node.to_path_buf();

    let open = MenuItemBuilder::with_id("open", "Open Linux Doctor").build(app)?;
    let runnow = MenuItemBuilder::with_id("runnow", "Run checks now").build(app)?;
    let autostart = CheckMenuItemBuilder::with_id("autostart", "Start at login")
        .checked(app.autolaunch().is_enabled().unwrap_or(false))
        .build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let update = MenuItemBuilder::with_id("update", "Check for updates").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&open)
        .item(&runnow)
        .separator()
        .item(&autostart)
        .separator()
        .item(&update)
        .separator()
        .item(&quit)
        .build()?;

    let mut tray = TrayIconBuilder::with_id("ld-tray")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("Linux Doctor — read-only health checks");
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;

    app.on_menu_event(move |app_handle, event| {
        match event.id().as_ref() {
            "open" => focus_main(app_handle),
            "runnow" => {
                // One run at a time: each scan spawns four parallel checks and
                // dozens of subprocesses, so an impatient double-click must
                // coalesce, not stack.
                static RUN_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
                if RUN_IN_FLIGHT.swap(true, Ordering::SeqCst) {
                    eprintln!(
                        "linux-doctor: a check run is already in flight — ignoring the click"
                    );
                } else {
                    // Same discipline as the report server's children: no env
                    // leakage, daemon-style one-shot with the desktop
                    // notification path; the dashboard picks the fresh report
                    // up on its next poll. Run off the main thread.
                    let root = root.clone();
                    let node = node.clone();
                    thread::spawn(move || {
                        let (_code, _out, _err) =
                            run_cli(&root, &node, &["bin/doctor.js", "--notify"]);
                        RUN_IN_FLIGHT.store(false, Ordering::SeqCst);
                    });
                }
            }
            "autostart" => {
                // Truthful toggle: attempt the change, then re-read the real
                // state and reflect THAT in the checkbox and the log. muda
                // toggles the check on click regardless, so a failed
                // enable()/disable() would otherwise leave the user believing
                // persistence is on. Panic-safe: auto-launch unwraps
                // home_dir, and this handler runs outside the tray
                // catch_unwind.
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let manager = app_handle.autolaunch();
                    let current = manager.is_enabled().unwrap_or(false);
                    if current {
                        let _ = manager.disable();
                    } else {
                        let _ = manager.enable();
                    }
                    manager.is_enabled().unwrap_or(current)
                }));
                match outcome {
                    Ok(on) => {
                        let _ = autostart.set_checked(on);
                        eprintln!(
                            "linux-doctor: start at login {}",
                            if on { "enabled" } else { "disabled" }
                        );
                    }
                    Err(_) => {
                        eprintln!("⚠️  linux-doctor: could not change start-at-login");
                    }
                }
            }
            "quit" => app_handle.exit(0),
            "update" => check_for_updates(app_handle, true),
            _ => {}
        }
    });
    Ok(())
}

/// Sizes the window to the screen instead of a fixed default: up to
/// 1500×950 (the full wide-desktop workbench) but never larger than the
/// monitor minus a margin, never smaller than 900×640. A 1366×768 laptop
/// therefore gets a comfortable ~1286×688 window, a 4K monitor gets the
/// 1500×950 workbench, and nothing ever opens larger than the display.
fn fit_window(app: &tauri::App) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    if let Ok(Some(monitor)) = win.current_monitor() {
        let logical = monitor.size().to_logical::<f64>(monitor.scale_factor());
        let w = (logical.width - 80.0).clamp(900.0, 1500.0);
        let h = (logical.height - 80.0).clamp(640.0, 950.0);
        let _ = win.set_size(tauri::LogicalSize::new(w, h));
        let _ = win.center();
    }
    // The window starts hidden (tauri.conf.json) so the user never sees the
    // default-size flash; show it once the geometry above is applied. This
    // also guarantees it becomes visible even if the monitor query failed.
    let _ = win.show();
}

/// Shows and focuses the main window (tray "Open" and second-launch paths).
fn focus_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Inside the AppImage, the bundled WebKitGTK comes from an older LTS base
/// and its accelerated paths can abort against a bleeding-edge host Mesa
/// ("Could not create default EGL display") — on AMD and Intel alike, since
/// both run on Mesa (NVIDIA's proprietary driver ships its own stack). A
/// diagnostics dashboard does not need GPU acceleration, so when running
/// from an AppImage we default to software GL before any GTK/WebKit code
/// initializes. Opt out with LINUX_DOCTOR_HARDWARE_GL=1. The .deb and CLI
/// are untouched: they use the host's matching WebKitGTK.
fn software_gl_fallback() {
    let appimage = std::env::var_os("APPIMAGE").is_some();
    let already_set = std::env::var_os("LIBGL_ALWAYS_SOFTWARE").is_some();
    let hardware_requested = std::env::var("LINUX_DOCTOR_HARDWARE_GL")
        .map(|v| v == "1")
        .unwrap_or(false);
    if appimage && !already_set && !hardware_requested {
        std::env::set_var("LIBGL_ALWAYS_SOFTWARE", "1");
        eprintln!(
            "linux-doctor: running from an AppImage — defaulting to software GL \
             (set LINUX_DOCTOR_HARDWARE_GL=1 to use hardware rendering)"
        );
    }
}

/// WebKitGTK's DMA-BUF renderer can produce a blank/white webview on many
/// Linux setups (NVIDIA proprietary, very recent Mesa, some Wayland
/// compositors). A diagnostics dashboard does not need it, so disable it
/// before any GTK/WebKit code initializes. Set
/// `WEBKIT_DISABLE_DMABUF_RENDERER=0` to opt back in.
fn disable_webkit_dmabuf() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_name_strips_ports_and_brackets() {
        assert_eq!(host_name("127.0.0.1:17321").as_deref(), Some("127.0.0.1"));
        assert_eq!(host_name("[::1]:43901").as_deref(), Some("::1"));
        assert_eq!(host_name("localhost").as_deref(), Some("localhost"));
        assert_eq!(host_name("LOCALHOST:8080").as_deref(), Some("localhost"));
        assert_eq!(host_name(""), None);
    }

    #[test]
    fn only_loopback_host_headers_are_accepted() {
        // What the dashboard itself sends.
        assert!(is_loopback_host("127.0.0.1:17321"));
        assert!(is_loopback_host("localhost:17321"));
        assert!(is_loopback_host("[::1]:17321"));
        assert!(is_loopback_host("::1"));
        // DNS rebinding: the page is evil.example, the socket is ours.
        assert!(!is_loopback_host("evil.example"));
        assert!(!is_loopback_host("evil.example:17321"));
        assert!(!is_loopback_host("127.0.0.1.evil.example"));
        assert!(!is_loopback_host("app.localhost.evil.example"));
        // Missing Host (HTTP/1.0) is refused, like src/web.js.
        assert!(!is_loopback_host(""));
    }

    #[test]
    fn allowed_origins_are_ours_only() {
        // The Tauri webview origin(s).
        assert!(origin_allowed("tauri://localhost"));
        assert!(origin_allowed("http://tauri.localhost"));
        assert!(origin_allowed("https://tauri.localhost"));
        // Opening the report URL in a local browser.
        assert!(origin_allowed("http://127.0.0.1:43901"));
        assert!(origin_allowed("http://localhost:43901"));
        // Any public website — the whole point of the guard.
        assert!(!origin_allowed("https://evil.example"));
        assert!(!origin_allowed("http://evil.example:17321"));
        assert!(!origin_allowed("null"));
        // Malformed / scheme tricks.
        assert!(!origin_allowed(""));
        assert!(!origin_allowed("ftp://localhost"));
        assert!(!origin_allowed("http://"));
        assert!(!origin_allowed("http://tauri.localhost.evil.example"));
    }

    #[test]
    fn response_head_has_exactly_one_header_terminator() {
        // Regression: a stray CRLF after the CORS block ended the headers
        // early and leaked Content-Length/Connection into the JSON body,
        // which broke every dashboard fetch in the desktop app.
        let plain = response_head("200 OK", "", 42);
        assert_eq!(plain.matches("\r\n\r\n").count(), 1, "plain: {plain:?}");
        assert!(plain.ends_with("\r\n\r\n"));
        assert!(plain.contains("\r\nContent-Length: 42\r\nConnection: close\r\n\r\n"));

        let cors = "Access-Control-Allow-Origin: tauri://localhost\r\nVary: Origin\r\n";
        let with_cors = response_head("200 OK", cors, 7);
        assert_eq!(
            with_cors.matches("\r\n\r\n").count(),
            1,
            "cors: {with_cors:?}"
        );
        assert!(with_cors.ends_with("\r\n\r\n"));
        assert!(with_cors.contains("Vary: Origin\r\nContent-Length: 7\r\n"));
    }

    #[test]
    fn request_header_is_case_insensitive_and_skips_the_request_line() {
        let head = "POST /thresholds HTTP/1.1\r\nHost: 127.0.0.1:17321\r\ncontent-type: application/json\r\nOrigin: https://evil.example\r\n\r\n";
        assert_eq!(
            request_header(head, "host").as_deref(),
            Some("127.0.0.1:17321")
        );
        assert_eq!(
            request_header(head, "HOST").as_deref(),
            Some("127.0.0.1:17321")
        );
        assert_eq!(
            request_header(head, "origin").as_deref(),
            Some("https://evil.example")
        );
        assert_eq!(request_header(head, "accept"), None);
        // The request line must never be mistaken for a header.
        assert_eq!(request_header(head, "post /thresholds http/1.1"), None);
    }

    #[test]
    fn report_cache_serves_within_ttl_and_refresh_bypasses_it() {
        use std::sync::atomic::{AtomicUsize, Ordering as O};
        let slot: Cache = Arc::new(Mutex::new(None));
        let calls = AtomicUsize::new(0);
        let run = || {
            calls.fetch_add(1, O::SeqCst);
            Ok::<Vec<u8>, String>(vec![7])
        };
        assert_eq!(
            cached_collect(&slot, Duration::from_secs(60), false, run).unwrap(),
            vec![7]
        );
        assert_eq!(
            cached_collect(&slot, Duration::from_secs(60), false, run).unwrap(),
            vec![7]
        );
        assert_eq!(
            calls.load(O::SeqCst),
            1,
            "a second call within the TTL must hit the cache"
        );
        assert_eq!(
            cached_collect(&slot, Duration::from_secs(60), true, run).unwrap(),
            vec![7]
        );
        assert_eq!(
            calls.load(O::SeqCst),
            2,
            "refresh must bypass a fresh cache entry"
        );
    }
}
