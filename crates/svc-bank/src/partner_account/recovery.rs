//! `recovery.*` (`recovery/`: recovery.router.ts, recovery-claims.ts, identity-recovery.ts): the heir's claim room.
//!
//! The heir an owner named moves the owner's balances into their own main account, once two staff confirmed the
//! owner's death and enough of the owner's own recovery keys signed the claim. Identity decides who may claim and
//! whether the signatures count ([`identity`]); the bank keeps only the claim and its sweep plan
//! (`bank.recovery_claims`, `bank.recovery_sweeps`), never a balance ([`ledger`]).
//!
//! Each door acts for the signed-in person only: an API key or a sub-account refuses `bank.recovery_delegated`, staff
//! (`admin:*` and every founder desk scope) refuse `bank.recovery_staff_forbidden`.
//!
//! A round plans one row per funded free account of the owner before anything posts, then posts each row as a
//! `bankTransfer` in the `recovery` key space, keyed by the claim, the account and the round; a crash after the plan
//! resumes the same rows with the same keys. A negative balance (a debt) refuses the round with `bank.recovery_blocked`.
//! The post goes through [`ledger::Ledger::bank_transfer`]; while no svc-ledger post door is wired for the Rust bank,
//! `claims.execute` answers "not ported" before it reads or writes anything.

pub mod identity;
pub mod ledger;

use std::collections::BTreeMap;

use postgres::{IsolationLevel, Row, Transaction};
use service_kit::edge::Principal;
use service_kit::http::UreqFetch;
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::s2s::{CallSigner, s2s_from_env};
use service_kit::schema::Value;
use service_kit::server::Response;
use sha2::{Digest, Sha256};

use self::identity::{IdentityRecovery, Verdict};
use self::ledger::{AccountRef, BankTransfer, DEFINITE_POST_REFUSALS, Ledger, PostError};
use super::{Deps, refuse};
use crate::db::{Store, StoreError, with_client};
use crate::door::{Ctx, Slice, not_ported};
use crate::errors::Refusal;

/// What this part holds, built once from the environment (`index.ts`: `createIdentityRecovery` or
/// `unconfiguredIdentityRecovery`, `createLedgerClient`).
pub struct Wiring {
    pub identity: Box<dyn IdentityRecovery>,
    pub ledger: Box<dyn Ledger>,
}

/// A raw environment value, blank read as unset.
pub fn env_value<'a>(env: &'a BTreeMap<String, String>, key: &str) -> Option<&'a str> {
    env.get(key)
        .map(|v| service_kit::money::js_trim(v))
        .filter(|v| !v.is_empty())
}

/// `serviceCallSigner({ service: 'svc-bank', audience, legacySecret: INTERNAL_SERVICE_SECRET, s2s })` from the
/// environment; `None` for a door built without the service's environment (no `INTERNAL_SERVICE_SECRET`, which env.ts
/// requires), whose clients are then not wired at all.
pub fn call_signer(
    env: &BTreeMap<String, String>,
    audience: &str,
) -> Result<Option<CallSigner>, String> {
    let Some(secret) = env_value(env, "INTERNAL_SERVICE_SECRET") else {
        return Ok(None);
    };
    let s2s = s2s_from_env(
        env_value(env, "S2S_AUTH_MODE").unwrap_or("off"),
        env_value(env, "S2S_KEYRING"),
        env_value(env, "S2S_SIGNING_KID"),
        env_value(env, "S2S_SIGNING_KEY"),
        "svc-bank",
    )?;
    let keys = match (s2s.signer, s2s.mode) {
        (Some(signer), Some(mode)) => Some((signer, mode)),
        _ => None,
    };
    Ok(Some(CallSigner::new("svc-bank", audience, secret, keys)))
}

/// svc-ledger's reads as the slice makes them (`LEDGER_URL`, `http://localhost:4001` by default).
pub fn ledger_from_env(env: &BTreeMap<String, String>) -> Result<Box<dyn Ledger>, String> {
    Ok(match call_signer(env, "svc-ledger")? {
        None => Box::new(ledger::Unwired),
        Some(signer) => Box::new(ledger::HttpLedger {
            base: env_value(env, "LEDGER_URL")
                .unwrap_or("http://localhost:4001")
                .to_owned(),
            signer,
            fetch: Box::new(UreqFetch::new()),
        }),
    })
}

