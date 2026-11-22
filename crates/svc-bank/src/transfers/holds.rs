//! Holds on received funds (`holds/received-holds.ts`, `holds/holds.router.ts`; PP-money-balance-05): a person may
//! choose that a payment from someone they have never paid waits for their answer instead of being paid in. The send
//! posts as any other; its hold is decided inside the send's reservation ([`decide`]), set aside after the send posts
//! ([`place_for`]) through svc-ledger's `payReceivedHold` recipe, and answered once: Accept releases it
//! (`payReceivedRelease`), Deny or the release date returns it to the payer (`payReceivedReturn`). The recovery timer
//! ([`sweep`]) finishes any step a crash left owed. Money moves only through those recipes, never by entries
//! assembled here.

use postgres::GenericClient;
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::Instant;

use super::Deps;
use crate::door::Ctx;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::ports::PostFailure;
use crate::spaces::space::{at, in_tx, pg, with};

const DAY_MS: i64 = 86_400_000;
/// `POST_IN_FLIGHT_BOUND_SECONDS`: how long a post of unknown outcome may still land.
pub const POST_IN_FLIGHT_BOUND_SECONDS: i64 = 7 * 60;
/// `RELEASE_DATE_ACTOR`: who decided a hold that went back at its release date.
pub const RELEASE_DATE_ACTOR: &str = "system:release-date";

/// `readStrangerHoldDays`: the owner's release period, 1 to 365 days, or none.
pub fn read_hold_days(raw: Option<&str>) -> Option<i64> {
    let t = raw.unwrap_or("").trim();
    if t.is_empty() || t.len() > 3 || !t.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    t.parse::<i64>().ok().filter(|d| (1..=365).contains(d))
}

/// The release period the slice was given (`BANK_STRANGER_HOLD_DAYS`), when it is one.
pub fn hold_days(d: &Deps<'_>) -> Option<i64> {
    d.w.settings
        .stranger_hold_days
        .filter(|days| (1..=365).contains(days))
}

/// The columns of a hold, in [`Hold::from_row`]'s order, times in milliseconds.
fn hold_cols(alias: &str) -> String {
    let ms = |c: &str| format!("floor(extract(epoch from {alias}{c}) * 1000)::int8");
    [
        format!("{alias}transfer_id"),
        format!("{alias}recipient_user_id"),
        format!("{alias}payer_user_id"),
        format!("{alias}asset_id"),
        format!("{alias}amount::text"),
        format!("{alias}reason_class"),
        format!("{alias}state"),
        ms("release_at"),
        format!("{alias}hold_tx_id"),
        format!("{alias}outcome_tx_id"),
        format!("{alias}decided_by"),
        ms("attempted_at"),
        ms("refused_at"),
        ms("created_at"),
        ms("decided_at"),
    ]
    .join(", ")
}

/// One `bank.received_holds` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hold {
    pub transfer_id: String,
    pub recipient_user_id: String,
    pub payer_user_id: String,
    pub asset_id: String,
    pub amount: Amount,
    pub reason_class: String,
    pub state: String,
    pub release_at: Instant,
    pub hold_tx_id: Option<String>,
    pub outcome_tx_id: Option<String>,
    pub decided_by: Option<String>,
    pub attempted_at: Option<Instant>,
    pub refused_at: Option<Instant>,
    pub created_at: Instant,
    pub decided_at: Option<Instant>,
}

