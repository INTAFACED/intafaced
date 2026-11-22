//! The assertions the slice PRs left "to another slice", through the door and each slice's own calls instead of seeded
//! rows (`learning/customer.db.test.ts`, `learners/staff-enrolment.db.test.ts`, `release/access.db.test.ts`):
//!
//! - `myCompletions` and `admin.completionsByItem` (certificate and community slices) read what `markCurriculumComplete`
//!   (learner slice) wrote.
//! - `enrollCertPath`, `leaveCertPath` and `myEnrollments` (certificate slice), counted by `admin.enrolments` (learner
//!   slice).
//! - A full course: `admin.setCourseSeatCap` (authoring) closes `enrolCourse` (learner) to a learner, and
//!   `admin.staffEnrol` (community) still seats one past it.
//! - A prerequisite: `admin.setItemPrerequisites` (authoring) holds `markCurriculumComplete` and `itemRelease`
//!   (learner) until the first item is complete.
//!
//! Figures are TEST values, not owner settings. Days are on the test clock (2030-01-01 onward).
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::panic,
    reason = "a test: a failure is the point"
)]

use crate::community_support;
use crate::join_support;

use community_support::{arr, data, get, mutate, n, query, refused, s};
use join_support::{LEARNER, OTHER, Run, STAFF, USER, advance, setup};
use service_kit::json::Json;
use svc_academy::curriculum::spine;

const THIRD: &str = "44444444-4444-4444-8444-444444444444";
const DAY: i64 = 86_400_000;

fn slug(v: &str) -> Json {
    Json::obj([("itemSlug", Json::str(v))])
}

fn path(v: &str) -> Json {
    Json::obj([("pathSlug", Json::str(v))])
}

impl Run {
    /// A learner change as `user`: its answer, or its refusal code.
    fn change_as(&self, user: &str, path: &str, input: &Json) -> Result<Json, String> {
        let answer = mutate(&self.door, user, &LEARNER, path, input);
        if answer.0 == 200 {
            Ok(data(&answer))
        } else {
            Err(refused(&answer).2)
        }
    }

    fn complete_as(&self, user: &str, item: &str) -> Json {
        advance(1000);
        self.change_as(user, "markCurriculumComplete", &slug(item))
            .unwrap()
    }

    fn read_as(&self, user: &str, path: &str, input: Option<&Json>) -> Json {
        data(&query(&self.door, user, &LEARNER, path, input))
    }

    fn slugs(&self, page: &Json) -> Vec<String> {
        arr(page, "items")
            .iter()
            .map(|r| s(r, "itemSlug"))
            .collect()
    }
}

#[test]
fn my_completions_lists_what_complete_wrote_including_a_lesson_outside_every_certificate_and_pages()
{
    let Some(run) = setup() else { return };
    run.complete_as(USER, "markets-reading-the-book");
    run.complete_as(OTHER, "foundations-risk-first");
    let limit = |l: i64| Json::obj([("limit", Json::int(l))]);
    let mine = run.read_as(USER, "myCompletions", Some(&limit(10)));
    assert_eq!(run.slugs(&mine), ["markets-reading-the-book"]);
    let theirs = run.read_as(OTHER, "myCompletions", Some(&limit(10)));
    assert_eq!(run.slugs(&theirs), ["foundations-risk-first"]);

    for item in [
        "foundations-risk-first",
        "foundations-order-types",
        "builder-first-automation",
    ] {
        run.complete_as(USER, item);
    }
    let first = run.read_as(USER, "myCompletions", Some(&limit(2)));
    let cursor = s(&first, "nextCursor");
    let second = run.read_as(
        USER,
        "myCompletions",
        Some(&Json::obj([
            ("limit", Json::int(2)),
            ("cursor", Json::str(cursor)),
        ])),
    );
    let mut all = run.slugs(&first);
    all.extend(run.slugs(&second));
    assert_eq!(
        all,
        [
            "builder-first-automation",
            "foundations-order-types",
            "foundations-risk-first",
            "markets-reading-the-book"
        ]
    );
    assert_eq!(get(&second, "nextCursor"), &Json::Null);
}

