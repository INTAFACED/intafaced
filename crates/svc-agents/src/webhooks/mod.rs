//! Webhooks for the runs a person started in their own session (`webhooks/run-webhooks.ts`; AG-sessions-04;
//! J-agents-12 #5). A person's own code registers an endpoint with their API key (`agents:read`: registering starts and
//! changes no run); every run of theirs that ends afterwards is delivered once to each endpoint they had when it ended,
//! signed with that endpoint's secret.
//!
//! The delivery row is written in the transaction that ends the run ([`enqueue_run_finished`]: `runtime::runs::move_run`
//! and each background run's end), so a run never ends without its delivery, and a crash after the commit leaves it due
//! for the next drain. Each post is claimed with a lease, so two drains never post one at once, and carries its event id
//! (`x-intafaced-event-id`, also its `idempotency-key`), so a receiver keeps it once. One attempt per delivery: an
//! endpoint that does not take it is marked failed with its answer. The payload carries ids, the state, the reply, the
//! cost and the refusal codes, never the prompt. Nothing here moves value.

pub mod pinned_post;
pub mod slice;
pub mod url_guard;

use std::sync::Mutex;

use hmac::{Hmac, Mac};
use postgres::GenericClient;
use sha2::Sha256;

use service_kit::json::{self, Json};
use service_kit::pg::Pool;
use service_kit::time::Instant;

use crate::db::{self, StoreError};
use crate::runtime::ms;
use pinned_post::{PinnedPost, PinnedTransport, Transport};
use url_guard::{Resolver, UrlRefusal};

/// `FinishedRunKind`: one `run.complete` (the room's run) or a background run of the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Run,
    Background,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Run => "run",
            Kind::Background => "background",
        }
    }
}

/// `FinishedRun`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinishedRun<'a> {
    /// The event's business key: one per run ending ([`finished_event_id`]).
    pub event_id: String,
    pub kind: Kind,
    pub user_id: &'a str,
    pub run_id: &'a str,
    pub session_id: &'a str,
    pub agent_id: &'a str,
    pub state: &'a str,
    pub reply: Option<&'a str>,
    pub cost: Option<String>,
    pub asset_id: Option<&'a str>,
    pub refusal_codes: Vec<String>,
}

/// `finishedEventId`.
pub fn finished_event_id(kind: Kind, run_id: &str, sequence: i64) -> String {
    let name = match kind {
        Kind::Run => "run",
        Kind::Background => "background_run",
    };
    format!("agents.{name}.finished:{run_id}:{sequence}")
}

fn opt(v: Option<&str>) -> Json {
    v.map_or(Json::Null, Json::str)
}

/// `enqueueRunFinished`: the ended run's delivery to every endpoint the person has now, in the caller's transaction.
/// The same event again writes nothing.
pub fn enqueue_run_finished(
    tx: &mut impl GenericClient,
    run: &FinishedRun<'_>,
) -> Result<(), postgres::Error> {
    let payload = Json::obj([
        ("id", Json::str(run.event_id.clone())),
        ("type", Json::str("agents.run.finished")),
        ("kind", Json::str(run.kind.name())),
        ("runId", Json::str(run.run_id)),
        ("sessionId", Json::str(run.session_id)),
        ("agentId", Json::str(run.agent_id)),
        ("state", Json::str(run.state)),
        ("reply", opt(run.reply)),
        ("cost", opt(run.cost.as_deref())),
        ("assetId", opt(run.asset_id)),
        (
            "refusalCodes",
            Json::Array(
                run.refusal_codes
                    .iter()
                    .cloned()
                    .map(Json::String)
                    .collect(),
            ),
        ),
    ]);
    tx.execute(
        "INSERT INTO agents.run_webhook_deliveries (event_id, endpoint_id, user_id, run_id, payload)
         SELECT $1::text, e.id, e.user_id, $2::text::uuid, $3::text::jsonb
           FROM agents.run_webhook_endpoints e
          WHERE e.user_id = $4::text AND e.disabled_at IS NULL
         ON CONFLICT DO NOTHING",
        &[&run.event_id, &run.run_id, &payload.compact(), &run.user_id],
    )?;
    Ok(())
}

