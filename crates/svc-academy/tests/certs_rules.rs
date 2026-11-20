//! The certificate rules held to the TypeScript tests that pin them, file for file (`services/svc-academy/src/certs/`):
//! `catalog-paths`, `catalog-spine`, `cert-paths`, `progress`, `grant-ledger`, `perk-plane`, `perk-money-isolation`,
//! `xp-policy`, `xp-emit` and `xp-publish`. None of them reads a database; `cert-paths` is asked over a store that is
//! down, which proves it reads nothing. The `L3` export, status-line and board-card helpers those files also test, and
//! `MemoryCertStore`, are unreachable from the service (port map 6.3) and are not ported; a grant is written as the
//! record the store would have returned.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeSet;
use std::sync::Mutex;

use service_kit::json::Json;
use service_kit::time::Instant;
use svc_academy::certs::catalog::{self, CertDefinition};
use svc_academy::certs::honesty;
use svc_academy::certs::perks;
use svc_academy::certs::progress::{self, Binding, Completion, Grant};
use svc_academy::certs::service::Certs;
use svc_academy::certs::xp::{self, BusPublisher, Emit, Publisher, Skip};
use svc_academy::curriculum::spine;
use svc_academy::db::Store;
use svc_academy::errors::Refusal;
use svc_academy::ports::{Bus, HostRights, NoBus};

const USER: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";
/// 2026-08-07T12:00:00.000Z and 2026-08-09T09:30:00.000Z.
const NOW: i64 = 1_786_104_000_000;
const LATER: i64 = 1_786_267_800_000;

const LESSONS: [&str; 7] = [
    "foundations-risk-first",
    "foundations-order-types",
    "foundations-paper-workbook",
    "foundations-position-sizing",
    "foundations-journal-discipline",
    "foundations-invalidation-first",
    "foundations-fees-are-real",
];

fn code(r: &Refusal) -> String {
    match r {
        Refusal::Academy(e) => e.code.clone(),
        Refusal::Internal { code, .. } => code.clone().unwrap_or_default(),
        Refusal::Approval { code, .. } | Refusal::Precondition { code, .. } => code.clone(),
        other => format!("{other:?}"),
    }
}

fn message(r: &Refusal) -> String {
    match r {
        Refusal::Academy(e) => e.message.clone(),
        Refusal::Internal { message, .. } => message.clone(),
        other => format!("{other:?}"),
    }
}

fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

/// What `MemoryCertStore.grant` answers for a learner who completed every item: `decideGrant`'s record.
fn grant_of(user: &str, cert: &str, now: i64) -> Grant {
    let def = CertDefinition::new(cert, "Foundations", Some("foundations"), &["a", "b"]);
    let (g, already) = progress::decide_grant(
        user,
        Some(&def),
        &set(&["a", "b"]),
        None,
        &BTreeSet::new(),
        now,
    )
    .unwrap();
    assert!(!already);
    g
}

fn obj(fields: &[(&str, Json)]) -> Json {
    Json::Object(
        fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), v.clone()))
            .collect(),
    )
}

// ── catalog-paths.test.ts ────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn catalog_keeps_foundations_v1_and_publishes_no_other_path() {
    let f = catalog::foundations_v1();
    assert_eq!(f.required_item_slugs, LESSONS);
    assert_eq!(f.path.as_deref(), Some("foundations"));
    let ids: Vec<&str> = catalog::production()
        .iter()
        .map(|c| c.id.as_str())
        .collect();
    assert_eq!(ids, ["foundations-v1"]);
    let prod = catalog::production();
    assert_eq!(
        catalog::for_path("foundations", prod).map(|c| c.id.as_str()),
        Some("foundations-v1")
    );
    for path in ["markets", "builder", "sovereign"] {
        assert!(catalog::for_path(path, prod).is_none(), "{path}");
    }
}

#[test]
fn catalog_rejects_a_certificate_naming_an_unknown_lesson_or_assessment() {
    let no_assessment = |_: &str| false;
    let bad_lesson = CertDefinition::new("bad-lesson", "Bad", Some("markets"), &["no-such-lesson"]);
    assert!(catalog::assert_catalog(&[bad_lesson], &spine::has, &no_assessment).is_err());
    let bad_assessment = CertDefinition::new(
        "bad-assessment",
        "Bad",
        Some("builder"),
        &["assessment:no-such"],
    );
    assert!(catalog::assert_catalog(&[bad_assessment], &spine::has, &no_assessment).is_err());
    assert_eq!(
        catalog::assert_catalog(catalog::production(), &spine::has, &no_assessment),
        Ok(())
    );
}

