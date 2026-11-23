//! `loans/prices.ts`: marks, where a wrong number becomes someone else's liquidation.
//!
//! §8.1 asks for "marks from svc-trade index prices", but svc-trade has no index price: its ticker gives best bid,
//! best ask and LAST TRADE from one in-memory book. A book marked off `last` inherits every property of `last`: one
//! small print on a thin market marks every loan on that asset down (or up) at once. This file does not pretend to
//! fix that. It makes the mark an explicit port (`PriceSource`), so an index price is one adapter; it refuses marks
//! that are stale, non-positive or moved further in one interval than a real market does; and it keeps what a mark is
//! good enough FOR apart: a margin call on a questionable mark costs a notification, a liquidation costs the
//! collateral, and they never share a threshold. Until svc-trade has an index, `TickerPriceSource` reads mid-of-book
//! where a two-sided quote exists, falls back to `last`, and labels which, so `MarkPolicy` refuses to liquidate on the
//! weaker one.

use std::collections::BTreeMap;

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, Rounding, format_amount, mul_div, parse_amount};
use service_kit::time::{Instant, time_clip};

use super::risk::Mark;
use crate::errors::Refusal;
use crate::partner::refuse;

const ONE: Amount = Amount::whole(1);

/// `MarkQuality`: how the mark was derived. The liquidation gate cares which.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarkQuality {
    /// Mid of a two-sided quote. The best this platform can currently produce.
    Mid,
    /// Last trade. One print moves it.
    Last,
    /// A real index feed. Nothing produces this yet; the branch exists so the adapter has somewhere to land.
    Index,
}

impl MarkQuality {
    /// The TypeScript's string: `mid`, `last`, `index`.
    pub fn as_str(self) -> &'static str {
        match self {
            MarkQuality::Mid => "mid",
            MarkQuality::Last => "last",
            MarkQuality::Index => "index",
        }
    }
}

/// `QuotedMark`: a `Mark` and its quality.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuotedMark {
    pub mark: Mark,
    pub quality: MarkQuality,
}

impl QuotedMark {
    pub fn new(
        asset_id: impl Into<String>,
        price: Amount,
        as_of: Instant,
        quality: MarkQuality,
    ) -> QuotedMark {
        QuotedMark {
            mark: Mark {
                asset_id: asset_id.into(),
                price,
                as_of,
            },
            quality,
        }
    }
}

impl AsRef<Mark> for QuotedMark {
    fn as_ref(&self) -> &Mark {
        &self.mark
    }
}

/// The marks a source answers, by asset id.
pub type Marks = BTreeMap<String, QuotedMark>;

/// `PriceSource`: the port. One method, because a mark is one question. Marks are in the quote asset; a missing asset
/// is omitted, never defaulted, so `risk.rs` refuses to value a holding whose mark is absent.
pub trait PriceSource: Send + Sync {
    fn marks(&self, asset_ids: &[String], quote_asset_id: &str) -> Marks;
}

/// `MarkPolicy`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkPolicy {
    /// Older than this and the mark is not a price, it is a memory.
    pub max_age_seconds: i64,
    /// The staleness limit for a liquidation, tighter than a warning's on purpose: refusing to warn leaves the
    /// borrower uninformed; refusing to sell on the same mark leaves them their collateral.
    pub liquidation_max_age_seconds: i64,
    /// A circuit breaker, not a price opinion: a mark that moved further than this from the last accepted one is no
    /// liquidation basis. A genuine crash liquidates one interval later; a spoofed print never does.
    pub max_deviation_bps: i64,
    /// Mark qualities a liquidation may be based on.
    pub liquidation_qualities: Vec<MarkQuality>,
}

/// `DEFAULT_MARK_POLICY`. `last` is deliberately absent: a market with no two-sided quote cannot be liquidated at all,
/// the loan sits in margin call and an operator looks at it. An illiquid book is where a forced sale does most damage.
pub fn default_mark_policy() -> MarkPolicy {
    MarkPolicy {
        max_age_seconds: 300,
        liquidation_max_age_seconds: 60,
        max_deviation_bps: 2_000,
        liquidation_qualities: vec![MarkQuality::Index, MarkQuality::Mid],
    }
}

/// `MarkCheck`: `ok` with no reason, or the reason it is not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkCheck {
    pub ok: bool,
    pub reason: Option<String>,
}

impl MarkCheck {
    fn ok() -> MarkCheck {
        MarkCheck {
            ok: true,
            reason: None,
        }
    }

    fn no(reason: String) -> MarkCheck {
        MarkCheck {
            ok: false,
            reason: Some(reason),
        }
    }
}

