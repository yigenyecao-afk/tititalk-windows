//! 桌面伴侣 "说话" 触发逻辑。Mac PetSpeechController.swift 的 Win 等价。
//!
//! 数据流: 各 input → 这里挑文案 → emit `companion-speech` event → 前端 SpeechBubble fade in/out
//!
//! Input 来源：
//!   1. idle 间隔 tokio interval（按 cfg.companion_chattiness 调档；
//!      少 8-15min / 中 3-8min / 多 1-3min）
//!   2. 时段 watcher（跨过早 / 午 / 下午 / 晚 / 深夜边界时各放一次）
//!   3. 事件订阅：
//!        • pipeline phase 边沿 — recording/transcribing/polishing → idle = 录音完成；→ failed = 失败
//!        • PetWindowController 在 single-tap / double-tap / drag-end / long-press 时主动 call notify(...)
//!   4. App 启动时一次性 launch greeting（构造完后 800ms）
//!
//! 防扰动规则（跟 Mac 完全对齐）：
//!   • cfg.companion_voice_enabled = false → 全局静音，所有 input 入口直接 return
//!   • pipeline 在 recording/transcribing/polishing/inserting 中 → idle / time greeting 不冒泡，
//!     只 recordingDone/Error/launch 类直接事件能冒
//!   • 同一条文案 30 分钟内不重复（recently_shown ring buffer）
//!   • 全局节流：任意两次气泡显示之间至少 12 秒（克制感>密集陪伴感）
//!   • 同 scene 30 秒内不重发
//!   • breakSuggestion 20min cooldown
//!   • 同一 app context 类（im/code）3min 不重发

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::state::{AppState, PipelinePhase};

use super::personality::{lines_for, AppCtx, PetID, Scene, TimeSlot};

/// 全局节流：任意两次气泡显示之间至少 12 秒
const MIN_DISPLAY_GAP: Duration = Duration::from_secs(12);
/// 同一类 scene 30 秒内不重发
const SCENE_COOLDOWN: Duration = Duration::from_secs(30);
/// recentlyShown ring buffer 容量（30 略大于单只宠物 idle 池 20 条）
const RECENT_CAP: usize = 30;
/// breakSuggestion 20min cooldown
const BREAK_MIN_GAP: Duration = Duration::from_secs(1200);
/// 应用感知 cooldown：3min 同 context 不重发
const APP_CONTEXT_COOLDOWN: Duration = Duration::from_secs(180);
/// recordingHistory ring buffer 容量（最近 5 次录音完成时间）
const RECORDING_HISTORY_CAP: usize = 5;
/// 疲劳检测窗口：最近 5 次都在 10min 内 → 提醒休息
const FATIGUE_WINDOW: Duration = Duration::from_secs(600);

/// 给前端 SpeechBubble 用——text=Some(...) 显示，text=None 立即隐藏。
/// dwell_ms 是建议停留时长（前端可不用，后端会自动 emit 第二条 clear）。
#[derive(Debug, Clone, Serialize)]
pub struct SpeechPayload {
    pub text: Option<String>,
    pub dwell_ms: u32,
}

/// 把 Scene 收敛成稳定的 cooldown key
fn scene_key(s: &Scene) -> String {
    match s {
        Scene::Idle => "idle".to_string(),
        Scene::TimeGreeting(t) => format!("tg-{:?}", t),
        Scene::SingleTap => "tap".to_string(),
        Scene::DoubleTap => "dtap".to_string(),
        Scene::DragEnd => "drag".to_string(),
        Scene::RecordingDone => "done".to_string(),
        Scene::RecordingError => "err".to_string(),
        Scene::Launch => "launch".to_string(),
        Scene::Petting => "pet".to_string(),
        Scene::DeepPet => "deeppet".to_string(),
        Scene::AppContext(c) => format!("ac-{:?}", c),
        Scene::BreakSuggestion => "break".to_string(),
    }
}

