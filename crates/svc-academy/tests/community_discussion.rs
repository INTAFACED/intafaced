//! `curriculum/discussion.db.test.ts` (AC-rooms-01) against Postgres: topics come pinned first with General; only enrolled
//! learners read and post; a retry is one post; a non-image or oversized file and a blank owner value refuse by name; the
//! asker's accepted answer moves; follow and like are set once; an anonymous post hides its author from classmates and
//! not from staff. Then the moderation outbox at each crash point (publish ok and the `notified_at` write fails; the
//! publish fails), and the discussion calls through the door.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod community_support;
mod support;

use std::sync::Mutex;

use community_support::{
    FakeBus, arr, at, b, code, door, items, mutate, n, one, query, refused, s, setup,
};
use service_kit::json::Json;
use service_kit::time::Instant;
use support::TestDb;
use svc_academy::community::Db;
use svc_academy::community::discussion::{self, Limits, NewPost, SaveTopic, classmate_label};
use svc_academy::community::moderation::{self, Moderator, Outbox, SUBJECT};
use svc_academy::db::Store;

const STAFF: &str = "33333333-3333-4333-8333-333333333333";
const ME: &str = "55555555-5555-4555-8555-555555555555";
const PEER: &str = "66666666-6666-4666-8666-666666666666";
const STRANGER: &str = "77777777-7777-4777-8777-777777777777";
const NOW_ISO: &str = "2026-10-24T19:00:00.000Z";
const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
/// `Buffer.from('%PDF-1.4\n').toString('base64')`.
const PDF: &str = "JVBERi0xLjQK";
/// `Buffer.from('<svg/>').toString('base64')`.
const SVG: &str = "PHN2Zy8+";
const LIMITS: Limits = Limits {
    post_max_chars: Some(100),
    image_max_bytes: Some(1024),
};

fn now() -> Instant {
    at(NOW_ISO)
}

/// A published free course, and enrolments for ME and PEER.
fn course(db: &TestDb) -> String {
    let id = community_support::course(db, "risk-basics", "published", STAFF, NOW_ISO);
    for user in [ME, PEER] {
        community_support::enrol(db, &id, user, NOW_ISO);
    }
    id
}

fn count(db: &TestDb, table: &str) -> String {
    one(db, &format!("SELECT count(*)::text FROM academy.{table}"))
}

/// `post(d, over)`: the default post, with what `over` changes.
struct Post<'a> {
    kind: &'a str,
    title: &'a str,
    body: &'a str,
    anonymous: bool,
    image: Option<(&'a str, &'a str)>,
    request: &'a str,
    user: &'a str,
}

impl Default for Post<'_> {
    fn default() -> Self {
        Post {
            kind: "question",
            title: "TEST How big?",
            body: "TEST How big should one trade be?",
            anonymous: false,
            image: None,
            request: "post:1",
            user: ME,
        }
    }
}

fn post(store: &Store, limits: Limits, p: &Post<'_>) -> Result<Json, svc_academy::errors::Refusal> {
    discussion::create_post(
        &Db(store),
        limits,
        &NewPost {
            course_slug: "risk-basics",
            topic_slug: "general",
            kind: p.kind,
            title: p.title,
            body: p.body,
            anonymous: p.anonymous,
            image: p.image,
            client_request_id: p.request,
            user_id: p.user,
            now: now(),
        },
    )
}

fn topic(store: &Store, course_id: &str, slug: &str, title: &str, pinned: bool, position: i32) {
    discussion::save_topic(
        &Db(store),
        &SaveTopic {
            course_id,
            slug,
            title,
            pinned,
            position,
            reason: "TEST",
            operator_id: STAFF,
            now: now(),
        },
    )
    .unwrap();
}

fn reply(
    store: &Store,
    post_id: &str,
    body: &str,
    request: &str,
    user: &str,
    when: Instant,
) -> Result<Json, svc_academy::errors::Refusal> {
    discussion::reply(
        &Db(store),
        LIMITS,
        post_id,
        body,
        false,
        request,
        user,
        when,
    )
}

fn accepted(thread: &Json) -> Vec<(String, bool)> {
    arr(thread, "replies")
        .iter()
        .map(|r| (s(r, "id"), b(r, "accepted")))
        .collect()
}

