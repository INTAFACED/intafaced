//! The slice's calls (`router/business.router.ts` and `ops.businessApprovals` of `ops/business-approvals.ts`), each
//! answered through the router's guard, with the money-out step-up where the TypeScript asks it.

use service_kit::edge::Principal;
use service_kit::json::Json;
use service_kit::money::{Amount, parse_amount};
use service_kit::schema::Value;
use service_kit::trpc::TrpcError;

use super::policy;
use super::service::{
    self as svc, ApprovalsAsk, MemberChange, NewAccount, Payroll, Propose, RecipientAsk,
};
use crate::door::Ctx;
use crate::errors::{Refusal, to_trpc};
use crate::spaces::space::{self, with};
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

/// `payrollLines`: the lines sorted by `(toSpaceId, amount)` as JSON, so the client's order cannot split the hash.
pub fn payroll_lines(lines: &[(String, String)]) -> String {
    let mut sorted: Vec<&(String, String)> = lines.iter().collect();
    sorted.sort();
    Json::Array(
        sorted
            .iter()
            .map(|(s, a)| Json::Array(vec![Json::str(s.clone()), Json::str(a.clone())]))
            .collect(),
    )
    .compact()
}

/// `assetOfSpace`: the space's asset, blank for none.
fn asset_of_space(d: &Deps<'_>, space_id: &str) -> Result<String, Refusal> {
    Ok(with(d.store, |c| space::find(c, space_id))?
        .map(|s| s.asset_id)
        .unwrap_or_default())
}

fn amount_of(v: &Value) -> Result<Amount, Refusal> {
    parse_amount(v.as_str().unwrap_or_default()).map_err(Refusal::Other)
}

