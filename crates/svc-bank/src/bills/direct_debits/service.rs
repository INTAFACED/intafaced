//! `DirectDebitService` (`direct-debits/direct-debits.ts`): Direct Debit mandates and their collections (BK-xfer-11,
//! J-bank-06 #4).
//!
//! A mandate is set up by a creditor through the scheme, never by the person: the scheme's door is a signed job call, and
//! on the stack the TEST stand-in (`dd-sim`) answers it. The person sees each mandate, its upcoming collections for the
//! next month and its past ones, blocks it (and can unblock it), and asks for a refund of a collected debit inside the
//! guarantee period. A collection debits the person's main balance in the mandate's asset once, through svc-ledger's
//! `bankTransfer` recipe to the scheme's rail boundary, under `bank.transfer.rail:dd:<mandate>:<collection>:0`.
//!
//! States of a collection: `upcoming` until it is due; `processing` once a run has claimed it (from here a block is too
//! late for it); `collected` with the ledger entry; `failed` when the ledger refused it (too little money: nothing is
//! posted); `rejected` when it was refused before any attempt (a blocked mandate, an account that cannot be debited).
//!
//! One run drives one collection at a time, under that collection's own session advisory lock held across the post, so
//! two overlapping runs never both debit or both decide it. The claim is one statement that reads the mandate without
//! locking it, so a block (which locks the mandate, then its collections) never waits on a run in the other order.
//!
//! If this crashes exactly here, whose funds are stranded? No one's: a crash after the post and before the row is marked
//! leaves the row `processing`, and the next run finds the entry by its key and records it instead of posting again. A
//! fault that will not pass (an entry the ledger refuses as invalid, a space that can never be debited) ends the
//! collection `failed` with nothing posted; an outage leaves it `processing` for the next run.
//!
//! When the partner bank holds the person's money (OWNER 226), the partner is the bank the scheme collects from: a block
//! is sent to the partner first and only then recorded here, a collection on a mandate the partner reports blocked is
//! rejected with the partner's own reason code, and a collection is ONE partner move from the main balance to the
//! partner's outbound-payments account under `bank.dd.collection:<mandate>:<collection>`. The ledger posts nothing.

use postgres::GenericClient;
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, js_trim, parse_amount};
use service_kit::time::Instant;

use super::super::Deps;
use crate::errors::Refusal;
use crate::loans::locks::with_lock;
use crate::partner::custody::Held;
use crate::partner::desks::DD_BLOCKED;
use crate::partner::{AccountRef, MoveRequest, TestPartner, payouts_account, refuse};
use crate::spaces::ports::LedgerAccount;
use crate::spaces::space::{at, in_tx, pg, with};
use crate::transfers::moves::{
    assert_can_receive, bank_transfer_key, find_primary, post_bank_transfer, resolve_for_debit,
};

/// `UPCOMING_DAYS`: how far ahead "upcoming" looks.
const UPCOMING_DAYS: i64 = 31;
const DAY_MS: i64 = 86_400_000;
const LOCK: &str = "bank.dd-collection";

/// `DD_FAILURE_FEE_UNSET`: the owner has no failure fee table, so a failed collection's fee is not set.
pub const DD_FAILURE_FEE_UNSET: &str = "bank.dd_failure_fee_unset";

fn ms(col: &str) -> String {
    format!("floor(extract(epoch from {col}) * 1000)::int8")
}

fn iso(at: Option<Instant>) -> Json {
    at.map_or(Json::Null, |t| Json::str(t.iso()))
}

fn opt(s: Option<&str>) -> Json {
    s.map_or(Json::Null, Json::str)
}

// ── Rows and views ────────────────────────────────────────────────────────────────────────────────────────────────

/// A mandate row (`MandateRow`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mandate {
    pub id: String,
    pub user_id: String,
    pub scheme: String,
    pub creditor_id: String,
    pub creditor_name: String,
    pub reference: String,
    pub asset_id: String,
    /// `active` or `blocked`.
    pub status: String,
    pub blocked_at: Option<Instant>,
    pub created_at: Instant,
}

fn mandate_cols() -> String {
    format!(
        "id, user_id::text, scheme, creditor_id, creditor_name, reference, asset_id, status, {}, {}",
        ms("blocked_at"),
        ms("created_at")
    )
}

fn mandate_row(r: &postgres::Row) -> Result<Mandate, Refusal> {
    let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
    Ok(Mandate {
        id: s(0)?,
        user_id: s(1)?,
        scheme: s(2)?,
        creditor_id: s(3)?,
        creditor_name: s(4)?,
        reference: s(5)?,
        asset_id: s(6)?,
        status: s(7)?,
        blocked_at: r
            .try_get::<_, Option<i64>>(8)
            .map_err(|e| pg(&e))?
            .map(Instant),
        created_at: Instant(r.try_get(9).map_err(|e| pg(&e))?),
    })
}

impl Mandate {
    /// `MandateView`, with its upcoming collections.
    pub fn json(&self, upcoming: &[CollectionView]) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("creditorId", Json::str(self.creditor_id.clone())),
            ("creditorName", Json::str(self.creditor_name.clone())),
            ("reference", Json::str(self.reference.clone())),
            ("assetId", Json::str(self.asset_id.clone())),
            ("status", Json::str(self.status.clone())),
            ("blockedAt", iso(self.blocked_at)),
            ("createdAt", Json::str(self.created_at.iso())),
            (
                "upcoming",
                Json::Array(upcoming.iter().map(CollectionView::json).collect()),
            ),
        ])
    }

    /// `{ ...mandateView, userId }`, as the scheme's door answers.
    pub fn json_with_user(&self) -> Json {
        let mut j = self.json(&[]);
        if let Json::Object(f) = &mut j {
            f.push(("userId".to_owned(), Json::str(self.user_id.clone())));
        }
        j
    }
}

