//! (v0.7.6) tititalk_cloud 真流式 ASR — WebSocket 客户端。
//!
//! 跟 Mac `Speech/TiTiTalkCloudASRClient.swift` 协议完全对齐：
//!   1. `GET /api/asr/ticket?sample_rate=16000` 拿一次性 ticket（Bearer 鉴权）
//!   2. 用 `wss://tititalk.com/api/asr/stream?ticket=...` 连 WebSocket
//!   3. 收到 `{event:ready}` 后开始推 binary PCM 帧（i16 LE 16kHz mono）
//!   4. 收到 `{event:partial|sentence|final|error}` JSON → emit `PipelineEvent`
//!   5. caller 通过 `stop_tx` 通知结束 → 客户端发 `{event:stop}` → 服务端 flush
//!      最后一句 → 发 `{event:final, text, ...}` → 关 WS
//!
//! 商业化保护全在服务端（ticket 单次 + 服务端按 PCM 字节实时计费），客户端
//! 只是一个干净的传输层。

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

use crate::state::{AppState, PipelineEvent};

/// caller 拿到这个 handle：用 `stop_tx.send(())` 通知 WS 任务发 stop 事件
/// + 等服务端 final；用 `final_rx.await` 拿到最终文本。
pub struct StreamHandle {
    /// 发 () 通知 WS 任务进入 finish 流（client → server "stop"）。
    /// 多次发只首次生效（后续 send 失败被忽略）。
    pub stop_tx: oneshot::Sender<()>,
    /// final 文本 channel。Ok(text) = 服务端 final 正常收到；
    /// Err 表示流式失败（caller 不应 fallback 给 batch 因为 PCM 已经在服务端）。
    pub final_rx: oneshot::Receiver<anyhow::Result<String>>,
    /// PCM 推送通道。caller 在 process_chunk 里塞 i16 LE bytes。
    /// 没有 send 给 channel = WS 任务不发数据；通道 close = WS 任务收 EOF。
    pub pcm_tx: mpsc::UnboundedSender<Vec<u8>>,
}

#[derive(Deserialize)]
struct TicketResp {
    ticket: String,
    ws_url: String,
}

