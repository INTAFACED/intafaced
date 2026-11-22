//! Slice `partner` with the TEST partner ON, through the Rust door on a real Postgres. `scripts/partner-probe.mjs`
//! sends one scripted story of calls to the TypeScript svc-bank (tRPC, the usage payment, the loopback record doors and
//! the TEST age door) and keeps every answer in `fixtures/partner-probe.golden.json`; this sends the same requests, with
//! the same headers, at the same pinned times, in the same order, and holds each status and body byte for byte. Then
//! the refusals the desk counted (`bank.partner_refusal_counts`) and the coin the cash leg paid into the TEST venue.
//!
//! The wire replay holds the slice with the TEST partner off; this holds it on. Without `TEST_DATABASE_URL` it skips;
//! with `REQUIRE_POSTGRES=1` it fails.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::support;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, Ordering};

use service_kit::json::{self, Json};
use service_kit::money::Amount;
use service_kit::s2s_verify::BodyBind;
use service_kit::server::Request;
use service_kit::time::{Instant, js_date};
use svc_bank::door::{BankDoor, DoorConfig, ServiceAuth};
use svc_bank::partner::TestPartner;
use svc_bank::partner::cash_leg::{CashLegs, Payout, VenueAccount, parse_rates};
use svc_bank::partner::custody::{Freeze, FreezeReading};
use svc_bank::partner::router::Wiring;

use support::TestDb;

/// The pinned clock: each step's `at`.
static CLOCK: AtomicI64 = AtomicI64::new(0);

fn now() -> Instant {
    Instant(CLOCK.load(Ordering::SeqCst))
}

/// The world each step runs in, as the story sets it.
struct World {
    posting: bool,
    cause: Option<String>,
    venue_fails: bool,
    paid: Vec<Json>,
}

static WORLD: Mutex<World> = Mutex::new(World {
    posting: true,
    cause: None,
    venue_fails: false,
    paid: Vec::new(),
});

/// svc-ledger's freeze as the story sets it.
struct StoryFreeze;

impl Freeze for StoryFreeze {
    fn read(&self) -> Result<FreezeReading, String> {
        let w = WORLD.lock().unwrap();
        Ok(FreezeReading {
            posting_enabled: w.posting,
            cause: if w.posting { None } else { w.cause.clone() },
        })
    }
}

/// The TEST venue's deposit control: it fails while the story says so, and keeps each payment.
struct StoryVenue;

impl Payout for StoryVenue {
    fn pay(
        &self,
        reference: &str,
        venue: &VenueAccount,
        coin: &str,
        amount: Amount,
    ) -> Result<(), String> {
        let mut w = WORLD.lock().unwrap();
        if w.venue_fails {
            return Err("the TEST venue answered 503".to_owned());
        }
        w.paid.push(Json::obj([
            ("ref", Json::str(reference)),
            ("owner", Json::str(&venue.owner)),
            ("coin", Json::str(coin)),
            // `String(amount)` of the scaled bigint, as the TypeScript keeps it.
            ("amount", Json::str(amount.to_string())),
        ]));
        Ok(())
    }
}

fn s<'a>(j: &'a Json, k: &str) -> &'a str {
    match j.get(k) {
        Some(Json::String(v)) => v,
        other => panic!("no {k}: {other:?}"),
    }
}

fn text(j: &Json) -> String {
    match j {
        Json::String(v) => v.clone(),
        other => panic!("not a string: {other:?}"),
    }
}

fn golden() -> Json {
    let file =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/partner-probe.golden.json");
    json::parse(&std::fs::read_to_string(file).unwrap()).unwrap()
}

/// The probe's masks: the TEST book's random boot id as `<boot>`, tRPC's stack trace as `<stack>`.
fn normal(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(at) = rest.find("test-partner-") {
        out.push_str(&rest[..at + "test-partner-".len()]);
        rest = &rest[at + "test-partner-".len()..];
        let kind = ["move-", "quote-", "payment-", "hold-"]
            .into_iter()
            .find(|k| rest.starts_with(k));
        if let Some(kind) = kind {
            let after = &rest[kind.len()..];
            let hex = after.bytes().take(12).filter(u8::is_ascii_hexdigit).count();
            let digits = after
                .bytes()
                .take(12)
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
            if hex == 12 && digits && after.as_bytes().get(12) == Some(&b'-') {
                out.push_str(kind);
                out.push_str("<boot>-");
                rest = &after[13..];
            }
        }
    }
    out.push_str(rest);
    let key = "\"stack\":\"";
    if let Some(at) = out.find(key) {
        let after = &out[at + key.len()..];
        let bytes = after.as_bytes();
        let mut end = 0;
        while end < bytes.len() && bytes[end] != b'"' {
            end += if bytes[end] == b'\\' { 2 } else { 1 };
        }
        out = format!("{}<stack>{}", &out[..at + key.len()], &after[end..]);
    }
    out
}

/// The rows the TypeScript's stand-in answers from: the story's two businesses, their administrators, and one open
/// business invite made at the story's start.
fn seed(db: &TestDb, g: &Json) {
    let mut c = db.client();
    let Some(Json::Array(businesses)) = g.get("businesses") else {
        panic!("businesses")
    };
    for b in businesses {
        c.execute(
            "INSERT INTO bank.business_accounts (id, name, asset_id, spend_threshold, status) \
             VALUES ($1::text::uuid, $2, $3, 1000, $4)",
            &[
                &s(b, "id"),
                &s(b, "name"),
                &s(b, "asset_id"),
                &s(b, "status"),
            ],
        )
        .unwrap();
        c.execute(
            "UPDATE bank.business_accounts SET owner_user_id = $2 WHERE id = $1::text::uuid",
            &[&s(b, "id"), &s(b, "owner_user_id")],
        )
        .unwrap();
        c.execute(
            "INSERT INTO bank.business_members (account_id, user_id, role) VALUES ($1::text::uuid, $2, 'admin')",
            &[&s(b, "id"), &s(b, "admin")],
        )
        .unwrap();
    }
    c.execute(
        "INSERT INTO bank.business_invites (id, account_id, kind, token_hash, role, invited_by, status, created_at, expires_at) \
         VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', $1::text::uuid, 'link', 'probe-token-hash', 'admin', $2, 'open', \
                 '2026-11-22T10:00:00.000Z', '2026-11-29T10:00:00.000Z')",
        &[&s(&businesses[0], "id"), &s(&businesses[0], "admin")],
    )
    .unwrap();
}

