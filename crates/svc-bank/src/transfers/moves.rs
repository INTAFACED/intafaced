//! One move of value between two spaces (`transfers/transfer-service.ts` `transfer`, `moveBetweenSpaces`,
//! `transferToUser`), with what it asks first: the space checks of a debit and a credit (`spaces/space-service.ts`
//! `resolveForDebit`, `resolveForCredit`, `primaryForCredit`, `assertCanReceive`, `assertCanSend`), the note and reference
//! bound to the transfer id (`transfers/transfer-message.ts`), and the receipt checked against the movement asked for
//! (`transfers/booked-transfer.ts`). The router's half: the destination gate (`router/shared.ts` `gateDestination`,
//! `hideDestinationDetail`) and the caller's own figures on a refusal for too little money (`insufficient-funds.ts`).
//!
//! The money posts through svc-ledger's `bankTransfer` recipe (`post_recipe`), or, when the partner bank holds both
//! people's money, as ONE partner move under the same business key. If this crashes after the post and before the
//! answer, nobody's funds are stranded: the movement is booked under its key and a retry with the same id is answered
//! with it.

use postgres::GenericClient;
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::Instant;
use service_kit::trpc::{SpendFigures, TrpcError};

use super::Deps;
use super::ports::RecipientStatus;
use crate::errors::Refusal;
use crate::partner::{Move, MoveRequest, refuse};
use crate::spaces::ports::{LedgerAccount, LedgerTx, PostFailure};
use crate::spaces::space::{self, Space, archived, in_tx, lock_end, pg, with};

/// `RECIPIENT_CANNOT_RECEIVE_MESSAGE`: one sentence for an unknown, frozen and closed recipient.
pub const RECIPIENT_CANNOT_RECEIVE_MESSAGE: &str = "This recipient cannot receive payments";

/// `bankTransferKey(space, transferId, occurrence)`: `bank.transfer.<space>:<id>:<occurrence>`.
pub fn bank_transfer_key(key_space: &str, transfer_id: &str, occurrence: i64) -> String {
    format!("bank.transfer.{key_space}:{transfer_id}:{occurrence}")
}

/// `KEY_SPACE_KIND`: the transfer kind each key space goes with.
fn kind_of(key_space: &str) -> &'static str {
    if key_space == "sched" {
        "scheduled"
    } else {
        "manual"
    }
}

/// `assertCanReceive`: identity says the person may receive, else one code and one sentence for unknown, frozen and
/// closed; identity down or unwired keeps its own retryable or operator code.
pub fn assert_can_receive(d: &Deps<'_>, user_id: &str) -> Result<(), Refusal> {
    match d.w.recipients.status_of(user_id) {
        Ok(RecipientStatus::Active) => Ok(()),
        Ok(_) => Err(refuse(
            "bank.recipient_cannot_receive",
            RECIPIENT_CANNOT_RECEIVE_MESSAGE,
        )),
        Err(e) if e.unset => Err(refuse("bank.recipient_check_unset", e.message)),
        Err(_) => Err(refuse(
            "bank.recipient_check_unavailable",
            "Could not check whether the recipient can receive payments; nothing was sent. Retry with the same id.",
        )),
    }
}

/// `assertCanSend`: the same read for the sending side, refused as `bank.sender_cannot_send`.
pub fn assert_can_send(d: &Deps<'_>, user_id: &str) -> Result<(), Refusal> {
    match assert_can_receive(d, user_id) {
        Err(Refusal::Bank(e)) if e.row.code == "bank.recipient_cannot_receive" => Err(refuse(
            "bank.sender_cannot_send",
            "The sending account cannot send money right now; nothing was sent.",
        )),
        other => other,
    }
}

/// `resolveForDebit`: a space a money path takes value out of, refusing an archived or locked one.
pub fn resolve_for_debit(
    c: &mut impl GenericClient,
    space_id: &str,
    now: Instant,
) -> Result<Space, Refusal> {
    let s = space::get(c, space_id)?;
    if s.archived_at.is_some() {
        return Err(archived(&s.name));
    }
    if let Some(until) = lock_end(s.locked_until, s.unlocks_at, now) {
        return Err(refuse(
            "bank.space_locked",
            format!("Space \"{}\" is locked until {}", s.name, until.iso()),
        ));
    }
    Ok(s)
}

