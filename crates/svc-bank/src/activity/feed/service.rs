//! `ActivityService` (`activity-service.ts`): the person's merged money history, newest first. A read, and only a read,
//! over svc-ledger's `historyPage`; nothing here writes.
//!
//! The owners read are the person's own account and every named space they own (svc-bank's own table, by user id). Each
//! owner is read `limit` newest first, the heads are merged by `postedAt`, then `entryId` (then tx id), and the first
//! `limit` are the page; a transaction is never split where its other half is in hand. The cursor records where each
//! owner stopped: the ledger's own cursor when its whole page was used, exactly below the last entry shown when the
//! ledger sends entry ids, else a re-read of exactly the consumed count.
//!
//! When the partner bank holds the person's money, the history is the partner's own record (`partner`).

use std::collections::{BTreeMap, BTreeSet};

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::{Instant, js_date};

use super::cursor::{self, Body, Pos};
use super::kind;
use super::partner;
use crate::activity::pages::{HistoryPages, PageEntry, PageRequest};
use crate::db::StoreError;
use crate::errors::BankError;

/// What a read of the history can fail with: the TypeScript's error classes, mapped by the router (`activityFailure`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeedError {
    /// `ActivityCursorInvalidError`.
    CursorInvalid,
    /// `ActivityRangeError`.
    Range,
    /// `ActivityNotFoundError`.
    NotFound,
    /// `ActivityLookupBoundedError`.
    LookupBounded,
    /// `ActivityTaxYearUnsetError`.
    TaxYearUnset,
    /// `ActivityTaxEffectMapUnsetError`.
    TaxEffectMapUnset,
    /// `ActivitySortBoundedError`.
    SortBounded,
    /// `ActivityAccountUnknownError`.
    AccountUnknown,
    /// `ActivityUnavailableError`: the feed cannot be served now (its words are never sent).
    Unavailable,
    /// A `BankError`.
    Bank(BankError),
    /// Anything else thrown (a database error, a broken stored value): the opaque failure, with the error's own code
    /// as its cause when it has one (a Postgres SQLSTATE).
    Other(StoreError),
    /// A `TRPCError` the handler threw inside the guard (`bank.activity_line_required`): `activityFailure` does not
    /// pass it through, so it answers the opaque failure with the error's tRPC code as its cause.
    Thrown(&'static str),
}

impl From<StoreError> for FeedError {
    fn from(e: StoreError) -> FeedError {
        FeedError::Other(e)
    }
}

impl From<cursor::Invalid> for FeedError {
    fn from(_: cursor::Invalid) -> FeedError {
        FeedError::CursorInvalid
    }
}

/// A `BankError` by its code; a code the table does not hold is an opaque failure (none is ever made up).
pub fn bank(code: &str, message: impl Into<String>) -> FeedError {
    let message = message.into();
    BankError::new(code, message.clone()).map_or_else(
        || FeedError::Other(StoreError::new(message, None)),
        FeedError::Bank,
    )
}

/// An open dispute on a line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dispute {
    pub id: String,
    pub reason: String,
}

/// `ActivityItem`. `None` is an absent field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub id: String,
    pub kind: &'static str,
    /// `in` or `out`.
    pub direction: &'static str,
    pub asset: String,
    /// Unsigned; the direction carries the sign.
    pub amount: Amount,
    pub posted_at: Instant,
    pub tx_id: String,
    pub counterparty: Option<String>,
    pub space_name: Option<String>,
    pub order_id: Option<String>,
    pub purchase: bool,
    pub note: Option<String>,
    pub reference: Option<String>,
    pub private_note: Option<String>,
    pub report_description: Option<String>,
    pub dispute: Option<Dispute>,
    pub address: Option<String>,
    /// `heldAt.label`: on a line the partner bank reports.
    pub held_at: Option<String>,
    /// `fees`: what a personal send cost, as the bank recorded it when the send was made. `None` on every other line.
    pub fees: Option<Fees>,
}

/// A personal send's recorded fees: our fee and the network fee the moving book stated. `None` is "not recorded" (our
/// fee) or "not known" (the network fee).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Fees {
    pub fee: Option<String>,
    pub network_fee: Option<String>,
}

fn opt(fields: &mut Vec<(String, Json)>, key: &str, v: Option<&String>) {
    if let Some(v) = v {
        fields.push((key.to_owned(), Json::str(v.clone())));
    }
}

impl Item {
    /// The line as the router's output schema writes it (`activityItem`, its keys in the schema's order).
    pub fn json(&self) -> Json {
        let mut f = vec![
            ("id".to_owned(), Json::str(self.id.clone())),
            ("kind".to_owned(), Json::str(self.kind)),
            ("direction".to_owned(), Json::str(self.direction)),
            ("asset".to_owned(), Json::str(self.asset.clone())),
            ("amount".to_owned(), Json::str(format_amount(self.amount))),
            ("postedAt".to_owned(), Json::str(self.posted_at.iso())),
            ("txId".to_owned(), Json::str(self.tx_id.clone())),
            (
                "counterparty".to_owned(),
                self.counterparty.as_ref().map_or(Json::Null, |h| {
                    Json::obj([("handle", Json::str(h.clone()))])
                }),
            ),
            (
                "spaceName".to_owned(),
                self.space_name.clone().map_or(Json::Null, Json::String),
            ),
        ];
        opt(&mut f, "orderId", self.order_id.as_ref());
        if self.purchase {
            f.push(("purchase".to_owned(), Json::Bool(true)));
        }
        opt(&mut f, "note", self.note.as_ref());
        opt(&mut f, "reference", self.reference.as_ref());
        opt(&mut f, "privateNote", self.private_note.as_ref());
        opt(
            &mut f,
            "reportDescription",
            self.report_description.as_ref(),
        );
        if let Some(d) = &self.dispute {
            f.push((
                "dispute".to_owned(),
                Json::obj([
                    ("id", Json::str(d.id.clone())),
                    ("status", Json::str("open")),
                    ("reason", Json::str(d.reason.clone())),
                ]),
            ));
        }
        opt(&mut f, "address", self.address.as_ref());
        if let Some(label) = &self.held_at {
            f.push((
                "heldAt".to_owned(),
                Json::obj([("label", Json::str(label.clone()))]),
            ));
        }
        if let Some(fees) = &self.fees {
            let figure = |v: &Option<String>| v.clone().map_or(Json::Null, Json::String);
            f.push((
                "fees".to_owned(),
                Json::obj([
                    ("fee", figure(&fees.fee)),
                    ("networkFee", figure(&fees.network_fee)),
                ]),
            ));
        }
        Json::Object(f)
    }
}