impl Hold {
    fn from_row(r: &postgres::Row) -> Result<Hold, Refusal> {
        let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
        let o = |i: usize| r.try_get::<_, Option<String>>(i).map_err(|e| pg(&e));
        let t = |i: usize| r.try_get::<_, i64>(i).map(Instant).map_err(|e| pg(&e));
        let ot = |i: usize| {
            r.try_get::<_, Option<i64>>(i)
                .map(|v| v.map(Instant))
                .map_err(|e| pg(&e))
        };
        Ok(Hold {
            transfer_id: s(0)?,
            recipient_user_id: s(1)?,
            payer_user_id: s(2)?,
            asset_id: s(3)?,
            amount: parse_amount(&s(4)?).map_err(Refusal::Other)?,
            reason_class: s(5)?,
            state: s(6)?,
            release_at: t(7)?,
            hold_tx_id: o(8)?,
            outcome_tx_id: o(9)?,
            decided_by: o(10)?,
            attempted_at: ot(11)?,
            refused_at: ot(12)?,
            created_at: t(13)?,
            decided_at: ot(14)?,
        })
    }

    /// `toView`: `ReceivedHoldView`, in `holdView`'s key order.
    pub fn view(&self, from_handle: Option<&str>, note: Option<&str>) -> Json {
        let opt = |v: Option<&str>| v.map_or(Json::Null, Json::str);
        Json::obj([
            ("transferId", Json::str(self.transfer_id.clone())),
            ("state", Json::str(self.state.clone())),
            ("reasonClass", Json::str(self.reason_class.clone())),
            ("amount", Json::str(format_amount(self.amount))),
            ("assetId", Json::str(self.asset_id.clone())),
            ("fromHandle", opt(from_handle)),
            ("note", opt(note)),
            ("createdAt", Json::str(self.created_at.iso())),
            ("releaseAt", Json::str(self.release_at.iso())),
            (
                "decidedAt",
                self.decided_at.map_or(Json::Null, |t| Json::str(t.iso())),
            ),
        ])
    }
}

/// `logHoldFailure`.
fn log_failure(event: &str, transfer_id: &str, detail: &str) {
    eprintln!(
        "{}",
        Json::obj([
            ("level", Json::str("error")),
            ("service", Json::str("svc-bank")),
            ("event", Json::str(event)),
            ("transferId", Json::str(transfer_id)),
            ("detail", Json::str(detail)),
        ])
        .compact()
    );
}

/// What a failure says, as `err.message` reads it.
pub fn reason_of(r: &Refusal) -> String {
    match r {
        Refusal::Bank(e) => e.message.clone(),
        Refusal::Trpc(e) => e.message.clone(),
        Refusal::Other(m) => m.clone(),
    }
}

/// `ReceiveRuleView`.
fn rule_view(strangers: &str, days: Option<i64>) -> Json {
    Json::obj([
        ("strangers", Json::str(strangers)),
        ("holdDays", days.map_or(Json::Null, Json::int)),
    ])
}

/// `rule`: the person's choice for payments from strangers (`pay_in` until they choose) and the release period.
pub fn rule(d: &Deps<'_>, user_id: &str) -> Result<Json, Refusal> {
    let strangers = with(d.store, |c| {
        let rows = c
            .query(
                "SELECT strangers FROM bank.receive_rules WHERE user_id = $1",
                &[&user_id],
            )
            .map_err(|e| pg(&e))?;
        rows.first()
            .map(|r| r.try_get::<_, String>(0).map_err(|e| pg(&e)))
            .transpose()
    })?;
    Ok(rule_view(
        strangers.as_deref().unwrap_or("pay_in"),
        hold_days(d),
    ))
}

/// `setRule`: `hold` needs a published release period, so a payment is never held without a date.
pub fn set_rule(d: &Deps<'_>, user_id: &str, strangers: &str) -> Result<Json, Refusal> {
    if strangers == "hold" && hold_days(d).is_none() {
        return Err(refuse(
            "bank.stranger_hold_period_unset",
            "No release period is published for held payments, so payments cannot be held yet (bank.stranger_hold_period_unset)",
        ));
    }
    with(d.store, |c| {
        c.execute(
            &format!(
                "INSERT INTO bank.receive_rules (user_id, strangers, updated_at) VALUES ($1, $2, {}) \
                 ON CONFLICT (user_id) DO UPDATE SET strangers = EXCLUDED.strangers, updated_at = EXCLUDED.updated_at",
                at("$3")
            ),
            &[&user_id, &strangers, &d.now.0],
        )
        .map_err(|e| pg(&e))
    })?;
    rule(d, user_id)
}

