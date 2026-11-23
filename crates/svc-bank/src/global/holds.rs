//! `GlobalHoldService` (`personal-pay/holds.ts`): compliance holds on a global send, and the document a customer is
//! asked for.
//!
//! A hold applies only to a send that is still `submitted` with no ledger transaction, so no value has moved and none
//! is reserved. If a hold lands in the instant the forward entry is being posted, the debit stands on the held send and
//! no payout is made until it is released. The hold's reason is internal; the customer sees only the request an
//! operator wrote for them. Release needs a different person from the one who held. If releasing leaves the outcome
//! unknown and nothing was posted, the hold goes back on.
//!
//! Cancel: while a send is on hold with nothing posted, its customer can cancel it, and the owner's window
//! (`BANK_GLOBAL_HOLD_CANCEL_HOURS`, no default) cancels one still on hold that long after the hold was placed. A
//! cancelled send never posts; the window is applied whenever the send or the queue is read and before any release.

use base64::Engine as _;
use postgres::{GenericClient, Row};
use service_kit::json::Json;
use service_kit::money::js_trim;
use service_kit::time::Instant;
use sha2::{Digest, Sha256};

use super::refusals::{code_of, refuse};
use super::rules;
use super::send::{self, SendRow, hex, node_base64};
use super::{Deps, ms, require_text, units, uuid};
use crate::errors::Refusal;
use crate::spaces::space::{at, in_tx, pg, with};

const HOUR_MS: i64 = 3_600_000;

/// Who placed a hold the stand-in's screening put on: not a person, so it never matches a signed-in operator.
pub const SCREENING_OPERATOR: &str = "system:test-screening";
const SCREENING_REASON: &str =
    "TEST screening: the stand-in marks this amount for a compliance look";

/// `readHoldCancelHours`: the owner's window in whole hours (1 or more), or none when blank or not a whole number.
pub fn read_hold_cancel_hours(raw: Option<&str>) -> Option<i64> {
    let t = js_trim(raw.unwrap_or(""));
    if t.is_empty() || t.len() > 6 || !t.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    t.parse::<i64>().ok().filter(|h| *h >= 1)
}

/// `HoldRow`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct HoldRow {
    id: String,
    send_id: String,
    hold_key: String,
    reason: String,
    placed_by: String,
    state: String,
    info_request: Option<String>,
    proof_name: Option<String>,
    proof_type: Option<String>,
    proof_size: Option<i32>,
    proof_sha256: Option<String>,
    proof_uploaded_at: Option<Instant>,
    released_by: Option<String>,
    released_at: Option<Instant>,
    created_at: Instant,
}

/// `COLUMNS`, each prefixed with `p` (`h.` in a join, empty otherwise).
fn cols(p: &str) -> String {
    format!(
        "{p}id::text, {p}send_id::text, {p}hold_key, {p}reason, {p}placed_by, {p}state, {p}info_request, {p}proof_name, \
         {p}proof_type, {p}proof_size, {p}proof_sha256, {}, {p}released_by, {}, {}",
        ms(&format!("{p}proof_uploaded_at")),
        ms(&format!("{p}released_at")),
        ms(&format!("{p}created_at"))
    )
}

impl HoldRow {
    fn from_row(r: &Row) -> Result<HoldRow, Refusal> {
        let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
        let o = |i: usize| r.try_get::<_, Option<String>>(i).map_err(|e| pg(&e));
        let t = |i: usize| {
            r.try_get::<_, Option<i64>>(i)
                .map(|v| v.map(Instant))
                .map_err(|e| pg(&e))
        };
        Ok(HoldRow {
            id: s(0)?,
            send_id: s(1)?,
            hold_key: s(2)?,
            reason: s(3)?,
            placed_by: s(4)?,
            state: s(5)?,
            info_request: o(6)?,
            proof_name: o(7)?,
            proof_type: o(8)?,
            proof_size: r.try_get::<_, Option<i32>>(9).map_err(|e| pg(&e))?,
            proof_sha256: o(10)?,
            proof_uploaded_at: t(11)?,
            released_by: o(12)?,
            released_at: t(13)?,
            created_at: Instant(r.try_get::<_, i64>(14).map_err(|e| pg(&e))?),
        })
    }