/// `ActivityPage`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page {
    pub items: Vec<Item>,
    pub next_cursor: Option<String>,
}

/// One line and the other lines of its transaction (`get`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub item: Item,
    pub lines: Vec<Item>,
    pub complete: bool,
}

/// `ActivityQuery`: `None` is an absent field.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Query {
    pub limit: Option<i64>,
    pub cursor: Option<String>,
    pub asset_id: Option<String>,
    pub kind: Option<Vec<String>>,
    pub direction: Option<String>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub q: Option<String>,
    pub min_amount: Option<String>,
    pub max_amount: Option<String>,
    pub account_id: Option<String>,
    /// `asc` or `desc`.
    pub sort: Option<String>,
    pub year: Option<i64>,
    pub tax_year: Option<i64>,
    pub address: Option<String>,
    pub has_note: Option<bool>,
}

/// What a statement collects (`collect`'s input).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CollectQuery {
    pub from: String,
    pub to: String,
    pub asset_id: Option<String>,
    pub account_id: Option<String>,
    pub kind: Option<Vec<String>>,
    pub limit: usize,
}

/// A named space the person owns (the fields of `SpaceRecord` the feed reads).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpaceRef {
    pub id: String,
    pub user_id: String,
    pub kind: String,
    pub name: String,
}

/// `SpaceLister.allNamedSpaces`: every named space the person owns, archived ones included. A failure is thrown as is.
pub trait Spaces {
    fn all_named(&self, user_id: &str, asset_id: Option<&str>) -> Result<Vec<SpaceRef>, FeedError>;
}

/// `ActivityAnnotation`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Annotation {
    pub note: Option<String>,
    pub reference: Option<String>,
    pub private_note: Option<String>,
    pub report_description: Option<String>,
    pub dispute: Option<Dispute>,
}

/// The records kept against a line (`ActivityRecordService`'s reads). An `Err` is a failed read.
pub trait Records {
    /// `forItems`: by line id; the refs are `(id, txId)`.
    fn for_items(
        &self,
        user_id: &str,
        refs: &[(String, String)],
    ) -> Result<BTreeMap<String, Annotation>, FeedError>;
    /// Whether `addressesFor` is wired (`records.addressesFor` is optional in the TypeScript).
    fn looks_up_addresses(&self) -> bool;
    /// `addressesFor`: the crypto address of each withdrawal by ledger tx id.
    fn addresses_for(
        &self,
        user_id: &str,
        tx_ids: &[String],
    ) -> Result<BTreeMap<String, String>, FeedError>;
}

/// `TransferFact`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Fact {
    pub note: Option<String>,
    pub reference: Option<String>,
    pub counterparty_handle: Option<String>,
    /// The send's recorded fees.
    pub fees: Fees,
}

/// `ActivityTransferFacts.forTransfers`: a personal send's note, reference and the other person's handle, by tx id.
pub trait TransferFacts {
    fn for_transfers(
        &self,
        user_id: &str,
        tx_ids: &[String],
    ) -> Result<BTreeMap<String, Fact>, FeedError>;
}

/// `ActivityCounterparties.handlesFor`: a handle, never an id. Nothing wires one today.
pub trait Counterparties {
    fn handles_for(
        &self,
        user_id: &str,
        tx_ids: &[String],
    ) -> Result<BTreeMap<String, String>, FeedError>;
}

/// `PayWithdrawalAddressesPort.addressesFor`: withdrawal id to address, or `None` when svc-pay could not be asked.
pub trait PayAddresses: Send + Sync {
    fn addresses_for(
        &self,
        user_id: &str,
        withdrawal_ids: &[String],
    ) -> Option<BTreeMap<String, String>>;
}

/// The partner bank's record, for a person whose money it holds (`custody.bankFor`).
pub trait PartnerBook {
    /// Whether the partner holds this person's money.
    fn holds(&self, user_id: &str) -> bool;
    /// `partner.moves`: the person's moves, newest first.
    fn moves(
        &self,
        user_id: &str,
        q: &crate::partner::MovesQuery,
    ) -> Result<Vec<crate::partner::Move>, FeedError>;
}

/// `ActivityServiceOptions` and the space lister: what one read is given.
pub struct Feed<'a> {
    pub spaces: &'a dyn Spaces,
    /// Unset: every read refuses as unavailable.
    pub pages: Option<&'a dyn HistoryPages>,
    /// Signs the cursors; unset or blank, every read refuses as unavailable.
    pub secret: Option<&'a str>,
    pub counterparties: Option<&'a dyn Counterparties>,
    pub facts: Option<&'a dyn TransferFacts>,
    pub records: Option<&'a dyn Records>,
    pub partner: Option<&'a dyn PartnerBook>,
    pub pay: Option<&'a dyn PayAddresses>,
}

/// `ACTIVITY_DEFAULT_LIMIT`.
pub const DEFAULT_LIMIT: i64 = 50;
/// `ACTIVITY_MAX_LIMIT`.
pub const MAX_LIMIT: i64 = 200;
/// `ACTIVITY_MAX_OWNERS`.
pub const MAX_OWNERS: usize = 100;
const ASC_MAX_ITEMS: usize = 2_000;
const ASC_MAX_CALLS: usize = 25;
const FILTER_WINDOW: i64 = 100;
const FILTER_SCAN_MAX: usize = 2_000;
const GET_PAGE: i64 = 100;
const GET_MAX_PAGES: usize = 100;
const PAR_ASSETS: [&str; 3] = ["USDT", "USDC", "USD"];

/// The page size `list` clamps to.
pub fn clamp_limit(limit: Option<i64>) -> usize {
    #[allow(
        clippy::cast_sign_loss,
        clippy::cast_possible_truncation,
        reason = "clamped to 1..=200"
    )]
    let n = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT) as usize;
    n
}

/// `ActivityFilter`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Filter {
    kind: Option<Vec<String>>,
    direction: Option<String>,
    from: Option<String>,
    to: Option<String>,
    q: Option<String>,
    min_amount: Option<String>,
    max_amount: Option<String>,
    account_id: Option<String>,
    address: Option<String>,
    has_note: bool,
}

fn null_or(v: Option<&String>) -> Json {
    v.map_or(Json::Null, |s| Json::str(s.clone()))
}

