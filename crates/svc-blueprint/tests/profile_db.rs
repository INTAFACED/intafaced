//! Slice `profile` against a real `blueprint` schema, every call entering through the Rust door: the ports of
//! `blueprint-service.test.ts`'s `get` test and its `setVisibility` and mentor-shortlist tests, each named after the
//! TypeScript test. Rows are written straight into the tables: onboarding, which writes them in the TypeScript tests,
//! is slice `onboard`'s, and the card checks those tests make next are slice `card`'s. Plus what the row and output
//! checks do with a row the schema would not accept, and that each call acts on the signed caller only.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::support::{self, TestDb, call, data};
use service_kit::json::Json;

fn uuid(n: u32) -> String {
    format!("{n:08}-0000-4000-8000-000000000000")
}

const PROFILE: &str = r#"{"crewRole":"anchor","energyRhythm":"dawn","guardrails":{"maxLeverage":2,"dailyLossPromptPct":5,"confirmBeforeMarketOrder":true,"copyTradingVisible":false},"decisionStyle":"analytical","learningMode":"visual","toneRegister":"direct","curriculumPath":"foundations","riskTemperament":"guarded"}"#;

/// A Blueprint row for `user`, as onboarding writes one; its id.
fn seed(db: &TestDb, user: &str, profile: &str, visibility: &str) -> String {
    db.client()
        .query_one(
            "INSERT INTO blueprint.blueprints (user_id, engine_version, profile, visibility)
             VALUES ($1::text::uuid, 'mock-1', $2::text::jsonb, $3::text::blueprint.blueprint_visibility)
             RETURNING id::text",
            &[&user, &profile, &visibility],
        )
        .unwrap()
        .get(0)
}

fn text<'a>(v: &'a Json, key: &str) -> &'a str {
    match v.get(key) {
        Some(Json::String(s)) => s,
        other => panic!("{key}: {other:?}"),
    }
}

fn error_code(body: &Json) -> (String, Option<String>) {
    let e = body.get("error").unwrap();
    let data = e.get("data").unwrap();
    let cause = match data.get("cause").and_then(|c| c.get("code")) {
        Some(Json::String(c)) => Some(c.clone()),
        _ => None,
    };
    (text(data, "code").to_owned(), cause)
}

#[test]
fn get_returns_null_for_a_user_with_no_blueprint_and_the_record_once_there_is_one() {
    let Some(db) = TestDb::migrated() else { return };
    let door = db.door();
    let a = uuid(101);

    let (status, body) = call(&door, &a, "me", None);
    assert_eq!((status, data(&body)), (200, &Json::Null));

    let id = seed(&db, &a, PROFILE, "private");
    let created: String = db
        .client()
        .query_one(
            "SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM blueprint.blueprints WHERE id = $1::text::uuid",
            &[&id],
        )
        .unwrap()
        .get(0);
    let (status, body) = call(&door, &a, "me", None);
    assert_eq!(status, 200);
    let fetched = data(&body);
    assert_eq!(text(fetched, "id"), id);
    assert_eq!(text(fetched, "userId"), a);
    assert_eq!(text(fetched, "engineVersion"), "mock-1");
    // The profile in the output schema's key order, whatever order jsonb stored it in.
    assert_eq!(
        fetched.get("profile").unwrap().compact(),
        r#"{"decisionStyle":"analytical","riskTemperament":"guarded","energyRhythm":"dawn","learningMode":"visual","crewRole":"anchor","curriculumPath":"foundations","toneRegister":"direct","guardrails":{"maxLeverage":2,"dailyLossPromptPct":5,"confirmBeforeMarketOrder":true,"copyTradingVisible":false}}"#
    );
    // Null because no rasterizer ever wrote one: the column holds a hosted PNG's URL and only ever a real one.
    assert_eq!(fetched.get("cardAssetUrl"), Some(&Json::Null));
    assert_eq!(text(fetched, "visibility"), "private");
    assert_eq!(text(fetched, "createdAt"), created);
    // `mentor_available` is a row column, never on the record.
    assert!(fetched.get("mentorAvailable").is_none());
}

