//! `copyIntel.*` (`router.ts` `copyIntel`, `copy-intel/`): Copy-Intel's policy, its audited leader stats over the
//! caller's fixtures, the directory they are presented in, and the metered stats run over svc-trade's live leaders.
//!
//! Nothing here invents a leader, a PnL, a win rate or a ranking: a dark copy plane, a live plane without the owner's
//! sealed allowlist (`LIVE_TRADE_COPY_LEADER_PLANE_OPEN`, `LIVE_TRADE_COPY_LEADER_IDS`), an incomplete row or a bad
//! window is a typed refusal, and a directory is always in `leaderId` order, never by returns (D26-P1-A5). `realisedPnl`
//! is money: it is checked as a scaled integer and handed back as the caller's own text, never a `number`. The win rate
//! is a unitless ratio the TypeScript computes in doubles. The free-text returns-board refusal on the session's engine
//! call is the runtime's (`runtime/copy_intel.rs`).

use std::cmp::Ordering;

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::money::{js_trim, parse_amount};
use service_kit::s2s::CallSigner;
use service_kit::schema::Value;
use service_kit::time::Instant;
use service_kit::trpc::TrpcError;

use super::js::{date_parse, to_fixed};
use super::{Cx, is_refused, json_str, metered_run, strings, unmetered};
use crate::runtime::{ActInput, act};
use crate::runtime::{Rt, RunError, denied};

/// `COPY_INTEL_AGENT_ID`.
pub const AGENT_ID: &str = "copy-intel";
/// `COPY_INTEL_LEADERS_TOOL`: the declared read of one leader's fixture.
pub const LEADERS_TOOL: &str = "trade.copy.leaders.read";
/// `COPY_INTEL_STATS_WRITE_TOOL`: the declared write of one audited stat.
pub const STATS_WRITE_TOOL: &str = "trade.copy.stats.write";

/// `COPY_INTEL_MONEY_WRITE_TOOLS`.
pub const MONEY_WRITE_TOOLS: [&str; 7] = [
    "ledger.post",
    "trade.order",
    "trade.cancel",
    "trade.copy.follow",
    "trade.copy.unfollow",
    "pay.capture",
    "p2p.release",
];

/// `FORBIDDEN_RETURNS_RANK_KEYS`.
pub const FORBIDDEN_RETURNS_RANK_KEYS: [&str; 11] = [
    "realisedPnl",
    "realizedPnl",
    "winRate",
    "win_rate",
    "returns",
    "return",
    "pnl",
    "performance",
    "profit",
    "roi",
    "rank",
];

/// `RETURNS_RANK_SORT_KEYS`.
pub const RETURNS_RANK_SORT_KEYS: [&str; 11] = [
    "returns",
    "return",
    "pnl",
    "realisedPnl",
    "realizedPnl",
    "winRate",
    "win_rate",
    "performance",
    "rank",
    "profit",
    "roi",
];

/// `MARKETING_BOARD_MODES`.
pub const MARKETING_BOARD_MODES: [&str; 7] = [
    "marketing_board",
    "leaderboard",
    "top_traders",
    "top_trader",
    "recommended",
    "recommended_for_you",
    "ranked",
];

/// `RETURNS_RANKED_BOARD_REFUSE_REASON`.
pub const RETURNS_RANKED_BOARD_REFUSE_REASON: &str = "returns_ranked_board_forbidden";

const EMPTY_KEY: &str = "agents.copy_intel.empty";
const UNAVAILABLE_KEY: &str = "agents.copy_intel.unavailable";

/// `isForbiddenReturnsRankKey`.
pub fn is_forbidden_returns_rank_key(rank_by: &str) -> bool {
    FORBIDDEN_RETURNS_RANK_KEYS.contains(&rank_by)
}

// ── The live plane ─────────────────────────────────────────────────────────

/// The owner's live leader plane, as `live-leader-plane-refuse.ts` reads it from the process environment (read once at
/// start-up here, into `Factories`, as the environment does not change while the process runs):
/// open only when `LIVE_TRADE_COPY_LEADER_PLANE_OPEN` trims to `true`, with the trimmed, non-blank ids of
/// `LIVE_TRADE_COPY_LEADER_IDS`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LivePlane {
    pub open: bool,
    pub ids: Vec<String>,
}

