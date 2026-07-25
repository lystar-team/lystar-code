#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export HOME="$tmp/home"
install_root="$HOME/.local/share/lystar-agent"
bin_dir="$HOME/.local/bin"
mkdir -p "$install_root/versions/1.0.0-lystar.1" "$install_root/versions/1.0.0-lystar.2" "$bin_dir" "$HOME/.pi/agent"
ln -s "versions/1.0.0-lystar.2" "$install_root/current"
ln -s "versions/1.0.0-lystar.1" "$install_root/previous"
touch "$HOME/.pi/agent/settings.json"

bash "$ROOT/scripts/install.sh" --rollback >/dev/null
[[ "$(readlink "$install_root/current")" == "versions/1.0.0-lystar.1" ]]
[[ "$(readlink "$install_root/previous")" == "versions/1.0.0-lystar.2" ]]

ln -s "$install_root/current/la" "$bin_dir/la"
bash "$ROOT/scripts/install.sh" --uninstall >/dev/null
[[ ! -e "$install_root" ]]
[[ ! -e "$bin_dir/la" ]]
[[ -e "$HOME/.pi/agent/settings.json" ]]

if bash "$ROOT/scripts/install.sh" >/dev/null 2>&1; then
    printf 'placeholder installer unexpectedly succeeded\n' >&2
    exit 1
fi

printf 'install.sh rollback/uninstall checks passed\n'
