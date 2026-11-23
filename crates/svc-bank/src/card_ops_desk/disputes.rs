//! Card disputes as support works them (`ops/card-disputes.ts` and the support half of `cards/card-disputes.ts`;
//! J-bank-27, BK-cdisp-02, BK-cdisp-03). Reads are `admin:read`; every step is `support:ops` and records the signed-in
//! operator as its actor.
//!
//! The case is the one the cardholder files and works from their side (`cards::disputes`): its row, its timeline, its
//! open, its evidence and its close are that module's functions, reached from here. This module adds support's own
//! steps: the queue, the case with the owner's cap, the representment, arbitration (an explicit state, never implied),
//! the partner's provisional credit, and the decision.
//!
//! The money is the partner's (OWNER 226): a provisional credit is the partner's credit to its own cardholder, recorded
//! here with the amount and reference the partner answers with; nothing posts to the ledger and no figure here is summed
//! into a balance. The dispute cap is the owner's (`BANK_CARD_DISPUTE_CAP_JSON`), per asset.

use postgres::GenericClient;
use service_kit::json::Json;
use service_kit::time::Instant;

use crate::cards::Deps;
use crate::cards::disputes::{
    self as case, CASE_FROM, Case, Dispute, Event, OpenAsk, amount, assert_under_cap, at, bounded,
    case_cols, case_row, credit_key, dec, event, is_decimal, step, wrong_state,
};
use crate::cards::issuer::Issuer;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{in_tx, pg, with};

/// `LIST_LIMIT`.
const LIST_LIMIT: i64 = 200;

/// The card partner's side of a provisional credit (`CardIssuerAdapter`'s `programme`, `mutationRefuse` and
/// `provisionalCredit`), so a partner that fails, refuses or answers another figure can be put in its place.
pub trait CreditPartner {
    /// `programme.id`: `none` when no card issuer is configured.
    fn programme_id(&self) -> &str;
    /// `mutationRefuse`: set on the simulator in a live posture.
    fn mutation_refuse(&self) -> Option<&'static str>;
    /// Whether the adapter takes a provisional credit at all (`provisionalCredit` is optional on the adapter).
    fn takes_credit(&self) -> bool {
        true
    }
    /// `provisionalCredit`: `(partnerRef, amount)` as the partner answers, deduplicated on `request_id`.
    fn provisional_credit(
        &self,
        request_id: &str,
        user_id: &str,
        asset_id: &str,
        amount: &str,
    ) -> Result<(String, String), Refusal>;
}

impl CreditPartner for Issuer {
    fn programme_id(&self) -> &str {
        self.programme().id
    }
    fn mutation_refuse(&self) -> Option<&'static str> {
        Issuer::mutation_refuse(self)
    }
    fn provisional_credit(
        &self,
        request_id: &str,
        user_id: &str,
        asset_id: &str,
        amount: &str,
    ) -> Result<(String, String), Refusal> {
        Issuer::provisional_credit(self, request_id, user_id, asset_id, amount)
    }
}

fn opt(v: Option<&String>) -> Json {
    v.cloned().map_or(Json::Null, Json::str)
}

fn iso(t: Option<Instant>) -> Json {
    t.map_or(Json::Null, |t| Json::str(t.iso()))
}

