//! `BusinessBillsService` (`business/business-bills.ts`): a business pays its suppliers' bills (J-bank-20; BK-bill-01
//! to BK-bill-03).
//!
//! The business's money is the partner bank's, in its own account at the partner, `business:<account id>`.
//! INTAFACED's ledger posts nothing for any of this.
//!
//! - inbox: a bill is uploaded under its own id, the intake's business key: the same upload sent again is the same
//!   bill. The bill reader (`BANK_BILL_READER`, handed only with the TEST partner on) fills what it read, labelled;
//!   with no reader every field is typed by hand. A person reviews it before it goes anywhere.
//! - duplicates: the same file, the same vendor and reference, or the same amount and due date as an earlier bill is
//!   flagged; it goes nowhere until someone who manages the team clears it (`bank.bill_duplicate_uncleared`).
//! - approval: a pre-approved vendor's bill at or under its cap is approved at once; any other goes to approvers, as
//!   the team's rules say, never fewer than one; the sender never approves it, and approvers are distinct.
//! - limits: per payment, per day and per month; a blank limit refuses every payment (`bank.bill_limit_unset`).
//! - paying: one instruction to the partner per attempt, `bank.business.bill-pay:<bill id>:<attempt>`, stored before
//!   it is sent and sent once; a lost answer is read back by its key, never sent again blind. A split is our record
//!   beside that one payment, adding up to it exactly.
//! - scheduled: waits for its day and is cancelled until it is sent; declined: back in the inbox with the partner's
//!   reason; returned: given back to the business's account once, under `bank.business.bill-return:<payment id>`.

use std::collections::BTreeMap;

use postgres::{GenericClient, Row};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, is_js_whitespace, js_trim, parse_amount};
use service_kit::time::Instant;
use sha2::{Digest, Sha256};

use crate::business_spend::{Seat, rule_list, seat};
use crate::business_team::service::{TeamRule, handles_of, partner_account, pick_rule};
use crate::errors::Refusal;
use crate::partner::custody::{Held, assert_posting_enabled};
use crate::partner::{MoveRequest, payouts_account, refuse};
use crate::spaces::space::{at, in_tx, pg, with};
use crate::transfers::Deps;

/// The only bill reader there is: a TEST stand-in that reads a TEST bill's labelled lines.
pub const TEST_BILL_READER: &str = "test-lines";
/// `BILL_READER_LABEL`.
pub const BILL_READER_LABEL: &str = "Preview \u{b7} sample data";
/// `MAX_BILL_BYTES`: 1 MiB.
pub const MAX_BILL_BYTES: usize = 1_048_576;
/// `MAX_SPLIT_LINES`.
pub const MAX_SPLIT_LINES: usize = 10;

/// `BILL_RETURN_REASONS`.
pub const BILL_RETURN_REASONS: [&str; 4] = [
    "account_closed",
    "account_not_found",
    "name_mismatch",
    "refused_by_payee_bank",
];

fn return_words(reason: &str) -> &'static str {
    match reason {
        "account_closed" => "The payee\u{2019}s bank account is closed.",
        "account_not_found" => "The payee\u{2019}s bank has no account with these details.",
        "name_mismatch" => "The payee\u{2019}s name does not match the account.",
        _ => "The payee\u{2019}s bank refused the payment.",
    }
}

/// Partner refusals that say nothing moved: the payment is declined with the partner's reason and never sent again.
const DEFINITE_REFUSALS: [&str; 5] = [
    "bank.partner_insufficient_funds",
    "bank.partner_move_conflict",
    "bank.partner_amount_invalid",
    "bank.asset_mismatch",
    "bank.account_restricted",
];

/// `billPayKey`.
pub fn bill_pay_key(bill_id: &str, attempt: i32) -> String {
    format!("bank.business.bill-pay:{bill_id}:{attempt}")
}

/// `billReturnKey`.
pub fn bill_return_key(payment_id: &str) -> String {
    format!("bank.business.bill-return:{payment_id}")
}

/// `parseBillReader`: `test-lines`, or none while no reader is set.
pub fn parse_bill_reader(raw: Option<&str>) -> Option<&'static str> {
    raw.filter(|r| js_trim(r) == TEST_BILL_READER)
        .map(|_| TEST_BILL_READER)
}

/// `BANK_BILL_READER` as `index.ts` hands it: only while the TEST partner is on.
fn reader(d: &Deps<'_>) -> Option<&'static str> {
    d.partner.partner.as_ref()?;
    parse_bill_reader(d.w.settings.bill_reader.as_deref())
}

// ---------------------------------------------------------------------------------------------------------------
// The TEST reader

/// What the reader read (`BillExtraction`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Extraction {
    pub reader: String,
    pub label: String,
    pub vendor: Option<String>,
    pub reference: Option<String>,
    pub amount: Option<String>,
    pub due_date: Option<String>,
}

impl Extraction {
    /// In the contract's key order.
    pub fn json(&self) -> Json {
        Json::obj([
            ("reader", Json::str(self.reader.clone())),
            ("label", Json::str(self.label.clone())),
            ("vendor", opt(self.vendor.as_deref())),
            ("reference", opt(self.reference.as_deref())),
            ("amount", opt(self.amount.as_deref())),
            ("dueDate", opt(self.due_date.as_deref())),
        ])
    }

    fn from_json(v: &Json) -> Extraction {
        let s = |k: &str| match v.get(k) {
            Some(Json::String(x)) => Some(x.clone()),
            _ => None,
        };
        Extraction {
            reader: s("reader").unwrap_or_default(),
            label: s("label").unwrap_or_default(),
            vendor: s("vendor"),
            reference: s("reference"),
            amount: s("amount"),
            due_date: s("dueDate"),
        }
    }
}

/// JavaScript's line terminators, where a multiline `^` and `$` hold and `.` stops.
fn line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `new RegExp('^\\s*<name>\\s*:\\s*(.+?)\\s*$', 'im').exec(text)?.[1]`, with JavaScript's `\s`, line terminators and
/// ASCII-only case folding (no `u` flag).
fn labelled(text: &[char], name: &str) -> Option<String> {
    let name: Vec<char> = name.chars().collect();
    let ws = |i: usize| text.get(i).copied().is_some_and(is_js_whitespace);
    for start in 0..=text.len() {
        if start > 0 && !text.get(start - 1).copied().is_some_and(line_end) {
            continue;
        }
        let mut i = start;
        while ws(i) {
            i += 1;
        }
        let named = name.iter().enumerate().all(|(k, n)| {
            text.get(i + k)
                .is_some_and(|c| c.is_ascii() && c.eq_ignore_ascii_case(n))
        });
        if !named {
            continue;
        }
        i += name.len();
        while ws(i) {
            i += 1;
        }
        if text.get(i) != Some(&':') {
            continue;
        }
        i += 1;
        let mut q = i;
        while ws(q) {
            q += 1;
        }
        // `\s*` greedy, giving back one at a time; then `.+?` lazy; then `\s*$`.
        for s1 in (i..=q).rev() {
            let mut e = s1;
            while text.get(e).is_some_and(|c| !line_end(*c)) {
                e += 1;
                let mut t = e;
                loop {
                    if t == text.len() || text.get(t).copied().is_some_and(line_end) {
                        return Some(text.get(s1..e).unwrap_or_default().iter().collect());
                    }
                    if !ws(t) {
                        break;
                    }
                    t += 1;
                }
            }
        }
    }
    None
}

fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `s.slice(0, n)` by UTF-16 units.
fn js_slice(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// `/^\d{1,18}(\.\d{1,18})?$/`.
fn reader_amount_text(s: &str) -> bool {
    let (whole, frac) = s.split_once('.').map_or((s, None), |(w, f)| (w, Some(f)));
    let digits = |p: &str| (1..=18).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit());
    digits(whole) && frac.is_none_or(digits)
}

/// `isDate`: `YYYY-MM-DD` and a real calendar day.
pub fn is_date(raw: &str) -> bool {
    let b = raw.as_bytes();
    if b.len() != 10
        || b.get(4) != Some(&b'-')
        || b.get(7) != Some(&b'-')
        || !b
            .iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
    {
        return false;
    }
    let n = |r: std::ops::Range<usize>| raw.get(r).and_then(|t| t.parse::<u32>().ok());
    let (Some(y), Some(m), Some(d)) = (n(0..4), n(5..7), n(8..10)) else {
        return false;
    };
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&d)
}

