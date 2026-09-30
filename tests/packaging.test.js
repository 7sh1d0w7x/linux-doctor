// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("npm package ships every file the runtime reads", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const files = pkg.files;
  // src/web.js reads ../src-gui/index.html at import time. If that file is
  // not in "files", the published npm package crashes on EVERY invocation
  // (cli.js imports web.js unconditionally), not just with --web.
  assert.ok(files.includes("src-gui/index.html"), "src-gui/index.html must be shipped in the npm package");
  assert.ok(files.includes("bin"), "bin must be shipped");
  assert.ok(files.includes("src"), "src must be shipped");
  assert.ok(files.includes("README.md"), "README.md must be shipped");
  assert.ok(files.includes("LICENSE"), "LICENSE must be shipped");
  // The README links the dual-license docs; a published tarball without them
  // ships a README with broken links (and hides the commercial-license option).
  assert.ok(files.includes("COMMERCIAL-LICENSE.md"), "COMMERCIAL-LICENSE.md must be shipped");
  assert.ok(files.includes("CONTRIBUTING.md"), "CONTRIBUTING.md must be shipped");
});

test("web.js' dashboard page exists on disk", () => {
  const page = join(root, "src-gui", "index.html");
  assert.doesNotThrow(() => readFileSync(page, "utf8"), "src-gui/index.html must exist");
});

test("the desktop binary does not shadow the CLI in /usr/bin", () => {
  // The CLI installs /usr/bin/linux-doctor (npm, AUR, OBS). The deb/rpm used to
  // install the GUI under the same name, so installing both overwrote one with
  // the other (issue #39). The GUI binary must be distinct.
  const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  assert.ok(conf.mainBinaryName, "the GUI must pin a distinct mainBinaryName");
  assert.notEqual(conf.mainBinaryName, "linux-doctor", "the GUI binary must not be named 'linux-doctor'");
});

test("the desktop template's StartupWMClass tracks the binary name", () => {
  // It was hardcoded to linux-doctor; the GUI binary is linux-doctor-app now, so
  // the window would not be matched to its launcher (a duplicate dock icon).
  const tpl = readFileSync(join(root, "packaging", "desktop-template.desktop"), "utf8");
  assert.match(tpl, /^StartupWMClass=\{\{exec\}\}$/m, "StartupWMClass must follow {{exec}}");
});

test("no .desktop uses an unregistered category", () => {
  // desktop-file-validate errors on "Diagnostics", which is not a freedesktop
  // category; it was shipped in packaging/linux-doctor.desktop.
  for (const name of ["desktop-template.desktop", "linux-doctor.desktop", "com.zshadow7x.linuxdoctor.desktop"]) {
    const s = readFileSync(join(root, "packaging", name), "utf8");
    const m = s.match(/^Categories=(.*)$/m);
    if (!m) continue;
    assert.ok(!/\bDiagnostics\b/.test(m[1]), `${name} has the unregistered category Diagnostics`);
  }
});

test("no .desktop lists two main categories", () => {
  // System and Utility are both main categories; a file with both makes the app
  // appear twice in the menu (a desktop-file-validate hint). Monitor is an
  // additional category under System, so System;Monitor; is the correct pair.
  const MAIN = new Set(["AudioVideo", "Development", "Education", "Game", "Graphics", "Network", "Office", "Science", "Settings", "System", "Utility"]);
  for (const name of ["desktop-template.desktop", "linux-doctor.desktop", "com.zshadow7x.linuxdoctor.desktop"]) {
    const s = readFileSync(join(root, "packaging", name), "utf8");
    const m = s.match(/^Categories=(.*)$/m);
    if (!m) continue;
    const mains = m[1].split(";").filter((c) => MAIN.has(c));
    assert.ok(mains.length <= 1, `${name} lists ${mains.length} main categories: ${mains.join(", ")}`);
  }
});
