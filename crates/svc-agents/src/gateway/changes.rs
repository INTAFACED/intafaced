//! The routing table, changed by two founders (`services/svc-agents/src/gateway/route-changes.ts`).
//!
//! The configured table names each task's provider and model alias, and nothing here changes them. Founders change a
//! route's output ceiling and its rates, two of them together: one proposes (stored pending; the table does not move),
//! that founder alone may withdraw it, and a different founder confirms it, applied once in the same transaction as its
//! audit row naming both. A rate change is in force from the next usage window; until then the window keeps the rate
//! in force when the change was confirmed. Nothing here is a balance and no value moves.

use postgres::{GenericClient, IsolationLevel, Transaction};
use sha2::{Digest, Sha256};

use service_kit::json::{self, Json};
use service_kit::money::{format_amount, parse_amount};
use service_kit::time::Instant;

use super::routing::{Price, Route, RoutingTable};
use crate::db::{Retryable, StoreError, transaction_retrying};

/// A refusal of the route desk (`RouteChangeRefusalCode`), or the database failing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeskError {
    Refused(&'static str),
    Store(StoreError),
}

impl From<StoreError> for DeskError {
    fn from(e: StoreError) -> DeskError {
        DeskError::Store(e)
    }
}

impl From<postgres::Error> for DeskError {
    fn from(e: postgres::Error) -> DeskError {
        DeskError::Store(StoreError::from(e))
    }
}

impl Retryable for DeskError {
    fn store(&self) -> Option<&StoreError> {
        match self {
            DeskError::Store(e) => Some(e),
            DeskError::Refused(_) => None,
        }
    }
}

/// `STATUS`: each refusal's tRPC code.
pub fn status_of(code: &str) -> &'static str {
    match code {
        "agents.route_not_found" | "agents.route_change_not_found" => "NOT_FOUND",
        "agents.route_change_invalid" => "BAD_REQUEST",
        "agents.route_change_same_founder"
        | "agents.route_change_not_yours"
        | "agents.route_change_person_only" => "FORBIDDEN",
        "agents.capability_unavailable" => "SERVICE_UNAVAILABLE",
        // unchanged, pending, not pending, request reused
        _ => "CONFLICT",
    }
}

// ── The founders' layer over the configured table ───────────────────────────

/// A confirmed change to one task's route, as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteOverride {
    pub task: String,
    pub max_output_tokens: i64,
    pub price: Option<Price>,
    /// The rate in force when the change was confirmed, kept until `price_from`.
    pub prior_price: Option<Price>,
    pub price_from: Instant,
}

/// `overridePriceAt`.
pub fn override_price_at(o: &RouteOverride, now: Instant) -> Option<Price> {
    if now.0 >= o.price_from.0 {
        o.price
    } else {
        o.prior_price
    }
}

/// `withOverrides`: provider, model and capability always from the configured table; an override for a task the
/// configuration no longer has is ignored.
pub fn with_overrides(
    base: &RoutingTable,
    overrides: &[RouteOverride],
    now: Instant,
) -> RoutingTable {
    RoutingTable {
        routes: base
            .routes
            .iter()
            .map(
                |route| match overrides.iter().find(|o| o.task == route.task) {
                    Some(o) => Route {
                        max_output_tokens: o.max_output_tokens,
                        price: override_price_at(o, now),
                        ..route.clone()
                    },
                    None => route.clone(),
                },
            )
            .collect(),
        fallback_task: base.fallback_task.clone(),
    }
}

/// `nextWindowStart`: the start of the usage window after the one `now` is in (whole minutes dividing a UTC day).
pub fn next_window_start(now: Instant, window_minutes: i64) -> Instant {
    let ms = window_minutes.max(1) * 60_000;
    let day = now.0.div_euclid(86_400_000) * 86_400_000;
    Instant(day + ((now.0 - day).div_euclid(ms) + 1) * ms)
}

fn price_of(input: Option<&str>, output: Option<&str>) -> Result<Option<Price>, StoreError> {
    match (input, output) {
        (Some(i), Some(o)) => {
            let amount = |s: &str| parse_amount(s).map_err(|e| StoreError::new(e, None));
            Ok(Some(Price {
                input_per_million: amount(i)?,
                output_per_million: amount(o)?,
            }))
        }
        _ => Ok(None),
    }
}