/// JavaScript's `<` on two strings: UTF-16 code units.
fn js_lt(a: &str, b: &str) -> bool {
    a.encode_utf16().lt(b.encode_utf16())
}

/// `activityFilterKey`.
fn filter_key(f: &Filter, asc: bool) -> String {
    let kinds = f.kind.as_ref().map_or(Json::Null, |k| {
        let mut k = k.clone();
        k.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        Json::Array(k.into_iter().map(Json::String).collect())
    });
    let mut fields = vec![
        ("k".to_owned(), kinds),
        ("d".to_owned(), null_or(f.direction.as_ref())),
        ("f".to_owned(), null_or(f.from.as_ref())),
        ("t".to_owned(), null_or(f.to.as_ref())),
        ("q".to_owned(), null_or(f.q.as_ref())),
        ("n".to_owned(), null_or(f.min_amount.as_ref())),
        ("x".to_owned(), null_or(f.max_amount.as_ref())),
    ];
    if let Some(a) = f.account_id.as_ref().filter(|a| !a.is_empty()) {
        fields.push(("a".to_owned(), Json::str(a.clone())));
    }
    if let Some(r) = f.address.as_ref().filter(|a| !a.is_empty()) {
        fields.push(("r".to_owned(), Json::str(r.clone())));
    }
    if f.has_note {
        fields.push(("h".to_owned(), Json::int(1)));
    }
    if asc {
        fields.push(("o".to_owned(), Json::str("asc")));
    }
    Json::Object(fields).compact()
}

fn has_filter(q: &Query) -> bool {
    q.kind.is_some()
        || q.direction.is_some()
        || q.from.is_some()
        || q.to.is_some()
        || q.q.is_some()
        || q.min_amount.is_some()
        || q.max_amount.is_some()
        || q.account_id.is_some()
        || q.year.is_some()
        || q.tax_year.is_some()
        || q.address.is_some()
        || q.has_note.is_some()
}

/// `Date.parse` on an ISO text the schema accepted; an unreadable one is NaN, which no comparison holds.
fn ms(text: &str) -> Option<i64> {
    js_date(text).map(|i| i.0)
}

fn non_empty(s: Option<&String>) -> Option<String> {
    s.filter(|s| !s.is_empty()).cloned()
}

fn amount(s: &str) -> Result<Amount, FeedError> {
    parse_amount(s).map_err(|e| FeedError::Other(StoreError::new(e, None)))
}

/// `readFilter`.
fn read_filter(q: &Query) -> Result<Filter, FeedError> {
    if q.tax_year.is_some() {
        return Err(FeedError::TaxYearUnset);
    }
    let mut from = q.from.clone();
    let mut to = q.to.clone();
    if let Some(year) = q.year {
        let year_from = Instant::start_of_year(year);
        let year_to = Instant(Instant::start_of_year(year + 1).0 - 1);
        // `Date.parse(from) < yearFrom` is false for NaN, so an unreadable bound is kept as given.
        if from
            .as_deref()
            .is_none_or(|f| ms(f).is_some_and(|m| m < year_from.0))
        {
            from = Some(year_from.iso());
        }
        if to
            .as_deref()
            .is_none_or(|t| ms(t).is_some_and(|m| m > year_to.0))
        {
            to = Some(year_to.iso());
        }
    }
    let f = Filter {
        kind: q.kind.clone(),
        direction: non_empty(q.direction.as_ref()),
        from: non_empty(from.as_ref()),
        to: non_empty(to.as_ref()),
        account_id: non_empty(q.account_id.as_ref()),
        address: non_empty(q.address.as_ref())
            .map(|a| service_kit::money::js_trim(&a).to_lowercase()),
        has_note: q.has_note == Some(true),
        q: non_empty(q.q.as_ref()).map(|s| service_kit::money::js_trim(&s).to_lowercase()),
        min_amount: non_empty(q.min_amount.as_ref()),
        max_amount: non_empty(q.max_amount.as_ref()),
    };
    if let (Some(a), Some(b)) = (&f.from, &f.to)
        && let (Some(a), Some(b)) = (ms(a), ms(b))
        && a > b
    {
        return Err(FeedError::Range);
    }
    if let (Some(a), Some(b)) = (&f.min_amount, &f.max_amount)
        && amount(a)? > amount(b)?
    {
        return Err(FeedError::Range);
    }
    Ok(f)
}

/// `accountOf`: `main`, a space id, or none. Ids are `<txId>:<owner key>:<asset>:<direction>`.
fn account_of(item: &Item) -> Option<String> {
    let rest = item.id.strip_prefix(&format!("{}:", item.tx_id))?;
    if rest.starts_with("u:") {
        return Some("main".to_owned());
    }
    let after = rest.strip_prefix("s:")?;
    let (id, _) = after.split_once(':')?;
    (!id.is_empty()).then(|| id.to_owned())
}

/// `withOwnFee`: a fill's fee as its own line out, the fill shown at what it delivered.
fn with_own_fee(line: Item, fee: Option<&Option<Amount>>) -> Vec<Item> {
    let Some(Some(taken)) = fee else {
        return vec![line];
    };
    if line.direction != "in" || *taken <= Amount::ZERO {
        return vec![line];
    }
    let fee_line = Item {
        id: format!("{}:fee", line.id),
        kind: "fee",
        direction: "out",
        amount: *taken,
        purchase: false,
        ..line.clone()
    };
    vec![
        Item {
            amount: line.amount + *taken,
            ..line
        },
        fee_line,
    ]
}

/// `isPurchase`.
fn is_purchase(e: &PageEntry, direction: &str) -> bool {
    if direction != "in" {
        return false;
    }
    let key = format!("{}/{}", e.module, e.reason);
    if key == "p2p/p2p.escrow.release" {
        return true;
    }
    (key == "trade/trade.fill" || key == "trade/trade.fill.mm_maker")
        && !PAR_ASSETS.contains(&e.asset_id.to_uppercase().as_str())
}

