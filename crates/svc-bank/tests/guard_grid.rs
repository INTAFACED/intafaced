//! Who may call each guarded call, against the TypeScript's own middlewares (`tests/fixtures/guard-grid.golden.json`,
//! recorded by `scripts/record-door.mjs` running each call's middlewares before its input on one grid of callers): for
//! every call and every caller, the same first refusal, word for word, or the same pass. The wire replay's five callers
//! never meet a basic-tier person, a key, a sub-account or a missing second factor; this grid does, so a call's tier, its
//! module's KYC rule, its region and its session rule are each held to the TypeScript's.
#![allow(clippy::unwrap_used, clippy::panic, reason = "a test")]

use std::collections::BTreeMap;

use service_kit::edge::Principal;
use service_kit::json::{self, Json};
use svc_bank::door::{self, BankDoor, DoorConfig, ServiceAuth};

const USER: &str = "11111111-1111-4111-8111-111111111111";
const SUB: &str = "44444444-4444-4444-8444-444444444444";

/// The recorder's process: vitest's NODE_ENV and APP_ENV, nothing else.
fn door() -> BankDoor {
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    BankDoor::new(DoorConfig {
        edge_secret: "a-bank-guard-grid-edge-secret-long-enough".to_owned(),
        services: ServiceAuth::unwired(),
        env,
        now: door::system_now,
        store: svc_bank::db::Store::Down("no database".to_owned()),
    })
    .unwrap()
}

fn s(v: &Json) -> &str {
    match v {
        Json::String(s) => s,
        _ => panic!("a string"),
    }
}

/// One caller of the grid, as the recorder builds its context.
fn principal(p: &Json, every_scope: &[String]) -> Option<Principal> {
    if matches!(p, Json::Null) {
        return None;
    }
    let session = s(p.get("session").unwrap());
    Some(Principal {
        user_id: USER.to_owned(),
        scopes: if s(p.get("scopes").unwrap()) == "all" {
            every_scope.to_vec()
        } else {
            Vec::new()
        },
        tier: s(p.get("tier").unwrap()).to_owned(),
        mfa: matches!(p.get("mfa"), Some(Json::Bool(true))),
        kid: (session == "key").then(|| "key-1".to_owned()),
        sub_account: (session == "sub-account").then(|| SUB.to_owned()),
        sid: "22222222-2222-4222-8222-222222222222".to_owned(),
        fam: None,
        dev: None,
    })
}

#[test]
fn every_guarded_call_admits_or_refuses_each_caller_as_the_typescript_does() {
    let golden = json::parse(include_str!("fixtures/guard-grid.golden.json")).unwrap();
    let Some(Json::Array(grid)) = golden.get("grid") else {
        panic!()
    };
    let Some(Json::Object(calls)) = golden.get("calls") else {
        panic!()
    };
    // Every scope, space-separated (one string, so no scope reads as a key and its value).
    let every_scope: Vec<String> = s(golden.get("scopes").unwrap())
        .split(' ')
        .map(str::to_owned)
        .collect();
    let door = door();
    let marks: Vec<char> = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
        .chars()
        .collect();
    let (mut probes, mut wrong) = (0, Vec::new());
    for (path, want) in calls {
        let call =
            door::call(path).unwrap_or_else(|| panic!("{path}: a call the door does not hold"));
        let Some(Json::Array(answers)) = want.get("answers") else {
            panic!()
        };
        let want_marks: Vec<char> = s(want.get("marks").unwrap()).chars().collect();
        assert_eq!(want_marks.len(), grid.len(), "{path}");
        for (g, mark) in grid.iter().zip(want_marks) {
            probes += 1;
            let i = marks.iter().position(|m| *m == mark).unwrap();
            let want = match &answers[i] {
                Json::Null => None,
                a => Some(s(a).to_owned()),
            };
            let who = principal(g.get("principal").unwrap(), &every_scope);
            let service = match g.get("service") {
                Some(Json::String(s)) => Some(s.as_str()),
                _ => None,
            };
            let got = door
                .admit(call, who.as_ref(), service, s(g.get("region").unwrap()))
                .err()
                .map(|e| format!("{} {}", e.code, e.message));
            if got != want {
                wrong.push(format!(
                    "{path} {}\n  ts:   {want:?}\n  rust: {got:?}",
                    g.compact()
                ));
            }
        }
    }
    for w in wrong.iter().take(40) {
        println!("{w}");
    }
    println!("{probes} probes over {} calls", calls.len());
    assert!(
        wrong.is_empty(),
        "{} of {probes} probes differ",
        wrong.len()
    );
}
