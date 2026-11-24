//! Sends to another person (`transfers/personal-pay.ts`'s send half, `transfers.toUser`, `get`, `held`, `quote`,
//! `settleWithdrawal`): a send is reserved in `bank.personal_transfers` under the caller's key, checked against the owner's
//! terms inside that reservation, then posted (svc-ledger's `bankTransfer` recipe, or the partner bank's one move when it
//! holds the money) and marked posted; its notice goes out on the bus and stays owed until the bus takes it.

use postgres::{GenericClient, Row, Transaction};
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::Instant;
use service_kit::trpc::TrpcError;

use super::moves::{self, Failed, Made};
use super::notices::TransferPosted;
use super::review::{self, HeldView, ReviewRow};
use super::{Deps, holds, ports, requests, safety, schedules, step_up, terms};
use crate::errors::Refusal;
use crate::partner::custody::Held;
use crate::partner::{AccountRef, Move, refuse};
use crate::spaces::shared::assert_may_take_out;
use crate::spaces::space::{self, at, in_tx, pg, with};

/// `NOTICE_RETRY_AFTER_MS`: a posted send's notice is retried by the recovery job only after this.
const NOTICE_RETRY_AFTER_MS: i64 = 30_000;
/// `POST_IN_FLIGHT_BOUND_SECONDS`.
pub const POST_IN_FLIGHT_BOUND_MS: i64 = 7 * 60 * 1000;

/// A send's own key on the book: `bankTransferKey('p2p', transferId, 0)`.
pub fn send_key(transfer_id: &str) -> String {
    moves::bank_transfer_key("p2p", transfer_id, 0)
}

/// `TRANSFER_COLS`, in [`TransferRow::from_row`]'s order.
pub const COLS: &str = "transfer_id, ledger_tx_id, partner_move_id, from_user_id, from_space_id::text, to_user_id, \
     asset_id, amount::text, note, reference, from_handle, to_handle, request_id::text, status, \
     floor(extract(epoch from created_at) * 1000)::int8, floor(extract(epoch from posted_at) * 1000)::int8, \
     floor(extract(epoch from announced_at) * 1000)::int8";

/// `TransferRow`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferRow {
    pub transfer_id: String,
    pub ledger_tx_id: Option<String>,
    pub partner_move_id: Option<String>,
    pub from_user_id: String,
    pub from_space_id: String,
    pub to_user_id: String,
    pub asset_id: String,
    pub amount: Amount,
    pub note: Option<String>,
    pub reference: Option<String>,
    pub from_handle: Option<String>,
    pub to_handle: Option<String>,
    pub request_id: Option<String>,
    /// `reserved` or `posted`.
    pub status: String,
    pub created_at: Instant,
    pub posted_at: Option<Instant>,
    pub announced_at: Option<Instant>,
}

impl TransferRow {
    pub fn from_row(r: &Row) -> Result<TransferRow, Refusal> {
        let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
        let o = |i: usize| r.try_get::<_, Option<String>>(i).map_err(|e| pg(&e));
        let t = |i: usize| {
            r.try_get::<_, Option<i64>>(i)
                .map(|v| v.map(Instant))
                .map_err(|e| pg(&e))
        };
        Ok(TransferRow {
            transfer_id: s(0)?,
            ledger_tx_id: o(1)?,
            partner_move_id: o(2)?,
            from_user_id: s(3)?,
            from_space_id: s(4)?,
            to_user_id: s(5)?,
            asset_id: s(6)?,
            amount: parse_amount(&s(7)?).map_err(Refusal::Other)?,
            note: o(8)?,
            reference: o(9)?,
            from_handle: o(10)?,
            to_handle: o(11)?,
            request_id: o(12)?,
            status: s(13)?,
            created_at: Instant(r.try_get::<_, i64>(14).map_err(|e| pg(&e))?),
            posted_at: t(15)?,
            announced_at: t(16)?,
        })
    }
}

pub fn transfer_rows(rows: &[Row]) -> Result<Vec<TransferRow>, Refusal> {
    rows.iter().map(TransferRow::from_row).collect()
}

fn log(event: &str, fields: Vec<(&str, Json)>) {
    let mut f = vec![
        ("level".to_owned(), Json::str("error")),
        ("service".to_owned(), Json::str("svc-bank")),
        ("event".to_owned(), Json::str(event)),
    ];
    f.extend(fields.into_iter().map(|(k, v)| (k.to_owned(), v)));
    eprintln!("{}", Json::Object(f).compact());
}

fn refusal_text(r: &Refusal) -> String {
    match r {
        Refusal::Bank(e) => e.message.clone(),
        Refusal::Trpc(e) => e.message.clone(),
        Refusal::Other(m) => m.clone(),
    }
}

/// `announcePosted`: the send's notice on the bus, then the row marked announced; a failure is logged and the notice
/// stays owed (the recovery job retries it). Never fails the send.
pub fn announce_posted(d: &Deps<'_>, row: &TransferRow) -> bool {
    let sent = d.notices().transfer_posted(&TransferPosted {
        transfer_id: row.transfer_id.clone(),
        sender_user_id: row.from_user_id.clone(),
        recipient_user_id: row.to_user_id.clone(),
        amount: format_amount(row.amount),
        asset_id: row.asset_id.clone(),
        ledger_tx_id: row.ledger_tx_id.clone(),
        partner_move_id: row.partner_move_id.clone(),
        posted_at: row.posted_at.unwrap_or(row.created_at).iso(),
    });
    let marked = sent.map_err(Refusal::Other).and_then(|()| {
        with(d.store, |c| {
            c.execute(
                &format!(
                    "UPDATE bank.personal_transfers SET announced_at = {} \
                     WHERE transfer_id = $1 AND status = 'posted' AND announced_at IS NULL",
                    at("$2")
                ),
                &[&row.transfer_id, &d.now.0],
            )
            .map_err(|e| pg(&e))
        })
    });
    match marked {
        Ok(_) => true,
        Err(e) => {
            log(
                "bank.transfer_notice_failed",
                vec![
                    ("transferId", Json::str(row.transfer_id.clone())),
                    ("detail", Json::str(refusal_text(&e))),
                ],
            );
            false
        }
    }
}

