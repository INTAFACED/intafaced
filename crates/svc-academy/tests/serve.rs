//! The process's routes: `/health` and `/ready` as the TypeScript `index.ts` answers them, the door under `/trpc`, and
//! Fastify's not-found outside it; and the door refuses to start on a weak edge secret.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeMap;

use service_kit::server::App;
use svc_academy::db::Store;
use svc_academy::door::{AcademyDoor, DoorConfig, system_now};
use svc_academy::ports::Ports;
use svc_academy::settings::Settings;

fn config(secret: &str) -> DoorConfig {
    DoorConfig {
        edge_secret: secret.to_owned(),
        env: BTreeMap::from([("NODE_ENV".to_owned(), "production".to_owned())]),
        store: Store::Down("down".to_owned()),
        ports: Ports::unwired(),
        settings: Settings::empty(),
        now: system_now,
    }
}

#[test]
fn health_ready_and_the_door() {
    let door = AcademyDoor::new(config("an-academy-serve-test-edge-secret-long")).unwrap();
    let ready_body = door.ready().compact();
    let app = App {
        wire: door,
        service_name: "svc-academy".to_owned(),
        ready_body,
    };
    let health = app.route("GET", "/health", &[], "", "req-1");
    assert_eq!(
        (health.status, health.body.as_str()),
        (200, r#"{"ok":true,"service":"svc-academy"}"#)
    );
    let ready = app.route("GET", "/ready", &[], "", "req-2");
    assert_eq!(
        ready.body,
        r#"{"ready":true,"stream":{"id":"null","usable":false,"constructed":false,"probed":false},"xp":{"id":"none","usable":false,"publishes":"intafaced.identity.xp.earned"},"payments":{"sells":false,"refunds":false}}"#
    );
    let trpc = app.route("GET", "/trpc/health", &[], "", "req-3");
    assert_eq!(
        trpc.body,
        r#"{"result":{"data":{"ok":true,"service":"svc-academy"}}}"#
    );
    // Production sends no stack.
    let anon = app.route("GET", "/trpc/rooms", &[], "", "req-4");
    assert_eq!(anon.status, 401);
    assert!(!anon.body.contains("stack"), "{}", anon.body);
    let missing = app.route("GET", "/nowhere", &[], "", "req-5");
    assert_eq!(missing.status, 404);
}

#[test]
fn a_weak_edge_secret_refuses_to_start() {
    let Err(e) = AcademyDoor::new(config("short")) else {
        panic!("a weak secret started")
    };
    assert!(e.contains("at least 32 characters"), "{e}");
}
