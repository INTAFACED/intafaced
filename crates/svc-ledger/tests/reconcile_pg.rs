//! The `reconcile` slice against a real Postgres, each test in its own throwaway database (`support`). Without a URL it
//! skips; with `REQUIRE_POSTGRES=1` it fails.
//!
//! The TypeScript proofs it ports, case for case: `reconcile-snapshot.test.ts`, `reconcile-proof-failure.test.ts`,
//! `reconcile-timeout-regression.test.ts`, `snapshot-anchor.test.ts`, the real-book half of
//! `scheduled-reconcile-tick.test.ts`, the reconcile cases of `postgres-ledger.test.ts`, `tx-hash-bind.test.ts`,
//! `service.freeze.test.ts` ("reconciliation freezes durably") and `operator-http.test.ts` ("reconcile is
//! reachable"). The tick's cases with no book are `reconcile_tick.rs`.
//!
//! Posting is the `posting` slice's, so the book is written here as `PostgresLedger.post` writes a deposit: the rail
//! leg and the user leg, their balances, the chain hash, the posted-key claim and the tip, in one transaction, and
//! refused while posting is frozen. Where a TypeScript case swaps a driver method mid-run, the case here plants the same
//! failure in the database instead, and says so.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use crate::support;

use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::time::{Duration, Instant as Clock};

use postgres::{Client, NoTls};
use service_kit::json::{self, Json};
use service_kit::telemetry::Logger;
use service_kit::time::Instant;
use support::TestDb;
use support::operator::{OPERATOR, call, code, door_config, stub, treasury};
use svc_ledger::chain::{HashEntry, HashTx, hash_tx};
use svc_ledger::clock::system_ms;
use svc_ledger::db::{self, Store, StoreError, with_client};
use svc_ledger::door::LedgerDoor;
use svc_ledger::freeze::{FreezeRelay, MemoryBus};
use svc_ledger::migrate::FILES;
use svc_ledger::reconcile::{
    self, Balances, Chain, CustodyLayer, CustomerCheck, CustomerHit, DEFAULT_STATEMENT_TIMEOUT_MS,
    Phase, ProofError, ProofWord, RECONCILE_IN_PROGRESS, RECONCILE_INCOMPLETE, RECONCILE_LOCK_SQL,
    Report, SnapshotOptions, SnapshotRun, Unfinished,
};
use svc_ledger::reconciler::{
    DRIFT_SUBJECT, RUN_FAILED_SUBJECT, Reconciler, TickOptions, TickState, tick,
};
use svc_ledger::status::{self, FreezeState, read_freeze};

const USER: &str = "55555555-5555-4555-8555-555555555555";
const USER_B: &str = "66666666-6666-4666-8666-666666666666";
const TEN: service_kit::money::Amount = service_kit::money::Amount::whole(10);
/// 20 integer digits: fits `numeric(38,18)`. Twice that does not.
const FITS: &str = "60000000000000000000";
const FROZEN_LOG: &str =
    "LEDGER RECONCILIATION FAILED — posting frozen, operator attention required";
const INCOMPLETE_LOG: &str = "LEDGER RECONCILIATION INCOMPLETE — the book was NOT verified and NOT frozen, operator attention required";
const STALE_LOG: &str = "LEDGER RECONCILIATION STALE — the book is NOT verified, posting unchanged, operator attention required";

static RAIL_REF: AtomicUsize = AtomicUsize::new(0);

/// One test's book: a migrated database, the ledger's pool on it, and a bus that keeps what it is given.
struct Book {
    db: TestDb,
    store: Store,
    bus: MemoryBus,
}

fn book() -> Option<Book> {
    let db = TestDb::new()?;
    db.migrate(&FILES, false).unwrap();
    let store = db.store();
    Some(Book {
        db,
        store,
        bus: MemoryBus::default(),
    })
}

fn green() -> Report {
    Report {
        ok: true,
        ran_at_ms: system_ms(),
        balances: Balances {
            ok: true,
            drift: Vec::new(),
            accounts_checked: 1,
        },
        chain: Chain::Ok { length: 1 },
        totals: vec![("USDT".to_owned(), "0".to_owned())],
        unbalanced_assets: Vec::new(),
        result: ProofWord::Matched,
        customer_balances: None,
        incomplete_checks: Vec::new(),
        corrupt_amount_fields: Vec::new(),
    }
}

fn failed() -> Report {
    Report {
        ok: false,
        balances: Balances {
            ok: false,
            drift: Vec::new(),
            accounts_checked: 1,
        },
        totals: vec![("USDT".to_owned(), "1".to_owned())],
        unbalanced_assets: vec!["USDT".to_owned()],
        result: ProofWord::Mismatch,
        ..green()
    }
}

fn opts(timeout_ms: i64, custody: CustodyLayer) -> SnapshotOptions<'static> {
    SnapshotOptions {
        statement_timeout_ms: timeout_ms,
        custody,
        now_ms: system_ms,
        prove: None,
        reserve_failure: None,
    }
}

fn on() -> SnapshotOptions<'static> {
    opts(DEFAULT_STATEMENT_TIMEOUT_MS, CustodyLayer::On)
}

