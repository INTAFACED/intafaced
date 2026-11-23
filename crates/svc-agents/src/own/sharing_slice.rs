//! The own-sharing slice's calls, answered as `own/routes.ts` answers them: `own.access.*`, `own.coOwners.*`,
//! `own.sharedWithMe`, `own.share.*` and `own.identity.*`. The door has already checked the caller, the scope, the
//! region, the person checks (`assertPersonSetsLimits`) and the input; each handler runs inside the route's `guard`,
//! with the call's own mapping where the route names one.

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::trpc::TrpcError;

use super::identity::Owner;
use super::self_freeze::assert_not_self_frozen;
use super::sharing::Include;
use super::{
    Own, OwnError, OwnRefusal, access, guard, identity, no_mapping, owner_forbidden, pool_of,
    sharing, store,
};
use crate::db::Store;
use crate::door::{Ctx, Slice, not_ported};
use crate::runtime::Runtime;

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).as_str().unwrap_or("")
}

fn flag(v: &Value, key: &str) -> bool {
    matches!(v.get(key), Value::Bool(true))
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
    pub rt: &'a Runtime,
    pub own: &'a Own,
}

impl Deps<'_> {
    /// `tooling.accounts` and `tooling.selfFreeze`.
    fn owner(&self) -> Owner<'_> {
        Owner {
            accounts: self.own.support_desk.as_deref(),
            freeze: self.rt.self_freeze.as_deref(),
        }
    }
}

/// `share.set`'s mapping.
fn share_refused(code: &str) -> Option<&'static str> {
    (code == "agents.privacy.confirm_required").then_some("PRECONDITION_FAILED")
}

/// `own.identity.agentCall`'s: an owner's account refusing is FORBIDDEN, any other refusal UNAUTHORIZED.
fn token_refused(code: &str) -> Option<&'static str> {
    owner_forbidden(code).or(Some("UNAUTHORIZED"))
}

/// The mapping each call's `guard` takes.
fn mapping(path: &str) -> fn(&str) -> Option<&'static str> {
    match path {
        "own.access.grant" | "own.identity.issue" => owner_forbidden,
        "own.share.set" => share_refused,
        "own.identity.agentCall" => token_refused,
        _ => no_mapping,
    }
}

/// Answers one call of the slice.
pub fn handle(ctx: &Ctx<'_>, d: &Deps<'_>) -> Result<Option<Json>, TrpcError> {
    answer(ctx, d)
        .map(Some)
        .map_err(|e| guard(e, mapping(ctx.call.path)))
}

fn include(input: &Value) -> Include {
    Include {
        transcripts: flag(input, "includeTranscripts"),
        memory: flag(input, "includeMemory"),
    }
}

fn answer(ctx: &Ctx<'_>, d: &Deps<'_>) -> Result<Json, OwnError> {
    let input = &ctx.input;
    let user = ctx.principal.map_or("", |p| p.user_id.as_str());
    if ctx.call.path == "own.identity.agentCall" {
        // A public call: the agent's own token says who it acts as, never a session.
        return identity::call(pool_of(d.store)?, text(input, "token"), &d.owner(), ctx.now);
    }
    if ctx.call.path == "own.sharedWithMe" {
        return sharing::shared_with(pool_of(d.store)?, user, whole(input, "limit"));
    }
    let pool = pool_of(d.store)?;
    let agent = match ctx.call.path {
        "own.access.get"
        | "own.access.grant"
        | "own.coOwners.list"
        | "own.coOwners.add"
        | "own.coOwners.remove"
        | "own.share.get"
        | "own.share.check"
        | "own.share.set"
        | "own.identity.get"
        | "own.identity.issue"
        | "own.identity.revoke" => store::get(pool, user, text(input, "id"))?,
        _ => return Err(OwnError::Trpc(not_ported(Slice::OwnSharing))),
    };
    let id = agent.id.as_str();
    match ctx.call.path {
        "own.access.get" => Ok(access::access_json(&access::read(pool, user, id)?)),
        "own.access.grant" => {
            assert_not_self_frozen(user, d.rt.self_freeze.as_deref())?;
            let subs = input
                .get("subAccounts")
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .map(|s| (text(s, "subAccount"), text(s, "name")))
                        .collect()
                })
                .unwrap_or_default();
            let grants = access::grant(
                pool,
                user,
                id,
                &access::GrantInput {
                    grant_key: text(input, "grantKey"),
                    venue_id: text(input, "venueId"),
                    owner: text(input, "owner"),
                    sub_accounts: subs,
                    ends_in: input.get("endsInDays").as_str(),
                },
                ctx.now,
            )?;
            Ok(access::access_json(&grants))
        }
        "own.coOwners.list" => sharing::co_owners(pool, user, id),
        "own.coOwners.add" => {
            let co_owner = sharing::check_co_owner(user, text(input, "coOwner"))?;
            if sharing::is_group(pool, &co_owner)? {
                return Err(OwnRefusal::new("agents.own.co_owner_group").into());
            }
            sharing::assert_active_person(d.own.support_desk.as_deref(), &co_owner)?;
            sharing::add_co_owner(pool, user, id, &co_owner)?;
            sharing::co_owners(pool, user, id)
        }
        "own.coOwners.remove" => {
            let co_owner = service_kit::schema::js_trim(text(input, "coOwner")).to_lowercase();
            sharing::remove_co_owner(pool, user, id, &co_owner)?;
            sharing::co_owners(pool, user, id)
        }
        "own.share.get" => sharing::share(pool, user, id),
        "own.share.check" => {
            let (exposes, co_owners) = sharing::share_check(pool, id, include(input))?;
            Ok(sharing::share_check_json(&exposes, co_owners))
        }
        "own.share.set" => {
            sharing::set_share(pool, user, id, include(input), flag(input, "confirmed"))
        }
        "own.identity.get" => Ok(Json::obj([(
            "token",
            identity::latest(pool, user, id)?.map_or(Json::Null, |t| t.to_json(ctx.now)),
        )])),
        "own.identity.issue" => {
            let lifetime = identity::token_lifetime(d.own.token_lifetime_minutes)?;
            let (token, secret) = identity::issue(
                pool,
                user,
                id,
                &agent.tools,
                Some(lifetime),
                &d.owner(),
                ctx.now,
            )?;
            Ok(identity::issued_json(&token, &secret))
        }
        "own.identity.revoke" => Ok(identity::revoke(pool, user, id, ctx.now)?.to_json(ctx.now)),
        _ => Err(OwnError::Trpc(not_ported(Slice::OwnSharing))),
    }
}
