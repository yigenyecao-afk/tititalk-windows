//! Billing — `/api/billing/*` proxy.
//!
//! Mirrors what the macOS BillingFlow / BillingCatalog do:
//!   • `fetch_plans()` — public catalog, render the upgrade UI from this
//!     so plans/prices/features all live server-side
//!   • `checkout(plan)` — POST `/api/billing/checkout`, returns pay_url +
//!     order_id; UI opens browser + starts polling
//!   • `get_order(id)` — single-order poll for the 2 s ticker
//!
//! Auth: catalog is public; checkout + order require Bearer. The api_client
//! handles 401-retry + X-User-Plan tap automatically.
use serde::{Deserialize, Serialize};

use super::api_client::{ApiClient, ApiError};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanInfo {
    pub code: String,
    pub kind: String,                // "membership" | "pro_unlock"
    pub title: String,
    pub title_long: String,
    pub subtitle: String,
    pub price_cents: i64,
    pub currency: String,
    pub duration_days: Option<i32>,
    pub quota_tokens: Option<i64>,
    pub features: Vec<String>,
    pub recommended: bool,
    pub sort_order: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurrentUserOwnership {
    pub plan: String,
    pub pro_unlocked: bool,
    pub owns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlansCatalog {
    pub plans: Vec<PlanInfo>,
    pub currency: String,
    pub current_user: Option<CurrentUserOwnership>,
}

#[derive(Debug, Serialize)]
pub struct CheckoutReq {
    pub plan: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckoutResp {
    pub order_id: i64,
    pub trade_order_id: String,
    pub pay_url: String,
    pub qr_url: Option<String>,
    pub total_fee_cents: i64,
    pub plan: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderInfo {
    pub id: i64,
    pub plan: String,
    pub status: String,                       // pending | paid | refunded | expired | failed
    pub amount_cents: i64,
    pub currency: String,
    pub paid_at: Option<String>,
    pub created_at: String,
    pub expires_at: String,
}

/// Fetch the plan catalog. Goes through the authed api client when a token
/// exists (so `current_user.owns` populates) and falls back to anon GET via
/// reqwest direct when not — server allows both.
pub async fn fetch_plans(api: &ApiClient) -> Result<PlansCatalog, ApiError> {
    api.get("/api/billing/plans").await
}

pub async fn checkout(api: &ApiClient, plan: &str) -> Result<CheckoutResp, ApiError> {
    api.post("/api/billing/checkout", &CheckoutReq { plan: plan.into() }, true).await
}

pub async fn get_order(api: &ApiClient, order_id: i64) -> Result<OrderInfo, ApiError> {
    api.get(&format!("/api/billing/orders/{order_id}")).await
}