    /// `holdView`, in `operatorHoldView`'s order: everything but the file itself.
    fn fields(&self) -> Vec<(String, Json)> {
        let o = |v: &Option<String>| v.clone().map_or(Json::Null, Json::String);
        let proof = match (&self.proof_sha256, self.proof_uploaded_at) {
            (Some(sha), Some(at)) if !sha.is_empty() => Json::Object(vec![
                (
                    "name".to_owned(),
                    Json::str(self.proof_name.clone().unwrap_or_default()),
                ),
                (
                    "type".to_owned(),
                    Json::str(self.proof_type.clone().unwrap_or_default()),
                ),
                (
                    "size".to_owned(),
                    Json::int(i64::from(self.proof_size.unwrap_or(0))),
                ),
                ("sha256".to_owned(), Json::str(sha.clone())),
                ("uploadedAt".to_owned(), Json::str(at.iso())),
            ]),
            _ => Json::Null,
        };
        vec![
            ("id".to_owned(), Json::str(self.id.clone())),
            ("sendId".to_owned(), Json::str(self.send_id.clone())),
            ("state".to_owned(), Json::str(self.state.clone())),
            ("reason".to_owned(), Json::str(self.reason.clone())),
            ("heldBy".to_owned(), Json::str(self.placed_by.clone())),
            ("infoRequest".to_owned(), o(&self.info_request)),
            ("proof".to_owned(), proof),
            ("releasedBy".to_owned(), o(&self.released_by)),
            ("createdAt".to_owned(), Json::str(self.created_at.iso())),
        ]
    }

    fn view(&self) -> Json {
        Json::Object(self.fields())
    }
}

fn holds_where(
    c: &mut impl GenericClient,
    clause: &str,
    params: &[&(dyn postgres::types::ToSql + Sync)],
) -> Result<Vec<HoldRow>, Refusal> {
    c.query(
        &format!(
            "SELECT {} FROM bank.global_send_holds WHERE {clause}",
            cols("")
        ),
        params,
    )
    .map_err(|e| pg(&e))?
    .iter()
    .map(HoldRow::from_row)
    .collect()
}

fn open_hold(d: &Deps<'_>, send_id: &str) -> Result<Option<HoldRow>, Refusal> {
    Ok(with(d.store, |c| {
        holds_where(
            c,
            "send_id = $1::text::uuid AND state IN ('requested', 'under_review')",
            &[&send_id],
        )
    })?
    .into_iter()
    .next())
}

/// `mustOpen`.
fn must_open(d: &Deps<'_>, send_id: &str) -> Result<HoldRow, Refusal> {
    open_hold(d, send_id)?.ok_or_else(|| refuse("bank.hold_not_found"))
}

/// `autoCancelRule`: the window, or that it is not published (`{ state, hours }`).
pub fn auto_cancel_hours(d: &Deps<'_>) -> Option<i64> {
    read_hold_cancel_hours(d.w.settings.hold_cancel_hours.as_deref())
}

fn rule_fields(hours: Option<i64>) -> Vec<(String, Json)> {
    vec![
        (
            "state".to_owned(),
            Json::str(if hours.is_some() {
                "published"
            } else {
                "unset"
            }),
        ),
        ("hours".to_owned(), hours.map_or(Json::Null, Json::int)),
    ]
}

/// `global.autoCancelRule`.
pub fn auto_cancel_rule(d: &Deps<'_>) -> Json {
    Json::Object(rule_fields(auto_cancel_hours(d)))
}

