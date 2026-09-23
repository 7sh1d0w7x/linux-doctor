# Dashboard & desktop app

The same report, visualized. For downloads and the CLI, see the
[README](../README.md).

## Visual dashboard (`--web`)

```bash
linux-doctor --web
```

Opens a dashboard in your browser at `127.0.0.1:43901` (a stable, predictable
URL — a second instance falls back to a free port instead of crashing). The
layout is organized into four clear zones: **identity** (logo + system info +
actions: notifications, theme, **Export** menu, help, **Re-run checks**),
**status** (health gauge with score/delta, a plain-language message,
NEW/FIXED chips, and a checks chip that opens the all-checks matrix),
**control** (group-by Severity/Category, severity pills with live counts,
search, Auto-refresh, Expand all, Density, Checks, Clear, and thresholds),
and **content** (full-width START HERE, then a shared **notices** row — the
daily-check strip and the security posture as compact one-liners side by
side — then High → Medium → Informational, Fixed, Skipped, Failed checks,
Changes, and history). The spine stays hero → START HERE → findings; when
only one notice is visible it spans the full width instead of leaving a
half-empty column.
The report area is organized into five **views** — **Overview** (today's
report, the default), **History** (score trend, severity charts, and a
newest-first ledger of past runs with per-run deltas), **Checks** (the
all-checks matrix inline, with deep-links back to the findings),
**System** (a full machine wiki — Operating system, Hardware, and Session
sections plus this report's summary), and **Schedule**
(timer status and cadence, notification state, and copy-paste setup,
alert, and heartbeat commands). Tabs carry live count badges (runs,
open problems). Switch from the sidebar navigation (icon + live count badges, Cockpit-style)
on wide screens, the scrollable tab bar below it on narrow ones, keys
`1`–`5`, or the arrow keys while a tab is focused; the choice is remembered.
Secondary panels share a two-column card grid next to START HERE instead of
stacking full-width. Overview
never moves: filters, search, keyboard navigation, and auto-refresh behave
exactly as before, and the background refresh keeps pausing while you read —
an open card in a hidden view never freezes updates.

**IA rule: five views, no more.** Research (NN/g, Hick's law) puts the
sweet spot for top-level navigation at 5–7 items, and each of ours answers
a distinct user question — broken now (Overview), over time (History),
what was checked (Checks), which machine (System), watched tomorrow
(Schedule). New features land *inside* existing views (alert examples live
in Schedule, thresholds in its panel), never as new top-level views; past
7, regroup instead of adding.
The **daily-check strip** answers whether the machine will check itself
tomorrow: it reads the user timer state from `GET /api/schedule` (read-only —
installing stays a CLI decision) and shows **on** (runs after boot, then
daily, notifies only on new findings), **off** (with a one-click copy of
`linux-doctor --install-timer`), or **needs attention** (units exist but the
timer isn't active), plus the browser-alerts state. It stays hidden for
static `--html` exports.
**High** findings are open by default; **Medium**, **Informational**,
**Fixed**, and **Skipped** collapse, so a full report fits on one screen
without scrolling. Click any finding to expand what happened and why it
matters, an **Evidence** expander with a copy button and the check's run
time, plus the recommended next step with **Copy fix**, **Dismiss**, and
**Report** actions. Every card header carries a quiet `code` pill — click it
to copy the stable code, or type `code:<prefix>` in search to filter by it.
Hit **Re-run checks** for a fresh report. The dashboard **auto-refreshes**
every 5s — it pauses while you are reading (searching, filtering, or with a
finding expanded) so your place is never reset, and the Auto button shows
its paused state. **Re-run records the run in history** (the trend and the
new/fixed diff move); the background auto-refresh deliberately does **not**,
so polling can never churn your history. Density defaults to compact (more
findings per viewport) and is remembered, like the theme. Pure HTML/CSS/JS —
no frameworks; the page served by `--web`, the desktop app, and `--html`
exports are all built from `src-gui/` via `npm run build:gui`.

The **history** view draws your health-score sparkline (with date tooltips
and a dashed 50-point "needs attention" line) plus a stacked bar chart of
high/medium/info findings across recent runs, so you can see at a glance
whether problems are trending up or down. With fewer than two recorded runs
it explains what will appear there instead of vanishing. The **Skipped**
section lists checks that do not apply to this machine profile plus checks
skipped on immutable/atomic systems (e.g. `reboot`).

**Themes:** the dashboard follows your system theme and remembers your
choice — the theme button in the header cycles light → dark → terminal →
auto. **Terminal** is a phosphor-console look (near-black, mono everywhere,
sharp corners, flat surfaces) for sysadmins; same layout and the same
contrast budget as the other themes, only variables change.
**Keyboard navigation:** `↑`/`↓` move between findings, `Enter`/`Space`
opens/closes the focused one, `/` focuses search, `?` shows all shortcuts,
`Esc` closes dialogs/menus/panels or clears search and filters, and `F11`
toggles fullscreen in the desktop app (in the browser dashboard the browser
keeps that key for itself). Every
severity has an icon plus a text label, never color alone; status changes
and confirmations are announced through live regions, and motion honors
`prefers-reduced-motion`. While checks re-run, a spinner shows progress and
the button is disabled.

## Desktop app (GUI)

The same dashboard, as a native desktop window — launch it, and one click on
**Re-run checks** gives you a fresh report. Built with Tauri v2: the window
is a thin Rust shell that runs the exact same Node checks
(`bin/doctor.js --json`), so there is **zero duplication** between the CLI
and the GUI — the checks are the single source of truth.

**Prerequisites:** Node.js ≥ 20 (the checks run through Node), Rust, and the
Tauri system libraries:

```bash
# Fedora / Bazzite (immutable) — layering applies live, no reboot needed
sudo rpm-ostree install --apply-live webkit2gtk4.1-devel dbus-devel librsvg2-devel libxdo-devel
# Debian / Ubuntu
sudo apt install libwebkit2gtk-4.1-dev build-essential libssl-dev libxdo-dev librsvg2-dev
```

**Run in development:**

```bash
npm install
npm run gui:dev
```

**Build installers (.deb / .rpm / AppImage):**

```bash
npm run gui:build
```

The bundled app ships its own Node.js runtime (nothing to install on PATH).
Set `LINUX_DOCTOR_ROOT` to point at a Linux Doctor checkout if the bundled
resources are unavailable, or `LINUX_DOCTOR_NODE` to override the interpreter.

To put the app in your desktop menu, install the launcher (the deb/rpm
bundles ship one automatically; this is for the AppImage or manual setups):

```bash
install -Dm644 packaging/linux-doctor.desktop ~/.local/share/applications/
install -Dm644 src-tauri/icons/128x128.png ~/.local/share/icons/hicolor/128x128/apps/linux-doctor.png
```
