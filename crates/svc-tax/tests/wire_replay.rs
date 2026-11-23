//! The wire replay. `fixtures/wire-replay.golden.json` holds what the TypeScript svc-tax answered to a matrix of
//! requests (every call, seven inputs, four callers, a blank and a set jurisdiction map), recorded by its
//! `wire-replay.test.ts` before the Rust service replaced it. This sends the same requests, built the same way, to the
//! Rust service, and every one must get the recorded status and body, byte for byte.
//!
//! The rows replay. `fixtures/wire-replay.rows.golden.json` holds the same matrix (set map) as the TypeScript svc-tax
//! answered it wired to its real Postgres stores: each request's status and body, and the rows it added to or removed
//! from the `tax` tables (`storedRows`, `@intafaced/db/testing`). The Rust service, wired to its own Postgres stores, must
//! leave the same rows after the same inputs: a second row where a save should replace, a value stored differently, or
//! a read that writes shows here as a difference. It needs a Postgres (`TEST_DATABASE_URL_TAX` or `TEST_DATABASE_URL`);
//! without one it skips, and with `REQUIRE_POSTGRES=1` it fails.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use postgres::{Client, NoTls};
use svc_tax::edge;
use svc_tax::json::{self, Json};
use svc_tax::money::parse_amount;
use svc_tax::ports::{
    BasisStore, ChoiceStore, InflowLine, Ledger, TaxBalance, TradeFillReader, TradeFills,
};
use svc_tax::stores::basis::PgBasisStore;
use svc_tax::stores::choices::PgChoiceStore;
use svc_tax::stores::migrate::FILES;
use svc_tax::stores::pool::Pool;
use svc_tax::tax::{Account, Failure, HistoryEntry, LakeStatus, Range, TaxDeps, TaxService};
use svc_tax::time::Instant;
use svc_tax::wire::{self, Request, Wire, WireConfig};

const GOLDEN: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/wire-replay.golden.json"
);
const ROWS_GOLDEN: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/wire-replay.rows.golden.json"
);
const SECRET: &str = "a-tax-wire-replay-edge-secret-long-enough";
const USER: &str = "11111111-1111-4111-8111-111111111111";
/// 2026-11-19T00:00:00Z: the replay's fixed clock, so the export's filename does not move with the calendar.
const NOW: Instant = Instant(1_795_046_400_000);

/// The replay's ledger: it holds nothing.
struct EmptyLedger;

impl Ledger for EmptyLedger {
    fn balances(&self, _owner_type: &str, _owner_id: &str) -> Result<Vec<TaxBalance>, Failure> {
        Ok(Vec::new())
    }
    fn history(&self, _account: &Account, _range: Range) -> Result<Vec<HistoryEntry>, Failure> {
        Ok(Vec::new())
    }
}

/// The rows replay's ledger: one deposit with no cost, so there is a lot whose basis a customer may enter. TEST figures.
struct OneUnknownLot;

impl Ledger for OneUnknownLot {
    fn balances(&self, _owner_type: &str, _owner_id: &str) -> Result<Vec<TaxBalance>, Failure> {
        Ok(vec![TaxBalance {
            account: Account {
                owner_type: "user".to_owned(),
                owner_id: USER.to_owned(),
                asset_id: "BTC".to_owned(),
                kind: "available".to_owned(),
            },
            purpose: None,
            account_id: "a-0".to_owned(),
            amount: parse_amount("1").unwrap(),
        }])
    }
    fn history(&self, _account: &Account, _range: Range) -> Result<Vec<HistoryEntry>, Failure> {
        Ok(Vec::new())
    }
    fn trade_fills(&self) -> Option<&dyn TradeFillReader> {
        Some(self)
    }
}

impl TradeFillReader for OneUnknownLot {
    fn trade_fills(&self, _user_id: &str) -> Result<TradeFills, Failure> {
        Ok(TradeFills {
            fills: Vec::new(),
            truncated: false,
            outside_inflows: vec!["BTC".to_owned()],
            inflows: Some(vec![InflowLine {
                tx_id: "tx-1".to_owned(),
                // 2024-01-01T00:00:00.000Z
                posted_at: Instant(1_704_067_200_000),
                asset_id: "BTC".to_owned(),
                amount: parse_amount("1").unwrap(),
                reason: "deposit.credited".to_owned(),
            }]),
            outflows: Some(Vec::new()),
            withdrawal_holds: Some(Vec::new()),
        })
    }
}