/// `readTestBill`: a TEST bill is plain text with labelled lines (`Vendor: …`, `Reference: …`, `Amount: 150.00`,
/// `Due: 2026-12-01`). What it cannot read is none. It never guesses.
pub fn read_test_bill(file: &[u8]) -> Extraction {
    let text: Vec<char> = String::from_utf8_lossy(file).chars().collect();
    let vendor = labelled(&text, "Vendor");
    let reference = labelled(&text, "Reference");
    let amount = labelled(&text, "Amount");
    let due = labelled(&text, "Due");
    Extraction {
        reader: TEST_BILL_READER.to_owned(),
        label: BILL_READER_LABEL.to_owned(),
        vendor: vendor.filter(|v| !v.is_empty() && js_len(v) <= 128),
        reference: reference.filter(|r| !r.is_empty() && js_len(r) <= 64),
        amount: amount
            .filter(|a| reader_amount_text(a))
            .and_then(|a| parse_amount(&a).ok())
            .filter(|a| *a > Amount::ZERO)
            .map(format_amount),
        due_date: due.filter(|d| is_date(d)),
    }
}

/// `Buffer.from(s, 'base64')` for the door's base64 (`^[A-Za-z0-9+/]+={0,2}$`): a dangling character decodes nothing.
pub fn decode_base64(s: &str) -> Vec<u8> {
    let val = |c: u8| -> Option<u32> {
        Some(u32::from(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        }))
    };
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for c in s.bytes() {
        let Some(v) = val(c) else { break };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((acc >> bits) & 0xff).unwrap_or(0));
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

fn ms(col: &str) -> String {
    format!("floor(extract(epoch from {col}) * 1000)::int8")
}

fn get_s(r: &Row, i: usize) -> Result<String, Refusal> {
    r.try_get::<_, String>(i).map_err(|e| pg(&e))
}

fn get_o(r: &Row, i: usize) -> Result<Option<String>, Refusal> {
    r.try_get::<_, Option<String>>(i).map_err(|e| pg(&e))
}

fn get_i(r: &Row, i: usize) -> Result<i32, Refusal> {
    r.try_get::<_, i32>(i).map_err(|e| pg(&e))
}

fn get_t(r: &Row, i: usize) -> Result<Option<Instant>, Refusal> {
    Ok(r.try_get::<_, Option<i64>>(i)
        .map_err(|e| pg(&e))?
        .map(Instant))
}

fn amount(s: &str) -> Result<Amount, Refusal> {
    parse_amount(s).map_err(Refusal::Other)
}

fn amount_or_none(s: Option<&str>) -> Result<Option<Amount>, Refusal> {
    s.map(amount).transpose()
}

fn opt(s: Option<&str>) -> Json {
    s.map_or(Json::Null, Json::str)
}

fn iso(t: Option<Instant>) -> Json {
    t.map_or(Json::Null, |t| Json::str(t.iso()))
}

fn f(v: Option<Amount>) -> Json {
    v.map_or(Json::Null, |a| Json::str(format_amount(a)))
}

/// `status.replace('_', ' ')`: the first underscore only.
fn words(status: &str) -> String {
    status.replacen('_', " ", 1)
}

fn field_invalid(message: &str) -> Refusal {
    refuse("bank.bill_field_invalid", message)
}

fn request_conflict(what: &str) -> Refusal {
    refuse("bank.business_request_conflict", what)
}

fn payment_not_found() -> Refusal {
    refuse(
        "bank.bill_payment_not_found",
        "No bill payment of this business has that id.",
    )
}

fn no_partner() -> Refusal {
    refuse(
        "bank.no_partner_bank",
        "This business\u{2019}s money is not held at a partner bank, so no bill can be paid from it.",
    )
}

fn closed() -> Refusal {
    refuse("bank.business_closed", "This business account is closed.")
}

/// `need`: the caller's role on the business holds `permission`.
fn need(seat: &Seat<'_>, permission: &str) -> Result<(), Refusal> {
    if seat.holds(permission) {
        return Ok(());
    }
    Err(refuse(
        "bank.business_role_forbidden",
        format!(
            "Your role on this business does not include {}, so this was refused. Nothing changed.",
            words(permission)
        ),
    ))
}

/// `moneyMayMove`: refuses `bank.posting_frozen` while posting is frozen, counted.
fn money_may_move(d: &Deps<'_>) -> Result<(), Refusal> {
    assert_posting_enabled(d.partner.freeze.as_ref(), d.store, "bank_move", true)
}

// ---------------------------------------------------------------------------------------------------------------
// Rows

struct BillRow {
    id: String,
    account_id: String,
    created_by: String,
    file_name: String,
    content_type: String,
    file_sha256: String,
    file_size: i32,
    extracted: Option<Extraction>,
    vendor: Option<String>,
    reference: Option<String>,
    amount: Option<Amount>,
    due_date: Option<String>,
    status: String,
    round: i32,
    approvals_needed: i32,
    rule_id: Option<String>,
    preapproved: bool,
    submitted_by: Option<String>,
    duplicate_of: Option<String>,
    duplicate_cleared_at: Option<Instant>,
    back_reason: Option<String>,
    back_reason_text: Option<String>,
    created_at: Instant,
}

fn bill_cols() -> String {
    format!(
        "id::text, account_id::text, created_by, file_name, content_type, file_sha256, file_size, extracted::text, \
         vendor, reference, amount::text, due_date::text, status, round, approvals_needed, rule_id::text, preapproved, \
         submitted_by, duplicate_of::text, {}, back_reason, back_reason_text, {}",
        ms("duplicate_cleared_at"),
        ms("created_at")
    )
}

impl BillRow {
    fn from_row(r: &Row) -> Result<BillRow, Refusal> {
        let extracted = match get_o(r, 7)? {
            Some(t) => Some(Extraction::from_json(
                &json::parse(&t).map_err(|e| Refusal::Other(e.message))?,
            )),
            None => None,
        };
        Ok(BillRow {
            id: get_s(r, 0)?,
            account_id: get_s(r, 1)?,
            created_by: get_s(r, 2)?,
            file_name: get_s(r, 3)?,
            content_type: get_s(r, 4)?,
            file_sha256: get_s(r, 5)?,
            file_size: get_i(r, 6)?,
            extracted,
            vendor: get_o(r, 8)?,
            reference: get_o(r, 9)?,
            amount: amount_or_none(get_o(r, 10)?.as_deref())?,
            due_date: get_o(r, 11)?,
            status: get_s(r, 12)?,
            round: get_i(r, 13)?,
            approvals_needed: get_i(r, 14)?,
            rule_id: get_o(r, 15)?,
            preapproved: r.try_get::<_, bool>(16).map_err(|e| pg(&e))?,
            submitted_by: get_o(r, 17)?,
            duplicate_of: get_o(r, 18)?,
            duplicate_cleared_at: get_t(r, 19)?,
            back_reason: get_o(r, 20)?,
            back_reason_text: get_o(r, 21)?,
            created_at: get_t(r, 22)?.unwrap_or(Instant(0)),
        })
    }

    /// `BillSummary`'s view.
    fn summary(&self) -> Vec<(String, Json)> {
        vec![
            ("id".to_owned(), Json::str(self.id.clone())),
            ("vendor".to_owned(), opt(self.vendor.as_deref())),
            ("reference".to_owned(), opt(self.reference.as_deref())),
            ("amount".to_owned(), f(self.amount)),
            ("dueDate".to_owned(), opt(self.due_date.as_deref())),
            ("createdAt".to_owned(), Json::str(self.created_at.iso())),
        ]
    }
}

#[derive(Clone)]
struct PaymentRow {
    id: String,
    bill_id: String,
    account_id: String,
    attempt: i32,
    made_by: String,
    asset_id: String,
    amount: Amount,
    scheduled_for: Option<String>,
    status: String,
    partner_key: String,
    partner_move_id: Option<String>,
    partner_reason: Option<String>,
    partner_reason_text: Option<String>,
    return_key: String,
    return_move_id: Option<String>,
    created_at: Instant,
    sent_at: Option<Instant>,
    cancelled_at: Option<Instant>,
    answered_at: Option<Instant>,
}

fn payment_cols() -> String {
    format!(
        "id::text, bill_id::text, account_id::text, attempt, made_by, asset_id, amount::text, scheduled_for::text, \
         status, partner_key, partner_move_id, partner_reason, partner_reason_text, return_key, return_move_id, {}, {}, \
         {}, {}",
        ms("created_at"),
        ms("sent_at"),
        ms("cancelled_at"),
        ms("answered_at")
    )
}

