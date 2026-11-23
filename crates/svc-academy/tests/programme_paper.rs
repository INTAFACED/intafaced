//! The paper drills' pure rules, ported from `services/svc-academy/src/paper/*.test.ts` (workbook-loop, simulated-result,
//! real-money-ban, ops-gate, cert-progress-hook) and the paper cases of `list-limit-unset.test.ts`. Each test keeps
//! its TypeScript counterpart's name and assertions.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::float_cmp,
    reason = "a test: a failure is the point"
)]

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::time::Instant;
use svc_academy::errors::Refusal;
use svc_academy::programme::paper::ban::{
    PAPER_REAL_MONEY_BANNED_KEYS, assert_paper_input_never_claims_live,
    assert_paper_never_readable_as_real_money, is_paper_real_money_banned_key,
};
use svc_academy::programme::paper::cert_hook::{
    CertDefinition, ItemCompletionRecord, PaperCertProgressView, record_paper_cert_item_progress,
};
use svc_academy::programme::paper::ops::{
    PAPER_OPS_ENV_KEY, PAPER_OPS_FLAG_ID, is_paper_ops_enabled, paper_ops_disabled_message,
    paper_ops_status,
};
use svc_academy::programme::paper::simulated::{
    PublishedFill, SIMULATED_DISCLAIMER, assert_sealed_simulated, is_sealed_simulated,
    is_valuation_complete, seal_fields, seal_simulated, simulated_label_line, simulated_seal,
    simulated_total_pnl_or_refuse, simulated_valuation_line, value_simulated_drill,
};
use svc_academy::programme::paper::workbook::*;

fn code(r: &Refusal) -> String {
    match r {
        Refusal::Academy(e) => e.code.clone(),
        other => panic!("not an AcademyError: {other:?}"),
    }
}

fn message(r: &Refusal) -> String {
    match r {
        Refusal::Academy(e) => e.message.clone(),
        other => panic!("not an AcademyError: {other:?}"),
    }
}

fn market(id: &str, paper: bool, symbol: &str) -> PaperMarketRef {
    PaperMarketRef {
        market_id: id.to_owned(),
        paper,
        symbol: symbol.to_owned(),
    }
}

fn start(id: &str, symbol: &str) -> DrillRun {
    start_paper_drill(
        "foundations-paper-workbook",
        Some(&market(id, true, symbol)),
        None,
    )
    .unwrap()
}

fn s(v: &str) -> Value {
    Value::String(v.to_owned())
}

fn fill(id: &str, market_id: &str, side: Value, price: Value, size: Value) -> FillIn {
    FillIn {
        fill_id: id.to_owned(),
        market_id: market_id.to_owned(),
        recorded_at: None,
        side,
        price,
        size,
    }
}

// ── workbook-loop.test.ts: paper Stage-2 workbook loop ──────────────────────────────────────────────────────────────

#[test]
fn refuses_live_market_fail_closed() {
    let r = start_paper_drill(
        "foundations-paper-workbook",
        Some(&market("m1", false, "BTC/USDT")),
        None,
    );
    assert_eq!(r.unwrap_err().reason, RefuseReason::NotPaper);
}

#[test]
fn refuses_missing_market() {
    let r = start_paper_drill("foundations-paper-workbook", None, None);
    assert_eq!(r.unwrap_err().reason, RefuseReason::NoMarket);
}

#[test]
fn completes_steps_idempotently_on_paper_market() {
    let mut run = start("p1", "PAPER/USD");
    assert!(run.fill_refs.is_empty());
    for step in run.steps.clone() {
        run = complete_drill_step(&run, &step.id).unwrap();
        let again = complete_drill_step(&run, &step.id).unwrap();
        assert_eq!(
            again
                .completed_step_ids
                .iter()
                .filter(|id| **id == step.id)
                .count(),
            1
        );
    }
    assert_eq!(run.status, DrillStatus::Complete);
}

#[test]
fn unknown_step_refuses_invent_progress() {
    let run = start("p1", "PAPER/USD");
    assert_eq!(
        complete_drill_step(&run, "not-a-step").unwrap_err().reason,
        RefuseReason::UnknownStep
    );
}

#[test]
fn refuses_non_workbook_catalog_kinds() {
    let r = start_paper_drill_for_catalog_item(
        "foundations-risk-first",
        Some("playbook"),
        Some(&market("p1", true, "PAPER/USD")),
        None,
    );
    assert!(r.is_err());
}

#[test]
fn attach_paper_fill_ref_accepts_trade_fill_ids_only_no_invent_empty() {
    let run = start("p1", "PAPER/USD");
    let bad = attach_paper_fill_ref(&run, &FillIn::bare("  ", "p1"));
    assert_eq!(bad.unwrap_err().reason, RefuseReason::BadFill);
    assert!(attach_paper_fill_ref(&run, &FillIn::bare("f-1", "other")).is_err());
    let ok = attach_paper_fill_ref(&run, &FillIn::bare("f-1", "p1")).unwrap();
    let ids: Vec<&str> = list_paper_fill_refs(&ok)
        .iter()
        .map(|f| f.fill_id.as_str())
        .collect();
    assert_eq!(ids, ["f-1"]);
    let again = attach_paper_fill_ref(&ok, &FillIn::bare("f-1", "p1")).unwrap();
    assert_eq!(again.fill_refs.len(), 1);
    // A bare ref carries no amount and no price: money stays on trade.
    assert_eq!(list_paper_fill_refs(&ok)[0].price, None);
}

#[test]
fn attach_paper_fill_ref_refuses_same_fill_id_with_a_conflicting_body() {
    let run = start("p1", "PAPER/USD");
    let first =
        attach_paper_fill_ref(&run, &fill("f-1", "p1", s("buy"), s("100"), s("1"))).unwrap();
    let conflict = attach_paper_fill_ref(&first, &fill("f-1", "p1", s("buy"), s("999"), s("1")));
    assert_eq!(conflict.unwrap_err().reason, RefuseReason::BadFill);
    assert_eq!(list_paper_fill_refs(&first).len(), 1);
    let same =
        attach_paper_fill_ref(&first, &fill("f-1", "p1", s("buy"), s("100"), s("1"))).unwrap();
    assert_eq!(same.fill_refs.len(), 1);
}

#[test]
fn l3_drill_progress_reports_ratio_without_invent_complete() {
    let run = start("p1", "PAPER/USD");
    let p0 = drill_progress(&run);
    assert_eq!(p0.completed_count, 0);
    assert_eq!(p0.ratio, "0.0000");
    let next = complete_drill_step(&run, &run.steps[0].id).unwrap();
    let p1 = drill_progress(&next);
    assert_eq!(p1.completed_count, 1);
    assert!(p1.ratio.parse::<f64>().unwrap() > 0.0);
    assert_eq!(p1.status, DrillStatus::Active);
    // 1/3 as JavaScript's toFixed(4) writes it.
    assert_eq!(p1.ratio, "0.3333");
}

