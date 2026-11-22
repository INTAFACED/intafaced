//! The customer's off-ramp and withdrawal address (`ramp-service.ts`: `offramp`, `setWithdrawDestination`; the router's
//! `ramps.offramp` and `ramps.setWithdrawDestination`).
//!
//! An off-ramp is a withdrawal: `withdrawHold` (available into the hold for this off-ramp id), then `withdrawSettle`
//! (the hold out to the crypto ledger rail), both through svc-ledger's recipe door under `withdraw.hold:<id>` and
//! `withdraw.settle:<id>`. Nothing is broadcast to a chain. If the process dies after the hold and before the settle,
//! the money sits in the person's own hold account for this id and a replay under the same id settles it; with the
//! custodial layer off each post refuses `bank.no_partner_bank` before svc-ledger is asked, and the claimed row stays
//! pending, holding nothing.

use postgres::GenericClient;
use postgres::error::SqlState;
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::schema::Value;
use service_kit::time::Instant;
use service_kit::trpc::TrpcError;

use crate::door::Ctx;
use crate::errors::{Refusal, to_trpc};
use crate::partner::refuse;
use crate::spaces::space::{in_tx, pg, with};
use crate::transfers::moves::post_refusal;
use crate::transfers::ports::{assert_holds_open, assert_security_lock_open};

use super::book::{fraud, store};
use super::refs::{address_key, js_trim};
use super::{Deps, cooling, sanctions};

/// `BANK_CRYPTO_LEDGER_RAIL`: the ledger rail of the crypto half, distinct from svc-pay's `crypto-native`.
pub const BANK_CRYPTO_LEDGER_RAIL: &str = "bank-crypto-ledger";

/// One off-ramp row (`OfframpRecord`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Offramp {
    pub id: String,
    pub user_id: String,
    pub asset_id: String,
    pub amount: Amount,
    pub kind: String,
    pub rail: String,
    pub destination_ref: String,
    pub client_ref: String,
    pub simulated: bool,
    pub status: String,
    pub hold_ledger_tx_id: Option<String>,
    pub settle_ledger_tx_id: Option<String>,
    pub release_ledger_tx_id: Option<String>,
    pub rejection_code: Option<String>,
    pub created_at: Instant,
    pub settled_at: Option<Instant>,
}

/// The columns an `Offramp` is read from.
pub const COLS: &str = "id::text, user_id, asset_id, amount::text, kind::text, rail, destination_ref, client_ref, \
     simulated, status::text, hold_ledger_tx_id, settle_ledger_tx_id, release_ledger_tx_id, rejection_code, \
     floor(extract(epoch from created_at) * 1000)::int8, floor(extract(epoch from settled_at) * 1000)::int8";

impl Offramp {
    pub fn from_row(r: &postgres::Row) -> Result<Offramp, Refusal> {
        let amount: String = r.try_get(3).map_err(|e| pg(&e))?;
        Ok(Offramp {
            id: r.try_get(0).map_err(|e| pg(&e))?,
            user_id: r.try_get(1).map_err(|e| pg(&e))?,
            asset_id: r.try_get(2).map_err(|e| pg(&e))?,
            amount: parse_amount(&amount).map_err(Refusal::Other)?,
            kind: r.try_get(4).map_err(|e| pg(&e))?,
            rail: r.try_get(5).map_err(|e| pg(&e))?,
            destination_ref: r.try_get(6).map_err(|e| pg(&e))?,
            client_ref: r.try_get(7).map_err(|e| pg(&e))?,
            simulated: r.try_get(8).map_err(|e| pg(&e))?,
            status: r.try_get(9).map_err(|e| pg(&e))?,
            hold_ledger_tx_id: r.try_get(10).map_err(|e| pg(&e))?,
            settle_ledger_tx_id: r.try_get(11).map_err(|e| pg(&e))?,
            release_ledger_tx_id: r.try_get(12).map_err(|e| pg(&e))?,
            rejection_code: r.try_get(13).map_err(|e| pg(&e))?,
            created_at: Instant(r.try_get(14).map_err(|e| pg(&e))?),
            settled_at: r
                .try_get::<_, Option<i64>>(15)
                .map_err(|e| pg(&e))?
                .map(Instant),
        })
    }

