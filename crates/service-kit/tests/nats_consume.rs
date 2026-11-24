//! The kit's JetStream consumer end to end over a stand-in server that speaks the JetStream API it uses
//! (`support/standin.rs`): the durable consumer is made as `subscribe` makes it, a message is worked once and acked
//! once, a failed work leaves it unacked and nak'd so it comes again, a redelivery after a lost ack is not applied twice,
//! and an envelope of another subject is refused. `nats_live.rs` runs the same against a real server.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

#[path = "support/standin.rs"]
mod standin;

use std::collections::BTreeSet;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use service_kit::nats::{Consumed, ConsumerSpec, Envelope, JetStream, consume};
use standin::StandIn;

const SUBJECT: &str = "intafaced.identity.self_freeze.frozen";

fn spec() -> ConsumerSpec {
    ConsumerSpec::new(
        "identity",
        "INTAFACED",
        SUBJECT,
        1,
        "agents-identity-self-freeze-frozen",
    )
}

fn envelope(subject: &str, key: &str) -> Vec<u8> {
    format!(
        r#"{{"id":"0b8f6a1e-0000-4000-8000-000000000001","subject":"{subject}","version":1,"occurredAt":"2026-11-22T00:00:00.000Z","producer":"svc-identity","idempotencyKey":"{key}","payload":{{"userId":"u1"}}}}"#
    )
    .into_bytes()
}

/// Runs `consume` with `work` until `done` holds of the stand-in, then stops it; what it reported.
fn run(
    server: &StandIn,
    work: &(dyn Fn(&Envelope) -> Result<(), String> + Sync),
    done: impl Fn(&standin::State) -> bool,
) -> Vec<String> {
    let js = JetStream::connect(&server.url(), "kit-test", Duration::from_secs(5)).unwrap();
    js.ensure_consumer(&spec()).unwrap();
    let stop = AtomicBool::new(false);
    let reports = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        scope.spawn(|| {
            consume(
                &js,
                &spec(),
                Duration::from_millis(200),
                &stop,
                work,
                &|c: Consumed<'_>| {
                    reports.lock().unwrap().push(format!("{c:?}"));
                },
            );
        });
        server.until(Duration::from_secs(10), done);
        // Long enough for a second delivery that should not come.
        std::thread::sleep(Duration::from_millis(400));
        stop.store(true, Ordering::Relaxed);
    });
    reports.into_inner().unwrap()
}

#[test]
fn the_durable_consumer_is_made_as_subscribe_makes_it() {
    let server = StandIn::start();
    let js = JetStream::connect(&server.url(), "kit-test", Duration::from_secs(5)).unwrap();
    js.ensure_consumer(&spec()).unwrap();
    let creates = server.state.lock().unwrap().creates.clone();
    assert_eq!(
        creates,
        vec![
            r#"{"stream_name":"INTAFACED_IDENTITY","config":{"durable_name":"agents-identity-self-freeze-frozen","ack_policy":"explicit","deliver_policy":"all","filter_subject":"intafaced.identity.self_freeze.frozen","max_deliver":5,"ack_wait":30000000000}}"#
        ]
    );
}

#[test]
fn a_message_is_worked_once_and_acked_once_after_the_work() {
    let server = StandIn::start();
    server.push(SUBJECT, &envelope(SUBJECT, "freeze:1"));
    let calls = Mutex::new(Vec::new());
    let work = |env: &Envelope| {
        // Not acked yet while the work runs.
        assert!(server.state.lock().unwrap().acks.is_empty());
        calls.lock().unwrap().push(env.idempotency_key.clone());
        Ok(())
    };
    run(&server, &work, |s| !s.acks.is_empty());
    let s = server.state.lock().unwrap();
    assert_eq!(*calls.lock().unwrap(), vec!["freeze:1".to_owned()]);
    assert_eq!(s.deliveries, vec![(1, 1)]);
    assert_eq!(s.acks, vec![(1, 1)]);
    assert!(s.naks.is_empty(), "{:?}", s.naks);
}

#[test]
fn a_failed_work_is_left_unacked_nakd_with_the_backoff_and_delivered_again() {
    let server = StandIn::start();
    server.push(SUBJECT, &envelope(SUBJECT, "freeze:1"));
    let attempts = Mutex::new(0);
    let work = |_: &Envelope| {
        let mut n = attempts.lock().unwrap();
        *n += 1;
        if *n == 1 {
            Err("the database is away".to_owned())
        } else {
            Ok(())
        }
    };
    let reports = run(&server, &work, |s| !s.acks.is_empty());
    let s = server.state.lock().unwrap();
    assert_eq!(s.deliveries, vec![(1, 1), (1, 2)]);
    assert_eq!(
        s.naks,
        vec![(1, 1, r#"-NAK {"delay":1000000000}"#.to_owned())]
    );
    assert_eq!(
        s.acks,
        vec![(1, 2)],
        "acked only after the work that succeeded"
    );
    assert!(
        reports
            .iter()
            .any(|r| r.contains("the database is away") && r.contains("abandoned: false")),
        "{reports:?}"
    );
}

#[test]
fn a_redelivery_after_a_lost_ack_is_not_applied_twice() {
    let server = StandIn::start();
    server.state.lock().unwrap().lose_acks = 1;
    server.push(SUBJECT, &envelope(SUBJECT, "freeze:1"));
    // The work's own idempotency: a seen-set under the envelope's business key, as each service keeps in its store.
    let seen = Mutex::new(BTreeSet::new());
    let applied = Mutex::new(0);
    let work = |env: &Envelope| {
        if seen.lock().unwrap().insert(env.idempotency_key.clone()) {
            *applied.lock().unwrap() += 1;
        }
        Ok(())
    };
    run(&server, &work, |s| !s.acks.is_empty());
    let s = server.state.lock().unwrap();
    assert_eq!(
        s.deliveries,
        vec![(1, 1), (1, 2)],
        "the lost ack delivered it again"
    );
    assert_eq!(*applied.lock().unwrap(), 1);
    assert_eq!(s.acks, vec![(1, 2)]);
}

#[test]
fn an_envelope_of_another_subject_is_refused_never_worked() {
    let server = StandIn::start();
    server.push(
        SUBJECT,
        &envelope("intafaced.identity.self_freeze.lifted", "freeze:1"),
    );
    let worked = Mutex::new(0);
    let work = |_: &Envelope| {
        *worked.lock().unwrap() += 1;
        Ok(())
    };
    let reports = run(&server, &work, |s| !s.naks.is_empty());
    assert_eq!(*worked.lock().unwrap(), 0);
    assert!(server.state.lock().unwrap().acks.is_empty());
    assert!(
        reports.iter().any(|r| r.contains("Subject mismatch")),
        "{reports:?}"
    );
}