/// A collection row with its mandate's creditor and its refund request (`CollectionRow`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Row {
    id: String,
    mandate_id: String,
    collection_id: String,
    user_id: String,
    asset_id: String,
    amount: String,
    due_at: Instant,
    status: String,
    failure_code: Option<String>,
    ledger_tx_id: Option<String>,
    partner_move_id: Option<String>,
    presented_at: Instant,
    settled_at: Option<Instant>,
    guarantee_ends_at: Option<Instant>,
    creditor_name: String,
    refund_requested_at: Option<Instant>,
    refund_reason: Option<String>,
}

fn collection_cols() -> String {
    format!(
        "c.id::text, c.mandate_id, c.collection_id, c.user_id::text, c.asset_id, c.amount::text, {}, c.status, \
         c.failure_code, c.ledger_tx_id, c.partner_move_id, {}, {}, {}, m.creditor_name, {}, r.reason",
        ms("c.due_at"),
        ms("c.presented_at"),
        ms("c.settled_at"),
        ms("c.guarantee_ends_at"),
        ms("r.requested_at"),
    )
}

fn row(r: &postgres::Row) -> Result<Row, Refusal> {
    let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
    let o = |i: usize| r.try_get::<_, Option<String>>(i).map_err(|e| pg(&e));
    let t = |i: usize| {
        r.try_get::<_, Option<i64>>(i)
            .map_err(|e| pg(&e))
            .map(|v| v.map(Instant))
    };
    Ok(Row {
        id: s(0)?,
        mandate_id: s(1)?,
        collection_id: s(2)?,
        user_id: s(3)?,
        asset_id: s(4)?,
        amount: s(5)?,
        due_at: Instant(r.try_get(6).map_err(|e| pg(&e))?),
        status: s(7)?,
        failure_code: o(8)?,
        ledger_tx_id: o(9)?,
        partner_move_id: o(10)?,
        presented_at: Instant(r.try_get(11).map_err(|e| pg(&e))?),
        settled_at: t(12)?,
        guarantee_ends_at: t(13)?,
        creditor_name: s(14)?,
        refund_requested_at: t(15)?,
        refund_reason: o(16)?,
    })
}

/// `RefundView`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefundView {
    /// `none`, `available`, `requested`, `closed` or `unset`.
    pub state: &'static str,
    pub ends_at: Option<Instant>,
    pub requested_at: Option<Instant>,
}

/// `CollectionView`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectionView {
    pub id: String,
    pub mandate_id: String,
    pub collection_id: String,
    pub creditor_name: String,
    pub asset_id: String,
    pub amount: Amount,
    pub due_at: Instant,
    pub status: String,
    pub failure_code: Option<String>,
    pub ledger_tx_id: Option<String>,
    pub partner_move_id: Option<String>,
    pub presented_at: Instant,
    pub settled_at: Option<Instant>,
    /// `failureFeeBlocker`: `bank.dd_failure_fee_unset` on a failed collection; the fee itself is always null.
    pub failure_fee_blocker: Option<&'static str>,
    pub refund: RefundView,
    /// Whose it is, and the refund reason: support's queue reads them.
    pub user_id: String,
    pub refund_reason: Option<String>,
}

impl CollectionView {
    pub fn json(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("mandateId", Json::str(self.mandate_id.clone())),
            ("collectionId", Json::str(self.collection_id.clone())),
            ("creditorName", Json::str(self.creditor_name.clone())),
            ("assetId", Json::str(self.asset_id.clone())),
            ("amount", Json::str(format_amount(self.amount))),
            ("dueAt", Json::str(self.due_at.iso())),
            ("status", Json::str(self.status.clone())),
            ("failureCode", opt(self.failure_code.as_deref())),
            ("ledgerTxId", opt(self.ledger_tx_id.as_deref())),
            ("partnerMoveId", opt(self.partner_move_id.as_deref())),
            ("presentedAt", Json::str(self.presented_at.iso())),
            ("settledAt", iso(self.settled_at)),
            ("failureFee", Json::Null),
            ("failureFeeBlocker", opt(self.failure_fee_blocker)),
            (
                "refund",
                Json::obj([
                    ("state", Json::str(self.refund.state)),
                    ("endsAt", iso(self.refund.ends_at)),
                    ("requestedAt", iso(self.refund.requested_at)),
                ]),
            ),
        ])
    }

    /// The view with `extra` keys after its own.
    fn json_with(&self, extra: Vec<(String, Json)>) -> Json {
        let mut j = self.json();
        if let Json::Object(f) = &mut j {
            f.extend(extra);
        }
        j
    }

    /// `{ ...collectionView, userId }`, as the scheme's door answers.
    pub fn json_with_user(&self) -> Json {
        self.json_with(vec![("userId".to_owned(), Json::str(self.user_id.clone()))])
    }

    /// Support's line: `collectionView.extend({ userId, reason })`.
    pub fn json_for_support(&self) -> Json {
        self.json_with(vec![
            ("userId".to_owned(), Json::str(self.user_id.clone())),
            (
                "reason".to_owned(),
                Json::str(self.refund_reason.clone().unwrap_or_default()),
            ),
        ])
    }
}

/// `refundOf`: the window as fixed when the debit was collected.
fn refund_of(r: &Row, now: Instant) -> RefundView {
    if let Some(requested) = r.refund_requested_at {
        return RefundView {
            state: "requested",
            ends_at: r.guarantee_ends_at,
            requested_at: Some(requested),
        };
    }
    let none = RefundView {
        state: "none",
        ends_at: None,
        requested_at: None,
    };
    if r.status != "collected" || r.settled_at.is_none() {
        return none;
    }
    match r.guarantee_ends_at {
        None => RefundView {
            state: "unset",
            ..none
        },
        Some(end) => RefundView {
            state: if end.0 > now.0 { "available" } else { "closed" },
            ends_at: Some(end),
            requested_at: None,
        },
    }
}

