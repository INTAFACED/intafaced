//! `RailSendService` (`rail-sends/rail-sends.ts`): send from a space to someone's bank account over a bank rail
//! (BK-xfer-02, J-bank-04 #1).
//!
//! No banking partner carries any rail in this build, so every send is answered with `rail.bank` and kept as an intent
//! row, `refused` with that code: nothing is held or posted. The request id is the customer's business key for one ask:
//! the same id on the same terms is the same intent; on other terms, or from someone else, `bank.rail_send_conflict`.
//!
//! If this crashes exactly here, whose funds are stranded? No one's: nothing here posts to the ledger or the partner.
//! The only money read is the space's available balance, through the spaces slice (`balanceOf`).

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, js_trim, parse_amount};
use service_kit::schema::Value;
use service_kit::time::Instant;

use super::forms::{self, Recipient, as_given, canonical, check_recipient, mask_recipient};
use super::payees::Book;
use crate::bills::Deps;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{self, Space, pg, with};

/// `RailSendAsk`: details typed for this send, or a saved recipient once its cooling-off has passed.
pub enum To<'a> {
    Typed {
        rail: &'a str,
        recipient: &'a [(String, Value)],
    },
    Saved {
        payee_id: &'a str,
    },
}

pub struct Ask<'a> {
    pub from_space_id: &'a str,
    pub amount: &'a str,
    pub to: To<'a>,
}

struct Entered {
    space: Space,
    amount: Amount,
    rail: String,
    recipient: Recipient,
}

/// `IntentRow`.
struct IntentRow {
    id: String,
    user_id: String,
    from_space_id: String,
    asset_id: String,
    amount: Amount,
    rail: String,
    recipient: Recipient,
    status: String,
    refusal_code: String,
    created_at: Instant,
}

const COLS: &str = "id::text, user_id, from_space_id::text, asset_id, amount::text, rail, recipient::text, status, \
     refusal_code, floor(extract(epoch from created_at) * 1000)::int8";

fn intent(r: &postgres::Row) -> Result<IntentRow, Refusal> {
    let s = |i: usize| -> Result<String, Refusal> { r.try_get::<_, String>(i).map_err(|e| pg(&e)) };
    Ok(IntentRow {
        id: s(0)?,
        user_id: s(1)?,
        from_space_id: s(2)?,
        asset_id: s(3)?,
        amount: parse_amount(&s(4)?).map_err(Refusal::Other)?,
        rail: s(5)?,
        recipient: forms::from_json_text(&s(6)?)?,
        status: s(7)?,
        refusal_code: r
            .try_get::<_, Option<String>>(8)
            .map_err(|e| pg(&e))?
            .unwrap_or_default(),
        created_at: Instant(r.try_get(9).map_err(|e| pg(&e))?),
    })
}

fn view(r: &IntentRow) -> Json {
    Json::obj([
        ("requestId", Json::str(r.id.clone())),
        ("fromSpaceId", Json::str(r.from_space_id.clone())),
        ("assetId", Json::str(r.asset_id.clone())),
        ("amount", Json::str(format_amount(r.amount))),
        ("rail", Json::str(r.rail.clone())),
        (
            "recipient",
            Json::str(mask_recipient(&r.rail, &r.recipient)),
        ),
        ("status", Json::str(r.status.clone())),
        ("refusalCode", Json::str(r.refusal_code.clone())),
        ("createdAt", Json::str(r.created_at.iso())),
    ])
}

/// `same`: the kept intent, if it is this customer's and was asked on the same terms. Anything else is a conflict.
fn same(r: &IntentRow, user_id: &str, e: &Entered) -> Result<Json, Refusal> {
    let matches = r.user_id == user_id
        && r.from_space_id == e.space.id
        && r.amount == e.amount
        && r.rail == e.rail
        && canonical(&r.recipient) == canonical(&e.recipient);
    if !matches {
        return Err(refuse(
            "bank.rail_send_conflict",
            "This request id is already used on other terms",
        ));
    }
    Ok(view(r))
}

fn book<'a>(d: &'a Deps<'_>) -> Book<'a> {
    Book {
        cooling_hours: d.w.rail_sends.cooling_hours.as_deref(),
        now: crate::door::system_now,
    }
}