/// `resolveForCredit`: a space a money path credits, refusing an archived one and a recipient who cannot receive.
/// Crediting the acting person's own space asks identity nothing. `already_booked` answers a retry whose instruction
/// already posted while the recipient could receive: it is answered with the original, never refused.
pub fn resolve_for_credit(
    d: &Deps<'_>,
    c: &mut impl GenericClient,
    space_id: &str,
    acting_user: Option<&str>,
    already_booked: Option<&dyn Fn() -> Result<bool, Refusal>>,
) -> Result<Space, Refusal> {
    let s = space::get(c, space_id)?;
    if s.archived_at.is_some() {
        return Err(archived(&s.name));
    }
    if Some(s.user_id.as_str()) == acting_user {
        return Ok(s);
    }
    match assert_can_receive(d, &s.user_id) {
        Ok(()) => Ok(s),
        Err(Refusal::Bank(e)) if e.row.code.starts_with("bank.recipient_") => {
            if let Some(booked) = already_booked
                && booked()?
            {
                return Ok(s);
            }
            Err(Refusal::Bank(e))
        }
        Err(e) => Err(e),
    }
}

/// `findPrimary`: the person's live main space in an asset, or none. Invents nothing.
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
                "SELECT {} FROM bank.spaces WHERE user_id = $1 AND asset_id = $2 AND kind = 'primary' AND archived_at IS NULL",
                space::COLS
            ),
            &[&id, &asset_id],
        )
        .map_err(|e| pg(&e))?;
    rows.first().map(Space::from_row).transpose()
}

/// `primaryForCredit`: the main space of a person being paid by id; made here, after identity says they may receive.
pub fn primary_for_credit(
    d: &Deps<'_>,
    user_id: &str,
    asset_id: &str,
) -> Result<Option<Space>, Refusal> {
    let id = user_id.trim();
    if id.is_empty() {
        return Ok(None);
    }
    if let Some(known) = with(d.store, |c| find_primary(c, id, asset_id))? {
        return Ok(Some(known));
    }
    assert_can_receive(d, id)?;
    with(d.store, |c| space::ensure_primary(c, id, asset_id)).map(Some)
}

/// `TransferMessageInput`.
pub struct Message<'a> {
    pub transfer_id: &'a str,
    pub key_space: &'a str,
    pub from_user_id: &'a str,
    pub to_user_id: &'a str,
    pub note: Option<&'a str>,
    pub reference: Option<&'a str>,
}

fn message_conflict(text: &str) -> Refusal {
    refuse("bank.transfer_message_conflict", text)
}

const RETRY_DIFFERENT: &str = "A retry of this transfer used a different note or reference";

