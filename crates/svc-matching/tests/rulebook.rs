//! The `rulebook` slice, test for test against the TypeScript:
//!
//! - `rulebook.router.test.ts`: every test, through the door, with the stub identity counting what it consumes.
//! - `engine/rulebook-refuse.test.ts`: its gates (operator and evidence before an emergency action, operator and owner
//!   policy before a delisting). The engine calls they guard (halt, resume, the venue halt, expiry, delisting) are the
//!   `venue` slice's, and its tests run them there; `listMarket`'s permissionless refusal is not ported: nothing calls
//!   it.
//! - `rulebook-version-compose-pin.test.ts`: the crate reads no rulebook version from its environment.
//!
//! Not ported, and why: `rulebook.test.ts` and `engine/cert-refuse.test.ts` test helpers nothing calls
//! (`readRulebook`, `presentRulebook`, the best-execution, certified-venue, certified and testnet-parity claims);
//! `rulebook-doors.router.test.ts` tests the `venue` and `operator` slices' doors.
//!
//! Beside them, the approval a door spends (`consumeVenueKill`): each refusal, in the TypeScript's order.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::cell::Cell;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use service_kit::approvals::{ConsumeInput, Consumed};
use service_kit::edge;
use service_kit::json::{self, Json};
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::{Instant, v8_date_parse};
use svc_matching::approval::{self, Approvals, Denied, Refused, Spend, Stub, Unwired};
use svc_matching::door::{DoorConfig, MatchingDoor, Outcome};
use svc_matching::engine::{EngineParts, MatchingEngine, MemoryEventBus};
use svc_matching::journal::io::{EngineJournal, FileJournal, MemoryJournal};
use svc_matching::journal::replay::MemorySnapshotSink;
use svc_matching::rulebook::refuse::{self, Cmd};
use svc_matching::rulebook::{
    RULEBOOK_IMMUTABLE, RULEBOOK_SECTION_UNSET, RULEBOOK_SECTIONS, RULEBOOK_UNPUBLISHED,
};

const SECRET: &str = "matching-rulebook-router-secret-32ch!!";
const EDGE_SECRET: &str = "edge-principal-secret-at-least-32-characters";
const REGION: &str = "XX";
const OPERATOR: &str = "11111111-1111-4111-8111-111111111111";
const CONFIRM: &str = "44444444-4444-4444-8444-444444444444";
const DAY: i64 = 86_400_000;

thread_local! {
    /// The engine's clock: each test runs on its own thread, and moves its own time.
    static NOW: Cell<i64> = Cell::new(v8_date_parse("2026-11-06T12:00:00.000Z").unwrap());
}

fn now() -> i64 {
    NOW.with(Cell::get)
}

fn advance(ms: i64) {
    NOW.with(|n| n.set(n.get() + ms));
}

/// `counting(stubApprovalConsumer(approver, OPERATOR))`.
struct Counting {
    inner: Stub,
    calls: Arc<AtomicUsize>,
}

impl Approvals for Counting {
    fn consume(&self, input: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.inner.consume(input)
    }
}

struct Mounted {
    door: MatchingDoor,
    calls: Arc<AtomicUsize>,
}

impl Mounted {
    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    fn journal_len(&self) -> usize {
        self.door.engine().journal().len()
    }

    fn records(&self) -> Vec<svc_matching::journal::record::JournalRecord> {
        self.door.engine().journal().read().to_vec()
    }
}

fn mount_on(journal: Box<dyn EngineJournal + Send>, approver: &str) -> Mounted {
    let mut engine = MatchingEngine::new(EngineParts {
        journal,
        bus: Box::new(MemoryEventBus::default()),
        clock: now,
        expiry_clock: true,
        snapshot_every: 0,
        sink: Box::new(MemorySnapshotSink::default()),
        enabled: true,
    });
    engine.recover().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let door = MatchingDoor::new(
        DoorConfig {
            internal_secret: SECRET.to_owned(),
            body_bind: BodyBind::Require,
            keys: None,
            edge_secret: Some(EDGE_SECRET.to_owned()),
            edge_key: None,
            clock: now,
            approvals: Box::new(Counting {
                inner: Stub {
                    approver_id: approver.to_owned(),
                    requester_id: OPERATOR.to_owned(),
                },
                calls: calls.clone(),
            }),
            operator_ids: vec![OPERATOR.to_owned(), CONFIRM.to_owned()],
        },
        engine,
    )
    .unwrap();
    Mounted { door, calls }
}

