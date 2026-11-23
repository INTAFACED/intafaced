//! `curriculum/course-messages.db.test.ts` (AC-rooms-04) against Postgres: an enrolled learner's message lands in their
//! inbox and the staff inbox, unread on the staff side; a staff reply turns the learner's marker on until they open it; a
//! stranger and a blank owner length refuse by name; a retry is one message; a learner never opens another learner's
//! conversation.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::community_support;
use crate::support;

use community_support::{arr, at, b, code, get, items, one, s, setup};
use service_kit::json::Json;
use service_kit::time::Instant;
use support::TestDb;
use svc_academy::community::Db;
use svc_academy::community::messages;
use svc_academy::db::Store;
use svc_academy::errors::Refusal;

const STAFF: &str = "33333333-3333-4333-8333-333333333333";
const ME: &str = "55555555-5555-4555-8555-555555555555";
const PEER: &str = "66666666-6666-4666-8666-666666666666";
const STRANGER: &str = "77777777-7777-4777-8777-777777777777";
const NOW: &str = "2026-10-24T19:00:00.000Z";
const LATER: &str = "2026-10-24T19:05:00.000Z";
const LATEST: &str = "2026-10-24T19:10:00.000Z";

/// A published free course, and enrolments for ME and PEER.
fn course(db: &TestDb) -> String {
    let id = community_support::course(db, "risk-basics", "published", STAFF, NOW);
    for user in [ME, PEER] {
        community_support::enrol(db, &id, user, NOW);
    }
    id
}

fn count(db: &TestDb, table: &str) -> String {
    one(db, &format!("SELECT count(*)::text FROM academy.{table}"))
}

/// `send(messages(max), over)`.
struct Send<'a> {
    max: Option<i64>,
    course: &'a str,
    body: &'a str,
    request: &'a str,
    user: &'a str,
    now: &'a str,
}

impl Default for Send<'_> {
    fn default() -> Self {
        Send {
            max: Some(100),
            course: "risk-basics",
            body: "TEST Is there a live session?",
            request: "msg:1",
            user: ME,
            now: NOW,
        }
    }
}

fn send(store: &Store, m: &Send<'_>) -> Result<Json, Refusal> {
    messages::send(
        &Db(store),
        m.max,
        m.user,
        m.course,
        m.body,
        m.request,
        at(m.now),
    )
}

fn staff_reply(
    store: &Store,
    conversation: &str,
    body: &str,
    request: &str,
    operator: &str,
    now: Instant,
) -> Result<Json, Refusal> {
    messages::staff_reply(
        &Db(store),
        Some(100),
        operator,
        conversation,
        body,
        request,
        now,
    )
}

fn inbox_first(store: &Store, user: &str) -> Json {
    items(&messages::inbox(&Db(store), user, 10).unwrap())[0].clone()
}

#[test]
fn stores_the_message_in_both_inboxes_unread_for_staff_and_names_vendor_email_for_the_mail_copy() {
    let Some((db, store)) = setup() else { return };
    let c = course(&db);
    let sent = send(&store, &Send::default()).unwrap();
    assert_eq!(
        *get(&sent, "mailCopy"),
        Json::obj([
            ("state", Json::str("not_connected")),
            ("code", Json::str("vendor.email"))
        ])
    );
    assert_eq!(send(&store, &Send::default()).unwrap(), sent);
    assert_eq!(
        code(send(
            &store,
            &Send {
                body: "TEST edited",
                ..Send::default()
            }
        )),
        "academy.request_reused"
    );
    let conversation = s(&sent, "conversationId");
    let mine = messages::inbox(&Db(&store), ME, 10).unwrap();
    assert_eq!(items(&mine).len(), 1);
    assert_eq!(s(&items(&mine)[0], "id"), conversation);
    assert_eq!(s(&items(&mine)[0], "courseSlug"), "risk-basics");
    assert!(!b(&items(&mine)[0], "unread"));
    let staff = messages::staff_inbox(&Db(&store), 10).unwrap();
    assert_eq!(items(&staff).len(), 1);
    let row = &items(&staff)[0];
    assert_eq!(
        (
            s(row, "id"),
            s(row, "courseId"),
            s(row, "learnerId"),
            b(row, "staffUnread")
        ),
        (conversation.clone(), c, ME.to_owned(), true)
    );
    // A second message is the same conversation.
    let again = send(
        &store,
        &Send {
            request: "msg:2",
            body: "TEST And a recording?",
            now: LATER,
            ..Send::default()
        },
    )
    .unwrap();
    assert_eq!(s(&again, "conversationId"), conversation);
    assert_eq!(count(&db, "course_messages"), "2");
}