/// `bindTransferMessage`: the note and reference bind to the transfer id before anything moves. A retry with other
/// words, or words added to a transfer that already completed without them, refuses `bank.transfer_message_conflict`.
/// `booked` says whether the transfer's key is already booked.
pub fn bind_message(
    d: &Deps<'_>,
    m: &Message<'_>,
    booked: &dyn Fn(&str) -> Result<bool, Refusal>,
) -> Result<(), Refusal> {
    if m.note.is_none() && m.reference.is_none() {
        return Ok(());
    }
    let same = |note: Option<String>, reference: Option<String>| {
        note.as_deref() == m.note && reference.as_deref() == m.reference
    };
    let key = bank_transfer_key(m.key_space, m.transfer_id, 0);
    let written = in_tx(d.store, |tx| {
        let rows = tx
            .query(
                "SELECT note, reference FROM bank.transfer_messages WHERE transfer_id = $1 FOR UPDATE",
                &[&m.transfer_id],
            )
            .map_err(|e| pg(&e))?;
        if let Some(r) = rows.first() {
            if !same(r.get(0), r.get(1)) {
                return Err(message_conflict(RETRY_DIFFERENT));
            }
            return Ok(());
        }
        if booked(&key)? {
            return Err(message_conflict(
                "This transfer already completed without this note or reference",
            ));
        }
        tx.execute(
            "INSERT INTO bank.transfer_messages (transfer_id, from_user_id, to_user_id, note, reference) \
             VALUES ($1, $2::text::uuid, $3::text::uuid, $4, $5)",
            &[
                &m.transfer_id,
                &m.from_user_id,
                &m.to_user_id,
                &m.note,
                &m.reference,
            ],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    });
    match written {
        // A racing first write of the same id: the row it wrote decides.
        Err(Refusal::Other(e)) if e.contains("23505") || e.contains("duplicate key") => {
            let rows = with(d.store, |c| {
                c.query(
                    "SELECT note, reference FROM bank.transfer_messages WHERE transfer_id = $1",
                    &[&m.transfer_id],
                )
                .map_err(|e| pg(&e))
            })?;
            match rows.first() {
                Some(r) if same(r.get(0), r.get(1)) => Ok(()),
                _ => Err(message_conflict(RETRY_DIFFERENT)),
            }
        }
        other => other,
    }
}

/// `attachTransferMessageTx`: the transaction the words show on, once it is known.
pub fn attach_message_tx(d: &Deps<'_>, transfer_id: &str, tx_id: &str) -> Result<(), Refusal> {
    with(d.store, |c| {
        c.execute(
            "UPDATE bank.transfer_messages SET ledger_tx_id = $2 WHERE transfer_id = $1 AND ledger_tx_id IS NULL",
            &[&transfer_id, &tx_id],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })
}

/// `bookedTransferMatches`: the receipt is this movement, two legs, `amount` out of `from` and into `to`.
pub fn booked_matches(
    d: &Deps<'_>,
    receipt: &LedgerTx,
    from: &LedgerAccount,
    to: &LedgerAccount,
    amount: Amount,
) -> Result<bool, Refusal> {
    let fetched;
    let tx = if receipt.entries.is_empty() {
        match d.ledger.tx_by_id(&receipt.id).map_err(Refusal::Other)? {
            Some(t) => {
                fetched = t;
                &fetched
            }
            None => return Ok(false),
        }
    } else {
        receipt
    };
    if tx.entries.len() != 2 {
        return Ok(false);
    }
    let from_id = d.ledger.account_id(from).map_err(Refusal::Other)?;
    let to_id = d.ledger.account_id(to).map_err(Refusal::Other)?;
    if from_id.is_empty() || to_id.is_empty() {
        return Ok(false);
    }
    let leg = |dir: &str, id: &str, asset: &str| {
        tx.entries.iter().any(|e| {
            e.direction == dir && e.account_id == id && e.asset_id == asset && e.amount == amount
        })
    };
    Ok(leg("credit", &from_id, &from.asset_id) && leg("debit", &to_id, &to.asset_id))
}

/// `BookedTransferConflict`.
pub fn booked_conflict(transfer_id: &str) -> Refusal {
    refuse(
        "bank.personal_transfer_conflict",
        format!(
            "Transfer {transfer_id} is already booked as a different movement (bank.personal_transfer_conflict)"
        ),
    )
}

/// `partnerCustodyMismatch`.
pub fn custody_mismatch() -> Refusal {
    refuse(
        "bank.partner_custody_mismatch",
        "One side of this move is held at the partner bank and the other is not, so it cannot be made as one partner move. Nothing was sent or changed.",
    )
}

/// `partnerPathNotBuilt`.
pub fn partner_path_not_built() -> Refusal {
    refuse(
        "bank.partner_path_not_built",
        "This payment is not yet made through the partner bank that holds this money, so it was not sent. Nothing was sent or changed.",
    )
}

/// The ledger's refusal for too little money, as the guard answers an `InsufficientFundsError`: a 400 with the ledger's
/// words, its code as the cause.
pub const LEDGER_INSUFFICIENT: &str = "ledger.insufficient_funds";

/// A failed post as the TypeScript client throws it: too little money is the ledger's own typed refusal; any other is a
/// `LedgerError`, which the guard answers as an opaque failure.
pub fn post_refusal(f: &PostFailure) -> Refusal {
    if f.insufficient() {
        return Refusal::Trpc(TrpcError::caused(
            "BAD_REQUEST",
            f.message().to_owned(),
            LEDGER_INSUFFICIENT,
        ));
    }
    Refusal::Other(format!("svc-ledger post failed: {}", f.message()))
}

/// Whether a refusal is the ledger's too-little-money one (`isLedgerInsufficientFunds`).
pub fn is_ledger_insufficient(r: &Refusal) -> bool {
    matches!(r, Refusal::Trpc(e) if e.cause.as_deref() == Some(LEDGER_INSUFFICIENT))
}

/// `recipes.bankTransfer` on svc-ledger's recipe door: `amount` out of `from` and into `to` under
/// `bank.transfer.<keySpace>:<transferId>:<occurrence>`.
pub fn post_bank_transfer(
    d: &Deps<'_>,
    transfer_id: &str,
    occurrence: i64,
    from: &LedgerAccount,
    to: &LedgerAccount,
    amount: Amount,
    key_space: &str,
) -> Result<LedgerTx, PostFailure> {
    let input = Json::obj([
        ("transferId", Json::str(transfer_id)),
        ("occurrence", Json::int(occurrence)),
        ("from", from.json()),
        ("to", to.json()),
        ("amount", Json::str(format_amount(amount))),
        ("kind", Json::str(kind_of(key_space))),
        ("keySpace", Json::str(key_space)),
    ]);
    d.ledger.post_recipe(
        "bankTransfer",
        &input,
        &bank_transfer_key(key_space, transfer_id, occurrence),
    )
}

/// What a move asks for.
pub struct MoveAsk<'a> {
    pub transfer_id: &'a str,
    pub from_space_id: &'a str,
    pub to_space_id: &'a str,
    pub amount: Amount,
    pub note: Option<&'a str>,
    pub reference: Option<&'a str>,
    /// `own` (the default) or `p2p`: the two never share a key.
    pub key_space: &'a str,
}

/// How the move was made: on the ledger, or by the partner bank that holds the money.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(
    clippy::large_enum_variant,
    reason = "one per move, never held in bulk"
)]
pub enum Made {
    Ledger(String),
    Partner(Move),
}