fn mount() -> Mounted {
    mount_on(Box::new(MemoryJournal::new()), CONFIRM)
}

fn edge_headers() -> Vec<(String, String)> {
    let raw = Json::obj([
        ("sub", Json::str(OPERATOR)),
        (
            "scopes",
            Json::Array(vec![Json::str("admin:write"), Json::str("admin:read")]),
        ),
        ("tier", Json::str("institutional")),
        ("mfa", Json::Bool(true)),
        ("sid", Json::str("22222222-2222-4222-8222-222222222222")),
        ("userId", Json::str(OPERATOR)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    let sig = edge::sign(&raw, EDGE_SECRET, REGION).unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), REGION.to_owned()),
    ]
}

/// The status and the body read back.
fn send(
    m: &Mounted,
    method: &str,
    url: &str,
    headers: Vec<(String, String)>,
    body: Option<&Json>,
) -> (u16, Json) {
    let payload = body.map(Json::compact).unwrap_or_default();
    let mut headers = headers;
    if body.is_some() {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
    }
    match m.door.decide(&Request {
        method,
        url,
        headers: &headers,
        body: &payload,
    }) {
        Outcome::Answer(r) => (r.status, json::parse(&r.body).unwrap()),
        Outcome::Owed(slice) => panic!("{method} {url} is owed by {}", slice.name()),
    }
}

fn get(m: &Mounted, url: &str) -> Json {
    let (status, body) = send(m, "GET", url, Vec::new(), None);
    assert_eq!(status, 200);
    body
}

fn sections(tag: &str, skip: Option<&str>) -> Vec<(String, Json)> {
    RULEBOOK_SECTIONS
        .iter()
        .filter(|(id, _)| Some(*id) != skip)
        .map(|(id, title)| {
            (
                (*id).to_owned(),
                Json::str(format!("TEST {title} rules for {tag}.")),
            )
        })
        .collect()
}

fn with(mut s: Vec<(String, Json)>, id: &str, body: &str) -> Vec<(String, Json)> {
    for (k, v) in &mut s {
        if k == id {
            *v = Json::str(body);
        }
    }
    s
}