/// `rate`: a price as its two decimal strings.
fn rate(price: Option<&Price>) -> (Option<String>, Option<String>) {
    match price {
        Some(p) => (
            Some(format_amount(p.input_per_million)),
            Some(format_amount(p.output_per_million)),
        ),
        None => (None, None),
    }
}

/// `canonical`: a stored or given decimal in its shortest form.
fn canonical(v: Option<&str>) -> Result<Option<String>, StoreError> {
    v.map(|s| {
        parse_amount(s)
            .map(format_amount)
            .map_err(|e| StoreError::new(e, None))
    })
    .transpose()
}

const EPOCH_MS: &str = "floor(extract(epoch FROM {c}) * 1000)::int8";

fn ms_of(column: &str) -> String {
    EPOCH_MS.replace("{c}", column)
}

/// `readRouteOverrides`.
pub fn read_overrides(c: &mut impl GenericClient) -> Result<Vec<RouteOverride>, StoreError> {
    let rows = c.query(
        &format!(
            "SELECT task, max_output_tokens::int8, input_per_million::text, output_per_million::text,
                    prior_input_per_million::text, prior_output_per_million::text, {}
               FROM agents.route_overrides ORDER BY task",
            ms_of("price_from")
        ),
        &[],
    )?;
    rows.iter()
        .map(|r| {
            Ok(RouteOverride {
                task: r.try_get(0)?,
                max_output_tokens: r.try_get(1)?,
                price: price_of(
                    r.try_get::<_, Option<String>>(2)?.as_deref(),
                    r.try_get::<_, Option<String>>(3)?.as_deref(),
                )?,
                prior_price: price_of(
                    r.try_get::<_, Option<String>>(4)?.as_deref(),
                    r.try_get::<_, Option<String>>(5)?.as_deref(),
                )?,
                price_from: Instant(r.try_get(6)?),
            })
        })
        .collect()
}

// ── The store ───────────────────────────────────────────────────────────────

/// `RouteChangeInput`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeInput {
    pub task: String,
    pub max_output_tokens: i64,
    pub input_per_million: Option<String>,
    pub output_per_million: Option<String>,
}

/// A `route_change_requests` row, as `changeView` answers it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChangeView {
    pub id: String,
    pub request_id: String,
    pub task: String,
    pub max_output_tokens: i64,
    /// Canonical decimals.
    pub input_per_million: Option<String>,
    pub output_per_million: Option<String>,
    pub status: String,
    pub proposed_by: String,
    pub confirmed_by: Option<String>,
    pub created_at: Instant,
    pub decided_at: Option<Instant>,
}

fn opt_str(v: Option<String>) -> Json {
    v.map_or(Json::Null, Json::String)
}

impl ChangeView {
    /// `routeChangeSchema`, in its key order.
    pub fn json(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("task", Json::str(self.task.clone())),
            ("maxOutputTokens", Json::int(self.max_output_tokens)),
            ("inputPerMillion", opt_str(self.input_per_million.clone())),
            ("outputPerMillion", opt_str(self.output_per_million.clone())),
            ("status", Json::str(self.status.clone())),
            ("proposedBy", Json::str(self.proposed_by.clone())),
            ("confirmedBy", opt_str(self.confirmed_by.clone())),
            ("createdAt", Json::str(self.created_at.iso())),
            (
                "decidedAt",
                self.decided_at.map_or(Json::Null, |d| Json::str(d.iso())),
            ),
        ])
    }
}

/// `RouteSnapshot`: a route's ceiling and rates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub max_output_tokens: i64,
    pub input_per_million: Option<String>,
    pub output_per_million: Option<String>,
}

impl Snapshot {
    fn of(route: &Route) -> Snapshot {
        let (i, o) = rate(route.price.as_ref());
        Snapshot {
            max_output_tokens: route.max_output_tokens,
            input_per_million: i,
            output_per_million: o,
        }
    }

    /// `routeSnapshotSchema`, in its key order.
    pub fn json(&self) -> Json {
        Json::obj([
            ("maxOutputTokens", Json::int(self.max_output_tokens)),
            ("inputPerMillion", opt_str(self.input_per_million.clone())),
            ("outputPerMillion", opt_str(self.output_per_million.clone())),
        ])
    }
}

fn request_columns() -> String {
    format!(
        "id::text, request_id, task, max_output_tokens::int8, input_per_million::text, output_per_million::text,
         status, proposed_by, confirmed_by, {}, {}",
        ms_of("created_at"),
        ms_of("decided_at")
    )
}

