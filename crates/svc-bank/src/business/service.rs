//! `BusinessService` (`business/business-service.ts`) and the operator's queue (`ops/business-approvals.ts`): a company
//! account, its team and dual control.
//!
//! Under the account's spend threshold a transfer is one move of the transfers slice (key space `own`, keyed by the
//! client's id). At or above it the money is first held in a purposed hold (`business-approval:<id>`) so the maker cannot
//! spend it while a checker decides; a different checker settles the hold to the destination, a rejection or a
//! cancellation releases it back. Every row is claimed before its ledger key posts, so a retry with the same id resumes
//! the same instruction and posts nothing new; a lost answer is reconciled by the key, never by a second post.

use std::collections::{BTreeMap, BTreeSet};

use base64::Engine as _;
use base64::engine::DecodePaddingMode;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig, URL_SAFE_NO_PAD};
use postgres::error::SqlState;
use postgres::{GenericClient, Row};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, js_trim, parse_amount};
use service_kit::time::{Instant, js_date};

use super::policy::{self, Capability};
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::ports::{DirError, LedgerAccount, LedgerTx, Lookup, PostFailure};
use crate::spaces::shared::{email_query, handle_query};
use crate::spaces::space::{self, Space, at, in_tx, owner_list_limit, pg, with};
use crate::transfers::Deps;
use crate::transfers::moves::{
    self, MoveAsk, bank_transfer_key, post_refusal, resolve_for_credit, resolve_for_debit,
};

/// `floor(extract(epoch from <col>) * 1000)::int8`: a time column as JavaScript's `Date` reads it.
fn ms(col: &str) -> String {
    format!("floor(extract(epoch from {col}) * 1000)::int8")
}

fn account_cols(p: &str) -> String {
    format!(
        "{p}id::text, {p}name, {p}asset_id, {p}spend_threshold::text, {p}status, {}",
        ms(&format!("{p}created_at"))
    )
}

fn approval_cols(p: &str) -> String {
    format!(
        "{p}id::text, {p}account_id::text, {p}maker_user_id, {p}checker_user_id, {p}from_space_id::text, \
         {p}to_space_id::text, {p}asset_id, {p}amount::text, {p}status::text, {p}transfer_id, {p}hold_ledger_tx_id, \
         {p}ledger_tx_id, {p}rejection_code, {}, {}",
        ms(&format!("{p}created_at")),
        ms(&format!("{p}decided_at"))
    )
}

fn get_s(r: &Row, i: usize) -> Result<String, Refusal> {
    r.try_get::<_, String>(i).map_err(|e| pg(&e))
}

fn get_o(r: &Row, i: usize) -> Result<Option<String>, Refusal> {
    r.try_get::<_, Option<String>>(i).map_err(|e| pg(&e))
}

fn get_t(r: &Row, i: usize) -> Result<Option<Instant>, Refusal> {
    Ok(r.try_get::<_, Option<i64>>(i)
        .map_err(|e| pg(&e))?
        .map(Instant))
}

fn amount(s: &str) -> Result<Amount, Refusal> {
    parse_amount(s).map_err(Refusal::Other)
}

fn iso(t: Option<Instant>) -> Json {
    t.map_or(Json::Null, |t| Json::str(t.iso()))
}

fn opt(s: Option<&str>) -> Json {
    s.map_or(Json::Null, Json::str)
}

/// `BusinessAccount`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub id: String,
    pub name: String,
    pub asset_id: String,
    pub spend_threshold: Amount,
    /// `active` or `closed`.
    pub status: String,
    pub created_at: Instant,
}

impl Account {
    fn from_row(r: &Row) -> Result<Account, Refusal> {
        Ok(Account {
            id: get_s(r, 0)?,
            name: get_s(r, 1)?,
            asset_id: get_s(r, 2)?,
            spend_threshold: amount(&get_s(r, 3)?)?,
            status: get_s(r, 4)?,
            created_at: get_t(r, 5)?.unwrap_or(Instant(0)),
        })
    }

    /// `businessAccountOutput`.
    pub fn json(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("name", Json::str(self.name.clone())),
            ("assetId", Json::str(self.asset_id.clone())),
            (
                "spendThreshold",
                Json::str(format_amount(self.spend_threshold)),
            ),
            ("status", Json::str(self.status.clone())),
            ("createdAt", Json::str(self.created_at.iso())),
        ])
    }
}

/// `BusinessApproval`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Approval {
    pub id: String,
    pub account_id: String,
    pub maker_user_id: String,
    pub checker_user_id: Option<String>,
    pub from_space_id: String,
    pub to_space_id: String,
    pub asset_id: String,
    pub amount: Amount,
    /// `pending`, `approved`, `rejected` or `cancelled`.
    pub status: String,
    pub transfer_id: Option<String>,
    pub hold_ledger_tx_id: Option<String>,
    pub ledger_tx_id: Option<String>,
    pub rejection_code: Option<String>,
    pub created_at: Instant,
    pub decided_at: Option<Instant>,
}

impl Approval {
    fn from_row(r: &Row) -> Result<Approval, Refusal> {
        Ok(Approval {
            id: get_s(r, 0)?,
            account_id: get_s(r, 1)?,
            maker_user_id: get_s(r, 2)?,
            checker_user_id: get_o(r, 3)?,
            from_space_id: get_s(r, 4)?,
            to_space_id: get_s(r, 5)?,
            asset_id: get_s(r, 6)?,
            amount: amount(&get_s(r, 7)?)?,
            status: get_s(r, 8)?,
            transfer_id: get_o(r, 9)?,
            hold_ledger_tx_id: get_o(r, 10)?,
            ledger_tx_id: get_o(r, 11)?,
            rejection_code: get_o(r, 12)?,
            created_at: get_t(r, 13)?.unwrap_or(Instant(0)),
            decided_at: get_t(r, 14)?,
        })
    }

    /// `businessApprovalOutput`.
    pub fn json(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("accountId", Json::str(self.account_id.clone())),
            ("makerUserId", Json::str(self.maker_user_id.clone())),
            ("checkerUserId", opt(self.checker_user_id.as_deref())),
            ("fromSpaceId", Json::str(self.from_space_id.clone())),
            ("toSpaceId", Json::str(self.to_space_id.clone())),
            ("assetId", Json::str(self.asset_id.clone())),
            ("amount", Json::str(format_amount(self.amount))),
            ("status", Json::str(self.status.clone())),
            ("transferId", opt(self.transfer_id.as_deref())),
            ("holdLedgerTxId", opt(self.hold_ledger_tx_id.as_deref())),
            ("ledgerTxId", opt(self.ledger_tx_id.as_deref())),
            ("createdAt", Json::str(self.created_at.iso())),
        ])
    }
}

/// What `proposeTransfer` answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Proposed {
    Posted {
        transfer_id: String,
        ledger_tx_id: String,
    },
    Pending(Box<Approval>),
}

impl Proposed {
    /// The router's output: `posted` with its ids, or `pending` with the approval.
    pub fn json(&self) -> Json {
        match self {
            Proposed::Posted {
                transfer_id,
                ledger_tx_id,
            } => Json::obj([
                ("kind", Json::str("posted")),
                ("transferId", Json::str(transfer_id.clone())),
                ("ledgerTxId", Json::str(ledger_tx_id.clone())),
            ]),
            Proposed::Pending(a) => {
                Json::obj([("kind", Json::str("pending")), ("approval", a.json())])
            }
        }
    }
}

/// What a proposal asks for.
#[derive(Debug, Clone)]
pub struct Propose<'a> {
    pub account_id: &'a str,
    pub maker_user_id: &'a str,
    pub from_space_id: &'a str,
    pub to_space_id: &'a str,
    pub amount: Amount,
    pub client_id: &'a str,
}

/// `BusinessPayrollRun`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayrollRun {
    pub payroll_id: String,
    pub account_id: String,
    pub actor_user_id: String,
    pub from_space_id: String,
    pub asset_id: String,
    pub ledger_tx_id: String,
    /// `(toSpaceId, amount)`, by space id.
    pub recipients: Vec<(String, Amount)>,
    pub created_at: Instant,
}

impl PayrollRun {
    /// The router's output.
    pub fn json(&self) -> Json {
        Json::obj([
            ("payrollId", Json::str(self.payroll_id.clone())),
            ("accountId", Json::str(self.account_id.clone())),
            ("fromSpaceId", Json::str(self.from_space_id.clone())),
            ("assetId", Json::str(self.asset_id.clone())),
            ("ledgerTxId", Json::str(self.ledger_tx_id.clone())),
            (
                "recipients",
                Json::Array(
                    self.recipients
                        .iter()
                        .map(|(to, a)| {
                            Json::obj([
                                ("toSpaceId", Json::str(to.clone())),
                                ("amount", Json::str(format_amount(*a))),
                            ])
                        })
                        .collect(),
                ),
            ),
            ("createdAt", Json::str(self.created_at.iso())),
        ])
    }
}

/// What a payroll asks for.
#[derive(Debug, Clone)]
pub struct Payroll<'a> {
    pub payroll_id: &'a str,
    pub account_id: &'a str,
    pub actor_user_id: &'a str,
    pub from_space_id: &'a str,
    pub recipients: Vec<(String, Amount)>,
}

/// An account control's answer (`BusinessControlResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Control {
    pub status: &'static str,
    pub request_id: String,
    pub account: Account,
}

