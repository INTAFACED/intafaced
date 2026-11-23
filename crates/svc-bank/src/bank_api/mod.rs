//! Slice `bank-api` (`PORT.md`): the bank API a person's own program calls with an API key they approved
//! with a second factor, or the person signed in (`developer-api/bank-api.ts`; J-bank-24, BK-bdev-01, BK-bdev-02).
//!
//! The money is the partner bank's, so:
//! - an account's figure is the partner's, with its time; a figure it has not reported is "not known", never 0;
//! - a move between the person's own accounts is made on the partner's quote, as ONE partner move under the business
//!   key `bank.api.move:<user>:<dedupe id>`, written as an intent row first: a lost answer keeps the row, and a retry
//!   under the same dedupe id asks again under the same key, on the same stored terms, so it is made once;
//! - a payment out (instant or ACH) is the partner's, over its rail, under `pay:<user>:<idempotency key>`, written as an
//!   intent row before the partner is asked; with no rail it is kept refused with `rail.bank`;
//! - each change of a payment's state the partner reports is kept once per (payment, version) and delivered to each of
//!   the person's webhook endpoints once, signed, carrying the previous and current state; a replayed report adds
//!   nothing.
//!
//! The ledger posts nothing for any of it, and the API reaches nothing the app does not: a locked pot refuses
//! `bank.space_locked`, only a shared pot's owner takes money out of it, and the posting freeze and partner stop guard every
//! partner move (the guarded custody, `partner::custody`).
//!
//! - this module: the service (`BankApiService`); [`router`]: the calls (`router/bank-api.router.ts`) and the TEST
//!   partner's `testPartner.settlePayment`; [`url_guard`] and [`pinned_post`]: the webhook URL guard and the one POST to
//!   vetted addresses.
//!
//! Where the port is not the TypeScript's yet, and must be before the switch: a recorded state change asks the
//! deliveries to be posted by the binary's webhook worker ([`Wiring::kick`], [`run_kicked`]) where the TypeScript posts
//! them from the request's own process after answering; either way a crash before the post leaves the delivery due, and
//! the recovery job posts it. Two drains at once wait for each other here, where the TypeScript's second caller shares
//! the first one's result; leases keep each delivery posted once either way.

pub mod pinned_post;
pub mod router;
pub mod url_guard;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use hmac::{Hmac, Mac};
use postgres::{GenericClient, Row};
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::Instant;
use sha2::Sha256;

use crate::db::Store;
use crate::errors::Refusal;
use crate::partner::custody::{Custody, Held};
use crate::partner::{
    AccountRef, Balance, MoveRequest, MovesQuery, Payment, PaymentRequest, STALE_AFTER_MS,
    TestPartner, refuse,
};
use crate::spaces::ports::Ledger;
use crate::spaces::shared::{assert_may_add_to, assert_may_take_out, role_of};
use crate::spaces::space::{self, Money, Space, at, in_tx, lock_end, pg, with};
use crate::transfers::moves::{custody_mismatch, resolve_for_debit};
use pinned_post::{PinnedPost, PinnedTransport, Transport};
use url_guard::{Resolver, assert_public_webhook_url, resolve_public_addresses, system_resolver};

/// `API_ACCOUNT_TYPES`.
pub const ACCOUNT_TYPES: [&str; 3] = ["standard", "savings", "joint"];
/// The partner's answers that mean the payment was not made and never will be under this key (`DEFINITE_REFUSALS`).
const DEFINITE_REFUSALS: [&str; 5] = [
    "rail.bank",
    "bank.partner_insufficient_funds",
    "bank.partner_amount_invalid",
    "bank.account_restricted",
    "bank.asset_mismatch",
];
/// How many of the partner's moves are read for spend-today (`SPEND_PAGE`).
const SPEND_PAGE: usize = 1_000;
/// How long a claimed delivery is held before another worker may post it (`LEASE_MS`).
const LEASE_MS: i64 = 60_000;
/// How many deliveries one claim takes (`DRAIN_BATCH`).
pub const DRAIN_BATCH: i64 = 20;
const DAY_MS: i64 = 86_400_000;

/// `MOVE_KEY`.
pub fn move_key(user_id: &str, dedupe_id: &str) -> String {
    format!("bank.api.move:{user_id}:{dedupe_id}")
}

/// `PAY_KEY`.
pub fn pay_key(user_id: &str, key: &str) -> String {
    format!("pay:{user_id}:{key}")
}

/// `EVENT_ID`.
pub fn event_id(payment_id: &str, version: i32) -> String {
    format!("bank.transfer.state_changed:{payment_id}:{version}")
}

/// What the door holds for the slice (`BankApiOptions`), built once at start-up.
pub struct Wiring {
    /// dev/test only: a webhook endpoint on loopback, over http, is allowed (the URL guard's hatch).
    pub allow_local_http: bool,
    pub transport: Box<dyn Transport>,
    pub resolver: Box<Resolver>,
    /// How long one delivery attempt may take.
    pub timeout_ms: u64,
    draining: Mutex<()>,
    kicked: Mutex<bool>,
    kick: Condvar,
}

impl Wiring {
    /// The service's: the real wire, the system's resolver (bounded), ten seconds an attempt.
    pub fn new(allow_local_http: bool) -> Wiring {
        Wiring::with(
            allow_local_http,
            Box::new(PinnedTransport),
            Box::new(system_resolver),
        )
    }

    /// A wiring with its own transport and resolver (a test's).
    pub fn with(
        allow_local_http: bool,
        transport: Box<dyn Transport>,
        resolver: Box<Resolver>,
    ) -> Wiring {
        Wiring {
            allow_local_http,
            transport,
            resolver,
            timeout_ms: 10_000,
            draining: Mutex::new(()),
            kicked: Mutex::new(false),
            kick: Condvar::new(),
        }
    }

    /// Production posture: no loopback hatch.
    pub fn none() -> Wiring {
        Wiring::new(false)
    }

    /// Asks the webhook worker to post what is due: a state change was just recorded.
    pub fn kick(&self) {
        if let Ok(mut k) = self.kicked.lock() {
            *k = true;
            self.kick.notify_all();
        }
    }

    /// Waits up to `timeout` for a kick; true when one came (and clears it).
    pub fn wait_kick(&self, timeout: Duration) -> bool {
        let Ok(guard) = self.kicked.lock() else {
            return false;
        };
        let Ok((mut guard, _)) = self.kick.wait_timeout_while(guard, timeout, |k| !*k) else {
            return false;
        };
        std::mem::take(&mut *guard)
    }
}

/// What a call, the recovery job or the worker hands the slice.
pub struct Deps<'a> {
    pub store: &'a Store,
    pub ledger: &'a dyn Ledger,
    pub custody: &'a Custody<'a>,
    /// The TEST partner itself, for its settle door only (`testPartner.settlePayment`).
    pub test_partner: Option<&'a TestPartner>,
    pub w: &'a Wiring,
    pub now: Instant,
    /// The clock a webhook's timestamp and delivery time are read from.
    pub clock: fn() -> Instant,
}

