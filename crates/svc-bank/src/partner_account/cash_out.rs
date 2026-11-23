//! `cashOut.quote/start/requests/receipt`, the banking partner's job doors `/internal/jobs/payout-sim/*` and
//! `/internal/jobs/redrive-cash-outs`, and the recovery job `bank.recovery.redrive_cash_outs` (`cash-out/`).
//!
//! The customer enters an amount and picks a linked account. The entry checks come first: an amount above zero, no
//! more than the available balance (the ledger's, or the partner's when it holds the person's money), and an account
//! of theirs still linked. The quote then says what stands in the way, first reason first: the account unverified, its
//! cooling-off blank or running, or no partner that pays out this asset (`bank.fiat_ramp_socket`). Asking is kept
//! whatever the answer: refused with its reason (nothing held or posted), or `processing`, the amount taken into this
//! request's own hold (`withdraw.hold:cash-out:<id>`, or for a partner-held request one partner move under
//! `bank.cash-out:<id>`) and the partner asked to pay. The partner answers once, by its signed job door: paid (the hold
//! settled once), failed or cancelled (given back once), or returned (what came back credited once). Every step is keyed
//! by the request, so a retry or the re-drive job posts nothing twice. One request is driven at a time under its session
//! lock (`bank.cash-out`).

pub mod ledger;
pub mod payout_sim;
pub mod receipt;
pub mod security_lock;
pub mod session_lock;

use std::collections::BTreeMap;

use postgres::Row;
use postgres::types::ToSql;
use service_kit::http::UreqFetch;
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, js_trim, parse_amount};
use service_kit::s2s::{CallSigner, s2s_from_env};
use service_kit::schema::Value;
use service_kit::server::Response;
use service_kit::time::Instant;

use super::linked_accounts::{self, View as AccountView, is_uuid, store_err};
use super::rail_records::Movement;
use super::{Deps, refuse};
use crate::db::{StoreError, with_client};
use crate::door::Ctx;
use crate::door::jobs::job_refuse;
use crate::errors::Refusal;
use crate::partner::custody::{Custody, Held};
use crate::partner::{AccountRef, MoveRequest, balance_not_known, payouts_account};
use ledger::{Ledger, PostError, Recipe, Unwired, Withdrawal};
use payout_sim::Partner;
use security_lock::{Identity, SecurityLock, Unconfigured, assert_holds_open};
use session_lock::{Gate, with_lock};

/// What this part holds, built once from the environment (`composeCashOutArea` with `index.ts`'s options).
pub struct Wiring {
    /// `cashOutPartnerFor(BANK_PAYOUT_PARTNER, ...)`: the TEST stand-in, or none (every cash-out kept refused).
    pub partner: Option<Partner>,
    /// `root.receiptSecret` (`INTERNAL_SERVICE_SECRET`): blank, no receipt is made.
    pub receipt_secret: Option<String>,
    /// The owner's security lock, asked of svc-identity; with no `IDENTITY_URL` every ask refuses.
    pub security_lock: Box<dyn SecurityLock>,
    /// svc-ledger's reads and the cash-out's four recipes (`ledger`).
    pub ledger: Box<dyn Ledger>,
    /// The session lock's slots (`DATABASE_POOL_MAX`).
    pub gate: Gate,
}

impl Wiring {
    pub fn from_env(env: &BTreeMap<String, String>) -> Result<Wiring, String> {
        let raw = |k: &str| env.get(k).map(String::as_str);
        let records = raw("BANK_PAYOUT_SIM_RECORDS_DIR")
            .map(js_trim)
            .filter(|d| !d.is_empty());
        let partner = payout_sim::partner_for(
            raw("BANK_PAYOUT_PARTNER").unwrap_or("none"),
            raw("BANK_PAYOUT_SIM_JSON"),
            raw("APP_ENV"),
            raw("NODE_ENV"),
            records,
        )?;
        let secret = raw("INTERNAL_SERVICE_SECRET")
            .unwrap_or_default()
            .to_owned();
        let security_lock: Box<dyn SecurityLock> =
            match raw("IDENTITY_URL").filter(|u| !u.is_empty()) {
                Some(url) => {
                    let s2s = s2s_from_env(
                        raw("S2S_AUTH_MODE").unwrap_or("off"),
                        raw("S2S_KEYRING"),
                        raw("S2S_SIGNING_KID"),
                        raw("S2S_SIGNING_KEY"),
                        "svc-bank",
                    )?;
                    let pair = match (s2s.signer, s2s.mode) {
                        (Some(signer), Some(mode)) => Some((signer, mode)),
                        _ => None,
                    };
                    Box::new(Identity {
                        base_url: url.to_owned(),
                        fetch: Box::new(UreqFetch::new()),
                        signer: CallSigner::new("svc-bank", "svc-identity", &secret, pair),
                    })
                }
                None => Box::new(Unconfigured),
            };
        Ok(Wiring {
            partner,
            receipt_secret: Some(secret).filter(|s| !s.is_empty()),
            security_lock,
            ledger: match super::recovery::call_signer(env, "svc-ledger")? {
                None => Box::new(Unwired),
                Some(signer) => Box::new(ledger::HttpLedger(Box::new(
                    crate::spaces::ports::LedgerHttp::new(
                        raw("LEDGER_URL").unwrap_or("http://localhost:4001"),
                        signer,
                        Box::new(UreqFetch::new()),
                    ),
                ))),
            },
            gate: Gate::new(
                raw("DATABASE_POOL_MAX")
                    .and_then(|v| js_trim(v).parse::<usize>().ok())
                    .unwrap_or(2),
            ),
        })
    }
}

const LOCK: &str = "bank.cash-out";
/// `CASH_OUT_RECEIPT_INFO`.
const RECEIPT_INFO: &str = "bank.cash-out.receipt.v1";

/// `cashOutWithdrawalId`, the partner-move keys, and the stand-in's paid record key.
pub fn withdrawal_id(id: &str) -> String {
    format!("cash-out:{id}")
}
pub fn move_key(id: &str) -> String {
    format!("bank.cash-out:{id}")
}
pub fn back_key(id: &str) -> String {
    format!("bank.cash-out-back:{id}")
}
pub fn return_key(id: &str) -> String {
    format!("bank.cash-out-return:{id}")
}
fn paid_key(id: &str) -> String {
    format!("{}:paid", withdrawal_id(id))
}

