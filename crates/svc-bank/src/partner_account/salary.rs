//! `salary.*`, `ops.salaryRails`, and the job doors `/internal/jobs/payroll-sim/{credit,reverse}` (`salary/`): salary paid
//! in by direct deposit, as `SalaryService` and `salary.router.ts` serve it.
//!
//! At launch the money is the partner bank's: the employer pays the account details the partner issued, the partner
//! credits the person's main balance, and INTAFACED's ledger posts nothing. This records what the payroll network sent,
//! keyed by the network's own id, and asks the partner for each move under a business key, reading each back once:
//!
//! - a credit is ONE pay-in at the partner, `salary:credit:<networkId>`; the same network id again changes nothing;
//! - a credit naming another account holder than the partner holds the account in is returned, crediting nothing;
//! - the person's split is their live income sorter for that currency, fixed per credit when it arrives and sent once:
//!   each leg ONE guarded partner move from the main balance into a space, `salary:split:<networkId>:<n>`;
//! - a reversal inside the owner's window first moves the split legs back (`salary:unsplit:<networkId>:<n>`), then ONE
//!   guarded move of the whole credit out to the partner's outbound account, `salary:reverse:<networkId>`.
//!
//! The intent row is written on the network id before the partner is asked; an unknown answer leaves it pending, and
//! the network's retry under the same id finishes it under the same keys, so nothing moves twice. With no payroll
//! network wired (`BANK_PAYROLL_PARTNER=none`, the default) every salary door refuses `rail.bank`. The only network is
//! the TEST stand-in (`payroll-sim`, dev or test with the TEST partner bank), which keeps its own TEST record of each
//! credit and reversal when the stack gives it a folder (`rail_records`).

use std::collections::{BTreeMap, BTreeSet};

use postgres::{GenericClient, IsolationLevel};
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, is_js_whitespace, js_trim, parse_amount};
use service_kit::schema::Value;
use service_kit::server::Response;
use service_kit::time::Instant;
use unicode_normalization::UnicodeNormalization as _;

use super::rail_records::{self, Movement, RailRecorder};
use super::{Deps, account_details, refuse};
use crate::db::{StoreError, transaction, with_client};
use crate::door::Ctx;
use crate::door::jobs::job_refuse;
use crate::errors::Refusal;
use crate::partner::custody::Held;
use crate::partner::{AccountRef, LABEL, Move, MoveRequest, TestPartner, payouts_account};

/// `PAYROLL_SIM_RAIL` and `PAYROLL_SIM_LABEL`.
pub const PAYROLL_SIM_RAIL: &str = "payroll-sim";
pub const PAYROLL_SIM_LABEL: &str = "TEST payroll network (payroll-sim)";
/// `FULL_BP`: a whole credit in basis points.
const FULL_BP: Amount = 10_000;
const DAY_MS: i64 = 86_400_000;

/// The payroll network on the stack (`PayrollPartner`): the TEST stand-in, whose credits land in the TEST partner
/// bank the door holds, and its own TEST record when the stack gave it a folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Payroll {
    pub label: &'static str,
    pub records: Option<RailRecorder>,
}

/// What this part holds, built once from the environment (`index.ts`: `payrollPartnerFor`, the reversal window, the
/// income sorter's smallest sorted credit).
pub struct Wiring {
    /// `None` when no payroll network is wired.
    pub payroll: Option<Payroll>,
    /// `BANK_DIRECT_DEPOSIT_REVERSAL_DAYS`: the owner's window. Blank refuses every reversal.
    pub reversal_days: Option<String>,
    /// `BANK_INCOME_SORTER_MIN_CREDIT`: the owner's smallest credit that is split. Blank splits nothing.
    pub min_credit: Option<String>,
}

impl Wiring {
    /// `payrollPartnerFor(env.BANK_PAYROLL_PARTNER, testPartner, rawEnv, recordsDir)`: refuses to start as it does.
    pub fn from_env(env: &BTreeMap<String, String>) -> Result<Wiring, String> {
        let raw = |k: &str| env.get(k).map(String::as_str);
        let dev_or_test =
            matches!(raw("APP_ENV"), Some("dev" | "test")) && raw("NODE_ENV") != Some("production");
        let records_dir = raw("BANK_PAYROLL_SIM_RECORDS_DIR")
            .map(js_trim)
            .filter(|d| !d.is_empty());
        if let Some(dir) = records_dir
            && (!dev_or_test || !rail_records::is_absolute(dir))
        {
            return Err("bank.payroll_sim_records_outside_dev_test: BANK_PAYROLL_SIM_RECORDS_DIR is the local-test stack's records folder; it is an absolute path and is set only with APP_ENV exactly dev or test.".to_owned());
        }
        let payroll = if raw("BANK_PAYROLL_PARTNER") == Some("payroll-sim") {
            if !dev_or_test {
                return Err("bank.payroll_sim_outside_dev_test: BANK_PAYROLL_PARTNER=payroll-sim is a local-test stand-in that pays nobody; it runs only with APP_ENV exactly dev or test.".to_owned());
            }
            // `testPartnerFor`: the TEST partner exists exactly when it is chosen (it refuses to start elsewhere).
            if raw("BANK_TEST_PARTNER") != Some("test") {
                return Err("bank.payroll_sim_needs_test_partner: BANK_PAYROLL_PARTNER=payroll-sim credits the TEST partner bank, so it needs BANK_TEST_PARTNER=test.".to_owned());
            }
            Some(Payroll {
                label: PAYROLL_SIM_LABEL,
                records: records_dir.map(|d| RailRecorder::new(d, PAYROLL_SIM_RAIL)),
            })
        } else {
            None
        };
        Ok(Wiring {
            payroll,
            reversal_days: env.get("BANK_DIRECT_DEPOSIT_REVERSAL_DAYS").cloned(),
            min_credit: env.get("BANK_INCOME_SORTER_MIN_CREDIT").cloned(),
        })
    }
}

/// What a salary step fails with: a refusal, or the database's own error (a job door answers it as Fastify does).
#[derive(Debug)]
enum Fail {
    Refused(Refusal),
    Store(StoreError),
}

impl From<Refusal> for Fail {
    fn from(r: Refusal) -> Fail {
        Fail::Refused(r)
    }
}

