//! A completion settles certificates and programmes, through the door, as `academy-service.ts` does: after
//! `markCurriculumComplete`, `staffMarkComplete` (`admin.markCompleteFor`), a watched video (`setVideoProgress`) and an
//! Undo, the learner slice calls the certificate slice's `settleCertificatesNeeding` and the programme slice's
//! `settleProgrammesHolding`, in the TypeScript's order, after the completion's own transaction has committed.
//!
//! What the TypeScript issues on each path (`academy-service.ts`, held by `curriculum/programmes.db.test.ts` and
//! `certs/issue-rules.db.test.ts`):
//! - Complete and staff mark-complete: the certificates needing the item, then the programmes holding its course. With
//!   an `automatic` rule the last required completion grants the certificate once (`cert:<user>:<cert>`) and publishes
//!   its XP; a programme whose every course is complete is granted once (`cert:<user>:programme:<slug>`), no XP.
//! - A watched video: the programmes only. The certificate waits for the learner's next read or the sweep.
//! - Undo: the certificates only. A delayed certificate's wait is dropped at once; a programme certificate stays.
//!
//! Every row and setting here is written through the slices' own calls: the path enrolment (`enrollCertPath`), the
//! issue rule (`admin.setCertIssueRule`), the programme (`admin.saveProgramme`) and the item's video
//! (`admin.setItemVideo`). Figures are TEST values, not owner settings.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

use crate::community_support;
use crate::join_support;

use community_support::{get, s};
use join_support::{Run, USER, advance, setup};
use service_kit::json::Json;
use svc_academy::curriculum::spine;

const CERT: &str = "foundations-v1";
const PROGRAMME: &str = "test-foundations";
const PROGRAMME_CERT: &str = "programme:test-foundations";

/// The steps these tests take through the slices' calls.
trait Steps {
    fn enrol(&self);
    fn rule(&self, mode: &str, delay: Option<i64>);
    fn programme(&self);
    fn complete(&self, slug: &str) -> Json;
    fn grants(&self) -> Vec<(String, String)>;
    fn waits(&self) -> Vec<String>;
    fn standing(&self) -> Json;
}

impl Steps for Run {
    /// `enrollCertPath`: the learner's free enrolment, which opens the path's items.
    fn enrol(&self) {
        self.learner(
            "enrollCertPath",
            &Json::obj([("pathSlug", Json::str("foundations"))]),
        );
    }

    fn rule(&self, mode: &str, delay: Option<i64>) {
        let mut input = vec![
            ("certId".to_owned(), Json::str(CERT)),
            ("mode".to_owned(), Json::str(mode)),
            ("reason".to_owned(), Json::str("TEST rule")),
        ];
        input.push((
            "delayMinutes".to_owned(),
            delay.map_or(Json::Null, Json::int),
        ));
        self.staff("admin.setCertIssueRule", &Json::Object(input));
    }

    /// `admin.saveProgramme`: one programme holding the Foundations course.
    fn programme(&self) {
        self.staff(
            "admin.saveProgramme",
            &Json::obj([
                ("slug", Json::str(PROGRAMME)),
                ("title", Json::str("TEST Foundations path")),
                ("summary", Json::str("TEST")),
                ("courseSlugs", Json::Array(vec![Json::str("foundations")])),
                ("expectedRevision", Json::Null),
                ("reason", Json::str("TEST programme")),
            ]),
        );
    }

    fn complete(&self, slug: &str) -> Json {
        advance(1000);
        self.learner(
            "markCurriculumComplete",
            &Json::obj([("itemSlug", Json::str(slug))]),
        )
    }

