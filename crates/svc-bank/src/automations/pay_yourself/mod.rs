//! Part `pay_yourself` of the automations slice: pay yourself from your trading (`pay-yourself/`, J-bank-31).
//!
//! A move is ONE venue withdrawal, signed once in the person's own wallet, from their venue account to their own account
//! at the partner bank (its pay-in: the partner slice's TEST rail, `partner::pay_in`, on a TEST stack). The venue holds
//! the money until it pays the withdrawal, the partner from when it credits it; INTAFACED holds none of it and the ledger
//! posts nothing. What is kept here is only what the person asked for:
//!
//! - `payYourself.summary`: what their trading realised since their last move, as the venue reports it (svc-trade's
//!   read, [`realised`], never a figure of ours), the partner's pay-in route and fee ("not known" when it gives none),
//!   their moves, the partner's pay-ins, their rule;
//! - `payYourself.record`: a move the person signed and the venue took, by its business key and the venue's nonce, once;
//! - `payYourself.setRule`: one weekly rule, "on <weekday>, the week's realised profit, up to <cap>";
//! - `POST /internal/jobs/pay-yourself/run-due` ([`run_due`]): each rule whose day has come prepares ONE move for the
//!   profit realised since it last ran (less what the person already paid themselves in that time), up to its cap,
//!   waiting for their one signature. A prepared move moves nothing.

pub mod realised;

use postgres::GenericClient;
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::schema::Value;
use service_kit::server::Response;
use service_kit::time::Instant;

use super::Deps;
use crate::door::Ctx;
use crate::door::jobs::{job_failed, ok};
use crate::errors::Refusal;
use crate::partner::pay_in::{self, ASSET as PAY_IN_ASSET};
use crate::partner::refuse;
use crate::spaces::space::{at, in_tx, pg, with};
use realised::{Read, RealisedSource};

/// What the binary hands this part: svc-trade's realised read (`createRealisedSource`). The pay-in rail is the partner
/// slice's (`partner::router::Wiring::pay_in`).
#[derive(Default)]
pub struct Wiring {
    /// Unset: the realised figure reads as not read, never 0.
    pub realised: Option<Box<dyn RealisedSource>>,
}

impl Wiring {
    pub fn none() -> Wiring {
        Wiring::default()
    }
}

/// `WEEKDAYS`: ISO 1 Monday … 7 Sunday.
pub const WEEKDAYS: [&str; 7] = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
];
/// `BEGINNING`: profit is counted from here for a person who has never paid themselves (2020-01-01T00:00:00Z).
pub const BEGINNING: Instant = Instant(1_577_836_800_000);
const DAY_MS: i64 = 86_400_000;
/// The path of the job door.
pub const RUN_DUE: &str = "/internal/jobs/pay-yourself/run-due";

/// `nextWeekday`: the start (00:00 UTC) of the next `weekday` (1 Monday … 7 Sunday) strictly after `now`.
pub fn next_weekday(weekday: i64, now: Instant) -> Instant {
    let day = now.0.div_euclid(DAY_MS);
    // 1970-01-01 was a Thursday (ISO 4).
    let today = (day + 3).rem_euclid(7) + 1;
    let mut ahead = (weekday - today).rem_euclid(7);
    if ahead == 0 {
        ahead = 7;
    }
    Instant((day + ahead) * DAY_MS)
}

/// `PayYourselfMove`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Move {
    pub id: String,
    pub user_id: String,
    pub move_key: String,
    pub source: String,
    pub asset_id: String,
    pub amount: Amount,
    pub status: String,
    pub owner: Option<String>,
    pub venue_nonce: Option<String>,
    pub window_from: Option<Instant>,
    pub window_to: Option<Instant>,
    pub prepared_at: Instant,
    pub sent_at: Option<Instant>,
}

/// `PayYourselfRule`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub id: String,
    pub user_id: String,
    pub weekday: i64,
    pub asset_id: String,
    pub cap: Amount,
    pub created_at: Instant,
    pub last_run_at: Option<Instant>,
    pub next_run_at: Instant,
}

fn ms(col: &str) -> String {
    format!("floor(extract(epoch from {col}) * 1000)::int8")
}

