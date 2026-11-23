//! Roles on a business account against the Rust slice on a real Postgres. Ports the describe "roles on a business
//! account" of the TypeScript's `business/business-roles.db.test.ts` (from its line 79; the role table and the separation
//! of duties above it are unit tests in `src/business/policy.rs`), each test named after the TypeScript test's words.
//! The TypeScript calls `bank.business.*` directly, so each call here is the Rust function it became
//! (`svc_bank::business::service`), given the door's own dependencies (`Bank::deps`); a refusal is read by its
//! `BankError` code, as `rejects.toMatchObject({ code })` reads it.
//!
//! A deposit (`recipes.deposit`) is the kit's `fund_user`, `spaces.create` is the kit's `pot` (the door's
//! `spaces.create` as the owner), and `ledger.reconcile()` is `Book::reconciles`. Each test has its own migrated
//! database, as the TypeScript truncates the tables before each. Without `TEST_DATABASE_URL` each test skips; with
//! `REQUIRE_POSTGRES=1` it fails.
//!
//! Not ported as written:
//! - `bank.business.listMembers(accountId, actor)` in "a security auditor and a viewer read the team but change
//!   nothing": the Rust slice has no raw member list; its one team read is `team` (the router's `business.members`),
//!   which names each member by public handle and refuses the page when a handle is missing. So the three members are
//!   given handles in the kit's directory (the TypeScript's bank has none) and the count is of `team`'s `members`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::too_many_lines,
    reason = "a test: a failure is the point"
)]

use service_kit::json::Json;
use svc_bank::business::service::{
    self as svc, Account, MemberChange, NewAccount, Propose, Proposed,
};
use svc_bank::errors::Refusal;

use crate::business_kit::{Bank, amt, bank, uuid};

const ADMIN: &str = "11111111-1111-4111-8111-111111111111";
const PEER: &str = "22222222-2222-4222-8222-222222222222";

/// `uid(n)`.
fn uid(n: u32) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

/// The refusal's code, as `rejects.toMatchObject({ code })` reads a `BankError`.
fn code<T: std::fmt::Debug>(r: Result<T, Refusal>) -> String {
    match r {
        Err(Refusal::Bank(e)) => e.row.code.to_owned(),
        other => panic!("not a bank refusal: {other:?}"),
    }
}

struct Opened {
    account: Account,
    primary: String,
    pot: String,
}

/// `openAccount()`.
fn open_account(b: &Bank) -> Opened {
    let id = uuid();
    let account = b
        .deps(|d| {
            svc::create_account(
                d,
                &NewAccount {
                    account_id: &id,
                    name: "Roles Co",
                    asset_id: "USDT",
                    spend_threshold: amt("100"),
                    creator_user_id: ADMIN,
                },
            )
        })
        .unwrap();
    let primary = b.primary(ADMIN, "USDT");
    let pot = b.pot(ADMIN, "USDT", "Vendor");
    b.ledger.fund_user(ADMIN, "USDT", "1000");
    Opened {
        account,
        primary,
        pot,
    }
}

/// `ownSpace(userId)`: a funded main space of the teammate's own.
fn own_space(b: &Bank, user: &str) -> String {
    let space = b.primary(user, "USDT");
    b.ledger.fund_user(user, "USDT", "1000");
    space
}

/// `seat(accountId, who)`.
fn seat(b: &Bank, account: &str, who: &[(&str, &str)]) {
    for (user, role) in who {
        b.deps(|d| svc::add_member(d, account, ADMIN, user, role))
            .unwrap();
    }
}

fn propose(
    b: &Bank,
    account: &str,
    maker: &str,
    from: &str,
    to: &str,
) -> Result<Proposed, Refusal> {
    let client = uuid();
    b.deps(|d| {
        svc::propose_transfer(
            d,
            &Propose {
                account_id: account,
                maker_user_id: maker,
                from_space_id: from,
                to_space_id: to,
                amount: amt("250"),
                client_id: &client,
            },
        )
    })
}