// ── catalog-spine.test.ts ────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn every_required_slug_is_on_the_curriculum_spine() {
    let missing: Vec<String> = catalog::production()
        .iter()
        .flat_map(|c| {
            c.required_item_slugs
                .iter()
                .filter(|s| !s.starts_with("assessment:") && !spine::has(s))
                .map(move |s| format!("{}:{s}", c.id))
        })
        .collect();
    assert!(missing.is_empty(), "{missing:?}");
}

#[test]
fn every_xp_policy_certificate_is_grantable() {
    assert!(xp::policy_catalog_consistent(catalog::production()));
    for (id, _) in xp::POLICIES {
        assert!(catalog::by_id(id, catalog::production()).is_some(), "{id}");
    }
}

#[test]
fn every_certificate_requires_something() {
    for cert in catalog::production() {
        assert!(!cert.required_item_slugs.is_empty(), "{}", cert.id);
    }
}

// ── cert-paths.test.ts ───────────────────────────────────────────────────────────────────────────────────────────

struct NoHostRights;
impl HostRights for NoHostRights {
    fn perks_of(&self, _user_id: &str) -> Result<Json, Refusal> {
        panic!("host rights unused")
    }
}

fn never() -> Instant {
    panic!("certPaths reads no clock")
}

#[test]
fn cert_paths_names_foundations_and_refuses_every_unpublished_path() {
    let store = Store::Down("certPaths reads no table".to_owned());
    let publisher = BusPublisher {
        bus: &NoBus,
        producer: "svc-academy".to_owned(),
        clock: never,
    };
    let certs = Certs {
        store: &store,
        catalog: catalog::production(),
        xp: &publisher,
        host_rights: &NoHostRights,
        sweep_running: false,
        issued_rows: None,
        wall: never,
    };
    let row = |path: &str, cert: Option<&str>| {
        obj(&[
            ("path", Json::str(path)),
            ("certId", cert.map_or(Json::Null, Json::str)),
            (
                "refusal",
                if cert.is_some() {
                    Json::Null
                } else {
                    Json::str("academy.certificate_unpublished")
                },
            ),
        ])
    };
    assert_eq!(
        certs.paths_json(),
        Json::Array(vec![
            row("foundations", Some("foundations-v1")),
            row("markets", None),
            row("builder", None),
            row("sovereign", None),
        ])
    );
}

// ── progress.test.ts ─────────────────────────────────────────────────────────────────────────────────────────────

fn foundations_fixture() -> CertDefinition {
    CertDefinition::new(
        "foundations-v1",
        "Foundations",
        None,
        &["foundations-intro", "foundations-risk"],
    )
}

#[test]
fn is_complete_requires_every_item() {
    let req = vec!["a".to_owned(), "b".to_owned()];
    assert!(!progress::is_complete(&req, &set(&["a"]), &BTreeSet::new()));
    assert!(progress::is_complete(
        &req,
        &set(&["a", "b"]),
        &BTreeSet::new()
    ));
}

#[test]
fn an_incomplete_grant_refuses_cert_incomplete() {
    let err = progress::decide_grant(
        "u1",
        Some(&foundations_fixture()),
        &set(&["foundations-intro"]),
        None,
        &BTreeSet::new(),
        NOW,
    )
    .unwrap_err();
    assert_eq!(code(&err), "academy.cert_incomplete");
}

#[test]
fn a_complete_set_grants_and_a_regrant_answers_the_first() {
    let cert = foundations_fixture();
    let done = set(&["foundations-intro", "foundations-risk"]);
    let (g1, a1) =
        progress::decide_grant("u1", Some(&cert), &done, None, &BTreeSet::new(), NOW).unwrap();
    let (g2, a2) =
        progress::decide_grant("u1", Some(&cert), &done, Some(&g1), &BTreeSet::new(), LATER)
            .unwrap();
    assert!(!a1 && a2);
    assert_eq!(g1.idempotency_key, g2.idempotency_key);
    assert_eq!(g1.granted_at, g2.granted_at);
    assert_eq!(g1.idempotency_key, "cert:u1:foundations-v1");
}

#[test]
fn an_insert_that_returned_no_row_reports_already_granted() {
    assert!(!progress::already_granted_after_insert(true));
    assert!(progress::already_granted_after_insert(false));
}

#[test]
fn a_recompletion_keeps_its_first_time() {
    let (a, first) = progress::decide_item_complete("u1", "foundations-intro", None, NOW).unwrap();
    let (b, again) =
        progress::decide_item_complete("u1", "foundations-intro", Some(&a), LATER).unwrap();
    assert!(!first && again);
    assert_eq!(a.completed_at, b.completed_at);
    let blank = progress::decide_item_complete("u1", "   ", None, NOW).unwrap_err();
    assert_eq!(code(&blank), "academy.cert_invalid");
    let _: Option<Completion> = None;
}

