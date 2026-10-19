# Configuration

Config, ignore rules, thresholds, custom checks, and caching. For the CLI and
downloads, see the [README](../README.md).

## Immutable / atomic distros

Linux Doctor detects image-based systems and reports them in `system.atomic`
(`immutable`, `imageBased`, `bootc`, `variant`, `pkg`). Some checks do not
make sense on an immutable OS — most importantly `reboot`, which you cannot
act on without an OS update rather than a local reboot. Such checks are
skipped and listed in `skippedChecks` (with their reason) and
`checksAtomicSkipped` in JSON, and surfaced in the dashboard's **Skipped**
section, instead of producing misleading findings. Checks that are still
valid on atomic systems (e.g. `security` — firewall/SELinux) run normally.

## Ignore list

Tired of the same finding every run? Hide it — per run with `--ignore`, or
permanently in the config file (`~/.config/linux-doctor/config.json`,
override with `LINUX_DOCTOR_CONFIG`):

```bash
linux-doctor --ignore "Suspend hooks are failing"
# permanent:
cat > ~/.config/linux-doctor/config.json <<'EOF'
{ "ignore": ["Suspend hooks are failing", "fw-fanctrl"] }
EOF
```

Matches are case-insensitive substrings of the finding title, so a short
fragment like `fw-fanctrl` works. Ignored findings are dropped from the
report, the score, and the history — they simply stop existing. The dashboard
has an **Ignore** button on every finding that saves the pattern for you.

Manage the persistent list without editing JSON:

```bash
linux-doctor --ignore-add fw-fanctrl          # title fragment
linux-doctor --ignore-add services/failed     # code-shaped values go to the exact-match code list
linux-doctor --ignore-remove fw-fanctrl
```

The config is a bonus, never a dependency — if it cannot be read, nothing is
ignored.

Ignore is never silent: hidden findings are counted (`# ignored: N` in
`--plain`, `ignoredCount` in `--json`, "N finding(s) hidden" in the terminal
report), and a pattern that matches nothing warns on stderr — so a stale
ignore (e.g. after a finding title changed) rots loudly, not silently.

## Tuning thresholds

Every severity threshold has a sane desktop default, but they are all tunable
in the same config file:

```jsonc
{
  "ignore": ["fw-fanctrl"],
  "thresholds": {
    "diskFullPct": 90,      // partition % full → high
    "diskWarnPct": 80,      // partition % full → medium
    "inodeFullPct": 90,     // inode % full → high
    "inodeWarnPct": 80,     // inode % full → medium
    "memLowRatio": 0.15,    // available/total below → high
    "memWarnRatio": 0.25,   // available/total below → medium
    "loadWarnRatio": 0.7,   // load per core above → info
    "loadHighRatio": 1.0,   // load per core above → medium
    "loadCriticalRatio": 1.5, // load per core above → high
    "tempWarnC": 85,        // hottest CPU zone → medium
    "tempHotC": 95,         // hottest CPU zone → high
    "procWarnRatio": 0.2,   // single app share of RAM above → medium
    "procHighRatio": 0.4,   // single app share of RAM above → high
    "journalWarnBytes": 2147483648, // journal size above → medium (2 GB)
    "containerWarnGB": 20,  // container storage above → medium
    "containerHighGB": 50,  // container storage above → high
    "dnsSlowMs": 500,       // DNS resolution above → medium (ms)
    "certWarnDays": 30,     // TLS cert lifetime below → medium (days)
    "certCritDays": 7,      // TLS cert lifetime below → high (days)
    "backupStaleDays": 30   // scheduled backup not run for → medium (days)
  }
}
```

Every key is optional; unset keys keep the defaults. A server on a small disk
might set `diskFullPct: 80`, a 4 GB laptop `memWarnRatio: 0.3`.

## Plugins (custom checks)

Drop any `.js` file into `~/.config/linux-doctor/checks/` (override with
`LINUX_DOCTOR_PLUGINS`) and it becomes a check — no forking, no registry
edits. A plugin file exports an object shaped like a built-in check:

```js
// ~/.config/linux-doctor/checks/example.js
export default {
  id: "example",
  title: "Example custom check",
  category: "custom",          // optional
  appliesTo: ["server"],       // optional: desktop | laptop | server
  async run(ctx) {
    const res = await ctx.run("some-read-only-command 2>/dev/null");
    if (!res.ok) return [];
    return [{ severity: "info", title: "Everything is fine", detail: null, evidence: res.stdout, fix: null, confidence: "high" }];
  },
};
```

Plugins show up in `--list`, are gated by `appliesTo` like built-ins, and are
runnable with `--check example`. A broken or id-colliding plugin is skipped
with a warning — it never takes down a run.

`--plugins` is the provenance view: one line per active plugin,
`id — /absolute/path/to/file.js — (user plugin)`, sorted by id, or `none`
when the directory is empty. Broken and id-colliding files are reported on
stderr and are not listed, because they are not running.

> **Trust model:** a plugin is code you chose to install, and it runs with
> your full user privileges — it can read and write anything you can. Linux
> Doctor's own code is read-only by construction, but it cannot sandbox a
> plugin. Only drop in files you have read and trust. The same applies to the
> Pro add-on module (`LINUX_DOCTOR_PRO_MODULE`).

## Caching

The `updates` check refreshes package metadata, which is the slowest thing in
a full run (~5s with dnf). Its result is cached for 30 minutes at
`~/.cache/linux-doctor/updates.json` (override with `LINUX_DOCTOR_CACHE`;
disable with `LINUX_DOCTOR_UPDATES_TTL_MS=0`). A failed check is never
cached, so the next run retries. The cache is a bonus, never a dependency —
if it cannot be written, the check just runs uncached.
