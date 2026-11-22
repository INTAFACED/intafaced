//! The cardholder's own disputes (`cardholder-disputes.ts`, and the half of `card-disputes.ts` its calls reach:
//! `cards.disputes.form`, `.open`, `.list`, `.get`, `.evidence`, `.withdraw`; J-bank-15).
//!
//! A case is one cardholder's dispute of one settled card capture, the same case support works (J-bank-27, slice
//! `card-ops`: `ops.cardDispute*`). The cardholder files it, adds evidence and may withdraw it; they read its states with
//! their dates, who took each step (them or support, never an operator's id), the partner's provisional credit and the
//! decision with its reason. The money is the partner's: nothing here posts to the ledger.
//!
//! `get`, `open`, `add_evidence` and `close` are the shared case functions support's calls will reach too; they are
//! public so slice `card-ops` hands its own inputs in rather than keeping a second copy.

use postgres::{GenericClient, Row};
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::Instant;

use super::core::text;
use super::issuer::sha256_hex;
use super::terms::{DisputeRules, PartnerTerms};
use super::{Deps, ms, own};
use crate::door::Ctx;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{in_tx, pg, with};

/// `LIST_LIMIT`.
const LIST_LIMIT: i64 = 200;
/// `NOT_KNOWN`.
const NOT_KNOWN: &str = "not known";
/// `LOSS_BEARERS`.
const LOSS_BEARERS: [&str; 3] = ["partner", "programme", "cardholder"];
const DAY_MS: i64 = 86_400_000;

fn not_found() -> Refusal {
    refuse(
        "bank.card_dispute_not_found",
        "No such card dispute (bank.card_dispute_not_found)",
    )
}

fn invalid(message: &str) -> Refusal {
    refuse("bank.card_dispute_invalid", message)
}

/// `wrongState`.
fn wrong_state(what: &str, state: &str) -> Refusal {
    refuse(
        "bank.card_dispute_state",
        format!("A case that is {state} cannot {what} (bank.card_dispute_state)"),
    )
}

/// JavaScript's `String.prototype.trim`: white space and line terminators, the byte-order mark included.
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `text`: trimmed, and between `min` and `max` UTF-16 units, else `bank.card_dispute_invalid`.
fn bounded(v: &str, min: usize, max: usize, what: &str) -> Result<String, Refusal> {
    let s = js_trim(v);
    let n = s.encode_utf16().count();
    if n < min || n > max {
        return Err(invalid(&format!(
            "{what} must be {min} to {max} characters (bank.card_dispute_invalid)"
        )));
    }
    Ok(s.to_owned())
}

/// `key`: a step key is 8 to 128 letters, digits, colons, dashes or underscores.
fn step_key(v: &str) -> Result<&str, Refusal> {
    let ok = (8..=128).contains(&v.len())
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-'));
    if !ok {
        return Err(invalid(
            "A step key is 8 to 128 letters, digits, colons, dashes or underscores (bank.card_dispute_invalid)",
        ));
    }
    Ok(v)
}

/// `/^\d+(\.\d{1,18})?$/` (ASCII digits: the pattern has no `u` flag).
fn is_decimal(v: &str) -> bool {
    let (whole, frac) = match v.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (v, None),
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    digits(whole) && frac.is_none_or(|f| digits(f) && f.len() <= 18)
}

fn amount(s: &str) -> Result<Amount, Refusal> {
    parse_amount(s).map_err(Refusal::Other)
}

/// `formatAmount(parseAmount(v))` of a stored numeric.
fn dec(s: &str) -> Result<String, Refusal> {
    Ok(format_amount(amount(s)?))
}

/// `caseId`: the opened case's id, derived from its key, so the same key always names the same case.
pub fn case_id(case_key: &str) -> String {
    let h = sha256_hex(&format!("card-dispute:{case_key}"));
    format!(
        "{}-{}-4{}-8{}-{}",
        &h[0..8],
        &h[8..12],
        &h[13..16],
        &h[17..20],
        &h[20..32]
    )
}

/// `creditKey`.
fn credit_key(id: &str) -> String {
    format!("card-dispute-credit:{id}")
}

fn at(t: Instant) -> String {
    format!(
        "'epoch'::timestamptz + ({}::int8 * interval '1 millisecond')",
        t.0
    )
}

