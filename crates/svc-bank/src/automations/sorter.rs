//! Part `sorter` of the automations slice (`sorter/`): the income sorter (`sorter.router.ts`, `income-sorter.ts`), its
//! sweep job (`POST /internal/jobs/run-income-sorter`) and the hand-off from a posted send (`onCreditPosted`).
//!
//! A payment from another person into the account is split across the person's own named spaces by percentage, once.
//! The sorter is an instruction; the credit is the posted row in `bank.personal_transfers`; each split is an own-space
//! `bankTransfer` recipe from the account into one space, keyed `sorter:<sorter>:<credit ledger tx>` with the leg's
//! position as its occurrence. Whatever is not sorted stays in the account. No balance lives here.
//!
//! Two paths drive a credit, and both end in the same keys: the send that posted it (right after the post) and the
//! sweep, which picks up a credit whose send crashed before sorting and any split whose outcome was unknown. A credit
//! has one run, ever (`income_sorter_runs.credit_transfer_id` is unique). The owner decides whether credits are sorted
//! at all and from what size (`BANK_INCOME_SORTER_MIN_CREDIT`); blank refuses a sorter and sorts no credit.
//!
//! If this crashes exactly here, whose funds are stranded? No one's: a split posted and not yet recorded is found under
//! its key by the next drive, and one never posted is posted then; the credit itself stays in the account until a split
//! moves it.

use postgres::{GenericClient, Row};
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::schema::Value;
use service_kit::server::Response;
use service_kit::time::Instant;

use super::Deps;
use crate::door::Ctx;
use crate::door::jobs::{job_failed, ok};
use crate::door::rest::reply;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::ports::{LedgerAccount, PostFailure};
use crate::spaces::space::{self, at, in_tx, pg, with};
use crate::transfers;
use crate::transfers::holds::POST_IN_FLIGHT_BOUND_SECONDS;
use crate::transfers::moves::{
    bank_transfer_key, booked_matches, find_primary, post_bank_transfer, resolve_for_credit,
    resolve_for_debit,
};
use crate::transfers::ports::{CreditPosted, IncomingCredit};

/// `SORTER_MAX_LEGS`.
pub const SORTER_MAX_LEGS: usize = 10;
const FULL_BP: i64 = 10_000;
/// `SWEEP_AFTER_MS`: a run younger than this is left to the send that made it.
const SWEEP_AFTER_MS: i64 = 60_000;

/// `/internal/jobs/run-income-sorter`.
pub const RUN_INCOME_SORTER: &str = "/internal/jobs/run-income-sorter";

/// What the binary hands this part.
#[derive(Default, Clone)]
pub struct Wiring {
    /// `BANK_INCOME_SORTER_MIN_CREDIT`: the owner's smallest sorted payment. No default: blank refuses a sorter.
    pub min_credit: Option<String>,
}

impl Wiring {
    pub fn none() -> Wiring {
        Wiring::default()
    }

    /// The hand-off the transfers slice is given (`onCreditPosted: (credit) => sorter.sortCredit(credit)`).
    pub fn hand_off(&self) -> HandOff {
        HandOff {
            min_credit: self.min_credit.clone(),
        }
    }
}

/// The send's hand-off to the recipient's sorter, holding the owner's minimum as the sorter reads it.
pub struct HandOff {
    pub min_credit: Option<String>,
}

impl CreditPosted for HandOff {
    fn credit_posted(
        &self,
        d: &transfers::Deps<'_>,
        credit: &IncomingCredit,
    ) -> Result<(), Refusal> {
        Sorter {
            t: d,
            min_credit: self.min_credit.as_deref(),
        }
        .sort_credit(credit)
        .map(|_| ())
    }
}

/// `parseMinCredit`: blank or not a non-negative decimal is not a decision.
pub fn parse_min_credit(raw: Option<&str>) -> Option<Amount> {
    let v = service_kit::money::js_trim(raw?);
    let (int, frac) = v.split_once('.').map_or((v, None), |(i, f)| (i, Some(f)));
    let ok = !int.is_empty()
        && int.bytes().all(|b| b.is_ascii_digit())
        && frac
            .is_none_or(|f| (1..=18).contains(&f.len()) && f.bytes().all(|b| b.is_ascii_digit()));
    if !ok {
        return None;
    }
    parse_amount(v).ok()
}

/// `legShare`: one leg's share of a credit, rounded down at the ledger's scale.
pub fn leg_share(credit: Amount, share_bp: i64) -> Amount {
    credit * Amount::from(share_bp) / Amount::from(FULL_BP)
}

/// `sorterTransferId`: the ledger key's transfer id for one credit under one sorter.
pub fn sorter_transfer_id(sorter_id: &str, credit_tx_id: &str) -> String {
    format!("sorter:{sorter_id}:{credit_tx_id}")
}

/// `SorterLeg` (with the listed space's name and whether it was archived since, when listed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Leg {
    pub space_id: String,
    pub share_bp: i64,
}

/// `IncomeSorter`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncomeSorter {
    pub id: String,
    pub user_id: String,
    pub asset_id: String,
    pub status: String,
    pub legs: Vec<Leg>,
    pub created_at: Instant,
    pub cancelled_at: Option<Instant>,
}

