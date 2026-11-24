//! The perk plane (`certs/perk-plane.ts`): a certificate's perks are real only through svc-identity's rank (XP, then
//! `rank_thresholds.perks`); every attempt to invent perk money or a certificate-to-perk map refuses closed. The Academy
//! holds no perk book.

use service_kit::json::Json;

use super::honesty::{INVENT_MESSAGE, PERK_REFUSE_CODE};
use super::xp::Emit;
use crate::ports::HostRights;

/// `CERT_PERK_RESIDUAL`.
pub const RESIDUAL: &str = "TRK-academy.certs D26-P1-C1 — perks via svc-identity rank only; cert→perk money refuse-closed (no invent)";

/// `INVENT_KINDS`, in their pinned order.
pub const INVENT_KINDS: [&str; 5] = [
    "cert_to_perk_map",
    "invent_perk_money",
    "invent_fee_discount",
    "invent_ifc_grant",
    "invent_balance",
];

const UNPRICED_MESSAGE: &str =
    "Unpriced cert publishes nothing — no XP, no identity perk grant, no invent perk money";
const UNREADABLE_MESSAGE: &str = "Identity perk table unreadable — refusing to invent cert perks (fail closed; grant + XP still durable)";

/// `decideCertPerkInvent(kind)`: always a refusal.
pub fn decide_invent(kind: &str) -> Json {
    Json::obj([
        ("status", Json::str("refuse")),
        ("code", Json::str(PERK_REFUSE_CODE)),
        ("kind", Json::str(kind)),
        ("message", Json::str(INVENT_MESSAGE)),
        ("academyHoldsPerkMoney", Json::Bool(false)),
        ("academyMapsCertToPerk", Json::Bool(false)),
        ("residual", Json::str(RESIDUAL)),
    ])
}

/// `isCertPerkInventRefuseClosed`.
pub fn is_invent_refuse_closed(decision: &Json) -> bool {
    decision.get("status") == Some(&Json::str("refuse"))
        && decision.get("code") == Some(&Json::str(PERK_REFUSE_CODE))
        && decision.get("academyHoldsPerkMoney") == Some(&Json::Bool(false))
        && decision.get("academyMapsCertToPerk") == Some(&Json::Bool(false))
}

fn refusal(reason: &str, message: &str) -> Json {
    Json::obj([
        ("status", Json::str("refuse")),
        ("code", Json::str(PERK_REFUSE_CODE)),
        ("reason", Json::str(reason)),
        ("message", Json::str(message)),
        ("academyHoldsPerkMoney", Json::Bool(false)),
        ("academyMapsCertToPerk", Json::Bool(false)),
        ("residual", Json::str(RESIDUAL)),
    ])
}

/// `rankPerksSchema` as the router's output keeps it: its seven keys, in order, nothing else.
fn rank_perks(perks: &Json) -> Json {
    let key = |k: &str| (k.to_owned(), perks.get(k).cloned().unwrap_or(Json::Null));
    Json::Object(
        [
            "feeDiscountBps",
            "p2pLimitMultiplier",
            "copyFollowerCap",
            "lobbyHostRights",
            "cardTier",
            "otcAccess",
            "launchpadTier",
        ]
        .into_iter()
        .map(key)
        .collect(),
    )
}

/// `resolveCertPerkOutcome`: an unpriced certificate refuses before identity is asked; identity's perks when it
/// answers; a refusal, never an invented perk, when it cannot.
pub fn resolve(user_id: &str, host_rights: &dyn HostRights, xp: &Emit) -> Json {
    if xp.is_unpriced() {
        return refusal("unpriced", UNPRICED_MESSAGE);
    }
    match host_rights.perks_of(user_id) {
        Ok(perks) => Json::obj([
            ("status", Json::str("real")),
            ("path", Json::str("identity_rank")),
            ("sot", Json::str("svc-identity")),
            ("academyHoldsPerkMoney", Json::Bool(false)),
            ("academyMapsCertToPerk", Json::Bool(false)),
            ("perks", rank_perks(&perks)),
        ]),
        Err(_) => refusal("identity_unreadable", UNREADABLE_MESSAGE),
    }
}

/// `certPerkPlaneStatusLine`.
pub fn plane_status_line() -> String {
    format!("perks=identity_rank sot=svc-identity academyMap=0 perkMoney=0 code={PERK_REFUSE_CODE}")
}

/// `certPerkPlaneStatus`.
pub fn plane_status() -> Json {
    Json::obj([
        ("perksEnabledViaIdentity", Json::Bool(true)),
        ("academyMapsCertToPerk", Json::Bool(false)),
        ("academyHoldsPerkMoney", Json::Bool(false)),
        ("rankWriter", Json::str("svc-identity")),
        ("residual", Json::str(RESIDUAL)),
        (
            "inventKindsRefuseClosed",
            Json::Array(INVENT_KINDS.iter().map(|k| Json::str(*k)).collect()),
        ),
        ("statusLine", Json::str(plane_status_line())),
    ])
}

/// `certPerkResidualIsHonest`.
pub fn residual_is_honest(residual: &str) -> bool {
    residual.contains("refuse-closed")
        && residual.contains("no invent")
        && residual.contains("svc-identity")
}

/// `grantCertMustNotInventPerkPayout`: the grant's perk view names no perk money and, unpriced, refuses.
pub fn grant_must_not_invent_payout(xp: &Emit, perks: &Json) -> bool {
    if perks.get("academyHoldsPerkMoney") != Some(&Json::Bool(false))
        || perks.get("academyMapsCertToPerk") != Some(&Json::Bool(false))
    {
        return false;
    }
    let status = perks.get("status").cloned();
    if xp.is_unpriced() {
        return status == Some(Json::str("refuse"))
            && perks.get("reason") == Some(&Json::str("unpriced"))
            && perks.get("code") == Some(&Json::str(PERK_REFUSE_CODE))
            && perks.get("perks").is_none();
    }
    if status == Some(Json::str("refuse")) {
        return perks.get("code") == Some(&Json::str(PERK_REFUSE_CODE));
    }
    status == Some(Json::str("real"))
        && perks.get("sot") == Some(&Json::str("svc-identity"))
        && perks.get("path") == Some(&Json::str("identity_rank"))
}
