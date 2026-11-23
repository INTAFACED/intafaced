//! `BusinessCardsService` (`business/business-cards.ts`): a business gives its team cards and handles their expenses
//! (J-bank-22; BK-bcard-01, BK-bexp-01, BK-bexp-02).
//!
//! The business's money is the partner bank's, in its own account at the partner, `business:<account id>`.
//! INTAFACED's ledger posts nothing for any of this.
//!
//! - cards: a member with `manage_team` issues a TEST card to a member with a per-purchase limit; no card number, CVC
//!   or PIN exists anywhere (the last four digits are derived from the card id);
//! - purchases: over the card's limit a purchase is declined `over_limit`, moves nothing and opens one request to the
//!   admins; within it, it is captured as one partner move from the business's account to the TEST merchant, under
//!   `bank.business.card-capture:<purchase id>`, stored before it is sent and sent once; a lost answer is read back by
//!   its key. The partner's no (not enough money, a restricted account) declines it;
//! - receipts: the business's own receipt rule; a captured purchase over it with no receipt needs one, with exactly one
//!   reminder queued; `export` downloads every receipt in one ZIP file (stored entries, written by hand);
//! - reimbursements: a member claims back what they paid, with a receipt; someone else holding `approve` pays it as
//!   one partner move to the member's own account under `bank.business.reimbursement:<claim id>`, the member's balance
//!   read just before and just after, as the partner reports it.

use std::collections::BTreeMap;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use postgres::{GenericClient, Row};
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, js_trim, parse_amount};
use service_kit::time::{Instant, civil_from_days};
use sha2::{Digest, Sha256};

use crate::business_team::service::{handles_of, partner_account, seat};
use crate::errors::Refusal;
use crate::partner::custody::{Held, assert_posting_enabled};
use crate::partner::{AccountRef, MERCHANT, MoveRequest, refuse};
use crate::spaces::space::{at, in_tx, pg, with};
use crate::transfers::Deps;

/// `MAX_RECEIPT_BYTES`: 512 KiB.
pub const MAX_RECEIPT_BYTES: usize = 524_288;

/// `RECEIPT_TYPES`.
pub const RECEIPT_TYPES: [&str; 4] = ["application/pdf", "image/png", "image/jpeg", "text/plain"];

/// `cardCaptureKey`: the business key of a captured purchase's one partner move.
pub fn card_capture_key(purchase_id: &str) -> String {
    format!("bank.business.card-capture:{purchase_id}")
}

/// `reimbursementKey`: the business key of a paid claim's one partner move.
pub fn reimbursement_key(claim_id: &str) -> String {
    format!("bank.business.reimbursement:{claim_id}")
}

/// `DEFINITE_DECLINES`: the partner's answers that say nothing moved, and the decline each is on the card.
fn definite_decline(code: &str) -> Option<&'static str> {
    match code {
        "bank.partner_insufficient_funds" => Some("insufficient_funds"),
        "bank.account_restricted" => Some("account_restricted"),
        _ => None,
    }
}

/// `DEFINITE_REFUSALS`: a claim's refusals that say nothing moved; the claim goes back to `submitted`.
const DEFINITE_REFUSALS: [&str; 3] = [
    "bank.partner_insufficient_funds",
    "bank.account_restricted",
    "bank.partner_move_conflict",
];

fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `testCardTail`: the last four digits of a TEST card, from its id, so stable, and the tail of no card number anyone
/// issued.
pub fn test_card_tail(card_id: &str) -> String {
    let hex = sha256_hex(format!("business-card:{card_id}").as_bytes());
    let head = u64::from_str_radix(hex.get(..8).unwrap_or("0"), 16).unwrap_or(0);
    format!("{:04}", head % 10_000)
}

/// `^[^\p{Cc}]{1,<max>}$` with the `u` flag (code points), and for a file name no `/` or `\` either.
fn plain(s: &str, max: usize, no_slashes: bool) -> bool {
    let n = s.chars().count();
    (1..=max).contains(&n)
        && s.chars().all(|c| {
            !(c <= '\u{1f}' || ('\u{7f}'..='\u{9f}').contains(&c))
                && !(no_slashes && (c == '/' || c == '\\'))
        })
}

/// `Buffer.from(text, 'base64')`: Node's lenient decoder. It stops at the first `=`, skips what is not of the
/// alphabet, and drops a trailing group's bits that make no whole byte.
pub fn node_base64(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3 + 2);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
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
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((acc >> bits) & 0xff).unwrap_or(0));
            acc &= (1 << bits) - 1;
        }
    }
    out
}

fn ms(col: &str) -> String {
    format!("floor(extract(epoch from {col}) * 1000)::int8")
}

fn amount(s: &str) -> Result<Amount, Refusal> {
    parse_amount(s).map_err(Refusal::Other)
}

fn opt_amount(s: Option<&str>) -> Result<Option<Amount>, Refusal> {
    s.map(amount).transpose()
}

fn opt_str(s: Option<&str>) -> Json {
    s.map_or(Json::Null, Json::str)
}

fn opt_fmt(a: Option<Amount>) -> Json {
    a.map_or(Json::Null, |a| Json::str(format_amount(a)))
}

fn iso(t: Option<Instant>) -> Json {
    t.map_or(Json::Null, |t| Json::str(t.iso()))
}

fn get_s(r: &Row, i: usize) -> Result<String, Refusal> {
    r.try_get::<_, String>(i).map_err(|e| pg(&e))
}

fn get_o(r: &Row, i: usize) -> Result<Option<String>, Refusal> {
    r.try_get::<_, Option<String>>(i).map_err(|e| pg(&e))
}

fn get_t(r: &Row, i: usize) -> Result<Option<Instant>, Refusal> {
    Ok(r.try_get::<_, Option<i64>>(i)
        .map_err(|e| pg(&e))?
        .map(Instant))
}

fn get_at(r: &Row, i: usize) -> Result<Instant, Refusal> {
    get_t(r, i)?.ok_or_else(|| Refusal::Other("a timestamp column was null".to_owned()))
}

// ---------------------------------------------------------------------------------------------------------------
// Refusals

fn field_invalid(message: &str) -> Refusal {
    refuse("bank.business_card_field_invalid", message)
}

fn receipt_invalid(message: &str) -> Refusal {
    refuse("bank.receipt_invalid", message)
}

fn conflict(what: &str) -> Refusal {
    refuse(
        "bank.business_request_conflict",
        format!("This {what} id is already used on different terms."),
    )
}

fn closed() -> Refusal {
    refuse("bank.business_closed", "This business account is closed.")
}

fn no_partner() -> Refusal {
    refuse(
        "bank.no_partner_bank",
        "This business\u{2019}s money is not held at a partner bank, so nothing can move.",
    )
}

fn purchase_not_found() -> Refusal {
    refuse(
        "bank.business_card_not_found",
        "No card purchase has that id.",
    )
}

/// `need`: the caller holds `permission`, or the refusal names it.
fn need(permissions: &[&str], permission: &str) -> Result<(), Refusal> {
    if permissions.contains(&permission) {
        return Ok(());
    }
    Err(refuse(
        "bank.business_role_forbidden",
        format!(
            "Your role on this business does not include {}, so this was refused. Nothing changed.",
            permission.replacen('_', " ", 1)
        ),
    ))
}

