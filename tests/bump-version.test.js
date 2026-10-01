// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Guard for scripts/bump-version.mjs.
 *
 * The release script lists every manifest path as a string literal and dies at
 * the first one that has moved. That is not hypothetical: the AUR files were
 * reorganised into packaging/aur/ and the script kept pointing at
 * packaging/PKGBUILD, so a release stopped halfway through and left the RPM
 * spec and the docs regeneration un-run, silently.
 *
 * This reads the paths out of the script and checks they exist, which is the
 * failure it would have caught.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { addRelease } from "../scripts/bump-appstream.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(ROOT, "scripts", "bump-version.mjs"), "utf8");

const paths = [...source.matchAll(/bump(?:Json|Text)\(\s*"([^"]+)"/g)].map((m) => m[1]);

test("bump-version: every manifest it rewrites exists", () => {
  assert.ok(paths.length >= 6, "expected the script to list its manifests");
  const missing = paths.filter((p) => !existsSync(join(ROOT, p)));
  assert.deepEqual(
    missing,
    [],
    `scripts/bump-version.mjs points at paths that no longer exist:\n  ${missing.join("\n  ")}`,
  );
});

test("bump-version: the AUR pair is bumped together", () => {
  // PKGBUILD and .SRCINFO must carry the same pkgver, or makepkg and the AUR
  // both reject the pair. A script that rewrites one without the other is the
  // bug this file exists for.
  const pkgbuild = paths.filter((p) => p.endsWith("PKGBUILD"));
  const srcinfo = paths.filter((p) => p.endsWith(".SRCINFO"));
  assert.equal(pkgbuild.length, 1, "PKGBUILD must be bumped");
  assert.equal(srcinfo.length, 1, ".SRCINFO must be bumped alongside it");
});

const METAINFO = "packaging/com.zshadow7x.linuxdoctor.metainfo.xml";
const RELEASES = `  <releases>
    <release version="0.6.0" date="2026-09-13">
      <url>https://github.com/7sh1d0w7x/linux-doctor/releases/tag/v0.6.0</url>
    </release>
  </releases>
</component>
`;


test("bump-version: both RPM specs are bumped", () => {
  // The OBS spec lives under packaging/obs/ and was not in the script's list,
  // so 0.7.1 shipped with an OBS spec still on 0.6.0.
  assert.ok(paths.includes("packaging/linux-doctor.spec"), "the git rpm spec");
  assert.ok(paths.includes("packaging/obs/linux-doctor.spec"), "the OBS spec");
});

test("bump-version: the AUR .SRCINFO source carries the current version", () => {
  // pkgver was bumped but the source line stayed on v0.6.0, so pkgver 0.7.1 sat
  // next to an old tarball — makepkg and the AUR reject the pair.
  assert.ok(
    source.includes("source = linux-doctor-${version}.tar.gz::"),
    "the script must rewrite the .SRCINFO source line, or pkgver and source drift",
  );
  const src = readFileSync(join(ROOT, "packaging/aur/.SRCINFO"), "utf8");
  const pkgver = src.match(/pkgver = ([\d.]+)/)[1];
  assert.ok(src.includes(`linux-doctor-${pkgver}.tar.gz`), `.SRCINFO source must match pkgver ${pkgver}`);
});

test("bump-version: the AppStream release list is bumped too", () => {
  // It drifted silently: after 0.6.1 the packaged metadata still advertised
  // 0.6.0, which app stores and appstreamcli read.
  assert.ok(paths.includes(METAINFO), "the metainfo must be in the script's file list");

  const out = addRelease(RELEASES, "0.7.0", "2026-09-22");
  assert.match(out, /<release version="0\.7\.0" date="2026-09-22">/);
  assert.match(out, /releases\/tag\/v0\.7\.0/);
  // newest first, and the previous entry kept
  assert.ok(out.indexOf('version="0.7.0"') < out.indexOf('version="0.6.0"'), "newest release goes first");
  assert.equal(out.split("</releases>").length, 2, "the section is not duplicated");
  // everything else in the file is untouched
  assert.ok(out.endsWith("</component>\n"));
});

test("bump-version: adding an existing release changes nothing", () => {
  const once = addRelease(RELEASES, "0.7.0", "2026-09-22");
  assert.equal(addRelease(once, "0.7.0", "2026-09-22"), once, "re-running must not duplicate the entry");
});

test("bump-version: a metainfo without <releases> is a hard error, not a silent skip", () => {
  assert.throws(() => addRelease("<component></component>", "0.7.0", "2026-09-22"), /no <releases> section/);
});

test("bump-version: the real metainfo lists a release (so the file is not silently empty)", () => {
  const xml = readFileSync(join(ROOT, METAINFO), "utf8");
  assert.match(xml, /<releases>\s*\n\s*<release version="/, "the shipped metainfo must carry a release entry");
});
