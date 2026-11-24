//! The `liquidity` slice's engine calls, each a TypeScript module the engine installs on import: the mass quote
//! (`mass-quote.ts`), market-maker protection (`mmp.ts`), the auction's uncross (`auction-uncross.ts`) and the liquidity
//! mill (`liquidity.ts`). The order parts themselves (icebergs, pegs, all-or-none, auction intents) are the book's
//! (`book::rules`); the in-flight marks (`ifm.ts`, `ifm-crash.ts`) are the engine's own steps.
//!
//! Every owner value here is unset, and unset is the live product: the uncrossing rules, the MMP magnitudes and the
//! rebate program refuse rather than invent a price, a zero or a rebate.

use service_kit::json::Json;
use service_kit::money::Amount;

use super::{EngineError, MatchingEngine};
use crate::book::types::{EngineOrder, Fill, Reject, SubmitResult};

const UNCROSSING_UNSET: &str = "uncrossing rules are unset; the engine does not invent an uncross";

/// `uncrossingUnsetRefuse`.
pub fn uncrossing_unset() -> Reject {
    Reject::new("uncrossing_unset", UNCROSSING_UNSET)
}

/// `uncrossSubmitRefuse`: a submit on a market in its auction state.
pub fn uncross_submit_refuse(order_id: &str) -> Reject {
    Reject::new(
        "uncrossing_unset",
        format!("{UNCROSSING_UNSET} — order {order_id} not processed"),
    )
}

/// `AuctionUncrossResult`: always refused while the rules are unset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UncrossResult {
    pub accepted: bool,
    pub market_id: String,
    pub fills: Vec<Fill>,
    pub rejected: Option<Reject>,
}

/// `MmpResult`: never a magnitude, so never a zero passed off as a live maximum.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MmpResult {
    pub accepted: bool,
    pub market_id: String,
    pub rejected: Option<Reject>,
}

/// `applyMmp`: the magnitudes are unpublished.
pub fn apply_mmp(market_id: &str) -> MmpResult {
    MmpResult {
        accepted: false,
        market_id: market_id.to_owned(),
        rejected: Some(super::mmp_unpublished()),
    }
}

/// `mmpMagnitudesUnset`: no setting on this process publishes them.
pub fn mmp_magnitudes_unset() -> bool {
    true
}

/// `uncrossingRulesUnset`.
pub fn uncrossing_rules_unset() -> bool {
    true
}

/// `rebateProgramUnset`.
pub fn rebate_program_unset() -> bool {
    true
}

// ── the mill ────────────────────────────────────────────────────────────

/// `SourcedDepth` and its refusal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourcedDepth {
    pub accepted: bool,
    pub market_id: String,
    pub source: Option<String>,
    pub native: bool,
    pub bids: Vec<(Amount, Amount)>,
    pub asks: Vec<(Amount, Amount)>,
    pub rejected: Option<Reject>,
}

/// Where depth comes from: this book to a window, or an outside venue that must be named.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DepthSource<'a> {
    /// The window is required: the TypeScript's missing limit refuses (`publishedEngineL2Limit`).
    Native {
        limit: usize,
    },
    External {
        source: Option<&'a str>,
    },
}

/// `readRequired`: trimmed, and blank is missing.
fn read_required(raw: Option<&str>) -> Option<String> {
    let t = service_kit::schema::js_trim(raw?);
    (!t.is_empty()).then(|| t.to_owned())
}

/// `RebateResult`: never paid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RebateResult {
    pub accepted: bool,
    pub paid: Option<Amount>,
    pub rejected: Reject,
}

/// `payRebate`: a wash (one account on both sides) is refused as wash; anything else as the unset program.
pub fn pay_rebate(maker_account_id: Option<&str>, taker_account_id: Option<&str>) -> RebateResult {
    let maker = read_required(maker_account_id);
    let taker = read_required(taker_account_id);
    let rejected = if maker.is_some() && maker == taker {
        Reject::new(
            "rebate_wash",
            "incentives must not reward wash; same-account maker/taker is not paid",
        )
    } else {
        Reject::new(
            "rebate_program_unset",
            "rebate program is unset; the engine does not invent a rebate",
        )
    };
    RebateResult {
        accepted: false,
        paid: None,
        rejected,
    }
}