#[test]
fn lists_general_with_pinned_topics_first_whatever_their_position_and_an_empty_general() {
    let Some((db, store)) = setup() else { return };
    let c = course(&db);
    topic(&store, &c, "week-one", "Week one", false, 1);
    topic(&store, &c, "read-first", "Read first", true, 9);
    let slugs = || -> Vec<String> {
        let t = discussion::topics(&Db(&store), ME, "risk-basics").unwrap();
        arr(&t, "topics").iter().map(|t| s(t, "slug")).collect()
    };
    assert_eq!(slugs(), ["read-first", "general", "week-one"]);
    topic(&store, &c, "week-one", "Week one", false, 0);
    assert_eq!(slugs()[0], "read-first");
    assert_eq!(
        discussion::posts(&Db(&store), ME, "risk-basics", "general", 50).unwrap(),
        Json::Array(vec![])
    );
    assert_eq!(count(&db, "discussion_topic_events"), "3");
    assert_eq!(
        code(discussion::posts(
            &Db(&store),
            ME,
            "risk-basics",
            "nowhere",
            5
        )),
        "academy.topic_not_found"
    );
}

#[test]
fn refuses_a_learner_who_is_not_enrolled_and_a_course_that_is_not_published() {
    let Some((db, store)) = setup() else { return };
    course(&db);
    assert_eq!(
        code(discussion::topics(&Db(&store), STRANGER, "risk-basics")),
        "academy.enrolment_required"
    );
    assert_eq!(
        code(post(
            &store,
            LIMITS,
            &Post {
                user: STRANGER,
                ..Post::default()
            }
        )),
        "academy.enrolment_required"
    );
    assert_eq!(
        code(discussion::topics(&Db(&store), ME, "no-such-course")),
        "academy.course_not_found"
    );
    let mine = discussion::courses(&Db(&store), ME, 10).unwrap();
    assert_eq!(items(&mine).len(), 1);
    assert_eq!(s(&items(&mine)[0], "slug"), "risk-basics");
    assert_eq!(
        discussion::courses(&Db(&store), STRANGER, 10).unwrap(),
        Json::Array(vec![])
    );
}

