//! Slice `card` against a real `blueprint` schema, every call entering through the Rust door: the ports of
//! `blueprint-service.test.ts`'s `card` and `visibility-gated cardFor` tests and of `card-shares.pg.test.ts`'s share
//! opens, each named after the TypeScript test. Rows are written straight into the tables: onboarding, which writes
//! the Blueprint and the crew there, is slice `onboard`'s, and `shares.create` and `shares.revoke` are slice `shares`'s.
//! Left to those slices: the TypeScript's revoke-queued-behind-a-held-row test, which needs `shares.revoke`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::sync::{Arc, Mutex};

use crate::support::{TestDb, call, data};
use postgres::NoTls;
use service_kit::json::Json;
use svc_blueprint::card::compose::{self, Size, Subject};
use svc_blueprint::card::renderer::{CardRenderer, Raster, RasterizeRequest};

const OWNER: &str = "11111111-1111-4111-8111-111111111111";
const VIEWER: &str = "22222222-2222-4222-8222-222222222222";
const MATE: &str = "33333333-3333-4333-8333-333333333333";
const STRANGER: &str = "44444444-4444-4444-8444-444444444444";
const CREW: &str = "55555555-5555-4555-8555-555555555555";
const MISSING: &str = "66666666-6666-4666-8666-666666666666";

const PROFILE: &str = r#"{"decisionStyle":"analytical","riskTemperament":"measured","energyRhythm":"steady","learningMode":"systematic","crewRole":"anchor","curriculumPath":"foundations","toneRegister":"direct","guardrails":{"maxLeverage":1,"dailyLossPromptPct":5,"confirmBeforeMarketOrder":true,"copyTradingVisible":false}}"#;
const CARD_NOT_FOUND: &str = "No Blueprint to render a card for — run the Blueprint session first";
const RENDERED_URL: &str = "https://cdn.example.com/card.png";

/// A Blueprint row for `user`; its id.
fn seed(db: &TestDb, user: &str, visibility: &str) -> String {
    seed_profile(db, user, PROFILE, visibility)
}

fn seed_profile(db: &TestDb, user: &str, profile: &str, visibility: &str) -> String {
    db.client()
        .query_one(
            "INSERT INTO blueprint.blueprints (user_id, engine_version, profile, visibility)
             VALUES ($1::text::uuid, 'test', $2::text::jsonb, $3::text::blueprint.blueprint_visibility)
             RETURNING id::text",
            &[&user, &profile, &visibility],
        )
        .unwrap()
        .get(0)
}

/// `users` placed in one crew, as onboarding places them.
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

/// An active share of `owner`'s card, as `shares.create` writes one; its id.
fn share(db: &TestDb, owner: &str, size: &str) -> String {
    db.client()
        .query_one(
            "INSERT INTO blueprint.card_shares (owner_user_id, size) VALUES ($1::text::uuid, $2) RETURNING id::text",
            &[&owner, &size],
        )
        .unwrap()
        .get(0)
}

