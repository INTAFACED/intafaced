//! The replay hold check (`replay-hold.ts`), its ledger reads (`replay-ledger-client.ts`) and the boot that runs it
//! (`open-after-replay.ts`).
//!
//! After the journal is in the book and before any new order can match, every resting order is read against its ledger
//! hold: the purposed `order:<id>` balance, or for a futures order its margin pot `futures-order:<id>`, confirmed by
//! being positive. svc-matching has no database and does not post. A missing, short or unreadable hold is pulled
//! through the normal cancel (`hold_unconfirmed`) so svc-trade can release what remains. If that cancel cannot land, the
//! market stays halted. If the ledger cannot be asked at all, the book does not open.

use std::collections::HashMap;
use std::sync::Arc;

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, Rounding, format_amount, mul_rounded, parse_amount};
use service_kit::s2s::CallSigner;

use crate::book::types::{CancelReason, Side};
use crate::engine::admission::RestingHoldSubject;
use crate::engine::{EngineError, MatchingEngine, Recovered};

/// `HoldVerdict`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoldVerdict {
    Missing,
    Short,
    Unreadable,
}

impl HoldVerdict {
    pub fn as_str(self) -> &'static str {
        match self {
            HoldVerdict::Missing => "missing",
            HoldVerdict::Short => "short",
            HoldVerdict::Unreadable => "unreadable",
        }
    }
}

/// `matching.hold_check_unreachable`: the ledger did not answer.
pub const HOLD_CHECK_UNREACHABLE: &str = "matching.hold_check_unreachable";
/// `matching.hold_check_unwired`: there is no `LEDGER_URL` to ask.
pub const HOLD_CHECK_UNWIRED: &str = "matching.hold_check_unwired";

/// What one hold read found: the order's `order:<id>` hold, a futures order's margin, or no hold balance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Hold {
    Order(String),
    FuturesMargin(String),
}

/// Why a read gave no hold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HoldReadError {
    /// `HoldCheckUnreachable`: the hold service itself could not be asked. Admission closes.
    Unreachable { code: &'static str, message: String },
    /// This one order's hold could not be read: it is unconfirmed.
    Order(String),
}

/// `ReplayHoldLookup`. Read-only.
pub trait ReplayHoldLookup {
    fn read(&mut self, order: &RestingHoldSubject) -> Result<Option<Hold>, HoldReadError>;
}

/// `PulledRestingOrder`: its reason is always `hold_unconfirmed`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pulled {
    pub order_id: String,
    pub market_id: String,
    pub verdict: HoldVerdict,
}

/// `HaltedRestingMarket`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Halted {
    pub market_id: String,
    pub order_id: String,
    pub verdict: HoldVerdict,
    pub reason: String,
}

/// `ReplayHoldGate`: `reason` is set when the book stayed closed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HoldGate {
    pub open: bool,
    pub reason: Option<&'static str>,
    pub checked: usize,
    pub pulled: Vec<Pulled>,
    pub halted: Vec<Halted>,
}

impl HoldGate {
    /// As the boot log writes it.
    pub fn to_json(&self) -> Json {
        let mut fields = vec![("open".to_owned(), Json::Bool(self.open))];
        if let Some(r) = self.reason {
            fields.push(("reason".to_owned(), Json::str(r)));
        }
        fields.push((
            "checked".to_owned(),
            Json::int(i64::try_from(self.checked).unwrap_or(i64::MAX)),
        ));
        fields.push((
            "pulled".to_owned(),
            Json::Array(
                self.pulled
                    .iter()
                    .map(|p| {
                        Json::obj([
                            ("orderId", Json::str(p.order_id.clone())),
                            ("marketId", Json::str(p.market_id.clone())),
                            ("verdict", Json::str(p.verdict.as_str())),
                            ("reason", Json::str("hold_unconfirmed")),
                        ])
                    })
                    .collect(),
            ),
        ));
        fields.push((
            "halted".to_owned(),
            Json::Array(
                self.halted
                    .iter()
                    .map(|h| {
                        Json::obj([
                            ("marketId", Json::str(h.market_id.clone())),
                            ("orderId", Json::str(h.order_id.clone())),
                            ("verdict", Json::str(h.verdict.as_str())),
                            ("reason", Json::str(h.reason.clone())),
                        ])
                    })
                    .collect(),
            ),
        ));
        Json::Object(fields)
    }
}

