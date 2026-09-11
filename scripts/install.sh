#!/usr/bin/env bash
set -eEuo pipefail

REPOSITORY="__LYSTAR_RELEASE_REPOSITORY__"
INSTALL_ROOT="$HOME/.local/share/lystar-agent"
BIN_DIR="$HOME/.local/bin"
VERSION=""
ACTION="install"
UPDATE_PATH=true
DOWNLOADER=""
tmp=""
activated_version=""
# 安装检查必须读取 current，不能继承后台服务固定的旧版本。
unset LYSTAR_WEB_SERVICE_VERSION

web_agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

web_usage_exists() {
    [[ -f "$web_agent_dir/web-config.json" || -f "$web_agent_dir/web/service-state.json" || -f "$web_agent_dir/web/gateway.json" ]]
}

reconcile_web_services() {
    local target_version="$1"
    local previous_version="${2:-}"
    local launcher="${3:-$INSTALL_ROOT/current/lc}"
    web_usage_exists || return 0
    [[ -x "$launcher" ]] || {
        print_warning "Web 服务已使用，但没有找到可执行的 lc：$launcher"
        return 1
    }
    print_info "正在把 Web Gateway 和 Web Runtime 服务切换到 ${target_version}……"
    LYSTAR_WEB_SERVICE_TARGET_VERSION="$target_version" \
        LYSTAR_WEB_PREVIOUS_SERVICE_VERSION="$previous_version" \
        "$launcher" web service reconcile --upgrade --non-interactive
}

print_usage() {
    printf '%s\n' \
        '用法：' \
        '  install.sh                         安装最新版本' \
        '  install.sh --version <版本号>       安装指定版本' \
        '  install.sh --no-path-update        不修改 Shell 配置文件' \
        '  install.sh --rollback              回退到上一个版本' \
        '  install.sh --uninstall             卸载 LYStar Code' \
        '  install.sh --help                 查看帮助'
    printf '\n%s\n' '版本切换前失败会保留已有安装；切换后失败会报告当前版本。用户数据目录 ~/.pi/agent 不会删除。'
}

print_banner() {
    printf '\n============================================================\n'
    printf '  LYStar Code Unix 安装器\n'
    printf '============================================================\n'
}

print_step() {
    printf '\n[%s/%s] %s\n' "$1" "$2" "$3"
}

print_info() {
    printf '  %s\n' "$1"
}

print_success() {
    printf '  [完成] %s\n' "$1"
}

print_warning() {
    printf '  [提示] %s\n' "$1" >&2
}

die() {
    printf '\n[失败] %s\n' "$1" >&2
    if [[ -n "$activated_version" ]]; then
        printf '  当前应用版本为 %s；操作未完成，请处理错误后重试。\n' "$activated_version" >&2
    else
        printf '  当前版本没有切换，已有安装仍可使用。\n' >&2
    fi
    exit 1
}

die_after_activation() {
    printf '\n[失败] %s\n' "$1" >&2
    printf '  LYStar Code 当前版本保持为 %s。\n' "$2" >&2
    printf '  应用版本不会因 Web 服务错误回退。\n' >&2
    exit 1
}

handle_error() {
    local status=$?
    trap - ERR
    die "安装器执行失败（退出码 ${status}）"
}

cleanup() {
    local status=$?
    trap - EXIT
    if [[ -n "$tmp" ]]; then
        rm -rf "$tmp" || true
    fi
    exit "$status"
}

trap handle_error ERR
trap cleanup EXIT

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
root="$HOME/.local/share/lystar-agent"
if [[ -n "${LYSTAR_WEB_SERVICE_VERSION:-}" ]]; then
    current="$root/versions/$LYSTAR_WEB_SERVICE_VERSION"
else
    current="$root/current"
fi
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
        die '缺少下载工具。请先安装 curl 或 wget。'
    fi
}

download() {
    local url="$1"
    local output="$2"
    local name="${output##*/}"
    local attempt
    print_info "正在下载 ${name}（进度条包含实时速度）……"
    for attempt in 1 2 3; do
        rm -f "$output"
        if [[ "$DOWNLOADER" == "curl" ]]; then
            if curl -fL --connect-timeout 10 "$url" -o "$output" && [[ -s "$output" ]]; then
                print_success "已下载 ${name}。"
                return
            fi
        elif wget --progress=bar:force --tries=1 --timeout=10 -O "$output" "$url" && [[ -s "$output" ]]; then
            print_success "已下载 ${name}。"
            return
        fi
        if [[ "$attempt" -lt 3 ]]; then
            print_warning "下载未完成，正在重试（$((attempt + 1))/3）……"
            sleep "$attempt"
        fi
    done
    die "下载失败：$url"
}