/// One case as `DisputeRow` reads it (with its authorisation's reference).
#[derive(Debug, Clone)]
pub struct Case {
    pub id: String,
    pub case_key: String,
    pub card_id: String,
    pub user_id: String,
    pub authorization_ref: String,
    pub asset_id: String,
    /// The stored numeric, as text.
    pub amount: String,
    pub reason: String,
    pub state: String,
    pub test: bool,
    pub credit_requested_at: Option<Instant>,
    pub credit_amount: Option<String>,
    pub credit_partner_ref: Option<String>,
    pub credited_at: Option<Instant>,
    pub outcome: Option<String>,
    pub decision_reason: Option<String>,
    pub loss_status: Option<String>,
    pub credit_settlement: Option<String>,
    pub credit_settlement_partner_ref: Option<String>,
    pub closed_at: Option<Instant>,
    pub decision_requested_outcome: Option<String>,
    pub created_at: Instant,
}

fn case_cols() -> String {
    format!(
        "d.id::text, d.case_key, d.card_id::text, d.user_id::text, a.authorization_ref, d.asset_id, d.amount::text, \
         d.reason, d.state, d.test, {}, d.credit_amount::text, d.credit_partner_ref, {}, d.outcome, d.decision_reason, \
         d.loss_status, d.credit_settlement, d.credit_settlement_partner_ref, {}, d.decision_requested_outcome, {}",
        ms("d.credit_requested_at"),
        ms("d.credited_at"),
        ms("d.closed_at"),
        ms("d.created_at"),
    )
}

const CASE_FROM: &str =
    "FROM bank.card_disputes d JOIN bank.card_authorizations a ON a.id = d.authorization_id";

impl Case {
    fn from_row(r: &Row) -> Result<Case, Refusal> {
        let g = |i: usize| -> Result<String, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
        let o = |i: usize| -> Result<Option<String>, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
        let t = |i: usize| -> Result<Option<Instant>, Refusal> {
            Ok(r.try_get::<_, Option<i64>>(i)
                .map_err(|e| pg(&e))?
                .map(Instant))
        };
        Ok(Case {
            id: g(0)?,
            case_key: g(1)?,
            card_id: g(2)?,
            user_id: g(3)?,
            authorization_ref: g(4)?,
            asset_id: g(5)?,
            amount: g(6)?,
            reason: g(7)?,
            state: g(8)?,
            test: r.try_get(9).map_err(|e| pg(&e))?,
            credit_requested_at: t(10)?,
            credit_amount: o(11)?,
            credit_partner_ref: o(12)?,
            credited_at: t(13)?,
            outcome: o(14)?,
            decision_reason: o(15)?,
            loss_status: o(16)?,
            credit_settlement: o(17)?,
            credit_settlement_partner_ref: o(18)?,
            closed_at: t(19)?,
            decision_requested_outcome: o(20)?,
            created_at: t(21)?.unwrap_or(Instant(0)),
        })
    }
}

/// One line of a case's timeline (`DisputeEvent`).
#[derive(Debug, Clone)]
pub struct Event {
    pub sequence: i64,
    pub kind: String,
    pub from_state: Option<String>,
    pub to_state: String,
    pub actor: String,
    pub detail: Option<String>,
    pub after_submission: bool,
    pub at: Instant,
}

/// `DisputeCase`: the case and its timeline.
#[derive(Debug, Clone)]
pub struct Dispute {
    pub case: Case,
    pub events: Vec<Event>,
}

/// `row`: the case, optionally under its lock; an id that is no case's is not found.
fn case_row(c: &mut impl GenericClient, id: &str, lock: bool) -> Result<Case, Refusal> {
    let shaped = id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-');
    if !shaped {
        return Err(not_found());
    }
    let rows = c
        .query(
            &format!(
                "SELECT {} {CASE_FROM} WHERE d.id = $1::text::uuid{}",
                case_cols(),
                if lock { " FOR UPDATE OF d" } else { "" }
            ),
            &[&id],
        )
        .map_err(|e| pg(&e))?;
    rows.first()
        .map(Case::from_row)
        .transpose()?
        .ok_or_else(not_found)
}

/// `CardDisputeService.get`: the case and its timeline.
pub fn get(c: &mut impl GenericClient, id: &str) -> Result<Dispute, Refusal> {
    let case = case_row(c, id, false)?;
    let rows = c
        .query(
            &format!(
                "SELECT sequence::int8, kind, from_state, to_state, actor, detail, after_submission, {} \
                   FROM bank.card_dispute_events WHERE dispute_id = $1::text::uuid ORDER BY sequence",
                ms("at")
            ),
            &[&case.id],
        )
        .map_err(|e| pg(&e))?;
    let events = rows
        .iter()
        .map(|r| Event {
            sequence: r.get(0),
            kind: r.get(1),
            from_state: r.get(2),
            to_state: r.get(3),
            actor: r.get(4),
            detail: r.get(5),
            after_submission: r.get(6),
            at: Instant(r.get(7)),
        })
        .collect();
    Ok(Dispute { case, events })
}

