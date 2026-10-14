// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Distro detection, in one place. Parses /etc/os-release fields (uppercase on
 * real systems, lowercase in test stubs) into a normalized profile that every
 * check can rely on instead of doing its own string matching.
 */
export function detectDistro(osRelease = {}) {
  const get = (k) =>
    String(osRelease[k] || osRelease[k.toUpperCase()] || osRelease[k.toLowerCase()] || "").toLowerCase();
  const id = get("id");
  const idLike = get("id_like");
  const variant = get("variant");
  const all = `${id} ${idLike} ${variant}`;

  // Image-based (ostree/atomic) distros update atomically via rpm-ostree,
  // and their root filesystem is virtual. Checked before family detection.
  const imageBased = /bazzite|silverblue|kinoite|sericea|bluefin|atomic|ostree/.test(all);

  // The specific atomic variant, so messages can name the distro ("Bazzite"
  // instead of a generic "immutable system"). null on classic distros.
  const variantMatch = all.match(/(bazzite|silverblue|kinoite|sericea|bluefin|aurora|cosmic-atomic|ublue|bootc)/);
  const atomicVariant = variantMatch ? variantMatch[1] : (imageBased ? "atomic" : null);

  let family = "other";
  if (id === "alpine") family = "alpine";
  else if (id === "void") family = "void";
  else if (id === "gentoo") family = "gentoo";
  else if (id === "arch" || /manjaro|endeavouros/.test(id) || /arch/.test(idLike)) family = "arch";
  else if (/suse|opensuse/.test(`${id} ${idLike}`)) family = "suse";
  else if (id === "debian" || id === "ubuntu" || /debian|ubuntu/.test(idLike)) family = "debian";
  else if (/fedora|rhel|centos|rocky|almalinux|nobara|bazzite|silverblue|kinoite/.test(all)) family = "fedora";

  let pkg = "unknown";
  if (imageBased) pkg = "rpm-ostree";
  else if (family === "fedora") pkg = "dnf";
  else if (family === "debian") pkg = "apt";
  else if (family === "arch") pkg = "pacman";
  else if (family === "suse") pkg = "zypper";
  else if (family === "alpine") pkg = "apk";
  else if (family === "void") pkg = "xbps";
  else if (family === "gentoo") pkg = "emerge";

  // Init system — the commands a fix may suggest for services. Alpine and
  // Gentoo run OpenRC, Void runs runit, everything else here is systemd.
  let init = "systemd";
  if (family === "alpine" || family === "gentoo") init = "openrc";
  else if (family === "void") init = "runit";

  return { id, idLike, variant, family, pkg, imageBased, atomicVariant, init, all };
}

/**
 * Central distro-specific install helper — single source of truth for fix strings.
 * `pkgs` can be:
 *   - a string ("pipewire") or array (["podman","buildah"]) when the package
 *     has the same name everywhere, or
 *   - an object mapping package-manager/family → name for packages that are
 *     named differently across distros ({ fedora: "procps-ng", "*": "procps" }).
 *     Keys are matched against dist.pkg first (dnf/apt/pacman/zypper/apk/
 *     rpm-ostree), then dist.family, then "*" as the fallback.
 * Returns a copy-pasteable `sudo ... install` line for the current distro.
 * Keeps fix messages from drifting across 20+ checks.
 */
export function pkgInstall(dist, pkgs) {
  if (pkgs && typeof pkgs === "object" && !Array.isArray(pkgs)) {
    const pick = pkgs[dist?.pkg] ?? pkgs[dist?.family] ?? pkgs["*"];
    if (!pick) throw new Error(`pkgInstall: no package name for ${dist?.pkg || dist?.family || "unknown"} and no "*" fallback`);
    return pkgInstall(dist, pick);
  }
  const list = Array.isArray(pkgs) ? pkgs.join(" ") : String(pkgs);
  const p = dist?.pkg;
  // An unknown manager must never degrade to a wrong command — on NixOS or an
  // exotic system, "sudo dnf install" is bad advice, not a fallback.
  if (!p || p === "unknown") {
    return `Manual step: install ${list} with your distribution's package manager (not recognized by linux-doctor).`;
  }
  if (p === "apt") return `sudo apt install ${list}`;
  if (p === "apk") return `sudo apk add ${list}`;
  if (p === "pacman") return `sudo pacman -S ${list}`;
  if (p === "zypper") return `sudo zypper install ${list}`;
  if (p === "xbps") return `sudo xbps-install -Sy ${list}`;
  if (p === "emerge") return `sudo emerge ${list}`;
  // Image-based/atomic desktops (Bazzite, Silverblue, Kinoite…): layering is
  // the correct command for a genuinely missing system package, but it only
  // applies on the next boot.
  if (p === "rpm-ostree") return `sudo rpm-ostree install ${list}, then reboot`;
  return `sudo dnf install ${list}`;
}

/**
 * How to reclaim space held by the package manager's cache. "There is no
 * package cache" is a real answer here: an image-based system has no dnf or
 * apt cache at all — what exists is rpm-ostree's cached repo metadata and
 * transient deployment space.
 * Returns a phrase to embed in a fix sentence.
 */