impl LivePlane {
    /// The plane read through `lookup` (a variable's value, or none when unset).
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> LivePlane {
        let open =
            lookup("LIVE_TRADE_COPY_LEADER_PLANE_OPEN").is_some_and(|v| js_trim(&v) == "true");
        let ids = lookup("LIVE_TRADE_COPY_LEADER_IDS")
            .map(|raw| {
                js_trim(&raw)
                    .split(',')
                    .map(js_trim)
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        LivePlane { open, ids }
    }

    /// `isLiveLeaderPlaneAllowlisted(requested)`: the plane open, a sealed list, and the caller naming a non-empty subset
    /// of it.
    pub fn allowlisted(&self, requested: Option<&[String]>) -> bool {
        if !self.open || self.ids.is_empty() {
            return false;
        }
        let asked = requested.unwrap_or(&[]);
        !asked.is_empty() && asked.iter().all(|id| self.ids.contains(id))
    }
}

// ── The stats ──────────────────────────────────────────────────────────────

/// `Date.parse(value)` of whatever a fixture's window holds: its `String(value)`.
fn date_of(v: &Value) -> Option<i64> {
    date_parse(&v.js_string())
}

/// `Number.isInteger(value)`.
fn integer(v: &Value) -> Option<f64> {
    v.as_number().filter(|n| n.is_finite() && n.fract() == 0.0)
}

/// `winRate(closed, winning)`: none for a negative count or more winners than trades.
#[expect(
    clippy::float_arithmetic,
    reason = "a unitless ratio of two counts, never money: the TypeScript divides doubles"
)]
fn win_rate(closed: f64, winning: f64) -> Option<String> {
    if closed < 0.0 || winning < 0.0 || winning > closed {
        return None;
    }
    if closed == 0.0 {
        return Some("0.0000".to_owned());
    }
    Some(to_fixed(winning / closed, 4))
}

/// One built stat: its leader, the stat as it leaves the service, and its audit row.
#[derive(Debug, Clone, PartialEq)]
pub struct Built {
    pub leader_id: String,
    pub stat: Json,
    pub audit: Json,
}

/// `buildLeaderStats`' outcome: `ok`'s stats with their audit rows, or the answer of any other status.
#[derive(Debug, Clone, PartialEq)]
pub enum Stats {
    Ok {
        built: Vec<Built>,
        skipped_incomplete: usize,
    },
    Other(Json),
}

fn empty() -> Json {
    Json::obj([
        ("status", Json::str("empty")),
        ("userMessageKey", Json::str(EMPTY_KEY)),
    ])
}

fn unavailable(reason: &str) -> Json {
    Json::obj([
        ("status", Json::str("unavailable")),
        ("userMessageKey", Json::str(UNAVAILABLE_KEY)),
        ("reason", Json::str(reason)),
    ])
}

/// The JSON of a value a fixture field holds (`undefined` dropped by the caller).
fn json_of(v: &Value) -> Json {
    v.to_json().unwrap_or(Json::Null)
}