    /// The grants the learner holds: certificate and idempotency key.
    fn grants(&self) -> Vec<(String, String)> {
        let mut c = self.db.client();
        c.query(
            "SELECT cert_id, idempotency_key FROM academy.cert_grants WHERE user_id = $1::text::uuid ORDER BY cert_id",
            &[&USER],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect()
    }

    fn waits(&self) -> Vec<String> {
        self.db.texts(&format!(
            "SELECT cert_id FROM academy.cert_issue_pending WHERE user_id = '{USER}'"
        ))
    }

    /// `programme({ slug })` as the learner reads it.
    fn standing(&self) -> Json {
        self.read("programme", &Json::obj([("slug", Json::str(PROGRAMME))]))
    }
}

/// The Foundations items, in the course's order.
fn items() -> Vec<String> {
    spine::list(Some("foundations"), None)
        .iter()
        .map(|i| i.slug.clone())
        .collect()
}

fn both() -> Vec<(String, String)> {
    let mut v = vec![
        (CERT.to_owned(), format!("cert:{USER}:{CERT}")),
        (
            PROGRAMME_CERT.to_owned(),
            format!("cert:{USER}:{PROGRAMME_CERT}"),
        ),
    ];
    v.sort();
    v
}

#[test]
fn the_last_complete_issues_the_certificate_and_the_programme_once_and_a_repeat_issues_nothing() {
    let Some(run) = setup() else { return };
    run.enrol();
    run.rule("automatic", None);
    run.programme();
    let all = items();
    let (last, rest) = all.split_last().unwrap();
    for slug in rest {
        run.complete(slug);
    }
    assert!(
        run.grants().is_empty(),
        "nothing is issued before the last item"
    );
    assert_eq!(
        s(get(&run.standing(), "certificate"), "state"),
        "not_earned"
    );

    run.complete(last);
    assert_eq!(run.grants(), both());
    assert_eq!(run.awards(), [format!("academy.cert:cert:{USER}:{CERT}")]);
    let standing = run.standing();
    assert_eq!(s(get(&standing, "certificate"), "state"), "earned");
    assert_eq!(s(get(&standing, "certificate"), "status"), "valid");
    // The public check names the programme (`certVerify`, the certificate slice, reading the programme's title).
    let public_id = s(get(&standing, "certificate"), "publicId");
    let checked = community_support::data(&community_support::query_from(
        &run.door,
        USER,
        &join_support::LEARNER,
        "certVerify",
        Some(&Json::obj([("publicId", Json::str(public_id))])),
        "203.0.113.7",
    ));
    assert_eq!(s(&checked, "certId"), PROGRAMME_CERT);
    assert_eq!(s(&checked, "title"), "TEST Foundations path");
    assert_eq!(s(&checked, "status"), "valid");

    // Complete again answers the stored completion and settles nothing more.
    run.complete(last);
    assert_eq!(run.grants(), both());
    assert_eq!(run.awards().len(), 1);
}

#[test]
fn staff_marking_the_last_item_complete_issues_both_and_a_repeat_key_issues_nothing() {
    let Some(run) = setup() else { return };
    run.enrol();
    run.rule("automatic", None);
    run.programme();
    let all = items();
    let (last, rest) = all.split_last().unwrap();
    for slug in rest {
        run.complete(slug);
    }
    let mark = |key: &str| {
        advance(1000);
        run.staff(
            "admin.markCompleteFor",
            &Json::obj([
                ("userId", Json::str(USER)),
                ("itemSlug", Json::str(last.as_str())),
                ("reason", Json::str("TEST finished offline")),
                ("key", Json::str(key)),
            ]),
        )
    };
    assert_eq!(s(&mark("k1"), "done"), "marked complete for the learner");
    assert_eq!(run.grants(), both());
    assert_eq!(run.awards(), [format!("academy.cert:cert:{USER}:{CERT}")]);
    assert_eq!(s(&mark("k1"), "done"), "already recorded");
    assert_eq!(s(&mark("k2"), "done"), "the item was already complete");
    assert_eq!(run.grants(), both());
    assert_eq!(run.awards().len(), 1);
}

#[test]
fn a_watched_video_that_finishes_the_course_issues_the_programme_but_not_the_certificate() {
    let Some(run) = setup() else { return };
    run.enrol();
    run.rule("automatic", None);
    run.programme();
    // The one video on the spine, attached to its item (`admin.setItemVideo`), finished last.
    let watched = "foundations-risk-first";
    run.staff(
        "admin.setItemVideo",
        &Json::obj([
            ("itemSlug", Json::str(watched)),
            ("videoSlug", Json::str(watched)),
            ("reason", Json::str("TEST video")),
        ]),
    );
    for slug in items().iter().filter(|s| *s != watched) {
        run.complete(slug);
    }
    assert!(run.grants().is_empty());
    advance(1000);
    let saved = run.learner(
        "videoProgress.set",
        &Json::obj([
            ("videoSlug", Json::str(watched)),
            ("positionSeconds", Json::int(40)),
            ("clientRequestId", Json::str("TEST-watch-1")),
        ]),
    );
    assert_eq!(
        get(&saved, "completedItems").clone(),
        Json::Array(vec![Json::str(watched)])
    );
    // `setVideoProgress` settles the programmes only, as the TypeScript does.
    assert_eq!(
        run.grants(),
        [(
            PROGRAMME_CERT.to_owned(),
            format!("cert:{USER}:{PROGRAMME_CERT}")
        )]
    );
    assert!(run.awards().is_empty());
}

#[test]
fn an_undo_before_a_delayed_certificate_is_due_drops_its_wait_and_keeps_the_programme() {
    let Some(run) = setup() else { return };
    run.enrol();
    run.rule("delayed", Some(60));
    run.programme();
    let all = items();
    let (last, rest) = all.split_last().unwrap();
    for slug in rest {
        run.complete(slug);
    }
    assert!(run.waits().is_empty());
    let done = run.complete(last);
    // The delayed certificate waits; the programme is issued by the completion.
    assert_eq!(run.waits(), [CERT]);
    assert_eq!(
        run.grants(),
        [(
            PROGRAMME_CERT.to_owned(),
            format!("cert:{USER}:{PROGRAMME_CERT}")
        )]
    );
    advance(1000);
    let undo = run.learner(
        "undoCurriculumComplete",
        &Json::obj([
            ("itemSlug", Json::str(last.as_str())),
            ("completedAt", Json::str(s(&done, "completedAt"))),
            ("clientRequestId", Json::str("TEST-undo-1")),
        ]),
    );
    assert!(matches!(get(&undo, "undoneAt"), Json::String(_)));
    assert!(run.waits().is_empty(), "the Undo drops the wait at once");
    // A programme certificate already issued stays.
    assert_eq!(
        run.grants(),
        [(
            PROGRAMME_CERT.to_owned(),
            format!("cert:{USER}:{PROGRAMME_CERT}")
        )]
    );
    assert!(run.awards().is_empty());

    // Completing again starts a new wait; the sweep issues it once it is due.
    run.complete(last);
    assert_eq!(run.waits(), [CERT]);
}
