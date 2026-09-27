# Changelog

All notable changes to Linux Doctor are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and versioning follows
[SemVer](https://semver.org/).

## [Unreleased]

### Fixed

- **`orphans` no longer calls a failed query a tidy database on apt, zypper
  or pacman.** Only the dnf branch checked whether its query actually ran; the
  other three piped through `grep`/`grep -c`, so a locked apt or a failed
  zypper printed nothing and the check reported "No orphaned packages". They
  read the raw output and count in JS now, and stay silent when the query did
  not run.
- **`backup` no longer says "nothing is scheduled" when it cannot read the
  schedule.** On a non-systemd system with a backup tool installed the timer
  list was empty for lack of `systemctl`, not for lack of a schedule; it says
  the schedule could not be checked now (`backup/unknown`).
- **`reboot` no longer says "No reboot needed" in a container.** A
  container has no kernels of its own, so the empty `/boot` list read as "the
  running kernel is the newest". It skips in a container, and stays silent
  when no kernel list can be read.
- **`boot`'s `df` probe no longer runs through `tail`.** Its exit status
  belonged to `tail`, so a failed `df` looked successful; the data row is
  taken in JS now.
- **`processes` sums memory per app, not per process.** A browser spreads
  its memory across many processes that share one binary, so the check listed
  "brave" twice, reported one process as if it were the app's footprint, and
  missed the real total. The top consumers are summed per binary now.

## [0.7.1] - 2026-09-26

### Fixed

- **`memory`, `zram` and `fstrim` no longer report the HOST's state inside a
  container.** `/proc/meminfo`, `/proc/swaps` and `lsblk` are not namespaced,
  so a 256MB-limited container's `free -b` reported the host's 15GB — the same
  lie `load` used to tell. The container detection is now shared
  (`detectContainer`) and all four checks skip with an explanation.
- **`processes` works on Alpine now.** The check asked `ps` for
  `--sort=-rss`, which busybox does not support, and busybox also ignores the
  column after `args=`, so the rss number was lost and the empty result read
  as "no consumers". It uses `ps -eo rss,args` (the one column order that
  works on both procps and busybox) and sorts in JS.
- **`timers`, `fstrim` and `hardware` say when they cannot run.** On a
  non-systemd system, or when lsblk/journalctl is missing, they returned
  silently, which read as "nothing wrong". They emit an explicit skip now.
- **Checks that could not run now say so instead of staying silent.** The
  `missing` flag was only set when the shell itself was absent, which never
  happens: a missing tool exits 127 through the shell instead. So every check
  that gated a "could not check" skip on `missing` stayed silent, and a
  minimal system scored as if those checks had passed. `run()` marks 127 as
  missing now, which activates the skip findings that were already written
  (`memory/skipped`, `journald/skipped`, `smart/skipped`, and more), and
  `processes`, `ports` and `certs` gained the explicit skips they lacked.
  A score now comes with the list of what could not be checked: on a minimal
  Debian image that is memory, processes, ports and the systemd checks, each
  naming the package that would fix it.

- **Three update checks were answering a question no one asked.** Found by
  running the engine against real package managers, not by reading code.
  `zypper` counted through `awk`, which is not installed on a minimal openSUSE
  image: the pipeline produced nothing and Tumbleweed reported "System is up
  to date" with thirteen lines of updates on screen. `apk info -u` is not a
  valid command (it exits 1 with "unrecognized option 'u'"), so Alpine
  silently reported nothing at all. Void had no update branch, so a machine
  with 54 pending updates was skipped and scored as current. All three read
  the raw output and parse it in JS now, with no `awk`/`wc` dependency.
- **apt with an empty package index no longer claims "up to date".** A fresh
  image, or a machine that never ran `apt update`, answers "0 upgraded" with a
  zero exit status. That is not being up to date, and reporting it as such is
  the dangerous direction of being wrong: the check says it could not
  determine the state and points at `apt update`.

- **The KDE lock screen's retry message is no longer counted as a system error.**
  `kscreenlocker_greet` logs `Authentication attempt too soon` when you retype a
  wrong password quickly, and repeats it a few times, so a healthy desktop got a
  medium "6 recognized errors" worth 8 points of health score. Only the screen
  locker's copy is noise: the same string from `sshd` stays an error, because
  that one is worth seeing. Also fixes `scripts/screenshot.mjs`, which waited
  for a selector that does not exist and therefore never ran.
- **Flatpak app caches are measured now.** The cache check looked at `~/.cache`
  and Trash only, so the per-app caches under `~/.var/app/<id>/cache` were
  invisible, which on a Flatpak-heavy distro is the larger half: on the
  maintainer's Bazzite box `~/.cache` held 3.5 GB while `~/.var/app` held
  5.3 GB, and the report said nothing about it. Both are measured and counted
  toward the same thresholds now, and the biggest offenders are named.
- **`zram` no longer calls a half-full compressed swap "healthy".** High
  occupancy is not a fault by itself (zram is meant to be used and cold pages
  sit there for days), so the severity stays informational. What changed is
  the wording: it reports how much is compressed, says the kernel is working
  to keep up, and points at the `processes` and `cache` findings. Inflating it
  to medium would be grading by distance from normal.
- **`network` called a missing `iproute2` "no default route".** Minimal
  Debian, Fedora and Ubuntu images do not ship `ip`, and the probe's failure
  was read as an empty route table: a medium "No default network route" on a
  machine with a perfectly good route. The tool's presence is probed
  separately now, and a missing `ip` is an explicit skip with the install
  hint.
- **`load` is skipped inside a container.** `/proc/loadavg` is not namespaced:
  in a container it is the host's load average while `nproc` reports the
  container's CPUs, so the ratio invented an overloaded system out of an idle
  container (all five test images reported it). The check says why it is
  skipping and stays quiet there.
- **`hardware` answered "no errors" only by accident.** The check used the
  exit status of `journalctl ... | grep ...` as its readability gate, but grep
  exits 1 when nothing matches, so its status meant "found something", not "I
  could read the log". On a healthy machine with no MCE/EDAC line at all it
  said nothing instead of "No hardware errors logged". A benign EDAC banner
  made grep exit 0 on the maintainer's box, which hid it.
- **`timers` no longer calls a timer with an unmet start condition broken.**
  `dnf-makecache.timer` is enabled on an immutable system and can never run:
  its start condition is unmet by design (`systemctl status` says so). The
  check asked only whether the timer was enabled and had never fired, so it
  reported a broken schedule the user cannot fix. It consults
  `ConditionResult` now.

## [0.7.0] - 2026-09-22

### Added

- **Two public documents about trust rather than features.**
  [docs/limitations.md](docs/limitations.md) lists what the tool does not
  detect and every false positive it has shipped and fixed, with the regression
  test that guards each one;
  [docs/compatibility.md](docs/compatibility.md) defines what counts as a
  public API (flags, exit codes, the JSON schema, finding codes, config keys,
  the check shape) and how a change to it is announced.
- **`F11` toggles fullscreen in the desktop app.** Three things had to agree for
  that to work (the key handler in the dashboard, `withGlobalTauri` so the page
  can reach the window API, and the `set_fullscreen` capability), so a test now
  fails if any of them goes missing. The browser dashboard keeps using the
  browser's own fullscreen.

### Fixed

- **The in-app update dialog now says what changed.** The updater manifest
  carried an empty `notes` because the generator only looked at
  `RELEASE_NOTES`, which the release workflow never sets: the GitHub release got
  the changelog section and the updater got nothing. The generator reads the
  section for the version out of `CHANGELOG.md` now, and an explicit
  `RELEASE_NOTES` still wins.
- **The packaged AppStream metadata no longer lags a release behind.** The
  `<releases>` list in the metainfo that app stores and `appstreamcli` read was
  updated by hand, and it drifted: after 0.6.1 shipped the file still advertised
  0.6.0. The release script adds the entry now (newest first, idempotent), the
  0.6.1 entry is in place, and tests hold the rule.
- **`security/autologin` never read the Debian GDM config.** The probe listed
  `/etc/gdm` (the Red Hat, openSUSE and Fedora layout) but not `/etc/gdm3`,
  which Debian, Ubuntu and Mint use, so an enabled autologin there was read as
  nothing at all. Both layouts are searched now, and a test pins the Debian
  path. Adding it is only safe because the comment filter below stops the
  commented examples that Debian's `daemon.conf` ships by default.
- **Five more wrong results, found by auditing every check against real input.**
  Each one was reproduced before it was changed, and each has a regression test
  that fails without the fix:
  - **`security/autologin` fired on a commented example** (the
    `# AutomaticLoginEnable=true` line several distros ship by default), on an
    explicit `false`, and on a bare `[Autologin]` section header. Comments are
    ignored now, GDM needs a true value, and SDDM needs a `User=` line inside
    the section.
  - **`flatpak` reported "apps are up to date" with updates pending.** The
    default `remote-ls --updates` output is a column table whose fields contain
    no `/`, and that is what the old count looked for. It asks for
    `--columns=application,version` now, with a table fallback for older
    flatpak.
  - **A `FAULTED`, `UNAVAIL`, `REMOVED` or `SUSPENDED` ZFS pool was reported as
    "RAID arrays are healthy".** Only the word "degraded" was recognised, so
    everything worse fell through to the healthy branch. Only `ONLINE` counts as
    healthy now, and a running scrub is no longer called a rebuild.
  - **A full root filesystem was reported as a full `/boot`.** `df -P /boot`
    prints the root row when `/boot` is a directory on `/`, and the columns look
    identical. The row is only used when its mount point is the requested one.
  - **`crash` could report a kernel panic from the Intel machine-check boot
    banner** (`Intel machine check reporting enabled on CPU#N`) on machines that
    reboot often. It defers to the same classifier the hardware check uses.
- **`packages/locked` accused linux-doctor of holding the dpkg lock.** The lock
  probe ran beside the tool's own `apt-get check`, and the `updates` and
  `orphans` checks take the same frontend lock, so `fuser` found linux-doctor
  itself. Run as root on a healthy machine that produced a medium finding
  naming the tool's own process (#24). Only holders outside linux-doctor's
  process group are reported now, and the evidence lists the PIDs alone.
- **`packages/locked` reports nothing when it cannot read its own process
  group.** Without `ps` to tell linux-doctor's own package-manager processes
  apart from another process, every lock holder would look foreign — exactly the
  false positive #24 removed. The attribution moved from the shell pipeline into
  JS, where a test pins the quiet fallback (#25).

## [0.6.1] - 2026-09-17

### Fixed

- **`hardware/ecc` fired on machines with no ECC.** The check matched the EDAC
  driver's own init lines (`EDAC MC: Ver: ...` and `EDAC ie31200: No ECC
  support`), so a healthy box reported a corrected memory error; on some systems
  that was the top item in the report. It needs a real CE/UE event now.
- **`hardware/mce` fired on the MCE banks boot line.** `mce: CPU supports N MCE
  banks` is printed once per CPU at boot on every Intel machine, and it was
  reported as a machine check exception (high). Routine init lines are rejected.
- **`fs/btrfs-errors` fired on the btrfs module load banner.** `Btrfs loaded,
  zoned=yes, fsverity=yes` is printed at boot on any kernel with btrfs compiled
  in, mounted or not. The pattern requires a real event and still catches
  `BTRFS critical`, `failed` and `corrupt`.
- **An uncorrected memory error was filed as "corrected".** An EDAC `UE` line
  raised `hardware/ecc` at medium; it is high now, with its own wording.
- **`packages/broken` fired on apt's own lock refusal.** Without root,
  `apt-get check` cannot take the dpkg frontend lock, and that refusal was read
  as broken dependencies (high). The healthy finding says "skipped (needs root)"
  instead of claiming the check ran.
- **`packages/broken` fired on `pacman -Dk`'s success line.** "No database
  errors have been found!" contains the word "errors", so a clean Arch system
  was reported as a broken package database.
- **`updates` doubled the count on dnf.** `dnf check-update` prints a header,
  indented obsoletion lines and one entry per enabled repo, so 314 pending
  updates read as 630. Unique package names are counted now.
- **`journal` counted stack-trace lines as separate entries.** One multi-line
  entry was counted once per continuation line, which turned a few crashes into
  "3062 unrecognized log entries".
- **The desktop webview could come up blank** where WebKit's DMA-BUF renderer
  fails; it is disabled by default now.

### Changed

- **Install instructions lead with `npx linux-doctor`**, the published package,
  with the GitHub form kept for the current `main`. The Arch section no longer
  claims an AUR package that does not exist yet.
- **CI gates the checks against clean images and recorded machines.** The engine
  runs inside Fedora, Debian, Alpine and Arch containers, and replays fixtures
  recorded on real machines; both fail on an unjustified high or medium finding.

## [0.6.0] - 2026-09-13

> **Highlights:** the desktop grows into a real app — bundled Node runtime, tray + single-instance + autostart, **auto-update**, adaptive window — and the dashboard gets a wide-screen workbench (master-detail, status bar, deep-linkable state). A correctness pass fixes checks that were silently wrong or could never fire, and a hardening pass covers state files, outbound data and the release pipeline. No breaking changes; the JSON schema stays v1.

### Added

- **Desktop app: auto-update.** The app checks GitHub Releases for a newer
  signed build ~12s after startup and from a tray **Check for updates** item;
  a native dialog offers to install and restart. Artifacts are
  minisign-signed (public key in `tauri.conf.json`, private key a CI secret),
  the updater manifest is assembled by `scripts/make-latest-json.mjs`, and a
  release fails fast if the signing secret is missing. On Linux the updatable
  artifact is the AppImage (deb/rpm stay package-manager updates).
  `LINUX_DOCTOR_NO_UPDATE=1` disables the check.
- **The desktop app is a tray app.** A second launch surfaces the existing
  window (single-instance, no second report server losing the fixed port); the
  tray offers Open / Run checks now / Start at login (official autostart
  plugin) / Check for updates / Quit, all handled Rust-side (Tauri IPC is not
  used in this stack). Missing-tray systems fail soft.
- **The desktop app bundles its own Node runtime.** .deb/.AppImage/.rpm ship a
  pinned Node 22 LTS binary under `<resources>/runtime/node`, hash-checked
  against the official SHASUMS256.txt at build time — end users need nothing
  on their PATH. The fetch is architecture-aware (x64 + arm64), so a local
  arm64 build embeds the right runtime. `LINUX_DOCTOR_NODE` still overrides.
- **Wide-screen desktop workbench (≥1440px).** The app shell uncaps and fills
  the monitor; Overview becomes a master-detail view — the findings list stays
  put while the selected finding renders in a pinned detail pane. Findings
  groups open, rows densify, and a persistent status bar shows the active view,
  freshness and the keyboard map. Below 1440px everything is unchanged.
- **Deep-linkable dashboard state.** View, severity filter, grouping, theme and
  density travel in the URL (`?view=checks&sev=high&group=category&theme=terminal`),
  so a refresh or a pasted link restores the exact workbench. Free-text search
  is deliberately never written to the URL.
- **`--debug` command tracing and a per-check deadline.** `--debug` (or
  `LINUX_DOCTOR_DEBUG=1`) traces every spawned command, its duration, status
  and (on failure) the stdout/stderr tail to stderr — stdout stays
  machine-clean. Each check is now capped at 45s wall-clock (recorded in
  `checkErrors`), so a check with many sequential commands cannot stretch a run.
- **`--allow-private-endpoint`** for `--push`/`--alert`/`--heartbeat`/`--ai`:
  opt in to a self-hosted LAN server that the new destination guard would
  otherwise refuse.

### Changed

- **Dashboard "Re-run checks" records the run in history.** The trend and the
  new/fixed diff advance when the user asks for a run (with a confirmation
  toast); the 20s background auto-refresh still never writes history.
- **Redundant probes removed.** The Fedora package check no longer runs two
  full `rpm -Va` verifications whose result was never used; the apt orphan
  check runs `apt-get -s autoremove` once (count + sample); `glxinfo` is
  memoized per run (was spawned by both the gpu and wayland checks); the
  hardware check reads the kernel log once instead of twice.
- **The desktop window fits the screen** instead of a fixed 1500×950: centered,
  clamped to the monitor minus a margin, never below 900×640, shown only after
  sizing (no resize flash).
- **`npm run gui:build` / `gui:dev` fetch the bundled Node runtime first** (a
  no-op when the right version is present), so a local build cannot package a
  stale or missing interpreter.
- **Releases smoke-check the packages** before publishing: the gui job asserts
  the built `.deb`/`.rpm` contain `runtime/node` and runs the bundled
  interpreter.
- **Docs:** support-bundle privacy claims corrected; the plugin/Pro trust model
  is stated in the README and configuration.md; README notes the bundled
  runtime and its ~130 MB size.

### Fixed

- **`smart/failing` could never fire.** `smartctl -H` exits non-zero when a
  drive is FAILING, and the code skipped any non-zero result before reading the
  health string — a failing disk was silently ignored. The health string is now
  read first; a dying disk is reported as high.
- **Desktop machines were classified as servers.** The profile probe read
  `loginctl`'s UID column instead of the seat, so every battery-less desktop was
  "headless" and all desktop checks (wifi, gpu, bluetooth, wayland, audio,
  cache) were skipped. The probe now finds the seat token regardless of column
  layout (shared with the wayland check).
- **The crash check reported the lifetime boot count.** `journalctl --list-boots`
  ignores `--since`; the boot count is now computed from the JSON form and
  filtered to the last 7 days — "62 reboots in the last 7 days" became the true
  count.
- **Atomic detection on composefs-overlay distros.** `findmnt -T /` reports
  `overlay` on Bazzite/Silverblue, so `immutable` disagreed with `imageBased`
  and atomic skips plus the report note were suppressed; `immutable` now also
  derives from the os-release `imageBased`/`bootc` signals.
- **The `locales` and `fds` checks could never fire.** `locales` runs with
  `LC_ALL` unset for its one probe (the forced `LC_ALL=C` masked the exact error
  it looks for); `fds` now measures per-process pressure against
  `RLIMIT_NOFILE` (the real "too many open files" mode) because `fs.file-max` is
  effectively unlimited on modern kernels.
- **One OOM kill looked like a pattern.** The oom check counted log lines; one
  kill writes both a "Killed process" and a "reaped process" line, so it was
  reported as two kills at high. It now counts distinct PIDs.
- **No more false "no firewall" without root.** `nft list ruleset` needs
  CAP_NET_ADMIN; when the ruleset cannot be read and no firewall service is
  active the result is a new `security/firewall-unknown` (info, no fix) instead
  of claiming there is no firewall, and `ports` says "firewall status unknown".
- **Fedora-family updates had no safe fix.** The catalog switched on a
  `family === "rhel"` case that `detectDistro` never returns (it normalizes to
  `fedora`); Fedora/RHEL now get `sudo dnf upgrade`.
- **Alpine/BusyBox no longer go quiet.** Missing `getent` is `network/skipped`
  (was a false "DNS is failing"); an unusable `df`/`df -i` is
  `disk/skipped`/`inodes/skipped`; `free` without an `available` column falls
  back to `/proc/meminfo`; `fstrim` no longer counts zram/loop devices as SSDs.
- **`durations` matches its schema.** `--json --profile` emitted an array while
  the schema (and the dashboard) used a check→ms object; both channels now emit
  the object.
- **A malformed threshold can no longer become 0.** `Number("")`/`Number([])`
  are 0; only a real number or non-empty numeric string is accepted now (CLI,
  dashboard and config share one coercion).
- **Dashboard Re-run/history, URL state, and the wide layout:** `?view=` deep
  links win over the remembered view; search text is no longer written to the
  URL; the desktop shell detects the webview via `tauri://localhost` too and
  surfaces the real service error; the static `--html` export keeps the Skipped
  section; sticky chrome is opaque (the toolbar/status bar no longer show
  content through them) and the detail pane sticks below the toolbar.
- **Desktop app: the dashboard could never parse a report.** The loopback
  report server wrote an extra CRLF after the CORS block, leaking
  `Content-Length`/`Connection` into the JSON body. Fixed with a regression
  test.
- **Start-at-login no longer lies.** The toggle re-reads the real autostart
  state, reflects it in the checkbox, and logs the actual outcome; it is also
  panic-safe.
- **Rust children drop `NODE_OPTIONS`/`NODE_PATH`** alongside `LD_*`, so a
  poisoned environment cannot inject a preload module into the Node checks.

### Security

- **State files are written atomically and privately.** config.json (which may
  hold the Pro license key), history, cache, the support bundle and systemd
  units go through one `atomicWrite()` helper: a unique temp sibling opened
  `O_CREAT|O_EXCL` (a planted symlink fails instead of being written through),
  `0600` files in `0700` directories, replaced by rename.
- **Egress is checked by destination, not just scheme.** `--push`, `--alert`,
  `--heartbeat` and `--ai` refuse private/LAN address literals (RFC1918,
  link-local including the cloud metadata address, CGNAT, IPv6
  ULA/link-local) unless `--allow-private-endpoint` is passed, and all four
  refuse HTTP redirects. `LLM_BASE_URL` goes through the same guard: an API key
  can no longer be sent to a plaintext non-loopback endpoint.
- **Destructive safe-fixes are now `[manual]`.** Enabling a firewall (ufw can
  lock out SSH), package autoremove, container prune and Trash deletion are
  printed but never auto-executed by `--fix --yes` — a false positive can no
  longer delete packages/data or cut a remote session.
- **Outbound and shared data is scrubbed.** `--alert`/`--push` carry scrubbed
  finding text; `--html` is scrubbed like `--md` (whole payload + hostname);
  the support bundle walks every field (plugin extras included); endpoint
  credentials are redacted from messages; `scrub()` is linear (a crafted colon
  run could hang a run); `/run/media` and `/media` user paths are redacted.
- **`--html` can no longer be weaponized.** The payload is embedded through
  `jsonForInlineScript()` (`<` → `\u003c`), so a `</script>` in any field
  cannot close the tag; the dashboard header escapes its payload fields.
- **Loopback report endpoints are cached and single-flight.** Repeated/drive-by
  requests share one scan, the tray's "Run checks now" coalesces, and
  connections get a read timeout; dashboard polls never write history.
- **A corrupt config is no longer silent**, and the dashboard rejects
  cross-origin writes and non-loopback Host headers as before.
- **Release pipeline hardened.** Every GitHub Action is pinned to a full commit
  SHA; the default token is `contents: read` with write scopes only on the two
  build jobs; publish/attest steps are gated on `refs/tags/v`; and the bundled
  Node is hash-pinned (v22.23.2).


## [0.5.0] - 2026-09-05

> **Highlights:** 8 new server checks (TLS certs, exposed ports, fd pressure, RAID, containers, service restart loops, GPU memory, stale backups) — the catalog grows to **49 checks / 161 codes**; `--init` guided first-run setup; `--heartbeat <url>` dead-man's switch [Pro]; `--ai-local` private offline AI summaries; the dashboard becomes a five-view app (Overview / History / Checks / System / Schedule) with a Terminal theme and a machine wiki. No breaking changes — the JSON schema stays v1.

### Added

- **Terminal theme for the dashboard.** A phosphor-console look (near-black green-tinted background, monospace throughout, sharp corners, flat surfaces, green accents) as a fourth theme option behind the header button — same layout, same contrast budget, variables only.
- **Cockpit-style app navigation.** The five views move into a sidebar rail with icons and live count badges on wide screens (scrollable tab bar below that width); secondary panels share a two-column card grid beside START HERE instead of stacking full-width. Same renderers, same keyboard flows, same remembered choice.
- **Product-look pass on findings and hero.** Informational findings now render as compact one-line rows (dot + title + code, full body on open) instead of full cards; evidence summaries carry their line count; the hero's empty right side is now four stat tiles (problems, checks, clean streak, last check with the live checked-ago indicator).
- **Dashboard content order.** START HERE takes the full width first; the daily-check strip and the security posture share a two-column notices row beneath it (spanning full width when only one is visible) — the Overview spine reads hero → START HERE → findings with no information or action removed.
- **System view is a full machine wiki.** The report payload now carries architecture, hostname, CPU model, total RAM, desktop, and session type (additive schema fields, still v1); the view renders them as Operating system / Hardware / Session sections next to the report summary.
- **Dashboard app views: Overview / History / Checks / System / Schedule.** The single scroll now has homes: today's report stays exactly as-is under Overview (the default), History gains a newest-first run ledger beside the trend charts, the all-checks matrix renders inline under Checks, System shows machine facts plus the report summary, and Schedule shows timer status, cadence, notification state, and copy-paste setup/alert/heartbeat commands. Tabs carry live count badges; tab bar, `1`–`5` shortcuts, roving arrow-key tabs, remembered choice — existing filters, keyboard flows, and the auto-refresh pause behavior are untouched.
- **`--init` — guided first-run setup (Free).** Detects the environment (profile, systemd, node), then offers the three steps that turn a one-off run into set-and-forget monitoring: a starter config, the daily systemd timer, and a desktop-notification test. Every mutating step asks first; without a TTY it prints the same steps as copy-paste commands.
- **`--heartbeat <url>` [Pro] — dead-man's switch.** Pings a heartbeat URL (Healthchecks.io, BetterStack) with a bare GET after every completed run, in one-off and `--daemon` mode. The ping carries no body — liveness only — and failures are warnings, never exit-code changes. Same Pro gate and URL validation as `--alert`.
- **ntfy examples for `--alert` in docs/integrations.md.** Phone push via ntfy (self-hostable, no account) plus the `--heartbeat` complement, so scheduled runs reach a human without a fleet server.
- **4 new server checks — the catalog grows to 49 checks / 161 codes:**
  - `certs` — TLS certificate expiry, the classic silent outage: reads certbot state (`/etc/letsencrypt/live/*/cert.pem`) *and* the actually-deployed cert via `s_client` against locally-listening TLS ports (catches "renewed on disk but never reloaded"). Expired or <7 days → **high**, <30 days → **medium**. Tunable `certWarnDays` / `certCritDays`.
  - `ports` — risky services (MySQL, PostgreSQL, Redis, MongoDB, FTP/Telnet…) listening on non-loopback interfaces, cross-checked against the firewall (same signals as the security check). Exposed with no firewall → **medium**; firewalled or clean → informational.
  - `fds` — file-descriptor pressure from `/proc/sys/fs/file-nr`: the "server dies mysteriously with no metric spiking" cause. ≥95% of the kernel limit → **high**, ≥90% → **medium**, healthy stays silent.
  - `backup/stale` — extends the backup check: a scheduled backup timer that never triggered, or last ran over `backupStaleDays` (30) ago, is **medium**. A backup that never runs protects nothing.
- **Dashboard "Daily check" strip.** The report now opens with the scheduling
  state: whether the user timer (`--install-timer`) is installed and active,
  plus the browser-alerts state — with a one-click copy of the setup command
  when the timer is off. Served read-only from the new `GET /api/schedule`
  endpoint (no report-schema change); hidden for static `--html` exports.

- **New `--ai-local` flag — private, offline AI summaries.** Points the existing AI summary at a local Ollama instance (`http://localhost:11434/v1`, model `llama3.2`, any key) so the plain-English explanation runs entirely on your machine with no cloud and no `LLM_API_KEY` to a third party. Finding text is still redacted with the same `scrub()` before it ever leaves the box.
- **New `gpu-usage` check:** GPU memory pressure for AI/homelab rigs — reads VRAM used/total for NVIDIA (`nvidia-smi`) and AMD (`amdgpu` sysfs, no tool needed). Stays silent on an idle card, reports usage as informational when the GPU is working (≥50%), and flags VRAM nearly full (≥90%) as **medium** — the OOM risk when you try to load a bigger model. Complements the existing `gpu` driver-health check.
- **3 new server checks:**
  - `raid` — software RAID health: a degraded mdadm array (parsed from `/proc/mdstat`, no binary needed) or a `DEGRADED` ZFS pool is flagged **high** (data-loss risk), a resyncing/scrubbing array is **medium**, healthy arrays get an informational line. Server-scoped (pass `--check=raid` to force it anywhere).
  - `containers/dead` + `containers/oom` + `containers/restarting` — extend the container check: a container that exited non-zero is **medium**, one killed by the OOM killer (exit 137) is **high**, and one stuck in a restart loop is **medium**. Read-only via `podman ps -a` / `docker ps -a`.
  - `services/restart-loop` — extend the services check: a unit in `auto-restart` substate is "active" but never actually stays up, so it hides behind a green status; flagged **high** with its `NRestarts` count.

### Fixed

- **AppImage runtime mounts no longer report as full disks.** FUSE mounts at `/tmp/.mount_*` (device `*.AppImage`) always read 100% because they are fixed-size images, not filling disks — same false-positive class as the excluded squashfs layers. Skipped by mount shape in the disk *and* inode checks.

## [0.4.0] - 2026-08-28

### Added

- **`--md <path>` — share-ready Markdown export.** One flag writes a
  paste-ready Markdown report (START HERE, severity sections with stable
  codes, evidence, fixes, since-last-run diff) with the same `scrub()` used
  by support bundles applied to every text field — IPs, home paths, and UIDs
  are redacted before the file is written, so it is safe to post in public
  forums or issues. Exit codes match the normal report.
- **`--install-timer` / `--uninstall-timer` — one-command scheduling.**
  Writes user-level systemd units (no sudo) under `~/.config/systemd/user/`
  with resolved absolute paths (survives npm relocation), enables the timer,
  and attaches `--notify` — the machine only speaks when something NEW
  appears. Idempotent install, forgiving uninstall, honest exit 2 when
  systemd is not running. Management commands never run checks.

### Changed

- **`pkgInstall()` no longer guesses `dnf` on unknown distributions.** Void
  and Gentoo now get correct native commands (`xbps-install -Sy`, `emerge`);
  any other unrecognized distro gets an honest manual-step line instead of a
  wrong `sudo dnf install` (e.g. on NixOS).

## [0.3.5] - 2026-08-27

> **Highlights:** 6 new health checks, stronger fleet/AI privacy, safer `--fix`, and a more robust dashboard. No breaking changes.

### Security

- **Fleet reporting now blocks plaintext HTTP for authenticated pushes.** When `FLEET_API_KEY` is set, `--push` and `--alert` require `https://` (loopback `http://127.0.0.1`, `localhost`, `[::1]` exempt for local dev). The check runs at CLI validation and again before `pushReport`/`sendAlert`; a misconfigured `http://` endpoint now fails fast with exit 2 instead of leaking the Bearer token. Includes tests in `fleet.test.js` and `alert.test.js`.
- **AI summaries redact sensitive data before egress.** Finding titles and details are now scrubbed with the same `scrub()` used for support bundles — IPv4/IPv6 literals and `/home/<user>` paths never reach the LLM endpoint. Verified by `llm.test.js`.

### Added

- **6 new checks + 1 Flatpak extension (44 checks / 145 codes total):**
  - `inodes` — inode exhaustion (`df -i`): the classic "No space left on device" when `df -h` still shows free space. Tunable `inodeFullPct` / `inodeWarnPct` (90/80).
  - `orphans` — orphaned packages: `pacman -Qtdq`, `apt autoremove --dry-run`, `dnf repoquery --unneeded` / `zypper packages --unneeded`.
  - `boot` — boot partition health: space on `/boot` and `/boot/efi` plus missing `grub.cfg` / `systemd-boot` entry.
  - `cache` — user cache and trash bloat: `~/.cache` and `~/.local/share/Trash` (5/10 GB thresholds, desktop/laptop).
  - `wifi` — WiFi state: rfkill soft/hard block, `nmcli radio wifi`, adapter presence (`wifi/blocked`, `wifi/disabled`, `wifi/no-adapter`, `wifi/ok`).
  - `packages` — package-manager health: `dpkg --audit`, `apt-get check`, `dnf check`, `pacman -Dk` (`packages/broken`, `packages/locked`, `packages/ok`).
  - `flatpak/unused-runtimes` — `flatpak uninstall --unused --dry-run` for stale SDKs.
- **Documentation:** `docs/checks.md` — auto-generated catalog of all 44 checks and 145 codes (`scripts/generate-check-docs.mjs`).
- **Man page:** `packaging/linux-doctor.1` now documents every flag, including `--history-json`, `--thresholds-set`, `--alert`, `--daemon`, and `--interval`.
- **Thresholds:** `inodeFullPct` / `inodeWarnPct` documented in `docs/configuration.md` and `DEFAULT_THRESHOLDS`.

### Changed

- **Safer `--fix` catalog — no more accidental SSH drops.** `network/no-route` (interface down/up cycle) is now `manual` tier — it would have killed the SSH session running `--fix --yes`. On Debian, `security/no-firewall` now runs `sudo ufw allow OpenSSH` *before* `sudo ufw --force enable` (plus `--force` to avoid the interactive y/n hang; existing sessions survive via conntrack).
- **Threshold validation is now strict.** `loadThresholds` and both `POST /api/thresholds` handlers drop non-numeric values (`"90%"` → ignored, keeps default) instead of storing `NaN` and breaking comparisons.
- **Scrubbing now covers compressed IPv6.** `scrub()` also redacts `::1` and `fe80::` without breaking `12:34:56` timestamps (guarded by `::` / `[A-Fa-f]`). Used by both support bundles and `--ai`.

### Fixed

- **Processes: header row no longer shifts the top-3.** `ps -o rss` leaves a `RSS` header even with `args=`; the parser now filters it explicitly. `processes/ok` correctly shows the real top consumers.

## [0.3.4] - 2026-08-26

### Security

- **Desktop: harden the loopback report API against cross-origin access**: the
  shell's report server answered every request with
  `Access-Control-Allow-Origin: *`, so while the app was running any website
  open in the user's browser could read the full system report from
  `http://127.0.0.1:17321/` and POST to the config-writing endpoints
  (`/thresholds`, `/api/ignore`). It now applies the same rules as the CLI
  dashboard server (`src/web.js`): loopback `Host` headers only (anti
  DNS-rebinding), writes accepted only without an `Origin` header or from our
  own origins (`tauri://localhost`, loopback), and the CORS wildcard replaced
  by a strict origin echo — public sites can no longer read the report.
  Covered by new unit tests on the guard helpers.
- **Tauri CSP**: `tauri.conf.json` `csp: null` → strict `default-src 'self' ipc: http://ipc.localhost; script-src 'self' 'unsafe-inline'; ...` — no wildcard.

### Added

- **Release: all distros** — `release.yml` now builds `AppImage + deb + rpm + tgz` (was `appimage,deb` only) so one tag covers Debian/Ubuntu (deb), Fedora/RHEL/Bazzite (rpm), and every glibc distro (AppImage) plus `npm` (tgz).
- **Docs: dashboard screenshots** — `docs/screenshots/dashboard-light.png` + `dark.png` regenerated for the fast compact UI (`codepill` + `durpill`, `Export ▾` dropdown, `186K/191K`) via Playwright on the live `0.3.4` dashboard.
- **Expanded safe-fix catalog (22 codes)**: `containerdisk/high|warn` (prune), `security/no-firewall` (family-aware), `firmware/pending`, `locales/broken`, `disk/full`, `suspend/failed`, plus `network/no-route|dns|dns-slow`, `ssh/root-login|root-password`, `bluetooth/failed|stopped`, `ntp/pending|unsynced`, `thermal/*`, `hardware/mce|ecc`, `security/autologin`, `backup/none`. All pinned by `fix-catalog.test.js`.
- **`--history-clear`**: clear stored run history (`src/history.js` `clearHistory()`), with completions and `--help` entry.
- **Dashboard: fast compact UI for technical users** — compact density by default, `codepill` on every card (click to copy, `code:` filter in search with 60ms debounce), `durpill` per check (from `durations` now always in `/api/report`), `Export ▾` dropdown, `skel-hero` skeletons, header blur, gauge 84px, card tint. `432 tests` still pass.
- **Man page 0.3.4**: `packaging/linux-doctor.1` now documents every flag (`--fix`, `--interactive`, `--notify`, `--support`, `--no-history`, `--history-clear`, etc.).
- **CI: Rust tests**: `ci.yml` now runs `cargo test` in `src-tauri` with webkit deps.

### Changed

- **Thresholds**: `dnsSlowMs` (500ms) now configurable via `config.json` and documented in `docs/configuration.md`; `containerWarnGB/HighGB` documented.
- **Tauri Node fallback**: `src-tauri/src/lib.rs` `node_bin()` now tries `LINUX_DOCTOR_NODE`, `runtime/node|nodejs`, `node` then `nodejs` on PATH, with `which()` helper and detailed error (suggests `LINUX_DOCTOR_NODE=nodejs` on Debian).

### Fixed

- **Completions drift**: `completions/*.bash|zsh|fish` now include `--history-clear` (caught by `completions.test.js`).
- **Web test**: `web.test.js` still matches `Re-run checks` after header refresh.

## [0.3.3] - 2026-08-26

### Fixed

- **Desktop (AppImage): EGL launch aborts on bleeding-edge Mesa**: the shell
  now defaults to software GL (`LIBGL_ALWAYS_SOFTWARE=1`) when running from
  an AppImage, set before any GTK/WebKit initialization. The bundled
  WebKitGTK's accelerated paths could abort at window creation against very
  new host Mesa — on AMD and Intel alike, since both run on Mesa (NVIDIA's
  proprietary driver ships its own stack). A diagnostics dashboard does not
  need GPU acceleration; opt out with `LINUX_DOCTOR_HARDWARE_GL=1`. The
  `.deb` and CLI are unaffected — they use the host's matching WebKitGTK.
  This retires the manual `LIBGL_ALWAYS_SOFTWARE=1` workaround documented
  for v0.3.2.

### Changed

- **Dashboard: first-run history explainer**: with fewer than two recorded
  runs, the History section no longer vanishes silently — it shows what the
  one run on record scored and what will appear there after the next check
  (static `--html` exports keep the section hidden, as before).
- **Dashboard: motion and number polish**: JS smooth-scrolls (sidebar jump,
  checks-matrix jump, START HERE jump, history diff) now honor
  `prefers-reduced-motion`; live numbers (NEW/FIXED badges, score delta,
  trend title) use tabular figures so they stop jittering as counts change;
  the gauge ring eases between severity colors instead of snapping; the hero
  delta on a first run reads "no baseline yet" instead of "no history to
  compare".
- **Dashboard: the subtraction pass**: removed the ornamental CSS layer
  (decorative gradients, noise texture, glassmorphism, glowing gauge, stagger
  card animations, hover lift) and consolidated everything into one calm
  layer. Findings render as a single readable column with neutral info rows;
  the healthy state gets a visually lighter card with a green hairline;
  spacing follows a strict rhythm (header 40 / status 36 / toolbar 28 /
  history 56); font stacks are honest system fonts. No libraries, no new
  features; the parity vocabulary is untouched.
- **JSON schema documents the whole payload (Phase 5)**: `--schema` now
  covers every field the runtime emits — `nextAction`, `cleanStreak`,
  `scoreDelta`, `previousScore`, `lastRunAt`, top-level `unchanged`,
  `scoreBreakdown`, `durations` (`--profile`), and `system.osRelease`.
  schemaVersion stays **1**: the documented policy is that additive optional
  fields never bump the version; incompatible changes do. Consumers should
  ignore unknown properties.
- **Open-core split (Pro is no longer in this repository)**: the five premium
  checks, all key-signing crypto, and `--license-gen` have moved to the
  separate proprietary package `@linux-doctor/pro`, distributed only through
  private channels (GitHub Packages buyer tokens or signed downloads). The
  free edition now discovers an installed Pro module automatically
  (`@linux-doctor/pro`, or `LINUX_DOCTOR_PRO_MODULE=/path/index.mjs` for
  air-gapped machines) and injects its core primitives via
  `init(core) → { checks, licensing }`. Consequences:
  - Pro is genuinely unavailable for free — no public secret, no self-minted
    keys; a key string alone unlocks nothing.
  - The free repo carries zero licensing code; a new guard test
    (`tests/open-core.test.js`) fails the build if any of it ever reappears,
    and pins the loader contract with a fixture module.
  - Without the add-on, behavior is identical whether or not a key string is
    configured ("Linux Doctor Pro: not installed").

### Added

- **Output drift guard (Phase 5)**: `tests/output-drift.test.js` runs the real
  binary and asserts every emitted key — top level and in the nested
  `system` / `diffSinceLast` / finding / scoreBreakdown objects — is
  documented in `src/schema.js`. A new payload field without a schema entry
  now fails CI instead of surprising scripts and fleet consumers.
- **Golden output snapshots (Phase 5)**: the four states from the parity
  matrix (mixed / healthy-streak / info-only / first-run) are snapshotted for
  pretty, `--plain`, and `--json` in `tests/golden/snapshots/` and compared
  byte-for-byte. Regeneration is controlled (`npm run goldens:update`) so any
  wording or ordering change shows up as a reviewable diff.
- **Score breakdown everywhere (Phase 5)**: the health score's arithmetic is
  now auditable — `scoreBreakdown` travels in `--json`, the terminal report
  prints one compact line under STATUS (`SCORE 77/100 = 100 −15 disk/full …`),
  and `--plain` carries `# score-breakdown:`. The score is derived from the
  breakdown by construction (`100 − Σpenalty === score`, pinned by tests).
- **Fix catalog ↔ registry pin (Phase 5)**: every safe-fix catalog code must
  exist in the finding-code registry, and each entry must still produce a
  plan for its own finding shape — a typo'd catalog key fails at test time.
- **Output parity contract (Faza 4)**: [docs/output-parity.md](docs/output-parity.md)
  documents the one-message-four-channels rule (CLI / `--plain` / `--json` /
  dashboard) with a per-state verification matrix. The vocabulary is pinned
  by tests that grep both the CLI output and the dashboard HTML; a new test
  guarantees `nextAction` in `--json` always matches the report's ▶ START
  HERE line.
- **`nextAction` in the JSON payload**: the ▶ START HERE pick now travels as
  data (`{code, severity, title, fix}`), and the dashboard renders it
  directly instead of recomputing — banner and report can never disagree
  (older payloads keep the client-side fallback).
- **"Failed checks" in the dashboard**: checks that threw are now visible in
  the GUI with the same wording as the CLI, so a partially-broken run is
  never silently rendered as a clean one.
- **Ignore management from the CLI (Faza 3)**: `--ignore-add <value>` /
  `--ignore-remove <value>` write the same config keys as the dashboard's
  Ignore button. Code-shaped values (`check/reason`) land in the
  exact-match code list; anything else is a title fragment. Both commands
  print the resulting list using the same format as `--ignore-list` (one
  vocabulary everywhere).
- **Healthy-state streak**: when a machine is clean, the report says so with
  momentum — "✅ Everything is clean — N clean run(s) in a row" — computed
  from history and exposed to the dashboard via `cleanStreak` in the JSON
  payload. Info-only systems read "No high or medium issues — N
  informational notes below" instead of pretending there is nothing.
- **Support bundle hardening**: `diffSinceLast` titles now go through the
  same redaction (IPs, home paths) as finding text.

### Changed

- **History v2 (Faza 2 — history as the core)**:
  - The file wrapper now carries `version: 2` (v1 files still read fine).
    Every saved finding is guaranteed to have its stable `code`; diffing
    among coded entries is code-only, so rewritten titles can no longer
    churn NEW/FIXED markers.
  - **Repair-on-read**: a partially corrupted history keeps its well-formed
    runs and drops only the broken entries (and broken finding rows inside
    them); a truncated file degrades to "no history" instead of failing.
  - **Upgrade bridge**: v1 entries stored without codes are matched by
    title for their remaining lifetime in the window, so upgrading never
    reads as everything-new-plus-everything-fixed at once. Reworded issues
    surface exactly once during the transition, then identity is permanent.
  - New `tests/output-parity.test.js` pins the one-computation contract:
    CLI text, `--plain` and `--json` (and therefore the dashboard) must
    render identical new/fixed/unchanged numbers from the same diff object,
    and the score stays severity-driven regardless of history content.
- **Severity rubric enforced (Faza 1 — findings trust)**: new
  [docs/severity.md](docs/severity.md) defines when a finding is high /
  medium / info, and `tests/codes-registry.test.js` pins every built-in code
  to its allowed severity set + category. Four findings were realigned with
  the rubric — degradation without data risk is **medium**, not high:
  `gpu/software-rendering`, `wayland/software-rendering`,
  `gpu/nvidia-missing`, `processes/high`. Machines that scored on these will
  see their health score improve; history keeps working (scores are
  recomputed per run).
- **Code discipline is mechanical**: every builtin `code:` must be a string
  literal (`^[a-z0-9-]+/[a-z0-9-]+$`, ternaries of literals allowed), titles
  carry no trailing period and stay short, and `evidence: null` is only
  allowed on the reviewed data-absence list (`battery/none`, `gpu/skipped`,
  `updates/skipped`). The slug-derived fallback code now exists solely as a
  plugin escape hatch.
- **Health score escalation**: penalties now compound within a severity tier —
  the n-th high-severity finding costs 15 + 5·(n−1), and medium findings past
  the third cost +1 each. Previously 4 high (score 40) and 7 medium (44)
  scored almost identically; now they land at 10 vs 34, so critical issues
  stand clearly apart from a pile of minor ones. Low counts are unchanged
  (one high is still 85, one medium still 92).
- **`--push` / `--alert` URL validation**: mistyped endpoints (missing
  `https://`, wrong scheme, no host) now fail fast with a clear message and
  exit 2, before any checks run — instead of a generic fetch error after a
  full run or mid-daemon-cycle.
- **Consistent repository URLs**: every reference to the old
  `linux-doctor-cli` repo name (package.json, PKGBUILD, RPM spec, report
  footer, GUI "Report wrong" link, commercial license) now points to
  `zShaD0w7x/linux-doctor`.
- **Distro-specific fixes**: `pkgInstall()` accepts per-distro package-name
  maps, and the `memory`, `network` and `smart` checks now emit the install
  command for the detected distro instead of enumerating alternatives.

### Added

- **Safe fixes (`--fix`)**: a dry-run plan of concrete commands for the
  findings on the system, built from a small built-in catalog (`src/fix.js`)
  mapped to stable finding codes — failed services, broken timers, pending
  updates (per package family, `rpm-ostree` on image-based systems), flatpak,
  snap, disabled fstrim, oversized journal. `--fix --yes` executes only the
  `[apply]` commands after a second opt-in; `[manual]` entries (e.g. reboot)
  are never executed.
- **Interactive mode (`--interactive`)**: zero-dependency terminal UI over the
  report — arrow keys pick a finding, Enter opens details/evidence, `c` copies
  the fix (wl-copy/xclip/pbcopy with OSC 52 fallback), `f` copies the safe-fix
  command. Falls back to the printed report without a TTY.
- **Desktop notifications (`--notify`)**: native `notify-send` notification
  when new medium/high findings appear; also honored by `--daemon`.
- **Score trend in the terminal**: a `TREND` sparkline (`▄▅▆▇`) of recent runs
  (capped to 20) in both the full report and `--plain` (`# trend:` comment).
- **▶ START HERE**: the report now calls out the single most useful next
  action between the summary and the findings. The web dashboard and static
  HTML export get the same banner with Copy-fix / Show buttons.
- **Category clustering**: findings are grouped by their check's category
  within each severity section, each numbered line carrying a `[category]`
  tag.
- **Shell-injection guardrail test**: a static test (`tests/shell-safety.test.js`)
  fails the suite if any command template interpolates a value without `shq()`,
  so the existing quoting discipline is enforced mechanically.
- **`npx github:zShaD0w7x/linux-doctor`**: documented zero-install trial path
  (the corrected repo URLs make it work).
- **Checks**: `fstrim` (SSD TRIM health — weekly `fstrim.timer`, continuous
  `discard` mounting, or a medium finding when SSDs are never trimmed).

### Changed

- **Security hardening** (web dashboard): non-loopback `Host` headers are
  rejected (DNS rebinding) and cross-origin POSTs to config-writing endpoints
  are rejected (CSRF).
- **Static HTML reports** embed data as `window.__DATA__` instead of
  monkey-patching `window.fetch`; save buttons now fail honestly in static files.
- **Shell safety**: every value interpolated into a spawned command is
  single-quoted (`shq`) so crafted names cannot break out of their argument.

### Fixed

- **TREND no longer lags a run behind**: the sparkline now ends at the
  current run's score (previously it showed only stored runs, so a fresh
  recovery read as a continuing decline). The window still caps at 20
  points, current run included. Pinned by `output-parity.test.js`.
- **Score delta is visible in the terminal report**: the pretty STATUS line
  now carries the same "(+N)" convention as `--plain`
  (`health 76/100 (+9)`), so recovery reads identically in every channel.
- **Dashboard Auto-refresh paused state is visible**: the button previously
  kept its active styling while paused; it now renders amber/dimmed.

## [0.3.2] - 2026-08-25

### Added

- **Desktop: complete loopback API**: the shell's report server now answers
  `/checks` (check → category map: category grouping and the checks matrix
  work in the installed app), `/history` (score trend section), and
  `GET/POST /thresholds` plus `POST /api/ignore` (thresholds panel and the
  per-finding Ignore button persist). Backed by three new hidden CLI flags
  (`--history-json`, `--thresholds-json`, `--thresholds-set`) so the Rust
  shell keeps delegating all logic to Node.

### Fixed

- **Desktop (AppImage): empty report**: the AppRun environment pointed
  `LD_LIBRARY_PATH` at the bundled libraries, which made the host's `node`
  abort with a symbol/version error — `/report` came back with an empty
  body. The shell now strips `LD_LIBRARY_PATH`/`LD_PRELOAD` from every Node
  child process.

## [0.3.0] - 2026-08-18

### Added

- **Checks**: `containerdisk` (container image storage via podman/docker),
  `crash` (reboot frequency + coredumps via journalctl and coredumpctl).
- **Shell completions**: bash, zsh, and fish completions in `completions/`.
- **Systemd timer**: `linux-doctor.timer` + `.service` for automated daily
  checks (see [packaging/](packaging/)).
- **HTML export**: `--html <path>` saves a standalone HTML report you can
  open in any browser or share on Slack.
- **`--summary`**: one-liner output with score + severity counts, designed
  for cron jobs and shell prompts (`score=72 high=1 medium=3 info=12`).
- **`--init-config`**: creates a starter config file at
  `~/.config/linux-doctor/config.json` with commented thresholds and
  examples — no more guessing what keys exist.
- **`--check-list`**: prints check metadata as JSON (id, title, category,
  appliesTo, appliesHere) — useful for dashboards and fleet tooling.
- **`--compare <file>`**: diffs a previous JSON report against the current
  run, showing new and fixed findings side by side.
- **DNS speed check**: the `network` check now times DNS resolution; slow
  resolvers (>500ms) are flagged as medium severity.
- **Man page**: `linux-doctor(1)` with full option docs, exit codes, and
  file locations (see `packaging/linux-doctor.1`).
- **`--severity <level>`**: filter output to show only high, medium, or info
  findings (scoring and fleet push always use the full set).
- **`--ignore-code <code>`**: ignore findings by stable code (e.g.
  `services/failed`) instead of fragile title substrings; works alongside
  `--ignore` and the config file's `ignoreCodes` array.
- **`--ignore-list`**: shows all configured ignore patterns (title + code)
  and exits.
- **Terminal colors**: severity headers are now ANSI-colored (red/yellow/blue)
  when stdout is a TTY.
- **NEW badge**: findings new since the last check now show `🆕 NEW` instead
  of the subtle `(new)` marker.
- Dashboard: a **Report wrong** button on every finding opens a pre-filled
  GitHub issue (title, code, check, version) — the false-positive feedback
  loop.
- CI: a **real-run** job executes the full `--json` report on a live ubuntu
  runner and asserts valid JSON with zero `checkErrors`; the Fedora container
  job runs the same smoke test against its real `/proc` and `/sys`.
- Journal findings are flagged `low` confidence (heuristic log matching may
  produce false positives).

#### History, support bundle, atomic awareness, dashboard trend

- **History is now central**: every run is diffed against the previous one and
  reports `newCount` / `fixedCount` / `unchanged` plus a plain-language
  `changeMessage` ("Since last run: 2 new, 1 fixed", or "no change since last
  check"). `--summary` and the JSON report carry these; `--no-history` (or
  `LINUX_DOCTOR_NO_HISTORY`) disables history recording for a one-off run.
- **`--support`**: writes a single, privacy-scrubbed support bundle
  (`linux-doctor-support-<timestamp>.json`) with system facts, the active
  config, recent findings, and a capped copy of history. IP addresses and
  `/home/<user>` paths are redacted; the bundle documents exactly what it
  excludes under `privacy.excluded`.
- **Immutable / atomic distro awareness**: `system.atomic` reports
  `immutable`, `imageBased`, `bootc`, `variant`, and `pkg`. Checks that do not
  apply to image-based systems (e.g. `reboot`) are skipped and listed in
  `skippedChecks` / `checksAtomicSkipped` (and surfaced in the dashboard's
  Skipped section) instead of producing misleading findings.
- **Dashboard trend graphs**: the history view now draws the health-score
  sparkline (with date tooltips and a dashed 50-point attention line) plus a
  new stacked-bar chart of high/medium/info findings across recent runs.

### Changed

- **Repositioned messaging around the core promise** — finds real problems, explains them in plain English, and remembers what changed between runs. The README now leads with that promise (not a feature list); the terminal report and `--summary` lead with `STATUS` and a `SINCE LAST RUN` change line (new/fixed/unchanged); the `--plain` report gains a `# since:` line; and the dashboard hero surfaces "Since last run" next to the health score. No feature/behavior change to the checks themselves.
- **Stable finding codes**: every count-bearing finding (services, journal,
  updates, flatpak, firmware, timers, disk, memory, network, ntp, audio,
  thermal, smart, journald) now carries an explicit stable `code`, and the
  history diff matches findings by code (falling back to title for older
  history). "New/fixed since last check" no longer churns when a count in a
  title changes between runs.
- **Explicit skips**: checks that cannot run because a tool is missing
  (`free`, `journalctl`, `smartctl`, `timedatectl`, `ip`, `pactl`, a package
  manager, thermal zones) now report an informational "check skipped"
  finding instead of silently returning "all clear".
- **Dedupe**: disk findings share one `dedupeKey` per backing device, so
  btrfs/ZFS subvolumes of the same pool are scored once; the journal check
  defers unit-failure lines to the services check (one problem, one finding).

### Fixed

- Packaging: the PKGBUILD and RPM spec now build from the real `npm pack`
  tarball layout (`package/`), which previously failed at `%setup`/`cp` time;
  `diffSinceLast` entries expose the stable `code` in the v1 JSON schema.
- **NEW badge** printed the literal template string `${A.bold}` instead of the
  ANSI code it was meant to reference — the badge now renders as actual colored
  output.
- **Thermal** check matched any log line containing "throttl" — e.g. Roblox's
  `setStartupThrottle` — and falsely reported CPU throttling. The pattern now
  requires `clock throttl` and a kernel-tagged log source.
- **Journal** check escalated thousands of benign but unrecognized error-level
  entries into a medium "noteworthy errors" finding. Noise patterns now cover
  X.509 certs, ELF architecture, i2c address, rpm-ostree metadata, and
  libseccomp lines; unrecognized entries are informational, never medium.
- **GPU** check reported a kernel-built-in driver (absent from `lsmod`) as
  "driver not loaded" even with a working display — a built-in driver plus a
  working display is now fine.
- **Updates** check could print "System is up to date" when `apt` actually
  failed (dpkg lock, `E:` errors). Apt failures now stay silent instead of
  pretending the system is clean.
- **Severity**: missing optional hardening — no LUKS encryption, Secure Boot
  off, no TPM, no firewall, no backup tool/schedule — is informational, not
  medium. A healthy default install is no longer penalized in the health score.

## [0.2.0] - 2026-08-18

### Added

- **Checks**: `network` (default route + DNS), `reboot` (newer kernel installed
  but not booted, `/var/run/reboot-required`), `journald` (journal disk usage),
  `smart` (SMART disk health, graceful without root), `timers` (enabled systemd
  timers that never run), `ntp` (time synchronization), battery capacity wear.
- **JSON v1 schema**: `schemaVersion`, `tool`, `version`, `durationMs`;
  every finding carries `check` and a stable `code`; `--schema` prints the
  JSON Schema document for validators and fleet servers.
- **History diff**: atomic history writes; `diffSinceLast` (`added`/`fixed`)
  in JSON and a "fixed since last check" line in the terminal and `--plain`
  output.
- **Check metadata**: `defineCheck` with `category` and `appliesTo`
  (desktop/laptop/server); `--list` and `--help` group checks by category and
  mark checks that do not apply to the current machine; a full run skips
  irrelevant checks (`--check` always overrides).
- **Plugins**: drop-in checks in `~/.config/linux-doctor/checks/`
  (`LINUX_DOCTOR_PLUGINS` to override) — any `.js` file exporting
  `{ id, run }` becomes a check.
- **Configurable thresholds**: `"thresholds"` in `config.json` tunes every
  severity boundary (disk %, memory ratio, load, temperature, RAM share,
  journal size).
- **Performance**: checks run through a concurrency pool (bounded
  subprocesses); `--profile` reports per-check durations.
- **CLI hygiene**: strict argument parsing (unknown flags and missing values
  exit 2), `--check=id` form, `--push` payload now carries `machineId` and
  `diffSinceLast`.
- **Packaging**: AUR `PKGBUILD`, RPM spec, release workflow, this changelog.
- **CI**: Node 20/22/24 matrix, a Fedora container job, and an npm pack gate
  that guards the published `files` list.

### Fixed

- npm package crashed on every invocation: `src-gui/index.html` (read by
  `web.js` at import time) is now in `files`.
- Same root cause reported twice (journal+suspend, gpu+wayland) and double
  penalized in the health score — now deduplicated via `dedupeKey` and
  deferred patterns.
- `ps -o comm` truncated process names (15 chars) so the friendly-name map
  never matched — now uses `args=`.
- `journalctl` boot separators inflated log checks — filtered in one place.
- `addIgnore` used to overwrite other config keys (e.g. thresholds) — it
  merges now.
- Wireless-device "batteries" (Logitech receivers, controllers) no longer
  report as laptop batteries or mark a desktop as a laptop.
- `systemd list-timers` column parsing was fragile — now slices by the
  header's column offsets.
- `tests/web.test.js` flaked (server banner corrupted the TAP stream) —
  `startWeb` gained a `quiet` option used by tests.

[Unreleased]: https://github.com/zShaD0w7x/linux-doctor/compare/v0.7.1...HEAD
[0.7.1]: https://github.com/zShaD0w7x/linux-doctor/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/zShaD0w7x/linux-doctor/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/zShaD0w7x/linux-doctor/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/zShaD0w7x/linux-doctor/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/zShaD0w7x/linux-doctor/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/zShaD0w7x/linux-doctor/compare/v0.3.5...v0.4.0
