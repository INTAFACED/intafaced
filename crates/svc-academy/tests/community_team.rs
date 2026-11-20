//! `team/team-moderation.db.test.ts` in Rust, against Postgres: course team roles (AC-roles-01) and discussion
//! moderation (AC-rooms-02).
//!
//! Roles narrow a founder only where they hold one; a role change waits for a second founder; nobody gives a role above
//! their own; a switched-off custom role permits nothing; a blank custom role limit refuses by name. A report is one per
//! account; the queue lists reported posts still showing; a read-only session deletes nothing; a delete needs a reason
//! and a moderator's role, leaves learner reads, keeps the row, and waits in the outbox until the bus took the author's
//! notice; bulk delete takes one course's posts and no other course's.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod community_support;
mod support;

use community_support::{
    FakeBus, arr, at, b, code, course, data, door, enrol, get, mutate, n, one, refused, s, setup,
};
use service_kit::json::Json;
use service_kit::time::Instant;
use support::TestDb;
use svc_academy::community::Db;
use svc_academy::community::discussion::{self, Limits, NewPost};
use svc_academy::community::moderation::{self, Moderator, Outbox};
use svc_academy::community::team::{self, Caller, Permissions, Propose, SaveCustomRole};
use svc_academy::db::Store;

const A: &str = "11111111-1111-4111-8111-111111111111";
const B: &str = "22222222-2222-4222-8222-222222222222";
const SUPPORT: &str = "33333333-3333-4333-8333-333333333333";
const AUTHOR: &str = "55555555-5555-4555-8555-555555555555";
const PEER: &str = "66666666-6666-4666-8666-666666666666";
const NOW_ISO: &str = "2026-11-12T12:00:00.000Z";

fn now() -> Instant {
    at(NOW_ISO)
}

fn founder(user_id: &str) -> Caller<'_> {
    Caller {
        user_id,
        may_write: true,
    }
}

fn moderator(user_id: &str) -> Moderator<'_> {
    Moderator {
        user_id,
        may_write: true,
    }
}

const READ_ONLY: Moderator<'static> = Moderator {
    user_id: SUPPORT,
    may_write: false,
};

const LIMITS: Limits = Limits {
    post_max_chars: Some(1000),
    image_max_bytes: None,
};

/// A published course created by founder A, with the author and the peer enrolled.
fn a_course(db: &TestDb, slug: &str) -> String {
    let id = course(db, slug, "published", A, NOW_ISO);
    for user in [AUTHOR, PEER] {
        enrol(db, &id, user, NOW_ISO);
    }
    id
}

/// A post in the General topic, numbered by `seq`.
fn post(store: &Store, slug: &str, user_id: &str, seq: &mut u32) -> String {
    *seq += 1;
    let title = format!("TEST post {seq}");
    let req = format!("req-{seq}");
    let made = discussion::create_post(
        &Db(store),
        LIMITS,
        &NewPost {
            course_slug: slug,
            topic_slug: "general",
            kind: "discussion",
            title: &title,
            body: "TEST body",
            anonymous: false,
            image: None,
            client_request_id: &req,
            user_id,
            now: now(),
        },
    )
    .unwrap();
    s(&made, "id")
}

fn propose(
    store: &Store,
    course_id: Option<&str>,
    account: &str,
    role: &str,
    request_id: &str,
    by: &str,
) -> Result<Json, svc_academy::errors::Refusal> {
    team::propose(
        &Db(store),
        &Propose {
            course_id,
            account_id: account,
            role,
            kind: "assign",
            reason: "TEST",
            request_id,
            caller: founder(by),
            now: now(),
        },
    )
}

/// Founder A gives founder B `role` on the course and founder B confirms it.
fn give(store: &Store, course_id: Option<&str>, role: &str) -> Json {
    let req = format!("r-{role}-{}", course_id.unwrap_or("null"));
    let change = propose(store, course_id, B, role, &req, A).unwrap();
    team::confirm(&Db(store), &s(&change, "id"), founder(B), now()).unwrap()
}

