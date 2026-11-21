//! The Portfolio agent (`portfolio-agent/`): a plan-only rebalance against the person's own targets. It never places
//! an order or posts to the ledger, never invents a book, and refuses a plan that moves value across planes.
//!
//! Holdings are the person's available balances in svc-ledger (`balances` only), weighted by the platform's prices
//! (svc-trade's public ticker). An asset with no positive price refuses `portfolio.price_unset` by name: never valued
//! at 0. Weights are decimal strings, scaled integers in memory.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::s2s::CallSigner;

/// The weight scale: 8 places.
const SCALE: usize = 8;
const UNIT: u128 = 100_000_000;
/// The money scale: 18 places.
const MONEY_UNIT: u64 = 1_000_000_000_000_000_000;

/// `parseWeight`: `/^(0|[1-9]\d*)(\.\d+)?$/`, at most 8 places, in [0, 1].
pub fn parse_weight(raw: &str) -> Option<u128> {
    let (whole, frac) = raw
        .split_once('.')
        .map_or((raw, None), |(w, f)| (w, Some(f)));
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(whole) || (whole.len() > 1 && whole.starts_with('0')) {
        return None;
    }
    if frac.is_some_and(|f| !digits(f) || f.len() > SCALE) {
        return None;
    }
    // Anything past one unit refuses; a long whole part is past it already.
    if whole.len() > 1 {
        return None;
    }
    let w: u128 = whole.parse().ok()?;
    let f = frac.unwrap_or_default();
    let f: u128 = format!("{f:0<SCALE$}").parse().ok()?;
    let n = w * UNIT + f;
    (n <= UNIT).then_some(n)
}

/// `formatWeight`.
pub fn format_weight(n: i128) -> String {
    let a = n.unsigned_abs();
    let frac = format!("{:0>SCALE$}", a % UNIT);
    let frac = frac.trim_end_matches('0');
    let s = if frac.is_empty() {
        format!("{}", a / UNIT)
    } else {
        format!("{}.{frac}", a / UNIT)
    };
    if n < 0 { format!("-{s}") } else { s }
}

/// `a * b / d` and its remainder, exact for any `u128` operands and a divisor below 2^64 (`BigInt` arithmetic).
fn mul_div(a: u128, b: u128, d: u64) -> Option<(u128, u128)> {
    // The 256-bit product as four 64-bit limbs, most significant first.
    let (ah, al) = (a >> 64, a & u128::from(u64::MAX));
    let (bh, bl) = (b >> 64, b & u128::from(u64::MAX));
    let ll = al * bl;
    let lh = al * bh;
    let hl = ah * bl;
    let hh = ah * bh;
    let mid = (ll >> 64) + (lh & u128::from(u64::MAX)) + (hl & u128::from(u64::MAX));
    let lo = (ll & u128::from(u64::MAX)) | ((mid & u128::from(u64::MAX)) << 64);
    let hi = hh + (lh >> 64) + (hl >> 64) + (mid >> 64);
    let limbs = [
        hi >> 64,
        hi & u128::from(u64::MAX),
        lo >> 64,
        lo & u128::from(u64::MAX),
    ];
    let d = u128::from(d);
    let mut rem: u128 = 0;
    let mut q = [0u128; 4];
    for (i, limb) in limbs.iter().enumerate() {
        let cur = (rem << 64) | limb;
        if let Some(slot) = q.get_mut(i) {
            *slot = cur / d;
        }
        rem = cur % d;
    }
    let [q0, q1, q2, q3] = q;
    if q0 != 0 || q1 != 0 {
        return None;
    }
    Some(((q2 << 64) | q3, rem))
}

// ── What it reads ────────────────────────────────────────────────────────────

/// One balance as svc-ledger's `balances` answers it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Balance {
    pub asset_id: String,
    pub kind: String,
    pub amount: Amount,
}

/// `HoldingsLedger`: the person's balances, read only.
pub trait HoldingsLedger: Send + Sync {
    fn balances(&self, user_id: &str) -> Result<Vec<Balance>, String>;
}

/// `PortfolioPriceSource`: one unit of the asset, as a decimal string, or none when no price is published.
pub trait Prices: Send + Sync {
    fn price(&self, asset_id: &str) -> Option<String>;
}

