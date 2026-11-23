//! Slice `business`'s caller-pinned proposal id and the payroll run's one ledger post, against the Rust door on a real
//! Postgres. Ports `services/svc-bank/src/business/propose-transfer-retry-id.test.ts` and
//! `services/svc-bank/src/business/payroll-ledger-once.db.test.ts`, each test named after the TypeScript test's words.
//! A direct call on `bank.business.proposeTransfer` is `svc_bank::business::service::propose_transfer` with the door's own
//! dependencies (`Bank::deps`); a call through `/trpc` is a door call. The ledger is the business kit's stand-in
//! (`Book`), which books `bankTransfer` (the TypeScript's `bank.transfer.manual` reason) and
//! `businessApprovalHold` (`bank.business.approval.held`) once per key. Without `TEST_DATABASE_URL` each test skips;
//! with `REQUIRE_POSTGRES=1` it fails.
//!
//! Not ported as written:
//! - The two source tests read the TypeScript's source (`business-service.ts`, the router's `proposeTransfer` door). Here
//!   they read the Rust that replaced it: `src/business/service.rs` from `pub fn propose_transfer(` to `pub fn approve(`
//!   (names the code `bank.business_request_id_required`, never `random_uuid`), and the recorded zod input in
//!   `src/door/schemas.json` (`clientId` is a required `guid` string, not `optional`), since the Rust door has no
//!   zod source to match.
//! - The journal's `reason` is counted by the recipe the stand-in booked (`bankTransfer`, `businessApprovalHold`).
//! - `payroll-ledger-once`'s suite shares one database across its tests (`beforeAll`); here each test has its own,
//!   with the same account inserted first. The run ids differ between tests in both, so no test leans on another.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use service_kit::json::{self, Json};
use service_kit::money::Amount;
use svc_bank::business::service::{self as svc, Account, NewAccount, Propose, Proposed};
use svc_bank::errors::Refusal;

use crate::business_kit::{Bank, WRITE, amt, bank, call, s, uuid};

const MAKER: &str = "11111111-1111-4111-8111-111111111111";

fn code<T: std::fmt::Debug>(r: Result<T, Refusal>) -> String {
    match r {
        Ok(v) => format!("ok: {v:?}"),
        Err(Refusal::Bank(e)) => e.row.code.to_owned(),
        Err(Refusal::Trpc(t)) => t.cause.clone().unwrap_or_else(|| t.code.to_owned()),
        Err(Refusal::Other(m)) => format!("other: {m}"),
    }
}

fn create(b: &Bank, name: &str, threshold: Amount) -> Account {
    let id = uuid();
    b.deps(|d| {
        svc::create_account(
            d,
            &NewAccount {
                account_id: &id,
                name,
                asset_id: "USDT",
                spend_threshold: threshold,
                creator_user_id: MAKER,
            },
        )
    })
    .unwrap()
}

fn propose(b: &Bank, p: &Propose<'_>) -> Result<Proposed, Refusal> {
    b.deps(|d| svc::propose_transfer(d, p))
}

/// `movementCounts`: `(posts, holds)`.
fn movement_counts(b: &Bank) -> (usize, usize) {
    let r = b.ledger.recipes();
    (
        r.iter().filter(|x| *x == "bankTransfer").count(),
        r.iter().filter(|x| *x == "businessApprovalHold").count(),
    )
}

fn approval_ids_of_account(b: &Bank, account_id: &str) -> Vec<String> {
    b.sql()
        .query(
            "SELECT id::text FROM bank.business_approvals WHERE account_id = $1::text::uuid",
            &[&account_id],
        )
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect()
}

fn approval_rows_with_id(b: &Bank, id: &str) -> usize {
    b.sql()
        .query(
            "SELECT id FROM bank.business_approvals WHERE id = $1::text::uuid",
            &[&id],
        )
        .unwrap()
        .len()
}

// ---------------------------------------------------------------------------------------------------------------
// proposeTransfer pins a required caller clientId and does not mint

#[test]
fn propose_transfer_does_not_call_random_uuid_for_transfer_id_or_approval_id() {
    let src = include_str!("../src/business/service.rs");
    let at = src.find("pub fn propose_transfer(");
    assert!(at.is_some());
    let at = at.unwrap();
    let approve_at = at + src[at..].find("pub fn approve(").unwrap();
    let body = &src[at..approve_at];
    assert!(body.contains("bank.business_request_id_required"));
    assert!(!body.contains("random_uuid"));
    assert!(!body.contains("randomUUID"));
}

