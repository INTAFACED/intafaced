//! `GlobalSendService` (`personal-pay/global.ts`) and its ledger half (`personal-pay/post.ts`).
//!
//! Corridors, quotes and payouts come from the ports; an unset port refuses by name. Quote numbers are the provider's
//! strings, checked for decimal shape and never recomputed. A quote is a rate lock: a send confirmed on it before its
//! valid-until is paid at exactly its figures, and one lock pays one send. Travel-rule fields are whatever the owner
//! recorded; an undecided rule refuses before any post. Every definite refusal keeps the send's intent row, failed with
//! its code, so a retry of the same key is the same refusal.
//!
//! If this crashes after the forward entry posts and before it is recorded, nobody's funds are stranded: the entry is
//! found by its key on the retry and recorded before any refusal, so a posted send is paid at its lock or left open as
//! unknown, never failed while the rail boundary holds its value.

use base64::Engine as _;
use hmac::{Hmac, Mac};
use postgres::Row;
use postgres::error::SqlState;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, js_trim, parse_amount};
use service_kit::schema::Value;
use service_kit::time::{Instant, v8_date_parse};
use service_kit::trpc::TrpcError;
use sha2::{Digest, Sha256};

use super::holds;
use super::ports::{Corridor, FxQuote, Payout, PayoutAnswer, SWIFT_CHARGES};
use super::refusals::{PSP_BLOCKER, blocker, pay, refuse};
use super::rules::{self, AccountKind, FieldContext};
use super::{Deps, ms, one_line, require_text, units, uuid};
use crate::errors::Refusal;
use crate::spaces::ports::{LedgerAccount, LedgerTx, PostFailure};
use crate::spaces::space::{self, Space, at, pg, with};

/// `GLOBAL_RECEIPT_INFO`: the HKDF info label of global-send receipts.
const GLOBAL_RECEIPT_INFO: &str = "bank.global.receipt.v1";

/// `SEND_STATUSES`.
pub const STATUSES: [&str; 9] = [
    "submitted",
    "held",
    "sent",
    "on_the_way",
    "arrived",
    "failed",
    "cancelled",
    "returned",
    "refunded",
];

/// `DEFINITE`: the refusals that fail a send's row (nothing was posted, or the posting was turned back).
const DEFINITE: [&str; 21] = [
    "bank.global_corridors_unset",
    "bank.global_corridor_unknown",
    "bank.global_amount_outside_corridor",
    "bank.global_fx_unset",
    "bank.global_quote_required",
    "bank.global_quote_expired",
    "bank.global_payout_unset",
    "bank.global_payout_uncovered",
    "bank.global_payout_refused",
    "bank.global_travel_rule_undecided",
    "bank.global_travel_rule_incomplete",
    "bank.send_field_rules_unset",
    "bank.reference_rules_unset",
    "bank.reference_too_long",
    "bank.send_purpose_required",
    "bank.source_of_funds_required",
    "bank.global_insufficient_funds",
    "bank.payee_controls_unset",
    "bank.payee_blocked",
    "bank.exchange_allowance_unset",
    "bank.exchange_allowance_exceeded",
];

const LEFT: [&str; 3] = ["sent", "on_the_way", "arrived"];

fn invalid() -> Refusal {
    refuse("bank.personal_pay_request_invalid")
}

fn f(k: &str, v: Json) -> (String, Json) {
    (k.to_owned(), v)
}

fn opt(v: Option<&String>) -> Json {
    v.map_or(Json::Null, |s| Json::str(s.clone()))
}

fn opt_at(v: Option<Instant>) -> Json {
    v.map_or(Json::Null, |t| Json::str(t.iso()))
}

// ── rows ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/// `RecipientRow`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecipientRow {
    pub id: String,
    pub user_id: String,
    pub idempotency_key: String,
    pub label: Option<String>,
    pub name: String,
    pub account: String,
    pub account_kind: String,
    pub bic: Option<String>,
    pub country: String,
    pub removed_at: Option<Instant>,
    pub created_at: Instant,
}

fn recipient_cols() -> String {
    format!(
        "id::text, user_id, idempotency_key, label, name, account, account_kind, bic, country, {}, {}",
        ms("removed_at"),
        ms("created_at")
    )
}

impl RecipientRow {
    fn from_row(r: &Row) -> Result<RecipientRow, Refusal> {
        let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
        let o = |i: usize| r.try_get::<_, Option<String>>(i).map_err(|e| pg(&e));
        Ok(RecipientRow {
            id: s(0)?,
            user_id: s(1)?,
            idempotency_key: s(2)?,
            label: o(3)?,
            name: s(4)?,
            account: s(5)?,
            account_kind: s(6)?,
            bic: o(7)?,
            country: s(8)?,
            removed_at: r
                .try_get::<_, Option<i64>>(9)
                .map_err(|e| pg(&e))?
                .map(Instant),
            created_at: Instant(r.try_get::<_, i64>(10).map_err(|e| pg(&e))?),
        })
    }

    /// `recipientView`, in `globalRecipientSchema`'s order.
    pub fn view(&self) -> Json {
        Json::Object(vec![
            f("id", Json::str(self.id.clone())),
            f("label", opt(self.label.as_ref())),
            f("name", Json::str(self.name.clone())),
            f("account", Json::str(self.account.clone())),
            f("accountKind", Json::str(self.account_kind.clone())),
            f("bic", opt(self.bic.as_ref())),
            f("country", Json::str(self.country.clone())),
            f("createdAt", Json::str(self.created_at.iso())),
        ])
    }
}

/// `SendRow`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendRow {
    pub id: String,
    pub user_id: String,
    pub idempotency_key: String,
    pub from_space_id: String,
    pub asset_id: String,
    pub amount: String,
    pub to_currency: String,
    pub recipient_id: String,
    pub country: String,
    pub delivery_method: String,
    pub compliance: Option<String>,
    pub status: String,
    pub failure_code: Option<String>,
    pub failure_blocker: Option<String>,
    pub provider_ref: Option<String>,
    pub quote_rate: Option<String>,
    pub quote_fee: Option<String>,
    pub quote_fee_asset: Option<String>,
    pub quote_receive: Option<String>,
    pub quote_valid_until: Option<Instant>,
    pub quote_eta: Option<String>,
    pub quote_id: Option<String>,
    pub ledger_tx_id: Option<String>,
    pub cancelled_by: Option<String>,
    pub return_ref: Option<String>,
    pub returned_by: Option<String>,
    pub returned_at: Option<Instant>,
    pub refund_operator_id: Option<String>,
    pub refunded_at: Option<Instant>,
    pub recall_reason: Option<String>,
    pub recall_requested_at: Option<Instant>,
    pub created_at: Instant,
    pub updated_at: Instant,
}

/// `SEND_COLUMNS`, in [`SendRow::from_row`]'s order.
pub fn send_cols() -> String {
    format!(
        "id::text, user_id, idempotency_key, from_space_id::text, asset_id, amount, to_currency, recipient_id::text, \
         country, delivery_method, compliance, status, failure_code, failure_blocker, provider_ref, quote_rate, \
         quote_fee, quote_fee_asset, quote_receive, {}, quote_eta, quote_id::text, ledger_tx_id, cancelled_by, \
         return_ref, returned_by, {}, refund_operator_id, {}, recall_reason, {}, {}, {}",
        ms("quote_valid_until"),
        ms("returned_at"),
        ms("refunded_at"),
        ms("recall_requested_at"),
        ms("created_at"),
        ms("updated_at")
    )
}

impl SendRow {
    pub fn from_row(r: &Row) -> Result<SendRow, Refusal> {
        let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
        let o = |i: usize| r.try_get::<_, Option<String>>(i).map_err(|e| pg(&e));
        let t = |i: usize| {
            r.try_get::<_, Option<i64>>(i)
                .map(|v| v.map(Instant))
                .map_err(|e| pg(&e))
        };
        let must = |i: usize| r.try_get::<_, i64>(i).map(Instant).map_err(|e| pg(&e));
        Ok(SendRow {
            id: s(0)?,
            user_id: s(1)?,
            idempotency_key: s(2)?,
            from_space_id: s(3)?,
            asset_id: s(4)?,
            amount: s(5)?,
            to_currency: s(6)?,
            recipient_id: s(7)?,
            country: s(8)?,
            delivery_method: s(9)?,
            compliance: o(10)?,
            status: s(11)?,
            failure_code: o(12)?,
            failure_blocker: o(13)?,
            provider_ref: o(14)?,
            quote_rate: o(15)?,
            quote_fee: o(16)?,
            quote_fee_asset: o(17)?,
            quote_receive: o(18)?,
            quote_valid_until: t(19)?,
            quote_eta: o(20)?,
            quote_id: o(21)?,
            ledger_tx_id: o(22)?,
            cancelled_by: o(23)?,
            return_ref: o(24)?,
            returned_by: o(25)?,
            returned_at: t(26)?,
            refund_operator_id: o(27)?,
            refunded_at: t(28)?,
            recall_reason: o(29)?,
            recall_requested_at: t(30)?,
            created_at: must(31)?,
            updated_at: must(32)?,
        })
    }

