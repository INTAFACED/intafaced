//! Part `pay` of the bills slice: personal bill pay over one ledger (`personal-pay/bills.ts`, `personal-pay/post.ts`,
//! `personal-pay/ports.ts`, `personal-pay/errors.ts`, `personal-pay/step-up-fields.ts`, and `personal-pay/router.ts`
//! `createBillsRouter`).
//!
//! Search, lookup and pay all refuse while their partner is unset; `index.ts` hands the area none, so on every stack
//! today each refuses `socket.psp-partners` by name and nothing is invented. Pay records the original instruction first
//! (business key: the person and their idempotency key), then either refuses with nothing posted or posts once through
//! svc-ledger's `bankTransfer` recipe to the bill rail's boundary under `bank.transfer.rail:<paymentId>:0`, and, when
//! the rail then refuses, back under `...:1`. A retry of the same key is that same instruction. A recurring bill
//! refuses until the pay rail is live; each occurrence it fires is a payment under `bill-recur:<schedule>:<n>`.
//!
//! If this crashes exactly here, whose funds are stranded? No one's: a crash after the post and before the row records
//! it leaves the row `submitted`, and the retry finds the post by its key before posting; an answer the rail never gave
//! leaves the row `submitted` with its post, and the retry submits the same payment id again.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use service_kit::edge::Principal;
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::schema::{Value, js_trim};
use service_kit::time::{Instant, js_date, zod_datetime};
use service_kit::trpc::TrpcError;

use super::Deps;
use crate::door::Ctx;
use crate::errors::Refusal;
use crate::spaces::ports::{LedgerAccount, LedgerTx, PostFailure};
use crate::spaces::space::{self, Space, at, pg, with};
use crate::transfers::calendar::{self, Cadence};
use crate::transfers::moves::{post_bank_transfer, resolve_for_debit};
use crate::transfers::step_up::{self, Binding};

/// `PSP_BLOCKER`.
pub const PSP_BLOCKER: &str = "socket.psp-partners";

const STATUSES: [&str; 5] = ["submitted", "accepted", "paid", "failed", "returned"];

/// `TERMINAL_BILL`: an occurrence refused by one of these is recorded fired; any other is retried on the next pass.
const TERMINAL: [&str; 4] = [
    "bank.bills_psp_unset",
    "bank.bills_rail_refused",
    "bank.bills_insufficient_funds",
    "bank.bills_rail_unusable",
];

// ---------------------------------------------------------------------------------------------------------------
// The partner ports (`ports.ts`). Unset is `None`: never a catalogue, an amount due or a rail.

/// `Biller`, as the directory answered it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Biller {
    pub id: String,
    pub name: String,
    pub country: String,
    pub category: String,
}

/// `BillLookup`, as the lookup answered it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lookup {
    pub amount_due: String,
    pub due_date: String,
    pub payee_name: String,
    pub currency: String,
}

/// `BillRailAnswer`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RailAnswer {
    /// `{ ok: true, providerRef, status }`: `status` as the rail sent it, checked here.
    Taken {
        provider_ref: Option<String>,
        status: String,
    },
    /// `{ ok: false }`.
    Refused,
}

/// `submit`'s input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Submit {
    pub payment_id: String,
    pub idempotency_key: String,
    pub biller_id: String,
    pub reference: String,
    pub amount: String,
    pub asset_id: String,
}

/// `BillerDirectoryPort`, live. An `Err` is a throw.
pub trait Directory: Send + Sync {
    fn search(&self, query: &str, country: Option<&str>) -> Result<Vec<Biller>, String>;
}

/// `BillLookupPort`, live.
pub trait LookupPort: Send + Sync {
    fn lookup(&self, biller_id: &str, reference: &str) -> Result<Option<Lookup>, String>;
}

/// `BillPayRailPort`, live.
pub trait Rail: Send + Sync {
    /// `railId()`: the ledger boundary's rail id. Never a made-up partner name.
    fn rail_id(&self) -> String;
    fn submit(&self, input: &Submit) -> Result<RailAnswer, String>;
}

/// What the binary hands this part: `BillPorts`. `index.ts` hands none, so every port is unset (`emptyBillPorts`).
#[derive(Default)]
pub struct Wiring {
    pub directory: Option<Box<dyn Directory>>,
    pub lookup: Option<Box<dyn LookupPort>>,
    pub rail: Option<Box<dyn Rail>>,
}

impl Wiring {
    pub fn none() -> Wiring {
        Wiring::default()
    }

    /// `bills.railStatus() === 'live'`.
    pub fn rail_live(&self) -> bool {
        self.rail.is_some()
    }
}

fn status_word(live: bool) -> &'static str {
    if live { "live" } else { "unset" }
}

// ---------------------------------------------------------------------------------------------------------------
// Refusals (`errors.ts`): a `PersonalPayError` is the bills router's `TRPCError` with `<sentence> (<code>)`.

fn copy(code: &str) -> (&'static str, &'static str, Option<&'static str>) {
    match code {
        "bank.bills_directory_unset" => (
            "PRECONDITION_FAILED",
            "Biller search is socket.psp-partners. No directory was queried and no biller was invented.",
            Some(PSP_BLOCKER),
        ),
        "bank.bills_lookup_unset" => (
            "PRECONDITION_FAILED",
            "Bill lookup is socket.psp-partners. No amount due, due date or payee name is invented.",
            Some(PSP_BLOCKER),
        ),
        "bank.bills_psp_unset" => (
            "PRECONDITION_FAILED",
            "Bill pay is socket.psp-partners — a bank/PSP partner and money-transmission permission, not inventable code. Nothing was posted.",
            Some(PSP_BLOCKER),
        ),
        "bank.bills_rail_refused" => (
            "PRECONDITION_FAILED",
            "The bill-pay rail refused this payment. Nothing remains posted.",
            Some(PSP_BLOCKER),
        ),
        "bank.bills_directory_unusable"
        | "bank.bills_lookup_unusable"
        | "bank.bills_rail_unusable" => (
            "SERVICE_UNAVAILABLE",
            "The bill-pay provider answered in a shape this service will not coerce into a biller, an amount due or a payment.",
            Some(PSP_BLOCKER),
        ),
        "bank.bills_outcome_unknown" => (
            "SERVICE_UNAVAILABLE",
            "Bill pay did not get a definite answer from the rail. Retry the same idempotency key. Do not start a second payment.",
            Some(PSP_BLOCKER),
        ),
        "bank.bills_reference_unknown" => (
            "NOT_FOUND",
            "This biller does not have that reference.",
            None,
        ),
        "bank.bills_conflict" => (
            "CONFLICT",
            "This idempotency key was already used for a different bill payment.",
            None,
        ),
        "bank.bills_not_found" | "bank.bill_recurring_not_found" => {
            ("NOT_FOUND", "No such bill.", None)
        }
        "bank.bills_space_not_found" => ("NOT_FOUND", "No such space.", None),
        "bank.bills_list_limit_unset" => (
            "BAD_REQUEST",
            "Page size was omitted. Blank is not a default page. Pass a limit.",
            None,
        ),
        "bank.bills_cursor_invalid" => ("BAD_REQUEST", "That bills cursor cannot be read.", None),
        "bank.bill_recurring_inactive" => (
            "PRECONDITION_FAILED",
            "This recurring bill is not active.",
            None,
        ),
        "bank.bills_insufficient_funds" => ("BAD_REQUEST", "Insufficient funds", None),
        "bank.personal_pay_request_invalid" => (
            "BAD_REQUEST",
            "That bill or send request is not usable.",
            None,
        ),
        _ => (
            "SERVICE_UNAVAILABLE",
            "Personal pay could not complete.",
            None,
        ),
    }
}

