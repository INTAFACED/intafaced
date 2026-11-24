//! The step-up on money out (`step-up/step-up-gate.ts`, `step-up/step-up-store.ts`, `step-up/money-out-fields.ts`,
//! `router/context.ts` `requireStepUp`): a send to another person needs a fresh approval of the person's own, consumed
//! once at svc-identity and bound to the door's fields. `BANK_STEP_UP_MONEY_OUT=off` (the default) makes it a no-op.

use std::collections::BTreeMap;
use std::sync::Mutex;

use postgres::GenericClient;
use service_kit::approvals::{ConsumeError, ConsumeInput, PrincipalBinding};
use service_kit::edge::Principal;
use service_kit::json::Json;
use service_kit::schema::js_trim;
use service_kit::time::{Instant, zod_datetime};
use sha2::{Digest, Sha256};

use super::{Approvals, Deps};
use crate::db::Store;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{at, pg, with};

/// `DoorBinding`: what an approval is bound to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub action_type: &'static str,
    /// In the TypeScript object's key order.
    pub fields: Vec<(String, String)>,
    pub operation_key: String,
}

fn fields(pairs: &[(&str, Option<&str>)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .filter_map(|(k, v)| v.map(|v| ((*k).to_owned(), v.to_owned())))
        .collect()
}

/// A field the TypeScript spreads in only when it is set and not empty.
fn some(v: Option<&str>) -> Option<&str> {
    v.filter(|s| !s.is_empty())
}

/// `toUserBinding`.
pub struct ToUser<'a> {
    pub actor: &'a str,
    pub transfer_id: &'a str,
    pub from_space_id: &'a str,
    pub to_user_id: &'a str,
    pub asset_id: &'a str,
    pub amount: &'a str,
    pub note: Option<&'a str>,
    pub reference: Option<&'a str>,
    pub request_id: Option<&'a str>,
}

pub fn to_user_binding(i: &ToUser<'_>) -> Binding {
    Binding {
        action_type: "bank.step_up.transfers.toUser",
        operation_key: i.transfer_id.to_owned(),
        fields: fields(&[
            ("actor", Some(i.actor)),
            ("transferId", Some(i.transfer_id)),
            ("fromSpaceId", Some(i.from_space_id)),
            ("toUserId", Some(i.to_user_id)),
            ("assetId", Some(i.asset_id)),
            ("amount", Some(i.amount)),
            ("note", some(i.note)),
            ("reference", some(i.reference)),
            ("requestId", some(i.request_id)),
        ]),
    }
}

/// `createTransferBinding`.
pub struct CreateTransfer<'a> {
    pub actor: &'a str,
    pub transfer_id: &'a str,
    pub from_space_id: &'a str,
    pub to_space_id: &'a str,
    pub asset_id: &'a str,
    pub amount: &'a str,
    pub note: Option<&'a str>,
    pub reference: Option<&'a str>,
}

pub fn create_transfer_binding(i: &CreateTransfer<'_>) -> Binding {
    Binding {
        action_type: "bank.step_up.transfers.create",
        operation_key: i.transfer_id.to_owned(),
        fields: fields(&[
            ("actor", Some(i.actor)),
            ("transferId", Some(i.transfer_id)),
            ("fromSpaceId", Some(i.from_space_id)),
            ("toSpaceId", Some(i.to_space_id)),
            ("assetId", Some(i.asset_id)),
            ("amount", Some(i.amount)),
            ("note", some(i.note)),
            ("reference", some(i.reference)),
        ]),
    }
}

/// `ScheduleCommon`, with the payee: another person (`toUserId`) or a space (`toSpaceId`).
pub struct Schedule<'a> {
    pub actor: &'a str,
    pub schedule_id: &'a str,
    pub from_space_id: &'a str,
    pub asset_id: &'a str,
    pub amount: &'a str,
    pub cadence: &'a str,
    pub starts_at: &'a str,
    pub ends_at: Option<&'a str>,
}

fn schedule_fields(i: &Schedule<'_>, payee: (&str, &str)) -> Vec<(String, String)> {
    fields(&[
        ("actor", Some(i.actor)),
        ("scheduleId", Some(i.schedule_id)),
        ("fromSpaceId", Some(i.from_space_id)),
        (payee.0, Some(payee.1)),
        ("assetId", Some(i.asset_id)),
        ("amount", Some(i.amount)),
        ("cadence", Some(i.cadence)),
        ("startsAt", Some(i.starts_at)),
        ("endsAt", Some(i.ends_at.unwrap_or(""))),
    ])
}

