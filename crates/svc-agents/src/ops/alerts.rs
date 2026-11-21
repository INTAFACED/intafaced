//! The operator's agent alert desk (`alerts/routes.ts`, AG-analytics-02, AG-guardrails-02; J-agents-16).
//!
//! A rule is a measure over every agent action recorded (refusal or failure rate in percent of the window's actions,
//! or cost in the fee asset), a threshold the operator typed (blank refused by name, 0 a value), a window in minutes,
//! and optionally one agent. The evaluator reads each rule's current window and the one before (aligned to the epoch);
//! a window with no actions has no rate and fires nothing; a breach writes one alert per rule and window, in the same
//! statement, so a second evaluation writes nothing. An alert is handed to notifications (`agentAlertFired`) once, on
//! its business key, while they are on; one the bus refuses stays pending for the next sweep.
//!
//! The managed baseline is the owner's (`AGENTS_POLICY_BASELINE`); this desk shows it and sets this environment's
//! override per tool class, which may only narrow it. Nothing here moves value.

use service_kit::json::Json;
use service_kit::pg::Pool;
use service_kit::time::Instant;

use crate::db::{self, Store, StoreError};
use crate::door::Ctx;
use crate::metering::Metering;
use crate::ops::{
    DATA_CLASSES, Ops, OpsError, PolicyBaseline, iso, looseness, operator, pool, stricter,
};
use crate::runtime::{envelope, ms};

/// `agentAlertFired`'s subject.
pub const AGENT_ALERT_FIRED: &str = "intafaced.agents.alert.triggered";
/// `ALERTS_LISTED`: most alerts one desk read lists, newest first.
pub const ALERTS_LISTED: i64 = 200;

/// `trimDecimal`: Postgres numeric text without its padding zeros, never through a float.
pub fn trim_decimal(text: &str) -> String {
    if !text.contains('.') {
        return text.to_owned();
    }
    let t = text.trim_end_matches('0');
    let t = t.strip_suffix('.').unwrap_or(t);
    if t.is_empty() {
        "0".to_owned()
    } else {
        t.to_owned()
    }
}

/// `DECIMAL`: up to 20 digits, then optionally a point and up to 18.
fn is_decimal(text: &str) -> bool {
    let (whole, fraction) = match text.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (text, None),
    };
    let digits =
        |s: &str, max: usize| (1..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit());
    digits(whole, 20) && fraction.is_none_or(|f| digits(f, 18))
}

/// `parseThreshold`: blank refused by name; a rate is a percent from 0 to 100. The decimal string as typed (trimmed).
pub fn parse_threshold(measure: &str, raw: Option<&str>) -> Result<String, OpsError> {
    let text = service_kit::schema::js_trim(raw.unwrap_or(""));
    if text.is_empty() {
        return Err(OpsError::Refused("agents.alert_threshold_required"));
    }
    if !is_decimal(text) {
        return Err(OpsError::Refused("agents.alert_threshold_invalid"));
    }
    if measure != "cost" {
        let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
        let whole = whole.trim_start_matches('0');
        let over = whole.len() > 3
            || whole.parse::<u32>().unwrap_or(0) > 100
            || (whole == "100" && fraction.bytes().any(|b| (b'1'..=b'9').contains(&b)));
        if over {
            return Err(OpsError::Refused("agents.alert_threshold_invalid"));
        }
    }
    Ok(text.to_owned())
}

/// The baseline's requirement for one class: blank refuses.
fn required(baseline: &PolicyBaseline, data_class: &str) -> Result<&'static str, OpsError> {
    baseline
        .of(data_class)
        .ok_or(OpsError::Refused("agents.baseline_value_unset"))
}

/// `checkChoice`: the built-in law first (a live write never acts without asking), then the baseline narrowed by this
/// environment's override. Returns what applies.
pub fn check_choice(
    data_class: &str,
    choice: &str,
    baseline: &PolicyBaseline,
    over: Option<&str>,
) -> Result<String, OpsError> {
    if data_class == "live_write" && choice == "act_without_asking" {
        return Err(OpsError::Refused("agents.rule_invalid"));
    }
    let base = required(baseline, data_class)?;
    let effective = over.map_or(base, |o| stricter(base, o));
    if looseness(choice) > looseness(effective) {
        return Err(OpsError::Refused("agents.baseline_loosen_refused"));
    }
    Ok(effective.to_owned())
}