/// `Math.round(ms / 1000)`: half up, toward +∞.
fn round_seconds(ms: i64) -> i64 {
    ms.saturating_add(500).div_euclid(1_000)
}

/// `acceptableForMarking`: is this mark fit to warn a borrower on?
pub fn acceptable_for_marking(mark: &QuotedMark, now: Instant, policy: &MarkPolicy) -> MarkCheck {
    let m = &mark.mark;
    if m.price <= Amount::ZERO {
        return MarkCheck::no(format!(
            "{}: non-positive mark {}",
            m.asset_id,
            format_amount(m.price)
        ));
    }
    let age_ms = now.0.saturating_sub(m.as_of.0);
    if i128::from(age_ms) > i128::from(policy.max_age_seconds) * 1_000 {
        return MarkCheck::no(format!(
            "{}: mark is {}s old, limit {}s",
            m.asset_id,
            round_seconds(age_ms),
            policy.max_age_seconds
        ));
    }
    if age_ms < -30_000 {
        // A mark from the future is a clock problem, and clock problems are how a stale price passes a staleness
        // check.
        return MarkCheck::no(format!(
            "{}: mark is dated {}s in the future",
            m.asset_id,
            round_seconds(age_ms.saturating_neg())
        ));
    }
    MarkCheck::ok()
}

/// `acceptableForLiquidation`: is this mark fit to SEIZE COLLATERAL on? A strictly higher bar. `previous` is the
/// last mark this loan was accepted against; `None` skips the breaker, which is safe for a loan's first mark because
/// `plan_liquidation` also needs an already-open margin call.
pub fn acceptable_for_liquidation(
    mark: &QuotedMark,
    previous: Option<Amount>,
    now: Instant,
    policy: &MarkPolicy,
) -> MarkCheck {
    let base = acceptable_for_marking(mark, now, policy);
    if !base.ok {
        return base;
    }
    let m = &mark.mark;

    if !policy.liquidation_qualities.contains(&mark.quality) {
        let allowed: Vec<&str> = policy
            .liquidation_qualities
            .iter()
            .map(|q| q.as_str())
            .collect();
        return MarkCheck::no(format!(
            "{}: mark quality \"{}\" is not a liquidation basis (allowed: {}) — a single print must not seize collateral",
            m.asset_id,
            mark.quality.as_str(),
            allowed.join(", ")
        ));
    }

    let age_ms = now.0.saturating_sub(m.as_of.0);
    if i128::from(age_ms) > i128::from(policy.liquidation_max_age_seconds) * 1_000 {
        return MarkCheck::no(format!(
            "{}: mark is {}s old, liquidation limit {}s",
            m.asset_id,
            round_seconds(age_ms),
            policy.liquidation_max_age_seconds
        ));
    }

    if let Some(previous) = previous
        && previous > Amount::ZERO
    {
        let delta = if m.price > previous {
            m.price - previous
        } else {
            previous - m.price
        };
        // Integer bps, rounded up so a move exactly on the breaker trips it.
        // A count of basis points: the ratio of two amounts times 10,000, read off the quotient's scaled integer.
        let deviation_bps =
            mul_div(delta, Amount::from_scaled(10_000), previous, Rounding::Ceil).scaled();
        if deviation_bps > i128::from(policy.max_deviation_bps) {
            return MarkCheck::no(format!(
                "{}: mark moved {deviation_bps}bps from {} to {}, breaker at {}bps — not liquidating through it",
                m.asset_id,
                format_amount(previous),
                format_amount(m.price),
                policy.max_deviation_bps
            ));
        }
    }
    MarkCheck::ok()
}

/// `assertAcceptableForLiquidation`: refuses `bank.mark_unusable`.
pub fn assert_acceptable_for_liquidation(
    mark: &QuotedMark,
    previous: Option<Amount>,
    now: Instant,
    policy: &MarkPolicy,
) -> Result<(), Refusal> {
    let check = acceptable_for_liquidation(mark, previous, now, policy);
    if check.ok {
        return Ok(());
    }
    Err(refuse(
        "bank.mark_unusable",
        format!(
            "Refusing to liquidate on this mark — {}",
            check.reason.unwrap_or_default()
        ),
    ))
}

// ── Adapters ─────────────────────────────────────────────────────────────────

/// A source's clock: `Date#getTime()` now.
pub type Clock = Box<dyn Fn() -> Instant + Send + Sync>;

/// The wall clock, in whole milliseconds.
pub fn system_clock() -> Instant {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
    Instant(ms)
}