/// `cancelsAt`: when the window cancels this hold, none when the rule is unset or the hold is closed.
fn cancels_at(d: &Deps<'_>, hold: &HoldRow) -> Option<Instant> {
    let hours = auto_cancel_hours(d)?;
    if hold.state != "requested" && hold.state != "under_review" {
        return None;
    }
    let at = hold.created_at.0.checked_add(hours.checked_mul(HOUR_MS)?)?;
    (at.abs() <= 8_640_000_000_000_000).then_some(Instant(at))
}

/// `cancelHold`: closes an open hold as cancelled and cancels its send, in one transaction; only a held send with
/// nothing posted.
fn cancel_hold(d: &Deps<'_>, hold: &HoldRow, by_customer: bool) -> Result<(), Refusal> {
    let closer = if by_customer {
        "customer"
    } else {
        "system:auto-cancel"
    };
    let by = if by_customer { "customer" } else { "auto" };
    in_tx(d.store, |tx| {
        let closed = tx
            .query(
                "UPDATE bank.global_send_holds SET state = 'cancelled', released_by = $2, released_at = now(), updated_at = now() \
                 WHERE id = $1::text::uuid AND state IN ('requested', 'under_review') RETURNING id",
                &[&hold.id, &closer],
            )
            .map_err(|e| pg(&e))?;
        if closed.is_empty() {
            return Err(refuse("bank.hold_not_found"));
        }
        let moved = tx
            .query(
                "UPDATE bank.global_sends SET status = 'cancelled', cancelled_by = $2, updated_at = now() \
                 WHERE id = $1::text::uuid AND status = 'held' AND ledger_tx_id IS NULL RETURNING id",
                &[&hold.send_id, &by],
            )
            .map_err(|e| pg(&e))?;
        // A hold that landed while the forward entry was being posted stands on a debit: that send cannot be cancelled.
        if moved.is_empty() {
            return Err(refuse("bank.transfer_settled"));
        }
        Ok(())
    })
}

/// Whose holds `expireOverdue` looks at.
#[derive(Debug, Clone, Copy, Default)]
pub struct Scope<'a> {
    pub user_id: Option<&'a str>,
    pub send_id: Option<&'a str>,
}

/// `expireOverdue`: every open hold placed longer ago than the window, on a send with nothing posted, is cancelled.
/// Blank window, nothing happens.
pub fn expire_overdue(d: &Deps<'_>, scope: Scope<'_>) -> Result<i64, Refusal> {
    let Some(hours) = auto_cancel_hours(d) else {
        return Ok(0);
    };
    let before = d.now.0 - hours * HOUR_MS;
    let mut clause = format!(
        "SELECT {} FROM bank.global_send_holds h JOIN bank.global_sends s ON s.id = h.send_id \
         WHERE h.state IN ('requested', 'under_review') AND h.created_at <= {} \
         AND s.status = 'held' AND s.ledger_tx_id IS NULL",
        cols("h."),
        at("$1")
    );
    let mut params: Vec<&(dyn postgres::types::ToSql + Sync)> = vec![&before];
    if let Some(u) = &scope.user_id {
        params.push(u);
        clause.push_str(&format!(" AND s.user_id = ${}", params.len()));
    }
    if let Some(s) = &scope.send_id {
        params.push(s);
        clause.push_str(&format!(" AND s.id = ${}::text::uuid", params.len()));
    }
    clause.push_str(" ORDER BY h.created_at LIMIT 200");
    let rows = with(d.store, |c| {
        c.query(&clause, &params)
            .map_err(|e| pg(&e))?
            .iter()
            .map(HoldRow::from_row)
            .collect::<Result<Vec<_>, _>>()
    })?;
    let mut cancelled = 0;
    for row in &rows {
        if cancel_hold(d, row, false).is_ok() {
            cancelled += 1;
        }
    }
    Ok(cancelled)
}