#[test]
fn an_unknown_certificate_refuses() {
    let err = progress::decide_grant("u1", None, &BTreeSet::new(), None, &BTreeSet::new(), NOW)
        .unwrap_err();
    assert_eq!(code(&err), "academy.cert_not_found");
    let empty = CertDefinition::new("empty", "E", None, &[]);
    let err = progress::decide_grant(
        "u1",
        Some(&empty),
        &BTreeSet::new(),
        None,
        &BTreeSet::new(),
        NOW,
    )
    .unwrap_err();
    assert_eq!(code(&err), "academy.cert_invalid");
}

#[test]
fn the_report_names_what_is_missing_and_never_invents_a_grant() {
    let cert = foundations_fixture();
    let r = progress::report(
        "u1",
        Some(&cert),
        &set(&["foundations-intro"]),
        None,
        &BTreeSet::new(),
    )
    .unwrap();
    assert!(!r.complete && !r.granted);
    assert_eq!(r.missing_item_slugs, ["foundations-risk"]);
    assert_eq!(r.ratio, "0.5000");
    assert_eq!((r.completed_count, r.required_count), (1, 2));
    assert_eq!(r.missing_item_slugs.len(), 1);
    assert!(!progress::is_grant_ready(&r));
    assert_eq!(r.grant_idempotency_key, None);

    let all = set(&["foundations-intro", "foundations-risk"]);
    let ready = progress::report("u1", Some(&cert), &all, None, &BTreeSet::new()).unwrap();
    assert!(progress::is_grant_ready(&ready));
    assert!(ready.missing_item_slugs.is_empty());
    let (g, _) =
        progress::decide_grant("u1", Some(&cert), &all, None, &BTreeSet::new(), NOW).unwrap();
    let done = progress::report("u1", Some(&cert), &all, Some(&g), &BTreeSet::new()).unwrap();
    assert!(done.complete && done.granted);
    assert!(done.missing_item_slugs.is_empty());
    assert_eq!(done.ratio, "1.0000");
    assert!(!progress::is_grant_ready(&done));
    assert_eq!(
        done.grant_idempotency_key.as_deref(),
        Some("cert:u1:foundations-v1")
    );
}

#[test]
fn an_assessment_requirement_counts_only_a_pass() {
    let cert = CertDefinition::new("t", "T", None, &["assessment:quiz", "lesson"]);
    let r = progress::report(
        "u1",
        Some(&cert),
        &set(&["lesson", "quiz"]),
        None,
        &BTreeSet::new(),
    )
    .unwrap();
    assert_eq!(r.missing_item_slugs, ["assessment:quiz"]);
    let r = progress::report("u1", Some(&cert), &set(&["lesson"]), None, &set(&["quiz"])).unwrap();
    assert!(r.complete);
}

#[test]
fn a_workbook_is_bound_to_its_certificate_or_named_unbound() {
    let certs = [foundations_fixture()];
    assert_eq!(
        progress::workbook_cert_binding("foundations-intro", &certs).unwrap(),
        Binding::Bound {
            cert_id: "foundations-v1".to_owned(),
            item_slug: "foundations-intro".to_owned()
        }
    );
    assert_eq!(
        progress::workbook_cert_binding("unbound-paper-workbook", &certs).unwrap(),
        Binding::Unbound {
            item_slug: "unbound-paper-workbook".to_owned()
        }
    );
    assert_eq!(progress::PAPER_CERT_UNBOUND, "academy.paper_cert_unbound");
}

// ── grant-ledger.test.ts ─────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn the_ledger_decision_refuses_closed() {
    // The TypeScript passes a spy ledger port and checks it is never called; the Rust decision takes no ledger at all.
    let d = honesty::decide_ledger_post();
    assert!(honesty::is_ledger_refuse_closed(&d));
    assert_eq!(d.get("ledgerPosted"), Some(&Json::Bool(false)));
    assert_eq!(d.get("rankWriter"), Some(&Json::str("svc-identity")));
    assert_eq!(
        d.get("xpGraph"),
        Some(&Json::str("intafaced.identity.xp.earned"))
    );
    assert_eq!(
        d.get("residual"),
        Some(&Json::str(honesty::LEDGER_RESIDUAL))
    );
}

