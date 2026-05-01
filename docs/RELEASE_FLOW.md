# TiTiTalk Windows · 发版流程

跟 macOS 端（`yigenyecao-afk/tititalk-mac`）保持节奏一致；两个端独立 bump、独立 tag、共享 tititalk.com 站点。

## 单次发版操作清单

### 1. Bump 版本号（local）

```bash
cd ~/Documents/tititalk-windows
# 改 src-tauri/tauri.conf.json 顶部 "version": "0.X.Y"
# 改 src-tauri/Cargo.toml 顶部 version = "0.X.Y"
# 提交
git add -A
git commit -m "chore(release): bump to v0.X.Y — <一句话亮点>"
```

### 2. 推 main 验证 + 打 tag 触发 release（local）

```bash
git push origin main
# 等 GHA build-windows 跑完通过（~14 min cold cache，~5 min warm）
git tag v0.X.Y -m "v0.X.Y — <一句话亮点>"
git push origin v0.X.Y
# tag push 同样触发 GHA build；这次的 build 末尾会跑 softprops/action-gh-release
# 自动建 GitHub Release v0.X.Y，挂 .exe + SHA256SUMS.txt + metadata.json
```

### 3. 上传 .exe 到 tititalk.com（local，一条命令）

```bash
# 等 GitHub Release v0.X.Y 出现后（GHA tag-run 完成）
bash scripts/publish-windows-release.sh 0.X.Y
```

脚本会：
- 优先用本地 `~/Downloads/tititalk-windows-installer/TiTiTalk_X.Y.Z_x64-setup.exe`
- 没有则 `gh release download v0.X.Y` 拉
- 校验 sha256 跟 GHA `metadata.json` 一致（防中间被改）
- scp 到 `root@43.106.48.21:/opt/tititalk-site/storage/downloads/`
- 原子换 `TiTiTalk-windows-latest.exe` symlink → 新版本
- 写 `windows-latest.json`（含 sha256/size/url/released_at）
- chmod 644（避免 `mktemp` 0600 撞 nginx 403）

### 4. Bump 前端 release.ts（local）

```bash
cd ~/Documents/tititalk-site/frontend
sed -i '' 's/WIN_VERSION = "[0-9.]*"/WIN_VERSION = "0.X.Y"/' lib/release.ts
pnpm build
tar czf /tmp/tititalk-frontend.tar.gz .next
scp /tmp/tititalk-frontend.tar.gz root@43.106.48.21:/tmp/
ssh root@43.106.48.21 'cd /opt/tititalk-site/frontend && rm -rf .next.new && mkdir .next.new && tar xzf /tmp/tititalk-frontend.tar.gz -C .next.new --strip-components=1 && rm -rf .next.old && mv .next .next.old && mv .next.new .next && systemctl restart tititalk-web.service'
```

### 5. 验证（local，5 个 curl）

```bash
curl -sI https://tititalk.com/downloads/TiTiTalk-windows-0.X.Y-setup.exe | grep -E "HTTP|content-length"
curl -sI https://tititalk.com/downloads/TiTiTalk-windows-latest.exe       | grep -E "HTTP|content-length"
curl -s   https://tititalk.com/downloads/windows-latest.json
curl -s   https://tititalk.com/ | grep -oE "0\.[0-9]+\.[0-9]+" | sort -u
gh release view v0.X.Y --repo yigenyecao-afk/tititalk-windows --json assets --jq '.assets[].name'
```

### 6.（可选）winget 上架

每个 release 跑一次：

```bash
bash scripts/winget-prepare.sh 0.X.Y https://tititalk.com/downloads/TiTiTalk-windows-0.X.Y-setup.exe
# 输出到 winget/.staged/manifests/t/TiTiTalk/TiTiTalk/0.X.Y/
# 然后手工 fork microsoft/winget-pkgs，cp 进去开 PR（脚本最后会打印步骤）
```

## 跟 macOS 端的对照

| 步骤 | macOS (`tititalk-mac`) | Windows (`tititalk-windows`) |
|---|---|---|
| 编译 | `swift build -c release` (本地 Mac) | GHA `windows-latest` runner |
| 打包 | `bash build.sh && bash dmg.sh` | GHA Tauri build + NSIS bundle |
| 签名 | Sparkle EdDSA via `sign_update -p` (Keychain 私钥) | Tauri minisign via `${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}` |
| 自动更新 | Sparkle ✓ 已活（`SUFeedURL = appcast.xml`） | ✗ v0.2 启用（plugins.updater.active = true） |
| 上传服务器 | `scripts/publish-release.sh` | `scripts/publish-windows-release.sh` |
| 服务端 latest 元数据 | `latest.json` + `appcast.xml` | `windows-latest.json`（暂无 appcast 等价物） |
| 前端版本号常量 | `VERSION` | `WIN_VERSION` |
| 包管理器 | Homebrew Cask（待提）| winget（脚手已就位 `winget/`） |

## 失败诊断

| 现象 | 原因 | 修法 |
|---|---|---|
| GHA Tauri build fail "future not Send" | 持有 `parking_lot` guard 跨 await | 先 `let x = lock.read().clone(); drop(lock);` 再 `.await` |
| GHA pnpm install fail | `pnpm-lock.yaml` 不在 repo | `git add pnpm-lock.yaml && git commit && git push` |
| GHA 两个 run 并行跑（push + tag）| workflow 没设 `concurrency` | 加 `concurrency: { group: ${{ github.ref }}, cancel-in-progress: true }` 让新 push 取消旧 run |
| nginx 403 latest.json | scp 后文件 0600 | publish 脚本末尾必须 `chmod 644` |
| 用户首启 SmartScreen 蓝屏 | 没买 EV 证书 | 短期 README 写「右键属性 → 解除锁定」；中期上 winget；长期买 EV ~¥3500/yr |
| `winget validate` fail | manifest schema 错 | 在 Windows 上跑 `winget validate winget/.staged/...`；macOS 上靠微软 PR CI |

## 维护原则（跟 macOS 共享）

1. **先 grep 再写**：提精品方案前先 grep 该领域关键词；多数「新功能」其实 50-90% 已建好，只补缺口
2. **fallback 必须本地**：cloud 失败 → local 降级前必须 gate by 本地依赖存在
3. **DMG/EXE 同步到 Downloads**：每次 build/CI artifact 出来，cp 一份到 `~/Downloads/<repo>-installer/`
4. **API key 永不入 repo**：如有内置 key 加 `.gitignore`，clone 后用户自填
5. **签名私钥永不入 repo**：Sparkle 在 macOS Keychain，Tauri 在 `~/.tauri/` + GitHub Secrets