/// `requiredHoldAmount`: quote for a buy (`ceil(price × remaining)`, as svc-trade's `holdFor`), base quantity for a
/// sell. None when a buy has no limit to size the hold against: that order is not confirmed.
pub fn required_hold_amount(order: &RestingHoldSubject) -> Option<Amount> {
    match order.side {
        Side::Sell => Some(order.remaining),
        Side::Buy => order
            .funding_price
            .map(|p| mul_rounded(p, order.remaining, Rounding::Ceil)),
    }
}

/// `classifyHold`: none is missing; text that does not read is unreadable; zero or less is missing; under `required` is
/// short.
fn classify(hold: Option<&str>, required: Amount) -> Option<HoldVerdict> {
    let Some(text) = hold else {
        return Some(HoldVerdict::Missing);
    };
    let Ok(held) = parse_amount(text) else {
        return Some(HoldVerdict::Unreadable);
    };
    if held <= 0 {
        Some(HoldVerdict::Missing)
    } else if held < required {
        Some(HoldVerdict::Short)
    } else {
        None
    }
}

/// `enforceReplayHolds`: confirm every resting order, then pull or halt. Matches nothing. An unreachable ledger fails
/// closed: nothing already known bad is undone, and admission closes so a still-resting order cannot be matched.
pub fn enforce_replay_holds(
    engine: &mut MatchingEngine,
    lookup: &mut dyn ReplayHoldLookup,
) -> Result<HoldGate, EngineError> {
    let subjects = engine.resting_hold_subjects();
    let mut gate = HoldGate {
        open: true,
        reason: None,
        checked: subjects.len(),
        pulled: Vec::new(),
        halted: Vec::new(),
    };
    for order in &subjects {
        let verdict = match lookup.read(order) {
            // Margin needs no amount to compare with: any positive balance confirms it.
            Ok(Some(Hold::FuturesMargin(m))) => classify(Some(&m), 0),
            Ok(hold) => {
                let text = match &hold {
                    Some(Hold::Order(t)) => Some(t.as_str()),
                    _ => None,
                };
                match required_hold_amount(order) {
                    None => Some(HoldVerdict::Unreadable),
                    Some(required) => classify(text, required),
                }
            }
            Err(HoldReadError::Unreachable { code, .. }) => {
                engine.close_admission(code);
                gate.open = false;
                gate.reason = Some(code);
                return Ok(gate);
            }
            Err(HoldReadError::Order(_)) => Some(HoldVerdict::Unreadable),
        };
        let Some(verdict) = verdict else { continue };
        let cancel = engine.cancel(
            &order.market_id,
            &order.order_id,
            CancelReason::HoldUnconfirmed,
        )?;
        if cancel.cancelled
            && cancel
                .cancellation
                .as_ref()
                .is_some_and(|c| c.reason == CancelReason::HoldUnconfirmed)
        {
            gate.pulled.push(Pulled {
                order_id: order.order_id.clone(),
                market_id: order.market_id.clone(),
                verdict,
            });
            continue;
        }
        let reason = format!("matching.hold_{}", verdict.as_str());
        engine.hold_halt(&order.market_id, &reason);
        gate.halted.push(Halted {
            market_id: order.market_id.clone(),
            order_id: order.order_id.clone(),
            verdict,
            reason,
        });
    }
    Ok(gate)
}

/// `unwiredReplayHoldLookup`: with no `LEDGER_URL` every read is unreachable, so a book that replayed resting orders
/// does not open.
pub struct UnwiredHolds;

