// SPDX-License-Identifier: GPL-3.0-or-later
import { journalLines } from "../utils.js";
import { defineCheck } from "./define.js";
import { finding } from "../findings.js";

/**
 * Bring-up: the reasons a device is simply *not there* after boot. `hardware`
 * looks for errors on devices that are working; this looks at devices that
 * never appeared, which is what people actually bring to a support thread
 * ("my Bluetooth and USB are gone"). Three causes, one story: firmware the
 * kernel could not load, USB devices that failed to enumerate, and controllers
 * with no driver bound.
 *
 * Read-only, current boot only: a device that failed once and now works is not
 * a current problem, and `-b` is the honest "this boot" window. The kernel log
 * is one cheap wide read; classification happens in JS so a routine line can be
 * rejected instead of becoming a finding.
 */

const FIRMWARE_RE = /failed to load firmware|firmware load for|direct firmware load/i;
const USB_RE =
  /unable to enumerate usb|device descriptor read|device not accepting address|maybe the usb cable is bad|cannot enable port/i;
const CRITICAL_PCI_RE =
  /usb controller|ethernet controller|network controller|vga compatible|3d controller|display controller/i;

/**
 * Devices of a class you would notice missing, whose PCI function has no
 * "Kernel driver in use". Anything else (bridges, unassigned functions) often
 * has no driver on purpose, so flagging those would be noise.
 */
function unboundCriticalDevices(lspciOut) {
  const devices = [];
  let current = null;
  for (const raw of lspciOut.split("\n")) {
    if (raw.trim() === "") continue;
    if (/^\S/.test(raw)) {
      if (current) devices.push(current);
      current = { line: raw, name: raw.slice(0, 70), hasDriver: false };
    } else if (current && /^\s+Kernel driver in use:/i.test(raw)) {
      current.hasDriver = true;
    }
  }
  if (current) devices.push(current);
  return devices.filter((d) => CRITICAL_PCI_RE.test(d.line) && !d.hasDriver);
}

export const bringup = defineCheck({
  id: "bringup",
  title: "Hardware bring-up (firmware, drivers, USB)",
  category: "hardware",
  appliesTo: ["desktop", "laptop"],
  async run(ctx) {
    const findings = [];

    // Same two-question split as `hardware`: whether the log can be read is
    // separate from what is in it, because the grep exits 1 when nothing
    // matches and that status means "found something", not "could read".
    const readable = await ctx.run("command -v journalctl 2>/dev/null");
    const logReadable = readable.ok && readable.stdout.trim() !== "";

    const [ker, lspci] = await Promise.all([
      ctx.run(
        'journalctl -k -b --no-pager -o short 2>/dev/null | grep -iE "failed to load firmware|firmware load for|direct firmware load|unable to enumerate usb|device descriptor read|device not accepting address|maybe the usb cable is bad|cannot enable port"'
      ),
      ctx.run("lspci -nnk 2>/dev/null"),
    ]);

    const logLines = journalLines(ker.stdout, { tail: 40 });
    const fwLines = logLines.filter((l) => FIRMWARE_RE.test(l)).slice(-5);
    const usbLines = logLines.filter((l) => USB_RE.test(l)).slice(-5);

    if (fwLines.length > 0) {
      const names = [...new Set(fwLines.map((l) => (l.match(/for ([^\s,]+)/i) || [])[1]).filter(Boolean))];
      findings.push(
        finding({
          severity: "medium",
          code: "bringup/firmware",
          title: "A device could not load its firmware",
          detail: `The kernel could not load firmware for ${names.length ? names.join(", ") : "a device"}. The device is present on the bus but cannot work without its firmware blob, so it looks missing rather than broken.`,
          evidence: fwLines.join("\n"),
          fix:
            ctx.dist.family === "debian"
              ? "Install the firmware package, e.g. `sudo apt install firmware-misc-nonfree` (or `linux-firmware`), then reboot."
              : "Install or update the firmware package (`linux-firmware` on most distros), then reboot.",
          confidence: "medium",
        })
      );
    }

    if (usbLines.length > 0) {
      findings.push(
        finding({
          severity: "medium",
          code: "bringup/usb",
          title: "USB devices failed to come up",
          detail:
            "The kernel reported USB enumeration errors on this boot. A device that cannot enumerate never appears, so it looks missing rather than broken. On a laptop the Bluetooth adapter is usually an internal USB device, so one USB-controller problem can take out both USB and Bluetooth at once.",
          evidence: usbLines.join("\n"),
          fix: "Try another port and another cable first. If the errors repeat, look at the bus with `lsusb -t` and `dmesg | grep -i usb`; on very new hardware an older kernel is often the cause (`uname -r`).",
          confidence: "medium",
        })
      );
    }

    const unbound = unboundCriticalDevices(lspci.stdout);
    if (unbound.length > 0) {
      findings.push(
        finding({
          severity: "medium",
          code: "bringup/driver",
          title: "A device has no driver bound",
          detail: `These devices are present on the bus but no kernel driver is using them, so they cannot work: ${unbound.map((d) => d.name).join("; ")}. This usually means the driver module is missing (an older kernel on new hardware) or was not loaded.`,
          evidence: unbound.map((d) => d.line).join("\n"),
          fix: "Check the device with `lspci -nnk` and the kernel with `uname -r`. On very new hardware a newer kernel usually carries the driver; otherwise the vendor driver may be needed.",
          confidence: "medium",
        })
      );
    }

    if (findings.length === 0) {
      if (logReadable) {
        findings.push(
          finding({
            severity: "info",
            code: "bringup/ok",
            title: "No bring-up problems found",
            detail:
              "No firmware load failures or USB enumeration errors were found in this boot's kernel log, and the controllers we check have drivers bound.",
            evidence: "firmware: none · usb: none · unbound controllers: none",
            fix: null,
            confidence: "high",
          })
        );
      } else {
        findings.push(
          finding({
            severity: "info",
            code: "bringup/skipped",
            title: "Bring-up check partial",
            detail:
              "The kernel log is not readable (`journalctl` unavailable), so firmware and USB bring-up could not be checked. Only the driver check ran.",
            evidence: "journalctl: not found",
            fix: null,
            confidence: "high",
          })
        );
      }
    }

    return findings;
  },
});