impl Book {
    fn reconciler(&self, custody: CustodyLayer, timeout_ms: i64) -> Reconciler<'_> {
        Reconciler {
            store: &self.store,
            relay: FreezeRelay {
                bus: &self.bus,
                producer: "svc-ledger".to_owned(),
                now_ms: system_ms,
            },
            custody,
            statement_timeout_ms: timeout_ms,
            now_ms: system_ms,
            controls: None,
        }
    }

    fn ledger(&self) -> Reconciler<'_> {
        self.reconciler(CustodyLayer::On, DEFAULT_STATEMENT_TIMEOUT_MS)
    }

    /// A session as the ledger's own connections open: `search_path` on `ledger`, so the lock key is the ledger's.
    fn session(&self) -> Client {
        Client::connect(
            &db::connection_url(&self.db.url, "svc-ledger").unwrap(),
            NoTls,
        )
        .unwrap()
    }

    fn sql(&self, statement: &str) {
        self.session().batch_execute(statement).unwrap();
    }

    fn texts(&self, query: &str) -> Vec<Vec<Option<String>>> {
        self.session()
            .query(query, &[])
            .unwrap()
            .iter()
            .map(|r| (0..r.len()).map(|i| r.get(i)).collect())
            .collect()
    }

    fn one(&self, query: &str) -> Option<String> {
        self.texts(query)
            .into_iter()
            .next()
            .and_then(|r| r.into_iter().next())
            .flatten()
    }

    fn count(&self, table: &str) -> i64 {
        self.db
            .count(&format!("SELECT count(*) FROM ledger.{table}"))
    }

    fn outcomes(&self) -> Vec<String> {
        self.texts("SELECT outcome FROM ledger.reconcile_runs ORDER BY id")
            .into_iter()
            .map(|r| r[0].clone().unwrap())
            .collect()
    }

    fn runs(&self) -> Vec<(String, Option<String>)> {
        self.texts("SELECT outcome, error_code FROM ledger.reconcile_runs ORDER BY id")
            .into_iter()
            .map(|r| (r[0].clone().unwrap(), r[1].clone()))
            .collect()
    }

    fn freeze_state(&self) -> FreezeState {
        with_client(self.store.pool().unwrap(), read_freeze).unwrap()
    }

    fn status(&self) -> status::Status {
        status::status(&self.store).unwrap()
    }

    /// `recipes.deposit` booked as `PostgresLedger.post` books it; `Err` carries the refusal's code.
    fn deposit_to(&self, user: &str, amount: service_kit::money::Amount) -> Result<String, String> {
        let rail_ref = format!("rc-{}", RAIL_REF.fetch_add(1, Ordering::SeqCst));
        let mut c = self.session();
        let mut tx = c.transaction().map_err(|e| e.to_string())?;
        tx.batch_execute("SET LOCAL lock_timeout = '5s'")
            .map_err(|e| e.to_string())?;
        let frozen: bool = tx
            .query_one(
                "SELECT frozen FROM ledger.posting_freeze WHERE id = true",
                &[],
            )
            .unwrap()
            .get(0);
        if frozen {
            return Err("ledger.frozen".to_owned());
        }
        let tip = tx
            .query_one(
                "SELECT hash FROM ledger.chain_tip WHERE id = true FOR UPDATE",
                &[],
            )
            .map_err(|e| e.to_string())?;
        let previous: Option<String> = tip.get(0);
        let mut legs = Vec::new();
        for (owner_type, owner_id, direction) in
            [("treasury", "rail:test", "credit"), ("user", user, "debit")]
        {
            tx.execute(
                "INSERT INTO ledger.accounts (owner_type, owner_id, asset_id, kind)
                 VALUES ($1::text::ledger.owner_type, $2, 'USDT', 'available')
                 ON CONFLICT DO NOTHING",
                &[&owner_type, &owner_id],
            )
            .unwrap();
            let row = tx
                .query_one(
                    "SELECT id::text, balance::text FROM ledger.accounts
                      WHERE owner_type = $1::text::ledger.owner_type AND owner_id = $2 AND asset_id = 'USDT'
                        AND kind = 'available' AND purpose = ''",
                    &[&owner_type, &owner_id],
                )
                .unwrap();
            let id: String = row.get(0);
            let balance = service_kit::money::parse_amount(&row.get::<_, String>(1)).unwrap();
            let after = if direction == "debit" {
                balance + amount
            } else {
                balance - amount
            };
            legs.push((id, direction, after));
        }
        let id: String = tx
            .query_one("SELECT gen_random_uuid()::text", &[])
            .unwrap()
            .get(0);
        let posted_at_ms = system_ms();
        let entries: Vec<HashEntry<'_>> = legs
            .iter()
            .map(|(account, direction, _)| HashEntry {
                account_id: account,
                asset_id: "USDT",
                direction,
                amount,
            })
            .collect();
        let hash = hash_tx(
            &HashTx {
                id: &id,
                module: "ledger",
                reason: "deposit.credited",
                posted_at_ms,
                entries: &entries,
            },
            previous.as_deref(),
        )
        .unwrap();
        let key = format!("deposit:test:{rail_ref}");
        let meta = format!("{{\"rail\":\"test\",\"railRef\":\"{rail_ref}\"}}");
        let seq: String = tx
            .query_one(
                "INSERT INTO ledger.ledger_tx (id, idempotency_key, module, reason, meta, posted_at, hash, previous_hash)
                 VALUES ($1::text::uuid, $2, 'ledger', 'deposit.credited', $3::text::jsonb, $4::text::timestamptz, $5, $6)
                 RETURNING seq::text",
                &[&id, &key, &meta, &Instant(posted_at_ms).iso(), &hash, &previous],
            )
            .unwrap()
            .get(0);
        tx.execute(
            "INSERT INTO ledger.ledger_posted_keys (idempotency_key, tx_id, posted_hash, posted_meta)
             VALUES ($1, $2::text::uuid, $3, $4::text::jsonb)",
            &[&key, &id, &hash, &meta],
        )
        .unwrap();
        let amount_text = service_kit::money::format_amount(amount);
        for (account, direction, after) in &legs {
            let after = service_kit::money::format_amount(*after);
            tx.execute(
                "INSERT INTO ledger.ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
                 VALUES ($1::text::uuid, $2::text::uuid, 'USDT', $3::text::ledger.direction, $4::text::numeric, $5::text::numeric)",
                &[&id, account, direction, &amount_text, &after],
            )
            .unwrap();
            tx.execute(
                "UPDATE ledger.accounts SET balance = $2::text::numeric WHERE id = $1::text::uuid",
                &[account, &after],
            )
            .unwrap();
        }
        tx.execute(
            "UPDATE ledger.chain_tip SET hash = $1, seq = $2::text::bigint, updated_at = now() WHERE id = true",
            &[&hash, &seq],
        )
        .unwrap();
        tx.commit().map_err(|e| e.to_string())?;
        Ok(id)
    }

    fn deposit(&self) -> Result<String, String> {
        self.deposit_to(USER, TEN)
    }

    /// `withJournalGuardsOff(['update', 'balance'])` and the posted-key guard: a tamper the triggers would refuse.
    fn tamper(&self, statements: &str) {
        let guards = [
            ("ledger_entries", "ledger_entries_immutable"),
            ("ledger_tx", "ledger_tx_immutable"),
            ("ledger_tx", "ledger_tx_key_immutable"),
            ("ledger_entries", "ledger_entries_tx_must_balance"),
            ("ledger_posted_keys", "ledger_posted_keys_immutable"),
        ];
        let toggle = |verb: &str| {
            guards
                .iter()
                .map(|(t, g)| format!("ALTER TABLE ledger.{t} {verb} TRIGGER {g};"))
                .collect::<String>()
        };
        self.sql(&format!(
            "{}{statements};{}",
            toggle("DISABLE"),
            toggle("ENABLE")
        ));
    }

    /// `rehashBook`: every row's hash recomputed from what is stored now, its claim and the tip moved with it.
    fn rehash(&self) {
        let mut c = self.session();
        let txs = c
            .query(
                "SELECT id::text, module, reason, floor(extract(epoch FROM posted_at) * 1000)::bigint
                   FROM ledger.ledger_tx ORDER BY seq",
                &[],
            )
            .unwrap();
        let mut previous: Option<String> = None;
        let mut updates = String::new();
        for t in &txs {
            let id: String = t.get(0);
            let rows = c
                .query(
                    "SELECT account_id::text, asset_id, direction::text, amount::text
                       FROM ledger.ledger_entries WHERE tx_id = $1::text::uuid ORDER BY id",
                    &[&id],
                )
                .unwrap();
            let owned: Vec<(String, String, String, service_kit::money::Amount)> = rows
                .iter()
                .map(|r| {
                    (
                        r.get(0),
                        r.get(1),
                        r.get(2),
                        service_kit::money::parse_amount(&r.get::<_, String>(3)).unwrap(),
                    )
                })
                .collect();
            let entries: Vec<HashEntry<'_>> = owned
                .iter()
                .map(|(a, s, d, v)| HashEntry {
                    account_id: a,
                    asset_id: s,
                    direction: d,
                    amount: *v,
                })
                .collect();
            let hash = hash_tx(
                &HashTx {
                    id: &id,
                    module: &t.get::<_, String>(1),
                    reason: &t.get::<_, String>(2),
                    posted_at_ms: t.get(3),
                    entries: &entries,
                },
                previous.as_deref(),
            )
            .unwrap();
            let prev = previous
                .as_ref()
                .map_or("NULL".to_owned(), |p| format!("'{p}'"));
            updates.push_str(&format!(
                "UPDATE ledger.ledger_tx SET hash = '{hash}', previous_hash = {prev} WHERE id = '{id}';
                 UPDATE ledger.ledger_posted_keys SET posted_hash = '{hash}' WHERE tx_id = '{id}';"
            ));
            previous = Some(hash);
        }
        let tip = previous.map_or("NULL".to_owned(), |p| format!("'{p}'"));
        updates.push_str(&format!(
            "UPDATE ledger.chain_tip SET hash = {tip} WHERE id = true"
        ));
        self.tamper(&updates);
    }

    /// A session holding `statement` inside an open transaction until it is dropped.
    fn hold(&self, statement: &str) -> Client {
        let mut c = self.session();
        c.batch_execute(&format!("BEGIN; {statement}")).unwrap();
        c
    }

    fn refuse_inserts(&self, table: &str, name: &str) {
        self.sql(&format!(
            "CREATE FUNCTION ledger.{name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'run table refused'; END $$;
             CREATE TRIGGER {name} BEFORE INSERT ON ledger.{table} FOR EACH ROW EXECUTE FUNCTION ledger.{name}();"
        ));
    }
}

fn mismatch_report(run: &SnapshotRun) -> &Report {
    match run {
        SnapshotRun::Mismatch { report, .. } => report,
        other => panic!("expected a mismatch, got {other:?}"),
    }
}

fn incomplete_of(run: &SnapshotRun) -> (Phase, &str) {
    match run {
        SnapshotRun::Incomplete {
            phase, error_code, ..
        } => (*phase, error_code),
        other => panic!("expected an incomplete run, got {other:?}"),
    }
}

/// A logger whose fatal lines can be read back.
#[derive(Clone, Default)]
struct Sink(Arc<Mutex<Vec<u8>>>);

impl Write for Sink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Sink {
    fn logger(&self) -> Logger {
        Logger::new("info", Box::new(self.clone()))
    }

    fn fatal(&self) -> Vec<Json> {
        String::from_utf8(self.0.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(|l| json::parse(l).unwrap())
            .filter(|j| j.get("level") == Some(&Json::int(60)))
            .collect()
    }

    fn messages(&self) -> Vec<String> {
        self.fatal()
            .iter()
            .map(|j| match j.get("msg") {
                Some(Json::String(m)) => m.clone(),
                _ => String::new(),
            })
            .collect()
    }
}

fn tick_options(max_stale_hours: Option<i64>) -> TickOptions {
    TickOptions {
        max_stale_hours,
        max_consecutive_incomplete: 3,
        now_ms: system_ms,
    }
}

// ── reconcile-snapshot.test.ts ─────────────────────────────────────────────────────────────────────────────────────

#[test]
fn a_post_commits_while_the_proof_runs_and_is_not_in_its_verdict() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    let posted = AtomicBool::new(false);
    let prove = |c: &mut Client| -> Result<Report, ProofError> {
        // The snapshot is open: a post on another connection completes (no lock on chain_tip is held).
        b.deposit().expect("a post blocked behind the proof");
        posted.store(true, Ordering::SeqCst);
        let seq: String = c
            .query_one(
                "SELECT seq::text FROM ledger.chain_tip WHERE id = true",
                &[],
            )?
            .get(0);
        assert_eq!(seq, "1", "the snapshot still sees only the first post");
        Ok(green())
    };
    let run = reconcile::run_snapshot(
        &b.store,
        &SnapshotOptions {
            prove: Some(&prove),
            ..on()
        },
    )
    .unwrap();
    assert!(posted.load(Ordering::SeqCst));
    assert!(matches!(run, SnapshotRun::Ok { ref tip, .. } if tip.seq == "1"));
    assert_eq!(
        b.one("SELECT seq::text FROM ledger.chain_tip").as_deref(),
        Some("2")
    );
}