fn move_cols() -> String {
    format!(
        "id::text, user_id, move_key, source, asset_id, amount::text, status, owner, venue_nonce, {}, {}, {}, {}",
        ms("window_from"),
        ms("window_to"),
        ms("prepared_at"),
        ms("sent_at")
    )
}

fn rule_cols() -> String {
    format!(
        "id::text, user_id, weekday::int8, asset_id, cap::text, {}, {}, {}",
        ms("created_at"),
        ms("last_run_at"),
        ms("next_run_at")
    )
}

fn amount_of(text: &str) -> Result<Amount, Refusal> {
    parse_amount(text).map_err(Refusal::Other)
}

fn move_of(r: &postgres::Row) -> Result<Move, Refusal> {
    let at = |i: usize| -> Result<Option<Instant>, Refusal> {
        Ok(r.try_get::<_, Option<i64>>(i)
            .map_err(|e| pg(&e))?
            .map(Instant))
    };
    let text = |i: usize| -> Result<String, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
    let opt = |i: usize| -> Result<Option<String>, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
    Ok(Move {
        id: text(0)?,
        user_id: text(1)?,
        move_key: text(2)?,
        source: text(3)?,
        asset_id: text(4)?,
        amount: amount_of(&text(5)?)?,
        status: text(6)?,
        owner: opt(7)?,
        venue_nonce: opt(8)?,
        window_from: at(9)?,
        window_to: at(10)?,
        prepared_at: at(11)?.ok_or_else(|| Refusal::Other("prepared_at is null".to_owned()))?,
        sent_at: at(12)?,
    })
}

fn rule_of(r: &postgres::Row) -> Result<Rule, Refusal> {
    let at = |i: usize| -> Result<Option<Instant>, Refusal> {
        Ok(r.try_get::<_, Option<i64>>(i)
            .map_err(|e| pg(&e))?
            .map(Instant))
    };
    let text = |i: usize| -> Result<String, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
    let null = |what: &str| Refusal::Other(format!("{what} is null"));
    Ok(Rule {
        id: text(0)?,
        user_id: text(1)?,
        weekday: r.try_get(2).map_err(|e| pg(&e))?,
        asset_id: text(3)?,
        cap: amount_of(&text(4)?)?,
        created_at: at(5)?.ok_or_else(|| null("created_at"))?,
        last_run_at: at(6)?,
        next_run_at: at(7)?.ok_or_else(|| null("next_run_at"))?,
    })
}

fn iso_or_null(t: Option<Instant>) -> Json {
    t.map_or(Json::Null, |t| Json::str(t.iso()))
}

fn opt_str(s: Option<&String>) -> Json {
    s.map_or(Json::Null, |s| Json::str(s.clone()))
}

impl Move {
    /// `moveView`.
    pub fn json(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("moveKey", Json::str(self.move_key.clone())),
            ("source", Json::str(self.source.clone())),
            ("assetId", Json::str(self.asset_id.clone())),
            ("amount", Json::str(format_amount(self.amount))),
            ("status", Json::str(self.status.clone())),
            ("owner", opt_str(self.owner.as_ref())),
            ("venueNonce", opt_str(self.venue_nonce.as_ref())),
            ("windowFrom", iso_or_null(self.window_from)),
            ("windowTo", iso_or_null(self.window_to)),
            ("preparedAt", Json::str(self.prepared_at.iso())),
            ("sentAt", iso_or_null(self.sent_at)),
        ])
    }
}

impl Rule {
    /// `ruleView`.
    pub fn json(&self) -> Json {
        let weekday = usize::try_from(self.weekday - 1)
            .ok()
            .and_then(|i| WEEKDAYS.get(i))
            .copied()
            .unwrap_or_default();
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("weekday", Json::str(weekday)),
            ("assetId", Json::str(self.asset_id.clone())),
            ("cap", Json::str(format_amount(self.cap))),
            ("lastRunAt", iso_or_null(self.last_run_at)),
            ("nextRunAt", Json::str(self.next_run_at.iso())),
        ])
    }
}

/// `bank.pay_in_unset`.
fn unset() -> Refusal {
    refuse(
        "bank.pay_in_unset",
        "No partner pay-in a venue can withdraw to is wired, so nothing can be paid to the partner account.",
    )
}

fn validation(message: &str) -> Refusal {
    refuse("bank.validation_failed", message)
}