#[test]
fn makes_one_post_of_a_retry_and_refuses_blank_or_exceeded_owner_values_and_a_non_image_file_by_name()
 {
    let Some((db, store)) = setup() else { return };
    course(&db);
    let first = post(&store, LIMITS, &Post::default()).unwrap();
    assert_eq!(post(&store, LIMITS, &Post::default()).unwrap(), first);
    // Two sends of one request at once both answer.
    let both: Vec<_> = std::thread::scope(|sc| {
        let hs: Vec<_> = (0..2)
            .map(|_| {
                sc.spawn(|| {
                    post(
                        &store,
                        LIMITS,
                        &Post {
                            request: "post:2",
                            ..Post::default()
                        },
                    )
                })
            })
            .collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert_eq!(both.len(), 2);
    assert!(both.iter().all(Result::is_ok), "{both:?}");
    assert_eq!(count(&db, "discussion_posts"), "2");

    let p3 = |over: Post<'static>| Post {
        request: "post:3",
        ..over
    };
    let unset_chars = Limits {
        post_max_chars: None,
        ..LIMITS
    };
    assert_eq!(
        code(post(&store, unset_chars, &p3(Post::default()))),
        "academy.post_limit_unset"
    );
    let long = "x".repeat(101);
    assert_eq!(
        code(post(
            &store,
            LIMITS,
            &Post {
                request: "post:3",
                body: &long,
                ..Post::default()
            }
        )),
        "academy.post_too_long"
    );
    assert_eq!(
        code(post(
            &store,
            LIMITS,
            &p3(Post {
                image: Some(("application/pdf", PDF)),
                ..Post::default()
            })
        )),
        "academy.attachment_type_refused"
    );
    // Declared as an image, but its bytes are not one.
    assert_eq!(
        code(post(
            &store,
            LIMITS,
            &p3(Post {
                image: Some(("image/png", PDF)),
                ..Post::default()
            })
        )),
        "academy.attachment_type_refused"
    );
    assert_eq!(
        code(post(
            &store,
            LIMITS,
            &p3(Post {
                image: Some(("image/svg+xml", SVG)),
                ..Post::default()
            })
        )),
        "academy.attachment_type_refused"
    );
    let png = || {
        p3(Post {
            image: Some(("image/png", PNG)),
            ..Post::default()
        })
    };
    let unset_bytes = Limits {
        image_max_bytes: None,
        ..LIMITS
    };
    assert_eq!(
        code(post(&store, unset_bytes, &png())),
        "academy.attachment_limit_unset"
    );
    let tiny = Limits {
        image_max_bytes: Some(10),
        ..LIMITS
    };
    assert_eq!(
        code(post(&store, tiny, &png())),
        "academy.attachment_too_large"
    );
    assert_eq!(count(&db, "discussion_posts"), "2");
    let with_image = post(&store, LIMITS, &png()).unwrap();
    assert!(b(&with_image, "hasImage"));
    assert_eq!(
        discussion::image(&Db(&store), PEER, &s(&with_image, "id")).unwrap(),
        Json::obj([
            ("contentType", Json::str("image/png")),
            ("base64", Json::str(PNG))
        ])
    );
    assert_eq!(
        discussion::image(&Db(&store), PEER, &s(&first, "id")).unwrap(),
        Json::Null
    );
    // A request id answers only the same send: an edited draft under it, or a reply under a post's id, is refused.
    assert_eq!(
        code(post(
            &store,
            LIMITS,
            &Post {
                body: "TEST edited",
                ..Post::default()
            }
        )),
        "academy.request_reused"
    );
    assert_eq!(
        code(reply(
            &store,
            &s(&first, "id"),
            "TEST How big should one trade be?",
            "post:1",
            ME,
            now()
        )),
        "academy.request_reused"
    );
}

#[test]
fn puts_the_accepted_answer_first_moves_it_on_a_second_accept_and_lets_only_the_asker_accept() {
    let Some((db, store)) = setup() else { return };
    course(&db);
    let q = s(&post(&store, LIMITS, &Post::default()).unwrap(), "id");
    let a = s(
        &reply(&store, &q, "TEST One percent.", "r:1", PEER, now()).unwrap(),
        "id",
    );
    let later = Instant(now().0 + 1000);
    let bb = s(
        &reply(&store, &q, "TEST A fixed amount.", "r:2", PEER, later).unwrap(),
        "id",
    );
    // A retried reply is the same reply.
    assert_eq!(
        s(
            &reply(&store, &q, "TEST A fixed amount.", "r:2", PEER, now()).unwrap(),
            "id"
        ),
        bb
    );
    assert_eq!(
        code(discussion::accept(&Db(&store), PEER, &q, &a)),
        "academy.permission_denied"
    );
    assert_eq!(
        code(reply(&store, &a, "TEST nested", "r:3", ME, now())),
        "academy.post_not_found"
    );
    discussion::accept(&Db(&store), ME, &q, &bb).unwrap();
    let thread = discussion::thread(&Db(&store), ME, &q, 50).unwrap();
    assert_eq!(accepted(&thread), [(bb.clone(), true), (a.clone(), false)]);
    discussion::accept(&Db(&store), ME, &q, &a).unwrap();
    let thread = discussion::thread(&Db(&store), ME, &q, 50).unwrap();
    assert_eq!(accepted(&thread), [(a, true), (bb, false)]);
    assert!(b(&thread, "canAccept"));
    assert!(!b(
        &discussion::thread(&Db(&store), PEER, &q, 50).unwrap(),
        "canAccept"
    ));
}

#[test]
fn sets_follow_and_like_once_and_takes_them_back() {
    let Some((db, store)) = setup() else { return };
    course(&db);
    let q = s(&post(&store, LIMITS, &Post::default()).unwrap(), "id");
    let d = Db(&store);
    discussion::follow(&d, ME, &q, true, now()).unwrap();
    discussion::follow(&d, ME, &q, true, now()).unwrap();
    assert_eq!(
        n(
            &discussion::like(&d, PEER, &q, true, now()).unwrap(),
            "likes"
        ),
        1
    );
    assert_eq!(
        n(
            &discussion::like(&d, PEER, &q, true, now()).unwrap(),
            "likes"
        ),
        1
    );
    let view = discussion::thread(&d, ME, &q, 50).unwrap();
    let p = community_support::get(&view, "post");
    assert_eq!(
        (b(p, "following"), n(p, "likes"), b(p, "liked")),
        (true, 1, false)
    );
    discussion::follow(&d, ME, &q, false, now()).unwrap();
    assert_eq!(
        n(
            &discussion::like(&d, PEER, &q, false, now()).unwrap(),
            "likes"
        ),
        0
    );
    let view = discussion::thread(&d, ME, &q, 50).unwrap();
    let p = community_support::get(&view, "post");
    assert_eq!((b(p, "following"), n(p, "likes")), (false, 0));
}

#[test]
fn shows_classmates_no_name_or_account_for_an_anonymous_post_and_staff_the_account() {
    let Some((db, store)) = setup() else { return };
    let c = course(&db);
    let named = post(&store, LIMITS, &Post::default()).unwrap();
    let anon = post(
        &store,
        LIMITS,
        &Post {
            request: "post:anon",
            kind: "discussion",
            title: "TEST unsigned",
            anonymous: true,
            ..Post::default()
        },
    )
    .unwrap();
    let seen = discussion::posts(&Db(&store), PEER, "risk-basics", "general", 50).unwrap();
    let find = |id: &str| {
        items(&seen)
            .iter()
            .find(|p| s(p, "id") == id)
            .unwrap()
            .clone()
    };
    assert_eq!(
        *community_support::get(&find(&s(&anon, "id")), "author"),
        Json::obj([("kind", Json::str("anonymous"))])
    );
    assert!(!seen.compact().contains(ME));
    assert_eq!(
        *community_support::get(&find(&s(&named, "id")), "author"),
        Json::obj([
            ("kind", Json::str("learner")),
            ("label", Json::str(classmate_label(&c, ME)))
        ])
    );
    assert_eq!(
        *community_support::get(&anon, "author"),
        Json::obj([("kind", Json::str("you")), ("anonymous", Json::Bool(true))])
    );
    let staff = discussion::staff_thread(&Db(&store), &s(&anon, "id"), 50).unwrap();
    let p = community_support::get(&staff, "post");
    assert_eq!(s(p, "authorId"), ME);
    assert!(b(p, "anonymous"));
}

// ── The moderation outbox at each crash point ─────────────────────────────

const STAFF_MOD: Moderator<'static> = Moderator {
    user_id: STAFF,
    may_write: true,
};

