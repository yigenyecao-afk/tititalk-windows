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
echo "==> 上传 $EXE_NAME ($SIZE_BYTES bytes, sha=${SHA256:0:12}…)"

# 3. 上传到服务器，原子换 symlink + chmod 644
SERVER_EXE_NAME="TiTiTalk-windows-${VERSION}-setup.exe"
SERVER_SIG_NAME="${SERVER_EXE_NAME}.sig"
scp -q -o ServerAliveInterval=15 -o ServerAliveCountMax=4 "$LOCAL_EXE" "$SERVER:$SERVER_DOWNLOADS/$SERVER_EXE_NAME"
ssh "$SERVER" "ln -sfn $SERVER_EXE_NAME $SERVER_DOWNLOADS/TiTiTalk-windows-latest.exe.new && mv -f $SERVER_DOWNLOADS/TiTiTalk-windows-latest.exe.new $SERVER_DOWNLOADS/TiTiTalk-windows-latest.exe && chmod 644 $SERVER_DOWNLOADS/$SERVER_EXE_NAME"

# 3b. 上传 .sig + windows-update.json（updater 闭环；缺则跳过 + 警告）
if [[ -f "$LOCAL_SIG" ]]; then
    scp -q -o ServerAliveInterval=15 -o ServerAliveCountMax=4 "$LOCAL_SIG" "$SERVER:$SERVER_DOWNLOADS/$SERVER_SIG_NAME"
    ssh "$SERVER" "chmod 644 $SERVER_DOWNLOADS/$SERVER_SIG_NAME"
else
    echo "⚠️  无 ${SIG_NAME}，跳过 updater 通道（用户不会收到自动更新）"
fi
if [[ -f "$LOCAL_UPDATE_JSON" ]]; then
    scp -q -o ServerAliveInterval=15 -o ServerAliveCountMax=4 "$LOCAL_UPDATE_JSON" "$SERVER:$SERVER_DOWNLOADS/windows-update.json.new"
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
scp -q -o ServerAliveInterval=15 -o ServerAliveCountMax=4 "$WIN_LATEST" "$SERVER:$SERVER_DOWNLOADS/windows-latest.json.new"
ssh "$SERVER" "mv -f $SERVER_DOWNLOADS/windows-latest.json.new $SERVER_DOWNLOADS/windows-latest.json && chmod 644 $SERVER_DOWNLOADS/windows-latest.json"
rm -f "$WIN_LATEST"

echo ""
echo "✅ Published TiTiTalk Windows $VERSION"
echo "   EXE     → https://tititalk.com/downloads/$SERVER_EXE_NAME"
echo "   latest  → https://tititalk.com/downloads/TiTiTalk-windows-latest.exe"
echo "   meta    → https://tititalk.com/downloads/windows-latest.json"
echo "   updater → https://tititalk.com/downloads/windows-update.json"
echo "   sha256  → $SHA256"

# Sync to public mirror (yigenyecao-afk/tititalk-downloads). Mac repo holds
# sync-mirror.sh — assume it's at the conventional sibling path. Best-effort.
# (NOW.md §10 #11, first surfaced 2026-05-05.) ZIP auto-derived from EXE.
SYNC_MIRROR="${SYNC_MIRROR:-$HOME/Documents/voiceink/scripts/sync-mirror.sh}"
if [[ -x "$SYNC_MIRROR" ]]; then
    echo ""
    echo "==> 同步到 mirror repo (pages / jsdelivr / github 直链)"
    bash "$SYNC_MIRROR" "" "$LOCAL_EXE" "" || \
        echo "   ⚠️  mirror 同步失败但官网 CDN 已上 — 手动跑 bash $SYNC_MIRROR \"\" $LOCAL_EXE"
else
    echo ""
    echo "⚠️  跳过 mirror 同步：sync-mirror.sh 不在 $SYNC_MIRROR — pages/jsdelivr/github 三渠道仍卡旧版"
    echo "   手动跑：bash ~/Documents/voiceink/scripts/sync-mirror.sh \"\" $LOCAL_EXE"
fi