/// `entry`: the amount, the rail's form (or the saved recipient's), then the space: not found and not yours read the
/// same, as every space door does. The recipient's cooling-off comes after, in `check` and `send`.
fn entry(d: &Deps<'_>, user_id: &str, ask: &Ask<'_>) -> Result<Entered, Refusal> {
    let amount = parse_amount(js_trim(ask.amount))
        .map_err(|_| forms::invalid("Enter an amount with up to 18 decimals"))?;
    if amount <= Amount::ZERO {
        return Err(forms::invalid("The amount to send must be above zero"));
    }
    let (rail, recipient) = match &ask.to {
        To::Saved { payee_id } => {
            let payee = with(d.store(), |c| Book::find(c, user_id, payee_id))?;
            let recipient = check_recipient(&payee.rail, &as_given(&payee.recipient))?;
            (payee.rail, recipient)
        }
        To::Typed { rail, recipient } => ((*rail).to_owned(), check_recipient(rail, recipient)?),
    };
    let from = js_trim(ask.from_space_id).to_lowercase();
    let found = with(d.store(), |c| space::find(c, &from))?;
    let space = match found {
        Some(s) if s.user_id == user_id => s,
        _ => return Err(space::not_found(&from)),
    };
    if space.archived_at.is_some() {
        return Err(space::archived(&space.name));
    }
    Ok(Entered {
        space,
        amount,
        rail,
        recipient,
    })
}

/// `available`: the space's available balance, refusing an amount above it.
fn available(d: &Deps<'_>, space: &Space, amount: Amount) -> Result<Amount, Refusal> {
    let available = d.t.money().balance_of(space)?;
    if amount > available {
        return Err(refuse(
            "bank.rail_send_over_available",
            format!(
                "You can send up to {} {}, the balance available in this space now",
                format_amount(available),
                space.asset_id
            ),
        ));
    }
    Ok(available)
}

/// `check`: every check a send makes, keeping nothing.
pub fn check(d: &Deps<'_>, user_id: &str, ask: &Ask<'_>) -> Result<Json, Refusal> {
    let e = entry(d, user_id, ask)?;
    with(d.store(), |c| {
        book(d).assert_cooled(c, user_id, &e.rail, &e.recipient)
    })?;
    let avail = available(d, &e.space, e.amount)?;
    Ok(Json::obj([
        ("assetId", Json::str(e.space.asset_id.clone())),
        ("amount", Json::str(format_amount(e.amount))),
        ("available", Json::str(format_amount(avail))),
    ]))
}

fn row(d: &Deps<'_>, request_id: &str) -> Result<Option<IntentRow>, Refusal> {
    with(d.store(), |c| {
        c.query(
            &format!("SELECT {COLS} FROM bank.rail_send_intents WHERE id = $1::text::uuid"),
            &[&request_id],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(intent)
        .transpose()
    })
}

/// `send`: ask to send. Kept `refused` with `rail.bank`; nothing is held or posted.
pub fn send(d: &Deps<'_>, user_id: &str, request_id: &str, ask: &Ask<'_>) -> Result<Json, Refusal> {
    let e = entry(d, user_id, ask)?;
    // A send already kept is answered as kept: a later change to the recipient or the window does not undo it.
    if let Some(prior) = row(d, request_id)? {
        return same(&prior, user_id, &e);
    }
    with(d.store(), |c| {
        book(d).assert_cooled(c, user_id, &e.rail, &e.recipient)
    })?;
    available(d, &e.space, e.amount)?;
    let recipient = forms::to_json(&e.recipient).compact();
    let inserted = with(d.store(), |c| {
        c.query(
            &format!(
                "INSERT INTO bank.rail_send_intents \
                   (id, user_id, from_space_id, asset_id, amount, rail, recipient, status, refusal_code) \
                 VALUES ($1::text::uuid, $2, $3::text::uuid, $4, $5::text::numeric, $6, $7::text::jsonb, \
                         'refused', 'rail.bank') \
                 ON CONFLICT (id) DO NOTHING RETURNING {COLS}"
            ),
            &[
                &request_id,
                &user_id,
                &e.space.id,
                &e.space.asset_id,
                &format_amount(e.amount),
                &e.rail,
                &recipient,
            ],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(intent)
        .transpose()
    })?;
    let kept = match inserted {
        Some(r) => Some(r),
        None => row(d, request_id)?,
    };
    let Some(kept) = kept else {
        return Err(refuse("bank.rail_send_conflict", "The send was not kept"));
    };
    same(&kept, user_id, &e)
}

/// `list`: the customer's own sends over a bank rail, newest first.
pub fn list(d: &Deps<'_>, user_id: &str, limit: i64) -> Result<Json, Refusal> {
    let rows = with(d.store(), |c| {
        c.query(
            &format!(
                "SELECT {COLS} FROM bank.rail_send_intents WHERE user_id = $1 \
                  ORDER BY created_at DESC, id DESC LIMIT $2"
            ),
            &[&user_id, &limit],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(intent)
        .collect::<Result<Vec<_>, _>>()
    })?;
    Ok(Json::Array(rows.iter().map(view).collect()))
}
