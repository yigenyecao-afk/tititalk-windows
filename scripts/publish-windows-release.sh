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
EXE_NAME="TiTiTalk_${VERSION}_x64-setup.exe"
SIG_NAME="${EXE_NAME}.sig"
UPDATE_JSON_NAME="windows-update.json"
LOCAL_EXE="$LOCAL_DIR/$EXE_NAME"
LOCAL_SIG="$LOCAL_DIR/$SIG_NAME"
LOCAL_UPDATE_JSON="$LOCAL_DIR/$UPDATE_JSON_NAME"

# 1. 拿 .exe —— 优先 local 缓存，没有就从 GH Release 下
if [[ ! -f "$LOCAL_EXE" ]]; then
    echo "==> 本地无 $EXE_NAME，从 GitHub Release v$VERSION 拉…"
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
    echo "==> 本地无 $SIG_NAME，尝试从 GH Release 拉…"
    gh release download "v$VERSION" --repo yigenyecao-afk/tititalk-windows \
        -p "$SIG_NAME" -O "$LOCAL_SIG" 2>/dev/null || true
fi
if [[ ! -f "$LOCAL_UPDATE_JSON" ]]; then
    gh release download "v$VERSION" --repo yigenyecao-afk/tititalk-windows \
        -p "$UPDATE_JSON_NAME" -O "$LOCAL_UPDATE_JSON" 2>/dev/null || true
fi

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
echo "==> 上传 $EXE_NAME ($SIZE_BYTES bytes, sha=${SHA256:0:12}…)"

# 3. 上传到服务器，原子换 symlink + chmod 644
SERVER_EXE_NAME="TiTiTalk-windows-${VERSION}-setup.exe"
SERVER_SIG_NAME="${SERVER_EXE_NAME}.sig"
scp -q "$LOCAL_EXE" "$SERVER:$SERVER_DOWNLOADS/$SERVER_EXE_NAME"
ssh "$SERVER" "ln -sfn $SERVER_EXE_NAME $SERVER_DOWNLOADS/TiTiTalk-windows-latest.exe.new && mv -f $SERVER_DOWNLOADS/TiTiTalk-windows-latest.exe.new $SERVER_DOWNLOADS/TiTiTalk-windows-latest.exe && chmod 644 $SERVER_DOWNLOADS/$SERVER_EXE_NAME"

# 3b. 上传 .sig + windows-update.json（updater 闭环；缺则跳过 + 警告）
if [[ -f "$LOCAL_SIG" ]]; then
    scp -q "$LOCAL_SIG" "$SERVER:$SERVER_DOWNLOADS/$SERVER_SIG_NAME"
    ssh "$SERVER" "chmod 644 $SERVER_DOWNLOADS/$SERVER_SIG_NAME"
else
    echo "⚠️  无 $SIG_NAME，跳过 updater 通道（用户不会收到自动更新）"
fi
if [[ -f "$LOCAL_UPDATE_JSON" ]]; then
    scp -q "$LOCAL_UPDATE_JSON" "$SERVER:$SERVER_DOWNLOADS/windows-update.json.new"
    ssh "$SERVER" "mv -f $SERVER_DOWNLOADS/windows-update.json.new $SERVER_DOWNLOADS/windows-update.json && chmod 644 $SERVER_DOWNLOADS/windows-update.json"
else
    echo "⚠️  无 windows-update.json，跳过 updater 元数据更新"
fi

# 4. 生成 windows-latest.json + 上传
RELEASED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
WIN_LATEST="$(mktemp)"
cat > "$WIN_LATEST" <<EOF
{
  "version": "$VERSION",
  "platform": "windows",
  "min_os": "10.0.17763",
  "url": "https://tititalk.com/downloads/TiTiTalk-windows-latest.exe",
  "versioned_url": "https://tititalk.com/downloads/$SERVER_EXE_NAME",
  "size_bytes": $SIZE_BYTES,
  "sha256": "$SHA256",
  "released_at": "$RELEASED_AT",
  "notes_url": "https://github.com/yigenyecao-afk/tititalk-windows/releases/tag/v$VERSION"
}
EOF
scp -q "$WIN_LATEST" "$SERVER:$SERVER_DOWNLOADS/windows-latest.json.new"
ssh "$SERVER" "mv -f $SERVER_DOWNLOADS/windows-latest.json.new $SERVER_DOWNLOADS/windows-latest.json && chmod 644 $SERVER_DOWNLOADS/windows-latest.json"
rm -f "$WIN_LATEST"

echo ""
echo "✅ Published TiTiTalk Windows $VERSION"
echo "   EXE     → https://tititalk.com/downloads/$SERVER_EXE_NAME"
echo "   latest  → https://tititalk.com/downloads/TiTiTalk-windows-latest.exe"
echo "   meta    → https://tititalk.com/downloads/windows-latest.json"
echo "   updater → https://tititalk.com/downloads/windows-update.json"
echo "   sha256  → $SHA256"
