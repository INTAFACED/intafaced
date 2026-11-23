//! `PortfolioService` (`portfolio/portfolio-service.ts`): the person's own total, its allocation, value over time and
//! holdings change, the balance breakdown and the entries behind one balance. Balances come from svc-ledger: the
//! person's own accounts (`user` owner) plus every named Space they own (`subaccount` owner, one read per Space), Space
//! ids from svc-bank's own table filtered by the person, so another person's Space is never read. Prices come from
//! svc-trade's public tickers. If prices are needed and cannot be had the call refuses `bank.prices_unavailable`; a
//! person holding only USDT, USDC or USD needs none. Read only; `user_id` is always the verified principal.

use std::collections::{BTreeSet, HashMap};

use service_kit::json::Json;
use service_kit::money::{Amount, Rounding, format_amount, mul_div};
use service_kit::time::{Instant, js_date};

use super::allocation::{Allocation, allocate};
use super::candles::{CloseSeries, CloseSource};
use super::history::{
    HistoryError, Holdings, HoldingsChange, HoldingsHistory, ValueInputs, ValueOverTime, bucket_of,
    choose_interval, coins_of, grid_of, holdings_change, value_over_time,
};
use super::tickers::TickerSource;
use super::valuation::{
    Holding, LOCK_KINDS, PRICE_QUOTES, PriceBook, Summary, holdings_from_balances, needs_prices,
    unavailable, value_portfolio,
};
use crate::activity::pages::{HistoryPages, PageEntry, PageRequest};
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::ports::{Ledger, LedgerBalance};

/// One named Space as the service needs it (`SpaceRecord`'s id, owner, kind and name).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Named {
    pub id: String,
    pub user_id: String,
    pub kind: String,
    pub name: String,
}

/// `SpaceLister`: the person's named Spaces (live, plus archived ones that still hold value), and every named Space
/// they have owned (for a history read).
pub trait SpaceLister {
    fn named_spaces(&self, user_id: &str) -> Result<Vec<Named>, Refusal>;
    fn all_named_spaces(&self, user_id: &str) -> Result<Vec<Named>, Refusal>;
}

/// `TransferFeeReads`: the fee each of the person's own personal sends charged, by ledger transaction id.
pub trait FeeReads {
    fn fees_for(&self, user_id: &str, tx_ids: &[String])
    -> Result<HashMap<String, String>, String>;
}

/// How a call failed: a refusal, or `balanceEntries`' own two (`ActivityLookupBoundedError`,
/// `ActivityUnavailableError`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fail {
    Refused(Refusal),
    Bounded,
    Unavailable,
}

impl From<Refusal> for Fail {
    fn from(r: Refusal) -> Fail {
        Fail::Refused(r)
    }
}

/// Ledger history reads and candle reads run this many at a time.
const VALUE_READ_PARALLEL: usize = 8;
/// Entries read per ledger page, and the most pages read for one balance before it is called too long to prove.
const ENTRY_PAGE: usize = 200;
const ENTRY_MAX_PAGES: usize = 50;
pub const BALANCE_ENTRIES_DEFAULT_LIMIT: usize = 50;
pub const BALANCE_ENTRIES_MAX_LIMIT: usize = 200;

const BTC_DP: Amount = Amount::from_scaled(100_000_000);
/// 10^-8 units up to the ledger's 18 places: a count.
const BTC_SCALE_UP: i128 = 10_000_000_000;

/// `inBatches`: `each` over `items`, `VALUE_READ_PARALLEL` at a time, results in order.
fn in_batches<T: Sync, R: Send>(items: &[T], each: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let mut out = Vec::new();
    for chunk in items.chunks(VALUE_READ_PARALLEL) {
        let got: Vec<R> = std::thread::scope(|s| {
            let handles: Vec<_> = chunk.iter().map(|item| s.spawn(|| each(item))).collect();
            handles.into_iter().filter_map(|h| h.join().ok()).collect()
        });
        out.extend(got);
    }
    out
}

/// The summary's options.
#[derive(Debug, Clone, Default)]
pub struct SummaryInput<'a> {
    pub asset_id: Option<&'a str>,
    pub value_in: Option<&'a str>,
    pub display_currency: Option<&'a str>,
    pub scope: Option<&'a str>,
}

