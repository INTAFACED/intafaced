//! The desk's two reads of a person's cards: one authorisation for compliance (`ops/authorization-detail.ts`,
//! `CardService.authorizationById`) and one customer's cards for the console's record (`ops/customer-cards.ts`,
//! `CardService.cardsPage`). Each writes one structured audit line before it reads; nothing is inserted.

use std::io::Write as _;

use postgres::GenericClient;
use service_kit::json::Json;
use service_kit::money::{format_amount, parse_amount};
use service_kit::time::Instant;

use crate::cards::core::{cards_list_limit, cards_page};
use crate::cards::reads::channel;
use crate::cards::{Card, Deps, ms};
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{pg, with};

/// `AUTHORIZATION_FIELDS_NOT_ON_CARD_SIM`: what a live issuer would send that the simulator does not, named, never blank.
pub const NOT_ON_CARD_SIM: [&str; 7] = [
    "merchantName",
    "merchantCountry",
    "networkData",
    "method",
    "cardPresence",
    "initiator",
    "type",
];

/// `NOT_AVAILABLE_ON_CARD_SIM`.
pub const NOT_AVAILABLE: &str = "not available on card-sim";

fn line(fields: &[(&str, &str)]) -> std::io::Result<()> {
    let mut all = vec![
        ("level", Json::str("info")),
        ("service", Json::str("svc-bank")),
    ];
    all.extend(fields.iter().map(|(k, v)| (*k, Json::str(*v))));
    let line = Json::Object(all.into_iter().map(|(k, v)| (k.to_owned(), v)).collect());
    writeln!(std::io::stdout(), "{}", line.compact())
}

/// `writeAuthorizationReadAudit`: one line with the actor and the id. It is not caught in the TypeScript, so a sink
/// that throws is the guard's opaque failure.
pub fn authorization_audit(actor: &str, id: &str) -> Result<(), Refusal> {
    line(&[
        ("event", "bank.ops.authorization_read"),
        ("actorUserId", actor),
        ("id", id),
    ])
    .map_err(|e| Refusal::Other(e.to_string()))
}

/// `writeCustomerCardsAudit`: a line that cannot be written refuses the read.
pub fn customer_cards_audit(actor: &str, owner: &str) -> Result<(), Refusal> {
    line(&[
        ("event", "bank.ops.customer_cards_read"),
        ("actorUserId", actor),
        ("ownerUserId", owner),
    ])
    .map_err(|_| {
        refuse(
            "bank.ops_audit_unavailable",
            "The read could not be recorded, so nothing was read",
        )
    })
}

