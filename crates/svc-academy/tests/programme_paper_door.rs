//! The paper drill calls through the door, ported from the paper `describe`s of `services/svc-academy/src/router.mount.test.ts`
//! ("the paper drill gate is reachable, and refuses live" and "a paper drill produces a labelled simulated result").
//! The calls hold no state, so the door runs over a store that refuses every query: nothing here may reach the database.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

#[path = "prog_support/mod.rs"]
mod support;

use service_kit::json::Json;
use svc_academy::db::Store;
use svc_academy::door::AcademyDoor;
use svc_academy::ports::{PaperFlag, Ports};
use svc_academy::programme::paper::flag::MemoryPaperFlags;

fn listing() -> MemoryPaperFlags {
    MemoryPaperFlags(vec![
        PaperFlag {
            market_id: "mkt-paper-1".to_owned(),
            symbol: "BTC-USDT".to_owned(),
            paper: true,
        },
        PaperFlag {
            market_id: "mkt-live-1".to_owned(),
            symbol: "BTC/USDT".to_owned(),
            paper: false,
        },
    ])
}

/// The door as `index.ts` builds it with `TRADE_URL` set: trade's listing verifies every `paper: true`.
fn door_with(extra: &[(&str, Json)], trade_url: bool) -> AcademyDoor {
    let mut ports = Ports::unwired();
    let mut pairs: Vec<(&str, Json)> = extra.to_vec();
    if trade_url {
        // `index.ts` builds the trade port only when TRADE_URL is set.
        ports.paper_flags = Box::new(listing());
        pairs.push(("TRADE_URL", Json::str("http://svc-trade:4004")));
    }
    support::door_over(
        Store::Down("a paper drill reads no table".to_owned()),
        ports,
        support::settings(&pairs),
    )
}

fn door() -> AcademyDoor {
    door_with(&[], true)
}

fn reader() -> Vec<(String, String)> {
    support::principal(support::OPERATOR, &["academy:read"], true)
}

fn ask(door: &AcademyDoor, path: &str, input: Option<&Json>) -> (u16, Json) {
    support::call(door, &reader(), path, true, input)
}

/// The tRPC code of a refusal.
fn trpc_code(answer: &(u16, Json)) -> String {
    match answer
        .1
        .get("error")
        .and_then(|e| e.get("data"))
        .and_then(|d| d.get("code"))
    {
        Some(Json::String(s)) => s.clone(),
        _ => panic!("not a refusal: {}", answer.1.compact()),
    }
}

fn paper_market() -> Json {
    Json::obj([
        ("marketId", Json::str("mkt-paper-1")),
        ("paper", Json::Bool(true)),
        ("symbol", Json::str("BTC-USDT")),
    ])
}

fn with_field(base: &Json, key: &str, v: Json) -> Json {
    let Json::Object(mut fields) = base.clone() else {
        panic!("not an object")
    };
    fields.retain(|(k, _)| k != key);
    fields.push((key.to_owned(), v));
    Json::Object(fields)
}

fn drill_input(market: Json) -> Json {
    Json::obj([
        ("slug", Json::str("foundations-paper-workbook")),
        ("market", market),
    ])
}

fn get<'a>(j: &'a Json, key: &str) -> &'a Json {
    j.get(key)
        .unwrap_or_else(|| panic!("no {key} in {}", j.compact()))
}

// ── the paper drill gate is reachable, and refuses live ───────────────────────────────────────────────────────────

#[test]
fn returns_the_drill_steps_for_a_workbook_on_a_paper_market() {
    let answer = ask(&door(), "paperDrill", Some(&drill_input(paper_market())));
    let d = support::data(&answer);
    assert_eq!(get(d, "ok"), &Json::Bool(true));
    assert_eq!(get(d, "marketId"), &Json::str("mkt-paper-1"));
    let Json::Array(steps) = get(d, "steps") else {
        panic!()
    };
    assert!(!steps.is_empty());
    for step in steps {
        assert!(matches!(step.get("id"), Some(Json::String(s)) if !s.is_empty()));
        assert!(matches!(step.get("instruction"), Some(Json::String(s)) if !s.is_empty()));
    }
}

#[test]
fn refuses_a_market_trade_did_not_flag_as_paper() {
    let market = with_field(&paper_market(), "paper", Json::Bool(false));
    let answer = ask(&door(), "paperDrill", Some(&drill_input(market)));
    let d = support::data(&answer);
    assert_eq!(get(d, "ok"), &Json::Bool(false));
    assert_eq!(get(d, "reason"), &Json::str("not_paper"));
}

