//! The operator's agent fleet (`fleet/control.ts`, AG-registry-01, AG-control-02): every agent on the platform in one
//! registry, with its owner, publisher, channels and risk signals read from stored rows, an audited CSV export, and the
//! switches. The brake is easy and the release is hard: one operator quarantines an agent or switches a whole kind
//! off; two distinct founders restore either. Every action and export writes one `agent_fleet_audit` row on a business
//! key, in the same transaction as what it records, so a retried request writes nothing twice. No money moves here.
//!
//! An agent is named by a reference: `product:<agent_id>` for a registered product agent, `own:<uuid>` for an agent a
//! person built.

use std::collections::BTreeMap;

use postgres::{GenericClient, IsolationLevel, Transaction};

use service_kit::json::{self, Json};
use service_kit::pg::Pool;

use crate::db::{self, Store, StoreError};
use crate::door::Ctx;
use crate::ops::{Ops, OpsError, iso, operator, pool};
use crate::runtime::funds::is_uuid;
use crate::runtime::guardrails::FLEET_HARD_MONEY_WRITE_TOOLS;
use crate::runtime::ms;

const OWN_PREFIX: &str = "own:";
const PRODUCT_PREFIX: &str = "product:";

/// The tools of a person's own agent that write (a draft it sends or a live write) or move value (`OWN_WRITE_TOOLS`,
/// from `own/catalog.ts` `OWN_TOOLS`): its one live write, `ledger.transfer` and the fleet's hard money writes.
pub fn is_own_write_tool(tool: &str) -> bool {
    OWN_WRITE_TOOLS.contains(&tool) || FLEET_HARD_MONEY_WRITE_TOOLS.contains(&tool)
}

/// `OWN_TOOLS` entries that write or move value besides the fleet's hard money writes.
pub const OWN_WRITE_TOOLS: [&str; 2] = ["support.ticket.comment", "ledger.transfer"];

/// A switch's row (`FleetSwitch`).
#[derive(Debug, Clone)]
struct Switch {
    reason: String,
    set_by: String,
    set_at: i64,
    restore_requested_by: Option<String>,
}

impl Switch {
    fn json(&self) -> Json {
        Json::obj([
            ("reason", Json::str(self.reason.clone())),
            ("setBy", Json::str(self.set_by.clone())),
            ("setAt", iso(self.set_at)),
            (
                "restoreRequestedBy",
                self.restore_requested_by
                    .clone()
                    .map_or(Json::Null, Json::String),
            ),
        ])
    }
}

/// One agent of the registry (`FleetRow`).
#[derive(Debug, Clone)]
pub struct FleetRow {
    pub reference: String,
    pub name: Option<String>,
    pub kind: &'static str,
    pub owner_id: Option<String>,
    pub publisher_id: Option<String>,
    pub channels: Option<Vec<String>>,
    pub risk_signals: Vec<&'static str>,
    pub status: &'static str,
    pub last_run_at: Option<i64>,
    quarantine: Option<Switch>,
    kind_switch: Option<Switch>,
}

impl FleetRow {
    /// `fleetRowSchema`, in its order.
    pub fn json(&self) -> Json {
        let opt = |v: &Option<String>| v.clone().map_or(Json::Null, Json::String);
        Json::obj([
            ("ref", Json::str(self.reference.clone())),
            ("name", opt(&self.name)),
            ("kind", Json::str(self.kind)),
            ("ownerId", opt(&self.owner_id)),
            ("publisherId", opt(&self.publisher_id)),
            (
                "channels",
                self.channels.as_ref().map_or(Json::Null, |c| {
                    Json::Array(c.iter().map(|s| Json::str(s.clone())).collect())
                }),
            ),
            (
                "riskSignals",
                Json::Array(self.risk_signals.iter().map(|s| Json::str(*s)).collect()),
            ),
            ("status", Json::str(self.status)),
            ("lastRunAt", self.last_run_at.map_or(Json::Null, iso)),
            (
                "quarantine",
                self.quarantine.as_ref().map_or(Json::Null, Switch::json),
            ),
            (
                "kindSwitch",
                self.kind_switch.as_ref().map_or(Json::Null, Switch::json),
            ),
        ])
    }
}

fn switches(c: &mut impl GenericClient, sql: &str) -> Result<BTreeMap<String, Switch>, StoreError> {
    let mut out = BTreeMap::new();
    for r in c.query(sql, &[])? {
        out.insert(
            r.try_get(0)?,
            Switch {
                reason: r.try_get(1)?,
                set_by: r.try_get(2)?,
                set_at: r.try_get(3)?,
                restore_requested_by: r.try_get(4)?,
            },
        );
    }
    Ok(out)
}

