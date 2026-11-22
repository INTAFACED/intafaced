//! The curriculum slice held to what the TypeScript router answered (`fixtures/curriculum.golden.json`, written by
//! `scripts/record-curriculum.mjs`): every curriculum call over a spread of inputs, and the item reads and the hub over
//! fifteen database states. The calls that never reach the service are asked over a database that is down, which
//! proves they read nothing from it; the item reads and the hub are asked over a real Postgres seeded with each
//! state's rows (`TEST_DATABASE_URL_ACADEMY` or `TEST_DATABASE_URL`; skipped without one unless `REQUIRE_POSTGRES=1`).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod support;

use std::collections::BTreeMap;

use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::server::Request;
use sha2::{Digest as _, Sha256};
use support::TestDb;
use svc_academy::curriculum::internal::{self, ServiceAuth};
use svc_academy::db::Store;
use svc_academy::door::{AcademyDoor, DoorConfig, system_now};
use svc_academy::ports::{Ports, StubApprovals};
use svc_academy::settings::Settings;

const GOLDEN: &str = include_str!("fixtures/curriculum.golden.json");
const SECRET: &str = "an-academy-curriculum-golden-edge-secret";
const INTERNAL_SECRET: &str = "an-academy-curriculum-golden-internal-secret";
const USER: &str = "11111111-1111-4111-8111-111111111111";
const ITEM: &str = "markets-reading-the-book";
const GRANT: &str = "33333333-3333-4333-8333-333333333333";

/// The calls that reach the service.
const ITEM_CALLS: [&str; 4] = [
    "curriculumItem",
    "curriculumItemLocalized",
    "publicCurriculumItem",
    "publicHub",
];

