# Releasing

How a version goes from this repo to downloadable artifacts on
<https://github.com/7sh1d0w7x/linux-doctor/releases>.

## Release checklist

Patch = fixes only, minor = new checks or flags. At 0.x anything may change
(SemVer §4), but a fixes-only release still reads as a patch.

```bash
node scripts/bump-version.mjs X.Y.Z          # 1. bump every manifest, the AppStream release entry, and generated docs
# 2. CHANGELOG.md: move [Unreleased] into `## [X.Y.Z] - YYYY-MM-DD`
npm test                                     # 3. full suite
git commit -am "chore: release X.Y.Z"        # 4. commit, push, wait for green CI on main
git tag -s vX.Y.Z -m "vX.Y.Z"                # 5. signed tag
git push origin vX.Y.Z                       # 6. triggers release.yml
```

7. Watch the release workflow: it attaches the tarball, AppImage, `.deb`, `.rpm`,
   `latest.json` and the checksums, and extracts the notes from `CHANGELOG.md`
   verbatim (not auto-generated).
8. **Publish to npm** (manual, next section). Skipping this leaves
   `npx linux-doctor` on an old version: only 0.2.0, 0.2.1 and 0.6.0 ever
   reached the registry.
9. Bump downstream: OBS (new tarball + spec, see packaging/README.md). For AUR
   (once registration reopens): put the tarball's real sha256 into
   `packaging/aur/PKGBUILD` and regenerate the pair with
   `makepkg --printsrcinfo > packaging/aur/.SRCINFO`, since both ship SKIP until
   then. AppImageHub needs nothing: it tracks channels, not versions.
10. Verify what users will get:

```bash
gh release view vX.Y.Z                      # assets
node scripts/verify-updater-signature.mjs   # AppImage signature vs the pubkey
npx linux-doctor@latest --version           # the registry serves X.Y.Z
```

11. Smoke test one real install path (npx or the AppImage), then announce. A
    patch gets release notes; aggregators (Hacker News, Reddit) wait for a
    release that adds something.

## What CI builds automatically

Pushing a tag `vX.Y.Z` triggers `.github/workflows/release.yml`:

| Job | Runs on | Produces |
|---|---|---|
| **cli** | ubuntu-latest | `linux-doctor-X.Y.Z.tgz` (npm pack, after `npm test`) + `SHA256SUMS` |
| **gui** | ubuntu-22.04 | `linux-doctor-X.Y.Z-x86_64.AppImage` (+ `.sig`), `Linux.Doctor_X.Y.Z_amd64.deb`, `Linux.Doctor-X.Y.Z-1.x86_64.rpm`, `latest.json`, `SHA256SUMS-bundles.txt` |

Both jobs attach their files to the same GitHub Release. Release notes are
extracted verbatim from `CHANGELOG.md` via `awk` (body_path), not auto-generated. Each asset gets a Sigstore attestation via `actions/attest`. The gui job builds on 22.04 on
purpose: the AppImage links against an older glibc, so it runs on most
distributions.

## Cut a release (with signed tag + SHA256SUMS)

```bash
# 0. one-time GPG setup (see /RELEASING.md)
# 1. bump all manifests atomically + regenerate docs:
node scripts/bump-version.mjs 0.4.0
# 2. curate CHANGELOG.md: move [Unreleased] -> ## [0.4.0] - YYYY-MM-DD
npm run goldens:update   # if output changed
npm test                 # must be green (600+ tests)
npm pack --dry-run | grep src-gui/index.html
node bin/doctor.js --self-test && node bin/doctor.js --json | jq .checksRun

# Real-browser dashboard smoke (not in PR CI — needs a cached Chromium +
# playwright-core). Catches JS/console errors a vm test cannot:
node bin/doctor.js --web & sleep 5
node scripts/check-dashboard.mjs http://127.0.0.1:43901/
kill %1


git commit -am "chore: release 0.4.0"
git push origin main              # wait for CI green (Node 20/22/24 + Fedora + Rust)
git tag -s v0.4.0 -m "v0.4.0" && git tag -v v0.4.0
git push origin v0.4.0            # triggers release.yml -> tgz + AppImage/deb/rpm + SHA256SUMS + attestations
# 3. verify Release: SHA256SUMS, CHANGELOG body, --version matches tag
```

## Publish to npm (manual)

The `npm publish` step in `release.yml` is disabled (`if: false`): npm now
stages new publishes for malware scanning (5–15 min) and needs auth the tag
workflow does not carry. Publish from the release commit instead:

```bash
git checkout v0.6.0        # the tag, so the tarball matches the release
npm publish                # needs an npm token with 2FA
npm view linux-doctor version   # confirm it went live (a few minutes later)
```

`linux-doctor@0.6.0` is live, so `npx linux-doctor` and
`npm i -g linux-doctor` resolve to it. Only publish a version that does not
exist yet — the registry rejects a second upload of the same version (409),
and a first upload sits in staging for a few minutes before it appears.

## Build the GUI locally (optional)

Needs WebKitGTK/GTK3 dev libraries, which immutable systems (Bazzite,
Silverblue) do not expose directly. Use a toolbox container — inside it you
have passwordless sudo:

```bash
toolbox -y create -c ldbuild
toolbox run -c ldbuild -- bash -lc '
  sudo dnf install -y nodejs npm rust cargo \
    webkit2gtk4.1-devel gtk3-devel librsvg2-devel file patchelf openssl-devel'
