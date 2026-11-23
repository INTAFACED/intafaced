//! The outbox against a real Postgres (`TEST_DATABASE_URL`; skips without one unless `REQUIRE_POSTGRES=1`): an event
//! leaves only with the commit that wrote it, the relay sends it until the bus takes it, a refused one waits its
//! backoff and keeps its error, `send` sends one now whatever its wait, and two relays at once send a row once.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use postgres::{Client, NoTls};
use service_kit::json::Json;
use service_kit::outbox::{Bus, Outbox, Relayed, ddl};
use service_kit::pg::Pool;

fn url() -> Option<String> {
    let url = std::env::var("TEST_DATABASE_URL")
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty());
    let required = std::env::var("REQUIRE_POSTGRES").is_ok_and(|v| v == "1");
    assert!(url.is_some() || !required, "TEST_DATABASE_URL is required");
    url
}

/// A schema of its own holding the kit's table, and a pool on the same database.
fn outbox() -> Option<(Outbox, Pool, Client)> {
    let url = url()?;
    let mut admin = Client::connect(&url, NoTls).unwrap();
    let db: String = admin
        .query_one("SELECT current_database()", &[])
        .unwrap()
        .get(0);
    assert!(db.ends_with("_test"), "refusing to write to database {db}");
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    let schema: &'static str =
        Box::leak(format!("kit_outbox_{}_{nanos:x}", std::process::id()).into_boxed_str());
    admin
        .batch_execute(&format!("CREATE SCHEMA {schema}; {}", ddl(schema)))
        .unwrap();
    Some((Outbox::new(schema), Pool::new(&url, 4), admin))
}

fn envelope(key: &str) -> Json {
    Json::obj([
        ("id", Json::str("00000000-0000-4000-8000-000000000001")),
        ("subject", Json::str("intafaced.test.thing.done")),
        ("version", Json::int(1)),
        ("idempotencyKey", Json::str(key)),
        ("payload", Json::obj([("amount", Json::str("1.5"))])),
    ])
}

/// A bus that records each publish, or refuses every one while `down`.
#[derive(Default)]
struct FakeBus {
    down: AtomicBool,
    sent: Mutex<Vec<(String, String, String)>>,
}

impl Bus for FakeBus {
    fn publish(&self, subject: &str, msg_id: &str, envelope: &Json) -> Result<(), String> {
        if self.down.load(Ordering::SeqCst) {
            return Err("TEST bus down".to_owned());
        }
        self.sent
            .lock()
            .unwrap()
            .push((subject.to_owned(), msg_id.to_owned(), envelope.compact()));
        Ok(())
    }
}

fn row(c: &mut Client, o: &Outbox, key: &str) -> (i32, Option<String>, bool, bool) {
    let r = c
        .query_one(
            &format!(
                "SELECT attempts, last_error, published_at IS NOT NULL, next_attempt_at > now()
                   FROM \"{}\".event_outbox WHERE idempotency_key = $1::text",
                o.schema()
            ),
            &[&key],
        )
        .unwrap();
    (r.get(0), r.get(1), r.get(2), r.get(3))
}

fn unique(tag: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("test.{tag}:{nanos}")
}

#[test]
fn an_event_leaves_only_with_the_commit_that_wrote_it_and_once() {
    let Some((o, pool, mut admin)) = outbox() else {
        return;
    };
    let bus = FakeBus::default();
    let kept = unique("kept");
    let rolled = unique("rolled");

    let mut tx = admin.transaction().unwrap();
    assert!(o.write(&mut tx, &envelope(&rolled)).unwrap());
    tx.rollback().unwrap();
    let mut tx = admin.transaction().unwrap();
    assert!(o.write(&mut tx, &envelope(&kept)).unwrap());
    // The same key again keeps the first row.
    assert!(!o.write(&mut tx, &envelope(&kept)).unwrap());
    tx.commit().unwrap();

    assert_eq!(
        o.relay(&pool, &bus, 10).unwrap(),
        Relayed {
            published: 1,
            failed: 0
        }
    );
    assert_eq!(o.relay(&pool, &bus, 10).unwrap(), Relayed::default());
    let sent = bus.sent.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, "intafaced.test.thing.done");
    assert_eq!(sent[0].1, kept);
    // Published byte for byte as it was written: the key order is the envelope's own.
    assert_eq!(sent[0].2, envelope(&kept).compact());
    assert_eq!(row(&mut admin, &o, &kept), (1, None, true, false));
    // `send` of a sent event answers that the bus has it, and sends nothing.
    assert!(o.send(&pool, &bus, &kept).unwrap());
    assert_eq!(bus.sent.lock().unwrap().len(), 1);
    // A key never written is not sent.
    assert!(!o.send(&pool, &bus, &unique("never")).unwrap());
}

#[test]
fn a_refused_event_keeps_its_error_waits_its_backoff_and_send_sends_it_now() {
    let Some((o, pool, mut admin)) = outbox() else {
        return;
    };
    let bus = FakeBus::default();
    let key = unique("refused");
    let mut tx = admin.transaction().unwrap();
    o.write(&mut tx, &envelope(&key)).unwrap();
    tx.commit().unwrap();

    bus.down.store(true, Ordering::SeqCst);
    assert_eq!(
        o.relay(&pool, &bus, 10).unwrap(),
        Relayed {
            published: 0,
            failed: 1
        }
    );
    assert_eq!(
        row(&mut admin, &o, &key),
        (1, Some("TEST bus down".to_owned()), false, true)
    );
    bus.down.store(false, Ordering::SeqCst);
    // Waiting its backoff, the relay leaves it; `send` does not wait.
    assert_eq!(o.relay(&pool, &bus, 10).unwrap(), Relayed::default());
    assert!(o.send(&pool, &bus, &key).unwrap());
    assert_eq!(row(&mut admin, &o, &key), (2, None, true, true));
    assert_eq!(bus.sent.lock().unwrap().len(), 1);
}

#[test]
fn the_table_refuses_an_envelope_that_names_no_subject_or_key() {
    let Some((o, _pool, mut admin)) = outbox() else {
        return;
    };
    let mut tx = admin.transaction().unwrap();
    let no_key = Json::obj([("subject", Json::str("intafaced.test.thing.done"))]);
    let e = o.write(&mut tx, &no_key).unwrap_err();
    assert_eq!(e.as_db_error().map(|d| d.code().code()), Some("23514"));
}

#[test]
fn two_relays_at_once_send_each_row_once() {
    let Some((o, pool, mut admin)) = outbox() else {
        return;
    };
    let bus = FakeBus::default();
    let mut tx = admin.transaction().unwrap();
    let keys: Vec<String> = (0..40).map(|i| unique(&format!("race{i}"))).collect();
    for k in &keys {
        o.write(&mut tx, &envelope(k)).unwrap();
    }
    tx.commit().unwrap();
    let total = std::thread::scope(|s| {
        let a = s.spawn(|| o.relay(&pool, &bus, 100).unwrap().published);
        let b = s.spawn(|| o.relay(&pool, &bus, 100).unwrap().published);
        a.join().unwrap() + b.join().unwrap()
    });
    assert_eq!(total, 40);
    let mut sent: Vec<String> = bus
        .sent
        .lock()
        .unwrap()
        .iter()
        .map(|s| s.1.clone())
        .collect();
    sent.sort();
    let mut want = keys.clone();
    want.sort();
    assert_eq!(sent, want);
}
