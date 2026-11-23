//! Part `own_moves` of the automations slice: moves between a person's own spending money at the partner bank and their
//! own trading account at the venue (`own-moves/`, J-derivatives-25 #2 #3). INTAFACED holds neither; the ledger posts
//! nothing. A move in is two legs, each sent once under its own key:
//!
//! 1. The partner's transfer out of the person's main balance to their own wallet, on chain: svc-bank asks the partner
//!    to move it from the main balance to its own chain-out account (`bank.transfer.own-move:<moveId>:1`) and to send
//!    that amount to the wallet (the same key): the partner deduplicates both, so a retry after a crash anywhere sends
//!    nothing more.
//! 2. The wallet's own signed deposit to the venue: only the wallet sends it; svc-bank records its hash once
//!    (`recordDeposit`). The leg reads confirmed only when a chain read ([`delivery::DepositReader`]) finds that
//!    transfer; with no reader wired (today) it stays claimed.
//!
//! Before anything is kept or sent: the step-up (always required, `ownMoveStepUp`), the amount above zero, the wallet's
//! signature over this move's own words ([`wallet`]), the owner's destination sanctions list ([`sanctions`]), the
//! partner holding the person's money, the partner's send being wired, the security lock, and the amount at most what
//! the partner reports free. If this crashes after the row is kept and before the partner moved, the move reads
//! `opening` and asking again sends it under the same key; nothing is stranded: the partner moved it once or not at all.

pub mod delivery;
pub mod sanctions;
pub mod wallet;

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::schema::Value;
use service_kit::time::Instant;

use super::Deps;
use crate::door::Ctx;
use crate::errors::Refusal;
use crate::partner::custody::Held;
use crate::partner::{AccountRef, MoveRequest, refuse};
use crate::spaces::space::{pg, with};
use crate::transfers::ports::assert_security_lock_open;
use crate::transfers::step_up::{Binding, Gate, Request, SqlUses};
use delivery::{Delivery, DepositReader};

/// What the binary hands this part.
#[derive(Default)]
pub struct Wiring {
    /// The pay-in partner's send to a wallet. Unset: every move in refuses `bank.own_move_rail_unset`.
    pub deliver: Option<Box<dyn Delivery>>,
    /// `BANK_DESTINATION_SANCTIONS`, read at each check. Blank refuses every wallet.
    pub sanctions: Option<String>,
    /// The chain read that confirms a deposit leg. Unset: every recorded deposit stays claimed.
    pub deposits: Option<Box<dyn DepositReader>>,
}

impl Wiring {
    pub fn none() -> Wiring {
        Wiring::default()
    }
}

/// The step-up's action for a move to the wallet.
pub const STEP_UP_ACTION: &str = "bank.step_up.ownMoves.toWallet";
/// The partner's own account a move to a wallet leaves the main balance into (`PARTNER_CHAIN_OUT_OWNER`).
pub const PARTNER_CHAIN_OUT_OWNER: &str = "partner:chain-out";

/// `partnerChainOutAccount`.
pub fn partner_chain_out_account(asset_id: &str) -> AccountRef {
    AccountRef {
        user_id: PARTNER_CHAIN_OUT_OWNER.to_owned(),
        asset_id: asset_id.to_owned(),
        space_id: None,
    }
}

/// `ownMoveKey`: the business key both of the partner's instructions for one move go under.
pub fn own_move_key(move_id: &str) -> String {
    format!("bank.transfer.own-move:{}:1", move_id.to_lowercase())
}

/// One row of `bank.own_moves`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub id: String,
    pub user_id: String,
    pub direction: String,
    pub asset_id: String,
    pub amount: Amount,
    pub wallet: String,
    pub status: String,
    pub partner_ref: Option<String>,
    pub delivery_tx: Option<String>,
    pub deposit_tx: Option<String>,
    pub created_at: Instant,
    pub sent_at: Option<Instant>,
    pub deposit_at: Option<Instant>,
}

fn ms(col: &str) -> String {
    format!("floor(extract(epoch from {col}) * 1000)::int8")
}