#[test]
fn public_door_requires_client_id_so_omit_is_not_a_second_movement() {
    let schemas = json::parse(include_str!("../src/door/schemas.json")).unwrap();
    let node = |i: f64| -> Json {
        match schemas.get("nodes") {
            Some(Json::Array(n)) => n[i as usize].clone(),
            other => panic!("nodes: {other:?}"),
        }
    };
    let door_at = match schemas
        .get("inputs")
        .and_then(|i| i.get("business.proposeTransfer"))
    {
        Some(Json::Number(n)) => *n,
        other => panic!("business.proposeTransfer: {other:?}"),
    };
    let input = node(door_at);
    let Some(Json::Array(shape)) = input.get("shape") else {
        panic!("{}", input.compact());
    };
    let client = shape
        .iter()
        .find_map(|f| match f {
            Json::Array(kv) if kv[0] == Json::str("clientId") => Some(kv[1].clone()),
            _ => None,
        })
        .expect("the door's input names clientId");
    let Json::Number(client_at) = client else {
        panic!("{}", client.compact());
    };
    let part = node(client_at);
    // clientId: z.string().guid(), never .optional().
    assert_eq!(s(&part, "t"), "string", "{}", part.compact());
    assert!(
        part.compact().contains(r#""format":"guid""#),
        "{}",
        part.compact()
    );
}

// ---------------------------------------------------------------------------------------------------------------
// BusinessService.proposeTransfer — retry with the same clientId is one movement

#[test]
fn omit_client_id_refuses_bank_business_request_id_required() {
    let Some(b) = bank() else { return };
    let account = create(&b, "Ops Co", amt("500"));
    let from = b.primary(MAKER, "USDT");
    let to = b.pot(MAKER, "USDT", "Vendor");
    b.ledger.fund_user(MAKER, "USDT", "400");
    let r = propose(
        &b,
        &Propose {
            account_id: &account.id,
            maker_user_id: MAKER,
            from_space_id: &from,
            to_space_id: &to,
            amount: amt("100"),
            client_id: "",
        },
    );
    assert_eq!(code(r), "bank.business_request_id_required");
}

#[test]
fn under_threshold_retry_one_manual_transfer() {
    let Some(b) = bank() else { return };
    let account = create(&b, "Ops Co", amt("500"));
    let from = b.primary(MAKER, "USDT");
    let to = b.pot(MAKER, "USDT", "Vendor");
    b.ledger.fund_user(MAKER, "USDT", "400");
    let client_id = uuid();
    let input = Propose {
        account_id: &account.id,
        maker_user_id: MAKER,
        from_space_id: &from,
        to_space_id: &to,
        amount: amt("100"),
        client_id: &client_id,
    };
    let first = propose(&b, &input).unwrap();
    let retry = propose(&b, &input).unwrap();
    let (
        Proposed::Posted {
            transfer_id: first_transfer,
            ledger_tx_id: first_tx,
        },
        Proposed::Posted {
            transfer_id: retry_transfer,
            ledger_tx_id: retry_tx,
        },
    ) = (&first, &retry)
    else {
        panic!("expected posted: {first:?} {retry:?}");
    };
    assert_eq!(retry_transfer, first_transfer);
    assert_eq!(retry_transfer, &client_id);
    assert_eq!(retry_tx, first_tx);
    assert_eq!(movement_counts(&b).0, 1);
}

#[test]
fn over_threshold_retry_one_approval_hold() {
    let Some(b) = bank() else { return };
    let account = create(&b, "Ops Co", amt("100"));
    let from = b.primary(MAKER, "USDT");
    let to = b.pot(MAKER, "USDT", "Payroll");
    b.ledger.fund_user(MAKER, "USDT", "1000");
    let client_id = uuid();
    let input = Propose {
        account_id: &account.id,
        maker_user_id: MAKER,
        from_space_id: &from,
        to_space_id: &to,
        amount: amt("250"),
        client_id: &client_id,
    };
    let first = propose(&b, &input).unwrap();
    let retry = propose(&b, &input).unwrap();
    let (Proposed::Pending(f), Proposed::Pending(r)) = (&first, &retry) else {
        panic!("expected pending: {first:?} {retry:?}");
    };
    assert_eq!(r.id, f.id);
    assert_eq!(r.id, client_id);
    assert_eq!(r.hold_ledger_tx_id, f.hold_ledger_tx_id);
    assert_eq!(movement_counts(&b).1, 1);
    let rows = approval_ids_of_account(&b, &account.id);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0], client_id);
}