fn bank_error(code: &str, message: impl Into<String>) -> Refusal {
    refuse(code, message)
}

fn conflict(what: &str) -> Refusal {
    bank_error(
        "bank.idempotency_conflict",
        format!("This {what} was already used for a different instruction. Nothing was moved."),
    )
}

fn amount_text(raw: &str) -> Result<String, Refusal> {
    parse_amount(raw).map(format_amount).map_err(Refusal::Other)
}

fn ms_col(col: &str) -> String {
    format!("floor(extract(epoch from {col}) * 1000)::int8")
}

fn iso(at: Option<Instant>) -> Json {
    at.map_or(Json::Null, |a| Json::str(a.iso()))
}

fn opt_str(v: Option<String>) -> Json {
    v.map_or(Json::Null, Json::str)
}

/// `partnerOf`: the guarded partner that holds the person's money, or `bank.no_partner_bank`.
fn partner_of<'a>(d: &'a Deps<'a>, user_id: &str) -> Result<Held<'a>, Refusal> {
    d.custody.bank_for(user_id).ok_or_else(|| {
        bank_error(
            "bank.no_partner_bank",
            "The bank API reads and moves money the partner bank holds, and none is held there for you.",
        )
    })
}

// ── Accounts (#2) ─────────────────────────────────────────────────────────────────────────────────────────────────

/// `partnerFigure`: the one displayed figure of a partner balance (`heldFigure`): its amount, state and time.
fn figure(b: &Balance, now: Instant) -> (Option<String>, &'static str, Option<Instant>) {
    match (b.amount, b.as_of) {
        (None, as_of) => (None, "unknown", as_of),
        (Some(_), None) => (None, "unknown", None),
        (Some(amount), Some(as_of)) => {
            let age = now.0 - as_of.0;
            if age < -STALE_AFTER_MS {
                return (None, "unknown", Some(as_of));
            }
            let state = if age > STALE_AFTER_MS {
                "stale"
            } else {
                "known"
            };
            (Some(format_amount(amount)), state, Some(as_of))
        }
    }
}

/// `spentToday`: what left `account` since today's UTC midnight on the partner's record, newest first, or none when
/// the page read does not reach midnight.
fn spent_today(
    moves: &[crate::partner::Move],
    account: &AccountRef,
    now: Instant,
) -> Option<String> {
    let start = now.0 - now.0.rem_euclid(DAY_MS);
    let mut spent: Amount = 0;
    for m in moves {
        if m.moved_at.0 < start {
            return Some(format_amount(spent));
        }
        // Money that left this account for anyone else's, or a payment out: not a move between the owner's own.
        if m.from == *account && m.to.user_id != account.user_id {
            spent = spent.saturating_add(m.amount);
        }
    }
    (moves.len() < SPEND_PAGE).then(|| format_amount(spent))
}