/// PetSpeechController 的 Win 等价。Mac 用 ObservableObject + @Published；
/// 这里用 Arc + 一堆 Mutex/RwLock，spawn task emit event 给前端。
pub struct SpeechController {
    handle: AppHandle,
    app_state: Arc<AppState>,
    /// 当前显示中的气泡文本（None = 隐藏）
    current_speech: Mutex<Option<String>>,
    /// 上次气泡 display 的时刻（全局节流）
    last_displayed_at: Mutex<Option<Instant>>,
    /// 同一 scene cooldown
    scene_last_displayed_at: Mutex<HashMap<String, Instant>>,
    /// 最近 RECENT_CAP 条文案 ring buffer
    recently_shown: Mutex<VecDeque<String>>,
    /// 最近 5 次录音完成时间——疲劳检测
    recording_history: Mutex<VecDeque<Instant>>,
    /// 上次发休息建议的时间
    last_break_at: Mutex<Option<Instant>>,
    /// 上次应用感知触发时刻（按 ctx 区分 → 简单起见单字段够用，反正只 IM/Code 两类）
    #[allow(dead_code)] // app_watcher 在 #[cfg(windows)] 下消费，host 编译看似 dead
    last_app_ctx_at: Mutex<Option<Instant>>,
    /// 上次激活的前台 app exe basename（同 app 不重复触发）
    #[allow(dead_code)]
    last_active_exe: Mutex<Option<String>>,
    /// 上次 phase（用来识别"录音结束"边沿）
    last_phase: Mutex<Option<PipelinePhase>>,
    /// 上次时段问候的 slot（跨边界才再触发一次）
    last_time_slot: Mutex<Option<TimeSlot>>,
    /// 当前 hide task token —— bump 后旧 hide task 放弃
    hide_token: std::sync::atomic::AtomicU64,
    /// (v0.16.2 B2) main window blur 时刻——focus 时检查 elapsed ≥30min
    /// 强冒 launch 招呼。短切（10s 内）不触发。
    last_blurred_at: Mutex<Option<Instant>>,
}

