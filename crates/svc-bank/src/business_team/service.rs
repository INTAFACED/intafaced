//! `BusinessTeamService` (`business/business-team.ts`): a business bank team and its approval rules
//! (J-bank-19; BK-biz-01 to BK-biz-04).
//!
//! The business's money is the partner bank's: it sits in the business's own account at the partner,
//! `business:<account id>`, and the partner reports its figure. A payment the team proposes is one instruction to the
//! partner under the business key `bank.business.payment:<payment id>`, stored on the payment's row before it is sent
//! and sent once; an answer that is not definite is read back by that key, never sent again blind. INTAFACED's ledger
//! posts nothing for any of it.
//!
//! - roles: the business names its own roles; nobody grants a permission they do not hold themselves;
//! - advisors: read the business and nothing more, once its owner approved them;
//! - invites: by email or by link, for the owner-set `BANK_BUSINESS_INVITE_MINUTES` (blank refuses every invite);
//!   only a hash of the link's secret is kept;
//! - rules: of every rule a payment matches, the one asking the most approvals applies; with none it is sent at once;
//! - approvals: distinct people holding `approve`, never the maker; the one that completes the count sends;
//! - team spend: by member, the partner's own lines beside the business's own record.

use std::collections::{BTreeMap, BTreeSet};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use postgres::error::SqlState;
use postgres::{GenericClient, Row};
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, js_trim, parse_amount};
use service_kit::time::Instant;
use sha2::{Digest, Sha256};

use crate::business::policy::{self, Capability};
use crate::errors::Refusal;
use crate::partner::custody::{Held, assert_posting_enabled};
use crate::partner::{AccountRef, MoveRequest, MovesQuery, payouts_account, refuse};
use crate::spaces::ports::{DirError, Lookup};
use crate::spaces::shared::{email_query, handle_query};
use crate::spaces::space::{at, in_tx, pg, with};
use crate::transfers::Deps;

/// `BUSINESS_PERMISSIONS`, in the table's order.
pub const PERMISSIONS: [&str; 6] = [
    "view",
    "export",
    "propose",
    "approve",
    "manage_team",
    "team_spend",
];

/// `BUSINESS_PAYMENT_TYPES`.
pub const PAYMENT_TYPES: [&str; 3] = ["domestic", "international", "payroll"];

/// `MAX_RULE_APPROVALS`: the most approvals a rule may ask for.
pub const MAX_RULE_APPROVALS: i64 = 5;

/// Partner refusals that say nothing moved: the payment is closed as refused and never sent again.
const DEFINITE_REFUSALS: [&str; 5] = [
    "bank.partner_insufficient_funds",
    "bank.partner_move_conflict",
    "bank.partner_amount_invalid",
    "bank.asset_mismatch",
    "bank.account_restricted",
];

/// `businessPaymentKey`: the business key of a payment's one partner instruction.
pub fn payment_key(payment_id: &str) -> String {
    format!("bank.business.payment:{payment_id}")
}

/// `businessPartnerAccount`: the business's own account at the partner bank.
pub fn partner_account(account_id: &str, asset_id: &str) -> AccountRef {
    AccountRef::main(&format!("business:{account_id}"), asset_id)
}

fn capability_name(c: Capability) -> &'static str {
    match c {
        Capability::View => "view",
        Capability::Propose => "propose",
        Capability::Approve => "approve",
        Capability::Sign => "sign",
        Capability::ManageTeam => "manage_team",
    }
}

/// `builtInPermissions`: administrators hold every team permission; everyone else what their role says.
pub fn built_in_permissions(role: &str) -> Vec<&'static str> {
    let caps = policy::capabilities(role);
    if caps.contains(&Capability::ManageTeam) {
        return PERMISSIONS.to_vec();
    }
    PERMISSIONS
        .iter()
        .filter(|p| caps.iter().any(|c| capability_name(*c) == **p))
        .copied()
        .collect()
}

/// `fittedRole`: the widest built-in role whose every capability the named role grants (ties go to the first in
/// the table). `sign` is never in a named role, so a named role never fits `admin`.
pub fn fitted_role<S: AsRef<str>>(permissions: &[S]) -> &'static str {
    let mut best = "viewer";
    for role in policy::ROLES {
        let caps = policy::capabilities(role);
        if !caps.iter().all(|c| {
            permissions
                .iter()
                .any(|p| p.as_ref() == capability_name(*c))
        }) {
            continue;
        }
        if caps.len() > policy::capabilities(best).len() {
            best = role;
        }
    }
    best
}

/// `parseInviteMinutes`: a whole number of minutes from 1 to 43200 (30 days), or none while the owner has not set it.
pub fn parse_invite_minutes(raw: Option<&str>) -> Option<i64> {
    let t = js_trim(raw.unwrap_or(""));
    let b = t.as_bytes();
    if b.is_empty() || b.len() > 5 || b.first() == Some(&b'0') || !b.iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    t.parse::<i64>().ok().filter(|m| *m <= 43_200)
}

/// `hashToken`: the sha256 of the link's secret, as hex.
pub fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `randomBytes(24).toString('base64url')`.
fn new_token() -> Result<String, Refusal> {
    let mut b = [0u8; 24];
    getrandom::fill(&mut b).map_err(|e| Refusal::Other(e.to_string()))?;
    Ok(URL_SAFE_NO_PAD.encode(b))
}

/// A string's length as JavaScript counts it.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn ms(col: &str) -> String {
    format!("floor(extract(epoch from {col}) * 1000)::int8")
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

fn opt(s: Option<&str>) -> Json {
    s.map_or(Json::Null, Json::str)
}

fn iso(t: Option<Instant>) -> Json {
    t.map_or(Json::Null, |t| Json::str(t.iso()))
}

fn strings(v: &[&str]) -> Json {
    Json::Array(v.iter().map(|s| Json::str(*s)).collect())
}

fn unique_violation(e: &postgres::Error) -> bool {
    e.code() == Some(&SqlState::UNIQUE_VIOLATION)
}

// ---------------------------------------------------------------------------------------------------------------
// Refusals

fn forbidden(permission: &str) -> Refusal {
    refuse(
        "bank.business_role_forbidden",
        format!(
            "Your role on this business does not include {}, so this was refused. Nothing changed.",
            permission.replacen('_', " ", 1)
        ),
    )
}

fn not_member() -> Refusal {
    refuse(
        "bank.business_not_member",
        "You are not a member of this business account.",
    )
}

fn conflict(what: &str) -> Refusal {
    refuse(
        "bank.business_request_conflict",
        format!("This {what} id is already used on different terms."),
    )
}

fn invite_not_found() -> Refusal {
    refuse(
        "bank.business_invite_not_found",
        "This invite link is not known.",
    )
}

fn no_partner() -> Refusal {
    refuse(
        "bank.no_partner_bank",
        "This business\u{2019}s money is not held at a partner bank, so no payment can be made from it.",
    )
}

/// `directoryRefusal`: unset says the directory's own sentence; anything else is unavailable.
fn directory_refusal(e: DirError) -> Refusal {
    if e.unset() {
        refuse("bank.business_directory_unset", e.sentence())
    } else {
        refuse(
            "bank.business_directory_unavailable",
            "svc-identity did not answer the business directory.",
        )
    }
}

fn lifetime_unset() -> Refusal {
    refuse(
        "bank.business_invite_lifetime_unset",
        "How long a team invite lasts is not set, so no invite can be sent yet. Nothing was sent.",
    )
}

// ---------------------------------------------------------------------------------------------------------------
// Rows

struct AccountRow {
    id: String,
    name: String,
    asset_id: String,
    status: String,
    owner_user_id: Option<String>,
}

impl AccountRow {
    fn json(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("name", Json::str(self.name.clone())),
            ("assetId", Json::str(self.asset_id.clone())),
            ("status", Json::str(self.status.clone())),
        ])
    }
}

#[derive(Clone)]
struct MemberRow {
    user_id: String,
    role: String,
    custom_role_id: Option<String>,
    department_id: Option<String>,
    advisor: bool,
    permissions: Option<Vec<String>>,
    role_name: Option<String>,
}

const MEMBER_COLS: &str = "m.user_id, m.role::text, m.custom_role_id::text, m.department_id::text, m.advisor, \
     r.permissions, r.name FROM bank.business_members m \
     LEFT JOIN bank.business_custom_roles r ON r.id = m.custom_role_id";

impl MemberRow {
    fn from_row(r: &Row) -> Result<MemberRow, Refusal> {
        Ok(MemberRow {
            user_id: get_s(r, 0)?,
            role: get_s(r, 1)?,
            custom_role_id: get_o(r, 2)?,
            department_id: get_o(r, 3)?,
            advisor: r.try_get::<_, bool>(4).map_err(|e| pg(&e))?,
            permissions: r.try_get::<_, Option<Vec<String>>>(5).map_err(|e| pg(&e))?,
            role_name: get_o(r, 6)?,
        })
    }

    /// `permissionsOf`: their named role's permissions, or their built-in role's. An advisor only reads.
    fn permissions(&self) -> Vec<&'static str> {
        if self.advisor {
            return vec!["view"];
        }
        match &self.permissions {
            Some(held) => PERMISSIONS
                .iter()
                .filter(|p| held.iter().any(|h| h == *p))
                .copied()
                .collect(),
            None => built_in_permissions(&self.role),
        }
    }

    fn holds(&self, permission: &str) -> bool {
        self.permissions().contains(&permission)
    }

    /// `need`.
    fn need(&self, permission: &'static str) -> Result<(), Refusal> {
        if self.holds(permission) {
            Ok(())
        } else {
            Err(forbidden(permission))
        }
    }

    /// `toMember`.
    fn json(&self, handles: &BTreeMap<String, String>) -> Json {
        Json::obj([
            ("userId", Json::str(self.user_id.clone())),
            (
                "handle",
                Json::str(handles.get(&self.user_id).cloned().unwrap_or_default()),
            ),
            ("role", Json::str(self.role.clone())),
            (
                "customRole",
                custom_role(self.custom_role_id.as_deref(), self.role_name.as_deref()),
            ),
            ("advisor", Json::Bool(self.advisor)),
            ("departmentId", opt(self.department_id.as_deref())),
            ("permissions", strings(&self.permissions())),
        ])
    }
}

fn custom_role(id: Option<&str>, name: Option<&str>) -> Json {
    id.map_or(Json::Null, |id| {
        Json::obj([
            ("id", Json::str(id)),
            ("name", Json::str(name.unwrap_or(""))),
        ])
    })
}

#[derive(Clone)]
struct RuleRow {
    id: String,
    over_amount: Amount,
    payee: Option<String>,
    payment_type: Option<String>,
    approvals: i64,
    created_at: Instant,
}

