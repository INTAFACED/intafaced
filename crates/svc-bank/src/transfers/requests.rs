//! Payment requests (`transfers/personal-pay.ts`'s request half, `transfers/personal-request.router.ts`): one person asks
//! another to pay; the payer settles it with a send (`personal`), which claims the request inside the send's
//! reservation and marks it paid once the money posted. Reminders follow the owner's rule
//! (`BANK_REQUEST_REMIND_POLICY_JSON`); a report closes the request and may block the asker.

use postgres::{GenericClient, Row};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::time::{Instant, js_date};

use super::Deps;
use super::notices::{RequestCreated, RequestPaid};
use super::ports::HandleUnavailable;
use crate::door::Ctx;
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{at, in_tx, pg, with};

const NOTE_MAX: usize = 140;
const REFERENCE_MAX: usize = 64;

/// `plainNote`: trimmed plain text up to 140 characters, or none.
pub fn plain_note(value: Option<&str>) -> Result<Option<String>, Refusal> {
    let Some(v) = value else { return Ok(None) };
    let note = v.trim();
    if note.is_empty() {
        return Ok(None);
    }
    if note.chars().count() > NOTE_MAX || note.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}') {
        return Err(refuse(
            "bank.personal_note_invalid",
            format!(
                "A payment note is plain text up to {NOTE_MAX} characters (bank.personal_note_invalid)"
            ),
        ));
    }
    Ok(Some(note.to_owned()))
}

/// `plainReference`: trimmed printable ASCII up to 64 characters, or none.
pub fn plain_reference(value: Option<&str>) -> Result<Option<String>, Refusal> {
    let Some(v) = value else { return Ok(None) };
    let reference = v.trim();
    if reference.is_empty() {
        return Ok(None);
    }
    if reference.encode_utf16().count() > REFERENCE_MAX
        || !reference.bytes().all(|b| (0x20..=0x7e).contains(&b))
    {
        return Err(refuse(
            "bank.personal_reference_invalid",
            format!(
                "A payment reference is printable text up to {REFERENCE_MAX} characters (bank.personal_reference_invalid)"
            ),
        ));
    }
    Ok(Some(reference.to_owned()))
}

/// `RemindPolicy`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RemindPolicy {
    pub cap: i64,
    pub window_seconds: i64,
}

/// `parseRemindPolicy`: `{"cap":<1-100>,"windowSeconds":<60-7776000>}`, else none.
pub fn parse_remind_policy(raw: Option<&str>) -> Option<RemindPolicy> {
    let raw = raw.filter(|r| !r.trim().is_empty())?;
    let Ok(Json::Object(fields)) = json::parse(raw) else {
        return None;
    };
    if fields.len() != 2 {
        return None;
    }
    let int = |k: &str| match fields.iter().find(|(n, _)| n == k) {
        Some((_, Json::Number(n))) if n.fract() == 0.0 => Some(*n as i64),
        _ => None,
    };
    let cap = int("cap").filter(|c| (1..=100).contains(c))?;
    let window_seconds = int("windowSeconds").filter(|w| (60..=90 * 86_400).contains(w))?;
    Some(RemindPolicy {
        cap,
        window_seconds,
    })
}

/// `REQUEST_COLS`, in [`RequestRow::from_row`]'s order.
const COLS: &str = "id::text, idempotency_key, payee_user_id, payer_user_id, asset_id, amount::text, note, \
     floor(extract(epoch from expires_at) * 1000)::int8, status, claim_transfer_id, ledger_tx_id, payee_handle, \
     payer_handle, notice_blocker, floor(extract(epoch from created_at) * 1000)::int8";

/// `RequestRow`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestRow {
    pub id: String,
    pub idempotency_key: String,
    pub payee_user_id: String,
    pub payer_user_id: String,
    pub asset_id: String,
    pub amount: Amount,
    pub note: Option<String>,
    pub expires_at: Instant,
    pub status: String,
    pub claim_transfer_id: Option<String>,
    pub ledger_tx_id: Option<String>,
    pub payee_handle: Option<String>,
    pub payer_handle: Option<String>,
    pub notice_blocker: Option<String>,
    pub created_at: Instant,
}

impl RequestRow {
    fn from_row(r: &Row) -> Result<RequestRow, Refusal> {
        let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
        let o = |i: usize| r.try_get::<_, Option<String>>(i).map_err(|e| pg(&e));
        let t = |i: usize| r.try_get::<_, i64>(i).map(Instant).map_err(|e| pg(&e));
        Ok(RequestRow {
            id: s(0)?,
            idempotency_key: s(1)?,
            payee_user_id: s(2)?,
            payer_user_id: s(3)?,
            asset_id: s(4)?,
            amount: parse_amount(&s(5)?).map_err(Refusal::Other)?,
            note: o(6)?,
            expires_at: t(7)?,
            status: s(8)?,
            claim_transfer_id: o(9)?,
            ledger_tx_id: o(10)?,
            payee_handle: o(11)?,
            payer_handle: o(12)?,
            notice_blocker: o(13)?,
            created_at: t(14)?,
        })
    }
}

