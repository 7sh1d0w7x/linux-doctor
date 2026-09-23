_linux_doctor_checks() {
  local checks
  checks=$(linux-doctor --list 2>/dev/null | grep -oP '^\s+\K[a-z][a-z0-9-]+(?=\s+—)' 2>/dev/null)
  COMPREPLY=($(compgen -W "$checks" -- "${COMP_WORDS[COMP_CWORD]}"))
}

_linux_doctor() {
  local cur="${COMP_WORDS[COMP_CWORD]}"
  local prev="${COMP_WORDS[COMP_CWORD-1]}"

  case "$prev" in
    --check)
      _linux_doctor_checks
      return
      ;;
    --severity)
      COMPREPLY=($(compgen -W "high medium info" -- "$cur"))
      return
      ;;
    --interval)
      COMPREPLY=($(compgen -W "300 600 1800 3600 7200" -- "$cur"))
      return
      ;;
  esac

  if [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "--check --ignore --ignore-code --ignore-add --ignore-remove --push --html --md --severity --compare --alert --heartbeat --interval --json --plain --web --ai --ai-local --list --schema --profile --ignore-list --ignore-list-json --summary --init --init-config --check-list --history-json --history-clear --thresholds-json --thresholds-set --todo --fix --yes --interactive --notify --self-test --license --daemon --support --no-history --install-timer --uninstall-timer --allow-private-endpoint --debug --help --version" -- "$cur"))
  fi
}

complete -F _linux_doctor linux-doctor