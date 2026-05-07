#!/bin/bash
# (publish-windows-release) Mac 端跑：把 GHA 出的 .exe 推到
# tititalk.com/downloads/，写 windows-latest.json，原子换 symlink。
#
# Usage: scripts/publish-windows-release.sh <version>
# Example: scripts/publish-windows-release.sh 0.1.0
#
# 读取顺序：
#   1. ~/Downloads/tititalk-windows-installer/TiTiTalk_<v>_x64-setup.exe
#      （gh run download 默认落点）
#   2. 如果不存在 → 从 GitHub Release 下（需要 gh CLI 已 auth）
#   3. 校验 SHA256 跟 metadata.json 里一致
#
# 服务端布局（跟 macOS 流程对齐）：
#   /opt/tititalk-site/storage/downloads/TiTiTalk-windows-<v>-setup.exe
#   /opt/tititalk-site/storage/downloads/TiTiTalk-windows-latest.exe → symlink
#   /opt/tititalk-site/storage/downloads/windows-latest.json (sha256 + size + url)
#
# 不动 macOS 的 latest.json，两边独立。前端 release.ts 已经分了 VERSION /
# WIN_VERSION 两个常量。

set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <version>" >&2
    echo "Example: $0 0.1.0" >&2
    exit 1
fi

VERSION="$1"
SERVER="root@43.106.48.21"
SERVER_DOWNLOADS="/opt/tititalk-site/storage/downloads"
LOCAL_DIR="$HOME/Downloads/tititalk-windows-installer"

# (v0.14.0 M1 双 SKU) BUILD_FLAVOR=cloud（默认）/ local
# 官网不再 host binary — EXE 走 GitHub Release direct link。tititalk.com 只
# 保留 metadata（windows-latest.json + windows-update.json）兼容老 Tauri updater
# feed URL（已发版本写死了 fixed URL，不能改）。
BUILD_FLAVOR="${BUILD_FLAVOR:-cloud}"
MIRROR_REPO="yigenyecao-afk/tititalk-downloads"
case "$BUILD_FLAVOR" in
    cloud)
        SERVER_SKU_DIR="$SERVER_DOWNLOADS"
        EXE_PREFIX="TiTiTalk-windows"
        UPDATE_JSON_NAME="windows-update.json"
        LATEST_JSON_NAME="windows-latest.json"
        ;;
    local)
        SERVER_SKU_DIR="$SERVER_DOWNLOADS/local"
        EXE_PREFIX="TiTiTalk-Local-windows"
        UPDATE_JSON_NAME="windows-update.json"  # 同名但放 local/ 子目录
        LATEST_JSON_NAME="windows-latest.json"
        ;;
    *) echo "❌ BUILD_FLAVOR 必须是 cloud 或 local（当前 '$BUILD_FLAVOR'）"; exit 1 ;;
esac
URL_PREFIX="https://github.com/$MIRROR_REPO/releases/download/v$VERSION"
echo "==> SKU: $BUILD_FLAVOR (binary→GH Release tag v$VERSION, metadata→$SERVER_SKU_DIR)"

# GHA artifact 命名（v0.14.0+ 双 flavor 都 rename 到 canonical -windows- 命名）：
#   cloud → TiTiTalk-windows-<v>-setup.exe
#   local → TiTiTalk-Local-windows-<v>-setup.exe
# 跟 update.json + sync-mirror.sh release tag asset 命名一致。
if [[ "$BUILD_FLAVOR" == "local" ]]; then
    EXE_NAME="TiTiTalk-Local-windows-${VERSION}-setup.exe"
else
    EXE_NAME="TiTiTalk-windows-${VERSION}-setup.exe"
fi
SIG_NAME="${EXE_NAME}.sig"
LOCAL_EXE="$LOCAL_DIR/$EXE_NAME"
LOCAL_SIG="$LOCAL_DIR/$SIG_NAME"
LOCAL_UPDATE_JSON="$LOCAL_DIR/${BUILD_FLAVOR}-${UPDATE_JSON_NAME}" # 防 cloud/local 缓存互踩

# 1. 拿 .exe —— 优先 local 缓存，没有就从 GH Release 下
if [[ ! -f "$LOCAL_EXE" ]]; then
    echo "==> 本地无 ${EXE_NAME}，从 GitHub Release v${VERSION} 拉…"
    mkdir -p "$LOCAL_DIR"
    if ! gh release download "v$VERSION" \
        --repo yigenyecao-afk/tititalk-windows \
        -p "$EXE_NAME" \
        -O "$LOCAL_EXE"; then
        echo "❌ Release v$VERSION 没找到 $EXE_NAME — 等 GHA 的 release-attach step 跑完？" >&2
        exit 1
    fi
fi