/// `event`: one line in the case's timeline, at the clock's time.
#[allow(
    clippy::too_many_arguments,
    reason = "the TypeScript's one helper, with its own nine fields"
)]
fn event(
    tx: &mut impl GenericClient,
    now: Instant,
    id: &str,
    event_key: &str,
    kind: &str,
    from: Option<&str>,
    to: &str,
    actor: &str,
    detail: Option<&str>,
    after_submission: bool,
) -> Result<(), Refusal> {
    tx.execute(
        &format!(
            "INSERT INTO bank.card_dispute_events (dispute_id, sequence, kind, from_state, to_state, actor, detail, after_submission, event_key, at) \
             VALUES ($1::text::uuid, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM bank.card_dispute_events WHERE dispute_id = $1::text::uuid), \
                     $2, $3, $4, $5, $6, $7, $8, {})",
            at(now)
        ),
        &[&id, &kind, &from, &to, &actor, &detail, &after_submission, &event_key],
    )
    .map_err(|e| pg(&e))?;
    Ok(())
}

/// What a case is opened with (`CardDisputeService.open`'s input).
pub struct OpenAsk<'a> {
    pub case_key: &'a str,
    pub card_id: &'a str,
    pub authorization_ref: &'a str,
    pub amount: &'a str,
    pub reason: &'a str,
    pub actor: &'a str,
}

/// `CardDisputeService.open`: a case for one settled capture of one card. The amount may not be above what was captured
/// on that authorisation. The same case key with the same figures returns the case; with other figures, or a second
/// case for the same payment, it refuses.
pub fn open(d: &Deps<'_>, ask: &OpenAsk<'_>) -> Result<Dispute, Refusal> {
    let case_key = step_key(ask.case_key)?;
    let reason = bounded(ask.reason, 1, 500, "A dispute reason")?;
    let positive = is_decimal(ask.amount) && amount(ask.amount)? > 0;
    if !positive {
        return Err(invalid(
            "A disputed amount is a positive decimal (bank.card_dispute_invalid)",
        ));
    }
    let disputed = amount(ask.amount)?;
    let id = case_id(case_key);
    let simulated = d.issuer().programme().simulated;
    let now = d.now();
    in_tx(d.store(), |tx| {
        let auth = tx
            .query(
                "SELECT a.id::text, k.user_id, k.asset_id, \
                        COALESCE((SELECT SUM(s.amount) FROM bank.card_settlements s \
                                   WHERE s.authorization_id = a.id AND s.kind = 'capture' AND s.status = 'settled'), 0)::text \
                   FROM bank.card_authorizations a JOIN bank.cards k ON k.id = a.card_id \
                  WHERE a.card_id = $1::text::uuid AND a.authorization_ref = $2 AND a.decision = 'approved'",
                &[&ask.card_id, &ask.authorization_ref],
            )
            .map_err(|e| pg(&e))?;
        let auth = match auth.first() {
            Some(r) => (
                r.get::<_, String>(0),
                r.get::<_, String>(1),
                r.get::<_, String>(2),
                amount(&r.get::<_, String>(3))?,
            ),
            None => (String::new(), String::new(), String::new(), 0),
        };
        let (auth_id, user_id, asset_id, captured) = auth;
        if auth_id.is_empty() || captured == 0 {
            return Err(refuse(
                "bank.card_dispute_not_disputable",
                "That card payment has no settled capture to dispute (bank.card_dispute_not_disputable)",
            ));
        }
        if disputed > captured {
            return Err(refuse(
                "bank.card_dispute_not_disputable",
                format!(
                    "The disputed amount is above the {} captured (bank.card_dispute_not_disputable)",
                    format_amount(captured)
                ),
            ));
        }
        // Insert first: of two concurrent opens one inserts and the other conflicts, and then reads what the first wrote.
        let inserted = tx
            .query(
                "INSERT INTO bank.card_disputes (id, case_key, card_id, user_id, authorization_id, asset_id, amount, reason, state, test) \
                 VALUES ($1::text::uuid, $2, $3::text::uuid, $4::text::uuid, $5::text::uuid, $6, $7::text::numeric, $8, 'opened', $9) \
                 ON CONFLICT DO NOTHING RETURNING id",
                &[
                    &id,
                    &case_key,
                    &ask.card_id,
                    &user_id,
                    &auth_id,
                    &asset_id,
                    &format_amount(disputed),
                    &reason,
                    &simulated,
                ],
            )
            .map_err(|e| pg(&e))?;
        if inserted.is_empty() {
            let prior = tx
                .query(
                    "SELECT case_key, amount::text, reason, authorization_id::text FROM bank.card_disputes \
                      WHERE id = $1::text::uuid OR case_key = $2 OR authorization_id = $3::text::uuid \
                      ORDER BY (case_key = $2) DESC LIMIT 1",
                    &[&id, &case_key, &auth_id],
                )
                .map_err(|e| pg(&e))?;
            let same = match prior.first() {
                Some(p) => {
                    p.get::<_, String>(0) == case_key
                        && p.get::<_, String>(3) == auth_id
                        && amount(&p.get::<_, String>(1))? == disputed
                        && p.get::<_, String>(2) == reason
                }
                None => false,
            };
            if !same {
                return Err(invalid(
                    "That case key or that payment already has a different dispute (bank.card_dispute_invalid)",
                ));
            }
            return Ok(());
        }
        event(
            tx,
            now,
            &id,
            &format!("opened:{id}"),
            "opened",
            None,
            "opened",
            ask.actor,
            Some(&reason),
            false,
        )
    })?;
    with(d.store(), |c| get(c, &id))
}

