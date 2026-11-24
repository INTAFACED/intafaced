//! The lot engine for the lot book (`lot-engine.ts`), rule for rule. The year pack keeps its own
//! matcher (`lots.rs`).
//!
//! Every lot has a deterministic id (`lot:<acquireTxId>:<assetId>`), a source and a basis that is a dollar amount or
//! unknown; unknown is never zero. FIFO, LIFO and HIFO draw lots in that order (HIFO cannot rank a lot with no basis, so a
//! sale that would have to is unknown as a whole, its quantity drawn oldest first); AVERAGE keeps one running cost per
//! coin. A move between two of the customer's own accounts carries the lots the method would draw on next (OWN-ACCOUNT
//! CARRY); a withdrawal is drawn like a sale (MOVED OUT); with transfers left out, the lots from transfers are a pool of
//! their own (KEPT APART).

use std::collections::{HashMap, HashSet};

use crate::money::{cmp_products, mul, share};
use crate::ports::EngineMethod;
use crate::tax::{
    Amount, TAX_COST_BASIS_UNAVAILABLE, TAX_LOT_PICK_UNUSABLE, TAX_LOT_UNDERFLOW, locale_compare,
};
use crate::time::Instant;

/// `LotSource`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LotSource {
    Trade,
    Deposit,
    Reward,
    TransferIn,
    OtherIn,
}

impl LotSource {
    pub fn name(self) -> &'static str {
        match self {
            Self::Trade => "trade",
            Self::Deposit => "deposit",
            Self::Reward => "reward",
            Self::TransferIn => "transfer_in",
            Self::OtherIn => "other_in",
        }
    }

    /// `LOT_TRANSFER_SOURCES`: left out of every figure while the customer leaves transfers out.
    pub fn is_transfer(self) -> bool {
        matches!(self, Self::Deposit | Self::TransferIn)
    }
}

/// `ValuedAt`: an arrival's dollar value when it arrived and the price that gave it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValuedAt {
    pub usd: Amount,
    pub market: String,
    pub timeframe: Option<String>,
    pub candle_at: Option<Instant>,
    pub price: Amount,
}

/// `CarriedFrom`: the lot a carried lot was split from, and the move that carried it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CarriedFrom {
    pub lot_id: String,
    pub tx_id: String,
    pub moved_at: Instant,
}

/// `CarriedIn`: what a lot carried in from a book built apart keeps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CarriedIn {
    pub lot_id: String,
    pub acquired_at: Instant,
    pub from: Option<CarriedFrom>,
    pub customer_entered: bool,
    pub price_lot_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Side {
    Acquire {
        cost_usd: Option<Amount>,
        source: LotSource,
        reason: String,
        valued_at: Option<ValuedAt>,
        /// `None`: the main account.
        space: Option<String>,
        carried: Option<Box<CarriedIn>>,
    },
    Dispose {
        proceeds_usd: Option<Amount>,
        /// A withdrawal to outside (`kind: 'moved_out'`); false: a sale.
        moved_out: bool,
    },
    Move {
        from: Option<String>,
        to: Option<String>,
    },
}

impl Side {
    fn order(&self) -> u8 {
        match self {
            Side::Acquire { .. } => 0,
            Side::Move { .. } => 1,
            Side::Dispose { .. } => 2,
        }
    }
}

/// `EngineMovement`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Movement {
    pub tx_id: String,
    pub posted_at: Instant,
    pub asset_id: String,
    pub qty: Amount,
    pub side: Side,
}

/// `MethodSource`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MethodSource {
    Preview,
    Day,
    Asset,
    Account,
    Default,
}

impl MethodSource {
    pub fn name(self) -> &'static str {
        match self {
            Self::Preview => "preview",
            Self::Day => "day",
            Self::Asset => "asset",
            Self::Account => "account",
            Self::Default => "default",
        }
    }
}

/// `SaleRule`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaleRule {
    pub method: EngineMethod,
    pub lot_id: Option<String>,
    pub source: MethodSource,
}

