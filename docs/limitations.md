# Limitations, and what it got wrong

Two lists, because both matter when you decide how much to trust a
diagnostic: what it does not do, and what it got wrong (in both directions)
and now has a test for.

## What it does not do

- **Not monitoring.** No metrics, no alerting, no background agent unless you
  run the Pro one. It answers "what is wrong right now", not "how is it
  trending".
- **Not a security audit.** It checks a handful of exposure basics (firewall,
  root SSH, SELinux/AppArmor state). It is not Lynis or OpenSCAP, and it does
  not pretend to be.
- **Not a hardware inventory.** No `inxi`-style report of every controller and
  revision.
- **It does not run the fixes it prints.** The `fix` line is advice. `--fix` is
  a dry run, `--fix --yes` executes only the catalogued `[apply]` tier, and
  `[manual]` commands are never executed at all.
- **It does not clean or optimise.** No cache deletion, no "speed up your PC".
  Those tools have a reason to find dirt; this one should not.
- **Linux only.** No macOS, no Windows.
- **Inside a container it reports the container's world, not the host's.**
  Some kernel interfaces are not namespaced — `/proc/loadavg`, `/proc/meminfo`,
  `/proc/swaps`, and the block devices `lsblk` reports — so a check reading them
  would report the host's state as the container's. Those checks now detect the
  container and say why they are skipping (`load`, `memory`, `zram`, `fstrim`,
  `reboot`). systemd is usually absent too, so systemd-based checks report a
  skip or nothing. That is a limitation of the environment, not a verdict about
  the host.
- **Some checks degrade instead of guessing.** A check that needs root says
  `skipped (needs root)` rather than claiming a clean result (the `apt` health
  check does this), and a check whose tool is missing stays silent or reports a
  skip.

## What it got wrong, and how it is guarded now

All of these were reported by users, caught by CI, or found by auditing every
check against real input, and each one now has a regression test. Listed
oldest first within each table.

### False positives (a problem reported where there is none)