/// `effectiveStatus`: an open request past its expiry reads as expired.
pub fn effective_status(row: &RequestRow, now: Instant) -> String {
    if row.status == "open" && row.expires_at.0 <= now.0 {
        "expired".to_owned()
    } else {
        row.status.clone()
    }
}

/// A notice's outcome: delivered, or the code of why not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub delivered: bool,
    pub blocker: Option<String>,
}

impl Notice {
    fn remembered(row: &RequestRow) -> Notice {
        Notice {
            delivered: row.notice_blocker.is_none(),
            blocker: row.notice_blocker.clone(),
        }
    }
}

fn opt(s: Option<&String>) -> Json {
    s.map_or(Json::Null, |v| Json::str(v.clone()))
}

/// `toRequestView`, in `personalRequestSchema`'s key order.
fn view(row: &RequestRow, now: Instant, notice: &Notice) -> Vec<(String, Json)> {
    let f = |k: &str, v: Json| (k.to_owned(), v);
    vec![
        f("requestId", Json::str(row.id.clone())),
        f("payeeUserId", Json::str(row.payee_user_id.clone())),
        f("payerUserId", Json::str(row.payer_user_id.clone())),
        f("payeeHandle", opt(row.payee_handle.as_ref())),
        f("payerHandle", opt(row.payer_handle.as_ref())),
        f("assetId", Json::str(row.asset_id.clone())),
        f("amount", Json::str(format_amount(row.amount))),
        f("note", opt(row.note.as_ref())),
        f("expiresAt", Json::str(row.expires_at.iso())),
        f("status", Json::str(effective_status(row, now))),
        f("ledgerTxId", opt(row.ledger_tx_id.as_ref())),
        f("createdAt", Json::str(row.created_at.iso())),
        f(
            "notice",
            Json::obj([
                ("delivered", Json::Bool(notice.delivered)),
                ("blocker", opt(notice.blocker.as_ref())),
            ]),
        ),
    ]
}

fn not_found(id: &str) -> Refusal {
    refuse(
        "bank.personal_request_not_found",
        format!("Request {id} not found (bank.personal_request_not_found)"),
    )
}

fn claim_held(id: &str) -> Refusal {
    refuse(
        "bank.personal_request_claim_held",
        format!("Request {id} has a payment in flight (bank.personal_request_claim_held)"),
    )
}

/// `throwClosed`.
fn closed(status: &str) -> Refusal {
    if status == "expired" {
        return refuse(
            "bank.personal_request_expired",
            "The request has expired (bank.personal_request_expired)",
        );
    }
    refuse(
        "bank.personal_request_closed",
        format!("The request is {status} (bank.personal_request_closed)"),
    )
}

fn by_id(c: &mut impl GenericClient, id: &str) -> Result<Option<RequestRow>, Refusal> {
    // A request id that is no uuid names no request, as the TypeScript's query finds none.
    if !service_kit::tokens::is_guid(id) {
        return Ok(None);
    }
    let rows = c
        .query(
            &format!("SELECT {COLS} FROM bank.personal_requests WHERE id = $1::text::uuid"),
            &[&id],
        )
        .map_err(|e| pg(&e))?;
    rows.first().map(RequestRow::from_row).transpose()
}

/// `mustRequest`.
fn must(c: &mut impl GenericClient, id: &str) -> Result<RequestRow, Refusal> {
    by_id(c, id)?.ok_or_else(|| not_found(id))
}

fn by_key(
    c: &mut impl GenericClient,
    payee: &str,
    key: &str,
) -> Result<Option<RequestRow>, Refusal> {
    let rows = c
        .query(
            &format!(
                "SELECT {COLS} FROM bank.personal_requests WHERE payee_user_id = $1 AND idempotency_key = $2"
            ),
            &[&payee, &key],
        )
        .map_err(|e| pg(&e))?;
    rows.first().map(RequestRow::from_row).transpose()
}

/// `assertParty`.
fn assert_party(row: &RequestRow, actor: &str, payee: bool) -> Result<(), Refusal> {
    let owner = if payee {
        &row.payee_user_id
    } else {
        &row.payer_user_id
    };
    if owner == actor {
        return Ok(());
    }
    if row.payee_user_id != actor && row.payer_user_id != actor {
        return Err(not_found(&row.id));
    }
    let (party, code) = if payee {
        ("payee", "bank.personal_request_not_payee")
    } else {
        ("payer", "bank.personal_request_not_payer")
    };
    Err(refuse(
        code,
        format!("That action belongs to the {party} ({code})"),
    ))
}

/// `remindPolicy`.
fn remind_policy(d: &Deps<'_>) -> Result<RemindPolicy, Refusal> {
    parse_remind_policy(d.w.settings.remind_policy.as_deref()).ok_or_else(|| {
        refuse(
            "bank.reminder_policy_unset",
            "No reminder rule is published, so no reminder can be sent (bank.reminder_policy_unset)",
        )
    })
}

