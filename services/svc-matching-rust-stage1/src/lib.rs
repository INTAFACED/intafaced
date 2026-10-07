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

fn parse_amount(s: &str) -> Result<u128, String> {
    let (whole, frac) = s.split_once('.').unwrap_or((s, ""));
    if whole.is_empty() || frac.len() > SCALE as usize || !whole.chars().all(|c| c.is_ascii_digit()) || !frac.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("invalid decimal amount: {s}"));
    }
    let mut digits = frac.to_owned();
    digits.extend(std::iter::repeat('0').take(SCALE as usize - digits.len()));
    let w = whole.parse::<u128>().map_err(|_| format!("amount overflow: {s}"))?;
    let f = if digits.is_empty() { 0 } else { digits.parse::<u128>().map_err(|_| format!("amount overflow: {s}"))? };
    w.checked_mul(10u128.pow(SCALE)).and_then(|x| x.checked_add(f)).ok_or_else(|| format!("amount overflow: {s}"))
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
        Some(s) => parse_amount(s),
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
        for maker in opposite {
            if remaining == 0 || take_left == 0 {
                break;
            }
            let maker_price = parse_amount(maker.order.price.as_deref().unwrap_or(""))?;
            if !crosses(&order.side, price, maker_price) {
                break;
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
                break;
            }
            if !clip_ok(traded, remaining - traded, taker_min) || !clip_ok(traded, maker.remaining - traded, maker_min) {
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

    fn match_rest(&mut self, order: Order, qty: u128, price: u128, display: Option<u128>) -> Result<(), String> {
        let clips = self.plan_take(&order, price, qty, display)?;
        let covered: u128 = clips.iter().map(|c| c.qty).sum();
        if order.tif == "FOK" && covered < qty {
            return Ok(());
        }
        let take: Vec<Clip> = if order.aon && covered < qty { Vec::new() } else { clips };
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
        if remaining > 0 && order.tif != "IOC" && order.tif != "FOK" {
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
            self.match_rest(stop.order, qty, price, display)?;
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
            accountId: "desk".into(),
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
}
