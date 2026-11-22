//! The address book (`PORT.md`, slice `ramps`): `ramps.destinations.*` (`router/ramps.router.ts`) and the desk's fraud
//! list calls (`ops.destinationFraudList`, `ops.setDestinationFraudListing`), each checked as the TypeScript checks it.
//!
//! - `store`: the legacy slot the off-ramp writes and the saved entries, with every shape check
//!   (`withdraw-destination.ts`).
//! - `customer`: the list and its views, the add form's check, save, rename, readiness, svc-pay's sendable question and
//!   the registry's networks (`customer-ramps.ts`, `send-destination.ts`, `withdraw-networks.ts`).
//! - `approval`: approving a new address by an emailed link or from another device (`address-approval.ts`).
//! - `ownership`: the signed-message proof that the customer controls a saved wallet (`wallet-ownership.ts`).
//! - `fraud`: the owner's destination fraud list and its approved change (`fraud-list.ts`).
//! - `ports`: identity's approval mail and trusted devices (`trusted-devices.ts`).
//!
//! Nothing here moves money. The security lock is the transfers slice's port; the operator's approval is
//! `ops_approval::consume`, consumed after the change's checks and before it is written.

pub mod approval;
pub mod customer;
pub mod fraud;
pub mod ownership;
pub mod ports;
pub mod store;

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::trpc::TrpcError;

use crate::door::Ctx;
use crate::errors::{Refusal, to_trpc};
use crate::ops_approval;
use crate::partner::refuse;
use crate::spaces::space::with;

use super::Deps;
use store::SavedOn;

/// What the door holds for the address book, built once at start-up: identity's mail door and trusted devices.
pub struct Wiring {
    pub mail: Box<dyn ports::ApprovalMail>,
    pub devices: Box<dyn ports::TrustedDevices>,
}

impl Wiring {
    /// No `IDENTITY_URL`: every approval mail and every device read refuses.
    pub fn none() -> Wiring {
        Wiring {
            mail: Box::new(ports::NoIdentity),
            devices: Box::new(ports::NoIdentity),
        }
    }
}

fn text<'v>(v: &'v Value, key: &str) -> &'v str {
    v.get(key).as_str().unwrap_or_default()
}

/// A whole number the schema let through, saturating.
fn int_of(v: &Value, key: &str) -> Option<i64> {
    #[allow(
        clippy::cast_possible_truncation,
        reason = "the schema held it to a whole number; out of range saturates and is refused"
    )]
    v.get(key).as_number().map(|n| n as i64)
}

fn book<'a>(d: &'a Deps<'a>) -> customer::Book<'a> {
    customer::Book {
        store: d.store,
        ledger: d.ledger,
        lock: d.transfers.lock.as_ref(),
        settings: &d.w.settings,
        now: d.now,
    }
}

fn approvals<'a>(d: &'a Deps<'a>) -> approval::Approval<'a> {
    approval::Approval {
        store: d.store,
        lock: d.transfers.lock.as_ref(),
        mail: d.w.book.mail.as_ref(),
        devices: d.w.book.devices.as_ref(),
        link_minutes_raw: d.w.settings.address_approval_link_minutes.as_deref(),
        now: d.now,
    }
}

/// The sign-in and device the verified access token names (`ctx.principal.fam`, `dev`), never the request's.
fn signed_in(ctx: &Ctx<'_>) -> SavedOn {
    SavedOn {
        fam: ctx.principal.and_then(|p| p.fam.clone()),
        dev: ctx.principal.and_then(|p| p.dev.clone()),
    }
}

fn fraud_list(d: &Deps<'_>, input: &Value) -> Result<Json, Refusal> {
    let history_for = match input.get("historyFor") {
        Value::Object(_) => Some((
            text(input.get("historyFor"), "network"),
            text(input.get("historyFor"), "address"),
        )),
        _ => None,
    };
    let history_limit = int_of(input, "historyLimit");
    if history_for.is_some() && history_limit.is_none() {
        return Err(refuse(
            "bank.validation_failed",
            "historyLimit is required with historyFor; blank is not 50",
        ));
    }
    let limit = int_of(input, "limit").unwrap_or(0);
    let entries = with(d.store, |c| {
        fraud::list(c, limit, input.get("address").as_str())
    })?;
    let history = match (history_for, history_limit) {
        (Some((network, address)), Some(limit)) => {
            with(d.store, |c| fraud::history_of(c, network, address, limit))?
        }
        _ => Vec::new(),
    };
    Ok(Json::obj([
        (
            "entries",
            Json::Array(entries.iter().map(fraud::Listing::json).collect()),
        ),
        ("history", Json::Array(history)),
    ]))
}