/// `assertNotBlocked`.
fn assert_not_blocked(d: &Deps<'_>, payer: &str, asker: &str) -> Result<(), Refusal> {
    let blocked = with(d.store, |c| {
        c.query(
            "SELECT key FROM bank.personal_request_blocks WHERE user_id = $1 AND blocked_user_id = $2",
            &[&payer, &asker],
        )
        .map_err(|e| pg(&e))
    })?;
    if blocked.is_empty() {
        return Ok(());
    }
    Err(refuse(
        "bank.personal_request_unavailable",
        "This person cannot be asked for money (bank.personal_request_unavailable)",
    ))
}

/// `requireHandles`: both people's handles, or why the request cannot name them.
fn require_handles(d: &Deps<'_>, payee: &str, payer: &str) -> Result<(String, String), Refusal> {
    let Some(port) = d.w.handles.as_deref() else {
        return Err(refuse(
            "bank.party_handles_unset",
            "IDENTITY_URL is unset, so a request cannot name either person (bank.party_handles_unset)",
        ));
    };
    let unavailable = |_: HandleUnavailable| {
        refuse(
            "bank.party_handles_unavailable",
            "Identity did not answer a handle lookup; the request was not created (bank.party_handles_unavailable)",
        )
    };
    let payee_handle = port.handle_of(payee).map_err(unavailable)?;
    let payer_handle = port.handle_of(payer).map_err(unavailable)?;
    let Some(payee_handle) = payee_handle else {
        return Err(refuse(
            "bank.recipient_cannot_receive",
            "This recipient cannot receive payments",
        ));
    };
    let Some(payer_handle) = payer_handle else {
        return Err(refuse(
            "bank.personal_request_payer_unknown",
            "No such person to ask (bank.personal_request_payer_unknown)",
        ));
    };
    Ok((payee_handle, payer_handle))
}