/// A webhook call's refusal: the URL guard's, a conflicting register, or the store failing.
#[derive(Debug)]
pub enum WebhookError {
    Url(UrlRefusal),
    /// `RunWebhookConflict`: `agents.webhook_endpoint_conflict`.
    Conflict,
    Store(StoreError),
}

impl From<StoreError> for WebhookError {
    fn from(e: StoreError) -> WebhookError {
        WebhookError::Store(e)
    }
}

impl From<postgres::Error> for WebhookError {
    fn from(e: postgres::Error) -> WebhookError {
        WebhookError::Store(StoreError::from(e))
    }
}

/// `RunWebhookEndpoint`.
fn endpoint(id: String, url: String, created_at: i64, secret: Option<String>) -> Json {
    Json::obj([
        ("id", Json::String(id)),
        ("url", Json::String(url)),
        ("createdAt", Json::str(Instant(created_at).iso())),
        ("secret", secret.map_or(Json::Null, Json::String)),
    ])
}

/// `LEASE_MS`.
const LEASE_MS: i64 = 60_000;
/// `DRAIN_BATCH`.
pub const DRAIN_BATCH: i64 = 20;

/// `RunWebhooks`: the endpoints, the deliveries and the drain.
pub struct RunWebhooks {
    allow_local_http: bool,
    transport: Box<dyn Transport>,
    resolver: Box<Resolver>,
    timeout_ms: u64,
    /// One drain at a time in this process; a second waits for the first, then finds nothing it leased.
    draining: Mutex<()>,
}

impl RunWebhooks {
    /// The service's: the real wire, the system's resolver (bounded), ten seconds an attempt. `allow_local_http` is the
    /// URL guard's dev/test hatch (an endpoint on loopback, over http).
    pub fn new(allow_local_http: bool) -> RunWebhooks {
        RunWebhooks::with(
            allow_local_http,
            Box::new(PinnedTransport),
            Box::new(url_guard::system_resolver),
        )
    }

    /// With the transport and resolver given (tests put a recorder in the transport's place).
    pub fn with(
        allow_local_http: bool,
        transport: Box<dyn Transport>,
        resolver: Box<Resolver>,
    ) -> RunWebhooks {
        RunWebhooks {
            allow_local_http,
            transport,
            resolver,
            timeout_ms: 10_000,
            draining: Mutex::new(()),
        }
    }

    /// `register`: an endpoint once per `endpointId`; its signing secret is shown on the register that made it and
    /// never again. Someone else's id, or the same id for another address, is refused and tells nothing of the other.
    pub fn register(
        &self,
        pool: &Pool,
        user_id: &str,
        endpoint_id: &str,
        url: &str,
    ) -> Result<Json, WebhookError> {
        let url = url_guard::assert_public_webhook_url(url, self.allow_local_http)
            .map_err(WebhookError::Url)?
            .to_string();
        let secret = new_secret().map_err(|e| WebhookError::Store(StoreError::new(e, None)))?;
        db::with_client(pool, |c| {
            let made = c.query(
                &format!(
                    "INSERT INTO agents.run_webhook_endpoints (id, user_id, url, secret)
                     VALUES ($1::text::uuid, $2::text, $3::text, $4::text)
                     ON CONFLICT (id) DO NOTHING
                     RETURNING id::text, url, {}",
                    ms("created_at")
                ),
                &[&endpoint_id, &user_id, &url, &secret],
            )?;
            if let Some(r) = made.first() {
                return Ok(Ok(endpoint(
                    r.try_get(0)?,
                    r.try_get(1)?,
                    r.try_get(2)?,
                    Some(secret.clone()),
                )));
            }
            let prior = c.query(
                &format!(
                    "SELECT id::text, user_id, url, {} FROM agents.run_webhook_endpoints WHERE id = $1::text::uuid",
                    ms("created_at")
                ),
                &[&endpoint_id],
            )?;
            let Some(p) = prior.first() else {
                return Ok(Err(WebhookError::Conflict));
            };
            let (owner, stored): (String, String) = (p.try_get(1)?, p.try_get(2)?);
            if owner != user_id || stored != url {
                return Ok(Err(WebhookError::Conflict));
            }
            Ok(Ok(endpoint(p.try_get(0)?, stored, p.try_get(3)?, None)))
        })?
    }