impl Control {
    pub fn json(&self) -> Json {
        Json::obj([
            ("status", Json::str(self.status)),
            ("requestId", Json::str(self.request_id.clone())),
            ("account", self.account.json()),
        ])
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Refusals

fn closed() -> Refusal {
    refuse("bank.business_closed", "Business account is closed")
}

fn not_member() -> Refusal {
    refuse(
        "bank.business_not_member",
        "Not a member of this business account",
    )
}

fn conflict(message: impl Into<String>) -> Refusal {
    refuse("bank.business_request_conflict", message)
}

fn inactive(message: impl Into<String>) -> Refusal {
    refuse("bank.business_approval_inactive", message)
}

fn payroll_conflict(id: &str) -> Refusal {
    conflict(format!("Payroll {id} already exists on different terms"))
}

fn role_forbidden(role: &str, capability: Capability) -> Refusal {
    refuse(
        "bank.business_role_forbidden",
        format!(
            "Role {role} cannot perform this action (need {})",
            policy::roles_with(capability)
        ),
    )
}

fn last_admin(verb: &str) -> Refusal {
    refuse(
        "bank.business_last_admin",
        format!("The last administrator cannot be {verb} (bank.business_last_admin)"),
    )
}

fn self_approve(message: &str) -> Refusal {
    refuse("bank.business_self_approve", message)
}

fn require_request_id(request_id: &str) -> Result<(), Refusal> {
    if request_id.is_empty() {
        return Err(refuse(
            "bank.business_request_id_required",
            "This change needs a caller-stable request id",
        ));
    }
    Ok(())
}

/// `directoryError`: unset stays unset; anything else is unavailable. The directory port names no detail here, so each
/// answers its one sentence.
fn directory_error(e: DirError) -> Refusal {
    match e {
        DirError::Unset => refuse(
            "bank.business_directory_unset",
            "IDENTITY_URL is unset, so svc-bank cannot read public handles from svc-identity. Team list, approval history and recipient lookup stay closed until that directory is connected (bank.business_directory_unset)",
        ),
        DirError::Unavailable => refuse(
            "bank.business_directory_unavailable",
            "svc-identity did not answer the business directory. Nothing was listed. Retry shortly (bank.business_directory_unavailable)",
        ),
    }
}

fn cursor_invalid() -> Refusal {
    refuse(
        "bank.business_cursor_invalid",
        "The approvals page cursor is not valid. Ask for the first page again.",
    )
}

// ---------------------------------------------------------------------------------------------------------------
// The ledger

/// `businessApprovalHoldFor`: the purposed hold on the debit pot's own owner.
pub fn hold_account(from: &LedgerAccount, approval_id: &str) -> LedgerAccount {
    LedgerAccount {
        owner_type: from.owner_type,
        owner_id: from.owner_id.clone(),
        asset_id: from.asset_id.clone(),
        kind: "hold",
        purpose: Some(format!("business-approval:{approval_id}")),
    }
}

pub fn hold_key(id: &str) -> String {
    format!("bank.business.hold:{id}")
}

pub fn settle_key(id: &str) -> String {
    format!("bank.business.settle:{id}")
}

pub fn release_key(id: &str) -> String {
    format!("bank.business.release:{id}")
}

pub fn payroll_key(id: &str) -> String {
    format!("bank.business.payroll:{id}")
}

/// Why a post was not made: the custody switch refused it before svc-ledger was asked, or svc-ledger failed.
#[derive(Debug)]
enum PostError {
    Custody(Refusal),
    Ledger(PostFailure),
}

impl PostError {
    fn refusal(&self) -> Refusal {
        match self {
            PostError::Custody(r) => r.clone(),
            PostError::Ledger(f) => post_refusal(f),
        }
    }
}

fn no_partner_bank() -> Refusal {
    refuse(
        "bank.no_partner_bank",
        "No banking partner holds this money, and INTAFACED holds no customer money, so nothing was moved.",
    )
}

/// `custodyGuardedLedger`'s `post`: every business recipe moves a customer balance, so with the custodial layer off
/// none reaches svc-ledger.
fn post(d: &Deps<'_>, recipe: &str, input: &Json, key: &str) -> Result<LedgerTx, PostError> {
    if d.partner.custody_layer != "on" {
        return Err(PostError::Custody(no_partner_bank()));
    }
    d.ledger
        .post_recipe(recipe, input, key)
        .map_err(PostError::Ledger)
}

fn tx_by_key(d: &Deps<'_>, key: &str) -> Result<Option<LedgerTx>, Refusal> {
    d.ledger.tx_by_key(key).map_err(Refusal::Other)
}

fn receipt_unavailable() -> Refusal {
    Refusal::Other("Business transfer receipt is unavailable (ledger.unavailable)".to_owned())
}

/// `withEntries`: a receipt with no legs is read back by id; one the ledger then cannot show is unavailable.
fn with_entries(d: &Deps<'_>, tx: LedgerTx) -> Result<LedgerTx, Refusal> {
    if !tx.entries.is_empty() {
        return Ok(tx);
    }
    d.ledger
        .tx_by_id(&tx.id)
        .map_err(Refusal::Other)?
        .ok_or_else(receipt_unavailable)
}

/// `postedPayrollMatches`: the posted book is the instruction. One credit of the whole on the source, and one debit of
/// each line's amount on each line's own account, none twice.
fn posted_matches(
    d: &Deps<'_>,
    posted: &LedgerTx,
    from: &LedgerAccount,
    lines: &[(Amount, LedgerAccount)],
) -> Result<bool, Refusal> {
    let source = d.ledger.account_id(from).map_err(Refusal::Other)?;
    if source.is_empty() {
        return Ok(false);
    }
    let total: Amount = lines.iter().map(|(a, _)| *a).sum();
    let credits: Vec<_> = posted
        .entries
        .iter()
        .filter(|e| e.direction == "credit")
        .collect();
    let debits: Vec<_> = posted
        .entries
        .iter()
        .filter(|e| e.direction == "debit")
        .collect();
    match credits.as_slice() {
        [c] if c.account_id == source && c.amount == total => {}
        _ => return Ok(false),
    }
    if debits.len() != lines.len() {
        return Ok(false);
    }
    let mut paid: BTreeMap<&str, Amount> = BTreeMap::new();
    for e in &debits {
        if paid.insert(e.account_id.as_str(), e.amount).is_some() {
            return Ok(false);
        }
    }
    for (a, acct) in lines {
        let dest = d.ledger.account_id(acct).map_err(Refusal::Other)?;
        if dest.is_empty() || paid.get(dest.as_str()) != Some(a) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn hold_input(id: &str, from: &LedgerAccount, amount: Amount) -> Json {
    Json::obj([
        ("approvalId", Json::str(id)),
        ("from", from.json()),
        ("amount", Json::str(format_amount(amount))),
    ])
}

// ---------------------------------------------------------------------------------------------------------------
// Reads the checks share

fn account_in(c: &mut impl GenericClient, id: &str) -> Result<Account, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.business_accounts WHERE id = $1::text::uuid",
                account_cols("")
            ),
            &[&id],
        )
        .map_err(|e| pg(&e))?;
    match rows.first() {
        Some(r) => Account::from_row(r),
        None => Err(refuse(
            "bank.business_not_found",
            format!("Business account {id} not found"),
        )),
    }
}

fn account(d: &Deps<'_>, id: &str) -> Result<Account, Refusal> {
    with(d.store, |c| account_in(c, id))
}

fn approval_in(c: &mut impl GenericClient, id: &str) -> Result<Option<Approval>, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.business_approvals WHERE id = $1::text::uuid",
                approval_cols("")
            ),
            &[&id],
        )
        .map_err(|e| pg(&e))?;
    rows.first().map(Approval::from_row).transpose()
}

fn approval(d: &Deps<'_>, id: &str) -> Result<Approval, Refusal> {
    with(d.store, |c| approval_in(c, id))?.ok_or_else(|| {
        refuse(
            "bank.business_approval_not_found",
            format!("Approval {id} not found"),
        )
    })
}

fn approval_exists(d: &Deps<'_>, id: &str) -> Result<bool, Refusal> {
    Ok(with(d.store, |c| approval_in(c, id))?.is_some())
}

/// `assertMember`: the caller's role on the account.
fn member_role(
    c: &mut impl GenericClient,
    account_id: &str,
    user_id: &str,
) -> Result<String, Refusal> {
    let rows = c
        .query(
            "SELECT role::text FROM bank.business_members WHERE account_id = $1::text::uuid AND user_id = $2",
            &[&account_id, &user_id],
        )
        .map_err(|e| pg(&e))?;
    match rows.first() {
        Some(r) => get_s(r, 0),
        None => Err(not_member()),
    }
}

fn assert_member(d: &Deps<'_>, account_id: &str, user_id: &str) -> Result<String, Refusal> {
    with(d.store, |c| member_role(c, account_id, user_id))
}

/// `assertRole`: the caller holds `capability` now; a removed member holds none.
fn assert_role(
    d: &Deps<'_>,
    account_id: &str,
    user_id: &str,
    capability: Capability,
) -> Result<(), Refusal> {
    let role = assert_member(d, account_id, user_id)?;
    if !policy::role_can(&role, capability) {
        return Err(role_forbidden(&role, capability));
    }
    Ok(())
}

/// `lockMembers`: `(user_id, role)` of every member, locked.
fn lock_members(
    c: &mut impl GenericClient,
    account_id: &str,
) -> Result<Vec<(String, String)>, Refusal> {
    let rows = c
        .query(
            "SELECT user_id, role::text FROM bank.business_members WHERE account_id = $1::text::uuid FOR UPDATE",
            &[&account_id],
        )
        .map_err(|e| pg(&e))?;
    rows.iter()
        .map(|r| Ok((get_s(r, 0)?, get_s(r, 1)?)))
        .collect()
}

fn assert_admin_locked(members: &[(String, String)], actor: &str) -> Result<(), Refusal> {
    let Some((_, role)) = members.iter().find(|(u, _)| u == actor) else {
        return Err(not_member());
    };
    if !policy::role_can(role, Capability::ManageTeam) {
        return Err(role_forbidden(role, Capability::ManageTeam));
    }
    Ok(())
}

fn managers(members: &[(String, String)]) -> usize {
    members
        .iter()
        .filter(|(_, r)| policy::role_can(r, Capability::ManageTeam))
        .count()
}

// ---------------------------------------------------------------------------------------------------------------
// Accounts and members

/// What `createAccount` asks for.
pub struct NewAccount<'a> {
    pub account_id: &'a str,
    pub name: &'a str,
    pub asset_id: &'a str,
    pub spend_threshold: Amount,
    pub creator_user_id: &'a str,
}

/// `createAccount`: the account and its first administrator, once per caller's id; the same id on other terms
/// refuses.
pub fn create_account(d: &Deps<'_>, ask: &NewAccount<'_>) -> Result<Account, Refusal> {
    if ask.account_id.is_empty() {
        return Err(refuse(
            "bank.business_request_id_required",
            "Business create needs a caller-stable account id",
        ));
    }
    if ask.spend_threshold <= 0 {
        return Err(refuse(
            "bank.business_invalid_threshold",
            "Business spend threshold must be positive",
        ));
    }
    let name = js_trim(ask.name);
    if name.is_empty() {
        return Err(refuse(
            "bank.business_invalid_name",
            "Business account needs a name",
        ));
    }
    let threshold = format_amount(ask.spend_threshold);
    let account = in_tx(d.store, |tx| {
        let inserted = tx
            .query(
                &format!(
                    "INSERT INTO bank.business_accounts (id, name, asset_id, spend_threshold, status, owner_user_id) \
                     VALUES ($1::text::uuid, $2, $3, $4::text::numeric, 'active', $5) \
                     ON CONFLICT DO NOTHING RETURNING {}",
                    account_cols("")
                ),
                &[&ask.account_id, &name, &ask.asset_id, &threshold, &ask.creator_user_id],
            )
            .map_err(|e| pg(&e))?;
        if let Some(r) = inserted.first() {
            let a = Account::from_row(r)?;
            tx.execute(
                "INSERT INTO bank.business_members (account_id, user_id, role) VALUES ($1::text::uuid, $2, 'admin')",
                &[&a.id, &ask.creator_user_id],
            )
            .map_err(|e| pg(&e))?;
            return Ok(a);
        }
        let existing = account_in(tx, ask.account_id)?;
        let role = tx
            .query(
                "SELECT role::text FROM bank.business_members WHERE account_id = $1::text::uuid AND user_id = $2",
                &[&ask.account_id, &ask.creator_user_id],
            )
            .map_err(|e| pg(&e))?
            .first()
            .map(|r| get_s(r, 0))
            .transpose()?;
        let same_owner = role.as_deref() == Some("admin");
        let same_rules = existing.name == name
            && existing.asset_id == ask.asset_id
            && existing.spend_threshold == ask.spend_threshold;
        if !same_owner || !same_rules {
            return Err(refuse(
                "bank.business_conflict",
                "This business id is already in use on different terms (bank.business_conflict)",
            ));
        }
        Ok(existing)
    })?;
    with(d.store, |c| {
        space::ensure_primary(c, ask.creator_user_id, ask.asset_id)
    })?;
    Ok(account)
}

