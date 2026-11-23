//! `AutoInvestService` (`auto-invest/auto-invest-service.ts`): the rules, their run and the capture hook.
//!
//! A rule is an instruction, never a balance. A threshold sweep moves the excess above the keep-amount into an earn
//! pool of the same asset through the earn slice's own deposit (`crate::earn::service::deposit`, keyed by the run's
//! id); a DCA buy goes through the convert port and refuses `bank.auto_invest_rate_unset` without one; a card round-up
//! moves a capture's spare change into a pool or into one of the person's own named spaces, on the ledger
//! (`bankTransfer` under `bank.transfer.own:roundup:<rule>:<authorization>:0`) or as ONE partner move under the same key.
//!
//! Each run is claimed `pending` under `(rule_id, client_run_id)` before anything moves. Only a refusal that proves
//! nothing moved (a `BankError`, or a ledger refusal made before it commits) marks a run `rejected`; any other failure
//! leaves it `pending`, and the same capture or schedule re-drives it under the same key. If this crashes after the
//! move and before the run is marked settled, nobody's funds are stranded: the money is in the person's own pot or
//! space, and the next drive finds it under the key.

use postgres::GenericClient;
use postgres::error::SqlState;
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::{Instant, civil_from_days, days_from_civil, days_in_month};

use super::convert::{ConvertAsk, ConvertError};
use super::{Deps, Wiring};
use crate::earn::service::{DepositAsk, deposit, job_batch_limit, pool};
use crate::earn::{definite_refusal, ms};
use crate::errors::Refusal;
use crate::partner::{AccountRef, MoveRequest, refuse};
use crate::spaces::ports::LedgerAccount;
use crate::spaces::space::{self, at, owner_list_limit, pg, with};
use crate::transfers::moves::{
    bank_transfer_key, booked_matches, custody_mismatch, find_primary, post_bank_transfer,
    post_refusal, resolve_for_credit, resolve_for_debit,
};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

// ── Codes and words ─────────────────────────────────────────────────────────────────────────────────────────────────

pub const RATE_UNSET: &str = "bank.auto_invest_rate_unset";
pub const DISABLED: &str = "bank.auto_invest_disabled";
pub const RUN_FAILED: &str = "bank.auto_invest_run_failed";
pub const NO_SPARE: &str = "bank.auto_invest_no_spare";
pub const OUTCOME_UNKNOWN: &str = "bank.ledger_outcome_unknown";
const DCA_RATE_UNSET: &str = "Auto-invest DCA needs a convert rate counterparty — rates are not invented here (§8 / bank.auto_invest_rate_unset)";

/// `describeAutoInvestPolicy`: the honesty door.
pub fn policy(w: &Wiring) -> Json {
    Json::obj([
        ("enabled", Json::Bool(w.enabled)),
        ("convertWired", Json::Bool(w.convert.is_some())),
        ("rateUnsetCode", Json::str(RATE_UNSET)),
        ("disabledCode", Json::str(DISABLED)),
        (
            "kinds",
            Json::Array(
                ["threshold_sweep", "dca", "card_roundup"]
                    .into_iter()
                    .map(Json::str)
                    .collect(),
            ),
        ),
        ("dcaRequiresConvert", Json::Bool(true)),
        ("crossAssetRoundUpRequiresConvert", Json::Bool(true)),
        ("thresholdSweepSameAssetOnly", Json::Bool(true)),
        ("inventsRates", Json::Bool(false)),
    ])
}

/// `assertAutoInvestListLimit`.
pub fn list_limit(limit: Option<f64>) -> Result<i64, Refusal> {
    owner_list_limit(
        limit,
        "bank.auto_invest_list_limit_unset",
        "autoInvest.list",
    )
}

/// `assertAutoInvestBatchLimit`: blank refuses, never 200.
pub fn batch_limit(limit: Option<f64>) -> Result<i64, Refusal> {
    job_batch_limit(
        limit,
        "bank.auto_invest_batch_limit_unset",
        200,
        10_000,
        "autoInvest.runDue",
    )
}

/// `spareChange`: the next multiple of `granularity` minus `captured`; an exact multiple, or a non-positive input, is 0.
pub fn spare_change(captured: Amount, granularity: Amount) -> Amount {
    if granularity <= 0 || captured <= 0 {
        return 0;
    }
    let rem = captured % granularity;
    if rem == 0 { 0 } else { granularity - rem }
}

/// `advanceCadence`: one step; a month keeps the day, clamped to the month's last.
pub fn advance_cadence(from: Instant, cadence: &str) -> Instant {
    match cadence {
        "daily" => Instant(from.0 + DAY_MS),
        "weekly" => Instant(from.0 + 7 * DAY_MS),
        _ => {
            let days = from.0.div_euclid(DAY_MS);
            let in_day = from.0.rem_euclid(DAY_MS);
            let (y, m, d) = civil_from_days(days);
            let (ty, tm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
            let day = d.min(days_in_month(ty, tm));
            Instant(days_from_civil(ty, tm, day) * DAY_MS + in_day)
        }
    }
}

// ── Rows ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/// One rule (`AutoInvestRule`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub id: String,
    pub user_id: String,
    /// `threshold_sweep`, `dca` or `card_roundup`.
    pub kind: String,
    pub asset_id: String,
    pub threshold: Option<Amount>,
    pub target_pool_id: Option<String>,
    pub target_space_id: Option<String>,
    pub buy_asset_id: Option<String>,
    /// A DCA's spend, or a round-up's granularity.
    pub amount: Option<Amount>,
    pub cadence: Option<String>,
    pub next_run_at: Option<Instant>,
    /// `active`, `paused` or `cancelled`.
    pub status: String,
    pub created_at: Instant,
}

fn rule_cols() -> String {
    format!(
        "id::text, user_id, kind::text, asset_id, threshold::text, target_pool_id::text, target_space_id::text, \
         buy_asset_id, amount::text, cadence::text, {}, status::text, {}",
        ms("next_run_at"),
        ms("created_at")
    )
}

fn opt_amount(r: &postgres::Row, i: usize) -> Result<Option<Amount>, Refusal> {
    r.try_get::<_, Option<String>>(i)
        .map_err(|e| pg(&e))?
        .map(|s| parse_amount(&s))
        .transpose()
        .map_err(Refusal::Other)
}

