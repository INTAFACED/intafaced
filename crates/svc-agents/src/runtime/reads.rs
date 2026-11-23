//! The runtime slice's reads (\`router.ts\` \`session.*\`, \`log.mine\`, \`agent.*\`; \`ops/ops-sessions.ts\` \`listSessions\`;
//! \`review/store.ts\` \`runTrace\`, the log cursor and \`recordOwnExport\`). Every read is the signed person's own rows.

use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::pg::Pool;
use service_kit::time::Instant;

use crate::audit::{self, Action};
use crate::db::{self, StoreError};
use crate::runtime::{RunError, SessionRecord, denied, ms};

/// The \`assert*Limit\` family (\`errors.ts\`): blank, not finite or under 1 refuses with its code; above 500 is 500.
pub fn page_limit(limit: Option<f64>, code: &'static str, what: &str) -> Result<i64, RunError> {
    let refused = || {
        RunError::Agent(denied(
            code,
            "agents.refused.log_mine_limit_unset",
            format!("{what} page limit is unset — pass limit (never invent 100)"),
            vec![],
        ))
    };
    let Some(l) = limit.filter(|l| l.is_finite()) else {
        return Err(refused());
    };
    let n = l.floor();
    if n < 1.0 {
        return Err(refused());
    }
    #[allow(clippy::cast_possible_truncation, reason = "at most 500 after the min")]
    Ok(n.min(500.0) as i64)
}

/// \`Buffer.from(s).toString('base64url')\`.
pub fn b64url(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [
            *chunk.first().unwrap_or(&0),
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..=chunk.len() {
            let at = ((n >> (18 - 6 * i)) & 63) as usize;
            out.push(char::from(*A.get(at).unwrap_or(&b'A')));
        }
    }
    out
}

/// \`Buffer.from(s, 'base64url')\`: lenient as Node is: both alphabets, characters outside them skipped, \`=\` ends it.
pub fn b64url_decode(text: &str) -> Vec<u8> {
    let mut bits: u32 = 0;
    let mut n = 0;
    let mut out = Vec::new();
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
        bits = (bits << 6) | u32::from(v);
        n += 6;
        if n >= 8 {
            n -= 8;
            out.push(((bits >> n) & 0xff) as u8);
        }
    }
    out
}

fn cursor_invalid(message: &str) -> RunError {
    RunError::Agent(denied(
        "agents.cursor_invalid",
        "agents.refused.cursor_invalid",
        message.to_owned(),
        vec![],
    ))
}

fn is_uuid_any_case(s: &str) -> bool {
    crate::runtime::funds::is_uuid(s)
}

// ── session.mine (\`listSessions\`) ─────────────────────────────────────────────

/// \`ListSessionsInput\`.
#[derive(Debug, Clone, Default)]
pub struct ListSessions<'a> {
    pub user_id: Option<&'a str>,
    pub agent_id: Option<&'a str>,
    pub status: Option<&'a str>,
    pub from: Option<&'a str>,
    pub to: Option<&'a str>,
    pub limit: i64,
    pub cursor: Option<&'a str>,
    pub fee_asset_id: &'a str,
}

fn decode_session_cursor(cursor: &str) -> Result<(String, String), RunError> {
    let raw = String::from_utf8_lossy(&b64url_decode(cursor)).into_owned();
    let refused = || cursor_invalid("session list cursor is not valid");
    let Some(nl) = raw.find('\n').filter(|n| *n >= 1) else {
        return Err(refused());
    };
    let (us, id) = (&raw[..nl], &raw[nl + 1..]);
    let digits = (1..=20).contains(&us.len()) && us.bytes().all(|b| b.is_ascii_digit());
    let id_ok = id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-');
    if !digits || !id_ok {
        return Err(refused());
    }
    Ok((us.to_owned(), id.to_owned()))
}