/// `step`: one step under its key. A retried key that already ran the same step on the same case returns without
/// running again; the key on another case or another step refuses.
fn step(
    d: &Deps<'_>,
    id: &str,
    key: &str,
    kind: &str,
    f: impl FnOnce(&mut postgres::Transaction<'_>, &Case, &str) -> Result<(), Refusal>,
) -> Result<(), Refusal> {
    let event_key = format!("step:{}", step_key(key)?);
    in_tx(d.store(), |tx| {
        let row = case_row(tx, id, true)?;
        let done = tx
            .query(
                "SELECT dispute_id::text, kind FROM bank.card_dispute_events WHERE event_key = $1",
                &[&event_key],
            )
            .map_err(|e| pg(&e))?;
        if let Some(done) = done.first() {
            if done.get::<_, String>(0) != row.id || done.get::<_, String>(1) != kind {
                return Err(invalid(
                    "That step key was used for another step (bank.card_dispute_invalid)",
                ));
            }
            return Ok(());
        }
        f(tx, &row, &event_key)
    })
}

/// `addEvidence`: kept with its time; after the representment it is still kept, and marked as after submission.
pub fn add_evidence(
    d: &Deps<'_>,
    id: &str,
    key: &str,
    description: &str,
    actor: &str,
) -> Result<Dispute, Refusal> {
    let description = bounded(description, 1, 2000, "Evidence")?;
    let now = d.now();
    step(d, id, key, "evidence", |tx, row, event_key| {
        if row.state == "closed" {
            return Err(wrong_state("add evidence to", &row.state));
        }
        event(
            tx,
            now,
            &row.id,
            event_key,
            "evidence",
            Some(&row.state),
            &row.state,
            actor,
            Some(&description),
            row.state != "opened",
        )
    })?;
    with(d.store(), |c| get(c, id))
}

/// `lossFromTerms`: who bears the loss, as the partner's terms say at the decision, or "not known".
fn loss_from_terms(terms: &PartnerTerms) -> (&'static str, Option<String>, Option<String>) {
    match &terms.loss_liability {
        Some((bearer, words))
            if LOSS_BEARERS.contains(&bearer.as_str()) && !js_trim(words).is_empty() =>
        {
            ("reported", Some(bearer.clone()), Some(words.clone()))
        }
        _ => ("not_known", None, None),
    }
}

/// `close`: decide or withdraw. The outcome is pinned under the case's lock before the partner hears of it; a closed case
/// returns as it is. `cardholder` is under the owner's cap and needs the partner's credit; any credit is made final
/// (`cardholder`) or reversed (`merchant`, `withdrawn`) by the partner. A withdrawn case asks nobody who bears a loss.
pub fn close(
    d: &Deps<'_>,
    id: &str,
    outcome: &str,
    actor: &str,
    reason: Option<&str>,
) -> Result<Dispute, Refusal> {
    let row = in_tx(d.store(), |tx| {
        let r = case_row(tx, id, true)?;
        if r.state == "closed"
            || r.decision_requested_outcome
                .as_deref()
                .is_some_and(|o| o != outcome)
        {
            let pinned = r
                .outcome
                .as_deref()
                .or(r.decision_requested_outcome.as_deref());
            if pinned != Some(outcome) {
                let state = if r.state == "closed" {
                    "closed"
                } else {
                    "being decided"
                };
                return Err(wrong_state("be decided another way", state));
            }
            return Ok(r);
        }
        if outcome == "cardholder" {
            assert_under_cap(d, &r.asset_id, &dec(&r.amount)?)?;
        }
        if r.credit_requested_at.is_some() && r.credit_partner_ref.is_none() {
            return Err(refuse(
                "bank.card_dispute_state",
                "The partner has not answered the provisional credit asked on this case; grant it again to read its answer first (bank.card_dispute_state)",
            ));
        }
        if outcome == "cardholder" && r.credit_partner_ref.is_none() {
            return Err(refuse(
                "bank.card_dispute_state",
                "A decision for the cardholder needs the partner\u{2019}s provisional credit first (bank.card_dispute_state)",
            ));
        }
        tx.execute(
            "UPDATE bank.card_disputes SET decision_requested_outcome = $2, updated_at = now() WHERE id = $1::text::uuid",
            &[&r.id, &outcome],
        )
        .map_err(|e| pg(&e))?;
        Ok(r)
    })?;
    if row.state == "closed" {
        return with(d.store(), |c| get(c, &row.id));
    }
    let loss = if outcome == "withdrawn" {
        ("not_known", None, None)
    } else {
        loss_from_terms(&d.issuer().partner_terms()?)
    };
    let settlement = match &row.credit_partner_ref {
        Some(_) => {
            let kind = if outcome == "cardholder" {
                "final"
            } else {
                "reversed"
            };
            let partner_ref = d.issuer().settle_provisional_credit(
                &format!("card-dispute-decision:{}", row.id),
                &credit_key(&row.id),
                kind,
            )?;
            Some((kind, partner_ref))
        }
        None => None,
    };
    let now = d.now();
    in_tx(d.store(), |tx| {
        let locked = tx
            .query(
                "SELECT state FROM bank.card_disputes WHERE id = $1::text::uuid FOR UPDATE",
                &[&row.id],
            )
            .map_err(|e| pg(&e))?;
        let Some(from) = locked.first().map(|r| r.get::<_, String>(0)) else {
            return Ok(());
        };
        if from == "closed" {
            return Ok(());
        }
        let (kind, partner_ref) = match &settlement {
            Some((k, r)) => (Some(*k), Some(r.as_str())),
            None => (None, None),
        };
        tx.execute(
            &format!(
                "UPDATE bank.card_disputes \
                    SET state = 'closed', outcome = $2, decision_reason = $3, loss_status = $4, loss_bearer = $5, \
                        loss_terms = $6, credit_settlement = $7, credit_settlement_partner_ref = $8, closed_at = {}, updated_at = now() \
                  WHERE id = $1::text::uuid",
                at(now)
            ),
            &[
                &row.id,
                &outcome,
                &reason,
                &loss.0,
                &loss.1,
                &loss.2,
                &kind,
                &partner_ref,
            ],
        )
        .map_err(|e| pg(&e))?;
        let who = match outcome {
            "cardholder" => "Decided for the cardholder",
            "merchant" => "Decided for the merchant",
            _ => "Withdrawn by the cardholder",
        };
        let bears = match (&loss.1, &loss.2) {
            (Some(bearer), Some(words)) if loss.0 == "reported" => {
                format!("{bearer} bears the fraud loss under the partner's terms: {words}")
            }
            _ => format!("who bears the fraud loss is {NOT_KNOWN}"),
        };
        let credited = match &settlement {
            Some((k, r)) => format!("; the partner's provisional credit is {k}, reference {r}"),
            None => String::new(),
        };
        let because = reason
            .filter(|r| !r.is_empty())
            .map_or(String::new(), |r| format!(": {r}"));
        event(
            tx,
            now,
            &row.id,
            &format!("card-dispute-decision:{}", row.id),
            "closed",
            Some(&from),
            "closed",
            actor,
            Some(&format!("{who}{because}; {bears}{credited}")),
            false,
        )
    })?;
    with(d.store(), |c| get(c, &row.id))
}

/// `assertUnderDisputeCap`: the owner's cap for this asset, or a typed refusal.
pub fn assert_under_cap(d: &Deps<'_>, asset: &str, disputed: &str) -> Result<String, Refusal> {
    let limit = d
        .settings()
        .dispute_cap
        .as_ref()
        .and_then(|cap| cap.iter().find(|(a, _)| a == asset))
        .map(|(_, l)| l.clone());
    let Some(limit) = limit else {
        return Err(refuse(
            "bank.card_dispute_cap_unset",
            format!(
                "The dispute cap for {asset} is not published: it is the owner's to set (bank.card_dispute_cap_unset)"
            ),
        ));
    };
    if amount(disputed)? > amount(&limit)? {
        return Err(refuse(
            "bank.card_dispute_cap_exceeded",
            format!(
                "The disputed {disputed} {asset} is above the dispute cap of {limit} {asset} (bank.card_dispute_cap_exceeded)"
            ),
        ));
    }
    Ok(limit)
}

/// `CardholderDisputeForm`.
#[derive(Debug, Clone)]
pub struct Form {
    pub test: bool,
    pub rules: Option<DisputeRules>,
    pub authorization_ref: String,
    pub asset_id: String,
    pub merchant: Option<String>,
    pub captured: Amount,
    pub disputable: Amount,
    pub settled_at: Option<Instant>,
    pub deadline: Option<Instant>,
    /// One of `CARDHOLDER_DISPUTE_STANDINGS`.
    pub standing: &'static str,
    pub dispute_id: Option<String>,
}

impl Form {
    pub fn json(&self) -> Json {
        let t = |v: Option<Instant>| v.map_or(Json::Null, |t| Json::str(t.iso()));
        Json::obj([
            ("test", Json::Bool(self.test)),
            (
                "rules",
                self.rules.as_ref().map_or(Json::Null, |r| {
                    Json::obj([
                        ("windowDays", Json::int(r.window_days)),
                        (
                            "evidenceAfterSubmission",
                            Json::Bool(r.evidence_after_submission),
                        ),
                    ])
                }),
            ),
            (
                "charge",
                Json::obj([
                    (
                        "authorizationRef",
                        Json::str(self.authorization_ref.clone()),
                    ),
                    ("assetId", Json::str(self.asset_id.clone())),
                    (
                        "merchant",
                        self.merchant.clone().map_or(Json::Null, Json::str),
                    ),
                    ("captured", Json::str(format_amount(self.captured))),
                    (
                        "disputable",
                        Json::str(format_amount(self.disputable.max(0))),
                    ),
                    ("settledAt", t(self.settled_at)),
                ]),
            ),
            ("deadline", t(self.deadline)),
            ("standing", Json::str(self.standing)),
            (
                "disputeId",
                self.dispute_id.clone().map_or(Json::Null, Json::str),
            ),
        ])
    }
}

/// `STANDING_WORDS`.
fn standing_words(standing: &str) -> &'static str {
    match standing {
        "disputable" => "it can be disputed",
        "declined" => "it was declined, so nothing was taken",
        "not_settled" => "it has not settled yet",
        "refunded" => "the merchant refunded it in full",
        "already_disputed" => "it is disputed already",
        "window_closed" => "the partner's time to dispute it has passed",
        _ => "the card partner has not reported its dispute rules",
    }
}

