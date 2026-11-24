//! The customer's address book calls (the address half of `ramps/customer-ramps.ts`, `send-destination.ts`,
//! `withdraw-networks.ts`): the list and its views, the add form's check, save, rename, remove, whether one saved address
//! can be sent to now, and svc-pay's question before a withdrawal to an outside wallet.

use service_kit::json::Json;
use service_kit::time::Instant;

use crate::db::Store;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::ramps::cooling;
use crate::ramps::refs::{is_evm_address_ref, js_trim};
use crate::ramps::sanctions::{self, Check};
use crate::spaces::ports::Ledger;
use crate::spaces::space::with;
use crate::transfers::ports::{SecurityLock, assert_security_lock_open};

use super::approval::open_links;
use super::fraud;
use super::ownership::{self, Ownership, ownership_of};
use super::store::{self, Destination, SaveInput, lookalike_of};

/// What the customer calls are handed.
pub struct Book<'a> {
    pub store: &'a Store,
    pub ledger: &'a dyn Ledger,
    pub lock: &'a dyn SecurityLock,
    pub settings: &'a crate::ramps::Settings,
    pub now: Instant,
}

/// `/\s/`: the whitespace JavaScript's regular expressions name, the set `trim` strips.
fn is_js_space(c: char) -> bool {
    js_trim(c.encode_utf8(&mut [0; 4])).is_empty()
}

/// `maskRef`: the first six and last four characters, enough to recognise an address and not to copy it.
pub fn mask_ref(r: &str) -> String {
    let compact: Vec<u16> = r
        .chars()
        .filter(|c| !is_js_space(*c))
        .collect::<String>()
        .encode_utf16()
        .collect();
    let s = |from: usize, to: usize| {
        String::from_utf16_lossy(compact.get(from..to).unwrap_or_default())
    };
    let n = compact.len();
    if n <= 12 {
        format!("{}…", s(0, n.min(2)))
    } else {
        format!("{}…{}", s(0, 6), s(n - 4, n))
    }
}

fn opt(s: &Option<String>) -> Json {
    s.clone().map_or(Json::Null, Json::str)
}

fn opt_at(t: Option<Instant>) -> Json {
    t.map_or(Json::Null, |t| Json::str(t.iso()))
}