#[test]
fn the_real_proof_stays_ok_while_posts_keep_landing() {
    let Some(b) = book() else { return };
    for _ in 0..5 {
        b.deposit().unwrap();
    }
    let stop = AtomicBool::new(false);
    std::thread::scope(|s| {
        s.spawn(|| {
            while !stop.load(Ordering::SeqCst) {
                b.deposit().unwrap();
            }
        });
        for _ in 0..3 {
            let report = b.ledger().reconcile();
            stop.store(report.as_ref().map_or(true, |r| !r.ok), Ordering::SeqCst);
            assert!(report.unwrap().ok);
        }
        stop.store(true, Ordering::SeqCst);
    });
}

#[test]
fn a_run_is_skipped_writing_nothing_while_another_holds_the_lock() {
    let Some(b) = book() else { return };
    let mut holder = b.session();
    holder
        .batch_execute(&format!("SELECT pg_advisory_lock({RECONCILE_LOCK_SQL})"))
        .unwrap();
    assert_eq!(
        reconcile::run_snapshot(&b.store, &on()).unwrap(),
        SnapshotRun::Skipped
    );
    assert_eq!(b.count("reconcile_runs"), 0);
    assert_eq!(b.count("balance_snapshots"), 0);
    // The operator door says so instead of reporting a verdict.
    assert_eq!(
        b.ledger().reconcile().unwrap_err().code.as_deref(),
        Some(RECONCILE_IN_PROGRESS)
    );
    holder
        .batch_execute(&format!("SELECT pg_advisory_unlock({RECONCILE_LOCK_SQL})"))
        .unwrap();
    assert!(matches!(
        reconcile::run_snapshot(&b.store, &on()).unwrap(),
        SnapshotRun::Ok { .. }
    ));
}

#[test]
fn two_runs_started_together_one_proves_and_the_other_skips() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    let entered = Barrier::new(2);
    let release = Barrier::new(2);
    let prove = |_: &mut Client| -> Result<Report, ProofError> {
        entered.wait();
        release.wait();
        Ok(green())
    };
    std::thread::scope(|s| {
        let first = s.spawn(|| {
            reconcile::run_snapshot(
                &b.store,
                &SnapshotOptions {
                    prove: Some(&prove),
                    ..on()
                },
            )
            .unwrap()
        });
        entered.wait();
        let second = reconcile::run_snapshot(&b.store, &on()).unwrap();
        release.wait();
        assert_eq!(second, SnapshotRun::Skipped);
        assert!(matches!(first.join().unwrap(), SnapshotRun::Ok { .. }));
    });
}

#[test]
fn single_flight_holds_through_the_short_snapshot_write() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    let blocker = b.hold("SELECT id FROM ledger.accounts FOR UPDATE");
    let backend = AtomicI32::new(0);
    let prove = |c: &mut Client| -> Result<Report, ProofError> {
        backend.store(
            c.query_one("SELECT pg_backend_pid()", &[])?.get(0),
            Ordering::SeqCst,
        );
        reconcile::run_reconciliation(c, CustodyLayer::On, system_ms)
    };
    std::thread::scope(|s| {
        let first = s.spawn(|| {
            reconcile::run_snapshot(
                &b.store,
                &SnapshotOptions {
                    prove: Some(&prove),
                    ..on()
                },
            )
            .unwrap()
        });
        let mut waiting = false;
        let mut watch = b.session();
        for _ in 0..500 {
            let pid = backend.load(Ordering::SeqCst);
            if pid != 0
                && !watch
                    .query(
                        "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'
                           AND query LIKE '%INSERT INTO ledger.balance_snapshots%'",
                        &[&pid],
                    )
                    .unwrap()
                    .is_empty()
            {
                waiting = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(waiting, "the run never reached its snapshot write");
        assert_eq!(
            reconcile::run_snapshot(&b.store, &on()).unwrap(),
            SnapshotRun::Skipped
        );
        drop(blocker);
        assert!(matches!(first.join().unwrap(), SnapshotRun::Ok { .. }));
    });
    assert_eq!(b.outcomes(), ["ok"]);
}

// The TypeScript fails the advisory unlock by swapping the driver's method and checks the posting pool survives. Here
// the proof's session is its own connection, never one of the pool's, so the case is: a pool of one stays usable
// while the proof holds its session, and after.
#[test]
fn the_proof_holds_its_own_session_and_a_pool_of_one_stays_usable() {
    let Some(b) = book() else { return };
    let single = db::open(&b.db.url, "svc-ledger", 1, false).unwrap();
    let prove = |c: &mut Client| -> Result<Report, ProofError> {
        with_client(single.pool()?, |p| Ok(p.batch_execute("SELECT 1")?))?;
        reconcile::run_reconciliation(c, CustodyLayer::On, system_ms)
    };
    let first = reconcile::run_snapshot(
        &single,
        &SnapshotOptions {
            prove: Some(&prove),
            ..on()
        },
    )
    .unwrap();
    assert!(matches!(first, SnapshotRun::Ok { .. }));
    with_client(single.pool().unwrap(), |p| Ok(p.batch_execute("SELECT 1")?)).unwrap();
    b.deposit().unwrap();
    assert!(matches!(
        reconcile::run_snapshot(&single, &on()).unwrap(),
        SnapshotRun::Ok { .. }
    ));
}

#[test]
fn a_finished_structural_mismatch_commits_its_halt_and_intent_with_no_caller_publishing() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    b.sql("DELETE FROM ledger.chain_tip WHERE id = true");
    let run = reconcile::run_snapshot(&b.store, &on()).unwrap();
    assert_eq!(mismatch_report(&run).chain.broken_at(), Some("chain_tip"));
    assert_eq!(b.outcomes(), ["mismatch"]);
    let s = b.freeze_state();
    assert!(s.frozen);
    assert_eq!(s.actor.as_deref(), Some("reconciliation"));
    assert_eq!(
        b.db.count("SELECT count(*) FROM ledger.ledger_freeze_outbox WHERE published_at IS NULL"),
        1
    );
}

#[test]
fn a_non_finite_persisted_amount_is_corruption_and_freezes() {
    for field in [
        "accounts.balance",
        "ledger_entries.amount",
        "ledger_entries.balance_after",
    ] {
        let Some(b) = book() else { return };
        b.deposit().unwrap();
        match field {
            "accounts.balance" => {
                b.sql(
                    "UPDATE ledger.accounts SET balance = 'NaN'::numeric WHERE owner_type = 'user'",
                );
            }
            _ => {
                let column = field.trim_start_matches("ledger_entries.");
                b.tamper(&format!(
                    "UPDATE ledger.ledger_entries SET {column} = 'NaN'::numeric WHERE id = (SELECT min(id) FROM ledger.ledger_entries)"
                ));
            }
        }
        let run = b.ledger().run_scheduled_default().unwrap();
        let report = mismatch_report(&run);
        if field == "ledger_entries.balance_after" {
            assert!(!report.chain.ok());
            assert_ne!(report.chain.broken_at(), Some("incomplete"));
        } else {
            assert!(
                report.corrupt_amount_fields.contains(&field.to_owned()),
                "{field}: {:?}",
                report.corrupt_amount_fields
            );
        }
        assert_eq!(b.outcomes(), ["mismatch"]);
        let s = b.status();
        assert!(!s.posting_enabled);
        assert_eq!(s.frozen_reason.as_deref(), Some("reconciliation mismatch"));
        assert_eq!(b.deposit().unwrap_err(), "ledger.frozen");
    }
}

#[test]
fn a_finished_balance_mismatch_survives_a_sibling_chain_timeout_and_still_freezes() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    b.sql("UPDATE ledger.accounts SET balance = balance + 1 WHERE owner_type = 'user'");
    let blocker = b.hold("LOCK TABLE ledger.ledger_tx IN ACCESS EXCLUSIVE MODE");
    let run = b
        .ledger()
        .run_scheduled(&opts(1_000, CustodyLayer::On))
        .unwrap();
    drop(blocker);
    let report = mismatch_report(&run);
    assert!(!report.balances.ok);
    assert_eq!(report.balances.drift[0].difference, "1");
    assert!(report.incomplete_checks.contains(&Unfinished {
        check: "chain",
        error_code: "57014".to_owned()
    }));
    let s = b.status();
    assert!(!s.posting_enabled);
    assert_eq!(s.frozen_reason.as_deref(), Some("reconciliation mismatch"));
    assert_eq!(b.outcomes(), ["mismatch"]);
}

#[test]
fn clean_partial_checks_then_a_chain_timeout_stay_incomplete_and_never_freeze() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    let blocker = b.hold("LOCK TABLE ledger.ledger_tx IN ACCESS EXCLUSIVE MODE");
    let run = b
        .ledger()
        .run_scheduled(&opts(1_000, CustodyLayer::On))
        .unwrap();
    drop(blocker);
    assert_eq!(incomplete_of(&run), (Phase::Proof, "57014"));
    assert!(b.status().posting_enabled);
}

