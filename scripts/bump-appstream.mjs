// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * AppStream release entry for `packaging/com.zshadow7x.linuxdoctor.metainfo.xml`.
 *
 * Kept as a pure function, separate from scripts/bump-version.mjs, so the
 * insertion rule can be tested directly (that script runs on import).
 *
 * Why it exists: the metainfo carries a `<releases>` list that app stores and
 * `appstreamcli` read, and nothing updated it. After 0.6.1 shipped the file
 * still advertised 0.6.0, which is exactly the kind of metadata drift a
 * validator complains about ("release newer than the metadata"). The release
 * script updates it now, and tests/bump-version.test.js holds the rule.
 */
const RELEASE_URL = (version) => `https://github.com/7sh1d0w7x/linux-doctor/releases/tag/v${version}`;

/**
 * Insert a release entry at the top of `<releases>` (AppStream wants newest
 * first) with the same shape as the existing entries. Idempotent: an entry that
 * is already there is left alone, so re-running the bump cannot duplicate it.
 */
export function addRelease(xml, version, date) {
  const src = String(xml ?? "");
  if (src.includes(`<release version="${version}"`)) return src;

  const entry = `    <release version="${version}" date="${date}">\n      <url>${RELEASE_URL(version)}</url>\n    </release>\n`;
  if (!src.includes("  <releases>")) {
    throw new Error("metainfo has no <releases> section");
  }
  return src.replace("  <releases>\n", `  <releases>\n${entry}`);
}
