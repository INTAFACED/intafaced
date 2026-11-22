//! The ramp service's on-ramp half (`ramps/ramp-service.ts`): the programme, the live and fiat-settle probes, the
//! customer's on- and off-ramp lists, the operator's credit and the attempts health reads.
//!
//! IF THE PROCESS DIES EXACTLY HERE (`creditOnramp`: claim, then deposit)
//!
//! - After the claim, before the post: value is still outside the book. The pending row is the resumable marker; a
//!   re-drive with the same rail reference finishes the credit under `deposit:<rail>:<railRef>`.
//! - After the post, before `settled`: the person has the funds and the row is one status behind. The same re-drive posts
//!   the same key, which svc-ledger answers with the transaction it already booked, and the row catches up.

use postgres::Row;
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, js_trim, parse_amount};
use service_kit::time::Instant;

use super::rails::{self, assert_crypto, refuse_fiat};
use super::{Deps, Onramp};
use crate::earn::ms;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{at, in_tx, owner_list_limit, pg, with};

/// `fiatSettle`: names the rail ids, or refuses. Mode `none` refuses the socket first; posts nothing.
pub fn fiat_settle(o: &Onramp<'_>) -> Result<Json, Refusal> {
    let programme = o.programme();
    rails::assert_fiat_socket_when_none(&programme)?;
    let listed = o.w.pay_fiat.list()?;
    // Every programme is simulated: no live mode sets `simulated: false`.
    rails::assert_empty_rails_cannot_look_live(&listed, true, false)?;
    let onramp = rails::resolve_rail_id(o.w.pay_fiat.as_ref(), "onramp")?;
    let offramp = rails::resolve_rail_id(o.w.pay_fiat.as_ref(), "offramp")?;
    // A resolved pay rail is not an outside cash company while the programme is still simulated, which it always is.
    let _ = (onramp, offramp);
    Err(rails::live_ramp_unset())
}

/// One operator credit (`OnrampRecord`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credit {
    pub id: String,
    pub user_id: String,
    pub asset_id: String,
    pub amount: Amount,
    pub kind: String,
    pub rail: String,
    pub rail_ref: String,
    pub simulated: bool,
    pub status: String,
    pub ledger_tx_id: Option<String>,
    pub rejection_code: Option<String>,
    pub created_at: Instant,
}

fn credit_cols() -> String {
    format!(
        "id::text, user_id, asset_id, amount::text, kind::text, rail, rail_ref, simulated, status::text, ledger_tx_id, \
         rejection_code, {}",
        ms("created_at")
    )
}

impl Credit {
    fn from_row(r: &Row) -> Result<Credit, Refusal> {
        let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
        let o = |i: usize| r.try_get::<_, Option<String>>(i).map_err(|e| pg(&e));
        Ok(Credit {
            id: s(0)?,
            user_id: s(1)?,
            asset_id: s(2)?,
            amount: parse_amount(&s(3)?).map_err(Refusal::Other)?,
            kind: s(4)?,
            rail: s(5)?,
            rail_ref: s(6)?,
            simulated: r.try_get(7).map_err(|e| pg(&e))?,
            status: s(8)?,
            ledger_tx_id: o(9)?,
            rejection_code: o(10)?,
            created_at: Instant(r.try_get(11).map_err(|e| pg(&e))?),
        })
    }

    /// `ramps.onramps`' row.
    pub fn list_json(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("assetId", Json::str(self.asset_id.clone())),
            ("amount", Json::str(format_amount(self.amount))),
            ("kind", Json::str(self.kind.clone())),
            ("rail", Json::str(self.rail.clone())),
            ("railRef", Json::str(self.rail_ref.clone())),
            ("simulated", Json::Bool(self.simulated)),
            ("status", Json::str(self.status.clone())),
            (
                "ledgerTxId",
                self.ledger_tx_id.clone().map_or(Json::Null, Json::str),
            ),
            ("createdAt", Json::str(self.created_at.iso())),
        ])
    }
}

fn limit_of(limit: Option<f64>, code: &str, name: &str) -> Result<i64, Refusal> {
    owner_list_limit(limit, code, name)
}