/// What a rule is chosen by: the sale's transaction, time and coin.
#[derive(Debug, Clone, Copy)]
pub struct SaleAt<'a> {
    pub tx_id: &'a str,
    pub posted_at: Instant,
    pub asset_id: &'a str,
}

/// `SaleRules`: one method for every sale, or a rule per sale.
pub enum SaleRules<'a> {
    One(EngineMethod),
    By(&'a dyn Fn(SaleAt<'_>) -> SaleRule),
}

impl SaleRules<'_> {
    fn rule(&self, at: SaleAt<'_>) -> SaleRule {
        match self {
            SaleRules::One(m) => SaleRule {
                method: *m,
                lot_id: None,
                source: MethodSource::Default,
            },
            SaleRules::By(f) => f(at),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LotMatch {
    pub lot_id: String,
    pub qty: Amount,
    pub cost_usd: Option<Amount>,
    pub proceeds_usd: Option<Amount>,
    pub realized_usd: Option<Amount>,
    pub customer_entered: bool,
}

/// `EngineSale`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineSale {
    pub moved_out: bool,
    pub rule: SaleRule,
    pub picked_lot_id: Option<String>,
    pub asset_id: String,
    pub tx_id: String,
    pub posted_at: Instant,
    pub qty: Amount,
    pub unmatched_qty: Amount,
    pub proceeds_usd: Option<Amount>,
    pub cost_usd: Option<Amount>,
    pub realized_usd: Option<Amount>,
    pub matches: Vec<LotMatch>,
}

/// `EngineLot`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineLot {
    pub id: String,
    pub asset_id: String,
    pub acquired_at: Instant,
    pub acquire_tx_id: String,
    pub source: LotSource,
    pub reason: String,
    pub qty: Amount,
    pub remaining: Amount,
    pub cost_usd: Option<Amount>,
    pub remaining_cost_usd: Option<Amount>,
    pub valued_at: Option<ValuedAt>,
    pub customer_entered: bool,
    /// Set only when the customer's price is stored under another lot's id.
    pub price_lot_id: Option<String>,
    pub space: Option<String>,
    pub carried_from: Option<CarriedFrom>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineRun {
    pub lots: Vec<EngineLot>,
    pub sales: Vec<EngineSale>,
    pub residuals: Vec<&'static str>,
}

/// `lotIdOf`.
pub fn lot_id_of(acquire_tx_id: &str, asset_id: &str) -> String {
    format!("lot:{acquire_tx_id}:{asset_id}")
}

/// The fixed part of a lot, as it arrived.
#[derive(Debug, Clone)]
struct LotHead {
    id: String,
    asset_id: String,
    acquired_at: Instant,
    acquire_tx_id: String,
    source: LotSource,
    reason: String,
    qty: Amount,
    cost_usd: Option<Amount>,
    valued_at: Option<ValuedAt>,
    space: Option<String>,
    carried_from: Option<CarriedFrom>,
}

#[derive(Debug, Clone)]
struct OpenLot {
    lot: LotHead,
    remaining: Amount,
    remaining_cost: Option<Amount>,
    customer_entered: bool,
    price_lot_id: Option<String>,
}

/// Every lot of one asset, and which are open in each account (indices, oldest first).
struct Book {
    arena: Vec<OpenLot>,
    open_in: HashMap<String, Vec<usize>>,
}

impl Book {
    fn key(space: Option<&str>) -> String {
        space.unwrap_or("").to_owned()
    }

    fn take_open(&mut self, space: Option<&str>) -> Vec<usize> {
        self.open_in.remove(&Self::key(space)).unwrap_or_default()
    }

    fn put_open(&mut self, space: Option<&str>, list: Vec<usize>) {
        self.open_in.insert(Self::key(space), list);
    }

    fn lot(&self, i: usize) -> Option<&OpenLot> {
        self.arena.get(i)
    }

    fn lot_mut(&mut self, i: usize) -> Option<&mut OpenLot> {
        self.arena.get_mut(i)
    }

    /// Inserts into an account's open lots at its acquired date (after every lot no later than it).
    fn insert_by_date(&self, list: &mut Vec<usize>, entry: usize) {
        let when = self.lot(entry).map_or(Instant(0), |l| l.lot.acquired_at);
        let mut at = list.len();
        while at > 0
            && list
                .get(at - 1)
                .and_then(|i| self.lot(*i))
                .is_some_and(|l| l.lot.acquired_at > when)
        {
            at -= 1;
        }
        list.insert(at, entry);
    }

    fn remaining(&self, i: usize) -> Amount {
        self.lot(i).map_or(Amount::ZERO, |l| l.remaining)
    }

    fn remaining_cost(&self, i: usize) -> Option<Amount> {
        self.lot(i).and_then(|l| l.remaining_cost)
    }

    /// `pick`: the index the method draws next, `None` when HIFO meets a lot with no basis.
    fn pick(&self, open: &[usize], method: EngineMethod) -> Option<usize> {
        match method {
            EngineMethod::Lifo => return Some(open.len().saturating_sub(1)),
            EngineMethod::Hifo => {}
            _ => return Some(0),
        }
        let mut best = 0;
        for (i, a) in open.iter().enumerate() {
            let a_cost = self.remaining_cost(*a)?;
            let b = *open.get(best)?;
            let b_cost = self.remaining_cost(b)?;
            if cmp_products(a_cost, self.remaining(b), b_cost, self.remaining(*a)).is_gt() {
                best = i;
            }
        }
        Some(best)
    }

    /// `averagePoolOf`.
    fn average_pool(&self, open: &[usize]) -> Pool {
        let mut qty = Amount::ZERO;
        let mut cost = Some(Amount::ZERO);
        for i in open {
            qty += self.remaining(*i);
            cost = match (cost, self.remaining_cost(*i)) {
                (Some(c), Some(r)) => Some(c + r),
                _ => None,
            };
        }
        let entered = cost.is_some()
            && open
                .iter()
                .any(|i| self.lot(*i).is_some_and(|l| l.customer_entered));
        Pool { qty, cost, entered }
    }

    /// `restateAtAverage`.
    fn restate_at_average(&mut self, open: &[usize], pool: &Pool, taken: Amount) {
        let Some(total) = pool.cost else {
            for i in open {
                if let Some(l) = self.lot_mut(*i) {
                    l.remaining_cost = None;
                }
            }
            return;
        };
        let mut left = total - taken;
        let last = open.len().saturating_sub(1);
        for (k, i) in open.iter().enumerate() {
            let part = if k == last {
                left
            } else {
                share(total, pool.qty, self.remaining(*i))
            };
            if let Some(l) = self.lot_mut(*i) {
                l.remaining_cost = Some(part);
                if pool.entered {
                    l.customer_entered = true;
                }
            }
            left -= part;
        }
    }
}

struct Pool {
    qty: Amount,
    cost: Option<Amount>,
    entered: bool,
}

/// Ids handed out so far, shared by every asset of a run.
struct Ids(HashSet<String>);

impl Ids {
    fn next(&mut self, base: &str) -> String {
        let mut id = base.to_owned();
        let mut n = 2;
        while self.0.contains(&id) {
            id = format!("{base}:{n}");
            n += 1;
        }
        self.0.insert(id.clone());
        id
    }
}

type Prices<'a> = Option<&'a HashMap<String, Amount>>;

fn entered_price(prices: Prices<'_>, id: &str) -> Option<Amount> {
    prices
        .and_then(|p| p.get(id))
        .copied()
        .filter(|p| *p > Amount::ZERO)
}

/// `runLotEngine`.
pub fn run_lot_engine(
    movements: &[Movement],
    rules: &SaleRules<'_>,
    override_price_per_unit: Prices<'_>,
    apart: Option<&dyn Fn(LotSource) -> bool>,
) -> EngineRun {
    let mut by_asset: Vec<(&str, Vec<&Movement>)> = Vec::new();
    for m in movements.iter().filter(|m| m.qty > Amount::ZERO) {
        match by_asset.iter_mut().find(|(a, _)| *a == m.asset_id) {
            Some((_, list)) => list.push(m),
            None => by_asset.push((&m.asset_id, vec![m])),
        }
    }
    let mut lots: Vec<EngineLot> = Vec::new();
    let mut sales: Vec<EngineSale> = Vec::new();
    let mut residuals: Vec<&'static str> = Vec::new();
    let mut ids = Ids(HashSet::new());

    for (_, mut list) in by_asset {
        list.sort_by(|a, b| {
            a.posted_at
                .cmp(&b.posted_at)
                .then_with(|| a.side.order().cmp(&b.side.order()))
                .then_with(|| locale_compare(&a.tx_id, &b.tx_id))
        });
        let mut book = Book {
            arena: Vec::new(),
            open_in: HashMap::new(),
        };
        for m in list {
            let at = SaleAt {
                tx_id: &m.tx_id,
                posted_at: m.posted_at,
                asset_id: &m.asset_id,
            };
            match &m.side {
                Side::Move { from, to } => {
                    let method = rules.rule(at).method;
                    carry(
                        &mut book,
                        m,
                        method,
                        from.as_deref(),
                        to.as_deref(),
                        &mut ids,
                        &mut residuals,
                        override_price_per_unit,
                    );
                }
                Side::Acquire {
                    cost_usd,
                    source,
                    reason,
                    valued_at,
                    space,
                    carried,
                } => {
                    let base = carried
                        .as_ref()
                        .map_or_else(|| lot_id_of(&m.tx_id, &m.asset_id), |c| c.lot_id.clone());
                    let id = ids.next(&base);
                    let price = if cost_usd.is_none() {
                        entered_price(override_price_per_unit, &id)
                    } else {
                        None
                    };
                    let entered = price.is_some();
                    let cost = price.map_or(*cost_usd, |p| Some(mul(p, m.qty)));
                    let inherited = !entered
                        && cost.is_some()
                        && carried.as_ref().is_some_and(|c| c.customer_entered);
                    let price_lot_id = if entered {
                        Some(id.clone())
                    } else if inherited {
                        carried.as_ref().and_then(|c| c.price_lot_id.clone())
                    } else {
                        None
                    };
                    let entry = OpenLot {
                        lot: LotHead {
                            id,
                            asset_id: m.asset_id.clone(),
                            acquired_at: carried.as_ref().map_or(m.posted_at, |c| c.acquired_at),
                            acquire_tx_id: m.tx_id.clone(),
                            source: *source,
                            reason: reason.clone(),
                            qty: m.qty,
                            cost_usd: cost,
                            valued_at: valued_at.clone(),
                            space: space.clone(),
                            carried_from: carried.as_ref().and_then(|c| c.from.clone()),
                        },
                        remaining: m.qty,
                        remaining_cost: cost,
                        customer_entered: entered || inherited,
                        price_lot_id,
                    };
                    book.arena.push(entry);
                    let idx = book.arena.len() - 1;
                    let mut here = book.take_open(space.as_deref());
                    if carried.is_some() {
                        book.insert_by_date(&mut here, idx);
                    } else {
                        here.push(idx);
                    }
                    book.put_open(space.as_deref(), here);
                }
                Side::Dispose {
                    proceeds_usd,
                    moved_out,
                } => {
                    let rule = rules.rule(at);
                    let rule = if *moved_out {
                        SaleRule {
                            method: rule.method,
                            lot_id: None,
                            source: rule.source,
                        }
                    } else {
                        rule
                    };
                    let mut open = book.take_open(None);
                    sales.push(dispose(
                        &mut book,
                        m,
                        *proceeds_usd,
                        *moved_out,
                        &mut open,
                        rule,
                        &mut residuals,
                        apart,
                    ));
                    book.put_open(None, open);
                }
            }
        }
        for entry in book.arena {
            let customer = entry.customer_entered;
            let price_lot_id = entry
                .price_lot_id
                .filter(|p| customer && *p != entry.lot.id);
            if entry.remaining > Amount::ZERO && entry.remaining_cost.is_none() {
                residuals.push(TAX_COST_BASIS_UNAVAILABLE);
            }
            let head = entry.lot;
            lots.push(EngineLot {
                id: head.id,
                asset_id: head.asset_id,
                acquired_at: head.acquired_at,
                acquire_tx_id: head.acquire_tx_id,
                source: head.source,
                reason: head.reason,
                qty: head.qty,
                remaining: entry.remaining,
                cost_usd: head.cost_usd,
                remaining_cost_usd: if entry.remaining == Amount::ZERO {
                    Some(Amount::ZERO)
                } else {
                    entry.remaining_cost
                },
                valued_at: head.valued_at,
                customer_entered: customer,
                price_lot_id,
                space: head.space,
                carried_from: head.carried_from,
            });
        }
    }
    lots.sort_by(|a, b| {
        a.acquired_at
            .cmp(&b.acquired_at)
            .then_with(|| locale_compare(&a.id, &b.id))
    });
    sales.sort_by(|a, b| {
        b.posted_at
            .cmp(&a.posted_at)
            .then_with(|| locale_compare(&a.tx_id, &b.tx_id))
    });
    residuals.sort_unstable();
    residuals.dedup();
    EngineRun {
        lots,
        sales,
        residuals,
    }
}

/// One own-account move (`carry`): open lots leave `from` in the method's order, and each part arrives in `to` as a lot
/// with the same acquired date, source and share of basis. Quantity no open lot covered arrives with no basis.
#[expect(
    clippy::too_many_arguments,
    reason = "the TypeScript function's own parameters"
)]
fn carry(
    book: &mut Book,
    m: &Movement,
    method: EngineMethod,
    from_space: Option<&str>,
    to_space: Option<&str>,
    ids: &mut Ids,
    residuals: &mut Vec<&'static str>,
    prices: Prices<'_>,
) {
    // Both ends are taken out of the book while the move runs; a move within one account reaches the same list twice in
    // the TypeScript, so it is handled on one list here.
    let same = Book::key(from_space) == Book::key(to_space);
    let mut from = book.take_open(from_space);
    let mut to = if same {
        Vec::new()
    } else {
        book.take_open(to_space)
    };
    let mut remaining = m.qty;
    let pool = (method == EngineMethod::Average).then(|| book.average_pool(&from));
    let mut unranked = false;
    let mut taken: Amount = Amount::ZERO;
    while remaining > Amount::ZERO && !from.is_empty() {
        let picked = match method {
            EngineMethod::Lifo => Some(from.len() - 1),
            EngineMethod::Hifo => book.pick(&from, EngineMethod::Hifo),
            _ => Some(0),
        };
        let idx = picked.unwrap_or_else(|| {
            unranked = true;
            residuals.push(TAX_COST_BASIS_UNAVAILABLE);
            0
        });
        let Some(lot_index) = from.get(idx).copied() else {
            break;
        };
        let Some(lot) = book.lot(lot_index).cloned() else {
            break;
        };
        let take = remaining.min(lot.remaining);
        let id = ids.next(&format!("{}>{}", lot.lot.id, m.tx_id));
        let own = if unranked {
            None
        } else if let Some(p) = &pool {
            p.cost.map(|c| share(c, p.qty, take))
        } else {
            lot.remaining_cost.map(|c| share(c, lot.remaining, take))
        };
        let price = if own.is_none() {
            entered_price(prices, &id)
        } else {
            None
        };
        let entered = price.is_some();
        let cost = price.map_or(own, |p| Some(mul(p, take)));
        let valued_at = lot.lot.valued_at.as_ref().map(|v| ValuedAt {
            usd: share(v.usd, lot.lot.qty, take),
            ..v.clone()
        });
        let inherited = !entered
            && own.is_some()
            && (lot.customer_entered || pool.as_ref().is_some_and(|p| p.entered));
        let price_lot_id = if entered {
            Some(id.clone())
        } else if inherited && pool.is_none() {
            lot.price_lot_id.clone()
        } else {
            None
        };
        book.arena.push(OpenLot {
            lot: LotHead {
                id,
                qty: take,
                cost_usd: cost,
                valued_at,
                space: to_space.map(str::to_owned),
                carried_from: Some(CarriedFrom {
                    lot_id: lot.lot.id.clone(),
                    tx_id: m.tx_id.clone(),
                    moved_at: m.posted_at,
                }),
                ..lot.lot.clone()
            },
            remaining: take,
            remaining_cost: cost,
            customer_entered: entered || inherited,
            price_lot_id,
        });
        let new_index = book.arena.len() - 1;
        if let Some(o) = own {
            taken += o;
        }
        if let Some(src) = book.lot_mut(lot_index) {
            if pool.is_none() {
                src.remaining_cost = match (src.remaining_cost, own) {
                    (Some(r), Some(o)) => Some(r - o),
                    _ => None,
                };
            }
            src.remaining -= take;
        }
        remaining -= take;
        // The TypeScript puts the part in `to` before it drops a used-up lot from `from` by its index; on one list (a
        // move within one account, which no caller makes) that order is kept.
        if same {
            book.insert_by_date(&mut from, new_index);
        } else {
            book.insert_by_date(&mut to, new_index);
        }
        if book.remaining(lot_index) == Amount::ZERO && idx < from.len() {
            from.remove(idx);
        }
    }
    if let Some(p) = &pool {
        let still: Vec<usize> = from.clone();
        book.restate_at_average(&still, p, taken);
    }
    if unranked {
        for i in &from {
            if let Some(l) = book.lot_mut(*i) {
                l.remaining_cost = None;
            }
        }
    }
    if remaining > Amount::ZERO {
        let id = ids.next(&lot_id_of(&m.tx_id, &m.asset_id));
        let price = entered_price(prices, &id);
        let cost = price.map(|p| mul(p, remaining));
        book.arena.push(OpenLot {
            lot: LotHead {
                id: id.clone(),
                asset_id: m.asset_id.clone(),
                acquired_at: m.posted_at,
                acquire_tx_id: m.tx_id.clone(),
                source: LotSource::TransferIn,
                reason: "own_account.move".to_owned(),
                qty: remaining,
                cost_usd: cost,
                valued_at: None,
                space: to_space.map(str::to_owned),
                carried_from: None,
            },
            remaining,
            remaining_cost: cost,
            customer_entered: price.is_some(),
            price_lot_id: price.is_some().then_some(id),
        });
        let new_index = book.arena.len() - 1;
        if same {
            book.insert_by_date(&mut from, new_index);
        } else {
            book.insert_by_date(&mut to, new_index);
        }
    }
    book.put_open(from_space, from);
    if !same {
        book.put_open(to_space, to);
    }
}

