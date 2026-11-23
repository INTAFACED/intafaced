//! The card itself (`card-service.ts`, `card-controls.ts`, `card-view.ts`; the router's `programme`, `list`, `issue`,
//! `setStatus`, `setLimits`, `setChannels`, `controls.*`, `replace`, `activate`, `uses`), and the freeze a shared pot's
//! holder asks for (`sharedPots.freezeCard`).
//!
//! The issuer is asked first, and a row is written only once it answered: a row the issuer never heard of is a card a
//! person can see and cannot use. A retried issue, limit or channel change is the same change (the card id, the
//! command id), and a different one under the same id refuses.

use postgres::GenericClient;
use service_kit::edge::Principal;
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::schema::Value;

use super::step_up as gate;
use super::{
    Address, CARD_COLS, Card, Deps, StatusChange, card, card_or_none, iso, ms, note_card_status,
    note_status_event, own, owned_card, update_status,
};
use crate::door::Ctx;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{in_tx, owner_list_limit, pg, with};

/// `CARD_CATEGORIES`.
pub const CATEGORIES: [&str; 8] = [
    "gambling",
    "cash_like",
    "adult",
    "travel",
    "entertainment",
    "online_shopping",
    "groceries",
    "fuel",
];

pub fn text<'v>(v: &'v Value, key: &str) -> &'v str {
    v.get(key).as_str().unwrap_or_default()
}

pub fn opt_text<'v>(v: &'v Value, key: &str) -> Option<&'v str> {
    v.get(key).as_str()
}

pub fn bool_of(v: &Value, key: &str) -> bool {
    matches!(v.get(key), Value::Bool(true))
}

pub fn int_of(v: &Value, key: &str) -> Option<i64> {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "the schema held it to a whole number"
    )]
    v.get(key).as_number().map(|n| n as i64)
}

pub fn amount_of(s: &str) -> Result<Amount, Refusal> {
    parse_amount(s).map_err(Refusal::Other)
}

/// A field that may be absent, `null`, or a value: `None` absent, `Some(None)` null.
pub fn tri<'v>(v: &'v Value, key: &str) -> Option<Option<&'v str>> {
    match v.get(key) {
        Value::Undefined => None,
        Value::Null => Some(None),
        x => Some(x.as_str()),
    }
}

/// `cardProgrammeOutput(issuer.programme)`.
pub fn programme_json(d: &Deps<'_>) -> Json {
    let p = d.issuer().programme();
    Json::obj([
        ("id", Json::str(p.id)),
        ("simulated", Json::Bool(p.simulated)),
        ("displayName", Json::str(p.display_name)),
    ])
}

/// `assertCardsListLimit`.
pub fn cards_list_limit(limit: Option<f64>) -> Result<i64, Refusal> {
    owner_list_limit(limit, "bank.cards_list_limit_unset", "cards.list")
}

/// `cardsPage`: one page of a person's cards, newest first.
pub fn cards_page(
    c: &mut impl GenericClient,
    user_id: &str,
    page: i64,
) -> Result<Vec<Card>, Refusal> {
    c.query(
        &format!("SELECT {CARD_COLS} FROM bank.cards WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2"),
        &[&user_id, &page],
    )
    .map_err(|e| pg(&e))?
    .iter()
    .map(Card::from_row)
    .collect()
}

/// `heldCount`: active or frozen cards of one kind this person holds. A closed card is not held.
pub fn held_count(
    c: &mut impl GenericClient,
    user_id: &str,
    card_type: &str,
) -> Result<i64, Refusal> {
    let row = c
        .query_one(
            "SELECT count(*)::int8 FROM bank.cards WHERE user_id = $1 AND card_type = $2 AND status <> 'closed'",
            &[&user_id, &card_type],
        )
        .map_err(|e| pg(&e))?;
    Ok(row.get(0))
}

pub(crate) fn assert_under_count(
    c: &mut impl GenericClient,
    user_id: &str,
    card_type: &str,
    limit: i64,
) -> Result<(), Refusal> {
    let held = held_count(c, user_id, card_type)?;
    if held >= limit {
        return Err(refuse(
            "bank.card_count_limit",
            format!(
                "You already hold {held} {card_type} card{}; the limit is {limit}.",
                if held == 1 { "" } else { "s" }
            ),
        ));
    }
    Ok(())
}

fn shipping_required() -> Refusal {
    refuse(
        "bank.card_shipping_address_required",
        "A physical card needs a delivery address",
    )
}

/// `requireShippingAddress`: every part trimmed, the country upper-cased, the blank optional parts null.
pub fn require_shipping_address(input: Option<&Address>) -> Result<Address, Refusal> {
    let a = input.ok_or_else(shipping_required)?;
    let t = |s: &str| service_kit::money::js_trim(s).to_owned();
    let opt = |s: &Option<String>| s.as_deref().map(t).filter(|v| !v.is_empty());
    let out = Address {
        name: t(&a.name),
        line1: t(&a.line1),
        line2: opt(&a.line2),
        city: t(&a.city),
        region: opt(&a.region),
        postal_code: t(&a.postal_code),
        country: t(&a.country).to_uppercase(),
    };
    let country_ok = out.country.len() == 2 && out.country.bytes().all(|b| b.is_ascii_uppercase());
    if out.name.is_empty()
        || out.line1.is_empty()
        || out.city.is_empty()
        || out.postal_code.is_empty()
        || !country_ok
    {
        return Err(shipping_required());
    }
    Ok(out)
}

