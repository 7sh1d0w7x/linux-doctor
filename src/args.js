// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Strict CLI argument parsing. Unknown options, unexpected positional
 * arguments, and value flags without a value are errors (exit 2) — a silent
 * typo like `--jsonn` must never quietly run a full report.
 */
export const VALUE_FLAGS = new Set(["--check", "--ignore", "--ignore-code", "--ignore-add", "--ignore-remove", "--push", "--html", "--md", "--severity", "--compare", "--alert", "--heartbeat", "--interval", "--thresholds-set"]);
export const BOOL_FLAGS = new Set(["--json", "--plain", "--web", "--ai", "--ai-local", "--list", "--schema", "--profile", "--ignore-list", "--ignore-list-json", "--summary", "--init", "--init-config", "--check-list", "--history-json", "--thresholds-json", "--todo", "--self-test", "--license", "--daemon", "--support", "--no-history", "--fix", "--yes", "--interactive", "--notify", "--history-clear", "--install-timer", "--uninstall-timer", "--allow-private-endpoint", "--debug"]);

export function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    help: false,
    version: false,
    list: false,
    schema: false,
    profile: false,
    json: false,
    plain: false,
    web: false,
    ai: false,
    aiLocal: false,
    checkIds: [],
    ignore: [],
    ignoreCodes: [],
    severity: null,
    ignoreList: false,
    ignoreListJson: false,
    pushUrl: null,
    htmlPath: null,
    mdPath: null,
    summary: false,
    init: false,
    initConfig: false,
    checkList: false,
    comparePath: null,
    todo: false,
    selfTest: false,
    license: false,
    alertUrl: null,
    heartbeatUrl: null,
    daemon: false,
    interval: null,
    support: false,
    noHistory: false,
    fix: false,
    yes: false,
    interactive: false,
    notify: false,
    ignoreAdd: null,
    ignoreRemove: null,
    historyJson: false,
    historyClear: false,
    thresholdsJson: false,
    thresholdsSet: null,
    installTimer: false,
    uninstallTimer: false,
    allowPrivateEndpoint: false,
    debug: false,
    error: null,
  };

  // --help/--version always win, even when other flags are wrong.
  if (args.includes("--help") || args.includes("-h")) return { ...out, help: true };
  if (args.includes("--version")) return { ...out, version: true };

  const assign = (flag, val) => {
    if (flag === "--check") out.checkIds.push(...val.split(",").map((s) => s.trim()).filter(Boolean));
    else if (flag === "--ignore") out.ignore.push(val);
    else if (flag === "--ignore-add") out.ignoreAdd = val;
    else if (flag === "--ignore-remove") out.ignoreRemove = val;
    else if (flag === "--thresholds-set") out.thresholdsSet = val;
    else if (flag === "--ignore-code") out.ignoreCodes.push(...val.split(",").map((s) => s.trim()).filter(Boolean));
    else if (flag === "--severity") out.severity = val.toLowerCase();
    else if (flag === "--push") out.pushUrl = val;
    else if (flag === "--html") out.htmlPath = val;
    else if (flag === "--md") out.mdPath = val;
    else if (flag === "--compare") out.comparePath = val;
    else if (flag === "--alert") out.alertUrl = val;
    else if (flag === "--heartbeat") out.heartbeatUrl = val;
    else if (flag === "--interval") out.interval = val;
  };

  const example = (flag) =>
    flag === "--push" ? "https://your-server/reports"
      : flag === "--check" ? "memory,disk"
      : flag === "--severity" ? "high"
      : flag === "--compare" ? "report.json"
      : flag === "--alert" ? "https://ntfy.sh/your-topic"
      : flag === "--heartbeat" ? "https://hc-ping.com/your-uuid"
      : flag === "--interval" ? "3600"
      : flag === "--ignore-add" ? "services/failed"
      : flag === "--ignore-remove" ? "fw-fanctrl"
      : flag === "--thresholds-set" ? '\'{"memory.warn":90}\''
      : flag === "--md" ? "report.md"
      : "fw-fanctrl";

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];

    if (BOOL_FLAGS.has(a)) {
      // Convert --ignore-list → ignoreList (camelCase for JS access)
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[key] = true;
      continue;
    }

    // --flag=value form
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    if (eq > 0) {
      const flag = a.slice(0, eq);
      if (!VALUE_FLAGS.has(flag)) {
        return { ...out, error: `Unknown option "${a}". Run "linux-doctor --help" for usage.` };
      }
      const val = a.slice(eq + 1);
      if (!val) {
        return { ...out, error: `${flag} requires a value, e.g. ${flag} ${example(flag)}` };
      }
      assign(flag, val);
      continue;
    }

    if (VALUE_FLAGS.has(a)) {
      const val = args[i + 1];
      if (val === undefined || val.startsWith("--")) {
        return { ...out, error: `${a} requires a value, e.g. ${a} ${example(a)}` };
      }
      assign(a, val);
      i += 1;
      continue;
    }

    if (a.startsWith("-")) {
      return { ...out, error: `Unknown option "${a}". Run "linux-doctor --help" for usage.` };
    }
    return { ...out, error: `Unexpected argument "${a}". Run "linux-doctor --help" for usage.` };
  }
  return out;
}