/// One stored request (`RequestRow`), its times in epoch milliseconds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Req {
    pub id: String,
    pub user_id: String,
    pub asset_id: String,
    pub amount: String,
    pub linked_account_id: String,
    pub rail: String,
    pub status: String,
    pub refusal_code: Option<String>,
    pub payout_rail: Option<String>,
    pub payout_ref: Option<String>,
    pub fee: Option<String>,
    pub receive_amount: Option<String>,
    pub receive_currency: Option<String>,
    pub hold_ledger_tx_id: Option<String>,
    pub settle_ledger_tx_id: Option<String>,
    pub reverse_ledger_tx_id: Option<String>,
    pub failure_code: Option<String>,
    pub returned_amount: Option<String>,
    pub return_ledger_tx_id: Option<String>,
    pub custodian: Option<String>,
    pub partner_move_id: Option<String>,
    pub partner_back_move_id: Option<String>,
    pub partner_return_move_id: Option<String>,
    pub drive_refused_at: Option<i64>,
    pub stray_checked_at: Option<i64>,
    pub created_at: i64,
    pub completed_at: Option<i64>,
    pub failed_at: Option<i64>,
    pub cancelled_at: Option<i64>,
    pub returned_at: Option<i64>,
}

const COLS: &str = "id::text, user_id, asset_id, amount::text, linked_account_id::text, rail, status, refusal_code, \
    payout_rail, payout_ref, fee::text, receive_amount::text, receive_currency, hold_ledger_tx_id, settle_ledger_tx_id, \
    reverse_ledger_tx_id, failure_code, returned_amount::text, return_ledger_tx_id, custodian, partner_move_id, \
    partner_back_move_id, partner_return_move_id, \
    (floor(extract(epoch FROM drive_refused_at) * 1000))::int8, \
    (floor(extract(epoch FROM stray_checked_at) * 1000))::int8, \
    (floor(extract(epoch FROM created_at) * 1000))::int8, \
    (floor(extract(epoch FROM completed_at) * 1000))::int8, \
    (floor(extract(epoch FROM failed_at) * 1000))::int8, \
    (floor(extract(epoch FROM cancelled_at) * 1000))::int8, \
    (floor(extract(epoch FROM returned_at) * 1000))::int8";

fn req_of(r: &Row) -> Result<Req, StoreError> {
    let s = |i: usize| r.try_get::<_, String>(i).map_err(StoreError::from);
    let o = |i: usize| r.try_get::<_, Option<String>>(i).map_err(StoreError::from);
    let t = |i: usize| r.try_get::<_, Option<i64>>(i).map_err(StoreError::from);
    Ok(Req {
        id: s(0)?,
        user_id: s(1)?,
        asset_id: s(2)?,
        amount: s(3)?,
        linked_account_id: s(4)?,
        rail: s(5)?,
        status: s(6)?,
        refusal_code: o(7)?,
        payout_rail: o(8)?,
        payout_ref: o(9)?,
        fee: o(10)?,
        receive_amount: o(11)?,
        receive_currency: o(12)?,
        hold_ledger_tx_id: o(13)?,
        settle_ledger_tx_id: o(14)?,
        reverse_ledger_tx_id: o(15)?,
        failure_code: o(16)?,
        returned_amount: o(17)?,
        return_ledger_tx_id: o(18)?,
        custodian: o(19)?,
        partner_move_id: o(20)?,
        partner_back_move_id: o(21)?,
        partner_return_move_id: o(22)?,
        drive_refused_at: t(23)?,
        stray_checked_at: t(24)?,
        created_at: t(25)?.unwrap_or_default(),
        completed_at: t(26)?,
        failed_at: t(27)?,
        cancelled_at: t(28)?,
        returned_at: t(29)?,
    })
}

fn wiring<'a>(d: &'a Deps<'_>) -> &'a Wiring {
    &d.wiring.cash_out
}

fn rows(d: &Deps<'_>, sql: &str, params: &[&(dyn ToSql + Sync)]) -> Result<Vec<Req>, Refusal> {
    let pool = d.store.pool().map_err(store_err)?;
    with_client(pool, |c| c.query(sql, params)?.iter().map(req_of).collect()).map_err(store_err)
}

fn row_of(d: &Deps<'_>, id: &str) -> Result<Option<Req>, Refusal> {
    Ok(rows(
        d,
        &format!("SELECT {COLS} FROM bank.cash_out_requests WHERE id = $1::text::uuid"),
        &[&id],
    )?
    .into_iter()
    .next())
}

fn conflict(message: impl Into<String>) -> Refusal {
    refuse("bank.ramp_conflict", message)
}

fn is_code(r: &Refusal, code: &str) -> bool {
    matches!(r, Refusal::Bank(e) if e.row.code == code)
}

/// `moved`: update one request still in `from`, returning it as it now is; anything else is a conflict. `set`'s own
/// parameters start at `$3`.
fn moved(
    d: &Deps<'_>,
    id: &str,
    from: &str,
    set: &str,
    extra: &[&(dyn ToSql + Sync)],
) -> Result<Req, Refusal> {
    let mut params: Vec<&(dyn ToSql + Sync)> = vec![&id, &from];
    params.extend_from_slice(extra);
    rows(
        d,
        &format!(
            "UPDATE bank.cash_out_requests SET {set} WHERE id = $1::text::uuid AND status = $2 RETURNING {COLS}"
        ),
        &params,
    )?
    .into_iter()
    .next()
    .ok_or_else(|| conflict("The cash-out changed while it was being answered"))
}

const DRIVE_REFUSED: &str = "status = 'refused', refusal_code = 'bank.cash_out_over_available', payout_rail = NULL, drive_refused_at = now()";

fn amount_of(text: &str) -> Result<Amount, Refusal> {
    parse_amount(text).map_err(Refusal::Other)
}

/// Whether the amount was taken: the partner's move for a partner-held request, else the ledger hold.
fn is_taken(r: &Req) -> bool {
    if r.custodian.is_none() {
        r.hold_ledger_tx_id.is_some()
    } else {
        r.partner_move_id.is_some()
    }
}

fn withdrawal(r: &Req) -> Result<Withdrawal, Refusal> {
    Ok(Withdrawal {
        user_id: r.user_id.clone(),
        asset_id: r.asset_id.clone(),
        amount: amount_of(&r.amount)?,
        rail: r
            .payout_rail
            .clone()
            .ok_or_else(|| Refusal::Other("a cash-out with no payout rail".to_owned()))?,
        withdrawal_id: withdrawal_id(&r.id),
    })
}

/// `bookedHold`: as stamped, else as the ledger booked it under the request's key, else none.
fn booked_hold(d: &Deps<'_>, r: &Req) -> Result<Option<String>, Refusal> {
    if let Some(h) = &r.hold_ledger_tx_id {
        return Ok(Some(h.clone()));
    }
    if r.payout_rail.is_none() {
        return Ok(None);
    }
    wiring(d)
        .ledger
        .tx_by_key(&Recipe::WithdrawHold(withdrawal(r)?).idempotency_key())
}