/// A product agent's guardrail as the registry reads it: any `write` tool, and whether its spend cap is set.
fn product_flags(guardrail: &str) -> (bool, bool) {
    let g = json::parse(guardrail).unwrap_or(Json::Null);
    let write = match g.get("tools") {
        Some(Json::Array(tools)) => tools
            .iter()
            .any(|t| matches!(t.get("mode"), Some(Json::String(m)) if m == "write")),
        _ => false,
    };
    let cap = g.get("limits").and_then(|l| l.get("maxSpendPerSession"));
    (write, matches!(cap, None | Some(Json::Null)))
}

/// `readFleet`: product agents by id, then people's agents newest first, so a page never hides a new one.
pub fn read_fleet(p: &Pool) -> Result<Vec<FleetRow>, StoreError> {
    db::with_client(p, |c| {
        let products = c.query(
            "SELECT agent_id, name, guardrail::text, enabled FROM agents.agent_definitions
              WHERE agent_id NOT LIKE 'own.%' ORDER BY agent_id",
            &[],
        )?;
        let owns = c.query(
            "SELECT id::text, owner_id, name, tools::text, per_session_cap IS NULL, state::text
               FROM agents.own_agents ORDER BY created_at DESC, id",
            &[],
        )?;
        let quarantined = switches(
            c,
            &format!(
                "SELECT agent_ref, reason, set_by, {}, restore_requested_by FROM agents.agent_switches",
                ms("set_at")
            ),
        )?;
        let kinds = switches(
            c,
            &format!(
                "SELECT kind, reason, set_by, {}, restore_requested_by FROM agents.agent_kind_switches",
                ms("set_at")
            ),
        )?;
        let mut assigned = BTreeMap::new();
        for r in c.query(
            "SELECT agent_ref, owner_id FROM agents.agent_owner_assignments",
            &[],
        )? {
            assigned.insert(r.try_get::<_, String>(0)?, r.try_get::<_, String>(1)?);
        }
        let mut last_run = BTreeMap::new();
        for r in c.query(
            &format!(
                "SELECT agent_id, {} FROM agents.agent_sessions GROUP BY agent_id",
                ms("max(opened_at)")
            ),
            &[],
        )? {
            last_run.insert(r.try_get::<_, String>(0)?, r.try_get::<_, i64>(1)?);
        }
        let mut channels = BTreeMap::new();
        for r in c.query(
            "SELECT agent_id::text, array_agg(surface ORDER BY surface)::text[] FROM agents.own_agent_surfaces GROUP BY agent_id",
            &[],
        )? {
            channels.insert(r.try_get::<_, String>(0)?, r.try_get::<_, Vec<String>>(1)?);
        }

        let finish = |reference: String,
                      name: Option<String>,
                      kind: &'static str,
                      owner_id: Option<String>,
                      publisher_id: Option<String>,
                      ch: Option<Vec<String>>,
                      last_run_at: Option<i64>,
                      (write_tool, no_cap, enabled): (bool, bool, bool)| {
            let quarantine = quarantined.get(&reference).cloned();
            let kind_switch = kinds.get(kind).cloned();
            let status = if quarantine.is_some() {
                "quarantined"
            } else if kind_switch.is_some() {
                "disabled_by_kind"
            } else if enabled {
                "active"
            } else {
                "disabled"
            };
            let mut risk = Vec::new();
            if owner_id.is_none() && status == "active" {
                risk.push("no_owner");
            }
            if write_tool {
                risk.push("write_tool");
            }
            if no_cap {
                risk.push("no_spend_cap");
            }
            if last_run_at.is_none() {
                risk.push("never_run");
            }
            FleetRow {
                reference,
                name,
                kind,
                owner_id,
                publisher_id,
                channels: ch,
                risk_signals: risk,
                status,
                last_run_at,
                quarantine,
                kind_switch,
            }
        };

        let mut rows = Vec::new();
        for r in &products {
            let id: String = r.try_get(0)?;
            let reference = format!("{PRODUCT_PREFIX}{id}");
            let (write, no_cap) = product_flags(&r.try_get::<_, String>(2)?);
            rows.push(finish(
                reference.clone(),
                r.try_get(1)?,
                "product",
                assigned.get(&reference).cloned(),
                // A product agent's publisher and channels are not stored yet: "not set", never an invented value.
                None,
                None,
                last_run.get(&id).copied(),
                (write, no_cap, r.try_get(3)?),
            ));
        }
        for r in &owns {
            let id: String = r.try_get(0)?;
            let reference = format!("{OWN_PREFIX}{id}");
            let owner: String = r.try_get(1)?;
            let name: String = r.try_get(2)?;
            let tools = match json::parse(&r.try_get::<_, String>(3)?) {
                Ok(Json::Array(list)) => list,
                _ => Vec::new(),
            };
            let state: String = r.try_get(5)?;
            rows.push(finish(
                reference.clone(),
                (!name.is_empty()).then_some(name),
                "customer_built",
                Some(
                    assigned
                        .get(&reference)
                        .cloned()
                        .unwrap_or_else(|| owner.clone()),
                ),
                // A person's agent is published by the person who built it; a draft by no one yet.
                (state == "published").then_some(owner),
                channels.get(&id).cloned(),
                last_run.get(&format!("own.{id}")).copied(),
                (
                    tools
                        .iter()
                        .any(|t| matches!(t, Json::String(name) if is_own_write_tool(name))),
                    r.try_get(4)?,
                    true,
                ),
            ));
        }
        Ok(rows)
    })
}