#[test]
fn refuses_when_the_caller_labels_a_live_listing_as_paper() {
    let market = Json::obj([
        ("marketId", Json::str("mkt-live-1")),
        ("paper", Json::Bool(true)),
        ("symbol", Json::str("BTC/USDT")),
    ]);
    let answer = ask(&door(), "paperDrill", Some(&drill_input(market)));
    assert_eq!(trpc_code(&answer), "FORBIDDEN");
    assert_eq!(
        support::cause(&answer).as_deref(),
        Some("academy.paper_flag_mismatch")
    );
}

#[test]
fn refuses_paper_true_when_trade_url_and_the_verification_port_are_unset() {
    let answer = ask(
        &door_with(&[], false),
        "paperDrill",
        Some(&drill_input(paper_market())),
    );
    assert_eq!(trpc_code(&answer), "PRECONDITION_FAILED");
    assert_eq!(
        support::cause(&answer).as_deref(),
        Some("academy.paper_flag_unverified")
    );
}

#[test]
fn refuses_with_no_market_rather_than_defaulting_to_one() {
    let answer = ask(&door(), "paperDrill", Some(&drill_input(Json::Null)));
    let d = support::data(&answer);
    assert_eq!(get(d, "ok"), &Json::Bool(false));
    assert_eq!(get(d, "reason"), &Json::str("no_market"));
}

#[test]
fn refuses_a_catalog_item_that_is_not_a_workbook() {
    let input = Json::obj([
        ("slug", Json::str("foundations-risk-first")),
        ("market", paper_market()),
    ]);
    let answer = ask(&door(), "paperDrill", Some(&input));
    assert_eq!(get(support::data(&answer), "ok"), &Json::Bool(false));
}

#[test]
fn rejects_a_slug_that_is_not_in_the_spine_at_all() {
    let input = Json::obj([
        ("slug", Json::str("no-such-workbook")),
        ("market", paper_market()),
    ]);
    let answer = ask(&door(), "paperDrill", Some(&input));
    assert_eq!(trpc_code(&answer), "NOT_FOUND");
}

#[test]
fn the_ops_kill_refuses_paper_drill_and_live_trade_is_not_involved() {
    let off = door_with(
        &[("ACADEMY_PAPER_TRADING_ENABLED", Json::Bool(false))],
        true,
    );
    let answer = ask(&off, "paperDrill", Some(&drill_input(paper_market())));
    assert_eq!(trpc_code(&answer), "FORBIDDEN");
    assert_eq!(
        support::cause(&answer).as_deref(),
        Some("academy.paper_trading_disabled")
    );
}

#[test]
fn paper_ops_status_reports_enable_live_trade_unaffected_and_real_money_false() {
    let answer = ask(&door(), "paperOpsStatus", None);
    let d = support::data(&answer);
    assert_eq!(
        d,
        &Json::obj([
            ("enabled", Json::Bool(true)),
            ("flagId", Json::str("academy.paper-trading")),
            ("envKey", Json::str("ACADEMY_PAPER_TRADING_ENABLED")),
            ("liveTradeUnaffected", Json::Bool(true)),
            ("simulated", Json::Bool(true)),
            ("venue", Json::str("paper")),
            ("realMoney", Json::Bool(false)),
        ])
    );
    let flat = d.compact();
    assert!(!flat.contains("\"realMoney\":true"));
    assert!(!flat.contains("\"live\":true"));
    let off = door_with(
        &[("ACADEMY_PAPER_TRADING_ENABLED", Json::Bool(false))],
        true,
    );
    let answer = ask(&off, "paperOpsStatus", None);
    assert_eq!(get(support::data(&answer), "enabled"), &Json::Bool(false));
}

#[test]
fn refuses_paper_drill_when_the_body_claims_real_money_or_live() {
    let real = with_field(&drill_input(paper_market()), "realMoney", Json::Bool(true));
    assert_eq!(
        trpc_code(&ask(&door(), "paperDrill", Some(&real))),
        "BAD_REQUEST"
    );
    let live = drill_input(with_field(&paper_market(), "live", Json::Bool(true)));
    assert_eq!(
        trpc_code(&ask(&door(), "paperDrill", Some(&live))),
        "BAD_REQUEST"
    );
}

#[test]
fn a_started_drill_arrives_sealed_so_the_client_has_something_to_badge() {
    let answer = ask(&door(), "paperDrill", Some(&drill_input(paper_market())));
    let d = support::data(&answer);
    assert_eq!(get(d, "ok"), &Json::Bool(true));
    assert_eq!(get(d, "simulated"), &Json::Bool(true));
    assert_eq!(get(d, "venue"), &Json::str("paper"));
    assert_eq!(get(d, "realLedger"), &Json::Bool(false));
    assert_eq!(get(d, "withdrawable"), &Json::Bool(false));
    assert_eq!(get(d, "realMoney"), &Json::Bool(false));
    let Json::String(disclaimer) = get(d, "disclaimer") else {
        panic!()
    };
    assert!(disclaimer.to_lowercase().contains("no value moved"));
}