impl From<StoreError> for Fail {
    fn from(e: StoreError) -> Fail {
        Fail::Store(e)
    }
}

impl Fail {
    fn refusal(self) -> Refusal {
        match self {
            Fail::Refused(r) => r,
            Fail::Store(e) => Refusal::Other(e.message),
        }
    }

    fn bank_code(&self) -> Option<&'static str> {
        match self {
            Fail::Refused(Refusal::Bank(e)) => Some(e.row.code),
            _ => None,
        }
    }
}

type Step<T> = Result<T, Fail>;

/// `creditKey`, `splitKey`, `unsplitKey`, `reverseKey`: the business keys of each partner move.
pub fn credit_key(network_id: &str) -> String {
    format!("salary:credit:{network_id}")
}
pub fn split_key(network_id: &str, position: i16) -> String {
    format!("salary:split:{network_id}:{position}")
}
pub fn unsplit_key(network_id: &str, position: i16) -> String {
    format!("salary:unsplit:{network_id}:{position}")
}
pub fn reverse_key(network_id: &str) -> String {
    format!("salary:reverse:{network_id}")
}

/// `holderNameKey`: a name as a bank compares it; case, spacing and surrounding blanks do not count.
pub fn holder_name_key(name: &str) -> String {
    let normal: String = name.nfkc().collect();
    let mut out = String::new();
    let mut blank = false;
    for c in js_trim(&normal).chars() {
        if is_js_whitespace(c) {
            if !blank {
                out.push(' ');
            }
            blank = true;
        } else {
            out.push(c);
            blank = false;
        }
    }
    out.to_lowercase()
}

/// `parseReversalDays`: whole days from 1 to 3650, else unpublished.
pub fn parse_reversal_days(raw: Option<&str>) -> Option<i64> {
    let v = raw.map(js_trim).unwrap_or_default();
    if v.is_empty() || v.len() > 4 || !v.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    v.parse::<i64>().ok().filter(|d| (1..=3650).contains(d))
}

/// `parseMinCredit`: the owner's smallest sorted credit; blank or not a non-negative decimal is no decision.
fn parse_min_credit(raw: Option<&str>) -> Option<Amount> {
    let v = raw.map(js_trim).filter(|v| !v.is_empty())?;
    let (whole, frac) = v.split_once('.').map_or((v, None), |(w, f)| (w, Some(f)));
    let ok = !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && frac
            .is_none_or(|f| (1..=18).contains(&f.len()) && f.bytes().all(|b| b.is_ascii_digit()));
    if ok { parse_amount(v).ok() } else { None }
}

/// One split leg (`SalaryLeg`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Leg {
    pub position: i16,
    pub space_id: String,
    pub amount: Amount,
    pub status: String,
    pub move_id: Option<String>,
    pub rejection_code: Option<String>,
    pub unsplit_move_id: Option<String>,
}

/// One salary credit (`SalaryCredit`), its legs in position order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credit {
    pub network_id: String,
    pub user_id: String,
    pub account_details_id: String,
    pub asset_id: String,
    pub amount: Amount,
    pub originator_name: String,
    pub holder_name: String,
    pub state: String,
    pub refusal_code: Option<String>,
    pub credit_move_id: Option<String>,
    pub reversal_move_id: Option<String>,
    pub created_at: Instant,
    pub received_at: Option<Instant>,
    pub reversed_at: Option<Instant>,
    pub legs: Vec<Leg>,
}

fn opt(v: Option<&str>) -> Json {
    v.map_or(Json::Null, Json::str)
}

impl Credit {
    /// `creditView`, in `salaryCreditView`'s order.
    pub fn view(&self) -> Json {
        let at = |t: Option<Instant>| t.map_or(Json::Null, |t| Json::str(t.iso()));
        Json::obj([
            ("networkId", Json::str(&self.network_id)),
            ("assetId", Json::str(&self.asset_id)),
            ("amount", Json::str(format_amount(self.amount))),
            ("originatorName", Json::str(&self.originator_name)),
            ("state", Json::str(&self.state)),
            ("refusalCode", opt(self.refusal_code.as_deref())),
            ("creditMoveId", opt(self.credit_move_id.as_deref())),
            ("reversalMoveId", opt(self.reversal_move_id.as_deref())),
            ("createdAt", Json::str(self.created_at.iso())),
            ("receivedAt", at(self.received_at)),
            ("reversedAt", at(self.reversed_at)),
            (
                "legs",
                Json::Array(
                    self.legs
                        .iter()
                        .map(|l| {
                            Json::obj([
                                ("position", Json::int(i64::from(l.position))),
                                ("spaceId", Json::str(&l.space_id)),
                                ("amount", Json::str(format_amount(l.amount))),
                                ("status", Json::str(&l.status)),
                                ("moveId", opt(l.move_id.as_deref())),
                                ("rejectionCode", opt(l.rejection_code.as_deref())),
                                ("unsplitMoveId", opt(l.unsplit_move_id.as_deref())),
                            ])
                        })
                        .collect(),
                ),
            ),
        ])
    }
}

/// `salaryView`: the job doors' answer.
fn salary_view(credit: &Credit, replayed: bool) -> Json {
    Json::obj([
        ("credit", credit.view()),
        ("replayed", Json::Bool(replayed)),
    ])
}

const CREDIT_COLS: &str = "network_id, user_id, account_details_id, asset_id, amount::text, originator_name, holder_name, \
    state, refusal_code, credit_move_id, reversal_move_id, floor(extract(epoch FROM created_at) * 1000)::bigint, \
    floor(extract(epoch FROM received_at) * 1000)::bigint, floor(extract(epoch FROM reversed_at) * 1000)::bigint";
const LEG_COLS: &str = "network_id, position, space_id::text, amount::text, status, move_id, rejection_code, unsplit_move_id";

fn amount_of(text: &str) -> Result<Amount, StoreError> {
    parse_amount(text).map_err(|e| StoreError::new(e, None))
}

fn store_err(e: &postgres::Error) -> StoreError {
    StoreError::from(e)
}

