#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
ORIGINAL_PATH="$PATH"
VERSION="1.0.0-lystar.1"

case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) printf 'unsupported test OS\n' >&2; exit 1 ;;
esac
case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *) printf 'unsupported test architecture\n' >&2; exit 1 ;;
esac

release_dir="$tmp/release"
bundle_dir="$tmp/bundle/lystar-agent"
mkdir -p "$release_dir" "$bundle_dir"
printf '%s\n' '#!/usr/bin/env bash' '[[ "${1:-}" == "--version" ]] || exit 2' "printf '%s\\n' '$VERSION'" > "$bundle_dir/la"
chmod +x "$bundle_dir/la"
asset="lystar-agent-v${VERSION}-${os}-${arch}.tar.gz"
tar -czf "$release_dir/$asset" -C "$tmp/bundle" lystar-agent
node "$ROOT/scripts/generate-release-metadata.mjs" "$release_dir" "$VERSION" "octyean/lystar-agent"

node - "$ROOT/scripts/install.ps1" "$release_dir/install.ps1" <<'NODE'
const fs = require("node:fs");
for (const path of process.argv.slice(2)) {
    const bytes = fs.readFileSync(path);
    if (!bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
        throw new Error(`${path} must start with a UTF-8 BOM for Windows PowerShell 5.1`);
    }
}
NODE
grep -F 'REPOSITORY="octyean/lystar-agent"' "$release_dir/install.sh" >/dev/null
grep -F '[[ "$REPOSITORY" == "__LYSTAR_RELEASE_REPOSITORY__" ]]' "$release_dir/install.sh" >/dev/null
grep -F '$Repository = "octyean/lystar-agent"' "$release_dir/install.ps1" >/dev/null
grep -F '$Repository -eq "__LYSTAR_RELEASE_REPOSITORY__"' "$release_dir/install.ps1" >/dev/null
grep -F 'https://github.com/octyean/lystar-agent/releases/latest/download/install.ps1' "$release_dir/install.cmd" >/dev/null
grep -F 'https://github.com/__LYSTAR_RELEASE_REPOSITORY__/releases/latest/download/install.ps1' "$ROOT/scripts/install.cmd" >/dev/null

fake_curl_dir="$tmp/fake-curl"
mkdir -p "$fake_curl_dir"
cat > "$fake_curl_dir/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        -o) output="$2"; shift 2 ;;
        http*) url="$1"; shift ;;
        *) shift ;;
    esac
done
[[ -n "$output" && -n "$url" ]]
/bin/cp "$FIXTURE_DIR/${url##*/}" "$output"
CURL
chmod +x "$fake_curl_dir/curl"

install_with_curl() {
    local home="$tmp/home-curl"
    mkdir -p "$home/.pi/agent"
    touch "$home/.pi/agent/settings.json"
    HOME="$home" SHELL=/bin/bash FIXTURE_DIR="$release_dir" PATH="$fake_curl_dir:$ORIGINAL_PATH" \
        bash "$release_dir/install.sh" >/dev/null

    local install_root="$home/.local/share/lystar-agent"
    [[ "$(readlink "$install_root/current")" == "versions/$VERSION" ]]
    [[ -x "$install_root/current/la" ]]
    [[ -L "$home/.local/bin/la" ]]
    [[ "$(grep -Fxc 'export PATH="$HOME/.local/bin:$PATH"' "$home/.bashrc")" == "1" ]]

    HOME="$home" SHELL=/bin/bash FIXTURE_DIR="$release_dir" PATH="$fake_curl_dir:$ORIGINAL_PATH" \
        bash "$release_dir/install.sh" >/dev/null
    [[ "$(grep -Fxc 'export PATH="$HOME/.local/bin:$PATH"' "$home/.bashrc")" == "1" ]]
}

