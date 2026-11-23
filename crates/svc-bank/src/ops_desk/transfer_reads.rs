//! The operator's transfer reads (`ops/transfer-source.ts`, `transfer-health.ts`, `failed-transfers.ts`,
//! `transfer-detail.ts`): health by status over a window, the rejected standing orders newest first with the people's
//! handles, and one transfer by id.
//!
//! Counts come from rows that exist. A source with no failed status (one-off sends: a refusal deletes the reservation)
//! says so rather than counting zero. Ratios are exact (`3/12` is `0.25`; a recurring one is a reduced fraction). No
//! page names a user id, except the one-transfer read for compliance, which logs who read what first.

use postgres::{GenericClient, Row};
use service_kit::json::Json;
use service_kit::money::{format_amount, js_trim, parse_amount};
use service_kit::time::Instant;

use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{at, pg};
use crate::transfers::moves::RECIPIENT_CANNOT_RECEIVE_MESSAGE;
use crate::transfers::ports::PartyHandles;

const HOUR_MS: i64 = 60 * 60 * 1000;

/// `assertWindowHours`: a whole number of hours from 1 to 720, never defaulted.
pub fn window_hours(hours: Option<f64>, code: &str, name: &str) -> Result<i64, Refusal> {
    match hours {
        #[allow(
            clippy::cast_possible_truncation,
            reason = "a whole number from 1 to 720"
        )]
        Some(h) if h.fract() == 0.0 && (1.0..=720.0).contains(&h) => Ok(h as i64),
        _ => Err(refuse(
            code,
            format!("{name} needs windowHours from 1 to 720 ({code})"),
        )),
    }
}

fn window_start(now: Instant, hours: i64) -> Instant {
    Instant(now.0 - hours * HOUR_MS)
}

/// `exactRatio`: none when nothing was counted; terminating decimals stay decimals, recurring ones a reduced fraction.
pub fn exact_ratio(numerator: i64, denominator: i64) -> Result<Option<String>, Refusal> {
    if denominator == 0 {
        return Ok(None);
    }
    if numerator < 0 || numerator > denominator {
        return Err(Refusal::Other(
            "transfer health ratio is not a count of stored rows".to_owned(),
        ));
    }
    let (n, d) = (numerator.unsigned_abs(), denominator.unsigned_abs());
    let whole = n / d;
    let mut rem = n % d;
    if rem == 0 {
        return Ok(Some(whole.to_string()));
    }
    let mut digits = String::new();
    let mut seen = std::collections::BTreeSet::new();
    while rem != 0 && digits.len() < 80 {
        if !seen.insert(rem) {
            let g = gcd(n, d);
            return Ok(Some(format!("{}/{}", n / g, d / g)));
        }
        rem *= 10;
        digits.push_str(&(rem / d).to_string());
        rem %= d;
    }
    let digits = digits.trim_end_matches('0');
    Ok(Some(format!("{whole}.{digits}")))
}

fn gcd(a: u64, b: u64) -> u64 {
    let (mut x, mut y) = (a, b);
    while y != 0 {
        let next = x % y;
        x = y;
        y = next;
    }
    x
}

/// `ageSeconds`: whole seconds, or none.
fn age_seconds(value: Option<String>) -> Result<Json, Refusal> {
    match value {
        None => Ok(Json::Null),
        Some(v) if !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()) => v
            .parse::<i64>()
            .ok()
            .filter(|n| *n <= MAX_SAFE)
            .map(Json::int)
            .ok_or_else(age_not_whole),
        Some(_) => Err(age_not_whole()),
    }
}

fn age_not_whole() -> Refusal {
    Refusal::Other("transfer health age was not a whole number of seconds".to_owned())
}

const MAX_SAFE: i64 = 9_007_199_254_740_991;

/// `money`: a stored amount in canonical decimal form.
fn money(amount: &str) -> Result<String, Refusal> {
    parse_amount(js_trim(amount))
        .map(format_amount)
        .map_err(Refusal::Other)
}

/// `rejectionReason`: the one sentence this service states for a code it knows; any other code as stored.
fn rejection_reason(code: Option<&str>) -> Option<String> {
    code.map(|c| {
        if c == "bank.recipient_cannot_receive" {
            RECIPIENT_CANNOT_RECEIVE_MESSAGE.to_owned()
        } else {
            c.to_owned()
        }
    })
}