/// Where the outbox tells a failure: each line `<event id>: <why>`.
fn push(log: &Mutex<Vec<String>>, e: &str, id: &str) {
    log.lock().unwrap().push(format!("{id}: {e}"));
}

fn waiting(db: &TestDb) -> String {
    count(db, "moderation_events WHERE notified_at IS NULL")
}

#[test]
fn a_publish_whose_notified_at_write_fails_is_sent_again_under_the_same_business_key() {
    let Some((db, store)) = setup() else { return };
    course(&db);
    let q = s(&post(&store, LIMITS, &Post::default()).unwrap(), "id");
    // The crash point: the bus took the notice, then the `notified_at` write fails.
    community_support::exec(
        &db,
        "CREATE FUNCTION academy.refuse_notified() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST notified_at write fails'; END $$;
         CREATE TRIGGER refuse_notified BEFORE UPDATE OF notified_at ON academy.moderation_events FOR EACH ROW EXECUTE FUNCTION academy.refuse_notified();",
    );
    let bus = FakeBus::default();
    let log = Mutex::new(Vec::new());
    let tell = |e: &str, id: &str| push(&log, e, id);
    let outbox = Outbox {
        bus: &bus,
        producer: "svc-academy",
        log: &tell,
    };
    let deleted =
        moderation::delete_post(&Db(&store), &outbox, &q, "TEST spam", STAFF_MOD, now()).unwrap();
    let event_id = s(community_support::get(&deleted, "event"), "id");
    let sent = bus.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, SUBJECT);
    assert_eq!(sent[0].1, format!("academy.moderation:{event_id}"));
    assert_eq!(
        waiting(&db),
        "1",
        "the notice still waits: its write failed"
    );
    assert_eq!(log.lock().unwrap().len(), 1);
    assert!(log.lock().unwrap()[0].starts_with(&event_id));

    // The next drain sends it again under the same key, and the write lands.
    community_support::exec(
        &db,
        "DROP TRIGGER refuse_notified ON academy.moderation_events",
    );
    assert_eq!(moderation::send_waiting(&Db(&store), &outbox).unwrap(), 1);
    let sent = bus.sent();
    assert_eq!(sent.len(), 2);
    assert_eq!(
        sent[1].1, sent[0].1,
        "the bus deduplicates on the business key"
    );
    let p = |i: usize| community_support::get(&sent[i].2, "payload").clone();
    assert_eq!(p(0), p(1));
    assert_ne!(
        s(&sent[0].2, "id"),
        s(&sent[1].2, "id"),
        "each envelope has its own id"
    );
    assert_eq!(waiting(&db), "0");
    assert_eq!(moderation::send_waiting(&Db(&store), &outbox).unwrap(), 0);
    assert_eq!(bus.sent().len(), 2);
}