fn view(r: &Row, now: Instant) -> Result<CollectionView, Refusal> {
    Ok(CollectionView {
        id: r.id.clone(),
        mandate_id: r.mandate_id.clone(),
        collection_id: r.collection_id.clone(),
        creditor_name: r.creditor_name.clone(),
        asset_id: r.asset_id.clone(),
        amount: parse_amount(&r.amount).map_err(Refusal::Other)?,
        due_at: r.due_at,
        status: r.status.clone(),
        failure_code: r.failure_code.clone(),
        ledger_tx_id: r.ledger_tx_id.clone(),
        partner_move_id: r.partner_move_id.clone(),
        presented_at: r.presented_at,
        settled_at: r.settled_at,
        failure_fee_blocker: (r.status == "failed").then_some(DD_FAILURE_FEE_UNSET),
        refund: refund_of(r, now),
        user_id: r.user_id.clone(),
        refund_reason: r.refund_reason.clone(),
    })
}

const COLLECTION_FROM: &str = "FROM bank.dd_collections c \
     JOIN bank.dd_mandates m ON m.id = c.mandate_id \
     LEFT JOIN bank.dd_refund_requests r ON r.collection_row_id = c.id";

fn rows(
    c: &mut impl GenericClient,
    filter: &str,
    order_and_limit: &str,
    params: &[&(dyn postgres::types::ToSql + Sync)],
) -> Result<Vec<Row>, Refusal> {
    c.query(
        &format!(
            "SELECT {} {COLLECTION_FROM} WHERE {filter} {order_and_limit}",
            collection_cols()
        ),
        params,
    )
    .map_err(|e| pg(&e))?
    .iter()
    .map(row)
    .collect()
}

fn by_row_id(c: &mut impl GenericClient, id: &str) -> Result<Option<Row>, Refusal> {
    Ok(rows(c, "c.id = $1::text::uuid", "LIMIT 200", &[&id])?
        .into_iter()
        .next())
}

// ── Who answers ───────────────────────────────────────────────────────────────────────────────────────────────────

/// `requireScheme`: every control refuses `rail.bank` while no scheme is wired.
fn require_scheme(d: &Deps<'_>) -> Result<(), Refusal> {
    if d.w.direct_debits.scheme.live() {
        Ok(())
    } else {
        Err(refuse(
            "rail.bank",
            "No direct debit scheme is connected (rail.bank); nothing was changed.",
        ))
    }
}

fn invalid(message: &str) -> Refusal {
    refuse("bank.dd_invalid", message)
}

fn conflict(message: &str) -> Refusal {
    refuse("bank.dd_collection_conflict", message)
}

fn mandate_not_found() -> Refusal {
    refuse("bank.dd_mandate_not_found", "No such direct debit mandate.")
}

/// `partnerPathNotBuilt`, in this part's words.
fn partner_path_not_built() -> Refusal {
    refuse(
        "bank.partner_path_not_built",
        "This direct debit is not yet run through the partner bank that holds this money, so nothing was changed.",
    )
}

/// The partner that answers for this person's direct debits (`partnerFor`): the guarded bank that holds their money and
/// its direct-debit desk, or none on the custodial layer. Partner-held money with no desk wired refuses by name.
struct AtPartner<'a> {
    bank: Held<'a>,
    desk: &'a TestPartner,
}

fn partner_for<'a>(d: &'a Deps<'a>, user_id: &str) -> Result<Option<AtPartner<'a>>, Refusal> {
    let Some(bank) = d.t.custody.bank_for(user_id) else {
        return Ok(None);
    };
    let Some(desk) = d.t.custody.partner else {
        return Err(partner_path_not_built());
    };
    Ok(Some(AtPartner { bank, desk }))
}

/// `collectionTransferId`: the ledger transfer id of one collection; its key is `bank.transfer.rail:<this>:0`.
pub fn collection_transfer_id(mandate_id: &str, collection_id: &str) -> String {
    format!("dd:{mandate_id}:{collection_id}")
}

/// `collectionPartnerKey`: one key is one move at the partner, however often it is sent.
pub fn collection_partner_key(mandate_id: &str, collection_id: &str) -> String {
    format!("bank.dd.collection:{mandate_id}:{collection_id}")
}

// ── The person's reads and controls ───────────────────────────────────────────────────────────────────────────────

/// `dated`: the person's collections due in `[from, to)`, soonest first, `limit` rows, for the money calendar.
pub fn dated(
    d: &Deps<'_>,
    user_id: &str,
    from: Instant,
    to: Instant,
    limit: i64,
) -> Result<Vec<CollectionView>, Refusal> {
    let now = d.now();
    let found = with(d.store(), |c| {
        rows(
            c,
            &format!(
                "c.user_id = $1::text::uuid AND c.due_at >= {} AND c.due_at < {}",
                at("$2"),
                at("$3")
            ),
            "ORDER BY c.due_at ASC, c.id ASC LIMIT $4",
            &[&user_id, &from.0, &to.0, &limit],
        )
    })?;
    found.iter().map(|r| view(r, now)).collect()
}