/// `personalPayError(code, detail)` as the bills router's guard sends it.
pub fn refusal(code: &str, detail: Option<&str>) -> Refusal {
    let (http, sentence, _) = copy(code);
    let message = detail.unwrap_or(sentence);
    Refusal::Trpc(TrpcError::caused(http, format!("{message} ({code})"), code))
}

fn pp(code: &str) -> Refusal {
    refusal(code, None)
}

/// The code a refusal carries, as `runDue` reads `err.code`; none for a failure with no code.
fn code_of(r: &Refusal) -> Option<&str> {
    match r {
        Refusal::Trpc(e) => e.cause.as_deref(),
        Refusal::Bank(e) => Some(e.row.code),
        Refusal::Other(_) => None,
    }
}

/// The bills router's `guard`: a refusal already decided passes; a space that is archived or locked and a step-up
/// refusal are 412 with their code; anything else is the opaque 500, its code (when it has one) as the cause.
pub fn guard(r: Refusal) -> TrpcError {
    match r {
        Refusal::Trpc(e) => e,
        Refusal::Bank(e)
            if e.row.code == "bank.space_archived"
                || e.row.code == "bank.space_locked"
                || e.row.code.starts_with("bank.step_up_") =>
        {
            TrpcError::caused(
                "PRECONDITION_FAILED",
                format!("{} ({})", e.message, e.row.code),
                e.row.code,
            )
        }
        Refusal::Bank(e) => {
            TrpcError::caused("INTERNAL_SERVER_ERROR", "Bank operation failed", e.row.code)
        }
        Refusal::Other(_) => TrpcError::plain("INTERNAL_SERVER_ERROR", "Bank operation failed"),
    }
}

/// A failed post as the TypeScript ledger client throws it, for the guard: a `LedgerError` keeps its code.
fn post_failed(f: &PostFailure) -> Refusal {
    match f.code() {
        Some(code) => Refusal::Trpc(TrpcError::caused(
            "INTERNAL_SERVER_ERROR",
            "Bank operation failed",
            code.to_owned(),
        )),
        None => Refusal::Other(format!("svc-ledger post failed: {}", f.message())),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Rows and views.

/// `BillView`, with whose it is for the founder's reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bill {
    pub id: String,
    pub user_id: String,
    pub idempotency_key: String,
    pub biller_id: String,
    pub reference: String,
    pub amount: String,
    pub asset_id: String,
    pub from_space_id: String,
    pub status: String,
    pub failure_code: Option<String>,
    pub failure_blocker: Option<String>,
    pub provider_ref: Option<String>,
    pub ledger_tx_id: Option<String>,
    pub created_at: Instant,
    pub updated_at: Instant,
}

impl Bill {
    /// `viewOf`.
    pub fn json(&self) -> Json {
        Json::Object(self.fields())
    }

    /// `{ ...viewOf(row), userId }`.
    pub fn ops_json(&self) -> Json {
        let mut f = self.fields();
        f.push(("userId".to_owned(), Json::str(self.user_id.clone())));
        Json::Object(f)
    }

    fn fields(&self) -> Vec<(String, Json)> {
        let opt = |v: &Option<String>| v.clone().map_or(Json::Null, Json::str);
        vec![
            ("id".to_owned(), Json::str(self.id.clone())),
            ("billerId".to_owned(), Json::str(self.biller_id.clone())),
            ("reference".to_owned(), Json::str(self.reference.clone())),
            ("amount".to_owned(), Json::str(self.amount.clone())),
            ("assetId".to_owned(), Json::str(self.asset_id.clone())),
            (
                "fromSpaceId".to_owned(),
                Json::str(self.from_space_id.clone()),
            ),
            ("status".to_owned(), Json::str(self.status.clone())),
            ("failureCode".to_owned(), opt(&self.failure_code)),
            ("failureBlocker".to_owned(), opt(&self.failure_blocker)),
            ("providerRef".to_owned(), opt(&self.provider_ref)),
            ("ledgerTxId".to_owned(), opt(&self.ledger_tx_id)),
            ("createdAt".to_owned(), Json::str(self.created_at.iso())),
            ("updatedAt".to_owned(), Json::str(self.updated_at.iso())),
        ]
    }
}

fn ms(col: &str) -> String {
    format!("floor(extract(epoch from {col}) * 1000)::int8")
}

fn bill_cols() -> String {
    format!(
        "id::text, user_id, idempotency_key, biller_id, reference, amount, asset_id, from_space_id::text, status, \
         failure_code, failure_blocker, provider_ref, ledger_tx_id, {}, {}",
        ms("created_at"),
        ms("updated_at")
    )
}

fn bill_row(r: &postgres::Row) -> Result<Bill, Refusal> {
    Ok(Bill {
        id: r.try_get(0).map_err(|e| pg(&e))?,
        user_id: r.try_get(1).map_err(|e| pg(&e))?,
        idempotency_key: r.try_get(2).map_err(|e| pg(&e))?,
        biller_id: r.try_get(3).map_err(|e| pg(&e))?,
        reference: r.try_get(4).map_err(|e| pg(&e))?,
        amount: r.try_get(5).map_err(|e| pg(&e))?,
        asset_id: r.try_get(6).map_err(|e| pg(&e))?,
        from_space_id: r.try_get(7).map_err(|e| pg(&e))?,
        status: r.try_get(8).map_err(|e| pg(&e))?,
        failure_code: r.try_get(9).map_err(|e| pg(&e))?,
        failure_blocker: r.try_get(10).map_err(|e| pg(&e))?,
        provider_ref: r.try_get(11).map_err(|e| pg(&e))?,
        ledger_tx_id: r.try_get(12).map_err(|e| pg(&e))?,
        created_at: Instant(r.try_get(13).map_err(|e| pg(&e))?),
        updated_at: Instant(r.try_get(14).map_err(|e| pg(&e))?),
    })
}

/// `RecurringView`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recurring {
    pub id: String,
    pub user_id: String,
    pub idempotency_key: String,
    pub biller_id: String,
    pub reference: String,
    pub amount: String,
    pub asset_id: String,
    pub from_space_id: String,
    pub cadence: String,
    pub status: String,
    pub starts_at: Instant,
    pub ends_at: Option<Instant>,
    pub next_run_at: Instant,
}