fn serve(store: Store) -> AcademyDoor {
    let env: BTreeMap<String, String> = [
        ("APP_ENV", "test"),
        ("INTAFACED_SCREENING_FAIL_CLOSED", "off"),
        ("NODE_ENV", "test"),
        ("INTAFACED_UNSIGNED_SANCTIONS_ROWS", "off"),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
    .collect();
    let mut ports = Ports::unwired();
    ports.approvals = Box::new(StubApprovals("replay-operator".to_owned()));
    ports.services = ServiceAuth::from_env(INTERNAL_SECRET, "", "off", None, None, None).unwrap();
    AcademyDoor::new(DoorConfig {
        edge_secret: SECRET.to_owned(),
        env,
        store,
        ports,
        settings: Settings::empty(),
        now: system_now,
    })
    .unwrap()
}

/// The recorder's caller: `academy:read`, no two-factor, signed for DE; or anonymous.
fn headers(scoped: bool) -> Vec<(String, String)> {
    let region = ("x-intafaced-region".to_owned(), "DE".to_owned());
    if !scoped {
        return vec![region];
    }
    let raw = Json::obj([
        ("sub", Json::str(USER)),
        ("scopes", Json::Array(vec![Json::str("academy:read")])),
        ("tier", Json::str("none")),
        ("mfa", Json::Bool(false)),
        ("sid", Json::str("22222222-2222-4222-8222-222222222222")),
        ("userId", Json::str(USER)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    let sig = edge::sign(&raw, SECRET, "DE").unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        region,
    ]
}

/// `encodeURIComponent`.
fn encode_uri_component(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// Replaces the value of every `"<key>":"..."` string with `<mask>`.
fn mask(body: &str, key: &str, mask: &str) -> String {
    let key = format!("\"{key}\":\"");
    let mut out = String::new();
    let mut rest = body;
    while let Some(at) = rest.find(&key) {
        out.push_str(&rest[..at + key.len()]);
        let after = &rest[at + key.len()..];
        let bytes = after.as_bytes();
        let mut end = 0;
        while end < bytes.len() && bytes[end] != b'"' {
            end += if bytes[end] == b'\\' { 2 } else { 1 };
        }
        out.push_str(mask);
        out.push('"');
        rest = &after[(end + 1).min(after.len())..];
    }
    out.push_str(rest);
    out
}

/// One `GET /trpc/<path>?input=...` as the recorder sends it: `<status> <body>`, masked as it masks.
fn hit(door: &AcademyDoor, path: &str, input: Option<&str>, scoped: bool) -> String {
    let headers = headers(scoped);
    let q = input
        .map(|i| format!("?input={}", encode_uri_component(i)))
        .unwrap_or_default();
    let url = format!("/trpc/{path}{q}");
    let res = door.handle(&Request {
        method: "GET",
        url: &url,
        headers: &headers,
        body: "",
    });
    let body = mask(&res.body, "stack", "<stack>");
    let body = mask(&body, "requestId", "<id>");
    let body = body.replace(
        &format!("\"path\":{}", Json::str(path).compact()),
        "\"path\":\"<path>\"",
    );
    format!("{} {body}", res.status)
}

struct Answer {
    scenario: String,
    path: String,
    scoped: bool,
    input: Option<String>,
    answer: Want,
}

/// What the golden holds of an answer: the text, or for a long one its SHA-256, UTF-8 byte count and opening.
enum Want {
    Text(String),
    Digest {
        sha256: String,
        bytes: usize,
        start: String,
    },
}

impl Want {
    fn matches(&self, got: &str) -> bool {
        match self {
            Want::Text(t) => t == got,
            Want::Digest { sha256, bytes, .. } => {
                let digest: String = Sha256::digest(got.as_bytes())
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect();
                got.len() == *bytes && digest == *sha256
            }
        }
    }
}

impl std::fmt::Display for Want {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Want::Text(t) => f.write_str(t),
            Want::Digest {
                sha256,
                bytes,
                start,
            } => write!(f, "{start}… ({bytes} bytes, sha256 {sha256})"),
        }
    }
}

fn golden() -> (Vec<Answer>, String, String) {
    let g = json::parse(GOLDEN).unwrap();
    let s = |v: &Json, k: &str| match v.get(k) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{k}: {other:?}"),
    };
    let Some(Json::Array(rows)) = g.get("answers") else {
        panic!("answers")
    };
    let answers = rows
        .iter()
        .map(|a| Answer {
            scenario: s(a, "scenario"),
            path: s(a, "path"),
            scoped: s(a, "caller") == "read",
            input: match a.get("input") {
                Some(Json::String(i)) => Some(i.clone()),
                _ => None,
            },
            answer: match a.get("answer") {
                Some(Json::String(t)) => Want::Text(t.clone()),
                _ => Want::Digest {
                    sha256: s(a, "answerSha256"),
                    bytes: match a.get("answerBytes") {
                        Some(Json::Number(n)) => n.to_string().parse().unwrap(),
                        other => panic!("answerBytes: {other:?}"),
                    },
                    start: s(a, "answerStart"),
                },
            },
        })
        .collect();
    let internal = g.get("internal").unwrap();
    (answers, s(internal, "ok"), s(internal, "refused"))
}

/// Each scenario's rows, as the recorder's stand-in database holds them for the one item asked.
fn seed(scenario: &str) -> String {
    let grant = |starts: &str, expires: &str, state: &str| {
        format!(
            "INSERT INTO academy.access_grants (id, user_id, path_slug, source, reason, starts_at, expires_at, state, created_at, updated_at) \
             VALUES ('{GRANT}', '{USER}', 'markets', 'staff', 'golden', '{starts}', {expires}, '{state}', '2020-01-01Z', '2020-01-01Z');"
        )
    };
    let window = |from: &str, until: &str, due: &str| {
        format!("INSERT INTO academy.item_windows VALUES ('{ITEM}', '{from}', '{until}', {due});")
    };
    let featured = |slug: &str| {
        format!(
            "INSERT INTO academy.featured_items (slot, item_slug, reason, chosen_by, chosen_at) VALUES ('hub', '{slug}', 'golden', '{USER}', '2020-01-01Z');"
        )
    };
    let prerequisite = format!(
        "INSERT INTO academy.item_prerequisites VALUES ('{ITEM}', 'foundations-risk-first');"
    );
    let lesson = |state: &str| {
        format!(
            "INSERT INTO academy.courses (id, slug, title, pricing, state, created_by, created_at, updated_at) \
               VALUES ('44444444-4444-4444-8444-444444444444', 'risk-basics', 'Risk basics', 'free', '{state}', '{USER}', '2020-01-01Z', '2020-01-01Z'); \
             INSERT INTO academy.course_sections (id, course_id, position, title) \
               VALUES ('55555555-5555-4555-8555-555555555555', '44444444-4444-4444-8444-444444444444', 1, 'Basics'); \
             INSERT INTO academy.course_items (id, course_id, section_id, position, kind, title, live_revision) \
               VALUES ('66666666-6666-4666-8666-666666666666', '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555', 1, 'lesson', 'Position size', 1); \
             INSERT INTO academy.lesson_revisions (item_id, revision, source, blocks, actor, at) \
               VALUES ('66666666-6666-4666-8666-666666666666', 1, 'saved', '[{{\"type\":\"text\"}}]', '{USER}', '2020-01-01Z'); \
             INSERT INTO academy.featured_items (slot, course_item_id, reason, chosen_by, chosen_at) \
               VALUES ('hub', '66666666-6666-4666-8666-666666666666', 'golden', '{USER}', '2020-01-01Z');"
        )
    };
    let start = |at: &str| {
        format!(
            "INSERT INTO academy.course_starts VALUES ('markets', '{at}', 'golden', '{USER}', '2020-01-01Z');"
        )
    };
    match scenario {
        "empty" => String::new(),
        "featured-item" => featured(ITEM),
        "featured-item-gated" => format!("{}{prerequisite}", featured(ITEM)),
        "featured-item-off-spine" => featured("gone-from-the-spine"),
        "lesson-published" => lesson("published"),
        "lesson-draft" => lesson("draft"),
        "prerequisite-met" => format!(
            "{prerequisite}INSERT INTO academy.cert_item_completions (user_id, item_slug) VALUES ('{USER}', 'foundations-risk-first');"
        ),
        "window-ahead" => window("2099-01-01Z", "2100-01-01Z", "NULL"),
        "window-open" => window("2020-01-01Z", "2099-01-01Z", "NULL"),
        "window-due-passed" => window("2020-01-01Z", "2099-01-01Z", "'2021-01-01Z'"),
        "course-starts-later" => start("2099-06-01Z"),
        "course-started" => start("2020-06-01Z"),
        "grant-revoked" => grant("2020-01-01Z", "NULL", "revoked"),
        "grant-ended" => grant("2020-01-01Z", "'2021-03-04T05:06:07.089Z'", "granted"),
        "grant-open" => grant("2020-01-01Z", "'2099-01-01Z'", "granted"),
        other => panic!("no seed for scenario {other}"),
    }
}

const TABLES: &str = "academy.access_grant_events, academy.access_grants, academy.item_windows, \
    academy.item_prerequisites, academy.cert_item_completions, academy.course_starts, academy.featured_items, \
    academy.lesson_revisions, academy.course_items, academy.course_sections, academy.courses";

#[test]
fn the_calls_that_never_reach_the_service_answer_as_the_typescript_did() {
    let (answers, _, _) = golden();
    let door = serve(Store::Down(
        "curriculum golden: the database is down".to_owned(),
    ));
    let mut asked = 0;
    let mut differ = Vec::new();
    for a in answers
        .iter()
        .filter(|a| !ITEM_CALLS.contains(&a.path.as_str()))
    {
        assert_eq!(
            a.scenario, "empty",
            "only the empty scenario asks {}",
            a.path
        );
        asked += 1;
        let got = hit(&door, &a.path, a.input.as_deref(), a.scoped);
        if !a.answer.matches(&got) {
            differ.push(format!(
                "{} {:?}\n  want {}\n  got  {got}",
                a.path, a.input, a.answer
            ));
        }
    }
    assert!(asked > 100, "the golden asks {asked} pure answers");
    assert!(
        differ.is_empty(),
        "{} of {asked} differ:\n{}",
        differ.len(),
        differ.join("\n")
    );
}

#[test]
fn the_item_reads_and_the_hub_answer_as_the_typescript_did_over_each_database_state() {
    let Some(db) = TestDb::migrated() else {
        eprintln!("skipped: no TEST_DATABASE_URL");
        return;
    };
    let (answers, _, _) = golden();
    let pool = db.pool();
    let door = serve(Store::Pool(pool));
    let mut scenarios: Vec<&str> = answers.iter().map(|a| a.scenario.as_str()).collect();
    scenarios.dedup();
    let mut asked = 0;
    let mut differ = Vec::new();
    for scenario in &scenarios {
        db.client()
            .batch_execute(&format!(
                "BEGIN; TRUNCATE {TABLES} CASCADE; {} COMMIT;",
                seed(scenario)
            ))
            .unwrap();
        for a in answers
            .iter()
            .filter(|a| a.scenario == *scenario && ITEM_CALLS.contains(&a.path.as_str()))
        {
            asked += 1;
            let got = hit(&door, &a.path, a.input.as_deref(), a.scoped);
            if !a.answer.matches(&got) {
                differ.push(format!(
                    "{scenario}: {} {:?}\n  want {}\n  got  {got}",
                    a.path, a.input, a.answer
                ));
            }
        }
    }
    assert_eq!(scenarios.len(), 15);
    assert!(asked >= 14 * 4 + 4, "asked {asked}");
    assert!(
        differ.is_empty(),
        "{} of {asked} differ:\n{}",
        differ.len(),
        differ.join("\n")
    );
}

#[test]
fn the_internal_route_answers_as_the_typescript_did() {
    let (_, ok, refused) = golden();
    let door = serve(Store::Down("down".to_owned()));
    let signed = support::legacy_headers("svc-agents", INTERNAL_SECRET, "");
    for (headers, want) in [(signed, ok), (Vec::new(), refused)] {
        let res = door.handle(&Request {
            method: "GET",
            url: internal::PATH,
            headers: &headers,
            body: "",
        });
        assert_eq!(format!("{} {}", res.status, res.body), want);
    }
}
