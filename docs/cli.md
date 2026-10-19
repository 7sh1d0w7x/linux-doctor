# CLI reference

Everything the `linux-doctor` command can do. For the big picture — what the
tool is, downloads, and the check list — see the [README](../README.md).

Every run is read-only unless you explicitly opt in to `--fix --yes`.

**Exit codes:** `0` if nothing serious was found, `1` if there are
high/medium findings, `2` on errors — so the report works in scripts and
cron jobs.

## Health score

Every run gets a **health score (0–100)**: 100, minus 15 per high-severity
and 8 per medium-severity finding — with escalation inside a tier so
problems compound honestly: each additional high beyond the first costs +5
more (15, 20, 25, 30 …), and mediums past the third cost +1 more. Four
failed units must not land anywhere near a pile of annoyances. Findings that
report the same root cause (e.g. software rendering, detected by both the
`gpu` and `wayland` checks) are collapsed into one before scoring, so one
problem never counts twice. The arithmetic is auditable: `scoreBreakdown`
travels in `--json`, and the terminal report prints one compact line under
STATUS (`SCORE 77/100 = 100 −15 disk/full …`), pinned by tests so
`100 − Σpenalty === score`.

## Options

```
--check <id>      run only the given check(s) — comma-separated or repeated
--list            list the checks by category without running them
--plugins         list loaded user plugins and the file each came from
--check-list      list checks as JSON (id, title, category, appliesTo)
--history-json    print run history as JSON (used by the desktop app)
--thresholds-json print current thresholds + defaults as JSON
--thresholds-set <j> merge thresholds from JSON into config
--json            machine-readable JSON output (great for scripting)
--plain           plain, tab-separated text — no colors/emoji, grep-friendly
--summary         one-liner: score + severity counts + delta (for cron/scripts)
--md <path>       save a share-ready Markdown report (IPs and home paths redacted)
--no-history      disable history recording for this run (or set LINUX_DOCTOR_NO_HISTORY)
--history-clear   clear stored run history
--install-timer   install the user systemd timer (daily run + --notify, no sudo)
--uninstall-timer remove and disable the user timer installed by --install-timer
--todo            numbered, copy-pasteable list of what to run, in order
--fix             dry run: show the safe-fix commands for the findings found
--fix --yes       execute the [apply] safe-fix commands ([manual] never runs)
--interactive     browse findings in an interactive terminal UI (needs a TTY)
--notify          desktop notification (notify-send) when new issues appear
--self-test       explain the environment: distro, profile, which checks run
--web             open the visual dashboard in your browser (recommended)
--ai              add an AI summary in plain English (needs LLM_API_KEY)
--ai-local        same, but use a local Ollama model (no cloud, fully private)
--html <path>     save a standalone HTML report (open in any browser)
--compare <file>  diff a previous JSON report against the current run
--push <url>      post the report to a fleet server (FLEET_API_KEY optional)
--severity <s>    show only findings at this severity (high, medium, info)
--ignore <txt>    hide findings whose title contains <txt>
--ignore-code <c> hide findings by stable code (e.g. services/failed)
--ignore-list     show configured ignore patterns and exit
--ignore-add <v>  persistently ignore a code or title fragment (saved to config)
--ignore-remove <v> remove a previously ignored code or title fragment
--init            guided first-run setup (config, timer, notification test)
--init-config     create a starter config file with commented thresholds
--schema          print the JSON Schema for --json output (v1)
--support         write a privacy-scrubbed support bundle for bug reports
--profile         append per-check durations to the report
--license         show Pro license status and exit
--alert <url>     POST a webhook when the machine degrades [Pro]
--heartbeat <url> ping a dead-man's switch after every run [Pro]
--allow-private-endpoint  let --push/--alert/--heartbeat/--ai target private/LAN addresses
--debug        trace every command and its result to stderr (or LINUX_DOCTOR_DEBUG=1)
--daemon          run continuously, re-checking every --interval [Pro]
--interval <s>    seconds between --daemon runs (default 3600) [Pro]
--help            usage
--version      version
```