/// A body: its fields in order.
fn body(fields: Vec<(&str, Json)>) -> Json {
    Json::Object(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

fn draft(version: &str, s: Vec<(String, Json)>) -> Vec<(&'static str, Json)> {
    vec![
        ("version", Json::str(version)),
        ("sections", Json::Object(s)),
    ]
}

/// `publish(app, body)`: `{ approvalId: 'appr-1', operationId: 'op-1', ...body }`.
fn publish(m: &Mounted, fields: Vec<(&'static str, Json)>) -> (u16, Json) {
    let mut all: Vec<(&str, Json)> = vec![
        ("approvalId", Json::str("appr-1")),
        ("operationId", Json::str("op-1")),
    ];
    for (k, v) in fields {
        match all.iter_mut().find(|(key, _)| *key == k) {
            Some((_, slot)) => *slot = v,
            None => all.push((k, v)),
        }
    }
    send(
        m,
        "POST",
        "/operator/rulebook/publish",
        edge_headers(),
        Some(&body(all)),
    )
}

fn check(m: &Mounted, fields: Vec<(&'static str, Json)>) -> Json {
    let (status, b) = send(
        m,
        "POST",
        "/operator/rulebook/check",
        edge_headers(),
        Some(&body(fields)),
    );
    assert_eq!(status, 200);
    b
}

fn s<'a>(j: &'a Json, k: &str) -> &'a Json {
    j.get(k).unwrap_or_else(|| panic!("{k} in {}", j.compact()))
}

fn code(j: &Json) -> String {
    match s(s(j, "rejected"), "code") {
        Json::String(c) => c.clone(),
        other => panic!("{other:?}"),
    }
}

fn text(j: &Json, k: &str) -> String {
    match s(j, k) {
        Json::String(c) => c.clone(),
        other => panic!("{k}: {other:?}"),
    }
}

// GET /rulebook

#[test]
fn no_versions_unpublished_with_its_code_and_no_text_and_no_auth_needed() {
    let m = mount();
    assert_eq!(
        get(&m, "/rulebook").compact(),
        format!(
            r#"{{"published":false,"version":null,"rejected":{{"code":"{RULEBOOK_UNPUBLISHED}","message":"{RULEBOOK_UNPUBLISHED}"}},"upcoming":[]}}"#
        )
    );
    assert_eq!(
        get(&m, "/rulebook/versions").compact(),
        r#"{"current":null,"versions":[]}"#
    );
}

#[test]
fn the_crate_reads_no_rulebook_version_from_its_environment_the_journal_is_the_only_source() {
    for (name, source) in [
        ("env.rs", include_str!("../src/env.rs")),
        ("door/mod.rs", include_str!("../src/door/mod.rs")),
        ("door/rulebook.rs", include_str!("../src/door/rulebook.rs")),
        ("rulebook/mod.rs", include_str!("../src/rulebook/mod.rs")),
        ("engine/mod.rs", include_str!("../src/engine/mod.rs")),
    ] {
        assert!(
            !source.contains(&["MATCHING", "RULEBOOK", "VERSION"].join("_")),
            "{name} names the rulebook version variable"
        );
    }
}

// POST /operator/rulebook/check and /publish

#[test]
fn six_of_seven_sections_check_and_publish_refuse_and_no_approval_is_spent() {
    let m = mount();
    let c = check(
        &m,
        draft("TEST-v1", sections("TEST-v1", Some("market_data"))),
    );
    assert_eq!(s(&c, "accepted"), &Json::Bool(false));
    assert_eq!(code(&c), RULEBOOK_SECTION_UNSET);
    assert!(text(s(&c, "rejected"), "message").contains("market data"));
    let (_, p) = publish(&m, draft("TEST-v1", sections("TEST-v1", Some("fees"))));
    assert_eq!(s(&p, "accepted"), &Json::Bool(false));
    assert_eq!(code(&p), RULEBOOK_SECTION_UNSET);
    assert_eq!(m.calls(), 0);
    assert_eq!(m.journal_len(), 0);
}

#[test]
fn a_whole_draft_checks_to_the_exact_approval_target_and_payload_hash_publish_recomputes() {
    let m = mount();
    let c = check(&m, draft("TEST-v1", sections("TEST-v1", None)));
    assert_eq!(s(&c, "accepted"), &Json::Bool(true));
    assert_eq!(text(&c, "version"), "TEST-v1");
    assert_eq!(text(&c, "actionType"), "matching.rulebook_publish");
    assert_eq!(text(&c, "targetId"), "rulebook_publish:TEST-v1");
    let digest = text(&c, "digest");
    assert_eq!(
        text(&c, "payloadHash"),
        approval::action_payload_hash(
            "matching.rulebook_publish",
            &[("version", "TEST-v1"), ("digest", &digest)]
        )
    );
}

#[test]
fn refuses_without_the_edge_principal() {
    let m = mount();
    let (status, _) = send(
        &m,
        "POST",
        "/operator/rulebook/publish",
        Vec::new(),
        Some(&body(draft("TEST-v1", sections("TEST-v1", None)))),
    );
    assert_eq!(status, 401);
}

#[test]
fn the_same_person_as_approver_refuses_and_publishes_nothing() {
    let m = mount_on(Box::new(MemoryJournal::new()), OPERATOR);
    let (status, p) = publish(&m, draft("TEST-v1", sections("TEST-v1", None)));
    assert_eq!(status, 400);
    assert_eq!(text(&p, "code"), "action_approval.missing");
    assert_eq!(m.journal_len(), 0);
    assert_eq!(s(&get(&m, "/rulebook"), "published"), &Json::Bool(false));
}

#[test]
fn v1_now_and_v2_next_week_then_after_the_date_v2_is_current_and_v1_in_history() {
    let m = mount();
    let (_, v1) = publish(&m, draft("TEST-v1", sections("TEST-v1", None)));
    assert_eq!(s(&v1, "accepted"), &Json::Bool(true));
    assert_eq!(text(&v1, "version"), "TEST-v1");
    assert_eq!(s(&v1, "alreadyPublished"), &Json::Bool(false));
    assert_eq!(text(&v1, "operatorId"), OPERATOR);
    assert_eq!(text(&v1, "confirmOperatorId"), CONFIRM);
    let next_week = Instant(now() + 7 * DAY).iso();
    let mut v2_fields = draft(
        "TEST-v2",
        with(
            sections("TEST-v1", None),
            "fees",
            "TEST fees rules for TEST-v2.",
        ),
    );
    v2_fields.extend([
        ("effectiveAt", Json::str(next_week.clone())),
        ("approvalId", Json::str("appr-2")),
        ("operationId", Json::str("op-2")),
    ]);
    let (_, v2) = publish(&m, v2_fields);
    assert_eq!(s(&v2, "accepted"), &Json::Bool(true));
    assert_eq!(text(&v2, "version"), "TEST-v2");

    let read = get(&m, "/rulebook");
    assert_eq!(s(&read, "published"), &Json::Bool(true));
    assert_eq!(text(&read, "version"), "TEST-v1");
    assert_eq!(
        s(&read, "upcoming").compact(),
        format!(r#"[{{"version":"TEST-v2","effectiveAt":"{next_week}"}}]"#)
    );
    let Json::Array(secs) = s(&read, "sections") else {
        panic!()
    };
    let titles: Vec<String> = secs.iter().map(|x| text(x, "title")).collect();
    let want: Vec<String> = RULEBOOK_SECTIONS
        .iter()
        .map(|(_, t)| (*t).to_owned())
        .collect();
    assert_eq!(titles, want);
    assert_eq!(
        text(&secs[0], "body"),
        "TEST participation rules for TEST-v1."
    );

    advance(8 * DAY);
    let read = get(&m, "/rulebook");
    assert_eq!(text(&read, "version"), "TEST-v2");
    assert_eq!(text(&read, "effectiveAt"), next_week);
    assert_eq!(s(&read, "upcoming").compact(), "[]");
    let history = get(&m, "/rulebook/versions");
    assert_eq!(text(&history, "current"), "TEST-v2");
    let Json::Array(versions) = s(&history, "versions") else {
        panic!()
    };
    let rows: Vec<(String, String)> = versions
        .iter()
        .map(|v| (text(v, "version"), text(v, "status")))
        .collect();
    assert_eq!(
        rows,
        [("TEST-v2", "current"), ("TEST-v1", "superseded")]
            .map(|(a, b)| (a.to_owned(), b.to_owned()))
    );
    assert_eq!(text(&versions[0], "supersedes"), "TEST-v1");
    assert_eq!(s(&versions[0], "changedSections").compact(), r#"["fees"]"#);
    let Json::Array(changed) = s(&versions[1], "changedSections") else {
        panic!()
    };
    assert_eq!(changed.len(), 7);
}

#[test]
fn an_edit_of_a_published_version_refuses_before_any_approval_is_spent_and_a_retry_returns_the_first()
 {
    let m = mount();
    publish(&m, draft("TEST-v1", sections("TEST-v1", None)));
    assert_eq!(m.calls(), 1);
    let changed = with(sections("TEST-v1", None), "matching", "TEST changed.");
    let mut edit = draft("TEST-v1", changed.clone());
    edit.push(("approvalId", Json::str("appr-2")));
    let (_, e) = publish(&m, edit);
    assert_eq!(s(&e, "accepted"), &Json::Bool(false));
    assert_eq!(code(&e), RULEBOOK_IMMUTABLE);
    let c = check(&m, draft("TEST-v1", changed));
    assert_eq!(code(&c), RULEBOOK_IMMUTABLE);
    // The same text again needs no new request either: check refuses it rather than file a no-op approval.
    let same = check(&m, draft("TEST-v1", sections("TEST-v1", None)));
    assert_eq!(s(&same, "accepted"), &Json::Bool(false));
    assert_eq!(code(&same), RULEBOOK_IMMUTABLE);
    let (_, retry) = publish(&m, draft("TEST-v1", sections("TEST-v1", None)));
    assert_eq!(s(&retry, "accepted"), &Json::Bool(true));
    assert_eq!(s(&retry, "alreadyPublished"), &Json::Bool(true));
    assert_eq!(m.calls(), 1);
    assert_eq!(m.journal_len(), 1);
}

#[test]
fn refuses_an_effective_time_before_publish_or_one_with_no_zone_before_any_approval_is_spent() {
    let m = mount();
    let mut past = draft("TEST-v1", sections("TEST-v1", None));
    past.push(("effectiveAt", Json::str(Instant(now() - DAY).iso())));
    let (_, p) = publish(&m, past);
    assert_eq!(s(&p, "accepted"), &Json::Bool(false));
    assert_eq!(code(&p), "matching.rulebook_effective_invalid");
    let mut no_zone = draft("TEST-v1", sections("TEST-v1", None));
    no_zone.push(("effectiveAt", Json::str("2026-12-01T00:00:00")));
    let (_, z) = publish(&m, no_zone);
    assert_eq!(s(&z, "accepted"), &Json::Bool(false));
    assert_eq!(code(&z), "matching.rulebook_effective_invalid");
    assert_eq!(m.calls(), 0);
    assert_eq!(m.journal_len(), 0);
}

#[test]
fn a_later_publish_replaces_an_earlier_scheduled_one_and_the_schedule_never_takes_effect() {
    let m = mount();
    publish(&m, draft("TEST-v1", sections("TEST-v1", None)));
    let next_week = Instant(now() + 7 * DAY).iso();
    let mut v2 = draft(
        "TEST-v2",
        with(sections("TEST-v1", None), "fees", "TEST v2 fees."),
    );
    v2.push(("effectiveAt", Json::str(next_week)));
    publish(&m, v2);
    // A correction published now replaces both: v2's date arriving must not bring v2 back.
    let v3 = with(
        with(sections("TEST-v1", None), "fees", "TEST v2 fees."),
        "matching",
        "TEST v3 matching.",
    );
    publish(&m, draft("TEST-v3", v3));
    let history = get(&m, "/rulebook/versions");
    let Json::Array(versions) = s(&history, "versions") else {
        panic!()
    };
    assert_eq!(text(&versions[0], "version"), "TEST-v3");
    assert_eq!(text(&versions[0], "status"), "current");
    assert_eq!(text(&versions[0], "supersedes"), "TEST-v2");
    assert_eq!(
        s(&versions[0], "changedSections").compact(),
        r#"["matching"]"#
    );
    assert_eq!(text(&versions[1], "version"), "TEST-v2");
    assert_eq!(text(&versions[1], "status"), "superseded");
    advance(8 * DAY);
    let read = get(&m, "/rulebook");
    assert_eq!(text(&read, "version"), "TEST-v3");
    assert_eq!(s(&read, "upcoming").compact(), "[]");
    assert_eq!(text(&get(&m, "/rulebook/versions"), "current"), "TEST-v3");
}

#[test]
fn survives_a_restart_versions_are_rebuilt_from_the_journal() {
    let first = mount();
    publish(&first, draft("TEST-v1", sections("TEST-v1", None)));
    let mut journal = MemoryJournal::new();
    for r in first.records() {
        let Json::Object(mut fields) = r.0 else {
            panic!()
        };
        fields.retain(|(k, _)| k != "seq");
        journal
            .append(&svc_matching::journal::record::JournalCommand(
                Json::Object(fields),
            ))
            .unwrap();
    }
    let second = mount_on(Box::new(journal), CONFIRM);
    let read = get(&second, "/rulebook");
    assert_eq!(s(&read, "published"), &Json::Bool(true));
    assert_eq!(text(&read, "version"), "TEST-v1");
    let Json::Array(secs) = s(&read, "sections") else {
        panic!()
    };
    assert_eq!(
        secs[6].compact(),
        r#"{"id":"market_data","title":"market data","body":"TEST market data rules for TEST-v1."}"#
    );
}

#[test]
fn survives_a_restart_on_the_file_journal_the_record_decodes_back_to_the_same_text() {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("rulebook-journal-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("engine_journal.ndjson");
    {
        let first = mount_on(Box::new(FileJournal::open(&path).unwrap()), CONFIRM);
        publish(&first, draft("TEST-v1", sections("TEST-v1", None)));
    }
    let second = mount_on(Box::new(FileJournal::open(&path).unwrap()), CONFIRM);
    let read = get(&second, "/rulebook");
    assert_eq!(text(&read, "version"), "TEST-v1");
    let Json::Array(secs) = s(&read, "sections") else {
        panic!()
    };
    let bodies: Vec<String> = secs.iter().map(|x| text(x, "body")).collect();
    let want: Vec<String> = sections("TEST-v1", None)
        .into_iter()
        .map(|(_, v)| match v {
            Json::String(t) => t,
            _ => unreachable!(),
        })
        .collect();
    assert_eq!(bodies, want);
    drop(second);
    std::fs::remove_dir_all(&dir).unwrap();
}

// engine/rulebook-refuse.test.ts: the gates

fn cmd(operator: Option<&str>) -> Cmd {
    Cmd {
        operator_id: operator.map(str::to_owned),
        ..Cmd::default()
    }
}

fn blank_refs() -> Vec<Json> {
    vec![
        Json::str(""),
        Json::str("   "),
        Json::str("\t"),
        Json::str("\n"),
        Json::Null,
    ]
}

#[test]
fn an_emergency_action_without_evidence_refuses_with_its_words() {
    let refused = refuse::emergency_gate(&cmd(Some("ops-1"))).unwrap_err();
    assert_eq!(refused.operator_id.as_deref(), Some("ops-1"));
    assert_eq!(refused.rejected.code, refuse::MISSING_EVIDENCE);
    assert_eq!(
        refused.rejected.message,
        "emergency action requires authority and evidence; the engine does not invent evidence"
    );
}

#[test]
fn an_emergency_action_with_an_operator_and_evidence_or_an_evidence_ref_passes() {
    let with_evidence = Cmd {
        evidence: Some("incident-42".to_owned()),
        ..cmd(Some("ops-1"))
    };
    assert_eq!(refuse::emergency_gate(&with_evidence).unwrap(), "ops-1");
    let with_ref = Cmd {
        evidence_refs: Some(vec![Json::str("ref-1")]),
        ..cmd(Some("ops-2"))
    };
    assert_eq!(refuse::emergency_gate(&with_ref).unwrap(), "ops-2");
}

#[test]
fn a_delisting_without_a_policy_refuses_and_with_a_policy_id_or_version_passes() {
    let refused = refuse::delist_gate(&cmd(Some("ops-1"))).unwrap_err();
    assert_eq!(refused.rejected.code, refuse::DELIST_POLICY_MISSING);
    assert_eq!(
        refused.rejected.message,
        "delist requires an owner policy; the engine does not invent a corporate action"
    );
    let with_id = Cmd {
        policy_id: Some("policy-7".to_owned()),
        ..cmd(Some("ops-1"))
    };
    assert_eq!(refuse::delist_gate(&with_id).unwrap(), "ops-1");
    let with_version = Cmd {
        policy_version: Some("v7".to_owned()),
        ..cmd(Some("ops-1"))
    };
    assert!(refuse::delist_gate(&with_version).is_ok());
}

#[test]
fn blank_evidence_and_blank_evidence_refs_are_not_evidence_and_one_padded_ref_is() {
    let blank = Cmd {
        evidence: Some("   ".to_owned()),
        evidence_refs: Some(blank_refs()),
        ..cmd(Some("ops-1"))
    };
    assert_eq!(
        refuse::emergency_gate(&blank).unwrap_err().rejected.code,
        refuse::MISSING_EVIDENCE
    );
    let padded = Cmd {
        evidence_refs: Some(vec![
            Json::str(""),
            Json::str("  venue-ticket  "),
            Json::Null,
        ]),
        ..cmd(Some("ops-1"))
    };
    assert!(refuse::emergency_gate(&padded).is_ok());
    // A ref that is not a string is not evidence.
    let numeric = Cmd {
        evidence_refs: Some(vec![Json::int(7), Json::Bool(true)]),
        ..cmd(Some("ops-1"))
    };
    assert!(refuse::emergency_gate(&numeric).is_err());
}

#[test]
fn a_missing_or_blank_operator_is_missing_operator_before_the_evidence_or_the_policy() {
    for operator in [None, Some("   ")] {
        let halt = Cmd {
            evidence: Some("incident-42".to_owned()),
            ..cmd(operator)
        };
        let refused = refuse::emergency_gate(&halt).unwrap_err();
        assert_eq!(refused.rejected.code, "missing_operator");
        assert_eq!(refused.operator_id, None);
        let delist = Cmd {
            policy_id: Some("policy-7".to_owned()),
            ..cmd(operator)
        };
        assert_eq!(
            refuse::delist_gate(&delist).unwrap_err().rejected.code,
            "missing_operator"
        );
    }
}

// The approval a door spends (`consumeVenueKill`)

struct Answer(Result<Consumed, Refused>);

impl Approvals for Answer {
    fn consume(&self, _: &ConsumeInput<'_>) -> Result<Consumed, Refused> {
        self.0.clone()
    }
}

fn consumed(action: &str, target: &str, requester: &str, approver: Option<&str>) -> Consumed {
    Consumed {
        action_type: action.to_owned(),
        target_service: "svc-matching".to_owned(),
        target_id: target.to_owned(),
        status: "CONSUMED".to_owned(),
        requester_id: requester.to_owned(),
        approver_id: approver.map(str::to_owned),
        approver_is_founder: Some(true),
        requester_is_founder: Some(true),
    }
}

fn operators() -> Vec<String> {
    vec![OPERATOR.to_owned(), CONFIRM.to_owned()]
}

fn spend_with(
    approvals: &dyn Approvals,
    operator_ids: &[String],
    operator: Option<&str>,
) -> Result<approval::Authorized, Denied> {
    approval::spend(
        approvals,
        operator_ids,
        &Spend {
            operator_id: operator,
            confirm_typed: None,
            approval_id: Some(" appr-1 "),
            operation_id: Some("op-1"),
            action_type: "matching.rulebook_publish",
            fields: &[("version", "TEST-v1"), ("digest", "sha256:x")],
            target_id: "rulebook_publish:TEST-v1",
        },
    )
}

fn bad_code(r: Result<approval::Authorized, Denied>) -> String {
    match r {
        Err(Denied::Bad { code, .. }) => code,
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_consumed_two_person_approval_names_both_people_and_its_evidence() {
    let stub = Stub {
        approver_id: CONFIRM.to_owned(),
        requester_id: OPERATOR.to_owned(),
    };
    let ok = spend_with(&stub, &operators(), Some(OPERATOR)).unwrap();
    assert_eq!(ok.operator_id, OPERATOR);
    assert_eq!(ok.confirm_operator_id, CONFIRM);
    assert_eq!(ok.evidence_refs, vec!["action-approval:appr-1".to_owned()]);
}

#[test]
fn each_refusal_of_the_approval_in_the_typescripts_order() {
    let good = consumed(
        "matching.rulebook_publish",
        "rulebook_publish:TEST-v1",
        OPERATOR,
        Some(CONFIRM),
    );
    // No operator: 200, refused, nothing consumed.
    assert!(matches!(
        spend_with(&Answer(Ok(good.clone())), &operators(), Some("  ")),
        Err(Denied::Refused { .. })
    ));
    // No approval ids.
    let no_ids = approval::spend(
        &Answer(Ok(good.clone())),
        &operators(),
        &Spend {
            operator_id: Some(OPERATOR),
            confirm_typed: None,
            approval_id: Some(" "),
            operation_id: None,
            action_type: "matching.rulebook_publish",
            fields: &[],
            target_id: "rulebook_publish:TEST-v1",
        },
    );
    assert_eq!(bad_code(no_ids), approval::MISSING);
    assert_eq!(
        bad_code(spend_with(&Answer(Ok(good.clone())), &[], Some(OPERATOR))),
        approval::OPERATORS_UNSET
    );
    assert_eq!(
        bad_code(spend_with(
            &Answer(Ok(good.clone())),
            &operators(),
            Some("someone-else")
        )),
        approval::NOT_OPERATOR
    );
    assert_eq!(
        bad_code(spend_with(&Unwired, &operators(), Some(OPERATOR))),
        approval::UNWIRED
    );
    assert!(matches!(
        spend_with(&Answer(Err(Refused::Thrown("fetch failed".to_owned()))), &operators(), Some(OPERATOR)),
        Err(Denied::Thrown(m)) if m == "fetch failed"
    ));
    let other_action = consumed(
        "matching.halt",
        "rulebook_publish:TEST-v1",
        OPERATOR,
        Some(CONFIRM),
    );
    assert_eq!(
        bad_code(spend_with(
            &Answer(Ok(other_action)),
            &operators(),
            Some(OPERATOR)
        )),
        approval::WRONG_ACTION
    );
    let asked_by_other = consumed(
        "matching.rulebook_publish",
        "rulebook_publish:TEST-v1",
        CONFIRM,
        Some(OPERATOR),
    );
    assert_eq!(
        bad_code(spend_with(
            &Answer(Ok(asked_by_other)),
            &operators(),
            Some(OPERATOR)
        )),
        approval::OPERATOR_MISMATCH
    );
    let alone = consumed(
        "matching.rulebook_publish",
        "rulebook_publish:TEST-v1",
        OPERATOR,
        Some(&OPERATOR.to_uppercase()),
    );
    assert_eq!(
        bad_code(spend_with(&Answer(Ok(alone)), &operators(), Some(OPERATOR))),
        approval::MISSING
    );
    let unlisted = consumed(
        "matching.rulebook_publish",
        "rulebook_publish:TEST-v1",
        OPERATOR,
        Some("outsider"),
    );
    assert_eq!(
        bad_code(spend_with(
            &Answer(Ok(unlisted)),
            &operators(),
            Some(OPERATOR)
        )),
        approval::NOT_OPERATOR
    );
    let mut unattested = good.clone();
    unattested.approver_is_founder = None;
    unattested.requester_is_founder = None;
    assert_eq!(
        bad_code(spend_with(
            &Answer(Ok(unattested)),
            &operators(),
            Some(OPERATOR)
        )),
        approval::NOT_FOUNDERS
    );
    let mut one_founder = good;
    one_founder.requester_is_founder = Some(false);
    assert_eq!(
        bad_code(spend_with(
            &Answer(Ok(one_founder)),
            &operators(),
            Some(OPERATOR)
        )),
        approval::NOT_FOUNDERS
    );
}

#[test]
fn a_door_answers_a_refused_approval_as_the_typescript_does_and_publishes_nothing() {
    let m = mount_on(Box::new(MemoryJournal::new()), "outsider");
    let (status, b) = publish(&m, draft("TEST-v1", sections("TEST-v1", None)));
    assert_eq!(status, 400);
    assert_eq!(
        b.compact(),
        r#"{"code":"action_approval.not_operator","message":"both the proposer and the approver must be operators of this venue"}"#
    );
    assert_eq!(m.journal_len(), 0);
}
