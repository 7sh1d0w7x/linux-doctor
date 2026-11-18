# Packaging

linux-doctor is pure Node.js with zero runtime dependencies, which makes it
trivial to package. This directory holds the starting points; the canonical
artifact for every channel is the npm tarball from `npm pack` at a release
tag (it ships `bin/`, `src/`, and `src-gui/index.html` — the page the `--web`
dashboard needs at load time).

## Build the tarball

`npm pack` produces a `.tgz` whose contents live under a `package/` directory
(it does not extract to `linux-doctor-$VERSION/`). Both the PKGBUILD and the
RPM spec in this directory already account for that layout — `-n package` in
%setup, `$srcdir/package` in `package()`. If you prefer a plain root tar
instead, repack it:

```bash
VERSION=0.2.0
npm pack
tar -xzf linux-doctor-$VERSION.tgz
mv package linux-doctor-$VERSION
tar -czf linux-doctor-$VERSION.tar.gz linux-doctor-$VERSION
rm -rf linux-doctor-$VERSION
```

## Arch Linux (AUR)

`PKGBUILD` installs to `/usr/lib/linux-doctor` and symlinks
`/usr/bin/linux-doctor`. To publish:

```bash
git clone ssh://aur@aur.archlinux.org/linux-doctor.git /tmp/aur
cp packaging/aur/PKGBUILD packaging/aur/.SRCINFO /tmp/aur/
# bump pkgver + sha256sums first (see the header comment in the PKGBUILD), then:
cd /tmp/aur && makepkg -f && makepkg --printsrcinfo > .SRCINFO
git add . && git commit -m "linux-doctor 0.6.0" && git push
```

## Alpine Linux

`alpine/APKBUILD` builds the CLI with `abuild`, installs it to
`/usr/lib/linux-doctor` and symlinks `/usr/bin/linux-doctor`. It is not in a
public Alpine repository yet, so build it from this directory:

```bash
# on Alpine, or in a container: podman run -it --rm -v "$PWD":/src alpine
apk add abuild build-base nodejs
abuild-keygen -a -n
abuild -r
apk add --allow-untrusted ~/packages/*/*/linux-doctor-*.apk
```

`sha512sums` must be recomputed after each tag: the source URL embeds
`$pkgver`, and the hash can only be computed once the tarball exists.
`scripts/bump-version.mjs` updates `pkgver`/`pkgrel` and deliberately leaves
the hash alone, so a stale hash fails loudly instead of passing quietly.

Verified 2026-11-18 in `alpine:3.22`: build, `apk add`, `--version` and
`--check memory --plain`.

## Fedora / RHEL (COPR)

`linux-doctor.spec` is a working noarch spec. To build on COPR:

```bash
copr-cli create linux-doctor --chroot fedora-42-x86_64
# Source0 in the spec is the release tarball URL, so COPR fetches it directly:
copr-cli build linux-doctor packaging/linux-doctor.spec
```

(Or, with the tarball in `~/rpmbuild/SOURCES/`: `rpmbuild -ba packaging/linux-doctor.spec`.)

## openSUSE Build Service (OBS) — COPR without a Fedora account

OBS builds the same spec for Fedora/RHEL/openSUSE and hosts the repository, so
users add it and update with their package manager. Live project:
`home:7sh1d0w7x:linux-doctor`.

```bash
sudo dnf config-manager --add-repo \
  https://download.opensuse.org/repositories/home:/7sh1d0w7x:/linux-doctor/Fedora_42/home:7sh1d0w7x:linux-doctor.repo
sudo dnf install linux-doctor
```

Package files: [`obs/`](obs/README.md); publishing steps in
[obs/README.md](obs/README.md).

## Debian/Ubuntu

A `deb` needs a proper maintainer setup (`debian/` control files + `dpkg-buildpackage`).
The easiest path for now: the npm tarball plus a `/usr/bin` symlink, or a
`.deb` generated from the same layout as the RPM spec (install to
`/usr/lib/linux-doctor`).