/// `moves`: the person's newest 50.
pub fn moves(c: &mut impl GenericClient, user_id: &str) -> Result<Vec<Move>, Refusal> {
    c.query(
        &format!(
            "SELECT {} FROM bank.pay_yourself_moves WHERE user_id = $1 ORDER BY prepared_at DESC, id LIMIT 50",
            move_cols()
        ),
        &[&user_id],
    )
    .map_err(|e| pg(&e))?
    .iter()
    .map(move_of)
    .collect()
}

/// `rule`.
pub fn rule(c: &mut impl GenericClient, user_id: &str) -> Result<Option<Rule>, Refusal> {
    c.query(
        &format!(
            "SELECT {} FROM bank.pay_yourself_rules WHERE user_id = $1",
            rule_cols()
        ),
        &[&user_id],
    )
    .map_err(|e| pg(&e))?
    .first()
    .map(rule_of)
    .transpose()
}

/// `realisedSince`'s answer: the window's start, the venue's time, the amount and the account a move withdraws from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Since {
    Read {
        since: Instant,
        as_of: Instant,
        amount: Amount,
        owner: Option<String>,
    },
    Unread(String),
}

/// `realisedSince`: what the person's trading realised from `since`, and from which main venue account.
fn realised_since(
    d: &Deps<'_>,
    user_id: &str,
    since: Instant,
    until: Option<Instant>,
) -> Result<Since, Refusal> {
    let Some(source) = d.w.pay_yourself.realised.as_ref() else {
        return Ok(Since::Unread(realised::REALISED_UNREAD.to_owned()));
    };
    Ok(
        match source.realised(user_id, PAY_IN_ASSET, since, until)? {
            Read::Unread(code) => Since::Unread(code),
            Read::Realised(r) => {
                // The account the most was realised on is the one a move withdraws from (the first of equals).
                let mut best: Option<&(String, Amount)> = None;
                for a in &r.accounts {
                    if best.is_none_or(|b| a.1 > b.1) {
                        best = Some(a);
                    }
                }
                Since::Read {
                    since,
                    as_of: r.as_of,
                    amount: r.realised,
                    owner: best.map(|b| b.0.clone()),
                }
            }
        },
    )
}

/// `partnerFeeKnown`: the TEST partner charges nothing for a pay-in (TEST) when it says what a move costs; with its fee
/// switch `unknown` it says nothing, "not known", never 0. Without the partner the fee is 0, as the TypeScript's is.
pub fn partner_fee(d: &Deps<'_>, user_id: &str) -> Json {
    let known =
        d.t.partner
            .partner
            .as_ref()
            .is_none_or(|p| p.switches(user_id).fee == "known");
    if known { Json::str("0") } else { Json::Null }
}

/// `summary` through `summaryOut`.
pub fn summary(d: &Deps<'_>, user_id: &str) -> Result<Json, Refusal> {
    let moves = with(d.store(), |c| moves(c, user_id))?;
    let since = moves
        .iter()
        .find(|m| m.status == "sent")
        .and_then(|m| m.sent_at)
        .unwrap_or(BEGINNING);
    let rail = d.t.partner.pay_in.as_ref();
    let pay_in = match rail {
        None => Json::obj([("unset", Json::str("bank.pay_in_unset"))]),
        Some(r) => Json::obj([
            ("label", Json::str("TEST")),
            (
                "chainId",
                Json::int(i64::try_from(r.chain_id).unwrap_or(i64::MAX)),
            ),
            ("token", Json::str(r.token.clone())),
            ("tokenDecimals", Json::int(i64::from(r.decimals))),
            ("address", Json::str(r.route(user_id))),
            ("asset", Json::str(PAY_IN_ASSET)),
            (
                "confirmations",
                Json::int(i64::try_from(pay_in::CONFIRMATIONS).unwrap_or(i64::MAX)),
            ),
        ]),
    };
    let partner_fee = partner_fee(d, user_id);
    let realised = match realised_since(d, user_id, since, None)? {
        Since::Unread(code) => Json::obj([("unread", Json::str(code))]),
        Since::Read {
            since,
            as_of,
            amount,
            owner,
        } => Json::obj([
            ("since", Json::str(since.iso())),
            ("asOf", Json::str(as_of.iso())),
            ("amount", Json::str(format_amount(amount))),
            ("owner", opt_str(owner.as_ref())),
        ]),
    };
    let credits = rail.map_or_else(Vec::new, |r| credits(d, r, user_id));
    let rule = with(d.store(), |c| rule(c, user_id))?;
    Ok(Json::obj([
        ("payIn", pay_in),
        ("partnerFee", partner_fee),
        ("realised", realised),
        ("moves", Json::Array(moves.iter().map(Move::json).collect())),
        ("credits", Json::Array(credits)),
        ("rule", rule.as_ref().map_or(Json::Null, Rule::json)),
    ]))
}