    /// `list`: the person's live endpoints, oldest first; no secret.
    pub fn list(&self, pool: &Pool, user_id: &str, limit: i64) -> Result<Json, WebhookError> {
        let rows = db::with_client(pool, |c| {
            Ok(c.query(
                &format!(
                    "SELECT id::text, url, {} FROM agents.run_webhook_endpoints
                      WHERE user_id = $1::text AND disabled_at IS NULL ORDER BY created_at, id LIMIT $2",
                    ms("created_at")
                ),
                &[&user_id, &limit],
            )?)
        })?;
        rows.iter()
            .map(|r| Ok(endpoint(r.try_get(0)?, r.try_get(1)?, r.try_get(2)?, None)))
            .collect::<Result<Vec<_>, postgres::Error>>()
            .map(Json::Array)
            .map_err(WebhookError::from)
    }

    /// `deliveries`: the person's deliveries, oldest first, each with its attempts and the endpoint's last answer.
    pub fn deliveries(
        &self,
        pool: &Pool,
        user_id: &str,
        endpoint_id: Option<&str>,
        run_id: Option<&str>,
        limit: i64,
    ) -> Result<Json, WebhookError> {
        let rows = db::with_client(pool, |c| {
            Ok(c.query(
                &format!(
                    "SELECT event_id, endpoint_id::text, run_id::text, payload->>'kind', payload->>'state', state,
                            attempts, last_status, last_error, {}
                       FROM agents.run_webhook_deliveries
                      WHERE user_id = $1::text
                        AND ($2::text::uuid IS NULL OR endpoint_id = $2::text::uuid)
                        AND ($3::text::uuid IS NULL OR run_id = $3::text::uuid)
                      ORDER BY created_at, event_id, endpoint_id
                      LIMIT $4",
                    ms("delivered_at")
                ),
                &[&user_id, &endpoint_id, &run_id, &limit],
            )?)
        })?;
        rows.iter()
            .map(|r| {
                let status: Option<i32> = r.try_get(7)?;
                let delivered: Option<i64> = r.try_get(9)?;
                Ok(Json::obj([
                    ("eventId", Json::String(r.try_get(0)?)),
                    ("endpointId", Json::String(r.try_get(1)?)),
                    ("runId", Json::String(r.try_get(2)?)),
                    ("kind", Json::String(r.try_get(3)?)),
                    ("runState", Json::String(r.try_get(4)?)),
                    ("state", Json::String(r.try_get(5)?)),
                    ("attempts", Json::int(i64::from(r.try_get::<_, i32>(6)?))),
                    (
                        "lastStatus",
                        status.map_or(Json::Null, |s| Json::int(i64::from(s))),
                    ),
                    (
                        "lastError",
                        r.try_get::<_, Option<String>>(8)?
                            .map_or(Json::Null, Json::String),
                    ),
                    (
                        "deliveredAt",
                        delivered.map_or(Json::Null, |d| Json::str(Instant(d).iso())),
                    ),
                ]))
            })
            .collect::<Result<Vec<_>, postgres::Error>>()
            .map(Json::Array)
            .map_err(WebhookError::from)
    }