/// `cardholderForm`: the partner's dispute rules and where this one charge stands under them. The caller checked the
/// card is theirs.
pub fn form(d: &Deps<'_>, card_id: &str, authorization_ref: &str) -> Result<Form, Refusal> {
    let rules = d.issuer().partner_terms()?.dispute_rules;
    let row = with(d.store(), |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT k.asset_id, a.decision::text, a.merchant, {}, \
                            COALESCE((SELECT SUM(s.amount) FROM bank.card_settlements s \
                                       WHERE s.authorization_id = a.id AND s.kind = 'capture' AND s.status = 'settled'), 0)::text, \
                            (SELECT floor(extract(epoch from MAX(s.settled_at)) * 1000)::int8 FROM bank.card_settlements s \
                              WHERE s.authorization_id = a.id AND s.kind = 'capture' AND s.status = 'settled'), \
                            COALESCE((SELECT r.amount FROM bank.card_partner_refunds r \
                                       WHERE r.authorization_id = a.id AND r.status = 'settled'), 0)::text, \
                            (SELECT d.id::text FROM bank.card_disputes d WHERE d.authorization_id = a.id) \
                       FROM bank.card_authorizations a JOIN bank.cards k ON k.id = a.card_id \
                      WHERE a.card_id = $1::text::uuid AND a.authorization_ref = $2",
                    ms("a.decided_at")
                ),
                &[&card_id, &authorization_ref],
            )
            .map_err(|e| pg(&e))?;
        let Some(r) = rows.first() else {
            return Err(refuse(
                "bank.card_dispute_not_found",
                "No such payment on this card (bank.card_dispute_not_found)",
            ));
        };
        Ok((
            r.get::<_, String>(0),
            r.get::<_, String>(1),
            r.get::<_, Option<String>>(2),
            Instant(r.get::<_, i64>(3)),
            amount(&r.get::<_, String>(4))?,
            r.get::<_, Option<i64>>(5).map(Instant),
            amount(&r.get::<_, String>(6))?,
            r.get::<_, Option<String>>(7),
        ))
    })?;
    let (asset_id, decision, merchant, decided_at, captured, settled, refunded, dispute_id) = row;
    let disputable = captured - refunded;
    let settled_at = settled.or((captured > 0).then_some(decided_at));
    let deadline = match (&rules, settled_at) {
        (Some(r), Some(s)) => Some(Instant(s.0 + r.window_days * DAY_MS)),
        _ => None,
    };
    let standing = if decision != "approved" {
        "declined"
    } else if captured == 0 {
        "not_settled"
    } else if disputable <= 0 {
        "refunded"
    } else if dispute_id.is_some() {
        "already_disputed"
    } else if rules.is_none() {
        "rules_unset"
    } else if deadline.is_some_and(|dl| d.now().0 > dl.0) {
        "window_closed"
    } else {
        "disputable"
    };
    Ok(Form {
        test: d.issuer().programme().simulated,
        rules,
        authorization_ref: authorization_ref.to_owned(),
        asset_id,
        merchant,
        captured,
        disputable,
        settled_at,
        deadline,
        standing,
        dispute_id,
    })
}

