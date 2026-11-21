//! \`merchant.*\` (\`router.ts\` \`merchant\`, \`merchant/\`): the Merchant agent's policy, its approval-rate watch over the
//! caller's points, and the metered watch run over svc-pay's live samples.
//!
//! Nothing here invents an approval rate: a dark pay plane, an unset or silent metrics port, a missing, stale or
//! low-sample point is a named refusal, never a 0.00 board. An approval rate is a ratio compared as the TypeScript
//! compares it (a double from its decimal text), never money; the merchant posts nothing and changes no rail.
//!
//! The run's points come from svc-pay unchecked by any schema, so the watcher reads each one as JavaScript does: a
//! field is coerced where the TypeScript coerces it (\`String(asOf)\` for \`Date.parse\`, the rate's text for its pattern,
//! \`maxAgeMs\` as a number in the comparison), and an alert whose rail or rate is not a string fails the output schema.

use std::sync::Arc;

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json, js_number_string};
use service_kit::s2s::CallSigner;
use service_kit::schema::Value;
use service_kit::time::{Instant, js_date};
use service_kit::trpc::TrpcError;

use super::js::is_fresh;
use super::{Cx, is_refused, metered_run, strings, unmetered};
use crate::runtime::RunError;
use crate::runtime::guardrails::{Guardrail, parse_guardrail};
use crate::runtime::{ActInput, act};

/// \`MERCHANT_AGENT_ID\`.
pub const AGENT_ID: &str = "merchant";
/// \`MERCHANT_METRICS_TOOL\`: the one tool a watch run invokes.
pub const METRICS_TOOL: &str = "pay.metrics.read";

/// \`MERCHANT_MONEY_WRITE_TOOLS\`: never granted on the merchant.
pub const MONEY_WRITE_TOOLS: [&str; 8] = [
    "ledger.post",
    "ledger.hold",
    "pay.refund",
    "pay.capture",
    "pay.route.change",
    "bank.transfer",
    "trade.order",
    "p2p.release",
];

/// \`Object.values(MERCHANT_WATCH_REFUSE)\`, in its key order.
pub const WATCH_REFUSE: [&str; 3] = ["no_metrics", "stale", "pay_plane_dark"];

/// \`PAY_MERCHANT_WATCH_METRICS_PATH\`.
pub const METRICS_PATH: &str = "/internal/agents/merchant-watch-metrics";

const UNAVAILABLE: &str = "agents.merchant.unavailable";

/// \`merchantAgentGuardrail()\`.
pub fn guardrail() -> Result<Guardrail, RunError> {
    let spec = json::parse(
        r#"{"agentId":"merchant","version":1,"capacityMode":"research_only",
            "tools":[{"name":"pay.metrics.read","module":"pay","mode":"read"},
                     {"name":"pay.rails.list","module":"pay","mode":"read"}],
            "limits":{"maxActionsPerSession":40,"maxOutputTokensPerCall":1024,"maxSpendPerSession":"0.25",
                      "allowedModules":["pay","agents"],"allowedTasks":["merchant.watch"]}}"#,
    )
    .map_err(|e| RunError::Other(e.message))?;
    parse_guardrail(&spec).map_err(|e| RunError::Other(e.0))
}

/// \`isMerchantMoneyWriteTool\`.
pub fn is_money_write_tool(tool: &str) -> bool {
    MONEY_WRITE_TOOLS.contains(&tool)
}

fn flag(b: bool) -> Json {
    Json::int(i64::from(b))
}

#[expect(
    clippy::cast_precision_loss,
    reason = "counts are small; the TypeScript adds numbers"
)]
fn count(n: usize) -> Json {
    Json::Number(n as f64)
}