/// A stored rule (`RuleView`).
#[derive(Debug, Clone)]
pub struct Rule {
    pub id: String,
    pub name: String,
    pub measure: String,
    pub threshold: String,
    pub window_minutes: i32,
    pub agent_id: Option<String>,
    pub created_by: String,
    pub created_at: i64,
}

impl Rule {
    fn json(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("name", Json::str(self.name.clone())),
            ("measure", Json::str(self.measure.clone())),
            ("threshold", Json::str(self.threshold.clone())),
            ("windowMinutes", Json::int(i64::from(self.window_minutes))),
            (
                "agentId",
                self.agent_id.clone().map_or(Json::Null, Json::String),
            ),
            ("createdBy", Json::str(self.created_by.clone())),
            ("createdAt", iso(self.created_at)),
        ])
    }
}

fn rule_columns() -> String {
    format!(
        "id::text, name, measure, threshold::text, window_minutes, agent_id, created_by, {}",
        ms("created_at")
    )
}

fn rule_of(r: &postgres::Row) -> Result<Rule, StoreError> {
    let threshold: String = r.try_get(3)?;
    Ok(Rule {
        id: r.try_get(0)?,
        name: r.try_get(1)?,
        measure: r.try_get(2)?,
        threshold: trim_decimal(&threshold),
        window_minutes: r.try_get(4)?,
        agent_id: r.try_get(5)?,
        created_by: r.try_get(6)?,
        created_at: r.try_get(7)?,
    })
}

/// The stored rules, oldest first.
pub fn read_rules(p: &Pool) -> Result<Vec<Rule>, StoreError> {
    db::with_client(p, |c| {
        c.query(
            &format!(
                "SELECT {} FROM agents.agent_alert_rules ORDER BY created_at, id",
                rule_columns()
            ),
            &[],
        )?
        .iter()
        .map(rule_of)
        .collect()
    })
}

fn read_alerts(p: &Pool) -> Result<Vec<Json>, StoreError> {
    db::with_client(p, |c| {
        let rows = c.query(
            &format!(
                "SELECT a.id::text, a.rule_id::text, r.name, r.measure, {}, {}, a.action_rows,
                        a.value::text, a.threshold::text, a.delivery, {}, {}
                   FROM agents.agent_alerts a JOIN agents.agent_alert_rules r ON r.id = a.rule_id
                  ORDER BY a.created_at DESC, a.id
                  LIMIT $1::bigint",
                ms("a.window_start"),
                ms("a.window_end"),
                ms("a.handed_off_at"),
                ms("a.created_at")
            ),
            &[&ALERTS_LISTED],
        )?;
        let mut out = Vec::new();
        for r in &rows {
            let (value, threshold): (String, String) = (r.try_get(7)?, r.try_get(8)?);
            out.push(Json::obj([
                ("id", Json::str(r.try_get::<_, String>(0)?)),
                ("ruleId", Json::str(r.try_get::<_, String>(1)?)),
                ("ruleName", Json::str(r.try_get::<_, String>(2)?)),
                ("measure", Json::str(r.try_get::<_, String>(3)?)),
                ("windowStart", iso(r.try_get(4)?)),
                ("windowEnd", iso(r.try_get(5)?)),
                ("actionRows", Json::int(i64::from(r.try_get::<_, i32>(6)?))),
                ("value", Json::str(trim_decimal(&value))),
                ("threshold", Json::str(trim_decimal(&threshold))),
                ("delivery", Json::str(r.try_get::<_, String>(9)?)),
                (
                    "handedOffAt",
                    r.try_get::<_, Option<i64>>(10)?.map_or(Json::Null, iso),
                ),
                ("createdAt", iso(r.try_get(11)?)),
            ]));
        }
        Ok(out)
    })
}