fn permissions_of(db: &TestDb, account: &str, course_id: &str) -> Permissions {
    team::permissions_of(&mut db.client(), account, Some(course_id)).unwrap()
}

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

fn ids(list: &Json) -> Vec<String> {
    community_support::items(list)
        .iter()
        .map(|p| s(p, "id"))
        .collect()
}

// ── course team roles (AC-roles-01) ───────────────────────────────────────────

#[test]
fn a_role_change_waits_for_a_second_founder_and_the_proposer_cannot_confirm_it() {
    let Some((db, store)) = setup() else { return };
    let c = a_course(&db, "team-a");
    let change = propose(&store, Some(&c), B, "moderator", "r1", A).unwrap();
    assert_eq!(s(&change, "state"), "pending");
    assert!(!permissions_of(&db, B, &c).narrowed);
    assert_eq!(
        code(team::confirm(
            &Db(&store),
            &s(&change, "id"),
            founder(A),
            now()
        )),
        "academy.second_founder_required"
    );
    // A retry of the same proposal is the same change.
    let again = propose(&store, Some(&c), B, "moderator", "r1", A).unwrap();
    assert_eq!(s(&again, "id"), s(&change, "id"));
    let done = team::confirm(&Db(&store), &s(&change, "id"), founder(B), now()).unwrap();
    assert_eq!(s(&done, "state"), "confirmed");
    assert_eq!(s(&done, "confirmedBy"), B);
    assert_eq!(
        permissions_of(&db, B, &c),
        Permissions {
            narrowed: true,
            permissions: strings(&["discussion.moderate", "discussion.endorse"]),
        }
    );
    // Only on that course: elsewhere B keeps the founder's reach.
    let other = a_course(&db, "team-b");
    assert!(!permissions_of(&db, B, &other).narrowed);
}

#[test]
fn a_moderator_cannot_give_the_admin_role_nor_any_role_without_the_right_to_assign() {
    let Some((db, store)) = setup() else { return };
    let c = a_course(&db, "team-c");
    give(&store, Some(&c), "moderator");
    assert_eq!(
        code(propose(&store, Some(&c), PEER, "admin", "r2", B)),
        "academy.role_escalation"
    );
    assert_eq!(
        code(propose(&store, Some(&c), PEER, "community_ta", "r3", B)),
        "academy.permission_denied"
    );
    assert_eq!(
        one(
            &db,
            &format!("SELECT count(*)::text FROM academy.team_changes WHERE proposed_by = '{B}'")
        ),
        "0"
    );
}

#[test]
fn limited_staff_cannot_edit_content_and_can_read_reports() {
    let Some((db, store)) = setup() else { return };
    let c = a_course(&db, "team-d");
    give(&store, Some(&c), "limited_staff");
    assert_eq!(
        code(team::require(&mut db.client(), B, Some(&c), "content.edit")),
        "academy.permission_denied"
    );
    team::require(&mut db.client(), B, Some(&c), "reports").unwrap();
}

#[test]
fn a_blank_custom_role_limit_refuses_by_name_with_it_set_the_role_saves_and_switched_off_it_permits_nothing()
 {
    let Some((db, store)) = setup() else { return };
    let c = a_course(&db, "team-e");
    let input = |name: &'static str, request_id: &'static str| SaveCustomRole {
        name,
        permissions: strings(&["reports", "comments"]),
        reason: "TEST",
        request_id,
        caller: founder(A),
        now: now(),
    };
    assert_eq!(
        code(team::save_custom_role(
            &Db(&store),
            None,
            &input("test_reviewer", "cr1")
        )),
        "academy.role_limit_unset"
    );
    let role =
        team::save_custom_role(&Db(&store), Some(1), &input("test_reviewer", "cr1")).unwrap();
    assert_eq!(s(&role, "kind"), "custom");
    assert!(b(&role, "active"));
    assert_eq!(
        get(&role, "permissions"),
        &Json::Array(vec![Json::str("reports"), Json::str("comments")])
    );
    let r = s(&role, "ref");
    assert_eq!(
        s(
            &team::save_custom_role(&Db(&store), Some(1), &input("test_reviewer", "cr1")).unwrap(),
            "ref"
        ),
        r
    );
    assert_eq!(
        code(team::save_custom_role(
            &Db(&store),
            Some(1),
            &input("test_other", "cr2")
        )),
        "academy.role_limit_reached"
    );
    give(&store, Some(&c), &r);
    assert_eq!(
        permissions_of(&db, B, &c).permissions,
        strings(&["reports", "comments"])
    );
    let role_id = &r[7..];
    let off = team::set_custom_role_active(&Db(&store), role_id, false, "TEST", founder(A), now())
        .unwrap();
    assert!(!b(&off, "active"));
    assert_eq!(n(&off, "holders"), 1);
    assert_eq!(
        permissions_of(&db, B, &c),
        Permissions {
            narrowed: true,
            permissions: vec![],
        }
    );
    assert_eq!(
        code(team::set_custom_role_active(
            &Db(&store),
            role_id,
            true,
            " ",
            founder(A),
            now()
        )),
        "academy.reason_required"
    );
}

