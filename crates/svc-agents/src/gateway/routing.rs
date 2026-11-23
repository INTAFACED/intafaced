//! Per-task model routing (`services/svc-agents/src/gateway/routing.ts`): which provider and model alias serve each task,
//! its output ceiling and the rate it is billed at. The table is data: parsed once from `AGENTS_ROUTING_TABLE` (or the
//! default table with every rate blank), with the founders' confirmed changes laid over it (`changes`).
//!
//! Rates are `Amount`s (18 places), never a float. A model is an alias the provider resolves; no vendor is named here.

use service_kit::json::{self, Json};
use service_kit::money::{Amount, parse_amount};

use crate::errors::AgentError;

/// What a route needs its provider to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Capability {
    Complete,
    Stream,
    Embed,
}

impl Capability {
    pub fn name(self) -> &'static str {
        match self {
            Capability::Complete => "complete",
            Capability::Stream => "stream",
            Capability::Embed => "embed",
        }
    }

    fn parse(s: &str) -> Option<Capability> {
        match s {
            "complete" => Some(Capability::Complete),
            "stream" => Some(Capability::Stream),
            "embed" => Some(Capability::Embed),
            _ => None,
        }
    }
}

/// A route's rate per million tokens, in the fee asset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Price {
    pub input_per_million: Amount,
    pub output_per_million: Amount,
}

/// One task's route (`RouteDef`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    pub task: String,
    pub provider_id: String,
    pub model: String,
    pub max_output_tokens: i64,
    /// `None`: no rate is published, and the route refuses its metered runs (`agents.price_unset`).
    pub price: Option<Price>,
    pub capability: Capability,
}

/// The routing table.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RoutingTable {
    pub routes: Vec<Route>,
    /// The task served when a requested task has no route; opted into, never assumed.
    pub fallback_task: Option<String>,
}

/// Which engine a route runs on: decided by the adapter registered for it, never by a name or a flag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    Sandbox,
    Live,
    Unknown,
}

impl Engine {
    pub fn name(self) -> &'static str {
        match self {
            Engine::Sandbox => "sandbox",
            Engine::Live => "live",
            Engine::Unknown => "unknown",
        }
    }
}

const PRICE_PLACES: &str = "a price is an unsigned decimal string with at most 18 decimal places";

/// zod's `.min(min).max(max)` on a string: it measures UTF-16 code units, and code points where the units alone would
/// refuse (`min_length` inside `[min, 2 * min)`, `max_length` past `max`), as the kit's zod engine does.
fn zod_length_ok(s: &str, min: usize, max: usize) -> bool {
    let (units, points) = (s.encode_utf16().count(), s.chars().count());
    let for_min = if units >= min && units < min * 2 {
        points
    } else {
        units
    };
    let for_max = if units > max { points } else { units };
    for_min >= min && for_max <= max
}

fn string_field(o: &Json, key: &str, at: &str, min: usize, max: usize) -> Result<String, String> {
    match o.get(key) {
        Some(Json::String(s)) if zod_length_ok(s, min, max) => Ok(s.clone()),
        Some(Json::String(_)) => Err(format!("{at}.{key}: a string of {min} to {max} characters")),
        _ => Err(format!("{at}.{key}: expected string")),
    }
}

/// `^\d+(\.\d{1,18})?$`, then `parseAmount`.
fn price_string(o: &Json, key: &str, at: &str) -> Result<Amount, String> {
    let Some(Json::String(s)) = o.get(key) else {
        return Err(format!("{at}.{key}: expected string"));
    };
    let (whole, frac) = s
        .split_once('.')
        .map_or((s.as_str(), None), |(w, f)| (w, Some(f)));
    let digits = |t: &str| !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit());
    if !digits(whole) || frac.is_some_and(|f| !digits(f) || f.len() > 18) {
        return Err(format!("{at}.{key}: {PRICE_PLACES}"));
    }
    parse_amount(s).map_err(|e| format!("{at}.{key}: {e}"))
}

