//! The total-value rule (`portfolio/valuation.ts`, UI-SPEC §1.2), written once here: USDT, USDC and USD count as
//! exactly 1 USD ("cash"); any other asset is priced at the last price of its asset/USDT market, else its asset/USDC
//! market; no price means `unpriced`, never a guess and never zero. svc-trade leaves out a market whose book it cannot
//! read: listed markets with none of them answered means svc-matching is down and the call refuses
//! `bank.prices_unavailable`. `change24hUsd` is the price move on current holdings, not profit and loss, and null when
//! any priced coin has no 24 h open. Per-asset values keep 18 places; the headline figures are rounded once, half away
//! from zero, to 2 places.

use std::collections::{BTreeMap, HashMap, HashSet};

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, mul};

use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::ports::LedgerBalance;

/// `PRICES_UNAVAILABLE_COPY`.
pub const PRICES_UNAVAILABLE_COPY: &str =
    "Prices can't be loaded right now, so your total can't be shown. Try again in a minute.";

/// `PAR_ASSETS`: counted as exactly 1 USD.
pub const PAR_ASSETS: [&str; 3] = ["USDT", "USDC", "USD"];

/// `PRICE_QUOTES`, tried in order.
pub const PRICE_QUOTES: [&str; 2] = ["USDT", "USDC"];

/// `LOCK_KIND_LIST` (ledger-client `types.ts`), in `ACCOUNT_KINDS` order.
pub const LOCK_KINDS: [&str; 4] = ["hold", "escrow", "stake", "collateral"];

const DAY_MS: i64 = 86_400_000;
const CENT_UNIT: Amount = 10_000_000_000_000_000;
/// The purpose prefix of an earn position's stake account (`earnStakeAccount`).
const EARN_PURPOSE: &str = "bank:earn:";

/// `bank.prices_unavailable`.
pub fn unavailable() -> Refusal {
    refuse("bank.prices_unavailable", PRICES_UNAVAILABLE_COPY)
}

pub fn is_par(asset: &str) -> bool {
    PAR_ASSETS.contains(&asset.to_uppercase().as_str())
}

/// One holding: what the ledger says the person owns of one asset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Holding {
    pub asset_id: String,
    /// Spendable (`available` accounts).
    pub free: Amount,
    /// Locked (hold, escrow, stake, collateral).
    pub used: Amount,
    /// The part of `used` in the bank's earn positions; `None` for none.
    pub earn: Option<Amount>,
    pub total: Amount,
}

/// What the valuation needs from one svc-trade ticker. Anything unknown is `None`.
#[derive(Debug, Clone, PartialEq)]
pub struct TickerQuote {
    pub last: Option<Amount>,
    pub open: Option<Amount>,
    /// Epoch ms the 24 h stats really start at (a finite number as svc-trade sent it).
    pub window_start: Option<f64>,
}