/// `buildLeaderStats(fixtures, { now, copyPlane, leaderAllowlist })`: the dark and the unsealed live plane refuse; the
/// allowlist scopes the rows (a missing or empty one keeps all); an incomplete row is skipped, a bad window refuses the
/// whole build; stats keep the fixtures' order.
pub fn build_leader_stats(
    fixtures: &[Json],
    now: Instant,
    copy_plane: Option<&str>,
    allowlist: Option<&[String]>,
    live: &LivePlane,
) -> Stats {
    if copy_plane == Some("dark") || (copy_plane == Some("live") && !live.allowlisted(allowlist)) {
        return Stats::Other(unavailable("copy_plane_dark"));
    }
    let rows: Vec<Value> = fixtures.iter().map(Value::from_json).collect();
    let scoped: Vec<&Value> = match allowlist {
        Some(list) if !list.is_empty() => rows
            .iter()
            .filter(|r| {
                r.get("leaderId")
                    .as_str()
                    .is_some_and(|id| list.iter().any(|l| l == id))
            })
            .collect(),
        _ => rows.iter().collect(),
    };
    let not_allowed = rows.len() - scoped.len();
    if scoped.is_empty() {
        return Stats::Other(empty());
    }
    let mut skipped = not_allowed;
    let mut built = Vec::new();
    let written_at = now.iso();
    for row in scoped {
        let leader = row.get("leaderId");
        let source = row.get("source");
        if !leader.truthy() || !source.truthy() {
            skipped += 1;
            continue;
        }
        let (ws, we) = (row.get("windowStart"), row.get("windowEnd"));
        match (date_of(ws), date_of(we)) {
            (Some(s), Some(e)) if e >= s => {}
            _ => return Stats::Other(unavailable("invalid_window")),
        }
        let (pnl, closed, winning) = (
            row.get("realisedPnl"),
            row.get("closedTrades"),
            row.get("winningTrades"),
        );
        if [pnl, closed, winning]
            .iter()
            .any(|v| matches!(v, Value::Undefined | Value::Null))
        {
            skipped += 1;
            continue;
        }
        let (Some(closed), Some(winning)) = (integer(closed), integer(winning)) else {
            skipped += 1;
            continue;
        };
        let Some(pnl) = pnl.as_str().filter(|p| parse_amount(p).is_ok()) else {
            skipped += 1;
            continue;
        };
        let Some(rate) = win_rate(closed, winning) else {
            skipped += 1;
            continue;
        };
        // A truthy leader the allowlist did not scope is a string on every path that reaches here but the pure
        // build's, whose input schema holds it to one.
        let leader_id = leader.js_string();
        let stat = Json::obj([
            ("leaderId", json_of(leader)),
            ("realisedPnl", Json::str(pnl)),
            ("closedTrades", Json::Number(closed)),
            ("winRate", Json::str(rate)),
            ("windowStart", json_of(ws)),
            ("windowEnd", json_of(we)),
        ]);
        let audit = Json::obj([
            ("id", Json::str(format!("ci-{}", built.len() + 1))),
            ("writtenAt", Json::str(written_at.clone())),
            ("source", json_of(source)),
            ("leaderId", json_of(leader)),
            ("stat", stat.clone()),
            (
                "provenance",
                Json::obj([
                    ("fixture", Json::Bool(true)),
                    ("source", json_of(source)),
                    ("windowStart", json_of(ws)),
                    ("windowEnd", json_of(we)),
                ]),
            ),
        ]);
        built.push(Built {
            leader_id,
            stat,
            audit,
        });
    }
    if built.is_empty() {
        return Stats::Other(unavailable("no_data"));
    }
    Stats::Ok {
        built,
        skipped_incomplete: skipped,
    }
}

/// JavaScript's `a < b` on two strings: by UTF-16 code units.
fn js_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `sortDirectoryByLeaderId`: a stable `leaderId` order, never by performance.
fn sort_by_leader<T>(rows: &mut [T], id: impl Fn(&T) -> &str) {
    rows.sort_by(|a, b| js_cmp(id(a), id(b)));
}

/// The directory's presentation head.
fn presentation() -> Json {
    Json::obj([
        ("kind", Json::str("directory")),
        ("rankedByReturns", Json::Bool(false)),
        ("sortKey", Json::str("leaderId")),
    ])
}

#[expect(
    clippy::cast_precision_loss,
    reason = "counts are small; the TypeScript adds numbers"
)]
fn count(n: usize) -> Json {
    Json::Number(n as f64)
}

fn pair(k: &str, v: Json) -> (String, Json) {
    (k.to_owned(), v)
}

/// The door's `ok` stats and audit: the stats in `leaderId` order, each with the last audit row written for its leader
/// (`new Map(audit.map(a => [a.leaderId, a]))`).
fn ordered(stats: &[(String, Json)], audit: &[(String, Json)]) -> (Json, Json) {
    let mut sorted: Vec<&(String, Json)> = stats.iter().collect();
    sort_by_leader(&mut sorted, |s| s.0.as_str());
    let by_leader = |id: &str| {
        audit
            .iter()
            .rev()
            .find(|(a, _)| a == id)
            .map(|(_, a)| a.clone())
    };
    (
        Json::Array(sorted.iter().map(|(_, s)| s.clone()).collect()),
        Json::Array(sorted.iter().filter_map(|(id, _)| by_leader(id)).collect()),
    )
}