/// `balanceEntries`' input.
#[derive(Debug, Clone)]
pub struct EntriesInput<'a> {
    pub asset_id: &'a str,
    pub account_id: Option<&'a str>,
    pub cursor: Option<&'a str>,
    pub limit: usize,
}

/// The service over its ports, for one call.
pub struct Service<'a> {
    pub ledger: &'a dyn Ledger,
    pub spaces: &'a dyn SpaceLister,
    pub tickers: &'a dyn TickerSource,
    pub pages: &'a dyn HistoryPages,
    pub history: &'a dyn HoldingsHistory,
    pub closes: &'a dyn CloseSource,
    pub fees: &'a dyn FeeReads,
    pub now: Instant,
}

fn not_yours() -> Refusal {
    refuse("bank.space_not_found", "That account is not yours")
}

fn history_unavailable() -> Refusal {
    refuse(
        "bank.value_history_unavailable",
        "Value history is not available right now",
    )
}

fn ledger_read(r: Result<Vec<LedgerBalance>, String>) -> Result<Vec<LedgerBalance>, Refusal> {
    r.map_err(Refusal::Other)
}

impl Service<'_> {
    /// `displayUnit`: USD and BTC are priced from the same book; any other currency refuses by name.
    fn display_unit<'v>(
        display_currency: Option<&str>,
        value_in: Option<&'v str>,
    ) -> Result<Option<&'v str>, Refusal> {
        let Some(dc) = display_currency else {
            return Ok(value_in);
        };
        let code = dc.to_uppercase();
        match code.as_str() {
            "USD" => Ok(Some("usd")),
            "BTC" => Ok(Some("btc")),
            _ => Err(refuse(
                "bank.fx_rate_unset",
                format!("No exchange rate is set for {code}"),
            )),
        }
    }

    /// `summary`: the caller's own total; `assetId` narrows it to one asset; a BTC display adds the value in BTC.
    pub fn summary(&self, user_id: &str, input: &SummaryInput<'_>) -> Result<Json, Refusal> {
        let value_in = Self::display_unit(input.display_currency, input.value_in)?;
        let btc = value_in == Some("btc");
        let (summary, _, prices) = self.valued(user_id, input.asset_id, btc, input.scope)?;
        let mut fields = summary.fields();
        if btc {
            fields.push(("btc".to_owned(), btc_valuation(&summary, &prices)));
        }
        Ok(Json::Object(fields))
    }

    /// `allocation`: the priced holdings grouped by class and by where they sit.
    pub fn allocation(&self, user_id: &str) -> Result<Allocation, Refusal> {
        let (summary, holdings, _) = self.valued(user_id, None, false, None)?;
        let listed = self.registry();
        let kinds = if needs_prices(&holdings) {
            listed
        } else {
            Some(HashMap::new())
        };
        Ok(allocate(&summary, &holdings, kinds.as_ref()))
    }

    /// The registry's kind by upper-case asset id; `None` when it cannot be read (a failed read or a row that does not
    /// fit, as `assetsListOutputSchema.parse` refuses the whole answer).
    fn registry(&self) -> Option<HashMap<String, String>> {
        let rows = self.ledger.assets().ok()?;
        rows.iter()
            .map(|r| match (r.get("id"), r.get("kind")) {
                (Some(Json::String(id)), Some(Json::String(kind))) => {
                    Some((id.to_uppercase(), kind.clone()))
                }
                _ => None,
            })
            .collect()
    }

    fn valued(
        &self,
        user_id: &str,
        asset_id: Option<&str>,
        want_btc: bool,
        scope: Option<&str>,
    ) -> Result<(Summary, Vec<Holding>, PriceBook), Refusal> {
        let rows = self.rows_in_scope(user_id, scope)?;
        let only = asset_id.map(str::to_uppercase);
        let holdings: Vec<Holding> = holdings_from_balances(&rows)
            .into_iter()
            .filter(|h| {
                only.as_ref()
                    .is_none_or(|o| h.asset_id.to_uppercase() == *o)
            })
            .collect();
        let mut prices = PriceBook::default();
        if needs_prices(&holdings) || (want_btc && !holdings.is_empty()) {
            prices = self.tickers.prices().map_err(|_| unavailable())?;
        }
        let summary = value_portfolio(&holdings, &prices, self.now.0)?;
        Ok((summary, holdings, prices))
    }

    /// `rowsInScope`: `combined` (the default) is main plus every named Space; `main` the person's own accounts; else
    /// one of the caller's own named Spaces, refused (and never read) when it is not theirs.
    fn rows_in_scope(
        &self,
        user_id: &str,
        scope: Option<&str>,
    ) -> Result<Vec<LedgerBalance>, Refusal> {
        match scope {
            None | Some("combined") => self.everything_owned_by(user_id),
            Some("main") => ledger_read(self.ledger.balances("user", user_id)),
            Some(s) => {
                let wanted = s.to_lowercase();
                let space = self
                    .named_of(user_id)?
                    .into_iter()
                    .find(|n| n.id.to_lowercase() == wanted)
                    .ok_or_else(not_yours)?;
                ledger_read(self.ledger.balances("subaccount", &space.id))
            }
        }
    }

    fn every_named_of(&self, user_id: &str) -> Result<Vec<Named>, Refusal> {
        Ok(self
            .spaces
            .all_named_spaces(user_id)?
            .into_iter()
            .filter(|s| s.kind == "named" && s.user_id == user_id)
            .collect())
    }

    fn named_of(&self, user_id: &str) -> Result<Vec<Named>, Refusal> {
        Ok(self
            .spaces
            .named_spaces(user_id)?
            .into_iter()
            .filter(|s| s.kind == "named" && s.user_id == user_id)
            .collect())
    }

    /// `everythingOwnedBy`: main plus every named Space of this person.
    fn everything_owned_by(&self, user_id: &str) -> Result<Vec<LedgerBalance>, Refusal> {
        let named = self.named_of(user_id)?;
        let mut rows = ledger_read(self.ledger.balances("user", user_id))?;
        for s in &named {
            rows.extend(ledger_read(self.ledger.balances("subaccount", &s.id))?);
        }
        Ok(rows)
    }

    /// `accounts`: the main account, then each named Space. Names only, no amounts.
    pub fn accounts(&self, user_id: &str) -> Result<Json, Refusal> {
        let mut accounts = vec![Json::obj([
            ("accountId", Json::str("main")),
            ("walletType", Json::str("main")),
            ("name", Json::Null),
        ])];
        for s in self.named_of(user_id)? {
            accounts.push(Json::obj([
                ("accountId", Json::str(s.id)),
                ("walletType", Json::str("space")),
                ("name", Json::str(s.name)),
            ]));
        }
        Ok(Json::obj([("accounts", Json::Array(accounts))]))
    }

    /// `balanceBreakdown`: each asset split into spendable and every lock kind with the claims behind it. An asset whose
    /// accounts are all zero is absent; a negative amount is shown as it is.
    pub fn balance_breakdown(
        &self,
        user_id: &str,
        scope: &str,
        account_id: Option<&str>,
        asset_id: Option<&str>,
    ) -> Result<Json, Refusal> {
        let rows = match account_id {
            Some("main") => ledger_read(self.ledger.balances("user", user_id))?,
            Some(id) => {
                let wanted = id.to_lowercase();
                let space = self
                    .named_of(user_id)?
                    .into_iter()
                    .find(|s| s.id.to_lowercase() == wanted)
                    .ok_or_else(not_yours)?;
                ledger_read(self.ledger.balances("subaccount", &space.id))?
            }
            None if scope == "main" => ledger_read(self.ledger.balances("user", user_id))?,
            None => self.everything_owned_by(user_id)?,
        };
        let only = asset_id.map(str::to_uppercase);
        let assets: BTreeSet<&String> = rows
            .iter()
            .map(|r| &r.asset_id)
            .filter(|a| only.as_ref().is_none_or(|o| a.to_uppercase() == *o))
            .collect();
        let mut out = Vec::new();
        for asset in assets {
            let mine: Vec<&LedgerBalance> = rows
                .iter()
                .filter(|r| r.asset_id == *asset && r.amount != Amount::ZERO)
                .collect();
            if mine.is_empty() {
                continue;
            }
            let mut locked = Vec::new();
            let mut locked_sum: Amount = Amount::ZERO;
            for kind in LOCK_KINDS {
                let of_kind: Vec<&&LedgerBalance> =
                    mine.iter().filter(|r| r.kind == kind).collect();
                if of_kind.is_empty() {
                    continue;
                }
                let mut by_purpose: Vec<(String, Amount)> = Vec::new();
                for r in &of_kind {
                    let purpose = r.purpose.trim().to_owned();
                    match by_purpose.iter_mut().find(|(p, _)| *p == purpose) {
                        Some((_, a)) => *a += r.amount,
                        None => by_purpose.push((purpose, r.amount)),
                    }
                }
                by_purpose.retain(|(_, a)| *a != Amount::ZERO);
                by_purpose.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
                let amount: Amount = of_kind.iter().map(|r| r.amount).sum();
                if !by_purpose.is_empty() {
                    locked_sum += amount;
                    locked.push(Json::obj([
                        ("kind", Json::str(kind)),
                        ("amount", Json::str(format_amount(amount))),
                        (
                            "claims",
                            Json::Array(
                                by_purpose
                                    .into_iter()
                                    .map(|(p, a)| {
                                        Json::obj([
                                            ("purpose", Json::str(p)),
                                            ("amount", Json::str(format_amount(a))),
                                        ])
                                    })
                                    .collect(),
                            ),
                        ),
                    ]));
                }
            }
            let available: Amount = mine
                .iter()
                .filter(|r| r.kind == "available")
                .map(|r| r.amount)
                .sum();
            out.push(Json::obj([
                ("assetId", Json::str(asset.clone())),
                ("total", Json::str(format_amount(available + locked_sum))),
                ("available", Json::str(format_amount(available))),
                ("locked", Json::Array(locked)),
            ]));
        }
        Ok(Json::obj([("assets", Json::Array(out))]))
    }

    /// `replayInputs`: the ledger's holdings history for every account the person owns and the candles of every coin
    /// in it, over a range.
    fn replay_inputs(
        &self,
        user_id: &str,
        from: &str,
        to: Option<&str>,
        prices_optional: bool,
    ) -> Result<ValueInputs, Refusal> {
        let invalid = || {
            refuse(
                "bank.value_range_invalid",
                "The range must start before it ends, and before now",
            )
        };
        let now = self.now.0;
        let from = js_date(from).map(|t| t.0);
        let asked = match to {
            None => Some(now),
            Some(t) => js_date(t).map(|t| t.0),
        };
        // `new Date(...)` of a bad string is NaN, and NaN is never before anything.
        let (Some(from), Some(asked)) = (from, asked) else {
            return Err(invalid());
        };
        let to = asked.min(now);
        if from >= to {
            return Err(invalid());
        }
        let interval = choose_interval(from, to, now).ok_or_else(|| {
            refuse(
                "bank.value_range_too_long",
                "The range starts too long ago to be priced: pick a later start",
            )
        })?;
        let grid = grid_of(from, to, now, interval).ok_or_else(|| {
            refuse(
                "bank.value_range_invalid",
                "The range is shorter than one step of its chart: pick a longer one",
            )
        })?;
        let start = grid.samples.first().copied().unwrap_or_default();
        let end = grid.samples.last().copied().unwrap_or_default();

        let mut owners = vec![("user", user_id.to_owned())];
        owners.extend(
            self.every_named_of(user_id)?
                .into_iter()
                .map(|s| ("subaccount", s.id)),
        );
        let from_iso = Instant(start).iso();
        let bucket = bucket_of(interval);
        let answers = in_batches(&owners, |(t, id)| {
            self.history.holdings_history(t, id, &from_iso, bucket)
        });
        let mut histories: Vec<Holdings> = Vec::new();
        for a in answers {
            match a {
                Ok(h) => histories.push(h),
                Err(HistoryError::TooLarge) => {
                    return Err(refuse(
                        "bank.value_history_too_large",
                        "Too much has happened since this range starts to show at once: pick a later start",
                    ));
                }
                Err(HistoryError::Other(_)) => return Err(history_unavailable()),
            }
        }
        if histories.len() != owners.len() {
            return Err(history_unavailable());
        }

        let coins = coins_of(&histories);
        let mut closes: HashMap<String, Option<CloseSeries>> = HashMap::new();
        if !coins.is_empty() {
            let series = in_batches(&coins, |asset| {
                self.closes
                    .closes(asset, interval, Instant(start), Instant(end))
            });
            if series.len() != coins.len() && !prices_optional {
                return Err(unavailable());
            }
            for (asset, s) in coins.iter().zip(series) {
                match s {
                    Ok(found) => {
                        closes.insert(asset.clone(), found);
                    }
                    // One coin's candles that cannot be read leave that coin unpriced, not the whole answer refused.
                    Err(_) if prices_optional => {
                        closes.insert(asset.clone(), None);
                    }
                    Err(_) => return Err(unavailable()),
                }
            }
            for asset in &coins {
                closes.entry(asset.clone()).or_insert(None);
            }
        }
        Ok(ValueInputs {
            histories,
            interval,
            samples: grid.samples,
            live: grid.live,
            closes,
        })
    }

    /// `valueOverTime`.
    pub fn value_over_time(
        &self,
        user_id: &str,
        from: &str,
        to: Option<&str>,
    ) -> Result<ValueOverTime, Refusal> {
        Ok(value_over_time(
            &self.replay_inputs(user_id, from, to, false)?,
        ))
    }

    /// `holdingsChange`: only the two ends, and the amounts need no price.
    pub fn holdings_change(
        &self,
        user_id: &str,
        from: &str,
        to: Option<&str>,
    ) -> Result<HoldingsChange, Refusal> {
        let mut inputs = self.replay_inputs(user_id, from, to, true)?;
        let ends: Vec<i64> = inputs
            .samples
            .first()
            .into_iter()
            .chain(inputs.samples.last())
            .copied()
            .collect();
        inputs.samples = ends;
        Ok(holdings_change(&inputs))
    }

    /// `balanceEntries`: every ledger entry behind one asset's spendable balance, newest first, with the sum check.
    pub fn balance_entries(&self, user_id: &str, input: &EntriesInput<'_>) -> Result<Json, Fail> {
        let asset_id = input.asset_id.to_uppercase();
        let limit = input.limit.clamp(1, BALANCE_ENTRIES_MAX_LIMIT);
        if let Some(c) = input.cursor
            && !((1..=9).contains(&c.len()) && c.bytes().all(|b| b.is_ascii_digit()))
        {
            return Err(refuse("bank.activity_range", "That page marker is not valid").into());
        }
        let skip: usize = input.cursor.and_then(|c| c.parse().ok()).unwrap_or(0);

        let named = self.named_of(user_id)?;
        let mut owners: Vec<(String, &'static str, String)> = Vec::new();
        if input.account_id.is_none_or(|a| a == "main") {
            owners.push(("main".to_owned(), "user", user_id.to_owned()));
        }
        match input.account_id {
            None => {
                for s in &named {
                    owners.push((s.id.clone(), "subaccount", s.id.clone()));
                }
            }
            Some("main") => {}
            Some(id) => {
                let wanted = id.to_lowercase();
                let space = named
                    .iter()
                    .find(|s| s.id.to_lowercase() == wanted)
                    .ok_or_else(not_yours)?;
                owners.push((space.id.clone(), "subaccount", space.id.clone()));
            }
        }

        let mut all: Vec<(PageEntry, String)> = Vec::new();
        let mut balance: Amount = Amount::ZERO;
        for (account, owner_type, owner_id) in &owners {
            for r in ledger_read(self.ledger.balances(owner_type, owner_id))? {
                if r.kind == "available" && r.asset_id.to_uppercase() == asset_id {
                    balance += r.amount;
                }
            }
            let mut cursor: Option<String> = None;
            let mut page = 0;
            loop {
                if page >= ENTRY_MAX_PAGES {
                    return Err(Fail::Bounded);
                }
                page += 1;
                let got = self
                    .pages
                    .page(&PageRequest {
                        owner_type,
                        owner_id: owner_id.clone(),
                        asset_id: Some(asset_id.clone()),
                        limit: ENTRY_PAGE,
                        cursor: cursor.clone(),
                    })
                    .map_err(|_| Fail::Unavailable)?;
                for e in got.entries {
                    if e.asset_id.to_uppercase() == asset_id {
                        all.push((e, account.clone()));
                    }
                }
                match got.next_cursor {
                    None => break,
                    Some(c) => cursor = Some(c),
                }
            }
        }

        let entries_sum: Amount = all
            .iter()
            .map(|(e, _)| {
                if e.direction == "debit" {
                    e.amount
                } else {
                    -e.amount
                }
            })
            .sum();
        if entries_sum != balance {
            return Err(refuse(
                "portfolio.entries_do_not_sum",
                format!(
                    "The entries add up to {} {asset_id} but the balance is {}, a gap of {}",
                    format_amount(entries_sum),
                    format_amount(balance),
                    format_amount(entries_sum - balance)
                ),
            )
            .into());
        }

        // Newest first: by time, then by book position when the ledger sends one, then by transaction id.
        let position = |e: &PageEntry| -> i128 {
            e.entry_id
                .as_deref()
                .and_then(|s| s.parse().ok())
                .unwrap_or(-1)
        };
        all.sort_by(|(a, _), (b, _)| {
            b.posted_at
                .0
                .cmp(&a.posted_at.0)
                .then_with(|| position(b).cmp(&position(a)))
                .then_with(|| b.tx_id.encode_utf16().cmp(a.tx_id.encode_utf16()))
        });
        let count = all.len();
        let slice: Vec<&(PageEntry, String)> = all.iter().skip(skip).take(limit).collect();
        let shown = skip.saturating_add(slice.len());
        let mut fees: HashMap<String, String> = HashMap::new();
        if !slice.is_empty() {
            let mut ids: Vec<String> = Vec::new();
            for (e, _) in &slice {
                if !ids.contains(&e.tx_id) {
                    ids.push(e.tx_id.clone());
                }
            }
            // A fee that cannot be read is unknown (null), never a zero; the entries and their check stand.
            if let Ok(f) = self.fees.fees_for(user_id, &ids) {
                fees = f;
            }
        }
        let entries = slice
            .iter()
            .map(|(e, account)| {
                Json::obj([
                    ("entryId", e.entry_id.clone().map_or(Json::Null, Json::str)),
                    ("txId", Json::str(e.tx_id.clone())),
                    ("accountId", Json::str(account.clone())),
                    ("reason", Json::str(e.reason.clone())),
                    ("direction", Json::str(e.direction.clone())),
                    ("amount", Json::str(format_amount(e.amount))),
                    ("postedAt", Json::str(e.posted_at.iso())),
                    ("state", Json::str("completed")),
                    (
                        "fee",
                        fees.get(&e.tx_id).cloned().map_or(Json::Null, Json::str),
                    ),
                ])
            })
            .collect();
        #[allow(
            clippy::cast_possible_wrap,
            reason = "a list of at most 50 pages of 200"
        )]
        let entry_count = count as i64;
        Ok(Json::obj([
            ("assetId", Json::str(asset_id)),
            ("entries", Json::Array(entries)),
            (
                "nextCursor",
                if shown < count {
                    Json::str(shown.to_string())
                } else {
                    Json::Null
                },
            ),
            (
                "sumCheck",
                Json::obj([
                    ("ok", Json::Bool(true)),
                    ("entriesSum", Json::str(format_amount(entries_sum))),
                    ("balance", Json::str(format_amount(balance))),
                    ("entryCount", Json::int(entry_count)),
                ]),
            ),
        ]))
    }
}

