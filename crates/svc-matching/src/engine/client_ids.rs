//! `core-tif.ts`'s client order id claim: a client order id is used once per account and environment, not once per
//! live order. A submit claims its id before it runs and keeps the claim unless it comes back as a refusal that touched
//! nothing; a submit that fails (a lost journal or publication acknowledgement) keeps it, because its order may be
//! durable or may already have traded. A cold start claims the id of every `submit` record in the journal. So a retry
//! after a lost acknowledgement refuses `client_order_id_reuse` and can never place a second order.

use std::collections::HashSet;

use service_kit::json::Json;

use crate::book::types::{EngineOrder, Reject, SubmitResult};
use crate::journal::record::{JournalRecord, js_string};

pub const CLIENT_ORDER_ID_REUSE: &str = "client_order_id_reuse";
pub const CLIENT_ORDER_ID_REUSE_MESSAGE: &str =
    "clientOrderId already used in this account/environment domain";

/// One claim: account, environment (empty when none was sent, never a silent `live`), client order id.
pub type ClientIdKey = (String, String, String);

/// `readClientOrderId`: the trimmed id, or none when absent or blank.
fn trimmed(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// The claim an order makes, if it names a client order id (`domainKey`).
pub fn key_of(order: &EngineOrder) -> Option<ClientIdKey> {
    let client = trimmed(order.client_order_id.as_deref())?;
    let environment = order
        .environment
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .to_owned();
    Some((order.account_id.clone(), environment, client))
}

/// The claim a journalled order makes, read as the TypeScript reads `row.order`: only a string id or environment counts.
fn key_of_json(order: &Json) -> Option<ClientIdKey> {
    let text = |field: &str| match order.get(field) {
        Some(Json::String(s)) => Some(s.as_str()),
        _ => None,
    };
    let client = trimmed(text("clientOrderId"))?;
    let environment = text("environment")
        .map(str::trim)
        .unwrap_or_default()
        .to_owned();
    Some((js_string(order.get("accountId")), environment, client))
}

/// `hydrateFromJournal`: every `submit` record's claim.
pub fn claims_in(records: &[JournalRecord]) -> impl Iterator<Item = ClientIdKey> + '_ {
    records
        .iter()
        .filter(|r| r.kind() == Some("submit"))
        .filter_map(|r| r.field("order").and_then(key_of_json))
}

/// The only outcome that releases a claim: a returned refusal that rested nothing, printed nothing and fired nothing
/// that printed.
pub fn releases(result: &SubmitResult) -> bool {
    !result.accepted
        && result.fills.is_empty()
        && result.resting.is_none()
        && result.triggered.iter().all(|t| t.fills.is_empty())
}

pub fn reuse_refuse() -> Reject {
    Reject::new(CLIENT_ORDER_ID_REUSE, CLIENT_ORDER_ID_REUSE_MESSAGE)
}

/// The claims an engine holds.
pub type ClientIds = HashSet<ClientIdKey>;
