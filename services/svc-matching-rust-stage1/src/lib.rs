//! C2 `socket.rust-matching` stage 1.
//!
//! This crate is deliberately a socket, not a replacement: the TypeScript
//! engine remains the default. Stage 1 reads only simple limit submit/cancel
//! records into its legacy deterministic state shape, not the full current TS
//! journal or snapshot contract. Advanced fields refuse rather than silently
//! becoming plain limits. Reachable self-crosses refuse as unsupported replay.
//! Stops, expiry, STP policy, accepted terminal IDs, positions,
//! amend and session/control records remain outside this socket.
//! Amounts stay decimal strings on the wire and are never represented as
//! floating point values.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Order {
    pub orderId: String,
    pub accountId: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub side: String,
    pub qty: String,
    pub price: Option<String>,
    pub stopPrice: Option<String>,
    pub tif: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Record {
    pub seq: u64,
    pub kind: String,
    pub marketId: String,
    pub at: String,
    pub order: Option<Order>,
    pub orderId: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RestingOrder {
    pub orderId: String,
    pub accountId: String,
    pub remaining: String,
    pub sequence: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PriceLevel {
    pub price: String,
    pub orders: Vec<RestingOrder>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BookState {
    pub marketId: String,
    pub sequence: u64,
    pub lastTradePrice: Option<String>,
    pub bids: Vec<PriceLevel>,
    pub asks: Vec<PriceLevel>,
    pub stops: Vec<serde_json::Value>,
}

#[derive(Debug, Clone)]
struct Live { order: Order, remaining: u128, sequence: u64 }

#[derive(Debug, Default)]
struct Book { market: String, sequence: u64, last: Option<u128>, bids: Vec<Live>, asks: Vec<Live> }

const SCALE: u32 = 18;
const NUMERIC_38_18_MAX: u128 = 10u128.pow(38) - 1;

fn parse_amount(s: &str) -> Result<u128, String> {
    let (whole, frac) = s.split_once('.').unwrap_or((s, ""));
    if s.ends_with('.') || whole.is_empty() || frac.len() > SCALE as usize || !whole.chars().all(|c| c.is_ascii_digit()) || !frac.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("invalid decimal amount: {s}"));
    }
    let mut digits = frac.to_owned();
    digits.extend(std::iter::repeat('0').take(SCALE as usize - digits.len()));
    let w = whole.parse::<u128>().map_err(|_| format!("amount overflow: {s}"))?;
    let f = if digits.is_empty() { 0 } else { digits.parse::<u128>().map_err(|_| format!("amount overflow: {s}"))? };
    let scaled = w.checked_mul(10u128.pow(SCALE)).and_then(|x| x.checked_add(f)).ok_or_else(|| format!("amount overflow: {s}"))?;
    if scaled > NUMERIC_38_18_MAX {
        return Err(format!("amount overflow: {s}"));
    }
    Ok(scaled)
}

fn format_amount(v: u128) -> String {
    let unit = 10u128.pow(SCALE);
    let whole = v / unit;
    let frac = format!("{:018}", v % unit).trim_end_matches('0').to_owned();
    if frac.is_empty() { whole.to_string() } else { format!("{whole}.{frac}") }
}

impl Book {
    fn submit(&mut self, order: Order) -> Result<(), String> {
        if order.accountId.trim().is_empty() {
            return Err("self_trade: STP identity missing; the engine does not invent a group".into());
        }
        if order.kind != "limit" {
            return Err(format!(
                "unsupported_order_type: stage 1 accepts limit orders only, got {}",
                order.kind
            ));
        }
        if order.stopPrice.is_some() {
            return Err("unexpected_stop_price: a limit order must not carry a stopPrice".into());
        }
        if !matches!(order.tif.as_str(), "GTC" | "IOC" | "FOK" | "PO") {
            return Err("unsupported_tif: stage 1 accepts GTC, IOC, FOK or PO only".into());
        }
        if self.bids.iter().chain(self.asks.iter()).any(|live| live.order.orderId == order.orderId) {
            return Err("duplicate_order_id: orderId is already live".into());
        }
        let qty = parse_amount(&order.qty)?;
        if qty == 0 {
            return Err("invalid_qty: quantity must be strictly positive".into());
        }
        let price = order.price.as_deref().ok_or_else(|| "stage 1 accepts limit orders only".to_string()).and_then(parse_amount)?;
        if price == 0 {
            return Err("invalid_price: price must be strictly positive".into());
        }
        let side = order.side.clone();
        let opposite = if side == "buy" { &mut self.asks } else if side == "sell" { &mut self.bids } else { return Err(format!("invalid side: {side}")); };
        let crossing = |p: u128| if side == "buy" { price >= p } else { price <= p };
        if order.tif == "PO" && opposite.first().is_some_and(|maker| crossing(parse_amount(maker.order.price.as_ref().unwrap()).unwrap())) {
            return Err("post_only_would_cross: post-only order would take liquidity".into());
        }
        let mut remaining = qty;
        // A fill-or-kill that cannot finish must not take a slice. The walk
        // below mutates makers as it goes, so the size is checked first.
        if order.tif == "FOK" {
            let mut cover = 0u128;
            for maker in opposite.iter() {
                let maker_price = parse_amount(maker.order.price.as_ref().unwrap()).unwrap();
                if !crossing(maker_price) { break; }
                cover = cover.saturating_add(maker.remaining);
                if cover >= qty { break; }
            }
            if cover < qty {
                return Ok(());
            }
        }
        // The TS engine expires the self maker and continues. This socket does
        // not implement that policy, so refuse this replay before any fill.
        // A deeper maker beyond the completed take cannot affect this input.
        let mut planned_remaining = qty;
        for maker in opposite.iter() {
            let maker_price = parse_amount(maker.order.price.as_ref().unwrap()).unwrap();
            if planned_remaining == 0 || !crossing(maker_price) {
                break;
            }
            if maker.order.accountId == order.accountId {
                return Err("unsupported_replay: self-trade prevention requires the TypeScript engine".into());
            }
            planned_remaining -= planned_remaining.min(maker.remaining);
        }
        while remaining > 0 && !opposite.is_empty() && crossing(parse_amount(opposite[0].order.price.as_ref().unwrap()).unwrap()) {
            let maker_price = parse_amount(opposite[0].order.price.as_ref().unwrap()).unwrap();
            let traded = remaining.min(opposite[0].remaining);
            remaining -= traded;
            opposite[0].remaining -= traded;
            self.last = Some(maker_price);
            self.sequence += 1;
            if opposite[0].remaining == 0 { opposite.remove(0); }
        }
        self.sequence += 1;
        if remaining > 0 && order.tif != "IOC" && order.tif != "FOK" {
            let live = Live { order, remaining, sequence: self.sequence };
            let own = if side == "buy" { &mut self.bids } else { &mut self.asks };
            own.push(live);
            own.sort_by(|a, b| {
                let pa = parse_amount(a.order.price.as_ref().unwrap()).unwrap();
                let pb = parse_amount(b.order.price.as_ref().unwrap()).unwrap();
                if side == "buy" { pb.cmp(&pa).then(a.sequence.cmp(&b.sequence)) } else { pa.cmp(&pb).then(a.sequence.cmp(&b.sequence)) }
            });
        }
        Ok(())
    }
    fn cancel(&mut self, id: &str) { self.bids.retain(|x| x.order.orderId != id); self.asks.retain(|x| x.order.orderId != id); self.sequence += 1; }
    fn state(&self) -> BookState {
        let levels = |orders: &[Live], side: &str| {
            let mut grouped: BTreeMap<u128, Vec<RestingOrder>> = BTreeMap::new();
            for x in orders { let p = parse_amount(x.order.price.as_ref().unwrap()).unwrap(); grouped.entry(p).or_default().push(RestingOrder { orderId: x.order.orderId.clone(), accountId: x.order.accountId.clone(), remaining: format_amount(x.remaining), sequence: x.sequence }); }
            let mut out: Vec<_> = grouped.into_iter().map(|(p, orders)| PriceLevel { price: format_amount(p), orders }).collect();
            if side == "buy" { out.reverse(); } out
        };
        BookState { marketId: self.market.clone(), sequence: self.sequence, lastTradePrice: self.last.map(format_amount), bids: levels(&self.bids, "buy"), asks: levels(&self.asks, "sell"), stops: vec![] }
    }
}

/// Replay a JSON array of the TypeScript engine's journal records.
pub fn replay(records: &[Record]) -> Result<String, String> {
    let mut books: BTreeMap<String, Book> = BTreeMap::new();
    for record in records {
        match record.kind.as_str() {
            "submit" => { let order = record.order.clone().ok_or_else(|| "submit without order".to_string())?; let book = books.entry(record.marketId.clone()).or_insert_with(|| Book { market: record.marketId.clone(), ..Default::default() }); book.submit(order)?; }
            "cancel" => { let id = record.orderId.as_deref().ok_or_else(|| "cancel_without_order_id: cancel requires orderId".to_string())?; if let Some(book) = books.get_mut(&record.marketId) { book.cancel(id); } }
            other => return Err(format!("unknown journal command: {other}")),
        }
    }
    let states: Vec<_> = books.values().map(Book::state).collect();
    serde_json::to_string(&states).map_err(|e| e.to_string())
}

pub fn replay_json(input: &str) -> Result<String, String> { let records: Vec<Record> = serde_json::from_str(input).map_err(|e| e.to_string())?; replay(&records) }

pub fn ready() -> &'static str { "ready" }

#[cfg(test)]
mod tests {
    use super::*;
    const FIXTURE: &str = include_str!("../fixtures/replay-golden.json");
    const GOLDEN: &str = include_str!("../fixtures/replay-golden.expected.json");

    #[test]
    fn replay_is_byte_identical_and_matches_golden() {
        let first = replay_json(FIXTURE).unwrap();
        let second = replay_json(FIXTURE).unwrap();
        assert_eq!(first, second);
        let got: serde_json::Value = serde_json::from_str(&first).unwrap();
        let want: serde_json::Value = serde_json::from_str(GOLDEN).unwrap();
        assert_eq!(got, want);
    }

    #[test]
    fn ready_harness_is_explicit() { assert_eq!(ready(), "ready"); }

    fn limit(id: &str, side: &str, qty: &str, tif: &str) -> Order {
        Order {
            orderId: id.into(),
            accountId: if side == "buy" { "desk".into() } else { "mm".into() },
            kind: "limit".into(),
            side: side.into(),
            qty: qty.into(),
            price: Some("100".into()),
            stopPrice: None,
            tif: tif.into(),
        }
    }

    #[test]
    fn fok_that_cannot_fill_leaves_the_book_unchanged() {
        let mut book = Book { market: "BTC/USDT".into(), ..Book::default() };
        book.submit(limit("ask", "sell", "5", "GTC")).unwrap();
        let before = book.state();
        book.submit(limit("buy", "buy", "10", "FOK")).unwrap();
        let after = book.state();
        assert_eq!(after.asks.len(), 1);
        assert_eq!(after.asks[0].orders[0].remaining, before.asks[0].orders[0].remaining);
        assert_eq!(after.bids.len(), 0);
        assert_eq!(after.lastTradePrice, None);
    }

    #[test]
    fn fok_that_can_fill_takes_the_maker() {
        let mut book = Book { market: "BTC/USDT".into(), ..Book::default() };
        book.submit(limit("ask", "sell", "5", "GTC")).unwrap();
        book.submit(limit("buy", "buy", "5", "FOK")).unwrap();
        let state = book.state();
        assert!(state.asks.is_empty());
        assert!(state.bids.is_empty());
        assert_eq!(state.lastTradePrice.as_deref(), Some("100"));
    }

    fn book_bytes(book: &Book) -> String {
        serde_json::to_string(&book.state()).unwrap()
    }

    #[test]
    fn duplicate_live_ids_refuse_without_changing_either_side() {
        let mut book = Book { market: "BTC/USDT".into(), ..Book::default() };
        book.submit(limit("live", "sell", "2", "GTC")).unwrap();
        let before = book_bytes(&book);
        for side in ["buy", "sell"] {
            let err = book.submit(limit("live", side, "1", "GTC")).unwrap_err();
            assert!(err.starts_with("duplicate_order_id:"), "{err}");
            assert_eq!(book_bytes(&book), before);
        }
    }

    #[test]
    fn invalid_structure_and_amounts_refuse_before_matching() {
        let mut book = Book { market: "BTC/USDT".into(), ..Book::default() };
        book.submit(limit("ask", "sell", "2", "GTC")).unwrap();
        let before = book_bytes(&book);
        let mut invalid = Vec::new();
        for qty in ["0", "0.0", "-1", "1.", "1e2", "1.0000000000000000001", "100000000000000000000"] {
            invalid.push(limit("bad", "buy", qty, "GTC"));
        }
        for price in [None, Some(""), Some("0"), Some("-1"), Some("1."), Some("100000000000000000000")] {
            let mut order = limit("bad", "buy", "1", "GTC");
            order.price = price.map(str::to_owned);
            invalid.push(order);
        }
        for tif in ["", "DAY", "gtc", "GTD", "GTT"] { invalid.push(limit("bad", "buy", "1", tif)); }
        invalid.push(limit("bad", "unknown", "1", "GTC"));
        for account in ["", "   "] {
            let mut order = limit("bad", "buy", "1", "GTC");
            order.accountId = account.into();
            invalid.push(order);
        }
        let mut stop = limit("bad", "buy", "1", "GTC");
        stop.kind = "stop_limit".into(); invalid.push(stop);
        let mut extra = limit("bad", "buy", "1", "GTC");
        extra.stopPrice = Some("90".into()); invalid.push(extra);
        for order in invalid {
            assert!(book.submit(order.clone()).is_err(), "accepted {order:?}");
            assert_eq!(book_bytes(&book), before, "mutated for {order:?}");
        }
    }

    #[test]
    fn post_only_cross_refuses_and_non_cross_rests() {
        let mut book = Book { market: "BTC/USDT".into(), ..Book::default() };
        book.submit(limit("ask", "sell", "2", "GTC")).unwrap();
        let before = book_bytes(&book);
        let err = book.submit(limit("cross", "buy", "1", "PO")).unwrap_err();
        assert!(err.starts_with("post_only_would_cross:"), "{err}");
        assert_eq!(book_bytes(&book), before);
        let mut behind = limit("behind", "buy", "1", "PO"); behind.price = Some("99".into());
        book.submit(behind).unwrap();
        assert_eq!(book.state().bids[0].orders[0].orderId, "behind");
        assert_eq!(book.state().lastTradePrice, None);
    }

    #[test]
    fn decimal_boundary_is_exact_and_never_wraps() {
        let raw = "99999999999999999999.999999999999999999";
        let scaled = parse_amount(raw).unwrap();
        assert_eq!(scaled, 10u128.pow(38) - 1);
        assert_eq!(format_amount(scaled), raw);
        assert!(parse_amount("100000000000000000000").is_err());
        assert!(parse_amount("340282366920938463463374607431768211456").is_err());
    }

    #[test]
    fn advanced_wire_inputs_refuse_instead_of_becoming_plain_limits() {
        let original: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        for field in ["aon", "iceberg", "displayQty", "minQty", "reduceOnly", "ocoSiblingId", "expireAt", "peg", "midpoint", "auction", "exercise", "sessionId", "trail", "relative", "collar", "minNotional", "combo", "lifecycleProof"] {
            let mut records = original.clone();
            records[0]["order"][field] = serde_json::json!(true);
            let err = replay_json(&records.to_string()).unwrap_err();
            assert!(err.contains("unknown field"), "{field}: {err}");
        }
        let mut records = original;
        records[2]["orderId"] = serde_json::Value::Null;
        assert!(replay_json(&records.to_string()).unwrap_err().starts_with("cancel_without_order_id:"));
    }

    #[test]
    fn reachable_self_cross_is_unsupported_before_any_fill() {
        let mut book = Book { market: "BTC/USDT".into(), ..Book::default() };
        book.submit(limit("external", "sell", "1", "GTC")).unwrap();
        let mut own = limit("own", "sell", "1", "GTC");
        own.accountId = "desk".into();
        book.submit(own).unwrap();
        let before = book_bytes(&book);
        let err = book.submit(limit("cross", "buy", "2", "GTC")).unwrap_err();
        assert!(err.starts_with("unsupported_replay:"), "{err}");
        assert_eq!(book_bytes(&book), before);
        // This order fills completely before reaching its own deeper maker.
        book.submit(limit("external-only", "buy", "1", "GTC")).unwrap();
        assert_eq!(book.state().asks[0].orders[0].orderId, "own");
        assert!(book.state().bids.is_empty());
        assert_eq!(book.state().lastTradePrice.as_deref(), Some("100"));
    }

    #[test]
    fn self_cross_refusal_preserves_fok_and_post_only_preflight() {
        let mut book = Book { market: "BTC/USDT".into(), ..Book::default() };
        let mut own = limit("own", "sell", "1", "GTC");
        own.accountId = "desk".into();
        book.submit(own).unwrap();
        let before = book_bytes(&book);
        book.submit(limit("too-large", "buy", "2", "FOK")).unwrap();
        assert_eq!(book_bytes(&book), before);
        let err = book.submit(limit("po", "buy", "1", "PO")).unwrap_err();
        assert!(err.starts_with("post_only_would_cross:"), "{err}");
        assert_eq!(book_bytes(&book), before);
        let err = book.submit(limit("fok-self", "buy", "1", "FOK")).unwrap_err();
        assert!(err.starts_with("unsupported_replay:"), "{err}");
        assert_eq!(book_bytes(&book), before);
    }

}