/// `cancel`: the customer cancels their send while it is on hold. Nothing was posted, so nothing is returned.
pub fn cancel(d: &Deps<'_>, user_id: &str, send_id: &str) -> Result<Json, Refusal> {
    send::get(d, user_id, send_id)?;
    expire_overdue(
        d,
        Scope {
            user_id: None,
            send_id: Some(send_id),
        },
    )?;
    let row = send::get(d, user_id, send_id)?;
    // Cancelled already (by the customer, or by the window just now) is the same answer.
    if row.status == "cancelled" {
        return Ok(row.view());
    }
    let open = open_hold(d, send_id)?;
    let Some(open) = open.filter(|_| row.status == "held" && row.ledger_tx_id.is_none()) else {
        return Err(refuse("bank.global_send_not_cancellable"));
    };
    if let Err(e) = cancel_hold(d, &open, true) {
        if matches!(
            code_of(&e),
            Some("bank.transfer_settled" | "bank.hold_not_found")
        ) {
            return Err(refuse("bank.global_send_not_cancellable"));
        }
        return Err(e);
    }
    Ok(send::get(d, user_id, send_id)?.view())
}

/// What `ops.hold` asks for.
pub struct HoldAsk<'a> {
    pub send_id: &'a str,
    pub operator_id: &'a str,
    pub hold_key: &'a str,
    pub reason: &'a str,
    pub info_request: Option<&'a str>,
}

/// `hold`: puts a send that has not left on hold. Replaying the same hold key returns the same hold.
pub fn hold(d: &Deps<'_>, i: &HoldAsk<'_>) -> Result<Json, Refusal> {
    let hold_key = require_text(i.hold_key, 128)?;
    if units(&hold_key) < 8 {
        return Err(refuse("bank.personal_pay_request_invalid"));
    }
    let reason = require_text(i.reason, 500)?;
    let info_request = i.info_request.map(|r| require_text(r, 1000)).transpose()?;
    let operator_id = require_text(i.operator_id, 128)?;

    let prior = with(d.store, |c| holds_where(c, "hold_key = $1", &[&hold_key]))?;
    if let Some(p) = prior.first() {
        let same = p.send_id == i.send_id && p.reason == reason && p.info_request == info_request;
        if !same {
            return Err(refuse("bank.hold_conflict"));
        }
        return Ok(p.view());
    }
    let row = send::ops_get(d, i.send_id)?;
    match row.status.as_str() {
        "sent" | "on_the_way" | "arrived" => return Err(refuse("bank.transfer_settled")),
        "failed" => return Err(refuse("bank.transfer_not_holdable")),
        "held" => return Err(refuse("bank.hold_conflict")),
        _ => {}
    }
    if row.ledger_tx_id.is_some() {
        return Err(refuse("bank.transfer_settled"));
    }
    let id = uuid()?;
    let placed = in_tx(d.store, |tx| {
        let moved = tx
            .query(
                "UPDATE bank.global_sends SET status = 'held', updated_at = now() \
                 WHERE id = $1::text::uuid AND status = 'submitted' AND ledger_tx_id IS NULL RETURNING id",
                &[&i.send_id],
            )
            .map_err(|e| pg(&e))?;
        if moved.is_empty() {
            return Err(refuse("bank.transfer_settled"));
        }
        let r = tx
            .query_one(
                &format!(
                    "INSERT INTO bank.global_send_holds (id, send_id, hold_key, reason, placed_by, state, info_request) \
                     VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5, 'requested', $6) RETURNING {}",
                    cols("")
                ),
                &[&id, &i.send_id, &hold_key, &reason, &operator_id, &info_request],
            )
            .map_err(|e| pg(&e))?;
        HoldRow::from_row(&r)
    })?;
    Ok(placed.view())
}

