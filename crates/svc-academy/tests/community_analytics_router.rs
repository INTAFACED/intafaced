//! AC-analytics-01 and -02 through the door, as `analytics/analytics-router.test.ts`: the procedures need the operator
//! scope, a change needs admin:write, and a refusal keeps its code and its status. The TypeScript stubs the stores to
//! throw each refusal; here the real store meets the same refusal (blank owner values, a done task whose file expired,
//! an unknown id).
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod community_support;
mod support;

use community_support::{SECRET, door, exec, mutate, query, refused, setup};
use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::server::Request;

const FOUNDER: &str = "11111111-1111-4111-8111-111111111111";
const TASK: &str = "44444444-4444-4444-8444-444444444444";
const MISSING: &str = "55555555-5555-4555-8555-555555555555";
const OPERATOR: &[&str] = &["admin:read", "admin:write"];

fn task() -> Json {
    Json::obj([("taskId", Json::str(TASK))])
}

fn status(answer: &(u16, Json)) -> u16 {
    refused(answer).0
}

#[test]
fn a_learner_and_a_read_only_operator_are_refused_and_a_forged_caller_is_unauthorised() {
    let Some((_db, store)) = setup() else { return };
    let d = door(store, Json::obj([]));
    let learner = &["academy:read"];
    assert_eq!(
        status(&query(
            &d,
            FOUNDER,
            learner,
            "admin.learnerSummaries",
            Some(&Json::obj([]))
        )),
        403
    );
    assert_eq!(
        status(&query(
            &d,
            FOUNDER,
            learner,
            "admin.reportCentreTasks",
            None
        )),
        403
    );
    let reader = &["admin:read"];
    let req = Json::obj([
        ("kind", Json::str("learners")),
        ("tag", Json::Null),
        ("n", Json::int(1)),
    ]);
    assert_eq!(
        status(&mutate(&d, FOUNDER, reader, "admin.requestReport", &req)),
        403
    );
    assert_eq!(
        status(&mutate(&d, FOUNDER, reader, "admin.abortReport", &task())),
        403
    );
    assert_eq!(
        status(&mutate(&d, FOUNDER, reader, "admin.deleteReport", &task())),
        403
    );

    // A principal signed with another secret.
    let raw = Json::obj([
        ("sub", Json::str(FOUNDER)),
        (
            "scopes",
            Json::Array(OPERATOR.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("none")),
        ("mfa", Json::Bool(true)),
        ("sid", Json::str("22222222-2222-4222-8222-222222222222")),
        ("userId", Json::str(FOUNDER)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    assert_ne!(SECRET, "a-forger-secret-of-its-own");
    let headers = vec![
        (
            "x-intafaced-principal-sig".to_owned(),
            edge::sign(&raw, "a-forger-secret-of-its-own", "DE").unwrap(),
        ),
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-region".to_owned(), "DE".to_owned()),
    ];
    let input: String = task()
        .compact()
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    let url = format!("/trpc/admin.reportCentreFile?input={input}");
    let res = d.handle(&Request {
        method: "GET",
        url: &url,
        headers: &headers,
        body: "",
    });
    assert_eq!(res.status, 401, "{}", res.body);
    let body = json::parse(&res.body).unwrap();
    assert!(body.get("error").is_some());
}

#[test]
fn each_refusal_reaches_the_console_with_its_code_and_status() {
    let Some((db, store)) = setup() else { return };
    // A done task whose file expired: it cannot be aborted, and its file is gone.
    exec(
        &db,
        &format!(
            "INSERT INTO academy.report_centre_tasks (id, requested_by, n, kind, state, requested_at, started_at, finished_at, expires_at, csv, rows, sha256)
             VALUES ('{TASK}', '{FOUNDER}', 1, 'learners', 'done', '2026-11-12T08:00:00Z', '2026-11-12T08:00:10Z',
                     '2026-11-12T08:00:20Z', '2026-11-12T08:01:00Z', 'x', 0, '{}')",
            "0".repeat(64)
        ),
    );
    let d = door(store, Json::obj([]));
    let check = |answer: (u16, Json), code: &str, want: u16| {
        let (got, message, cause) = refused(&answer);
        assert_eq!(
            (got, cause.as_str()),
            (want, code),
            "{message}: {}",
            answer.1.compact()
        );
    };
    check(
        query(
            &d,
            FOUNDER,
            OPERATOR,
            "admin.learnerSummaries",
            Some(&Json::obj([])),
        ),
        "academy.learner_summaries_list_limit_unset",
        412,
    );
    check(
        query(&d, FOUNDER, OPERATOR, "admin.reportCentreTasks", None),
        "academy.report_tasks_list_limit_unset",
        412,
    );
    let req = Json::obj([
        ("kind", Json::str("learners")),
        ("tag", Json::Null),
        ("n", Json::int(1)),
    ]);
    check(
        mutate(&d, FOUNDER, OPERATOR, "admin.requestReport", &req),
        "academy.report_retention_unset",
        412,
    );
    check(
        mutate(&d, FOUNDER, OPERATOR, "admin.abortReport", &task()),
        "academy.report_not_abortable",
        409,
    );
    let missing = Json::obj([("taskId", Json::str(MISSING))]);
    check(
        mutate(&d, FOUNDER, OPERATOR, "admin.deleteReport", &missing),
        "academy.report_not_found",
        404,
    );
    check(
        query(
            &d,
            FOUNDER,
            OPERATOR,
            "admin.reportCentreFile",
            Some(&task()),
        ),
        "academy.report_expired",
        412,
    );
}
