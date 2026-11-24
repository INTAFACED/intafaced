//! Slice `shares` against a real `blueprint` schema, every call entering through the Rust door: the ports of
//! `card-shares.pg.test.ts`'s share creation, idempotency, revocation (including a revoke queued behind a held row with
//! a waiting open), visibility/privacy, blank-limit refusal, active-share cap and opener listing tests, plus
//! `shares.list` ordering, open-count aggregation, revoked-share opener reads and zero/negative limits.
//! Left to slice `privacy`: the export and erase assertions of `card-shares.pg.test.ts`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use crate::support::{TestDb, call, data};
use service_kit::json::Json;
use svc_blueprint::env::Settings;

const OWNER: &str = "11111111-1111-4111-8111-111111111111";
const VIEWER: &str = "22222222-2222-4222-8222-222222222222";
const MATE: &str = "33333333-3333-4333-8333-333333333333";
const STRANGER: &str = "44444444-4444-4444-8444-444444444444";
const CREW: &str = "55555555-5555-4555-8555-555555555555";
const MISSING: &str = "66666666-6666-4666-8666-666666666666";

const PROFILE: &str = r#"{"decisionStyle":"analytical","riskTemperament":"measured","energyRhythm":"steady","learningMode":"systematic","crewRole":"anchor","curriculumPath":"foundations","toneRegister":"direct","guardrails":{"maxLeverage":1,"dailyLossPromptPct":5,"confirmBeforeMarketOrder":true,"copyTradingVisible":false}}"#;
const CARD_NOT_FOUND: &str = "No Blueprint to render a card for — run the Blueprint session first";

fn limits(shares: Option<i64>, opens: Option<i64>) -> Settings {
    Settings {
        shares_per_owner: shares,
        opens_list_limit: opens,
        ..Settings::default()
    }
}

fn default_limits() -> Settings {
    limits(Some(2), Some(20))
}

fn seed(db: &TestDb, user: &str, visibility: &str) {
    db.client()
        .execute(
            "INSERT INTO blueprint.blueprints (user_id, engine_version, profile, visibility)
             VALUES ($1::text::uuid, 'test', $2::text::jsonb, $3::text::blueprint.blueprint_visibility)",
            &[&user, &PROFILE, &visibility],
        )
        .unwrap();
}

fn same_crew(db: &TestDb, users: &[&str]) {
    let mut c = db.client();
    c.execute(
        "INSERT INTO blueprint.crews (id, name, season, capacity) VALUES ($1::text::uuid, 'TEST crew', 1, 6)",
        &[&CREW],
    )
    .unwrap();
    for user in users {
        c.execute(
            "INSERT INTO blueprint.crew_members (crew_id, user_id, role) VALUES ($1::text::uuid, $2::text::uuid, 'anchor')",
            &[&CREW, user],
        )
        .unwrap();
    }
}

fn text<'a>(v: &'a Json, key: &str) -> &'a str {
    match v.get(key) {
        Some(Json::String(s)) => s,
        other => panic!("{key}: {other:?}"),
    }
}

fn array(v: &Json) -> &[Json] {
    match v {
        Json::Array(items) => items,
        other => panic!("not an array: {other:?}"),
    }
}

fn refusal(status: u16, body: &Json) -> (u16, String, String, Option<String>) {
    let e = body
        .get("error")
        .unwrap_or_else(|| panic!("not a refusal: {}", body.compact()));
    let d = e.get("data").unwrap();
    let cause = match d.get("cause").and_then(|c| c.get("code")) {
        Some(Json::String(c)) => Some(c.clone()),
        _ => None,
    };
    (
        status,
        text(d, "code").to_owned(),
        text(e, "message").to_owned(),
        cause,
    )
}

fn not_found() -> (u16, String, String, Option<String>) {
    (
        404,
        "NOT_FOUND".to_owned(),
        CARD_NOT_FOUND.to_owned(),
        Some("blueprint.not_found".to_owned()),
    )
}