/// `cardholderOpen`: the cardholder files their own dispute of one charge, all or part of it, with their reason. The
/// case key is derived from the card and the payment, so a retried filing is the same case.
pub fn cardholder_open(
    d: &Deps<'_>,
    user_id: &str,
    card_id: &str,
    authorization_ref: &str,
    disputed: &str,
    reason: &str,
) -> Result<Dispute, Refusal> {
    let form = form(d, card_id, authorization_ref)?;
    let case_key = format!(
        "cardholder:{}",
        &sha256_hex(&format!("{card_id}\n{authorization_ref}"))[..40]
    );
    let ask = OpenAsk {
        case_key: &case_key,
        card_id,
        authorization_ref,
        amount: disputed,
        reason,
        actor: user_id,
    };
    if form.standing == "already_disputed"
        && form.dispute_id.as_deref() == Some(case_id(&case_key).as_str())
    {
        return open(d, &ask);
    }
    if form.standing == "rules_unset" {
        return Err(refuse(
            "bank.card_dispute_rules_unset",
            "The card partner has not reported its dispute rules, so no dispute can be filed (bank.card_dispute_rules_unset)",
        ));
    }
    if form.standing != "disputable" {
        return Err(refuse(
            "bank.card_dispute_not_disputable",
            format!(
                "This payment cannot be disputed: {} (bank.card_dispute_not_disputable)",
                standing_words(form.standing)
            ),
        ));
    }
    let shown = format_amount(form.disputable.max(0));
    if is_decimal(disputed) && amount(disputed)? > form.disputable.max(0) {
        return Err(refuse(
            "bank.card_dispute_not_disputable",
            format!(
                "The disputed amount is above the {shown} {} that can be disputed (bank.card_dispute_not_disputable)",
                form.asset_id
            ),
        ));
    }
    open(d, &ask)
}