/// \`listSessions\`: newest first; spend is the sealed windows' charged amounts by their stored asset.
pub fn list_sessions(
    pool: &Pool,
    input: &ListSessions<'_>,
    with_user: bool,
) -> Result<Json, RunError> {
    let cursor = input.cursor.map(decode_session_cursor).transpose()?;
    let (cursor_us, cursor_id) = cursor.map_or((None, None), |(u, i)| (Some(u), Some(i)));
    let mut conn = pool.get().map_err(StoreError::from)?;
    let c = conn.client().map_err(StoreError::from)?;
    let rows = c.query(
        &format!(
            "SELECT s.id::text, s.user_id, s.agent_id, s.status::text, {},
                    (extract(epoch from s.opened_at) * 1000000)::bigint::text, {},
                    (SELECT count(*)::int FROM agents.agent_actions a WHERE a.session_id = s.id)
               FROM agents.agent_sessions s
              WHERE ($1::text IS NULL
                     OR (s.opened_at, s.id) < (
                          timestamptz 'epoch' + $1::text::bigint * interval '1 microsecond',
                          $2::text::uuid))
                AND ($3::text IS NULL OR s.user_id = $3::text)
                AND ($4::text IS NULL OR s.agent_id = $4::text)
                AND ($5::text IS NULL OR s.status = $5::text::agents.session_status)
                AND ($6::text IS NULL OR s.opened_at >= $6::text::timestamptz)
                AND ($7::text IS NULL OR s.opened_at <= $7::text::timestamptz)
              ORDER BY s.opened_at DESC, s.id DESC
              LIMIT $8::text::bigint",
            ms("s.opened_at"),
            ms("s.closed_at")
        ),
        &[
            &cursor_us,
            &cursor_id,
            &input.user_id,
            &input.agent_id,
            &input.status,
            &input.from,
            &input.to,
            &(input.limit + 1).to_string(),
        ],
    )?;
    let page = rows
        .get(..rows.len().min(usize::try_from(input.limit).unwrap_or(0)))
        .unwrap_or_default();
    let ids: Vec<String> = page
        .iter()
        .map(|r| r.try_get::<_, String>(0))
        .collect::<Result<_, _>>()?;
    let windows = if ids.is_empty() {
        Vec::new()
    } else {
        let list = Json::Array(ids.iter().map(|i| Json::str(i.clone())).collect()).compact();
        c.query(
            "SELECT session_id::text, charged_amount::text, charged_asset, sealed_at IS NOT NULL
               FROM agents.usage_windows
              WHERE session_id IN (SELECT jsonb_array_elements_text($1::text::jsonb)::uuid)",
            &[&list],
        )?
    };
    let mut items = Vec::new();
    for r in page {
        let id: String = r.try_get(0)?;
        let mut by_asset: Vec<(String, Amount)> = Vec::new();
        for w in &windows {
            let (sid, amount, asset, sealed): (String, Option<String>, Option<String>, bool) =
                (w.try_get(0)?, w.try_get(1)?, w.try_get(2)?, w.try_get(3)?);
            let (true, Some(amount)) = (sid == id && sealed, amount) else {
                continue;
            };
            let stored = asset
                .as_deref()
                .map(service_kit::schema::js_trim)
                .unwrap_or_default();
            let asset_id = if stored.is_empty() {
                service_kit::schema::js_trim(input.fee_asset_id)
            } else {
                stored
            };
            if asset_id.is_empty() {
                return Err(RunError::Agent(denied(
                    "agents.fee_asset_unset",
                    "agents.refused.fee_asset_unset",
                    "AGENTS_FEE_ASSET_ID is unset — a sealed window has no stored asset".to_owned(),
                    vec![],
                )));
            }
            let a = parse_amount(&amount).map_err(RunError::Other)?;
            match by_asset.iter_mut().find(|(k, _)| k == asset_id) {
                Some((_, sum)) => *sum += a,
                None => by_asset.push((asset_id.to_owned(), a)),
            }
        }
        by_asset.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
        let (spend, reason) = if by_asset.is_empty() {
            (Json::Null, Json::str("no_settled_window"))
        } else {
            (
                Json::Array(
                    by_asset
                        .into_iter()
                        .map(|(asset, amount)| {
                            Json::obj([
                                ("assetId", Json::str(asset)),
                                ("amount", Json::str(format_amount(amount))),
                            ])
                        })
                        .collect(),
                ),
                Json::Null,
            )
        };
        let mut fields = vec![
            ("id".to_owned(), Json::str(id)),
            ("agentId".to_owned(), Json::str(r.try_get::<_, String>(2)?)),
        ];
        if with_user {
            fields.push(("userId".to_owned(), Json::str(r.try_get::<_, String>(1)?)));
        }
        fields.extend([
            ("status".to_owned(), Json::str(r.try_get::<_, String>(3)?)),
            (
                "openedAt".to_owned(),
                Json::str(Instant(r.try_get(4)?).iso()),
            ),
            (
                "closedAt".to_owned(),
                r.try_get::<_, Option<i64>>(6)?
                    .map_or(Json::Null, |c| Json::str(Instant(c).iso())),
            ),
            (
                "actionCount".to_owned(),
                Json::int(i64::from(r.try_get::<_, i32>(7)?)),
            ),
            ("spend".to_owned(), spend),
            ("spendReason".to_owned(), reason),
        ]);
        items.push(Json::Object(fields));
    }
    let next = if rows.len() > page.len() {
        match page.last() {
            Some(last) => {
                let us: String = last.try_get(5)?;
                let id: String = last.try_get(0)?;
                Json::str(b64url(format!("{us}\n{id}").as_bytes()))
            }
            None => Json::Null,
        }
    } else {
        Json::Null
    };
    Ok(Json::obj([
        ("items", Json::Array(items)),
        ("nextCursor", next),
    ]))
}

