# TiTiTalk Windows

按住快捷键说话 · 松开自动转写到光标处。Windows 10/11 上的语音输入法，
Mac 端 [TiTiTalk](https://tititalk.com) 的同门兄弟。

| | macOS 端 | Windows 端 |
|---|---|---|
| 当前版本 | 2.10.13 | 0.1.0（首版） |
| 技术栈 | Swift / SwiftUI / AppKit | Tauri 2 + Rust + React + Tailwind |
| 安装包 | DMG ~6 MB | NSIS ~10 MB |
| 代码签名 | Developer ID | **暂无（首启 SmartScreen 警告）** |

## 安装与首次运行

1. 从 [tititalk.com](https://tititalk.com) 下载 `TiTiTalk-Setup-x.y.z-x64.exe`，或者从 GitHub Releases 拿。
2. 双击运行——首次会弹出 **Windows 已保护你的电脑** 蓝色警告（SmartScreen）：
   - 点 **更多信息** → **仍要运行**
   - 这是因为本版未做代码签名（EV 证书 ~¥3500/年待购），不是病毒
3. 安装完成后程序常驻系统托盘（屏幕右下角）
4. 第一次打开请去 **设置 → 语音识别**，填入 API key（推荐百炼 Qwen）
5. 按住 **F1** 说话，松开自动转写并粘贴到当前光标

> 如果下载下来的 `.exe` 双击没反应，右键 → **属性** → 勾选下面的 **解除锁定（Unblock）** → 应用 → 再双击。这是 Windows 对从浏览器下载的未签名 `.exe` 的「Mark of the Web」机制。

## 系统要求

- Windows 10 1809（10.0.17763）及以上 / Windows 11
- x64 架构（暂不支持 ARM64，下个版本加）
- WebView2 运行时（Win11 自带；Win10 由安装包自动下载）
- 麦克风权限

## 与 Mac 端的差异（v0.1.0 范围）

Mac 端 35K LOC 35 大模块，Windows 首版 Slice 1 范围只覆盖最核心的录制 → 转写 → 插入回路：

| 模块 | Mac | Windows v0.1 | 计划 |
|---|---|---|---|
| 全局热键（按住说话） | ✓ | ✓ | — |
| WASAPI 音频采集 | ✓ (CoreAudio) | ✓ | — |
| 百炼 Qwen ASR | ✓ | ✓ | — |
| OpenAI Whisper | ✓ | ✓ | — |
| 本地 Whisper.cpp | ✓ | ✗ | v0.3 |
| 文字插入（剪贴板兜底） | ✓ | ✓ | — |
| 悬浮 Pill | ✓ | ✓ | — |
| 设置 / 词典 / 历史 | ✓ | ✓ 简化版 | v0.2 完整版 |
| Account / License / 配额 | ✓ | ✗ | v0.2 |
| Stylist 后处理 | ✓ | ✗ | v0.3 |
| 自动更新（Sparkle / Tauri updater） | ✓ | ✗（手动下载） | v0.2 |

## 开发与构建

见 [BUILD.md](./BUILD.md)。

## License

MIT，与 Mac 端同步。

## 反馈

bug / 建议：[hi@tititalk.com](mailto:hi@tititalk.com) 或 GitHub Issues。
