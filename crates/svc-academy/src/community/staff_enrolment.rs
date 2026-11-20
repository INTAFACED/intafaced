//! J-academy-15: staff enrol people in bulk, invite an address, write to a course, and export learners by tag
//! (`learners/staff-enrolment.ts`).
//!
//! A staff enrolment goes past a full course, a closed window and a hidden or unpublished course, and records what it
//! went past (`staff_enrolment_events`, keyed `enrol:<course>:<learner>:<n>`). A bulk upload answers each address and is
//! keyed by its course and addresses. An invitation keeps only a hash of the address and a masked form. A course email is
//! written first with every recipient's state; there is no email provider, so it stays refused `vendor.email`. A
//! learner export is a task run in the background and kept until the owner's retention ends. No money moves.
//!
//! Refusals are the `StaffEnrolmentError` family's (`staffEnrolmentRefusals`): `<code>: <message>` with the code as cause.

use postgres::{GenericClient, Row};
use service_kit::json::{self, Json};
use service_kit::pg::Pool;
use service_kit::time::Instant;

use super::Db;
use super::{
    at, at_opt, begin, clock, col, csv_field, exec, family, first, int, iso, iso_opt, js_cmp,
    js_slice, js_trim, ms,
};
use super::{require_setting, rows, sha256_hex, str_opt, strs};
use crate::db::with_client;
use crate::errors::Refusal;

const BAD_REQUEST: &str = "BAD_REQUEST";
const NOT_FOUND: &str = "NOT_FOUND";
const PRECONDITION_FAILED: &str = "PRECONDITION_FAILED";

/// `staffEnrolmentRefusals`: each code's status.
fn status_of(code: &str) -> &'static str {
    match code {
        "academy.course_not_found"
        | "academy.learner_not_found"
        | "academy.report_not_found"
        | "academy.email_not_found" => NOT_FOUND,
        "academy.bulk_limit_unset"
        | "academy.prerequisite_unmet"
        | "academy.inactivity_period_unset"
        | "academy.audience_empty"
        | "academy.report_retention_unset"
        | "academy.report_limit_unset"
        | "academy.report_not_ready"
        | "academy.report_expired" => PRECONDITION_FAILED,
        _ => BAD_REQUEST,
    }
}

/// `refuse(code, message)`.
pub fn refuse(code: &str, message: &str) -> Refusal {
    family(status_of(code), code, message)
}

fn setting(value: Option<i64>, code: &str) -> Result<i64, Refusal> {
    require_setting(value, status_of(code), code)
}

/// The owner's values this desk reads.
#[derive(Debug, Clone, Copy, Default)]
pub struct Limits {
    pub bulk_enrol_rows: Option<i64>,
    pub inactive_days: Option<i64>,
    pub report_retention_hours: Option<i64>,
    pub export_rows: Option<i64>,
}

/// The JavaScript `\s` set.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// Lower-case trimmed, so one person's address is one key however it was typed.
pub fn normalise_address(address: &str) -> String {
    js_trim(address).to_lowercase()
}

/// `address.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)`.
pub fn is_address(address: &str) -> bool {
    if address.encode_utf16().count() > 254 || address.chars().any(js_space) {
        return false;
    }
    let mut parts = address.split('@');
    let (Some(name), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    // `[^\s@]+\.[^\s@]+`: some dot with something on each side.
    !name.is_empty()
        && domain
            .char_indices()
            .any(|(i, c)| c == '.' && i > 0 && i + 1 < domain.len())
}

/// The first letter of the name and the whole domain.
pub fn mask_address(address: &str) -> String {
    let mut parts = address.split('@');
    let name = parts.next().unwrap_or("");
    let domain = parts.next().unwrap_or("");
    format!("{}***@{domain}", js_slice(name, 1))
}

fn require_reason(reason: &str) -> Result<String, Refusal> {
    let trimmed = js_trim(reason);
    if trimmed.is_empty() {
        return Err(refuse("academy.reason_required", "a reason is required"));
    }
    Ok(trimmed.to_owned())
}

fn undefined(field: &str) -> Refusal {
    Refusal::Internal {
        message: format!("Cannot read properties of undefined (reading '{field}')"),
        code: None,
    }
}

const EVENT_COLUMNS: &str = "key, path, user_id::text, source, bypassed, reason, actor_id::text, floor(extract(epoch from at)*1000)::int8";

fn event_of(r: &Row) -> Result<Json, Refusal> {
    Ok(Json::obj([
        ("key", Json::str(col::<String>(r, 0)?)),
        ("path", Json::str(col::<String>(r, 1)?)),
        ("userId", Json::str(col::<String>(r, 2)?)),
        ("source", Json::str(col::<String>(r, 3)?)),
        ("bypassed", strs(&col::<Vec<String>>(r, 4)?)),
        ("reason", Json::str(col::<String>(r, 5)?)),
        ("actorId", Json::str(col::<String>(r, 6)?)),
        ("at", iso(at(r, 7)?)),
    ]))
}

/// A course's seat cap, enrolment window and visibility (`CourseTerms`); no row is no cap, no window, published.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Terms {
    pub seat_cap: Option<i64>,
    pub opens_at: Option<Instant>,
    pub closes_at: Option<Instant>,
    pub visibility: String,
}