/// `addMember`: adds or re-roles a member; re-roling obeys the last-administrator rule.
pub fn add_member(
    d: &Deps<'_>,
    account_id: &str,
    actor: &str,
    user_id: &str,
    role: &str,
) -> Result<Json, Refusal> {
    in_tx(d.store, |tx| {
        let members = lock_members(tx, account_id)?;
        assert_admin_locked(&members, actor)?;
        if let Some((_, current)) = members.iter().find(|(u, _)| u == user_id)
            && policy::role_can(current, Capability::ManageTeam)
            && !policy::role_can(role, Capability::ManageTeam)
            && managers(&members) < 2
        {
            return Err(last_admin("demoted"));
        }
        let rows = tx
            .query(
                "INSERT INTO bank.business_members (account_id, user_id, role) \
                 VALUES ($1::text::uuid, $2, $3::text::bank.business_member_role) \
                 ON CONFLICT (account_id, user_id) DO UPDATE SET role = EXCLUDED.role, custom_role_id = NULL, advisor = false \
                 RETURNING account_id::text, user_id, role::text",
                &[&account_id, &user_id, &role],
            )
            .map_err(|e| pg(&e))?;
        let r = rows
            .first()
            .ok_or_else(|| Refusal::Other("member upsert returned no row".to_owned()))?;
        Ok(Json::obj([
            ("accountId", Json::str(get_s(r, 0)?)),
            ("userId", Json::str(get_s(r, 1)?)),
            ("role", Json::str(get_s(r, 2)?)),
        ]))
    })
}

/// `accountsOf`: the person's accounts, newest first; a closed account stays on the list.
pub fn accounts_of(
    d: &Deps<'_>,
    user_id: &str,
    limit: Option<f64>,
) -> Result<Vec<Account>, Refusal> {
    let page = owner_list_limit(limit, "bank.business_list_limit_unset", "business.list")?;
    with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.business_accounts a JOIN bank.business_members m ON m.account_id = a.id \
                     WHERE m.user_id = $1 ORDER BY a.created_at DESC LIMIT $2",
                    account_cols("a.")
                ),
                &[&user_id, &page],
            )
            .map_err(|e| pg(&e))?;
        rows.iter().map(Account::from_row).collect()
    })
}

/// `myRole`: the caller's role, or `bank.business_not_found` for a stranger and an unknown account alike.
pub fn my_role(d: &Deps<'_>, account_id: &str, user_id: &str) -> Result<String, Refusal> {
    let role = with(d.store, |c| {
        let rows = c
            .query(
                "SELECT m.role::text FROM bank.business_accounts a \
                 JOIN bank.business_members m ON m.account_id = a.id AND m.user_id = $2 \
                 WHERE a.id = $1::text::uuid",
                &[&account_id, &user_id],
            )
            .map_err(|e| pg(&e))?;
        rows.first().map(|r| get_s(r, 0)).transpose()
    })?;
    match role {
        Some(r) if policy::ROLES.contains(&r.as_str()) => Ok(r),
        _ => Err(refuse(
            "bank.business_not_found",
            format!("Business account {account_id} not found"),
        )),
    }
}

/// `approverEligibility`: whether a person's role may approve for an open account (svc-pay's question). A read.
pub fn approver_eligibility(
    d: &Deps<'_>,
    account_id: &str,
    user_id: &str,
) -> Result<Json, Refusal> {
    with(d.store, |c| {
        let state = |s: &str| Json::obj([("state", Json::str(s))]);
        let rows = c
            .query(
                "SELECT status FROM bank.business_accounts WHERE id = $1::text::uuid",
                &[&account_id],
            )
            .map_err(|e| pg(&e))?;
        let Some(a) = rows.first() else {
            return Ok(state("no_such_account"));
        };
        if get_s(a, 0)? != "active" {
            return Ok(state("account_closed"));
        }
        let rows = c
            .query(
                "SELECT role::text FROM bank.business_members WHERE account_id = $1::text::uuid AND user_id = $2",
                &[&account_id, &user_id],
            )
            .map_err(|e| pg(&e))?;
        let Some(m) = rows.first() else {
            return Ok(state("not_a_member"));
        };
        let role = get_s(m, 0)?;
        let st = if policy::ROLES.contains(&role.as_str())
            && policy::role_can(&role, Capability::Approve)
        {
            "eligible"
        } else {
            "role_cannot_approve"
        };
        Ok(Json::obj([
            ("state", Json::str(st)),
            ("role", Json::str(role)),
        ]))
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Proposals

fn assert_same_terms(existing: &Approval, ask: &Propose<'_>) -> Result<(), Refusal> {
    if existing.account_id != ask.account_id
        || existing.maker_user_id != ask.maker_user_id
        || existing.from_space_id != ask.from_space_id
        || existing.to_space_id != ask.to_space_id
        || existing.amount != ask.amount
    {
        return Err(conflict(format!(
            "Proposal {} already exists on different terms — a retry must carry the same instruction",
            ask.client_id
        )));
    }
    Ok(())
}

fn decide_existing(existing: Approval, ask: &Propose<'_>) -> Result<Proposed, Refusal> {
    assert_same_terms(&existing, ask)?;
    if existing.status == "pending" {
        return Ok(Proposed::Pending(Box::new(existing)));
    }
    if existing.status == "approved"
        && let Some(ledger_tx_id) = existing.ledger_tx_id.clone()
    {
        return Ok(Proposed::Posted {
            transfer_id: existing
                .transfer_id
                .clone()
                .unwrap_or_else(|| existing.id.clone()),
            ledger_tx_id,
        });
    }
    Err(inactive(format!(
        "Approval {} is {}",
        existing.id, existing.status
    )))
}

/// `proposeTransfer`: under the threshold one move; at or above it a held proposal for a different checker. The
/// caller's id is the instruction's: a retry resumes it, other terms refuse.
pub fn propose_transfer(d: &Deps<'_>, ask: &Propose<'_>) -> Result<Proposed, Refusal> {
    if ask.client_id.is_empty() {
        return Err(refuse(
            "bank.business_request_id_required",
            "Business propose needs a caller-stable client id",
        ));
    }
    if ask.amount <= 0 {
        return Err(refuse(
            "bank.below_minimum",
            "Transfer amount must be positive",
        ));
    }
    let acct = account(d, ask.account_id)?;
    if acct.status != "active" {
        return Err(closed());
    }
    assert_role(d, ask.account_id, ask.maker_user_id, Capability::Propose)?;
    let from = with(d.store, |c| resolve_for_debit(c, ask.from_space_id, d.now))?;
    let already = || -> Result<bool, Refusal> {
        Ok(approval_exists(d, ask.client_id)?
            || tx_by_key(d, &bank_transfer_key("own", ask.client_id, 0))?.is_some()
            || tx_by_key(d, &hold_key(ask.client_id))?.is_some())
    };
    let to = with(d.store, |c| {
        resolve_for_credit(d, c, ask.to_space_id, Some(&from.user_id), Some(&already))
    })?;
    if from.asset_id != acct.asset_id || to.asset_id != acct.asset_id {
        return Err(refuse(
            "bank.asset_mismatch",
            format!(
                "Business account {} cannot move {}→{}",
                acct.asset_id, from.asset_id, to.asset_id
            ),
        ));
    }
    if from.user_id != ask.maker_user_id {
        return Err(refuse(
            "bank.not_owner",
            "Maker must own the debit space in this partial",
        ));
    }
    let client_id = ask.client_id;
    if let Some(existing) = with(d.store, |c| approval_in(c, client_id))? {
        return resume_proposal(d, existing, ask);
    }
    // Pre-claim receipts: neither ledger key may be rebound to other terms or a second money path.
    let previous_transfer = tx_by_key(d, &bank_transfer_key("own", client_id, 0))?
        .map(|t| with_entries(d, t))
        .transpose()?;
    let previous_hold = tx_by_key(d, &hold_key(client_id))?
        .map(|t| with_entries(d, t))
        .transpose()?;
    let from_acct = from.ledger_account();
    let hold_dest = hold_account(&from_acct, client_id);
    let transfer_differs = match &previous_transfer {
        Some(t) => !posted_matches(d, t, &from_acct, &[(ask.amount, to.ledger_account())])?,
        None => false,
    };
    let hold_differs = match &previous_hold {
        Some(t) => !posted_matches(d, t, &from_acct, &[(ask.amount, hold_dest)])?,
        None => false,
    };
    if transfer_differs || hold_differs || (previous_transfer.is_some() && previous_hold.is_some())
    {
        return Err(conflict(
            "The ledger instruction differs from the original proposal",
        ));
    }
    let immediate = previous_hold.is_none() && ask.amount < acct.spend_threshold;
    if previous_transfer.is_some() && !immediate {
        return Err(conflict(
            "The original transfer cannot become an approval hold",
        ));
    }
    let status = if immediate { "approved" } else { "pending" };
    let transfer_id = immediate.then_some(client_id);
    let decided = immediate.then_some(d.now.0);
    let amount_text = format_amount(ask.amount);
    let claimed = with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "INSERT INTO bank.business_approvals \
                       (id, account_id, maker_user_id, from_space_id, to_space_id, asset_id, amount, status, transfer_id, decided_at) \
                     VALUES ($1::text::uuid, $2::text::uuid, $3, $4::text::uuid, $5::text::uuid, $6, $7::text::numeric, \
                       $8::text::bank.business_approval_status, $9, CASE WHEN $10::int8 IS NULL THEN NULL ELSE {} END) \
                     ON CONFLICT (id) DO NOTHING RETURNING {}",
                    at("$10"),
                    approval_cols("")
                ),
                &[
                    &client_id,
                    &ask.account_id,
                    &ask.maker_user_id,
                    &ask.from_space_id,
                    &ask.to_space_id,
                    &acct.asset_id,
                    &amount_text,
                    &status,
                    &transfer_id,
                    &decided,
                ],
            )
            .map_err(|e| pg(&e))?;
        rows.first().map(Approval::from_row).transpose()
    })?;
    let row = match claimed {
        Some(a) => a,
        None => approval(d, client_id)?,
    };
    resume_proposal(d, row, ask)
}

/// `resumeProposal`: finishes a durable claim without changing its instruction or ledger key.
fn resume_proposal(d: &Deps<'_>, a: Approval, ask: &Propose<'_>) -> Result<Proposed, Refusal> {
    assert_same_terms(&a, ask)?;
    if a.status == "pending" && a.hold_ledger_tx_id.is_none() {
        return resume_hold(d, a, ask);
    }
    if a.status == "cancelled" || a.status == "rejected" {
        release_hold(d, &a)?;
    }
    if a.status != "approved" || a.ledger_tx_id.is_some() || a.hold_ledger_tx_id.is_some() {
        return decide_existing(a, ask);
    }
    // An immediate transfer: the transfers slice's own move, through the same custody guard as every other post.
    let (from, to) = with(d.store, |c| {
        Ok((
            space::get(c, &a.from_space_id)?,
            space::get(c, &a.to_space_id)?,
        ))
    })?;
    if d.custody.bank_for(&from.user_id).is_none()
        && d.custody.bank_for(&to.user_id).is_none()
        && d.partner.custody_layer != "on"
    {
        return Err(no_partner_bank());
    }
    let moved = moves::transfer(
        d,
        &MoveAsk {
            transfer_id: &a.id,
            from_space_id: &a.from_space_id,
            to_space_id: &a.to_space_id,
            amount: a.amount,
            note: None,
            reference: None,
            key_space: "own",
        },
    )?;
    let ledger_tx_id = moved
        .ledger_tx_id()
        .ok_or_else(|| Refusal::Other("a business transfer was made at the partner".to_owned()))?
        .to_owned();
    let receipt = d
        .ledger
        .tx_by_id(&ledger_tx_id)
        .map_err(Refusal::Other)?
        .ok_or_else(receipt_unavailable)?;
    if receipt.key != bank_transfer_key("own", &a.id, 0)
        || !posted_matches(
            d,
            &receipt,
            &from.ledger_account(),
            &[(a.amount, to.ledger_account())],
        )?
    {
        return Err(conflict(
            "The ledger transfer differs from the original proposal",
        ));
    }
    let recorded = with(d.store, |c| {
        c.query(
            "UPDATE bank.business_approvals SET ledger_tx_id = $2 \
             WHERE id = $1::text::uuid AND status = 'approved' AND hold_ledger_tx_id IS NULL \
               AND (ledger_tx_id IS NULL OR ledger_tx_id = $2) RETURNING id",
            &[&a.id, &ledger_tx_id],
        )
        .map_err(|e| pg(&e))
    })?;
    if recorded.is_empty() {
        return Err(conflict("The proposal no longer names this transfer"));
    }
    Ok(Proposed::Posted {
        transfer_id: a.id,
        ledger_tx_id,
    })
}