# 1b. 拿 .sig + windows-update.json（updater 必需，没有则只发 .exe + 警告）
if [[ ! -f "$LOCAL_SIG" ]]; then
    echo "==> 本地无 ${SIG_NAME}，尝试从 GH Release 拉…"
    gh release download "v$VERSION" --repo yigenyecao-afk/tititalk-windows \
        -p "$SIG_NAME" -O "$LOCAL_SIG" 2>/dev/null || true
fi
# windows-update.json 跟 .exe / .sig 不一样：文件名不带版本号（updater
# 协议要求固定 URL），所以本地缓存命中后会用旧版本的 json 把服务端覆盖
# 成上一版（实际事故：v0.7.0 publish 时本地还留着 v0.5.0 的，update.json
# 上线后还是写 v0.5.0 → 客户端 updater 跳过 v0.7.0）。每次 publish 都
# 强制重拉对应 tag 的 fresh 版本。
#
# v0.7.1 又踩了：GHA 把 run status 标 completed 时 windows-update.json
# 上传还在进行中（最后一个 asset），导致这里 silent fail，updater 通道
# 漏更。改成 5 次重试 + 5s 间隔，给 GHA assets 上传留时间。
rm -f "$LOCAL_UPDATE_JSON"
for i in 1 2 3 4 5; do
    if gh release download "v$VERSION" --repo yigenyecao-afk/tititalk-windows \
        -p "$UPDATE_JSON_NAME" -O "$LOCAL_UPDATE_JSON" 2>/dev/null && [[ -s "$LOCAL_UPDATE_JSON" ]]; then
        break
    fi
    echo "==> windows-update.json 还没上线（attempt $i/5），等 5s 重试…"
    sleep 5
done

# 2. 校验 SHA256（如果 metadata.json 存在）
SHA256="$(shasum -a 256 "$LOCAL_EXE" | awk '{print $1}')"
SIZE_BYTES="$(wc -c < "$LOCAL_EXE" | tr -d ' ')"
META="$LOCAL_DIR/metadata.json"
if [[ -f "$META" ]]; then
    GHA_SHA="$(jq -r '.sha256 // empty' "$META")"
    if [[ -n "$GHA_SHA" && "$GHA_SHA" != "$SHA256" ]]; then
        echo "❌ SHA mismatch:" >&2
        echo "   GHA   $GHA_SHA" >&2
        echo "   local $SHA256" >&2
        echo "   .exe 在传输中可能被改了，停止发版" >&2
        exit 1
    fi
fi
echo "==> EXE: $EXE_NAME ($SIZE_BYTES bytes, sha=${SHA256:0:12}…) — binary 走 GH Release，不再上 server"

# (v0.14.0) 跟 Mac publish-release.sh 对齐：
#   - binary （EXE + .sig）走 GitHub Release direct link
#   - tititalk.com 只放 metadata（windows-update.json + windows-latest.json），
#     兼容老 Tauri updater feed URL（已发版本写死了 fixed URL，不能改）
SERVER_EXE_NAME="${EXE_PREFIX}-${VERSION}-setup.exe"

# 3. metadata only — windows-update.json（Tauri updater feed，已经是 fresh 版本）+
#    windows-latest.json（前端展示）。注意 url 字段都指向 GitHub Release。
RELEASED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# 3a. windows-latest.json（前端 release.ts 用）
WIN_LATEST="$(mktemp)"
cat > "$WIN_LATEST" <<EOF
{
  "version": "$VERSION",
  "platform": "windows",
  "sku": "$BUILD_FLAVOR",
  "min_os": "10.0.17763",
  "url": "$URL_PREFIX/$SERVER_EXE_NAME",
  "versioned_url": "$URL_PREFIX/$SERVER_EXE_NAME",
  "size_bytes": $SIZE_BYTES,
  "sha256": "$SHA256",
  "released_at": "$RELEASED_AT",
  "notes_url": "https://github.com/yigenyecao-afk/tititalk-windows/releases/tag/v$VERSION"
}
EOF

# 3b. windows-update.json（Tauri updater feed） — 必须把 platforms.windows-x86_64.url
# 改成 GH Release URL，否则 updater 还是去 tititalk.com 拉 binary（404）。
# GHA 出的原版 update.json url 是 GH Release tag asset，正常情况已经对，但保险
# 起见这里 jq 强制重写一遍（兼容 Tauri 不同版本的字段命名）。
if [[ -f "$LOCAL_UPDATE_JSON" ]]; then
    PATCHED_UPDATE="$(mktemp)"
    if command -v jq >/dev/null 2>&1; then
        jq --arg url "$URL_PREFIX/$SERVER_EXE_NAME" \
           '.platforms["windows-x86_64"].url = $url' \
           "$LOCAL_UPDATE_JSON" > "$PATCHED_UPDATE" 2>/dev/null || cp "$LOCAL_UPDATE_JSON" "$PATCHED_UPDATE"
    else
        cp "$LOCAL_UPDATE_JSON" "$PATCHED_UPDATE"
    fi