fn credit_row(r: &postgres::Row) -> Result<Credit, StoreError> {
    let at = |i: usize| {
        r.try_get::<_, Option<i64>>(i)
            .map(|v| v.map(Instant))
            .map_err(|e| store_err(&e))
    };
    Ok(Credit {
        network_id: r.try_get(0).map_err(|e| store_err(&e))?,
        user_id: r.try_get(1).map_err(|e| store_err(&e))?,
        account_details_id: r.try_get(2).map_err(|e| store_err(&e))?,
        asset_id: r.try_get(3).map_err(|e| store_err(&e))?,
        amount: amount_of(r.try_get(4).map_err(|e| store_err(&e))?)?,
        originator_name: r.try_get(5).map_err(|e| store_err(&e))?,
        holder_name: r.try_get(6).map_err(|e| store_err(&e))?,
        state: r.try_get(7).map_err(|e| store_err(&e))?,
        refusal_code: r.try_get(8).map_err(|e| store_err(&e))?,
        credit_move_id: r.try_get(9).map_err(|e| store_err(&e))?,
        reversal_move_id: r.try_get(10).map_err(|e| store_err(&e))?,
        created_at: at(11)?.unwrap_or(Instant(0)),
        received_at: at(12)?,
        reversed_at: at(13)?,
        legs: Vec::new(),
    })
}

fn leg_row(r: &postgres::Row) -> Result<(String, Leg), StoreError> {
    Ok((
        r.try_get(0).map_err(|e| store_err(&e))?,
        Leg {
            position: r.try_get(1).map_err(|e| store_err(&e))?,
            space_id: r.try_get(2).map_err(|e| store_err(&e))?,
            amount: amount_of(r.try_get(3).map_err(|e| store_err(&e))?)?,
            status: r.try_get(4).map_err(|e| store_err(&e))?,
            move_id: r.try_get(5).map_err(|e| store_err(&e))?,
            rejection_code: r.try_get(6).map_err(|e| store_err(&e))?,
            unsplit_move_id: r.try_get(7).map_err(|e| store_err(&e))?,
        },
    ))
}

/// `toCredit`: each credit with its own legs, by position.
fn with_legs(mut credits: Vec<Credit>, legs: Vec<(String, Leg)>) -> Vec<Credit> {
    for c in &mut credits {
        c.legs = legs
            .iter()
            .filter(|(n, _)| *n == c.network_id)
            .map(|(_, l)| l.clone())
            .collect();
        c.legs.sort_by_key(|l| l.position);
    }
    credits
}

fn legs_of(c: &mut impl GenericClient, ids: &[String]) -> Result<Vec<(String, Leg)>, StoreError> {
    c.query(
        &format!("SELECT {LEG_COLS} FROM bank.salary_split_legs WHERE network_id = ANY($1)"),
        &[&ids],
    )?
    .iter()
    .map(leg_row)
    .collect()
}

/// `read`: one credit by its network id.
fn read(d: &Deps<'_>, network_id: &str) -> Result<Option<Credit>, StoreError> {
    with_client(d.store.pool()?, |c| {
        let rows = c.query(
            &format!("SELECT {CREDIT_COLS} FROM bank.salary_credits WHERE network_id = $1"),
            &[&network_id],
        )?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let credit = credit_row(row)?;
        let legs = legs_of(c, &[network_id.to_owned()])?;
        Ok(with_legs(vec![credit], legs).pop())
    })
}

fn read_known(d: &Deps<'_>, network_id: &str) -> Step<Credit> {
    read(d, network_id)?.ok_or_else(|| {
        Fail::Store(StoreError::new(
            format!("salary credit {network_id} is gone"),
            None,
        ))
    })
}

/// `list`: the person's credits that are not pending, newest first, each with its split.
pub fn list(d: &Deps<'_>, user_id: &str, limit: i64) -> Result<Vec<Credit>, StoreError> {
    with_client(d.store.pool()?, |c| {
        let rows = c.query(
            &format!(
                "SELECT {CREDIT_COLS} FROM bank.salary_credits WHERE user_id = $1 AND state <> 'pending' \
                 ORDER BY created_at DESC, network_id DESC LIMIT $2"
            ),
            &[&user_id, &limit],
        )?;
        let credits = rows.iter().map(credit_row).collect::<Result<Vec<_>, _>>()?;
        if credits.is_empty() {
            return Ok(credits);
        }
        let ids: Vec<String> = credits.iter().map(|c| c.network_id.clone()).collect();
        let legs = legs_of(c, &ids)?;
        Ok(with_legs(credits, legs))
    })
}

fn rail_bank() -> Refusal {
    refuse(
        "rail.bank",
        "Salary paid in by direct deposit needs rail.bank. It is switched off in this build.",
    )
}

/// `payroll()`: the network and the TEST partner bank its credits land in, or `rail.bank`. A door built without the
/// TEST partner has no network, whatever the environment chose.
fn payroll<'a>(d: &'a Deps<'_>) -> Result<(&'a Payroll, &'a TestPartner), Refusal> {
    match (d.wiring.salary.payroll.as_ref(), d.partner.partner.as_ref()) {
        (Some(p), Some(partner)) => Ok((p, partner)),
        _ => Err(rail_bank()),
    }
}

/// `partnerBank`: the person's guarded partner bank (the stop, then the freeze, before each move).
fn partner_bank<'a>(
    custody: &'a crate::partner::custody::Custody<'a>,
    user_id: &str,
) -> Result<Held<'a>, Refusal> {
    custody.bank_for(user_id).ok_or_else(|| {
        refuse(
            "bank.partner_unset",
            "This person’s bank money is not held at the partner bank, so nothing can move there. Nothing moved.",
        )
    })
}

/// `readBack`: a move the partner says it made, read back once by its key: the same id and amount, or refused.
fn read_back(held: &Held<'_>, key: &str, made: &Move) -> Result<Move, Refusal> {
    match held.move_by_key(key) {
        Some(back) if back.id == made.id && back.amount == made.amount => Ok(back),
        _ => Err(refuse(
            "bank.partner_reply_lost",
            "The partner bank did not read back the move it reported, so the outcome is not known. The network may retry with the same id.",
        )),
    }
}

fn record(payroll: &Payroll, m: Movement) -> Step<()> {
    match &payroll.records {
        Some(r) => r
            .record(&m)
            .map_err(|e| Fail::Refused(Refusal::Other(e.message))),
        None => Ok(()),
    }
}