impl Rule {
    fn from_row(r: &postgres::Row) -> Result<Rule, Refusal> {
        let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
        let o = |i: usize| r.try_get::<_, Option<String>>(i).map_err(|e| pg(&e));
        Ok(Rule {
            id: s(0)?,
            user_id: s(1)?,
            kind: s(2)?,
            asset_id: s(3)?,
            threshold: opt_amount(r, 4)?,
            target_pool_id: o(5)?,
            target_space_id: o(6)?,
            buy_asset_id: o(7)?,
            amount: opt_amount(r, 8)?,
            cadence: o(9)?,
            next_run_at: r
                .try_get::<_, Option<i64>>(10)
                .map_err(|e| pg(&e))?
                .map(Instant),
            status: s(11)?,
            created_at: Instant(r.try_get(12).map_err(|e| pg(&e))?),
        })
    }

    /// The router's `mapRule`.
    pub fn json(&self) -> Json {
        let opt = |v: &Option<String>| v.clone().map_or(Json::Null, Json::str);
        let amt = |v: Option<Amount>| v.map_or(Json::Null, |a| Json::str(format_amount(a)));
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("kind", Json::str(self.kind.clone())),
            ("assetId", Json::str(self.asset_id.clone())),
            ("threshold", amt(self.threshold)),
            ("targetPoolId", opt(&self.target_pool_id)),
            ("targetSpaceId", opt(&self.target_space_id)),
            ("buyAssetId", opt(&self.buy_asset_id)),
            ("amount", amt(self.amount)),
            ("cadence", opt(&self.cadence)),
            (
                "nextRunAt",
                self.next_run_at.map_or(Json::Null, |t| Json::str(t.iso())),
            ),
            ("status", Json::str(self.status.clone())),
            ("createdAt", Json::str(self.created_at.iso())),
        ])
    }
}

/// One run (`AutoInvestRun`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    pub id: String,
    pub rule_id: String,
    pub client_run_id: String,
    /// `pending`, `settled`, `rejected` or `skipped`.
    pub status: String,
    pub amount: Option<Amount>,
    pub ledger_tx_id: Option<String>,
    pub position_id: Option<String>,
    pub partner_move_id: Option<String>,
    pub rejection_code: Option<String>,
}

// ── Create, read, hold ───────────────────────────────────────────────────────────────────────────────────────────────

fn insert_rule(
    c: &mut impl GenericClient,
    sql: &str,
    params: &[&(dyn postgres::types::ToSql + Sync)],
) -> Result<Rule, Refusal> {
    let rows = c
        .query(&format!("{sql} RETURNING {}", rule_cols()), params)
        .map_err(|e| {
            if e.code() == Some(&SqlState::UNIQUE_VIOLATION) {
                refuse(
                    "bank.auto_invest_roundup_exists",
                    "An active card round-up already exists for this asset — pause or cancel it first",
                )
            } else {
                pg(&e)
            }
        })?;
    rows.first()
        .map(Rule::from_row)
        .transpose()?
        .ok_or_else(|| Refusal::Other("auto_invest_rules insert returned no row".to_owned()))
}

fn open_pool_of(
    c: &mut impl GenericClient,
    pool_id: &str,
    asset_id: &str,
    what: &str,
) -> Result<(), Refusal> {
    let p = pool(c, pool_id)?;
    if p.status != "open" {
        return Err(refuse(
            "bank.pool_closed",
            format!("Pool \"{}\" is closed", p.name),
        ));
    }
    if p.asset_id != asset_id {
        return Err(refuse(
            "bank.asset_mismatch",
            format!(
                "{what} asset {asset_id} does not match pool asset {}",
                p.asset_id
            ),
        ));
    }
    Ok(())
}

/// `createThresholdSweep`: keep `threshold` in the main balance, sweep the excess into a same-asset pool.
pub fn create_threshold_sweep(
    d: &Deps<'_>,
    user_id: &str,
    asset_id: &str,
    threshold: Amount,
    pool_id: &str,
) -> Result<Rule, Refusal> {
    if threshold <= 0 {
        return Err(refuse(
            "bank.auto_invest_invalid_threshold",
            "A threshold sweep needs a positive keep-amount",
        ));
    }
    with(d.store(), |c| {
        open_pool_of(c, pool_id, asset_id, "Threshold sweep")?;
        space::ensure_primary(c, user_id, asset_id)?;
        insert_rule(
            c,
            "INSERT INTO bank.auto_invest_rules (user_id, kind, asset_id, threshold, target_pool_id, status) \
             VALUES ($1, 'threshold_sweep', $2, $3::text::numeric, $4::text::uuid, 'active')",
            &[&user_id, &asset_id, &format_amount(threshold), &pool_id],
        )
    })
}

/// What a DCA schedule asks for.
pub struct DcaAsk<'a> {
    pub user_id: &'a str,
    pub spend_asset_id: &'a str,
    pub buy_asset_id: &'a str,
    pub amount: Amount,
    pub cadence: &'a str,
    pub starts_at: Instant,
}

/// `createDca`: refused `bank.auto_invest_rate_unset` without a convert counterparty, before anything is written.
pub fn create_dca(d: &Deps<'_>, ask: &DcaAsk<'_>) -> Result<Rule, Refusal> {
    if d.w.auto_invest.convert.is_none() {
        return Err(refuse(RATE_UNSET, DCA_RATE_UNSET));
    }
    if ask.amount <= 0 {
        return Err(refuse(
            "bank.below_minimum",
            "A DCA schedule needs a positive amount",
        ));
    }
    if ask.spend_asset_id == ask.buy_asset_id {
        return Err(refuse(
            "bank.same_space",
            "DCA needs two different assets — same-asset use a threshold sweep or standing order",
        ));
    }
    with(d.store(), |c| {
        space::ensure_primary(c, ask.user_id, ask.spend_asset_id)?;
        insert_rule(
            c,
            &format!(
                "INSERT INTO bank.auto_invest_rules (user_id, kind, asset_id, buy_asset_id, amount, cadence, next_run_at, status) \
                 VALUES ($1, 'dca', $2, $3, $4::text::numeric, $5::text::bank.transfer_cadence, {}, 'active')",
                at("$6")
            ),
            &[
                &ask.user_id,
                &ask.spend_asset_id,
                &ask.buy_asset_id,
                &format_amount(ask.amount),
                &ask.cadence,
                &ask.starts_at.0,
            ],
        )
    })
}

