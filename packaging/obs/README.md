# openSUSE Build Service (OBS)

OBS builds RPMs for **Fedora, RHEL/CentOS, openSUSE and others** from one spec
and hosts a repository users can add. It is the COPR alternative that does
**not** need a Fedora account.

## Live project

- Project: `home:7sh1d0w7x:linux-doctor` — repository `Fedora_42`
- Web: <https://build.opensuse.org/project/show/home:7sh1d0w7x:linux-doctor>
- Users install it with:
  ```bash
  sudo dnf config-manager --add-repo \
    https://download.opensuse.org/repositories/home:/7sh1d0w7x:/linux-doctor/Fedora_42/home:7sh1d0w7x:linux-doctor.repo
  sudo dnf install linux-doctor
  ```

## One-time setup (already done)

1. openSUSE account: <https://id.opensuse.org/>.
2. `osc` installed and logged in (credentials in `~/.config/osc/oscrc`).

## Publishing a new version

The source services were not available on this OBS instance, so the tarball is
uploaded by hand. `linux-doctor.spec` here is a copy of
[`../linux-doctor.spec`](../linux-doctor.spec) — re-copy it on a version bump.

```bash
osc checkout home:7sh1d0w7x:linux-doctor
cd home:7sh1d0w7x:linux-doctor/linux-doctor
cp <repo>/packaging/obs/linux-doctor.spec .
curl -sLO https://github.com/7sh1d0w7x/linux-doctor/releases/download/v<version>/linux-doctor-<version>.tgz
osc add linux-doctor.spec linux-doctor-<version>.tgz
osc commit -m "linux-doctor <version>"
osc results home:7sh1d0w7x:linux-doctor
```

Add a repository per distro in the project (Fedora 42 is enabled; add
RHEL/CentOS or openSUSE chroots in the web UI when needed — the package is
`noarch` and needs Node ≥ 20 at runtime).
