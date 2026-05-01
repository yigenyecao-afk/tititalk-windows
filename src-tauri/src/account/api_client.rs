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
    #[error("transport: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("not logged in")]
    NotLoggedIn,
    #[error("http {status}: {message}")]
    Http {
        status: u16,
        code: Option<String>,
        message: String,
    },
    #[error("decode: {0}")]
    Decode(String),
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
        // Try to surface server's {error,message} — fall back to bare HTTP.
        #[derive(serde::Deserialize)]
        struct E {
            error: Option<String>,
            message: Option<String>,
        }
        let parsed: Option<E> = serde_json::from_slice(&bytes).ok();
        Err(ApiError::Http {
            status: status.as_u16(),
            code: parsed.as_ref().and_then(|e| e.error.clone()),
            message: parsed
                .and_then(|e| e.message)
                .unwrap_or_else(|| format!("HTTP {}", status.as_u16())),
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