impl ReplayHoldLookup for UnwiredHolds {
    fn read(&mut self, _: &RestingHoldSubject) -> Result<Option<Hold>, HoldReadError> {
        Err(HoldReadError::Unreachable {
            code: HOLD_CHECK_UNWIRED,
            message: "LEDGER_URL is unset — svc-matching cannot read order holds and will not open a book that replayed resting orders".to_owned(),
        })
    }
}

/// One balance row as the ledger's `balances` answers it (`balancesWire`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BalanceRow {
    pub kind: String,
    /// `accountPurpose`: trimmed, blank when none.
    pub purpose: String,
    pub amount: Amount,
}

/// `ReplayHoldLedger`: the one read the check makes.
pub trait ReplayHoldLedger {
    fn balances(&self, owner_type: &str, owner_id: &str) -> Result<Vec<BalanceRow>, String>;
}

/// `holdOwner`: the house market maker, or a user whose id is a lowercase canonical UUID.
pub fn hold_owner(account_id: &str) -> Option<(&'static str, String)> {
    if account_id == "house:market-maker" {
        return Some(("house", "market-maker".to_owned()));
    }
    is_uuid(account_id).then(|| ("user", account_id.to_owned()))
}

/// `UUID_OWNER_ID_PATTERN`.
fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, &c)| match i {
            8 | 13 | 18 | 23 => c == b'-',
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(&c),
        })
}

/// `createReplayHoldLookup`: each owner's balances read once per boot through the ledger; a failed read is the hold
/// service not answering, never one bad order, so it never cancels the book.
pub struct LedgerHolds<L: ReplayHoldLedger> {
    ledger: L,
    seen: HashMap<(String, String), Vec<BalanceRow>>,
}

impl<L: ReplayHoldLedger> LedgerHolds<L> {
    pub fn new(ledger: L) -> LedgerHolds<L> {
        LedgerHolds {
            ledger,
            seen: HashMap::new(),
        }
    }
}

impl<L: ReplayHoldLedger> ReplayHoldLookup for LedgerHolds<L> {
    fn read(&mut self, order: &RestingHoldSubject) -> Result<Option<Hold>, HoldReadError> {
        let Some((owner_type, owner_id)) = hold_owner(&order.account_id) else {
            return Err(HoldReadError::Order(format!(
                "resting account {} is not a ledger owner; hold unreadable",
                order.account_id
            )));
        };
        let key = (owner_type.to_owned(), owner_id.clone());
        if !self.seen.contains_key(&key) {
            let rows = self
                .ledger
                .balances(owner_type, &owner_id)
                .map_err(|message| HoldReadError::Unreachable {
                    code: HOLD_CHECK_UNREACHABLE,
                    message,
                })?;
            self.seen.insert(key.clone(), rows);
        }
        let rows = self.seen.get(&key).map(Vec::as_slice).unwrap_or_default();
        let held = |purpose: &str| -> Vec<&BalanceRow> {
            rows.iter()
                .filter(|r| r.kind == "hold" && r.purpose == purpose)
                .collect()
        };
        let holds = held(&format!("order:{}", order.order_id));
        let margin = held(&format!("futures-order:{}", order.order_id));
        if holds.len() + margin.len() > 1 {
            return Err(HoldReadError::Order(format!(
                "multiple ledger holds for order {}",
                order.order_id
            )));
        }
        if let Some(m) = margin.first() {
            return Ok(Some(Hold::FuturesMargin(format_amount(m.amount))));
        }
        Ok(holds.first().map(|h| Hold::Order(format_amount(h.amount))))
    }
}

/// `createReplayLedgerClient`'s `balances`: `POST /trpc/balances`, signed as svc-matching for svc-ledger, 4 s an
/// attempt, one retry after 200 ms on a network failure or a 502, 503 or 504.
pub struct LedgerHttp {
    pub base_url: String,
    pub signer: CallSigner,
    pub fetch: Arc<dyn Fetch>,
}