fn partner_gone() -> Refusal {
    refuse(
        "bank.partner_unavailable",
        "The partner bank that holds this cash-out is not answering. Nothing was changed.",
    )
}

/// `heldBank`: the partner bank that holds a partner-held request's money; not answering refuses, nothing changed.
fn held_bank<'a>(custody: &'a Custody<'a>, r: &Req) -> Result<Held<'a>, Refusal> {
    match custody.bank_for(&r.user_id) {
        Some(bank) if Some(bank.label()) == r.custodian.as_deref() => Ok(bank),
        _ => Err(partner_gone()),
    }
}

fn partner_takes(w: &Wiring, r: &Req) -> bool {
    w.partner
        .as_ref()
        .is_some_and(|p| Some(p.rail.as_str()) == r.payout_rail.as_deref())
}

/// The owner's self-freeze, asked once per drive, before either step.
fn not_self_frozen(w: &Wiring, user_id: &str, checked: &mut bool) -> Result<(), Refusal> {
    if *checked {
        return Ok(());
    }
    let hold = w.security_lock.read(user_id)?;
    if hold.self_frozen {
        assert_holds_open(&hold, "a cash-out")?;
    }
    *checked = true;
    Ok(())
}

/// `drive`: take a `processing` request as far as it goes here: its hold, then the partner's acceptance. Refused and
/// answered requests come back unchanged.
fn drive(d: &Deps<'_>, row: Req) -> Result<Req, Refusal> {
    if row.status != "processing" || (is_taken(&row) && row.payout_ref.is_some()) {
        return Ok(row);
    }
    let w = wiring(d);
    with_lock(d.store, &w.gate, LOCK, &row.id, || {
        let mut now =
            row_of(d, &row.id)?.ok_or_else(|| Refusal::Other("the cash-out is gone".to_owned()))?;
        if now.status != "processing" {
            return Ok(now);
        }
        let mut frozen_checked = false;
        let custody = d.partner.custody(d.store);
        if now.custodian.is_some() && now.partner_move_id.is_none() {
            if !partner_takes(w, &now) {
                return Ok(now);
            }
            not_self_frozen(w, &now.user_id, &mut frozen_checked)?;
            let bank = held_bank(&custody, &now)?;
            let made = bank.move_(
                &MoveRequest {
                    key: move_key(&now.id),
                    from: AccountRef::main(&now.user_id, &now.asset_id),
                    to: payouts_account(&now.asset_id),
                    amount: amount_of(&now.amount)?,
                    payees: None,
                },
                d.now,
            );
            let move_id = match made {
                Ok(m) => m.id,
                // The partner balance moved since the quote: kept refused, nothing taken.
                Err(e) if is_code(&e, "bank.partner_insufficient_funds") => {
                    return moved(d, &now.id, "processing", DRIVE_REFUSED, &[]);
                }
                Err(e) => return Err(e),
            };
            match moved(
                d,
                &now.id,
                "processing",
                "partner_move_id = $3",
                &[&move_id],
            ) {
                Ok(r) => now = r,
                Err(err) => {
                    // The lock's connection dropped and another driver recorded the request refused before this move
                    // was made. A refused request took nothing: give it back.
                    let after = if is_code(&err, "bank.ramp_conflict") {
                        row_of(d, &now.id)?
                    } else {
                        None
                    };
                    return match after {
                        Some(a) if a.status == "refused" => give_back_refused(d, &custody, a),
                        _ => Err(err),
                    };
                }
            }
        }
        if now.custodian.is_none() && now.hold_ledger_tx_id.is_none() {
            if let Some(booked) = booked_hold(d, &now)? {
                // Held before, and the answer was lost: stamp that hold, never post another.
                now = moved(
                    d,
                    &now.id,
                    "processing",
                    "hold_ledger_tx_id = $3",
                    &[&booked],
                )?;
            } else if !partner_takes(w, &now) {
                // No partner here pays it: nothing is held. It stays processing for a hold that may yet land.
                return Ok(now);
            }
        }
        if now.custodian.is_none() && now.hold_ledger_tx_id.is_none() {
            not_self_frozen(w, &now.user_id, &mut frozen_checked)?;
            match w.ledger.post(&Recipe::WithdrawHold(withdrawal(&now)?)) {
                Ok(hold) => {
                    now = moved(d, &now.id, "processing", "hold_ledger_tx_id = $3", &[&hold])?
                }
                // The balance moved since the quote: kept refused, nothing held.
                Err(PostError::InsufficientFunds) => {
                    return moved(d, &now.id, "processing", DRIVE_REFUSED, &[]);
                }
                Err(PostError::Failed(e)) => return Err(e),
            }
        }
        if now.payout_ref.is_none() {
            let Some(partner) = w.partner.as_ref().filter(|_| partner_takes(w, &now)) else {
                // The partner that priced it is gone after the hold: the hold waits, visible, for its answer.
                return Ok(now);
            };
            not_self_frozen(w, &now.user_id, &mut frozen_checked)?;
            let payout_ref = partner.pay(&now.id);
            now = moved(d, &now.id, "processing", "payout_ref = $3", &[&payout_ref])?;
        }
        Ok(now)
    })
}

/// `giveBackRefused`: a partner-held request recorded refused whose order key still has a move goes back to the main
/// balance once, under the back key. With no move under the key, or already given back, it comes back unchanged.
fn give_back_refused(d: &Deps<'_>, custody: &Custody<'_>, row: Req) -> Result<Req, Refusal> {
    if row.status != "refused" || row.custodian.is_none() || row.partner_back_move_id.is_some() {
        return Ok(row);
    }
    let bank = held_bank(custody, &row)?;
    if bank.move_by_key(&move_key(&row.id)).is_none() {
        // Nothing to give back now: stamped, so the sweep asks again only while a stray move could still land.
        if row.drive_refused_at.is_none() {
            return Ok(row);
        }
        let stamped = rows(
            d,
            &format!(
                "UPDATE bank.cash_out_requests SET stray_checked_at = now() \
                  WHERE id = $1::text::uuid AND status = 'refused' AND partner_back_move_id IS NULL RETURNING {COLS}"
            ),
            &[&row.id],
        )?;
        return Ok(stamped.into_iter().next().unwrap_or(row));
    }
    let back = bank.move_(
        &MoveRequest {
            key: back_key(&row.id),
            from: payouts_account(&row.asset_id),
            to: AccountRef::main(&row.user_id, &row.asset_id),
            amount: amount_of(&row.amount)?,
            payees: None,
        },
        d.now,
    )?;
    rows(
        d,
        &format!(
            "UPDATE bank.cash_out_requests SET partner_back_move_id = $2 \
              WHERE id = $1::text::uuid AND status = 'refused' \
                AND (partner_back_move_id IS NULL OR partner_back_move_id = $2) RETURNING {COLS}"
        ),
        &[&row.id, &back.id],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| conflict("The cash-out changed while it was being given back"))
}

