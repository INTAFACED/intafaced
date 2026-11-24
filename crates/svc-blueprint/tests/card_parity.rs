//! Slice `card`'s pure parts against what the TypeScript did (`tests/fixtures/card.golden.json`, written by
//! `scripts/record-door.mjs`): every card `composeCard` drew, byte for byte; the zero-PII bar's verdict on each payload;
//! and, for each answer a renderer gave, the request `HttpCardRenderer` sent and the raster it returned.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::sync::{Arc, Mutex};

use service_kit::http::{FETCH_FAILED, Fetch, FetchError, HttpRequest, HttpResponse, TIMED_OUT};
use service_kit::json::{self, Json};
use svc_blueprint::card::compose::{self, Size, Subject};
use svc_blueprint::card::renderer::{CardRenderer, Http, RasterizeRequest};
use svc_blueprint::zero_pii;

const GOLDEN: &str = include_str!("fixtures/card.golden.json");

fn golden() -> Json {
    json::parse(GOLDEN).unwrap()
}

fn list<'a>(v: &'a Json, key: &str) -> &'a [Json] {
    match v.get(key) {
        Some(Json::Array(a)) => a,
        other => panic!("{key}: {other:?}"),
    }
}

fn s<'a>(v: &'a Json, key: &str) -> &'a str {
    match v.get(key) {
        Some(Json::String(s)) => s,
        other => panic!("{key}: {other:?}"),
    }
}

fn n(v: &Json, key: &str) -> f64 {
    match v.get(key) {
        Some(Json::Number(n)) => *n,
        other => panic!("{key}: {other:?}"),
    }
}

#[test]
fn every_card_is_the_one_the_typescript_drew() {
    let g = golden();
    let composed = list(&g, "composed");
    assert!(composed.len() >= 10);
    for c in composed {
        let subject = c.get("subject").unwrap();
        let profile = subject.get("profile").unwrap();
        let subject = Subject {
            decision_style: s(profile, "decisionStyle").to_owned(),
            risk_temperament: s(profile, "riskTemperament").to_owned(),
            energy_rhythm: s(profile, "energyRhythm").to_owned(),
            learning_mode: s(profile, "learningMode").to_owned(),
            crew_role: s(profile, "crewRole").to_owned(),
            curriculum_path: s(profile, "curriculumPath").to_owned(),
            tone_register: s(profile, "toneRegister").to_owned(),
            crew_name: match subject.get("crewName") {
                Some(Json::String(n)) => Some(n.clone()),
                _ => None,
            },
            #[allow(
                clippy::cast_possible_truncation,
                reason = "a season is a small integer"
            )]
            season: match subject.get("season") {
                Some(Json::Number(n)) => Some(*n as i64),
                _ => None,
            },
        };
        let size = Size::parse(s(c, "size")).unwrap();
        assert_eq!(
            compose::compose(&subject, size).unwrap(),
            s(c, "svg"),
            "{subject:?} at {size:?}"
        );
    }
}

#[test]
fn the_zero_pii_bar_refuses_what_the_typescript_refused() {
    let g = golden();
    for c in list(&g, "zeroPii") {
        let payload = c.get("payload").unwrap();
        let answer = c.get("answer").unwrap();
        let ours = zero_pii::inspect(payload);
        match answer.get("ok") {
            Some(Json::Bool(true)) => assert_eq!(ours, None, "{}", payload.compact()),
            _ => assert_eq!(
                ours,
                Some((s(answer, "field").to_owned(), {
                    let code = s(answer, "code");
                    svc_blueprint::errors::ATTESTATION_CODES
                        .iter()
                        .copied()
                        .find(|c| *c == code)
                        .unwrap()
                })),
                "{}",
                payload.compact()
            ),
        }
    }
    // What a refusal says, as `assertZeroPiiSurface` throws it.
    let refused = zero_pii::assert_surface(
        "card.subject",
        &json::parse(r#"{"profile":{"userId":"x"}}"#).unwrap(),
    )
    .unwrap_err()
    .mapped();
    assert_eq!(
        (
            refused.code,
            refused.message.as_str(),
            refused.cause.as_deref()
        ),
        (
            "BAD_REQUEST",
            "card.subject: attestation/card payload refuses PII field userId (blueprint.attestation_pii_custodial_user_id)",
            Some("blueprint.attestation_pii_custodial_user_id")
        )
    );
}

/// A renderer that answers one recorded case and keeps the request it was sent.
struct Recorded {
    case: Json,
    sent: Mutex<Option<HttpRequest>>,
}

impl Fetch for Recorded {
    fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
        *self.sent.lock().unwrap() = Some(req.clone());
        match self.case.get("throws") {
            Some(Json::String(t)) if t == "timeout" => Err(FetchError {
                message: TIMED_OUT.to_owned(),
            }),
            Some(Json::String(_)) => Err(FetchError {
                message: FETCH_FAILED.to_owned(),
            }),
            _ => Ok(HttpResponse {
                #[allow(
                    clippy::cast_possible_truncation,
                    clippy::cast_sign_loss,
                    reason = "an HTTP status"
                )]
                status: n(&self.case, "status") as u16,
                body: s(&self.case, "body").to_owned(),
            }),
        }
    }
}

#[test]
fn the_http_renderer_sends_and_returns_what_the_typescript_did() {
    let g = golden();
    let r = g.get("request").unwrap();
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "the card's pixel size"
    )]
    let request = RasterizeRequest {
        svg: s(r, "svg").to_owned(),
        size: Size::parse(s(r, "size")).unwrap(),
        width: n(r, "width") as u32,
        height: n(r, "height") as u32,
        blueprint_id: s(r, "blueprintId").to_owned(),
    };
    let cases = list(&g, "renderer");
    assert!(cases.len() >= 15);
    for c in cases {
        let case = c.get("case").unwrap().clone();
        let fetch = Arc::new(Recorded {
            case: case.clone(),
            sent: Mutex::new(None),
        });
        let api_key = case.get("apiKey").map(|_| s(&case, "apiKey").to_owned());
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a timeout in ms"
        )]
        let timeout = case.get("timeoutMs").map(|_| n(&case, "timeoutMs") as u64);
        let renderer = Http::new(s(&case, "baseUrl"), timeout, api_key, fetch.clone());
        let answer = renderer.rasterize(&request);
        assert_eq!(
            answer.to_json().compact(),
            c.get("answer").unwrap().compact(),
            "{}",
            case.compact()
        );

        let sent = fetch.sent.lock().unwrap().clone().unwrap();
        let was = c.get("sent").unwrap();
        assert_eq!(sent.method, s(was, "method"));
        assert_eq!(sent.url, s(was, "url"));
        let headers: Vec<(String, String)> = list(was, "headers")
            .iter()
            .map(|h| match h {
                Json::Array(kv) => (
                    kv[0].compact().trim_matches('"').to_owned(),
                    kv[1].compact().trim_matches('"').to_owned(),
                ),
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(sent.headers, headers);
        assert_eq!(sent.body.as_deref(), Some(s(was, "body")));
        assert_eq!(sent.timeout_ms, Some(timeout.unwrap_or(10_000)));
    }
}