/// tRPC's answer when an answer breaks the call's output schema.
fn output_invalid() -> RunError {
    RunError::Trpc(TrpcError::plain(
        "INTERNAL_SERVER_ERROR",
        "Output validation failed".to_owned(),
    ))
}

/// The output schema's string fields of an `ok` answer's stats and audit rows: a live row holding another type there
/// fails the call as tRPC's output check does.
fn output_checked(answer: Json) -> Result<Json, RunError> {
    let is_str = |v: Option<&Json>| matches!(v, Some(Json::String(_)));
    let stat_ok = |s: &Json| {
        [
            "leaderId",
            "realisedPnl",
            "winRate",
            "windowStart",
            "windowEnd",
        ]
        .iter()
        .all(|k| is_str(s.get(k)))
    };
    if let Some(Json::Array(stats)) = answer.get("stats")
        && !stats.iter().all(stat_ok)
    {
        return Err(output_invalid());
    }
    if let Some(Json::Array(audit)) = answer.get("audit") {
        let row_ok = |a: &Json| {
            ["id", "writtenAt", "source", "leaderId"]
                .iter()
                .all(|k| is_str(a.get(k)))
                && a.get("stat").is_some_and(stat_ok)
                && a.get("provenance").is_some_and(|p| {
                    ["source", "windowStart", "windowEnd"]
                        .iter()
                        .all(|k| is_str(p.get(k)))
                })
        };
        if !audit.iter().all(row_ok) {
            return Err(output_invalid());
        }
    }
    Ok(answer)
}

// ── The directory ──────────────────────────────────────────────────────────

/// `presentLeaderDirectory`: only the `directory` mode and the `leaderId` sort; a marketing mode, any other mode, a
/// returns sort or any other sort refuses; no rows, or none the filter keeps, is empty.
fn present_directory(input: &Value) -> Json {
    let refuse = |reason: &str| {
        Json::obj([
            ("status", Json::str("refuse")),
            ("reason", Json::str(reason)),
            ("userMessageKey", Json::str(UNAVAILABLE_KEY)),
        ])
    };
    let mode = input
        .get("mode")
        .as_str()
        .filter(|m| !m.is_empty())
        .unwrap_or("directory");
    if mode != "directory" {
        return refuse(if MARKETING_BOARD_MODES.contains(&mode) {
            "marketing_board"
        } else {
            "returns_ranked_board"
        });
    }
    if let Some(sort) = input.get("sortBy").as_str().filter(|s| !s.is_empty())
        && sort != "leaderId"
    {
        return refuse("returns_ranked_board");
    }
    let stats = input.get("stats").as_array().unwrap_or(&[]);
    if stats.is_empty() {
        return empty();
    }
    let filter: Vec<&str> = input
        .get("leaderFilter")
        .as_array()
        .unwrap_or(&[])
        .iter()
        .filter_map(Value::as_str)
        .collect();
    let id = |s: &Value| s.get("leaderId").as_str().unwrap_or("").to_owned();
    let mut kept: Vec<(String, &Value)> = stats
        .iter()
        .map(|s| (id(s), s))
        .filter(|(i, _)| filter.is_empty() || filter.contains(&i.as_str()))
        .collect();
    if kept.is_empty() {
        return empty();
    }
    let skipped = stats.len() - kept.len();
    sort_by_leader(&mut kept, |(i, _)| i.as_str());
    let leader = |s: &Value| {
        Json::obj([
            ("leaderId", json_of(s.get("leaderId"))),
            ("realisedPnl", json_of(s.get("realisedPnl"))),
            ("closedTrades", json_of(s.get("closedTrades"))),
            ("winRate", json_of(s.get("winRate"))),
            ("windowStart", json_of(s.get("windowStart"))),
            ("windowEnd", json_of(s.get("windowEnd"))),
        ])
    };
    Json::obj([
        ("status", Json::str("ok")),
        ("skippedFiltered", count(skipped)),
        (
            "presentation",
            Json::obj([
                ("kind", Json::str("directory")),
                ("rankedByReturns", Json::Bool(false)),
                ("sortKey", Json::str("leaderId")),
                (
                    "leaders",
                    Json::Array(kept.into_iter().map(|(_, s)| leader(s)).collect()),
                ),
            ]),
        ),
    ])
}

// ── The policy ─────────────────────────────────────────────────────────────

