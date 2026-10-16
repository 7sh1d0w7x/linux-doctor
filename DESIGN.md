# Linux Doctor — design system

The desktop app and the dashboard it exports are **one product with two
faces**: the same single-file frontend (`src-gui/`, built by
`scripts/build-gui.mjs` into `src-gui/index.html`) serves the Tauri window, the
`--web` dashboard and the `--html` report. Both faces share every token and
component below.

This document describes what the interface is made of and the rules that keep
it coherent. It is written for whoever touches `src-gui/` next.

---

## 1. The world

A **professional Linux desktop tool**. The craft bar is three applications the
user named when pinning the direction:

| Product | What it sets the bar for |
|---|---|
| **Linear** | density with air, one accent, keyboard-first, restraint |
| **JetBrains Toolbox** | the list-of-tools-with-actions model, a dark professional chrome |
| **GNOME Settings / libadwaita** | the sidebar + rows grammar — what "recognizable as a Linux app" means |

The commitment is the canon, **executed at full fidelity — without irony and
without smuggled quirk.** No specimen plates, no emission lines, no clever
reinterpretation of a familiar control. Two earlier candidate directions were
built, seen rendered, and rejected; they are on record in
`internal/redesign/` and are not part of this system.

### The two rules that decide most arguments

1. **One accent with exactly three jobs**: the primary action, the selected
   row, and focus. Nothing else is accent-coloured.
2. **Severity is the only other colour on screen.** Red, amber, blue-grey —
   and only as an ink dot, a bar, or a word. If a new element needs colour and
   is neither the accent nor a severity, it gets the ink ladder instead.

---

## 2. Tokens

Defined once in `src-gui/css/base.css`. Every other stylesheet uses the
variables; a hard-coded colour outside `base.css` is a bug (the only exceptions
are `print.css`, where paper is always white, and `color-mix()` darkening).

### Surfaces

A single neutral ladder, tinted from one hue — no second temperature appears
anywhere.

| Token | Role |
|---|---|
| `--bg` | the window |
| `--bg2` | chrome: headerbar, rail, status bar |
| `--card` | rows and panels |
| `--card2` | controls: inputs, segmented tracks, pills |

### Ink

| Token | Role |
|---|---|
| `--text` | primary text |
| `--muted` | secondary text, row codes |
| `--muted2` | labels, helper text, status bar |

### Severity inks

`--red` (high), `--yellow` (medium), `--blue` (info), plus `--green` (fixed /
positive) and `--purple` (the NEW badge). Used for ink dots, progress fills and
severity words.

### On-fill inks

`--on-accent` and `--on-ok` are the text colours that sit **on** an accent or
green fill (primary button, toast action, recommended-action button). They are
per-theme on purpose: white passes on the light theme's darker accent, dark ink
passes on the dark and terminal themes' brighter ones. Never write `#fff` on a
fill.

### Geometry

`--radius: 10px` (panels), `--radius-sm: 6px` (rows, controls), `--radius-lg:
12px` (the command palette). Two values plus one. Shadows are one token, used
only for popovers.

---

## 3. Type

One UI sans (`--sans`) and one mono (`--mono`), the mono reserved for things
that are *identifiers or counts*: check codes, commands, freshness, versions,
PIDs, durations. Numbers are `font-variant-numeric: tabular-nums` so columns
line up. Identifiers shown in a view (kernel, hostname, version, profile,
desktop) are mono **and copyable in place** — the value is what you paste into
a bug report.

Scale, in use: `10` labels · `11` meta · `12.5` body/rows · `13.5` app title ·
`32` the health score. Nothing larger ships in the interface; the size
hierarchy is carried by weight and colour, not by display type.

---

## 4. Components

**Headerbar** (48px, full-bleed). App mark, then the window identity as two
lines — title over a mono `distro · kernel · cores · uptime · version`. Actions
on the right, one of them primary. A hairline highlight in `inset` gives the
chrome depth without a shadow.

**Rail** (236px, flush to the window edge, `≥1100px`). Top block is
**Health**: the score, a progress hairline, the headline, one counts line and
the freshness footer. Below it, the sections — Views, Why this score, Severity,
Categories — separated by hairlines, with the active row carrying a 16% accent
wash. Below 1100px the rail collapses to a segmented view strip and the Health
block stays at the top of the flow.

**Toolbar** (sticky under the headerbar). A segmented group-by control, severity
pill filters, a search field, then icon+label buttons. Toolbar icons are drawn
with **CSS masks** from one 13px single-stroke set (`--ic-rows`, `--ic-checks`,
`--ic-x`, `--ic-expand`, `--ic-pulse`), so a JS label change ("Expand all" →
"Collapse all") keeps the icon and the ink follows `currentColor`.