impl Recurring {
    pub fn json(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("billerId", Json::str(self.biller_id.clone())),
            ("reference", Json::str(self.reference.clone())),
            ("amount", Json::str(self.amount.clone())),
            ("assetId", Json::str(self.asset_id.clone())),
            ("fromSpaceId", Json::str(self.from_space_id.clone())),
            ("cadence", Json::str(self.cadence.clone())),
            ("status", Json::str(self.status.clone())),
            ("startsAt", Json::str(self.starts_at.iso())),
            (
                "endsAt",
                self.ends_at.map_or(Json::Null, |t| Json::str(t.iso())),
            ),
            ("nextRunAt", Json::str(self.next_run_at.iso())),
        ])
    }

    fn cadence(&self) -> Result<Cadence, Refusal> {
        Cadence::parse(&self.cadence)
            .ok_or_else(|| Refusal::Other(format!("cadence {}", self.cadence)))
    }
}

fn recurring_cols() -> String {
    format!(
        "id::text, user_id, idempotency_key, biller_id, reference, amount, asset_id, from_space_id::text, cadence, \
         status, {}, {}, {}",
        ms("starts_at"),
        ms("ends_at"),
        ms("next_run_at")
    )
}

fn recurring_row(r: &postgres::Row) -> Result<Recurring, Refusal> {
    Ok(Recurring {
        id: r.try_get(0).map_err(|e| pg(&e))?,
        user_id: r.try_get(1).map_err(|e| pg(&e))?,
        idempotency_key: r.try_get(2).map_err(|e| pg(&e))?,
        biller_id: r.try_get(3).map_err(|e| pg(&e))?,
        reference: r.try_get(4).map_err(|e| pg(&e))?,
        amount: r.try_get(5).map_err(|e| pg(&e))?,
        asset_id: r.try_get(6).map_err(|e| pg(&e))?,
        from_space_id: r.try_get(7).map_err(|e| pg(&e))?,
        cadence: r.try_get(8).map_err(|e| pg(&e))?,
        status: r.try_get(9).map_err(|e| pg(&e))?,
        starts_at: Instant(r.try_get(10).map_err(|e| pg(&e))?),
        ends_at: r
            .try_get::<_, Option<i64>>(11)
            .map_err(|e| pg(&e))?
            .map(Instant),
        next_run_at: Instant(r.try_get(12).map_err(|e| pg(&e))?),
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Checks on what the customer and the partner send.

/// `canonical`: an amount above zero, in the ledger's canonical text.
fn canonical(raw: &str) -> Result<(String, Amount), Refusal> {
    let amount = parse_amount(raw).map_err(|_| pp("bank.personal_pay_request_invalid"))?;
    if amount <= 0 {
        return Err(pp("bank.personal_pay_request_invalid"));
    }
    Ok((format_amount(amount), amount))
}

fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `requireText`.
fn require_text(value: &str, max: usize, code: &str) -> Result<String, Refusal> {
    let t = js_trim(value);
    if t.is_empty() || js_len(t) > max {
        return Err(pp(code));
    }
    Ok(t.to_owned())
}

fn upper_letters(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_uppercase())
}

/// `usableBiller`.
fn usable_biller(row: &Biller) -> Result<Json, Refusal> {
    const U: &str = "bank.bills_directory_unusable";
    let id = require_text(&row.id, 64, U)?;
    let name = require_text(&row.name, 140, U)?;
    let category = require_text(&row.category, 64, U)?;
    let country = js_trim(&row.country).to_uppercase();
    if !upper_letters(&country, 2, 2) {
        return Err(pp(U));
    }
    Ok(Json::obj([
        ("id", Json::str(id)),
        ("name", Json::str(name)),
        ("country", Json::str(country)),
        ("category", Json::str(category)),
    ]))
}

/// `^\d+(\.\d{1,18})?$`.
pub fn is_amount_text(s: &str) -> bool {
    let (whole, frac) = match s.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (s, None),
    };
    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && frac.is_none_or(|f| (1..=18).contains(&f.len()) && f.bytes().all(|b| b.is_ascii_digit()))
}

/// `usableLookup`.
fn usable_lookup(row: &Lookup) -> Result<Json, Refusal> {
    const U: &str = "bank.bills_lookup_unusable";
    if !is_amount_text(&row.amount_due) {
        return Err(pp(U));
    }
    let amount = parse_amount(&row.amount_due).map_err(|_| pp(U))?;
    if amount <= 0 {
        return Err(pp(U));
    }
    let d = row.due_date.as_bytes();
    let shaped = d.len() == 10
        && d.iter().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                *b == b'-'
            } else {
                b.is_ascii_digit()
            }
        });
    if !shaped || js_date(&format!("{}T00:00:00Z", row.due_date)).is_none() {
        return Err(pp(U));
    }
    let payee_name = require_text(&row.payee_name, 140, U)?;
    let currency = js_trim(&row.currency).to_uppercase();
    if !(3..=8).contains(&currency.len())
        || !currency
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    {
        return Err(pp(U));
    }
    Ok(Json::obj([
        ("amountDue", Json::str(row.amount_due.clone())),
        ("dueDate", Json::str(row.due_date.clone())),
        ("payeeName", Json::str(payee_name)),
        ("currency", Json::str(currency)),
    ]))
}

fn encode_cursor(created_at: Instant, id: &str) -> String {
    URL_SAFE_NO_PAD.encode(format!("{}|{id}", created_at.iso()))
}

/// `decodeCursor`: `<iso>|<uuid>`, or `bank.bills_cursor_invalid`.
fn decode_cursor(cursor: &str) -> Result<(Instant, String), Refusal> {
    let text = String::from_utf8_lossy(&crate::activity::feed::cursor::b64url_lenient(cursor))
        .into_owned();
    let (at, id) = match text.rfind('|') {
        Some(p) if p > 0 => (&text[..p], &text[p + 1..]),
        _ => ("", ""),
    };
    let uuid = id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        });
    match js_date(at) {
        Some(t) if uuid => Ok((t, id.to_ascii_lowercase())),
        _ => Err(pp("bank.bills_cursor_invalid")),
    }
}

fn limit_of(input: &Value) -> Result<i64, Refusal> {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "a whole number 1..100 the schema checked"
    )]
    input
        .get("limit")
        .as_number()
        .map(|n| n as i64)
        .ok_or_else(|| pp("bank.bills_list_limit_unset"))
}

// ---------------------------------------------------------------------------------------------------------------
// The service (`BillPayService`).

/// `search`.
pub fn search(d: &Deps<'_>, query: &str, country: Option<&str>) -> Result<Json, Refusal> {
    let Some(directory) = d.w.pay.directory.as_ref() else {
        return Err(pp("bank.bills_directory_unset"));
    };
    let query = require_text(query, 64, "bank.personal_pay_request_invalid")?;
    let country = country.map(|c| js_trim(c).to_uppercase());
    if let Some(c) = &country
        && !upper_letters(c, 2, 2)
    {
        return Err(pp("bank.bills_directory_unusable"));
    }
    let rows = directory
        .search(&query, country.as_deref().filter(|c| !c.is_empty()))
        .map_err(Refusal::Other)?;
    Ok(Json::Array(
        rows.iter().map(usable_biller).collect::<Result<_, _>>()?,
    ))
}

