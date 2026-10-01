// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The updater manifest is assembled by scripts/make-latest-json.mjs (the Tauri
 * CLI does not write it). Pinned here with synthetic signed artifacts, placed
 * in the nested layout the bundler actually produces (bundle/appimage/…).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "make-latest-json.mjs");

test("make-latest-json: finds the signed AppImage in the nested bundle layout", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-upd-"));
  try {
    const appimage = join(dir, "appimage");
    mkdirSync(appimage);
    writeFileSync(join(appimage, "Linux Doctor_0.6.0_amd64.AppImage"), "appimage");
    writeFileSync(join(appimage, "Linux Doctor_0.6.0_amd64.AppImage.sig"), "SIGCONTENT\n");
    execFileSync("node", [SCRIPT, dir, "0.6.0", "v0.6.0", "7sh1d0w7x/linux-doctor"], { stdio: "pipe" });
    const m = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
    assert.equal(m.version, "0.6.0");
    assert.equal(m.platforms["linux-x86_64"].signature, "SIGCONTENT");
    assert.match(m.platforms["linux-x86_64"].url, /\/v0\.6\.0\/Linux\.Doctor_0\.6\.0_amd64\.AppImage$/);
    assert.match(m.pub_date, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("make-latest-json: fails clearly when no signed artifact exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-upd-"));
  try {
    const appimage = join(dir, "appimage");
    mkdirSync(appimage);
    writeFileSync(join(appimage, "Linux.Doctor_0.6.0_amd64.AppImage"), "appimage"); // no .sig
    assert.throws(() => execFileSync("node", [SCRIPT, dir, "0.6.0", "v0.6.0", "o/r"], { stdio: "pipe" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("make-latest-json: the updater notes come from the CHANGELOG for that version", () => {
  // The in-app update dialog reads latest.json's notes. They were always empty
  // because the script only looked at RELEASE_NOTES, which the release workflow
  // never sets — the GitHub release got the changelog section, the updater got
  // nothing. Read the section for this version when no override is given.
  const dir = mkdtempSync(join(tmpdir(), "ld-upd-"));
  try {
    const appimage = join(dir, "appimage");
    mkdirSync(appimage);
    writeFileSync(join(appimage, "Linux Doctor_0.7.0_amd64.AppImage"), "appimage");
    writeFileSync(join(appimage, "Linux Doctor_0.7.0_amd64.AppImage.sig"), "SIG\n");
    const changelog = join(dir, "CHANGELOG.md");
    writeFileSync(changelog, [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "- a thing that has not shipped",
      "",
      "## [0.7.0] - 2026-09-22",
      "",
      "### Fixed",
      "",
      "- the thing that changed",
      "",
      "## [0.6.1] - 2026-09-17",
      "",
      "- old news",
      "",
    ].join("\n"));
    execFileSync("node", [SCRIPT, dir, "0.7.0", "v0.7.0", "o/r"], {
      stdio: "pipe",
      env: { ...process.env, LINUX_DOCTOR_CHANGELOG: changelog, RELEASE_NOTES: "" },
    });
    const m = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
    assert.match(m.notes, /the thing that changed/, "the update dialog must say what changed");
    assert.ok(!/has not shipped/.test(m.notes), "must not leak the Unreleased section");
    assert.ok(!/old news/.test(m.notes), "must stop at the next version heading");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("make-latest-json: an explicit RELEASE_NOTES still wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-upd-"));
  try {
    const appimage = join(dir, "appimage");
    mkdirSync(appimage);
    writeFileSync(join(appimage, "Linux Doctor_0.7.0_amd64.AppImage"), "appimage");
    writeFileSync(join(appimage, "Linux Doctor_0.7.0_amd64.AppImage.sig"), "SIG\n");
    execFileSync("node", [SCRIPT, dir, "0.7.0", "v0.7.0", "o/r"], {
      stdio: "pipe",
      env: { ...process.env, RELEASE_NOTES: "typed by hand", LINUX_DOCTOR_CHANGELOG: "/nonexistent" },
    });
    const m = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
    assert.equal(m.notes, "typed by hand");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