/// `CourseTermsStore.read(path)`.
fn read_terms<C: GenericClient>(db: &mut C, path: &str) -> Result<Terms, Refusal> {
    let row = first(
        db,
        &format!(
            "SELECT seat_cap, {}, {}, visibility FROM academy.course_enrolment_terms WHERE path = $1::text",
            ms("opens_at"),
            ms("closes_at")
        ),
        &[&path],
    )?;
    Ok(match row {
        Some(r) => Terms {
            seat_cap: col::<Option<i32>>(&r, 0)?.map(i64::from),
            opens_at: at_opt(&r, 1)?,
            closes_at: at_opt(&r, 2)?,
            visibility: col(&r, 3)?,
        },
        None => Terms {
            seat_cap: None,
            opens_at: None,
            closes_at: None,
            visibility: "published".to_owned(),
        },
    })
}

/// `PROGRAMME_CATALOG`'s prerequisites (`curriculum/programmes.ts`): every course has none today.
fn prerequisites(_path: &str) -> &'static [&'static str] {
    &[]
}

/// Every reason the course is closed to a learner enrolling themselves now: what a staff enrolment goes past.
pub fn closed_reasons(terms: &Terms, taken: i64, now: Instant) -> Vec<String> {
    let mut out = Vec::new();
    if terms.visibility != "published" {
        out.push(terms.visibility.clone());
    }
    if terms.opens_at.is_some_and(|o| now.0 < o.0) {
        out.push("window_not_started".to_owned());
    } else if terms.closes_at.is_some_and(|c| now.0 >= c.0) {
        out.push("window_ended".to_owned());
    }
    if terms.seat_cap.is_some_and(|cap| taken >= cap) {
        out.push("full".to_owned());
    }
    out
}

/// One learner enrolled by staff, past whatever closes the course to them, with the reason.
pub fn enrol(
    pool: &Db<'_>,
    path: &str,
    user_id: &str,
    reason: &str,
    actor_id: &str,
    source: &str,
    now: Instant,
) -> Result<Json, Refusal> {
    let reason = require_reason(reason)?;
    let terms = with_client(pool.get()?, |db| {
        let active = rows(
            db,
            "SELECT path_slug FROM academy.cert_enrollments WHERE user_id = $1::text::uuid AND left_at IS NULL",
            &[&user_id],
        )?;
        let mut held = Vec::new();
        for r in &active {
            held.push(col::<String>(r, 0)?);
        }
        let missing: Vec<&str> = prerequisites(path)
            .iter()
            .copied()
            .filter(|p| !held.iter().any(|h| h == p))
            .collect();
        if !missing.is_empty() {
            return Err(refuse(
                "academy.prerequisite_unmet",
                &format!("academy.prerequisite_unmet missing={}", missing.join(",")),
            ));
        }
        read_terms(db, path)
    })?;
    begin(pool.get()?, |tx| {
        // The same lock as a learner's own enrolment under a cap, so the seat count and this enrolment agree.
        exec(
            tx,
            "SELECT pg_advisory_xact_lock(hashtext($1::text))",
            &[&format!("academy.course_seats:{path}")],
        )?;
        if first(
            tx,
            "SELECT id::text FROM academy.cert_enrollments WHERE user_id = $1::text::uuid AND path_slug = $2::text AND left_at IS NULL",
            &[&user_id, &path],
        )?
        .is_some()
        {
            return Ok(Json::obj([("outcome", Json::str("already_enrolled")), ("event", Json::Null)]));
        }
        let counts = first(
            tx,
            "SELECT (SELECT count(*)::int FROM academy.cert_enrollments WHERE path_slug = $1::text AND left_at IS NULL) AS taken,
                    (SELECT count(*)::int FROM academy.cert_enrollments WHERE path_slug = $1::text AND user_id = $2::text::uuid) + 1 AS n",
            &[&path, &user_id],
        )?
        .ok_or_else(|| undefined("taken"))?;
        let taken: i32 = col(&counts, 0)?;
        let n: i32 = col(&counts, 1)?;
        let bypassed = closed_reasons(&terms, i64::from(taken), now);
        exec(
            tx,
            "INSERT INTO academy.cert_enrollments (user_id, path_slug, enrolled_at) VALUES ($1::text::uuid, $2::text, $3::text::timestamptz)",
            &[&user_id, &path, &now.iso()],
        )?;
        let event = first(
            tx,
            &format!(
                "INSERT INTO academy.staff_enrolment_events (key, path, user_id, source, bypassed, reason, actor_id, at)
                 VALUES ($1::text, $2::text, $3::text::uuid, $4::text, $5::text[], $6::text, $7::text::uuid, $8::text::timestamptz)
                 RETURNING {EVENT_COLUMNS}"
            ),
            &[
                &format!("enrol:{path}:{user_id}:{n}"),
                &path,
                &user_id,
                &source,
                &bypassed,
                &reason,
                &actor_id,
                &now.iso(),
            ],
        )?
        .ok_or_else(|| undefined("key"))?;
        Ok(Json::obj([
            ("outcome", Json::str("enrolled")),
            ("event", event_of(&event)?),
        ]))
    })
}