/// `QualityTelemetry`: samples may exist; they never prove the market liquid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QualityTelemetry {
    pub market_id: String,
    pub samples: u64,
    pub proven_liquid: bool,
}

/// `qualityTelemetry`.
pub fn quality_telemetry(market_id: &str, samples: u64) -> QualityTelemetry {
    QualityTelemetry {
        market_id: market_id.to_owned(),
        samples,
        proven_liquid: false,
    }
}

// ── the mass quote ──────────────────────────────────────────────────────

/// `bid` or `ask`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuoteSide {
    Bid,
    Ask,
}

impl QuoteSide {
    pub fn as_str(self) -> &'static str {
        match self {
            QuoteSide::Bid => "bid",
            QuoteSide::Ask => "ask",
        }
    }
}

/// `MassQuoteCommand`: one market, the sides given, and the admission proof both sides carry.
#[derive(Debug, Clone)]
pub struct MassQuote {
    pub set_id: String,
    pub market_id: String,
    pub account_id: String,
    pub one_sided: bool,
    pub bid: Option<EngineOrder>,
    pub ask: Option<EngineOrder>,
    pub lifecycle_proof: Option<Json>,
}

/// `QuoteSideResult`: `APPLIED` when the side was accepted, else `REFUSED` with why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuoteSideResult {
    pub side: QuoteSide,
    pub applied: bool,
    pub order_id: Option<String>,
    pub rejected: Option<Reject>,
}

impl QuoteSideResult {
    fn applied(side: QuoteSide, order_id: &str) -> Self {
        QuoteSideResult {
            side,
            applied: true,
            order_id: Some(order_id.to_owned()),
            rejected: None,
        }
    }

    fn refused(side: QuoteSide, reason: Reject, order_id: Option<&str>) -> Self {
        QuoteSideResult {
            side,
            applied: false,
            order_id: order_id.map(str::to_owned),
            rejected: Some(reason),
        }
    }

    /// `presentMassQuote`'s row.
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("side", Json::str(self.side.as_str())),
            (
                "status",
                Json::str(if self.applied { "APPLIED" } else { "REFUSED" }),
            ),
            (
                "orderId",
                self.order_id.clone().map_or(Json::Null, Json::String),
            ),
            (
                "rejected",
                self.rejected.as_ref().map_or(Json::Null, Reject::to_json),
            ),
        ])
    }
}

/// `MassQuoteResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MassQuoteResult {
    pub set_id: Option<String>,
    pub one_sided: bool,
    pub results: Vec<QuoteSideResult>,
    pub rejected: Option<Reject>,
}

impl MassQuoteResult {
    /// `presentMassQuote`.
    pub fn to_json(&self) -> Json {
        Json::obj([
            (
                "setId",
                self.set_id.clone().map_or(Json::Null, Json::String),
            ),
            ("oneSided", Json::Bool(self.one_sided)),
            (
                "results",
                Json::Array(self.results.iter().map(QuoteSideResult::to_json).collect()),
            ),
            (
                "rejected",
                self.rejected.as_ref().map_or(Json::Null, Reject::to_json),
            ),
        ])
    }
}

fn set_missing() -> Reject {
    Reject::new("quote_set_missing", "quote setId is required")
}

fn pair_incomplete() -> Reject {
    Reject::new(
        "quote_pair_incomplete",
        "required two-sided quote set is missing a side; neither rests",
    )
}

/// `pairRejectedRefuse`.
pub fn pair_rejected() -> Reject {
    Reject::new(
        "quote_pair_rejected",
        "quote pair refused; applied side was unwound so the book is not one-sided",
    )
}

fn printed(result: &SubmitResult) -> bool {
    !result.fills.is_empty() || result.triggered.iter().any(|t| !t.fills.is_empty())
}

