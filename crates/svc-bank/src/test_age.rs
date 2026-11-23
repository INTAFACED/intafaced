//! `POST /internal/test/age` (`registerTestAgeDoor` from the service kit, with svc-bank's subjects in
//! `src/test-age-door.ts`): a TEST stack's door that moves one record's clock back, so a journey can see what a person
//! sees once time has passed. Closed unless `TEST_AGE_DOOR=on`, which refuses to start outside dev or test.
//!
//! A signed service call only (svc-edge's signature is not one), its body bound; then the door's switch (403), the
//! body (400, zod's issues as `<path>: <message>`), the subject (400), and the record (404 when none it may age).
//! Subjects: an open shared pot invite, an open business invite, a pay-yourself rule's next run, and an active
//! scheduled transfer's start, end and next run.

use service_kit::json::{self, Json};
use service_kit::s2s_verify::BodyBind;
use service_kit::schema::{Outcome, Schema};
use service_kit::server::{Request, Response};

use crate::db::{Store, StoreError, with_client};
use crate::door::BankDoor;
use crate::refines::BankRefines;

pub const PATH: &str = "/internal/test/age";
pub const ENV: &str = "TEST_AGE_DOOR";
/// The longest a record is aged at once (`TEST_AGE_MAX_MS`): a day.
pub const MAX_MS: i64 = 86_400_000;
/// The subjects, in the order `index.ts` names them.
pub const SUBJECTS: [&str; 4] = [
    "shared-pot-invite",
    "business-invite",
    "pay-yourself-rule",
    "scheduled-transfer",
];

/// `testAgeDoorOpen`: unset or `off` is closed; `on` only in an explicit dev or test process.
pub fn open(
    raw: Option<&str>,
    app_env: Option<&str>,
    node_env: Option<&str>,
) -> Result<bool, String> {
    let v = raw
        .map(|r| service_kit::money::js_trim(r).to_lowercase())
        .unwrap_or_default();
    if v.is_empty() || v == "off" {
        return Ok(false);
    }
    if v != "on" {
        return Err(format!("{ENV} must be unset, off or on"));
    }
    let node_prod =
        node_env.is_some_and(|n| service_kit::money::js_trim(n).to_lowercase() == "production");
    if !matches!(app_env, Some("dev" | "test")) || node_prod {
        let q = |v: Option<&str>| v.map_or_else(|| "null".to_owned(), |s| Json::str(s).compact());
        return Err(format!(
            "{ENV}=on is a TEST stack's door and is refused unless APP_ENV is exactly dev or test and NODE_ENV is not production (got APP_ENV {}, NODE_ENV {})",
            q(app_env),
            q(node_env)
        ));
    }
    Ok(true)
}

/// The body's schema: `{ subject: string, id: string.trim().min(1).max(200), ms: int 1..=MAX_MS }`, strict.
const BODY: &str = r#"{"nodes":[
  {"t":"object","shape":[["subject",1],["id",2],["ms",3]],"catchall":"strict"},
  {"t":"string"},
  {"t":"string","checks":[{"k":"trim"},{"k":"min_length","n":1},{"k":"max_length","n":200}]},
  {"t":"number","checks":[{"k":"int"},{"k":"gt","v":1,"incl":true},{"k":"lt","v":86400000,"incl":true}]}
]}"#;

fn reply(status: u16, body: Json) -> Response {
    Response {
        status,
        body: body.compact(),
    }
}

fn refusal(status: u16, code: &str, message: &str) -> Response {
    reply(
        status,
        Json::obj([("error", Json::str(code)), ("message", Json::str(message))]),
    )
}