/// What a card round-up asks for.
pub struct RoundUpAsk<'a> {
    pub user_id: &'a str,
    pub asset_id: &'a str,
    pub granularity: Amount,
    pub target_pool_id: Option<&'a str>,
    pub target_space_id: Option<&'a str>,
    pub buy_asset_id: Option<&'a str>,
}

/// `createCardRoundUp`: into exactly one pool or one of the person's own live named spaces of the same asset.
pub fn create_round_up(d: &Deps<'_>, ask: &RoundUpAsk<'_>) -> Result<Rule, Refusal> {
    if ask.target_pool_id.is_none() == ask.target_space_id.is_none() {
        return Err(refuse(
            "bank.auto_invest_target_invalid",
            "A card round-up goes into exactly one pool or one space",
        ));
    }
    if ask.buy_asset_id.is_some_and(|b| b != ask.asset_id) {
        return Err(refuse(
            RATE_UNSET,
            "Card round-up into another asset needs a convert rate counterparty — rates are not invented here (§8 / bank.auto_invest_rate_unset)",
        ));
    }
    if ask.granularity <= 0 {
        return Err(refuse(
            "bank.auto_invest_invalid_threshold",
            "A card round-up needs a positive granularity",
        ));
    }
    with(d.store(), |c| {
        if let Some(pool_id) = ask.target_pool_id {
            open_pool_of(c, pool_id, ask.asset_id, "Round-up")?;
        } else if let Some(space_id) = ask.target_space_id {
            own_target_space(c, ask.user_id, space_id, ask.asset_id)?;
        }
        space::ensure_primary(c, ask.user_id, ask.asset_id)?;
        insert_rule(
            c,
            "INSERT INTO bank.auto_invest_rules (user_id, kind, asset_id, target_pool_id, target_space_id, amount, status) \
             VALUES ($1, 'card_roundup', $2, $3::text::uuid, $4::text::uuid, $5::text::numeric, 'active')",
            &[
                &ask.user_id,
                &ask.asset_id,
                &ask.target_pool_id,
                &ask.target_space_id,
                &format_amount(ask.granularity),
            ],
        )
    })
}

/// `ownTargetSpace`: the person's own live named space of `asset_id`; another person's reads as not found.
fn own_target_space(
    c: &mut impl GenericClient,
    user_id: &str,
    space_id: &str,
    asset_id: &str,
) -> Result<(), Refusal> {
    let s = space::get(c, space_id)?;
    if s.user_id != user_id {
        return Err(space::not_found(space_id));
    }
    if s.kind != "named" {
        return Err(refuse(
            "bank.auto_invest_target_invalid",
            "Spare change comes from the account itself, so it cannot go back into it",
        ));
    }
    if s.archived_at.is_some() {
        return Err(space::archived(&s.name));
    }
    if s.asset_id != asset_id {
        return Err(refuse(
            "bank.asset_mismatch",
            format!(
                "Round-up asset {asset_id} does not match space asset {}",
                s.asset_id
            ),
        ));
    }
    Ok(())
}

/// `listRules`: newest first; with `target_space_id`, only the round-ups into that space.
pub fn list(
    d: &Deps<'_>,
    user_id: &str,
    limit: Option<f64>,
    target_space_id: Option<&str>,
) -> Result<Vec<Rule>, Refusal> {
    let page = list_limit(limit)?;
    with(d.store(), |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.auto_invest_rules WHERE user_id = $1 \
                     AND ($2::text::uuid IS NULL OR target_space_id = $2::text::uuid) \
                     ORDER BY created_at DESC LIMIT $3",
                    rule_cols()
                ),
                &[&user_id, &target_space_id, &page],
            )
            .map_err(|e| pg(&e))?;
        rows.iter().map(Rule::from_row).collect()
    })
}

/// `getRule`.
pub fn get(d: &Deps<'_>, rule_id: &str) -> Result<Rule, Refusal> {
    with(d.store(), |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.auto_invest_rules WHERE id = $1::text::uuid",
                    rule_cols()
                ),
                &[&rule_id],
            )
            .map_err(|e| pg(&e))?;
        rows.first()
            .map(Rule::from_row)
            .transpose()?
            .ok_or_else(|| {
                refuse(
                    "bank.auto_invest_not_found",
                    format!("Auto-invest rule {rule_id} not found"),
                )
            })
    })
}

fn set_status(
    d: &Deps<'_>,
    rule_id: &str,
    to: &str,
    from: &[&str],
    word: &str,
) -> Result<Rule, Refusal> {
    let from: Vec<String> = from.iter().map(|s| (*s).to_owned()).collect();
    with(d.store(), |c| {
        let rows = c
            .query(
                &format!(
                    "UPDATE bank.auto_invest_rules SET status = $2::text::bank.auto_invest_rule_status, updated_at = now() \
                     WHERE id = $1::text::uuid AND status::text = ANY($3) RETURNING {}",
                    rule_cols()
                ),
                &[&rule_id, &to, &from],
            )
            .map_err(|e| pg(&e))?;
        rows.first()
            .map(Rule::from_row)
            .transpose()?
            .ok_or_else(|| {
                refuse(
                    "bank.auto_invest_inactive",
                    format!("Auto-invest rule {rule_id} is not {word}"),
                )
            })
    })
}

/// `cancelRule`.
pub fn cancel(d: &Deps<'_>, rule_id: &str) -> Result<(), Refusal> {
    set_status(
        d,
        rule_id,
        "cancelled",
        &["active", "paused"],
        "cancellable",
    )
    .map(|_| ())
}

/// `pauseRule`: the runner and the capture hook pass a paused rule by.
pub fn pause(d: &Deps<'_>, rule_id: &str) -> Result<Rule, Refusal> {
    set_status(d, rule_id, "paused", &["active"], "pausable")
}

/// `resumeRule`: no catch-up fire for the time it was paused.
pub fn resume(d: &Deps<'_>, rule_id: &str) -> Result<Rule, Refusal> {
    set_status(d, rule_id, "active", &["paused"], "resumable")
}