/// The newest staff enrolments, of one course or all, with what each went past and why.
pub fn events(
    pool: &Db<'_>,
    path: Option<&str>,
    user_id: Option<&str>,
    limit: i64,
) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let list = rows(
            db,
            &format!(
                "SELECT {EVENT_COLUMNS} FROM academy.staff_enrolment_events
                  WHERE ($1::text IS NULL OR path = $1::text)
                    AND ($2::text::uuid IS NULL OR user_id = $2::text::uuid)
                  ORDER BY at DESC, key DESC
                  LIMIT $3::int8"
            ),
            &[&path, &user_id, &limit],
        )?;
        Ok(Json::Array(
            list.iter().map(event_of).collect::<Result<_, _>>()?,
        ))
    })
}

/// One address of a bulk upload, as the console resolved it.
#[derive(Debug, Clone)]
pub struct UploadRow {
    pub address: String,
    pub user_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BulkRow {
    address: String,
    outcome: &'static str,
    code: Option<&'static str>,
    user_id: Option<String>,
}

fn bulk_row_json(address: Json, outcome: Json, code: Json, user_id: Json) -> Json {
    Json::obj([
        ("address", address),
        ("outcome", outcome),
        ("code", code),
        ("userId", user_id),
    ])
}

fn bulk_row(r: &BulkRow) -> Json {
    bulk_row_json(
        Json::str(r.address.clone()),
        Json::str(r.outcome),
        r.code.map_or(Json::Null, Json::str),
        str_opt(r.user_id.clone()),
    )
}

/// A stored row read back from jsonb, re-emitted in the schema's key order.
fn stored_row(v: &Json) -> Json {
    let field = |k: &str| v.get(k).cloned().unwrap_or(Json::Null);
    bulk_row_json(
        field("address"),
        field("outcome"),
        field("code"),
        field("userId"),
    )
}

fn stored_upload<C: GenericClient>(
    db: &mut C,
    key: &str,
) -> Result<Option<(String, String, Json, Instant)>, Refusal> {
    let row = first(
        db,
        &format!(
            "SELECT key, path, rows::text, {} FROM academy.bulk_enrol_uploads WHERE key = $1::text",
            ms("at")
        ),
        &[&key],
    )?;
    let Some(row) = row else {
        return Ok(None);
    };
    let text: String = col(&row, 2)?;
    let parsed = json::parse(&text).map_err(|e| Refusal::Internal {
        message: e.message,
        code: None,
    })?;
    let list = match parsed {
        Json::Array(items) => Json::Array(items.iter().map(stored_row).collect()),
        other => other,
    };
    Ok(Some((col(&row, 0)?, col(&row, 1)?, list, at(&row, 3)?)))
}

fn upload_json(key: String, path: String, rows: Json, replayed: bool, at: Instant) -> Json {
    Json::obj([
        ("key", Json::str(key)),
        ("path", Json::str(path)),
        ("rows", rows),
        ("replayed", Json::Bool(replayed)),
        ("mail", Json::str("none")),
        ("at", iso(at)),
    ])
}

/// The upload's key: its course and the SHA-256 of its normalised addresses, sorted as JavaScript sorts, joined by `\n`.
pub fn upload_key(path: &str, addresses: &[String]) -> String {
    let mut sorted: Vec<&String> = addresses.iter().collect();
    sorted.sort_by(|a, b| js_cmp(a, b));
    let joined = sorted
        .iter()
        .map(|s| s.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    format!("bulkenrol:{path}:{}", sha256_hex(&joined))
}

/// A bulk upload: each address enrolled, already enrolled, or listed with its refusal. No mail is sent.
pub fn bulk_enrol(
    pool: &Db<'_>,
    limits: &Limits,
    path: &str,
    upload: &[UploadRow],
    reason: &str,
    actor_id: &str,
    now: Instant,
) -> Result<Json, Refusal> {
    let limit = setting(limits.bulk_enrol_rows, "academy.bulk_limit_unset")?;
    let reason = require_reason(reason)?;
    if upload.is_empty() {
        return Err(refuse(
            "academy.address_invalid",
            "the upload holds no address",
        ));
    }
    let count = i64::try_from(upload.len()).unwrap_or(i64::MAX);
    if count > limit {
        return Err(refuse(
            "academy.bulk_limit_exceeded",
            &format!("{count} addresses, over the {limit} one upload may hold"),
        ));
    }
    let addresses: Vec<String> = upload
        .iter()
        .map(|r| normalise_address(&r.address))
        .collect();
    let key = upload_key(path, &addresses);
    if let Some((k, p, list, at)) = with_client(pool.get()?, |db| stored_upload(db, &key))? {
        return Ok(upload_json(k, p, list, true, at));
    }
    let mut seen: Vec<&String> = Vec::new();
    let mut out: Vec<BulkRow> = Vec::new();
    for (row, address) in upload.iter().zip(addresses.iter()) {
        let answer = |outcome, code, user_id| BulkRow {
            address: address.clone(),
            outcome,
            code,
            user_id,
        };
        if !is_address(address) {
            out.push(answer("refused", Some("academy.address_invalid"), None));
        } else if seen.contains(&address) {
            out.push(answer("refused", Some("academy.duplicate_address"), None));
        } else if let Some(user_id) = &row.user_id {
            match enrol(pool, path, user_id, &reason, actor_id, "bulk", clock()) {
                Ok(done) => {
                    let outcome = match done.get("outcome") {
                        Some(Json::String(s)) if s == "enrolled" => "enrolled",
                        _ => "already_enrolled",
                    };
                    out.push(answer(outcome, None, Some(user_id.clone())));
                }
                Err(Refusal::Trpc(e))
                    if e.cause.as_deref() == Some("academy.prerequisite_unmet") =>
                {
                    out.push(answer(
                        "refused",
                        Some("academy.prerequisite_unmet"),
                        Some(user_id.clone()),
                    ));
                }
                Err(e) => return Err(e),
            }
        } else {
            out.push(answer("refused", Some("academy.learner_not_found"), None));
        }
        seen.push(address);
    }
    let rows_json = Json::Array(out.iter().map(bulk_row).collect());
    with_client(pool.get()?, |db| {
        let kept = first(
            db,
            &format!(
                "INSERT INTO academy.bulk_enrol_uploads (key, path, rows, reason, actor_id, at)
                 VALUES ($1::text, $2::text, $3::text::jsonb, $4::text, $5::text::uuid, $6::text::timestamptz)
                 ON CONFLICT (key) DO NOTHING
                 RETURNING {}",
                ms("at")
            ),
            &[&key, &path, &rows_json.compact(), &reason, &actor_id, &now.iso()],
        )?;
        match kept {
            Some(k) => Ok(upload_json(
                key.clone(),
                path.to_owned(),
                rows_json.clone(),
                false,
                at(&k, 0)?,
            )),
            None => {
                let (k, p, list, at) = stored_upload(db, &key)?.ok_or_else(|| undefined("key"))?;
                Ok(upload_json(k, p, list, true, at))
            }
        }
    })
}

const INVITE_COLUMNS: &str =
    "key, path, address_mask, reason, invited_by::text, floor(extract(epoch from at)*1000)::int8";

fn invite_fields(r: &Row) -> Result<Vec<(String, Json)>, Refusal> {
    Ok(vec![
        ("key".to_owned(), Json::str(col::<String>(r, 0)?)),
        ("path".to_owned(), Json::str(col::<String>(r, 1)?)),
        ("addressMask".to_owned(), Json::str(col::<String>(r, 2)?)),
        ("reason".to_owned(), Json::str(col::<String>(r, 3)?)),
        ("invitedBy".to_owned(), Json::str(col::<String>(r, 4)?)),
        ("at".to_owned(), iso(at(r, 5)?)),
        ("mail".to_owned(), Json::str("vendor.email")),
    ])
}

/// An address invited to a course, once per course and address; the mail step needs an email provider.
pub fn invite(
    pool: &Db<'_>,
    path: &str,
    address: &str,
    reason: &str,
    actor_id: &str,
    now: Instant,
) -> Result<Json, Refusal> {
    let reason = require_reason(reason)?;
    let address = normalise_address(address);
    if !is_address(&address) {
        return Err(refuse(
            "academy.address_invalid",
            "that is not an email address",
        ));
    }
    let hash = sha256_hex(&address);
    let key = format!("invite:{path}:{hash}");
    with_client(pool.get()?, |db| {
        let made = first(
            db,
            &format!(
                "INSERT INTO academy.course_invitations (key, path, address_hash, address_mask, reason, invited_by, at)
                 VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text::uuid, $7::text::timestamptz)
                 ON CONFLICT (key) DO NOTHING
                 RETURNING {INVITE_COLUMNS}"
            ),
            &[&key, &path, &hash, &mask_address(&address), &reason, &actor_id, &now.iso()],
        )?;
        let (row, replayed) = match made {
            Some(r) => (r, false),
            None => (
                first(
                    db,
                    &format!("SELECT {INVITE_COLUMNS} FROM academy.course_invitations WHERE key = $1::text"),
                    &[&key],
                )?
                .ok_or_else(|| undefined("key"))?,
                true,
            ),
        };
        let mut fields = invite_fields(&row)?;
        fields.push(("replayed".to_owned(), Json::Bool(replayed)));
        Ok(Json::Object(fields))
    })
}

pub fn invitations(pool: &Db<'_>, path: Option<&str>, limit: i64) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let list = rows(
            db,
            &format!(
                "SELECT {INVITE_COLUMNS} FROM academy.course_invitations
                  WHERE $1::text IS NULL OR path = $1::text
                  ORDER BY at DESC, key DESC
                  LIMIT $2::int8"
            ),
            &[&path, &limit],
        )?;
        let mut out = Vec::new();
        for r in &list {
            out.push(Json::Object(invite_fields(r)?));
        }
        Ok(Json::Array(out))
    })
}