/// `resumeHold`: posts the claimed hold under its key and records it; a cancellation that won meanwhile is compensated
/// with the original release key.
fn resume_hold(d: &Deps<'_>, a: Approval, ask: &Propose<'_>) -> Result<Proposed, Refusal> {
    let from = with(d.store, |c| space::get(c, &a.from_space_id))?;
    let from_acct = from.ledger_account();
    let key = hold_key(&a.id);
    let posted = post(
        d,
        "businessApprovalHold",
        &hold_input(&a.id, &from_acct, a.amount),
        &key,
    )
    .map_err(|e| e.refusal())?;
    let held = with_entries(d, posted)?;
    if held.key != key
        || !posted_matches(
            d,
            &held,
            &from_acct,
            &[(a.amount, hold_account(&from_acct, &a.id))],
        )?
    {
        return Err(conflict(
            "The ledger hold differs from the original proposal",
        ));
    }
    let recorded = with(d.store, |c| {
        c.query(
            "UPDATE bank.business_approvals SET hold_ledger_tx_id = $2 \
             WHERE id = $1::text::uuid AND status = 'pending' \
               AND (hold_ledger_tx_id IS NULL OR hold_ledger_tx_id = $2) RETURNING id",
            &[&a.id, &held.id],
        )
        .map_err(|e| pg(&e))
    })?;
    let current = approval(d, &a.id)?;
    if recorded.is_empty() {
        if current.status == "cancelled" || current.status == "rejected" {
            release_hold(d, &current)?;
        }
        if current.status != "pending" {
            return Err(inactive(format!("Approval {} is {}", a.id, current.status)));
        }
    }
    decide_existing(current, ask)
}

// ---------------------------------------------------------------------------------------------------------------
// The checker's decision

fn self_approval(a: &Approval, checker: &str) -> Result<(), Refusal> {
    if policy::duty_clash(Some(&a.maker_user_id), Some(checker), None).is_some() {
        return Err(self_approve("Maker cannot approve their own transfer"));
    }
    Ok(())
}

/// `approve`: a different checker settles the held transfer. A refusal from identity before the claim leaves the row
/// pending, so reject and cancel can still release it.
pub fn approve(
    d: &Deps<'_>,
    approval_id: &str,
    checker: &str,
) -> Result<(String, String), Refusal> {
    let a = approval(d, approval_id)?;
    if a.status == "approved" {
        if let Some(ledger) = &a.ledger_tx_id {
            return Ok((
                a.transfer_id.clone().unwrap_or_else(|| a.id.clone()),
                ledger.clone(),
            ));
        }
        if a.hold_ledger_tx_id.is_none() {
            return Err(inactive(
                "Retry the original proposal to complete this transfer",
            ));
        }
        self_approval(&a, checker)?;
        assert_role(d, &a.account_id, checker, Capability::Approve)?;
        return finish_settle(d, &a);
    }
    if a.status != "pending" {
        return Err(inactive(format!("Approval {} is {}", a.id, a.status)));
    }
    if a.hold_ledger_tx_id.is_none() {
        return Err(inactive("Retry the original proposal to complete its hold"));
    }
    self_approval(&a, checker)?;
    assert_role(d, &a.account_id, checker, Capability::Approve)?;
    resolve_settle_target(d, &a)?;
    let claimed = with(d.store, |c| {
        c.query(
            "UPDATE bank.business_approvals \
                SET status = 'approved', checker_user_id = $2, transfer_id = $1, decided_at = now() \
              WHERE id = $1::text::uuid AND status = 'pending' AND hold_ledger_tx_id IS NOT NULL RETURNING id",
            &[&a.id, &checker],
        )
        .map_err(|e| pg(&e))
    })?;
    if claimed.is_empty() {
        return Err(inactive(format!("Approval {} is no longer pending", a.id)));
    }
    finish_settle(d, &a)
}

/// `resolveSettleTarget`: the destination, refusing a recipient who cannot receive unless this settle already posted.
fn resolve_settle_target(d: &Deps<'_>, a: &Approval) -> Result<Space, Refusal> {
    let from = with(d.store, |c| space::get(c, &a.from_space_id))?;
    let key = settle_key(&a.id);
    let already = || -> Result<bool, Refusal> { Ok(tx_by_key(d, &key)?.is_some()) };
    with(d.store, |c| {
        resolve_for_credit(d, c, &a.to_space_id, Some(&from.user_id), Some(&already))
    })
}

fn is_code(r: &Refusal, code: &str) -> bool {
    matches!(r, Refusal::Bank(e) if e.row.code == code)
}

/// `finishSettle`: reconciles the original settle key; an unknown outcome never releases its hold.
fn finish_settle(d: &Deps<'_>, a: &Approval) -> Result<(String, String), Refusal> {
    let from = with(d.store, |c| space::get(c, &a.from_space_id))?;
    let to = match resolve_settle_target(d, a) {
        Ok(to) => to,
        Err(refusal) => {
            // A recipient who became unable to receive after the claim will not clear: close the row and return the hold.
            if !is_code(&refusal, "bank.recipient_cannot_receive") {
                return Err(refusal);
            }
            let closed = with(d.store, |c| {
                c.query(
                    "UPDATE bank.business_approvals \
                        SET status = 'rejected', rejection_code = 'bank.recipient_cannot_receive', decided_at = now() \
                      WHERE id = $1::text::uuid AND status = 'approved' AND ledger_tx_id IS NULL RETURNING id",
                    &[&a.id],
                )
                .map_err(|e| pg(&e))
            })?;
            if !closed.is_empty()
                && let Err(release_error) = release_hold(d, a)
            {
                // A concurrent approve may have posted the settle after our check: the post is the fact.
                let Some(posted) = tx_by_key(d, &settle_key(&a.id))? else {
                    return Err(release_error);
                };
                return record_settled(d, a, &posted.id);
            }
            return Err(refusal);
        }
    };
    let key = settle_key(&a.id);
    let input = Json::obj([
        ("approvalId", Json::str(a.id.clone())),
        ("from", from.ledger_account().json()),
        ("to", to.ledger_account().json()),
        ("amount", Json::str(format_amount(a.amount))),
    ]);
    let settled = match post(d, "businessApprovalSettle", &input, &key) {
        Ok(tx) => tx,
        Err(error) => {
            // A lost acknowledgement is not proof of a missing post.
            if let Some(committed) = tx_by_key(d, &key)? {
                committed
            } else {
                let funds = matches!(&error, PostError::Ledger(f) if f.insufficient());
                if !funds {
                    return Err(error.refusal());
                }
                let rejected = with(d.store, |c| {
                    c.query(
                        "UPDATE bank.business_approvals \
                            SET status = 'rejected', rejection_code = 'bank.business_settle_unposted', decided_at = now() \
                          WHERE id = $1::text::uuid AND status = 'approved' AND ledger_tx_id IS NULL RETURNING id",
                        &[&a.id],
                    )
                    .map_err(|e| pg(&e))
                })?;
                if rejected.is_empty() {
                    let current = approval(d, &a.id)?;
                    if current.status == "approved"
                        && let Some(ledger) = current.ledger_tx_id.clone()
                    {
                        return Ok((current.transfer_id.unwrap_or(current.id), ledger));
                    }
                    return Err(error.refusal());
                }
                release_hold(d, a)?;
                return Err(refuse(
                    "bank.business_rejected",
                    "The settle did not post and the hold was released",
                ));
            }
        }
    };
    record_settled(d, a, &settled.id)
}

/// `recordSettled`: the posted settle is the fact; a row a concurrent approve closed for its recipient is set back.
fn record_settled(
    d: &Deps<'_>,
    a: &Approval,
    ledger_tx_id: &str,
) -> Result<(String, String), Refusal> {
    let recorded = with(d.store, |c| {
        c.query(
            "UPDATE bank.business_approvals SET ledger_tx_id = $2, status = 'approved', rejection_code = NULL \
             WHERE id = $1::text::uuid \
               AND (status = 'approved' OR (status = 'rejected' AND rejection_code = 'bank.recipient_cannot_receive')) \
               AND (ledger_tx_id IS NULL OR ledger_tx_id = $2) RETURNING id",
            &[&a.id, &ledger_tx_id],
        )
        .map_err(|e| pg(&e))
    })?;
    if recorded.is_empty() {
        return Err(conflict("The proposal no longer names this transfer"));
    }
    Ok((a.id.clone(), ledger_tx_id.to_owned()))
}

/// `releaseHold`: the release key is the approval's, so a second call never pays the hold back twice. Nothing to
/// release when no hold posted.
fn release_hold(d: &Deps<'_>, a: &Approval) -> Result<(), Refusal> {
    if a.hold_ledger_tx_id.is_none() && tx_by_key(d, &hold_key(&a.id))?.is_none() {
        return Ok(());
    }
    let from = with(d.store, |c| space::get(c, &a.from_space_id))?;
    post(
        d,
        "businessApprovalRelease",
        &hold_input(&a.id, &from.ledger_account(), a.amount),
        &release_key(&a.id),
    )
    .map_err(|e| e.refusal())?;
    Ok(())
}

/// `claimAndRelease`: claims the pending row, then releases its hold, so approve cannot settle after this won.
fn claim_and_release(
    d: &Deps<'_>,
    a: &Approval,
    actor: &str,
    status: &str,
    rejection_code: &str,
) -> Result<(), Refusal> {
    let claimed = with(d.store, |c| {
        c.query(
            "UPDATE bank.business_approvals \
                SET status = $2::text::bank.business_approval_status, checker_user_id = $3, rejection_code = $4, decided_at = now() \
              WHERE id = $1::text::uuid AND status = 'pending' RETURNING id",
            &[&a.id, &status, &actor, &rejection_code],
        )
        .map_err(|e| pg(&e))
    })?;
    if claimed.is_empty() {
        return Err(inactive(format!("Approval {} is no longer pending", a.id)));
    }
    release_hold(d, a)
}