// ── session.detail, selected, select ───────────────────────────────────────

/// \`session.detail\`: the session, every usage window with what it was charged, and its runs by request id.
pub fn session_detail(
    pool: &Pool,
    s: &SessionRecord,
    fee_asset_id: &str,
) -> Result<Json, RunError> {
    let mut conn = pool.get().map_err(StoreError::from)?;
    let c = conn.client().map_err(StoreError::from)?;
    let rows = c.query(
        &format!(
            "SELECT window_id, {}, sealed_at IS NOT NULL, charged_amount::text, charge_key, charge_tx_id, paid_by,
                    payment_ref, payment_label
               FROM agents.usage_windows
              WHERE session_id = $1::text::uuid
              ORDER BY opened_at, window_id",
            ms("opened_at")
        ),
        &[&s.id],
    )?;
    let mut windows = Vec::new();
    for r in &rows {
        let sealed: bool = r.try_get(2)?;
        let charged: Option<String> = r.try_get(3)?;
        let charge_key: Option<String> = r.try_get(4)?;
        let tx_id: Option<String> = r.try_get(5)?;
        let paid_by: Option<String> = r.try_get(6)?;
        let payment_ref: Option<String> = r.try_get(7)?;
        let payment_label: Option<String> = r.try_get(8)?;
        let amount = charged
            .as_deref()
            .map(parse_amount)
            .transpose()
            .map_err(RunError::Other)?;
        let state = if !sealed {
            "open"
        } else if tx_id.as_deref().is_some_and(|t| !t.is_empty()) {
            "settled"
        } else {
            "unpaid"
        };
        let paid = tx_id.as_deref().is_some_and(|t| !t.is_empty())
            && sealed
            && amount.is_some_and(|a| a > Amount::ZERO);
        windows.push(Json::obj([
            ("windowId", Json::str(r.try_get::<_, String>(0)?)),
            ("openedAt", Json::str(Instant(r.try_get(1)?).iso())),
            ("state", Json::str(state)),
            (
                "amount",
                amount.map_or(Json::Null, |a| Json::str(format_amount(a))),
            ),
            ("chargeKey", charge_key.map_or(Json::Null, Json::str)),
            (
                "paidBy",
                if paid {
                    Json::str(paid_by.clone().unwrap_or_else(|| "ledger".to_owned()))
                } else {
                    Json::Null
                },
            ),
            (
                "payment",
                match (paid_by.as_deref(), payment_ref) {
                    (Some("partner"), Some(r)) if !r.is_empty() => Json::obj([
                        ("ref", Json::str(r)),
                        ("label", Json::str(payment_label.unwrap_or_default())),
                    ]),
                    _ => Json::Null,
                },
            ),
        ]));
    }
    let runs = c.query(
        &format!(
            "SELECT c.request_id, {},
                    EXISTS (SELECT 1 FROM agents.usage_records u
                             WHERE u.session_id = c.session_id AND u.request_id = c.request_id)
               FROM agents.think_claims c
              WHERE c.session_id = $1::text::uuid
              ORDER BY c.claimed_at, c.request_id",
            ms("c.claimed_at")
        ),
        &[&s.id],
    )?;
    let runs = runs
        .iter()
        .map(|r| {
            Ok(Json::obj([
                ("requestId", Json::str(r.try_get::<_, String>(0)?)),
                ("startedAt", Json::str(Instant(r.try_get(1)?).iso())),
                (
                    "state",
                    Json::str(if r.try_get::<_, bool>(2)? {
                        "completed"
                    } else {
                        "running"
                    }),
                ),
            ]))
        })
        .collect::<Result<Vec<_>, RunError>>()?;
    Ok(Json::obj([
        ("session", s.to_output()),
        ("assetId", Json::str(fee_asset_id)),
        ("windows", Json::Array(windows)),
        ("runs", Json::Array(runs)),
    ]))
}