impl Wiring {
    pub fn from_env(env: &BTreeMap<String, String>) -> Result<Wiring, String> {
        let identity: Box<dyn IdentityRecovery> = match env_value(env, "IDENTITY_URL") {
            None => Box::new(identity::Unconfigured),
            Some(url) => Box::new(identity::HttpIdentity {
                base: url.to_owned(),
                signer: call_signer(env, "svc-identity")?
                    .unwrap_or_else(|| CallSigner::new("svc-bank", "svc-identity", "", None)),
                fetch: Box::new(UreqFetch::new()),
            }),
        };
        Ok(Wiring {
            identity,
            ledger: ledger_from_env(env)?,
        })
    }
}

/// `FOUNDER_DESK_SCOPES`.
const STAFF_SCOPES: [&str; 7] = [
    "admin:read",
    "admin:write",
    "admin:compliance",
    "market:ops",
    "support:ops",
    "support:lookup",
    "campaigns:ops",
];

/// `recoveryHeir`: the heir at their own keyboard, never a delegate and never staff.
pub fn recovery_heir(principal: &Principal) -> Result<String, Refusal> {
    if principal.kid.as_deref().is_some_and(|k| !k.is_empty())
        || principal
            .sub_account
            .as_deref()
            .is_some_and(|s| !s.is_empty())
    {
        return Err(refuse(
            "bank.recovery_delegated",
            "Sign in as yourself to claim an account [bank.recovery_delegated]",
        ));
    }
    if principal
        .scopes
        .iter()
        .any(|s| s.starts_with("admin:") || STAFF_SCOPES.contains(&s.as_str()))
    {
        return Err(refuse(
            "bank.recovery_staff_forbidden",
            "Staff do not claim or move customer balances [bank.recovery_staff_forbidden]",
        ));
    }
    Ok(principal.user_id.clone())
}

/// `recoveryClaimId`: a business key, so opening again answers the same claim and every sweep key is the same.
pub fn recovery_claim_id(owner_user_id: &str, notice_id: &str) -> String {
    let digest = Sha256::digest(format!(
        "bank.recovery_claim:{}:{}",
        owner_user_id.to_lowercase(),
        notice_id.to_lowercase()
    ));
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    let part = |a: usize, b: usize| hex.get(a..b).unwrap_or_default().to_owned();
    format!(
        "{}-{}-5{}-8{}-{}",
        part(0, 8),
        part(8, 12),
        part(13, 16),
        part(17, 20),
        part(20, 32)
    )
}

/// `recoveryClaimMessage`: the text every recovery key signs for one claim.
pub fn recovery_claim_message(user_id: &str, heir_user_id: &str, claim_id: &str) -> String {
    [
        "INTAFACED recovery claim v1".to_owned(),
        format!("account:{}", user_id.to_lowercase()),
        format!("heir:{}", heir_user_id.to_lowercase()),
        format!("claim:{}", claim_id.to_lowercase()),
    ]
    .join("\n")
}

/// One funded account of the owner (`RecoveryAccount`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Holding {
    pub account: AccountRef,
    pub space_id: Option<String>,
    pub space_name: Option<String>,
    pub amount: Amount,
}

/// `splitHoldings`: what a sweep moves, what stays until released, and what stops it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Holdings {
    pub sweepable: Vec<Holding>,
    pub held: Vec<Holding>,
    pub blockers: Vec<Holding>,
}

fn is_free(a: &AccountRef) -> bool {
    a.kind == "available" && a.purpose().is_empty()
}

/// `splitHoldings`.
pub fn split_holdings(all: &[Holding]) -> Holdings {
    let mut sorted = all.to_vec();
    sorted.sort_by_key(|h| h.account.key());
    let pick = |f: &dyn Fn(&Holding) -> bool| sorted.iter().filter(|h| f(h)).cloned().collect();
    Holdings {
        sweepable: pick(&|h| is_free(&h.account) && h.amount.is_positive()),
        held: pick(&|h| !is_free(&h.account) && h.amount.is_positive()),
        blockers: pick(&|h| h.amount.is_negative()),
    }
}

