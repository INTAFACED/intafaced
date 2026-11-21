//! The `post-recipe` slice's door against what the TypeScript answered (`tests/fixtures/post-recipe.golden.jsonl`,
//! written by `scripts/record-door.mjs`): for each recorded body and each caller, `handleS2sPostRecipe`'s refusal on the
//! wire, or the post it handed the ledger once `postChecked` had run the caller binding and the recipe gate. The Rust
//! door must refuse the same bodies with the same status and body, and build the same post from the rest: the same key,
//! module, reason, meta and legs, so a booking through either door is the same booking.
//!
//! The four binding checks that read the book come after the recipe gate; the recorder stops if one reads for a recipe
//! on this door, so none applies here. `tests/conformance/` runs the slice's Postgres test against the binary.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use service_kit::json::{self, Json};
use svc_ledger::errors::{self, Failure};
use svc_ledger::posting::gate::{self, Caller};
use svc_ledger::posting::recipe_door::{self, NAMES};
use svc_ledger::posting::rules;

const GOLDEN: &str = include_str!("fixtures/post-recipe.golden.jsonl");

/// A recorded caller (`{ kind, service }`, `{ kind, claimed }`, or `null` for a direct call).
fn caller_of(c: &Json) -> Option<Caller> {
    match c.get("kind") {
        Some(Json::String(k)) if k == "bound" => match c.get("service") {
            Some(Json::String(s)) => Some(Caller::Bound(s.clone())),
            _ => panic!("a bound caller with no service"),
        },
        Some(Json::String(k)) if k == "legacy" => Some(Caller::Legacy(match c.get("claimed") {
            Some(Json::String(s)) => Some(s.clone()),
            _ => None,
        })),
        _ => None,
    }
}

/// Keys sorted at every level: the recorded post is the TypeScript ledger's object, whose key order is its own.
fn sorted(j: &Json) -> Json {
    match j {
        Json::Object(fields) => {
            let mut f: Vec<_> = fields.iter().map(|(k, v)| (k.clone(), sorted(v))).collect();
            f.sort_by(|a, b| a.0.cmp(&b.0));
            Json::Object(f)
        }
        Json::Array(items) => Json::Array(items.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

fn refused(f: &Failure) -> Json {
    let (status, body) = errors::http_error(f);
    Json::obj([("status", Json::int(i64::from(status))), ("body", body)])
}

/// What the Rust door does with one body for one caller, written as the recording writes it.
fn rust_answer(caller: Option<&Caller>, body: Option<&Json>) -> Json {
    let prepared = match recipe_door::prepare(caller, body) {
        Ok(p) => p,
        Err(f) => return refused(&f),
    };
    // `postChecked` before the ledger: the caller binding (the recording passes no binding options, so no keys are
    // configured), then the recipe gate.
    let r = rules::read_post(&prepared.post).unwrap();
    if let Some(caller) = caller
        && let (_, Err(f)) = gate::apply_binding(caller, &r, false)
    {
        return refused(&f);
    }
    if let Err(f) = gate::assert_known_recipe(&r) {
        return refused(&f);
    }
    assert_eq!(
        prepared.post.get("idempotencyKey"),
        Some(&Json::str(prepared.idempotency_key.clone()))
    );
    assert_eq!(
        prepared.post.get("module"),
        Some(&Json::str(prepared.module.clone()))
    );
    assert_eq!(
        prepared.post.get("reason"),
        Some(&Json::str(prepared.reason.clone()))
    );
    Json::obj([("post", prepared.post)])
}

#[test]
fn the_door_refuses_and_builds_what_the_typescript_door_does() {
    let mut lines = GOLDEN.lines();
    let head = json::parse(lines.next().unwrap()).unwrap();
    let Some(Json::Array(recipes)) = head.get("recipes") else {
        panic!("no recipes")
    };
    assert_eq!(
        recipes.iter().map(Json::compact).collect::<Vec<_>>(),
        NAMES
            .iter()
            .map(|n| Json::str(*n).compact())
            .collect::<Vec<_>>(),
        "the door posts the recipes the TypeScript door posts"
    );
    let Some(Json::Array(callers)) = head.get("callers") else {
        panic!("no callers")
    };
    let callers: Vec<_> = callers.iter().map(caller_of).collect();
    let Some(Json::Array(answers)) = head.get("answers") else {
        panic!("no answers")
    };
    let answers: Vec<Json> = answers
        .iter()
        .map(|a| match a {
            Json::String(s) => json::parse(s).unwrap(),
            _ => panic!("an answer is its JSON text"),
        })
        .collect();

    let (mut cases, mut posts, mut differ) = (0usize, 0usize, Vec::new());
    for line in lines {
        let case = json::parse(line).unwrap();
        let Json::Array(case) = case else {
            panic!("a case is [body, answers]")
        };
        let body = match &case[0] {
            Json::String(text) => Some(json::parse(text).unwrap()),
            Json::Null => None,
            _ => panic!("a body is its JSON text"),
        };
        let Json::Array(said) = &case[1] else {
            panic!("answers per caller")
        };
        for (caller, index) in callers.iter().zip(said) {
            let Json::Number(i) = index else {
                panic!("an answer index")
            };
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "an index the recorder wrote"
            )]
            let want = &answers[*i as usize];
            let got = rust_answer(caller.as_ref(), body.as_ref());
            cases += 1;
            if want.get("post").is_some() {
                posts += 1;
            }
            if sorted(want) != sorted(&got) {
                differ.push(format!(
                    "body {} caller {caller:?}\n  ts:   {}\n  rust: {}",
                    body.as_ref()
                        .map_or_else(|| "undefined".to_owned(), Json::compact),
                    want.compact(),
                    got.compact()
                ));
            }
        }
    }
    assert!(posts > 0, "no recorded body reached the ledger");
    assert!(
        differ.is_empty(),
        "{} of {cases} answers differ:\n{}",
        differ.len(),
        differ.join("\n")
    );
    println!("post-recipe parity: {cases} answers, {posts} of them posts, all the same");
}
