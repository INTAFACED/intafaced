//! `POST /internal/agents/usage-payment` past the door's checks (`agents/usage-payment.ts`, J-agents-01): how a person
//! pays for agent usage, and one payment of a sealed window, carried out by the partner that holds their money.
//!
//! A business's usage is paid by its first administrator. Only a partner-held payer can pay; anyone else answers
//! `not_partner_held`. A payment is one partner move into INTAFACED's own account at the partner under
//! `agents.usage-payment:<chargeKey>`, so the same charge is paid once; one already made is answered as made, even
//! while the freeze is on. A partner refusal answers its reason; any answer that cannot be given is a 503, never a
//! payment made or refused.

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::schema::Value;
use service_kit::server::Response;
use service_kit::time::Instant;

use super::custody::assert_posting_enabled;
use super::router::Wiring;
use super::{AccountRef, MoveRequest, money_held_by};
use crate::db::{Store, StoreError, with_client};
use crate::errors::Refusal;

/// INTAFACED's own account at the partner (`PARTNER_INTAFACED_OWNER`).
pub const INTAFACED_OWNER: &str = "partner:intafaced";

/// `usagePaymentKey`.
pub fn key(charge_key: &str) -> String {
    format!("agents.usage-payment:{charge_key}")
}

/// `firstAdministrator`: the business's first admin by when they joined, when it is active.
fn first_administrator(store: &Store, business_id: &str) -> Result<Option<String>, StoreError> {
    let pool = store.pool()?;
    with_client(pool, |c| {
        let rows = c.query(
            "SELECT m.user_id::text \
               FROM bank.business_accounts a \
               JOIN bank.business_members m ON m.account_id = a.id \
              WHERE a.id = $1::text::uuid AND a.status = 'active' AND m.role = 'admin' \
              ORDER BY m.created_at, m.user_id \
              LIMIT 1",
            &[&business_id.to_lowercase()],
        )?;
        rows.first()
            .map(|r| r.try_get::<_, String>(0).map_err(|e| StoreError::from(&e)))
            .transpose()
    })
}