fn open_counts(db: &TestDb, share: &str) -> Vec<i32> {
    db.client()
        .query(
            "SELECT open_count FROM blueprint.card_opens WHERE share_id = $1::text::uuid",
            &[&share],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect()
}

fn asset_url(db: &TestDb, user: &str) -> Option<String> {
    db.client()
        .query_one(
            "SELECT card_asset_url FROM blueprint.blueprints WHERE user_id = $1::text::uuid",
            &[&user],
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

/// A refusal's status, tRPC code, message and `cause.code`.
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

/// A renderer that really renders, and keeps every request.
#[derive(Clone)]
struct Stub {
    calls: Arc<Mutex<Vec<RasterizeRequest>>>,
}

impl Stub {
    fn new() -> Stub {
        Stub {
            calls: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl CardRenderer for Stub {
    fn rasterize(&self, request: &RasterizeRequest) -> Raster {
        self.calls.lock().unwrap().push(request.clone());
        Raster::Rendered {
            url: RENDERED_URL.to_owned(),
            bytes: 84_000.0,
        }
    }
}

fn card_input(size: &str) -> String {
    format!(r#"{{"size":"{size}"}}"#)
}

fn of_subject(user: &str) -> String {
    format!(r#"{{"userId":"{user}","size":"portrait"}}"#)
}

fn of_share(share: &str, size: &str) -> String {
    format!(r#"{{"shareId":"{share}","size":"{size}"}}"#)
}

// ── card ──────────────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn refuses_when_there_is_no_blueprint_rather_than_drawing_an_empty_card() {
    let Some(db) = TestDb::migrated() else { return };
    let (status, body) = call(&db.door(), OWNER, "card", Some(&card_input("portrait")));
    assert_eq!(refusal(status, &body), not_found());
}

#[test]
fn composes_a_card_at_both_share_sizes_carrying_the_placed_crew() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "private");
    same_crew(&db, &[OWNER]);
    let door = db.door();
    for (size, width, height) in [("portrait", 1080, 1350), ("landscape", 1200, 630)] {
        let (status, body) = call(&door, OWNER, "card", Some(&card_input(size)));
        assert_eq!(status, 200, "{}", body.compact());
        let card = data(&body);
        assert_eq!(text(card, "size"), size);
        assert_eq!(card.get("width"), Some(&Json::int(width)));
        assert_eq!(card.get("height"), Some(&Json::int(height)));
        let svg = text(card, "svg");
        assert!(svg.contains(&format!(r#"width="{width}""#)));
        assert!(svg.contains(&format!(r#"height="{height}""#)));
        assert!(!svg.contains("Unplaced"));
        // The card the composer draws for this profile and crew, byte for byte.
        let subject = Subject {
            decision_style: "analytical".to_owned(),
            risk_temperament: "measured".to_owned(),
            energy_rhythm: "steady".to_owned(),
            learning_mode: "systematic".to_owned(),
            crew_role: "anchor".to_owned(),
            curriculum_path: "foundations".to_owned(),
            tone_register: "direct".to_owned(),
            crew_name: Some("TEST crew".to_owned()),
            season: Some(1),
        };
        assert_eq!(
            svg,
            compose::compose(&subject, Size::parse(size).unwrap()).unwrap()
        );
        // Key for key, the record's output.
        let keys: Vec<&str> = match card {
            Json::Object(fields) => fields.iter().map(|(k, _)| k.as_str()).collect(),
            _ => panic!(),
        };
        assert_eq!(
            keys,
            ["size", "width", "height", "svg", "raster", "shareMode"]
        );
    }
}

#[test]
fn renders_in_full_with_no_rasterizer_and_says_why_there_is_no_png() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "private");
    let (status, body) = call(&db.door(), OWNER, "card", Some(&card_input("portrait")));
    assert_eq!(status, 200);
    let card = data(&body);
    assert!(text(card, "svg").len() > 1_000);
    // Unplaced is an honest state, drawn as such.
    assert!(text(card, "svg").contains(">Unplaced<"));
    let raster = card.get("raster").unwrap();
    assert_eq!(text(raster, "status"), "unavailable");
    assert_eq!(text(raster, "code"), "blueprint.card_renderer_unconfigured");
    assert!(raster.get("url").is_none());
    // Stage-1 shareMode is svg when the raster is unavailable.
    assert_eq!(text(card, "shareMode"), "svg");
}

#[test]
fn does_not_write_card_asset_url_when_the_raster_is_unavailable() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "private");
    call(&db.door(), OWNER, "card", Some(&card_input("portrait")));
    assert_eq!(asset_url(&db, OWNER), None);
}

#[test]
fn writes_card_asset_url_when_a_raster_really_came_back_and_shares_it_as_png() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "private");
    let door = db.door_with(Box::new(Stub::new()));
    let (status, body) = call(&door, OWNER, "card", Some(&card_input("portrait")));
    assert_eq!(status, 200);
    let card = data(&body);
    assert_eq!(
        card.get("raster").unwrap().compact(),
        format!(
            r#"{{"status":"rendered","url":"{RENDERED_URL}","contentType":"image/png","bytes":84000}}"#
        )
    );
    assert_eq!(text(card, "shareMode"), "png");
    assert_eq!(asset_url(&db, OWNER).as_deref(), Some(RENDERED_URL));
    let (_, me) = call(&door, OWNER, "me", None);
    assert_eq!(text(data(&me), "cardAssetUrl"), RENDERED_URL);
}

#[test]
fn keys_the_asset_on_the_blueprint_id_never_on_the_user_id() {
    let Some(db) = TestDb::migrated() else { return };
    let id = seed(&db, OWNER, "private");
    let stub = Stub::new();
    let door = db.door_with(Box::new(stub.clone()));
    call(&door, OWNER, "card", Some(&card_input("portrait")));
    let calls = stub.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].blueprint_id, id);
    assert_ne!(calls[0].blueprint_id, OWNER);
    assert_eq!((calls[0].width, calls[0].height), (1080, 1350));
}

#[test]
fn does_not_persist_a_landscape_url_over_the_primary_portrait_asset() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "private");
    let door = db.door_with(Box::new(Stub::new()));
    call(&door, OWNER, "card", Some(&card_input("landscape")));
    assert_eq!(asset_url(&db, OWNER), None);
    call(&door, OWNER, "card", Some(&card_input("portrait")));
    assert_eq!(asset_url(&db, OWNER).as_deref(), Some(RENDERED_URL));
}

#[test]
fn is_stable_the_same_blueprint_yields_a_byte_identical_card() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "private");
    let door = db.door();
    let (_, first) = call(&door, OWNER, "card", Some(&card_input("portrait")));
    let (_, second) = call(&door, OWNER, "card", Some(&card_input("portrait")));
    assert_eq!(text(data(&first), "svg"), text(data(&second), "svg"));
}