#[test]
fn a_failed_publish_leaves_the_notice_waiting_the_delete_stands_and_a_later_drain_sends_it_once() {
    let Some((db, store)) = setup() else { return };
    course(&db);
    let q = s(&post(&store, LIMITS, &Post::default()).unwrap(), "id");
    let bus = FakeBus::default();
    bus.set_fail(true);
    let log = Mutex::new(Vec::new());
    let tell = |e: &str, id: &str| push(&log, e, id);
    let outbox = Outbox {
        bus: &bus,
        producer: "svc-academy",
        log: &tell,
    };
    let deleted =
        moderation::delete_post(&Db(&store), &outbox, &q, "TEST spam", STAFF_MOD, now()).unwrap();
    let event_id = s(community_support::get(&deleted, "event"), "id");
    assert!(bus.sent().is_empty());
    assert_eq!(log.lock().unwrap().len(), 1);
    assert_eq!(waiting(&db), "1");
    assert_eq!(
        one(
            &db,
            &format!(
                "SELECT (removed_at IS NOT NULL)::text FROM academy.discussion_posts WHERE id = '{q}'"
            )
        ),
        "true"
    );
    // A repeat answers with the first event, and still sends nothing while the bus is down.
    let again =
        moderation::delete_post(&Db(&store), &outbox, &q, "TEST spam", STAFF_MOD, now()).unwrap();
    assert_eq!(again, deleted);
    assert_eq!(count(&db, "moderation_events"), "1");

    bus.set_fail(false);
    assert_eq!(moderation::send_waiting(&Db(&store), &outbox).unwrap(), 1);
    assert_eq!(moderation::send_waiting(&Db(&store), &outbox).unwrap(), 0);
    let sent = bus.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].1, format!("academy.moderation:{event_id}"));
    let payload = community_support::get(&sent[0].2, "payload");
    assert_eq!(s(payload, "eventId"), event_id);
    assert_eq!(s(payload, "authorId"), ME);
    assert_eq!(s(payload, "courseTitle"), "TEST risk-basics");
    assert_eq!(n(payload, "posts"), 1);
    assert_eq!(s(payload, "reason"), "TEST spam");
    assert_eq!(waiting(&db), "0");
}

// ── Through the door ─────────────────────────────────────────────────────

#[test]
fn the_door_posts_with_the_owner_limits_and_refuses_by_name_while_they_are_blank() {
    let Some((db, store)) = setup() else { return };
    course(&db);
    let input = Json::obj([
        ("courseSlug", Json::str("risk-basics")),
        ("topicSlug", Json::str("general")),
        ("kind", Json::str("question")),
        ("title", Json::str("TEST How big?")),
        ("body", Json::str("TEST How big should one trade be?")),
        ("anonymous", Json::Bool(false)),
        ("image", Json::Null),
        ("clientRequestId", Json::str("post:door")),
    ]);
    let write = ["academy:read", "academy:write"];
    let blank = door(Store::Pool(db.pool()), Json::Object(vec![]));
    let (status, msg, cause) = refused(&mutate(&blank, ME, &write, "createDiscussionPost", &input));
    assert_eq!(cause, "academy.post_limit_unset", "{status} {msg}");
    assert_eq!(count(&db, "discussion_posts"), "0");

    let set = door(
        store,
        Json::obj([
            ("ACADEMY_POST_MAX_CHARS", Json::int(100)),
            ("ACADEMY_POST_IMAGE_MAX_BYTES", Json::int(1024)),
        ]),
    );
    let made = community_support::data(&mutate(&set, ME, &write, "createDiscussionPost", &input));
    assert_eq!(s(&made, "title"), "TEST How big?");
    let listed = community_support::data(&query(
        &set,
        PEER,
        &["academy:read"],
        "discussionPosts",
        Some(&Json::obj([
            ("courseSlug", Json::str("risk-basics")),
            ("topicSlug", Json::str("general")),
            ("limit", Json::int(50)),
        ])),
    ));
    assert_eq!(items(&listed).len(), 1);
    assert_eq!(s(&items(&listed)[0], "id"), s(&made, "id"));
    // A stranger reads nothing.
    let (_, _, cause) = refused(&query(
        &set,
        STRANGER,
        &["academy:read"],
        "discussionTopics",
        Some(&Json::obj([("courseSlug", Json::str("risk-basics"))])),
    ));
    assert_eq!(cause, "academy.enrolment_required");
}