#[test]
fn a_ledger_post_recipe_or_amount_on_the_grant_path_refuses() {
    for payload in [
        obj(&[("ledgerTxId", Json::str("tx-1"))]),
        obj(&[("recipes", obj(&[("certFee", Json::Bool(true))]))]),
        obj(&[("ifcAmount", Json::str("1.00"))]),
        obj(&[("certFee", Json::str("10"))]),
        obj(&[("ledgerEntryId", Json::str("e1"))]),
        obj(&[("academyRank", Json::int(3))]),
        obj(&[("awardXpLocal", Json::int(100))]),
    ] {
        let err = honesty::assert_never_posts_ledger(&payload).unwrap_err();
        assert_eq!(code(&err), honesty::LEDGER_REFUSE_CODE);
    }
    assert!(
        message(
            &honesty::assert_never_posts_ledger(&obj(&[("ledgerTxId", Json::str("t"))]))
                .unwrap_err()
        )
        .contains("ledger money")
    );
    assert!(
        honesty::assert_grant_path_honest(&grant_of(USER, "foundations-v1", NOW).json()).is_ok()
    );
    assert!(
        honesty::assert_never_posts_ledger(&obj(&[
            ("certId", Json::str("foundations-v1")),
            ("xpDelta", Json::int(100))
        ]))
        .is_ok()
    );
    let smuggled = honesty::assert_no_perk_money(&obj(&[
        ("certId", Json::str("foundations-v1")),
        ("ledgerTxId", Json::str("tx")),
    ]))
    .unwrap_err();
    assert!(message(&smuggled).contains("ledger money"));
}

#[test]
fn xp_goes_only_through_the_identity_rank_graph() {
    assert!(honesty::is_identity_rank_xp_event(
        honesty::XP_IDENTITY_GRAPH_EVENT
    ));
    assert!(!honesty::is_identity_rank_xp_event("rankUpdated"));
    assert!(honesty::is_academy_local_rank_write("rankUpdated"));
    assert!(honesty::assert_may_publish_on_identity_graph("xpEarned").is_ok());
    assert!(
        message(&honesty::assert_may_publish_on_identity_graph("rankUpdated").unwrap_err())
            .contains("rank_state")
    );
    assert!(honesty::assert_may_publish_on_identity_graph("awardXpLocal").is_err());
    let silo =
        honesty::assert_grant_path_honest(&obj(&[("rank_state", obj(&[("rank", Json::int(1))]))]))
            .unwrap_err();
    let m = message(&silo);
    assert!(
        m.contains("ledger money") || m.contains("rank_state"),
        "{m}"
    );
}

#[test]
fn no_fake_perks_ride_on_the_grant_path() {
    for payload in [
        obj(&[("fakePerk", Json::Bool(true))]),
        obj(&[("claimedPerks", Json::Array(vec![Json::str("fee")]))]),
        obj(&[("unlockedPerks", obj(&[("otcAccess", Json::Bool(true))]))]),
    ] {
        let err = honesty::assert_no_fake_perks(&payload).unwrap_err();
        assert!(message(&err).contains("cosmetic"));
    }
    assert!(
        honesty::assert_grant_path_honest(&obj(&[("cosmeticPerk", Json::str("metal"))])).is_err()
    );
    assert!(
        honesty::assert_no_perk_money(&obj(&[
            ("certId", Json::str("foundations-v1")),
            ("inventedPerks", Json::Array(vec![]))
        ]))
        .is_err()
    );
    assert_eq!(
        honesty::ledger_status_line(),
        format!(
            "grantLedger=0 xpGraph=xpEarned rankWriter=svc-identity fakePerk=0 code={}",
            honesty::LEDGER_REFUSE_CODE
        )
    );
}

// ── perk-plane.test.ts ───────────────────────────────────────────────────────────────────────────────────────────

/// `BASE_PERKS` with overrides, in `rankPerksSchema`'s order, plus a key the schema drops.
fn rank_perks(fee_bps: i64, host: bool) -> Json {
    obj(&[
        ("feeDiscountBps", Json::int(fee_bps)),
        ("p2pLimitMultiplier", Json::int(1)),
        ("copyFollowerCap", Json::int(0)),
        ("lobbyHostRights", Json::Bool(host)),
        ("cardTier", Json::str("none")),
        ("otcAccess", Json::Bool(false)),
        ("launchpadTier", Json::str("none")),
    ])
}

struct Identity {
    perks: Option<Json>,
    asked: Mutex<u32>,
}
impl HostRights for Identity {
    fn perks_of(&self, _user_id: &str) -> Result<Json, Refusal> {
        *self.asked.lock().unwrap() += 1;
        self.perks.clone().ok_or_else(|| Refusal::Internal {
            message: "identity down".to_owned(),
            code: None,
        })
    }
}
fn identity(perks: Option<Json>) -> Identity {
    Identity {
        perks,
        asked: Mutex::new(0),
    }
}

fn emitted() -> Emit {
    Emit::Emitted {
        idempotency_key: "academy.cert:cert:u-1:foundations-v1".to_owned(),
        xp_delta: 100,
    }
}