/// `accounts`: the caller's accounts at the partner: each currency's main balance (`standard`), their own pots
/// (`savings`), and every pot shared between people that they own or are a member of (`joint`), filtered by `type`.
pub fn accounts(
    d: &Deps<'_>,
    user_id: &str,
    kind: Option<&str>,
    limit: i64,
) -> Result<Json, Refusal> {
    let partner = partner_of(d, user_id)?;
    let money = Money {
        ledger: d.ledger,
        custody: d.custody,
        now: d.now,
    };
    let own = space::list(
        d.store,
        &money,
        user_id,
        None,
        space::spaces_list_limit(Some(limit as f64))?,
    )?;
    let own_pots: Vec<String> = own
        .iter()
        .filter(|s| s.kind == "named")
        .map(|s| s.id.clone())
        .collect();
    let (joint_own, member_of) = with(d.store, |c| {
        let joint_own: Vec<String> = if own_pots.is_empty() {
            Vec::new()
        } else {
            c.query(
                "SELECT DISTINCT space_id::text FROM bank.shared_pot_members WHERE space_id::text = ANY($1)",
                &[&own_pots],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(|r| r.get(0))
            .collect()
        };
        let member_of: Vec<String> = c
            .query(
                "SELECT m.space_id::text FROM bank.shared_pot_members m JOIN bank.spaces s ON s.id = m.space_id \
                 WHERE m.user_id = $1 AND s.archived_at IS NULL AND s.removed_at IS NULL \
                 ORDER BY m.joined_at, m.space_id LIMIT $2",
                &[&user_id, &limit],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(|r| r.get(0))
            .collect();
        Ok((joint_own, member_of))
    })?;
    let mut theirs = Vec::new();
    for id in &member_of {
        theirs.push(with(d.store, |c| space::get(c, id))?);
    }
    let typed: Vec<(Space, &'static str)> = own
        .into_iter()
        .filter(|s| s.archived_at.is_none())
        .map(|s| {
            let t = if s.kind == "primary" {
                "standard"
            } else if joint_own.contains(&s.id) {
                "joint"
            } else {
                "savings"
            };
            (s, t)
        })
        .chain(theirs.into_iter().map(|s| (s, "joint")))
        .filter(|(_, t)| kind.is_none_or(|k| k == *t))
        .take(usize::try_from(limit).unwrap_or(0))
        .collect();
    let mut moves_of: Vec<(String, Vec<crate::partner::Move>)> = Vec::new();
    let mut out = Vec::new();
    for (s, t) in typed {
        if d.custody.bank_for(&s.user_id).is_none() {
            return Err(custody_mismatch());
        }
        let account = s.partner_account();
        let (balance, state, as_of) = figure(&partner.balance(&account, d.now), d.now);
        if !moves_of.iter().any(|(u, _)| *u == s.user_id) {
            let page = partner.moves(
                &s.user_id,
                &MovesQuery {
                    limit: SPEND_PAGE,
                    ..MovesQuery::default()
                },
            );
            moves_of.push((s.user_id.clone(), page));
        }
        let moves = moves_of
            .iter()
            .find(|(u, _)| *u == s.user_id)
            .map(|(_, m)| m.as_slice())
            .unwrap_or_default();
        let locked_until = lock_end(s.locked_until, s.unlocks_at, d.now);
        out.push(Json::obj([
            ("id", Json::str(s.id.clone())),
            ("type", Json::str(t)),
            ("name", Json::str(s.name.clone())),
            ("assetId", Json::str(s.asset_id.clone())),
            (
                "owner",
                Json::str(if s.user_id == user_id {
                    "self"
                } else {
                    "other"
                }),
            ),
            ("heldAt", Json::str(partner.label())),
            ("balance", opt_str(balance)),
            ("figure", Json::str(state)),
            ("asOf", iso(as_of)),
            ("spendToday", opt_str(spent_today(moves, &account, d.now))),
            ("locked", Json::Bool(locked_until.is_some())),
            ("lockedUntil", iso(locked_until)),
        ]));
    }
    Ok(Json::obj([("items", Json::Array(out))]))
}

// ── Moves on a quote (#3) ─────────────────────────────────────────────────────────────────────────────────────────

/// The two accounts of a move, checked as the app's own transfer door checks them. Locked or archived refuses here.
fn sides<'a>(
    d: &'a Deps<'a>,
    user_id: &str,
    from_id: &str,
    to_id: &str,
) -> Result<(Space, Space, Held<'a>), Refusal> {
    if from_id == to_id {
        return Err(bank_error(
            "bank.same_space",
            "A transfer needs two different spaces",
        ));
    }
    let (from, to) = with(d.store, |c| {
        let from = resolve_for_debit(c, from_id, d.now)?;
        if from.user_id != user_id {
            // A shared pot's member is told only the owner takes money out; anyone else's space is not found.
            assert_may_take_out(c, user_id, &from.id, &from.user_id)?;
            return Err(space::not_found(from_id));
        }
        let to = space::get(c, to_id)?;
        if to.archived_at.is_some() {
            return Err(space::archived(&to.name));
        }
        if to.user_id != user_id {
            if role_of(c, &to.id, user_id)?.is_none() {
                return Err(space::not_found(to_id));
            }
            assert_may_add_to(c, user_id, &to.id)?;
        }
        Ok((from, to))
    })?;
    let partner = partner_of(d, user_id)?;
    if d.custody.bank_for(&to.user_id).is_none() {
        return Err(custody_mismatch());
    }
    if from.asset_id != to.asset_id {
        return Err(bank_error(
            "bank.asset_mismatch",
            format!(
                "Cannot move {} into a {} account. Nothing was moved.",
                from.asset_id, to.asset_id
            ),
        ));
    }
    Ok((from, to, partner))
}

const QUOTE_COLS: &str = "quote_id, user_id, from_space_id::text, to_space_id::text, asset_id, amount::text, \
     fee::text, receives::text, label";

/// One kept quote (`QuoteRow`).
struct QuoteRow {
    quote_id: String,
    from_space_id: String,
    to_space_id: String,
    asset_id: String,
    amount: String,
    fee: Option<String>,
    receives: Option<String>,
    label: String,
    quoted_at: Instant,
    valid_until: Instant,
}

fn quote_cols() -> String {
    format!(
        "{QUOTE_COLS}, {}, {}",
        ms_col("quoted_at"),
        ms_col("valid_until")
    )
}

impl QuoteRow {
    fn from_row(r: &Row) -> Result<QuoteRow, Refusal> {
        let g = |e: postgres::Error| pg(&e);
        Ok(QuoteRow {
            quote_id: r.try_get(0).map_err(g)?,
            from_space_id: r.try_get(2).map_err(g)?,
            to_space_id: r.try_get(3).map_err(g)?,
            asset_id: r.try_get(4).map_err(g)?,
            amount: r.try_get(5).map_err(g)?,
            fee: r.try_get(6).map_err(g)?,
            receives: r.try_get(7).map_err(g)?,
            label: r.try_get(8).map_err(g)?,
            quoted_at: Instant(r.try_get(9).map_err(g)?),
            valid_until: Instant(r.try_get(10).map_err(g)?),
        })
    }

    /// `quoteView`.
    fn view(&self) -> Result<Json, Refusal> {
        let opt = |v: &Option<String>| -> Result<Json, Refusal> {
            Ok(match v {
                None => Json::Null,
                Some(t) => Json::str(amount_text(t)?),
            })
        };
        Ok(Json::obj([
            ("quoteId", Json::str(self.quote_id.clone())),
            ("fromAccountId", Json::str(self.from_space_id.clone())),
            ("toAccountId", Json::str(self.to_space_id.clone())),
            ("assetId", Json::str(self.asset_id.clone())),
            ("amount", Json::str(amount_text(&self.amount)?)),
            ("fee", opt(&self.fee)?),
            ("receives", opt(&self.receives)?),
            ("heldAt", Json::str(self.label.clone())),
            ("quotedAt", Json::str(self.quoted_at.iso())),
            ("validUntil", Json::str(self.valid_until.iso())),
        ]))
    }
}

/// `quote`: the partner's quote for moving `amount` from one of the caller's accounts to another, kept with its exact
/// figures.
pub fn quote(
    d: &Deps<'_>,
    user_id: &str,
    from_id: &str,
    to_id: &str,
    amount: Amount,
) -> Result<Json, Refusal> {
    let (from, to, partner) = sides(d, user_id, from_id, to_id)?;
    let q = partner.quote_move(
        &from.partner_account(),
        &to.partner_account(),
        amount,
        d.now,
    )?;
    let fee = q.fee.map(format_amount);
    let receives = q.receives.map(format_amount);
    let row = with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "INSERT INTO bank.api_move_quotes \
                     (quote_id, user_id, from_space_id, to_space_id, asset_id, amount, fee, receives, label, quoted_at, valid_until) \
                     VALUES ($1, $2, $3::text::uuid, $4::text::uuid, $5, $6::text::numeric, $7::text::numeric, $8::text::numeric, $9, {}, {}) \
                     RETURNING {}",
                    at("$10"),
                    at("$11"),
                    quote_cols()
                ),
                &[
                    &q.quote_id,
                    &user_id,
                    &from.id,
                    &to.id,
                    &from.asset_id,
                    &format_amount(q.amount),
                    &fee,
                    &receives,
                    &q.label,
                    &q.quoted_at.0,
                    &q.valid_until.0,
                ],
            )
            .map_err(|e| pg(&e))?;
        rows.first()
            .map(QuoteRow::from_row)
            .ok_or_else(|| Refusal::Other("no quote row".to_owned()))?
    })?;
    row.view()
}

fn quote_row(d: &Deps<'_>, user_id: &str, quote_id: &str) -> Result<QuoteRow, Refusal> {
    with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.api_move_quotes WHERE quote_id = $1 AND user_id = $2",
                    quote_cols()
                ),
                &[&quote_id, &user_id],
            )
            .map_err(|e| pg(&e))?;
        rows.first().map(QuoteRow::from_row).transpose()
    })?
    .ok_or_else(|| bank_error("bank.quote_not_found", "No quote by that id is yours."))
}

/// One move asked through the API (`MoveRow`).
struct MoveRow {
    dedupe_id: String,
    quote_id: String,
    partner_key: String,
    state: String,
    partner_move_id: Option<String>,
    completed_at: Option<Instant>,
}

fn move_cols() -> String {
    format!(
        "dedupe_id, quote_id, partner_key, state, partner_move_id, {}",
        ms_col("completed_at")
    )
}

impl MoveRow {
    fn from_row(r: &Row) -> Result<MoveRow, Refusal> {
        let g = |e: postgres::Error| pg(&e);
        Ok(MoveRow {
            dedupe_id: r.try_get(0).map_err(g)?,
            quote_id: r.try_get(1).map_err(g)?,
            partner_key: r.try_get(2).map_err(g)?,
            state: r.try_get(3).map_err(g)?,
            partner_move_id: r.try_get(4).map_err(g)?,
            completed_at: r.try_get::<_, Option<i64>>(5).map_err(g)?.map(Instant),
        })
    }