#[test]
fn enrols_lists_leaves_with_history_replays_the_leave_and_counts_by_path() {
    let Some(run) = setup() else { return };
    run.learner("enrollCertPath", &path("foundations"));
    let listed = |user: &str| -> Vec<String> {
        match run.read_as(user, "myEnrollments", None) {
            Json::Array(rows) => rows.iter().map(|r| s(r, "pathSlug")).collect(),
            other => panic!("myEnrollments answered {other:?}"),
        }
    };
    assert_eq!(listed(USER), ["foundations"]);
    advance(1000);
    let leave = |user: &str, key: &str| {
        run.change_as(
            user,
            "leaveCertPath",
            &Json::obj([
                ("pathSlug", Json::str("foundations")),
                ("clientRequestId", Json::str(key)),
            ]),
        )
    };
    let left = leave(USER, "leave-1").unwrap();
    assert!(matches!(get(&left, "leftAt"), Json::String(_)));
    assert!(listed(USER).is_empty());
    let history = || {
        run.db.texts(&format!(
            "SELECT COUNT(*)::text FROM academy.cert_enrollments WHERE user_id = '{USER}' AND path_slug = 'foundations' AND left_at IS NOT NULL"
        ))
    };
    assert_eq!(history(), ["1"]);
    assert_eq!(
        leave(OTHER, "leave-other").unwrap_err(),
        "academy.enrollment_not_found"
    );
    assert_eq!(history(), ["1"]);
    advance(1000);
    let replay = leave(USER, "leave-1").unwrap();
    assert_eq!(s(&replay, "leftAt"), s(&left, "leftAt"));
    assert_eq!(s(&replay, "enrolledAt"), s(&left, "enrolledAt"));
    run.learner("enrollCertPath", &path("foundations"));
    assert_eq!(
        run.db.texts(&format!(
            "SELECT COUNT(*)::text || '/' || COUNT(*) FILTER (WHERE left_at IS NULL)::text FROM academy.cert_enrollments WHERE user_id = '{USER}' AND path_slug = 'foundations'"
        )),
        ["2/1"]
    );

    // `admin.enrolments` (learner slice) counts each enrolment made in the UTC window, by path, and names no account.
    // An enrolment is stamped with the database's own `now()`, as `customer-store.ts` does, so the window is its day.
    run.change_as(OTHER, "enrollCertPath", &path("foundations"))
        .unwrap();
    // `builder` has no published certificate, so its free course track is the enrolment (`enrolCourse`).
    run.change_as(
        THIRD,
        "enrolCourse",
        &Json::obj([
            ("slug", Json::str("builder")),
            ("track", Json::str("audit")),
        ]),
    )
    .unwrap();
    let today = run
        .db
        .texts("SELECT (now() AT TIME ZONE 'UTC')::date::text")
        .remove(0);
    let window = |from: &str, to: &str| {
        run.staff_read(
            "admin.enrolments",
            &Json::obj([("from", Json::str(from)), ("to", Json::str(to))]),
        )
    };
    let counts = window(&today, &today);
    assert_eq!(n(&counts, "total"), 4, "{counts:?}");
    let paths: Vec<(String, i64)> = arr(&counts, "paths")
        .iter()
        .map(|p| (s(p, "pathSlug"), n(p, "count")))
        .collect();
    assert_eq!(
        paths,
        [("builder".to_owned(), 1), ("foundations".to_owned(), 3)]
    );
    let empty = window("2020-01-01", "2020-01-02");
    assert_eq!(n(&empty, "total"), 0);
    assert_eq!(arr(&empty, "paths").len(), 0);
    let body = counts.compact();
    for id in [USER, OTHER, THIRD] {
        assert!(!body.contains(id));
    }
}