/// A partner refusal that proves nothing moved: the leg is rejected with it.
const DEFINITE_PARTNER_REFUSALS: [&str; 6] = [
    "bank.partner_insufficient_funds",
    "bank.partner_amount_invalid",
    "bank.asset_mismatch",
    "bank.same_space",
    "bank.account_restricted",
    "bank.partner_move_conflict",
];

fn main_of(user_id: &str, asset_id: &str) -> AccountRef {
    AccountRef {
        user_id: user_id.to_owned(),
        asset_id: asset_id.to_owned(),
        space_id: None,
    }
}

fn ms_param(t: Instant) -> i64 {
    t.0
}

/// `detailsOwner` (`testPartnerDetailsOwner`): whose TEST account details an id names, while the TEST partner issues them.
fn details_owner(partner: &TestPartner, details_id: &str) -> Option<(String, String)> {
    let rest = details_id.strip_prefix("test-partner:")?;
    let (user, currency) = rest.rsplit_once(':')?;
    let user_ok = (1..=64).contains(&js_len(user)) && !user.contains(':');
    let currency_ok = currency.len() == 3 && currency.bytes().all(|b| b.is_ascii_uppercase());
    (user_ok && currency_ok && partner.switches(user).account_details == "issued")
        .then(|| (user.to_owned(), currency.to_owned()))
}

/// The network's credit (`PayrollCredit`), held to `payrollCreditBody`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayrollCredit {
    pub network_id: String,
    pub account_details_id: String,
    pub amount: String,
    pub currency: String,
    pub originator_name: String,
    pub holder_name: String,
}

fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `networkId`: `/^[A-Za-z0-9:._-]{1,128}$/`.
fn network_id_ok(s: &str) -> bool {
    (1..=128).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'.' | b'_' | b'-'))
}

/// `decimal`: `/^\d{1,20}(\.\d{1,18})?$/`.
fn decimal_ok(s: &str) -> bool {
    let (whole, frac) = s.split_once('.').map_or((s, None), |(w, f)| (w, Some(f)));
    (1..=20).contains(&whole.len())
        && whole.bytes().all(|b| b.is_ascii_digit())
        && frac.is_none_or(|f| (1..=18).contains(&f.len()) && f.bytes().all(|b| b.is_ascii_digit()))
}

/// A strict object's string fields, when it holds exactly `keys`, each a string.
fn strict_strings<'a>(body: &'a Value, keys: &[&str]) -> Option<Vec<&'a str>> {
    let Value::Object(fields) = body else {
        return None;
    };
    if fields.iter().any(|(k, _)| !keys.contains(&k.as_str())) {
        return None;
    }
    keys.iter().map(|k| body.get(k).as_str()).collect()
}

/// `payrollCreditBody.safeParse(req.body ?? {})`: the parsed credit, names trimmed, or not in shape.
pub fn credit_body(body: &Value) -> Option<PayrollCredit> {
    let [network_id, details, amount, currency, originator, holder] =
        <[&str; 6]>::try_from(strict_strings(
            body,
            &[
                "networkId",
                "accountDetailsId",
                "amount",
                "currency",
                "originatorName",
                "holderName",
            ],
        )?)
        .ok()?;
    let name = |s: &str| {
        let t = js_trim(s);
        (1..=140).contains(&js_len(t)).then(|| t.to_owned())
    };
    let ok = network_id_ok(network_id)
        && (1..=256).contains(&js_len(details))
        && decimal_ok(amount)
        && currency.len() == 3
        && currency.bytes().all(|b| b.is_ascii_uppercase());
    let (originator_name, holder_name) = (name(originator)?, name(holder)?);
    ok.then(|| PayrollCredit {
        network_id: network_id.to_owned(),
        account_details_id: details.to_owned(),
        amount: amount.to_owned(),
        currency: currency.to_owned(),
        originator_name,
        holder_name,
    })
}

/// `payrollReverseBody.safeParse(req.body ?? {})`.
pub fn reverse_body(body: &Value) -> Option<String> {
    let [network_id] = <[&str; 1]>::try_from(strict_strings(body, &["networkId"])?).ok()?;
    network_id_ok(network_id).then(|| network_id.to_owned())
}