fn serve(map_raw: &str) -> Wire {
    serve_with(map_raw, Arc::new(EmptyLedger), None)
}

/// The service, with its Postgres stores when `stores` is given.
fn serve_with(
    map_raw: &str,
    ledger: Arc<dyn Ledger>,
    stores: Option<(Arc<dyn BasisStore>, Arc<dyn ChoiceStore>)>,
) -> Wire {
    let (basis, choices) = stores.map_or((None, None), |(b, c)| (Some(b), Some(c)));
    let tax = TaxService::new(TaxDeps {
        lake: LakeStatus::lake(None),
        indexer: LakeStatus::indexer(None),
        basis,
        choices,
        ..TaxDeps::new(map_raw, ledger, Some(10), Box::new(|| NOW))
    })
    .unwrap();
    // svc-tax's vitest environment (the TypeScript service's `vitest.config.ts`); vitest sets NODE_ENV to `test`.
    let env: BTreeMap<String, String> = [
        ("APP_ENV", "test"),
        ("INTAFACED_SCREENING_FAIL_CLOSED", "off"),
        ("NODE_ENV", "test"),
    ]
    .iter()
    .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
    .collect();
    Wire::new(WireConfig {
        edge_secret: SECRET.to_owned(),
        env,
        tax,
    })
    .unwrap()
}

