//! The tournament calls through the door, as the app calls them, on real Postgres; and the pins the TypeScript keeps
//! by reading its own source (`tournaments/wire-tx-atomic.test.ts`, `tournaments/tournaments.policy-route.test.ts`,
//! `season-standings-sql-limit-unset.test.ts`, `list-remaining-sql-lists-limit-unset.test.ts` for `listSeasons`, and
//! `tournaments/tournament-compose-pin.test.ts`), held here to the Rust source that replaced it.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

#[path = "prog_support/mod.rs"]
mod support;

use service_kit::json::Json;
use support::{OPERATOR, call, cause, data, message, operator, principal, settings};
use svc_academy::ports::{Ports, StubApprovals};

const ALICE: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const BOB: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const APPROVER: &str = "33333333-3333-4333-8333-333333333333";

fn approved() -> Ports {
    let mut p = Ports::unwired();
    p.approvals = Box::new(StubApprovals(APPROVER.to_owned()));
    p
}

fn with_approval(fields: Vec<(&str, Json)>) -> Json {
    let mut all: Vec<(String, Json)> = fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect();
    all.push(("approvalId".to_owned(), Json::str("approval-1")));
    all.push(("operationId".to_owned(), Json::str("operation-1")));
    Json::Object(all)
}

fn s(v: &str) -> Json {
    Json::str(v)
}

fn str_at<'a>(j: &'a Json, key: &str) -> &'a str {
    match j.get(key) {
        Some(Json::String(v)) => v,
        other => panic!("{key}: {other:?} in {}", j.compact()),
    }
}

