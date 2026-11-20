//! Ambassadors and residencies through the door: the programme and residency desks against Postgres
//! (`academy-service.ts`'s SQL, `learning/customer.db.test.ts`'s cohorts), the pay doors (`ifc-pay-public-door.test.ts`
//! and the ambassador part of `router.mount.test.ts`), and the source scans (`ledger-isolation.test.ts`,
//! `mount-vs-tracker.test.ts`, `ambassador-rate-law-compose-pin.test.ts`, `list-ambassadors-limit-unset.test.ts`).
#![allow(clippy::unwrap_used, reason = "a test")]

#[path = "prog_support/mod.rs"]
mod support;

use service_kit::json::Json;
use svc_academy::db::Store;
use svc_academy::ports::{Ports, StubApprovals};
use svc_academy::programme::ambassadors::ifc_pay::{
    pay_looks_payable, pay_refuse_code, unset_rates_public_door_holds,
};
use svc_academy::programme::ambassadors::{IFC_PAY_LAW_KEY, REVENUE_SHARE_LAW_KEY, check_laws};

const APPROVER: &str = "99999999-9999-4999-8999-999999999999";
const AMB: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AMB2: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const APPLICANT: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const STATEMENT: &str = "I host weekly risk-first lobbies and can commit six hours a week.";

fn approved() -> Ports {
    Ports {
        approvals: Box::new(StubApprovals(APPROVER.to_owned())),
        ..Ports::unwired()
    }
}

fn s(v: &str) -> Json {
    Json::str(v)
}

fn with_approval(fields: &[(&str, Json)]) -> Json {
    let mut all: Vec<(String, Json)> = fields
        .iter()
        .map(|(k, v)| ((*k).to_owned(), v.clone()))
        .collect();
    all.push(("approvalId".to_owned(), s("approval-1")));
    all.push(("operationId".to_owned(), s("operation-1")));
    Json::Object(all)
}

fn text<'a>(j: &'a Json, key: &str) -> Option<&'a str> {
    match j.get(key) {
        Some(Json::String(v)) => Some(v.as_str()),
        _ => None,
    }
}

fn is_iso_ms(v: &str) -> bool {
    let b = v.as_bytes();
    b.len() == 24 && b.get(10) == Some(&b'T') && b.get(19) == Some(&b'.') && b.last() == Some(&b'Z')
}

fn applicant() -> Vec<(String, String)> {
    support::principal(APPLICANT, &["academy:read", "academy:write"], false)
}

fn reader() -> Vec<(String, String)> {
    support::principal(OTHER, &["academy:read", "academy:write"], false)
}

/// A door over no database: the pay doors never reach one.
fn pay_door(settings: &[(&str, Json)]) -> svc_academy::door::AcademyDoor {
    support::door_over(
        Store::Down("the pay doors must not reach the database".to_owned()),
        Ports::unwired(),
        support::settings(settings),
    )
}

const PUBLISHED_IFC: &str =
    r#"{"published":true,"sessionCredit":"7.25000000","asset":"IFC","period":"session"}"#;

// ── Programme: appoint, freeze, unfreeze (programme.test.ts, unfreeze.test.ts on Postgres) ──

#[test]
fn appoint_freeze_unfreeze_and_the_badge_tracks_active_only() {
    let Some(db) = support::TestDb::new() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    let door = db.door(approved(), support::settings(&[]));
    let op = support::operator();
    let badge = |door: &svc_academy::door::AcademyDoor| {
        support::data(&support::call(
            door,
            &reader(),
            "ambassadorBadge",
            true,
            Some(&Json::obj([("userId", s(AMB))])),
        ))
        .clone()
    };
    assert_eq!(
        badge(&door).compact(),
        Json::obj([
            ("userId", s(AMB)),
            ("isAmbassador", Json::Bool(false)),
            ("status", Json::Null)
        ])
        .compact()
    );

    let appointed = support::call(
        &door,
        &op,
        "appointAmbassador",
        false,
        Some(&with_approval(&[("userId", s(AMB))])),
    );
    let row = support::data(&appointed);
    assert_eq!(text(row, "status"), Some("active"));
    assert_eq!(text(row, "appointedBy"), Some(support::OPERATOR));
    assert_eq!(
        text(row, "confirmOperatorId"),
        Some(APPROVER),
        "the approver, never a typed-in name"
    );
    assert!(is_iso_ms(text(row, "appointedAt").unwrap()));
    assert_eq!(row.get("frozenAt"), Some(&Json::Null));
    let keys: Vec<&str> = match row {
        Json::Object(f) => f.iter().map(|(k, _)| k.as_str()).collect(),
        _ => vec![],
    };
    assert_eq!(
        keys,
        [
            "userId",
            "status",
            "appointedBy",
            "appointedAt",
            "frozenAt",
            "frozenBy",
            "freezeReason",
            "confirmOperatorId"
        ]
    );
    assert_eq!(badge(&door).get("isAmbassador"), Some(&Json::Bool(true)));

    let again = support::call(
        &door,
        &op,
        "appointAmbassador",
        false,
        Some(&with_approval(&[("userId", s(AMB))])),
    );
    assert_eq!(
        support::cause(&again).as_deref(),
        Some("academy.ambassador_already_active")
    );

    let frozen = support::call(
        &door,
        &op,
        "freezeAmbassador",
        false,
        Some(&with_approval(&[
            ("userId", s(AMB)),
            ("reason", s("  policy hold  ")),
        ])),
    );
    let row = support::data(&frozen);
    assert_eq!(text(row, "status"), Some("frozen"));
    assert_eq!(text(row, "freezeReason"), Some("policy hold"));
    assert_eq!(text(row, "frozenBy"), Some(support::OPERATOR));
    assert!(is_iso_ms(text(row, "frozenAt").unwrap()));
    let b = badge(&door);
    assert_eq!(b.get("isAmbassador"), Some(&Json::Bool(false)));
    assert_eq!(text(&b, "status"), Some("frozen"));

    let listed = support::call(
        &door,
        &op,
        "ambassadors",
        true,
        Some(&Json::obj([
            ("status", s("frozen")),
            ("limit", Json::int(10)),
        ])),
    );
    assert!(matches!(support::data(&listed), Json::Array(a) if a.len() == 1));
    let none_active = support::call(
        &door,
        &op,
        "ambassadors",
        true,
        Some(&Json::obj([
            ("status", s("active")),
            ("limit", Json::int(10)),
        ])),
    );
    assert!(matches!(support::data(&none_active), Json::Array(a) if a.is_empty()));

    let unfrozen = support::call(
        &door,
        &op,
        "unfreezeAmbassador",
        false,
        Some(&with_approval(&[("userId", s(AMB))])),
    );
    let row = support::data(&unfrozen);
    assert_eq!(text(row, "status"), Some("active"));
    assert_eq!(row.get("freezeReason"), Some(&Json::Null));
    assert_eq!(row.get("frozenAt"), Some(&Json::Null));
    assert_eq!(row.get("frozenBy"), Some(&Json::Null));
    let b = badge(&door);
    assert_eq!(b.get("isAmbassador"), Some(&Json::Bool(true)));
    assert_eq!(text(&b, "status"), Some("active"));
}