/// \`describeMerchantPolicy()\` in its output's key order.
pub fn policy() -> Json {
    let tools = MONEY_WRITE_TOOLS.len();
    let ledger_post = MONEY_WRITE_TOOLS.contains(&"ledger.post");
    let route_change = MONEY_WRITE_TOOLS.contains(&"pay.route.change");
    let (t, l, r) = (tools, u8::from(ledger_post), u8::from(route_change));
    Json::obj([
        ("moneyWriteTools", strings(&MONEY_WRITE_TOOLS)),
        (
            "moneyDeny",
            Json::obj([
                ("tools", count(tools)),
                ("hasLedgerPost", flag(ledger_post)),
                ("hasPayRouteChange", flag(route_change)),
            ]),
        ),
        (
            "moneyDenyStatusLine",
            Json::str(format!("tools={t} ledger_post={l} pay_route_change={r}")),
        ),
        (
            "moneyDenyExport",
            Json::str(format!("tools,ledger_post,pay_route_change\n{t},{l},{r}")),
        ),
        ("watchRefuseReasons", strings(&WATCH_REFUSE)),
        (
            "watchRefuse",
            Json::obj([
                ("codes", count(WATCH_REFUSE.len())),
                ("hasNoMetrics", flag(WATCH_REFUSE.contains(&"no_metrics"))),
                (
                    "hasPayPlaneDark",
                    flag(WATCH_REFUSE.contains(&"pay_plane_dark")),
                ),
                ("hasStale", flag(WATCH_REFUSE.contains(&"stale"))),
            ]),
        ),
        ("liveMetricsRefuseReason", Json::str("no_live_metrics")),
        ("darkPayPlaneRefuseReason", Json::str("pay_plane_dark")),
        ("inventsApprovalRate", Json::Bool(false)),
        ("allowedTask", Json::str("merchant.watch")),
    ])
}

// ── JavaScript's reading of an unchecked point ─────────────────────────────

/// \`String(v)\`.
fn js_string(v: &Value) -> String {
    match v {
        Value::Undefined => "undefined".to_owned(),
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_string(*n),
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|e| match e {
                Value::Undefined | Value::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
        Value::Date(ms) => ms.map_or_else(|| "Invalid Date".to_owned(), |m| Instant(m).iso()),
    }
}

/// \`Number(v)\`, as a relational comparison reads its operand.
fn js_to_number(v: &Value) -> f64 {
    match v {
        Value::Undefined | Value::Object(_) | Value::Date(None) => f64::NAN,
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => *n,
        Value::String(s) => service_kit::env::js_number(s).unwrap_or(f64::NAN),
        Value::Array(_) => service_kit::env::js_number(&js_string(v)).unwrap_or(f64::NAN),
        #[expect(
            clippy::cast_precision_loss,
            reason = "a time value within ±8.64e15 is exact"
        )]
        Value::Date(Some(ms)) => *ms as f64,
    }
}

/// \`!!v\`.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Undefined | Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => *n != 0.0 && !n.is_nan(),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) | Value::Date(_) => true,
    }
}

/// \`p[key]\`: a field of anything but \`null\` and \`undefined\`, which throw as JavaScript does.
fn prop<'v>(p: &'v Value, key: &str) -> Result<&'v Value, RunError> {
    match p {
        Value::Null | Value::Undefined => Err(RunError::Other(format!(
            "Cannot read properties of {} (reading '{key}')",
            js_string(p)
        ))),
        other => Ok(other.get(key)),
    }
}

/// \`/^(0(\.\d+)?|1(\.0+)?)$/\`.
fn rate_shape(s: &str) -> bool {
    let (whole, frac) = match s.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (s, None),
    };
    match (whole, frac) {
        ("0" | "1", None) => true,
        ("0", Some(f)) => !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()),
        ("1", Some(f)) => !f.is_empty() && f.bytes().all(|b| b == b'0'),
        _ => false,
    }
}

/// \`parseRate(s)\`: the pattern over \`String(s)\`, then \`Number(s)\` in [0, 1].
fn parse_rate(v: &Value) -> Option<f64> {
    let text = js_string(v);
    if !rate_shape(&text) {
        return None;
    }
    let n: f64 = text.parse().ok()?;
    (n.is_finite() && (0.0..=1.0).contains(&n)).then_some(n)
}

fn is_integer(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) if n.is_finite() && n.fract() == 0.0 => Some(*n),
        _ => None,
    }
}

// ── The watcher ────────────────────────────────────────────────────────────

/// \`watchApprovalFixtures\`' options. \`now\` is the clock or the caller's time; none is an invalid date.
pub struct WatchOptions<'a> {
    pub now: Option<Instant>,
    pub threshold: Option<&'a str>,
    pub pay_plane: Option<&'a str>,
    pub allowlist: Option<Vec<String>>,
    pub min_attempts: Option<f64>,
}