/// `viewOf`, in `destinationViewOutput`'s key order.
fn view_of(
    row: &Destination,
    hours: Option<i64>,
    own: &Ownership,
    link_expires_at: Option<&str>,
) -> Result<Json, Refusal> {
    let pending = row.state == "pending";
    let cooling_off_ends_at = match hours {
        Some(h) if !pending => Json::str(
            cooling::ends_at(h, row.updated_at)
                .ok_or_else(|| Refusal::Other("RangeError: Invalid time value".to_owned()))?
                .iso(),
        ),
        _ => Json::Null,
    };
    let k = |k: &str, v: Json| (k.to_owned(), v);
    Ok(Json::Object(vec![
        k("destinationId", Json::str(row.destination_id.clone())),
        k("label", opt(&row.label)),
        k("kind", Json::str(row.kind.clone())),
        k("ref", Json::str(row.r#ref.clone())),
        k("refMasked", Json::str(mask_ref(&row.r#ref))),
        k("assetId", opt(&row.asset_id)),
        k("network", opt(&row.network)),
        k("tag", opt(&row.tag)),
        k("origin", Json::str(row.origin.clone())),
        k("state", Json::str(row.state.clone())),
        k("addedAt", Json::str(row.added_at.iso())),
        k("coolingOffEndsAt", cooling_off_ends_at),
        k(
            "coolingBlocker",
            if hours.is_none() {
                Json::str("bank.offramp_cooling_unset")
            } else {
                Json::Null
            },
        ),
        k("lookalikeConfirmedAt", opt_at(row.lookalike_confirmed_at)),
        k("ownership", own.json()),
        k("approvedAt", opt_at(row.approved_at)),
        k("approvedBy", opt(&row.approved_by)),
        k(
            "approvalLinkExpiresAt",
            match link_expires_at {
                Some(t) if pending => Json::str(t),
                _ => Json::Null,
            },
        ),
    ]))
}

fn hours(b: &Book<'_>) -> Option<i64> {
    cooling::read_hours(b.settings.offramp_cooling_hours.as_deref())
}

/// `viewWithOwnership`: one entry's view with its ownership read from the latest proof.
pub fn view_with_ownership(
    b: &Book<'_>,
    user_id: &str,
    row: &Destination,
) -> Result<Json, Refusal> {
    let latest = with(b.store, |c| ownership::latest(c, user_id))?;
    let links = if row.state == "pending" {
        with(b.store, |c| open_links(c, user_id, b.now))?
    } else {
        Vec::new()
    };
    let link = links
        .iter()
        .find(|(d, _)| *d == row.destination_id)
        .map(|(_, t)| t.as_str());
    let own = ownership_of(
        ownership::of(&latest, &row.destination_id),
        b.now,
        Some(&row.r#ref),
    );
    view_of(row, hours(b), &own, link)
}

/// `listDestinations`.
pub fn list(b: &Book<'_>, user_id: &str) -> Result<Json, Refusal> {
    let h = hours(b);
    let rows = with(b.store, |c| store::list(c, user_id))?;
    let latest = with(b.store, |c| ownership::latest(c, user_id))?;
    let links = with(b.store, |c| open_links(c, user_id, b.now))?;
    rows.iter()
        .map(|row| {
            let own = ownership_of(
                ownership::of(&latest, &row.destination_id),
                b.now,
                Some(&row.r#ref),
            );
            let link = links
                .iter()
                .find(|(d, _)| *d == row.destination_id)
                .map(|(_, t)| t.as_str());
            view_of(row, h, &own, link)
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Json::Array)
}

const ADDING: &str = "adding a withdrawal address";

/// `checkDestination`: the address rules `save` applies, answered as data so the form can warn before step-up.
pub fn check(b: &Book<'_>, user_id: &str, r: &str, network: Option<&str>) -> Result<Json, Refusal> {
    assert_security_lock_open(b.lock, user_id, ADDING)?;
    let r = js_trim(r);
    if !is_evm_address_ref(r) {
        return Ok(Json::obj([
            ("address", Json::str("invalid")),
            ("lookalike", Json::Null),
            ("fraudListed", Json::Bool(false)),
        ]));
    }
    sanctions::assert_clear(b.settings.destination_sanctions.as_deref(), network, r)?;
    let saved = with(b.store, |c| store::list(c, user_id))?;
    let fraud_listed = match network {
        None => false,
        Some(n) => fraud::is_listed_in(b.store, Some(n), r)?,
    };
    let near = lookalike_of(r, &saved);
    Ok(Json::obj([
        (
            "address",
            Json::str(if store::evm_checksum_matches(r) {
                "ok"
            } else {
                "checksum_mismatch"
            }),
        ),
        (
            "lookalike",
            near.map_or(Json::Null, |n| {
                Json::obj([
                    ("destinationId", Json::str(n.destination_id.clone())),
                    ("label", opt(&n.label)),
                    ("refMasked", Json::str(mask_ref(&n.r#ref))),
                ])
            }),
        ),
        ("fraudListed", Json::Bool(fraud_listed)),
    ]))
}

// ---------------------------------------------------------------------------------------------------------------
// Which asset may be sent on which network (`withdraw-networks.ts`)

/// `WithdrawAsset`.
pub struct WithdrawAsset {
    pub asset_id: String,
    pub precision: f64,
    pub networks: Vec<(String, String)>,
    pub default_network_id: Option<String>,
}

fn registry_unavailable() -> Refusal {
    refuse(
        "bank.asset_registry_unavailable",
        "The list of supported assets and networks could not be read. Try again shortly",
    )
}

/// One registry row as the address book reads it: `None` when it does not fit the registry's wire shape.
fn registry_row(a: &Json) -> Option<(bool, WithdrawAsset)> {
    let s = |k: &str| match a.get(k) {
        Some(Json::String(v)) => Some(v.clone()),
        _ => None,
    };
    let Some(Json::Array(networks)) = a.get("networks") else {
        return None;
    };
    let networks = networks
        .iter()
        .map(|n| match (n.get("networkId"), n.get("label")) {
            (Some(Json::String(id)), Some(Json::String(label))) => {
                Some((id.clone(), label.clone()))
            }
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    let precision = match a.get("precision") {
        Some(Json::Number(p)) if p.fract() == 0.0 => *p,
        _ => return None,
    };
    let Some(Json::Array(actions)) = a.get("allowedActions") else {
        return None;
    };
    let withdraw = actions
        .iter()
        .any(|x| matches!(x, Json::String(s) if s == "withdraw"));
    let default_network_id = match a.get("defaultNetworkId") {
        Some(Json::Null) => None,
        Some(Json::String(d)) => Some(d.clone()),
        _ => return None,
    };
    let allows = s("state")? == "active" && withdraw;
    Some((
        allows,
        WithdrawAsset {
            asset_id: s("id")?,
            precision,
            networks,
            default_network_id,
        },
    ))
}

/// `listWithdrawNetworks`: the assets a person may save a withdrawal address for, each with its networks, in the
/// registry's order. An unreadable registry refuses, never an empty list.
pub fn withdraw_networks(ledger: &dyn Ledger) -> Result<Vec<WithdrawAsset>, Refusal> {
    let rows = ledger.assets().map_err(|_| registry_unavailable())?;
    let parsed = rows
        .iter()
        .map(registry_row)
        .collect::<Option<Vec<_>>>()
        .ok_or_else(registry_unavailable)?;
    Ok(parsed
        .into_iter()
        .filter(|(allows, a)| *allows && !a.networks.is_empty())
        .map(|(_, a)| a)
        .collect())
}

/// `destinations.networks`' answer.
pub fn networks_json(ledger: &dyn Ledger) -> Result<Json, Refusal> {
    Ok(Json::Array(
        withdraw_networks(ledger)?
            .into_iter()
            .map(|a| {
                Json::obj([
                    ("assetId", Json::str(a.asset_id)),
                    ("precision", Json::Number(a.precision)),
                    (
                        "networks",
                        Json::Array(
                            a.networks
                                .into_iter()
                                .map(|(id, label)| {
                                    Json::obj([
                                        ("networkId", Json::str(id)),
                                        ("label", Json::str(label)),
                                    ])
                                })
                                .collect(),
                        ),
                    ),
                    (
                        "defaultNetworkId",
                        a.default_network_id.map_or(Json::Null, Json::str),
                    ),
                ])
            })
            .collect(),
    ))
}

/// `assertWithdrawNetwork`: the registry must list `network` for `asset_id` and the asset allow withdrawals now.
fn assert_withdraw_network(
    ledger: &dyn Ledger,
    asset_id: &str,
    network: &str,
) -> Result<(), Refusal> {
    let assets = withdraw_networks(ledger)?;
    let Some(asset) = assets.iter().find(|a| a.asset_id == asset_id) else {
        return Err(refuse(
            "bank.withdraw_network_unsupported",
            format!("{asset_id} cannot be withdrawn right now, so no address can be saved for it"),
        ));
    };
    if !asset.networks.iter().any(|(id, _)| id == network) {
        let labels: Vec<&str> = asset.networks.iter().map(|(_, l)| l.as_str()).collect();
        return Err(refuse(
            "bank.withdraw_network_unsupported",
            format!(
                "{asset_id} is not sent on {network}. Choose one of: {}",
                labels.join(", ")
            ),
        ));
    }
    Ok(())
}

/// `saveDestination`: a new entry is saved `pending`, recording the saving sign-in and device. The network must be one
/// the registry lists, the address clear of the sanctions and fraud lists, the security lock open, and an address that
/// shows like a saved one is saved only after the customer confirmed it.
pub fn save(b: &Book<'_>, input: &SaveInput<'_>, confirm_lookalike: bool) -> Result<Json, Refusal> {
    // The look-alike record is this function's alone: whatever a caller passed is dropped.
    let book = SaveInput {
        lookalike_of: None,
        ..input.clone()
    };
    let entry = store::assert_book_entry(&book)?;
    assert_withdraw_network(b.ledger, &entry.asset_id, &entry.network)?;
    sanctions::assert_clear(
        b.settings.destination_sanctions.as_deref(),
        Some(&entry.network),
        &entry.r#ref,
    )?;
    let saved = with(b.store, |c| store::list(c, book.user_id))?;
    let fraud_listed = fraud::is_listed_in(b.store, Some(&entry.network), &entry.r#ref)?;
    let same = saved.iter().find(|row| {
        row.origin == "customer"
            && row.kind == "crypto"
            && row.asset_id.as_deref() == Some(entry.asset_id.as_str())
            && row.network.as_deref() == Some(entry.network.as_str())
            && row.r#ref.to_lowercase() == entry.r#ref.to_lowercase()
            && row.tag.clone().unwrap_or_default() == entry.tag.clone().unwrap_or_default()
    });
    if fraud_listed {
        return Err(refuse(
            "bank.destination_fraud_listed",
            "This address is on the fraud list, so it cannot be saved to your address book. Nothing was saved",
        ));
    }
    if let Some(same) = same {
        return view_with_ownership(b, book.user_id, same);
    }
    assert_security_lock_open(b.lock, book.user_id, ADDING)?;
    let near = lookalike_of(&entry.r#ref, &saved);
    if let Some(n) = near
        && !confirm_lookalike
    {
        let named = n
            .label
            .as_ref()
            .map_or_else(|| mask_ref(&n.r#ref), |l| format!("\"{l}\""));
        return Err(refuse(
            "bank.address_lookalike",
            format!(
                "This address starts and ends like your saved address {named} but is a different address. Check every character before you save it"
            ),
        ));
    }
    let to_save = SaveInput {
        lookalike_of: near.map(|n| n.destination_id.clone()),
        ..book
    };
    let row = store::save(b.store, b.settings.address_book_cap.as_deref(), &to_save)?;
    view_with_ownership(b, input.user_id, &row)
}

/// `renameDestination`.
pub fn rename(
    b: &Book<'_>,
    user_id: &str,
    destination_id: &str,
    label: &str,
) -> Result<Json, Refusal> {
    let row = with(b.store, |c| {
        store::rename(c, user_id, destination_id, label)
    })?;
    view_with_ownership(b, user_id, &row)
}

/// `DestinationReadiness`: `(state, coolingOffEndsAt, lockUnlocksAt, approvalLinkExpiresAt)`.
pub struct Readiness {
    pub destination_id: String,
    pub state: &'static str,
    pub cooling_off_ends_at: Option<String>,
    pub lock_unlocks_at: Option<String>,
    pub approval_link_expires_at: Option<String>,
}

impl Readiness {
    pub fn json(&self) -> Json {
        let o = |s: &Option<String>| s.clone().map_or(Json::Null, Json::str);
        Json::obj([
            ("destinationId", Json::str(self.destination_id.clone())),
            ("state", Json::str(self.state)),
            ("coolingOffEndsAt", o(&self.cooling_off_ends_at)),
            ("lockUnlocksAt", o(&self.lock_unlocks_at)),
            ("approvalLinkExpiresAt", o(&self.approval_link_expires_at)),
        ])
    }
}

/// `destinationReadiness`: whether money may be sent to one saved address now, or what stands in the way first.
pub fn readiness(b: &Book<'_>, user_id: &str, destination_id: &str) -> Result<Readiness, Refusal> {
    let rows = with(b.store, |c| store::list(c, user_id))?;
    let lock = b.lock.read(user_id)?;
    let row = rows
        .iter()
        .find(|e| e.destination_id == destination_id)
        .ok_or_else(|| {
            refuse(
                "bank.withdraw_destination_missing",
                format!("User {user_id} has no saved address {destination_id}"),
            )
        })?;
    let base = |state: &'static str| Readiness {
        destination_id: row.destination_id.clone(),
        state,
        cooling_off_ends_at: None,
        lock_unlocks_at: None,
        approval_link_expires_at: None,
    };
    if lock.self_frozen {
        return Ok(base("locked"));
    }
    if lock.locked {
        return Ok(Readiness {
            lock_unlocks_at: lock.unlocks_at,
            ..base("locked")
        });
    }
    if row.state == "blocked" || row.state == "archived" {
        return Ok(base("blocked"));
    }
    if fraud::is_listed_in(b.store, row.network.as_deref(), &row.r#ref)? {
        return Ok(base("blocked"));
    }
    if sanctions::check(
        b.settings.destination_sanctions.as_deref(),
        row.network.as_deref(),
        &row.r#ref,
    ) != Check::Clear
    {
        return Ok(base("blocked"));
    }
    if row.state == "pending" {
        let links = with(b.store, |c| open_links(c, user_id, b.now))?;
        return Ok(Readiness {
            approval_link_expires_at: links
                .into_iter()
                .find(|(d, _)| *d == row.destination_id)
                .map(|(_, t)| t),
            ..base("approval_pending")
        });
    }
    let Some(h) = hours(b) else {
        return Ok(base("cooling_unset"));
    };
    let Some(ends) = cooling::ends_at(h, row.updated_at) else {
        return Ok(base("cooling"));
    };
    let state = if b.now.0 < ends.0 { "cooling" } else { "ready" };
    Ok(Readiness {
        cooling_off_ends_at: Some(ends.iso()),
        ..base(state)
    })
}

/// `sendableDestination`: whether money may be sent to this address of this asset on this network now, asked by
/// svc-pay before it claims a withdrawal to a wallet outside the platform. Reads, never writes.
pub fn sendable(
    b: &Book<'_>,
    user_id: &str,
    asset_id: &str,
    network: &str,
    r: &str,
) -> Result<Json, Refusal> {
    let asset_id = js_trim(asset_id).to_uppercase();
    let network = js_trim(network).to_lowercase();
    let sent = js_trim(r);
    let evm = is_evm_address_ref(sent);
    let same_address = |saved: &str| {
        if evm {
            js_trim(saved).to_lowercase() == sent.to_lowercase()
        } else {
            js_trim(saved) == sent
        }
    };
    let saved: Vec<Destination> = with(b.store, |c| store::list(c, user_id))?
        .into_iter()
        .filter(|row| {
            row.origin == "customer"
                && row.state != "archived"
                && row.asset_id.as_deref() == Some(asset_id.as_str())
                && same_address(&row.r#ref)
        })
        .collect();
    let answer = |state: &str, id: Option<String>, ends: Option<String>| {
        Json::obj([
            ("state", Json::str(state)),
            ("destinationId", id.map_or(Json::Null, Json::str)),
            ("coolingOffEndsAt", ends.map_or(Json::Null, Json::str)),
        ])
    };
    let Some(m) = saved
        .iter()
        .find(|row| row.network.as_deref() == Some(network.as_str()) && row.tag.is_none())
    else {
        let elsewhere = saved
            .iter()
            .any(|row| row.network.as_deref() != Some(network.as_str()) && row.tag.is_none());
        return Ok(answer(
            if elsewhere {
                "other_network"
            } else {
                "not_saved"
            },
            None,
            None,
        ));
    };
    let ready = readiness(b, user_id, &m.destination_id)?;
    let ends = if ready.state == "cooling" {
        ready.cooling_off_ends_at
    } else {
        None
    };
    Ok(answer(ready.state, Some(ready.destination_id), ends))
}