/// `describeCopyIntelPolicy()`.
fn policy() -> Json {
    let has = |t: &str| Json::int(i64::from(MONEY_WRITE_TOOLS.contains(&t)));
    let flag = |t: &str| u8::from(MONEY_WRITE_TOOLS.contains(&t));
    let (n, ledger, order, follow) = (
        MONEY_WRITE_TOOLS.len(),
        flag("ledger.post"),
        flag("trade.order"),
        flag("trade.copy.follow"),
    );
    Json::obj([
        ("moneyWriteTools", strings(&MONEY_WRITE_TOOLS)),
        (
            "moneyDeny",
            Json::obj([
                ("tools", count(n)),
                ("hasLedgerPost", has("ledger.post")),
                ("hasTradeOrder", has("trade.order")),
                ("hasCopyFollow", has("trade.copy.follow")),
            ]),
        ),
        (
            "moneyDenyStatusLine",
            Json::str(format!(
                "tools={n} ledger_post={ledger} trade_order={order} copy_follow={follow}"
            )),
        ),
        (
            "moneyDenyExport",
            Json::str(format!(
                "tools,ledger_post,trade_order,copy_follow\n{n},{ledger},{order},{follow}"
            )),
        ),
        (
            "returnsRankForbiddenKeys",
            strings(&FORBIDDEN_RETURNS_RANK_KEYS),
        ),
        ("returnsRankSortKeys", strings(&RETURNS_RANK_SORT_KEYS)),
        ("marketingBoardModes", strings(&MARKETING_BOARD_MODES)),
        (
            "returnsRankedBoardRefuseReason",
            Json::str(RETURNS_RANKED_BOARD_REFUSE_REASON),
        ),
        ("directorySortKey", Json::str("leaderId")),
        ("rankedByReturns", Json::Bool(false)),
    ])
}

// ── The calls ──────────────────────────────────────────────────────────────

fn allowlist(v: &Value) -> Option<Vec<String>> {
    v.as_array().map(|a| {
        a.iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    })
}

fn fixtures(v: &Value) -> Vec<Json> {
    v.as_array().unwrap_or(&[]).iter().map(json_of).collect()
}

/// Answers one `copyIntel.*` call.
pub fn handle(cx: &Cx<'_>, call: &str) -> Result<Json, RunError> {
    let input = &cx.ctx.input;
    match call {
        "policy" => Ok(policy()),
        "buildStats" => {
            let list = allowlist(input.get("leaderAllowlist"));
            let stats = build_leader_stats(
                &fixtures(input.get("fixtures")),
                cx.now_of("now"),
                input.get("copyPlane").as_str(),
                list.as_deref(),
                &cx.ports.copy_leader_plane,
            );
            match stats {
                Stats::Ok {
                    built,
                    skipped_incomplete,
                } => {
                    let stats: Vec<(String, Json)> = built
                        .iter()
                        .map(|b| (b.leader_id.clone(), b.stat.clone()))
                        .collect();
                    let audit: Vec<(String, Json)> =
                        built.into_iter().map(|b| (b.leader_id, b.audit)).collect();
                    let (stats, audit) = ordered(&stats, &audit);
                    output_checked(Json::obj([
                        ("status", Json::str("ok")),
                        ("stats", stats),
                        ("audit", audit),
                        ("skippedIncomplete", count(skipped_incomplete)),
                        ("presentation", presentation()),
                    ]))
                }
                Stats::Other(answer) => Ok(answer),
            }
        }
        "presentDirectory" => Ok(present_directory(input)),
        "runSession" => {
            let list = allowlist(input.get("leaderAllowlist"));
            let run = RunInput {
                plane: input.get("plane").as_str().unwrap_or(""),
                fixtures: fixtures(input.get("fixtures")),
                allowlist: list.as_deref(),
                now: cx.now_of("now"),
                rank_by: None,
            };
            run_session(
                || cx.x(),
                cx.user(),
                cx.fee_asset_id(),
                &run,
                cx.ports.copy_leaders.as_deref(),
                &cx.ports.copy_leader_plane,
            )
        }
        _ => Err(RunError::Trpc(crate::door::not_ported(cx.ctx.call.slice))),
    }
}

// ── The metered run ────────────────────────────────────────────────────────

