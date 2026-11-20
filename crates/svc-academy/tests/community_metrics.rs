//! The founder console's daily counts and completions by item, as the `opsMetrics` and `completionsByItem` parts of
//! `learning/customer.db.test.ts`, through the door; and the UTC window's edge cases (`learning/metrics.ts`).
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod community_support;
mod support;

use community_support::{arr, code, data, door, exec, get, n, query, refused, s, setup};
use service_kit::json::Json;
use svc_academy::community::metrics::{MAX_DAYS, parse_utc_day, utc_window};
use svc_academy::curriculum::spine;

const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
const THIRD: &str = "44444444-4444-4444-8444-444444444444";
const FOURTH: &str = "55555555-5555-4555-8555-555555555555";
const OPERATOR: &[&str] = &["admin:read", "admin:write"];

fn window(from: &str, to: &str) -> Json {
    Json::obj([("from", Json::str(from)), ("to", Json::str(to))])
}

fn cell(v: i64) -> Json {
    Json::obj([("value", Json::int(v)), ("reason", Json::Null)])
}

#[test]
fn operators_get_daily_counts_and_a_session_without_admin_read_is_refused() {
    let Some((db, store)) = setup() else { return };
    // `truncateAll` before each TypeScript test empties the recording start too.
    exec(&db, "DELETE FROM academy.metrics_recording");
    exec(
        &db,
        &format!(
            "INSERT INTO academy.cert_item_completions (user_id, item_slug, completed_at) VALUES
               ('{USER}', 'markets-reading-the-book', '2026-10-17T01:00:00Z'),
               ('{OTHER}', 'foundations-risk-first', '2026-10-17T02:00:00Z');
             INSERT INTO academy.cert_grants (user_id, cert_id, granted_at, idempotency_key) VALUES
               ('{USER}', 'foundations-v1', '2026-10-17T03:00:00Z', 'cert:{USER}:foundations-v1');
             INSERT INTO academy.learning_touches (user_id, client_request_id, item_slug, seconds_added, touched_at,
               last_item_slug, last_opened_at, seconds_read, active_days) VALUES
               ('{USER}', 'op-touch', 'markets-reading-the-book', 4, '2026-10-17T04:00:00Z',
                'markets-reading-the-book', '2026-10-17T04:00:00Z', 4, 1);
             INSERT INTO academy.cert_grants (user_id, cert_id, granted_at, idempotency_key) VALUES
               ('{OTHER}', 'foundations-v1', '2026-10-17T05:00:00Z', 'cert:{OTHER}:foundations-v1'),
               ('{USER}', 'other-cert', '2026-10-16T03:00:00Z', 'cert:{USER}:other-cert');"
        ),
    );
    let d = door(store, Json::obj([]));
    let metrics = data(&query(
        &d,
        USER,
        OPERATOR,
        "admin.opsMetrics",
        Some(&window("2026-10-17", "2026-10-18")),
    ));
    assert_eq!(
        get(&metrics, "days"),
        &Json::Array(vec![
            Json::obj([
                ("date", Json::str("2026-10-17")),
                ("lessonsRead", cell(1)),
                ("completions", cell(2)),
                ("grants", cell(2)),
            ]),
            Json::obj([
                ("date", Json::str("2026-10-18")),
                ("lessonsRead", cell(0)),
                ("completions", cell(0)),
                ("grants", cell(0)),
            ]),
        ])
    );
    let reader = &["academy:read", "academy:write"];
    let refused_as = |scopes: &[&str], w: Json| {
        refused(&query(&d, USER, scopes, "admin.opsMetrics", Some(&w))).0
    };
    assert_eq!(refused_as(reader, window("2026-10-17", "2026-10-17")), 403);
    assert_eq!(
        refused_as(OPERATOR, window("2026-10-18", "2026-10-17")),
        400
    );
    assert_eq!(
        refused_as(OPERATOR, window("2026-02-31", "2026-03-01")),
        400
    );
}