/// `runsOf`: newest first.
pub fn runs_of(d: &Deps<'_>, rule_id: &str) -> Result<Vec<Run>, Refusal> {
    with(d.store(), |c| {
        let rows = c
            .query(
                "SELECT id::text, rule_id::text, client_run_id, status::text, amount::text, ledger_tx_id, position_id, \
                 partner_move_id, rejection_code FROM bank.auto_invest_runs WHERE rule_id = $1::text::uuid \
                 ORDER BY created_at DESC",
                &[&rule_id],
            )
            .map_err(|e| pg(&e))?;
        rows.iter()
            .map(|r| {
                let o = |i: usize| r.try_get::<_, Option<String>>(i).map_err(|e| pg(&e));
                Ok(Run {
                    id: r.try_get(0).map_err(|e| pg(&e))?,
                    rule_id: r.try_get(1).map_err(|e| pg(&e))?,
                    client_run_id: r.try_get(2).map_err(|e| pg(&e))?,
                    status: r.try_get(3).map_err(|e| pg(&e))?,
                    amount: opt_amount(r, 4)?,
                    ledger_tx_id: o(5)?,
                    position_id: o(6)?,
                    partner_move_id: o(7)?,
                    rejection_code: o(8)?,
                })
            })
            .collect()
    })
}

// ── Runs ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/// What a failed move proves (`isDefiniteRunRefusal`, `runRefusalCode`): a code when nothing moved, else nothing.
fn definite_code(r: &Refusal) -> Option<String> {
    match r {
        Refusal::Bank(e) => Some(e.row.code.to_owned()),
        // The ledger's own refusal for too little money, as the transfers and earn slices raise it.
        Refusal::Trpc(t) if t.cause.as_deref().is_some_and(definite_ledger) => t.cause.clone(),
        _ => None,
    }
}

/// Claims a run `pending`; `None` when its key is already taken.
fn claim(
    c: &mut impl GenericClient,
    rule_id: &str,
    client_run_id: &str,
    amount: Amount,
) -> Result<Option<String>, Refusal> {
    let rows = c
        .query(
            "INSERT INTO bank.auto_invest_runs (rule_id, client_run_id, status, amount) \
             VALUES ($1::text::uuid, $2, 'pending', $3::text::numeric) \
             ON CONFLICT (rule_id, client_run_id) DO NOTHING RETURNING id::text",
            &[&rule_id, &client_run_id, &format_amount(amount)],
        )
        .map_err(|e| pg(&e))?;
    Ok(rows.first().map(|r| r.get(0)))
}

/// `recordSkipped`.
fn record_skipped(
    c: &mut impl GenericClient,
    rule_id: &str,
    client_run_id: &str,
    reason: &str,
) -> Result<(), Refusal> {
    c.execute(
        "INSERT INTO bank.auto_invest_runs (rule_id, client_run_id, status, amount, rejection_code, settled_at) \
         VALUES ($1::text::uuid, $2, 'skipped', NULL, $3, now()) ON CONFLICT (rule_id, client_run_id) DO NOTHING",
        &[&rule_id, &client_run_id, &reason],
    )
    .map_err(|e| pg(&e))?;
    Ok(())
}

fn prior_status(
    c: &mut impl GenericClient,
    rule_id: &str,
    client_run_id: &str,
) -> Result<Option<String>, Refusal> {
    let rows = c
        .query(
            "SELECT status::text FROM bank.auto_invest_runs WHERE rule_id = $1::text::uuid AND client_run_id = $2",
            &[&rule_id, &client_run_id],
        )
        .map_err(|e| pg(&e))?;
    Ok(rows.first().map(|r| r.get(0)))
}

/// A taken key: settled only if that row settled; a pending, rejected or skipped row did not move this money.
fn taken(status: Option<String>) -> Outcome {
    match status.as_deref() {
        Some("settled") => Outcome::Settled,
        Some("rejected") => Outcome::Rejected,
        Some("pending") => Outcome::Pending,
        _ => Outcome::Skipped,
    }
}

/// `rejected` with its code, only while the run has not settled.
fn reject(
    c: &mut impl GenericClient,
    run_id: &str,
    code: &str,
    now: Instant,
    also_rejected: bool,
) -> Result<(), Refusal> {
    let from = if also_rejected {
        "('pending', 'rejected')"
    } else {
        "('pending')"
    };
    c.execute(
        &format!(
            "UPDATE bank.auto_invest_runs SET status = 'rejected', rejection_code = $2, settled_at = {} \
             WHERE id = $1::text::uuid AND status IN {from}",
            at("$3")
        ),
        &[&run_id, &code, &now.0],
    )
    .map_err(|e| pg(&e))?;
    Ok(())
}

/// One rule's outcome on a pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Settled,
    Skipped,
    Rejected,
    Pending,
}

/// `AutoInvestRunReport`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    pub considered: i64,
    pub settled: i64,
    pub skipped: i64,
    pub rejected: i64,
    /// (rule id, code).
    pub failures: Vec<(String, String)>,
}

impl Report {
    pub fn json(&self) -> Json {
        Json::obj([
            ("considered", Json::int(self.considered)),
            ("settled", Json::int(self.settled)),
            ("skipped", Json::int(self.skipped)),
            ("rejected", Json::int(self.rejected)),
            (
                "failures",
                Json::Array(
                    self.failures
                        .iter()
                        .map(|(rule, code)| {
                            Json::obj([
                                ("ruleId", Json::str(rule.clone())),
                                ("code", Json::str(code.clone())),
                            ])
                        })
                        .collect(),
                ),
            ),
        ])
    }
}