/// `screen`: the TEST stand-in's screening puts a send it marks on hold before anything is posted, once: a send that
/// has ever been held carries on. True when the send now waits on this hold.
pub fn screen(d: &Deps<'_>, send_id: &str) -> Result<bool, Refusal> {
    let id = uuid()?;
    in_tx(d.store, |tx| {
        let moved = tx
            .query(
                "UPDATE bank.global_sends SET status = 'held', updated_at = now() \
                 WHERE id = $1::text::uuid AND status = 'submitted' AND ledger_tx_id IS NULL \
                 AND NOT EXISTS (SELECT 1 FROM bank.global_send_holds WHERE send_id = $1::text::uuid) RETURNING id",
                &[&send_id],
            )
            .map_err(|e| pg(&e))?;
        if moved.is_empty() {
            return Ok(false);
        }
        let key = format!("screening:{send_id}");
        tx.execute(
            "INSERT INTO bank.global_send_holds (id, send_id, hold_key, reason, placed_by, state, info_request) \
             VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5, 'requested', NULL)",
            &[&id, &send_id, &key, &SCREENING_REASON, &SCREENING_OPERATOR],
        )
        .map_err(|e| pg(&e))?;
        Ok(true)
    })
}

/// `requestInfo`: writes (or rewrites) what the customer is asked for, while the hold is open.
pub fn request_info(d: &Deps<'_>, send_id: &str, info_request: &str) -> Result<Json, Refusal> {
    let info_request = require_text(info_request, 1000)?;
    let rows = with(d.store, |c| {
        c.query(
            &format!(
                "UPDATE bank.global_send_holds SET info_request = $2, updated_at = now() \
                 WHERE send_id = $1::text::uuid AND state IN ('requested', 'under_review') RETURNING {}",
                cols("")
            ),
            &[&send_id, &info_request],
        )
        .map_err(|e| pg(&e))?
        .iter()
        .map(HoldRow::from_row)
        .collect::<Result<Vec<_>, _>>()
    })?;
    rows.first()
        .map(HoldRow::view)
        .ok_or_else(|| refuse("bank.hold_not_found"))
}

/// `queue`: open holds, newest first, each with its send as the operator reads it.
pub fn queue(d: &Deps<'_>, limit: Option<i64>) -> Result<Json, Refusal> {
    let limit = limit.ok_or_else(|| refuse("bank.global_list_limit_unset"))?;
    expire_overdue(d, Scope::default())?;
    let rows = with(d.store, |c| {
        holds_where(
            c,
            "state IN ('requested', 'under_review') ORDER BY created_at DESC, id DESC LIMIT $1",
            &[&limit],
        )
    })?;
    let mut out = Vec::new();
    for row in &rows {
        let mut v = row.fields();
        v.push((
            "send".to_owned(),
            send::ops_get(d, &row.send_id)?.ops_view(),
        ));
        out.push(Json::Object(v));
    }
    Ok(Json::Array(out))
}

/// `forCustomer`: the customer's own view of the hold on their send: no reason, no operator, no screening detail.
pub fn for_customer(d: &Deps<'_>, user_id: &str, send_id: &str) -> Result<Json, Refusal> {
    send::get(d, user_id, send_id)?;
    expire_overdue(
        d,
        Scope {
            user_id: None,
            send_id: Some(send_id),
        },
    )?;
    let row = with(d.store, |c| {
        holds_where(
            c,
            "send_id = $1::text::uuid ORDER BY created_at DESC LIMIT 1",
            &[&send_id],
        )
    })?
    .into_iter()
    .next()
    .ok_or_else(|| refuse("bank.hold_not_found"))?;
    let limits = rules::proof_limits(d.w.settings.proof_limits.as_deref());
    let mut auto = rule_fields(auto_cancel_hours(d));
    auto.push((
        "at".to_owned(),
        cancels_at(d, &row).map_or(Json::Null, |t| Json::str(t.iso())),
    ));
    Ok(Json::Object(vec![
        ("state".to_owned(), Json::str(row.state.clone())),
        (
            "infoRequest".to_owned(),
            row.info_request.clone().map_or(Json::Null, Json::String),
        ),
        (
            "proofUploaded".to_owned(),
            Json::Bool(row.proof_sha256.is_some()),
        ),
        (
            "proofLimits".to_owned(),
            limits.map_or(Json::Null, |l| {
                Json::Object(vec![
                    (
                        "allowedTypes".to_owned(),
                        Json::Array(
                            l.allowed_types
                                .iter()
                                .map(|t| Json::str(t.clone()))
                                .collect(),
                        ),
                    ),
                    ("maxBytes".to_owned(), Json::int(l.max_bytes)),
                ])
            }),
        ),
        ("autoCancel".to_owned(), Json::Object(auto)),
    ]))
}