impl IncomeSorter {
    /// `viewOf`, each leg given its fields (`listedView` adds the space's name and archive state).
    fn view(&self, leg: impl Fn(&Leg) -> Json) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("assetId", Json::str(self.asset_id.clone())),
            ("status", Json::str(self.status.clone())),
            ("legs", Json::Array(self.legs.iter().map(leg).collect())),
            ("createdAt", Json::str(self.created_at.iso())),
            (
                "cancelledAt",
                self.cancelled_at.map_or(Json::Null, |c| Json::str(c.iso())),
            ),
        ])
    }

    pub fn json(&self) -> Json {
        self.view(|l| {
            Json::obj([
                ("spaceId", Json::str(l.space_id.clone())),
                ("shareBp", Json::int(l.share_bp)),
            ])
        })
    }
}

/// `SorterRunLeg`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunLeg {
    pub position: i64,
    pub space_id: String,
    pub amount: Amount,
    pub status: String,
    pub ledger_tx_id: Option<String>,
    pub rejection_code: Option<String>,
    pub settled_at: Option<Instant>,
}

/// `SorterRun`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    pub id: String,
    pub sorter_id: String,
    pub credit_transfer_id: String,
    pub credit_tx_id: String,
    pub credit_amount: Amount,
    pub credit_posted_at: Instant,
    pub skipped_reason: Option<String>,
    pub created_at: Instant,
    pub legs: Vec<RunLeg>,
}

impl Run {
    /// `runOf`.
    pub fn json(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            (
                "creditTransferId",
                Json::str(self.credit_transfer_id.clone()),
            ),
            ("creditTxId", Json::str(self.credit_tx_id.clone())),
            ("creditAmount", Json::str(format_amount(self.credit_amount))),
            ("creditPostedAt", Json::str(self.credit_posted_at.iso())),
            (
                "skippedReason",
                self.skipped_reason.clone().map_or(Json::Null, Json::str),
            ),
            ("createdAt", Json::str(self.created_at.iso())),
            (
                "legs",
                Json::Array(
                    self.legs
                        .iter()
                        .map(|l| {
                            Json::obj([
                                ("position", Json::int(l.position)),
                                ("spaceId", Json::str(l.space_id.clone())),
                                ("amount", Json::str(format_amount(l.amount))),
                                ("status", Json::str(l.status.clone())),
                                (
                                    "ledgerTxId",
                                    l.ledger_tx_id.clone().map_or(Json::Null, Json::str),
                                ),
                                (
                                    "rejectionCode",
                                    l.rejection_code.clone().map_or(Json::Null, Json::str),
                                ),
                            ])
                        })
                        .collect(),
                ),
            ),
        ])
    }
}

/// `SortOutcome`: `Unsorted` moved and recorded nothing (`no_sorter`, `own_money`); `Recorded` is the credit's one run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SortOutcome {
    Unsorted(&'static str),
    Recorded(Run),
}

/// `SorterSweepReport`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SweepReport {
    pub credits_recorded: i64,
    pub runs_driven: i64,
    pub legs_still_pending: i64,
}

impl SweepReport {
    pub fn json(&self) -> Json {
        Json::obj([
            ("creditsRecorded", Json::int(self.credits_recorded)),
            ("runsDriven", Json::int(self.runs_driven)),
            ("legsStillPending", Json::int(self.legs_still_pending)),
        ])
    }
}

fn ms(col: &str) -> String {
    format!("floor(extract(epoch from {col}) * 1000)::int8")
}

fn sorter_cols(t: &str) -> String {
    format!(
        "{t}id::text, {t}user_id, {t}asset_id, {t}status, {}, {}",
        ms(&format!("{t}created_at")),
        ms(&format!("{t}cancelled_at"))
    )
}

fn run_cols(t: &str) -> String {
    format!(
        "{t}id::text, {t}sorter_id::text, {t}credit_transfer_id, {t}credit_tx_id, {t}credit_amount::text, {}, \
         {t}skipped_reason, {}",
        ms(&format!("{t}credit_posted_at")),
        ms(&format!("{t}created_at"))
    )
}

fn run_leg_cols() -> String {
    format!(
        "run_id::text, position, space_id::text, amount::text, status, ledger_tx_id, rejection_code, {}",
        ms("settled_at")
    )
}

fn g<T: for<'a> postgres::types::FromSql<'a>>(r: &Row, i: usize) -> Result<T, Refusal> {
    r.try_get(i).map_err(|e| pg(&e))
}

fn amount_at(r: &Row, i: usize) -> Result<Amount, Refusal> {
    parse_amount(&g::<String>(r, i)?).map_err(Refusal::Other)
}

/// A sorter row of [`sorter_cols`], with no legs yet.
fn sorter_row(r: &Row) -> Result<IncomeSorter, Refusal> {
    Ok(IncomeSorter {
        id: g(r, 0)?,
        user_id: g(r, 1)?,
        asset_id: g(r, 2)?,
        status: g(r, 3)?,
        legs: Vec::new(),
        created_at: Instant(g(r, 4)?),
        cancelled_at: g::<Option<i64>>(r, 5)?.map(Instant),
    })
}

fn legs_of(c: &mut impl GenericClient, sorter_id: &str) -> Result<Vec<Leg>, Refusal> {
    let rows = c
        .query(
            "SELECT space_id::text, share_bp FROM bank.income_sorter_legs \
              WHERE sorter_id = $1::text::uuid ORDER BY position",
            &[&sorter_id],
        )
        .map_err(|e| pg(&e))?;
    rows.iter()
        .map(|r| {
            Ok(Leg {
                space_id: g(r, 0)?,
                share_bp: i64::from(g::<i32>(r, 1)?),
            })
        })
        .collect()
}

