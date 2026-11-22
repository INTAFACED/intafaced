//! 3D Secure challenges and card fraud reports (`card-safety.ts`; the router's `threeDS.list`, `threeDS.answer`,
//! `fraud.report`, `fraud.list`; J-bank-14 #5, #7).
//!
//! A 3D Secure challenge is the card partner asking the cardholder to confirm an online purchase. The partner holds the
//! code; this row never does, only how many wrong codes were typed. The owner's count (`BANK_CARD_3DS_TRY_LIMIT`) of
//! wrong codes locks the challenge. The right code approves it, and the purchase's authorisation is then driven once,
//! under the business key `3ds:<challenge ref>`, through `CardService.authorize`: that move is slice `card-ops`', so an
//! approved challenge with no authorisation answers "not ported" until that slice is, and stays approved for it to finish
//! (the TypeScript's own crash path: the next answer with no code finishes it).
//!
//! A fraud report freezes the card as the person's own lock and opens one case for that payment: the payment is the
//! business key, so filing again returns the same case. Nothing here moves money.

use postgres::{GenericClient, Row};
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount};
use service_kit::time::Instant;

use super::core::{opt_text, text};
use super::{Card, Deps, card, ms, owned_card};
use crate::door::Ctx;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{in_tx, pg, with};

/// One `bank.card_3ds_challenges` row (`ChallengeRow`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Challenge {
    pub id: String,
    pub card_id: String,
    pub user_id: String,
    pub challenge_ref: String,
    pub amount: String,
    pub merchant: Option<String>,
    pub merchant_country: Option<String>,
    pub merchant_category: Option<String>,
    /// `open`, `approved` or `locked`.
    pub state: String,
    pub wrong_codes: i64,
    pub authorization_id: Option<String>,
    pub created_at: Instant,
}

fn challenge_cols() -> String {
    format!(
        "id::text, card_id::text, user_id, challenge_ref, amount, merchant, merchant_country, merchant_category, state, \
         wrong_codes::int8, authorization_id::text, {}",
        ms("created_at")
    )
}

impl Challenge {
    fn from_row(r: &Row) -> Result<Challenge, Refusal> {
        let g = |i: usize| -> Result<String, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
        let o = |i: usize| -> Result<Option<String>, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
        Ok(Challenge {
            id: g(0)?,
            card_id: g(1)?,
            user_id: g(2)?,
            challenge_ref: g(3)?,
            amount: g(4)?,
            merchant: o(5)?,
            merchant_country: o(6)?,
            merchant_category: o(7)?,
            state: g(8)?,
            wrong_codes: r.try_get(9).map_err(|e| pg(&e))?,
            authorization_id: o(10)?,
            created_at: Instant(r.try_get(11).map_err(|e| pg(&e))?),
        })
    }
}

/// `threeDSAuthorizationRef`: the business key of the authorisation a challenge completes.
pub fn three_ds_authorization_ref(challenge_ref: &str) -> String {
    format!("3ds:{challenge_ref}")
}