pub(crate) fn db<T>(
    store: &Store,
    f: impl FnOnce(&mut postgres::Client) -> Result<T, StoreError>,
) -> Result<T, Refusal> {
    store
        .pool()
        .and_then(|pool| with_client(pool, f))
        .map_err(|e| Refusal::Other(e.message))
}

/// A named space of the owner (`SpaceService.allNamedSpaces`'s id and name).
struct Space {
    id: String,
    name: String,
}

/// `SpaceService.allNamedSpaces(userId)`.
fn all_named_spaces(store: &Store, user_id: &str) -> Result<Vec<Space>, Refusal> {
    db(store, |c| {
        let rows = c.query(
            "SELECT id::text, name FROM bank.spaces WHERE user_id = $1 AND kind = 'named' \
             ORDER BY asset_id ASC, name ASC, id ASC",
            &[&user_id],
        )?;
        rows.iter()
            .map(|r| {
                Ok(Space {
                    id: r.try_get(0)?,
                    name: r.try_get(1)?,
                })
            })
            .collect()
    })
}

/// `SpaceService.ensurePrimary(userId, assetId)`: the heir's main space in the asset, made when missing.
fn ensure_primary(store: &Store, user_id: &str, asset_id: &str) -> Result<(), Refusal> {
    let found = db(store, |c| {
        let inserted = c.query(
            "INSERT INTO bank.spaces (user_id, asset_id, kind, name) VALUES ($1, $2, 'primary', 'Main') \
             ON CONFLICT DO NOTHING RETURNING id::text",
            &[&user_id, &asset_id],
        )?;
        if !inserted.is_empty() {
            return Ok(true);
        }
        let existing = c.query(
            "SELECT id::text FROM bank.spaces WHERE user_id = $1 AND asset_id = $2 AND kind = 'primary'",
            &[&user_id, &asset_id],
        )?;
        Ok(!existing.is_empty())
    })?;
    if found {
        Ok(())
    } else {
        Err(refuse(
            "bank.space_not_found",
            format!("Could not resolve the primary {asset_id} space for {user_id}"),
        ))
    }
}

/// Every funded account of the owner, read from the ledger now: their own accounts and their named spaces'.
fn holdings(d: &Deps<'_>, owner: &str) -> Result<Holdings, Refusal> {
    let ledger = d.wiring.recovery.ledger.as_ref();
    let own = ledger.balances("user", owner).map_err(Refusal::Other)?;
    let named = all_named_spaces(d.store, owner)?;
    let mut all = Vec::new();
    let mut add = |balances: Vec<ledger::Balance>, space: Option<&Space>| {
        for b in balances.into_iter().filter(|b| !b.amount.is_zero()) {
            all.push(Holding {
                account: b.account,
                space_id: space.map(|s| s.id.clone()),
                space_name: space.map(|s| s.name.clone()),
                amount: b.amount,
            });
        }
    };
    add(own, None);
    for space in &named {
        let pot = ledger
            .balances("subaccount", &space.id)
            .map_err(Refusal::Other)?;
        add(pot, Some(space));
    }
    Ok(split_holdings(&all))
}

/// The ISO instant of a timestamp column, as `Date.toISOString` writes it.
pub(crate) fn iso(column: &str) -> String {
    format!("to_char({column} AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")
}

/// One claim (`RecoveryClaimRecord`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Claim {
    id: String,
    owner_user_id: String,
    heir_user_id: String,
    notice_id: String,
    status: String,
    round: i32,
    created_at: String,
    executed_at: Option<String>,
}

fn claim_columns(prefix: &str) -> String {
    format!(
        "{p}id::text, {p}owner_user_id, {p}heir_user_id, {p}notice_id::text, {p}status, {p}round, {}, {}",
        iso(&format!("{prefix}created_at")),
        iso(&format!("{prefix}executed_at")),
        p = prefix
    )
}

fn to_claim(r: &Row) -> Result<Claim, StoreError> {
    Ok(Claim {
        id: r.try_get(0)?,
        owner_user_id: r.try_get(1)?,
        heir_user_id: r.try_get(2)?,
        notice_id: r.try_get(3)?,
        status: r.try_get(4)?,
        round: r.try_get(5)?,
        created_at: r.try_get(6)?,
        executed_at: r.try_get(7)?,
    })
}

