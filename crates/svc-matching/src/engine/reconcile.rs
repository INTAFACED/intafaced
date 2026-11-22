//! Engine against counterpart (`reconcile.ts`): what the engine is working compared with what the caller believes,
//! each disagreement named with both sides' state. It classifies and refuses: it writes nothing, cancels nothing and
//! moves no value. Only an unfunded intent row the engine never accepted is safe to repair without a person.

use service_kit::json::Json;
use service_kit::money::{format_amount, parse_amount};

use super::EngineLiveOrder;

/// What the caller believes about one order (`CounterpartOrder`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CounterpartOrder {
    pub order_id: String,
    pub market_id: String,
    /// `pending`, `open` or `terminal`.
    pub state: String,
    /// A decimal string, as the caller sent it.
    pub remaining: String,
    pub funded: bool,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub order_id: String,
    pub case: &'static str,
    pub verdict: &'static str,
    pub engine: String,
    pub counterpart: String,
    pub reason: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    pub checked: usize,
    pub agreed: usize,
    pub findings: Vec<Finding>,
    pub refusals: usize,
    pub ok: bool,
}

fn count(n: usize) -> Json {
    Json::int(i64::try_from(n).unwrap_or(i64::MAX))
}

impl Report {
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("checked", count(self.checked)),
            ("agreed", count(self.agreed)),
            (
                "findings",
                Json::Array(
                    self.findings
                        .iter()
                        .map(|f| {
                            Json::obj([
                                ("orderId", Json::str(f.order_id.clone())),
                                ("case", Json::str(f.case)),
                                ("verdict", Json::str(f.verdict)),
                                ("engine", Json::str(f.engine.clone())),
                                ("counterpart", Json::str(f.counterpart.clone())),
                                ("reason", Json::str(f.reason)),
                            ])
                        })
                        .collect(),
                ),
            ),
            ("refusals", count(self.refusals)),
            ("ok", Json::Bool(self.ok)),
        ])
    }
}

/// `1` and `1.0` are one amount; none when either does not read as one.
fn same_amount(a: &str, b: &str) -> Option<bool> {
    Some(parse_amount(a).ok()? == parse_amount(b).ok()?)
}

fn describe_engine(o: &EngineLiveOrder) -> String {
    format!(
        "engine: LIVE {} {} remaining={} price={} market={} seq={}",
        o.kind.as_str(),
        o.side.as_str(),
        format_amount(o.remaining),
        format_amount(o.price),
        o.market_id,
        o.sequence
    )
}

fn describe_counterpart(o: &CounterpartOrder) -> String {
    let detail = o
        .detail
        .as_deref()
        .filter(|d| !d.is_empty())
        .map_or_else(String::new, |d| format!(" ({d})"));
    format!(
        "counterpart: {} remaining={} market={} funded={}{detail}",
        o.state.to_uppercase(),
        o.remaining,
        o.market_id,
        o.funded
    )
}

const ENGINE_ABSENT: &str = "engine: NOT LIVE — no resting order with this id in any book";
const COUNTERPART_ABSENT: &str = "counterpart: UNKNOWN — no record of this order id";

const DUPLICATE: &str = "the caller sent this order id more than once, with states that cannot both be true — its view of its own orders is inconsistent, so no verdict computed from that view is trustworthy for this id. Fix the query before acting.";
const UNFUNDED: &str =
    "intent row the ledger never funded and the engine never accepted — deleting it moves no value";
const STRANDED: &str = "value is held for an order the engine is not working — funds are stranded until this is resolved. Cannot auto-release: a lost fill event is indistinguishable from an order that was never live, and releasing a filled order pays the user money it owes the taker. Check fills for this order id before acting.";
const TERMINAL_LIVE: &str = "the engine can still match an order the caller has already closed — free book risk, and any fill it takes settles against a released hold. Cannot auto-cancel: if the counterpart is the side that is wrong, cancelling destroys a live funded order.";
const MARKET: &str = "one order id resting under two different markets — a cancel sent to either market is aimed at the wrong book";
const UNREADABLE: &str = "one side reported a quantity that is not a decimal amount — refusing rather than coercing a number out of it";
const QUANTITY: &str = "the two sides are working different quantities — one has mis-tracked a partial fill. Whichever is wrong, the held amount no longer matches the exposure, and picking a winner here writes that error into the book.";
const PENDING_LIVE: &str = "the engine is already resting an order the caller has not opened — pending is intent recorded, not yet live. Same market and the same remaining are not agreement. Cannot auto-cancel: cancelling would destroy a live order. Cannot auto-release: funded false is not a fill, and this report does not invent a quantity.";
const ENGINE_ONLY: &str = "the engine is working an order no caller claims — it can fill against a hold that does not exist. Cannot auto-cancel: an incomplete counterpart view is indistinguishable from a genuinely orphaned order, and cancelling on a partial view is the \"for-loop over ids empties a book\" failure the write routes are authenticated to prevent.";