fn find_sorter(c: &mut impl GenericClient, id: &str) -> Result<Option<IncomeSorter>, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.income_sorters WHERE id = $1::text::uuid",
                sorter_cols("")
            ),
            &[&id],
        )
        .map_err(|e| pg(&e))?;
    let Some(r) = rows.first() else {
        return Ok(None);
    };
    let mut s = sorter_row(r)?;
    s.legs = legs_of(c, id)?;
    Ok(Some(s))
}

/// A run row of [`run_cols`], with no legs yet.
fn run_row(r: &Row) -> Result<Run, Refusal> {
    Ok(Run {
        id: g(r, 0)?,
        sorter_id: g(r, 1)?,
        credit_transfer_id: g(r, 2)?,
        credit_tx_id: g(r, 3)?,
        credit_amount: amount_at(r, 4)?,
        credit_posted_at: Instant(g(r, 5)?),
        skipped_reason: g(r, 6)?,
        created_at: Instant(g(r, 7)?),
        legs: Vec::new(),
    })
}

fn run_leg_row(r: &Row) -> Result<(String, RunLeg), Refusal> {
    Ok((
        g(r, 0)?,
        RunLeg {
            position: i64::from(g::<i16>(r, 1)?),
            space_id: g(r, 2)?,
            amount: amount_at(r, 3)?,
            status: g(r, 4)?,
            ledger_tx_id: g(r, 5)?,
            rejection_code: g(r, 6)?,
            settled_at: g::<Option<i64>>(r, 7)?.map(Instant),
        },
    ))
}

fn not_found(sorter_id: &str) -> Refusal {
    refuse(
        "bank.sorter_not_found",
        format!("Sorter {sorter_id} not found"),
    )
}

fn invalid(message: impl Into<String>) -> Refusal {
    refuse("bank.sorter_invalid", message)
}

/// `isDefiniteLedgerRefusal(err) && provesPostNotCommitted(err)`: a typed refusal the ledger makes before committing, on
/// its one attempt. A freeze or an outage is not final.
fn definite_refusal(f: &PostFailure) -> Option<&str> {
    const DEFINITE: [&str; 4] = [
        "ledger.insufficient_funds",
        "ledger.invalid_entry",
        "ledger.unbalanced",
        "ledger.owner_identity_space",
    ];
    let code = f.code()?;
    (DEFINITE.contains(&code) && f.proves_not_committed()).then_some(code)
}

fn log(event: &str, fields: Vec<(&str, Json)>) {
    let mut f = vec![
        ("level".to_owned(), Json::str("error")),
        ("service".to_owned(), Json::str("svc-bank")),
        ("event".to_owned(), Json::str(event)),
    ];
    f.extend(fields.into_iter().map(|(k, v)| (k.to_owned(), v)));
    eprintln!("{}", Json::Object(f).compact());
}

/// `IncomeSorterService`: the store, the ledger and the spaces as the transfers slice reads them, and the owner's
/// minimum.
pub struct Sorter<'a> {
    pub t: &'a transfers::Deps<'a>,
    pub min_credit: Option<&'a str>,
}

