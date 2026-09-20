#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT_DIR="$(pwd)"

SKIP_INSTALL=false
SKIP_BUILD=false
OFFLINE_MODEL_DATA=false
PLATFORM=""
OUTPUT_DIR=""
CONFIGURED_REPOSITORY="$(node -p "require('./packages/coding-agent/package.json').piConfig?.releaseRepository || ''")"
REPOSITORY="${GITHUB_REPOSITORY:-$CONFIGURED_REPOSITORY}"

run_bun() {
    if command -v bun >/dev/null 2>&1; then
        bun "$@"
    else
        npx --yes -p bun@1.3.9 bun "$@"
    fi
}

native_platform() {
    local os arch
    case "$(uname -s)" in
        Darwin) os="darwin" ;;
        Linux) os="linux" ;;
        *) printf 'Unsupported Unix release host: %s\n' "$(uname -s)" >&2; exit 2 ;;
    esac
    case "$(uname -m)" in
        arm64|aarch64) arch="arm64" ;;
        x86_64|amd64) arch="x64" ;;
        *) printf 'Unsupported Unix release architecture: %s\n' "$(uname -m)" >&2; exit 2 ;;
    esac
    printf '%s-%s\n' "$os" "$arch"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-install) SKIP_INSTALL=true; shift ;;
        --skip-build) SKIP_BUILD=true; shift ;;
        --offline-model-data) OFFLINE_MODEL_DATA=true; shift ;;
        --platform) PLATFORM="$2"; shift 2 ;;
        --out) OUTPUT_DIR="$2"; shift 2 ;;
        --repository) REPOSITORY="$2"; shift 2 ;;
        *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
    esac
done

NATIVE_PLATFORM="$(native_platform)"
if [[ -z "$PLATFORM" ]]; then
    PLATFORM="$NATIVE_PLATFORM"
fi
case "$PLATFORM" in
    darwin-arm64|darwin-x64|linux-x64|linux-arm64) ;;
    *) printf 'Invalid platform: %s\n' "$PLATFORM" >&2; exit 2 ;;
esac
if [[ "$PLATFORM" != "$NATIVE_PLATFORM" ]]; then
    printf 'Release binary must be built natively: requested %s, current %s\n' "$PLATFORM" "$NATIVE_PLATFORM" >&2
    exit 2