/// The amount above zero and the asset as a ledger symbol (`entry`).
fn entry(asset_id: &str, amount: &str) -> Result<(String, Amount), Refusal> {
    let asset = js_trim(asset_id).to_uppercase();
    let b = asset.as_bytes();
    if !(1..=16).contains(&b.len())
        || !b
            .iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
    {
        return Err(refuse(
            "bank.ramp_invalid_asset",
            "Choose the currency to cash out",
        ));
    }
    let a = parse_amount(js_trim(amount)).map_err(|_| {
        refuse(
            "bank.ramp_invalid_amount",
            "Enter an amount with up to 18 decimals",
        )
    })?;
    if !a.is_positive() {
        return Err(refuse(
            "bank.ramp_invalid_amount",
            "The amount to cash out must be above zero",
        ));
    }
    Ok((asset, a))
}

/// `CashOutQuoteView`.
#[derive(Debug, Clone)]
pub struct Quote {
    pub asset_id: String,
    pub amount: Amount,
    pub available: Amount,
    pub held_at: Option<String>,
    pub account: AccountView,
    pub price: Option<payout_sim::Price>,
    pub blocker: Option<&'static str>,
    pub stand_in: Option<String>,
}

fn opt(v: Option<&str>) -> Json {
    v.map_or(Json::Null, Json::str)
}

impl Quote {
    pub fn json(&self) -> Json {
        Json::obj([
            ("assetId", Json::str(&self.asset_id)),
            ("amount", Json::str(format_amount(self.amount))),
            ("available", Json::str(format_amount(self.available))),
            ("heldAt", opt(self.held_at.as_deref())),
            ("account", self.account.json()),
            ("rail", Json::str("rail.bank")),
            ("fee", opt(self.price.as_ref().map(|p| p.fee.as_str()))),
            (
                "receiveAmount",
                opt(self.price.as_ref().map(|p| p.receive_amount.as_str())),
            ),
            (
                "receiveCurrency",
                opt(self.price.as_ref().map(|p| p.receive_currency.as_str())),
            ),
            ("blocker", opt(self.blocker)),
            ("standIn", opt(self.stand_in.as_deref())),
        ])
    }
}

/// `quote`: the entry checks, then the account, then what stands in the way. Reads only.
pub fn quote(
    d: &Deps<'_>,
    user_id: &str,
    asset_id: &str,
    amount: &str,
    linked_id: &str,
) -> Result<Quote, Refusal> {
    let w = wiring(d);
    let (asset, amount) = entry(asset_id, amount)?;
    let custody = d.partner.custody(d.store);
    let held = custody.bank_for(user_id);
    let available = match &held {
        Some(bank) => {
            let b = bank.balance(&AccountRef::main(user_id, &asset), d.now);
            match (b.amount, b.as_of) {
                (Some(a), Some(_)) => a,
                _ => return Err(balance_not_known(b.label)),
            }
        }
        None => w.ledger.available(user_id, &asset)?,
    };
    if amount > available {
        return Err(refuse(
            "bank.cash_out_over_available",
            format!(
                "You can cash out up to {} {asset}, the balance available now",
                format_amount(available)
            ),
        ));
    }
    let account = linked_accounts::get(d, user_id, linked_id)?;
    let price = if account.blocker.is_none() {
        w.partner.as_ref().and_then(|p| p.price(&asset, amount))
    } else {
        None
    };
    Ok(Quote {
        blocker: account.blocker.or(if price.is_some() {
            None
        } else {
            Some("bank.fiat_ramp_socket")
        }),
        stand_in: price
            .as_ref()
            .and(w.partner.as_ref().map(|p| p.label.clone())),
        held_at: held.as_ref().map(|b| b.label().to_owned()),
        asset_id: asset,
        amount,
        available,
        account,
        price,
    })
}

/// `same`: the stored request, if it is this customer's and was asked on the same terms. Anything else is a conflict.
fn same(
    row: Req,
    user_id: &str,
    asset: &str,
    amount: Amount,
    linked: &str,
) -> Result<Req, Refusal> {
    let matches = row.user_id == user_id
        && row.asset_id == asset
        && parse_amount(&row.amount).ok() == Some(amount)
        && row.linked_account_id == linked;
    if !matches {
        return Err(conflict("This request id is already used on other terms"));
    }
    Ok(row)
}

/// `start`: kept refused with its reason, or held and handed to the partner.
pub fn start(
    d: &Deps<'_>,
    user_id: &str,
    request_id: &str,
    asset_id: &str,
    amount: &str,
    linked_id: &str,
) -> Result<Req, Refusal> {
    let w = wiring(d);
    let (asset, amount) = entry(asset_id, amount)?;
    let linked = js_trim(linked_id).to_lowercase();
    if let Some(prior) = row_of(d, request_id)? {
        return drive(d, same(prior, user_id, &asset, amount, &linked)?);
    }
    let q = quote(d, user_id, &asset, &format_amount(amount), &linked)?;
    let taken = q.blocker.is_none() && w.partner.is_some();
    // While the owner's security lock holds, no cash-out starts: asked before anything is written.
    if taken {
        assert_holds_open(&w.security_lock.read(user_id)?, "a cash-out")?;
    }
    let status = if taken { "processing" } else { "refused" };
    let refusal: Option<&str> = if taken { None } else { q.blocker };
    let rail: Option<String> = if taken {
        w.partner.as_ref().map(|p| p.rail.clone())
    } else {
        None
    };
    let fee = q.price.as_ref().map(|p| p.fee.clone());
    let receive = q.price.as_ref().map(|p| p.receive_amount.clone());
    let currency = q.price.as_ref().map(|p| p.receive_currency.clone());
    let custodian = if taken { q.held_at.clone() } else { None };
    let amount_text = format_amount(amount);
    let inserted = rows(
        d,
        &format!(
            "INSERT INTO bank.cash_out_requests ( \
               id, user_id, asset_id, amount, linked_account_id, status, refusal_code, \
               payout_rail, fee, receive_amount, receive_currency, custodian \
             ) VALUES ( \
               $1::text::uuid, $2, $3, $4::text::numeric, $5::text::uuid, $6, $7, \
               $8, $9::text::numeric, $10::text::numeric, $11, $12 \
             ) ON CONFLICT (id) DO NOTHING RETURNING {COLS}"
        ),
        &[
            &request_id,
            &user_id,
            &asset,
            &amount_text,
            &linked,
            &status,
            &refusal,
            &rail,
            &fee,
            &receive,
            &currency,
            &custodian,
        ],
    )?;
    let row = match inserted.into_iter().next() {
        Some(r) => r,
        None => {
            row_of(d, request_id)?.ok_or_else(|| conflict("The cash-out request was not stored"))?
        }
    };
    drive(d, same(row, user_id, &asset, amount, &linked)?)
}