/// `evaluateWindow`: one rule over the window `offset` windows back (0 is the one now open). The measure and the
/// comparison are Postgres numeric; a breach writes its alert in the same statement, once per rule and window.
fn evaluate_window(p: &Pool, rule: &Rule, offset: i32) -> Result<Json, StoreError> {
    db::with_client(p, |c| {
        let r = c.query_one(
            &format!(
                "WITH bounds AS (
                   SELECT to_timestamp((floor(extract(epoch FROM now()) / ($1::int * 60)) - $2::int)
                                       * ($1::int * 60)) AS window_start
                 ), span AS (
                   SELECT window_start, window_start + make_interval(mins => $1::int) AS window_end FROM bounds
                 ), stats AS (
                   SELECT s.window_start, s.window_end, count(a.id)::int AS action_rows,
                          count(a.id) FILTER (WHERE a.status = 'refused') AS refused,
                          count(a.id) FILTER (WHERE a.status = 'failed') AS failed,
                          coalesce(sum(a.cost), 0) AS cost
                     FROM span s
                     LEFT JOIN agents.agent_actions a
                       ON a.occurred_at >= s.window_start AND a.occurred_at < s.window_end
                      AND ($3::text IS NULL OR a.agent_id = $3::text)
                    GROUP BY s.window_start, s.window_end
                 ), measured AS (
                   SELECT window_start, window_end, action_rows,
                          CASE WHEN action_rows = 0 THEN NULL
                               WHEN $4::text = 'refusal_rate' THEN round(refused * 100.0 / action_rows, 4)
                               WHEN $4::text = 'failure_rate' THEN round(failed * 100.0 / action_rows, 4)
                               ELSE cost END AS value
                     FROM stats
                 ), fired AS (
                   INSERT INTO agents.agent_alerts (rule_id, window_start, window_end, action_rows, value, threshold)
                   SELECT $5::text::uuid, window_start, window_end, action_rows, value, $6::text::numeric
                     FROM measured WHERE value IS NOT NULL AND value > $6::text::numeric
                   ON CONFLICT (rule_id, window_start) DO NOTHING
                   RETURNING id
                 )
                 SELECT {}, {}, action_rows, value::text,
                        coalesce(value > $6::text::numeric, false),
                        EXISTS (SELECT 1 FROM fired)
                   FROM measured",
                ms("window_start"),
                ms("window_end")
            ),
            &[
                &rule.window_minutes,
                &offset,
                &rule.agent_id,
                &rule.measure,
                &rule.id,
                &rule.threshold,
            ],
        )?;
        let value: Option<String> = r.try_get(3)?;
        Ok(Json::obj([
            ("ruleId", Json::str(rule.id.clone())),
            ("windowStart", iso(r.try_get(0)?)),
            ("windowEnd", iso(r.try_get(1)?)),
            ("actionRows", Json::int(i64::from(r.try_get::<_, i32>(2)?))),
            (
                "value",
                value.map_or(Json::Null, |v| Json::str(trim_decimal(&v))),
            ),
            ("breached", Json::Bool(r.try_get(4)?)),
            ("alertWritten", Json::Bool(r.try_get(5)?)),
        ]))
    })
}

/// `evaluateAlertRules`: every rule over its current and previous window. The timer and "Evaluate now" both run it.
pub fn evaluate_alert_rules(p: &Pool) -> Result<Vec<Json>, StoreError> {
    let mut out = Vec::new();
    for rule in read_rules(p)? {
        out.push(evaluate_window(p, &rule, 0)?);
        out.push(evaluate_window(p, &rule, 1)?);
    }
    Ok(out)
}

/// `readNotifications`: the one settings row, or on when no one has set it.
pub fn read_notifications(p: &Pool) -> Result<Json, StoreError> {
    db::with_client(p, |c| {
        let rows = c.query(
            &format!(
                "SELECT notifications, set_by, {} FROM agents.agent_alert_settings WHERE id",
                ms("set_at")
            ),
            &[],
        )?;
        Ok(match rows.first() {
            Some(r) => Json::obj([
                ("state", Json::str(r.try_get::<_, String>(0)?)),
                ("setBy", Json::str(r.try_get::<_, String>(1)?)),
                ("setAt", iso(r.try_get(2)?)),
            ]),
            None => Json::obj([
                ("state", Json::str("on")),
                ("setBy", Json::Null),
                ("setAt", Json::Null),
            ]),
        })
    })
}

fn notifications_down(p: &Pool) -> Result<bool, StoreError> {
    Ok(matches!(read_notifications(p)?.get("state"), Some(Json::String(s)) if s == "down"))
}

fn set_notifications(p: &Pool, state: &str, set_by: &str) -> Result<(), StoreError> {
    db::with_client(p, |c| {
        c.execute(
            "INSERT INTO agents.agent_alert_settings (id, notifications, set_by) VALUES (true, $1::text, $2::text)
             ON CONFLICT (id) DO UPDATE
               SET notifications = EXCLUDED.notifications,
                   set_by = CASE WHEN agent_alert_settings.notifications = EXCLUDED.notifications THEN agent_alert_settings.set_by ELSE EXCLUDED.set_by END,
                   set_at = CASE WHEN agent_alert_settings.notifications = EXCLUDED.notifications THEN agent_alert_settings.set_at ELSE now() END",
            &[&state, &set_by],
        )?;
        Ok(())
    })
}

