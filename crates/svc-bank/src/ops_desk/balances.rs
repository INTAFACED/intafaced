//! A customer's balances for the finance-treasury desk (`ops/customer-balances.ts`; PF-balances-01): the same split and
//! the same entries the customer reads (`portfolio-service.ts`: `balanceBreakdown(userId, 'all')` and `balanceEntries`),
//! asked for the customer the desk names. Ledger reads only; nothing is written and there is no export.
//!
//! Every read first writes one line naming the operator and the customer; a line that cannot be written refuses the read
//! (`bank.ops_audit_unavailable`). The entries' list is the asset's whole history, bounded, checked against the live
//! balance before any page of it is shown: a sum that differs refuses `portfolio.entries_do_not_sum` and names the gap.
//!
//! Where the Rust stops: the customer's own calls on these reads are slice `activity`'s. The entries' fee, which the
//! customer's page reads, is not on the desk's page (its output schema strips it), so it is not read here.

use std::collections::BTreeMap;

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount};
use service_kit::time::js_date;
use service_kit::trpc::TrpcError;

use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::ports::{HistoryEntry, HistoryRequest, Ledger, LedgerBalance};
use crate::spaces::space::{Money, Space, named_spaces};

/// `LOCK_KIND_LIST`, in `ACCOUNT_KINDS`' order.
const LOCK_KINDS: [&str; 4] = ["hold", "escrow", "stake", "collateral"];
/// Entries read per ledger page, and the most pages read for one balance before it is called too long to prove.
const ENTRY_PAGE: i64 = 200;
const ENTRY_MAX_PAGES: usize = 50;
/// `BALANCE_ENTRIES_DEFAULT_LIMIT`, `BALANCE_ENTRIES_MAX_LIMIT`.
const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 200;

/// `writeCustomerBalancesAudit`: the line is written before any figure is read, or the read refuses.
pub fn audit(actor: &str, owner: &str, what: &str) -> Result<(), Refusal> {
    write_audit(Json::obj([
        ("level", Json::str("info")),
        ("service", Json::str("svc-bank")),
        ("event", Json::str("bank.ops.customer_balances_read")),
        ("actorUserId", Json::str(actor)),
        ("ownerUserId", Json::str(owner)),
        ("what", Json::str(what)),
    ]))
}

/// `writeCustomerPartnerBalancesAudit` (J-derivatives-26 #8): the same rule for the partner-held read.
pub fn partner_audit(actor: &str, owner: &str) -> Result<(), Refusal> {
    write_audit(Json::obj([
        ("level", Json::str("info")),
        ("service", Json::str("svc-bank")),
        (
            "event",
            Json::str("bank.ops.customer_partner_balances_read"),
        ),
        ("actorUserId", Json::str(actor)),
        ("ownerUserId", Json::str(owner)),
    ]))
}

fn write_audit(line: Json) -> Result<(), Refusal> {
    use std::io::Write;
    writeln!(std::io::stdout(), "{}", line.compact()).map_err(|_| {
        refuse(
            "bank.ops_audit_unavailable",
            "The read could not be recorded, so nothing was read",
        )
    })
}

/// The owner list's cap (`OWNER_LIST_CAP`): the desk reads one page, the most the owner can ask for.
const PARTNER_SPACES_PAGE: i64 = 200;

/// `customerPartnerBalances` (J-derivatives-26 #8, `SpaceService.partnerHeldFigures`): the person's spaces with the figure
/// the partner holding their money reports, each built by `space::held_figure` as the person's own `spaces.list` builds
/// it. No partner holds their money: `heldByPartner: false` and no spaces; no ledger figure is read. Writes nothing (no
/// `ensure_held_primaries`), so a main balance whose label row the owner has not read into being yet is not listed.
pub fn partner_held(
    store: &crate::db::Store,
    money: &Money<'_>,
    user_id: &str,
) -> Result<Json, Refusal> {
    let Some(partner) = money.held(user_id) else {
        return Ok(Json::obj([
            ("userId", Json::str(user_id)),
            ("heldByPartner", Json::Bool(false)),
            ("spaces", Json::Array(Vec::new())),
        ]));
    };
    let spaces = crate::spaces::space::list(store, money, user_id, None, PARTNER_SPACES_PAGE)?;
    let reports = partner.balances(user_id, money.now);
    let mut out = Vec::new();
    for s in spaces {
        let f = crate::spaces::space::held_figure(&partner, &reports, &s, money.now)?;
        out.push(Json::obj([
            ("spaceId", Json::str(s.id.clone())),
            ("assetId", Json::str(s.asset_id.clone())),
            ("kind", Json::str(s.kind.clone())),
            ("name", Json::str(s.name.clone())),
            ("balance", Json::str(format_amount(f.amount))),
            ("source", Json::str(f.label)),
            ("asOf", Json::str(f.as_of.iso())),
            ("state", Json::str(if f.stale { "stale" } else { "known" })),
            ("staleAfterMs", Json::int(crate::partner::STALE_AFTER_MS)),
        ]));
    }
    Ok(Json::obj([
        ("userId", Json::str(user_id)),
        ("heldByPartner", Json::Bool(true)),
        ("spaces", Json::Array(out)),
    ]))
}