/// `itemMatches`.
fn item_matches(item: &Item, f: &Filter) -> Result<bool, FeedError> {
    if let Some(a) = &f.account_id
        && account_of(item).as_ref() != Some(a)
    {
        return Ok(false);
    }
    if let Some(k) = &f.kind
        && !k.iter().any(|k| k == item.kind)
    {
        return Ok(false);
    }
    if let Some(d) = &f.direction
        && item.direction != d
    {
        return Ok(false);
    }
    if let Some(min) = &f.min_amount
        && item.amount < amount(min)?
    {
        return Ok(false);
    }
    if let Some(max) = &f.max_amount
        && item.amount > amount(max)?
    {
        return Ok(false);
    }
    if f.has_note && item.private_note.is_none() && item.report_description.is_none() {
        return Ok(false);
    }
    if let Some(addr) = &f.address
        && !item
            .address
            .as_deref()
            .unwrap_or_default()
            .to_lowercase()
            .contains(addr.as_str())
    {
        return Ok(false);
    }
    let Some(q) = &f.q else {
        return Ok(true);
    };
    let hay = [
        item.kind.to_owned(),
        item.direction.to_owned(),
        item.asset.clone(),
        format_amount(item.amount),
        item.tx_id.clone(),
        item.id.clone(),
        item.space_name.clone().unwrap_or_default(),
        item.counterparty.clone().unwrap_or_default(),
        item.note.clone().unwrap_or_default(),
        item.reference.clone().unwrap_or_default(),
        item.private_note.clone().unwrap_or_default(),
        item.order_id.clone().unwrap_or_default(),
    ]
    .join("\n")
    .to_lowercase();
    Ok(hay.contains(q.as_str()))
}

/// svc-ledger's cursor for "entries older than this entry id": base64url of `v2.<entryId>`.
fn ledger_cursor_below(entry_id: &str) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!("v2.{entry_id}"))
}

/// Positive when `a` belongs after `b` in a newest-first list.
fn after(a: &PageEntry, b: &PageEntry) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match b.posted_at.0.cmp(&a.posted_at.0) {
        Ordering::Equal => {}
        o => return o,
    }
    if let (Some(x), Some(y)) = (&a.entry_id, &b.entry_id)
        && x != y
    {
        let (x, y) = (
            x.parse::<u128>().unwrap_or(0),
            y.parse::<u128>().unwrap_or(0),
        );
        return if y > x {
            Ordering::Greater
        } else {
            Ordering::Less
        };
    }
    if js_lt(&a.tx_id, &b.tx_id) {
        Ordering::Greater
    } else if js_lt(&b.tx_id, &a.tx_id) {
        Ordering::Less
    } else {
        Ordering::Equal
    }
}

/// `UUID`, case-insensitive.
pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// `/^(.+):\d{1,9}$/`'s first group: the withdrawal id before the attempt.
fn withdrawal_of(id: &str) -> Option<&str> {
    let (head, tail) = id.rsplit_once(':')?;
    let line_break = |c: char| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
    ((1..=9).contains(&tail.len())
        && tail.bytes().all(|b| b.is_ascii_digit())
        && !head.is_empty()
        && !head.contains(line_break))
    .then_some(head)
}

struct Owner {
    key: String,
    owner_type: &'static str,
    owner_id: String,
    space_name: Option<String>,
}

struct Queue<'o> {
    owner: &'o Owner,
    start: Option<String>,
    entries: Vec<PageEntry>,
    next: Option<String>,
    taken: usize,
}

const TRANSFER_REASONS: [&str; 2] = ["bank/bank.transfer.manual", "bank/bank.transfer.scheduled"];

/// What `listPage` is asked.
#[derive(Default)]
struct PageAsk {
    limit: Option<i64>,
    cursor: Option<String>,
    asset_id: Option<String>,
    need_address: bool,
    need_notes: bool,
}