// ── a paper drill produces a labelled simulated result ─────────────────────────────────────────────────────────────

fn fill(id: &str, market: &str, side: &str, price: Json, size: &str) -> Json {
    Json::obj([
        ("fillId", Json::str(id)),
        ("marketId", Json::str(market)),
        ("side", Json::str(side)),
        ("price", price),
        ("size", Json::str(size)),
    ])
}

fn result_input(over: &[(&str, Json)]) -> Json {
    let mut input = Json::obj([
        ("slug", Json::str("foundations-paper-workbook")),
        ("market", paper_market()),
        ("completedStepIds", Json::Array(Vec::new())),
        ("fills", Json::Array(Vec::new())),
        ("markPrice", Json::Null),
    ]);
    for (k, v) in over {
        input = with_field(&input, k, v.clone());
    }
    input
}

fn drill_result(over: &[(&str, Json)]) -> (u16, Json) {
    ask(&door(), "paperDrillResult", Some(&result_input(over)))
}

#[test]
fn completes_the_workbook_and_values_the_round_trip_from_published_prices() {
    let answer = drill_result(&[
        (
            "completedStepIds",
            Json::Array(vec![
                Json::str("size-from-invalidation"),
                Json::str("limit-cancel"),
                Json::str("prewritten-stop"),
            ]),
        ),
        (
            "fills",
            Json::Array(vec![
                fill("f-1", "mkt-paper-1", "buy", Json::str("100"), "2"),
                fill("f-2", "mkt-paper-1", "sell", Json::str("110"), "2"),
            ]),
        ),
    ]);
    let d = support::data(&answer);
    assert_eq!(get(d, "ok"), &Json::Bool(true));
    let r = get(d, "result");
    assert_eq!(get(r, "status"), &Json::str("complete"));
    assert_eq!(get(r, "complete"), &Json::Bool(true));
    assert_eq!(get(r, "completedCount"), &Json::int(3));
    assert_eq!(get(r, "remainingStepIds"), &Json::Array(Vec::new()));
    let v = get(r, "valuation");
    assert_eq!(get(v, "realisedPnl"), &Json::str("20"));
    assert_eq!(get(v, "totalPnl"), &Json::str("20"));
}

#[test]
fn a_fill_posted_twice_is_valued_once() {
    let answer = drill_result(&[(
        "fills",
        Json::Array(vec![
            fill("f-1", "mkt-paper-1", "buy", Json::str("100"), "2"),
            fill("f-1", "mkt-paper-1", "buy", Json::str("100"), "2"),
        ]),
    )]);
    let v = get(get(support::data(&answer), "result"), "valuation");
    assert_eq!(get(v, "fillCount"), &Json::int(1));
    assert_eq!(get(v, "boughtSize"), &Json::str("2"));
}

#[test]
fn labels_the_result_so_nothing_here_could_be_read_as_a_real_position() {
    let answer = drill_result(&[
        (
            "fills",
            Json::Array(vec![fill(
                "f-1",
                "mkt-paper-1",
                "buy",
                Json::str("100"),
                "2",
            )]),
        ),
        ("markPrice", Json::str("115")),
    ]);
    let d = support::data(&answer);
    assert_eq!(get(d, "simulated"), &Json::Bool(true));
    assert_eq!(get(d, "venue"), &Json::str("paper"));
    assert_eq!(get(d, "realLedger"), &Json::Bool(false));
    assert_eq!(get(d, "withdrawable"), &Json::Bool(false));
    assert_eq!(get(d, "realMoney"), &Json::Bool(false));
    let Json::String(disclaimer) = get(d, "disclaimer") else {
        panic!()
    };
    assert!(disclaimer.to_lowercase().contains("withdrawable"));
    let flat = d.compact();
    assert!(flat.contains("\"simulated\":true"));
    assert!(flat.contains("\"withdrawable\":false"));
    assert!(flat.contains("\"realMoney\":false"));
    for banned in [
        "ledgerTxId",
        "idempotencyKey",
        "availableBalance",
        "holdAmount",
    ] {
        assert!(!flat.contains(banned), "{banned}");
    }
}