fn rule_cols() -> String {
    format!(
        "id::text, over_amount::text, payee, payment_type, approvals, {}, account_id::text",
        ms("created_at")
    )
}

impl RuleRow {
    fn from_row(r: &Row) -> Result<RuleRow, Refusal> {
        Ok(RuleRow {
            id: get_s(r, 0)?,
            over_amount: amount(&get_s(r, 1)?)?,
            payee: get_o(r, 2)?,
            payment_type: get_o(r, 3)?,
            approvals: i64::from(r.try_get::<_, i32>(4).map_err(|e| pg(&e))?),
            created_at: get_t(r, 5)?.unwrap_or(Instant(0)),
        })
    }

    /// `toRule`'s view.
    fn json(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("overAmount", Json::str(format_amount(self.over_amount))),
            ("payee", opt(self.payee.as_deref())),
            ("paymentType", opt(self.payment_type.as_deref())),
            ("approvals", Json::int(self.approvals)),
            ("createdAt", Json::str(self.created_at.iso())),
        ])
    }
}

/// One rule as `pickRule` reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub over_amount: Amount,
    pub payee: Option<String>,
    pub payment_type: Option<String>,
    pub approvals: i64,
}

/// `pickRule`: of every rule the payment matches, the one asking the most approvals; then the highest amount; then
/// the oldest. Its index in `rules`.
pub fn pick_rule(rules: &[Rule], amount: Amount, payee: &str, payment_type: &str) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (i, rule) in rules.iter().enumerate() {
        if amount <= rule.over_amount {
            continue;
        }
        if rule
            .payee
            .as_ref()
            .is_some_and(|p| p.to_lowercase() != payee.to_lowercase())
        {
            continue;
        }
        if rule
            .payment_type
            .as_ref()
            .is_some_and(|t| t != payment_type)
        {
            continue;
        }
        let better = match best.and_then(|b| rules.get(b)) {
            None => true,
            Some(b) => {
                rule.approvals > b.approvals
                    || (rule.approvals == b.approvals && rule.over_amount > b.over_amount)
            }
        };
        if better {
            best = Some(i);
        }
    }
    best
}

// ---------------------------------------------------------------------------------------------------------------
// What the other business slices ask of the team (`BusinessTeamService.seat`, `approverPool`, `ruleList`)

/// `seat`: the business account and what the caller may do on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Seat {
    pub account_id: String,
    pub name: String,
    pub asset_id: String,
    /// `active` or `closed`.
    pub status: String,
    /// Who opened the business: whose money the partner holds for it (`partnerFor`).
    pub owner_user_id: Option<String>,
    pub permissions: Vec<&'static str>,
}

impl Seat {
    pub fn holds(&self, permission: &str) -> bool {
        self.permissions.contains(&permission)
    }
}

/// `seat`: the business first (`bank.business_not_found`), then the caller's membership (`bank.business_not_member`).
pub fn seat<C: GenericClient>(c: &mut C, account_id: &str, user_id: &str) -> Result<Seat, Refusal> {
    let a = account(c, account_id)?;
    let m = member_or_none(c, account_id, user_id)?.ok_or_else(not_member)?;
    Ok(Seat {
        account_id: a.id,
        name: a.name,
        asset_id: a.asset_id,
        status: a.status,
        owner_user_id: a.owner_user_id,
        permissions: m.permissions(),
    })
}

/// `approverPool`: the members other than `exclude` who hold `approve`, in the order they joined.
pub fn approver_pool<C: GenericClient>(
    c: &mut C,
    account_id: &str,
    exclude: &str,
) -> Result<Vec<String>, Refusal> {
    Ok(member_rows(c, account_id)?
        .into_iter()
        .filter(|m| m.user_id != exclude && m.holds("approve"))
        .map(|m| m.user_id)
        .collect())
}

/// One approval rule (`TeamRule`), as `ruleList` hands it out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamRule {
    pub id: String,
    pub rule: Rule,
    pub created_at: Instant,
}

impl TeamRule {
    /// `toRule`'s view: `overAmount` a decimal string, `createdAt` ISO.
    pub fn json(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            (
                "overAmount",
                Json::str(format_amount(self.rule.over_amount)),
            ),
            ("payee", opt(self.rule.payee.as_deref())),
            ("paymentType", opt(self.rule.payment_type.as_deref())),
            ("approvals", Json::int(self.rule.approvals)),
            ("createdAt", Json::str(self.created_at.iso())),
        ])
    }
}

/// `ruleList`: the business's approval rules, oldest first, as `pickRule` reads them.
pub fn rule_list<C: GenericClient>(c: &mut C, account_id: &str) -> Result<Vec<TeamRule>, Refusal> {
    Ok(rule_rows(c, account_id)?
        .into_iter()
        .map(|r| TeamRule {
            id: r.id,
            rule: Rule {
                over_amount: r.over_amount,
                payee: r.payee,
                payment_type: r.payment_type,
                approvals: r.approvals,
            },
            created_at: r.created_at,
        })
        .collect())
}

/// `partnerFor` on a seat: the guarded partner holding the business owner's money, none when no partner holds it.
pub fn partner_of<'a>(d: &Deps<'a>, seat: &Seat) -> Option<Held<'a>> {
    seat.owner_user_id
        .as_deref()
        .and_then(|owner| d.custody.bank_for(owner))
}

#[derive(Clone)]
struct PaymentRow {
    id: String,
    account_id: String,
    maker_user_id: String,
    payee: String,
    payment_type: String,
    asset_id: String,
    amount: Amount,
    rule_id: Option<String>,
    approvals_needed: i64,
    status: String,
    partner_key: String,
    partner_move_id: Option<String>,
    refusal_code: Option<String>,
    created_at: Instant,
    sent_at: Option<Instant>,
}

fn payment_cols() -> String {
    format!(
        "id::text, account_id::text, maker_user_id, payee, payment_type, asset_id, amount::text, rule_id::text, \
         approvals_needed, status, partner_key, partner_move_id, refusal_code, {}, {}",
        ms("created_at"),
        ms("sent_at")
    )
}

impl PaymentRow {
    fn from_row(r: &Row) -> Result<PaymentRow, Refusal> {
        Ok(PaymentRow {
            id: get_s(r, 0)?,
            account_id: get_s(r, 1)?,
            maker_user_id: get_s(r, 2)?,
            payee: get_s(r, 3)?,
            payment_type: get_s(r, 4)?,
            asset_id: get_s(r, 5)?,
            amount: amount(&get_s(r, 6)?)?,
            rule_id: get_o(r, 7)?,
            approvals_needed: i64::from(r.try_get::<_, i32>(8).map_err(|e| pg(&e))?),
            status: get_s(r, 9)?,
            partner_key: get_s(r, 10)?,
            partner_move_id: get_o(r, 11)?,
            refusal_code: get_o(r, 12)?,
            created_at: get_t(r, 13)?.unwrap_or(Instant(0)),
            sent_at: get_t(r, 14)?,
        })
    }
}

struct InviteRow {
    id: String,
    account_id: String,
    kind: String,
    email: Option<String>,
    role: Option<String>,
    custom_role_id: Option<String>,
    invited_by: String,
    status: String,
    accepted_by: Option<String>,
    replaced_by: Option<String>,
    expired: bool,
}

fn invite_cols(p: &str) -> String {
    format!(
        "{p}id::text, {p}account_id::text, {p}kind, {p}email, {p}role::text, {p}custom_role_id::text, {p}invited_by, \
         {p}status, {p}accepted_by, {p}replaced_by::text, ({p}expires_at <= now()), {}, {}",
        ms(&format!("{p}expires_at")),
        ms(&format!("{p}created_at"))
    )
}

impl InviteRow {
    fn from_row(r: &Row) -> Result<InviteRow, Refusal> {
        Ok(InviteRow {
            id: get_s(r, 0)?,
            account_id: get_s(r, 1)?,
            kind: get_s(r, 2)?,
            email: get_o(r, 3)?,
            role: get_o(r, 4)?,
            custom_role_id: get_o(r, 5)?,
            invited_by: get_s(r, 6)?,
            status: get_s(r, 7)?,
            accepted_by: get_o(r, 8)?,
            replaced_by: get_o(r, 9)?,
            expired: r.try_get::<_, bool>(10).map_err(|e| pg(&e))?,
        })
    }
}

/// An invite's view (`TeamInvite`) from `invite_cols("i.")` and the role's name.
fn invite_json(r: &Row) -> Result<Json, Refusal> {
    let row = InviteRow::from_row(r)?;
    let status = if row.status == "open" && row.expired {
        "expired".to_owned()
    } else {
        row.status.clone()
    };
    Ok(Json::obj([
        ("id", Json::str(row.id.clone())),
        ("kind", Json::str(row.kind.clone())),
        ("email", opt(row.email.as_deref())),
        ("role", opt(row.role.as_deref())),
        (
            "customRole",
            custom_role(row.custom_role_id.as_deref(), get_o(r, 13)?.as_deref()),
        ),
        ("status", Json::str(status)),
        ("expiresAt", iso(get_t(r, 11)?)),
        ("createdAt", iso(get_t(r, 12)?)),
    ]))
}

// ---------------------------------------------------------------------------------------------------------------
// Reads shared by every call

fn account<C: GenericClient>(c: &mut C, account_id: &str) -> Result<AccountRow, Refusal> {
    let rows = c
        .query(
            "SELECT id::text, name, asset_id, status::text, owner_user_id FROM bank.business_accounts \
             WHERE id = $1::text::uuid",
            &[&account_id],
        )
        .map_err(|e| pg(&e))?;
    let Some(r) = rows.first() else {
        return Err(refuse(
            "bank.business_not_found",
            "No business account has this id.",
        ));
    };
    Ok(AccountRow {
        id: get_s(r, 0)?,
        name: get_s(r, 1)?,
        asset_id: get_s(r, 2)?,
        status: get_s(r, 3)?,
        owner_user_id: get_o(r, 4)?,
    })
}

fn active_account<C: GenericClient>(c: &mut C, account_id: &str) -> Result<AccountRow, Refusal> {
    let a = account(c, account_id)?;
    if a.status != "active" {
        return Err(refuse(
            "bank.business_closed",
            "This business account is closed.",
        ));
    }
    Ok(a)
}

fn member_rows<C: GenericClient>(c: &mut C, account_id: &str) -> Result<Vec<MemberRow>, Refusal> {
    c.query(
        &format!(
            "SELECT {MEMBER_COLS} WHERE m.account_id = $1::text::uuid ORDER BY m.created_at ASC, m.user_id ASC"
        ),
        &[&account_id],
    )
    .map_err(|e| pg(&e))?
    .iter()
    .map(MemberRow::from_row)
    .collect()
}

