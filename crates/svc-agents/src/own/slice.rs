//! The own-builder slice's calls, answered as `own/routes.ts` answers them. The door has already checked the caller,
//! the scope, the region, the person checks (`assertPersonSetsLimits`) and the input; each handler runs inside the
//! route's `guard`.

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::trpc::TrpcError;

use super::assistant::{assistant_engine, draft_agent};
use super::catalog::{DraftInput, OWN_TEMPLATES, own_tools};
use super::{Own, OwnError, OwnRefusal, gates, guard, no_mapping, pool_of, store};
use crate::db::Store;
use crate::door::{Ctx, Slice, not_ported};
use crate::gateway::desk::GatewaySlice;
use crate::metering::Metering;
use crate::runtime::Runtime;

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).as_str().unwrap_or("")
}

fn strings<'a>(v: &'a Value, key: &str) -> Vec<&'a str> {
    v.get(key)
        .as_array()
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// A whole number the input check already bounded.
#[allow(
    clippy::cast_possible_truncation,
    reason = "the input check bounds it to a small whole number"
)]
fn whole(v: &Value, key: &str) -> i64 {
    v.get(key).as_number().map_or(0, |n| n as i64)
}

/// What the slice reads besides the call.
pub struct Deps<'a> {
    pub store: &'a Store,
    pub gateway: &'a GatewaySlice,
    pub m: &'a Metering,
    pub rt: &'a Runtime,
    pub own: &'a Own,
}

/// Answers one call of the slice.
pub fn handle(ctx: &Ctx<'_>, d: &Deps<'_>) -> Result<Option<Json>, TrpcError> {
    answer(ctx, d).map(Some).map_err(|e| guard(e, no_mapping))
}

fn answer(ctx: &Ctx<'_>, d: &Deps<'_>) -> Result<Json, OwnError> {
    let input = &ctx.input;
    let user = ctx.principal.map_or("", |p| p.user_id.as_str());
    match ctx.call.path {
        "own.catalogue" => Ok(Json::obj([
            (
                "templates",
                Json::Array(
                    d.own
                        .templates
                        .iter()
                        .map(|id| {
                            let tools = OWN_TEMPLATES
                                .iter()
                                .find(|(t, _)| t == id)
                                .map_or(&[][..], |(_, tools)| tools);
                            Json::obj([
                                ("id", Json::str(*id)),
                                (
                                    "tools",
                                    Json::Array(tools.iter().map(|t| Json::str(*t)).collect()),
                                ),
                            ])
                        })
                        .collect(),
                ),
            ),
            (
                "tools",
                Json::Array(
                    own_tools()
                        .iter()
                        .map(super::catalog::OwnTool::to_json)
                        .collect(),
                ),
            ),
        ])),
        "own.create" => {
            // Only an offered template: one taken off the list is unknown to a create, as it is to the picker.
            let Some(template) = d
                .own
                .templates
                .iter()
                .find(|t| **t == text(input, "template"))
            else {
                return Err(OwnRefusal::new("agents.own.template_unknown").into());
            };
            Ok(
                store::create(pool_of(d.store)?, user, template, text(input, "createKey"))?
                    .to_json(),
            )
        }
        "own.save" => {
            let cap = input.get("perSessionCap").as_str();
            Ok(store::save(
                pool_of(d.store)?,
                user,
                text(input, "id"),
                &DraftInput {
                    name: text(input, "name"),
                    instructions: text(input, "instructions"),
                    tools: strings(input, "tools"),
                    per_session_cap: cap,
                },
            )?
            .to_json())
        }
        "own.get" => Ok(store::get(pool_of(d.store)?, user, text(input, "id"))?.to_json()),
        "own.list" => Ok(Json::Array(
            store::list(pool_of(d.store)?, user, whole(input, "limit"))?
                .iter()
                .map(store::OwnAgent::to_json)
                .collect(),
        )),
        "own.assistant.state" => Ok(Json::obj([(
            "engine",
            assistant_engine(d.own.assistant_model.as_deref()).map_or(Json::Null, Json::str),
        )])),
        "own.assistant.draft" => draft_agent(
            assistant_engine(d.own.assistant_model.as_deref()),
            text(input, "description"),
        ),
        "own.assistant.accept" => Ok(store::create_drafted(
            pool_of(d.store)?,
            user,
            &DraftInput {
                name: text(input, "name"),
                instructions: text(input, "instructions"),
                tools: strings(input, "tools"),
                per_session_cap: None,
            },
            &format!("assistant:{}", text(input, "acceptKey")),
        )?
        .to_json()),
        "own.rules.list" => {
            let pool = pool_of(d.store)?;
            let agent = store::get(pool, user, text(input, "id"))?;
            Ok(Json::Array(
                gates::list_rules(pool, user, &agent.id)?
                    .iter()
                    .map(gates::Rule::to_json)
                    .collect(),
            ))
        }
        "own.rules.save" => {
            let pool = pool_of(d.store)?;
            let agent = store::get(pool, user, text(input, "id"))?;
            let (tool, choice) = (text(input, "tool"), text(input, "choice"));
            gates::check_rule(&d.own.baseline, &agent.tools, tool, choice)?;
            Ok(gates::save_rule(pool, user, &agent.id, tool, choice)?.to_json())
        }
        _ => Err(OwnError::Trpc(not_ported(Slice::OwnBuilder))),
    }
}
