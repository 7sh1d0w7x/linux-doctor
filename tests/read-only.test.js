// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The product promise is "read-only by construction": fixes are printed and
 * never executed. That promise is only worth anything if it is checked, so
 * this test reads every command the checks hand to ctx.run() and fails on
 * anything that could change the machine — sudo, a mutating verb, or a
 * service manager told to start/stop/restart.
 *
 * Commands that are only PRINTED (in a fix string) are deliberately not
 * covered: telling the user to run `sudo dnf install` is the product working.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

function jsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = dir + "/" + e.name;
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

/* Verbs that change state when they are the command being run. A check that
   needs to know "is X installed" uses `command -v`, not `apt install`. */
const MUTATING = new Set([
  "rm", "mv", "cp", "ln", "touch", "mkdir", "rmdir", "chmod", "chown", "truncate",
  "dd", "tee", "mkfs", "fdisk", "parted", "mount", "umount", "sysctl", "fstrim", "blockdev",
  "useradd", "usermod", "userdel", "groupadd", "passwd", "kill", "pkill", "killall",
  "reboot", "shutdown", "poweroff", "halt", "systemd-run",
]);

/* Package managers, and the token patterns that make an invocation a QUESTION
   rather than an action. `apt-get -s autoremove` and `dnf autoremove
   --assumeno` change nothing; `apt-get autoremove` does. */
const PKG_QUERY = {
  apt: (t) => t.some((x) => /^(-s|--simulate|check|list|show|policy|cache|search|--print-uris)$/.test(x)),
  "apt-get": (t) => PKG_QUERY.apt(t),
  dnf: (t) => t.some((x) => /^(check|repoquery|list|info|search|history|provides|--assumeno|--cacheonly)$/.test(x)),
  dnf5: (t) => PKG_QUERY.dnf(t),
  yum: (t) => PKG_QUERY.dnf(t),
  pacman: (t) => t.some((x) => /^-Q|^-Dk$|^-D$|^-T$|^-Ss$|^-Si$/.test(x)),
  zypper: (t) => t.some((x) => /^(packages|lu|list-updates|verify|search|info|patches|repos|--non-interactive)$/.test(x)),
  apk: (t) => t.some((x) => /^(version|info|list|audit|dot|policy|search|--simulate)$/.test(x)),
  "xbps-query": () => true,
  "xbps-install": (t) => t.some((x) => /^(-S?un|-u?n|-n)$/.test(x)),
  "xbps-remove": (t) => t.some((x) => /^-n$/.test(x)),
  emerge: (t) => t.some((x) => /^(-p|--pretend|--info|--search|-s|--fetchonly)$/.test(x)),
  flatpak: (t) => t.some((x) => /^(list|remote-ls|remote-info|info|search|history|permissions)$/.test(x)),
  snap: (t) => t.some((x) => /^(list|info|version|changes|--list)$/.test(x)),
  "rpm-ostree": (t) =>
    t.includes("status") || t.includes("db") ||
    (t.includes("upgrade") && t.includes("--check")) ||
    (t.includes("kargs") && !t.some((x) => /^--(append|delete|editor|unset)/.test(x))),
  swapon: (t) => t.some((x) => /^(--show|-s)$/.test(x)),
  swaponx: () => true,
  fstrim: (t) => t.some((x) => /^(--dry-run|-n)$/.test(x)),
  "systemd-analyze": (t) => t.some((x) => /^(blame|critical-chain|verify|dump|unit-paths|time)$/.test(x)),
};

/* Service managers are fine when asked a question, never when told to act. */
const READ_SERVICE_ACTIONS = new Set([
  "is-active", "is-enabled", "is-failed", "show", "status", "cat", "list-units",
  "list-timers", "list-unit-files", "get-default", "daemon-reload-check",
]);

function segments(cmd) {
  return cmd.split(/;|&&|\|\||\|/).map((s) => s.trim()).filter(Boolean);
}

/* First real token of a segment, skipping env assignments and wrappers. */
function firstToken(seg) {
  const toks = seg.split(/\s+/).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  return { tok: (toks[0] || "").replace(/^[(]+/, ""), rest: toks.slice(1) };
}

function offence(cmd) {
  for (const seg of segments(cmd)) {
    const { tok, rest } = firstToken(seg);
    const base = tok.split("/").pop();
    if (base === "sudo" || base === "doas" || base === "pkexec") return "privilege escalation";
    if (base === "systemctl" || base === "sv" || base === "rc-service" || base === "rc-update" || base === "service") {
      const verb = rest.find((t) => !t.startsWith("-"));
      if (verb && /^(start|stop|restart|reload|enable|disable|mask|reset-failed|set-default|kill|daemon-reexec)$/.test(verb)) {
        return "service action: " + verb;
      }
      continue;
    }
    if (PKG_QUERY[base]) {
      if (!PKG_QUERY[base](rest)) return "package manager in a non-query mode: " + base;
      continue;
    }
    if (MUTATING.has(base)) return "mutating verb: " + base;
    if (/(^|\s)>\s*[^&]/.test(seg) && !/2>/.test(seg)) return "output redirection to a file";
  }
  return null;
}

test("the doctor never EXECUTES a command that changes the machine", () => {
  const offenders = [];
  for (const f of jsFiles("src")) {
    readFileSync(f, "utf8").split("\n").forEach((ln, i) => {
      for (const m of ln.matchAll(/ctx\.run\(\s*[`"]([^`"]+)[`"]/g)) {
        const why = offence(m[1]);
        if (why) offenders.push(`${f}:${i + 1} — ${why}\n      ${m[1].slice(0, 140)}`);
      }
    });
  }
  assert.deepEqual(offenders, [], "executed commands must be read-only:\n" + offenders.join("\n"));
});