/// `cardholderList`: the cardholder's own cases on one card, newest first.
pub fn cardholder_list(d: &Deps<'_>, user_id: &str, card_id: &str) -> Result<Vec<Case>, Refusal> {
    with(d.store(), |c| {
        c.query(
            &format!(
                "SELECT {} {CASE_FROM} WHERE d.user_id = $1::text::uuid AND d.card_id = $2::text::uuid \
                  ORDER BY d.created_at DESC, d.id LIMIT $3",
                case_cols()
            ),
            &[&user_id, &card_id, &LIST_LIMIT],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(Case::from_row)
        .collect()
    })
}

/// `cardholderGet`: one of the cardholder's own cases; another person's reads as not found.
pub fn cardholder_get(d: &Deps<'_>, user_id: &str, id: &str) -> Result<Dispute, Refusal> {
    let found = with(d.store(), |c| get(c, id))?;
    if found.case.user_id != user_id {
        return Err(not_found());
    }
    Ok(found)
}

/// `cardholderEvidence`: taken while the case is open; once the representment is submitted, only where the partner's
/// rules take it. The same words on the same case are the same step.
pub fn cardholder_evidence(
    d: &Deps<'_>,
    user_id: &str,
    id: &str,
    description: &str,
) -> Result<Dispute, Refusal> {
    let found = cardholder_get(d, user_id, id)?;
    let rules = d.issuer().partner_terms()?.dispute_rules;
    let state = found.case.state.as_str();
    if state != "opened"
        && state != "closed"
        && !rules.as_ref().is_some_and(|r| r.evidence_after_submission)
    {
        return Err(refuse(
            "bank.card_dispute_evidence_closed",
            if rules.is_some() {
                "The card partner takes no more evidence from you once the representment is submitted (bank.card_dispute_evidence_closed)"
            } else {
                "The card partner has not reported whether it takes evidence after the representment (bank.card_dispute_evidence_closed)"
            },
        ));
    }
    let key = format!(
        "cardholder-evidence:{}",
        &sha256_hex(&format!("{}\n{}", found.case.id, js_trim(description)))[..40]
    );
    add_evidence(d, &found.case.id, &key, description, user_id)
}

/// `cardholderWithdraw`: the case closes `withdrawn`, and any provisional credit is reversed by the partner.
pub fn cardholder_withdraw(
    d: &Deps<'_>,
    user_id: &str,
    id: &str,
    reason: &str,
) -> Result<Dispute, Refusal> {
    let found = cardholder_get(d, user_id, id)?;
    let reason = bounded(reason, 1, 500, "A reason")?;
    close(d, &found.case.id, "withdrawn", user_id, Some(&reason))
}

/// `cardholderCase`: the case as its cardholder reads it; `events` is `None` for the list, which omits them.
pub fn cardholder_case(
    user_id: &str,
    case: &Case,
    events: Option<&[Event]>,
) -> Result<Json, Refusal> {
    let opt = |v: &Option<String>| v.clone().map_or(Json::Null, Json::str);
    let t = |v: Option<Instant>| v.map_or(Json::Null, |t| Json::str(t.iso()));
    let credit_state = if case.credit_partner_ref.is_some() {
        "credited"
    } else if case.credit_requested_at.is_some() {
        "asked"
    } else {
        "none"
    };
    let credit_amount = case.credit_amount.as_deref().map(dec).transpose()?;
    let decision = match (&case.outcome, &case.loss_status, case.closed_at) {
        (Some(outcome), Some(_), Some(closed)) if case.state == "closed" => Json::obj([
            ("outcome", Json::str(outcome.clone())),
            ("reason", opt(&case.decision_reason)),
            ("creditSettlement", opt(&case.credit_settlement)),
            (
                "creditSettlementPartnerRef",
                opt(&case.credit_settlement_partner_ref),
            ),
            ("closedAt", Json::str(closed.iso())),
        ]),
        _ => Json::Null,
    };
    let mut fields = vec![
        ("id", Json::str(case.id.clone())),
        ("cardId", Json::str(case.card_id.clone())),
        (
            "authorizationRef",
            Json::str(case.authorization_ref.clone()),
        ),
        ("assetId", Json::str(case.asset_id.clone())),
        ("amount", Json::str(dec(&case.amount)?)),
        ("reason", Json::str(case.reason.clone())),
        ("state", Json::str(case.state.clone())),
        ("test", Json::Bool(case.test)),
        (
            "provisionalCredit",
            Json::obj([
                ("state", Json::str(credit_state)),
                ("amount", credit_amount.map_or(Json::Null, Json::str)),
                ("partnerRef", opt(&case.credit_partner_ref)),
                ("at", t(case.credited_at)),
            ]),
        ),
        ("decision", decision),
        ("createdAt", Json::str(case.created_at.iso())),
    ];
    if let Some(events) = events {
        fields.push((
            "events",
            Json::Array(
                events
                    .iter()
                    .map(|e| {
                        let mine = e.actor == user_id;
                        Json::obj([
                            ("sequence", Json::int(e.sequence)),
                            ("kind", Json::str(e.kind.clone())),
                            ("fromState", opt(&e.from_state)),
                            ("toState", Json::str(e.to_state.clone())),
                            ("by", Json::str(if mine { "you" } else { "support" })),
                            ("detail", if mine { opt(&e.detail) } else { Json::Null }),
                            ("afterSubmission", Json::Bool(e.after_submission)),
                            ("at", Json::str(e.at.iso())),
                        ])
                    })
                    .collect(),
            ),
        ));
    }
    Ok(Json::Object(
        fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect(),
    ))
}

fn whole(user_id: &str, d: &Dispute) -> Result<Json, Refusal> {
    cardholder_case(user_id, &d.case, Some(&d.events))
}

/// This part's calls, or `None` for a call it does not hold.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let input = &ctx.input;
    let user = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    let card_id = text(input, "cardId");
    let dispute_id = text(input, "disputeId");
    Some(match ctx.call.path {
        "cards.disputes.form" => own(d, user, card_id)
            .and_then(|_| form(d, card_id, text(input, "authorizationRef")))
            .map(|f| f.json()),
        "cards.disputes.open" => own(d, user, card_id)
            .and_then(|_| {
                cardholder_open(
                    d,
                    user,
                    card_id,
                    text(input, "authorizationRef"),
                    text(input, "amount"),
                    text(input, "reason"),
                )
            })
            .and_then(|c| whole(user, &c)),
        "cards.disputes.list" => own(d, user, card_id)
            .and_then(|_| cardholder_list(d, user, card_id))
            .and_then(|rows| {
                rows.iter()
                    .map(|r| cardholder_case(user, r, None))
                    .collect::<Result<Vec<_>, _>>()
                    .map(Json::Array)
            }),
        "cards.disputes.get" => cardholder_get(d, user, dispute_id).and_then(|c| whole(user, &c)),
        "cards.disputes.evidence" => {
            cardholder_evidence(d, user, dispute_id, text(input, "description"))
                .and_then(|c| whole(user, &c))
        }
        "cards.disputes.withdraw" => {
            cardholder_withdraw(d, user, dispute_id, text(input, "reason"))
                .and_then(|c| whole(user, &c))
        }
        _ => return None,
    })
}