/// `positive`: an amount above zero, or `bank.business_card_field_invalid` naming what it is.
fn positive(raw: &str, what: &str) -> Result<Amount, Refusal> {
    let a =
        parse_amount(raw).map_err(|_| field_invalid(&format!("The {what} is not an amount.")))?;
    if a <= Amount::ZERO {
        return Err(field_invalid(&format!("The {what} must be above zero.")));
    }
    Ok(a)
}

/// `moneyMayMove`: refuses `bank.posting_frozen` while posting is frozen, or while the freeze cannot be read.
fn money_may_move(d: &Deps<'_>) -> Result<(), Refusal> {
    assert_posting_enabled(d.partner.freeze.as_ref(), d.store, "bank_move", true)
}

// ---------------------------------------------------------------------------------------------------------------
// Rows

struct CardRow {
    id: String,
    account_id: String,
    member_user_id: String,
    asset_id: String,
    per_purchase_limit: Amount,
    pan_tail: String,
    status: String,
    issued_by: String,
    created_at: Instant,
}

fn card_cols() -> String {
    format!(
        "id::text, account_id::text, member_user_id, asset_id, per_purchase_limit::text, pan_tail, status, issued_by, {}",
        ms("created_at")
    )
}

impl CardRow {
    fn of(r: &Row) -> Result<CardRow, Refusal> {
        Ok(CardRow {
            id: get_s(r, 0)?,
            account_id: get_s(r, 1)?,
            member_user_id: get_s(r, 2)?,
            asset_id: get_s(r, 3)?,
            per_purchase_limit: amount(&get_s(r, 4)?)?,
            pan_tail: get_s(r, 5)?,
            status: get_s(r, 6)?,
            issued_by: get_s(r, 7)?,
            created_at: get_at(r, 8)?,
        })
    }

    /// `toCard` through the router's `cardView`.
    fn json(&self, handles: &BTreeMap<String, String>) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("accountId", Json::str(self.account_id.clone())),
            ("memberUserId", Json::str(self.member_user_id.clone())),
            (
                "memberHandle",
                opt_str(handles.get(&self.member_user_id).map(String::as_str)),
            ),
            ("assetId", Json::str(self.asset_id.clone())),
            (
                "perPurchaseLimit",
                Json::str(format_amount(self.per_purchase_limit)),
            ),
            ("panTail", Json::str(self.pan_tail.clone())),
            ("status", Json::str(self.status.clone())),
            ("test", Json::Bool(true)),
            ("issuedBy", Json::str(self.issued_by.clone())),
            ("createdAt", Json::str(self.created_at.iso())),
        ])
    }
}

struct PurchaseRow {
    id: String,
    card_id: String,
    account_id: String,
    member_user_id: String,
    merchant: String,
    asset_id: String,
    amount: Amount,
    status: String,
    decline_reason: Option<String>,
    partner_key: String,
    partner_move_id: Option<String>,
    receipt_over: Option<Amount>,
    created_at: Instant,
    captured_at: Option<Instant>,
}

fn purchase_cols() -> String {
    format!(
        "id::text, card_id::text, account_id::text, member_user_id, merchant, asset_id, amount::text, status, \
         decline_reason, partner_key, partner_move_id, receipt_over::text, {}, {}",
        ms("created_at"),
        ms("captured_at")
    )
}

impl PurchaseRow {
    fn of(r: &Row) -> Result<PurchaseRow, Refusal> {
        Ok(PurchaseRow {
            id: get_s(r, 0)?,
            card_id: get_s(r, 1)?,
            account_id: get_s(r, 2)?,
            member_user_id: get_s(r, 3)?,
            merchant: get_s(r, 4)?,
            asset_id: get_s(r, 5)?,
            amount: amount(&get_s(r, 6)?)?,
            status: get_s(r, 7)?,
            decline_reason: get_o(r, 8)?,
            partner_key: get_s(r, 9)?,
            partner_move_id: get_o(r, 10)?,
            receipt_over: opt_amount(get_o(r, 11)?.as_deref())?,
            created_at: get_at(r, 12)?,
            captured_at: get_t(r, 13)?,
        })
    }
}

struct RequestRow {
    purchase_id: String,
    card_id: String,
    account_id: String,
    member_user_id: String,
    amount: Amount,
    status: String,
    decided_by: Option<String>,
    created_at: Instant,
}

fn request_cols() -> String {
    format!(
        "purchase_id::text, card_id::text, account_id::text, member_user_id, amount::text, status, decided_by, {}",
        ms("created_at")
    )
}

impl RequestRow {
    fn of(r: &Row) -> Result<RequestRow, Refusal> {
        Ok(RequestRow {
            purchase_id: get_s(r, 0)?,
            card_id: get_s(r, 1)?,
            account_id: get_s(r, 2)?,
            member_user_id: get_s(r, 3)?,
            amount: amount(&get_s(r, 4)?)?,
            status: get_s(r, 5)?,
            decided_by: get_o(r, 6)?,
            created_at: get_at(r, 7)?,
        })
    }

    /// `toRequest` through the router's `requestView`.
    fn json(&self) -> Json {
        Json::obj([
            ("purchaseId", Json::str(self.purchase_id.clone())),
            ("cardId", Json::str(self.card_id.clone())),
            ("memberUserId", Json::str(self.member_user_id.clone())),
            ("amount", Json::str(format_amount(self.amount))),
            ("status", Json::str(self.status.clone())),
            ("decidedBy", opt_str(self.decided_by.as_deref())),
            ("createdAt", Json::str(self.created_at.iso())),
        ])
    }
}

struct ClaimRow {
    id: String,
    account_id: String,
    member_user_id: String,
    asset_id: String,
    amount: Amount,
    description: String,
    receipt_id: String,
    status: String,
    approved_by: Option<String>,
    partner_key: String,
    partner_move_id: Option<String>,
    member_before: Option<Amount>,
    member_after: Option<Amount>,
    refusal_code: Option<String>,
    created_at: Instant,
    paid_at: Option<Instant>,
}

fn claim_cols() -> String {
    format!(
        "id::text, account_id::text, member_user_id, asset_id, amount::text, description, receipt_id::text, status, \
         approved_by, partner_key, partner_move_id, member_before::text, member_after::text, refusal_code, {}, {}",
        ms("created_at"),
        ms("paid_at")
    )
}

impl ClaimRow {
    fn of(r: &Row) -> Result<ClaimRow, Refusal> {
        Ok(ClaimRow {
            id: get_s(r, 0)?,
            account_id: get_s(r, 1)?,
            member_user_id: get_s(r, 2)?,
            asset_id: get_s(r, 3)?,
            amount: amount(&get_s(r, 4)?)?,
            description: get_s(r, 5)?,
            receipt_id: get_s(r, 6)?,
            status: get_s(r, 7)?,
            approved_by: get_o(r, 8)?,
            partner_key: get_s(r, 9)?,
            partner_move_id: get_o(r, 10)?,
            member_before: opt_amount(get_o(r, 11)?.as_deref())?,
            member_after: opt_amount(get_o(r, 12)?.as_deref())?,
            refusal_code: get_o(r, 13)?,
            created_at: get_at(r, 14)?,
            paid_at: get_t(r, 15)?,
        })
    }
}

fn card_row<C: GenericClient>(c: &mut C, card_id: &str) -> Result<CardRow, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.business_cards WHERE id = $1::text::uuid",
                card_cols()
            ),
            &[&card_id],
        )
        .map_err(|e| pg(&e))?;
    match rows.first() {
        Some(r) => CardRow::of(r),
        None => Err(refuse(
            "bank.business_card_not_found",
            "No business card has that id.",
        )),
    }
}