/// A ledger read that failed: `LedgerError`, which the guard answers opaquely.
fn ledger_failed(e: String) -> Refusal {
    Refusal::Other(e)
}

/// `namedOf`: the person's named spaces (live, and archived ones that still hold value).
fn named_of(
    store: &crate::db::Store,
    money: &Money<'_>,
    user_id: &str,
) -> Result<Vec<Space>, Refusal> {
    Ok(named_spaces(store, money, user_id)?
        .into_iter()
        .filter(|s| s.kind == "named" && s.user_id == user_id)
        .collect())
}

/// JavaScript's string order (UTF-16 code units).
fn js_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `balanceBreakdown(userId, 'all')` flattened (`flattenBreakdown`): per asset, the total, the spendable and each lock
/// kind as its own exact column (`0` when there is none).
pub fn breakdown(
    store: &crate::db::Store,
    ledger: &dyn Ledger,
    money: &Money<'_>,
    user_id: &str,
) -> Result<Json, Refusal> {
    let named = named_of(store, money, user_id)?;
    let mut rows: Vec<LedgerBalance> = ledger.balances("user", user_id).map_err(ledger_failed)?;
    for s in &named {
        rows.extend(
            ledger
                .balances("subaccount", &s.id)
                .map_err(ledger_failed)?,
        );
    }
    let mut assets: Vec<&str> = rows.iter().map(|r| r.asset_id.as_str()).collect();
    assets.sort_by(|a, b| js_cmp(a, b));
    assets.dedup();
    let mut out = Vec::new();
    for asset in assets {
        let mine: Vec<&LedgerBalance> = rows
            .iter()
            .filter(|r| r.asset_id == asset && r.amount != Amount::ZERO)
            .collect();
        if mine.is_empty() {
            continue;
        }
        let mut locked: BTreeMap<&str, Amount> = BTreeMap::new();
        for kind in LOCK_KINDS {
            let of_kind: Vec<&&LedgerBalance> = mine.iter().filter(|r| r.kind == kind).collect();
            if of_kind.is_empty() {
                continue;
            }
            let mut by_purpose: BTreeMap<String, Amount> = BTreeMap::new();
            for r in &of_kind {
                *by_purpose
                    .entry(service_kit::money::js_trim(&r.purpose).to_owned())
                    .or_insert(Amount::ZERO) += r.amount;
            }
            // A kind shows only when one of its claims is not zero; its amount is every claim's.
            if by_purpose.values().any(|a| *a != Amount::ZERO) {
                locked.insert(kind, of_kind.iter().map(|r| r.amount).sum());
            }
        }
        let available: Amount = mine
            .iter()
            .filter(|r| r.kind == "available")
            .map(|r| r.amount)
            .sum();
        let total = available + locked.values().sum::<Amount>();
        let lock = |k: &str| {
            locked
                .get(k)
                .map_or_else(|| "0".to_owned(), |a| format_amount(*a))
        };
        out.push(Json::Object(vec![
            ("assetId".to_owned(), Json::str(asset)),
            ("total".to_owned(), Json::str(format_amount(total))),
            ("available".to_owned(), Json::str(format_amount(available))),
            ("hold".to_owned(), Json::str(lock("hold"))),
            ("escrow".to_owned(), Json::str(lock("escrow"))),
            ("stake".to_owned(), Json::str(lock("stake"))),
            ("collateral".to_owned(), Json::str(lock("collateral"))),
        ]));
    }
    Ok(Json::Object(vec![
        ("userId".to_owned(), Json::str(user_id)),
        ("assets".to_owned(), Json::Array(out)),
    ]))
}

/// `ActivityUnavailableError` as `activityFailure` answers it.
fn history_unavailable() -> Refusal {
    Refusal::Trpc(TrpcError::plain(
        "SERVICE_UNAVAILABLE",
        "Activity is not available right now. Try again in a minute.",
    ))
}

/// `ActivityLookupBoundedError` as `activityFailure` answers it.
fn lookup_bounded() -> Refusal {
    Refusal::Trpc(TrpcError::caused(
        "PRECONDITION_FAILED",
        "Activity lookup stopped before the end of your history. Try again. (bank.activity_lookup_bounded)",
        "bank.activity_lookup_bounded",
    ))
}

/// One entry with the account it posted to.
struct Entry {
    e: HistoryEntry,
    account_id: String,
    posted_ms: i64,
}