cd <repo>
toolbox run -c ldbuild -- bash -lc 'npm ci && npm run build:gui && npx tauri build --bundles deb'
```

Artifacts land in `src-tauri/target/release/bundle/deb/`.

Two gotchas learned the hard way:

- **Run what you built inside the same container** (`toolbox run -c ldbuild
  -- ./src-tauri/target/release/linux-doctor` with
  `WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/user/1000`). A binary
  compiled against the container's WebKitGTK crashes on the host's older
  libs (`free(): corrupted unsorted chunks`).
- **AppImage bundling may fail on bleeding-edge Fedora containers**: the
  `strip` shipped inside linuxdeploy rejects modern `.relr.dyn` ELF sections
  found in current Fedora libraries (`unknown type [0x13]`). Exporting
  `APPIMAGE_EXTRACT_AND_RUN=1` is required regardless (no FUSE), but does
  not fix strip. Practical split: build **deb locally**, let **CI produce
  the AppImage** on ubuntu-22.04.

## Node runtime resolution

The desktop shell runs the Node CLI under the hood. It picks the interpreter
in this order: `$LINUX_DOCTOR_NODE`, `<resources>/runtime/node` (a runtime
bundled into the packages by `node scripts/fetch-node-runtime.mjs` — run
before every `tauri build`; release.yml does it automatically), then `node`
from PATH. Since 0.5.x the .deb/.AppImage/.rpm ship the Node 22 LTS binary,
so end users need nothing on their PATH; the runtime dir is gitignored and
must be refetched after a clean checkout.

## Asset naming convention

```
linux-doctor-0.3.0-x86_64.AppImage    # primary download (catalog convention)
Linux.Doctor_0.3.0_amd64.deb          # Debian/Ubuntu
Linux.Doctor-0.3.0-1.x86_64.rpm       # Fedora/RHEL/openSUSE
linux-doctor-0.3.0.tgz                # npm CLI tarball
```

The AppImage uses the `<repo>-<version>-<arch>.AppImage` name so catalogs
(auto-discovering it from the GitHub Releases) work. `release.yml` also
repacks it to make `AppRun.wrapped` world-executable (0755) — linuxdeploy
ships it 0770, which breaks sandboxes that mount the AppImage as root and drop
to a user (Firejail, used by AppImageHub) — and re-signs it for the updater.

## Release notes (minimum)

```
🩺 Linux Doctor v0.3.0

Download `linux-doctor-0.3.0-x86_64.AppImage`, then:
  chmod +x linux-doctor-*-x86_64.AppImage && ./linux-doctor-*-x86_64.AppImage

CLI users: npx github:7sh1d0w7x/linux-doctor  (Node ≥ 20)
Read-only diagnostics — it never modifies your system.
```

## Auto-update (desktop app)

The Tauri app checks GitHub Releases for a newer **signed** build and, with
the user's consent, installs it and restarts. The check runs ~12s after
startup and from the tray's **Check for updates** item. `LINUX_DOCTOR_NO_UPDATE=1`
disables it (dev/tests).

- Endpoint: `https://github.com/7sh1d0w7x/linux-doctor/releases/latest/download/latest.json`
  (configured in `src-tauri/tauri.conf.json` → `plugins.updater.endpoints`).
- The manifest `latest.json` is assembled by `scripts/make-latest-json.mjs`
  from the signed AppImage (`*.AppImage` + `*.AppImage.sig`) during the release
  job — Tauri's CLI does not write it (that is `tauri-action`'s job, which this
  repo does not use).
- The release then runs `scripts/verify-updater-signature.mjs`, which checks the
  AppImage's signature and the `latest.json` signature against the **public key
  embedded in the app** — the same thing the updater does at install time. A
  release cannot ship an artifact the updater would reject.
- **Linux auto-update targets the AppImage.** `.deb`/`.rpm` users update
  through their package manager.

### Signing key (one-time, then a CI secret)

```bash
npx tauri signer generate -w ~/.tauri/linux-doctor.key   # keep the private key safe
```

1. Put the printed **public** key into `src-tauri/tauri.conf.json` →
   `plugins.updater.pubkey`.
2. Store the **private** key as the repository secret
   `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, empty
   for a passwordless key). **Never commit it.**
3. The release job fails fast if the secret is missing — a release without it
   would produce artifacts no installed app can verify.

**If the private key is lost, existing installs can no longer be updated** by
a new key (the public key is baked into each build). Generate a new pair,
update `pubkey`, and ship one release users install manually; from then on
auto-update works again.
