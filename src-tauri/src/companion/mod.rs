//! Wave 4 — 桌面伴侣（pet companion）。
//!
//! Mac 端 4 文件 (Sources/VoiceInk/Companion/) 的 Win 等价：
//!   • state.rs   = PetCompanion.swift   — Mood/Facing 状态机 + transient 自动复位
//!   • catalog.rs = PetCatalog.swift     — bundled + ~/.codex/pets/ merge
//!   • window.rs  = PetWindowController + PetView 行为机 — 30fps wander tick / pill 联动
//!
//! 渲染由前端 React 完成（companion.html → CompanionApp.tsx → PetView.tsx）；
//! 后端只负责状态机 + 30fps set_position + emit `companion-state` 给前端。
//!
//! 跨端区别：
//!   • Mac 用 GCD asyncAfter；Win 用 tokio::spawn + AtomicU64 token 比对。
//!   • Mac UserDefaults 持久化窗口位置；Win 落 `<config_dir>/TiTiTalk/companion-position.json`。
//!   • Mac NSImage CGImage 切片；Win 把整张 spritesheet.webp 当 background-image，
//!     用 CSS `background-position: -col*192px -row*208px` 切帧（零像素操作，快）。

pub mod catalog;
pub mod state;
pub mod window;

// (v1.1 性格化陪伴) 文案库 / 触发逻辑 / 应用感知 watcher
pub mod personality;
pub mod speech;
#[cfg(windows)]
pub mod app_watcher;