/// `summary`: one case as support reads it, in the output's order.
fn summary(r: &Case) -> Result<Vec<(String, Json)>, Refusal> {
    let credit_state = if r.credit_partner_ref.is_some() {
        "credited"
    } else if r.credit_requested_at.is_some() {
        "asked"
    } else {
        "none"
    };
    let credit_amount = r.credit_amount.as_deref().map(dec).transpose()?;
    let decision = match (&r.outcome, &r.loss_status, r.closed_at) {
        (Some(outcome), Some(loss), Some(closed)) if r.state == "closed" => Json::obj([
            ("outcome", Json::str(outcome.clone())),
            ("reason", opt(r.decision_reason.as_ref())),
            ("lossStatus", Json::str(loss.clone())),
            ("lossBearer", opt(r.loss_bearer.as_ref())),
            ("lossTerms", opt(r.loss_terms.as_ref())),
            ("creditSettlement", opt(r.credit_settlement.as_ref())),
            (
                "creditSettlementPartnerRef",
                opt(r.credit_settlement_partner_ref.as_ref()),
            ),
            ("closedAt", Json::str(closed.iso())),
        ]),
        _ => Json::Null,
    };
    let fields = [
        ("id", Json::str(r.id.clone())),
        ("caseKey", Json::str(r.case_key.clone())),
        ("cardId", Json::str(r.card_id.clone())),
        ("userId", Json::str(r.user_id.clone())),
        ("authorizationRef", Json::str(r.authorization_ref.clone())),
        ("assetId", Json::str(r.asset_id.clone())),
        ("amount", Json::str(dec(&r.amount)?)),
        ("reason", Json::str(r.reason.clone())),
        ("state", Json::str(r.state.clone())),
        ("test", Json::Bool(r.test)),
        (
            "provisionalCredit",
            Json::obj([
                ("state", Json::str(credit_state)),
                ("amount", credit_amount.map_or(Json::Null, Json::str)),
                ("partnerRef", opt(r.credit_partner_ref.as_ref())),
                ("at", iso(r.credited_at)),
            ]),
        ),
        ("decision", decision),
        ("createdAt", Json::str(r.created_at.iso())),
    ];
    Ok(fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

fn event_json(e: &Event) -> Json {
    Json::obj([
        ("sequence", Json::int(e.sequence)),
        ("kind", Json::str(e.kind.clone())),
        ("fromState", opt(e.from_state.as_ref())),
        ("toState", Json::str(e.to_state.clone())),
        ("actor", Json::str(e.actor.clone())),
        ("detail", opt(e.detail.as_ref())),
        ("afterSubmission", Json::Bool(e.after_submission)),
        ("at", Json::str(e.at.iso())),
    ])
}

/// The owner's cap for one asset, as published, or `None` (not published).
fn cap_of(d: &Deps<'_>, asset: &str) -> Option<String> {
    d.settings()
        .dispute_cap
        .as_ref()?
        .iter()
        .find(|(a, _)| a == asset)
        .map(|(_, l)| l.clone())
}

/// `DisputeCase`: the case, the owner's cap for its asset, and its whole timeline.
pub fn case_json(d: &Deps<'_>, found: &Dispute) -> Result<Json, Refusal> {
    let mut fields = summary(&found.case)?;
    fields.push((
        "cap".to_owned(),
        cap_of(d, &found.case.asset_id).map_or(Json::Null, Json::str),
    ));
    fields.push((
        "events".to_owned(),
        Json::Array(found.events.iter().map(event_json).collect()),
    ));
    Ok(Json::Object(fields))
}

fn read(d: &Deps<'_>, id: &str) -> Result<Json, Refusal> {
    let found = with(d.store(), |c| case::get(c, id))?;
    case_json(d, &found)
}

/// `list`: the queue, newest first, optionally one state; `more` says it was cut at its limit.
pub fn list(d: &Deps<'_>, state: Option<&str>) -> Result<Json, Refusal> {
    let rows = with(d.store(), |c| {
        let filter = if state.is_some() {
            "d.state = $2"
        } else {
            "$2::text IS NULL"
        };
        c.query(
            &format!(
                "SELECT {} {CASE_FROM} WHERE {filter} ORDER BY d.created_at DESC, d.id LIMIT $1",
                case_cols()
            ),
            &[&(LIST_LIMIT + 1), &state],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(Case::from_row)
        .collect::<Result<Vec<_>, _>>()
    })?;
    let more = i64::try_from(rows.len()).unwrap_or(i64::MAX) > LIST_LIMIT;
    let rows = rows
        .iter()
        .take(usize::try_from(LIST_LIMIT).unwrap_or(usize::MAX))
        .map(|r| summary(r).map(Json::Object))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json::obj([
        ("rows", Json::Array(rows)),
        ("more", Json::Bool(more)),
    ]))
}

/// `get`: one case with its whole timeline and the owner's cap for its asset.
pub fn get(d: &Deps<'_>, id: &str) -> Result<Json, Refusal> {
    read(d, id)
}

/// `open`: support files a case on the cardholder's word (`CardDisputeService.open`).
pub fn open(d: &Deps<'_>, ask: &OpenAsk<'_>) -> Result<Json, Refusal> {
    let found = case::open(d, ask)?;
    case_json(d, &found)
}

/// `addEvidence`.
pub fn add_evidence(
    d: &Deps<'_>,
    id: &str,
    step_key: &str,
    description: &str,
    actor: &str,
) -> Result<Json, Refusal> {
    let found = case::add_evidence(d, id, step_key, description, actor)?;
    case_json(d, &found)
}

fn transition(tx: &mut impl GenericClient, id: &str, to: &str) -> Result<(), Refusal> {
    tx.execute(
        "UPDATE bank.card_disputes SET state = $2, updated_at = now() WHERE id = $1::text::uuid",
        &[&id, &to],
    )
    .map_err(|e| pg(&e))?;
    Ok(())
}

/// `submitRepresentment`: from opened only, and only with evidence on the case.
pub fn submit_representment(
    d: &Deps<'_>,
    id: &str,
    step_key: &str,
    description: &str,
    actor: &str,
) -> Result<Json, Refusal> {
    let description = bounded(description, 1, 2000, "A representment")?;
    let now = d.now();
    step(d, id, step_key, "representment", |tx, row, event_key| {
        if row.state != "opened" {
            return Err(wrong_state("submit a representment on", &row.state));
        }
        let evidence: i64 = tx
            .query_one(
                "SELECT count(*)::int8 FROM bank.card_dispute_events WHERE dispute_id = $1::text::uuid AND kind = 'evidence'",
                &[&row.id],
            )
            .map_err(|e| pg(&e))?
            .get(0);
        if evidence == 0 {
            return Err(refuse(
                "bank.card_dispute_state",
                "A representment needs evidence on the case first (bank.card_dispute_state)",
            ));
        }
        transition(tx, &row.id, "representment")?;
        event(
            tx,
            now,
            &row.id,
            event_key,
            "representment",
            Some("opened"),
            "representment",
            actor,
            Some(&description),
            false,
        )
    })?;
    read(d, id)
}

/// `escalateToArbitration`: an explicit state, only after a representment.
pub fn escalate_to_arbitration(
    d: &Deps<'_>,
    id: &str,
    step_key: &str,
    actor: &str,
) -> Result<Json, Refusal> {
    let now = d.now();
    step(d, id, step_key, "arbitration", |tx, row, event_key| {
        if row.state != "representment" {
            return Err(wrong_state("escalate to arbitration", &row.state));
        }
        transition(tx, &row.id, "arbitration")?;
        event(
            tx,
            now,
            &row.id,
            event_key,
            "arbitration",
            Some("representment"),
            "arbitration",
            actor,
            None,
            false,
        )
    })?;
    read(d, id)
}

fn partner_unset(message: &str) -> Refusal {
    refuse("bank.card_dispute_partner_unset", message)
}

/// `grantProvisionalCredit`: ask the partner for its provisional credit, once per case, under the cap. The ask is
/// written first, under the case's lock and only while no decision is under way, so a crash leaves it and a retry asks
/// again under the same key (`card-dispute-credit:<case id>`), which the partner deduplicates. The case records the
/// amount and reference the partner answers with; another amount than asked is not recorded. Nothing posts.
pub fn grant_provisional_credit(
    d: &Deps<'_>,
    id: &str,
    actor: &str,
    partner: &dyn CreditPartner,
) -> Result<Json, Refusal> {
    if !partner.takes_credit() {
        return Err(partner_unset(
            "The card partner takes no provisional credit through this programme (bank.card_dispute_partner_unset)",
        ));
    }
    // No partner, or the simulator in a live deployment, refuses by name before anything is written.
    if partner.programme_id() == "none" {
        return Err(refuse(
            "bank.no_card_issuer",
            "No card issuer is configured \u{2014} this deployment has no card partner to credit",
        ));
    }
    if let Some(code) = partner.mutation_refuse() {
        return Err(refuse(
            code,
            "card-sim is not a live issuer \u{2014} this deployment will not credit as if a partner exists",
        ));
    }
    let now = d.now();
    let row = in_tx(d.store(), |tx| {
        let r = case_row(tx, id, true)?;
        if r.credit_partner_ref.is_some() {
            return Ok(r);
        }
        if r.state == "closed" || r.decision_requested_outcome.is_some() {
            let state = if r.state == "closed" {
                "closed"
            } else {
                "being decided"
            };
            return Err(wrong_state("credit", state));
        }
        assert_under_cap(d, &r.asset_id, &dec(&r.amount)?)?;
        tx.execute(
            &format!(
                "UPDATE bank.card_disputes SET credit_requested_at = COALESCE(credit_requested_at, {}), updated_at = now() \
                  WHERE id = $1::text::uuid",
                at(now)
            ),
            &[&r.id],
        )
        .map_err(|e| pg(&e))?;
        Ok(r)
    })?;
    if row.credit_partner_ref.is_some() {
        return read(d, &row.id);
    }
    let asked = dec(&row.amount)?;
    let (partner_ref, credited) = match partner.provisional_credit(
        &credit_key(&row.id),
        &row.user_id,
        &row.asset_id,
        &asked,
    ) {
        Ok(answer) => answer,
        Err(e) => {
            // A definite refusal by name means nothing was credited: the ask is taken back, so the case is not left
            // waiting on an answer that will never come. Any other failure may have reached the partner, so the ask
            // stays and a retry asks again under the same key.
            if matches!(e, Refusal::Bank(_)) {
                with(d.store(), |c| {
                    c.execute(
                        "UPDATE bank.card_disputes SET credit_requested_at = NULL, updated_at = now() \
                          WHERE id = $1::text::uuid AND credit_partner_ref IS NULL",
                        &[&row.id],
                    )
                    .map_err(|e| pg(&e))
                })?;
            }
            return Err(e);
        }
    };
    if !is_decimal(&credited) || partner_ref.is_empty() {
        return Err(partner_unset(
            "The card partner answered the credit in a shape this service cannot record (bank.card_dispute_partner_unset)",
        ));
    }
    // The case asked for the disputed amount, under the cap. Another figure is not recorded as if it were that credit:
    // the ask stays open and support reads the partner's answer.
    if amount(&credited)? != amount(&row.amount)? {
        return Err(refuse(
            "bank.card_dispute_partner_mismatch",
            format!(
                "The card partner reports a credit of {credited} {}, not the {asked} asked; nothing was recorded (bank.card_dispute_partner_mismatch)",
                row.asset_id
            ),
        ));
    }
    let credited = dec(&credited)?;
    let now = d.now();
    in_tx(d.store(), |tx| {
        let locked = tx
            .query(
                "SELECT credit_partner_ref, state FROM bank.card_disputes WHERE id = $1::text::uuid FOR UPDATE",
                &[&row.id],
            )
            .map_err(|e| pg(&e))?;
        let Some(locked) = locked.first() else {
            return Err(Refusal::Other(format!("card dispute {} vanished", row.id)));
        };
        if locked.get::<_, Option<String>>(0).is_some() {
            return Ok(());
        }
        let state: String = locked.get(1);
        tx.execute(
            &format!(
                "UPDATE bank.card_disputes \
                    SET credit_amount = $2::text::numeric, credit_partner_ref = $3, credited_at = {}, updated_at = now() \
                  WHERE id = $1::text::uuid",
                at(now)
            ),
            &[&row.id, &credited, &partner_ref],
        )
        .map_err(|e| pg(&e))?;
        event(
            tx,
            now,
            &row.id,
            &credit_key(&row.id),
            "provisional_credit",
            Some(&state),
            &state,
            actor,
            Some(&format!(
                "{credited} {}, the partner's credit, reference {partner_ref}",
                row.asset_id
            )),
            false,
        )
    })?;
    read(d, &row.id)
}

/// `decide`: close the case for the cardholder or the merchant (`close`, shared with the cardholder's withdrawal). For
/// the cardholder it is under the cap and the partner's credit becomes final; for the merchant any credit is reversed
/// by the partner. Who bears the fraud loss is read from the partner's terms now, or "not known". A closed case
/// returns as it is.
pub fn decide(
    d: &Deps<'_>,
    id: &str,
    outcome: &str,
    actor: &str,
    reason: Option<&str>,
) -> Result<Json, Refusal> {
    let reason = reason
        .map(|r| bounded(r, 1, 500, "A decision reason"))
        .transpose()?;
    let found = case::close(d, id, outcome, actor, reason.as_deref())?;
    case_json(d, &found)
}