fn change_view(r: &postgres::Row) -> Result<ChangeView, StoreError> {
    Ok(ChangeView {
        id: r.try_get(0)?,
        request_id: r.try_get(1)?,
        task: r.try_get(2)?,
        max_output_tokens: r.try_get(3)?,
        input_per_million: canonical(r.try_get::<_, Option<String>>(4)?.as_deref())?,
        output_per_million: canonical(r.try_get::<_, Option<String>>(5)?.as_deref())?,
        status: r.try_get(6)?,
        proposed_by: r.try_get(7)?,
        confirmed_by: r.try_get(8)?,
        created_at: Instant(r.try_get(9)?),
        decided_at: r.try_get::<_, Option<i64>>(10)?.map(Instant),
    })
}

/// `idFor`: an id derived from the request's business key, so a retried proposal lands on the same row.
pub fn id_for(key: &str) -> String {
    let h: String = Sha256::digest(key.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let part = |a: usize, b: usize| h.get(a..b).unwrap_or("");
    format!(
        "{}-{}-4{}-8{}-{}",
        part(0, 8),
        part(8, 12),
        part(13, 16),
        part(17, 20),
        part(20, 32)
    )
}

/// `/^\d{1,20}(\.\d{1,18})?$/`.
fn is_amount(s: &str) -> bool {
    let (whole, frac) = s.split_once('.').map_or((s, None), |(w, f)| (w, Some(f)));
    let digits = |t: &str, max: usize| {
        !t.is_empty() && t.len() <= max && t.bytes().all(|b| b.is_ascii_digit())
    };
    digits(whole, 20) && frac.is_none_or(|f| digits(f, 18))
}

/// `sameUser`.
fn same_user(a: &str, b: &str) -> bool {
    service_kit::money::js_trim(a).to_lowercase() == service_kit::money::js_trim(b).to_lowercase()
}

/// `transaction`'s default attempts.
const ATTEMPTS: u32 = 5;

/// Every write takes this lock, so a proposal, a withdrawal and a confirm of one table never interleave.
const LOCK: &str = "agents-route-changes";

/// `validate`: a ceiling in range, both rates or neither, each a plain decimal.
fn validate(input: &ChangeInput) -> Result<ChangeInput, DeskError> {
    let invalid = DeskError::Refused("agents.route_change_invalid");
    if !(1..=1_000_000).contains(&input.max_output_tokens) {
        return Err(invalid);
    }
    let (i, o) = (
        input.input_per_million.as_deref(),
        input.output_per_million.as_deref(),
    );
    if i.is_none() != o.is_none()
        || i.is_some_and(|v| !is_amount(v))
        || o.is_some_and(|v| !is_amount(v))
    {
        return Err(invalid);
    }
    Ok(ChangeInput {
        task: input.task.clone(),
        max_output_tokens: input.max_output_tokens,
        input_per_million: canonical(i)?,
        output_per_million: canonical(o)?,
    })
}

struct AuditRow<'a> {
    key: String,
    change_id: &'a str,
    task: &'a str,
    action: &'static str,
    operator_id: &'a str,
    proposed_by: &'a str,
    before: Snapshot,
    after: Snapshot,
}

fn audit(tx: &mut Transaction<'_>, row: &AuditRow<'_>) -> Result<(), StoreError> {
    tx.execute(
        "INSERT INTO agents.route_change_audit (business_key, change_id, task, action, operator_id, proposed_by, before, after)
         VALUES ($1, $2::text::uuid, $3, $4, $5, $6, $7::text::jsonb, $8::text::jsonb)
         ON CONFLICT (business_key) DO NOTHING",
        &[
            &row.key,
            &row.change_id,
            &row.task,
            &row.action,
            &row.operator_id,
            &row.proposed_by,
            &row.before.json().compact(),
            &row.after.json().compact(),
        ],
    )?;
    Ok(())
}

/// `RouteChangeStore`: the founders' proposals, withdrawals and confirmations.
pub struct ChangeStore<'a> {
    pub pool: &'a service_kit::pg::Pool,
    /// The configured table.
    pub base: &'a RoutingTable,
    /// `AGENTS_USAGE_WINDOW_MINUTES`.
    pub window_minutes: i64,
    pub now: Instant,
}