#[test]
fn l3_remaining_step_ids_and_is_drill_complete_without_invent_steps() {
    let start_run = start("p1", "PAPER/USD");
    assert_eq!(remaining_step_ids(&start_run).len(), start_run.steps.len());
    assert!(!is_drill_complete(&start_run));
    let mut run = start_run.clone();
    for step in &start_run.steps {
        run = complete_drill_step(&run, &step.id).unwrap();
    }
    assert!(remaining_step_ids(&run).is_empty());
    assert!(is_drill_complete(&run));
}

#[test]
fn l3_completed_step_count_tracks_progress_without_invent() {
    let steps = [
        DrillStep {
            id: "s1".to_owned(),
            instruction: "one".to_owned(),
        },
        DrillStep {
            id: "s2".to_owned(),
            instruction: "two".to_owned(),
        },
    ];
    let run =
        start_paper_drill("wb", Some(&market("p1", true, "PAPER/USD")), Some(&steps)).unwrap();
    assert_eq!(completed_step_count(&run), 0);
    let mid = complete_drill_step(&run, "s1").unwrap();
    assert_eq!(completed_step_count(&mid), 1);
}

#[test]
fn l3_fill_ref_count_zero_without_invent() {
    assert_eq!(fill_ref_count(&start("p1", "PAPER/USD")), 0);
}

#[test]
fn l3_wave25_refused_progress_step_counts() {
    assert!(
        start_paper_drill(
            "foundations-paper-workbook",
            Some(&market("m1", false, "BTC/USDT")),
            None
        )
        .is_err()
    );
    let run = start("m1", "BTC/USDT");
    assert!(!is_drill_refused(&run));
    assert_eq!(total_step_count(&run), run.steps.len());
    assert_eq!(remaining_step_count(&run), run.steps.len());
    assert!(is_drill_in_progress(&run));
}

#[test]
fn l3_wave26_status_flags_completion_ratio_market_id() {
    let run = start("m-w26", "BTC/USDT");
    assert!(is_drill_status_active(&run));
    assert!(!is_drill_status_complete(&run));
    assert_eq!(drill_completion_ratio(&run), "0.0000");
    assert_eq!(drill_market_id(&run), "m-w26");
}

#[test]
fn l3_wave27_fill_refs_symbol_slug_partial_progress() {
    let run = start("m-w27", "ETH/USDT");
    assert!(has_no_fill_refs(&run));
    assert_eq!(drill_symbol(&run), "ETH/USDT");
    assert_eq!(drill_workbook_slug(&run), "foundations-paper-workbook");
    assert!(!has_partial_progress(&run));
    let mid = complete_drill_step(&run, &run.steps[0].id).unwrap();
    assert!(has_partial_progress(&mid));
}

#[test]
fn l3_wave28_fill_refs_remaining_ends_ratio_number() {
    let run = start("m-w28", "BTC/USDT");
    assert!(!has_fill_refs(&run));
    assert_eq!(first_remaining_step_id(&run), Some(run.steps[0].id.clone()));
    assert_eq!(
        last_remaining_step_id(&run),
        Some(run.steps[run.steps.len() - 1].id.clone())
    );
    assert_eq!(drill_completion_ratio_number(&run), 0.0);
}

#[test]
fn l3_wave29_completed_ends_remaining_empty_step_list() {
    let run = start("m-w29", "BTC/USDT");
    assert_eq!(first_completed_step_id(&run), None);
    assert_eq!(last_completed_step_id(&run), None);
    assert!(!has_no_remaining_steps(&run));
    assert!(!is_step_list_empty(&run));
    let step = run.steps[0].id.clone();
    let mid = complete_drill_step(&run, &step).unwrap();
    assert_eq!(first_completed_step_id(&mid), Some(step.clone()));
    assert_eq!(last_completed_step_id(&mid), Some(step));
}

#[test]
fn l3_wave30_untouched_percent_remaining_ratio() {
    let run = start("m-w30", "BTC/USDT");
    assert!(is_drill_untouched(&run));
    assert!(!is_drill_fully_ratioed(&run));
    assert_eq!(drill_completion_percent(&run), 0.0);
    assert_eq!(remaining_step_ratio(&run), "1.0000");
}

#[test]
fn l3_wave31_step_fill_count_labels() {
    let run = start("m-w31", "BTC/USDT");
    assert_eq!(total_step_count_label(&run), run.steps.len().to_string());
    assert_eq!(completed_step_count_label(&run), "0");
    assert_eq!(
        remaining_step_count_label(&run),
        run.steps.len().to_string()
    );
    assert_eq!(fill_ref_count_label(&run), "0");
}

#[test]
fn l3_wave32_step_joins_status_ratio_labels() {
    let run = start("m-w32", "BTC/USDT");
    assert_eq!(
        remaining_step_ids_joined(&run)
            .split(',')
            .filter(|s| !s.is_empty())
            .count(),
        run.steps.len()
    );
    assert_eq!(completed_step_ids_joined(&run), "");
    assert_eq!(drill_status_label(&run), "active");
    assert_eq!(drill_ratio_label(&run), "0.0000");
}

#[test]
fn l3_wave33_drill_identity_labels() {
    let run = start("m-w33", "SOL/USDT");
    assert_eq!(drill_market_id_label(&run), "m-w33");
    assert_eq!(drill_symbol_label(&run), "SOL/USDT");
    assert_eq!(
        drill_workbook_slug_label(&run),
        "foundations-paper-workbook"
    );
    assert_eq!(drill_completion_percent_label(&run), "0");
}

#[test]
fn l3_wave34_drill_snapshots_fresh_active() {
    let run = start("m-w34", "BTC/USDT");
    assert_eq!(drill_progress_snapshot(&run).percent, 0.0);
    assert!(drill_step_counts_consistent(&run));
    assert_eq!(drill_identity_snapshot(&run).market_id, "m-w34");
    assert!(is_fresh_active_drill(&run));
}

#[test]
fn l3_wave36_drill_board_card_step_bar() {
    let run = start("m-w36", "BTC/USDT");
    assert!(drill_board_card(&run).fresh);
    assert!(drill_card_is_fresh(&run));
    assert!(!drill_card_is_refused(&run));
    assert_eq!(drill_step_bar(&run).percent, 0.0);
}