// ── discussion moderation (AC-rooms-02) ───────────────────────────────────────

fn no_log(_: &str, _: &str) {}

fn outbox(bus: &FakeBus) -> Outbox<'_> {
    Outbox {
        bus,
        producer: "svc-academy",
        log: &no_log,
    }
}

/// The notices the bus took, as the TypeScript test's `ModerationNotice` list.
fn notices(bus: &FakeBus) -> Vec<Json> {
    bus.sent()
        .into_iter()
        .map(|(subject, _, envelope)| {
            assert_eq!(subject, moderation::SUBJECT);
            get(&envelope, "payload").clone()
        })
        .collect()
}

fn notice(event_id: &str, title: &str, posts: i64, reason: &str) -> Json {
    Json::obj([
        ("eventId", Json::str(event_id)),
        ("authorId", Json::str(AUTHOR)),
        ("courseTitle", Json::str(title)),
        ("posts", Json::int(posts)),
        ("reason", Json::str(reason)),
    ])
}

fn event(answer: Json) -> Json {
    get(&answer, "event").clone()
}

#[test]
fn a_report_is_one_per_account_the_queue_lists_it_and_a_read_only_session_deletes_nothing() {
    let Some((db, store)) = setup() else { return };
    let bus = FakeBus::default();
    let mut seq = 0;
    a_course(&db, "mod-a");
    let p = post(&store, "mod-a", AUTHOR, &mut seq);
    let first = moderation::report(&Db(&store), PEER, &p, "TEST spam", now()).unwrap();
    assert_eq!(
        first,
        Json::obj([("postId", Json::str(&p)), ("reported", Json::Bool(true))])
    );
    let second = moderation::report(&Db(&store), PEER, &p, "TEST again", now()).unwrap();
    assert_eq!(
        second,
        Json::obj([("postId", Json::str(&p)), ("reported", Json::Bool(false))])
    );
    assert_eq!(
        code(moderation::report(&Db(&store), SUPPORT, &p, "TEST", now())),
        "academy.enrolment_required"
    );
    let queue = moderation::queue(&Db(&store), None, 50, READ_ONLY).unwrap();
    assert!(!b(&queue, "mayWrite"));
    let reports = arr(&queue, "reports");
    assert_eq!(reports.len(), 1);
    let r = &reports[0];
    assert_eq!(s(r, "postId"), p);
    assert_eq!(n(r, "reports"), 1);
    assert_eq!(
        get(r, "reasons"),
        &Json::Array(vec![Json::str("TEST spam")])
    );
    assert_eq!(s(r, "authorId"), AUTHOR);
    assert!(!b(r, "mayModerate"));
    assert_eq!(
        code(moderation::delete_post(
            &Db(&store),
            &outbox(&bus),
            &p,
            "TEST",
            READ_ONLY,
            now()
        )),
        "academy.permission_denied"
    );
}