/// `TransferResult` / `PartnerTransferResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Moved {
    pub transfer_id: String,
    pub occurrence: i64,
    pub made: Made,
    pub amount: Amount,
}

impl Moved {
    pub fn ledger_tx_id(&self) -> Option<&str> {
        match &self.made {
            Made::Ledger(id) => Some(id),
            Made::Partner(_) => None,
        }
    }
}

/// `transfer`: a move whose caller records the ledger transaction, so a partner-held side refuses by name.
pub fn transfer(d: &Deps<'_>, ask: &MoveAsk<'_>) -> Result<Moved, Refusal> {
    move_between(d, ask, false)
}

/// A move that failed: the refusal, and svc-ledger's own failure when the post itself failed, so a caller can tell a
/// refusal that proves nothing was booked from one that may yet land (`provesPostNotCommitted`).
#[derive(Debug)]
pub struct Failed {
    pub refusal: Refusal,
    pub post: Option<PostFailure>,
}

impl From<Refusal> for Box<Failed> {
    fn from(refusal: Refusal) -> Box<Failed> {
        Box::new(Failed {
            refusal,
            post: None,
        })
    }
}

/// `moveBetweenSpaces` (`partner_allowed`) and `move`.
pub fn move_between(
    d: &Deps<'_>,
    ask: &MoveAsk<'_>,
    partner_allowed: bool,
) -> Result<Moved, Refusal> {
    move_between_outcome(d, ask, partner_allowed).map_err(|f| f.refusal)
}