/// `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`.
fn is_uuid(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    parts.len() == 5
        && parts
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(p, n)| p.len() == n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn not_found() -> Refusal {
    refuse(
        "bank.ops_authorization_not_found",
        "No such card authorisation (bank.ops_authorization_not_found)",
    )
}

fn decimal(s: &str) -> Result<String, Refusal> {
    parse_amount(s).map(format_amount).map_err(Refusal::Other)
}

/// `authorizationById` and the procedure's shape: the stored decision, its hold and both legs of its conversion, with
/// the fields the simulator does not have named. `None` when there is none.
pub fn authorization_by_id(c: &mut impl GenericClient, id: &str) -> Result<Option<Json>, Refusal> {
    let sql = format!(
        "SELECT a.id::text, a.card_id::text, k.user_id::text, k.asset_id, a.authorization_ref, a.amount::text, \
                a.merchant_category, a.channel, a.decision::text, a.decline_code, a.status::text, a.hold_ledger_tx_id, \
                {decided}, c.settlement_asset_id, c.settlement_amount::text, c.funding_asset_id, c.funding_amount::text, \
                c.rate::text, c.rate_quality::text, {rate_as_of} \
           FROM bank.card_authorizations a \
           JOIN bank.cards k ON k.id = a.card_id \
           LEFT JOIN bank.card_conversions c ON c.authorization_id = a.id \
          WHERE a.id = $1::text::uuid",
        decided = ms("a.decided_at"),
        rate_as_of = ms("c.rate_as_of"),
    );
    let rows = c.query(&sql, &[&id]).map_err(|e| pg(&e))?;
    let Some(r) = rows.first() else {
        return Ok(None);
    };
    let g = |i: usize| -> Result<String, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
    let o = |i: usize| -> Result<Option<String>, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
    let opt = |v: Option<String>| v.map_or(Json::Null, Json::str);
    let decided: i64 = r.try_get(12).map_err(|e| pg(&e))?;
    let rate_as_of: Option<i64> = r.try_get(19).map_err(|e| pg(&e))?;
    // The conversion: every column present together, or none (`toConversion`).
    let conversion = match (o(13)?, o(14)?, o(15)?, o(16)?, o(17)?, o(18)?, rate_as_of) {
        (Some(sa), Some(samt), Some(fa), Some(famt), Some(rate), Some(q), Some(at)) => Json::obj([
            ("settlementAssetId", Json::str(sa)),
            ("settlementAmount", Json::str(decimal(&samt)?)),
            ("fundingAssetId", Json::str(fa)),
            ("fundingAmount", Json::str(decimal(&famt)?)),
            ("rate", Json::str(decimal(&rate)?)),
            ("rateQuality", Json::str(q)),
            ("rateAsOf", Json::str(Instant(at).iso())),
        ]),
        _ => Json::Null,
    };
    Ok(Some(Json::obj([
        ("id", Json::str(g(0)?)),
        ("cardId", Json::str(g(1)?)),
        ("userId", Json::str(g(2)?)),
        // `amount` is in the card's funding asset, `bank.cards.asset_id`.
        ("assetId", Json::str(g(3)?)),
        ("authorizationRef", Json::str(g(4)?)),
        ("amount", Json::str(decimal(&g(5)?)?)),
        ("merchantCategory", opt(o(6)?)),
        ("channel", Json::str(channel(&g(7)?))),
        ("decision", Json::str(g(8)?)),
        ("declineCode", opt(o(9)?)),
        ("status", Json::str(g(10)?)),
        ("holdLedgerTxId", opt(o(11)?)),
        ("decidedAt", Json::str(Instant(decided).iso())),
        ("conversion", conversion),
        (
            "notAvailable",
            Json::Array(
                NOT_ON_CARD_SIM
                    .iter()
                    .map(|f| {
                        Json::obj([
                            ("field", Json::str(*f)),
                            ("reason", Json::str(NOT_AVAILABLE)),
                        ])
                    })
                    .collect(),
            ),
        ),
    ])))
}

/// `ops.authorizationGet`: the audit line, then the read; an unknown and a malformed id are the same not-found.
pub fn authorization_get(d: &Deps<'_>, actor: &str, id: &str) -> Result<Json, Refusal> {
    authorization_audit(actor, id)?;
    if !is_uuid(id) {
        return Err(not_found());
    }
    with(d.store(), |c| authorization_by_id(c, id))?.ok_or_else(not_found)
}

/// `customerCardOutput`: the owner's view of a card without its shipping address.
pub fn customer_card(card: &Card) -> Json {
    match card.view() {
        Json::Object(fields) => Json::Object(
            fields
                .into_iter()
                .filter(|(k, _)| k != "shippingAddress")
                .collect(),
        ),
        other => other,
    }
}

/// `ops.customerCards`: the page size is checked once, before the audit line; the line is written before any card is
/// read, and a line that cannot be written reads nothing.
pub fn customer_cards(
    d: &Deps<'_>,
    actor: &str,
    owner: &str,
    limit: Option<f64>,
) -> Result<Json, Refusal> {
    let page = cards_list_limit(limit)?;
    customer_cards_audit(actor, owner)?;
    let cards = with(d.store(), |c| cards_page(c, owner, page))?;
    Ok(Json::obj([
        ("userId", Json::str(owner)),
        (
            "cards",
            Json::Array(cards.iter().map(customer_card).collect()),
        ),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_uuid_in_any_case_is_read() {
        assert!(is_uuid("6f1c1c2e-0000-4000-8000-00000000000A"));
        assert!(!is_uuid("not-an-id"));
        assert!(!is_uuid("6f1c1c2e00004000800000000000000a"));
        assert!(!is_uuid("6f1c1c2e-0000-4000-8000-00000000000g"));
    }
}