/// svc-ledger's `/trpc/balances`, signed as svc-agents, retried as the ledger client retries.
pub struct LedgerBalancesHttp {
    pub base_url: String,
    pub signer: CallSigner,
    pub fetch: Arc<dyn Fetch>,
    pub timeout_ms: u64,
    pub retries: u32,
    pub sleep: fn(Duration),
}

/// svc-ledger's balances read.
pub const BALANCES_PATH: &str = "/trpc/balances";

impl LedgerBalancesHttp {
    pub fn new(base_url: &str, signer: CallSigner, fetch: Arc<dyn Fetch>) -> LedgerBalancesHttp {
        LedgerBalancesHttp {
            base_url: base_url.trim_end_matches('/').to_owned(),
            signer,
            fetch,
            timeout_ms: 10_000,
            retries: 2,
            sleep: std::thread::sleep,
        }
    }
}

impl HoldingsLedger for LedgerBalancesHttp {
    fn balances(&self, user_id: &str) -> Result<Vec<Balance>, String> {
        let payload = Json::obj([
            ("ownerType", Json::str("user")),
            ("ownerId", Json::str(user_id)),
        ])
        .compact();
        let url = format!("{}{BALANCES_PATH}", self.base_url);
        let mut attempt = 0;
        loop {
            let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
            headers.extend(self.signer.sign(
                &payload,
                "POST",
                BALANCES_PATH,
                "application/json",
            )?);
            let sent = self.fetch.fetch(&HttpRequest {
                method: "POST".to_owned(),
                url: url.clone(),
                headers,
                body: Some(payload.clone()),
                timeout_ms: Some(self.timeout_ms),
                refuse_redirect: false,
            });
            let retryable = match &sent {
                Err(_) => true,
                Ok(res) => [502, 503, 504].contains(&res.status),
            };
            if retryable && attempt < self.retries {
                (self.sleep)(Duration::from_millis(150 << attempt));
                attempt += 1;
                continue;
            }
            let res = sent.map_err(|e| e.message)?;
            if !res.ok() {
                return Err(format!("svc-ledger balances failed ({})", res.status));
            }
            let Json::Array(rows) = json::parse(&res.body).map_err(|e| e.message)? else {
                return Err("svc-ledger balances answered another shape".to_owned());
            };
            return rows
                .iter()
                .map(|r| {
                    match (
                        r.get("accountId"),
                        r.get("assetId"),
                        r.get("kind"),
                        r.get("amount"),
                    ) {
                        (
                            Some(Json::String(_)),
                            Some(Json::String(a)),
                            Some(Json::String(k)),
                            Some(Json::String(n)),
                        ) => Ok(Balance {
                            asset_id: a.clone(),
                            kind: k.clone(),
                            amount: parse_amount(n)?,
                        }),
                        _ => Err("svc-ledger balances answered another shape".to_owned()),
                    }
                })
                .collect();
        }
    }
}

/// `usable`: a positive decimal, else none.
fn usable(raw: Option<&Json>) -> Option<Amount> {
    let Some(Json::String(s)) = raw else {
        return None;
    };
    if s.is_empty() {
        return None;
    }
    parse_amount(service_kit::schema::js_trim(s))
        .ok()
        .filter(|a| *a > 0)
}

/// `tradeTickerPrices`: svc-trade's public ticker, the mid of a two-sided quote, otherwise the last trade. A missing,
/// zero or unusable quote is none, never "0".
pub struct TradeTickerPrices {
    pub base_url: String,
    pub quote_asset_id: String,
    pub fetch: Arc<dyn Fetch>,
    pub timeout_ms: u64,
}

/// `encodeURIComponent`.
fn encode_uri_component(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

impl Prices for TradeTickerPrices {
    fn price(&self, asset_id: &str) -> Option<String> {
        let quote = service_kit::schema::js_trim(&self.quote_asset_id);
        if quote.is_empty() {
            return None;
        }
        if asset_id == quote {
            return Some("1".to_owned());
        }
        let symbol = encode_uri_component(&format!("{asset_id}/{quote}"));
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
        let body = json::parse(&res.body).ok()?;
        if let (Some(bid), Some(ask)) = (usable(body.get("bid")), usable(body.get("ask"))) {
            let mid = (bid + ask) / 2;
            if mid > 0 {
                return Some(format_amount(mid));
            }
        }
        usable(body.get("last")).map(format_amount)
    }
}

// ── The holdings ─────────────────────────────────────────────────────────────

/// One holding (`PortfolioHolding`): every holding read from the ledger is custodial.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Holding {
    pub asset: String,
    pub weight: String,
}