/// [`move_between`], keeping svc-ledger's failure when the post failed.
pub fn move_between_outcome(
    d: &Deps<'_>,
    ask: &MoveAsk<'_>,
    partner_allowed: bool,
) -> Result<Moved, Box<Failed>> {
    let now = d.now;
    if ask.from_space_id == ask.to_space_id {
        return Err(refuse("bank.same_space", "A transfer needs two different spaces").into());
    }
    let from = with(d.store, |c| resolve_for_debit(c, ask.from_space_id, now))?;
    let key = bank_transfer_key(ask.key_space, ask.transfer_id, 0);
    let partner = d.custody.bank_for(&from.user_id);
    let already = || -> Result<bool, Refusal> {
        Ok(match &partner {
            Some(p) => p.move_by_key(&key).is_some(),
            None => d.ledger.tx_by_key(&key).map_err(Refusal::Other)?.is_some(),
        })
    };
    let to = with(d.store, |c| {
        resolve_for_credit(d, c, ask.to_space_id, Some(&from.user_id), Some(&already))
    })?;
    if from.asset_id != to.asset_id {
        return Err(refuse(
            "bank.asset_mismatch",
            format!(
                "Cannot transfer {} into a {} space — convert first",
                from.asset_id, to.asset_id
            ),
        )
        .into());
    }
    let to_partner = d.custody.bank_for(&to.user_id);
    if partner.is_some() || to_partner.is_some() {
        let (Some(p), Some(_)) = (&partner, &to_partner) else {
            return Err(custody_mismatch().into());
        };
        if !partner_allowed {
            return Err(partner_path_not_built().into());
        }
        bind_message(
            d,
            &Message {
                transfer_id: ask.transfer_id,
                key_space: ask.key_space,
                from_user_id: &from.user_id,
                to_user_id: &to.user_id,
                note: ask.note,
                reference: ask.reference,
            },
            &|k| Ok(p.move_by_key(k).is_some()),
        )?;
        let moved = p.move_(
            &MoveRequest {
                key: key.clone(),
                from: from.partner_account(),
                to: to.partner_account(),
                amount: ask.amount,
                payees: None,
            },
            now,
        )?;
        if ask.note.is_some() || ask.reference.is_some() {
            attach_message_tx(d, ask.transfer_id, &moved.id)?;
        }
        return Ok(Moved {
            transfer_id: ask.transfer_id.to_owned(),
            occurrence: 0,
            amount: moved.amount,
            made: Made::Partner(moved),
        });
    }
    bind_message(
        d,
        &Message {
            transfer_id: ask.transfer_id,
            key_space: ask.key_space,
            from_user_id: &from.user_id,
            to_user_id: &to.user_id,
            note: ask.note,
            reference: ask.reference,
        },
        &|k| Ok(d.ledger.tx_by_key(k).map_err(Refusal::Other)?.is_some()),
    )?;
    let from_account = from.ledger_account();
    let to_account = to.ledger_account();
    let tx = post_bank_transfer(
        d,
        ask.transfer_id,
        0,
        &from_account,
        &to_account,
        ask.amount,
        ask.key_space,
    )
    .map_err(|f| {
        Box::new(Failed {
            refusal: post_refusal(&f),
            post: Some(f),
        })
    })?;
    // A ledger answering a reused key with the ORIGINAL transaction: never report this one booked unless it is this move.
    if !booked_matches(d, &tx, &from_account, &to_account, ask.amount)? {
        return Err(booked_conflict(ask.transfer_id).into());
    }
    if ask.note.is_some() || ask.reference.is_some() {
        attach_message_tx(d, ask.transfer_id, &tx.id)?;
    }
    Ok(Moved {
        transfer_id: ask.transfer_id.to_owned(),
        occurrence: 0,
        made: Made::Ledger(tx.id),
        amount: ask.amount,
    })
}

/// `transferToUser`: a send to another person's main space under the `p2p` key, on the ledger or as one partner move.
pub fn transfer_to_user(
    d: &Deps<'_>,
    transfer_id: &str,
    from_space_id: &str,
    to_user_id: &str,
    amount: Amount,
) -> Result<Moved, Refusal> {
    transfer_to_user_outcome(d, transfer_id, from_space_id, to_user_id, amount)
        .map_err(|f| f.refusal)
}