/// The address an input names (`shippingAddressInput`), as given: `None` when absent.
pub fn address_of(v: &Value) -> Option<Address> {
    if matches!(v, Value::Undefined | Value::Null) {
        return None;
    }
    Some(Address {
        name: text(v, "name").to_owned(),
        line1: text(v, "line1").to_owned(),
        line2: opt_text(v, "line2").map(str::to_owned),
        city: text(v, "city").to_owned(),
        region: opt_text(v, "region").map(str::to_owned),
        postal_code: text(v, "postalCode").to_owned(),
        country: text(v, "country").to_owned(),
    })
}

/// What `issue` is asked for.
#[derive(Debug, Clone, Default)]
pub struct IssueAsk {
    pub card_id: String,
    pub user_id: String,
    pub asset_id: String,
    pub settlement_asset_id: Option<String>,
    pub cashback_bps: Option<i64>,
    pub per_authorization_limit: Amount,
    /// `None` is virtual.
    pub card_type: Option<String>,
    pub shipping_address: Option<Address>,
    /// `Some(false)` starts the card not activated (a physical card ordered through `cards.order`).
    pub activated: Option<bool>,
    pub uses_allowed: Option<i64>,
    pub design_id: Option<String>,
    pub delivery_speed: Option<String>,
    pub residence_country: Option<String>,
}

fn by_issuer_ref(
    c: &mut impl GenericClient,
    issuer: &str,
    issuer_ref: &str,
) -> Result<Option<Card>, Refusal> {
    c.query(
        &format!("SELECT {CARD_COLS} FROM bank.cards WHERE issuer = $1 AND issuer_ref = $2"),
        &[&issuer, &issuer_ref],
    )
    .map_err(|e| pg(&e))?
    .first()
    .map(Card::from_row)
    .transpose()
}

fn address_text(a: Option<&Address>) -> Option<String> {
    a.map(|a| a.json().compact())
}

