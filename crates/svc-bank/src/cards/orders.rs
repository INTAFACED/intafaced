//! Getting a card (`card-orders.ts`, `card-programme.ts`'s `requireProgramme` and `termsTextHash`; the router's
//! `catalogue`, `acceptTerms`, `order`, `delivery`, `updateShipping`), the stand-in printer's job
//! (`/internal/jobs/card-sim/shipment`, `recordShipment`) and a replacement's delivery (`afterReplace`).
//!
//! No value moves here. An order is `core::issue` with the owner's eligibility, count limit and terms checked first, and
//! a physical card's delivery is a record of what a printer and courier said. Neither is connected (`hardware`): only
//! the test stack's stand-in printer, through its signed job door, moves a delivery past `ordered`.

use postgres::GenericClient;
use service_kit::json::{self, Json};
use service_kit::money::{Amount, js_trim};
use service_kit::schema::Value;
use service_kit::time::Instant;

use super::core::{
    IssueAsk, address_of, amount_of, held_count, int_of, opt_text, programme_json, text,
};
use super::step_up as gate;
use super::terms::ProgrammeTerms;
use super::{Address, Card, Deps, card, ms};
use crate::door::Ctx;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{in_tx, pg, with};

/// `SHIPMENT_ORDER`.
pub const SHIPMENT_ORDER: [&str; 4] = ["ordered", "produced", "shipped", "delivered"];
/// `PRINTER_CONNECTED`: no printer or courier adapter exists in this build (`hardware`).
const PRINTER_CONNECTED: bool = false;
const DAY_MS: i64 = 86_400_000;

/// `requireProgramme`: the owner's published programme, or `bank.card_eligibility_unset`.
pub fn require_programme<'a>(d: &'a Deps<'_>) -> Result<&'a ProgrammeTerms, Refusal> {
    d.settings().programme.as_ref().ok_or_else(|| {
        refuse(
            "bank.card_eligibility_unset",
            "The card programme is not published: which countries may get a card, the card limits and the cardholder terms are the owner\u{2019}s to set.",
        )
    })
}

/// `termsTextHash`: sha256 of the exact terms text, prefixed with its algorithm.
pub fn terms_text_hash(text: &str) -> String {
    format!("sha256:{}", super::issuer::sha256_hex(text))
}

/// `country.trim().toUpperCase()`.
fn upper(country: &str) -> String {
    js_trim(country).to_uppercase()
}

fn terms_changed(message: &str) -> Refusal {
    refuse("bank.card_terms_changed", message)
}

fn not_physical(message: &str) -> Refusal {
    refuse("bank.card_not_physical", message)
}

fn not_delivered_to(to: &str) -> Refusal {
    refuse(
        "bank.card_delivery_country",
        format!("A physical card is not delivered to {to}"),
    )
}

/// `acceptanceOf`: the person's acceptance of this version, as the router shows it.
fn acceptance_of(
    c: &mut impl GenericClient,
    user_id: &str,
    version: &str,
) -> Result<Option<Json>, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT id::text, terms_version, {} FROM bank.card_terms_acceptances \
                  WHERE user_id = $1 AND terms_version = $2",
                ms("accepted_at")
            ),
            &[&user_id, &version],
        )
        .map_err(|e| pg(&e))?;
    Ok(rows.first().map(|r| {
        Json::obj([
            ("id", Json::str(r.get::<_, String>(0))),
            ("version", Json::str(r.get::<_, String>(1))),
            ("acceptedAt", Json::str(Instant(r.get(2)).iso())),
        ])
    }))
}