/// The partner's pay-ins as it reports them now, newest first, each through `payInCreditView`.
fn credits(d: &Deps<'_>, rail: &pay_in::PayInRail, user_id: &str) -> Vec<Json> {
    let (kept, head) = rail.credits(user_id);
    let held_switch =
        d.t.partner
            .partner
            .as_ref()
            .is_some_and(|p| p.switches(user_id).pay_in == "held");
    kept.iter()
        .map(|k| {
            let seen = if head >= k.block {
                head - k.block + 1
            } else {
                0
            };
            Json::obj([
                ("key", Json::str(k.key.clone())),
                ("txHash", Json::str(k.tx_hash.clone())),
                ("amount", Json::str(format_amount(k.amount))),
                ("from", Json::str(k.from.clone())),
                (
                    "status",
                    Json::str(if k.available_at.is_some() {
                        "available"
                    } else {
                        "pending"
                    }),
                ),
                ("held", Json::Bool(k.available_at.is_none() && held_switch)),
                (
                    "confirmations",
                    Json::int(i64::try_from(seen.min(pay_in::CONFIRMATIONS)).unwrap_or(i64::MAX)),
                ),
                (
                    "required",
                    Json::int(i64::try_from(pay_in::CONFIRMATIONS).unwrap_or(i64::MAX)),
                ),
                ("seenAt", Json::str(k.seen_at.iso())),
                ("availableAt", iso_or_null(k.available_at)),
            ])
        })
        .collect()
}

/// `^pay-yourself:[A-Za-z0-9:._-]{1,140}$`.
fn move_key_shape(key: &str) -> bool {
    let Some(rest) = key.strip_prefix("pay-yourself:") else {
        return false;
    };
    (1..=140).contains(&rest.len())
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'.' | b'_' | b'-'))
}

/// `^[A-Za-z0-9:_-]{1,80}$`.
fn nonce_shape(nonce: &str) -> bool {
    (1..=80).contains(&nonce.len())
        && nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-'))
}

/// What `payYourself.record` is given.
pub struct RecordInput<'a> {
    pub move_key: &'a str,
    pub owner: &'a str,
    pub nonce: &'a str,
    pub amount: Amount,
}