ensure_path() {
    case ":${PATH:-}:" in
        *":$BIN_DIR:"*)
            print_info "当前 PATH 已包含 ${BIN_DIR}。"
            return
            ;;
    esac

    if [[ "$UPDATE_PATH" != true ]]; then
        print_warning '没有修改 Shell 配置文件。'
        print_info "当前终端可临时执行：export PATH=\"$BIN_DIR:\$PATH\""
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
        print_success "已把 $BIN_DIR 写入 ${profile}。"
    else
        print_info "$profile 已包含 PATH 配置。"
    fi
    print_info '请重新打开终端，让 PATH 设置生效。'
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version)
            if [[ $# -lt 2 || -z "$2" ]]; then
                printf '[失败] --version 需要版本号，例如 0.82.1-lystar.5。\n\n' >&2
                print_usage >&2
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
        -h|--help)
            ACTION="help"
            shift
            ;;
        *)
            printf '[失败] 未知参数：%s。\n\n' "$1" >&2
            print_usage >&2
            exit 2
            ;;
    esac
done

print_banner
if [[ "$ACTION" == "help" ]]; then
    print_usage
    exit 0
fi

case "$ACTION" in
    install) print_info '当前操作：安装或更新' ;;
    rollback) print_info '当前操作：回退版本' ;;
    uninstall) print_info '当前操作：卸载' ;;
esac
print_info "安装目录：$INSTALL_ROOT"
print_info '安装范围：当前用户，不需要管理员权限。'
current_target="$(readlink "$INSTALL_ROOT/current" 2>/dev/null || true)"
current_version="${current_target##*/}"
if [[ -z "$current_version" ]]; then current_version='未安装'; fi
print_info "当前版本：$current_version"

if [[ "$(uname -s)" == "Darwin" ]] && web_usage_exists; then
    print_info 'macOS Web 后台服务使用 LaunchDaemon，需要管理员授权。'
    if [[ -t 0 && -t 1 ]]; then
        sudo -v || die '管理员授权失败，未修改安装和 Web 服务。'
    else
        sudo -n true || die 'Web 服务需要管理员授权。请在终端执行 sudo -v，再运行安装器或 lc update。'
    fi
fi

if [[ "$ACTION" == "uninstall" ]]; then
    print_step 1 1 '删除 LYStar Code 安装文件'
    print_info "将删除安装目录：$INSTALL_ROOT"
    print_info '用户数据目录 ~/.pi/agent 不会删除。'
    if [[ -x "$INSTALL_ROOT/current/lc" ]]; then
        "$INSTALL_ROOT/current/lc" web service uninstall --non-interactive || die 'Web 服务卸载失败，未删除安装目录。'
    fi
    rm -f "$BIN_DIR/lc" "$BIN_DIR/lystar" "$BIN_DIR/la"
    rm -rf "$INSTALL_ROOT"
    print_success 'LYStar Code 已卸载。用户数据仍保留在 ~/.pi/agent。'
    exit 0
fi

if [[ "$ACTION" == "rollback" ]]; then
    print_step 1 1 '切换到上一个 LYStar Code 版本'
    if [[ ! -L "$INSTALL_ROOT/previous" ]]; then
        die '没有可回退的 LYStar Code 版本。'
    fi
    current_target="$(readlink "$INSTALL_ROOT/current" 2>/dev/null || true)"
    previous_target="$(readlink "$INSTALL_ROOT/previous")"
    [[ -x "$INSTALL_ROOT/$previous_target/lc" || -x "$INSTALL_ROOT/$previous_target/la" ]] || die '回退版本缺少可执行文件，未切换版本。'
    print_info "目标版本：${previous_target##*/}"
    replace_symlink "$previous_target" "$INSTALL_ROOT/current"
    activated_version="${previous_target##*/}"
    if [[ -n "$current_target" ]]; then
        replace_symlink "$current_target" "$INSTALL_ROOT/previous"
    fi
    rollback_launcher=""
    if [[ -n "$current_target" && -x "$INSTALL_ROOT/$current_target/lc" ]]; then
        rollback_launcher="$INSTALL_ROOT/$current_target/lc"
    fi
    target_version="${previous_target##*/}"
    current_version="${current_target##*/}"
    if ! reconcile_web_services "$target_version" "$current_version" "$rollback_launcher"; then
        die_after_activation "LYStar Code 已回退到 ${target_version}，但 Web 服务切换失败。请运行 lc web service status 查看结果。" "$target_version"
    fi
    print_success "已回退到 ${target_version}。"
    exit 0
fi

if [[ "$REPOSITORY" == "__LYSTAR_RELEASE_REPOSITORY__" ]]; then
    die '安装器尚未写入 GitHub repository。请使用 release 构建生成的 install.sh。'
fi

command -v tar >/dev/null 2>&1 || die '缺少 tar。请先安装 tar。'
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    die '缺少 SHA-256 校验工具。请安装 sha256sum 或 shasum。'
fi
select_downloader

case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) die "当前系统暂不支持：$(uname -s)" ;;
esac

case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *) die "当前架构暂不支持：$(uname -m)" ;;
esac