/// `FleetFilter`: each field, when given, narrows the rows.
#[derive(Debug, Clone, Default)]
pub struct Filter {
    pub risk_signal: Option<String>,
    pub status: Option<String>,
    pub kind: Option<String>,
    pub ownerless: Option<bool>,
}

impl Filter {
    fn of(ctx: &Ctx<'_>) -> Filter {
        let s = |k: &str| ctx.input.get(k).as_str().map(str::to_owned);
        Filter {
            risk_signal: s("riskSignal"),
            status: s("status"),
            kind: s("kind"),
            ownerless: match ctx.input.get("ownerless") {
                service_kit::schema::Value::Bool(b) => Some(*b),
                _ => None,
            },
        }
    }

    /// `filterRecord`: the fields given, as strings, in the input's order.
    fn record(&self) -> Json {
        let mut fields = Vec::new();
        for (k, v) in [
            ("riskSignal", self.risk_signal.clone()),
            ("status", self.status.clone()),
            ("kind", self.kind.clone()),
            ("ownerless", self.ownerless.map(|b| b.to_string())),
        ] {
            if let Some(v) = v {
                fields.push((k.to_owned(), Json::String(v)));
            }
        }
        Json::Object(fields)
    }

    /// `filterFleet`. A blank string is not a filter, as `!filter.x` reads it.
    pub fn apply(&self, rows: &[FleetRow]) -> Vec<FleetRow> {
        let given = |v: &Option<String>| v.clone().filter(|s| !s.is_empty());
        rows.iter()
            .filter(|r| {
                given(&self.risk_signal).is_none_or(|s| r.risk_signals.contains(&s.as_str()))
                    && given(&self.status).is_none_or(|s| r.status == s)
                    && given(&self.kind).is_none_or(|k| r.kind == k)
                    && self.ownerless.is_none_or(|o| r.owner_id.is_none() == o)
            })
            .cloned()
            .collect()
    }
}

/// `fleetCounts`.
fn counts(rows: &[FleetRow]) -> Json {
    let n = |f: &dyn Fn(&FleetRow) -> bool| {
        Json::int(i64::try_from(rows.iter().filter(|r| f(r)).count()).unwrap_or(0))
    };
    Json::obj([
        ("total", Json::int(i64::try_from(rows.len()).unwrap_or(0))),
        ("ownerless", n(&|r| r.owner_id.is_none())),
        (
            "unmanaged",
            n(&|r| r.owner_id.is_none() && r.kind != "product"),
        ),
        (
            "disabled",
            n(&|r| r.status == "disabled" || r.status == "disabled_by_kind"),
        ),
        ("quarantined", n(&|r| r.status == "quarantined")),
    ])
}

