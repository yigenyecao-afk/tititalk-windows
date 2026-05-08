//! WASAPI capture + WAV encoding + pipeline orchestration.
//!
//! `cpal::Stream` is not `Send`, so we keep it owned by a dedicated OS thread.
//! Communication is via channels:
//!  - main → capture thread: a `stop` signal (parking_lot Mutex<bool>)
//!  - capture thread → main: a oneshot `Sender<CapturedAudio>` once the stream ends
//!
//! Resampling: most consumer mics deliver 44.1k or 48k stereo float; we collapse to
//! mono and resample-by-decimation to 16k i16 with a tiny anti-alias decimation filter.
//! Quality is more than enough for short-form ASR (DashScope Qwen) and matches what the
//! Mac client does.

use std::io::Cursor;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::asr;
use crate::insertion;
use crate::state::{AppState, PipelineEvent, PipelinePhase};
use crate::stylist;

const TARGET_SR: u32 = 16_000;
/// 短句模式 5 min — paraformer-realtime-v2 streams comfortably to this length,
/// matches server WS session cap (MAX_SESSION_SEC=300), and lifts the old 60s wall.
/// (v0.15.0 长录音工作台) 用户从「记录」tab 显式 arm 长录音 → 走 config
/// `long_recording_max_sec`（默认 1800/30min；Pro 可拉到 7200/2h，旗舰 21600/6h）。
/// 走 current_max_duration_secs() 动态 dispatch；buffer 仍 const 初值 5min，
/// Vec 会自动 grow。
const MAX_DURATION_SECS: f32 = 300.0;

/// (v0.15.0) 当前 session 的 cap — armed 走长录音上限，否则 5min。
/// 进入 capture loop 那刻 snapshot 一次；loop 内不变。
fn current_max_duration_secs() -> f32 {
    let cfg = crate::config::load_config();
    if cfg.long_recording_armed {
        cfg.long_recording_max_sec.max(60) as f32
    } else {
        MAX_DURATION_SECS
    }
}

