//! The slice's calls (`router/business-team.router.ts`), each answered through the router's guard, with the money-out
//! step-up where the TypeScript asks it.

use service_kit::edge::Principal;
use service_kit::json::Json;
use service_kit::money::{Amount, parse_amount};
use service_kit::schema::Value;
use service_kit::trpc::TrpcError;

use super::service::{self as svc, InviteAsk, ProposeAsk, RuleAsk};
use crate::door::Ctx;
use crate::errors::{Refusal, to_trpc};
use crate::transfers::Deps;
use crate::transfers::step_up::{self, Binding};

fn binding(action_type: &'static str, operation_key: String, fields: &[(&str, &str)]) -> Binding {
    Binding {
        action_type,
        operation_key,
        fields: fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
    }
}

fn amount_of(v: &Value) -> Result<Amount, Refusal> {
    parse_amount(v.as_str().unwrap_or_default()).map_err(Refusal::Other)
}

/// The answer of one of the slice's calls, by its path; `None` for a path outside it. `invite_minutes` is
/// `BANK_BUSINESS_INVITE_MINUTES` as published.
pub fn answer(
    d: &Deps<'_>,
    ctx: &Ctx<'_>,
    invite_minutes: Option<&str>,
) -> Option<Result<Option<Json>, TrpcError>> {
    let out = handle(d, ctx, invite_minutes)?;
    Some(out.map(Some).map_err(|r| {
        to_trpc(r, || {
            service_kit::approvals::random_uuid().unwrap_or_default()
        })
    }))
}