fn member_or_none<C: GenericClient>(
    c: &mut C,
    account_id: &str,
    user_id: &str,
) -> Result<Option<MemberRow>, Refusal> {
    c.query(
        &format!("SELECT {MEMBER_COLS} WHERE m.account_id = $1::text::uuid AND m.user_id = $2"),
        &[&account_id, &user_id],
    )
    .map_err(|e| pg(&e))?
    .first()
    .map(MemberRow::from_row)
    .transpose()
}

/// `member`: the business first (`bank.business_not_found`), then the caller's seat on it.
fn member<C: GenericClient>(
    c: &mut C,
    account_id: &str,
    user_id: &str,
) -> Result<MemberRow, Refusal> {
    account(c, account_id)?;
    member_or_none(c, account_id, user_id)?.ok_or_else(not_member)
}

/// `roleIn`: a role of this business, its name and permissions.
fn role_in<C: GenericClient>(
    c: &mut C,
    account_id: &str,
    role_id: &str,
) -> Result<(String, Vec<String>), Refusal> {
    let rows = c
        .query(
            "SELECT name, permissions FROM bank.business_custom_roles \
             WHERE id = $1::text::uuid AND account_id = $2::text::uuid",
            &[&role_id, &account_id],
        )
        .map_err(|e| pg(&e))?;
    let Some(r) = rows.first() else {
        return Err(refuse(
            "bank.business_role_not_found",
            "This business has no such role.",
        ));
    };
    Ok((
        get_s(r, 0)?,
        r.try_get::<_, Vec<String>>(1).map_err(|e| pg(&e))?,
    ))
}

fn rule_rows<C: GenericClient>(c: &mut C, account_id: &str) -> Result<Vec<RuleRow>, Refusal> {
    c.query(
        &format!(
            "SELECT {} FROM bank.business_payment_rules WHERE account_id = $1::text::uuid \
             ORDER BY created_at ASC, id ASC",
            rule_cols()
        ),
        &[&account_id],
    )
    .map_err(|e| pg(&e))?
    .iter()
    .map(RuleRow::from_row)
    .collect()
}

fn payment_row_or_none<C: GenericClient>(
    c: &mut C,
    payment_id: &str,
    lock: bool,
) -> Result<Option<PaymentRow>, Refusal> {
    c.query(
        &format!(
            "SELECT {} FROM bank.business_payments WHERE id = $1::text::uuid{}",
            payment_cols(),
            if lock { " FOR UPDATE" } else { "" }
        ),
        &[&payment_id],
    )
    .map_err(|e| pg(&e))?
    .first()
    .map(PaymentRow::from_row)
    .transpose()
}

fn payment_row<C: GenericClient>(
    c: &mut C,
    payment_id: &str,
    lock: bool,
) -> Result<PaymentRow, Refusal> {
    payment_row_or_none(c, payment_id, lock)?.ok_or_else(|| {
        refuse(
            "bank.business_approval_not_found",
            "No payment of this business has that id.",
        )
    })
}

fn invite_row<C: GenericClient>(
    c: &mut C,
    invite_id: &str,
    lock: bool,
) -> Result<Option<InviteRow>, Refusal> {
    c.query(
        &format!(
            "SELECT {} FROM bank.business_invites WHERE id = $1::text::uuid{}",
            invite_cols(""),
            if lock { " FOR UPDATE" } else { "" }
        ),
        &[&invite_id],
    )
    .map_err(|e| pg(&e))?
    .first()
    .map(InviteRow::from_row)
    .transpose()
}

fn invite_view<C: GenericClient>(c: &mut C, invite_id: &str) -> Result<Json, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {}, r.name FROM bank.business_invites i \
                 LEFT JOIN bank.business_custom_roles r ON r.id = i.custom_role_id WHERE i.id = $1::text::uuid",
                invite_cols("i.")
            ),
            &[&invite_id],
        )
        .map_err(|e| pg(&e))?;
    let r = rows
        .first()
        .ok_or_else(|| Refusal::Other(format!("invite {invite_id} vanished")))?;
    invite_json(r)
}

/// `handles`: public handles from svc-identity. A person with none is refused by name, never shown as someone else.
fn handles(d: &Deps<'_>, ids: &[String]) -> Result<BTreeMap<String, String>, Refusal> {
    let mut unique: Vec<String> = Vec::new();
    for id in ids {
        if !unique.contains(id) {
            unique.push(id.clone());
        }
    }
    if unique.is_empty() {
        return Ok(BTreeMap::new());
    }
    let found = d
        .spaces
        .directory
        .handles_of(&unique)
        .map_err(directory_refusal)?;
    for id in &unique {
        if found.get(id).is_none_or(String::is_empty) {
            return Err(refuse(
                "bank.business_directory_incomplete",
                "A person on this business has no public handle in the identity directory, so this is not shown.",
            ));
        }
    }
    Ok(found)
}

/// `partnerFor`: the partner bank that holds the business owner's money, or none.
fn partner_for<'a>(d: &Deps<'a>, a: &AccountRow) -> Option<Held<'a>> {
    a.owner_user_id
        .as_deref()
        .and_then(|o| d.custody.bank_for(o))
}

/// `moneyMayMove`: refuses `bank.posting_frozen` while posting is frozen, or while the freeze cannot be read.
fn money_may_move(d: &Deps<'_>) -> Result<(), Refusal> {
    assert_posting_enabled(d.partner.freeze.as_ref(), d.store, "bank_move", true)
}

/// `inviteMinutes`: the owner's lifetime, or the refusal that no invite can be sent.
fn invite_minutes(raw: Option<&str>) -> Result<i64, Refusal> {
    parse_invite_minutes(raw).ok_or_else(lifetime_unset)
}

/// `assertMayGrantBuiltIn`: a built-in role may be granted only by someone who holds all of it, `sign` included.
fn assert_may_grant_built_in(me: &MemberRow, role: &str) -> Result<(), Refusal> {
    let mine = me.permissions();
    let mut beyond: Vec<&str> = built_in_permissions(role)
        .into_iter()
        .filter(|p| !mine.contains(p))
        .collect();
    for c in policy::capabilities(role) {
        let name = capability_name(*c);
        if !policy::role_can(&me.role, *c) && !PERMISSIONS.contains(&name) {
            beyond.push(name);
        }
    }
    let mut seen = Vec::new();
    for b in beyond {
        if !seen.contains(&b) {
            seen.push(b);
        }
    }
    if seen.is_empty() {
        return Ok(());
    }
    Err(refuse(
        "bank.business_role_grant_exceeds",
        format!(
            "You cannot invite someone to a role that grants {}, which you do not hold.",
            seen.join(", ")
        ),
    ))
}

/// The permissions of a named role the actor does not hold, in the role's order.
fn beyond_of(me: &MemberRow, granted: &[String]) -> Vec<String> {
    let mine = me.permissions();
    granted
        .iter()
        .filter(|p| !mine.contains(&p.as_str()))
        .cloned()
        .collect()
}

fn seat_advisor<C: GenericClient>(
    c: &mut C,
    account_id: &str,
    user_id: &str,
) -> Result<(), Refusal> {
    c.execute(
        "INSERT INTO bank.business_members (account_id, user_id, role, advisor) \
         VALUES ($1::text::uuid, $2, 'viewer', true) ON CONFLICT (account_id, user_id) DO NOTHING",
        &[&account_id, &user_id],
    )
    .map_err(|e| pg(&e))?;
    Ok(())
}

