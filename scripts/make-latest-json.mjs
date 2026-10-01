#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Build the Tauri updater manifest (`latest.json`) from signed bundles.
 *
 * Tauri's CLI produces `<artifact>` + `<artifact>.sig` when
 * `bundle.createUpdaterArtifacts` is on and TAURI_SIGNING_PRIVATE_KEY is set;
 * it does NOT write latest.json (that is tauri-action's job). This repo uses a
 * plain `npx tauri build`, so we assemble the manifest ourselves for the
 * endpoint configured in src-tauri/tauri.conf.json.
 *
 * On Linux the updatable artifact is the AppImage; deb/rpm users update through
 * their package manager, so only the AppImage is listed.
 *
 * Usage:
 *   node scripts/make-latest-json.mjs <bundle-dir> <version> <tag> <owner/repo> [out]
 * e.g.
 *   node scripts/make-latest-json.mjs src-tauri/target/release/bundle 0.6.0 v0.6.0 7sh1d0w7x/linux-doctor
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const [dir, version, tag, repo, outArg] = process.argv.slice(2);
if (!dir || !version || !tag || !repo) {
  console.error("usage: make-latest-json.mjs <bundle-dir> <version> <tag> <owner/repo> [out]");
  process.exit(2);
}

/** The release workflow normalizes spaces in asset names. */
const assetName = (f) => basename(f).replaceAll(" ", ".");

/** All files under `root`, recursively (Tauri nests bundle/appimage/, bundle/deb/…). */
function walk(root) {
  const out = [];
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function findArtifact() {
  if (!existsSync(dir)) return null;
  // Prefer the updater's tar.gz when present, else the AppImage itself;
  // both are signed as `<name>.sig`.
  const candidates = walk(dir).filter((p) => /\.AppImage(\.tar\.gz)?$/.test(p));
  for (const p of candidates) {
    if (existsSync(`${p}.sig`)) {
      return { file: p, sigFile: `${p}.sig` };
    }
  }
  return null;
}

const found = findArtifact();
if (!found) {
  console.error(`no signed AppImage found under ${dir} — is TAURI_SIGNING_PRIVATE_KEY set?`);
  process.exit(1);
}

/**
 * The changelog section for this version, for the in-app update dialog.
 *
 * RELEASE_NOTES used to be the only source and the release workflow never set
 * it, so the updater always showed an empty "what's new" while the GitHub
 * release had the section. Read it from CHANGELOG.md instead; an explicit
 * RELEASE_NOTES still wins so a hotfix release can override the text.
 */
function notesFromChangelog(v) {
  const path = process.env.LINUX_DOCTOR_CHANGELOG || join(dirname(fileURLToPath(import.meta.url)), "..", "CHANGELOG.md");
  if (!existsSync(path)) return "";
  const lines = readFileSync(path, "utf8").split("\n");
  const start = lines.findIndex((l) => new RegExp(`^## \\[${v.replace(/\./g, "\\.")}\\]`).test(l));
  if (start < 0) return "";
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^## \[/.test(line)) break; // next version (Unreleased or older)
    body.push(line);
  }
  return body.join("\n").trim();
}

const signature = readFileSync(found.sigFile, "utf8").trim();
const name = assetName(found.file);
const manifest = {
  version,
  notes: process.env.RELEASE_NOTES || notesFromChangelog(version),
  pub_date: new Date().toISOString(),
  platforms: {
    "linux-x86_64": {
      signature,
      url: `https://github.com/${repo}/releases/download/${tag}/${name}`,
    },
  },
};

const out = outArg || join(dir, "latest.json");
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${out} → ${name} (${version})`);