/// \`session.selected\`.
pub fn selected(pool: &Pool, user_id: &str) -> Result<Json, RunError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            "SELECT s.id::text, s.agent_id
               FROM agents.selected_sessions sel
               JOIN agents.agent_sessions s ON s.id = sel.session_id AND s.user_id = sel.user_id
              WHERE sel.user_id = $1::text",
            &[&user_id],
        )?)
    })?;
    Ok(match rows.first() {
        Some(r) => Json::obj([
            ("sessionId", Json::str(r.try_get::<_, String>(0)?)),
            ("agentId", Json::str(r.try_get::<_, String>(1)?)),
        ]),
        None => Json::Null,
    })
}

/// \`session.select\`.
pub fn select(pool: &Pool, user_id: &str, s: &SessionRecord) -> Result<Json, RunError> {
    db::with_client(pool, |c| {
        c.execute(
            "INSERT INTO agents.selected_sessions (user_id, session_id)
             VALUES ($1::text, $2::text::uuid)
             ON CONFLICT (user_id) DO UPDATE SET session_id = EXCLUDED.session_id, updated_at = now()",
            &[&user_id, &s.id],
        )?;
        Ok(())
    })?;
    Ok(Json::obj([
        ("sessionId", Json::str(s.id.clone())),
        ("agentId", Json::str(s.agent_id.clone())),
    ]))
}

/// Actions as the calls answer them (\`toActionOutput\`).
pub fn actions(list: &[Action]) -> Json {
    Json::Array(list.iter().map(Action::to_output).collect())
}

// ── run.trace (\`runTrace\`) ─────────────────────────────────────────────────

