//! `curriculum/course-learners.db.test.ts` (AC-catalogue-03, AC-enrolment-01): a published course staff made in the
//! public catalogue, its page, and enrolling, against a real Postgres (`TEST_DATABASE_URL`; skips without one unless
//! `REQUIRE_POSTGRES=1`). Course payments are not set up here, as the TypeScript test builds `CourseLearners` without
//! purchases.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod learner_courses;
mod support;

use learner_courses::{A, COURSE, L, LATER, NOW, NOW_ISO, code, draft_with_outline, published};
use service_kit::json::{self, Json};
use support::TestDb;
use svc_academy::db::Store;
use svc_academy::learner::learners::CourseLearners;
use svc_academy::learner::preview::CoursePreview;
use svc_academy::learner::purchases::{CoursePurchases, Deps};

fn parse(text: &str) -> Json {
    json::parse(text).unwrap()
}

fn locks(view: &Json) -> Vec<Json> {
    let Some(Json::Array(sections)) = view.get("sections") else {
        panic!("sections")
    };
    let Some(Json::Array(items)) = sections[0].get("items") else {
        panic!("items")
    };
    items
        .iter()
        .map(|i| i.get("lock").unwrap().clone())
        .collect()
}

fn unwired(store: &Store) -> CoursePurchases<'_> {
    CoursePurchases {
        pool: store,
        deps: Deps {
            settings: None,
            chain: None,
            ledger: None,
            refunds: None,
            wallets: None,
        },
    }
}

#[test]
fn a_draft_is_neither_listed_nor_found_published_it_is_both() {
    let Some(db) = TestDb::migrated() else { return };
    let mut c = db.client();
    draft_with_outline(&mut c);
    let store = Store::Pool(db.pool());
    let purchases = unwired(&store);
    let learners = CourseLearners {
        pool: &store,
        preview: CoursePreview { pool: &store },
        purchases: &purchases,
    };
    assert_eq!(learners.published(10).unwrap(), Json::Array(vec![]));
    assert_eq!(
        code(&learners.page("risk-basics", None, NOW).unwrap_err()),
        "academy.course_not_found"
    );
    assert_eq!(
        code(&learners.terms(L, "risk-basics").unwrap_err()),
        "academy.course_not_found"
    );
    c.batch_execute(&format!(
        "DELETE FROM academy.course_sections WHERE course_id = '{COURSE}'; \
         DELETE FROM academy.course_events WHERE course_id = '{COURSE}'; \
         DELETE FROM academy.courses WHERE id = '{COURSE}';"
    ))
    .unwrap();

    published(&mut c);
    assert_eq!(
        learners.published(10).unwrap(),
        parse(
            r#"[{"slug":"risk-basics","title":"Risk basics","summary":null,"thumbnailUrl":null,"pricing":"free",
            "price":null,"priceAsset":null,"items":2}]"#
        )
    );
    let page = learners.page("risk-basics", None, NOW).unwrap();
    assert_eq!(
        locks(&page),
        vec![Json::Null, Json::str("enrol"), Json::str("enrol")]
    );
    assert_eq!(
        code(&learners.page("no-such-course", None, NOW).unwrap_err()),
        "academy.course_not_found"
    );
}

#[test]
fn enrols_on_the_free_track_once_opens_what_is_released_to_that_learner_and_leaves_by_the_enrolment_it_ends()
 {
    let Some(db) = TestDb::migrated() else { return };
    let mut c = db.client();
    published(&mut c);
    let store = Store::Pool(db.pool());
    let purchases = unwired(&store);
    let learners = CourseLearners {
        pool: &store,
        preview: CoursePreview { pool: &store },
        purchases: &purchases,
    };
    assert_eq!(
        learners.terms(L, "risk-basics").unwrap(),
        parse(
            r#"{"slug":"risk-basics","startsAt":null,"seatCap":null,"seatsRemaining":null,"closed":null,
            "tracks":[{"track":"audit","free":true,"closed":null}],"enrolment":null,"activationMail":"vendor.email"}"#
        )
    );
    let first = learners.enrol(L, "risk-basics", "audit", NOW).unwrap();
    assert_eq!(
        first.get("enrolment"),
        Some(&parse(&format!(
            r#"{{"track":"audit","enrolledAt":"{NOW_ISO}"}}"#
        )))
    );
    // A repeat answers with the same enrolment.
    assert_eq!(
        learners.enrol(L, "risk-basics", "audit", LATER).unwrap(),
        first
    );
    assert_eq!(
        db.texts("SELECT count(*)::text FROM academy.course_enrolments"),
        vec!["1".to_owned()]
    );
    assert_eq!(
        locks(&learners.page("risk-basics", Some(L), NOW).unwrap()),
        vec![Json::Null; 3]
    );
    assert_eq!(
        locks(&learners.page("risk-basics", Some(A), NOW).unwrap()),
        vec![Json::Null, Json::str("enrol"), Json::str("enrol")]
    );

    let left = learners.leave(L, "risk-basics", NOW_ISO, LATER).unwrap();
    assert_eq!(left.get("enrolment"), Some(&Json::Null));
    // Enrolled again, a late repeat of the first leave does not end the new enrolment.
    let again = learners.enrol(L, "risk-basics", "audit", LATER).unwrap();
    assert_eq!(
        learners.leave(L, "risk-basics", NOW_ISO, LATER).unwrap(),
        again
    );
}

#[test]
fn a_paid_course_keeps_its_paid_track_closed_payments_are_off_a_closed_track_refuses() {
    let Some(db) = TestDb::migrated() else { return };
    let mut c = db.client();
    published(&mut c);
    c.batch_execute(&format!(
        "UPDATE academy.courses SET pricing = 'paid', price = '25.5', price_asset = 'USDT' WHERE id = '{COURSE}'"
    ))
    .unwrap();
    let store = Store::Pool(db.pool());
    let purchases = unwired(&store);
    let learners = CourseLearners {
        pool: &store,
        preview: CoursePreview { pool: &store },
        purchases: &purchases,
    };
    let terms = learners.terms(L, "risk-basics").unwrap();
    assert_eq!(
        terms.get("tracks"),
        Some(&parse(
            r#"[{"track":"audit","free":true,"closed":null},{"track":"certificate","free":false,"closed":"payments_off"}]"#
        ))
    );
    let Json::Array(cards) = learners.published(10).unwrap() else {
        panic!("cards")
    };
    assert_eq!(cards[0].get("pricing"), Some(&Json::str("paid")));
    assert_eq!(cards[0].get("price"), Some(&Json::str("25.5")));
    assert_eq!(cards[0].get("priceAsset"), Some(&Json::str("USDT")));
    assert_eq!(
        code(
            &learners
                .enrol(L, "risk-basics", "certificate", NOW)
                .unwrap_err()
        ),
        "academy.enrolment_closed"
    );
    assert_ne!(
        learners
            .enrol(L, "risk-basics", "audit", NOW)
            .unwrap()
            .get("enrolment"),
        Some(&Json::Null)
    );
}