    /// `drain`: posts every delivery that is due, up to `limit`; returns how many it posted.
    pub fn drain(&self, pool: &Pool, limit: i64) -> Result<i64, StoreError> {
        let _one = self
            .draining
            .lock()
            .map_err(|_| StoreError::new("the webhook drain lock is poisoned", None))?;
        let mut posted = 0;
        while posted < limit {
            let claimed = db::with_client(pool, |c| {
                Ok(c.query(
                    "WITH due AS (
                       SELECT event_id, endpoint_id FROM agents.run_webhook_deliveries
                        WHERE state = 'pending' AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until <= now())
                        ORDER BY next_attempt_at
                        LIMIT $1
                        FOR UPDATE SKIP LOCKED
                     )
                     UPDATE agents.run_webhook_deliveries d SET lease_until = now() + ($2::bigint * interval '1 millisecond')
                       FROM due, agents.run_webhook_endpoints w
                      WHERE d.event_id = due.event_id AND d.endpoint_id = due.endpoint_id AND w.id = d.endpoint_id
                     RETURNING d.event_id, d.endpoint_id::text, d.payload::text, w.url, w.secret",
                    &[&DRAIN_BATCH.min(limit), &LEASE_MS],
                )?)
            })?;
            if claimed.is_empty() {
                break;
            }
            for r in &claimed {
                let d = Claimed {
                    event_id: r.try_get(0)?,
                    endpoint_id: r.try_get(1)?,
                    payload: r.try_get(2)?,
                    url: r.try_get(3)?,
                    secret: r.try_get(4)?,
                };
                self.post(pool, &d)?;
                posted += 1;
            }
        }
        Ok(posted)
    }

    fn post(&self, pool: &Pool, d: &Claimed) -> Result<(), StoreError> {
        // The body is the stored payload as `JSON.stringify` writes what Postgres hands back.
        let body = json::parse(&d.payload)
            .map_err(|e| StoreError::new(e.message, None))?
            .compact();
        let timestamp = unix_seconds().to_string();
        let signature = sign(&d.secret, &format!("{timestamp}.{body}"));
        let sent = url_guard::assert_public_webhook_url(&d.url, self.allow_local_http)
            .and_then(|url| {
                let addresses = url_guard::resolve_public_addresses(
                    url.host_str().unwrap_or(""),
                    &*self.resolver,
                    self.allow_local_http,
                )?;
                Ok((url, addresses))
            })
            .map_err(|_| url_guard::URL_INVALID.to_owned())
            .and_then(|(url, addresses)| {
                self.transport
                    .post(&PinnedPost {
                        url,
                        addresses,
                        headers: vec![
                            ("content-type".to_owned(), "application/json".to_owned()),
                            ("x-intafaced-event-id".to_owned(), d.event_id.clone()),
                            ("idempotency-key".to_owned(), d.event_id.clone()),
                            ("x-intafaced-timestamp".to_owned(), timestamp.clone()),
                            (
                                "x-intafaced-signature".to_owned(),
                                format!("v1={signature}"),
                            ),
                        ],
                        body: body.clone(),
                        timeout_ms: self.timeout_ms,
                    })
                    .map_err(|_| "unreachable".to_owned())
            });
        let (status, error) = match sent {
            Ok(s) => (Some(i32::from(s)), None),
            Err(e) => (None, Some(e)),
        };
        let delivered = status.is_some_and(|s| (200..300).contains(&s));
        db::with_client(pool, |c| {
            c.execute(
                "UPDATE agents.run_webhook_deliveries
                    SET attempts = attempts + 1, last_status = $3, last_error = $4::text, lease_until = NULL,
                        state = $5::text, delivered_at = CASE WHEN $6::boolean THEN now() END
                  WHERE event_id = $1::text AND endpoint_id = $2::text::uuid",
                &[
                    &d.event_id,
                    &d.endpoint_id,
                    &status,
                    &error,
                    &if delivered { "delivered" } else { "failed" },
                    &delivered,
                ],
            )?;
            Ok(())
        })
    }
}

struct Claimed {
    event_id: String,
    endpoint_id: String,
    payload: String,
    url: String,
    secret: String,
}

/// `whsec_` and 32 random bytes in hex.
fn new_secret() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok(format!("whsec_{}", hex(&bytes)))
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// HMAC-SHA256 of `message` under `secret`, in hex.
pub fn sign(secret: &str, message: &str) -> String {
    #[expect(clippy::expect_used, reason = "HMAC takes a key of any length")]
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC takes any key length");
    mac.update(message.as_bytes());
    hex(&mac.finalize().into_bytes())
}

fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    #[test]
    fn an_event_id_is_the_run_its_kind_and_its_sequence() {
        assert_eq!(
            finished_event_id(Kind::Run, "r", 3),
            "agents.run.finished:r:3"
        );
        assert_eq!(
            finished_event_id(Kind::Background, "r", 1),
            "agents.background_run.finished:r:1"
        );
    }

    #[test]
    fn the_signature_is_hmac_sha256_in_hex() {
        // RFC 4231 test case 2.
        assert_eq!(
            sign("Jefe", "what do ya want for nothing?"),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        let s = new_secret().unwrap();
        assert!(s.starts_with("whsec_") && s.len() == 6 + 64);
    }
}