/// `decimal` of the contract: `^\d{1,30}(\.\d{1,18})?$`.
fn decimal_ok(text: &str) -> bool {
    let (whole, frac) = text.split_once('.').unwrap_or((text, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    (1..=30).contains(&whole.len())
        && digits(whole)
        && (!text.contains('.') || ((1..=18).contains(&frac.len()) && digits(frac)))
}

fn reason_of(r: &Refusal) -> Option<&'static str> {
    let Refusal::Bank(e) = r else { return None };
    Some(match e.row.code {
        "bank.partner_insufficient_funds" => "insufficient_funds",
        "bank.partner_unavailable" => "partner_unavailable",
        "bank.partner_reply_lost" => "reply_lost",
        "bank.posting_frozen" => "posting_frozen",
        "bank.partner_stopped" | "bank.partner_stop_unreadable" => "partner_stopped",
        _ => return None,
    })
}

/// The payer: the member, or the business's first administrator.
fn payer(store: &Store, body: &Value) -> Result<Option<String>, String> {
    match body.get("businessId").as_str() {
        None => Ok(body.get("userId").as_str().map(str::to_owned)),
        Some(b) => first_administrator(store, b).map_err(|e| e.message),
    }
}

fn read(w: &Wiring, store: &Store, body: &Value, now: Instant) -> Result<Json, String> {
    let Some(user) = payer(store, body)? else {
        return Ok(Json::obj([("heldBy", Json::str("none"))]));
    };
    let held = money_held_by(w.partner.as_ref(), &user, &w.custody_layer);
    let custody = w.custody(store);
    let bank = (held == "partner")
        .then(|| custody.bank_for(&user))
        .flatten();
    let Some(bank) = bank else {
        let kind = if held == "partner" { "none" } else { held };
        return Ok(Json::obj([("heldBy", Json::str(kind))]));
    };
    let asset = body.get("assetId").as_str().unwrap_or_default();
    let b = bank.balance(&AccountRef::main(&user, asset), now);
    let known = match (b.amount, b.as_of) {
        (Some(a), Some(t)) if !b.unavailable => Some((a, t)),
        _ => None,
    };
    let available = known.map(|(a, _)| format_amount(a));
    if available.as_deref().is_some_and(|a| !decimal_ok(a)) {
        return Err("a balance the contract cannot carry".to_owned());
    }
    Ok(Json::obj([
        ("heldBy", Json::str("partner")),
        ("label", Json::str(b.label)),
        ("available", available.map_or(Json::Null, Json::str)),
        (
            "asOf",
            known.map_or(Json::Null, |(_, t)| Json::str(t.iso())),
        ),
    ]))
}

fn refused(reason: &str) -> Json {
    Json::obj([("ok", Json::Bool(false)), ("reason", Json::str(reason))])
}

fn collect(w: &Wiring, store: &Store, body: &Value, now: Instant) -> Result<Json, String> {
    let Some(user) = payer(store, body)? else {
        return Ok(refused("not_partner_held"));
    };
    let custody = w.custody(store);
    let bank = (money_held_by(w.partner.as_ref(), &user, &w.custody_layer) == "partner")
        .then(|| custody.bank_for(&user))
        .flatten();
    let Some(bank) = bank else {
        return Ok(refused("not_partner_held"));
    };
    let amount: Amount = parse_amount(body.get("amount").as_str().unwrap_or_default())?;
    if amount <= Amount::ZERO {
        return Err("A usage payment needs an amount above zero.".to_owned());
    }
    let asset = body.get("assetId").as_str().unwrap_or_default();
    let key = key(body.get("chargeKey").as_str().unwrap_or_default());
    let paid = (|| {
        // A payment already made under this key is answered as made, even while the freeze is on.
        if bank.move_by_key(&key).is_none() {
            assert_posting_enabled(w.freeze.as_ref(), store, "agents_usage_payment", false)?;
        }
        bank.move_(
            &MoveRequest {
                key: key.clone(),
                from: AccountRef::main(&user, asset),
                to: AccountRef::main(INTAFACED_OWNER, asset),
                amount,
                payees: None,
            },
            now,
        )
    })();
    match paid {
        Ok(m) => {
            let amount = format_amount(m.amount);
            let id_ok = !m.id.is_empty()
                && m.id.len() <= 128
                && !m.id.contains(|c: char| c == ':' || c.is_whitespace());
            if !decimal_ok(&amount) || !id_ok {
                return Err("a payment the contract cannot carry".to_owned());
            }
            Ok(Json::obj([
                ("ok", Json::Bool(true)),
                ("paymentId", Json::str(m.id)),
                ("partnerId", Json::str("test")),
                ("label", Json::str(m.label)),
                ("amount", Json::str(amount)),
                ("paidAt", Json::str(m.moved_at.iso())),
            ]))
        }
        Err(r) => reason_of(&r).map(refused).ok_or_else(|| format!("{r:?}")),
    }
}

/// The door's answer once the caller and the body passed: the read or the payment, or 503.
pub fn answer(w: &Wiring, store: &Store, body: &Value, now: Instant) -> Response {
    let out = if body.get("action").as_str() == Some("read") {
        read(w, store, body, now)
    } else {
        collect(w, store, body, now)
    };
    match out {
        Ok(json) => Response {
            status: 200,
            body: json.compact(),
        },
        Err(_) => Response {
            status: 503,
            body: Json::obj([
                ("error", Json::str("usage payment could not be answered")),
                ("code", Json::str("bank.usage_payment_unavailable")),
            ])
            .compact(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_decimal_is_the_contracts() {
        for ok in ["0", "12", "1.5", "123456789012345678901234567890"] {
            assert!(decimal_ok(ok), "{ok}");
        }
        for bad in [
            "",
            "-1",
            "1.",
            ".5",
            "1.1234567890123456789",
            "1234567890123456789012345678901",
            "1e3",
        ] {
            assert!(!decimal_ok(bad), "{bad}");
        }
    }
}