fn create_input(size: &str) -> String {
    format!(r#"{{"size":"{size}"}}"#)
}

fn share_input(share_id: &str) -> String {
    format!(r#"{{"shareId":"{share_id}"}}"#)
}

fn of_share(share_id: &str, size: &str) -> String {
    format!(r#"{{"shareId":"{share_id}","size":"{size}"}}"#)
}

fn open_counts(db: &TestDb, share_id: &str) -> Vec<i32> {
    db.client()
        .query(
            "SELECT open_count FROM blueprint.card_opens WHERE share_id = $1::text::uuid",
            &[&share_id],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect()
}

#[test]
fn creates_one_share_counts_a_second_open_on_the_same_row_and_returns_no_account_id() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "public");
    let door = db.door_with_settings(default_limits());

    let (status, body) = call(
        &door,
        OWNER,
        "shares.create",
        Some(&create_input("portrait")),
    );
    assert_eq!(status, 200, "{}", body.compact());
    let share = data(&body);
    let share_id = text(share, "id").to_owned();
    assert_eq!(text(share, "size"), "portrait");
    assert_eq!(text(share, "state"), "active");
    assert_eq!(share.get("revokedAt"), Some(&Json::Null));
    assert_eq!(share.get("openCount"), Some(&Json::int(0)));
    let keys: Vec<&str> = match share {
        Json::Object(fields) => fields.iter().map(|(k, _)| k.as_str()).collect(),
        _ => panic!(),
    };
    assert_eq!(
        keys,
        ["id", "size", "createdAt", "revokedAt", "state", "openCount"]
    );

    // Repeating create for the same active size returns that same share.
    let (status, repeat) = call(
        &door,
        OWNER,
        "shares.create",
        Some(&create_input("portrait")),
    );
    assert_eq!(status, 200);
    assert_eq!(text(data(&repeat), "id"), share_id);

    // Opening returns the share's own size and counts a second open on the same row.
    let (status, card) = call(
        &door,
        VIEWER,
        "cardOf",
        Some(&of_share(&share_id, "landscape")),
    );
    assert_eq!(status, 200);
    assert_eq!(text(data(&card), "size"), "portrait");
    assert_eq!(data(&card).get("width"), Some(&Json::int(1080)));
    let (status, _) = call(
        &door,
        VIEWER,
        "cardOf",
        Some(&of_share(&share_id, "portrait")),
    );
    assert_eq!(status, 200);

    let (status, openers_body) = call(
        &door,
        OWNER,
        "shares.openers",
        Some(&share_input(&share_id)),
    );
    assert_eq!(status, 200, "{}", openers_body.compact());
    let openers = array(data(&openers_body));
    assert_eq!(openers.len(), 1);
    assert_eq!(text(&openers[0], "kind"), "signed-in account");
    assert_eq!(openers[0].get("openCount"), Some(&Json::int(2)));
    assert!(!data(&openers_body).compact().contains(VIEWER));
    assert_eq!(open_counts(&db, &share_id), vec![2]);

    let (status, list_body) = call(&door, OWNER, "shares.list", None);
    assert_eq!(status, 200);
    let listed = array(data(&list_body));
    assert_eq!(listed.len(), 1);
    assert_eq!(text(&listed[0], "id"), share_id);
    assert_eq!(listed[0].get("openCount"), Some(&Json::int(2)));
}

#[test]
fn names_a_crew_member_when_the_viewer_shares_a_crew() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "crew");
    seed(&db, MATE, "crew");
    same_crew(&db, &[OWNER, MATE]);
    let door = db.door_with_settings(default_limits());

    let (status, body) = call(
        &door,
        OWNER,
        "shares.create",
        Some(&create_input("portrait")),
    );
    assert_eq!(status, 200);
    let share_id = text(data(&body), "id").to_owned();

    let (status, _) = call(
        &door,
        MATE,
        "cardOf",
        Some(&of_share(&share_id, "portrait")),
    );
    assert_eq!(status, 200);

    let (status, openers_body) = call(
        &door,
        OWNER,
        "shares.openers",
        Some(&share_input(&share_id)),
    );
    assert_eq!(status, 200);
    let openers = array(data(&openers_body));
    assert_eq!(openers.len(), 1);
    assert_eq!(text(&openers[0], "kind"), "crew member");
    assert_eq!(openers[0].get("openCount"), Some(&Json::int(1)));
    assert!(!data(&openers_body).compact().contains(MATE));
}