/// \`MerchantAlert\`: the point's own rail and rate, as it held them.
pub struct Alert {
    pub rail_id: Value,
    pub approval_rate: Value,
    pub attempts: f64,
    pub threshold: String,
}

/// A watch's outcome: \`ok\`'s counts and alerts, or the answer of any other status.
pub enum Watched {
    Ok {
        watched_at: String,
        considered: usize,
        skipped_stale: usize,
        skipped_incomplete: usize,
        skipped_low_sample: usize,
        alerts: Vec<Alert>,
    },
    Other(Vec<(String, Json)>),
}

fn unavailable(reason: &str) -> Vec<(String, Json)> {
    vec![
        ("status".to_owned(), Json::str("unavailable")),
        ("userMessageKey".to_owned(), Json::str(UNAVAILABLE)),
        ("reason".to_owned(), Json::str(reason)),
    ]
}

fn empty() -> Vec<(String, Json)> {
    vec![
        ("status".to_owned(), Json::str("empty")),
        (
            "userMessageKey".to_owned(),
            Json::str("agents.merchant.empty"),
        ),
    ]
}

/// \`watchApprovalFixtures\`: alerts where a usable point's rate is below the threshold; any scoped point missing its
/// rate or attempts, or stale, refuses the whole watch, and a board of only low samples refuses too.
pub fn watch(points: &[Value], o: &WatchOptions<'_>) -> Result<Watched, RunError> {
    if o.pay_plane != Some("live") {
        return Ok(Watched::Other(unavailable("pay_plane_dark")));
    }
    let threshold_text = o.threshold.unwrap_or("0.85");
    let Some(threshold) = parse_rate(&Value::String(threshold_text.to_owned())) else {
        return Ok(Watched::Other(unavailable("no_metrics")));
    };
    let min_attempts = o
        .min_attempts
        .filter(|m| m.is_finite() && m.fract() == 0.0 && *m >= 1.0)
        .unwrap_or(1.0);

    let (scoped, not_allowed): (Vec<&Value>, usize) = match &o.allowlist {
        Some(list) if !list.is_empty() => {
            let mut kept = Vec::new();
            let mut skipped = 0;
            for p in points {
                match prop(p, "railId")? {
                    Value::String(s) if list.contains(s) => kept.push(p),
                    _ => skipped += 1,
                }
            }
            (kept, skipped)
        }
        _ => (points.iter().collect(), 0),
    };
    if scoped.is_empty() {
        return Ok(Watched::Other(empty()));
    }

    let mut stale = 0;
    let mut incomplete = not_allowed;
    let mut low_sample = 0;
    let mut alerts = Vec::new();
    for p in scoped.iter().copied() {
        let rail = prop(p, "railId")?;
        if !truthy(rail) {
            incomplete += 1;
            continue;
        }
        let fresh = o.now.is_some_and(|now| {
            is_fresh(
                &js_string(p.get("asOf")),
                js_to_number(p.get("maxAgeMs")),
                now.0,
            )
        });
        if !fresh {
            stale += 1;
            continue;
        }
        let (rate, attempts) = (p.get("approvalRate"), p.get("attempts"));
        if matches!(rate, Value::Null | Value::Undefined)
            || matches!(attempts, Value::Null | Value::Undefined)
        {
            incomplete += 1;
            continue;
        }
        let Some(attempts) = is_integer(attempts).filter(|a| *a >= 0.0) else {
            incomplete += 1;
            continue;
        };
        if attempts < min_attempts {
            low_sample += 1;
            continue;
        }
        let Some(r) = parse_rate(rate) else {
            incomplete += 1;
            continue;
        };
        if r < threshold {
            alerts.push(Alert {
                rail_id: rail.clone(),
                approval_rate: rate.clone(),
                attempts,
                threshold: threshold_text.to_owned(),
            });
        }
    }

    let real_incomplete = incomplete - not_allowed;
    if real_incomplete > 0 {
        return Ok(Watched::Other(unavailable("no_metrics")));
    }
    if stale > 0 {
        return Ok(Watched::Other(unavailable("stale")));
    }
    let usable = scoped.len() - low_sample;
    if usable == 0 && alerts.is_empty() {
        if low_sample > 0 {
            return Ok(Watched::Other(unavailable("no_metrics")));
        }
        return Ok(Watched::Other(empty()));
    }
    // `now.toISOString()` of an invalid date throws; no path reaches here without a fresh point, which needs a time.
    let Some(now) = o.now else {
        return Err(RunError::Other("Invalid time value".to_owned()));
    };
    Ok(Watched::Ok {
        watched_at: now.iso(),
        considered: scoped.len() + not_allowed,
        skipped_stale: stale,
        skipped_incomplete: incomplete,
        skipped_low_sample: low_sample,
        alerts,
    })
}