/// `reject`: a different checker refuses; a repeat on a closed row releases the hold again.
pub fn reject(d: &Deps<'_>, approval_id: &str, checker: &str) -> Result<(), Refusal> {
    let a = approval(d, approval_id)?;
    let own = || {
        if policy::duty_clash(Some(&a.maker_user_id), Some(checker), None).is_some() {
            return Err(self_approve(
                "Maker cannot reject their own transfer as checker",
            ));
        }
        Ok(())
    };
    if a.status == "rejected" || a.status == "cancelled" {
        own()?;
        assert_role(d, &a.account_id, checker, Capability::Approve)?;
        return release_hold(d, &a);
    }
    if a.status != "pending" {
        return Err(inactive(format!("Approval {} is {}", a.id, a.status)));
    }
    own()?;
    assert_role(d, &a.account_id, checker, Capability::Approve)?;
    claim_and_release(d, &a, checker, "rejected", "bank.business_rejected")
}

/// `cancel`: the maker cancels their own proposal without a current membership, so removing them cannot strand the
/// hold; an administrator cancels anyone's. A repeat releases the hold again.
pub fn cancel(d: &Deps<'_>, approval_id: &str, actor: &str) -> Result<(), Refusal> {
    let a = approval(d, approval_id)?;
    let own = a.maker_user_id == actor;
    if a.status == "cancelled" || a.status == "rejected" {
        if !own {
            assert_role(d, &a.account_id, actor, Capability::ManageTeam)?;
        }
        return release_hold(d, &a);
    }
    if a.status != "pending" {
        return Err(inactive(format!("Approval {} is {}", a.id, a.status)));
    }
    if !own {
        assert_role(d, &a.account_id, actor, Capability::ManageTeam)?;
    }
    claim_and_release(d, &a, actor, "cancelled", "bank.business_cancelled")
}

// ---------------------------------------------------------------------------------------------------------------
// Handles

/// `BusinessPartyView`.
struct Party {
    handle: Option<String>,
    name: Option<String>,
}

fn unique_ids(ids: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if !js_trim(id).is_empty() && !out.contains(id) {
            out.push(id.clone());
        }
    }
    out
}

/// `partiesFor`: each person's handle, or none with its reason; a name only where the owner published one.
fn parties_for(d: &Deps<'_>, ids: &[String]) -> Result<BTreeMap<String, Party>, Refusal> {
    let unique = unique_ids(ids);
    let handles = d
        .spaces
        .directory
        .handles_of(&unique)
        .map_err(directory_error)?;
    let names = d
        .spaces
        .directory
        .published_names(&unique)
        .map_err(directory_error)?;
    Ok(unique
        .into_iter()
        .map(|id| {
            let handle = handles.get(&id).cloned();
            let name = handle.as_ref().and(names.get(&id).cloned());
            (id, Party { handle, name })
        })
        .collect())
}

/// `handlesFor`: every id has a public handle, or the page is refused rather than show a raw id.
fn handles_for(d: &Deps<'_>, ids: &[String]) -> Result<BTreeMap<String, String>, Refusal> {
    let unique = unique_ids(ids);
    let found = d
        .spaces
        .directory
        .handles_of(&unique)
        .map_err(directory_error)?;
    for id in &unique {
        if found.get(id).is_none_or(String::is_empty) {
            return Err(refuse(
                "bank.business_directory_incomplete",
                "A person on this account has no public handle in the identity directory, so this list is not shown (bank.business_directory_incomplete)",
            ));
        }
    }
    Ok(found)
}

fn space_owners(d: &Deps<'_>, space_ids: &[String]) -> Result<BTreeMap<String, String>, Refusal> {
    let ids: Vec<String> = space_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    with(d.store, |c| {
        let rows = c
            .query(
                "SELECT id::text, user_id FROM bank.spaces WHERE id = ANY($1::text[]::uuid[])",
                &[&ids],
            )
            .map_err(|e| pg(&e))?;
        rows.iter()
            .map(|r| Ok((get_s(r, 0)?, get_s(r, 1)?)))
            .collect()
    })
}

/// `withParties`: the maker and the receiving space's owner named by handle (`BusinessPendingView`), in the
/// pending page's key order; `checker` adds the history page's two keys.
fn with_parties(
    d: &Deps<'_>,
    rows: &[Approval],
    checkers: Option<&BTreeMap<String, String>>,
) -> Result<Vec<Json>, Refusal> {
    let owners = space_owners(
        d,
        &rows
            .iter()
            .map(|r| r.to_space_id.clone())
            .collect::<Vec<_>>(),
    )?;
    let mut ids: Vec<String> = rows.iter().map(|r| r.maker_user_id.clone()).collect();
    ids.extend(owners.values().cloned());
    let parties = parties_for(d, &ids)?;
    let view = |p: Option<&Party>| -> (Json, Json, Json) {
        match p.and_then(|p| p.handle.as_ref().map(|h| (h, p))) {
            Some((h, p)) => (Json::str(h.clone()), Json::Null, opt(p.name.as_deref())),
            None => (Json::Null, Json::str("handle_unresolved"), Json::Null),
        }
    };
    Ok(rows
        .iter()
        .map(|a| {
            let (maker, maker_reason, _) = view(parties.get(&a.maker_user_id));
            let (receiver, receiver_reason, receiver_name) =
                view(owners.get(&a.to_space_id).and_then(|o| parties.get(o)));
            let mut f: Vec<(String, Json)> = vec![
                ("id".to_owned(), Json::str(a.id.clone())),
                ("accountId".to_owned(), Json::str(a.account_id.clone())),
                ("makerHandle".to_owned(), maker),
                ("makerHandleReason".to_owned(), maker_reason),
            ];
            if let Some(checkers) = checkers {
                f.push((
                    "checkerHandle".to_owned(),
                    a.checker_user_id
                        .as_ref()
                        .filter(|c| !c.is_empty())
                        .and_then(|c| checkers.get(c))
                        .map_or(Json::Null, |h| Json::str(h.clone())),
                ));
            }
            f.extend([
                ("receiverOwnerHandle".to_owned(), receiver),
                ("receiverOwnerHandleReason".to_owned(), receiver_reason),
                ("receiverOwnerName".to_owned(), receiver_name),
                ("fromSpaceId".to_owned(), Json::str(a.from_space_id.clone())),
                ("toSpaceId".to_owned(), Json::str(a.to_space_id.clone())),
                ("assetId".to_owned(), Json::str(a.asset_id.clone())),
                ("amount".to_owned(), Json::str(format_amount(a.amount))),
                ("status".to_owned(), Json::str(a.status.clone())),
                ("transferId".to_owned(), opt(a.transfer_id.as_deref())),
                (
                    "holdLedgerTxId".to_owned(),
                    opt(a.hold_ledger_tx_id.as_deref()),
                ),
                ("ledgerTxId".to_owned(), opt(a.ledger_tx_id.as_deref())),
                ("createdAt".to_owned(), Json::str(a.created_at.iso())),
            ]);
            if checkers.is_some() {
                f.push(("decidedAt".to_owned(), iso(a.decided_at)));
            }
            Json::Object(f)
        })
        .collect())
}

// ---------------------------------------------------------------------------------------------------------------
// The team's reads

/// `listPending`: the waiting queue, oldest first.
pub fn list_pending(
    d: &Deps<'_>,
    account_id: &str,
    actor: &str,
    limit: Option<f64>,
) -> Result<Json, Refusal> {
    assert_member(d, account_id, actor)?;
    let page = owner_list_limit(
        limit,
        "bank.business_pending_list_limit_unset",
        "business.pending",
    )?;
    let rows = with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.business_approvals WHERE account_id = $1::text::uuid AND status = 'pending' \
                     ORDER BY created_at ASC LIMIT $2",
                    approval_cols("")
                ),
                &[&account_id, &page],
            )
            .map_err(|e| pg(&e))?;
        rows.iter()
            .map(Approval::from_row)
            .collect::<Result<Vec<_>, _>>()
    })?;
    Ok(Json::Array(with_parties(d, &rows, None)?))
}