/// BK-salary-03: the network's credit. The same network id again finishes what is unfinished under the same keys and
/// otherwise changes nothing (`replayed`); the same id with other facts refuses `bank.direct_deposit_conflict`.
fn credit(d: &Deps<'_>, input: &PayrollCredit) -> Step<(Credit, bool)> {
    let (payroll, partner) = payroll(d)?;
    let amount = parse_amount(&input.amount).map_err(Refusal::Other)?;
    if amount <= 0 {
        return Err(refuse(
            "bank.partner_amount_invalid",
            "A salary credit needs an amount above zero.",
        )
        .into());
    }
    let owner = details_owner(partner, &input.account_details_id);
    let known = match &owner {
        Some((_, currency)) if *currency == input.currency => {
            account_details::currencies(&d.wiring.account_details)?.contains(&input.currency)
        }
        _ => false,
    };
    let Some((owner, _)) = owner.filter(|_| known) else {
        return Err(refuse(
            "bank.direct_deposit_details_unknown",
            "No account details with this id take payments in this currency.",
        )
        .into());
    };
    if partner.switches(&owner).custody != "off" {
        return Err(refuse(
            "bank.partner_unset",
            "This person’s bank money is not held at the partner bank, so a direct deposit has nowhere to land. Nothing was credited.",
        )
        .into());
    }
    let pool = d.store.pool()?;
    let inserted = with_client(pool, |c| {
        Ok(!c
            .query(
                "INSERT INTO bank.salary_credits (network_id, user_id, account_details_id, asset_id, amount, originator_name, holder_name, state) \
                 VALUES ($1, $2, $3, $4, $5::text::numeric, $6, $7, 'pending') \
                 ON CONFLICT (network_id) DO NOTHING RETURNING network_id",
                &[
                    &input.network_id,
                    &owner,
                    &input.account_details_id,
                    &input.currency,
                    &format_amount(amount),
                    &input.originator_name,
                    &input.holder_name,
                ],
            )?
            .is_empty())
    })?;
    let mut row = read_known(d, &input.network_id)?;
    // `sameRequest`: the same originator, holder and details as the first.
    let same = row.account_details_id == input.account_details_id
        && row.originator_name == input.originator_name
        && row.holder_name == input.holder_name;
    if row.user_id != owner || row.asset_id != input.currency || row.amount != amount || !same {
        return Err(refuse(
            "bank.direct_deposit_conflict",
            format!(
                "The network already sent {} with other details. Nothing was changed.",
                input.network_id
            ),
        )
        .into());
    }
    let replayed = !inserted;
    if row.state == "returned" || row.state == "reversed" {
        return Ok((row, replayed));
    }
    if row.state == "pending" {
        let holder = partner.switches(&owner).holder_name;
        if holder.is_none_or(|h| holder_name_key(&h) != holder_name_key(&input.holder_name)) {
            with_client(pool, |c| {
                c.execute(
                    "UPDATE bank.salary_credits SET state = 'returned', refusal_code = 'bank.direct_deposit_name_mismatch' \
                     WHERE network_id = $1 AND state = 'pending'",
                    &[&input.network_id],
                )?;
                Ok(())
            })?;
            return Ok((read_known(d, &input.network_id)?, replayed));
        }
        let key = credit_key(&input.network_id);
        let made =
            partner
                .lock()
                .receive(&main_of(&owner, &input.currency), &key, amount, d.now)?;
        let custody = d.partner.custody(d.store);
        let back = read_back(&partner_bank(&custody, &owner)?, &key, &made)?;
        // The network's own record: it carried this credit. Same key, same facts: a retry writes nothing new.
        record(
            payroll,
            Movement {
                key,
                direction: "in",
                asset_id: input.currency.clone(),
                amount,
                reference: None,
            },
        )?;
        let min = parse_min_credit(d.wiring.salary.min_credit.as_deref());
        transaction(pool, IsolationLevel::ReadCommitted, |tx| {
            tx.execute(
                "UPDATE bank.salary_credits SET state = 'received', credit_move_id = $2, \
                 received_at = 'epoch'::timestamptz + $3::bigint * interval '1 millisecond' \
                 WHERE network_id = $1 AND state = 'pending'",
                &[&input.network_id, &back.id, &ms_param(d.now)],
            )?;
            fix_split(tx, &input.network_id, &owner, &input.currency, amount, min)
        })?;
        row = read_known(d, &input.network_id)?;
    }
    send_split(d, &row)?;
    Ok((read_known(d, &input.network_id)?, replayed))
}

/// `fixSplit`: the person's split for this currency, fixed once for this credit: each leg of their live income sorter
/// into a live space, its share rounded down; nothing below the owner's smallest sorted credit, and nothing while the
/// owner has published none. What is not split stays in the main balance.
fn fix_split(
    tx: &mut impl GenericClient,
    network_id: &str,
    user_id: &str,
    asset_id: &str,
    amount: Amount,
    min: Option<Amount>,
) -> Result<(), StoreError> {
    let Some(min) = min else { return Ok(()) };
    if amount < min {
        return Ok(());
    }
    // `IncomeSorterService.list`: the person's live sorter for the asset and its legs, each with its space.
    let sorter = tx.query(
        "SELECT id::text FROM bank.income_sorters WHERE user_id = $1 AND status = 'active' AND asset_id = $2 \
         ORDER BY asset_id LIMIT 1",
        &[&user_id, &asset_id],
    )?;
    let Some(sorter) = sorter.first() else {
        return Ok(());
    };
    let sorter_id: String = sorter.try_get(0).map_err(|e| store_err(&e))?;
    let legs = tx.query(
        "SELECT l.space_id::text, l.share_bp, sp.archived_at IS NOT NULL FROM bank.income_sorter_legs l \
           JOIN bank.spaces sp ON sp.id = l.space_id \
          WHERE l.sorter_id = $1::text::uuid ORDER BY l.position",
        &[&sorter_id],
    )?;
    for (position, leg) in legs.iter().enumerate() {
        let space_id: String = leg.try_get(0).map_err(|e| store_err(&e))?;
        let share_bp: i32 = leg.try_get(1).map_err(|e| store_err(&e))?;
        let archived: bool = leg.try_get(2).map_err(|e| store_err(&e))?;
        if archived {
            continue;
        }
        // `legShare`: bigint division, rounded toward zero.
        let share = amount.saturating_mul(Amount::from(share_bp)) / FULL_BP;
        if share <= 0 {
            continue;
        }
        let position = i16::try_from(position).map_err(|e| StoreError::new(e.to_string(), None))?;
        tx.execute(
            "INSERT INTO bank.salary_split_legs (network_id, position, space_id, amount) \
             VALUES ($1, $2, $3::text::uuid, $4::text::numeric) ON CONFLICT (network_id, position) DO NOTHING",
            &[&network_id, &position, &space_id, &format_amount(share)],
        )?;
    }
    Ok(())
}

/// `sendSplit`: each pending leg sent to the partner once under its key, and the partner's answer recorded, read back.
fn send_split(d: &Deps<'_>, credit: &Credit) -> Step<()> {
    let custody = d.partner.custody(d.store);
    let held = partner_bank(&custody, &credit.user_id)?;
    let pool = d.store.pool()?;
    for leg in credit.legs.iter().filter(|l| l.status == "pending") {
        let key = split_key(&credit.network_id, leg.position);
        let sent = held
            .move_(
                &MoveRequest {
                    key: key.clone(),
                    from: main_of(&credit.user_id, &credit.asset_id),
                    to: AccountRef {
                        space_id: Some(leg.space_id.clone()),
                        ..main_of(&credit.user_id, &credit.asset_id)
                    },
                    amount: leg.amount,
                    payees: None,
                },
                d.now,
            )
            .map_err(Fail::from)
            .and_then(|made| Ok(read_back(&held, &key, &made)?))
            .and_then(|back| {
                with_client(pool, |c| {
                    c.execute(
                        "UPDATE bank.salary_split_legs SET status = 'settled', move_id = $3 \
                         WHERE network_id = $1 AND position = $2 AND status = 'pending'",
                        &[&credit.network_id, &leg.position, &back.id],
                    )?;
                    Ok(())
                })
                .map_err(Fail::from)
            });
        match sent {
            Ok(()) => {}
            Err(f)
                if f.bank_code()
                    .is_some_and(|c| DEFINITE_PARTNER_REFUSALS.contains(&c)) =>
            {
                let code = f.bank_code().unwrap_or_default();
                with_client(pool, |c| {
                    c.execute(
                        "UPDATE bank.salary_split_legs SET status = 'rejected', rejection_code = $3 \
                         WHERE network_id = $1 AND position = $2 AND status = 'pending'",
                        &[&credit.network_id, &leg.position, &code],
                    )?;
                    Ok(())
                })?;
            }
            // Not known whether it moved: the leg stays pending and the network's retry sends it again under the same key.
            Err(f) => return Err(f),
        }
    }
    Ok(())
}

