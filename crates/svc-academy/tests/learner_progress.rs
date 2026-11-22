//! The progress page and the planner against a real Postgres: the port of `learning/progress.db.test.ts`. Figures are
//! TEST values, not owner settings.
//!
//! A quiz and its attempts are written by the assessment slice's calls (`setQuiz`, `startQuizAttempt`,
//! `answerQuizAttempt`, `finishQuizAttempt`); here they are written as the rows those calls leave (`academy.quizzes`,
//! `academy.assessment_attempts`), and the assertions on those calls' own answers (a hidden finish, the review and
//! resubmission refusals, the attempt list, the outline's rule) are left to that slice's port.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::support;

use service_kit::json::Json;
use support::TestDb;
use svc_academy::authoring::video::Gate;
use svc_academy::curriculum::spine;
use svc_academy::db::Store;
use svc_academy::door::system_now;
use svc_academy::errors::Refusal;
use svc_academy::learner::planner::Planner;
use svc_academy::learner::service::{Learning, Options, Settle};
use svc_academy::ports::Ports;

const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const STAFF: &str = "44444444-4444-4444-8444-444444444444";
const WEEK: i64 = 7 * 24 * 60 * 60 * 1000;

fn now() -> i64 {
    system_now().0
}

fn iso(ms: i64) -> String {
    service_kit::time::Instant(ms).iso()
}

fn code<T: std::fmt::Debug>(r: Result<T, Refusal>) -> String {
    match r {
        Err(Refusal::Academy(e)) => e.code,
        other => panic!("{other:?}"),
    }
}

fn arr(v: &Json) -> &Vec<Json> {
    match v {
        Json::Array(a) => a,
        other => panic!("not an array: {other:?}"),
    }
}

fn s(v: &Json, key: &str) -> String {
    match v.get(key) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{key}: {other:?}"),
    }
}

fn n(v: &Json, key: &str) -> f64 {
    match v.get(key) {
        Some(Json::Number(n)) => *n,
        other => panic!("{key}: {other:?}"),
    }
}

fn items(path: &str) -> Vec<String> {
    spine::list(Some(path), None)
        .iter()
        .map(|i| i.slug.clone())
        .collect()
}

struct T {
    db: TestDb,
    store: Store,
    ports: Ports,
}

const OPTIONS: Options<'static> = Options {
    watch_threshold_seconds: None,
    video_storage: None,
    video_gate: &Gate {
        min_tier: String::new(),
        min_stake: String::new(),
    },
    settle: &Settle::NONE,
};

impl T {
    fn learning(&self) -> Learning<'_> {
        Learning {
            pool: &self.store,
            ports: &self.ports,
            options: OPTIONS,
        }
    }

    fn planner(&self, todo_limit: Option<i64>) -> Planner<'_> {
        Planner {
            pool: &self.store,
            todo_limit,
        }
    }

    fn exec(&self, sql: &str) {
        self.db.client().batch_execute(sql).unwrap();
    }

    fn page(&self, user: &str, at: i64) -> Json {
        self.learning().progress_page(user, at).unwrap()
    }
}

macro_rules! db {
    () => {
        match TestDb::migrated() {
            Some(db) => {
                let store = Store::Pool(db.pool());
                T {
                    db,
                    store,
                    ports: Ports::unwired(),
                }
            }
            None => {
                eprintln!("skipped: no TEST_DATABASE_URL");
                return;
            }
        }
    };
}

// ── progress page (AC-progress-02) ─────────────────────────────────────────────────────────────────────────────────

#[test]
fn shows_percent_complete_over_the_courses_items_with_each_completion_and_an_empty_grades_list_with_no_average()
 {
    let t = db!();
    assert_eq!(
        t.page(USER, now()).compact(),
        r#"{"courses":[],"grades":{"rows":[],"averages":[]},"courseGrades":[]}"#
    );
    t.learning()
        .enrol_course(USER, "markets", "audit", now())
        .unwrap();
    let items = items("markets");
    t.learning()
        .mark_complete(USER, "none", &items[0], now())
        .unwrap();
    let page = t.page(USER, now());
    let courses = arr(page.get("courses").unwrap());
    assert_eq!(courses.len(), 1);
    let course = &courses[0];
    assert_eq!(s(course, "slug"), "markets");
    assert_eq!(n(course, "visible"), items.len() as f64);
    assert_eq!(n(course, "completed"), 1.0);
    let expected = (1000.0 / items.len() as f64).round() / 10.0;
    let percent = s(course, "percent");
    assert!(
        (percent.parse::<f64>().unwrap() - expected).abs() < 0.05,
        "{percent} vs {expected}"
    );
    let (whole, tenth) = percent.split_once('.').unwrap();
    assert!(
        !whole.is_empty() && whole.bytes().all(|b| b.is_ascii_digit()) && tenth.len() == 1,
        "{percent}"
    );
    assert_eq!(
        arr(course.get("items").unwrap())
            .iter()
            .map(|r| !matches!(r.get("completedAt"), Some(Json::Null)))
            .collect::<Vec<_>>(),
        (0..items.len()).map(|i| i == 0).collect::<Vec<_>>()
    );
    assert_eq!(
        page.get("grades").unwrap().compact(),
        r#"{"rows":[],"averages":[]}"#
    );
    // Another learner's progress is not this learner's.
    assert_eq!(
        t.page(OTHER, now()).get("courses"),
        Some(&Json::Array(vec![]))
    );
}