/// `list`: the scheme, the person's mandates with their next month's upcoming collections, and their past collections
/// newest first. Upcoming and history are read apart, so a long run of future presentments never pushes past debits out.
pub fn list(d: &Deps<'_>, user_id: &str) -> Result<Json, Refusal> {
    let now = d.now();
    let scheme = &d.w.direct_debits.scheme;
    let until = Instant(now.0 + UPCOMING_DAYS * DAY_MS);
    let (mandates, upcoming, history) = with(d.store(), |c| {
        let mandates = c
            .query(
                &format!(
                    "SELECT {} FROM bank.dd_mandates WHERE user_id = $1::text::uuid \
                     ORDER BY created_at DESC, id LIMIT 100",
                    mandate_cols()
                ),
                &[&user_id],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(mandate_row)
            .collect::<Result<Vec<_>, _>>()?;
        let upcoming = rows(
            c,
            &format!(
                "c.user_id = $1::text::uuid AND c.status = 'upcoming' AND c.due_at <= {}",
                at("$2")
            ),
            "ORDER BY c.due_at DESC, c.id DESC LIMIT 200",
            &[&user_id, &until.0],
        )?;
        let history = rows(
            c,
            "c.user_id = $1::text::uuid AND c.status <> 'upcoming'",
            "ORDER BY c.due_at DESC, c.id DESC LIMIT 200",
            &[&user_id],
        )?;
        Ok((mandates, upcoming, history))
    })?;
    let mut next = upcoming
        .iter()
        .map(|r| view(r, now))
        .collect::<Result<Vec<_>, _>>()?;
    next.sort_by_key(|c| c.due_at.0);
    let history = history
        .iter()
        .map(|r| view(r, now).map(|v| v.json()))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json::obj([
        (
            "scheme",
            Json::obj([
                ("status", Json::str(scheme.status)),
                ("standIn", opt(scheme.stand_in.as_deref())),
                (
                    "guaranteeDays",
                    scheme.guarantee_days.map_or(Json::Null, Json::int),
                ),
                (
                    "blocker",
                    if scheme.live() {
                        Json::Null
                    } else {
                        Json::str("rail.bank")
                    },
                ),
            ]),
        ),
        (
            "mandates",
            Json::Array(
                mandates
                    .iter()
                    .map(|m| {
                        let mine: Vec<CollectionView> = next
                            .iter()
                            .filter(|c| c.mandate_id == m.id)
                            .cloned()
                            .collect();
                        m.json(&mine)
                    })
                    .collect(),
            ),
        ),
        ("collections", Json::Array(history)),
    ]))
}

/// `ownedMandate`: another person's mandate reads as missing.
fn owned_mandate(
    c: &mut impl GenericClient,
    user_id: &str,
    mandate_id: &str,
    lock: bool,
) -> Result<Mandate, Refusal> {
    let found = c
        .query(
            &format!(
                "SELECT {} FROM bank.dd_mandates WHERE id = $1{}",
                mandate_cols(),
                if lock { " FOR UPDATE" } else { "" }
            ),
            &[&mandate_id],
        )
        .map_err(|e| pg(&e))?;
    match found.first().map(mandate_row).transpose()? {
        Some(m) if m.user_id == user_id => Ok(m),
        _ => Err(mandate_not_found()),
    }
}

