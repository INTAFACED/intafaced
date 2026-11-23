//! What the process says about itself: `GET /health` (`health.ts`), `GET /ready` (inline in `index.ts`), and the
//! latency of each order operation since the engine started (`operation-latency.ts`), which `/health` carries for the
//! founder console's venue health.
//!
//! The scrape at `/metrics` keeps every reply under one `_local` module label, so it cannot say how long a submit took
//! apart from a depth read. This keeps a small histogram per operation, on the scrape's bucket bounds. An operation
//! with no reply timed yet has no latency: its count is 0 and both percentiles are null, which the console shows as
//! `matching_metrics_unread`, never as 0 ms.

use std::collections::BTreeMap;
use std::time::Duration;

use service_kit::json::Json;
use service_kit::server::Response;
use service_kit::time::Instant;

use crate::engine::MatchingEngine;

/// `OPERATIONS`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Operation {
    Submit,
    Cancel,
    Depth,
}

impl Operation {
    pub const ALL: [Operation; 3] = [Operation::Submit, Operation::Cancel, Operation::Depth];

    pub fn name(self) -> &'static str {
        match self {
            Operation::Submit => "submit",
            Operation::Cancel => "cancel",
            Operation::Depth => "depth",
        }
    }
}

/// `operationOf`: the operation a route pattern serves (the pattern, never the URL, so a market id is never a label).
pub fn operation_of(method: &str, pattern: Option<&str>) -> Option<Operation> {
    match (method.to_ascii_uppercase().as_str(), pattern?) {
        ("POST", "/markets/:marketId/orders") => Some(Operation::Submit),
        ("DELETE", "/markets/:marketId/orders/:orderId") => Some(Operation::Cancel),
        ("GET", "/markets/:marketId/depth") => Some(Operation::Depth),
        _ => None,
    }
}

/// `BOUNDS_MS`: the scrape's buckets in whole milliseconds; one more, open-ended, after them.
pub fn bounds_ms() -> [u64; 11] {
    // `Math.round(s * 1000)` of the kit's `DURATION_BUCKETS`, written out; `tests/status.rs` holds them equal.
    [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]
}

const BUCKETS: usize = 12;

#[derive(Debug, Clone, Default)]
struct Histogram {
    buckets: [u64; BUCKETS],
    errors: u64,
}

impl Histogram {
    fn observe(&mut self, at: usize, status: u16) {
        if let Some(b) = self.buckets.get_mut(at) {
            *b += 1;
        }
        if status >= 500 {
            self.errors += 1;
        }
    }
}

/// `OperationLatency`.
#[derive(Debug, Clone)]
pub struct OperationLatency {
    started_at: i64,
    ops: BTreeMap<Operation, Histogram>,
    submit_markets: BTreeMap<String, Histogram>,
}

/// `OperationReading`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reading {
    pub count: u64,
    pub errors: u64,
    pub p50_ms: Option<u64>,
    pub p99_ms: Option<u64>,
    /// Replies a minute over the whole time since timing began, to two decimals; `0` with none.
    pub per_minute: String,
}

impl Reading {
    pub fn to_json(&self) -> Json {
        let ms = |v: Option<u64>| {
            v.map_or(Json::Null, |n| {
                Json::int(i64::try_from(n).unwrap_or(i64::MAX))
            })
        };
        let count = |n: u64| Json::int(i64::try_from(n).unwrap_or(i64::MAX));
        Json::obj([
            ("count", count(self.count)),
            ("errors", count(self.errors)),
            ("p50Ms", ms(self.p50_ms)),
            ("p99Ms", ms(self.p99_ms)),
            ("perMinute", Json::str(self.per_minute.clone())),
        ])
    }
}

impl OperationLatency {
    /// Timing since `started_at`, in milliseconds since the epoch.
    pub fn new(started_at: i64) -> OperationLatency {
        OperationLatency {
            started_at,
            ops: Operation::ALL
                .into_iter()
                .map(|op| (op, Histogram::default()))
                .collect(),
            submit_markets: BTreeMap::new(),
        }
    }

    /// One reply of `op` that took `elapsed`; `market_id` counts a submit for that market too (only an id the engine
    /// has, never a raw URL value).
    pub fn observe(
        &mut self,
        op: Operation,
        elapsed: Duration,
        status: u16,
        market_id: Option<&str>,
    ) {
        let micros = elapsed.as_micros();
        let at = bounds_ms()
            .iter()
            .position(|b| micros <= u128::from(*b) * 1000)
            .unwrap_or(BUCKETS - 1);
        self.ops.entry(op).or_default().observe(at, status);
        if op == Operation::Submit
            && let Some(m) = market_id
        {
            self.submit_markets
                .entry(m.to_owned())
                .or_default()
                .observe(at, status);
        }
    }