#[test]
fn every_invent_kind_refuses_closed() {
    assert_eq!(
        perks::INVENT_KINDS,
        [
            "cert_to_perk_map",
            "invent_perk_money",
            "invent_fee_discount",
            "invent_ifc_grant",
            "invent_balance"
        ]
    );
    for kind in perks::INVENT_KINDS {
        let d = perks::decide_invent(kind);
        assert_eq!(d.get("status"), Some(&Json::str("refuse")));
        assert_eq!(d.get("code"), Some(&Json::str(honesty::PERK_REFUSE_CODE)));
        assert_eq!(d.get("kind"), Some(&Json::str(kind)));
        assert!(perks::is_invent_refuse_closed(&d));
        let Some(Json::String(m)) = d.get("message") else {
            panic!("a message")
        };
        assert!(m.contains("refuse-closed") && m.contains("svc-identity"));
        assert_eq!(d.get("residual"), Some(&Json::str(perks::RESIDUAL)));
    }
}

#[test]
fn perk_money_on_a_grant_payload_refuses_and_an_xp_shape_passes() {
    assert!(
        honesty::assert_no_perk_money(&obj(&[
            ("certId", Json::str("foundations-v1")),
            ("xpDelta", Json::int(100)),
            ("alreadyGranted", Json::Bool(false)),
        ]))
        .is_ok()
    );
    assert!(honesty::assert_no_perk_money(&Json::Null).is_ok());
    for key in honesty::PERK_MONEY_BANNED_KEYS {
        let err = honesty::assert_no_perk_money(&obj(&[(key, Json::str("10.00"))])).unwrap_err();
        assert_eq!(code(&err), honesty::PERK_REFUSE_CODE, "{key}");
        assert!(message(&err).contains("refuse-closed"));
    }
}

#[test]
fn perks_are_identitys_and_a_down_identity_refuses_without_inventing() {
    let up = identity(Some(rank_perks(150, true)));
    assert_eq!(
        perks::resolve("u-1", &up, &emitted()),
        obj(&[
            ("status", Json::str("real")),
            ("path", Json::str("identity_rank")),
            ("sot", Json::str("svc-identity")),
            ("academyHoldsPerkMoney", Json::Bool(false)),
            ("academyMapsCertToPerk", Json::Bool(false)),
            ("perks", rank_perks(150, true)),
        ])
    );
    let down = identity(None);
    let out = perks::resolve("u-1", &down, &Emit::Skipped(Skip::PublisherUnavailable));
    assert_eq!(out.get("status"), Some(&Json::str("refuse")));
    assert_eq!(out.get("reason"), Some(&Json::str("identity_unreadable")));
    assert_eq!(out.get("academyHoldsPerkMoney"), Some(&Json::Bool(false)));
    assert_eq!(out.get("academyMapsCertToPerk"), Some(&Json::Bool(false)));
    assert!(out.get("perks").is_none());
}

#[test]
fn an_unpriced_certificate_refuses_before_identity_is_asked() {
    let rights = identity(Some(rank_perks(150, true)));
    let xp = Emit::Skipped(Skip::NoPolicy);
    assert!(xp.is_unpriced());
    let out = perks::resolve("u-1", &rights, &xp);
    assert_eq!(out.get("status"), Some(&Json::str("refuse")));
    assert_eq!(out.get("reason"), Some(&Json::str("unpriced")));
    assert!(out.get("perks").is_none());
    assert_eq!(*rights.asked.lock().unwrap(), 0);
    assert!(perks::grant_must_not_invent_payout(&xp, &out));
    // An unpriced certificate that still shows a real perk is caught. (The TypeScript's second case, an unpriced
    // result carrying an `xpDelta`, cannot be built in Rust: `Skipped` holds no amount.)
    let lying = obj(&[
        ("status", Json::str("real")),
        ("path", Json::str("identity_rank")),
        ("sot", Json::str("svc-identity")),
        ("academyHoldsPerkMoney", Json::Bool(false)),
        ("academyMapsCertToPerk", Json::Bool(false)),
        ("perks", rank_perks(50, false)),
    ]);
    assert!(!perks::grant_must_not_invent_payout(&xp, &lying));
}

#[test]
fn a_priced_grant_may_show_identitys_perks_and_never_an_academy_map() {
    let rights = identity(Some(rank_perks(0, false)));
    let out = perks::resolve("u-1", &rights, &emitted());
    assert!(perks::grant_must_not_invent_payout(&emitted(), &out));
    assert_eq!(out.get("academyMapsCertToPerk"), Some(&Json::Bool(false)));
    let mut map = out.clone();
    if let Json::Object(f) = &mut map {
        for (k, v) in f.iter_mut() {
            if k == "academyHoldsPerkMoney" {
                *v = Json::Bool(true);
            }
        }
    }
    assert!(!perks::grant_must_not_invent_payout(&emitted(), &map));
}