/// The \`ok\` answer's fields in the outputs' order, and whether every alert's rail and rate are strings (the output
/// schema's \`z.string()\`).
fn ok_fields(
    watched_at: String,
    considered: usize,
    stale: usize,
    incomplete: usize,
    low_sample: usize,
    alerts: &[Alert],
) -> (Vec<(String, Json)>, bool) {
    let shaped = alerts.iter().all(|a| {
        matches!(a.rail_id, Value::String(_)) && matches!(a.approval_rate, Value::String(_))
    });
    let alerts = alerts
        .iter()
        .map(|a| {
            Json::obj([
                ("railId", a.rail_id.to_json().unwrap_or(Json::Null)),
                (
                    "approvalRate",
                    a.approval_rate.to_json().unwrap_or(Json::Null),
                ),
                ("attempts", Json::Number(a.attempts)),
                ("threshold", Json::str(a.threshold.clone())),
                ("kind", Json::str("below_threshold")),
            ])
        })
        .collect();
    (
        vec![
            ("status".to_owned(), Json::str("ok")),
            ("watchedAt".to_owned(), Json::str(watched_at)),
            ("considered".to_owned(), count(considered)),
            ("skippedStale".to_owned(), count(stale)),
            ("skippedIncomplete".to_owned(), count(incomplete)),
            ("skippedLowSample".to_owned(), count(low_sample)),
            ("alerts".to_owned(), Json::Array(alerts)),
        ],
        shaped,
    )
}

/// tRPC's answer when a handler's value fails its \`.output()\` schema.
fn output_invalid() -> RunError {
    RunError::Trpc(TrpcError::plain(
        "INTERNAL_SERVER_ERROR",
        "Output validation failed",
    ))
}

// ── The calls ──────────────────────────────────────────────────────────────

/// \`input.now === undefined ? <the clock> : new Date(input.now)\`; none when the date is invalid.
fn now_of(cx: &Cx<'_>) -> Option<Instant> {
    match cx.ctx.input.get("now").as_str() {
        Some(s) => js_date(s),
        None => Some(cx.ctx.now),
    }
}

fn options<'a>(cx: &'a Cx<'a>, plane: Option<&'a str>) -> WatchOptions<'a> {
    let input = &cx.ctx.input;
    WatchOptions {
        now: now_of(cx),
        threshold: input.get("threshold").as_str(),
        pay_plane: plane,
        allowlist: input.get("railAllowlist").as_array().map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        }),
        min_attempts: input.get("minAttempts").as_number(),
    }
}

/// Answers one \`merchant.*\` call.
pub fn handle(cx: &Cx<'_>, call: &str) -> Result<Json, RunError> {
    match call {
        "policy" => Ok(policy()),
        "watch" => {
            let input = &cx.ctx.input;
            let points = input.get("points").as_array().unwrap_or(&[]);
            match watch(points, &options(cx, input.get("payPlane").as_str()))? {
                Watched::Ok {
                    watched_at,
                    considered,
                    skipped_stale,
                    skipped_incomplete,
                    skipped_low_sample,
                    alerts,
                } => {
                    let (fields, shaped) = ok_fields(
                        watched_at,
                        considered,
                        skipped_stale,
                        skipped_incomplete,
                        skipped_low_sample,
                        &alerts,
                    );
                    if !shaped {
                        return Err(output_invalid());
                    }
                    Ok(Json::Object(fields))
                }
                Watched::Other(fields) => Ok(Json::Object(fields)),
            }
        }
        "runSession" => run_session(cx),
        _ => Err(RunError::Trpc(crate::door::not_ported(cx.ctx.call.slice))),
    }
}

// ── The metered run ────────────────────────────────────────────────────────