fn purchase_row_or_none<C: GenericClient>(
    c: &mut C,
    id: &str,
) -> Result<Option<PurchaseRow>, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.business_card_purchases WHERE id = $1::text::uuid",
                purchase_cols()
            ),
            &[&id],
        )
        .map_err(|e| pg(&e))?;
    rows.first().map(PurchaseRow::of).transpose()
}

fn purchase_row<C: GenericClient>(c: &mut C, id: &str) -> Result<PurchaseRow, Refusal> {
    purchase_row_or_none(c, id)?.ok_or_else(purchase_not_found)
}

fn request_row<C: GenericClient>(
    c: &mut C,
    purchase_id: &str,
    lock: bool,
) -> Result<Option<RequestRow>, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.business_card_limit_requests WHERE purchase_id = $1::text::uuid{}",
                request_cols(),
                if lock { " FOR UPDATE" } else { "" }
            ),
            &[&purchase_id],
        )
        .map_err(|e| pg(&e))?;
    rows.first().map(RequestRow::of).transpose()
}

fn claim_row<C: GenericClient>(c: &mut C, id: &str, lock: bool) -> Result<ClaimRow, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.business_reimbursements WHERE id = $1::text::uuid{}",
                claim_cols(),
                if lock { " FOR UPDATE" } else { "" }
            ),
            &[&id],
        )
        .map_err(|e| pg(&e))?;
    match rows.first() {
        Some(r) => ClaimRow::of(r),
        None => Err(refuse(
            "bank.reimbursement_not_found",
            "No reimbursement claim has that id.",
        )),
    }
}

/// `policyOf`: the business's receipt rule, or none.
fn policy_of<C: GenericClient>(c: &mut C, account_id: &str) -> Result<Option<Amount>, Refusal> {
    let rows = c
        .query(
            "SELECT receipt_over::text FROM bank.business_expense_policies WHERE account_id = $1::text::uuid",
            &[&account_id],
        )
        .map_err(|e| pg(&e))?;
    match rows.first() {
        Some(r) => Ok(Some(amount(&get_s(r, 0)?)?)),
        None => Ok(None),
    }
}

fn policy_json(over: Option<Amount>) -> Json {
    Json::obj([("receiptOver", opt_fmt(over))])
}

/// `purchaseView`, through the router's own.
fn purchase_view<C: GenericClient>(c: &mut C, row: &PurchaseRow) -> Result<Json, Refusal> {
    let receipt: Option<String> = c
        .query(
            "SELECT receipt_id::text FROM bank.business_purchase_receipts WHERE purchase_id = $1::text::uuid",
            &[&row.id],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(|r| get_s(r, 0))
        .transpose()?;
    let reminders: i64 = c
        .query_one(
            "SELECT count(*)::int8 FROM bank.business_receipt_reminders \
             WHERE purchase_id = $1::text::uuid AND status = 'queued'",
            &[&row.id],
        )
        .map_err(|e| pg(&e))?
        .try_get(0)
        .map_err(|e| pg(&e))?;
    let request = request_row(c, &row.id, false)?;
    let tail_rows = c
        .query(
            "SELECT pan_tail FROM bank.business_cards WHERE id = $1::text::uuid",
            &[&row.card_id],
        )
        .map_err(|e| pg(&e))?;
    let tail = get_s(
        tail_rows
            .first()
            .ok_or_else(|| Refusal::Other(format!("card {} vanished", row.card_id)))?,
        0,
    )?;
    let needs_receipt = row.status == "captured"
        && row.receipt_over.is_some_and(|over| row.amount > over)
        && receipt.is_none();
    Ok(Json::obj([
        ("id", Json::str(row.id.clone())),
        ("cardId", Json::str(row.card_id.clone())),
        ("panTail", Json::str(tail)),
        ("memberUserId", Json::str(row.member_user_id.clone())),
        ("merchant", Json::str(row.merchant.clone())),
        ("assetId", Json::str(row.asset_id.clone())),
        ("amount", Json::str(format_amount(row.amount))),
        ("status", Json::str(row.status.clone())),
        ("declineReason", opt_str(row.decline_reason.as_deref())),
        ("partnerKey", Json::str(row.partner_key.clone())),
        ("partnerMoveId", opt_str(row.partner_move_id.as_deref())),
        ("receiptOver", opt_fmt(row.receipt_over)),
        ("needsReceipt", Json::Bool(needs_receipt)),
        ("receiptId", opt_str(receipt.as_deref())),
        ("reminders", Json::int(reminders)),
        (
            "limitRequest",
            request.as_ref().map_or(Json::Null, RequestRow::json),
        ),
        ("createdAt", Json::str(row.created_at.iso())),
        ("capturedAt", iso(row.captured_at)),
    ]))
}

/// `claimView`, through the router's own.
fn claim_view<C: GenericClient>(c: &mut C, row: &ClaimRow) -> Result<Json, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT id::text, uploaded_by, file_name, content_type, octet_length(bytes)::int8, sha256, {} \
                 FROM bank.business_receipts WHERE id = $1::text::uuid",
                ms("created_at")
            ),
            &[&row.receipt_id],
        )
        .map_err(|e| pg(&e))?;
    let r = rows
        .first()
        .ok_or_else(|| Refusal::Other(format!("receipt {} vanished", row.receipt_id)))?;
    let size: i64 = r.try_get(4).map_err(|e| pg(&e))?;
    let receipt = Json::obj([
        ("id", Json::str(get_s(r, 0)?)),
        ("fileName", Json::str(get_s(r, 2)?)),
        ("contentType", Json::str(get_s(r, 3)?)),
        ("size", Json::int(size)),
        ("sha256", Json::str(get_s(r, 5)?)),
        ("uploadedBy", Json::str(get_s(r, 1)?)),
        ("createdAt", Json::str(get_at(r, 6)?.iso())),
    ]);
    Ok(Json::obj([
        ("id", Json::str(row.id.clone())),
        ("accountId", Json::str(row.account_id.clone())),
        ("memberUserId", Json::str(row.member_user_id.clone())),
        ("assetId", Json::str(row.asset_id.clone())),
        ("amount", Json::str(format_amount(row.amount))),
        ("description", Json::str(row.description.clone())),
        ("receipt", receipt),
        ("status", Json::str(row.status.clone())),
        ("approvedBy", opt_str(row.approved_by.as_deref())),
        ("partnerKey", Json::str(row.partner_key.clone())),
        ("partnerMoveId", opt_str(row.partner_move_id.as_deref())),
        ("memberBefore", opt_fmt(row.member_before)),
        ("memberAfter", opt_fmt(row.member_after)),
        ("refusalCode", opt_str(row.refusal_code.as_deref())),
        ("createdAt", Json::str(row.created_at.iso())),
        ("paidAt", iso(row.paid_at)),
    ]))
}

/// Handles for a card view: a directory that cannot answer leaves every handle unknown (`.catch(() => new Map())`).
fn handles_or_none(d: &Deps<'_>, ids: &[String]) -> BTreeMap<String, String> {
    let mut unique: Vec<String> = Vec::new();
    for id in ids {
        if !unique.contains(id) {
            unique.push(id.clone());
        }
    }
    handles_of(d, &unique).unwrap_or_default()
}