/// `CopyLeaderFixturesPort`: svc-trade's live leader fixtures.
pub trait LeaderFixtures: Send + Sync {
    /// `sample()`: the rows as svc-trade sent them (unchecked, as the TypeScript takes them), or why not.
    fn sample(&self) -> Result<Vec<Json>, String>;
}

/// `readLiveLeaderFixtures`: the port's rows; no port, a failure or no row is none.
fn live_fixtures(port: Option<&dyn LeaderFixtures>) -> Option<Vec<Json>> {
    port?.sample().ok().filter(|rows| !rows.is_empty())
}

/// What `runCopyIntelStatsSession` is handed past its runtime, user and fee asset.
pub struct RunInput<'a> {
    /// `live` or `dark`.
    pub plane: &'a str,
    /// The caller's rows; a live run reads the port's instead.
    pub fixtures: Vec<Json>,
    pub allowlist: Option<&'a [String]>,
    pub now: Instant,
    /// `rankBy`: the router never passes one.
    pub rank_by: Option<&'a str>,
}

/// The run's refusal: its reason, then the two counts.
fn run_refusal(reason: &str, fixtures: usize, writes: usize) -> Json {
    Json::obj([
        ("status", Json::str("refuse")),
        ("reason", Json::str(reason)),
        ("userMessageKey", Json::str(UNAVAILABLE_KEY)),
        ("fixturesRefusedByGuardrail", count(fixtures)),
        ("writesRefusedByGuardrail", count(writes)),
    ])
}

/// `refuseReturnsRankedMarketingBoard(rankBy)`.
fn returns_board_refused(rank_by: &str) -> RunError {
    RunError::Agent(denied(
        "agents.refused",
        UNAVAILABLE_KEY,
        format!(
            "Returns-ranked marketing board refused (rankBy={rank_by}) — D26-P1-A5 / SPEC-SOVEREIGN §4; audited stats only, never sort by PnL or win rate"
        ),
        vec![
            pair("reason", Json::str(RETURNS_RANKED_BOARD_REFUSE_REASON)),
            pair("rankBy", Json::str(rank_by)),
        ],
    ))
}

/// `runCopyIntelStatsSession` with the router's shaping: the free refusals before any session (a returns sort, the
/// dark plane, a live plane with no live rows or no sealed allowlist, no rows), then each row read through
/// `trade.copy.leaders.read`, the pure build, each audited stat written through `trade.copy.stats.write`, settled and
/// closed on every path. `rt` is asked for the runtime only once a session opens.
pub fn run_session<'a>(
    rt: impl FnOnce() -> Result<Rt<'a>, RunError>,
    user_id: &str,
    asset_id: &str,
    input: &RunInput<'_>,
    port: Option<&dyn LeaderFixtures>,
    live: &LivePlane,
) -> Result<Json, RunError> {
    let free = |answer: Json| -> Result<Json, RunError> {
        Ok(super::with_field(answer, "metering", unmetered(asset_id)))
    };
    if let Some(rank_by) = input.rank_by
        && is_forbidden_returns_rank_key(rank_by)
    {
        return Err(returns_board_refused(rank_by));
    }
    if input.plane == "dark" {
        return free(run_refusal("copy_plane_dark", 0, 0));
    }
    let rows = if input.plane == "live" {
        let Some(rows) = live_fixtures(port) else {
            return free(run_refusal("no_live_leaders", 0, 0));
        };
        if !live.allowlisted(input.allowlist) {
            return free(run_refusal("no_live_leaders", 0, 0));
        }
        rows
    } else if input.fixtures.is_empty() {
        return free(empty());
    } else {
        input.fixtures.clone()
    };

    let x = rt()?;
    let answer = metered_run(&x, user_id, AGENT_ID, asset_id, |session_id| {
        let call = |tool: &'static str, row: Json| {
            act(
                &x,
                &ActInput {
                    session_id,
                    tool,
                    ..ActInput::default()
                },
                move || Ok(row),
            )
        };
        let mut accepted = Vec::new();
        let mut fixtures_refused = 0;
        for row in &rows {
            match call(LEADERS_TOOL, row.clone()) {
                Ok(a) => accepted.push(a.result),
                Err(e) if is_refused(&e) => fixtures_refused += 1,
                Err(e) => return Err(e),
            }
        }
        if accepted.is_empty() {
            return Ok(run_refusal("no_live_leaders", fixtures_refused, 0));
        }
        let (built, skipped) = match build_leader_stats(
            &accepted,
            input.now,
            Some(input.plane),
            input.allowlist,
            live,
        ) {
            Stats::Ok {
                built,
                skipped_incomplete,
            } => (built, skipped_incomplete),
            Stats::Other(answer) => return Ok(answer),
        };
        let mut written: Vec<(String, Json)> = Vec::new();
        let mut writes_refused = 0;
        for b in &built {
            match call(STATS_WRITE_TOOL, b.audit.clone()) {
                Ok(a) => {
                    let id = a
                        .result
                        .get("leaderId")
                        .and_then(json_str)
                        .unwrap_or("")
                        .to_owned();
                    written.push((id, a.result));
                }
                Err(e) if is_refused(&e) => writes_refused += 1,
                Err(e) => return Err(e),
            }
        }
        if written.is_empty() {
            return Ok(run_refusal(
                "writes_refused",
                fixtures_refused,
                writes_refused,
            ));
        }
        let stats: Vec<(String, Json)> = built
            .iter()
            .filter(|b| written.iter().any(|(id, _)| *id == b.leader_id))
            .map(|b| (b.leader_id.clone(), b.stat.clone()))
            .collect();
        let (stats, audit) = ordered(&stats, &written);
        Ok(Json::Object(vec![
            pair("status", Json::str("ok")),
            pair("stats", stats),
            pair("audit", audit),
            pair("skippedIncomplete", count(skipped)),
            pair("fixturesAccepted", count(accepted.len())),
            pair("fixturesRefusedByGuardrail", count(fixtures_refused)),
            pair("writesRefusedByGuardrail", count(writes_refused)),
            pair("presentation", presentation()),
        ]))
    })?;
    output_checked(answer)
}