/// `runDue`: every active threshold sweep once, and every DCA rule that is due; one rule's failure is recorded and the
/// others go on. A rule stuck on an unknown outcome sorts last, so it never takes a due rule's batch slot.
pub fn run_due(d: &Deps<'_>, now: Instant, limit: Option<f64>) -> Result<Report, Refusal> {
    let limit = batch_limit(limit.or(d.w.auto_invest.batch_size))?;
    let rules = with(d.store(), |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.auto_invest_rules WHERE status = 'active' \
                     AND (kind = 'threshold_sweep' OR (kind = 'dca' AND next_run_at IS NOT NULL AND next_run_at <= {})) \
                     ORDER BY EXISTS (SELECT 1 FROM bank.auto_invest_runs r \
                       WHERE r.rule_id = bank.auto_invest_rules.id AND r.status = 'pending') ASC, created_at ASC \
                     LIMIT $2",
                    rule_cols(),
                    at("$1")
                ),
                &[&now.0, &limit],
            )
            .map_err(|e| pg(&e))?;
        rows.iter()
            .map(Rule::from_row)
            .collect::<Result<Vec<_>, _>>()
    })?;
    let mut report = Report::default();
    for rule in rules {
        report.considered += 1;
        let driven = match rule.kind.as_str() {
            "threshold_sweep" => drive_sweep(d, &rule, now),
            "dca" => drive_dca(d, &rule, now),
            _ => Err(refuse(
                RUN_FAILED,
                "Card round-ups fire on capture, not on the runner",
            )),
        };
        match driven {
            Ok(Outcome::Settled) => report.settled += 1,
            Ok(Outcome::Skipped) => report.skipped += 1,
            Ok(Outcome::Rejected) => report.rejected += 1,
            Ok(Outcome::Pending) => {}
            Err(r) => {
                let code = match &r {
                    Refusal::Bank(e) => e.row.code.to_owned(),
                    _ => RUN_FAILED.to_owned(),
                };
                report.failures.push((rule.id.clone(), code));
            }
        }
    }
    Ok(report)
}

/// The earn slice's dependencies for one deposit at `now`.
fn earn_deposit(
    d: &Deps<'_>,
    now: Instant,
    pool_id: &str,
    user_id: &str,
    amount: Amount,
    position_id: &str,
) -> Result<crate::earn::Position, Refusal> {
    let earn = crate::earn::Deps {
        store: d.store(),
        ledger: d.t.ledger,
        custody_layer: &d.t.partner.custody_layer,
        recipients: d.t.w.recipients.as_ref(),
        approvals: d.t.w.approvals.as_ref(),
        settings: d.earn,
        now,
    };
    deposit(
        &earn,
        &DepositAsk {
            pool_id,
            user_id,
            amount,
            position_id,
        },
    )
}

fn drive_sweep(d: &Deps<'_>, rule: &Rule, now: Instant) -> Result<Outcome, Refusal> {
    let client_run_id = format!("sweep:{}:{}", rule.id, now.iso());
    let threshold = rule.threshold.unwrap_or_default();
    let pool_id = rule.target_pool_id.clone().unwrap_or_default();
    let balance =
        d.t.ledger
            .balance(&LedgerAccount::user_available(
                &rule.user_id,
                &rule.asset_id,
            ))
            .map_err(Refusal::Other)?;
    if balance <= threshold {
        with(d.store(), |c| {
            record_skipped(
                c,
                &rule.id,
                &client_run_id,
                "bank.auto_invest_below_threshold",
            )
        })?;
        return Ok(Outcome::Skipped);
    }
    let excess = balance - threshold;
    let claimed = with(d.store(), |c| claim(c, &rule.id, &client_run_id, excess))?;
    let Some(run_id) = claimed else {
        return with(d.store(), |c| prior_status(c, &rule.id, &client_run_id)).map(taken);
    };
    match earn_deposit(d, now, &pool_id, &rule.user_id, excess, &run_id) {
        Ok(position) => {
            with(d.store(), |c| {
                c.execute(
                    &format!(
                        "UPDATE bank.auto_invest_runs SET status = 'settled', position_id = $2, settled_at = {}, \
                         amount = $4::text::numeric WHERE id = $1::text::uuid",
                        at("$3")
                    ),
                    &[&run_id, &position.id, &now.0, &format_amount(excess)],
                )
                .map_err(|e| pg(&e))
            })?;
            Ok(Outcome::Settled)
        }
        Err(r) => {
            // Unknown outcome: the run stays pending and the failure is reported.
            let Some(code) = definite_code(&r) else {
                return Err(r);
            };
            with(d.store(), |c| reject(c, &run_id, &code, now, false))?;
            Ok(Outcome::Rejected)
        }
    }
}

fn drive_dca(d: &Deps<'_>, rule: &Rule, now: Instant) -> Result<Outcome, Refusal> {
    let Some(convert) = d.w.auto_invest.convert.as_deref() else {
        // A rule from a deployment that had a convert port never invents a rate here.
        return Err(refuse(RATE_UNSET, DCA_RATE_UNSET));
    };
    let client_run_id = format!("dca:{}:{}", rule.id, rule.next_run_at.unwrap_or(now).iso());
    let amount = rule.amount.unwrap_or_default();
    let claimed = with(d.store(), |c| claim(c, &rule.id, &client_run_id, amount))?;
    let Some(run_id) = claimed else {
        return with(d.store(), |c| prior_status(c, &rule.id, &client_run_id)).map(taken);
    };
    let converted = convert.convert(&ConvertAsk {
        user_id: &rule.user_id,
        instruction_id: &rule.id,
        from_asset: &rule.asset_id,
        to_asset: rule.buy_asset_id.as_deref().unwrap_or_default(),
        from_amount: amount,
        client_convert_id: &client_run_id,
    });
    match converted {
        Ok(fill) => {
            let next = advance_cadence(
                rule.next_run_at.unwrap_or(now),
                rule.cadence.as_deref().unwrap_or("daily"),
            );
            with(d.store(), |c| {
                c.execute(
                    &format!(
                        "UPDATE bank.auto_invest_runs SET status = 'settled', ledger_tx_id = $2, \
                         amount = $3::text::numeric, settled_at = {} WHERE id = $1::text::uuid",
                        at("$4")
                    ),
                    &[
                        &run_id,
                        &fill.ledger_tx_id,
                        &format_amount(fill.to_amount),
                        &now.0,
                    ],
                )
                .map_err(|e| pg(&e))?;
                c.execute(
                    &format!(
                        "UPDATE bank.auto_invest_rules SET next_run_at = {}, updated_at = now() WHERE id = $1::text::uuid",
                        at("$2")
                    ),
                    &[&rule.id, &next.0],
                )
                .map_err(|e| pg(&e))
            })?;
            Ok(Outcome::Settled)
        }
        Err(ConvertError::Refused(r)) => {
            let code = definite_code(&r).unwrap_or_else(|| RUN_FAILED.to_owned());
            with(d.store(), |c| reject(c, &run_id, &code, now, false))?;
            Ok(Outcome::Rejected)
        }
        Err(ConvertError::Ledger(code)) if definite_ledger(&code) => {
            with(d.store(), |c| reject(c, &run_id, &code, now, false))?;
            Ok(Outcome::Rejected)
        }
        Err(ConvertError::Ledger(code)) => Err(Refusal::Other(format!(
            "convert failed with {code}; the outcome is unknown"
        ))),
        // The convert may have filled: the run stays pending for reconciliation.
        Err(ConvertError::Unknown(m)) => Err(Refusal::Other(m)),
    }
}

