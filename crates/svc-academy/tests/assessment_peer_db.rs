//! Review steps, rubrics, and peer and self review, against a real Postgres: the port of
//! `curriculum/peer-review.db.test.ts` (AC-assignments-03), assertion for assertion. The course, its outline and the
//! enrolments are another slice's calls; they are written here as the rows those calls leave. Publishing a course is
//! the authoring slice's call; the check it makes on review steps (`assertPeerCountsSet`) is this slice's and is called
//! here as publishing calls it.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::support;

use service_kit::json::Json;
use support::{MemoryObjects, TestDb, at, base64, code_of, enrol, jp, seed_course, test_storage};
use svc_academy::assessment::assignments::{self, BriefInput, Files};
use svc_academy::assessment::peer::{self, StepsInput, rubric_total};
use svc_academy::db::Store;
use svc_academy::errors::Refusal;

const A: &str = "33333333-3333-4333-8333-333333333333";
const L: &str = "55555555-5555-4555-8555-555555555555";
const M: &str = "77777777-7777-4777-8777-777777777777";
const N: &str = "88888888-8888-4888-8888-888888888888";
const X: &str = "99999999-9999-4999-8999-999999999999";
const OUTSIDER: &str = "66666666-6666-4666-8666-666666666666";
const NOW_ISO: &str = "2026-10-23T12:00:00.000Z";
const PDF: &[u8] = b"%PDF-1.4\nTEST\n%%EOF\n";
const CRITERIA: &str =
    r#"[{"name":"Sizing","levels":["0","1","2"]},{"name":"Working shown","levels":["0","0.5"]}]"#;

fn now() -> i64 {
    service_kit::time::js_date(NOW_ISO).unwrap().0
}

fn later(minutes: i64) -> i64 {
    now() + minutes * 60_000
}

fn s(v: &str) -> Json {
    Json::str(v)
}

fn text(j: &Json) -> String {
    match j {
        Json::String(s) => s.clone(),
        other => panic!("not a string: {other:?}"),
    }
}

fn list(j: &Json) -> Vec<Json> {
    match j {
        Json::Array(items) => items.clone(),
        other => panic!("not an array: {other:?}"),
    }
}

fn marks(m: &[&str]) -> Vec<String> {
    m.iter().map(|x| (*x).to_owned()).collect()
}

struct Open {
    db: TestDb,
    store: Store,
    objects: MemoryObjects,
    course: String,
    item: String,
}

#[derive(Clone, Copy)]
struct Steps {
    revision: i64,
    peer: bool,
    peer_count: Option<i64>,
    self_review: bool,
}

const STEPS: Steps = Steps {
    revision: 0,
    peer: true,
    peer_count: Some(2),
    self_review: true,
};

impl Open {
    fn files(&self) -> Files<'_> {
        Files {
            storage: Some(test_storage()),
            max_bytes: Some(1024),
            types: Some(vec!["application/pdf".to_owned()]),
            bytes: &self.objects,
        }
    }

    fn steps_with(&self, over: Steps, criteria: &[Json]) -> Result<(), Refusal> {
        peer::save(
            &self.store,
            &StepsInput {
                item_id: &self.item,
                revision: over.revision,
                peer: over.peer,
                peer_count: over.peer_count,
                self_review: over.self_review,
                criteria,
            },
            A,
            now(),
        )
    }

    fn steps(&self, over: Steps) -> Result<(), Refusal> {
        self.steps_with(over, &list(&jp(CRITERIA)))
    }

    fn hand_in(&self, user: &str, body: &str, minutes: i64) {
        assignments::submit(
            &self.store,
            &self.files(),
            &self.item,
            1,
            Some(body),
            None,
            user,
            later(minutes),
        )
        .unwrap();
    }

    fn state(&self, user: &str) -> Result<Json, Refusal> {
        peer::state(&self.store, &self.item, user, now())
    }

    fn task(&self, user: &str) -> Json {
        at(&self.state(user).unwrap(), "task")
    }

    fn submit(&self, task: &Json, m: &[&str], user: &str) -> Result<Json, Refusal> {
        peer::submit(
            &self.store,
            &self.item,
            &text(&at(task, "id")),
            &marks(m),
            user,
            now(),
        )
    }

    fn review(&self) -> Json {
        at(
            &assignments::admin_view(&self.store, &self.item).unwrap(),
            "review",
        )
    }
}