impl MatchingEngine {
    fn is_live_in(&self, market_id: &str, order_id: &str) -> bool {
        self.resting_orders(Some(market_id))
            .iter()
            .any(|o| o.order_id == order_id)
    }

    /// `acceptedTerminal`: the book accepted the order and it is no longer live.
    fn accepted_terminal(&self, market_id: &str, order_id: &str) -> bool {
        self.books
            .get(market_id)
            .is_some_and(|b| b.has_accepted(order_id) && !self.is_live_in(market_id, order_id))
    }

    /// `submitSide`. A submit that failed after its input was durable is applied when the book shows it took the
    /// order; otherwise the failure goes back to the caller, whose outcome stays unknown.
    fn submit_side(
        &mut self,
        market_id: &str,
        side: QuoteSide,
        order: &EngineOrder,
        proof: Option<&Json>,
        filled: &mut Vec<String>,
    ) -> Result<QuoteSideResult, EngineError> {
        let id = order.order_id.as_str();
        match self.submit(market_id, order, proof) {
            Ok(result) => {
                if printed(&result) {
                    filled.push(id.to_owned());
                }
                Ok(match (result.accepted, result.rejected) {
                    (true, _) => QuoteSideResult::applied(side, id),
                    (false, Some(r)) => QuoteSideResult::refused(side, r, Some(id)),
                    (false, None) => QuoteSideResult::refused(side, pair_rejected(), Some(id)),
                })
            }
            Err(e) => {
                if self.accepted_terminal(market_id, id) {
                    filled.push(id.to_owned());
                    return Ok(QuoteSideResult::applied(side, id));
                }
                if self.is_live_in(market_id, id) {
                    return Ok(QuoteSideResult::applied(side, id));
                }
                Err(e)
            }
        }
    }

    /// `unwindSide`: cancel an applied side. A cancel releases a remainder; it never reverses a fill already printed,
    /// so a side that traded stays applied.
    fn unwind_side(
        &mut self,
        market_id: &str,
        current: QuoteSideResult,
        filled: &[String],
    ) -> QuoteSideResult {
        let Some(id) = current.order_id.clone().filter(|_| current.applied) else {
            return current;
        };
        // A refused or failed cancel is judged by what the book still holds, as the TypeScript judges it.
        let _ = self.cancel(market_id, &id, crate::book::types::CancelReason::Requested);
        if filled.contains(&id) || self.is_live_in(market_id, &id) {
            return current;
        }
        QuoteSideResult::refused(current.side, pair_rejected(), Some(&id))
    }

    /// `massQuote`: a required two-sided set rests both sides or neither; `one_sided` is explicit. One side refused
    /// unwinds the other.
    pub fn mass_quote(&mut self, cmd: &MassQuote) -> Result<MassQuoteResult, EngineError> {
        let one_sided = cmd.one_sided;
        let bid_id = cmd.bid.as_ref().map(|o| o.order_id.as_str());
        let ask_id = cmd.ask.as_ref().map(|o| o.order_id.as_str());
        let both_refused = |reason: Reject| {
            vec![
                QuoteSideResult::refused(QuoteSide::Bid, reason.clone(), bid_id),
                QuoteSideResult::refused(QuoteSide::Ask, reason, ask_id),
            ]
        };
        let set_id = service_kit::schema::js_trim(&cmd.set_id);
        if set_id.is_empty() {
            return Ok(MassQuoteResult {
                set_id: None,
                one_sided,
                results: both_refused(set_missing()),
                rejected: Some(set_missing()),
            });
        }
        let set_id = set_id.to_owned();
        if !one_sided && (cmd.bid.is_none() || cmd.ask.is_none()) {
            return Ok(MassQuoteResult {
                set_id: Some(set_id),
                one_sided,
                results: both_refused(pair_incomplete()),
                rejected: Some(pair_incomplete()),
            });
        }
        let market = cmd.market_id.as_str();
        let proof = cmd.lifecycle_proof.as_ref();
        let mut filled: Vec<String> = Vec::new();
        let mut results = Vec::new();
        if let Some(bid) = &cmd.bid {
            results.push(self.submit_side(market, QuoteSide::Bid, bid, proof, &mut filled)?);
        }
        if let Some(ask) = &cmd.ask {
            results.push(self.submit_side(market, QuoteSide::Ask, ask, proof, &mut filled)?);
        }
        if !one_sided && results.iter().any(|r| !r.applied) {
            let results: Vec<QuoteSideResult> = results
                .into_iter()
                .map(|r| self.unwind_side(market, r, &filled))
                .collect();
            let still_resting = results.iter().any(|r| {
                r.applied
                    && r.order_id
                        .as_deref()
                        .is_some_and(|id| self.is_live_in(market, id))
            });
            return Ok(MassQuoteResult {
                set_id: Some(set_id),
                one_sided,
                results,
                rejected: (!still_resting).then(pair_rejected),
            });
        }
        Ok(MassQuoteResult {
            set_id: Some(set_id),
            one_sided,
            results,
            rejected: None,
        })
    }

