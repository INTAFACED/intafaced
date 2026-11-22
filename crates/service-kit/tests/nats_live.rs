//! The JetStream client against a real NATS server with JetStream on (`TEST_NATS_URL`, e.g. `nats-server -js`):
//! the stream is made and reconciled, a publish is acknowledged, a second with the same `Nats-Msg-Id` is a duplicate,
//! and a subject no stream holds refuses; a durable consumer is made and reconciled, a message worked once is acked once,
//! and a failed work is delivered again. Without `TEST_NATS_URL` it skips; with `REQUIRE_NATS=1` it fails.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use service_kit::json::Json;
use service_kit::nats::{ConsumerSpec, Envelope, JetStream, consume, stream_config};

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

fn count(info: &Json, k: &str) -> i64 {
    match info.get(k) {
        Some(Json::Number(n)) => format!("{n}").parse().unwrap(),
        _ => -1,
    }
}

#[test]
fn consumes_acking_after_the_work_and_delivers_a_failed_work_again() {
    let Ok(url) = std::env::var("TEST_NATS_URL") else {
        assert!(
            std::env::var("REQUIRE_NATS").as_deref() != Ok("1"),
            "REQUIRE_NATS=1 and no TEST_NATS_URL"
        );
        eprintln!("skipped: no TEST_NATS_URL");
        return;
    };
    let js = JetStream::connect(&url, "service-kit-test", Duration::from_secs(5)).unwrap();
    let prefix = format!("KITCONSUME{}", std::process::id());
    js.ensure_stream(&stream_config("identity", &prefix))
        .unwrap();
    let subject = "intafaced.identity.self_freeze.frozen";
    let mut spec = ConsumerSpec::new("identity", &prefix, subject, 1, "kit-test-freeze");
    js.ensure_consumer(&spec).unwrap();
    // A second boot with another budget reconciles the live consumer.
    spec.max_deliver = 3;
    js.ensure_consumer(&spec).unwrap();
    let info = js.consumer_info(&spec.stream, &spec.durable).unwrap();
    assert_eq!(count(info.get("config").unwrap(), "max_deliver"), 3);
    js.ensure_consumer(&spec).unwrap();
    let env = format!(
        r#"{{"id":"e1","subject":"{subject}","version":1,"occurredAt":"2026-11-22T00:00:00.000Z","producer":"svc-identity","idempotencyKey":"freeze:1","payload":{{}}}}"#
    );
    js.publish(subject, "freeze:1", env.as_bytes()).unwrap();

    let consumer =
        JetStream::connect(&url, "service-kit-consumer", Duration::from_secs(5)).unwrap();
    let attempts = Mutex::new(Vec::new());
    let stop = AtomicBool::new(false);
    let work = |e: &Envelope| {
        let mut a = attempts.lock().unwrap();
        a.push(e.idempotency_key.clone());
        if a.len() == 1 {
            Err("first attempt fails".to_owned())
        } else {
            Ok(())
        }
    };
    std::thread::scope(|scope| {
        scope.spawn(|| {
            consume(
                &consumer,
                &spec,
                Duration::from_millis(500),
                &stop,
                &work,
                &|_| {},
            )
        });
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let info = js.consumer_info(&spec.stream, &spec.durable).unwrap();
            if attempts.lock().unwrap().len() >= 2
                && count(&info, "num_ack_pending") == 0
                && count(&info, "num_pending") == 0
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "never settled: {}",
                info.compact()
            );
            std::thread::sleep(Duration::from_millis(100));
        }
        // A worked and acked message does not come again.
        std::thread::sleep(Duration::from_secs(2));
        stop.store(true, Ordering::Relaxed);
    });
    assert_eq!(
        *attempts.lock().unwrap(),
        vec!["freeze:1".to_owned(), "freeze:1".to_owned()]
    );
    let info = js.consumer_info(&spec.stream, &spec.durable).unwrap();
    let delivered = info.get("delivered").unwrap();
    assert_eq!(count(delivered, "stream_seq"), 1);
    assert_eq!(count(&info, "num_redelivered"), 0, "{}", info.compact());
    consumer.close();
    js.close();
}