export function pkgCacheClean(dist) {
  const p = dist?.pkg;
  if (p === "apt") return "`sudo apt clean`";
  if (p === "dnf") return "`sudo dnf clean all`";
  if (p === "pacman") return "`sudo pacman -Sc`";
  if (p === "zypper") return "`sudo zypper clean`";
  if (p === "apk") return "`sudo apk cache clean`";
  if (p === "xbps") return "`sudo xbps-remove -O`";
  if (p === "emerge") return "`sudo eclean-dist` (gentoolkit)";
  if (p === "rpm-ostree") {
    return "`sudo rpm-ostree cleanup -m` (cached repo metadata — there is no package cache to clear on an image-based system)";
  }
  return "your distribution's package-cache tool";
}

/**
 * How to get rid of old kernels. Returns a phrase, because on some systems the
 * honest answer is "there is nothing to remove": Arch ships one kernel version
 * at a time, and on an image-based system the kernel belongs to the image.
 */
export function oldKernelClean(dist) {
  const p = dist?.pkg;
  if (p === "apt") return "`sudo apt autoremove --purge`";
  if (p === "dnf") return "`sudo dnf remove --oldinstallonly`";
  if (p === "zypper") return "`sudo zypper purge-kernels`";
  if (p === "xbps") return "`sudo vkpurge rm all`";
  if (p === "emerge") return "`sudo eclean-kernel` (app-admin/eclean-kernel)";
  if (p === "pacman") return "nothing — Arch ships one kernel version at a time; old ones only linger in the package cache (`sudo pacman -Sc`)";
  if (p === "rpm-ostree") {
    return "nothing to remove by hand — the kernel is part of the image, and old kernels leave with their deployments (`sudo rpm-ostree cleanup -b` frees the space)";
  }
  return "remove old kernels with your distribution's tool";
}

/**
 * How to refresh the bootloader configuration. An image-based system is the
 * case that matters: boot entries are generated per deployment by rpm-ostree,
 * and running grub2-mkconfig there by hand is the classic wrong move.
 */
export function bootloaderRefresh(dist) {
  const p = dist?.pkg;
  if (p === "rpm-ostree") {
    return "do not regenerate GRUB by hand on an image-based system — boot entries are generated per deployment; use `sudo rpm-ostree kargs` for kernel arguments (and `ujust configure-grub` for menu visibility on Bazzite)";
  }
  if (dist?.family === "debian") return "`sudo update-grub`";
  if (dist?.family === "arch") return "`sudo grub-mkconfig -o /boot/grub/grub.cfg` (or `sudo bootctl update` for systemd-boot)";
  if (dist?.family === "suse") return "`sudo grub2-mkconfig -o /boot/grub2/grub.cfg` (note the `2` and `/boot/grub2/` on openSUSE)";
  if (dist?.family === "fedora") return "`sudo grub2-mkconfig -o /boot/grub2/grub.cfg`";
  return "refresh the bootloader with your distribution's tool";
}

/**
 * The service-manager command for an action on a unit. Returns a BARE command
 * string (callers wrap it in backticks), or null when the concept has no
 * equivalent on that init system — telling an OpenRC or runit user to run
 * `systemctl` is simply wrong.
 * Actions: status · start · stop · restart · reload · enable-now.
 */
export function svcCmd(dist, action, unit) {
  const init = dist?.init || "systemd";
  // systemd units carry a .service suffix; OpenRC and runit service names
  // do not, so `rc-service foo.service` would be wrong.
  const u = init === "systemd" ? unit : String(unit).replace(/\.service$/, "");
  if (init === "openrc") {
    if (action === "status") return `rc-service ${u} status`;
    if (action === "start") return `sudo rc-service ${u} start`;
    if (action === "stop") return `sudo rc-service ${u} stop`;
    if (action === "restart") return `sudo rc-service ${u} restart`;
    if (action === "reload") return `sudo rc-service ${u} reload`;
    if (action === "enable-now") return `sudo rc-update add ${u} && sudo rc-service ${u} start`;
    return null;
  }
  if (init === "runit") {
    if (action === "status") return `sv status ${u}`;
    if (action === "start") return `sudo sv start ${u}`;
    if (action === "stop") return `sudo sv stop ${u}`;
    if (action === "restart") return `sudo sv restart ${u}`;
    if (action === "reload") return `sudo sv reload ${u}`;
    if (action === "enable-now") return `sudo ln -s /etc/sv/${u} /var/service/`;
    return null;
  }
  if (action === "status") return `systemctl status ${u}`;
  if (action === "start") return `sudo systemctl start ${u}`;
  if (action === "stop") return `sudo systemctl stop ${u}`;
  if (action === "restart") return `sudo systemctl restart ${u}`;
  if (action === "reload") return `sudo systemctl reload ${u}`;
  if (action === "enable-now") return `sudo systemctl enable --now ${u}`;
  return null;
}

/**
 * Where to read a unit's log output. systemd has `journalctl -u`; OpenRC and
 * runit write to a system log instead, and it is a different file on each.
 */
export function svcLogs(dist, unit) {
  const init = dist?.init || "systemd";
  if (init === "openrc") return `grep ${unit} /var/log/messages | tail -n 50`;
  if (init === "runit") return `tail -n 50 /var/log/${unit}/current`;
  return `journalctl -u ${unit} -b`;
}

/**
 * Timer units exist on systemd only. A fix that says "enable fstrim.timer" is
 * meaningless on OpenRC and runit, where the equivalent is a cron job.
 */
export function hasTimers(dist) {
  return (dist?.init || "systemd") === "systemd";
}