#[test]
fn does_not_write_card_asset_url_when_a_stranger_views_via_card_of() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "public");
    let door = db.door_with(Box::new(Stub::new()));
    let (status, _) = call(&door, VIEWER, "cardOf", Some(&of_subject(OWNER)));
    assert_eq!(status, 200);
    assert_eq!(asset_url(&db, OWNER), None);
}

#[test]
fn is_not_touched_by_the_mentor_shortlist_which_reaches_no_rasterizer_at_all() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "private");
    let stub = Stub::new();
    let door = db.door_with(Box::new(stub.clone()));
    let (status, _) = call(&door, OWNER, "mentors", None);
    assert_eq!(status, 200);
    assert!(stub.calls.lock().unwrap().is_empty());
}

#[test]
fn a_stored_profile_with_a_personal_key_is_refused_before_it_is_drawn() {
    // `StoredProfile` keeps any key a row holds; the card's subject passes the zero-PII bar before it is composed.
    let Some(db) = TestDb::migrated() else { return };
    let with_name = PROFILE.replacen('{', r#"{"name":"Ada","#, 1);
    seed_profile(&db, OWNER, &with_name, "private");
    let stub = Stub::new();
    let door = db.door_with(Box::new(stub.clone()));
    let (status, body) = call(&door, OWNER, "card", Some(&card_input("portrait")));
    assert_eq!(
        refusal(status, &body),
        (
            400,
            "BAD_REQUEST".to_owned(),
            "card.subject: attestation/card payload refuses PII field name (blueprint.attestation_pii_identity)"
                .to_owned(),
            Some("blueprint.attestation_pii_identity".to_owned())
        )
    );
    assert!(stub.calls.lock().unwrap().is_empty());
}

// ── visibility-gated cardFor ──────────────────────────────────────────────────────────────────────────────────────

#[test]
fn lets_the_owner_read_their_own_card_even_when_private() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "private");
    let (status, body) = call(&db.door(), OWNER, "cardOf", Some(&of_subject(OWNER)));
    assert_eq!(status, 200);
    assert!(text(data(&body), "svg").len() > 1_000);
    assert_eq!(text(data(&body), "shareMode"), "svg");
}

#[test]
fn the_owner_reading_their_own_card_by_subject_is_the_owner_path_and_stores_the_portrait() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "private");
    let door = db.door_with(Box::new(Stub::new()));
    call(&door, OWNER, "cardOf", Some(&of_subject(OWNER)));
    assert_eq!(asset_url(&db, OWNER).as_deref(), Some(RENDERED_URL));
}

#[test]
fn hides_a_private_card_from_anyone_else_same_error_as_missing() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "private");
    let door = db.door();
    let (status, body) = call(&door, VIEWER, "cardOf", Some(&of_subject(OWNER)));
    assert_eq!(refusal(status, &body), not_found());
    let (status, body) = call(&door, VIEWER, "cardOf", Some(&of_subject(MISSING)));
    assert_eq!(refusal(status, &body), not_found());
}

#[test]
fn public_lets_any_authenticated_viewer_read_the_card_and_private_hides_it_again() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "private");
    let door = db.door();
    let (status, body) = call(
        &door,
        OWNER,
        "setVisibility",
        Some(r#"{"visibility":"public"}"#),
    );
    assert_eq!((status, text(data(&body), "visibility")), (200, "public"));
    let (status, body) = call(&door, VIEWER, "cardOf", Some(&of_subject(OWNER)));
    assert_eq!(status, 200);
    assert!(text(data(&body), "svg").len() > 1_000);

    call(
        &door,
        OWNER,
        "setVisibility",
        Some(r#"{"visibility":"private"}"#),
    );
    let (status, body) = call(&door, VIEWER, "cardOf", Some(&of_subject(OWNER)));
    assert_eq!(refusal(status, &body), not_found());
}

#[test]
fn crew_visibility_is_same_crew_only_outsiders_get_not_found() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "crew");
    seed(&db, MATE, "crew");
    same_crew(&db, &[OWNER, MATE]);
    let door = db.door();
    let (status, body) = call(&door, MATE, "cardOf", Some(&of_subject(OWNER)));
    assert_eq!(status, 200);
    assert!(text(data(&body), "svg").len() > 1_000);
    let (status, body) = call(&door, STRANGER, "cardOf", Some(&of_subject(OWNER)));
    assert_eq!(refusal(status, &body), not_found());
}