/// `fixedPriceSource`: a mark that is always the same, for the identity case and for tests. `clock` exists because
/// the staleness guards compare `as_of` against the caller's `now`, and a source that stamps wall-clock time hands a
/// test working at a fixed instant marks from the future.
pub struct FixedPriceSource {
    prices: BTreeMap<String, (Amount, MarkQuality)>,
    clock: Clock,
}

impl FixedPriceSource {
    /// `fixedPriceSource({})`: no marks for anything.
    pub fn empty() -> FixedPriceSource {
        FixedPriceSource {
            prices: BTreeMap::new(),
            clock: Box::new(system_clock),
        }
    }

    /// `prices` is `(asset, decimal price, quality)`, quality `mid` when `None`. A malformed price is `parseAmount`'s
    /// error here, where the TypeScript throws it from `marks`.
    pub fn new(
        prices: &[(&str, &str, Option<MarkQuality>)],
        clock: Clock,
    ) -> Result<FixedPriceSource, String> {
        let mut parsed = BTreeMap::new();
        for (asset, price, quality) in prices {
            parsed.insert(
                (*asset).to_owned(),
                (parse_amount(price)?, quality.unwrap_or(MarkQuality::Mid)),
            );
        }
        Ok(FixedPriceSource {
            prices: parsed,
            clock,
        })
    }
}

impl PriceSource for FixedPriceSource {
    fn marks(&self, asset_ids: &[String], quote_asset_id: &str) -> Marks {
        let mut out = Marks::new();
        let now = (self.clock)();
        for asset_id in asset_ids {
            if asset_id == quote_asset_id {
                // The quote asset is worth one of itself: not a price lookup, so the book never depends on a market
                // that need not exist.
                out.insert(
                    asset_id.clone(),
                    QuotedMark::new(asset_id.clone(), ONE, now, MarkQuality::Index),
                );
                continue;
            }
            let Some((price, quality)) = self.prices.get(asset_id) else {
                continue;
            };
            out.insert(
                asset_id.clone(),
                QuotedMark::new(asset_id.clone(), *price, now, *quality),
            );
        }
        out
    }
}

/// `tickerPriceSource`: svc-trade's public ticker (`GET /api/v1/ticker/<asset>/<quote>`), read over HTTP. Mid where a
/// two-sided quote exists, `last` where it does not, labelled either way. A read of another stream's public surface:
/// no import of svc-trade, no shared table.
pub struct TickerPriceSource {
    base_url: String,
    fetch: Box<dyn Fetch>,
    timeout_ms: u64,
    clock: Clock,
}

impl TickerPriceSource {
    /// `timeout_ms` is 3000 when `None`, as in the TypeScript.
    pub fn new(
        base_url: impl Into<String>,
        fetch: Box<dyn Fetch>,
        timeout_ms: Option<u64>,
        clock: Clock,
    ) -> TickerPriceSource {
        TickerPriceSource {
            base_url: base_url.into(),
            fetch,
            timeout_ms: timeout_ms.unwrap_or(3_000),
            clock,
        }
    }

    fn one(&self, asset_id: &str, quote_asset_id: &str) -> Option<QuotedMark> {
        if asset_id == quote_asset_id {
            return Some(QuotedMark::new(
                asset_id,
                ONE,
                (self.clock)(),
                MarkQuality::Index,
            ));
        }
        let symbol = encode_uri_component(&format!("{asset_id}/{quote_asset_id}"));
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "GET".to_owned(),
                url: format!("{}/api/v1/ticker/{symbol}", self.base_url),
                headers: Vec::new(),
                body: None,
                timeout_ms: Some(self.timeout_ms),
                refuse_redirect: false,
            })
            .ok()?;
        if !res.ok() {
            return None;
        }
        // Any throw the TypeScript catches (a bad body, a malformed amount) omits the mark: a missing mark is not a
        // zero mark.
        let body = json::parse(&res.body).ok()?;
        if !matches!(body, Json::Object(_)) {
            return None;
        }
        // No stated time, no mark: stamping "now" on a quote of unknown age would let a stale price pass.
        let Some(Json::Number(ts)) = body.get("timestamp") else {
            return None;
        };
        let as_of = Instant(time_clip(*ts)?);

        let bid = truthy(body.get("bid"));
        let ask = truthy(body.get("ask"));
        if let (Some(bid), Some(ask)) = (bid, ask) {
            let bid = amount_of(bid)?;
            let ask = amount_of(ask)?;
            if bid > Amount::ZERO && ask > Amount::ZERO {
                // Floor of the mid: half a unit in the direction collateral rounds.
                let mid = bid / 2 + ask / 2 + (bid.rem_count(2) + ask.rem_count(2)) / 2;
                return Some(QuotedMark::new(asset_id, mid, as_of, MarkQuality::Mid));
            }
        }
        if let Some(last) = truthy(body.get("last")) {
            let last = amount_of(last)?;
            if last > Amount::ZERO {
                return Some(QuotedMark::new(asset_id, last, as_of, MarkQuality::Last));
            }
        }
        None
    }
}