/// `scheduleToUserBinding`.
pub fn schedule_to_user_binding(i: &Schedule<'_>, to_user_id: &str) -> Binding {
    Binding {
        action_type: "bank.step_up.transfers.scheduleToUser",
        operation_key: i.schedule_id.to_owned(),
        fields: schedule_fields(i, ("toUserId", to_user_id)),
    }
}

/// `scheduleBinding`.
pub fn schedule_binding(i: &Schedule<'_>, to_space_id: &str) -> Binding {
    Binding {
        action_type: "bank.step_up.transfers.schedule",
        operation_key: i.schedule_id.to_owned(),
        fields: schedule_fields(i, ("toSpaceId", to_space_id)),
    }
}

/// `scheduleEditBinding`.
pub fn schedule_edit_binding(i: &Schedule<'_>, to_space_id: &str, revision: i64) -> Binding {
    Binding {
        operation_key: format!("{}:edit:{revision}", i.schedule_id),
        ..schedule_binding(i, to_space_id)
    }
}

/// `bankActionPayloadHash`: `sha256:` over `{"actionType", "fields"}`, the fields in sorted key order.
pub fn payload_hash(action_type: &str, fields: &[(String, String)]) -> String {
    let mut sorted: Vec<&(String, String)> = fields.iter().collect();
    sorted.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    let mut copy: Vec<(String, Json)> = Vec::new();
    for (k, v) in sorted {
        match copy.iter_mut().find(|(key, _)| key == k) {
            Some(slot) => slot.1 = Json::str(v.clone()),
            None => copy.push((k.clone(), Json::str(v.clone()))),
        }
    }
    let payload = Json::Object(vec![
        ("actionType".to_owned(), Json::str(action_type)),
        (
            "fields".to_owned(),
            Json::Object(service_kit::json::js_key_order(copy)),
        ),
    ])
    .compact();
    let digest = Sha256::digest(payload.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("sha256:{hex}")
}

/// `StepUpUse`: which operation spent an approval.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepUpUse {
    pub approval_id: String,
    pub user_id: String,
    pub session_id: String,
    pub action_type: String,
    pub payload_hash: String,
    pub operation_key: String,
    pub expires_at: Instant,
}

/// `StepUpUseStore`.
pub trait UseStore {
    fn get(&self, approval_id: &str) -> Result<Option<StepUpUse>, Refusal>;
    /// Records the use, or answers the one already recorded under the approval (the first writer wins).
    fn record(&self, use_: &StepUpUse) -> Result<StepUpUse, Refusal>;
}

/// `MemoryStepUpUseStore`.
#[derive(Default)]
pub struct MemoryUses(Mutex<BTreeMap<String, StepUpUse>>);

impl UseStore for MemoryUses {
    fn get(&self, approval_id: &str) -> Result<Option<StepUpUse>, Refusal> {
        let rows = self.0.lock().map_err(|e| Refusal::Other(e.to_string()))?;
        Ok(rows.get(approval_id).cloned())
    }
    fn record(&self, use_: &StepUpUse) -> Result<StepUpUse, Refusal> {
        let mut rows = self.0.lock().map_err(|e| Refusal::Other(e.to_string()))?;
        Ok(rows
            .entry(use_.approval_id.clone())
            .or_insert_with(|| use_.clone())
            .clone())
    }
}

/// `SqlStepUpUseStore` on `bank.step_up_uses`.
pub struct SqlUses<'a>(pub &'a Store);

const USE_COLS: &str = "approval_id, user_id, session_id, action_type, payload_hash, operation_key, \
     floor(extract(epoch from expires_at) * 1000)::int8";

fn use_of(r: &postgres::Row) -> Result<StepUpUse, Refusal> {
    let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
    Ok(StepUpUse {
        approval_id: s(0)?,
        user_id: s(1)?,
        session_id: s(2)?,
        action_type: s(3)?,
        payload_hash: s(4)?,
        operation_key: s(5)?,
        expires_at: Instant(r.try_get::<_, i64>(6).map_err(|e| pg(&e))?),
    })
}

fn get_use(c: &mut impl GenericClient, approval_id: &str) -> Result<Option<StepUpUse>, Refusal> {
    let rows = c
        .query(
            &format!("SELECT {USE_COLS} FROM bank.step_up_uses WHERE approval_id = $1 LIMIT 1"),
            &[&approval_id],
        )
        .map_err(|e| pg(&e))?;
    rows.first().map(use_of).transpose()
}