#[test]
fn re_appoint_of_a_frozen_row_refuses_and_the_freeze_audit_is_kept() {
    let Some(db) = support::TestDb::new() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    let door = db.door(approved(), support::settings(&[]));
    let op = support::operator();
    support::data(&support::call(
        &door,
        &op,
        "appointAmbassador",
        false,
        Some(&with_approval(&[("userId", s(AMB))])),
    ));
    support::data(&support::call(
        &door,
        &op,
        "freezeAmbassador",
        false,
        Some(&with_approval(&[
            ("userId", s(AMB)),
            ("reason", s("policy hold")),
        ])),
    ));
    let audit = |db: &support::TestDb| -> (
        String,
        Option<String>,
        Option<String>,
        Option<std::time::SystemTime>,
    ) {
        let r = db
            .client()
            .query_one(
                "SELECT status::text, freeze_reason, frozen_by::text, frozen_at FROM academy.ambassadors WHERE user_id = $1::text::uuid",
                &[&AMB],
            )
            .unwrap();
        (r.get(0), r.get(1), r.get(2), r.get(3))
    };
    let before = audit(&db);
    let refused = support::call(
        &door,
        &op,
        "appointAmbassador",
        false,
        Some(&with_approval(&[("userId", s(AMB))])),
    );
    assert_eq!(refused.0, 409, "{}", refused.1.compact());
    assert_eq!(
        support::cause(&refused).as_deref(),
        Some("academy.ambassador_already_frozen")
    );
    let after = audit(&db);
    assert_eq!(after, before);
    assert_eq!(after.0, "frozen");
    assert_eq!(after.1.as_deref(), Some("policy hold"));
    assert_eq!(after.2.as_deref(), Some(support::OPERATOR));
}

#[test]
fn freeze_and_unfreeze_refuse_a_missing_row_a_repeat_and_a_short_reason() {
    let Some(db) = support::TestDb::new() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    let door = db.door(approved(), support::settings(&[]));
    let op = support::operator();
    let unfreeze = |u: &str| {
        support::call(
            &door,
            &op,
            "unfreezeAmbassador",
            false,
            Some(&with_approval(&[("userId", s(u))])),
        )
    };
    let freeze = |u: &str, reason: &str| {
        support::call(
            &door,
            &op,
            "freezeAmbassador",
            false,
            Some(&with_approval(&[("userId", s(u)), ("reason", s(reason))])),
        )
    };
    assert_eq!(
        support::cause(&unfreeze(AMB)).as_deref(),
        Some("academy.ambassador_not_found")
    );
    assert_eq!(
        support::cause(&freeze(AMB, "policy hold")).as_deref(),
        Some("academy.ambassador_not_found")
    );
    support::data(&support::call(
        &door,
        &op,
        "appointAmbassador",
        false,
        Some(&with_approval(&[("userId", s(AMB))])),
    ));
    let not_frozen = unfreeze(AMB);
    assert_eq!(
        support::cause(&not_frozen).as_deref(),
        Some("academy.ambassador_invalid")
    );
    assert_eq!(
        support::cause(&freeze(AMB, "  x  ")).as_deref(),
        Some("academy.ambassador_invalid")
    );
    support::data(&freeze(AMB, "policy hold"));
    assert_eq!(
        support::cause(&freeze(AMB, "policy hold")).as_deref(),
        Some("academy.ambassador_already_frozen")
    );
}