    /// `sendView`, in `globalSendSchema`'s order.
    pub fn fields(&self) -> Vec<(String, Json)> {
        vec![
            f("id", Json::str(self.id.clone())),
            f("fromSpaceId", Json::str(self.from_space_id.clone())),
            f("assetId", Json::str(self.asset_id.clone())),
            f("amount", Json::str(self.amount.clone())),
            f("toCurrency", Json::str(self.to_currency.clone())),
            f("recipientId", Json::str(self.recipient_id.clone())),
            f("country", Json::str(self.country.clone())),
            f("deliveryMethod", Json::str(self.delivery_method.clone())),
            f("status", Json::str(self.status.clone())),
            f("failureCode", opt(self.failure_code.as_ref())),
            f("failureBlocker", opt(self.failure_blocker.as_ref())),
            f("providerRef", opt(self.provider_ref.as_ref())),
            f("quoteRate", opt(self.quote_rate.as_ref())),
            f("quoteFee", opt(self.quote_fee.as_ref())),
            f("quoteFeeAsset", opt(self.quote_fee_asset.as_ref())),
            f("quoteReceive", opt(self.quote_receive.as_ref())),
            f("quoteValidUntil", opt_at(self.quote_valid_until)),
            f("quoteEta", opt(self.quote_eta.as_ref())),
            f("quoteId", opt(self.quote_id.as_ref())),
            f("ledgerTxId", opt(self.ledger_tx_id.as_ref())),
            f("cancelledBy", opt(self.cancelled_by.as_ref())),
            f("returnRef", opt(self.return_ref.as_ref())),
            f("returnedAt", opt_at(self.returned_at)),
            f("refundedAt", opt_at(self.refunded_at)),
            f("recallReason", opt(self.recall_reason.as_ref())),
            f("recallRequestedAt", opt_at(self.recall_requested_at)),
            f("createdAt", Json::str(self.created_at.iso())),
            f("updatedAt", Json::str(self.updated_at.iso())),
        ]
    }

    /// The customer's view.
    pub fn view(&self) -> Json {
        Json::Object(self.fields())
    }

    /// The operator's view: the customer's and `userId`.
    pub fn ops_view(&self) -> Json {
        let mut v = self.fields();
        v.push(f("userId", Json::str(self.user_id.clone())));
        Json::Object(v)
    }
}

/// `LockRow`: one rate lock (`bank.global_quotes`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct LockRow {
    id: String,
    user_id: String,
    asset_id: String,
    amount: String,
    to_currency: String,
    rate: String,
    fee: String,
    fee_asset: String,
    receive_amount: String,
    valid_until: Instant,
    eta: String,
}

// ── the ledger half (`post.ts`) ─────────────────────────────────────────────────────────────────────────────────────

/// `bankTransferKey('rail', id, 0)`: the forward entry's key.
pub fn forward_key(send_id: &str) -> String {
    format!("bank.transfer.rail:{send_id}:0")
}

/// `bankTransferKey('rail', id, 1)`: the entry back's key.
pub fn reverse_key(send_id: &str) -> String {
    format!("bank.transfer.rail:{send_id}:1")
}

/// `railBoundary(rail, assetId)`.
pub fn rail_boundary(rail: &str, asset_id: &str) -> LedgerAccount {
    LedgerAccount {
        owner_type: "treasury",
        owner_id: format!("rail:{rail}"),
        asset_id: asset_id.to_owned(),
        kind: "available",
        purpose: None,
    }
}

/// Why a post was not made: the custody switch refused it before svc-ledger was asked, or svc-ledger failed.
#[derive(Debug)]
pub enum PostError {
    Custody(Refusal),
    Ledger(PostFailure),
}

/// `ledger.post(recipes.bankTransfer({ transferId, occurrence, from, to, amount, kind: 'manual', keySpace: 'rail' }))`
/// through the custody guard: with the custodial layer off, a post that moves a customer balance (every one here) is
/// refused `bank.no_partner_bank`.
fn post_rail(
    d: &Deps<'_>,
    send_id: &str,
    occurrence: i64,
    from: &LedgerAccount,
    to: &LedgerAccount,
    amount: Amount,
) -> Result<LedgerTx, PostError> {
    if d.custody_layer != "on" {
        return Err(PostError::Custody(crate::partner::refuse(
            "bank.no_partner_bank",
            "No banking partner holds this money, and INTAFACED holds no customer money, so nothing was moved.",
        )));
    }
    let input = Json::obj([
        ("transferId", Json::str(send_id)),
        ("occurrence", Json::int(occurrence)),
        ("from", from.json()),
        ("to", to.json()),
        ("amount", Json::str(format_amount(amount))),
        ("kind", Json::str("manual")),
        ("keySpace", Json::str("rail")),
    ]);
    let key = if occurrence == 0 {
        forward_key(send_id)
    } else {
        reverse_key(send_id)
    };
    d.ledger
        .post_recipe("bankTransfer", &input, &key)
        .map_err(PostError::Ledger)
}

/// `postToRail`: the space's value to the rail boundary, occurrence 0.
pub fn post_to_rail(
    d: &Deps<'_>,
    send_id: &str,
    from: &LedgerAccount,
    rail: &str,
    amount: Amount,
) -> Result<LedgerTx, PostError> {
    post_rail(
        d,
        send_id,
        0,
        from,
        &rail_boundary(rail, &from.asset_id),
        amount,
    )
}

/// `reverseFromRail`: back from the rail boundary to the space, occurrence 1.
pub fn reverse_from_rail(
    d: &Deps<'_>,
    send_id: &str,
    to: &LedgerAccount,
    rail: &str,
    amount: Amount,
) -> Result<LedgerTx, PostError> {
    post_rail(
        d,
        send_id,
        1,
        &rail_boundary(rail, &to.asset_id),
        to,
        amount,
    )
}

/// A post error the router's guard answers: an opaque failure whose cause is the error's own code, if it has one.
fn post_thrown(e: PostError) -> Refusal {
    match e {
        PostError::Custody(r) => r,
        PostError::Ledger(PostFailure::Coded { code, .. }) => Refusal::Trpc(TrpcError::caused(
            "INTERNAL_SERVER_ERROR",
            "Bank operation failed",
            code,
        )),
        PostError::Ledger(PostFailure::Unknown(m)) => Refusal::Other(m),
    }
}

fn tx_by_key(d: &Deps<'_>, key: &str) -> Result<Option<LedgerTx>, Refusal> {
    d.ledger.tx_by_key(key).map_err(Refusal::Other)
}

// ── small checks ────────────────────────────────────────────────────────────────────────────────────────────────────

/// `canonical`: a positive decimal amount, as text and as the ledger's number.
fn canonical(raw: &str) -> Result<(String, Amount), Refusal> {
    let a = parse_amount(raw).map_err(|_| invalid())?;
    if a <= 0 {
        return Err(invalid());
    }
    Ok((format_amount(a), a))
}

/// `canonicalCompliance`: the fields sorted by key, blank values dropped, as JSON; `''` for none.
pub fn canonical_compliance(fields: Option<&Value>) -> Result<String, Refusal> {
    let Some(Value::Object(pairs)) = fields else {
        return Ok(String::new());
    };
    let mut kept: Vec<(String, String)> = Vec::new();
    let mut keys: Vec<&(String, Value)> = pairs.iter().collect();
    keys.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    for (k, v) in keys {
        let value = js_trim(v.as_str().unwrap_or("")).to_owned();
        if value.is_empty() {
            continue;
        }
        let key_ok = (1..=64).contains(&k.len())
            && k.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'));
        if !key_ok || units(&value) > 200 {
            return Err(invalid());
        }
        kept.push((k.clone(), value));
    }
    if kept.is_empty() {
        return Ok(String::new());
    }
    let obj = kept
        .into_iter()
        .map(|(k, v)| (k, Json::String(v)))
        .collect();
    Ok(Json::Object(json::js_key_order(obj)).compact())
}

/// `providerDecimal`.
fn provider_decimal(raw: &str, allow_zero: bool) -> Result<String, Refusal> {
    let unusable = || refuse("bank.global_fx_unusable");
    if !rules::is_decimal(raw) {
        return Err(unusable());
    }
    let a = parse_amount(raw).map_err(|_| unusable())?;
    if a < 0 || (!allow_zero && a == 0) {
        return Err(unusable());
    }
    Ok(raw.to_owned())
}

/// `providerInstant`: an ISO-looking instant `Date.parse` reads.
fn provider_instant(raw: &str) -> Result<i64, Refusal> {
    if !raw.contains('T') {
        return Err(refuse("bank.global_fx_unusable"));
    }
    v8_date_parse(raw).ok_or_else(|| refuse("bank.global_fx_unusable"))
}

/// `encodeCursor`: base64url of `<iso>|<id>`.
fn encode_cursor(created_at: Instant, id: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!("{}|{id}", created_at.iso()))
}

/// `Buffer.from(text, 'base64url')`: either alphabet, anything else skipped, stopping at the first `=`.
pub(crate) fn node_base64(text: &str) -> Vec<u8> {
    let mut bits: u32 = 0;
    let mut n = 0;
    let mut out = Vec::new();
    for b in text.bytes() {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        bits = (bits << 6) | u32::from(v);
        n += 6;
        if n >= 8 {
            n -= 8;
            out.push(((bits >> n) & 0xff) as u8);
        }
    }
    out
}

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// `decodeCursor`: the instant's text and the id, or `bank.global_cursor_invalid`.
fn decode_cursor(cursor: &str) -> Result<(String, String), Refusal> {
    let text = String::from_utf8_lossy(&node_base64(cursor)).into_owned();
    let (at, id) = match text.rfind('|') {
        Some(p) if p > 0 => (text[..p].to_owned(), text[p + 1..].to_owned()),
        _ => (String::new(), String::new()),
    };
    if v8_date_parse(&at).is_none() || !is_uuid(&id) {
        return Err(refuse("bank.global_cursor_invalid"));
    }
    Ok((at, id))
}