fn emails_json(path: &str, on: bool) -> Json {
    Json::obj([("path", Json::str(path)), ("on", Json::Bool(on))])
}

/// A learner's own course email switch.
pub fn set_course_emails(
    pool: &Db<'_>,
    user_id: &str,
    path: &str,
    on: bool,
    now: Instant,
) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        exec(
            db,
            "INSERT INTO academy.course_email_optouts (user_id, path, opted_out, at)
             VALUES ($1::text::uuid, $2::text, $3::bool, $4::text::timestamptz)
             ON CONFLICT (user_id, path) DO UPDATE SET opted_out = EXCLUDED.opted_out, at = EXCLUDED.at",
            &[&user_id, &path, &!on, &now.iso()],
        )?;
        Ok(emails_json(path, on))
    })
}

pub fn course_emails(pool: &Db<'_>, user_id: &str, path: &str) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let row = first(
            db,
            "SELECT opted_out FROM academy.course_email_optouts WHERE user_id = $1::text::uuid AND path = $2::text",
            &[&user_id, &path],
        )?;
        let opted_out = match row {
            Some(r) => col::<bool>(&r, 0)?,
            None => false,
        };
        Ok(emails_json(path, !opted_out))
    })
}

fn email_columns() -> String {
    format!(
        "m.id::text, m.key, m.path, m.subject, m.inactive_days, m.state, m.refusal, m.actor_id::text, {},
  (SELECT count(*)::int FROM academy.bulk_email_recipients r WHERE r.email_id = m.id AND r.state = 'not_sent') AS not_sent,
  (SELECT count(*)::int FROM academy.bulk_email_recipients r WHERE r.email_id = m.id AND r.state = 'sent') AS sent,
  (SELECT count(*)::int FROM academy.bulk_email_recipients r WHERE r.email_id = m.id AND r.state = 'skipped_opted_out') AS skipped_opted_out,
  (SELECT count(*)::int FROM academy.bulk_email_recipients r WHERE r.email_id = m.id AND r.state = 'skipped_inactive') AS skipped_inactive",
        ms("m.at")
    )
}