#[test]
fn refuses_a_result_body_that_claims_live_money_on_the_wire() {
    assert_eq!(
        trpc_code(&drill_result(&[("realMoney", Json::Bool(true))])),
        "BAD_REQUEST"
    );
    let live_fill = with_field(
        &fill("f-1", "mkt-paper-1", "buy", Json::str("1"), "1"),
        "live",
        Json::Bool(true),
    );
    assert_eq!(
        trpc_code(&drill_result(&[("fills", Json::Array(vec![live_fill]))])),
        "BAD_REQUEST"
    );
}

#[test]
fn refuses_a_live_market_so_a_result_is_never_produced_off_a_real_book() {
    let market = with_field(&paper_market(), "paper", Json::Bool(false));
    let answer = drill_result(&[("market", market)]);
    let d = support::data(&answer);
    assert_eq!(get(d, "ok"), &Json::Bool(false));
    assert_eq!(get(d, "reason"), &Json::str("not_paper"));
}

#[test]
fn refuses_a_result_when_the_caller_labels_a_live_listing_as_paper() {
    let market = Json::obj([
        ("marketId", Json::str("mkt-live-1")),
        ("paper", Json::Bool(true)),
        ("symbol", Json::str("BTC/USDT")),
    ]);
    assert_eq!(trpc_code(&drill_result(&[("market", market)])), "FORBIDDEN");
}

#[test]
fn refuses_with_no_market_rather_than_picking_one() {
    let answer = drill_result(&[("market", Json::Null)]);
    assert_eq!(
        get(support::data(&answer), "reason"),
        &Json::str("no_market")
    );
}

#[test]
fn refuses_a_step_the_workbook_does_not_have() {
    let answer = drill_result(&[(
        "completedStepIds",
        Json::Array(vec![Json::str("step-i-made-up")]),
    )]);
    assert_eq!(
        get(support::data(&answer), "reason"),
        &Json::str("unknown_step")
    );
}

#[test]
fn refuses_a_fill_from_another_market() {
    let answer = drill_result(&[(
        "fills",
        Json::Array(vec![fill(
            "f-1",
            "mkt-somewhere-else",
            "buy",
            Json::str("1"),
            "1",
        )]),
    )]);
    assert_eq!(
        get(support::data(&answer), "reason"),
        &Json::str("bad_fill")
    );
}

#[test]
fn rejects_a_price_sent_as_a_json_number() {
    let answer = drill_result(&[(
        "fills",
        Json::Array(vec![fill("f-1", "mkt-paper-1", "buy", Json::int(100), "1")]),
    )]);
    assert_eq!(trpc_code(&answer), "BAD_REQUEST");
}

#[test]
fn rejects_a_fill_with_no_price_at_all_rather_than_valuing_it_at_zero() {
    let no_price = Json::obj([
        ("fillId", Json::str("f-1")),
        ("marketId", Json::str("mkt-paper-1")),
        ("side", Json::str("buy")),
        ("size", Json::str("1")),
    ]);
    assert_eq!(
        trpc_code(&drill_result(&[("fills", Json::Array(vec![no_price]))])),
        "BAD_REQUEST"
    );
}

#[test]
fn reports_an_unmarked_open_position_as_unmarked_instead_of_inventing_the_mark() {
    let answer = drill_result(&[(
        "fills",
        Json::Array(vec![fill(
            "f-1",
            "mkt-paper-1",
            "buy",
            Json::str("100"),
            "2",
        )]),
    )]);
    let v = get(get(support::data(&answer), "result"), "valuation");
    assert_eq!(get(v, "openSize"), &Json::str("2"));
    assert_eq!(get(v, "unrealisedPnl"), &Json::Null);
    assert_eq!(get(v, "totalPnl"), &Json::Null);
    assert_eq!(get(v, "markUnavailable"), &Json::Bool(true));
}

#[test]
fn rejects_a_slug_that_is_not_in_the_spine() {
    assert_eq!(
        trpc_code(&drill_result(&[("slug", Json::str("no-such-workbook"))])),
        "NOT_FOUND"
    );
}

#[test]
fn the_ops_kill_refuses_the_result_surface_too() {
    let off = door_with(
        &[("ACADEMY_PAPER_TRADING_ENABLED", Json::Bool(false))],
        true,
    );
    let answer = ask(&off, "paperDrillResult", Some(&result_input(&[])));
    assert_eq!(trpc_code(&answer), "FORBIDDEN");
}

#[test]
fn is_refused_outright_without_the_academy_read_scope() {
    let no_scope = support::principal(support::OPERATOR, &[], true);
    let answer = support::call(
        &door(),
        &no_scope,
        "paperDrillResult",
        true,
        Some(&result_input(&[])),
    );
    assert_ne!(answer.0, 200);
}