#[test]
fn a_deleted_blueprint_leaves_no_card_to_read() {
    // The TypeScript proves this through `erase` (slice `privacy`): the card is derived on read, so a removed row
    // leaves nothing behind.
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "public");
    db.client()
        .execute("DELETE FROM blueprint.blueprints", &[])
        .unwrap();
    let door = db.door();
    let (status, body) = call(&door, VIEWER, "cardOf", Some(&of_subject(OWNER)));
    assert_eq!(refusal(status, &body), not_found());
    let (status, body) = call(&door, OWNER, "card", Some(&card_input("portrait")));
    assert_eq!(refusal(status, &body), not_found());
}

// ── card shares (MC-blueprint-01) ─────────────────────────────────────────────────────────────────────────────────

#[test]
fn an_open_returns_the_shares_own_size_and_a_second_open_counts_on_the_same_row() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "public");
    let id = share(&db, OWNER, "portrait");
    let door = db.door();
    let (status, body) = call(&door, VIEWER, "cardOf", Some(&of_share(&id, "landscape")));
    assert_eq!(status, 200, "{}", body.compact());
    assert_eq!(text(data(&body), "size"), "portrait");
    assert_eq!(data(&body).get("width"), Some(&Json::int(1080)));
    let (status, _) = call(&door, VIEWER, "cardOf", Some(&of_share(&id, "portrait")));
    assert_eq!(status, 200);
    assert_eq!(open_counts(&db, &id), vec![2]);
}

#[test]
fn a_crew_member_opens_a_crew_card_and_an_outsider_is_refused() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "crew");
    seed(&db, MATE, "crew");
    same_crew(&db, &[OWNER, MATE]);
    let id = share(&db, OWNER, "portrait");
    let door = db.door();
    let (status, _) = call(&door, MATE, "cardOf", Some(&of_share(&id, "portrait")));
    assert_eq!(status, 200);
    let (status, body) = call(&door, STRANGER, "cardOf", Some(&of_share(&id, "portrait")));
    assert_eq!(refusal(status, &body), not_found());
    assert_eq!(open_counts(&db, &id), vec![1]);
}

#[test]
fn refuses_a_viewer_the_visibility_rule_excludes_and_writes_no_open_row() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "private");
    let id = share(&db, OWNER, "portrait");
    let door = db.door();
    let (status, body) = call(
        &door,
        VIEWER,
        "cardOf",
        Some(&of_share(MISSING, "portrait")),
    );
    assert_eq!(refusal(status, &body), not_found());
    let (status, body) = call(&door, VIEWER, "cardOf", Some(&of_share(&id, "portrait")));
    assert_eq!(refusal(status, &body), not_found());
    assert!(open_counts(&db, &id).is_empty());
}

#[test]
fn a_revoked_share_and_a_share_of_another_subject_are_not_found() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "public");
    let id = share(&db, OWNER, "portrait");
    let door = db.door();
    let named = format!(r#"{{"userId":"{STRANGER}","shareId":"{id}","size":"portrait"}}"#);
    let (status, body) = call(&door, VIEWER, "cardOf", Some(&named));
    assert_eq!(refusal(status, &body), not_found());
    db.client()
        .execute(
            "UPDATE blueprint.card_shares SET revoked_at = now() WHERE id = $1::text::uuid",
            &[&id],
        )
        .unwrap();
    let (status, body) = call(&door, VIEWER, "cardOf", Some(&of_share(&id, "portrait")));
    assert_eq!(refusal(status, &body), not_found());
    assert!(open_counts(&db, &id).is_empty());
}

#[test]
fn the_owner_is_not_an_opener_of_their_own_share_and_only_their_portrait_render_is_stored() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "public");
    let id = share(&db, OWNER, "portrait");
    let door = db.door_with(Box::new(Stub::new()));
    let (status, _) = call(&door, VIEWER, "cardOf", Some(&of_share(&id, "portrait")));
    assert_eq!(status, 200);
    assert_eq!(asset_url(&db, OWNER), None);
    let (status, _) = call(&door, OWNER, "cardOf", Some(&of_share(&id, "portrait")));
    assert_eq!(status, 200);
    assert_eq!(open_counts(&db, &id), vec![1]);
    assert_eq!(asset_url(&db, OWNER).as_deref(), Some(RENDERED_URL));
}