/// What `global.hold.uploadProof` asks for.
pub struct ProofAsk<'a> {
    pub user_id: &'a str,
    pub send_id: &'a str,
    pub name: &'a str,
    pub kind: &'a str,
    pub content_base64: &'a str,
}

/// `/^[A-Za-z0-9+/]+={0,2}$/` and a length that is a multiple of four.
fn proof_shape(b64: &str) -> bool {
    let body = b64.trim_end_matches('=');
    let pad = b64.len() - body.len();
    pad <= 2
        && !body.is_empty()
        && body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
        && b64.len().is_multiple_of(4)
}

/// `uploadProof`: one file, by hash: the same file again is the same answer, a different one is refused.
pub fn upload_proof(d: &Deps<'_>, i: &ProofAsk<'_>) -> Result<Json, Refusal> {
    let limits = rules::proof_limits(d.w.settings.proof_limits.as_deref())
        .ok_or_else(|| refuse("bank.proof_limits_unset"))?;
    send::get(d, i.user_id, i.send_id)?;
    let name = require_text(i.name, 200)?;
    let kind = js_trim(i.kind).to_lowercase();
    if !limits.allowed_types.contains(&kind) {
        return Err(refuse("bank.proof_type_not_allowed"));
    }
    if !proof_shape(i.content_base64) {
        return Err(refuse("bank.proof_invalid"));
    }
    let bytes = node_base64(i.content_base64);
    if bytes.is_empty() {
        return Err(refuse("bank.proof_invalid"));
    }
    let size = i64::try_from(bytes.len()).unwrap_or(i64::MAX);
    if size > limits.max_bytes {
        return Err(refuse("bank.proof_too_large"));
    }
    let sha = hex(&Sha256::digest(&bytes));
    let hold = open_hold(d, i.send_id)?
        .filter(|h| h.info_request.is_some())
        .ok_or_else(|| refuse("bank.proof_not_requested"))?;
    if let Some(prior) = &hold.proof_sha256
        && !prior.is_empty()
    {
        if *prior == sha {
            return for_customer(d, i.user_id, i.send_id);
        }
        return Err(refuse("bank.proof_already_uploaded"));
    }
    let size32 = i32::try_from(size).map_err(|_| refuse("bank.proof_too_large"))?;
    let moved = with(d.store, |c| {
        c.query(
            "UPDATE bank.global_send_holds SET proof_name = $2, proof_type = $3, proof_size = $4, proof_sha256 = $5, \
             proof_bytes = $6, proof_uploaded_at = now(), state = 'under_review', updated_at = now() \
             WHERE id = $1::text::uuid AND state = 'requested' AND proof_sha256 IS NULL RETURNING id",
            &[&hold.id, &name, &kind, &size32, &sha, &bytes],
        )
        .map_err(|e| pg(&e))
    })?;
    if moved.is_empty() {
        let again: Option<String> = with(d.store, |c| {
            c.query(
                "SELECT proof_sha256 FROM bank.global_send_holds WHERE id = $1::text::uuid",
                &[&hold.id],
            )
            .map_err(|e| pg(&e))?
            .first()
            .map(|r| r.try_get::<_, Option<String>>(0).map_err(|e| pg(&e)))
            .transpose()
            .map(Option::flatten)
        })?;
        if again.as_deref() == Some(sha.as_str()) {
            return for_customer(d, i.user_id, i.send_id);
        }
        return Err(refuse("bank.proof_already_uploaded"));
    }
    for_customer(d, i.user_id, i.send_id)
}