/// `fleetCsv`: a header and one line per agent; a value not stored is "not set"; a line break inside a value is a space.
pub fn fleet_csv(rows: &[FleetRow]) -> String {
    const NOT_SET: &str = "not set";
    let cell = |v: &str| {
        let mut flat = String::new();
        let mut in_break = false;
        for ch in v.chars() {
            if ch == '\r' || ch == '\n' {
                if !in_break {
                    flat.push(' ');
                }
                in_break = true;
            } else {
                flat.push(ch);
                in_break = false;
            }
        }
        if flat.contains(['"', ',', '\r', '\n']) {
            format!("\"{}\"", flat.replace('"', "\"\""))
        } else {
            flat
        }
    };
    let mut lines =
        vec!["agent,name,kind,owner,publisher,channels,status,risk_signals,last_run_at".to_owned()];
    for r in rows {
        let last = r.last_run_at.map_or_else(
            || NOT_SET.to_owned(),
            |t| service_kit::time::Instant(t).iso(),
        );
        lines.push(
            [
                r.reference.clone(),
                r.name.clone().unwrap_or_else(|| NOT_SET.to_owned()),
                r.kind.to_owned(),
                r.owner_id.clone().unwrap_or_else(|| NOT_SET.to_owned()),
                r.publisher_id.clone().unwrap_or_else(|| NOT_SET.to_owned()),
                r.channels
                    .as_ref()
                    .map_or_else(|| NOT_SET.to_owned(), |c| c.join(" ")),
                r.status.to_owned(),
                r.risk_signals.join(" "),
                last,
            ]
            .iter()
            .map(|c| cell(c))
            .collect::<Vec<_>>()
            .join(","),
        );
    }
    format!("{}\n", lines.join("\n"))
}

/// `ownAgentSwitch`: whether new work of one of a person's agents may start: `active`, or the switch that stops it.
pub fn own_agent_switch(
    c: &mut impl GenericClient,
    agent_id: &str,
) -> Result<&'static str, StoreError> {
    let reference = format!("{OWN_PREFIX}{agent_id}");
    let r = c.query_one(
        "SELECT EXISTS (SELECT 1 FROM agents.agent_switches WHERE agent_ref = $1::text),
                EXISTS (SELECT 1 FROM agents.agent_kind_switches WHERE kind = 'customer_built')",
        &[&reference],
    )?;
    let (quarantined, kind_off): (bool, bool) = (r.try_get(0)?, r.try_get(1)?);
    Ok(if quarantined {
        "quarantined"
    } else if kind_off {
        "disabled_by_kind"
    } else {
        "active"
    })
}

/// `productKindOff`: a new product session refuses while the product kind is switched off.
pub fn product_kind_off(p: &Pool) -> Result<bool, StoreError> {
    db::with_client(p, |c| {
        Ok(c.query_one(
            "SELECT EXISTS (SELECT 1 FROM agents.agent_kind_switches WHERE kind = 'product')",
            &[],
        )?
        .try_get(0)?)
    })
}

/// `fleetKey`: one action's business key.
pub fn fleet_key(action: &str, operator_id: &str, request_id: &str) -> String {
    format!("agents:fleet:{action}:{operator_id}:{request_id}")
}

/// `requestIdOf`: the request id inside a business key.
pub fn request_id_of(business_key: &str, action: &str, operator_id: &str) -> String {
    let prefix = fleet_key(action, operator_id, "");
    business_key
        .strip_prefix(&prefix)
        .unwrap_or(business_key)
        .to_owned()
}

/// One audit row to write.
#[derive(Default)]
struct Record<'a> {
    key: String,
    operator_id: &'a str,
    action: &'a str,
    agent_ref: Option<&'a str>,
    kind: Option<&'a str>,
    reason: Option<&'a str>,
    filter: Option<Json>,
    row_count: Option<i32>,
}

/// `recordAction`: the row once; true when this call wrote it. A key already used for another target is refused.
fn record_action(tx: &mut Transaction<'_>, row: &Record<'_>) -> Result<bool, OpsError> {
    let filter = row
        .filter
        .clone()
        .unwrap_or(Json::Object(Vec::new()))
        .compact();
    let inserted = tx.query(
        "INSERT INTO agents.agent_fleet_audit (business_key, operator_id, action, agent_ref, kind, reason, filter, row_count)
         VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text::jsonb, $8::int)
         ON CONFLICT (business_key) DO NOTHING
         RETURNING id",
        &[&row.key, &row.operator_id, &row.action, &row.agent_ref, &row.kind, &row.reason, &filter, &row.row_count],
    )?;
    if !inserted.is_empty() {
        return Ok(true);
    }
    let stored = tx.query(
        "SELECT agent_ref, kind FROM agents.agent_fleet_audit WHERE business_key = $1::text",
        &[&row.key],
    )?;
    let same = stored.first().is_some_and(|s| {
        s.get::<_, Option<String>>(0).as_deref() == row.agent_ref
            && s.get::<_, Option<String>>(1).as_deref() == row.kind
    });
    if !same {
        return Err(OpsError::Refused("agents.fleet_request_reused"));
    }
    Ok(false)
}