/// 真正起 WS session：fetch ticket → connect → 等 ready → 进主循环。
/// 所有步骤都在 spawn 的 task 里跑，prepare 失败用 final_tx.send(Err) 通知 caller。
/// (HOTFIX 2026-05-03) 抽出来供 start_session_async 用 —— 让 caller 不用 await
/// prepare 完成就能拿 handle，提前起 capture 线程，PCM 在握手期间 buffer 进
/// pcm_rx unbounded channel，ready 后主循环 first iteration 立刻 drain。
pub fn start_session_async(state: Arc<AppState>, sample_rate: u32) -> StreamHandle {
    let (pcm_tx, pcm_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let (final_tx, final_rx) = oneshot::channel::<anyhow::Result<String>>();

    tauri::async_runtime::spawn(async move {
        match prepare_and_run(state, sample_rate, pcm_rx, stop_rx).await {
            Ok(text) => { let _ = final_tx.send(Ok(text)); }
            Err(e) => {
                log::warn!("tititalk-cloud streaming task failed: {e}");
                let _ = final_tx.send(Err(e));
            }
        }
    });

    StreamHandle { stop_tx, final_rx, pcm_tx }
}

async fn prepare_and_run(
    state: Arc<AppState>,
    sample_rate: u32,
    pcm_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    stop_rx: oneshot::Receiver<()>,
) -> anyhow::Result<String> {
    let session = start_session(state, sample_rate).await?;
    session.run(pcm_rx, stop_rx).await
}

/// prepare 阶段的产物：握手好的 ws + event channel。run() 接 pcm_rx + stop_rx
/// 跑主循环。把「握手」跟「主循环」拆开是为了让 caller 能在 prepare 期间已经
/// 起 capture（pcm 进 unbounded channel buffer），ready 后 first iteration drain。
struct StreamSession {
    ws_sink: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        Message,
    >,
    ws_stream: futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    >,
    event_tx: tokio::sync::mpsc::UnboundedSender<PipelineEvent>,
}

async fn start_session(state: Arc<AppState>, sample_rate: u32) -> anyhow::Result<StreamSession> {
    // 1. 取 access token —— 没登录直接 fail
    let acc = state
        .account
        .read()
        .clone()
        .ok_or_else(|| anyhow!("未登录 TiTiTalk — 请在「设置 → 账号」登录后重试"))?;
    let access = acc
        .access_token()
        .ok_or_else(|| anyhow!("登录已失效，请到「设置 → 账号」重新登录后重试。"))?;

    // 2. GET /api/asr/ticket（如果 401 就 refresh 一次再试）
    let ticket = match fetch_ticket(&access, sample_rate).await {
        Ok(t) => t,
        Err(e) if e.to_string().contains("401") => {
            log::info!("ASR ticket 401 — refreshing access token + retrying once");
            acc.try_refresh_now()
                .await
                .map_err(|e| anyhow!("登录已失效，请到「设置 → 账号」重新登录后重试：{e}"))?;
            let access2 = acc
                .access_token()
                .ok_or_else(|| anyhow!("登录状态异常，请到「设置 → 账号」重新登录。"))?;
            fetch_ticket(&access2, sample_rate).await?
        }
        Err(e) => return Err(e),
    };

    // 3. 连 WS（ticket 已在 ws_url query）
    let (ws_stream, _resp) = tokio_tungstenite::connect_async(&ticket.ws_url)
        .await
        .with_context(|| format!("连 ASR WebSocket 失败：{}", ticket.ws_url))?;
    let (mut ws_sink, mut ws_stream) = ws_stream.split();

    // 4. 等 ready 事件 —— 5s 上限，跟 Mac 对齐
    let ready_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let now = tokio::time::Instant::now();
        if now >= ready_deadline {
            return Err(anyhow!("等待 ASR 就绪超时（5s）— 检查网络"));
        }
        let remain = ready_deadline - now;
        let msg = tokio::time::timeout(remain, ws_stream.next())
            .await
            .map_err(|_| anyhow!("等待 ASR 就绪超时（5s）— 检查网络"))?;
        let msg = msg.ok_or_else(|| anyhow!("ASR 连接被服务端立即断开"))?;
        let msg = msg.context("ASR WebSocket 读失败")?;
        match msg {
            Message::Text(s) => {
                let event: serde_json::Value = serde_json::from_str(&s)
                    .with_context(|| format!("ASR 事件 JSON 解析失败: {s}"))?;
                let kind = event.get("event").and_then(|v| v.as_str()).unwrap_or("");
                if kind == "ready" {
                    log::info!("tititalk-cloud ASR ws ready");
                    break;
                } else if kind == "error" {
                    let code = event.get("code").and_then(|v| v.as_str()).unwrap_or("");
                    let m = event.get("message").and_then(|v| v.as_str()).unwrap_or("ASR 错");
                    return Err(anyhow!("ASR 拒绝连接 [{code}]: {m}"));
                }
                // 其他事件（不该有）忽略，继续等 ready
            }
            Message::Close(frame) => {
                let info = frame.map(|f| format!("{} {}", f.code, f.reason)).unwrap_or_default();
                return Err(anyhow!("ASR 服务端关闭连接：{info}"));
            }
            _ => continue,
        }
    }

    // (HOTFIX 2026-05-03) prepare 完成 → 把 ws/sink/stream 打包成 StreamSession 给
    // caller。caller 在 prepare 期间已经把 capture 起来，PCM buffer 在 pcm_rx
    // unbounded channel 里，session.run() 主循环 first iteration 立刻 drain。
    let event_tx = state.event_tx.clone();
    Ok(StreamSession { ws_sink, ws_stream, event_tx })
}