#[test]
fn refuses_a_viewer_the_visibility_rule_excludes_and_writes_no_open_row() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "private");
    let door = db.door_with_settings(default_limits());

    let (status, body) = call(
        &door,
        OWNER,
        "shares.create",
        Some(&create_input("portrait")),
    );
    assert_eq!(status, 200);
    let share_id = text(data(&body), "id").to_owned();

    let (status, body) = call(
        &door,
        VIEWER,
        "cardOf",
        Some(&of_share(MISSING, "portrait")),
    );
    assert_eq!(refusal(status, &body), not_found());
    let (status, body) = call(
        &door,
        VIEWER,
        "cardOf",
        Some(&of_share(&share_id, "portrait")),
    );
    assert_eq!(refusal(status, &body), not_found());
    assert!(open_counts(&db, &share_id).is_empty());

    let (status, openers_body) = call(
        &door,
        OWNER,
        "shares.openers",
        Some(&share_input(&share_id)),
    );
    assert_eq!((status, array(data(&openers_body)).len()), (200, 0));
}

#[test]
fn revoke_is_idempotent_and_the_next_read_including_one_already_waiting_is_not_found() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "public");
    let door = Arc::new(db.door_with_settings(default_limits()));

    let (status, body) = call(
        &door,
        OWNER,
        "shares.create",
        Some(&create_input("portrait")),
    );
    assert_eq!(status, 200);
    let share_id = text(data(&body), "id").to_owned();

    let (status, _) = call(
        &door,
        VIEWER,
        "cardOf",
        Some(&of_share(&share_id, "portrait")),
    );
    assert_eq!(status, 200);

    let (locked_tx, locked_rx) = mpsc::channel();
    let (gate_tx, gate_rx) = mpsc::channel();
    let mut holder_client = db.client();
    let holder_share = share_id.clone();
    let holder = thread::spawn(move || {
        let mut tx = holder_client.transaction().unwrap();
        tx.query(
            "SELECT id FROM blueprint.card_shares WHERE id = $1::text::uuid FOR UPDATE",
            &[&holder_share],
        )
        .unwrap();
        locked_tx.send(()).unwrap();
        gate_rx.recv().unwrap();
        tx.commit().unwrap();
    });
    locked_rx.recv_timeout(Duration::from_secs(3)).unwrap();

    let mut probe = db.client();
    let mut blocked_on_the_row = |backends: i32| -> bool {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let n: i32 = probe
                .query_one(
                    "SELECT count(*)::int AS n FROM pg_stat_activity
                      WHERE datname = current_database() AND wait_event_type = 'Lock'
                        AND query ILIKE '%card_shares%' AND pid <> pg_backend_pid()",
                    &[],
                )
                .unwrap()
                .get(0);
            if n >= backends {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    };

    let revoke_door = Arc::clone(&door);
    let revoke_id = share_id.clone();
    let revoking = thread::spawn(move || {
        call(
            &revoke_door,
            OWNER,
            "shares.revoke",
            Some(&share_input(&revoke_id)),
        )
    });
    assert!(blocked_on_the_row(1));

    let read_door = Arc::clone(&door);
    let read_id = share_id.clone();
    let reading = thread::spawn(move || {
        call(
            &read_door,
            STRANGER,
            "cardOf",
            Some(&of_share(&read_id, "portrait")),
        )
    });
    // The read must be queued behind the revoke before the holder lets go.
    assert!(blocked_on_the_row(2));

    gate_tx.send(()).unwrap();
    holder.join().unwrap();

    let (revoke_status, revoke_body) = revoking.join().unwrap();
    assert_eq!(revoke_status, 200, "{}", revoke_body.compact());
    let revoked = data(&revoke_body);
    assert_eq!(text(revoked, "state"), "revoked");
    let revoked_at = text(revoked, "revokedAt").to_owned();

    let (read_status, read_body) = reading.join().unwrap();
    assert_eq!(refusal(read_status, &read_body), not_found());

    // Revoking a second time is idempotent and keeps the stored revokedAt.
    let (again_status, again_body) =
        call(&door, OWNER, "shares.revoke", Some(&share_input(&share_id)));
    assert_eq!(again_status, 200);
    assert_eq!(text(data(&again_body), "state"), "revoked");
    assert_eq!(text(data(&again_body), "revokedAt"), revoked_at);
    assert_eq!(open_counts(&db, &share_id), vec![1]);
}