#[test]
fn the_perk_plane_status_is_honest() {
    let plane = perks::plane_status();
    assert_eq!(
        plane.get("perksEnabledViaIdentity"),
        Some(&Json::Bool(true))
    );
    assert_eq!(plane.get("academyMapsCertToPerk"), Some(&Json::Bool(false)));
    assert_eq!(plane.get("academyHoldsPerkMoney"), Some(&Json::Bool(false)));
    assert_eq!(plane.get("rankWriter"), Some(&Json::str("svc-identity")));
    assert!(perks::residual_is_honest(perks::RESIDUAL));
    assert_eq!(
        plane.get("statusLine"),
        Some(&Json::str(perks::plane_status_line()))
    );
    assert_eq!(
        plane.get("inventKindsRefuseClosed"),
        Some(&Json::Array(
            perks::INVENT_KINDS.iter().map(|k| Json::str(*k)).collect()
        ))
    );
}

// ── perk-money-isolation.test.ts ─────────────────────────────────────────────────────────────────────────────────

/// Every certificate module's source, with its comment lines dropped.
fn cert_sources() -> Vec<(String, String)> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/certs");
    let mut out: Vec<(String, String)> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "rs"))
        .map(|p| {
            let text = std::fs::read_to_string(&p).unwrap();
            let body: Vec<&str> = text
                .lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .collect();
            (
                p.file_name().unwrap().to_string_lossy().into_owned(),
                body.join("\n"),
            )
        })
        .collect();
    out.sort();
    out
}

#[test]
fn no_certificate_module_can_post_to_the_ledger_or_invent_perk_money() {
    let sources = cert_sources();
    assert!(sources.len() >= 10, "{sources:?}");
    for (name, body) in &sources {
        for banned in [
            "ledger_client",
            "ledger-client",
            "LedgerClient",
            "LEDGER_URL",
            "feeCharge",
            "fee_charge",
            "CERT_TO_PERK_MAP",
            ".post(",
            "ureq",
        ] {
            assert!(!body.contains(banned), "{name} holds {banned}");
        }
        // `\bperkAmount\s*[:=]`, `\bifcGrant\s*[:=]`: an invented field (the banned-key lists name them as strings).
        for invented in ["perk_amount:", "perk_amount =", "ifc_grant:", "ifc_grant ="] {
            assert!(!body.contains(invented), "{name} holds {invented}");
        }
    }
    let plane = &sources.iter().find(|(n, _)| n == "perks.rs").unwrap().1;
    assert!(plane.contains("svc-identity"));
    assert!(plane.contains("(\"academyHoldsPerkMoney\", Json::Bool(false))"));
    let ledger = &sources.iter().find(|(n, _)| n == "honesty.rs").unwrap().1;
    assert!(ledger.contains("intafaced.identity.xp.earned"));
    assert!(ledger.contains("(\"ledgerPosted\", Json::Bool(false))"));
    assert!(ledger.contains("refuse-closed"));
}

// ── xp-policy.test.ts and xp-emit.test.ts ────────────────────────────────────────────────────────────────────────

#[test]
fn foundations_is_worth_a_fixed_xp_string_and_nothing_else_is_priced() {
    assert_eq!(xp::policy_for("foundations-v1"), Some("100"));
    assert_eq!(xp::policy_for("no-such-cert"), None);
    assert_eq!(xp::policy_for("markets-v1"), None);
    let ids: Vec<&str> = xp::POLICIES.iter().map(|(id, _)| *id).collect();
    let mut sorted = ids.clone();
    sorted.sort_unstable();
    assert_eq!(ids, sorted);
}

#[test]
fn the_xp_intent_is_keyed_on_the_grant() {
    let intent = xp::intent_from_grant(&grant_of("u1", "foundations-v1", NOW))
        .unwrap()
        .unwrap();
    assert_eq!(intent.user_id, "u1");
    assert_eq!(intent.cert_id, "foundations-v1");
    assert_eq!(intent.xp_delta, "100");
    assert_eq!(
        intent.idempotency_key,
        "academy.cert:cert:u1:foundations-v1"
    );
    let again = xp::intent_from_grant(&grant_of("u1", "foundations-v1", LATER))
        .unwrap()
        .unwrap();
    assert_eq!(again.idempotency_key, intent.idempotency_key);
    assert!(xp::may_publish(Some(&intent)));
    assert!(!xp::may_publish(None));
    assert_eq!(
        xp::intent_from_grant(&grant_of("u1", "unknown-v1", NOW)).unwrap(),
        None
    );
}

