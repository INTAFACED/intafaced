//! The step-up on money out (`step-up/step-up-gate.ts`, `step-up/step-up-store.ts`, `step-up/money-out-fields.ts`,
//! `router/context.ts` `requireStepUp`): a send to another person needs a fresh approval of the person's own, consumed
//! once at svc-identity and bound to the door's fields. `BANK_STEP_UP_MONEY_OUT=off` (the default) makes it a no-op.

use service_kit::edge::Principal;

use super::Deps;
use crate::errors::Refusal;

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

/// `stepUpEnforced`: the gate's mode is `required`.
pub fn enforced(d: &Deps<'_>) -> bool {
    d.w.settings.step_up_required
}

/// `requireStepUp(principal, binding, approvalId, replay = true)`.
pub fn require(
    d: &Deps<'_>,
    principal: &Principal,
    binding: &Binding,
    approval_id: Option<&str>,
) -> Result<(), Refusal> {
    let _ = (principal, binding, approval_id);
    if !enforced(d) {
        return Ok(());
    }
    Err(Refusal::Other(
        "svc-bank in Rust: the step-up gate is not ported yet".to_owned(),
    ))
}
