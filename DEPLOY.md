# Deploy Cheatsheet · TiTiTalk Windows v0.1.0

剩下要在你机器上手跑的步骤（凡涉及远程仓库 / 生产服务器，都不该 AI 替跑）。
按顺序执行，预计总耗时 ~15 分钟（其中 GitHub Actions 自动跑 ~8 min）。

---

## 1. 推 GitHub（~2 min）

GitHub 上手动建空仓库 `tititalk-windows`（Public 或 Private 都可），不要勾 README/license（已有）。然后：

```bash
cd /Users/lingyin/Documents/tititalk-windows
git remote add origin git@github.com:<你的用户名>/tititalk-windows.git
git push -u origin main
```

如果偏好 `gh`：
```bash
gh repo create tititalk-windows --source=. --remote=origin --push --private
```

push 完成的瞬间 `.github/workflows/build.yml` 会自动触发，去 GitHub Actions tab 看绿勾。

---

## 2. 出首版正式包并触发 GitHub Release（~10 min）

```bash
cd /Users/lingyin/Documents/tititalk-windows
git tag v0.1.0
git push --tags
```

Actions windows-latest runner 会：
1. 装 Rust + pnpm + Node 20
2. `pnpm exec tauri icon` 生成多尺寸 .ico/.png（这步**必跑**，否则 NSIS 找不到 icon.ico）
3. `pnpm build` 出前端 dist/
4. `pnpm exec tauri build --bundles nsis` 出 `TiTiTalk-Setup-0.1.0-x64.exe`
5. 计算 SHA256 → 上传 artifact + 自动建 GitHub Release（因为是 tag push）

跑完后去 Releases 页拿 `.exe`（也可以从 Actions 的 artifact 拉）。

---

## 3. 上传到 tititalk.com（~2 min）

⚠️ 动到生产服务器 `43.106.48.21`。先确认手上是 .exe + SHA256SUMS.txt。

```bash
# 假设 exe 已下载到 ~/Downloads/
EXE=~/Downloads/TiTiTalk-Setup-0.1.0-x64.exe

scp "$EXE" root@43.106.48.21:/opt/tititalk-site/storage/downloads/

ssh root@43.106.48.21 <<'REMOTE'
  set -e
  cd /opt/tititalk-site/storage/downloads
  chmod 644 TiTiTalk-Setup-0.1.0-x64.exe       # ← 别忘，nginx 0600 → 403（项目 v2.10.12 踩过的坑）
  ln -sfn TiTiTalk-Setup-0.1.0-x64.exe TiTiTalk-windows-latest.exe
  ls -la TiTiTalk-windows-latest.exe TiTiTalk-Setup-0.1.0-x64.exe
REMOTE
```

确认 `https://tititalk.com/downloads/TiTiTalk-windows-latest.exe` 能正常 200 + 下载（curl -I 看头）。

---

## 4. 部署网站前端 + 后端改动（~3 min）

我已经在本地改好这几个文件，**还没推到 git**：

```
tititalk-site/frontend/lib/release.ts       (+EXE_URL, +WIN_VERSION)
tititalk-site/frontend/app/page.tsx         (Nav dropdown / Hero / Final CTA / FAQ / Footer)
tititalk-site/backend/app/main.py           (/api/release/latest?platform=windows 分流)
tititalk-site/storage/downloads/README.md   (NEW，部署 checklist)
tititalk-site/storage/downloads/appcast-win.xml  (NEW，Tauri updater 占位)
```

部署：

```bash
cd /Users/lingyin/Documents/tititalk-site
git status                                   # 应该看到上面 5 个文件
git add -A
git commit -m "feat(release): 加 Windows v0.1.0 下载入口 + /api/release/latest?platform 分流"
git push                                     # 假设线上有 webhook 自动 deploy；没有继续看下一步

# 如果生产是 systemd 拉本地路径（不通过 git pull），手动同步：
ssh root@43.106.48.21 <<'REMOTE'
  cd /opt/tititalk-site && git pull
  cd frontend && pnpm install --prod && pnpm build
  systemctl restart tititalk-frontend tititalk-api
  systemctl status tititalk-frontend tititalk-api --no-pager
REMOTE
```

---

## 5. 抽查（~2 min）

| 检查 | 期望 |
|---|---|
| 浏览 https://tititalk.com | Hero 双按钮 macOS / Windows 同时显示 |
| 点 Nav 里"下载" | 出现两行 dropdown |
| 点 Windows 按钮 | 浏览器开始下载 .exe（10 MB 左右） |
| `curl -s https://tititalk.com/api/release/latest?platform=windows \| jq` | 返回 v0.1.0 + signed:false |
| 双击 .exe | SmartScreen 蓝屏（**这是预期行为**） → 更多信息 → 仍要运行 → 进入 NSIS 安装向导 |
| 安装后系统托盘有 TiTiTalk 图标 | ✓ |
| 设置里填百炼 key → 测试 → "OK" | ✓ |
| 按住 F1 说话 → 松开 → 文字插入到 Notepad | ✓ |

---

## 6. 灰飞回滚（如果出大问题）

```bash
ssh root@43.106.48.21 <<'REMOTE'
  cd /opt/tititalk-site/storage/downloads
  rm TiTiTalk-windows-latest.exe              # 立刻让下载链接 404
REMOTE

# 网站文案回退
cd /Users/lingyin/Documents/tititalk-site
git revert HEAD
git push
```

下一步再修问题，重发 v0.1.1。

---

## 已知首版限制（用户问到再答即可）

- **未签名 → SmartScreen 警告**：买 EV 证书前每位首装用户都会看到。README 已写绕行。
- **无本地 Whisper.cpp**：必须有 API key。v0.3 加。
- **无 Account / 配额 / License**：站点用户体系没接入；v0.2 计划。
- **无 ARM64**：Surface Pro X 不能用；下版本加 `--target aarch64-pc-windows-msvc`。
- **无自动更新**：首装后还要手动重新下载新版本；v0.2 接 Tauri updater + appcast-win.json。