/// `EXECUTION_ID`: a uuid in any case.
fn is_execution_id(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn count(r: &Row, i: usize) -> Result<i64, Refusal> {
    let n: i32 = r.try_get(i).map_err(|e| pg(&e))?;
    if n < 0 {
        return Err(Refusal::Other(
            "transfer health count was not a non-negative integer".to_owned(),
        ));
    }
    Ok(i64::from(n))
}

fn first_row(rows: &[Row], what: &str) -> Result<Row, Refusal> {
    rows.first()
        .cloned()
        .ok_or_else(|| Refusal::Other(format!("transfer health returned no {what} aggregate")))
}

/// `readTransferHealth`: the window's standing orders, one-off sends and bills by status, at `now`.
pub fn health(c: &mut impl GenericClient, hours: i64, now: Instant) -> Result<Json, Refusal> {
    let since = window_start(now, hours);
    let k = |k: &str, v: Json| (k.to_owned(), v);
    let (s, n) = (since.0, now.0);
    let standing = first_row(
        &c.query(
            &format!(
                "SELECT count(*) FILTER (WHERE status = 'pending')::int, \
                        count(*) FILTER (WHERE status = 'settled')::int, \
                        count(*) FILTER (WHERE status = 'rejected')::int, \
                        count(*) FILTER (WHERE status = 'skipped')::int, \
                        count(*)::int, \
                        (SELECT floor(extract(epoch FROM ({now} - attempted_at)))::text \
                           FROM bank.transfer_executions \
                          WHERE status = 'pending' AND attempted_at >= {since} AND attempted_at <= {now} \
                          ORDER BY attempted_at ASC, id ASC LIMIT 1) \
                   FROM bank.transfer_executions \
                  WHERE attempted_at >= {since} AND attempted_at <= {now}",
                now = at("$1"),
                since = at("$2"),
            ),
            &[&n, &s],
        )
        .map_err(|e| pg(&e))?,
        "standing-order",
    )?;
    let rejected = count(&standing, 2)?;
    let total = count(&standing, 4)?;
    let standing = Json::Object(vec![
        k("pending", Json::int(count(&standing, 0)?)),
        k("settled", Json::int(count(&standing, 1)?)),
        k("rejected", Json::int(rejected)),
        k("skipped", Json::int(count(&standing, 3)?)),
        k("total", Json::int(total)),
        k(
            "failureRate",
            exact_ratio(rejected, total)?.map_or(Json::Null, Json::str),
        ),
        k(
            "oldestPendingAgeSeconds",
            age_seconds(standing.try_get(5).map_err(|e| pg(&e))?)?,
        ),
    ]);
    let one_off = first_row(
        &c.query(
            &format!(
                "SELECT count(*) FILTER (WHERE status = 'reserved')::int, \
                        count(*) FILTER (WHERE status = 'posted')::int, \
                        count(*)::int, \
                        (SELECT floor(extract(epoch FROM ({now} - created_at)))::text \
                           FROM bank.personal_transfers \
                          WHERE status = 'reserved' AND created_at >= {since} AND created_at <= {now} \
                          ORDER BY created_at ASC, transfer_id ASC LIMIT 1) \
                   FROM bank.personal_transfers \
                  WHERE created_at >= {since} AND created_at <= {now}",
                now = at("$1"),
                since = at("$2"),
            ),
            &[&n, &s],
        )
        .map_err(|e| pg(&e))?,
        "one-off",
    )?;
    let one_off = Json::Object(vec![
        k("available", Json::Bool(true)),
        k("reserved", Json::int(count(&one_off, 0)?)),
        k("posted", Json::int(count(&one_off, 1)?)),
        k("total", Json::int(count(&one_off, 2)?)),
        k("failureRate", Json::Null),
        k("failureRateReason", Json::str("failures_not_recorded")),
        k(
            "oldestPendingAgeSeconds",
            age_seconds(one_off.try_get(3).map_err(|e| pg(&e))?)?,
        ),
    ]);
    let bills = first_row(
        &c.query(
            &format!(
                "SELECT count(*) FILTER (WHERE status = 'submitted')::int, \
                        count(*) FILTER (WHERE status = 'accepted')::int, \
                        count(*) FILTER (WHERE status = 'paid')::int, \
                        count(*) FILTER (WHERE status = 'failed')::int, \
                        count(*) FILTER (WHERE status = 'returned')::int, \
                        count(*)::int, \
                        (SELECT floor(extract(epoch FROM ({now} - created_at)))::text \
                           FROM bank.bill_payments \
                          WHERE status = 'submitted' AND created_at >= {since} AND created_at <= {now} \
                          ORDER BY created_at ASC, id ASC LIMIT 1) \
                   FROM bank.bill_payments \
                  WHERE created_at >= {since} AND created_at <= {now}",
                now = at("$1"),
                since = at("$2"),
            ),
            &[&n, &s],
        )
        .map_err(|e| pg(&e))?,
        "bill",
    )?;
    let failed = count(&bills, 3)?;
    let total = count(&bills, 5)?;
    let bills = Json::Object(vec![
        k("available", Json::Bool(true)),
        k("submitted", Json::int(count(&bills, 0)?)),
        k("accepted", Json::int(count(&bills, 1)?)),
        k("paid", Json::int(count(&bills, 2)?)),
        k("failed", Json::int(failed)),
        k("returned", Json::int(count(&bills, 4)?)),
        k("total", Json::int(total)),
        k(
            "failureRate",
            exact_ratio(failed, total)?.map_or(Json::Null, Json::str),
        ),
        k(
            "oldestPendingAgeSeconds",
            age_seconds(bills.try_get(6).map_err(|e| pg(&e))?)?,
        ),
    ]);
    Ok(Json::Object(vec![
        k("asOf", Json::str(now.iso())),
        k("standingOrders", standing),
        k("oneOff", one_off),
        k(
            "p2p",
            Json::Object(vec![
                k("available", Json::Bool(false)),
                k("reason", Json::str("served_by_p2p_ops")),
            ]),
        ),
        k("bills", bills),
    ]))
}

const LIST_CAP: i64 = 200;

fn limit_unset() -> Refusal {
    refuse(
        "bank.failed_transfers_limit_unset",
        "failedTransfers page size is unset. Blank refuses — never 50. Pass a positive integer (50 is allowed if explicit) (bank.failed_transfers_limit_unset)",
    )
}

/// `assertFailedTransfersLimit`: a page size the caller named, floored, at most 200.
pub fn failed_limit(limit: Option<f64>) -> Result<i64, Refusal> {
    let Some(l) = limit.filter(|l| l.is_finite()) else {
        return Err(limit_unset());
    };
    let n = l.floor();
    if n < 1.0 {
        return Err(limit_unset());
    }
    #[allow(clippy::cast_possible_truncation, reason = "at most 200 once capped")]
    Ok((n.min(LIST_CAP as f64)) as i64)
}

fn cursor_invalid() -> Refusal {
    refuse(
        "bank.failed_transfers_cursor_invalid",
        "Failed-transfer cursor is not a page this service issued (bank.failed_transfers_cursor_invalid)",
    )
}

const B64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// `Buffer.from(text).toString('base64url')`: no padding.
fn base64url(bytes: &[u8]) -> String {
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk.first().copied().unwrap_or(0),
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        let take = chunk.len() + 1;
        for i in 0..take {
            let idx = usize::try_from((n >> (18 - 6 * i)) & 63).unwrap_or(0);
            out.push(char::from(B64URL.get(idx).copied().unwrap_or(b'A')));
        }
    }
    out
}