/// `proofFor`: the stored document, for an operator who has to read it.
pub fn proof_for(d: &Deps<'_>, send_id: &str) -> Result<Json, Refusal> {
    let row = with(d.store, |c| {
        c.query(
            "SELECT proof_name, proof_type, proof_bytes FROM bank.global_send_holds \
             WHERE send_id = $1::text::uuid AND proof_bytes IS NOT NULL ORDER BY created_at DESC LIMIT 1",
            &[&send_id],
        )
        .map_err(|e| pg(&e))?
        .first()
        .map(|r| -> Result<(String, String, Vec<u8>), Refusal> {
            Ok((
                r.try_get::<_, Option<String>>(0).map_err(|e| pg(&e))?.unwrap_or_default(),
                r.try_get::<_, Option<String>>(1).map_err(|e| pg(&e))?.unwrap_or_default(),
                r.try_get::<_, Vec<u8>>(2).map_err(|e| pg(&e))?,
            ))
        })
        .transpose()
    })?
    .ok_or_else(|| refuse("bank.hold_not_found"))?;
    Ok(Json::Object(vec![
        ("name".to_owned(), Json::str(row.0)),
        ("type".to_owned(), Json::str(row.1)),
        (
            "contentBase64".to_owned(),
            Json::str(base64::engine::general_purpose::STANDARD.encode(row.2)),
        ),
    ]))
}

