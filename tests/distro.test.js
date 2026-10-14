// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDistro, pkgInstall, pkgCacheClean, oldKernelClean, bootloaderRefresh, svcCmd, svcLogs, hasTimers } from "../src/distro.js";

test("pkgInstall: same-named packages produce the right command per package manager", () => {
  assert.equal(pkgInstall(detectDistro({ ID: "fedora" }), "smartmontools"), "sudo dnf install smartmontools");
  assert.equal(pkgInstall(detectDistro({ ID: "debian" }), "smartmontools"), "sudo apt install smartmontools");
  assert.equal(pkgInstall(detectDistro({ ID: "arch" }), "smartmontools"), "sudo pacman -S smartmontools");
  assert.equal(pkgInstall(detectDistro({ ID: "opensuse-tumbleweed" }), "x"), "sudo zypper install x");
  assert.equal(pkgInstall(detectDistro({ ID: "alpine" }), "x"), "sudo apk add x");
});

test("pkgInstall: atomic systems install via rpm-ostree, and say when it takes effect", () => {
  const dist = detectDistro({ ID: "bazzite", ID_LIKE: "fedora" });
  assert.equal(dist.imageBased, true);
  // Layering is the correct command, but it only lands on the next boot.
  assert.equal(pkgInstall(dist, "fastfetch"), "sudo rpm-ostree install fastfetch, then reboot");
});

test("pkgInstall: array joins into one command", () => {
  assert.equal(pkgInstall(detectDistro({ ID: "ubuntu" }), ["podman", "buildah"]), "sudo apt install podman buildah");
});

test("pkgInstall: map form resolves per-distro package names by pkg first, then family, then *", () => {
  // fedora family: the dnf key wins over the family key.
  const fedora = detectDistro({ ID: "fedora" });
  assert.equal(pkgInstall(fedora, { dnf: "procps-ng", debian: "procps", "*": "procps" }), "sudo dnf install procps-ng");
  // debian: falls through to the explicit debian key.
  const ubuntu = detectDistro({ ID: "ubuntu" });
  assert.equal(pkgInstall(ubuntu, { dnf: "iproute", "*": "iproute2" }), "sudo apt install iproute2");
  // arch: no arch/debian key — the "*" fallback applies.
  const arch = detectDistro({ ID: "arch" });
  assert.equal(pkgInstall(arch, { dnf: "procps-ng", "*": "procps" }), "sudo pacman -S procps");
});

test("pkgInstall: a missing key without * is a loud error, not a wrong command", () => {
  assert.throws(() => pkgInstall(detectDistro({ ID: "fedora" }), { debian: "procps" }));
});

test("pkgInstall: void and gentoo get native commands, not guesses", () => {
  assert.equal(pkgInstall(detectDistro({ ID: "void" }), "smartmontools"), "sudo xbps-install -Sy smartmontools");
  assert.equal(pkgInstall(detectDistro({ ID: "gentoo" }), "smartmontools"), "sudo emerge smartmontools");
});

test("pkgInstall: an unknown distribution gets an honest manual step, never a wrong command", () => {
  // NixOS (and other unrecognized systems) must not be told to run dnf.
  const out = pkgInstall(detectDistro({ ID: "nixos" }), "fastfetch");
  assert.match(out, /fastfetch/);
  assert.match(out, /package manager/i);
  assert.doesNotMatch(out, /sudo dnf/);
  assert.doesNotMatch(out, /sudo apt/);
});

test("pkgCacheClean: an image-based system has no package cache, and says so", () => {
  const atomic = pkgCacheClean(detectDistro({ ID: "bazzite", ID_LIKE: "fedora" }));
  assert.match(atomic, /rpm-ostree cleanup -m/);
  assert.match(atomic, /no package cache/i);
  // `dnf clean all` is the classic wrong move on an Atomic desktop.
  assert.doesNotMatch(atomic, /dnf clean/);
  assert.equal(pkgCacheClean(detectDistro({ ID: "fedora" })), "`sudo dnf clean all`");
  assert.equal(pkgCacheClean(detectDistro({ ID: "ubuntu" })), "`sudo apt clean`");
  assert.equal(pkgCacheClean(detectDistro({ ID: "arch" })), "`sudo pacman -Sc`");
});