/// One planned sweep (`RecoverySweepRecord`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Sweep {
    round: i32,
    account_key: String,
    from_owner_type: String,
    from_owner_id: String,
    asset_id: String,
    amount: Amount,
    status: String,
    ledger_tx_id: Option<String>,
    refusal_code: Option<String>,
}

const SWEEP_COLUMNS: &str = "round, account_key, from_owner_type, from_owner_id, asset_id, amount::text, \
     status, ledger_tx_id, refusal_code";

fn to_sweep(r: &Row) -> Result<Sweep, StoreError> {
    let amount: String = r.try_get(5)?;
    Ok(Sweep {
        round: r.try_get(0)?,
        account_key: r.try_get(1)?,
        from_owner_type: r.try_get(2)?,
        from_owner_id: r.try_get(3)?,
        asset_id: r.try_get(4)?,
        amount: parse_amount(&amount).map_err(|e| StoreError::new(e, None))?,
        status: r.try_get(6)?,
        ledger_tx_id: r.try_get(7)?,
        refusal_code: r.try_get(8)?,
    })
}

fn claim_for(store: &Store, owner: &str) -> Result<Option<Claim>, Refusal> {
    db(store, |c| {
        let sql = format!(
            "SELECT {} FROM bank.recovery_claims WHERE owner_user_id = $1",
            claim_columns("")
        );
        c.query(&sql, &[&owner])?.first().map(to_claim).transpose()
    })
}

fn opt(s: Option<&String>) -> Json {
    s.map_or(Json::Null, |v| Json::str(v.clone()))
}

fn account_out(h: &Holding) -> Json {
    Json::obj([
        ("ownerType", Json::str(h.account.owner_type.clone())),
        ("assetId", Json::str(h.account.asset_id.clone())),
        ("kind", Json::str(h.account.kind.clone())),
        ("spaceId", opt(h.space_id.as_ref())),
        ("spaceName", opt(h.space_name.as_ref())),
        ("amount", Json::str(format_amount(h.amount))),
    ])
}

fn claim_fields(c: &Claim) -> Vec<(String, Json)> {
    vec![
        ("claimId".to_owned(), Json::str(c.id.clone())),
        ("status".to_owned(), Json::str(c.status.clone())),
        ("round".to_owned(), Json::int(i64::from(c.round))),
        ("createdAt".to_owned(), Json::str(c.created_at.clone())),
        ("executedAt".to_owned(), opt(c.executed_at.as_ref())),
    ]
}

fn sweep_out(s: &Sweep) -> Json {
    Json::obj([
        ("round", Json::int(i64::from(s.round))),
        ("ownerType", Json::str(s.from_owner_type.clone())),
        (
            "spaceId",
            if s.from_owner_type == "subaccount" {
                Json::str(s.from_owner_id.clone())
            } else {
                Json::Null
            },
        ),
        ("assetId", Json::str(s.asset_id.clone())),
        ("amount", Json::str(format_amount(s.amount))),
        ("status", Json::str(s.status.clone())),
        ("ledgerTxId", opt(s.ledger_tx_id.as_ref())),
        ("refusalCode", opt(s.refusal_code.as_ref())),
    ])
}

fn estates(d: &Deps<'_>, heir: &str) -> Result<Json, Refusal> {
    let listed = d.wiring.recovery.identity.estates(heir)?;
    let mut out = Vec::new();
    for e in &listed {
        let claim = claim_for(d.store, &e.user_id)?.filter(|c| c.heir_user_id == heir);
        let h = holdings(d, &e.user_id)?;
        out.push(Json::obj([
            ("userId", Json::str(e.user_id.clone())),
            ("handle", Json::str(e.handle.clone())),
            ("threshold", Json::int(e.threshold)),
            ("liveKeys", Json::int(e.live_keys)),
            (
                "claim",
                claim
                    .as_ref()
                    .map_or(Json::Null, |c| Json::Object(claim_fields(c))),
            ),
            (
                "sweepable",
                Json::Array(h.sweepable.iter().map(account_out).collect()),
            ),
            (
                "held",
                Json::Array(h.held.iter().map(account_out).collect()),
            ),
            (
                "blockers",
                Json::Array(h.blockers.iter().map(account_out).collect()),
            ),
        ]));
    }
    Ok(Json::obj([("estates", Json::Array(out))]))
}