/// `findPrimary`: the person's open main space in the asset, if any.
fn has_primary(d: &Deps<'_>, user_id: &str, asset_id: &str) -> Result<bool, Refusal> {
    let id = user_id.trim();
    if id.is_empty() {
        return Ok(false);
    }
    let rows = with(d.store, |c| {
        c.query(
            "SELECT 1 FROM bank.spaces WHERE user_id = $1 AND asset_id = $2 AND kind = 'primary' AND archived_at IS NULL",
            &[&id, &asset_id],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(!rows.is_empty())
}

/// `rememberNotice`.
fn remember_notice(d: &Deps<'_>, id: &str, blocker: Option<&str>) -> Result<(), Refusal> {
    with(d.store, |c| {
        c.execute(
            "UPDATE bank.personal_requests SET notice_blocker = $2 WHERE id = $1::text::uuid",
            &[&id, &blocker],
        )
        .map_err(|e| pg(&e))
    })?;
    Ok(())
}

/// `noticeBlocker`: every publish failure here is the bus's, never a `BankError`.
const NOTIFY_FAILED: &str = "bank.pay_request_notify_failed";

/// `publishCreated`.
fn publish_created(d: &Deps<'_>, row: &RequestRow, sequence: i64) -> Result<Notice, Refusal> {
    let Some(handle) = row.payee_handle.clone() else {
        remember_notice(d, &row.id, Some("bank.party_handles_unset"))?;
        return Ok(Notice {
            delivered: false,
            blocker: Some("bank.party_handles_unset".to_owned()),
        });
    };
    let sent = d.notices().request_created(&RequestCreated {
        request_id: row.id.clone(),
        payer_user_id: row.payer_user_id.clone(),
        payee_handle: handle,
        amount: format_amount(row.amount),
        asset_id: row.asset_id.clone(),
        note: row.note.clone(),
        expires_at: row.expires_at.iso(),
        sequence,
    });
    if sent.is_ok() {
        remember_notice(d, &row.id, None)?;
        return Ok(Notice {
            delivered: true,
            blocker: None,
        });
    }
    remember_notice(d, &row.id, Some(NOTIFY_FAILED))?;
    Ok(Notice {
        delivered: false,
        blocker: Some(NOTIFY_FAILED.to_owned()),
    })
}

/// What `createRequest` is given.
pub struct NewRequest<'a> {
    pub payee_user_id: &'a str,
    pub payer_user_id: &'a str,
    pub asset_id: &'a str,
    pub amount: Amount,
    pub note: Option<&'a str>,
    pub expires_at: Instant,
    pub idempotency_key: &'a str,
}

/// `sameRequest`.
fn same_request(row: &RequestRow, ask: &NewRequest<'_>, note: Option<&str>) -> bool {
    row.payer_user_id == ask.payer_user_id
        && row.asset_id == ask.asset_id
        && row.amount == ask.amount
        && row.note.as_deref() == note
        && row.expires_at == ask.expires_at
}

fn request_conflict(key: &str) -> Refusal {
    refuse(
        "bank.personal_request_conflict",
        format!(
            "Request key {key} was already used on different terms (bank.personal_request_conflict)"
        ),
    )
}

/// `createRequest`.
pub fn create(d: &Deps<'_>, ask: &NewRequest<'_>) -> Result<Json, Refusal> {
    let now = d.now;
    let note = plain_note(ask.note)?;
    if ask.payee_user_id == ask.payer_user_id {
        return Err(refuse(
            "bank.personal_request_self",
            "You cannot request money from yourself (bank.personal_request_self)",
        ));
    }
    if ask.expires_at.0 <= now.0 {
        return Err(refuse(
            "bank.personal_request_expired",
            "A request needs an expiry in the future (bank.personal_request_expired)",
        ));
    }
    let prior = with(d.store, |c| {
        by_key(c, ask.payee_user_id, ask.idempotency_key)
    })?;
    if let Some(prior) = prior {
        if !same_request(&prior, ask, note.as_deref()) {
            return Err(request_conflict(ask.idempotency_key));
        }
        return Ok(Json::Object(view(&prior, now, &Notice::remembered(&prior))));
    }
    if !has_primary(d, ask.payee_user_id, ask.asset_id)? {
        return Err(refuse(
            "bank.recipient_cannot_receive",
            "This recipient cannot receive payments",
        ));
    }
    assert_not_blocked(d, ask.payer_user_id, ask.payee_user_id)?;
    let (payee_handle, payer_handle) = require_handles(d, ask.payee_user_id, ask.payer_user_id)?;
    let amount = format_amount(ask.amount);
    let inserted = with(d.store, |c| {
        c.query(
            &format!(
                "INSERT INTO bank.personal_requests (idempotency_key, payee_user_id, payer_user_id, asset_id, amount, \
                 note, expires_at, status, payee_handle, payer_handle) \
                 VALUES ($1, $2, $3, $4, $5::text::numeric, $6, {}, 'open', $8, $9) \
                 ON CONFLICT (payee_user_id, idempotency_key) DO NOTHING RETURNING {COLS}",
                at("$7")
            ),
            &[
                &ask.idempotency_key,
                &ask.payee_user_id,
                &ask.payer_user_id,
                &ask.asset_id,
                &amount,
                &note,
                &ask.expires_at.0,
                &payee_handle,
                &payer_handle,
            ],
        )
        .map_err(|e| pg(&e))
    })?;
    let fresh = inserted.first().map(RequestRow::from_row).transpose()?;
    let row = match &fresh {
        Some(r) => r.clone(),
        None => with(d.store, |c| {
            by_key(c, ask.payee_user_id, ask.idempotency_key)
        })?
        .ok_or_else(|| {
            refuse(
                "bank.personal_request_not_found",
                "Request disappeared after insert",
            )
        })?,
    };
    if !same_request(&row, ask, note.as_deref()) {
        return Err(request_conflict(ask.idempotency_key));
    }
    let notice = if fresh.is_some() {
        publish_created(d, &row, 1)?
    } else {
        Notice::remembered(&row)
    };
    Ok(Json::Object(view(&row, now, &notice)))
}

/// `listLimit`.
fn list_limit(limit: Option<f64>) -> Result<i64, Refusal> {
    match limit {
        Some(l) if l.fract() == 0.0 && (1.0..=100.0).contains(&l) => Ok(l as i64),
        _ => Err(refuse(
            "bank.personal_request_list_limit_unset",
            "personalRequest.list needs a limit from 1 to 100 (bank.personal_request_list_limit_unset)",
        )),
    }
}

/// `listRequests`.
pub fn list(
    d: &Deps<'_>,
    actor: &str,
    incoming: bool,
    status: Option<&str>,
    limit: Option<f64>,
) -> Result<Json, Refusal> {
    let limit = list_limit(limit)?;
    let now = d.now;
    let party = if incoming {
        "payer_user_id = $1"
    } else {
        "payee_user_id = $1"
    };
    let ts = at("$2");
    let clause = match status {
        None => "TRUE".to_owned(),
        Some("expired") => format!("status = 'open' AND expires_at <= {ts}"),
        Some("open") => format!("status = 'open' AND expires_at > {ts}"),
        Some(_) => "status = $3".to_owned(),
    };
    // Every parameter is named in the text, so Postgres types each one.
    let sql = format!(
        "SELECT {COLS} FROM bank.personal_requests WHERE {party} AND {clause} \
         AND $2::int8 IS NOT NULL AND $3::text IS NOT DISTINCT FROM $3::text \
         ORDER BY created_at DESC LIMIT $4"
    );
    let st = status.unwrap_or_default().to_owned();
    let rows = with(d.store, |c| {
        c.query(&sql, &[&actor, &now.0, &st, &limit])
            .map_err(|e| pg(&e))
    })?;
    let mut out = Vec::new();
    for r in &rows {
        let row = RequestRow::from_row(r)?;
        out.push(Json::Object(view(&row, now, &Notice::remembered(&row))));
    }
    Ok(Json::Array(out))
}

/// `getRequest`.
pub fn get(d: &Deps<'_>, actor: &str, id: &str) -> Result<Json, Refusal> {
    let row = with(d.store, |c| must(c, id))?;
    if row.payee_user_id != actor && row.payer_user_id != actor {
        return Err(not_found(id));
    }
    Ok(Json::Object(view(&row, d.now, &Notice::remembered(&row))))
}

/// `closeRequest`: the payee cancels, the payer declines.
pub fn close(
    d: &Deps<'_>,
    actor: &str,
    id: &str,
    payee: bool,
) -> Result<Vec<(String, Json)>, Refusal> {
    let now = d.now;
    let next = if payee { "cancelled" } else { "declined" };
    let row = with(d.store, |c| must(c, id))?;
    assert_party(&row, actor, payee)?;
    if row.status == next {
        return Ok(view(&row, now, &Notice::remembered(&row)));
    }
    let status = effective_status(&row, now);
    if status != "open" {
        return Err(closed(&status));
    }
    if row.claim_transfer_id.is_some() {
        return Err(claim_held(id));
    }
    let updated = with(d.store, |c| {
        c.query(
            &format!(
                "UPDATE bank.personal_requests SET status = $2, updated_at = {ts} \
                 WHERE id = $1::text::uuid AND status = 'open' AND expires_at > {ts} AND claim_transfer_id IS NULL \
                 RETURNING {COLS}",
                ts = at("$3")
            ),
            &[&id, &next, &now.0],
        )
        .map_err(|e| pg(&e))
    })?;
    let saved = match updated.first() {
        Some(r) => RequestRow::from_row(r)?,
        None => with(d.store, |c| must(c, id))?,
    };
    if saved.status != next {
        return Err(closed(&effective_status(&saved, now)));
    }
    Ok(view(&saved, now, &Notice::remembered(&saved)))
}

/// `ReminderFacts`, in `personalRequestReminderSchema`'s key order.
fn reminder_facts(
    c: &mut impl GenericClient,
    id: &str,
    policy: RemindPolicy,
    now: Instant,
) -> Result<(i64, Json), Refusal> {
    let window_start = now.0 - policy.window_seconds * 1000;
    let rows = c
        .query(
            &format!(
                "SELECT floor(extract(epoch from created_at) * 1000)::int8 FROM bank.personal_request_reminds \
                 WHERE request_id = $1::text::uuid AND created_at > {} ORDER BY created_at ASC",
                at("$2")
            ),
            &[&id, &window_start],
        )
        .map_err(|e| pg(&e))?;
    let recent: Vec<i64> = rows
        .iter()
        .map(|r| r.try_get::<_, i64>(0).map_err(|e| pg(&e)))
        .collect::<Result<_, _>>()?;
    let n = i64::try_from(recent.len()).unwrap_or(i64::MAX);
    let next = if n >= policy.cap {
        usize::try_from(n - policy.cap)
            .ok()
            .and_then(|i| recent.get(i))
            .map(|t| Json::str(Instant(t + policy.window_seconds * 1000).iso()))
    } else {
        None
    };
    let blocked = next.is_some();
    Ok((
        i64::from(blocked),
        Json::obj([
            ("sentInWindow", Json::int(n)),
            ("cap", Json::int(policy.cap)),
            ("windowSeconds", Json::int(policy.window_seconds)),
            ("nextAllowedAt", next.unwrap_or(Json::Null)),
        ]),
    ))
}

/// `remindRequest`.
pub fn remind(d: &Deps<'_>, actor: &str, id: &str, key: &str) -> Result<Json, Refusal> {
    let now = d.now;
    let row = with(d.store, |c| must(c, id))?;
    assert_party(&row, actor, true)?;
    let status = effective_status(&row, now);
    if status != "open" {
        return Err(closed(&status));
    }
    if row.claim_transfer_id.is_some() {
        return Err(claim_held(id));
    }
    let policy = remind_policy(d)?;
    assert_not_blocked(d, &row.payer_user_id, &row.payee_user_id)?;
    let (sequence, published) = in_tx(d.store, |tx| {
        tx.query(
            "SELECT id FROM bank.personal_requests WHERE id = $1::text::uuid FOR UPDATE",
            &[&id],
        )
        .map_err(|e| pg(&e))?;
        let prior = tx
            .query(
                "SELECT sequence, published_at IS NOT NULL FROM bank.personal_request_reminds \
                 WHERE request_id = $1::text::uuid AND idempotency_key = $2",
                &[&id, &key],
            )
            .map_err(|e| pg(&e))?;
        if let Some(p) = prior.first() {
            return Ok((
                p.try_get::<_, i32>(0).map_err(|e| pg(&e))?,
                p.try_get::<_, bool>(1).map_err(|e| pg(&e))?,
            ));
        }
        let (capped, facts) = reminder_facts(tx, id, policy, now)?;
        if capped == 1 {
            let next = match facts.get("nextAllowedAt") {
                Some(Json::String(s)) => s.clone(),
                _ => String::new(),
            };
            return Err(refuse(
                "bank.personal_request_remind_capped",
                format!(
                    "{} reminder{} already went out in this window; the next is allowed at {next} (bank.personal_request_remind_capped)",
                    policy.cap,
                    if policy.cap == 1 { "" } else { "s" }
                ),
            ));
        }
        let next = tx
            .query_one(
                "SELECT (COALESCE(MAX(sequence), 1) + 1)::int4 FROM bank.personal_request_reminds \
                 WHERE request_id = $1::text::uuid",
                &[&id],
            )
            .map_err(|e| pg(&e))?;
        let sequence: i32 = next.try_get(0).map_err(|e| pg(&e))?;
        let inserted = tx
            .query(
                &format!(
                    "INSERT INTO bank.personal_request_reminds (request_id, idempotency_key, sequence, created_at) \
                     VALUES ($1::text::uuid, $2, $3, {}) ON CONFLICT (request_id, idempotency_key) DO NOTHING \
                     RETURNING sequence, published_at IS NOT NULL",
                    at("$4")
                ),
                &[&id, &key, &sequence, &now.0],
            )
            .map_err(|e| pg(&e))?;
        match inserted.first() {
            Some(r) => Ok((
                r.try_get::<_, i32>(0).map_err(|e| pg(&e))?,
                r.try_get::<_, bool>(1).map_err(|e| pg(&e))?,
            )),
            None => Ok((sequence, false)),
        }
    })?;
    let mut out;
    if published {
        out = view(
            &row,
            now,
            &Notice {
                delivered: true,
                blocker: None,
            },
        );
    } else {
        let notice = publish_created(d, &row, i64::from(sequence))?;
        with(d.store, |c| {
            if notice.delivered {
                c.execute(
                    &format!(
                        "UPDATE bank.personal_request_reminds SET published_at = {} \
                         WHERE request_id = $1::text::uuid AND idempotency_key = $2",
                        at("$3")
                    ),
                    &[&id, &key, &now.0],
                )
            } else {
                c.execute(
                    "DELETE FROM bank.personal_request_reminds \
                     WHERE request_id = $1::text::uuid AND idempotency_key = $2 AND published_at IS NULL",
                    &[&id, &key],
                )
            }
            .map_err(|e| pg(&e))
        })?;
        out = view(&row, now, &notice);
    }
    let (_, facts) = with(d.store, |c| reminder_facts(c, id, policy, now))?;
    out.push(("reminder".to_owned(), facts));
    Ok(Json::Object(out))
}

/// `reminders`.
pub fn reminders(d: &Deps<'_>, actor: &str, id: &str) -> Result<Json, Refusal> {
    let row = with(d.store, |c| must(c, id))?;
    assert_party(&row, actor, true)?;
    let policy = remind_policy(d)?;
    let (_, facts) = with(d.store, |c| reminder_facts(c, id, policy, d.now))?;
    Ok(facts)
}

const REPORT_REASONS: [&str; 4] = ["scam", "spam", "harassment", "other"];

/// `reportFor` and `safetyView`: the report on this request, and whether the payer blocked the asker.
fn safety_view(d: &Deps<'_>, user: &str, asker: &str, id: &str) -> Result<Option<Json>, Refusal> {
    let report = with(d.store, |c| {
        c.query(
            "SELECT id::text, reason, state, floor(extract(epoch from created_at) * 1000)::int8 \
             FROM bank.personal_request_reports WHERE request_id = $1::text::uuid",
            &[&id],
        )
        .map_err(|e| pg(&e))
    })?;
    let Some(r) = report.first() else {
        return Ok(None);
    };
    let blocks = with(d.store, |c| {
        c.query(
            "SELECT key FROM bank.personal_request_blocks WHERE user_id = $1 AND blocked_user_id = $2",
            &[&user, &asker],
        )
        .map_err(|e| pg(&e))
    })?;
    let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
    Ok(Some(Json::obj([
        ("caseId", Json::str(s(0)?)),
        ("reason", Json::str(s(1)?)),
        ("state", Json::str(s(2)?)),
        (
            "openedAt",
            Json::str(Instant(r.try_get::<_, i64>(3).map_err(|e| pg(&e))?).iso()),
        ),
        ("blocked", Json::Bool(!blocks.is_empty())),
    ])))
}

/// `reportRequest`.
pub fn report(
    d: &Deps<'_>,
    actor: &str,
    id: &str,
    reason: &str,
    block: bool,
) -> Result<Json, Refusal> {
    let now = d.now;
    let row = with(d.store, |c| must(c, id))?;
    assert_party(&row, actor, false)?;
    if !REPORT_REASONS.contains(&reason) {
        return Err(refuse(
            "bank.personal_request_report_reason",
            "A report needs one of the listed reasons (bank.personal_request_report_reason)",
        ));
    }
    let request = if effective_status(&row, now) == "open" {
        close(d, actor, id, false)?
    } else {
        view(&row, now, &Notice::remembered(&row))
    };
    let report_key = format!("report:{id}");
    let block_key = format!("block:{actor}:{}", row.payee_user_id);
    in_tx(d.store, |tx| {
        tx.execute(
            &format!(
                "INSERT INTO bank.personal_request_reports (key, request_id, reporter_user_id, reported_user_id, reason, created_at) \
                 VALUES ($1, $2::text::uuid, $3, $4, $5, {}) ON CONFLICT DO NOTHING",
                at("$6")
            ),
            &[&report_key, &id, &actor, &row.payee_user_id, &reason, &now.0],
        )
        .map_err(|e| pg(&e))?;
        if block {
            tx.execute(
                &format!(
                    "INSERT INTO bank.personal_request_blocks (key, user_id, blocked_user_id, report_id, created_at) \
                     SELECT $1, $2, $3, id, {} FROM bank.personal_request_reports WHERE request_id = $4::text::uuid \
                     ON CONFLICT DO NOTHING",
                    at("$5")
                ),
                &[&block_key, &actor, &row.payee_user_id, &id, &now.0],
            )
            .map_err(|e| pg(&e))?;
        }
        Ok(())
    })?;
    let safety = safety_view(d, actor, &row.payee_user_id, id)?.ok_or_else(|| {
        refuse(
            "bank.personal_request_not_found",
            format!("Report on request {id} disappeared after insert"),
        )
    })?;
    Ok(Json::obj([
        ("request", Json::Object(request)),
        ("safety", safety),
    ]))
}

/// `requestSafety`.
pub fn safety(d: &Deps<'_>, actor: &str, id: &str) -> Result<Json, Refusal> {
    let row = with(d.store, |c| must(c, id))?;
    if row.payer_user_id != actor {
        return Err(not_found(id));
    }
    Ok(safety_view(d, actor, &row.payee_user_id, id)?.unwrap_or(Json::Null))
}

/// What a send settling a request claims it with (`claim`'s input).
pub struct Claim<'a> {
    pub request_id: &'a str,
    pub transfer_id: &'a str,
    pub payer_user_id: &'a str,
    pub to_user_id: &'a str,
    pub asset_id: &'a str,
    pub amount: Amount,
    pub now: Instant,
}

/// `claim`: inside the send's transaction, the request is this send's, or the refusal says why not.
pub fn claim(tx: &mut impl GenericClient, c: &Claim<'_>) -> Result<(), Refusal> {
    let amount = format_amount(c.amount);
    let updated = if service_kit::tokens::is_guid(c.request_id) {
        tx.query(
            &format!(
                "UPDATE bank.personal_requests SET claim_transfer_id = $2, updated_at = {ts} \
                 WHERE id = $1::text::uuid AND payer_user_id = $3 AND payee_user_id = $4 AND asset_id = $5 \
                 AND amount = $6::text::numeric AND status = 'open' AND expires_at > {ts} \
                 AND (claim_transfer_id IS NULL OR claim_transfer_id = $2) RETURNING id::text",
                ts = at("$7")
            ),
            &[
                &c.request_id,
                &c.transfer_id,
                &c.payer_user_id,
                &c.to_user_id,
                &c.asset_id,
                &amount,
                &c.now.0,
            ],
        )
        .map_err(|e| pg(&e))?
    } else {
        Vec::new()
    };
    if !updated.is_empty() {
        return Ok(());
    }
    let row = by_id(tx, c.request_id)?;
    let Some(row) =
        row.filter(|r| r.payer_user_id == c.payer_user_id || r.payee_user_id == c.payer_user_id)
    else {
        return Err(not_found(c.request_id));
    };
    if row.payer_user_id != c.payer_user_id {
        return Err(refuse(
            "bank.personal_request_not_payer",
            format!(
                "Only the person asked to pay can settle request {} (bank.personal_request_not_payer)",
                c.request_id
            ),
        ));
    }
    if row.payee_user_id != c.to_user_id {
        return Err(refuse(
            "bank.personal_request_payee_mismatch",
            "Payment recipient is not the person who asked (bank.personal_request_payee_mismatch)",
        ));
    }
    if row.asset_id != c.asset_id || row.amount != c.amount {
        return Err(refuse(
            "bank.personal_request_amount_mismatch",
            format!(
                "Payment does not match request {} (bank.personal_request_amount_mismatch)",
                c.request_id
            ),
        ));
    }
    if row
        .claim_transfer_id
        .as_deref()
        .is_some_and(|t| t != c.transfer_id)
    {
        return Err(claim_held(c.request_id));
    }
    let status = effective_status(&row, c.now);
    if status == "expired" {
        return Err(refuse(
            "bank.personal_request_expired",
            format!(
                "Request {} has expired (bank.personal_request_expired)",
                c.request_id
            ),
        ));
    }
    Err(closed(&status))
}

/// `finishRequest`: a posted send marks its request paid and tells the payee, once.
pub fn finish(
    d: &Deps<'_>,
    request_id: &str,
    transfer_id: &str,
    ledger_tx_id: &str,
) -> Result<(), Refusal> {
    let updated = with(d.store, |c| {
        c.query(
            &format!(
                "UPDATE bank.personal_requests SET status = 'paid', ledger_tx_id = $3, updated_at = {} \
                 WHERE id = $1::text::uuid AND claim_transfer_id = $2 AND status = 'open' RETURNING {COLS}",
                at("$4")
            ),
            &[&request_id, &transfer_id, &ledger_tx_id, &d.now.0],
        )
        .map_err(|e| pg(&e))
    })?;
    let row = match updated.first() {
        Some(r) => RequestRow::from_row(r)?,
        None => with(d.store, |c| must(c, request_id))?,
    };
    if row.status != "paid" {
        return Ok(());
    }
    let Some(payer_handle) = row.payer_handle.clone() else {
        return Ok(());
    };
    let sent = d.notices().request_paid(&RequestPaid {
        request_id: request_id.to_owned(),
        payee_user_id: row.payee_user_id.clone(),
        payer_handle,
        amount: format_amount(row.amount),
        asset_id: row.asset_id.clone(),
        ledger_tx_id: ledger_tx_id.to_owned(),
    });
    remember_notice(d, request_id, sent.err().map(|_| NOTIFY_FAILED))
}

/// `abandon`'s request half: a send that never posted lets go of its claim.
pub fn release_claim(
    c: &mut impl GenericClient,
    request_id: &str,
    transfer_id: &str,
) -> Result<(), Refusal> {
    c.execute(
        "UPDATE bank.personal_requests SET claim_transfer_id = NULL \
         WHERE id = $1::text::uuid AND claim_transfer_id = $2 AND status = 'open'",
        &[&request_id, &transfer_id],
    )
    .map_err(|e| pg(&e))?;
    Ok(())
}

fn text<'v>(v: &'v service_kit::schema::Value, key: &str) -> &'v str {
    v.get(key).as_str().unwrap_or_default()
}