/// `lookup`.
pub fn lookup(d: &Deps<'_>, biller_id: &str, reference: &str) -> Result<Json, Refusal> {
    let Some(port) = d.w.pay.lookup.as_ref() else {
        return Err(pp("bank.bills_lookup_unset"));
    };
    let biller_id = require_text(biller_id, 64, "bank.bills_lookup_unusable")?;
    let reference = require_text(reference, 64, "bank.bills_lookup_unusable")?;
    match port
        .lookup(&biller_id, &reference)
        .map_err(Refusal::Other)?
    {
        None => Err(pp("bank.bills_reference_unknown")),
        Some(found) => usable_lookup(&found),
    }
}

/// What a person asks to pay (`pay`'s input).
#[derive(Debug, Clone)]
pub struct PayAsk<'a> {
    pub user_id: &'a str,
    pub idempotency_key: &'a str,
    pub biller_id: &'a str,
    pub reference: &'a str,
    pub amount: &'a str,
    pub from_space_id: &'a str,
}

/// The router's `ownedSpace`: the person's own space, else `bank.bills_space_not_found`.
fn owned_space_plain(d: &Deps<'_>, user_id: &str, space_id: &str) -> Result<Space, Refusal> {
    let found = with(d.store(), |c| space::find(c, space_id))?;
    match found {
        Some(s) if s.user_id == user_id => Ok(s),
        _ => Err(pp("bank.bills_space_not_found")),
    }
}

/// The service's `ownedSpace`: the person's own space that may be debited now.
fn owned_space(
    d: &Deps<'_>,
    user_id: &str,
    space_id: &str,
    now: Instant,
) -> Result<Space, Refusal> {
    owned_space_plain(d, user_id, space_id)?;
    with(d.store(), |c| resolve_for_debit(c, space_id, now))
}

/// `pay`.
pub fn pay(d: &Deps<'_>, ask: &PayAsk<'_>, now: Instant) -> Result<Bill, Refusal> {
    let key = require_text(
        ask.idempotency_key,
        128,
        "bank.personal_pay_request_invalid",
    )?;
    if js_len(&key) < 8 {
        return Err(pp("bank.personal_pay_request_invalid"));
    }
    let biller_id = require_text(ask.biller_id, 64, "bank.personal_pay_request_invalid")?;
    let reference = require_text(ask.reference, 64, "bank.personal_pay_request_invalid")?;
    let (text, amount) = canonical(ask.amount)?;
    let space = owned_space(d, ask.user_id, ask.from_space_id, now)?;
    let row = instruction(d, ask.user_id, &key, &biller_id, &reference, &text, &space)?;
    drive(d, &row, &space, amount)
}

/// `instruction`: the original instruction under (person, key); the same key with other terms refuses.
fn instruction(
    d: &Deps<'_>,
    user_id: &str,
    key: &str,
    biller_id: &str,
    reference: &str,
    amount: &str,
    space: &Space,
) -> Result<Bill, Refusal> {
    let id = service_kit::approvals::random_uuid().map_err(Refusal::Other)?;
    with(d.store(), |c| {
        c.execute(
            "INSERT INTO bank.bill_payments \
               (id, user_id, idempotency_key, biller_id, reference, amount, asset_id, from_space_id, status) \
             VALUES ($1::text::uuid, $2, $3, $4, $5, $6, $7, $8::text::uuid, 'submitted') \
             ON CONFLICT (user_id, idempotency_key) DO NOTHING",
            &[&id, &user_id, &key, &biller_id, &reference, &amount, &space.asset_id, &space.id],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })?;
    let row = payment_by_key(d, user_id, key)?.ok_or_else(|| pp("bank.bills_outcome_unknown"))?;
    if row.biller_id != biller_id
        || row.reference != reference
        || row.amount != amount
        || row.asset_id != space.asset_id
        || row.from_space_id != space.id
    {
        return Err(pp("bank.bills_conflict"));
    }
    Ok(row)
}

/// `railBoundary(rail, asset)`.
fn rail_boundary(rail_id: &str, asset_id: &str) -> LedgerAccount {
    LedgerAccount {
        owner_type: "treasury",
        owner_id: format!("rail:{rail_id}"),
        asset_id: asset_id.to_owned(),
        kind: "available",
        purpose: None,
    }
}

/// `forwardKey`: `bank.transfer.rail:<paymentId>:0`.
pub fn forward_key(payment_id: &str) -> String {
    crate::transfers::moves::bank_transfer_key("rail", payment_id, 0)
}

/// `custodyGuardedLedger`: with the custodial layer off no customer balance is posted from here.
fn custody_guard(d: &Deps<'_>) -> Result<(), Refusal> {
    if d.t.partner.custody_layer != "on" {
        return Err(crate::partner::refuse(
            "bank.no_partner_bank",
            "No banking partner holds this money, and INTAFACED holds no customer money, so nothing was moved.",
        ));
    }
    Ok(())
}

/// `postToRail` (occurrence 0) and `reverseFromRail` (occurrence 1).
fn post_rail(
    d: &Deps<'_>,
    payment_id: &str,
    occurrence: i64,
    account: &LedgerAccount,
    rail_id: &str,
    amount: Amount,
) -> Result<LedgerTx, PostFailure> {
    let boundary = rail_boundary(rail_id, &account.asset_id);
    let (from, to) = if occurrence == 0 {
        (account, &boundary)
    } else {
        (&boundary, account)
    };
    post_bank_transfer(d.t, payment_id, occurrence, from, to, amount, "rail")
}

/// `drive`: the instruction to its end, or a refusal that says what is left.
fn drive(d: &Deps<'_>, row: &Bill, space: &Space, amount: Amount) -> Result<Bill, Refusal> {
    match row.status.as_str() {
        "failed" => {
            return Err(pp(row
                .failure_code
                .as_deref()
                .unwrap_or("bank.bills_psp_unset")));
        }
        "accepted" | "paid" | "returned" => return Ok(row.clone()),
        _ => {}
    }
    let Some(rail) = d.w.pay.rail.as_ref() else {
        if row.ledger_tx_id.is_some() {
            return Err(pp("bank.bills_outcome_unknown"));
        }
        fail(d, &row.id, "bank.bills_psp_unset")?;
        return Err(pp("bank.bills_psp_unset"));
    };
    let rail_id = js_trim(&rail.rail_id()).to_owned();
    if rail_id.is_empty() || js_len(&rail_id) > 64 {
        if must(d, &row.id)?.ledger_tx_id.is_some() {
            return Err(pp("bank.bills_outcome_unknown"));
        }
        fail(d, &row.id, "bank.bills_rail_unusable")?;
        return Err(pp("bank.bills_rail_unusable"));
    }
    let account = space.ledger_account();
    let tx_id = match &row.ledger_tx_id {
        Some(id) => id.clone(),
        None => {
            let existing =
                d.t.ledger
                    .tx_by_key(&forward_key(&row.id))
                    .map_err(Refusal::Other)?;
            let tx = match existing {
                Some(tx) => tx,
                None => {
                    custody_guard(d)?;
                    match post_rail(d, &row.id, 0, &account, &rail_id, amount) {
                        Ok(tx) => tx,
                        Err(f) if f.insufficient() => {
                            fail(d, &row.id, "bank.bills_insufficient_funds")?;
                            return Err(refusal(
                                "bank.bills_insufficient_funds",
                                Some(f.message()),
                            ));
                        }
                        Err(f) => return Err(post_failed(&f)),
                    }
                }
            };
            with(d.store(), |c| {
                c.execute(
                    "UPDATE bank.bill_payments SET ledger_tx_id = $2, updated_at = now() \
                      WHERE id = $1::text::uuid AND status = 'submitted' AND ledger_tx_id IS NULL",
                    &[&row.id, &tx.id],
                )
                .map_err(|e| pg(&e))
            })?;
            tx.id
        }
    };
    let answer = rail
        .submit(&Submit {
            payment_id: row.id.clone(),
            idempotency_key: row.idempotency_key.clone(),
            biller_id: row.biller_id.clone(),
            reference: row.reference.clone(),
            amount: row.amount.clone(),
            asset_id: row.asset_id.clone(),
        })
        .map_err(|_| pp("bank.bills_outcome_unknown"))?;
    let (provider_ref, status) = match answer {
        RailAnswer::Refused => {
            custody_guard(d).map_err(|_| pp("bank.bills_outcome_unknown"))?;
            post_rail(d, &row.id, 1, &account, &rail_id, amount)
                .map_err(|_| pp("bank.bills_outcome_unknown"))?;
            fail(d, &row.id, "bank.bills_rail_refused")?;
            return Err(pp("bank.bills_rail_refused"));
        }
        RailAnswer::Taken {
            provider_ref,
            status,
        } => (
            provider_ref
                .map(|r| js_trim(&r).to_owned())
                .unwrap_or_default(),
            status,
        ),
    };
    if (status != "accepted" && status != "paid")
        || provider_ref.is_empty()
        || js_len(&provider_ref) > 128
    {
        return Err(pp("bank.bills_outcome_unknown"));
    }
    with(d.store(), |c| {
        c.execute(
            "UPDATE bank.bill_payments \
                SET status = $2, provider_ref = $3, ledger_tx_id = $4, failure_code = NULL, failure_blocker = NULL, \
                    updated_at = now() \
              WHERE id = $1::text::uuid AND status = 'submitted'",
            &[&row.id, &status, &provider_ref, &tx_id],
        )
        .map_err(|e| pg(&e))
    })?;
    must(d, &row.id)
}

/// `fail`: the instruction ends failed with nothing posted.
fn fail(d: &Deps<'_>, id: &str, code: &str) -> Result<(), Refusal> {
    let blocker = copy(code).2;
    with(d.store(), |c| {
        c.execute(
            "UPDATE bank.bill_payments \
                SET status = 'failed', failure_code = $2, failure_blocker = $3, ledger_tx_id = NULL, updated_at = now() \
              WHERE id = $1::text::uuid AND status = 'submitted'",
            &[&id, &code, &blocker],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })
}

fn payment_by_key(d: &Deps<'_>, user_id: &str, key: &str) -> Result<Option<Bill>, Refusal> {
    with(d.store(), |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.bill_payments WHERE user_id = $1 AND idempotency_key = $2",
                    bill_cols()
                ),
                &[&user_id, &key],
            )
            .map_err(|e| pg(&e))?;
        rows.first().map(bill_row).transpose()
    })
}