/// `isDefiniteLedgerRefusal` for a code alone.
fn definite_ledger(code: &str) -> bool {
    definite_refusal(&crate::spaces::ports::PostFailure::Coded {
        code: code.to_owned(),
        message: String::new(),
        attempts: 1,
    })
}

// ── The capture hook ─────────────────────────────────────────────────────────────────────────────────────────────────

/// `RoundUpOutcome` (`cards/card-service.ts`): what a capture's round-up did. The capture stands whatever it says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoundUpOutcome {
    None,
    Skipped {
        amount: Amount,
        reason: String,
    },
    /// Into a pool: the saving it opened.
    SettledPool {
        amount: Amount,
        position_id: String,
    },
    /// Into one of the person's own spaces on the ledger.
    SettledSpace {
        amount: Amount,
        space_id: String,
        ledger_tx_id: String,
    },
    /// Into one of the person's own spaces the partner bank holds: its one move, nothing on the ledger.
    SettledPartner {
        amount: Amount,
        space_id: String,
        partner_move_id: String,
    },
    Refused {
        amount: Amount,
        reason: String,
    },
}

impl RoundUpOutcome {
    pub fn status(&self) -> &'static str {
        match self {
            RoundUpOutcome::None => "none",
            RoundUpOutcome::Skipped { .. } => "skipped",
            RoundUpOutcome::SettledPool { .. }
            | RoundUpOutcome::SettledSpace { .. }
            | RoundUpOutcome::SettledPartner { .. } => "settled",
            RoundUpOutcome::Refused { .. } => "refused",
        }
    }

    pub fn amount(&self) -> Amount {
        match self {
            RoundUpOutcome::None => 0,
            RoundUpOutcome::Skipped { amount, .. }
            | RoundUpOutcome::SettledPool { amount, .. }
            | RoundUpOutcome::SettledSpace { amount, .. }
            | RoundUpOutcome::SettledPartner { amount, .. }
            | RoundUpOutcome::Refused { amount, .. } => *amount,
        }
    }

    /// The reason a skip or a refusal names.
    pub fn reason(&self) -> Option<&str> {
        match self {
            RoundUpOutcome::Skipped { reason, .. } | RoundUpOutcome::Refused { reason, .. } => {
                Some(reason)
            }
            _ => None,
        }
    }

    /// As the TypeScript's object reads on the wire (amounts as decimal strings).
    pub fn json(&self) -> Json {
        let amount = Json::str(format_amount(self.amount()));
        let status = Json::str(self.status());
        match self {
            RoundUpOutcome::None => Json::obj([("status", status), ("amount", amount)]),
            RoundUpOutcome::Skipped { reason, .. } | RoundUpOutcome::Refused { reason, .. } => {
                Json::obj([
                    ("status", status),
                    ("amount", amount),
                    ("reason", Json::str(reason.clone())),
                ])
            }
            RoundUpOutcome::SettledPool { position_id, .. } => Json::obj([
                ("status", status),
                ("amount", amount),
                ("positionId", Json::str(position_id.clone())),
            ]),
            RoundUpOutcome::SettledSpace {
                space_id,
                ledger_tx_id,
                ..
            } => Json::obj([
                ("status", status),
                ("amount", amount),
                ("spaceId", Json::str(space_id.clone())),
                ("ledgerTxId", Json::str(ledger_tx_id.clone())),
            ]),
            RoundUpOutcome::SettledPartner {
                space_id,
                partner_move_id,
                ..
            } => Json::obj([
                ("status", status),
                ("amount", amount),
                ("spaceId", Json::str(space_id.clone())),
                ("ledgerTxId", Json::Null),
                ("partnerMoveId", Json::str(partner_move_id.clone())),
            ]),
        }
    }
}

/// The capture the hook is handed (`CaptureSettledHook`'s event).
pub struct Capture<'a> {
    pub user_id: &'a str,
    pub asset_id: &'a str,
    pub authorization_id: &'a str,
    pub captured: Amount,
    /// The card partner captured it.
    pub partner_held: bool,
}