print_step 1 6 '检查系统和获取版本信息'
print_info "目标平台：$os-$arch"
print_info "下载工具：$DOWNLOADER"
if [[ "$UPDATE_PATH" == true ]]; then
    print_info 'PATH：安装后按需写入当前 Shell 配置文件。'
else
    print_info 'PATH：不修改 Shell 配置文件。'
fi

tmp="$(mktemp -d)"
if [[ -z "$VERSION" ]]; then
    print_info '正在获取最新版本信息……'
    download "https://github.com/$REPOSITORY/releases/latest/download/release-manifest.json" "$tmp/release-manifest.json"
    VERSION="$(awk -F'"' '/"version"[[:space:]]*:/ { print $4; exit }' "$tmp/release-manifest.json")"
fi

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-lystar\.[0-9]+$ ]] || die "无效版本：$VERSION"
print_success "目标版本：${VERSION}。"

asset="lystar-agent-v${VERSION}-${os}-${arch}.tar.gz"
base_url="https://github.com/$REPOSITORY/releases/download/v${VERSION}"

print_step 2 6 '下载并校验发行包'
download "$base_url/$asset" "$tmp/$asset"
download "$base_url/SHA256SUMS" "$tmp/SHA256SUMS"
expected="$(awk -v file="$asset" '$2 == file || $2 == "*" file { print $1 }' "$tmp/SHA256SUMS")"
[[ "$expected" =~ ^[0-9a-fA-F]{64}$ ]] || die "SHA256SUMS 中缺少 ${asset}。"

print_info '正在校验发行包完整性（SHA-256）……'
if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
else
    actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
fi
actual="$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]')"
expected="$(printf '%s' "$expected" | tr '[:upper:]' '[:lower:]')"
[[ "$actual" == "$expected" ]] || die 'SHA-256 校验失败。'
print_success '发行包完整性校验通过。'

print_step 3 6 '解压并检查发行包'
print_info '正在解压发行包……'
tar -xzf "$tmp/$asset" -C "$tmp"
[[ -x "$tmp/lystar-agent/lc" ]] || die '发行包缺少 lc。'
[[ -x "$tmp/lystar-agent/lystar" ]] || die '发行包缺少 lystar。'
CandidateVersion="$("$tmp/lystar-agent/lc" --version)"
[[ "$CandidateVersion" == "$VERSION" ]] || die "候选版本校验失败：预期 ${VERSION}，实际 ${CandidateVersion}。"
print_success "发行包检查通过，候选版本为 ${CandidateVersion}。"

print_step 4 6 '写入版本和命令文件'
mkdir -p "$INSTALL_ROOT/versions" "$BIN_DIR"
target="$INSTALL_ROOT/versions/$VERSION"
if [[ ! -d "$target" ]]; then
    mv "$tmp/lystar-agent" "$target.next"
    mv "$target.next" "$target"
else
    existing_version="$("$target/lc" --version)" || die "已有版本目录损坏：$target"
    [[ "$existing_version" == "$VERSION" ]] || die "已有版本目录校验失败：$target"
    print_info "版本目录已存在，复用：$target"
fi

current_target="$(readlink "$INSTALL_ROOT/current" 2>/dev/null || true)"
if [[ -n "$current_target" && "$current_target" != "versions/$VERSION" ]]; then
    replace_symlink "$current_target" "$INSTALL_ROOT/previous"
fi
replace_symlink "versions/$VERSION" "$INSTALL_ROOT/current"
activated_version="$VERSION"
print_success "当前版本已切换到 ${VERSION}。"

print_step 5 6 '创建命令入口并处理 PATH'
write_launcher 'lc'
write_launcher 'lystar'
rm -f "$BIN_DIR/la"
print_success "已创建命令入口：$BIN_DIR/lc 和 $BIN_DIR/lystar。"
ensure_path

print_step 6 6 '检查安装结果'
installed_version="$(HOME="$HOME" "$BIN_DIR/lc" --version)"
[[ "$installed_version" == "$VERSION" ]] || die "安装后的 lc 版本校验失败：预期 ${VERSION}，实际 ${installed_version}。"
alias_version="$(HOME="$HOME" "$BIN_DIR/lystar" --version)"
[[ "$alias_version" == "$VERSION" ]] || die "安装后的 lystar 版本校验失败：预期 ${VERSION}，实际 ${alias_version}。"
print_success "安装结果检查通过：lc 和 lystar 均为 ${VERSION}。"
print_info "安装位置：$target"
previous_service_version="${current_target##*/}"
if ! reconcile_web_services "$VERSION" "$previous_service_version"; then
    die_after_activation "LYStar Code $VERSION 已安装，但 Web 服务切换失败。请运行 lc web service status 查看结果。" "$VERSION"
fi
print_info '新开的终端可直接运行：lc、lystar。'
print_info '首次使用：进入项目目录后执行 /login。'
print_info '用户数据目录 ~/.pi/agent 不会被安装器删除。'
