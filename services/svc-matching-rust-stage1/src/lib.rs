//! C2 `socket.rust-matching` stage 1.
//!
//! This crate is deliberately a socket, not a replacement: the TypeScript
//! engine remains the default. Stage 1 proves that its append-only journal can
//! be read by Rust and replayed into a canonical, deterministic book state.
//! Amounts stay decimal strings on the wire and are never represented as
//! floating point values.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Deserialize, Serialize)]
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
    /// All-or-none. Absent is a normal order.
    #[serde(default)]
    pub aon: bool,
    /// Iceberg. Absent is a normal order. Display is required when set.
    #[serde(default)]
    pub iceberg: bool,
    /// Visible peak. Decimal string. The engine does not invent one.
    #[serde(default)]
    pub displayQty: Option<String>,
    /// Minimum clip. Decimal string. Zero or absent is not set.
    #[serde(default)]
    pub minQty: Option<String>,
    /// Rest only when the fill would shrink this account's net.
    #[serde(default)]
    pub reduceOnly: bool,
    /// First fill cancels the sibling. Absent when the order is not linked.
    #[serde(default)]
    pub ocoSiblingId: Option<String>,
    /// Caller expiry. ISO-8601. The engine does not invent one.
    #[serde(default)]
    pub expireAt: Option<String>,
    /// Pegged. Refuses rather than matching the limit price. No invented mid.
    #[serde(default)]
    pub peg: bool,
    /// Midpoint. Refuses rather than matching the limit price.
    #[serde(default)]
    pub midpoint: bool,
    /// Auction. Refuses rather than matching the limit price.
    #[serde(default)]
    pub auction: bool,
    /// Option exercise. Refuses rather than matching the limit price.
    #[serde(default)]
    pub exercise: bool,
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
struct Live {
    order: Order,
    remaining: u128,
    sequence: u64,
    display_peak: Option<u128>,
    display_remaining: Option<u128>,
}

#[derive(Debug, Clone)]
struct Stop {
    order: Order,
    remaining: u128,
    sequence: u64,
}

#[derive(Debug, Clone)]
struct Clip {
    maker_id: String,
    qty: u128,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Instant {
    y: u16,
    m: u8,
    d: u8,
    hh: u8,
    mm: u8,
    ss: u8,
    ms: u16,
}

#[derive(Debug, Default)]
struct Book {
    market: String,
    sequence: u64,
    last: Option<u128>,
    bids: Vec<Live>,
    asks: Vec<Live>,
    stops: Vec<Stop>,
    /// Net fills per account. Scaled integer. Buy positive, sell negative.
    positions: BTreeMap<String, i128>,
}

const SCALE: u32 = 18;
// numeric(38,18) maximum, scaled: 20 digits before the point and 18 after.
const NUMERIC_38_18_MAX: u128 = 10u128.pow(38) - 1;

fn parse_amount(s: &str) -> Result<u128, String> {
    let (whole, frac) = s.split_once('.').unwrap_or((s, ""));
    if whole.is_empty() || frac.len() > SCALE as usize || !whole.chars().all(|c| c.is_ascii_digit()) || !frac.chars().all(|c| c.is_ascii_digit()) {
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

fn blank(s: &Option<String>) -> bool {
    match s.as_deref() {
        None | Some("") => true,
        Some(_) => false,
    }
}

fn parse_instant(s: &str) -> Result<Instant, String> {
    let raw = s.trim();
    let raw = raw.strip_suffix('Z').ok_or_else(|| format!("invalid ISO instant: {s}"))?;
    let (date, time) = raw.split_once('T').ok_or_else(|| format!("invalid ISO instant: {s}"))?;
    let mut date_parts = date.split('-');
    let y = take_u32(&mut date_parts, s)? as u16;
    let m = take_u32(&mut date_parts, s)? as u8;
    let d = take_u32(&mut date_parts, s)? as u8;
    if date_parts.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return Err(format!("invalid ISO instant: {s}"));
    }
    let (hms, frac) = time.split_once('.').unwrap_or((time, ""));
    let mut time_parts = hms.split(':');
    let hh = take_u32(&mut time_parts, s)? as u8;
    let mm = take_u32(&mut time_parts, s)? as u8;
    let ss = take_u32(&mut time_parts, s)? as u8;
    if time_parts.next().is_some() || hh > 23 || mm > 59 || ss > 60 {
        return Err(format!("invalid ISO instant: {s}"));
    }
    let ms = parse_millis(frac, s)?;
    Ok(Instant { y, m, d, hh, mm, ss, ms })
}

fn take_u32(parts: &mut std::str::Split<'_, char>, label: &str) -> Result<u32, String> {
    let p = parts.next().ok_or_else(|| format!("invalid ISO instant: {label}"))?;
    if p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("invalid ISO instant: {label}"));
    }
    p.parse().map_err(|_| format!("invalid ISO instant: {label}"))
}

fn parse_millis(frac: &str, label: &str) -> Result<u16, String> {
    if frac.is_empty() {
        return Ok(0);
    }
    if !frac.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("invalid ISO instant: {label}"));
    }
    let mut digits = frac.to_string();
    if digits.len() > 3 {
        digits.truncate(3);
    }
    while digits.len() < 3 {
        digits.push('0');
    }
    digits.parse().map_err(|_| format!("invalid ISO instant: {label}"))
}

fn wants_iceberg(order: &Order) -> bool {
    order.iceberg || order.displayQty.is_some()
}

fn parse_min_qty(raw: &Option<String>) -> Result<Option<u128>, String> {
    let Some(s) = raw.as_deref().filter(|s| !s.is_empty()) else { return Ok(None) };
    let m = parse_amount(s)?;
    if m == 0 { Ok(None) } else { Ok(Some(m)) }
}

fn read_display(order: &Order, qty: u128) -> Result<Option<u128>, String> {
    if !wants_iceberg(order) {
        return Ok(None);
    }
    let Some(raw) = order.displayQty.as_deref().filter(|s| !s.is_empty()) else {
        return Err("iceberg_display_missing: iceberg requires a display qty; the engine does not invent a display".into());
    };
    let d = parse_amount(raw)?;
    if d == 0 {
        return Err("iceberg_display_missing: iceberg requires a display qty; the engine does not invent a display".into());
    }
    if d >= qty {
        return Err("iceberg_display_not_smaller: iceberg display must be smaller than total; the engine does not invent a display".into());
    }
    Ok(Some(d))
}

fn require_price(order: &Order) -> Result<u128, String> {
    match order.price.as_deref() {
        None | Some("") => Err("stage 1 accepts limit orders only".into()),
        Some(p) => parse_amount(p),
    }
}

fn require_stop(order: &Order) -> Result<u128, String> {
    match order.stopPrice.as_deref() {
        None | Some("") => Err("missing_stop_price: a stop order requires a stopPrice".into()),
        Some(s) => {
            let px = parse_amount(s)?;
            if px == 0 {
                Err("invalid_price: stopPrice must be strictly positive".into())
            } else {
                Ok(px)
            }
        }
    }
}

fn clip_ok(clip: u128, after: u128, min_qty: Option<u128>) -> bool {
    let Some(min_qty) = min_qty else { return clip > 0 };
    if clip < min_qty {
        return false;
    }
    if after > 0 && after < min_qty {
        return false;
    }
    true
}

fn crosses(side: &str, taker: u128, maker: u128) -> bool {
    if side == "buy" { taker >= maker } else { taker <= maker }
}

fn self_trade_prevention() -> String {
    "self_trade_prevention: a taker and a resting maker with the same account do not trade; the engine does not invent a self-fill".into()
}

fn known_tif(tif: &str) -> bool {
    matches!(tif, "GTC" | "IOC" | "FOK" | "PO" | "GTD" | "GTT")
}

/// A remainder rests only for a known resting time in force. IOC and FOK do not.
/// Blank and unknown are refused before this, so they neither take nor rest.
fn may_rest(tif: &str) -> bool {
    matches!(tif, "GTC" | "PO" | "GTD" | "GTT")
}

fn taker_would_rest(order: &Order, remaining: u128) -> bool {
    remaining > 0 && may_rest(&order.tif)
}

/// Later makers the fill walk will not trade. Book order is price-time, so the first non-cross ends the scan.
fn unvisited_same_account(order: &Order, price: u128, makers: &[Live]) -> Result<bool, String> {
    for maker in makers {
        let maker_price = parse_amount(maker.order.price.as_deref().unwrap_or(""))?;
        if !crosses(&order.side, price, maker_price) {
            return Ok(false);
        }
        if maker.order.accountId == order.accountId {
            return Ok(true);
        }
    }
    Ok(false)
}