/// `publishPendingAgentAlerts`: every pending alert handed to notifications once, on its business key, while they are
/// on. Marked handed off only after the bus took it; one the bus refused stays pending. Returns how many were handed.
pub fn publish_pending_agent_alerts(
    p: &Pool,
    m: &Metering,
    now: Instant,
) -> Result<i64, StoreError> {
    if notifications_down(p)? {
        return Ok(0);
    }
    let rows = db::with_client(p, |c| {
        Ok(c.query(
            &format!(
                "SELECT a.id::text, a.rule_id::text, r.created_by, r.name, r.measure, a.value::text, a.threshold::text,
                        {}, {}
                   FROM agents.agent_alerts a JOIN agents.agent_alert_rules r ON r.id = a.rule_id
                  WHERE a.delivery = 'pending'
                  ORDER BY a.created_at
                  LIMIT 100",
                ms("a.window_start"),
                ms("a.window_end")
            ),
            &[],
        )?)
    })?;
    let mut handed = 0;
    for r in &rows {
        let id: String = r.try_get(0)?;
        let rule_id: String = r.try_get(1)?;
        let start = Instant(r.try_get(7)?).iso();
        let key = format!("agents.alert:{rule_id}:{start}");
        let (value, threshold): (String, String) = (r.try_get(5)?, r.try_get(6)?);
        let payload = Json::obj([
            ("alertKey", Json::str(key.clone())),
            ("alertId", Json::str(id.clone())),
            ("userId", Json::str(r.try_get::<_, String>(2)?)),
            ("ruleName", Json::str(r.try_get::<_, String>(3)?)),
            ("measure", Json::str(r.try_get::<_, String>(4)?)),
            ("value", Json::str(trim_decimal(&value))),
            ("threshold", Json::str(trim_decimal(&threshold))),
            ("windowStart", Json::str(start)),
            ("windowEnd", iso(r.try_get(8)?)),
        ]);
        let sent = envelope(m, AGENT_ALERT_FIRED, &key, payload, now)
            .and_then(|env| m.bus.publish(AGENT_ALERT_FIRED, &key, &env));
        if sent.is_err() {
            continue;
        }
        db::with_client(p, |c| {
            c.execute(
                "UPDATE agents.agent_alerts SET delivery = 'handed_off', handed_off_at = now()
                  WHERE id = $1::text::uuid AND delivery = 'pending'",
                &[&id],
            )?;
            Ok(())
        })?;
        handed += 1;
    }
    Ok(handed)
}

/// One override (`PolicyOverrideView`).
struct Override {
    data_class: String,
    choice: String,
    set_by: String,
    set_at: i64,
}

fn overrides(p: &Pool) -> Result<Vec<Override>, StoreError> {
    db::with_client(p, |c| {
        c.query(
            &format!(
                "SELECT data_class, choice, set_by, {} FROM agents.agent_policy_overrides ORDER BY data_class",
                ms("set_at")
            ),
            &[],
        )?
        .iter()
        .map(|r| {
            Ok(Override {
                data_class: r.try_get(0)?,
                choice: r.try_get(1)?,
                set_by: r.try_get(2)?,
                set_at: r.try_get(3)?,
            })
        })
        .collect()
    })
}

/// `PolicyOverrideStore.forClass`.
pub fn override_for(p: &Pool, data_class: &str) -> Result<Option<String>, StoreError> {
    db::with_client(p, |c| {
        Ok(c.query(
            "SELECT choice FROM agents.agent_policy_overrides WHERE data_class = $1::text",
            &[&data_class],
        )?
        .first()
        .map(|r| r.try_get(0))
        .transpose()?)
    })
}

fn set_override(p: &Pool, data_class: &str, choice: &str, set_by: &str) -> Result<(), StoreError> {
    db::with_client(p, |c| {
        c.execute(
            "INSERT INTO agents.agent_policy_overrides (data_class, choice, set_by)
             VALUES ($1::text, $2::text, $3::text)
             ON CONFLICT (data_class) DO UPDATE
               SET choice = EXCLUDED.choice,
                   set_by = CASE WHEN agent_policy_overrides.choice = EXCLUDED.choice THEN agent_policy_overrides.set_by ELSE EXCLUDED.set_by END,
                   set_at = CASE WHEN agent_policy_overrides.choice = EXCLUDED.choice THEN agent_policy_overrides.set_at ELSE now() END",
            &[&data_class, &choice, &set_by],
        )?;
        Ok(())
    })
}