impl ChangeStore<'_> {
    fn base_route(&self, task: &str) -> Result<&Route, DeskError> {
        self.base
            .routes
            .iter()
            .find(|r| r.task == task)
            .ok_or(DeskError::Refused("agents.route_not_found"))
    }

    /// The route as it stands now: the configured route with its stored change, if any.
    fn current(&self, tx: &mut Transaction<'_>, task: &str) -> Result<Route, DeskError> {
        let base = RoutingTable {
            routes: vec![self.base_route(task)?.clone()],
            fallback_task: None,
        };
        let overrides = read_overrides(tx)?;
        with_overrides(&base, &overrides, self.now)
            .routes
            .into_iter()
            .next()
            .ok_or(DeskError::Refused("agents.route_not_found"))
    }

    fn lock(tx: &mut Transaction<'_>) -> Result<(), StoreError> {
        tx.execute("SELECT pg_advisory_xact_lock(hashtext($1))", &[&LOCK])?;
        Ok(())
    }

    fn request(tx: &mut Transaction<'_>, change_id: &str) -> Result<ChangeView, DeskError> {
        let rows = tx.query(
            &format!(
                "SELECT {} FROM agents.route_change_requests WHERE id = $1::text::uuid FOR UPDATE",
                request_columns()
            ),
            &[&change_id],
        )?;
        match rows.first() {
            Some(r) => Ok(change_view(r)?),
            None => Err(DeskError::Refused("agents.route_change_not_found")),
        }
    }

    /// One founder's change, stored as pending. Retried with the same request id, it answers the same row.
    pub fn propose(
        &self,
        operator_id: &str,
        input: &ChangeInput,
        request_id: &str,
    ) -> Result<ChangeView, DeskError> {
        let valid = validate(input)?;
        self.base_route(&valid.task)?;
        let id = id_for(&format!("route-change:{request_id}"));
        transaction_retrying(self.pool, IsolationLevel::Serializable, ATTEMPTS, |tx| {
            Self::lock(tx)?;
            let mine = tx.query(
                &format!(
                    "SELECT {} FROM agents.route_change_requests WHERE request_id = $1",
                    request_columns()
                ),
                &[&request_id],
            )?;
            if let Some(mine) = mine.first() {
                let mine = change_view(mine)?;
                let same = mine.task == valid.task
                    && same_user(&mine.proposed_by, operator_id)
                    && mine.max_output_tokens == valid.max_output_tokens
                    && mine.input_per_million == valid.input_per_million
                    && mine.output_per_million == valid.output_per_million;
                return if same {
                    Ok(mine)
                } else {
                    Err(DeskError::Refused("agents.route_change_request_reused"))
                };
            }
            let waiting = tx.query(
                "SELECT 1 FROM agents.route_change_requests WHERE task = $1 AND status = 'pending'",
                &[&valid.task],
            )?;
            if !waiting.is_empty() {
                return Err(DeskError::Refused("agents.route_change_pending"));
            }
            let before = Snapshot::of(&self.current(tx, &valid.task)?);
            let after = Snapshot {
                max_output_tokens: valid.max_output_tokens,
                input_per_million: valid.input_per_million.clone(),
                output_per_million: valid.output_per_million.clone(),
            };
            if before == after {
                return Err(DeskError::Refused("agents.route_change_unchanged"));
            }
            let row = tx.query_one(
                &format!(
                    "INSERT INTO agents.route_change_requests (id, request_id, task, max_output_tokens, input_per_million, output_per_million, proposed_by)
                     VALUES ($1::text::uuid, $2, $3, $4::int8::int4, $5::text::numeric, $6::text::numeric, $7) RETURNING {}",
                    request_columns()
                ),
                &[
                    &id,
                    &request_id,
                    &valid.task,
                    &valid.max_output_tokens,
                    &valid.input_per_million,
                    &valid.output_per_million,
                    &operator_id,
                ],
            )?;
            audit(
                tx,
                &AuditRow {
                    key: format!("route-change:propose:{id}"),
                    change_id: &id,
                    task: &valid.task,
                    action: "propose",
                    operator_id,
                    proposed_by: operator_id,
                    before,
                    after,
                },
            )?;
            Ok(change_view(&row)?)
        })
    }

    /// The proposer takes their pending change back. Nothing else changes.
    pub fn withdraw(&self, operator_id: &str, change_id: &str) -> Result<ChangeView, DeskError> {
        transaction_retrying(self.pool, IsolationLevel::Serializable, ATTEMPTS, |tx| {
            Self::lock(tx)?;
            let row = Self::request(tx, change_id)?;
            if !same_user(&row.proposed_by, operator_id) {
                return Err(DeskError::Refused("agents.route_change_not_yours"));
            }
            if row.status == "withdrawn" {
                return Ok(row);
            }
            if row.status != "pending" {
                return Err(DeskError::Refused("agents.route_change_not_pending"));
            }
            let now = Snapshot::of(&self.current(tx, &row.task)?);
            let done = tx.query_one(
                &format!(
                    "UPDATE agents.route_change_requests SET status = 'withdrawn', decided_at = now() WHERE id = $1::text::uuid RETURNING {}",
                    request_columns()
                ),
                &[&change_id],
            )?;
            audit(
                tx,
                &AuditRow {
                    key: format!("route-change:withdraw:{change_id}"),
                    change_id,
                    task: &row.task,
                    action: "withdraw",
                    operator_id,
                    proposed_by: &row.proposed_by,
                    before: now.clone(),
                    after: now,
                },
            )?;
            Ok(change_view(&done)?)
        })
    }

    /// A second founder applies the change: once, with its audit row, in one transaction. A rate change is in force from
    /// the next usage window; the ceiling at once. The caller refreshes the gateway's table afterwards.
    pub fn confirm(&self, operator_id: &str, change_id: &str) -> Result<ChangeView, DeskError> {
        transaction_retrying(self.pool, IsolationLevel::Serializable, ATTEMPTS, |tx| {
            Self::lock(tx)?;
            let row = Self::request(tx, change_id)?;
            if row.status == "applied"
                && row
                    .confirmed_by
                    .as_deref()
                    .is_some_and(|c| same_user(c, operator_id))
            {
                return Ok(row);
            }
            if row.status != "pending" {
                return Err(DeskError::Refused("agents.route_change_not_pending"));
            }
            if same_user(&row.proposed_by, operator_id) {
                return Err(DeskError::Refused("agents.route_change_same_founder"));
            }
            let route = self.current(tx, &row.task)?;
            let price = price_of(
                row.input_per_million.as_deref(),
                row.output_per_million.as_deref(),
            )?;
            let price_from = if route.price == price {
                self.now
            } else {
                next_window_start(self.now, self.window_minutes)
            };
            let (prior_in, prior_out) = rate(route.price.as_ref());
            tx.execute(
                "INSERT INTO agents.route_overrides
                   (task, max_output_tokens, input_per_million, output_per_million, prior_input_per_million, prior_output_per_million, price_from, change_id)
                 VALUES ($1, $2::int8::int4, $3::text::numeric, $4::text::numeric, $5::text::numeric, $6::text::numeric, $7::text::timestamptz, $8::text::uuid)
                 ON CONFLICT (task) DO UPDATE SET
                   max_output_tokens = EXCLUDED.max_output_tokens, input_per_million = EXCLUDED.input_per_million,
                   output_per_million = EXCLUDED.output_per_million, prior_input_per_million = EXCLUDED.prior_input_per_million,
                   prior_output_per_million = EXCLUDED.prior_output_per_million, price_from = EXCLUDED.price_from,
                   change_id = EXCLUDED.change_id, updated_at = now()",
                &[
                    &row.task,
                    &row.max_output_tokens,
                    &row.input_per_million,
                    &row.output_per_million,
                    &prior_in,
                    &prior_out,
                    &price_from.iso(),
                    &change_id,
                ],
            )?;
            let done = tx.query_one(
                &format!(
                    "UPDATE agents.route_change_requests SET status = 'applied', confirmed_by = $2, decided_at = now()
                      WHERE id = $1::text::uuid AND status = 'pending' RETURNING {}",
                    request_columns()
                ),
                &[&change_id, &operator_id],
            )?;
            audit(
                tx,
                &AuditRow {
                    key: format!("route-change:confirm:{change_id}"),
                    change_id,
                    task: &row.task,
                    action: "confirm",
                    operator_id,
                    proposed_by: &row.proposed_by,
                    before: Snapshot::of(&route),
                    after: Snapshot {
                        max_output_tokens: row.max_output_tokens,
                        input_per_million: row.input_per_million.clone(),
                        output_per_million: row.output_per_million.clone(),
                    },
                },
            )?;
            Ok(change_view(&done)?)
        })
    }
}