fn must(d: &Deps<'_>, id: &str) -> Result<Bill, Refusal> {
    with(d.store(), |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.bill_payments WHERE id = $1::text::uuid",
                    bill_cols()
                ),
                &[&id],
            )
            .map_err(|e| pg(&e))?;
        rows.first().map(bill_row).transpose()
    })?
    .ok_or_else(|| pp("bank.bills_not_found"))
}

/// One page, newest first, of the rows `filter` (a SQL condition on `$1`, `$2`) keeps.
fn page(
    d: &Deps<'_>,
    filter: &str,
    first: &str,
    second: Option<&str>,
    limit: i64,
    cursor: Option<&str>,
) -> Result<(Vec<Bill>, Option<String>), Refusal> {
    let cursor = cursor.map(decode_cursor).transpose()?;
    let rows = with(d.store(), |c| {
        let after = cursor.as_ref().map(|(t, _)| t.0);
        let after_id = cursor.as_ref().map(|(_, id)| id.as_str());
        c.query(
            &format!(
                "SELECT {} FROM bank.bill_payments \
                  WHERE {filter} \
                    AND ($3::int8 IS NULL OR (created_at, id) < ({}, $4::text::uuid)) \
                  ORDER BY created_at DESC, id DESC LIMIT $5",
                bill_cols(),
                at("$3")
            ),
            &[&first, &second, &after, &after_id, &(limit + 1)],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(bill_row)
        .collect::<Result<Vec<_>, _>>()
    })?;
    let more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > limit;
    let mut items = rows;
    items.truncate(usize::try_from(limit).unwrap_or(0));
    let next = if more {
        items.last().map(|b| encode_cursor(b.created_at, &b.id))
    } else {
        None
    };
    Ok((items, next))
}

/// `list`.
pub fn list(
    d: &Deps<'_>,
    user_id: &str,
    limit: i64,
    status: Option<&str>,
    cursor: Option<&str>,
) -> Result<(Vec<Bill>, Option<String>), Refusal> {
    page(
        d,
        "user_id = $1 AND ($2::text IS NULL OR status = $2)",
        user_id,
        status,
        limit,
        cursor,
    )
}

/// `get`: the person's own bill.
pub fn get(d: &Deps<'_>, user_id: &str, id: &str) -> Result<Bill, Refusal> {
    with(d.store(), |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.bill_payments WHERE id = $1::text::uuid AND user_id = $2",
                    bill_cols()
                ),
                &[&id, &user_id],
            )
            .map_err(|e| pg(&e))?;
        rows.first().map(bill_row).transpose()
    })?
    .ok_or_else(|| pp("bank.bills_not_found"))
}

/// What a person asks to recur (`createRecurring`'s input).
#[derive(Debug, Clone)]
pub struct RecurringAsk<'a> {
    pub user_id: &'a str,
    pub idempotency_key: &'a str,
    pub biller_id: &'a str,
    pub reference: &'a str,
    pub amount: &'a str,
    pub from_space_id: &'a str,
    pub cadence: &'a str,
    pub starts_at: Instant,
    pub ends_at: Option<Instant>,
}