impl Sorter<'_> {
    /// `minimumCredit`: the owner's smallest sorted credit, or none while the owner has published none.
    pub fn minimum_credit(&self) -> Option<Amount> {
        parse_min_credit(self.min_credit)
    }

    /// `minCredit`: blank refuses: the owner has not said credits are sorted at all.
    fn min_credit(&self) -> Result<Amount, Refusal> {
        self.minimum_credit().ok_or_else(|| {
            refuse(
                "bank.sorter_terms_unset",
                "The bank has not published when incoming payments are sorted (bank.sorter_terms_unset)",
            )
        })
    }

    /// `create`: the account's sorter for one asset. The client's `sorterId` makes a retry the same sorter; one live
    /// sorter per asset (`bank.sorter_exists`).
    pub fn create(
        &self,
        user_id: &str,
        sorter_id: &str,
        asset_id: &str,
        legs: &[Leg],
    ) -> Result<IncomeSorter, Refusal> {
        self.min_credit()?;
        if legs.is_empty() || legs.len() > SORTER_MAX_LEGS {
            return Err(invalid(format!(
                "A sorter has 1 to {SORTER_MAX_LEGS} spaces"
            )));
        }
        for (i, leg) in legs.iter().enumerate() {
            if legs.iter().take(i).any(|l| l.space_id == leg.space_id) {
                return Err(invalid("Each space appears once in a sorter"));
            }
        }
        let mut total = 0;
        for leg in legs {
            if !(1..=FULL_BP).contains(&leg.share_bp) {
                return Err(invalid(
                    "Each share is a whole number of basis points from 1 to 10000",
                ));
            }
            total += leg.share_bp;
        }
        if total > FULL_BP {
            // `total / 100` as JavaScript prints it: whole basis points are at most two decimals.
            let cents = format!("{:02}", total % 100);
            let cents = cents.trim_end_matches('0');
            let percent = if cents.is_empty() {
                (total / 100).to_string()
            } else {
                format!("{}.{cents}", total / 100)
            };
            return Err(invalid(format!(
                "The shares total {percent}%, more than 100% (bank.sorter_invalid)"
            )));
        }
        for leg in legs {
            self.own_target_space(user_id, &leg.space_id, asset_id)?;
        }
        in_tx(self.t.store, |tx| {
            tx.execute(
                "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
                &[&user_id, &format!("sorter:{asset_id}")],
            )
            .map_err(|e| pg(&e))?;
            if let Some(existing) = find_sorter(tx, sorter_id)? {
                if existing.user_id != user_id
                    || existing.asset_id != asset_id
                    || existing.legs != legs
                {
                    return Err(refuse(
                        "bank.sorter_conflict",
                        format!("Sorter {sorter_id} already exists on different terms"),
                    ));
                }
                return Ok(existing);
            }
            let live = tx
                .query(
                    "SELECT id FROM bank.income_sorters WHERE user_id = $1 AND asset_id = $2 AND status = 'active'",
                    &[&user_id, &asset_id],
                )
                .map_err(|e| pg(&e))?;
            if !live.is_empty() {
                return Err(refuse(
                    "bank.sorter_exists",
                    format!("This account already sorts {asset_id}; cancel that sorter first"),
                ));
            }
            tx.execute(
                "INSERT INTO bank.income_sorters (id, user_id, asset_id, status) VALUES ($1::text::uuid, $2, $3, 'active')",
                &[&sorter_id, &user_id, &asset_id],
            )
            .map_err(|e| pg(&e))?;
            for (position, leg) in legs.iter().enumerate() {
                let position = i16::try_from(position).unwrap_or(i16::MAX);
                let share = i32::try_from(leg.share_bp).unwrap_or(i32::MAX);
                tx.execute(
                    "INSERT INTO bank.income_sorter_legs (sorter_id, position, space_id, share_bp) \
                     VALUES ($1::text::uuid, $2, $3::text::uuid, $4)",
                    &[&sorter_id, &position, &leg.space_id, &share],
                )
                .map_err(|e| pg(&e))?;
            }
            find_sorter(tx, sorter_id)?
                .ok_or_else(|| Refusal::Other(format!("sorter {sorter_id} not written")))
        })
    }

    /// `cancel`: stop sorting. Credits already sorted stay where they went.
    pub fn cancel(&self, user_id: &str, sorter_id: &str) -> Result<IncomeSorter, Refusal> {
        let sorter = self.own(user_id, sorter_id)?;
        if sorter.status == "cancelled" {
            return Ok(sorter);
        }
        with(self.t.store, |c| {
            c.execute(
                &format!(
                    "UPDATE bank.income_sorters SET status = 'cancelled', cancelled_at = {} \
                      WHERE id = $1::text::uuid AND status = 'active'",
                    at("$2")
                ),
                &[&sorter_id, &self.t.now.0],
            )
            .map_err(|e| pg(&e))
        })?;
        self.own(user_id, sorter_id)
    }

    /// `list`: the account's live sorters, each space named, and whether it has been archived since.
    pub fn list(&self, user_id: &str) -> Result<Vec<Json>, Refusal> {
        with(self.t.store, |c| {
            let rows = c
                .query(
                    &format!(
                        "SELECT {} FROM bank.income_sorters WHERE user_id = $1 AND status = 'active' ORDER BY asset_id",
                        sorter_cols("")
                    ),
                    &[&user_id],
                )
                .map_err(|e| pg(&e))?;
            let mut out = Vec::new();
            for r in &rows {
                let mut s = sorter_row(r)?;
                let legs = c
                    .query(
                        "SELECT l.space_id::text, l.share_bp, sp.name, sp.archived_at IS NOT NULL \
                           FROM bank.income_sorter_legs l JOIN bank.spaces sp ON sp.id = l.space_id \
                          WHERE l.sorter_id = $1::text::uuid ORDER BY l.position",
                        &[&s.id],
                    )
                    .map_err(|e| pg(&e))?;
                let mut named = Vec::new();
                for l in &legs {
                    s.legs.push(Leg {
                        space_id: g(l, 0)?,
                        share_bp: i64::from(g::<i32>(l, 1)?),
                    });
                    named.push((g::<String>(l, 2)?, g::<bool>(l, 3)?));
                }
                let view = s.view(|leg| {
                    let (name, archived) = s
                        .legs
                        .iter()
                        .position(|x| x == leg)
                        .and_then(|i| named.get(i))
                        .cloned()
                        .unwrap_or_default();
                    Json::obj([
                        ("spaceId", Json::str(leg.space_id.clone())),
                        ("shareBp", Json::int(leg.share_bp)),
                        ("spaceName", Json::str(name)),
                        ("archived", Json::Bool(archived)),
                    ])
                });
                out.push(view);
            }
            Ok(out)
        })
    }

    /// `runs`: what each sorted credit came to, newest first. Another person's sorter reads as not found.
    pub fn runs(&self, user_id: &str, sorter_id: &str, limit: i64) -> Result<Vec<Run>, Refusal> {
        self.own(user_id, sorter_id)?;
        let rows = with(self.t.store, |c| {
            let rows = c
                .query(
                    &format!(
                        "SELECT {} FROM bank.income_sorter_runs WHERE sorter_id = $1::text::uuid \
                          ORDER BY created_at DESC, id LIMIT $2",
                        run_cols("")
                    ),
                    &[&sorter_id, &limit],
                )
                .map_err(|e| pg(&e))?;
            rows.iter().map(run_row).collect::<Result<Vec<_>, _>>()
        })?;
        self.with_legs(rows)
    }

    /// `sortCredit`: sort one posted credit. Called by the send that posted it and by the sweep; both are safe to
    /// repeat. A credit that reaches a live sorter gets one run, ever: split into legs, or skipped with its reason. A
    /// refused split never fails the call: it is recorded `rejected` with its code and its share stays in the account.
    pub fn sort_credit(&self, credit: &IncomingCredit) -> Result<SortOutcome, Refusal> {
        if credit.from_user_id == credit.to_user_id {
            return Ok(SortOutcome::Unsorted("own_money"));
        }
        if let Some(existing) = self.run_for_credit(&credit.transfer_id)? {
            return Ok(SortOutcome::Recorded(
                self.drive(&existing, &credit.to_user_id)?,
            ));
        }
        let sorter = with(self.t.store, |c| {
            let rows = c
                .query(
                    &format!(
                        "SELECT {} FROM bank.income_sorters \
                          WHERE user_id = $1 AND asset_id = $2 AND status = 'active' AND created_at <= {}",
                        sorter_cols(""),
                        at("$3")
                    ),
                    &[&credit.to_user_id, &credit.asset_id, &credit.posted_at.0],
                )
                .map_err(|e| pg(&e))?;
            let Some(r) = rows.first() else {
                return Ok(None);
            };
            let mut s = sorter_row(r)?;
            s.legs = legs_of(c, &s.id)?;
            Ok(Some(s))
        })?;
        let Some(sorter) = sorter else {
            return Ok(SortOutcome::Unsorted("no_sorter"));
        };
        let skipped = match self.minimum_credit() {
            None => Some("terms_unset"),
            Some(min) if credit.amount < min => Some("below_minimum"),
            Some(_) => None,
        };
        let created = in_tx(self.t.store, |tx| {
            let rows = tx
                .query(
                    &format!(
                        "INSERT INTO bank.income_sorter_runs \
                           (sorter_id, credit_transfer_id, credit_tx_id, credit_amount, credit_posted_at, skipped_reason) \
                         VALUES ($1::text::uuid, $2, $3, $4::text::numeric, {}, $6) \
                         ON CONFLICT (credit_transfer_id) DO NOTHING RETURNING {}",
                        at("$5"),
                        run_cols("")
                    ),
                    &[
                        &sorter.id,
                        &credit.transfer_id,
                        &credit.ledger_tx_id,
                        &format_amount(credit.amount),
                        &credit.posted_at.0,
                        &skipped,
                    ],
                )
                .map_err(|e| pg(&e))?;
            let Some(r) = rows.first() else {
                return Ok(None);
            };
            let run = run_row(r)?;
            if skipped.is_some() {
                return Ok(Some(run));
            }
            for (position, leg) in sorter.legs.iter().enumerate() {
                let share = leg_share(credit.amount, leg.share_bp);
                if share <= 0 {
                    continue;
                }
                let position = i16::try_from(position).unwrap_or(i16::MAX);
                tx.execute(
                    "INSERT INTO bank.income_sorter_run_legs (run_id, position, space_id, amount, status) \
                     VALUES ($1::text::uuid, $2, $3::text::uuid, $4::text::numeric, 'pending')",
                    &[&run.id, &position, &leg.space_id, &format_amount(share)],
                )
                .map_err(|e| pg(&e))?;
            }
            Ok(Some(run))
        })?;
        // Another path made this credit's run first: drive that one, never a second.
        let run = match created {
            Some(r) => r,
            None => self.run_for_credit(&credit.transfer_id)?.ok_or_else(|| {
                refuse(
                    "bank.sorter_split_failed",
                    format!("No sorter run for {}", credit.transfer_id),
                )
            })?,
        };
        Ok(SortOutcome::Recorded(self.drive(&run, &credit.to_user_id)?))
    }

    /// `sweep`: record posted credits that reached a live sorter but have no run (the send crashed after its post), then
    /// drive the splits still pending in runs older than a minute, least recently tried first. A split still pending
    /// once its run is older than the in-flight bound is logged for an operator.
    pub fn sweep(&self, limit: i64, now: Instant) -> Result<SweepReport, Refusal> {
        let mut report = SweepReport::default();
        let unsorted = with(self.t.store, |c| {
            let rows = c
                .query(
                    &format!(
                        "SELECT t.transfer_id, t.from_user_id, t.to_user_id, t.asset_id, t.amount::text, t.ledger_tx_id, {} \
                           FROM bank.income_sorters s \
                           JOIN bank.personal_transfers t \
                             ON t.to_user_id = s.user_id AND t.asset_id = s.asset_id AND t.status = 'posted' \
                            AND t.posted_at >= s.created_at \
                          WHERE s.status = 'active' \
                            AND t.from_user_id <> t.to_user_id \
                            AND NOT EXISTS (SELECT 1 FROM bank.income_sorter_runs r WHERE r.credit_transfer_id = t.transfer_id) \
                            AND NOT EXISTS (SELECT 1 FROM bank.received_holds h WHERE h.transfer_id = t.transfer_id AND h.state <> 'lapsed') \
                          ORDER BY t.posted_at \
                          LIMIT $1",
                        ms("t.posted_at")
                    ),
                    &[&limit],
                )
                .map_err(|e| pg(&e))?;
            rows.iter()
                .map(|r| {
                    Ok(IncomingCredit {
                        transfer_id: g(r, 0)?,
                        from_user_id: g(r, 1)?,
                        to_user_id: g(r, 2)?,
                        asset_id: g(r, 3)?,
                        amount: amount_at(r, 4)?,
                        // A send the partner moved has no ledger transaction; the TypeScript's insert of its run fails on it.
                        ledger_tx_id: g::<Option<String>>(r, 5)?.ok_or_else(|| {
                            Refusal::Other("a posted credit with no ledger transaction".to_owned())
                        })?,
                        posted_at: Instant(g(r, 6)?),
                    })
                })
                .collect::<Result<Vec<_>, Refusal>>()
        })?;
        for credit in &unsorted {
            if matches!(self.sort_credit(credit)?, SortOutcome::Recorded(_)) {
                report.credits_recorded += 1;
            }
        }
        let before = now.0 - SWEEP_AFTER_MS;
        let pending = with(self.t.store, |c| {
            let rows = c
                .query(
                    &format!(
                        "SELECT {}, s.user_id \
                           FROM bank.income_sorter_runs r \
                           JOIN bank.income_sorters s ON s.id = r.sorter_id \
                          WHERE r.created_at < {} \
                            AND EXISTS (SELECT 1 FROM bank.income_sorter_run_legs l WHERE l.run_id = r.id AND l.status = 'pending') \
                          ORDER BY r.driven_at NULLS FIRST, r.created_at \
                          LIMIT $2",
                        run_cols("r."),
                        at("$1")
                    ),
                    &[&before, &limit],
                )
                .map_err(|e| pg(&e))?;
            rows.iter()
                .map(|r| Ok((run_row(r)?, g::<String>(r, 8)?)))
                .collect::<Result<Vec<_>, Refusal>>()
        })?;
        for (row, user_id) in &pending {
            let run = self.drive(row, user_id)?;
            report.runs_driven += 1;
            let stuck: Vec<i64> = run
                .legs
                .iter()
                .filter(|l| l.status == "pending")
                .map(|l| l.position)
                .collect();
            report.legs_still_pending += i64::try_from(stuck.len()).unwrap_or(i64::MAX);
            // A split waiting out the in-flight bound after a lost post is ordinary recovery. One still pending once its
            // run is older than the bound is for an operator.
            if !stuck.is_empty()
                && crate::door::system_now().0 - run.created_at.0
                    >= POST_IN_FLIGHT_BOUND_SECONDS * 1000
            {
                log(
                    "bank.sorter_split_pending",
                    vec![
                        ("runId", Json::str(run.id.clone())),
                        ("creditTxId", Json::str(run.credit_tx_id.clone())),
                        (
                            "positions",
                            Json::Array(stuck.iter().map(|p| Json::int(*p)).collect()),
                        ),
                    ],
                );
            }
        }
        Ok(report)
    }

    /// `drive`: post every pending split of one run, in order, and answer the run as it now stands.
    fn drive(&self, run: &Run, user_id: &str) -> Result<Run, Refusal> {
        let asset = with(self.t.store, |c| find_sorter(c, &run.sorter_id))?
            .ok_or_else(|| Refusal::Other(format!("sorter {} is gone", run.sorter_id)))?
            .asset_id;
        let legs = self.legs_of_runs(std::slice::from_ref(&run.id))?;
        let owed: Vec<&RunLeg> = legs
            .iter()
            .map(|(_, l)| l)
            .filter(|l| l.status == "pending")
            .collect();
        for leg in &owed {
            self.drive_leg(run, &asset, user_id, leg)?;
        }
        if !owed.is_empty() {
            with(self.t.store, |c| {
                c.execute(
                    "UPDATE bank.income_sorter_runs SET driven_at = now() WHERE id = $1::text::uuid",
                    &[&run.id],
                )
                .map_err(|e| pg(&e))
            })?;
        }
        let mut settled = self.with_legs(vec![run.clone()])?;
        settled
            .pop()
            .ok_or_else(|| Refusal::Other(format!("run {} is gone", run.id)))
    }

    fn mark(&self, run: &Run, leg: &RunLeg, sql: &str, value: &str) -> Result<(), Refusal> {
        let position = i16::try_from(leg.position).unwrap_or(i16::MAX);
        with(self.t.store, |c| {
            c.execute(
                &format!(
                    "UPDATE bank.income_sorter_run_legs SET {sql}, settled_at = {} \
                      WHERE run_id = $1::text::uuid AND position = $2 AND status = 'pending'",
                    at("$4")
                ),
                &[&run.id, &position, &value, &self.t.now.0],
            )
            .map_err(|e| pg(&e))?;
            Ok(())
        })
    }

    fn settle(&self, run: &Run, leg: &RunLeg, ledger_tx_id: &str) -> Result<(), Refusal> {
        self.mark(
            run,
            leg,
            "status = 'settled', ledger_tx_id = $3, rejection_code = NULL",
            ledger_tx_id,
        )
    }

    fn reject(&self, run: &Run, leg: &RunLeg, code: &str) -> Result<(), Refusal> {
        self.mark(run, leg, "status = 'rejected', rejection_code = $3", code)
    }

    /// `driveLeg`: one split, an own-space `bankTransfer` from the account into the space. The key is read first: a
    /// split whose earlier post landed settles on that booking, whatever has happened to the spaces since. With nothing
    /// under the key, the split claims an attempt and reads the key again before it decides; while an earlier attempt is
    /// younger than the ledger's in-flight bound, it waits. Past the bound with nothing under the key, a refused space or
    /// a typed refusal that proves this one attempt committed nothing rejects the split with its code. A frozen or
    /// unreachable ledger, or a failing space read, leaves it pending.
    fn drive_leg(
        &self,
        run: &Run,
        asset_id: &str,
        user_id: &str,
        leg: &RunLeg,
    ) -> Result<(), Refusal> {
        let d = self.t;
        let transfer_id = sorter_transfer_id(&run.sorter_id, &run.credit_tx_id);
        let key = bank_transfer_key("own", &transfer_id, leg.position);
        // The account itself and the space, as `accountForSpace` names a primary and a named space.
        let settled_on_booking = || -> Result<bool, Refusal> {
            let Some(booked) = d.ledger.tx_by_key(&key).map_err(Refusal::Other)? else {
                return Ok(false);
            };
            if booked_matches(
                d,
                &booked,
                &LedgerAccount::user_available(user_id, asset_id),
                &LedgerAccount::sub_account_available(&leg.space_id, asset_id),
                leg.amount,
            )? {
                self.settle(run, leg, &booked.id)?;
            }
            Ok(true)
        };
        if settled_on_booking()? {
            return Ok(());
        }

        // Resolving the spaces posts nothing, so it comes before the claim: a failing read never stamps an attempt.
        let resolved = with(d.store, |c| {
            let primary = find_primary(c, user_id, asset_id)?.ok_or_else(|| {
                refuse(
                    "bank.space_not_found",
                    format!("No {asset_id} account to sort from"),
                )
            })?;
            let from = resolve_for_debit(c, &primary.id, d.now)?;
            let to = resolve_for_credit(d, c, &leg.space_id, Some(user_id), None)?;
            if to.user_id != user_id || to.kind != "named" {
                return Err(space::not_found(&leg.space_id));
            }
            if to.asset_id != asset_id {
                return Err(refuse(
                    "bank.asset_mismatch",
                    format!(
                        "Sorter asset {asset_id} does not match space asset {}",
                        to.asset_id
                    ),
                ));
            }
            Ok((from.ledger_account(), to.ledger_account()))
        });
        let (accounts, refused) = match resolved {
            Ok(a) => (Some(a), None),
            Err(Refusal::Bank(e)) => (None, Some(e.row.code)),
            Err(_) => return Ok(()),
        };

        // On the database clock, in one statement, so two drivers never both post.
        let position = i16::try_from(leg.position).unwrap_or(i16::MAX);
        let claimed = with(d.store, |c| {
            c.query(
                "UPDATE bank.income_sorter_run_legs SET attempted_at = now() \
                  WHERE run_id = $1::text::uuid AND position = $2 AND status = 'pending' \
                    AND (attempted_at IS NULL OR attempted_at < now() - make_interval(secs => $3::int8)) \
                 RETURNING position",
                &[&run.id, &position, &POST_IN_FLIGHT_BOUND_SECONDS],
            )
            .map_err(|e| pg(&e))
        })?;
        if claimed.is_empty() {
            return Ok(());
        }
        // An earlier post may have landed between the first read and the claim.
        if settled_on_booking()? {
            return Ok(());
        }
        if let Some(code) = refused {
            return self.reject(run, leg, code);
        }
        let Some((from, to)) = accounts else {
            return Ok(());
        };
        match post_bank_transfer(d, &transfer_id, leg.position, &from, &to, leg.amount, "own") {
            Ok(tx) => {
                if booked_matches(d, &tx, &from, &to, leg.amount)? {
                    self.settle(run, leg, &tx.id)?;
                }
                Ok(())
            }
            Err(f) => match definite_refusal(&f) {
                Some(code) => self.reject(run, leg, code),
                None => Ok(()),
            },
        }
    }

    fn run_for_credit(&self, transfer_id: &str) -> Result<Option<Run>, Refusal> {
        with(self.t.store, |c| {
            let rows = c
                .query(
                    &format!(
                        "SELECT {} FROM bank.income_sorter_runs WHERE credit_transfer_id = $1",
                        run_cols("")
                    ),
                    &[&transfer_id],
                )
                .map_err(|e| pg(&e))?;
            rows.first().map(run_row).transpose()
        })
    }

    fn legs_of_runs(&self, ids: &[String]) -> Result<Vec<(String, RunLeg)>, Refusal> {
        with(self.t.store, |c| {
            let rows = c
                .query(
                    &format!(
                        "SELECT {} FROM bank.income_sorter_run_legs \
                          WHERE run_id = ANY($1::text[]::uuid[]) ORDER BY position",
                        run_leg_cols()
                    ),
                    &[&ids],
                )
                .map_err(|e| pg(&e))?;
            rows.iter().map(run_leg_row).collect()
        })
    }

    fn with_legs(&self, mut runs: Vec<Run>) -> Result<Vec<Run>, Refusal> {
        if runs.is_empty() {
            return Ok(runs);
        }
        let ids: Vec<String> = runs.iter().map(|r| r.id.clone()).collect();
        let legs = self.legs_of_runs(&ids)?;
        for run in &mut runs {
            run.legs = legs
                .iter()
                .filter(|(id, _)| *id == run.id)
                .map(|(_, l)| l.clone())
                .collect();
        }
        Ok(runs)
    }

    /// `own`: the person's own sorter; another person's reads as not found.
    fn own(&self, user_id: &str, sorter_id: &str) -> Result<IncomeSorter, Refusal> {
        match with(self.t.store, |c| find_sorter(c, sorter_id))? {
            Some(s) if s.user_id == user_id => Ok(s),
            _ => Err(not_found(sorter_id)),
        }
    }

    /// `ownTargetSpace`: one of the person's own live named spaces of `asset_id`.
    fn own_target_space(
        &self,
        user_id: &str,
        space_id: &str,
        asset_id: &str,
    ) -> Result<(), Refusal> {
        let s = with(self.t.store, |c| space::get(c, space_id))?;
        if s.user_id != user_id {
            return Err(space::not_found(space_id));
        }
        if s.kind != "named" {
            return Err(invalid(
                "What is not sorted stays in the account, so the account itself is not a sorter space",
            ));
        }
        if s.archived_at.is_some() {
            return Err(space::archived(&s.name));
        }
        if s.asset_id != asset_id {
            return Err(refuse(
                "bank.asset_mismatch",
                format!(
                    "Sorter asset {asset_id} does not match space asset {}",
                    s.asset_id
                ),
            ));
        }
        Ok(())
    }
}