/// `balanceEntries(userId, { assetId, cursor, limit })`: every entry behind the asset's spendable balance on the main
/// account and each named space, newest first, checked against the live balance, and the page the cursor names.
pub fn entries(
    store: &crate::db::Store,
    ledger: &dyn Ledger,
    money: &Money<'_>,
    user_id: &str,
    asset_id: &str,
    cursor: Option<&str>,
    limit: Option<i64>,
) -> Result<Json, Refusal> {
    let asset = asset_id.to_uppercase();
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    if let Some(c) = cursor
        && !((1..=9).contains(&c.len()) && c.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(refuse(
            "bank.activity_range",
            "That page marker is not valid",
        ));
    }
    let skip: usize = cursor
        .map_or(Ok(0), str::parse)
        .map_err(|_| refuse("bank.activity_range", "That page marker is not valid"))?;
    let named = named_of(store, money, user_id)?;
    let mut owners: Vec<(String, &str, String)> =
        vec![("main".to_owned(), "user", user_id.to_owned())];
    owners.extend(
        named
            .iter()
            .map(|s| (s.id.clone(), "subaccount", s.id.clone())),
    );
    let mut all: Vec<Entry> = Vec::new();
    let mut balance: Amount = Amount::ZERO;
    for (account_id, owner_type, owner_id) in &owners {
        for r in ledger
            .balances(owner_type, owner_id)
            .map_err(ledger_failed)?
        {
            if r.kind == "available" && r.asset_id.to_uppercase() == asset {
                balance += r.amount;
            }
        }
        let mut next: Option<String> = None;
        for page in 0.. {
            if page >= ENTRY_MAX_PAGES {
                return Err(lookup_bounded());
            }
            let got = ledger
                .history_page(&HistoryRequest {
                    owner_type,
                    owner_id,
                    asset_id: Some(&asset),
                    limit: ENTRY_PAGE,
                    cursor: next.as_deref(),
                })
                .map_err(|_| history_unavailable())?;
            for e in got.entries {
                if e.asset_id.to_uppercase() == asset {
                    // `new Date(postedAt).toISOString()` throws on a date it cannot read.
                    let posted_ms = js_date(&e.posted_at)
                        .ok_or_else(|| Refusal::Other(format!("{} is no date", e.posted_at)))?
                        .0;
                    all.push(Entry {
                        e,
                        account_id: account_id.clone(),
                        posted_ms,
                    });
                }
            }
            match got.next_cursor {
                None => break,
                Some(c) => next = Some(c),
            }
        }
    }
    let entries_sum: Amount = all
        .iter()
        .map(|x| {
            if x.e.direction == "debit" {
                x.e.amount
            } else {
                -x.e.amount
            }
        })
        .sum();
    if entries_sum != balance {
        return Err(refuse(
            "portfolio.entries_do_not_sum",
            format!(
                "The entries add up to {} {asset} but the balance is {}, a gap of {}",
                format_amount(entries_sum),
                format_amount(balance),
                format_amount(entries_sum - balance)
            ),
        ));
    }
    // Newest first: by time, then by book position when the ledger sends one, then by transaction id.
    let pos = |x: &Entry| {
        x.e.entry_id
            .as_deref()
            .map_or(-1, |id| id.parse::<i128>().unwrap_or(-1))
    };
    all.sort_by(|a, b| {
        b.posted_ms
            .cmp(&a.posted_ms)
            .then_with(|| pos(b).cmp(&pos(a)))
            .then_with(|| js_cmp(&b.e.tx_id, &a.e.tx_id))
    });
    let page: Vec<&Entry> = all
        .iter()
        .skip(skip)
        .take(usize::try_from(limit).unwrap_or(0))
        .collect();
    let shown = skip + page.len();
    let k = |k: &str, v: Json| (k.to_owned(), v);
    let rows = page
        .iter()
        .map(|x| {
            Json::Object(vec![
                k(
                    "entryId",
                    x.e.entry_id.clone().map_or(Json::Null, Json::str),
                ),
                k("txId", Json::str(x.e.tx_id.clone())),
                k("accountId", Json::str(x.account_id.clone())),
                k("reason", Json::str(x.e.reason.clone())),
                k("direction", Json::str(x.e.direction.clone())),
                k("amount", Json::str(format_amount(x.e.amount))),
                k(
                    "postedAt",
                    Json::str(service_kit::time::Instant(x.posted_ms).iso()),
                ),
            ])
        })
        .collect();
    let count = i64::try_from(all.len()).unwrap_or(i64::MAX);
    Ok(Json::Object(vec![
        k("assetId", Json::str(asset)),
        k("entries", Json::Array(rows)),
        k(
            "nextCursor",
            if shown < all.len() {
                Json::str(shown.to_string())
            } else {
                Json::Null
            },
        ),
        k(
            "sumCheck",
            Json::Object(vec![
                k("ok", Json::Bool(true)),
                k("entriesSum", Json::str(format_amount(entries_sum))),
                k("balance", Json::str(format_amount(balance))),
                k("entryCount", Json::int(count)),
            ]),
        ),
    ]))
}