/// One `route_change_audit` row, as the desk answers it.
#[derive(Debug, Clone, PartialEq)]
pub struct AuditView {
    pub id: String,
    pub at: Instant,
    pub change_id: String,
    pub task: String,
    pub action: String,
    pub operator_id: String,
    pub proposed_by: String,
    pub before: Json,
    pub after: Json,
}

impl AuditView {
    /// `routeAuditRowSchema`, in its key order.
    pub fn json(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("at", Json::str(self.at.iso())),
            ("changeId", Json::str(self.change_id.clone())),
            ("task", Json::str(self.task.clone())),
            ("action", Json::str(self.action.clone())),
            ("operatorId", Json::str(self.operator_id.clone())),
            ("proposedBy", Json::str(self.proposed_by.clone())),
            ("before", snapshot_json(&self.before)),
            ("after", snapshot_json(&self.after)),
        ])
    }
}

/// A stored snapshot read back in `routeSnapshotSchema`'s key order (zod's output parse rebuilds it so).
fn snapshot_json(stored: &Json) -> Json {
    let field = |k: &str| stored.get(k).cloned().unwrap_or(Json::Null);
    Json::obj([
        ("maxOutputTokens", field("maxOutputTokens")),
        ("inputPerMillion", field("inputPerMillion")),
        ("outputPerMillion", field("outputPerMillion")),
    ])
}