/// A free course with one text-only assignment, its brief saved; published with L, M, N and X enrolled unless asked.
fn open_assignment(publish: bool, file: &str) -> Option<Open> {
    let db = TestDb::migrated()?;
    let mut c = db.client();
    let seeded = seed_course(
        &mut c,
        "risk-basics",
        "draft",
        A,
        NOW_ISO,
        &[("assignment", "Write-up")],
    );
    let store = Store::Pool(db.pool());
    let item = seeded.items[0].clone();
    let brief = BriefInput {
        instructions: "Size one trade.",
        points: "10",
        due_at: None,
        text: "required",
        file,
    };
    assignments::save(&store, &item, 0, &brief, A, now()).unwrap();
    let open = Open {
        db,
        store,
        objects: MemoryObjects::new(),
        course: seeded.id,
        item,
    };
    if publish {
        open.publish().unwrap();
    }
    Some(open)
}

impl Open {
    /// The authoring slice's `setState(published)`: its review-step check first, then the course is published and the
    /// learners enrol.
    fn publish(&self) -> Result<(), Refusal> {
        let mut c = self.db.client();
        peer::assert_peer_counts_set(&mut c, &self.course)?;
        c.execute(
            "UPDATE academy.courses SET state = 'published' WHERE id = $1::text::uuid",
            &[&self.course],
        )
        .unwrap();
        for user in [L, M, N, X] {
            enrol(&mut c, &self.course, user, NOW_ISO);
        }
        Ok(())
    }
}

macro_rules! need {
    ($e:expr) => {
        match $e {
            Some(f) => f,
            None => {
                eprintln!("skipped: no TEST_DATABASE_URL");
                return;
            }
        }
    };
}

// ── review steps on the founder console ─────────────────────────────────────────────────────────────────────────────

#[test]
fn steps_save_over_the_revision_read_keep_an_unchanged_rubric_and_write_a_new_one_for_other_criteria()
 {
    let o = need!(open_assignment(true, "off"));
    o.steps(STEPS).unwrap();
    let first = o.review();
    for (k, v) in [
        ("revision", Json::int(1)),
        ("peer", Json::Bool(true)),
        ("peerCount", Json::int(2)),
        ("self", Json::Bool(true)),
        ("rubric.criteria", jp(CRITERIA)),
    ] {
        assert_eq!(at(&first, k), v, "{k}");
    }
    assert_eq!(code_of(o.steps(STEPS)), "academy.revision_stale");
    o.steps(Steps {
        revision: 1,
        peer_count: Some(3),
        ..STEPS
    })
    .unwrap();
    assert_eq!(at(&o.review(), "rubric.id"), at(&first, "rubric.id"));
    let one = list(&jp(CRITERIA)).into_iter().take(1).collect::<Vec<_>>();
    o.steps_with(
        Steps {
            revision: 2,
            peer_count: Some(3),
            self_review: false,
            ..STEPS
        },
        &one,
    )
    .unwrap();
    assert_ne!(at(&o.review(), "rubric.id"), at(&first, "rubric.id"));
    // The first rubric stays as it was, for the reviews scored against it.
    let kept: String =
        o.db.client()
            .query_one(
                "SELECT criteria::text FROM academy.assignment_rubrics WHERE id = $1::text::uuid",
                &[&text(&at(&first, "rubric.id"))],
            )
            .unwrap()
            .get(0);
    assert_eq!(jp(&kept), jp(CRITERIA));
}

#[test]
fn a_published_course_refuses_peer_review_with_no_count_and_a_draft_takes_it_then_is_not_published()
{
    let published = need!(open_assignment(true, "off"));
    assert_eq!(
        code_of(published.steps(Steps {
            peer_count: None,
            ..STEPS
        })),
        "academy.peer_count_unset"
    );
    let draft = need!(open_assignment(false, "off"));
    draft
        .steps(Steps {
            peer_count: None,
            ..STEPS
        })
        .unwrap();
    assert_eq!(code_of(draft.publish()), "academy.peer_count_unset");
}

#[test]
fn a_step_with_no_rubric_or_two_criteria_of_one_name_refuses() {
    let o = need!(open_assignment(true, "off"));
    assert_eq!(
        code_of(o.steps_with(
            Steps {
                peer_count: Some(1),
                self_review: false,
                ..STEPS
            },
            &[]
        )),
        "academy.rubric_invalid"
    );
    let twice = list(&jp(
        r#"[{"name":"Sizing","levels":["0","1","2"]},{"name":"sizing","levels":["0","0.5"]}]"#,
    ));
    assert_eq!(
        code_of(o.steps_with(
            Steps {
                peer: false,
                peer_count: None,
                self_review: true,
                ..STEPS
            },
            &twice
        )),
        "academy.rubric_invalid"
    );
}

// ── peer and self review for learners ───────────────────────────────────────────────────────────────────────────────