/// BK-salary-03: the employer's reversal of a credit, inside the owner's window. Split legs come back first, then the
/// whole credit leaves once. Asked again, it answers the reversal already made.
fn reverse(d: &Deps<'_>, network_id: &str) -> Step<Credit> {
    let (payroll, _) = payroll(d)?;
    let Some(credit) = read(d, network_id)? else {
        return Err(refuse(
            "bank.direct_deposit_not_found",
            "The network carried no credit with this id.",
        )
        .into());
    };
    if credit.state == "reversed" {
        return Ok(credit);
    }
    let Some(received_at) = credit.received_at.filter(|_| credit.state == "received") else {
        return Err(refuse(
            "bank.direct_deposit_not_received",
            "Only a credit the account received can be reversed. Nothing moved.",
        )
        .into());
    };
    let Some(days) = parse_reversal_days(d.wiring.salary.reversal_days.as_deref()) else {
        return Err(refuse(
            "bank.direct_deposit_reversal_window_unset",
            "The owner has not published how long an employer may reverse a salary credit, so none is reversed.",
        )
        .into());
    };
    if d.now.0 > received_at.0.saturating_add(days.saturating_mul(DAY_MS)) {
        return Err(refuse(
            "bank.direct_deposit_reversal_window",
            format!("The {days}-day window to reverse this credit has passed. Nothing moved."),
        )
        .into());
    }
    send_split(d, &credit)?;
    let custody = d.partner.custody(d.store);
    let held = partner_bank(&custody, &credit.user_id)?;
    let settled = read_known(d, network_id)?;
    let main = main_of(&credit.user_id, &credit.asset_id);
    let pool = d.store.pool()?;
    for leg in settled.legs.iter().filter(|l| l.status == "settled") {
        let key = unsplit_key(network_id, leg.position);
        let made = match held.move_(
            &MoveRequest {
                key: key.clone(),
                from: AccountRef {
                    space_id: Some(leg.space_id.clone()),
                    ..main.clone()
                },
                to: main.clone(),
                amount: leg.amount,
                payees: None,
            },
            d.now,
        ) {
            Ok(m) => m,
            // The space no longer holds its share: it stays there, and the main balance below decides the reversal.
            Err(Refusal::Bank(e)) if e.row.code == "bank.partner_insufficient_funds" => continue,
            Err(e) => return Err(e.into()),
        };
        let back = read_back(&held, &key, &made)?;
        with_client(pool, |c| {
            c.execute(
                "UPDATE bank.salary_split_legs SET status = 'unsplit', unsplit_move_id = $3 \
                 WHERE network_id = $1 AND position = $2 AND status = 'settled'",
                &[&network_id, &leg.position, &back.id],
            )?;
            Ok(())
        })?;
    }
    let key = reverse_key(network_id);
    let made = match held.move_(
        &MoveRequest {
            key: key.clone(),
            from: main,
            to: payouts_account(&credit.asset_id),
            amount: credit.amount,
            payees: None,
        },
        d.now,
    ) {
        Ok(m) => m,
        Err(Refusal::Bank(e)) if e.row.code == "bank.partner_insufficient_funds" => {
            return Err(refuse(
                "bank.direct_deposit_reversal_insufficient",
                "The account no longer holds the amount the employer asks back, so the reversal was refused. Nothing more moved.",
            )
            .into());
        }
        Err(e) => return Err(e.into()),
    };
    let back = read_back(&held, &key, &made)?;
    record(
        payroll,
        Movement {
            key,
            direction: "out",
            asset_id: credit.asset_id.clone(),
            amount: credit.amount,
            reference: None,
        },
    )?;
    with_client(pool, |c| {
        c.execute(
            "UPDATE bank.salary_credits SET state = 'reversed', reversal_move_id = $2, \
             reversed_at = 'epoch'::timestamptz + $3::bigint * interval '1 millisecond' \
             WHERE network_id = $1 AND state = 'received'",
            &[&network_id, &back.id, &ms_param(d.now)],
        )?;
        Ok(())
    })?;
    read_known(d, network_id)
}