#[test]
fn hides_another_account_share_and_refuses_a_blank_limit_before_writing() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "public");
    let door = db.door_with_settings(default_limits());

    let (status, body) = call(
        &door,
        OWNER,
        "shares.create",
        Some(&create_input("portrait")),
    );
    assert_eq!(status, 200);
    let share_id = text(data(&body), "id").to_owned();

    let (status, body) = call(
        &door,
        VIEWER,
        "shares.openers",
        Some(&share_input(&share_id)),
    );
    assert_eq!(refusal(status, &body), not_found());
    let (status, body) = call(
        &door,
        VIEWER,
        "shares.revoke",
        Some(&share_input(&share_id)),
    );
    assert_eq!(refusal(status, &body), not_found());

    let unset = db.door();
    let (status, body) = call(
        &unset,
        OWNER,
        "shares.create",
        Some(&create_input("landscape")),
    );
    assert_eq!(
        refusal(status, &body),
        (
            412,
            "PRECONDITION_FAILED".to_owned(),
            "BLUEPRINT_SHARES_PER_OWNER is unset — owner must publish a share limit (never invent one)".to_owned(),
            Some("blueprint.share_limit_unset".to_owned()),
        )
    );
    let (status, body) = call(
        &unset,
        OWNER,
        "shares.openers",
        Some(&share_input(&share_id)),
    );
    assert_eq!(
        refusal(status, &body),
        (
            412,
            "PRECONDITION_FAILED".to_owned(),
            "BLUEPRINT_OPENS_LIST_LIMIT is unset — owner must publish an openers list limit (never invent one)".to_owned(),
            Some("blueprint.opens_list_limit_unset".to_owned()),
        )
    );

    let sizes: Vec<String> = db
        .client()
        .query(
            "SELECT size FROM blueprint.card_shares WHERE owner_user_id = $1::text::uuid ORDER BY size",
            &[&OWNER],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(sizes, vec!["portrait"]);
}

#[test]
fn refuses_a_second_active_size_once_the_published_cap_is_full_and_frees_the_slot_on_revoke() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "public");
    let door = db.door_with_settings(limits(Some(1), Some(20)));

    let (status, first_body) = call(
        &door,
        OWNER,
        "shares.create",
        Some(&create_input("portrait")),
    );
    assert_eq!(status, 200);
    let first_id = text(data(&first_body), "id").to_owned();

    let (status, body) = call(
        &door,
        OWNER,
        "shares.create",
        Some(&create_input("landscape")),
    );
    assert_eq!(
        refusal(status, &body),
        (
            409,
            "CONFLICT".to_owned(),
            "No active share slot is left under the published shares-per-owner limit".to_owned(),
            Some("blueprint.share_limit_reached".to_owned()),
        )
    );

    // Revoking frees the active slot so the other size, or a fresh portrait share, can be created.
    let (status, _) = call(&door, OWNER, "shares.revoke", Some(&share_input(&first_id)));
    assert_eq!(status, 200);
    let (status, second_body) = call(
        &door,
        OWNER,
        "shares.create",
        Some(&create_input("portrait")),
    );
    assert_eq!(status, 200);
    let second_id = text(data(&second_body), "id").to_owned();
    assert_ne!(second_id, first_id);
    assert_eq!(text(data(&second_body), "state"), "active");
}

