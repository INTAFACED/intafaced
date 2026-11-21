//! The JetStream client against a real NATS server with JetStream on (`TEST_NATS_URL`, e.g. `nats-server -js`):
//! the stream is made and reconciled, a publish is acknowledged, a second with the same `Nats-Msg-Id` is a duplicate,
//! and a subject no stream holds refuses. Without `TEST_NATS_URL` it skips; with `REQUIRE_NATS=1` it fails.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

use std::time::Duration;

use service_kit::nats::{JetStream, stream_config};

#[test]
fn publishes_once_per_message_id_into_its_own_stream() {
    let Ok(url) = std::env::var("TEST_NATS_URL") else {
        assert!(
            std::env::var("REQUIRE_NATS").as_deref() != Ok("1"),
            "REQUIRE_NATS=1 and no TEST_NATS_URL"
        );
        eprintln!("skipped: no TEST_NATS_URL");
        return;
    };
    let js = JetStream::connect(&url, "service-kit-test", Duration::from_secs(5)).unwrap();
    let prefix = format!("KITTEST{}", std::process::id());
    let config = stream_config("academy", &prefix);
    js.ensure_stream(&config).unwrap();
    // A second boot reconciles the same stream.
    js.ensure_stream(&config).unwrap();
    let first = js
        .publish("intafaced.academy.cert.granted", "cert:1", br#"{"a":1}"#)
        .unwrap();
    assert_eq!(first.stream, format!("{prefix}_ACADEMY"));
    assert!(!first.duplicate);
    let again = js
        .publish("intafaced.academy.cert.granted", "cert:1", br#"{"a":1}"#)
        .unwrap();
    assert!(
        again.duplicate,
        "the same Nats-Msg-Id inside the window is deduplicated"
    );
    assert_eq!(again.seq, first.seq);
    let other = js
        .publish("intafaced.academy.cert.granted", "cert:2", br#"{"a":2}"#)
        .unwrap();
    assert_eq!(other.seq, first.seq + 1);
    let nowhere = js.publish("nobody.holds.this", "x:1", b"{}");
    assert!(nowhere.is_err(), "{nowhere:?}");
    js.close();
}