/// `onrampsOf`: the customer's credits, newest first.
pub fn onramps_of(d: &Deps<'_>, user_id: &str, limit: Option<f64>) -> Result<Vec<Credit>, Refusal> {
    let page = limit_of(limit, "bank.onramps_list_limit_unset", "ramps.onramps")?;
    with(d.store, |c| {
        c.query(
            &format!(
                "SELECT {} FROM bank.ramp_onramps WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
                credit_cols()
            ),
            &[&user_id, &page],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(Credit::from_row)
        .collect()
    })
}

/// `offrampsOf`: the customer's off-ramps, newest first, as `ramps.offramps` answers them.
pub fn offramps_of(d: &Deps<'_>, user_id: &str, limit: Option<f64>) -> Result<Vec<Json>, Refusal> {
    let page = limit_of(limit, "bank.offramps_list_limit_unset", "ramps.offramps")?;
    with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT id::text, asset_id, amount::text, kind::text, rail, destination_ref, client_ref, simulated, \
                       status::text, hold_ledger_tx_id, settle_ledger_tx_id, {} \
                     FROM bank.ramp_offramps WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
                    ms("created_at")
                ),
                &[&user_id, &page],
            )
            .map_err(|e| pg(&e))?;
        rows.iter()
            .map(|r| {
                let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
                let o = |i: usize| {
                    r.try_get::<_, Option<String>>(i)
                        .map_err(|e| pg(&e))
                        .map(|v| v.map_or(Json::Null, Json::str))
                };
                Ok(Json::obj([
                    ("id", Json::str(s(0)?)),
                    ("assetId", Json::str(s(1)?)),
                    (
                        "amount",
                        Json::str(format_amount(parse_amount(&s(2)?).map_err(Refusal::Other)?)),
                    ),
                    ("kind", Json::str(s(3)?)),
                    ("rail", Json::str(s(4)?)),
                    ("destinationRef", Json::str(s(5)?)),
                    ("clientRef", Json::str(s(6)?)),
                    ("simulated", Json::Bool(r.try_get(7).map_err(|e| pg(&e))?)),
                    ("status", Json::str(s(8)?)),
                    ("holdLedgerTxId", o(9)?),
                    ("settleLedgerTxId", o(10)?),
                    (
                        "createdAt",
                        Json::str(Instant(r.try_get(11).map_err(|e| pg(&e))?).iso()),
                    ),
                ]))
            })
            .collect()
    })
}

/// What the operator credits.
pub struct CreditAsk<'a> {
    pub user_id: &'a str,
    pub asset_id: &'a str,
    pub amount: Amount,
    pub kind: &'a str,
    pub rail_ref: &'a str,
    pub credited_by: &'a str,
}

/// `assertRampAssetId`.
fn assert_asset_id(asset_id: &str) -> Result<(), Refusal> {
    let trimmed = js_trim(asset_id);
    if trimmed.is_empty() || trimmed != asset_id {
        return Err(refuse(
            "bank.ramp_invalid_asset",
            "Ramp asset id must be a non-empty crypto symbol with no leading or trailing whitespace",
        ));
    }
    Ok(())
}

/// `claimOnramp`: the pending row under (rail, railRef), or the one already there on the same terms.
fn claim(d: &Deps<'_>, ask: &CreditAsk<'_>, rail: &str) -> Result<Credit, Refusal> {
    in_tx(d.store, |tx| {
        let inserted = tx
            .query(
                &format!(
                    "INSERT INTO bank.ramp_onramps (user_id, asset_id, amount, kind, rail, rail_ref, simulated, credited_by, \
                       status) \
                     VALUES ($1, $2, $3::text::numeric, $4::text::bank.ramp_kind, $5, $6, true, $7, 'pending') \
                     ON CONFLICT (rail, rail_ref) DO NOTHING RETURNING {}",
                    credit_cols()
                ),
                &[
                    &ask.user_id,
                    &ask.asset_id,
                    &format_amount(ask.amount),
                    &ask.kind,
                    &rail,
                    &ask.rail_ref,
                    &ask.credited_by,
                ],
            )
            .map_err(|e| pg(&e))?;
        if let Some(row) = inserted.first() {
            return Credit::from_row(row);
        }
        let rows = tx
            .query(
                &format!(
                    "SELECT {} FROM bank.ramp_onramps WHERE rail = $1 AND rail_ref = $2 FOR UPDATE",
                    credit_cols()
                ),
                &[&rail, &ask.rail_ref],
            )
            .map_err(|e| pg(&e))?;
        let existing = rows
            .first()
            .map(Credit::from_row)
            .transpose()?
            .ok_or_else(|| Refusal::Other("the on-ramp claim vanished".to_owned()))?;
        if existing.user_id != ask.user_id
            || existing.asset_id != ask.asset_id
            || existing.amount != ask.amount
        {
            return Err(refuse(
                "bank.ramp_conflict",
                format!(
                    "Rail reference {}:{} was already credited as a different on-ramp",
                    existing.rail, existing.rail_ref
                ),
            ));
        }
        Ok(existing)
    })
}