test("oldKernelClean: never a package verb on a system whose kernel is not a package", () => {
  const atomic = oldKernelClean(detectDistro({ ID: "bazzite", ID_LIKE: "fedora" }));
  assert.match(atomic, /part of the image/);
  assert.doesNotMatch(atomic, /dnf remove/);
  assert.equal(oldKernelClean(detectDistro({ ID: "fedora" })), "`sudo dnf remove --oldinstallonly`");
  assert.equal(oldKernelClean(detectDistro({ ID: "debian" })), "`sudo apt autoremove --purge`");
  // Arch ships one kernel version at a time — saying "remove old kernels" would be wrong.
  assert.match(oldKernelClean(detectDistro({ ID: "arch" })), /one kernel version/);
});

test("bootloaderRefresh: grub2-mkconfig is the wrong move on an image-based system", () => {
  const atomic = bootloaderRefresh(detectDistro({ ID: "bazzite", ID_LIKE: "fedora" }));
  assert.match(atomic, /do not regenerate GRUB by hand/);
  assert.match(atomic, /rpm-ostree kargs/);
  assert.doesNotMatch(atomic, /mkconfig/);
  // openSUSE is the family where the path differs from the Fedora one.
  assert.match(bootloaderRefresh(detectDistro({ ID: "opensuse-tumbleweed" })), /grub2-mkconfig -o \/boot\/grub2\/grub\.cfg/);
  assert.match(bootloaderRefresh(detectDistro({ ID: "ubuntu" })), /update-grub/);
});

test("svcCmd: the same action becomes rc-service / sv / systemctl by init system", () => {
  assert.equal(svcCmd(detectDistro({ ID: "bazzite", ID_LIKE: "fedora" }), "restart", "sshd"), "sudo systemctl restart sshd");
  assert.equal(svcCmd(detectDistro({ ID: "alpine" }), "restart", "sshd"), "sudo rc-service sshd restart");
  assert.equal(svcCmd(detectDistro({ ID: "void" }), "restart", "sshd"), "sudo sv restart sshd");
  assert.equal(svcCmd(detectDistro({ ID: "gentoo" }), "restart", "sshd"), "sudo rc-service sshd restart");
  // A systemd unit name must not reach OpenRC as `rc-service foo.service`.
  assert.equal(svcCmd(detectDistro({ ID: "alpine" }), "status", "bluetooth.service"), "rc-service bluetooth status");
});

test("svcCmd: enable-now per init, and an unknown action is null, never a guess", () => {
  assert.equal(svcCmd(detectDistro({ ID: "debian" }), "enable-now", "chronyd"), "sudo systemctl enable --now chronyd");
  assert.equal(svcCmd(detectDistro({ ID: "alpine" }), "enable-now", "chronyd"), "sudo rc-update add chronyd && sudo rc-service chronyd start");
  assert.equal(svcCmd(detectDistro({ ID: "void" }), "enable-now", "chronyd"), "sudo ln -s /etc/sv/chronyd /var/service/");
  assert.equal(svcCmd(detectDistro({ ID: "alpine" }), "reload", "nginx"), "sudo rc-service nginx reload");
  assert.equal(svcCmd(detectDistro({ ID: "alpine" }), "reset-failed", "x"), null);
});

test("svcLogs: journalctl on systemd, the system log elsewhere", () => {
  assert.equal(svcLogs(detectDistro({ ID: "fedora" }), "sshd"), "journalctl -u sshd -b");
  assert.match(svcLogs(detectDistro({ ID: "alpine" }), "sshd"), /\/var\/log\/messages/);
  assert.match(svcLogs(detectDistro({ ID: "void" }), "sshd"), /\/var\/log\/sshd\/current/);
});

test("hasTimers: timer units are a systemd-only concept", () => {
  assert.equal(hasTimers(detectDistro({ ID: "fedora" })), true);
  assert.equal(hasTimers(detectDistro({ ID: "bazzite", ID_LIKE: "fedora" })), true);
  for (const id of ["alpine", "gentoo", "void"]) assert.equal(hasTimers(detectDistro({ ID: id })), false, id);
});
