//! The certificate grant path's honesty (`certs/grant-ledger.ts`, and the perk-money check of `certs/perk-plane.ts`):
//! a grant posts no ledger money, publishes XP only on the identity rank graph (`xpEarned`), never writes a rank of its
//! own and never carries an invented perk. Each check refuses a payload naming a banned key; the ledger decision always
//! refuses and never calls a ledger.

use service_kit::json::Json;

use crate::errors::Refusal;

/// `CERT_GRANT_LEDGER_REFUSE_CODE`.
pub const LEDGER_REFUSE_CODE: &str = "academy.cert_grant_ledger_refuse_closed";
/// `CERT_XP_IDENTITY_GRAPH_EVENT`.
pub const XP_IDENTITY_GRAPH_EVENT: &str = "xpEarned";
/// `CERT_GRANT_LEDGER_RESIDUAL`.
pub const LEDGER_RESIDUAL: &str = "TRK-academy.certs — cert grant posts no ledger; XP via svc-identity rank graph only; no fake perks";

/// `CERT_GRANT_LEDGER_BANNED_KEYS`: a ledger post, a second money book, or an academy rank silo.
pub const LEDGER_BANNED_KEYS: [&str; 15] = [
    "ledgerTxId",
    "ledgerEntryId",
    "ledgerBalance",
    "PostRequest",
    "EntryInput",
    "recipes",
    "recipe",
    "ifcAmount",
    "prizePool",
    "certFee",
    "rank_state",
    "rankState",
    "localRank",
    "academyRank",
    "awardXpLocal",
];

/// `CERT_FAKE_PERK_BANNED_KEYS`.
pub const FAKE_PERK_BANNED_KEYS: [&str; 5] = [
    "fakePerk",
    "cosmeticPerk",
    "claimedPerks",
    "inventedPerks",
    "unlockedPerks",
];

/// The perk-money keys `assertNoCertPerkMoneyAttachment` refuses.
pub const PERK_MONEY_BANNED_KEYS: [&str; 11] = [
    "perkMoney",
    "perkAmount",
    "ifcPerk",
    "ifcGrant",
    "certPerkMap",
    "inventedFeeDiscountBps",
    "perkBalance",
    "perkPayout",
    "perkPayoutAmount",
    "inventedPerkPayout",
    "certToPerkMoneyMap",
];

const LEDGER_MESSAGE: &str = "Cert grant does not post ledger money — XP only via intafaced.identity.xp.earned (svc-identity rank graph); refuse-closed";
const FAKE_PERK_MESSAGE: &str = "Fake / cosmetic cert perks are refuse-closed — perks come only from svc-identity rank after XP; no invent";
const LOCAL_RANK_MESSAGE: &str = "Academy does not write rank_state — XP publishes xpEarned for svc-identity only; refuse-closed";
/// The perk plane's refusal words, shared with `perks`.
pub const INVENT_MESSAGE: &str = "Cert perk money / cert→perk map is refuse-closed — perks come only from svc-identity rank after XP (§4.1); no invent";
/// `CERT_PERK_REFUSE_CODE`.
pub const PERK_REFUSE_CODE: &str = "academy.cert_perk_refuse_closed";

/// `Object.assign(new Error(message), { code })`: a plain error carrying a code.
fn refuse(message: &str, code: &str) -> Refusal {
    Refusal::Internal {
        message: message.to_owned(),
        code: Some(code.to_owned()),
    }
}

/// `key in o && o[key] != null`.
fn holds(payload: &Json, key: &str) -> bool {
    payload.get(key).is_some_and(|v| *v != Json::Null)
}

fn keys(payload: &Json) -> Vec<&str> {
    match payload {
        Json::Object(fields) => fields.iter().map(|(k, _)| k.as_str()).collect(),
        _ => Vec::new(),
    }
}

/// `CertGrantLedgerRefuse`: what `decideCertGrantLedgerPost` always answers.
pub fn decide_ledger_post() -> Json {
    Json::obj([
        ("ok", Json::Bool(false)),
        ("code", Json::str(LEDGER_REFUSE_CODE)),
        ("ledgerPosted", Json::Bool(false)),
        ("rankWriter", Json::str("svc-identity")),
        ("xpGraph", Json::str("intafaced.identity.xp.earned")),
        ("academyWritesRankState", Json::Bool(false)),
        ("residual", Json::str(LEDGER_RESIDUAL)),
    ])
}

/// `isCertGrantLedgerRefuseClosed`.
pub fn is_ledger_refuse_closed(decision: &Json) -> bool {
    decision.get("ok") == Some(&Json::Bool(false))
        && decision.get("code") == Some(&Json::str(LEDGER_REFUSE_CODE))
        && decision.get("ledgerPosted") == Some(&Json::Bool(false))
        && decision.get("academyWritesRankState") == Some(&Json::Bool(false))
}

/// `isIdentityRankXpEvent`.
pub fn is_identity_rank_xp_event(event: &str) -> bool {
    event == XP_IDENTITY_GRAPH_EVENT
}

/// `isAcademyLocalRankWrite`.
pub fn is_academy_local_rank_write(event: &str) -> bool {
    matches!(event, "rankUpdated" | "rank_state" | "awardXpLocal")
}

/// `assertMayPublishCertXpOnIdentityGraph`: only `xpEarned`.
pub fn assert_may_publish_on_identity_graph(event: &str) -> Result<(), Refusal> {
    if is_academy_local_rank_write(event) || !is_identity_rank_xp_event(event) {
        return Err(refuse(LOCAL_RANK_MESSAGE, LEDGER_REFUSE_CODE));
    }
    Ok(())
}

/// `assertCertGrantNeverPostsLedger`.
pub fn assert_never_posts_ledger(payload: &Json) -> Result<(), Refusal> {
    if LEDGER_BANNED_KEYS.iter().any(|k| holds(payload, k)) {
        return Err(refuse(LEDGER_MESSAGE, LEDGER_REFUSE_CODE));
    }
    Ok(())
}

/// `assertNoFakeCertPerks`.
pub fn assert_no_fake_perks(payload: &Json) -> Result<(), Refusal> {
    if FAKE_PERK_BANNED_KEYS.iter().any(|k| holds(payload, k)) {
        return Err(refuse(FAKE_PERK_MESSAGE, LEDGER_REFUSE_CODE));
    }
    Ok(())
}

/// `assertCertGrantPathHonest`: no ledger fields, no fake perks, no local rank silo.
pub fn assert_grant_path_honest(payload: &Json) -> Result<(), Refusal> {
    assert_never_posts_ledger(payload)?;
    assert_no_fake_perks(payload)?;
    let k = keys(payload);
    if k.contains(&"rankUpdated") || k.contains(&"rank_state") {
        return Err(refuse(LOCAL_RANK_MESSAGE, LEDGER_REFUSE_CODE));
    }
    Ok(())
}

/// `assertNoCertPerkMoneyAttachment`: the grant path's honesty, then no perk money.
pub fn assert_no_perk_money(payload: &Json) -> Result<(), Refusal> {
    assert_grant_path_honest(payload)?;
    if PERK_MONEY_BANNED_KEYS.iter().any(|k| holds(payload, k)) {
        return Err(refuse(INVENT_MESSAGE, PERK_REFUSE_CODE));
    }
    Ok(())
}

/// `certGrantLedgerStatusLine`.
pub fn ledger_status_line() -> String {
    format!(
        "grantLedger=0 xpGraph={XP_IDENTITY_GRAPH_EVENT} rankWriter=svc-identity fakePerk=0 code={LEDGER_REFUSE_CODE}"
    )
}