#[test]
fn completions_by_item_counts_what_complete_wrote_inside_the_window_by_path() {
    let Some(run) = setup() else { return };
    run.complete_as(USER, "foundations-risk-first");
    run.complete_as(OTHER, "foundations-risk-first");
    run.complete_as(USER, "markets-reading-the-book");
    advance(DAY);
    run.complete_as(THIRD, "foundations-risk-first");
    let window = |to: &str, path: Option<&str>| {
        let mut input = vec![
            ("from".to_owned(), Json::str("2030-01-01")),
            ("to".to_owned(), Json::str(to)),
        ];
        if let Some(p) = path {
            input.push(("pathSlug".to_owned(), Json::str(p)));
        }
        run.staff_read("admin.completionsByItem", &Json::Object(input))
    };
    let count = |page: &Json, item: &str| {
        arr(page, "items")
            .iter()
            .find(|r| s(r, "itemSlug") == item)
            .map(|r| (get(r, "pathSlug").clone(), n(r, "count")))
    };
    let day1 = window("2030-01-01", None);
    assert_eq!(
        count(&day1, "foundations-risk-first"),
        Some((Json::str("foundations"), 2))
    );
    assert_eq!(
        count(&day1, "markets-reading-the-book"),
        Some((Json::str("markets"), 1))
    );
    assert_eq!(
        count(&day1, "foundations-order-types"),
        Some((Json::str("foundations"), 0))
    );
    assert_eq!(
        count(&window("2030-01-02", None), "foundations-risk-first"),
        Some((Json::str("foundations"), 3))
    );
    let markets = window("2030-01-02", Some("markets"));
    let mut listed: Vec<String> = arr(&markets, "items")
        .iter()
        .map(|r| s(r, "itemSlug"))
        .collect();
    listed.sort();
    let mut expected: Vec<String> = spine::list(Some("markets"), None)
        .iter()
        .map(|i| i.slug.clone())
        .collect();
    expected.sort();
    assert_eq!(listed, expected);
    assert!(!markets.compact().contains(USER));
}

#[test]
fn a_full_course_refuses_a_learner_enrolling_themselves_and_staff_seat_one_past_it() {
    let Some(run) = setup() else { return };
    let enrol = |user: &str| {
        run.change_as(
            user,
            "enrolCourse",
            &Json::obj([
                ("slug", Json::str("foundations")),
                ("track", Json::str("audit")),
            ]),
        )
    };
    enrol(USER).unwrap();
    run.staff(
        "admin.setCourseSeatCap",
        &Json::obj([
            ("slug", Json::str("foundations")),
            ("seatCap", Json::int(1)),
            ("reason", Json::str("TEST cap")),
        ]),
    );
    assert_eq!(enrol(THIRD).unwrap_err(), "academy.enrolment_closed");
    let done = run.staff(
        "admin.staffEnrol",
        &Json::obj([
            ("path", Json::str("foundations")),
            ("userId", Json::str(OTHER)),
            ("reason", Json::str("TEST bursary seat")),
        ]),
    );
    assert_eq!(s(&done, "outcome"), "enrolled");
    let event = get(&done, "event");
    assert_eq!(s(event, "userId"), OTHER);
    assert_eq!(
        get(event, "bypassed").clone(),
        Json::Array(vec![Json::str("full")])
    );
    assert_eq!(s(event, "actorId"), STAFF);
    assert_eq!(s(event, "key"), format!("enrol:foundations:{OTHER}:1"));
    // The learner the staff seated is enrolled; the one refused still is not.
    assert_eq!(enrol(THIRD).unwrap_err(), "academy.enrolment_closed");
    let repeat = run.staff(
        "admin.staffEnrol",
        &Json::obj([
            ("path", Json::str("foundations")),
            ("userId", Json::str(OTHER)),
            ("reason", Json::str("TEST again")),
        ]),
    );
    assert_eq!(s(&repeat, "outcome"), "already_enrolled");
    let read = refused(&mutate(
        &run.door,
        STAFF,
        &["admin:read"],
        "admin.staffEnrol",
        &Json::obj([
            ("path", Json::str("foundations")),
            ("userId", Json::str(THIRD)),
            ("reason", Json::str("TEST")),
        ]),
    ));
    assert_eq!(read.0, 403);
}