/// `weightsFor`: weights in the portfolio scale that sum to exactly one unit (largest remainders first).
fn weights_for(values: &[u128]) -> Option<Vec<u128>> {
    let total = values.iter().try_fold(0u128, |s, v| s.checked_add(*v))?;
    if total == 0 {
        return Some(vec![0; values.len()]);
    }
    let parts = values
        .iter()
        .map(|v| {
            // (value * unit) / total, exactly.
            let product = v.checked_mul(UNIT)?;
            Some((product / total, product % total))
        })
        .collect::<Option<Vec<_>>>()?;
    let mut floors: Vec<u128> = parts.iter().map(|p| p.0).collect();
    let used: u128 = floors.iter().sum();
    let mut order: Vec<usize> = (0..parts.len()).collect();
    order.sort_by(|a, b| {
        let (ra, rb) = (
            parts.get(*a).map_or(0, |p| p.1),
            parts.get(*b).map_or(0, |p| p.1),
        );
        rb.cmp(&ra).then(a.cmp(b))
    });
    let short = usize::try_from(UNIT.saturating_sub(used)).unwrap_or(usize::MAX);
    for i in order.into_iter().take(short) {
        if let Some(f) = floors.get_mut(i) {
            *f += 1;
        }
    }
    Some(floors)
}

/// `readOwnHoldings`: the person's available balances, each priced; the first asset with no positive price is named.
pub fn read_own_holdings(
    ledger: &dyn HoldingsLedger,
    prices: &dyn Prices,
    user_id: &str,
) -> Result<Result<Vec<Holding>, String>, String> {
    let mut amounts: BTreeMap<String, Amount> = BTreeMap::new();
    for b in ledger.balances(user_id)? {
        if b.kind != "available" || b.amount <= 0 {
            continue;
        }
        *amounts.entry(b.asset_id).or_default() += b.amount;
    }
    // `[...keys].sort()`: UTF-16 order.
    let mut assets: Vec<(String, Amount)> = amounts.into_iter().collect();
    assets.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    let mut priced: Vec<(String, u128)> = Vec::new();
    for (asset, amount) in assets {
        let price = prices
            .price(&asset)
            .map(|p| service_kit::schema::js_trim(&p).to_owned())
            .filter(|p| !p.is_empty())
            .and_then(|p| parse_amount(&p).ok())
            .filter(|p| *p > 0);
        let Some(price) = price else {
            return Ok(Err(asset));
        };
        // value = amount * price, both scaled by 10^18, the product scaled back once.
        let value = mul_div(amount.unsigned_abs(), price.unsigned_abs(), MONEY_UNIT)
            .map(|(q, _)| q)
            .ok_or_else(|| "a holding's value is past the arithmetic".to_owned())?;
        if value == 0 {
            return Ok(Err(asset));
        }
        priced.push((asset, value));
    }
    let values: Vec<u128> = priced.iter().map(|p| p.1).collect();
    let weights = weights_for(&values)
        .ok_or_else(|| "the holdings' weights are past the arithmetic".to_owned())?;
    Ok(Ok(priced
        .into_iter()
        .zip(weights)
        .map(|((asset, _), w)| Holding {
            asset,
            weight: format_weight(i128::try_from(w).unwrap_or(i128::MAX)),
        })
        .collect()))
}

// ── The plan ─────────────────────────────────────────────────────────────────

/// `TargetWeight`, as the input carries it.
pub struct Target<'a> {
    pub asset: &'a str,
    pub plane: &'a str,
    pub weight: &'a str,
}