install_without_path_update() {
    local home="$tmp/home-no-path"
    HOME="$home" SHELL=/bin/bash FIXTURE_DIR="$release_dir" PATH="$fake_curl_dir:$ORIGINAL_PATH" \
        bash "$release_dir/install.sh" --no-path-update >/dev/null
    [[ ! -e "$home/.bashrc" ]]
    [[ -x "$home/.local/share/lystar-agent/current/la" ]]
}

install_with_wget_only() {
    local tool_dir="$tmp/wget-tools"
    mkdir -p "$tool_dir"
    local name
    for name in bash tar gzip sha256sum awk tr grep uname mktemp rm ln mv mkdir readlink; do
        ln -s "$(command -v "$name")" "$tool_dir/$name"
    done
    cat > "$tool_dir/wget" <<'WGET'
#!/bin/bash
set -euo pipefail
output=""
url=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        -O) output="$2"; shift 2 ;;
        http*) url="$1"; shift ;;
        *) shift ;;
    esac
done
[[ -n "$output" && -n "$url" ]]
/bin/cp "$FIXTURE_DIR/${url##*/}" "$output"
WGET
    chmod +x "$tool_dir/wget"

    local home="$tmp/home-wget"
    HOME="$home" SHELL=/bin/bash FIXTURE_DIR="$release_dir" PATH="$tool_dir" \
        /bin/bash "$release_dir/install.sh" >/dev/null
    [[ -x "$home/.local/share/lystar-agent/current/la" ]]
}

reject_bad_checksum() {
    local bad_release="$tmp/bad-release"
    cp -R "$release_dir" "$bad_release"
    printf '%064d  %s\n' 0 "$asset" > "$bad_release/SHA256SUMS"
    local home="$tmp/home-bad-sha"
    if HOME="$home" SHELL=/bin/bash FIXTURE_DIR="$bad_release" PATH="$fake_curl_dir:$ORIGINAL_PATH" \
        bash "$bad_release/install.sh" >/dev/null 2>&1; then
        printf 'installer unexpectedly accepted a bad checksum\n' >&2
        exit 1
    fi
    [[ ! -e "$home/.local/share/lystar-agent/current" ]]
}

check_rollback_and_uninstall() {
    local home="$tmp/home-actions"
    local install_root="$home/.local/share/lystar-agent"
    local bin_dir="$home/.local/bin"
    mkdir -p "$install_root/versions/1.0.0-lystar.1" "$install_root/versions/1.0.0-lystar.2" "$bin_dir" "$home/.pi/agent"
    ln -s "versions/1.0.0-lystar.2" "$install_root/current"
    ln -s "versions/1.0.0-lystar.1" "$install_root/previous"
    touch "$home/.pi/agent/settings.json"

    HOME="$home" bash "$ROOT/scripts/install.sh" --rollback >/dev/null
    [[ "$(readlink "$install_root/current")" == "versions/1.0.0-lystar.1" ]]
    [[ "$(readlink "$install_root/previous")" == "versions/1.0.0-lystar.2" ]]

    ln -s "$install_root/current/la" "$bin_dir/la"
    HOME="$home" bash "$ROOT/scripts/install.sh" --uninstall >/dev/null
    [[ ! -e "$install_root" ]]
    [[ ! -e "$bin_dir/la" ]]
    [[ -e "$home/.pi/agent/settings.json" ]]
}

install_with_curl
install_without_path_update
install_with_wget_only
reject_bad_checksum
check_rollback_and_uninstall

if HOME="$tmp/home-missing-version" bash "$ROOT/scripts/install.sh" --version >/dev/null 2>&1; then
    printf 'installer unexpectedly accepted --version without a value\n' >&2
    exit 1
fi

if HOME="$tmp/home-placeholder" bash "$ROOT/scripts/install.sh" >/dev/null 2>&1; then
    printf 'placeholder installer unexpectedly succeeded\n' >&2
    exit 1
fi

printf 'Unix installer install, PATH, checksum, rollback, uninstall, and materialization checks passed\n'