fn email_fields(r: &Row) -> Result<Vec<(String, Json)>, Refusal> {
    Ok(vec![
        ("id".to_owned(), Json::str(col::<String>(r, 0)?)),
        ("key".to_owned(), Json::str(col::<String>(r, 1)?)),
        ("path".to_owned(), Json::str(col::<String>(r, 2)?)),
        ("subject".to_owned(), Json::str(col::<String>(r, 3)?)),
        ("inactiveDays".to_owned(), int(col(r, 4)?)),
        ("state".to_owned(), Json::str(col::<String>(r, 5)?)),
        ("refusal".to_owned(), str_opt(col(r, 6)?)),
        ("actorId".to_owned(), Json::str(col::<String>(r, 7)?)),
        ("at".to_owned(), iso(at(r, 8)?)),
        (
            "counts".to_owned(),
            Json::obj([
                ("not_sent", int(col(r, 9)?)),
                ("sent", int(col(r, 10)?)),
                ("skipped_opted_out", int(col(r, 11)?)),
                ("skipped_inactive", int(col(r, 12)?)),
            ]),
        ),
    ])
}

fn detail<C: GenericClient>(db: &mut C, row: &Row) -> Result<Vec<(String, Json)>, Refusal> {
    let id: String = col(row, 0)?;
    let recipients = rows(
        db,
        "SELECT user_id::text, state FROM academy.bulk_email_recipients WHERE email_id = $1::text::uuid ORDER BY user_id",
        &[&id],
    )?;
    let mut list = Vec::new();
    for r in &recipients {
        list.push(Json::obj([
            ("userId", Json::str(col::<String>(r, 0)?)),
            ("state", Json::str(col::<String>(r, 1)?)),
        ]));
    }
    let mut fields = email_fields(row)?;
    fields.push(("recipients".to_owned(), Json::Array(list)));
    Ok(fields)
}

fn email_by_key<C: GenericClient>(
    db: &mut C,
    key: &str,
) -> Result<Option<Vec<(String, Json)>>, Refusal> {
    let row = first(
        db,
        &format!(
            "SELECT {} FROM academy.bulk_emails m WHERE m.key = $1::text",
            email_columns()
        ),
        &[&key],
    )?;
    match row {
        Some(r) => Ok(Some(detail(db, &r)?)),
        None => Ok(None),
    }
}

fn with_replayed(mut fields: Vec<(String, Json)>, replayed: bool) -> Json {
    fields.push(("replayed".to_owned(), Json::Bool(replayed)));
    Json::Object(fields)
}

