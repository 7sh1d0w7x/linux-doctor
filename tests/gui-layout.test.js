// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Layout gates. The wide-desktop shell has TWO gates that must agree:
 *
 *   - `src-gui/css/wide.css`   — the `@media (min-width: …)` block
 *   - `src-gui/js/ui-wide.js`  — `WIDE_QUERY`, which toggles `html.wide`
 *
 * They were written as the same number by hand, and nothing stopped them from
 * drifting apart: change one and the other silently keeps the old behaviour
 * (the CSS would uncap at one width while the JS opens the groups at another).
 * The built `src-gui/index.html` is a third copy — it is a committed artifact,
 * so it can also lag behind the sources.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/** The CSS gate: the min-width of the single @media block in wide.css. */
function cssBreakpoint() {
  const css = read("src-gui/css/wide.css");
  const m = /@media\s*\(\s*min-width:\s*(\d+)px\s*\)/.exec(css);
  return m ? Number(m[1]) : null;
}

/** The JS gate: WIDE_QUERY's min-width. */
function jsBreakpoint() {
  const js = read("src-gui/js/ui-wide.js");
  const m = /WIDE_QUERY\s*=\s*"\(min-width:\s*(\d+)px\)"/.exec(js);
  return m ? Number(m[1]) : null;
}

test("wide: both gates declare a breakpoint and they agree", () => {
  const css = cssBreakpoint();
  const js = jsBreakpoint();
  assert.ok(css, "wide.css must declare a @media (min-width: …) block");
  assert.ok(js, "ui-wide.js must declare WIDE_QUERY");
  assert.equal(
    css,
    js,
    "wide.css and ui-wide.js must use the SAME breakpoint — the CSS uncaps the shell and the JS opens the groups"
  );
});

test("wide: the breakpoint stays in the desktop range", () => {
  const bp = cssBreakpoint();
  // Below 1100 the sidebar rail (responsive.css) has not appeared yet, so a
  // master-detail pane there would be a mobile screen with two columns. Above
  // 1440 is the old value that left ordinary laptops without the workbench.
  assert.ok(bp >= 1100 && bp <= 1440, `unexpected wide breakpoint: ${bp}px`);
});

test("wide: the committed index.html carries both gates at that breakpoint", () => {
  const bp = cssBreakpoint();
  const html = read("src-gui/index.html");
  const hits = html.match(new RegExp(`min-width:\\s*${bp}px`, "g")) ?? [];
  assert.equal(
    hits.length,
    2,
    `index.html must contain the CSS gate and the JS gate (found ${hits.length}) — run: npm run build:gui`
  );
});

/**
 * The phone layout stacked the toolbar controls into a column, so every button
 * stretched to full width: six rows of chrome before the first finding. It was
 * fixed to wrap instead, and this is the guard against it coming back.
 */
test("mobile: the toolbar wraps instead of stacking full-width controls", () => {
  const css = read("src-gui/css/responsive.css");
  const block = /@media\s*\(max-width:\s*700px\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  assert.ok(block, "responsive.css must keep a ≤700px block");

  const toolbar = /\.toolbar\s*\{([^}]*)\}/.exec(block)?.[1] ?? "";
  assert.ok(toolbar, "the ≤700px block must style .toolbar");
  assert.match(toolbar, /flex-wrap:\s*wrap/, ".toolbar must wrap");
  assert.doesNotMatch(
    toolbar,
    /flex-direction:\s*column/,
    "a column stretches every control to full width — six rows of chrome before the first finding"
  );
});