/// `usableCorridor`: the provider's row checked and normalised, or `bank.global_corridors_unusable`.
fn usable_corridor(row: &Corridor) -> Result<Corridor, Refusal> {
    let unusable = || refuse("bank.global_corridors_unusable");
    let country = js_trim(&row.country).to_uppercase();
    let currency = js_trim(&row.currency).to_uppercase();
    let caps = |s: &str, lo: usize, hi: usize| {
        (lo..=hi).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_uppercase())
    };
    if !caps(&country, 2, 2) || !caps(&currency, 3, 8) || row.delivery_methods.is_empty() {
        return Err(unusable());
    }
    let mut methods = Vec::new();
    for m in &row.delivery_methods {
        let t = js_trim(m);
        if t.is_empty() || units(t) > 64 {
            return Err(unusable());
        }
        methods.push(t.to_owned());
    }
    let bound = |v: &Option<String>| -> Result<Option<String>, Refusal> {
        let Some(v) = v else { return Ok(None) };
        if !rules::is_decimal(v) || parse_amount(v).map_err(|_| unusable())? <= 0 {
            return Err(unusable());
        }
        Ok(Some(v.clone()))
    };
    let cut_off = match &row.cut_off_time {
        None => None,
        Some(c) if js_trim(c).is_empty() || units(c) > 80 => return Err(unusable()),
        Some(c) => Some(js_trim(c).to_owned()),
    };
    if let Some(s) = &row.swift_charges
        && !SWIFT_CHARGES.contains(&s.as_str())
    {
        return Err(unusable());
    }
    Ok(Corridor {
        country,
        currency,
        delivery_methods: methods,
        min_amount: bound(&row.min_amount)?,
        max_amount: bound(&row.max_amount)?,
        cut_off_time: cut_off,
        swift_charges: row.swift_charges.clone(),
    })
}

// ── the catalogue and recipients ────────────────────────────────────────────────────────────────────────────────────

/// Whether the payout partner covers one corridor and method; one that names no coverage covers every corridor.
fn pays_out(d: &Deps<'_>, country: &str, currency: &str, method: &str) -> Result<bool, Refusal> {
    match d.w.ports.payout_covers(country, currency, method) {
        None => Ok(true),
        Some(Ok(b)) => Ok(b),
        // A coverage answer the service cannot read is the provider's shape problem: nothing is refused or posted on it.
        Some(Err(_)) => Err(refuse("bank.global_payout_unusable")),
    }
}

/// `corridors`: the catalogue, each corridor with the delivery methods a payout partner pays out on.
pub fn corridors(d: &Deps<'_>) -> Result<Vec<(Corridor, Vec<String>)>, Refusal> {
    let p = &d.w.ports;
    if !p.corridors_live() {
        return Err(refuse("bank.global_corridors_unset"));
    }
    let rows = p.corridors().map_err(Refusal::Other)?;
    let mut out = Vec::new();
    for row in &rows {
        let c = usable_corridor(row)?;
        let methods = if p.payout_live() {
            let mut m = Vec::new();
            for method in &c.delivery_methods {
                if pays_out(d, &c.country, &c.currency, method)? {
                    m.push(method.clone());
                }
            }
            m
        } else {
            Vec::new()
        };
        out.push((c, methods));
    }
    Ok(out)
}

/// `global.corridors.list`, in `globalCorridorSchema`'s order.
pub fn corridors_json(d: &Deps<'_>) -> Result<Json, Refusal> {
    let strs = |v: &[String]| Json::Array(v.iter().map(|s| Json::str(s.clone())).collect());
    Ok(Json::Array(
        corridors(d)?
            .into_iter()
            .map(|(c, payout)| {
                Json::Object(vec![
                    f("country", Json::str(c.country)),
                    f("currency", Json::str(c.currency)),
                    f("deliveryMethods", strs(&c.delivery_methods)),
                    f("minAmount", opt(c.min_amount.as_ref())),
                    f("maxAmount", opt(c.max_amount.as_ref())),
                    f("cutOffTime", opt(c.cut_off_time.as_ref())),
                    f("swiftCharges", opt(c.swift_charges.as_ref())),
                    f("payoutMethods", strs(&payout)),
                ])
            })
            .collect(),
    ))
}

/// `validateRecipient`: the account's shape, and the BIC looked up when one is given and the directory is live.
pub fn validate_recipient(d: &Deps<'_>, account: &str, bic: Option<&str>) -> Result<Json, Refusal> {
    let answer = |kind: Option<AccountKind>, normalized: Option<&str>, lookup: Json| {
        Json::Object(vec![
            f(
                "format",
                Json::str(if kind.is_some() { "valid" } else { "invalid" }),
            ),
            f(
                "formatKind",
                kind.map_or(Json::Null, |k| Json::str(k.as_str())),
            ),
            f("normalized", normalized.map_or(Json::Null, Json::str)),
            f("bicLookup", lookup),
        ])
    };
    let status = |s: &str| Json::obj([("status", Json::str(s))]);
    let Some((kind, normalized)) = rules::classify_account(account) else {
        return Ok(answer(None, None, status("not_requested")));
    };
    let ok = |lookup: Json| Ok(answer(Some(kind), Some(&normalized), lookup));
    let Some(bic) = bic.filter(|b| !js_trim(b).is_empty()) else {
        return ok(status("not_requested"));
    };
    let Some(bic) = rules::classify_bic(bic) else {
        return ok(Json::obj([
            ("status", Json::str("invalid")),
            ("code", Json::str("bank.global_bic_format_invalid")),
        ]));
    };
    if !d.w.ports.bic_live() {
        return ok(Json::obj([
            ("status", Json::str("refused")),
            ("code", Json::str("bank.global_bic_directory_unset")),
            ("blocker", Json::str(PSP_BLOCKER)),
        ]));
    }
    let Some(hit) = d.w.ports.bic_lookup(&bic).map_err(Refusal::Other)? else {
        return ok(status("unmatched"));
    };
    let bank_name = js_trim(&hit.bank_name).to_owned();
    if bank_name.is_empty() || rules::compact_upper(&hit.bic) != bic {
        return Err(refuse("bank.global_corridors_unusable"));
    }
    ok(Json::obj([
        ("status", Json::str("matched")),
        ("bic", Json::str(bic)),
        ("bankName", Json::str(bank_name)),
    ]))
}

/// What `global.recipients.add` asks for.
pub struct NewRecipient<'a> {
    pub user_id: &'a str,
    pub idempotency_key: &'a str,
    pub name: &'a str,
    pub account: &'a str,
    pub country: &'a str,
    pub bic: Option<&'a str>,
    pub label: Option<&'a str>,
}

/// `addRecipient`: saved once per key; the same key with other details is `bank.global_conflict`.
pub fn add_recipient(d: &Deps<'_>, i: &NewRecipient<'_>) -> Result<Json, Refusal> {
    let key = require_text(i.idempotency_key, 128)?;
    if units(&key) < 8 {
        return Err(invalid());
    }
    let name = require_text(i.name, 140)?;
    let country = js_trim(i.country).to_uppercase();
    if !(country.len() == 2 && country.bytes().all(|b| b.is_ascii_uppercase())) {
        return Err(invalid());
    }
    let (kind, account) = rules::classify_account(i.account)
        .ok_or_else(|| refuse("bank.global_account_format_invalid"))?;
    let bic = match i.bic.filter(|b| !js_trim(b).is_empty()) {
        None => None,
        Some(b) => {
            Some(rules::classify_bic(b).ok_or_else(|| refuse("bank.global_bic_format_invalid"))?)
        }
    };
    let label = match i.label.filter(|l| !js_trim(l).is_empty()) {
        None => None,
        Some(l) => Some(require_text(l, 64)?),
    };
    let id = uuid()?;
    with(d.store, |c| {
        c.execute(
            "INSERT INTO bank.global_recipients (id, user_id, idempotency_key, label, name, account, account_kind, bic, country) \
             VALUES ($1::text::uuid, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (user_id, idempotency_key) DO NOTHING",
            &[&id, &i.user_id, &key, &label, &name, &account, &kind.as_str(), &bic, &country],
        )
        .map_err(|e| pg(&e))
    })?;
    let row = recipient_by_key(d, i.user_id, &key)?;
    let same = row.name == name
        && row.account == account
        && row.account_kind == kind.as_str()
        && row.bic == bic
        && row.country == country
        && row.label == label;
    if !same {
        return Err(refuse("bank.global_conflict"));
    }
    Ok(row.view())
}