/// BK-salary-03, the founders' rail desk (`rails` with `railsView`): per currency, the network's own credits minus
/// reversals against what the app showed. `partner: null` when no payroll network is wired.
fn rails(d: &Deps<'_>) -> Step<Json> {
    let Ok((payroll, _)) = payroll(d) else {
        return Ok(Json::obj([("partner", Json::Null)]));
    };
    let app: Vec<(String, Amount, Amount)> = with_client(d.store.pool()?, |c| {
        c.query(
            "SELECT asset_id, \
                    COALESCE(sum(amount) FILTER (WHERE credit_move_id IS NOT NULL), 0)::text, \
                    COALESCE(sum(amount) FILTER (WHERE reversal_move_id IS NOT NULL), 0)::text \
               FROM bank.salary_credits GROUP BY asset_id",
            &[],
        )?
        .iter()
        .map(|r| {
            Ok((
                r.try_get::<_, String>(0).map_err(|e| store_err(&e))?,
                amount_of(r.try_get(1).map_err(|e| store_err(&e))?)?,
                amount_of(r.try_get(2).map_err(|e| store_err(&e))?)?,
            ))
        })
        .collect()
    })?;
    let movements = match &payroll.records {
        Some(r) => Some(r.movements().map_err(|e| Refusal::Other(e.message))?),
        None => None,
    };
    let mut network: BTreeMap<String, (Amount, Amount)> = BTreeMap::new();
    for m in movements.iter().flatten() {
        let sums = network.entry(m.asset_id.clone()).or_insert((0, 0));
        if m.direction == "in" && m.key.starts_with("salary:credit:") {
            sums.0 = sums.0.saturating_add(m.amount);
        }
        if m.direction == "out" && m.key.starts_with("salary:reverse:") {
            sums.1 = sums.1.saturating_add(m.amount);
        }
    }
    let currencies: BTreeSet<&String> = app
        .iter()
        .map(|(a, _, _)| a)
        .chain(network.keys())
        .collect();
    let pair = |c: Amount, r: Amount| {
        Json::obj([
            ("credits", Json::str(format_amount(c))),
            ("reversals", Json::str(format_amount(r))),
        ])
    };
    let lines = currencies
        .into_iter()
        .map(|currency| {
            let shown = app
                .iter()
                .find(|(a, _, _)| a == currency)
                .map_or((0, 0), |(_, c, r)| (*c, *r));
            let said = movements
                .as_ref()
                .map(|_| network.get(currency).copied().unwrap_or((0, 0)));
            let difference = said.map(|s| (s.0 - s.1) - (shown.0 - shown.1));
            Json::obj([
                ("currency", Json::str(currency)),
                ("network", said.map_or(Json::Null, |s| pair(s.0, s.1))),
                ("app", pair(shown.0, shown.1)),
                (
                    "matches",
                    difference.map_or(Json::Null, |x| Json::Bool(x == 0)),
                ),
                (
                    "difference",
                    difference.map_or(Json::Null, |x| Json::str(format_amount(x))),
                ),
            ])
        })
        .collect();
    Ok(Json::obj([(
        "partner",
        Json::obj([
            (
                "label",
                Json::str(format!("{}, {PAYROLL_SIM_RAIL}", payroll.label)),
            ),
            ("asOf", Json::str(d.now.iso())),
            ("lines", Json::Array(lines)),
        ]),
    )]))
}

/// BK-salary-01: the account details salary is paid to, per owner-listed currency, and the name the account is held in.
fn details(d: &Deps<'_>, user_id: &str) -> Result<Json, Refusal> {
    account_details::currencies(&d.wiring.account_details)?;
    let (payroll, partner) = payroll(d)?;
    let currencies = account_details::list(d, user_id)?;
    Ok(Json::obj([
        ("partnerBank", Json::str(LABEL)),
        ("network", Json::str(payroll.label)),
        (
            "holderName",
            opt(partner.switches(user_id).holder_name.as_deref()),
        ),
        (
            "currencies",
            Json::Array(
                currencies
                    .iter()
                    .map(account_details::CurrencyDetails::json)
                    .collect(),
            ),
        ),
    ]))
}

/// BK-salary-01: the employer form for one currency, as fields and as the text the person downloads.
fn form(d: &Deps<'_>, user_id: &str, currency: &str) -> Result<Json, Refusal> {
    let (_, partner) = payroll(d)?;
    let details = account_details::get(d, user_id, currency)?;
    let Some(set) = details.sets.first() else {
        return Err(rail_bank());
    };
    let Some(holder) = partner.switches(user_id).holder_name else {
        return Err(refuse(
            "bank.direct_deposit_holder_unknown",
            "The partner bank has not given the name your account is held in, so no employer form can be made.",
        ));
    };
    let reference = format!("Salary for {holder}");
    let fields: [(&str, Option<&str>); 9] = [
        ("Account holder", Some(&holder)),
        ("Bank", Some(&set.partner_bank)),
        ("Currency", Some(&details.currency)),
        ("Account number", set.account_number.as_deref()),
        ("Sort code", set.sort_code.as_deref()),
        ("Routing number", set.routing_number.as_deref()),
        ("IBAN", set.iban.as_deref()),
        ("BIC", set.bic.as_deref()),
        ("Reference", Some(&reference)),
    ];
    let mut lines = vec!["Direct deposit form".to_owned()];
    lines.extend(
        fields
            .iter()
            .filter_map(|(label, v)| v.map(|v| format!("{label}: {v}"))),
    );
    lines.extend(set.restrictions.iter().map(|r| format!("Note: {r}")));
    Ok(Json::obj([
        ("currency", Json::str(&details.currency)),
        ("holderName", Json::str(&holder)),
        ("partnerBank", Json::str(&set.partner_bank)),
        ("accountNumber", opt(set.account_number.as_deref())),
        ("sortCode", opt(set.sort_code.as_deref())),
        ("routingNumber", opt(set.routing_number.as_deref())),
        ("iban", opt(set.iban.as_deref())),
        ("bic", opt(set.bic.as_deref())),
        ("reference", Json::str(&reference)),
        ("text", Json::str(format!("{}\n", lines.join("\n")))),
    ]))
}

/// The answer of one of this part's calls, by its path; `None` for a path outside it.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let user = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    let input = &ctx.input;
    let profile = || super::profile::personal_only(d.store, user, input.get("profile").as_str());
    Some(match ctx.call.path {
        "salary.details" => profile().and_then(|()| details(d, user)),
        "salary.form" => profile()
            .and_then(|()| form(d, user, input.get("currency").as_str().unwrap_or_default())),
        "salary.credits" => {
            #[expect(
                clippy::cast_possible_truncation,
                reason = "the schema held the limit to a whole number from 1 to 100"
            )]
            let limit = input.get("limit").as_number().unwrap_or(1.0) as i64;
            list(d, user, limit)
                .map(|credits| Json::Array(credits.iter().map(Credit::view).collect()))
                .map_err(|e| Refusal::Other(e.message))
        }
        "ops.salaryRails" => rails(d).map_err(Fail::refusal),
        _ => return None,
    })
}

fn not_in_shape() -> Response {
    Response {
        status: 400,
        body: Json::obj([
            ("error", Json::str("body not in shape")),
            ("code", Json::str("bank.validation_failed")),
        ])
        .compact(),
    }
}