fn route_of(r: &Json, at: &str) -> Result<Route, String> {
    if !matches!(r, Json::Object(_)) {
        return Err(format!("{at}: expected object"));
    }
    let task = string_field(r, "task", at, 1, 120)?;
    let provider_id = string_field(r, "providerId", at, 1, 64)?;
    let model = string_field(r, "model", at, 1, 200)?;
    let max_output_tokens = match r.get("maxOutputTokens") {
        Some(Json::Number(n)) if n.fract() == 0.0 && (1.0..=1_000_000.0).contains(n) => {
            #[expect(
                clippy::cast_possible_truncation,
                reason = "a whole number between 1 and 1,000,000"
            )]
            let n = *n as i64;
            n
        }
        Some(Json::Number(_)) => {
            return Err(format!(
                "{at}.maxOutputTokens: an integer from 1 to 1000000"
            ));
        }
        _ => return Err(format!("{at}.maxOutputTokens: expected number")),
    };
    let price = match r.get("price") {
        Some(p @ Json::Object(_)) => {
            let at = format!("{at}.price");
            Price {
                input_per_million: price_string(p, "inputPerMillion", &at)?,
                output_per_million: price_string(p, "outputPerMillion", &at)?,
            }
        }
        _ => return Err(format!("{at}.price: expected object")),
    };
    let capability = match r.get("capability") {
        None => Capability::Complete,
        Some(Json::String(s)) => Capability::parse(s).ok_or_else(|| {
            format!("{at}.capability: expected one of \"complete\"|\"stream\"|\"embed\"")
        })?,
        Some(_) => {
            return Err(format!(
                "{at}.capability: expected one of \"complete\"|\"stream\"|\"embed\""
            ));
        }
    };
    Ok(Route {
        task,
        provider_id,
        model,
        max_output_tokens,
        price: Some(price),
        capability,
    })
}

/// `parseRoutingTable(JSON.parse(text))`: the configured table, or why it is refused (the boot stops on it).
pub fn parse_routing_table(text: &str) -> Result<RoutingTable, String> {
    let doc = json::parse(text).map_err(|e| format!("AGENTS_ROUTING_TABLE: {}", e.message))?;
    parse_routing_json(&doc).map_err(|e| format!("AGENTS_ROUTING_TABLE: {e}"))
}

/// `parseRoutingTable(input)` on a parsed value.
pub fn parse_routing_json(doc: &Json) -> Result<RoutingTable, String> {
    if !matches!(doc, Json::Object(_)) {
        return Err("expected object".to_owned());
    }
    let Some(Json::Array(rows)) = doc.get("routes") else {
        return Err("routes: expected array".to_owned());
    };
    if rows.is_empty() {
        return Err("routes: at least one route".to_owned());
    }
    let fallback_task = match doc.get("fallbackTask") {
        None => None,
        Some(Json::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(Json::String(_)) => return Err("fallbackTask: at least one character".to_owned()),
        Some(_) => return Err("fallbackTask: expected string".to_owned()),
    };
    let routes = rows
        .iter()
        .enumerate()
        .map(|(i, r)| route_of(r, &format!("routes.{i}")))
        .collect::<Result<Vec<_>, _>>()?;
    let mut seen: Vec<&str> = Vec::new();
    for r in &routes {
        if seen.contains(&r.task.as_str()) {
            return Err(format!(
                "Duplicate route for task \"{}\" — a task must resolve to exactly one model",
                r.task
            ));
        }
        seen.push(&r.task);
    }
    if let Some(f) = &fallback_task
        && !seen.contains(&f.as_str())
    {
        return Err(format!("fallbackTask \"{f}\" has no route of its own"));
    }
    Ok(RoutingTable {
        routes,
        fallback_task,
    })
}

/// `DEFAULT_ROUTING_TABLE`: the tasks the fleet names, their ceilings, and placeholder rates for tests.
pub fn default_table() -> RoutingTable {
    // (task, model, ceiling, input rate, output rate, capability)
    const ROWS: [(&str, &str, i64, &str, &str, Capability); 9] = [
        (
            "navigator.plan",
            "reasoning-lg",
            4096,
            "3",
            "15",
            Capability::Complete,
        ),
        (
            "navigator.tool_select",
            "reasoning-md",
            1024,
            "1",
            "5",
            Capability::Complete,
        ),
        (
            "support.reply",
            "reasoning-md",
            2048,
            "1",
            "5",
            Capability::Complete,
        ),
        (
            "own.run",
            "reasoning-md",
            2048,
            "1",
            "5",
            Capability::Complete,
        ),
        (
            "support.classify",
            "fast-sm",
            256,
            "0.25",
            "1.25",
            Capability::Complete,
        ),
        (
            "scanner.rank",
            "reasoning-md",
            2048,
            "1",
            "5",
            Capability::Complete,
        ),
        (
            "merchant.watch",
            "fast-sm",
            1024,
            "0.25",
            "1.25",
            Capability::Complete,
        ),
        (
            "copy_intel.stats",
            "reasoning-md",
            2048,
            "1",
            "5",
            Capability::Complete,
        ),
        ("index.embed", "embed-sm", 1, "0.1", "0", Capability::Embed),
    ];
    let rate = |s: &str| parse_amount(s).unwrap_or_default();
    RoutingTable {
        routes: ROWS
            .iter()
            .map(|(task, model, ceiling, i, o, capability)| Route {
                task: (*task).to_owned(),
                provider_id: "primary".to_owned(),
                model: (*model).to_owned(),
                max_output_tokens: *ceiling,
                price: Some(Price {
                    input_per_million: rate(i),
                    output_per_million: rate(o),
                }),
                capability: *capability,
            })
            .collect(),
        fallback_task: None,
    }
}

/// `unpricedTable`: the same routes with every rate blank. A deployment that published no table prices nothing.
pub fn unpriced(table: &RoutingTable) -> RoutingTable {
    RoutingTable {
        routes: table
            .routes
            .iter()
            .map(|r| Route {
                price: None,
                ..r.clone()
            })
            .collect(),
        fallback_task: table.fallback_task.clone(),
    }
}

/// `resolveRoute`: the task's own route, else the fallback's, else `agents.route_not_found`.
pub fn resolve_route<'a>(table: &'a RoutingTable, task: &str) -> Result<&'a Route, AgentError> {
    if let Some(r) = table.routes.iter().find(|r| r.task == task) {
        return Ok(r);
    }
    if let Some(f) = &table.fallback_task
        && let Some(r) = table.routes.iter().find(|r| &r.task == f)
    {
        return Ok(r);
    }
    Err(AgentError::declared(
        "agents.route_not_found",
        "agents.error.route_not_found",
        format!("No route configured for task \"{task}\""),
    ))
}