fn open(d: &Deps<'_>, heir: &str, owner: &str) -> Result<Json, Refusal> {
    let wanted = owner.to_lowercase();
    let Some(estate) = d
        .wiring
        .recovery
        .identity
        .estates(heir)?
        .into_iter()
        .find(|e| e.user_id.to_lowercase() == wanted)
    else {
        return Err(refuse(
            "bank.recovery_estate_not_found",
            "This account is not one you can claim [bank.recovery_estate_not_found]",
        ));
    };
    let id = recovery_claim_id(&estate.user_id, &estate.notice_id);
    // No conflict target: the id is a hash of the owner (and notice), so a clash on either unique key is with this
    // owner's one claim; the read-back decides.
    db(d.store, |c| {
        c.execute(
            "INSERT INTO bank.recovery_claims (id, owner_user_id, heir_user_id, notice_id) \
             VALUES ($1::text::uuid, $2, $3, $4::text::uuid) ON CONFLICT DO NOTHING",
            &[&id, &estate.user_id, &heir, &estate.notice_id],
        )?;
        Ok(())
    })?;
    let claim = claim_for(d.store, &estate.user_id)?;
    let Some(claim) = claim.filter(|c| c.id == id && c.heir_user_id == heir) else {
        return Err(refuse(
            "bank.recovery_claim_conflict",
            "This account already has a claim under another notice [bank.recovery_claim_conflict]",
        ));
    };
    let mut fields = claim_fields(&claim);
    fields.push((
        "ownerUserId".to_owned(),
        Json::str(claim.owner_user_id.clone()),
    ));
    fields.push(("handle".to_owned(), Json::str(estate.handle.clone())));
    fields.push(("threshold".to_owned(), Json::int(estate.threshold)));
    fields.push(("liveKeys".to_owned(), Json::int(estate.live_keys)));
    fields.push((
        "message".to_owned(),
        Json::str(recovery_claim_message(
            &claim.owner_user_id,
            heir,
            &claim.id,
        )),
    ));
    Ok(Json::Object(fields))
}

/// `recoveryClaimSignatureSchema`'s output, field for field, in its order.
fn signatures_of(input: &Value) -> Json {
    let rows = input.get("signatures").as_array().unwrap_or_default();
    Json::Array(
        rows.iter()
            .map(|s| {
                let k = s.get("publicKey");
                let text = |v: &Value| Json::str(v.as_str().unwrap_or_default());
                Json::obj([
                    (
                        "publicKey",
                        Json::obj([
                            ("kty", text(k.get("kty"))),
                            ("crv", text(k.get("crv"))),
                            ("x", text(k.get("x"))),
                            ("y", text(k.get("y"))),
                        ]),
                    ),
                    ("signature", text(s.get("signature"))),
                ])
            })
            .collect(),
    )
}

/// A planned round: the round, or none when there was nothing to sweep, and its rows.
struct Plan {
    round: Option<i32>,
    rows: Vec<Sweep>,
}