/// `team`: teammates and waiting account controls by handle; a missing handle refuses the page.
pub fn team(d: &Deps<'_>, account_id: &str, actor: &str) -> Result<Json, Refusal> {
    assert_member(d, account_id, actor)?;
    let (members, controls) = with(d.store, |c| {
        let members = c
            .query(
                "SELECT account_id::text, user_id, role::text FROM bank.business_members \
                 WHERE account_id = $1::text::uuid ORDER BY created_at ASC LIMIT 201",
                &[&account_id],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(|r| Ok((get_s(r, 0)?, get_s(r, 1)?, get_s(r, 2)?)))
            .collect::<Result<Vec<_>, Refusal>>()?;
        if members.len() > 200 {
            return Err(refuse(
                "bank.business_directory_incomplete",
                "This team is larger than the published page. It is not truncated (bank.business_directory_incomplete)",
            ));
        }
        let controls = c
            .query(
                &format!(
                    "SELECT id::text, kind, spend_threshold::text, proposed_by, {} FROM bank.business_control_requests \
                     WHERE account_id = $1::text::uuid AND status = 'pending' ORDER BY created_at ASC",
                    ms("created_at")
                ),
                &[&account_id],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(|r| Ok((get_s(r, 0)?, get_s(r, 1)?, get_o(r, 2)?, get_s(r, 3)?, get_t(r, 4)?)))
            .collect::<Result<Vec<_>, Refusal>>()?;
        Ok((members, controls))
    })?;
    let mut ids: Vec<String> = members.iter().map(|m| m.1.clone()).collect();
    ids.extend(controls.iter().map(|c| c.3.clone()));
    let handles = handles_for(d, &ids)?;
    let handle = |id: &str| handles.get(id).map_or(Json::Null, |h| Json::str(h.clone()));
    let members = members
        .iter()
        .map(|(account, user, role)| {
            Json::obj([
                ("accountId", Json::str(account.clone())),
                ("userId", Json::str(user.clone())),
                ("role", Json::str(role.clone())),
                ("handle", handle(user)),
            ])
        })
        .collect();
    let controls = controls
        .iter()
        .map(|(id, kind, threshold, by, created)| {
            let threshold = threshold
                .as_deref()
                .map(amount)
                .transpose()?
                .map_or(Json::Null, |t| Json::str(format_amount(t)));
            Ok(Json::obj([
                ("requestId", Json::str(id.clone())),
                ("kind", Json::str(kind.clone())),
                ("spendThreshold", threshold),
                ("proposedByHandle", handle(by)),
                ("createdAt", iso(*created)),
            ]))
        })
        .collect::<Result<Vec<_>, Refusal>>()?;
    Ok(Json::obj([
        ("members", Json::Array(members)),
        ("pendingControls", Json::Array(controls)),
    ]))
}

/// What a recipient lookup asks for.
pub struct RecipientAsk<'a> {
    pub account_id: &'a str,
    pub actor: &'a str,
    pub asset_id: &'a str,
    pub handle: Option<&'a str>,
    pub email: Option<&'a str>,
}

/// `resolveRecipientSpace`: the main space of an active person, never made here; one miss for unknown, frozen, closed
/// and a badly shaped query.
pub fn resolve_recipient_space(d: &Deps<'_>, ask: &RecipientAsk<'_>) -> Result<Json, Refusal> {
    assert_member(d, ask.account_id, ask.actor)?;
    if !d.spaces.lookups.try_take(ask.actor, d.now.0) {
        return Err(refuse(
            "bank.business_directory_rate_limited",
            "Too many recipient lookups. Try again in a minute (bank.business_directory_rate_limited)",
        ));
    }
    let handle_raw = js_trim(ask.handle.unwrap_or(""));
    let email_raw = js_trim(ask.email.unwrap_or(""));
    if handle_raw.is_empty() == email_raw.is_empty() {
        return Err(refuse(
            "bank.business_recipient_query",
            "Send a handle or an email, not both (bank.business_recipient_query)",
        ));
    }
    let miss = || Json::obj([("found", Json::Bool(false))]);
    let query = if handle_raw.is_empty() {
        email_query(email_raw).map(Lookup::Email)
    } else {
        handle_query(handle_raw).map(Lookup::Handle)
    };
    let Some(query) = query else {
        return Ok(miss());
    };
    let Some((user_id, handle)) = d
        .spaces
        .directory
        .find_active(&query)
        .map_err(directory_error)?
    else {
        return Ok(miss());
    };
    let space = with(d.store, |c| moves::find_primary(c, &user_id, ask.asset_id))?;
    Ok(Json::obj([
        ("found", Json::Bool(true)),
        ("handle", Json::str(handle)),
        ("assetId", Json::str(ask.asset_id)),
        ("spaceId", space.map_or(Json::Null, |s| Json::str(s.id))),
    ]))
}

fn base64url_json(j: &Json) -> String {
    URL_SAFE_NO_PAD.encode(j.compact())
}

/// `Buffer.from(cursor, 'base64url')` read as JSON: either alphabet, padding or not.
fn decode_cursor(cursor: &str) -> Option<Json> {
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &base64::alphabet::URL_SAFE,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    let normal: String = cursor
        .chars()
        .map(|c| match c {
            '+' => '-',
            '/' => '_',
            c => c,
        })
        .collect();
    let bytes = LENIENT.decode(normal.trim_end_matches('=')).ok()?;
    json::parse(&String::from_utf8_lossy(&bytes)).ok()
}

fn is_uuid_text(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// What the history page asks for.
pub struct ApprovalsAsk<'a> {
    pub account_id: &'a str,
    pub actor: &'a str,
    pub status: Option<&'a str>,
    pub limit: Option<f64>,
    pub cursor: Option<&'a str>,
}

/// `listApprovals`: the history, newest first, filtered by status, maker and checker named by handle.
pub fn list_approvals(d: &Deps<'_>, ask: &ApprovalsAsk<'_>) -> Result<Json, Refusal> {
    assert_member(d, ask.account_id, ask.actor)?;
    let page = owner_list_limit(
        ask.limit,
        "bank.business_approvals_list_limit_unset",
        "business.approvals",
    )?;
    let cursor = match ask.cursor.filter(|c| !c.is_empty()) {
        None => None,
        Some(raw) => {
            let j = decode_cursor(raw).ok_or_else(cursor_invalid)?;
            let (Some(Json::String(at_text)), Some(Json::String(id))) = (j.get("at"), j.get("id"))
            else {
                return Err(cursor_invalid());
            };
            let at_ms = js_date(at_text).ok_or_else(cursor_invalid)?;
            if !is_uuid_text(id) {
                return Err(cursor_invalid());
            }
            Some((at_ms.iso(), id.clone()))
        }
    };
    let at_param = cursor.as_ref().map(|c| c.0.clone());
    let id_param = cursor.as_ref().map(|c| c.1.clone());
    let rows = with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.business_approvals \
                     WHERE account_id = $1::text::uuid \
                       AND ($2::text IS NULL OR status::text = $2) \
                       AND ($3::text IS NULL OR created_at < $3::text::timestamptz \
                            OR (created_at = $3::text::timestamptz AND id < $4::text::uuid)) \
                     ORDER BY created_at DESC, id DESC LIMIT $5",
                    approval_cols("")
                ),
                &[&ask.account_id, &ask.status, &at_param, &id_param, &page],
            )
            .map_err(|e| pg(&e))?;
        rows.iter()
            .map(Approval::from_row)
            .collect::<Result<Vec<_>, _>>()
    })?;
    let checker_ids: Vec<String> = rows
        .iter()
        .filter_map(|r| r.checker_user_id.clone().filter(|c| !c.is_empty()))
        .collect();
    let checkers = if checker_ids.is_empty() {
        BTreeMap::new()
    } else {
        handles_for(d, &checker_ids)?
    };
    let items = with_parties(d, &rows, Some(&checkers))?;
    let next = match rows.last() {
        Some(last) if i64::try_from(rows.len()).ok() == Some(page) => {
            Json::str(base64url_json(&Json::obj([
                ("at", Json::str(last.created_at.iso())),
                ("id", Json::str(last.id.clone())),
            ])))
        }
        _ => Json::Null,
    };
    Ok(Json::obj([
        ("items", Json::Array(items)),
        ("nextCursor", next),
    ]))
}

// ---------------------------------------------------------------------------------------------------------------
// Team changes

/// A member command's stored terms.
struct Command {
    account_id: String,
    actor: String,
    target: String,
    action: String,
    role: Option<String>,
}

fn member_command(c: &mut impl GenericClient, id: &str) -> Result<Option<Command>, Refusal> {
    let rows = c
        .query(
            "SELECT account_id::text, actor_user_id, target_user_id, action, role::text \
             FROM bank.business_member_commands WHERE id = $1::text::uuid FOR UPDATE",
            &[&id],
        )
        .map_err(|e| pg(&e))?;
    rows.first()
        .map(|r| {
            Ok(Command {
                account_id: get_s(r, 0)?,
                actor: get_s(r, 1)?,
                target: get_s(r, 2)?,
                action: get_s(r, 3)?,
                role: get_o(r, 4)?,
            })
        })
        .transpose()
}

/// What a team change asks for.
pub struct MemberChange<'a> {
    pub account_id: &'a str,
    pub actor: &'a str,
    pub user_id: &'a str,
    pub request_id: &'a str,
    /// `None` removes; `Some(role)` re-roles.
    pub role: Option<&'a str>,
}

impl MemberChange<'_> {
    fn action(&self) -> &'static str {
        if self.role.is_some() {
            "set_role"
        } else {
            "remove"
        }
    }

    fn assert_terms(&self, existing: &Command) -> Result<(), Refusal> {
        if existing.account_id != self.account_id
            || existing.actor != self.actor
            || existing.target != self.user_id
            || existing.action != self.action()
            || existing.role.as_deref() != self.role
        {
            return Err(conflict(format!(
                "Request {} already exists on different terms — a retry must carry the same instruction",
                self.request_id
            )));
        }
        Ok(())
    }

    /// The router's output for the change.
    pub fn answer(&self) -> Json {
        match self.role {
            None => Json::obj([
                ("accountId", Json::str(self.account_id)),
                ("userId", Json::str(self.user_id)),
                ("removed", Json::Bool(true)),
            ]),
            Some(role) => Json::obj([
                ("accountId", Json::str(self.account_id)),
                ("userId", Json::str(self.user_id)),
                ("role", Json::str(role)),
            ]),
        }
    }
}