/// `createRecurring`: refused until the pay rail is live.
pub fn create_recurring(
    d: &Deps<'_>,
    ask: &RecurringAsk<'_>,
    now: Instant,
) -> Result<Recurring, Refusal> {
    if !d.w.pay.rail_live() {
        return Err(pp("bank.bills_psp_unset"));
    }
    let key = require_text(
        ask.idempotency_key,
        128,
        "bank.personal_pay_request_invalid",
    )?;
    if js_len(&key) < 8 {
        return Err(pp("bank.personal_pay_request_invalid"));
    }
    let biller_id = require_text(ask.biller_id, 64, "bank.personal_pay_request_invalid")?;
    let reference = require_text(ask.reference, 64, "bank.personal_pay_request_invalid")?;
    let (text, _) = canonical(ask.amount)?;
    let space = owned_space(d, ask.user_id, ask.from_space_id, now)?;
    if ask.ends_at.is_some_and(|e| e.0 <= ask.starts_at.0) {
        return Err(pp("bank.bill_recurring_inactive"));
    }
    let id = service_kit::approvals::random_uuid().map_err(Refusal::Other)?;
    with(d.store(), |c| {
        c.execute(
            &format!(
                "INSERT INTO bank.bill_recurring ( \
                   id, user_id, idempotency_key, biller_id, reference, amount, asset_id, from_space_id, \
                   cadence, status, starts_at, ends_at, next_run_at \
                 ) VALUES ($1::text::uuid, $2, $3, $4, $5, $6, $7, $8::text::uuid, $9, 'active', {}, {}, {}) \
                 ON CONFLICT (user_id, idempotency_key) DO NOTHING",
                at("$10"),
                at("$11"),
                at("$10")
            ),
            &[
                &id,
                &ask.user_id,
                &key,
                &biller_id,
                &reference,
                &text,
                &space.asset_id,
                &space.id,
                &ask.cadence,
                &ask.starts_at.0,
                &ask.ends_at.map(|t| t.0),
            ],
        )
        .map_err(|e| pg(&e))
    })?;
    let row = recurring_by_key(d, ask.user_id, &key)?;
    if row.biller_id != biller_id
        || row.reference != reference
        || row.amount != text
        || row.from_space_id != space.id
        || row.asset_id != space.asset_id
        || row.cadence != ask.cadence
        || row.starts_at != ask.starts_at
    {
        return Err(pp("bank.bills_conflict"));
    }
    Ok(row)
}

fn one_recurring(d: &Deps<'_>, cond: &str, a: &str, b: &str) -> Result<Recurring, Refusal> {
    with(d.store(), |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.bill_recurring WHERE {cond}",
                    recurring_cols()
                ),
                &[&a, &b],
            )
            .map_err(|e| pg(&e))?;
        rows.first().map(recurring_row).transpose()
    })?
    .ok_or_else(|| pp("bank.bill_recurring_not_found"))
}

fn owned_recurring(d: &Deps<'_>, user_id: &str, id: &str) -> Result<Recurring, Refusal> {
    one_recurring(d, "id = $1::text::uuid AND user_id = $2", id, user_id)
}

fn recurring_by_key(d: &Deps<'_>, user_id: &str, key: &str) -> Result<Recurring, Refusal> {
    one_recurring(d, "user_id = $1 AND idempotency_key = $2", user_id, key)
}

/// `pauseRecurring`.
pub fn pause_recurring(d: &Deps<'_>, user_id: &str, id: &str) -> Result<Recurring, Refusal> {
    let row = owned_recurring(d, user_id, id)?;
    if row.status == "paused" {
        return Ok(row);
    }
    if row.status != "active" {
        return Err(pp("bank.bill_recurring_inactive"));
    }
    with(d.store(), |c| {
        c.execute(
            "UPDATE bank.bill_recurring SET status = 'paused' \
              WHERE id = $1::text::uuid AND user_id = $2 AND status = 'active'",
            &[&id, &user_id],
        )
        .map_err(|e| pg(&e))
    })?;
    owned_recurring(d, user_id, id)
}

/// `cancelRecurring`.
pub fn cancel_recurring(d: &Deps<'_>, user_id: &str, id: &str) -> Result<Recurring, Refusal> {
    let row = owned_recurring(d, user_id, id)?;
    if row.status == "cancelled" || row.status == "completed" {
        return Ok(row);
    }
    if row.status != "active" && row.status != "paused" {
        return Err(pp("bank.bill_recurring_inactive"));
    }
    with(d.store(), |c| {
        c.execute(
            "UPDATE bank.bill_recurring SET status = 'cancelled' \
              WHERE id = $1::text::uuid AND user_id = $2 AND status IN ('active', 'paused')",
            &[&id, &user_id],
        )
        .map_err(|e| pg(&e))
    })?;
    owned_recurring(d, user_id, id)
}

/// `listRecurring`: the person's recurring bills, newest first.
pub fn list_recurring(d: &Deps<'_>, user_id: &str, limit: i64) -> Result<Vec<Recurring>, Refusal> {
    with(d.store(), |c| {
        c.query(
            &format!(
                "SELECT {} FROM bank.bill_recurring WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2",
                recurring_cols()
            ),
            &[&user_id, &limit],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(recurring_row)
        .collect()
    })
}

/// `runDue`'s answer.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunReport {
    pub considered: i64,
    pub settled: i64,
    pub refused: i64,
    pub failures: Vec<(String, String)>,
}

impl RunReport {
    pub fn json(&self) -> Json {
        Json::obj([
            ("considered", Json::int(self.considered)),
            ("settled", Json::int(self.settled)),
            ("refused", Json::int(self.refused)),
            (
                "failures",
                Json::Array(
                    self.failures
                        .iter()
                        .map(|(s, c)| {
                            Json::obj([
                                ("scheduleId", Json::str(s.clone())),
                                ("code", Json::str(c.clone())),
                            ])
                        })
                        .collect(),
                ),
            ),
        ])
    }
}