/// The operator's partner stop as the step sets it.
fn stops(db: &TestDb, stopped: &[String]) {
    let mut c = db.client();
    c.execute("DELETE FROM bank.partner_stops", &[]).unwrap();
    if !stopped.is_empty() {
        c.execute(
            "INSERT INTO bank.partner_stops (partner_id, stopped_kinds, revision, reason, approved_by) \
             VALUES ('test-partner', $1, 1, 'the probe', 'probe-operator')",
            &[&stopped],
        )
        .unwrap();
    }
}

fn door(db: &TestDb, g: &Json) -> BankDoor {
    // The probe's process: NODE_ENV and APP_ENV test, nothing else of the slice's set.
    let env: BTreeMap<String, String> = [("APP_ENV", "test"), ("NODE_ENV", "test")]
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    BankDoor::new(DoorConfig {
        edge_secret: s(g, "secret").to_owned(),
        services: ServiceAuth {
            secret: Some(s(g, "internal").to_owned()),
            keys: None,
            trpc_bind: BodyBind::AcceptBoth,
        },
        env,
        now,
        store: db.store(),
    })
    .unwrap()
    .with_partner(Wiring {
        partner: Some(TestPartner::new().unwrap()),
        freeze: Box::new(StoryFreeze),
        custody_layer: "off".to_owned(),
        cash_legs: Some(CashLegs::new(
            parse_rates(Some("EUR:USDC:1.08,USD:USDC:1"))
                .unwrap()
                .unwrap(),
            Box::new(StoryVenue),
        )),
        pay_in: None,
    })
    .with_test_age(true)
}

#[test]
fn the_rust_door_answers_the_partner_story_as_the_typescript_does() {
    let Some(db) = TestDb::new() else {
        eprintln!("partner_probe: skipped, no TEST_DATABASE_URL");
        return;
    };
    db.migrated();
    let g = golden();
    seed(&db, &g);
    let bank = door(&db, &g);
    let Some(Json::Array(steps)) = g.get("steps") else {
        panic!("steps")
    };
    let mut wrong = Vec::new();
    for (i, step) in steps.iter().enumerate() {
        CLOCK.store(js_date(s(step, "at")).unwrap().0, Ordering::SeqCst);
        let env = step.get("env").unwrap();
        {
            let mut w = WORLD.lock().unwrap();
            w.posting = env.get("posting") == Some(&Json::Bool(true));
            w.cause = match env.get("cause") {
                Some(Json::String(c)) => Some(c.clone()),
                _ => None,
            };
            w.venue_fails = env.get("venueFails") == Some(&Json::Bool(true));
        }
        let stopped: Vec<String> = match env.get("stopped") {
            Some(Json::Array(k)) => k.iter().map(text).collect(),
            _ => Vec::new(),
        };
        stops(&db, &stopped);
        let headers: Vec<(String, String)> = match step.get("headers") {
            Some(Json::Object(h)) => h.iter().map(|(k, v)| (k.clone(), text(v))).collect(),
            _ => Vec::new(),
        };
        let body = match step.get("body") {
            Some(Json::String(b)) => b.as_str(),
            _ => "",
        };
        let res = bank.handle_from(
            &Request {
                method: s(step, "method"),
                url: s(step, "url"),
                headers: &headers,
                body,
            },
            "probe-request",
            "127.0.0.1",
        );
        let want_status = match step.get("status") {
            Some(Json::Number(n)) => *n as u16,
            other => panic!("status {other:?}"),
        };
        let got = normal(&res.body);
        if res.status != want_status || got != s(step, "answer") {
            wrong.push(format!(
                "step {i} `{}` {} {}\n  want {want_status} {}\n  got  {} {got}",
                s(step, "name"),
                s(step, "method"),
                s(step, "url"),
                s(step, "answer"),
                res.status
            ));
        }
    }
    assert!(
        wrong.is_empty(),
        "{} of {} steps differ:\n{}",
        wrong.len(),
        steps.len(),
        wrong.join("\n")
    );

    // Each refusal the desk counted, summed over days as the stand-in keeps them.
    let mut counted = BTreeMap::new();
    for row in db
        .client()
        .query(
            "SELECT refused_by || '|' || cause || '|' || kind, sum(count)::bigint FROM bank.partner_refusal_counts GROUP BY 1",
            &[],
        )
        .unwrap()
    {
        counted.insert(row.get::<_, String>(0), row.get::<_, i64>(1));
    }
    let Some(Json::Object(want)) = g.get("counted") else {
        panic!("counted")
    };
    let want: BTreeMap<String, i64> = want
        .iter()
        .map(|(k, v)| match v {
            Json::Number(n) => (k.clone(), *n as i64),
            other => panic!("count {other:?}"),
        })
        .collect();
    assert_eq!(counted, want, "the refusals counted");

    let paid = Json::Array(WORLD.lock().unwrap().paid.clone()).compact();
    assert_eq!(
        paid,
        g.get("venuePaid").unwrap().compact(),
        "the coin paid into the TEST venue"
    );
}