/// `list`: the customer's own requests, newest first.
pub fn list(d: &Deps<'_>, user_id: &str, limit: i64) -> Result<Vec<Req>, Refusal> {
    rows(
        d,
        &format!(
            "SELECT {COLS} FROM bank.cash_out_requests WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2"
        ),
        &[&user_id, &limit],
    )
}

fn iso(ms: Option<i64>) -> Json {
    ms.map_or(Json::Null, |m| Json::str(Instant(m).iso()))
}

fn decimal_or_null(v: Option<&str>) -> Json {
    v.and_then(|t| parse_amount(t).ok())
        .map_or(Json::Null, |a| Json::str(format_amount(a)))
}

/// `view` (`CashOutRequestView`).
pub fn view(r: &Req) -> Json {
    let amount = parse_amount(&r.amount).unwrap_or(Amount::ZERO);
    let remains = match r.status.as_str() {
        "completed" => Json::str(format_amount(amount)),
        "returned" => Json::str(format_amount(
            amount
                - r.returned_amount
                    .as_deref()
                    .and_then(|t| parse_amount(t).ok())
                    .unwrap_or(Amount::ZERO),
        )),
        _ => Json::Null,
    };
    Json::obj([
        ("requestId", Json::str(&r.id)),
        ("assetId", Json::str(&r.asset_id)),
        ("amount", Json::str(format_amount(amount))),
        ("linkedAccountId", Json::str(&r.linked_account_id)),
        ("rail", Json::str(&r.rail)),
        ("status", Json::str(&r.status)),
        ("refusalCode", opt(r.refusal_code.as_deref())),
        ("fee", decimal_or_null(r.fee.as_deref())),
        (
            "receiveAmount",
            decimal_or_null(r.receive_amount.as_deref()),
        ),
        ("receiveCurrency", opt(r.receive_currency.as_deref())),
        ("payoutRef", opt(r.payout_ref.as_deref())),
        ("ledgerTxId", opt(r.settle_ledger_tx_id.as_deref())),
        ("heldAt", opt(r.custodian.as_deref())),
        ("partnerMoveId", opt(r.partner_move_id.as_deref())),
        ("failureCode", opt(r.failure_code.as_deref())),
        (
            "returnedAmount",
            decimal_or_null(r.returned_amount.as_deref()),
        ),
        ("remainsPaidOut", remains),
        ("createdAt", Json::str(Instant(r.created_at).iso())),
        ("completedAt", iso(r.completed_at)),
        ("failedAt", iso(r.failed_at)),
        ("cancelledAt", iso(r.cancelled_at)),
        ("returnedAt", iso(r.returned_at)),
    ])
}

/// `verifyAccount`: only the partner's signed call reaches this; with no partner it refuses `rail.bank`.
pub fn verify_account(d: &Deps<'_>, account_id: &str) -> Result<AccountView, Refusal> {
    if wiring(d).partner.is_none() {
        return Err(refuse(
            "rail.bank",
            "No banking partner verifies bank accounts in this build",
        ));
    }
    linked_accounts::verify(d, account_id)
}

/// `answer`: one partner answer on one request, under the request's lock.
fn answer_for(
    d: &Deps<'_>,
    id: &str,
    act: impl FnOnce(&Partner, Req) -> Result<Req, Refusal>,
) -> Result<Req, Refusal> {
    let w = wiring(d);
    with_lock(d.store, &w.gate, LOCK, id, || {
        let row = row_of(d, id)?
            .ok_or_else(|| refuse("bank.cash_out_not_found", "No cash-out with this id"))?;
        // Only the partner that took it answers for it: with none here, or another one, nothing moves.
        let Some(partner) = w.partner.as_ref().filter(|_| partner_takes(w, &row)) else {
            return Err(refuse(
                "rail.bank",
                "No banking partner here answers for this cash-out",
            ));
        };
        act(partner, row)
    })
}

/// `onRail`: a TEST stand-in's own record of a movement on its rail; one the rail already contradicts is a conflict.
fn on_rail(partner: &Partner, m: &Movement) -> Result<(), Refusal> {
    let Some(records) = &partner.records else {
        return Ok(());
    };
    records.record(m).map_err(|e| {
        if e.conflict {
            conflict(e.message)
        } else {
            Refusal::Other(e.message)
        }
    })
}

/// `complete`: the partner paid it; the hold settles to the partner's rail, once.
pub fn complete(d: &Deps<'_>, id: &str) -> Result<Req, Refusal> {
    answer_for(d, id, |partner, row| {
        if row.status == "completed" {
            return Ok(row);
        }
        let (Some(payout_ref), Some(_)) = (row.payout_ref.clone(), row.payout_rail.as_ref()) else {
            return Err(conflict(format!(
                "This cash-out is {} and cannot be marked paid",
                row.status
            )));
        };
        if row.status != "processing" || !is_taken(&row) {
            return Err(conflict(format!(
                "This cash-out is {} and cannot be marked paid",
                row.status
            )));
        }
        // Partner-held: the amount already left the partner balance once; paid closes it, and the ledger posts nothing.
        if row.custodian.is_some() {
            return moved(
                d,
                &row.id,
                "processing",
                "status = 'completed', completed_at = now()",
                &[],
            );
        }
        // A TEST stand-in records what it paid in its own words first: if the post then fails, the rail shows the gap.
        on_rail(
            partner,
            &Movement {
                key: paid_key(&row.id),
                direction: "out",
                asset_id: row.asset_id.clone(),
                amount: amount_of(&row.amount)?,
                reference: Some(payout_ref),
            },
        )?;
        let settled = wiring(d)
            .ledger
            .post(&Recipe::WithdrawSettle(withdrawal(&row)?))
            .map_err(post_failure)?;
        moved(
            d,
            &row.id,
            "processing",
            "status = 'completed', settle_ledger_tx_id = $3, completed_at = now()",
            &[&settled],
        )
    })
}

/// An `InsufficientFundsError` the TypeScript does not catch here: thrown on, as the guard would see it.
fn post_failure(e: PostError) -> Refusal {
    match e {
        PostError::InsufficientFunds => Refusal::Other("insufficient funds".to_owned()),
        PostError::Failed(r) => r,
    }
}

