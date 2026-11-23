//! What the `serve` slice adds to the engine: admission after a cold start (`admissionClosed`, `holdHalted` in
//! `engine.ts`), the resting orders the replay hold check reads (`restingHoldSubjects`), the expiry pass the sweep runs
//! (`sweepExpiry`), and the startup publish retry (`startup-publish.ts`).

use service_kit::money::Amount;

use super::{EngineError, MatchingEngine, refused};
use crate::book::types::{CancelReason, CancelledRef, Reject, Side};
use crate::journal::replay::js_sort_cmp;

/// `STARTUP_PUBLISH_ATTEMPTS`: four tries, then stop.
pub const STARTUP_PUBLISH_ATTEMPTS: u32 = 4;
/// `STARTUP_PUBLISH_BACKOFF_MS`: the wait before attempts 2, 3 and 4.
pub const STARTUP_PUBLISH_BACKOFF_MS: [u64; 3] = [200, 400, 800];

/// `isNatsPublishTimeout`: a lost acknowledgement. The TypeScript reads NATS's `TIMEOUT` code; the Rust client reports
/// a read that ran past its bound as the socket's own words.
pub fn is_publish_timeout(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    message.contains("TIMEOUT")
        || lower.contains("timeout")
        || lower.contains("timed out")
        || lower.contains("temporarily unavailable")
        || lower.contains("would block")
}

/// `publishWithStartupRetry`: the same publish (the same message id) again on a timeout, with a bounded backoff; any
/// other failure is not retried.
pub fn publish_with_startup_retry(
    publish: &mut dyn FnMut() -> Result<(), String>,
    sleep: &mut Box<dyn FnMut(u64) + Send>,
) -> Result<(), EngineError> {
    for attempt in 1..=STARTUP_PUBLISH_ATTEMPTS {
        match publish() {
            Ok(()) => return Ok(()),
            Err(e) if !is_publish_timeout(&e) => return Err(EngineError::Publish(e)),
            Err(e) if attempt == STARTUP_PUBLISH_ATTEMPTS => {
                return Err(EngineError::StartupPublish(startup_publish_message(
                    attempt, &e,
                )));
            }
            Err(_) => {
                let at = usize::try_from(attempt - 1).unwrap_or(usize::MAX);
                let wait = STARTUP_PUBLISH_BACKOFF_MS
                    .get(at)
                    .or(STARTUP_PUBLISH_BACKOFF_MS.last())
                    .copied()
                    .unwrap_or(0);
                sleep(wait);
            }
        }
    }
    Err(EngineError::StartupPublish(startup_publish_message(
        STARTUP_PUBLISH_ATTEMPTS,
        "no attempt ran",
    )))
}

/// `StartupPublishError`'s message.
pub fn startup_publish_message(attempts: u32, detail: &str) -> String {
    format!(
        "svc-matching startup NATS publish timed out after {attempts} attempts ({detail}); engine replayed but was not announced. Exiting before listen."
    )
}

/// One resting order the replay hold check reads (`RestingHoldSubject`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestingHoldSubject {
    pub market_id: String,
    pub order_id: String,
    pub account_id: String,
    pub side: Side,
    pub remaining: Amount,
    /// The limit the hold was sized at: the level for a rest, a stop's limit; none for a market stop.
    pub funding_price: Option<Amount>,
    pub sequence: u64,
}

/// One order the expiry pass could not reach (`ExpirySweepResult.misses`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpiryMiss {
    pub market_id: String,
    pub code: &'static str,
    pub reason: String,
}

/// `ExpirySweepResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpirySweep {
    pub accepted: bool,
    pub cancelled: Vec<CancelledRef>,
    pub misses: Vec<ExpiryMiss>,
    pub rejected: Option<Reject>,
}

impl MatchingEngine {
    /// The admission gates, after the kill switch and before the market modes: a closed hold check, then a market the
    /// check held closed.
    pub(super) fn admission_refusal(&self, market_id: &str, order_id: &str) -> Option<Reject> {
        if let Some(reason) = &self.admission_closed {
            return Some(refused(
                "hold_check_unreachable",
                format!(
                    "hold check did not answer ({reason}); market stays closed — order {order_id} not processed"
                ),
            ));
        }
        self.hold_halted.get(market_id).map(|reason| {
            refused(
                "hold_unconfirmed",
                format!(
                    "market {market_id} stays halted ({reason}) — order {order_id} not processed"
                ),
            )
        })
    }

