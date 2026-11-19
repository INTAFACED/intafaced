//! The year pack's matcher (`lots.ts`): a missing cost basis is never 0 and never paired; the lots
//! stay open and the reason is named. Realised is null unless every matched part has a basis; unrealised is always null.

use crate::json::Json;
use crate::money::cmp_products;
use crate::tax::{
    Amount, TAX_COST_BASIS_UNAVAILABLE, TAX_LOT_UNDERFLOW, format_amount, locale_compare,
};
use crate::time::Instant;

/// `LotMethod`: the export's methods.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LotMethod {
    Fifo,
    Lifo,
    Hifo,
}

impl LotMethod {
    /// `isLotMethod`.
    pub fn parse(raw: &str) -> Option<LotMethod> {
        match raw {
            "FIFO" => Some(Self::Fifo),
            "LIFO" => Some(Self::Lifo),
            "HIFO" => Some(Self::Hifo),
            _ => None,
        }
    }
}

/// `LotMovement`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LotMovement {
    pub asset_id: String,
    pub acquire: bool,
    pub qty: Amount,
    pub cost_basis: Option<Amount>,
    pub proceeds: Option<Amount>,
    pub posted_at: Instant,
    pub tx_id: String,
    pub reason: String,
}

/// `LotRun`, its lots as the export writes them.
#[derive(Debug, Clone, PartialEq)]
pub struct LotRun {
    pub lots_closed: Vec<Json>,
    pub lots_open: Vec<Json>,
    pub realized: Option<String>,
    pub unrealized: Option<String>,
    pub residuals: Vec<&'static str>,
}

struct Open {
    asset_id: String,
    qty_remaining: Amount,
    acquired_at: Instant,
    acquire_tx_id: String,
    cost_basis: Option<Amount>,
}

fn pick_index(open: &[Open], method: LotMethod) -> Option<usize> {
    if open.is_empty() {
        return None;
    }
    match method {
        LotMethod::Fifo => return Some(0),
        LotMethod::Lifo => return Some(open.len() - 1),
        LotMethod::Hifo => {}
    }
    let mut best = 0;
    for i in 1..open.len() {
        let a = open.get(i)?;
        let b = open.get(best)?;
        let (Some(ac), Some(bc)) = (a.cost_basis, b.cost_basis) else {
            return None;
        };
        if cmp_products(ac, b.qty_remaining, bc, a.qty_remaining).is_gt() {
            best = i;
        }
    }
    Some(best)
}

/// `splitCost`: (taken, left).
fn split(total: Option<Amount>, qty: Amount, take: Amount) -> (Option<Amount>, Option<Amount>) {
    match total {
        None => (None, None),
        Some(t) if take == qty => (Some(t), Some(0)),
        Some(t) => {
            let taken = crate::money::share(t, qty, take);
            (Some(taken), Some(t - taken))
        }
    }
}

fn money(v: Option<Amount>) -> Json {
    v.map_or(Json::Null, |a| Json::str(format_amount(a)))
}

/// `runLots`.
pub fn run_lots(movements: &[LotMovement], method: LotMethod) -> LotRun {
    let mut by_asset: Vec<(&str, Vec<&LotMovement>)> = Vec::new();
    for m in movements.iter().filter(|m| m.qty != 0) {
        match by_asset.iter_mut().find(|(a, _)| *a == m.asset_id) {
            Some((_, list)) => list.push(m),
            None => by_asset.push((&m.asset_id, vec![m])),
        }
    }
    let mut lots_closed = Vec::new();
    let mut lots_open = Vec::new();
    let mut residuals: Vec<&'static str> = Vec::new();
    let mut realized_sum: Option<Amount> = Some(0);
    let mut any_closed = false;

    for (_, mut list) in by_asset {
        list.sort_by(|a, b| {
            a.posted_at
                .cmp(&b.posted_at)
                .then_with(|| locale_compare(&a.tx_id, &b.tx_id))
        });
        let mut open: Vec<Open> = Vec::new();
        for m in list {
            if m.acquire {
                open.push(Open {
                    asset_id: m.asset_id.clone(),
                    qty_remaining: m.qty,
                    acquired_at: m.posted_at,
                    acquire_tx_id: m.tx_id.clone(),
                    cost_basis: m.cost_basis,
                });
                continue;
            }
            let mut remaining = m.qty;
            let mut proceeds_left = m.proceeds;
            while remaining > 0 && !open.is_empty() {
                if open.iter().any(|l| l.cost_basis.is_none()) {
                    residuals.push(TAX_COST_BASIS_UNAVAILABLE);
                    realized_sum = None;
                    break;
                }
                let Some(idx) = pick_index(&open, method) else {
                    residuals.push(TAX_COST_BASIS_UNAVAILABLE);
                    realized_sum = None;
                    break;
                };
                let Some(lot) = open.get_mut(idx) else {
                    break;
                };
                if lot.cost_basis.is_none() {
                    residuals.push(TAX_COST_BASIS_UNAVAILABLE);
                    realized_sum = None;
                    break;
                }
                let take = remaining.min(lot.qty_remaining);
                let (cost_taken, cost_left) = split(lot.cost_basis, lot.qty_remaining, take);
                let (proceeds_taken, proceeds_rest) = split(proceeds_left, remaining, take);
                let realized = match (cost_taken, proceeds_taken) {
                    (Some(c), Some(p)) => Some(p - c),
                    _ => {
                        residuals.push(TAX_COST_BASIS_UNAVAILABLE);
                        realized_sum = None;
                        None
                    }
                };
                lots_closed.push(Json::obj([
                    ("assetId", Json::str(m.asset_id.clone())),
                    ("qty", Json::str(format_amount(take))),
                    ("acquiredAt", Json::str(lot.acquired_at.iso())),
                    ("disposedAt", Json::str(m.posted_at.iso())),
                    ("acquireTxId", Json::str(lot.acquire_tx_id.clone())),
                    ("disposeTxId", Json::str(m.tx_id.clone())),
                    ("costBasis", money(cost_taken)),
                    ("proceeds", money(proceeds_taken)),
                    ("realized", money(realized)),
                ]));
                any_closed = true;
                realized_sum = match (realized_sum, realized) {
                    (Some(s), Some(r)) => Some(s + r),
                    _ => None,
                };
                remaining -= take;
                proceeds_left = proceeds_rest;
                lot.qty_remaining -= take;
                lot.cost_basis = cost_left;
                if lot.qty_remaining == 0 {
                    open.remove(idx);
                }
            }
            if remaining > 0 && open.is_empty() {
                residuals.push(TAX_LOT_UNDERFLOW);
            }
        }
        for lot in open {
            if lot.cost_basis.is_none() {
                residuals.push(TAX_COST_BASIS_UNAVAILABLE);
            }
            lots_open.push(Json::obj([
                ("assetId", Json::str(lot.asset_id)),
                ("qtyRemaining", Json::str(format_amount(lot.qty_remaining))),
                ("acquiredAt", Json::str(lot.acquired_at.iso())),
                ("acquireTxId", Json::str(lot.acquire_tx_id)),
                ("costBasis", money(lot.cost_basis)),
            ]));
        }
    }
    residuals.sort_unstable();
    residuals.dedup();
    LotRun {
        lots_closed,
        lots_open,
        realized: if any_closed {
            realized_sum.map(format_amount)
        } else {
            None
        },
        unrealized: None,
        residuals,
    }
}