/// One read-committed transaction whose work may refuse: committed only when it neither fails nor refuses.
pub(crate) fn refusing_tx<T>(
    store: &Store,
    f: impl FnOnce(&mut Transaction<'_>) -> Result<Result<T, Refusal>, StoreError>,
) -> Result<T, Refusal> {
    let run = || -> Result<Result<T, Refusal>, StoreError> {
        let pool = store.pool()?;
        let mut conn = pool.get()?;
        let client = conn.client()?;
        let mut tx = client
            .build_transaction()
            .isolation_level(IsolationLevel::ReadCommitted)
            .start()?;
        let out = f(&mut tx)?;
        if out.is_ok() {
            tx.commit()?;
        }
        Ok(out)
    };
    run().map_err(|e| Refusal::Other(e.message))?
}

fn plan(d: &Deps<'_>, opened: &Claim, h: &Holdings) -> Result<Plan, Refusal> {
    refusing_tx(d.store, |tx| {
        let sql = format!(
            "SELECT {} FROM bank.recovery_claims WHERE id = $1::text::uuid FOR UPDATE",
            claim_columns("")
        );
        let row = tx.query_one(&sql, &[&opened.id])?;
        let claim = to_claim(&row)?;
        let pending = tx.query(
            &format!(
                "SELECT {SWEEP_COLUMNS} FROM bank.recovery_sweeps \
                 WHERE claim_id = $1::text::uuid AND status = 'pending' ORDER BY account_key"
            ),
            &[&claim.id],
        )?;
        if !pending.is_empty() {
            let rows = pending
                .iter()
                .map(to_sweep)
                .collect::<Result<Vec<_>, _>>()?;
            return Ok(Ok(Plan {
                round: Some(claim.round),
                rows,
            }));
        }
        // A round whose rows have all settled is done, even when the call that posted it has not moved the claim on.
        let mut round = claim.round;
        let planned: i32 = tx
            .query_one(
                "SELECT count(*)::int FROM bank.recovery_sweeps WHERE claim_id = $1::text::uuid AND round = $2",
                &[&claim.id, &round],
            )?
            .try_get(0)?;
        if planned > 0 {
            round = round.saturating_add(1);
            tx.execute(
                "UPDATE bank.recovery_claims SET round = $1 WHERE id = $2::text::uuid",
                &[&round, &claim.id],
            )?;
        }
        if !h.blockers.is_empty() {
            let mut named: Vec<String> = Vec::new();
            for b in &h.blockers {
                let n = format!("{} {}", b.account.asset_id, b.account.kind);
                if !named.contains(&n) {
                    named.push(n);
                }
            }
            return Ok(Err(refuse(
                "bank.recovery_blocked",
                format!(
                    "The account owes a debt that must be settled first ({}) [bank.recovery_blocked]",
                    named.join(", ")
                ),
            )));
        }
        if h.sweepable.is_empty() {
            return Ok(Ok(Plan {
                round: None,
                rows: Vec::new(),
            }));
        }
        let mut rows = Vec::new();
        for item in &h.sweepable {
            let from = AccountRef::available(
                &item.account.owner_type,
                &item.account.owner_id,
                &item.account.asset_id,
            );
            let key = from.key();
            let idempotency_key = format!("bank.transfer.recovery:{}:{key}:{round}", claim.id);
            let inserted = tx.query_one(
                &format!(
                    "INSERT INTO bank.recovery_sweeps \
                     (claim_id, round, account_key, from_owner_type, from_owner_id, asset_id, amount, idempotency_key) \
                     VALUES ($1::text::uuid, $2, $3, $4, $5, $6, $7::text::numeric, $8) RETURNING {SWEEP_COLUMNS}"
                ),
                &[
                    &claim.id,
                    &round,
                    &key,
                    &from.owner_type,
                    &from.owner_id,
                    &from.asset_id,
                    &format_amount(item.amount),
                    &idempotency_key,
                ],
            )?;
            rows.push(to_sweep(&inserted)?);
        }
        Ok(Ok(Plan {
            round: Some(round),
            rows,
        }))
    })
}

fn execute(d: &Deps<'_>, heir: &str, input: &Value) -> Result<Json, Refusal> {
    let w = &d.wiring.recovery;
    let claim_id = input.get("claimId").as_str().unwrap_or_default().to_owned();
    let found = db(d.store, |c| {
        let sql = format!(
            "SELECT {} FROM bank.recovery_claims WHERE id = $1::text::uuid AND heir_user_id = $2",
            claim_columns("")
        );
        c.query(&sql, &[&claim_id, &heir])?
            .first()
            .map(to_claim)
            .transpose()
    })?;
    let Some(opened) = found else {
        return Err(refuse(
            "bank.recovery_claim_not_found",
            "No claim by that id is yours [bank.recovery_claim_not_found]",
        ));
    };
    let request = Json::obj([
        ("userId", Json::str(opened.owner_user_id.clone())),
        ("heirUserId", Json::str(heir)),
        ("claimId", Json::str(opened.id.clone())),
        ("signatures", signatures_of(input)),
    ]);
    match w.identity.verify(&request)? {
        Verdict::Refused { code } => {
            return Err(refuse(
                "bank.recovery_claim_refused",
                format!("The recovery keys did not claim this account [{code}]"),
            ));
        }
        Verdict::Ok { notice_id }
            if notice_id.to_lowercase() != opened.notice_id.to_lowercase() =>
        {
            return Err(refuse(
                "bank.recovery_claim_refused",
                "The account changed since this claim was opened [identity.recovery_account_changed]",
            ));
        }
        Verdict::Ok { .. } => {}
    }

    // Plan: the ledger is read outside the claim's lock; value that arrives after the read goes to the next round.
    let h = holdings(d, &opened.owner_user_id)?;
    let planned = plan(d, &opened, &h)?;

    // Post: each row once, with the key it was planned under. The heir's main account in each asset exists first.
    let mut assets: Vec<&str> = Vec::new();
    for r in &planned.rows {
        if !assets.contains(&r.asset_id.as_str()) {
            assets.push(&r.asset_id);
        }
    }
    for asset in assets {
        ensure_primary(d.store, heir, asset)?;
    }
    for sweep in &planned.rows {
        let from = AccountRef::available(
            &sweep.from_owner_type,
            &sweep.from_owner_id,
            &sweep.asset_id,
        );
        let posted = w.ledger.bank_transfer(&BankTransfer {
            transfer_id: format!("{}:{}", opened.id, from.key()),
            occurrence: i64::from(sweep.round),
            to: AccountRef::available("user", heir, &sweep.asset_id),
            from,
            amount: sweep.amount,
            key_space: "recovery",
        });
        let settle = |status: &str, tx_id: Option<&str>, code: Option<&str>| {
            db(d.store, |c| {
                c.execute(
                    "UPDATE bank.recovery_sweeps SET status = $1, ledger_tx_id = $2, refusal_code = $3, settled_at = now() \
                     WHERE claim_id = $4::text::uuid AND round = $5 AND account_key = $6 AND status = 'pending'",
                    &[&status, &tx_id, &code, &opened.id, &sweep.round, &sweep.account_key],
                )?;
                Ok(())
            })
        };
        match posted {
            Ok(tx_id) => settle("posted", Some(&tx_id), None)?,
            Err(PostError::Ledger { code, .. })
                if DEFINITE_POST_REFUSALS.contains(&code.as_str()) =>
            {
                settle("refused", None, Some(&code))?;
            }
            Err(PostError::Ledger { code, message }) => {
                return Err(Refusal::Other(format!("{message} [{code}]")));
            }
            Err(PostError::Other(message)) => return Err(Refusal::Other(message)),
        }
    }

    // Settle: a round with nothing pending is done, and the next call plans the next one.
    let claim = refusing_tx(d.store, |tx| {
        let row = tx.query_one(
            &format!(
                "SELECT {} FROM bank.recovery_claims WHERE id = $1::text::uuid FOR UPDATE",
                claim_columns("")
            ),
            &[&opened.id],
        )?;
        let current = to_claim(&row)?;
        let left: i32 = tx
            .query_one(
                "SELECT count(*)::int FROM bank.recovery_sweeps WHERE claim_id = $1::text::uuid AND status = 'pending'",
                &[&opened.id],
            )?
            .try_get(0)?;
        if left > 0 {
            return Ok(Ok(current));
        }
        let next = if planned.round == Some(current.round) {
            current.round.saturating_add(1)
        } else {
            current.round
        };
        // Executed means value moved: a claim whose rounds swept nothing stays open.
        let done = tx.query_one(
            &format!(
                "UPDATE bank.recovery_claims c \
                    SET round = $1, \
                        status = CASE WHEN p.any THEN 'executed' ELSE c.status END, \
                        executed_at = CASE WHEN p.any THEN coalesce(c.executed_at, now()) ELSE c.executed_at END \
                   FROM (SELECT EXISTS (SELECT 1 FROM bank.recovery_sweeps \
                          WHERE claim_id = $2::text::uuid AND status = 'posted') AS any) p \
                  WHERE c.id = $2::text::uuid RETURNING {}",
                claim_columns("c.")
            ),
            &[&next, &opened.id],
        )?;
        Ok(Ok(to_claim(&done)?))
    })?;

    let sweeps = match planned.round {
        None => Vec::new(),
        Some(round) => db(d.store, |c| {
            c.query(
                &format!(
                    "SELECT {SWEEP_COLUMNS} FROM bank.recovery_sweeps \
                     WHERE claim_id = $1::text::uuid AND round = $2 ORDER BY account_key"
                ),
                &[&opened.id, &round],
            )?
            .iter()
            .map(to_sweep)
            .collect::<Result<Vec<_>, _>>()
        })?,
    };
    Ok(Json::obj([
        ("claim", Json::Object(claim_fields(&claim))),
        (
            "round",
            planned
                .round
                .map_or(Json::Null, |r| Json::int(i64::from(r))),
        ),
        (
            "sweeps",
            Json::Array(sweeps.iter().map(sweep_out).collect()),
        ),
    ]))
}

/// The answer of one of this part's calls, by its path; `None` for a path outside it.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let path = ctx.call.path;
    if !matches!(
        path,
        "recovery.estates" | "recovery.claims.open" | "recovery.claims.execute"
    ) {
        return None;
    }
    let Some(principal) = ctx.principal else {
        return Some(Err(Refusal::Other("no principal".to_owned())));
    };
    Some((|| {
        let heir = recovery_heir(principal)?;
        match path {
            "recovery.estates" => estates(d, &heir),
            "recovery.claims.open" => open(
                d,
                &heir,
                ctx.input.get("ownerUserId").as_str().unwrap_or_default(),
            ),
            _ => {
                // Nothing is read or written while no svc-ledger post door is wired (PORT.md, "The ledger").
                if !d.wiring.recovery.ledger.posts() {
                    return Err(Refusal::Trpc(not_ported(Slice::PartnerAccount)));
                }
                execute(d, &heir, &ctx.input)
            }
        }
    })())
}