#[test]
fn l3_wave37_drill_step_filter_match() {
    let run = start("m-w37", "BTC/USDT");
    assert!(filter_remaining_step_ids(&run, "").is_empty());
    assert!(remaining_steps_match(&run, "size"));
    assert!(!completed_steps_match(&run, "size"));
    let step = run.steps[0].id.clone();
    let mid = complete_drill_step(&run, &step).unwrap();
    assert!(filter_completed_step_ids(&mid, &step[..3]).contains(&step));
}

#[test]
fn l3_wave38_drill_step_paging() {
    let run = start("m-w38", "BTC/USDT");
    let page = PageOptions {
        offset: Some(0.0),
        limit: Value::Number(1.0),
    };
    assert_eq!(page_remaining_step_ids(&run, &page).unwrap().len(), 1);
    assert_eq!(remaining_steps_page_count(&run, 1.0), run.steps.len());
    assert_eq!(
        reverse_remaining_step_ids(&run)[0],
        run.steps[run.steps.len() - 1].id
    );
    assert!(
        page_completed_step_ids(&run, &PageOptions::limit(5.0))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn l3_wave39_drill_compare() {
    let a = start("m-w39a", "BTC/USDT");
    let b = start("m-w39b", "ETH/USDT");
    assert!(drills_same_status(&a, &b));
    assert_eq!(drill_percent_delta(&a, &b), 0.0);
    let step = a.steps[0].id.clone();
    let a2 = complete_drill_step(&a, &step).unwrap();
    assert!(completed_steps_only_left(&a2, &b).contains(&step));
    assert!(remaining_steps_only_left(&b, &a2).contains(&step));
}

#[test]
fn l3_wave40_drill_remaining_safe_paging() {
    let run = start("m-w40", "BTC/USDT");
    assert_eq!(safe_page_remaining_step_ids(&run, 0.0, 1.0).len(), 1);
    assert_eq!(
        clamp_remaining_steps_page_index(&run, 99.0, 1.0),
        run.steps.len() - 1
    );
    assert_eq!(remaining_step_ids_at_page(&run, 0.0, 1.0).len(), 1);
    assert!(is_valid_remaining_steps_page(&run, 0.0, 1.0));
}

#[test]
fn l3_wave41_drill_steps_export() {
    let run = start("m-w41", "BTC/USDT");
    assert_eq!(drill_steps_export_header(), "stepId,state");
    assert_eq!(remaining_steps_export_lines(&run).len(), run.steps.len());
    assert!(completed_steps_export_lines(&run).is_empty());
    assert!(drill_steps_export_text(&run).contains("remaining"));
}

#[test]
fn l3_wave42_drill_steps_export_parse_round_trip() {
    assert_eq!(parse_drill_steps_export_line("stepId,state"), None);
    assert_eq!(
        parse_drill_steps_export_line("s1,remaining"),
        Some(DrillStepsExportRow {
            step_id: "s1".to_owned(),
            state: "remaining"
        })
    );
    let run = start("m-w42", "BTC/USDT");
    let text = drill_steps_export_text(&run);
    assert!(drill_steps_export_has_header(&text));
    assert_eq!(count_drill_steps_export_data_lines(&text), run.steps.len());
    assert!(drill_steps_export_round_trip_ok(&run));
}

#[test]
fn l3_wave44_drill_status_lines() {
    let run = start("m-w44", "BTC/USDT");
    assert!(drill_status_line_is_fresh(&run));
    assert!(drill_status_line(&run).contains("percent=0"));
    assert!(drill_status_line_detailed(&run).contains("workbook="));
    assert!(drill_status_line_token_count(&run) > 4);
}

#[test]
fn l3_wave45_drill_status_parse_match() {
    let run = start("m-w45", "BTC/USDT");
    assert!(drill_status_line_matches(&run));
    assert!(drill_status_line_consistent(&drill_status_line(&run)));
    assert_eq!(
        parse_drill_status_line_detailed(&drill_status_line_detailed(&run)).map(|p| p.market),
        Some("m-w45".to_owned())
    );
}

#[test]
fn l3_wave46_drill_thresholds_clamps() {
    let run = start("m-w46", "BTC/USDT");
    assert!(remaining_step_count_in_range(&run, 1.0, 10.0));
    assert!(drill_percent_at_least(&run, 0.0));
    assert_eq!(clamp_remaining_steps_page_size(&run, 99.0), run.steps.len());
    assert!(fill_count_at_most(&run, 0.0));
}

// ── a drill cannot be projected without saying it is simulated ─────────────────────────────────────────────────────

#[test]
fn the_run_itself_carries_it_so_every_projection_reads_it_from_one_place() {
    let run = start("m-label", "BTC/USDT");
    assert!(run.simulated);
    assert!(drill_board_card(&run).simulated);
    assert!(!drill_board_card(&run).real_money);
    assert!(!drill_step_bar(&run).real_money);
    assert!(!drill_progress(&run).real_money);
}

#[test]
fn both_status_lines_lead_with_simulated_and_real_money_0() {
    let run = start("m-label", "BTC/USDT");
    assert!(drill_status_line(&run).starts_with("simulated=1 realMoney=0 "));
    assert!(drill_status_line_detailed(&run).starts_with("simulated=1 realMoney=0 "));
}

#[test]
fn a_status_line_with_the_label_stripped_no_longer_parses() {
    let run = start("m-label", "BTC/USDT");
    let stripped = drill_status_line(&run).replacen("simulated=1 ", "", 1);
    let no_real_money = drill_status_line(&run).replacen(" realMoney=0", "", 1);
    assert_eq!(parse_drill_status_line(&stripped), None);
    assert_eq!(parse_drill_status_line(&no_real_money), None);
    assert!(!drill_status_line_consistent(&stripped));
    assert_eq!(
        parse_drill_status_line_detailed(&drill_status_line_detailed(&run).replacen(
            "simulated=1 ",
            "",
            1
        )),
        None
    );
}

#[test]
fn an_export_leads_with_the_label_and_still_round_trips_its_rows() {
    let run = start("m-label", "BTC/USDT");
    let text = drill_steps_export_text(&run);
    assert!(drill_steps_export_is_labelled(&text));
    let first = text.split('\n').next().unwrap();
    assert!(first.contains("simulated=1"));
    assert!(first.contains("realMoney=0"));
    assert!(drill_steps_export_has_header(&text));
    assert!(drill_steps_export_round_trip_ok(&run));
    // The label is a comment, not a row.
    assert_eq!(count_drill_steps_export_data_lines(&text), run.steps.len());
}

// ── replayPaperDrill: the loop is reachable end to end, and still refuses ──────────────────────────────────────────

fn replay_market() -> PaperMarketRef {
    market("m-replay", true, "BTC/USDT")
}

fn replay(kind: &str, m: &PaperMarketRef, steps: &[&str], fills: &[FillIn]) -> DrillResult {
    let steps: Vec<String> = steps.iter().map(|s| (*s).to_owned()).collect();
    replay_paper_drill(
        "foundations-paper-workbook",
        Some(kind),
        Some(m),
        &steps,
        fills,
        None,
    )
}

#[test]
fn walks_a_workbook_to_complete() {
    let ids: Vec<String> = foundations_paper_steps()
        .into_iter()
        .map(|s| s.id)
        .collect();
    let ids: Vec<&str> = ids.iter().map(String::as_str).collect();
    let run = replay("workbook", &replay_market(), &ids, &[]).unwrap();
    assert_eq!(run.status, DrillStatus::Complete);
    assert!(is_drill_complete(&run));
    assert!(run.simulated);
}

#[test]
fn attaches_trade_published_fills_keeping_the_decimal_strings_intact() {
    let run = replay(
        "workbook",
        &replay_market(),
        &[],
        &[fill("f-1", "m-replay", s("buy"), s("0.1"), s("3"))],
    )
    .unwrap();
    let f = &run.fill_refs[0];
    assert_eq!(f.fill_id, "f-1");
    assert_eq!(f.side.as_deref(), Some("buy"));
    assert_eq!(f.price.as_deref(), Some("0.1"));
    assert_eq!(f.size.as_deref(), Some("3"));
}

#[test]
fn refuses_a_live_market_before_replaying_anything() {
    let live = market("m-replay", false, "BTC/USDT");
    assert_eq!(
        replay("workbook", &live, &["size-from-invalidation"], &[])
            .unwrap_err()
            .reason,
        RefuseReason::NotPaper
    );
}

#[test]
fn replay_refuses_a_non_workbook_catalog_kind() {
    assert!(replay("playbook", &replay_market(), &[], &[]).is_err());
}

#[test]
fn a_refusal_part_way_through_is_the_result_of_the_whole_replay() {
    assert_eq!(
        replay(
            "workbook",
            &replay_market(),
            &["size-from-invalidation", "not-a-step"],
            &[]
        )
        .unwrap_err()
        .reason,
        RefuseReason::UnknownStep
    );
}

#[test]
fn replay_refuses_each_bad_fill() {
    let cases = [
        (
            "a price sent as a number",
            fill("f-1", "m-replay", s("buy"), Value::Number(100.0), s("1")),
        ),
        (
            "a size sent as a number",
            fill("f-1", "m-replay", s("buy"), s("100"), Value::Number(1.0)),
        ),
        (
            "a negative price",
            fill("f-1", "m-replay", s("buy"), s("-1"), s("1")),
        ),
        (
            "an unreadable price",
            fill("f-1", "m-replay", s("buy"), s("1e5"), s("1")),
        ),
        (
            "a side that is neither",
            fill("f-1", "m-replay", s("hodl"), s("1"), s("1")),
        ),
        (
            "another market",
            fill("f-1", "m-elsewhere", s("buy"), s("1"), s("1")),
        ),
    ];
    for (why, bad) in cases {
        let r = replay("workbook", &replay_market(), &[], &[bad]);
        assert_eq!(r.unwrap_err().reason, RefuseReason::BadFill, "{why}");
    }
}

#[test]
fn a_bad_fill_names_why_in_the_typescripts_words() {
    let run = start("p1", "PAPER/USD");
    let msg = |f: FillIn| attach_paper_fill_ref(&run, &f).unwrap_err().message;
    assert_eq!(
        msg(fill("f-1", "p1", s("buy"), Value::Number(1.0), s("1"))),
        "Fill f-1: price must be a decimal string, got number."
    );
    assert_eq!(
        msg(fill("f-1", "p1", s("buy"), s("  "), s("1"))),
        "Fill f-1: price must not be blank."
    );
    assert_eq!(
        msg(fill("f-1", "p1", s("buy"), s("1"), s(" 1e5 "))),
        "Fill f-1: size \"1e5\" is not a non-negative decimal string."
    );
    assert_eq!(
        msg(fill("f-1", "p1", Value::Number(1.0), s("1"), s("1"))),
        "Fill f-1: side must be \"buy\" or \"sell\"."
    );
    assert_eq!(
        msg(FillIn::bare(&"x".repeat(129), "p1")),
        "fillId required (1–128 chars) — no invent fill."
    );
    assert_eq!(
        msg(FillIn::bare("f", " ")),
        "marketId required on fill ref."
    );
    assert_eq!(
        msg(FillIn::bare("f", "q")),
        "Fill market q does not match drill market p1"
    );
}

#[test]
fn js_number_semantics_of_the_projections() {
    // Ties in toFixed go to the larger (1/32 = 0.03125), and Math.round ties toward +infinity.
    assert_eq!(to_fixed(0.031_25, 4), "0.0313");
    assert_eq!(to_fixed(2.0 / 3.0, 4), "0.6667");
    assert_eq!(to_fixed(1.0, 4), "1.0000");
    assert_eq!(js_round(2.5), 3.0);
    assert_eq!(js_round(-2.5), -2.0);
    assert_eq!(js_round(33.33), 33.0);
}

// ── list-limit-unset.test.ts: the paper drill pages ────────────────────────────────────────────────────────────────

fn unset_options() -> Vec<PageOptions> {
    let limit = |v: Value| PageOptions {
        offset: None,
        limit: v,
    };
    vec![
        PageOptions::none(),
        PageOptions::none(),
        PageOptions {
            offset: Some(0.0),
            limit: Value::Undefined,
        },
        limit(Value::Undefined),
        limit(Value::Null),
        limit(Value::Number(f64::NAN)),
        limit(Value::Number(f64::INFINITY)),
        limit(Value::Number(0.0)),
        limit(Value::Number(-1.0)),
        limit(Value::String("nope".to_owned())),
    ]
}

#[test]
fn paper_drill_page_ids_refuse_omit_null_0_negative_garbage() {
    let run = start_paper_drill(
        "foundations-paper-workbook",
        Some(&market("p1", true, "PAPER/USD")),
        None,
    )
    .unwrap();
    for options in unset_options() {
        assert!(page_remaining_step_ids(&run, &options).is_err());
        assert!(page_completed_step_ids(&run, &options).is_err());
    }
    let e = page_remaining_step_ids(&run, &PageOptions::none()).unwrap_err();
    assert_eq!(code(&e), "academy.paper_list_limit_unset");
}

#[test]
fn paper_drill_published_limit_slices() {
    let run = start("p1", "PAPER/USD");
    let all = page_remaining_step_ids(&run, &PageOptions::limit(10.0)).unwrap();
    assert_eq!(all.len(), 3);
    let two = page_remaining_step_ids(
        &run,
        &PageOptions {
            offset: Some(0.0),
            limit: Value::Number(2.0),
        },
    )
    .unwrap();
    assert_eq!(two, all[..2]);
    assert!(
        page_completed_step_ids(&run, &PageOptions::limit(5.0))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn source_does_not_invent_all_length_when_limit_is_omitted() {
    let src = include_str!("../src/programme/paper/workbook.rs");
    assert!(!src.contains("unwrap_or(all.len())"));
    assert!(!src.contains("limit ?? all.length"));
}

// ── simulated-result.test.ts ───────────────────────────────────────────────────────────────────────────────────────

fn pf(id: &str, side: &str, price: &str, size: &str) -> PublishedFill {
    PublishedFill {
        fill_id: id.to_owned(),
        market_id: "mkt-paper-1".to_owned(),
        side: s(side),
        price: s(price),
        size: s(size),
    }
}

fn academy_code(r: &Result<impl std::fmt::Debug, Refusal>) -> String {
    match r {
        Err(e) => code(e),
        Ok(v) => panic!("expected a refusal, got {v:?}"),
    }
}

#[test]
fn seals_a_payload_with_all_four_assertions_and_the_full_disclaimer() {
    let sealed = seal_simulated(Json::obj([("realisedPnl", Json::str("12.5"))]));
    assert_eq!(sealed.get("simulated"), Some(&Json::Bool(true)));
    assert_eq!(sealed.get("venue"), Some(&Json::str("paper")));
    assert_eq!(sealed.get("realLedger"), Some(&Json::Bool(false)));
    assert_eq!(sealed.get("withdrawable"), Some(&Json::Bool(false)));
    assert_eq!(sealed.get("realMoney"), Some(&Json::Bool(false)));
    assert_eq!(
        sealed.get("disclaimer"),
        Some(&Json::str(SIMULATED_DISCLAIMER))
    );
    assert_eq!(
        sealed.get("result"),
        Some(&Json::obj([("realisedPnl", Json::str("12.5"))]))
    );
}

#[test]
fn the_disclaimer_says_all_three_things_a_reader_needs() {
    let d = SIMULATED_DISCLAIMER.to_lowercase();
    assert!(d.contains("no value moved"));
    assert!(d.contains("no ledger entry"));
    assert!(d.contains("withdrawable"));
}

fn with(over: &[(&str, Option<Json>)], result: bool) -> Json {
    let mut fields = seal_fields();
    for (k, v) in over {
        fields.retain(|(key, _)| key != k);
        if let Some(v) = v {
            fields.push(((*k).to_owned(), v.clone()));
        }
    }
    if result {
        fields.push(("result".to_owned(), Json::Object(Vec::new())));
    }
    Json::Object(fields)
}

#[test]
fn refuses_to_let_a_result_through_with_any_part_of_the_seal_missing() {
    let cases = [
        (
            "no seal at all",
            Json::obj([("result", Json::obj([("realisedPnl", Json::str("12.5"))]))]),
        ),
        ("simulated stripped", with(&[("simulated", None)], true)),
        (
            "simulated flipped to false",
            with(&[("simulated", Some(Json::Bool(false)))], true),
        ),
        (
            "venue claimed as live",
            with(&[("venue", Some(Json::str("live")))], true),
        ),
        (
            "realLedger claimed true",
            with(&[("realLedger", Some(Json::Bool(true)))], true),
        ),
        (
            "withdrawable claimed true",
            with(&[("withdrawable", Some(Json::Bool(true)))], true),
        ),
        (
            "realMoney claimed true",
            with(&[("realMoney", Some(Json::Bool(true)))], true),
        ),
        (
            "disclaimer blanked",
            with(&[("disclaimer", Some(Json::str("")))], true),
        ),
        ("payload missing entirely", with(&[], false)),
    ];
    for (why, payload) in cases {
        assert!(!is_sealed_simulated(&payload), "{why}");
        assert_eq!(
            academy_code(&assert_sealed_simulated(payload)),
            "academy.paper_result_unlabelled",
            "{why}"
        );
    }
}

#[test]
fn lets_a_properly_sealed_result_through_unchanged() {
    let sealed = seal_simulated(Json::obj([("ok", Json::Bool(true))]));
    assert_eq!(assert_sealed_simulated(sealed.clone()).unwrap(), sealed);
}

#[test]
fn the_label_survives_being_copied_into_a_log_line() {
    assert_eq!(
        simulated_label_line(),
        "simulated=1 venue=paper realLedger=0 withdrawable=0 realMoney=0"
    );
}

#[test]
fn values_a_round_trip_at_the_published_prices() {
    let v = value_simulated_drill(
        &[
            pf("f-1", "buy", "100", "2"),
            pf("f-2", "sell", "110", "2"),
            pf("f-1", "buy", "100", "2"),
        ],
        None,
    )
    .unwrap();
    assert_eq!(v.fill_count, 2);
    assert_eq!(v.bought_size, "2");
    assert_eq!(v.sold_size, "2");
    assert_eq!(v.open_size, "0");
    assert_eq!(v.average_buy_price.as_deref(), Some("100"));
    assert_eq!(v.average_sell_price.as_deref(), Some("110"));
    assert_eq!(v.realised_pnl, "20");
    assert_eq!(v.unrealised_pnl.as_deref(), Some("0"));
    assert_eq!(v.total_pnl.as_deref(), Some("20"));
    assert!(!v.mark_unavailable);
    assert!(is_valuation_complete(&v));
    // The nested seal: the valuation alone still cannot look like live money.
    let j = v.json();
    assert_eq!(j.get("simulated"), Some(&Json::Bool(true)));
    assert_eq!(j.get("realLedger"), Some(&Json::Bool(false)));
    assert_eq!(j.get("withdrawable"), Some(&Json::Bool(false)));
    assert_eq!(j.get("realMoney"), Some(&Json::Bool(false)));
    assert_eq!(j.get("venue"), Some(&Json::str("paper")));
}

#[test]
fn averages_several_buys_at_their_own_published_prices() {
    let v = value_simulated_drill(
        &[
            pf("f-1", "buy", "100", "1"),
            pf("f-2", "buy", "120", "1"),
            pf("f-3", "sell", "130", "2"),
        ],
        None,
    )
    .unwrap();
    assert_eq!(v.average_buy_price.as_deref(), Some("110"));
    assert_eq!(v.realised_pnl, "40");
}

#[test]
fn refuses_the_same_fill_id_published_twice_with_conflicting_trade_data() {
    let r = value_simulated_drill(
        &[pf("f-1", "buy", "100", "1"), pf("f-1", "buy", "200", "1")],
        None,
    );
    assert_eq!(academy_code(&r), "academy.paper_price_unavailable");
}

#[test]
fn carries_decimals_no_float_could() {
    let v = value_simulated_drill(
        &[pf("f-1", "buy", "0.1", "1"), pf("f-2", "buy", "0.2", "1")],
        None,
    )
    .unwrap();
    assert_eq!(v.average_buy_price.as_deref(), Some("0.15"));
}

#[test]
fn a_loss_is_reported_as_a_loss_signed() {
    let v = value_simulated_drill(
        &[pf("f-1", "buy", "100", "3"), pf("f-2", "sell", "90", "3")],
        None,
    )
    .unwrap();
    assert_eq!(v.realised_pnl, "-30");
}

#[test]
fn a_drill_with_no_fills_at_all_is_flat_not_an_error() {
    let v = value_simulated_drill(&[], None).unwrap();
    assert_eq!(v.fill_count, 0);
    assert_eq!(v.realised_pnl, "0");
    assert_eq!(v.total_pnl.as_deref(), Some("0"));
    assert_eq!(v.average_buy_price, None);
}

#[test]
fn refuses_to_value_a_fill_rather_than_guessing() {
    let base = pf("f-1", "buy", "100", "2");
    let set = |f: &dyn Fn(&mut PublishedFill)| {
        let mut x = base.clone();
        f(&mut x);
        x
    };
    let cases = [
        ("a missing price", set(&|x| x.price = Value::Undefined)),
        ("a blank price", set(&|x| x.price = s("   "))),
        (
            "a price sent as a number",
            set(&|x| x.price = Value::Number(100.0)),
        ),
        (
            "a size sent as a number",
            set(&|x| x.size = Value::Number(2.0)),
        ),
        ("a negative price", set(&|x| x.price = s("-100"))),
        (
            "an unreadable price",
            set(&|x| x.price = s("about a hundred")),
        ),
        ("no side", set(&|x| x.side = Value::Undefined)),
    ];
    for (why, bad) in cases {
        let r = value_simulated_drill(&[bad], None);
        let Err(e) = r else { panic!("{why}: valued") };
        assert_eq!(code(&e), "academy.paper_price_unavailable", "{why}");
        assert!(message(&e).to_lowercase().contains("invent"), "{why}");
    }
}

#[test]
fn every_valuation_refusal_names_its_point_in_the_typescripts_words() {
    let m = |fills: &[PublishedFill], mark: Option<&str>| {
        message(&value_simulated_drill(fills, mark).unwrap_err())
    };
    let tail = " — academy publishes no prices and will not invent one to finish a drill.";
    let mut blank_id = pf("f-1", "buy", "1", "1");
    blank_id.fill_id = " ".to_owned();
    assert_eq!(
        m(&[blank_id], None),
        format!("A fill with no fillId cannot be valued{tail}")
    );
    assert_eq!(
        m(
            &[pf("f-1", "buy", "1", "1"), pf("f-1", "sell", "1", "1")],
            None
        ),
        format!(
            "Fill f-1 was published twice with conflicting trade data — refusing to invent a merged paper PnL{tail}"
        )
    );
    assert_eq!(
        m(&[pf("f-1", "hold", "1", "1")], None),
        format!("Fill f-1 has no side, so it cannot be valued{tail}")
    );
    assert_eq!(
        m(&[pf("f-1", "buy", " ", "1")], None),
        format!("Fill f-1 carries no published price{tail}")
    );
    assert_eq!(
        m(&[pf("f-1", "buy", "1", " x ")], None),
        format!("Fill f-1 has an unreadable published size \"x\"{tail}")
    );
    assert_eq!(
        m(&[pf("f-1", "buy", "1", "-1")], None),
        format!("Fill f-1 has a negative published size{tail}")
    );
    assert_eq!(
        m(&[pf("f-1", "buy", "1", "1")], Some("-3")),
        format!("Fill (drill mark) has a negative published mark price{tail}")
    );
}

#[test]
fn sums_past_an_i128_stay_exact_as_the_typescripts_bigint() {
    // Two fills at the largest price and size numeric(38,18) holds: the notional is far past 2^127.
    let big = "99999999999999999999.999999999999999999";
    let v = value_simulated_drill(
        &[pf("f-1", "buy", big, big), pf("f-2", "buy", big, big)],
        Some("1"),
    )
    .unwrap();
    assert_eq!(v.bought_size, "199999999999999999999.999999999999999998");
    assert_eq!(v.average_buy_price.as_deref(), Some(big));
    // (1 - big) × 2big, rounded half up; the TypeScript gives the same digits (tsx, 2026-11-20).
    assert_eq!(
        v.unrealised_pnl.as_deref(),
        Some("-19999999999999999999799999999999999999600.000000000000000002")
    );
}

#[test]
fn says_so_instead_of_pricing_the_open_size_itself() {
    let v = value_simulated_drill(&[pf("f-1", "buy", "100", "2")], None).unwrap();
    assert_eq!(v.open_size, "2");
    assert_eq!(v.realised_pnl, "0");
    assert_eq!(v.unrealised_pnl, None);
    assert_eq!(v.total_pnl, None);
    assert!(v.mark_unavailable);
    assert!(!is_valuation_complete(&v));
}

#[test]
fn does_not_fall_back_to_the_last_traded_price() {
    let v = value_simulated_drill(&[pf("f-1", "buy", "100", "2")], None).unwrap();
    assert_ne!(v.unrealised_pnl.as_deref(), Some("0"));
    assert_eq!(v.unrealised_pnl, None);
}

#[test]
fn marks_the_open_size_once_trade_publishes_a_mark() {
    let v = value_simulated_drill(&[pf("f-1", "buy", "100", "2")], Some("115")).unwrap();
    assert_eq!(v.unrealised_pnl.as_deref(), Some("30"));
    assert_eq!(v.total_pnl.as_deref(), Some("30"));
    assert!(!v.mark_unavailable);
}

#[test]
fn marks_an_open_short_from_the_published_sell_average() {
    let v = value_simulated_drill(&[pf("f-1", "sell", "100", "2")], Some("90")).unwrap();
    assert_eq!(v.open_size, "-2");
    assert_eq!(v.unrealised_pnl.as_deref(), Some("20"));
}

#[test]
fn refuses_a_mark_that_is_itself_unreadable() {
    let r = value_simulated_drill(&[pf("f-1", "buy", "100", "2")], Some("about 115"));
    assert_eq!(academy_code(&r), "academy.paper_price_unavailable");
}

#[test]
fn a_total_demanded_over_an_unmarked_position_is_a_refusal() {
    let open = [pf("f-1", "buy", "100", "2")];
    let v = value_simulated_drill(&open, None).unwrap();
    assert_eq!(
        academy_code(&simulated_total_pnl_or_refuse(&v)),
        "academy.paper_price_unavailable"
    );
    let marked = value_simulated_drill(&open, Some("115")).unwrap();
    assert_eq!(simulated_total_pnl_or_refuse(&marked).unwrap(), "30");
}

#[test]
fn the_operator_line_carries_the_seal_and_says_unmarked() {
    let line = simulated_valuation_line(
        &value_simulated_drill(&[pf("f-1", "buy", "100", "2")], None).unwrap(),
    );
    assert!(line.contains("simulated=1"));
    assert!(line.contains("total=unmarked"));
}

// ── real-money-ban.test.ts ─────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn lists_the_custody_looking_keys_a_paper_payload_must_never_carry() {
    for k in [
        "availableBalance",
        "ledgerTxId",
        "holdAmount",
        "withdrawableBalance",
    ] {
        assert!(PAPER_REAL_MONEY_BANNED_KEYS.contains(&k));
    }
    assert!(!is_paper_real_money_banned_key("realisedPnl"));
    assert!(!is_paper_real_money_banned_key("totalPnl"));
}

#[test]
fn lets_a_properly_sealed_drill_payload_through() {
    let mut valuation = seal_fields();
    valuation.push(("realisedPnl".to_owned(), Json::str("12.5")));
    valuation.push(("totalPnl".to_owned(), Json::str("12.5")));
    let sealed = seal_simulated(Json::obj([
        ("marketId", Json::str("m1")),
        ("realisedPnl", Json::str("12.5")),
        ("valuation", Json::Object(valuation)),
    ]));
    assert!(assert_paper_never_readable_as_real_money(&sealed).is_ok());
}

fn plus(base: Json, key: &str, v: Json) -> Json {
    let Json::Object(mut fields) = base else {
        panic!()
    };
    fields.retain(|(k, _)| k != key);
    fields.push((key.to_owned(), v));
    Json::Object(fields)
}

#[test]
fn refuses_a_sealed_payload_that_also_carries_each_banned_key() {
    for key in PAPER_REAL_MONEY_BANNED_KEYS {
        let dirty = plus(
            seal_simulated(Json::obj([("ok", Json::Bool(true))])),
            key,
            Json::str("1.00"),
        );
        let e = assert_paper_never_readable_as_real_money(&dirty).unwrap_err();
        assert_eq!(code(&e), "academy.paper_looks_like_real_money", "{key}");
        assert!(
            message(&e)
                .to_lowercase()
                .contains("never be readable as real money"),
            "{key}"
        );
    }
}

#[test]
fn refuses_nested_custody_keys_under_result_valuation() {
    let mut valuation = seal_fields();
    valuation.push(("availableBalance".to_owned(), Json::str("100")));
    let dirty = seal_simulated(Json::obj([("valuation", Json::Object(valuation))]));
    let e = assert_paper_never_readable_as_real_money(&dirty).unwrap_err();
    assert_eq!(
        message(&e),
        "Paper payload refused — payload.result.valuation.availableBalance claims real custody (\"availableBalance\"). A paper flag must never be readable as real money."
    );
}

#[test]
fn refuses_when_a_seal_key_is_flipped_to_true() {
    for key in ["realMoney", "realLedger", "withdrawable", "live", "isLive"] {
        let dirty = plus(
            seal_simulated(Json::obj([("ok", Json::Bool(true))])),
            key,
            Json::Bool(true),
        );
        assert!(
            assert_paper_never_readable_as_real_money(&dirty).is_err(),
            "{key}"
        );
    }
}

#[test]
fn refuses_a_venue_that_is_not_paper() {
    let dirty = plus(
        seal_simulated(Json::obj([("ok", Json::Bool(true))])),
        "venue",
        Json::str("spot"),
    );
    let e = assert_paper_never_readable_as_real_money(&dirty).unwrap_err();
    assert_eq!(
        message(&e),
        "Paper payload refused — payload.venue is \"spot\" — paper doors are venue=paper. A paper flag must never be readable as real money."
    );
}

fn obj(fields: &[(&str, Value)]) -> Value {
    Value::Object(
        fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect(),
    )
}

#[test]
fn refuses_an_inbound_body_that_claims_live_money() {
    assert!(
        assert_paper_input_never_claims_live(&obj(&[
            ("slug", s("x")),
            ("realMoney", Value::Bool(true))
        ]))
        .is_err()
    );
    let nested = obj(&[(
        "market",
        obj(&[("paper", Value::Bool(true)), ("live", Value::Bool(true))]),
    )]);
    let e = assert_paper_input_never_claims_live(&nested).unwrap_err();
    assert_eq!(
        message(&e),
        "Paper payload refused — input.market.live is true — paper must keep live=false. A paper flag must never be readable as real money."
    );
}

#[test]
fn fails_if_a_public_academy_paper_door_can_present_paper_as_live() {
    // The handlers' source: every door runs the inbound ban and the outbound ban, and each drill seals its figure.
    let src = include_str!("../src/programme/paper/mod.rs");
    let region = |name: &str| {
        let start = src.find(&format!("fn {name}(")).unwrap();
        let end = src[start + 1..]
            .find("\nfn ")
            .map_or(src.len(), |i| start + 1 + i);
        &src[start..end]
    };
    assert!(src.contains("\"paperDrill\" =>"));
    assert!(src.contains("\"paperDrillResult\" =>"));
    assert!(src.contains("\"paperOpsStatus\" =>"));
    for door in ["paper_drill", "paper_drill_result", "paper_ops_status"] {
        assert!(
            region(door).contains("assert_paper_never_readable_as_real_money"),
            "{door}"
        );
    }
    for door in ["paper_drill", "paper_drill_result"] {
        assert!(region(door).contains("gate(ctx"), "{door}");
        assert!(region(door).contains("assert_sealed_simulated"), "{door}");
    }
    assert!(region("gate").contains("assert_paper_input_never_claims_live"));
    assert!(region("paper_ops_status").contains("(\"realMoney\", Json::Bool(false))"));
}

// ── ops-gate.test.ts ───────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn defaults_enabled_when_flag_is_undefined() {
    assert!(is_paper_ops_enabled(None));
    assert!(paper_ops_status(None).enabled);
}

#[test]
fn kills_paper_drills_when_ops_sets_false_live_trade_stays_unaffected() {
    assert!(!is_paper_ops_enabled(Some(false)));
    let status = paper_ops_status(Some(false));
    assert!(!status.enabled);
    assert!(status.live_trade_unaffected);
    assert_eq!(status.flag_id, PAPER_OPS_FLAG_ID);
    assert_eq!(status.env_key, PAPER_OPS_ENV_KEY);
    assert!(!status.real_money);
    assert!(status.simulated);
    assert_eq!(status.venue, "paper");
}

#[test]
fn keeps_paper_on_when_enabled_is_true() {
    assert!(is_paper_ops_enabled(Some(true)));
    assert!(paper_ops_status(Some(true)).enabled);
}

#[test]
fn names_the_refuse_message_without_inventing_prices_or_live_risk() {
    let m = paper_ops_disabled_message().to_lowercase();
    assert!(m.contains("live trade unchanged"));
    for word in ["price", "pnl", "balance", "ledger"] {
        assert!(!m.contains(word), "{word}");
    }
}

// ── cert-progress-hook.test.ts ─────────────────────────────────────────────────────────────────────────────────────

const NOW: Instant = Instant(1_786_881_600_000); // 2026-08-16T12:00:00.000Z

fn bound_cert() -> CertDefinition {
    CertDefinition {
        id: "foundations-v1".to_owned(),
        title: "Foundations".to_owned(),
        required_item_slugs: vec!["foundations-paper-workbook".to_owned()],
    }
}

fn complete_run(workbook_slug: &str) -> DrillRun {
    let mut run = start_paper_drill(
        workbook_slug,
        Some(&market("mkt-paper-1", true, "BTC-USDT")),
        None,
    )
    .unwrap();
    for step in run.steps.clone() {
        run = complete_drill_step(&run, &step.id).unwrap();
    }
    run
}

#[test]
fn bound_workbook_records_a_completion_row_and_never_grants() {
    assert_eq!(NOW.iso(), "2026-08-16T12:00:00.000Z");
    let mut store: Vec<ItemCompletionRecord> = Vec::new();
    let mut persisted = 0;
    let view = record_paper_cert_item_progress(
        "u-paper-1",
        &complete_run("foundations-paper-workbook"),
        &[bound_cert()],
        None,
        &mut |r| {
            persisted += 1;
            store.push(r.clone());
        },
        NOW,
    )
    .unwrap();
    assert_eq!(
        view,
        PaperCertProgressView::Recorded {
            cert_id: "foundations-v1".to_owned(),
            item_slug: "foundations-paper-workbook".to_owned(),
            already_complete: false,
            completed_at: NOW,
        }
    );
    let j = view.json();
    assert_eq!(j.get("simulated"), Some(&Json::Bool(true)));
    assert_eq!(j.get("realMoney"), Some(&Json::Bool(false)));
    assert_eq!(j.get("progress"), Some(&Json::str("recorded")));
    assert_eq!(j.get("grantCert"), Some(&Json::Bool(false)));
    assert_eq!(j.get("perkMap"), Some(&Json::Bool(false)));
    assert_eq!(persisted, 1);
    let slugs: Vec<&str> = store.iter().map(|r| r.item_slug.as_str()).collect();
    assert_eq!(slugs, ["foundations-paper-workbook"]);
    assert!(assert_paper_never_readable_as_real_money(&j).is_ok());
}

#[test]
fn an_already_complete_workbook_is_not_persisted_again() {
    let existing = ItemCompletionRecord {
        user_id: "u-paper-1".to_owned(),
        item_slug: "foundations-paper-workbook".to_owned(),
        completed_at: Instant(0),
    };
    let mut persisted = 0;
    let view = record_paper_cert_item_progress(
        "u-paper-1",
        &complete_run("foundations-paper-workbook"),
        &[bound_cert()],
        Some(&existing),
        &mut |_| persisted += 1,
        NOW,
    )
    .unwrap();
    assert_eq!(persisted, 0);
    assert!(matches!(
        view,
        PaperCertProgressView::Recorded {
            already_complete: true,
            completed_at: Instant(0),
            ..
        }
    ));
}

#[test]
fn unbound_workbook_is_named_unbound_no_persist_no_grant() {
    let mut persisted = 0;
    let view = record_paper_cert_item_progress(
        "u-paper-1",
        &complete_run("unbound-paper-workbook"),
        &[bound_cert()],
        None,
        &mut |_| persisted += 1,
        NOW,
    )
    .unwrap();
    assert_eq!(
        view.json(),
        Json::obj([
            ("simulated", Json::Bool(true)),
            ("realMoney", Json::Bool(false)),
            ("progress", Json::str("unbound")),
            ("reason", Json::str("academy.paper_cert_unbound")),
            ("itemSlug", Json::str("unbound-paper-workbook")),
            ("grantCert", Json::Bool(false)),
            ("perkMap", Json::Bool(false)),
        ])
    );
    assert_eq!(persisted, 0);
    assert!(assert_paper_never_readable_as_real_money(&view.json()).is_ok());
}

#[test]
fn incomplete_drill_does_not_record_a_completion_row() {
    let run = start_paper_drill(
        "foundations-paper-workbook",
        Some(&market("mkt-paper-1", true, "BTC-USDT")),
        None,
    )
    .unwrap();
    let mut persisted = 0;
    let view = record_paper_cert_item_progress(
        "u-paper-1",
        &run,
        &[bound_cert()],
        None,
        &mut |_| persisted += 1,
        NOW,
    )
    .unwrap();
    assert_eq!(view, PaperCertProgressView::Incomplete);
    assert_eq!(persisted, 0);
    assert!(assert_paper_never_readable_as_real_money(&view.json()).is_ok());
}

/// The source with comments and doc lines removed: only code is scanned.
fn code_only(text: &str) -> String {
    text.lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn does_not_import_perk_map_xp_invent_or_the_ledger_write_surface() {
    let code = code_only(include_str!("../src/programme/paper/cert_hook.rs"));
    // The TypeScript's patterns (perk-plane, xp-publish|xp-policy|xp-emit, LedgerClient|recipes|MemoryLedger,
    // .grant() and their Rust spellings.
    for banned in [
        "perk-plane",
        "perk_plane",
        "xp-publish",
        "xp_publish",
        "xp-policy",
        "xp_policy",
        "xp-emit",
        "xp_emit",
        "LedgerClient",
        "ledger_client",
        "recipes",
        "MemoryLedger",
        ".grant(",
    ] {
        assert!(
            !code.contains(banned),
            "cert_hook.rs code mentions {banned}"
        );
    }
}

#[test]
fn the_seal_constant_is_the_typescripts() {
    assert_eq!(
        simulated_seal().compact(),
        "{\"simulated\":true,\"venue\":\"paper\",\"realLedger\":false,\"withdrawable\":false,\"realMoney\":false,\"disclaimer\":\"Simulated result from a paper trading drill. No value moved, no ledger entry exists, and nothing here is withdrawable.\"}"
    );
}