/// What [`decide`] is asked about one send.
pub struct Decide<'a> {
    pub transfer_id: &'a str,
    pub payer_user_id: &'a str,
    pub recipient_user_id: &'a str,
    pub asset_id: &'a str,
    pub amount: Amount,
    pub request_id: Option<&'a str>,
    pub now: Instant,
}

/// `decide`, inside the send's reservation: whether this payment is held. Only a payer the recipient has never paid,
/// paying no request of theirs, while the recipient chose `hold` and a release period is published. A held payment's
/// row starts `placing`; it is set aside once the send posts.
pub fn decide(
    tx: &mut impl GenericClient,
    hold_days: Option<i64>,
    i: &Decide<'_>,
) -> Result<bool, Refusal> {
    let Some(days) = hold_days else {
        return Ok(false);
    };
    if i.request_id.is_some() || i.payer_user_id == i.recipient_user_id {
        return Ok(false);
    }
    let rule = tx
        .query(
            "SELECT strangers FROM bank.receive_rules WHERE user_id = $1",
            &[&i.recipient_user_id],
        )
        .map_err(|e| pg(&e))?;
    let strangers = rule
        .first()
        .map(|r| r.try_get::<_, String>(0).map_err(|e| pg(&e)))
        .transpose()?;
    if strangers.as_deref() != Some("hold") {
        return Ok(false);
    }
    let known = tx
        .query(
            "SELECT 1 AS one FROM bank.personal_transfers \
              WHERE from_user_id = $1 AND to_user_id = $2 AND status = 'posted' LIMIT 1",
            &[&i.recipient_user_id, &i.payer_user_id],
        )
        .map_err(|e| pg(&e))?;
    if !known.is_empty() {
        return Ok(false);
    }
    let release_at = i.now.0 + days * DAY_MS;
    tx.execute(
        &format!(
            "INSERT INTO bank.received_holds ( \
               transfer_id, recipient_user_id, payer_user_id, asset_id, amount, reason_class, state, release_at, created_at \
             ) VALUES ($1, $2, $3, $4, $5::text::numeric, 'stranger', 'placing', {}, {}) \
             ON CONFLICT (transfer_id) DO NOTHING",
            at("$6"),
            at("$7")
        ),
        &[
            &i.transfer_id,
            &i.recipient_user_id,
            &i.payer_user_id,
            &i.asset_id,
            &format_amount(i.amount),
            &release_at,
            &i.now.0,
        ],
    )
    .map_err(|e| pg(&e))?;
    Ok(true)
}

fn find(c: &mut impl GenericClient, transfer_id: &str) -> Result<Option<Hold>, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {} FROM bank.received_holds WHERE transfer_id = $1",
                hold_cols("")
            ),
            &[&transfer_id],
        )
        .map_err(|e| pg(&e))?;
    rows.first().map(Hold::from_row).transpose()
}

/// `placeFor`: after the send posted, set its hold aside. False when there is no hold (or it lapsed); a failure to set
/// it aside is logged and left to the recovery timer, never the send's answer.
pub fn place_for(d: &Deps<'_>, transfer_id: &str, at_time: Instant) -> Result<bool, Refusal> {
    let Some(row) = with(d.store, |c| find(c, transfer_id))? else {
        return Ok(false);
    };
    if row.state != "placing" {
        return Ok(row.state != "lapsed");
    }
    if let Err(e) = place(d, &row, at_time) {
        log_failure(
            "bank.received_hold_place_failed",
            transfer_id,
            &reason_of(&e),
        );
    }
    Ok(true)
}