/// `btcValuation`: the USD value of everything counted, divided by the last BTC price (BTC/USDT, else BTC/USDC),
/// rounded half-up once to 8 places. Nothing held is 0 with no price; something held and nothing priced is blank.
fn btc_valuation(summary: &Summary, prices: &PriceBook) -> Json {
    let out = |total: Option<String>, price: Option<String>, reason: Option<&str>| {
        Json::obj([
            ("total", total.map_or(Json::Null, Json::str)),
            ("priceUsd", price.map_or(Json::Null, Json::str)),
            ("reason", reason.map_or(Json::Null, Json::str)),
        ])
    };
    if summary.priced.is_empty() && summary.unpriced.is_empty() {
        return out(Some("0".to_owned()), None, None);
    }
    if summary.priced.is_empty() {
        return out(None, None, Some("nothing_priced"));
    }
    let price = PRICE_QUOTES.iter().find_map(|q| {
        prices
            .tickers
            .get(&format!("BTC/{q}"))
            .and_then(|t| t.last)
            .filter(|l| *l > Amount::ZERO)
    });
    let Some(price) = price else {
        return out(None, None, Some("no_price_published"));
    };
    let value: Amount = summary
        .priced
        .iter()
        .map(|r| service_kit::money::parse_amount(&r.value_usd).unwrap_or_default())
        .sum();
    // value / price in units of 10^-8, half-up (the value is never negative: every counted holding is above zero).
    let units = mul_div(value, BTC_DP, price, Rounding::HalfUp);
    out(
        Some(format_amount(units * BTC_SCALE_UP)),
        Some(format_amount(price)),
        None,
    )
}