#[allow(
    clippy::too_many_lines,
    reason = "one arm per call, as the router lists them"
)]
fn handle(d: &Deps<'_>, ctx: &Ctx<'_>, minutes: Option<&str>) -> Option<Result<Json, Refusal>> {
    let input = &ctx.input;
    let principal: Option<&Principal> = ctx.principal;
    let user = principal.map(|p| p.user_id.as_str()).unwrap_or_default();
    let text = |k: &str| input.get(k).as_str().unwrap_or_default();
    let opt = |k: &str| input.get(k).as_str();
    let step_up = |b: Binding| -> Result<(), Refusal> {
        if !step_up::enforced(d) {
            return Ok(());
        }
        let Some(p) = principal else {
            return Err(Refusal::Other(
                "a step-up call with no principal".to_owned(),
            ));
        };
        step_up::require(d, p, &b, opt("stepUpApprovalId"))
    };
    let account_id = || text("accountId");
    Some(match ctx.call.path {
        "businessTeam.overview" => svc::overview(d, account_id(), user, minutes),
        "businessTeam.members" => svc::members(d, account_id(), user),
        "businessTeam.roles" => svc::roles(d, account_id(), user),
        "businessTeam.advisors" => svc::advisors(d, account_id(), user),
        "businessTeam.invites" => svc::invites(d, account_id(), user),
        "businessTeam.rules" => svc::rules(d, account_id(), user),
        "businessTeam.payments" => svc::payments(d, account_id(), user),
        "businessTeam.payment" => svc::payment(d, text("paymentId"), user),
        "businessTeam.spend" => svc::spend(d, account_id(), user),
        "businessTeam.createRole" => {
            let permissions: Vec<String> = input
                .get("permissions")
                .as_array()
                .unwrap_or_default()
                .iter()
                .map(|p| p.as_str().unwrap_or_default().to_owned())
                .collect();
            svc::create_role(
                d,
                account_id(),
                user,
                text("roleId"),
                text("name"),
                &permissions,
            )
        }
        "businessTeam.assignRole" => (|| {
            step_up(binding(
                "bank.step_up.businessTeam.assignRole",
                format!(
                    "{}:{}:{}",
                    account_id(),
                    text("userId"),
                    opt("roleId").unwrap_or("")
                ),
                &[
                    ("actor", user),
                    ("accountId", account_id()),
                    ("userId", text("userId")),
                    ("roleId", opt("roleId").unwrap_or("")),
                ],
            ))?;
            svc::assign_role(d, account_id(), user, text("userId"), opt("roleId"))
        })(),
        "businessTeam.addAdvisor" => svc::add_advisor(d, account_id(), user, text("handle")),
        "businessTeam.approveAdvisor" => {
            svc::approve_advisor(d, account_id(), user, text("userId"))
        }
        "businessTeam.invite" => (|| {
            step_up(binding(
                "bank.step_up.businessTeam.invite",
                text("inviteId").to_owned(),
                &[
                    ("actor", user),
                    ("accountId", account_id()),
                    ("inviteId", text("inviteId")),
                    ("email", opt("email").unwrap_or("")),
                    ("role", opt("role").unwrap_or("")),
                    ("roleId", opt("roleId").unwrap_or("")),
                ],
            ))?;
            svc::invite(
                d,
                &InviteAsk {
                    account_id: account_id(),
                    actor: user,
                    invite_id: text("inviteId"),
                    email: opt("email"),
                    role: opt("role"),
                    role_id: opt("roleId"),
                },
                minutes,
            )
        })(),
        "businessTeam.resendInvite" => svc::resend_invite(
            d,
            account_id(),
            user,
            text("inviteId"),
            text("newInviteId"),
            minutes,
        ),
        "businessTeam.revokeInvite" => svc::revoke_invite(d, account_id(), user, text("inviteId")),
        "businessTeam.acceptInvite" => (|| {
            if step_up::enforced(d) {
                let token_hash = svc::hash_token(text("token"));
                step_up(binding(
                    "bank.step_up.businessTeam.acceptInvite",
                    token_hash.clone(),
                    &[("actor", user), ("tokenHash", &token_hash)],
                ))?;
            }
            svc::accept_invite(d, text("token"), user)
        })(),
        "businessTeam.addRule" => (|| {
            svc::add_rule(
                d,
                &RuleAsk {
                    account_id: account_id(),
                    actor: user,
                    rule_id: text("ruleId"),
                    over_amount: amount_of(input.get("overAmount"))?,
                    payee: opt("payee"),
                    payment_type: opt("paymentType"),
                    approvals: input.get("approvals").as_number().unwrap_or_default(),
                },
            )
        })(),
        "businessTeam.propose" => (|| {
            // Money leaves here when no rule applies, so the maker confirms the exact payment as the business door asks.
            step_up(binding(
                "bank.step_up.businessTeam.propose",
                text("paymentId").to_owned(),
                &[
                    ("actor", user),
                    ("accountId", account_id()),
                    ("paymentId", text("paymentId")),
                    ("payee", text("payee")),
                    ("paymentType", text("paymentType")),
                    ("amount", text("amount")),
                ],
            ))?;
            svc::propose(
                d,
                &ProposeAsk {
                    account_id: account_id(),
                    maker: user,
                    payment_id: text("paymentId"),
                    payee: text("payee"),
                    payment_type: text("paymentType"),
                    amount: amount_of(input.get("amount"))?,
                },
            )
        })(),
        "businessTeam.approve" => (|| {
            step_up(binding(
                "bank.step_up.businessTeam.approve",
                format!("{}:{user}", text("paymentId")),
                &[("actor", user), ("paymentId", text("paymentId"))],
            ))?;
            svc::approve(d, text("paymentId"), user)
        })(),
        "businessTeam.reject" => svc::reject(d, text("paymentId"), user),
        "businessTeam.resend" => svc::resend(d, text("paymentId"), user),
        "businessTeam.addDepartment" => (|| {
            let budget = match opt("budget") {
                Some(b) => Some(parse_amount(b).map_err(Refusal::Other)?),
                None => None,
            };
            svc::add_department(
                d,
                account_id(),
                user,
                text("departmentId"),
                text("name"),
                budget,
            )
        })(),
        "businessTeam.setDepartment" => {
            svc::set_department(d, account_id(), user, text("userId"), opt("departmentId"))
        }
        _ => return None,
    })
}