/// `waiting`: the person's holds still open or under way, newest first, 50 at most.
pub fn waiting(d: &Deps<'_>, user_id: &str) -> Result<Vec<Json>, Refusal> {
    with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {}, t.from_handle, t.note \
                       FROM bank.received_holds h \
                       JOIN bank.personal_transfers t ON t.transfer_id = h.transfer_id \
                      WHERE h.recipient_user_id = $1 AND h.state IN ('placing', 'held', 'releasing', 'returning') \
                      ORDER BY h.created_at DESC \
                      LIMIT 50",
                    hold_cols("h.")
                ),
                &[&user_id],
            )
            .map_err(|e| pg(&e))?;
        rows.iter()
            .map(|r| {
                let h = Hold::from_row(r)?;
                let handle: Option<String> = r.try_get(15).map_err(|e| pg(&e))?;
                let note: Option<String> = r.try_get(16).map_err(|e| pg(&e))?;
                Ok(h.view(handle.as_deref(), note.as_deref()))
            })
            .collect()
    })
}

/// `HoldOutcome`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Release,
    Return,
}

/// `decideHold`: the recipient's one answer. The claim is written first, so a lost ledger post is still recorded and
/// the recovery timer finishes it; the same answer again is the same outcome, the other one is refused.
pub fn decide_hold(
    d: &Deps<'_>,
    user_id: &str,
    transfer_id: &str,
    outcome: Outcome,
) -> Result<Json, Refusal> {
    let now = d.now;
    let (claiming, done) = match outcome {
        Outcome::Release => ("releasing", "released"),
        Outcome::Return => ("returning", "returned"),
    };
    let claimed = in_tx(d.store, |tx| {
        let rows = tx
            .query(
                &format!(
                    "SELECT {} FROM bank.received_holds WHERE transfer_id = $1 FOR UPDATE",
                    hold_cols("")
                ),
                &[&transfer_id],
            )
            .map_err(|e| pg(&e))?;
        let row = rows.first().map(Hold::from_row).transpose()?;
        let Some(row) = row.filter(|r| r.recipient_user_id == user_id) else {
            return Err(refuse(
                "bank.received_hold_not_found",
                "No payment of yours is waiting under this id (bank.received_hold_not_found)",
            ));
        };
        if row.state == claiming || row.state == done {
            return Ok(row);
        }
        if row.state != "held" {
            return Err(if row.state == "placing" {
                refuse(
                    "bank.received_hold_not_ready",
                    "This payment is still being set aside; try again in a moment (bank.received_hold_not_ready)",
                )
            } else {
                refuse(
                    "bank.received_hold_decided",
                    "This payment was already answered (bank.received_hold_decided)",
                )
            });
        }
        if row.release_at.0 <= now.0 {
            return Err(refuse(
                "bank.received_hold_decided",
                "This payment went back to the sender at its release date (bank.received_hold_decided)",
            ));
        }
        let next = tx
            .query(
                &format!(
                    "UPDATE bank.received_holds SET state = $1, decided_by = $2, attempted_at = {} \
                      WHERE transfer_id = $4 AND state = 'held' RETURNING {}",
                    at("$3"),
                    hold_cols("")
                ),
                &[&claiming, &user_id, &now.0, &transfer_id],
            )
            .map_err(|e| pg(&e))?;
        next.first()
            .map(Hold::from_row)
            .transpose()?
            .ok_or_else(|| Refusal::Other("the claimed hold row is gone".to_owned()))
    })?;
    let finished = finish(d, &claimed, now).unwrap_or_else(|e| {
        log_failure(
            "bank.received_hold_finish_failed",
            transfer_id,
            &reason_of(&e),
        );
        claimed.clone()
    });
    let extra = with(d.store, |c| {
        let rows = c
            .query(
                "SELECT from_handle, note FROM bank.personal_transfers WHERE transfer_id = $1",
                &[&transfer_id],
            )
            .map_err(|e| pg(&e))?;
        rows.first()
            .map(|r| -> Result<(Option<String>, Option<String>), Refusal> {
                Ok((
                    r.try_get(0).map_err(|e| pg(&e))?,
                    r.try_get(1).map_err(|e| pg(&e))?,
                ))
            })
            .transpose()
    })?;
    let (handle, note) = extra.unwrap_or((None, None));
    Ok(finished.view(handle.as_deref(), note.as_deref()))
}