/// A course email to the course's learners: written first with every recipient's state; the send is refused
/// `vendor.email` and nobody is marked sent. A retry with the same key answers the stored email.
#[expect(
    clippy::too_many_arguments,
    reason = "the TypeScript method takes these as one input object; each is a named field of it"
)]
pub fn send_bulk_email(
    pool: &Db<'_>,
    limits: &Limits,
    path: &str,
    subject: &str,
    body: &str,
    key: &str,
    actor_id: &str,
    now: Instant,
) -> Result<Json, Refusal> {
    let days = setting(limits.inactive_days, "academy.inactivity_period_unset")?;
    let subject = js_trim(subject);
    if subject.is_empty() || js_trim(body).is_empty() {
        return Err(refuse(
            "academy.email_incomplete",
            "a course email needs a subject and a body",
        ));
    }
    if let Some(prior) = with_client(pool.get()?, |db| email_by_key(db, key))? {
        return Ok(with_replayed(prior, true));
    }
    let made = begin(pool.get()?, |tx| {
        let recipients = rows(
            tx,
            &format!(
                "SELECT e.user_id::text,
                        coalesce(o.opted_out, false) AS opted_out,
                        {} AS last_active
                   FROM academy.cert_enrollments e
                   LEFT JOIN academy.course_email_optouts o ON o.user_id = e.user_id AND o.path = e.path_slug
                   LEFT JOIN academy.learning_state s ON s.user_id = e.user_id
                  WHERE e.path_slug = $1::text AND e.left_at IS NULL",
                ms("greatest(e.enrolled_at, coalesce(s.last_opened_at, e.enrolled_at))")
            ),
            &[&path],
        )?;
        if recipients.is_empty() {
            return Err(refuse(
                "academy.audience_empty",
                "no learner is enrolled in this course",
            ));
        }
        let since = now.0 - days * 86_400_000;
        let days32 = i32::try_from(days).unwrap_or(i32::MAX);
        let email = first(
            tx,
            "INSERT INTO academy.bulk_emails (key, path, subject, body, inactive_days, state, refusal, actor_id, at)
             VALUES ($1::text, $2::text, $3::text, $4::text, $5::int4, 'refused', 'vendor.email', $6::text::uuid, $7::text::timestamptz)
             ON CONFLICT (key) DO NOTHING
             RETURNING id::text",
            &[&key, &path, &subject, &body, &days32, &actor_id, &now.iso()],
        )?;
        let Some(email) = email else {
            return Ok(None);
        };
        let id: String = col(&email, 0)?;
        let mut users = Vec::new();
        let mut states = Vec::new();
        for r in &recipients {
            users.push(col::<String>(r, 0)?);
            let opted_out: bool = col(r, 1)?;
            let last_active = at(r, 2)?;
            states.push(if opted_out {
                "skipped_opted_out".to_owned()
            } else if last_active.0 < since {
                "skipped_inactive".to_owned()
            } else {
                "not_sent".to_owned()
            });
        }
        exec(
            tx,
            "INSERT INTO academy.bulk_email_recipients (email_id, user_id, state)
             SELECT $1::text::uuid, u, s FROM unnest($2::text[]::uuid[], $3::text[]) AS t(u, s)",
            &[&id, &users, &states],
        )?;
        Ok(Some(id))
    })?;
    // Sending is the mail path's: this build has no email provider, so the email stays refused and nobody is sent.
    let stored =
        with_client(pool.get()?, |db| email_by_key(db, key))?.ok_or_else(|| undefined("id"))?;
    Ok(with_replayed(stored, made.is_none()))
}

pub fn bulk_emails(pool: &Db<'_>, path: Option<&str>, limit: i64) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let list = rows(
            db,
            &format!(
                "SELECT {} FROM academy.bulk_emails m
                  WHERE $1::text IS NULL OR m.path = $1::text
                  ORDER BY m.at DESC, m.key DESC
                  LIMIT $2::int8",
                email_columns()
            ),
            &[&path, &limit],
        )?;
        let mut out = Vec::new();
        for r in &list {
            out.push(Json::Object(email_fields(r)?));
        }
        Ok(Json::Array(out))
    })
}

pub fn bulk_email(pool: &Db<'_>, id: &str) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let row = first(
            db,
            &format!(
                "SELECT {} FROM academy.bulk_emails m WHERE m.id = $1::text::uuid",
                email_columns()
            ),
            &[&id],
        )?
        .ok_or_else(|| refuse("academy.email_not_found", "no course email has that id"))?;
        Ok(Json::Object(detail(db, &row)?))
    })
}

fn report_columns() -> String {
    format!(
        "id::text, key, kind, tag, requested_by::text, state, rows, content_hash, failure, {}, {}, {}",
        ms("requested_at"),
        ms("finished_at"),
        ms("expires_at")
    )
}

fn task_fields(r: &Row, now: Instant) -> Result<Vec<(String, Json)>, Refusal> {
    let expires = at_opt(r, 11)?;
    let rows_n: Option<i32> = col(r, 6)?;
    Ok(vec![
        ("id".to_owned(), Json::str(col::<String>(r, 0)?)),
        ("key".to_owned(), Json::str(col::<String>(r, 1)?)),
        ("kind".to_owned(), Json::str(col::<String>(r, 2)?)),
        ("tag".to_owned(), str_opt(col(r, 3)?)),
        ("requestedBy".to_owned(), Json::str(col::<String>(r, 4)?)),
        ("state".to_owned(), Json::str(col::<String>(r, 5)?)),
        ("rows".to_owned(), rows_n.map_or(Json::Null, int)),
        ("sha256".to_owned(), str_opt(col(r, 7)?)),
        ("failure".to_owned(), str_opt(col(r, 8)?)),
        ("requestedAt".to_owned(), iso(at(r, 9)?)),
        ("finishedAt".to_owned(), iso_opt(at_opt(r, 10)?)),
        ("expiresAt".to_owned(), iso_opt(expires)),
        (
            "expired".to_owned(),
            Json::Bool(expires.is_some_and(|e| e.0 <= now.0)),
        ),
    ])
}