#[test]
fn last_verified_never_moves_back_to_an_older_prefix() {
    let Some(b) = book() else { return };
    b.sql("INSERT INTO ledger.reconcile_runs (started_at, outcome, through_seq) VALUES (now(), 'ok', 20), (now(), 'ok', 10)");
    assert_eq!(
        reconcile::read_last_verified(&b.store)
            .unwrap()
            .seq
            .as_deref(),
        Some("20")
    );
}

#[test]
fn the_per_run_statement_timeout_is_set_inside_the_transaction_only() {
    let Some(b) = book() else { return };
    let seen = Mutex::new(Vec::<String>::new());
    let prove = |c: &mut Client| -> Result<Report, ProofError> {
        seen.lock()
            .unwrap()
            .push(c.query_one("SHOW statement_timeout", &[])?.get(0));
        Ok(green())
    };
    for timeout in [DEFAULT_STATEMENT_TIMEOUT_MS, 2_000] {
        reconcile::run_snapshot(
            &b.store,
            &SnapshotOptions {
                prove: Some(&prove),
                ..opts(timeout, CustodyLayer::On)
            },
        )
        .unwrap();
    }
    assert_eq!(*seen.lock().unwrap(), ["10min", "2s"]);
    // SET LOCAL: the pool's own setting is untouched afterwards.
    reconcile::run_snapshot(&b.store, &on()).unwrap();
    let pooled: String = with_client(b.store.pool().unwrap(), |c| {
        Ok(c.query_one("SHOW statement_timeout", &[])?.get(0))
    })
    .unwrap();
    assert_eq!(pooled, "15s");
}

#[test]
fn a_statement_timeout_outside_its_bounds_is_refused_before_sql() {
    let Some(b) = book() else { return };
    for bad in [0, 999, 3_600_001] {
        assert!(reconcile::run_snapshot(&b.store, &opts(bad, CustodyLayer::On)).is_err());
    }
    assert_eq!(b.count("reconcile_runs"), 0);
}

#[test]
fn a_real_timeout_is_incomplete_recorded_rolled_back_and_not_frozen() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    let blocker = b.hold("LOCK TABLE ledger.ledger_entries IN ACCESS EXCLUSIVE MODE");
    let refused = b
        .reconciler(CustodyLayer::On, 1_000)
        .reconcile()
        .unwrap_err();
    drop(blocker);
    assert_eq!(refused.code.as_deref(), Some(RECONCILE_INCOMPLETE));
    assert!(b.status().posting_enabled);
    assert_eq!(
        b.runs(),
        [("incomplete".to_owned(), Some("57014".to_owned()))]
    );
    assert_eq!(b.count("balance_snapshots"), 0);
    b.deposit().unwrap();
}

#[test]
fn a_snapshot_foreign_key_timeout_is_incomplete_leaves_no_anchor_and_retries() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    // Snapshot reads still work; the anchor insert waits for the account FK's KEY SHARE lock.
    let blocker = b.hold("SELECT id FROM ledger.accounts FOR UPDATE");
    let run = b
        .ledger()
        .run_scheduled(&opts(1_000, CustodyLayer::On))
        .unwrap();
    drop(blocker);
    assert_eq!(incomplete_of(&run), (Phase::Snapshot, "57014"));
    assert!(b.status().posting_enabled);
    assert_eq!(b.count("balance_snapshots"), 0);
    assert_eq!(b.count("ledger_freeze_outbox"), 0);
    assert_eq!(
        b.runs(),
        [("incomplete".to_owned(), Some("57014".to_owned()))]
    );
    assert!(matches!(
        b.ledger()
            .run_scheduled(&opts(1_000, CustodyLayer::On))
            .unwrap(),
        SnapshotRun::Ok { .. }
    ));
    b.deposit().unwrap();
}

#[test]
fn a_mismatch_freezes_records_the_run_writes_no_snapshot_and_returns_the_report() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    b.sql("UPDATE ledger.accounts SET balance = balance + 1 WHERE owner_type = 'user'");
    let report = b.ledger().reconcile().unwrap();
    assert!(!report.ok);
    assert!(!report.balances.ok);
    let s = b.status();
    assert!(!s.posting_enabled);
    assert_eq!(s.frozen_reason.as_deref(), Some("reconciliation mismatch"));
    assert_eq!(s.frozen_by.as_deref(), Some("reconciliation"));
    assert_eq!(
        b.texts("SELECT outcome, through_seq::text FROM ledger.reconcile_runs"),
        [[Some("mismatch".to_owned()), Some("1".to_owned())]]
    );
    assert_eq!(b.count("balance_snapshots"), 0);
}

#[test]
fn a_mismatch_survives_a_failed_run_row_insert_and_the_caller_still_freezes() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    b.sql("UPDATE ledger.accounts SET balance = balance + 1 WHERE owner_type = 'user'");
    b.refuse_inserts("reconcile_runs", "refuse_run");
    let run = b.ledger().run_scheduled_default().unwrap();
    assert!(matches!(run, SnapshotRun::Mismatch { run_id: None, .. }));
    let s = b.status();
    assert!(!s.posting_enabled);
    assert_eq!(s.frozen_reason.as_deref(), Some("reconciliation mismatch"));
}

#[test]
fn an_incomplete_run_whose_row_cannot_be_written_is_still_returned() {
    let Some(b) = book() else { return };
    b.refuse_inserts("reconcile_runs", "refuse_run2");
    let prove = |c: &mut Client| -> Result<Report, ProofError> {
        c.batch_execute("SELECT 'not-a-number'::int")?;
        panic!("expected the cast to fail");
    };
    let run = reconcile::run_snapshot(
        &b.store,
        &SnapshotOptions {
            prove: Some(&prove),
            ..on()
        },
    )
    .unwrap();
    assert!(matches!(
        run,
        SnapshotRun::Incomplete {
            phase: Phase::Proof,
            run_id: None,
            record_error: Some(_),
            ..
        }
    ));
}

// The gauge half of the TypeScript case is `store_pg.rs`, which reads them through `GET /metrics`.
#[test]
fn last_verified_and_health_follow_the_latest_ok_run() {
    let Some(b) = book() else { return };
    let before = reconcile::read_last_verified(&b.store).unwrap();
    assert_eq!((before.at_ms, before.seq), (None, None));
    b.deposit().unwrap();
    reconcile::run_snapshot(&b.store, &on()).unwrap();
    let last = reconcile::read_last_verified(&b.store).unwrap();
    assert_eq!(last.seq.as_deref(), Some("1"));
    let at = last.at_ms.unwrap();
    let health = json::parse(&status::health(&b.store, "svc-ledger").body).unwrap();
    assert_eq!(health.get("ok"), Some(&Json::Bool(true)));
    assert_eq!(health.get("postingEnabled"), Some(&Json::Bool(true)));
    assert_eq!(
        health.get("lastVerifiedAt"),
        Some(&Json::str(Instant(at).iso()))
    );
    assert_eq!(health.get("lastVerifiedSeq"), Some(&Json::str("1")));
}

#[test]
fn the_0022_down_refuses_while_a_run_is_on_file() {
    let Some(b) = book() else { return };
    let file = |name: &str| FILES.iter().find(|(n, _)| *n == name).unwrap().1;
    b.sql("INSERT INTO ledger.reconcile_runs (started_at, outcome, through_seq) VALUES (now(), 'ok', 1)");
    let refused = b
        .session()
        .batch_execute(file("0022_reconcile_runs.down.sql"))
        .unwrap_err();
    assert_eq!(refused.code().map(|c| c.code()), Some("P0001"));
    assert_eq!(b.count("reconcile_runs"), 1);
    b.sql("DELETE FROM ledger.reconcile_runs");
    b.sql(file("0022_reconcile_runs.down.sql"));
    assert_eq!(b.db.regclass("ledger.reconcile_runs"), None);
}

#[test]
fn the_run_table_refuses_an_unknown_outcome_and_an_ok_row_with_no_tip() {
    let Some(b) = book() else { return };
    let mut c = b.session();
    for refused in ["fine", "ok"] {
        let e = c
            .execute(
                "INSERT INTO ledger.reconcile_runs (started_at, outcome) VALUES (now(), $1)",
                &[&refused],
            )
            .unwrap_err();
        assert_eq!(e.code().map(|c| c.code()), Some("23514"));
    }
    c.execute(
        "INSERT INTO ledger.reconcile_runs (started_at, outcome) VALUES (now(), 'incomplete')",
        &[],
    )
    .unwrap();
}

// ── reconcile-proof-failure.test.ts ────────────────────────────────────────────────────────────────────────────────