/// `sweep`: the recovery timer. Every hold still owed a step (set aside, released, returned, or gone back at its release
/// date) is advanced; a hold lapsed within twice the in-flight bound whose post landed after all is put back to held.
/// One result per row it worked on: `Ok` completed, `Err` failed with why.
pub fn sweep(d: &Deps<'_>, limit: i64) -> Vec<Result<(), String>> {
    let now = d.now;
    let mut results = Vec::new();
    let rows = with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.received_holds \
                      WHERE state IN ('placing', 'releasing', 'returning') OR (state = 'held' AND release_at <= {}) \
                      ORDER BY created_at LIMIT $2",
                    hold_cols(""),
                    at("$1")
                ),
                &[&now.0, &limit],
            )
            .map_err(|e| pg(&e))?;
        rows.iter()
            .map(Hold::from_row)
            .collect::<Result<Vec<_>, _>>()
    });
    match rows {
        Ok(rows) => {
            for row in rows {
                results.push(advance(d, &row, now).map_err(|e| reason_of(&e)));
            }
        }
        Err(e) => {
            results.push(Err(reason_of(&e)));
            return results;
        }
    }
    let since = now.0 - 2 * POST_IN_FLIGHT_BOUND_SECONDS * 1000;
    let lapsed = with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "SELECT {} FROM bank.received_holds \
                      WHERE state = 'lapsed' AND decided_at > {} ORDER BY decided_at LIMIT $2",
                    hold_cols(""),
                    at("$1")
                ),
                &[&since, &limit],
            )
            .map_err(|e| pg(&e))?;
        rows.iter()
            .map(Hold::from_row)
            .collect::<Result<Vec<_>, _>>()
    });
    match lapsed {
        Ok(rows) => {
            for row in rows {
                let key = hold_key(&row.transfer_id);
                match d.ledger.tx_by_key(&key) {
                    Ok(Some(booked)) => match mark_held(d, &row.transfer_id, &booked.id, now) {
                        Ok(true) => results.push(Ok(())),
                        Ok(false) => {}
                        Err(e) => results.push(Err(reason_of(&e))),
                    },
                    Ok(None) => {}
                    Err(e) => results.push(Err(e)),
                }
            }
        }
        Err(e) => results.push(Err(reason_of(&e))),
    }
    results
}