#[test]
fn completions_count_per_catalogue_item_apply_the_path_filter_and_refuse_an_unknown_path() {
    let Some((db, store)) = setup() else { return };
    exec(
        &db,
        &format!(
            "INSERT INTO academy.cert_item_completions (user_id, item_slug, completed_at) VALUES
               ('{USER}', 'foundations-risk-first', '2026-10-17T01:00:00Z'),
               ('{OTHER}', 'foundations-risk-first', '2026-10-17T02:00:00Z'),
               ('{THIRD}', 'foundations-risk-first', '2026-10-18T03:00:00Z'),
               ('{FOURTH}', 'foundations-risk-first', '2026-10-16T03:00:00Z'),
               ('{USER}', 'markets-reading-the-book', '2026-10-17T04:00:00Z'),
               ('{USER}', 'builder-first-automation', '2026-10-17T05:00:00Z'),
               ('{OTHER}', 'builder-first-automation', '2026-10-18T06:00:00Z'),
               ('{USER}', 'not-in-spine', '2026-10-17T07:00:00Z')"
        ),
    );
    let d = door(store, Json::obj([]));
    let all = data(&query(
        &d,
        USER,
        OPERATOR,
        "admin.completionsByItem",
        Some(&window("2026-10-17", "2026-10-18")),
    ));
    let by_slug = |list: &Json, slug: &str| {
        arr(list, "items")
            .iter()
            .find(|r| s(r, "itemSlug") == slug)
            .cloned()
    };
    let row = |slug: &str, path: Option<&str>, count: i64| {
        Json::obj([
            ("itemSlug", Json::str(slug)),
            ("pathSlug", path.map_or(Json::Null, Json::str)),
            ("count", Json::int(count)),
        ])
    };
    assert_eq!(
        by_slug(&all, "foundations-risk-first"),
        Some(row("foundations-risk-first", Some("foundations"), 3))
    );
    assert_eq!(
        by_slug(&all, "markets-reading-the-book"),
        Some(row("markets-reading-the-book", Some("markets"), 1))
    );
    assert_eq!(
        by_slug(&all, "builder-first-automation"),
        Some(row("builder-first-automation", Some("builder"), 2))
    );
    assert_eq!(
        by_slug(&all, "foundations-order-types"),
        Some(row("foundations-order-types", Some("foundations"), 0))
    );
    assert_eq!(
        by_slug(&all, "not-in-spine"),
        Some(row("not-in-spine", None, 1))
    );
    assert_eq!(get(&all, "pathSlug"), &Json::Null);

    let mut input = window("2026-10-17", "2026-10-18");
    if let Json::Object(fields) = &mut input {
        fields.push(("pathSlug".to_owned(), Json::str("markets")));
    }
    let markets = data(&query(
        &d,
        USER,
        OPERATOR,
        "admin.completionsByItem",
        Some(&input),
    ));
    assert_eq!(s(&markets, "pathSlug"), "markets");
    let mut market_slugs: Vec<String> = spine::list(Some("markets"), None)
        .iter()
        .map(|i| i.slug.clone())
        .collect();
    market_slugs.sort();
    let mut got: Vec<String> = arr(&markets, "items")
        .iter()
        .map(|r| s(r, "itemSlug"))
        .collect();
    got.sort();
    assert_eq!(got, market_slugs);
    assert_eq!(
        n(
            &by_slug(&markets, "markets-reading-the-book").unwrap(),
            "count"
        ),
        1
    );
    assert!(
        arr(&markets, "items")
            .iter()
            .filter(|r| s(r, "itemSlug") != "markets-reading-the-book")
            .all(|r| n(r, "count") == 0)
    );
    assert!(!arr(&markets, "items").iter().any(|r| {
        let slug = s(r, "itemSlug");
        slug == "foundations-risk-first" || slug == "not-in-spine"
    }));
    let body = format!("{}{}", all.compact(), markets.compact());
    for id in [USER, OTHER, THIRD, FOURTH] {
        assert!(!body.contains(id), "{id} leaked");
    }

    let mut unknown = window("2026-10-17", "2026-10-17");
    if let Json::Object(fields) = &mut unknown {
        fields.push(("pathSlug".to_owned(), Json::str("no-such")));
    }
    let (status, _, cause) = refused(&query(
        &d,
        USER,
        OPERATOR,
        "admin.completionsByItem",
        Some(&unknown),
    ));
    assert_eq!((status, cause.as_str()), (404, "academy.path_not_found"));
    let writer = &["academy:write"];
    let (status, _, _) = refused(&query(
        &d,
        USER,
        writer,
        "admin.completionsByItem",
        Some(&window("2026-10-17", "2026-10-17")),
    ));
    assert_eq!(status, 403);
}

/// `parseUtcDay` and `utcWindow`: what the console's range checks refuse, by name.
#[test]
fn the_utc_window_refuses_what_is_not_a_real_day_a_reversed_range_and_more_than_the_maximum() {
    assert_eq!(parse_utc_day("2026-10-17"), Some((2026, 10, 17)));
    assert_eq!(parse_utc_day("2024-02-29"), Some((2024, 2, 29)));
    for bad in [
        "2026-02-31",
        "2025-02-29",
        "2026-13-01",
        "2026-00-10",
        "2026-1-01",
        "2026/10/17",
        "0099-01-01",
        "2026-10-17T00:00:00Z",
        "",
    ] {
        assert_eq!(parse_utc_day(bad), None, "{bad}");
    }
    assert_eq!(
        code(utc_window("opsMetrics", "2026-10-18", "2026-10-17")),
        "academy.metrics_range_invalid"
    );
    assert_eq!(
        code(utc_window("opsMetrics", "2026-02-31", "2026-03-01")),
        "academy.metrics_range_invalid"
    );
    // 366 days is the most a window may span; one more refuses (the enrolments test's 2025-01-01 to 2026-01-02).
    assert!(utc_window("opsMetrics", "2025-01-01", "2026-01-01").is_ok());
    assert_eq!(MAX_DAYS, 366);
    assert_eq!(
        code(utc_window("opsMetrics", "2025-01-01", "2026-01-02")),
        "academy.metrics_range_invalid"
    );
    let w = utc_window("opsMetrics", "2026-10-17", "2026-10-18").unwrap();
    assert_eq!(w.start.iso(), "2026-10-17T00:00:00.000Z");
    assert_eq!(w.end_exclusive.iso(), "2026-10-19T00:00:00.000Z");
}
