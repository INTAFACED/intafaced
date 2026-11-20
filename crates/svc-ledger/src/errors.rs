//! The ledger's refusals and how each door answers them: `httpError` in `services/svc-ledger/src/s2s-http.ts` for the
//! service doors, and the operator doors' own map in `operator-http.ts` (its auth refusals, then `guarded`'s catch).
//! A refusal carries its code and its own message; the answer is the code's user copy (`userCopy`, the recorded
//! `errors_table.rs`) where the TypeScript sends that instead.

use service_kit::json::Json;

use crate::errors_table::USER_COPY;

// Codes the doors answer with their own status (`s2s-http.ts` `httpError`).
pub const UNAUTHENTICATED: &str = "ledger.unauthenticated";
pub const CALLER_UNBOUND: &str = "ledger.caller_unbound";
pub const CALLER_FORBIDDEN: &str = "ledger.caller_forbidden";
pub const INSUFFICIENT_FUNDS: &str = "ledger.insufficient_funds";
pub const UNBALANCED: &str = "ledger.unbalanced";
pub const INVALID_ENTRY: &str = "ledger.invalid_entry";
pub const OWNER_IDENTITY_SPACE: &str = "ledger.owner_identity_space";
pub const IDEMPOTENCY_CONFLICT: &str = "ledger.idempotency_conflict";
pub const CUSTODY_LAYER_OFF: &str = "ledger.custody_layer_off";
pub const FROZEN: &str = "ledger.frozen";
pub const SKEW_BOUND_UNSET: &str = "ledger.skew_bound_unset";
pub const RESTORE_ASOF_INVALID: &str = "ledger.restore_asof_invalid";
pub const RESTORE_ASOF_UNANSWERABLE: &str = "ledger.restore_asof_unanswerable";
pub const POST_RECIPE_UNKNOWN: &str = "ledger.recipe_unknown";
pub const POST_RECIPE_INPUT_INVALID: &str = "ledger.recipe_input_invalid";

/// `isWriteBlockCode`: the store cannot take a write right now; nothing was booked.
pub const WRITE_BLOCKS: [&str; 3] = [
    "ledger.writes_blocked_store_disk_full",
    "ledger.writes_blocked_store_unavailable",
    "ledger.writes_blocked_clock_skew",
];

/// The request as asked cannot be answered and the fix is the caller's: 400 with the refusal's own message.
pub const CALLER_FIXES: [&str; 15] = [
    "ledger.history_range_invalid",
    "ledger.history_range_too_large",
    "ledger.history_page_socket",
    "ledger.fee_revenue_window_invalid",
    "ledger.holdings_history_window_invalid",
    "ledger.holdings_history_too_large",
    "ledger.history_cursor_invalid",
    "ledger.recipe_required",
    POST_RECIPE_UNKNOWN,
    POST_RECIPE_INPUT_INVALID,
    "ledger.rebate_unbound",
    "ledger.campaign_lock_unbound",
    "ledger.withdraw_return_unbound",
    "ledger.withdraw_fee_unbound",
    RESTORE_ASOF_INVALID,
];

/// `REGISTRY_REFUSALS` (`ledger/supported-assets.ts`): the asset registry's refusals of the caller's request.
pub const REGISTRY_REFUSALS: [&str; 6] = [
    "ledger.asset_not_found",
    "ledger.asset_precision_unset",
    "ledger.asset_precision_invalid",
    "ledger.asset_default_network_not_listed",
    "ledger.asset_edit_invalid",
    "ledger.asset_list_filter_invalid",
];

/// `userCopy(code)`: the catalogue's English for a code, or the code itself when the catalogue has none.
pub fn user_copy(code: &str) -> String {
    USER_COPY
        .iter()
        .find(|(c, _)| *c == code)
        .map_or_else(|| code.to_owned(), |(_, copy)| (*copy).to_owned())
}

/// What a service door's handler throws, as `httpError` tells them apart.
#[derive(Debug, Clone, PartialEq)]
pub enum Failure {
    /// A `LedgerError`: its code and own message.
    Ledger { code: String, message: String },
    /// `InsufficientFundsError`: the answer names the account, the asset and both amounts (decimal strings).
    InsufficientFunds {
        account_id: String,
        asset_id: String,
        requested: String,
        available: String,
    },
    /// A `ZodError` from a door's input: its message is `JSON.stringify(issues, null, 2)`.
    Zod(String),
    /// Anything else: the ledger's own fault.
    Fault,
}

impl Failure {
    pub fn ledger(code: &str, message: impl Into<String>) -> Failure {
        Failure::Ledger {
            code: code.to_owned(),
            message: message.into(),
        }
    }
}

fn body(message: &str, code: Option<&str>) -> Json {
    let mut o = vec![("message".to_owned(), Json::str(message))];
    if let Some(c) = code {
        o.push(("code".to_owned(), Json::str(c)));
    }
    Json::Object(o)
}

/// `httpError(err)`: the status and body a service door answers a failure with.
pub fn http_error(err: &Failure) -> (u16, Json) {
    match err {
        Failure::InsufficientFunds {
            account_id,
            asset_id,
            requested,
            available,
        } => (
            400,
            Json::Object(vec![
                (
                    "message".to_owned(),
                    Json::str(user_copy(INSUFFICIENT_FUNDS)),
                ),
                ("code".to_owned(), Json::str(INSUFFICIENT_FUNDS)),
                ("accountId".to_owned(), Json::str(account_id.clone())),
                ("assetId".to_owned(), Json::str(asset_id.clone())),
                ("requested".to_owned(), Json::str(requested.clone())),
                ("availableBalance".to_owned(), Json::str(available.clone())),
            ]),
        ),
        Failure::Ledger { code, message } => {
            let c = code.as_str();
            let own = |status| (status, body(message, Some(c)));
            let copy = |status| (status, body(&user_copy(c), Some(c)));
            match c {
                UNBALANCED | INVALID_ENTRY => copy(500),
                OWNER_IDENTITY_SPACE => own(400),
                UNAUTHENTICATED | CALLER_UNBOUND => own(401),
                CALLER_FORBIDDEN => own(403),
                IDEMPOTENCY_CONFLICT => own(409),
                _ if WRITE_BLOCKS.contains(&c) => (503, body(c, Some(c))),
                CUSTODY_LAYER_OFF | FROZEN => copy(412),
                _ if CALLER_FIXES.contains(&c) => own(400),
                RESTORE_ASOF_UNANSWERABLE | SKEW_BOUND_UNSET => own(409),
                _ if REGISTRY_REFUSALS.contains(&c) => own(400),
                _ => copy(500),
            }
        }
        Failure::Zod(message) => (400, body(message, None)),
        Failure::Fault => (500, body("Ledger request failed", None)),
    }
}

/// An operator door's auth refusal (`AuthError`): 403 for `scope.denied`, else 401 (`statusForAuthError`).
pub fn auth_error(message: &str, code: &str) -> (u16, Json) {
    (
        if code == "scope.denied" { 403 } else { 401 },
        body(message, Some(code)),
    )
}

/// An operator lookup whose input does not parse: 400 with the door's fixed sentence (`LOOKUP_INPUT_INVALID`).
pub fn lookup_invalid(message: &str) -> (u16, Json) {
    (400, body(message, Some("ledger.lookup_input_invalid")))
}

/// `guarded`'s catch-all on an operator door: 400, the thrown message, `ledger.operator_request_failed`.
pub fn operator_failed(message: &str) -> (u16, Json) {
    (400, body(message, Some("ledger.operator_request_failed")))
}