// ── xp-publish.test.ts ───────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn the_xp_delta_is_a_positive_safe_integer_or_nothing() {
    assert_eq!(xp::delta_to_int("100"), Some(100));
    assert_eq!(xp::delta_to_int(" 150 "), Some(150));
    for bad in ["0", "-5", "1.5", "100.0", "lots", "", "9007199254740993"] {
        assert_eq!(xp::delta_to_int(bad), None, "{bad}");
    }
}

#[test]
fn the_intent_names_academy_and_puts_the_certificate_in_meta() {
    let intent = xp::intent_for(&grant_of(USER, "foundations-v1", NOW), false)
        .unwrap()
        .unwrap();
    assert_eq!(
        intent.payload(),
        obj(&[
            ("userId", Json::str(USER)),
            ("sourceModule", Json::str(xp::SOURCE_MODULE)),
            ("action", Json::str(xp::ACTION)),
            ("xpDelta", Json::int(100)),
            ("meta", obj(&[("certId", Json::str("foundations-v1"))])),
        ])
    );
    assert_eq!(
        intent.idempotency_key,
        format!("academy.cert:cert:{USER}:foundations-v1")
    );
    let later = xp::intent_for(&grant_of(USER, "foundations-v1", LATER), false)
        .unwrap()
        .unwrap();
    assert_eq!(later.idempotency_key, intent.idempotency_key);
    let theirs = xp::intent_for(&grant_of(OTHER, "foundations-v1", NOW), false)
        .unwrap()
        .unwrap();
    assert_ne!(theirs.idempotency_key, intent.idempotency_key);
    assert_eq!(
        xp::intent_for(&grant_of(USER, "not-in-policy-v1", NOW), false).unwrap(),
        Err(Skip::NoPolicy)
    );
}

/// `MemoryEventBus` with svc-identity's `idempotent()` subscriber: every publish is kept; the writer applies each
/// envelope's `idempotencyKey` once.
#[derive(Default)]
struct MemoryBus {
    emitted: Mutex<Vec<(String, String, Json)>>,
    fail: bool,
}
impl Bus for MemoryBus {
    fn id(&self) -> &str {
        "bus"
    }
    fn usable(&self) -> bool {
        true
    }
    fn publish(&self, subject: &str, msg_id: &str, payload: &Json) -> Result<(), String> {
        if self.fail {
            return Err("nats is gone".to_owned());
        }
        self.emitted
            .lock()
            .unwrap()
            .push((subject.to_owned(), msg_id.to_owned(), payload.clone()));
        Ok(())
    }
}
impl MemoryBus {
    fn envelopes(&self) -> Vec<Json> {
        self.emitted
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.2.clone())
            .collect()
    }
    /// What the identity writer applied: each key once, in order.
    fn awarded(&self) -> Vec<Json> {
        let mut seen = BTreeSet::new();
        self.envelopes()
            .into_iter()
            .filter(|e| {
                let Some(Json::String(k)) = e.get("idempotencyKey") else {
                    return false;
                };
                seen.insert(k.clone())
            })
            .map(|e| e.get("payload").cloned().unwrap())
            .collect()
    }
}

fn clock() -> Instant {
    Instant(NOW)
}
fn publisher(bus: &dyn Bus) -> BusPublisher<'_> {
    BusPublisher {
        bus,
        producer: "svc-academy".to_owned(),
        clock,
    }
}

#[test]
fn a_grant_publishes_one_xp_earned_the_catalogue_accepts() {
    let bus = MemoryBus::default();
    let out = publisher(&bus)
        .publish(&grant_of(USER, "foundations-v1", NOW))
        .unwrap();
    assert_eq!(
        out,
        Emit::Emitted {
            idempotency_key: format!("academy.cert:cert:{USER}:foundations-v1"),
            xp_delta: 100
        }
    );
    let sent = bus.emitted.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    let (subject, msg_id, env) = &sent[0];
    assert_eq!(subject, "intafaced.identity.xp.earned");
    assert_eq!(msg_id, &format!("academy.cert:cert:{USER}:foundations-v1"));
    assert_eq!(
        env.get("subject"),
        Some(&Json::str("intafaced.identity.xp.earned"))
    );
    assert_eq!(env.get("version"), Some(&Json::int(1)));
    assert_eq!(env.get("producer"), Some(&Json::str("svc-academy")));
    assert_eq!(
        env.get("occurredAt"),
        Some(&Json::str("2026-08-07T12:00:00.000Z"))
    );
    let p = env.get("payload").unwrap();
    assert_eq!(p.get("sourceModule"), Some(&Json::str("academy")));
    assert_eq!(p.get("action"), Some(&Json::str("cert.granted")));
    assert_eq!(p.get("xpDelta"), Some(&Json::int(100)));
}