/// `Buffer.from(text, 'base64url')`: either alphabet, anything else skipped, stopping at `=`; a lone last character
/// carries no byte.
fn unbase64(text: &str) -> Vec<u8> {
    let mut sextets = Vec::new();
    for c in text.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        sextets.push(u32::from(v));
    }
    let mut out = Vec::new();
    for chunk in sextets.chunks(4) {
        if chunk.len() < 2 {
            break;
        }
        let mut n = 0u32;
        for (i, s) in chunk.iter().enumerate() {
            n |= s << (18 - 6 * i);
        }
        let bytes = n.to_be_bytes();
        out.extend_from_slice(bytes.get(1..chunk.len()).unwrap_or_default());
    }
    out
}

/// `encodeCursor`.
fn encode_cursor(us: &str, id: &str) -> String {
    base64url(format!("{us}\n{id}").as_bytes())
}

/// `decodeCursor`: the microsecond and the id of the last row a page showed.
fn decode_cursor(cursor: &str) -> Result<(String, String), Refusal> {
    let text = String::from_utf8_lossy(&unbase64(cursor)).into_owned();
    let (us, id) = match text.find('\n') {
        Some(nl) if nl > 0 => (&text[..nl], &text[nl + 1..]),
        _ => ("", ""),
    };
    let us_ok = (1..=20).contains(&us.len()) && us.bytes().all(|b| b.is_ascii_digit());
    if !us_ok || !is_execution_id(id) {
        return Err(cursor_invalid());
    }
    Ok((us.to_owned(), id.to_owned()))
}