/// `fail` and `cancel` (`unpaid`): the amount comes back once, with the partner's reason.
pub fn unpaid(d: &Deps<'_>, id: &str, status: &str, reason: &str) -> Result<Req, Refusal> {
    let at = if status == "failed" {
        "failed_at = now()"
    } else {
        "cancelled_at = now()"
    };
    answer_for(d, id, |partner, row| {
        if row.status == status && row.failure_code.as_deref() == Some(reason) {
            return Ok(row);
        }
        if row.status != "processing" || row.payout_rail.is_none() {
            return Err(conflict(format!(
                "This cash-out is {} and cannot be marked {status}",
                row.status
            )));
        }
        if row.custodian.is_some() {
            // Partner-held: what the partner took under the order key comes back once, under its own key. Asked of the
            // partner, not the row, so a move whose answer was lost is given back too.
            let custody = d.partner.custody(d.store);
            let bank = held_bank(&custody, &row)?;
            let took = match &row.partner_move_id {
                Some(m) => Some(m.clone()),
                None => bank.move_by_key(&move_key(&row.id)).map(|m| m.id),
            };
            let back = match &took {
                Some(_) => Some(
                    bank.move_(
                        &MoveRequest {
                            key: back_key(&row.id),
                            from: payouts_account(&row.asset_id),
                            to: AccountRef::main(&row.user_id, &row.asset_id),
                            amount: amount_of(&row.amount)?,
                            payees: None,
                        },
                        d.now,
                    )?
                    .id,
                ),
                None => None,
            };
            return moved(
                d,
                &row.id,
                "processing",
                &format!(
                    "status = $3, failure_code = $4, partner_move_id = $5, partner_back_move_id = $6, {at}"
                ),
                &[&status, &reason, &took, &back],
            );
        }
        // A TEST stand-in that already recorded this payout as paid cannot also say it failed: the settle is retried.
        if let Some(records) = &partner.records
            && records
                .has(&paid_key(&row.id))
                .map_err(|e| Refusal::Other(e.message))?
        {
            return Err(conflict(
                "The payout stand-in already recorded this cash-out as paid; say paid again",
            ));
        }
        // The ledger, not the row, says whether it was held: a hold it booked whose answer was lost is given back too.
        let reversed = match booked_hold(d, &row)? {
            Some(_) => Some(
                wiring(d)
                    .ledger
                    .post(&Recipe::WithdrawReverse(withdrawal(&row)?))
                    .map_err(post_failure)?,
            ),
            None => None,
        };
        moved(
            d,
            &row.id,
            "processing",
            &format!("status = $3, failure_code = $4, reverse_ledger_tx_id = $5, {at}"),
            &[&status, &reason, &reversed],
        )
    })
}

/// `returned`: the receiving bank sent a paid-out amount back, in full or in part; credited once. The same return
/// again answers the same.
pub fn returned(
    d: &Deps<'_>,
    id: &str,
    amount: &str,
    asset_id: &str,
    reason: &str,
) -> Result<Req, Refusal> {
    let back = parse_amount(amount).map_err(|_| {
        refuse(
            "bank.ramp_invalid_amount",
            "The returned amount is not an amount",
        )
    })?;
    answer_for(d, id, |partner, row| {
        if row.status == "returned" {
            let same_back = row
                .returned_amount
                .as_deref()
                .and_then(|t| parse_amount(t).ok())
                == Some(back);
            if same_back && row.failure_code.as_deref() == Some(reason) {
                return Ok(row);
            }
            return Err(conflict("This cash-out already came back on other terms"));
        }
        let Some(rail) = row
            .payout_rail
            .clone()
            .filter(|_| row.status == "completed")
        else {
            return Err(conflict(format!(
                "This cash-out is {}; only a paid-out one can come back",
                row.status
            )));
        };
        // The partner states what came back in the asset that left, at its own rate back.
        if js_trim(asset_id).to_uppercase() != row.asset_id {
            return Err(refuse(
                "bank.ramp_invalid_asset",
                format!(
                    "What came back is stated in {}, the asset that left",
                    row.asset_id
                ),
            ));
        }
        if !back.is_positive() || back > amount_of(&row.amount)? {
            return Err(refuse(
                "bank.ramp_invalid_amount",
                "What came back must be above zero and no more than was paid out",
            ));
        }
        let back_text = format_amount(back);
        if row.custodian.is_some() {
            let custody = d.partner.custody(d.store);
            let credited = held_bank(&custody, &row)?.move_(
                &MoveRequest {
                    key: return_key(&row.id),
                    from: payouts_account(&row.asset_id),
                    to: AccountRef::main(&row.user_id, &row.asset_id),
                    amount: back,
                    payees: None,
                },
                d.now,
            )?;
            return moved(
                d,
                &row.id,
                "completed",
                "status = 'returned', returned_amount = $3::text::numeric, failure_code = $4, \
                 partner_return_move_id = $5, returned_at = now()",
                &[&back_text, &reason, &credited.id],
            );
        }
        on_rail(
            partner,
            &Movement {
                key: format!("{}:returned", withdrawal_id(&row.id)),
                direction: "in",
                asset_id: row.asset_id.clone(),
                amount: back,
                reference: None,
            },
        )?;
        let credited = wiring(d)
            .ledger
            .post(&Recipe::Deposit {
                user_id: row.user_id.clone(),
                asset_id: row.asset_id.clone(),
                amount: back,
                rail,
                rail_ref: format!("cash-out-return:{}", row.id),
            })
            .map_err(post_failure)?;
        moved(
            d,
            &row.id,
            "completed",
            "status = 'returned', returned_amount = $3::text::numeric, failure_code = $4, \
             return_ledger_tx_id = $5, returned_at = now()",
            &[&back_text, &reason, &credited],
        )
    })
}

