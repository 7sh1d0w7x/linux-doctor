#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Bump version in all manifests atomically.
 * Usage: node scripts/bump-version.mjs 0.3.5
 *
 * Updates:
 *  - package.json
 *  - package-lock.json (root + packages."")
 *  - src-tauri/Cargo.toml
 *  - src-tauri/tauri.conf.json
 *  - packaging/linux-doctor.1  (.TH date + version)
 *  - packaging/PKGBUILD  (pkgver + sha256sums=SKIP)
 *  - packaging/linux-doctor.spec and packaging/obs/linux-doctor.spec  (Version + %changelog)
 *  - packaging/aur/.SRCINFO  (pkgver + source + sha256sums)
 *  - packaging/com.zshadow7x.linuxdoctor.metainfo.xml  (AppStream releases)
 * Then regenerates docs/checks.md
 */

import { readFileSync, writeFileSync } from "node:fs";
import { addRelease } from "./bump-appstream.mjs";
import { execSync } from "node:child_process";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("Usage: node scripts/bump-version.mjs <version>  (e.g. 0.3.5)");
  process.exit(2);
}

const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

function bumpJson(path, updater) {
  const raw = readFileSync(path, "utf8");
  const data = JSON.parse(raw);
  updater(data);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  console.log(`✓ ${path} -> ${version}`);
}

function bumpText(path, replacer) {
  const raw = readFileSync(path, "utf8");
  const next = replacer(raw);
  if (raw === next) {
    console.warn(`⚠ ${path}: no change (pattern not found)`);
  } else {
    writeFileSync(path, next);
    console.log(`✓ ${path} -> ${version}`);
  }
}

// 1. package.json
bumpJson("package.json", (j) => { j.version = version; });

// 2. package-lock.json (two places)
bumpJson("package-lock.json", (j) => {
  j.version = version;
  if (j.packages && j.packages[""]) j.packages[""].version = version;
});

// 3. src-tauri/Cargo.toml  ->  version = "x.y.z"
bumpText("src-tauri/Cargo.toml", (s) =>
  s.replace(/^version = ".*"/m, `version = "${version}"`)
);

// 3b. src-tauri/Cargo.lock — `cargo --locked` (CI clippy/build) fails if the
// package's own recorded version drifts from Cargo.toml.
bumpText("src-tauri/Cargo.lock", (s) =>
  s.replace(/(name = "linux-doctor"\r?\nversion = ")[^"]*(")/, `$1${version}$2`)
);

// 4. src-tauri/tauri.conf.json
bumpJson("src-tauri/tauri.conf.json", (j) => { j.version = version; });

// 5. packaging/linux-doctor.1  -> .TH LINUX-DOCTOR 1 "YYYY-MM-DD" "linux-doctor X.Y.Z"
bumpText("packaging/linux-doctor.1", (s) =>
  s.replace(/^\.TH LINUX-DOCTOR 1 ".*?" "linux-doctor .*?"/m, `.TH LINUX-DOCTOR 1 "${date}" "linux-doctor ${version}"`)
);

// 6. packaging/aur/PKGBUILD  -> pkgver=X.Y.Z + pkgrel=1 + sha256sums=('SKIP')
bumpText("packaging/aur/PKGBUILD", (s) => {
  let out = s.replace(/^pkgver=.*$/m, `pkgver=${version}`);
  out = out.replace(/^pkgrel=.*$/m, "pkgrel=1");
  // reset hash to SKIP — real hash is computed from the published tarball
  out = out.replace(/^sha256sums=\(.*?\)/m, `sha256sums=('SKIP')`);
  return out;
});

// 6b. packaging/aur/.SRCINFO must match the PKGBUILD, or makepkg and the AUR
// both reject the pair. Regenerated from PKGBUILD after the real hash is known;
// until then both files carry SKIP.
bumpText("packaging/aur/.SRCINFO", (s) => {
  let out = s.replace(/^\tpkgver = .*$/m, `\tpkgver = ${version}`);
  out = out.replace(/^\tpkgrel = .*$/m, "\tpkgrel = 1");
  out = out.replace(/^\tsha256sums = .*$/m, "\tsha256sums = SKIP");
  // The source line embeds the version too. It stayed on the old one, leaving
  // pkgver 0.7.1 next to a v0.6.0 tarball, which makepkg and the AUR reject.
  out = out.replace(
    /^\tsource = .*$/m,
    `\tsource = linux-doctor-${version}.tar.gz::https://github.com/7sh1d0w7x/linux-doctor/archive/refs/tags/v${version}.tar.gz`,
  );
  return out;
});

// 7. RPM specs (git + OBS) -> Version: X.Y.Z + add %changelog entry. The OBS
// spec was missed entirely and shipped 0.7.1 with a 0.6.0 Version.
const specBump = (s) => {
  let out = s.replace(/^Version:\s+.*$/m, `Version:        ${version}`);
  // Add changelog entry if not already present for this version
  const tag = `${version}-1`;
  if (!out.includes(tag)) {
    const entry = `* ${new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "2-digit", year: "numeric" })} 7sh1d0w7x <zshadow7x@users.noreply.github.com> - ${tag}\n- Sync to ${version}\n`;
    out = out.replace(/^%changelog/m, `%changelog\n${entry}`);
  }
  return out;
};
bumpText("packaging/linux-doctor.spec", specBump);
bumpText("packaging/obs/linux-doctor.spec", specBump);

// 8. packaging/com.zshadow7x.linuxdoctor.metainfo.xml — the AppStream
// <releases> list is read by app stores and appstreamcli, and it used to drift:
// after 0.6.1 the file still advertised 0.6.0. Newest entry first, idempotent.
bumpText("packaging/com.zshadow7x.linuxdoctor.metainfo.xml", (s) => addRelease(s, version, date));

// 9. Regenerate derived docs
console.log("\n→ Regenerating docs/checks.md ...");
try {
  execSync("node scripts/generate-check-docs.mjs", { stdio: "inherit" });
} catch (e) {
  console.error("Failed to regenerate docs/checks.md", e.message);
  process.exit(1);
}

console.log(`\n✓ All manifests bumped to ${version} (${date})`);
console.log(`  Next: git diff  &&  npm test  &&  git commit -am "chore: bump to ${version}"`);