/// \`runTrace\`: one run of the session by its request id, timed from its stored rows; none when there is no such run.
pub fn run_trace(
    pool: &Pool,
    session_id: &str,
    request_id: &str,
) -> Result<Option<Json>, RunError> {
    let mut conn = pool.get().map_err(StoreError::from)?;
    let c = conn.client().map_err(StoreError::from)?;
    let runs = c.query(
        &format!(
            "SELECT id::text, request_id, session_id::text, agent_id, task, state, cost::text, asset_id, action_id::text, {}
               FROM agents.agent_runs
              WHERE session_id = $1::text::uuid AND request_id = $2::text",
            ms("created_at")
        ),
        &[&session_id, &request_id],
    )?;
    let Some(run) = runs.first() else {
        return Ok(None);
    };
    let run_id: String = run.try_get(0)?;
    let run_session: String = run.try_get(2)?;
    let run_request: String = run.try_get(1)?;
    let action_id: Option<String> = run.try_get(8)?;
    let events = c.query(
        &format!(
            "SELECT sequence, state, code, {} FROM agents.agent_run_events WHERE run_id = $1::text::uuid ORDER BY sequence",
            ms("occurred_at")
        ),
        &[&run_id],
    )?;
    let claims = c.query(
        &format!(
            "SELECT {} FROM agents.think_claims WHERE session_id = $1::text::uuid AND request_id = $2::text",
            ms("claimed_at")
        ),
        &[&run_session, &run_request],
    )?;
    let calls = match &action_id {
        Some(a) => c.query(
            &format!(
                "SELECT id::text, sequence, kind::text, status::text, tool, task, input_tokens::text,
                        output_tokens::text, cost::text, refusal_code, {}
                   FROM agents.agent_actions
                  WHERE id = $1::text::uuid AND session_id = $2::text::uuid",
                ms("occurred_at")
            ),
            &[a, &run_session],
        )?,
        None => Vec::new(),
    };
    let claimed_at: Option<i64> = claims.first().map(|r| r.try_get(0)).transpose()?;
    let opt = |v: Option<String>| v.map_or(Json::Null, Json::str);
    let cost: Option<String> = run.try_get(6)?;
    let at: Vec<i64> = events
        .iter()
        .map(|e| e.try_get::<_, i64>(3))
        .collect::<Result<_, _>>()?;
    let plan = events
        .iter()
        .enumerate()
        .zip(&at)
        .map(|((i, e), here)| {
            Ok(Json::obj([
                ("sequence", Json::int(i64::from(e.try_get::<_, i32>(0)?))),
                ("state", Json::str(e.try_get::<_, String>(1)?)),
                ("code", opt(e.try_get(2)?)),
                ("startedAt", Json::str(Instant(*here).iso())),
                (
                    "tookMs",
                    at.get(i + 1)
                        .map_or(Json::Null, |next| Json::int(next - here)),
                ),
            ]))
        })
        .collect::<Result<Vec<_>, RunError>>()?;
    let calls = calls
        .iter()
        .map(|call| {
            let finished: i64 = call.try_get(10)?;
            let started = claimed_at.filter(|c| *c <= finished).unwrap_or(finished);
            Ok(Json::obj([
                ("actionId", Json::str(call.try_get::<_, String>(0)?)),
                ("sequence", Json::int(i64::from(call.try_get::<_, i32>(1)?))),
                ("kind", Json::str(call.try_get::<_, String>(2)?)),
                ("status", Json::str(call.try_get::<_, String>(3)?)),
                ("tool", opt(call.try_get(4)?)),
                ("task", opt(call.try_get(5)?)),
                ("startedAt", Json::str(Instant(started).iso())),
                ("finishedAt", Json::str(Instant(finished).iso())),
                ("tookMs", Json::int(finished - started)),
                ("inputTokens", Json::str(call.try_get::<_, String>(6)?)),
                ("outputTokens", Json::str(call.try_get::<_, String>(7)?)),
                (
                    "cost",
                    Json::str(format_amount(
                        parse_amount(&call.try_get::<_, String>(8)?).map_err(RunError::Other)?,
                    )),
                ),
                ("refusalCode", opt(call.try_get(9)?)),
            ]))
        })
        .collect::<Result<Vec<_>, RunError>>()?;
    Ok(Some(Json::obj([
        ("runId", Json::str(run_id)),
        ("requestId", Json::str(run_request)),
        ("sessionId", Json::str(run_session)),
        ("agentId", Json::str(run.try_get::<_, String>(3)?)),
        ("task", opt(run.try_get(4)?)),
        ("state", Json::str(run.try_get::<_, String>(5)?)),
        (
            "cost",
            cost.as_deref()
                .map(|c| parse_amount(c).map(|a| Json::str(format_amount(a))))
                .transpose()
                .map_err(RunError::Other)?
                .unwrap_or(Json::Null),
        ),
        ("assetId", opt(run.try_get(7)?)),
        ("startedAt", Json::str(Instant(run.try_get(9)?).iso())),
        ("plan", Json::Array(plan)),
        ("calls", Json::Array(calls)),
    ])))
}