impl UseStore for SqlUses<'_> {
    fn get(&self, approval_id: &str) -> Result<Option<StepUpUse>, Refusal> {
        with(self.0, |c| get_use(c, approval_id))
    }
    fn record(&self, u: &StepUpUse) -> Result<StepUpUse, Refusal> {
        with(self.0, |c| {
            let rows = c
                .query(
                    &format!(
                        "INSERT INTO bank.step_up_uses \
                         (approval_id, user_id, session_id, action_type, payload_hash, operation_key, expires_at) \
                         VALUES ($1, $2, $3, $4, $5, $6, {}) ON CONFLICT (approval_id) DO NOTHING \
                         RETURNING {USE_COLS}",
                        at("$7")
                    ),
                    &[
                        &u.approval_id,
                        &u.user_id,
                        &u.session_id,
                        &u.action_type,
                        &u.payload_hash,
                        &u.operation_key,
                        &u.expires_at.0,
                    ],
                )
                .map_err(|e| pg(&e))?;
            if let Some(r) = rows.first() {
                return use_of(r);
            }
            get_use(c, &u.approval_id)?
                .ok_or_else(|| Refusal::Other("step_up_uses: conflict without a row".to_owned()))
        })
    }
}

/// `StepUpRequest`.
pub struct Request<'a> {
    pub user_id: &'a str,
    pub session_id: &'a str,
    pub binding: &'a Binding,
    pub approval_id: Option<&'a str>,
    pub replay: bool,
}

const FRESH: &str = "A fresh confirmation is required. Confirm again.";
const USED: &str = "This approval was already used. Confirm again.";
const MISMATCH: &str = "The approval was for different details. Confirm again.";

/// `IDENTITY_CODE`: the first `[action_approval.<lower and _>]` in identity's refusal.
fn identity_code(message: &str) -> Option<&str> {
    let mut rest = message;
    while let Some(i) = rest.find("[action_approval.") {
        let tail = rest.get(i + 1..)?;
        let name_len = tail
            .get("action_approval.".len()..)?
            .bytes()
            .take_while(|b| b.is_ascii_lowercase() || *b == b'_')
            .count();
        let end = "action_approval.".len() + name_len;
        if name_len > 0 && tail.as_bytes().get(end) == Some(&b']') {
            return tail.get(..end);
        }
        rest = tail;
    }
    None
}

/// `refuseFromConsumeFailure`: identity's own code in the refusal, else unavailable.
fn consume_failure(err: &ConsumeError) -> Refusal {
    if let ConsumeError::Refused(message) = err {
        match identity_code(message) {
            Some("action_approval.consumed") => return refuse("bank.step_up_used", USED),
            Some("action_approval.payload_mismatch" | "action_approval.target_mismatch") => {
                return refuse("bank.step_up_mismatch", MISMATCH);
            }
            Some(
                "action_approval.expired"
                | "action_approval.not_found"
                | "action_approval.not_approved"
                | "action_approval.not_pending"
                | "action_approval.already_terminal"
                | "action_approval.not_requester"
                | "action_approval.service_mismatch",
            ) => return refuse("bank.step_up_required", FRESH),
            _ => {}
        }
    }
    refuse(
        "bank.step_up_unavailable",
        "Confirmation could not be checked right now. Nothing was sent. Try again shortly.",
    )
}

/// `createStepUpGate`'s `require`.
pub struct Gate<'a> {
    /// The mode is `required`; `off` lets everything through.
    pub required: bool,
    pub approvals: &'a dyn Approvals,
    pub store: &'a dyn UseStore,
    pub now: Instant,
}

