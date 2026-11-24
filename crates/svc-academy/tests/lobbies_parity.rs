//! The lobbies' zod parts held to zod's own verdicts, recorded from the TypeScript functions themselves by
//! `scripts/record-lobbies.mjs`: `parseScene` (verdict, reason, message, output, fingerprint) on a corpus of scenes,
//! `decideHostSceneWrite` over every pairing of current scene, next scene and fingerprint, and `rankPerksSchema` on a
//! corpus of perk payloads. Also: the spine summaries the pins read are the catalogue's, in its order.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use service_kit::json::{self, Json};
use service_kit::schema::Value;
use svc_academy::lobbies::clients::parse_perks;
use svc_academy::lobbies::scene::{self, Parsed, Write};
use svc_academy::lobbies::spine;

const GOLDEN: &str = include_str!("fixtures/lobbies-parity.golden.json");

fn golden() -> Json {
    json::parse(GOLDEN).unwrap()
}

fn input_of(g: &Json, v: &Json) -> Value {
    match v {
        Json::String(s) if s == "BIG" => Value::from_json(g.get("big").unwrap()),
        other => Value::from_json(other),
    }
}

fn s<'a>(j: &'a Json, k: &str) -> &'a str {
    match j.get(k) {
        Some(Json::String(s)) => s,
        other => panic!("{k}: {other:?}"),
    }
}

#[test]
fn every_scene_reads_as_zod_read_it() {
    let g = golden();
    let Some(Json::Array(cases)) = g.get("parsed") else {
        panic!("no cases")
    };
    assert!(cases.len() >= 40);
    for case in cases {
        let input = input_of(&g, case.get("input").unwrap());
        let label = case.get("input").unwrap().compact();
        let label = &label[..label.len().min(120)];
        match (scene::parse_scene(&input), case.get("ok")) {
            (Parsed::Ok(out), Some(Json::Bool(true))) => {
                assert_eq!(
                    scene::to_json(&out).compact(),
                    case.get("scene").unwrap().compact(),
                    "{label}"
                );
                assert_eq!(scene::fingerprint(&out), s(case, "fingerprint"), "{label}");
            }
            (Parsed::Err { reason, message }, Some(Json::Bool(false))) => {
                assert_eq!(reason.name(), s(case, "reason"), "{label}");
                assert_eq!(message, s(case, "message"), "{label}");
            }
            (got, want) => panic!("{label}: got {got:?}, zod said ok={want:?}"),
        }
    }
}

#[test]
fn every_host_write_is_decided_as_the_typescript_decided_it() {
    let g = golden();
    let Some(Json::Array(cases)) = g.get("writes") else {
        panic!("no cases")
    };
    assert_eq!(cases.len(), 126);
    for case in cases {
        let current = Value::from_json(case.get("current").unwrap());
        let next = input_of(&g, case.get("next").unwrap());
        let expected = match case.get("expectedFingerprint") {
            Some(Json::String(s)) => Some(s.as_str()),
            _ => None,
        };
        let want = case.get("result").unwrap();
        let got = scene::decide_host_scene_write(&current, &next, expected);
        let label = format!("{} / {expected:?}", case.get("next").unwrap().compact());
        match got {
            Write::Ok {
                scene: out,
                fingerprint,
            } => {
                assert_eq!(want.get("ok"), Some(&Json::Bool(true)), "{label}");
                assert_eq!(
                    scene::to_json(&out).compact(),
                    want.get("scene").unwrap().compact(),
                    "{label}"
                );
                assert_eq!(fingerprint, s(want, "fingerprint"), "{label}");
            }
            Write::Conflict { name, message } => {
                assert_eq!(s(want, "reason"), "conflict", "{label}");
                assert_eq!(s(want, "name"), name, "{label}");
                assert_eq!(s(want, "message"), message, "{label}");
            }
            Write::PresenceCollision { message } => {
                assert_eq!(s(want, "reason"), "presence_collision", "{label}");
                assert_eq!(s(want, "message"), message, "{label}");
            }
            Write::Refused { reason, message } => {
                assert_eq!(s(want, "reason"), reason.name(), "{label}");
                assert_eq!(s(want, "message"), message, "{label}");
            }
        }
    }
}

#[test]
fn every_perk_payload_is_read_as_the_contract_reads_it() {
    let g = golden();
    let Some(Json::Array(cases)) = g.get("perks") else {
        panic!("no cases")
    };
    for case in cases {
        let input = case.get("input").unwrap();
        let got = parse_perks(input);
        match case.get("ok") {
            Some(Json::Bool(true)) => assert_eq!(
                got.map(|j| j.compact()),
                Some(case.get("output").unwrap().compact()),
                "{}",
                input.compact()
            ),
            _ => assert_eq!(got, None, "{}", input.compact()),
        }
    }
}

#[test]
fn the_pins_read_the_catalogue_in_its_order() {
    assert_eq!(spine::size(), 25);
    assert_eq!(spine::list().len(), 25);
    let first = &spine::list()[0];
    assert_eq!(first.slug, "builder-first-automation");
    assert_eq!(
        first.summary_json().compact(),
        r#"{"slug":"builder-first-automation","title":"First automation, no live capital","kind":"playbook","path":"builder","order":10,"summary":"Agent guardrails and paper runs before any live rail.","estimatedMinutes":3}"#
    );
    assert!(spine::has_slug("  builder-first-automation "));
    assert!(!spine::has_slug("no-such-lesson"));
}