/// `announceUnannounced`: the recovery job's pass over posted sends whose notice is still owed.
pub fn announce_unannounced(d: &Deps<'_>, limit: i64) -> Result<Vec<Result<(), String>>, Refusal> {
    let before = d.now.0 - NOTICE_RETRY_AFTER_MS;
    let rows = with(d.store, |c| {
        c.query(
            &format!(
                "SELECT {COLS} FROM bank.personal_transfers \
                 WHERE status = 'posted' AND announced_at IS NULL AND COALESCE(posted_at, created_at) < {} \
                 ORDER BY created_at LIMIT $2",
                at("$1")
            ),
            &[&before, &limit],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(transfer_rows(&rows)?
        .iter()
        .map(|row| {
            let announced = (row.ledger_tx_id.is_some() || row.partner_move_id.is_some())
                && announce_posted(d, row);
            if announced {
                Ok(())
            } else {
                Err("bank.transfer_notice_failed".to_owned())
            }
        })
        .collect())
}

/// `sentBy`: whether this person made this send (posted or still reserved).
pub fn sent_by(d: &Deps<'_>, user_id: &str, transfer_id: &str) -> Result<bool, Refusal> {
    let rows = with(d.store, |c| {
        c.query(
            "SELECT 1 FROM bank.personal_transfers WHERE transfer_id = $1 AND from_user_id = $2 \
             AND status IN ('posted', 'reserved') LIMIT 1",
            &[&transfer_id, &user_id],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(!rows.is_empty())
}

/// `partnerLabel`.
fn partner_label(d: &Deps<'_>, user_id: &str) -> String {
    d.custody
        .bank_for(user_id)
        .map_or_else(|| "partner bank".to_owned(), |p| p.label().to_owned())
}

fn opt(s: Option<&String>) -> Json {
    s.map_or(Json::Null, |v| Json::str(v.clone()))
}

/// `PersonalTransferView`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferView {
    pub transfer_id: String,
    pub ledger_tx_id: Option<String>,
    /// `(id, label)`.
    pub partner_move: Option<(String, String)>,
    pub amount: Amount,
    pub asset_id: String,
    pub note: Option<String>,
    pub reference: Option<String>,
    pub request_id: Option<String>,
    pub from_handle: Option<String>,
    pub to_handle: Option<String>,
    pub handles_blocker: Option<&'static str>,
    pub created_at: Instant,
}

impl TransferView {
    pub fn partner_move_json(&self) -> Json {
        self.partner_move
            .as_ref()
            .map_or(Json::Null, |(id, label)| {
                Json::obj([
                    ("id", Json::str(id.clone())),
                    ("label", Json::str(label.clone())),
                ])
            })
    }

    /// `transfers.get`'s output, in its schema's key order.
    pub fn receipt(&self) -> Json {
        Json::obj([
            ("ledgerTxId", opt(self.ledger_tx_id.as_ref())),
            ("partnerMove", self.partner_move_json()),
            ("transferId", Json::str(self.transfer_id.clone())),
            ("createdAt", Json::str(self.created_at.iso())),
            ("fromHandle", opt(self.from_handle.as_ref())),
            ("toHandle", opt(self.to_handle.as_ref())),
            (
                "handlesBlocker",
                self.handles_blocker.map_or(Json::Null, Json::str),
            ),
            ("fee", Json::Null),
            ("status", Json::str("posted")),
            ("amount", Json::str(format_amount(self.amount))),
            ("assetId", Json::str(self.asset_id.clone())),
            ("note", opt(self.note.as_ref())),
            ("reference", opt(self.reference.as_ref())),
        ])
    }

    /// `transfers.toUser`'s output, in its schema's key order.
    pub fn sent(&self) -> Json {
        Json::obj([
            ("ledgerTxId", opt(self.ledger_tx_id.as_ref())),
            ("partnerMove", self.partner_move_json()),
            ("amount", Json::str(format_amount(self.amount))),
            ("note", opt(self.note.as_ref())),
            ("reference", opt(self.reference.as_ref())),
            ("requestId", opt(self.request_id.as_ref())),
        ])
    }
}

/// `toTransferView`: a ledger send is dated by its posting.
pub fn transfer_view(d: &Deps<'_>, row: &TransferRow) -> Result<TransferView, Refusal> {
    let mut created_at = row.created_at;
    if let Some(t) = match &row.ledger_tx_id {
        Some(tx) => d.ledger.tx_by_id(tx).map_err(Refusal::Other)?,
        None => None,
    } {
        created_at = t.posted_at;
    }
    let missing = row.from_handle.is_none() || row.to_handle.is_none();
    Ok(TransferView {
        transfer_id: row.transfer_id.clone(),
        ledger_tx_id: row.ledger_tx_id.clone(),
        partner_move: row
            .partner_move_id
            .as_ref()
            .map(|id| (id.clone(), partner_label(d, &row.from_user_id))),
        amount: row.amount,
        asset_id: row.asset_id.clone(),
        note: row.note.clone(),
        reference: row.reference.clone(),
        request_id: row.request_id.clone(),
        from_handle: row.from_handle.clone(),
        to_handle: row.to_handle.clone(),
        handles_blocker: missing.then(|| {
            if d.w.handles.is_some() {
                "bank.party_handles_missing"
            } else {
                "bank.party_handles_unset"
            }
        }),
        created_at,
    })
}

fn transfer_not_found(id: &str) -> Refusal {
    refuse(
        "bank.personal_transfer_not_found",
        format!("Transfer {id} not found (bank.personal_transfer_not_found)"),
    )
}

/// `get`: a posted send's receipt, for its two parties only; a stranger gets the same not-found as a missing id.
pub fn get(d: &Deps<'_>, actor: &str, ledger_tx_id: &str) -> Result<TransferView, Refusal> {
    let rows = with(d.store, |c| {
        c.query(
            &format!(
                "SELECT {COLS} FROM bank.personal_transfers \
                 WHERE (ledger_tx_id = $1 OR partner_move_id = $1) AND status = 'posted' \
                 AND (from_user_id = $2 OR to_user_id = $2)"
            ),
            &[&ledger_tx_id, &actor],
        )
        .map_err(|e| pg(&e))
    })?;
    let row = transfer_rows(&rows)?
        .into_iter()
        .next()
        .ok_or_else(|| transfer_not_found(ledger_tx_id))?;
    transfer_view(d, &row)
}

/// One send's row by its id.
pub fn by_id(
    c: &mut impl GenericClient,
    transfer_id: &str,
) -> Result<Option<TransferRow>, Refusal> {
    let rows = c
        .query(
            &format!("SELECT {COLS} FROM bank.personal_transfers WHERE transfer_id = $1"),
            &[&transfer_id],
        )
        .map_err(|e| pg(&e))?;
    Ok(transfer_rows(&rows)?.into_iter().next())
}

/// `mustTransfer`: a send that has posted somewhere.
pub fn must_transfer(d: &Deps<'_>, transfer_id: &str) -> Result<TransferRow, Refusal> {
    with(d.store, |c| by_id(c, transfer_id))?
        .filter(|r| r.ledger_tx_id.is_some() || r.partner_move_id.is_some())
        .ok_or_else(|| transfer_not_found(transfer_id))
}

/// `reviewRow`.
pub fn review_row(d: &Deps<'_>, transfer_id: &str) -> Result<Option<ReviewRow>, Refusal> {
    let rows = with(d.store, |c| {
        c.query(
            &format!(
                "SELECT {} FROM bank.personal_send_reviews WHERE transfer_id = $1",
                review::COLS
            ),
            &[&transfer_id],
        )
        .map_err(|e| pg(&e))
    })?;
    rows.first().map(ReviewRow::from_row).transpose()
}

fn held_not_found() -> Refusal {
    refuse(
        "bank.held_send_not_found",
        "No held payment with that id (bank.held_send_not_found)",
    )
}

/// `heldSend`: the sender's own held send; a stranger gets the same not-found as a missing id.
pub fn held_send(d: &Deps<'_>, user_id: &str, transfer_id: &str) -> Result<HeldView, Refusal> {
    match review_row(d, transfer_id)? {
        Some(row) if row.from_user_id == user_id => Ok(review::held_view(&row)),
        _ => Err(held_not_found()),
    }
}

/// `abandon`: a send that never posted is let go, and its claim on a request with it.
pub fn abandon(d: &Deps<'_>, transfer_id: &str, request_id: Option<&str>) -> Result<(), Refusal> {
    with(d.store, |c| {
        c.execute(
            "DELETE FROM bank.personal_transfers WHERE transfer_id = $1 AND status = 'reserved'",
            &[&transfer_id],
        )
        .map_err(|e| pg(&e))?;
        match request_id {
            Some(r) => requests::release_claim(c, r, transfer_id),
            None => Ok(()),
        }
    })
}

/// `snapshotHandles`: both handles as they are now, or none when identity is not wired or does not answer.
pub fn snapshot_handles(d: &Deps<'_>, from: &str, to: &str) -> (Option<String>, Option<String>) {
    let Some(port) = d.w.handles.as_deref() else {
        return (None, None);
    };
    match (port.handle_of(from), port.handle_of(to)) {
        (Ok(f), Ok(t)) => (f, t),
        _ => (None, None),
    }
}

/// `bookedSendMatches`: the transaction under the send's key is exactly this send, from its space to the recipient's
/// main account.
pub fn booked_send_matches(
    d: &Deps<'_>,
    tx: &crate::spaces::ports::LedgerTx,
    from_space_id: &str,
    to_user_id: &str,
    asset_id: &str,
    amount: Amount,
) -> Result<bool, Refusal> {
    if tx.entries.len() != 2 {
        return Ok(false);
    }
    let from = with(d.store, |c| space::get(c, from_space_id))?;
    if from.asset_id != asset_id {
        return Ok(false);
    }
    let Some(dest) = with(d.store, |c| moves::find_primary(c, to_user_id, asset_id))? else {
        return Ok(false);
    };
    let from_id = d
        .ledger
        .account_id(&from.ledger_account())
        .map_err(Refusal::Other)?;
    let to_id = d
        .ledger
        .account_id(&dest.ledger_account())
        .map_err(Refusal::Other)?;
    if from_id.is_empty() || to_id.is_empty() {
        return Ok(false);
    }
    let leg = |dir: &str, acct: &str| {
        tx.entries.iter().any(|e| {
            e.direction == dir
                && e.account_id == acct
                && e.asset_id == asset_id
                && e.amount == amount
        })
    };
    Ok(leg("credit", &from_id) && leg("debit", &to_id))
}

/// `heldForReview`: ops' queue of sends the review holds (slice ops-desk's call).
pub fn held_for_review(
    d: &Deps<'_>,
    limit: i64,
) -> Result<Vec<(HeldView, String, String)>, Refusal> {
    let rows = with(d.store, |c| {
        c.query(
            &format!(
                "SELECT {} FROM bank.personal_send_reviews WHERE status IN ('in_review', 'releasing') \
                 ORDER BY created_at ASC LIMIT $1",
                review::COLS
            ),
            &[&limit],
        )
        .map_err(|e| pg(&e))
    })?;
    rows.iter()
        .map(|r| {
            let row = ReviewRow::from_row(r)?;
            Ok((
                review::held_view(&row),
                row.from_user_id.clone(),
                row.to_user_id.clone(),
            ))
        })
        .collect()
}

/// `partnerFeeKnown`: whether the partner says what a move costs; without the partner the published fee stands.
fn partner_fee_known(d: &Deps<'_>, user_id: &str) -> bool {
    d.partner
        .partner
        .as_ref()
        .is_none_or(|p| p.switches(user_id).fee == "known")
}

/// `assertPartnerAnswering`.
pub fn assert_partner_answering(d: &Deps<'_>, user_id: &str) -> Result<(), Refusal> {
    if d.partner
        .partner
        .as_ref()
        .is_some_and(|p| p.switches(user_id).down)
    {
        return Err(refuse(
            "bank.partner_unavailable",
            "The partner bank is not answering. Nothing was sent or changed.",
        ));
    }
    Ok(())
}

// ── Sending ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// What `send` is asked.
pub struct SendInput<'a> {
    pub actor_user_id: &'a str,
    pub transfer_id: &'a str,
    pub from_space_id: &'a str,
    pub to_user_id: &'a str,
    pub amount: Amount,
    pub note: Option<&'a str>,
    pub reference: Option<&'a str>,
    pub request_id: Option<&'a str>,
    /// Only the review's own release, and svc-pay's withdrawal, send with this: the rule is not asked again.
    pub reviewed: bool,
}

/// `send`'s answer: the posted send, or the send the review holds.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(
    clippy::large_enum_variant,
    reason = "one per send, never held in bulk"
)]
pub enum Sent {
    Posted(TransferView),
    Held(HeldView),
}

/// A send that failed: the refusal, whether it proves nothing was sent (`isDefinitePersonalRefusal`), and its code.
#[derive(Debug)]
pub struct SendFailed {
    pub refusal: Refusal,
    pub definite: bool,
    pub code: Option<String>,
}

fn code_of(r: &Refusal) -> Option<String> {
    match r {
        Refusal::Bank(e) => Some(e.row.code.to_owned()),
        Refusal::Trpc(e) => e.cause.clone(),
        Refusal::Other(_) => None,
    }
}

impl From<Refusal> for Box<SendFailed> {
    /// A `BankError` proves nothing was sent, except a partner answer that was lost; anything untyped may have.
    fn from(refusal: Refusal) -> Box<SendFailed> {
        let definite =
            matches!(&refusal, Refusal::Bank(e) if e.row.code != "bank.partner_reply_lost");
        let code = code_of(&refusal);
        Box::new(SendFailed {
            refusal,
            definite,
            code,
        })
    }
}

/// A failed move, judged as `send`'s catch judges it: a post failure is definite only when it proves no commit (the
/// posting freeze, so proved, is answered as `ledger.frozen`), and a booked movement that is not this send never is.
fn move_failure(f: Failed) -> Box<SendFailed> {
    if let Some(post) = &f.post {
        let definite = post.proves_not_committed();
        if definite && post.code() == Some("ledger.frozen") {
            return Box::new(SendFailed {
                refusal: Refusal::Trpc(TrpcError::caused(
                    "PRECONDITION_FAILED",
                    "ledger.frozen",
                    "ledger.frozen",
                )),
                definite,
                code: Some("ledger.frozen".to_owned()),
            });
        }
        let code = post.code().map(str::to_owned);
        return Box::new(SendFailed {
            code,
            refusal: f.refusal,
            definite,
        });
    }
    let booked =
        matches!(&f.refusal, Refusal::Bank(e) if e.row.code == "bank.personal_transfer_conflict");
    let mut out = Box::<SendFailed>::from(f.refusal);
    out.definite &= !booked;
    out
}

fn transfer_conflict(transfer_id: &str) -> Refusal {
    refuse(
        "bank.personal_transfer_conflict",
        format!(
            "Transfer {transfer_id} already exists on different terms (bank.personal_transfer_conflict)"
        ),
    )
}

fn not_this_send(transfer_id: &str) -> Refusal {
    refuse(
        "bank.personal_transfer_conflict",
        format!("Transfer {transfer_id} is not this send (bank.personal_transfer_conflict)"),
    )
}

/// `sameTransfer`.
fn same_transfer(row: &TransferRow, ask: &review::SendAsk<'_>) -> bool {
    row.from_user_id == ask.actor_user_id
        && row.from_space_id == ask.from_space_id
        && row.to_user_id == ask.to_user_id
        && row.asset_id == ask.asset_id
        && row.amount == ask.amount
        && row.note.as_deref() == ask.note
        && row.reference.as_deref() == ask.reference
        && row.request_id.as_deref() == ask.request_id
}

fn lock_sender(tx: &mut Transaction<'_>, user_id: &str, asset_id: &str) -> Result<(), Refusal> {
    tx.execute(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        &[&user_id, &asset_id],
    )
    .map_err(|e| pg(&e))?;
    Ok(())
}

/// `send`: a send to another person, reserved under its transfer id and posted once (see the module's words).
pub fn send(d: &Deps<'_>, i: &SendInput<'_>) -> Result<Sent, Box<SendFailed>> {
    let now = d.now;
    let note = requests::plain_note(i.note)?;
    let reference = requests::plain_reference(i.reference)?;
    let request_id = i.request_id;
    let to_user_id = i.to_user_id.trim();
    let from = with(d.store, |c| space::get(c, i.from_space_id))?;
    if from.user_id != i.actor_user_id {
        return Err(refuse("bank.not_owner", "Not your space").into());
    }
    // The partner bank holds this person's money: the send is the partner's one move, and nothing of it is posted to the
    // ledger. Paying a request through the partner is not built yet, so it is refused by name, before anything is written.
    let partner = d.custody.bank_for(i.actor_user_id);
    if partner.is_some() && request_id.is_some() {
        return Err(moves::partner_path_not_built().into());
    }
    let ask = review::SendAsk {
        actor_user_id: i.actor_user_id,
        from_space_id: i.from_space_id,
        to_user_id,
        asset_id: &from.asset_id,
        amount: i.amount,
        note: note.as_deref(),
        reference: reference.as_deref(),
        request_id,
    };

    // A send the review holds, or held before: answered from its review row, and no money moves while it waits.
    if !i.reviewed
        && let Some(held) = hold_for_review(d, i.transfer_id, &ask)?
    {
        return Ok(Sent::Held(held));
    }

    sweep_stale(d, i.actor_user_id)?;

    // The network fee the moving book states for this send, recorded with it: "0" on our own book, which crosses no
    // network; the partner's stated send fee for money it holds; none when the partner gives none ("not known").
    let network_fee = match &partner {
        Some(p) if partner_fee_known(d, i.actor_user_id) => {
            p.limits(i.actor_user_id, &from.asset_id, now)?.send_fee
        }
        Some(_) => None,
        None => Some(Amount::ZERO),
    };

    let reserved = in_tx(d.store, |tx| {
        lock_sender(tx, i.actor_user_id, &from.asset_id)?;
        if let Some(existing) = by_id(tx, i.transfer_id)? {
            if !same_transfer(&existing, &ask) {
                return Err(transfer_conflict(i.transfer_id));
            }
            return Ok(existing);
        }
        if let Some(r) = request_id {
            requests::claim(
                tx,
                &requests::Claim {
                    request_id: r,
                    transfer_id: i.transfer_id,
                    payer_user_id: i.actor_user_id,
                    to_user_id,
                    asset_id: &from.asset_id,
                    amount: i.amount,
                    now,
                },
            )?;
        }
        let fee = terms::assert_within_terms(tx, i.actor_user_id, &from.asset_id, i.amount, now)?;
        let (from_handle, to_handle) = snapshot_handles(d, i.actor_user_id, to_user_id);
        let rows = tx
            .query(
                &format!(
                    "INSERT INTO bank.personal_transfers ( \
                       transfer_id, from_user_id, from_space_id, to_user_id, asset_id, amount, note, reference, \
                       from_handle, to_handle, request_id, status, created_at, fee, network_fee \
                     ) VALUES ($1, $2, $3::text::uuid, $4, $5, $6::text::numeric, $7, $8, $9, $10, $11::text::uuid, \
                       'reserved', {}, $13::text::numeric, $14::text::numeric) \
                     RETURNING {COLS}",
                    at("$12")
                ),
                &[
                    &i.transfer_id,
                    &i.actor_user_id,
                    &i.from_space_id,
                    &to_user_id,
                    &from.asset_id,
                    &format_amount(i.amount),
                    &note,
                    &reference,
                    &from_handle,
                    &to_handle,
                    &request_id,
                    &now.0,
                    &format_amount(fee),
                    &network_fee.map(format_amount),
                ],
            )
            .map_err(|e| pg(&e))?;
        let row = rows
            .first()
            .map(TransferRow::from_row)
            .transpose()?
            .ok_or_else(|| Refusal::Other("the reservation returned no row".to_owned()))?;
        // The recipient's rule for strangers is decided here, once, with the reservation: a retry never asks again. Money
        // the partner bank moves straight into the recipient's account there is not set aside on our ledger.
        if partner.is_none() {
            holds::decide(
                tx,
                holds::hold_days(d),
                &holds::Decide {
                    transfer_id: i.transfer_id,
                    payer_user_id: i.actor_user_id,
                    recipient_user_id: to_user_id,
                    asset_id: &from.asset_id,
                    amount: i.amount,
                    request_id,
                    now,
                },
            )?;
        }
        Ok(row)
    })?;

    if reserved.status == "posted" && reserved.partner_move_id.is_some() {
        if reserved.announced_at.is_none() {
            announce_posted(d, &reserved);
        }
        return Ok(Sent::Posted(transfer_view(d, &reserved)?));
    }
    if reserved.status == "posted"
        && let Some(tx_id) = &reserved.ledger_tx_id
    {
        if let Some(r) = &reserved.request_id {
            requests::finish(d, r, i.transfer_id, tx_id)?;
        }
        if reserved.announced_at.is_none() {
            announce_posted(d, &reserved);
        }
        if !hold_received(d, &reserved.transfer_id) {
            credit_posted(d, &reserved, tx_id);
        }
        return Ok(Sent::Posted(transfer_view(d, &reserved)?));
    }

    if let Some(p) = &partner {
        return send_at_partner(d, p, i.transfer_id, &ask).map(Sent::Posted);
    }

    let ledger_tx_id = match moves::transfer_to_user_outcome(
        d,
        i.transfer_id,
        i.from_space_id,
        to_user_id,
        i.amount,
    ) {
        Ok(moved) => match moved.made {
            Made::Ledger(id) => id,
            // The sender is not held at the partner, so the post went to the ledger; a partner answer here would mean the
            // book changed under this send.
            Made::Partner(_) => {
                return Err(Refusal::Other(format!(
                    "send {} was moved by the partner, not the ledger",
                    i.transfer_id
                ))
                .into());
            }
        },
        Err(f) => {
            let failed = move_failure(*f);
            // A typed refusal proved this send did not post. Looking the key up would adopt whatever else is booked
            // under it, including an own-space move.
            if failed.definite {
                abandon(d, i.transfer_id, request_id)?;
                return Err(failed);
            }
            // Timeout, network, or 5xx: the post may still land. Keep the reservation and the request claim. Adopt the
            // key only when its entries are this send.
            let Some(already) = d
                .ledger
                .tx_by_key(&send_key(i.transfer_id))
                .map_err(Refusal::Other)?
            else {
                return Err(failed);
            };
            if !booked_send_matches(
                d,
                &already,
                i.from_space_id,
                to_user_id,
                &from.asset_id,
                i.amount,
            )? {
                return Err(not_this_send(i.transfer_id).into());
            }
            already.id
        }
    };

    let row = mark_posted(d, i.transfer_id, "ledger_tx_id", &ledger_tx_id)?;
    if let Some(r) = request_id {
        requests::finish(d, r, i.transfer_id, &ledger_tx_id)?;
    }
    if row.status == "posted" && row.announced_at.is_none() {
        announce_posted(d, &row);
    }
    if row.status == "posted" && !hold_received(d, &row.transfer_id) {
        credit_posted(d, &row, &ledger_tx_id);
    }
    Ok(Sent::Posted(transfer_view(d, &row)?))
}

/// The reserved row marked posted under the ledger transaction or the partner's move (`column`), or the row as it
/// already stands.
fn mark_posted(
    d: &Deps<'_>,
    transfer_id: &str,
    column: &str,
    id: &str,
) -> Result<TransferRow, Refusal> {
    let rows = with(d.store, |c| {
        c.query(
            &format!(
                "UPDATE bank.personal_transfers SET status = 'posted', {column} = $2, posted_at = {} \
                 WHERE transfer_id = $1 AND status = 'reserved' RETURNING {COLS}",
                at("$3")
            ),
            &[&transfer_id, &id, &d.now.0],
        )
        .map_err(|e| pg(&e))
    })?;
    match rows.first() {
        Some(r) => TransferRow::from_row(r),
        None => must_transfer(d, transfer_id),
    }
}

/// `holdReceived`: a posted payment the recipient's rule held is set aside. True while it is held, so it is not handed
/// to the income sorter. A failure is logged and finished by the recovery timer: the send has posted and its answer
/// stands.
fn hold_received(d: &Deps<'_>, transfer_id: &str) -> bool {
    match holds::place_for(d, transfer_id, d.now) {
        Ok(held) => held,
        Err(e) => {
            log(
                "bank.received_hold_after_send_failed",
                vec![
                    ("transferId", Json::str(transfer_id)),
                    ("detail", Json::str(refusal_text(&e))),
                ],
            );
            // Unknown: treat it as held, so the sorter never moves money the hold may still need.
            true
        }
    }
}

/// `creditPosted`: hand a posted send to the recipient's income sorter (`onCreditPosted`). The sorter's own sweep picks
/// up anything this misses, so a failure here is logged and the send's answer stands.
fn credit_posted(d: &Deps<'_>, row: &TransferRow, ledger_tx_id: &str) {
    let Some(hook) = d.w.credit_posted.as_ref() else {
        return;
    };
    let credit = super::ports::IncomingCredit {
        transfer_id: row.transfer_id.clone(),
        from_user_id: row.from_user_id.clone(),
        to_user_id: row.to_user_id.clone(),
        asset_id: row.asset_id.clone(),
        amount: row.amount,
        ledger_tx_id: ledger_tx_id.to_owned(),
        posted_at: row.posted_at.unwrap_or(row.created_at),
    };
    if let Err(e) = hook.credit_posted(d, &credit) {
        log(
            "bank.sorter_after_send_failed",
            vec![
                ("transferId", Json::str(row.transfer_id.clone())),
                ("detail", Json::str(refusal_text(&e))),
            ],
        );
    }
}

/// `sendAtPartner`: the send as the partner bank's one move under `bank.transfer.p2p:<transferId>:0`, nothing posted to
/// the ledger. A lost partner answer keeps the reservation for the retry; only a refusal that proves nothing moved lets
/// it go.
fn send_at_partner(
    d: &Deps<'_>,
    partner: &Held<'_>,
    transfer_id: &str,
    ask: &review::SendAsk<'_>,
) -> Result<TransferView, Box<SendFailed>> {
    let moved = match moves::transfer_to_user_outcome(
        d,
        transfer_id,
        ask.from_space_id,
        ask.to_user_id,
        ask.amount,
    ) {
        Ok(m) => match m.made {
            Made::Partner(mv) => mv,
            Made::Ledger(_) => {
                return Err(Refusal::Other(format!(
                    "send {transfer_id} was posted to the ledger, not moved by the partner"
                ))
                .into());
            }
        },
        Err(f) => {
            let failed = move_failure(*f);
            if !failed.definite {
                return Err(failed);
            }
            // A refusal before the partner was asked proves nothing moved, unless an earlier ask under this key already did.
            match partner.move_by_key(&send_key(transfer_id)) {
                Some(prior) => prior,
                None => {
                    abandon(d, transfer_id, None)?;
                    return Err(failed);
                }
            }
        }
    };
    if !partner_move_is_send(
        d,
        &moved,
        ask.from_space_id,
        ask.to_user_id,
        ask.asset_id,
        ask.amount,
    )? {
        return Err(not_this_send(transfer_id).into());
    }
    let row = mark_posted(d, transfer_id, "partner_move_id", &moved.id)?;
    if row.status == "posted" && row.announced_at.is_none() {
        announce_posted(d, &row);
    }
    Ok(transfer_view(d, &row)?)
}

/// `partnerMoveIsSend`: from the sender's space at the partner to the recipient's main account, same amount.
fn partner_move_is_send(
    d: &Deps<'_>,
    mv: &Move,
    from_space_id: &str,
    to_user_id: &str,
    asset_id: &str,
    amount: Amount,
) -> Result<bool, Refusal> {
    let from = with(d.store, |c| space::get(c, from_space_id))?.partner_account();
    let Some(dest) = with(d.store, |c| moves::find_primary(c, to_user_id, asset_id))? else {
        return Ok(false);
    };
    let to = dest.partner_account();
    let same = |a: &AccountRef, b: &AccountRef| {
        a.user_id == b.user_id && a.asset_id == b.asset_id && a.space_id == b.space_id
    };
    Ok(same(&mv.from, &from) && same(&mv.to, &to) && mv.amount == amount)
}

fn log_adopt_mismatch(row: &TransferRow, tx_id: &str, err: Option<&Refusal>) {
    log(
        "bank.personal_transfer_adopt_mismatch",
        vec![
            ("transferId", Json::str(row.transfer_id.clone())),
            ("requestId", opt(row.request_id.as_ref())),
            ("ledgerTxId", Json::str(tx_id)),
            (
                "detail",
                err.map_or(Json::Null, |e| {
                    Json::str(match e {
                        Refusal::Bank(_) => "BankError",
                        Refusal::Trpc(_) => "TRPCError",
                        Refusal::Other(_) => "Error",
                    })
                }),
            ),
        ],
    );
}

/// `sweepStale`: the person's reservations older than the stale cutoff are settled from the book that holds the money:
/// adopted when the move under the key is this send, let go when nothing is there, left (and logged) otherwise.
fn sweep_stale(d: &Deps<'_>, user_id: &str) -> Result<(), Refusal> {
    let cutoff = d.now.0 - terms::STALE_RESERVATION_MS;
    let rows = with(d.store, |c| {
        c.query(
            &format!(
                "SELECT {COLS} FROM bank.personal_transfers \
                 WHERE from_user_id = $1 AND status = 'reserved' AND created_at < {}",
                at("$2")
            ),
            &[&user_id, &cutoff],
        )
        .map_err(|e| pg(&e))
    })?;
    let partner = d.custody.bank_for(user_id);
    for row in transfer_rows(&rows)? {
        let key = send_key(&row.transfer_id);
        if let Some(p) = &partner {
            // Money the partner bank holds: the partner's record under the key says whether it moved, never the ledger's.
            let Some(moved) = p.move_by_key(&key) else {
                abandon(d, &row.transfer_id, row.request_id.as_deref())?;
                continue;
            };
            if !partner_move_is_send(
                d,
                &moved,
                &row.from_space_id,
                &row.to_user_id,
                &row.asset_id,
                row.amount,
            )? {
                log_adopt_mismatch(&row, &moved.id, None);
                continue;
            }
            mark_posted(d, &row.transfer_id, "partner_move_id", &moved.id)?;
            continue;
        }
        let Some(posted) = d.ledger.tx_by_key(&key).map_err(Refusal::Other)? else {
            abandon(d, &row.transfer_id, row.request_id.as_deref())?;
            continue;
        };
        match booked_send_matches(
            d,
            &posted,
            &row.from_space_id,
            &row.to_user_id,
            &row.asset_id,
            row.amount,
        ) {
            Ok(true) => {}
            Ok(false) => {
                log_adopt_mismatch(&row, &posted.id, None);
                continue;
            }
            Err(e) => {
                log_adopt_mismatch(&row, &posted.id, Some(&e));
                continue;
            }
        }
        mark_posted(d, &row.transfer_id, "ledger_tx_id", &posted.id)?;
        if let Some(r) = &row.request_id {
            requests::finish(d, r, &row.transfer_id, &posted.id)?;
        }
    }
    Ok(())
}

/// `holdForReview`: a transfer id already held answers from its row; a new send above the rule's line is checked as any
/// send is (the recipient, the request, the terms) and written as held, with no reservation and no ledger call. `None`
/// when the send goes on now.
fn hold_for_review(
    d: &Deps<'_>,
    transfer_id: &str,
    ask: &review::SendAsk<'_>,
) -> Result<Option<HeldView>, Refusal> {
    if let Some(earlier) = review_row(d, transfer_id)? {
        if !review::same_held_send(&earlier, ask) {
            return Err(transfer_conflict(transfer_id));
        }
        return Ok((earlier.status != "released").then(|| review::held_view(&earlier)));
    }
    let rule = review::rule_of(d.w.settings.send_review.as_deref());
    let Some(reason) = review::reason(rule.as_ref(), ask.asset_id, ask.amount) else {
        return Ok(None);
    };
    // A send the bank would refuse now is refused now, never held: an unknown, frozen or closed recipient...
    moves::assert_can_receive(d, ask.to_user_id)?;
    let held = in_tx(d.store, |tx| {
        lock_sender(tx, ask.actor_user_id, ask.asset_id)?;
        // A send already under way under this id (posted, or reserved by a race) is never turned into a held one.
        if by_id(tx, transfer_id)?.is_some() {
            return Ok(None);
        }
        // ...a request it cannot settle (its claim also keeps anyone else from paying it while this waits)...
        if let Some(r) = ask.request_id {
            requests::claim(
                tx,
                &requests::Claim {
                    request_id: r,
                    transfer_id,
                    payer_user_id: ask.actor_user_id,
                    to_user_id: ask.to_user_id,
                    asset_id: ask.asset_id,
                    amount: ask.amount,
                    now: d.now,
                },
            )?;
        }
        // ...or over the limits, as any send is: a review never stands in for a refusal.
        terms::assert_within_terms(tx, ask.actor_user_id, ask.asset_id, ask.amount, d.now)?;
        let (from_handle, to_handle) = snapshot_handles(d, ask.actor_user_id, ask.to_user_id);
        tx.execute(
            &format!(
                "INSERT INTO bank.personal_send_reviews ( \
                   transfer_id, from_user_id, from_space_id, to_user_id, asset_id, amount, note, reference, request_id, \
                   from_handle, to_handle, reason_class, status, created_at \
                 ) VALUES ($1, $2, $3::text::uuid, $4, $5, $6::text::numeric, $7, $8, $9::text::uuid, $10, $11, $12, \
                   'in_review', {}) \
                 ON CONFLICT (transfer_id) DO NOTHING",
                at("$13")
            ),
            &[
                &transfer_id,
                &ask.actor_user_id,
                &ask.from_space_id,
                &ask.to_user_id,
                &ask.asset_id,
                &format_amount(ask.amount),
                &ask.note,
                &ask.reference,
                &ask.request_id,
                &from_handle,
                &to_handle,
                &reason,
                &d.now.0,
            ],
        )
        .map_err(|e| pg(&e))?;
        let rows = tx
            .query(
                &format!(
                    "SELECT {} FROM bank.personal_send_reviews WHERE transfer_id = $1",
                    review::COLS
                ),
                &[&transfer_id],
            )
            .map_err(|e| pg(&e))?;
        rows.first().map(ReviewRow::from_row).transpose()
    })?;
    let Some(row) = held else {
        return Ok(None);
    };
    if !review::same_held_send(&row, ask) {
        return Err(transfer_conflict(transfer_id));
    }
    Ok(Some(review::held_view(&row)))
}

fn held_decided(status: &str) -> Refusal {
    refuse(
        "bank.held_send_decided",
        format!("The held payment is {status} (bank.held_send_decided)"),
    )
}

fn review_rows(rows: &[Row]) -> Result<Option<ReviewRow>, Refusal> {
    rows.first().map(ReviewRow::from_row).transpose()
}

/// `releaseHeld`: an operator's release sends the held send now through the normal path under its own id, so the
/// terms, the balance and the recipient are checked as of now and it posts once. A refusal that proves nothing posted
/// puts it back in review; anything else leaves it releasing, and a repeat finds out.
pub fn release_held(
    d: &Deps<'_>,
    transfer_id: &str,
    operator_id: &str,
) -> Result<HeldView, Refusal> {
    let claimed = with(d.store, |c| {
        c.query(
            &format!(
                "UPDATE bank.personal_send_reviews SET status = 'releasing', decided_by = $2 \
                 WHERE transfer_id = $1 AND status IN ('in_review', 'releasing') RETURNING {}",
                review::COLS
            ),
            &[&transfer_id, &operator_id],
        )
        .map_err(|e| pg(&e))
    })?;
    let row = match review_rows(&claimed)? {
        Some(r) => r,
        None => review_row(d, transfer_id)?.ok_or_else(held_not_found)?,
    };
    if row.status == "released" {
        return Ok(review::held_view(&row));
    }
    if row.status != "releasing" {
        return Err(held_decided(&row.status));
    }
    let sent = if d.custody.bank_for(&row.from_user_id).is_some() {
        // A held send of money the partner bank holds is not released through the partner yet: it stays in review, where
        // an operator can reject it, and nothing moves.
        Err(Box::<SendFailed>::from(moves::partner_path_not_built()))
    } else {
        send(
            d,
            &SendInput {
                actor_user_id: &row.from_user_id,
                transfer_id: &row.transfer_id,
                from_space_id: &row.from_space_id,
                to_user_id: &row.to_user_id,
                amount: row.amount,
                note: row.note.as_deref(),
                reference: row.reference.as_deref(),
                request_id: row.request_id.as_deref(),
                reviewed: true,
            },
        )
    };
    let sent = match sent {
        Ok(s) => s,
        Err(e) => {
            if e.definite {
                with(d.store, |c| {
                    c.execute(
                        "UPDATE bank.personal_send_reviews SET status = 'in_review', decided_by = NULL \
                         WHERE transfer_id = $1 AND status = 'releasing'",
                        &[&transfer_id],
                    )
                    .map_err(|e| pg(&e))
                })?;
            }
            return Err(e.refusal);
        }
    };
    let Sent::Posted(TransferView {
        ledger_tx_id: Some(tx_id),
        ..
    }) = sent
    else {
        return Err(Refusal::Other(format!(
            "held send {transfer_id} did not post"
        )));
    };
    let released = with(d.store, |c| {
        c.query(
            &format!(
                "UPDATE bank.personal_send_reviews SET status = 'released', ledger_tx_id = $2, decided_by = $3, \
                 decided_at = {} WHERE transfer_id = $1 AND status = 'releasing' RETURNING {}",
                at("$4"),
                review::COLS
            ),
            &[&transfer_id, &tx_id, &operator_id, &d.now.0],
        )
        .map_err(|e| pg(&e))
    })?;
    match review_rows(&released)? {
        Some(r) => Ok(review::held_view(&r)),
        None => review_row(d, transfer_id)?
            .map(|r| review::held_view(&r))
            .ok_or_else(held_not_found),
    }
}

/// `rejectHeld`: nothing was taken while it waited, so nothing moves; a request it claimed is free to be paid again. A
/// send being released (or released) is never rejected.
pub fn reject_held(
    d: &Deps<'_>,
    transfer_id: &str,
    operator_id: &str,
) -> Result<HeldView, Refusal> {
    let now = d.now.0;
    let rejected = in_tx(d.store, |tx| {
        let rows = tx
            .query(
                &format!(
                    "UPDATE bank.personal_send_reviews SET status = 'rejected', decided_by = $2, decided_at = {} \
                     WHERE transfer_id = $1 AND status = 'in_review' \
                     AND NOT EXISTS (SELECT 1 FROM bank.personal_transfers WHERE transfer_id = $1) RETURNING {}",
                    at("$3"),
                    review::COLS
                ),
                &[&transfer_id, &operator_id, &now],
            )
            .map_err(|e| pg(&e))?;
        let done = review_rows(&rows)?;
        if let Some(request_id) = done.as_ref().and_then(|r| r.request_id.as_deref()) {
            tx.execute(
                &format!(
                    "UPDATE bank.personal_requests SET claim_transfer_id = NULL, updated_at = {} \
                     WHERE id = $1::text::uuid AND claim_transfer_id = $2 AND status = 'open'",
                    at("$3")
                ),
                &[&request_id, &transfer_id, &now],
            )
            .map_err(|e| pg(&e))?;
        }
        Ok(done)
    })?;
    if let Some(r) = rejected {
        return Ok(review::held_view(&r));
    }
    let row = review_row(d, transfer_id)?.ok_or_else(held_not_found)?;
    if row.status == "rejected" {
        return Ok(review::held_view(&row));
    }
    Err(held_decided(&row.status))
}

/// svc-pay's withdrawal to another person's platform address (`bank-internal-withdrawal`).
pub struct Withdrawal<'a> {
    pub transfer_id: &'a str,
    pub from_user_id: &'a str,
    pub to_user_id: &'a str,
    pub asset_id: &'a str,
    pub amount: Amount,
}

fn withdrawal_posted(transfer_id: &str, ledger_tx_id: &str) -> Json {
    Json::obj([
        ("state", Json::str("posted")),
        ("transferId", Json::str(transfer_id)),
        ("ledgerTxId", Json::str(ledger_tx_id)),
    ])
}

/// `settleWithdrawal`: one person-to-person send from the sender's main account under svc-pay's key. `refused` only
/// when this send provably posted nothing; every other failure is thrown, so the caller hears "unknown" and asks again.
pub fn settle_withdrawal(d: &Deps<'_>, w: &Withdrawal<'_>) -> Result<Json, Refusal> {
    let key = send_key(w.transfer_id);
    // An earlier ask under this key still inside the ledger's in-flight bound may yet post, so no refusal from this ask
    // can prove the key empty.
    let earlier = with(d.store, |c| {
        c.query(
            "SELECT floor(extract(epoch from created_at) * 1000)::int8 FROM bank.personal_transfers \
             WHERE transfer_id = $1 AND status = 'reserved'",
            &[&w.transfer_id],
        )
        .map_err(|e| pg(&e))
    })?;
    let earlier_in_flight = match earlier.first() {
        Some(r) => d.now.0 - r.try_get::<_, i64>(0).map_err(|e| pg(&e))? < POST_IN_FLIGHT_BOUND_MS,
        None => false,
    };
    let attempt = || -> Result<(String, String), Box<SendFailed>> {
        // A withdrawal from money the partner bank holds is not settled through the partner yet: refused, nothing sent.
        if d.custody.bank_for(w.from_user_id).is_some() {
            return Err(moves::partner_path_not_built().into());
        }
        // Refused while the owner's security lock holds, unless this key already holds the send.
        if d.ledger.tx_by_key(&key).map_err(Refusal::Other)?.is_none() {
            ports::assert_security_lock_open(d.w.lock.as_ref(), w.from_user_id, "a withdrawal")?;
        }
        // No edge stands in front of this door, so the sender's own account state is asked here.
        moves::assert_can_send(d, w.from_user_id)?;
        let from = with(d.store, |c| {
            match moves::find_primary(c, w.from_user_id, w.asset_id)? {
                Some(s) => Ok(s),
                None => space::ensure_primary(c, w.from_user_id, w.asset_id),
            }
        })?;
        // svc-pay reviewed this withdrawal under its own rules before it asked: the send review does not hold it again.
        let sent = send(
            d,
            &SendInput {
                actor_user_id: w.from_user_id,
                transfer_id: w.transfer_id,
                from_space_id: &from.id,
                to_user_id: w.to_user_id,
                amount: w.amount,
                note: None,
                reference: None,
                request_id: None,
                reviewed: true,
            },
        )?;
        match sent {
            Sent::Posted(TransferView {
                transfer_id,
                ledger_tx_id: Some(tx_id),
                ..
            }) => Ok((transfer_id, tx_id)),
            _ => Err(Refusal::Other(format!("withdrawal {} was not posted", w.transfer_id)).into()),
        }
    };
    let err = match attempt() {
        Ok((transfer_id, tx_id)) => return Ok(withdrawal_posted(&transfer_id, &tx_id)),
        Err(e) => e,
    };
    if !err.definite {
        return Err(err.refusal);
    }
    // A refusal is the caller's licence to close its withdrawal, so it is checked against the book first: if this key
    // already holds this very send, the answer is that send.
    if let Some(booked) = d.ledger.tx_by_key(&key).map_err(Refusal::Other)? {
        let from = with(d.store, |c| {
            moves::find_primary(c, w.from_user_id, w.asset_id)
        })?;
        if let Some(f) = from
            && booked_send_matches(d, &booked, &f.id, w.to_user_id, w.asset_id, w.amount)?
        {
            return Ok(withdrawal_posted(w.transfer_id, &booked.id));
        }
        return Err(err.refusal);
    }
    // A conflict means something is already filed under this key: never a licence to close.
    if earlier_in_flight || err.code.as_deref() == Some("bank.personal_transfer_conflict") {
        return Err(err.refusal);
    }
    let code = err
        .code
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| "bank.internal_withdrawal_refused".to_owned());
    Ok(Json::obj([
        ("state", Json::str("refused")),
        ("code", Json::str(code)),
    ]))
}