/// One re-drive outcome: the request, `completed` or `failed`, and why it failed.
pub type Outcome = (String, &'static str, Option<String>);

fn code_of(e: &Refusal) -> String {
    match e {
        Refusal::Bank(b) => b.row.code.to_owned(),
        _ => "bank.cash_out_redrive_failed".to_owned(),
    }
}

/// `redrive(limit)`: requests left `processing` before their hold or the partner's acceptance, oldest first, driven
/// on; then partner-held requests a drive refused whose order key has a move nobody gave back, given back once.
pub fn redrive(d: &Deps<'_>, limit: i64) -> Result<Vec<Outcome>, Refusal> {
    let left = rows(
        d,
        &format!(
            "SELECT {COLS} FROM bank.cash_out_requests \
              WHERE status = 'processing' \
                AND (payout_ref IS NULL OR (custodian IS NULL AND hold_ledger_tx_id IS NULL) \
                     OR (custodian IS NOT NULL AND partner_move_id IS NULL)) \
                AND created_at < now() - interval '1 minute' \
              ORDER BY created_at ASC LIMIT $1"
        ),
        &[&limit],
    )?;
    let mut out: Vec<Outcome> = Vec::new();
    for row in left {
        let id = row.id.clone();
        match drive(d, row) {
            Ok(after) if after.status == "processing" && after.payout_ref.is_none() => {
                out.push((id, "failed", Some("bank.cash_out_partner_gone".to_owned())));
            }
            Ok(_) => out.push((id, "completed", None)),
            // One that cannot be driven now does not stop the others: it is picked up on the next pass.
            Err(e) => out.push((id, "failed", Some(code_of(&e)))),
        }
    }
    let refused = rows(
        d,
        &format!(
            "SELECT {COLS} FROM bank.cash_out_requests \
              WHERE status = 'refused' AND custodian IS NOT NULL AND partner_back_move_id IS NULL \
                AND drive_refused_at IS NOT NULL AND drive_refused_at < now() - interval '1 minute' \
                AND (stray_checked_at IS NULL \
                     OR (stray_checked_at < drive_refused_at + interval '1 day' AND stray_checked_at < now() - interval '1 hour')) \
              ORDER BY coalesce(stray_checked_at, drive_refused_at) ASC, id ASC LIMIT $1"
        ),
        &[&limit],
    )?;
    let w = wiring(d);
    for row in refused {
        let id = row.id.clone();
        let custody = d.partner.custody(d.store);
        let given = with_lock(d.store, &w.gate, LOCK, &id, || {
            let now =
                row_of(d, &id)?.ok_or_else(|| Refusal::Other("the cash-out is gone".to_owned()))?;
            give_back_refused(d, &custody, now)
        });
        match given {
            Ok(after) if after.partner_back_move_id.is_some() => out.push((id, "completed", None)),
            Ok(_) => {}
            Err(e) => out.push((id, "failed", Some(code_of(&e)))),
        }
    }
    Ok(out)
}

/// `receipt`: the signed receipt of a cash-out that was paid. The same cash-out in the same state gives the same bytes.
pub fn receipt(d: &Deps<'_>, user_id: &str, id: &str) -> Result<Json, Refusal> {
    let not_found = || refuse("bank.cash_out_not_found", "No cash-out with this id");
    let row = row_of(d, id)?
        .filter(|r| r.user_id == user_id)
        .ok_or_else(not_found)?;
    let paid = row.settle_ledger_tx_id.is_some() || row.partner_move_id.is_some();
    let (true, true, Some(completed_at)) = (
        row.status == "completed" || row.status == "returned",
        paid,
        row.completed_at,
    ) else {
        return Err(refuse(
            "bank.cash_out_receipt_not_ready",
            "This cash-out was not paid out, so it has no receipt",
        ));
    };
    let secret = wiring(d)
        .receipt_secret
        .as_deref()
        .map(js_trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            refuse(
                "bank.cash_out_receipt_signing_unset",
                "No receipt signing key is set",
            )
        })?;
    let (holder, masked) = linked_accounts::payout_details(d, user_id, &row.linked_account_id)?;
    let line = |v: Option<&str>| receipt::one_line(v);
    let sent = amount_of(&row.amount)?;
    let back = if row.status == "returned" {
        row.returned_amount.as_deref().map(amount_of).transpose()?
    } else {
        None
    };
    let fmt = |v: Option<&str>| {
        v.and_then(|t| parse_amount(t).ok())
            .map(format_amount)
            .unwrap_or_default()
    };
    let mut text = vec![
        "INTAFACED receipt: cash out".to_owned(),
        format!("Cash out: {}", row.id),
        format!("Created (UTC): {}", Instant(row.created_at).iso()),
        format!("Paid out (UTC): {}", Instant(completed_at).iso()),
        format!("Status: {}", row.status),
        format!("Sent: {} {}", format_amount(sent), row.asset_id),
        format!(
            "Fee: {} {}",
            fmt(row.fee.as_deref()),
            line(row.receive_currency.as_deref())
        ),
        format!(
            "Arrives: {} {}",
            fmt(row.receive_amount.as_deref()),
            line(row.receive_currency.as_deref())
        ),
        format!("To: {} · {}", line(Some(&holder)), line(Some(&masked))),
        format!("Payout reference: {}", line(row.payout_ref.as_deref())),
    ];
    if row.custodian.is_none() {
        text.push(format!(
            "Ledger transaction: {}",
            row.settle_ledger_tx_id.as_deref().unwrap_or("null")
        ));
    } else {
        text.push(format!("Held at: {}", line(row.custodian.as_deref())));
        text.push(format!(
            "Partner payout: {}",
            line(row.partner_move_id.as_deref())
        ));
    }
    if let (Some(back), Some(returned_at)) = (back, row.returned_at) {
        text.push(format!("Came back (UTC): {}", Instant(returned_at).iso()));
        text.push(format!(
            "Came back: {} {} ({})",
            format_amount(back),
            row.asset_id,
            line(row.failure_code.as_deref())
        ));
        text.push(format!(
            "Stays paid out: {} {}",
            format_amount(sent - back),
            row.asset_id
        ));
        text.push(if row.custodian.is_none() {
            format!(
                "Return ledger transaction: {}",
                line(row.return_ledger_tx_id.as_deref())
            )
        } else {
            format!(
                "Partner return: {}",
                line(row.partner_return_move_id.as_deref())
            )
        });
    }
    text.push(String::new());
    let text = text.join("\n");
    let (sha256, signature) = receipt::sign(&text, secret, RECEIPT_INFO);
    Ok(Json::obj([
        ("fileName", Json::str(format!("receipt-{}.txt", row.id))),
        ("text", Json::str(text)),
        ("ledgerTxId", opt(row.settle_ledger_tx_id.as_deref())),
        ("partnerMoveId", opt(row.partner_move_id.as_deref())),
        ("sha256", Json::str(sha256)),
        ("signature", Json::str(signature)),
    ]))
}

fn text(v: &Value, key: &str) -> String {
    v.get(key).as_str().unwrap_or_default().to_owned()
}

/// The answer of one of this part's calls, by its path; `None` for a path outside it.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let user = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    let i = &ctx.input;
    Some(match ctx.call.path {
        "cashOut.quote" => quote(
            d,
            user,
            &text(i, "assetId"),
            &text(i, "amount"),
            &text(i, "linkedAccountId"),
        )
        .map(|q| q.json()),
        "cashOut.start" => start(
            d,
            user,
            &text(i, "requestId"),
            &text(i, "assetId"),
            &text(i, "amount"),
            &text(i, "linkedAccountId"),
        )
        .map(|r| view(&r)),
        "cashOut.requests" => {
            #[allow(
                clippy::cast_possible_truncation,
                reason = "the schema holds limit to an integer in 1..=50"
            )]
            let limit = i.get("limit").as_number().unwrap_or(1.0) as i64;
            list(d, user, limit).map(|rs| Json::Array(rs.iter().map(view).collect()))
        }
        "cashOut.receipt" => receipt(d, user, &text(i, "requestId")),
        _ => return None,
    })
}