/// [`transfer_to_user`], keeping svc-ledger's failure when the post failed.
pub fn transfer_to_user_outcome(
    d: &Deps<'_>,
    transfer_id: &str,
    from_space_id: &str,
    to_user_id: &str,
    amount: Amount,
) -> Result<Moved, Box<Failed>> {
    let dest_user = to_user_id.trim();
    let from = with(d.store, |c| resolve_for_debit(c, from_space_id, d.now))?;
    let dest = if dest_user.is_empty() {
        None
    } else {
        primary_for_credit(d, dest_user, &from.asset_id)?
    };
    let Some(dest) = dest else {
        return Err(refuse(
            "bank.recipient_cannot_receive",
            RECIPIENT_CANNOT_RECEIVE_MESSAGE,
        )
        .into());
    };
    move_between_outcome(
        d,
        &MoveAsk {
            transfer_id,
            from_space_id,
            to_space_id: &dest.id,
            amount,
            note: None,
            reference: None,
            key_space: "p2p",
        },
        true,
    )
}

/// `NO_SUCH_DESTINATION`, from its one construction site.
pub fn no_such_destination() -> Refusal {
    Refusal::Trpc(TrpcError::plain("NOT_FOUND", "No such space"))
}

/// `gateDestination`: what the caller may be told about the destination. Their own space: everything (`true`). Anyone
/// else's: one answer for missing, archived and of another asset; a viewer of that shared pot adds nothing; else the
/// move proceeds and a later refusal is flattened by [`hide_destination_detail`] (`false`).
pub fn gate_destination(
    d: &Deps<'_>,
    caller: &str,
    from: &Space,
    to_space_id: &str,
) -> Result<bool, Refusal> {
    with(d.store, |c| {
        let to = space::find(c, to_space_id)?;
        match to {
            Some(t) if t.user_id == caller => Ok(true),
            None => Err(no_such_destination()),
            Some(t) if t.archived_at.is_some() || t.asset_id != from.asset_id => {
                Err(no_such_destination())
            }
            Some(t) => {
                crate::spaces::shared::assert_may_add_to(c, caller, &t.id)?;
                Ok(false)
            }
        }
    })
}

/// `hideDestinationDetail`: a refusal that could only be about someone else's space reads as no such space.
pub fn hide_destination_detail(r: Refusal) -> Refusal {
    match &r {
        Refusal::Bank(e)
            if matches!(
                e.row.code,
                "bank.space_not_found" | "bank.asset_mismatch" | "bank.recipient_cannot_receive"
            ) =>
        {
            no_such_destination()
        }
        _ => r,
    }
}

/// `SpendFiguresReader.read`: the person's available and held money in the asset, and their active earn principal (null
/// when that read fails). None when the balances cannot be read.
pub fn spend_figures(d: &Deps<'_>, user_id: &str, asset_id: &str) -> Option<SpendFigures> {
    let rows = d.ledger.balances("user", user_id).ok()?;
    let mut available: Amount = Amount::ZERO;
    let mut on_hold: Amount = Amount::ZERO;
    for r in rows.iter().filter(|r| r.asset_id == asset_id) {
        match r.kind.as_str() {
            "available" => available += r.amount,
            "hold" => on_hold += r.amount,
            _ => {}
        }
    }
    let in_earn = with(d.store, |c| {
        let rows = c
            .query(
                "SELECT principal::text FROM bank.earn_positions WHERE user_id = $1 AND asset_id = $2 AND status = 'active'",
                &[&user_id, &asset_id],
            )
            .map_err(|e| pg(&e))?;
        let mut total: Amount = Amount::ZERO;
        for r in &rows {
            total += parse_amount(&r.get::<_, String>(0)).map_err(Refusal::Other)?;
        }
        Ok(format_amount(total))
    })
    .ok();
    Some(SpendFigures {
        asset_id: asset_id.to_owned(),
        available: format_amount(available),
        on_hold: format_amount(on_hold),
        in_earn,
    })
}

/// `SpendFiguresReader.refusal`: the ledger's refusal for too little money becomes `bank.insufficient_funds` with the
/// caller's own figures; any other refusal passes unchanged.
pub fn spend_refusal(d: &Deps<'_>, r: Refusal, user_id: &str, asset_id: &str) -> Refusal {
    if !is_ledger_insufficient(&r) {
        return r;
    }
    let mut e = crate::errors::to_trpc(
        refuse(
            "bank.insufficient_funds",
            format!("Insufficient {asset_id}."),
        ),
        String::new,
    );
    e.spend = spend_figures(d, user_id, asset_id).map(Box::new);
    Refusal::Trpc(e)
}