#[test]
fn a_delete_needs_a_reason_and_a_moderator_role_it_leaves_learner_reads_keeps_the_row_and_tells_the_author_once()
 {
    let Some((db, store)) = setup() else { return };
    let bus = FakeBus::default();
    let mut seq = 0;
    let c = a_course(&db, "mod-b");
    let p = post(&store, "mod-b", AUTHOR, &mut seq);
    let reply = discussion::reply(
        &Db(&store),
        LIMITS,
        &p,
        "TEST reply",
        false,
        "reply-1",
        PEER,
        now(),
    )
    .unwrap();
    let reply_id = s(&reply, "id");
    moderation::report(&Db(&store), PEER, &p, "TEST spam", now()).unwrap();
    assert_eq!(
        code(moderation::delete_post(
            &Db(&store),
            &outbox(&bus),
            &p,
            "  ",
            moderator(A),
            now()
        )),
        "academy.reason_required"
    );
    // Limited staff on the course may not moderate.
    give(&store, Some(&c), "limited_staff");
    assert_eq!(
        code(moderation::delete_post(
            &Db(&store),
            &outbox(&bus),
            &p,
            "TEST",
            moderator(B),
            now()
        )),
        "academy.permission_denied"
    );
    let ev = event(
        moderation::delete_post(
            &Db(&store),
            &outbox(&bus),
            &p,
            "TEST off-topic",
            moderator(A),
            now(),
        )
        .unwrap(),
    );
    assert_eq!(s(&ev, "action"), "delete");
    assert_eq!(s(&ev, "postId"), p);
    assert_eq!(s(&ev, "authorId"), AUTHOR);
    assert_eq!(n(&ev, "posts"), 1);
    assert_eq!(s(&ev, "actorId"), A);
    assert_eq!(s(&ev, "reason"), "TEST off-topic");
    let id = s(&ev, "id");
    assert_eq!(
        notices(&bus),
        vec![notice(&id, "TEST mod-b", 1, "TEST off-topic")]
    );
    // A repeat answers with the same event and tells nobody again.
    let again = event(
        moderation::delete_post(
            &Db(&store),
            &outbox(&bus),
            &p,
            "TEST off-topic",
            moderator(A),
            now(),
        )
        .unwrap(),
    );
    assert_eq!(s(&again, "id"), id);
    assert_eq!(notices(&bus).len(), 1);
    // Gone from learners, the reply with it; the queue has no open report; the row is kept with who and why.
    assert_eq!(
        discussion::posts(&Db(&store), PEER, "mod-b", "general", 50).unwrap(),
        Json::Array(vec![])
    );
    assert_eq!(
        code(discussion::thread(&Db(&store), PEER, &p, 50)),
        "academy.post_not_found"
    );
    assert_eq!(
        code(discussion::like(&Db(&store), PEER, &reply_id, true, now())),
        "academy.post_not_found"
    );
    let queue = moderation::queue(&Db(&store), Some(&c), 50, moderator(A)).unwrap();
    assert!(arr(&queue, "reports").is_empty());
    assert_eq!(
        db.texts(&format!(
            "SELECT removed_by::text || '|' || removed_reason FROM academy.discussion_posts WHERE id = '{p}'"
        )),
        vec![format!("{A}|TEST off-topic")]
    );
}

#[test]
fn with_the_bus_down_the_notice_waits_in_the_outbox_and_goes_on_the_next_send() {
    let Some((db, store)) = setup() else { return };
    let bus = FakeBus::default();
    bus.set_fail(true);
    let mut seq = 0;
    a_course(&db, "mod-c");
    let p = post(&store, "mod-c", AUTHOR, &mut seq);
    let ev = event(
        moderation::delete_post(&Db(&store), &outbox(&bus), &p, "TEST", moderator(A), now())
            .unwrap(),
    );
    let id = s(&ev, "id");
    assert_eq!(
        one(
            &db,
            &format!(
                "SELECT (notified_at IS NULL)::text FROM academy.moderation_events WHERE id = '{id}'"
            )
        ),
        "true"
    );
    bus.set_fail(false);
    assert_eq!(
        moderation::send_waiting(&Db(&store), &outbox(&bus)).unwrap(),
        1
    );
    assert_eq!(
        notices(&bus)
            .iter()
            .map(|x| s(x, "eventId"))
            .collect::<Vec<_>>(),
        vec![id]
    );
    assert_eq!(
        moderation::send_waiting(&Db(&store), &outbox(&bus)).unwrap(),
        0
    );
}