/// zod's `z.string().uuid()` (any version, or the nil and max uuids).
fn zod_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    if s == "00000000-0000-0000-0000-000000000000" || s == "ffffffff-ffff-ffff-ffff-ffffffffffff" {
        return true;
    }
    is_uuid(s)
        && b.get(14).is_some_and(|c| (b'1'..=b'8').contains(c))
        && b.get(19)
            .is_some_and(|c| matches!(c, b'8' | b'9' | b'a' | b'b' | b'A' | b'B'))
}

fn decimal(s: &str) -> bool {
    let (whole, frac) = match s.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (s, None),
    };
    !whole.is_empty()
        && whole.bytes().all(|c| c.is_ascii_digit())
        && frac.is_none_or(|f| (1..=18).contains(&f.len()) && f.bytes().all(|c| c.is_ascii_digit()))
}

/// A job body held to its zod schema (`job-bodies.ts`): a strict object with these keys, each passing its check.
type Check = fn(&Value) -> bool;

fn body_of<'a>(body: &'a Value, keys: &[(&str, Check)]) -> Option<&'a Value> {
    static EMPTY: Value = Value::Object(Vec::new());
    // `req.body ?? {}`.
    let body = match body {
        Value::Undefined | Value::Null => &EMPTY,
        b => b,
    };
    let Value::Object(fields) = body else {
        return None;
    };
    if fields
        .iter()
        .any(|(k, _)| !keys.iter().any(|(name, _)| name == k))
    {
        return None;
    }
    keys.iter().all(|(k, ok)| ok(body.get(k))).then_some(body)
}

fn uuid_field(v: &Value) -> bool {
    v.as_str().is_some_and(zod_uuid)
}

fn job_answer(out: Result<Json, Refusal>) -> Response {
    match out {
        Ok(j) => Response {
            status: 200,
            body: j.compact(),
        },
        Err(Refusal::Bank(e)) => job_refuse(&e),
        Err(Refusal::Trpc(e)) => internal(&e.message),
        Err(Refusal::Other(m)) => internal(&m),
    }
}

/// A thrown error that is no `BankError`: Fastify's own 500.
fn internal(message: &str) -> Response {
    Response {
        status: 500,
        body: Json::obj([
            ("statusCode", Json::int(500)),
            ("error", Json::str("Internal Server Error")),
            ("message", Json::str(message)),
        ])
        .compact(),
    }
}

fn redrive_counts(outcomes: &[Outcome]) -> Json {
    let names: Vec<&str> = outcomes.iter().map(|o| o.1).collect();
    let c = crate::recovery::recovery_counts(&names);
    let n = |v: usize| Json::int(i64::try_from(v).unwrap_or(i64::MAX));
    Json::obj([
        ("scanned", n(c.scanned)),
        ("resolved", n(c.resolved)),
        ("stillUnknown", n(c.still_unknown)),
    ])
}

/// The answer of one of this part's job doors past its signature (`jobDoor` in `index.ts`): the body's 400, then the
/// work, a `BankError` as 400.
pub fn job(d: &Deps<'_>, path: &str, body: &Value) -> Option<Response> {
    fn failure(v: &Value) -> bool {
        v.as_str()
            .is_some_and(|s| payout_sim::FAILURES.contains(&s))
    }
    fn cancel(v: &Value) -> bool {
        v.as_str().is_some_and(|s| payout_sim::CANCELS.contains(&s))
    }
    fn back(v: &Value) -> bool {
        v.as_str().is_some_and(|s| payout_sim::RETURNS.contains(&s))
    }
    fn amount(v: &Value) -> bool {
        v.as_str().is_some_and(decimal)
    }
    fn asset(v: &Value) -> bool {
        v.as_str().is_some_and(|s| {
            (1..=16).contains(&s.len())
                && s.bytes()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        })
    }
    fn limit(v: &Value) -> bool {
        matches!(v, Value::Number(n) if n.fract() == 0.0 && (1.0..=1000.0).contains(n))
    }
    let keys: &[(&str, Check)] = match path {
        "/internal/jobs/payout-sim/verify" => &[("accountId", uuid_field)],
        "/internal/jobs/payout-sim/paid" => &[("cashOutId", uuid_field)],
        "/internal/jobs/payout-sim/failed" => &[("cashOutId", uuid_field), ("reason", failure)],
        "/internal/jobs/payout-sim/cancelled" => &[("cashOutId", uuid_field), ("reason", cancel)],
        "/internal/jobs/payout-sim/returned" => &[
            ("cashOutId", uuid_field),
            ("amount", amount),
            ("assetId", asset),
            ("reason", back),
        ],
        "/internal/jobs/redrive-cash-outs" => &[("limit", limit)],
        _ => return None,
    };
    let Some(b) = body_of(body, keys) else {
        return Some(Response {
            status: 400,
            body: Json::obj([
                ("error", Json::str("body not in shape")),
                ("code", Json::str("bank.validation_failed")),
            ])
            .compact(),
        });
    };
    let id = text(b, "cashOutId");
    let reason = text(b, "reason");
    let out = match path {
        "/internal/jobs/payout-sim/verify" => {
            verify_account(d, &text(b, "accountId")).map(|v| v.json())
        }
        "/internal/jobs/payout-sim/paid" => complete(d, &id).map(|r| view(&r)),
        "/internal/jobs/payout-sim/failed" => unpaid(d, &id, "failed", &reason).map(|r| view(&r)),
        "/internal/jobs/payout-sim/cancelled" => {
            unpaid(d, &id, "cancelled", &reason).map(|r| view(&r))
        }
        "/internal/jobs/payout-sim/returned" => {
            returned(d, &id, &text(b, "amount"), &text(b, "assetId"), &reason).map(|r| view(&r))
        }
        _ => {
            #[allow(
                clippy::cast_possible_truncation,
                reason = "held to an integer in 1..=1000 above"
            )]
            let n = b.get("limit").as_number().unwrap_or(1.0) as i64;
            redrive(d, n).map(|o| redrive_counts(&o))
        }
    };
    Some(job_answer(out))
}

/// The recovery job `bank.recovery.redrive_cash_outs`: one pass of `redrive` over the timer's batch, each row's outcome.
pub fn recovery(d: &Deps<'_>, batch: u32) -> Result<Vec<String>, String> {
    redrive(d, i64::from(batch))
        .map(|o| {
            o.into_iter()
                .map(|(_, outcome, _)| outcome.to_owned())
                .collect()
        })
        .map_err(|e| match e {
            Refusal::Bank(b) => b.message,
            Refusal::Trpc(t) => t.message,
            Refusal::Other(m) => m,
        })
}