fn recipients_where(
    d: &Deps<'_>,
    clause: &str,
    params: &[&(dyn postgres::types::ToSql + Sync)],
) -> Result<Vec<RecipientRow>, Refusal> {
    with(d.store, |c| {
        c.query(
            &format!(
                "SELECT {} FROM bank.global_recipients WHERE {clause}",
                recipient_cols()
            ),
            params,
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(RecipientRow::from_row)
        .collect()
    })
}

/// `listRecipients`: the person's live recipients, newest first.
pub fn list_recipients(d: &Deps<'_>, user_id: &str, limit: Option<i64>) -> Result<Json, Refusal> {
    let limit = limit.ok_or_else(|| refuse("bank.global_list_limit_unset"))?;
    let rows = recipients_where(
        d,
        "user_id = $1 AND removed_at IS NULL ORDER BY created_at DESC, id DESC LIMIT $2",
        &[&user_id, &limit],
    )?;
    Ok(Json::Array(rows.iter().map(RecipientRow::view).collect()))
}

/// `removeRecipient`: marks the person's recipient removed; removing it again is the same answer.
pub fn remove_recipient(
    d: &Deps<'_>,
    user_id: &str,
    recipient_id: &str,
    key: &str,
) -> Result<Json, Refusal> {
    require_text(key, 128)?;
    let row = recipients_where(
        d,
        "id = $1::text::uuid AND user_id = $2",
        &[&recipient_id, &user_id],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| refuse("bank.global_recipient_not_found"))?;
    if row.removed_at.is_none() {
        with(d.store, |c| {
            c.execute(
                "UPDATE bank.global_recipients SET removed_at = now() \
                 WHERE id = $1::text::uuid AND user_id = $2 AND removed_at IS NULL",
                &[&recipient_id, &user_id],
            )
            .map_err(|e| pg(&e))
        })?;
    }
    Ok(Json::obj([("removed", Json::Bool(true))]))
}

fn live_recipient(d: &Deps<'_>, user_id: &str, id: &str) -> Result<RecipientRow, Refusal> {
    recipients_where(
        d,
        "id = $1::text::uuid AND user_id = $2 AND removed_at IS NULL",
        &[&id, &user_id],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| refuse("bank.global_recipient_not_found"))
}

fn recipient_by_id(d: &Deps<'_>, id: &str) -> Result<RecipientRow, Refusal> {
    recipients_where(d, "id = $1::text::uuid", &[&id])?
        .into_iter()
        .next()
        .ok_or_else(|| refuse("bank.global_recipient_not_found"))
}

fn recipient_by_key(d: &Deps<'_>, user_id: &str, key: &str) -> Result<RecipientRow, Refusal> {
    recipients_where(
        d,
        "user_id = $1 AND idempotency_key = $2",
        &[&user_id, &key],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| refuse("bank.global_recipient_not_found"))
}

// ── the rate lock ───────────────────────────────────────────────────────────────────────────────────────────────────

/// `checkedQuote`: the provider's quote, each figure checked; a quote already out of date is refused.
fn checked_quote(
    d: &Deps<'_>,
    asset: &str,
    amount: &str,
    to_currency: &str,
) -> Result<FxQuote, Refusal> {
    let q =
        d.w.ports
            .fx_quote(asset, amount, to_currency)
            .map_err(|_| refuse("bank.global_fx_unusable"))?;
    let rate = provider_decimal(&q.rate, false)?;
    let fee = provider_decimal(&q.fee, true)?;
    let receive_amount = provider_decimal(&q.receive_amount, false)?;
    let fee_asset = js_trim(&q.fee_asset).to_uppercase();
    if !((2..=16).contains(&fee_asset.len())
        && fee_asset
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()))
    {
        return Err(refuse("bank.global_fx_unusable"));
    }
    if provider_instant(&q.valid_until)? <= d.now.0 {
        return Err(refuse("bank.global_quote_expired"));
    }
    provider_instant(&q.eta)?;
    Ok(FxQuote {
        rate,
        fee,
        fee_asset,
        receive_amount,
        valid_until: q.valid_until,
        eta: q.eta,
    })
}

/// `quote`: a rate lock for this person, asset, amount and currency until the provider's valid-until.
pub fn quote(
    d: &Deps<'_>,
    user_id: &str,
    asset: &str,
    amount: &str,
    to_currency: &str,
) -> Result<Json, Refusal> {
    if !d.w.ports.fx_live() {
        return Err(refuse("bank.global_fx_unset"));
    }
    let asset = require_text(asset, 16)?.to_uppercase();
    let to_currency = require_text(to_currency, 8)?.to_uppercase();
    let (text, _) = canonical(amount)?;
    let q = checked_quote(d, &asset, &text, &to_currency)?;
    let id = uuid()?;
    with(d.store, |c| {
        // A lock no send was confirmed on is of no use once it has run out: this person's, an hour past its end, go.
        c.execute(
            "DELETE FROM bank.global_quotes q WHERE q.user_id = $1 AND q.valid_until < now() - interval '1 hour' \
             AND NOT EXISTS (SELECT 1 FROM bank.global_sends s WHERE s.quote_id = q.id)",
            &[&user_id],
        )
        .map_err(|e| pg(&e))?;
        c.execute(
            "INSERT INTO bank.global_quotes (id, user_id, asset_id, amount, to_currency, rate, fee, fee_asset, receive_amount, valid_until, eta) \
             VALUES ($1::text::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::text::timestamptz, $11)",
            &[&id, &user_id, &asset, &text, &to_currency, &q.rate, &q.fee, &q.fee_asset, &q.receive_amount, &q.valid_until, &q.eta],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(Json::Object(vec![
        f("quoteId", Json::str(id)),
        f("lockedAt", Json::str(d.now.iso())),
        f("rate", Json::str(q.rate)),
        f("fee", Json::str(q.fee)),
        f("feeAsset", Json::str(q.fee_asset)),
        f("receiveAmount", Json::str(q.receive_amount)),
        f("validUntil", Json::str(q.valid_until)),
        f("eta", Json::str(q.eta)),
    ]))
}

fn lock_by_id(d: &Deps<'_>, id: &str) -> Result<Option<LockRow>, Refusal> {
    with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT id::text, user_id, asset_id, amount, to_currency, rate, fee, fee_asset, receive_amount, {}, eta \
                     FROM bank.global_quotes WHERE id = $1::text::uuid",
                    ms("valid_until")
                ),
                &[&id],
            )
            .map_err(|e| pg(&e))?;
        rows.first()
            .map(|r| -> Result<LockRow, Refusal> {
                let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
                Ok(LockRow {
                    id: s(0)?,
                    user_id: s(1)?,
                    asset_id: s(2)?,
                    amount: s(3)?,
                    to_currency: s(4)?,
                    rate: s(5)?,
                    fee: s(6)?,
                    fee_asset: s(7)?,
                    receive_amount: s(8)?,
                    valid_until: Instant(r.try_get::<_, i64>(9).map_err(|e| pg(&e))?),
                    eta: s(10)?,
                })
            })
            .transpose()
    })
}

fn was_held(d: &Deps<'_>, send_id: &str) -> Result<bool, Refusal> {
    with(d.store, |c| {
        c.query_one(
            "SELECT EXISTS (SELECT 1 FROM bank.global_send_holds WHERE send_id = $1::text::uuid)",
            &[&send_id],
        )
        .and_then(|r| r.try_get::<_, bool>(0))
        .map_err(|e| pg(&e))
    })
}

/// `lockedQuote`: the figures a send is paid at, the lock it was confirmed on, exactly. It must have been confirmed
/// before the lock ran out, and still be inside it as it posts, except a send held for review and released, and a
/// send whose forward entry already posted (only its payout is retried).
fn locked_quote(d: &Deps<'_>, row: &SendRow) -> Result<LockRow, Refusal> {
    let Some(quote_id) = &row.quote_id else {
        return Err(definite(d, row, "bank.global_quote_required", None));
    };
    let lock = lock_by_id(d, quote_id)?
        .filter(|l| l.user_id == row.user_id)
        .ok_or_else(|| refuse("bank.global_outcome_unknown"))?;
    if lock.valid_until.0 <= row.created_at.0 {
        return Err(definite(d, row, "bank.global_quote_expired", None));
    }
    if row.ledger_tx_id.is_none() && lock.valid_until.0 <= d.now.0 && !was_held(d, &row.id)? {
        return Err(definite(d, row, "bank.global_quote_expired", None));
    }
    Ok(lock)
}

// ── sends ───────────────────────────────────────────────────────────────────────────────────────────────────────────

fn sends_where(
    d: &Deps<'_>,
    clause: &str,
    params: &[&(dyn postgres::types::ToSql + Sync)],
) -> Result<Vec<SendRow>, Refusal> {
    with(d.store, |c| {
        c.query(
            &format!(
                "SELECT {} FROM bank.global_sends WHERE {clause}",
                send_cols()
            ),
            params,
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(SendRow::from_row)
        .collect()
    })
}

/// `sendById`: one send, the person's own when `user_id` is given.
pub fn send_by_id(
    d: &Deps<'_>,
    id: &str,
    user_id: Option<&str>,
) -> Result<Option<SendRow>, Refusal> {
    let rows = match user_id {
        Some(u) => sends_where(d, "id = $1::text::uuid AND user_id = $2", &[&id, &u])?,
        None => sends_where(d, "id = $1::text::uuid", &[&id])?,
    };
    Ok(rows.into_iter().next())
}

/// `mustSend`.
pub fn must_send(d: &Deps<'_>, id: &str) -> Result<SendRow, Refusal> {
    send_by_id(d, id, None)?.ok_or_else(|| refuse("bank.global_not_found"))
}

fn send_by_key(d: &Deps<'_>, user_id: &str, key: &str) -> Result<Option<SendRow>, Refusal> {
    Ok(sends_where(
        d,
        "user_id = $1 AND idempotency_key = $2",
        &[&user_id, &key],
    )?
    .into_iter()
    .next())
}

/// `definite`: fails the send's row with a refusal that left nothing posted, and answers the refusal. A send whose
/// forward entry is recorded is never failed: its outcome is unknown, unless the payout was refused (the entry is
/// turned back first) or there was too little money.
fn definite(d: &Deps<'_>, row: &SendRow, code: &str, detail: Option<&str>) -> Refusal {
    if row.ledger_tx_id.is_some()
        && code != "bank.global_payout_refused"
        && code != "bank.global_insufficient_funds"
    {
        return refuse("bank.global_outcome_unknown");
    }
    if !DEFINITE.contains(&code) {
        return refuse(code);
    }
    let b = blocker(code);
    let written = with(d.store, |c| {
        c.execute(
            "UPDATE bank.global_sends SET status = 'failed', failure_code = $2, failure_blocker = $3, ledger_tx_id = NULL, \
             updated_at = now() WHERE id = $1::text::uuid AND status = 'submitted'",
            &[&row.id, &code, &b],
        )
        .map_err(|e| pg(&e))
    });
    match written {
        Ok(_) => pay(code, detail),
        Err(e) => e,
    }
}

/// `ownedSpace` (the service's): the person's space, checked for a debit at `now`.
fn owned_space(d: &Deps<'_>, user_id: &str, space_id: &str) -> Result<Space, Refusal> {
    let found = with(d.store, |c| space::find(c, space_id))?;
    let space = found
        .filter(|s| s.user_id == user_id)
        .ok_or_else(|| refuse("bank.global_space_not_found"))?;
    with(d.store, |c| {
        crate::transfers::moves::resolve_for_debit(c, &space.id, d.now)
    })
}

/// What `global.send` asks for, as the door read it.
pub struct SendAsk<'a> {
    pub user_id: &'a str,
    pub idempotency_key: &'a str,
    pub from_space_id: &'a str,
    pub amount: &'a str,
    pub to_currency: &'a str,
    pub recipient_id: &'a str,
    pub country: &'a str,
    pub delivery_method: &'a str,
    pub compliance: Option<&'a Value>,
    pub quote_id: Option<&'a str>,
}