/// \`PayMetricsPort\`: svc-pay's grounded live samples, each as svc-pay sent it.
pub trait PayMetrics: Send + Sync {
    /// \`sample()\`: the points, or the failure the TypeScript's port would throw.
    fn sample(&self) -> Result<Vec<Json>, String>;
}

/// \`readLivePayMetrics\`: no port, no points or a failure are all \`no_live_metrics\` (none).
fn live_metrics(port: Option<&dyn PayMetrics>) -> Option<Vec<Json>> {
    let points = port?.sample().ok()?;
    (!points.is_empty()).then_some(points)
}

/// The run's refusal fields, before its metering.
fn run_refusal(reason: &str, by_guardrail: usize) -> Vec<(String, Json)> {
    vec![
        ("status".to_owned(), Json::str("refuse")),
        ("reason".to_owned(), Json::str(reason)),
        ("userMessageKey".to_owned(), Json::str(UNAVAILABLE)),
        ("pointsRefusedByGuardrail".to_owned(), count(by_guardrail)),
    ]
}

/// \`runMerchantWatchSession\`: a dark plane and a silent port refuse before any session; otherwise each live sample
/// goes through \`act\` as \`pay.metrics.read\`, a guardrail refusal counted, and the accepted samples are watched; the
/// session is settled and closed on every path. Request-body points are never live truth.
fn run_session(cx: &Cx<'_>) -> Result<Json, RunError> {
    let input = &cx.ctx.input;
    let asset = cx.fee_asset_id();
    let free = |mut f: Vec<(String, Json)>| {
        f.push(("metering".to_owned(), unmetered(asset)));
        Ok(Json::Object(f))
    };
    let plane = input.get("plane").as_str();
    if plane != Some("live") {
        return free(run_refusal("pay_plane_dark", 0));
    }
    let Some(series) = live_metrics(cx.ports.pay_metrics.as_deref()) else {
        return free(run_refusal("no_live_metrics", 0));
    };

    let opts = options(cx, plane);
    let x = cx.x()?;
    let mut shaped = true;
    let answer = metered_run(&x, cx.user(), AGENT_ID, asset, |session_id| {
        let mut accepted = Vec::new();
        let mut by_guardrail = 0;
        for point in &series {
            let done = act(
                &x,
                &ActInput {
                    session_id,
                    tool: METRICS_TOOL,
                    ..ActInput::default()
                },
                || Ok(js_shaped(point)),
            );
            match done {
                Ok(a) => accepted.push(Value::from_json(&a.result)),
                Err(e) if is_refused(&e) => by_guardrail += 1,
                Err(e) => return Err(e),
            }
        }
        if accepted.is_empty() {
            return Ok(Json::Object(run_refusal("no_live_metrics", by_guardrail)));
        }
        // A guardrail drop is a hole in the series: watching the accepted subset would invent a complete board.
        if by_guardrail > 0 {
            return Ok(Json::Object(unavailable("no_metrics")));
        }
        Ok(match watch(&accepted, &opts)? {
            Watched::Ok {
                watched_at,
                considered,
                skipped_stale,
                skipped_incomplete,
                skipped_low_sample,
                alerts,
            } => {
                let (mut f, ok) = ok_fields(
                    watched_at,
                    considered,
                    skipped_stale,
                    skipped_incomplete,
                    skipped_low_sample,
                    &alerts,
                );
                shaped = ok;
                f.push(("pointsAccepted".to_owned(), count(accepted.len())));
                f.push(("pointsRefusedByGuardrail".to_owned(), count(by_guardrail)));
                Json::Object(f)
            }
            Watched::Other(fields) => Json::Object(fields),
        })
    })?;
    // The output schema judges the answer after the run has settled and closed.
    if !shaped {
        return Err(output_invalid());
    }
    Ok(answer)
}

/// A sample as the TypeScript holds it after \`response.json()\`: an object's keys in JavaScript's order.
fn js_shaped(point: &Json) -> Json {
    Value::from_json(point).to_json().unwrap_or(Json::Null)
}

// ── The live port ──────────────────────────────────────────────────────────

/// \`createHttpPayMetricsPort\`: svc-pay's \`GET /internal/agents/merchant-watch-metrics\`, signed as svc-agents for
/// svc-pay. A failed signature or request, a status outside 2xx, a body that is not JSON, a refusal body or one
/// without a list of points is no points, never a failure.
pub struct PayMetricsHttp {
    pub pay_url: String,
    pub signer: CallSigner,
    pub fetch: Arc<dyn Fetch>,
}

