#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="__LYSTAR_RELEASE_REPOSITORY__"
INSTALL_ROOT="$HOME/.local/share/lystar-agent"
BIN_DIR="$HOME/.local/bin"
VERSION=""
ACTION="install"
UPDATE_PATH=true
DOWNLOADER=""

replace_symlink() {
    local target="$1"
    local link="$2"
    local next="${link}.next.$$"
    rm -f "$next"
    ln -s "$target" "$next"
    if [[ "$(uname -s)" == "Darwin" ]]; then
        mv -hf "$next" "$link"
    else
        mv -Tf "$next" "$link"
    fi
}

write_launcher() {
    local name="$1"
    local path="$BIN_DIR/$name"
    local next="${path}.next.$$"
    cat > "$next" <<'LAUNCHER'
#!/usr/bin/env bash
set -e
current="$HOME/.local/share/lystar-agent/current"
if [[ -x "$current/lc" ]]; then
    exec "$current/lc" "$@"
fi
exec "$current/la" "$@"
LAUNCHER
    chmod +x "$next"
    mv -f "$next" "$path"
}

select_downloader() {
    if command -v curl >/dev/null 2>&1; then
        DOWNLOADER="curl"
    elif command -v wget >/dev/null 2>&1; then
        DOWNLOADER="wget"
    else
        printf '缺少下载工具。请先安装 curl 或 wget。\n' >&2
        exit 1
    fi
}

download() {
    local url="$1"
    local output="$2"
    if [[ "$DOWNLOADER" == "curl" ]]; then
        if ! curl -fL --retry 3 --connect-timeout 10 "$url" -o "$output"; then
            printf '下载失败：%s\n' "$url" >&2
            exit 1
        fi
    elif ! wget --quiet --tries=3 --timeout=10 -O "$output" "$url"; then
        printf '下载失败：%s\n' "$url" >&2
        exit 1
    fi
}

ensure_path() {
    case ":$PATH:" in
        *":$BIN_DIR:"*) return ;;
    esac

    if [[ "$UPDATE_PATH" != true ]]; then
        printf '请把 %s 加入 PATH。\n' "$BIN_DIR"
        return
    fi

    local profile
    local shell_name="${SHELL:-}"
    case "${shell_name##*/}:$(uname -s)" in
        zsh:*) profile="$HOME/.zprofile" ;;
        bash:Darwin) profile="$HOME/.bash_profile" ;;
        bash:*) profile="$HOME/.bashrc" ;;
        *) profile="$HOME/.profile" ;;
    esac
    local path_line='export PATH="$HOME/.local/bin:$PATH"'
    if [[ ! -f "$profile" ]] || ! grep -Fqx "$path_line" "$profile"; then
        printf '\n%s\n' "$path_line" >> "$profile"
    fi
    printf '已把 %s 写入 %s。请重新打开终端。\n' "$BIN_DIR" "$profile"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version)
            if [[ $# -lt 2 || -z "$2" ]]; then
                printf '%s\n' '--version 需要版本号，例如 0.82.1-lystar.5。' >&2
                exit 2
            fi
            VERSION="$2"
            shift 2
            ;;
        --rollback)
            ACTION="rollback"
            shift
            ;;
        --uninstall)
            ACTION="uninstall"
            shift
            ;;
        --no-path-update)
            UPDATE_PATH=false
            shift
            ;;
        *)
            printf '未知参数：%s\n' "$1" >&2
            exit 2
            ;;
    esac
done

if [[ "$ACTION" == "uninstall" ]]; then
    rm -f "$BIN_DIR/lc" "$BIN_DIR/lystar" "$BIN_DIR/la"
    rm -rf "$INSTALL_ROOT"
    printf 'LYStar Code 已卸载。用户数据仍保留在 ~/.pi/agent。\n'
    exit 0
fi