/// `send`: records the instruction once per key, then drives it.
pub fn send(d: &Deps<'_>, i: &SendAsk<'_>) -> Result<Json, Refusal> {
    let key = require_text(i.idempotency_key, 128)?;
    if units(&key) < 8 {
        return Err(invalid());
    }
    let (amount_text, amount) = canonical(i.amount)?;
    let to_currency = require_text(i.to_currency, 8)?.to_uppercase();
    let country = js_trim(i.country).to_uppercase();
    let delivery_method = require_text(i.delivery_method, 64)?;
    if !(country.len() == 2 && country.bytes().all(|b| b.is_ascii_uppercase())) {
        return Err(invalid());
    }
    let compliance = canonical_compliance(i.compliance)?;
    let space = owned_space(d, i.user_id, i.from_space_id)?;
    let recipient = live_recipient(d, i.user_id, i.recipient_id)?;
    // A lock id in any letter case is the same lock; it is kept as Postgres writes it, so a replay compares equal.
    let quote_id = i.quote_id.map(|q| js_trim(q).to_lowercase());
    if let Some(q) = &quote_id {
        let lock = lock_by_id(d, q)?
            .filter(|l| l.user_id == i.user_id)
            .ok_or_else(|| refuse("bank.global_quote_not_found"))?;
        if lock.asset_id != space.asset_id.to_uppercase()
            || lock.amount != amount_text
            || lock.to_currency != to_currency
        {
            return Err(refuse("bank.global_quote_mismatch"));
        }
    }
    let row = instruction(
        d,
        &Instruction {
            user_id: i.user_id,
            key: &key,
            from_space_id: &space.id,
            asset_id: &space.asset_id,
            amount: &amount_text,
            to_currency: &to_currency,
            recipient_id: &recipient.id,
            country: &country,
            delivery_method: &delivery_method,
            compliance: &compliance,
            quote_id: quote_id.as_deref(),
        },
    )?;
    drive(d, row, &space, amount)
}

struct Instruction<'a> {
    user_id: &'a str,
    key: &'a str,
    from_space_id: &'a str,
    asset_id: &'a str,
    amount: &'a str,
    to_currency: &'a str,
    recipient_id: &'a str,
    country: &'a str,
    delivery_method: &'a str,
    compliance: &'a str,
    quote_id: Option<&'a str>,
}

/// `instruction`: the send's row, once per key; the same key with other details is `bank.global_conflict`.
fn instruction(d: &Deps<'_>, i: &Instruction<'_>) -> Result<SendRow, Refusal> {
    let id = uuid()?;
    let compliance = (!i.compliance.is_empty()).then_some(i.compliance);
    let inserted = with(d.store, |c| {
        Ok(c.execute(
            "INSERT INTO bank.global_sends (id, user_id, idempotency_key, from_space_id, asset_id, amount, to_currency, \
             recipient_id, country, delivery_method, compliance, quote_id, status) VALUES ($1::text::uuid, $2, $3, \
             $4::text::uuid, $5, $6, $7, $8::text::uuid, $9, $10, $11, $12::text::uuid, 'submitted') \
             ON CONFLICT (user_id, idempotency_key) DO NOTHING",
            &[
                &id,
                &i.user_id,
                &i.key,
                &i.from_space_id,
                &i.asset_id,
                &i.amount,
                &i.to_currency,
                &i.recipient_id,
                &i.country,
                &i.delivery_method,
                &compliance,
                &i.quote_id,
            ],
        ))
    })?;
    if let Err(e) = inserted {
        // One lock pays one send: a second send (another key) on a quote a live or paid send holds is refused, and
        // nothing is recorded for it. The same request twice at once can meet here too, and is the same send.
        let on_lock = e
            .as_db_error()
            .is_some_and(|db| db.constraint() == Some("global_sends_quote_uq"));
        if !on_lock {
            return Err(pg(&e));
        }
        if send_by_key(d, i.user_id, i.key)?.is_none() {
            return Err(refuse("bank.global_quote_used"));
        }
    }
    let row =
        send_by_key(d, i.user_id, i.key)?.ok_or_else(|| refuse("bank.global_outcome_unknown"))?;
    let same = row.from_space_id == i.from_space_id
        && row.asset_id == i.asset_id
        && row.amount == i.amount
        && row.to_currency == i.to_currency
        && row.recipient_id == i.recipient_id
        && row.country == i.country
        && row.delivery_method == i.delivery_method
        && row.compliance.as_deref().unwrap_or("") == i.compliance
        && row.quote_id.as_deref() == i.quote_id;
    if !same {
        return Err(refuse("bank.global_conflict"));
    }
    Ok(row)
}

fn rail_id(d: &Deps<'_>, unusable: &str) -> Result<String, Refusal> {
    let raw = d.w.ports.payout_rail_id().map_err(Refusal::Other)?;
    let id = js_trim(&raw);
    if id.is_empty() || units(id) > 64 {
        return Err(refuse(unusable));
    }
    Ok(id.to_owned())
}

/// `reverseCancelled`: turns back a cancelled send's forward entry when one exists (occurrence 1, keyed by the send).
fn reverse_cancelled(d: &Deps<'_>, row: &SendRow) -> Result<(), Refusal> {
    if tx_by_key(d, &forward_key(&row.id))?.is_none() {
        return Ok(());
    }
    let rail = rail_id(d, "bank.global_outcome_unknown")?;
    let account = with(d.store, |c| space::get(c, &row.from_space_id))?.ledger_account();
    let (_, amount) = canonical(&row.amount)?;
    reverse_from_rail(d, &row.id, &account, &rail, amount)
        .map_err(|_| refuse("bank.global_outcome_unknown"))?;
    Ok(())
}

/// `settleCancelled`: a cancelled send keeps nothing; a read never fails on it, and a failed reversal is tried again on
/// the next read.
fn settle_cancelled(d: &Deps<'_>, row: &SendRow) {
    if row.status == "cancelled" {
        let _ = reverse_cancelled(d, row);
    }
}