/// `record`: a move the person signed and the venue took, once per key. The same facts again answer the same move;
/// other facts under the key refuse `bank.pay_yourself_conflict`. A key a rule prepared marks that move sent, for the
/// amount it prepared only.
pub fn record(d: &Deps<'_>, user_id: &str, input: &RecordInput<'_>) -> Result<Move, Refusal> {
    if d.t.partner.pay_in.is_none() {
        return Err(unset());
    }
    let owner = input.owner.to_lowercase();
    if !move_key_shape(input.move_key)
        || !realised::lower_address(&owner)
        || !nonce_shape(input.nonce)
        || input.amount <= 0
    {
        return Err(validation(
            "A pay yourself move needs its key, the venue account’s owner, the venue’s nonce and an amount.",
        ));
    }
    let conflict = || {
        refuse(
            "bank.pay_yourself_conflict",
            format!(
                "A different move is already recorded under {}, so this one was not.",
                input.move_key
            ),
        )
    };
    let now = d.now();
    in_tx(d.store(), |tx| {
        let prior = tx
            .query(
                &format!(
                    "SELECT {} FROM bank.pay_yourself_moves WHERE move_key = $1 FOR UPDATE",
                    move_cols()
                ),
                &[&input.move_key],
            )
            .map_err(|e| pg(&e))?;
        if let Some(prior) = prior.first() {
            let m = move_of(prior)?;
            if m.user_id != user_id || m.amount != input.amount {
                return Err(conflict());
            }
            if m.status == "sent" {
                if m.owner.as_deref() != Some(owner.as_str())
                    || m.venue_nonce.as_deref() != Some(input.nonce)
                {
                    return Err(conflict());
                }
                return Ok(m);
            }
            let rows = tx
                .query(
                    &format!(
                        "UPDATE bank.pay_yourself_moves SET status = 'sent', owner = $2, venue_nonce = $3, sent_at = {} \
                         WHERE id = $1::text::uuid RETURNING {}",
                        at("$4"),
                        move_cols()
                    ),
                    &[&m.id, &owner, &input.nonce, &now.0],
                )
                .map_err(|e| pg(&e))?;
            return rows
                .first()
                .map(move_of)
                .unwrap_or_else(|| Err(Refusal::Other("the move was not updated".to_owned())));
        }
        if !input.move_key.starts_with("pay-yourself:manual:") {
            return Err(refuse(
                "bank.pay_yourself_move_not_found",
                "No prepared move is held under that key.",
            ));
        }
        let id = service_kit::approvals::random_uuid().map_err(Refusal::Other)?;
        let rows = tx
            .query(
                &format!(
                    "INSERT INTO bank.pay_yourself_moves (id, user_id, move_key, source, asset_id, amount, status, owner, venue_nonce, prepared_at, sent_at) \
                     VALUES ($1::text::uuid, $2, $3, 'manual', $4, $5::text::numeric, 'sent', $6, $7, {at}, {at}) RETURNING {}",
                    move_cols(),
                    at = at("$8")
                ),
                &[
                    &id,
                    &user_id,
                    &input.move_key,
                    &PAY_IN_ASSET,
                    &format_amount(input.amount),
                    &owner,
                    &input.nonce,
                    &now.0,
                ],
            )
            .map_err(|e| pg(&e))?;
        rows.first()
            .map(move_of)
            .unwrap_or_else(|| Err(Refusal::Other("the move was not kept".to_owned())))
    })
}

/// `setRule`: the person's weekly rule, set or changed: from now, it runs at the start of the next `weekday` (UTC).
pub fn set_rule(d: &Deps<'_>, user_id: &str, weekday: &str, cap: Amount) -> Result<Rule, Refusal> {
    if d.t.partner.pay_in.is_none() {
        return Err(unset());
    }
    if cap <= 0 {
        return Err(validation(
            "A weekly rule needs a most it may move above zero.",
        ));
    }
    let iso = WEEKDAYS
        .iter()
        .position(|w| *w == weekday)
        .and_then(|i| i64::try_from(i + 1).ok())
        .ok_or_else(|| Refusal::Other(format!("{weekday} is no weekday")))?;
    let now = d.now();
    let id = service_kit::approvals::random_uuid().map_err(Refusal::Other)?;
    with(d.store(), |c| {
        let rows = c
            .query(
                &format!(
                    "INSERT INTO bank.pay_yourself_rules (id, user_id, weekday, asset_id, cap, created_at, next_run_at) \
                     VALUES ($1::text::uuid, $2, $3::int8::smallint, $4, $5::text::numeric, {}, {}) \
                     ON CONFLICT (user_id) DO UPDATE SET weekday = EXCLUDED.weekday, cap = EXCLUDED.cap, next_run_at = EXCLUDED.next_run_at \
                     RETURNING {}",
                    at("$6"),
                    at("$7"),
                    rule_cols()
                ),
                &[
                    &id,
                    &user_id,
                    &iso,
                    &PAY_IN_ASSET,
                    &format_amount(cap),
                    &now.0,
                    &next_weekday(iso, now).0,
                ],
            )
            .map_err(|e| pg(&e))?;
        rows.first()
            .map(rule_of)
            .unwrap_or_else(|| Err(Refusal::Other("the rule was not kept".to_owned())))
    })
}

/// What one pass of the rules did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RunDue {
    pub prepared: i64,
    pub nothing: i64,
    pub unread: i64,
}

impl RunDue {
    pub fn json(&self) -> Json {
        Json::obj([
            ("prepared", Json::int(self.prepared)),
            ("nothing", Json::int(self.nothing)),
            ("unread", Json::int(self.unread)),
        ])
    }
}