    // ── the auction ─────────────────────────────────────────────────────

    fn refused_uncross(market_id: &str) -> UncrossResult {
        UncrossResult {
            accepted: false,
            market_id: market_id.to_owned(),
            fills: Vec::new(),
            rejected: Some(uncrossing_unset()),
        }
    }

    /// `uncross`: refused while the rules are unset; nothing is journalled and the book does not move.
    pub fn uncross(&self, market_id: &str) -> UncrossResult {
        Self::refused_uncross(market_id)
    }

    /// `enterAuction`: refused while the rules are unset, so no market enters its auction state.
    pub fn enter_auction(&self, market_id: &str) -> UncrossResult {
        Self::refused_uncross(market_id)
    }

    /// `leaveAuction`.
    pub fn leave_auction(&self, market_id: &str) -> UncrossResult {
        Self::refused_uncross(market_id)
    }

    /// Put a market in the auction state directly, as the TypeScript test does through its symbol: only a test can,
    /// since entering refuses.
    pub fn mark_auction_state(&mut self, market_id: &str) {
        self.auction.insert(market_id.to_owned());
    }

    /// `applyMmp`.
    pub fn apply_mmp(&self, market_id: &str) -> MmpResult {
        apply_mmp(market_id)
    }

    // ── the mill ────────────────────────────────────────────────────────

    /// `sourcedDepth`: this book's depth, labelled `matching`, or an outside venue's, which must name its source.
    pub fn sourced_depth(&self, market_id: &str, from: DepthSource<'_>) -> SourcedDepth {
        match from {
            DepthSource::External { source } => match read_required(source) {
                None => SourcedDepth {
                    accepted: false,
                    market_id: market_id.to_owned(),
                    source: None,
                    native: false,
                    bids: Vec::new(),
                    asks: Vec::new(),
                    rejected: Some(Reject::new(
                        "unsourced_depth",
                        "external depth requires a visible source; the engine does not invent a venue",
                    )),
                },
                Some(source) => SourcedDepth {
                    accepted: true,
                    market_id: market_id.to_owned(),
                    source: Some(source),
                    native: false,
                    bids: Vec::new(),
                    asks: Vec::new(),
                    rejected: None,
                },
            },
            DepthSource::Native { limit } => {
                // `l2Depth`: the existing book's depth, or empty.
                let (bids, asks) = self
                    .books
                    .get(market_id)
                    .map(|b| {
                        let (bids, asks, _) = b.depth(limit);
                        (bids, asks)
                    })
                    .unwrap_or_default();
                SourcedDepth {
                    accepted: true,
                    market_id: market_id.to_owned(),
                    source: Some("matching".to_owned()),
                    native: true,
                    bids,
                    asks,
                    rejected: None,
                }
            }
        }
    }

    /// `payRebate`.
    pub fn pay_rebate(&self, maker: Option<&str>, taker: Option<&str>) -> RebateResult {
        pay_rebate(maker, taker)
    }

    /// `qualityTelemetry`.
    pub fn quality_telemetry(&self, market_id: &str, samples: u64) -> QualityTelemetry {
        quality_telemetry(market_id, samples)
    }
}