if [[ "$ACTION" == "rollback" ]]; then
    if [[ ! -L "$INSTALL_ROOT/previous" ]]; then
        printf '没有可回退的 LYStar Code 版本。\n' >&2
        exit 1
    fi
    current_target="$(readlink "$INSTALL_ROOT/current" 2>/dev/null || true)"
    previous_target="$(readlink "$INSTALL_ROOT/previous")"
    replace_symlink "$previous_target" "$INSTALL_ROOT/current"
    if [[ -n "$current_target" ]]; then
        replace_symlink "$current_target" "$INSTALL_ROOT/previous"
    fi
    printf '已回退到 %s。\n' "${previous_target##*/}"
    exit 0
fi

if [[ "$REPOSITORY" == "__LYSTAR_RELEASE_REPOSITORY__" ]]; then
    printf '安装器尚未写入 GitHub repository。请使用 release 构建生成的 install.sh。\n' >&2
    exit 1
fi

command -v tar >/dev/null 2>&1 || { printf '缺少 tar。\n' >&2; exit 1; }
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    printf '缺少 SHA-256 校验工具。请安装 sha256sum 或 shasum。\n' >&2
    exit 1
fi
select_downloader

case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) printf '当前系统暂不支持：%s\n' "$(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *) printf '当前架构暂不支持：%s\n' "$(uname -m)" >&2; exit 1 ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

if [[ -z "$VERSION" ]]; then
    download "https://github.com/$REPOSITORY/releases/latest/download/release-manifest.json" "$tmp/release-manifest.json"
    VERSION="$(awk -F'"' '/"version"[[:space:]]*:/ { print $4; exit }' "$tmp/release-manifest.json")"
fi

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-lystar\.[0-9]+$ ]] || {
    printf '无效版本：%s\n' "$VERSION" >&2
    exit 1
}

asset="lystar-agent-v${VERSION}-${os}-${arch}.tar.gz"
base_url="https://github.com/$REPOSITORY/releases/download/v${VERSION}"

printf '正在下载 LYStar Code %s (%s-%s)...\n' "$VERSION" "$os" "$arch"
download "$base_url/$asset" "$tmp/$asset"
download "$base_url/SHA256SUMS" "$tmp/SHA256SUMS"
expected="$(awk -v file="$asset" '$2 == file || $2 == "*" file { print $1 }' "$tmp/SHA256SUMS")"
[[ "$expected" =~ ^[0-9a-fA-F]{64}$ ]] || { printf 'SHA256SUMS 中缺少 %s。\n' "$asset" >&2; exit 1; }

if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
else
    actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
fi
actual="$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]')"
expected="$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')"
[[ "$actual" == "$expected" ]] || { printf 'SHA-256 校验失败。\n' >&2; exit 1; }

mkdir -p "$INSTALL_ROOT/versions" "$BIN_DIR"
tar -xzf "$tmp/$asset" -C "$tmp"
[[ -x "$tmp/lystar-agent/lc" ]] || { printf '发行包缺少 lc。\n' >&2; exit 1; }
[[ -x "$tmp/lystar-agent/lystar" ]] || { printf '发行包缺少 lystar。\n' >&2; exit 1; }
[[ -x "$tmp/lystar-agent/lystar-tui" ]] || { printf '发行包缺少 lystar-tui。\n' >&2; exit 1; }
"$tmp/lystar-agent/lc" --version >/dev/null

target="$INSTALL_ROOT/versions/$VERSION"
if [[ ! -d "$target" ]]; then
    mv "$tmp/lystar-agent" "$target.next"
    mv "$target.next" "$target"
fi

current_target="$(readlink "$INSTALL_ROOT/current" 2>/dev/null || true)"
if [[ -n "$current_target" && "$current_target" != "versions/$VERSION" ]]; then
    replace_symlink "$current_target" "$INSTALL_ROOT/previous"
fi
replace_symlink "versions/$VERSION" "$INSTALL_ROOT/current"
write_launcher "lc"
write_launcher "lystar"
rm -f "$BIN_DIR/la"

printf 'LYStar Code %s 已安装到 %s。\n' "$VERSION" "$target"
ensure_path
printf '首次使用：进入项目目录运行 lc 或 lystar，然后执行 /login。\n'
