//! The card doors' step-up bindings (`step-up/money-out-fields.ts`: every `bank.step_up.cards.*`) and the router's
//! own pieces around them (`shippingToken`, `refuseCardSecretWithoutStepUp`). The gate itself is the transfers slice's
//! (`transfers::step_up`), with its uses on `bank.step_up_uses`.

use service_kit::edge::Principal;
use service_kit::json::Json;
use service_kit::money::js_trim;
use service_kit::schema::Value;

use super::Deps;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::transfers::step_up::{self, Binding};

fn f(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

/// `stepUpEnforced`.
pub fn enforced(d: &Deps<'_>) -> bool {
    step_up::enforced(d.t)
}

/// `requireStepUp(principal, binding, approvalId, replay)`.
pub fn require(
    d: &Deps<'_>,
    principal: &Principal,
    binding: &Binding,
    approval_id: Option<&str>,
    replay: bool,
) -> Result<(), Refusal> {
    step_up::require_with(d.t, principal, binding, approval_id, replay)
}

/// `refuseCardSecretWithoutStepUp`.
pub fn secret_without_step_up() -> Refusal {
    refuse(
        "bank.step_up_unavailable",
        "Showing or setting card secrets needs step-up, and step-up is not switched on in this deployment.",
    )
}

/// `unfreezeCardBinding`.
pub fn unfreeze(actor: &str, card_id: &str, from_status: &str) -> Binding {
    Binding {
        action_type: "bank.step_up.cards.unfreeze",
        operation_key: format!("{card_id}:{from_status}"),
        fields: f(&[
            ("actor", actor),
            ("cardId", card_id),
            ("fromStatus", from_status),
            ("status", "active"),
        ]),
    }
}

/// `issueCardBinding`.
pub struct Issue<'a> {
    pub actor: &'a str,
    pub card_id: &'a str,
    pub asset_id: &'a str,
    pub settlement_asset_id: Option<&'a str>,
    pub cashback_bps: Option<i64>,
    pub per_authorization_limit: &'a str,
    pub card_type: &'a str,
    pub shipping_address: &'a str,
}

pub fn issue(i: &Issue<'_>) -> Binding {
    let bps = i.cashback_bps.map(|b| b.to_string()).unwrap_or_default();
    Binding {
        action_type: "bank.step_up.cards.issue",
        operation_key: i.card_id.to_owned(),
        fields: f(&[
            ("actor", i.actor),
            ("cardId", i.card_id),
            ("assetId", i.asset_id),
            ("settlementAssetId", i.settlement_asset_id.unwrap_or("")),
            ("cashbackBps", &bps),
            ("perAuthorizationLimit", i.per_authorization_limit),
            ("cardType", i.card_type),
            ("shippingAddress", i.shipping_address),
        ]),
    }
}

/// `setCardLimitsBinding`: each ceiling as `limitField` writes it (`''` absent, `'null'` removed).
pub fn set_limits(
    actor: &str,
    card_id: &str,
    command_id: &str,
    per: &str,
    daily: &str,
    monthly: &str,
    cash: &str,
) -> Binding {
    Binding {
        action_type: "bank.step_up.cards.setLimits",
        operation_key: command_id.to_owned(),
        fields: f(&[
            ("actor", actor),
            ("cardId", card_id),
            ("commandId", command_id),
            ("perAuthorizationLimit", per),
            ("dailyLimit", daily),
            ("monthlyLimit", monthly),
            ("cashLimit", cash),
        ]),
    }
}

/// `revealCardBinding`.
pub fn reveal(actor: &str, card_id: &str, reveal_id: &str) -> Binding {
    Binding {
        action_type: "bank.step_up.cards.reveal",
        operation_key: reveal_id.to_owned(),
        fields: f(&[
            ("actor", actor),
            ("cardId", card_id),
            ("revealId", reveal_id),
        ]),
    }
}

/// `revealCardPinBinding`.
pub fn pin_reveal(actor: &str, card_id: &str, reveal_id: &str) -> Binding {
    Binding {
        action_type: "bank.step_up.cards.pinReveal",
        operation_key: reveal_id.to_owned(),
        fields: f(&[
            ("actor", actor),
            ("cardId", card_id),
            ("revealId", reveal_id),
        ]),
    }
}

/// `setCardPinBinding`: binds the attempt, never the PIN.
pub fn pin_set(actor: &str, card_id: &str, command_id: &str) -> Binding {
    Binding {
        action_type: "bank.step_up.cards.pinSet",
        operation_key: command_id.to_owned(),
        fields: f(&[
            ("actor", actor),
            ("cardId", card_id),
            ("commandId", command_id),
        ]),
    }
}

/// `activateCardBinding`.
pub fn activate(actor: &str, card_id: &str) -> Binding {
    Binding {
        action_type: "bank.step_up.cards.activate",
        operation_key: card_id.to_owned(),
        fields: f(&[("actor", actor), ("cardId", card_id)]),
    }
}

/// `orderCardBinding`: every term of the order.
pub struct Order<'a> {
    pub actor: &'a str,
    pub card_id: &'a str,
    pub asset_id: &'a str,
    pub per_authorization_limit: &'a str,
    pub card_type: &'a str,
    pub country: &'a str,
    pub terms_version: &'a str,
    pub uses_allowed: Option<i64>,
    pub design_id: Option<&'a str>,
    pub delivery_speed: Option<&'a str>,
    pub shipping_address: &'a str,
}

pub fn order(i: &Order<'_>) -> Binding {
    let uses = i.uses_allowed.map(|u| u.to_string()).unwrap_or_default();
    let country = i.country.to_uppercase();
    Binding {
        action_type: "bank.step_up.cards.order",
        operation_key: i.card_id.to_owned(),
        fields: f(&[
            ("actor", i.actor),
            ("cardId", i.card_id),
            ("assetId", i.asset_id),
            ("perAuthorizationLimit", i.per_authorization_limit),
            ("cardType", i.card_type),
            ("country", &country),
            ("termsVersion", i.terms_version),
            ("usesAllowed", &uses),
            ("designId", i.design_id.unwrap_or("")),
            ("deliverySpeed", i.delivery_speed.unwrap_or("")),
            ("shippingAddress", i.shipping_address),
        ]),
    }
}

/// `updateCardShippingBinding`.
pub fn update_shipping(actor: &str, card_id: &str, request_id: &str, shipping: &str) -> Binding {
    Binding {
        action_type: "bank.step_up.cards.updateShipping",
        operation_key: request_id.to_owned(),
        fields: f(&[
            ("actor", actor),
            ("cardId", card_id),
            ("requestId", request_id),
            ("shippingAddress", shipping),
        ]),
    }
}

/// `shippingToken(address)`: the address as one canonical string for a binding, `''` with none. The input's strings
/// are already trimmed by its schema; this trims again, as the TypeScript does.
pub fn shipping_token(address: &Value) -> String {
    if matches!(address, Value::Undefined) {
        return String::new();
    }
    let t = |k: &str| js_trim(address.get(k).as_str().unwrap_or("")).to_owned();
    Json::obj([
        ("name", Json::str(t("name"))),
        ("line1", Json::str(t("line1"))),
        ("line2", Json::str(t("line2"))),
        ("city", Json::str(t("city"))),
        ("region", Json::str(t("region"))),
        ("postalCode", Json::str(t("postalCode"))),
        ("country", Json::str(t("country").to_uppercase())),
    ])
    .compact()
}