/// `encodePrincipal` of the replay's principal: its keys in that function's order.
fn headers(scopes: Option<&[&str]>, region: &str) -> Vec<(String, String)> {
    let Some(scopes) = scopes else {
        return Vec::new();
    };
    let raw = Json::obj([
        ("sub", Json::str(USER)),
        (
            "scopes",
            Json::Array(scopes.iter().map(|s| Json::str(*s)).collect()),
        ),
        ("tier", Json::str("none")),
        ("mfa", Json::Bool(false)),
        ("sid", Json::str("22222222-2222-4222-8222-222222222222")),
        ("userId", Json::str(USER)),
        ("expiresAt", Json::str("2099-01-01T00:00:00.000Z")),
    ])
    .compact();
    let sig = edge::sign(&raw, SECRET, region).unwrap();
    vec![
        ("x-intafaced-principal".to_owned(), raw),
        ("x-intafaced-principal-sig".to_owned(), sig),
        ("x-intafaced-region".to_owned(), region.to_owned()),
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

/// tRPC's dev stack trace carries file paths and line numbers, which move with any edit.
fn without_stack(body: &str) -> String {
    let key = "\"stack\":\"";
    let mut out = String::new();
    let mut rest = body;
    while let Some(at) = rest.find(key) {
        out.push_str(&rest[..at + key.len()]);
        let after = &rest[at + key.len()..];
        let mut end = 0;
        let bytes = after.as_bytes();
        while end < bytes.len() && bytes[end] != b'"' {
            end += if bytes[end] == b'\\' { 2 } else { 1 };
        }
        out.push_str("<stack>\"");
        rest = &after[(end + 1).min(after.len())..];
    }
    out.push_str(rest);
    out
}

/// The replay's calls: path, kind and a valid input (`None`: no input), as JSON text in the TypeScript literal's order.
const CALLS: [(&str, &str, Option<&str>); 12] = [
    ("health", "query", None),
    ("lotBook", "query", Some(r#"{"method":"FIFO"}"#)),
    (
        "pnlOverTime",
        "query",
        Some(r#"{"from":"2026-01-01T00:00:00Z","utcOffsetMinutes":60}"#),
    ),
    ("missingBasis", "query", Some("{}")),
    (
        "basisOverride.set",
        "mutation",
        Some(r#"{"lotId":"l1","pricePerUnit":"1.5","date":"2026-01-01","sourceNote":"n"}"#),
    ),
    (
        "basisOverride.remove",
        "mutation",
        Some(r#"{"lotId":"l1"}"#),
    ),
    (
        "setLotMethod",
        "mutation",
        Some(r#"{"assetId":null,"method":"FIFO"}"#),
    ),
    (
        "setDayMethod",
        "mutation",
        Some(r#"{"day":"2026-01-01","assetId":"BTC","method":"LIFO"}"#),
    ),
    (
        "pickSaleLot",
        "mutation",
        Some(r#"{"saleTxId":"s1","assetId":"BTC","lotId":null}"#),
    ),
    (
        "setIncludeTransfers",
        "mutation",
        Some(r#"{"include":true}"#),
    ),
    ("exportPreview", "query", Some(r#"{"lotMethod":"HIFO"}"#)),
    ("exportPack", "mutation", Some(r#"{"lotMethod":"FIFO"}"#)),
];

/// The seven inputs each call gets, as `JSON.stringify` writes them (`None`: undefined).
fn inputs(valid: Option<&str>) -> Vec<(&'static str, Option<String>)> {
    let extra = match valid.map(|v| json::parse(v).unwrap()) {
        Some(Json::Object(mut fields)) => {
            fields.push(("extra".to_owned(), Json::int(1)));
            Json::Object(fields).compact()
        }
        _ => r#"{"extra":1}"#.to_owned(),
    };
    vec![
        ("valid", valid.map(str::to_owned)),
        ("absent", None),
        ("wrong-type", Some("7".to_owned())),
        ("extra-key", Some(extra)),
        (
            "bad-day",
            Some(r#"{"day":"2026-02-30","assetId":null,"method":"FIFO"}"#.to_owned()),
        ),
        (
            "complete-true",
            Some(r#"{"lotMethod":"FIFO","complete":true}"#.to_owned()),
        ),
        ("average", Some(r#"{"lotMethod":"AVERAGE"}"#.to_owned())),
    ]
}

const CALLERS: [(&str, Option<&[&str]>, &str); 4] = [
    ("anon", None, "DE"),
    ("read", Some(&["tax:read"]), "DE"),
    ("write", Some(&["tax:read", "tax:write"]), "DE"),
    ("write-US", Some(&["tax:read", "tax:write"]), "US"),
];

/// One request as the TypeScript replay's `hit` sends it: its status and body, the stack trace masked.
fn send(
    wire: &Wire,
    path: &str,
    kind: &str,
    input: Option<&str>,
    scopes: Option<&[&str]>,
    region: &str,
) -> (u16, String) {
    let mut headers = headers(scopes, region);
    let (method, url, body) = if kind == "query" {
        let q = input
            .map(|i| format!("?input={}", encode_uri_component(i)))
            .unwrap_or_default();
        ("GET", format!("/trpc/{path}{q}"), String::new())
    } else {
        headers.push(("content-type".to_owned(), "application/json".to_owned()));
        (
            "POST",
            format!("/trpc/{path}"),
            input.unwrap_or_default().to_owned(),
        )
    };
    let res = wire.handle(&Request {
        method,
        url: &url,
        headers: &headers,
        body: &body,
    });
    (res.status, without_stack(&res.body))
}

fn replay() -> BTreeMap<String, (u16, String)> {
    let mut answers = BTreeMap::new();
    for map_raw in ["", r#"["DE"]"#] {
        let wire = serve(map_raw);
        for (path, kind, valid) in CALLS {
            for (input_name, input) in inputs(valid) {
                for (caller, scopes, region) in CALLERS {
                    let res = send(&wire, path, kind, input.as_deref(), scopes, region);
                    let map_name = if map_raw.is_empty() {
                        "blank-map"
                    } else {
                        map_raw
                    };
                    answers.insert(format!("{map_name} {path} {input_name} {caller}"), res);
                }
            }
        }
    }
    answers
}

#[test]
fn every_request_in_the_matrix_gets_the_recorded_status_and_body_byte_for_byte() {
    let golden = json::parse(&std::fs::read_to_string(GOLDEN).unwrap()).unwrap();
    let Some(Json::Object(recorded)) = golden.get("answers") else {
        panic!("no answers in {GOLDEN}")
    };
    assert_eq!(recorded.len(), 672);
    let now = replay();
    assert_eq!(now.len(), 672, "the Rust replay builds the recorded matrix");
    let mut diffs = Vec::new();
    for (key, was) in recorded {
        let status = was
            .get("status")
            .and_then(|s| {
                if let Json::Number(n) = s {
                    Some(*n)
                } else {
                    None
                }
            })
            .unwrap();
        let Some(Json::String(body)) = was.get("body") else {
            panic!("{key}: no body")
        };
        match now.get(key) {
            Some((s, b)) if f64::from(*s) == status && b == body => {}
            Some((s, b)) => diffs.push(format!("{key}: {status} {body}\n  != {s} {b}")),
            None => diffs.push(format!("{key}: not sent")),
        }
    }
    assert!(
        diffs.is_empty(),
        "{} of 672 differ:\n{}",
        diffs.len(),
        diffs.join("\n")
    );
}

#[test]
fn every_call_has_the_recorded_path_kind_and_caller() {
    let golden = json::parse(&std::fs::read_to_string(GOLDEN).unwrap()).unwrap();
    let Some(Json::Array(recorded)) = golden.get("callers") else {
        panic!("no callers in {GOLDEN}")
    };
    let recorded: Vec<(String, String, String)> = recorded
        .iter()
        .map(|c| {
            let s = |k| match c.get(k) {
                Some(Json::String(v)) => v.clone(),
                _ => panic!("caller without {k}"),
            };
            (s("path"), s("type"), s("caller"))
        })
        .collect();
    let now: Vec<(String, String, String)> = wire::callers()
        .into_iter()
        .map(|(p, k, c)| (p.to_owned(), k.to_owned(), c.to_owned()))
        .collect();
    assert_eq!(now, recorded);
}

// ── The rows replay ─────────────────────────────────────────────────────────────────────────────────────────────────

/// The rows replay's valid inputs where the answer replay's name no lot that exists: here the one unknown lot does.
fn rows_valid(path: &str) -> Option<Option<&'static str>> {
    match path {
        "basisOverride.set" => Some(Some(
            r#"{"lotId":"lot:tx-1:BTC","pricePerUnit":"1.5","date":"2026-01-01","sourceNote":"n"}"#,
        )),
        "basisOverride.remove" => Some(Some(r#"{"lotId":"lot:tx-1:BTC"}"#)),
        _ => None,
    }
}

/// One private database (`..._test`) holding the `tax` schema at its production migrations, dropped after.
struct TestDb {
    admin: String,
    name: String,
    url: String,
}

static COUNTER: AtomicUsize = AtomicUsize::new(0);

fn current_database_is_a_test_one(c: &mut Client) {
    let name: String = c
        .query_one("SELECT current_database()", &[])
        .unwrap()
        .get(0);
    assert!(
        name.ends_with("_test"),
        "refusing: {name} is not a test database (its name must end in _test)"
    );
}

impl TestDb {
    fn new() -> Option<TestDb> {
        let pick = |k: &str| {
            std::env::var(k)
                .ok()
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let admin = pick("TEST_DATABASE_URL_TAX").or_else(|| pick("TEST_DATABASE_URL"));
        assert!(
            admin.is_some() || !std::env::var("REQUIRE_POSTGRES").is_ok_and(|v| v == "1"),
            "TEST_DATABASE_URL_TAX or TEST_DATABASE_URL is required"
        );
        let admin = admin?;
        let mut a = Client::connect(&admin, NoTls).expect("the admin database answers");
        current_database_is_a_test_one(&mut a);
        let mut rand = [0u8; 3];
        getrandom::fill(&mut rand).unwrap();
        let name = format!(
            "itf_run_tax_rows_{}_{}_{:02x}{:02x}{:02x}_test",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst),
            rand[0],
            rand[1],
            rand[2]
        );
        a.batch_execute(&format!("CREATE DATABASE \"{name}\""))
            .unwrap();
        let mut parsed = url::Url::parse(&admin).unwrap();
        parsed.set_path(&format!("/{name}"));
        let db = TestDb {
            admin,
            name,
            url: parsed.to_string(),
        };
        let mut c = db.client();
        current_database_is_a_test_one(&mut c);
        c.batch_execute(
            "CREATE EXTENSION IF NOT EXISTS \"pgcrypto\"; CREATE EXTENSION IF NOT EXISTS \"citext\"; CREATE SCHEMA IF NOT EXISTS \"tax\"",
        )
        .unwrap();
        let mut ups: Vec<_> = FILES
            .iter()
            .filter(|(n, _)| !n.ends_with(".down.sql"))
            .collect();
        ups.sort_by_key(|(n, _)| *n);
        for (_, sql) in ups {
            c.batch_execute(sql).unwrap();
        }
        Some(db)
    }

    fn client(&self) -> Client {
        Client::connect(&self.url, NoTls).unwrap()
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        if let Ok(mut a) = Client::connect(&self.admin, NoTls) {
            let _ = a.batch_execute(&format!(
                "DROP DATABASE IF EXISTS \"{}\" WITH (FORCE)",
                self.name
            ));
        }
    }
}

fn safe_ident(s: &str) -> bool {
    s.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `MADE_BY_DATABASE` (`@intafaced/db/testing`): a column default the database makes up on insert, a clock or a
/// random id, so a row comparison sees only that it is set.
fn made_by_database(default: &str) -> bool {
    let d = default.to_ascii_lowercase();
    let call = [
        "now(",
        "clock_timestamp(",
        "statement_timestamp(",
        "transaction_timestamp(",
        "gen_random_uuid(",
    ]
    .iter()
    .any(|f| {
        d.match_indices(f).any(|(at, _)| {
            at == 0 || !d.as_bytes()[at - 1].is_ascii_alphanumeric() && d.as_bytes()[at - 1] != b'_'
        })
    });
    let uuid_v = d.match_indices("uuid_generate_v").any(|(at, m)| {
        let rest = &d.as_bytes()[at + m.len()..];
        let digits = rest.iter().take_while(|b| b.is_ascii_digit()).count();
        digits > 0 && rest.get(digits) == Some(&b'(')
    });
    let word = ["current_timestamp", "current_date", "current_time"]
        .iter()
        .any(|w| {
            d.match_indices(w).any(|(at, m)| {
                let before = at == 0
                    || !(d.as_bytes()[at - 1].is_ascii_alphanumeric()
                        || d.as_bytes()[at - 1] == b'_');
                let after = d
                    .as_bytes()
                    .get(at + m.len())
                    .is_none_or(|b| !(b.is_ascii_alphanumeric() || *b == b'_'));
                before && after
            })
        });
    call || uuid_v || word
}

/// `storedRows` (`@intafaced/db/testing`): every row of the `tax` schema as Postgres's own `to_jsonb` text, read in
/// UTC in one transaction, each line `<table> <row>`, sorted, with values the database makes up masked as `<database>`.
fn stored_rows(c: &mut Client) -> Vec<String> {
    let mut tx = c.transaction().unwrap();
    tx.batch_execute("SET LOCAL TIME ZONE 'UTC'").unwrap();
    let columns = tx
        .query(
            "SELECT table_name::text, column_name::text, column_default::text FROM information_schema.columns
             WHERE table_schema = 'tax' ORDER BY table_name, ordinal_position",
            &[],
        )
        .unwrap();
    let mut tables: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in &columns {
        let (table, column, default): (String, String, Option<String>) =
            (row.get(0), row.get(1), row.get(2));
        let made = tables.entry(table).or_default();
        if default.as_deref().is_some_and(made_by_database) {
            made.push(column);
        }
    }
    let mut lines = Vec::new();
    for (table, made) in &tables {
        assert!(safe_ident(table), "refusing to read rows of {table}");
        let mask: String = made
            .iter()
            .map(|c| {
                assert!(safe_ident(c), "refusing to read rows with column {table}.{c}");
                format!(" || jsonb_build_object('{c}', CASE WHEN t.\"{c}\" IS NULL THEN NULL ELSE '<database>' END)")
            })
            .collect();
        for row in tx
            .query(
                &format!("SELECT (to_jsonb(t){mask})::text FROM \"tax\".\"{table}\" t"),
                &[],
            )
            .unwrap()
        {
            let text: String = row.get(0);
            lines.push(format!("{table} {text}"));
        }
    }
    tx.commit().unwrap();
    lines.sort();
    lines
}

/// `rowsChange`: the lines new after a call, and the lines gone (sorted). A changed row is one of each.
fn rows_change(before: &[String], after: &[String]) -> (Vec<String>, Vec<String>) {
    let mut left: BTreeMap<&str, usize> = BTreeMap::new();
    for line in before {
        *left.entry(line).or_default() += 1;
    }
    let mut added = Vec::new();
    for line in after {
        match left.get_mut(line.as_str()) {
            Some(n) if *n > 0 => *n -= 1,
            _ => added.push(line.clone()),
        }
    }
    let mut removed: Vec<String> = left
        .into_iter()
        .flat_map(|(line, n)| std::iter::repeat_n(line.to_owned(), n))
        .collect();
    removed.sort();
    (added, removed)
}

type RowsAnswer = (u16, String, Vec<String>, Vec<String>);

fn replay_rows(db: &TestDb) -> BTreeMap<String, RowsAnswer> {
    let pool = Arc::new(Pool::new(&db.url, 8));
    let wire = serve_with(
        r#"["DE"]"#,
        Arc::new(OneUnknownLot),
        Some((
            Arc::new(PgBasisStore::new(pool.clone())),
            Arc::new(PgChoiceStore::new(pool)),
        )),
    );
    let mut reader = db.client();
    let mut answers = BTreeMap::new();
    for (path, kind, valid) in CALLS {
        for (input_name, input) in inputs(rows_valid(path).unwrap_or(valid)) {
            for (caller, scopes, region) in CALLERS {
                let before = stored_rows(&mut reader);
                let (status, body) = send(&wire, path, kind, input.as_deref(), scopes, region);
                let (added, removed) = rows_change(&before, &stored_rows(&mut reader));
                answers.insert(
                    format!("{path} {input_name} {caller}"),
                    (status, body, added, removed),
                );
            }
        }
    }
    answers
}

fn strings(v: Option<&Json>) -> Vec<String> {
    match v {
        None => Vec::new(),
        Some(Json::Array(a)) => a
            .iter()
            .map(|s| match s {
                Json::String(s) => s.clone(),
                other => panic!("not a row line: {other:?}"),
            })
            .collect(),
        Some(other) => panic!("not a list of rows: {other:?}"),
    }
}

#[test]
fn every_request_in_the_matrix_leaves_the_rows_the_typescript_service_left() {
    let Some(db) = TestDb::new() else {
        eprintln!("skipped: no TEST_DATABASE_URL_TAX or TEST_DATABASE_URL");
        return;
    };
    let golden = json::parse(&std::fs::read_to_string(ROWS_GOLDEN).unwrap()).unwrap();
    let Some(Json::Object(recorded)) = golden.get("answers") else {
        panic!("no answers in {ROWS_GOLDEN}")
    };
    assert_eq!(recorded.len(), 336);
    // Some request must have written, or this replay compares nothing.
    assert!(
        recorded
            .iter()
            .any(|(_, a)| !strings(a.get("added")).is_empty()),
        "no recorded request wrote a row"
    );
    let now = replay_rows(&db);
    assert_eq!(now.len(), 336, "the Rust replay builds the recorded matrix");
    let shown = |status: f64, body: &str, added: &[String], removed: &[String]| {
        let cut: String = body.chars().take(120).collect();
        format!("{status} {cut} +{added:?} -{removed:?}")
    };
    let mut diffs = Vec::new();
    for (key, was) in recorded {
        let Some(Json::Number(status)) = was.get("status") else {
            panic!("{key}: no status")
        };
        let Some(Json::String(body)) = was.get("body") else {
            panic!("{key}: no body")
        };
        let (added, removed) = (strings(was.get("added")), strings(was.get("removed")));
        match now.get(key) {
            Some((s, b, a, r))
                if f64::from(*s) == *status && b == body && *a == added && *r == removed => {}
            Some((s, b, a, r)) => diffs.push(format!(
                "{key}: {}\n  != {}",
                shown(*status, body, &added, &removed),
                shown(f64::from(*s), b, a, r)
            )),
            None => diffs.push(format!("{key}: not sent")),
        }
    }
    assert!(
        diffs.is_empty(),
        "{} of 336 differ:\n{}",
        diffs.len(),
        diffs.join("\n")
    );
}