/// `deposit` on svc-ledger's recipe door under `deposit:<rail>:<railRef>`; with the custodial layer off it refuses
/// `bank.no_partner_bank` before svc-ledger is asked (`custodyGuardedLedger`: a deposit moves a customer balance).
pub fn post_deposit(
    d: &Deps<'_>,
    user_id: &str,
    asset_id: &str,
    amount: Amount,
    rail: &str,
    rail_ref: &str,
) -> Result<String, Refusal> {
    if d.partner.custody_layer != "on" {
        return Err(refuse(
            "bank.no_partner_bank",
            "No banking partner holds this money, and INTAFACED holds no customer money, so nothing was moved.",
        ));
    }
    let input = Json::obj([
        ("userId", Json::str(user_id)),
        ("assetId", Json::str(asset_id)),
        ("amount", Json::str(format_amount(amount))),
        ("rail", Json::str(rail)),
        ("railRef", Json::str(rail_ref)),
    ]);
    d.ledger
        .post_recipe("deposit", &input, &format!("deposit:{rail}:{rail_ref}"))
        .map(|tx| tx.id)
        .map_err(|f| crate::transfers::moves::post_refusal(&f))
}

/// `creditOnramp`: the operator's credit from the crypto ledger rail. Kind fiat refuses before any row or post.
pub fn credit_onramp(d: &Deps<'_>, o: &Onramp<'_>, ask: &CreditAsk<'_>) -> Result<Credit, Refusal> {
    if ask.kind == "fiat" {
        return Err(refuse_fiat());
    }
    if ask.amount <= 0 {
        return Err(refuse(
            "bank.ramp_invalid_amount",
            "On-ramp amount must be positive",
        ));
    }
    assert_asset_id(ask.asset_id)?;
    let rail = assert_crypto(&o.programme())?;
    let claimed = claim(d, ask, rail)?;
    if claimed.status == "settled" {
        return Ok(claimed);
    }
    if claimed.status == "rejected" {
        return Err(refuse(
            "bank.ramp_conflict",
            claimed
                .rejection_code
                .clone()
                .unwrap_or_else(|| "On-ramp previously rejected".to_owned()),
        ));
    }
    let tx_id = post_deposit(
        d,
        &claimed.user_id,
        &claimed.asset_id,
        claimed.amount,
        &claimed.rail,
        &claimed.rail_ref,
    )?;
    with(d.store, |c| {
        c.execute(
            "UPDATE bank.ramp_onramps SET status = 'settled', ledger_tx_id = $1, settled_at = now() \
             WHERE id = $2::text::uuid AND status = 'pending'",
            &[&tx_id, &claimed.id],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(Credit {
        status: "settled".to_owned(),
        ledger_tx_id: Some(tx_id),
        ..claimed
    })
}

/// One attempt health reads (`attemptsSince`'s row).
pub struct Attempt {
    pub rail: String,
    pub status: String,
    pub created_at: Instant,
    pub settled_at: Option<Instant>,
}

/// `attemptsSince`: on- and off-ramp attempts opened at or after `since`.
pub fn attempts_since(d: &Deps<'_>, since: Instant) -> Result<Vec<Attempt>, Refusal> {
    with(d.store, |c| {
        let mut out = Vec::new();
        for table in ["bank.ramp_onramps", "bank.ramp_offramps"] {
            let rows = c
                .query(
                    &format!(
                        "SELECT rail, status::text, {}, CASE WHEN settled_at IS NULL THEN NULL ELSE {} END \
                         FROM {table} WHERE created_at >= {}",
                        ms("created_at"),
                        ms("settled_at"),
                        at("$1")
                    ),
                    &[&since.0],
                )
                .map_err(|e| pg(&e))?;
            for r in &rows {
                out.push(Attempt {
                    rail: r.try_get(0).map_err(|e| pg(&e))?,
                    status: r.try_get(1).map_err(|e| pg(&e))?,
                    created_at: Instant(r.try_get(2).map_err(|e| pg(&e))?),
                    settled_at: r
                        .try_get::<_, Option<i64>>(3)
                        .map_err(|e| pg(&e))?
                        .map(Instant),
                });
            }
        }
        Ok(out)
    })
}