fn advance(d: &Deps<'_>, row: &Hold, now: Instant) -> Result<(), Refusal> {
    match row.state.as_str() {
        "placing" => place(d, row, now),
        "releasing" | "returning" => finish(d, row, now).map(|_| ()),
        "held" if row.release_at.0 <= now.0 => {
            let claimed = with(d.store, |c| {
                let rows = c
                    .query(
                        &format!(
                            "UPDATE bank.received_holds SET state = 'returning', decided_by = $1, attempted_at = {} \
                              WHERE transfer_id = $3 AND state = 'held' RETURNING {}",
                            at("$2"),
                            hold_cols("")
                        ),
                        &[&RELEASE_DATE_ACTOR, &now.0, &row.transfer_id],
                    )
                    .map_err(|e| pg(&e))?;
                rows.first().map(Hold::from_row).transpose()
            })?;
            if let Some(claimed) = claimed {
                finish(d, &claimed, now)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// `bankTransferKey('p2p', transferId, 0)`: the send's own ledger key.
fn send_key(transfer_id: &str) -> String {
    format!("bank.transfer.p2p:{transfer_id}:0")
}

/// `payReceivedHold(...).idempotencyKey`.
pub fn hold_key(transfer_id: &str) -> String {
    format!("pay.recv.hold:{}", transfer_id.trim())
}

/// The recipe inputs (`PayReceivedHoldInput`): the hold's own id is the send's, amounts as decimal strings.
fn hold_input(row: &Hold) -> Json {
    Json::obj([
        ("holdId", Json::str(row.transfer_id.clone())),
        ("userId", Json::str(row.recipient_user_id.clone())),
        ("assetId", Json::str(row.asset_id.clone())),
        ("amount", Json::str(format_amount(row.amount))),
    ])
}

fn post_refusal(f: &PostFailure) -> Refusal {
    Refusal::Other(f.message().to_owned())
}

fn place(d: &Deps<'_>, row: &Hold, now: Instant) -> Result<(), Refusal> {
    let send = with(d.store, |c| {
        let rows = c
            .query(
                "SELECT status, floor(extract(epoch from created_at) * 1000)::int8 \
                   FROM bank.personal_transfers WHERE transfer_id = $1",
                &[&row.transfer_id],
            )
            .map_err(|e| pg(&e))?;
        rows.first()
            .map(|r| -> Result<(String, i64), Refusal> {
                Ok((
                    r.try_get(0).map_err(|e| pg(&e))?,
                    r.try_get(1).map_err(|e| pg(&e))?,
                ))
            })
            .transpose()
    })?;
    let Some((status, created_at)) = send else {
        return Ok(());
    };
    if status != "posted"
        && d.ledger
            .tx_by_key(&send_key(&row.transfer_id))
            .map_err(Refusal::Other)?
            .is_none()
    {
        if now.0 - created_at > POST_IN_FLIGHT_BOUND_SECONDS * 1000 {
            mark_lapsed(d, &row.transfer_id, now, "the payment never arrived")?;
        }
        return Ok(());
    }
    let key = hold_key(&row.transfer_id);
    let claimed = with(d.store, |c| {
        c.query(
            &format!(
                "UPDATE bank.received_holds SET attempted_at = {} WHERE transfer_id = $2 AND state = 'placing' \
                 RETURNING transfer_id",
                at("$1")
            ),
            &[&now.0, &row.transfer_id],
        )
        .map_err(|e| pg(&e))
    })?;
    if claimed.is_empty() {
        return Ok(());
    }
    let tx_id = match d
        .ledger
        .post_recipe("payReceivedHold", &hold_input(row), &key)
    {
        Ok(tx) => tx.id,
        Err(err) => match d.ledger.tx_by_key(&key).map_err(Refusal::Other)? {
            Some(booked) => booked.id,
            None => {
                let short = err.insufficient();
                if short
                    && row
                        .refused_at
                        .is_some_and(|r| now.0 - r.0 > POST_IN_FLIGHT_BOUND_SECONDS * 1000)
                {
                    mark_lapsed(
                        d,
                        &row.transfer_id,
                        now,
                        "the payment was spent before it could be set aside",
                    )?;
                    return Ok(());
                }
                let refused_at = if short {
                    Some(row.refused_at.unwrap_or(now).0)
                } else {
                    None
                };
                with(d.store, |c| {
                    c.execute(
                        &format!(
                            "UPDATE bank.received_holds SET refused_at = {} \
                              WHERE transfer_id = $2 AND state = 'placing'",
                            at("$1")
                        ),
                        &[&refused_at, &row.transfer_id],
                    )
                    .map_err(|e| pg(&e))
                })?;
                return Err(post_refusal(&err));
            }
        },
    };
    mark_held(d, &row.transfer_id, &tx_id, now)?;
    Ok(())
}

fn mark_held(d: &Deps<'_>, transfer_id: &str, tx_id: &str, now: Instant) -> Result<bool, Refusal> {
    let changed = with(d.store, |c| {
        c.execute(
            &format!(
                "UPDATE bank.received_holds \
                    SET state = 'held', hold_tx_id = $1, placed_at = {}, decided_at = NULL, lapse_reason = NULL \
                  WHERE transfer_id = $3 AND state IN ('placing', 'lapsed')",
                at("$2")
            ),
            &[&tx_id, &now.0, &transfer_id],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(changed > 0)
}

fn mark_lapsed(d: &Deps<'_>, transfer_id: &str, now: Instant, why: &str) -> Result<(), Refusal> {
    with(d.store, |c| {
        c.execute(
            &format!(
                "UPDATE bank.received_holds SET state = 'lapsed', decided_at = {}, lapse_reason = $2 \
                  WHERE transfer_id = $3 AND state = 'placing'",
                at("$1")
            ),
            &[&now.0, &why, &transfer_id],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(())
}

fn finish(d: &Deps<'_>, row: &Hold, now: Instant) -> Result<Hold, Refusal> {
    let (recipe, key, done) = match row.state.as_str() {
        "releasing" => (
            "payReceivedRelease",
            format!("pay.recv.release:{}", row.transfer_id.trim()),
            "released",
        ),
        "returning" => (
            "payReceivedReturn",
            format!("pay.recv.return:{}", row.transfer_id.trim()),
            "returned",
        ),
        _ => return Ok(row.clone()),
    };
    let mut input = vec![
        ("holdId".to_owned(), Json::str(row.transfer_id.clone())),
        (
            "userId".to_owned(),
            Json::str(row.recipient_user_id.clone()),
        ),
        ("assetId".to_owned(), Json::str(row.asset_id.clone())),
        ("amount".to_owned(), Json::str(format_amount(row.amount))),
        (
            "heldAmount".to_owned(),
            Json::str(format_amount(row.amount)),
        ),
    ];
    if done == "returned" {
        input.push((
            "payerUserId".to_owned(),
            Json::str(row.payer_user_id.clone()),
        ));
    }
    let tx_id = match d.ledger.post_recipe(recipe, &Json::Object(input), &key) {
        Ok(tx) => tx.id,
        Err(err) => match d.ledger.tx_by_key(&key).map_err(Refusal::Other)? {
            Some(booked) => booked.id,
            None => return Err(post_refusal(&err)),
        },
    };
    let updated = with(d.store, |c| {
        let rows = c
            .query(
                &format!(
                    "UPDATE bank.received_holds SET state = $1, outcome_tx_id = $2, decided_at = {} \
                      WHERE transfer_id = $4 AND state = $5 RETURNING {}",
                    at("$3"),
                    hold_cols("")
                ),
                &[&done, &tx_id, &now.0, &row.transfer_id, &row.state],
            )
            .map_err(|e| pg(&e))?;
        match rows.first() {
            Some(r) => Hold::from_row(r).map(Some),
            None => find(c, &row.transfer_id),
        }
    })?;
    Ok(updated.unwrap_or_else(|| row.clone()))
}

/// The answer of one of this part's calls, by its path; `None` for a path outside it.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let user = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    let text = |k: &str| ctx.input.get(k).as_str().unwrap_or_default();
    Some(match ctx.call.path {
        "holds.rule" => rule(d, user),
        "holds.setRule" => set_rule(d, user, text("strangers")),
        "holds.waiting" => waiting(d, user).map(Json::Array),
        "holds.accept" => decide_hold(d, user, text("transferId"), Outcome::Release),
        "holds.deny" => decide_hold(d, user, text("transferId"), Outcome::Return),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_release_period_is_a_whole_number_of_days_from_1_to_365() {
        assert_eq!(read_hold_days(Some(" 30 ")), Some(30));
        assert_eq!(read_hold_days(Some("0")), None);
        assert_eq!(read_hold_days(Some("366")), None);
        assert_eq!(read_hold_days(Some("1000")), None);
        assert_eq!(read_hold_days(Some("1.5")), None);
        assert_eq!(read_hold_days(None), None);
    }
}