fn read(path: &str) -> String {
    std::fs::read_to_string(format!("{}/{path}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

macro_rules! needs_postgres {
    () => {
        match support::TestDb::new() {
            Some(db) => db,
            None => {
                eprintln!("skipped: no TEST_DATABASE_URL");
                return;
            }
        }
    };
}

#[test]
fn a_season_runs_its_whole_life_through_the_door() {
    let db = needs_postgres!();
    let door = db.door(approved(), settings(&[]));
    let op = operator();

    let created = call(
        &door,
        &op,
        "createSeason",
        false,
        Some(&with_approval(vec![
            ("slug", s("  Spring-Ladder ")),
            ("title", s("  Spring ladder  ")),
            ("rulesSummary", s("Rank by score. No prizes.")),
            ("startsAt", s("2026-01-01T00:00:00.000Z")),
            ("endsAt", Json::Null),
        ])),
    );
    let season = data(&created).clone();
    let keys: Vec<&str> = match &season {
        Json::Object(f) => f.iter().map(|(k, _)| k.as_str()).collect(),
        _ => panic!(),
    };
    assert_eq!(
        keys,
        [
            "id",
            "slug",
            "title",
            "status",
            "rulesSummary",
            "startsAt",
            "endsAt",
            "confirmOperatorId"
        ]
    );
    assert_eq!(str_at(&season, "slug"), "spring-ladder");
    assert_eq!(str_at(&season, "title"), "Spring ladder");
    assert_eq!(str_at(&season, "status"), "scheduled");
    assert_eq!(str_at(&season, "startsAt"), "2026-01-01T00:00:00.000Z");
    assert_eq!(season.get("endsAt"), Some(&Json::Null));
    assert_eq!(str_at(&season, "confirmOperatorId"), APPROVER);
    let id = str_at(&season, "id").to_owned();

    // Reads.
    let reader = principal(OPERATOR, &["academy:read"], false);
    let listed = call(
        &door,
        &reader,
        "seasons",
        true,
        Some(&Json::obj([("limit", Json::int(10))])),
    );
    assert_eq!(
        data(&listed),
        &Json::Array(vec![{
            let mut f = match &season {
                Json::Object(f) => f.clone(),
                _ => panic!(),
            };
            f.pop();
            Json::Object(f)
        }])
    );
    let none_live = call(
        &door,
        &reader,
        "seasons",
        true,
        Some(&Json::obj([
            ("status", s("live")),
            ("limit", Json::int(10)),
        ])),
    );
    assert_eq!(data(&none_live), &Json::Array(vec![]));
    let unset = call(&door, &reader, "seasons", true, None);
    assert_eq!(unset.0, 412);
    assert_eq!(
        cause(&unset).as_deref(),
        Some("academy.seasons_list_limit_unset")
    );

    // A standing refuses while scheduled.
    let early = call(
        &door,
        &op,
        "setStanding",
        false,
        Some(&with_approval(vec![
            ("seasonId", s(&id)),
            ("userId", s(ALICE)),
            ("score", Json::int(5)),
        ])),
    );
    assert_eq!(early.0, 409);
    assert_eq!(cause(&early).as_deref(), Some("academy.season_not_live"));

    let live = call(
        &door,
        &op,
        "setSeasonStatus",
        false,
        Some(&with_approval(vec![
            ("seasonId", s(&id)),
            ("status", s("live")),
        ])),
    );
    assert_eq!(str_at(data(&live), "status"), "live");

    let set = call(
        &door,
        &op,
        "setStanding",
        false,
        Some(&with_approval(vec![
            ("seasonId", s(&id)),
            ("userId", s(ALICE)),
            ("score", Json::int(5)),
        ])),
    );
    let standing = data(&set);
    assert_eq!(standing.get("score"), Some(&Json::int(5)));
    assert_eq!(str_at(standing, "confirmOperatorId"), APPROVER);

    let bulk = call(
        &door,
        &op,
        "bulkSetStandings",
        false,
        Some(&with_approval(vec![
            ("seasonId", s(&id)),
            (
                "patches",
                Json::Array(vec![
                    Json::obj([("userId", s(BOB)), ("score", Json::int(9))]),
                    Json::obj([("userId", s(ALICE)), ("score", Json::int(7))]),
                ]),
            ),
        ])),
    );
    let ok = data(&bulk);
    assert_eq!(ok.get("ok"), Some(&Json::Bool(true)));
    assert_eq!(ok.get("accepted"), Some(&Json::int(2)));
    assert_eq!(str_at(ok, "statusLine"), "ok=1 accepted=2 refused=0");

    let dup = call(
        &door,
        &op,
        "bulkSetStandings",
        false,
        Some(&with_approval(vec![
            ("seasonId", s(&id)),
            (
                "patches",
                Json::Array(vec![
                    Json::obj([("userId", s(BOB)), ("score", Json::int(1))]),
                    Json::obj([("userId", s(BOB)), ("score", Json::int(2))]),
                ]),
            ),
        ])),
    );
    assert_eq!(
        data(&dup).compact(),
        format!(
            "{{\"ok\":false,\"reason\":\"duplicate_user\",\"message\":\"Duplicate userId {BOB}\",\"statusLine\":\"ok=0 accepted=0 refused=1 reason=duplicate_user\",\"badUserId\":\"{BOB}\",\"confirmOperatorId\":\"{APPROVER}\"}}"
        )
    );

    let board = call(
        &door,
        &reader,
        "standings",
        true,
        Some(&Json::obj([("seasonId", s(&id)), ("limit", Json::int(10))])),
    );
    let rows = match data(&board) {
        Json::Array(r) => r.clone(),
        other => panic!("{other:?}"),
    };
    assert_eq!(rows.len(), 2);
    assert_eq!(str_at(&rows[0], "userId"), BOB);
    assert_eq!(rows[0].get("rank"), Some(&Json::int(1)));
    assert_eq!(str_at(&rows[1], "userId"), ALICE);
    let no_limit = call(
        &door,
        &reader,
        "standings",
        true,
        Some(&Json::obj([("seasonId", s(&id))])),
    );
    assert_eq!(no_limit.0, 412);
    assert_eq!(
        cause(&no_limit).as_deref(),
        Some("academy.standings_limit_unset")
    );

    // The calendar, at a given time and now.
    let at = call(
        &door,
        &reader,
        "seasonCalendar",
        true,
        Some(&Json::obj([
            ("seasonId", s(&id)),
            ("at", s("2025-06-01T00:00:00.000Z")),
        ])),
    );
    assert_eq!(
        data(&at).compact(),
        format!(
            "{{\"seasonId\":\"{id}\",\"status\":\"live\",\"startsAt\":\"2026-01-01T00:00:00.000Z\",\"endsAt\":null,\"openAt\":\"2025-06-01T00:00:00.000Z\",\"inWindow\":false,\"scoreWindowOpen\":false}}"
        )
    );
    let now = call(
        &door,
        &reader,
        "seasonCalendar",
        true,
        Some(&Json::obj([("seasonId", s(&id))])),
    );
    assert_eq!(data(&now).get("scoreWindowOpen"), Some(&Json::Bool(true)));

    // Freeze through the door, and its audit.
    let admin = principal(OPERATOR, &["admin:read"], false);
    let before = call(
        &door,
        &admin,
        "freezeSnapshot",
        true,
        Some(&Json::obj([("seasonId", s(&id))])),
    );
    assert_eq!(data(&before), &Json::Null);
    let frozen = call(
        &door,
        &op,
        "setSeasonStatus",
        false,
        Some(&with_approval(vec![
            ("seasonId", s(&id)),
            ("status", s("frozen")),
        ])),
    );
    assert_eq!(str_at(data(&frozen), "status"), "frozen");
    let snap = call(
        &door,
        &admin,
        "freezeSnapshot",
        true,
        Some(&Json::obj([("seasonId", s(&id))])),
    );
    let snap = data(&snap);
    assert_eq!(str_at(snap, "seasonId"), id);
    let standings = match snap.get("standings") {
        Some(Json::Array(r)) => r.clone(),
        other => panic!("{other:?}"),
    };
    let keys: Vec<&str> = match &standings[0] {
        Json::Object(f) => f.iter().map(|(k, _)| k.as_str()).collect(),
        _ => panic!(),
    };
    assert_eq!(keys, ["rank", "userId", "score", "updatedAt"]);
    assert_eq!(str_at(&standings[0], "userId"), BOB);
    assert_eq!(standings[0].get("score"), Some(&Json::int(9)));

    // frozen → live is closed.
    let reopen = call(
        &door,
        &op,
        "setSeasonStatus",
        false,
        Some(&with_approval(vec![
            ("seasonId", s(&id)),
            ("status", s("live")),
        ])),
    );
    assert_eq!(reopen.0, 400);
    assert_eq!(cause(&reopen).as_deref(), Some("academy.season_invalid"));

    // A missing season.
    let missing = call(
        &door,
        &reader,
        "season",
        true,
        Some(&Json::obj([(
            "seasonId",
            s("99999999-9999-4999-8999-999999999999"),
        )])),
    );
    assert_eq!(missing.0, 404);
    assert_eq!(cause(&missing).as_deref(), Some("academy.season_not_found"));
}

#[test]
fn a_write_without_an_approval_refuses_before_anything_is_stored() {
    let db = needs_postgres!();
    let door = db.door(approved(), settings(&[]));
    let answer = call(
        &door,
        &operator(),
        "createSeason",
        false,
        Some(&Json::obj([
            ("slug", s("no-approval")),
            ("title", s("No approval")),
            ("rulesSummary", s("Rank by score. No prizes.")),
            ("startsAt", s("2026-01-01T00:00:00.000Z")),
        ])),
    );
    assert_eq!(answer.0, 412);
    assert_eq!(cause(&answer).as_deref(), Some("action_approval.missing"));
    let n: i64 = db
        .client()
        .query_one("SELECT count(*) FROM academy.tournament_seasons", &[])
        .unwrap()
        .get(0);
    assert_eq!(n, 0);
    // Unwired identity: nobody approves.
    let unwired = db.door(Ports::unwired(), settings(&[]));
    let answer = call(
        &unwired,
        &operator(),
        "createSeason",
        false,
        Some(&with_approval(vec![
            ("slug", s("no-approver")),
            ("title", s("No approver")),
            ("rulesSummary", s("Rank by score. No prizes.")),
            ("startsAt", s("2026-01-01T00:00:00.000Z")),
        ])),
    );
    assert_eq!(answer.0, 412);
    assert_eq!(cause(&answer).as_deref(), Some("action_approval.unwired"));
}

#[test]
fn the_ladder_switched_off_refuses_every_season_call() {
    let db = needs_postgres!();
    let door = db.door(
        approved(),
        settings(&[("ACADEMY_TOURNAMENT_ENABLED", Json::Bool(false))]),
    );
    let reader = principal(OPERATOR, &["academy:read"], false);
    let list = call(
        &door,
        &reader,
        "seasons",
        true,
        Some(&Json::obj([("limit", Json::int(5))])),
    );
    assert_eq!(list.0, 403);
    assert_eq!(cause(&list).as_deref(), Some("academy.tournament_disabled"));
    let create = call(
        &door,
        &operator(),
        "createSeason",
        false,
        Some(&with_approval(vec![
            ("slug", s("off-ladder")),
            ("title", s("Off ladder")),
            ("rulesSummary", s("Rank by score. No prizes.")),
            ("startsAt", s("2026-01-01T00:00:00.000Z")),
        ])),
    );
    assert_eq!(
        cause(&create).as_deref(),
        Some("academy.tournament_disabled")
    );
    // The honesty board and the prize plane still answer.
    let policy = call(&door, &[], "tournaments.policy", true, None);
    assert_eq!(data(&policy).get("movesMoney"), Some(&Json::Bool(false)));
}

#[test]
fn a_duplicate_slug_is_a_plain_failure_and_a_bad_title_refuses() {
    let db = needs_postgres!();
    let door = db.door(approved(), settings(&[]));
    let create = |slug: &str, title: &str| {
        call(
            &door,
            &operator(),
            "createSeason",
            false,
            Some(&with_approval(vec![
                ("slug", s(slug)),
                ("title", s(title)),
                ("rulesSummary", s("Rank by score. No prizes.")),
                ("startsAt", s("2026-01-01T00:00:00.000Z")),
            ])),
        )
    };
    assert_eq!(create("dup-slug", "First").0, 200);
    let again = create("dup-slug", "Second");
    assert_eq!(again.0, 500);
    assert_eq!(message(&again), "Request failed");
    assert_eq!(cause(&again).as_deref(), Some("23505"));
    // Three characters before the trim, two after.
    let short = create("short-title", " ab ");
    assert_eq!(short.0, 400);
    assert_eq!(cause(&short).as_deref(), Some("academy.season_invalid"));
    let bad_slug = create("a_b", "Bad slug");
    assert_eq!(cause(&bad_slug).as_deref(), Some("academy.season_invalid"));
}

#[test]
fn the_prize_calls_refuse_closed_on_the_wire() {
    let db = needs_postgres!();
    let door = db.door(approved(), settings(&[]));
    let op = operator();
    let unset = call(
        &door,
        &op,
        "tournamentPrizeStart",
        false,
        Some(&Json::obj([])),
    );
    assert_eq!(unset.0, 412);
    assert_eq!(cause(&unset).as_deref(), Some("academy.prize_pool_unset"));
    assert_eq!(
        message(&unset),
        "IFC prize pool is unset — blank pool cannot start; refuse-closed (no invent IFC amounts)"
    );
    let set = call(
        &door,
        &op,
        "tournamentPrizeStart",
        false,
        Some(&Json::obj([(
            "prizePool",
            Json::obj([("amount", s("100.00"))]),
        )])),
    );
    assert_eq!(set.0, 412);
    assert_eq!(cause(&set).as_deref(), Some("academy.prize_refuse_closed"));
    let intent = call(
        &door,
        &op,
        "tournamentPrizeIntent",
        false,
        Some(&Json::obj([("kind", s("payout"))])),
    );
    assert_eq!(data(&intent).get("kind"), Some(&s("payout")));
    assert_eq!(data(&intent).get("ok"), Some(&Json::Bool(false)));
    let plane = call(&door, &op, "tournamentPrizePlane", true, None);
    assert_eq!(data(&plane).get("prizesEnabled"), Some(&Json::Bool(false)));
    let n: i64 = db
        .client()
        .query_one("SELECT count(*) FROM academy.tournament_seasons", &[])
        .unwrap()
        .get(0);
    assert_eq!(n, 0);
}

// ── Source pins ──────────────────────────────────────────────────────────────────────────────────────────────────

/// The body of `fn <name>(` in `src`: from its first `{` to the matching `}`.
fn fn_body<'a>(src: &'a str, name: &str) -> &'a str {
    let start = src
        .find(&format!("fn {name}("))
        .unwrap_or_else(|| panic!("fn {name} not found"));
    let open = start + src[start..].find('{').unwrap();
    let mut depth = 0;
    for (i, c) in src[open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &src[open..=open + i];
                }
            }
            _ => {}
        }
    }
    panic!("fn {name}: unclosed body");
}

