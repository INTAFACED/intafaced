//! The engine's events reach its own stream. Each event's subject is the one `packages/events/src/catalog.ts` declares
//! for it (`defineEvent(service, entity, verb, ...)` is `intafaced.<service>.<entity>.<verb>`), and every one is inside
//! the `intafaced.matching.>` stream the binary creates, so JetStream holds it rather than answer that no stream does.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use service_kit::json::Json;
use service_kit::nats::{stream_config, wildcard};
use svc_matching::bus::{STREAM_SERVICE, subject_of};

const CATALOG: &str = include_str!("../../../packages/events/src/catalog.ts");

const EVENTS: [&str; 5] = [
    "orderAccepted",
    "orderFilled",
    "orderCancelled",
    "orderTriggered",
    "spreadFilled",
];

/// `export const <name> = defineEvent('<service>', '<entity>', '<verb>', ...)` as its subject.
fn catalog_subject(name: &str) -> String {
    let head = format!("export const {name} = defineEvent(");
    let at = CATALOG
        .find(&head)
        .unwrap_or_else(|| panic!("{name} is not in catalog.ts"));
    let args: Vec<String> = CATALOG[at + head.len()..]
        .split(',')
        .take(3)
        .map(|a| a.trim().trim_matches('\'').to_owned())
        .collect();
    format!("intafaced.{}.{}.{}", args[0], args[1], args[2])
}

#[test]
fn every_engine_event_is_published_on_its_catalog_subject() {
    for name in EVENTS {
        assert_eq!(
            subject_of(name),
            Some(catalog_subject(name).as_str()),
            "{name}"
        );
    }
    assert_eq!(subject_of("notAnEvent"), None);
}

#[test]
fn every_engine_event_lands_in_the_stream_the_binary_creates() {
    let config = stream_config(STREAM_SERVICE, "INTAFACED");
    let Some(Json::Array(subjects)) = config.get("subjects") else {
        panic!("the stream names its subjects")
    };
    assert_eq!(subjects, &vec![Json::str(wildcard(STREAM_SERVICE))]);
    let within = wildcard(STREAM_SERVICE).trim_end_matches('>').to_owned();
    for name in EVENTS {
        let subject = subject_of(name).unwrap();
        assert!(
            subject.starts_with(&within) && subject.len() > within.len(),
            "{name}: {subject} is outside {}",
            wildcard(STREAM_SERVICE)
        );
    }
}