/// What `readRouteDesk` reads.
#[derive(Debug, Clone, PartialEq)]
pub struct DeskRead {
    pub pending: Vec<ChangeView>,
    /// The newest applied change of each task.
    pub applied: Vec<ChangeView>,
    pub audit: Vec<AuditView>,
}

const AUDIT_LIMIT: i64 = 100;

/// `readRouteDesk`.
pub fn read_desk(c: &mut impl GenericClient) -> Result<DeskRead, StoreError> {
    let cols = request_columns();
    let pending = c.query(
        &format!("SELECT {cols} FROM agents.route_change_requests WHERE status = 'pending' ORDER BY created_at"),
        &[],
    )?;
    let applied = c.query(
        &format!(
            "SELECT DISTINCT ON (task) {cols} FROM agents.route_change_requests WHERE status = 'applied' ORDER BY task, decided_at DESC"
        ),
        &[],
    )?;
    let audits = c.query(
        &format!(
            "SELECT id::text, {}, change_id::text, task, action, operator_id, proposed_by, before::text, after::text
               FROM agents.route_change_audit ORDER BY at DESC, id DESC LIMIT $1",
            ms_of("at")
        ),
        &[&AUDIT_LIMIT],
    )?;
    let parse = |t: String| json::parse(&t).map_err(|e| StoreError::new(e.message, None));
    Ok(DeskRead {
        pending: pending.iter().map(change_view).collect::<Result<_, _>>()?,
        applied: applied.iter().map(change_view).collect::<Result<_, _>>()?,
        audit: audits
            .iter()
            .map(|r| {
                Ok(AuditView {
                    id: r.try_get(0)?,
                    at: Instant(r.try_get(1)?),
                    change_id: r.try_get(2)?,
                    task: r.try_get(3)?,
                    action: r.try_get(4)?,
                    operator_id: r.try_get(5)?,
                    proposed_by: r.try_get(6)?,
                    before: parse(r.try_get(7)?)?,
                    after: parse(r.try_get(8)?)?,
                })
            })
            .collect::<Result<_, StoreError>>()?,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;
    use crate::gateway::routing::parse_routing_table;

    const ONE: service_kit::money::Amount = service_kit::money::Amount::ONE;

    fn at(iso: &str) -> Instant {
        service_kit::time::js_date(iso).unwrap()
    }

    fn config(provider: &str) -> RoutingTable {
        parse_routing_table(&format!(
            r#"{{"routes":[{{"task":"a.task","providerId":"{provider}","model":"reasoning-md","maxOutputTokens":100,"price":{{"inputPerMillion":"1","outputPerMillion":"5"}}}},{{"task":"b.task","providerId":"{provider}","model":"fast-sm","maxOutputTokens":50,"price":{{"inputPerMillion":"0.25","outputPerMillion":"1.25"}}}}]}}"#
        ))
        .unwrap()
    }

    fn change() -> RouteOverride {
        RouteOverride {
            task: "a.task".to_owned(),
            max_output_tokens: 200,
            price: Some(Price {
                input_per_million: 2 * ONE,
                output_per_million: 6 * ONE,
            }),
            prior_price: Some(Price {
                input_per_million: ONE,
                output_per_million: 5 * ONE,
            }),
            price_from: at("2026-11-16T10:15:00.000Z"),
        }
    }

    #[test]
    fn a_confirmed_change_sets_the_ceiling_at_once_and_the_rate_only_from_the_next_window() {
        let o = change();
        let before = with_overrides(
            &config("primary"),
            std::slice::from_ref(&o),
            at("2026-11-16T10:07:00.000Z"),
        );
        let r = before.routes.first().unwrap();
        assert_eq!(r.max_output_tokens, 200);
        assert_eq!(r.price, o.prior_price);
        let after = with_overrides(&config("primary"), std::slice::from_ref(&o), o.price_from);
        assert_eq!(after.routes.first().unwrap().price, o.price);
        assert_eq!(
            override_price_at(&o, Instant(o.price_from.0 - 1)),
            o.prior_price
        );
    }

    #[test]
    fn every_other_route_stays_as_configured_and_a_change_for_a_gone_task_is_ignored() {
        let o = change();
        let gone = RouteOverride {
            task: "gone.task".to_owned(),
            ..o.clone()
        };
        let t = with_overrides(&config("primary"), &[o.clone(), gone], o.price_from);
        assert_eq!(
            t.routes.iter().map(|r| r.task.as_str()).collect::<Vec<_>>(),
            ["a.task", "b.task"]
        );
        assert_eq!(t.routes.get(1), config("primary").routes.get(1));
    }

    #[test]
    fn a_provider_swapped_in_configuration_keeps_the_founders_change() {
        let o = change();
        let t = with_overrides(&config("secondary"), std::slice::from_ref(&o), o.price_from);
        let r = t.routes.first().unwrap();
        assert_eq!(
            (r.provider_id.as_str(), r.model.as_str()),
            ("secondary", "reasoning-md")
        );
        assert_eq!((r.max_output_tokens, r.price), (200, o.price));
    }

    #[test]
    fn a_blank_rate_stays_blank() {
        let o = RouteOverride {
            price: None,
            ..change()
        };
        let t = with_overrides(&config("primary"), std::slice::from_ref(&o), o.price_from);
        assert_eq!(t.routes.first().unwrap().price, None);
    }

    #[test]
    fn the_next_window_starts_at_the_next_whole_window_of_the_utc_day() {
        let next = |iso: &str, m: i64| next_window_start(at(iso), m).iso();
        assert_eq!(
            next("2026-11-16T10:07:00.000Z", 15),
            "2026-11-16T10:15:00.000Z"
        );
        assert_eq!(
            next("2026-11-16T10:15:00.000Z", 15),
            "2026-11-16T10:30:00.000Z"
        );
        assert_eq!(
            next("2026-11-16T23:59:59.999Z", 60),
            "2026-11-17T00:00:00.000Z"
        );
    }

    #[test]
    fn a_change_id_is_the_typescripts_shape_of_the_business_keys_hash() {
        let id = id_for("route-change:abc");
        assert_eq!(id.len(), 36);
        assert_eq!(id.get(14..15), Some("4"));
        assert_eq!(id.get(19..20), Some("8"));
        assert_eq!(id, id_for("route-change:abc"));
    }

    #[test]
    fn a_change_is_valid_only_with_a_ceiling_in_range_and_both_rates_or_neither() {
        let ok = ChangeInput {
            task: "a".to_owned(),
            max_output_tokens: 2,
            input_per_million: Some("0.10".to_owned()),
            output_per_million: Some("0".to_owned()),
        };
        assert_eq!(
            validate(&ok).unwrap().input_per_million.as_deref(),
            Some("0.1")
        );
        let refused = |c: ChangeInput| {
            assert_eq!(
                validate(&c),
                Err(DeskError::Refused("agents.route_change_invalid"))
            );
        };
        refused(ChangeInput {
            max_output_tokens: 0,
            ..ok.clone()
        });
        refused(ChangeInput {
            output_per_million: None,
            ..ok.clone()
        });
        refused(ChangeInput {
            input_per_million: Some("1e3".to_owned()),
            ..ok.clone()
        });
        refused(ChangeInput {
            input_per_million: Some("123456789012345678901".to_owned()),
            ..ok
        });
    }
}