/// `sameCode`: equal length and every byte equal, compared without stopping early.
fn same_code(typed: &str, expected: &str) -> bool {
    let (a, b) = (typed.as_bytes(), expected.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn not_found() -> Refusal {
    refuse(
        "bank.card_3ds_not_found",
        "No such 3D Secure challenge on this card",
    )
}

fn conflict() -> Refusal {
    refuse(
        "bank.card_3ds_conflict",
        "This challenge was already opened for a different purchase",
    )
}

/// `codeSource`: the partner's code for one challenge, or `bank.card_3ds_issuer_unset`.
fn code_of(d: &Deps<'_>, challenge_id: &str) -> Result<String, Refusal> {
    d.issuer().three_ds_code(challenge_id).ok_or_else(|| {
        refuse(
            "bank.card_3ds_issuer_unset",
            "No card partner can send a 3D Secure code for this card",
        )
    })
}

/// The authorisation a challenge or a fraud report names, as `authorizationById` reads it: its card, decision and
/// decline code.
pub struct Payment {
    pub card_id: String,
    pub decision: String,
    pub decline_code: Option<String>,
}

pub fn payment(
    c: &mut impl GenericClient,
    authorization_id: &str,
) -> Result<Option<Payment>, Refusal> {
    let rows = c
        .query(
            "SELECT a.card_id::text, a.decision::text, a.decline_code FROM bank.card_authorizations a \
               JOIN bank.cards k ON k.id = a.card_id WHERE a.id = $1::text::uuid",
            &[&authorization_id],
        )
        .map_err(|e| pg(&e))?;
    Ok(rows.first().map(|r| Payment {
        card_id: r.get(0),
        decision: r.get(1),
        decline_code: r.get(2),
    }))
}

/// `view`: the challenge as the person sees it.
fn view(d: &Deps<'_>, c: &mut impl GenericClient, row: &Challenge) -> Result<Json, Refusal> {
    let limit = d.settings().three_ds_try_limit;
    let test_code = if row.state == "open" {
        d.issuer().three_ds_code(&row.id)
    } else {
        None
    };
    let auth = match &row.authorization_id {
        Some(id) => payment(c, id)?,
        None => None,
    };
    let tries_left = if row.state != "open" {
        Json::int(0)
    } else {
        limit.map_or(Json::Null, |l| Json::int((l - row.wrong_codes).max(0)))
    };
    let opt = |v: &Option<String>| v.clone().map_or(Json::Null, Json::str);
    Ok(Json::obj([
        ("id", Json::str(row.id.clone())),
        ("cardId", Json::str(row.card_id.clone())),
        ("challengeRef", Json::str(row.challenge_ref.clone())),
        ("amount", Json::str(row.amount.clone())),
        ("merchant", opt(&row.merchant)),
        ("merchantCountry", opt(&row.merchant_country)),
        ("state", Json::str(row.state.clone())),
        ("triesLeft", tries_left),
        ("authorizationId", opt(&row.authorization_id)),
        (
            "decision",
            auth.as_ref()
                .map_or(Json::Null, |a| Json::str(a.decision.clone())),
        ),
        (
            "declineCode",
            auth.as_ref()
                .and_then(|a| a.decline_code.clone())
                .map_or(Json::Null, Json::str),
        ),
        ("createdAt", Json::str(row.created_at.iso())),
        ("testCode", test_code.map_or(Json::Null, Json::str)),
    ]))
}

fn row(
    c: &mut impl GenericClient,
    challenge_id: &str,
    card_id: &str,
    lock: bool,
) -> Result<Option<Challenge>, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.card_3ds_challenges WHERE id = $1::text::uuid AND card_id = $2::text::uuid{}",
                challenge_cols(),
                if lock { " FOR UPDATE" } else { "" }
            ),
            &[&challenge_id, &card_id],
        )
        .map_err(|e| pg(&e))?;
    rows.first().map(Challenge::from_row).transpose()
}

fn by_ref(
    c: &mut impl GenericClient,
    card_id: &str,
    challenge_ref: &str,
) -> Result<Option<Challenge>, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.card_3ds_challenges WHERE card_id = $1::text::uuid AND challenge_ref = $2",
                challenge_cols()
            ),
            &[&card_id, &challenge_ref],
        )
        .map_err(|e| pg(&e))?;
    rows.first().map(Challenge::from_row).transpose()
}

/// What the issuer asks (`CardSafety.open`'s input).
#[derive(Debug, Clone, Default)]
pub struct OpenAsk {
    pub challenge_id: String,
    pub card_id: String,
    pub challenge_ref: String,
    pub amount: Amount,
    pub merchant: Option<String>,
    pub merchant_country: Option<String>,
    pub merchant_category: Option<String>,
}