fn assert_reason(reason: Option<&str>) -> Result<String, OpsError> {
    let picked = service_kit::schema::js_trim(reason.unwrap_or(""));
    if picked.is_empty() {
        return Err(OpsError::Refused("agents.reason_required"));
    }
    Ok(picked.to_owned())
}

/// `assertAgent`: the agent a reference names, as stored now: (kind, id).
fn assert_agent(
    tx: &mut Transaction<'_>,
    reference: &str,
) -> Result<(&'static str, String), OpsError> {
    // The two prefixes never both match.
    let found = match (
        reference.strip_prefix(PRODUCT_PREFIX),
        reference.strip_prefix(OWN_PREFIX),
    ) {
        (Some(id), _) if !id.starts_with("own.") => {
            let rows = tx.query(
                "SELECT 1 FROM agents.agent_definitions WHERE agent_id = $1::text",
                &[&id],
            )?;
            (!rows.is_empty()).then_some(("product", id))
        }
        (_, Some(id)) if is_uuid(id) => {
            let rows = tx.query(
                "SELECT 1 FROM agents.own_agents WHERE id = $1::text::uuid",
                &[&id],
            )?;
            (!rows.is_empty()).then_some(("customer_built", id))
        }
        _ => None,
    };
    found
        .map(|(kind, id)| (kind, id.to_owned()))
        .ok_or(OpsError::Refused("agents.agent_not_found"))
}

fn exists(tx: &mut Transaction<'_>, sql: &str, a: &str, b: &str) -> Result<bool, OpsError> {
    Ok(!tx.query(sql, &[&a, &b])?.is_empty())
}

/// A fleet store transaction: serializable, up to five attempts (`transaction`'s defaults).
fn serializable<T>(
    p: &Pool,
    f: impl FnMut(&mut Transaction<'_>) -> Result<T, OpsError>,
) -> Result<T, OpsError> {
    db::transaction_retrying(p, IsolationLevel::Serializable, 5, f)
}

fn kind_count(c: &mut impl GenericClient, kind: &str) -> Result<i64, StoreError> {
    let sql = if kind == "product" {
        "SELECT count(*)::bigint FROM agents.agent_definitions WHERE agent_id NOT LIKE 'own.%'"
    } else {
        "SELECT count(*)::bigint FROM agents.own_agents"
    };
    Ok(c.query_one(sql, &[])?.try_get(0)?)
}

fn quarantine(
    p: &Pool,
    op: &str,
    reference: &str,
    reason: Option<&str>,
    request: &str,
) -> Result<(), OpsError> {
    let why = assert_reason(reason)?;
    serializable(p, |tx| {
        let (kind, id) = assert_agent(tx, reference)?;
        let key = fleet_key("quarantine", op, request);
        let existing = !tx
            .query(
                "SELECT 1 FROM agents.agent_switches WHERE agent_ref = $1::text FOR UPDATE",
                &[&reference],
            )?
            .is_empty();
        if existing {
            // The same request again is the first answer; a new request on a quarantined agent is refused by name.
            if exists(
                tx,
                "SELECT 1 FROM agents.agent_fleet_audit WHERE business_key = $1::text AND agent_ref = $2::text",
                &key,
                reference,
            )? {
                return Ok(());
            }
            return Err(OpsError::Refused("agents.fleet_already_quarantined"));
        }
        let rec = Record {
            key,
            operator_id: op,
            action: "quarantine",
            agent_ref: Some(reference),
            reason: Some(&why),
            ..Record::default()
        };
        if !record_action(tx, &rec)? {
            return Ok(());
        }
        tx.execute(
            "INSERT INTO agents.agent_switches (agent_ref, reason, set_by) VALUES ($1::text, $2::text, $3::text)",
            &[&reference, &why, &op],
        )?;
        // A product agent's own switch goes off too, which a boot re-register keeps.
        if kind == "product" {
            tx.execute(
                "UPDATE agents.agent_definitions SET enabled = false WHERE agent_id = $1::text",
                &[&id],
            )?;
        }
        Ok(())
    })
}

/// The first founder's press records the request; a different founder's press restores. The same founder again
/// changes nothing.
fn restore(p: &Pool, op: &str, reference: &str, request: &str) -> Result<&'static str, OpsError> {
    serializable(p, |tx| {
        let (kind, id) = assert_agent(tx, reference)?;
        let current = tx.query(
            "SELECT restore_requested_by FROM agents.agent_switches WHERE agent_ref = $1::text FOR UPDATE",
            &[&reference],
        )?;
        let Some(current) = current.first() else {
            if exists(
                tx,
                "SELECT 1 FROM agents.agent_fleet_audit WHERE business_key = $1::text AND agent_ref = $2::text",
                &fleet_key("restore", op, request),
                reference,
            )? {
                return Ok("restored");
            }
            return Err(OpsError::Refused("agents.fleet_not_quarantined"));
        };
        let requested: Option<String> = current.try_get(0)?;
        if requested.as_deref().is_none_or(|r| r == op) {
            let rec = Record {
                key: fleet_key("restore_request", op, request),
                operator_id: op,
                action: "restore_request",
                agent_ref: Some(reference),
                ..Record::default()
            };
            if record_action(tx, &rec)? {
                tx.execute(
                    "UPDATE agents.agent_switches SET restore_requested_by = $1::text, restore_requested_at = now()
                      WHERE agent_ref = $2::text AND restore_requested_by IS NULL",
                    &[&op, &reference],
                )?;
            }
            return Ok("waiting_second_founder");
        }
        let rec = Record {
            key: fleet_key("restore", op, request),
            operator_id: op,
            action: "restore",
            agent_ref: Some(reference),
            ..Record::default()
        };
        if record_action(tx, &rec)? {
            tx.execute(
                "DELETE FROM agents.agent_switches WHERE agent_ref = $1::text",
                &[&reference],
            )?;
            if kind == "product" {
                tx.execute(
                    "UPDATE agents.agent_definitions SET enabled = true WHERE agent_id = $1::text",
                    &[&id],
                )?;
            }
        }
        Ok("restored")
    })
}