// ── log.export ──────────────────────────────────────────────────────────────

/// \`LogCursor\`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogCursor {
    pub at_us: String,
    pub session_id: String,
    pub sequence: i64,
    pub returned: i64,
}

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// \`encodeLogCursor\`.
pub fn encode_log_cursor(c: &LogCursor) -> String {
    let text = Json::Array(vec![
        Json::str(c.at_us.clone()),
        Json::str(c.session_id.clone()),
        Json::int(c.sequence),
        Json::int(c.returned),
    ])
    .compact();
    b64url(text.as_bytes())
}

/// \`decodeLogCursor\`: only a cursor this service issued.
pub fn decode_log_cursor(text: &str) -> Result<LogCursor, RunError> {
    let refused = || cursor_invalid("Log cursor is not one this service issued");
    let raw = String::from_utf8_lossy(&b64url_decode(text)).into_owned();
    let Ok(Json::Array(items)) = json::parse(&raw) else {
        return Err(refused());
    };
    let safe = |v: Option<&Json>| match v {
        Some(Json::Number(n)) if n.fract() == 0.0 && n.abs() <= MAX_SAFE => Some(*n),
        _ => None,
    };
    let at_ok = |s: &str| {
        let digits = s.strip_prefix('-').unwrap_or(s);
        (1..=20).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit())
    };
    match (
        items.first(),
        items.get(1),
        safe(items.get(2)),
        safe(items.get(3)),
    ) {
        (Some(Json::String(at)), Some(Json::String(sid)), Some(seq), Some(ret))
            if at_ok(at) && is_uuid_any_case(sid) && seq >= 0.0 && ret > 0.0 =>
        {
            #[allow(clippy::cast_possible_truncation, reason = "a safe integer")]
            Ok(LogCursor {
                at_us: at.clone(),
                session_id: sid.clone(),
                sequence: seq as i64,
                returned: ret as i64,
            })
        }
        _ => Err(refused()),
    }
}

/// \`log.export\`: one page of the person's whole log, newest first; its last page records the export once.
pub fn log_export(
    pool: &Pool,
    user_id: &str,
    outcome: Option<&str>,
    cursor: Option<&str>,
    limit: Option<f64>,
    request_id: Option<&str>,
    format: Option<&str>,
) -> Result<Json, RunError> {
    let after = cursor.map(decode_log_cursor).transpose()?;
    let page = page_limit(limit, "agents.log_mine_limit_unset", "User log")?;
    let (rows, last_us) = audit::for_user_after(
        pool,
        user_id,
        outcome,
        after
            .as_ref()
            .map(|a| audit::After {
                at_us: a.at_us.clone(),
                session_id: a.session_id.clone(),
                sequence: a.sequence,
            })
            .as_ref(),
        page,
    )?;
    let returned =
        after.as_ref().map_or(0, |a| a.returned) + i64::try_from(rows.len()).unwrap_or(0);
    #[allow(
        clippy::cast_possible_truncation,
        reason = "a page limit the schema bounds to 500"
    )]
    let full = limit.is_some_and(|l| i64::try_from(rows.len()).unwrap_or(0) == (l as i64).min(500));
    if !full && let Some(r) = request_id {
        record_own_export(
            pool,
            user_id,
            r,
            outcome.unwrap_or("all"),
            format.unwrap_or("csv"),
            returned,
        )?;
    }
    let next = match (full, rows.last(), last_us) {
        (true, Some(last), Some(us)) => Json::str(encode_log_cursor(&LogCursor {
            at_us: us,
            session_id: last.session_id.clone(),
            sequence: last.sequence,
            returned,
        })),
        _ => Json::Null,
    };
    Ok(Json::obj([("rows", actions(&rows)), ("nextCursor", next)]))
}