fn refuse_unvisited_self_cross(order: &Order, price: u128, remaining: u128, makers: &[Live]) -> Result<(), String> {
    if taker_would_rest(order, remaining) && unvisited_same_account(order, price, makers)? {
        return Err(self_trade_prevention());
    }
    Ok(())
}

fn visible(maker: &Live) -> u128 {
    match maker.display_remaining {
        Some(d) => d.min(maker.remaining),
        None => maker.remaining,
    }
}

fn fill_deltas(side: &str, qty: u128) -> Result<(i128, i128), String> {
    let q = i128::try_from(qty).map_err(|_| "position overflow".to_string())?;
    if side == "buy" { Ok((q, -q)) } else { Ok((-q, q)) }
}

fn bump(pos: &mut BTreeMap<String, i128>, account: &str, delta: i128) -> Result<(), String> {
    let next = pos.get(account).copied().unwrap_or(0).checked_add(delta).ok_or_else(|| "position overflow".to_string())?;
    if next == 0 {
        pos.remove(account);
    } else {
        pos.insert(account.to_string(), next);
    }
    Ok(())
}

fn reducible_of(pos: &BTreeMap<String, i128>, account: &str, side: &str) -> u128 {
    let net = pos.get(account).copied().unwrap_or(0);
    match side {
        "sell" if net > 0 => net as u128,
        "buy" if net < 0 => (-net) as u128,
        _ => 0,
    }
}