fn opt_text<'v>(v: &'v service_kit::schema::Value, key: &str) -> Option<&'v str> {
    v.get(key).as_str()
}

/// `transfers.toUser`: the debit side is the caller's own space; the person's extra checks and the step-up come before
/// any money moves; a held send answers as a typed refusal that names the review.
fn to_user(d: &Deps<'_>, ctx: &crate::door::Ctx<'_>) -> Result<Json, Refusal> {
    let Some(principal) = ctx.principal else {
        return Err(Refusal::Other(
            "transfers.toUser has no principal".to_owned(),
        ));
    };
    let user = principal.user_id.as_str();
    let input = &ctx.input;
    assert_partner_answering(d, user)?;
    let from = with(d.store, |c| {
        let from = space::get(c, text(input, "fromSpaceId"))?;
        assert_may_take_out(c, user, &from.id, &from.user_id)?;
        Ok(from)
    })?;
    schedules::assert_self(user, &from.user_id)?;
    let note = requests::plain_note(opt_text(input, "note"))?;
    let reference = requests::plain_reference(opt_text(input, "reference"))?;
    let transfer_id = text(input, "transferId");
    let to_user_id = text(input, "toUserId");
    let request_id = opt_text(input, "requestId");
    let amount_text = text(input, "amount");
    let amount = parse_amount(amount_text).map_err(Refusal::Other)?;
    // The person's own extra checks hold a send above their allowance, before any step-up is spent.
    safety::assert_extras_allow(
        d.w.extras.as_ref(),
        user,
        to_user_id,
        &from.asset_id,
        amount,
    )?;
    if step_up::enforced(d) && to_user_id != user {
        let binding = step_up::to_user_binding(&step_up::ToUser {
            actor: user,
            transfer_id,
            from_space_id: text(input, "fromSpaceId"),
            to_user_id,
            asset_id: &from.asset_id,
            amount: amount_text,
            note: note.as_deref(),
            reference: reference.as_deref(),
            request_id,
        });
        step_up::require(d, principal, &binding, opt_text(input, "stepUpApprovalId"))?;
    }
    let sent = send(
        d,
        &SendInput {
            actor_user_id: user,
            transfer_id,
            from_space_id: text(input, "fromSpaceId"),
            to_user_id,
            amount,
            note: note.as_deref(),
            reference: reference.as_deref(),
            request_id,
            reviewed: false,
        },
    )
    .map_err(|e| {
        // Paying more than the balance holds: the caller is told their own figures, for a payment from the main account
        // only; a named space's refusal stays the ledger's.
        if from.primary() {
            moves::spend_refusal(d, e.refusal, user, &from.asset_id)
        } else {
            e.refusal
        }
    })?;
    match sent {
        Sent::Held(held) => Err(review::held_refusal(&held)),
        Sent::Posted(view) => Ok(view.sent()),
    }
}