#[test]
fn under_threshold_client_id_with_different_terms_conflicts_and_does_not_post_again() {
    let Some(b) = bank() else { return };
    let account = create(&b, "Ops Co", amt("500"));
    let other_account = create(&b, "Other Co", account.spend_threshold);
    let from = b.primary(MAKER, "USDT");
    let to = b.pot(MAKER, "USDT", "Vendor");
    let other = b.pot(MAKER, "USDT", "Other");
    b.ledger.fund_user(MAKER, "USDT", "5000");
    let below = amt("100");
    let still_below = below + amt("1");
    assert!(below < account.spend_threshold);
    assert!(still_below < account.spend_threshold);
    let client_id = uuid();
    let original = Propose {
        account_id: &account.id,
        maker_user_id: MAKER,
        from_space_id: &from,
        to_space_id: &to,
        amount: below,
        client_id: &client_id,
    };

    let first = propose(&b, &original).unwrap();
    let conflict = "bank.business_request_conflict";
    assert_eq!(
        code(propose(
            &b,
            &Propose {
                account_id: &other_account.id,
                ..original.clone()
            }
        )),
        conflict
    );
    assert_eq!(
        code(propose(
            &b,
            &Propose {
                to_space_id: &other,
                ..original.clone()
            }
        )),
        conflict
    );
    assert_eq!(
        code(propose(
            &b,
            &Propose {
                amount: still_below,
                ..original.clone()
            }
        )),
        conflict
    );
    let retry = propose(&b, &original).unwrap();
    assert!(matches!(first, Proposed::Posted { .. }), "{first:?}");
    assert_eq!(retry, first);
    assert_eq!(movement_counts(&b), (1, 0));
    assert_eq!(approval_rows_with_id(&b, &client_id), 1);
}

#[test]
fn over_threshold_client_id_with_different_terms_conflicts_and_does_not_hold_again() {
    let Some(b) = bank() else { return };
    let account = create(&b, "Ops Co", amt("500"));
    let other_account = create(&b, "Other Co", account.spend_threshold);
    let from = b.primary(MAKER, "USDT");
    let to = b.pot(MAKER, "USDT", "Payroll");
    let other = b.pot(MAKER, "USDT", "Other");
    b.ledger.fund_user(MAKER, "USDT", "5000");
    let at_threshold = account.spend_threshold;
    let still_over = account.spend_threshold + amt("1");
    let client_id = uuid();
    let original = Propose {
        account_id: &account.id,
        maker_user_id: MAKER,
        from_space_id: &from,
        to_space_id: &to,
        amount: at_threshold,
        client_id: &client_id,
    };

    let first = propose(&b, &original).unwrap();
    let conflict = "bank.business_request_conflict";
    assert_eq!(
        code(propose(
            &b,
            &Propose {
                account_id: &other_account.id,
                ..original.clone()
            }
        )),
        conflict
    );
    assert_eq!(
        code(propose(
            &b,
            &Propose {
                to_space_id: &other,
                ..original.clone()
            }
        )),
        conflict
    );
    assert_eq!(
        code(propose(
            &b,
            &Propose {
                amount: still_over,
                ..original.clone()
            }
        )),
        conflict
    );
    let retry = propose(&b, &original).unwrap();
    assert!(matches!(first, Proposed::Pending(_)), "{first:?}");
    assert_eq!(retry, first);
    assert_eq!(movement_counts(&b), (0, 1));
    assert_eq!(approval_rows_with_id(&b, &client_id), 1);
}

#[test]
fn an_amount_that_moves_from_below_spend_threshold_to_at_or_above_it_conflicts_and_does_not_hold() {
    let Some(b) = bank() else { return };
    let account = create(&b, "Ops Co", amt("500"));
    let from = b.primary(MAKER, "USDT");
    let to = b.pot(MAKER, "USDT", "Vendor");
    b.ledger.fund_user(MAKER, "USDT", "5000");
    let below = amt("100");
    assert!(below < account.spend_threshold);
    let conflict = "bank.business_request_conflict";

    let at_client = uuid();
    let base = |amount: Amount, client_id: &str| -> Result<Proposed, Refusal> {
        propose(
            &b,
            &Propose {
                account_id: &account.id,
                maker_user_id: MAKER,
                from_space_id: &from,
                to_space_id: &to,
                amount,
                client_id,
            },
        )
    };
    let first_at = base(below, &at_client).unwrap();
    assert_eq!(code(base(account.spend_threshold, &at_client)), conflict);
    let retry_at = base(below, &at_client).unwrap();
    assert!(matches!(first_at, Proposed::Posted { .. }), "{first_at:?}");
    assert_eq!(retry_at, first_at);

    let above_client = uuid();
    let first_above = base(below, &above_client).unwrap();
    assert_eq!(
        code(base(account.spend_threshold + amt("1"), &above_client)),
        conflict
    );
    let retry_above = base(below, &above_client).unwrap();
    assert!(
        matches!(first_above, Proposed::Posted { .. }),
        "{first_above:?}"
    );
    assert_eq!(retry_above, first_above);
    assert_eq!(movement_counts(&b), (2, 0));
    assert_eq!(approval_ids_of_account(&b, &account.id).len(), 2);
}