#[test]
fn grades_a_quiz_at_the_best_attempt_hides_results_until_their_date_everywhere_the_learner_reads_them_and_averages_released_ones()
 {
    let t = db!();
    let slug = items("markets")[1].clone();
    let publish = |hidden_until: Option<i64>| {
        let until =
            hidden_until.map_or("NULL".to_owned(), |u| format!("'{}'::timestamptz", iso(u)));
        t.exec(&format!(
            "INSERT INTO academy.quizzes (slug, definition, pass_mark, attempt_limit, time_limit_seconds, review_mode, reason, \
               set_by, set_at, results_hidden_until) \
             VALUES ('{slug}', '{{}}'::jsonb, 2, NULL, NULL, 'answers', 'TEST quiz', '{STAFF}', now(), {until}) \
             ON CONFLICT (slug) DO UPDATE SET results_hidden_until = EXCLUDED.results_hidden_until"
        ));
    };
    // A finished attempt as `finishQuizAttempt` stores it: its score, and the hiding date the quiz had at finish.
    let attempt = |id: &str, score: i32, at: i64, hidden_until: Option<i64>| {
        let until =
            hidden_until.map_or("NULL".to_owned(), |u| format!("'{}'::timestamptz", iso(u)));
        t.exec(&format!(
            "INSERT INTO academy.assessment_attempts (user_id, slug, client_attempt_id, score, max_score, passed, submitted_at, hidden_until) \
             VALUES ('{USER}', '{slug}', 'quiz-attempt:{id}', {score}, 2, {}, '{}', {until})",
            score >= 2,
            iso(at)
        ));
    };
    publish(None);
    let now_at = now();
    attempt("one", 0, now_at, None);
    attempt("two", 2, now_at + 1, None);
    let page = t.page(USER, now_at + 2);
    let rows = arr(page.get("grades").unwrap().get("rows").unwrap());
    assert_eq!(rows.len(), 1);
    let title = s(&rows[0], "title");
    assert_eq!(
        rows[0],
        Json::obj([
            ("pending", Json::Bool(false)),
            ("slug", Json::str(slug.clone())),
            ("title", Json::str(title.clone())),
            ("type", Json::str("quiz")),
            ("attempts", Json::int(2)),
            ("score", Json::str("2")),
            ("possible", Json::str("2")),
            ("percent", Json::str("100.0")),
            ("passed", Json::Bool(true)),
        ])
    );
    assert_eq!(
        page.get("grades")
            .unwrap()
            .get("averages")
            .unwrap()
            .compact(),
        r#"[{"type":"quiz","percent":"100.0","count":1}]"#
    );

    // Staff hide results until next week: the grade is pending and the score is nowhere.
    let until = now_at + WEEK;
    publish(Some(until));
    let page = t.page(USER, now_at + 2);
    let grades = page.get("grades").unwrap();
    assert_eq!(
        arr(grades.get("rows").unwrap())[0],
        Json::obj([
            ("pending", Json::Bool(true)),
            ("slug", Json::str(slug.clone())),
            ("title", Json::str(title)),
            ("type", Json::str("quiz")),
            ("attempts", Json::int(2)),
            ("hiddenUntil", Json::str(iso(until))),
        ])
    );
    assert_eq!(grades.get("averages"), Some(&Json::Array(vec![])));
    let text = grades.compact();
    assert!(
        !text.contains("score") && !text.contains("percent"),
        "{text}"
    );
    // A third attempt finished while hidden keeps the date it finished under.
    attempt("three", 0, now_at + 3, Some(until));
    // The rule is not met while hidden: Complete refuses.
    assert_eq!(
        code(t.learning().mark_complete(USER, "none", &slug, now_at + 4)),
        "academy.completion_rule_unmet"
    );

    // A staff re-publish without the date, or a take-down, does not release a result kept hidden at finish.
    publish(None);
    assert_eq!(
        arr(t
            .page(USER, now_at + 5)
            .get("grades")
            .unwrap()
            .get("rows")
            .unwrap())[0]
            .get("pending"),
        Some(&Json::Bool(true))
    );
    t.exec(&format!(
        "DELETE FROM academy.quizzes WHERE slug = '{slug}'"
    ));
    let row = arr(t
        .page(USER, now_at + 5)
        .get("grades")
        .unwrap()
        .get("rows")
        .unwrap())[0]
        .clone();
    assert_eq!(row.get("pending"), Some(&Json::Bool(true)));
    assert_eq!(s(&row, "hiddenUntil"), iso(until));

    // Past the date the results show again.
    let released = t.page(USER, until + 1000);
    let row = &arr(released.get("grades").unwrap().get("rows").unwrap())[0];
    assert_eq!(row.get("pending"), Some(&Json::Bool(false)));
    assert_eq!(n(row, "attempts"), 3.0);
    assert_eq!(
        (s(row, "score"), s(row, "percent")),
        ("2".to_owned(), "100.0".to_owned())
    );
}