/// `CardSafety.open`, THE ISSUER'S SIDE (reached by `ops.cardThreeDSChallenge`, slice `card-ops`): one challenge per
/// card and reference; the same reference again returns it, and with different terms, or a challenge id already used for
/// another purchase, refuses `bank.card_3ds_conflict`. A card that cannot authorise now is not asked
/// (`bank.card_not_active`).
pub fn open(d: &Deps<'_>, ask: &OpenAsk) -> Result<Json, Refusal> {
    // `codeSource()`: the partner must be able to send a code at all; the code itself is not read here.
    code_of(d, &ask.challenge_id)?;
    with(d.store(), |c| {
        let card: Card = card(c, &ask.card_id)?;
        let amount = format_amount(ask.amount);
        let country = ask.merchant_country.as_deref().map(str::to_uppercase);
        if by_ref(c, &card.id, &ask.challenge_ref)?.is_none()
            && !(card.status == "active" && !card.inactive())
        {
            return Err(refuse("bank.card_not_active", "This card is not active"));
        }
        c.execute(
            "INSERT INTO bank.card_3ds_challenges (id, card_id, user_id, challenge_ref, amount, merchant, merchant_country, merchant_category) \
             VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING",
            &[
                &ask.challenge_id,
                &card.id,
                &card.user_id,
                &ask.challenge_ref,
                &amount,
                &ask.merchant,
                &country,
                &ask.merchant_category,
            ],
        )
        .map_err(|e| pg(&e))?;
        // No row under this reference: the challenge id was already taken by another purchase.
        let row = by_ref(c, &card.id, &ask.challenge_ref)?.ok_or_else(conflict)?;
        if row.amount != amount
            || row.merchant != ask.merchant
            || row.merchant_country != country
            || row.merchant_category != ask.merchant_category
        {
            return Err(conflict());
        }
        view(d, c, &row)
    })
}

/// `CardSafety.list`: the person's challenges on one card, newest first.
pub fn list(
    d: &Deps<'_>,
    card_id: &str,
    user_id: &str,
    limit: Option<i64>,
) -> Result<Json, Refusal> {
    with(d.store(), |c| {
        let card = owned_card(c, card_id, user_id)?;
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.card_3ds_challenges WHERE card_id = $1::text::uuid ORDER BY created_at DESC, id LIMIT $2",
                    challenge_cols()
                ),
                &[&card.id, &limit.unwrap_or(20).clamp(1, 100)],
            )
            .map_err(|e| pg(&e))?;
        let mut out = Vec::with_capacity(rows.len());
        for r in &rows {
            out.push(view(d, c, &Challenge::from_row(r)?)?);
        }
        Ok(Json::Array(out))
    })
}

/// `CardSafety.answer`: a wrong code counts once and, at the owner's count, locks the challenge; a decided challenge
/// checks no more codes. The right code approves it. An approved challenge with no authorisation is completed through
/// `CardService.authorize`, slice `card-ops`'; until it is ported that answers "not ported" and the challenge stays
/// approved with no authorisation, which the next answer with no code finishes, as after a crash in the TypeScript.
pub fn answer_challenge(
    d: &Deps<'_>,
    card_id: &str,
    user_id: &str,
    challenge_id: &str,
    code: Option<&str>,
) -> Result<Json, Refusal> {
    let card = with(d.store(), |c| owned_card(c, card_id, user_id))?;
    let seen = with(d.store(), |c| row(c, challenge_id, &card.id, false))?.ok_or_else(not_found)?;
    let mut decided = seen.clone();
    if seen.state == "open" {
        let Some(limit) = d.settings().three_ds_try_limit else {
            return Err(refuse(
                "bank.card_3ds_try_limit_unset",
                "The owner has not set how many wrong 3D Secure codes lock a challenge (BANK_CARD_3DS_TRY_LIMIT)",
            ));
        };
        let Some(typed) = code else {
            return Err(refuse(
                "bank.card_3ds_code_missing",
                "Enter the code the card partner sent you",
            ));
        };
        let expected = code_of(d, &seen.id)?;
        decided = in_tx(d.store(), |tx| {
            let r = row(tx, &seen.id, &card.id, true)?.ok_or_else(not_found)?;
            if r.state != "open" {
                return Ok(r);
            }
            let cols = challenge_cols();
            let updated = if same_code(typed, &expected) {
                tx.query(
                    &format!(
                        "UPDATE bank.card_3ds_challenges SET state = 'approved', decided_at = now() \
                         WHERE id = $1::text::uuid RETURNING {cols}"
                    ),
                    &[&r.id],
                )
            } else {
                let wrong = r.wrong_codes + 1;
                let state = if wrong >= limit { "locked" } else { "open" };
                tx.query(
                    &format!(
                        "UPDATE bank.card_3ds_challenges \
                            SET wrong_codes = $2::int8::int4, state = $3, \
                                decided_at = CASE WHEN $3 = 'locked' THEN now() ELSE decided_at END \
                          WHERE id = $1::text::uuid RETURNING {cols}"
                    ),
                    &[&r.id, &wrong, &state],
                )
            }
            .map_err(|e| pg(&e))?;
            updated
                .first()
                .map(Challenge::from_row)
                .transpose()?
                .ok_or_else(not_found)
        })?;
    }
    if decided.state != "approved" || decided.authorization_id.is_some() {
        return with(d.store(), |c| view(d, c, &decided));
    }
    // Approved and not yet authorised: `authorize(cardId, '3ds:<ref>', amount, online, merchant...)` is slice
    // `card-ops`' move. The challenge stays approved with no authorisation until it is ported.
    Err(Refusal::Trpc(crate::door::not_ported(
        crate::door::Slice::CardOps,
    )))
}

