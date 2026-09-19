# Doctrine — what Linux Doctor will not do

Most of this file is about refusals, because they are what makes a verdict worth
trusting. Each claim is enforced by something in the repository, named next to
it: if a claim stops being true, a test fails rather than this page quietly
lying.

## Refusals

**It never changes your system.** Checks read `/proc`, `/sys`, the journal and
the output of read-only commands, and stop there. No check writes to disk or
spawns a mutating command — `tests/doctrine.test.js` fails if one gains a
filesystem handle or a process spawner.

**It does not execute the fixes it prints.** The `fix` line is copy-paste
advice. Running anything is a separate, explicit opt-in: `--fix` is a dry run,
`--fix --yes` executes only the catalogued `[apply]` tier, and `[manual]`
commands are never executed at all. The catalog lives in `src/fix.js`, and a
finding's free-text `fix` is never run.

**It does not phone home.** No telemetry, no analytics, no background pings. The
only outbound paths are features you configure yourself (`--push`, `--alert`,
`--heartbeat`, `--ai`), they refuse private/LAN endpoints unless you pass
`--allow-private-endpoint`, and a check cannot reach them at all:
`tests/doctrine.test.js` fails if `src/checks/` imports an egress module.

**It is not a monitor, an antivirus, or a cleaner.** No real-time metrics, no
background daemon unless you run the Pro agent, no rootkit scanning, no clearing
your caches. The tool's job is to tell you the truth; a tool that also cleans up
has a reason to invent dirt.

**It does not invent a finding to look busy.** A clean machine gets a clean
report, and "skipped" is a first-class outcome: a check that does not apply
(battery on a desktop, reboot on an immutable image, a probe that needs root) is
reported as skipped with a reason instead of producing a plausible-sounding
finding. A wrong finding is worse than no finding, because people act on it.

## How a finding earns trust

- **Severity comes from a rubric, not from taste.** [docs/severity.md](severity.md)
  decides every level, and `tests/codes-registry.test.js` pins each code to its
  allowed severities, its category and its literal form.
- **Clean images stay silent.** CI runs the engine inside Fedora, Debian, Alpine
  and Arch containers and fails when a high or medium finding appears that the
  baseline does not justify (`scripts/baseline-gate.mjs`).
- **Real machines get recorded.** Fixtures captured with `LINUX_DOCTOR_RECORD`
  replay through the real pipeline, and every high/medium finding on that machine
  needs a written reason (`tests/fixtures.test.js`).
- **Every surface gives the same answer.** CLI, dashboard and desktop app render
  the same findings from the same engine; `tests/output-parity.test.js` and the
  golden snapshots keep them from drifting apart.
- **The numbers are auditable.** The health score is `100 − Σ penalties` with a
  printed breakdown, reproducible from the JSON envelope published via `--schema`.
- **Severity and urgency are separate axes.** [docs/severity.md](severity.md)
  grades how bad a finding is; urgency (`now` / `watch` / `fyi`) decides what is
  called out, comes from a reviewed list of codes rather than from severity, and
  never re-grades the score.

## What a new check has to clear

1. It stays silent on the clean images in CI.
2. If it fires on a recorded machine, the fixture carries a written reason.
3. Defaults are conservative and thresholds are tunable
   ([docs/configuration.md](configuration.md)) rather than hard-coded.
4. If we cannot detect when it is wrong, we do not ship it.
5. **A probe's exit status means what it says.** Never end a probe you gate on
   in a pipe: `cmd | head`, `| tail` and `| wc -l` hand the status to the last
   command, which almost always succeeds, so `.ok` stops meaning "I could read
   this" and starts meaning nothing. Slice in JS instead, or probe the binary
   separately. This is not theoretical: it turned unreadable nftables into
   "no firewall", an unprivileged dnf refusal into a broken package database,
   and a failed orphan query into "no orphaned packages".

Contributors: this is the same policy stated as a checklist in
[CONTRIBUTING.md](../CONTRIBUTING.md), and recording a machine fixture is the way
to add a system we cannot represent in a container.