/// \`recordOwnExport\`: one append-only row per export, however often it is retried.
pub fn record_own_export(
    pool: &Pool,
    user_id: &str,
    request_id: &str,
    outcome: &str,
    format: &str,
    row_count: i64,
) -> Result<(), RunError> {
    let filter = Json::obj([
        ("outcome", Json::str(outcome)),
        ("format", Json::str(format)),
    ])
    .compact();
    let row_count = i32::try_from(row_count).map_err(|e| RunError::Other(e.to_string()))?;
    db::with_client(pool, |c| {
        c.execute(
            "INSERT INTO agents.agent_log_reads (business_key, operator_id, subject_id, kind, reason, filter, row_count)
             VALUES ($1::text, $2::text, $2::text, 'export', 'own_export', $3::text::jsonb, $4)
             ON CONFLICT (business_key) DO NOTHING",
            &[&format!("agents:logexport:{user_id}:{request_id}"), &user_id, &filter, &row_count],
        )?;
        Ok(())
    })?;
    Ok(())
}

// ── agent.catalogue ─────────────────────────────────────────────────────────

/// \`listCatalogue\`: the stored agents by id, disabled ones included.
pub fn catalogue(pool: &Pool) -> Result<Json, RunError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            "SELECT agent_id, name, purpose, enabled, version FROM agents.agent_definitions ORDER BY agent_id ASC",
            &[],
        )?)
    })?;
    rows.iter()
        .map(|r| {
            Ok(Json::obj([
                ("agentId", Json::str(r.try_get::<_, String>(0)?)),
                (
                    "name",
                    r.try_get::<_, Option<String>>(1)?
                        .map_or(Json::Null, Json::str),
                ),
                (
                    "purpose",
                    r.try_get::<_, Option<String>>(2)?
                        .map_or(Json::Null, Json::str),
                ),
                ("enabled", Json::Bool(r.try_get(3)?)),
                ("version", Json::int(i64::from(r.try_get::<_, i32>(4)?))),
            ]))
        })
        .collect::<Result<Vec<_>, RunError>>()
        .map(Json::Array)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn base64url_round_trips_as_node_writes_it() {
        assert_eq!(
            b64url(b"1700000000000000\n00000000-0000-4000-8000-000000000000"),
            "MTcwMDAwMDAwMDAwMDAwMAowMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDA"
        );
        assert_eq!(b64url(b"a"), "YQ");
        assert_eq!(b64url_decode("YQ"), b"a");
        assert_eq!(b64url_decode("Y Q=="), b"a");
    }

    #[test]
    fn a_log_cursor_is_only_one_this_service_issued() {
        let c = LogCursor {
            at_us: "1767225600000123".to_owned(),
            session_id: "11111111-1111-4111-8111-111111111111".to_owned(),
            sequence: 3,
            returned: 2,
        };
        assert_eq!(decode_log_cursor(&encode_log_cursor(&c)).unwrap(), c);
        for bad in [
            "",
            "e30",
            &b64url(b"[\"1\",\"x\",0,1]"),
            &b64url(b"[\"1\",\"11111111-1111-4111-8111-111111111111\",0,0]"),
        ] {
            assert_eq!(
                decode_log_cursor(bad).unwrap_err().code(),
                Some("agents.cursor_invalid"),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_page_limit_is_never_invented() {
        assert_eq!(
            page_limit(Some(9000.0), "agents.log_mine_limit_unset", "User log").unwrap(),
            500
        );
        assert_eq!(
            page_limit(Some(2.7), "agents.log_mine_limit_unset", "User log").unwrap(),
            2
        );
        for bad in [None, Some(0.5), Some(f64::NAN)] {
            assert_eq!(
                page_limit(bad, "agents.session_mine_limit_unset", "session.mine")
                    .unwrap_err()
                    .code(),
                Some("agents.session_mine_limit_unset")
            );
        }
    }
}
