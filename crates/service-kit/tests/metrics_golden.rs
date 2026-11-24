//! `service_kit::metrics` against `@intafaced/telemetry`'s `Metrics`: for each recorded case, the same observations give
//! the same exposition byte for byte, and `statusClass` and `methodLabel` give the same labels.
//! `scripts/record-metrics.mjs` records `tests/fixtures/metrics.golden.json` from the TypeScript.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use service_kit::json::{self, Json};
use service_kit::metrics::{Labels, Metrics, method_label, status_class};

fn golden() -> Json {
    json::parse(include_str!("fixtures/metrics.golden.json")).unwrap()
}

fn text(v: &Json, key: &str) -> String {
    match v.get(key) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{key}: {other:?}"),
    }
}

fn number(v: &Json, key: &str) -> f64 {
    match v.get(key) {
        Some(Json::Number(n)) => *n,
        other => panic!("{key}: {other:?}"),
    }
}

fn list<'a>(v: &'a Json, key: &str) -> &'a [Json] {
    match v.get(key) {
        Some(Json::Array(a)) => a,
        other => panic!("{key}: {other:?}"),
    }
}

/// `Number(s)` for what the recorder wrote with `String(n)`.
fn seconds(s: &str) -> f64 {
    match s {
        "NaN" => f64::NAN,
        "Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ => s.parse().unwrap(),
    }
}

#[test]
fn every_recorded_exposition_matches_byte_for_byte() {
    let g = golden();
    let cases = list(&g, "cases");
    assert!(cases.len() >= 10, "{} cases", cases.len());
    for c in cases {
        let name = text(c, "name");
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a small recorded cap"
        )]
        let metrics = Metrics::new(number(c, "maxSeries") as usize);
        for o in list(c, "observations") {
            let l = o.get("labels").unwrap();
            metrics.observe(
                &Labels {
                    service: text(l, "service"),
                    module: text(l, "module"),
                    method: text(l, "method"),
                    status: text(l, "status"),
                    outcome: text(l, "outcome"),
                },
                seconds(&text(o, "seconds")),
            );
        }
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a small recorded count"
        )]
        let size = number(c, "size") as usize;
        assert_eq!(metrics.size(), size, "{name}: size");
        assert_eq!(metrics.render(), text(c, "render"), "{name}: render");
    }
}

#[test]
fn status_classes_and_method_labels_match() {
    let g = golden();
    for pair in list(&g, "statusClass") {
        let Json::Array(p) = pair else { panic!() };
        let (Json::Number(code), Json::String(class)) = (&p[0], &p[1]) else {
            panic!()
        };
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a recorded status code"
        )]
        let code = *code as u16;
        assert_eq!(status_class(code), class, "{code}");
    }
    for pair in list(&g, "methodLabel") {
        let Json::Array(p) = pair else { panic!() };
        let (Json::String(m), Json::String(label)) = (&p[0], &p[1]) else {
            panic!()
        };
        assert_eq!(&method_label(m), label, "{m:?}");
    }
}