const LEDGER_TIMEOUT_MS: u64 = 4_000;
const LEDGER_RETRIES: u32 = 1;
const LEDGER_RETRY_BASE_MS: u64 = 200;
const BALANCES_PATH: &str = "/trpc/balances";

impl ReplayHoldLedger for LedgerHttp {
    fn balances(&self, owner_type: &str, owner_id: &str) -> Result<Vec<BalanceRow>, String> {
        let payload = Json::obj([
            ("ownerType", Json::str(owner_type)),
            ("ownerId", Json::str(owner_id)),
        ])
        .compact();
        let url = format!("{}{BALANCES_PATH}", self.base_url.trim_end_matches('/'));
        let mut attempt = 0;
        loop {
            let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
            headers.extend(self.signer.sign(
                &payload,
                "POST",
                BALANCES_PATH,
                "application/json",
            )?);
            let answer = self.fetch.fetch(&HttpRequest {
                method: "POST".to_owned(),
                url: url.clone(),
                headers,
                body: Some(payload.clone()),
                timeout_ms: Some(LEDGER_TIMEOUT_MS),
                refuse_redirect: false,
            });
            let failure = match answer {
                Ok(res) if res.ok() => return balance_rows(&res.body),
                Ok(res) if !matches!(res.status, 502..=504) => {
                    return Err(format!(
                        "svc-ledger {BALANCES_PATH} answered {}: {}",
                        res.status, res.body
                    ));
                }
                Ok(res) => format!("svc-ledger {BALANCES_PATH} answered {}", res.status),
                Err(e) => e.message,
            };
            if attempt >= LEDGER_RETRIES {
                return Err(failure);
            }
            std::thread::sleep(std::time::Duration::from_millis(
                LEDGER_RETRY_BASE_MS << attempt,
            ));
            attempt += 1;
        }
    }
}

/// `balancesWire.parse`: an array of `{ accountId, assetId, kind, purpose?, amount }`.
pub fn balance_rows(body: &str) -> Result<Vec<BalanceRow>, String> {
    let parsed = json::parse(body).map_err(|e| format!("svc-ledger balances: {}", e.message))?;
    let Json::Array(rows) = parsed else {
        return Err("svc-ledger balances: not a list".to_owned());
    };
    rows.iter()
        .map(|row| {
            let text = |k: &str| match row.get(k) {
                Some(Json::String(s)) => Ok(s.clone()),
                _ => Err(format!("svc-ledger balances: {k} is not text")),
            };
            text("accountId")?;
            text("assetId")?;
            let purpose = match row.get("purpose") {
                None => String::new(),
                Some(Json::String(s)) => service_kit::money::js_trim(s).to_owned(),
                Some(_) => return Err("svc-ledger balances: purpose is not text".to_owned()),
            };
            Ok(BalanceRow {
                kind: text("kind")?,
                purpose,
                amount: parse_amount(&text("amount")?)?,
            })
        })
        .collect()
}

/// `OpenAfterReplayResult`: a startup publish that kept timing out exits 1 without listening.
#[derive(Debug)]
pub enum Boot {
    Open {
        recovered: Recovered,
        gate: HoldGate,
    },
    Exit {
        message: String,
    },
}

/// `openAfterReplay`: replay, confirm holds, end the startup announce, then listen. Only a startup publish that kept
/// timing out stops it before `listen`; any other failure is returned as it is.
pub fn open_after_replay(
    engine: &mut MatchingEngine,
    holds: &mut dyn ReplayHoldLookup,
    listen: &mut dyn FnMut() -> Result<(), String>,
) -> Result<Boot, String> {
    let gated = engine
        .recover()
        .and_then(|recovered| enforce_replay_holds(engine, holds).map(|gate| (recovered, gate)));
    let (recovered, gate) = match gated {
        Ok(v) => v,
        Err(EngineError::StartupPublish(message)) => return Ok(Boot::Exit { message }),
        Err(e) => return Err(e.to_string()),
    };
    engine.finish_startup_announce();
    listen()?;
    Ok(Boot::Open { recovered, gate })
}