#[test]
fn a_revoke_takes_the_award_back_once_and_the_net_is_nothing() {
    let bus = MemoryBus::default();
    let pubr = publisher(&bus);
    let grant = grant_of(USER, "foundations-v1", NOW);
    pubr.publish(&grant).unwrap();
    let reversed = pubr.reverse(&grant).unwrap();
    pubr.publish(&grant).unwrap();
    pubr.reverse(&grant).unwrap();
    assert_eq!(
        reversed,
        Emit::Emitted {
            idempotency_key: format!("academy.cert:reverse:cert:{USER}:foundations-v1"),
            xp_delta: -100
        }
    );
    let last = bus
        .envelopes()
        .last()
        .unwrap()
        .get("payload")
        .cloned()
        .unwrap();
    assert_eq!(last.get("action"), Some(&Json::str("cert.revoked")));
    assert_eq!(last.get("xpDelta"), Some(&Json::int(-100)));
    let awarded: Vec<Json> = bus
        .awarded()
        .iter()
        .map(|p| p.get("xpDelta").cloned().unwrap())
        .collect();
    assert_eq!(awarded, [Json::int(100), Json::int(-100)]);
}

#[test]
fn an_unpriced_certificate_publishes_and_takes_back_nothing() {
    let bus = MemoryBus::default();
    let grant = grant_of(USER, "not-in-policy-v1", NOW);
    assert_eq!(
        publisher(&bus).reverse(&grant).unwrap(),
        Emit::Skipped(Skip::NoPolicy)
    );
    assert_eq!(
        publisher(&bus).publish(&grant).unwrap(),
        Emit::Skipped(Skip::NoPolicy)
    );
    assert!(bus.envelopes().is_empty());
}

#[test]
fn a_regrant_awards_once_at_the_writer_and_two_users_each_once() {
    let bus = MemoryBus::default();
    let p = publisher(&bus);
    p.publish(&grant_of(USER, "foundations-v1", NOW)).unwrap();
    p.publish(&grant_of(USER, "foundations-v1", LATER)).unwrap();
    p.publish(&grant_of(USER, "foundations-v1", LATER)).unwrap();
    assert_eq!(bus.envelopes().len(), 3);
    assert_eq!(bus.awarded().len(), 1);
    assert_eq!(bus.awarded()[0].get("xpDelta"), Some(&Json::int(100)));

    let two = MemoryBus::default();
    publisher(&two)
        .publish(&grant_of(USER, "foundations-v1", NOW))
        .unwrap();
    publisher(&two)
        .publish(&grant_of(OTHER, "foundations-v1", NOW))
        .unwrap();
    let users: Vec<Json> = two
        .awarded()
        .iter()
        .map(|p| p.get("userId").cloned().unwrap())
        .collect();
    assert_eq!(users, [Json::str(USER), Json::str(OTHER)]);
}

#[test]
fn a_failed_publish_is_reported_not_thrown() {
    let broken = MemoryBus {
        fail: true,
        ..MemoryBus::default()
    };
    let out = publisher(&broken)
        .publish(&grant_of(USER, "foundations-v1", NOW))
        .unwrap();
    assert_eq!(out, Emit::Skipped(Skip::PublishFailed));
}

#[test]
fn no_bus_says_so_and_nothing_else() {
    let none = publisher(&NoBus);
    assert!(!none.usable());
    assert_eq!(
        none.publish(&grant_of(USER, "foundations-v1", NOW))
            .unwrap(),
        Emit::Skipped(Skip::PublisherUnavailable)
    );
    let unpriced = none
        .publish(&grant_of(USER, "not-in-policy-v1", NOW))
        .unwrap();
    assert_eq!(unpriced, Emit::Skipped(Skip::NoPolicy));
    assert!(unpriced.json().get("xpDelta").is_none());
}

#[test]
fn the_xp_plane_status_names_the_publisher_and_the_priced_certificates() {
    let bus = MemoryBus::default();
    assert_eq!(
        xp::plane_status(&publisher(&bus)),
        obj(&[
            ("publisherId", Json::str("bus")),
            ("emitEnabled", Json::Bool(true)),
            ("sourceModule", Json::str("academy")),
            ("action", Json::str("cert.granted")),
            ("rankWriter", Json::str("svc-identity")),
            (
                "policies",
                Json::Array(vec![obj(&[
                    ("certId", Json::str("foundations-v1")),
                    ("xpDelta", Json::int(100))
                ])])
            ),
        ])
    );
    let none = xp::plane_status(&publisher(&NoBus));
    assert_eq!(none.get("publisherId"), Some(&Json::str("none")));
    assert_eq!(none.get("emitEnabled"), Some(&Json::Bool(false)));
    assert_eq!(none.get("rankWriter"), Some(&Json::str("svc-identity")));
}