impl PaymentRow {
    fn from_row(r: &Row) -> Result<PaymentRow, Refusal> {
        Ok(PaymentRow {
            id: get_s(r, 0)?,
            bill_id: get_s(r, 1)?,
            account_id: get_s(r, 2)?,
            attempt: get_i(r, 3)?,
            made_by: get_s(r, 4)?,
            asset_id: get_s(r, 5)?,
            amount: amount(&get_s(r, 6)?)?,
            scheduled_for: get_o(r, 7)?,
            status: get_s(r, 8)?,
            partner_key: get_s(r, 9)?,
            partner_move_id: get_o(r, 10)?,
            partner_reason: get_o(r, 11)?,
            partner_reason_text: get_o(r, 12)?,
            return_key: get_s(r, 13)?,
            return_move_id: get_o(r, 14)?,
            created_at: get_t(r, 15)?.unwrap_or(Instant(0)),
            sent_at: get_t(r, 16)?,
            cancelled_at: get_t(r, 17)?,
            answered_at: get_t(r, 18)?,
        })
    }
}

fn bill_row_or_none<C: GenericClient>(
    c: &mut C,
    bill_id: &str,
    lock: bool,
) -> Result<Option<BillRow>, Refusal> {
    c.query(
        &format!(
            "SELECT {} FROM bank.business_bills WHERE id = $1::text::uuid{}",
            bill_cols(),
            if lock { " FOR UPDATE" } else { "" }
        ),
        &[&bill_id],
    )
    .map_err(|e| pg(&e))?
    .first()
    .map(BillRow::from_row)
    .transpose()
}

fn bill_row<C: GenericClient>(c: &mut C, bill_id: &str, lock: bool) -> Result<BillRow, Refusal> {
    bill_row_or_none(c, bill_id, lock)?.ok_or_else(|| {
        refuse(
            "bank.bill_not_found",
            "No bill of this business has that id.",
        )
    })
}

fn payment_row_or_none<C: GenericClient>(
    c: &mut C,
    payment_id: &str,
    lock: bool,
) -> Result<Option<PaymentRow>, Refusal> {
    c.query(
        &format!(
            "SELECT {} FROM bank.business_bill_payments WHERE id = $1::text::uuid{}",
            payment_cols(),
            if lock { " FOR UPDATE" } else { "" }
        ),
        &[&payment_id],
    )
    .map_err(|e| pg(&e))?
    .first()
    .map(PaymentRow::from_row)
    .transpose()
}

fn payment_row<C: GenericClient>(
    c: &mut C,
    payment_id: &str,
    lock: bool,
) -> Result<PaymentRow, Refusal> {
    payment_row_or_none(c, payment_id, lock)?.ok_or_else(payment_not_found)
}

/// Bill Pay limits, each none while not set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Limits {
    pub per_payment: Option<Amount>,
    pub daily: Option<Amount>,
    pub monthly: Option<Amount>,
}

impl Limits {
    fn json(&self) -> Json {
        Json::obj([
            ("perPayment", f(self.per_payment)),
            ("daily", f(self.daily)),
            ("monthly", f(self.monthly)),
        ])
    }
}

fn limits_of<C: GenericClient>(
    c: &mut C,
    account_id: &str,
    lock: bool,
) -> Result<Option<[Option<String>; 3]>, Refusal> {
    c.query(
        &format!(
            "SELECT per_payment::text, daily::text, monthly::text FROM bank.business_bill_limits \
             WHERE account_id = $1::text::uuid{}",
            if lock { " FOR UPDATE" } else { "" }
        ),
        &[&account_id],
    )
    .map_err(|e| pg(&e))?
    .first()
    .map(|r| -> Result<[Option<String>; 3], Refusal> {
        Ok([get_o(r, 0)?, get_o(r, 1)?, get_o(r, 2)?])
    })
    .transpose()
}

fn limits<C: GenericClient>(c: &mut C, account_id: &str) -> Result<Limits, Refusal> {
    let [p, dd, m] = limits_of(c, account_id, false)?.unwrap_or_default();
    Ok(Limits {
        per_payment: amount_or_none(p.as_deref())?,
        daily: amount_or_none(dd.as_deref())?,
        monthly: amount_or_none(m.as_deref())?,
    })
}

/// `flagDuplicate`: flags the earliest other bill of this business that looks the same.
fn flag_duplicate<C: GenericClient>(c: &mut C, bill_id: &str) -> Result<(), Refusal> {
    c.execute(
        "UPDATE bank.business_bills b \
            SET duplicate_of = ( \
              SELECT o.id FROM bank.business_bills o \
               WHERE o.account_id = b.account_id AND o.id <> b.id AND o.created_at <= b.created_at \
                 AND (o.file_sha256 = b.file_sha256 \
                      OR (b.vendor IS NOT NULL AND b.reference IS NOT NULL AND lower(o.vendor) = lower(b.vendor) AND lower(o.reference) = lower(b.reference)) \
                      OR (b.amount IS NOT NULL AND b.due_date IS NOT NULL AND o.amount = b.amount AND o.due_date = b.due_date)) \
               ORDER BY o.created_at ASC, o.id ASC \
               LIMIT 1) \
          WHERE b.id = $1::text::uuid",
        &[&bill_id],
    )
    .map_err(|e| pg(&e))?;
    Ok(())
}

fn assert_not_duplicate(row: &BillRow) -> Result<(), Refusal> {
    if row.duplicate_of.is_some() && row.duplicate_cleared_at.is_none() {
        return Err(refuse(
            "bank.bill_duplicate_uncleared",
            "This bill may be a duplicate of one already received. Someone who manages the team must clear it before it is paid.",
        ));
    }
    Ok(())
}

/// `backToInbox`: the bill comes back with the partner's reason; its approvals start again in a new round.
fn back_to_inbox<C: GenericClient>(
    c: &mut C,
    bill_id: &str,
    reason: &str,
    text: &str,
) -> Result<(), Refusal> {
    c.execute(
        "UPDATE bank.business_bills \
            SET status = 'inbox', round = round + 1, approvals_needed = 0, rule_id = NULL, preapproved = false, \
                submitted_by = NULL, submitted_at = NULL, back_reason = $1, back_reason_text = $2, updated_at = now() \
          WHERE id = $3::text::uuid",
        &[&reason, &text, &bill_id],
    )
    .map_err(|e| pg(&e))?;
    Ok(())
}

/// `assertWithinLimits`: per payment, per day and per month, on the database clock; a blank limit refuses. Payments
/// still live count.
fn assert_within_limits<C: GenericClient>(
    c: &mut C,
    account_id: &str,
    amt: Amount,
) -> Result<(), Refusal> {
    let unset = || {
        refuse(
            "bank.bill_limit_unset",
            "This business\u{2019}s Bill Pay limits are not set, so no bill can be paid yet. Nothing was paid.",
        )
    };
    let Some([Some(per), Some(daily), Some(monthly)]) = limits_of(c, account_id, true)? else {
        return Err(unset());
    };
    let used = c
        .query_one(
            "SELECT coalesce(sum(amount) FILTER (WHERE created_at >= date_trunc('day', now())), 0)::text, \
                    coalesce(sum(amount) FILTER (WHERE created_at >= date_trunc('month', now())), 0)::text \
               FROM bank.business_bill_payments \
              WHERE account_id = $1::text::uuid AND status IN ('scheduled', 'sending', 'sent')",
            &[&account_id],
        )
        .map_err(|e| pg(&e))?;
    let over = |what: &str, cap: &str, now: Amount| -> Result<(), Refusal> {
        let cap = amount(cap)?;
        if now > cap {
            return Err(refuse(
                "bank.bill_limit_exceeded",
                format!(
                    "This payment would pass the business\u{2019}s {what} Bill Pay limit of {}. Nothing was paid.",
                    format_amount(cap)
                ),
            ));
        }
        Ok(())
    };
    let sum = |a: Amount, b: Amount| {
        a.checked_add(b)
            .ok_or_else(|| Refusal::Other("a Bill Pay sum past i128".to_owned()))
    };
    over("per-payment", &per, amt)?;
    over("daily", &daily, sum(amount(&get_s(&used, 0)?)?, amt)?)?;
    over("monthly", &monthly, sum(amount(&get_s(&used, 1)?)?, amt)?)?;
    Ok(())
}

/// `partnerOfAccount`: the partner that holds the business owner's money, through the owner's own seat.
fn partner_of_account<'a>(d: &Deps<'a>, account_id: &str) -> Result<Held<'a>, Refusal> {
    let owner: Option<String> = with(d.store, |c| {
        Ok(c.query(
            "SELECT owner_user_id FROM bank.business_accounts WHERE id = $1::text::uuid",
            &[&account_id],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(|r| get_o(r, 0))
        .transpose()?
        .flatten())
    })?;
    let Some(owner) = owner else {
        return Err(no_partner());
    };
    seat(d, account_id, &owner)?.partner.ok_or_else(no_partner)
}