    /// `admissionOpen`.
    pub fn admission_open(&self) -> bool {
        self.admission_closed.is_none()
    }

    /// `admissionReason`: why admission is closed, none while the book may trade.
    pub fn admission_reason(&self) -> Option<&str> {
        self.admission_closed.as_deref()
    }

    /// `closeAdmission`: fail closed for the whole book. Not journalled; the next boot asks again.
    pub fn close_admission(&mut self, reason: &str) {
        self.admission_closed = Some(reason.to_owned());
    }

    /// `holdHalt`: one market stays halted because a resting hold could not be pulled. Not an operator halt.
    pub fn hold_halt(&mut self, market_id: &str, reason: &str) {
        self.hold_halted
            .insert(market_id.to_owned(), reason.to_owned());
    }

    /// `holdHaltedMarkets`, sorted.
    pub fn hold_halted_markets(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.hold_halted.keys().cloned().collect();
        ids.sort_by(|a, b| js_sort_cmp(a, b));
        ids
    }

    /// `holdHaltReason`.
    pub fn hold_halt_reason(&self, market_id: &str) -> Option<&str> {
        self.hold_halted.get(market_id).map(String::as_str)
    }

    /// `finishStartupAnnounce`: live publishes after this take no startup backoff.
    pub fn finish_startup_announce(&mut self) {
        self.announcing = false;
    }

    /// `isVenueHalted`: the venue halt, read live.
    pub fn is_venue_halted(&self) -> bool {
        self.modes.venue_halted
    }

    /// `restingHoldSubjects`: every resting order and stop, by market and then sequence. A stop carries its limit as
    /// the funding price, not its trigger.
    pub fn resting_hold_subjects(&self) -> Vec<RestingHoldSubject> {
        let mut subjects: Vec<RestingHoldSubject> = self
            .books
            .values()
            .flat_map(|book| {
                let market = book.market_id().to_owned();
                book.live_orders()
                    .into_iter()
                    .map(move |o| RestingHoldSubject {
                        market_id: market.clone(),
                        funding_price: o.funding_price,
                        order_id: o.order_id,
                        account_id: o.account_id,
                        side: o.side,
                        remaining: o.remaining,
                        sequence: o.sequence,
                    })
            })
            .collect();
        subjects.sort_by(|a, b| {
            js_sort_cmp(&a.market_id, &b.market_id).then(a.sequence.cmp(&b.sequence))
        });
        subjects
    }

    /// `sweepExpiry`: cancel every GTD or GTT rest whose expiry has come, market by market, each through the ordinary
    /// cancel with reason `expired`. Without the engine clock it refuses.
    pub fn sweep_expiry(&mut self) -> Result<ExpirySweep, EngineError> {
        let Some(now) = self.expiry_now() else {
            return Ok(ExpirySweep {
                accepted: false,
                cancelled: Vec::new(),
                misses: Vec::new(),
                rejected: Some(refused(
                    "engine_clock_missing",
                    "GTD/GTT expires on the engine clock; refuse when that clock is missing"
                        .to_owned(),
                )),
            });
        };
        let mut markets: Vec<String> = self.books.keys().cloned().collect();
        markets.sort_by(|a, b| js_sort_cmp(a, b));
        let mut cancelled = Vec::new();
        for market_id in markets {
            let due = self
                .books
                .get(&market_id)
                .map(|b| b.due_expiry(now))
                .unwrap_or_default();
            for order_id in due {
                let result = self.cancel(&market_id, &order_id, CancelReason::Expired)?;
                if let Some(c) = result.cancellation {
                    cancelled.push(c);
                }
            }
        }
        Ok(ExpirySweep {
            accepted: true,
            cancelled,
            misses: Vec::new(),
            rejected: None,
        })
    }
}

/// `EXPIRY_SWEEP_EVERY_MS`: how often the sweep runs, so a GTD or GTT rest leaves at its expiry in a quiet market too.
pub const EXPIRY_SWEEP_EVERY_MS: u64 = 1000;

impl MatchingEngine {
    /// One pass of the expiry sweep (`startExpirySweep`'s `tick`): a disabled engine (the kill switch, or the shutdown
    /// drain) is not swept, so nothing is journalled while the journal closes.
    pub fn expiry_tick(&mut self) -> Result<Option<ExpirySweep>, EngineError> {
        if !self.enabled {
            return Ok(None);
        }
        self.sweep_expiry().map(Some)
    }
}