#[test]
fn an_unwired_approval_refuses_before_anything_is_stored() {
    let Some(db) = support::TestDb::new() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    let door = db.door(Ports::unwired(), support::settings(&[]));
    let op = support::operator();
    for (path, input) in [
        ("appointAmbassador", with_approval(&[("userId", s(AMB))])),
        (
            "freezeAmbassador",
            with_approval(&[("userId", s(AMB)), ("reason", s("policy hold"))]),
        ),
        ("unfreezeAmbassador", with_approval(&[("userId", s(AMB))])),
        (
            "decideResidency",
            with_approval(&[
                ("id", s("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")),
                ("decision", s("accepted")),
            ]),
        ),
    ] {
        let a = support::call(&door, &op, path, false, Some(&input));
        assert_eq!(a.0, 412, "{path}: {}", a.1.compact());
        assert_eq!(
            support::cause(&a).as_deref(),
            Some("action_approval.unwired"),
            "{path}"
        );
    }
    let n: i64 = db
        .client()
        .query_one("SELECT count(*) FROM academy.ambassadors", &[])
        .unwrap()
        .get(0);
    assert_eq!(n, 0);
}

#[test]
fn the_ambassadors_list_refuses_an_unset_limit_and_keeps_a_published_one() {
    let Some(db) = support::TestDb::new() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    let door = db.door(approved(), support::settings(&[]));
    let op = support::operator();
    for u in [AMB, AMB2] {
        support::data(&support::call(
            &door,
            &op,
            "appointAmbassador",
            false,
            Some(&with_approval(&[("userId", s(u))])),
        ));
    }
    for input in [
        None,
        Some(Json::obj([("limit", Json::int(0))])),
        Some(Json::obj([("limit", Json::int(-1))])),
    ] {
        let a = support::call(&door, &op, "ambassadors", true, input.as_ref());
        assert_eq!(
            support::cause(&a).as_deref(),
            Some("academy.ambassadors_list_limit_unset")
        );
    }
    let one = support::call(
        &door,
        &op,
        "ambassadors",
        true,
        Some(&Json::obj([("limit", Json::int(1))])),
    );
    assert!(matches!(support::data(&one), Json::Array(a) if a.len() == 1));
    let all = support::call(
        &door,
        &op,
        "ambassadors",
        true,
        Some(&Json::obj([("limit", Json::int(500))])),
    );
    assert!(matches!(support::data(&all), Json::Array(a) if a.len() == 2));
}

// ── Residencies (residency.test.ts on Postgres) ──

fn apply(
    door: &svc_academy::door::AcademyDoor,
    who: &[(String, String)],
    cohort: &str,
) -> (u16, Json) {
    support::call(
        door,
        who,
        "applyResidency",
        false,
        Some(&Json::obj([
            ("cohortSlug", s(cohort)),
            ("statement", s(STATEMENT)),
        ])),
    )
}

#[test]
fn apply_then_a_second_open_application_refuses_and_decide_accepts() {
    let Some(db) = support::TestDb::new() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    let door = db.door(approved(), support::settings(&[]));
    let op = support::operator();
    let first = apply(&door, &applicant(), "  Bali-2026 ");
    let row = support::data(&first).clone();
    assert_eq!(text(&row, "status"), Some("applied"));
    assert_eq!(text(&row, "cohortSlug"), Some("bali-2026"));
    assert_eq!(text(&row, "userId"), Some(APPLICANT));
    assert!(is_iso_ms(text(&row, "appliedAt").unwrap()));
    let keys: Vec<&str> = match &row {
        Json::Object(f) => f.iter().map(|(k, _)| k.as_str()).collect(),
        _ => vec![],
    };
    assert_eq!(
        keys,
        [
            "id",
            "userId",
            "cohortSlug",
            "statement",
            "status",
            "appliedAt",
            "decidedAt",
            "decidedBy",
            "decisionNote"
        ]
    );

    let dup = apply(&door, &applicant(), "bali-2026");
    assert_eq!(dup.0, 409, "{}", dup.1.compact());
    assert_eq!(
        support::cause(&dup).as_deref(),
        Some("academy.residency_already_open")
    );
    let n: i64 = db
        .client()
        .query_one("SELECT count(*) FROM academy.residency_applications", &[])
        .unwrap()
        .get(0);
    assert_eq!(n, 1, "the unique violation stored nothing");

    let id = text(&row, "id").unwrap().to_owned();
    let decide = |decision: &str, note: Option<&str>| {
        let mut fields = vec![("id", s(&id)), ("decision", s(decision))];
        if let Some(n) = note {
            fields.push(("note", s(n)));
        }
        support::call(
            &door,
            &op,
            "decideResidency",
            false,
            Some(&with_approval(&fields)),
        )
    };
    let accepted = decide("accepted", Some("  strong host  "));
    let d = support::data(&accepted);
    assert_eq!(text(d, "status"), Some("accepted"));
    assert_eq!(text(d, "decidedBy"), Some(support::OPERATOR));
    assert_eq!(text(d, "decisionNote"), Some("strong host"));
    assert_eq!(text(d, "confirmOperatorId"), Some(APPROVER));
    let twice = decide("rejected", None);
    assert_eq!(
        support::cause(&twice).as_deref(),
        Some("academy.residency_not_pending")
    );

    let missing = support::call(
        &door,
        &op,
        "decideResidency",
        false,
        Some(&with_approval(&[
            ("id", s("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")),
            ("decision", s("accepted")),
        ])),
    );
    assert_eq!(
        support::cause(&missing).as_deref(),
        Some("academy.residency_not_found")
    );

    let again = apply(&door, &applicant(), "bali-2026");
    assert_eq!(
        text(support::data(&again), "status"),
        Some("applied"),
        "a decided application frees the slot"
    );
}