/// `applyRoundUp`: the capture hook, called by slice `card-ops`' capture once it has settled; nothing here undoes it.
/// The kill switch, no live rule and an exact multiple are skips; a failure is `refused` with its code.
pub fn apply_round_up(d: &Deps<'_>, cap: &Capture<'_>) -> Result<RoundUpOutcome, Refusal> {
    if !d.w.auto_invest.enabled {
        return Ok(RoundUpOutcome::Skipped {
            amount: 0,
            reason: DISABLED.to_owned(),
        });
    }
    let rule = with(d.store(), |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.auto_invest_rules WHERE user_id = $1 AND asset_id = $2 \
                     AND kind = 'card_roundup' AND status = 'active' ORDER BY created_at ASC LIMIT 1",
                    rule_cols()
                ),
                &[&cap.user_id, &cap.asset_id],
            )
            .map_err(|e| pg(&e))?;
        rows.first().map(Rule::from_row).transpose()
    })?;
    let Some(rule) = rule else {
        return Ok(RoundUpOutcome::None);
    };
    let spare = spare_change(cap.captured, rule.amount.unwrap_or_default());
    let client_run_id = format!("roundup:{}:{}", rule.id, cap.authorization_id);
    if spare <= 0 {
        with(d.store(), |c| {
            record_skipped(c, &rule.id, &client_run_id, NO_SPARE)
        })?;
        return Ok(RoundUpOutcome::Skipped {
            amount: 0,
            reason: NO_SPARE.to_owned(),
        });
    }
    let claimed = with(d.store(), |c| claim(c, &rule.id, &client_run_id, spare))?;
    let run_id = match claimed {
        Some(id) => id,
        None => {
            let prior = with(d.store(), |c| {
                let rows = c
                    .query(
                        "SELECT id::text, status::text, position_id, ledger_tx_id, partner_move_id FROM bank.auto_invest_runs \
                         WHERE rule_id = $1::text::uuid AND client_run_id = $2",
                        &[&rule.id, &client_run_id],
                    )
                    .map_err(|e| pg(&e))?;
                Ok(rows.first().map(|r| {
                    (
                        r.get::<_, String>(0),
                        r.get::<_, String>(1),
                        r.get::<_, Option<String>>(2),
                        r.get::<_, Option<String>>(3),
                        r.get::<_, Option<String>>(4),
                    )
                }))
            })?;
            match prior {
                Some((_, status, _, Some(tx), _))
                    if status == "settled" && rule.target_space_id.is_some() =>
                {
                    return Ok(RoundUpOutcome::SettledSpace {
                        amount: spare,
                        space_id: rule.target_space_id.clone().unwrap_or_default(),
                        ledger_tx_id: tx,
                    });
                }
                Some((_, status, _, _, Some(mv)))
                    if status == "settled" && rule.target_space_id.is_some() =>
                {
                    return Ok(RoundUpOutcome::SettledPartner {
                        amount: spare,
                        space_id: rule.target_space_id.clone().unwrap_or_default(),
                        partner_move_id: mv,
                    });
                }
                Some((_, status, Some(pos), _, _)) if status == "settled" => {
                    return Ok(RoundUpOutcome::SettledPool {
                        amount: spare,
                        position_id: pos,
                    });
                }
                // The deposit and the space move are idempotent on this run: retry it, never mint another id.
                Some((id, status, ..)) if status == "pending" || status == "rejected" => id,
                _ => {
                    return Ok(RoundUpOutcome::Skipped {
                        amount: spare,
                        reason: RUN_FAILED.to_owned(),
                    });
                }
            }
        }
    };
    let now = d.now();
    if let Some(space_id) = rule.target_space_id.as_deref() {
        return round_up_into_space(
            d,
            &rule,
            space_id,
            &run_id,
            &client_run_id,
            spare,
            cap.partner_held,
        );
    }
    // A savings deposit pays from our own book: a capture the card partner made, or a person whose bank money the partner
    // holds, has nothing there to round up from. Refused by name, and nothing posts.
    if cap.partner_held || d.t.custody.bank_for(&rule.user_id).is_some() {
        let code = "bank.partner_custody_mismatch";
        with(d.store(), |c| reject(c, &run_id, code, now, true))?;
        return Ok(RoundUpOutcome::Refused {
            amount: spare,
            reason: code.to_owned(),
        });
    }
    let pool_id = rule.target_pool_id.clone().unwrap_or_default();
    match earn_deposit(d, now, &pool_id, &rule.user_id, spare, &run_id) {
        Ok(position) => {
            with(d.store(), |c| {
                c.execute(
                    &format!(
                        "UPDATE bank.auto_invest_runs SET status = 'settled', position_id = $2, rejection_code = NULL, \
                         settled_at = {}, amount = $4::text::numeric WHERE id = $1::text::uuid",
                        at("$3")
                    ),
                    &[&run_id, &position.id, &now.0, &format_amount(spare)],
                )
                .map_err(|e| pg(&e))
            })?;
            Ok(RoundUpOutcome::SettledPool {
                amount: spare,
                position_id: position.id,
            })
        }
        Err(r) => match definite_code(&r) {
            // Unknown outcome: the deposit may have committed. The run stays pending; the same capture re-drives it.
            None => Ok(RoundUpOutcome::Refused {
                amount: spare,
                reason: OUTCOME_UNKNOWN.to_owned(),
            }),
            Some(code) => {
                with(d.store(), |c| reject(c, &run_id, &code, now, true))?;
                Ok(RoundUpOutcome::Refused {
                    amount: spare,
                    reason: code,
                })
            }
        },
    }
}

/// `roundUpIntoSpace`: one own-space move from the account itself, keyed by the run's client id, on the ledger or as
/// one partner move. The same capture re-driven moves once.
fn round_up_into_space(
    d: &Deps<'_>,
    rule: &Rule,
    space_id: &str,
    run_id: &str,
    transfer_id: &str,
    spare: Amount,
    card_partner_held: bool,
) -> Result<RoundUpOutcome, Refusal> {
    let now = d.now();
    match move_into_space(
        d,
        rule,
        space_id,
        run_id,
        transfer_id,
        spare,
        card_partner_held,
    ) {
        Ok(out) => Ok(out),
        Err(r) => match definite_code(&r) {
            None => Ok(RoundUpOutcome::Refused {
                amount: spare,
                reason: OUTCOME_UNKNOWN.to_owned(),
            }),
            Some(code) => {
                with(d.store(), |c| reject(c, run_id, &code, now, true))?;
                Ok(RoundUpOutcome::Refused {
                    amount: spare,
                    reason: code,
                })
            }
        },
    }
}

