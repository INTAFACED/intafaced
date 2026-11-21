//! The `posting` slice's rules against what the TypeScript answered (`tests/fixtures/posting-parity/`,
//! written by `scripts/record-posting.mjs`): for every recipe the gate was sampled from, and variants of each, the
//! gate's candidates, every caller's allowlist verdict, `assertValidPost`'s refusal, `postFingerprint`, `hashTx`,
//! `movesCustomerBalance` and the balance rule. The hash and the fingerprint are stored in the book and recomputed by
//! the TypeScript, so they must match byte for byte.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use service_kit::json::{self, Json};
use svc_ledger::chain::{self, HashEntry, HashTx};
use svc_ledger::errors::Failure;
use svc_ledger::posting::gate::{self, Caller};
use svc_ledger::posting::rules::{self, Wide};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/posting-parity");

/// `meta.json` (the callers in verdict order, the replay-meta cases) with every `cases-NN.jsonl` line as `cases`.
fn golden() -> Json {
    let mut g =
        json::parse(&std::fs::read_to_string(format!("{FIXTURES}/meta.json")).unwrap()).unwrap();
    let mut parts: Vec<_> = std::fs::read_dir(FIXTURES)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    parts.sort();
    let cases = parts
        .iter()
        .flat_map(|p| {
            std::fs::read_to_string(p)
                .unwrap()
                .lines()
                .map(|l| json::parse(l).unwrap())
                .collect::<Vec<_>>()
        })
        .collect();
    let Json::Object(fields) = &mut g else {
        panic!("meta.json is not an object")
    };
    fields.push(("cases".to_owned(), Json::Array(cases)));
    g
}

fn strs(v: &Json) -> Vec<String> {
    match v {
        Json::Array(a) => a
            .iter()
            .map(|x| match x {
                Json::String(s) => s.clone(),
                other => panic!("not a string: {other:?}"),
            })
            .collect(),
        other => panic!("not a list: {other:?}"),
    }
}

fn said(j: Result<Option<&'static str>, gate::Violation>) -> String {
    match j {
        Ok(r) => format!("ok {}", r.unwrap_or("-")),
        Err(v) => format!("{} {} {}", v.code, v.why.as_str(), v.recipe.unwrap_or("-")),
    }
}

const TX_ID: &str = "9a9a9a9a-0000-4000-8000-000000000001";
/// `2026-11-21T01:02:03.045Z`, the instant the fixture was hashed at.
const POSTED_AT_MS: i64 = 1_795_222_923_045;

#[test]
fn every_recorded_post_is_judged_hashed_and_refused_as_the_typescript_does() {
    let g = golden();
    let services = strs(g.get("services").unwrap());
    let Some(Json::Array(cases)) = g.get("cases") else {
        panic!("no cases")
    };
    assert!(cases.len() > 1000, "the fixture lost its cases");
    let mut checked = 0;
    for c in cases {
        let label = match c.get("label") {
            Some(Json::String(s)) => s.clone(),
            _ => panic!("a case without a label"),
        };
        let r = rules::read_post(c.get("body").unwrap()).unwrap();

        let candidates: Vec<String> = gate::recipe_candidates(&r)
            .into_iter()
            .map(str::to_owned)
            .collect();
        assert_eq!(
            candidates,
            strs(c.get("candidates").unwrap()),
            "{label}: candidates"
        );

        let verdicts = strs(c.get("verdicts").unwrap());
        for (i, service) in services.iter().enumerate() {
            assert_eq!(
                said(gate::judge(&Caller::Bound(service.clone()), &r)),
                verdicts[i],
                "{label}: {service}"
            );
        }
        assert_eq!(
            said(gate::judge(&Caller::Legacy(None), &r)),
            verdicts[services.len()],
            "{label}: unclaimed"
        );

        let valid = match rules::assert_valid_post(&r) {
            Ok(()) => Json::Null,
            Err(Failure::Ledger { code, message }) => {
                Json::obj([("code", Json::str(code)), ("message", Json::str(message))])
            }
            Err(other) => panic!("{label}: {other:?}"),
        };
        assert_eq!(&valid, c.get("valid").unwrap(), "{label}: assertValidPost");

        assert_eq!(
            Some(&Json::str(rules::post_fingerprint(
                &r.module, &r.reason, &r.entries
            ))),
            c.get("fingerprint"),
            "{label}: fingerprint"
        );
        let ids: Vec<String> = (0..r.entries.len())
            .map(|i| format!("00000000-0000-4000-8000-{i:012}"))
            .collect();
        let legs: Vec<HashEntry<'_>> = r
            .entries
            .iter()
            .zip(&ids)
            .map(|(e, id)| HashEntry {
                account_id: id,
                asset_id: &e.account.asset_id,
                direction: e.direction.as_str(),
                amount: e.amount,
            })
            .collect();
        let tx = HashTx {
            id: TX_ID,
            module: &r.module,
            reason: &r.reason,
            posted_at_ms: POSTED_AT_MS,
            entries: &legs,
        };
        let hash = |prev| chain::hash_tx(&tx, prev).unwrap();
        assert_eq!(Some(&Json::str(hash(None))), c.get("hash"), "{label}: hash");
        let tip = "f".repeat(64);
        assert_eq!(
            Some(&Json::str(hash(Some(&tip)))),
            c.get("chained"),
            "{label}: chained hash"
        );

        assert_eq!(
            Some(&Json::Bool(r.moves_customer_balance())),
            c.get("customer"),
            "{label}: custody"
        );
        let Some(Json::Array(allowed)) = c.get("allowed") else {
            panic!("{label}: no balance rule")
        };
        let held = strs(c.get("held").unwrap());
        for (i, e) in r.entries.iter().enumerate() {
            let ours: Vec<Json> = [-1, 0, 1]
                .iter()
                .map(|n| Json::Bool(e.account.balance_allowed(Wide::of(*n))))
                .collect();
            assert_eq!(
                Json::Array(ours),
                allowed[i],
                "{label}: leg {i} balance rule"
            );
            assert_eq!(
                e.account.held_for_refusal(Wide::of(-5)).format(),
                held[i],
                "{label}: leg {i} held"
            );
        }
        checked += 1;
    }
    println!("{checked} recorded posts match");
}

#[test]
fn a_retried_withdrawal_is_told_apart_by_its_fee_and_rail_as_the_typescript_does() {
    let g = golden();
    let Some(Json::Array(cases)) = g.get("meta") else {
        panic!("no meta cases")
    };
    for c in cases {
        let text = |k| match c.get(k) {
            Some(Json::String(s)) => s.clone(),
            _ => panic!("no {k}"),
        };
        let asked = match c.get("asked") {
            Some(Json::Object(o)) => o.clone(),
            _ => panic!("no asked"),
        };
        assert_eq!(
            Some(&Json::Bool(rules::replay_meta_differs(
                c.get("posted").unwrap(),
                &text("module"),
                &text("reason"),
                Some(&asked),
            ))),
            c.get("differs"),
            "{c:?}"
        );
    }
}

#[test]
fn a_sum_past_i128_stays_exact() {
    let max = service_kit::money::MAX_AMOUNT;
    let w = Wide::of(max).plus_amount(max).plus_amount(max);
    assert_eq!(w.amount(), None);
    assert_eq!(w.format(), "299999999999999999999.999999999999999997");
    assert_eq!(
        w.negated().format(),
        "-299999999999999999999.999999999999999997"
    );
    let back = w.plus_amount(-max).plus_amount(-max);
    assert_eq!(back.amount(), Some(max));
    assert_eq!(Wide::of(-3).plus_amount(5).format(), "0.000000000000000002");
}