/// One sale or withdrawal (`dispose`), drawn from the main account's open lots.
#[expect(
    clippy::too_many_arguments,
    reason = "the TypeScript function's own parameters"
)]
fn dispose(
    book: &mut Book,
    m: &Movement,
    proceeds_usd: Option<Amount>,
    moved_out: bool,
    open: &mut Vec<usize>,
    rule: SaleRule,
    residuals: &mut Vec<&'static str>,
    apart: Option<&dyn Fn(LotSource) -> bool>,
) -> EngineSale {
    let method = rule.method;
    let mut matches: Vec<LotMatch> = Vec::new();
    let mut picked: Option<usize> = None;
    if let Some(want) = rule.lot_id.as_deref().filter(|s| !s.is_empty()) {
        picked = open
            .iter()
            .copied()
            .find(|i| book.lot(*i).is_some_and(|l| l.lot.id == want));
        if picked.is_none() {
            residuals.push(TAX_LOT_PICK_UNUSABLE);
        }
    }
    let mut remaining = m.qty;
    let mut proceeds_left = proceeds_usd;
    let mut unknown = false;

    let kept_apart = |i: usize| -> bool {
        match (apart, book.lot(i)) {
            (Some(f), Some(l)) => f(l.lot.source),
            _ => false,
        }
    };
    let pools: Vec<Vec<usize>> = if apart.is_none() {
        vec![open.clone()]
    } else {
        let first: Vec<usize> = open
            .iter()
            .copied()
            .filter(|i| kept_apart(*i) == moved_out)
            .collect();
        let second: Vec<usize> = open
            .iter()
            .copied()
            .filter(|i| kept_apart(*i) != moved_out)
            .collect();
        vec![first, second]
    };

    for mut pool in pools {
        if remaining == Amount::ZERO {
            break;
        }
        let mut unranked = false;
        let average = (method == EngineMethod::Average).then(|| book.average_pool(&pool));
        let pool_entered = average.as_ref().is_some_and(|p| p.entered);
        let mut drew = false;
        let mut taken_cost: Amount = Amount::ZERO;
        while remaining > Amount::ZERO && !pool.is_empty() {
            drew = true;
            let picked_at = picked.and_then(|p| pool.iter().position(|i| *i == p));
            let idx = match picked_at {
                Some(i) => i,
                None => match book.pick(&pool, method) {
                    Some(i) => i,
                    None => {
                        unknown = true;
                        unranked = true;
                        residuals.push(TAX_COST_BASIS_UNAVAILABLE);
                        0
                    }
                },
            };
            let Some(lot_index) = pool.get(idx).copied() else {
                break;
            };
            let Some(lot) = book.lot(lot_index) else {
                break;
            };
            let take = remaining.min(lot.remaining);
            let cost = if unranked {
                None
            } else if let Some(p) = &average {
                p.cost.map(|c| share(c, p.qty, take))
            } else {
                lot.remaining_cost.map(|c| share(c, lot.remaining, take))
            };
            let proceeds = proceeds_left.map(|p| share(p, remaining, take));
            if cost.is_none() {
                unknown = true;
                residuals.push(TAX_COST_BASIS_UNAVAILABLE);
            }
            let from_customer = cost.is_some() && (lot.customer_entered || pool_entered);
            matches.push(LotMatch {
                lot_id: lot.lot.id.clone(),
                qty: take,
                cost_usd: cost,
                proceeds_usd: proceeds,
                realized_usd: match (cost, proceeds) {
                    (Some(c), Some(p)) => Some(p - c),
                    _ => None,
                },
                customer_entered: from_customer,
            });
            remaining -= take;
            taken_cost += cost.unwrap_or(Amount::ZERO);
            if let (Some(left), Some(p)) = (proceeds_left, proceeds) {
                proceeds_left = Some(left - p);
            }
            let averaging = average.is_some();
            if let Some(l) = book.lot_mut(lot_index) {
                if !averaging {
                    l.remaining_cost = match (l.remaining_cost, cost) {
                        (Some(r), Some(c)) => Some(r - c),
                        _ => None,
                    };
                }
                l.remaining -= take;
            }
            if book.remaining(lot_index) == Amount::ZERO {
                pool.remove(idx);
            }
        }
        if drew && let Some(p) = &average {
            book.restate_at_average(&pool, p, taken_cost);
        }
        if unranked {
            for i in &pool {
                if let Some(l) = book.lot_mut(*i) {
                    l.remaining_cost = None;
                }
            }
        }
    }
    open.retain(|i| book.remaining(*i) != Amount::ZERO);
    if remaining > Amount::ZERO && open.is_empty() {
        residuals.push(TAX_LOT_UNDERFLOW);
    }
    let covered = remaining == Amount::ZERO && !unknown;
    let cost_usd = if covered {
        matches
            .iter()
            .try_fold(Amount::ZERO, |t: Amount, x| x.cost_usd.map(|c| t + c))
    } else {
        None
    };
    EngineSale {
        moved_out,
        rule,
        picked_lot_id: picked.and_then(|p| book.lot(p)).map(|l| l.lot.id.clone()),
        asset_id: m.asset_id.clone(),
        tx_id: m.tx_id.clone(),
        posted_at: m.posted_at,
        qty: m.qty,
        unmatched_qty: remaining,
        proceeds_usd,
        cost_usd,
        realized_usd: match (cost_usd, proceeds_usd) {
            (Some(c), Some(p)) => Some(p - c),
            _ => None,
        },
        matches,
    }
}