fn move_into_space(
    d: &Deps<'_>,
    rule: &Rule,
    space_id: &str,
    run_id: &str,
    transfer_id: &str,
    spare: Amount,
    card_partner_held: bool,
) -> Result<RoundUpOutcome, Refusal> {
    let now = d.now();
    let partner = d.t.custody.bank_for(&rule.user_id);
    // The card partner's book and the bank's book of this person must agree, else nothing moves.
    if card_partner_held != partner.is_some() {
        return Err(custody_mismatch());
    }
    // The rule made the account's primary space; a capture only reads it.
    let primary = with(d.store(), |c| {
        find_primary(c, &rule.user_id, &rule.asset_id)
    })?
    .ok_or_else(|| {
        refuse(
            "bank.space_not_found",
            format!("No {} account to round up from", rule.asset_id),
        )
    })?;
    let from = with(d.store(), |c| resolve_for_debit(c, &primary.id, now))?;
    let to = with(d.store(), |c| {
        resolve_for_credit(d.t, c, space_id, Some(&rule.user_id), None)
    })?;
    if to.user_id != rule.user_id || to.kind != "named" {
        return Err(space::not_found(space_id));
    }
    if to.asset_id != rule.asset_id {
        return Err(refuse(
            "bank.asset_mismatch",
            format!(
                "Round-up asset {} does not match space asset {}",
                rule.asset_id, to.asset_id
            ),
        ));
    }
    if let Some(p) = partner {
        return round_up_at_partner(
            d,
            &p,
            run_id,
            transfer_id,
            space_id,
            from.partner_account(),
            to.partner_account(),
            spare,
        );
    }
    // `custodyGuardedLedger`: with the custodial layer off no customer balance is posted from here.
    if d.t.partner.custody_layer != "on" {
        return Err(refuse(
            "bank.no_partner_bank",
            "No banking partner holds this money, and INTAFACED holds no customer money, so nothing was moved.",
        ));
    }
    let from_account = from.ledger_account();
    let to_account = to.ledger_account();
    let tx = post_bank_transfer(
        d.t,
        transfer_id,
        0,
        &from_account,
        &to_account,
        spare,
        "own",
    )
    .map_err(|f| {
        if f.insufficient() {
            post_refusal(&f)
        } else if f.code().is_some_and(definite_ledger) {
            // A definite refusal other than too little money keeps its own code on the run.
            refuse_ledger(f.code().unwrap_or_default())
        } else {
            Refusal::Other(format!("svc-ledger post failed: {}", f.message()))
        }
    })?;
    // A ledger answering a reused key with the original transaction: only this movement settles the run.
    if !booked_matches(d.t, &tx, &from_account, &to_account, spare)? {
        return Ok(RoundUpOutcome::Refused {
            amount: spare,
            reason: OUTCOME_UNKNOWN.to_owned(),
        });
    }
    with(d.store(), |c| {
        c.execute(
            &format!(
                "UPDATE bank.auto_invest_runs SET status = 'settled', ledger_tx_id = $2, rejection_code = NULL, \
                 settled_at = {} WHERE id = $1::text::uuid",
                at("$3")
            ),
            &[&run_id, &tx.id, &now.0],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(RoundUpOutcome::SettledSpace {
        amount: spare,
        space_id: space_id.to_owned(),
        ledger_tx_id: tx.id,
    })
}

/// A definite ledger refusal carried as a cause, so the run records the ledger's own code.
fn refuse_ledger(code: &str) -> Refusal {
    Refusal::Trpc(service_kit::trpc::TrpcError::caused(
        "BAD_REQUEST",
        format!("svc-ledger refused: {code}"),
        code,
    ))
}

/// `roundUpAtPartner`: ONE partner move under `bank.transfer.own:roundup:<rule>:<authorization>:0`, nothing posted to
/// the ledger. If this crashes after the partner moved and before the run settles, the money is in the person's own
/// space at the partner, and the next drive finds the move under the key and settles on it.
#[allow(clippy::too_many_arguments, reason = "one move's facts, each named")]
fn round_up_at_partner(
    d: &Deps<'_>,
    partner: &crate::partner::custody::Held<'_>,
    run_id: &str,
    transfer_id: &str,
    space_id: &str,
    from: AccountRef,
    to: AccountRef,
    spare: Amount,
) -> Result<RoundUpOutcome, Refusal> {
    let key = bank_transfer_key("own", transfer_id, 0);
    let moved = match partner.move_by_key(&key) {
        Some(m) => m,
        None => partner.move_(
            &MoveRequest {
                key,
                from: from.clone(),
                to: to.clone(),
                amount: spare,
                payees: None,
            },
            d.now(),
        )?,
    };
    if moved.from != from || moved.to != to || moved.amount != spare {
        return Ok(RoundUpOutcome::Refused {
            amount: spare,
            reason: OUTCOME_UNKNOWN.to_owned(),
        });
    }
    with(d.store(), |c| {
        c.execute(
            &format!(
                "UPDATE bank.auto_invest_runs SET status = 'settled', partner_move_id = $2, rejection_code = NULL, \
                 settled_at = {} WHERE id = $1::text::uuid",
                at("$3")
            ),
            &[&run_id, &moved.id, &d.now().0],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(RoundUpOutcome::SettledPartner {
        amount: spare,
        space_id: space_id.to_owned(),
        partner_move_id: moved.id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use service_kit::time::js_date;

    fn amt(s: &str) -> Amount {
        parse_amount(s).unwrap_or_default()
    }

    #[test]
    fn spare_change_rounds_4_30_to_the_next_1_00_as_0_70() {
        assert_eq!(format_amount(spare_change(amt("4.30"), amt("1"))), "0.7");
    }

    #[test]
    fn spare_change_of_an_exact_multiple_is_zero_nothing_to_sweep() {
        assert_eq!(spare_change(amt("5"), amt("1")), 0);
    }

    #[test]
    fn spare_change_with_a_non_positive_granularity_is_zero_rather_than_inventing_a_unit() {
        assert_eq!(spare_change(amt("4.30"), 0), 0);
    }

    #[test]
    fn a_month_keeps_its_day_clamped_to_the_month_end() {
        let at = |s: &str| js_date(s).unwrap_or(Instant(0));
        assert_eq!(
            advance_cadence(at("2026-01-31T10:00:00.000Z"), "monthly").iso(),
            "2026-02-28T10:00:00.000Z"
        );
        assert_eq!(
            advance_cadence(at("2026-12-15T00:00:00.000Z"), "monthly").iso(),
            "2027-01-15T00:00:00.000Z"
        );
        assert_eq!(
            advance_cadence(at("2026-08-09T00:00:00.000Z"), "weekly").iso(),
            "2026-08-16T00:00:00.000Z"
        );
    }

    #[test]
    fn every_code_the_part_refuses_with_is_a_bank_error_code() {
        for code in [
            RATE_UNSET,
            DISABLED,
            RUN_FAILED,
            "bank.auto_invest_not_found",
            "bank.auto_invest_inactive",
            "bank.auto_invest_invalid_threshold",
            "bank.auto_invest_roundup_exists",
            "bank.auto_invest_target_invalid",
            "bank.auto_invest_list_limit_unset",
            "bank.auto_invest_batch_limit_unset",
            "bank.convert_markets_limit_unset",
            "bank.not_owner",
            "bank.below_minimum",
            "bank.same_space",
            "bank.pool_closed",
            "bank.asset_mismatch",
            "bank.no_partner_bank",
            "bank.partner_custody_mismatch",
        ] {
            assert!(
                matches!(refuse(code, "m"), Refusal::Bank(_)),
                "{code} is no BankError code"
            );
        }
    }
}