/// The tickers (by upper-case unified symbol) and the listed spot markets.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PriceBook {
    pub tickers: HashMap<String, TickerQuote>,
    pub listed: HashSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PricedRow {
    pub asset: String,
    pub amount: String,
    pub price_usd: String,
    pub value_usd: String,
    pub change24h_usd: Option<String>,
    pub pair: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnpricedRow {
    pub asset: String,
    pub amount: String,
    /// `no_market` or `no_price_yet`.
    pub reason: &'static str,
}

impl UnpricedRow {
    pub fn json(&self) -> Json {
        Json::obj([
            ("asset", Json::str(self.asset.clone())),
            ("amount", Json::str(self.amount.clone())),
            ("reason", Json::str(self.reason)),
        ])
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Summary {
    pub total_usd: Option<String>,
    pub change24h_usd: Option<String>,
    pub cash_usd: Option<String>,
    pub crypto_usd: Option<String>,
    pub priced: Vec<PricedRow>,
    pub unpriced: Vec<UnpricedRow>,
    pub as_of: i64,
    pub window_start: Option<f64>,
}

fn opt(s: Option<&String>) -> Json {
    s.map_or(Json::Null, |v| Json::str(v.clone()))
}

impl Summary {
    /// The answer in `portfolioSummaryOutput`'s key order.
    pub fn fields(&self) -> Vec<(String, Json)> {
        let priced = self
            .priced
            .iter()
            .map(|r| {
                Json::obj([
                    ("asset", Json::str(r.asset.clone())),
                    ("amount", Json::str(r.amount.clone())),
                    ("priceUsd", Json::str(r.price_usd.clone())),
                    ("valueUsd", Json::str(r.value_usd.clone())),
                    ("change24hUsd", opt(r.change24h_usd.as_ref())),
                    ("pair", opt(r.pair.as_ref())),
                ])
            })
            .collect();
        vec![
            ("totalUsd".to_owned(), opt(self.total_usd.as_ref())),
            ("change24hUsd".to_owned(), opt(self.change24h_usd.as_ref())),
            ("cashUsd".to_owned(), opt(self.cash_usd.as_ref())),
            ("cryptoUsd".to_owned(), opt(self.crypto_usd.as_ref())),
            ("priced".to_owned(), Json::Array(priced)),
            (
                "unpriced".to_owned(),
                Json::Array(self.unpriced.iter().map(UnpricedRow::json).collect()),
            ),
            ("asOf".to_owned(), Json::int(self.as_of)),
            (
                "windowStart".to_owned(),
                self.window_start.map_or(Json::Null, Json::Number),
            ),
        ]
    }
}

/// `holdingsFromBalances`: free = available, used = every lock kind, total = free + used, earn = the bank's earn
/// stakes. Assets in code-unit order; a zero or negative total is dropped.
pub fn holdings_from_balances(rows: &[LedgerBalance]) -> Vec<Holding> {
    let mut free: BTreeMap<String, Amount> = BTreeMap::new();
    let mut used: BTreeMap<String, Amount> = BTreeMap::new();
    let mut earn: BTreeMap<String, Amount> = BTreeMap::new();
    for row in rows {
        let asset = row.asset_id.clone();
        if row.kind == "available" {
            *free.entry(asset).or_insert(0) += row.amount;
        } else if LOCK_KINDS.contains(&row.kind.as_str()) {
            *used.entry(asset.clone()).or_insert(0) += row.amount;
            if row.kind == "stake" && row.purpose.starts_with(EARN_PURPOSE) {
                *earn.entry(asset).or_insert(0) += row.amount;
            }
        }
    }
    let mut assets: Vec<&String> = free.keys().chain(used.keys()).collect();
    assets.sort();
    assets.dedup();
    let mut out = Vec::new();
    for asset in assets {
        let f = free.get(asset).copied().unwrap_or(0);
        let u = used.get(asset).copied().unwrap_or(0);
        let e = earn.get(asset).copied().unwrap_or(0);
        if f + u > 0 {
            out.push(Holding {
                asset_id: asset.clone(),
                free: f,
                used: u,
                earn: (e > 0).then_some(e),
                total: f + u,
            });
        }
    }
    out
}

/// `needsPrices`: a held asset needs a market price.
pub fn needs_prices(holdings: &[Holding]) -> bool {
    holdings.iter().any(|h| !is_par(&h.asset_id))
}

/// `formatUsd2`: 2 places, half away from zero.
pub fn format_usd2(value: Amount) -> String {
    let negative = value < 0;
    let abs = value.unsigned_abs();
    let unit = CENT_UNIT.unsigned_abs();
    let mut cents = abs / unit;
    if (abs % unit) * 2 >= unit {
        cents += 1;
    }
    format!(
        "{}{}.{:02}",
        if negative && cents != 0 { "-" } else { "" },
        cents / 100,
        cents % 100
    )
}

/// `String#localeCompare` for asset codes (printable ASCII), as ICU's root collation orders them: each character by
/// its primary weight (punctuation, then digits, then letters without case), and on a tie lower case first.
pub fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    const ORDER: &str = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStTuUvVwWxXyYzZ";
    fn primary(c: char) -> (usize, char) {
        match ORDER.find(c.to_ascii_lowercase()) {
            Some(at) => (at, '\0'),
            None => (ORDER.len(), c),
        }
    }
    a.chars()
        .map(primary)
        .cmp(b.chars().map(primary))
        .then_with(|| {
            a.chars()
                .map(|c| !c.is_ascii_lowercase())
                .cmp(b.chars().map(|c| !c.is_ascii_lowercase()))
        })
}

struct Counted {
    row: PricedRow,
    value: Amount,
    change: Option<Amount>,
    cash: bool,
}

/// `valuePortfolio`.
pub fn value_portfolio(
    holdings: &[Holding],
    book: &PriceBook,
    now_ms: i64,
) -> Result<Summary, Refusal> {
    let tickers = &book.tickers;
    let listed = &book.listed;
    if !listed.is_empty() && !listed.iter().any(|s| tickers.contains_key(s)) {
        return Err(unavailable());
    }
    let mut counted: Vec<Counted> = Vec::new();
    let mut unpriced: Vec<UnpricedRow> = Vec::new();
    let mut partial: Vec<f64> = Vec::new();
    for h in holdings {
        if h.total <= 0 {
            continue;
        }
        let asset = &h.asset_id;
        let code = asset.to_uppercase();
        if PAR_ASSETS.contains(&code.as_str()) {
            counted.push(Counted {
                row: PricedRow {
                    asset: asset.clone(),
                    amount: format_amount(h.total),
                    price_usd: "1".to_owned(),
                    value_usd: format_amount(h.total),
                    change24h_usd: Some("0".to_owned()),
                    pair: None,
                },
                value: h.total,
                change: Some(0),
                cash: true,
            });
            continue;
        }
        let mut priced = false;
        let mut market_exists = false;
        for quote in PRICE_QUOTES {
            let pair = format!("{code}/{quote}");
            let t = tickers.get(&pair);
            if t.is_some() || listed.contains(&pair) {
                market_exists = true;
            }
            let Some(t) = t else { continue };
            let Some(last) = t.last.filter(|l| *l > 0) else {
                continue;
            };
            let open = t.open.filter(|o| *o > 0);
            let value = mul(h.total, last);
            let change = open.map(|o| mul(h.total, last - o));
            #[allow(
                clippy::cast_precision_loss,
                reason = "epoch ms, as the TypeScript's number"
            )]
            let since = (now_ms - DAY_MS) as f64;
            if let Some(ws) = t.window_start
                && ws > since
            {
                partial.push(ws);
            }
            counted.push(Counted {
                row: PricedRow {
                    asset: asset.clone(),
                    amount: format_amount(h.total),
                    price_usd: format_amount(last),
                    value_usd: format_amount(value),
                    change24h_usd: change.map(format_amount),
                    pair: Some(pair),
                },
                value,
                change,
                cash: false,
            });
            priced = true;
            break;
        }
        if !priced {
            unpriced.push(UnpricedRow {
                asset: asset.clone(),
                amount: format_amount(h.total),
                reason: if market_exists {
                    "no_price_yet"
                } else {
                    "no_market"
                },
            });
        }
    }
    counted.sort_by(|a, b| {
        if a.value == b.value {
            locale_compare(&a.row.asset, &b.row.asset)
        } else {
            b.value.cmp(&a.value)
        }
    });
    unpriced.sort_by(|a, b| locale_compare(&a.asset, &b.asset));

    let nothing_held = counted.is_empty() && unpriced.is_empty();
    let any_counted = !counted.is_empty();
    let shown = any_counted || nothing_held;
    let known_change = counted.iter().all(|c| c.change.is_some());
    let total: Amount = counted.iter().map(|c| c.value).sum();
    let cash: Amount = counted.iter().filter(|c| c.cash).map(|c| c.value).sum();
    let crypto: Amount = counted.iter().filter(|c| !c.cash).map(|c| c.value).sum();
    let change: Amount = counted.iter().filter_map(|c| c.change).sum();
    let window_start = partial.into_iter().reduce(f64::max);
    Ok(Summary {
        total_usd: shown.then(|| format_usd2(total)),
        change24h_usd: if nothing_held {
            Some("0.00".to_owned())
        } else if any_counted && known_change {
            Some(format_usd2(change))
        } else {
            None
        },
        cash_usd: shown.then(|| format_usd2(cash)),
        crypto_usd: shown.then(|| format_usd2(crypto)),
        priced: counted.into_iter().map(|c| c.row).collect(),
        unpriced,
        as_of: now_ms,
        window_start,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "a test")]
    use super::*;
    use service_kit::money::parse_amount;

    const NOW: i64 = 1_700_000_000_000;

    fn amt(s: &str) -> Amount {
        parse_amount(s).unwrap()
    }

    fn h(asset: &str, total: &str, used: &str) -> Holding {
        Holding {
            asset_id: asset.to_owned(),
            free: amt(total) - amt(used),
            used: amt(used),
            earn: None,
            total: amt(total),
        }
    }

    fn q(last: Option<&str>, open: Option<&str>, ws: Option<i64>) -> TickerQuote {
        TickerQuote {
            last: last.map(amt),
            open: open.map(amt),
            #[allow(clippy::cast_precision_loss, reason = "a test's epoch ms")]
            window_start: ws.map(|w| w as f64),
        }
    }

    fn value(holdings: &[Holding], rows: &[(&str, TickerQuote)]) -> Summary {
        let book = PriceBook {
            tickers: rows
                .iter()
                .map(|(k, v)| ((*k).to_owned(), v.clone()))
                .collect(),
            listed: HashSet::new(),
        };
        value_portfolio(holdings, &book, NOW).unwrap()
    }

    fn row<'s>(s: &'s Summary, asset: &str) -> &'s PricedRow {
        s.priced.iter().find(|r| r.asset == asset).unwrap()
    }

    #[test]
    fn counts_usdt_usdc_and_usd_at_exactly_1_and_calls_them_cash_with_no_price_needed() {
        let s = value(
            &[
                h("USDT", "100.5", "0"),
                h("USDC", "20", "0"),
                h("USD", "0.25", "0"),
            ],
            &[],
        );
        assert_eq!(s.total_usd.as_deref(), Some("120.75"));
        assert_eq!(s.cash_usd.as_deref(), Some("120.75"));
        assert_eq!(s.crypto_usd.as_deref(), Some("0.00"));
        assert_eq!(s.change24h_usd.as_deref(), Some("0.00"));
        assert!(s.unpriced.is_empty());
        let got: Vec<_> = s
            .priced
            .iter()
            .map(|r| {
                (
                    r.asset.as_str(),
                    r.price_usd.as_str(),
                    r.pair.clone(),
                    r.change24h_usd.clone(),
                )
            })
            .collect();
        assert_eq!(
            got,
            vec![
                ("USDT", "1", None, Some("0".to_owned())),
                ("USDC", "1", None, Some("0".to_owned())),
                ("USD", "1", None, Some("0".to_owned())),
            ]
        );
        assert_eq!(s.as_of, NOW);
        assert_eq!(s.window_start, None);
    }

    #[test]
    fn values_a_mixed_portfolio_at_the_last_price_of_the_asset_usdt_market_and_sums_the_price_move()
    {
        let s = value(
            &[
                h("USDT", "1000", "0"),
                h("BTC", "0.5", "0"),
                h("ETH", "2", "0"),
            ],
            &[
                ("BTC/USDT", q(Some("60000"), Some("58000"), None)),
                ("ETH/USDT", q(Some("3000"), Some("3100"), None)),
            ],
        );
        assert_eq!(s.cash_usd.as_deref(), Some("1000.00"));
        assert_eq!(s.crypto_usd.as_deref(), Some("36000.00"));
        assert_eq!(s.total_usd.as_deref(), Some("37000.00"));
        assert_eq!(s.change24h_usd.as_deref(), Some("800.00"));
        assert_eq!(
            row(&s, "BTC"),
            &PricedRow {
                asset: "BTC".to_owned(),
                amount: "0.5".to_owned(),
                price_usd: "60000".to_owned(),
                value_usd: "30000".to_owned(),
                change24h_usd: Some("1000".to_owned()),
                pair: Some("BTC/USDT".to_owned()),
            }
        );
        assert_eq!(row(&s, "ETH").change24h_usd.as_deref(), Some("-200"));
    }

    #[test]
    fn lists_an_asset_with_no_market_in_unpriced_never_guessed_and_never_valued_at_zero() {
        let s = value(
            &[h("USDT", "10", "0"), h("IFC", "500", "0")],
            &[("BTC/USDT", q(Some("60000"), Some("58000"), None))],
        );
        assert_eq!(s.total_usd.as_deref(), Some("10.00"));
        assert_eq!(
            s.unpriced,
            vec![UnpricedRow {
                asset: "IFC".to_owned(),
                amount: "500".to_owned(),
                reason: "no_market"
            }]
        );
        assert_eq!(s.priced.len(), 1);
        assert_eq!(s.change24h_usd.as_deref(), Some("0.00"));
    }

    #[test]
    fn treats_another_fiat_code_as_unpriced_no_fx_source_and_a_market_that_never_traded_as_unpriced()
     {
        let s = value(
            &[h("EUR", "50", "0"), h("SOL", "3", "0")],
            &[("SOL/USDT", q(None, None, None))],
        );
        let got: Vec<_> = s
            .unpriced
            .iter()
            .map(|r| (r.asset.as_str(), r.reason))
            .collect();
        assert_eq!(got, vec![("EUR", "no_market"), ("SOL", "no_price_yet")]);
        assert_eq!(s.total_usd, None);
        assert_eq!(s.cash_usd, None);
        assert_eq!(s.crypto_usd, None);
        assert_eq!(s.change24h_usd, None);
    }

    #[test]
    fn falls_back_to_the_usdc_market_when_there_is_no_usable_usdt_price_and_prefers_usdt_when_both_exist()
     {
        let f = value(
            &[h("XYZ", "10", "0")],
            &[
                ("XYZ/USDT", q(None, None, None)),
                ("XYZ/USDC", q(Some("2.5"), Some("2"), None)),
            ],
        );
        let r = &f.priced[0];
        assert_eq!(
            (
                r.pair.as_deref(),
                r.price_usd.as_str(),
                r.value_usd.as_str(),
                r.change24h_usd.as_deref()
            ),
            (Some("XYZ/USDC"), "2.5", "25", Some("5"))
        );
        let both = value(
            &[h("XYZ", "10", "0")],
            &[
                ("XYZ/USDT", q(Some("3"), Some("3"), None)),
                ("XYZ/USDC", q(Some("2.5"), Some("2"), None)),
            ],
        );
        assert_eq!(both.priced[0].pair.as_deref(), Some("XYZ/USDT"));
        assert_eq!(both.priced[0].price_usd, "3");
    }

    #[test]
    fn does_not_cross_through_a_third_market_btc_priced_only_against_eth_stays_unpriced() {
        let s = value(
            &[h("BTC", "1", "0")],
            &[("BTC/ETH", q(Some("20"), None, None))],
        );
        assert_eq!(s.unpriced[0].reason, "no_market");
    }

    #[test]
    fn is_case_insensitive_on_the_asset_code() {
        let s = value(
            &[h("btc", "2", "0")],
            &[("BTC/USDT", q(Some("10"), Some("9"), None))],
        );
        assert_eq!(s.priced[0].asset, "btc");
        assert_eq!(s.priced[0].pair.as_deref(), Some("BTC/USDT"));
        assert_eq!(s.priced[0].value_usd, "20");
    }

    #[test]
    fn makes_change24husd_null_not_partial_when_any_priced_non_stable_asset_lacks_open24h() {
        let s = value(
            &[h("USDT", "5", "0"), h("BTC", "1", "0"), h("ETH", "1", "0")],
            &[
                ("BTC/USDT", q(Some("60000"), Some("58000"), None)),
                ("ETH/USDT", q(Some("3000"), None, None)),
            ],
        );
        assert_eq!(s.total_usd.as_deref(), Some("63005.00"));
        assert_eq!(s.change24h_usd, None);
        assert_eq!(row(&s, "BTC").change24h_usd.as_deref(), Some("2000"));
        assert_eq!(row(&s, "ETH").change24h_usd, None);
    }

    #[test]
    fn is_null_change_on_todays_svc_trade_where_every_open_is_null() {
        let s = value(
            &[h("BTC", "1", "0")],
            &[("BTC/USDT", q(Some("60000"), None, None))],
        );
        assert_eq!(s.total_usd.as_deref(), Some("60000.00"));
        assert_eq!(s.change24h_usd, None);
    }

    #[test]
    fn treats_a_zero_open_as_unknown_rather_than_dividing_or_inventing_a_move() {
        let s = value(
            &[h("BTC", "1", "0")],
            &[("BTC/USDT", q(Some("60000"), Some("0"), None))],
        );
        assert_eq!(s.change24h_usd, None);
    }

    #[test]
    fn keeps_full_precision_per_asset_for_dust_and_many_decimals_and_rounds_only_the_headline_once()
    {
        let s = value(
            &[
                h("BTC", "0.000000000000000001", "0"),
                h("ETH", "0.123456789012345678", "0"),
                h("USDT", "0.004", "0"),
            ],
            &[
                (
                    "BTC/USDT",
                    q(Some("60000.123456789012345678"), Some("59999"), None),
                ),
                ("ETH/USDT", q(Some("3000.987654321"), Some("3000"), None)),
            ],
        );
        assert_eq!(row(&s, "BTC").value_usd, "0.00000000000006");
        assert_eq!(row(&s, "ETH").amount, "0.123456789012345678");
        assert_eq!(row(&s, "ETH").value_usd, "370.492299668161862531");
        assert_eq!(s.total_usd.as_deref(), Some("370.50"));
        assert_eq!(s.cash_usd.as_deref(), Some("0.00"));
    }

    #[test]
    fn a_pure_dust_portfolio_rounds_to_0_00_but_is_still_a_counted_total_not_null() {
        let s = value(
            &[h("BTC", "0.000000000000000001", "0")],
            &[("BTC/USDT", q(Some("60000"), Some("59000"), None))],
        );
        assert_eq!(s.total_usd.as_deref(), Some("0.00"));
        assert_eq!(s.change24h_usd.as_deref(), Some("0.00"));
        assert_eq!(s.priced.len(), 1);
    }

    #[test]
    fn answers_an_empty_portfolio_with_0_00_because_the_ledger_really_holds_nothing() {
        let s = value(&[], &[]);
        for f in [&s.total_usd, &s.change24h_usd, &s.cash_usd, &s.crypto_usd] {
            assert_eq!(f.as_deref(), Some("0.00"));
        }
        assert!(s.priced.is_empty() && s.unpriced.is_empty());
    }

    #[test]
    fn ignores_zero_and_negative_holdings() {
        let neg = Holding {
            asset_id: "ETH".to_owned(),
            free: -1,
            used: 0,
            earn: None,
            total: -1,
        };
        let s = value(&[h("BTC", "0", "0"), neg], &[]);
        assert!(s.priced.is_empty() && s.unpriced.is_empty());
        assert_eq!(s.total_usd.as_deref(), Some("0.00"));
    }

    #[test]
    fn reports_windowstart_only_when_a_priced_market_is_younger_than_a_day_the_latest_start_wins() {
        let young = NOW - 5 * 3_600_000;
        let youngest = NOW - 2 * 3_600_000;
        let s = value(
            &[h("BTC", "1", "0"), h("ETH", "1", "0"), h("SOL", "1", "0")],
            &[
                ("BTC/USDT", q(Some("10"), Some("9"), Some(NOW - DAY_MS))),
                ("ETH/USDT", q(Some("10"), Some("9"), Some(young))),
                ("SOL/USDT", q(Some("10"), Some("9"), Some(youngest))),
            ],
        );
        #[allow(clippy::cast_precision_loss, reason = "a test's epoch ms")]
        let want = youngest as f64;
        assert_eq!(s.window_start, Some(want));
        let full = value(
            &[h("BTC", "1", "0")],
            &[("BTC/USDT", q(Some("10"), Some("9"), Some(NOW - DAY_MS)))],
        );
        assert_eq!(full.window_start, None);
    }

    #[test]
    fn sorts_biggest_value_first_ties_by_asset_code() {
        let s = value(
            &[h("AAA", "1", "0"), h("BBB", "1", "0"), h("USDT", "5", "0")],
            &[
                ("AAA/USDT", q(Some("5"), Some("5"), None)),
                ("BBB/USDT", q(Some("9"), Some("9"), None)),
            ],
        );
        let got: Vec<_> = s.priced.iter().map(|r| r.asset.as_str()).collect();
        assert_eq!(got, vec!["BBB", "AAA", "USDT"]);
    }

    #[test]
    fn format_usd2_rounds_half_away_from_zero_to_2_decimals() {
        assert_eq!(format_usd2(amt("1.005")), "1.01");
        assert_eq!(format_usd2(amt("1.004999999999999999")), "1.00");
        assert_eq!(format_usd2(amt("-1.005")), "-1.01");
        assert_eq!(format_usd2(amt("-0.004")), "0.00");
        assert_eq!(format_usd2(0), "0.00");
        assert_eq!(
            format_usd2(amt("12345678901234567890.999")),
            "12345678901234567891.00"
        );
    }

    fn bal(asset: &str, kind: &str, amount: &str, purpose: &str) -> LedgerBalance {
        LedgerBalance {
            asset_id: asset.to_owned(),
            kind: kind.to_owned(),
            purpose: purpose.to_owned(),
            amount: amt(amount),
        }
    }

    #[test]
    fn free_is_available_used_is_every_lock_total_is_free_plus_used_earn_is_the_bank_earn_stakes() {
        let rows = [
            bal("BTC", "available", "1", ""),
            bal("BTC", "hold", "0.25", ""),
            bal("BTC", "stake", "0.5", "bank:earn:p1"),
            bal("BTC", "stake", "0.03125", "token:stake:s1"),
            bal("BTC", "collateral", "0.125", ""),
            bal("BTC", "escrow", "0.0625", ""),
            bal("USDT", "available", "10", ""),
            bal("ETH", "available", "0", ""),
        ];
        assert_eq!(
            holdings_from_balances(&rows),
            vec![
                Holding {
                    asset_id: "BTC".to_owned(),
                    free: amt("1"),
                    used: amt("0.96875"),
                    earn: Some(amt("0.5")),
                    total: amt("1.96875"),
                },
                Holding {
                    asset_id: "USDT".to_owned(),
                    free: amt("10"),
                    used: 0,
                    earn: None,
                    total: amt("10"),
                },
            ]
        );
    }

    #[test]
    fn counts_locked_only_holdings_and_needsprices_is_false_for_stable_only_books() {
        let locked = holdings_from_balances(&[bal("SOL", "stake", "4", "")]);
        assert_eq!(locked.len(), 1);
        assert_eq!((locked[0].free, locked[0].used), (0, amt("4")));
        assert!(needs_prices(&locked));
        assert!(!needs_prices(&holdings_from_balances(&[
            bal("usdt", "available", "1", ""),
            bal("USDC", "hold", "1", ""),
        ])));
        assert!(!needs_prices(&[]));
    }
}