#[test]
fn create_requires_a_blueprint_and_zero_cap_refuses_new_shares_while_returning_an_existing_one() {
    let Some(db) = TestDb::migrated() else { return };
    let door = db.door_with_settings(default_limits());

    let (status, body) = call(
        &door,
        OWNER,
        "shares.create",
        Some(&create_input("portrait")),
    );
    assert_eq!(refusal(status, &body), not_found());

    seed(&db, OWNER, "public");
    let zero_door = db.door_with_settings(limits(Some(0), Some(0)));
    let (status, body) = call(
        &zero_door,
        OWNER,
        "shares.create",
        Some(&create_input("portrait")),
    );
    assert_eq!(
        refusal(status, &body),
        (
            409,
            "CONFLICT".to_owned(),
            "No active share slot is left under the published shares-per-owner limit".to_owned(),
            Some("blueprint.share_limit_reached".to_owned()),
        )
    );

    // If an active share already exists for that size, create returns it even under cap 0.
    let (status, created) = call(
        &door,
        OWNER,
        "shares.create",
        Some(&create_input("portrait")),
    );
    assert_eq!(status, 200);
    let share_id = text(data(&created), "id").to_owned();
    let (status, existing) = call(
        &zero_door,
        OWNER,
        "shares.create",
        Some(&create_input("portrait")),
    );
    assert_eq!(status, 200);
    assert_eq!(text(data(&existing), "id"), share_id);
}

#[test]
fn list_shares_returns_callers_shares_newest_first_with_summed_open_counts() {
    let Some(db) = TestDb::migrated() else { return };
    // Empty even without a Blueprint and with blank settings.
    let (status, empty) = call(&db.door(), OWNER, "shares.list", None);
    assert_eq!((status, array(data(&empty)).len()), (200, 0));

    seed(&db, OWNER, "public");
    seed(&db, MATE, "public");
    let door = db.door_with_settings(default_limits());

    let (status, first) = call(
        &door,
        OWNER,
        "shares.create",
        Some(&create_input("portrait")),
    );
    assert_eq!(status, 200);
    let first_id = text(data(&first), "id").to_owned();
    let (status, second) = call(
        &door,
        OWNER,
        "shares.create",
        Some(&create_input("landscape")),
    );
    assert_eq!(status, 200);
    let second_id = text(data(&second), "id").to_owned();
    let (status, _) = call(
        &door,
        MATE,
        "shares.create",
        Some(&create_input("portrait")),
    );
    assert_eq!(status, 200);

    // Give the two shares distinct created_at timestamps so ordering is deterministic.
    db.client()
        .execute(
            "UPDATE blueprint.card_shares SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = $1::text::uuid",
            &[&first_id],
        )
        .unwrap();
    db.client()
        .execute(
            "UPDATE blueprint.card_shares SET created_at = '2026-01-02T00:00:00.000Z' WHERE id = $1::text::uuid",
            &[&second_id],
        )
        .unwrap();

    // Two opens from VIEWER and one from STRANGER -> openCount 3 on first_id.
    call(
        &door,
        VIEWER,
        "cardOf",
        Some(&of_share(&first_id, "portrait")),
    );
    call(
        &door,
        VIEWER,
        "cardOf",
        Some(&of_share(&first_id, "portrait")),
    );
    call(
        &door,
        STRANGER,
        "cardOf",
        Some(&of_share(&first_id, "portrait")),
    );
    call(
        &door,
        OWNER,
        "shares.revoke",
        Some(&share_input(&second_id)),
    );

    // Listing needs no owner limit settings.
    let (status, body) = call(&db.door(), OWNER, "shares.list", None);
    assert_eq!(status, 200);
    let listed = array(data(&body));
    assert_eq!(listed.len(), 2);
    assert_eq!(text(&listed[0], "id"), second_id);
    assert_eq!(text(&listed[0], "createdAt"), "2026-01-02T00:00:00.000Z");
    assert_eq!(text(&listed[0], "state"), "revoked");
    assert_eq!(listed[0].get("openCount"), Some(&Json::int(0)));

    assert_eq!(text(&listed[1], "id"), first_id);
    assert_eq!(text(&listed[1], "createdAt"), "2026-01-01T00:00:00.000Z");
    assert_eq!(text(&listed[1], "state"), "active");
    assert_eq!(listed[1].get("revokedAt"), Some(&Json::Null));
    assert_eq!(listed[1].get("openCount"), Some(&Json::int(3)));
}