/// A learner export filtered by tag, requested once per press of Request; it runs in the background through
/// `schedule`, which is handed the task's id.
pub fn request_learner_export(
    pool: &Db<'_>,
    limits: &Limits,
    tag: Option<&str>,
    key: &str,
    actor_id: &str,
    now: Instant,
    schedule: &dyn Fn(String),
) -> Result<Json, Refusal> {
    let retention = setting(
        limits.report_retention_hours,
        "academy.report_retention_unset",
    )?;
    let limit = setting(limits.export_rows, "academy.report_limit_unset")?;
    let limit32 = i32::try_from(limit).unwrap_or(i32::MAX);
    let retention32 = i32::try_from(retention).unwrap_or(i32::MAX);
    let (fields, made) = with_client(pool.get()?, |db| {
        let made = first(
            db,
            &format!(
                "INSERT INTO academy.report_tasks (key, kind, tag, requested_by, state, row_limit, retention_hours, requested_at)
                 VALUES ($1::text, 'learners', $2::text, $3::text::uuid, 'queued', $4::int4, $5::int4, $6::text::timestamptz)
                 ON CONFLICT (key) DO NOTHING
                 RETURNING {}",
                report_columns()
            ),
            &[&key, &tag, &actor_id, &limit32, &retention32, &now.iso()],
        )?;
        match made {
            Some(r) => Ok((task_fields(&r, now)?, Some(col::<String>(&r, 0)?))),
            None => {
                let kept = first(
                    db,
                    &format!(
                        "SELECT {} FROM academy.report_tasks WHERE key = $1::text",
                        report_columns()
                    ),
                    &[&key],
                )?
                .ok_or_else(|| undefined("id"))?;
                Ok((task_fields(&kept, now)?, None))
            }
        }
    })?;
    let replayed = made.is_none();
    if let Some(id) = made {
        schedule(id);
    }
    let mut fields = fields;
    fields.push(("replayed".to_owned(), Json::Bool(replayed)));
    Ok(Json::Object(fields))
}

/// One learner of an export: their id, open courses and tags.
pub type Learner = (String, Vec<String>, Vec<String>);

/// The learners carrying `tag` (or everyone), with their courses and tags, at most `limit`.
fn tagged_learners<C: GenericClient>(
    db: &mut C,
    tag: Option<&str>,
    limit: i64,
) -> Result<Vec<Learner>, Refusal> {
    let ids = rows(
        db,
        "SELECT user_id::text FROM (
           SELECT user_id FROM academy.cert_enrollments WHERE left_at IS NULL
           UNION SELECT user_id FROM academy.access_grants
           UNION SELECT user_id FROM academy.learner_tags
         ) people
         WHERE $1::text IS NULL OR EXISTS (SELECT 1 FROM academy.learner_tags t WHERE t.user_id = people.user_id AND t.tag = $1::text)
         ORDER BY user_id
         LIMIT $2::int8",
        &[&tag, &limit],
    )?;
    let mut users = Vec::new();
    for r in &ids {
        users.push(col::<String>(r, 0)?);
    }
    if users.is_empty() {
        return Ok(Vec::new());
    }
    let paths = rows(
        db,
        "SELECT user_id::text, path_slug FROM academy.cert_enrollments WHERE left_at IS NULL AND user_id = ANY($1::text[]::uuid[]) ORDER BY path_slug",
        &[&users],
    )?;
    let tags = rows(
        db,
        "SELECT user_id::text, tag FROM academy.learner_tags WHERE user_id = ANY($1::text[]::uuid[]) ORDER BY tag",
        &[&users],
    )?;
    let mut out = Vec::new();
    for u in users {
        let mut ps = Vec::new();
        for p in &paths {
            if col::<String>(p, 0)? == u {
                ps.push(col::<String>(p, 1)?);
            }
        }
        let mut ts = Vec::new();
        for t in &tags {
            if col::<String>(t, 0)? == u {
                ts.push(col::<String>(t, 1)?);
            }
        }
        out.push((u, ps, ts));
    }
    Ok(out)
}

/// The export's CSV: a title line, a header and one line per learner, joined by `\n`.
pub fn export_csv(tag: Option<&str>, finished_at: Instant, learners: &[Learner]) -> String {
    let line = |cells: &[String]| {
        cells
            .iter()
            .map(|c| csv_field(c))
            .collect::<Vec<_>>()
            .join(",")
    };
    let mut lines = vec![
        line(&[
            "learner export".to_owned(),
            tag.map_or_else(|| "every learner".to_owned(), |t| format!("tag {t}")),
            "finished at".to_owned(),
            finished_at.iso(),
        ]),
        line(&[
            "learner".to_owned(),
            "courses".to_owned(),
            "tags".to_owned(),
        ]),
    ];
    for (u, ps, ts) in learners {
        lines.push(line(&[u.clone(), ps.join(" "), ts.join(" ")]));
    }
    lines.join("\n")
}