fn pending_id(p: Proposed) -> String {
    match p {
        Proposed::Pending(a) => a.id,
        Proposed::Posted { .. } => panic!("expected pending"),
    }
}

fn approve(b: &Bank, approval: &str, checker: &str) -> Result<(String, String), Refusal> {
    b.deps(|d| svc::approve(d, approval, checker))
}

fn reject(b: &Bank, approval: &str, checker: &str) -> Result<(), Refusal> {
    b.deps(|d| svc::reject(d, approval, checker))
}

fn change(
    b: &Bank,
    account: &str,
    actor: &str,
    user: &str,
    role: Option<&str>,
) -> Result<Json, Refusal> {
    let request = uuid();
    b.deps(|d| {
        svc::change_member(
            d,
            &MemberChange {
                account_id: account,
                actor,
                user_id: user,
                request_id: &request,
                role,
            },
        )
    })
}

#[test]
fn a_viewer_a_signer_and_a_security_auditor_cannot_start_a_payment_an_editor_can() {
    let Some(b) = bank() else { return };
    let o = open_account(&b);
    let (u1, u2, u3, u4) = (uid(1), uid(2), uid(3), uid(4));
    seat(
        &b,
        &o.account.id,
        &[
            (&u1, "viewer"),
            (&u2, "signer"),
            (&u3, "security_auditor"),
            (&u4, "editor"),
        ],
    );
    for u in [&u1, &u2, &u3] {
        assert_eq!(
            code(propose(&b, &o.account.id, u, &o.primary, &o.pot)),
            "bank.business_role_forbidden"
        );
    }
    let space = own_space(&b, &u4);
    assert!(matches!(
        propose(&b, &o.account.id, &u4, &space, &o.pot).unwrap(),
        Proposed::Pending(_)
    ));
}

#[test]
fn a_viewer_a_signer_an_editor_and_a_security_auditor_cannot_decide_a_waiting_payment() {
    let Some(b) = bank() else { return };
    let o = open_account(&b);
    let (u1, u2, u3, u4) = (uid(1), uid(2), uid(3), uid(4));
    seat(
        &b,
        &o.account.id,
        &[
            (&u1, "viewer"),
            (&u2, "signer"),
            (&u3, "security_auditor"),
            (&u4, "editor"),
            (PEER, "checker"),
        ],
    );
    let id = pending_id(propose(&b, &o.account.id, ADMIN, &o.primary, &o.pot).unwrap());
    for u in [&u1, &u2, &u3, &u4] {
        assert_eq!(code(approve(&b, &id, u)), "bank.business_role_forbidden");
        assert_eq!(code(reject(&b, &id, u)), "bank.business_role_forbidden");
    }
    // The payment is still waiting and a real approver settles it.
    let (_, ledger_tx_id) = approve(&b, &id, PEER).unwrap();
    assert!(!ledger_tx_id.is_empty());
    assert!(b.ledger.reconciles());
}

#[test]
fn an_initiator_cannot_decide_their_own_payment_even_a_non_signing_administrator() {
    let Some(b) = bank() else { return };
    let o = open_account(&b);
    seat(&b, &o.account.id, &[(PEER, "non_signing_admin")]);
    let peer_space = own_space(&b, PEER);
    let id = pending_id(propose(&b, &o.account.id, PEER, &peer_space, &o.pot).unwrap());
    assert_eq!(code(approve(&b, &id, PEER)), "bank.business_self_approve");
    assert_eq!(code(reject(&b, &id, PEER)), "bank.business_self_approve");
    // A different administrator decides it.
    assert!(!approve(&b, &id, ADMIN).unwrap().1.is_empty());
}