    fn view(&self, quote: &QuoteRow) -> Result<Json, Refusal> {
        Ok(Json::obj([
            ("dedupeId", Json::str(self.dedupe_id.clone())),
            ("quote", quote.view()?),
            ("state", Json::str(self.state.clone())),
            ("partnerMoveId", opt_str(self.partner_move_id.clone())),
            ("completedAt", iso(self.completed_at)),
        ]))
    }
}

fn move_row(
    c: &mut impl GenericClient,
    user_id: &str,
    dedupe_id: &str,
) -> Result<Option<MoveRow>, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.api_moves WHERE user_id = $1 AND dedupe_id = $2",
                move_cols()
            ),
            &[&user_id, &dedupe_id],
        )
        .map_err(|e| pg(&e))?;
    rows.first().map(MoveRow::from_row).transpose()
}

/// `move`: makes the move on a quote, once per dedupe id. The intent row is written before the partner is asked; the same
/// id with another quote refuses `bank.idempotency_conflict`; the same id again answers with the same move. A pending row (the
/// partner's answer was lost) is asked again under the same key on the stored quote, whatever its valid-until.
pub fn make_move(
    d: &Deps<'_>,
    user_id: &str,
    quote_id: &str,
    dedupe_id: &str,
) -> Result<Json, Refusal> {
    let quote = quote_row(d, user_id, quote_id)?;
    let mut row = with(d.store, |c| move_row(c, user_id, dedupe_id))?;
    if row.as_ref().is_some_and(|r| r.quote_id != quote_id) {
        return Err(conflict("dedupe id"));
    }
    if let Some(r) = row.as_ref().filter(|r| r.state == "completed") {
        return r.view(&quote);
    }
    let (from, to, partner) = sides(d, user_id, &quote.from_space_id, &quote.to_space_id)?;
    let row = match row.take() {
        Some(r) => r,
        None => {
            if quote.valid_until.0 <= d.now.0 {
                return Err(bank_error(
                    "bank.quote_expired",
                    "This quote is past its valid-until. Ask for a new quote. Nothing was moved.",
                ));
            }
            if quote.fee.is_none() {
                return Err(bank_error(
                    "bank.partner_fee_unknown",
                    "The partner bank does not say what this move costs, so it is not made. Nothing was moved.",
                ));
            }
            let won =
                with(d.store, |c| {
                    c.execute(
                    "INSERT INTO bank.api_moves (user_id, dedupe_id, quote_id, partner_key, state) \
                     VALUES ($1, $2, $3, $4, 'pending') ON CONFLICT DO NOTHING",
                    &[&user_id, &dedupe_id, &quote_id, &move_key(user_id, dedupe_id)],
                )
                .map_err(|e| pg(&e))?;
                    // No conflict target: partner_key is MOVE_KEY of (user_id, dedupe_id), so both unique keys name the same
                    // row, and a call that loses the insert race reads the row that won instead of failing on partner_key.
                    move_row(c, user_id, dedupe_id)
                })?;
            let Some(won) = won.filter(|r| r.quote_id == quote_id) else {
                return Err(conflict("dedupe id"));
            };
            if won.state == "completed" {
                return won.view(&quote);
            }
            won
        }
    };
    // If this crashes after the partner moved and before the row is updated, the retry asks under the same key and the
    // partner answers with the move it made: one move, never two.
    let amount = parse_amount(&quote.amount).map_err(Refusal::Other)?;
    let moved = partner.move_(
        &MoveRequest {
            key: row.partner_key.clone(),
            from: from.partner_account(),
            to: to.partner_account(),
            amount,
            payees: None,
        },
        d.now,
    )?;
    let done = with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "UPDATE bank.api_moves SET state = 'completed', partner_move_id = $3, completed_at = {} \
                     WHERE user_id = $1 AND dedupe_id = $2 RETURNING {}",
                    at("$4"),
                    move_cols()
                ),
                &[&user_id, &dedupe_id, &moved.id, &moved.moved_at.0],
            )
            .map_err(|e| pg(&e))?;
        rows.first()
            .map(MoveRow::from_row)
            .ok_or_else(|| Refusal::Other("no move row".to_owned()))?
    })?;
    done.view(&quote)
}

// ── Payments (#4) ─────────────────────────────────────────────────────────────────────────────────────────────────

/// A payment's recipient (`PartnerPaymentRecipient`): name, account number, routing number.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recipient {
    pub name: String,
    pub account_number: String,
    pub routing_number: String,
}

impl Recipient {
    fn json(&self) -> Json {
        Json::obj([
            ("name", Json::str(self.name.clone())),
            ("accountNumber", Json::str(self.account_number.clone())),
            ("routingNumber", Json::str(self.routing_number.clone())),
        ])
    }
}

/// One payment out asked through the API (`PaymentRow`).
#[derive(Debug, Clone)]
pub struct PaymentRow {
    pub id: String,
    pub user_id: String,
    pub idempotency_key: String,
    pub partner_key: String,
    pub from_space_id: String,
    pub asset_id: String,
    pub method: String,
    pub recipient: Recipient,
    pub amount: String,
    pub state: String,
    pub refusal_code: Option<String>,
    pub partner_payment_id: Option<String>,
    pub version: i32,
    pub created_at: Instant,
    pub updated_at: Instant,
}

fn payment_cols() -> String {
    format!(
        "id::text, user_id, idempotency_key, partner_key, from_space_id::text, asset_id, method, \
         recipient->>'name', recipient->>'accountNumber', recipient->>'routingNumber', amount::text, state, refusal_code, \
         partner_payment_id, version, {}, {}",
        ms_col("created_at"),
        ms_col("updated_at")
    )
}

impl PaymentRow {
    fn from_row(r: &Row) -> Result<PaymentRow, Refusal> {
        let g = |e: postgres::Error| pg(&e);
        Ok(PaymentRow {
            id: r.try_get(0).map_err(g)?,
            user_id: r.try_get(1).map_err(g)?,
            idempotency_key: r.try_get(2).map_err(g)?,
            partner_key: r.try_get(3).map_err(g)?,
            from_space_id: r.try_get(4).map_err(g)?,
            asset_id: r.try_get(5).map_err(g)?,
            method: r.try_get(6).map_err(g)?,
            recipient: Recipient {
                name: r.try_get(7).map_err(g)?,
                account_number: r.try_get(8).map_err(g)?,
                routing_number: r.try_get(9).map_err(g)?,
            },
            amount: r.try_get(10).map_err(g)?,
            state: r.try_get(11).map_err(g)?,
            refusal_code: r.try_get(12).map_err(g)?,
            partner_payment_id: r.try_get(13).map_err(g)?,
            version: r.try_get(14).map_err(g)?,
            created_at: Instant(r.try_get(15).map_err(g)?),
            updated_at: Instant(r.try_get(16).map_err(g)?),
        })
    }
}