    /// The router's `offrampOutput`.
    pub fn json(&self) -> Json {
        let opt = |v: &Option<String>| v.as_ref().map_or(Json::Null, |s| Json::str(s.clone()));
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("assetId", Json::str(self.asset_id.clone())),
            ("amount", Json::str(format_amount(self.amount))),
            ("kind", Json::str(self.kind.clone())),
            ("rail", Json::str(self.rail.clone())),
            ("destinationRef", Json::str(self.destination_ref.clone())),
            ("clientRef", Json::str(self.client_ref.clone())),
            ("simulated", Json::Bool(self.simulated)),
            ("status", Json::str(self.status.clone())),
            ("holdLedgerTxId", opt(&self.hold_ledger_tx_id)),
            ("settleLedgerTxId", opt(&self.settle_ledger_tx_id)),
            ("createdAt", Json::str(self.created_at.iso())),
        ])
    }
}

/// `refuseFiatRamp`.
pub fn refuse_fiat() -> Refusal {
    refuse(
        "bank.fiat_ramp_socket",
        "Fiat on/off ramp is socket.psp-partners — a bank/PSP partner and money-transmission permission, not inventable code. \
         Reuse a live svc-pay RailAdapter via PayFiatRampPort; do not invent APY, card BIN, or a bank-local PSP.",
    )
}

/// `assertCryptoRamp`: the ledger rail of the programme `BANK_RAMP_MODE` names; `none` (the default) refuses.
pub fn assert_crypto_ramp(ramp_mode: Option<&str>) -> Result<&'static str, Refusal> {
    if ramp_mode.map(js_trim) == Some("crypto-ledger") {
        return Ok(BANK_CRYPTO_LEDGER_RAIL);
    }
    Err(refuse(
        "bank.no_ramp_rail",
        "No bank ramp programme is configured — set BANK_RAMP_MODE=crypto-ledger for the crypto ledger half, or leave none and do not call ramps",
    ))
}

/// `assertRampAssetId`: a non-empty symbol with no surrounding whitespace.
pub fn assert_ramp_asset_id(asset_id: &str) -> Result<(), Refusal> {
    let t = js_trim(asset_id);
    if t.is_empty() || t != asset_id {
        return Err(refuse(
            "bank.ramp_invalid_asset",
            "Ramp asset id must be a non-empty crypto symbol with no leading or trailing whitespace",
        ));
    }
    Ok(())
}

fn conflict(message: impl Into<String>) -> Refusal {
    refuse("bank.ramp_conflict", message)
}

/// `custodyGuardedLedger`: with the custodial layer off no customer balance is posted from here.
fn custody_guard(d: &Deps<'_>) -> Result<(), Refusal> {
    if d.partner.custody_layer == "on" {
        return Ok(());
    }
    Err(refuse(
        "bank.no_partner_bank",
        "No banking partner holds this money, and INTAFACED holds no customer money, so nothing was moved.",
    ))
}

/// The input of `ramps.offramp` as the router hands it to the service.
pub struct OfframpInput<'a> {
    pub offramp_id: &'a str,
    pub user_id: &'a str,
    pub asset_id: &'a str,
    pub amount: Amount,
    pub kind: &'a str,
    pub destination_ref: Option<&'a str>,
    pub client_ref: &'a str,
}

struct Claim<'a> {
    input: &'a OfframpInput<'a>,
    rail: &'a str,
    destination_ref: &'a str,
}

/// `offrampFactsMismatch`: the claimed row must match every term the client sent, both unique keys included.
fn mismatch(existing: &Offramp, c: &Claim<'_>) -> bool {
    existing.id != c.input.offramp_id
        || existing.user_id != c.input.user_id
        || existing.asset_id != c.input.asset_id
        || existing.amount != c.input.amount
        || existing.destination_ref != c.destination_ref
        || existing.client_ref != c.input.client_ref
}

fn select_one(
    c: &mut impl GenericClient,
    sql: &str,
    params: &[&(dyn postgres::types::ToSql + Sync)],
) -> Result<Option<Offramp>, Refusal> {
    let rows = c.query(sql, params).map_err(|e| pg(&e))?;
    rows.first().map(Offramp::from_row).transpose()
}