fn assert_invite_open(row: &InviteRow) -> Result<(), Refusal> {
    match row.status.as_str() {
        "revoked" => Err(refuse(
            "bank.business_invite_revoked",
            "This invite was revoked. Ask the business for a new one.",
        )),
        "replaced" => Err(refuse(
            "bank.business_invite_replaced",
            "This invite was sent again, so this link no longer works. Use the newest one.",
        )),
        "accepted" => Err(refuse(
            "bank.business_invite_used",
            "This invite has already been used.",
        )),
        _ if row.expired => Err(refuse(
            "bank.business_invite_expired",
            "This invite has expired. Ask the business to send it again.",
        )),
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// What the business-spend slice asks of the team besides its seat

/// `handlesOf`: public handles from svc-identity; a person with none is refused by name.
pub fn handles_of(d: &Deps<'_>, user_ids: &[String]) -> Result<BTreeMap<String, String>, Refusal> {
    handles(d, user_ids)
}

// ---------------------------------------------------------------------------------------------------------------
// Reads

/// `overview`.
pub fn overview(
    d: &Deps<'_>,
    account_id: &str,
    user_id: &str,
    minutes: Option<&str>,
) -> Result<Json, Refusal> {
    let (a, me) = with(d.store, |c| {
        Ok((account(c, account_id)?, member(c, account_id, user_id)?))
    })?;
    let names = handles(d, &[user_id.to_owned()])?;
    let partner = partner_for(d, &a).map(|p| {
        let b = p.balance(&partner_account(&a.id, &a.asset_id), d.now);
        Json::obj([
            ("label", Json::str(b.label)),
            (
                "amount",
                b.amount.map_or(Json::Null, |x| Json::str(format_amount(x))),
            ),
            ("asOf", iso(b.as_of)),
        ])
    });
    Ok(Json::obj([
        ("account", a.json()),
        (
            "owner",
            Json::Bool(a.owner_user_id.as_deref() == Some(user_id)),
        ),
        ("me", me.json(&names)),
        (
            "inviteMinutes",
            parse_invite_minutes(minutes).map_or(Json::Null, Json::int),
        ),
        ("partner", partner.unwrap_or(Json::Null)),
    ]))
}

/// `members`.
pub fn members(d: &Deps<'_>, account_id: &str, user_id: &str) -> Result<Json, Refusal> {
    let rows = with(d.store, |c| {
        member(c, account_id, user_id)?;
        member_rows(c, account_id)
    })?;
    let ids: Vec<String> = rows.iter().map(|r| r.user_id.clone()).collect();
    let names = handles(d, &ids)?;
    Ok(Json::Array(rows.iter().map(|r| r.json(&names)).collect()))
}

/// `roles`.
pub fn roles(d: &Deps<'_>, account_id: &str, user_id: &str) -> Result<Json, Refusal> {
    with(d.store, |c| {
        member(c, account_id, user_id)?;
        let rows = c
            .query(
                &format!(
                    "SELECT id::text, name, permissions, {} FROM bank.business_custom_roles \
                     WHERE account_id = $1::text::uuid ORDER BY created_at ASC, id ASC",
                    ms("created_at")
                ),
                &[&account_id],
            )
            .map_err(|e| pg(&e))?;
        let out = rows
            .iter()
            .map(|r| {
                let perms = r.try_get::<_, Vec<String>>(2).map_err(|e| pg(&e))?;
                Ok(role_json(
                    &get_s(r, 0)?,
                    &get_s(r, 1)?,
                    &perms,
                    get_t(r, 3)?,
                ))
            })
            .collect::<Result<Vec<_>, Refusal>>()?;
        Ok(Json::Array(out))
    })
}

fn role_json(id: &str, name: &str, permissions: &[String], created_at: Option<Instant>) -> Json {
    Json::obj([
        ("id", Json::str(id)),
        ("name", Json::str(name)),
        (
            "permissions",
            Json::Array(permissions.iter().map(|p| Json::str(p.clone())).collect()),
        ),
        ("createdAt", iso(created_at)),
    ])
}

fn advisor_json(
    user_id: &str,
    handle: &str,
    added_by_handle: &str,
    status: &str,
    created_at: Option<Instant>,
) -> Json {
    Json::obj([
        ("userId", Json::str(user_id)),
        ("handle", Json::str(handle)),
        ("addedByHandle", Json::str(added_by_handle)),
        ("status", Json::str(status)),
        ("createdAt", iso(created_at)),
    ])
}

/// `advisors`.
pub fn advisors(d: &Deps<'_>, account_id: &str, user_id: &str) -> Result<Json, Refusal> {
    let rows = with(d.store, |c| {
        member(c, account_id, user_id)?;
        c.query(
            &format!(
                "SELECT user_id, added_by, status, {} FROM bank.business_advisors \
                 WHERE account_id = $1::text::uuid ORDER BY created_at ASC",
                ms("created_at")
            ),
            &[&account_id],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(|r| Ok((get_s(r, 0)?, get_s(r, 1)?, get_s(r, 2)?, get_t(r, 3)?)))
        .collect::<Result<Vec<_>, Refusal>>()
    })?;
    let ids: Vec<String> = rows
        .iter()
        .flat_map(|r| [r.0.clone(), r.1.clone()])
        .collect();
    let names = handles(d, &ids)?;
    let name = |id: &str| names.get(id).cloned().unwrap_or_default();
    Ok(Json::Array(
        rows.iter()
            .map(|(u, by, status, at)| advisor_json(u, &name(u), &name(by), status, *at))
            .collect(),
    ))
}

/// `invites`: the newest 50, for a member who manages the team.
pub fn invites(d: &Deps<'_>, account_id: &str, user_id: &str) -> Result<Json, Refusal> {
    with(d.store, |c| {
        member(c, account_id, user_id)?.need("manage_team")?;
        let rows = c
            .query(
                &format!(
                    "SELECT {}, r.name FROM bank.business_invites i \
                     LEFT JOIN bank.business_custom_roles r ON r.id = i.custom_role_id \
                     WHERE i.account_id = $1::text::uuid ORDER BY i.created_at DESC LIMIT 50",
                    invite_cols("i.")
                ),
                &[&account_id],
            )
            .map_err(|e| pg(&e))?;
        Ok(Json::Array(
            rows.iter().map(invite_json).collect::<Result<_, _>>()?,
        ))
    })
}

/// `rules`.
pub fn rules(d: &Deps<'_>, account_id: &str, user_id: &str) -> Result<Json, Refusal> {
    with(d.store, |c| {
        member(c, account_id, user_id)?;
        Ok(Json::Array(
            rule_rows(c, account_id)?
                .iter()
                .map(RuleRow::json)
                .collect(),
        ))
    })
}

/// `payments`: the newest 50.
pub fn payments(d: &Deps<'_>, account_id: &str, user_id: &str) -> Result<Json, Refusal> {
    let rows = with(d.store, |c| {
        member(c, account_id, user_id)?;
        c.query(
            &format!(
                "SELECT {} FROM bank.business_payments WHERE account_id = $1::text::uuid \
                 ORDER BY created_at DESC, id DESC LIMIT 50",
                payment_cols()
            ),
            &[&account_id],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(PaymentRow::from_row)
        .collect::<Result<Vec<_>, Refusal>>()
    })?;
    Ok(Json::Array(with_approvals(d, &rows)?))
}

/// `payment`: one payment, for a member of its business.
pub fn payment(d: &Deps<'_>, payment_id: &str, user_id: &str) -> Result<Json, Refusal> {
    let row = with(d.store, |c| {
        let row = payment_row(c, payment_id, false)?;
        member(c, &row.account_id, user_id)?;
        Ok(row)
    })?;
    with_approvals(d, &[row])?
        .into_iter()
        .next()
        .ok_or_else(|| Refusal::Other("a payment with no view".to_owned()))
}

/// `withApprovals`: each payment with its rule, its approvals and every handle.
fn with_approvals(d: &Deps<'_>, rows: &[PaymentRow]) -> Result<Vec<Json>, Refusal> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
    let rule_ids: Vec<String> = rows
        .iter()
        .filter_map(|r| r.rule_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let (approvals, rules) = with(d.store, |c| {
        let approvals = c
            .query(
                &format!(
                    "SELECT payment_id::text, approver_user_id, {} FROM bank.business_payment_approvals \
                     WHERE payment_id = ANY($1::text[]::uuid[]) ORDER BY approved_at ASC, approver_user_id ASC",
                    ms("approved_at")
                ),
                &[&ids],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(|r| Ok((get_s(r, 0)?, get_s(r, 1)?, get_t(r, 2)?)))
            .collect::<Result<Vec<_>, Refusal>>()?;
        let rules = if rule_ids.is_empty() {
            Vec::new()
        } else {
            c.query(
                &format!(
                    "SELECT {} FROM bank.business_payment_rules WHERE id = ANY($1::text[]::uuid[])",
                    rule_cols()
                ),
                &[&rule_ids],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(RuleRow::from_row)
            .collect::<Result<Vec<_>, Refusal>>()?
        };
        Ok((approvals, rules))
    })?;
    let mut people: Vec<String> = rows.iter().map(|r| r.maker_user_id.clone()).collect();
    people.extend(approvals.iter().map(|a| a.1.clone()));
    let names = handles(d, &people)?;
    let name = |id: &str| Json::str(names.get(id).cloned().unwrap_or_default());
    Ok(rows
        .iter()
        .map(|row| {
            let rule = rules
                .iter()
                .find(|r| Some(&r.id) == row.rule_id.as_ref())
                .map_or(Json::Null, RuleRow::json);
            Json::obj([
                ("id", Json::str(row.id.clone())),
                ("accountId", Json::str(row.account_id.clone())),
                ("makerUserId", Json::str(row.maker_user_id.clone())),
                ("makerHandle", name(&row.maker_user_id)),
                ("payee", Json::str(row.payee.clone())),
                ("paymentType", Json::str(row.payment_type.clone())),
                ("assetId", Json::str(row.asset_id.clone())),
                ("amount", Json::str(format_amount(row.amount))),
                ("rule", rule),
                ("approvalsNeeded", Json::int(row.approvals_needed)),
                (
                    "approvals",
                    Json::Array(
                        approvals
                            .iter()
                            .filter(|a| a.0 == row.id)
                            .map(|a| {
                                Json::obj([
                                    ("userId", Json::str(a.1.clone())),
                                    ("handle", name(&a.1)),
                                    ("approvedAt", iso(a.2)),
                                ])
                            })
                            .collect(),
                    ),
                ),
                ("status", Json::str(row.status.clone())),
                ("partnerKey", Json::str(row.partner_key.clone())),
                ("partnerMoveId", opt(row.partner_move_id.as_deref())),
                ("refusalCode", opt(row.refusal_code.as_deref())),
                ("createdAt", Json::str(row.created_at.iso())),
                ("sentAt", iso(row.sent_at)),
            ])
        })
        .collect())
}

// ---------------------------------------------------------------------------------------------------------------
// Roles

/// `createRole` (BK-biz-01): a role the business names, granting no permission the creator does not hold.
pub fn create_role(
    d: &Deps<'_>,
    account_id: &str,
    actor: &str,
    role_id: &str,
    raw_name: &str,
    asked: &[String],
) -> Result<Json, Refusal> {
    let name = js_trim(raw_name);
    if name.is_empty() || js_len(name) > 64 {
        return Err(refuse(
            "bank.business_invalid_name",
            "A role needs a name of 1 to 64 characters.",
        ));
    }
    let mut permissions: Vec<String> = Vec::new();
    for p in asked {
        if !permissions.contains(p) {
            permissions.push(p.clone());
        }
    }
    if permissions.is_empty()
        || permissions
            .iter()
            .any(|p| !PERMISSIONS.contains(&p.as_str()))
    {
        return Err(refuse(
            "bank.business_role_invalid",
            "A role needs at least one permission from the list.",
        ));
    }
    if !permissions.iter().any(|p| p == "view") {
        return Err(refuse(
            "bank.business_role_invalid",
            "A role always includes view.",
        ));
    }
    in_tx(d.store, |tx| {
        active_account(tx, account_id)?;
        let me = member(tx, account_id, actor)?;
        me.need("manage_team")?;
        let beyond = beyond_of(&me, &permissions);
        if !beyond.is_empty() {
            return Err(refuse(
                "bank.business_role_grant_exceeds",
                format!(
                    "You cannot create a role that grants {}: you do not hold {} yourself. Nothing was created.",
                    beyond.join(", "),
                    if beyond.len() == 1 { "it" } else { "them" }
                ),
            ));
        }
        let ordered: Vec<String> = PERMISSIONS
            .iter()
            .filter(|p| permissions.iter().any(|q| q == *p))
            .map(|p| (*p).to_owned())
            .collect();
        let existing = tx
            .query(
                &format!(
                    "SELECT id::text, account_id::text, name, permissions, {} FROM bank.business_custom_roles \
                     WHERE id = $1::text::uuid",
                    ms("created_at")
                ),
                &[&role_id],
            )
            .map_err(|e| pg(&e))?;
        if let Some(r) = existing.first() {
            let same = get_s(r, 1)? == account_id
                && get_s(r, 2)? == name
                && r.try_get::<_, Vec<String>>(3).map_err(|e| pg(&e))? == ordered;
            if !same {
                return Err(refuse(
                    "bank.business_request_conflict",
                    "This role id is already used on different terms.",
                ));
            }
            return Ok(role_json(&get_s(r, 0)?, name, &ordered, get_t(r, 4)?));
        }
        let rows = tx
            .query(
                &format!(
                    "INSERT INTO bank.business_custom_roles (id, account_id, name, permissions, created_by) \
                     VALUES ($1::text::uuid, $2::text::uuid, $3, $4::text[], $5) RETURNING id::text, {}",
                    ms("created_at")
                ),
                &[&role_id, &account_id, &name, &ordered, &actor],
            )
            .map_err(|e| {
                if unique_violation(&e) {
                    refuse(
                        "bank.business_role_name_taken",
                        format!("This business already has a role named {name}."),
                    )
                } else {
                    pg(&e)
                }
            })?;
        let r = rows
            .first()
            .ok_or_else(|| Refusal::Other("a role insert returned nothing".to_owned()))?;
        Ok(role_json(&get_s(r, 0)?, name, &ordered, get_t(r, 1)?))
    })
}

/// `assignRole`: gives a member a named role within the actor's own permissions, and seats them on the built-in role it
/// fits, so every older door holds them to it too. None takes the named role away; the built-in role stays.
pub fn assign_role(
    d: &Deps<'_>,
    account_id: &str,
    actor: &str,
    user_id: &str,
    role_id: Option<&str>,
) -> Result<Json, Refusal> {
    in_tx(d.store, |tx| {
        active_account(tx, account_id)?;
        let me = member(tx, account_id, actor)?;
        me.need("manage_team")?;
        let target = member_or_none(tx, account_id, user_id)?;
        let Some(target) = target.filter(|t| !t.advisor) else {
            return Err(refuse(
                "bank.business_not_member",
                "That person is not a member of this business.",
            ));
        };
        let a = account(tx, account_id)?;
        if a.owner_user_id.as_deref() == Some(user_id) {
            return Err(refuse(
                "bank.business_last_admin",
                "The owner keeps every permission; their role is not changed.",
            ));
        }
        if let Some(role_id) = role_id.filter(|r| !r.is_empty()) {
            let (_, granted) = role_in(tx, account_id, role_id)?;
            let beyond = beyond_of(&me, &granted);
            if !beyond.is_empty() {
                return Err(refuse(
                    "bank.business_role_grant_exceeds",
                    format!(
                        "You cannot give a role that grants {}, which you do not hold.",
                        beyond.join(", ")
                    ),
                ));
            }
            let fitted = fitted_role(&granted);
            if policy::role_can(&target.role, Capability::ManageTeam)
                && !policy::role_can(fitted, Capability::ManageTeam)
            {
                let managers = tx
                    .query(
                        "SELECT role::text FROM bank.business_members WHERE account_id = $1::text::uuid FOR UPDATE",
                        &[&account_id],
                    )
                    .map_err(|e| pg(&e))?
                    .iter()
                    .map(|r| get_s(r, 0))
                    .collect::<Result<Vec<_>, Refusal>>()?;
                if managers
                    .iter()
                    .filter(|r| policy::role_can(r, Capability::ManageTeam))
                    .count()
                    < 2
                {
                    return Err(refuse(
                        "bank.business_last_admin",
                        "The last administrator cannot be narrowed.",
                    ));
                }
            }
            tx.execute(
                "UPDATE bank.business_members SET custom_role_id = $1::text::uuid, role = $2::text::bank.business_member_role \
                 WHERE account_id = $3::text::uuid AND user_id = $4",
                &[&role_id, &fitted, &account_id, &user_id],
            )
            .map_err(|e| pg(&e))?;
        } else {
            tx.execute(
                "UPDATE bank.business_members SET custom_role_id = NULL \
                 WHERE account_id = $1::text::uuid AND user_id = $2",
                &[&account_id, &user_id],
            )
            .map_err(|e| pg(&e))?;
        }
        let row = member(tx, account_id, user_id)?;
        Ok(row.json(&handles(d, &[user_id.to_owned()])?))
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Advisors

fn advisor_row<C: GenericClient>(
    c: &mut C,
    sql: &str,
    params: &[&(dyn postgres::types::ToSql + Sync)],
) -> Result<Option<(String, String, Option<Instant>)>, Refusal> {
    c.query(sql, params)
        .map_err(|e| pg(&e))?
        .first()
        .map(|r| Ok((get_s(r, 0)?, get_s(r, 1)?, get_t(r, 2)?)))
        .transpose()
}

/// `addAdvisor` (BK-biz-01): an advisor by handle. Added by the owner it is approved; by anyone else it waits for the owner.
pub fn add_advisor(
    d: &Deps<'_>,
    account_id: &str,
    actor: &str,
    raw_handle: &str,
) -> Result<Json, Refusal> {
    let Some(handle) = handle_query(raw_handle) else {
        return Err(refuse(
            "bank.business_invalid_handle",
            "Enter the advisor\u{2019}s handle.",
        ));
    };
    let Some((person, person_handle)) = d
        .spaces
        .directory
        .find_active(&Lookup::Handle(handle))
        .map_err(directory_refusal)?
    else {
        return Err(refuse(
            "bank.business_person_not_found",
            "No active account has that handle.",
        ));
    };
    in_tx(d.store, |tx| {
        let a = active_account(tx, account_id)?;
        member(tx, account_id, actor)?.need("manage_team")?;
        if member_or_none(tx, account_id, &person)?.is_some() {
            return Err(refuse(
                "bank.business_already_member",
                "That person is already on this business.",
            ));
        }
        let by_owner = a.owner_user_id.as_deref() == Some(actor);
        let status = if by_owner { "approved" } else { "pending" };
        let decided_by: Option<&str> = by_owner.then_some(actor);
        let cols = format!("status, added_by, {}", ms("created_at"));
        let inserted = advisor_row(
            tx,
            &format!(
                "INSERT INTO bank.business_advisors (account_id, user_id, added_by, status, decided_by, decided_at) \
                 VALUES ($1::text::uuid, $2, $3, $4, $5, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END) \
                 ON CONFLICT (account_id, user_id) DO NOTHING RETURNING {cols}"
            ),
            &[&account_id, &person, &actor, &status, &decided_by],
        )?;
        let row = match inserted {
            Some(r) => r,
            None => advisor_row(
                tx,
                &format!(
                    "SELECT {cols} FROM bank.business_advisors WHERE account_id = $1::text::uuid AND user_id = $2"
                ),
                &[&account_id, &person],
            )?
            .ok_or_else(|| Refusal::Other("an advisor row vanished".to_owned()))?,
        };
        if row.0 == "approved" {
            seat_advisor(tx, account_id, &person)?;
        }
        let names = handles(d, std::slice::from_ref(&row.1))?;
        Ok(advisor_json(
            &person,
            &person_handle,
            &names.get(&row.1).cloned().unwrap_or_default(),
            &row.0,
            row.2,
        ))
    })
}

/// `approveAdvisor`: only the business's owner approves an advisor; then the advisor reads the business, and nothing more.
pub fn approve_advisor(
    d: &Deps<'_>,
    account_id: &str,
    actor: &str,
    user_id: &str,
) -> Result<Json, Refusal> {
    in_tx(d.store, |tx| {
        let a = active_account(tx, account_id)?;
        member(tx, account_id, actor)?;
        if a.owner_user_id.as_deref() != Some(actor) {
            return Err(refuse(
                "bank.business_owner_only",
                "Only the owner of this business can approve an advisor. Nothing changed.",
            ));
        }
        let row = advisor_row(
            tx,
            &format!(
                "UPDATE bank.business_advisors SET status = 'approved', decided_by = COALESCE(decided_by, $3), \
                 decided_at = COALESCE(decided_at, now()) \
                 WHERE account_id = $1::text::uuid AND user_id = $2 RETURNING status, added_by, {}",
                ms("created_at")
            ),
            &[&account_id, &user_id, &actor],
        )?
        .ok_or_else(|| {
            refuse(
                "bank.business_advisor_not_found",
                "No advisor of this business is waiting with that id.",
            )
        })?;
        seat_advisor(tx, account_id, user_id)?;
        let names = handles(d, &[user_id.to_owned(), row.1.clone()])?;
        let name = |id: &str| names.get(id).cloned().unwrap_or_default();
        Ok(advisor_json(
            user_id,
            &name(user_id),
            &name(&row.1),
            "approved",
            row.2,
        ))
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Invites

/// What an invite asks.
pub struct InviteAsk<'a> {
    pub account_id: &'a str,
    pub actor: &'a str,
    pub invite_id: &'a str,
    pub email: Option<&'a str>,
    pub role: Option<&'a str>,
    pub role_id: Option<&'a str>,
}

fn made(invite: Json, token: Option<String>) -> Json {
    Json::obj([
        ("invite", invite),
        ("token", token.map_or(Json::Null, Json::str)),
    ])
}

/// One invite row to write.
struct NewInvite<'a> {
    id: &'a str,
    account_id: &'a str,
    kind: &'a str,
    email: Option<&'a str>,
    hash: &'a str,
    role: Option<&'a str>,
    role_id: Option<&'a str>,
    actor: &'a str,
}

fn insert_invite<C: GenericClient>(
    c: &mut C,
    n: &NewInvite<'_>,
    minutes: i64,
) -> Result<(), Refusal> {
    let NewInvite {
        id,
        account_id,
        kind,
        email,
        hash,
        role,
        role_id,
        actor,
    } = n;
    let minutes = i32::try_from(minutes).map_err(|e| Refusal::Other(e.to_string()))?;
    c.execute(
        "INSERT INTO bank.business_invites \
         (id, account_id, kind, email, token_hash, role, custom_role_id, invited_by, expires_at) \
         VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5, $6::text::bank.business_member_role, $7::text::uuid, $8, \
                 now() + make_interval(mins => $9::int))",
        &[&id, &account_id, &kind, &email, &hash, &role, &role_id, &actor, &minutes],
    )
    .map_err(|e| pg(&e))?;
    Ok(())
}

/// `invite` (BK-biz-02): by email or by link, as a built-in role or a named one. The link's secret is answered once; only
/// its hash is kept. The same invite id answers the same invite, with no secret.
pub fn invite(d: &Deps<'_>, ask: &InviteAsk<'_>, minutes: Option<&str>) -> Result<Json, Refusal> {
    let minutes = invite_minutes(minutes)?;
    let email = match ask.email {
        None => None,
        Some(raw) => Some(email_query(raw).map(|e| e.to_lowercase()).ok_or_else(|| {
            refuse(
                "bank.business_invalid_email",
                "Enter a valid email address.",
            )
        })?),
    };
    if ask.role.is_none() == ask.role_id.is_none() {
        return Err(refuse(
            "bank.business_role_invalid",
            "Choose one role for the invite.",
        ));
    }
    in_tx(d.store, |tx| {
        active_account(tx, ask.account_id)?;
        let me = member(tx, ask.account_id, ask.actor)?;
        me.need("manage_team")?;
        if let Some(role_id) = ask.role_id {
            let (_, granted) = role_in(tx, ask.account_id, role_id)?;
            let beyond = beyond_of(&me, &granted);
            if !beyond.is_empty() {
                return Err(refuse(
                    "bank.business_role_grant_exceeds",
                    format!(
                        "You cannot invite someone to a role that grants {}, which you do not hold.",
                        beyond.join(", ")
                    ),
                ));
            }
        } else {
            assert_may_grant_built_in(&me, ask.role.unwrap_or_default())?;
        }
        if let Some(prior) = invite_row(tx, ask.invite_id, false)? {
            let same = prior.account_id == ask.account_id
                && prior.email == email
                && prior.role.as_deref() == ask.role
                && prior.custom_role_id.as_deref() == ask.role_id
                && prior.invited_by == ask.actor;
            if !same {
                return Err(conflict("invite"));
            }
            return Ok(made(invite_view(tx, &prior.id)?, None));
        }
        let token = new_token()?;
        let kind = if email.is_some() { "email" } else { "link" };
        insert_invite(
            tx,
            &NewInvite {
                id: ask.invite_id,
                account_id: ask.account_id,
                kind,
                email: email.as_deref(),
                hash: &hash_token(&token),
                role: ask.role,
                role_id: ask.role_id,
                actor: ask.actor,
            },
            minutes,
        )?;
        Ok(made(invite_view(tx, ask.invite_id)?, Some(token)))
    })
}

/// `resendInvite`: an open or expired invite sent again; the old link stops working and the new one lasts the full lifetime.
pub fn resend_invite(
    d: &Deps<'_>,
    account_id: &str,
    actor: &str,
    invite_id: &str,
    new_invite_id: &str,
    minutes: Option<&str>,
) -> Result<Json, Refusal> {
    let minutes = invite_minutes(minutes)?;
    in_tx(d.store, |tx| {
        active_account(tx, account_id)?;
        let me = member(tx, account_id, actor)?;
        me.need("manage_team")?;
        let Some(old) = invite_row(tx, invite_id, true)?.filter(|o| o.account_id == account_id)
        else {
            return Err(invite_not_found());
        };
        if old.status == "replaced" && old.replaced_by.as_deref() == Some(new_invite_id) {
            return Ok(made(invite_view(tx, new_invite_id)?, None));
        }
        if old.status != "open" {
            return Err(refuse(
                "bank.business_invite_inactive",
                format!("This invite is {} and cannot be sent again.", old.status),
            ));
        }
        // Sending it again is granting it again: the one who sends must hold the role it carries.
        if let Some(role) = old.role.as_deref() {
            assert_may_grant_built_in(&me, role)?;
        } else if let Some(role_id) = old.custom_role_id.as_deref() {
            let (_, granted) = role_in(tx, &old.account_id, role_id)?;
            let beyond = beyond_of(&me, &granted);
            if !beyond.is_empty() {
                return Err(refuse(
                    "bank.business_role_grant_exceeds",
                    format!(
                        "You cannot send an invite to a role that grants {}.",
                        beyond.join(", ")
                    ),
                ));
            }
        }
        let token = new_token()?;
        insert_invite(
            tx,
            &NewInvite {
                id: new_invite_id,
                account_id: &old.account_id,
                kind: &old.kind,
                email: old.email.as_deref(),
                hash: &hash_token(&token),
                role: old.role.as_deref(),
                role_id: old.custom_role_id.as_deref(),
                actor,
            },
            minutes,
        )?;
        tx.execute(
            "UPDATE bank.business_invites SET status = 'replaced', replaced_by = $1::text::uuid, decided_at = now() \
             WHERE id = $2::text::uuid",
            &[&new_invite_id, &old.id],
        )
        .map_err(|e| pg(&e))?;
        Ok(made(invite_view(tx, new_invite_id)?, Some(token)))
    })
}

/// `revokeInvite`.
pub fn revoke_invite(
    d: &Deps<'_>,
    account_id: &str,
    actor: &str,
    invite_id: &str,
) -> Result<Json, Refusal> {
    in_tx(d.store, |tx| {
        member(tx, account_id, actor)?.need("manage_team")?;
        let Some(old) = invite_row(tx, invite_id, true)?.filter(|o| o.account_id == account_id)
        else {
            return Err(invite_not_found());
        };
        if old.status == "open" {
            tx.execute(
                "UPDATE bank.business_invites SET status = 'revoked', decided_at = now() WHERE id = $1::text::uuid",
                &[&old.id],
            )
            .map_err(|e| pg(&e))?;
        } else if old.status != "revoked" {
            return Err(refuse(
                "bank.business_invite_inactive",
                format!("This invite is {} and cannot be revoked.", old.status),
            ));
        }
        invite_view(tx, &old.id)
    })
}

fn token_shape(token: &str) -> bool {
    (16..=64).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn joined(d: &Deps<'_>, a: &AccountRow, m: &MemberRow, user_id: &str) -> Result<Json, Refusal> {
    Ok(Json::obj([
        ("accountId", Json::str(a.id.clone())),
        ("name", Json::str(a.name.clone())),
        ("member", m.json(&handles(d, &[user_id.to_owned()])?)),
    ]))
}

/// `acceptInvite`: the invitee opens the link. An email invite is for the account with that email only.
pub fn accept_invite(d: &Deps<'_>, token: &str, user_id: &str) -> Result<Json, Refusal> {
    if !token_shape(token) {
        return Err(invite_not_found());
    }
    let hash = hash_token(token);
    let row = with(d.store, |c| {
        c.query(
            &format!(
                "SELECT {} FROM bank.business_invites WHERE token_hash = $1",
                invite_cols("")
            ),
            &[&hash],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(InviteRow::from_row)
        .transpose()
    })?
    .ok_or_else(invite_not_found)?;
    if row.status == "accepted" && row.accepted_by.as_deref() == Some(user_id) {
        let (a, m) = with(d.store, |c| {
            Ok((
                account(c, &row.account_id)?,
                member(c, &row.account_id, user_id)?,
            ))
        })?;
        return joined(d, &a, &m, user_id);
    }
    assert_invite_open(&row)?;
    if let Some(email) = row.email.as_deref() {
        let found = d
            .spaces
            .directory
            .find_active(&Lookup::Email(email.to_owned()))
            .map_err(directory_refusal)?;
        if found.is_none_or(|(id, _)| id != user_id) {
            return Err(refuse(
                "bank.business_invite_wrong_person",
                "This invite was sent to another email address. Sign in with that account to accept it.",
            ));
        }
    }
    in_tx(d.store, |tx| {
        let locked = invite_row(tx, &row.id, true)?.ok_or_else(invite_not_found)?;
        assert_invite_open(&locked)?;
        let a = active_account(tx, &locked.account_id)?;
        if member_or_none(tx, &locked.account_id, user_id)?.is_some() {
            return Err(refuse(
                "bank.business_already_member",
                "You are already on this business.",
            ));
        }
        // A named role seats the member on the built-in role it fits, so the older doors hold them to it too.
        let seat = match locked.custom_role_id.as_deref() {
            Some(role_id) => fitted_role(&role_in(tx, &locked.account_id, role_id)?.1).to_owned(),
            None => locked.role.clone().unwrap_or_else(|| "viewer".to_owned()),
        };
        tx.execute(
            "INSERT INTO bank.business_members (account_id, user_id, role, custom_role_id) \
             VALUES ($1::text::uuid, $2, $3::text::bank.business_member_role, $4::text::uuid)",
            &[&locked.account_id, &user_id, &seat, &locked.custom_role_id],
        )
        .map_err(|e| pg(&e))?;
        tx.execute(
            "UPDATE bank.business_invites SET status = 'accepted', accepted_by = $1, decided_at = now() \
             WHERE id = $2::text::uuid",
            &[&user_id, &locked.id],
        )
        .map_err(|e| pg(&e))?;
        let m = member(tx, &locked.account_id, user_id)?;
        joined(d, &a, &m, user_id)
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Rules

/// What a rule asks.
pub struct RuleAsk<'a> {
    pub account_id: &'a str,
    pub actor: &'a str,
    pub rule_id: &'a str,
    pub over_amount: Amount,
    pub payee: Option<&'a str>,
    pub payment_type: Option<&'a str>,
    pub approvals: f64,
}

/// `addRule` (BK-biz-03): an approval rule by amount, payee and payment type.
pub fn add_rule(d: &Deps<'_>, ask: &RuleAsk<'_>) -> Result<Json, Refusal> {
    if ask.over_amount < Amount::ZERO {
        return Err(refuse(
            "bank.business_rule_invalid",
            "A rule\u{2019}s amount cannot be below zero.",
        ));
    }
    if ask.approvals.fract() != 0.0 || ask.approvals < 1.0 || ask.approvals > 5.0 {
        return Err(refuse(
            "bank.business_rule_invalid",
            format!("A rule asks for 1 to {MAX_RULE_APPROVALS} approvers."),
        ));
    }
    #[allow(
        clippy::cast_possible_truncation,
        reason = "a whole number from 1 to 5, checked above"
    )]
    let approvals = ask.approvals as i32;
    let payee = ask.payee.map(js_trim).filter(|p| !p.is_empty());
    if payee.is_some_and(|p| js_len(p) > 128) {
        return Err(refuse(
            "bank.business_rule_invalid",
            "A payee name is 128 characters or fewer.",
        ));
    }
    in_tx(d.store, |tx| {
        active_account(tx, ask.account_id)?;
        member(tx, ask.account_id, ask.actor)?.need("manage_team")?;
        let over = format_amount(ask.over_amount);
        let inserted = tx
            .query(
                &format!(
                    "INSERT INTO bank.business_payment_rules \
                     (id, account_id, over_amount, payee, payment_type, approvals, created_by) \
                     VALUES ($1::text::uuid, $2::text::uuid, $3::text::numeric, $4, $5, $6, $7) \
                     ON CONFLICT (id) DO NOTHING RETURNING {}",
                    rule_cols()
                ),
                &[
                    &ask.rule_id,
                    &ask.account_id,
                    &over,
                    &payee,
                    &ask.payment_type,
                    &approvals,
                    &ask.actor,
                ],
            )
            .map_err(|e| pg(&e))?;
        let rows = if inserted.is_empty() {
            tx.query(
                &format!(
                    "SELECT {} FROM bank.business_payment_rules WHERE id = $1::text::uuid",
                    rule_cols()
                ),
                &[&ask.rule_id],
            )
            .map_err(|e| pg(&e))?
        } else {
            inserted
        };
        let r = rows
            .first()
            .ok_or_else(|| Refusal::Other("a rule row vanished".to_owned()))?;
        let rule = RuleRow::from_row(r)?;
        let same = get_s(r, 6)? == ask.account_id
            && rule.over_amount == ask.over_amount
            && rule.payee.as_deref() == payee
            && rule.payment_type.as_deref() == ask.payment_type
            && rule.approvals == i64::from(approvals);
        if !same {
            return Err(conflict("rule"));
        }
        Ok(rule.json())
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Payments

/// What a payment asks.
pub struct ProposeAsk<'a> {
    pub account_id: &'a str,
    pub maker: &'a str,
    pub payment_id: &'a str,
    pub payee: &'a str,
    pub payment_type: &'a str,
    pub amount: Amount,
}

/// `propose`: a payment from the business's account at the partner to a payee. The rule it falls under is fixed now; with
/// no rule it is sent at once.
pub fn propose(d: &Deps<'_>, ask: &ProposeAsk<'_>) -> Result<Json, Refusal> {
    let payee = js_trim(ask.payee);
    if payee.is_empty() || js_len(payee) > 128 {
        return Err(refuse(
            "bank.business_payee_invalid",
            "A payment needs a payee of 1 to 128 characters.",
        ));
    }
    if ask.amount <= Amount::ZERO {
        return Err(refuse(
            "bank.below_minimum",
            "A payment needs an amount above zero.",
        ));
    }
    if let Some(prior) = with(d.store, |c| payment_row_or_none(c, ask.payment_id, false))? {
        let same = prior.account_id == ask.account_id
            && prior.maker_user_id == ask.maker
            && prior.payee == payee
            && prior.payment_type == ask.payment_type
            && prior.amount == ask.amount;
        if !same {
            return Err(conflict("payment"));
        }
        if prior.status == "sending" {
            money_may_move(d)?;
            send(d, &prior)?;
        }
        return payment(d, &prior.id, ask.maker);
    }
    // A payment no rule holds is sent at once: while posting is frozen nothing is recorded or sent.
    money_may_move(d)?;
    let created = in_tx(d.store, |tx| {
        let a = active_account(tx, ask.account_id)?;
        member(tx, ask.account_id, ask.maker)?.need("propose")?;
        if partner_for(d, &a).is_none() {
            return Err(no_partner());
        }
        let rows = rule_rows(tx, ask.account_id)?;
        let rules: Vec<Rule> = rows
            .iter()
            .map(|r| Rule {
                over_amount: r.over_amount,
                payee: r.payee.clone(),
                payment_type: r.payment_type.clone(),
                approvals: r.approvals,
            })
            .collect();
        let rule = pick_rule(&rules, ask.amount, payee, ask.payment_type).and_then(|i| rows.get(i));
        let needed = rule.map_or(0, |r| r.approvals);
        if needed > 0 {
            let pool = member_rows(tx, ask.account_id)?
                .into_iter()
                .filter(|m| m.user_id != ask.maker && m.holds("approve"))
                .count();
            if i64::try_from(pool).unwrap_or(i64::MAX) < needed {
                return Err(refuse(
                    "bank.business_approvers_short",
                    format!(
                        "This payment needs {needed} approvers other than you, and this business has {pool}. Nothing was proposed."
                    ),
                ));
            }
        }
        let needed_i32 = i32::try_from(needed).map_err(|e| Refusal::Other(e.to_string()))?;
        let status = if needed == 0 { "sending" } else { "pending" };
        let rule_id = rule.map(|r| r.id.clone());
        // No conflict target: partner_key is fixed by id (business_payments_key_ck), so a clash on either key is this
        // same payment, and the call that loses a race reads the winner instead of raising 23505 on partner_key.
        tx.query(
            &format!(
                "INSERT INTO bank.business_payments \
                 (id, account_id, maker_user_id, payee, payment_type, asset_id, amount, rule_id, approvals_needed, status, partner_key) \
                 VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5, $6, $7::text::numeric, $8::text::uuid, $9, $10, $11) \
                 ON CONFLICT DO NOTHING RETURNING {}",
                payment_cols()
            ),
            &[
                &ask.payment_id,
                &ask.account_id,
                &ask.maker,
                &payee,
                &ask.payment_type,
                &a.asset_id,
                &format_amount(ask.amount),
                &rule_id,
                &needed_i32,
                &status,
                &payment_key(ask.payment_id),
            ],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(PaymentRow::from_row)
        .transpose()
    })?;
    let Some(created) = created else {
        return propose(d, ask);
    };
    if created.status == "sending" {
        send(d, &created)?;
    }
    payment(d, &created.id, ask.maker)
}

/// `approve`: one approval by one distinct approver, never the maker. The approval that completes the rule's count sends the
/// instruction, once; called again while it is being sent, it reads the instruction back by its key.
pub fn approve(d: &Deps<'_>, payment_id: &str, approver: &str) -> Result<Json, Refusal> {
    // The approval that completes the count sends: while posting is frozen no approval is recorded.
    money_may_move(d)?;
    let decided = in_tx(d.store, |tx| {
        let row = payment_row(tx, payment_id, true)?;
        let me = member(tx, &row.account_id, approver)?;
        if row.maker_user_id == approver {
            return Err(refuse(
                "bank.business_self_approve",
                "You proposed this payment, so you cannot approve it. Another approver must.",
            ));
        }
        me.need("approve")?;
        let already = !tx
            .query(
                "SELECT 1 FROM bank.business_payment_approvals \
                 WHERE payment_id = $1::text::uuid AND approver_user_id = $2",
                &[&row.id, &approver],
            )
            .map_err(|e| pg(&e))?
            .is_empty();
        if row.status == "sending" && already {
            return Ok(Some(row));
        }
        if row.status != "pending" {
            return Err(refuse(
                "bank.business_approval_inactive",
                format!(
                    "This payment is {}; it takes no more approvals.",
                    row.status
                ),
            ));
        }
        if already {
            return Err(refuse(
                "bank.business_already_approved",
                "You have already approved this payment. A different approver must give the next approval.",
            ));
        }
        tx.execute(
            "INSERT INTO bank.business_payment_approvals (payment_id, approver_user_id) VALUES ($1::text::uuid, $2)",
            &[&row.id, &approver],
        )
        .map_err(|e| pg(&e))?;
        let count: i64 = tx
            .query_one(
                "SELECT count(*) FROM bank.business_payment_approvals WHERE payment_id = $1::text::uuid",
                &[&row.id],
            )
            .map_err(|e| pg(&e))?
            .try_get(0)
            .map_err(|e| pg(&e))?;
        if count < row.approvals_needed {
            return Ok(None);
        }
        // The key is on the row already; marking it sending before the partner is asked is what makes it sent once.
        tx.query(
            &format!(
                "UPDATE bank.business_payments SET status = 'sending' WHERE id = $1::text::uuid AND status = 'pending' \
                 RETURNING {}",
                payment_cols()
            ),
            &[&row.id],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(PaymentRow::from_row)
        .transpose()?
        .map(Some)
        .ok_or_else(|| Refusal::Other("a pending payment vanished".to_owned()))
    })?;
    if let Some(row) = decided {
        send(d, &row)?;
    }
    payment(d, payment_id, approver)
}

/// `reject`: an approver or the maker declines a waiting payment. Nothing is sent.
pub fn reject(d: &Deps<'_>, payment_id: &str, user_id: &str) -> Result<Json, Refusal> {
    in_tx(d.store, |tx| {
        let row = payment_row(tx, payment_id, true)?;
        let me = member(tx, &row.account_id, user_id)?;
        if row.maker_user_id != user_id {
            me.need("approve")?;
        }
        if row.status == "rejected" {
            return Ok(());
        }
        if row.status != "pending" {
            return Err(refuse(
                "bank.business_approval_inactive",
                format!("This payment is {} and cannot be declined.", row.status),
            ));
        }
        tx.execute(
            "UPDATE bank.business_payments SET status = 'rejected' WHERE id = $1::text::uuid",
            &[&row.id],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })?;
    payment(d, payment_id, user_id)
}

/// `resend`: a payment whose answer from the partner was not definite, sent again under the same key: made at most once.
pub fn resend(d: &Deps<'_>, payment_id: &str, user_id: &str) -> Result<Json, Refusal> {
    money_may_move(d)?;
    let row = with(d.store, |c| {
        let row = payment_row(c, payment_id, false)?;
        let me = member(c, &row.account_id, user_id)?;
        if row.maker_user_id != user_id {
            me.need("approve")?;
        }
        Ok(row)
    })?;
    if row.status == "sending" {
        send(d, &row)?;
    }
    payment(d, payment_id, user_id)
}

/// `send`: the one partner instruction. A retry first asks the partner for the move under the key: an answer that was
/// lost is never sent again blind. A refusal that says nothing moved closes the payment as refused.
fn send(d: &Deps<'_>, row: &PaymentRow) -> Result<(), Refusal> {
    let a = with(d.store, |c| account(c, &row.account_id))?;
    let partner = partner_for(d, &a).ok_or_else(no_partner)?;
    let moved = match partner.move_by_key(&row.partner_key) {
        Some(m) => Ok(m),
        None => partner.move_(
            &MoveRequest {
                key: row.partner_key.clone(),
                from: partner_account(&row.account_id, &row.asset_id),
                to: payouts_account(&row.asset_id),
                amount: row.amount,
                payees: None,
            },
            d.now,
        ),
    };
    let m = match moved {
        Ok(m) => m,
        Err(err) => {
            if let Refusal::Bank(e) = &err
                && DEFINITE_REFUSALS.contains(&e.row.code)
            {
                let code = e.row.code;
                with(d.store, |c| {
                    c.execute(
                        "UPDATE bank.business_payments SET status = 'refused', refusal_code = $1 \
                         WHERE id = $2::text::uuid AND status = 'sending'",
                        &[&code, &row.id],
                    )
                    .map_err(|e| pg(&e))
                })?;
            }
            return Err(err);
        }
    };
    with(d.store, |c| {
        c.execute(
            &format!(
                "UPDATE bank.business_payments SET status = 'sent', partner_move_id = $1, sent_at = {} \
                 WHERE id = $3::text::uuid AND status = 'sending'",
                at("$2")
            ),
            &[&m.id, &m.moved_at.0, &row.id],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Team spend and departments

fn department_json(id: &str, name: &str, budget: Option<Amount>) -> Json {
    Json::obj([
        ("id", Json::str(id)),
        ("name", Json::str(name)),
        (
            "budget",
            budget.map_or(Json::Null, |b| Json::str(format_amount(b))),
        ),
    ])
}

/// `addDepartment`.
pub fn add_department(
    d: &Deps<'_>,
    account_id: &str,
    actor: &str,
    department_id: &str,
    raw_name: &str,
    budget: Option<Amount>,
) -> Result<Json, Refusal> {
    let name = js_trim(raw_name);
    if name.is_empty() || js_len(name) > 64 {
        return Err(refuse(
            "bank.business_invalid_name",
            "A department needs a name of 1 to 64 characters.",
        ));
    }
    if budget.is_some_and(|b| b <= Amount::ZERO) {
        return Err(refuse(
            "bank.business_budget_invalid",
            "A budget is above zero, or left blank for none.",
        ));
    }
    in_tx(d.store, |tx| {
        active_account(tx, account_id)?;
        member(tx, account_id, actor)?.need("manage_team")?;
        let text = budget.map(format_amount);
        // No conflict target: a clash on either key (the id, or the name within the business) is absorbed, so a
        // concurrent retry of this id reads the row that won. No row under this id then means the name is taken.
        tx.execute(
            "INSERT INTO bank.business_departments (id, account_id, name, budget) \
             VALUES ($1::text::uuid, $2::text::uuid, $3, $4::text::numeric) ON CONFLICT DO NOTHING",
            &[&department_id, &account_id, &name, &text],
        )
        .map_err(|e| pg(&e))?;
        let rows = tx
            .query(
                "SELECT id::text, account_id::text, name, budget::text FROM bank.business_departments \
                 WHERE id = $1::text::uuid",
                &[&department_id],
            )
            .map_err(|e| pg(&e))?;
        let Some(r) = rows.first() else {
            return Err(refuse(
                "bank.business_role_name_taken",
                format!("This business already has a department named {name}."),
            ));
        };
        let held = get_o(r, 3)?.map(|b| amount(&b)).transpose()?;
        let same = get_s(r, 1)? == account_id && get_s(r, 2)? == name && held == budget;
        if !same {
            return Err(conflict("department"));
        }
        Ok(department_json(&get_s(r, 0)?, &get_s(r, 2)?, held))
    })
}

/// `setDepartment`.
pub fn set_department(
    d: &Deps<'_>,
    account_id: &str,
    actor: &str,
    user_id: &str,
    department_id: Option<&str>,
) -> Result<Json, Refusal> {
    in_tx(d.store, |tx| {
        member(tx, account_id, actor)?.need("manage_team")?;
        if member_or_none(tx, account_id, user_id)?.is_none() {
            return Err(not_member());
        }
        if let Some(dep) = department_id.filter(|d| !d.is_empty()) {
            let found = tx
                .query(
                    "SELECT 1 FROM bank.business_departments WHERE id = $1::text::uuid AND account_id = $2::text::uuid",
                    &[&dep, &account_id],
                )
                .map_err(|e| pg(&e))?;
            if found.is_empty() {
                return Err(refuse(
                    "bank.business_department_not_found",
                    "This business has no such department.",
                ));
            }
        }
        tx.execute(
            "UPDATE bank.business_members SET department_id = $1::text::uuid \
             WHERE account_id = $2::text::uuid AND user_id = $3",
            &[&department_id, &account_id, &user_id],
        )
        .map_err(|e| pg(&e))?;
        let row = member(tx, account_id, user_id)?;
        Ok(row.json(&handles(d, &[user_id.to_owned()])?))
    })
}

/// `spend` (BK-biz-04): what each member's payments took out, from the partner's own lines for the business, beside the
/// business's record. With `team_spend` the whole team and its departments; without it, the caller's own line only.
pub fn spend(d: &Deps<'_>, account_id: &str, user_id: &str) -> Result<Json, Refusal> {
    let (a, me) = with(d.store, |c| {
        Ok((account(c, account_id)?, member(c, account_id, user_id)?))
    })?;
    let team = me.holds("team_spend");
    let partner = partner_for(d, &a).ok_or_else(no_partner)?;
    let owner = format!("business:{account_id}");
    let lines = partner.moves(
        &owner,
        &MovesQuery {
            limit: 200,
            asset_id: Some(a.asset_id.clone()),
            ..MovesQuery::default()
        },
    );
    let (paid, rows) = with(d.store, |c| {
        let paid = c
            .query(
                "SELECT maker_user_id, amount::text, status, partner_key FROM bank.business_payments \
                 WHERE account_id = $1::text::uuid",
                &[&account_id],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(|r| Ok((get_s(r, 0)?, amount(&get_s(r, 1)?)?, get_s(r, 2)?, get_s(r, 3)?)))
            .collect::<Result<Vec<_>, Refusal>>()?;
        Ok((paid, member_rows(c, account_id)?))
    })?;
    let by_key: BTreeMap<&str, &str> = paid.iter().map(|p| (p.3.as_str(), p.0.as_str())).collect();
    let shown: Vec<&MemberRow> = rows
        .iter()
        .filter(|r| team || r.user_id == user_id)
        .collect();
    let ids: Vec<String> = shown.iter().map(|r| r.user_id.clone()).collect();
    let names = handles(d, &ids)?;
    let mut totals: Vec<(String, Option<String>, Amount)> = Vec::new();
    let members: Vec<Json> = shown
        .iter()
        .map(|row| {
            let mut partner_total = Amount::ZERO;
            let mut partner_lines: i64 = 0;
            for line in &lines {
                let Some(maker) = by_key.get(line.key.as_str()) else {
                    continue;
                };
                if *maker != row.user_id || line.from.user_id != owner {
                    continue;
                }
                partner_total += line.amount;
                partner_lines += 1;
            }
            let mut record_total = Amount::ZERO;
            for p in paid.iter().filter(|p| p.0 == row.user_id && p.2 == "sent") {
                record_total += p.1;
            }
            totals.push((
                row.user_id.clone(),
                row.department_id.clone(),
                partner_total,
            ));
            Json::obj([
                ("userId", Json::str(row.user_id.clone())),
                (
                    "handle",
                    Json::str(names.get(&row.user_id).cloned().unwrap_or_default()),
                ),
                ("departmentId", opt(row.department_id.as_deref())),
                ("partnerTotal", Json::str(format_amount(partner_total))),
                ("partnerLines", Json::int(partner_lines)),
                ("recordTotal", Json::str(format_amount(record_total))),
            ])
        })
        .collect();
    let departments = if team {
        let deps = with(d.store, |c| {
            c.query(
                "SELECT id::text, name, budget::text FROM bank.business_departments \
                 WHERE account_id = $1::text::uuid ORDER BY created_at ASC, id ASC",
                &[&account_id],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(|r| {
                Ok((
                    get_s(r, 0)?,
                    get_s(r, 1)?,
                    get_o(r, 2)?.map(|b| amount(&b)).transpose()?,
                ))
            })
            .collect::<Result<Vec<_>, Refusal>>()
        })?;
        deps.iter()
            .map(|(id, name, budget)| {
                let in_it: Vec<&(String, Option<String>, Amount)> = totals
                    .iter()
                    .filter(|t| t.1.as_deref() == Some(id.as_str()))
                    .collect();
                let mut spent = Amount::ZERO;
                for t in &in_it {
                    spent += t.2;
                }
                Json::obj([
                    ("id", Json::str(id.clone())),
                    ("name", Json::str(name.clone())),
                    (
                        "budget",
                        budget.map_or(Json::Null, |b| Json::str(format_amount(b))),
                    ),
                    ("spent", Json::str(format_amount(spent))),
                    (
                        "members",
                        Json::Array(in_it.iter().map(|t| Json::str(t.0.clone())).collect()),
                    ),
                ])
            })
            .collect()
    } else {
        Vec::new()
    };
    Ok(Json::obj([
        ("scope", Json::str(if team { "team" } else { "self" })),
        ("assetId", Json::str(a.asset_id.clone())),
        ("partnerLabel", Json::str(partner.label())),
        ("members", Json::Array(members)),
        ("departments", Json::Array(departments)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(over: &str, payee: Option<&str>, kind: Option<&str>, approvals: i64) -> Rule {
        Rule {
            over_amount: parse_amount(over).unwrap_or(Amount::ZERO),
            payee: payee.map(str::to_owned),
            payment_type: kind.map(str::to_owned),
            approvals,
        }
    }

    fn amt(s: &str) -> Amount {
        parse_amount(s).unwrap_or(Amount::ZERO)
    }

    /// `the rule that applies is the one asking the most approvals, by payee and payment type`.
    #[test]
    fn the_rule_that_applies_asks_the_most_approvals_by_payee_and_type() {
        let rules = [
            rule("1000", None, None, 1),
            rule("5000", None, None, 2),
            rule("100", Some("TEST Lawyer"), Some("international"), 3),
        ];
        assert_eq!(pick_rule(&rules, amt("6000"), "x", "domestic"), Some(1));
        assert_eq!(pick_rule(&rules, amt("1000"), "x", "domestic"), None);
        assert_eq!(
            pick_rule(&rules, amt("200"), "test lawyer", "international"),
            Some(2)
        );
        assert_eq!(
            pick_rule(&rules, amt("200"), "test lawyer", "domestic"),
            None
        );
    }

    /// `the roles a named role fits`.
    #[test]
    fn the_roles_a_named_role_fits() {
        assert_eq!(fitted_role(&["view", "export"]), "viewer");
        assert_eq!(fitted_role(&["view", "approve"]), "checker");
        assert_eq!(fitted_role(&["view", "propose", "export"]), "maker");
        assert_eq!(
            fitted_role(&["view", "propose", "approve", "manage_team"]),
            "non_signing_admin"
        );
        assert_eq!(fitted_role(&PERMISSIONS), "non_signing_admin");
    }

    #[test]
    fn built_in_permissions_follow_the_capability_table() {
        assert_eq!(built_in_permissions("admin"), PERMISSIONS.to_vec());
        assert_eq!(built_in_permissions("checker"), vec!["view", "approve"]);
        assert_eq!(built_in_permissions("signer"), vec!["view"]);
    }

    #[test]
    fn invite_minutes_are_a_whole_number_up_to_thirty_days() {
        assert_eq!(parse_invite_minutes(Some(" 2 ")), Some(2));
        assert_eq!(parse_invite_minutes(Some("43200")), Some(43_200));
        for raw in [
            None,
            Some(""),
            Some("0"),
            Some("02"),
            Some("43201"),
            Some("1.5"),
            Some("123456"),
            Some("-1"),
        ] {
            assert_eq!(parse_invite_minutes(raw), None, "{raw:?}");
        }
    }

    #[test]
    fn the_token_hash_is_sha256_hex() {
        assert_eq!(
            hash_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let t = new_token().unwrap_or_default();
        assert_eq!(t.len(), 32);
        assert!(token_shape(&t));
    }

    /// Every code the slice refuses with is one `errors.ts` declares.
    #[test]
    fn every_code_is_declared() {
        let src = include_str!("service.rs");
        let codes: BTreeSet<&str> = src
            .split('"')
            .skip(1)
            .step_by(2)
            .filter(|s| {
                s.starts_with("bank.")
                    && !s.starts_with("bank.business.")
                    && !s.contains(char::is_whitespace)
            })
            .collect();
        assert!(codes.len() > 30, "{codes:?}");
        for code in codes {
            assert!(
                crate::errors::BankError::new(code, "x").is_some(),
                "{code} is no BankError code"
            );
        }
    }
}