/// `paymentView`.
fn payment_view(d: &Deps<'_>, row: &PaymentRow) -> Result<Json, Refusal> {
    Ok(Json::obj([
        ("id", Json::str(row.id.clone())),
        ("idempotencyKey", Json::str(row.idempotency_key.clone())),
        ("fromAccountId", Json::str(row.from_space_id.clone())),
        ("assetId", Json::str(row.asset_id.clone())),
        ("method", Json::str(row.method.clone())),
        ("recipient", row.recipient.json()),
        ("amount", Json::str(amount_text(&row.amount)?)),
        ("state", Json::str(row.state.clone())),
        ("refusalCode", opt_str(row.refusal_code.clone())),
        ("version", Json::int(i64::from(row.version))),
        (
            "heldAt",
            d.custody
                .bank_for(&row.user_id)
                .map_or(Json::Null, |p| Json::str(p.label())),
        ),
        ("createdAt", Json::str(row.created_at.iso())),
        ("updatedAt", Json::str(row.updated_at.iso())),
    ]))
}

/// `refusedAgain`: a refused payment answers its refusal again, by its code.
fn refused_again(row: &PaymentRow) -> Refusal {
    let code = row.refusal_code.as_deref().unwrap_or_default();
    if code == "rail.bank" {
        let rail = if row.method == "ach" {
            "ACH"
        } else {
            "instant"
        };
        return bank_error(
            "rail.bank",
            format!("An {rail} payment needs rail.bank. It is switched off in this build."),
        );
    }
    bank_error(
        code,
        format!("This payment was refused ({code}). Nothing was moved."),
    )
}

/// What a payment out asks.
pub struct PaymentAsk<'a> {
    pub idempotency_key: &'a str,
    pub from_account_id: &'a str,
    pub method: &'a str,
    pub recipient: Recipient,
    pub amount: Amount,
}

/// `createPayment`: one payment out, once per idempotency key. The intent row is written before the partner is asked. With
/// no rail the row is kept refused with `rail.bank`, and the same key answers the same refusal. A partner answer that may have
/// been made (a lost reply, a pause) keeps the row `asked`, and the same key asks again under the same business key.
pub fn create_payment(d: &Deps<'_>, user_id: &str, ask: &PaymentAsk<'_>) -> Result<Json, Refusal> {
    let partner = partner_of(d, user_id)?;
    let from = with(d.store, |c| {
        let from = resolve_for_debit(c, ask.from_account_id, d.now)?;
        if from.user_id != user_id {
            assert_may_take_out(c, user_id, &from.id, &from.user_id)?;
            return Err(space::not_found(ask.from_account_id));
        }
        Ok(from)
    })?;
    if d.custody.bank_for(&from.user_id).is_none() {
        return Err(custody_mismatch());
    }
    let row = with(d.store, |c| {
        c.execute(
            "INSERT INTO bank.api_payments \
             (user_id, idempotency_key, partner_key, from_space_id, asset_id, method, recipient, amount, state) \
             VALUES ($1, $2, $3, $4::text::uuid, $5, $6, $7::text::jsonb, $8::text::numeric, 'asked') ON CONFLICT DO NOTHING",
            &[
                &user_id,
                &ask.idempotency_key,
                &pay_key(user_id, ask.idempotency_key),
                &from.id,
                &from.asset_id,
                &ask.method,
                &ask.recipient.json().compact(),
                &format_amount(ask.amount),
            ],
        )
        .map_err(|e| pg(&e))?;
        // No conflict target: partner_key is PAY_KEY of (user_id, idempotency_key), so both unique keys name the same
        // row, and a call that loses the insert race reads the row that won instead of failing on partner_key.
        payment_by_key(c, user_id, ask.idempotency_key)
    })?;
    if row.from_space_id != from.id
        || row.method != ask.method
        || parse_amount(&row.amount).ok() != Some(ask.amount)
        || row.recipient != ask.recipient
    {
        return Err(conflict("idempotency key"));
    }
    if row.state == "refused" {
        return Err(refused_again(&row));
    }
    if row.state != "asked" {
        return payment_view(d, &refresh(d, row)?);
    }
    let made = partner.pay(
        &PaymentRequest {
            key: row.partner_key.clone(),
            from: from.partner_account(),
            method: ask.method.to_owned(),
            recipient: (
                ask.recipient.name.clone(),
                ask.recipient.account_number.clone(),
                ask.recipient.routing_number.clone(),
            ),
            amount: ask.amount,
        },
        d.now,
    );
    match made {
        Ok(made) => payment_view(d, &reported(d, &row, &made)?),
        Err(Refusal::Bank(e)) if DEFINITE_REFUSALS.contains(&e.row.code) => {
            refuse_row(d, &row, e.row.code)?;
            Err(Refusal::Bank(e))
        }
        Err(e) => Err(e),
    }
}

fn refuse_row(d: &Deps<'_>, row: &PaymentRow, code: &str) -> Result<(), Refusal> {
    with(d.store, |c| {
        c.execute(
            "UPDATE bank.api_payments SET state = 'refused', refusal_code = $2, updated_at = now() \
             WHERE id = $1::text::uuid AND state = 'asked'",
            &[&row.id, &code],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })
}

fn payment_by_key(
    c: &mut impl GenericClient,
    user_id: &str,
    key: &str,
) -> Result<PaymentRow, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.api_payments WHERE user_id = $1 AND idempotency_key = $2",
                payment_cols()
            ),
            &[&user_id, &key],
        )
        .map_err(|e| pg(&e))?;
    rows.first()
        .map(PaymentRow::from_row)
        .transpose()?
        .ok_or_else(|| bank_error("bank.payment_not_found", "No payment by that key is yours."))
}

fn payment_row(d: &Deps<'_>, user_id: &str, payment_id: &str) -> Result<PaymentRow, Refusal> {
    with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.api_payments WHERE id = $1::text::uuid AND user_id = $2",
                    payment_cols()
                ),
                &[&payment_id, &user_id],
            )
            .map_err(|e| pg(&e))?;
        rows.first().map(PaymentRow::from_row).transpose()
    })?
    .ok_or_else(|| bank_error("bank.payment_not_found", "No payment by that id is yours."))
}

/// `refresh`: the partner's current word on a payment it made, recorded once per version.
fn refresh(d: &Deps<'_>, row: PaymentRow) -> Result<PaymentRow, Refusal> {
    if row.state == "asked" || row.state == "refused" {
        return Ok(row);
    }
    let now = d
        .custody
        .bank_for(&row.user_id)
        .and_then(|p| p.payment_by_key(&row.partner_key));
    match now {
        Some(p) => reported(d, &row, &p),
        None => Ok(row),
    }
}