fn handles_unset() -> Refusal {
    refuse(
        "bank.party_handles_unset",
        "IDENTITY_URL is unset, so a failed transfer cannot name either person (bank.party_handles_unset)",
    )
}

/// `party`: a person's handle, or none with `handle_unresolved`; no identity wired refuses.
fn party(handles: Option<&dyn PartyHandles>, user_id: &str) -> Result<Json, Refusal> {
    let port = handles.ok_or_else(handles_unset)?;
    let handle = port.handle_of(user_id).map_err(|_| {
        refuse(
            "bank.party_handles_unavailable",
            "Identity did not answer a handle lookup (bank.party_handles_unavailable)",
        )
    })?;
    let k = |k: &str, v: Json| (k.to_owned(), v);
    Ok(match handle {
        Some(h) if !js_trim(&h).is_empty() => {
            Json::Object(vec![k("handle", Json::str(h)), k("reason", Json::Null)])
        }
        _ => Json::Object(vec![
            k("handle", Json::Null),
            k("reason", Json::str("handle_unresolved")),
        ]),
    })
}

/// `readFailedTransfers`: one page of rejected standing orders in the window, newest first, at `now`.
pub fn failed(
    c: &mut impl GenericClient,
    handles: Option<&dyn PartyHandles>,
    hours: i64,
    limit: i64,
    cursor: Option<&str>,
    now: Instant,
) -> Result<Json, Refusal> {
    let since = window_start(now, hours);
    let mark = cursor.map(decode_cursor).transpose()?;
    let select = "SELECT e.id::text, e.amount::text, s.asset_id, e.rejection_code, \
                   (extract(epoch FROM e.attempted_at) * 1000000)::bigint::text, \
                   floor(extract(epoch from e.attempted_at) * 1000)::int8, \
                   s.user_id, dest.user_id \
              FROM bank.transfer_executions e \
              JOIN bank.scheduled_transfers s ON s.id = e.schedule_id \
              JOIN bank.spaces dest ON dest.id = s.to_space_id \
             WHERE e.status = 'rejected'";
    let window = format!(
        "AND e.attempted_at >= {} AND e.attempted_at <= {}",
        at("$1"),
        at("$2")
    );
    let rows = match &mark {
        Some((us, id)) => c.query(
            &format!(
                "{select} {window} \
                 AND (e.attempted_at, e.id) < (timestamptz 'epoch' + $4::text::bigint * interval '1 microsecond', $5::text::uuid) \
                 ORDER BY e.attempted_at DESC, e.id DESC LIMIT $3"
            ),
            &[&since.0, &now.0, &(limit + 1), us, id],
        ),
        None => c.query(
            &format!("{select} {window} ORDER BY e.attempted_at DESC, e.id DESC LIMIT $3"),
            &[&since.0, &now.0, &(limit + 1)],
        ),
    }
    .map_err(|e| pg(&e))?;
    let shown = usize::try_from(limit).unwrap_or(usize::MAX);
    let k = |k: &str, v: Json| (k.to_owned(), v);
    let mut items = Vec::new();
    let mut last = None;
    for r in rows.iter().take(shown) {
        let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
        let code: Option<String> = r.try_get(3).map_err(|e| pg(&e))?;
        let reason = rejection_reason(code.as_deref()).ok_or_else(|| {
            Refusal::Other("a rejected execution has no rejection code".to_owned())
        })?;
        let id = s(0)?;
        items.push(Json::Object(vec![
            k("id", Json::str(id.clone())),
            k("kind", Json::str("standing_order")),
            k("amount", Json::str(money(&s(1)?)?)),
            k("assetId", Json::str(s(2)?)),
            k("status", Json::str("rejected")),
            k("rejectionCode", Json::str(code.unwrap_or_default())),
            k("reason", Json::str(reason)),
            k(
                "attemptedAt",
                Json::str(Instant(r.try_get(5).map_err(|e| pg(&e))?).iso()),
            ),
            k("sender", party(handles, &s(6)?)?),
            k("receiver", party(handles, &s(7)?)?),
        ]));
        last = Some((s(4)?, id));
    }
    let next = match last {
        Some((us, id)) if rows.len() > shown => Json::str(encode_cursor(&us, &id)),
        _ => Json::Null,
    };
    Ok(Json::Object(vec![
        k("items", Json::Array(items)),
        k("nextCursor", next),
    ]))
}