/// The answer of one of the slice's calls, by its path; `None` for a path outside it.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    let out = handle(d, ctx)?;
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
fn handle(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let input = &ctx.input;
    let principal: Option<&Principal> = ctx.principal;
    let user = principal.map(|p| p.user_id.as_str()).unwrap_or_default();
    let text = |k: &str| input.get(k).as_str().unwrap_or_default();
    let opt = |k: &str| input.get(k).as_str();
    let number = |k: &str| input.get(k).as_number();
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
        "business.policy" => Ok(policy::describe()),
        "business.list" => svc::accounts_of(d, user, number("limit"))
            .map(|rows| Json::Array(rows.iter().map(svc::Account::json).collect())),
        "business.create" => (|| {
            let a = svc::create_account(
                d,
                &NewAccount {
                    account_id: account_id(),
                    name: text("name"),
                    asset_id: text("assetId"),
                    spend_threshold: amount_of(input.get("spendThreshold"))?,
                    creator_user_id: user,
                },
            )?;
            Ok(a.json())
        })(),
        "business.addMember" => (|| {
            step_up(binding(
                "bank.step_up.business.addMember",
                format!("{}:{}:{}", account_id(), text("userId"), text("role")),
                &[
                    ("actor", user),
                    ("accountId", account_id()),
                    ("userId", text("userId")),
                    ("role", text("role")),
                ],
            ))?;
            svc::add_member(d, account_id(), user, text("userId"), text("role"))
        })(),
        "business.proposeTransfer" => (|| {
            if step_up::enforced(d) {
                let asset = asset_of_space(d, text("fromSpaceId"))?;
                step_up(binding(
                    "bank.step_up.business.proposeTransfer",
                    text("clientId").to_owned(),
                    &[
                        ("actor", user),
                        ("clientId", text("clientId")),
                        ("accountId", account_id()),
                        ("fromSpaceId", text("fromSpaceId")),
                        ("toSpaceId", text("toSpaceId")),
                        ("assetId", &asset),
                        ("amount", text("amount")),
                    ],
                ))?;
            }
            let proposed = svc::propose_transfer(
                d,
                &Propose {
                    account_id: account_id(),
                    maker_user_id: user,
                    from_space_id: text("fromSpaceId"),
                    to_space_id: text("toSpaceId"),
                    amount: amount_of(input.get("amount"))?,
                    client_id: text("clientId"),
                },
            )?;
            Ok(proposed.json())
        })(),
        "business.approve" => (|| {
            step_up(binding(
                "bank.step_up.business.approve",
                text("approvalId").to_owned(),
                &[("actor", user), ("approvalId", text("approvalId"))],
            ))?;
            let (transfer_id, ledger_tx_id) = svc::approve(d, text("approvalId"), user)?;
            Ok(Json::obj([
                ("transferId", Json::str(transfer_id)),
                ("ledgerTxId", Json::str(ledger_tx_id)),
            ]))
        })(),
        "business.reject" => svc::reject(d, text("approvalId"), user).map(|()| ok()),
        "business.cancel" => svc::cancel(d, text("approvalId"), user).map(|()| ok()),
        "business.pending" => svc::list_pending(d, account_id(), user, number("limit")),
        "business.members" => svc::team(d, account_id(), user),
        "business.removeMember" | "business.setMemberRole" => (|| {
            let role = (ctx.call.path == "business.setMemberRole").then(|| text("role"));
            let request_id = text("requestId");
            let b = match role {
                None => binding(
                    "bank.step_up.business.removeMember",
                    request_id.to_owned(),
                    &[
                        ("actor", user),
                        ("accountId", account_id()),
                        ("userId", text("userId")),
                        ("requestId", request_id),
                    ],
                ),
                Some(role) => binding(
                    "bank.step_up.business.setMemberRole",
                    request_id.to_owned(),
                    &[
                        ("actor", user),
                        ("accountId", account_id()),
                        ("userId", text("userId")),
                        ("role", role),
                        ("requestId", request_id),
                    ],
                ),
            };
            step_up(b)?;
            svc::change_member(
                d,
                &MemberChange {
                    account_id: account_id(),
                    actor: user,
                    user_id: text("userId"),
                    request_id,
                    role,
                },
            )
        })(),
        "business.resolveRecipientSpace" => svc::resolve_recipient_space(
            d,
            &RecipientAsk {
                account_id: account_id(),
                actor: user,
                asset_id: text("assetId"),
                handle: opt("handle"),
                email: opt("email"),
            },
        ),
        "business.approvals" => svc::list_approvals(
            d,
            &ApprovalsAsk {
                account_id: account_id(),
                actor: user,
                status: opt("status"),
                limit: number("limit"),
                cursor: opt("cursor"),
            },
        ),
        "business.setThreshold" => (|| {
            let t = amount_of(input.get("spendThreshold"))?;
            svc::set_threshold(d, account_id(), user, t, text("requestId")).map(|c| c.json())
        })(),
        "business.close" => {
            svc::close_account(d, account_id(), user, text("requestId")).map(|c| c.json())
        }
        "business.cancelControl" => {
            svc::cancel_control(d, account_id(), user, text("requestId")).map(|c| c.json())
        }
        "business.myRole" => {
            svc::my_role(d, account_id(), user).map(|role| Json::obj([("role", Json::str(role))]))
        }
        "business.runPayroll" => (|| {
            let raw: Vec<(String, String)> = input
                .get("recipients")
                .as_array()
                .unwrap_or_default()
                .iter()
                .map(|r| {
                    (
                        r.get("toSpaceId").as_str().unwrap_or_default().to_owned(),
                        r.get("amount").as_str().unwrap_or_default().to_owned(),
                    )
                })
                .collect();
            if step_up::enforced(d) {
                let asset = asset_of_space(d, text("fromSpaceId"))?;
                step_up(binding(
                    "bank.step_up.business.runPayroll",
                    text("payrollId").to_owned(),
                    &[
                        ("actor", user),
                        ("payrollId", text("payrollId")),
                        ("accountId", account_id()),
                        ("fromSpaceId", text("fromSpaceId")),
                        ("assetId", &asset),
                        ("lines", &payroll_lines(&raw)),
                    ],
                ))?;
            }
            let recipients = raw
                .iter()
                .map(|(s, a)| Ok((s.clone(), parse_amount(a).map_err(Refusal::Other)?)))
                .collect::<Result<Vec<_>, Refusal>>()?;
            let run = svc::run_payroll(
                d,
                &Payroll {
                    payroll_id: text("payrollId"),
                    account_id: account_id(),
                    actor_user_id: user,
                    from_space_id: text("fromSpaceId"),
                    recipients,
                },
            )?;
            Ok(run.json())
        })(),
        "business.approverEligibility" => {
            svc::approver_eligibility(d, account_id(), text("userId"))
        }
        "ops.businessApprovals" => (|| {
            let limit = svc::operator_limit(number("limit"))?;
            svc::operator_approvals(d, opt("status").unwrap_or("pending"), limit, opt("cursor"))
        })(),
        _ => return None,
    })
}

fn ok() -> Json {
    Json::obj([("ok", Json::Bool(true))])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payroll_lines_sort_by_space_then_amount() {
        let lines = vec![
            ("b".to_owned(), "2".to_owned()),
            ("a".to_owned(), "9".to_owned()),
            ("a".to_owned(), "10".to_owned()),
        ];
        assert_eq!(payroll_lines(&lines), r#"[["a","10"],["a","9"],["b","2"]]"#);
    }
}