## GUI: .desktop launcher

The Tauri app (`npm run gui:build`) produces a binary named `linux-doctor` and
the deb/rpm bundles it generates carry their own `.desktop` entry. For the
AppImage (which has no menu entry by default) or manual installs, ship the
launcher in this directory:

```bash
install -Dm644 packaging/linux-doctor.desktop ~/.local/share/applications/linux-doctor.desktop
install -Dm644 src-tauri/icons/128x128.png ~/.local/share/icons/hicolor/128x128/apps/linux-doctor.png
update-desktop-database ~/.local/share/applications 2>/dev/null || true
```

The desktop file expects the `linux-doctor` GUI binary on `PATH`, and the app
itself needs `node` on `PATH` (see the README) to run the checks.

## No Node on the target? (optional)

For environments without Node ≥ 20, `bun build --compile bin/doctor.js -o linux-doctor`
produces a single self-contained binary (evaluate size/startup before
committing to it). Node remains the primary, tested runtime.

## Release checklist (maintainers)

1. Bump `version` in `package.json`, add a `CHANGELOG.md` entry.
2. Tag `v<version>` — the `release.yml` workflow tests, packs, and attaches
   the tarball to a GitHub Release.
3. From that tarball, publish AUR / COPR / deb using the files here.
4. `npm publish` (the package ships everything the runtime needs — the
   `packaging gate` CI step guards the `files` list).

## AppStream / software centers

`com.zshadow7x.linuxdoctor.metainfo.xml` is the AppStream component for the
desktop app (id `com.zshadow7x.linuxdoctor`). It is embedded into the
`.deb`/`.rpm`/AppImage by `src-tauri/tauri.conf.json` (`bundle.linux.*.files`)
together with the app-id-named icons in `icons/`, so GNOME Software and KDE
Discover can show name, description, screenshots and release notes.

- Validate it after any edit: `appstreamcli validate --no-net <file>`.
- `desktop-template.desktop` is the Handlebars template Tauri uses for the
  deb/rpm menu entry; it fixes `Categories=` (Tauri leaves it empty by
  default) and sets `StartupWMClass`.
- Known Tauri limitation: the generated desktop file is named after
  `productName` (`Linux Doctor.desktop`), not the app-id. Flathub and the
  `packaging/com.zshadow7x.linuxdoctor.desktop` entry use the app-id name;
  for the deb/rpm the `<launchable>` may not link in every software center.

## AppImageHub

The catalog (`github.com/AppImage/appimage.github.io`, one file per app under
`data/`) takes a **single line**: the GitHub repo URL (the file name is the
catalog entry name). The AppImage must follow the catalog naming convention —
`<repo>-<version>-<arch>.AppImage` — which `release.yml` now enforces by
renaming Tauri's output. Submit:

```bash
# fork github.com/AppImage/appimage.github.io and add the file to data/
cp packaging/appimagehub/Linux_Doctor /tmp/appimagehub-data/Linux_Doctor
```

AppImageHub then discovers the AppImage from the GitHub releases.

## Flathub / Flatpak — intentionally not a target

Linux Doctor is a **system diagnostic**: its checks read the host's systemd,
journal, SMART data, package databases, `/proc` and `/sys`, and run host
commands. A Flatpak sandbox hides exactly those, so a Flathub build would
report mostly skipped or failed checks — a broken product, not a packaged one.
Tauri 2 also has no `flatpak` bundle target, so it would need a source
manifest on top of that. The same reasoning applies to strict Snap
confinement; a **classic** Snap could work but needs store approval and a
Snapcraft account.

The supported desktop channels are **AppImage**, **`.deb`/`.rpm`**, the
**OBS repository** for Fedora/RHEL/openSUSE, and **AUR** once it is published —
all of which run with normal host access.