impl SpeechController {
    pub fn new(handle: AppHandle, app_state: Arc<AppState>) -> Arc<Self> {
        let me = Arc::new(Self {
            handle,
            app_state,
            current_speech: Mutex::new(None),
            last_displayed_at: Mutex::new(None),
            scene_last_displayed_at: Mutex::new(HashMap::new()),
            recently_shown: Mutex::new(VecDeque::with_capacity(RECENT_CAP)),
            recording_history: Mutex::new(VecDeque::with_capacity(RECORDING_HISTORY_CAP)),
            last_break_at: Mutex::new(None),
            last_app_ctx_at: Mutex::new(None),
            last_active_exe: Mutex::new(None),
            last_phase: Mutex::new(None),
            last_time_slot: Mutex::new(None),
            hide_token: std::sync::atomic::AtomicU64::new(0),
            last_blurred_at: Mutex::new(None),
        });
        // 启动 idle tick
        Self::spawn_idle_tick(me.clone());
        // 启动后 800ms 蹦一句 launch 招呼
        let me2 = me.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(800)).await;
            me2.notify(Scene::Launch);
        });
        me
    }

    /// 全局开关 + 当前性格
    fn voice_enabled(&self) -> bool {
        self.app_state.config.read().companion_voice_enabled
    }

    fn personality(&self) -> Option<PetID> {
        let slug = self.app_state.config.read().companion_pet_slug.clone();
        PetID::from_slug(&slug)
    }

    fn chattiness(&self) -> u8 {
        self.app_state.config.read().companion_chattiness
    }

    /// pill 显示中（即 ASR 在 active phase）→ 同 Mac state.pillDisplayMode != .hidden
    fn in_active_phase(&self) -> bool {
        matches!(
            self.app_state.current_phase(),
            PipelinePhase::Recording
                | PipelinePhase::Stopping
                | PipelinePhase::Transcribing
                | PipelinePhase::Polishing
                | PipelinePhase::Inserting
        )
    }

    // ---------- 外部 notify 入口 ----------

    /// 行为事件触发说话（PetWindowController 在 single-tap / double-tap /
    /// drag-end / long-press 时调；speech 自己的 idle/time/recording 路径
    /// 也走这里收口）。
    pub fn notify(self: &Arc<Self>, scene: Scene) {
        if !self.voice_enabled() {
            return;
        }
        let Some(pid) = self.personality() else {
            return;
        };
        // pill 显示中只允许 RecordingDone/Error/Launch 直接事件
        if self.in_active_phase() {
            match scene {
                Scene::RecordingDone | Scene::RecordingError | Scene::Launch => {}
                _ => return,
            }
        }
        // 同 scene 节流：30 秒内不重发同款 scene 文案
        let key = scene_key(&scene);
        {
            let mut map = self.scene_last_displayed_at.lock();
            if let Some(last) = map.get(&key) {
                if last.elapsed() < SCENE_COOLDOWN {
                    log::debug!("[companion-speech] scene throttled: {key}");
                    return;
                }
            }
            map.insert(key.clone(), Instant::now());
        }
        if let Some(line) = self.pick_line(pid, scene) {
            self.display(line);
        }
    }

    /// pipeline phase 边沿处理。lib.rs 的 event pump 在 PipelineEvent::Phase
    /// 时调一次，传新 phase；这里跟 last_phase 做边沿对比。
    pub fn on_phase(self: &Arc<Self>, new_phase: PipelinePhase) {
        let prev = {
            let mut g = self.last_phase.lock();
            let prev = *g;
            *g = Some(new_phase);
            prev
        };

        let was_active = matches!(
            prev,
            Some(PipelinePhase::Recording)
                | Some(PipelinePhase::Stopping)
                | Some(PipelinePhase::Transcribing)
                | Some(PipelinePhase::Polishing)
                | Some(PipelinePhase::Inserting)
        );

        // (recording/transcribing/polishing/inserting) → done = 录音成功完成
        // (任意 → failed) = 录音失败
        if was_active && matches!(new_phase, PipelinePhase::Done | PipelinePhase::Idle) {
            // 累计录音完成时间戳
            {
                let mut hist = self.recording_history.lock();
                hist.push_back(Instant::now());
                while hist.len() > RECORDING_HISTORY_CAP {
                    hist.pop_front();
                }
            }
            // 30% 概率冒一句
            if rand_unit() < 0.30 {
                self.notify(Scene::RecordingDone);
            }
            // 疲劳检测：最近 5 次录音都在 10min 内 → 提醒休息
            let should_break = {
                let hist = self.recording_history.lock();
                if hist.len() >= RECORDING_HISTORY_CAP {
                    if let Some(oldest) = hist.front() {
                        oldest.elapsed() < FATIGUE_WINDOW
                    } else {
                        false
                    }
                } else {
                    false
                }
            };
            if should_break && self.should_suggest_break() {
                *self.last_break_at.lock() = Some(Instant::now());
                self.notify(Scene::BreakSuggestion);
            }
        }

        // failed 边沿：60% 概率冒一句
        let prev_failed = matches!(prev, Some(PipelinePhase::Failed));
        if !prev_failed && matches!(new_phase, PipelinePhase::Failed) {
            if rand_unit() < 0.60 {
                self.notify(Scene::RecordingError);
            }
        }
    }

    /// app 切换前台 → 按 IM/Code 关键字 classify → 冒一句。
    /// app_watcher.rs 5s tick 时调；同 exe 不重复触发，自家应用过滤。
    #[allow(dead_code)] // host 编译时 app_watcher 不存在；仅 windows target 真用
    pub fn on_app_activated(self: &Arc<Self>, exe_basename: &str) {
        if !self.voice_enabled() {
            return;
        }
        let exe = exe_basename.to_lowercase();
        // 同 exe 不重复
        {
            let mut last = self.last_active_exe.lock();
            if last.as_deref() == Some(&exe) {
                return;
            }
            *last = Some(exe.clone());
        }
        // 切到 TiTiTalk 自己时不冒泡
        if exe.contains("tititalk") || exe.contains("voiceink") {
            return;
        }
        let Some(kind) = classify_app(&exe) else {
            return;
        };
        // 3min 同 context 不重发
        {
            let mut last = self.last_app_ctx_at.lock();
            if let Some(t) = *last {
                if t.elapsed() < APP_CONTEXT_COOLDOWN {
                    return;
                }
            }
            *last = Some(Instant::now());
        }
        self.notify(Scene::AppContext(kind));
    }

    fn should_suggest_break(&self) -> bool {
        match *self.last_break_at.lock() {
            Some(t) => t.elapsed() > BREAK_MIN_GAP,
            None => true,
        }
    }

    /// (v0.16.2 B2 离场归来) main window 失焦——记 timestamp。
    pub fn on_blurred(self: &Arc<Self>) {
        *self.last_blurred_at.lock() = Some(Instant::now());
    }

    /// (v0.16.2 B2 离场归来) main window 重新获得焦点——如果离场 ≥30min，
    /// 强冒一句 launch 招呼欢迎用户回来。短切（开 finder 一秒回来）不触发。
    pub fn on_focused(self: &Arc<Self>) {
        let blurred = self.last_blurred_at.lock().take();
        if let Some(t) = blurred {
            if t.elapsed() >= Duration::from_secs(30 * 60) {
                log::info!(
                    "[companion-speech] returning from away ≥30min, force launch greeting"
                );
                self.notify(Scene::Launch);
            }
        }
    }

    // ---------- idle timer + 时段问候 ----------

    fn spawn_idle_tick(me: Arc<Self>) {
        tauri::async_runtime::spawn(async move {
            loop {
                let (lo, hi) = me.idle_interval_range();
                let secs = lo + (rand_unit() * (hi - lo) as f64) as u64;
                tokio::time::sleep(Duration::from_secs(secs)).await;
                me.idle_tick();
            }
        });
    }

    /// 根据 chattiness 0..3 给 idle 触发间隔区间（秒）。
    /// 0 = 静音；1 少 8-15min；2 中 3-8min；3 多 1-3min。
    fn idle_interval_range(&self) -> (u64, u64) {
        match self.chattiness() {
            0 => (3600, 7200), // 实际 voice_enabled=false 时 idle 不会发
            1 => (8 * 60, 15 * 60),
            3 => (60, 3 * 60),
            _ => (3 * 60, 8 * 60),
        }
    }

    fn idle_tick(self: &Arc<Self>) {
        if !self.voice_enabled() {
            return;
        }
        if self.personality().is_none() {
            return;
        }
        // pill 显示中跳过 idle / time greeting
        if self.in_active_phase() {
            return;
        }
        // 优先尝试时段问候（如果跨边界）；否则 idle 碎碎念
        if let Some(slot) = self.current_time_slot_if_new() {
            *self.last_time_slot.lock() = Some(slot);
            self.notify(Scene::TimeGreeting(slot));
            return;
        }
        self.notify(Scene::Idle);
    }

    /// 当前是否落在某个时段窗口；返回 None 表示当前不在任何 greeting 窗口，
    /// 或上次已经在同一窗口里发过。
    fn current_time_slot_if_new(&self) -> Option<TimeSlot> {
        use chrono::{Local, Timelike};
        let h = Local::now().hour();
        let slot = match h {
            7..=8 => Some(TimeSlot::Morning),
            11..=12 => Some(TimeSlot::Lunch),
            15 => Some(TimeSlot::AfternoonTea),
            22 => Some(TimeSlot::Evening),
            2..=3 => Some(TimeSlot::LateNight),
            _ => None,
        };
        let s = slot?;
        let prev = *self.last_time_slot.lock();
        if prev == Some(s) {
            return None;
        }
        Some(s)
    }

    // ---------- 文案选取 + 显示 ----------

    fn pick_line(&self, pid: PetID, scene: Scene) -> Option<String> {
        let pool = lines_for(pid, scene);
        if pool.is_empty() {
            return None;
        }
        let recent = self.recently_shown.lock();
        let fresh: Vec<&&str> = pool.iter().filter(|l| !recent.contains(&l.to_string())).collect();
        drop(recent);
        let pick: Option<String> = if fresh.is_empty() {
            pool.get(rand_index(pool.len())).map(|s| s.to_string())
        } else {
            fresh.get(rand_index(fresh.len())).map(|s| (**s).to_string())
        };
        if let Some(p) = pick.as_ref() {
            let mut buf = self.recently_shown.lock();
            buf.push_back(p.clone());
            while buf.len() > RECENT_CAP {
                buf.pop_front();
            }
        }
        pick
    }

    fn display(self: &Arc<Self>, line: String) {
        // 全局节流
        {
            let mut last = self.last_displayed_at.lock();
            if let Some(t) = *last {
                if t.elapsed() < MIN_DISPLAY_GAP {
                    log::debug!(
                        "[companion-speech] display throttled: '{line}' (gap={}s)",
                        t.elapsed().as_secs()
                    );
                    return;
                }
            }
            *last = Some(Instant::now());
        }

        // (v0.16.2 B1 起名) 用户起了名 + 15% 概率 + 短句 ≤12 chars → 前缀
        // 注入 "<name>～"。概率压低保留克制感；前缀只影响输出 line，不影响
        // recently_shown 去重池（基于原 line key）。
        let mut output = line;
        let name = self
            .app_state
            .config
            .read()
            .companion_pet_name
            .trim()
            .to_string();
        if !name.is_empty() && output.chars().count() <= 12 && rand_unit() < 0.15 {
            output = format!("{name}～{output}");
        }

        log::info!("[companion-speech] display: {output}");

        // 字数自适应停留 3-6s（约 0.18s/字 + 2.5s 起步）
        let chars = output.chars().count() as f64;
        let dwell = (2.5 + chars * 0.18).clamp(3.0, 6.0);
        let dwell_ms = (dwell * 1000.0) as u32;

        // bump hide token
        let token = self
            .hide_token
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;

        *self.current_speech.lock() = Some(output.clone());
        let _ = self.handle.emit(
            "companion-speech",
            &SpeechPayload {
                text: Some(output),
                dwell_ms,
            },
        );

        // 计划 dwell 后清空（前端也能自带 timer，但后端兜底保证状态一致）
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(dwell_ms as u64)).await;
            // 比对 token；中间被 display() 抢占了就放弃
            if me.hide_token.load(std::sync::atomic::Ordering::SeqCst) != token {
                return;
            }
            *me.current_speech.lock() = None;
            let _ = me.handle.emit(
                "companion-speech",
                &SpeechPayload {
                    text: None,
                    dwell_ms: 0,
                },
            );
        });
    }
}