fn text<'v>(v: &'v service_kit::schema::Value, key: &str) -> &'v str {
    v.get(key).as_str().unwrap_or_default()
}

/// The answer of one of this part's calls, by its path; `None` for a path outside it.
pub fn answer(d: &Deps<'_>, ctx: &crate::door::Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let user = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    let input = &ctx.input;
    Some(match ctx.call.path {
        "transfers.get" => get(d, user, text(input, "ledgerTxId")).map(|v| v.receipt()),
        "transfers.held" => held_send(d, user, text(input, "transferId")).map(|v| v.json()),
        "transfers.quote" => (|| {
            let asset = text(input, "assetId");
            let amount = parse_amount(text(input, "amount")).map_err(Refusal::Other)?;
            let q = with(d.store, |c| {
                super::terms::quote(c, user, asset, amount, d.now)
            })?;
            // The network fee: what the partner holding the sender's money says a send costs (null when it gives
            // none), "0" on our own book, which crosses no network; null whenever the partner's fee is not known.
            let network_fee = match d.custody.bank_for(user) {
                Some(p) => p
                    .limits(user, asset, d.now)?
                    .send_fee
                    .map_or(Json::Null, |f| Json::str(format_amount(f))),
                None => Json::str("0"),
            };
            Ok(q.json(Some(if partner_fee_known(d, user) {
                network_fee
            } else {
                Json::Null
            })))
        })(),
        "transfers.toUser" => to_user(d, ctx),
        "transfers.settleWithdrawal" => (|| {
            settle_withdrawal(
                d,
                &Withdrawal {
                    transfer_id: text(input, "transferId"),
                    from_user_id: text(input, "fromUserId"),
                    to_user_id: text(input, "toUserId"),
                    asset_id: text(input, "assetId"),
                    amount: parse_amount(text(input, "amount")).map_err(Refusal::Other)?,
                },
            )
        })(),
        _ => return None,
    })
}