/// `claimOfframp`: the row for this id, inserted once; a reused id or client ref with other terms is a conflict.
fn claim(d: &Deps<'_>, c: &Claim<'_>) -> Result<Offramp, Refusal> {
    let i = c.input;
    in_tx(d.store, |tx| {
        if let Some(existing) = select_one(
            tx,
            &format!("SELECT {COLS} FROM bank.ramp_offramps WHERE id = $1::text::uuid FOR UPDATE"),
            &[&i.offramp_id],
        )? {
            if mismatch(&existing, c) {
                return Err(conflict(format!(
                    "Off-ramp id {} was already used with different terms",
                    i.offramp_id
                )));
            }
            return Ok(existing);
        }
        let amount = format_amount(i.amount);
        let inserted = tx.query(
            &format!(
                "INSERT INTO bank.ramp_offramps (id, user_id, asset_id, amount, kind, rail, destination_ref, client_ref, \
                 simulated, status) VALUES ($1::text::uuid, $2, $3, $4::text::numeric, $5::text::bank.ramp_kind, $6, $7, \
                 $8, true, 'pending') ON CONFLICT (user_id, client_ref) DO NOTHING RETURNING {COLS}"
            ),
            &[
                &i.offramp_id,
                &i.user_id,
                &i.asset_id,
                &amount,
                &i.kind,
                &c.rail,
                &c.destination_ref,
                &i.client_ref,
            ],
        );
        match inserted {
            Ok(rows) => {
                if let Some(r) = rows.first() {
                    return Offramp::from_row(r);
                }
            }
            Err(e) => {
                // A concurrent insert of the same id: resolved by name, never a raw 23505.
                if e.code() != Some(&SqlState::UNIQUE_VIOLATION) {
                    return Err(pg(&e));
                }
                let raced = select_one(
                    tx,
                    &format!(
                        "SELECT {COLS} FROM bank.ramp_offramps WHERE id = $1::text::uuid \
                         OR (user_id = $2 AND client_ref = $3) FOR UPDATE"
                    ),
                    &[&i.offramp_id, &i.user_id, &i.client_ref],
                )?;
                let Some(existing) = raced else {
                    return Err(pg(&e));
                };
                if mismatch(&existing, c) {
                    return Err(conflict(format!(
                        "Off-ramp claim collided on id {} or client ref {}",
                        i.offramp_id, i.client_ref
                    )));
                }
                return Ok(existing);
            }
        }
        let existing = select_one(
            tx,
            &format!(
                "SELECT {COLS} FROM bank.ramp_offramps WHERE user_id = $1 AND client_ref = $2 FOR UPDATE"
            ),
            &[&i.user_id, &i.client_ref],
        )?
        .ok_or_else(|| Refusal::Other("the client ref's row is gone".to_owned()))?;
        if mismatch(&existing, c) {
            return Err(conflict(format!(
                "Client ref {} was already used for a different off-ramp",
                i.client_ref
            )));
        }
        Ok(existing)
    })
}

/// The address and state this person's off-ramp under this id was claimed with, or none.
fn claimed(
    d: &Deps<'_>,
    offramp_id: &str,
    user_id: &str,
) -> Result<Option<(String, String)>, Refusal> {
    with(d.store, |c| {
        let rows = c
            .query(
                "SELECT destination_ref, status::text FROM bank.ramp_offramps WHERE id = $1::text::uuid AND user_id = $2",
                &[&offramp_id, &user_id],
            )
            .map_err(|e| pg(&e))?;
        rows.first()
            .map(|r| {
                Ok((
                    r.try_get(0).map_err(|e| pg(&e))?,
                    r.try_get(1).map_err(|e| pg(&e))?,
                ))
            })
            .transpose()
    })
}

fn recipe_input(o: &Offramp) -> Json {
    Json::obj([
        ("userId", Json::str(o.user_id.clone())),
        ("assetId", Json::str(o.asset_id.clone())),
        ("amount", Json::str(format_amount(o.amount))),
        ("rail", Json::str(o.rail.clone())),
        ("withdrawalId", Json::str(o.id.clone())),
    ])
}

/// `resolveWithdrawDestination`: a crypto withdrawal always pays the stored address; an offered one is stored first.
fn resolve_destination(
    d: &Deps<'_>,
    user_id: &str,
    offered: Option<&str>,
) -> Result<store::Destination, Refusal> {
    let cap = d.w.settings.address_book_cap.as_deref();
    with(d.store, |c| {
        if let Some(r) = offered.filter(|o| !o.is_empty()) {
            store::persist(c, cap, user_id, "crypto", r, None)?;
        }
        store::require(c, user_id, "crypto")
    })
}