fn sorter_of<'a>(d: &'a Deps<'a>) -> Sorter<'a> {
    Sorter {
        t: d.t,
        min_credit: d.w.sorter.min_credit.as_deref(),
    }
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "whole numbers the schema checked"
)]
fn int(v: &Value) -> i64 {
    v.as_number().map_or(0, |n| n as i64)
}

/// This part's calls; `None` for any other call.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let call = ctx.call.path.strip_prefix("sorter.")?;
    if !matches!(call, "list" | "runs" | "create" | "cancel") {
        return None;
    }
    let Some(principal) = ctx.principal else {
        return Some(Err(Refusal::Other("no principal".to_owned())));
    };
    let user = principal.user_id.as_str();
    let input = &ctx.input;
    let sorter = sorter_of(d);
    let text = |k: &str| input.get(k).as_str().unwrap_or_default().to_owned();
    Some(match call {
        "list" => (|| {
            let terms = match sorter.minimum_credit() {
                None => Json::obj([
                    ("state", Json::str("not_set")),
                    ("code", Json::str("bank.sorter_terms_unset")),
                ]),
                Some(min) => Json::obj([
                    ("state", Json::str("set")),
                    ("minCredit", Json::str(format_amount(min))),
                ]),
            };
            Ok(Json::obj([
                ("terms", terms),
                ("sorters", Json::Array(sorter.list(user)?)),
            ]))
        })(),
        "runs" => sorter
            .runs(user, &text("sorterId"), int(input.get("limit")))
            .map(|runs| Json::Array(runs.iter().map(Run::json).collect())),
        "create" => (|| {
            crate::spaces::router::offers(d.t.partner, user, "pots")?;
            let legs: Vec<Leg> = input
                .get("legs")
                .as_array()
                .unwrap_or_default()
                .iter()
                .map(|l| Leg {
                    space_id: l.get("spaceId").as_str().unwrap_or_default().to_owned(),
                    share_bp: int(l.get("shareBp")),
                })
                .collect();
            // The schema trims the asset.
            let asset = text("assetId");
            sorter
                .create(user, &text("sorterId"), &asset, &legs)
                .map(|s| s.json())
        })(),
        _ => (|| {
            crate::spaces::router::offers(d.t.partner, user, "pots")?;
            sorter.cancel(user, &text("sorterId")).map(|s| s.json())
        })(),
    })
}