fi

echo "==> Ensuring server SKU dir exists ($SERVER_SKU_DIR)"
ssh "$SERVER" "mkdir -p $SERVER_SKU_DIR"

echo "==> Uploading metadata only (windows-latest.json + windows-update.json) — EXE 走 GH Release"
scp -q -o ServerAliveInterval=15 -o ServerAliveCountMax=4 "$WIN_LATEST" "$SERVER:$SERVER_SKU_DIR/$LATEST_JSON_NAME.new"
ssh "$SERVER" "mv -f $SERVER_SKU_DIR/$LATEST_JSON_NAME.new $SERVER_SKU_DIR/$LATEST_JSON_NAME && chmod 644 $SERVER_SKU_DIR/$LATEST_JSON_NAME"

if [[ -f "${PATCHED_UPDATE:-}" ]]; then
    scp -q -o ServerAliveInterval=15 -o ServerAliveCountMax=4 "$PATCHED_UPDATE" "$SERVER:$SERVER_SKU_DIR/$UPDATE_JSON_NAME.new"
    ssh "$SERVER" "mv -f $SERVER_SKU_DIR/$UPDATE_JSON_NAME.new $SERVER_SKU_DIR/$UPDATE_JSON_NAME && chmod 644 $SERVER_SKU_DIR/$UPDATE_JSON_NAME"
    rm -f "$PATCHED_UPDATE"
else
    echo "⚠️  无 windows-update.json，跳过 updater 元数据更新（自动更新通道会卡旧版）"
fi
rm -f "$WIN_LATEST"

# meta URL 路径：cloud → /downloads/，local → /downloads/local/
if [[ "$BUILD_FLAVOR" == "local" ]]; then
    META_URL_PATH="https://tititalk.com/downloads/local"
else
    META_URL_PATH="https://tititalk.com/downloads"
fi

echo ""
echo "✅ Published TiTiTalk Windows $BUILD_FLAVOR $VERSION"
echo "   EXE     → $URL_PREFIX/$SERVER_EXE_NAME (GH Release)"
echo "   meta    → $META_URL_PATH/$LATEST_JSON_NAME"
echo "   updater → $META_URL_PATH/$UPDATE_JSON_NAME"
echo "   sha256  → $SHA256"

# (v0.14.0) 双 SKU 都必须 push 到 GH Release（binary 唯一落点）。
# Cloud 版 EXE 同时进 mirror main 分支（jsdelivr/Pages 三渠道）。
# Local 版 EXE 270MB 超 jsdelivr 50MB cap，只挂 release tag asset。
SYNC_MIRROR="${SYNC_MIRROR:-$HOME/Documents/voiceink/scripts/sync-mirror.sh}"
if [[ ! -x "$SYNC_MIRROR" ]]; then
    echo ""
    echo "❌ sync-mirror.sh 不在 $SYNC_MIRROR — EXE 没传上 GH Release，Tauri updater 拉不到 binary！"
    echo "   手动跑：MAC_VERSION=<mac-version> bash $SYNC_MIRROR \"\" $LOCAL_EXE"
    exit 1
fi

echo ""
echo "==> Push EXE to GitHub Release v$VERSION (mirror repo)"
# MAC_VERSION 必须传 — sync-mirror 用它当 release tag。Win-only 发版时
# 沿用上一次 Mac 发版的 tag（不创建新 v0.14.0 的 Mac-less tag）。
if [[ -z "${MAC_VERSION:-}" ]]; then
    # Win 单独发版时，沿用 mirror repo 当前 latest release tag
    MAC_VERSION="$(gh release list --repo $MIRROR_REPO --limit 1 --json tagName -q '.[0].tagName' 2>/dev/null | sed 's/^v//')"
    if [[ -z "$MAC_VERSION" ]]; then
        echo "❌ 无法从 mirror repo 探测到 release tag，必须显式传 MAC_VERSION=<x.y.z>"
        exit 1
    fi
    echo "   (沿用 mirror 现有 tag v$MAC_VERSION — 没有 Mac 同步发版)"
fi
MAC_VERSION="$MAC_VERSION" bash "$SYNC_MIRROR" "" "$LOCAL_EXE" "" || {
    echo "   ❌ EXE 没传上 GH Release — Tauri updater 自动更新会拉不到 binary！"
    echo "   手动跑：MAC_VERSION=$MAC_VERSION bash $SYNC_MIRROR \"\" $LOCAL_EXE"
    exit 1
}