/// `RampService.offramp`.
pub fn offramp(d: &Deps<'_>, input: &OfframpInput<'_>) -> Result<Offramp, Refusal> {
    if input.kind == "fiat" {
        return Err(refuse_fiat());
    }
    if input.amount <= 0 {
        return Err(refuse(
            "bank.ramp_invalid_amount",
            "Off-ramp amount must be positive",
        ));
    }
    assert_ramp_asset_id(input.asset_id)?;
    let rail = assert_crypto_ramp(d.w.settings.ramp_mode.as_deref())?;
    let offered = input.destination_ref.map(js_trim);

    // While the security lock holds no new send starts; a send already claimed to the same address carries on. The
    // owner's self-freeze stops everything.
    let hold = d.transfers.lock.read(input.user_id)?;
    if hold.self_frozen {
        assert_holds_open(&hold, "a withdrawal")?;
    }
    if hold.locked {
        let to = claimed(d, input.offramp_id, input.user_id)?.map(|(r, _)| r);
        let other = offered.is_some_and(|o| !o.is_empty() && Some(o) != to.as_deref());
        if to.is_none() || other {
            assert_holds_open(&hold, "a withdrawal")?;
        }
    }
    let hours = cooling::require_hours(d.w.settings.offramp_cooling_hours.as_deref())?;

    // A listed address is never stored or sent to; only a send already claimed to that same address carries on.
    let resumes_with = |r: &str| -> Result<bool, Refusal> {
        Ok(claimed(d, input.offramp_id, input.user_id)?
            .is_some_and(|(to, _)| address_key(r) == address_key(&to)))
    };
    // The sanctions list is stricter: only a finished send to that address answers as before.
    let answers_as_before = |r: &str| -> Result<bool, Refusal> {
        Ok(
            claimed(d, input.offramp_id, input.user_id)?.is_some_and(|(to, status)| {
                address_key(r) == address_key(&to) && (status == "settled" || status == "rejected")
            }),
        )
    };
    let sanctions_raw = d.w.settings.destination_sanctions.as_deref();
    if let Some(o) = offered.filter(|o| !o.is_empty()) {
        if with(d.store, |c| fraud::is_listed(c, None, o))? && !resumes_with(o)? {
            return Err(fraud::refuse_listed());
        }
        if let Some(r) = sanctions::refusal(sanctions_raw, None, o)
            && !answers_as_before(o)?
        {
            return Err(r);
        }
    }
    let dest = resolve_destination(d, input.user_id, offered)?;
    if with(d.store, |c| {
        fraud::is_listed(c, dest.network.as_deref(), &dest.r#ref)
    })? && !resumes_with(&dest.r#ref)?
    {
        return Err(fraud::refuse_listed());
    }
    if let Some(r) = sanctions::refusal(sanctions_raw, dest.network.as_deref(), &dest.r#ref)
        && !answers_as_before(&dest.r#ref)?
    {
        return Err(r);
    }
    cooling::assert_elapsed(hours, dest.updated_at, d.now)?;

    crate::loans::locks::with_lock(d.store, "bank.ramp.offramp", input.offramp_id, || {
        let c = Claim {
            input,
            rail,
            destination_ref: &dest.r#ref,
        };
        let claimed = claim(d, &c)?;
        match claimed.status.as_str() {
            "settled" => return Ok(claimed),
            "rejected" => {
                return Err(conflict(
                    claimed
                        .rejection_code
                        .clone()
                        .unwrap_or_else(|| "Off-ramp previously rejected".to_owned()),
                ));
            }
            _ => {}
        }
        let posted_input = recipe_input(&claimed);
        // The resume path: the hold already posted, the settle still owed.
        let hold_tx = match claimed.hold_ledger_tx_id.clone() {
            Some(id) => id,
            None => {
                custody_guard(d)?;
                let held = match d.ledger.post_recipe(
                    "withdrawHold",
                    &posted_input,
                    &format!("withdraw.hold:{}", claimed.id),
                ) {
                    Ok(tx) => tx,
                    Err(f) => {
                        if f.insufficient() {
                            reject(d, &claimed.id, "ledger.insufficient_funds")?;
                        }
                        return Err(post_refusal(&f));
                    }
                };
                let stamped = with(d.store, |cl| {
                    cl.query(
                        "UPDATE bank.ramp_offramps SET hold_ledger_tx_id = $1 \
                         WHERE id = $2::text::uuid AND status = 'pending' RETURNING id",
                        &[&held.id, &claimed.id],
                    )
                    .map_err(|e| pg(&e))
                })?;
                if stamped.is_empty() {
                    return Err(conflict("Off-ramp hold did not claim the pending row"));
                }
                held.id
            }
        };
        custody_guard(d)?;
        let settled = d
            .ledger
            .post_recipe(
                "withdrawSettle",
                &posted_input,
                &format!("withdraw.settle:{}", claimed.id),
            )
            .map_err(|f| post_refusal(&f))?;
        let wrote = with(d.store, |cl| {
            cl.query(
                "UPDATE bank.ramp_offramps SET status = 'settled', hold_ledger_tx_id = $1, settle_ledger_tx_id = $2, \
                 settled_at = now() WHERE id = $3::text::uuid AND status = 'pending' RETURNING id",
                &[&hold_tx, &settled.id, &claimed.id],
            )
            .map_err(|e| pg(&e))
        })?;
        if wrote.is_empty() {
            return Err(conflict("Off-ramp settle did not claim the pending row"));
        }
        Ok(Offramp {
            status: "settled".to_owned(),
            hold_ledger_tx_id: Some(hold_tx),
            settle_ledger_tx_id: Some(settled.id),
            settled_at: Some(d.now),
            ..claimed
        })
    })
}

fn reject(d: &Deps<'_>, id: &str, code: &str) -> Result<(), Refusal> {
    with(d.store, |c| {
        c.execute(
            "UPDATE bank.ramp_offramps SET status = 'rejected', rejection_code = $1 \
             WHERE id = $2::text::uuid AND status = 'pending'",
            &[&code, &id],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(())
}

/// `RampService.setWithdrawDestination`: refused while the security lock holds, and for an address on the fraud or
/// sanctions list on any network.
pub fn set_withdraw_destination(
    d: &Deps<'_>,
    user_id: &str,
    kind: &str,
    r: &str,
    label: Option<&str>,
) -> Result<store::Destination, Refusal> {
    assert_security_lock_open(
        d.transfers.lock.as_ref(),
        user_id,
        "changing a withdrawal address",
    )?;
    if with(d.store, |c| fraud::is_listed(c, None, r))? {
        return Err(fraud::refuse_listed());
    }
    sanctions::assert_clear(d.w.settings.destination_sanctions.as_deref(), None, r)?;
    let cap = d.w.settings.address_book_cap.as_deref();
    with(d.store, |c| store::persist(c, cap, user_id, kind, r, label))
}

fn text<'v>(v: &'v Value, key: &str) -> &'v str {
    v.get(key).as_str().unwrap_or_default()
}

/// The off-ramp's calls; `None` for any other path.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    let path = ctx.call.path;
    if path != "ramps.offramp" && path != "ramps.setWithdrawDestination" {
        return None;
    }
    let user = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    let input = &ctx.input;
    let out: Result<Json, Refusal> = (|| {
        if path == "ramps.offramp" {
            let amount = parse_amount(text(input, "amount")).map_err(Refusal::Other)?;
            let row = offramp(
                d,
                &OfframpInput {
                    offramp_id: text(input, "offrampId"),
                    user_id: user,
                    asset_id: text(input, "assetId"),
                    amount,
                    kind: text(input, "kind"),
                    destination_ref: input.get("destinationRef").as_str(),
                    client_ref: text(input, "clientRef"),
                },
            )?;
            return Ok(row.json());
        }
        let saved = set_withdraw_destination(
            d,
            user,
            text(input, "kind"),
            text(input, "ref"),
            input.get("label").as_str(),
        )?;
        Ok(Json::obj([
            ("kind", Json::str(saved.kind.clone())),
            ("ref", Json::str(saved.r#ref.clone())),
        ]))
    })();
    Some(out.map(Some).map_err(|e| {
        to_trpc(e, || {
            service_kit::approvals::random_uuid().unwrap_or_default()
        })
    }))
}
