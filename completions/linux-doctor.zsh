#compdef linux-doctor

_linux_doctor_check_ids() {
  local -a ids
  ids=(${(f)"$(linux-doctor --list 2>/dev/null | grep -oP '^\s+\K[a-z][a-z0-9-]+(?=\s+—)' 2>/dev/null)"})
  _describe 'check id' ids
}

_linux_doctor() {
  _arguments \
    '--check=[run specific check(s), comma-separated]:check id:_linux_doctor_check_ids' \
    '--list[list available checks]' \
    '--json[print findings as JSON]' \
    '--plain[print plain tab-separated text]' \
    '--web[open visual dashboard in browser]' \
    '--ai[add AI summary (needs LLM_API_KEY)]' \
    '--ai-local[use a local Ollama model, fully private]' \
    '--push=[post report to fleet server]:url:' \
    '--html=[save a standalone HTML report]:file:_files' \
    '--md=[save a share-ready Markdown report (redacted)]:file:_files' \
    '--compare=[diff against a previous JSON report]:file:_files' \
    '--severity=[only findings at this severity]:severity:(high medium info)' \
    '--ignore=[hide findings by title]:pattern:' \
    '--ignore-code=[hide findings by stable code]:code:' \
    '--ignore-add=[persistently ignore a code or title fragment]:value:' \
    '--ignore-remove=[remove a previously ignored code or title fragment]:value:' \
    '--ignore-list[show configured ignore patterns]' \
    '--ignore-list-json[show ignore patterns as JSON]' \
    '--summary[one-line score + severity counts]' \
    '--todo[numbered fix list, ordered by severity]' \
    '--fix[dry run: show safe-fix commands for the findings]' \
    "--yes[with --fix: execute the [apply] safe-fix commands]" \
    '--interactive[browse findings in an interactive terminal UI]' \
    '--notify[desktop notification when new issues appear]' \
    '--self-test[explain the environment]' \
    '--init[guided first-run setup]' \
    '--init-config[create a starter config file]' \
    '--check-list[list checks as JSON]' \
    '--history-json[print run history as JSON]' \
    '--history-clear[clear stored run history]' \
    '--thresholds-json[print thresholds as JSON]' \
    "--thresholds-set=[merge thresholds from a JSON payload]:json:" \
    '--schema[print the JSON Schema]' \
    '--profile[show check durations]' \
    '--license[show Pro add-on status]' \
    '--alert=[POST an alert webhook]:url:' \
    '--heartbeat=[ping a dead-man switch after every run]:url:' \
    '--allow-private-endpoint[allow --push/--alert/--heartbeat/--ai to target private/LAN addresses]' \
    '--debug[trace every command and its result to stderr]' \
    '--daemon[run continuously as a scheduled agent]' \
    '--interval=[seconds between --daemon runs]:seconds:' \
    '--support[write a privacy-safe support bundle (JSON)]' \
    '--no-history[do not read or write run history]' \
    '--install-timer[install the user systemd timer (daily + --notify)]' \
    '--uninstall-timer[remove the user systemd timer]' \
    '--help[show help]' \
    '--version[show version]' \
    '*:: :->args'
}

if [[ "$funcstack[1]" == "_linux_doctor" ]]; then
  _linux_doctor "$@"
fi