/// This part's job door past the signature (`jobDoor`): `incomeSorterBody`, then one sweep; a `BankError` is 400.
pub fn job(d: &Deps<'_>, path: &str, body: &Value) -> Option<Response> {
    if path != RUN_INCOME_SORTER {
        return None;
    }
    let Some(limit) = super::rules::notices_body(body) else {
        return Some(reply(400, "body not in shape", "bank.validation_failed"));
    };
    Some(match sorter_of(d).sweep(limit, d.now()) {
        Ok(report) => ok(&report.json()),
        Err(r) => job_failed(r),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_owner_minimum_is_a_non_negative_decimal_or_nothing() {
        assert_eq!(parse_min_credit(None), None);
        assert_eq!(parse_min_credit(Some("  ")), None);
        assert_eq!(parse_min_credit(Some("-1")), None);
        assert_eq!(parse_min_credit(Some("1.")), None);
        assert_eq!(parse_min_credit(Some(" 1 ")), parse_amount("1").ok());
        assert_eq!(parse_min_credit(Some("0.5")), parse_amount("0.5").ok());
    }

    #[test]
    fn a_share_rounds_down_at_the_ledger_scale() {
        let credit = parse_amount("10.01").unwrap_or_default();
        assert_eq!(format_amount(leg_share(credit, 3333)), "3.336333");
        assert_eq!(sorter_transfer_id("s", "tx-1"), "sorter:s:tx-1");
    }
}
