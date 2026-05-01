#!/bin/bash
# (winget-prepare) 把 winget/*.yaml 模板填实数据，输出到 winget/.staged/
# 不直接覆盖模板 —— 模板要保持 placeholder 形态便于重复用。
#
# Usage: scripts/winget-prepare.sh <version> <installer-url>
# Example: scripts/winget-prepare.sh 0.1.0 \
#            https://github.com/yigenyecao-afk/tititalk-windows/releases/download/v0.1.0/TiTiTalk_0.1.0_x64-setup.exe
#
# 脚本会：
#   1. 验证 url 可访问 + 下载到临时文件
#   2. 算 SHA256
#   3. cp 模板到 winget/.staged/manifests/t/TiTiTalk/TiTiTalk/<version>/
#      （这是 winget-pkgs repo 的标准目录结构）
#   4. 替换 PLACEHOLDER + PackageVersion + ReleaseDate
#   5. 提示下一步：fork microsoft/winget-pkgs，cp .staged 进去，开 PR
#
# 不自动 push winget-pkgs PR —— 那要 fork 微软仓库（公开行为）+ 多手工
# 步骤（标题格式 / 校验通过率），第一次手工最稳。

set -euo pipefail

if [[ $# -lt 2 ]]; then
    echo "Usage: $0 <version> <installer-url>" >&2
    echo "Example: $0 0.1.0 https://github.com/yigenyecao-afk/tititalk-windows/releases/download/v0.1.0/TiTiTalk_0.1.0_x64-setup.exe" >&2
    exit 1
fi

VERSION="$1"
URL="$2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TPL_DIR="$REPO_ROOT/winget"
OUT_DIR="$REPO_ROOT/winget/.staged/manifests/t/TiTiTalk/TiTiTalk/$VERSION"

# 1. 下载 + 校验可访问
TMP="$(mktemp).exe"
echo "==> 下载 installer 验证可访问性 + 算 SHA256…"
if ! curl -sfL --max-time 120 -o "$TMP" "$URL"; then
    echo "❌ 下载失败：$URL" >&2
    rm -f "$TMP"
    exit 1
fi
SIZE_BYTES=$(wc -c < "$TMP" | tr -d ' ')
SHA256=$(shasum -a 256 "$TMP" | awk '{print toupper($1)}')
rm -f "$TMP"
echo "   size=$SIZE_BYTES bytes"
echo "   sha256=$SHA256"

# 2. 输出到 staged 目录
mkdir -p "$OUT_DIR"
TODAY="$(date -u +%Y-%m-%d)"

for f in TiTiTalk.TiTiTalk.installer.yaml TiTiTalk.TiTiTalk.locale.zh-CN.yaml TiTiTalk.TiTiTalk.yaml; do
    src="$TPL_DIR/$f"
    dst="$OUT_DIR/$f"
    [[ ! -f "$src" ]] && { echo "❌ 模板缺失：$src" >&2; exit 1; }
    sed -e "s|PLACEHOLDER_INSTALLER_URL|$URL|g" \
        -e "s|PLACEHOLDER_SHA256|$SHA256|g" \
        -e "s|^PackageVersion: 0\\.0\\.0.*|PackageVersion: $VERSION|" \
        -e "s|^ReleaseDate: 0000-00-00.*|ReleaseDate: $TODAY|" \
        "$src" > "$dst"
done

echo ""
echo "✅ Manifests staged to: $OUT_DIR"
echo ""
echo "==> 下一步（手工）："
echo "  1. Fork https://github.com/microsoft/winget-pkgs"
echo "  2. git clone fork → cd winget-pkgs"
echo "  3. cp -R $OUT_DIR/* manifests/t/TiTiTalk/TiTiTalk/$VERSION/"
echo "  4. winget validate manifests/t/TiTiTalk/TiTiTalk/$VERSION/"
echo "     （Windows 上跑；macOS 没有 winget CLI 可省略 → 微软 CI 也会跑）"
echo "  5. git commit -m \"New version: TiTiTalk.TiTiTalk version $VERSION\""
echo "  6. git push fork main"
echo "  7. 开 PR 到 microsoft/winget-pkgs，标题用同一格式"
echo ""
echo "  审核通过后用户即可 \`winget install TiTiTalk.TiTiTalk\` 安装。"
