//! Thin reqwest wrapper for tititalk.com REST. Centralises:
//!   • base URL + JSON contract
//!   • Bearer attachment via a closure (so we don't depend on Account)
//!   • One automatic refresh-then-retry on 401, coalesced via the
//!     account's single-flight refresh task
//!   • `X-User-Plan` header tap → forwarded to a callback (plan drift
//!     detection per spec §9.6 step 4)
//!
//! UI / state mutation happens in `auth.rs`; this file is the network
//! boundary only.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use reqwest::{header, Client, Method, Response, StatusCode};
use serde::{de::DeserializeOwned, Serialize};
use thiserror::Error;

pub const BASE_URL: &str = "https://tititalk.com";

#[derive(Debug, Error)]
pub enum ApiError {
    /// 网络层 raw error；保留原 reqwest::Error 让上层看 Display 时能 debug。
    /// UI 用 `friendly_message()` 拿翻译过的中文，不直接用 Display。
    #[error("transport: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("not logged in")]
    NotLoggedIn,
    #[error("http {status}: {message}")]
    Http {
        status: u16,
        code: Option<String>,
        message: String,
        /// 后端 detail.dict 里所有非 error/message 字段 —— 给 UI 拿额外
        /// 上下文（如 device_limit_reached 的 manage_url / device_count）。
        /// 空 dict 表示后端没附带或 detail 是字符串型。
        extras: std::collections::BTreeMap<String, serde_json::Value>,
    },
    #[error("decode: {0}")]
    Decode(String),
}

/// Transport 错误的具体子类型 —— 给前端做精准提示。
/// reqwest::Error 没有 enum 区分这些，要从 is_*() 方法逐个判。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkErrorKind {
    /// DNS 失败 / 路由不可达（is_connect && err 包含 "dns" / "name resolution"）
    Offline,
    /// 服务可达但请求超时
    Timeout,
    /// 服务端 TLS / cert 问题
    Tls,
    /// 其他（builder error / decode error / unknown）
    Other,
}

impl ApiError {
    pub fn status(&self) -> Option<u16> {
        match self {
            ApiError::Http { status, .. } => Some(*status),
            _ => None,
        }
    }
    pub fn code(&self) -> Option<&str> {
        match self {
            ApiError::Http { code, .. } => code.as_deref(),
            _ => None,
        }
    }
    /// Server-provided human-readable message (after `parse_error_body`
    /// unpacks FastAPI's `{"detail": ...}` wrapping). Empty string for
    /// non-HTTP errors. Prefer this over hardcoding strings on the
    /// client when the server already returns user-facing copy that
    /// includes details (e.g. `device_count: 3/3` for device_limit).
    pub fn message(&self) -> &str {
        match self {
            ApiError::Http { message, .. } => message.as_str(),
            _ => "",
        }
    }

    /// 取 detail dict 里的某个 string 字段（如 device_limit_reached 的
    /// `manage_url`）。其他类型字段拿不到 —— 调 `extras()` 自己处理。
    pub fn extra_str(&self, key: &str) -> Option<String> {
        match self {
            ApiError::Http { extras, .. } => {
                extras.get(key).and_then(|v| v.as_str()).map(String::from)
            }
            _ => None,
        }
    }

    /// 把任何 ApiError 翻译成给用户看的人话。Transport 走 NetworkErrorKind
    /// 分类；HTTP 走 message（已经是后端 friendly 文案 + parse_error_body 兜过）。
    /// UI 直接调这个方法，不要再自己拼字符串 —— 双端口径一致。
    pub fn friendly_message(&self) -> String {
        match self {
            ApiError::Transport(e) => match Self::network_kind(e) {
                NetworkErrorKind::Offline => {
                    "无法连接 tititalk.com — 请检查网络（Wi-Fi 是否连接？是否开了代理或 VPN？）".into()
                }
                NetworkErrorKind::Timeout => {
                    "请求超时 — 服务可达但响应过慢，请稍后重试。如果持续，可能是网络拥塞或服务繁忙。".into()
                }
                NetworkErrorKind::Tls => {
                    "TLS / 证书校验失败 — 系统时间是否准确？是否有抓包工具拦截 HTTPS？".into()
                }
                NetworkErrorKind::Other => format!("网络错误：{e}"),
            },
            ApiError::NotLoggedIn => "尚未登录，请到「设置 → 账号」登录。".into(),
            ApiError::Http { status, message, .. } => {
                if *status == 429 {
                    "请求过于频繁，稍等几秒再试。".into()
                } else if message.is_empty() {
                    format!("服务器返回 HTTP {status}")
                } else {
                    message.clone()
                }
            }
            ApiError::Decode(s) => format!("响应解析失败：{s}"),
        }
    }