**Rows** are the finding unit — never a card. A row is: severity dot with a
soft halo · title · quiet mono code / NEW badge · chevron. Hover is a surface
change; opening reveals detail, evidence and the recommended next step in
place. Severity is carried by the dot, not a coloured left border.

**Group headings** are sentence case section labels with a hairline underline
and a count — not boxes.

**View header and section rule.** Every view that is not Overview opens the
same way: a `view-head` — a title and one line of purpose. Sections inside a
view use the report's own rule: a label, a hairline underneath, a count on
the right. Never a stack of competing cards.

**The four dedicated surfaces.** History, Checks, System and Schedule each
carry one idea in the first three seconds:

- **History** — *has the machine held or slipped?* The score, its direction
  chip and its sparkline are **one instrument**: the trace sits directly under
  the score (the same shape-from-data language as the rail's vitals pulse, not
  a hairline floating at the bottom of a column). Each severity bar is one
  run, dated on hover, with the run window printed under the chart. The run
  ledger is a table with a header row (`when · score · Δ · findings`), mono
  timestamps and tabular numbers.
- **Checks** — *what did it look at, and what is not clean?* The whole
  registry as a table: a count per category, a sticky `check · result` column
  rule on desktop, a **fixed result vocabulary** (`clean`, `observation`,
  `warning`, `needs attention`, `not applicable`, `skipped`, `failed to run`)
  carrying the severity ink, and a *Problems only* filter that drops the clean
  rows. A row with findings still deep-links to its card.
- **System** — *what is this machine?* One list of sections under section
  rules, grouped by how they are read — *Read once* (identity) vs *Read when
  something's wrong* (live state) — never four separate cards. Identifiers
  (version, kernel, hostname, profile, desktop) are mono and copyable in place.
- **Schedule** — *will it check itself tomorrow?* An instrument row answers
  **last run · next run · timer state** with a green/amber state dot; the
  cadence is the caption under it; the commands are printed as recipes — the
  same accent-ruled mono slip as *Recommended next step* — so the command is
  the information, with a copy button beside it rather than a button that
  hides it.

**Detail pane** (`≥1200px`): the selected row's body pins to the right; below
1200 the row expands inline. Same content, two presentations.

**Status bar**: current view, freshness, the read-only promise, the keyboard
map.

**Command palette** (`Ctrl`/`Cmd`+`K`): views, actions and the findings already
in memory, grouped and filtered as you type; ↑↓ move, ↵ runs, `Esc` closes.

**Skeletons** on load show the *shape* of the incoming content (bars in the
rail, rows in the list) rather than a spinner. **Empty states** always pair a
short sentence with a way out ("Nothing matches “x” · Clear filters").

---

## 5. Themes

Dark is the default. `light` and `terminal` re-derive the same tokens — **no
component CSS is theme-specific**. The terminal theme takes over `--sans` with
mono, sharpens the radii and flattens the shadows.

---

## 6. Accessibility

- **Contrast is verified, not assumed.** `scripts/check-contrast.mjs` computes the
  WCAG ratio of every ink/surface pair in all three themes; the current matrix
  has **0 failures** (body text ≥ 4.5:1, labels and non-text ≥ 3:1, on-fill ink
  ≥ 4.5:1). Re-run it after any palette change.
- **Focus** is `:focus-visible` only: a 2px accent outline, offset. Rows use
  `outline-offset: -2px` so it stays inside the list.
- **Motion** is short and directional (view switch, score count-up, hover). All
  of it is disabled under `prefers-reduced-motion`.
- **Keyboard**: `/` search · `Ctrl K` palette · `↑↓` navigate rows · `Enter`
  open · `1`–`5` views · `Esc` close/clear · `?` help.

---

## 7. Do / Don't

| Do | Don't |
|---|---|
| Use the token ladders | Hard-code a hex outside `base.css` |
| Carry severity in a dot/ink | Give a card a red left border |
| Let one accent do three jobs | Introduce a second accent for "variety" |
| Use `text-transform` for labels only | Shout a sentence in uppercase |
| Pair an empty state with an action | Leave a dead end |
| Keep toolbars icon **and** label | Ship icon-only buttons without a tooltip/aria-label |

---

## 8. Provenance

- Source: `src-gui/css/*.css`, `src-gui/js/*.js`; the markup lives in
  `scripts/build-gui.mjs`. Build with `npm run build:gui`.
- Screenshots shipped in `docs/screenshots/` are regenerated from the real
  dashboard (`node scripts/screenshot.mjs`) — never hand-edited.
- The direction, the rejected candidates and the review page live under
  `internal/redesign/` (local only, not shipped).
- Development is AI-assisted; see `README.md`.