#[test]
fn an_amount_that_moves_from_at_or_above_spend_threshold_to_below_it_conflicts_and_does_not_post() {
    let Some(b) = bank() else { return };
    let account = create(&b, "Ops Co", amt("500"));
    let from = b.primary(MAKER, "USDT");
    let to = b.pot(MAKER, "USDT", "Payroll");
    b.ledger.fund_user(MAKER, "USDT", "5000");
    let below = amt("100");
    assert!(below < account.spend_threshold);
    let conflict = "bank.business_request_conflict";
    let base = |amount: Amount, client_id: &str| -> Result<Proposed, Refusal> {
        propose(
            &b,
            &Propose {
                account_id: &account.id,
                maker_user_id: MAKER,
                from_space_id: &from,
                to_space_id: &to,
                amount,
                client_id,
            },
        )
    };

    let at_client = uuid();
    let first_at = base(account.spend_threshold, &at_client).unwrap();
    assert_eq!(code(base(below, &at_client)), conflict);
    let retry_at = base(account.spend_threshold, &at_client).unwrap();
    assert!(matches!(first_at, Proposed::Pending(_)), "{first_at:?}");
    assert_eq!(retry_at, first_at);

    let above_client = uuid();
    let first_above = base(account.spend_threshold + amt("1"), &above_client).unwrap();
    assert_eq!(code(base(below, &above_client)), conflict);
    let retry_above = base(account.spend_threshold + amt("1"), &above_client).unwrap();
    assert!(
        matches!(first_above, Proposed::Pending(_)),
        "{first_above:?}"
    );
    assert_eq!(retry_above, first_above);
    assert_eq!(movement_counts(&b), (0, 2));
    assert_eq!(approval_ids_of_account(&b, &account.id).len(), 2);
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP /trpc/business.proposeTransfer — retry with the same clientId is one post

#[test]
fn http_without_client_id_is_400() {
    let Some(b) = bank() else { return };
    let account = create(&b, "Ops Co", amt("500"));
    let from = b.primary(MAKER, "USDT");
    let to = b.pot(MAKER, "USDT", "Vendor");
    b.ledger.fund_user(MAKER, "USDT", "400");
    let omitted = call(
        &b,
        MAKER,
        WRITE,
        "business.proposeTransfer",
        &Json::obj([
            ("accountId", Json::str(account.id.clone())),
            ("fromSpaceId", Json::str(from.clone())),
            ("toSpaceId", Json::str(to.clone())),
            ("amount", Json::str("100")),
        ]),
    );
    assert_eq!(omitted.0, 400, "{}", omitted.1.compact());
    assert_eq!(movement_counts(&b).0, 0);
}

#[test]
fn two_http_posts_with_the_same_client_id_are_one_transfer() {
    let Some(b) = bank() else { return };
    let account = create(&b, "Ops Co", amt("500"));
    let from = b.primary(MAKER, "USDT");
    let to = b.pot(MAKER, "USDT", "Vendor");
    b.ledger.fund_user(MAKER, "USDT", "400");
    let client_id = uuid();
    let payload = Json::obj([
        ("accountId", Json::str(account.id.clone())),
        ("fromSpaceId", Json::str(from.clone())),
        ("toSpaceId", Json::str(to.clone())),
        ("amount", Json::str("100")),
        ("clientId", Json::str(client_id.clone())),
    ]);

    let first = call(&b, MAKER, WRITE, "business.proposeTransfer", &payload);
    assert_eq!(first.0, 200, "{}", first.1.compact());
    let first_data = first.ok();

    let retry = call(&b, MAKER, WRITE, "business.proposeTransfer", &payload);
    assert_eq!(retry.0, 200, "{}", retry.1.compact());
    let retry_data = retry.ok();
    assert_eq!(s(&retry_data, "transferId"), s(&first_data, "transferId"));
    assert_eq!(s(&retry_data, "transferId"), client_id);
    assert_eq!(s(&retry_data, "ledgerTxId"), s(&first_data, "ledgerTxId"));

    assert_eq!(movement_counts(&b).0, 1);
}

// ---------------------------------------------------------------------------------------------------------------
// payroll-ledger-once.db.test.ts: a payroll run cannot reuse or blank its ledger post

const THRESHOLD: &str = "1";
const ACTOR: &str = "l1129-actor";
const FROM_SPACE: &str = "11111111-1111-4111-8111-111111111111";
const CHECK_VIOLATION: &str = "23514";
const UNIQUE_VIOLATION: &str = "23505";
const RUN_BLANK: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const RUN_SAME_A: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const RUN_SAME_B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const RUN_DIFF_A: &str = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const RUN_DIFF_B: &str = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const LEDGER_SAME: &str = "ledger-tx-same";
const LEDGER_A: &str = "ledger-tx-a";
const LEDGER_B: &str = "ledger-tx-b";

/// The suite's `beforeAll`: the account the runs name.
fn payroll_account(b: &Bank) -> String {
    b.sql()
        .query_one(
            "INSERT INTO bank.business_accounts (name, asset_id, spend_threshold) \
             VALUES ($1, $2, $3::text::numeric) RETURNING id::text AS id",
            &[&"l1129", &"USDT", &THRESHOLD],
        )
        .unwrap()
        .get(0)
}

/// `insertRun`: the ids returned, or the SQLSTATE.
fn insert_run(
    b: &Bank,
    account_id: &str,
    id: &str,
    ledger_tx_id: &str,
) -> Result<Vec<String>, String> {
    b.sql()
        .query(
            "INSERT INTO bank.business_payroll_runs (id, account_id, actor_user_id, from_space_id, asset_id, ledger_tx_id) \
             VALUES ($1::text::uuid, $2::text::uuid, $3, $4::text::uuid, $5, $6) RETURNING id::text AS id",
            &[&id, &account_id, &ACTOR, &FROM_SPACE, &"USDT", &ledger_tx_id],
        )
        .map(|rows| rows.iter().map(|r| r.get(0)).collect())
        .map_err(|e| e.code().map_or_else(|| e.to_string(), |c| c.code().to_owned()))
}

fn database_name(b: &Bank) -> String {
    url::Url::parse(&b.db.url)
        .unwrap()
        .path()
        .trim_start_matches('/')
        .to_owned()
}

#[test]
fn runs_in_the_per_run_bank_database_not_the_admin_database() {
    let Some(b) = bank() else { return };
    let _ = payroll_account(&b);
    let name = database_name(&b);
    assert!(
        name.starts_with("itf_run_bank_") && name.ends_with("_test"),
        "{name}"
    );
    assert_ne!(name, "intafaced_test");
    assert_ne!(name, "postgres");
    let current: String = b
        .sql()
        .query_one("SELECT current_database() AS name", &[])
        .unwrap()
        .get(0);
    assert_eq!(current, name);
}

#[test]
fn refuses_a_blank_ledger_tx_id() {
    let Some(b) = bank() else { return };
    let account = payroll_account(&b);
    assert_eq!(
        insert_run(&b, &account, RUN_BLANK, ""),
        Err(CHECK_VIOLATION.to_owned())
    );
}

#[test]
fn refuses_a_second_run_that_reuses_a_ledger_tx_id() {
    let Some(b) = bank() else { return };
    let account = payroll_account(&b);
    let first = insert_run(&b, &account, RUN_SAME_A, LEDGER_SAME).unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(
        insert_run(&b, &account, RUN_SAME_B, LEDGER_SAME),
        Err(UNIQUE_VIOLATION.to_owned())
    );
}

#[test]
fn inserts_two_runs_with_different_ledger_posts() {
    let Some(b) = bank() else { return };
    let account = payroll_account(&b);
    let first = insert_run(&b, &account, RUN_DIFF_A, LEDGER_A).unwrap();
    let second = insert_run(&b, &account, RUN_DIFF_B, LEDGER_B).unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(second.len(), 1);
    assert_eq!(first[0], RUN_DIFF_A);
    assert_eq!(second[0], RUN_DIFF_B);
}
