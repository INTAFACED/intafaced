//! Sends to another person (`transfers/personal-pay.ts`'s send half, `transfers.toUser`, `get`, `held`, `quote`,
//! `settleWithdrawal`): a send is reserved in `bank.personal_transfers` under the caller's key, checked against the owner's
//! terms inside that reservation, then posted (svc-ledger's `bankTransfer` recipe, or the partner bank's one move when it
//! holds the money) and marked posted; its notice goes out on the bus and stays owed until the bus takes it.

use postgres::{GenericClient, Row};
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::Instant;

use super::Deps;
use super::notices::TransferPosted;
use super::requests;
use super::review::{self, HeldView, ReviewRow};
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{self, Space, at, pg, with};

/// `STALE_RESERVATION_MS`: a reservation older than this is settled or let go by the person's next send.
pub const STALE_RESERVATION_MS: i64 = 15 * 60 * 1000;
/// `NOTICE_RETRY_AFTER_MS`: a posted send's notice is retried by the recovery job only after this.
const NOTICE_RETRY_AFTER_MS: i64 = 30_000;
/// `POST_IN_FLIGHT_BOUND_SECONDS`.
pub const POST_IN_FLIGHT_BOUND_MS: i64 = 7 * 60 * 1000;

/// `bankTransferKey(space, transferId, occurrence)`.
pub fn transfer_key(space: &str, transfer_id: &str, occurrence: i64) -> String {
    format!("bank.transfer.{space}:{transfer_id}:{occurrence}")
}

/// A send's own key on the book: `bankTransferKey('p2p', transferId, 0)`.
pub fn send_key(transfer_id: &str) -> String {
    transfer_key("p2p", transfer_id, 0)
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

/// `findPrimary`: the person's open main space in the asset.
pub fn find_primary(
    c: &mut impl GenericClient,
    user_id: &str,
    asset_id: &str,
) -> Result<Option<Space>, Refusal> {
    let id = user_id.trim();
    if id.is_empty() {
        return Ok(None);
    }
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.spaces WHERE user_id = $1 AND asset_id = $2 AND kind = 'primary' \
                 AND archived_at IS NULL",
                space::COLS
            ),
            &[&id, &asset_id],
        )
        .map_err(|e| pg(&e))?;
    rows.first().map(Space::from_row).transpose()
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
    let Some(dest) = with(d.store, |c| find_primary(c, to_user_id, asset_id))? else {
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

/// The answer of one of this part's calls, by its path; `None` for a path outside it.
pub fn answer(_d: &Deps<'_>, _ctx: &crate::door::Ctx<'_>) -> Option<Result<Json, Refusal>> {
    None
}