/// `runDue`: every rule whose day has come, once each: the profit realised since the rule last ran (or was set), less
/// what the person paid themselves in that time, up to the cap, prepared as ONE move under
/// `pay-yourself:rule:<rule>:<window end>`. Nothing above zero, or a read that failed, prepares nothing; a failed read
/// leaves the rule due, so the next pass tries again. Nothing is sent.
pub fn run_due(d: &Deps<'_>, limit: i64) -> Result<RunDue, Refusal> {
    let now = d.now();
    let due: Vec<Rule> = with(d.store(), |c| {
        c.query(
            &format!(
                "SELECT {} FROM bank.pay_yourself_rules WHERE next_run_at <= {} ORDER BY next_run_at, id LIMIT $2",
                rule_cols(),
                at("$1")
            ),
            &[&now.0, &limit],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(rule_of)
        .collect()
    })?;
    let mut out = RunDue::default();
    for rule in due {
        let from = rule.last_run_at.unwrap_or(rule.created_at);
        let (realised, owner) = match realised_since(d, &rule.user_id, from, Some(now))? {
            Since::Unread(_) => {
                out.unread += 1;
                continue;
            }
            Since::Read { amount, owner, .. } => (amount, owner),
        };
        let paid: Amount = with(d.store(), |c| moves(c, &rule.user_id))?
            .iter()
            .filter(|m| m.status == "sent")
            .filter(|m| m.sent_at.is_some_and(|s| s.0 >= from.0 && s.0 < now.0))
            .map(|m| m.amount)
            .sum();
        let amount = rule.cap.min(realised - paid);
        in_tx(d.store(), |tx| {
            if amount > 0 {
                let id = service_kit::approvals::random_uuid().map_err(Refusal::Other)?;
                tx.execute(
                    &format!(
                        "INSERT INTO bank.pay_yourself_moves (id, user_id, move_key, source, rule_id, asset_id, amount, status, owner, window_from, window_to, prepared_at) \
                         VALUES ($1::text::uuid, $2, $3, 'rule', $4::text::uuid, $5, $6::text::numeric, 'prepared', $7, {}, {to}, {to}) \
                         ON CONFLICT (move_key) DO NOTHING",
                        at("$8"),
                        to = at("$9")
                    ),
                    &[
                        &id,
                        &rule.user_id,
                        &format!("pay-yourself:rule:{}:{}", rule.id, now.0),
                        &rule.id,
                        &rule.asset_id,
                        &format_amount(amount),
                        &owner,
                        &from.0,
                        &now.0,
                    ],
                )
                .map_err(|e| pg(&e))?;
            }
            tx.execute(
                &format!(
                    "UPDATE bank.pay_yourself_rules SET last_run_at = {}, next_run_at = {} WHERE id = $1::text::uuid",
                    at("$2"),
                    at("$3")
                ),
                &[&rule.id, &now.0, &next_weekday(rule.weekday, now).0],
            )
            .map_err(|e| pg(&e))?;
            Ok(())
        })?;
        if amount > 0 {
            out.prepared += 1;
        } else {
            out.nothing += 1;
        }
    }
    Ok(out)
}

fn text<'a>(input: &'a Value, key: &str) -> &'a str {
    input.get(key).as_str().unwrap_or_default()
}

/// This part's calls; `None` for any other call.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let user = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    let input = &ctx.input;
    Some(match ctx.call.path {
        "payYourself.summary" => summary(d, user),
        // `parseAmount(input.amount)` is made before the service runs: an amount it refuses is thrown first.
        "payYourself.record" => amount_of(text(input, "amount")).and_then(|amount| {
            record(
                d,
                user,
                &RecordInput {
                    move_key: text(input, "moveKey"),
                    owner: text(input, "owner"),
                    nonce: text(input, "nonce"),
                    amount,
                },
            )
            .map(|m| m.json())
        }),
        "payYourself.setRule" => amount_of(text(input, "cap"))
            .and_then(|cap| set_rule(d, user, text(input, "weekday"), cap))
            .map(|r| r.json()),
        _ => return None,
    })
}