/// The answer of one of this part's calls, by its path; `None` for a path outside it.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let path = ctx.call.path.strip_prefix("personalRequest.")?;
    let user = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    let input = &ctx.input;
    let id = text(input, "requestId");
    Some(match path {
        "create" => js_date(text(input, "expiresAt"))
            .ok_or_else(|| Refusal::Other("expiresAt is no date".to_owned()))
            .and_then(|expires_at| {
                let amount = parse_amount(text(input, "amount")).map_err(Refusal::Other)?;
                create(
                    d,
                    &NewRequest {
                        payee_user_id: user,
                        payer_user_id: text(input, "payerUserId"),
                        asset_id: text(input, "assetId"),
                        amount,
                        note: input.get("note").as_str(),
                        expires_at,
                        idempotency_key: text(input, "idempotencyKey"),
                    },
                )
            }),
        "list" => list(
            d,
            user,
            text(input, "direction") == "incoming",
            input.get("status").as_str(),
            input.get("limit").as_number(),
        ),
        "get" => get(d, user, id),
        "cancel" => close(d, user, id, true).map(Json::Object),
        "decline" => close(d, user, id, false).map(Json::Object),
        "remind" => remind(d, user, id, text(input, "idempotencyKey")),
        "reminders" => reminders(d, user, id),
        "report" => report(
            d,
            user,
            id,
            text(input, "reason"),
            matches!(input.get("block"), service_kit::schema::Value::Bool(true)),
        ),
        "safety" => safety(d, user, id),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn a_note_is_plain_text_and_a_reference_printable() {
        assert_eq!(plain_note(Some("  hi ")).unwrap().as_deref(), Some("hi"));
        assert_eq!(plain_note(Some("   ")).unwrap(), None);
        assert!(plain_note(Some("a\u{7}b")).is_err());
        assert!(plain_note(Some(&"é".repeat(140))).unwrap().is_some());
        assert!(plain_note(Some(&"é".repeat(141))).is_err());
        assert!(plain_reference(Some("INV-1")).unwrap().is_some());
        assert!(plain_reference(Some("caf\u{e9}")).is_err());
    }

    #[test]
    fn the_remind_rule_is_two_whole_numbers_in_range() {
        assert_eq!(
            parse_remind_policy(Some(r#"{"cap":3,"windowSeconds":3600}"#)),
            Some(RemindPolicy {
                cap: 3,
                window_seconds: 3600
            })
        );
        assert_eq!(
            parse_remind_policy(Some(r#"{"cap":0,"windowSeconds":3600}"#)),
            None
        );
        assert_eq!(
            parse_remind_policy(Some(r#"{"cap":3,"windowSeconds":59}"#)),
            None
        );
        assert_eq!(
            parse_remind_policy(Some(r#"{"cap":3,"windowSeconds":3600,"x":1}"#)),
            None
        );
        assert_eq!(parse_remind_policy(None), None);
    }
}