impl Gate<'_> {
    pub fn require(&self, req: &Request<'_>) -> Result<(), Refusal> {
        if !self.required {
            return Ok(());
        }
        let approval_id = js_trim(req.approval_id.unwrap_or(""));
        if approval_id.is_empty() {
            return Err(refuse(
                "bank.step_up_required",
                "This needs a fresh confirmation (passkey or authenticator code).",
            ));
        }
        let b = req.binding;
        let hash = payload_hash(b.action_type, &b.fields);
        if let Some(earlier) = self.store.get(approval_id)? {
            if earlier.user_id != req.user_id
                || earlier.session_id != req.session_id
                || earlier.action_type != b.action_type
            {
                return Err(refuse("bank.step_up_required", FRESH));
            }
            if earlier.payload_hash != hash {
                return Err(refuse("bank.step_up_mismatch", MISMATCH));
            }
            if req.replay
                && earlier.operation_key == b.operation_key
                && self.now.0 < earlier.expires_at.0
            {
                return Ok(());
            }
            return Err(refuse("bank.step_up_used", USED));
        }
        let input = ConsumeInput {
            approval_id,
            operation_id: approval_id,
            payload_hash: &hash,
            target_service: "svc-bank",
            target_id: b.action_type,
            expected_version: "1",
            replay: None,
        };
        let who = PrincipalBinding {
            user_id: req.user_id,
            session_id: req.session_id,
        };
        let (consumed, facts) = self
            .approvals
            .consume(&input, Some(who))
            .map_err(|e| consume_failure(&e))?;
        // Identity already enforced this; a second look costs nothing and survives a misconfigured stub.
        if facts.kind.as_deref() != Some("same_person")
            || consumed.requester_id != req.user_id
            || consumed.approver_id.as_deref() != Some(req.user_id)
        {
            return Err(refuse("bank.step_up_required", FRESH));
        }
        let expires_at = zod_datetime(&facts.expires_at, true)
            .ok_or_else(|| Refusal::Other("Invalid time value".to_owned()))?;
        let winner = self.store.record(&StepUpUse {
            approval_id: approval_id.to_owned(),
            user_id: req.user_id.to_owned(),
            session_id: req.session_id.to_owned(),
            action_type: b.action_type.to_owned(),
            payload_hash: hash.clone(),
            operation_key: b.operation_key.clone(),
            expires_at,
        })?;
        if winner.session_id != req.session_id
            || winner.operation_key != b.operation_key
            || winner.payload_hash != hash
        {
            return Err(refuse("bank.step_up_used", USED));
        }
        Ok(())
    }
}

/// `stepUpEnforced`: the gate's mode is `required`.
pub fn enforced(d: &Deps<'_>) -> bool {
    d.w.settings.step_up_required
}

/// `requireStepUp(principal, binding, approvalId, replay = true)`: the money-out gate, its uses on `bank.step_up_uses`.
pub fn require(
    d: &Deps<'_>,
    principal: &Principal,
    binding: &Binding,
    approval_id: Option<&str>,
) -> Result<(), Refusal> {
    require_with(d, principal, binding, approval_id, true)
}

/// `requireStepUp` with its `replay` argument.
pub fn require_with(
    d: &Deps<'_>,
    principal: &Principal,
    binding: &Binding,
    approval_id: Option<&str>,
    replay: bool,
) -> Result<(), Refusal> {
    Gate {
        required: enforced(d),
        approvals: d.w.approvals.as_ref(),
        store: &SqlUses(d.store),
        now: d.now,
    }
    .require(&Request {
        user_id: &principal.user_id,
        session_id: &principal.sid,
        binding,
        approval_id,
        replay,
    })
}

#[cfg(test)]
mod tests {
    //! The gate checks of `step-up/step-up-money-out.test.ts` ("flag required: sends to other users"), driven on the gate
    //! with a memory store and a faithful stand-in for identity's same-person consume. The door-level halves (the
    //! service is never reached) are `transfers.toUser`'s, with `personal`.
    #![allow(clippy::unwrap_used, clippy::panic, reason = "a test")]

    use service_kit::approvals::{Consumed, Facts};

    use super::*;

    const USER: &str = "11111111-1111-4111-8111-111111111111";
    const OTHER: &str = "99999999-9999-4999-8999-999999999999";
    const SID: &str = "22222222-2222-4222-8222-222222222222";
    const SID2: &str = "23232323-2222-4222-8222-222222222222";
    const FROM: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const TRANSFER: &str = "transfer-0001";
    const TRANSFER_2: &str = "transfer-0002";
    const TO_USER: &str = "bank.step_up.transfers.toUser";

    struct Row {
        user_id: String,
        session_id: String,
        action_type: String,
        hash: String,
        expires_at: i64,
        consumed: bool,
        four_eyes: bool,
    }

    /// `FakeIdentity`: CAS once, user + session + hash + expiry.
    #[derive(Default)]
    struct FakeIdentity {
        now: Mutex<i64>,
        down: Mutex<bool>,
        calls: Mutex<usize>,
        rows: Mutex<BTreeMap<String, Row>>,
    }