#[test]
fn a_prerequisite_set_by_staff_holds_complete_until_the_first_item_is_complete() {
    let Some(run) = setup() else { return };
    let (first, second) = ("foundations-risk-first", "foundations-order-types");
    let set = run.staff(
        "admin.setItemPrerequisites",
        &Json::obj([
            ("itemSlug", Json::str(second)),
            ("prerequisites", Json::Array(vec![Json::str(first)])),
        ]),
    );
    assert_eq!(
        get(&set, "prerequisites").clone(),
        Json::Array(vec![Json::str(first)])
    );
    assert_eq!(
        run.change_as(USER, "markCurriculumComplete", &slug(second))
            .unwrap_err(),
        "academy.prerequisite_unmet"
    );
    run.complete_as(USER, first);
    let done = run.complete_as(USER, second);
    assert_eq!(s(&done, "itemSlug"), second);
    let view = run.read_as(USER, "itemRelease", Some(&slug(second)));
    assert_eq!(s(&view, "state"), "completed");
    for key in [
        "availableFrom",
        "availableUntil",
        "dueAt",
        "extendedUntil",
        "reason",
        "grantedAt",
        "grantedBy",
    ] {
        assert_eq!(get(&view, key), &Json::Null, "{key}");
    }
}

/// A visitor's read (no session, a region header), as the edge sends it.
fn visit(run: &Run, path: &str, input: Option<&Json>) -> Json {
    data(&community_support::visitor(&run.door, path, input))
}

#[test]
fn a_featured_item_behind_a_prerequisite_leaves_the_hub_and_its_objectives_leave_the_public_course()
{
    let Some(run) = setup() else { return };
    let empty = Json::obj([("featured", Json::Null), ("lesson", Json::Null)]);
    let course = Json::obj([("slug", Json::str("foundations"))]);
    let before = visit(&run, "publicCourse", Some(&course));
    run.staff(
        "admin.setFeatured",
        &Json::obj([
            ("itemSlug", Json::str("foundations-order-types")),
            ("reason", Json::str("Start here")),
        ]),
    );
    let hub = visit(&run, "publicHub", None);
    assert_eq!(s(get(&hub, "featured"), "slug"), "foundations-order-types");
    run.staff(
        "admin.setItemPrerequisites",
        &Json::obj([
            ("itemSlug", Json::str("foundations-order-types")),
            (
                "prerequisites",
                Json::Array(vec![Json::str("foundations-risk-first")]),
            ),
        ]),
    );
    // The curriculum slice's hub leaves out a chosen item a visitor could not open.
    assert_eq!(visit(&run, "publicHub", None), empty);
    // The learner slice's public course keeps its syllabus and drops the gated lesson's objectives.
    let after = visit(&run, "publicCourse", Some(&course));
    assert_eq!(get(&after, "syllabus"), get(&before, "syllabus"));
    assert!(
        arr(&after, "outcomes").len() < arr(&before, "outcomes").len(),
        "{} vs {}",
        arr(&after, "outcomes").len(),
        arr(&before, "outcomes").len()
    );
}

#[test]
fn a_certificate_exception_shows_in_the_grant_audit_with_who_and_why() {
    const APPROVER: &str = "55555555-5555-4555-8555-555555555555";
    let Some(run) = join_support::setup_with(|ports| {
        ports.approvals = Box::new(svc_academy::ports::StubApprovals(APPROVER.to_owned()));
    }) else {
        return;
    };
    run.learner("enrollCertPath", &path("foundations"));
    let first_item = spine::list(Some("foundations"), None)[0].slug.clone();
    run.complete_as(USER, &first_item);
    let reason = "TEST a learner who finished elsewhere";
    let except = |why: &str| {
        run.staff(
            "admin.grantCertException",
            &Json::obj([
                ("userId", Json::str(USER)),
                ("certId", Json::str("foundations-v1")),
                ("reason", Json::str(why)),
                ("approvalId", Json::str("TEST-approval")),
                ("operationId", Json::str("TEST-operation")),
            ]),
        )
    };
    let first = except(reason);
    assert_eq!(s(&first, "approvedBy"), APPROVER);
    assert_eq!(s(&first, "grantedBy"), STAFF);
    // A repeat answers with the first record.
    assert_eq!(except("TEST a different reason"), first);
    // The learner slice's audit names the exception, its operator and its reason.
    let audit = run.staff_read(
        "admin.grantAudit",
        &Json::obj([("certificate", Json::str("foundations-v1"))]),
    );
    let lines = arr(&audit, "items");
    assert_eq!(lines.len(), 1, "{audit:?}");
    assert_eq!(s(&lines[0], "kind"), "certificate_granted");
    assert_eq!(s(&lines[0], "accountId"), USER);
    assert_eq!(s(&lines[0], "source"), "exception");
    assert_eq!(s(&lines[0], "actorId"), STAFF);
    assert_eq!(s(&lines[0], "reason"), reason);
}