// ---------------------------------------------------------------------------------------------------------------
// Views

/// `views` with `billView`: each bill with its payments, splits, this round's approvals, duplicate and rule.
fn views(d: &Deps<'_>, rows: &[BillRow]) -> Result<Vec<Json>, Refusal> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
    let (payments, splits, approvals, dups, assets) = with(d.store, |c| {
        let payments = c
            .query(
                &format!(
                    "SELECT {} FROM bank.business_bill_payments WHERE bill_id = ANY($1::text[]::uuid[]) ORDER BY attempt ASC",
                    payment_cols()
                ),
                &[&ids],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(PaymentRow::from_row)
            .collect::<Result<Vec<_>, _>>()?;
        let payment_ids: Vec<String> = payments.iter().map(|p| p.id.clone()).collect();
        let mut splits: Vec<(String, String, Amount)> = Vec::new();
        if !payment_ids.is_empty() {
            for r in c
                .query(
                    "SELECT payment_id::text, category, amount::text FROM bank.business_bill_splits \
                     WHERE payment_id = ANY($1::text[]::uuid[]) ORDER BY line",
                    &[&payment_ids],
                )
                .map_err(|e| pg(&e))?
            {
                splits.push((get_s(&r, 0)?, get_s(&r, 1)?, amount(&get_s(&r, 2)?)?));
            }
        }
        let mut approvals: Vec<(String, i32, String, Instant)> = Vec::new();
        for r in c
            .query(
                &format!(
                    "SELECT bill_id::text, round, approver_user_id, {} FROM bank.business_bill_approvals \
                     WHERE bill_id = ANY($1::text[]::uuid[]) ORDER BY approved_at ASC, approver_user_id ASC",
                    ms("approved_at")
                ),
                &[&ids],
            )
            .map_err(|e| pg(&e))?
        {
            approvals.push((
                get_s(&r, 0)?,
                get_i(&r, 1)?,
                get_s(&r, 2)?,
                get_t(&r, 3)?.unwrap_or(Instant(0)),
            ));
        }
        let mut dup_ids: Vec<String> = Vec::new();
        for r in rows {
            if let Some(dup) = &r.duplicate_of
                && !dup_ids.contains(dup)
            {
                dup_ids.push(dup.clone());
            }
        }
        let dups = if dup_ids.is_empty() {
            Vec::new()
        } else {
            c.query(
                &format!(
                    "SELECT {} FROM bank.business_bills WHERE id = ANY($1::text[]::uuid[])",
                    bill_cols()
                ),
                &[&dup_ids],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(BillRow::from_row)
            .collect::<Result<Vec<_>, _>>()?
        };
        let mut account_ids: Vec<String> = Vec::new();
        for r in rows {
            if !account_ids.contains(&r.account_id) {
                account_ids.push(r.account_id.clone());
            }
        }
        let mut assets: BTreeMap<String, String> = BTreeMap::new();
        for r in c
            .query(
                "SELECT id::text, asset_id FROM bank.business_accounts WHERE id = ANY($1::text[]::uuid[])",
                &[&account_ids],
            )
            .map_err(|e| pg(&e))?
        {
            assets.insert(get_s(&r, 0)?, get_s(&r, 1)?);
        }
        Ok((payments, splits, approvals, dups, assets))
    })?;
    let mut rule_cache: BTreeMap<String, Vec<TeamRule>> = BTreeMap::new();
    for r in rows.iter().filter(|r| r.rule_id.is_some()) {
        if !rule_cache.contains_key(&r.account_id) {
            rule_cache.insert(r.account_id.clone(), rule_list(d, &r.account_id)?);
        }
    }
    let mut people: Vec<String> = rows.iter().map(|r| r.created_by.clone()).collect();
    people.extend(rows.iter().filter_map(|r| r.submitted_by.clone()));
    people.extend(approvals.iter().map(|a| a.2.clone()));
    people.extend(payments.iter().map(|p| p.made_by.clone()));
    let handles = handles_of(d, &people)?;
    let handle = |id: &str| Json::str(handles.get(id).cloned().unwrap_or_default());
    Ok(rows
        .iter()
        .map(|r| {
            let dup = r
                .duplicate_of
                .as_ref()
                .and_then(|id| dups.iter().find(|x| &x.id == id));
            let rule = r.rule_id.as_ref().and_then(|id| {
                rule_cache
                    .get(&r.account_id)
                    .and_then(|rules| rules.iter().find(|x| &x.id == id))
            });
            let mut fields = r.summary();
            fields.extend([
                ("accountId".to_owned(), Json::str(r.account_id.clone())),
                (
                    "assetId".to_owned(),
                    Json::str(assets.get(&r.account_id).cloned().unwrap_or_default()),
                ),
                ("fileName".to_owned(), Json::str(r.file_name.clone())),
                ("contentType".to_owned(), Json::str(r.content_type.clone())),
                ("fileSize".to_owned(), Json::int(i64::from(r.file_size))),
                ("fileSha256".to_owned(), Json::str(r.file_sha256.clone())),
                ("createdByHandle".to_owned(), handle(&r.created_by)),
                (
                    "extracted".to_owned(),
                    r.extracted.as_ref().map_or(Json::Null, Extraction::json),
                ),
                ("status".to_owned(), Json::str(r.status.clone())),
                ("round".to_owned(), Json::int(i64::from(r.round))),
                (
                    "approvalsNeeded".to_owned(),
                    Json::int(i64::from(r.approvals_needed)),
                ),
                ("preapproved".to_owned(), Json::Bool(r.preapproved)),
                ("rule".to_owned(), rule.map_or(Json::Null, TeamRule::json)),
                (
                    "submittedByHandle".to_owned(),
                    r.submitted_by.as_deref().map_or(Json::Null, handle),
                ),
                (
                    "approvals".to_owned(),
                    Json::Array(
                        approvals
                            .iter()
                            .filter(|a| a.0 == r.id && a.1 == r.round)
                            .map(|a| {
                                Json::obj([
                                    ("userId", Json::str(a.2.clone())),
                                    ("handle", handle(&a.2)),
                                    ("approvedAt", Json::str(a.3.iso())),
                                ])
                            })
                            .collect(),
                    ),
                ),
                (
                    "duplicateOf".to_owned(),
                    dup.map_or(Json::Null, |x| Json::Object(x.summary())),
                ),
                (
                    "duplicateCleared".to_owned(),
                    Json::Bool(r.duplicate_cleared_at.is_some()),
                ),
                (
                    "back".to_owned(),
                    r.back_reason.as_ref().map_or(Json::Null, |reason| {
                        Json::obj([
                            ("reason", Json::str(reason.clone())),
                            (
                                "text",
                                Json::str(r.back_reason_text.clone().unwrap_or_default()),
                            ),
                        ])
                    }),
                ),
                (
                    "payments".to_owned(),
                    Json::Array(
                        payments
                            .iter()
                            .filter(|p| p.bill_id == r.id)
                            .map(|p| payment_json(p, &handles, &splits))
                            .collect(),
                    ),
                ),
            ]);
            Json::Object(fields)
        })
        .collect())
}

fn payment_json(
    p: &PaymentRow,
    handles: &BTreeMap<String, String>,
    splits: &[(String, String, Amount)],
) -> Json {
    Json::obj([
        ("id", Json::str(p.id.clone())),
        ("billId", Json::str(p.bill_id.clone())),
        ("attempt", Json::int(i64::from(p.attempt))),
        (
            "madeByHandle",
            Json::str(handles.get(&p.made_by).cloned().unwrap_or_default()),
        ),
        ("assetId", Json::str(p.asset_id.clone())),
        ("amount", Json::str(format_amount(p.amount))),
        ("scheduledFor", opt(p.scheduled_for.as_deref())),
        ("status", Json::str(p.status.clone())),
        ("partnerKey", Json::str(p.partner_key.clone())),
        ("partnerMoveId", opt(p.partner_move_id.as_deref())),
        ("partnerReason", opt(p.partner_reason.as_deref())),
        ("partnerReasonText", opt(p.partner_reason_text.as_deref())),
        ("returnKey", Json::str(p.return_key.clone())),
        ("returnMoveId", opt(p.return_move_id.as_deref())),
        (
            "splits",
            Json::Array(
                splits
                    .iter()
                    .filter(|s| s.0 == p.id)
                    .map(|s| {
                        Json::obj([
                            ("category", Json::str(s.1.clone())),
                            ("amount", Json::str(format_amount(s.2))),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("createdAt", Json::str(p.created_at.iso())),
        ("sentAt", iso(p.sent_at)),
        ("cancelledAt", iso(p.cancelled_at)),
        ("answeredAt", iso(p.answered_at)),
    ])
}

fn one(d: &Deps<'_>, row: BillRow) -> Result<Json, Refusal> {
    views(d, std::slice::from_ref(&row))?
        .into_iter()
        .next()
        .ok_or_else(|| Refusal::Other("a bill's view vanished".to_owned()))
}

/// `billAsSystem`: a bill read for a job's answer, with no member's seat.
fn bill_as_system(d: &Deps<'_>, bill_id: &str) -> Result<Json, Refusal> {
    let row = with(d.store, |c| bill_row(c, bill_id, false))?;
    one(d, row)
}

// ---------------------------------------------------------------------------------------------------------------
// Reads

/// `bills`: the inbox, by approval status and then due date.
pub fn bills(d: &Deps<'_>, account_id: &str, user_id: &str) -> Result<Json, Refusal> {
    seat(d, account_id, user_id)?;
    let rows = with(d.store, |c| {
        c.query(
            &format!(
                "SELECT {} FROM bank.business_bills WHERE account_id = $1::text::uuid \
                 ORDER BY array_position(ARRAY['inbox','awaiting_approval','approved','scheduled','paying','paid'], status), \
                          due_date ASC NULLS LAST, created_at ASC, id ASC \
                 LIMIT 100",
                bill_cols()
            ),
            &[&account_id],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(BillRow::from_row)
        .collect::<Result<Vec<_>, _>>()
    })?;
    Ok(Json::Array(views(d, &rows)?))
}

/// `bill`.
pub fn bill(d: &Deps<'_>, bill_id: &str, user_id: &str) -> Result<Json, Refusal> {
    let row = with(d.store, |c| bill_row(c, bill_id, false))?;
    seat(d, &row.account_id, user_id)?;
    one(d, row)
}

fn vendor_json(name: String, cap: Amount, created_at: Instant) -> Json {
    Json::obj([
        ("name", Json::str(name)),
        ("cap", Json::str(format_amount(cap))),
        ("createdAt", Json::str(created_at.iso())),
    ])
}

/// `settings`: the business's asset, the reader (if one is set), its vendors and its limits.
pub fn settings(d: &Deps<'_>, account_id: &str, user_id: &str) -> Result<Json, Refusal> {
    let s = seat(d, account_id, user_id)?;
    let (vendors, lim) = with(d.store, |c| {
        let mut vendors = Vec::new();
        for r in c
            .query(
                &format!(
                    "SELECT name, cap::text, {} FROM bank.business_bill_vendors WHERE account_id = $1::text::uuid \
                     ORDER BY lower(name)",
                    ms("created_at")
                ),
                &[&account_id],
            )
            .map_err(|e| pg(&e))?
        {
            vendors.push(vendor_json(
                get_s(&r, 0)?,
                amount(&get_s(&r, 1)?)?,
                get_t(&r, 2)?.unwrap_or(Instant(0)),
            ));
        }
        Ok((vendors, limits(c, account_id)?))
    })?;
    Ok(Json::obj([
        ("assetId", Json::str(s.account.asset_id)),
        (
            "reader",
            reader(d).map_or(Json::Null, |id| {
                Json::obj([
                    ("id", Json::str(id)),
                    ("label", Json::str(BILL_READER_LABEL)),
                ])
            }),
        ),
        ("vendors", Json::Array(vendors)),
        ("limits", lim.json()),
    ]))
}

// ---------------------------------------------------------------------------------------------------------------
// The inbox

/// One upload (`upload`'s input past the router).
pub struct UploadAsk<'a> {
    pub account_id: &'a str,
    pub user_id: &'a str,
    pub bill_id: &'a str,
    pub file_name: &'a str,
    pub content_type: &'a str,
    pub file: &'a [u8],
}

fn file_invalid(message: &str) -> Refusal {
    refuse("bank.bill_file_invalid", message)
}

/// `upload` (BK-bill-01): a bill into the inbox. The same id sent again with the same file is the same bill.
pub fn upload(d: &Deps<'_>, ask: &UploadAsk<'_>) -> Result<Json, Refusal> {
    let file_name = js_trim(ask.file_name);
    if file_name.is_empty() || js_len(file_name) > 128 {
        return Err(file_invalid(
            "A bill file needs a name of 1 to 128 characters.",
        ));
    }
    if ask.file.is_empty() || ask.file.len() > MAX_BILL_BYTES {
        return Err(file_invalid("A bill file is 1 byte to 1 MiB."));
    }
    let sha: String = Sha256::digest(ask.file)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let s = seat(d, ask.account_id, ask.user_id)?;
    need(&s, "propose")?;
    if s.account.status != "active" {
        return Err(closed());
    }
    let conflict = || request_conflict("This bill id is already used for another file.");
    if let Some(prior) = with(d.store, |c| bill_row_or_none(c, ask.bill_id, false))? {
        if prior.account_id != ask.account_id || prior.file_sha256 != sha {
            return Err(conflict());
        }
        return bill(d, &prior.id, ask.user_id);
    }
    let read = reader(d).map(|_| read_test_bill(ask.file));
    let size = i32::try_from(ask.file.len()).map_err(|e| Refusal::Other(e.to_string()))?;
    let content_type = js_slice(ask.content_type, 128);
    in_tx(d.store, |tx| {
        let extracted = read.as_ref().map(|r| r.json().compact());
        let inserted = tx
            .query(
                "INSERT INTO bank.business_bills \
                   (id, account_id, created_by, file_name, content_type, file_sha256, file_size, file, extracted, vendor, \
                    reference, amount, due_date) \
                 VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5, $6, $7, $8, $9::text::jsonb, $10, $11, \
                         $12::text::numeric, $13::text::date) \
                 ON CONFLICT (id) DO NOTHING \
                 RETURNING id",
                &[
                    &ask.bill_id,
                    &ask.account_id,
                    &ask.user_id,
                    &file_name,
                    &content_type,
                    &sha,
                    &size,
                    &ask.file,
                    &extracted,
                    &read.as_ref().and_then(|r| r.vendor.clone()),
                    &read.as_ref().and_then(|r| r.reference.clone()),
                    &read.as_ref().and_then(|r| r.amount.clone()),
                    &read.as_ref().and_then(|r| r.due_date.clone()),
                ],
            )
            .map_err(|e| pg(&e))?;
        if !inserted.is_empty() {
            flag_duplicate(tx, ask.bill_id)?;
        }
        Ok(())
    })?;
    let row = with(d.store, |c| bill_row(c, ask.bill_id, false))?;
    if row.file_sha256 != sha || row.account_id != ask.account_id {
        return Err(conflict());
    }
    bill(d, &row.id, ask.user_id)
}

/// A person's review of what the bill says.
pub struct ReviewAsk<'a> {
    pub bill_id: &'a str,
    pub user_id: &'a str,
    pub vendor: Option<&'a str>,
    pub reference: Option<&'a str>,
    pub amount: Option<Amount>,
    pub due_date: Option<&'a str>,
}

/// `review`: only a bill in the inbox is edited; the duplicate check runs again unless it was cleared.
pub fn review(d: &Deps<'_>, ask: &ReviewAsk<'_>) -> Result<Json, Refusal> {
    let vendor = ask.vendor.map(js_trim).filter(|v| !v.is_empty());
    let reference = ask.reference.map(js_trim).filter(|v| !v.is_empty());
    if vendor.is_some_and(|v| js_len(v) > 128) {
        return Err(field_invalid("A vendor is 128 characters or fewer."));
    }
    if reference.is_some_and(|v| js_len(v) > 64) {
        return Err(field_invalid("A reference is 64 characters or fewer."));
    }
    if ask.amount.is_some_and(|a| a <= Amount::ZERO) {
        return Err(field_invalid("A bill\u{2019}s amount is above zero."));
    }
    if ask.due_date.is_some_and(|v| !is_date(v)) {
        return Err(field_invalid("A due date is a calendar date."));
    }
    in_tx(d.store, |tx| {
        let row = bill_row(tx, ask.bill_id, true)?;
        let s = seat(d, &row.account_id, ask.user_id)?;
        need(&s, "propose")?;
        if row.status != "inbox" {
            return Err(refuse(
                "bank.bill_not_editable",
                format!(
                    "This bill is {}; only a bill in the inbox is edited.",
                    words(&row.status)
                ),
            ));
        }
        tx.execute(
            "UPDATE bank.business_bills \
                SET vendor = $1, reference = $2, amount = $3::text::numeric, due_date = $4::text::date, updated_at = now() \
              WHERE id = $5::text::uuid",
            &[
                &vendor,
                &reference,
                &ask.amount.map(format_amount),
                &ask.due_date,
                &row.id,
            ],
        )
        .map_err(|e| pg(&e))?;
        if row.duplicate_cleared_at.is_none() {
            flag_duplicate(tx, &row.id)?;
        }
        Ok(())
    })?;
    bill(d, ask.bill_id, ask.user_id)
}

/// `clearDuplicate`: someone who manages the team says the flagged bill is not a duplicate.
pub fn clear_duplicate(d: &Deps<'_>, bill_id: &str, user_id: &str) -> Result<Json, Refusal> {
    in_tx(d.store, |tx| {
        let row = bill_row(tx, bill_id, true)?;
        let s = seat(d, &row.account_id, user_id)?;
        need(&s, "manage_team")?;
        if row.duplicate_of.is_none() || row.duplicate_cleared_at.is_some() {
            return Ok(());
        }
        tx.execute(
            "UPDATE bank.business_bills SET duplicate_cleared_by = $1, duplicate_cleared_at = now(), updated_at = now() \
             WHERE id = $2::text::uuid",
            &[&user_id, &row.id],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })?;
    bill(d, bill_id, user_id)
}

// ---------------------------------------------------------------------------------------------------------------
// Vendors and limits

/// `setVendor` (BK-bill-02): a pre-approved vendor and its cap, set again under the same name.
pub fn set_vendor(
    d: &Deps<'_>,
    account_id: &str,
    user_id: &str,
    name: &str,
    cap: Amount,
) -> Result<Json, Refusal> {
    let name = js_trim(name);
    if name.is_empty() || js_len(name) > 128 {
        return Err(field_invalid(
            "A vendor needs a name of 1 to 128 characters.",
        ));
    }
    if cap <= Amount::ZERO {
        return Err(field_invalid("A vendor\u{2019}s cap is above zero."));
    }
    let s = seat(d, account_id, user_id)?;
    need(&s, "manage_team")?;
    with(d.store, |c| {
        let r = c
            .query_one(
                &format!(
                    "INSERT INTO bank.business_bill_vendors (account_id, name, cap, created_by) \
                     VALUES ($1::text::uuid, $2, $3::text::numeric, $4) \
                     ON CONFLICT (account_id, lower(name)) DO UPDATE SET cap = EXCLUDED.cap, updated_at = now() \
                     RETURNING name, cap::text, {}",
                    ms("created_at")
                ),
                &[&account_id, &name, &format_amount(cap), &user_id],
            )
            .map_err(|e| pg(&e))?;
        Ok(vendor_json(
            get_s(&r, 0)?,
            amount(&get_s(&r, 1)?)?,
            get_t(&r, 2)?.unwrap_or(Instant(0)),
        ))
    })
}

/// `setLimits` (BK-bill-02): a blank limit stays not set, and every payment refuses until all are.
pub fn set_limits(
    d: &Deps<'_>,
    account_id: &str,
    user_id: &str,
    l: Limits,
) -> Result<Json, Refusal> {
    for v in [l.per_payment, l.daily, l.monthly].into_iter().flatten() {
        if v <= Amount::ZERO {
            return Err(field_invalid(
                "A Bill Pay limit is above zero, or left blank.",
            ));
        }
    }
    let s = seat(d, account_id, user_id)?;
    need(&s, "manage_team")?;
    with(d.store, |c| {
        c.execute(
            "INSERT INTO bank.business_bill_limits (account_id, per_payment, daily, monthly, updated_by) \
             VALUES ($1::text::uuid, $2::text::numeric, $3::text::numeric, $4::text::numeric, $5) \
             ON CONFLICT (account_id) DO UPDATE \
               SET per_payment = EXCLUDED.per_payment, daily = EXCLUDED.daily, monthly = EXCLUDED.monthly, \
                   updated_by = EXCLUDED.updated_by, updated_at = now()",
            &[
                &account_id,
                &l.per_payment.map(format_amount),
                &l.daily.map(format_amount),
                &l.monthly.map(format_amount),
                &user_id,
            ],
        )
        .map_err(|e| pg(&e))?;
        Ok(limits(c, account_id)?.json())
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Approval

/// `submit`: approved at once from a pre-approved vendor at or under its cap, otherwise to approvers. The rule and the
/// count are fixed now.
pub fn submit(d: &Deps<'_>, bill_id: &str, user_id: &str) -> Result<Json, Refusal> {
    in_tx(d.store, |tx| {
        let row = bill_row(tx, bill_id, true)?;
        let s = seat(d, &row.account_id, user_id)?;
        need(&s, "propose")?;
        if row.status != "inbox" {
            return Err(refuse(
                "bank.bill_not_editable",
                format!("This bill is {}, not in the inbox.", words(&row.status)),
            ));
        }
        assert_not_duplicate(&row)?;
        let (Some(vendor), Some(amt), Some(_)) = (&row.vendor, row.amount, &row.due_date) else {
            return Err(refuse(
                "bank.bill_incomplete",
                "Review the bill first: it needs a vendor, an amount and a due date.",
            ));
        };
        let cap = tx
            .query(
                "SELECT cap::text FROM bank.business_bill_vendors \
                 WHERE account_id = $1::text::uuid AND lower(name) = lower($2)",
                &[&row.account_id, vendor],
            )
            .map_err(|e| pg(&e))?
            .first()
            .map(|r| get_s(r, 0))
            .transpose()?;
        if let Some(cap) = cap
            && amt <= amount(&cap)?
        {
            tx.execute(
                "UPDATE bank.business_bills \
                    SET status = 'approved', preapproved = true, approvals_needed = 0, rule_id = NULL, \
                        submitted_by = $1, submitted_at = now(), updated_at = now() \
                  WHERE id = $2::text::uuid",
                &[&user_id, &row.id],
            )
            .map_err(|e| pg(&e))?;
            return Ok(());
        }
        let rules = rule_list(d, &row.account_id)?;
        let plain: Vec<_> = rules.iter().map(|r| r.rule.clone()).collect();
        let rule = pick_rule(&plain, amt, vendor, "domestic").and_then(|i| rules.get(i));
        let needed = rule.map_or(0, |r| r.rule.approvals).max(1);
        let pool = crate::business_spend::approver_pool(d, &row.account_id, user_id)?.len();
        if i64::try_from(pool).unwrap_or(i64::MAX) < needed {
            return Err(refuse(
                "bank.business_approvers_short",
                format!(
                    "This bill needs {needed} approvers other than you, and this business has {pool}. It stays in the inbox."
                ),
            ));
        }
        let needed = i32::try_from(needed).map_err(|e| Refusal::Other(e.to_string()))?;
        tx.execute(
            "UPDATE bank.business_bills \
                SET status = 'awaiting_approval', preapproved = false, approvals_needed = $1, rule_id = $2::text::uuid, \
                    submitted_by = $3, submitted_at = now(), updated_at = now() \
              WHERE id = $4::text::uuid",
            &[&needed, &rule.map(|r| r.id.clone()), &user_id, &row.id],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })?;
    bill(d, bill_id, user_id)
}

/// `approve`: one approval by one distinct approver, never the person who sent the bill on. The last one approves it.
pub fn approve(d: &Deps<'_>, bill_id: &str, user_id: &str) -> Result<Json, Refusal> {
    in_tx(d.store, |tx| {
        let row = bill_row(tx, bill_id, true)?;
        let s = seat(d, &row.account_id, user_id)?;
        if row.submitted_by.as_deref() == Some(user_id) {
            return Err(refuse(
                "bank.business_self_approve",
                "You sent this bill for approval, so you cannot approve it. Another approver must.",
            ));
        }
        need(&s, "approve")?;
        if row.status != "awaiting_approval" {
            return Err(refuse(
                "bank.business_approval_inactive",
                format!(
                    "This bill is {}; it takes no approvals.",
                    words(&row.status)
                ),
            ));
        }
        let added = tx
            .query(
                "INSERT INTO bank.business_bill_approvals (bill_id, round, approver_user_id) \
                 VALUES ($1::text::uuid, $2, $3) ON CONFLICT DO NOTHING RETURNING bill_id",
                &[&row.id, &row.round, &user_id],
            )
            .map_err(|e| pg(&e))?;
        if added.is_empty() {
            return Err(refuse(
                "bank.business_already_approved",
                "You have already approved this bill. A different approver must give the next approval.",
            ));
        }
        let count: i64 = tx
            .query_one(
                "SELECT count(*) FROM bank.business_bill_approvals WHERE bill_id = $1::text::uuid AND round = $2",
                &[&row.id, &row.round],
            )
            .map_err(|e| pg(&e))?
            .try_get(0)
            .map_err(|e| pg(&e))?;
        if count >= i64::from(row.approvals_needed) {
            tx.execute(
                "UPDATE bank.business_bills SET status = 'approved', updated_at = now() \
                 WHERE id = $1::text::uuid AND status = 'awaiting_approval'",
                &[&row.id],
            )
            .map_err(|e| pg(&e))?;
        }
        Ok(())
    })?;
    bill(d, bill_id, user_id)
}

// ---------------------------------------------------------------------------------------------------------------
// Paying

/// One split line, as the router parsed it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SplitLine {
    pub category: String,
    pub amount: Amount,
}

/// `pay`'s input past the router.
pub struct PayAsk<'a> {
    pub bill_id: &'a str,
    pub user_id: &'a str,
    pub payment_id: &'a str,
    pub scheduled_for: Option<&'a str>,
    pub splits: &'a [SplitLine],
}

/// `pay` (BK-bill-02, BK-bill-03): pays an approved bill now, or schedules it for a later date. One instruction to the
/// partner under `bank.business.bill-pay:<bill id>:<attempt>`, written before it is sent. The same payment id again
/// is the same payment.
pub fn pay(d: &Deps<'_>, ask: &PayAsk<'_>) -> Result<Json, Refusal> {
    if let Some(prior) = with(d.store, |c| payment_row_or_none(c, ask.payment_id, false))? {
        if prior.bill_id != ask.bill_id || prior.scheduled_for.as_deref() != ask.scheduled_for {
            return Err(request_conflict(
                "This payment id is already used on different terms.",
            ));
        }
        let s = seat(d, &prior.account_id, ask.user_id)?;
        need(&s, "propose")?;
        if prior.status == "sending" {
            money_may_move(d)?;
            send(d, &prior, s.partner.as_ref())?;
        }
        return bill(d, ask.bill_id, ask.user_id);
    }
    if ask.splits.len() > MAX_SPLIT_LINES {
        return Err(field_invalid(&format!(
            "A payment is split into at most {MAX_SPLIT_LINES} lines."
        )));
    }
    for line in ask.splits {
        let category = js_trim(&line.category);
        if category.is_empty() || js_len(category) > 64 {
            return Err(field_invalid(
                "Each line needs a category of 1 to 64 characters.",
            ));
        }
        if line.amount <= Amount::ZERO {
            return Err(field_invalid("Each line\u{2019}s amount is above zero."));
        }
    }
    if ask.scheduled_for.is_some_and(|v| !is_date(v)) {
        return Err(refuse(
            "bank.bill_schedule_invalid",
            "A payment date is a calendar date.",
        ));
    }
    // Paid now, money leaves at once: while posting is frozen nothing is recorded or sent.
    if ask.scheduled_for.is_none() {
        money_may_move(d)?;
    }
    let (payment, partner) = in_tx(d.store, |tx| {
        let row = bill_row(tx, ask.bill_id, true)?;
        let s = seat(d, &row.account_id, ask.user_id)?;
        need(&s, "propose")?;
        if s.account.status != "active" {
            return Err(closed());
        }
        if s.partner.is_none() {
            return Err(no_partner());
        }
        assert_not_duplicate(&row)?;
        if row.status != "approved" {
            return Err(refuse(
                "bank.bill_not_approved",
                if row.status == "awaiting_approval" {
                    "This bill is waiting for its approvals; it cannot be paid yet.".to_owned()
                } else {
                    format!(
                        "This bill is {}; only an approved bill is paid.",
                        words(&row.status)
                    )
                },
            ));
        }
        let amt = row
            .amount
            .ok_or_else(|| Refusal::Other("an approved bill with no amount".to_owned()))?;
        if !ask.splits.is_empty() {
            let mut total = Amount::ZERO;
            for l in ask.splits {
                total = total
                    .checked_add(l.amount)
                    .ok_or_else(|| Refusal::Other("a split total past i128".to_owned()))?;
            }
            if total != amt {
                return Err(refuse(
                    "bank.split_total_mismatch",
                    format!(
                        "The lines add up to {}, not the bill\u{2019}s {}. Nothing was paid.",
                        format_amount(total),
                        format_amount(amt)
                    ),
                ));
            }
        }
        if let Some(day) = ask.scheduled_for {
            let later: bool = tx
                .query_one("SELECT $1::text::date > current_date", &[&day])
                .map_err(|e| pg(&e))?
                .try_get(0)
                .map_err(|e| pg(&e))?;
            if !later {
                return Err(refuse(
                    "bank.bill_schedule_invalid",
                    "A scheduled payment is for a later day; to pay today, pay now.",
                ));
            }
        }
        assert_within_limits(tx, &row.account_id, amt)?;
        let attempt: i32 = tx
            .query_one(
                "SELECT coalesce(max(attempt), 0) FROM bank.business_bill_payments WHERE bill_id = $1::text::uuid",
                &[&row.id],
            )
            .map_err(|e| pg(&e))?
            .try_get::<_, i32>(0)
            .map_err(|e| pg(&e))?
            + 1;
        let status = if ask.scheduled_for.is_none() {
            "sending"
        } else {
            "scheduled"
        };
        let payment = tx
            .query_one(
                &format!(
                    "INSERT INTO bank.business_bill_payments \
                       (id, bill_id, account_id, attempt, made_by, asset_id, amount, scheduled_for, status, partner_key, \
                        return_key) \
                     VALUES ($1::text::uuid, $2::text::uuid, $3::text::uuid, $4, $5, $6, $7::text::numeric, $8::text::date, \
                             $9, $10, $11) \
                     RETURNING {}",
                    payment_cols()
                ),
                &[
                    &ask.payment_id,
                    &row.id,
                    &row.account_id,
                    &attempt,
                    &ask.user_id,
                    &s.account.asset_id,
                    &format_amount(amt),
                    &ask.scheduled_for,
                    &status,
                    &bill_pay_key(&row.id, attempt),
                    &bill_return_key(ask.payment_id),
                ],
            )
            .map_err(|e| pg(&e))?;
        let payment = PaymentRow::from_row(&payment)?;
        for (i, l) in ask.splits.iter().enumerate() {
            let line = i32::try_from(i + 1).map_err(|e| Refusal::Other(e.to_string()))?;
            tx.execute(
                "INSERT INTO bank.business_bill_splits (payment_id, line, category, amount) \
                 VALUES ($1::text::uuid, $2, $3, $4::text::numeric)",
                &[
                    &ask.payment_id,
                    &line,
                    &js_trim(&l.category),
                    &format_amount(l.amount),
                ],
            )
            .map_err(|e| pg(&e))?;
        }
        tx.execute(
            "UPDATE bank.business_bills SET status = $1, updated_at = now() WHERE id = $2::text::uuid",
            &[
                &if status == "sending" {
                    "paying"
                } else {
                    "scheduled"
                },
                &row.id,
            ],
        )
        .map_err(|e| pg(&e))?;
        Ok((payment, s.partner))
    })?;
    if payment.status == "sending" {
        send(d, &payment, partner.as_ref())?;
    }
    bill(d, ask.bill_id, ask.user_id)
}

/// `resend`: a sending payment whose partner answer was not definite, sent again under the same key.
pub fn resend(d: &Deps<'_>, payment_id: &str, user_id: &str) -> Result<Json, Refusal> {
    let row = with(d.store, |c| payment_row(c, payment_id, false))?;
    let s = seat(d, &row.account_id, user_id)?;
    need(&s, "propose")?;
    if row.status == "sending" {
        money_may_move(d)?;
        send(d, &row, s.partner.as_ref())?;
    }
    bill(d, &row.bill_id, user_id)
}

/// `cancel` (BK-bill-03): a scheduled payment stopped before it is sent; the bill is approved again. A second cancel
/// changes nothing; once sent it cannot be cancelled here.
pub fn cancel(d: &Deps<'_>, payment_id: &str, user_id: &str) -> Result<Json, Refusal> {
    in_tx(d.store, |tx| {
        let row = payment_row(tx, payment_id, true)?;
        let s = seat(d, &row.account_id, user_id)?;
        need(&s, "propose")?;
        if row.status == "cancelled" {
            return Ok(());
        }
        if row.status != "scheduled" {
            return Err(refuse(
                "bank.bill_payment_sent",
                "This payment was already sent to the partner bank, so it cannot be cancelled here.",
            ));
        }
        tx.execute(
            "UPDATE bank.business_bill_payments SET status = 'cancelled', cancelled_at = now() WHERE id = $1::text::uuid",
            &[&row.id],
        )
        .map_err(|e| pg(&e))?;
        tx.execute(
            "UPDATE bank.business_bills SET status = 'approved', updated_at = now() \
             WHERE id = $1::text::uuid AND status = 'scheduled'",
            &[&row.bill_id],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })?;
    let row = with(d.store, |c| payment_row(c, payment_id, false))?;
    bill(d, &row.bill_id, user_id)
}

/// What one pass of the due run did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RunDue {
    pub sent: i64,
    pub declined: i64,
    pub unknown: i64,
}

impl RunDue {
    pub fn json(&self) -> Json {
        Json::obj([
            ("sent", Json::int(self.sent)),
            ("declined", Json::int(self.declined)),
            ("unknown", Json::int(self.unknown)),
        ])
    }
}

/// `runDue`: the scheduled payments whose day has come, sent once each. A payment cancelled first is never picked up:
/// the cancel and this pick change the same row's status, one at a time.
pub fn run_due(d: &Deps<'_>, limit: i64) -> Result<RunDue, Refusal> {
    money_may_move(d)?;
    let picked = in_tx(d.store, |tx| {
        tx.query(
            &format!(
                "UPDATE bank.business_bill_payments SET status = 'sending' \
                  WHERE id IN (SELECT id FROM bank.business_bill_payments \
                                WHERE status = 'scheduled' AND scheduled_for <= current_date \
                                ORDER BY scheduled_for, created_at LIMIT $1 FOR UPDATE SKIP LOCKED) \
                  RETURNING {}",
                payment_cols()
            ),
            &[&limit],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(PaymentRow::from_row)
        .collect::<Result<Vec<_>, _>>()
    })?;
    with(d.store, |c| {
        for p in &picked {
            c.execute(
                "UPDATE bank.business_bills SET status = 'paying', updated_at = now() WHERE id = $1::text::uuid",
                &[&p.bill_id],
            )
            .map_err(|e| pg(&e))?;
        }
        Ok(())
    })?;
    let mut out = RunDue::default();
    for p in &picked {
        let sent =
            partner_of_account(d, &p.account_id).and_then(|partner| send(d, p, Some(&partner)));
        match sent {
            Ok(Sent::Sent) => out.sent += 1,
            Ok(Sent::Declined) => out.declined += 1,
            Err(_) => out.unknown += 1,
        }
    }
    Ok(out)
}

/// `returned`: the partner reports the payee's bank sent a payment back. The amount is given back to the business's
/// account once, under its return key; the same report again answers the same.
pub fn returned(d: &Deps<'_>, payment_id: &str, reason: &str) -> Result<Json, Refusal> {
    let row = with(d.store, |c| payment_row(c, payment_id, false))?;
    if row.status == "returned" {
        return bill_as_system(d, &row.bill_id);
    }
    if row.status != "sent" {
        return Err(refuse(
            "bank.bill_payment_not_sent",
            format!(
                "This bill payment is {}; only a sent payment comes back.",
                row.status
            ),
        ));
    }
    let partner = partner_of_account(d, &row.account_id)?;
    let back = partner.move_(
        &MoveRequest {
            key: row.return_key.clone(),
            from: payouts_account(&row.asset_id),
            to: partner_account(&row.account_id, &row.asset_id),
            amount: row.amount,
            payees: None,
        },
        d.now,
    )?;
    let text = return_words(reason);
    in_tx(d.store, |tx| {
        let moved = tx
            .query(
                "UPDATE bank.business_bill_payments \
                    SET status = 'returned', return_move_id = $1, partner_reason = $2, partner_reason_text = $3, \
                        answered_at = now() \
                  WHERE id = $4::text::uuid AND status = 'sent' \
                  RETURNING id",
                &[&back.id, &reason, &text, &row.id],
            )
            .map_err(|e| pg(&e))?;
        if !moved.is_empty() {
            back_to_inbox(tx, &row.bill_id, &format!("returned:{reason}"), text)?;
        }
        Ok(())
    })?;
    bill_as_system(d, &row.bill_id)
}

enum Sent {
    Sent,
    Declined,
}

/// `send`: one payment's instruction. A retry first asks the partner for the move under this key: an answer that was
/// lost is never sent again blind. A definite refusal declines it and puts the bill back; any other failure stands.
fn send(d: &Deps<'_>, row: &PaymentRow, partner: Option<&Held<'_>>) -> Result<Sent, Refusal> {
    let partner = partner.ok_or_else(no_partner)?;
    let moved = match partner.move_by_key(&row.partner_key) {
        Some(m) => Ok(m),
        None => partner.move_(
            &MoveRequest {
                key: row.partner_key.clone(),
                from: partner_account(&row.account_id, &row.asset_id),
                to: payouts_account(&row.asset_id),
                amount: row.amount,
                payees: None,
            },
            d.now,
        ),
    };
    let m = match moved {
        Ok(m) => m,
        Err(Refusal::Bank(e)) if DEFINITE_REFUSALS.contains(&e.row.code) => {
            let code = e.row.code;
            let text = js_slice(&e.message, 500);
            in_tx(d.store, |tx| {
                let declined = tx
                    .query(
                        "UPDATE bank.business_bill_payments \
                            SET status = 'declined', partner_reason = $1, partner_reason_text = $2, answered_at = now() \
                          WHERE id = $3::text::uuid AND status = 'sending' \
                          RETURNING id",
                        &[&code, &text, &row.id],
                    )
                    .map_err(|e| pg(&e))?;
                if !declined.is_empty() {
                    back_to_inbox(tx, &row.bill_id, code, &text)?;
                }
                Ok(())
            })?;
            return Ok(Sent::Declined);
        }
        Err(e) => return Err(e),
    };
    in_tx(d.store, |tx| {
        let sent = tx
            .query(
                &format!(
                    "UPDATE bank.business_bill_payments \
                        SET status = 'sent', partner_move_id = $1, sent_at = {}, answered_at = now() \
                      WHERE id = $3::text::uuid AND status = 'sending' \
                      RETURNING id",
                    at("$2")
                ),
                &[&m.id, &m.moved_at.0, &row.id],
            )
            .map_err(|e| pg(&e))?;
        if !sent.is_empty() {
            tx.execute(
                "UPDATE bank.business_bills SET status = 'paid', updated_at = now() WHERE id = $1::text::uuid",
                &[&row.bill_id],
            )
            .map_err(|e| pg(&e))?;
        }
        Ok(())
    })?;
    Ok(Sent::Sent)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
mod tests {
    use super::*;

    /// `the TEST reader reads only labelled lines, and never guesses`.
    #[test]
    fn the_test_reader_reads_only_labelled_lines_and_never_guesses() {
        let read = read_test_bill(
            b"Vendor: TEST Paper Co\nReference: INV-1\nAmount: 150.00\nDue: 2026-12-01\n",
        );
        assert_eq!(read.label, "Preview \u{b7} sample data");
        assert_eq!(read.vendor.as_deref(), Some("TEST Paper Co"));
        assert_eq!(read.reference.as_deref(), Some("INV-1"));
        assert_eq!(read.amount.as_deref(), Some("150"));
        assert_eq!(read.due_date.as_deref(), Some("2026-12-01"));
        let none = read_test_bill(b"Amount: lots\nDue: 2026-02-30");
        assert_eq!(none.vendor, None);
        assert_eq!(none.amount, None);
        assert_eq!(none.due_date, None);
    }

    #[test]
    fn the_labelled_lines_read_as_the_typescript_regex_does() {
        let t = |s: &str, n: &str| labelled(&s.chars().collect::<Vec<_>>(), n);
        assert_eq!(
            t("  vendor :  A B  \r\nx", "Vendor").as_deref(),
            Some("A B")
        );
        assert_eq!(t("TEST BILL\nVENDOR:x", "Vendor").as_deref(), Some("x"));
        assert_eq!(t("Vendor:\nnext", "Vendor").as_deref(), Some("next"));
        assert_eq!(t("Vendor: \n", "Vendor").as_deref(), Some(" "));
        assert_eq!(t("xVendor: a", "Vendor"), None);
        assert_eq!(t("Vendor:", "Vendor"), None);
    }

    #[test]
    fn base64_decodes_as_buffer_from_does() {
        assert_eq!(decode_base64("aGVsbG8="), b"hello");
        assert_eq!(decode_base64("aGVsbG8"), b"hello");
        assert_eq!(decode_base64("AAAAA"), vec![0, 0, 0]);
    }

    #[test]
    fn a_date_is_a_calendar_day() {
        assert!(is_date("2024-02-29"));
        assert!(!is_date("2026-02-29"));
        assert!(!is_date("2026-13-01"));
        assert!(!is_date("2026-1-01"));
    }
}