// ── The live port ──────────────────────────────────────────────────────────

/// `TRADE_COPY_LEADER_FIXTURES_PATH`.
pub const FIXTURES_PATH: &str = "/internal/agents/copy-leader-fixtures";

/// `createHttpCopyLeaderFixturesPort`: svc-trade's `GET /internal/agents/copy-leader-fixtures`, signed as svc-agents
/// for svc-trade. A failed send, a signing failure, a non-2xx, a body that is not JSON or not `{ ok: true, fixtures:
/// [...] }` is no rows, never invented ones.
pub struct LeaderFixturesHttp {
    pub trade_url: String,
    pub signer: CallSigner,
    pub fetch: std::sync::Arc<dyn Fetch>,
}

impl LeaderFixturesHttp {
    pub fn new(
        trade_url: &str,
        signer: CallSigner,
        fetch: std::sync::Arc<dyn Fetch>,
    ) -> LeaderFixturesHttp {
        LeaderFixturesHttp {
            trade_url: trade_url.strip_suffix('/').unwrap_or(trade_url).to_owned(),
            signer,
            fetch,
        }
    }
}

/// `new URL(url).pathname`, for the URL this port builds (a base and a fixed path).
fn pathname(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let path = rest.find('/').map_or("/", |i| rest.get(i..).unwrap_or("/"));
    path.split(['?', '#']).next().unwrap_or(path)
}