// ---------------------------------------------------------------------------------------------------------------
// Reads

/// `overview`: an admin (`manage_team`) or an approver sees the whole business; any other member their own cards,
/// purchases and claims. Limit requests are the whole business's only for `manage_team`.
pub fn overview(d: &Deps<'_>, account_id: &str, user_id: &str) -> Result<Json, Refusal> {
    let seat = seat(d, account_id, user_id)?;
    let all = seat.holds("manage_team") || seat.holds("approve");
    let admin = seat.holds("manage_team");
    let (policy, cards, purchases, claims, requests) = with(d.store, |c| {
        let policy = policy_of(c, account_id)?;
        let mine = |all: bool| {
            if all { "" } else { " AND member_user_id = $2" }
        };
        let q = |c: &mut postgres::Client, sql: String, all: bool| {
            if all {
                c.query(&sql, &[&account_id])
            } else {
                c.query(&sql, &[&account_id, &user_id])
            }
            .map_err(|e| pg(&e))
        };
        let cards = q(
            c,
            format!(
                "SELECT {} FROM bank.business_cards WHERE account_id = $1::text::uuid{} ORDER BY created_at DESC",
                card_cols(),
                mine(all)
            ),
            all,
        )?
        .iter()
        .map(CardRow::of)
        .collect::<Result<Vec<_>, _>>()?;
        let purchases = q(
            c,
            format!(
                "SELECT {} FROM bank.business_card_purchases WHERE account_id = $1::text::uuid{} \
                 ORDER BY created_at DESC LIMIT 200",
                purchase_cols(),
                mine(all)
            ),
            all,
        )?
        .iter()
        .map(PurchaseRow::of)
        .collect::<Result<Vec<_>, _>>()?;
        let claims = q(
            c,
            format!(
                "SELECT {} FROM bank.business_reimbursements WHERE account_id = $1::text::uuid{} \
                 ORDER BY created_at DESC LIMIT 200",
                claim_cols(),
                mine(all)
            ),
            all,
        )?
        .iter()
        .map(ClaimRow::of)
        .collect::<Result<Vec<_>, _>>()?;
        let requests = q(
            c,
            format!(
                "SELECT {} FROM bank.business_card_limit_requests WHERE account_id = $1::text::uuid{} \
                 ORDER BY created_at DESC LIMIT 200",
                request_cols(),
                mine(admin)
            ),
            admin,
        )?
        .iter()
        .map(RequestRow::of)
        .collect::<Result<Vec<_>, _>>()?;
        Ok((policy, cards, purchases, claims, requests))
    })?;
    let handles = handles_or_none(
        d,
        &cards
            .iter()
            .map(|c| c.member_user_id.clone())
            .collect::<Vec<_>>(),
    );
    let my_balance = match d.custody.bank_for(user_id) {
        Some(mine) => {
            let b = mine.balance(&AccountRef::main(user_id, &seat.account.asset_id), d.now);
            Json::obj([
                ("label", Json::str(mine.label())),
                (
                    "amount",
                    opt_fmt(if b.unavailable { None } else { b.amount }),
                ),
            ])
        }
        None => Json::Null,
    };
    let (purchase_views, claim_views) = with(d.store, |c| {
        let p = purchases
            .iter()
            .map(|p| purchase_view(c, p))
            .collect::<Result<Vec<_>, _>>()?;
        let k = claims
            .iter()
            .map(|k| claim_view(c, k))
            .collect::<Result<Vec<_>, _>>()?;
        Ok((p, k))
    })?;
    Ok(Json::obj([
        ("policy", policy_json(policy)),
        (
            "permissions",
            Json::Array(seat.permissions.iter().map(|p| Json::str(*p)).collect()),
        ),
        (
            "cards",
            Json::Array(cards.iter().map(|c| c.json(&handles)).collect()),
        ),
        ("purchases", Json::Array(purchase_views)),
        (
            "limitRequests",
            Json::Array(requests.iter().map(RequestRow::json).collect()),
        ),
        ("claims", Json::Array(claim_views)),
        ("myBalance", my_balance),
    ]))
}

// ---------------------------------------------------------------------------------------------------------------
// Cards (BK-bcard-01)

/// What `issueCard` is asked.
pub struct IssueAsk<'a> {
    pub account_id: &'a str,
    pub actor: &'a str,
    pub card_id: &'a str,
    pub member_user_id: &'a str,
    pub per_purchase_limit: &'a str,
}

/// `issueCard`: a TEST card for a member of the business with a per-purchase limit. The same id on the same terms is
/// the same card.
pub fn issue_card(d: &Deps<'_>, ask: &IssueAsk<'_>) -> Result<Json, Refusal> {
    let seat = seat(d, ask.account_id, ask.actor)?;
    need(&seat.permissions, "manage_team")?;
    if seat.account.status != "active" {
        return Err(closed());
    }
    let limit = positive(ask.per_purchase_limit, "per-purchase limit")?;
    let row = with(d.store, |c| {
        let member = c
            .query(
                "SELECT 1 FROM bank.business_members WHERE account_id = $1::text::uuid AND user_id = $2",
                &[&ask.account_id, &ask.member_user_id],
            )
            .map_err(|e| pg(&e))?;
        if member.is_empty() {
            return Err(refuse(
                "bank.business_not_member",
                "That person is not a member of this business, so no card was issued.",
            ));
        }
        let rows = c
            .query(
                &format!(
                    "INSERT INTO bank.business_cards \
                       (id, account_id, member_user_id, asset_id, per_purchase_limit, pan_tail, issued_by) \
                     VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5::text::numeric, $6, $7) \
                     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id RETURNING {}",
                    card_cols()
                ),
                &[
                    &ask.card_id,
                    &ask.account_id,
                    &ask.member_user_id,
                    &seat.account.asset_id,
                    &format_amount(limit),
                    &test_card_tail(ask.card_id),
                    &ask.actor,
                ],
            )
            .map_err(|e| pg(&e))?;
        CardRow::of(
            rows.first()
                .ok_or_else(|| Refusal::Other("the card insert returned nothing".to_owned()))?,
        )
    })?;
    if row.account_id != ask.account_id
        || row.member_user_id != ask.member_user_id
        || row.per_purchase_limit != limit
    {
        return Err(conflict("card"));
    }
    let handles = handles_or_none(d, std::slice::from_ref(&row.member_user_id));
    Ok(row.json(&handles))
}

/// What `testPurchase` is asked.
pub struct PurchaseAsk<'a> {
    pub card_id: &'a str,
    pub actor: &'a str,
    pub purchase_id: &'a str,
    pub merchant: &'a str,
    pub amount: &'a str,
}

