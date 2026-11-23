//! The slice's calls (`ops/card-programme.ts` and `ops/card-programme-ops.ts`), every refusal through the router's
//! guard. The actor of every change is the signed-in operator.

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::trpc::TrpcError;

use super::{Deps, desk, funding, holders};
use crate::door::Ctx;
use crate::errors::{Refusal, to_trpc};

fn text<'v>(v: &'v Value, key: &str) -> &'v str {
    v.get(key).as_str().unwrap_or_default()
}

fn call(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let input = &ctx.input;
    let actor = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    Some(match ctx.call.path {
        "ops.cardProgramme" => {
            funding::assert_span(input.get("from").as_str(), input.get("to").as_str())
                .and_then(|(from, to)| funding::read(d, from, to))
        }
        "ops.cardProgrammeFunding" => funding::view(d),
        "ops.requestCardProgrammeFunding" => funding::request(d, input),
        "ops.cardProgrammeDesk" => desk::desk(d),
        "ops.cardProgrammeCardholders" => crate::spaces::space::with(d.store(), |c| {
            holders::cardholders(c, input.get("query").as_str())
        }),
        "ops.cardProgrammeCardholder" => holders::cardholder(d, text(input, "cardholderId")),
        "ops.cardProgrammeAuthorization" => desk::authorization(d, text(input, "id")),
        "ops.cardProgrammeExport" => desk::export_report(d, actor),
        "ops.cardProgrammeConfigure" => {
            let value = input.get("value").to_json().unwrap_or(Json::Null);
            desk::configure(d, actor, text(input, "key"), &value)
        }
        "ops.cardProgrammeClearThreeDs" => desk::clear_three_ds(d, actor),
        "ops.cardProgrammeRuleCreate" => desk::create_rule(
            d,
            actor,
            text(input, "ruleKey"),
            text(input, "name"),
            &input.get("params").to_json().unwrap_or(Json::Null),
        ),
        "ops.cardProgrammeRulePromote" => desk::promote_rule(d, actor, text(input, "ruleId")),
        "ops.cardProgrammeRuleRollback" => desk::rollback_rule(d, actor, text(input, "ruleKey")),
        "ops.cardProgrammeStaffAssign" => {
            desk::assign_staff(d, actor, text(input, "email"), text(input, "role"))
        }
        "ops.cardProgrammeCardholderCreate" => {
            let owners = input
                .get("beneficialOwners")
                .as_array()
                .unwrap_or_default()
                .iter()
                .map(|o| holders::Owner {
                    name: text(o, "name").to_owned(),
                    email: text(o, "email").to_owned(),
                })
                .collect();
            holders::create_cardholder(
                d,
                actor,
                &holders::HolderAsk {
                    request_key: text(input, "requestKey"),
                    kind: text(input, "kind"),
                    name: text(input, "name"),
                    email: input.get("email").as_str(),
                    country: text(input, "country"),
                    owners,
                },
            )
        }
        "ops.cardProgrammeBulkValidate" => holders::validate_bulk_json(d, text(input, "file")),
        "ops.cardProgrammeBulkIssue" => holders::issue_bulk(d, actor, text(input, "file")),
        "ops.cardProgrammeReassign" => holders::reassign(
            d,
            actor,
            text(input, "cardId"),
            text(input, "toCardholderId"),
        ),
        "ops.cardProgrammeSimulate" => holders::simulate(d, actor, input),
        _ => return None,
    })
}

/// The slice's answer at the door; `None` for a path outside it.
pub fn answer(
    moves: &crate::cards::moves::Moves<'_>,
    w: &super::Wiring,
    ctx: &Ctx<'_>,
) -> Option<Result<Option<Json>, TrpcError>> {
    let d = Deps::new(moves, w);
    let out = call(&d, ctx)?;
    Some(out.map(Some).map_err(|r| {
        to_trpc(r, || {
            service_kit::approvals::random_uuid().unwrap_or_default()
        })
    }))
}
