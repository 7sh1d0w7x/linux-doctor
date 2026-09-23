// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The check registry — the single place a check is registered. Order matters:
 * it is the --list order, and dedupe ties keep the first finding (the
 * specialized check is listed before the aggregator one). Categories are
 * grouped contiguously so --list reads naturally.
 */
import { memory } from "./memory.js";
import { load } from "./load.js";
import { disk } from "./disk.js";
import { inodes } from "./inodes.js";
import { fs } from "./fs.js";
import { raid } from "./raid.js";
import { oom } from "./oom.js";
import { processes } from "./processes.js";
import { thermal } from "./thermal.js";
import { journald } from "./journald.js";
import { zram } from "./zram.js";
import { locales } from "./locales.js";
import { services } from "./services.js";
import { timers } from "./timers.js";
import { journal } from "./journal.js";
import { suspend } from "./suspend.js";
import { security } from "./security.js";
import { ssh } from "./ssh.js";
import { autologin } from "./autologin.js";
import { secureboot } from "./secureboot.js";
import { luks } from "./luks.js";
import { certs } from "./certs.js";
import { ports } from "./ports.js";
import { network } from "./network.js";
import { ntp } from "./ntp.js";
import { updates } from "./updates.js";
import { snap } from "./snap.js";
import { firmware } from "./firmware.js";
import { flatpak } from "./flatpak.js";
import { reboot } from "./reboot.js";
import { containers } from "./containers.js";
import { containerdisk } from "./containerdisk.js";
import { crash } from "./crash.js";
import { battery } from "./battery.js";
import { gpu } from "./gpu.js";
import { gpuUsage } from "./gpu-usage.js";
import { bluetooth } from "./bluetooth.js";
import { wayland } from "./wayland.js";
import { smart } from "./smart.js";
import { hardware } from "./hardware.js";
import { bringup } from "./bringup.js";
import { audio } from "./audio.js";
import { backup } from "./backup.js";
import { fstrim } from "./fstrim.js";
import { orphans } from "./orphans.js";
import { fds } from "./fds.js";
import { boot } from "./boot.js";
import { cache } from "./cache.js";
import { wifi } from "./wifi.js";
import { packages } from "./packages.js";

export const checks = [
  // system
  memory, load, disk, inodes, fs, raid, oom, processes, thermal, journald, zram, locales, fds,
  // software
  services, timers, journal, suspend, containers, containerdisk, crash,
  // security
  security, secureboot, luks, ssh, autologin, certs, ports,
  // network
  network, ntp, wifi,
  // updates
  updates, snap, firmware, flatpak, reboot, packages,
  // hardware
  battery, gpu, gpuUsage, bluetooth, wayland, smart, hardware, bringup, audio,
  // data
  backup, fstrim, orphans, boot, cache,
];

export const byId = new Map(checks.map((c) => [c.id, c]));