    struct Approve<'a> {
        user_id: &'a str,
        session_id: &'a str,
        ttl_ms: i64,
        four_eyes: bool,
    }

    const DEFAULT: Approve<'static> = Approve {
        user_id: USER,
        session_id: SID,
        ttl_ms: 300_000,
        four_eyes: false,
    };

    impl FakeIdentity {
        fn new() -> FakeIdentity {
            let f = FakeIdentity::default();
            *f.now.lock().unwrap() = 1_000_000;
            f
        }

        fn approve(&self, action: &str, fields: &[(String, String)], o: &Approve<'_>) -> String {
            let id = format!("approval-{}", self.rows.lock().unwrap().len() + 1);
            self.rows.lock().unwrap().insert(
                id.clone(),
                Row {
                    user_id: o.user_id.to_owned(),
                    session_id: o.session_id.to_owned(),
                    action_type: action.to_owned(),
                    hash: payload_hash(action, fields),
                    expires_at: *self.now.lock().unwrap() + o.ttl_ms,
                    consumed: false,
                    four_eyes: o.four_eyes,
                },
            );
            id
        }
    }

    impl Approvals for FakeIdentity {
        fn consume(
            &self,
            input: &ConsumeInput<'_>,
            principal: Option<PrincipalBinding<'_>>,
        ) -> Result<(Consumed, Facts), ConsumeError> {
            *self.calls.lock().unwrap() += 1;
            if *self.down.lock().unwrap() {
                return Err(ConsumeError::Thrown("fetch failed".to_owned()));
            }
            let refused = |code: &str| {
                Err(ConsumeError::Refused(format!(
                    "identity refused consume (412) {{\"message\":\"x [action_approval.{code}]\"}}"
                )))
            };
            let now = *self.now.lock().unwrap();
            let mut rows = self.rows.lock().unwrap();
            let Some(row) = rows.get_mut(input.approval_id) else {
                return refused("not_found");
            };
            if now >= row.expires_at {
                return refused("expired");
            }
            if input.target_service != "svc-bank"
                || input.target_id != row.action_type
                || input.operation_id != input.approval_id
            {
                return refused("target_mismatch");
            }
            if row.hash != input.payload_hash {
                return refused("payload_mismatch");
            }
            let p = principal.unwrap();
            if !row.four_eyes && (row.user_id != p.user_id || row.session_id != p.session_id) {
                return refused("not_requester");
            }
            if row.four_eyes {
                return refused("target_mismatch");
            }
            if row.consumed {
                return refused("consumed");
            }
            row.consumed = true;
            Ok((
                Consumed {
                    action_type: row.action_type.clone(),
                    target_service: "svc-bank".to_owned(),
                    target_id: input.target_id.to_owned(),
                    status: "CONSUMED".to_owned(),
                    requester_id: row.user_id.clone(),
                    approver_id: Some(row.user_id.clone()),
                    approver_is_founder: None,
                    requester_is_founder: None,
                },
                Facts {
                    kind: Some("same_person".to_owned()),
                    expires_at: Instant(row.expires_at).iso(),
                },
            ))
        }
    }

    fn to_user(transfer: &str, to: &str, amount: &str, asset: &str) -> Binding {
        to_user_binding(&ToUser {
            actor: USER,
            transfer_id: transfer,
            from_space_id: FROM,
            to_user_id: to,
            asset_id: asset,
            amount,
            note: None,
            reference: None,
            request_id: None,
        })
    }

    fn base() -> Binding {
        to_user(TRANSFER, OTHER, "5", "USDT")
    }

    fn code(r: Result<(), Refusal>) -> String {
        match r {
            Err(Refusal::Bank(e)) => e.row.code.to_owned(),
            other => panic!("not a bank refusal: {other:?}"),
        }
    }

    struct Fixture {
        identity: FakeIdentity,
        store: MemoryUses,
    }

    impl Fixture {
        fn new() -> Fixture {
            Fixture {
                identity: FakeIdentity::new(),
                store: MemoryUses::default(),
            }
        }

        fn require(&self, b: &Binding, sid: &str, approval: Option<&str>) -> Result<(), Refusal> {
            let now = Instant(*self.identity.now.lock().unwrap());
            Gate {
                required: true,
                approvals: &self.identity,
                store: &self.store,
                now,
            }
            .require(&Request {
                user_id: USER,
                session_id: sid,
                binding: b,
                approval_id: approval,
                replay: true,
            })
        }
    }

    #[test]
    fn pins_the_exact_fields_a_client_hashes_for_transfers_to_user() {
        let b = base();
        assert_eq!(b.action_type, TO_USER);
        assert_eq!(b.operation_key, TRANSFER);
        let keys: Vec<&str> = b.fields.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            keys,
            [
                "actor",
                "transferId",
                "fromSpaceId",
                "toUserId",
                "assetId",
                "amount"
            ]
        );
    }

    #[test]
    fn adds_a_note_and_reference_to_the_hash_only_when_the_transfer_carries_them() {
        let b = to_user_binding(&ToUser {
            actor: USER,
            transfer_id: TRANSFER,
            from_space_id: FROM,
            to_user_id: OTHER,
            asset_id: "USDT",
            amount: "5",
            note: Some("October rent"),
            reference: Some("INV-9"),
            request_id: None,
        });
        assert_eq!(b.fields.len(), 8);
        assert_eq!(b.fields[6], ("note".to_owned(), "October rent".to_owned()));
        assert_eq!(b.fields[7], ("reference".to_owned(), "INV-9".to_owned()));
        let empty = to_user_binding(&ToUser {
            note: Some(""),
            ..ToUser {
                actor: USER,
                transfer_id: TRANSFER,
                from_space_id: FROM,
                to_user_id: OTHER,
                asset_id: "USDT",
                amount: "5",
                note: None,
                reference: None,
                request_id: None,
            }
        });
        assert_eq!(empty.fields.len(), 6);
    }

    #[test]
    fn the_hash_is_the_typescripts_sorted_fields_under_the_action_type() {
        // JSON.stringify({actionType, fields: sorted}) for these fields, hashed with node:crypto.
        let fields = vec![
            ("transferId".to_owned(), "t-1".to_owned()),
            ("amount".to_owned(), "5".to_owned()),
        ];
        let payload = r#"{"actionType":"bank.step_up.transfers.toUser","fields":{"amount":"5","transferId":"t-1"}}"#;
        let digest = Sha256::digest(payload.as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(payload_hash(TO_USER, &fields), format!("sha256:{hex}"));
    }

    #[test]
    fn refuses_without_an_approval_and_never_asks_identity() {
        let f = Fixture::new();
        assert_eq!(code(f.require(&base(), SID, None)), "bank.step_up_required");
        assert_eq!(
            code(f.require(&base(), SID, Some("  "))),
            "bank.step_up_required"
        );
        assert_eq!(*f.identity.calls.lock().unwrap(), 0);
    }

    #[test]
    fn accepts_an_approval_for_exactly_this_payload_then_replays_the_same_transfer_id_without_asking_identity_again()
     {
        let f = Fixture::new();
        let id = f.identity.approve(TO_USER, &base().fields, &DEFAULT);
        f.require(&base(), SID, Some(&id)).unwrap();
        f.require(&base(), SID, Some(&id)).unwrap();
        assert_eq!(*f.identity.calls.lock().unwrap(), 1);
    }

    #[test]
    fn a_different_amount_payee_or_transfer_id_than_the_one_approved_is_a_mismatch() {
        for changed in [
            to_user(TRANSFER, OTHER, "6", "USDT"),
            to_user(TRANSFER, "someone-else", "5", "USDT"),
            to_user(TRANSFER_2, OTHER, "5", "USDT"),
        ] {
            let f = Fixture::new();
            let id = f.identity.approve(TO_USER, &base().fields, &DEFAULT);
            assert_eq!(
                code(f.require(&changed, SID, Some(&id))),
                "bank.step_up_mismatch"
            );
        }
    }

    #[test]
    fn a_different_asset_is_a_mismatch() {
        let f = Fixture::new();
        let eur = to_user(TRANSFER, OTHER, "5", "EUR");
        let id = f.identity.approve(TO_USER, &eur.fields, &DEFAULT);
        assert_eq!(
            code(f.require(&base(), SID, Some(&id))),
            "bank.step_up_mismatch"
        );
    }

    #[test]
    fn another_session_of_the_same_user_cannot_replay_a_spent_approval_even_for_the_same_transfer()
    {
        let f = Fixture::new();
        let id = f.identity.approve(TO_USER, &base().fields, &DEFAULT);
        f.require(&base(), SID, Some(&id)).unwrap();
        assert_eq!(
            code(f.require(&base(), SID2, Some(&id))),
            "bank.step_up_required"
        );
    }

    #[test]
    fn a_timeout_or_an_unreachable_identity_is_unavailable() {
        let f = Fixture::new();
        let id = f.identity.approve(TO_USER, &base().fields, &DEFAULT);
        *f.identity.down.lock().unwrap() = true;
        assert_eq!(
            code(f.require(&base(), SID, Some(&id))),
            "bank.step_up_unavailable"
        );
        let unwired = Gate {
            required: true,
            approvals: &super::super::NoApprovals,
            store: &f.store,
            now: Instant(0),
        };
        let r = unwired.require(&Request {
            user_id: USER,
            session_id: SID,
            binding: &base(),
            approval_id: Some(&id),
            replay: true,
        });
        let Err(Refusal::Bank(e)) = r else { panic!() };
        assert_eq!(e.row.code, "bank.step_up_unavailable");
        assert_eq!(e.row.trpc, "SERVICE_UNAVAILABLE");
    }

    #[test]
    fn a_spent_approval_cannot_pay_a_different_transfer() {
        let f = Fixture::new();
        let id = f.identity.approve(TO_USER, &base().fields, &DEFAULT);
        f.require(&base(), SID, Some(&id)).unwrap();
        let other = to_user(TRANSFER_2, OTHER, "5", "USDT");
        assert_eq!(
            code(f.require(&other, SID, Some(&id))),
            "bank.step_up_mismatch"
        );
    }

    #[test]
    fn an_approval_spent_elsewhere_is_refused_as_used() {
        let f = Fixture::new();
        let b = base();
        let id = f.identity.approve(TO_USER, &b.fields, &DEFAULT);
        let hash = payload_hash(TO_USER, &b.fields);
        f.identity
            .consume(
                &ConsumeInput {
                    approval_id: &id,
                    operation_id: &id,
                    payload_hash: &hash,
                    target_service: "svc-bank",
                    target_id: TO_USER,
                    expected_version: "1",
                    replay: None,
                },
                Some(PrincipalBinding {
                    user_id: USER,
                    session_id: SID,
                }),
            )
            .unwrap();
        assert_eq!(code(f.require(&b, SID, Some(&id))), "bank.step_up_used");
    }

    #[test]
    fn refuses_an_expired_approval_another_user_another_session_and_an_unknown_id() {
        let f = Fixture::new();
        let b = base();
        let expired = f.identity.approve(
            TO_USER,
            &b.fields,
            &Approve {
                ttl_ms: 1000,
                ..DEFAULT
            },
        );
        *f.identity.now.lock().unwrap() += 2000;
        let other_user = f.identity.approve(
            TO_USER,
            &b.fields,
            &Approve {
                user_id: OTHER,
                ..DEFAULT
            },
        );
        let other_session = f.identity.approve(
            TO_USER,
            &b.fields,
            &Approve {
                session_id: SID2,
                ..DEFAULT
            },
        );
        for id in [
            expired,
            other_user,
            other_session,
            "does-not-exist".to_owned(),
        ] {
            assert_eq!(code(f.require(&b, SID, Some(&id))), "bank.step_up_required");
        }
    }

    #[test]
    fn refuses_a_four_eyes_approval_on_a_step_up_door() {
        let f = Fixture::new();
        let id = f.identity.approve(
            TO_USER,
            &base().fields,
            &Approve {
                four_eyes: true,
                ..DEFAULT
            },
        );
        assert!(f.require(&base(), SID, Some(&id)).is_err());
    }

    #[test]
    fn the_flag_off_lets_every_door_through_and_never_asks_identity() {
        let f = Fixture::new();
        let off = Gate {
            required: false,
            approvals: &f.identity,
            store: &f.store,
            now: Instant(0),
        };
        off.require(&Request {
            user_id: USER,
            session_id: SID,
            binding: &base(),
            approval_id: None,
            replay: true,
        })
        .unwrap();
        assert_eq!(*f.identity.calls.lock().unwrap(), 0);
    }

    #[test]
    fn identity_codes_are_read_from_the_bracket() {
        assert_eq!(
            identity_code("identity refused consume (409) x [action_approval.consumed] y"),
            Some("action_approval.consumed")
        );
        assert_eq!(
            identity_code("[action_approval.] [action_approval.Bad]"),
            None
        );
        assert_eq!(identity_code("no code"), None);
    }
}