/// `wire-tx-atomic.test.ts`: the bulk write upserts in one transaction under the season lock, re-gated there.
#[test]
fn bulk_set_standings_upserts_under_one_transaction_and_the_season_lock() {
    let src = read("src/programme/tournaments/service.rs");
    let body = fn_body(&src, "bulk_set_standings");
    assert!(
        body.contains("self.transaction("),
        "bulk writes must run inside the transaction"
    );
    assert!(
        body.contains("select_season(tx, season_id, true)"),
        "the season row must be locked before the upserts"
    );
    assert!(
        body.matches("validate_bulk_score_write").count() >= 2,
        "re-gate under the lock so a freeze cannot interleave"
    );
    assert!(
        !body.contains("self.set_standing("),
        "upserts in the transaction, not a set_standing loop"
    );
    assert!(body.contains("upsert_standing(tx"));
    let select = fn_body(&src, "select_season");
    assert!(select.contains(" FOR UPDATE"));
    assert!(fn_body(&src, "upsert_standing").contains("INSERT INTO academy.tournament_standings"));
}

/// `wire-tx-atomic.test.ts`: live → frozen writes the snapshot and flips the status in one transaction, in that order.
#[test]
fn the_freeze_writes_snapshot_and_status_in_one_transaction_under_the_lock() {
    let src = read("src/programme/tournaments/service.rs");
    let set = fn_body(&src, "set_season_status");
    assert!(set.contains("self.transaction(|tx| self.freeze(tx, season_id))"));
    let body = fn_body(&src, "freeze");
    let lock = body.find("select_season(tx, season_id, true)").unwrap();
    let snap = body.find("tournament_freeze_snapshots").unwrap();
    let status = body.find("SET status = 'frozen'").unwrap();
    assert!(body.contains("AND status = 'live'"));
    assert!(lock < snap && snap < status);
}