impl PayMetricsHttp {
    pub fn new(pay_url: &str, signer: CallSigner, fetch: Arc<dyn Fetch>) -> PayMetricsHttp {
        PayMetricsHttp {
            pay_url: pay_url.strip_suffix('/').unwrap_or(pay_url).to_owned(),
            signer,
            fetch,
        }
    }
}

/// \`url.pathname + url.search\` of an absolute URL; none when it has no scheme (\`new URL\` throws).
fn signed_target(url: &str) -> Option<String> {
    let (_, rest) = url.split_once("://")?;
    let rest = rest.split('#').next().unwrap_or("");
    Some(match rest.find(['/', '?']) {
        Some(at) => {
            let tail = rest.get(at..).unwrap_or("");
            if tail.starts_with('?') {
                format!("/{tail}")
            } else {
                tail.to_owned()
            }
        }
        None => "/".to_owned(),
    })
}

/// \`parsePoints\`: \`{ ok: true, points: [...] }\`'s points; anything else none.
fn parse_points(body: &Json) -> Vec<Json> {
    match (body.get("ok"), body.get("points")) {
        (Some(Json::Bool(true)), Some(Json::Array(points))) => points.clone(),
        _ => Vec::new(),
    }
}

impl PayMetrics for PayMetricsHttp {
    fn sample(&self) -> Result<Vec<Json>, String> {
        let url = format!("{}{METRICS_PATH}", self.pay_url);
        let Some(target) = signed_target(&url) else {
            return Ok(Vec::new());
        };
        let Ok(signed) = self.signer.sign("", "GET", &target, "") else {
            return Ok(Vec::new());
        };
        let mut headers = vec![("accept".to_owned(), "application/json".to_owned())];
        headers.extend(signed);
        let Ok(res) = self.fetch.fetch(&HttpRequest {
            method: "GET".to_owned(),
            url,
            headers,
            body: None,
            timeout_ms: None,
            refuse_redirect: false,
        }) else {
            return Ok(Vec::new());
        };
        if !res.ok() {
            return Ok(Vec::new());
        }
        Ok(json::parse(&res.body)
            .map(|b| parse_points(&b))
            .unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn the_guardrail_is_the_boot_row() {
        let boot = crate::boot::boot_agents().unwrap();
        let row = boot.iter().find(|r| r.agent_id == AGENT_ID).unwrap();
        assert_eq!(
            crate::runtime::guardrails::serialise_guardrail(&guardrail().unwrap()),
            row.guardrail
        );
        assert!(
            guardrail()
                .unwrap()
                .tools
                .iter()
                .all(|t| !is_money_write_tool(&t.name))
        );
    }

    #[test]
    fn the_rate_pattern_is_the_typescripts() {
        for ok in ["0", "1", "0.5", "0.85", "1.0", "1.000", "0.0000"] {
            assert!(rate_shape(ok), "{ok}");
        }
        for no in [
            "", ".5", "0.", "1.", "01", "1.5", "1.01", "2", "-0.1", "0.5x", "0,5", "1e-1",
        ] {
            assert!(!rate_shape(no), "{no}");
        }
    }

    #[test]
    fn a_signed_target_is_the_path_and_query() {
        assert_eq!(
            signed_target("http://pay.test/internal/x").as_deref(),
            Some("/internal/x")
        );
        assert_eq!(
            signed_target("http://pay.test/base/internal/x?a=1#f").as_deref(),
            Some("/base/internal/x?a=1")
        );
        assert_eq!(signed_target("pay.test/internal/x"), None);
    }

    #[test]
    fn js_coercions() {
        assert_eq!(js_string(&Value::Number(0.5)), "0.5");
        assert_eq!(
            js_string(&Value::Array(vec![Value::Null, Value::Number(1.0)])),
            ",1"
        );
        assert!(js_to_number(&Value::Null) == 0.0);
        assert!(js_to_number(&Value::String("12".to_owned())) == 12.0);
        assert!(!truthy(&Value::Number(f64::NAN)));
        assert!(truthy(&Value::Array(Vec::new())));
    }
}