impl PriceSource for TickerPriceSource {
    /// One request per asset, in parallel, as the TypeScript's `Promise.all`.
    fn marks(&self, asset_ids: &[String], quote_asset_id: &str) -> Marks {
        let found: Vec<QuotedMark> = std::thread::scope(|s| {
            let handles: Vec<_> = asset_ids
                .iter()
                .map(|a| s.spawn(move || self.one(a, quote_asset_id)))
                .collect();
            handles
                .into_iter()
                .filter_map(|h| h.join().ok().flatten())
                .collect()
        });
        found
            .into_iter()
            .map(|q| (q.mark.asset_id.clone(), q))
            .collect()
    }
}

/// A JavaScript-truthy JSON value, or `None`.
fn truthy(v: Option<&Json>) -> Option<&Json> {
    match v? {
        Json::Null | Json::Bool(false) => None,
        Json::String(s) if s.is_empty() => None,
        Json::Number(n) if *n == 0.0 || n.is_nan() => None,
        other => Some(other),
    }
}

/// `parseAmount` of a ticker field: only a decimal string is an amount (anything else throws there).
fn amount_of(v: &Json) -> Option<Amount> {
    match v {
        Json::String(s) => parse_amount(s).ok(),
        _ => None,
    }
}

/// `encodeURIComponent`.
fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    //! `loans.test.ts` §3 (mark acceptability), and the adapters.
    use super::*;
    use service_kit::http::{FetchError, HttpResponse};

    fn amt(s: &str) -> Amount {
        parse_amount(s).unwrap()
    }

    fn now() -> Instant {
        service_kit::time::js_date("2026-06-01T12:00:00Z").unwrap()
    }

    fn at(seconds_ago: i64, quality: MarkQuality, price: &str) -> QuotedMark {
        QuotedMark::new(
            "BTC",
            amt(price),
            Instant(now().0 - seconds_ago * 1_000),
            quality,
        )
    }

    fn mid(seconds_ago: i64) -> QuotedMark {
        at(seconds_ago, MarkQuality::Mid, "10000")
    }

    #[test]
    fn a_fresh_two_sided_mark_is_fit_for_both() {
        let p = default_mark_policy();
        assert!(acceptable_for_marking(&mid(5), now(), &p).ok);
        assert!(acceptable_for_liquidation(&mid(5), None, now(), &p).ok);
    }

    #[test]
    fn a_stale_mark_warns_but_does_not_seize() {
        let p = default_mark_policy();
        assert!(acceptable_for_marking(&mid(120), now(), &p).ok);
        let c = acceptable_for_liquidation(&mid(120), None, now(), &p);
        assert!(!c.ok);
        assert_eq!(
            c.reason.as_deref(),
            Some("BTC: mark is 120s old, liquidation limit 60s")
        );
        let c = acceptable_for_marking(&mid(301), now(), &p);
        assert_eq!(
            c.reason.as_deref(),
            Some("BTC: mark is 301s old, limit 300s")
        );
    }

    #[test]
    fn a_mark_from_the_future_or_non_positive_is_refused() {
        let p = default_mark_policy();
        let c = acceptable_for_marking(&mid(-120), now(), &p);
        assert!(!c.ok);
        assert_eq!(
            c.reason.as_deref(),
            Some("BTC: mark is dated 120s in the future")
        );
        let zero = QuotedMark::new("BTC", Amount::ZERO, now(), MarkQuality::Mid);
        let c = acceptable_for_marking(&zero, now(), &p);
        assert_eq!(c.reason.as_deref(), Some("BTC: non-positive mark 0"));
    }

    #[test]
    fn a_single_print_warns_but_never_seizes() {
        let p = default_mark_policy();
        let c = acceptable_for_liquidation(&at(5, MarkQuality::Last, "10000"), None, now(), &p);
        assert!(!c.ok);
        assert_eq!(
            c.reason.as_deref(),
            Some(
                "BTC: mark quality \"last\" is not a liquidation basis (allowed: index, mid) — a single print must not seize collateral"
            )
        );
        assert!(acceptable_for_marking(&at(5, MarkQuality::Last, "10000"), now(), &p).ok);
    }

    #[test]
    fn the_breaker_is_integer_bps_and_trips_on_the_line() {
        let p = default_mark_policy();
        let prev = Some(amt("10000"));
        let c = acceptable_for_liquidation(&at(5, MarkQuality::Mid, "5000"), prev, now(), &p);
        assert!(!c.ok);
        assert_eq!(
            c.reason.as_deref(),
            Some(
                "BTC: mark moved 5000bps from 10000 to 5000, breaker at 2000bps — not liquidating through it"
            )
        );
        assert!(acceptable_for_liquidation(&at(5, MarkQuality::Mid, "9000"), prev, now(), &p).ok);
        assert!(acceptable_for_liquidation(&at(5, MarkQuality::Mid, "8000"), prev, now(), &p).ok);
        assert!(!acceptable_for_liquidation(&at(5, MarkQuality::Mid, "7999"), prev, now(), &p).ok);
    }

    #[test]
    fn the_assert_refuses_bank_mark_unusable() {
        let p = default_mark_policy();
        assert!(assert_acceptable_for_liquidation(&mid(5), None, now(), &p).is_ok());
        let Err(Refusal::Bank(e)) = assert_acceptable_for_liquidation(&mid(120), None, now(), &p)
        else {
            panic!("expected a BankError");
        };
        let text = format!("{e:?}");
        assert!(text.contains("bank.mark_unusable"), "{text}");
        assert!(
            text.contains("Refusing to liquidate on this mark — BTC: mark is 120s old"),
            "{text}"
        );
    }

    #[test]
    fn the_fixed_source_prices_the_quote_asset_at_one_and_omits_the_unknown() {
        let src = FixedPriceSource::new(
            &[
                ("BTC", "60000", None),
                ("ETH", "3000", Some(MarkQuality::Last)),
            ],
            Box::new(now),
        )
        .unwrap();
        let ids: Vec<String> = ["BTC", "USDT", "ETH", "DOGE"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let m = src.marks(&ids, "USDT");
        assert_eq!(m.len(), 3);
        assert_eq!(
            m["BTC"],
            QuotedMark::new("BTC", amt("60000"), now(), MarkQuality::Mid)
        );
        assert_eq!(
            m["USDT"],
            QuotedMark::new("USDT", ONE, now(), MarkQuality::Index)
        );
        assert_eq!(m["ETH"].quality, MarkQuality::Last);
        assert!(!m.contains_key("DOGE"));
    }

    struct Ticker(Vec<(&'static str, u16, &'static str)>);

    impl Fetch for Ticker {
        fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
            for (url, status, body) in &self.0 {
                if req.url == *url {
                    return Ok(HttpResponse {
                        status: *status,
                        body: (*body).to_owned(),
                    });
                }
            }
            Err(FetchError {
                message: "fetch failed".to_owned(),
            })
        }
    }

    #[test]
    fn the_ticker_reads_mid_then_last_and_omits_what_it_cannot_date() {
        let src = TickerPriceSource::new(
            "http://trade",
            Box::new(Ticker(vec![
                (
                    "http://trade/api/v1/ticker/BTC%2FUSDT",
                    200,
                    r#"{"bid":"100","ask":"101.000000000000000001","last":"5","timestamp":1780315200000}"#,
                ),
                (
                    "http://trade/api/v1/ticker/ETH%2FUSDT",
                    200,
                    r#"{"bid":null,"ask":"3","last":"2.5","timestamp":1780315200000}"#,
                ),
                (
                    "http://trade/api/v1/ticker/SOL%2FUSDT",
                    200,
                    r#"{"bid":"1","ask":"2","last":"1"}"#,
                ),
                ("http://trade/api/v1/ticker/XRP%2FUSDT", 503, "{}"),
            ])),
            None,
            Box::new(now),
        );
        let ids: Vec<String> = ["BTC", "ETH", "SOL", "XRP", "DOGE", "USDT"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let m = src.marks(&ids, "USDT");
        let ts = Instant(1_780_315_200_000);
        assert_eq!(
            m["BTC"],
            QuotedMark::new("BTC", amt("100.5"), ts, MarkQuality::Mid)
        );
        assert_eq!(
            m["ETH"],
            QuotedMark::new("ETH", amt("2.5"), ts, MarkQuality::Last)
        );
        assert_eq!(m["USDT"].quality, MarkQuality::Index);
        assert_eq!(m.len(), 3);
    }
}
