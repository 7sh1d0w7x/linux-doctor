// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Dashboard state invariants, evaluated against the BUILT src-gui/index.html
 * in a stubbed browser environment (vm), like tests/gui-smoke.test.js.
 *
 * Pins the two behaviors a restyle can most easily break silently:
 *  1. pollPaused() — auto-refresh must pause while the user is reading
 *     (search text, non-All filter, an open card, rerun in flight, or a
 *     hidden tab), so a background refresh never yanks their place away.
 *  2. renderTrend() first-run states — zero recorded runs hides History;
 *     exactly one run explains what will grow there (with its score);
 *     corrupt/scoreless entries degrade to "no history".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(ROOT, "src-gui", "index.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
assert.ok(script.length > 10000, "built index.html must contain the app script");

function makeEl() {
  return {
    hidden: false,
    disabled: false,
    value: "",
    textContent: "",
    innerHTML: "",
    open: false,
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    focus() {},
    scrollIntoView() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild() {},
    remove() {},
    closest() { return null; },
    matches() { return false; },
  };
}

/**
 * Sandbox with a controllable DOM: `state.hidden` flips document.hidden,
 * `el(sel)` returns the stub element for a selector, and `lists` backs
 * querySelectorAll so tests can simulate open cards.
 */
function makeSandbox({ storage } = {}) {
  const els = new Map();
  const lists = new Map();
  const state = { hidden: false };
  const store = storage || new Map();
  const el = (sel) => {
    if (!els.has(sel)) els.set(sel, makeEl());
    return els.get(sel);
  };
  const document = {
    get hidden() { return state.hidden; },
    querySelector: (sel) => el(sel),
    querySelectorAll: (sel) => lists.get(sel) || [],
    getElementById: (id) => el("#" + id),
    addEventListener: () => {},
    createElement: () => makeEl(),
    createTextNode: (t) => ({ textContent: t }),
    createDocumentFragment: () => makeEl(),
    createTreeWalker: () => ({ nextNode: () => false }),
    documentElement: makeEl(),
    body: makeEl(),
    activeElement: null,
  };
  const ctx = vm.createContext({
    document,
    window: {
      matchMedia: () => ({ matches: false, addEventListener: () => {} }),
      addEventListener: () => {},
    },
    // The dashboard reads the BARE matchMedia global (ui-wide.js) — keep the
    // stub here so the narrow path is what these invariants exercise.
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    navigator: {},
    performance: { now: () => Date.now() },
    requestAnimationFrame: () => 0,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
    fetch: () => Promise.resolve({ ok: false }),
  });
  // init.js runs load() → fetch fails → error path renders into stubs only.
  vm.runInContext(script, ctx, { filename: "gui-bundle.js" });
  // Reset the module-level pause inputs to a known-clean baseline.
  vm.runInContext("autoRefresh = true; pollBusy = false; activeFilter = 'all';", ctx);
  return { ctx, el, lists, state };
}

const paused = (s) => {
  const { ctx, el, lists, state } = s;
  el("#rerun").disabled = false;
  el("#search").value = "";
  state.hidden = false;
  vm.runInContext("autoRefresh = true; pollBusy = false; activeFilter = 'all';", ctx);
  lists.delete("#report details[open]");
  return vm.runInContext("pollPaused()", ctx);
};

test("pollPaused: a clean idle dashboard is NOT paused", () => {
  assert.equal(paused(makeSandbox()), false);
});

test("pollPaused: auto-refresh off, busy poll, or hidden tab pauses", () => {
  const s = makeSandbox();
  const { ctx, state } = s;
  vm.runInContext("autoRefresh = false;", ctx);
  assert.equal(vm.runInContext("pollPaused()", ctx), true);
  vm.runInContext("autoRefresh = true; pollBusy = true;", ctx);
  assert.equal(vm.runInContext("pollPaused()", ctx), true);
  vm.runInContext("pollBusy = false;", ctx);
  state.hidden = true;
  assert.equal(vm.runInContext("pollPaused()", ctx), true);
});

test("pollPaused: rerun in flight pauses", () => {
  const s = makeSandbox();
  s.el("#rerun").disabled = true;
  assert.equal(vm.runInContext("pollPaused()", s.ctx), true);
});

test("pollPaused: search text pauses (reading while filtering)", () => {
  const s = makeSandbox();
  s.el("#search").value = "disk";
  assert.equal(vm.runInContext("pollPaused()", s.ctx), true);
});

test("pollPaused: a non-All severity filter pauses", () => {
  const s = makeSandbox();
  vm.runInContext("activeFilter = 'high';", s.ctx);
  assert.equal(vm.runInContext("pollPaused()", s.ctx), true);
});

test("pollPaused: an open finding card pauses", () => {
  const s = makeSandbox();
  s.lists.set("#report details[open]", [{}]);
  assert.equal(vm.runInContext("pollPaused()", s.ctx), true);
});

// ---------------------------------------------------------------------------
// renderTrend() first-run / empty / corrupt states.
// ---------------------------------------------------------------------------

const trendCtx = (s, runs) => {
  const { ctx, el } = s;
  vm.runInContext(`fetchHistory = async () => ${JSON.stringify(runs)};`, ctx);
  return vm.runInContext("renderTrend(80)", ctx).then(() => ({ trend: el("#trend").innerHTML, hidden: el("#history").hidden }));
};

test("renderTrend: zero recorded runs hides History", async () => {
  const { hidden, trend } = await trendCtx(makeSandbox(), []);
  assert.equal(hidden, true);
  assert.equal(trend, "");
});

test("renderTrend: corrupt/scoreless entries degrade to hidden History", async () => {
  const { hidden } = await trendCtx(makeSandbox(), [{ at: "x" }, { score: "bad" }, { score: null }]);
  assert.equal(hidden, true);
});

test("renderTrend: exactly one run explains what will grow there", async () => {
  const { hidden, trend } = await trendCtx(makeSandbox(), [{ at: "2026-09-01T10:00:00Z", score: 80 }]);
  assert.equal(hidden, false);
  assert.match(trend, /Only one run on record so far/);
  assert.match(trend, /80\/100/);
  assert.match(trend, /health-score trend appears here/);
});

test("renderTrend: two or more runs render the charts", async () => {
  const { ctx, el } = makeSandbox();
  vm.runInContext(
    "fetchHistory = async () => [{ at: '2026-09-01T10:00:00Z', score: 70, counts: { high: 1, medium: 0, info: 2 } }, { at: '2026-09-02T10:00:00Z', score: 80, counts: { high: 0, medium: 1, info: 2 } }];",
    ctx
  );
  await vm.runInContext("renderTrend(80)", ctx);
  const trend = el("#trend").innerHTML;
  assert.match(trend, /Health score trend/);
  assert.match(trend, /Findings by severity/);
  assert.equal(el("#hero-spark").hidden, false);
});

// ---------------------------------------------------------------------------
// scheduleHtml(): the "Daily check" strip vocabulary.
// ---------------------------------------------------------------------------

const stripHtml = (sched, notify) => {
  const s = makeSandbox();
  return vm.runInContext(`scheduleHtml(${JSON.stringify(sched)}, ${JSON.stringify(notify)})`, s.ctx);
};

test("scheduleHtml: null schedule renders nothing (strip stays hidden)", () => {
  assert.equal(stripHtml(null, "off"), "");
});

test("scheduleHtml: timer off shows state plus the setup command", () => {
  const html = stripHtml({ installed: false, enabled: false, active: false, systemd: true }, "off");
  assert.match(html, /Daily check off/);
  assert.match(html, /linux-doctor --install-timer/);
  assert.match(html, /Copy setup command/);
  assert.match(html, /Browser alerts off/);
});

test("scheduleHtml: active timer reads as on", () => {
  const html = stripHtml({ installed: true, enabled: true, active: true, systemd: true }, "on");
  assert.match(html, /Daily check on/);
  assert.match(html, /notifies only on new findings/);
  assert.match(html, /Browser alerts on/);
  assert.ok(!html.includes("install-timer"), "no setup command when the timer is healthy");
});

test("scheduleHtml: installed but inactive timer needs attention", () => {
  const html = stripHtml({ installed: true, enabled: false, active: false, systemd: true }, "off");
  assert.match(html, /needs attention/);
  assert.match(html, /linux-doctor --install-timer/);
});

test("scheduleHtml: unavailable browser notify omits the alerts bit", () => {
  const html = stripHtml({ installed: true, enabled: true, active: true, systemd: true }, "unavailable");
  assert.match(html, /Daily check on/);
  assert.ok(!html.includes("Browser alerts"), "no alerts bit when the API is unavailable");
});

// ---------------------------------------------------------------------------
// App views: Overview / History / Checks tab switching.
// ---------------------------------------------------------------------------

function makeTab(view) {
  const attrs = {};
  const classes = new Set(view === "overview" ? ["active"] : []);
  return {
    dataset: { view },
    tabIndex: view === "overview" ? 0 : -1,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, f) => (f ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => attrs[k] ?? null,
    focus: () => {},
  };
}

const flush = () => new Promise((r) => setImmediate(r));

test("switchView: shows one pane, marks its tab, persists the choice", () => {
  const store = new Map();
  const s = makeSandbox({ storage: store });
  const tabs = [makeTab("overview"), makeTab("history"), makeTab("checks")];
  s.lists.set("#viewtabs .viewtab", tabs);

  vm.runInContext("switchView('history')", s.ctx);

  assert.equal(s.el("#view-overview").hidden, true);
  assert.equal(s.el("#view-history").hidden, false);
  assert.equal(s.el("#view-checks").hidden, true);
  assert.equal(tabs[1].getAttribute("aria-selected"), "true");
  assert.equal(tabs[0].getAttribute("aria-selected"), "false");
  assert.equal(tabs[1].tabIndex, 0);
  assert.equal(tabs[0].tabIndex, -1);
  assert.equal(store.get("ld-view"), "history");
});

test("switchView: an unknown view name leaves every pane untouched", () => {
  const s = makeSandbox();
  vm.runInContext("switchView('nope')", s.ctx);
  assert.equal(s.el("#view-overview").hidden, false);
  assert.equal(s.el("#view-history").hidden, false);
  assert.equal(s.el("#view-checks").hidden, false);
});

test("setupViews: restores the persisted view on load", () => {
  const s = makeSandbox({ storage: new Map([["ld-view", "history"]]) });
  assert.equal(s.el("#view-history").hidden, false);
  assert.equal(s.el("#view-overview").hidden, true);
});

test("switchView: Checks view renders the matrix inline", async () => {
  const s = makeSandbox();
  vm.runInContext("switchView('checks')", s.ctx);
  await flush();
  assert.match(s.el("#checksview").innerHTML, /All checks/);
});

test("pollPaused: an open card in a hidden Overview does NOT pause", () => {
  const s = makeSandbox();
  const { ctx, el, lists, state } = s;
  el("#rerun").disabled = false;
  el("#search").value = "";
  state.hidden = false;
  vm.runInContext("autoRefresh = true; pollBusy = false; activeFilter = 'all';", ctx);
  el("#view-overview").hidden = true;
  lists.set("#report details[open]", [{}]);
  assert.equal(vm.runInContext("pollPaused()", ctx), false);
});

// ---------------------------------------------------------------------------
// Rich views: ledger, system facts, schedule detail, tab badges.
// ---------------------------------------------------------------------------

test("switchView: all five panes toggle exclusively", () => {
  const store = new Map();
  const s = makeSandbox({ storage: store });
  for (const v of ["history", "checks", "system", "schedule", "overview"]) {
    vm.runInContext(`switchView('${v}')`, s.ctx);
    for (const w of ["overview", "history", "checks", "system", "schedule"]) {
      assert.equal(s.el("#view-" + w).hidden, w !== v, `${w} hidden unless active (${v})`);
    }
  }
  assert.equal(store.get("ld-view"), "overview");
});

test("historyLedgerHtml: rows newest-first with delta and counts", () => {
  const s = makeSandbox();
  const html = vm.runInContext(
    "historyLedgerHtml([{ at: '2026-09-01T10:00:00Z', score: 70, counts: { high: 1, medium: 0, info: 2 } }, { at: '2026-09-02T10:00:00Z', score: 80, counts: { high: 0, medium: 1, info: 2 } }])",
    s.ctx
  );
  assert.match(html, /Past runs/);
  assert.match(html, /80\/100/);
  assert.match(html, /\+10/);
  assert.match(html, /0 high · 1 med · 2 info/);
  assert.ok(html.indexOf("80/100") < html.indexOf("70/100"), "newest run first");
});

test("historyLedgerHtml: fewer than two scored runs renders nothing", () => {
  const s = makeSandbox();
  assert.equal(vm.runInContext("historyLedgerHtml([{ score: 80 }])", s.ctx), "");
  assert.equal(vm.runInContext("historyLedgerHtml([])", s.ctx), "");
});

test("systemFactsHtml: full wiki sections render", () => {
  const s = makeSandbox();
  const html = vm.runInContext(
    `systemFactsHtml({ system: { distro: "Bazzite 44", family: "fedora", arch: "x86_64", kernel: "6.1", cores: "16", uptime: "2h 5m", cpuModel: "AMD Ryzen 7", memTotalBytes: 17179869184, hostname: "lab", desktop: "KDE", sessionType: "wayland", kind: "desktop", atomicVariant: "bazzite", atomic: { pkg: "rpm-ostree" }, osRelease: { VERSION_ID: "44" } }, score: 72, findings: [{ severity: "high" }], checksRun: 41, checksSkipped: 8, generatedAt: "2026-09-03T10:00:00Z" })`,
    s.ctx
  );
  for (const section of ["Operating system", "Hardware", "Session", "This report"]) {
    assert.match(html, new RegExp(section), `missing wiki section: ${section}`);
  }
  assert.match(html, /Bazzite 44/);
  assert.match(html, /AMD Ryzen 7 · 16 cores/);
  assert.match(html, /16\.0 GB/);
  assert.match(html, /immutable \(bazzite\)/);
  assert.match(html, /rpm-ostree/);
  assert.match(html, /72\/100/);
});

test("scheduleViewHtml: full detail card with manage commands", () => {
  const s = makeSandbox();
  const html = vm.runInContext(
    "scheduleViewHtml({ installed: true, enabled: true, active: true, systemd: true }, 'off')",
    s.ctx
  );
  assert.match(html, /Scheduled checks/);
  assert.match(html, /every 24h/);
  assert.match(html, /linux-doctor --uninstall-timer/);
  assert.match(html, /--heartbeat/);
  const empty = vm.runInContext("scheduleViewHtml(null, 'off')", s.ctx);
  assert.match(empty, /unavailable/);
});

test("updateChecksBadge: problem count shown, hidden when clean", () => {
  const s = makeSandbox();
  vm.runInContext("updateChecksBadge({ findings: [{ severity: 'high' }, { severity: 'medium' }, { severity: 'info' }] })", s.ctx);
  const badge = s.el("#tabbadge-checks");
  // getElementById returns el("#tabbadge-checks"); setTabBadge uses document.getElementById too.
  assert.equal(badge.textContent, "2");
  assert.equal(badge.hidden, false);
  vm.runInContext("updateChecksBadge({ findings: [{ severity: 'info' }] })", s.ctx);
  assert.equal(badge.hidden, true);
});

test("syncNoticeGrid: lone visible child spans full width", () => {
  const s = makeSandbox();
  const grid = s.el("#notices");
  const toggled = {};
  grid.classList = { toggle: (c, f) => { toggled[c] = f; }, add() {}, remove() {}, contains: (c) => !!toggled[c] };
  grid.children = [{ hidden: false }, { hidden: true }];
  vm.runInContext("syncNoticeGrid()", s.ctx);
  assert.equal(toggled.single, true);
  grid.children = [{ hidden: false }, { hidden: false }];
  vm.runInContext("syncNoticeGrid()", s.ctx);
  assert.equal(toggled.single, false);
});

// ---------------------------------------------------------------------------
// Product look: compact info rows, evidence line counts, hero stat tiles.
// ---------------------------------------------------------------------------

test("renderCard: info findings render as compact rows, actionables as cards", () => {
  const s = makeSandbox();
  const info = vm.runInContext(
    `renderCard({ check: "zram", code: "zram/ok", severity: "info", title: "All good", detail: "Fine.", evidence: "a\\nb", fix: null }, "info")`,
    s.ctx
  );
  assert.ok(info.includes('card info crow"'), "info rows carry both classes so card selectors keep working");
  const med = vm.runInContext(
    `renderCard({ check: "disk", code: "disk/full", severity: "medium", title: "Disk full", detail: "Full.", evidence: "x", fix: "Clean." }, "medium")`,
    s.ctx
  );
  assert.ok(!med.includes("crow"), "medium findings stay full cards");
});

test("renderCard: evidence summary carries its line count", () => {
  const s = makeSandbox();
  const html = vm.runInContext(
    `renderCard({ check: "x", code: "x/ok", severity: "info", title: "T", detail: "D.", evidence: "one\\ntwo\\nthree", fix: null }, "info")`,
    s.ctx
  );
  assert.match(html, /Evidence — how we detected it · 3 lines/);
});

test("renderStatus: the rail Health block renders and keeps the live ids", () => {
  const s = makeSandbox();
  const counts = vm.runInContext(
    `renderStatus({ findings: [{ severity: "high" }, { severity: "medium" }, { severity: "info" }], system: { distro: "D", kernel: "K", cores: "4", uptime: "1h" }, score: 70, scoreDelta: 2, newCount: 0, fixedCount: 0, checksRun: 41, checksSkipped: 8, cleanStreak: 3 })`,
    s.ctx
  );
  assert.deepEqual([counts.high, counts.medium, counts.info], [1, 1, 1]);
  const html = s.el("#status").innerHTML;
  assert.ok(html.includes("sr-num") && html.includes("sr-pulse"), "health block rendered");
  assert.ok(html.includes('id="scorering"') && html.includes('id="pulsedot"'), "the vital trace and its dot are rendered");
  assert.match(html, /Health/);
  assert.match(html, /1<\/b> high · <b>1<\/b> medium/);
  assert.ok(html.includes('id="scorenum"'), "score id kept");
  assert.ok(html.includes('id="statusdot"') && html.includes('id="statuspill-txt"'), "live checked-ago ids preserved");
});


test("switchView: sidebar report blocks show only on Overview", () => {
  const s = makeSandbox();
  const blocks = [{ hidden: false }, { hidden: false }];
  s.lists.set("#sidebar .sb-block:not(.sb-views):not(.sb-health)", blocks);
  vm.runInContext("switchView('history')", s.ctx);
  assert.ok(blocks.every((b) => b.hidden === true), "report sections hide off-overview");
  assert.equal(s.el("#sidebar").hidden, false, "the sidebar itself stays visible");
  vm.runInContext("switchView('overview')", s.ctx);
  assert.ok(blocks.every((b) => b.hidden === false), "report sections return on Overview");
});
