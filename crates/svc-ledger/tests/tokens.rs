//! The operator doors' access tokens against `verifyAccessToken`'s own verdicts: `fixtures/tokens.golden.json` holds
//! what the TypeScript answered to tokens `scripts/record-door.mjs` made to probe it (expiries far in the past or the
//! future, so the verdict does not move with the clock).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use service_kit::json::{self, Json};
use service_kit::s2s::system_seconds;
use service_kit::tokens::{TokenConfig, VerifyKey, verify_access_token};

const GOLDEN: &str = include_str!("fixtures/tokens.golden.json");

fn s(j: &Json, k: &str) -> Option<String> {
    match j.get(k) {
        Some(Json::String(v)) => Some(v.clone()),
        _ => None,
    }
}

/// The token, from the parts the fixture keeps.
fn token(case: &Json) -> String {
    let Some(Json::Array(parts)) = case.get("parts") else {
        panic!("parts")
    };
    parts
        .iter()
        .map(|p| match p {
            Json::String(s) => s.as_str(),
            _ => panic!("a part is text"),
        })
        .collect::<Vec<_>>()
        .join(".")
}

#[test]
fn every_token_is_judged_as_the_typescript_judges_it() {
    let golden = json::parse(GOLDEN).unwrap();
    let Some(Json::Array(cases)) = golden.get("cases") else {
        panic!("no cases")
    };
    let mut differ = Vec::new();
    for case in cases {
        let c = case.get("config").unwrap();
        let Some(Json::Array(vo)) = c.get("verifyOnly") else {
            panic!("verifyOnly")
        };
        let config = TokenConfig {
            secret: s(c, "secret").unwrap(),
            issuer: "intafaced".to_owned(),
            audience: "intafaced.api".to_owned(),
            key_id: s(c, "keyId"),
            verify_only: vo
                .iter()
                .map(|k| VerifyKey {
                    key_id: s(k, "keyId").unwrap(),
                    secret: s(k, "secret").unwrap(),
                })
                .collect(),
        };
        let got = match verify_access_token(&token(case), &config, system_seconds()) {
            Ok(v) => {
                let p = v.principal;
                let opt = |o: Option<String>| o.map_or(Json::Null, Json::String);
                Json::Object(vec![(
                    "ok".to_owned(),
                    Json::Object(vec![
                        ("userId".to_owned(), Json::str(p.user_id)),
                        (
                            "scopes".to_owned(),
                            Json::Array(p.scopes.into_iter().map(Json::String).collect()),
                        ),
                        ("tier".to_owned(), Json::str(p.tier)),
                        ("mfa".to_owned(), Json::Bool(p.mfa)),
                        ("kid".to_owned(), opt(p.kid)),
                        ("subAccount".to_owned(), opt(p.sub_account)),
                        ("exp".to_owned(), Json::int(v.expires_at)),
                    ]),
                )])
            }
            Err(e) => Json::Object(vec![(
                "refused".to_owned(),
                Json::Object(vec![
                    ("message".to_owned(), Json::str(e.message)),
                    ("code".to_owned(), Json::str(e.code)),
                ]),
            )]),
        };
        let want = case.get("answer").unwrap();
        if &got != want {
            differ.push(format!(
                "{}\n  want {}\n  got  {}",
                s(case, "name").unwrap(),
                want.compact(),
                got.compact()
            ));
        }
    }
    println!("{} tokens; {} differ", cases.len(), differ.len());
    assert!(differ.is_empty(), "{}", differ.join("\n"));
}
