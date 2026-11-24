//! The bus events the binary takes are the catalog's (`packages/events/src/catalog.ts`): each one's subject, its
//! stream and its version are read from its `defineEvent(service, entity, verb, version, …)`, and its durable is the one
//! the TypeScript service took it under, so a wrong subject, stream or durable fails here.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use service_kit::nats::stream_name;
use svc_agents::bus::{FILL_SETTLED, SELF_FREEZE_APPLIED, TAKEN, Taken};

fn read(path: &str) -> String {
    std::fs::read_to_string(format!("{}/../../{path}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

/// `export const <event> = defineEvent('service', 'entity', 'verb', version, …)`: (service, entity, verb, version).
fn defined(catalog: &str, event: &str) -> (String, String, String, i64) {
    let head = format!("export const {event} = defineEvent(");
    let at = catalog
        .find(&head)
        .unwrap_or_else(|| panic!("{event} is not in the catalog"));
    let args: Vec<String> = catalog[at + head.len()..]
        .split(',')
        .take(4)
        .map(|a| a.trim().trim_matches('\'').to_owned())
        .collect();
    (
        args[0].clone(),
        args[1].clone(),
        args[2].clone(),
        args[3].parse().unwrap(),
    )
}

/// Where the catalog and `taken` disagree, or none.
fn mismatch(catalog: &str, taken: &Taken) -> Option<String> {
    let (service, entity, verb, version) = defined(catalog, taken.event);
    let subject = format!("intafaced.{service}.{entity}.{verb}");
    let spec = taken.spec("INTAFACED");
    let want = (subject.clone(), stream_name(&service, "INTAFACED"), version);
    let got = (spec.filter_subject, spec.stream, spec.version);
    (got != want).then(|| format!("{}: catalog {want:?}, Rust {got:?}", taken.event))
}

#[test]
fn each_event_taken_is_its_catalog_entry() {
    let catalog = read("packages/events/src/catalog.ts");
    for taken in TAKEN {
        assert_eq!(mismatch(&catalog, &taken), None);
    }
    assert_eq!(
        SELF_FREEZE_APPLIED.subject(),
        "intafaced.identity.self_freeze.frozen"
    );
    assert_eq!(FILL_SETTLED.spec("INTAFACED").stream, "INTAFACED_TRADE");
}

#[test]
fn a_wrong_subject_or_version_is_caught() {
    let catalog = read("packages/events/src/catalog.ts");
    let wrong_verb = Taken {
        verb: "lifted",
        ..SELF_FREEZE_APPLIED
    };
    assert!(mismatch(&catalog, &wrong_verb).is_some());
    let wrong_service = Taken {
        service: "ledger",
        ..FILL_SETTLED
    };
    assert!(mismatch(&catalog, &wrong_service).is_some());
    let wrong_version = Taken {
        version: 2,
        ..FILL_SETTLED
    };
    assert!(mismatch(&catalog, &wrong_version).is_some());
}

/// The durables the TypeScript service took them under (its `subscribe` calls in `own/self-freeze.ts` and `index.ts`,
/// deleted in the switch): the streams already hold these consumers, so a renamed one would start a new consumer and
/// replay or skip what the old one had acked.
#[test]
fn each_durable_is_the_one_the_stream_already_holds() {
    let held = [
        ("selfFreezeApplied", "agents-identity-self-freeze-frozen"),
        (
            "supportAccountFrozen",
            "agents-identity-support-account-freeze-frozen",
        ),
        ("fillSettled", "agents-own-trigger-fill-settled"),
    ];
    assert_eq!(
        TAKEN.len(),
        held.len(),
        "each event taken has its held durable"
    );
    for taken in TAKEN {
        let want = held
            .iter()
            .find(|(event, _)| *event == taken.event)
            .unwrap_or_else(|| panic!("{} has no held durable", taken.event))
            .1;
        assert_eq!(taken.durable, want, "{}", taken.event);
    }
}
