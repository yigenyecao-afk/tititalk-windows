# 构建指南

## 在 Windows 上本地构建

需要：
- Windows 10/11
- Rust stable（`rustup install stable`）
- Node.js 20+ 和 pnpm 9+
- WebView2 SDK（Tauri 自动拉）
- Visual Studio Build Tools 2022（C++ workload）

```pwsh
git clone https://github.com/<owner>/tititalk-windows.git
cd tititalk-windows
pnpm install
pnpm exec tauri icon src-tauri/icons/icon.png    # 一次性，生成 .ico 与多尺寸 .png
pnpm tauri dev                                    # 开发模式（热重载）
pnpm tauri build --bundles nsis                   # 出 NSIS 安装包
```

产物在 `src-tauri/target/release/bundle/nsis/TiTiTalk-Setup-<version>-x64.exe`。

## 在 macOS 上交叉编译？不行

Tauri 的 Windows 目标依赖 WebView2 SDK + MSVC 工具链，macOS 上原生交叉编译目前无可
靠路径。两种解决：

1. **GitHub Actions（推荐）**：仓库已配 `.github/workflows/build.yml`，windows-latest
   runner 自动出包。push tag `v*` 触发 GitHub Release。
2. **Parallels / 远程 Windows VM**：本地手工编译。

## 发版流程（首版 0.1.0 起步）

1. 改 `src-tauri/tauri.conf.json` 的 `"version"`
2. 改 `src-tauri/Cargo.toml` 的 `version`
3. 改 README 与官网 `tititalk-site/frontend/lib/release.ts` 的 `WIN_VERSION`
4. `git tag v0.1.0 && git push --tags` → GitHub Actions 自动 build + 创建 Release
5. 把 Release artifact 上传到服务器：
   ```sh
   scp TiTiTalk-Setup-0.1.0-x64.exe \
       root@43.106.48.21:/opt/tititalk-site/storage/downloads/
   ssh root@43.106.48.21 "
     cd /opt/tititalk-site/storage/downloads &&
     chmod 644 TiTiTalk-Setup-0.1.0-x64.exe &&
     ln -sfn TiTiTalk-Setup-0.1.0-x64.exe TiTiTalk-windows-latest.exe
   "
   ```
6. 网站前端重新部署（`pnpm build && systemctl restart tititalk-frontend`）

## 代码签名（待办）

首版不签名。买到 EV 代码签名证书（DigiCert / Sectigo / 数安时代等，¥3500–¥6000/年）
后：

```pwsh
signtool sign `
  /tr http://timestamp.digicert.com `
  /td sha256 /fd sha256 `
  /n "TiTiTalk Co." `
  TiTiTalk-Setup-0.1.0-x64.exe
```

签名后将 `backend/app/main.py::_RELEASES["windows"]["signed"]` 设为 `True`。

> EV 证书理论上能立刻拿满 SmartScreen reputation；OV / 普通签名要 1000+ 用户安装才会
> 解除警告。预算允许直接上 EV。

## 关键风险点（实测踩过的坑预防）

| 风险 | 预防 |
|---|---|
| nginx 静态文件 403 | 上传后 `chmod 644`；`mktemp` 默认 0600 → 不可读 |
| WebView2 用户没装 | `tauri.conf.json` 已配 `downloadBootstrapper`，自动下载 |
| 快捷键被微信/QQ 抢占 | `min_hold_ms=150` 过滤误触 + 用户可改键 |
| 长会议 Stream 内存泄漏 | 单次最长 60s 强制截断 |
| 中文路径 `C:\用户\...` | Tauri config 全部用 ASCII；安装路径默认 currentUser |