fn supplied(row: &SendRow) -> Vec<(String, String)> {
    match row.compliance.as_deref().map(json::parse) {
        Some(Ok(Json::Object(fields))) => fields
            .into_iter()
            .map(|(k, v)| {
                (
                    k,
                    if let Json::String(s) = v {
                        s
                    } else {
                        String::new()
                    },
                )
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// `drive`: carries a recorded send as far as it can go, in the TypeScript's order of checks.
fn drive(d: &Deps<'_>, mut row: SendRow, space: &Space, amount: Amount) -> Result<Json, Refusal> {
    if row.status == "failed" {
        return Err(refuse(
            row.failure_code
                .as_deref()
                .unwrap_or("bank.global_payout_unset"),
        ));
    }
    if row.status == "cancelled" {
        reverse_cancelled(d, &row)?;
        return Ok(row.view());
    }
    if row.status != "submitted" {
        return Ok(row.view());
    }
    // A forward entry that posted but was never recorded is recorded before any refusal below: the send is then paid at
    // its lock, or left open as unknown, and never failed while the rail boundary holds its value.
    if row.ledger_tx_id.is_none()
        && let Some(posted) = tx_by_key(d, &forward_key(&row.id))?
    {
        with(d.store, |c| {
            c.execute(
                "UPDATE bank.global_sends SET ledger_tx_id = $2, updated_at = now() \
                 WHERE id = $1::text::uuid AND status = 'submitted' AND ledger_tx_id IS NULL",
                &[&row.id, &posted.id],
            )
            .map_err(|e| pg(&e))
        })?;
        row.ledger_tx_id = Some(posted.id);
    }
    let p = &d.w.ports;
    if !p.corridors_live() {
        return Err(definite(d, &row, "bank.global_corridors_unset", None));
    }
    let catalogue = corridors(d)?;
    let Some((corridor, _)) = catalogue.iter().find(|(c, _)| {
        c.country == row.country
            && c.currency == row.to_currency
            && c.delivery_methods.contains(&row.delivery_method)
    }) else {
        return Err(definite(d, &row, "bank.global_corridor_unknown", None));
    };
    // The corridor's own bounds, as the catalogue gives them: outside them nothing is quoted or posted.
    if let Some(min) = &corridor.min_amount
        && amount < parse_amount(min).map_err(Refusal::Other)?
    {
        let detail = format!("The smallest send for this destination is {min}.");
        return Err(definite(
            d,
            &row,
            "bank.global_amount_outside_corridor",
            Some(&detail),
        ));
    }
    if let Some(max) = &corridor.max_amount
        && amount > parse_amount(max).map_err(Refusal::Other)?
    {
        let detail = format!("The largest send for this destination is {max}.");
        return Err(definite(
            d,
            &row,
            "bank.global_amount_outside_corridor",
            Some(&detail),
        ));
    }
    if !p.fx_live() {
        return Err(definite(d, &row, "bank.global_fx_unset", None));
    }
    if !p.payout_live() {
        return Err(definite(d, &row, "bank.global_payout_unset", None));
    }
    if !pays_out(d, &row.country, &row.to_currency, &row.delivery_method)? {
        return Err(definite(d, &row, "bank.global_payout_uncovered", None));
    }
    let Some(decision) = p
        .travel_rule()
        .filter(|t| !js_trim(&t.decided_by).is_empty())
    else {
        return Err(definite(d, &row, "bank.global_travel_rule_undecided", None));
    };
    let given = supplied(&row);
    let value_of = |k: &str| {
        given
            .iter()
            .find(|(key, _)| key == k)
            .map_or("", |(_, v)| js_trim(v))
    };
    if decision
        .required_fields
        .iter()
        .any(|field| value_of(field).is_empty())
    {
        return Err(definite(
            d,
            &row,
            "bank.global_travel_rule_incomplete",
            None,
        ));
    }

    let settings = &d.w.settings;
    let Some(controls) = rules::payee_controls(settings.payee_controls.as_deref()) else {
        return Err(definite(d, &row, "bank.payee_controls_unset", None));
    };
    let payee = recipient_by_id(d, &row.recipient_id)?;
    let payee_account = rules::normalize_account(&payee.account);
    if controls.blocked.contains(&payee_account) {
        return Err(definite(d, &row, "bank.payee_blocked", None));
    }
    let Some(allowance) = rules::exchange_allowance(settings.exchange_allowance.as_deref()) else {
        return Err(definite(d, &row, "bank.exchange_allowance_unset", None));
    };
    if allowance.accounts.contains(&payee_account) {
        let Some(limit) = allowance.limits.get(&row.asset_id.to_uppercase()) else {
            return Err(definite(d, &row, "bank.exchange_allowance_unset", None));
        };
        // Every send to an exchange since the window opened counts, in the order they were taken in, this one included:
        // two sends made at the same moment cannot both fit a room that holds only one.
        let window =
            i32::try_from(allowance.window_days).map_err(|e| Refusal::Other(e.to_string()))?;
        let total: Option<String> = with(d.store, |c| {
            c.query_one(
                "SELECT sum(s.amount::numeric)::text FROM bank.global_sends me \
                 JOIN bank.global_sends s ON s.user_id = me.user_id AND s.asset_id = me.asset_id \
                 JOIN bank.global_recipients r ON r.id = s.recipient_id \
                 WHERE me.id = $1::text::uuid AND s.status <> 'failed' \
                 AND s.created_at > me.created_at - make_interval(days => $2::int4) \
                 AND (s.created_at, s.id) <= (me.created_at, me.id) \
                 AND upper(replace(r.account, ' ', '')) = ANY($3::text[])",
                &[&row.id, &window, &allowance.account_list],
            )
            .and_then(|r| r.try_get::<_, Option<String>>(0))
            .map_err(|e| pg(&e))
        })?;
        let total = parse_amount(total.as_deref().unwrap_or("0")).map_err(Refusal::Other)?;
        if total > parse_amount(limit).map_err(Refusal::Other)? {
            return Err(definite(d, &row, "bank.exchange_allowance_exceeded", None));
        }
    }
    let field_rules = rules::send_field_rules(settings.send_field_rules.as_deref());
    if let Some(r) = rules::check_send_fields(
        field_rules.as_ref(),
        &FieldContext {
            asset_id: &row.asset_id,
            amount: &row.amount,
            to_currency: &row.to_currency,
            country: &row.country,
            delivery_method: &row.delivery_method,
            compliance: &given,
        },
    ) {
        let detail = r
            .max_length
            .map(|m| format!("The reference can be at most {m} characters for this rail."));
        return Err(definite(d, &row, r.code, detail.as_deref()));
    }

    let lock = locked_quote(d, &row)?;
    let rail = rail_id(d, "bank.global_payout_unusable")?;
    let account = space.ledger_account();
    let mut tx_id = row.ledger_tx_id.clone();
    // The TEST stand-in's screening: a send it marks is put on hold here, with nothing posted. A send screened before
    // (its hold released) carries on.
    if tx_id.is_none()
        && p.review_waits(&row.asset_id, &row.amount) == Some(true)
        && holds::screen(d, &row.id)?
    {
        return Ok(send_by_id(d, &row.id, None)?.unwrap_or(row).view());
    }
    if tx_id.is_none() {
        // A hold placed while this send was being checked wins: nothing is posted for a held send.
        if let Some(fresh) = send_by_id(d, &row.id, None)?
            && fresh.status != "submitted"
        {
            return Ok(fresh.view());
        }
        let tx = match tx_by_key(d, &forward_key(&row.id))? {
            Some(tx) => tx,
            None => match post_to_rail(d, &row.id, &account, &rail, amount) {
                Ok(tx) => tx,
                Err(PostError::Ledger(f)) if f.insufficient() => {
                    return Err(definite(
                        d,
                        &row,
                        "bank.global_insufficient_funds",
                        Some(f.message()),
                    ));
                }
                Err(e) => return Err(post_thrown(e)),
            },
        };
        with(d.store, |c| {
            c.execute(
                "UPDATE bank.global_sends SET ledger_tx_id = $2, updated_at = now() \
                 WHERE id = $1::text::uuid AND status IN ('submitted', 'held') AND ledger_tx_id IS NULL",
                &[&row.id, &tx.id],
            )
            .map_err(|e| pg(&e))
        })?;
        tx_id = Some(tx.id);
        // A hold that landed while the forward entry was being posted stands: no payout until someone else releases it.
        if let Some(after) = send_by_id(d, &row.id, None)? {
            if after.status == "cancelled" {
                // Held and cancelled in the instant of posting: the cancelled send keeps nothing, so the entry is turned
                // back; if this fails, the next read or replay of the send turns it back.
                reverse_cancelled(d, &after)?;
                return Ok(after.view());
            }
            if after.status != "submitted" {
                return Ok(after.view());
            }
        }
    }
    let answer = p
        .payout_submit(&Payout {
            send_id: row.id.clone(),
            idempotency_key: row.idempotency_key.clone(),
            amount: row.amount.clone(),
            asset_id: row.asset_id.clone(),
            to_currency: row.to_currency.clone(),
            recipient_id: row.recipient_id.clone(),
            quote_id: lock.id.clone(),
            rate: lock.rate.clone(),
            receive_amount: lock.receive_amount.clone(),
        })
        .map_err(|_| refuse("bank.global_outcome_unknown"))?;
    let (provider_ref, status) = match answer {
        PayoutAnswer::Refused => {
            reverse_from_rail(d, &row.id, &account, &rail, amount)
                .map_err(|_| refuse("bank.global_outcome_unknown"))?;
            return Err(definite(d, &row, "bank.global_payout_refused", None));
        }
        PayoutAnswer::Accepted {
            provider_ref,
            status,
        } => (js_trim(&provider_ref).to_owned(), status),
    };
    if provider_ref.is_empty() || units(&provider_ref) > 128 || !LEFT.contains(&status.as_str()) {
        return Err(refuse("bank.global_outcome_unknown"));
    }
    let valid_until = lock.valid_until.0;
    with(d.store, |c| {
        c.execute(
            &format!(
                "UPDATE bank.global_sends SET status = $2, provider_ref = $3, ledger_tx_id = $4, quote_rate = $5, \
                 quote_fee = $6, quote_fee_asset = $7, quote_receive = $8, quote_valid_until = {}, quote_eta = $10, \
                 failure_code = NULL, failure_blocker = NULL, updated_at = now() \
                 WHERE id = $1::text::uuid AND status = 'submitted'",
                at("$9")
            ),
            &[
                &row.id,
                &status,
                &provider_ref,
                &tx_id,
                &lock.rate,
                &lock.fee,
                &lock.fee_asset,
                &lock.receive_amount,
                &valid_until,
                &lock.eta,
            ],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(must_send(d, &row.id)?.view())
}

/// `resume`: carries on a send whose hold was released, with the same steps, checks and keys.
pub fn resume(d: &Deps<'_>, id: &str) -> Result<Json, Refusal> {
    let row = must_send(d, id)?;
    let space = owned_space(d, &row.user_id, &row.from_space_id)?;
    let (_, amount) = canonical(&row.amount)?;
    drive(d, row, &space, amount)
}

/// `list`: the person's sends, newest first, a page at a time.
pub fn list(
    d: &Deps<'_>,
    user_id: &str,
    limit: Option<i64>,
    cursor: Option<&str>,
) -> Result<Json, Refusal> {
    let limit = limit.ok_or_else(|| refuse("bank.global_list_limit_unset"))?;
    let take = limit + 1;
    let rows = match cursor {
        Some(c) => {
            let (at, id) = decode_cursor(c)?;
            sends_where(
                d,
                "user_id = $1 AND (created_at, id) < ($2::text::timestamptz, $3::text::uuid) \
                 ORDER BY created_at DESC, id DESC LIMIT $4",
                &[&user_id, &at, &id, &take],
            )?
        }
        None => sends_where(
            d,
            "user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2",
            &[&user_id, &take],
        )?,
    };
    let page_len = usize::try_from(limit).unwrap_or(usize::MAX).min(rows.len());
    let page = rows.get(..page_len).unwrap_or_default();
    for row in page {
        settle_cancelled(d, row);
    }
    let next = if rows.len() > page_len {
        page.last()
            .map(|last| encode_cursor(last.created_at, &last.id))
    } else {
        None
    };
    Ok(Json::Object(vec![
        f(
            "items",
            Json::Array(page.iter().map(SendRow::view).collect()),
        ),
        f("nextCursor", next.map_or(Json::Null, Json::str)),
    ]))
}

/// `get`: the person's own send, any other told it does not exist.
pub fn get(d: &Deps<'_>, user_id: &str, id: &str) -> Result<SendRow, Refusal> {
    let row = send_by_id(d, id, Some(user_id))?.ok_or_else(|| refuse("bank.global_not_found"))?;
    settle_cancelled(d, &row);
    Ok(row)
}

/// `opsGet`.
pub fn ops_get(d: &Deps<'_>, id: &str) -> Result<SendRow, Refusal> {
    let row = send_by_id(d, id, None)?.ok_or_else(|| refuse("bank.global_not_found"))?;
    settle_cancelled(d, &row);
    Ok(row)
}

type HmacSha256 = Hmac<Sha256>;

fn hmac(key: &[u8], bytes: &[u8]) -> Vec<u8> {
    #[allow(clippy::expect_used, reason = "HMAC takes a key of any length")]
    let mut m = HmacSha256::new_from_slice(key).expect("hmac key");
    m.update(bytes);
    m.finalize().into_bytes().to_vec()
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `signReceipt`: the text's SHA-256, and an HMAC-SHA256 over it under HKDF-SHA256(secret, empty salt, `info`, 32).
pub fn sign_receipt(text: &str, secret: &str, info: &str) -> (String, String) {
    let prk = hmac(&[0_u8; 32], secret.as_bytes());
    let mut t = info.as_bytes().to_vec();
    t.push(1);
    let key = hmac(&prk, &t);
    (
        hex(&Sha256::digest(text.as_bytes())),
        hex(&hmac(&key, text.as_bytes())),
    )
}

/// `receipt`: the signed receipt of a send that left; the same send always gives the same bytes.
pub fn receipt(d: &Deps<'_>, user_id: &str, id: &str) -> Result<Json, Refusal> {
    let row = send_by_id(d, id, Some(user_id))?.ok_or_else(|| refuse("bank.global_not_found"))?;
    let left = ["sent", "on_the_way", "arrived", "returned", "refunded"];
    let Some(ledger_tx_id) = row
        .ledger_tx_id
        .clone()
        .filter(|_| left.contains(&row.status.as_str()))
    else {
        return Err(refuse("bank.receipt_not_ready"));
    };
    let secret =
        d.w.settings
            .receipt_secret
            .as_deref()
            .map(js_trim)
            .unwrap_or_default()
            .to_owned();
    if secret.is_empty() {
        return Err(refuse("bank.receipt_signing_unset"));
    }
    let to = recipient_by_id(d, &row.recipient_id)?;
    let last4: String = {
        let units: Vec<u16> = to.account.encode_utf16().collect();
        String::from_utf16_lossy(
            units
                .get(units.len().saturating_sub(4)..)
                .unwrap_or_default(),
        )
    };
    let o = |v: &Option<String>| v.clone().unwrap_or_default();
    let text = [
        "INTAFACED receipt: global send".to_owned(),
        format!("Send: {}", row.id),
        format!("Created (UTC): {}", row.created_at.iso()),
        format!("Status: {}", row.status),
        format!("Sent: {} {}", row.amount, row.asset_id),
        format!(
            "They receive: {} {}",
            o(&row.quote_receive),
            row.to_currency
        ),
        format!("Rate: {}", o(&row.quote_rate)),
        format!("Fee: {} {}", o(&row.quote_fee), o(&row.quote_fee_asset)),
        format!(
            "To: {} \u{b7} \u{2026}{} ({}, {})",
            one_line(Some(&to.name)),
            one_line(Some(&last4)),
            one_line(Some(&row.country)),
            one_line(Some(&row.delivery_method))
        ),
        format!(
            "Payout reference: {}",
            one_line(row.provider_ref.as_deref())
        ),
        format!("Ledger transaction: {ledger_tx_id}"),
        String::new(),
    ]
    .join("\n");
    let (sha256, signature) = sign_receipt(&text, &secret, GLOBAL_RECEIPT_INFO);
    Ok(Json::Object(vec![
        f("fileName", Json::str(format!("receipt-{}.txt", row.id))),
        f("text", Json::str(text)),
        f("ledgerTxId", Json::str(ledger_tx_id)),
        f("sha256", Json::str(sha256)),
        f("signature", Json::str(signature)),
    ]))
}

/// `opsSummary`: the counts and volumes by status, and which ports are live.
pub fn ops_summary(d: &Deps<'_>) -> Result<Json, Refusal> {
    let grouped = with(d.store, |c| {
        c.query(
            "SELECT status, asset_id, count(*)::text, sum(amount::numeric)::text FROM bank.global_sends GROUP BY status, asset_id",
            &[],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(|r| -> Result<(String, String, String, String), Refusal> {
            let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
            Ok((s(0)?, s(1)?, s(2)?, s(3)?))
        })
        .collect::<Result<Vec<_>, _>>()
    })?;
    let mut counts: Vec<(String, i64)> = STATUSES.iter().map(|s| ((*s).to_owned(), 0)).collect();
    let mut volumes = Vec::new();
    for (status, asset, n, total) in grouped {
        let Some(slot) = counts.iter_mut().find(|(s, _)| *s == status) else {
            return Err(refuse("bank.global_outcome_unknown"));
        };
        let count: i64 = n
            .parse()
            .map_err(|_| refuse("bank.global_outcome_unknown"))?;
        if count > 9_007_199_254_740_991 {
            return Err(refuse("bank.global_outcome_unknown"));
        }
        slot.1 += count;
        let amount = format_amount(parse_amount(&total).map_err(Refusal::Other)?);
        volumes.push(Json::Object(vec![
            f("status", Json::str(status)),
            f("assetId", Json::str(asset)),
            f("count", Json::int(count)),
            f("amount", Json::str(amount)),
        ]));
    }
    let p = &d.w.ports;
    let live = |l: bool| Json::str(if l { "live" } else { "unset" });
    Ok(Json::Object(vec![
        f("asOf", Json::str(d.now.iso())),
        f(
            "counts",
            Json::Object(counts.into_iter().map(|(s, n)| (s, Json::int(n))).collect()),
        ),
        f("volumes", Json::Array(volumes)),
        f(
            "rails",
            Json::Object(vec![
                f("corridors", live(p.corridors_live())),
                f("fx", live(p.fx_live())),
                f("payout", live(p.payout_live())),
                f("bic", live(p.bic_live())),
                f(
                    "travelRule",
                    Json::str(if p.travel_rule().is_some() {
                        "recorded"
                    } else {
                        "undecided"
                    }),
                ),
                f("blocker", Json::str(PSP_BLOCKER)),
                f("standIn", p.stand_in().map_or(Json::Null, Json::str)),
            ]),
        ),
    ]))
}

/// `opsFailed`: failed sends, newest first.
pub fn ops_failed(d: &Deps<'_>, limit: Option<i64>) -> Result<Json, Refusal> {
    let limit = limit.ok_or_else(|| refuse("bank.global_list_limit_unset"))?;
    let rows = sends_where(
        d,
        "status = 'failed' ORDER BY created_at DESC, id DESC LIMIT $1",
        &[&limit],
    )?;
    Ok(Json::Array(rows.iter().map(SendRow::ops_view).collect()))
}

/// `opsRecalls`: open recall requests, oldest first.
pub fn ops_recalls(d: &Deps<'_>, limit: Option<i64>) -> Result<Json, Refusal> {
    let limit = limit.ok_or_else(|| refuse("bank.global_list_limit_unset"))?;
    let rows = sends_where(
        d,
        "recall_requested_at IS NOT NULL AND status <> 'refunded' ORDER BY recall_requested_at, id LIMIT $1",
        &[&limit],
    )?;
    Ok(Json::Array(rows.iter().map(SendRow::ops_view).collect()))
}

/// `recordReturn`: the rail sent a send back, recorded with the rail's own reference. Nothing posts.
pub fn record_return(
    d: &Deps<'_>,
    send_id: &str,
    return_ref: &str,
    operator: &str,
) -> Result<Json, Refusal> {
    let return_ref = require_text(return_ref, 128)?;
    let operator = require_text(operator, 128)?;
    let row = must_send(d, send_id)?;
    let done = |r: &SendRow| r.status == "returned" || r.status == "refunded";
    if done(&row) {
        if row.return_ref.as_deref() != Some(return_ref.as_str()) {
            return Err(refuse("bank.global_return_conflict"));
        }
        return Ok(row.ops_view());
    }
    if !LEFT.contains(&row.status.as_str()) || row.ledger_tx_id.is_none() {
        return Err(refuse("bank.global_not_returnable"));
    }
    let moved = with(d.store, |c| {
        Ok(c.query(
            "UPDATE bank.global_sends SET status = 'returned', return_ref = $2, returned_by = $3, returned_at = now(), \
             updated_at = now() WHERE id = $1::text::uuid AND status IN ('sent', 'on_the_way', 'arrived') \
             AND ledger_tx_id IS NOT NULL RETURNING id",
            &[&row.id, &return_ref, &operator],
        ))
    })?;
    let moved = match moved {
        Ok(rows) => rows.len(),
        Err(e) if e.code() == Some(&SqlState::UNIQUE_VIOLATION) => {
            return Err(refuse("bank.global_return_conflict"));
        }
        Err(e) => return Err(pg(&e)),
    };
    if moved == 0 {
        // Recorded by someone else in the same instant: their reference stands, and a different one is a conflict.
        let now = must_send(d, &row.id)?;
        if done(&now) && now.return_ref.as_deref() == Some(return_ref.as_str()) {
            return Ok(now.ops_view());
        }
        return Err(refuse("bank.global_return_conflict"));
    }
    Ok(must_send(d, &row.id)?.ops_view())
}

/// `refundReturn`: a returned send's whole amount back to its sender's space, once, by another operator, and only at a
/// published zero refund fee. The entry back shares the occurrence-1 key with the reversal of a refused payout.
pub fn refund_return(d: &Deps<'_>, send_id: &str, operator: &str) -> Result<Json, Refusal> {
    let operator = require_text(operator, 128)?;
    let row = must_send(d, send_id)?;
    if row.status == "refunded" {
        return Ok(row.ops_view());
    }
    if row.status != "returned" || row.ledger_tx_id.is_none() {
        return Err(refuse("bank.global_not_returned"));
    }
    if row.returned_by.as_deref() == Some(operator.as_str()) {
        return Err(refuse("bank.refund_same_operator"));
    }
    let fee =
        d.w.settings
            .refund_fee
            .as_deref()
            .map(js_trim)
            .unwrap_or_default();
    if fee.is_empty() || !rules::is_decimal(fee) {
        return Err(refuse("bank.refund_fee_unset"));
    }
    if parse_amount(fee).map_err(Refusal::Other)? != 0 {
        return Err(refuse("bank.refund_fee_unsupported"));
    }
    let rail = rail_id(d, "bank.global_payout_unusable")?;
    let account = match with(d.store, |c| space::get(c, &row.from_space_id)) {
        Ok(s) => s.ledger_account(),
        Err(Refusal::Bank(e)) if e.row.code == "bank.space_not_found" => {
            return Err(refuse("bank.global_space_not_found"));
        }
        Err(e) => return Err(e),
    };
    // The refund comes off the rail boundary the send was posted to: if the connected rail is another one now, nothing
    // is refunded from here.
    let forward = tx_by_key(d, &forward_key(&row.id))?;
    let boundary = d
        .ledger
        .account_id(&rail_boundary(&rail, &row.asset_id))
        .map_err(Refusal::Other)?;
    let on_boundary = forward.is_some_and(|t| {
        !boundary.is_empty() && t.entries.iter().any(|e| e.account_id == boundary)
    });
    if !on_boundary {
        return Err(refuse("bank.refund_rail_changed"));
    }
    // An entry under the occurrence-1 key that no refund of this send started was turned back some other way.
    let prior = tx_by_key(d, &reverse_key(&row.id))?;
    if prior.is_some() && row.refund_operator_id.is_none() {
        return Err(refuse("bank.refund_already_reversed"));
    }
    if prior.is_none() {
        with(d.store, |c| {
            c.execute(
                "UPDATE bank.global_sends SET refund_operator_id = $2, updated_at = now() \
                 WHERE id = $1::text::uuid AND status = 'returned'",
                &[&row.id, &operator],
            )
            .map_err(|e| pg(&e))
        })?;
    }
    let (_, amount) = canonical(&row.amount)?;
    reverse_from_rail(d, &row.id, &account, &rail, amount)
        .map_err(|_| refuse("bank.global_outcome_unknown"))?;
    with(d.store, |c| {
        c.execute(
            "UPDATE bank.global_sends SET status = 'refunded', refund_operator_id = $2, refunded_at = now(), \
             updated_at = now() WHERE id = $1::text::uuid AND status = 'returned'",
            &[&row.id, &operator],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(must_send(d, &row.id)?.ops_view())
}

/// `recall`: the person asks for a send that left to come back; kept as a request on the send, nothing moves.
pub fn recall(d: &Deps<'_>, user_id: &str, id: &str, reason: &str) -> Result<Json, Refusal> {
    let reason = require_text(&one_line_keep(reason), 500)?;
    let row = send_by_id(d, id, Some(user_id))?.ok_or_else(|| refuse("bank.global_not_found"))?;
    if row.recall_requested_at.is_some() {
        return Ok(row.view());
    }
    if !LEFT.contains(&row.status.as_str()) || row.ledger_tx_id.is_none() {
        return Err(refuse("bank.global_not_recallable"));
    }
    with(d.store, |c| {
        c.execute(
            "UPDATE bank.global_sends SET recall_reason = $2, recall_requested_at = now(), updated_at = now() \
             WHERE id = $1::text::uuid AND recall_requested_at IS NULL",
            &[&row.id, &reason],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(must_send(d, &row.id)?.view())
}

/// `reason.replace(/[\p{Cc}  ]+/gu, ' ')`, untrimmed.
fn one_line_keep(s: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in s.chars() {
        if c.is_control() || c == '\u{2028}' || c == '\u{2029}' {
            if !gap {
                out.push(' ');
            }
            gap = true;
        } else {
            out.push(c);
            gap = false;
        }
    }
    out
}

/// `standInPayout`: the TEST stand-in's own record of one send it paid out.
pub fn stand_in_payout(d: &Deps<'_>, send_id: &str) -> Result<Json, Refusal> {
    let r =
        d.w.ports
            .stand_in_payout(send_id)
            .ok_or_else(|| refuse("bank.global_not_found"))?;
    Ok(Json::Object(vec![
        f("sendId", Json::str(r.send_id)),
        f("quoteId", Json::str(r.quote_id)),
        f("assetId", Json::str(r.asset_id)),
        f("amount", Json::str(r.amount)),
        f("toCurrency", Json::str(r.to_currency)),
        f("rate", Json::str(r.rate)),
        f("receiveAmount", Json::str(r.receive_amount)),
        f("conversions", Json::int(r.conversions)),
        f("calls", Json::int(r.calls)),
    ]))
}

/// `exchangeAllowanceStatus`, `payeeControlsStatus` and the holds' `proofLimitsStatus`: what the owner published,
/// never the accounts or limits themselves.
pub fn controls(d: &Deps<'_>) -> Json {
    let s = &d.w.settings;
    let state = |p: bool| Json::str(if p { "published" } else { "unset" });
    let payee = rules::payee_controls(s.payee_controls.as_deref());
    let allowance = rules::exchange_allowance(s.exchange_allowance.as_deref());
    let proof = rules::proof_limits(s.proof_limits.as_deref());
    let count = |n: usize| Json::int(i64::try_from(n).unwrap_or(i64::MAX));
    Json::Object(vec![
        f(
            "payeeControls",
            Json::Object(vec![
                f("state", state(payee.is_some())),
                f(
                    "blockedCount",
                    count(payee.as_ref().map_or(0, |p| p.blocked.len())),
                ),
            ]),
        ),
        f(
            "exchangeAllowance",
            Json::Object(vec![
                f("state", state(allowance.is_some())),
                f(
                    "windowDays",
                    allowance
                        .as_ref()
                        .map_or(Json::Null, |a| Json::int(a.window_days)),
                ),
                f(
                    "exchangeCount",
                    count(allowance.as_ref().map_or(0, |a| a.accounts.len())),
                ),
            ]),
        ),
        f(
            "proofLimits",
            Json::Object(vec![
                f("state", state(proof.is_some())),
                f(
                    "allowedTypes",
                    Json::Array(
                        proof
                            .as_ref()
                            .map(|p| {
                                p.allowed_types
                                    .iter()
                                    .map(|t| Json::str(t.clone()))
                                    .collect()
                            })
                            .unwrap_or_default(),
                    ),
                ),
                f(
                    "maxBytes",
                    proof
                        .as_ref()
                        .map_or(Json::Null, |p| Json::int(p.max_bytes)),
                ),
            ]),
        ),
    ])
}

/// `partner`: who answers a send, the TEST stand-in's label or none.
pub fn partner(d: &Deps<'_>) -> Json {
    Json::obj([(
        "standIn",
        d.w.ports.stand_in().map_or(Json::Null, Json::str),
    )])
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn the_cursor_round_trips_and_reads_as_node_reads_base64url() {
        let at = service_kit::time::js_date("2026-11-23T10:00:00.123Z").unwrap();
        let id = "c4b8d2f3-5e6a-4b7c-9d0e-1f2a3b4c5d6e";
        let c = encode_cursor(at, id);
        assert_eq!(
            decode_cursor(&c).unwrap(),
            ("2026-11-23T10:00:00.123Z".to_owned(), id.to_owned())
        );
        // Node skips characters outside both alphabets and stops at the first `=`.
        assert_eq!(node_base64("YW$Jj"), b"abc");
        assert_eq!(node_base64("YWJj==YWJj"), b"abc");
        assert_eq!(node_base64("YW-_"), [0x61, 0x6f, 0xbf]);
        assert!(decode_cursor("bm9wZQ").is_err());
    }

    #[test]
    fn compliance_is_sorted_trimmed_and_blank_values_dropped() {
        let v = Value::from_json(&json::parse(r#"{"b":" x ","a":"y","c":"  ","2":"n"}"#).unwrap());
        assert_eq!(
            canonical_compliance(Some(&v)).unwrap(),
            r#"{"2":"n","a":"y","b":"x"}"#
        );
        let bad = Value::from_json(&json::parse(r#"{"a b":"y"}"#).unwrap());
        assert!(canonical_compliance(Some(&bad)).is_err());
        assert_eq!(canonical_compliance(None).unwrap(), "");
    }

    #[test]
    fn receipt_key_matches_node_hkdf() {
        // node -e "const c=require('crypto');const k=Buffer.from(c.hkdfSync('sha256','s',Buffer.alloc(0),'bank.global.receipt.v1',32));console.log(c.createHmac('sha256',k).update('t').digest('hex'))"
        let (sha, signature) = sign_receipt("t", "s", GLOBAL_RECEIPT_INFO);
        assert_eq!(sha, hex(&Sha256::digest(b"t")));
        assert_eq!(
            signature,
            "8c358a9c6ad448cc1b08b1d011889645d9dc9b4b33f36c54bf56ec698390e122"
        );
    }
}