/// A job's failure as `jobDoor` answers it: a `BankError` is 400 (`sendBankJobRefuse`); anything else is thrown to Fastify's
/// own 500, with the database's SQLSTATE when it sent one.
fn job_failed(f: Fail) -> Response {
    let (code, message) = match f {
        Fail::Refused(Refusal::Bank(e)) => return job_refuse(&e),
        Fail::Refused(Refusal::Trpc(e)) => (None, e.message),
        Fail::Refused(Refusal::Other(m)) => (None, m),
        Fail::Store(e) => (e.code, e.message),
    };
    let body = match code {
        Some(code) => Json::obj([
            ("statusCode", Json::int(500)),
            ("code", Json::str(code)),
            ("error", Json::str("Internal Server Error")),
            ("message", Json::str(message)),
        ]),
        None => Json::obj([
            ("statusCode", Json::int(500)),
            ("error", Json::str("Internal Server Error")),
            ("message", Json::str(message)),
        ]),
    };
    Response {
        status: 500,
        body: body.compact(),
    }
}

/// The answer of one of this part's job doors past its signature, by its path; `None` for a path outside it.
pub fn job(d: &Deps<'_>, path: &str, body: &Value) -> Option<Response> {
    let out = match path {
        "/internal/jobs/payroll-sim/credit" => {
            let Some(input) = credit_body(body) else {
                return Some(not_in_shape());
            };
            credit(d, &input).map(|(c, replayed)| salary_view(&c, replayed))
        }
        "/internal/jobs/payroll-sim/reverse" => {
            let Some(network_id) = reverse_body(body) else {
                return Some(not_in_shape());
            };
            reverse(d, &network_id).map(|c| salary_view(&c, false))
        }
        _ => return None,
    };
    Some(match out {
        Ok(json) => Response {
            status: 200,
            body: json.compact(),
        },
        Err(f) => job_failed(f),
    })
}

/// A refusal `errors.ts` declares, for the tests below.
#[cfg(test)]
fn code_of(r: &Refusal) -> &str {
    match r {
        Refusal::Bank(crate::errors::BankError { row, .. }) => row.code,
        _ => "other",
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;
    use service_kit::json;

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn refuses_to_start_payroll_sim_outside_dev_test_or_without_the_test_partner() {
        let on = [
            ("BANK_PAYROLL_PARTNER", "payroll-sim"),
            ("BANK_TEST_PARTNER", "test"),
        ];
        let with = |extra: &[(&str, &str)]| {
            let mut e = env(&on);
            e.extend(env(extra));
            Wiring::from_env(&e).map(|w| w.payroll)
        };
        assert!(
            with(&[("APP_ENV", "production")])
                .unwrap_err()
                .starts_with("bank.payroll_sim_outside_dev_test")
        );
        assert!(with(&[("APP_ENV", "test"), ("NODE_ENV", "production")]).is_err());
        assert!(
            with(&[("APP_ENV", "test"), ("BANK_TEST_PARTNER", "off")])
                .unwrap_err()
                .starts_with("bank.payroll_sim_needs_test_partner")
        );
        assert!(
            Wiring::from_env(&env(&[
                ("APP_ENV", "test"),
                ("BANK_PAYROLL_SIM_RECORDS_DIR", "relative/dir")
            ]))
            .err()
            .unwrap()
            .starts_with("bank.payroll_sim_records_outside_dev_test")
        );
        assert_eq!(
            Wiring::from_env(&env(&[("APP_ENV", "test")]))
                .unwrap()
                .payroll,
            None
        );
        assert_eq!(
            with(&[
                ("APP_ENV", "test"),
                ("BANK_PAYROLL_SIM_RECORDS_DIR", " /tmp/r ")
            ])
            .unwrap(),
            Some(Payroll {
                label: PAYROLL_SIM_LABEL,
                records: Some(RailRecorder::new("/tmp/r", PAYROLL_SIM_RAIL))
            })
        );
    }

    #[test]
    fn a_name_compares_as_a_bank_compares_it() {
        assert_eq!(
            holder_name_key("  test ada   LOVELACE "),
            holder_name_key("TEST Ada Lovelace")
        );
        assert_eq!(holder_name_key("ＡＤＡ\u{3000}x"), "ada x");
        assert_ne!(
            holder_name_key("TEST Ada"),
            holder_name_key("TEST Somebody Else")
        );
    }

    #[test]
    fn the_owners_window_is_whole_days_from_1_to_3650() {
        assert_eq!(parse_reversal_days(Some(" 5 ")), Some(5));
        for raw in [
            None,
            Some(""),
            Some("0"),
            Some("3651"),
            Some("1.5"),
            Some("12345"),
            Some("-1"),
        ] {
            assert_eq!(parse_reversal_days(raw), None, "{raw:?}");
        }
    }

    #[test]
    fn a_job_body_is_held_to_its_schema() {
        let body = |t: &str| Value::from_json(&json::parse(t).unwrap());
        let good = r#"{"networkId":"net-1","accountDetailsId":"test-partner:u:USD","amount":"2000.00","currency":"USD","originatorName":" TEST Employer ","holderName":"TEST Ada"}"#;
        let c = credit_body(&body(good)).unwrap();
        assert_eq!(
            (c.originator_name.as_str(), c.amount.as_str()),
            ("TEST Employer", "2000.00")
        );
        for bad in [
            good.replace("net-1", "net 1"),
            good.replace("\"USD\",", "\"usd\","),
            good.replace("2000.00", "2000."),
            good.replace(" TEST Employer ", "   "),
            good.replace('}', r#","extra":1}"#),
            "{}".to_owned(),
            "[]".to_owned(),
        ] {
            assert!(credit_body(&body(&bad)).is_none(), "{bad}");
        }
        assert!(credit_body(&Value::Undefined).is_none());
        assert_eq!(
            reverse_body(&body(r#"{"networkId":"net-1"}"#)).as_deref(),
            Some("net-1")
        );
        assert!(reverse_body(&body(r#"{"networkId":"net-1","x":1}"#)).is_none());
    }

    #[test]
    fn the_owners_smallest_sorted_credit_is_a_decimal_or_no_decision() {
        assert_eq!(
            parse_min_credit(Some("1")),
            Some(parse_amount("1").unwrap())
        );
        assert_eq!(parse_min_credit(Some(" ")), None);
        assert_eq!(parse_min_credit(Some("-1")), None);
        assert_eq!(code_of(&rail_bank()), "rail.bank");
    }
}