/// `catalogue`: the product list for a country (BK-cissue-01).
pub fn catalogue(d: &Deps<'_>, user_id: &str, country_code: &str) -> Result<Json, Refusal> {
    let terms = require_programme(d)?;
    let country = upper(country_code);
    let eligible = terms.countries.contains(&country);
    let (virtual_held, physical_held, acceptance) = with(d.store(), |c| {
        Ok((
            held_count(c, user_id, "virtual")?,
            held_count(c, user_id, "physical")?,
            acceptance_of(c, user_id, &terms.terms_version)?,
        ))
    })?;
    let strs = |v: &[String]| Json::Array(v.iter().map(|s| Json::str(s.clone())).collect());
    let product = |kind: &str, held: i64, limit: i64| {
        Json::obj([
            ("type", Json::str(kind)),
            ("held", Json::int(held)),
            ("limit", Json::int(limit)),
        ])
    };
    Ok(Json::obj([
        ("programme", programme_json(d)),
        ("network", Json::str(terms.network.clone())),
        ("country", Json::str(country)),
        ("eligible", Json::Bool(eligible)),
        (
            "reason",
            if eligible {
                Json::Null
            } else {
                Json::str("bank.card_not_eligible")
            },
        ),
        ("countries", strs(&terms.countries)),
        (
            "products",
            Json::Array(vec![
                product("virtual", virtual_held, terms.limit_virtual),
                product("physical", physical_held, terms.limit_physical),
            ]),
        ),
        (
            "terms",
            Json::obj([
                ("version", Json::str(terms.terms_version.clone())),
                ("text", Json::str(terms.terms_text.clone())),
                ("textHash", Json::str(terms_text_hash(&terms.terms_text))),
                ("acceptance", acceptance.unwrap_or(Json::Null)),
            ]),
        ),
        (
            "designs",
            Json::Array(
                terms
                    .designs
                    .iter()
                    .map(|g| {
                        Json::obj([
                            ("id", Json::str(g.id.clone())),
                            ("name", Json::str(g.name.clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "speeds",
            Json::Array(
                terms
                    .speeds
                    .iter()
                    .map(|(speed, days)| {
                        Json::obj([
                            ("speed", Json::str(speed.clone())),
                            ("days", Json::int(*days)),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("deliveryCountries", strs(&terms.delivery_countries)),
    ]))
}

/// `acceptTerms` (`consent:<userId>:<termsVersion>`): the version and the text's hash must be the ones published now;
/// accepting again returns the first acceptance and writes nothing.
pub fn accept_terms(
    d: &Deps<'_>,
    user_id: &str,
    terms_version: &str,
    text_hash: &str,
) -> Result<Json, Refusal> {
    let terms = require_programme(d)?;
    if terms_version != terms.terms_version || text_hash != terms_text_hash(&terms.terms_text) {
        return Err(terms_changed(
            "These are not the cardholder terms published now; read them again before accepting",
        ));
    }
    with(d.store(), |c| {
        c.execute(
            "INSERT INTO bank.card_terms_acceptances (user_id, terms_version, text_hash) VALUES ($1, $2, $3) \
             ON CONFLICT (user_id, terms_version) DO NOTHING",
            &[&user_id, &terms.terms_version, &text_hash],
        )
        .map_err(|e| pg(&e))?;
        acceptance_of(c, user_id, &terms.terms_version)?.ok_or_else(|| {
            Refusal::Other("the terms acceptance just written is not there".to_owned())
        })
    })
}

/// What `order` is asked for (`CardOrderService.order`'s input): an absent design, speed or address is `None`.
#[derive(Debug, Clone)]
pub struct OrderAsk {
    pub card_id: String,
    pub user_id: String,
    pub country: String,
    pub terms_version: String,
    pub asset_id: String,
    pub per_authorization_limit: Amount,
    /// `virtual` or `physical`.
    pub card_type: String,
    pub uses_allowed: Option<i64>,
    pub design_id: Option<String>,
    pub delivery_speed: Option<String>,
    pub shipping_address: Option<Address>,
}

/// `order` (BK-cissue-02, -03): eligibility, the terms, then a physical card's design, speed and delivery country, then
/// `core::issue`, which checks the count limit under the person's lock. `cardId` is the request: a retry is the same
/// card and the same delivery.
pub fn order(d: &Deps<'_>, ask: &OrderAsk) -> Result<Card, Refusal> {
    let terms = require_programme(d)?;
    let country = upper(&ask.country);
    if !terms.countries.contains(&country) {
        return Err(refuse(
            "bank.card_not_eligible",
            format!("Cards are not offered to residents of {country}"),
        ));
    }
    if ask.terms_version != terms.terms_version {
        return Err(terms_changed(
            "These are not the cardholder terms published now; read them again",
        ));
    }
    if with(d.store(), |c| {
        acceptance_of(c, &ask.user_id, &terms.terms_version)
    })?
    .is_none()
    {
        return Err(refuse(
            "bank.card_terms_not_accepted",
            "Accept the cardholder terms before ordering a card",
        ));
    }
    let physical = ask.card_type == "physical";
    let mut speed: Option<String> = None;
    if physical {
        let design_ok = ask
            .design_id
            .as_deref()
            .is_some_and(|id| !id.is_empty() && terms.designs.iter().any(|g| g.id == id));
        if !design_ok {
            return Err(refuse(
                "bank.card_design_unknown",
                "Choose one of the programme\u{2019}s card designs",
            ));
        }
        speed = terms
            .speeds
            .iter()
            .find(|(s, _)| Some(s.as_str()) == ask.delivery_speed.as_deref())
            .map(|(s, _)| s.clone());
        if speed.is_none() {
            return Err(refuse(
                "bank.card_delivery_speed_unknown",
                "Choose one of the programme\u{2019}s delivery speeds",
            ));
        }
        if let Some(a) = &ask.shipping_address {
            let to = upper(&a.country);
            if !to.is_empty() && !terms.delivery_countries.contains(&to) {
                return Err(not_delivered_to(&to));
            }
        }
    } else if ask.design_id.is_some()
        || ask.delivery_speed.is_some()
        || ask.shipping_address.is_some()
    {
        return Err(not_physical(
            "A virtual card has no design, delivery speed or address",
        ));
    }
    let card = super::core::issue(
        d,
        &IssueAsk {
            card_id: ask.card_id.clone(),
            user_id: ask.user_id.clone(),
            asset_id: ask.asset_id.clone(),
            per_authorization_limit: ask.per_authorization_limit,
            card_type: Some(ask.card_type.clone()),
            shipping_address: ask.shipping_address.clone(),
            // A virtual card works at once; a physical card is activated when it arrives (BK-cissue-04).
            activated: Some(!physical),
            uses_allowed: if physical { None } else { ask.uses_allowed },
            design_id: ask.design_id.clone(),
            delivery_speed: speed,
            residence_country: Some(country),
            ..IssueAsk::default()
        },
    )?;
    if card.user_id != ask.user_id {
        return Err(refuse(
            "bank.card_issue_conflict",
            "This card id already belongs to another card",
        ));
    }
    if card.card_type == "physical" {
        ensure_shipment(d, &card)?;
    }
    Ok(card)
}

/// `ensureShipment`: the delivery row of a physical card ordered with a speed, written once from the card. A speed the
/// programme no longer offers writes nothing.
fn ensure_shipment(d: &Deps<'_>, card: &Card) -> Result<(), Refusal> {
    if card.card_type != "physical" {
        return Ok(());
    }
    let (Some(address), Some(speed)) = (&card.shipping_address, &card.delivery_speed) else {
        return Ok(());
    };
    let days = d
        .settings()
        .programme
        .as_ref()
        .and_then(|t| t.speeds.iter().find(|(s, _)| s == speed).map(|(_, n)| *n));
    let Some(days) = days.filter(|n| *n != 0) else {
        return Ok(());
    };
    let address = address.json().compact();
    with(d.store(), |c| {
        c.execute(
            "INSERT INTO bank.card_shipments (card_id, user_id, speed, estimate_days, address) \
             VALUES ($1::text::uuid, $2, $3, $4::int8::int4, $5::text::jsonb) ON CONFLICT (card_id) DO NOTHING",
            &[&card.id, &card.user_id, speed, &days, &address],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })
}

/// `ownedPhysical`: this person's physical card; another's is not found.
fn owned_physical(d: &Deps<'_>, user_id: &str, card_id: &str) -> Result<Card, Refusal> {
    let card = with(d.store(), |c| card(c, card_id))?;
    if card.user_id != user_id {
        return Err(super::card_not_found(card_id));
    }
    if card.card_type != "physical" {
        return Err(not_physical("A virtual card has no delivery"));
    }
    Ok(card)
}

fn stored_address(text: Option<String>) -> Option<Address> {
    text.and_then(|t| json::parse(&t).ok())
        .and_then(|j| Address::from_json(&j))
}

fn address_missing() -> Refusal {
    Refusal::Other("Cannot read properties of null (reading 'name')".to_owned())
}

/// `readDelivery`: the delivery as `presentDelivery` shows it (and as the job door sends it).
fn read_delivery(d: &Deps<'_>, card: &Card) -> Result<Json, Refusal> {
    let (row, history) = with(d.store(), |c| {
        let row = c
            .query(
                &format!(
                    "SELECT state, speed, estimate_days::int8, {}, carrier, tracking_ref, address::text \
                       FROM bank.card_shipments WHERE card_id = $1::text::uuid",
                    ms("ordered_at")
                ),
                &[&card.id],
            )
            .map_err(|e| pg(&e))?;
        let history = c
            .query(
                &format!(
                    "SELECT previous_address::text, {} FROM bank.card_address_changes \
                      WHERE card_id = $1::text::uuid ORDER BY changed_at, id",
                    ms("changed_at")
                ),
                &[&card.id],
            )
            .map_err(|e| pg(&e))?;
        Ok((row.into_iter().next(), history))
    })?;
    let Some(row) = row else {
        return Err(not_physical(&format!(
            "Card {} was not ordered with a delivery, so there is none to show",
            card.id
        )));
    };
    let design_name = card.design_id.as_ref().and_then(|id| {
        d.settings()
            .programme
            .as_ref()
            .and_then(|t| t.designs.iter().find(|g| &g.id == id))
            .map(|g| g.name.clone())
    });
    let estimate_days: i64 = row.get(2);
    let ordered_at: i64 = row.get(3);
    let opt = |v: Option<String>| v.map_or(Json::Null, Json::str);
    let address = stored_address(row.get(6)).ok_or_else(address_missing)?;
    let history = history
        .iter()
        .map(|h| {
            let a = stored_address(h.get(0)).ok_or_else(address_missing)?;
            Ok(Json::obj([
                ("address", a.json()),
                ("changedAt", Json::str(Instant(h.get(1)).iso())),
            ]))
        })
        .collect::<Result<Vec<_>, Refusal>>()?;
    Ok(Json::obj([
        ("cardId", Json::str(card.id.clone())),
        ("state", Json::str(row.get::<_, String>(0))),
        ("designId", opt(card.design_id.clone())),
        ("designName", opt(design_name)),
        ("speed", Json::str(row.get::<_, String>(1))),
        ("estimateDays", Json::int(estimate_days)),
        ("orderedAt", Json::str(Instant(ordered_at).iso())),
        (
            "expectedBy",
            Json::str(Instant(ordered_at + estimate_days * DAY_MS).iso()),
        ),
        ("carrier", opt(row.get(4))),
        ("trackingRef", opt(row.get(5))),
        (
            "notConnected",
            if PRINTER_CONNECTED {
                Json::Null
            } else {
                Json::str("hardware")
            },
        ),
        ("address", address.json()),
        ("history", Json::Array(history)),
    ]))
}

/// `delivery` (BK-cissue-03).
pub fn delivery(d: &Deps<'_>, user_id: &str, card_id: &str) -> Result<Json, Refusal> {
    let card = owned_physical(d, user_id, card_id)?;
    ensure_shipment(d, &card)?;
    read_delivery(d, &card)
}

/// `updateShipping` (`ship-update:<cardId>:<requestId>`): the address of a card not yet produced, the one it replaces
/// kept in the history. Once produced it refuses `bank.card_address_locked`; a retried request that landed changes
/// nothing.
pub fn update_shipping(
    d: &Deps<'_>,
    user_id: &str,
    card_id: &str,
    request_id: &str,
    address: &Address,
) -> Result<Json, Refusal> {
    let card = owned_physical(d, user_id, card_id)?;
    let terms = require_programme(d)?;
    let to = upper(&address.country);
    if !terms.delivery_countries.contains(&to) {
        return Err(not_delivered_to(&to));
    }
    ensure_shipment(d, &card)?;
    let next = Address {
        country: to,
        ..address.clone()
    }
    .json()
    .compact();
    in_tx(d.store(), |tx| {
        let row = tx
            .query(
                "SELECT state, address::text FROM bank.card_shipments WHERE card_id = $1::text::uuid FOR UPDATE",
                &[&card.id],
            )
            .map_err(|e| pg(&e))?;
        let done = tx
            .query(
                "SELECT 1 FROM bank.card_address_changes WHERE card_id = $1::text::uuid AND request_id = $2::text::uuid",
                &[&card.id, &request_id],
            )
            .map_err(|e| pg(&e))?;
        if !done.is_empty() {
            return Ok(());
        }
        let row = row.first();
        if row.is_none_or(|r| r.get::<_, String>(0) != "ordered") {
            return Err(refuse(
                "bank.card_address_locked",
                "This card is already produced, so its delivery address can no longer change",
            ));
        }
        let previous = row
            .and_then(|r| stored_address(r.get(1)))
            .map_or_else(|| "null".to_owned(), |a| a.json().compact());
        tx.execute(
            "INSERT INTO bank.card_address_changes (card_id, request_id, previous_address, address) \
             VALUES ($1::text::uuid, $2::text::uuid, $3::text::jsonb, $4::text::jsonb)",
            &[&card.id, &request_id, &previous, &next],
        )
        .map_err(|e| pg(&e))?;
        tx.execute(
            "UPDATE bank.card_shipments SET address = $2::text::jsonb, updated_at = now() WHERE card_id = $1::text::uuid",
            &[&card.id, &next],
        )
        .map_err(|e| pg(&e))?;
        tx.execute(
            "UPDATE bank.cards SET shipping_address = $2::text::jsonb, updated_at = now() WHERE id = $1::text::uuid",
            &[&card.id, &next],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })?;
    let fresh = with(d.store(), |c| super::card(c, &card.id))?;
    read_delivery(d, &fresh)
}

/// What the printer or courier said (`cardShipmentJobBody`).
#[derive(Debug, Clone)]
pub struct Shipment {
    pub card_id: String,
    pub state: String,
    pub carrier: Option<String>,
    pub tracking_ref: Option<String>,
}

/// `recordShipment`: forward only and idempotent. Only the simulator has a stand-in printer; any other programme
/// refuses `bank.card_printer_unset`.
pub fn record_shipment(d: &Deps<'_>, s: &Shipment) -> Result<Json, Refusal> {
    if d.issuer().programme().id != "card-sim" {
        return Err(refuse(
            "bank.card_printer_unset",
            "Printing and delivery need hardware; no printer or courier is connected",
        ));
    }
    let card = with(d.store(), |c| card(c, &s.card_id))?;
    if card.card_type != "physical" {
        return Err(not_physical("A virtual card has no delivery"));
    }
    ensure_shipment(d, &card)?;
    let to = SHIPMENT_ORDER.iter().position(|x| *x == s.state);
    in_tx(d.store(), |tx| {
        let rows = tx
            .query(
                "SELECT state FROM bank.card_shipments WHERE card_id = $1::text::uuid FOR UPDATE",
                &[&card.id],
            )
            .map_err(|e| pg(&e))?;
        let Some(row) = rows.first() else {
            return Err(not_physical("This card was not ordered with a delivery"));
        };
        let current: String = row.get(0);
        let from = SHIPMENT_ORDER.iter().position(|x| *x == current);
        if to == from {
            return Ok(());
        }
        if to < from {
            return Err(refuse(
                "bank.card_shipment_order",
                format!("A {current} card cannot go back to {}", s.state),
            ));
        }
        #[allow(clippy::cast_possible_wrap, reason = "an index of a four-entry list")]
        let to = to.map_or(-1, |i| i as i64);
        tx.execute(
            "UPDATE bank.card_shipments \
                SET state = $2, \
                    carrier = COALESCE($3, carrier), \
                    tracking_ref = COALESCE($4, tracking_ref), \
                    produced_at = CASE WHEN $5::int8 >= 1 THEN COALESCE(produced_at, now()) ELSE produced_at END, \
                    shipped_at = CASE WHEN $5::int8 >= 2 THEN COALESCE(shipped_at, now()) ELSE shipped_at END, \
                    delivered_at = CASE WHEN $5::int8 >= 3 THEN COALESCE(delivered_at, now()) ELSE delivered_at END, \
                    updated_at = now() \
              WHERE card_id = $1::text::uuid",
            &[&card.id, &s.state, &s.carrier, &s.tracking_ref, &to],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })?;
    read_delivery(d, &card)
}

/// `cardOrders.afterReplace`: a replacement physical card gets its own delivery at the same address and speed
/// (BK-cissue-04).
pub fn after_replace(d: &Deps<'_>, card: &Card) -> Result<(), Refusal> {
    ensure_shipment(d, card)
}

/// `addressFrom`: the input's address, the absent optional parts null, the country upper-cased.
fn address_from(v: &Value) -> Option<Address> {
    address_of(v).map(|a| Address {
        country: a.country.to_uppercase(),
        ..a
    })
}

fn principal<'a>(ctx: &'a Ctx<'_>) -> Result<&'a service_kit::edge::Principal, Refusal> {
    ctx.principal.ok_or_else(|| {
        Refusal::Other("a scoped call reached the slice with no principal".to_owned())
    })
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
        "cards.catalogue" => catalogue(d, user, text(input, "country")),
        "cards.acceptTerms" => accept_terms(
            d,
            user,
            text(input, "termsVersion"),
            text(input, "textHash"),
        ),
        "cards.order" => (|| {
            let card_type = text(input, "cardType");
            let per_text = text(input, "perAuthorizationLimit");
            let uses = int_of(input, "usesAllowed");
            let design = opt_text(input, "designId");
            let speed = opt_text(input, "deliverySpeed");
            let shipping = input.get("shippingAddress");
            if gate::enforced(d) {
                let token = if card_type == "physical" {
                    gate::shipping_token(shipping)
                } else {
                    String::new()
                };
                gate::require(
                    d,
                    principal(ctx)?,
                    &gate::order(&gate::Order {
                        actor: user,
                        card_id,
                        asset_id: text(input, "assetId"),
                        per_authorization_limit: per_text,
                        card_type,
                        country: text(input, "country"),
                        terms_version: text(input, "termsVersion"),
                        uses_allowed: uses,
                        design_id: design,
                        delivery_speed: speed,
                        shipping_address: &token,
                    }),
                    opt_text(input, "stepUpApprovalId"),
                    true,
                )?;
            }
            let address = address_from(shipping);
            if card_type == "physical" && address.is_none() {
                return Err(refuse(
                    "bank.card_shipping_address_required",
                    "A physical card needs a delivery address",
                ));
            }
            let card = order(
                d,
                &OrderAsk {
                    card_id: card_id.to_owned(),
                    user_id: user.to_owned(),
                    country: text(input, "country").to_owned(),
                    terms_version: text(input, "termsVersion").to_owned(),
                    asset_id: text(input, "assetId").to_owned(),
                    per_authorization_limit: amount_of(per_text)?,
                    card_type: card_type.to_owned(),
                    uses_allowed: uses,
                    design_id: design.map(str::to_owned),
                    delivery_speed: speed.map(str::to_owned),
                    shipping_address: address,
                },
            )?;
            Ok(card.view())
        })(),
        "cards.delivery" => delivery(d, user, card_id),
        "cards.updateShipping" => (|| {
            let request_id = text(input, "requestId");
            let given = input.get("address");
            if gate::enforced(d) {
                gate::require(
                    d,
                    principal(ctx)?,
                    &gate::update_shipping(user, card_id, request_id, &gate::shipping_token(given)),
                    opt_text(input, "stepUpApprovalId"),
                    true,
                )?;
            }
            let address = address_from(given).ok_or_else(|| {
                Refusal::Other("cards.updateShipping reached the slice with no address".to_owned())
            })?;
            update_shipping(d, user, card_id, request_id, &address)
        })(),
        _ => return None,
    })
}

/// `cardShipmentJobBody`: zod's strict object (`req.body ?? {}`), or `None` for a body not in shape.
pub fn shipment_body(body: &Value) -> Option<Shipment> {
    let empty = Vec::new();
    let fields = match body {
        Value::Undefined | Value::Null => &empty,
        Value::Object(f) => f,
        _ => return None,
    };
    let mut card_id = None;
    let mut state = None;
    let mut carrier = None;
    let mut tracking_ref = None;
    for (k, v) in fields {
        let s = match v {
            Value::String(s) => s.as_str(),
            Value::Undefined if k == "carrier" || k == "trackingRef" => continue,
            _ => return None,
        };
        let short = || {
            let n = s.encode_utf16().count();
            (1..=80).contains(&n).then(|| s.to_owned())
        };
        match k.as_str() {
            "cardId" if is_zod_uuid(s) => card_id = Some(s.to_owned()),
            "state" if SHIPMENT_ORDER.contains(&s) => state = Some(s.to_owned()),
            "carrier" => carrier = Some(short()?),
            "trackingRef" => tracking_ref = Some(short()?),
            _ => return None,
        }
    }
    Some(Shipment {
        card_id: card_id?,
        state: state?,
        carrier,
        tracking_ref,
    })
}

/// zod 4's `uuid()`: an RFC 9562 UUID of versions 1 to 8 with its variant, or the nil or max UUID.
pub fn is_zod_uuid(s: &str) -> bool {
    if s == "00000000-0000-0000-0000-000000000000" || s == "ffffffff-ffff-ffff-ffff-ffffffffffff" {
        return true;
    }
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    for (i, c) in b.iter().enumerate() {
        let ok = match i {
            8 | 13 | 18 | 23 => *c == b'-',
            14 => (b'1'..=b'8').contains(c),
            19 => b"89abAB".contains(c),
            _ => c.is_ascii_hexdigit(),
        };
        if !ok {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn the_terms_hash_is_sha256_of_the_text_with_its_algorithm() {
        use sha2::{Digest, Sha256};
        assert_eq!(
            terms_text_hash("TEST terms"),
            format!("sha256:{:x}", Sha256::digest(b"TEST terms"))
        );
    }

    #[test]
    fn a_uuid_is_zods() {
        assert!(is_zod_uuid("11111111-1111-4111-8111-111111111111"));
        assert!(is_zod_uuid("00000000-0000-0000-0000-000000000000"));
        assert!(!is_zod_uuid("11111111-1111-0111-8111-111111111111"));
        assert!(!is_zod_uuid("11111111-1111-4111-7111-111111111111"));
        assert!(!is_zod_uuid("11111111-1111-4111-8111-11111111111"));
    }

    #[test]
    fn the_shipment_body_is_zods_strict_object() {
        let id = "11111111-1111-4111-8111-111111111111";
        let v = |j: &str| Value::from_json(&json::parse(j).unwrap());
        let ok = shipment_body(&v(&format!(
            r#"{{"cardId":"{id}","state":"shipped","carrier":"TEST Post"}}"#
        )))
        .unwrap();
        assert_eq!(ok.state, "shipped");
        assert_eq!(ok.carrier.as_deref(), Some("TEST Post"));
        assert!(shipment_body(&Value::Undefined).is_none());
        assert!(shipment_body(&v(&format!(r#"{{"cardId":"{id}","state":"lost"}}"#))).is_none());
        assert!(
            shipment_body(&v(&format!(
                r#"{{"cardId":"{id}","state":"shipped","x":1}}"#
            )))
            .is_none()
        );
        assert!(
            shipment_body(&v(&format!(
                r#"{{"cardId":"{id}","state":"shipped","carrier":""}}"#
            )))
            .is_none()
        );
        assert!(shipment_body(&v(r#"{"cardId":"nope","state":"shipped"}"#)).is_none());
    }
}
