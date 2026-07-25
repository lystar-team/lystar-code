#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="__LYSTAR_RELEASE_REPOSITORY__"
INSTALL_ROOT="$HOME/.local/share/lystar-agent"
BIN_DIR="$HOME/.local/bin"
VERSION=""
ACTION="install"

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

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version)
            VERSION="${2:-}"
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
        *)
            printf '未知参数：%s\n' "$1" >&2
            exit 2
            ;;
    esac
done

if [[ "$ACTION" == "uninstall" ]]; then
    rm -f "$BIN_DIR/la"
    rm -rf "$INSTALL_ROOT"
    printf 'LYStar Agent 已卸载。用户数据仍保留在 ~/.pi/agent。\n'
    exit 0
fi

if [[ "$ACTION" == "rollback" ]]; then
    if [[ ! -L "$INSTALL_ROOT/previous" ]]; then
        printf '没有可回退的 LYStar Agent 版本。\n' >&2
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

command -v curl >/dev/null 2>&1 || { printf '缺少 curl。\n' >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { printf '缺少 tar。\n' >&2; exit 1; }

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

if [[ -z "$VERSION" ]]; then
    latest_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPOSITORY/releases/latest")"
    tag="${latest_url##*/}"
    VERSION="${tag#v}"
fi

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-lystar\.[0-9]+$ ]] || {
    printf '无效版本：%s\n' "$VERSION" >&2
    exit 1
}

asset="lystar-agent-v${VERSION}-${os}-${arch}.tar.gz"
base_url="https://github.com/$REPOSITORY/releases/download/v${VERSION}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

printf '正在下载 LYStar Agent %s (%s-%s)...\n' "$VERSION" "$os" "$arch"
curl -fL --retry 3 --connect-timeout 10 "$base_url/$asset" -o "$tmp/$asset"
curl -fL --retry 3 --connect-timeout 10 "$base_url/SHA256SUMS" -o "$tmp/SHA256SUMS"
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
[[ -x "$tmp/lystar-agent/la" ]] || { printf '发行包缺少 la。\n' >&2; exit 1; }
"$tmp/lystar-agent/la" --version >/dev/null

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
ln -sfn "$INSTALL_ROOT/current/la" "$BIN_DIR/la"

printf 'LYStar Agent %s 已安装到 %s。\n' "$VERSION" "$target"
case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) printf '请把 %s 加入 PATH。\n' "$BIN_DIR" ;;
esac