/// `readPolicy`: per class, the baseline, the override and the stricter of the two.
fn read_policy(p: &Pool, baseline: &PolicyBaseline) -> Result<Json, StoreError> {
    let list = overrides(p)?;
    let classes = DATA_CLASSES
        .iter()
        .map(|dc| {
            let base = baseline.of(dc);
            let o = list.iter().find(|o| o.data_class == *dc);
            let opt = |v: Option<&String>| v.map_or(Json::Null, |s| Json::str(s.clone()));
            let effective = match (base, o) {
                (Some(b), Some(o)) => Json::str(stricter(b, &o.choice)),
                (b, _) => b.map_or(Json::Null, Json::str),
            };
            Json::obj([
                ("dataClass", Json::str(*dc)),
                ("baseline", base.map_or(Json::Null, Json::str)),
                ("override", opt(o.map(|o| &o.choice))),
                ("overrideSetBy", opt(o.map(|o| &o.set_by))),
                ("overrideSetAt", o.map_or(Json::Null, |o| iso(o.set_at))),
                ("effective", effective),
            ])
        })
        .collect();
    Ok(Json::obj([("classes", Json::Array(classes))]))
}

/// The handler's hand-off after an evaluation or notifications back on: a bus fault leaves the alerts pending for the
/// timer's next sweep and never fails the operator's call.
fn hand_off(p: &Pool, m: &Metering, now: Instant) {
    let _ = publish_pending_agent_alerts(p, m, now);
}