#[test]
fn bulk_delete_takes_one_authors_posts_in_one_course_and_none_elsewhere() {
    let Some((db, store)) = setup() else { return };
    let bus = FakeBus::default();
    let mut seq = 0;
    let x = a_course(&db, "mod-x");
    a_course(&db, "mod-y");
    let x1 = post(&store, "mod-x", AUTHOR, &mut seq);
    let x2 = post(&store, "mod-x", AUTHOR, &mut seq);
    let peer_post = post(&store, "mod-x", PEER, &mut seq);
    let y1 = post(&store, "mod-y", AUTHOR, &mut seq);
    let ev = event(
        moderation::bulk_delete(
            &Db(&store),
            &outbox(&bus),
            &x,
            AUTHOR,
            "TEST spam account",
            moderator(A),
            now(),
        )
        .unwrap(),
    );
    assert_eq!(s(&ev, "action"), "bulk_delete");
    assert_eq!(get(&ev, "postId"), &Json::Null);
    assert_eq!(n(&ev, "posts"), 2);
    let in_x = ids(&discussion::posts(&Db(&store), PEER, "mod-x", "general", 50).unwrap());
    assert_eq!(in_x, vec![peer_post]);
    assert!(!in_x.contains(&x1));
    assert!(!in_x.contains(&x2));
    assert_eq!(
        ids(&discussion::posts(&Db(&store), PEER, "mod-y", "general", 50).unwrap()),
        vec![y1]
    );
    assert_eq!(
        notices(&bus),
        vec![notice(&s(&ev, "id"), "TEST mod-x", 2, "TEST spam account")]
    );
    // Nothing left to delete: a second bulk delete is recorded with 0 posts and tells nobody.
    let none = event(
        moderation::bulk_delete(
            &Db(&store),
            &outbox(&bus),
            &x,
            AUTHOR,
            "TEST again",
            moderator(A),
            now(),
        )
        .unwrap(),
    );
    assert_eq!(n(&none, "posts"), 0);
    assert_eq!(notices(&bus).len(), 1);
}

// ── through the door ──────────────────────────────────────────────────────────

/// The router's own checks on a team call: a read-only session may not propose; a founder's proposal waits; the same
/// founder confirming it is refused by its code.
#[test]
fn the_door_answers_a_team_change_and_refuses_its_proposer_confirming_it() {
    let Some((db, store)) = setup() else { return };
    let c = a_course(&db, "door-team");
    let door = door(store, Json::obj([]));
    let input = Json::obj([
        ("courseId", Json::str(&c)),
        ("accountId", Json::str(B)),
        ("role", Json::str("moderator")),
        ("kind", Json::str("assign")),
        ("reason", Json::str("TEST")),
        ("requestId", Json::str("door-r1")),
    ]);
    let read_only = mutate(&door, A, &["admin:read"], "admin.proposeTeamChange", &input);
    assert_eq!(read_only.0, 403, "{}", read_only.1.compact());
    let change = data(&mutate(
        &door,
        A,
        &["admin:read", "admin:write"],
        "admin.proposeTeamChange",
        &input,
    ));
    assert_eq!(s(&change, "state"), "pending");
    let confirm = Json::obj([("changeId", Json::str(s(&change, "id")))]);
    let (_, _, cause) = refused(&mutate(
        &door,
        A,
        &["admin:read", "admin:write"],
        "admin.confirmTeamChange",
        &confirm,
    ));
    assert_eq!(cause, "academy.second_founder_required");
    let done = data(&mutate(
        &door,
        B,
        &["admin:read", "admin:write"],
        "admin.confirmTeamChange",
        &confirm,
    ));
    assert_eq!(s(&done, "state"), "confirmed");
    assert_eq!(s(&done, "confirmedBy"), B);
}