/// `routeIsMetered`: billed unless metering is known to be off, the rate is blank, or both rates are zero.
pub fn route_is_metered(metering_enabled: Option<bool>, price: Option<&Price>) -> bool {
    metering_enabled != Some(false)
        && price.is_some_and(|p| {
            !(p.input_per_million == Amount::ZERO && p.output_per_million == Amount::ZERO)
        })
}

/// `engineForTasks`: one engine for an agent when every allowed task resolves to the same one, else unknown; metered
/// when metering is not known to be off and a task would be billed or has no route.
pub fn engine_for_tasks(
    tasks: &[String],
    resolve: impl Fn(&str) -> Option<(Engine, bool)>,
    metering_enabled: Option<bool>,
) -> (Engine, bool) {
    if tasks.is_empty() {
        return (Engine::Unknown, metering_enabled != Some(false));
    }
    let mut engines: Vec<Engine> = Vec::new();
    let (mut billed, mut unresolved) = (false, false);
    for task in tasks {
        let engine = match resolve(task) {
            None => {
                unresolved = true;
                Engine::Unknown
            }
            Some((engine, b)) => {
                billed |= b;
                engine
            }
        };
        if !engines.contains(&engine) {
            engines.push(engine);
        }
    }
    let engine = match engines.as_slice() {
        [one] => *one,
        _ => Engine::Unknown,
    };
    (
        engine,
        metering_enabled != Some(false) && (billed || unresolved),
    )
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    const ONE: Amount = Amount::whole(1);

    #[test]
    fn a_table_is_parsed_with_its_rates_as_amounts_and_complete_by_default() {
        let t = parse_routing_table(
            r#"{"routes":[{"task":"a","providerId":"p","model":"m","maxOutputTokens":10,"price":{"inputPerMillion":"0.25","outputPerMillion":"1"},"extra":1}]}"#,
        )
        .unwrap();
        let r = t.routes.first().unwrap();
        assert_eq!(r.capability, Capability::Complete);
        assert_eq!(
            r.price,
            Some(Price {
                input_per_million: ONE / 4,
                output_per_million: ONE
            })
        );
    }

    #[test]
    fn a_table_that_is_not_one_is_refused() {
        let bad = [
            r#"{"routes":[]}"#,
            r#"{"routes":[{"task":"","providerId":"p","model":"m","maxOutputTokens":1,"price":{"inputPerMillion":"1","outputPerMillion":"1"}}]}"#,
            r#"{"routes":[{"task":"a","providerId":"p","model":"m","maxOutputTokens":1.5,"price":{"inputPerMillion":"1","outputPerMillion":"1"}}]}"#,
            r#"{"routes":[{"task":"a","providerId":"p","model":"m","maxOutputTokens":1,"price":{"inputPerMillion":"-1","outputPerMillion":"1"}}]}"#,
            r#"{"routes":[{"task":"a","providerId":"p","model":"m","maxOutputTokens":1,"price":{"inputPerMillion":"1.","outputPerMillion":"1"}}]}"#,
            r#"{"routes":[{"task":"a","providerId":"p","model":"m","maxOutputTokens":1,"price":{"inputPerMillion":"1","outputPerMillion":"1"},"capability":"chat"}]}"#,
            r#"{"routes":[{"task":"a","providerId":"p","model":"m","maxOutputTokens":1,"price":{"inputPerMillion":"1","outputPerMillion":"1"}},{"task":"a","providerId":"p","model":"m","maxOutputTokens":1,"price":{"inputPerMillion":"1","outputPerMillion":"1"}}]}"#,
            r#"{"routes":[{"task":"a","providerId":"p","model":"m","maxOutputTokens":1,"price":{"inputPerMillion":"1","outputPerMillion":"1"}}],"fallbackTask":"b"}"#,
            "not json",
        ];
        for text in bad {
            assert!(parse_routing_table(text).is_err(), "{text}");
        }
    }

    #[test]
    fn a_task_resolves_to_its_route_then_the_fallback_then_refuses() {
        let mut t = default_table();
        assert_eq!(resolve_route(&t, "own.run").unwrap().model, "reasoning-md");
        let e = resolve_route(&t, "nope").unwrap_err();
        assert_eq!(e.code, "agents.route_not_found");
        t.fallback_task = Some("support.reply".to_owned());
        assert_eq!(resolve_route(&t, "nope").unwrap().task, "support.reply");
    }

    #[test]
    fn metered_follows_the_switch_and_the_rate_never_the_engine() {
        let p = Price {
            input_per_million: ONE,
            output_per_million: Amount::ZERO,
        };
        let zero = Price {
            input_per_million: Amount::ZERO,
            output_per_million: Amount::ZERO,
        };
        assert!(route_is_metered(None, Some(&p)));
        assert!(route_is_metered(Some(true), Some(&p)));
        assert!(!route_is_metered(Some(false), Some(&p)));
        assert!(!route_is_metered(None, None));
        assert!(!route_is_metered(None, Some(&zero)));
    }

    #[test]
    fn one_engine_for_an_agent_only_when_every_task_agrees() {
        let tasks = vec!["a".to_owned(), "b".to_owned()];
        let same = |_: &str| Some((Engine::Sandbox, false));
        assert_eq!(
            engine_for_tasks(&tasks, same, None),
            (Engine::Sandbox, false)
        );
        let mixed = |t: &str| {
            Some((
                if t == "a" {
                    Engine::Live
                } else {
                    Engine::Sandbox
                },
                true,
            ))
        };
        assert_eq!(
            engine_for_tasks(&tasks, mixed, None),
            (Engine::Unknown, true)
        );
        let missing = |t: &str| (t == "a").then_some((Engine::Live, false));
        assert_eq!(
            engine_for_tasks(&tasks, missing, None),
            (Engine::Unknown, true)
        );
        assert_eq!(
            engine_for_tasks(&[], same, Some(false)),
            (Engine::Unknown, false)
        );
        assert_eq!(engine_for_tasks(&[], same, None), (Engine::Unknown, true));
    }

    #[test]
    fn the_unpriced_default_keeps_tasks_and_ceilings_and_blanks_every_rate() {
        let t = unpriced(&default_table());
        assert_eq!(t.routes.len(), 9);
        assert!(t.routes.iter().all(|r| r.price.is_none()));
        assert_eq!(t.routes.last().unwrap().capability, Capability::Embed);
    }
}