impl Feed<'_> {
    fn wired(&self) -> Option<(&dyn HistoryPages, &str)> {
        Some((self.pages?, self.secret.filter(|s| !s.is_empty())?))
    }

    fn held(&self, user_id: &str) -> Option<&dyn PartnerBook> {
        self.partner.filter(|p| p.holds(user_id))
    }

    /// `list`. `user_id` is the verified principal, never input.
    pub fn list(&self, user_id: &str, q: &Query) -> Result<Page, FeedError> {
        if let Some(book) = self.held(user_id) {
            let limit = clamp_limit(q.limit);
            let page = partner::page(user_id, book, self.spaces, q, limit)?;
            let (items, personal) = self.with_transfer_facts(user_id, page.items);
            let items =
                self.with_records(user_id, items, &personal, false, false, &BTreeMap::new())?;
            return Ok(Page {
                items,
                next_cursor: page.next_cursor,
            });
        }
        if q.sort.as_deref() == Some("asc") {
            return self.list_oldest_first(user_id, q);
        }
        if !has_filter(q) {
            return self.list_page(
                user_id,
                &PageAsk {
                    limit: q.limit,
                    cursor: q.cursor.clone(),
                    asset_id: q.asset_id.clone(),
                    ..PageAsk::default()
                },
            );
        }
        self.list_filtered(user_id, q)
    }

    /// `get`: one line and the other lines of its transaction; `order:<orderId>` is every line of that order.
    pub fn get(&self, user_id: &str, id: &str) -> Result<Found, FeedError> {
        if let Some(book) = self.held(user_id) {
            let found = partner::item(user_id, book, self.spaces, id)?;
            let (lines, personal) = self.with_transfer_facts(user_id, found.lines);
            let lines =
                self.with_records(user_id, lines, &personal, false, false, &BTreeMap::new())?;
            let item = lines
                .iter()
                .find(|l| l.id == found.item.id)
                .cloned()
                .unwrap_or(found.item);
            return Ok(Found {
                item,
                lines,
                complete: found.complete,
            });
        }
        if let Some(order_id) = id.strip_prefix("order:") {
            let n = order_id.encode_utf16().count();
            if !(1..=128).contains(&n) {
                return Err(FeedError::NotFound);
            }
            return self.find_order(user_id, order_id);
        }
        self.find_item(user_id, id)
    }

    /// `collect`: every matching line in the range, newest first, for a statement; stops after `limit` matches. The
    /// caller passes limit + 1 to see an overflow.
    pub fn collect(&self, user_id: &str, input: &CollectQuery) -> Result<Vec<Item>, FeedError> {
        let mut items: Vec<Item> = Vec::new();
        let mut cursor: Option<String> = None;
        while items.len() < input.limit {
            #[allow(clippy::cast_possible_wrap, reason = "at most 200")]
            let limit = 200.min(input.limit - items.len()) as i64;
            let page = self.list(
                user_id,
                &Query {
                    limit: Some(limit),
                    cursor: cursor.clone(),
                    asset_id: input.asset_id.clone(),
                    from: Some(input.from.clone()),
                    to: Some(input.to.clone()),
                    account_id: input.account_id.clone(),
                    kind: input.kind.clone(),
                    ..Query::default()
                },
            )?;
            let empty = page.items.is_empty();
            items.extend(page.items);
            let Some(next) = page.next_cursor else {
                break;
            };
            if empty && cursor.as_deref() == Some(next.as_str()) {
                break;
            }
            cursor = Some(next);
        }
        Ok(items)
    }

    fn list_filtered(&self, user_id: &str, input: &Query) -> Result<Page, FeedError> {
        let Some((_, secret)) = self.wired() else {
            return Err(FeedError::Unavailable);
        };
        let filter = read_filter(input)?;
        if let Some(account) = &filter.account_id {
            self.assert_account(user_id, input.asset_id.as_deref(), account)?;
        }
        let key = filter_key(&filter, false);
        let limit = clamp_limit(input.limit);
        let asset_id = input.asset_id.clone();
        let asset = asset_id.as_deref();
        let start = match &input.cursor {
            None => None,
            Some(c) => Some(cursor::decode(secret, c, user_id, asset, Some(&key))?),
        };
        let mut position = start.as_ref().map(|s| {
            cursor::encode(
                secret,
                &Body {
                    user_id: user_id.to_owned(),
                    asset_id: asset_id.clone(),
                    owners: s.owners.clone(),
                    ..Body::default()
                },
            )
        });
        let mut skip = start.as_ref().map_or(0, |s| s.skip as usize);
        let mut matches: Vec<Item> = Vec::new();
        let mut scanned = 0usize;
        let from_ms = filter.from.as_deref().map(ms);
        let to_ms = filter.to.as_deref().map(ms);
        while matches.len() < limit && scanned < FILTER_SCAN_MAX {
            let window = self.list_page(
                user_id,
                &PageAsk {
                    limit: Some(FILTER_WINDOW),
                    cursor: position.clone(),
                    asset_id: asset_id.clone(),
                    need_address: filter.address.is_some(),
                    need_notes: filter.has_note,
                },
            )?;
            scanned += window.items.len();
            let mut kept: Vec<Item> = Vec::new();
            let mut older = false;
            for item in &window.items {
                let at = item.posted_at.0;
                // A bound that does not parse is NaN: no line is past it.
                if let Some(Some(t)) = to_ms
                    && at > t
                {
                    continue;
                }
                if let Some(Some(f)) = from_ms
                    && at < f
                {
                    older = true;
                    break;
                }
                if item_matches(item, &filter)? {
                    kept.push(item.clone());
                }
            }
            let rest: Vec<Item> = kept.into_iter().skip(skip).collect();
            let rest_len = rest.len();
            let take: Vec<Item> = rest.into_iter().take(limit - matches.len()).collect();
            let took = take.len();
            matches.extend(take);
            let window_start = self.position_body(user_id, asset, position.as_deref())?;
            if took < rest_len {
                #[allow(clippy::cast_possible_truncation, reason = "a page count")]
                let s = (skip + took) as u32;
                return Ok(Page {
                    items: matches,
                    next_cursor: Some(cursor::encode(
                        secret,
                        &Body {
                            filter_key: Some(key),
                            skip: s,
                            ..window_start
                        },
                    )),
                });
            }
            let Some(next) = window.next_cursor.clone() else {
                return Ok(Page {
                    items: matches,
                    next_cursor: None,
                });
            };
            if older || window.items.is_empty() {
                return Ok(Page {
                    items: matches,
                    next_cursor: None,
                });
            }
            position = Some(next.clone());
            skip = 0;
            if scanned >= FILTER_SCAN_MAX && matches.len() < limit {
                let end = cursor::decode(secret, &next, user_id, asset, None)?;
                return Ok(Page {
                    items: matches,
                    next_cursor: Some(cursor::encode(
                        secret,
                        &Body {
                            filter_key: Some(key),
                            skip: 0,
                            ..end
                        },
                    )),
                });
            }
        }
        let Some(position) = position else {
            return Ok(Page {
                items: matches,
                next_cursor: None,
            });
        };
        let end = cursor::decode(secret, &position, user_id, asset, None)?;
        let more = matches.len() >= limit;
        Ok(Page {
            items: matches,
            next_cursor: more.then(|| {
                cursor::encode(
                    secret,
                    &Body {
                        filter_key: Some(key),
                        skip: 0,
                        ..end
                    },
                )
            }),
        })
    }

    fn position_body(
        &self,
        user_id: &str,
        asset_id: Option<&str>,
        cursor: Option<&str>,
    ) -> Result<Body, FeedError> {
        if let Some(c) = cursor {
            let body = cursor::decode(self.secret.unwrap_or_default(), c, user_id, asset_id, None)?;
            return Ok(Body {
                user_id: user_id.to_owned(),
                asset_id: asset_id.map(str::to_owned),
                owners: body.owners,
                ..Body::default()
            });
        }
        let owners = self.owners_of(user_id, asset_id)?;
        Ok(Body {
            user_id: user_id.to_owned(),
            asset_id: asset_id.map(str::to_owned),
            owners: owners.into_iter().map(|o| (o.key, Pos::Start)).collect(),
            ..Body::default()
        })
    }

    fn find_item(&self, user_id: &str, id: &str) -> Result<Found, FeedError> {
        let mut cursor: Option<String> = None;
        let mut read: Vec<Item> = Vec::new();
        let mut hit: Option<Item> = None;
        let mut page = 0usize;
        while page < GET_MAX_PAGES {
            let got = self.list_page(
                user_id,
                &PageAsk {
                    limit: Some(GET_PAGE),
                    cursor: cursor.clone(),
                    ..PageAsk::default()
                },
            )?;
            hit = got.items.iter().find(|i| i.id == id).cloned();
            read.extend(got.items);
            cursor.clone_from(&got.next_cursor);
            if hit.is_some() {
                break;
            }
            if got.next_cursor.is_none() {
                return Err(FeedError::NotFound);
            }
            page += 1;
        }
        let Some(hit) = hit else {
            return Err(FeedError::LookupBounded);
        };
        let at = hit.posted_at.0;
        let may_continue = |read: &[Item]| {
            read.last()
                .is_some_and(|last| last.tx_id == hit.tx_id || last.posted_at.0 >= at)
        };
        let mut complete = true;
        while cursor.is_some() && may_continue(&read) {
            page += 1;
            if page >= GET_MAX_PAGES {
                complete = false;
                break;
            }
            let got = self.list_page(
                user_id,
                &PageAsk {
                    limit: Some(GET_PAGE),
                    cursor: cursor.clone(),
                    ..PageAsk::default()
                },
            )?;
            read.extend(got.items);
            cursor = got.next_cursor;
        }
        // `new Map(...)`: one line per id, at its first place, holding its last value.
        let mut lines: Vec<Item> = Vec::new();
        for item in read.into_iter().filter(|i| i.tx_id == hit.tx_id) {
            match lines.iter_mut().find(|l| l.id == item.id) {
                Some(slot) => *slot = item,
                None => lines.push(item),
            }
        }
        Ok(Found {
            item: hit,
            lines,
            complete,
        })
    }

    fn find_order(&self, user_id: &str, order_id: &str) -> Result<Found, FeedError> {
        let mut lines: Vec<Item> = Vec::new();
        let mut cursor: Option<String> = None;
        let mut complete = true;
        for page in 0..GET_MAX_PAGES {
            let got = self.list_page(
                user_id,
                &PageAsk {
                    limit: Some(GET_PAGE),
                    cursor: cursor.clone(),
                    ..PageAsk::default()
                },
            )?;
            lines.extend(
                got.items
                    .into_iter()
                    .filter(|i| i.order_id.as_deref() == Some(order_id)),
            );
            let Some(next) = got.next_cursor else {
                break;
            };
            cursor = Some(next);
            if page == GET_MAX_PAGES - 1 {
                complete = false;
            }
        }
        let Some(item) = lines.first().cloned() else {
            return Err(if complete {
                FeedError::NotFound
            } else {
                FeedError::LookupBounded
            });
        };
        Ok(Found {
            item,
            lines,
            complete,
        })
    }

    fn list_oldest_first(&self, user_id: &str, input: &Query) -> Result<Page, FeedError> {
        let Some((_, secret)) = self.wired() else {
            return Err(FeedError::Unavailable);
        };
        let base = Query {
            sort: None,
            cursor: None,
            limit: Some(MAX_LIMIT),
            ..input.clone()
        };
        let filter = read_filter(&base)?;
        let asset = input.asset_id.as_deref();
        let key = filter_key(&filter, true);
        let limit = clamp_limit(input.limit);
        let skip = match &input.cursor {
            None => 0,
            Some(c) => cursor::decode(secret, c, user_id, asset, Some(&key))?.skip as usize,
        };
        let mut newest_first: Vec<Item> = Vec::new();
        let mut cursor: Option<String> = None;
        let mut call = 0usize;
        loop {
            if call >= ASC_MAX_CALLS {
                return Err(FeedError::SortBounded);
            }
            let page = self.list_filtered(
                user_id,
                &Query {
                    cursor: cursor.clone(),
                    ..base.clone()
                },
            )?;
            newest_first.extend(page.items);
            if newest_first.len() > ASC_MAX_ITEMS {
                return Err(FeedError::SortBounded);
            }
            let Some(next) = page.next_cursor else {
                break;
            };
            cursor = Some(next);
            call += 1;
        }
        newest_first.reverse();
        let total = newest_first.len();
        let items: Vec<Item> = newest_first.into_iter().skip(skip).take(limit).collect();
        let shown = skip + items.len();
        #[allow(clippy::cast_possible_truncation, reason = "at most 2,000")]
        let next_cursor = (shown < total).then(|| {
            cursor::encode(
                secret,
                &Body {
                    user_id: user_id.to_owned(),
                    asset_id: asset.map(str::to_owned),
                    owners: Vec::new(),
                    filter_key: Some(key),
                    skip: shown as u32,
                },
            )
        });
        Ok(Page { items, next_cursor })
    }

    fn list_page(&self, user_id: &str, ask: &PageAsk) -> Result<Page, FeedError> {
        let Some((pages, secret)) = self.wired() else {
            return Err(FeedError::Unavailable);
        };
        let limit = clamp_limit(ask.limit);
        let asset_id = ask.asset_id.clone();
        // The cursor first: a bad one is refused before anything is read.
        let resume = match &ask.cursor {
            None => None,
            Some(c) => Some(cursor::decode(
                secret,
                c,
                user_id,
                asset_id.as_deref(),
                None,
            )?),
        };
        let owners = self.owners_of(user_id, asset_id.as_deref())?;
        let start = |o: &Owner| -> Option<Option<String>> {
            match &resume {
                None => Some(None),
                Some(r) => match r.owner(&o.key) {
                    None | Some(Pos::Done) => None,
                    Some(Pos::Start) => Some(None),
                    Some(Pos::Ledger(c)) => Some(Some(c.clone())),
                },
            }
        };
        let read = |o: &Owner, cursor: Option<&String>, n: usize| {
            pages.page(&PageRequest {
                owner_type: o.owner_type,
                owner_id: o.owner_id.clone(),
                asset_id: asset_id.clone(),
                limit: n,
                cursor: cursor.cloned(),
            })
        };
        // Everything past the owners is the TypeScript's `try`: any failure is "not available".
        let attempt = || -> Result<Page, FeedError> {
            let mut queues: Vec<Queue<'_>> = Vec::new();
            for owner in &owners {
                let Some(from) = start(owner) else {
                    continue;
                };
                let got = read(owner, from.as_ref(), limit).map_err(|_| FeedError::Unavailable)?;
                queues.push(Queue {
                    owner,
                    start: from,
                    entries: got.entries,
                    next: got.next_cursor,
                    taken: 0,
                });
            }
            let taken = merge(&mut queues, limit);
            let mut positions: Vec<(String, Pos)> = Vec::new();
            for q in &queues {
                let pos = if q.taken == q.entries.len() {
                    q.next.clone().map_or(Pos::Done, Pos::Ledger)
                } else if q.taken == 0 {
                    q.start.clone().map_or(Pos::Start, Pos::Ledger)
                } else {
                    let last = q.entries.get(q.taken - 1).ok_or(FeedError::Unavailable)?;
                    if let Some(entry_id) = &last.entry_id {
                        Pos::Ledger(ledger_cursor_below(entry_id))
                    } else {
                        let upto = read(q.owner, q.start.as_ref(), q.taken)
                            .map_err(|_| FeedError::Unavailable)?;
                        upto.next_cursor.map_or(Pos::Done, Pos::Ledger)
                    }
                };
                positions.push((q.owner.key.clone(), pos));
            }
            let picked: Vec<(&PageEntry, &Owner)> = taken
                .iter()
                .filter_map(|(qi, ei)| {
                    let q = queues.get(*qi)?;
                    Some((q.entries.get(*ei)?, q.owner))
                })
                .collect();
            let items = self.to_items(user_id, &picked, ask.need_address, ask.need_notes)?;
            let more = positions.iter().any(|(_, p)| *p != Pos::Done);
            Ok(Page {
                items,
                next_cursor: more.then(|| {
                    cursor::encode(
                        secret,
                        &Body {
                            user_id: user_id.to_owned(),
                            asset_id: asset_id.clone(),
                            owners: positions,
                            ..Body::default()
                        },
                    )
                }),
            })
        };
        attempt().map_err(|e| match e {
            FeedError::CursorInvalid => e,
            _ => FeedError::Unavailable,
        })
    }

    /// `ownersOf`: the person's own account and their named spaces, from svc-bank's table by user id.
    fn owners_of(&self, user_id: &str, asset_id: Option<&str>) -> Result<Vec<Owner>, FeedError> {
        let named: Vec<SpaceRef> = self
            .spaces
            .all_named(user_id, asset_id)?
            .into_iter()
            .filter(|s| s.kind == "named" && s.user_id == user_id)
            .collect();
        if named.len() + 1 > MAX_OWNERS {
            return Err(FeedError::Unavailable);
        }
        let mut out = vec![Owner {
            key: "u".to_owned(),
            owner_type: "user",
            owner_id: user_id.to_owned(),
            space_name: None,
        }];
        out.extend(named.into_iter().map(|s| Owner {
            key: format!("s:{}", s.id),
            owner_type: "subaccount",
            owner_id: s.id,
            space_name: Some(s.name),
        }));
        Ok(out)
    }

    /// `assertAccount`: `main`, or one of the person's own spaces.
    fn assert_account(
        &self,
        user_id: &str,
        asset_id: Option<&str>,
        account_id: &str,
    ) -> Result<(), FeedError> {
        if account_id == "main" {
            return Ok(());
        }
        let owners = self.owners_of(user_id, asset_id)?;
        if owners.iter().any(|o| o.key == format!("s:{account_id}")) {
            Ok(())
        } else {
            Err(FeedError::AccountUnknown)
        }
    }

    fn to_items(
        &self,
        user_id: &str,
        taken: &[(&PageEntry, &Owner)],
        need_address: bool,
        need_notes: bool,
    ) -> Result<Vec<Item>, FeedError> {
        let mut halves: BTreeMap<&str, usize> = BTreeMap::new();
        for (e, _) in taken {
            if TRANSFER_REASONS.contains(&format!("{}/{}", e.module, e.reason).as_str()) {
                *halves.entry(e.tx_id.as_str()).or_default() += 1;
            }
        }
        let mut withdrawals: BTreeMap<String, String> = BTreeMap::new();
        for (e, _) in taken {
            if let Some(id) = e.withdrawal_id.as_deref().and_then(withdrawal_of) {
                withdrawals.insert(e.tx_id.clone(), id.to_owned());
            }
        }
        let mut seen: BTreeMap<String, usize> = BTreeMap::new();
        let mut items: Vec<Item> = Vec::new();
        for (e, owner) in taken {
            let dir = kind::direction_of(&e.direction);
            let own = halves.get(e.tx_id.as_str()).copied().unwrap_or(0) >= 2;
            let base = format!("{}:{}:{}:{dir}", e.tx_id, owner.key, e.asset_id);
            let n = seen.get(&base).copied().unwrap_or(0);
            seen.insert(base.clone(), n + 1);
            let line = Item {
                id: if n == 0 { base } else { format!("{base}#{n}") },
                kind: if own {
                    "space_move"
                } else {
                    kind::classify(
                        &e.module,
                        &e.reason,
                        &e.direction,
                        e.rail.as_ref().and_then(Option::as_deref),
                        e.product.as_ref().and_then(Option::as_deref),
                    )
                },
                direction: dir,
                asset: e.asset_id.clone(),
                amount: e.amount,
                posted_at: e.posted_at,
                tx_id: e.tx_id.clone(),
                counterparty: None,
                space_name: owner.space_name.clone(),
                order_id: e.order_id.clone(),
                purchase: is_purchase(e, dir),
                note: None,
                reference: None,
                private_note: None,
                report_description: None,
                dispute: None,
                address: None,
                held_at: None,
                fees: None,
            };
            items.extend(with_own_fee(line, e.fee.as_ref()));
        }
        let transfer = |i: &Item| i.kind == "transfer_in" || i.kind == "transfer_out";
        let wanted = unique(items.iter().filter(|i| transfer(i)).map(|i| &i.tx_id));
        if let Some(resolver) = self.counterparties
            && !wanted.is_empty()
            && let Ok(handles) = resolver.handles_for(user_id, &wanted)
        {
            for i in &mut items {
                if transfer(i)
                    && let Some(h) = handles.get(&i.tx_id)
                {
                    i.counterparty = Some(h.clone());
                }
            }
        }
        let mut personal: BTreeSet<String> = BTreeSet::new();
        if let Some(facts) = self.facts
            && !wanted.is_empty()
            && let Ok(recorded) = facts.for_transfers(user_id, &wanted)
        {
            apply_facts(&mut items, &recorded, &mut personal);
        }
        self.with_records(
            user_id,
            items,
            &personal,
            need_address,
            need_notes,
            &withdrawals,
        )
    }

    /// `withAddresses`.
    fn with_addresses(
        &self,
        user_id: &str,
        mut items: Vec<Item>,
        records: &dyn Records,
        need_address: bool,
        withdrawals: &BTreeMap<String, String>,
    ) -> Result<Vec<Item>, FeedError> {
        if !records.looks_up_addresses() {
            if need_address {
                return Err(FeedError::Unavailable);
            }
            return Ok(items);
        }
        let tx_ids = unique(
            items
                .iter()
                .filter(|i| i.kind == "withdrawal")
                .map(|i| &i.tx_id),
        );
        if tx_ids.is_empty() {
            return Ok(items);
        }
        let mut by_tx = match records.addresses_for(user_id, &tx_ids) {
            Ok(m) => m,
            Err(_) if need_address => return Err(FeedError::Unavailable),
            Err(_) => return Ok(items),
        };
        let paid: Vec<&String> = tx_ids
            .iter()
            .filter(|t| !by_tx.contains_key(*t) && withdrawals.get(*t).is_some_and(|w| is_uuid(w)))
            .collect();
        match self.pay {
            Some(pay) if !paid.is_empty() => {
                let ids = unique(paid.iter().filter_map(|t| withdrawals.get(*t)));
                match pay.addresses_for(user_id, &ids) {
                    None if need_address => return Err(FeedError::Unavailable),
                    None => {}
                    Some(answer) => {
                        for t in &paid {
                            if let Some(a) = withdrawals.get(*t).and_then(|w| answer.get(w)) {
                                by_tx.insert((*t).clone(), a.clone());
                            }
                        }
                    }
                }
            }
            None if !paid.is_empty() && need_address => return Err(FeedError::Unavailable),
            _ => {}
        }
        for i in &mut items {
            if i.kind == "withdrawal"
                && let Some(a) = by_tx.get(&i.tx_id)
            {
                i.address = Some(a.clone());
            }
        }
        Ok(items)
    }

    /// `withTransferFacts`: a partner line of a send to another person, with that send's words and the other handle.
    fn with_transfer_facts(
        &self,
        user_id: &str,
        mut items: Vec<Item>,
    ) -> (Vec<Item>, BTreeSet<String>) {
        let mut personal = BTreeSet::new();
        let wanted = unique(
            items
                .iter()
                .filter(|i| i.kind == "transfer_in" || i.kind == "transfer_out")
                .map(|i| &i.tx_id),
        );
        let Some(facts) = self.facts else {
            return (items, personal);
        };
        if wanted.is_empty() {
            return (items, personal);
        }
        if let Ok(recorded) = facts.for_transfers(user_id, &wanted) {
            apply_facts(&mut items, &recorded, &mut personal);
        }
        (items, personal)
    }

    /// `withRecords`: a personal send already took its words from its record; a space move takes them from its
    /// transfer message; private notes and disputes are the caller's own on any line.
    fn with_records(
        &self,
        user_id: &str,
        items: Vec<Item>,
        personal: &BTreeSet<String>,
        need_address: bool,
        need_notes: bool,
        withdrawals: &BTreeMap<String, String>,
    ) -> Result<Vec<Item>, FeedError> {
        let Some(records) = self.records else {
            if need_address || need_notes {
                return Err(FeedError::Unavailable);
            }
            return Ok(items);
        };
        if items.is_empty() {
            return Ok(items);
        }
        let mut items = self.with_addresses(user_id, items, records, need_address, withdrawals)?;
        let refs: Vec<(String, String)> = items
            .iter()
            .map(|i| (i.id.clone(), i.tx_id.clone()))
            .collect();
        let notes = match records.for_items(user_id, &refs) {
            Ok(n) => n,
            Err(_) if need_notes => return Err(FeedError::Unavailable),
            Err(_) => return Ok(items),
        };
        for i in &mut items {
            let Some(n) = notes.get(&i.id) else {
                continue;
            };
            let p = personal.contains(&i.tx_id);
            if !p && let Some(v) = n.note.as_ref().filter(|v| !v.is_empty()) {
                i.note = Some(v.clone());
            }
            if !p && let Some(v) = n.reference.as_ref().filter(|v| !v.is_empty()) {
                i.reference = Some(v.clone());
            }
            if let Some(v) = n.private_note.as_ref().filter(|v| !v.is_empty()) {
                i.private_note = Some(v.clone());
            }
            if let Some(v) = n.report_description.as_ref().filter(|v| !v.is_empty()) {
                i.report_description = Some(v.clone());
            }
            if let Some(d) = &n.dispute {
                i.dispute = Some(d.clone());
            }
        }
        Ok(items)
    }
}