/// `insertPurchase`: the purchase recorded once; a copy racing this one that recorded it first on the same terms is
/// that purchase.
#[allow(clippy::too_many_arguments, reason = "the TypeScript's own signature")]
fn insert_purchase<C: GenericClient>(
    c: &mut C,
    card: &CardRow,
    purchase_id: &str,
    merchant: &str,
    amount: Amount,
    status: &str,
    decline_reason: Option<&str>,
    receipt_over: Option<Amount>,
) -> Result<(), Refusal> {
    let made = c
        .query(
            "INSERT INTO bank.business_card_purchases \
               (id, card_id, account_id, member_user_id, merchant, asset_id, amount, status, decline_reason, \
                partner_key, receipt_over) \
             VALUES ($1::text::uuid, $2::text::uuid, $3::text::uuid, $4, $5, $6, $7::text::numeric, $8, $9, $10, \
                     $11::text::numeric) \
             ON CONFLICT DO NOTHING RETURNING id",
            &[
                &purchase_id,
                &card.id,
                &card.account_id,
                &card.member_user_id,
                &merchant,
                &card.asset_id,
                &format_amount(amount),
                &status,
                &decline_reason,
                &card_capture_key(purchase_id),
                &receipt_over.map(format_amount),
            ],
        )
        .map_err(|e| pg(&e))?;
    if !made.is_empty() {
        return Ok(());
    }
    let won = purchase_row(c, purchase_id)?;
    if won.card_id != card.id || won.merchant != merchant || won.amount != amount {
        return Err(conflict("purchase"));
    }
    Ok(())
}

/// `testPurchase`: one purchase on the TEST card network (the `rail.card` stand-in) by the card's holder. Over the
/// card's limit it is declined `over_limit` with one request to the admins; within it, one partner move captures it.
/// The same purchase id is the same purchase: a retry reads back what was decided.
pub fn test_purchase(d: &Deps<'_>, ask: &PurchaseAsk<'_>) -> Result<Json, Refusal> {
    if d.partner.partner.is_none() {
        return Err(refuse(
            "bank.test_partner_off",
            "The TEST card network exists only on a stack that runs the TEST partner bank.",
        ));
    }
    let card = with(d.store, |c| card_row(c, ask.card_id))?;
    if card.member_user_id != ask.actor {
        return Err(refuse(
            "bank.business_card_not_found",
            "This card is not yours, so nothing was spent on it.",
        ));
    }
    let merchant = js_trim(ask.merchant);
    if !plain(merchant, 80, false) {
        return Err(field_invalid("A merchant name is 1 to 80 characters."));
    }
    let amount = positive(ask.amount, "amount")?;
    if let Some(prior) = with(d.store, |c| purchase_row_or_none(c, ask.purchase_id))? {
        if prior.card_id != card.id || prior.merchant != merchant || prior.amount != amount {
            return Err(conflict("purchase"));
        }
        if prior.status == "capturing" {
            capture(d, &prior)?;
        }
        return view_of(d, &prior.id);
    }
    let seat = seat(d, &card.account_id, ask.actor)?;
    if seat.account.status != "active" {
        return Err(closed());
    }
    if card.status != "active" {
        return Err(refuse(
            "bank.business_card_frozen",
            "This card is frozen, so nothing was spent on it.",
        ));
    }
    if amount > card.per_purchase_limit {
        in_tx(d.store, |tx| {
            insert_purchase(
                tx,
                &card,
                ask.purchase_id,
                merchant,
                amount,
                "declined",
                Some("over_limit"),
                None,
            )?;
            tx.execute(
                "INSERT INTO bank.business_card_limit_requests (purchase_id, card_id, account_id, member_user_id, amount) \
                 VALUES ($1::text::uuid, $2::text::uuid, $3::text::uuid, $4, $5::text::numeric) \
                 ON CONFLICT (purchase_id) DO NOTHING",
                &[
                    &ask.purchase_id,
                    &card.id,
                    &card.account_id,
                    &card.member_user_id,
                    &format_amount(amount),
                ],
            )
            .map_err(|e| pg(&e))?;
            Ok(())
        })?;
        return view_of(d, ask.purchase_id);
    }
    if seat.partner.is_none() {
        return Err(no_partner());
    }
    money_may_move(d)?;
    let row = with(d.store, |c| {
        let policy = policy_of(c, &card.account_id)?;
        insert_purchase(
            c,
            &card,
            ask.purchase_id,
            merchant,
            amount,
            "capturing",
            None,
            policy,
        )?;
        purchase_row(c, ask.purchase_id)
    })?;
    capture(d, &row)?;
    view_of(d, ask.purchase_id)
}

fn view_of(d: &Deps<'_>, purchase_id: &str) -> Result<Json, Refusal> {
    with(d.store, |c| {
        let row = purchase_row(c, purchase_id)?;
        purchase_view(c, &row)
    })
}

/// `capture`: the one partner move from the business's account to the TEST merchant, asked first by its key so a lost
/// answer is never sent again blind. The partner's definite no declines the purchase.
fn capture(d: &Deps<'_>, row: &PurchaseRow) -> Result<(), Refusal> {
    let seat = seat(d, &row.account_id, &row.member_user_id)?;
    let partner = seat.partner.ok_or_else(no_partner)?;
    let moved = match partner.move_by_key(&row.partner_key) {
        Some(m) => Ok(m),
        None => partner.move_(
            &MoveRequest {
                key: row.partner_key.clone(),
                from: partner_account(&row.account_id, &row.asset_id),
                to: AccountRef::main(MERCHANT, &row.asset_id),
                amount: row.amount,
                payees: None,
            },
            d.now,
        ),
    };
    let decline = |err: Refusal| -> Result<(), Refusal> {
        let reason = match &err {
            Refusal::Bank(e) => definite_decline(e.row.code),
            _ => None,
        };
        let Some(reason) = reason else {
            return Err(err);
        };
        with(d.store, |c| {
            c.execute(
                "UPDATE bank.business_card_purchases SET status = 'declined', decline_reason = $1 \
                 WHERE id = $2::text::uuid AND status = 'capturing'",
                &[&reason, &row.id],
            )
            .map_err(|e| pg(&e))
        })?;
        Ok(())
    };
    let m = match moved {
        Ok(m) => m,
        Err(err) => return decline(err),
    };
    let written = in_tx(d.store, |tx| {
        let done = tx
            .query(
                &format!(
                    "UPDATE bank.business_card_purchases SET status = 'captured', partner_move_id = $1, captured_at = {} \
                     WHERE id = $3::text::uuid AND status = 'capturing' RETURNING receipt_over::text",
                    at("$2")
                ),
                &[&m.id, &m.moved_at.0, &row.id],
            )
            .map_err(|e| pg(&e))?;
        if let Some(r) = done.first() {
            let over = opt_amount(get_o(r, 0)?.as_deref())?;
            if over.is_some_and(|over| row.amount > over) {
                // One reminder for the purchase, never a second: the purchase id is the reminder's key.
                tx.execute(
                    "INSERT INTO bank.business_receipt_reminders (purchase_id, account_id, member_user_id) \
                     VALUES ($1::text::uuid, $2::text::uuid, $3) ON CONFLICT (purchase_id) DO NOTHING",
                    &[&row.id, &row.account_id, &row.member_user_id],
                )
                .map_err(|e| pg(&e))?;
            }
        }
        Ok(())
    });
    // The TypeScript's catch spans the write too; no database error carries a decline's code, so it is passed on.
    written.or_else(decline)
}

