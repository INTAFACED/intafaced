//! The owner is told of a held call (`own/approval-notices.ts`, AG-approvals-01, J-agents-05 #4): every request not
//! yet announced is published on its business key, `agents.approval.requested:<id>`, then marked. Each is published
//! under its row lock, read again under that lock, so a request a decision or an expiry holds is left for the next
//! sweep, and one that stopped waiting is only marked. A crash between the publish and the mark publishes it again
//! under the same key, which JetStream and the consumer drop. One that cannot be published never holds back the rest.

use postgres::IsolationLevel;
use service_kit::json::Json;
use service_kit::pg::Pool;
use service_kit::time::Instant;

use crate::db::{self, StoreError};
use crate::metering::Metering;
use crate::runtime::{envelope, ms};

/// `agentApprovalRequested`'s subject.
pub const APPROVAL_REQUESTED: &str = "intafaced.agents.approval.requested";

/// `approvalNoticeKey`.
pub fn approval_notice_key(request_id: &str) -> String {
    format!("agents.approval.requested:{request_id}")
}

/// Told of one request that could not be published: the error, then the request's id.
pub type OnError<'a> = &'a dyn Fn(&str, &str);

/// Which requests a sweep publishes.
#[derive(Default)]
pub struct Scope<'a> {
    /// Only this person's requests.
    pub owner_id: Option<&'a str>,
    /// Only this request (the one a call just held).
    pub request_id: Option<&'a str>,
    /// Told of each request that could not be published; it stays unpublished for the next sweep.
    pub on_error: Option<OnError<'a>>,
}

/// `publishPendingApprovalRequests`: how many were published.
pub fn publish_pending_approval_requests(
    pool: &Pool,
    m: &Metering,
    now: Instant,
    scope: &Scope<'_>,
) -> Result<i64, StoreError> {
    let pending = db::with_client(pool, |c| {
        Ok(c.query(
            "SELECT id::text FROM agents.own_agent_approval_requests
              WHERE published_at IS NULL
                AND ($1::text IS NULL OR owner_id = $1::text)
                AND ($2::text IS NULL OR id = $2::text::uuid)
              ORDER BY created_at
              LIMIT 100",
            &[&scope.owner_id, &scope.request_id],
        )?)
    })?;
    let mut published = 0;
    for row in &pending {
        let id: String = row.try_get(0)?;
        match publish_one(pool, m, now, &id) {
            Ok(true) => published += 1,
            Ok(false) => {}
            Err(e) => {
                if let Some(on_error) = scope.on_error {
                    on_error(&e, &id);
                }
            }
        }
    }
    Ok(published)
}

/// One request, under its lock: published while it still waits, then marked either way. False when it was published
/// meanwhile, another sweep holds it, or it stopped waiting.
fn publish_one(pool: &Pool, m: &Metering, now: Instant, id: &str) -> Result<bool, String> {
    db::transaction(pool, IsolationLevel::ReadCommitted, |tx| {
        let rows = tx.query(
            &format!(
                "SELECT owner_id, agent_id::text, session_id::text, tool, {},
                        (status = 'waiting' AND expires_at > now())
                   FROM agents.own_agent_approval_requests
                  WHERE id = $1::text::uuid AND published_at IS NULL
                  FOR UPDATE SKIP LOCKED",
                ms("expires_at")
            ),
            &[&id],
        )?;
        let Some(r) = rows.first() else {
            return Ok(false);
        };
        let waiting: bool = r.try_get(5)?;
        if waiting {
            let payload = Json::obj([
                ("requestId", Json::str(id)),
                ("userId", Json::str(r.try_get::<_, String>(0)?)),
                ("agentId", Json::str(r.try_get::<_, String>(1)?)),
                ("sessionId", Json::str(r.try_get::<_, String>(2)?)),
                ("tool", Json::str(r.try_get::<_, String>(3)?)),
                ("expiresAt", Json::str(Instant(r.try_get(4)?).iso())),
            ]);
            let key = approval_notice_key(id);
            let env = envelope(m, APPROVAL_REQUESTED, &key, payload, now)
                .map_err(|e| StoreError::new(e, None))?;
            m.bus
                .publish(APPROVAL_REQUESTED, &key, &env)
                .map_err(|e| StoreError::new(e, None))?;
        }
        tx.execute(
            "UPDATE agents.own_agent_approval_requests SET published_at = now() WHERE id = $1::text::uuid",
            &[&id],
        )?;
        Ok(waiting)
    })
    .map_err(|e| e.message)
}

/// The `unpublished sweep` timer (`index.ts`, `sweepUnpublished`): the recorded usage alerts, then every held call not
/// yet announced. Each half runs whatever the other did; a failure of either, or a request that could not be
/// published, is the run's error, which the timer logs (the next tick retries).
pub fn sweep_unpublished(door: &crate::door::AgentsDoor) -> Result<(), String> {
    let pool = door.store().pool().map_err(|e| e.message)?;
    let x = crate::runtime::Rt {
        rt: door.runtime(),
        pool,
        gateway: &door.gateway().gateway,
        m: door.metering(),
        now: crate::door::system_now(),
    };
    let mut errors = Vec::new();
    if let Err(e) = crate::runtime::publish_usage_alerts(&x, None) {
        errors.push(format!("usage alert sweep failed: {e:?}"));
    }
    let failed = std::cell::RefCell::new(Vec::new());
    let on_error = |err: &str, id: &str| {
        failed
            .borrow_mut()
            .push(format!("approval request {id} not published: {err}"));
    };
    if let Err(e) = publish_pending_approval_requests(
        pool,
        x.m,
        x.now,
        &Scope {
            on_error: Some(&on_error),
            ..Scope::default()
        },
    ) {
        errors.push(format!("approval request sweep failed: {}", e.message));
    }
    errors.extend(failed.into_inner());
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}