/// Answers one `opsAlerts.*` call.
pub fn handle(
    call: &str,
    ctx: &Ctx<'_>,
    store: &Store,
    m: &Metering,
    ops: &Ops,
) -> Result<Json, OpsError> {
    let input = |k: &str| ctx.input.get(k).as_str();
    match call {
        "desk" => {
            let p = pool(store)?;
            Ok(Json::obj([
                ("notifications", read_notifications(p)?),
                (
                    "rules",
                    Json::Array(read_rules(p)?.iter().map(Rule::json).collect()),
                ),
                ("alerts", Json::Array(read_alerts(p)?)),
                ("alertsListed", Json::int(ALERTS_LISTED)),
            ]))
        }
        "createRule" => {
            let measure = input("measure").unwrap_or("");
            let threshold = parse_threshold(measure, input("threshold"))?;
            let p = pool(store)?;
            #[allow(
                clippy::cast_possible_truncation,
                reason = "the schema bounds it to 1..1440"
            )]
            let window = ctx.input.get("windowMinutes").as_number().unwrap_or(0.0) as i32;
            let (name, agent_id) = (input("name").unwrap_or(""), input("agentId"));
            let operator_id = operator(ctx);
            let rows = db::with_client(p, |c| {
                Ok(c.query(
                    &format!(
                        "INSERT INTO agents.agent_alert_rules (name, measure, threshold, window_minutes, agent_id, created_by)
                         VALUES ($1::text, $2::text, $3::text::numeric, $4::int, $5::text, $6::text)
                         ON CONFLICT (name) DO NOTHING
                         RETURNING {}",
                        rule_columns()
                    ),
                    &[&name, &measure, &threshold, &window, &agent_id, &operator_id],
                )?)
            })?;
            let Some(row) = rows.first() else {
                return Err(OpsError::Refused("agents.alert_rule_name_taken"));
            };
            Ok(rule_of(row)?.json())
        }
        "evaluate" => {
            let p = pool(store)?;
            let windows = evaluate_alert_rules(p)?;
            hand_off(p, m, ctx.now);
            Ok(Json::obj([("windows", Json::Array(windows))]))
        }
        "setNotifications" => {
            let p = pool(store)?;
            let state = input("state").unwrap_or("");
            set_notifications(p, state, operator(ctx))?;
            if state == "on" {
                hand_off(p, m, ctx.now);
            }
            Ok(read_notifications(p)?)
        }
        "policy" => Ok(read_policy(pool(store)?, &ops.baseline)?),
        "setOverride" => {
            let p = pool(store)?;
            let (data_class, choice) = (
                input("dataClass").unwrap_or(""),
                input("choice").unwrap_or(""),
            );
            let base = required(&ops.baseline, data_class)?;
            if looseness(choice) > looseness(base) {
                return Err(OpsError::Refused("agents.baseline_loosen_refused"));
            }
            set_override(p, data_class, choice, operator(ctx))?;
            Ok(read_policy(p, &ops.baseline)?)
        }
        "checkRule" => {
            let p = pool(store)?;
            let (data_class, choice) = (
                input("dataClass").unwrap_or(""),
                input("choice").unwrap_or(""),
            );
            let over = override_for(p, data_class)?;
            let effective = check_choice(data_class, choice, &ops.baseline, over.as_deref())?;
            Ok(Json::obj([
                ("verdict", Json::str("allowed")),
                ("effective", Json::str(effective)),
            ]))
        }
        other => Err(OpsError::Store(StoreError::new(
            format!("svc-agents in Rust: opsAlerts.{other} is not an opsAlerts call"),
            None,
        ))),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    fn refusal<T: std::fmt::Debug>(r: Result<T, OpsError>) -> &'static str {
        match r {
            Err(OpsError::Refused(code)) => code,
            other => panic!("not a refusal: {other:?}"),
        }
    }

    fn baseline() -> PolicyBaseline {
        PolicyBaseline(vec![
            ("own_data", "act_on_request"),
            ("market_data", "act_on_request"),
            ("draft_write", "ask_before"),
            ("live_write", "act_on_request"),
        ])
    }

    /// alerts.db.test.ts: "a blank threshold is refused by name; 0 is a value; a rate stays within 0 to 100".
    #[test]
    fn a_blank_threshold_is_refused_by_name_zero_is_a_value_and_a_rate_stays_within_0_to_100() {
        assert_eq!(
            refusal(parse_threshold("refusal_rate", None)),
            "agents.alert_threshold_required"
        );
        assert_eq!(
            refusal(parse_threshold("refusal_rate", Some("  "))),
            "agents.alert_threshold_required"
        );
        assert_eq!(parse_threshold("refusal_rate", Some("0")).unwrap(), "0");
        assert_eq!(parse_threshold("refusal_rate", Some("100")).unwrap(), "100");
        assert_eq!(
            parse_threshold("refusal_rate", Some("100.00")).unwrap(),
            "100.00"
        );
        assert_eq!(
            refusal(parse_threshold("refusal_rate", Some("100.01"))),
            "agents.alert_threshold_invalid"
        );
        assert_eq!(
            refusal(parse_threshold("refusal_rate", Some("101"))),
            "agents.alert_threshold_invalid"
        );
        assert_eq!(
            refusal(parse_threshold("refusal_rate", Some("00000101"))),
            "agents.alert_threshold_invalid"
        );
        assert_eq!(
            refusal(parse_threshold("failure_rate", Some("-1"))),
            "agents.alert_threshold_invalid"
        );
        assert_eq!(
            refusal(parse_threshold("cost", Some("1e3"))),
            "agents.alert_threshold_invalid"
        );
        assert_eq!(parse_threshold("cost", Some("250.5")).unwrap(), "250.5");
        assert_eq!(trim_decimal("0.000000000000000000"), "0");
        assert_eq!(trim_decimal("12.500000000000000000"), "12.5");
        assert_eq!(trim_decimal("40"), "40");
    }

    /// alerts.db.test.ts: "a rule looser than the baseline, or than an override that narrows it, is refused; the
    /// built-in law comes first".
    #[test]
    fn a_rule_looser_than_the_baseline_or_its_narrowing_override_is_refused_and_the_law_comes_first()
     {
        let b = baseline();
        assert_eq!(
            check_choice("own_data", "act_on_request", &b, None).unwrap(),
            "act_on_request"
        );
        assert_eq!(
            refusal(check_choice("own_data", "act_without_asking", &b, None)),
            "agents.baseline_loosen_refused"
        );
        assert_eq!(
            refusal(check_choice(
                "own_data",
                "act_on_request",
                &b,
                Some("ask_before")
            )),
            "agents.baseline_loosen_refused"
        );
        assert_eq!(
            refusal(check_choice(
                "draft_write",
                "act_on_request",
                &b,
                Some("act_without_asking")
            )),
            "agents.baseline_loosen_refused"
        );
        assert_eq!(
            refusal(check_choice("live_write", "act_without_asking", &b, None)),
            "agents.rule_invalid"
        );
        assert_eq!(
            refusal(check_choice(
                "own_data",
                "hand_off",
                &PolicyBaseline::default(),
                None
            )),
            "agents.baseline_value_unset"
        );
    }
}