#[test]
fn a_replay_sum_past_the_column_freezes_as_corruption_with_the_chain_intact() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    b.tamper(&format!(
        "UPDATE ledger.ledger_entries SET amount = {FITS}::numeric, balance_after = {FITS}::numeric
          WHERE account_id IN (SELECT id FROM ledger.accounts WHERE owner_type = 'user');
         INSERT INTO ledger.ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
         SELECT tx_id, account_id, asset_id, 'debit', {FITS}::numeric, {FITS}::numeric
           FROM ledger.ledger_entries
          WHERE account_id IN (SELECT id FROM ledger.accounts WHERE owner_type = 'user');
         UPDATE ledger.accounts SET balance = 0"
    ));
    b.rehash();
    let run = b.ledger().run_scheduled_default().unwrap();
    let report = mismatch_report(&run);
    assert!(report.chain.ok());
    assert!(
        report
            .corrupt_amount_fields
            .contains(&"ledger_entries.amount".to_owned())
    );
    assert_eq!(
        b.status().frozen_reason.as_deref(),
        Some("reconciliation mismatch")
    );
    assert_eq!(b.outcomes(), ["mismatch"]);
}

#[test]
fn an_asset_total_past_the_column_freezes_as_corruption_when_every_account_matches() {
    let Some(b) = book() else { return };
    b.deposit_to(USER, TEN).unwrap();
    b.deposit_to(USER_B, TEN).unwrap();
    b.tamper(&format!(
        "UPDATE ledger.ledger_entries AS e SET amount = {FITS}::numeric, balance_after = {FITS}::numeric
           FROM ledger.accounts a
          WHERE e.account_id = a.id AND a.owner_type = 'user' AND e.direction = 'debit';
         UPDATE ledger.accounts SET balance = {FITS}::numeric WHERE owner_type = 'user'"
    ));
    b.rehash();
    let run = b.ledger().run_scheduled_default().unwrap();
    let report = mismatch_report(&run);
    assert!(report.balances.ok);
    assert!(report.chain.ok());
    assert!(
        report
            .corrupt_amount_fields
            .contains(&"accounts.balance".to_owned())
    );
    assert!(!b.status().posting_enabled);
}

#[test]
fn a_posted_at_of_infinity_is_a_broken_chain_row_and_freezes() {
    let Some(b) = book() else { return };
    let id = b.deposit().unwrap();
    b.tamper("UPDATE ledger.ledger_tx SET posted_at = 'infinity'");
    let run = b.ledger().run_scheduled_default().unwrap();
    assert_eq!(
        mismatch_report(&run).chain,
        Chain::Broken {
            broken_at: id,
            length: 0
        }
    );
    assert_eq!(
        b.status().frozen_reason.as_deref(),
        Some("reconciliation mismatch")
    );
}

fn run_failed_counts(b: &Book) -> Vec<Json> {
    b.bus
        .emitted(RUN_FAILED_SUBJECT)
        .iter()
        .map(|e| e.get("payload").unwrap().clone())
        .collect()
}

fn streak(payloads: &[Json]) -> Vec<Json> {
    payloads
        .iter()
        .map(|p| p.get("consecutiveIncomplete").unwrap().clone())
        .collect()
}

#[test]
fn a_plain_proof_error_stays_incomplete_and_the_third_in_a_row_freezes_as_unproven() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    let ledger = b.ledger();
    let prove = |_: &mut Client| -> Result<Report, ProofError> {
        Err(ProofError::Failed(StoreError::new("proof blew up", None)))
    };
    let fail = || {
        ledger.run_scheduled(&SnapshotOptions {
            prove: Some(&prove),
            ..on()
        })
    };
    let log = Sink::default().logger();
    let mut state = TickState::new(system_ms());
    tick(&fail, &ledger, &log, &mut state, &tick_options(None)).unwrap();
    assert!(b.status().posting_enabled);
    assert_eq!(
        b.runs(),
        [("incomplete".to_owned(), Some("unknown".to_owned()))]
    );
    tick(&fail, &ledger, &log, &mut state, &tick_options(None)).unwrap();
    assert!(b.status().posting_enabled);
    assert_eq!(b.outcomes().len(), 2);
    // Backed off: this tick does not run.
    tick(&fail, &ledger, &log, &mut state, &tick_options(None)).unwrap();
    assert!(b.status().posting_enabled);
    assert_eq!(b.outcomes().len(), 2);
    tick(&fail, &ledger, &log, &mut state, &tick_options(None)).unwrap();
    let s = b.status();
    assert!(!s.posting_enabled);
    assert_eq!(s.frozen_reason.as_deref(), Some("reconcile_unproven"));
    assert_eq!(s.frozen_by.as_deref(), Some("reconciliation"));
    assert_eq!(b.outcomes(), ["incomplete", "incomplete", "incomplete"]);
    assert_eq!(
        streak(&run_failed_counts(&b)),
        [Json::int(1), Json::int(2), Json::int(3)]
    );
}

#[test]
fn a_tls_failure_at_reserve_is_incomplete_and_does_not_freeze_below_n() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    let ledger = b.ledger();
    let run = || {
        ledger.run_scheduled(&SnapshotOptions {
            reserve_failure: Some(ProofError::Failed(StoreError::new(
                "certificate has expired",
                Some("CERT_HAS_EXPIRED"),
            ))),
            ..on()
        })
    };
    let mut state = TickState::new(system_ms());
    tick(
        &run,
        &ledger,
        &Sink::default().logger(),
        &mut state,
        &tick_options(None),
    )
    .unwrap();
    assert!(b.status().posting_enabled);
    assert_eq!(
        b.texts("SELECT outcome, error_code, detail->>'phase' FROM ledger.reconcile_runs"),
        [[
            Some("incomplete".to_owned()),
            Some("CERT_HAS_EXPIRED".to_owned()),
            Some("start".to_owned())
        ]]
    );
}

// The TypeScript throws a code-less error from a swapped driver method; here the database refuses the insert (P0001).
#[test]
fn a_green_proof_whose_snapshot_insert_fails_stays_incomplete_with_no_freeze() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    b.refuse_inserts("balance_snapshots", "refuse_anchor");
    let prove = |_: &mut Client| -> Result<Report, ProofError> { Ok(green()) };
    let run = b
        .ledger()
        .run_scheduled(&SnapshotOptions {
            prove: Some(&prove),
            ..on()
        })
        .unwrap();
    assert_eq!(incomplete_of(&run).0, Phase::Snapshot);
    assert!(b.status().posting_enabled);
    assert_eq!(b.outcomes(), ["incomplete"]);
}

#[test]
fn a_fresh_tick_state_still_freezes_when_two_incomplete_runs_are_on_file() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    let ledger = b.ledger();
    let prove = |_: &mut Client| -> Result<Report, ProofError> {
        Err(ProofError::Failed(StoreError::new("proof blew up", None)))
    };
    let fail = || {
        ledger.run_scheduled(&SnapshotOptions {
            prove: Some(&prove),
            ..on()
        })
    };
    let log = Sink::default().logger();
    let mut first = TickState::new(system_ms());
    tick(&fail, &ledger, &log, &mut first, &tick_options(None)).unwrap();
    tick(&fail, &ledger, &log, &mut first, &tick_options(None)).unwrap();
    assert!(b.status().posting_enabled);
    let mut restarted = TickState::new(system_ms());
    tick(&fail, &ledger, &log, &mut restarted, &tick_options(None)).unwrap();
    let s = b.status();
    assert_eq!(s.frozen_reason.as_deref(), Some("reconcile_unproven"));
    assert_eq!(s.frozen_by.as_deref(), Some("reconciliation"));
    assert_eq!(restarted.consecutive_incomplete, 1);
    let payloads = run_failed_counts(&b);
    assert_eq!(
        streak(&payloads),
        [Json::int(1), Json::int(2), Json::int(3)]
    );
    for p in &payloads {
        assert_eq!(p.get("errorCode"), Some(&Json::str("unknown")));
        assert_eq!(p.get("phase"), Some(&Json::str("proof")));
        assert!(matches!(p.get("runId"), Some(Json::String(_))));
    }
}

#[test]
fn two_postgres_errors_stay_incomplete_and_the_third_freezes_alerting_each() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    let ledger = b.ledger();
    let prove = |c: &mut Client| -> Result<Report, ProofError> {
        c.batch_execute("SELECT 'not-a-number'::int")?;
        panic!("expected the cast to fail");
    };
    let fail = || {
        ledger.run_scheduled(&SnapshotOptions {
            prove: Some(&prove),
            ..on()
        })
    };
    let log = Sink::default().logger();
    let mut state = TickState::new(system_ms());
    for _ in 0..3 {
        tick(&fail, &ledger, &log, &mut state, &tick_options(None)).unwrap();
        assert!(b.status().posting_enabled);
    }
    tick(&fail, &ledger, &log, &mut state, &tick_options(None)).unwrap();
    assert_eq!(
        b.status().frozen_reason.as_deref(),
        Some("reconcile_unproven")
    );
    let code = ("incomplete".to_owned(), Some("22P02".to_owned()));
    assert_eq!(b.runs(), [code.clone(), code.clone(), code]);
    let payloads = run_failed_counts(&b);
    assert_eq!(
        streak(&payloads),
        [Json::int(1), Json::int(2), Json::int(3)]
    );
    assert!(
        payloads
            .iter()
            .all(|p| p.get("errorCode") == Some(&Json::str("22P02")))
    );
}