/// `writeTransferDetailAudit`: one line naming who read which id, before anything is read.
pub fn detail_audit(actor: &str, id: &str) -> Result<(), Refusal> {
    use std::io::Write;
    let line = Json::obj([
        ("level", Json::str("info")),
        ("service", Json::str("svc-bank")),
        ("event", Json::str("bank.ops.transfer_detail_read")),
        ("actorUserId", Json::str(actor)),
        ("id", Json::str(id)),
    ]);
    writeln!(std::io::stdout(), "{}", line.compact()).map_err(|e| Refusal::Other(e.to_string()))
}

/// `readTransferDetail`: a standing-order execution by its id, else a one-off send by its transfer id; unknown and
/// malformed ids are the same not-found.
pub fn detail(c: &mut impl GenericClient, id: &str) -> Result<Json, Refusal> {
    let k = |k: &str, v: Json| (k.to_owned(), v);
    let opt = |v: Option<String>| v.map_or(Json::Null, Json::str);
    if is_execution_id(id) {
        let rows = c
            .query(
                "SELECT e.id::text, e.schedule_id::text, e.occurrence::int8, e.amount::text, s.asset_id, \
                        e.status::text, e.rejection_code, e.ledger_tx_id, \
                        floor(extract(epoch from e.attempted_at) * 1000)::int8, \
                        floor(extract(epoch from e.settled_at) * 1000)::int8, \
                        s.user_id, dest.user_id \
                   FROM bank.transfer_executions e \
                   JOIN bank.scheduled_transfers s ON s.id = e.schedule_id \
                   JOIN bank.spaces dest ON dest.id = s.to_space_id \
                  WHERE e.id = $1::text::uuid",
                &[&id],
            )
            .map_err(|e| pg(&e))?;
        if let Some(r) = rows.first() {
            let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
            let o = |i: usize| r.try_get::<_, Option<String>>(i).map_err(|e| pg(&e));
            let code = o(6)?;
            let settled: Option<i64> = r.try_get(9).map_err(|e| pg(&e))?;
            return Ok(Json::Object(vec![
                k("id", Json::str(s(0)?)),
                k("kind", Json::str("standing_order")),
                k("senderUserId", Json::str(s(10)?)),
                k("receiverUserId", Json::str(s(11)?)),
                k("amount", Json::str(money(&s(3)?)?)),
                k("assetId", Json::str(s(4)?)),
                k("status", Json::str(s(5)?)),
                k("rejectionCode", opt(code.clone())),
                k("reason", opt(rejection_reason(code.as_deref()))),
                k("ledgerTxId", opt(o(7)?)),
                k("scheduleId", Json::str(s(1)?)),
                k("occurrence", Json::int(r.try_get(2).map_err(|e| pg(&e))?)),
                k(
                    "attemptedAt",
                    Json::str(Instant(r.try_get(8).map_err(|e| pg(&e))?).iso()),
                ),
                k(
                    "settledAt",
                    settled.map_or(Json::Null, |t| Json::str(Instant(t).iso())),
                ),
            ]));
        }
    }
    let rows = c
        .query(
            "SELECT transfer_id, from_user_id, to_user_id, asset_id, amount::text, status::text, ledger_tx_id, \
                    floor(extract(epoch from created_at) * 1000)::int8 \
               FROM bank.personal_transfers WHERE transfer_id = $1",
            &[&id],
        )
        .map_err(|e| pg(&e))?;
    let Some(r) = rows.first() else {
        return Err(refuse(
            "bank.ops_transfer_not_found",
            "No such transfer (bank.ops_transfer_not_found)",
        ));
    };
    let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
    Ok(Json::Object(vec![
        k("id", Json::str(s(0)?)),
        k("kind", Json::str("one_off")),
        k("senderUserId", Json::str(s(1)?)),
        k("receiverUserId", Json::str(s(2)?)),
        k("amount", Json::str(money(&s(4)?)?)),
        k("assetId", Json::str(s(3)?)),
        k("status", Json::str(s(5)?)),
        k("rejectionCode", Json::Null),
        k("reason", Json::Null),
        k(
            "ledgerTxId",
            opt(r.try_get::<_, Option<String>>(6).map_err(|e| pg(&e))?),
        ),
        k("scheduleId", Json::Null),
        k("occurrence", Json::Null),
        k(
            "attemptedAt",
            Json::str(Instant(r.try_get(7).map_err(|e| pg(&e))?).iso()),
        ),
        k("settledAt", Json::Null),
    ]))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn a_ratio_is_exact_a_terminating_one_a_decimal_a_recurring_one_a_reduced_fraction() {
        assert_eq!(exact_ratio(0, 0).unwrap(), None);
        assert_eq!(exact_ratio(3, 12).unwrap().as_deref(), Some("0.25"));
        assert_eq!(exact_ratio(1, 5).unwrap().as_deref(), Some("0.2"));
        assert_eq!(exact_ratio(4, 4).unwrap().as_deref(), Some("1"));
        assert_eq!(exact_ratio(0, 7).unwrap().as_deref(), Some("0"));
        assert_eq!(exact_ratio(2, 6).unwrap().as_deref(), Some("1/3"));
        assert_eq!(exact_ratio(1, 6).unwrap().as_deref(), Some("1/6"));
        assert!(exact_ratio(5, 4).is_err());
    }

    #[test]
    fn a_cursor_round_trips_and_one_this_service_did_not_issue_refuses() {
        let id = "0b2a5c3e-1f4d-4a6b-8c7d-9e0f1a2b3c4d";
        let c = encode_cursor("1763800000123456", id);
        assert!(!c.contains('='));
        assert_eq!(
            decode_cursor(&c).unwrap(),
            ("1763800000123456".to_owned(), id.to_owned())
        );
        // Node's decoder skips characters outside both alphabets.
        let noisy = format!("{c}!!");
        assert_eq!(decode_cursor(&noisy).unwrap().1, id);
        for bad in [
            "",
            "abc",
            &base64url(b"x\nnot-a-uuid"),
            &base64url(b"\n0b2a"),
        ] {
            let Err(Refusal::Bank(e)) = decode_cursor(bad) else {
                panic!("{bad}")
            };
            assert_eq!(e.row.code, "bank.failed_transfers_cursor_invalid");
        }
    }

    #[test]
    fn base64url_matches_nodes_for_every_tail_length() {
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(b"\xfb\xff"), "-_8");
        assert_eq!(unbase64("Zm9vYg"), b"foob");
        assert_eq!(unbase64("Zm9vYg=="), b"foob");
        assert_eq!(unbase64("Zm9vY"), b"foo");
    }

    #[test]
    fn the_window_and_the_page_size_are_never_defaulted() {
        assert!(
            window_hours(None, "bank.transfer_health_window_unset", "Transfer health").is_err()
        );
        assert!(window_hours(Some(0.0), "bank.transfer_health_window_unset", "x").is_err());
        assert!(window_hours(Some(721.0), "bank.transfer_health_window_unset", "x").is_err());
        assert_eq!(
            window_hours(Some(48.0), "bank.transfer_health_window_unset", "x").unwrap(),
            48
        );
        assert!(failed_limit(None).is_err());
        assert!(failed_limit(Some(0.5)).is_err());
        assert_eq!(failed_limit(Some(2.9)).unwrap(), 2);
        assert_eq!(failed_limit(Some(5000.0)).unwrap(), 200);
    }
}