#[test]
fn openers_orders_newest_first_enforces_page_limit_and_stays_readable_after_revoke() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "public");
    seed(&db, MATE, "public");
    same_crew(&db, &[OWNER, MATE]);
    let door = db.door_with_settings(limits(Some(2), Some(2)));

    let (status, body) = call(
        &door,
        OWNER,
        "shares.create",
        Some(&create_input("portrait")),
    );
    assert_eq!(status, 200);
    let share_id = text(data(&body), "id").to_owned();

    let mut c = db.client();
    for (viewer, first, last, count) in [
        (
            VIEWER,
            "2026-01-01T01:00:00.000Z",
            "2026-01-01T01:00:00.000Z",
            1i32,
        ),
        (
            MATE,
            "2026-01-01T02:00:00.000Z",
            "2026-01-01T03:00:00.000Z",
            4i32,
        ),
        (
            STRANGER,
            "2026-01-01T01:30:00.000Z",
            "2026-01-01T02:30:00.000Z",
            2i32,
        ),
    ] {
        c.execute(
            "INSERT INTO blueprint.card_opens (share_id, viewer_user_id, first_opened, last_opened, open_count)
             VALUES ($1::text::uuid, $2::text::uuid, $3::text::timestamptz, $4::text::timestamptz, $5)",
            &[&share_id, &viewer, &first, &last, &count],
        )
        .unwrap();
    }

    // Page limit 2 returns MATE (03:00) then STRANGER (02:30), dropping VIEWER (01:00).
    let (status, body) = call(
        &door,
        OWNER,
        "shares.openers",
        Some(&share_input(&share_id)),
    );
    assert_eq!(status, 200, "{}", body.compact());
    assert_eq!(
        data(&body).compact(),
        r#"[{"kind":"crew member","firstOpened":"2026-01-01T02:00:00.000Z","lastOpened":"2026-01-01T03:00:00.000Z","openCount":4},{"kind":"signed-in account","firstOpened":"2026-01-01T01:30:00.000Z","lastOpened":"2026-01-01T02:30:00.000Z","openCount":2}]"#
    );

    // Zero page limit returns an empty page for the owner, and still hides others' or missing shares.
    let zero = db.door_with_settings(limits(Some(2), Some(0)));
    let (status, empty) = call(
        &zero,
        OWNER,
        "shares.openers",
        Some(&share_input(&share_id)),
    );
    assert_eq!((status, array(data(&empty)).len()), (200, 0));
    let (status, body) = call(
        &zero,
        VIEWER,
        "shares.openers",
        Some(&share_input(&share_id)),
    );
    assert_eq!(refusal(status, &body), not_found());
    let (status, body) = call(&zero, OWNER, "shares.openers", Some(&share_input(MISSING)));
    assert_eq!(refusal(status, &body), not_found());

    // Revoking the share keeps its opener log readable by the owner.
    let (status, _) = call(&door, OWNER, "shares.revoke", Some(&share_input(&share_id)));
    assert_eq!(status, 200);
    let (status, after_revoke) = call(
        &door,
        OWNER,
        "shares.openers",
        Some(&share_input(&share_id)),
    );
    assert_eq!((status, array(data(&after_revoke)).len()), (200, 2));

    // Missing share on revoke is not_found.
    let (status, body) = call(&door, OWNER, "shares.revoke", Some(&share_input(MISSING)));
    assert_eq!(refusal(status, &body), not_found());
}