impl StreamSession {
    /// 主循环：select! 轮询三个 source：pcm_rx / stop_rx / ws_stream。
    async fn run(
        self,
        mut pcm_rx: mpsc::UnboundedReceiver<Vec<u8>>,
        stop_rx: oneshot::Receiver<()>,
    ) -> anyhow::Result<String> {
        let StreamSession { mut ws_sink, mut ws_stream, event_tx } = self;
        let mut stop_rx = stop_rx;
        let mut stop_sent = false;
        let mut final_text: Option<String> = None;
        let mut error_msg: Option<String> = None;
        // 服务端 5min session cap，本地保险 320s 兜底；正常 stop_rx 会先来。
        let session_deadline = tokio::time::Instant::now() + Duration::from_secs(320);

        loop {
            tokio::select! {
                _ = tokio::time::sleep_until(session_deadline) => {
                    log::warn!("tititalk-cloud ws session 320s soft-cap reached, breaking");
                    break;
                }
                // PCM 入 → 转发；channel close（caller drop pcm_tx）正常情况是
                // caller 已经走 stop_tx 路径，这里 None 直接 break 主循环。
                pcm = pcm_rx.recv() => {
                    match pcm {
                        Some(bytes) => {
                            // (v0.7.8) 即便 stop_sent，pcm_rx 里仍可能有 buffered PCM
                            // 没发出去（capture flush 跟 stop_tx.send 之间有几 ms gap）。
                            // 旧版 `if stop_sent { continue }` 把它们全丢了 →
                            // 服务端看到 bytes=0 reason=4004。改成「无论 stop_sent 都发」，
                            // 服务端 ASR provider 容忍 stop 后再来 PCM（按到达顺序处理）。
                            if let Err(e) = ws_sink.send(Message::Binary(bytes)).await {
                                log::warn!("tititalk-cloud ws send pcm failed: {e}");
                                error_msg = Some(format!("ASR 推流失败：{e}"));
                                break;
                            }
                        }
                        None => {
                            // pcm_tx dropped without explicit stop —— 视为隐式停
                            if !stop_sent {
                                let _ = ws_sink.send(Message::Text(r#"{"event":"stop"}"#.into())).await;
                                stop_sent = true;
                            }
                        }
                    }
                }
                // 用户停 → 先 drain pcm_rx 的 buffered 帧再发 stop 事件，等服务端 final。
                // (v0.7.8) 不 drain 直接发 stop 会有 race：select! pcm 路径还没拿到
                // 最后几个 chunk，stop 已发到服务端 → 服务端按 stop 立刻关 →
                // bytes=0 reason=4004。
                _ = &mut stop_rx, if !stop_sent => {
                    while let Ok(bytes) = pcm_rx.try_recv() {
                        if let Err(e) = ws_sink.send(Message::Binary(bytes)).await {
                            log::warn!("tititalk-cloud ws drain pcm before stop failed: {e}");
                            break;
                        }
                    }
                    if let Err(e) = ws_sink.send(Message::Text(r#"{"event":"stop"}"#.into())).await {
                        log::warn!("tititalk-cloud ws send stop failed: {e}");
                        error_msg = Some(format!("ASR 结束信号失败：{e}"));
                        break;
                    }
                    stop_sent = true;
                    log::info!("tititalk-cloud ws stop sent, waiting final...");
                }
                // 读服务端事件
                msg = ws_stream.next() => {
                    let Some(msg) = msg else {
                        log::info!("tititalk-cloud ws stream ended");
                        break;
                    };
                    let msg = match msg {
                        Ok(m) => m,
                        Err(e) => {
                            log::warn!("tititalk-cloud ws recv err: {e}");
                            error_msg = Some(format!("ASR 接收失败：{e}"));
                            break;
                        }
                    };
                    match msg {
                        Message::Text(s) => {
                            let event: serde_json::Value = match serde_json::from_str(&s) {
                                Ok(v) => v,
                                Err(e) => {
                                    log::warn!("tititalk-cloud ws bad JSON: {e} body={s}");
                                    continue;
                                }
                            };
                            let kind = event.get("event").and_then(|v| v.as_str()).unwrap_or("");
                            match kind {
                                "partial" | "sentence" => {
                                    let text = event.get("text").and_then(|v| v.as_str()).unwrap_or("");
                                    if !text.is_empty() {
                                        let _ = event_tx.send(PipelineEvent::Partial { text: text.into() });
                                    }
                                }
                                "final" => {
                                    let text = event.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                    let cost = event.get("cost_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                                    let used = event.get("used_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                                    log::info!("tititalk-cloud ws final cost={cost} used={used} text_len={}", text.chars().count());
                                    final_text = Some(text);
                                    // 服务端会自己 close → 下一个 select tick 拿到 Close，自然退
                                }
                                "error" => {
                                    let code = event.get("code").and_then(|v| v.as_str()).unwrap_or("");
                                    let m = event.get("message").and_then(|v| v.as_str()).unwrap_or("ASR 错");
                                    log::warn!("tititalk-cloud ws error event [{code}]: {m}");
                                    error_msg = Some(format!("[{code}] {m}"));
                                    // 不立即 break —— 服务端通常马上跟 close
                                }
                                "ready" => {
                                    // late ready, 忽略
                                }
                                other => {
                                    log::debug!("tititalk-cloud ws unknown event: {other}");
                                }
                            }
                        }
                        Message::Binary(_) => {}
                        Message::Close(frame) => {
                            // (v0.7.8) 把服务端 4001-4006 关闭码映射成人话给 UI
                            // —— 旧版只 log，用户看到「ASR 失败」却不知是配额/超时/重连
                            let mapped = frame.as_ref().and_then(|f| {
                                let code: u16 = f.code.into();
                                match code {
                                    4001 => Some("登录已失效，请到「设置 → 账号」重新登录".to_string()),
                                    4002 => Some("今日云端配额已用完 — 重置时间在明天 0 点（北京）".to_string()),
                                    4003 => Some("检测到另一台设备正在录音 — 请关闭后再试".to_string()),
                                    4004 => Some("ASR 超时（5 分钟单段上限或长时间静音）— 已停止".to_string()),
                                    4005 => Some("ASR 服务暂时不可用，请稍后重试（百炼后端波动）".to_string()),
                                    4006 => Some("录音超过 5 分钟单段上限 — 自动停止".to_string()),
                                    _ => None,
                                }
                            });
                            if let Some(msg) = mapped {
                                log::warn!("tititalk-cloud ws closed with mapped code: {msg}");
                                if final_text.is_none() && error_msg.is_none() {
                                    error_msg = Some(msg);
                                }
                            } else {
                                let info = frame.map(|f| format!("{} {}", f.code, f.reason)).unwrap_or_default();
                                log::info!("tititalk-cloud ws closed: {info}");
                            }
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }

        // close 拿不到不影响正确性
        let _ = ws_sink.send(Message::Close(None)).await;

        // final 优先；error 次之；都没就当 client 异常退
        if let Some(t) = final_text {
            Ok(t)
        } else if let Some(e) = error_msg {
            Err(anyhow!(e))
        } else {
            Err(anyhow!("ASR 连接异常结束（无 final，无错）"))
        }
    }
}

async fn fetch_ticket(access: &str, sample_rate: u32) -> anyhow::Result<TicketResp> {
    let url = format!("https://tititalk.com/api/asr/ticket?sample_rate={sample_rate}");
    // 单独建个 client 即可（ticket 调一次/session，没必要复用）。
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(8))
        .build()
        .context("build reqwest client")?;
    let resp = client
        .get(&url)
        .bearer_auth(access)
        .send()
        .await
        .context("拉 ASR ticket 网络失败")?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        // 错误格式跟 batch 路径同：{detail:{error,message}} or {detail:string}
        // 让 caller 看到 status 数字方便 401-refresh 路径判断
        return Err(anyhow!("ticket 请求失败 {status}: {body}"));
    }
    let parsed: TicketResp = serde_json::from_str(&body)
        .with_context(|| format!("ticket 响应解析失败: {body}"))?;
    Ok(parsed)
}