#[test]
fn set_visibility_public_then_the_record_says_public() {
    // The TypeScript test then reads the card as another viewer: slice `card`.
    let Some(db) = TestDb::migrated() else { return };
    let door = db.door();
    let a = uuid(101);
    let id = seed(&db, &a, PROFILE, "private");

    let (status, body) = call(
        &door,
        &a,
        "setVisibility",
        Some(r#"{"visibility":"public"}"#),
    );
    assert_eq!(status, 200);
    let updated = data(&body);
    assert_eq!(
        (text(updated, "id"), text(updated, "visibility")),
        (id.as_str(), "public")
    );
    let (_, body) = call(&door, &a, "me", None);
    assert_eq!(text(data(&body), "visibility"), "public");
    let stored: String = db
        .client()
        .query_one(
            "SELECT visibility::text FROM blueprint.blueprints WHERE user_id = $1::text::uuid",
            &[&a],
        )
        .unwrap()
        .get(0);
    assert_eq!(stored, "public");
}

#[test]
fn flipping_public_back_to_private_takes_at_once() {
    let Some(db) = TestDb::migrated() else { return };
    let door = db.door();
    let a = uuid(101);
    seed(&db, &a, PROFILE, "public");

    let (status, body) = call(
        &door,
        &a,
        "setVisibility",
        Some(r#"{"visibility":"private"}"#),
    );
    assert_eq!((status, text(data(&body), "visibility")), (200, "private"));
    let (_, body) = call(&door, &a, "me", None);
    assert_eq!(text(data(&body), "visibility"), "private");
}

#[test]
fn set_visibility_on_a_user_with_no_blueprint_is_not_found() {
    let Some(db) = TestDb::migrated() else { return };
    let door = db.door();
    let (status, body) = call(
        &door,
        &uuid(101),
        "setVisibility",
        Some(r#"{"visibility":"public"}"#),
    );
    assert_eq!(status, 404);
    assert_eq!(
        error_code(&body),
        (
            "NOT_FOUND".to_owned(),
            Some("blueprint.not_found".to_owned())
        )
    );
    assert_eq!(
        text(body.get("error").unwrap(), "message"),
        "No Blueprint to update — run the Blueprint session first"
    );
}

#[test]
fn each_call_acts_on_the_signed_caller_and_no_one_else() {
    let Some(db) = TestDb::migrated() else { return };
    let door = db.door();
    let (a, b) = (uuid(101), uuid(102));
    let id_a = seed(&db, &a, PROFILE, "private");
    seed(&db, &b, PROFILE, "crew");

    // An id in the input is not read: the schema drops it, and the caller's own row moves.
    let input = format!(r#"{{"visibility":"public","userId":"{a}"}}"#);
    let (status, body) = call(&door, &b, "setVisibility", Some(&input));
    assert_eq!((status, text(data(&body), "userId")), (200, b.as_str()));
    let (_, body) = call(&door, &a, "me", None);
    assert_eq!(
        (text(data(&body), "id"), text(data(&body), "visibility")),
        (id_a.as_str(), "private")
    );
}

#[test]
fn mentors_lists_only_the_callers_shortlist_best_fit_first() {
    // `is not touched by the mentor shortlist, which reaches no rasterizer at all`: here, no renderer exists at all;
    // the shortlist is the caller's own rows of `mentor_matches`, best fit first, then by mentor id.
    let Some(db) = TestDb::migrated() else { return };
    let door = db.door();
    let (a, b) = (uuid(101), uuid(102));
    let (status, body) = call(&door, &a, "mentors", None);
    assert_eq!((status, data(&body)), (200, &Json::Array(Vec::new())));

    let mut c = db.client();
    for (student, mentor, fit, status) in [
        (&a, uuid(503), 4200, "shortlisted"),
        (&a, uuid(501), 9100, "accepted"),
        (&a, uuid(502), 4200, "declined"),
        (&b, uuid(504), 9900, "shortlisted"),
    ] {
        c.execute(
            "INSERT INTO blueprint.mentor_matches (student_id, mentor_id, fit_score, status)
             VALUES ($1::text::uuid, $2::text::uuid, $3, $4::text::blueprint.mentor_match_status)",
            &[student, &mentor, &fit, &status],
        )
        .unwrap();
    }
    let (status, body) = call(&door, &a, "mentors", None);
    assert_eq!(status, 200);
    assert_eq!(
        data(&body).compact(),
        format!(
            r#"[{{"studentId":"{a}","mentorId":"{}","fitScore":9100,"status":"accepted"}},{{"studentId":"{a}","mentorId":"{}","fitScore":4200,"status":"declined"}},{{"studentId":"{a}","mentorId":"{}","fitScore":4200,"status":"shortlisted"}}]"#,
            uuid(501),
            uuid(502),
            uuid(503)
        )
    );
}

#[test]
fn a_stored_profile_the_schema_refuses_is_a_500_never_a_guess() {
    // `BlueprintRow.array().parse(rows)` throws a ZodError: `me` sends its message (unmapped), `setVisibility` the
    // mapped "Request failed". A guardrail out of range passes the table's checks, so only the row check stops it.
    let Some(db) = TestDb::migrated() else { return };
    let door = db.door();
    let a = uuid(101);
    seed(
        &db,
        &a,
        &PROFILE.replace(r#""maxLeverage":2"#, r#""maxLeverage":99"#),
        "private",
    );

    let (status, body) = call(&door, &a, "me", None);
    assert_eq!(
        (status, error_code(&body)),
        (500, ("INTERNAL_SERVER_ERROR".to_owned(), None))
    );
    // zod's own message for this row, as `BlueprintRow.array().safeParse` gives it in the TypeScript.
    assert_eq!(
        text(body.get("error").unwrap(), "message"),
        "[\n  {\n    \"origin\": \"number\",\n    \"code\": \"too_big\",\n    \"maximum\": 20,\n    \"inclusive\": true,\n    \"path\": [\n      0,\n      \"profile\",\n      \"guardrails\",\n      \"maxLeverage\"\n    ],\n    \"message\": \"Too big: expected number to be <=20\"\n  }\n]"
    );

    let (status, body) = call(
        &door,
        &a,
        "setVisibility",
        Some(r#"{"visibility":"public"}"#),
    );
    assert_eq!(status, 500);
    assert_eq!(
        text(body.get("error").unwrap(), "message"),
        "Request failed"
    );
}

#[test]
fn a_key_the_record_does_not_name_never_leaves() {
    // The row keeps a stored profile's extra keys (`.loose()`); the output schema drops them on the way out.
    let Some(db) = TestDb::migrated() else { return };
    let door = db.door();
    let a = uuid(101);
    seed(
        &db,
        &a,
        &PROFILE.replace(r#"{"crewRole""#, r#"{"note":"kept in the row","crewRole""#),
        "private",
    );
    let (status, body) = call(&door, &a, "me", None);
    assert_eq!(status, 200);
    let profile = data(&body).get("profile").unwrap();
    assert!(profile.get("note").is_none(), "{}", profile.compact());
    assert!(profile.get("crewRole").is_some());
}

#[test]
fn a_database_that_fails_is_the_drivers_message_on_the_unmapped_calls() {
    // `me` and `mentors` never mapped their errors; `setVisibility` did.
    let door = support::door(svc_blueprint::db::Store::Down(
        "connect ECONNREFUSED".to_owned(),
    ));
    let a = uuid(101);
    for path in ["me", "mentors"] {
        let (status, body) = call(&door, &a, path, None);
        assert_eq!(
            (status, text(body.get("error").unwrap(), "message")),
            (500, "connect ECONNREFUSED")
        );
    }
    let (status, body) = call(
        &door,
        &a,
        "setVisibility",
        Some(r#"{"visibility":"public"}"#),
    );
    assert_eq!(
        (status, text(body.get("error").unwrap(), "message")),
        (500, "Request failed")
    );
}