fn apply_facts(
    items: &mut [Item],
    recorded: &BTreeMap<String, Fact>,
    personal: &mut BTreeSet<String>,
) {
    for i in items {
        if !(i.kind == "transfer_in" || i.kind == "transfer_out") {
            continue;
        }
        let Some(fact) = recorded.get(&i.tx_id) else {
            continue;
        };
        personal.insert(i.tx_id.clone());
        if let Some(h) = fact.counterparty_handle.as_ref().filter(|h| !h.is_empty()) {
            i.counterparty = Some(h.clone());
        }
        if let Some(n) = fact.note.as_ref().filter(|n| !n.is_empty()) {
            i.note = Some(n.clone());
        }
        if let Some(r) = fact.reference.as_ref().filter(|r| !r.is_empty()) {
            i.reference = Some(r.clone());
        }
        i.fees = Some(fact.fees.clone());
    }
}

/// `[...new Set(values)]`: first-seen order.
fn unique<'s>(values: impl Iterator<Item = &'s String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for v in values {
        if !out.contains(v) {
            out.push(v.clone());
        }
    }
    out
}

/// The k-way merge of the owners' newest-first queues: (queue, entry) pairs in page order. Each owner's own order is
/// kept, and a transaction whose other half is in hand is never split.
fn merge(queues: &mut [Queue<'_>], limit: usize) -> Vec<(usize, usize)> {
    let head = |queues: &[Queue<'_>]| -> Option<usize> {
        let mut best: Option<usize> = None;
        for (i, q) in queues.iter().enumerate() {
            let Some(e) = q.entries.get(q.taken) else {
                continue;
            };
            let better = match best.and_then(|b| queues.get(b)) {
                None => true,
                Some(b) => b
                    .entries
                    .get(b.taken)
                    .is_some_and(|be| after(be, e) == std::cmp::Ordering::Greater),
            };
            if better {
                best = Some(i);
            }
        }
        best
    };
    let mut out: Vec<(usize, usize)> = Vec::new();
    while out.len() < limit {
        let Some(i) = head(queues) else {
            break;
        };
        if let Some(q) = queues.get_mut(i) {
            out.push((i, q.taken));
            q.taken += 1;
        }
    }
    while let Some(i) = head(queues) {
        let Some(&(lq, le)) = out.last() else {
            break;
        };
        let last_tx = queues
            .get(lq)
            .and_then(|q| q.entries.get(le))
            .map(|e| e.tx_id.clone());
        let Some(q) = queues.get_mut(i) else {
            break;
        };
        if q.entries.get(q.taken).map(|e| &e.tx_id) != last_tx.as_ref() {
            break;
        }
        out.push((i, q.taken));
        q.taken += 1;
    }
    out
}

/// `assetPageOf`: the asset the first purchase line brought in, when it is a plain code.
pub fn asset_page_of(lines: &[Item]) -> Option<String> {
    let bought = lines.iter().find(|l| l.purchase)?;
    let a = &bought.asset;
    ((1..=16).contains(&a.len())
        && a.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
    .then(|| format!("/coin/{a}"))
}