/// `issue`: the issuer first, then the row under the person's count lock. A redelivered issue is the same card.
pub fn issue(d: &Deps<'_>, ask: &IssueAsk) -> Result<Card, Refusal> {
    d.assert_module_enabled()?;
    d.assert_issuer_may_mutate()?;
    let card_type = ask
        .card_type
        .clone()
        .unwrap_or_else(|| "virtual".to_owned());
    if let Some(u) = ask.uses_allowed {
        if u < 1 {
            return Err(refuse(
                "bank.card_use_limit_invalid",
                "A use limit is a whole number of payments, at least one",
            ));
        }
        if card_type != "virtual" {
            return Err(refuse(
                "bank.card_use_limit_invalid",
                "Only a virtual card can be single-use or limited to a number of payments",
            ));
        }
    }
    if ask.per_authorization_limit <= Amount::ZERO {
        return Err(refuse(
            "bank.card_limit_exceeded",
            "A card needs a positive per-authorisation limit",
        ));
    }
    let shipping = if card_type == "physical" {
        Some(require_shipping_address(ask.shipping_address.as_ref())?)
    } else {
        None
    };
    let settlement = ask
        .settlement_asset_id
        .clone()
        .unwrap_or_else(|| ask.asset_id.clone());
    let limit = d.settings().programme.as_ref().map(|t| t.limit(&card_type));
    if let Some(limit) = limit {
        with(d.store(), |c| {
            if card_or_none(c, &ask.card_id)?.is_none() {
                assert_under_count(c, &ask.user_id, &card_type, limit)?;
            }
            Ok(())
        })?;
    }
    let handle = d.issuer().issue(&ask.card_id)?;
    let programme = d.issuer().programme();
    let activated_at: Option<i64> = (ask.activated != Some(false)).then_some(d.now().0);
    let per = format_amount(ask.per_authorization_limit);
    let bps = ask.cashback_bps.unwrap_or(0);
    let addr = address_text(shipping.as_ref());
    let inserted = in_tx(d.store(), |tx| {
        let lock = format!("card-count:{}", ask.user_id);
        tx.execute("SELECT pg_advisory_xact_lock(hashtext($1))", &[&lock])
            .map_err(|e| pg(&e))?;
        if let Some(limit) = limit {
            let already = tx
                .query(
                    "SELECT id FROM bank.cards WHERE id = $1::text::uuid",
                    &[&ask.card_id],
                )
                .map_err(|e| pg(&e))?;
            if already.is_empty() {
                assert_under_count(tx, &ask.user_id, &card_type, limit)?;
            }
        }
        tx.query(
            &format!(
                "INSERT INTO bank.cards (id, user_id, asset_id, settlement_asset_id, issuer, simulated, issuer_ref, pan_tail, \
                   cashback_bps, per_authorization_limit, card_type, shipping_address, activated_at, uses_allowed, design_id, \
                   delivery_speed, residence_country) \
                 VALUES ($1::text::uuid, $2, $3, $4, $5, $6, $7, $8, $9::int8::int4, $10::text::numeric, $11, $12::text::jsonb, \
                   CASE WHEN $13::int8 IS NULL THEN NULL ELSE to_timestamp($13::int8 / 1000.0) END, $14::int8::int4, $15, $16, $17) \
                 ON CONFLICT (issuer, issuer_ref) DO NOTHING RETURNING {CARD_COLS}"
            ),
            &[
                &ask.card_id,
                &ask.user_id,
                &ask.asset_id,
                &settlement,
                &programme.id,
                &programme.simulated,
                &handle.issuer_ref,
                &handle.pan_tail,
                &bps,
                &per,
                &card_type,
                &addr,
                &activated_at,
                &ask.uses_allowed,
                &ask.design_id,
                &ask.delivery_speed,
                &ask.residence_country,
            ],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(Card::from_row)
        .transpose()
    })?;
    let existing = match inserted {
        Some(c) => c,
        None => with(d.store(), |c| {
            by_issuer_ref(c, programme.id, &handle.issuer_ref)
        })?
        .ok_or_else(|| refuse("bank.card_not_found", "Card could not be issued"))?,
    };
    if existing.card_type != card_type {
        return Err(refuse(
            "bank.card_issue_conflict",
            "This card id was already issued as a different card type",
        ));
    }
    if card_type == "physical"
        && address_text(existing.shipping_address.as_ref()) != address_text(shipping.as_ref())
    {
        return Err(refuse(
            "bank.card_issue_conflict",
            "This card id was already issued to a different delivery address",
        ));
    }
    Ok(existing)
}

/// `setStatus`: freeze, unfreeze or close. The issuer is told first, and a refusal there changes nothing. `actor` is
/// who asked: the owner, or a holder of the shared pot the card is linked to (`holder`).
pub fn set_status(
    d: &Deps<'_>,
    card_id: &str,
    status: &str,
    actor: Option<&str>,
) -> Result<Card, Refusal> {
    let card = with(d.store(), |c| card(c, card_id))?;
    if card.status == "closed" && status != "closed" {
        return Err(refuse(
            "bank.card_not_active",
            "A closed card cannot be reopened",
        ));
    }
    let operator_frozen = card.frozen_by.as_deref() == Some("operator");
    if operator_frozen && status == "active" {
        return Err(refuse(
            "bank.card_operator_frozen",
            "An operator froze this card. The owner cannot lift that freeze (bank.card_operator_frozen)",
        ));
    }
    if operator_frozen && status == "frozen" {
        return Ok(card);
    }
    d.issuer().set_status()?;
    let actor = actor.unwrap_or(&card.user_id);
    let by_owner = actor == card.user_id;
    let frozen_by: Option<&str> =
        (status == "frozen").then_some(if by_owner { "owner" } else { "holder" });
    in_tx(d.store(), |tx| {
        let changed = update_status(
            tx,
            card_id,
            "status = $2::text::bank.card_status, frozen_by = $3",
            &[&status, &frozen_by],
            status,
        )?;
        if changed {
            note_status_event(
                tx,
                card_id,
                status,
                if by_owner { "owner" } else { "holder" },
            )?;
            note_card_status(
                tx,
                &StatusChange {
                    card_id,
                    owner_user_id: &card.user_id,
                    actor: Some(actor),
                    status,
                    replacement_card_id: None,
                },
            )?;
        }
        Ok(())
    })?;
    with(d.store(), |c| super::card(c, card_id))
}

/// `commandHash`: sha256 over `key=value` lines, the keys sorted.
fn command_hash(fields: &[(&str, String)]) -> String {
    let mut sorted: Vec<&(&str, String)> = fields.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    let canonical = sorted
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("\n");
    super::issuer::sha256_hex(&canonical)
}

/// `claimCommand`: `true` for a new command, `false` for a replay of the same one; another change refuses.
fn claim_command(
    tx: &mut postgres::Transaction<'_>,
    card_id: &str,
    command_id: &str,
    kind: &str,
    hash: &str,
) -> Result<bool, Refusal> {
    let inserted = tx
        .query(
            "INSERT INTO bank.card_commands (id, card_id, kind, payload_hash) VALUES ($1::text::uuid, $2::text::uuid, $3, $4) \
             ON CONFLICT (id) DO NOTHING RETURNING id",
            &[&command_id, &card_id, &kind, &hash],
        )
        .map_err(|e| pg(&e))?;
    if !inserted.is_empty() {
        return Ok(true);
    }
    let rows = tx
        .query(
            "SELECT card_id::text, kind, payload_hash FROM bank.card_commands WHERE id = $1::text::uuid",
            &[&command_id],
        )
        .map_err(|e| pg(&e))?;
    let same = rows.first().is_some_and(|r| {
        r.get::<_, String>(0) == card_id
            && r.get::<_, String>(1) == kind
            && r.get::<_, String>(2) == hash
    });
    if !same {
        return Err(refuse(
            "bank.card_command_conflict",
            "This command id was already used for a different card change",
        ));
    }
    Ok(false)
}

fn limit_exceeded(message: &str) -> Refusal {
    refuse("bank.card_limit_exceeded", message)
}

/// `limitToken`.
fn limit_token(v: Option<Option<Amount>>) -> String {
    match v {
        None => String::new(),
        Some(None) => "null".to_owned(),
        Some(Some(a)) => format_amount(a),
    }
}

/// What `setLimits` is asked for: each ceiling absent (`None`, kept), removed (`Some(None)`) or set.
pub struct Limits {
    pub per: Amount,
    pub daily: Option<Option<Amount>>,
    pub monthly: Option<Option<Amount>>,
    pub cash: Option<Option<Amount>>,
}

/// `setLimits`: `commandId` retries the same change.
pub fn set_limits(
    d: &Deps<'_>,
    card_id: &str,
    user_id: &str,
    command_id: &str,
    l: &Limits,
) -> Result<Card, Refusal> {
    d.assert_module_enabled()?;
    if l.per <= Amount::ZERO {
        return Err(limit_exceeded(
            "A card needs a positive per-authorisation limit",
        ));
    }
    for v in [l.daily, l.monthly, l.cash] {
        if matches!(v, Some(Some(a)) if a <= Amount::ZERO) {
            return Err(limit_exceeded("A card limit must be a positive amount"));
        }
    }
    let card = with(d.store(), |c| owned_card(c, card_id, user_id))?;
    let hash = command_hash(&[
        ("perAuthorizationLimit", format_amount(l.per)),
        ("dailyLimit", limit_token(l.daily)),
        ("monthlyLimit", limit_token(l.monthly)),
        ("cashLimit", limit_token(l.cash)),
    ]);
    in_tx(d.store(), |tx| {
        if !claim_command(tx, &card.id, command_id, "set_limits", &hash)? {
            return Ok(());
        }
        let keep =
            |v: Option<Option<Amount>>, cur: Option<Amount>| v.unwrap_or(cur).map(format_amount);
        tx.execute(
            "UPDATE bank.cards SET per_authorization_limit = $2::text::numeric, daily_limit = $3::text::numeric, \
               monthly_limit = $4::text::numeric, cash_limit = $5::text::numeric, updated_at = now() WHERE id = $1::text::uuid",
            &[
                &card.id,
                &format_amount(l.per),
                &keep(l.daily, card.daily_limit),
                &keep(l.monthly, card.monthly_limit),
                &keep(l.cash, card.cash_limit),
            ],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })?;
    with(d.store(), |c| super::card(c, &card.id))
}

/// `setChannels`: the four switches; `commandId` retries the same four.
pub fn set_channels(
    d: &Deps<'_>,
    card_id: &str,
    user_id: &str,
    command_id: &str,
    flags: [bool; 4],
) -> Result<Card, Refusal> {
    d.assert_module_enabled()?;
    let card = with(d.store(), |c| owned_card(c, card_id, user_id))?;
    let bit = |b: bool| if b { "1" } else { "0" }.to_owned();
    let [online, contactless, atm, abroad] = flags;
    let hash = command_hash(&[
        ("online", bit(online)),
        ("contactless", bit(contactless)),
        ("atm", bit(atm)),
        ("abroad", bit(abroad)),
    ]);
    in_tx(d.store(), |tx| {
        if !claim_command(tx, &card.id, command_id, "set_channels", &hash)? {
            return Ok(());
        }
        tx.execute(
            "UPDATE bank.cards SET channel_online = $2, channel_contactless = $3, channel_atm = $4, channel_abroad = $5, \
               updated_at = now() WHERE id = $1::text::uuid",
            &[&card.id, &online, &contactless, &atm, &abroad],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })?;
    with(d.store(), |c| super::card(c, &card.id))
}

fn control_invalid(message: String) -> Refusal {
    refuse("bank.card_control_invalid", message)
}

/// `controlValue`: a category from the list, a country's two letters (upper-cased), or a merchant's name (lower-cased).
pub fn control_value(kind: &str, raw: &str) -> Result<String, Refusal> {
    let value = service_kit::money::js_trim(raw);
    match kind {
        "category" => {
            if !CATEGORIES.contains(&value) {
                return Err(control_invalid(format!(
                    "Unknown card category {value} (bank.card_control_invalid)"
                )));
            }
            Ok(value.to_owned())
        }
        "country" => {
            let country = value.to_uppercase();
            if country.len() != 2 || !country.bytes().all(|b| b.is_ascii_uppercase()) {
                return Err(control_invalid(
                    "A blocked country is its two-letter code (bank.card_control_invalid)"
                        .to_owned(),
                ));
            }
            Ok(country)
        }
        _ => {
            // `value.length` counts UTF-16 units.
            let units = value.encode_utf16().count();
            if value.is_empty() || units > 64 || value.chars().any(|c| (c as u32) < 0x20) {
                return Err(control_invalid(
                    "A blocked merchant is a name of 1 to 64 characters (bank.card_control_invalid)".to_owned(),
                ));
            }
            Ok(value.to_lowercase())
        }
    }
}

fn control_json(r: &postgres::Row) -> Json {
    Json::obj([
        ("id", Json::str(r.get::<_, String>(0))),
        ("kind", Json::str(r.get::<_, String>(1))),
        ("value", Json::str(r.get::<_, String>(2))),
        ("createdAt", iso(Some(service_kit::time::Instant(r.get(3))))),
    ])
}

/// `cards.controls.*`' answer: the categories, the live controls and the lock history (newest 50).
pub fn controls(c: &mut impl GenericClient, card_id: &str) -> Result<Json, Refusal> {
    let live = c
        .query(
            &format!(
                "SELECT id::text, kind, value, {} FROM bank.card_controls WHERE card_id = $1::text::uuid AND lifted_at IS NULL \
                 ORDER BY created_at, id",
                ms("created_at")
            ),
            &[&card_id],
        )
        .map_err(|e| pg(&e))?;
    let history = c
        .query(
            &format!(
                "SELECT id::text, status, actor, {} FROM bank.card_status_events WHERE card_id = $1::text::uuid \
                 ORDER BY at DESC, id DESC LIMIT 50",
                ms("at")
            ),
            &[&card_id],
        )
        .map_err(|e| pg(&e))?;
    Ok(Json::obj([
        (
            "categories",
            Json::Array(CATEGORIES.iter().map(|c| Json::str(*c)).collect()),
        ),
        (
            "controls",
            Json::Array(live.iter().map(control_json).collect()),
        ),
        (
            "history",
            Json::Array(
                history
                    .iter()
                    .map(|r| {
                        Json::obj([
                            ("id", Json::str(r.get::<_, String>(0))),
                            ("status", Json::str(r.get::<_, String>(1))),
                            ("actor", Json::str(r.get::<_, String>(2))),
                            ("at", iso(Some(service_kit::time::Instant(r.get(3))))),
                        ])
                    })
                    .collect(),
            ),
        ),
    ]))
}

/// `blockControl`: blocking what is already blocked answers the live control.
pub fn block_control(d: &Deps<'_>, card_id: &str, kind: &str, raw: &str) -> Result<(), Refusal> {
    with(d.store(), |c| {
        let card = card(c, card_id)?;
        if card.status == "closed" {
            return Err(refuse(
                "bank.card_not_active",
                "A closed card takes no controls (bank.card_not_active)",
            ));
        }
        let value = control_value(kind, raw)?;
        loop {
            let inserted = c
                .query(
                    "INSERT INTO bank.card_controls (card_id, kind, value) VALUES ($1::text::uuid, $2, $3) \
                     ON CONFLICT (card_id, kind, value) WHERE lifted_at IS NULL DO NOTHING RETURNING id",
                    &[&card_id, &kind, &value],
                )
                .map_err(|e| pg(&e))?;
            if !inserted.is_empty() {
                return Ok(());
            }
            let live = c
                .query(
                    "SELECT id FROM bank.card_controls WHERE card_id = $1::text::uuid AND kind = $2 AND value = $3 \
                     AND lifted_at IS NULL",
                    &[&card_id, &kind, &value],
                )
                .map_err(|e| pg(&e))?;
            // Lifted between the two statements: the block is the person's newer word, so it is made again.
            if !live.is_empty() {
                return Ok(());
            }
        }
    })
}

/// `liftControl`: lifting again answers the same; one not on this card is not found.
pub fn lift_control(d: &Deps<'_>, card_id: &str, control_id: &str) -> Result<(), Refusal> {
    with(d.store(), |c| {
        let rows = c
            .query(
                "UPDATE bank.card_controls SET lifted_at = COALESCE(lifted_at, now()) \
                  WHERE card_id = $1::text::uuid AND id = $2::text::uuid RETURNING id",
                &[&card_id, &control_id],
            )
            .map_err(|e| pg(&e))?;
        if rows.is_empty() {
            return Err(refuse(
                "bank.card_control_not_found",
                "That is not a control of this card (bank.card_control_not_found)",
            ));
        }
        Ok(())
    })
}

fn replace_conflict(message: &str) -> Refusal {
    refuse("bank.card_replace_conflict", message)
}

/// `reverseOpenHolds`: every hold still open on a lost or stolen card goes back through slice `card-ops`' `reverse`
/// (`moves::settle::reverse_open_holds`).
fn reverse_open_holds(d: &Deps<'_>, card: &Card) -> Result<(), Refusal> {
    super::moves::settle::reverse_open_holds(&super::moves::Moves::bare(d), card)
}

fn close_replaced(
    d: &Deps<'_>,
    card: &Card,
    replacement_id: &str,
    reason: &str,
) -> Result<(), Refusal> {
    let current = with(d.store(), |c| super::card(c, &card.id))?;
    if current.replaced_by_card_id.as_deref() == Some(replacement_id)
        && current.status == "closed"
        && current.replace_reason.as_deref() == Some(reason)
    {
        return Ok(());
    }
    if current
        .replace_reason
        .as_deref()
        .is_some_and(|r| r != reason)
    {
        return Err(replace_conflict(
            "This card was already replaced on different terms",
        ));
    }
    if reason == "lost" || reason == "stolen" {
        if current.status == "active" {
            set_status(d, &current.id, "frozen", Some(&current.user_id))?;
        }
        reverse_open_holds(d, &current)?;
    }
    d.issuer().set_status()?;
    in_tx(d.store(), |tx| {
        let changed = update_status(
            tx,
            &current.id,
            "status = 'closed', replaced_by_card_id = $2::text::uuid, replace_reason = $3, frozen_by = NULL",
            &[&replacement_id, &reason],
            "closed",
        )?;
        if changed {
            note_status_event(tx, &current.id, "closed", "owner")?;
            note_card_status(
                tx,
                &StatusChange {
                    card_id: &current.id,
                    owner_user_id: &current.user_id,
                    actor: Some(&current.user_id),
                    status: "closed",
                    replacement_card_id: Some(replacement_id),
                },
            )?;
        }
        Ok(())
    })
}

/// `replace`: close this card and issue another with the same asset, ceilings and channels; `replacementId` is the key.
pub fn replace(
    d: &Deps<'_>,
    card_id: &str,
    user_id: &str,
    replacement_id: &str,
    reason: &str,
) -> Result<Card, Refusal> {
    d.assert_module_enabled()?;
    d.assert_issuer_may_mutate()?;
    let card = with(d.store(), |c| owned_card(c, card_id, user_id))?;
    if let Some(by) = &card.replaced_by_card_id {
        if by != replacement_id || card.replace_reason.as_deref() != Some(reason) {
            return Err(replace_conflict(
                "This card was already replaced on different terms",
            ));
        }
        return with(d.store(), |c| owned_card(c, by, user_id));
    }
    if card.status == "closed" {
        return Err(refuse(
            "bank.card_not_active",
            "A closed card cannot be replaced",
        ));
    }
    if let Some(existing) = with(d.store(), |c| card_or_none(c, replacement_id))? {
        if existing.replaces_card_id.as_deref() != Some(card.id.as_str())
            || existing.user_id != user_id
        {
            return Err(replace_conflict(
                "This replacement id already belongs to another card",
            ));
        }
        close_replaced(d, &card, &existing.id, reason)?;
        return with(d.store(), |c| super::card(c, &existing.id));
    }
    let handle = d.issuer().issue(replacement_id)?;
    let programme = d.issuer().programme();
    let amt = |a: Option<Amount>| a.map(format_amount);
    let activated_at: Option<i64> = (card.card_type != "physical").then_some(d.now().0);
    with(d.store(), |c| {
        c.execute(
            "INSERT INTO bank.cards (id, user_id, asset_id, settlement_asset_id, issuer, simulated, issuer_ref, pan_tail, \
               cashback_bps, per_authorization_limit, daily_limit, monthly_limit, cash_limit, channel_online, \
               channel_contactless, channel_atm, channel_abroad, card_type, shipping_address, replaces_card_id, activated_at, \
               uses_allowed, design_id, delivery_speed, residence_country) \
             VALUES ($1::text::uuid, $2, $3, $4, $5, $6, $7, $8, $9::int8::int4, $10::text::numeric, $11::text::numeric, \
               $12::text::numeric, $13::text::numeric, $14, $15, $16, $17, $18, $19::text::jsonb, $20::text::uuid, \
               CASE WHEN $21::int8 IS NULL THEN NULL ELSE to_timestamp($21::int8 / 1000.0) END, $22::int8::int4, $23, $24, $25) \
             ON CONFLICT DO NOTHING",
            &[
                &replacement_id,
                &card.user_id,
                &card.asset_id,
                &card.settlement_asset_id,
                &programme.id,
                &programme.simulated,
                &handle.issuer_ref,
                &handle.pan_tail,
                &card.cashback_bps,
                &format_amount(card.per_authorization_limit),
                &amt(card.daily_limit),
                &amt(card.monthly_limit),
                &amt(card.cash_limit),
                &card.online,
                &card.contactless,
                &card.atm,
                &card.abroad,
                &card.card_type,
                &address_text(card.shipping_address.as_ref()),
                &card.id,
                &activated_at,
                &card.uses_allowed,
                &card.design_id,
                &card.delivery_speed,
                &card.residence_country,
            ],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })?;
    let created = with(d.store(), |c| super::card(c, replacement_id))?;
    if created.replaces_card_id.as_deref() != Some(card.id.as_str()) {
        return Err(replace_conflict(
            "This replacement id already belongs to another card",
        ));
    }
    close_replaced(d, &card, &created.id, reason)?;
    with(d.store(), |c| super::card(c, &created.id))
}

/// `activate`: once is enough.
pub fn activate(d: &Deps<'_>, card_id: &str, user_id: &str) -> Result<Card, Refusal> {
    d.assert_module_enabled()?;
    d.assert_issuer_may_mutate()?;
    let card = with(d.store(), |c| owned_card(c, card_id, user_id))?;
    if !card.inactive() {
        return Ok(card);
    }
    if card.status != "active" {
        return Err(refuse(
            "bank.card_not_active",
            if card.status == "closed" {
                "A closed card cannot be activated"
            } else {
                "Unfreeze this card before activating it"
            },
        ));
    }
    let now = d.now().0;
    with(d.store(), |c| {
        c.execute(
            "UPDATE bank.cards SET activated_at = to_timestamp($2::int8 / 1000.0), updated_at = now() \
              WHERE id = $1::text::uuid AND activated_at IS NULL",
            &[&card.id, &now],
        )
        .map_err(|e| pg(&e))?;
        super::card(c, &card.id)
    })
}

/// `usesMade`: captured payments on this card so far.
pub fn uses_made(c: &mut impl GenericClient, card_id: &str) -> Result<i64, Refusal> {
    Ok(c
        .query_one(
            "SELECT count(*)::int8 FROM bank.card_settlements s JOIN bank.card_authorizations a ON a.id = s.authorization_id \
              WHERE a.card_id = $1::text::uuid AND s.sequence = 0 AND s.kind = 'capture' AND s.status = 'settled'",
            &[&card_id],
        )
        .map_err(|e| pg(&e))?
        .get(0))
}

/// `sharedPots.freezeCard`' second half: the holder's freeze, recorded as `holder`, the pot's log written with the row.
pub fn freeze_for_holder(d: &Deps<'_>, card_id: &str, user_id: &str) -> Result<Json, Refusal> {
    let frozen = set_status(d, card_id, "frozen", Some(user_id))?;
    Ok(Json::obj([
        ("cardId", Json::str(frozen.id.clone())),
        ("panTail", Json::str(frozen.pan_tail.clone())),
        ("status", Json::str(frozen.status.clone())),
        (
            "frozenBy",
            frozen.frozen_by.clone().map_or(Json::Null, Json::str),
        ),
    ]))
}

fn principal<'a>(ctx: &'a Ctx<'_>) -> Result<&'a Principal, Refusal> {
    ctx.principal.ok_or_else(|| {
        Refusal::Other("a scoped call reached the slice with no principal".to_owned())
    })
}

fn controls_answer(d: &Deps<'_>, card_id: &str) -> Result<Json, Refusal> {
    with(d.store(), |c| controls(c, card_id))
}

/// This part's calls.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let input = &ctx.input;
    let user = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    let card_id = text(input, "cardId");
    Some(match ctx.call.path {
        "cards.programme" => Ok(programme_json(d)),
        "cards.list" => cards_list_limit(input.get("limit").as_number()).and_then(|page| {
            with(d.store(), |c| {
                Ok(Json::Array(
                    cards_page(c, user, page)?.iter().map(Card::view).collect(),
                ))
            })
        }),
        "cards.issue" => (|| {
            let p = principal(ctx)?;
            let card_type = opt_text(input, "cardType");
            let per_text = text(input, "perAuthorizationLimit");
            if gate::enforced(d) {
                let shipping = if card_type == Some("physical") {
                    gate::shipping_token(input.get("shippingAddress"))
                } else {
                    String::new()
                };
                gate::require(
                    d,
                    p,
                    &gate::issue(&gate::Issue {
                        actor: user,
                        card_id,
                        asset_id: text(input, "assetId"),
                        settlement_asset_id: opt_text(input, "settlementAssetId"),
                        cashback_bps: int_of(input, "cashbackBps"),
                        per_authorization_limit: per_text,
                        card_type: card_type.unwrap_or("virtual"),
                        shipping_address: &shipping,
                    }),
                    opt_text(input, "stepUpApprovalId"),
                    true,
                )?;
            }
            let card = issue(
                d,
                &IssueAsk {
                    card_id: card_id.to_owned(),
                    user_id: user.to_owned(),
                    asset_id: text(input, "assetId").to_owned(),
                    settlement_asset_id: opt_text(input, "settlementAssetId").map(str::to_owned),
                    cashback_bps: int_of(input, "cashbackBps"),
                    per_authorization_limit: amount_of(per_text)?,
                    card_type: card_type.map(str::to_owned),
                    shipping_address: address_of(input.get("shippingAddress")),
                    ..IssueAsk::default()
                },
            )?;
            Ok(card.view())
        })(),
        "cards.setStatus" => (|| {
            let card = own(d, user, card_id)?;
            let status = text(input, "status");
            if gate::enforced(d) && status == "active" && card.status != "active" {
                gate::require(
                    d,
                    principal(ctx)?,
                    &gate::unfreeze(user, card_id, &card.status),
                    opt_text(input, "stepUpApprovalId"),
                    false,
                )?;
            }
            let updated = set_status(d, card_id, status, Some(user))?;
            Ok(Json::obj([
                ("id", Json::str(updated.id)),
                ("status", Json::str(updated.status)),
            ]))
        })(),
        "cards.setLimits" => (|| {
            let card = own(d, user, card_id)?;
            let per_text = text(input, "perAuthorizationLimit");
            let per = amount_of(per_text)?;
            let ceiling = |k: &str| -> Result<Option<Option<Amount>>, Refusal> {
                tri(input, k)
                    .map(|v| v.map(amount_of).transpose())
                    .transpose()
            };
            let (daily, monthly, cash) = (
                ceiling("dailyLimit")?,
                ceiling("monthlyLimit")?,
                ceiling("cashLimit")?,
            );
            let loosens = |cur: Option<Amount>, next: Option<Option<Amount>>| match (cur, next) {
                (_, None) => false,
                (cur, Some(None)) => cur.is_some(),
                (None, Some(Some(_))) => false,
                (Some(c), Some(Some(n))) => n > c,
            };
            let loosened = per > card.per_authorization_limit
                || loosens(card.daily_limit, daily)
                || loosens(card.monthly_limit, monthly)
                || loosens(card.cash_limit, cash);
            if gate::enforced(d) && loosened {
                let field = |k: &str| match tri(input, k) {
                    None => String::new(),
                    Some(None) => "null".to_owned(),
                    Some(Some(v)) => v.to_owned(),
                };
                gate::require(
                    d,
                    principal(ctx)?,
                    &gate::set_limits(
                        user,
                        card_id,
                        text(input, "commandId"),
                        per_text,
                        &field("dailyLimit"),
                        &field("monthlyLimit"),
                        &field("cashLimit"),
                    ),
                    opt_text(input, "stepUpApprovalId"),
                    true,
                )?;
            }
            let updated = set_limits(
                d,
                card_id,
                user,
                text(input, "commandId"),
                &Limits {
                    per,
                    daily,
                    monthly,
                    cash,
                },
            )?;
            Ok(updated.view())
        })(),
        "cards.setChannels" => (|| {
            own(d, user, card_id)?;
            let updated = set_channels(
                d,
                card_id,
                user,
                text(input, "commandId"),
                [
                    bool_of(input, "online"),
                    bool_of(input, "contactless"),
                    bool_of(input, "atm"),
                    bool_of(input, "abroad"),
                ],
            )?;
            Ok(updated.view())
        })(),
        "cards.controls.get" => own(d, user, card_id).and_then(|c| controls_answer(d, &c.id)),
        "cards.controls.block" => own(d, user, card_id).and_then(|c| {
            block_control(d, &c.id, text(input, "kind"), text(input, "value"))?;
            controls_answer(d, &c.id)
        }),
        "cards.controls.lift" => own(d, user, card_id).and_then(|c| {
            lift_control(d, &c.id, text(input, "controlId"))?;
            controls_answer(d, &c.id)
        }),
        "cards.replace" => (|| {
            own(d, user, card_id)?;
            let replaced = replace(
                d,
                card_id,
                user,
                text(input, "replacementId"),
                text(input, "reason"),
            )?;
            super::orders::after_replace(d, &replaced)?;
            Ok(replaced.view())
        })(),
        "cards.activate" => (|| {
            let card = own(d, user, card_id)?;
            if !card.inactive() {
                return Ok(card.view());
            }
            if !gate::enforced(d) {
                return Err(refuse(
                    "bank.step_up_unavailable",
                    "Activating a card needs a fresh confirmation that it is you, and step-up is not switched on in this deployment.",
                ));
            }
            gate::require(
                d,
                principal(ctx)?,
                &gate::activate(user, card_id),
                opt_text(input, "stepUpApprovalId"),
                false,
            )?;
            Ok(activate(d, card_id, user)?.view())
        })(),
        "cards.uses" => own(d, user, card_id).and_then(|card| {
            let made = with(d.store(), |c| uses_made(c, &card.id))?;
            Ok(Json::obj([
                ("cardId", Json::str(card.id.clone())),
                (
                    "usesAllowed",
                    card.uses_allowed.map_or(Json::Null, Json::int),
                ),
                ("usesMade", Json::int(made)),
            ]))
        }),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn a_command_hash_is_sha256_over_sorted_key_value_lines() {
        let want = super::super::issuer::sha256_hex("a=1\nb=2");
        assert_eq!(
            command_hash(&[("b", "2".to_owned()), ("a", "1".to_owned())]),
            want
        );
        assert_eq!(want.len(), 64);
        // A real sha256, not a stand-in.
        use sha2::{Digest, Sha256};
        assert_eq!(format!("{:x}", Sha256::digest(b"a=1\nb=2")), want);
    }

    #[test]
    fn a_control_value_is_a_known_category_a_country_code_or_a_short_merchant_name() {
        assert_eq!(control_value("category", " fuel ").unwrap(), "fuel");
        assert!(control_value("category", "cars").is_err());
        assert_eq!(control_value("country", "gb").unwrap(), "GB");
        assert!(control_value("country", "GBR").is_err());
        assert_eq!(control_value("merchant", " ACME Ltd ").unwrap(), "acme ltd");
        assert!(control_value("merchant", "a\u{1}b").is_err());
        assert!(control_value("merchant", &"x".repeat(65)).is_err());
    }
}