// The TypeScript also refuses a missing or unknown custody switch with a TypeError; `CustodyLayer` has only `On` and
// `Off`, so no such call compiles.
#[test]
fn with_custody_off_an_empty_book_has_nothing_to_compare_and_freezes_nothing() {
    let Some(b) = book() else { return };
    let off = b.reconciler(CustodyLayer::Off, DEFAULT_STATEMENT_TIMEOUT_MS);
    let run = off.run_scheduled_default().unwrap();
    let SnapshotRun::Ok { report, .. } = run else {
        panic!("{run:?}")
    };
    assert_eq!(report.result, ProofWord::NothingToCompare);
    assert_eq!(
        report.customer_balances,
        Some(CustomerCheck::Off {
            ok: true,
            accounts_checked: 0,
            open: Vec::new()
        })
    );
    assert!(b.status().posting_enabled);
}

#[test]
fn with_custody_off_a_planted_customer_balance_freezes_and_with_it_on_the_book_matches() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    let customer = b
        .one(&format!(
            "SELECT id::text FROM ledger.accounts WHERE owner_type = 'user' AND owner_id = '{USER}' AND balance <> 0"
        ))
        .unwrap();
    let on_run = b.ledger().run_scheduled_default().unwrap();
    let SnapshotRun::Ok { report, .. } = on_run else {
        panic!("{on_run:?}")
    };
    assert_eq!(report.result, ProofWord::Matched);
    assert_eq!(report.customer_balances, Some(CustomerCheck::On));

    let off = b.reconciler(CustodyLayer::Off, DEFAULT_STATEMENT_TIMEOUT_MS);
    let run = off.run_scheduled_default().unwrap();
    let report = mismatch_report(&run);
    assert!(!report.ok);
    assert_eq!(report.result, ProofWord::Mismatch);
    // Only the customer account is named: the rail's leg is ours.
    assert_eq!(
        report.customer_balances,
        Some(CustomerCheck::Off {
            ok: false,
            accounts_checked: 1,
            open: vec![CustomerHit {
                account_id: customer.clone(),
                asset_id: "USDT".to_owned(),
                balance: "10".to_owned()
            }]
        })
    );
    assert_eq!(b.status().frozen_by.as_deref(), Some("reconciliation"));
    let row = b.texts(
        "SELECT outcome, detail->>'result', detail->>'customerBalancesOpen', detail->>'firstCustomerBalanceAccountId'
           FROM ledger.reconcile_runs ORDER BY id DESC LIMIT 1",
    );
    assert_eq!(
        row,
        [[
            Some("mismatch".to_owned()),
            Some("mismatch".to_owned()),
            Some("1".to_owned()),
            Some(customer)
        ]]
    );
}

// The TypeScript watches the filter to see it asked about every account; here the query reads every account and the
// filter alone decides, which owner types it is not today asked to name show.
#[test]
fn the_customer_check_puts_every_owner_type_to_the_filter() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    b.sql(
        "INSERT INTO ledger.accounts (owner_type, owner_id, asset_id, kind)
         VALUES ('house', 'house:proof-probe', 'USDT', 'available'), ('treasury', 'treasury:proof-probe', 'USDT', 'available')",
    );
    let check = reconcile::customer_balances(&mut b.session(), CustodyLayer::Off).unwrap();
    assert!(matches!(
        check,
        CustomerCheck::Off {
            ok: false,
            accounts_checked: 1,
            ..
        }
    ));
}

#[test]
fn a_customer_check_that_cannot_finish_on_a_consistent_book_is_an_error_never_matched() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    b.sql("ALTER TABLE ledger.accounts RENAME COLUMN owner_type TO owner_type_hidden");
    assert!(reconcile::run_reconciliation(&mut b.session(), CustodyLayer::Off, system_ms).is_err());
    b.sql("ALTER TABLE ledger.accounts RENAME COLUMN owner_type_hidden TO owner_type");
    let on = reconcile::run_reconciliation(&mut b.session(), CustodyLayer::On, system_ms).unwrap();
    assert!(on.ok);
    assert_eq!(on.result, ProofWord::Matched);
}

// ── reconcile-timeout-regression.test.ts, scheduled-reconcile-tick.test.ts (a real book) ───────────────────────────

#[test]
fn a_real_scheduled_timeout_does_not_freeze_and_the_next_tick_retries() {
    let Some(b) = book() else { return };
    b.deposit_to(USER, service_kit::money::Amount::ONE).unwrap();
    let ledger = b.ledger();
    let run = || ledger.run_scheduled(&opts(1_000, CustodyLayer::On));
    let sink = Sink::default();
    let mut state = TickState::new(system_ms());
    let blocker = b.hold("LOCK TABLE ledger.ledger_entries IN ACCESS EXCLUSIVE MODE");
    tick(
        &run,
        &ledger,
        &sink.logger(),
        &mut state,
        &tick_options(None),
    )
    .unwrap();
    drop(blocker);
    assert!(b.status().posting_enabled);
    assert_eq!(sink.messages(), [INCOMPLETE_LOG]);
    let fatal = sink.fatal();
    assert_eq!(fatal[0].get("outcome"), Some(&Json::str("incomplete")));
    assert_eq!(fatal[0].get("errorCode"), Some(&Json::str("57014")));
    assert_eq!(
        b.runs(),
        [("incomplete".to_owned(), Some("57014".to_owned()))]
    );
    assert_eq!(b.count("balance_snapshots"), 0);
    tick(
        &run,
        &ledger,
        &sink.logger(),
        &mut state,
        &tick_options(None),
    )
    .unwrap();
    assert_eq!(b.outcomes(), ["incomplete", "ok"]);
    assert!(b.status().posting_enabled);
    b.deposit().unwrap();
}

#[test]
fn a_real_mismatch_on_the_tick_freezes_the_book_for_every_connection() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    b.sql("UPDATE ledger.accounts SET balance = balance + 1 WHERE owner_type = 'user'");
    let ledger = b.ledger();
    let sink = Sink::default();
    tick(
        &|| ledger.run_scheduled_default(),
        &ledger,
        &sink.logger(),
        &mut TickState::new(system_ms()),
        &tick_options(None),
    )
    .unwrap();
    assert_eq!(sink.messages(), [FROZEN_LOG]);
    let s = b.status();
    assert_eq!(
        (
            s.posting_enabled,
            s.frozen_reason.as_deref(),
            s.frozen_by.as_deref()
        ),
        (
            false,
            Some("reconciliation mismatch"),
            Some("reconciliation")
        )
    );
    assert_eq!(b.deposit().unwrap_err(), "ledger.frozen");
    assert_eq!(b.outcomes(), ["mismatch"]);
}

#[test]
fn an_incomplete_tick_leaves_an_operator_freeze_standing() {
    let Some(b) = book() else { return };
    let ledger = b.ledger();
    ledger
        .freeze("operator: suspected drift", OPERATOR)
        .unwrap();
    let run = || {
        Ok(SnapshotRun::Incomplete {
            phase: Phase::Proof,
            error: ProofError::Failed(StoreError::new("x", Some("x"))),
            error_code: "x".to_owned(),
            run_id: None,
            record_error: None,
        })
    };
    tick(
        &run,
        &ledger,
        &Sink::default().logger(),
        &mut TickState::new(system_ms()),
        &tick_options(None),
    )
    .unwrap();
    let s = b.freeze_state();
    assert!(s.frozen);
    assert_eq!(s.reason.as_deref(), Some("operator: suspected drift"));
    assert_eq!(s.actor.as_deref(), Some(OPERATOR));
}

#[test]
fn staleness_reports_an_old_proof_without_freezing_or_refusing_a_post() {
    let Some(b) = book() else { return };
    b.sql(
        "INSERT INTO ledger.reconcile_runs (started_at, finished_at, outcome, through_seq)
         VALUES (now() - interval '26 hours', now() - interval '26 hours', 'ok', 5)",
    );
    let ledger = b.ledger();
    let sink = Sink::default();
    tick(
        &|| Ok(SnapshotRun::Skipped),
        &ledger,
        &sink.logger(),
        &mut TickState::new(system_ms()),
        &tick_options(Some(24)),
    )
    .unwrap();
    assert_eq!(sink.messages(), [STALE_LOG]);
    let s = b.status();
    assert_eq!(
        (s.posting_enabled, s.frozen_reason, s.frozen_by),
        (true, None, None)
    );
    b.deposit().unwrap();
}