#[test]
fn two_peers_then_the_self_review_never_my_own_work_and_a_waiting_list_while_too_few_handed_in() {
    let o = need!(open_assignment(true, "off"));
    o.steps(STEPS).unwrap();
    assert_eq!(at(&o.state(L).unwrap(), "stage"), s("hand_in_first"));
    o.hand_in(L, "L sizes by risk.", 0);
    // Nobody else has handed in: L waits and is never handed their own work.
    let waiting = o.state(L).unwrap();
    assert_eq!(
        (
            at(&waiting, "stage"),
            at(&waiting, "task"),
            at(&waiting, "peerDone")
        ),
        (s("waiting"), Json::Null, Json::int(0))
    );
    assert_eq!(
        (
            at(&o.review(), "authorsShortOfReviews"),
            at(&o.review(), "reviewersWaiting")
        ),
        (Json::int(1), Json::int(1))
    );

    o.hand_in(M, "M sizes by a fixed amount.", 1);
    let one = o.state(L).unwrap();
    assert_eq!(at(&one, "stage"), s("peer"));
    for (k, v) in [
        ("kind", s("peer")),
        ("ordinal", Json::int(1)),
        ("text", s("M sizes by a fixed amount.")),
        ("criteria", jp(CRITERIA)),
    ] {
        assert_eq!(at(&one, &format!("task.{k}")), v, "{k}");
    }
    // Reading again hands out nothing new.
    assert_eq!(at(&o.task(L), "id"), at(&one, "task.id"));
    let after_one = o.submit(&at(&one, "task"), &["1", "0.5"], L).unwrap();
    assert_eq!(
        (
            at(&after_one, "stage"),
            at(&after_one, "peerDone"),
            at(&after_one, "task")
        ),
        (s("waiting"), Json::int(1), Json::Null)
    );

    o.hand_in(N, "N sizes from the stop.", 2);
    let two = o.task(L);
    assert_eq!(
        (at(&two, "ordinal"), at(&two, "text")),
        (Json::int(2), s("N sizes from the stop."))
    );
    let after_two = o.submit(&two, &["2", "0"], L).unwrap();
    assert_eq!(
        (at(&after_two, "stage"), at(&after_two, "peerDone")),
        (s("self"), Json::int(2))
    );
    assert_eq!(
        (
            at(&after_two, "task.kind"),
            at(&after_two, "task.ordinal"),
            at(&after_two, "task.text")
        ),
        (s("self"), Json::Null, s("L sizes by risk."))
    );
    let done = o.submit(&at(&after_two, "task"), &["2", "0.5"], L).unwrap();
    assert_eq!(
        (
            at(&done, "stage"),
            at(&done, "peerDone"),
            at(&done, "selfDone"),
            at(&done, "task")
        ),
        (s("done"), Json::int(2), Json::Bool(true), Json::Null)
    );

    let totals = o.db.texts(&format!("SELECT total::text FROM academy.assignment_reviews WHERE reviewer_id = '{L}' ORDER BY reviewed_at, id"));
    let totals: Vec<String> = totals
        .iter()
        .map(|t| rubric_total(std::slice::from_ref(t)))
        .collect();
    for want in ["1.5", "2", "2.5"] {
        assert!(totals.iter().any(|t| t == want), "{want} in {totals:?}");
    }
    let own = o.db.texts(&format!(
        "SELECT '1' FROM academy.assignment_reviews WHERE reviewer_id = '{L}' AND author_id = '{L}' AND marks IS NOT NULL"
    ));
    assert_eq!(own.len(), 1);
}

#[test]
fn the_least_reviewed_work_goes_out_first_then_the_earliest_hand_in() {
    let o = need!(open_assignment(true, "off"));
    o.steps(Steps {
        peer_count: Some(1),
        self_review: false,
        ..STEPS
    })
    .unwrap();
    o.hand_in(M, "M", 1);
    o.hand_in(N, "N", 2);
    o.hand_in(X, "X", 3);
    // X reviews first and gets M, the earliest; L then gets N, which nobody reviews yet.
    assert_eq!(at(&o.task(X), "text"), s("M"));
    o.hand_in(L, "L", 4);
    assert_eq!(at(&o.task(L), "text"), s("N"));
}

#[test]
fn two_learners_asking_at_once_are_handed_different_work() {
    let o = need!(open_assignment(true, "off"));
    o.steps(Steps {
        peer_count: Some(1),
        self_review: false,
        ..STEPS
    })
    .unwrap();
    for (n, who) in [M, N, L, X].iter().enumerate() {
        let n = i64::try_from(n).unwrap();
        o.hand_in(who, &format!("work {n}"), n);
    }
    let (l, x) = std::thread::scope(|scope| {
        let l = scope.spawn(|| o.task(L));
        let x = scope.spawn(|| o.task(X));
        (l.join().unwrap(), x.join().unwrap())
    });
    assert_ne!(at(&l, "text"), at(&x, "text"));
    let mut texts = vec![text(&at(&l, "text")), text(&at(&x, "text"))];
    texts.sort();
    assert_eq!(texts, ["work 0", "work 1"]);
}

