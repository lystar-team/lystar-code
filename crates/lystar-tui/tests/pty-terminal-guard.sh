#!/usr/bin/env bash
set -euo pipefail

binary=${1:-target/release/lystar-tui}
socket="lystar-rust-b0-$$"
root=$(mktemp -d)
trap 'tmux -L "$socket" kill-server 2>/dev/null || true; rm -rf "$root"' EXIT

run_case() {
  local name=$1
  local mode=$2
  local signal=${3:-}
  local width=${4:-80}
  local height=${5:-8}
  local case_dir="$root/$name"
  mkdir -p "$case_dir"
  local command
  case "$mode" in
    eof) command="exec 3</dev/null; '$binary' --shell-pipe" ;;
    panic) command="'$binary' --shell-panic" ;;
    shell) command="'$binary' --shell & child=\$!; echo \$child > '$case_dir/pid'; wait \$child" ;;
    *) exit 2 ;;
  esac
  tmux -L "$socket" new-session -d -s "$name" -x "$width" -y "$height" \
    "bash -lc 'sleep 0.2; before=\$(stty -g); printf %s \"\$before\" > \"$case_dir/before\"; set +e; $command; status=\$?; after=\$(stty -g); printf %s \"\$after\" > \"$case_dir/after\"; printf %s \"\$status\" > \"$case_dir/status\"; exit \$status'"
  tmux -L "$socket" pipe-pane -o -t "$name" "cat > '$case_dir/output'"
  if [[ -n "$signal" ]]; then
    for _ in {1..100}; do [[ -s "$case_dir/pid" ]] && break; sleep 0.02; done
    kill -"$signal" "$(cat "$case_dir/pid")"
  fi
  for _ in {1..250}; do [[ -f "$case_dir/after" ]] && break; sleep 0.02; done
  [[ -f "$case_dir/after" ]]
  [[ "$(cat "$case_dir/before")" == "$(cat "$case_dir/after")" ]]
  local status
  status=$(cat "$case_dir/status")
  case "$name" in
    eof) [[ "$status" == 1 ]] ;;
    panic) [[ "$status" == 101 ]] ;;
    sigint|sigterm) [[ "$status" == 0 ]] ;;
  esac
  tail -c 2048 "$case_dir/output" | grep -aFq $'\033[?25h'
  tail -c 2048 "$case_dir/output" | grep -aFq $'\033[?1049l'
  tail -c 2048 "$case_dir/output" | grep -aFq $'\033[?1000l'
  printf '%s status=%s stty=restored\n' "$name" "$status"
}

run_case eof eof "" 80 8
run_case panic panic "" 80 24
run_case sigint shell INT 120 36
run_case sigterm shell TERM 200 60