## Fixing issues safely (`--fix`)

Linux Doctor is read-only by default. `--fix` stays that way: it prints a
**dry-run plan** of concrete commands for the findings on *your* system:

```bash
$ linux-doctor --fix
# linux-doctor --fix (dry run — nothing was executed)
1. [apply] (services/failed) systemctl --user reset-failed 'app-picom@autostart.service'
2. [apply] (timers/broken) sudo systemctl start 'dnf-makecache.timer'
```

Commands come **only** from a small built-in safe-fix catalog (`src/fix.js`)
mapped to stable finding codes — the free-text suggestions in the report are
never executed. Review the plan, then opt in a second time to run it:

```bash
linux-doctor --fix --yes     # runs only [apply]; [manual] items are printed, never executed
```

`[manual]` entries (a pending reboot, firmware updates) are always left for
you to run yourself.

## Interactive mode (`--interactive`)

```bash
linux-doctor --interactive
```

A zero-dependency terminal UI over the report: `↑`/`↓` or `j`/`k` pick a
finding, `Enter` opens its details and evidence, `c` copies the suggested fix,
and `f` copies the safe-fix command when one exists in the catalog. `q` quits.
Without a TTY (pipes, CI) it falls back to printing the normal report.

## Desktop notifications (`--notify`)

```bash
linux-doctor --notify          # also works with --daemon
```

Sends a native desktop notification via `notify-send` when **new** medium/high
findings appear — so a scheduled agent can tell you about degradation without
a terminal. Needs a graphical session; silently does nothing otherwise.

## Plain output (`--plain`)

```bash
linux-doctor --plain
```

Prints the same report as plain, tab-separated lines — no colors, emoji, or
box drawing — so it works in dumb terminals and pipes cleanly into
`grep`/`awk`. Metadata goes to `#` comment lines; each finding is one
`severity<TAB>number<TAB>title` row with `detail`/`fix` rows right after:

```
# linux-doctor
# system: Bazzite 44 · kernel 6.1.0 · 16 core(s) · up 2h
# score: 53/100
# summary: 1 high, 4 medium, 12 info
high    1   3 services failed to start
fix     1   Inspect one with `systemctl status ...`
```

Exit codes are the same as the normal report, so `--plain` works in cron and
scripts too.

## Markdown export (`--md`)

```bash
linux-doctor --md report.md
```

Saves the report as a share-ready Markdown file — the paste-on-forum
successor of "run inxi and paste the output": START HERE, every finding with
its stable code, evidence, and fix, plus what changed since the last run.
Every text field goes through the same scrubbing as the support bundle (IPs,
home paths, UIDs), so the file is safe to post publicly. Exit codes match the
normal report.

## Shell completions

Shell completions (bash/zsh/fish) are in [completions/](../completions/).
Install them with:

```bash
# bash
install -Dm644 completions/linux-doctor.bash /usr/share/bash-completion/completions/linux-doctor
# zsh
install -Dm644 completions/linux-doctor.zsh /usr/share/zsh/site-functions/_linux-doctor
# fish
install -Dm644 completions/linux-doctor.fish ~/.config/fish/completions/linux-doctor.fish
```

## One-command scheduling (`--install-timer`)

```bash
linux-doctor --install-timer
```

Writes a **user-level** systemd timer (no sudo, no root) under
`~/.config/systemd/user/`, then enables it: Linux Doctor runs shortly after
boot and then once a day, with `--notify` attached — so you only hear about
your machine when something **new** appears. The units carry resolved
absolute paths (your node binary + the installed CLI), so they survive npm
relocation. Remove it any time:

```bash
linux-doctor --uninstall-timer
```

Both commands exit `2` honestly when systemd is not running, and never run
checks themselves. For a **system-wide** variant (root, servers, headless),
use the manual timer below instead.

## Run checks automatically (systemd timer)

To run checks automatically, enable the systemd timer:

```bash
sudo cp packaging/linux-doctor.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now linux-doctor.timer
```

Under systemd, `--notify` turns the timer into a watchdog: you only hear
about your machine when something new goes wrong.
