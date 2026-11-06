// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { certs } from "../src/checks/certs.js";
import { ports } from "../src/checks/ports.js";
import { fds } from "../src/checks/fds.js";
import { backup } from "../src/checks/backup.js";
import { detectDistro } from "../src/distro.js";
import { loadThresholds } from "../src/thresholds.js";

function stubCtx(map, osRelease = { id: "fedora", id_like: "fedora" }) {
  return {
    osRelease,
    dist: detectDistro(osRelease),
    thresholds: loadThresholds({}),
    run: async (cmd) => {
      const entry = map[cmd] ?? map[cmd.replaceAll("'", "")];
      if (entry === undefined) return { ok: false, code: 1, stdout: "", stderr: "" };
      return { ok: true, code: 0, stdout: entry, stderr: "" };
    },
  };
}

/** openssl-style `notAfter` string N days from now (bucket-safe margins). */
function notAfter(days) {
  const d = new Date(Date.now() + days * 86400000);
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n) => String(n).padStart(2, "0");
  return `notAfter=${M[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()} GMT`;
}

const LE_LIST = "for d in /etc/letsencrypt/live/*/cert.pem; do [ -f \"$d\" ] && echo \"$d\"; done 2>/dev/null";

// --------------------------------------------------------------- certs ---------------------------------------------------------------

test("certs: an expired certbot cert is high severity", async () => {
  const ctx = stubCtx({
    "command -v openssl 2>/dev/null": "/usr/bin/openssl\n",
    [LE_LIST]: "/etc/letsencrypt/live/example.com/cert.pem\n",
    "openssl x509 -in /etc/letsencrypt/live/example.com/cert.pem -noout -enddate 2>/dev/null": notAfter(-2) + "\n",
    "ss -tlnH 2>/dev/null": "",
  });
  const findings = await certs.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "high");
  assert.equal(findings[0].code, "certs/critical");
});

test("certs: a cert expiring in 3 days is high, in 20 days medium", async () => {
  const soon = stubCtx({
    "command -v openssl 2>/dev/null": "/usr/bin/openssl\n",
    [LE_LIST]: "/etc/letsencrypt/live/a.example/cert.pem\n",
    "openssl x509 -in /etc/letsencrypt/live/a.example/cert.pem -noout -enddate 2>/dev/null": notAfter(3) + "\n",
    "ss -tlnH 2>/dev/null": "",
  });
  const crit = await certs.run(soon);
  assert.equal(crit[0].code, "certs/critical");
  assert.equal(crit[0].severity, "high");

  const later = stubCtx({
    "command -v openssl 2>/dev/null": "/usr/bin/openssl\n",
    [LE_LIST]: "/etc/letsencrypt/live/b.example/cert.pem\n",
    "openssl x509 -in /etc/letsencrypt/live/b.example/cert.pem -noout -enddate 2>/dev/null": notAfter(20) + "\n",
    "ss -tlnH 2>/dev/null": "",
  });
  const warn = await certs.run(later);
  assert.equal(warn[0].code, "certs/expiring");
  assert.equal(warn[0].severity, "medium");
});

test("certs: a deployed cert on a listening 443 is checked live", async () => {
  const ctx = stubCtx({
    "command -v openssl 2>/dev/null": "/usr/bin/openssl\n",
    [LE_LIST]: "",
    "ss -tlnH 2>/dev/null": "LISTEN 0 128 0.0.0.0:443 0.0.0.0:*\n",
    "echo | openssl s_client -connect 127.0.0.1:443 -servername localhost 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null": notAfter(60) + "\n",
  });
  const findings = await certs.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "certs/ok");
});