/// `removeMember` and `setMemberRole`: applied once with its command row; a retry reads the row and changes nothing.
/// The last administrator stays, and a person with a payment still waiting is not removed.
pub fn change_member(d: &Deps<'_>, ch: &MemberChange<'_>) -> Result<Json, Refusal> {
    require_request_id(ch.request_id)?;
    in_tx(d.store, |tx| {
        if let Some(existing) = member_command(tx, ch.request_id)? {
            ch.assert_terms(&existing)?;
            return Ok(ch.answer());
        }
        let members = lock_members(tx, ch.account_id)?;
        assert_admin_locked(&members, ch.actor)?;
        let Some((_, target_role)) = members.iter().find(|(u, _)| u == ch.user_id) else {
            return Err(not_member());
        };
        let loses_admin = match ch.role {
            None => policy::role_can(target_role, Capability::ManageTeam),
            Some(role) => {
                policy::role_can(target_role, Capability::ManageTeam)
                    && !policy::role_can(role, Capability::ManageTeam)
            }
        };
        if loses_admin && managers(&members) < 2 {
            return Err(last_admin(if ch.role.is_none() {
                "removed"
            } else {
                "demoted"
            }));
        }
        if ch.role.is_none() {
            let waiting = tx
                .query(
                    "SELECT id FROM bank.business_approvals \
                     WHERE account_id = $1::text::uuid AND maker_user_id = $2 AND status = 'pending' LIMIT 1",
                    &[&ch.account_id, &ch.user_id],
                )
                .map_err(|e| pg(&e))?;
            if !waiting.is_empty() {
                return Err(refuse(
                    "bank.business_member_has_pending",
                    "This person still has a payment waiting. Decide or cancel those payments before removing them (bank.business_member_has_pending)",
                ));
            }
        }
        let inserted = tx
            .query(
                "INSERT INTO bank.business_member_commands (id, account_id, actor_user_id, target_user_id, action, role) \
                 VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5, $6::text::bank.business_member_role) \
                 ON CONFLICT (id) DO NOTHING RETURNING id",
                &[&ch.request_id, &ch.account_id, &ch.actor, &ch.user_id, &ch.action(), &ch.role],
            )
            .map_err(|e| pg(&e))?;
        if inserted.is_empty() {
            let Some(raced) = member_command(tx, ch.request_id)? else {
                return Err(conflict("The member change could not be recorded"));
            };
            ch.assert_terms(&raced)?;
            return Ok(ch.answer());
        }
        match ch.role {
            None => tx.execute(
                "DELETE FROM bank.business_members WHERE account_id = $1::text::uuid AND user_id = $2",
                &[&ch.account_id, &ch.user_id],
            ),
            Some(role) => tx.execute(
                "UPDATE bank.business_members SET role = $3::text::bank.business_member_role, custom_role_id = NULL, advisor = false \
                 WHERE account_id = $1::text::uuid AND user_id = $2",
                &[&ch.account_id, &ch.user_id, &role],
            ),
        }
        .map_err(|e| pg(&e))?;
        Ok(ch.answer())
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Account controls

/// One control request's row.
struct ControlRow {
    account_id: String,
    kind: String,
    spend_threshold: Option<Amount>,
    proposed_by: String,
    status: String,
}

fn control_row(c: &mut impl GenericClient, id: &str) -> Result<Option<ControlRow>, Refusal> {
    let rows = c
        .query(
            "SELECT account_id::text, kind, spend_threshold::text, proposed_by, status \
             FROM bank.business_control_requests WHERE id = $1::text::uuid FOR UPDATE",
            &[&id],
        )
        .map_err(|e| pg(&e))?;
    rows.first()
        .map(|r| {
            Ok(ControlRow {
                account_id: get_s(r, 0)?,
                kind: get_s(r, 1)?,
                spend_threshold: get_o(r, 2)?.as_deref().map(amount).transpose()?,
                proposed_by: get_s(r, 3)?,
                status: get_s(r, 4)?,
            })
        })
        .transpose()
}

/// A change to the account a second administrator confirms.
pub struct ControlAsk<'a> {
    pub account_id: &'a str,
    pub actor: &'a str,
    pub request_id: &'a str,
    /// `set_threshold` or `close`.
    pub kind: &'static str,
    pub spend_threshold: Option<Amount>,
}

impl ControlAsk<'_> {
    fn assert_terms(&self, existing: &ControlRow) -> Result<(), Refusal> {
        if existing.account_id != self.account_id
            || existing.kind != self.kind
            || existing.spend_threshold != self.spend_threshold
        {
            return Err(conflict(format!(
                "Request {} already exists on different terms — a retry must carry the same instruction",
                self.request_id
            )));
        }
        Ok(())
    }

    fn withdrawn(&self) -> Refusal {
        inactive(format!(
            "Request {} was withdrawn (bank.business_approval_inactive)",
            self.request_id
        ))
    }
}

fn change_pending() -> Refusal {
    refuse(
        "bank.business_change_pending",
        "A change of this kind is already waiting for a second administrator (bank.business_change_pending)",
    )
}

/// `setThreshold`: one administrator records the new threshold, a different one confirms the same id and amount.
pub fn set_threshold(
    d: &Deps<'_>,
    account_id: &str,
    actor: &str,
    spend_threshold: Amount,
    request_id: &str,
) -> Result<Control, Refusal> {
    require_request_id(request_id)?;
    if spend_threshold <= 0 {
        return Err(refuse(
            "bank.business_invalid_threshold",
            "Business spend threshold must be positive",
        ));
    }
    control(
        d,
        &ControlAsk {
            account_id,
            actor,
            request_id,
            kind: "set_threshold",
            spend_threshold: Some(spend_threshold),
        },
    )
}

/// `closeAccount`: one administrator records the close, a different one confirms it.
pub fn close_account(
    d: &Deps<'_>,
    account_id: &str,
    actor: &str,
    request_id: &str,
) -> Result<Control, Refusal> {
    require_request_id(request_id)?;
    control(
        d,
        &ControlAsk {
            account_id,
            actor,
            request_id,
            kind: "close",
            spend_threshold: None,
        },
    )
}

fn assert_no_pending_payment(
    c: &mut impl GenericClient,
    account_id: &str,
    kind: &str,
) -> Result<(), Refusal> {
    if kind != "close" {
        return Ok(());
    }
    let waiting = c
        .query(
            "SELECT id FROM bank.business_approvals WHERE account_id = $1::text::uuid AND status = 'pending' LIMIT 1",
            &[&account_id],
        )
        .map_err(|e| pg(&e))?;
    if !waiting.is_empty() {
        return Err(refuse(
            "bank.business_close_blocked",
            "Payments are still waiting for a decision. Decide those before closing the account (bank.business_close_blocked)",
        ));
    }
    Ok(())
}

fn apply_control(c: &mut impl GenericClient, ask: &ControlAsk<'_>) -> Result<(), Refusal> {
    let updated = match ask.spend_threshold.filter(|_| ask.kind == "set_threshold") {
        Some(t) => c.query(
            "UPDATE bank.business_accounts SET spend_threshold = $2::text::numeric, updated_at = now() \
             WHERE id = $1::text::uuid AND status = 'active' RETURNING id",
            &[&ask.account_id, &format_amount(t)],
        ),
        None => c.query(
            "UPDATE bank.business_accounts SET status = 'closed', updated_at = now() \
             WHERE id = $1::text::uuid AND status = 'active' RETURNING id",
            &[&ask.account_id],
        ),
    }
    .map_err(|e| pg(&e))?;
    if updated.is_empty() {
        return Err(closed());
    }
    let recorded = c
        .query(
            "UPDATE bank.business_control_requests SET status = 'applied', confirmed_by = $2, decided_at = now() \
             WHERE id = $1::text::uuid AND status = 'pending' RETURNING id",
            &[&ask.request_id, &ask.actor],
        )
        .map_err(|e| pg(&e))?;
    if recorded.is_empty() {
        return Err(inactive("The change is no longer waiting"));
    }
    Ok(())
}

fn control(d: &Deps<'_>, ask: &ControlAsk<'_>) -> Result<Control, Refusal> {
    assert_role(d, ask.account_id, ask.actor, Capability::ManageTeam)?;
    let acct = account(d, ask.account_id)?;
    let answer = |status: &'static str, account: Account| Control {
        status,
        request_id: ask.request_id.to_owned(),
        account,
    };
    in_tx(d.store, |tx| {
        if let Some(existing) = control_row(tx, ask.request_id)? {
            ask.assert_terms(&existing)?;
            if existing.status == "cancelled" {
                return Err(ask.withdrawn());
            }
            if existing.status == "applied" {
                return Ok(answer("applied", account_in(tx, ask.account_id)?));
            }
            if existing.proposed_by == ask.actor {
                return Ok(answer("pending", acct.clone()));
            }
            let members = lock_members(tx, ask.account_id)?;
            assert_admin_locked(&members, ask.actor)?;
            assert_no_pending_payment(tx, ask.account_id, ask.kind)?;
            apply_control(tx, ask)?;
            return Ok(answer("applied", account_in(tx, ask.account_id)?));
        }
        if acct.status != "active" {
            return Err(closed());
        }
        assert_no_pending_payment(tx, ask.account_id, ask.kind)?;
        let pending = tx
            .query(
                "SELECT id FROM bank.business_control_requests \
                 WHERE account_id = $1::text::uuid AND kind = $2 AND status = 'pending' FOR UPDATE",
                &[&ask.account_id, &ask.kind],
            )
            .map_err(|e| pg(&e))?;
        if !pending.is_empty() {
            return Err(change_pending());
        }
        let threshold = ask.spend_threshold.map(format_amount);
        // A savepoint, so a racing insert's unique clash leaves the transaction usable for the read that follows.
        let mut sp = tx.transaction().map_err(|e| pg(&e))?;
        let inserted = sp.execute(
            "INSERT INTO bank.business_control_requests (id, account_id, kind, spend_threshold, proposed_by, status) \
             VALUES ($1::text::uuid, $2::text::uuid, $3, $4::text::numeric, $5, 'pending')",
            &[&ask.request_id, &ask.account_id, &ask.kind, &threshold, &ask.actor],
        );
        match inserted {
            Ok(_) => {
                sp.commit().map_err(|e| pg(&e))?;
                Ok(answer("pending", acct.clone()))
            }
            Err(e) => {
                drop(sp);
                let unique = e
                    .as_db_error()
                    .filter(|db| db.code() == &SqlState::UNIQUE_VIOLATION)
                    .map(|db| db.constraint().unwrap_or("").to_owned());
                match unique.as_deref() {
                    Some("business_control_one_pending") => Err(change_pending()),
                    Some(_) => {
                        let Some(raced) = control_row(tx, ask.request_id)? else {
                            return Err(pg(&e));
                        };
                        ask.assert_terms(&raced)?;
                        if raced.status == "cancelled" {
                            return Err(ask.withdrawn());
                        }
                        let status = if raced.status == "applied" {
                            "applied"
                        } else {
                            "pending"
                        };
                        Ok(answer(status, acct.clone()))
                    }
                    None => Err(pg(&e)),
                }
            }
        }
    })
}