    /// reqwest::Error 没有 kind enum，只能 is_connect / is_timeout / is_request
    /// 一个个问。注意：is_connect 同时包括 DNS 失败 + TCP 拒绝，对用户都
    /// 表现为「连不上」 —— 一并归为 Offline。
    fn network_kind(e: &reqwest::Error) -> NetworkErrorKind {
        if e.is_timeout() {
            return NetworkErrorKind::Timeout;
        }
        if e.is_connect() {
            return NetworkErrorKind::Offline;
        }
        // TLS 错误埋在 source chain 里 —— 字符串嗅探。比较糙，但 reqwest 没
        // 暴露更好的钩子。
        let s = e.to_string().to_ascii_lowercase();
        if s.contains("tls") || s.contains("certificate") || s.contains("ssl") {
            return NetworkErrorKind::Tls;
        }
        if s.contains("dns") || s.contains("name resolution") {
            return NetworkErrorKind::Offline;
        }
        NetworkErrorKind::Other
    }
}

/// Async closure returning the current access token (or None if logged
/// out). Cheap — called for every authed request.
pub type TokenProvider = Arc<dyn Fn() -> Option<String> + Send + Sync>;

/// Async closure that triggers a refresh — returns `Ok(())` on success
/// (a fresh token is now retrievable from the provider) or `Err` if
/// refresh failed (caller will surface the original 401).
pub type RefreshHandler = Arc<
    dyn Fn() -> Pin<Box<dyn Future<Output = Result<(), ApiError>> + Send>> + Send + Sync,
>;

/// Plan-header observer — called with the X-User-Plan value (if any)
/// from every response. Idempotent on no-op (same plan).
pub type PlanObserver = Arc<dyn Fn(Option<String>) + Send + Sync>;

#[derive(Clone)]
pub struct ApiClient {
    http: Client,
    token: TokenProvider,
    refresh: RefreshHandler,
    on_plan: PlanObserver,
    user_agent: String,
}

impl ApiClient {
    pub fn new(
        token: TokenProvider,
        refresh: RefreshHandler,
        on_plan: PlanObserver,
        client_version: String,
    ) -> Self {
        let http = Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .connect_timeout(std::time::Duration::from_secs(8))
            .build()
            .expect("reqwest client");
        Self {
            http,
            token,
            refresh,
            on_plan,
            user_agent: format!("TiTiTalk-windows/{client_version}"),
        }
    }

    // ---- public surface --------------------------------------------------

    pub async fn post<Req: Serialize, Resp: DeserializeOwned>(
        &self,
        path: &str,
        body: &Req,
        authed: bool,
    ) -> Result<Resp, ApiError> {
        let bytes = self
            .send_with_retry(Method::POST, path, Some(serde_json::to_vec(body).map_err(|e| ApiError::Decode(e.to_string()))?), authed, &[])
            .await?;
        decode(&bytes)
    }

    pub async fn get<Resp: DeserializeOwned>(&self, path: &str) -> Result<Resp, ApiError> {
        let bytes = self
            .send_with_retry(Method::GET, path, None, true, &[])
            .await?;
        decode(&bytes)
    }

    pub async fn put<Req: Serialize, Resp: DeserializeOwned>(
        &self,
        path: &str,
        body: &Req,
        extra_headers: &[(&str, String)],
    ) -> Result<Resp, ApiError> {
        let bytes = self
            .send_with_retry(
                Method::PUT,
                path,
                Some(serde_json::to_vec(body).map_err(|e| ApiError::Decode(e.to_string()))?),
                true,
                extra_headers,
            )
            .await?;
        decode(&bytes)
    }

    pub async fn delete(&self, path: &str) -> Result<(), ApiError> {
        let _ = self
            .send_with_retry(Method::DELETE, path, None, true, &[])
            .await?;
        Ok(())
    }

    // ---- internals -------------------------------------------------------

    async fn send_with_retry(
        &self,
        method: Method,
        path: &str,
        body: Option<Vec<u8>>,
        authed: bool,
        extra_headers: &[(&str, String)],
    ) -> Result<Vec<u8>, ApiError> {
        let resp = self
            .send_once(method.clone(), path, body.clone(), authed, extra_headers)
            .await?;
        let status = resp.status();
        if status == StatusCode::UNAUTHORIZED && authed {
            // Try one refresh-then-retry. If refresh itself fails, surface
            // the ORIGINAL 401 so the user sees "session expired" not
            // "refresh failed" (less confusing in UI).
            let _drained = resp.bytes().await.ok();
            if (self.refresh)().await.is_err() {
                return Err(ApiError::Http {
                    status: 401,
                    code: Some("token_expired".into()),
                    message: "登录已失效，请重新登录".into(),
                    extras: std::collections::BTreeMap::new(),
                });
            }
            let resp2 = self
                .send_once(method, path, body, authed, extra_headers)
                .await?;
            return self.finalize(resp2).await;
        }
        self.finalize(resp).await
    }