#[test]
fn a_fresh_ok_run_keeps_staleness_quiet_and_an_operator_freeze_beats_a_stale_one() {
    let Some(b) = book() else { return };
    b.sql("INSERT INTO ledger.reconcile_runs (started_at, outcome, through_seq) VALUES (now(), 'ok', 5)");
    let ledger = b.ledger();
    let quiet = Sink::default();
    tick(
        &|| Ok(SnapshotRun::Skipped),
        &ledger,
        &quiet.logger(),
        &mut TickState::new(system_ms()),
        &tick_options(Some(24)),
    )
    .unwrap();
    assert!(quiet.messages().is_empty());
    assert!(b.status().posting_enabled);
    b.sql("UPDATE ledger.reconcile_runs SET finished_at = now() - interval '3 days'");
    ledger.freeze("operator: investigating", OPERATOR).unwrap();
    let stale = Sink::default();
    tick(
        &|| Ok(SnapshotRun::Skipped),
        &ledger,
        &stale.logger(),
        &mut TickState::new(system_ms()),
        &tick_options(Some(24)),
    )
    .unwrap();
    assert_eq!(stale.messages(), [STALE_LOG]);
    let s = b.freeze_state();
    assert_eq!(s.reason.as_deref(), Some("operator: investigating"));
    assert_eq!(s.actor.as_deref(), Some(OPERATOR));
}

// ── snapshot-anchor.test.ts ────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn snapshot_rows_carry_the_tip_the_proof_read_even_when_a_post_lands_in_between() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    let tip = b.texts(
        "SELECT seq::text, hash, (SELECT max(id)::text FROM ledger.ledger_entries) FROM ledger.chain_tip WHERE id = true",
    )[0]
    .clone();
    let under = Mutex::new(Vec::<(String, String)>::new());
    let prove = |c: &mut Client| -> Result<Report, ProofError> {
        *under.lock().unwrap() = c
            .query(
                "SELECT id::text, balance::text FROM ledger.accounts ORDER BY id",
                &[],
            )?
            .iter()
            .map(|r| (r.get(0), r.get(1)))
            .collect();
        b.deposit()
            .expect("the post waited for the proof: a lock is held");
        Ok(green())
    };
    let run = reconcile::run_snapshot(
        &b.store,
        &SnapshotOptions {
            prove: Some(&prove),
            ..on()
        },
    )
    .unwrap();
    let SnapshotRun::Ok { tip: read, .. } = run else {
        panic!("{run:?}")
    };
    assert_eq!(
        (
            Some(read.seq.clone()),
            read.hash.clone(),
            read.through_entry_id.clone()
        ),
        (tip[0].clone(), tip[1].clone(), tip[2].clone())
    );
    let rows = b.texts(
        "SELECT account_id::text, balance::text, chain_tip_seq::text, chain_tip_hash, through_entry_id,
                (abs(extract(epoch FROM as_of - now())) < 60)::text
           FROM ledger.balance_snapshots ORDER BY account_id",
    );
    let under = under.lock().unwrap().clone();
    assert!(!rows.is_empty());
    assert_eq!(rows.len(), under.len());
    for (row, (id, balance)) in rows.iter().zip(&under) {
        // The balances the proof read, not the ones after the in-between post.
        assert_eq!(row[0].as_deref(), Some(id.as_str()));
        assert_eq!(row[1].as_deref(), Some(balance.as_str()));
        assert_eq!(row[2..5], tip[..]);
        assert_eq!(row[5].as_deref(), Some("true"));
    }
    let after = b.texts("SELECT seq::text, hash FROM ledger.chain_tip")[0].clone();
    assert_ne!(after[0], tip[0]);
    assert_ne!(after[1], tip[1]);
    assert_eq!(
        b.texts("SELECT outcome, through_seq::text, tip_hash, through_entry_id FROM ledger.reconcile_runs"),
        [[
            Some("ok".to_owned()),
            tip[0].clone(),
            tip[1].clone(),
            tip[2].clone()
        ]]
    );
}

#[test]
fn a_failed_proof_writes_no_snapshot_records_a_mismatch_and_takes_no_tip_lock() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    let prove = |_: &mut Client| -> Result<Report, ProofError> {
        // NOWAIT on the singleton succeeds: the proof holds no lock on it.
        b.sql(
            "BEGIN; SELECT seq FROM ledger.chain_tip WHERE id = true FOR UPDATE NOWAIT; ROLLBACK",
        );
        Ok(failed())
    };
    let run = reconcile::run_snapshot(
        &b.store,
        &SnapshotOptions {
            prove: Some(&prove),
            ..on()
        },
    )
    .unwrap();
    mismatch_report(&run);
    assert_eq!(b.count("balance_snapshots"), 0);
    assert_eq!(
        b.texts("SELECT outcome, through_seq::text FROM ledger.reconcile_runs"),
        [[Some("mismatch".to_owned()), Some("1".to_owned())]]
    );
}

#[test]
fn snapshot_rows_from_before_0015_with_no_tip_are_left_untouched() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    b.sql(
        "INSERT INTO ledger.balance_snapshots (account_id, as_of, balance)
         SELECT id, now() - interval '2 hours', 25 FROM ledger.accounts WHERE owner_type = 'user'",
    );
    assert!(matches!(
        reconcile::run_snapshot(&b.store, &on()).unwrap(),
        SnapshotRun::Ok { .. }
    ));
    let rows = b.texts(
        "SELECT chain_tip_seq::text, chain_tip_hash, through_entry_id FROM ledger.balance_snapshots ORDER BY id",
    );
    assert_eq!(rows[0], [None, None, None]);
    assert!(rows.len() > 1);
    assert!(
        rows[1..]
            .iter()
            .all(|r| r[0].as_deref() == Some("1") && r[1].is_some())
    );
}

// ── postgres-ledger.test.ts, tx-hash-bind.test.ts: the chain and the balances ────────────────────────────────────────

fn chain(b: &Book) -> Chain {
    reconcile::verify_chain(&mut b.session(), reconcile::CHAIN_BATCH, None).unwrap()
}

#[test]
fn the_proof_detects_tampering_after_the_fact() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    let second = b.deposit().unwrap();
    assert_eq!(chain(&b), Chain::Ok { length: 2 });
    b.tamper(&format!(
        "UPDATE ledger.ledger_entries SET amount = 11 WHERE tx_id = '{second}' AND direction = 'debit'"
    ));
    assert_eq!(
        chain(&b),
        Chain::Broken {
            broken_at: second,
            length: 1
        }
    );
}

#[test]
fn a_chain_whose_tip_names_another_hash_or_sequence_is_not_ok() {
    let Some(b) = book() else { return };
    let last = b.deposit().unwrap();
    b.sql("UPDATE ledger.chain_tip SET hash = hash || 'x'");
    assert_eq!(
        chain(&b),
        Chain::Broken {
            broken_at: last.clone(),
            length: 1
        }
    );
    b.sql("UPDATE ledger.chain_tip SET hash = rtrim(hash, 'x'), seq = seq + 1");
    assert_eq!(
        chain(&b),
        Chain::Broken {
            broken_at: last,
            length: 1
        }
    );
}

#[test]
fn a_rewritten_key_or_meta_breaks_the_chain_at_that_row() {
    for rewrite in [
        "idempotency_key = idempotency_key || ':rewritten'",
        "meta = meta || '{\"rewritten\": true}'::jsonb",
    ] {
        let Some(b) = book() else { return };
        b.deposit().unwrap();
        let id = b.deposit().unwrap();
        b.tamper(&format!(
            "UPDATE ledger.ledger_tx SET {rewrite} WHERE id = '{id}'"
        ));
        assert_eq!(
            chain(&b),
            Chain::Broken {
                broken_at: id,
                length: 1
            },
            "{rewrite}"
        );
    }
}

#[test]
fn reconciliation_catches_a_balance_that_no_longer_matches_its_entries() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    b.sql("UPDATE ledger.accounts SET balance = balance + 0.000000000000000001 WHERE owner_type = 'user'");
    let balances = reconcile::reconcile_balances(&mut b.session()).unwrap();
    assert!(!balances.ok);
    assert_eq!(balances.drift.len(), 1);
    assert_eq!(balances.drift[0].cached, "10.000000000000000001");
    assert_eq!(balances.drift[0].replayed, "10");
    assert_eq!(balances.drift[0].difference, "0.000000000000000001");
}

#[test]
fn a_full_run_reports_every_asset_netting_to_zero_across_200_posts() {
    let Some(b) = book() else { return };
    for _ in 0..200 {
        b.deposit().unwrap();
    }
    let report =
        reconcile::run_reconciliation(&mut b.session(), CustodyLayer::On, system_ms).unwrap();
    assert!(report.ok);
    assert_eq!(report.chain, Chain::Ok { length: 200 });
    assert_eq!(report.totals, [("USDT".to_owned(), "0".to_owned())]);
    assert!(report.unbalanced_assets.is_empty());
    assert_eq!(report.result, ProofWord::Matched);
}

// ── service.freeze.test.ts, "reconciliation freezes durably" ─────────────────────────────────────────────────────────