/// `reported`: records a payment state the partner reported: a version above the one kept updates the row and keeps the
/// change as one event, with one delivery per live endpoint, in one transaction. The same version again (a replay)
/// changes nothing. A recorded change asks the webhook worker to post its deliveries, after the commit.
pub fn reported(d: &Deps<'_>, row: &PaymentRow, payment: &Payment) -> Result<PaymentRow, Refusal> {
    if payment.key != row.partner_key {
        return Err(custody_mismatch());
    }
    let version = i32::try_from(payment.version).map_err(|e| Refusal::Other(e.to_string()))?;
    let (fresh, recorded) = in_tx(d.store, |tx| {
        let rows = tx
            .query(
                &format!(
                    "SELECT {} FROM bank.api_payments WHERE id = $1::text::uuid FOR UPDATE",
                    payment_cols()
                ),
                &[&row.id],
            )
            .map_err(|e| pg(&e))?;
        let locked = rows
            .first()
            .map(PaymentRow::from_row)
            .ok_or_else(|| Refusal::Other("no payment row".to_owned()))??;
        if version <= locked.version {
            return Ok((locked, false));
        }
        let rows = tx
            .query(
                &format!(
                    "UPDATE bank.api_payments SET state = $2, version = $3, partner_payment_id = $4, updated_at = now() \
                     WHERE id = $1::text::uuid RETURNING {}",
                    payment_cols()
                ),
                &[&row.id, &payment.state, &version, &payment.id],
            )
            .map_err(|e| pg(&e))?;
        let updated = rows
            .first()
            .map(PaymentRow::from_row)
            .ok_or_else(|| Refusal::Other("no payment row".to_owned()))??;
        let event = event_id(&row.id, version);
        let inserted = tx
            .query(
                &format!(
                    "INSERT INTO bank.api_transfer_events \
                     (event_id, user_id, payment_id, version, previous_state, current_state, occurred_at) \
                     VALUES ($1, $2, $3::text::uuid, $4, $5, $6, {}) ON CONFLICT DO NOTHING RETURNING event_id",
                    at("$7")
                ),
                &[
                    &event,
                    &row.user_id,
                    &row.id,
                    &version,
                    &payment.previous,
                    &payment.state,
                    &payment.changed_at.0,
                ],
            )
            .map_err(|e| pg(&e))?;
        if !inserted.is_empty() {
            tx.execute(
                "INSERT INTO bank.api_webhook_deliveries (event_id, endpoint_id, user_id) \
                 SELECT $1, e.id, e.user_id FROM bank.api_webhook_endpoints e \
                 WHERE e.user_id = $2 AND e.disabled_at IS NULL ON CONFLICT DO NOTHING",
                &[&event, &row.user_id],
            )
            .map_err(|e| pg(&e))?;
        }
        Ok((updated, !inserted.is_empty()))
    })?;
    // Posted after the commit; a crash before it leaves the delivery due, and the recovery job posts it.
    if recorded {
        d.w.kick();
    }
    Ok(fresh)
}

/// `getPayment`.
pub fn get_payment(d: &Deps<'_>, user_id: &str, payment_id: &str) -> Result<Json, Refusal> {
    let row = payment_row(d, user_id, payment_id)?;
    payment_view(d, &refresh(d, row)?)
}

/// `listPayments`.
pub fn list_payments(d: &Deps<'_>, user_id: &str, limit: i64) -> Result<Json, Refusal> {
    let rows = with(d.store, |c| {
        c.query(
            &format!(
                "SELECT {} FROM bank.api_payments WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2",
                payment_cols()
            ),
            &[&user_id, &limit],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(PaymentRow::from_row)
        .collect::<Result<Vec<_>, _>>()
    })?;
    let items = rows
        .iter()
        .map(|r| payment_view(d, r))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json::obj([("items", Json::Array(items))]))
}

/// `settleTestPayment`: TEST stack only: the TEST partner reports the payment completed, and the report is recorded as a
/// real partner's would be. Asked again, the partner reports the same version again, which records nothing:
/// `recorded` says which. Answers `testPartner.settlePayment`'s output.
pub fn settle_test_payment(d: &Deps<'_>, user_id: &str, payment_id: &str) -> Result<Json, Refusal> {
    let Some(partner) = d.test_partner else {
        return Err(bank_error(
            "bank.test_partner_off",
            "The TEST partner switches exist only on a stack that runs the TEST partner bank.",
        ));
    };
    let row = payment_row(d, user_id, payment_id)?;
    let Some(partner_payment_id) = row.partner_payment_id.clone() else {
        return Err(bank_error(
            "bank.payment_not_found",
            "The partner made no payment under this key.",
        ));
    };
    let before = row.version;
    let settled = partner
        .lock()
        .settle_payment(user_id, &partner_payment_id, d.now)?;
    let after = reported(d, &row, &settled)?;
    Ok(Json::obj([
        ("paymentId", Json::str(after.id.clone())),
        ("state", Json::str(after.state.clone())),
        ("version", Json::int(i64::from(after.version))),
        ("recorded", Json::Bool(after.version > before)),
    ]))
}

// ── Webhooks (#5) ─────────────────────────────────────────────────────────────────────────────────────────────────

fn url_refusal(e: &url_guard::UrlRefusal) -> Refusal {
    bank_error(url_guard::URL_INVALID, e.message.clone())
}

/// `whsec_` and 32 random bytes in hex.
fn new_secret() -> Result<String, Refusal> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| Refusal::Other(e.to_string()))?;
    Ok(format!("whsec_{}", hex(&bytes)))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

fn endpoint_view(id: String, url: String, created_at: i64, secret: Option<String>) -> Json {
    Json::obj([
        ("id", Json::str(id)),
        ("url", Json::str(url)),
        ("createdAt", Json::str(Instant(created_at).iso())),
        ("secret", opt_str(secret)),
    ])
}

/// `createEndpoint`: adds an endpoint, once per `endpointId`; its signing secret is shown on the create that made it, and never
/// again.
pub fn create_endpoint(
    d: &Deps<'_>,
    user_id: &str,
    endpoint_id: &str,
    url: &str,
) -> Result<Json, Refusal> {
    let url = assert_public_webhook_url(url, d.w.allow_local_http)
        .map_err(|e| url_refusal(&e))?
        .to_string();
    let secret = new_secret()?;
    let created = ms_col("created_at");
    with(d.store, |c| {
        let made = c
            .query(
                &format!(
                    "INSERT INTO bank.api_webhook_endpoints (id, user_id, url, secret) VALUES ($1::text::uuid, $2, $3, $4) \
                     ON CONFLICT (id) DO NOTHING RETURNING id::text, url, {created}"
                ),
                &[&endpoint_id, &user_id, &url, &secret],
            )
            .map_err(|e| pg(&e))?;
        if let Some(r) = made.first() {
            return Ok(endpoint_view(r.get(0), r.get(1), r.get(2), Some(secret)));
        }
        let prior = c
            .query(
                &format!(
                    "SELECT id::text, user_id, url, {created} FROM bank.api_webhook_endpoints WHERE id = $1::text::uuid"
                ),
                &[&endpoint_id],
            )
            .map_err(|e| pg(&e))?;
        match prior.first() {
            Some(r) if r.get::<_, String>(1) == user_id && r.get::<_, String>(2) == url => {
                Ok(endpoint_view(r.get(0), r.get(2), r.get(3), None))
            }
            _ => Err(conflict("endpoint id")),
        }
    })
}