/// `planRebalance`'s answer.
#[derive(Debug, Clone, PartialEq)]
pub enum Plan {
    Planned(Vec<Json>),
    Refused(&'static str),
}

/// `ownerTargets`: every target well formed, each once, summing to exactly one unit; else none.
fn owner_targets(raw: Option<&[Target<'_>]>) -> Option<BTreeMap<(String, String), u128>> {
    let raw = raw.filter(|r| !r.is_empty())?;
    let mut map = BTreeMap::new();
    let mut sum = 0u128;
    for t in raw {
        if t.asset.is_empty()
            || !matches!(t.plane, "custodial" | "sovereign")
            || t.weight.is_empty()
        {
            return None;
        }
        let w = parse_weight(t.weight)?;
        if map
            .insert((t.plane.to_owned(), t.asset.to_owned()), w)
            .is_some()
        {
            return None;
        }
        sum += w;
    }
    (sum == UNIT).then_some(map)
}

fn plane_total(book: &BTreeMap<(String, String), u128>, plane: &str) -> i128 {
    book.iter()
        .filter(|((p, _), _)| p == plane)
        .map(|(_, w)| i128::try_from(*w).unwrap_or(i128::MAX))
        .sum()
}

/// `planRebalance`: compare the holdings with the person's targets. `holdings` none is the unwired port.
pub fn plan_rebalance(
    killed: bool,
    holdings: Option<&[Holding]>,
    targets: Option<&[Target<'_>]>,
) -> Plan {
    if killed {
        return Plan::Refused("portfolio.killed");
    }
    let Some(holdings) = holdings else {
        return Plan::Refused("portfolio.port_dark");
    };
    let Some(targets) = owner_targets(targets) else {
        return Plan::Refused("portfolio.target_unset");
    };
    let mut current: BTreeMap<(String, String), u128> = BTreeMap::new();
    for h in holdings {
        let Some(w) = parse_weight(&h.weight) else {
            return Plan::Refused("portfolio.port_dark");
        };
        *current
            .entry(("custodial".to_owned(), h.asset.clone()))
            .or_default() += w;
    }
    let custodial = plane_total(&targets, "custodial") - plane_total(&current, "custodial");
    let sovereign = plane_total(&targets, "sovereign") - plane_total(&current, "sovereign");
    if (custodial < 0 && sovereign > 0) || (sovereign < 0 && custodial > 0) {
        return Plan::Refused("portfolio.cross_plane_blocked");
    }
    if holdings.iter().any(|h| h.asset.is_empty()) {
        return Plan::Refused("portfolio.holding_unread");
    }
    // `[...keys].sort()` on `${plane}:${asset}`: UTF-16 order.
    let mut keys: Vec<(String, String)> = current.keys().chain(targets.keys()).cloned().collect();
    keys.sort_by(|a, b| {
        format!("{}:{}", a.0, a.1)
            .encode_utf16()
            .cmp(format!("{}:{}", b.0, b.1).encode_utf16())
    });
    keys.dedup();
    let mut legs = Vec::new();
    for key in keys {
        let cur = i128::try_from(current.get(&key).copied().unwrap_or(0)).unwrap_or(i128::MAX);
        let tgt = i128::try_from(targets.get(&key).copied().unwrap_or(0)).unwrap_or(i128::MAX);
        if cur == tgt {
            continue;
        }
        let delta = tgt - cur;
        legs.push(Json::obj([
            ("asset", Json::str(key.1.clone())),
            ("plane", Json::str(key.0.clone())),
            ("currentWeight", Json::str(format_weight(cur))),
            ("targetWeight", Json::str(format_weight(tgt))),
            ("deltaWeight", Json::str(format_weight(delta))),
            (
                "intent",
                Json::str(if delta > 0 { "increase" } else { "reduce" }),
            ),
        ]));
    }
    Plan::Planned(legs)
}

/// `isPortfolioAgentKilled`: `AGENTS_PORTFOLIO_ENABLED` live only when `1`, `true`, `on` or `yes`.
pub fn killed(raw: Option<&str>) -> bool {
    let v = service_kit::schema::js_trim(raw.unwrap_or_default()).to_lowercase();
    !matches!(v.as_str(), "1" | "true" | "on" | "yes")
}

/// `portfolio.plan`'s `result`.
pub fn result_json(user_id: &str, plan: &Plan, asset: Option<&str>) -> Json {
    let inner = match plan {
        Plan::Planned(legs) => Json::obj([
            ("status", Json::str("planned")),
            ("userId", Json::str(user_id)),
            ("legs", Json::Array(legs.clone())),
        ]),
        Plan::Refused(code) => Json::obj([
            ("status", Json::str("refused")),
            ("code", Json::str(*code)),
            (
                "userMessageKey",
                Json::str("agents.refused.module_not_allowed"),
            ),
            ("asset", asset.map_or(Json::Null, Json::str)),
        ]),
    };
    Json::obj([("result", inner)])
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    fn h(asset: &str, weight: &str) -> Holding {
        Holding {
            asset: asset.to_owned(),
            weight: weight.to_owned(),
        }
    }

    /// `weights.ts` and `plan.test.ts`: weights in [0, 1] with at most 8 places, targets summing to one.
    #[test]
    fn weights_and_targets() {
        assert_eq!(parse_weight("0.5"), Some(50_000_000));
        assert_eq!(parse_weight("1"), Some(UNIT));
        assert_eq!(parse_weight("1.00000000"), Some(UNIT));
        for bad in [
            "1.1",
            "01",
            "0.123456789",
            ".5",
            "5.",
            "-0.1",
            "2",
            "",
            "0.5 ",
        ] {
            assert_eq!(parse_weight(bad), None, "{bad}");
        }
        assert_eq!(format_weight(-25_000_000), "-0.25");
        assert_eq!(format_weight(100_000_000), "1");
        let t = |a, p, w| Target {
            asset: a,
            plane: p,
            weight: w,
        };
        assert_eq!(
            plan_rebalance(true, None, None),
            Plan::Refused("portfolio.killed")
        );
        assert_eq!(
            plan_rebalance(false, None, None),
            Plan::Refused("portfolio.port_dark")
        );
        let held = [h("BTC", "0.6"), h("USDC", "0.4")];
        assert_eq!(
            plan_rebalance(false, Some(&held), Some(&[t("BTC", "custodial", "0.5")])),
            Plan::Refused("portfolio.target_unset")
        );
        assert_eq!(
            plan_rebalance(
                false,
                Some(&held),
                Some(&[t("BTC", "custodial", "0.5"), t("ETH", "sovereign", "0.5")])
            ),
            Plan::Refused("portfolio.cross_plane_blocked")
        );
        let Plan::Planned(legs) = plan_rebalance(
            false,
            Some(&held),
            Some(&[t("BTC", "custodial", "0.5"), t("ETH", "custodial", "0.5")]),
        ) else {
            panic!("planned");
        };
        assert_eq!(
            Json::Array(legs).compact(),
            r#"[{"asset":"BTC","plane":"custodial","currentWeight":"0.6","targetWeight":"0.5","deltaWeight":"-0.1","intent":"reduce"},{"asset":"ETH","plane":"custodial","currentWeight":"0","targetWeight":"0.5","deltaWeight":"0.5","intent":"increase"},{"asset":"USDC","plane":"custodial","currentWeight":"0.4","targetWeight":"0","deltaWeight":"-0.4","intent":"reduce"}]"#
        );
    }

    struct Book(Vec<Balance>);
    impl HoldingsLedger for Book {
        fn balances(&self, _: &str) -> Result<Vec<Balance>, String> {
            Ok(self.0.clone())
        }
    }
    struct Fixed(&'static [(&'static str, &'static str)]);
    impl Prices for Fixed {
        fn price(&self, asset: &str) -> Option<String> {
            self.0
                .iter()
                .find(|(a, _)| *a == asset)
                .map(|(_, p)| (*p).to_owned())
        }
    }

    /// `holdings.test.ts`: available balances only, priced, weights summing to one; an unpriced asset is named.
    #[test]
    fn holdings_are_priced_balances_and_an_unpriced_asset_is_named() {
        let amt = |s| parse_amount(s).unwrap();
        let bal = |a: &str, k: &str, n| Balance {
            asset_id: a.to_owned(),
            kind: k.to_owned(),
            amount: amt(n),
        };
        let book = Book(vec![
            bal("USDC", "available", "1"),
            bal("BTC", "available", "0.00002"),
            bal("BTC", "locked", "5"),
            bal("ETH", "available", "0"),
        ]);
        let read = read_own_holdings(&book, &Fixed(&[("USDC", "1"), ("BTC", "100000")]), "u")
            .unwrap()
            .unwrap();
        assert_eq!(read, vec![h("BTC", "0.66666667"), h("USDC", "0.33333333")]);
        let unpriced =
            read_own_holdings(&book, &Fixed(&[("USDC", "1"), ("BTC", "0")]), "u").unwrap();
        assert_eq!(unpriced, Err("BTC".to_owned()));
        assert!(killed(None));
        assert!(!killed(Some(" YES ")));
        assert!(killed(Some("maybe")));
    }

    #[test]
    fn the_wide_product_is_exact() {
        let unit = u128::from(MONEY_UNIT);
        let big = 1_000_000_000_000u128 * unit;
        assert_eq!(mul_div(big, 3 * unit, MONEY_UNIT), Some((3 * big, 0)));
        assert_eq!(mul_div(7, 3, 2), Some((10, 1)));
    }
}