fn report_json(r: &Row) -> Json {
    Json::obj([
        ("id", Json::str(r.get::<_, String>(0))),
        ("cardId", Json::str(r.get::<_, String>(1))),
        ("authorizationId", Json::str(r.get::<_, String>(2))),
        ("state", Json::str("open")),
        ("createdAt", Json::str(Instant(r.get::<_, i64>(3)).iso())),
    ])
}

fn report_cols() -> String {
    format!(
        "id::text, card_id::text, authorization_id::text, {}",
        ms("created_at")
    )
}

/// `CardSafety.reportFraud`: the card is frozen as the person's own lock and one case opens for that payment; the same
/// payment again returns the same case (and freezes again if it was unfrozen). A declined payment is not reported.
pub fn report_fraud(
    d: &Deps<'_>,
    card_id: &str,
    user_id: &str,
    authorization_id: &str,
) -> Result<Json, Refusal> {
    let card = with(d.store(), |c| {
        let card = owned_card(c, card_id, user_id)?;
        let paid = payment(c, authorization_id)?;
        let Some(paid) = paid.filter(|p| p.card_id == card.id) else {
            return Err(refuse(
                "bank.card_authorization_not_found",
                "No such card payment on this card",
            ));
        };
        if paid.decision != "approved" {
            return Err(refuse(
                "bank.card_authorization_declined",
                "A declined payment moved nothing, so there is no fraud to report on it",
            ));
        }
        let id = service_kit::approvals::random_uuid().map_err(Refusal::Other)?;
        c.execute(
            "INSERT INTO bank.card_fraud_reports (id, card_id, user_id, authorization_id) \
             VALUES ($1::text::uuid, $2::text::uuid, $3, $4::text::uuid) ON CONFLICT (authorization_id) DO NOTHING",
            &[&id, &card.id, &user_id, &authorization_id],
        )
        .map_err(|e| pg(&e))?;
        Ok(card)
    })?;
    if card.status == "active" {
        super::core::set_status(d, &card.id, "frozen", Some(user_id))?;
    }
    with(d.store(), |c| {
        let r = c
            .query_one(
                &format!(
                    "SELECT {} FROM bank.card_fraud_reports WHERE authorization_id = $1::text::uuid",
                    report_cols()
                ),
                &[&authorization_id],
            )
            .map_err(|e| pg(&e))?;
        Ok(report_json(&r))
    })
}

/// `CardSafety.fraudReports`: the person's fraud reports on one card, newest first.
pub fn fraud_reports(d: &Deps<'_>, card_id: &str, user_id: &str) -> Result<Json, Refusal> {
    with(d.store(), |c| {
        let card = owned_card(c, card_id, user_id)?;
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.card_fraud_reports WHERE card_id = $1::text::uuid ORDER BY created_at DESC, id LIMIT 50",
                    report_cols()
                ),
                &[&card.id],
            )
            .map_err(|e| pg(&e))?;
        Ok(Json::Array(rows.iter().map(report_json).collect()))
    })
}

/// This part's calls, or `None` for a call it does not hold.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let input = &ctx.input;
    let user = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    let card_id = text(input, "cardId");
    Some(match ctx.call.path {
        "cards.threeDS.list" => {
            list(d, card_id, user, None).map(|challenges| Json::obj([("challenges", challenges)]))
        }
        "cards.threeDS.answer" => answer_challenge(
            d,
            card_id,
            user,
            text(input, "challengeId"),
            opt_text(input, "code"),
        ),
        "cards.fraud.report" => report_fraud(d, card_id, user, text(input, "authorizationId")),
        "cards.fraud.list" => {
            fraud_reports(d, card_id, user).map(|reports| Json::obj([("reports", reports)]))
        }
        _ => return None,
    })
}