#[test]
fn the_public_catalogue_lists_a_card_per_course_opens_one_and_refuses_what_is_not_a_course() {
    let Some(run) = setup() else { return };
    let cards = visit(&run, "publicCourses", None);
    let Json::Array(cards) = cards else {
        panic!("publicCourses answered {cards:?}")
    };
    let mut paths: Vec<String> = spine::list(None, None)
        .iter()
        .map(|i| i.path.clone())
        .collect();
    paths.sort();
    paths.dedup();
    let mut listed: Vec<String> = cards.iter().map(|c| s(c, "slug")).collect();
    listed.sort();
    assert_eq!(listed, paths);
    for card in &cards {
        let slug = s(card, "slug");
        assert_eq!(
            n(card, "items"),
            i64::try_from(spine::list(Some(&slug), None).len()).unwrap()
        );
    }
    let course = visit(
        &run,
        "publicCourse",
        Some(&Json::obj([("slug", Json::str("foundations"))])),
    );
    let syllabus: Vec<String> = arr(&course, "syllabus")
        .iter()
        .map(|r| s(r, "slug"))
        .collect();
    let spine_slugs: Vec<String> = spine::list(Some("foundations"), None)
        .iter()
        .map(|i| i.slug.clone())
        .collect();
    assert_eq!(syllabus, spine_slugs);
    assert_eq!(get(&course, "summary"), &Json::Null);
    assert_eq!(get(&course, "instructor"), &Json::Null);
    // The certificate slice's published Foundations certificate names the course's certificate.
    let published = svc_academy::certs::catalog::for_path(
        "foundations",
        svc_academy::certs::catalog::production(),
    )
    .unwrap();
    assert_eq!(s(&course, "certificate"), published.title);
    for slug in ["no-such-course", spine_slugs[0].as_str()] {
        let answer = community_support::visitor(
            &run.door,
            "publicCourse",
            Some(&Json::obj([("slug", Json::str(slug))])),
        );
        assert_eq!(refused(&answer).2, "academy.course_not_found", "{slug}");
    }
    // Without the owner's video storage settings the public video list refuses (authoring's video slice).
    let bare = community_support::door(
        svc_academy::db::Store::Pool(run.db.pool()),
        Json::Object(Vec::new()),
    );
    let answer = community_support::visitor(&bare, "publicVideos", None);
    assert_eq!(refused(&answer).2, "academy.video_storage_unconfigured");
}

impl Run {
    fn prerequisites(&self, item: &str, needs: &[&str]) {
        self.staff(
            "admin.setItemPrerequisites",
            &Json::obj([
                ("itemSlug", Json::str(item)),
                (
                    "prerequisites",
                    Json::Array(needs.iter().map(|p| Json::str(*p)).collect()),
                ),
            ]),
        );
    }

    fn outline(&self, user: &str, item: &str) -> Vec<Json> {
        arr(
            &self.read_as(user, "courseOutline", Some(&slug(item))),
            "items",
        )
        .to_vec()
    }
}

fn strings(v: &Json) -> Vec<String> {
    match v {
        Json::Array(list) => list
            .iter()
            .map(|x| match x {
                Json::String(t) => t.clone(),
                other => panic!("not a string: {other:?}"),
            })
            .collect(),
        other => panic!("not a list: {other:?}"),
    }
}