// ── progress page grades and courses staff made (AC-quizzes-01) ─────────────────────────────────────────────────────

#[test]
fn leaves_a_quiz_in_a_course_staff_made_out_of_the_path_grades() {
    let t = db!();
    let item_id = "77777777-7777-4777-8777-777777777777";
    t.exec(&format!(
        "INSERT INTO academy.assessment_attempts (user_id, slug, client_attempt_id, score, max_score, passed, submitted_at) \
         VALUES ('{USER}', '{item_id}', 'quiz-attempt:TEST', 1, 2, false, now())"
    ));
    assert_eq!(
        t.page(USER, now()).get("grades").unwrap().compact(),
        r#"{"rows":[],"averages":[]}"#
    );
}

// ── planner (AC-progress-02) ────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn refuses_an_add_while_the_owner_has_set_no_cap_in_words() {
    let t = db!();
    let p = t.planner(None);
    assert_eq!(
        code(p.add_todo(USER, "todo:0", "TEST read", now())),
        "academy.planner_limit_unset"
    );
    assert_eq!(
        p.read(USER, now()).unwrap().get("todoLimit"),
        Some(&Json::Null)
    );
}

#[test]
fn adds_once_per_key_refuses_a_reused_key_for_other_text_keeps_to_the_cap_and_is_the_learners_own()
{
    let t = db!();
    let p = t.planner(Some(2));
    let first = p
        .add_todo(USER, "todo:0", " TEST read chapter two ", now())
        .unwrap();
    assert_eq!(s(&first, "text"), "TEST read chapter two");
    assert_eq!(
        p.add_todo(USER, "todo:0", "TEST read chapter two", now())
            .unwrap(),
        first
    );
    assert_eq!(
        code(p.add_todo(USER, "todo:0", "TEST other", now())),
        "academy.request_reused"
    );
    let second = p.add_todo(USER, "todo:1", "TEST quiz", now()).unwrap();
    assert_eq!(
        code(p.add_todo(USER, "todo:2", "TEST third", now())),
        "academy.planner_full"
    );
    let done = p
        .set_todo_done(USER, &s(&second, "id"), true, now())
        .unwrap();
    assert!(!matches!(done.get("doneAt"), Some(Json::Null) | None));
    assert_eq!(
        p.set_todo_done(USER, &s(&second, "id"), true, now() + 10)
            .unwrap()
            .get("doneAt"),
        done.get("doneAt")
    );
    assert_eq!(
        code(p.set_todo_done(OTHER, &s(&second, "id"), false, now())),
        "academy.todo_not_found"
    );
    assert_eq!(
        code(p.remove_todo(OTHER, &s(&first, "id"), now())),
        "academy.todo_not_found"
    );
    p.remove_todo(USER, &s(&first, "id"), now()).unwrap();
    // A late replay of the removed item's add does not bring it back.
    p.add_todo(USER, "todo:0", "TEST read chapter two", now())
        .unwrap();
    let planner = p.read(USER, now()).unwrap();
    assert_eq!(
        arr(planner.get("todos").unwrap())
            .iter()
            .map(|r| s(r, "text"))
            .collect::<Vec<_>>(),
        ["TEST quiz"]
    );
    assert_eq!(n(&planner, "revision"), 2.0);
    assert_eq!(
        p.read(OTHER, now()).unwrap().get("todos"),
        Some(&Json::Array(vec![]))
    );
}

#[test]
fn saves_a_weekly_goal_counts_this_weeks_completions_and_the_reminder_names_the_missing_mail_sender()
 {
    let t = db!();
    let p = t.planner(None);
    assert_eq!(code(p.send_goal_reminder(USER)), "academy.goal_invalid");
    assert_eq!(
        code(p.set_goal(USER, 0.0, true, now())),
        "academy.goal_invalid"
    );
    t.learning()
        .mark_complete(USER, "none", &items("markets")[0], now())
        .unwrap();
    let goal = p.set_goal(USER, 3.0, false, now()).unwrap();
    assert_eq!(
        (
            n(&goal, "itemsPerWeek"),
            goal.get("reminder"),
            n(&goal, "doneThisWeek")
        ),
        (3.0, Some(&Json::Bool(false)), 1.0)
    );
    assert_eq!(code(p.send_goal_reminder(USER)), "academy.goal_invalid");
    p.set_goal(USER, 3.0, true, now()).unwrap();
    assert_eq!(
        p.send_goal_reminder(USER).unwrap().compact(),
        r#"{"sent":false,"mail":"vendor.email"}"#
    );
    let saved = p.read(USER, now()).unwrap();
    let g = saved.get("goal").unwrap();
    assert_eq!(
        (n(g, "itemsPerWeek"), g.get("reminder")),
        (3.0, Some(&Json::Bool(true)))
    );
}