fn is_uuid(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// Ages one record by `ms`; `None` when there is none this door may age.
fn age(
    store: &Store,
    subject: &str,
    id: &str,
    ms: i64,
) -> Result<Option<Vec<(&'static str, String)>>, StoreError> {
    if !is_uuid(id) {
        return Ok(None);
    }
    // `ms / 1000` as the TypeScript sends it, written exactly.
    let secs = format!("{}.{:03}", ms.div_euclid(1000), ms.rem_euclid(1000));
    let pool = store.pool()?;
    with_client(pool, |c| {
        let (sql, fields): (&str, &[&'static str]) = match subject {
            "shared-pot-invite" => (
                "UPDATE bank.shared_pot_invites \
                    SET created_at = created_at - make_interval(secs => $2::text::double precision), expires_at = expires_at - make_interval(secs => $2::text::double precision) \
                  WHERE id = $1::text::uuid AND accepted_at IS NULL AND declined_at IS NULL AND cancelled_at IS NULL \
                  RETURNING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
                            to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')",
                &["createdAt", "expiresAt"],
            ),
            "business-invite" => (
                "UPDATE bank.business_invites \
                    SET created_at = created_at - make_interval(secs => $2::text::double precision), expires_at = expires_at - make_interval(secs => $2::text::double precision) \
                  WHERE id = $1::text::uuid AND status = 'open' \
                  RETURNING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
                            to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')",
                &["createdAt", "expiresAt"],
            ),
            "scheduled-transfer" => (
                "UPDATE bank.scheduled_transfers \
                    SET starts_at = starts_at - make_interval(secs => $2::text::double precision), ends_at = ends_at - make_interval(secs => $2::text::double precision), next_run_at = next_run_at - make_interval(secs => $2::text::double precision) \
                  WHERE id = $1::text::uuid AND status = 'active' \
                  RETURNING to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
                            to_char(next_run_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')",
                &["startsAt", "nextRunAt"],
            ),
            _ => (
                "UPDATE bank.pay_yourself_rules SET next_run_at = next_run_at - make_interval(secs => $2::text::double precision) \
                  WHERE id = $1::text::uuid \
                  RETURNING to_char(next_run_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')",
                &["nextRunAt"],
            ),
        };
        let rows = c.query(sql, &[&id, &secs])?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let mut out = Vec::new();
        for (i, f) in fields.iter().enumerate() {
            out.push((
                *f,
                row.try_get::<_, String>(i)
                    .map_err(|e| StoreError::from(&e))?,
            ));
        }
        Ok(Some(out))
    })
}

/// The door, when the request is for it.
pub fn answer(door: &BankDoor, req: &Request<'_>, open: bool) -> Option<Response> {
    let path = req.url.split_once('?').map_or(req.url, |(p, _)| p);
    if req.method != "POST" || path != PATH {
        return None;
    }
    let body = match crate::door::rest::read_body(req) {
        Ok(b) => b,
        Err(res) => return Some(res),
    };
    match door.service(req, BodyBind::Require) {
        None => return Some(unauthenticated()),
        Some(s) if s == "svc-edge" => return Some(unauthenticated()),
        Some(_) => {}
    }
    if !open {
        return Some(refusal(
            403,
            "test_age.door_closed",
            &format!("the TEST age door is closed: {ENV} is not on, so no record is aged"),
        ));
    }
    let parsed = json::parse(BODY)
        .map_err(|e| e.message)
        .and_then(|doc| Schema::from_json(&doc))
        .and_then(|s| s.parse(0, body, &BankRefines).map_err(|t| t.0));
    let parsed = match parsed {
        Ok(Outcome::Ok(v)) => v,
        Ok(Outcome::Issues(issues)) => {
            let words: Vec<String> = issues
                .iter()
                .map(|i| {
                    let path: Vec<String> = i
                        .path()
                        .iter()
                        .map(|p| match p {
                            Json::String(s) => s.clone(),
                            other => other.compact(),
                        })
                        .collect();
                    format!("{}: {}", path.join("."), i.message())
                })
                .collect();
            return Some(refusal(400, "test_age.invalid", &words.join("; ")));
        }
        Err(broken) => return Some(reply(500, Json::obj([("error", Json::str(broken))]))),
    };
    let subject = parsed
        .get("subject")
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let id = parsed.get("id").as_str().unwrap_or_default().to_owned();
    #[allow(
        clippy::cast_possible_truncation,
        reason = "the schema holds ms to an integer in 1..=86400000"
    )]
    let ms = parsed.get("ms").as_number().unwrap_or(0.0) as i64;
    if !SUBJECTS.contains(&subject.as_str()) {
        return Some(refusal(
            400,
            "test_age.invalid",
            &format!("subject must be one of {}", SUBJECTS.join(", ")),
        ));
    }
    Some(match age(door.store(), &subject, &id, ms) {
        Ok(None) => refusal(
            404,
            "test_age.not_found",
            &format!("no {subject} {id} this door may age"),
        ),
        Ok(Some(fields)) => {
            let mut out = vec![
                ("ok".to_owned(), Json::Bool(true)),
                ("subject".to_owned(), Json::str(&subject)),
                ("id".to_owned(), Json::str(&id)),
                ("agedMs".to_owned(), Json::int(ms)),
            ];
            out.extend(
                fields
                    .into_iter()
                    .map(|(k, v)| (k.to_owned(), Json::str(v))),
            );
            reply(200, Json::Object(out))
        }
        // Fastify's answer to a handler that threw.
        Err(_) => reply(
            500,
            Json::obj([
                ("statusCode", Json::int(500)),
                ("error", Json::str("Internal Server Error")),
                ("message", Json::str("An internal server error occurred")),
            ]),
        ),
    })
}

fn unauthenticated() -> Response {
    refusal(
        401,
        "test_age.unauthenticated",
        "the TEST age door answers a signed service call only",
    )
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;
    use service_kit::schema::Value;

    #[test]
    fn the_door_is_open_only_on_an_explicit_test_stack() {
        assert!(!open(None, None, None).unwrap());
        assert!(!open(Some(" OFF "), Some("prod"), None).unwrap());
        assert!(open(Some("on"), Some("test"), None).unwrap());
        assert!(open(Some("On"), Some("dev"), Some("development")).unwrap());
        assert!(
            open(Some("yes"), Some("test"), None)
                .unwrap_err()
                .contains("must be unset, off or on")
        );
        assert!(
            open(Some("on"), Some("prod"), None)
                .unwrap_err()
                .contains("(got APP_ENV \"prod\", NODE_ENV null)")
        );
        assert!(open(Some("on"), Some("test"), Some(" Production")).is_err());
    }

    #[test]
    fn the_body_is_zods_with_its_words() {
        let check = |text: &str| {
            let doc = json::parse(BODY).unwrap();
            let s = Schema::from_json(&doc).unwrap();
            match s
                .parse(
                    0,
                    Value::from_json(&json::parse(text).unwrap()),
                    &BankRefines,
                )
                .unwrap()
            {
                Outcome::Ok(v) => Ok(v),
                Outcome::Issues(i) => {
                    Err(i.iter().map(|i| i.message().to_owned()).collect::<Vec<_>>())
                }
            }
        };
        let ok = check(r#"{"subject":"business-invite","id":"  x ","ms":1000}"#).unwrap();
        assert_eq!(ok.get("id").as_str(), Some("x"));
        assert!(check(r#"{"subject":"x","id":"x","ms":0}"#).is_err());
        assert!(check(r#"{"subject":"x","id":"x","ms":1.5}"#).is_err());
        assert!(check(r#"{"subject":"x","id":"x","ms":1,"more":1}"#).is_err());
    }
}