/// `listEndpoints`.
pub fn list_endpoints(d: &Deps<'_>, user_id: &str, limit: i64) -> Result<Json, Refusal> {
    let items = with(d.store, |c| {
        Ok(c.query(
            &format!(
                "SELECT id::text, url, {} FROM bank.api_webhook_endpoints \
                 WHERE user_id = $1 AND disabled_at IS NULL ORDER BY created_at, id LIMIT $2",
                ms_col("created_at")
            ),
            &[&user_id, &limit],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(|r| endpoint_view(r.get(0), r.get(1), r.get(2), None))
        .collect::<Vec<_>>())
    })?;
    Ok(Json::obj([("items", Json::Array(items))]))
}

/// `deliveries`: the caller's deliveries, newest event first, each with its attempts and the endpoint's last answer.
pub fn deliveries(
    d: &Deps<'_>,
    user_id: &str,
    endpoint_id: Option<&str>,
    payment_id: Option<&str>,
    limit: i64,
) -> Result<Json, Refusal> {
    let items = with(d.store, |c| {
        Ok(c.query(
            &format!(
                "SELECT d.event_id, d.endpoint_id::text, e.payment_id::text, e.previous_state, e.current_state, e.version, \
                 d.state, d.attempts, d.last_status, d.last_error, {} \
                 FROM bank.api_webhook_deliveries d JOIN bank.api_transfer_events e ON e.event_id = d.event_id \
                 WHERE d.user_id = $1 \
                 AND ($2::text IS NULL OR d.endpoint_id = $2::text::uuid) \
                 AND ($3::text IS NULL OR e.payment_id = $3::text::uuid) \
                 ORDER BY e.created_at DESC, d.event_id DESC, d.endpoint_id LIMIT $4",
                ms_col("d.delivered_at")
            ),
            &[&user_id, &endpoint_id, &payment_id, &limit],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(|r| {
            Json::obj([
                ("eventId", Json::str(r.get::<_, String>(0))),
                ("endpointId", Json::str(r.get::<_, String>(1))),
                ("paymentId", Json::str(r.get::<_, String>(2))),
                ("previous", opt_str(r.get(3))),
                ("current", Json::str(r.get::<_, String>(4))),
                ("version", Json::int(i64::from(r.get::<_, i32>(5)))),
                ("state", Json::str(r.get::<_, String>(6))),
                ("attempts", Json::int(i64::from(r.get::<_, i32>(7)))),
                (
                    "lastStatus",
                    r.get::<_, Option<i32>>(8)
                        .map_or(Json::Null, |s| Json::int(i64::from(s))),
                ),
                ("lastError", opt_str(r.get(9))),
                ("deliveredAt", iso(r.get::<_, Option<i64>>(10).map(Instant))),
            ])
        })
        .collect::<Vec<_>>())
    })?;
    Ok(Json::obj([("items", Json::Array(items))]))
}

/// One claimed delivery, with what its post carries.
struct Claimed {
    event_id: String,
    endpoint_id: String,
    payment_id: String,
    previous: Option<String>,
    current: String,
    version: i32,
    url: String,
    secret: String,
    amount: String,
    asset_id: String,
    method: String,
    occurred_at: Instant,
}

/// `drain`: posts every delivery that is due, each claimed with a lease so two workers never post one at once, and a crash
/// mid-post leaves the lease to expire and the delivery to be posted again. Every post carries the event id
/// (`x-intafaced-event-id`, also its `idempotency-key`) so a receiver keeps it once. One attempt per delivery: an endpoint that
/// does not take it is marked failed with its answer. Each outcome is `completed` or `open`.
pub fn drain(d: &Deps<'_>, limit: i64) -> Result<Vec<String>, Refusal> {
    let _one =
        d.w.draining
            .lock()
            .map_err(|_| Refusal::Other("bank API drain lock poisoned".to_owned()))?;
    let mut results = Vec::new();
    while i64::try_from(results.len()).unwrap_or(i64::MAX) < limit {
        let claimed = with(d.store, |c| {
            c.query(
                &format!(
                    "WITH due AS ( \
                       SELECT event_id, endpoint_id FROM bank.api_webhook_deliveries \
                        WHERE state = 'pending' AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until <= now()) \
                        ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED \
                     ) \
                     UPDATE bank.api_webhook_deliveries d SET lease_until = now() + ($2::int8 * interval '1 millisecond') \
                       FROM due, bank.api_transfer_events e, bank.api_webhook_endpoints w, bank.api_payments p \
                      WHERE d.event_id = due.event_id AND d.endpoint_id = due.endpoint_id \
                        AND e.event_id = d.event_id AND w.id = d.endpoint_id AND p.id = e.payment_id \
                     RETURNING d.event_id, d.endpoint_id::text, e.payment_id::text, e.previous_state, e.current_state, \
                       e.version, w.url, w.secret, p.amount::text, p.asset_id, p.method, {}",
                    ms_col("e.occurred_at")
                ),
                &[&DRAIN_BATCH.min(limit), &LEASE_MS],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(|r| {
                Ok(Claimed {
                    event_id: r.try_get(0).map_err(|e| pg(&e))?,
                    endpoint_id: r.try_get(1).map_err(|e| pg(&e))?,
                    payment_id: r.try_get(2).map_err(|e| pg(&e))?,
                    previous: r.try_get(3).map_err(|e| pg(&e))?,
                    current: r.try_get(4).map_err(|e| pg(&e))?,
                    version: r.try_get(5).map_err(|e| pg(&e))?,
                    url: r.try_get(6).map_err(|e| pg(&e))?,
                    secret: r.try_get(7).map_err(|e| pg(&e))?,
                    amount: r.try_get(8).map_err(|e| pg(&e))?,
                    asset_id: r.try_get(9).map_err(|e| pg(&e))?,
                    method: r.try_get(10).map_err(|e| pg(&e))?,
                    occurred_at: Instant(r.try_get(11).map_err(|e| pg(&e))?),
                })
            })
            .collect::<Result<Vec<_>, Refusal>>()
        })?;
        if claimed.is_empty() {
            break;
        }
        for c in &claimed {
            let delivered = post(d, c)?;
            results.push(if delivered { "completed" } else { "open" }.to_owned());
        }
    }
    Ok(results)
}

/// The webhook's body (`transfer.state_changed`).
fn body_of(c: &Claimed) -> Result<String, Refusal> {
    Ok(Json::obj([
        ("id", Json::str(c.event_id.clone())),
        ("type", Json::str("transfer.state_changed")),
        ("transferId", Json::str(c.payment_id.clone())),
        ("version", Json::int(i64::from(c.version))),
        ("previousState", opt_str(c.previous.clone())),
        ("currentState", Json::str(c.current.clone())),
        ("amount", Json::str(amount_text(&c.amount)?)),
        ("assetId", Json::str(c.asset_id.clone())),
        ("method", Json::str(c.method.clone())),
        ("occurredAt", Json::str(c.occurred_at.iso())),
    ])
    .compact())
}

/// `HMAC-SHA256(secret, "<timestamp>.<body>")` in hex.
pub fn signature(secret: &str, timestamp: &str, body: &str) -> String {
    #[expect(clippy::expect_used, reason = "HMAC takes a key of any length")]
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC takes any key length");
    mac.update(timestamp.as_bytes());
    mac.update(b".");
    mac.update(body.as_bytes());
    hex(&mac.finalize().into_bytes())
}

/// One attempt at one delivery, and its outcome recorded: true when the endpoint took it (a 2xx).
fn post(d: &Deps<'_>, c: &Claimed) -> Result<bool, Refusal> {
    let body = body_of(c)?;
    let timestamp = (d.clock)().0.div_euclid(1000).to_string();
    let sig = signature(&c.secret, &timestamp, &body);
    let sent = assert_public_webhook_url(&c.url, d.w.allow_local_http)
        .and_then(|url| {
            let host = url.host_str().unwrap_or_default().to_owned();
            resolve_public_addresses(&host, d.w.resolver.as_ref(), d.w.allow_local_http)
                .map(|addresses| (url, addresses))
        })
        .map_err(|_| url_guard::URL_INVALID.to_owned())
        .and_then(|(url, addresses)| {
            d.w.transport
                .post(&PinnedPost {
                    url,
                    addresses,
                    headers: vec![
                        ("content-type".to_owned(), "application/json".to_owned()),
                        ("x-intafaced-event-id".to_owned(), c.event_id.clone()),
                        ("idempotency-key".to_owned(), c.event_id.clone()),
                        ("x-intafaced-timestamp".to_owned(), timestamp.clone()),
                        ("x-intafaced-signature".to_owned(), format!("v1={sig}")),
                    ],
                    body: body.clone(),
                    timeout_ms: d.w.timeout_ms,
                })
                .map_err(|_| "unreachable".to_owned())
        });
    let (status, error) = match sent {
        Ok(s) => (Some(i32::from(s)), None),
        Err(e) => (None, Some(e)),
    };
    let delivered = status.is_some_and(|s| (200..300).contains(&s));
    let delivered_at = delivered.then(|| (d.clock)().0);
    with(d.store, |cl| {
        cl.execute(
            &format!(
                "UPDATE bank.api_webhook_deliveries \
                 SET attempts = attempts + 1, last_status = $3, last_error = $4, lease_until = NULL, state = $5, \
                     delivered_at = CASE WHEN $6::int8 IS NULL THEN NULL ELSE {} END \
                 WHERE event_id = $1 AND endpoint_id = $2::text::uuid",
                at("$6")
            ),
            &[
                &c.event_id,
                &c.endpoint_id,
                &status,
                &error,
                &if delivered { "delivered" } else { "failed" },
                &delivered_at,
            ],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })?;
    Ok(delivered)
}

/// The binary's webhook worker: posts what is due each time a recorded state change kicks it, until `stop` is set. A
/// failed drain is the recovery job's to retry.
pub fn run_kicked(door: &crate::door::BankDoor, stop: &AtomicBool) {
    while !stop.load(Ordering::SeqCst) {
        if door.bank_api().wait_kick(Duration::from_millis(200)) {
            let _ = door.bank_api_deps(door.now(), |d| drain(d, DRAIN_BATCH));
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    fn mv(at: i64, from: &AccountRef, to: &AccountRef, amount: &str) -> crate::partner::Move {
        crate::partner::Move {
            id: format!("m{at}"),
            key: format!("k{at}"),
            from: from.clone(),
            to: to.clone(),
            amount: parse_amount(amount).unwrap(),
            moved_at: Instant(at),
            label: "TEST partner bank",
            payees: None,
        }
    }

    #[test]
    fn spend_today_counts_what_left_for_someone_else_since_utc_midnight() {
        let main = AccountRef::main("u", "EUR");
        let pot = AccountRef {
            space_id: Some("p".to_owned()),
            ..main.clone()
        };
        let out = crate::partner::payouts_account("EUR");
        let now = Instant(10 * DAY_MS + 5_000);
        let moves = vec![
            mv(10 * DAY_MS + 4_000, &main, &out, "12.5"),
            mv(10 * DAY_MS + 3_000, &main, &pot, "7"),
            mv(10 * DAY_MS - 1, &main, &out, "99"),
        ];
        assert_eq!(spent_today(&moves, &main, now).as_deref(), Some("12.5"));
        assert_eq!(
            spent_today(&moves[..2], &main, now).as_deref(),
            Some("12.5")
        );
        let full: Vec<_> = (0..SPEND_PAGE)
            .map(|i| mv(10 * DAY_MS + 4_000 - i as i64, &main, &out, "1"))
            .collect();
        assert_eq!(spent_today(&full, &main, now), None);
    }

    #[test]
    fn a_figure_not_reported_or_ahead_of_now_is_unknown_never_zero() {
        let now = Instant(1_000_000);
        let b = |amount: Option<&str>, as_of: Option<i64>| Balance {
            account: AccountRef::main("u", "EUR"),
            amount: amount.map(|a| parse_amount(a).unwrap()),
            as_of: as_of.map(Instant),
            unavailable: false,
            label: "TEST partner bank",
        };
        assert_eq!(figure(&b(Some("1"), Some(1_000_000)), now).1, "known");
        assert_eq!(
            figure(&b(Some("1"), Some(1_000_000 - STALE_AFTER_MS - 1)), now).1,
            "stale"
        );
        assert_eq!(
            figure(&b(Some("1"), Some(1_000_000 + STALE_AFTER_MS + 1)), now),
            (
                None,
                "unknown",
                Some(Instant(1_000_000 + STALE_AFTER_MS + 1))
            )
        );
        assert_eq!(
            figure(&b(None, Some(5)), now),
            (None, "unknown", Some(Instant(5)))
        );
        assert_eq!(figure(&b(Some("1"), None), now), (None, "unknown", None));
    }

    #[test]
    fn the_signature_is_hmac_sha256_of_the_timestamp_and_body_in_hex() {
        // node -e "console.log(require('crypto').createHmac('sha256','whsec_k').update('1700000000.{}').digest('hex'))"
        assert_eq!(
            signature("whsec_k", "1700000000", "{}"),
            "8b20524faff2b12e1089e404a8cf60fbe577e5320e899ebff7329ebbcb9ada22"
        );
    }
}