/// `close`: the hold released by this operator, and its send back to `submitted`.
fn close(d: &Deps<'_>, hold: &HoldRow, operator_id: &str) -> Result<(), Refusal> {
    in_tx(d.store, |tx| {
        let closed = tx
            .query(
                "UPDATE bank.global_send_holds SET state = 'released', released_by = $2, released_at = now(), updated_at = now() \
                 WHERE id = $1::text::uuid AND state IN ('requested', 'under_review') RETURNING id",
                &[&hold.id, &operator_id],
            )
            .map_err(|e| pg(&e))?;
        if closed.is_empty() {
            return Err(refuse("bank.hold_not_found"));
        }
        tx.execute(
            "UPDATE bank.global_sends SET status = 'submitted', updated_at = now() WHERE id = $1::text::uuid AND status = 'held'",
            &[&hold.send_id],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })
}

/// `putBack`: release left the outcome unknown. If nothing was posted the hold goes back on; if value moved the send
/// is retried instead.
fn put_back(d: &Deps<'_>, hold: &HoldRow) -> Result<(), Refusal> {
    in_tx(d.store, |tx| {
        let back = tx
            .query(
                "UPDATE bank.global_sends SET status = 'held', updated_at = now() \
                 WHERE id = $1::text::uuid AND status = 'submitted' AND ledger_tx_id IS NULL RETURNING id",
                &[&hold.send_id],
            )
            .map_err(|e| pg(&e))?;
        if back.is_empty() {
            return Ok(());
        }
        tx.execute(
            "UPDATE bank.global_send_holds SET state = $2, released_by = NULL, released_at = NULL, updated_at = now() \
             WHERE id = $1::text::uuid",
            &[&hold.id, &hold.state],
        )
        .map_err(|e| pg(&e))?;
        Ok(())
    })
}

/// Resumes a send after its hold closed; an unknown outcome puts the hold back on.
fn resume_after(d: &Deps<'_>, hold: &HoldRow) -> Result<Json, Refusal> {
    match send::resume(d, &hold.send_id) {
        Ok(v) => Ok(v),
        Err(e) => {
            if code_of(&e) == Some("bank.global_outcome_unknown") {
                put_back(d, hold)?;
            }
            Err(e)
        }
    }
}

/// `release`: lets a held send carry on. The person who held it cannot release it.
pub fn release(d: &Deps<'_>, send_id: &str, operator_id: &str) -> Result<Json, Refusal> {
    let operator_id = require_text(operator_id, 128)?;
    if expire_overdue(
        d,
        Scope {
            user_id: None,
            send_id: Some(send_id),
        },
    )? > 0
    {
        return Err(refuse("bank.global_send_cancelled"));
    }
    let hold = must_open(d, send_id)?;
    if hold.placed_by == operator_id {
        return Err(refuse("bank.release_same_operator"));
    }
    close(d, &hold, &operator_id)?;
    resume_after(d, &hold)
}

/// `linkReference`: links an incoming payment's reference to a send. If the send is held, the link releases it.
pub fn link_reference(
    d: &Deps<'_>,
    send_id: &str,
    operator_id: &str,
    reference: &str,
) -> Result<Json, Refusal> {
    let operator_id = require_text(operator_id, 128)?;
    let reference = require_text(reference, 64)?.to_uppercase();
    if units(&reference) < 6 {
        return Err(refuse("bank.personal_pay_request_invalid"));
    }
    send::ops_get(d, send_id)?;
    if expire_overdue(
        d,
        Scope {
            user_id: None,
            send_id: Some(send_id),
        },
    )? > 0
    {
        return Err(refuse("bank.global_send_cancelled"));
    }
    let hold = open_hold(d, send_id)?;
    if hold.as_ref().is_some_and(|h| h.placed_by == operator_id) {
        return Err(refuse("bank.release_same_operator"));
    }
    let id = uuid()?;
    let inserted = with(d.store, |c| {
        c.query(
            "INSERT INTO bank.global_incoming_links (id, reference, send_id, linked_by) \
             VALUES ($1::text::uuid, $2, $3::text::uuid, $4) ON CONFLICT (reference) DO NOTHING RETURNING id",
            &[&id, &reference, &send_id, &operator_id],
        )
        .map_err(|e| pg(&e))
    })?;
    if inserted.is_empty() {
        let existing: Option<String> = with(d.store, |c| {
            c.query(
                "SELECT send_id::text FROM bank.global_incoming_links WHERE reference = $1",
                &[&reference],
            )
            .map_err(|e| pg(&e))?
            .first()
            .map(|r| r.try_get::<_, String>(0).map_err(|e| pg(&e)))
            .transpose()
        })?;
        if existing.as_deref() != Some(send_id) {
            return Err(refuse("bank.link_reference_conflict"));
        }
    }
    let linked = |send: Json| {
        Json::Object(vec![
            ("linked".to_owned(), Json::Bool(true)),
            ("send".to_owned(), send),
        ])
    };
    let Some(hold) = hold else {
        return Ok(linked(send::ops_get(d, send_id)?.view()));
    };
    close(d, &hold, &operator_id)?;
    Ok(linked(resume_after(d, &hold)?))
}

/// `global.get` as the router runs it: read, apply the window, read again.
pub fn get_send(d: &Deps<'_>, user_id: &str, id: &str) -> Result<SendRow, Refusal> {
    send::get(d, user_id, id)?;
    expire_overdue(
        d,
        Scope {
            user_id: None,
            send_id: Some(id),
        },
    )?;
    send::get(d, user_id, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_is_whole_hours_of_one_or_more() {
        assert_eq!(read_hold_cancel_hours(Some(" 48 ")), Some(48));
        assert_eq!(read_hold_cancel_hours(Some("0")), None);
        assert_eq!(read_hold_cancel_hours(Some("1.5")), None);
        assert_eq!(read_hold_cancel_hours(Some("1234567")), None);
        assert_eq!(read_hold_cancel_hours(None), None);
    }

    #[test]
    fn a_proof_is_padded_standard_base64() {
        assert!(proof_shape("AAAA"));
        assert!(proof_shape("AB=="));
        assert!(!proof_shape("A==="));
        assert!(!proof_shape("AAA"));
        assert!(!proof_shape("AA-_"));
        assert!(!proof_shape("===="));
        assert!(!proof_shape(""));
    }
}
