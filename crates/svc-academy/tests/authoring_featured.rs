//! The authoring side of `curriculum/featured.db.test.ts` against a real Postgres: staff choose and clear the hub's
//! featured item (`academy.setFeatured`), each real move is a `featured_events` row with who and why, a blank reason or
//! an unknown item writes nothing, and the hub (`publicHub`, through the door) shows what was chosen. The hub's own
//! reads (an item that left the spine, an item a visitor could not open) are `curriculum_release.rs`'s; they are run
//! here again against the rows the authoring calls leave.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod authoring_kit;

use authoring_kit::{code, data, door, equals, matches, store, v, visitor};
use service_kit::json::Json;
use svc_academy::authoring::{learn_hub, release};
use svc_academy::ports::Ports;
use svc_academy::settings::Settings;

const OPERATOR: &str = "33333333-3333-4333-8333-333333333333";

fn now() -> i64 {
    svc_academy::door::system_now().0
}

fn hub(d: &svc_academy::door::AcademyDoor) -> Json {
    data(&visitor(d, "publicHub", None))
}

#[test]
fn is_empty_until_staff_choose_an_item_then_shows_that_item_and_clears_again() {
    let Some((db, st)) = store() else { return };
    let d = door(&db, Settings::empty(), Ports::unwired());
    equals(&hub(&d), r#"{"featured":null,"lesson":null}"#);

    let chosen = learn_hub::set_featured(&st, &v(r#"{"itemSlug":" foundations-risk-first ","reason":"Start here"}"#), OPERATOR, now()).unwrap();
    matches(&chosen, r#"{"itemSlug":"foundations-risk-first","reason":"Start here"}"#);
    let shown = hub(&d);
    matches(&shown, r#"{"featured":{"slug":"foundations-risk-first","path":"foundations"}}"#);
    assert!(shown.get("featured").unwrap().get("body").is_none());

    learn_hub::set_featured(&st, &v(r#"{"itemSlug":null,"reason":"Rotating"}"#), OPERATOR, now() + 1).unwrap();
    equals(&hub(&d), r#"{"featured":null,"lesson":null}"#);
    // A clear of an empty slot records nothing; every real feature and clear is a featured_events row with who and why.
    learn_hub::set_featured(&st, &v(r#"{"itemSlug":null,"reason":"Again"}"#), OPERATOR, now() + 2).unwrap();
    assert_eq!(
        db.texts(
            "SELECT action || '|' || coalesce(item_slug, '') || '|' || reason || '|' || actor::text FROM academy.featured_events ORDER BY at, action DESC"
        ),
        [
            format!("featured|foundations-risk-first|Start here|{OPERATOR}"),
            format!("cleared|foundations-risk-first|Rotating|{OPERATOR}"),
        ]
    );
}

#[test]
fn refuses_a_blank_reason_and_an_unknown_item_and_writes_nothing() {
    let Some((db, st)) = store() else { return };
    let d = door(&db, Settings::empty(), Ports::unwired());
    assert_eq!(
        code(learn_hub::set_featured(&st, &v(r#"{"itemSlug":"foundations-risk-first","reason":"  "}"#), OPERATOR, now())),
        "academy.reason_required"
    );
    assert_eq!(
        code(learn_hub::set_featured(&st, &v(r#"{"itemSlug":"no-such-item","reason":"x"}"#), OPERATOR, now())),
        "academy.curriculum_not_found"
    );
    equals(&hub(&d), r#"{"featured":null,"lesson":null}"#);
    assert!(db.texts("SELECT 'x' FROM academy.featured_events").is_empty());
}

#[test]
fn drops_an_item_that_has_left_the_spine_instead_of_showing_it() {
    let Some((db, _st)) = store() else { return };
    db.client()
        .batch_execute(&format!(
            "INSERT INTO academy.featured_items (slot, item_slug, reason, chosen_by, chosen_at) \
             VALUES ('hub', 'retired-item', 'old pick', '{OPERATOR}', now())"
        ))
        .unwrap();
    let d = door(&db, Settings::empty(), Ports::unwired());
    equals(&hub(&d), r#"{"featured":null,"lesson":null}"#);
}

#[test]
fn leaves_out_a_chosen_item_a_visitor_could_not_open() {
    let Some((db, st)) = store() else { return };
    let d = door(&db, Settings::empty(), Ports::unwired());
    learn_hub::set_featured(&st, &v(r#"{"itemSlug":"foundations-order-types","reason":"Start here"}"#), OPERATOR, now()).unwrap();
    release::set_item_prerequisites(&st, &v(r#"{"itemSlug":"foundations-order-types","prerequisites":["foundations-risk-first"]}"#))
        .unwrap();
    equals(&hub(&d), r#"{"featured":null,"lesson":null}"#);
}
