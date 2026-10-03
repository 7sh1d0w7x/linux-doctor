# Check catalogue

Every finding `code` is stable — use it for `--ignore-code`, history diffing, and scripting. Generated from `src/checks/index.js` + `tests/codes-registry.test.js`; do not edit by hand.

Total: **49 checks** → **174 codes**.

| Check | Category | Codes | Severity |
|---|---|---|---|
| `memory` — Memory pressure | system | `memory/low` (medium/high)<br>`memory/skipped` (info)<br>`memory/swap` (info) | desktop/laptop/server |
| `load` — CPU load | system | `load/busy` (info)<br>`load/overloaded` (medium/high)<br>`load/skipped` (info) | desktop/laptop/server |
| `disk` — Disk space | system | `disk/full` (high/medium)<br>`disk/skipped` (info) | desktop/laptop/server |
| `inodes` — Inode usage | system | `inodes/full` (high/medium)<br>`inodes/skipped` (info) | desktop/laptop/server |
| `fs` — Filesystem errors | system | `fs/btrfs-errors` (high)<br>`fs/io-errors` (high)<br>`fs/ok` (info)<br>`fs/readonly-remount` (high) | desktop/laptop/server |
| `raid` — RAID array health | storage | `raid/degraded` (high)<br>`raid/rebuilding` (medium)<br>`raid/ok` (info) | server |
| `oom` — Out-of-memory kills | system | `oom/kills` (medium/high)<br>`oom/ok` (info) | desktop/laptop/server |
| `processes` — Top memory consumers | system | `processes/high` (medium)<br>`processes/ok` (info)<br>`processes/skipped` (info)<br>`processes/warn` (medium) | desktop/laptop/server |
| `thermal` — Temperatures and throttling | system | `thermal/hot` (high)<br>`thermal/ok` (info)<br>`thermal/skipped` (info)<br>`thermal/throttle` (medium)<br>`thermal/warm` (medium) | desktop/laptop/server |
| `journald` — Journal (systemd log) size | system | `journald/large` (medium)<br>`journald/ok` (info)<br>`journald/skipped` (info) | desktop/laptop/server |
| `zram` — Swap and zram health | system | `zram/full` (medium)<br>`zram/ok` (info)<br>`zram/skipped` (info)<br>`zram/swappiness` (info) | desktop/laptop/server |
| `locales` — Locale configuration | system | `locales/broken` (medium) | desktop/laptop/server |
| `fds` — File descriptor pressure | system | `fds/exhausted` (high/medium) | server |
| `services` — Failed services | software | `services/failed` (medium/high)<br>`services/restart-loop` (high)<br>`services/skipped` (info) | desktop/laptop/server |
| `timers` — Scheduled tasks (systemd timers) | software | `timers/broken` (medium)<br>`timers/ok` (info)<br>`timers/skipped` (info) | desktop/laptop/server |
| `journal` — System log errors (last 24 hours) | software | `journal/errors` (info/medium)<br>`journal/no-noise` (info)<br>`journal/skipped` (info)<br>`journal/unknown` (info) | desktop/laptop/server |
| `suspend` — Suspend / resume | software | `suspend/failed` (medium) | desktop/laptop |
| `containers` — Container runtimes | software | `containers/docker-stopped` (medium)<br>`containers/none` (info)<br>`containers/ok` (info)<br>`containers/oom` (high)<br>`containers/dead` (medium)<br>`containers/restarting` (medium)<br>`containers/podman-failed` (medium) | desktop/laptop/server |
| `containerdisk` — Container storage | system | `containerdisk/high` (high)<br>`containerdisk/ok` (info)<br>`containerdisk/skipped` (info)<br>`containerdisk/warn` (medium) | desktop/laptop/server |
| `crash` — Crash and reboot history | system | `crash/coredumps` (high/medium)<br>`crash/panic` (high)<br>`crash/reboots` (info/medium/high)<br>`crash/skipped` (info) | desktop/laptop/server |
| `security` — Basic security posture | security | `security/autologin` (medium)<br>`security/apparmor` (info)<br>`security/auto-update` (info)<br>`security/firewall` (info)<br>`security/no-firewall` (info)<br>`security/firewall-unknown` (info)<br>`security/selinux` (info) | desktop/laptop/server |
| `secureboot` — Secure Boot and TPM | security | `secureboot/bios` (info)<br>`secureboot/disabled` (info)<br>`secureboot/enabled` (info)<br>`secureboot/no-tpm` (info)<br>`secureboot/tpm` (info) | desktop/laptop/server |
| `luks` — Disk encryption (LUKS) | security | `luks/encrypted` (info)<br>`luks/none` (info) | desktop/laptop/server |
| `ssh` — SSH server configuration | security | `ssh/ok` (info)<br>`ssh/root-login` (medium)<br>`ssh/root-password` (high) | desktop/laptop/server |
| `autologin` — Automatic login | security | — | desktop/laptop/server |
| `certs` — TLS certificate expiry | security | `certs/critical` (high)<br>`certs/expiring` (medium)<br>`certs/ok` (info)<br>`certs/skipped` (info) | server |
| `ports` — Exposed network services | security | `ports/exposed-risky` (medium)<br>`ports/ok` (info)<br>`ports/skipped` (info) | server |
| `network` — Network connectivity and DNS | network | `network/dns` (medium)<br>`network/dns-slow` (medium)<br>`network/no-route` (medium)<br>`network/ok` (info)<br>`network/skipped` (info) | desktop/laptop/server |
| `ntp` — Time synchronization | network | `ntp/ok` (info)<br>`ntp/pending` (medium)<br>`ntp/skipped` (info)<br>`ntp/unsynced` (medium) | desktop/laptop/server |
| `wifi` — WiFi | network | `wifi/blocked` (medium)<br>`wifi/disabled` (medium)<br>`wifi/no-adapter` (info)<br>`wifi/ok` (info) | desktop/laptop |
| `updates` — Pending updates | updates | `updates/none` (info)<br>`updates/pending` (info/medium)<br>`updates/stale` (info)<br>`updates/skipped` (info) | desktop/laptop/server |
| `snap` — Snap updates and refresh timer | updates | `snap/no-timer` (medium)<br>`snap/ok` (info)<br>`snap/pending` (info/medium) | desktop/laptop/server |
| `firmware` — Firmware updates (fwupd) | updates | `firmware/none` (info)<br>`firmware/not-checked` (info)<br>`firmware/pending` (medium) | desktop/laptop/server |
| `flatpak` — Flatpak app updates | updates | `flatpak/none` (info)<br>`flatpak/pending` (info/medium) | desktop/laptop/server |
| `reboot` — Reboot required / kernel updates | updates | `reboot/skipped` (info)<br>`reboot/ok` (info)<br>`reboot/required` (medium) | desktop/laptop/server |
| `packages` — Package manager health | system | `packages/broken` (high)<br>`packages/locked` (medium)<br>`packages/ok` (info) | desktop/laptop/server |
| `battery` — Battery | hardware | `battery/low` (medium)<br>`battery/none` (info)<br>`battery/status` (info)<br>`battery/wear` (info/medium) | laptop |
| `gpu` — Graphics / GPU | hardware | `gpu/amd` (info)<br>`gpu/amd-missing` (medium)<br>`gpu/driver` (info)<br>`gpu/none` (info)<br>`gpu/nouveau` (medium)<br>`gpu/nvidia` (info)<br>`gpu/nvidia-missing` (medium)<br>`gpu/skipped` (info)<br>`gpu/software-rendering` (medium) | desktop/laptop |
| `gpu-usage` — GPU memory pressure | graphics | `gpu-usage/vram-full` (medium)<br>`gpu-usage/active` (info) | desktop/laptop/server |
| `bluetooth` — Bluetooth | hardware | `bluetooth/failed` (medium)<br>`bluetooth/none` (info)<br>`bluetooth/ok` (info)<br>`bluetooth/stopped` (medium) | desktop/laptop |
| `wayland` — Wayland / display session | hardware | `wayland/healthy` (info)<br>`wayland/loginctl-missing` (info)<br>`wayland/no-compositor` (medium)<br>`wayland/no-session` (info)<br>`wayland/not-graphical` (info)<br>`wayland/software-rendering` (medium)<br>`wayland/x11` (info) | desktop/laptop |
| `smart` — Disk health (SMART) | hardware | `smart/failing` (high)<br>`smart/good` (info)<br>`smart/needs-root` (info)<br>`smart/skipped` (info) | desktop/laptop/server |
| `hardware` — Hardware errors (MCE/ECC) | hardware | `hardware/ecc` (medium/high)<br>`hardware/mce` (high)<br>`hardware/ok` (info)<br>`hardware/skipped` (info) | desktop/laptop/server |
| `audio` — Audio (PipeWire / PulseAudio) | hardware | `audio/no-output` (medium)<br>`audio/no-server` (medium)<br>`audio/ok` (info)<br>`audio/sinks-skipped` (info) | desktop/laptop |
| `backup` — Backups and snapshots | data | `backup/none` (info)<br>`backup/ok` (info)<br>`backup/stale` (medium)<br>`backup/unknown` (info)<br>`backup/unscheduled` (info) | desktop/laptop/server |
| `fstrim` — SSD TRIM (fstrim) | data | `fstrim/disabled` (medium)<br>`fstrim/ok` (info)<br>`fstrim/ok-discard` (info)<br>`fstrim/skipped` (info) | desktop/laptop/server |
| `orphans` — Orphaned packages | system | `orphans/many` (medium)<br>`orphans/none` (info)<br>`orphans/some` (info) | desktop/laptop/server |
| `boot` — Boot partition | system | `boot/full` (high/medium)<br>`boot/no-config` (medium)<br>`boot/ok` (info) | desktop/laptop/server |
| `cache` — Cache and trash | system | `cache/large` (info/medium)<br>`cache/ok` (info)<br>`cache/trash` (info/medium) | desktop/laptop |

See `docs/severity.md` for how severities are decided, and `src/fix.js` for the safe-fix catalogue.