fn sibling_id(order: &Order) -> Option<String> {
    order.ocoSiblingId.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

impl Book {
    #[cfg(test)]
    fn submit(&mut self, order: Order) -> Result<(), String> {
        self.submit_at(order, None)
    }

    fn submit_at(&mut self, order: Order, now: Option<&str>) -> Result<(), String> {
        if order.accountId.trim().is_empty() {
            return Err("self_trade: STP identity missing; the engine does not invent a group".into());
        }
        if order.midpoint {
            return Err("midpoint_unsupported: midpoint orders are unsupported; the engine does not invent a mid".into());
        }
        if order.auction {
            return Err("auction_unsupported: auction orders are unsupported; the engine does not invent an auction price".into());
        }
        if order.exercise {
            return Err("position_flat: exercise is a long option; the engine does not invent a mark".into());
        }
        if order.peg {
            return Err("peg_unsupported: peg orders are not matched as limits; the engine does not invent a price".into());
        }

        let qty = parse_amount(&order.qty)?;
        if qty == 0 {
            return Err("invalid_qty: quantity must be strictly positive".into());
        }
        if order.side != "buy" && order.side != "sell" {
            return Err(format!("invalid side: {}", order.side));
        }
        let kind = order.kind.as_str();
        let is_stop = kind == "stop" || kind == "stop_limit";
        if kind != "limit" && !is_stop {
            return Err(format!("unsupported order type: {kind}"));
        }

        if !known_tif(&order.tif) {
            return Err("invalid_tif: time in force is blank or unknown; the engine does not invent a fill or a price".into());
        }
        if order.tif == "GTD" || order.tif == "GTT" {
            if blank(&order.expireAt) {
                return Err("missing_expire_at: GTD/GTT requires expireAt; the engine does not invent one".into());
            }
        }
        if !blank(&order.expireAt) {
            let exp = parse_instant(order.expireAt.as_deref().unwrap_or(""))
                .map_err(|_| "missing_expire_at: expireAt must be an ISO instant; the engine does not invent one".to_string())?;
            let now_at = match now {
                Some(s) => parse_instant(s).map_err(|_| "engine_clock_missing: expireAt is judged on the engine clock; refuse when that clock is missing".to_string())?,
                None => return Err("engine_clock_missing: expireAt is judged on the engine clock; refuse when that clock is missing".into()),
            };
            if exp <= now_at {
                return Err("already_expired: expireAt is not after the engine clock".into());
            }
        }

        if let Some(sib) = order.ocoSiblingId.as_deref() {
            if sib.is_empty() || sib == order.orderId {
                return Err("invalid_oco_sibling: an OCO order cannot name itself as its sibling".into());
            }
        }

        let min_qty = parse_min_qty(&order.minQty)?;
        if let Some(min_qty) = min_qty {
            if min_qty > qty {
                return Err("min_qty_exceeds_qty: minQty must not exceed remaining qty; the engine does not invent a fill".into());
            }
        }
        let display = read_display(&order, qty)?;
        if order.aon && wants_iceberg(&order) {
            return Err("aon_iceberg: all-or-none cannot hide a stub behind a display; the engine does not invent a fill".into());
        }
        if order.reduceOnly && self.would_increase(&order.accountId, &order.side, qty) {
            return Err("would_increase_position: reduce-only refuses a qty that would increase the position; the engine does not invent a mark".into());
        }

        if kind == "stop" {
            if !blank(&order.price) {
                return Err("unexpected_price: a stop order must not carry a limit price".into());
            }
        } else {
            match require_price(&order) {
                Ok(0) => return Err("invalid_price: price must be strictly positive".into()),
                Ok(_) => {}
                Err(_) => return Err("stage 1 accepts limit orders only".into()),
            }
        }
        if is_stop {
            require_stop(&order)?;
        } else if !blank(&order.stopPrice) {
            return Err("unexpected_stop_price: a limit order must not carry a stopPrice".into());
        }

        if self.has_live(&order.orderId) {
            return Err("duplicate_order_id: orderId is already live; the engine does not invent a replacement id".into());
        }

        if is_stop {
            let stop_px = require_stop(&order)?;
            if !self.is_triggered(&order.side, stop_px) {
                self.sequence += 1;
                if let Some(sib) = sibling_id(&order) {
                    let id = order.orderId.clone();
                    self.stops.push(Stop { order, remaining: qty, sequence: self.sequence });
                    self.note_oco(&id, &sib);
                } else {
                    self.stops.push(Stop { order, remaining: qty, sequence: self.sequence });
                }
                return Ok(());
            }
            if kind == "stop" {
                return Err("stage 1 accepts limit orders only".into());
            }
        }

        let price = require_price(&order)?;
        self.match_rest(order, qty, price, display)?;
        self.drain_stops()?;
        Ok(())
    }

    fn is_triggered(&self, side: &str, stop_px: u128) -> bool {
        match self.last {
            None => false,
            Some(last) if side == "buy" => last >= stop_px,
            Some(last) if side == "sell" => last <= stop_px,
            Some(_) => false,
        }
    }

    fn would_increase(&self, account: &str, side: &str, qty: u128) -> bool {
        qty > reducible_of(&self.positions, account, side)
    }

    fn plan_take(&self, order: &Order, price: u128, qty: u128, display: Option<u128>) -> Result<Vec<Clip>, String> {
        let taker_min = parse_min_qty(&order.minQty)?;
        let mut sim = self.positions.clone();
        let mut remaining = qty;
        // Display caps this taking clip. Hidden remainder rests; it is not a second slice.
        let mut take_left = display.unwrap_or(qty).min(qty);
        let mut clips = Vec::new();
        let opposite = if order.side == "buy" { &self.asks } else { &self.bids };
        for (idx, maker) in opposite.iter().enumerate() {
            if remaining == 0 {
                break;
            }
            if take_left == 0 {
                // Display is spent. The hidden remainder would rest across any later same-account maker.
                refuse_unvisited_self_cross(order, price, remaining, &opposite[idx..])?;
                break;
            }
            let maker_price = parse_amount(maker.order.price.as_deref().unwrap_or(""))?;
            if !crosses(&order.side, price, maker_price) {
                break;
            }
            if maker.order.accountId == order.accountId {
                return Err(self_trade_prevention());
            }
            let show = visible(maker);
            if show == 0 {
                continue;
            }
            let mut traded = remaining.min(show).min(take_left);
            if maker.order.reduceOnly {
                let room = reducible_of(&sim, &maker.order.accountId, &maker.order.side);
                if room == 0 {
                    continue;
                }
                traded = traded.min(room);
            }
            if order.reduceOnly {
                let room = reducible_of(&sim, &order.accountId, &order.side);
                if room == 0 {
                    break;
                }
                traded = traded.min(room);
            }
            if traded == 0 {
                break;
            }
            let maker_min = parse_min_qty(&maker.order.minQty)?;
            if maker.order.aon && traded < maker.remaining {
                refuse_unvisited_self_cross(order, price, remaining, &opposite[idx + 1..])?;
                break;
            }
            if !clip_ok(traded, remaining - traded, taker_min) || !clip_ok(traded, maker.remaining - traded, maker_min) {
                refuse_unvisited_self_cross(order, price, remaining, &opposite[idx + 1..])?;
                break;
            }
            let (taker_delta, maker_delta) = fill_deltas(&order.side, traded)?;
            bump(&mut sim, &order.accountId, taker_delta)?;
            bump(&mut sim, &maker.order.accountId, maker_delta)?;
            remaining -= traded;
            take_left -= traded;
            clips.push(Clip { maker_id: maker.order.orderId.clone(), qty: traded });
        }
        Ok(clips)
    }

    fn would_cross(&self, side: &str, price: u128) -> Result<bool, String> {
        let opposite = if side == "buy" { &self.asks } else { &self.bids };
        let Some(best) = opposite.first() else {
            return Ok(false);
        };
        let maker = parse_amount(best.order.price.as_deref().unwrap_or(""))?;
        Ok(crosses(side, price, maker))
    }

    fn match_rest(&mut self, order: Order, qty: u128, price: u128, display: Option<u128>) -> Result<(), String> {
        // Post-only never takes. A crossing limit is refused before any print.
        let clips = if order.tif == "PO" {
            if self.would_cross(&order.side, price)? {
                return Err("post_only_would_cross: post-only order would take liquidity".into());
            }
            Vec::new()
        } else {
            self.plan_take(&order, price, qty, display)?
        };
        let covered: u128 = clips.iter().map(|c| c.qty).sum();
        if order.tif == "FOK" && covered < qty {
            return Ok(());
        }
        let take: Vec<Clip> = if order.aon && covered < qty { Vec::new() } else { clips };
        {
            let opposite = if order.side == "buy" { &self.asks } else { &self.bids };
            for clip in &take {
                if let Some(maker) = opposite.iter().find(|m| m.order.orderId == clip.maker_id) {
                    if maker.order.accountId == order.accountId {
                        return Err(self_trade_prevention());
                    }
                }
            }
        }
        let mut remaining = qty;
        let mut filled = false;
        let mut oco_pull: Vec<String> = Vec::new();
        for clip in take {
            let applied = {
                let opposite = if order.side == "buy" { &mut self.asks } else { &mut self.bids };
                let Some(idx) = opposite.iter().position(|m| m.order.orderId == clip.maker_id) else { continue };
                let maker = &mut opposite[idx];
                maker.remaining -= clip.qty;
                if let Some(d) = maker.display_remaining.as_mut() {
                    *d = d.saturating_sub(clip.qty);
                    if *d == 0 && maker.remaining > 0 {
                        if let Some(peak) = maker.display_peak {
                            *d = peak.min(maker.remaining);
                        }
                    }
                }
                let done = maker.remaining == 0;
                let maker_price = parse_amount(maker.order.price.as_deref().unwrap_or(""))?;
                let maker_account = maker.order.accountId.clone();
                let maker_sib = sibling_id(&maker.order);
                if done {
                    opposite.remove(idx);
                }
                (maker_price, maker_account, maker_sib)
            };
            let (maker_price, maker_account, maker_sib) = applied;
            self.last = Some(maker_price);
            self.sequence += 1;
            let (taker_delta, maker_delta) = fill_deltas(&order.side, clip.qty)?;
            bump(&mut self.positions, &order.accountId, taker_delta)?;
            bump(&mut self.positions, &maker_account, maker_delta)?;
            remaining -= clip.qty;
            filled = true;
            if let Some(sib) = maker_sib {
                oco_pull.push(sib);
            }
        }
        self.sequence += 1;
        if remaining > 0 && may_rest(&order.tif) {
            let side = order.side.clone();
            let live = Live {
                display_peak: display,
                display_remaining: display.map(|d| d.min(remaining)),
                order: order.clone(),
                remaining,
                sequence: self.sequence,
            };
            let own = if side == "buy" { &mut self.bids } else { &mut self.asks };
            own.push(live);
            own.sort_by(|a, b| {
                let pa = parse_amount(a.order.price.as_ref().unwrap()).unwrap();
                let pb = parse_amount(b.order.price.as_ref().unwrap()).unwrap();
                if side == "buy" { pb.cmp(&pa).then(a.sequence.cmp(&b.sequence)) } else { pa.cmp(&pb).then(a.sequence.cmp(&b.sequence)) }
            });
        }
        if filled {
            if let Some(sib) = sibling_id(&order) {
                oco_pull.push(sib);
            }
        }
        if let Some(sib) = sibling_id(&order) {
            self.note_oco(&order.orderId, &sib);
        }
        for sib in oco_pull {
            if sib != order.orderId && self.has_live(&sib) {
                self.cancel(&sib);
            }
        }
        self.cancel_reduce_only_due();
        Ok(())
    }

    fn drain_stops(&mut self) -> Result<(), String> {
        loop {
            let idx = self.stops.iter().position(|s| {
                require_stop(&s.order).ok().is_some_and(|px| self.is_triggered(&s.order.side, px))
            });
            let Some(idx) = idx else { break };
            let stop = self.stops.remove(idx);
            if stop.order.kind == "stop" {
                return Err("stage 1 accepts limit orders only".into());
            }
            let qty = stop.remaining;
            let price = require_price(&stop.order)?;
            let display = read_display(&stop.order, qty)?;
            if stop.order.reduceOnly && self.would_increase(&stop.order.accountId, &stop.order.side, qty) {
                continue;
            }
            // The print that armed this stop is already on the book. A stop that would
            // cross its own resting order, or a post-only stop that would take, is dropped.
            // That refusal does not unwind the print.
            match self.match_rest(stop.order, qty, price, display) {
                Err(err) if err.starts_with("self_trade_prevention") || err.starts_with("post_only_would_cross") => {}
                other => other?,
            }
        }
        Ok(())
    }

    fn note_oco(&mut self, id: &str, sibling: &str) {
        let link = |order: &mut Order| {
            if order.orderId == sibling && sibling_id(order).is_none() {
                order.ocoSiblingId = Some(id.to_string());
            }
        };
        for row in &mut self.bids {
            link(&mut row.order);
        }
        for row in &mut self.asks {
            link(&mut row.order);
        }
        for row in &mut self.stops {
            link(&mut row.order);
        }
    }

    fn has_live(&self, id: &str) -> bool {
        self.bids.iter().any(|o| o.order.orderId == id)
            || self.asks.iter().any(|o| o.order.orderId == id)
            || self.stops.iter().any(|o| o.order.orderId == id)
    }

    fn cancel_reduce_only_due(&mut self) {
        let mut due = Vec::new();
        for row in self.bids.iter().chain(self.asks.iter()) {
            if row.order.reduceOnly && self.would_increase(&row.order.accountId, &row.order.side, row.remaining) {
                due.push(row.order.orderId.clone());
            }
        }
        for row in &self.stops {
            if row.order.reduceOnly && self.would_increase(&row.order.accountId, &row.order.side, row.remaining) {
                due.push(row.order.orderId.clone());
            }
        }
        for id in due {
            if self.has_live(&id) {
                self.cancel(&id);
            }
        }
    }

    fn expire_due(&mut self, now: &str) {
        let Ok(now_at) = parse_instant(now) else { return };
        let due = |order: &Order| -> bool {
            match order.expireAt.as_deref() {
                Some(s) if !s.is_empty() => parse_instant(s).is_ok_and(|t| t <= now_at),
                _ => false,
            }
        };
        self.bids.retain(|o| !due(&o.order));
        self.asks.retain(|o| !due(&o.order));
        self.stops.retain(|o| !due(&o.order));
    }

    fn cancel(&mut self, id: &str) {
        self.bids.retain(|x| x.order.orderId != id);
        self.asks.retain(|x| x.order.orderId != id);
        self.stops.retain(|x| x.order.orderId != id);
        self.sequence += 1;
    }

    fn state(&self) -> BookState {
        let levels = |orders: &[Live], side: &str| {
            let mut grouped: BTreeMap<u128, Vec<RestingOrder>> = BTreeMap::new();
            for x in orders {
                let p = parse_amount(x.order.price.as_ref().unwrap()).unwrap();
                grouped.entry(p).or_default().push(RestingOrder {
                    orderId: x.order.orderId.clone(),
                    accountId: x.order.accountId.clone(),
                    remaining: format_amount(x.remaining),
                    sequence: x.sequence,
                });
            }
            let mut out: Vec<_> = grouped.into_iter().map(|(p, orders)| PriceLevel { price: format_amount(p), orders }).collect();
            if side == "buy" { out.reverse(); }
            out
        };
        BookState {
            marketId: self.market.clone(),
            sequence: self.sequence,
            lastTradePrice: self.last.map(format_amount),
            bids: levels(&self.bids, "buy"),
            asks: levels(&self.asks, "sell"),
            stops: self.stops.iter().map(|s| {
                serde_json::json!({
                    "orderId": s.order.orderId,
                    "accountId": s.order.accountId,
                    "type": s.order.kind,
                    "side": s.order.side,
                    "qty": format_amount(s.remaining),
                    "price": s.order.price,
                    "stopPrice": s.order.stopPrice,
                    "tif": s.order.tif,
                    "sequence": s.sequence,
                })
            }).collect(),
        }
    }
}

/// Replay a JSON array of the TypeScript engine's journal records.
pub fn replay(records: &[Record]) -> Result<String, String> {
    let mut books: BTreeMap<String, Book> = BTreeMap::new();
    for record in records {
        match record.kind.as_str() {
            "submit" => {
                let order = record.order.clone().ok_or_else(|| "submit without order".to_string())?;
                let book = books.entry(record.marketId.clone()).or_insert_with(|| Book { market: record.marketId.clone(), ..Default::default() });
                book.expire_due(&record.at);
                book.submit_at(order, Some(&record.at))?;
            }
            "cancel" => {
                if let Some(book) = books.get_mut(&record.marketId) {
                    book.expire_due(&record.at);
                    if let Some(id) = &record.orderId {
                        book.cancel(id);
                    }
                }
            }
            other => return Err(format!("unknown journal command: {other}")),
        }
    }
    let states: Vec<_> = books.values().map(Book::state).collect();
    serde_json::to_string(&states).map_err(|e| e.to_string())
}

pub fn replay_json(input: &str) -> Result<String, String> {
    let records: Vec<Record> = serde_json::from_str(input).map_err(|e| e.to_string())?;
    replay(&records)
}

pub fn ready() -> &'static str { "ready" }

#[test]
fn parse_amount_rejects_one_digit_past_numeric_38_18() {
    // 10^20 scales to 10^38, one integer digit past numeric(38,18).
    assert!(parse_amount("100000000000000000000").is_err());
    assert_eq!(
        parse_amount("99999999999999999999.999999999999999999").unwrap(),
        10u128.pow(38) - 1
    );
    assert_eq!(parse_amount("1").unwrap(), 10u128.pow(18));
    assert_eq!(parse_amount("1.5").unwrap(), 15 * 10u128.pow(17));
    assert!(parse_amount("").is_err());
    assert!(parse_amount("1a").is_err());
    assert!(parse_amount("1.0000000000000000001").is_err());
}

#[cfg(test)]
mod tests {
    use super::*;
    const FIXTURE: &str = include_str!("../fixtures/replay-golden.json");
    const GOLDEN: &str = include_str!("../fixtures/replay-golden.expected.json");
    const AT: &str = "2026-01-01T00:00:01.000Z";

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
            aon: false,
            iceberg: false,
            displayQty: None,
            minQty: None,
            reduceOnly: false,
            ocoSiblingId: None,
            expireAt: None,
            peg: false,
            midpoint: false,
            auction: false,
            exercise: false,
        }
    }

    fn submit_record(seq: u64, at: &str, order: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "seq": seq,
            "kind": "submit",
            "marketId": "BTC/USDT",
            "at": at,
            "order": order,
            "orderId": null
        })
    }

    fn limit_json(id: &str, account: &str, side: &str, qty: &str, price: &str) -> serde_json::Value {
        serde_json::json!({
            "orderId": id,
            "accountId": account,
            "type": "limit",
            "side": side,
            "qty": qty,
            "price": price,
            "stopPrice": null,
            "tif": "GTC"
        })
    }

    fn replay_book(records: Vec<serde_json::Value>) -> Result<BookState, String> {
        let raw = serde_json::to_string(&records).unwrap();
        let out = replay_json(&raw)?;
        let states: Vec<BookState> = serde_json::from_str(&out).unwrap();
        states.into_iter().next().ok_or_else(|| "empty book".to_string())
    }

    fn resting_ids(levels: &[PriceLevel]) -> Vec<String> {
        levels.iter().flat_map(|l| l.orders.iter().map(|o| o.orderId.clone())).collect()
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

    #[test]
    fn same_account_cross_is_refused_and_blank_account_does_not_match() {
        let mut book = Book { market: "BTC/USDT".into(), ..Book::default() };
        let mut ask = limit("ask", "sell", "2", "GTC");
        ask.accountId = "mm".into();
        book.submit(ask).unwrap();
        let before = serde_json::to_value(book.state()).unwrap();
        assert!(before["sequence"].as_u64().unwrap() > 0);
        assert!(before["lastTradePrice"].is_null());
        assert_eq!(before["asks"][0]["orders"][0]["remaining"], "2");

        let mut buy = limit("buy", "buy", "2", "GTC");
        buy.accountId = "mm".into();
        let err = book.submit(buy).unwrap_err();
        assert!(err.contains("self_trade_prevention"), "{err}");
        assert_eq!(serde_json::to_value(book.state()).unwrap(), before);

        let mut fok = limit("fok", "buy", "2", "FOK");
        fok.accountId = "mm".into();
        let err = book.submit(fok).unwrap_err();
        assert!(err.contains("self_trade_prevention"), "{err}");
        assert_eq!(serde_json::to_value(book.state()).unwrap(), before);

        let mut bid_book = Book { market: "BTC/USDT".into(), ..Book::default() };
        let mut bid = limit("bid", "buy", "2", "GTC");
        bid.accountId = "mm".into();
        bid_book.submit(bid).unwrap();
        let bid_before = serde_json::to_value(bid_book.state()).unwrap();
        let mut sell = limit("sell", "sell", "2", "GTC");
        sell.accountId = "mm".into();
        let err = bid_book.submit(sell).unwrap_err();
        assert!(err.contains("self_trade_prevention"), "{err}");
        assert_eq!(serde_json::to_value(bid_book.state()).unwrap(), bid_before);
        assert!(bid_before["lastTradePrice"].is_null());

        for raw in ["", "   "] {
            let mut blank = limit("blank", "buy", "2", "GTC");
            blank.accountId = raw.into();
            let err = book.submit(blank).unwrap_err();
            assert!(err.starts_with("self_trade:"), "{raw:?}: {err}");
            assert_eq!(serde_json::to_value(book.state()).unwrap(), before, "{raw:?}");
        }

        let mut empty = Book { market: "BTC/USDT".into(), ..Book::default() };
        let mut naked = limit("naked", "sell", "1", "GTC");
        naked.accountId = String::new();
        let err = empty.submit(naked).unwrap_err();
        assert!(err.starts_with("self_trade:"), "{err}");
        let state = empty.state();
        assert_eq!(state.sequence, 0);
        assert!(state.bids.is_empty());
        assert!(state.asks.is_empty());
        assert_eq!(state.lastTradePrice, None);

        let mut other = limit("other", "buy", "2", "GTC");
        other.accountId = "desk".into();
        book.submit(other).unwrap();
        let traded = book.state();
        assert!(traded.asks.is_empty());
        assert!(traded.bids.is_empty());
        assert_eq!(traded.lastTradePrice.as_deref(), Some("100"));
    }

    fn order_on(id: &str, account: &str, side: &str, qty: &str) -> Order {
        let mut order = limit(id, side, qty, "GTC");
        order.accountId = account.into();
        order
    }

    fn replay_orders(orders: &[Order]) -> Result<BookState, String> {
        let records = orders.iter().enumerate().map(|(i, order)| {
            let at = format!("2026-01-01T00:00:{:02}.000Z", i + 1);
            submit_record((i as u64) + 1, &at, serde_json::to_value(order).unwrap())
        }).collect();
        replay_book(records)
    }

    fn assert_replay_refuses_before_the_book_moves(resting: &[Order], taker: &Order) {
        let mut book = Book { market: "BTC/USDT".into(), ..Book::default() };
        for order in resting {
            book.submit(order.clone()).unwrap();
        }
        let before = serde_json::to_value(book.state()).unwrap();
        let err = book.submit(taker.clone()).unwrap_err();
        assert!(err.contains("self_trade_prevention"), "{err}");
        assert_eq!(serde_json::to_value(book.state()).unwrap(), before);

        let mut journal = resting.to_vec();
        journal.push(taker.clone());
        let err = replay_orders(&journal).unwrap_err();
        assert!(err.contains("self_trade_prevention"), "{err}");
    }

    #[test]
    fn replay_refuses_same_account_cross_behind_an_all_or_none_maker() {
        let mut desk = order_on("desk-ask", "desk", "sell", "5");
        desk.aon = true;
        let mm_ask = order_on("mm-ask", "mm", "sell", "1");
        let mm_bid = order_on("mm-bid", "mm", "buy", "1");
        let resting = replay_orders(&[desk.clone(), mm_ask.clone()]).unwrap();
        assert_eq!(resting.sequence, 2);
        assert_eq!(resting.lastTradePrice, None);
        assert!(resting.bids.is_empty());
        assert_eq!(resting.asks[0].price, "100");
        assert_eq!(resting.asks[0].orders[0].orderId, "desk-ask");
        assert_eq!(resting.asks[0].orders[0].accountId, "desk");
        assert_eq!(resting.asks[0].orders[0].remaining, "5");
        assert_eq!(resting.asks[0].orders[1].orderId, "mm-ask");
        assert_eq!(resting.asks[0].orders[1].accountId, "mm");
        assert_eq!(resting.asks[0].orders[1].remaining, "1");
        assert_replay_refuses_before_the_book_moves(&[desk, mm_ask], &mm_bid);
    }

    #[test]
    fn replay_refuses_same_account_cross_behind_a_min_qty_maker() {
        let mut desk = order_on("desk-ask", "desk", "sell", "5");
        desk.minQty = Some("2".into());
        let mm_ask = order_on("mm-ask", "mm", "sell", "1");
        let mm_bid = order_on("mm-bid", "mm", "buy", "1");
        let resting = replay_orders(&[desk.clone(), mm_ask.clone()]).unwrap();
        assert_eq!(resting.sequence, 2);
        assert_eq!(resting.lastTradePrice, None);
        assert!(resting.bids.is_empty());
        assert_eq!(resting.asks[0].orders[0].remaining, "5");
        assert_eq!(resting.asks[0].orders[0].accountId, "desk");
        assert_eq!(resting.asks[0].orders[1].remaining, "1");
        assert_eq!(resting.asks[0].orders[1].accountId, "mm");
        assert_replay_refuses_before_the_book_moves(&[desk, mm_ask], &mm_bid);
    }

    #[test]
    fn replay_refuses_same_account_cross_behind_an_iceberg_display() {
        let desk = order_on("desk-ask", "desk", "sell", "1");
        let mm_ask = order_on("mm-ask", "mm", "sell", "5");
        let mut mm_bid = order_on("mm-bid", "mm", "buy", "3");
        mm_bid.iceberg = true;
        mm_bid.displayQty = Some("1".into());
        let resting = replay_orders(&[desk.clone(), mm_ask.clone()]).unwrap();
        assert_eq!(resting.sequence, 2);
        assert_eq!(resting.lastTradePrice, None);
        assert!(resting.bids.is_empty());
        assert_eq!(resting.asks[0].orders[0].orderId, "desk-ask");
        assert_eq!(resting.asks[0].orders[0].remaining, "1");
        assert_eq!(resting.asks[0].orders[1].orderId, "mm-ask");
        assert_eq!(resting.asks[0].orders[1].accountId, "mm");
        assert_eq!(resting.asks[0].orders[1].remaining, "5");
        assert_replay_refuses_before_the_book_moves(&[desk, mm_ask], &mm_bid);
    }

    #[test]
    fn different_accounts_still_trade_when_the_taker_is_filled_before_its_own_maker() {
        let desk = order_on("desk-ask", "desk", "sell", "1");
        let mm_ask = order_on("mm-ask", "mm", "sell", "5");
        let mm_bid = order_on("mm-bid", "mm", "buy", "1");
        let state = replay_orders(&[desk, mm_ask, mm_bid]).unwrap();
        assert_eq!(state.lastTradePrice.as_deref(), Some("100"));
        assert!(state.bids.is_empty());
        assert_eq!(state.asks.len(), 1);
        assert_eq!(state.asks[0].orders.len(), 1);
        assert_eq!(state.asks[0].orders[0].orderId, "mm-ask");
        assert_eq!(state.asks[0].orders[0].accountId, "mm");
        assert_eq!(state.asks[0].orders[0].remaining, "5");
    }

    #[test]
    fn different_account_trade_stays_when_a_triggered_stop_would_self_cross() {
        let mm_ask = order_on("mm-ask", "mm", "sell", "5");
        let mut alice = order_on("alice-ask", "alice", "sell", "1");
        alice.price = Some("90".into());
        let mut stop = order_on("mm-stop", "mm", "buy", "1");
        stop.kind = "stop_limit".into();
        stop.stopPrice = Some("90".into());
        let mut bob = order_on("bob-bid", "bob", "buy", "1");
        bob.price = Some("90".into());

        let parked = replay_orders(&[mm_ask.clone(), alice.clone(), stop.clone()]).unwrap();
        assert_eq!(parked.sequence, 3);
        assert_eq!(parked.lastTradePrice, None);
        assert!(parked.bids.is_empty());
        assert_eq!(parked.stops.len(), 1);
        assert_eq!(parked.stops[0]["orderId"], "mm-stop");
        assert_eq!(parked.stops[0]["accountId"], "mm");
        assert_eq!(parked.asks.len(), 2);
        assert_eq!(parked.asks[0].price, "90");
        assert_eq!(parked.asks[0].orders[0].orderId, "alice-ask");
        assert_eq!(parked.asks[0].orders[0].remaining, "1");
        assert_eq!(parked.asks[1].price, "100");
        assert_eq!(parked.asks[1].orders[0].orderId, "mm-ask");
        assert_eq!(parked.asks[1].orders[0].accountId, "mm");
        assert_eq!(parked.asks[1].orders[0].remaining, "5");

        let state = replay_orders(&[mm_ask, alice, stop, bob]).unwrap();
        assert_eq!(state.sequence, 5);
        assert_eq!(state.lastTradePrice.as_deref(), Some("90"));
        assert!(state.bids.is_empty());
        assert!(state.stops.is_empty());
        assert_eq!(state.asks.len(), 1);
        assert_eq!(state.asks[0].price, "100");
        assert_eq!(state.asks[0].orders.len(), 1);
        assert_eq!(state.asks[0].orders[0].orderId, "mm-ask");
        assert_eq!(state.asks[0].orders[0].accountId, "mm");
        assert_eq!(state.asks[0].orders[0].remaining, "5");
    }

    #[test]
    fn blank_price_is_a_typed_refusal() {
        let mut book = Book { market: "BTC/USDT".into(), ..Book::default() };
        let mut order = limit("buy", "buy", "1", "GTC");
        order.price = None;
        let err = book.submit(order).unwrap_err();
        assert!(err.contains("stage 1 accepts limit orders only"), "{err}");
        assert!(book.state().bids.is_empty());
        assert_eq!(book.state().lastTradePrice, None);
    }

    #[test]
    fn stop_limit_stays_off_the_live_book_until_the_stop_trades() {
        let ask = limit_json("ask", "mm", "sell", "1", "100");
        let mut stop = limit_json("stop", "desk", "buy", "1", "100");
        stop["type"] = serde_json::json!("stop_limit");
        stop["stopPrice"] = serde_json::json!("150");
        let state = replay_book(vec![
            submit_record(1, AT, ask),
            submit_record(2, "2026-01-01T00:00:02.000Z", stop),
        ]).unwrap();
        assert_eq!(state.lastTradePrice, None);
        assert_eq!(resting_ids(&state.asks), vec!["ask".to_string()]);
        assert!(state.bids.is_empty());
        assert_eq!(state.stops.len(), 1);
        assert_eq!(state.stops[0]["orderId"], "stop");
        assert_eq!(state.stops[0]["stopPrice"], "150");
        assert_eq!(state.asks[0].orders[0].remaining, "1");
    }

    #[test]
    fn iceberg_does_not_trade_its_full_qty_in_one_clip() {
        let mut ask = limit_json("ask", "mm", "sell", "5", "100");
        ask["iceberg"] = serde_json::json!(true);
        ask["displayQty"] = serde_json::json!("1");
        let buy = limit_json("buy", "desk", "buy", "5", "100");
        let state = replay_book(vec![
            submit_record(1, AT, ask),
            submit_record(2, "2026-01-01T00:00:02.000Z", buy),
        ]).unwrap();
        assert_eq!(state.lastTradePrice.as_deref(), Some("100"));
        assert_eq!(state.asks.len(), 1);
        assert_eq!(state.asks[0].orders[0].remaining, "4");
        assert_eq!(state.bids.len(), 1);
        assert_eq!(state.bids[0].orders[0].remaining, "4");
    }

    #[test]
    fn crossing_iceberg_does_not_trade_more_than_its_display_in_one_clip() {
        let ask = limit_json("ask", "mm", "sell", "5", "100");
        let mut buy = limit_json("buy", "desk", "buy", "5", "100");
        buy["iceberg"] = serde_json::json!(true);
        buy["displayQty"] = serde_json::json!("1");
        let state = replay_book(vec![
            submit_record(1, AT, ask),
            submit_record(2, "2026-01-01T00:00:02.000Z", buy),
        ]).unwrap();
        assert_eq!(state.lastTradePrice.as_deref(), Some("100"));
        assert_eq!(state.asks.len(), 1);
        assert_eq!(state.asks[0].orders[0].remaining, "4");
        assert_eq!(state.bids.len(), 1);
        assert_eq!(state.bids[0].orders[0].remaining, "4");
    }

    #[test]
    fn aon_does_not_partial_fill() {
        let ask = limit_json("ask", "mm", "sell", "2", "100");
        let mut buy = limit_json("buy", "desk", "buy", "5", "100");
        buy["aon"] = serde_json::json!(true);
        let state = replay_book(vec![
            submit_record(1, AT, ask),
            submit_record(2, "2026-01-01T00:00:02.000Z", buy),
        ]).unwrap();
        assert_eq!(state.lastTradePrice, None);
        assert_eq!(state.asks[0].orders[0].remaining, "2");
        assert_eq!(state.bids[0].orders[0].remaining, "5");
    }

    #[test]
    fn reduce_only_does_not_increase_the_position() {
        let ask = limit_json("ask", "mm", "sell", "1", "100");
        let mut buy = limit_json("buy", "desk", "buy", "1", "100");
        buy["reduceOnly"] = serde_json::json!(true);
        let err = replay_book(vec![
            submit_record(1, AT, ask),
            submit_record(2, "2026-01-01T00:00:02.000Z", buy),
        ]).unwrap_err();
        assert!(err.contains("would_increase_position"), "{err}");
    }

    #[test]
    fn reduce_only_may_shrink_a_long() {
        let open_ask = limit_json("open-ask", "mm", "sell", "1", "100");
        let open_bid = limit_json("open-bid", "desk", "buy", "1", "100");
        let bid = limit_json("bid", "mm", "buy", "1", "100");
        let mut sell = limit_json("sell", "desk", "sell", "1", "100");
        sell["reduceOnly"] = serde_json::json!(true);
        let state = replay_book(vec![
            submit_record(1, AT, open_ask),
            submit_record(2, "2026-01-01T00:00:02.000Z", open_bid),
            submit_record(3, "2026-01-01T00:00:03.000Z", bid),
            submit_record(4, "2026-01-01T00:00:04.000Z", sell),
        ]).unwrap();
        assert!(state.bids.is_empty());
        assert!(state.asks.is_empty());
        assert_eq!(state.lastTradePrice.as_deref(), Some("100"));
    }

    #[test]
    fn oco_fill_cancels_the_sibling() {
        let mut a = limit_json("a", "desk", "buy", "1", "100");
        a["ocoSiblingId"] = serde_json::json!("b");
        let mut b = limit_json("b", "desk", "buy", "1", "90");
        b["ocoSiblingId"] = serde_json::json!("a");
        let sell = limit_json("sell", "mm", "sell", "1", "100");
        let state = replay_book(vec![
            submit_record(1, AT, a),
            submit_record(2, "2026-01-01T00:00:02.000Z", b),
            submit_record(3, "2026-01-01T00:00:03.000Z", sell),
        ]).unwrap();
        assert!(state.bids.is_empty(), "sibling still resting: {:?}", resting_ids(&state.bids));
        assert!(state.asks.is_empty());
        assert_eq!(state.lastTradePrice.as_deref(), Some("100"));
    }

    #[test]
    fn peg_midpoint_auction_and_exercise_are_not_plain_limits() {
        for (flag, needle) in [
            ("peg", "peg_unsupported"),
            ("midpoint", "midpoint_unsupported"),
            ("auction", "auction_unsupported"),
            ("exercise", "position_flat"),
        ] {
            let ask = limit_json("ask", "mm", "sell", "1", "100");
            let mut buy = limit_json("buy", "desk", "buy", "1", "100");
            buy[flag] = serde_json::json!(true);
            let err = replay_book(vec![
                submit_record(1, AT, ask),
                submit_record(2, "2026-01-01T00:00:02.000Z", buy),
            ]).unwrap_err();
            assert!(err.contains(needle), "{flag}: {err}");
        }
    }

    #[test]
    fn min_qty_does_not_take_a_clip_below_the_floor() {
        let ask = limit_json("ask", "mm", "sell", "1", "100");
        let mut buy = limit_json("buy", "desk", "buy", "5", "100");
        buy["minQty"] = serde_json::json!("2");
        let state = replay_book(vec![
            submit_record(1, AT, ask),
            submit_record(2, "2026-01-01T00:00:02.000Z", buy),
        ]).unwrap();
        assert_eq!(state.lastTradePrice, None);
        assert_eq!(state.asks[0].orders[0].remaining, "1");
        assert_eq!(state.bids[0].orders[0].remaining, "5");
    }

    #[test]
    fn expire_at_does_not_leave_a_resting_plain_limit() {
        let mut buy = limit_json("buy", "desk", "buy", "1", "100");
        buy["expireAt"] = serde_json::json!("2026-01-01T00:00:02.000Z");
        let sell = limit_json("sell", "mm", "sell", "1", "100");
        let state = replay_book(vec![
            submit_record(1, AT, buy),
            submit_record(2, "2026-01-01T00:00:03.000Z", sell),
        ]).unwrap();
        assert_eq!(state.lastTradePrice, None);
        assert!(state.bids.is_empty());
        assert_eq!(resting_ids(&state.asks), vec!["sell".to_string()]);
    }

    #[test]
    fn wire_flags_round_trip_on_the_order() {
        let raw = r#"{
            "orderId":"o","accountId":"desk","type":"limit","side":"buy","qty":"1","price":"100","stopPrice":null,"tif":"GTC",
            "aon":true,"iceberg":true,"displayQty":"0.2","minQty":"0.2","reduceOnly":true,
            "ocoSiblingId":"sib","expireAt":"2026-01-02T00:00:00.000Z","peg":true,"midpoint":true,"auction":true,"exercise":true
        }"#;
        let order: Order = serde_json::from_str(raw).unwrap();
        assert!(order.aon && order.iceberg && order.reduceOnly && order.peg && order.midpoint && order.auction && order.exercise);
        assert_eq!(order.displayQty.as_deref(), Some("0.2"));
        assert_eq!(order.minQty.as_deref(), Some("0.2"));
        assert_eq!(order.ocoSiblingId.as_deref(), Some("sib"));
        assert_eq!(order.expireAt.as_deref(), Some("2026-01-02T00:00:00.000Z"));
        assert_eq!(order.kind, "limit");
    }

    #[test]
    fn zero_price_or_qty_is_refused_without_moving_the_book() {
        let mut book = Book { market: "BTC/USDT".into(), ..Book::default() };
        book.submit(limit("bid", "buy", "2", "GTC")).unwrap();
        let before = serde_json::to_value(book.state()).unwrap();
        assert!(before["sequence"].as_u64().unwrap() > 0);
        assert!(before["lastTradePrice"].is_null());

        for (id, side, qty, price) in [
            ("zero-qty", "sell", "0", "100"),
            ("zero-qty-decimal", "buy", "0.0", "100"),
            ("zero-price", "sell", "1", "0"),
            ("zero-price-decimal", "buy", "1", "0.0"),
        ] {
            let mut order = limit(id, side, qty, "GTC");
            order.price = Some(price.into());
            let err = book.submit(order).unwrap_err();
            assert!(err.contains("strictly positive"), "{id}: {err}");
            assert_eq!(serde_json::to_value(book.state()).unwrap(), before, "{id}");
        }

        book.submit(limit("sell", "sell", "2", "GTC")).unwrap();
        let traded = book.state();
        assert!(traded.bids.is_empty());
        assert!(traded.asks.is_empty());
        assert_eq!(traded.lastTradePrice.as_deref(), Some("100"));
    }

    fn stop(id: &str, side: &str, qty: &str, stop_price: Option<&str>) -> Order {
        Order {
            orderId: id.into(),
            accountId: "desk".into(),
            kind: "stop".into(),
            side: side.into(),
            qty: qty.into(),
            price: None,
            stopPrice: stop_price.map(str::to_string),
            tif: "GTC".into(),
            aon: false,
            iceberg: false,
            displayQty: None,
            minQty: None,
            reduceOnly: false,
            ocoSiblingId: None,
            expireAt: None,
            peg: false,
            midpoint: false,
            auction: false,
            exercise: false,
        }
    }

    #[test]
    fn zero_stop_price_is_refused_before_the_stop_rests() {
        let mut book = Book { market: "BTC/USDT".into(), ..Book::default() };
        let empty = serde_json::to_value(book.state()).unwrap();
        assert_eq!(empty["sequence"], 0);
        assert!(empty["stops"].as_array().unwrap().is_empty());

        for raw in ["0", "0.0"] {
            let err = book.submit(stop("zero-stop", "sell", "1", Some(raw))).unwrap_err();
            assert!(err.contains("invalid_price") && err.contains("strictly positive"), "{raw}: {err}");
            assert_eq!(serde_json::to_value(book.state()).unwrap(), empty, "{raw}");
        }

        for raw in [None, Some("")] {
            let err = book.submit(stop("blank-stop", "sell", "1", raw)).unwrap_err();
            assert!(err.contains("missing_stop_price"), "{raw:?}: {err}");
            assert!(!err.contains("0"), "{raw:?}: {err}");
            assert_eq!(serde_json::to_value(book.state()).unwrap(), empty, "{raw:?}");
        }

        book.submit(stop("rest-stop", "sell", "1", Some("90"))).unwrap();
        let rested = book.state();
        assert_eq!(rested.sequence, 1);
        assert!(rested.bids.is_empty());
        assert!(rested.asks.is_empty());
        assert_eq!(rested.lastTradePrice, None);
        assert_eq!(rested.stops.len(), 1);
        assert_eq!(rested.stops[0]["orderId"], "rest-stop");
        assert_eq!(rested.stops[0]["stopPrice"], "90");
        assert_eq!(rested.stops[0]["price"], serde_json::Value::Null);

        let mut book = Book { market: "BTC/USDT".into(), ..Book::default() };
        book.submit(limit("bid", "buy", "1", "GTC")).unwrap();
        let with_bid = serde_json::to_value(book.state()).unwrap();
        assert_eq!(with_bid["sequence"], 1);
        assert_eq!(with_bid["bids"][0]["orders"][0]["orderId"], "bid");
        assert!(with_bid["stops"].as_array().unwrap().is_empty());
        let err = book.submit(stop("zero-stop", "sell", "1", Some("0"))).unwrap_err();
        assert!(err.contains("invalid_price") && err.contains("strictly positive"), "{err}");
        assert_eq!(serde_json::to_value(book.state()).unwrap(), with_bid);
    }

    fn priced(id: &str, account: &str, side: &str, qty: &str, price: &str, tif: &str) -> Order {
        let mut order = limit(id, side, qty, tif);
        order.accountId = account.into();
        order.price = Some(price.into());
        order
    }

    #[test]
    fn post_only_that_would_cross_prints_nothing_and_rests_nothing() {
        let ask = priced("ask", "mm", "sell", "2", "99.10", "GTC");
        let mut book = Book { market: "BTC/USDT".into(), ..Book::default() };
        book.submit(ask.clone()).unwrap();
        let before = serde_json::to_value(book.state()).unwrap();
        assert!(before["lastTradePrice"].is_null());
        assert_eq!(before["asks"][0]["orders"][0]["remaining"], "2");

        for (id, price) in [("po-eq", "99.1"), ("po-through", "100"), ("po-padded", "99.10")] {
            let buy = priced(id, "desk", "buy", "5", price, "PO");
            let err = book.submit(buy.clone()).unwrap_err();
            assert!(err.starts_with("post_only_would_cross"), "{price}: {err}");
            assert_eq!(serde_json::to_value(book.state()).unwrap(), before, "{price}");
            let err = replay_orders(&[ask.clone(), buy]).unwrap_err();
            assert!(err.starts_with("post_only_would_cross"), "replay {price}: {err}");
        }

        let mut bid_book = Book { market: "BTC/USDT".into(), ..Book::default() };
        let bid = priced("bid", "desk", "buy", "2", "100.10", "GTC");
        bid_book.submit(bid.clone()).unwrap();
        let bid_before = serde_json::to_value(bid_book.state()).unwrap();
        let sell = priced("po-sell", "mm", "sell", "5", "100.1", "PO");
        let err = bid_book.submit(sell.clone()).unwrap_err();
        assert!(err.starts_with("post_only_would_cross"), "{err}");
        assert_eq!(serde_json::to_value(bid_book.state()).unwrap(), bid_before);
        assert!(bid_before["lastTradePrice"].is_null());
        assert!(bid_before["bids"][0]["orders"][0]["remaining"] == "2");
        let err = replay_orders(&[bid, sell]).unwrap_err();
        assert!(err.starts_with("post_only_would_cross"), "{err}");
    }

    #[test]
    fn post_only_that_would_not_cross_rests_and_does_not_take() {
        let ask = priced("ask", "mm", "sell", "2", "100.50", "GTC");
        let buy = priced("po", "desk", "buy", "1", "100.49", "PO");
        let state = replay_orders(&[ask, buy]).unwrap();
        assert_eq!(state.lastTradePrice, None);
        assert_eq!(state.asks.len(), 1);
        assert_eq!(state.asks[0].orders[0].orderId, "ask");
        assert_eq!(state.asks[0].orders[0].remaining, "2");
        assert_eq!(state.bids.len(), 1);
        assert_eq!(state.bids[0].price, "100.49");
        assert_eq!(state.bids[0].orders[0].orderId, "po");
        assert_eq!(state.bids[0].orders[0].remaining, "1");

        let mut book = Book { market: "BTC/USDT".into(), ..Book::default() };
        book.submit(priced("alone", "desk", "sell", "1", "101", "PO")).unwrap();
        let alone = book.state();
        assert_eq!(alone.lastTradePrice, None);
        assert!(alone.bids.is_empty());
        assert_eq!(alone.asks[0].orders[0].orderId, "alone");
        assert_eq!(alone.asks[0].orders[0].remaining, "1");

        let bid = priced("bid", "desk", "buy", "2", "100", "GTC");
        let sell = priced("po-sell", "mm", "sell", "1", "100.01", "PO");
        let behind = replay_orders(&[bid, sell]).unwrap();
        assert_eq!(behind.lastTradePrice, None);
        assert_eq!(behind.bids[0].orders[0].remaining, "2");
        assert_eq!(behind.asks[0].price, "100.01");
        assert_eq!(behind.asks[0].orders[0].orderId, "po-sell");
        assert_eq!(behind.asks[0].orders[0].remaining, "1");
    }

    #[test]
    fn post_only_same_account_cross_prints_nothing() {
        let ask = priced("ask", "mm", "sell", "2", "100", "GTC");
        let mut book = Book { market: "BTC/USDT".into(), ..Book::default() };
        book.submit(ask.clone()).unwrap();
        let before = serde_json::to_value(book.state()).unwrap();
        let buy = priced("po", "mm", "buy", "2", "100", "PO");
        let err = book.submit(buy.clone()).unwrap_err();
        assert!(err.starts_with("post_only_would_cross"), "{err}");
        assert_eq!(serde_json::to_value(book.state()).unwrap(), before);
        assert!(before["lastTradePrice"].is_null());
        let err = replay_orders(&[ask, buy]).unwrap_err();
        assert!(err.starts_with("post_only_would_cross"), "{err}");
    }

    #[test]
    fn blank_or_unknown_tif_does_not_take_or_rest() {
        let ask = priced("ask", "mm", "sell", "2", "100", "GTC");
        let mut book = Book { market: "BTC/USDT".into(), ..Book::default() };
        book.submit(ask.clone()).unwrap();
        let before = serde_json::to_value(book.state()).unwrap();
        assert_eq!(before["sequence"], 1);
        assert!(before["lastTradePrice"].is_null());

        for tif in ["", "   ", "DAY", "gtc", "po", "GTC "] {
            let buy = priced("bad", "desk", "buy", "2", "100", tif);
            let err = book.submit(buy.clone()).unwrap_err();
            assert!(err.starts_with("invalid_tif"), "{tif:?}: {err}");
            assert!(err.contains("does not invent a fill or a price"), "{tif:?}: {err}");
            assert_eq!(serde_json::to_value(book.state()).unwrap(), before, "{tif:?}");
            let err = replay_orders(&[ask.clone(), buy]).unwrap_err();
            assert!(err.starts_with("invalid_tif"), "replay {tif:?}: {err}");
        }

        let mut empty = Book { market: "BTC/USDT".into(), ..Book::default() };
        let err = empty.submit(priced("rest", "desk", "buy", "1", "99", "DAY")).unwrap_err();
        assert!(err.starts_with("invalid_tif"), "{err}");
        let state = empty.state();
        assert_eq!(state.sequence, 0);
        assert!(state.bids.is_empty());
        assert!(state.asks.is_empty());
        assert_eq!(state.lastTradePrice, None);
    }

    #[test]
    fn ioc_does_not_rest_a_remainder() {
        let ask = priced("ask", "mm", "sell", "2", "100", "GTC");
        let buy = priced("ioc", "desk", "buy", "5", "100", "IOC");
        let state = replay_orders(&[ask, buy]).unwrap();
        assert_eq!(state.lastTradePrice.as_deref(), Some("100"));
        assert!(state.asks.is_empty());
        assert!(state.bids.is_empty());
    }

    #[test]
    fn gtd_and_gtt_still_require_a_future_expire_at() {
        for tif in ["GTD", "GTT"] {
            let mut book = Book { market: "BTC/USDT".into(), ..Book::default() };
            let err = book.submit_at(priced("open", "desk", "buy", "1", "100", tif), Some(AT)).unwrap_err();
            assert!(err.starts_with("missing_expire_at"), "{tif}: {err}");
            assert_eq!(book.state().sequence, 0);
            assert!(book.state().bids.is_empty());
            assert_eq!(book.state().lastTradePrice, None);

            let mut expired = priced("expired", "desk", "buy", "1", "100", tif);
            expired.expireAt = Some(AT.into());
            let err = book.submit_at(expired.clone(), Some(AT)).unwrap_err();
            assert!(err.starts_with("already_expired"), "{tif}: {err}");
            assert_eq!(book.state().sequence, 0, "{tif}");
            let err = replay_orders(&[expired]).unwrap_err();
            assert!(err.starts_with("already_expired"), "replay {tif}: {err}");

            let mut past = priced("past", "desk", "buy", "1", "100", tif);
            past.expireAt = Some("2026-01-01T00:00:00.000Z".into());
            let err = book.submit_at(past, Some(AT)).unwrap_err();
            assert!(err.starts_with("already_expired"), "{tif}: {err}");
            assert_eq!(book.state().sequence, 0, "{tif}");
        }
    }

    #[test]
    fn replay_drops_gtd_and_gtt_when_the_deadline_has_passed() {
        for tif in ["GTD", "GTT"] {
            let mut buy = priced("buy", "desk", "buy", "1", "100", tif);
            buy.expireAt = Some("2026-01-01T00:00:02.000Z".into());
            let sell = priced("sell", "mm", "sell", "1", "100", "GTC");
            let state = replay_orders(&[buy, sell]).unwrap();
            assert_eq!(state.lastTradePrice, None, "{tif}");
            assert!(state.bids.is_empty(), "{tif}");
            assert_eq!(state.asks.len(), 1, "{tif}");
            assert_eq!(state.asks[0].orders[0].orderId, "sell");
            assert_eq!(state.asks[0].orders[0].remaining, "1");
        }

        let mut live = priced("live", "desk", "buy", "1", "100", "GTD");
        live.expireAt = Some("2026-01-01T00:00:05.000Z".into());
        let sell = priced("sell", "mm", "sell", "1", "100", "GTC");
        let traded = replay_orders(&[live, sell]).unwrap();
        assert_eq!(traded.lastTradePrice.as_deref(), Some("100"));
        assert!(traded.bids.is_empty());
        assert!(traded.asks.is_empty());
    }

    #[test]
    fn different_account_trade_stays_when_a_triggered_post_only_stop_would_cross() {
        let desk_ask = priced("desk-ask", "desk", "sell", "5", "100", "GTC");
        let mut alice = priced("alice-ask", "alice", "sell", "1", "90", "GTC");
        alice.price = Some("90".into());
        let mut stop = priced("mm-stop", "mm", "buy", "1", "100", "PO");
        stop.kind = "stop_limit".into();
        stop.stopPrice = Some("90".into());
        let mut bob = priced("bob-bid", "bob", "buy", "1", "90", "GTC");
        bob.price = Some("90".into());

        let state = replay_orders(&[desk_ask, alice, stop, bob]).unwrap();
        assert_eq!(state.sequence, 5);
        assert_eq!(state.lastTradePrice.as_deref(), Some("90"));
        assert!(state.bids.is_empty());
        assert!(state.stops.is_empty());
        assert_eq!(state.asks.len(), 1);
        assert_eq!(state.asks[0].price, "100");
        assert_eq!(state.asks[0].orders[0].orderId, "desk-ask");
        assert_eq!(state.asks[0].orders[0].remaining, "5");
    }

    #[test]
    fn a_live_order_id_cannot_be_submitted_twice() {
        let mut book = Book { market: "BTC/USDT".into(), ..Book::default() };
        book.submit(order_on("bid", "desk", "buy", "1")).unwrap();
        let before = serde_json::to_value(book.state()).unwrap();
        assert_eq!(before["sequence"], 1);
        assert_eq!(resting_ids(&book.state().bids), vec!["bid".to_string()]);
        assert!(book.state().asks.is_empty());
        assert!(book.state().stops.is_empty());

        let err = book.submit(order_on("bid", "mm", "buy", "1")).unwrap_err();
        assert!(err.contains("duplicate_order_id"), "{err}");
        assert_eq!(serde_json::to_value(book.state()).unwrap(), before);
        assert_eq!(resting_ids(&book.state().bids), vec!["bid".to_string()]);

        let mut stop_on_book = order_on("bid", "mm", "sell", "1");
        stop_on_book.kind = "stop_limit".into();
        stop_on_book.stopPrice = Some("150".into());
        let err = book.submit(stop_on_book).unwrap_err();
        assert!(err.contains("duplicate_order_id"), "{err}");
        assert_eq!(serde_json::to_value(book.state()).unwrap(), before);
        assert!(book.state().stops.is_empty());

        let mut parked = order_on("stop", "mm", "sell", "1");
        parked.kind = "stop_limit".into();
        parked.stopPrice = Some("150".into());
        book.submit(parked).unwrap();
        let with_stop = serde_json::to_value(book.state()).unwrap();
        assert_eq!(with_stop["stops"].as_array().unwrap().len(), 1);
        assert_eq!(with_stop["stops"][0]["orderId"], "stop");
        assert_eq!(resting_ids(&book.state().bids), vec!["bid".to_string()]);

        let mut stop_again = order_on("stop", "desk", "buy", "1");
        stop_again.kind = "stop_limit".into();
        stop_again.stopPrice = Some("150".into());
        let err = book.submit(stop_again).unwrap_err();
        assert!(err.contains("duplicate_order_id"), "{err}");
        assert_eq!(serde_json::to_value(book.state()).unwrap(), with_stop);

        book.cancel("bid");
        let cleared = book.state();
        assert!(cleared.bids.is_empty());
        assert!(cleared.asks.is_empty());
        assert_eq!(cleared.stops.len(), 1);
        assert_eq!(cleared.stops[0]["orderId"], "stop");
        assert_eq!(cleared.sequence, with_stop["sequence"].as_u64().unwrap() + 1);

        book.submit(order_on("other", "desk", "buy", "1")).unwrap();
        let next = book.state();
        assert_eq!(resting_ids(&next.bids), vec!["other".to_string()]);
        assert!(next.asks.is_empty());
        assert_eq!(next.stops.len(), 1);
        assert_eq!(next.stops[0]["orderId"], "stop");
    }
}