fn record_firing(
    d: &Deps<'_>,
    schedule_id: &str,
    occurrence: i64,
    payment_id: &str,
) -> Result<(), Refusal> {
    let n = i32::try_from(occurrence)
        .map_err(|_| Refusal::Other(format!("occurrence {occurrence}")))?;
    with(d.store(), |c| {
        c.execute(
            "INSERT INTO bank.bill_recurring_firings (schedule_id, occurrence, payment_id) \
             VALUES ($1::text::uuid, $2, $3::text::uuid) ON CONFLICT (schedule_id, occurrence) DO NOTHING",
            &[&schedule_id, &n, &payment_id],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })
}

/// `runDue`: fire due recurring bills, each occurrence one payment under `bill-recur:<schedule>:<n>`, so a second pass
/// posts nothing again. An occurrence whose outcome is unknown gets no firing row: the schedule stays due there.
pub fn run_due(d: &Deps<'_>, limit: f64, now: Instant) -> Result<RunReport, Refusal> {
    if limit.fract() != 0.0 || !(1.0..=50.0).contains(&limit) {
        return Err(pp("bank.bills_list_limit_unset"));
    }
    #[allow(clippy::cast_possible_truncation, reason = "a whole number 1..50")]
    let limit = limit as i64;
    let schedules = with(d.store(), |c| {
        c.query(
            &format!(
                "SELECT {} FROM bank.bill_recurring \
                  WHERE status = 'active' AND next_run_at <= {} ORDER BY next_run_at, id LIMIT $2",
                recurring_cols(),
                at("$1")
            ),
            &[&now.0, &limit],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(recurring_row)
        .collect::<Result<Vec<_>, _>>()
    })?;
    let mut report = RunReport {
        considered: i64::try_from(schedules.len()).unwrap_or(i64::MAX),
        ..RunReport::default()
    };
    for s in &schedules {
        let last: Option<i64> = with(d.store(), |c| {
            c.query(
                "SELECT occurrence FROM bank.bill_recurring_firings WHERE schedule_id = $1::text::uuid \
                  ORDER BY occurrence DESC LIMIT 1",
                &[&s.id],
            )
            .map_err(|e| pg(&e))?
            .first()
            .map(|r| r.try_get::<_, i32>(0).map(i64::from))
            .transpose()
            .map_err(|e| pg(&e))
        })?;
        let cadence = s.cadence()?;
        let plan = calendar::plan_due(
            s.starts_at,
            cadence,
            s.ends_at,
            last,
            now,
            calendar::MAX_CATCH_UP_PER_PASS,
        );
        let mut unsettled: Option<i64> = None;
        for &occurrence in &plan.occurrences {
            let key = format!("bill-recur:{}:{occurrence}", s.id);
            let ask = PayAsk {
                user_id: &s.user_id,
                idempotency_key: &key,
                biller_id: &s.biller_id,
                reference: &s.reference,
                amount: &s.amount,
                from_space_id: &s.from_space_id,
            };
            match pay(d, &ask, now) {
                Ok(p) => {
                    if p.status == "accepted" || p.status == "paid" {
                        report.settled += 1;
                    }
                    record_firing(d, &s.id, occurrence, &p.id)?;
                }
                Err(e) => {
                    let code = code_of(&e)
                        .unwrap_or("bank.bills_outcome_unknown")
                        .to_owned();
                    if !TERMINAL.contains(&code.as_str()) {
                        report.failures.push((s.id.clone(), code));
                        unsettled = Some(occurrence);
                        break;
                    }
                    report.refused += 1;
                    if let Some(existing) = payment_by_key(d, &s.user_id, &key)? {
                        record_firing(d, &s.id, occurrence, &existing.id)?;
                    }
                    report.failures.push((s.id.clone(), code));
                }
            }
        }
        let status = if plan.completed && unsettled.is_none() {
            "completed"
        } else {
            "active"
        };
        let next = match unsettled {
            None => plan.next_run_at,
            Some(n) => calendar::occurrence_start(s.starts_at, cadence, n)
                .ok_or_else(|| Refusal::Other(format!("occurrence {n}")))?,
        };
        with(d.store(), |c| {
            c.execute(
                &format!(
                    "UPDATE bank.bill_recurring SET next_run_at = {}, status = $3 \
                      WHERE id = $1::text::uuid AND status = 'active'",
                    at("$2")
                ),
                &[&s.id, &next.0, &status],
            )
            .map_err(|e| pg(&e))
        })?;
    }
    Ok(report)
}

/// `opsSummary`: counts and volumes by status and asset, and which partner ports are live.
pub fn ops_summary(d: &Deps<'_>, now: Instant) -> Result<Json, Refusal> {
    let grouped = with(d.store(), |c| {
        c.query(
            "SELECT status, asset_id, count(*)::text, sum(amount::numeric)::text \
               FROM bank.bill_payments GROUP BY status, asset_id",
            &[],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(|r| {
            Ok((
                r.try_get::<_, String>(0).map_err(|e| pg(&e))?,
                r.try_get::<_, String>(1).map_err(|e| pg(&e))?,
                r.try_get::<_, String>(2).map_err(|e| pg(&e))?,
                r.try_get::<_, String>(3).map_err(|e| pg(&e))?,
            ))
        })
        .collect::<Result<Vec<_>, Refusal>>()
    })?;
    let mut counts = [0i64; 5];
    let mut volumes = Vec::new();
    for (status, asset, n, total) in grouped {
        let i = STATUSES
            .iter()
            .position(|s| *s == status)
            .ok_or_else(|| pp("bank.bills_outcome_unknown"))?;
        let count: i64 = n.parse().map_err(|_| pp("bank.bills_outcome_unknown"))?;
        if count.unsigned_abs() > (1u64 << 53) - 1 {
            return Err(pp("bank.bills_outcome_unknown"));
        }
        if let Some(n) = counts.get_mut(i) {
            *n += count;
        }
        let amount = format_amount(parse_amount(&total).map_err(Refusal::Other)?);
        volumes.push(Json::obj([
            ("status", Json::str(status)),
            ("assetId", Json::str(asset)),
            ("count", Json::int(count)),
            ("amount", Json::str(amount)),
        ]));
    }
    let w = &d.w.pay;
    Ok(Json::obj([
        ("asOf", Json::str(now.iso())),
        (
            "counts",
            Json::Object(
                STATUSES
                    .iter()
                    .zip(counts)
                    .map(|(s, n)| ((*s).to_owned(), Json::int(n)))
                    .collect(),
            ),
        ),
        ("volumes", Json::Array(volumes)),
        (
            "rails",
            Json::obj([
                (
                    "billerDirectory",
                    Json::str(status_word(w.directory.is_some())),
                ),
                ("lookup", Json::str(status_word(w.lookup.is_some()))),
                ("payRail", Json::str(status_word(w.rail.is_some()))),
                ("blocker", Json::str(PSP_BLOCKER)),
            ]),
        ),
    ]))
}

/// `opsFailed`: every person's failed bills, newest first.
pub fn ops_failed(
    d: &Deps<'_>,
    limit: i64,
    cursor: Option<&str>,
) -> Result<(Vec<Bill>, Option<String>), Refusal> {
    page(
        d,
        "status = $1 AND $2::text IS NULL",
        "failed",
        None,
        limit,
        cursor,
    )
}

/// `opsGet`.
pub fn ops_get(d: &Deps<'_>, id: &str) -> Result<Bill, Refusal> {
    must(d, id)
}

// ---------------------------------------------------------------------------------------------------------------
// The step-up bindings (`step-up-fields.ts`).

fn binding(action_type: &'static str, key: &str, fields: &[(&str, &str)]) -> Binding {
    Binding {
        action_type,
        fields: fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
        operation_key: key.to_owned(),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The calls (`createBillsRouter`).

fn principal<'c>(ctx: &'c Ctx<'_>) -> Result<&'c Principal, Refusal> {
    ctx.principal
        .ok_or_else(|| Refusal::Other("no principal".to_owned()))
}

fn s<'v>(input: &'v Value, key: &str) -> &'v str {
    input.get(key).as_str().unwrap_or_default()
}

fn paged(items: &[Bill], next: Option<String>, ops: bool) -> Json {
    Json::obj([
        (
            "items",
            Json::Array(
                items
                    .iter()
                    .map(|b| if ops { b.ops_json() } else { b.json() })
                    .collect(),
            ),
        ),
        ("nextCursor", next.map_or(Json::Null, Json::str)),
    ])
}

fn call(d: &Deps<'_>, ctx: &Ctx<'_>, path: &str) -> Option<Result<Json, Refusal>> {
    let input = &ctx.input;
    let now = ctx.now;
    Some(match path {
        "billers.search" => search(d, s(input, "query"), input.get("country").as_str()),
        "lookup" => lookup(d, s(input, "billerId"), s(input, "reference")),
        "pay" => principal(ctx).and_then(|p| {
            let space = owned_space_plain(d, &p.user_id, s(input, "fromSpaceId"))?;
            let b = binding(
                "bank.step_up.bills.pay",
                s(input, "idempotencyKey"),
                &[
                    ("actor", &p.user_id),
                    ("idempotencyKey", s(input, "idempotencyKey")),
                    ("billerId", s(input, "billerId")),
                    ("reference", s(input, "reference")),
                    ("fromSpaceId", s(input, "fromSpaceId")),
                    ("assetId", &space.asset_id),
                    ("amount", s(input, "amount")),
                ],
            );
            step_up::require(d.t, p, &b, input.get("stepUpApprovalId").as_str())?;
            pay(
                d,
                &PayAsk {
                    user_id: &p.user_id,
                    idempotency_key: s(input, "idempotencyKey"),
                    biller_id: s(input, "billerId"),
                    reference: s(input, "reference"),
                    amount: s(input, "amount"),
                    from_space_id: s(input, "fromSpaceId"),
                },
                now,
            )
            .map(|b| b.json())
        }),
        "list" => principal(ctx).and_then(|p| {
            let limit = limit_of(input)?;
            let (items, next) = list(
                d,
                &p.user_id,
                limit,
                input.get("status").as_str(),
                input.get("cursor").as_str(),
            )?;
            Ok(paged(&items, next, false))
        }),
        "get" => principal(ctx).and_then(|p| get(d, &p.user_id, s(input, "id")).map(|b| b.json())),
        "recurring.create" => principal(ctx).and_then(|p| {
            let space = owned_space_plain(d, &p.user_id, s(input, "fromSpaceId"))?;
            let ends = input.get("endsAt").as_str();
            let b = binding(
                "bank.step_up.bills.recurring",
                s(input, "idempotencyKey"),
                &[
                    ("actor", &p.user_id),
                    ("idempotencyKey", s(input, "idempotencyKey")),
                    ("billerId", s(input, "billerId")),
                    ("reference", s(input, "reference")),
                    ("fromSpaceId", s(input, "fromSpaceId")),
                    ("assetId", &space.asset_id),
                    ("amount", s(input, "amount")),
                    ("cadence", s(input, "cadence")),
                    ("startsAt", s(input, "startsAt")),
                    ("endsAt", ends.unwrap_or_default()),
                ],
            );
            step_up::require(d.t, p, &b, input.get("stepUpApprovalId").as_str())?;
            let starts_at = zod_datetime(s(input, "startsAt"), true)
                .ok_or_else(|| Refusal::Other("Invalid time value".to_owned()))?;
            let ends_at = ends
                .filter(|e| !e.is_empty())
                .map(|e| {
                    zod_datetime(e, true)
                        .ok_or_else(|| Refusal::Other("Invalid time value".to_owned()))
                })
                .transpose()?;
            create_recurring(
                d,
                &RecurringAsk {
                    user_id: &p.user_id,
                    idempotency_key: s(input, "idempotencyKey"),
                    biller_id: s(input, "billerId"),
                    reference: s(input, "reference"),
                    amount: s(input, "amount"),
                    from_space_id: s(input, "fromSpaceId"),
                    cadence: s(input, "cadence"),
                    starts_at,
                    ends_at,
                },
                now,
            )
            .map(|r| r.json())
        }),
        "recurring.pause" => principal(ctx)
            .and_then(|p| pause_recurring(d, &p.user_id, s(input, "id")).map(|r| r.json())),
        "recurring.cancel" => principal(ctx)
            .and_then(|p| cancel_recurring(d, &p.user_id, s(input, "id")).map(|r| r.json())),
        "recurring.list" => principal(ctx).and_then(|p| {
            let limit = limit_of(input)?;
            Ok(Json::Array(
                list_recurring(d, &p.user_id, limit)?
                    .iter()
                    .map(Recurring::json)
                    .collect(),
            ))
        }),
        "runDue" => {
            run_due(d, input.get("limit").as_number().unwrap_or(f64::NAN), now).map(|r| r.json())
        }
        "ops.summary" => ops_summary(d, now),
        "ops.failed" => limit_of(input)
            .and_then(|limit| ops_failed(d, limit, input.get("cursor").as_str()))
            .map(|(items, next)| paged(&items, next, true)),
        "ops.get" => ops_get(d, s(input, "id")).map(|b| b.ops_json()),
        _ => return None,
    })
}

/// This part's calls (`bills.*`); `None` for any other call.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    let path = ctx.call.path.strip_prefix("bills.")?;
    let out = call(d, ctx, path)?;
    Some(out.map(Some).map_err(guard))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn a_cursor_reads_back_what_it_was_made_from() {
        let at = Instant(1_767_225_600_123);
        let id = "0b2a3c4d-0000-4000-8000-00000000000a";
        assert_eq!(
            decode_cursor(&encode_cursor(at, id)).unwrap(),
            (at, id.to_owned())
        );
    }

    #[test]
    fn a_cursor_that_is_not_a_time_and_a_uuid_refuses_by_name() {
        for bad in [
            "",
            "eA",
            &URL_SAFE_NO_PAD.encode("2026-01-01T00:00:00Z|nope"),
        ] {
            let Err(Refusal::Trpc(e)) = decode_cursor(bad) else {
                panic!("{bad}")
            };
            assert_eq!(e.cause.as_deref(), Some("bank.bills_cursor_invalid"));
        }
    }

    #[test]
    fn a_personal_pay_refusal_names_its_code_after_its_sentence() {
        let Refusal::Trpc(e) = pp("bank.bills_list_limit_unset") else {
            panic!()
        };
        assert_eq!(e.code, "BAD_REQUEST");
        assert_eq!(
            e.message,
            "Page size was omitted. Blank is not a default page. Pass a limit. (bank.bills_list_limit_unset)"
        );
    }

    #[test]
    fn amounts_are_the_wire_shape() {
        assert!(is_amount_text("1") && is_amount_text("0.000000000000000001"));
        assert!(
            !is_amount_text("1.")
                && !is_amount_text(".1")
                && !is_amount_text("-1")
                && !is_amount_text("1e3")
        );
    }
}