#[test]
fn a_self_freeze_reaches_a_second_instance_and_pages_the_drift() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    b.sql(&format!(
        "UPDATE ledger.accounts SET balance = balance + 50 WHERE owner_type = 'user' AND owner_id = '{USER}'"
    ));
    let account = b
        .one(&format!(
            "SELECT id::text FROM ledger.accounts WHERE owner_type = 'user' AND owner_id = '{USER}'"
        ))
        .unwrap();
    let report = b.ledger().reconcile().unwrap();
    assert!(!report.ok);
    let other = b.db.store();
    let s = status::status(&other).unwrap();
    assert!(!s.posting_enabled);
    assert_eq!(s.frozen_by.as_deref(), Some("reconciliation"));
    assert_eq!(b.deposit().unwrap_err(), "ledger.frozen");
    let drift = &report.balances.drift[0];
    assert_eq!(drift.account_id, account);
    let pages = b.bus.emitted(DRIFT_SUBJECT);
    assert_eq!(pages.len(), 1);
    let page = pages[0].get("payload").unwrap();
    assert_eq!(
        page.get("accountId"),
        Some(&Json::str(drift.account_id.clone()))
    );
    assert_eq!(page.get("assetId"), Some(&Json::str("USDT")));
    assert_eq!(page.get("snapshotBalance"), Some(&Json::str("60")));
    assert_eq!(page.get("replayBalance"), Some(&Json::str("10")));
    assert_eq!(page.get("drift"), Some(&Json::str("50")));
    assert_eq!(page.get("module"), Some(&Json::str("ledger")));
}

#[test]
fn a_chain_break_with_no_drift_freezes_and_pages_no_invented_zero_drift() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    b.tamper("UPDATE ledger.ledger_tx SET hash = hash || 'tamper'");
    let report = b.ledger().reconcile().unwrap();
    assert!(!report.ok);
    assert!(report.balances.ok);
    assert!(!report.chain.ok());
    assert_eq!(b.status().frozen_by.as_deref(), Some("reconciliation"));
    assert!(b.bus.emitted(DRIFT_SUBJECT).is_empty());
}

// ── operator-http.test.ts, "reconcile is reachable" ─────────────────────────────────────────────────────────────────

fn operator_door(b: &Book) -> LedgerDoor {
    LedgerDoor::new(door_config(
        &b.db,
        Arc::new(MemoryBus::default()),
        Box::new(support::operator::Shared(stub(
            Some("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
            Some(true),
        ))),
    ))
    .unwrap()
}

const APPROVED: &str = r#"{"approvalId":"appr-1","operationId":"op-1"}"#;

#[test]
fn the_door_runs_the_real_proof_and_answers_the_report_shape() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    let door = operator_door(&b);
    let (status, body) = call(&door, "POST", "/operator/reconcile", treasury(), APPROVED);
    assert_eq!(status, 200, "{body:?}");
    assert_eq!(body.get("ok"), Some(&Json::Bool(true)));
    assert_eq!(body.get("accountsChecked"), Some(&Json::int(2)));
    assert_eq!(body.get("chainLength"), Some(&Json::int(1)));
    assert_eq!(body.get("unbalancedAssets"), Some(&Json::Array(Vec::new())));
    assert_eq!(body.get("result"), Some(&Json::str("matched")));
    assert_eq!(body.get("customerBalancesOpen"), Some(&Json::Null));
    assert_eq!(
        body.get("confirmOperatorId"),
        Some(&Json::str("cccccccc-cccc-4ccc-8ccc-cccccccccccc"))
    );
    assert!(body.get("chainBrokenAt").is_none());
    assert!(matches!(body.get("ranAt"), Some(Json::String(_))));
    assert_eq!(b.outcomes(), ["ok"]);
}

#[test]
fn a_failed_book_answers_ok_false_and_the_service_froze_it() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    b.sql("UPDATE ledger.accounts SET balance = balance + 1 WHERE owner_type = 'user'");
    let (status, body) = call(
        &operator_door(&b),
        "POST",
        "/operator/reconcile",
        treasury(),
        APPROVED,
    );
    assert_eq!(status, 200);
    assert_eq!(body.get("ok"), Some(&Json::Bool(false)));
    assert_eq!(body.get("accountsChecked"), Some(&Json::int(2)));
    assert_eq!(body.get("chainLength"), Some(&Json::int(1)));
    assert_eq!(b.status().frozen_by.as_deref(), Some("reconciliation"));
}

#[test]
fn a_broken_chain_answers_the_length_so_far_and_where_it_broke() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    let id = b.deposit().unwrap();
    b.tamper(&format!(
        "UPDATE ledger.ledger_tx SET reason = 'rewritten' WHERE id = '{id}'"
    ));
    let (status, body) = call(
        &operator_door(&b),
        "POST",
        "/operator/reconcile",
        treasury(),
        APPROVED,
    );
    assert_eq!(status, 200);
    assert_eq!(body.get("ok"), Some(&Json::Bool(false)));
    assert_eq!(body.get("chainLength"), Some(&Json::int(1)));
    assert_eq!(body.get("chainBrokenAt"), Some(&Json::str(id)));
}

#[test]
fn totals_that_do_not_net_to_zero_name_the_unbalanced_asset() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    // Every account still matches its entries and the chain is rehashed: only the asset's total is off.
    b.tamper(
        "UPDATE ledger.ledger_entries SET amount = 11, balance_after = 11 WHERE direction = 'debit';
         UPDATE ledger.accounts SET balance = 11 WHERE owner_type = 'user'",
    );
    b.rehash();
    let (status, body) = call(
        &operator_door(&b),
        "POST",
        "/operator/reconcile",
        treasury(),
        APPROVED,
    );
    assert_eq!(status, 200);
    assert_eq!(body.get("ok"), Some(&Json::Bool(false)));
    assert_eq!(
        body.get("unbalancedAssets"),
        Some(&Json::Array(vec![Json::str("USDT")]))
    );
    assert_eq!(body.get("chainLength"), Some(&Json::int(1)));
}

#[test]
fn without_approval_ids_the_door_refuses_and_runs_nothing() {
    let Some(b) = book() else { return };
    let door = operator_door(&b);
    for body in ["{}", &format!(r#"{{"confirmOperatorId":"{OPERATOR}"}}"#)] {
        let (status, answer) = call(&door, "POST", "/operator/reconcile", treasury(), body);
        assert_eq!(status, 400);
        assert_eq!(code(&answer), Some("ledger.operator_request_failed"));
    }
    let (status, _) = call(&door, "POST", "/operator/reconcile", None, APPROVED);
    assert_eq!(status, 401);
    assert_eq!(b.count("reconcile_runs"), 0);
}

#[test]
fn the_door_answers_409_while_another_run_holds_the_lock_and_503_when_it_cannot_finish() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    let door = operator_door(&b);
    let mut holder = b.session();
    holder
        .batch_execute(&format!("SELECT pg_advisory_lock({RECONCILE_LOCK_SQL})"))
        .unwrap();
    let (status, body) = call(&door, "POST", "/operator/reconcile", treasury(), APPROVED);
    assert_eq!(status, 409);
    assert_eq!(code(&body), Some(RECONCILE_IN_PROGRESS));
    drop(holder);

    let slow = LedgerDoor::new(svc_ledger::door::DoorConfig {
        reconcile_statement_timeout_ms: 1_000,
        ..door_config(
            &b.db,
            Arc::new(MemoryBus::default()),
            Box::new(support::operator::Shared(stub(
                Some("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
                Some(true),
            ))),
        )
    })
    .unwrap();
    let blocker = b.hold("LOCK TABLE ledger.ledger_entries IN ACCESS EXCLUSIVE MODE");
    let started = Clock::now();
    let (status, body) = call(&slow, "POST", "/operator/reconcile", treasury(), APPROVED);
    drop(blocker);
    assert_eq!(status, 503, "{body:?}");
    assert_eq!(code(&body), Some(RECONCILE_INCOMPLETE));
    assert!(started.elapsed() < Duration::from_secs(30));
    assert!(b.status().posting_enabled);
    let _ = slow.store();
}

#[test]
fn a_reconcile_submitted_by_the_approver_names_the_proposer_as_the_confirming_operator() {
    let Some(b) = book() else { return };
    b.deposit().unwrap();
    let door = LedgerDoor::new(door_config(
        &b.db,
        Arc::new(MemoryBus::default()),
        Box::new(support::operator::Shared(stub(Some(OPERATOR), Some(true)))),
    ))
    .unwrap();
    let (status, body) = call(&door, "POST", "/operator/reconcile", treasury(), APPROVED);
    assert_eq!(status, 200, "{body:?}");
    assert_eq!(
        body.get("confirmOperatorId"),
        Some(&Json::str("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"))
    );
}

/// A drift between opposite-sign balances near the top of `numeric(38,18)` reports its true difference, never a clamped one.
#[test]
fn balance_drift_reports_exact_difference_across_opposite_sign_bounds() {
    let Some(b) = book() else { return };
    let ninety = service_kit::money::Amount::whole(90_000_000_000_000_000_000);
    b.deposit_to(USER, ninety).unwrap();
    b.sql(
        "UPDATE ledger.accounts SET balance = 90000000000000000000 WHERE owner_type = 'treasury'",
    );
    let balances = reconcile::reconcile_balances(&mut b.session()).unwrap();
    assert!(!balances.ok);
    assert_eq!(balances.drift.len(), 1);
    assert_eq!(balances.drift[0].cached, "90000000000000000000");
    assert_eq!(balances.drift[0].replayed, "-90000000000000000000");
    assert_eq!(balances.drift[0].difference, "180000000000000000000");
}