/// Runs one queued export: only the learners carrying the tag, with its finish time and the CSV's SHA-256. A failure
/// is written on the task.
pub fn run_export(pool: &Pool, id: &str) -> Result<(), Refusal> {
    with_client(pool, |db| {
        let task = first(
            db,
            "UPDATE academy.report_tasks SET state = 'running' WHERE id = $1::text::uuid AND state = 'queued'
             RETURNING tag, row_limit, retention_hours",
            &[&id],
        )?;
        let Some(task) = task else {
            return Ok(());
        };
        let tag: Option<String> = col(&task, 0)?;
        let row_limit: i32 = col(&task, 1)?;
        let retention_hours: i32 = col(&task, 2)?;
        let done = (|| -> Result<(), Refusal> {
            let learners = tagged_learners(db, tag.as_deref(), i64::from(row_limit) + 1)?;
            let count = i32::try_from(learners.len()).unwrap_or(i32::MAX);
            if count > row_limit {
                exec(
                    db,
                    "UPDATE academy.report_tasks SET state = 'failed', failure = $1::text, finished_at = now() WHERE id = $2::text::uuid",
                    &[
                        &format!("academy.report_too_large: more than {row_limit} learners"),
                        &id,
                    ],
                )?;
                return Ok(());
            }
            let finished_at = clock();
            let csv = export_csv(tag.as_deref(), finished_at, &learners);
            let expires = Instant(finished_at.0 + i64::from(retention_hours) * 3_600_000);
            exec(
                db,
                "UPDATE academy.report_tasks
                    SET state = 'done', rows = $1::int4, content = $2::text, content_hash = $3::text,
                        finished_at = $4::text::timestamptz, expires_at = $5::text::timestamptz
                  WHERE id = $6::text::uuid",
                &[&count, &csv, &sha256_hex(&csv), &finished_at.iso(), &expires.iso(), &id],
            )?;
            Ok(())
        })();
        if let Err(e) = done {
            let message = match &e {
                Refusal::Internal { message, .. } => message.clone(),
                other => format!("{other:?}"),
            };
            exec(
                db,
                "UPDATE academy.report_tasks SET state = 'failed', failure = $1::text, finished_at = now() WHERE id = $2::text::uuid",
                &[&js_slice(&message, 300), &id],
            )?;
        }
        Ok(())
    })
}

pub fn reports(pool: &Db<'_>, limit: i64, now: Instant) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let list = rows(
            db,
            &format!(
                "SELECT {} FROM academy.report_tasks ORDER BY requested_at DESC, key DESC LIMIT $1::int8",
                report_columns()
            ),
            &[&limit],
        )?;
        let mut out = Vec::new();
        for r in &list {
            out.push(Json::Object(task_fields(r, now)?));
        }
        Ok(Json::Array(out))
    })
}

/// A finished export's CSV, exactly as it was made; an unfinished or expired one refuses by name.
pub fn report_file(pool: &Db<'_>, id: &str, now: Instant) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let row = first(
            db,
            &format!(
                "SELECT {}, content FROM academy.report_tasks WHERE id = $1::text::uuid",
                report_columns()
            ),
            &[&id],
        )?
        .ok_or_else(|| refuse("academy.report_not_found", "no report has that id"))?;
        let state: String = col(&row, 5)?;
        let content: Option<String> = col(&row, 12)?;
        let expires = at_opt(&row, 11)?;
        let Some(csv) = content.filter(|_| state == "done") else {
            return Err(refuse(
                "academy.report_not_ready",
                &format!("the report is {state}"),
            ));
        };
        if let Some(e) = expires.filter(|e| e.0 <= now.0) {
            return Err(refuse(
                "academy.report_expired",
                &format!("the report expired at {}", e.iso()),
            ));
        }
        let mut fields = task_fields(&row, now)?;
        fields.push(("csv".to_owned(), Json::str(csv)));
        Ok(Json::Object(fields))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_is_what_the_typescript_pattern_takes() {
        assert!(is_address("a@b.co"));
        assert!(!is_address("a@b"));
        assert!(!is_address("a@.b"));
        assert!(!is_address("a@b."));
        assert!(!is_address("a b@c.d"));
        assert!(!is_address("a@b@c.d"));
        assert!(!is_address("@b.c"));
        assert!(is_address("a@b..c"));
        assert!(!is_address(&format!("{}@b.co", "a".repeat(250))));
    }

    #[test]
    fn a_mask_keeps_one_letter_and_the_domain() {
        assert_eq!(mask_address("ada@example.com"), "a***@example.com");
        assert_eq!(normalise_address("  Ada@Example.COM "), "ada@example.com");
    }

    #[test]
    fn the_upload_key_does_not_hang_on_the_order() {
        let a = upload_key("markets", &["b@x.io".to_owned(), "a@x.io".to_owned()]);
        let b = upload_key("markets", &["a@x.io".to_owned(), "b@x.io".to_owned()]);
        assert_eq!(a, b);
        assert_eq!(
            a,
            format!("bulkenrol:markets:{}", sha256_hex("a@x.io\nb@x.io"))
        );
    }

    #[test]
    fn a_staff_enrolment_names_everything_it_went_past() {
        let terms = Terms {
            seat_cap: Some(1),
            opens_at: Some(Instant(2_000)),
            closes_at: None,
            visibility: "hidden".to_owned(),
        };
        assert_eq!(
            closed_reasons(&terms, 1, Instant(1_000)),
            ["hidden", "window_not_started", "full"]
        );
        let open = Terms {
            seat_cap: None,
            opens_at: None,
            closes_at: Some(Instant(1_000)),
            visibility: "published".to_owned(),
        };
        assert_eq!(closed_reasons(&open, 0, Instant(1_000)), ["window_ended"]);
    }

    #[test]
    fn the_export_csv_is_lines_joined_by_newline() {
        let csv = export_csv(
            Some("vip"),
            Instant(0),
            &[(
                "u".to_owned(),
                vec!["markets".to_owned()],
                vec!["vip".to_owned(), "=x".to_owned()],
            )],
        );
        assert_eq!(
            csv,
            "learner export,tag vip,finished at,1970-01-01T00:00:00.000Z\nlearner,courses,tags\nu,markets,vip =x"
        );
    }
}