/// Every agent of one kind off in one audited action; a restart reads the row again and never re-enables it.
fn kill_kind(
    p: &Pool,
    op: &str,
    kind: &str,
    reason: Option<&str>,
    request: &str,
) -> Result<i64, OpsError> {
    let why = assert_reason(reason)?;
    serializable(p, |tx| {
        let key = fleet_key("kill_kind", op, request);
        let existing = !tx
            .query(
                "SELECT 1 FROM agents.agent_kind_switches WHERE kind = $1::text FOR UPDATE",
                &[&kind],
            )?
            .is_empty();
        if existing {
            if exists(
                tx,
                "SELECT 1 FROM agents.agent_fleet_audit WHERE business_key = $1::text AND kind = $2::text",
                &key,
                kind,
            )? {
                return Ok(());
            }
            return Err(OpsError::Refused("agents.fleet_kind_already_off"));
        }
        let count = i32::try_from(kind_count(tx, kind)?).unwrap_or(i32::MAX);
        let rec = Record {
            key,
            operator_id: op,
            action: "kill_kind",
            kind: Some(kind),
            reason: Some(&why),
            row_count: Some(count),
            ..Record::default()
        };
        if !record_action(tx, &rec)? {
            return Ok(());
        }
        tx.execute(
            "INSERT INTO agents.agent_kind_switches (kind, reason, set_by) VALUES ($1::text, $2::text, $3::text)",
            &[&kind, &why, &op],
        )?;
        Ok(())
    })?;
    Ok(db::with_client(p, |c| kind_count(c, kind))?)
}

fn restore_kind(p: &Pool, op: &str, kind: &str, request: &str) -> Result<&'static str, OpsError> {
    serializable(p, |tx| {
        let current = tx.query(
            "SELECT restore_requested_by FROM agents.agent_kind_switches WHERE kind = $1::text FOR UPDATE",
            &[&kind],
        )?;
        let Some(current) = current.first() else {
            if exists(
                tx,
                "SELECT 1 FROM agents.agent_fleet_audit WHERE business_key = $1::text AND kind = $2::text",
                &fleet_key("restore_kind", op, request),
                kind,
            )? {
                return Ok("restored");
            }
            return Err(OpsError::Refused("agents.fleet_kind_not_off"));
        };
        let requested: Option<String> = current.try_get(0)?;
        if requested.as_deref().is_none_or(|r| r == op) {
            let rec = Record {
                key: fleet_key("restore_kind_request", op, request),
                operator_id: op,
                action: "restore_kind_request",
                kind: Some(kind),
                ..Record::default()
            };
            if record_action(tx, &rec)? {
                tx.execute(
                    "UPDATE agents.agent_kind_switches SET restore_requested_by = $1::text, restore_requested_at = now()
                      WHERE kind = $2::text AND restore_requested_by IS NULL",
                    &[&op, &kind],
                )?;
            }
            return Ok("waiting_second_founder");
        }
        let rec = Record {
            key: fleet_key("restore_kind", op, request),
            operator_id: op,
            action: "restore_kind",
            kind: Some(kind),
            ..Record::default()
        };
        if record_action(tx, &rec)? {
            tx.execute(
                "DELETE FROM agents.agent_kind_switches WHERE kind = $1::text",
                &[&kind],
            )?;
        }
        Ok("restored")
    })
}

