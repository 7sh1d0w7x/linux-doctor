// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Plugin checks: any .js file in the plugin directory is loaded as a check.
 * This lets sysadmins add checks without forking the project — the killer
 * feature for custom environments. A plugin file must export (default or
 * named) an object shaped like a built-in check: { id, title, category?,
 * appliesTo?, async run(ctx) }.
 *
 * The directory is `~/.config/linux-doctor/checks/` (override with
 * LINUX_DOCTOR_PLUGINS). A broken plugin is reported to stderr and skipped —
 * it must never take down a run.
 *
 * `loadPluginEntries` keeps the source file next to each check so `--plugins`
 * can answer "which file does this check come from?" without re-reading the
 * directory. Loading stays one pass: `loadPlugins` is the check-only view.
 */
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ALL_KINDS } from "./checks/define.js";
import { pluginDir } from "./paths.js";

export { pluginDir };

/**
 * Load every plugin file and keep the provenance. Returns one entry per file:
 *
 *   { kind: "ok", name, file, check }        a usable check
 *   { kind: "invalid", name, file, warning } wrong export shape, skipped
 *   { kind: "error", name, file, warning }   threw while importing, skipped
 *
 * Never throws. A missing directory is an empty list.
 */
export async function loadPluginEntries(dir = pluginDir()) {
  const root = resolve(dir);
  let files;
  try {
    files = readdirSync(root).filter((f) => f.endsWith(".js"));
  } catch {
    return []; // no plugin directory — nothing to load
  }

  const entries = [];
  for (const name of files.sort()) {
    const file = join(root, name);
    try {
      const mod = await import(pathToFileURL(file).href);
      const check = mod.default ?? Object.values(mod)[0];
      if (check && typeof check.id === "string" && check.id.trim() !== "" && typeof check.run === "function") {
        // Normalize to the defineCheck shape so downstream code (gating,
        // --list) can assume category and appliesTo always exist.
        entries.push({
          kind: "ok",
          name,
          file,
          check: {
            ...check,
            category: check.category ?? "custom",
            appliesTo: Array.isArray(check.appliesTo) ? check.appliesTo : ALL_KINDS,
          },
        });
      } else {
        entries.push({
          kind: "invalid",
          name,
          file,
          warning: `linux-doctor: plugin ${name} does not export { id, run } — skipping`,
        });
      }
    } catch (err) {
      entries.push({
        kind: "error",
        name,
        file,
        warning: `linux-doctor: could not load plugin ${name}: ${err.message}`,
      });
    }
  }
  return entries;
}

/** Load every plugin in the directory as a check. Never throws. */
export async function loadPlugins(dir = pluginDir()) {
  const checks = [];
  for (const entry of await loadPluginEntries(dir)) {
    if (entry.check) checks.push(entry.check);
    else console.error(entry.warning);
  }
  return checks;
}