/// `tournaments.policy-route.test.ts`: the public honesty board is mounted from `describe_tournament_policy`.
#[test]
fn the_router_mounts_the_public_policy_from_describe_tournament_policy() {
    let router = read("src/programme/tournaments/mod.rs");
    assert!(
        router.contains("\"tournaments.policy\" => Ok(Some(policy::describe_tournament_policy()))")
    );
    assert!(!router.contains("\"tournamentPolicy\""));
    let calls = read("src/door/calls.rs");
    let at = calls.find("path: \"tournaments.policy\"").unwrap();
    assert!(calls[at..at + 200].contains("access: Access::Public"));
}

/// `season-standings-sql-limit-unset.test.ts` and `list-remaining-sql-lists-limit-unset.test.ts`: the SQL dumps take
/// the published limit and never invent one.
#[test]
fn the_season_and_standings_sql_take_the_published_limit() {
    let src = read("src/programme/tournaments/service.rs");
    let standings = fn_body(&src, "standings");
    assert!(standings.contains("season_standings_limit(limit)?"));
    assert!(standings.contains("LIMIT $2::int8"));
    assert!(standings.contains("ORDER BY score DESC, updated_at ASC"));
    let seasons = fn_body(&src, "list_seasons");
    assert!(seasons.contains("seasons_list_limit(limit)?"));
    assert!(seasons.matches("LIMIT $").count() == 2);
    for body in [standings, seasons] {
        for invented in ["unwrap_or(50", "unwrap_or(100", "unwrap_or(200"] {
            assert!(!body.contains(invented));
        }
    }
    let router = read("src/programme/tournaments/mod.rs");
    for call in ["\"seasons\" =>", "\"standings\" =>"] {
        let at = router.find(call).unwrap();
        let arm = &router[at..at + 400];
        assert!(arm.contains("input.get(\"limit\").as_number()"), "{call}");
        assert!(!arm.contains("unwrap_or(50"), "{call}");
    }
}