fn cols() -> String {
    format!(
        "id::text, user_id, direction, asset_id, amount::text, wallet, status, partner_ref, delivery_tx, deposit_tx, {}, {}, {}",
        ms("created_at"),
        ms("sent_at"),
        ms("deposit_at")
    )
}

fn row_of(r: &postgres::Row) -> Result<Row, Refusal> {
    let text = |i: usize| -> Result<String, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
    let opt = |i: usize| -> Result<Option<String>, Refusal> { r.try_get(i).map_err(|e| pg(&e)) };
    let at = |i: usize| -> Result<Option<Instant>, Refusal> {
        Ok(r.try_get::<_, Option<i64>>(i)
            .map_err(|e| pg(&e))?
            .map(Instant))
    };
    Ok(Row {
        id: text(0)?,
        user_id: text(1)?,
        direction: text(2)?,
        asset_id: text(3)?,
        amount: parse_amount(&text(4)?).map_err(Refusal::Other)?,
        wallet: text(5)?,
        status: text(6)?,
        partner_ref: opt(7)?,
        delivery_tx: opt(8)?,
        deposit_tx: opt(9)?,
        created_at: at(10)?.ok_or_else(|| Refusal::Other("created_at is null".to_owned()))?,
        sent_at: at(11)?,
        deposit_at: at(12)?,
    })
}