| What you saw | Why the check was wrong | What guards it now |
|---|---|---|
| `fs/btrfs-errors` on a system with no btrfs filesystem ([#13](https://github.com/zShaD0w7x/linux-doctor/issues/13)) | the dmesg pattern matched the bare word `BTRFS`, which the kernel prints at boot as a module load banner on every build with btrfs compiled in | the pattern requires a real event, the banner is rejected explicitly, and `BTRFS critical` / `failed` / `corrupt` still match |
| `hardware/ecc` on a machine with no ECC memory | the check matched the EDAC driver's own init lines, including `EDAC ie31200: No ECC support`. It was the top item in the report and cost 9 points | classification requires an actual CE/UE event or an `error` token, and routine init lines are rejected |
| `hardware/mce` reporting a machine check exception on healthy hardware | `mce: CPU supports N MCE banks` is printed once per CPU at boot on every Intel machine, and a bare `mce` match read it as an exception | same classifier: routine boot lines are rejected, `[Hardware Error]` lines are not |
| `packages/broken` when run without root ([#14](https://github.com/zShaD0w7x/linux-doctor/issues/14)) | `apt-get check` cannot take the dpkg frontend lock unprivileged, and its refusal was folded into the same string and matched as broken dependencies. The report also contradicted itself, claiming 0 updates in the same output | the lock refusal is dropped, the check requires a real dependency diagnostic, and the healthy finding says `skipped (needs root)` instead |
| `packages/broken` on a clean Arch system ([#19](https://github.com/zShaD0w7x/linux-doctor/pull/19)) | `pacman -Dk` prints "No database errors have been found!", and a bare `error` match caught the word "errors" in that sentence | the success line is dropped and the predicate requires a real diagnostic |
| `packages/locked` accusing the tool itself, only when run as root ([#24](https://github.com/zShaD0w7x/linux-doctor/issues/24)) | the lock probe ran beside linux-doctor's own `apt-get check` (and the `updates` / `orphans` probes), so `fuser` found linux-doctor holding the lock and the user was told to wait for, or kill, a process that was the tool | holders inside linux-doctor's own process group are ignored, and the evidence lists PIDs only |
| `updates` reporting roughly double the real number on dnf | `dnf check-update` prints a header, indented obsoletion lines and one entry per enabled repo, so 314 pending updates read as 630 | unique package names are counted |
| `journal` reporting thousands of "unrecognized entries" after a few crashes | a multi-line entry (a crash plus its stack trace) was counted once per continuation line | only timestamped head lines count as entries |
| `security/autologin` on a machine with autologin disabled | the commented `# AutomaticLoginEnable=true` example that several distros ship was read as config, and an explicit `false` or a bare `[Autologin]` header counted too | comments are ignored, GDM needs an actual true value, and SDDM needs a `User=` line inside the section |
| a full root filesystem reported as a full `/boot` | `df -P /boot` prints the root row when `/boot` is a directory on `/` and the columns are identical, so a 95%-full root was filed against `/boot` | a row is only used when its mount point is the one requested |
| `crash` reporting a kernel panic on machines that reboot often | the Intel machine-check boot banner (`Intel machine check reporting enabled on CPU#N`) was read as a panic | it defers to the same classifier as `hardware/mce`, which rejects routine init lines |
| `load`, `memory`, `zram`, `fstrim` reporting the HOST's load, memory, swap and disks inside a container | those kernel interfaces are not namespaced, so a 256MB-limited container's `free -b` reported the host's 15GB and the check read the host's state as the container's | each probes for a container and reports `*/skipped` instead |
| `network/no-route` on a machine that has a route | minimal Debian, Fedora and Ubuntu images do not ship `ip` (iproute2), and the probe's failure was read as an empty route table | the presence of `ip` is probed first; a missing `ip` is a skip with the install hint, never "no route" |
| `updates` "System is up to date" on Tumbleweed with updates waiting | the count piped through `awk`, which the minimal image does not ship, so the pipeline produced nothing | the raw output is parsed in JS, with no `awk`/`wc` dependency |
| `hardware` staying silent on a healthy machine instead of "No hardware errors logged" | the readability gate was the exit status of `journalctl … \| grep …`, and grep exits 1 when nothing matches, so the status meant "found something", not "could read the log" | the log's readability is probed separately from its content |
| `timers` calling a timer broken that can never run | an enabled timer whose start condition is unmet by design (`dnf-makecache.timer` on an immutable system) was read as a broken schedule | it consults `ConditionResult` and does not flag unmet-condition timers |
| a KDE lock screen inflating the error count | `kscreenlocker_greet` logs `Authentication attempt too soon` when you retype a wrong password quickly, and each one was counted as an error | only the screen locker's copy is noise; the same string from `sshd` still counts |
| `processes` warning for a large app on a machine with plenty of free RAM | it compared the app against total RAM, ignoring what was available, so a browser at ~19% of a 15GB machine with 9.4GB free was filed medium | the warning requires the system to be short on memory (available below the memory warn ratio) |
| `processes` listing the same app several times, at the size of one process | a browser spreads its memory across many processes that share one binary, so it appeared once per process and the largest was reported as the app | RSS is summed per binary; the app appears once, with its total |
| `backup` "tools installed, but nothing is scheduled" on a non-systemd system | the timer list was empty because `systemctl` is absent, not because the backup is unscheduled | it checks the timer tool is present and reports `backup/unknown` instead |
| `reboot` "No reboot needed" in a container | a container has no kernels of its own, so the empty `/boot` list read as "the running kernel is the newest" | it skips in a container, and stays silent when no kernel list can be read |

Three more that were fixed before anyone reported them: the webview could come
up blank where WebKit's DMA-BUF renderer fails, `updates` could claim "up to
date" when the package manager was actually locked, and an uncorrected memory
error (an EDAC `UE` line) was filed at medium as if it had been corrected — it
is high now, with its own wording.

### False negatives (a real problem the check missed)

| What you did not see | Why the check was blind | What guards it now |
|---|---|---|
| `security/autologin` said nothing on Debian, Ubuntu and Mint | the probe listed `/etc/gdm` (the Red Hat, openSUSE and Fedora layout) but not `/etc/gdm3`, which the Debian family uses, so an enabled autologin read as no autologin | both layouts are searched, which is only safe because the comment filter above drops the commented examples Debian ships |
| `flatpak` said "apps are up to date" with updates pending | the default `remote-ls --updates` output is a column table whose fields contain no `/`, and that is what the count looked for | it asks for `--columns=application,version`, with a table fallback for older flatpak |
| `raid` called a `FAULTED`, `UNAVAIL`, `REMOVED` or `SUSPENDED` ZFS pool healthy | only the word "degraded" was recognised, so anything worse fell through to the healthy branch | only `ONLINE` counts as healthy, and a running scrub is no longer called a rebuild |
| `updates` saying nothing on Alpine | `apk info -u` is not a valid command (it exits 1 with "unrecognized option 'u'"), and the empty output read as "no updates" | `apk version -l '<'` is the real command, with the header excluded so it cannot become a phantom update |
| `updates` saying nothing on Void | there was no xbps branch at all, so a machine with 54 pending updates was skipped and scored as current | `xbps-install -un` lists what would be updated, from the local index |
| `orphans` "No orphaned packages. The package database is tidy." when the query actually failed | only the dnf branch checked whether its query ran; apt and zypper piped through `grep`, so a locked apt or a failed zypper printed nothing and read as a tidy database | all four families check the query ran, and count in JS |
| `apt` "up to date" from an empty package index | a fresh image, or a machine that never ran `apt update`, answers "0 upgraded" with a zero exit status | the check notices the empty index and says it could not determine the state, instead of claiming health |
| `memory`, `processes`, `ports`, `certs` (and more) staying silent when their tool was missing | `run()` only set `missing` when the shell itself was absent, which never happens — a missing tool exits 127 — so every check that gated a "could not check" skip on `missing` stayed silent | `run()` marks exit 127 as missing, activating the skip findings, and the checks that lacked one gained an explicit skip |
| `cache` not measuring the Flatpak app caches | it looked at `~/.cache` and Trash only, so `~/.var/app/<id>/cache` was invisible — on a Flatpak-heavy distro the larger half | both are measured and counted toward the same thresholds, and the biggest offenders are named |

## How we catch these now

- A **clean-image gate** runs the engine inside Fedora, Debian, Ubuntu, Alpine
  and Arch containers and fails when a high or medium finding appears that the
  baseline does not justify.
- **Recorded fixtures** from real machines replay through the same pipeline,
  and every high/medium finding they produce needs a written reason.
- The **severity rubric and the code registry** stop a severity from drifting
  silently.
- **Every check is audited against real input**, and a wrong result is
  reproduced before it is changed: no fix lands without a regression test that
  fails first.
- See [docs/doctrine.md](doctrine.md) for the full list of what is enforced,
  and [docs/compatibility.md](compatibility.md) for what counts as a
  user-visible change.

## Found something wrong?

Please report it: a wrong finding is the most useful bug report this project
can get. Attach a [`--support`](integrations.md) bundle (privacy-scrubbed), or
record a replayable fixture from your machine with `LINUX_DOCTOR_RECORD` as
described in [CONTRIBUTING.md](../CONTRIBUTING.md).