/// `cancelControl`: any administrator, the proposer too, withdraws a pending control; a repeat answers the same.
pub fn cancel_control(
    d: &Deps<'_>,
    account_id: &str,
    actor: &str,
    request_id: &str,
) -> Result<Control, Refusal> {
    require_request_id(request_id)?;
    in_tx(d.store, |tx| {
        let existing = control_row(tx, request_id)?.filter(|r| r.account_id == account_id);
        let Some(existing) = existing else {
            return Err(refuse(
                "bank.business_not_found",
                format!("Business control {request_id} not found"),
            ));
        };
        let members = lock_members(tx, account_id)?;
        assert_admin_locked(&members, actor)?;
        if existing.status == "applied" {
            return Err(inactive(format!("Request {request_id} is already applied")));
        }
        if existing.status == "pending" {
            let updated = tx
                .query(
                    "UPDATE bank.business_control_requests SET status = 'cancelled', confirmed_by = $2, decided_at = now() \
                     WHERE id = $1::text::uuid AND status = 'pending' RETURNING id",
                    &[&request_id, &actor],
                )
                .map_err(|e| pg(&e))?;
            if updated.is_empty() {
                return Err(inactive(format!(
                    "Request {request_id} is no longer waiting"
                )));
            }
        }
        Ok(Control {
            status: "cancelled",
            request_id: request_id.to_owned(),
            account: account_in(tx, account_id)?,
        })
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Payroll

fn payroll_run_in(
    c: &mut impl GenericClient,
    id: &str,
    lock: bool,
) -> Result<Option<PayrollRun>, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT id::text, account_id::text, actor_user_id, from_space_id::text, asset_id, ledger_tx_id, {} \
                 FROM bank.business_payroll_runs WHERE id = $1::text::uuid{}",
                ms("created_at"),
                if lock { " FOR UPDATE" } else { "" }
            ),
            &[&id],
        )
        .map_err(|e| pg(&e))?;
    let Some(r) = rows.first() else {
        return Ok(None);
    };
    let lines = c
        .query(
            "SELECT to_space_id::text, amount::text FROM bank.business_payroll_lines \
             WHERE payroll_id = $1::text::uuid ORDER BY to_space_id ASC",
            &[&id],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(|l| Ok((get_s(l, 0)?, amount(&get_s(l, 1)?)?)))
        .collect::<Result<Vec<_>, Refusal>>()?;
    Ok(Some(PayrollRun {
        payroll_id: get_s(r, 0)?,
        account_id: get_s(r, 1)?,
        actor_user_id: get_s(r, 2)?,
        from_space_id: get_s(r, 3)?,
        asset_id: get_s(r, 4)?,
        ledger_tx_id: get_s(r, 5)?,
        recipients: lines,
        created_at: get_t(r, 6)?.unwrap_or(Instant(0)),
    }))
}

/// `assertPayrollVisibleTerms`: stored lines agree with the request; lines not yet stored are not a difference.
fn assert_visible_terms(existing: &PayrollRun, ask: &Payroll<'_>) -> Result<(), Refusal> {
    if existing.account_id != ask.account_id || existing.from_space_id != ask.from_space_id {
        return Err(payroll_conflict(&existing.payroll_id));
    }
    let requested: BTreeMap<&str, Amount> = ask
        .recipients
        .iter()
        .map(|(s, a)| (s.as_str(), *a))
        .collect();
    for (to, a) in &existing.recipients {
        if requested.get(to.as_str()) != Some(a) {
            return Err(payroll_conflict(&existing.payroll_id));
        }
    }
    Ok(())
}

/// `assertPayrollSameTerms`: the stored run is this request, line for line.
fn assert_same_payroll(existing: &PayrollRun, ask: &Payroll<'_>) -> Result<(), Refusal> {
    if existing.account_id != ask.account_id
        || existing.from_space_id != ask.from_space_id
        || existing.recipients.len() != ask.recipients.len()
    {
        return Err(payroll_conflict(&existing.payroll_id));
    }
    let by_space: BTreeMap<&str, Amount> = existing
        .recipients
        .iter()
        .map(|(s, a)| (s.as_str(), *a))
        .collect();
    for (to, a) in &ask.recipients {
        if by_space.get(to.as_str()) != Some(a) {
            return Err(payroll_conflict(&existing.payroll_id));
        }
    }
    Ok(())
}

/// `runPayroll`: every recipient paid in one post, or none. Same asset only (a mix would invent a rate), and a total
/// at or above the threshold refuses: one administrator or maker is not a different checker.
pub fn run_payroll(d: &Deps<'_>, ask: &Payroll<'_>) -> Result<PayrollRun, Refusal> {
    if ask.recipients.is_empty() {
        return Err(refuse(
            "bank.business_payroll_empty",
            "Payroll needs at least one recipient",
        ));
    }
    let acct = account(d, ask.account_id)?;
    if acct.status != "active" {
        return Err(closed());
    }
    assert_role(d, ask.account_id, ask.actor_user_id, Capability::Propose)?;
    let existing = with(d.store, |c| payroll_run_in(c, ask.payroll_id, false))?;
    if let Some(e) = &existing {
        assert_visible_terms(e, ask)?;
    }
    let from = with(d.store, |c| resolve_for_debit(c, ask.from_space_id, d.now))?;
    if from.user_id != ask.actor_user_id {
        return Err(refuse(
            "bank.not_owner",
            "Payroll debit space must belong to the actor",
        ));
    }
    if from.asset_id != acct.asset_id {
        return Err(refuse(
            "bank.asset_mismatch",
            format!(
                "Business account {} cannot payroll {}",
                acct.asset_id, from.asset_id
            ),
        ));
    }
    let key = payroll_key(ask.payroll_id);
    let mut seen: Vec<&str> = vec![ask.from_space_id];
    let mut resolved: Vec<(Amount, LedgerAccount)> = Vec::new();
    for (to_space, line_amount) in &ask.recipients {
        if *line_amount <= 0 {
            return Err(refuse(
                "bank.below_minimum",
                "Payroll line amount must be positive",
            ));
        }
        if seen.contains(&to_space.as_str()) {
            return Err(refuse(
                "bank.same_space",
                "Payroll cannot pay the same space twice, or pay the source",
            ));
        }
        seen.push(to_space);
        let already =
            || -> Result<bool, Refusal> { Ok(existing.is_some() || tx_by_key(d, &key)?.is_some()) };
        let to = with(d.store, |c| {
            resolve_for_credit(d, c, to_space, Some(&from.user_id), Some(&already))
        })?;
        if to.asset_id != from.asset_id {
            return Err(refuse(
                policy::PAYROLL_RATE_UNSET,
                format!(
                    "Payroll cannot mix {} and {} — rates are not invented here",
                    from.asset_id, to.asset_id
                ),
            ));
        }
        resolved.push((*line_amount, to.ledger_account()));
    }
    let total: Amount = resolved.iter().map(|(a, _)| *a).sum();
    if total >= acct.spend_threshold {
        return Err(self_approve(
            "Dual control is required for a payroll at or above the spend threshold. An admin or maker alone is not a different checker.",
        ));
    }
    let from_acct = from.ledger_account();
    let input = Json::obj([
        ("payrollId", Json::str(ask.payroll_id)),
        ("from", from_acct.json()),
        (
            "recipients",
            Json::Array(
                resolved
                    .iter()
                    .map(|(a, to)| {
                        Json::obj([("to", to.json()), ("amount", Json::str(format_amount(*a)))])
                    })
                    .collect(),
            ),
        ),
    ]);
    let posted = post(d, "businessPayroll", &input, &key).map_err(|e| match &e {
        PostError::Ledger(f) if f.code() == Some("ledger.idempotency_conflict") => {
            payroll_conflict(ask.payroll_id)
        }
        _ => e.refusal(),
    })?;
    // No entries: this client did not show the book, which is not a different instruction.
    if !posted.entries.is_empty() && !posted_matches(d, &posted, &from_acct, &resolved)? {
        return Err(payroll_conflict(ask.payroll_id));
    }
    if let Some(e) = &existing {
        if e.ledger_tx_id != posted.id {
            return Err(payroll_conflict(ask.payroll_id));
        }
        if e.recipients.len() == ask.recipients.len() {
            assert_same_payroll(e, ask)?;
            return Ok(e.clone());
        }
    }
    let could_not = || conflict(format!("Payroll {} could not be recorded", ask.payroll_id));
    in_tx(d.store, |tx| {
        let inserted = tx
            .query(
                "INSERT INTO bank.business_payroll_runs (id, account_id, actor_user_id, from_space_id, asset_id, ledger_tx_id) \
                 VALUES ($1::text::uuid, $2::text::uuid, $3, $4::text::uuid, $5, $6) ON CONFLICT DO NOTHING RETURNING id",
                &[&ask.payroll_id, &ask.account_id, &ask.actor_user_id, &ask.from_space_id, &acct.asset_id, &posted.id],
            )
            .map_err(|e| pg(&e))?;
        if !inserted.is_empty() {
            for (to, a) in &ask.recipients {
                tx.execute(
                    "INSERT INTO bank.business_payroll_lines (payroll_id, to_space_id, amount) \
                     VALUES ($1::text::uuid, $2::text::uuid, $3::text::numeric)",
                    &[&ask.payroll_id, to, &format_amount(*a)],
                )
                .map_err(|e| pg(&e))?;
            }
            let recorded = payroll_run_in(tx, ask.payroll_id, false)?.ok_or_else(could_not)?;
            assert_same_payroll(&recorded, ask)?;
            return Ok(recorded);
        }
        let locked = payroll_run_in(tx, ask.payroll_id, true)?
            .filter(|l| l.ledger_tx_id == posted.id)
            .ok_or_else(could_not)?;
        // `completePayrollLines`.
        assert_visible_terms(&locked, ask)?;
        for (to, a) in &ask.recipients {
            if locked.recipients.iter().any(|(s, _)| s == to) {
                continue;
            }
            tx.execute(
                "INSERT INTO bank.business_payroll_lines (payroll_id, to_space_id, amount) \
                 VALUES ($1::text::uuid, $2::text::uuid, $3::text::numeric) ON CONFLICT (payroll_id, to_space_id) DO NOTHING",
                &[&ask.payroll_id, to, &format_amount(*a)],
            )
            .map_err(|e| pg(&e))?;
        }
        let recorded = payroll_run_in(tx, ask.payroll_id, false)?.ok_or_else(could_not)?;
        assert_same_payroll(&recorded, ask)?;
        Ok(recorded)
    })
}

// ---------------------------------------------------------------------------------------------------------------
// The operator's queue

/// `assertOperatorApprovalLimit`: 1 to 200, else `bank.ops_business_approvals_limit_unset`.
pub fn operator_limit(limit: Option<f64>) -> Result<i64, Refusal> {
    match limit {
        #[allow(
            clippy::cast_possible_truncation,
            reason = "a whole number from 1 to 200"
        )]
        Some(l) if l.fract() == 0.0 && (1.0..=200.0).contains(&l) => Ok(l as i64),
        _ => Err(refuse(
            "bank.ops_business_approvals_limit_unset",
            "The operator approval queue needs a limit from 1 to 200 (bank.ops_business_approvals_limit_unset)",
        )),
    }
}

fn operator_stamp_ok(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 26
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            10 => *c == b' ',
            13 | 16 => *c == b':',
            19 => *c == b'.',
            _ => c.is_ascii_digit(),
        })
}

/// `operatorApprovals`: the queue across businesses, oldest first. Read-only; a missing directory refuses the page,
/// a person with no handle is null with its reason.
pub fn operator_approvals(
    d: &Deps<'_>,
    status: &str,
    limit: i64,
    cursor: Option<&str>,
) -> Result<Json, Refusal> {
    let cursor = match cursor.filter(|c| !c.is_empty()) {
        None => None,
        Some(raw) => {
            let j = decode_cursor(raw).ok_or_else(cursor_invalid)?;
            let (Some(Json::String(at_key)), Some(Json::String(id))) = (j.get("at"), j.get("id"))
            else {
                return Err(cursor_invalid());
            };
            if !operator_stamp_ok(at_key) || !is_uuid_text(id) {
                return Err(cursor_invalid());
            }
            Some((at_key.clone(), id.clone()))
        }
    };
    let stamp = cursor.as_ref().map(|c| c.0.clone());
    let stamp_id = cursor.as_ref().map(|c| c.1.clone());
    let key_expr = "to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')";
    let rows = with(d.store, |c| {
        c.query(
            &format!(
                "SELECT {}, b.spend_threshold::text, {key_expr} \
                 FROM bank.business_approvals a JOIN bank.business_accounts b ON b.id = a.account_id \
                 WHERE a.status::text = $1 \
                   AND ($2::text IS NULL OR {key_expr} > $2 OR ({key_expr} = $2 AND a.id > $3::text::uuid)) \
                 ORDER BY a.created_at ASC, a.id ASC LIMIT $4",
                approval_cols("a.")
            ),
            &[&status, &stamp, &stamp_id, &limit],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(|r| Ok((Approval::from_row(r)?, amount(&get_s(r, 15)?)?, get_s(r, 16)?)))
        .collect::<Result<Vec<_>, Refusal>>()
    })?;
    let parties = parties_for(
        d,
        &rows
            .iter()
            .map(|r| r.0.maker_user_id.clone())
            .collect::<Vec<_>>(),
    )?;
    let approvals = rows
        .iter()
        .map(|(a, rule, _)| {
            let party = parties.get(&a.maker_user_id);
            let handle = party.and_then(|p| p.handle.clone());
            let reason = if handle.is_some() {
                Json::Null
            } else {
                Json::str("handle_unresolved")
            };
            Json::obj([
                ("businessId", Json::str(a.account_id.clone())),
                ("amount", Json::str(format_amount(a.amount))),
                ("assetId", Json::str(a.asset_id.clone())),
                (
                    "ageSeconds",
                    Json::int(((d.now.0 - a.created_at.0) / 1000).max(0)),
                ),
                ("makerHandle", handle.map_or(Json::Null, Json::str)),
                ("makerHandleReason", reason),
                ("rule", Json::str(format_amount(*rule))),
            ])
        })
        .collect();
    let next = match rows.last() {
        Some((a, _, key)) if i64::try_from(rows.len()).ok() == Some(limit) => {
            Json::str(base64url_json(&Json::obj([
                ("at", Json::str(key.clone())),
                ("id", Json::str(a.id.clone())),
            ])))
        }
        _ => Json::Null,
    };
    Ok(Json::obj([
        ("approvals", Json::Array(approvals)),
        ("nextCursor", next),
    ]))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn a_cursor_reads_back_in_either_alphabet_and_with_padding() {
        let j = Json::obj([
            ("at", Json::str("2026-11-01T00:00:00.000Z")),
            ("id", Json::str("x")),
        ]);
        let enc = base64url_json(&j);
        assert_eq!(decode_cursor(&enc), Some(j.clone()));
        assert_eq!(decode_cursor(&format!("{enc}==")), Some(j));
        assert_eq!(decode_cursor("!!!"), None);
    }

    #[test]
    fn the_operator_stamp_is_utc_to_the_microsecond() {
        assert!(operator_stamp_ok("2026-11-01 10:00:00.123456"));
        assert!(!operator_stamp_ok("2026-11-01T10:00:00.123456"));
        assert!(!operator_stamp_ok("2026-11-01 10:00:00.123"));
    }

    #[test]
    fn the_operator_limit_is_a_whole_number_from_1_to_200() {
        assert_eq!(operator_limit(Some(200.0)).unwrap(), 200);
        assert!(operator_limit(Some(0.0)).is_err());
        assert!(operator_limit(Some(201.0)).is_err());
        assert!(operator_limit(Some(1.5)).is_err());
        assert!(operator_limit(None).is_err());
    }

    #[test]
    fn a_hold_is_on_the_debit_pots_own_owner_with_the_approval_as_its_purpose() {
        let from = LedgerAccount::sub_account_available("s1", "USDT");
        let h = hold_account(&from, "a1");
        assert_eq!((h.owner_type, h.kind), ("subaccount", "hold"));
        assert_eq!(h.purpose.as_deref(), Some("business-approval:a1"));
    }
}