/// `reconcile(engine, counterpart)`. `engine` is the whole engine's live orders, not one market's.
pub fn reconcile(engine: &[EngineLiveOrder], counterpart: &[CounterpartOrder]) -> Report {
    // The last order of an id wins, as `byId.set` keeps it.
    let live_of = |id: &str| engine.iter().rev().find(|o| o.order_id == id);
    let mut seen: Vec<&str> = Vec::new();
    let mut findings: Vec<Finding> = Vec::new();
    let mut agreed = 0usize;

    for (i, claim) in counterpart.iter().enumerate() {
        if !seen.contains(&claim.order_id.as_str()) {
            seen.push(&claim.order_id);
        }
        let copies: Vec<&CounterpartOrder> = counterpart
            .iter()
            .filter(|c| c.order_id == claim.order_id)
            .collect();
        if copies.len() > 1 {
            let first = counterpart
                .iter()
                .position(|c| c.order_id == claim.order_id)
                == Some(i);
            if first {
                findings.push(Finding {
                    order_id: claim.order_id.clone(),
                    case: "duplicate_counterpart_id",
                    verdict: "refuse",
                    engine: live_of(&claim.order_id)
                        .map_or_else(|| ENGINE_ABSENT.to_owned(), describe_engine),
                    counterpart: copies
                        .iter()
                        .map(|c| describe_counterpart(c))
                        .collect::<Vec<_>>()
                        .join(" | "),
                    reason: DUPLICATE,
                });
            }
            continue;
        }
        let finding = |case, verdict, engine: String, reason| Finding {
            order_id: claim.order_id.clone(),
            case,
            verdict,
            engine,
            counterpart: describe_counterpart(claim),
            reason,
        };
        let Some(live) = live_of(&claim.order_id) else {
            if claim.state == "terminal" {
                agreed += 1;
            } else if !claim.funded {
                findings.push(finding(
                    "counterpart_unfunded_engine_missing",
                    "auto",
                    ENGINE_ABSENT.to_owned(),
                    UNFUNDED,
                ));
            } else {
                findings.push(finding(
                    "counterpart_open_engine_missing",
                    "refuse",
                    ENGINE_ABSENT.to_owned(),
                    STRANDED,
                ));
            }
            continue;
        };
        let engine_state = describe_engine(live);
        if claim.state == "terminal" {
            findings.push(finding(
                "counterpart_terminal_engine_live",
                "refuse",
                engine_state,
                TERMINAL_LIVE,
            ));
            continue;
        }
        if live.market_id != claim.market_id {
            findings.push(finding(
                "market_disagreement",
                "refuse",
                engine_state,
                MARKET,
            ));
            continue;
        }
        match same_amount(&format_amount(live.remaining), &claim.remaining) {
            None => findings.push(finding(
                "unreadable_amount",
                "refuse",
                engine_state,
                UNREADABLE,
            )),
            Some(false) => findings.push(finding(
                "quantity_disagreement",
                "refuse",
                engine_state,
                QUANTITY,
            )),
            Some(true) if claim.state == "pending" => {
                findings.push(finding(
                    "counterpart_pending_engine_live",
                    "refuse",
                    engine_state,
                    PENDING_LIVE,
                ));
            }
            Some(true) => agreed += 1,
        }
    }

    let mut engine_only = 0usize;
    for live in engine {
        if seen.contains(&live.order_id.as_str()) {
            continue;
        }
        engine_only += 1;
        findings.push(Finding {
            order_id: live.order_id.clone(),
            case: "engine_only",
            verdict: "refuse",
            engine: describe_engine(live),
            counterpart: COUNTERPART_ABSENT.to_owned(),
            reason: ENGINE_ONLY,
        });
    }
    findings.sort_by(|a, b| crate::journal::replay::js_sort_cmp(&a.order_id, &b.order_id));
    let refusals = findings.iter().filter(|f| f.verdict == "refuse").count();
    Report {
        checked: seen.len() + engine_only,
        agreed,
        findings,
        refusals,
        ok: refusals == 0,
    }
}