#[test]
fn a_blank_note_is_stored_as_none() {
    let Some(db) = support::TestDb::new() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    let door = db.door(approved(), support::settings(&[]));
    let row = support::data(&apply(&door, &applicant(), "bali-2026")).clone();
    let rejected = support::call(
        &door,
        &support::operator(),
        "decideResidency",
        false,
        Some(&with_approval(&[
            ("id", row.get("id").unwrap().clone()),
            ("decision", s("rejected")),
            ("note", s("   ")),
        ])),
    );
    let d = support::data(&rejected);
    assert_eq!(text(d, "status"), Some("rejected"));
    assert_eq!(d.get("decisionNote"), Some(&Json::Null));
}

#[test]
fn a_short_statement_or_bad_slug_refuses_before_the_insert() {
    let Some(db) = support::TestDb::new() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    let door = db.door(approved(), support::settings(&[]));
    let short = support::call(
        &door,
        &applicant(),
        "applyResidency",
        false,
        Some(&Json::obj([
            ("cohortSlug", s("bali-2026")),
            ("statement", s("   too short now        ")),
        ])),
    );
    assert_eq!(
        support::cause(&short).as_deref(),
        Some("academy.residency_invalid")
    );
    let slug = support::call(
        &door,
        &applicant(),
        "applyResidency",
        false,
        Some(&Json::obj([
            ("cohortSlug", s("-bali")),
            ("statement", s(STATEMENT)),
        ])),
    );
    assert_eq!(
        support::cause(&slug).as_deref(),
        Some("academy.residency_invalid")
    );
    let n: i64 = db
        .client()
        .query_one("SELECT count(*) FROM academy.residency_applications", &[])
        .unwrap()
        .get(0);
    assert_eq!(n, 0);
}