/// Gives an agent with no owner an owner of record; an agent with an owner is refused, never taken from them.
fn reassign(
    p: &Pool,
    op: &str,
    reference: &str,
    owner_id: &str,
    request: &str,
) -> Result<(), OpsError> {
    serializable(p, |tx| {
        let (kind, _) = assert_agent(tx, reference)?;
        let key = fleet_key("reassign", op, request);
        let assigned = !tx
            .query(
                "SELECT owner_id FROM agents.agent_owner_assignments WHERE agent_ref = $1::text FOR UPDATE",
                &[&reference],
            )?
            .is_empty();
        if exists(
            tx,
            "SELECT 1 FROM agents.agent_fleet_audit WHERE business_key = $1::text AND agent_ref = $2::text",
            &key,
            reference,
        )? {
            return Ok(());
        }
        if assigned || kind == "customer_built" {
            return Err(OpsError::Refused("agents.fleet_owner_present"));
        }
        let rec = Record {
            key,
            operator_id: op,
            action: "reassign",
            agent_ref: Some(reference),
            ..Record::default()
        };
        record_action(tx, &rec)?;
        tx.execute(
            "INSERT INTO agents.agent_owner_assignments (agent_ref, owner_id, assigned_by) VALUES ($1::text, $2::text, $3::text)",
            &[&reference, &owner_id, &op],
        )?;
        Ok(())
    })
}

/// `recordExport`: one audit row per request id, naming the filter and the row count; how many rows carry the key.
fn record_export(
    p: &Pool,
    op: &str,
    request: &str,
    filter: &Json,
    rows: i64,
) -> Result<i64, OpsError> {
    serializable(p, |tx| {
        let key = fleet_key("export", op, request);
        let rec = Record {
            key: key.clone(),
            operator_id: op,
            action: "export",
            filter: Some(filter.clone()),
            row_count: Some(i32::try_from(rows).unwrap_or(i32::MAX)),
            ..Record::default()
        };
        record_action(tx, &rec)?;
        let same: bool = tx
            .query_one(
                "SELECT coalesce(bool_and(filter = $2::text::jsonb), false) FROM agents.agent_fleet_audit WHERE business_key = $1::text",
                &[&key, &filter.compact()],
            )?
            .try_get(0)?;
        if !same {
            return Err(OpsError::Refused("agents.fleet_request_reused"));
        }
        Ok(tx
            .query_one(
                "SELECT count(*)::bigint FROM agents.agent_fleet_audit WHERE business_key = $1::text",
                &[&key],
            )?
            .try_get(0)?)
    })
}

/// `readFleetAudit`: the newest `limit` rows, newest first.
fn read_audit(p: &Pool, limit: i64) -> Result<Json, StoreError> {
    db::with_client(p, |c| {
        let rows = c.query(
            &format!(
                "SELECT id::text, {}, business_key, operator_id, action, agent_ref, kind, reason, filter::text, row_count
                   FROM agents.agent_fleet_audit ORDER BY at DESC, id DESC LIMIT $1::bigint",
                ms("at")
            ),
            &[&limit],
        )?;
        let mut out = Vec::new();
        for r in &rows {
            let (key, op, action): (String, String, String) =
                (r.try_get(2)?, r.try_get(3)?, r.try_get(4)?);
            let opt = |v: Option<String>| v.map_or(Json::Null, Json::String);
            let filter = match json::parse(&r.try_get::<_, String>(8)?) {
                Ok(Json::Object(fields)) => Json::Object(
                    fields
                        .into_iter()
                        .map(|(k, v)| {
                            let s = match v {
                                Json::String(s) => s,
                                Json::Number(n) => json::js_number_string(n),
                                Json::Bool(b) => b.to_string(),
                                Json::Null => "null".to_owned(),
                                Json::Array(_) | Json::Object(_) => v.compact(),
                            };
                            (k, Json::String(s))
                        })
                        .collect(),
                ),
                _ => Json::Object(Vec::new()),
            };
            out.push(Json::obj([
                ("id", Json::str(r.try_get::<_, String>(0)?)),
                ("at", iso(r.try_get(1)?)),
                ("operatorId", Json::str(op.clone())),
                ("action", Json::str(action.clone())),
                ("agentRef", opt(r.try_get(5)?)),
                ("kind", opt(r.try_get(6)?)),
                ("reason", opt(r.try_get(7)?)),
                ("filter", filter),
                (
                    "rowCount",
                    r.try_get::<_, Option<i32>>(9)?
                        .map_or(Json::Null, |n| Json::int(i64::from(n))),
                ),
                ("requestId", Json::str(request_id_of(&key, &action, &op))),
            ]));
        }
        Ok(Json::Array(out))
    })
}