    /// `read(now, markets)`: each operation, and submit latency for every market given (sorted), one with nothing timed
    /// reading count 0 and no percentile.
    pub fn read(&self, now: i64, markets: &[String]) -> Json {
        let elapsed = (now - self.started_at).max(1);
        let reading = |h: &Histogram| read_histogram(h, elapsed);
        let operations = Json::Object(
            Operation::ALL
                .into_iter()
                .map(|op| {
                    let h = self.ops.get(&op).cloned().unwrap_or_default();
                    (op.name().to_owned(), reading(&h).to_json())
                })
                .collect(),
        );
        let mut ids: Vec<&String> = markets.iter().collect();
        ids.sort();
        ids.dedup();
        let by_market = Json::Object(
            ids.into_iter()
                .map(|id| {
                    let h = self.submit_markets.get(id).cloned().unwrap_or_default();
                    (id.clone(), reading(&h).to_json())
                })
                .collect(),
        );
        Json::obj([
            ("startedAt", Json::str(Instant(self.started_at).iso())),
            ("operations", operations),
            ("submitByMarket", by_market),
        ])
    }

    /// One operation's reading at `now`, for a test.
    pub fn reading(&self, op: Operation, now: i64) -> Reading {
        let h = self.ops.get(&op).cloned().unwrap_or_default();
        read_histogram(&h, (now - self.started_at).max(1))
    }

    /// One market's submit reading at `now`, for a test.
    pub fn market_reading(&self, market_id: &str, now: i64) -> Reading {
        let h = self
            .submit_markets
            .get(market_id)
            .cloned()
            .unwrap_or_default();
        read_histogram(&h, (now - self.started_at).max(1))
    }
}

fn read_histogram(h: &Histogram, elapsed_ms: i64) -> Reading {
    let count: u64 = h.buckets.iter().sum();
    Reading {
        count,
        errors: h.errors,
        p50_ms: percentile_bound(&h.buckets, count, 50),
        p99_ms: percentile_bound(&h.buckets, count, 99),
        per_minute: per_minute(count, elapsed_ms),
    }
}

/// `(count / minutes).toFixed(2)`, in integers: hundredths of `count × 60000 / elapsed`, a tie rounding up.
fn per_minute(count: u64, elapsed_ms: i64) -> String {
    if count == 0 {
        return "0".to_owned();
    }
    let d = u128::try_from(elapsed_ms.max(1)).unwrap_or(1);
    let num = u128::from(count) * 6_000_000;
    let hundredths = (num * 2 + d) / (d * 2);
    format!("{}.{:02}", hundredths / 100, hundredths % 100)
}

/// `percentileBound`: the upper bound of the bucket holding the p-th percentile reply; null past the last finite bound
/// (the console says "over 10000 ms", not a number nobody measured), and null with no reply timed.
fn percentile_bound(buckets: &[u64; BUCKETS], count: u64, p: u64) -> Option<u64> {
    if count == 0 {
        return None;
    }
    let rank = (count * p).div_ceil(100);
    let mut seen = 0;
    for (i, n) in buckets.iter().enumerate() {
        seen += n;
        if seen >= rank {
            return bounds_ms().get(i).copied();
        }
    }
    None
}

/// `matchingHealthBody`: the engine's state, read live, with the latency when the process keeps it.
pub fn health_body(
    service: &str,
    engine: &MatchingEngine,
    latency: Option<&OperationLatency>,
    now: i64,
) -> Json {
    let n = |v: usize| Json::int(i64::try_from(v).unwrap_or(i64::MAX));
    let markets = engine.markets();
    let mut fields = vec![
        ("ok".to_owned(), Json::Bool(true)),
        ("service".to_owned(), Json::str(service)),
        ("enabled".to_owned(), Json::Bool(engine.is_enabled())),
        (
            "venueHalted".to_owned(),
            Json::Bool(engine.is_venue_halted()),
        ),
        ("markets".to_owned(), n(markets.len())),
        ("restingOrders".to_owned(), n(engine.resting_order_count())),
        ("journalRecords".to_owned(), n(engine.journal().len())),
        (
            "admissionOpen".to_owned(),
            Json::Bool(engine.admission_open()),
        ),
        (
            "admissionReason".to_owned(),
            engine.admission_reason().map_or(Json::Null, Json::str),
        ),
        (
            "holdHalted".to_owned(),
            Json::Array(
                engine
                    .hold_halted_markets()
                    .into_iter()
                    .map(Json::String)
                    .collect(),
            ),
        ),
    ];
    if let Some(l) = latency {
        fields.push(("metrics".to_owned(), l.read(now, &markets)));
    }
    Json::Object(fields)
}

/// `GET /ready`: stricter than liveness. A disabled engine is alive (it still serves depth and health) but must not
/// receive orders, so it answers 503; so does a book whose hold check closed admission.
pub fn ready(engine: &MatchingEngine) -> Response {
    let not_ready = |reason: &str| Response {
        status: 503,
        body: Json::obj([("ready", Json::Bool(false)), ("reason", Json::str(reason))]).compact(),
    };
    if !engine.is_enabled() {
        return not_ready("matching.engine flag is off");
    }
    if !engine.admission_open() {
        return not_ready(
            engine
                .admission_reason()
                .unwrap_or("matching.hold_check_unreachable"),
        );
    }
    Response {
        status: 200,
        body: Json::obj([
            ("ready", Json::Bool(true)),
            (
                "sequence",
                Json::int(i64::try_from(engine.markets().len()).unwrap_or(i64::MAX)),
            ),
        ])
        .compact(),
    }
}