/// (v0.15.0) one-shot disarm — orchestrate_stop / orchestrate_cancel 调一次。
/// 写回 cfg.json + 同步运行时 state.config 内存副本，让前端轮询 cfg 的代码立刻
/// 看到 long_recording_armed=false。Mac VoicePipeline.stop()/cancel() 同语义。
fn disarm_long_recording_if_armed(state: &Arc<AppState>) {
    let mut needs_save = false;
    {
        let mut cfg = state.config.write();
        if cfg.long_recording_armed {
            cfg.long_recording_armed = false;
            needs_save = true;
        }
    }
    if needs_save {
        let snapshot = state.config.read().clone();
        let _ = crate::config::save_config(&snapshot);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapturedAudio {
    pub samples_i16: Vec<i16>,
    pub sample_rate: u32,
    pub duration_secs: f32,
}

impl CapturedAudio {
    pub fn to_wav_bytes(&self) -> anyhow::Result<Vec<u8>> {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: self.sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut buf: Vec<u8> = Vec::with_capacity(self.samples_i16.len() * 2 + 64);
        {
            let mut writer = hound::WavWriter::new(Cursor::new(&mut buf), spec)?;
            for s in &self.samples_i16 {
                writer.write_sample(*s)?;
            }
            writer.finalize()?;
        }
        Ok(buf)
    }
}

struct CaptureHandle {
    stop_flag: Arc<Mutex<bool>>,
    rx: Option<oneshot::Receiver<anyhow::Result<CapturedAudio>>>,
    /// (v0.7.6) tititalk_cloud 流式：start 时持有 → stop 用 stop_tx 通知
    /// asr_stream 任务进 finish + await final_rx 拿文本。其他引擎为 None。
    stream: Option<crate::asr_stream::StreamHandle>,
}

/// Currently active recording. Cleared when stop completes.
static ACTIVE: once_cell::sync::Lazy<Mutex<Option<CaptureHandle>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

/// (v0.7.6) tititalk_cloud 流式 PCM 出口。orchestrate_start 在跑流式 session
/// 前装上；capture 线程的 process_chunk_* 把 i16 LE bytes 同时塞进 collected +
/// 这个 channel。stop 后清。其他引擎为 None → process_chunk 直接跳过 push。
/// Mutex 是必须的（capture 线程 + orchestrator 都要写），但读路径竞争极轻。
static STREAMING_PCM_TX: once_cell::sync::Lazy<Mutex<Option<tokio::sync::mpsc::UnboundedSender<Vec<u8>>>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

pub async fn orchestrate_start(state: Arc<AppState>) {
    // 权限预检：在 set_phase(Recording) 之前确认麦克风可用，避免「pill 亮了
    // 红点用户开始说话，结果系统弹框遮住、直到松手才发现没录到」。预检即
    // 调用 default_input_config —— 跟真录音同一条路径，最准确，比只查
    // device.name() 靠谱。失败直接 Notice + 不进入 Recording phase。
    if let Err(reason) = preflight_microphone() {
        // 用 Error 走 HomeView lastError Banner（sticky），不再用 Notice 弹 toast。
        // 跟 Mac VoicePipeline 对齐：录音前置错误统一靠 Banner 而非 toast。
        state.emit(PipelineEvent::Error { message: reason });
        return;
    }

    state.set_phase(PipelinePhase::Recording);
    state.emit(PipelineEvent::Sound { sound: "start".into() });

    // (v0.8.3 P0-5) settings.mute_system_during_recording=true → 静音系统输出，
    // 避免扬声器声音被麦克风采进去。orchestrate_stop 末尾对应 restore。
    if state.config.read().mute_system_during_recording {
        crate::system_audio_muter::mute();
    }

    let stop_flag = Arc::new(Mutex::new(false));
    let (tx, rx) = oneshot::channel::<anyhow::Result<CapturedAudio>>();
    let stop_flag_thr = stop_flag.clone();
    let event_tx = state.event_tx.clone();

    // (HOTFIX 2026-05-03) start_session_async 立刻返回 handle，prepare（fetch
    // ticket + WS 握手 + 等 ready）在后台 task 跑。caller 立刻 set
    // STREAMING_PCM_TX 让 capture 线程开始往 channel 推 PCM —— 握手期间 PCM
    // buffer 在 unbounded channel 里，ready 后主循环 first iteration drain。
    // 旧路径 await start_session 让 capture 线程在 500-1500ms 握手期间根本没
    // 起，用户开口的前 1-2 句直接进虚空。失败信号通过 final_rx 在 stop 时
    // 暴露 → orchestrate_stop 检测到 final_rx Err 后回退 batch。
    let cfg_engine = state.config.read().engine.clone();
    let stream_handle = if cfg_engine == "tititalk_cloud" {
        // (ISSUE-2 2026-05-03) cold-connect 期间 pill 显示「连接云端」让用户
        // 知道是网络等待。ready 抵达后 asr_stream 自己 emit connecting=false。
        state.emit(PipelineEvent::CloudConnecting { connecting: true });
        let h = crate::asr_stream::start_session_async(state.clone(), TARGET_SR);
        *STREAMING_PCM_TX.lock() = Some(h.pcm_tx.clone());
        Some(h)
    } else {
        None
    };

    std::thread::Builder::new()
        .name("tititalk-capture".into())
        .spawn(move || {
            let result = capture_blocking(stop_flag_thr, event_tx);
            let _ = tx.send(result);
        })
        .expect("spawn capture thread");

    *ACTIVE.lock() = Some(CaptureHandle {
        stop_flag,
        rx: Some(rx),
        stream: stream_handle,
    });
}

/// (v0.8.3 P0-3) ESC 取消录音 —— 跟 stop 不同：丢弃 PCM、不转写、不插入。
/// 也回收 system mute / cloud ws / streaming pcm tx 等所有副作用。
pub async fn orchestrate_cancel(state: Arc<AppState>) {
    // (v0.15.0) 长录音 one-shot disarm — 跟 Mac VoicePipeline.cancel() 对齐。
    disarm_long_recording_if_armed(&state);
    let (rx, stream_handle) = {
        let mut active = ACTIVE.lock();
        let Some(handle) = active.as_mut() else {
            // idempotent —— 没活跃 session 时不报错，回到 idle
            state.set_phase(PipelinePhase::Idle);
            return;
        };
        *handle.stop_flag.lock() = true;
        (handle.rx.take(), handle.stream.take())
    };
    // ws 流式断 —— 不发 stop event，直接 drop（服务端会自己 timeout 清 ticket）
    if let Some(h) = stream_handle {
        let _ = h.stop_tx.send(());
    }
    // capture 线程 join；丢弃 captured（不转写）
    if let Some(rx) = rx {
        let _ = rx.await;
    }
    *STREAMING_PCM_TX.lock() = None;
    *ACTIVE.lock() = None;
    if state.config.read().mute_system_during_recording {
        crate::system_audio_muter::restore();
    }
    state.set_phase(PipelinePhase::Idle);
    state.emit(PipelineEvent::Notice { message: "已取消".into() });
}

pub async fn orchestrate_stop(state: Arc<AppState>) {
    // (v0.15.0) 长录音 one-shot disarm — 跟 Mac VoicePipeline.stop() 对齐。
    disarm_long_recording_if_armed(&state);
    state.set_phase(PipelinePhase::Stopping);
    state.emit(PipelineEvent::Sound { sound: "stop".into() });

    // (v0.8.3 P0-5) 配对 mute() —— mute_system_during_recording 开启时恢复系统
    // 输出。用 saturating depth 嵌套保护，多次 stop 只有最外层真写。
    if state.config.read().mute_system_during_recording {
        crate::system_audio_muter::restore();
    }

    // 拿出 capture rx + 流式 handle（如果有）；ACTIVE 即时清掉
    let (rx, stream_handle) = {
        let mut active = ACTIVE.lock();
        let Some(handle) = active.as_mut() else {
            // (v0.7.8) idempotent —— 双 stop 调（hotkey 重入残留 / Tauri cmd
            // 跟 hotkey 同时触发）不再红 banner「no active recording」，回到 Idle。
            log::debug!("orchestrate_stop called with no ACTIVE — already stopped");
            state.set_phase(PipelinePhase::Idle);
            return;
        };
        *handle.stop_flag.lock() = true;
        (handle.rx.take(), handle.stream.take())
    };
    // (v0.7.8) ⚠️ STREAMING_PCM_TX 不能在这里清 —— capture 线程刚收到 stop_flag，
    // 还要把残留 PCM flush 出来。提前清会让残留帧 send 到 None channel 被丢弃，
    // 服务端看到 bytes=0 reason=4004。改成「rx.await 拿到 captured 后再清」，
    // 那时 capture 线程已经 100% 退出，channel 不再有写者。

    let Some(rx) = rx else {
        *STREAMING_PCM_TX.lock() = None;
        return;
    };

    let captured = match rx.await {
        Ok(Ok(audio)) => audio,
        Ok(Err(e)) => {
            *STREAMING_PCM_TX.lock() = None;
            *ACTIVE.lock() = None;
            state.set_phase(PipelinePhase::Failed);
            state.emit(PipelineEvent::Error { message: e.to_string() });
            return;
        }
        Err(_) => {
            *STREAMING_PCM_TX.lock() = None;
            *ACTIVE.lock() = None;
            state.set_phase(PipelinePhase::Failed);
            state.emit(PipelineEvent::Error {
                message: "capture channel dropped".into(),
            });
            return;
        }
    };
    // (v0.7.8) capture 100% 退出，现在清 STREAMING_PCM_TX 安全
    *STREAMING_PCM_TX.lock() = None;
    *ACTIVE.lock() = None;

    *state.current_audio.write() = Some(captured.clone());
    state.set_phase(PipelinePhase::Transcribing);

    let cfg = state.config.read().clone();

    // (v0.7.6) 优先走流式 final；只有 stream_handle 是 None 或 streaming 失败
    // 才回退 batch。
    let raw_result: anyhow::Result<String> = if let Some(handle) = stream_handle {
        let _ = handle.stop_tx.send(()); // 通知 ws 任务发 stop 事件
        // final_rx 等服务端 final；本地 30s 上限够长（服务端 5min cap，但单条
        // 60s 录音 flush 通常 <2s）。失败 fallback batch。
        match tokio::time::timeout(std::time::Duration::from_secs(30), handle.final_rx).await {
            Ok(Ok(Ok(text))) => {
                // 成功 —— 清空 partial（pill 上的过程文消失，下面 transcript 替代）
                state.emit(PipelineEvent::Partial { text: String::new() });
                Ok(text)
            }
            Ok(Ok(Err(e))) => {
                log::warn!("streaming final err, fallback to batch: {e}");
                state.emit(PipelineEvent::Partial { text: String::new() });
                asr::transcribe(&cfg, &captured, &state).await
            }
            Ok(Err(_canceled)) => {
                log::warn!("streaming final channel closed, fallback to batch");
                state.emit(PipelineEvent::Partial { text: String::new() });
                asr::transcribe(&cfg, &captured, &state).await
            }
            Err(_timeout) => {
                log::warn!("streaming final timeout 30s, fallback to batch");
                state.emit(PipelineEvent::Partial { text: String::new() });
                asr::transcribe(&cfg, &captured, &state).await
            }
        }
    } else {
        asr::transcribe(&cfg, &captured, &state).await
    };

    let raw = match raw_result {
        Ok(t) => t,
        Err(e) => {
            // (v0.14.0 双 SKU) 本地引擎失败时不自动 fallback —— Local SKU 用户
            // 买 Local 版就是要本地，强切云端违反预期。给友好错误 + 重试建议。
            // Cloud SKU local engine 在 preflight 已经被拦截走不到这里。
            let err_msg = if cfg.engine == "local" {
                format!(
                    "本地引擎转写失败：{}。请重试一次；如果反复失败可在「设置 → 引擎」切到 TiTiTalk 云端。",
                    e
                )
            } else {
                e.to_string()
            };
            state.set_phase(PipelinePhase::Failed);
            state.emit(PipelineEvent::Error { message: err_msg });
            return;
        }
    };

    // (P0-5 2026-05-06) 跟 Mac VoicePipeline `trimmedRaw.count < 2` 对齐——
    // 极短转写（噪音/单词）不走 polish/insert/billing：避免空转 polish 浪费配额、
    // 避免空字符串 paste 把用户原 clipboard 污染、避免历史落入 1 字符垃圾条。
    let trimmed_raw = raw.trim();
    if trimmed_raw.chars().count() < 2 {
        log::info!("[short-transcript-guard] dropping {} chars", trimmed_raw.chars().count());
        state.set_phase(PipelinePhase::Done);
        return;
    }

    // (v0.14.0 M3 伪 partial 流) Local 引擎一次性出全文，Cloud 流式逐字。
    // 为体验对齐：local 路径把 raw 切 5 段，每 50ms emit Partial 让 pill 动画追字。
    // SenseVoice 不支持真流式，这是补救方案 — 用户感知「字一段段冒出来」而不是
    // 「啪一下全显」。Cloud 路径已经是真流式不走这里。
    if cfg.engine == "local" {
        let chars: Vec<char> = trimmed_raw.chars().collect();
        let seg_count = chars.len().min(5).max(1);
        let step_size = (chars.len() / seg_count).max(1);
        let mut emitted = 0usize;
        for _ in 0..seg_count {
            emitted = (emitted + step_size).min(chars.len());
            let slice: String = chars[..emitted].iter().collect();
            state.emit(PipelineEvent::Partial { text: slice });
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        // 清空 partial — 接下来的 transcript / polish 接管显示
        state.emit(PipelineEvent::Partial { text: String::new() });
    }

    // Stylist post-processing — opt-in. Failure falls back to raw with a warning,
    // never blocks insertion (paste must always happen on the user's gesture).
    let text = if cfg.stylist_enabled {
        state.set_phase(PipelinePhase::Polishing);
        // (v0.7.4 polish-fix) 全程日志：起手 / 结束 / 失败 都打 elapsed + engine
        // + model + text_len，复现「润色超时」时一眼看穿走的 cloud 还是 BYOK，
        // 慢在哪一步。
        let polish_t0 = std::time::Instant::now();
        log::info!(
            "polish start: engine={} model={} stylist_persona={} text_len={}",
            cfg.engine, cfg.stylist_model, cfg.stylist_persona, raw.chars().count()
        );
        match stylist::polish(&cfg, &raw, &state).await {
            Ok(p) if !p.trim().is_empty() => {
                log::info!(
                    "polish done: engine={} elapsed={:.2}s output_len={}",
                    cfg.engine, polish_t0.elapsed().as_secs_f32(), p.chars().count()
                );
                p
            }
            Ok(_) => {
                log::warn!(
                    "polish returned empty: engine={} elapsed={:.2}s — falling back to raw",
                    cfg.engine, polish_t0.elapsed().as_secs_f32()
                );
                // FIX-21 (qa-2026-05-03): 跟 Mac 措辞对齐——「已用原文」是
                // Mac 端 stylist 失败时的 pill 文案，Win 端原本写「已落原始
                // 转写」表达不一致（WIN-004）。
                state.emit(PipelineEvent::Error {
                    message: "已用原文｜云端润色返回空".into(),
                });
                raw.clone()
            }
            Err(e) => {
                log::warn!(
                    "polish failed: engine={} elapsed={:.2}s err={e} — falling back to raw",
                    cfg.engine, polish_t0.elapsed().as_secs_f32()
                );
                // FIX-21: 失败文案改「已用原文｜润色失败：xxx」跟 Mac 一致。
                state.emit(PipelineEvent::Error {
                    message: format!("已用原文｜润色失败：{e}"),
                });
                raw.clone()
            }
        }
    } else {
        raw.clone()
    };

    // (v0.8.3 P0-2) 客户端最后一道排版清洁：CJK ↔ Latin 边界自动加空格。
    // polish 后端模型偶尔忘加（v0.8.3 后已写进 system prompt，但旧请求/网络重试
    // 路径仍可能漏），verbatim 模式更必需。
    let text = crate::text_post_process::normalize(&text, cfg.cjk_auto_space);

    // (v0.8.4 P1-2) 词汇检测 —— 后台扫陌生英文 token 计数（不阻塞 insert）。
    // 总开关 OFF 直接 no-op；ON 走 hotword_candidate::observe 累计 + 落 disk。
    if cfg.hotword_suggestion_enabled {
        let snap = text.clone();
        let dict = cfg.dictionary.clone();
        std::thread::spawn(move || {
            crate::hotword_candidate::observe(&snap, &dict, true);
        });
    }

    state.emit(PipelineEvent::Transcript { text: text.clone() });

    if cfg.auto_insert {
        state.set_phase(PipelinePhase::Inserting);
        // (v0.8.3 P0-4) also_copy=true 时：除了插入光标也复制到剪贴板，跟 Mac
        // autoCopyToClipboard 同源。注意 cfg.also_copy 旧字段已存在（v0.7 用），
        // 旧用户 false → 新行为不变。
        match insertion::insert_text(&text, cfg.also_copy, Some(state.clone())) {
            Ok(()) => {
                state.set_phase(PipelinePhase::Done);
            }
            Err(e) => {
                // Fall back to clipboard-only
                let _ = insertion::copy_to_clipboard(&text);
                state.set_phase(PipelinePhase::Failed);
                state.emit(PipelineEvent::Error {
                    message: format!("插入失败，已复制到剪贴板：{e}"),
                });
            }
        }
    } else {
        let _ = insertion::copy_to_clipboard(&text);
        state.set_phase(PipelinePhase::Done);
    }
}

/// 录音前轻量级麦克风可用性 + 权限预检。
/// 走 cpal 同一条路径（host → default_input_device → default_input_config）
/// —— 跟真录音失败的根因一致，不会出现「预检过了，真录音又炸」。
/// 返回 Ok(()) 代表可以走，Err(message) 是给用户看的人话（不带 internal err）。
pub fn preflight_microphone() -> Result<(), String> {
    let host = cpal::default_host();
    let device = host.default_input_device().ok_or_else(|| {
        "找不到麦克风。请插好麦克风，或到「Windows 设置 → 隐私和安全 → 麦克风」开启。".to_string()
    })?;
    device.default_input_config().map_err(|e| {
        log::warn!("preflight cfg err: {e}");
        // cpal 的 default_input_config 失败几乎都是权限或独占；不区分细节，
        // 给用户最 actionable 的指引。
        "麦克风暂时不可用。常见原因：① Windows 隐私设置里 TiTiTalk \
         没有麦克风权限；② 被其他应用独占（QQ、Teams、Zoom 等）。\
         点「打开 Windows 麦克风设置」开启权限，或先关掉抢占的应用。"
            .to_string()
    })?;
    Ok(())
}

/// (P1 hotkey→partial 加速 2026-05-05) 后台预热 cpal/WASAPI 子系统。
///
/// Windows 上首次调 `cpal::default_host().default_input_device()` 要做：
///   1. COM init 进 MTA（之前没初始化的话）
///   2. 创建 IMMDeviceEnumerator → 查询默认 capture endpoint
///   3. 加载 WASAPI driver（声卡 driver 冷加载 ~30-100ms 不等）
///   4. 缓存 IAudioClient（cpal 内部 Drop 后下次建 stream 还能复用 driver-loaded 状态）
/// 第一次冷启动总成本 ~50-300ms，预热后 default_input_device + default_input_config
/// 落到 <5ms，省掉用户按 hotkey 时的同步等待。
///
/// **不调** `device.build_input_stream(...)` —— 那会真打开 WASAPI capture session
/// （占设备 handle、可能跟用户其它录音 app 冲突），prewarm 不该承担副作用。
///
/// 在 lib.rs setup 阶段 spawn_blocking 跑（cpal 是 blocking API，不能直接 .await）。
/// 失败 silent —— prewarm 是 best-effort，失败时下次 hotkey 走冷路径，行为兼容。
pub fn prewarm_audio_device() {
    let host = cpal::default_host();
    let dev = match host.default_input_device() {
        Some(d) => d,
        None => {
            log::debug!("audio prewarm: no default input device, skipping");
            return;
        }
    };
    match dev.default_input_config() {
        Ok(cfg) => {
            log::info!(
                "audio device prewarmed: sr={}, ch={}, fmt={:?}",
                cfg.sample_rate().0, cfg.channels(), cfg.sample_format()
            );
        }
        Err(e) => {
            log::debug!("audio prewarm: default_input_config failed: {e}");
        }
    }
}

fn capture_blocking(
    stop_flag: Arc<Mutex<bool>>,
    event_tx: tokio::sync::mpsc::UnboundedSender<PipelineEvent>,
) -> anyhow::Result<CapturedAudio> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| anyhow!(
            "找不到麦克风。请插好麦克风，并到 Windows 设置 → 隐私和安全 → 麦克风 \
             允许 TiTiTalk 访问。"
        ))?;
    let supported = device
        .default_input_config()
        .map_err(|e| anyhow!(
            "麦克风配置读取失败：{e}。常见原因：Windows 隐私设置里 TiTiTalk \
             没有麦克风权限，或被其他应用独占。"
        ))?;

    let src_sr = supported.sample_rate().0;
    let channels = supported.channels() as usize;
    let format = supported.sample_format();

    let cfg: StreamConfig = supported.into();
    let collected: Arc<Mutex<Vec<i16>>> = Arc::new(Mutex::new(Vec::with_capacity(
        (TARGET_SR as f32 * MAX_DURATION_SECS) as usize,
    )));
    let collected_cb = collected.clone();
    let event_tx_cb = event_tx.clone();

    // 录音中设备拔出 / driver 抽风时 cpal 会从 OS 侧推 err 上来。原来这里
    // 只 log 不通知前端 —— 用户面对一段沉默的「录音中…」直到松手才知道炸了。
    // 现在升级为 Notice，pill 上能立刻看到。capture 线程仍会按 stop_flag 退
    // 出，由 orchestrate_stop 接管 → 走完正常 Failed/Done 流。
    let err_event_tx = event_tx.clone();
    let err_fn = move |e: cpal::StreamError| {
        log::error!("audio stream error: {e}");
        let msg = match &e {
            cpal::StreamError::DeviceNotAvailable => {
                "麦克风设备已断开（拔出 USB 麦 / 蓝牙断连？）。请重新插上后再试。".to_string()
            }
            cpal::StreamError::BackendSpecific { err } => {
                format!("音频驱动异常：{}。请重新插拔麦克风或重启 TiTiTalk。", err)
            }
        };
        // 用 Error（HomeView lastError Banner sticky）替代 Notice toast，避免
        // 跟前端音频设备状态显示重复
        let _ = err_event_tx.send(PipelineEvent::Error { message: msg });
    };

    let stream = match format {
        SampleFormat::F32 => device.build_input_stream(
            &cfg,
            move |data: &[f32], _: &_| {
                process_chunk_f32(data, channels, src_sr, &collected_cb, &event_tx_cb);
            },
            err_fn,
            None,
        )?,
        SampleFormat::I16 => device.build_input_stream(
            &cfg,
            move |data: &[i16], _: &_| {
                process_chunk_i16(data, channels, src_sr, &collected_cb, &event_tx_cb);
            },
            err_fn,
            None,
        )?,
        SampleFormat::U16 => device.build_input_stream(
            &cfg,
            move |data: &[u16], _: &_| {
                let as_i16: Vec<i16> =
                    data.iter().map(|s| (*s as i32 - 32_768) as i16).collect();
                process_chunk_i16(&as_i16, channels, src_sr, &collected_cb, &event_tx_cb);
            },
            err_fn,
            None,
        )?,
        other => return Err(anyhow!("不支持的采样格式 {other:?}")),
    };

    stream.play().map_err(|e| anyhow!(
        "启动音频流失败：{e}。如果是首次使用，请在 Windows 系统弹出的「允许 \
         TiTiTalk 访问麦克风」对话框点同意；已经拒绝过的话，去「设置 → 隐私 \
         → 麦克风」手动开启。"
    ))?;

    let start = std::time::Instant::now();
    let session_cap = current_max_duration_secs();
    while !*stop_flag.lock() {
        if start.elapsed().as_secs_f32() > session_cap {
            log::warn!("hit max duration {session_cap}s, force stop");
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(stream);

    let samples = std::mem::take(&mut *collected.lock());
    let duration_secs = samples.len() as f32 / TARGET_SR as f32;
    Ok(CapturedAudio {
        samples_i16: samples,
        sample_rate: TARGET_SR,
        duration_secs,
    })
}

fn process_chunk_f32(
    data: &[f32],
    channels: usize,
    src_sr: u32,
    collected: &Arc<Mutex<Vec<i16>>>,
    event_tx: &tokio::sync::mpsc::UnboundedSender<PipelineEvent>,
) {
    let mono: Vec<f32> = if channels <= 1 {
        data.to_vec()
    } else {
        data.chunks(channels)
            .map(|c| c.iter().sum::<f32>() / channels as f32)
            .collect()
    };
    let resampled = decimate_to_target(&mono, src_sr);
    let mut sum_sq = 0.0f64;
    let mut buf = Vec::with_capacity(resampled.len());
    for s in &resampled {
        let clamped = s.max(-1.0).min(1.0);
        sum_sq += (clamped as f64) * (clamped as f64);
        buf.push((clamped * 32_767.0) as i16);
    }
    collected.lock().extend_from_slice(&buf);
    // (v0.7.6) 流式 ASR 旁路 —— 跟 collected 双写。i16 LE bytes 直接推 ws 任务。
    // STREAMING_PCM_TX 只在 tititalk_cloud 引擎 + start_session 成功时才有；
    // 其它引擎 None → 这里直接跳过，0 开销。channel send 失败（已 close）也
    // 安全忽略，capture 线程不该因为 ws 出问题而崩。
    if !buf.is_empty() {
        if let Some(tx) = STREAMING_PCM_TX.lock().clone() {
            let mut bytes = Vec::with_capacity(buf.len() * 2);
            for s in &buf {
                bytes.extend_from_slice(&s.to_le_bytes());
            }
            let _ = tx.send(bytes);
        }
    }
    if !resampled.is_empty() {
        let rms = (sum_sq / resampled.len() as f64).sqrt() as f32;
        let _ = event_tx.send(PipelineEvent::Level { rms });
    }
}

fn process_chunk_i16(
    data: &[i16],
    channels: usize,
    src_sr: u32,
    collected: &Arc<Mutex<Vec<i16>>>,
    event_tx: &tokio::sync::mpsc::UnboundedSender<PipelineEvent>,
) {
    let as_f: Vec<f32> = data.iter().map(|s| *s as f32 / 32_768.0).collect();
    process_chunk_f32(&as_f, channels, src_sr, collected, event_tx);
}

/// Naive integer-ratio decimation with leading boxcar filter — good enough for
/// 48k → 16k speech. Not phase-perfect, but DashScope/Whisper handle it fine.
fn decimate_to_target(mono: &[f32], src_sr: u32) -> Vec<f32> {
    if src_sr == TARGET_SR || src_sr == 0 {
        return mono.to_vec();
    }
    let ratio = src_sr as f32 / TARGET_SR as f32;
    if ratio <= 1.0 {
        // upsample (rare): linear interpolate
        let out_len = (mono.len() as f32 / ratio).round() as usize;
        let mut out = Vec::with_capacity(out_len);
        for i in 0..out_len {
            let src_idx = i as f32 * ratio;
            let lo = src_idx.floor() as usize;
            let hi = (lo + 1).min(mono.len().saturating_sub(1));
            let f = src_idx - lo as f32;
            out.push(mono[lo] * (1.0 - f) + mono[hi] * f);
        }
        return out;
    }
    let step = ratio as usize;
    let mut out = Vec::with_capacity(mono.len() / step.max(1) + 1);
    let win = step.max(1);
    let mut idx = 0usize;
    while idx + win <= mono.len() {
        let avg: f32 = mono[idx..idx + win].iter().sum::<f32>() / win as f32;
        out.push(avg);
        idx += win;
    }
    // (v0.7.8) 残余样本兜底 —— 旧版 while 退出时 mono[idx..] 直接丢，
    // 短音频（<100ms）尾部被截，dashscope 收到比预期短的字节流时
    // 会判 NO_VALID_AUDIO_ERROR。补上残余 box-car 平均，最后一帧留住。
    if idx < mono.len() {
        let tail = &mono[idx..];
        let avg: f32 = tail.iter().sum::<f32>() / tail.len() as f32;
        out.push(avg);
    }
    out
}
