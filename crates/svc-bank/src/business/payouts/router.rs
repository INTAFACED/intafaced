//! The slice's calls (`router/business-payouts.router.ts`), each answered through the router's guard, with the money-out
//! step-up where the TypeScript asks it (`bulkRunConfirmBinding`, `contractorBatchBinding`).

use service_kit::json::Json;
use service_kit::money::{Amount, parse_amount};
use service_kit::schema::Value;
use service_kit::trpc::TrpcError;

use super::service::{self as svc, ContractorFields, ImportRun, NewInvoice, NewPayroll, PayBatch};
use crate::door::Ctx;
use crate::errors::{Refusal, to_trpc};
use crate::transfers::Deps;
use crate::transfers::step_up::{self, Binding};

fn binding(action_type: &'static str, operation_key: &str, fields: &[(&str, &str)]) -> Binding {
    Binding {
        action_type,
        operation_key: operation_key.to_owned(),
        fields: fields
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
    }
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

fn handle(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let input = &ctx.input;
    let principal = ctx.principal;
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
    let fields = || ContractorFields {
        name: text("name"),
        email: opt("email"),
        iban: opt("iban"),
        wallet_address: opt("walletAddress"),
    };
    let account_id = text("accountId");
    Some(match ctx.call.path {
        "businessPayouts.runs" => svc::runs(d, account_id, user),
        "businessPayouts.run" => svc::run(d, text("runId"), user),
        "businessPayouts.importRun" => svc::import_run(
            d,
            &ImportRun {
                account_id,
                user_id: user,
                run_id: text("runId"),
                csv: text("csv"),
            },
        ),
        "businessPayouts.confirmRun" => (|| {
            step_up(binding(
                "bank.step_up.businessPayouts.confirmRun",
                text("runId"),
                &[("actor", user), ("runId", text("runId"))],
            ))?;
            svc::confirm_run(d, text("runId"), user)
        })(),
        "businessPayouts.approveRun" => svc::approve_run(d, text("runId"), user),
        "businessPayouts.contractors" => svc::contractors(d, account_id, user),
        "businessPayouts.addContractor" => {
            svc::add_contractor(d, account_id, user, text("contractorId"), &fields())
        }
        "businessPayouts.addInvoice" => (|| {
            svc::add_invoice(
                d,
                &NewInvoice {
                    contractor_id: text("contractorId"),
                    user_id: user,
                    invoice_id: text("invoiceId"),
                    number: text("number"),
                    amount: amount_of(input.get("amount"))?,
                    due_date: opt("dueDate"),
                },
            )
        })(),
        "businessPayouts.createInvite" => svc::create_invite(d, account_id, user),
        "businessPayouts.inviteInfo" => svc::invite_info(d, text("token")),
        "businessPayouts.joinAsContractor" => {
            svc::join_as_contractor(d, text("token"), user, &fields())
        }
        "businessPayouts.batches" => svc::batches(d, account_id, user),
        "businessPayouts.payBatch" => (|| {
            step_up(binding(
                "bank.step_up.businessPayouts.payBatch",
                text("batchId"),
                &[
                    ("actor", user),
                    ("accountId", account_id),
                    ("batchId", text("batchId")),
                ],
            ))?;
            svc::pay_batch(
                d,
                &PayBatch {
                    account_id,
                    user_id: user,
                    batch_id: text("batchId"),
                    invoice_ids: input
                        .get("invoiceIds")
                        .as_array()
                        .unwrap_or_default()
                        .iter()
                        .map(|v| v.as_str().unwrap_or_default().to_owned())
                        .collect(),
                },
            )
        })(),
        "businessPayouts.approveBatch" => svc::approve_batch(d, text("batchId"), user),
        "businessPayouts.wallet" => svc::wallet(d, account_id, user),
        "businessPayouts.walletOffer" => svc::wallet_offer(d, account_id, user, text("address")),
        "businessPayouts.connectWallet" => {
            svc::connect_wallet(d, text("offerId"), user, text("signature"))
        }
        "businessPayouts.payrolls" => svc::payrolls(d, account_id, user),
        "businessPayouts.createPayroll" => (|| {
            let members = input
                .get("members")
                .as_array()
                .unwrap_or_default()
                .iter()
                .map(|m| {
                    Ok((
                        m.get("contractorId")
                            .as_str()
                            .unwrap_or_default()
                            .to_owned(),
                        amount_of(m.get("amount"))?,
                    ))
                })
                .collect::<Result<Vec<_>, Refusal>>()?;
            svc::create_payroll(
                d,
                &NewPayroll {
                    account_id,
                    user_id: user,
                    payroll_id: text("payrollId"),
                    name: text("name"),
                    day_of_month: input.get("dayOfMonth").as_number().unwrap_or_default(),
                    members,
                },
            )
        })(),
        "businessPayouts.prepareRun" => {
            svc::prepare_run(d, text("payrollId"), user, text("period"))
        }
        "businessPayouts.signRun" => svc::sign_run(d, text("runId"), user, text("signature")),
        _ => return None,
    })
}