    async fn finalize(&self, resp: Response) -> Result<Vec<u8>, ApiError> {
        // Tap X-User-Plan BEFORE consuming body — header still readable post-await.
        let plan = resp
            .headers()
            .get("x-user-plan")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        (self.on_plan)(plan);

        let status = resp.status();
        let bytes = resp.bytes().await?.to_vec();
        if status.is_success() {
            return Ok(bytes);
        }
        let (code, message, extras) = parse_error_body(&bytes, status.as_u16());
        Err(ApiError::Http {
            status: status.as_u16(),
            code,
            message,
            extras,
        })
    }

    async fn send_once(
        &self,
        method: Method,
        path: &str,
        body: Option<Vec<u8>>,
        authed: bool,
        extra_headers: &[(&str, String)],
    ) -> Result<Response, ApiError> {
        let url = format!("{BASE_URL}{path}");
        let mut req = self.http.request(method, &url);
        req = req
            .header(header::ACCEPT, "application/json")
            .header(header::USER_AGENT, &self.user_agent);
        if let Some(b) = body {
            req = req.header(header::CONTENT_TYPE, "application/json").body(b);
        }
        if authed {
            let tok = (self.token)().ok_or(ApiError::NotLoggedIn)?;
            if tok.is_empty() {
                return Err(ApiError::NotLoggedIn);
            }
            req = req.bearer_auth(tok);
        }
        for (k, v) in extra_headers {
            req = req.header(*k, v);
        }
        Ok(req.send().await?)
    }
}

fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, ApiError> {
    serde_json::from_slice(bytes).map_err(|e| ApiError::Decode(e.to_string()))
}

/// Pull `(code, message)` out of a server error response. The backend uses
/// FastAPI, which wraps `HTTPException` into one of three shapes:
///
///   1. `{"detail": "username_taken"}`         — string detail (most common)
///   2. `{"detail": {"error": "...", "message": "...", ...}}` — dict detail
///      (used when the server wants to attach extra hints, e.g. the
///      `device_limit_reached` 409 carries a `manage_url` field)
///   3. `{"error": "...", "message": "..."}`   — legacy / future
///
/// We try them in order. Without this, every server error came through as
/// `code=None` + `message="HTTP <status>"`, which broke client branches like
/// `e.code() == Some("device_limit_reached")` /
/// `e.code() == Some("refresh_invalid")` /
/// `e.code() == Some("version_mismatch")` — the user just saw bare HTTP
/// status codes instead of friendly Chinese explainers.
/// Returns `(code, message, extras)` where `extras` is the rest of the
/// detail dict minus `error`/`message` —— `manage_url` / `device_count` /
/// `unlock_hint` 等 extra context 走这里给 UI 用。
fn parse_error_body(
    bytes: &[u8],
    status: u16,
) -> (
    Option<String>,
    String,
    std::collections::BTreeMap<String, serde_json::Value>,
) {
    use std::collections::BTreeMap;
    let v: serde_json::Value = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(_) => return (None, format!("HTTP {status}"), BTreeMap::new()),
    };

    // Shape 1 + 2: `{"detail": ...}`
    if let Some(detail) = v.get("detail") {
        if let Some(s) = detail.as_str() {
            // FastAPI string detail — that string IS the code. No extras.
            return (Some(s.to_string()), s.to_string(), BTreeMap::new());
        }
        if let Some(obj) = detail.as_object() {
            let code = obj.get("error").and_then(|x| x.as_str()).map(String::from);
            let message = obj
                .get("message")
                .and_then(|x| x.as_str())
                .map(String::from)
                .or_else(|| code.clone())
                .unwrap_or_else(|| format!("HTTP {status}"));
            // 把除 error/message 之外的字段全收走（BTreeMap 保证 stable order
            // 方便测试 / log 比对）。
            let mut extras = BTreeMap::new();
            for (k, v) in obj.iter() {
                if k != "error" && k != "message" {
                    extras.insert(k.clone(), v.clone());
                }
            }
            return (code, message, extras);
        }
    }

    // Shape 3: top-level {error, message}
    let code = v.get("error").and_then(|x| x.as_str()).map(String::from);
    let message = v
        .get("message")
        .and_then(|x| x.as_str())
        .map(String::from)
        .or_else(|| code.clone())
        .unwrap_or_else(|| format!("HTTP {status}"));
    let mut extras = BTreeMap::new();
    if let Some(obj) = v.as_object() {
        for (k, v) in obj.iter() {
            if k != "error" && k != "message" && k != "detail" {
                extras.insert(k.clone(), v.clone());
            }
        }
    }
    (code, message, extras)
}