#[test]
fn withdraw_is_the_applicants_own_and_only_while_applied() {
    let Some(db) = support::TestDb::new() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    let door = db.door(approved(), support::settings(&[]));
    let row = support::data(&apply(&door, &applicant(), "bali-2026")).clone();
    let id = Json::obj([("id", row.get("id").unwrap().clone())]);
    let not_theirs = support::call(&door, &reader(), "withdrawResidency", false, Some(&id));
    assert_eq!(
        support::cause(&not_theirs).as_deref(),
        Some("academy.residency_not_found"),
        "someone else's reads as missing"
    );
    let w = support::call(&door, &applicant(), "withdrawResidency", false, Some(&id));
    let d = support::data(&w);
    assert_eq!(text(d, "status"), Some("withdrawn"));
    assert_eq!(text(d, "decidedBy"), Some(APPLICANT));
    assert_eq!(text(d, "decisionNote"), Some("withdrawn by applicant"));
    let twice = support::call(&door, &applicant(), "withdrawResidency", false, Some(&id));
    assert_eq!(
        support::cause(&twice).as_deref(),
        Some("academy.residency_not_pending")
    );
    let missing = support::call(
        &door,
        &applicant(),
        "withdrawResidency",
        false,
        Some(&Json::obj([(
            "id",
            s("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
        )])),
    );
    assert_eq!(
        support::cause(&missing).as_deref(),
        Some("academy.residency_not_found")
    );
}

#[test]
fn my_and_open_residencies_list_in_order_at_a_published_limit() {
    let Some(db) = support::TestDb::new() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    let door = db.door(approved(), support::settings(&[]));
    let op = support::operator();
    let a = support::data(&apply(&door, &applicant(), "bali-2026")).clone();
    let b = support::data(&apply(&door, &applicant(), "lisbon-2026")).clone();
    support::data(&apply(&door, &reader(), "bali-2026"));
    let ids = |answer: &(u16, Json)| -> Vec<String> {
        match support::data(answer) {
            Json::Array(rows) => rows
                .iter()
                .filter_map(|r| text(r, "id").map(str::to_owned))
                .collect(),
            _ => vec![],
        }
    };
    let mine = support::call(
        &door,
        &applicant(),
        "myResidencies",
        true,
        Some(&Json::obj([("limit", Json::int(10))])),
    );
    assert_eq!(
        ids(&mine),
        [text(&b, "id").unwrap(), text(&a, "id").unwrap()],
        "newest first"
    );
    let mine_one = support::call(
        &door,
        &applicant(),
        "myResidencies",
        true,
        Some(&Json::obj([("limit", Json::int(1))])),
    );
    assert_eq!(ids(&mine_one).len(), 1);
    for input in [None, Some(Json::obj([("limit", Json::int(0))]))] {
        let a = support::call(&door, &applicant(), "myResidencies", true, input.as_ref());
        assert_eq!(
            support::cause(&a).as_deref(),
            Some("academy.my_residencies_list_limit_unset")
        );
        let o = support::call(&door, &op, "openResidencies", true, input.as_ref());
        assert_eq!(
            support::cause(&o).as_deref(),
            Some("academy.open_residencies_list_limit_unset")
        );
    }
    let open = support::call(
        &door,
        &op,
        "openResidencies",
        true,
        Some(&Json::obj([("limit", Json::int(10))])),
    );
    let open_ids = ids(&open);
    assert_eq!(open_ids.len(), 3);
    assert_eq!(
        open_ids.first().map(String::as_str),
        text(&a, "id"),
        "oldest first"
    );
    let bali = support::call(
        &door,
        &op,
        "openResidencies",
        true,
        Some(&Json::obj([
            ("cohortSlug", s(" BALI-2026 ")),
            ("limit", Json::int(10)),
        ])),
    );
    assert_eq!(
        ids(&bali).len(),
        2,
        "the cohort filter is trimmed and lower-cased"
    );
}

#[test]
fn cohorts_list_open_published_rows_and_count_seats_only_from_a_set_capacity() {
    let Some(db) = support::TestDb::new() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    db.client()
        .batch_execute(
            "INSERT INTO academy.residency_cohorts (slug, status, published, starts_at, ends_at, capacity, entry_rules) VALUES
               ('open-set', 'open', true, '2026-11-01T00:00:00Z', '2026-11-08T00:00:00Z', 2, 'statement required'),
               ('open-unset', 'open', true, NULL, NULL, NULL, NULL),
               ('closed-one', 'closed', true, '2026-11-01T00:00:00Z', NULL, 4, 'closed'),
               ('draft-one', 'open', false, '2026-11-01T00:00:00Z', NULL, 4, 'draft')",
        )
        .unwrap();
    let door = db.door(Ports::unwired(), support::settings(&[]));
    let list = |door: &svc_academy::door::AcademyDoor| {
        support::data(&support::call(
            door,
            &reader(),
            "residencyCohorts",
            true,
            Some(&Json::obj([("limit", Json::int(10))])),
        ))
        .clone()
    };
    let before = list(&door);
    let Json::Array(rows) = &before else {
        panic!("{}", before.compact())
    };
    let slugs: Vec<&str> = rows.iter().filter_map(|r| text(r, "slug")).collect();
    assert_eq!(slugs, ["open-set", "open-unset"]);
    let unset = rows
        .iter()
        .find(|r| text(r, "slug") == Some("open-unset"))
        .unwrap();
    for key in ["capacity", "seatsLeft", "startsAt", "entryRules"] {
        assert_eq!(unset.get(key), Some(&Json::Null), "{key}");
    }
    let set = rows
        .iter()
        .find(|r| text(r, "slug") == Some("open-set"))
        .unwrap();
    assert_eq!(text(set, "startsAt"), Some("2026-11-01T00:00:00.000Z"));
    assert_eq!(set.get("capacity"), Some(&Json::int(2)));
    assert_eq!(set.get("seatsLeft"), Some(&Json::int(2)));
    db.client()
        .execute(
            "INSERT INTO academy.residency_applications (user_id, cohort_slug, statement, status)
             VALUES ($1::text::uuid, 'open-set', 'I want a seat in this cohort.', 'applied')",
            &[&OTHER],
        )
        .unwrap();
    let after = list(&door);
    let Json::Array(rows) = &after else {
        panic!("{}", after.compact())
    };
    let set = rows
        .iter()
        .find(|r| text(r, "slug") == Some("open-set"))
        .unwrap();
    assert_eq!(set.get("seatsLeft"), Some(&Json::int(1)));
    assert!(!after.compact().contains(OTHER));
    let unset_limit = support::call(
        &door,
        &reader(),
        "residencyCohorts",
        true,
        Some(&Json::obj([])),
    );
    assert_eq!(
        support::cause(&unset_limit).as_deref(),
        Some("academy.residency_cohorts_list_limit_unset")
    );
}

// ── Pay doors: never payable while the owner's rates are unset (ifc-pay-public-door.test.ts, router.mount.test.ts) ──

fn admin() -> Vec<(String, String)> {
    support::principal(
        support::OPERATOR,
        &["admin:read", "admin:write", "academy:read", "academy:write"],
        false,
    )
}

#[test]
fn the_public_quote_refuses_unset_ifc_and_revenue_share_without_magnitudes() {
    let door = pay_door(&[]);
    let ifc = support::data(&support::call(
        &door,
        &reader(),
        "ambassadorPayQuote",
        true,
        Some(&Json::obj([("kind", s("ifc_pay"))])),
    ))
    .clone();
    assert_eq!(
        text(&ifc, "code"),
        Some("academy.ambassador_pay.rates_unset")
    );
    assert!(unset_rates_public_door_holds(&ifc));
    assert!(ifc.get("shareOfFeeBps").is_none() && ifc.get("sessionCredit").is_none());
    assert!(!ifc.compact().to_lowercase().contains("bps"));
    let share = support::data(&support::call(
        &door,
        &reader(),
        "ambassadorPayQuote",
        true,
        Some(&Json::obj([("kind", s("revenue_share"))])),
    ))
    .clone();
    assert_eq!(
        text(&share, "code"),
        Some("academy.ambassador_revenue_share.rates_unset")
    );
    assert!(unset_rates_public_door_holds(&share));
    assert!(share.get("shareOfFeeBps").is_none());
    let default = support::data(&support::call(
        &door,
        &reader(),
        "ambassadorPayQuote",
        true,
        None,
    ))
    .clone();
    for (k, v) in [
        ("status", s("refuse")),
        ("ok", Json::Bool(false)),
        ("payable", Json::Bool(false)),
        ("inventedIfc", Json::Bool(false)),
    ] {
        assert_eq!(default.get(k), Some(&v), "{k}");
    }
    assert_eq!(text(&default, "reason"), Some("unset"));
    assert_eq!(
        text(&default, "code"),
        Some("academy.ambassador_pay.rates_unset")
    );
    assert_eq!(
        default.get("rateAuthorityPublished"),
        Some(&Json::Bool(false))
    );
    assert!(default.get("amount").is_none());
}

#[test]
fn the_residency_quote_refuses_unset_rates_even_when_accepted() {
    let door = pay_door(&[]);
    let q = support::data(&support::call(
        &door,
        &reader(),
        "residencyPayQuote",
        true,
        Some(&Json::obj([("residencyStatus", s("accepted"))])),
    ))
    .clone();
    assert_eq!(text(&q, "status"), Some("refuse"));
    assert_eq!(text(&q, "kind"), Some("residency"));
    assert_eq!(text(&q, "code"), Some("academy.ambassador_pay.rates_unset"));
    assert_eq!(q.get("payable"), Some(&Json::Bool(false)));
    assert!(q.get("sessionCredit").is_none());
    assert!(!pay_looks_payable(&q));
    let bare = support::data(&support::call(
        &door,
        &reader(),
        "residencyPayQuote",
        true,
        None,
    ))
    .clone();
    assert_eq!(bare.get("ok"), Some(&Json::Bool(false)));
}

#[test]
fn the_pay_mutations_refuse_unset_rates_by_name_with_a_412() {
    let door = pay_door(&[]);
    let ifc = support::call(
        &door,
        &admin(),
        "ambassadorIfcPay",
        false,
        Some(&Json::obj([
            ("beneficiaryId", s(AMB)),
            ("dryRun", Json::Bool(true)),
        ])),
    );
    assert_eq!(ifc.0, 412, "{}", ifc.1.compact());
    assert_eq!(
        pay_refuse_code(support::cause(&ifc).as_deref()),
        Some("academy.ambassador_pay.rates_unset")
    );
    assert!(!ifc.1.compact().contains("shareOfFeeBps"));
    let live = support::call(
        &door,
        &admin(),
        "ambassadorIfcPay",
        false,
        Some(&Json::obj([("beneficiaryId", s(AMB))])),
    );
    assert_eq!(live.0, 412);
    let share = support::call(
        &door,
        &admin(),
        "ambassadorRevenueShare",
        false,
        Some(&Json::obj([
            ("beneficiaryId", s(AMB)),
            ("dryRun", Json::Bool(true)),
        ])),
    );
    assert_eq!(share.0, 412);
    assert_eq!(
        pay_refuse_code(support::cause(&share).as_deref()),
        Some("academy.ambassador_revenue_share.rates_unset")
    );
}

#[test]
fn the_pay_plane_is_dark_for_settlement_and_needs_admin_read() {
    let door = pay_door(&[]);
    let plane = support::data(&support::call(
        &door,
        &admin(),
        "ambassadorPayPlane",
        true,
        None,
    ))
    .clone();
    for (k, v) in [
        ("ifcPayEnabled", false),
        ("revenueShareEnabled", false),
        ("ifcRateAuthorityPublished", false),
        ("ifcPayQuoteEnabled", false),
        ("classM", true),
    ] {
        assert_eq!(plane.get(k), Some(&Json::Bool(v)), "{k}");
    }
    for k in ["rate", "amount", "bps"] {
        assert!(plane.get(k).is_none(), "{k}");
    }
    let residual = text(&plane, "residualIfcPay").unwrap();
    assert!(residual.contains("refuse-closed") || residual.contains("owner-only"));
    let not_admin = support::call(&door, &reader(), "ambassadorPayPlane", true, None);
    assert_ne!(not_admin.0, 200);
}

#[test]
fn a_published_law_with_dry_run_quotes_from_the_owners_rates_only() {
    let door = pay_door(&[(IFC_PAY_LAW_KEY, s(PUBLISHED_IFC))]);
    let plane = support::data(&support::call(
        &door,
        &admin(),
        "ambassadorPayPlane",
        true,
        None,
    ))
    .clone();
    assert_eq!(
        plane.get("ifcRateAuthorityPublished"),
        Some(&Json::Bool(true))
    );
    assert_eq!(plane.get("ifcPayQuoteEnabled"), Some(&Json::Bool(true)));
    assert_eq!(plane.get("ifcPayEnabled"), Some(&Json::Bool(false)));
    let quote = support::data(&support::call(
        &door,
        &admin(),
        "ambassadorIfcPay",
        false,
        Some(&Json::obj([
            ("beneficiaryId", s(AMB)),
            ("dryRun", Json::Bool(true)),
            ("residencyStatus", s("accepted")),
        ])),
    ))
    .clone();
    assert_eq!(quote.get("ok"), Some(&Json::Bool(true)));
    for (k, v) in [
        ("kind", "ifc_pay"),
        ("sessionCredit", "7.25000000"),
        ("asset", "IFC"),
        ("authority", "owner_published"),
        ("settlement", "refuse_recipe_unset"),
    ] {
        assert_eq!(text(&quote, k), Some(v), "{k}");
    }
    let settle = support::call(
        &door,
        &admin(),
        "ambassadorIfcPay",
        false,
        Some(&Json::obj([("beneficiaryId", s(AMB))])),
    );
    assert_eq!(
        settle.0, 412,
        "a published law without dryRun still refuses: no recipe"
    );
    let public = support::data(&support::call(
        &door,
        &reader(),
        "ambassadorPayQuote",
        true,
        None,
    ))
    .clone();
    assert_eq!(
        public.get("payable"),
        Some(&Json::Bool(false)),
        "the public door never pays, even with a law"
    );
}

#[test]
fn the_residency_quote_refuses_an_unaccepted_residency_even_with_authority() {
    let law = r#"{"published":true,"sessionCredit":"1.00000000","asset":"IFC","period":"session"}"#;
    let door = pay_door(&[(IFC_PAY_LAW_KEY, s(law))]);
    let applied = support::call(
        &door,
        &admin(),
        "residencyIfcPayQuote",
        false,
        Some(&Json::obj([
            ("beneficiaryId", s(AMB)),
            ("residencyStatus", s("applied")),
        ])),
    );
    assert_eq!(applied.0, 412, "{}", applied.1.compact());
    let accepted = support::call(
        &door,
        &admin(),
        "residencyIfcPayQuote",
        false,
        Some(&Json::obj([
            ("beneficiaryId", s(AMB)),
            ("residencyStatus", s("accepted")),
        ])),
    );
    assert_eq!(
        text(support::data(&accepted), "sessionCredit"),
        Some("1.00000000"),
        "dryRun defaults to true"
    );
}

#[test]
fn a_malformed_law_refuses_closed_and_check_laws_names_it_at_boot() {
    let bad = [(
        REVENUE_SHARE_LAW_KEY,
        s(r#"{"published":true,"shareOfFeeBps":20000,"feeBasis":"x"}"#),
    )];
    assert!(check_laws(&support::settings(&bad)).is_err());
    assert!(check_laws(&support::settings(&[])).is_ok());
    let door = pay_door(&bad);
    for (path, query, input) in [
        ("ambassadorPayPlane", true, None),
        ("ambassadorPayQuote", true, None),
        (
            "ambassadorRevenueShare",
            false,
            Some(Json::obj([
                ("beneficiaryId", s(AMB)),
                ("dryRun", Json::Bool(true)),
            ])),
        ),
    ] {
        let a = support::call(&door, &admin(), path, query, input.as_ref());
        assert_eq!(a.0, 412, "{path}: {}", a.1.compact());
    }
}

// ── Source scans (ledger-isolation.test.ts, mount-vs-tracker.test.ts, the limit source tests) ──

const SOURCES: [(&str, &str); 9] = [
    (
        "mod.rs",
        include_str!("../src/programme/ambassadors/mod.rs"),
    ),
    (
        "ifc_pay.rs",
        include_str!("../src/programme/ambassadors/ifc_pay.rs"),
    ),
    (
        "rate_law.rs",
        include_str!("../src/programme/ambassadors/rate_law.rs"),
    ),
    (
        "programme.rs",
        include_str!("../src/programme/ambassadors/programme.rs"),
    ),
    (
        "residency.rs",
        include_str!("../src/programme/ambassadors/residency.rs"),
    ),
    (
        "limits.rs",
        include_str!("../src/programme/ambassadors/limits.rs"),
    ),
    (
        "memory.rs",
        include_str!("../src/programme/ambassadors/memory.rs"),
    ),
    ("pg.rs", include_str!("../src/programme/ambassadors/pg.rs")),
    (
        "programme slice",
        include_str!("../src/slices/programme.rs"),
    ),
];

/// The source without its comment lines and its unit tests (which name what they refuse).
fn strip_comments(text: &str) -> String {
    let text = text.split("#[cfg(test)]\nmod tests").next().unwrap_or(text);
    text.lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn has_word(text: &str, word: &str) -> bool {
    text.match_indices(word).any(|(i, _)| {
        let before = text.get(..i).and_then(|t| t.chars().last());
        let after = text.get(i + word.len()..).and_then(|t| t.chars().next());
        let edge = |c: Option<char>| c.is_none_or(|c| !(c.is_alphanumeric() || c == '_'));
        edge(before) && edge(after)
    })
}

fn has_assignment(text: &str, name: &str) -> bool {
    text.match_indices(name).any(|(i, _)| {
        let before = text.get(..i).and_then(|t| t.chars().last());
        let rest = text.get(i + name.len()..).unwrap_or_default().trim_start();
        before.is_none_or(|c| !(c.is_alphanumeric() || c == '_'))
            && (rest.starts_with(':') || rest.starts_with('='))
    })
}

#[test]
fn no_ambassador_module_reaches_the_ledger_or_invents_a_rate() {
    let words = [
        (
            "LedgerClient",
            "the ledger client: ambassadors hold no balance",
        ),
        ("ReadOnlyLedgerClient", "even the read client"),
        ("recipes", "a ledger recipe assembles a real posting"),
        ("ledger_client", "the ledger client crate"),
        ("MemoryLedger", "a second book"),
        ("orderHold", "trade recipes"),
        ("tradeFill", "trade recipes"),
        ("PostRequest", "the shape of a ledger posting"),
        ("EntryInput", "the shape of a ledger posting"),
        ("AccountRef", "ledger account addressing"),
    ];
    let invented = [
        "ifcRate",
        "ifc_rate",
        "revenueShareBps",
        "revenue_share_bps",
        "payAmount",
        "pay_amount",
    ];
    for (name, source) in SOURCES {
        let body = strip_comments(source);
        for (word, why) in words {
            assert!(!has_word(&body, word), "{name}: {why}");
        }
        assert!(!body.contains(".post("), "{name}: a posting call");
        assert!(!body.contains("ports.ledger"), "{name}: the ledger port");
        for field in invented {
            assert!(!has_assignment(&body, field), "{name}: invented {field}");
        }
    }
    let wire = strip_comments(SOURCES.first().unwrap().1);
    assert!(
        [
            "decide_public_pay_quote",
            "decide_public_residency_pay_quote",
            "attempt_pay",
            "attempt_residency_ifc_pay",
            "pay_plane_status"
        ]
        .iter()
        .all(|f| wire.contains(f)),
        "the pay doors answer from the pay plane's functions"
    );
}

#[test]
fn the_pay_plane_names_its_refusals_and_unpublished_defaults() {
    let law = SOURCES.get(2).unwrap().1;
    let pay = SOURCES.get(1).unwrap().1;
    for symbol in [
        "UNPUBLISHED_IFC_PAY_LAW",
        "refuse_ifc_pay",
        "attempt_pay",
        "decide_public_pay_quote",
    ] {
        assert!(has_word(law, symbol) || has_word(pay, symbol), "{symbol}");
    }
    assert!(law.contains("Unpublished"));
    assert!(pay.contains("unset_rates_public_door_holds"));
    assert!(
        law.contains("mod tests") && pay.contains("mod tests"),
        "the pay plane's done-bar tests live beside it"
    );
}

#[test]
fn every_list_takes_the_owners_limit_and_none_invents_one() {
    let wire = strip_comments(SOURCES.first().unwrap().1);
    for (call, check) in [
        ("\"ambassadors\" =>", "ambassadors_list_limit"),
        ("\"myResidencies\" =>", "my_residencies_list_limit"),
        ("\"openResidencies\" =>", "open_residencies_list_limit"),
        ("\"residencyCohorts\" =>", "residency_cohorts_list_limit"),
    ] {
        let start = wire.find(call).unwrap();
        let arm = wire.get(start..).unwrap();
        let arm = arm.get(..arm.find("Ok(Some(").unwrap()).unwrap();
        assert!(arm.contains(check), "{call} checks its limit");
        assert!(
            arm.contains("ctx.input.get(\"limit\")"),
            "{call} takes the caller's limit"
        );
        assert!(
            arm.find(check) < arm.find("ctx.service()"),
            "{call} checks before it reaches the database"
        );
    }
    for (name, source) in SOURCES {
        let body = strip_comments(source);
        for invented in [
            "unwrap_or(50",
            "unwrap_or(100",
            "?? 50",
            "unwrap_or(all.len()",
        ] {
            assert!(!body.contains(invented), "{name}: {invented}");
        }
    }
    let programme = strip_comments(SOURCES.get(3).unwrap().1);
    let residency = strip_comments(SOURCES.get(4).unwrap().1);
    assert_eq!(
        programme.matches("LIMIT $").count(),
        2,
        "both ambassadors selects are limited"
    );
    assert_eq!(
        residency.matches("LIMIT $").count(),
        4,
        "my, open (both) and cohorts are limited"
    );
}

/// `ambassador-rate-law-compose-pin.test.ts`: the compose stack passes both laws to svc-academy, once, with an empty
/// default, and the Rust environment declares both with an empty default (unpublished, so every pay door refuses).
#[test]
fn compose_passes_both_rate_laws_once_with_empty_defaults() {
    let env = include_str!("../src/env.rs");
    assert!(env.contains("o.string(\"ACADEMY_AMBASSADOR_IFC_PAY_LAW_JSON\", \"\")"));
    assert!(env.contains("o.string(\"ACADEMY_AMBASSADOR_REVENUE_SHARE_LAW_JSON\", \"\")"));
    let compose = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docker-compose.apps.yml"
    ))
    .unwrap();
    let lines: Vec<&str> = compose.split('\n').collect();
    let start = lines
        .iter()
        .position(|l| l.trim_end() == "  svc-academy:")
        .unwrap();
    let block: Vec<&str> = lines
        .iter()
        .skip(start + 1)
        .take_while(|l| l.trim().is_empty() || l.starts_with("   "))
        .copied()
        .collect();
    let block = block.join("\n");
    assert!(block.contains("SERVICE_NAME: svc-academy"));
    for key in [IFC_PAY_LAW_KEY, REVENUE_SHARE_LAW_KEY] {
        let pinned = format!("{key}: ${{{key}:-}}");
        assert_eq!(
            block.lines().filter(|l| l.trim() == pinned).count(),
            1,
            "{key} pinned once in svc-academy"
        );
        let anywhere = compose
            .lines()
            .filter(|l| l.trim_start().starts_with(&format!("{key}:")))
            .count();
        assert_eq!(anywhere, 1, "{key} appears once in the compose file");
        assert!(
            !block.contains(&format!("{key}: ${{{key}:-{{")),
            "{key} defaults no law"
        );
    }
    for kept in [
        "ACADEMY_STREAM_PROVIDER: ${ACADEMY_STREAM_PROVIDER:-none}",
        "ACADEMY_MAX_ROOM_CAPACITY: ${ACADEMY_MAX_ROOM_CAPACITY:-}",
        "ACADEMY_PAPER_TRADING_ENABLED: ${ACADEMY_PAPER_TRADING_ENABLED:-true}",
        "ACADEMY_TOURNAMENT_ENABLED: ${ACADEMY_TOURNAMENT_ENABLED:-true}",
    ] {
        assert!(block.contains(kept), "{kept}");
    }
    let lower = block.to_lowercase();
    for invented in [
        "prize_pool",
        "paper_balance",
        "shareoffeebps",
        "sessioncredit",
    ] {
        assert!(!lower.contains(invented), "{invented}");
    }
}