// ---------- helpers ----------

/// classify exe basename (lowercase) → IM / Code / None。
/// Win 用 .exe basename 而非 macOS bundleID。
#[allow(dead_code)] // host 编译时 on_app_activated 是 dead_code 的；仅 windows target 真用
pub fn classify_app(exe_lower: &str) -> Option<AppCtx> {
    // IM / 通讯
    const IM_KEYS: &[&str] = &[
        "wechat",
        "wxwork",
        "dingtalk",
        "feishu",
        "lark",
        "slack",
        "outlook",
        "thunderbird",
        "telegram",
        "discord",
    ];
    // 编辑器 / IDE / 终端
    const CODE_KEYS: &[&str] = &[
        "code",
        "cursor",
        "devenv",
        "studio64",
        "idea64",
        "pycharm64",
        "webstorm64",
        "rustrover64",
        "rider64",
        "sublime_text",
        "notepad++",
        "windowsterminal",
        "wt",
    ];
    // (v0.16.2) leisure 类：娱乐/视频/音乐/游戏。Win 用户多半浏览器看 B 站，
    // 后端拿不到 url，所以 leisure 主要靠桌面 app exe basename 命中。优先级
    // 高于 IM/Code（按 leisure → im → code 顺序），避免 keyword 撞名。
    const LEISURE_KEYS: &[&str] = &[
        "bilibili",
        "cloudmusic",  // 网易云 PC
        "qqmusic",
        "wemusic",
        "iqiyi",
        "youku",
        "spotify",
        "netflix",
        "steam",
    ];
    if LEISURE_KEYS.iter().any(|k| exe_lower.contains(k)) {
        return Some(AppCtx::Leisure);
    }
    if IM_KEYS.iter().any(|k| exe_lower.contains(k)) {
        return Some(AppCtx::Im);
    }
    if CODE_KEYS.iter().any(|k| exe_lower.contains(k)) {
        return Some(AppCtx::Code);
    }
    None
}

/// 0..1 浮点随机数。基于 SystemTime nanos 跑一遍 SplitMix64 — 不掏 rand crate
/// 的依赖（companion 是次要 feature，加 dep 不值）。质量足够 idle/概率分支用。
fn rand_unit() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64 ^ d.as_secs())
        .unwrap_or(0);
    // SplitMix64 一步
    let mut z = nanos.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z = z ^ (z >> 31);
    // 保留高 53 bit 转成 [0,1)
    (z >> 11) as f64 / ((1u64 << 53) as f64)
}

fn rand_index(len: usize) -> usize {
    if len == 0 {
        return 0;
    }
    (rand_unit() * len as f64) as usize % len
}