/// `decideLimitRequest`: an admin's answer to an over-limit request; approved, the card's limit becomes the requested
/// amount (never lower than it is).
pub fn decide_limit_request(
    d: &Deps<'_>,
    purchase_id: &str,
    actor: &str,
    approve: bool,
) -> Result<Json, Refusal> {
    let req = with(d.store, |c| request_row(c, purchase_id, false))?.ok_or_else(|| {
        refuse(
            "bank.limit_request_not_found",
            "No over-limit request has that id.",
        )
    })?;
    let seat = seat(d, &req.account_id, actor)?;
    need(&seat.permissions, "manage_team")?;
    in_tx(d.store, |tx| {
        let locked = request_row(tx, &req.purchase_id, true)?
            .ok_or_else(|| Refusal::Other("the limit request vanished".to_owned()))?;
        if locked.status != "open" {
            return Ok(locked.json());
        }
        let status = if approve { "approved" } else { "declined" };
        if approve {
            tx.execute(
                "UPDATE bank.business_cards SET per_purchase_limit = GREATEST(per_purchase_limit, $1::text::numeric) \
                 WHERE id = $2::text::uuid",
                &[&format_amount(locked.amount), &locked.card_id],
            )
            .map_err(|e| pg(&e))?;
        }
        let rows = tx
            .query(
                &format!(
                    "UPDATE bank.business_card_limit_requests SET status = $1, decided_by = $2, decided_at = now() \
                     WHERE purchase_id = $3::text::uuid RETURNING {}",
                    request_cols()
                ),
                &[&status, &actor, &locked.purchase_id],
            )
            .map_err(|e| pg(&e))?;
        Ok(RequestRow::of(
            rows.first()
                .ok_or_else(|| Refusal::Other("the limit request vanished".to_owned()))?,
        )?
        .json())
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Receipts (BK-bexp-01)

/// `setPolicy`: the business's own receipt rule; a captured purchase over this amount needs a receipt.
pub fn set_policy(
    d: &Deps<'_>,
    account_id: &str,
    actor: &str,
    receipt_over: &str,
) -> Result<Json, Refusal> {
    let seat = seat(d, account_id, actor)?;
    need(&seat.permissions, "manage_team")?;
    let over = parse_amount(receipt_over)
        .map_err(|_| field_invalid("The receipt rule is not an amount."))?;
    if over < Amount::ZERO {
        return Err(field_invalid("The receipt rule cannot be below zero."));
    }
    with(d.store, |c| {
        c.execute(
            "INSERT INTO bank.business_expense_policies (account_id, receipt_over, set_by) \
             VALUES ($1::text::uuid, $2::text::numeric, $3) \
             ON CONFLICT (account_id) DO UPDATE SET receipt_over = EXCLUDED.receipt_over, set_by = EXCLUDED.set_by, \
             set_at = now()",
            &[&account_id, &format_amount(over), &actor],
        )
        .map_err(|e| pg(&e))?;
        Ok(policy_json(policy_of(c, account_id)?))
    })
}

/// A receipt as a call gives it.
pub struct ReceiptAsk<'a> {
    pub actor: &'a str,
    pub receipt_id: &'a str,
    pub file_name: &'a str,
    pub content_type: &'a str,
    pub content_base64: &'a str,
}

/// `insertReceipt`: the file kept once; the same id on other terms is a conflict.
fn insert_receipt<C: GenericClient>(
    c: &mut C,
    account_id: &str,
    r: &ReceiptAsk<'_>,
) -> Result<(), Refusal> {
    let file_name = js_trim(r.file_name);
    if !plain(file_name, 120, true) {
        return Err(receipt_invalid(
            "A receipt\u{2019}s file name is 1 to 120 characters.",
        ));
    }
    if !RECEIPT_TYPES.contains(&r.content_type) {
        return Err(receipt_invalid(
            "A receipt is a PDF, PNG, JPEG or text file.",
        ));
    }
    let bytes = node_base64(r.content_base64);
    if bytes.is_empty() || bytes.len() > MAX_RECEIPT_BYTES {
        return Err(receipt_invalid("A receipt is between 1 byte and 512 KiB."));
    }
    let digest = sha256_hex(&bytes);
    let rows = c
        .query(
            "INSERT INTO bank.business_receipts (id, account_id, uploaded_by, file_name, content_type, bytes, sha256) \
             VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5, $6, $7) \
             ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id \
             RETURNING account_id::text, sha256, uploaded_by",
            &[
                &r.receipt_id,
                &account_id,
                &r.actor,
                &file_name,
                &r.content_type,
                &bytes,
                &digest,
            ],
        )
        .map_err(|e| pg(&e))?;
    let row = rows
        .first()
        .ok_or_else(|| Refusal::Other("the receipt insert returned nothing".to_owned()))?;
    if get_s(row, 0)? != account_id || get_s(row, 1)? != digest || get_s(row, 2)? != r.actor {
        return Err(conflict("receipt"));
    }
    Ok(())
}

/// `attachReceipt`: the card's holder gives the receipt for one of their captured purchases; its reminder is cleared.
pub fn attach_receipt(
    d: &Deps<'_>,
    purchase_id: &str,
    receipt: &ReceiptAsk<'_>,
) -> Result<Json, Refusal> {
    let purchase = with(d.store, |c| purchase_row(c, purchase_id))?;
    if purchase.member_user_id != receipt.actor {
        return Err(refuse(
            "bank.business_card_not_found",
            "Only the cardholder gives the receipt for their purchase.",
        ));
    }
    if purchase.status != "captured" {
        return Err(field_invalid("Only a captured purchase takes a receipt."));
    }
    in_tx(d.store, |tx| {
        insert_receipt(tx, &purchase.account_id, receipt)?;
        let attached = tx
            .query(
                "INSERT INTO bank.business_purchase_receipts (purchase_id, receipt_id) \
                 VALUES ($1::text::uuid, $2::text::uuid) \
                 ON CONFLICT (purchase_id) DO UPDATE SET purchase_id = EXCLUDED.purchase_id \
                 RETURNING receipt_id::text",
                &[&purchase.id, &receipt.receipt_id],
            )
            .map_err(|e| pg(&e))?;
        let got = get_s(
            attached
                .first()
                .ok_or_else(|| Refusal::Other("the attach returned nothing".to_owned()))?,
            0,
        )?;
        if got != receipt.receipt_id {
            return Err(conflict("receipt"));
        }
        tx.execute(
            "UPDATE bank.business_receipt_reminders SET status = 'cleared' WHERE purchase_id = $1::text::uuid",
            &[&purchase.id],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })?;
    view_of(d, &purchase.id)
}

/// The first `n` UTF-16 units of an id (`slice(0, n)`); every id here is ASCII.
fn head(s: &str, n: usize) -> String {
    s.encode_utf16()
        .take(n)
        .collect::<Vec<u16>>()
        .iter()
        .map(|u| char::from_u32(u32::from(*u)).unwrap_or('\u{fffd}'))
        .collect()
}

/// `receiptsZip`: every receipt of the business, purchases' and claims', in one ZIP file, base64 on the wire.
pub fn receipts_zip(d: &Deps<'_>, account_id: &str, user_id: &str) -> Result<Json, Refusal> {
    let seat = seat(d, account_id, user_id)?;
    need(&seat.permissions, "export")?;
    let files = with(d.store, |c| {
        c.query(
            &format!(
                "SELECT id::text, file_name, bytes, {} FROM bank.business_receipts \
                 WHERE account_id = $1::text::uuid ORDER BY created_at, id LIMIT 500",
                ms("created_at")
            ),
            &[&account_id],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(|r| {
            Ok(ZipFile {
                name: format!("{}-{}", head(&get_s(r, 0)?, 8), get_s(r, 1)?),
                data: r.try_get::<_, Vec<u8>>(2).map_err(|e| pg(&e))?,
                at: get_at(r, 3)?,
            })
        })
        .collect::<Result<Vec<_>, Refusal>>()
    })?;
    let zip = zip_store(&files)?;
    Ok(Json::obj([
        (
            "fileName",
            Json::str(format!("receipts-{}.zip", head(account_id, 8))),
        ),
        (
            "count",
            Json::int(i64::try_from(files.len()).unwrap_or(i64::MAX)),
        ),
        ("zipBase64", Json::str(STANDARD.encode(zip))),
    ]))
}

// ---------------------------------------------------------------------------------------------------------------
// Reimbursements (BK-bexp-02)

/// What `submitClaim` is asked.
pub struct ClaimAsk<'a> {
    pub account_id: &'a str,
    pub claim_id: &'a str,
    pub amount: &'a str,
    pub description: &'a str,
    pub receipt: ReceiptAsk<'a>,
}

/// `submitClaim`: a member's claim for what they paid themselves, with its receipt. The same id on the same terms is
/// the same claim.
pub fn submit_claim(d: &Deps<'_>, ask: &ClaimAsk<'_>) -> Result<Json, Refusal> {
    let actor = ask.receipt.actor;
    let seat = seat(d, ask.account_id, actor)?;
    if seat.account.status != "active" {
        return Err(closed());
    }
    let amount = positive(ask.amount, "amount")?;
    let description = js_trim(ask.description);
    if !plain(description, 200, false) {
        return Err(field_invalid("A description is 1 to 200 characters."));
    }
    let row = in_tx(d.store, |tx| {
        insert_receipt(tx, ask.account_id, &ask.receipt)?;
        let rows = tx
            .query(
                &format!(
                    "INSERT INTO bank.business_reimbursements \
                       (id, account_id, member_user_id, asset_id, amount, description, receipt_id, partner_key) \
                     VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5::text::numeric, $6, $7::text::uuid, $8) \
                     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id RETURNING {}",
                    claim_cols()
                ),
                &[
                    &ask.claim_id,
                    &ask.account_id,
                    &actor,
                    &seat.account.asset_id,
                    &format_amount(amount),
                    &description,
                    &ask.receipt.receipt_id,
                    &reimbursement_key(ask.claim_id),
                ],
            )
            .map_err(|e| pg(&e))?;
        ClaimRow::of(
            rows.first()
                .ok_or_else(|| Refusal::Other("the claim insert returned nothing".to_owned()))?,
        )
    })?;
    if row.account_id != ask.account_id
        || row.member_user_id != actor
        || row.amount != amount
        || row.description != description
        || row.receipt_id != ask.receipt.receipt_id
    {
        return Err(conflict("claim"));
    }
    with(d.store, |c| claim_view(c, &row))
}

/// `approveAndPay`: someone holding `approve` other than the claimant approves and pays: one partner move from the
/// business's account to the member's own, under the claim's key, sent once. A retry of a claim whose answer was lost
/// reads it back by its key.
pub fn approve_and_pay(d: &Deps<'_>, claim_id: &str, actor: &str) -> Result<Json, Refusal> {
    let prior = with(d.store, |c| claim_row(c, claim_id, false))?;
    let seat = seat(d, &prior.account_id, actor)?;
    if prior.member_user_id == actor {
        return Err(refuse(
            "bank.business_self_approve",
            "This is your own claim, so you cannot approve it. Another approver must.",
        ));
    }
    need(&seat.permissions, "approve")?;
    if prior.status == "paid" || prior.status == "declined" {
        return with(d.store, |c| claim_view(c, &prior));
    }
    let partner = seat.partner.ok_or_else(no_partner)?;
    if d.custody.bank_for(&prior.member_user_id).is_none() {
        return Err(refuse(
            "bank.no_partner_bank",
            "The member\u{2019}s own bank money is not held at the partner bank, so it cannot pay them there. Nothing was sent.",
        ));
    }
    money_may_move(d)?;
    let row = in_tx(d.store, |tx| {
        let locked = claim_row(tx, &prior.id, true)?;
        if locked.status != "submitted" {
            return Ok(locked);
        }
        let rows = tx
            .query(
                &format!(
                    "UPDATE bank.business_reimbursements SET status = 'paying', approved_by = $1 \
                     WHERE id = $2::text::uuid RETURNING {}",
                    claim_cols()
                ),
                &[&actor, &locked.id],
            )
            .map_err(|e| pg(&e))?;
        ClaimRow::of(
            rows.first()
                .ok_or_else(|| Refusal::Other("the claim vanished".to_owned()))?,
        )
    })?;
    if row.status == "paying" {
        pay(d, &row, &partner)?;
    }
    with(d.store, |c| {
        let now = claim_row(c, &row.id, false)?;
        claim_view(c, &now)
    })
}

/// A figure the partner gave, or none when it gave none or was unavailable.
fn reported(b: &crate::partner::Balance) -> Option<String> {
    if b.unavailable {
        return None;
    }
    b.amount.map(format_amount)
}

/// `pay`: the claim's one partner move. A definite refusal puts the claim back to `submitted` with its code.
fn pay(d: &Deps<'_>, row: &ClaimRow, partner: &Held<'_>) -> Result<(), Refusal> {
    let to = AccountRef::main(&row.member_user_id, &row.asset_id);
    let already = partner.move_by_key(&row.partner_key);
    let before = if already.is_some() {
        None
    } else {
        reported(&partner.balance(&to, d.now))
    };
    let moved = match already {
        Some(m) => Ok(m),
        None => partner.move_(
            &MoveRequest {
                key: row.partner_key.clone(),
                from: partner_account(&row.account_id, &row.asset_id),
                to: to.clone(),
                amount: row.amount,
                payees: None,
            },
            d.now,
        ),
    };
    let result = moved.and_then(|m| {
        let after = reported(&partner.balance(&to, d.now));
        with(d.store, |c| {
            c.execute(
                &format!(
                    "UPDATE bank.business_reimbursements \
                       SET status = 'paid', partner_move_id = $1, paid_at = {}, \
                           member_before = COALESCE(member_before, $3::text::numeric), \
                           member_after = $4::text::numeric \
                     WHERE id = $5::text::uuid AND status = 'paying'",
                    at("$2")
                ),
                &[&m.id, &m.moved_at.0, &before, &after, &row.id],
            )
            .map_err(|e| pg(&e))
        })?;
        Ok(())
    });
    if let Err(Refusal::Bank(e)) = &result
        && DEFINITE_REFUSALS.contains(&e.row.code)
    {
        let code = e.row.code;
        with(d.store, |c| {
            c.execute(
                "UPDATE bank.business_reimbursements SET status = 'submitted', approved_by = NULL, refusal_code = $1 \
                 WHERE id = $2::text::uuid AND status = 'paying'",
                &[&code, &row.id],
            )
            .map_err(|e| pg(&e))
        })?;
    }
    result
}

// ---------------------------------------------------------------------------------------------------------------
// A ZIP file with stored (uncompressed) entries

/// One file of a ZIP.
pub struct ZipFile {
    pub name: String,
    pub data: Vec<u8>,
    pub at: Instant,
}

const fn crc_table() -> [u32; 256] {
    let mut t = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        #[allow(clippy::cast_possible_truncation, reason = "n < 256")]
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 == 1 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        #[allow(clippy::indexing_slicing, reason = "n < 256, in a const fn")]
        {
            t[n] = c;
        }
        n += 1;
    }
    t
}

const CRC_TABLE: [u32; 256] = crc_table();

/// `crc32`: the ZIP's CRC-32 (IEEE, reflected, `0xedb88320`).
pub fn crc32(data: &[u8]) -> u32 {
    let mut c: u32 = 0xffff_ffff;
    for b in data {
        let i = usize::try_from((c ^ u32::from(*b)) & 0xff).unwrap_or(0);
        c = CRC_TABLE.get(i).copied().unwrap_or(0) ^ (c >> 8);
    }
    c ^ 0xffff_ffff
}

/// `dosTime`: the UTC time and date in MS-DOS form; a year before 1980 is 1980.
fn dos_time(at: Instant) -> (i64, i64) {
    let days = at.0.div_euclid(86_400_000);
    let secs = at.0.rem_euclid(86_400_000) / 1000;
    let (year, month, day) = civil_from_days(days);
    let year = year.max(1980);
    let (h, m, s) = (secs / 3600, secs / 60 % 60, secs % 60);
    (
        (h << 11) | (m << 5) | (s >> 1),
        ((year - 1980) << 9) | (month << 5) | day,
    )
}

/// `writeUInt16LE`: a value outside 0 to 65535 is Node's `RangeError`, the opaque 500.
fn u16le(out: &mut Vec<u8>, v: i64) -> Result<(), Refusal> {
    let v = u16::try_from(v).map_err(|_| {
        Refusal::Other(format!(
            "The value of \"value\" is out of range. It must be >= 0 and <= 65535. Received {v}"
        ))
    })?;
    out.extend_from_slice(&v.to_le_bytes());
    Ok(())
}

fn u32le(out: &mut Vec<u8>, v: usize) -> Result<(), Refusal> {
    let v = u32::try_from(v).map_err(|_| {
        Refusal::Other(format!(
            "The value of \"value\" is out of range. It must be >= 0 and <= 4294967295. Received {v}"
        ))
    })?;
    out.extend_from_slice(&v.to_le_bytes());
    Ok(())
}

/// `zipStore`: a ZIP of the files as they are (method 0, stored), with UTF-8 names, byte for byte the TypeScript's.
pub fn zip_store(files: &[ZipFile]) -> Result<Vec<u8>, Refusal> {
    let mut locals: Vec<u8> = Vec::new();
    let mut dir: Vec<u8> = Vec::new();
    let mut offset: usize = 0;
    for f in files {
        let name = f.name.as_bytes();
        let crc = crc32(&f.data);
        let (time, date) = dos_time(f.at);
        let start = locals.len();
        locals.extend_from_slice(&0x0403_4b50_u32.to_le_bytes());
        u16le(&mut locals, 20)?;
        u16le(&mut locals, 0x0800)?;
        u16le(&mut locals, 0)?;
        u16le(&mut locals, time)?;
        u16le(&mut locals, date)?;
        locals.extend_from_slice(&crc.to_le_bytes());
        u32le(&mut locals, f.data.len())?;
        u32le(&mut locals, f.data.len())?;
        u16le(&mut locals, i64::try_from(name.len()).unwrap_or(i64::MAX))?;
        u16le(&mut locals, 0)?;
        debug_assert_eq!(locals.len() - start, 30);
        dir.extend_from_slice(&0x0201_4b50_u32.to_le_bytes());
        u16le(&mut dir, 20)?;
        u16le(&mut dir, 20)?;
        u16le(&mut dir, 0x0800)?;
        u16le(&mut dir, 0)?;
        u16le(&mut dir, time)?;
        u16le(&mut dir, date)?;
        dir.extend_from_slice(&crc.to_le_bytes());
        u32le(&mut dir, f.data.len())?;
        u32le(&mut dir, f.data.len())?;
        u16le(&mut dir, i64::try_from(name.len()).unwrap_or(i64::MAX))?;
        // Extra and comment lengths, disk number, internal and external attributes: zero.
        dir.extend_from_slice(&[0u8; 12]);
        u32le(&mut dir, offset)?;
        dir.extend_from_slice(name);
        locals.extend_from_slice(name);
        locals.extend_from_slice(&f.data);
        offset += 30 + name.len() + f.data.len();
    }
    let mut out = locals;
    let dir_len = dir.len();
    out.extend_from_slice(&dir);
    out.extend_from_slice(&0x0605_4b50_u32.to_le_bytes());
    out.extend_from_slice(&[0u8; 4]);
    u16le(&mut out, i64::try_from(files.len()).unwrap_or(i64::MAX))?;
    u16le(&mut out, i64::try_from(files.len()).unwrap_or(i64::MAX))?;
    u32le(&mut out, dir_len)?;
    u32le(&mut out, offset)?;
    out.extend_from_slice(&[0u8; 2]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn crc32_is_the_zip_crc() {
        assert_eq!(crc32(b""), 0);
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(crc32(b"TEST receipt 80.00"), crc32(b"TEST receipt 80.00"));
    }

    #[test]
    fn a_test_card_tail_is_four_digits_from_the_id() {
        // The TypeScript's `testCardTail` of the same id.
        assert_eq!(
            test_card_tail("00000000-0000-4000-8000-000000000001"),
            "5496"
        );
    }

    #[test]
    fn node_base64_drops_what_makes_no_whole_byte() {
        assert_eq!(node_base64("QUJD"), b"ABC");
        assert_eq!(node_base64("QUI="), b"AB");
        assert_eq!(node_base64("QUI"), b"AB");
        assert_eq!(node_base64("QUJDR"), b"ABC");
        assert_eq!(node_base64("QQ=="), b"A");
        assert_eq!(node_base64("QUJDRA"), b"ABCD");
        assert_eq!(node_base64("A-_B"), [0x03, 0xef, 0xc1]);
    }

    /// The TypeScript's `zipStore` on the same two files, its bytes in hex (run under Node 22).
    const TS_ZIP: &str = "504b03041400000800008f52775dac2a93d802000000020000000e00000061626364656667682d722e7478746869504b0304140000080000a32043002438b23f04000000040000000f00000031323334353637382dc3bc2e706466000102ff504b010214001400000800008f52775dac2a93d802000000020000000e000000000000000000000000000000000061626364656667682d722e747874504b01021400140000080000a32043002438b23f04000000040000000f000000000000000000000000002e00000031323334353637382dc3bc2e706466504b05060000000002000200790000005f0000000000";

    #[test]
    fn a_stored_zip_is_byte_for_byte_the_typescripts() {
        let files = [
            ZipFile {
                name: "abcdefgh-r.txt".to_owned(),
                data: b"hi".to_vec(),
                // 2026-11-23T10:20:31.250Z
                at: Instant(1_795_429_231_250),
            },
            ZipFile {
                name: "12345678-\u{fc}.pdf".to_owned(),
                data: vec![0, 1, 2, 255],
                // 1975-02-03T04:05:06Z: the year is 1980's
                at: Instant(160_632_306_000),
            },
        ];
        let hex: String = zip_store(&files)
            .unwrap()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(hex, TS_ZIP);
        assert_eq!(
            zip_store(&[]).unwrap(),
            [
                0x50, 0x4b, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
            ]
        );
    }

    #[test]
    fn plain_text_counts_code_points_and_refuses_control_characters() {
        assert!(plain("TEST Shop", 80, false));
        assert!(!plain("", 80, false));
        assert!(!plain("a\u{7f}", 80, false));
        assert!(!plain("a/b", 120, true));
        assert!(plain(&"\u{1f600}".repeat(80), 80, false));
    }
}