/// `row`: one move by its id, or none.
fn row(d: &Deps<'_>, move_id: &str) -> Result<Option<Row>, Refusal> {
    with(d.store(), |c| {
        c.query(
            &format!(
                "SELECT {} FROM bank.own_moves WHERE id = $1::text::uuid",
                cols()
            ),
            &[&move_id],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(row_of)
        .transpose()
    })
}

/// `kept`: a row this move just wrote or found; gone is refused, never guessed at.
fn kept(d: &Deps<'_>, move_id: &str) -> Result<Row, Refusal> {
    row(d, move_id)?.ok_or_else(|| {
        refuse(
            "bank.own_move_not_found",
            "This move’s record could not be read back. Ask again to see it.",
        )
    })
}

/// `^0x[0-9a-f]{64}$`.
fn tx_shape(s: &str) -> bool {
    s.len() == 66
        && s.starts_with("0x")
        && s.bytes()
            .skip(2)
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn iso_or_null(t: Option<Instant>) -> Json {
    t.map_or(Json::Null, |t| Json::str(t.iso()))
}

fn opt_str(s: Option<&String>) -> Json {
    s.map_or(Json::Null, |s| Json::str(s.clone()))
}

/// `view` through `moveOut`: the move as `ownMoveViewSchema` reads it. `partner` is the partner's label, or none.
fn view(d: &Deps<'_>, r: &Row, user_id: &str, partner: Option<&str>) -> Json {
    let confirmed = match (d.w.own_moves.deposits.as_ref(), r.deposit_tx.as_ref()) {
        (Some(reader), Some(tx)) => reader.confirmed(tx, &r.wallet, &r.asset_id, r.amount),
        _ => false,
    };
    Json::obj([
        ("id", Json::str(r.id.clone())),
        ("direction", Json::str(r.direction.clone())),
        ("assetId", Json::str(r.asset_id.clone())),
        ("amount", Json::str(format_amount(r.amount))),
        ("wallet", Json::str(r.wallet.clone())),
        ("status", Json::str(r.status.clone())),
        ("partner", Json::str(partner.unwrap_or("not known"))),
        ("partnerRef", opt_str(r.partner_ref.as_ref())),
        ("partnerFee", super::pay_yourself::partner_fee(d, user_id)),
        ("deliveryTx", opt_str(r.delivery_tx.as_ref())),
        ("depositTx", opt_str(r.deposit_tx.as_ref())),
        ("depositConfirmed", Json::Bool(confirmed)),
        ("createdAt", Json::str(r.created_at.iso())),
        ("sentAt", iso_or_null(r.sent_at)),
        ("depositAt", iso_or_null(r.deposit_at)),
    ])
}

/// `partnerBank`: the guarded partner holding this person's money, or `bank.partner_unset`.
fn partner_bank<'a>(d: &'a Deps<'a>, user_id: &str) -> Result<Held<'a>, Refusal> {
    d.t.custody.bank_for(user_id).ok_or_else(|| {
        refuse(
            "bank.partner_unset",
            "This person’s bank money is not held at the partner bank, so nothing can move from it. Nothing was sent.",
        )
    })
}

fn conflict() -> Refusal {
    refuse(
        "bank.own_move_conflict",
        "This move was already asked with other terms. Nothing was sent.",
    )
}

/// What `ownMoves.toWallet` is given.
pub struct ToWallet<'a> {
    pub move_id: &'a str,
    pub asset_id: &'a str,
    pub amount: &'a str,
    pub wallet: &'a str,
    pub wallet_signature: &'a str,
}

/// `toWallet`: move from spending into trading, the partner's send to the person's own wallet under the move's own key.
pub fn to_wallet(d: &Deps<'_>, user_id: &str, input: &ToWallet<'_>) -> Result<Json, Refusal> {
    let amount = parse_amount(input.amount).map_err(Refusal::Other)?;
    if amount <= Amount::ZERO {
        return Err(refuse(
            "bank.validation_failed",
            "The amount to move must be above zero. Nothing was sent.",
        ));
    }
    let move_id = input.move_id.to_lowercase();
    let wallet = service_kit::money::js_trim(input.wallet).to_lowercase();
    let asset_id = input.asset_id;
    if !super::pay_yourself::realised::lower_address(&wallet) {
        return Err(refuse(
            "bank.validation_failed",
            "The wallet must be an EVM address. Nothing was sent.",
        ));
    }
    let message = wallet::own_move_message(&move_id, &wallet, asset_id, &format_amount(amount));
    if wallet::recover_personal_sign_address(&message, input.wallet_signature).as_deref()
        != Some(wallet.as_str())
    {
        return Err(refuse(
            "bank.wallet_delivery_unproven",
            "The wallet to send to must sign this move to prove it is yours. Nothing was sent or kept.",
        ));
    }
    sanctions::screen_wallet(d.w.own_moves.sanctions.as_deref(), &wallet)?;
    let bank = partner_bank(d, user_id)?;
    let Some(deliver) = d.w.own_moves.deliver.as_ref() else {
        return Err(refuse(
            "bank.own_move_rail_unset",
            "Your partner bank has no way to send to a wallet connected here, so nothing can move to your trading account. Nothing was sent.",
        ));
    };
    // A frozen or locked account sends nothing out, a move asked again included: read before anything is kept or moved.
    assert_security_lock_open(d.t.w.lock.as_ref(), user_id, "a move to your wallet")?;
    let same = |r: &Row| {
        r.user_id == user_id && r.asset_id == asset_id && r.amount == amount && r.wallet == wallet
    };
    let label = Some(bank.label());
    match row(d, &move_id)? {
        Some(prior) => {
            if !same(&prior) {
                return Err(conflict());
            }
            if prior.status == "sent" {
                return Ok(view(d, &prior, user_id, label));
            }
        }
        None => {
            // The partner's free figure first: above it, nothing is kept and nothing is sent.
            let free = bank.balance(&AccountRef::main(user_id, asset_id), d.now());
            if free.amount.is_none_or(|f| f < amount) {
                let said = free.amount.map_or_else(
                    || "does not report a figure for".to_owned(),
                    |f| format!("reports {} {asset_id} free in", format_amount(f)),
                );
                return Err(refuse(
                    "bank.own_move_above_free",
                    format!(
                        "{} {said} your account, so {} {asset_id} cannot move. Nothing was sent.",
                        free.label,
                        format_amount(amount)
                    ),
                ));
            }
            with(d.store(), |c| {
                c.execute(
                    "INSERT INTO bank.own_moves (id, user_id, direction, asset_id, amount, wallet, status) \
                     VALUES ($1::text::uuid, $2, 'in', $3, $4::text::numeric, $5, 'opening') ON CONFLICT (id) DO NOTHING",
                    &[&move_id, &user_id, &asset_id, &format_amount(amount), &wallet],
                )
                .map_err(|e| pg(&e))
            })?;
            let now_kept = row(d, &move_id)?;
            let Some(now_kept) = now_kept.filter(|r| same(r)) else {
                return Err(conflict());
            };
            if now_kept.status == "sent" {
                return Ok(view(d, &now_kept, user_id, label));
            }
        }
    }
    let key = own_move_key(&move_id);
    let moved = bank
        .move_(
            &MoveRequest {
                key: key.clone(),
                from: AccountRef::main(user_id, asset_id),
                to: partner_chain_out_account(asset_id),
                amount,
                payees: None,
            },
            d.now(),
        )
        .map_err(|e| match e {
            Refusal::Bank(b) if b.row.code == "bank.partner_insufficient_funds" => refuse(
                "bank.own_move_above_free",
                format!(
                    "{} Nothing was sent.",
                    b.message
                        .strip_suffix(" Nothing was moved.")
                        .unwrap_or(&b.message)
                ),
            ),
            other => other,
        })?;
    let tx = deliver
        .deliver(&key, &wallet, asset_id, &format_amount(amount))
        .map_err(Refusal::Other)?
        .to_lowercase();
    if !tx_shape(&tx) {
        return Err(refuse(
            "bank.partner_reply_lost",
            "The partner answered no transfer for this move. Ask again to finish it.",
        ));
    }
    let sent = with(d.store(), |c| {
        c.query(
            &format!(
                "UPDATE bank.own_moves SET status = 'sent', partner_ref = $2, delivery_tx = $3, sent_at = now() \
                 WHERE id = $1::text::uuid AND status = 'opening' RETURNING {}",
                cols()
            ),
            &[&move_id, &moved.id, &tx],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(row_of)
        .transpose()
    })?;
    let sent = match sent {
        Some(r) => r,
        None => kept(d, &move_id)?,
    };
    Ok(view(d, &sent, user_id, label))
}

fn deposit_conflict() -> Refusal {
    refuse(
        "bank.own_move_conflict",
        "This move’s deposit was already sent with another transaction. Nothing more was recorded.",
    )
}

/// `recordDeposit`: the wallet's own signed deposit to the venue for a sent move, recorded once; another transfer is a
/// conflict.
pub fn record_deposit(
    d: &Deps<'_>,
    user_id: &str,
    move_id: &str,
    deposit_tx: &str,
) -> Result<Json, Refusal> {
    let move_id = move_id.to_lowercase();
    let tx = service_kit::money::js_trim(deposit_tx).to_lowercase();
    if !tx_shape(&tx) {
        return Err(refuse(
            "bank.validation_failed",
            "A deposit is a transaction hash.",
        ));
    }
    let Some(r) = row(d, &move_id)?.filter(|r| r.user_id == user_id) else {
        return Err(refuse("bank.own_move_not_found", "No such move of yours."));
    };
    if r.status != "sent" {
        return Err(refuse(
            "bank.own_move_conflict",
            "The partner has not sent this move to your wallet yet, so there is nothing to deposit.",
        ));
    }
    if r.deposit_tx.as_deref() == Some(tx.as_str()) {
        let bank = partner_bank(d, user_id)?;
        return Ok(view(d, &r, user_id, Some(bank.label())));
    }
    if r.deposit_tx.is_some() {
        return Err(deposit_conflict());
    }
    let updated = with(d.store(), |c| {
        c.query(
            &format!(
                "UPDATE bank.own_moves SET deposit_tx = $2, deposit_at = now() \
                 WHERE id = $1::text::uuid AND deposit_tx IS NULL RETURNING {}",
                cols()
            ),
            &[&move_id, &tx],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(row_of)
        .transpose()
    })?;
    let now = match updated {
        Some(r) => r,
        None => kept(d, &move_id)?,
    };
    if now.deposit_tx.as_deref() != Some(tx.as_str()) {
        return Err(deposit_conflict());
    }
    let bank = partner_bank(d, user_id)?;
    Ok(view(d, &now, user_id, Some(bank.label())))
}

/// `get`: one of the person's moves, or null.
pub fn get(d: &Deps<'_>, user_id: &str, move_id: &str) -> Result<Json, Refusal> {
    let Some(r) = row(d, &move_id.to_lowercase())?.filter(|r| r.user_id == user_id) else {
        return Ok(Json::Null);
    };
    let bank = d.t.custody.bank_for(user_id);
    Ok(view(d, &r, user_id, bank.as_ref().map(Held::label)))
}

/// `list`: the person's moves, newest first.
pub fn list(d: &Deps<'_>, user_id: &str, limit: i64) -> Result<Json, Refusal> {
    let rows: Vec<Row> = with(d.store(), |c| {
        c.query(
            &format!(
                "SELECT {} FROM bank.own_moves WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2",
                cols()
            ),
            &[&user_id, &limit],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(row_of)
        .collect()
    })?;
    let bank = d.t.custody.bank_for(user_id);
    let label = bank.as_ref().map(Held::label);
    Ok(Json::Array(
        rows.iter().map(|r| view(d, r, user_id, label)).collect(),
    ))
}

fn text<'a>(input: &'a Value, key: &str) -> &'a str {
    input.get(key).as_str().unwrap_or_default()
}

/// The step-up `ownMoves.toWallet` always asks (`createStepUpGate({ mode: 'required' })` with svc-identity's consume and
/// `bank.step_up_uses`), bound to the move; a retry of the same move with the same approval replays.
fn require_step_up(d: &Deps<'_>, ctx: &Ctx<'_>, input: &Value) -> Result<(), Refusal> {
    let Some(p) = ctx.principal else {
        return Err(Refusal::Other("no principal".to_owned()));
    };
    let field = |k: &str| (k.to_owned(), text(input, k).to_owned());
    let binding = Binding {
        action_type: STEP_UP_ACTION,
        fields: vec![
            ("actor".to_owned(), p.user_id.clone()),
            field("moveId"),
            field("assetId"),
            field("amount"),
            field("wallet"),
        ],
        operation_key: text(input, "moveId").to_owned(),
    };
    Gate {
        required: true,
        approvals: d.t.w.approvals.as_ref(),
        store: &SqlUses(d.store()),
        now: d.now(),
    }
    .require(&Request {
        user_id: &p.user_id,
        session_id: &p.sid,
        binding: &binding,
        approval_id: input.get("stepUpApprovalId").as_str(),
        replay: true,
    })
}

/// This part's calls; `None` for any other call.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let user = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    let input = &ctx.input;
    Some(match ctx.call.path {
        "ownMoves.message" => Ok(Json::obj([(
            "message",
            Json::str(wallet::own_move_message(
                text(input, "moveId"),
                text(input, "wallet"),
                text(input, "assetId"),
                text(input, "amount"),
            )),
        )])),
        "ownMoves.toWallet" => require_step_up(d, ctx, input).and_then(|()| {
            to_wallet(
                d,
                user,
                &ToWallet {
                    move_id: text(input, "moveId"),
                    asset_id: text(input, "assetId"),
                    amount: text(input, "amount"),
                    wallet: text(input, "wallet"),
                    wallet_signature: text(input, "walletSignature"),
                },
            )
        }),
        "ownMoves.recordDeposit" => {
            record_deposit(d, user, text(input, "moveId"), text(input, "depositTx"))
        }
        "ownMoves.get" => get(d, user, text(input, "moveId")),
        "ownMoves.list" => {
            #[allow(
                clippy::cast_possible_truncation,
                reason = "the door's schema holds it to a whole number from 1 to 100"
            )]
            let limit = input.get("limit").as_number().unwrap_or(1.0) as i64;
            list(d, user, limit)
        }
        _ => return None,
    })
}