#[test]
fn the_same_marks_again_answer_as_stored_and_other_marks_a_bad_level_or_a_strangers_task_refuse() {
    let o = need!(open_assignment(true, "off"));
    o.steps(Steps {
        peer_count: Some(1),
        self_review: false,
        ..STEPS
    })
    .unwrap();
    o.hand_in(L, "L", 0);
    o.hand_in(M, "M", 1);
    let task = o.task(L);
    assert_eq!(
        code_of(o.submit(&task, &["3", "0"], L)),
        "academy.review_marks_invalid"
    );
    assert_eq!(
        code_of(o.submit(&task, &["1"], L)),
        "academy.review_marks_invalid"
    );
    assert_eq!(
        code_of(o.submit(&task, &["1", "0"], M)),
        "academy.review_task_not_found"
    );
    let first = o.submit(&task, &["1", "0"], L).unwrap();
    let again = o.submit(&task, &["1", "0"], L).unwrap();
    assert_eq!(again, first);
    assert_eq!(
        code_of(o.submit(&task, &["2", "0"], L)),
        "academy.review_already_sent"
    );
}

#[test]
fn a_learner_who_is_not_enrolled_is_refused_and_an_assignment_with_no_steps_is_off() {
    let o = need!(open_assignment(true, "off"));
    assert_eq!(code_of(o.state(OUTSIDER)), "academy.enrolment_required");
    assert_eq!(at(&o.state(L).unwrap(), "stage"), s("off"));
}

#[test]
fn a_classmates_file_is_read_back_under_no_name_and_a_non_reviewer_or_a_bad_store_read_refuse() {
    let o = need!(open_assignment(true, "optional"));
    o.steps(Steps {
        peer_count: Some(1),
        self_review: false,
        ..STEPS
    })
    .unwrap();
    o.hand_in(L, "L", 0);
    let stored = assignments::upload_file(
        &o.store,
        &o.files(),
        &o.item,
        "Jane_Doe_sizing.pdf",
        "application/pdf",
        &base64(PDF),
        M,
        now(),
    )
    .unwrap();
    let file_id = text(&at(&stored, "id"));
    assignments::submit(
        &o.store,
        &o.files(),
        &o.item,
        1,
        Some("M"),
        Some(&file_id),
        M,
        later(1),
    )
    .unwrap();
    let task = o.task(L);
    // The reviewer sees that a file is there, never its name.
    assert_eq!(
        at(&task, "file"),
        jp(&format!(
            r#"{{"fileName":null,"contentType":"application/pdf","bytes":{}}}"#,
            PDF.len()
        ))
    );
    let task_id = text(&at(&task, "id"));
    let config = test_storage();
    let read = |user: &str| {
        peer::file(
            &o.store,
            Some(&config),
            &o.objects,
            &o.item,
            &task_id,
            user,
            now(),
        )
    };
    let got = read(L).unwrap();
    assert_eq!(text(&at(&got, "contentBase64")), base64(PDF));
    assert_eq!(code_of(read(N)), "academy.review_task_not_found");
    o.objects.clear();
    assert_eq!(code_of(read(L)), "academy.file_unavailable");
}

#[test]
fn the_waiting_list_counts_only_learners_with_no_work_free_and_a_withdrawn_assignment_keeps_its_steps()
 {
    let o = need!(open_assignment(true, "off"));
    o.steps(Steps {
        peer_count: Some(1),
        self_review: false,
        ..STEPS
    })
    .unwrap();
    o.hand_in(L, "L", 0);
    o.hand_in(M, "M", 1);
    // Each could be handed the other's work at once: nobody waits, though nobody opened the page.
    assert_eq!(
        (
            at(&o.review(), "authorsShortOfReviews"),
            at(&o.review(), "reviewersWaiting")
        ),
        (Json::int(2), Json::int(0))
    );
    o.submit(&o.task(L), &["1", "0"], L).unwrap();
    assert_eq!(
        (
            at(&o.review(), "authorsShortOfReviews"),
            at(&o.review(), "reviewersWaiting")
        ),
        (Json::int(1), Json::int(0))
    );
    assignments::withdraw(&o.store, &o.item, "TEST", A, now()).unwrap();
    assert_eq!(
        code_of(o.steps(Steps {
            revision: 1,
            peer_count: Some(1),
            self_review: false,
            ..STEPS
        })),
        "academy.assignment_closed"
    );
}

#[test]
fn rubric_levels_sum_as_decimals() {
    assert_eq!(rubric_total(&marks(&["0.5", "0.25", "1"])), "1.75");
    assert_eq!(rubric_total(&marks(&["0", "0"])), "0");
    assert_eq!(rubric_total(&marks(&["999999.99", "0.01"])), "1000000");
}