impl LeaderFixtures for LeaderFixturesHttp {
    fn sample(&self) -> Result<Vec<Json>, String> {
        let url = format!("{}{FIXTURES_PATH}", self.trade_url);
        let mut headers = vec![("accept".to_owned(), "application/json".to_owned())];
        match self.signer.sign("", "GET", pathname(&url), "") {
            Ok(signed) => headers.extend(signed),
            Err(_) => return Ok(Vec::new()),
        }
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
        let Ok(body) = json::parse(&res.body) else {
            return Ok(Vec::new());
        };
        let body = Value::from_json(&body);
        match (body.get("ok"), body.get("fixtures")) {
            (Value::Bool(true), Value::Array(rows)) => Ok(rows.iter().map(json_of).collect()),
            _ => Ok(Vec::new()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plane(open: Option<&str>, ids: Option<&str>) -> LivePlane {
        LivePlane::from_lookup(|k| match k {
            "LIVE_TRADE_COPY_LEADER_PLANE_OPEN" => open.map(str::to_owned),
            "LIVE_TRADE_COPY_LEADER_IDS" => ids.map(str::to_owned),
            _ => None,
        })
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    /// `live-leader-plane-refuse.test.ts`: closed unless the owner opens it with a sealed list the caller stays inside.
    #[test]
    fn the_live_plane_opens_only_on_the_owners_sealed_list() {
        assert!(!plane(None, None).allowlisted(Some(&ids(&["a"]))));
        assert!(!plane(Some("true"), None).allowlisted(Some(&ids(&["a"]))));
        assert!(!plane(Some("TRUE"), Some("a")).allowlisted(Some(&ids(&["a"]))));
        assert!(!plane(Some("true"), Some(" , ")).allowlisted(Some(&ids(&["a"]))));
        let open = plane(Some(" true "), Some(" a , b ,"));
        assert_eq!(open.ids, ids(&["a", "b"]));
        assert!(open.allowlisted(Some(&ids(&["a"]))));
        assert!(open.allowlisted(Some(&ids(&["b", "a"]))));
        assert!(!open.allowlisted(Some(&ids(&["a", "fake"]))));
        assert!(!open.allowlisted(Some(&[])));
        assert!(!open.allowlisted(None));
    }

    fn row(id: &str, start: &str, end: &str) -> Json {
        json::parse(&format!(
            r#"{{"leaderId":"{id}","realisedPnl":"1","closedTrades":3,"winningTrades":1,"windowStart":"{start}","windowEnd":"{end}","source":"s"}}"#
        ))
        .unwrap()
    }

    /// The open plane: the build runs on the allowlisted rows only, the others counted as skipped.
    #[test]
    fn an_open_plane_builds_from_the_allowlisted_rows() {
        let open = plane(Some("true"), Some("a,b"));
        let rows = [
            row("b", "2026-01-01", "2026-01-02"),
            row("a", "2026-01-01", "2026-01-02"),
            row("c", "2026-01-01", "2026-01-02"),
        ];
        let Stats::Ok {
            built,
            skipped_incomplete,
        } = build_leader_stats(
            &rows,
            Instant(0),
            Some("live"),
            Some(&ids(&["a", "b"])),
            &open,
        )
        else {
            panic!("ok");
        };
        assert_eq!(skipped_incomplete, 1);
        assert_eq!(
            built
                .iter()
                .map(|b| b.leader_id.as_str())
                .collect::<Vec<_>>(),
            ["b", "a"]
        );
        assert_eq!(
            built.first().unwrap().stat.get("winRate"),
            Some(&Json::str("0.3333"))
        );
        assert_eq!(
            build_leader_stats(
                &rows,
                Instant(0),
                Some("live"),
                Some(&ids(&["a", "x"])),
                &open
            ),
            Stats::Other(unavailable("copy_plane_dark"))
        );
    }

    /// A live row whose window is a number is parsed as `Date.parse(String(n))`, and its answer fails the output check.
    #[test]
    fn a_live_row_of_another_type_fails_the_output_check() {
        let mut r = row("a", "2026-01-01", "2026-01-02");
        if let Json::Object(f) = &mut r
            && let Some(slot) = f.iter_mut().find(|(k, _)| k == "windowStart")
        {
            slot.1 = Json::Number(2020.0);
        }
        let Stats::Ok { built, .. } =
            build_leader_stats(&[r], Instant(0), None, None, &LivePlane::default())
        else {
            panic!("ok");
        };
        let answer = Json::obj([(
            "stats",
            Json::Array(built.iter().map(|b| b.stat.clone()).collect()),
        )]);
        assert_eq!(output_checked(answer), Err(output_invalid()));
    }

    #[test]
    fn the_target_signed_is_the_urls_pathname() {
        assert_eq!(pathname("http://trade.test/internal/x"), "/internal/x");
        assert_eq!(
            pathname("http://trade.test/base/internal/x?y=1"),
            "/base/internal/x"
        );
    }

    #[test]
    fn javascript_orders_strings_by_utf16_units() {
        assert_eq!(js_cmp("\u{FF5E}", "\u{1F600}"), Ordering::Greater);
        assert_eq!(js_cmp("B", "a"), Ordering::Less);
    }
}