#[test]
fn turns_the_learner_marker_on_with_a_staff_reply_and_off_when_they_open_it_staff_opening_clears_theirs()
 {
    let Some((db, store)) = setup() else { return };
    course(&db);
    let conversation = s(&send(&store, &Send::default()).unwrap(), "conversationId");
    let staff_view = messages::staff_open(&Db(&store), &conversation, 50, at(LATER)).unwrap();
    let from: Vec<(String, String)> = arr(&staff_view, "messages")
        .iter()
        .map(|x| (s(x, "from"), s(x, "senderId")))
        .collect();
    assert_eq!(from, [("learner".to_owned(), ME.to_owned())]);
    assert!(!b(
        &items(&messages::staff_inbox(&Db(&store), 10).unwrap())[0],
        "staffUnread"
    ));
    staff_reply(
        &store,
        &conversation,
        "TEST Thursday.",
        "r:1",
        STAFF,
        at(LATER),
    )
    .unwrap();
    assert!(b(&inbox_first(&store, ME), "unread"));
    let opened = messages::open(&Db(&store), ME, &conversation, 50, at(LATEST)).unwrap();
    let said: Vec<(String, String)> = arr(&opened, "messages")
        .iter()
        .map(|x| (s(x, "from"), s(x, "body")))
        .collect();
    assert_eq!(
        said,
        [
            (
                "learner".to_owned(),
                "TEST Is there a live session?".to_owned()
            ),
            ("staff".to_owned(), "TEST Thursday.".to_owned()),
        ]
    );
    assert!(!b(&inbox_first(&store, ME), "unread"));
}

#[test]
fn refuses_a_learner_not_enrolled_a_blank_or_exceeded_length_and_another_learner_opening_the_conversation()
 {
    let Some((db, store)) = setup() else { return };
    course(&db);
    assert_eq!(
        code(send(
            &store,
            &Send {
                user: STRANGER,
                ..Send::default()
            }
        )),
        "academy.enrolment_required"
    );
    assert_eq!(
        code(send(
            &store,
            &Send {
                course: "no-such-course",
                ..Send::default()
            }
        )),
        "academy.course_not_found"
    );
    assert_eq!(
        code(send(
            &store,
            &Send {
                max: None,
                ..Send::default()
            }
        )),
        "academy.message_limit_unset"
    );
    assert_eq!(
        code(send(
            &store,
            &Send {
                max: Some(5),
                ..Send::default()
            }
        )),
        "academy.message_too_long"
    );
    assert_eq!(
        code(messages::staff_reply(
            &Db(&store),
            None,
            STAFF,
            STAFF,
            "x",
            "r",
            at(NOW)
        )),
        "academy.conversation_not_found"
    );
    assert_eq!(count(&db, "course_conversations"), "0");
    let conversation = s(&send(&store, &Send::default()).unwrap(), "conversationId");
    assert_eq!(
        code(messages::open(
            &Db(&store),
            PEER,
            &conversation,
            50,
            at(NOW)
        )),
        "academy.conversation_not_found"
    );
    assert_eq!(
        messages::inbox(&Db(&store), PEER, 10).unwrap(),
        Json::Array(vec![])
    );
}

#[test]
fn keeps_an_unread_reply_unread_when_the_learner_sends_first_answers_a_stored_retry_after_the_course_changed_and_flags_earlier_messages()
 {
    let Some((db, store)) = setup() else { return };
    let c = course(&db);
    let conversation = s(&send(&store, &Send::default()).unwrap(), "conversationId");
    // The staff request id equals the learner's: each side has its own.
    staff_reply(
        &store,
        &conversation,
        "TEST Thursday.",
        "msg:1",
        ME,
        at(LATER),
    )
    .unwrap();
    let more = Send {
        request: "msg:2",
        body: "TEST One more thing.",
        now: LATEST,
        ..Send::default()
    };
    send(&store, &more).unwrap();
    assert!(b(&inbox_first(&store, ME), "unread"));
    community_support::exec(
        &db,
        &format!(
            "UPDATE academy.course_enrolments SET left_at = '{LATEST}' WHERE course_id = '{c}' AND user_id = '{ME}'"
        ),
    );
    assert_eq!(
        s(
            &send(&store, &Send { max: None, ..more }).unwrap(),
            "conversationId"
        ),
        conversation
    );
    let opened = messages::open(&Db(&store), ME, &conversation, 2, at(LATEST)).unwrap();
    assert!(b(&opened, "earlier"));
    let bodies: Vec<String> = arr(&opened, "messages")
        .iter()
        .map(|x| s(x, "body"))
        .collect();
    assert_eq!(bodies, ["TEST Thursday.", "TEST One more thing."]);
    assert!(!b(
        &messages::open(&Db(&store), ME, &conversation, 3, at(LATEST)).unwrap(),
        "earlier"
    ));
}