test("certs: healthy certs report ok, nothing found stays silent", async () => {
  const ctx = stubCtx({
    "command -v openssl 2>/dev/null": "/usr/bin/openssl\n",
    [LE_LIST]: "/etc/letsencrypt/live/example.com/cert.pem\n",
    "openssl x509 -in /etc/letsencrypt/live/example.com/cert.pem -noout -enddate 2>/dev/null": notAfter(60) + "\n",
    "ss -tlnH 2>/dev/null": "",
  });
  const ok = await certs.run(ctx);
  assert.equal(ok[0].code, "certs/ok");

  const empty = stubCtx({
    "command -v openssl 2>/dev/null": "/usr/bin/openssl\n",
    [LE_LIST]: "",
    "ss -tlnH 2>/dev/null": "",
  });
  assert.equal((await certs.run(empty)).length, 0);

  const noOpenssl = stubCtx({});
  const skipped = await certs.run(noOpenssl);
  assert.equal(skipped[0].code, "certs/skipped", "a missing tool is an explicit skip, not silence");
});

// --------------------------------------------------------------- ports ---------------------------------------------------------------

test("ports: mysql on 0.0.0.0 with no firewall is medium", async () => {
  const ctx = stubCtx({
    "ss -tlnH 2>/dev/null": "LISTEN 0 128 0.0.0.0:3306 0.0.0.0:*\nLISTEN 0 128 127.0.0.1:5432 0.0.0.0:*\n",
    "systemctl is-active firewalld 2>/dev/null": "inactive\n",
    "systemctl is-active ufw 2>/dev/null": "inactive\n",
    "nft list ruleset 2>/dev/null | head -5": "",
  });
  const findings = await ports.run(ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.equal(findings[0].code, "ports/exposed-risky");
  assert.match(findings[0].detail, /MySQL/);
  assert.ok(!/PostgreSQL/.test(findings[0].detail), "loopback-bound postgres must not be flagged");
});

test("ports: an active firewall downgrades exposure to info", async () => {
  const ctx = stubCtx({
    "ss -tlnH 2>/dev/null": "LISTEN 0 128 0.0.0.0:6379 0.0.0.0:*\n",
    "systemctl is-active firewalld 2>/dev/null": "active\n",
    "systemctl is-active ufw 2>/dev/null": "inactive\n",
    "nft list ruleset 2>/dev/null | head -5": "",
  });
  const findings = await ports.run(ctx);
  assert.equal(findings[0].code, "ports/ok");
  assert.equal(findings[0].severity, "info");
});

test("ports: ordinary listeners report ok, empty table stays silent", async () => {
  const ctx = stubCtx({ "ss -tlnH 2>/dev/null": "LISTEN 0 128 0.0.0.0:443 0.0.0.0:*\nLISTEN 0 128 0.0.0.0:22 0.0.0.0:*\n" });
  assert.equal((await ports.run(ctx))[0].code, "ports/ok");
  assert.equal((await ports.run(stubCtx({ "ss -tlnH 2>/dev/null": "" }))).length, 0);
});

// ---------------------------------------------------------------- fds ----------------------------------------------------------------

test("fds: 95% file handles is high, 92% medium, healthy stays silent", async () => {
  assert.equal((await fds.run(stubCtx({ "cat /proc/sys/fs/file-nr 2>/dev/null": "9500 0 10000\n" })))[0].severity, "high");
  const med = await fds.run(stubCtx({ "cat /proc/sys/fs/file-nr 2>/dev/null": "9200 0 10000\n" }));
  assert.equal(med[0].code, "fds/exhausted");
  assert.equal(med[0].severity, "medium");
  assert.equal((await fds.run(stubCtx({ "cat /proc/sys/fs/file-nr 2>/dev/null": "1000 0 100000\n" }))).length, 0);
  assert.equal((await fds.run(stubCtx({}))).length, 0);
});

// ------------------------------------------------------------ backup/stale ------------------------------------------------------------

const BACKUP_BASE = {
  'for t in borg restic rclone duplicity timeshift pika-backup backintime deja-dup; do command -v "$t" 2>/dev/null; done': "/usr/bin/borg\n",
  "ls /etc/snapper/configs 2>/dev/null": "",
  "[ -f /etc/timeshift/timeshift.json ] && echo configured": "",
  "systemctl list-timers --all --no-pager 2>/dev/null | grep -iE 'backup|borg|restic|timeshift|snapper|pika|deja' | grep -oE '[A-Za-z0-9_.@-]+\\.timer' | sort -u": "borg-backup.timer\n",
};

test("backup/stale: a scheduled timer that never ran is medium", async () => {
  const ctx = stubCtx({
    ...BACKUP_BASE,
    "systemctl show borg-backup.timer -p LastTriggerUSec --value 2>/dev/null": "0\n",
    // 46 days up: "no trigger since boot" really is "never ran" here.
    "cat /proc/uptime 2>/dev/null": "4000000.00 12345.67\n",
  });
  const findings = await backup.run(ctx);
  const stale = findings.find((f) => f.code === "backup/stale");
  assert.ok(stale, "expected a backup/stale finding");
  assert.equal(stale.severity, "medium");
  assert.match(stale.detail, /never ran/);
});

test("backup/stale: a timer that has not fired since boot is not stale", async () => {
  // LastTriggerUSec is a runtime property: systemd resets it to 0 at boot for
  // a timer that is not Persistent=true, and fills it in at the first elapse.
  // Reading 0 as "never ran" flagged a healthy desktop every time it rebooted
  // before its daily timer fired.
  const ctx = stubCtx({
    ...BACKUP_BASE,
    "systemctl show borg-backup.timer -p LastTriggerUSec --value 2>/dev/null": "0\n",
    "cat /proc/uptime 2>/dev/null": "7200.00 12345.67\n", // 2 hours up
  });
  const findings = await backup.run(ctx);
  assert.ok(!findings.some((f) => f.code === "backup/stale"), "a fresh boot is not a broken backup");
  assert.ok(findings.some((f) => f.code === "backup/ok"));
});

test("backup/stale: unknown uptime is unknown, not stale", async () => {
  const ctx = stubCtx({
    ...BACKUP_BASE,
    "systemctl show borg-backup.timer -p LastTriggerUSec --value 2>/dev/null": "0\n",
    // no /proc/uptime stub: the value cannot be read
  });
  const findings = await backup.run(ctx);
  assert.ok(!findings.some((f) => f.code === "backup/stale"));
});

test("backup/stale: a timer that last ran 40 days ago is medium", async () => {
  const old = String((Date.now() - 40 * 86400000) * 1000);
  const ctx = stubCtx({ ...BACKUP_BASE, "systemctl show borg-backup.timer -p LastTriggerUSec --value 2>/dev/null": old + "\n" });
  const stale = (await backup.run(ctx)).find((f) => f.code === "backup/stale");
  assert.ok(stale);
  assert.match(stale.detail, /40 days ago/);
});

test("backup/stale: a recently-run timer keeps backup/ok", async () => {
  const recent = String(Date.now() * 1000);
  const ctx = stubCtx({ ...BACKUP_BASE, "systemctl show borg-backup.timer -p LastTriggerUSec --value 2>/dev/null": recent + "\n" });
  const findings = await backup.run(ctx);
  assert.ok(findings.some((f) => f.code === "backup/ok"));
  assert.ok(!findings.some((f) => f.code === "backup/stale"));
});

test("backup/stale: unreadable trigger state never cries stale", async () => {
  const ctx = stubCtx(BACKUP_BASE); // systemctl show fails → unknown, not stale
  const findings = await backup.run(ctx);
  assert.ok(findings.some((f) => f.code === "backup/ok"));
});

test("fds: per-process pressure is caught when file-max is effectively unlimited", async () => {
  const ctx = stubCtx({
    "cat /proc/sys/fs/file-nr 2>/dev/null": "11671 0 9223372036854775807\n",
    'for p in /proc/[0-9]*; do n=$(ls "$p/fd" 2>/dev/null | wc -l); [ "$n" -gt 0 ] && echo "$n ${p##*/}"; done | sort -rn | head -3': "950 4242\n10 1\n",
    "head -40 /proc/4242/limits 2>/dev/null": "Limit                     Soft Limit           Hard Limit           Units\nMax open files            1024                 1048576              files\n",
    "cat /proc/4242/comm 2>/dev/null": "postgres\n",
  });
  const findings = await fds.run(ctx);
  assert.equal(findings.length, 1, "expected one finding");
  assert.equal(findings[0].code, "fds/exhausted");
  assert.equal(findings[0].severity, "high");
  assert.match(findings[0].title, /postgres/);
  assert.match(findings[0].evidence, /950\/1024/);
});