#[test]
fn the_outline_locks_an_item_behind_a_staff_prerequisite_until_complete_and_start_course_skips_a_locked_first_item()
 {
    let Some(run) = setup() else { return };
    let items: Vec<String> = spine::list(Some("markets"), None)
        .iter()
        .map(|i| i.slug.clone())
        .collect();
    assert!(items.len() >= 3);
    run.prerequisites(&items[2], &[&items[1]]);
    let outline = run.outline(USER, &items[0]);
    let slugs: Vec<String> = outline.iter().map(|r| s(r, "slug")).collect();
    assert_eq!(slugs, items);
    assert_eq!(s(&outline[2], "state"), "locked");
    assert_eq!(s(&outline[2], "lock"), "prerequisite");
    assert_eq!(strings(get(&outline[2], "missing")), [items[1].clone()]);
    assert_eq!(get(&outline[2], "opensAt"), &Json::Null);
    assert_eq!(s(&outline[0], "state"), "unlocked");
    assert_eq!(get(&outline[0], "lock"), &Json::Null);
    assert!(!Json::Array(outline.clone()).compact().contains("\"body\""));

    run.complete_as(USER, &items[1]);
    let after = run.outline(USER, &items[2]);
    assert_eq!(s(&after[1], "state"), "completed");
    assert_eq!(get(&after[2], "lock"), &Json::Null);
    assert!(strings(get(&after[2], "missing")).is_empty());
    assert_eq!(s(&run.outline(OTHER, &items[2])[2], "lock"), "prerequisite");

    // Start course skips a first item a staff prerequisite now locks.
    run.prerequisites(&items[0], &[&items[2]]);
    run.change_as(
        OTHER,
        "enrolCourse",
        &Json::obj([
            ("slug", Json::str("markets")),
            ("track", Json::str("audit")),
        ]),
    )
    .unwrap();
    let learning = run.read_as(OTHER, "myLearning", None);
    let Json::Array(rows) = learning else {
        panic!("myLearning answered {learning:?}")
    };
    assert_eq!(s(&rows[0], "firstItemSlug"), items[1]);
}

#[test]
fn complete_meets_the_view_rule_on_the_outline_and_undo_relocks_the_next_item() {
    let Some(run) = setup() else { return };
    let items: Vec<String> = spine::list(Some("markets"), None)
        .iter()
        .map(|i| i.slug.clone())
        .collect();
    run.prerequisites(&items[1], &[&items[0]]);
    let first = run.complete_as(USER, &items[0]);
    let again = run.complete_as(USER, &items[0]);
    assert_eq!(s(&again, "completedAt"), s(&first, "completedAt"));
    let outline = run.outline(USER, &items[0]);
    assert_eq!(s(&outline[0], "state"), "completed");
    assert_eq!(s(&outline[0], "rule"), "view");
    assert_eq!(get(&outline[0], "ruleMet"), &Json::Bool(true));
    assert_eq!(s(&outline[0], "completedAt"), s(&first, "completedAt"));
    assert_eq!(get(&outline[1], "lock"), &Json::Null);
    assert_eq!(get(&outline[1], "completedAt"), &Json::Null);

    advance(1000);
    let undone = run.learner(
        "undoCurriculumComplete",
        &Json::obj([
            ("itemSlug", Json::str(items[0].clone())),
            ("completedAt", Json::str(s(&first, "completedAt"))),
            ("clientRequestId", Json::str("undo-1")),
        ]),
    );
    assert!(matches!(get(&undone, "undoneAt"), Json::String(_)));
    let dropped = run.outline(USER, &items[0]);
    assert_eq!(s(&dropped[0], "state"), "unlocked");
    assert_eq!(get(&dropped[0], "completedAt"), &Json::Null);
    assert_eq!(s(&dropped[1], "lock"), "prerequisite");
    assert_eq!(strings(get(&dropped[1], "missing")), [items[0].clone()]);
    assert_eq!(
        run.change_as(USER, "markCurriculumComplete", &slug(&items[1]))
            .unwrap_err(),
        "academy.prerequisite_unmet"
    );
}