/// `block`: the mandate's upcoming collections are rejected now with `bank.dd_mandate_blocked` (or the partner's own
/// code), and any it presents later the same way; a collection a run already claimed is named `bank.dd_too_late`.
/// Blocking a blocked mandate changes nothing and answers the same. Partner-held money: the block is the partner's first,
/// and if the partner refuses or is down nothing is recorded here.
pub fn block(d: &Deps<'_>, user_id: &str, mandate_id: &str) -> Result<Json, Refusal> {
    require_scheme(d)?;
    let now = d.now();
    with(d.store(), |c| owned_mandate(c, user_id, mandate_id, false))?;
    let partner = partner_for(d, user_id)?;
    let at_partner = match &partner {
        Some(p) => Some(p.desk.lock().dd_block(user_id, mandate_id, now)?),
        None => None,
    };
    let code = if at_partner.as_ref().is_some_and(|m| m.blocked_at.is_some()) {
        DD_BLOCKED
    } else {
        "bank.dd_mandate_blocked"
    };
    let (rejected, too_late) = in_tx(d.store(), |tx| {
        let mandate = owned_mandate(tx, user_id, mandate_id, true)?;
        if mandate.status == "active" {
            tx.execute(
                &format!(
                    "UPDATE bank.dd_mandates SET status = 'blocked', blocked_at = {}, updated_at = now() WHERE id = $2",
                    at("$1")
                ),
                &[&now.0, &mandate.id],
            )
            .map_err(|e| pg(&e))?;
        }
        let rejected: Vec<String> = tx
            .query(
                &format!(
                    "UPDATE bank.dd_collections SET status = 'rejected', failure_code = $2, settled_at = {} \
                     WHERE mandate_id = $3 AND status = 'upcoming' RETURNING collection_id",
                    at("$1")
                ),
                &[&now.0, &code, &mandate.id],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(|r| r.get(0))
            .collect();
        let busy: Vec<String> = tx
            .query(
                "SELECT collection_id FROM bank.dd_collections WHERE mandate_id = $1 AND status = 'processing'",
                &[&mandate.id],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(|r| r.get(0))
            .collect();
        Ok((rejected, busy))
    })?;
    let mandate = with(d.store(), |c| owned_mandate(c, user_id, mandate_id, false))?;
    Ok(Json::obj([
        ("mandate", mandate.json(&[])),
        (
            "rejected",
            Json::Array(rejected.into_iter().map(Json::str).collect()),
        ),
        (
            "tooLate",
            Json::Array(
                too_late
                    .into_iter()
                    .map(|id| {
                        Json::obj([
                            ("collectionId", Json::str(id)),
                            ("code", Json::str("bank.dd_too_late")),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "sentTo",
            if at_partner.is_some() {
                Json::str(crate::partner::LABEL)
            } else {
                Json::Null
            },
        ),
    ]))
}

/// `unblock`: collections the creditor presents from now on are collected again; rejected ones stay rejected.
pub fn unblock(d: &Deps<'_>, user_id: &str, mandate_id: &str) -> Result<Json, Refusal> {
    require_scheme(d)?;
    with(d.store(), |c| owned_mandate(c, user_id, mandate_id, false))?;
    if let Some(p) = partner_for(d, user_id)? {
        p.desk.lock().dd_unblock(user_id, mandate_id)?;
    }
    in_tx(d.store(), |tx| {
        let mandate = owned_mandate(tx, user_id, mandate_id, true)?;
        if mandate.status == "blocked" {
            tx.execute(
                "UPDATE bank.dd_mandates SET status = 'active', blocked_at = NULL, updated_at = now() WHERE id = $1",
                &[&mandate.id],
            )
            .map_err(|e| pg(&e))?;
        }
        Ok(())
    })?;
    let mandate = with(d.store(), |c| owned_mandate(c, user_id, mandate_id, false))?;
    Ok(Json::obj([("mandate", mandate.json(&[]))]))
}

/// `requestRefund`: ask for a collected debit back inside the guarantee period. One request per collection: asking again
/// answers the first. Support reads it; the credit back is the scheme's answer and is not made here.
pub fn request_refund(
    d: &Deps<'_>,
    user_id: &str,
    collection_row_id: &str,
    reason: &str,
) -> Result<(CollectionView, bool), Refusal> {
    require_scheme(d)?;
    let now = d.now();
    let reason = js_trim(reason);
    if !(1..=500).contains(&reason.encode_utf16().count()) {
        return Err(invalid(
            "Say in up to 500 characters why this debit should be refunded.",
        ));
    }
    let found = with(d.store(), |c| by_row_id(c, collection_row_id))?;
    let Some(r) = found.filter(|r| r.user_id == user_id) else {
        return Err(refuse(
            "bank.dd_collection_not_found",
            "No such direct debit collection.",
        ));
    };
    if r.refund_requested_at.is_some() {
        return Ok((view(&r, now)?, false));
    }
    if r.status != "collected" {
        return Err(refuse(
            "bank.dd_refund_not_collected",
            "Only a debit that was collected can be refunded; nothing was taken for this one.",
        ));
    }
    let Some(ends) = r.guarantee_ends_at else {
        return Err(refuse(
            "bank.dd_guarantee_unset",
            "The direct debit guarantee period is not set, so no refund can be requested.",
        ));
    };
    if ends.0 <= now.0 {
        return Err(refuse(
            "bank.dd_refund_window_closed",
            format!(
                "The guarantee period for this debit ended on {}.",
                ends.iso()
            ),
        ));
    }
    let (inserted, after) = with(d.store(), |c| {
        let n = c
            .execute(
                &format!(
                    "INSERT INTO bank.dd_refund_requests (collection_row_id, user_id, reason, guarantee_ends_at, requested_at) \
                     VALUES ($1::text::uuid, $2::text::uuid, $3, {}, {}) ON CONFLICT (collection_row_id) DO NOTHING",
                    at("$4"),
                    at("$5")
                ),
                &[&r.id, &r.user_id, &reason, &ends.0, &now.0],
            )
            .map_err(|e| pg(&e))?;
        let after = by_row_id(c, &r.id)?
            .ok_or_else(|| Refusal::Other("the collection vanished".to_owned()))?;
        Ok((n, after))
    })?;
    Ok((view(&after, now)?, inserted == 1))
}

/// `opsRefunds`: support's queue of refund requests, oldest first, with whose they are.
pub fn ops_refunds(d: &Deps<'_>, limit: Option<i64>) -> Result<Vec<CollectionView>, Refusal> {
    let now = d.now();
    let limit = limit.unwrap_or(50).clamp(1, 100);
    let found = with(d.store(), |c| {
        c.query(
            &format!(
                "SELECT {} FROM bank.dd_refund_requests r \
                   JOIN bank.dd_collections c ON c.id = r.collection_row_id \
                   JOIN bank.dd_mandates m ON m.id = c.mandate_id \
                 ORDER BY r.requested_at ASC, c.id LIMIT $1",
                collection_cols()
            ),
            &[&limit],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(row)
        .collect::<Result<Vec<_>, _>>()
    })?;
    found.iter().map(|r| view(r, now)).collect()
}

/// `opsMandateDetails`: the mandates by id, for the finance desk's partner read.
pub fn ops_mandate_details(d: &Deps<'_>, ids: &[String]) -> Result<Vec<Mandate>, Refusal> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    with(d.store(), |c| {
        c.query(
            &format!(
                "SELECT {} FROM bank.dd_mandates WHERE id = ANY($1::text[])",
                mandate_cols()
            ),
            &[&ids],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(mandate_row)
        .collect()
    })
}

// ── The scheme's side: signed job doors, never a customer ─────────────────────────────────────────────────────────

/// `ddSimMandateBody`, as the door read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewMandate {
    pub mandate_id: String,
    pub user_id: String,
    pub creditor_id: String,
    pub reference: String,
    pub asset_id: String,
}

/// `setUpMandate`: a creditor sets up a mandate through the scheme. The same mandate again answers the first; other
/// terms refuse. Identity says whether the person's account is open.
pub fn set_up_mandate(d: &Deps<'_>, i: &NewMandate) -> Result<Mandate, Refusal> {
    require_scheme(d)?;
    let scheme_w = &d.w.direct_debits.scheme;
    let Some(creditor) = scheme_w.creditor(&i.creditor_id) else {
        return Err(refuse(
            "bank.dd_creditor_unknown",
            "The scheme knows no creditor by that id.",
        ));
    };
    assert_can_receive(d.t, &i.user_id)?;
    let scheme = if scheme_w.stand_in.is_some() {
        "dd-sim"
    } else {
        "live"
    };
    let found = with(d.store(), |c| {
        c.execute(
            "INSERT INTO bank.dd_mandates (id, user_id, scheme, creditor_id, creditor_name, reference, asset_id) \
             VALUES ($1, $2::text::uuid, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING",
            &[
                &i.mandate_id,
                &i.user_id,
                &scheme,
                &creditor.id,
                &creditor.name,
                &i.reference,
                &i.asset_id,
            ],
        )
        .map_err(|e| pg(&e))?;
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.dd_mandates WHERE id = $1",
                    mandate_cols()
                ),
                &[&i.mandate_id],
            )
            .map_err(|e| pg(&e))?;
        rows.first()
            .map(mandate_row)
            .transpose()?
            .ok_or_else(|| Refusal::Other("the mandate vanished".to_owned()))
    })?;
    if found.user_id != i.user_id
        || found.creditor_id != creditor.id
        || found.reference != i.reference
        || found.asset_id != i.asset_id
    {
        return Err(refuse(
            "bank.dd_mandate_conflict",
            "That mandate id is already set up with other terms.",
        ));
    }
    if let Some(p) = partner_for(d, &found.user_id)? {
        p.desk
            .lock()
            .dd_set_up(&found.user_id, &found.id, d.now())?;
    }
    Ok(found)
}

/// `present`: a creditor presents one collection. A replay of the same presentment is one row; the same id with another
/// amount or date refuses. Against a blocked mandate it is recorded `rejected`, nothing posted.
pub fn present(
    d: &Deps<'_>,
    mandate_id: &str,
    collection_id: &str,
    amount: &str,
    due_at: &str,
) -> Result<CollectionView, Refusal> {
    require_scheme(d)?;
    let now = d.now();
    let amount = parse_amount(amount)
        .map_err(|_| invalid("The collection amount must be a decimal string."))?;
    if amount <= Amount::ZERO {
        return Err(invalid("The collection amount must be more than zero."));
    }
    let due = service_kit::time::js_date(due_at)
        .ok_or_else(|| invalid("The collection needs a due date."))?;
    let owner: Option<String> = with(d.store(), |c| {
        Ok(c.query(
            "SELECT user_id::text FROM bank.dd_mandates WHERE id = $1",
            &[&mandate_id],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(|r| r.get(0)))
    })?;
    let mut partner_blocked = false;
    if let Some(owner) = &owner
        && let Some(p) = partner_for(d, owner)?
    {
        partner_blocked = p
            .desk
            .lock()
            .dd_mandate(owner, mandate_id, Some(collection_id), now)?
            .blocked_at
            .is_some();
    }
    let row_id = in_tx(d.store(), |tx| {
        // FOR SHARE orders this with a block, which takes the row FOR UPDATE.
        let mandate = tx
            .query(
                &format!(
                    "SELECT {} FROM bank.dd_mandates WHERE id = $1 FOR SHARE",
                    mandate_cols()
                ),
                &[&mandate_id],
            )
            .map_err(|e| pg(&e))?
            .first()
            .map(mandate_row)
            .transpose()?
            .ok_or_else(mandate_not_found)?;
        let blocked = mandate.status == "blocked" || partner_blocked;
        let code = if partner_blocked {
            DD_BLOCKED
        } else {
            "bank.dd_mandate_blocked"
        };
        let status = if blocked { "rejected" } else { "upcoming" };
        let failure: Option<&str> = blocked.then_some(code);
        let settled: Option<i64> = blocked.then_some(now.0);
        tx.execute(
            &format!(
                "INSERT INTO bank.dd_collections \
                   (mandate_id, collection_id, user_id, asset_id, amount, due_at, status, failure_code, settled_at) \
                 VALUES ($1, $2, $3::text::uuid, $4, $5::text::numeric, {}, $7, $8, {}) \
                 ON CONFLICT (mandate_id, collection_id) DO NOTHING",
                at("$6"),
                at("$9")
            ),
            &[
                &mandate.id,
                &collection_id,
                &mandate.user_id,
                &mandate.asset_id,
                &format_amount(amount),
                &due.0,
                &status,
                &failure,
                &settled,
            ],
        )
        .map_err(|e| pg(&e))?;
        let kept = tx
            .query_one(
                &format!(
                    "SELECT id::text, amount::text, {} FROM bank.dd_collections \
                     WHERE mandate_id = $1 AND collection_id = $2",
                    ms("due_at")
                ),
                &[&mandate.id, &collection_id],
            )
            .map_err(|e| pg(&e))?;
        let kept_amount: String = kept.get(1);
        let kept_due: i64 = kept.get(2);
        if parse_amount(&kept_amount).ok() != Some(amount) || kept_due != due.0 {
            return Err(conflict(
                "That collection id was presented with another amount or date.",
            ));
        }
        Ok(kept.get::<_, String>(0))
    })?;
    let r = with(d.store(), |c| by_row_id(c, &row_id))?
        .ok_or_else(|| Refusal::Other("the collection vanished".to_owned()))?;
    view(&r, now)
}

/// `DirectDebitRunReport`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RunReport {
    pub considered: i64,
    pub collected: i64,
    pub failed: i64,
    pub rejected: i64,
    /// (collection row id, reason, the `BankError`'s code when it was one).
    pub failures: Vec<(String, String, Option<String>)>,
}

impl RunReport {
    pub fn json(&self) -> Json {
        Json::obj([
            ("considered", Json::int(self.considered)),
            ("collected", Json::int(self.collected)),
            ("failed", Json::int(self.failed)),
            ("rejected", Json::int(self.rejected)),
            (
                "failures",
                Json::Array(
                    self.failures
                        .iter()
                        .map(|(id, reason, code)| {
                            let mut f = vec![
                                ("collectionId".to_owned(), Json::str(id.clone())),
                                ("reason".to_owned(), Json::str(reason.clone())),
                            ];
                            if let Some(code) = code {
                                f.push(("code".to_owned(), Json::str(code.clone())));
                            }
                            Json::Object(f)
                        })
                        .collect(),
                ),
            ),
        ])
    }
}

/// How one collection ended in a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Collected,
    Failed,
    Rejected,
}

/// `runDue`: every due collection is collected, failed or rejected once. One fault never stops the rest.
pub fn run_due(d: &Deps<'_>, limit: i64) -> Result<RunReport, Refusal> {
    require_scheme(d)?;
    let now = d.now();
    let due: Vec<String> = with(d.store(), |c| {
        Ok(c.query(
            &format!(
                "SELECT id::text FROM bank.dd_collections WHERE status IN ('upcoming', 'processing') AND due_at <= {} \
                 ORDER BY due_at ASC, id LIMIT $2",
                at("$1")
            ),
            &[&now.0, &limit],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(|r| r.get(0))
        .collect())
    })?;
    let mut report = RunReport {
        considered: i64::try_from(due.len()).unwrap_or(i64::MAX),
        ..RunReport::default()
    };
    for id in due {
        match drive(d, &id, now) {
            Ok(Some(Outcome::Collected)) => report.collected += 1,
            Ok(Some(Outcome::Failed)) => report.failed += 1,
            Ok(Some(Outcome::Rejected)) => report.rejected += 1,
            Ok(None) => {}
            Err(r) => {
                let (reason, code) = match r {
                    Refusal::Bank(e) => (e.message, Some(e.row.code.to_owned())),
                    Refusal::Trpc(e) => (e.message, None),
                    Refusal::Other(m) => (m, None),
                };
                report.failures.push((id, reason, code));
            }
        }
    }
    Ok(report)
}

/// `finish`: a collection decided failed or rejected, only while nothing has moved for it.
fn finish(
    d: &Deps<'_>,
    id: &str,
    failed: bool,
    code: &str,
    now: Instant,
) -> Result<Outcome, Refusal> {
    let status = if failed { "failed" } else { "rejected" };
    let n = with(d.store(), |c| {
        c.execute(
            &format!(
                "UPDATE bank.dd_collections SET status = $1, failure_code = $2, settled_at = {} \
                 WHERE id = $4::text::uuid AND status IN ('upcoming', 'processing') \
                   AND ledger_tx_id IS NULL AND partner_move_id IS NULL",
                at("$3")
            ),
            &[&status, &code, &now.0, &id],
        )
        .map_err(|e| pg(&e))
    })?;
    if n != 1 {
        return Err(conflict(
            "The collection changed while it was being decided.",
        ));
    }
    Ok(if failed {
        Outcome::Failed
    } else {
        Outcome::Rejected
    })
}

/// The row as a run reads it.
struct Due {
    id: String,
    mandate_id: String,
    collection_id: String,
    user_id: String,
    asset_id: String,
    amount: Amount,
}

/// Marks a collection collected by the movement that took it: the ledger's transaction or the partner's move.
fn collected(
    d: &Deps<'_>,
    id: &str,
    column: &str,
    movement: &str,
    now: Instant,
) -> Result<Outcome, Refusal> {
    let ends: Option<i64> =
        d.w.direct_debits
            .scheme
            .guarantee_days
            .map(|days| now.0 + days * DAY_MS);
    let n = with(d.store(), |c| {
        c.execute(
            &format!(
                "UPDATE bank.dd_collections SET status = 'collected', {column} = $1, settled_at = {}, \
                        failure_code = NULL, guarantee_ends_at = {} \
                  WHERE id = $4::text::uuid AND status = 'processing'",
                at("$2"),
                at("$3")
            ),
            &[&movement, &now.0, &ends, &id],
        )
        .map_err(|e| pg(&e))
    })?;
    if n != 1 {
        return Err(conflict(
            "The collection changed while it was being collected.",
        ));
    }
    Ok(Outcome::Collected)
}

/// Whether the person may be debited, else the rejection (`bank.dd_account_unavailable`); identity down is an error and
/// leaves the row processing for a retry.
fn can_be_debited(d: &Deps<'_>, due: &Due, now: Instant) -> Result<Option<Outcome>, Refusal> {
    match assert_can_receive(d.t, &due.user_id) {
        Ok(()) => Ok(None),
        Err(Refusal::Bank(e)) if e.row.code == "bank.recipient_cannot_receive" => Ok(Some(finish(
            d,
            &due.id,
            false,
            "bank.dd_account_unavailable",
            now,
        )?)),
        Err(e) => Err(e),
    }
}

/// The main balance's space, if any, checked for a debit: a locked or archived one fails the collection by its reason.
fn main_space(
    d: &Deps<'_>,
    due: &Due,
    now: Instant,
) -> Result<Result<Option<crate::spaces::space::Space>, Outcome>, Refusal> {
    let primary = with(d.store(), |c| find_primary(c, &due.user_id, &due.asset_id))?;
    let Some(primary) = primary else {
        return Ok(Ok(None));
    };
    match with(d.store(), |c| resolve_for_debit(c, &primary.id, now)) {
        Ok(_) => Ok(Ok(Some(primary))),
        Err(Refusal::Bank(e)) => Ok(Err(finish(d, &due.id, true, e.row.code, now)?)),
        Err(e) => Err(e),
    }
}

/// `drive`: one collection under its own session advisory lock, held across the post.
fn drive(d: &Deps<'_>, id: &str, now: Instant) -> Result<Option<Outcome>, Refusal> {
    with_lock(d.store(), LOCK, id, || {
        let read = with(d.store(), |c| {
            Ok(c.query(
                "SELECT c.id::text, c.mandate_id, c.collection_id, c.user_id::text, c.asset_id, c.amount::text, \
                        c.status, m.status \
                   FROM bank.dd_collections c JOIN bank.dd_mandates m ON m.id = c.mandate_id \
                  WHERE c.id = $1::text::uuid",
                &[&id],
            )
            .map_err(|e| pg(&e))?
            .first()
            .map(|r| {
                (
                    r.get::<_, String>(0),
                    r.get::<_, String>(1),
                    r.get::<_, String>(2),
                    r.get::<_, String>(3),
                    r.get::<_, String>(4),
                    r.get::<_, String>(5),
                    r.get::<_, String>(6),
                    r.get::<_, String>(7),
                )
            }))
        })?;
        let Some((
            id,
            mandate_id,
            collection_id,
            user_id,
            asset_id,
            amount,
            status,
            mandate_status,
        )) = read
        else {
            return Ok(None);
        };
        if status != "upcoming" && status != "processing" {
            return Ok(None);
        }
        if status == "upcoming" {
            if mandate_status != "active" {
                return finish(d, &id, false, "bank.dd_mandate_blocked", now).map(Some);
            }
            // Claimed only while its mandate is still active, in one statement: a block that got there first wins.
            let claimed = with(d.store(), |c| {
                c.execute(
                    "UPDATE bank.dd_collections c SET status = 'processing' \
                      WHERE c.id = $1::text::uuid AND c.status = 'upcoming' \
                        AND EXISTS (SELECT 1 FROM bank.dd_mandates m WHERE m.id = c.mandate_id AND m.status = 'active')",
                    &[&id],
                )
                .map_err(|e| pg(&e))
            })?;
            if claimed != 1 {
                return Ok(None);
            }
        }
        let due = Due {
            id,
            mandate_id,
            collection_id,
            user_id,
            asset_id,
            amount: parse_amount(&amount).map_err(Refusal::Other)?,
        };
        if let Some(p) = partner_for(d, &due.user_id)? {
            return collect_at_partner(d, &due, &p, now).map(Some);
        }
        collect_on_ledger(d, &due, now).map(Some)
    })
}

/// One collection on svc-ledger: an entry that posted before a crash is recorded, never posted again.
fn collect_on_ledger(d: &Deps<'_>, due: &Due, now: Instant) -> Result<Outcome, Refusal> {
    let transfer_id = collection_transfer_id(&due.mandate_id, &due.collection_id);
    let key = bank_transfer_key("rail", &transfer_id, 0);
    if let Some(tx) = d.t.ledger.tx_by_key(&key).map_err(Refusal::Other)? {
        return collected(d, &due.id, "ledger_tx_id", &tx.id, now);
    }
    if let Some(rejected) = can_be_debited(d, due, now)? {
        return Ok(rejected);
    }
    if let Err(failed) = main_space(d, due, now)? {
        return Ok(failed);
    }
    // `custodyGuardedLedger`: with the custodial layer off no customer balance is posted, before svc-ledger is asked.
    if d.t.partner.custody_layer != "on" {
        return Err(refuse(
            "bank.no_partner_bank",
            "No banking partner holds this money, and INTAFACED holds no customer money, so nothing was moved.",
        ));
    }
    let rail = &d.w.direct_debits.scheme.rail_id;
    let posted = post_bank_transfer(
        d.t,
        &transfer_id,
        0,
        &LedgerAccount::user_available(&due.user_id, &due.asset_id),
        &crate::bills::rail_boundary(rail, &due.asset_id),
        due.amount,
        "rail",
    );
    match posted {
        Ok(tx) => collected(d, &due.id, "ledger_tx_id", &tx.id, now),
        Err(f) if f.insufficient() => finish(d, &due.id, true, "bank.insufficient_funds", now),
        // The ledger refused the entry itself (an asset it does not hold, say): it never will post, so it fails.
        Err(f) if f.code() == Some("ledger.invalid_entry") => {
            finish(d, &due.id, true, "bank.dd_collection_invalid", now)
        }
        // A posting freeze or a lost answer: the row stays processing and the next run looks the key up first.
        Err(f) => Err(Refusal::Other(f.message().to_owned())),
    }
}

/// `collectAtPartner`: the partner says whether the mandate refuses it, and if not, ONE partner move under the
/// collection's key takes it from the main balance. Too little at the partner fails it with the partner's reason; anything
/// else (the partner down, its reply lost, a posting freeze) leaves the row `processing`, and the next run sends the same
/// key, which the partner answers once.
fn collect_at_partner(
    d: &Deps<'_>,
    due: &Due,
    p: &AtPartner<'_>,
    now: Instant,
) -> Result<Outcome, Refusal> {
    let key = collection_partner_key(&due.mandate_id, &due.collection_id);
    if let Some(moved) = p.bank.move_by_key(&key) {
        return collected(d, &due.id, "partner_move_id", &moved.id, now);
    }
    let mandate =
        p.desk
            .lock()
            .dd_mandate(&due.user_id, &due.mandate_id, Some(&due.collection_id), now)?;
    if mandate.blocked_at.is_some() {
        return finish(d, &due.id, false, DD_BLOCKED, now);
    }
    if let Some(rejected) = can_be_debited(d, due, now)? {
        return Ok(rejected);
    }
    let primary = match main_space(d, due, now)? {
        Ok(p) => p,
        Err(failed) => return Ok(failed),
    };
    let from = primary.map_or_else(
        || AccountRef {
            user_id: due.user_id.clone(),
            asset_id: due.asset_id.clone(),
            space_id: None,
        },
        |s| s.partner_account(),
    );
    let moved = p.bank.move_(
        &MoveRequest {
            key,
            from,
            to: payouts_account(&due.asset_id),
            amount: due.amount,
            payees: None,
        },
        now,
    );
    match moved {
        Ok(m) => collected(d, &due.id, "partner_move_id", &m.id, now),
        Err(Refusal::Bank(e)) if e.row.code == "bank.partner_insufficient_funds" => {
            finish(d, &due.id, true, e.row.code, now)
        }
        Err(e) => Err(e),
    }
}