fn registry_limit(ops: &Ops) -> Result<i64, OpsError> {
    ops.registry_limit
        .ok_or(OpsError::Refused("agents.registry_list_limit_unset"))
}

/// Answers one `fleet.*` call.
pub fn handle(call: &str, ctx: &Ctx<'_>, store: &Store, ops: &Ops) -> Result<Json, OpsError> {
    let input = |k: &str| ctx.input.get(k).as_str();
    let op = operator(ctx);
    let reference = input("ref").unwrap_or("");
    let request = input("requestId").unwrap_or("");
    match call {
        "registry" => {
            let limit = registry_limit(ops)?;
            let all = read_fleet(pool(store)?)?;
            let matched = Filter::of(ctx).apply(&all);
            let shown = usize::try_from(limit).unwrap_or(0);
            Ok(Json::obj([
                ("counts", counts(&all)),
                (
                    "rows",
                    Json::Array(matched.iter().take(shown).map(FleetRow::json).collect()),
                ),
                (
                    "filtered",
                    Json::int(i64::try_from(matched.len()).unwrap_or(0)),
                ),
                ("more", Json::Bool(matched.len() > shown)),
                ("limit", Json::int(limit)),
            ]))
        }
        "audit" => {
            let limit = registry_limit(ops)?;
            Ok(Json::obj([
                ("rows", read_audit(pool(store)?, limit)?),
                ("limit", Json::int(limit)),
            ]))
        }
        "export" => {
            let p = pool(store)?;
            let filter = Filter::of(ctx);
            let matched = filter.apply(&read_fleet(p)?);
            let rows = i64::try_from(matched.len()).unwrap_or(0);
            let audit_rows = record_export(p, op, request, &filter.record(), rows)?;
            Ok(Json::obj([
                ("csv", Json::str(fleet_csv(&matched))),
                ("rows", Json::int(rows)),
                ("auditRows", Json::int(audit_rows)),
            ]))
        }
        "quarantine" => {
            quarantine(pool(store)?, op, reference, input("reason"), request)?;
            Ok(Json::obj([("ok", Json::Bool(true))]))
        }
        "restore" => Ok(Json::obj([(
            "outcome",
            Json::str(restore(pool(store)?, op, reference, request)?),
        )])),
        "killKind" => Ok(Json::obj([(
            "agents",
            Json::int(kill_kind(
                pool(store)?,
                op,
                input("kind").unwrap_or(""),
                input("reason"),
                request,
            )?),
        )])),
        "restoreKind" => Ok(Json::obj([(
            "outcome",
            Json::str(restore_kind(
                pool(store)?,
                op,
                input("kind").unwrap_or(""),
                request,
            )?),
        )])),
        "reassign" => {
            reassign(
                pool(store)?,
                op,
                reference,
                input("ownerId").unwrap_or(""),
                request,
            )?;
            Ok(Json::obj([("ok", Json::Bool(true))]))
        }
        other => Err(OpsError::Store(StoreError::new(
            format!("svc-agents in Rust: fleet.{other} is not a fleet call"),
            None,
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_id_is_read_back_from_its_business_key() {
        let key = fleet_key("export", "op-1", "agents-fleet:export:a1");
        assert_eq!(
            request_id_of(&key, "export", "op-1"),
            "agents-fleet:export:a1"
        );
        assert_eq!(request_id_of("other", "export", "op-1"), "other");
    }

    #[test]
    fn a_product_guardrail_reads_its_write_tool_and_its_cap() {
        assert_eq!(
            product_flags(r#"{"tools":[{"mode":"write"}],"limits":{"maxSpendPerSession":null}}"#),
            (true, true)
        );
        assert_eq!(
            product_flags(r#"{"tools":[{"mode":"read"}],"limits":{"maxSpendPerSession":"5"}}"#),
            (false, false)
        );
        assert_eq!(product_flags(r#"{"tools":"x"}"#), (false, true));
    }
}