fn set_fraud_listing(d: &Deps<'_>, input: &Value) -> Result<Json, Refusal> {
    let change = fraud::Change {
        network: text(input, "network"),
        address: text(input, "address"),
        listed: matches!(input.get("listed"), Value::Bool(true)),
        expected_revision: int_of(input, "expectedRevision").unwrap_or(-1),
        reason: text(input, "reason"),
    };
    let (listing, replayed) = fraud::set(d.store, &change, || {
        let fields = fraud::fields(&change)?;
        ops_approval::consume(
            d.transfers.approvals.as_ref(),
            input,
            fraud::SET_ACTION,
            &fields,
        )
        .map(|a| (a.requester_id, a.approver_id))
    })?;
    Ok(listing.json_replayed(replayed))
}

/// The answer of one of the address book's calls, by its path; `None` for a path outside it.
fn call(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let user = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    let input = &ctx.input;
    let b = book(d);
    let destination_id = text(input, "destinationId");
    Some(match ctx.call.path {
        "ramps.destinations.list" => customer::list(&b, user),
        "ramps.destinations.networks" => customer::networks_json(d.ledger),
        "ramps.destinations.check" => {
            customer::check(&b, user, text(input, "ref"), input.get("network").as_str())
        }
        "ramps.destinations.save" => {
            let save = store::SaveInput {
                user_id: user,
                asset_id: text(input, "assetId"),
                network: text(input, "network"),
                r#ref: text(input, "ref"),
                tag: input.get("tag").as_str(),
                label: text(input, "label"),
                lookalike_of: None,
                saved_on: signed_in(ctx),
            };
            customer::save(
                &b,
                &save,
                matches!(input.get("confirmLookalike"), Value::Bool(true)),
            )
        }
        "ramps.destinations.approval.requestMail" => {
            approval::request_mail(&approvals(d), user, destination_id).map(|(id, expires)| {
                Json::obj([
                    ("destinationId", Json::str(id)),
                    ("expiresAt", Json::str(expires)),
                ])
            })
        }
        "ramps.destinations.approval.confirmLink" => {
            approval::approve_by_link(&approvals(d), user, text(input, "token"))
                .and_then(|row| customer::view_with_ownership(&b, user, &row))
        }
        "ramps.destinations.approval.onDevice" => {
            approval::approve_on_device(&approvals(d), user, destination_id, &signed_in(ctx))
                .and_then(|row| customer::view_with_ownership(&b, user, &row))
        }
        "ramps.destinations.rename" => {
            customer::rename(&b, user, destination_id, text(input, "label"))
        }
        "ramps.destinations.ownership.start" => ownership::start(
            d.store,
            d.w.settings.wallet_proof_window_minutes.as_deref(),
            d.w.settings.wallet_proof_valid_days.as_deref(),
            user,
            destination_id,
            d.now,
        )
        .map(|s| {
            Json::obj([
                ("proofId", Json::str(s.proof_id)),
                ("destinationId", Json::str(s.destination_id)),
                ("message", Json::str(s.message)),
                ("expiresAt", Json::str(s.expires_at.iso())),
            ])
        }),
        "ramps.destinations.ownership.verify" => ownership::verify(
            d.store,
            d.w.settings.wallet_proof_valid_days.as_deref(),
            user,
            text(input, "proofId"),
            text(input, "signature"),
            d.now,
        )
        .map(|(p, own)| {
            let mut fields = vec![
                ("proofId".to_owned(), Json::str(p.id)),
                ("destinationId".to_owned(), Json::str(p.destination_id)),
            ];
            fields.extend(own.fields());
            Json::Object(fields)
        }),
        "ramps.destinations.readiness" => {
            customer::readiness(&b, user, destination_id).map(|r| r.json())
        }
        "ramps.destinations.sendable" => customer::sendable(
            &b,
            text(input, "userId"),
            text(input, "assetId"),
            text(input, "network"),
            text(input, "ref"),
        ),
        "ramps.destinations.remove" => {
            store::remove(d.store, user, destination_id, text(input, "idempotencyKey")).map(|id| {
                Json::obj([
                    ("destinationId", Json::str(id)),
                    ("removed", Json::Bool(true)),
                ])
            })
        }
        "ops.destinationFraudList" => fraud_list(d, input),
        "ops.setDestinationFraudListing" => set_fraud_listing(d, input),
        _ => return None,
    })
}

/// The address book's calls; `None` for any other path.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    let out = call(d, ctx)?;
    Some(out.map(Some).map_err(|r| {
        to_trpc(r, || {
            service_kit::approvals::random_uuid().unwrap_or_default()
        })
    }))
}