#[test]
fn fails_the_read_closed_when_the_open_row_cannot_be_written() {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "public");
    let id = share(&db, OWNER, "portrait");
    db.client()
        .batch_execute(
            "CREATE OR REPLACE FUNCTION blueprint.mc_blueprint_01_fail_open() RETURNS trigger
               LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'open log refused'; END $$;
             CREATE TRIGGER mc_blueprint_01_fail_open BEFORE INSERT ON blueprint.card_opens
               FOR EACH ROW EXECUTE FUNCTION blueprint.mc_blueprint_01_fail_open();",
        )
        .unwrap();
    let (status, body) = call(
        &db.door(),
        VIEWER,
        "cardOf",
        Some(&of_share(&id, "portrait")),
    );
    assert_eq!(
        refusal(status, &body),
        (
            500,
            "INTERNAL_SERVER_ERROR".to_owned(),
            "The open could not be recorded, so the card was not returned".to_owned(),
            Some("blueprint.open_log_unavailable".to_owned())
        )
    );
    assert!(open_counts(&db, &id).is_empty());
}

/// A renderer that marks that it ran, and runs `during` first.
struct During {
    rendered: Arc<Mutex<bool>>,
    during: Box<dyn Fn() + Send + Sync>,
}

impl CardRenderer for During {
    fn rasterize(&self, _request: &RasterizeRequest) -> Raster {
        (self.during)();
        *self.rendered.lock().unwrap() = true;
        Raster::Unavailable {
            code: "blueprint.card_renderer_unconfigured",
            reason: "TEST".to_owned(),
        }
    }
}

#[test]
fn a_revoke_that_commits_after_the_open_insert_and_before_the_response_returns_not_found_and_leaves_no_open_row()
 {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "public");
    let id = share(&db, OWNER, "portrait");
    // The trigger revokes in the open's own transaction, after its insert: the re-read under the lock must roll the
    // open back.
    db.client()
        .batch_execute(
            "CREATE FUNCTION blueprint.mc_blueprint_01_revoke_during_open() RETURNS trigger
               LANGUAGE plpgsql AS $$
               BEGIN
                 UPDATE blueprint.card_shares SET revoked_at = now() WHERE id = NEW.share_id AND revoked_at IS NULL;
                 RETURN NEW;
               END $$;
             CREATE TRIGGER mc_blueprint_01_revoke_during_open AFTER INSERT ON blueprint.card_opens
               FOR EACH ROW EXECUTE FUNCTION blueprint.mc_blueprint_01_revoke_during_open();",
        )
        .unwrap();
    let rendered = Arc::new(Mutex::new(false));
    let door = db.door_with(Box::new(During {
        rendered: rendered.clone(),
        during: Box::new(|| {}),
    }));
    let (status, body) = call(&door, VIEWER, "cardOf", Some(&of_share(&id, "portrait")));
    assert_eq!(refusal(status, &body), not_found());
    assert!(*rendered.lock().unwrap());
    assert!(open_counts(&db, &id).is_empty());
    let revoked: Option<String> = db
        .client()
        .query_one(
            "SELECT revoked_at::text FROM blueprint.card_shares WHERE id = $1::text::uuid",
            &[&id],
        )
        .unwrap()
        .get(0);
    assert_eq!(revoked, None);
}

#[test]
fn renders_without_holding_the_share_so_a_revoke_during_the_render_commits_and_the_card_is_not_returned()
 {
    let Some(db) = TestDb::migrated() else { return };
    seed(&db, OWNER, "public");
    let id = share(&db, OWNER, "portrait");
    // The renderer revokes on another connection and waits for it: if the share's row were held through the render,
    // this would wait on its own lock.
    let url = db.url.clone();
    let share_id = id.clone();
    let rendered = Arc::new(Mutex::new(false));
    let door = db.door_with(Box::new(During {
        rendered: rendered.clone(),
        during: Box::new(move || {
            let mut c = postgres::Client::connect(&url, NoTls).unwrap();
            c.batch_execute("SET lock_timeout = '3s'").unwrap();
            c.execute(
                "UPDATE blueprint.card_shares SET revoked_at = now() WHERE id = $1::text::uuid AND revoked_at IS NULL",
                &[&share_id],
            )
            .unwrap();
        }),
    }));
    let (status, body) = call(&door, VIEWER, "cardOf", Some(&of_share(&id, "portrait")));
    assert_eq!(refusal(status, &body), not_found());
    assert!(*rendered.lock().unwrap());
    assert!(open_counts(&db, &id).is_empty());
}