/// `tournament-compose-pin.test.ts`: the compose stack hands the tournament switch to svc-academy, default on, once.
#[test]
fn compose_passes_the_tournament_switch_to_svc_academy() {
    let env = read("src/env.rs");
    assert!(env.contains("o.switch(\"ACADEMY_TOURNAMENT_ENABLED\");"));
    let switch = fn_body(&env, "switch");
    assert!(switch.contains("is_none_or"), "an unset switch is on");

    let compose = read("../../docker-compose.apps.yml");
    // The service's block: its own line and every line after it until the next key at its depth or above.
    let block: String = compose
        .lines()
        .skip_while(|l| *l != "  svc-academy:")
        .enumerate()
        .take_while(|(i, l)| {
            *i == 0 || l.trim().is_empty() || l.starts_with("   ") || l.starts_with("  #")
        })
        .map(|(_, l)| format!("{l}\n"))
        .collect();
    assert!(
        block.starts_with("  svc-academy:"),
        "the svc-academy service"
    );
    assert!(block.contains("SERVICE_NAME: svc-academy"));
    assert!(block.contains("ACADEMY_TOURNAMENT_ENABLED: ${ACADEMY_TOURNAMENT_ENABLED:-true}"));
    let hits = compose
        .lines()
        .filter(|l| l.trim_start().starts_with("ACADEMY_TOURNAMENT_ENABLED:"))
        .count();
    assert_eq!(
        hits, 1,
        "ACADEMY_TOURNAMENT_ENABLED must appear once (svc-academy only)"
    );
    assert!(!block.contains("ACADEMY_TOURNAMENT_ENABLED: ${ACADEMY_TOURNAMENT_ENABLED:-false}"));
    assert!(block.contains("ACADEMY_STREAM_PROVIDER: ${ACADEMY_STREAM_PROVIDER:-none}"));
    assert!(block.contains("ACADEMY_MAX_ROOM_CAPACITY: ${ACADEMY_MAX_ROOM_CAPACITY:-}"));
    assert!(
        block.contains("ACADEMY_PAPER_TRADING_ENABLED: ${ACADEMY_PAPER_TRADING_ENABLED:-true}")
    );
    let upper = block.to_uppercase();
    assert!(!upper.contains("PRIZE_POOL") && !upper.contains("PAPER_BALANCE"));
}