#[test]
fn a_removed_approver_can_no_longer_decide_anything() {
    let Some(b) = bank() else { return };
    let o = open_account(&b);
    seat(&b, &o.account.id, &[(PEER, "checker")]);
    let id = pending_id(propose(&b, &o.account.id, ADMIN, &o.primary, &o.pot).unwrap());
    change(&b, &o.account.id, ADMIN, PEER, None).unwrap();
    assert_eq!(code(approve(&b, &id, PEER)), "bank.business_not_member");
}

#[test]
fn a_removed_initiator_cannot_leave_a_payment_waiting_removal_is_refused_until_it_is_decided() {
    let Some(b) = bank() else { return };
    let o = open_account(&b);
    seat(&b, &o.account.id, &[(PEER, "editor")]);
    let peer_space = own_space(&b, PEER);
    let proposed = propose(&b, &o.account.id, PEER, &peer_space, &o.pot).unwrap();
    pending_id(proposed);
    assert_eq!(
        code(change(&b, &o.account.id, ADMIN, PEER, None)),
        "bank.business_member_has_pending"
    );
}

#[test]
fn only_an_administrator_role_manages_the_team_a_non_signing_administrator_does() {
    let Some(b) = bank() else { return };
    let o = open_account(&b);
    let (u1, u2) = (uid(1), uid(2));
    seat(
        &b,
        &o.account.id,
        &[(PEER, "non_signing_admin"), (&u1, "editor")],
    );
    assert_eq!(
        code(b.deps(|d| svc::add_member(d, &o.account.id, &u1, &u2, "viewer"))),
        "bank.business_role_forbidden"
    );
    let added = b
        .deps(|d| svc::add_member(d, &o.account.id, PEER, &u2, "viewer"))
        .unwrap();
    assert_eq!(
        added.get("role"),
        Some(&Json::str("viewer")),
        "{}",
        added.compact()
    );
    assert_eq!(
        b.deps(|d| svc::my_role(d, &o.account.id, &u2)).unwrap(),
        "viewer"
    );
}

#[test]
fn keeps_one_administrator_neither_re_adding_nor_re_roling_demotes_the_last_one() {
    let Some(b) = bank() else { return };
    let o = open_account(&b);
    assert_eq!(
        code(b.deps(|d| svc::add_member(d, &o.account.id, ADMIN, ADMIN, "viewer"))),
        "bank.business_last_admin"
    );
    assert_eq!(
        code(change(&b, &o.account.id, ADMIN, ADMIN, Some("maker"))),
        "bank.business_last_admin"
    );
    // A non-signing administrator counts as an administrator, so the first can step down once there are two.
    seat(&b, &o.account.id, &[(PEER, "non_signing_admin")]);
    change(&b, &o.account.id, ADMIN, ADMIN, Some("maker")).unwrap();
    assert_eq!(
        code(change(&b, &o.account.id, PEER, PEER, Some("viewer"))),
        "bank.business_last_admin"
    );
}

#[test]
fn a_security_auditor_and_a_viewer_read_the_team_but_change_nothing() {
    let Some(b) = bank() else { return };
    let o = open_account(&b);
    let (u1, u2) = (uid(1), uid(2));
    seat(
        &b,
        &o.account.id,
        &[(&u1, "security_auditor"), (&u2, "viewer")],
    );
    // The team read names members by handle (see the module's note).
    for (id, handle) in [
        (ADMIN, "Roles_Admin"),
        (u1.as_str(), "Roles_Auditor"),
        (u2.as_str(), "Roles_Viewer"),
    ] {
        b.people.person(id, handle, None);
    }
    for u in [&u1, &u2] {
        let team = b.deps(|d| svc::team(d, &o.account.id, u)).unwrap();
        let Some(Json::Array(members)) = team.get("members") else {
            panic!("no members: {}", team.compact());
        };
        assert_eq!(members.len(), 3);
        assert_eq!(
            code(change(&b, &o.account.id, u, ADMIN, None)),
            "bank.business_role_forbidden"
        );
    }
}