/// `z.object({ limit: z.number().int().min(1).max(500) }).strict()` on the job's body (`req.body ?? {}`).
fn limit_of(body: &Value) -> Option<i64> {
    let fields = match body {
        Value::Object(f) => f.as_slice(),
        Value::Undefined | Value::Null => &[],
        _ => return None,
    };
    if fields.iter().any(|(k, _)| k != "limit") {
        return None;
    }
    let n = body.get("limit").as_number()?;
    #[allow(
        clippy::float_arithmetic,
        reason = "zod's integer check on a JSON number"
    )]
    let whole = n.fract() == 0.0;
    if !whole || !(1.0..=500.0).contains(&n) {
        return None;
    }
    #[allow(
        clippy::cast_possible_truncation,
        reason = "a whole number from 1 to 500"
    )]
    Some(n as i64)
}

/// This part's job door past the signature: `POST /internal/jobs/pay-yourself/run-due` (`jobDoor`): the body, then one
/// pass; a `BankError` is `sendBankJobRefuse`'s 400, anything else Fastify's 500.
pub fn job(d: &Deps<'_>, path: &str, body: &Value) -> Option<Response> {
    if path != RUN_DUE {
        return None;
    }
    let Some(limit) = limit_of(body) else {
        // `{ error: 'body not in shape', code: 'bank.validation_failed' }`, 400.
        return Some(Response {
            status: 400,
            body: Json::obj([
                ("error", Json::str("body not in shape")),
                ("code", Json::str("bank.validation_failed")),
            ])
            .compact(),
        });
    };
    Some(match run_due(d, limit) {
        Ok(report) => ok(&report.json()),
        Err(r) => job_failed(r),
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    fn at(iso: &str) -> Instant {
        service_kit::time::zod_datetime(iso, true).unwrap()
    }

    fn day(weekday: &str) -> i64 {
        i64::try_from(WEEKDAYS.iter().position(|w| *w == weekday).unwrap() + 1).unwrap()
    }

    /// `test-pay-in.test.ts`, "the weekly rule day": "is the start of the next such day, strictly after now".
    #[test]
    fn is_the_start_of_the_next_such_day_strictly_after_now() {
        // 17 Nov 2026 is a Tuesday.
        let next = |w: &str, now: &str| next_weekday(day(w), at(now)).iso();
        assert_eq!(
            next("friday", "2026-11-17T10:00:00Z"),
            "2026-11-20T00:00:00.000Z"
        );
        assert_eq!(
            next("tuesday", "2026-11-17T10:00:00Z"),
            "2026-11-24T00:00:00.000Z"
        );
        assert_eq!(
            next("friday", "2026-11-20T00:00:00Z"),
            "2026-11-27T00:00:00.000Z"
        );
        assert_eq!(
            next("sunday", "2026-11-22T23:59:59Z"),
            "2026-11-29T00:00:00.000Z"
        );
        assert_eq!(
            next("monday", "2026-11-22T23:59:59Z"),
            "2026-11-23T00:00:00.000Z"
        );
    }

    #[test]
    fn a_move_key_and_a_nonce_take_the_typescripts_shapes() {
        assert!(move_key_shape("pay-yourself:manual:abc-1"));
        assert!(!move_key_shape("pay-yourself:"));
        assert!(!move_key_shape("payyourself:manual:1"));
        assert!(!move_key_shape("pay-yourself:a b"));
        assert!(nonce_shape("1763337600000"));
        assert!(!nonce_shape("a.b"));
        assert!(!nonce_shape(""));
    }

    #[test]
    fn the_job_body_is_a_strict_whole_limit_from_1_to_500() {
        let body = |s: &str| Value::from_json(&service_kit::json::parse(s).unwrap());
        assert_eq!(limit_of(&body(r#"{"limit":10}"#)), Some(10));
        assert_eq!(limit_of(&body(r#"{"limit":500}"#)), Some(500));
        assert_eq!(limit_of(&body(r#"{"limit":0}"#)), None);
        assert_eq!(limit_of(&body(r#"{"limit":1.5}"#)), None);
        assert_eq!(limit_of(&body(r#"{"limit":"10"}"#)), None);
        assert_eq!(limit_of(&body(r#"{"limit":10,"more":1}"#)), None);
        assert_eq!(limit_of(&body("{}")), None);
        assert_eq!(limit_of(&Value::Undefined), None);
    }
}