fi
if [[ -n "$REPOSITORY" && ! "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    printf 'Invalid repository: %s (expected owner/repo)\n' "$REPOSITORY" >&2
    exit 2
fi
if [[ -n "$CONFIGURED_REPOSITORY" && "$REPOSITORY" != "$CONFIGURED_REPOSITORY" ]]; then
    printf 'Repository mismatch: configured %s, received %s\n' "$CONFIGURED_REPOSITORY" "$REPOSITORY" >&2
    exit 2
fi

VERSION="$(node -p "const p=require('./packages/coding-agent/package.json'); p.piConfig?.productVersion || p.version")"
BUN_STAGING_FILES=()
cleanup() {
    if [[ ${#BUN_STAGING_FILES[@]} -gt 0 ]]; then rm -f "${BUN_STAGING_FILES[@]}"; fi
}
trap cleanup EXIT
if [[ -z "$OUTPUT_DIR" ]]; then
    OUTPUT_DIR="packages/coding-agent/binaries"
fi
if [[ "$OUTPUT_DIR" != /* ]]; then
    OUTPUT_DIR="$(pwd)/$OUTPUT_DIR"
fi

if [[ "$SKIP_INSTALL" == false ]]; then
    npm ci --ignore-scripts
fi

if [[ "$SKIP_BUILD" == false ]]; then
    if [[ "$OFFLINE_MODEL_DATA" == true ]]; then
        npm run build:offline
    else
        npm run build
    fi
fi

PLATFORMS=("$PLATFORM")

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"
for platform in "${PLATFORMS[@]}"; do
    mkdir -p "$OUTPUT_DIR/$platform"
done

cd packages/coding-agent
for platform in "${PLATFORMS[@]}"; do
    printf 'Building LYStar Code %s for %s...\n' "$VERSION" "$platform"

    # Bun 只有显式收到 worker 入口时，才会把 worker 编入独立可执行文件。
    # 每个平台在对应原生 runner 构建，避免交叉 target 产出不可执行文件。
    # 禁用当前目录 bunfig.toml 自动加载，避免项目 preload 在独立程序启动前执行。
    bun_target="bun-$platform"
    if [[ "$platform" == *-x64 ]]; then
        bun_target="${bun_target}-baseline"
    fi
    bun_output="$ROOT_DIR/packages/coding-agent/dist/.lystar-lc-${platform}-$$"
    BUN_STAGING_FILES+=("$bun_output")
    rm -f "$bun_output"
    run_bun build --compile --no-compile-autoload-bunfig --target="$bun_target" ../../scripts/lystar-bun-cli.mjs ./src/utils/image-resize-worker.ts \
        --outfile "$bun_output"
    cp "$bun_output" "$OUTPUT_DIR/$platform/lc"
    rm -f "$bun_output"
	ln -s lc "$OUTPUT_DIR/$platform/lystar"
done

for platform in "${PLATFORMS[@]}"; do
    cp package.json "$OUTPUT_DIR/$platform/package.json"
    node ../../scripts/prepare-release-package.mjs "$OUTPUT_DIR/$platform/package.json" "$VERSION" "$REPOSITORY"
    cp README.md CHANGELOG.md "$OUTPUT_DIR/$platform/"
    cp ../../LICENSE ../../THIRD_PARTY_LICENSES.md "$OUTPUT_DIR/$platform/"
    cp ../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm "$OUTPUT_DIR/$platform/"
    mkdir -p "$OUTPUT_DIR/$platform/theme" "$OUTPUT_DIR/$platform/assets"
    cp dist/modes/interactive/theme/*.json "$OUTPUT_DIR/$platform/theme/"
    cp dist/modes/interactive/assets/* "$OUTPUT_DIR/$platform/assets/"
    cp -r dist/core/export-html "$OUTPUT_DIR/$platform/"
    cp -r dist/skills "$OUTPUT_DIR/$platform/"
    cp -r docs examples "$OUTPUT_DIR/$platform/"
    mkdir -p "$OUTPUT_DIR/$platform/web"
    cp -r "$ROOT_DIR/packages/web/dist/." "$OUTPUT_DIR/$platform/web/"

    # 复制当前平台的原生辅助模块，运行时按 native/<os>/prebuilds/<platform> 查找。
    native_platform_dir="${platform/windows-/win32-}"
    native_path="native/${native_platform_dir%-*}/prebuilds"
    mkdir -p "$OUTPUT_DIR/$platform/$native_path"
    cp -R "../tui/$native_path/$native_platform_dir" "$OUTPUT_DIR/$platform/$native_path/"

    [[ -x "$OUTPUT_DIR/$platform/lc" ]] || { printf 'Release bundle is missing lc for %s\n' "$platform" >&2; exit 1; }
    [[ "$("$OUTPUT_DIR/$platform/lc" --version)" == "$VERSION" ]] || { printf 'Release bundle lc version mismatch for %s\n' "$platform" >&2; exit 1; }
    [[ -x "$OUTPUT_DIR/$platform/lystar" ]] || { printf 'Release bundle is missing lystar for %s\n' "$platform" >&2; exit 1; }
    [[ -f "$OUTPUT_DIR/$platform/package.json" ]] || { printf 'Release bundle is missing package.json for %s\n' "$platform" >&2; exit 1; }
    [[ -f "$OUTPUT_DIR/$platform/photon_rs_bg.wasm" ]] || { printf 'Release bundle is missing photon WASM for %s\n' "$platform" >&2; exit 1; }
    [[ -f "$OUTPUT_DIR/$platform/web/index.html" ]] || { printf 'Release bundle is missing Web assets for %s\n' "$platform" >&2; exit 1; }
    [[ -f "$OUTPUT_DIR/$platform/web/version.json" ]] || { printf 'Release bundle is missing Web version for %s\n' "$platform" >&2; exit 1; }
    [[ -f "$OUTPUT_DIR/$platform/skills/imagegen/SKILL.md" ]] || { printf 'Release bundle is missing built-in skills for %s\n' "$platform" >&2; exit 1; }
done

cd "$OUTPUT_DIR"
for platform in "${PLATFORMS[@]}"; do
    mv "$platform" lystar-agent
    tar -czf "lystar-agent-v${VERSION}-${platform}.tar.gz" lystar-agent
    mv lystar-agent "$platform"
done

cd "$ROOT_DIR"
node scripts/generate-release-metadata.mjs "$OUTPUT_DIR" "$VERSION" "$REPOSITORY"
printf '%s\n' "$VERSION" > "$OUTPUT_DIR/VERSION"

printf '\nLYStar Code build complete: %s\n' "$OUTPUT_DIR"
find "$OUTPUT_DIR" -maxdepth 1 -type f -printf '  %f\n' 2>/dev/null || ls -1 "$OUTPUT_DIR"
if [[ -z "$REPOSITORY" ]]; then
    printf 'Note: pass --repository owner/repo after creating the GitHub repository to enable installers and lc update.\n'
fi