/// This part has no job door.
pub fn job(_d: &Deps<'_>, _path: &str, _body: &Value) -> Option<Response> {
    None
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    fn principal(scopes: &[&str], kid: Option<&str>) -> Principal {
        Principal {
            user_id: "u".to_owned(),
            scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
            tier: "full".to_owned(),
            mfa: true,
            kid: kid.map(str::to_owned),
            sub_account: None,
            sid: "s".to_owned(),
            fam: None,
            dev: None,
        }
    }

    fn code(r: Result<String, Refusal>) -> String {
        match r {
            Ok(u) => u,
            Err(Refusal::Bank(e)) => e.row.code.to_owned(),
            Err(other) => format!("{other:?}"),
        }
    }

    #[test]
    fn only_the_heir_at_their_own_keyboard_may_claim() {
        assert_eq!(code(recovery_heir(&principal(&["bank:write"], None))), "u");
        assert_eq!(
            code(recovery_heir(&principal(&["bank:write"], Some("k1")))),
            "bank.recovery_delegated"
        );
        for staff in ["admin:anything", "support:ops", "campaigns:ops"] {
            assert_eq!(
                code(recovery_heir(&principal(&["bank:write", staff], None))),
                "bank.recovery_staff_forbidden"
            );
        }
    }

    #[test]
    fn the_claim_id_is_a_version_5_shaped_hash_of_the_owner_and_notice() {
        let a = recovery_claim_id("AAAA", "N");
        assert_eq!(a, recovery_claim_id("aaaa", "n"));
        assert!(identity::is_guid(&a));
        assert_eq!(a.get(14..15), Some("5"));
        assert_eq!(a.get(19..20), Some("8"));
        assert_ne!(a, recovery_claim_id("aaaa", "m"));
    }

    #[test]
    fn holdings_split_into_free_held_and_debts_in_account_key_order() {
        let h = |kind: &str, purpose: Option<&str>, asset: &str, amount: Amount| Holding {
            account: AccountRef {
                owner_type: "user".to_owned(),
                owner_id: "o".to_owned(),
                asset_id: asset.to_owned(),
                kind: kind.to_owned(),
                purpose: purpose.map(str::to_owned),
            },
            space_id: None,
            space_name: None,
            amount,
        };
        let split = split_holdings(&[
            h("available", None, "USDC", Amount::from_scaled(5)),
            h("available", None, "BTC", Amount::from_scaled(2)),
            h("hold", Some("order:1"), "BTC", Amount::from_scaled(1)),
            h("available", Some("x"), "EUR", Amount::from_scaled(3)),
            h("available", None, "ETH", Amount::from_scaled(-4)),
        ]);
        let assets = |l: &[Holding]| {
            l.iter()
                .map(|x| x.account.asset_id.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(assets(&split.sweepable), ["BTC", "USDC"]);
        assert_eq!(assets(&split.held), ["BTC", "EUR"]);
        assert_eq!(assets(&split.blockers), ["ETH"]);
    }
}
