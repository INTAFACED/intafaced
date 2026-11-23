//! `businessBooks.*` (`router/business-books.router.ts`), each answered through the router's guard. Every door is the
//! signed-in member's; what each may do is their permissions on that business, checked by the service. Nothing here
//! moves money.

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::time::{Instant, js_date};
use service_kit::trpc::TrpcError;

use super::service::{self as svc, CodeAsk, Range, RuleAsk, lines_json};
use crate::door::Ctx;
use crate::errors::{Refusal, to_trpc};
use crate::transfers::Deps;
use crate::transfers::step_up::{Binding, Gate, Request, SqlUses};

/// `bookStatementBinding`.
fn statement_binding(actor: &str, account_id: &str, export_id: &str, range: Range) -> Binding {
    let fields = [
        ("actor", actor.to_owned()),
        ("accountId", account_id.to_owned()),
        ("exportId", export_id.to_owned()),
        ("from", range.from.iso()),
        ("to", range.to.iso()),
    ];
    Binding {
        action_type: "bank.step_up.businessBooks.exportStatement",
        operation_key: export_id.to_owned(),
        fields: fields.into_iter().map(|(k, v)| (k.to_owned(), v)).collect(),
    }
}

/// `new Date(text)` of a field the input check passed as a datetime.
fn instant(v: &Value) -> Result<Instant, Refusal> {
    js_date(v.as_str().unwrap_or_default())
        .ok_or_else(|| Refusal::Other("Invalid time value".to_owned()))
}

fn range(input: &Value) -> Result<Range, Refusal> {
    Ok(Range {
        from: instant(input.get("from"))?,
        to: instant(input.get("to"))?,
    })
}

/// `businessBooks.*`; `None` for a call outside it.
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
    let account_id = text("accountId");
    Some(match ctx.call.path {
        "businessBooks.overview" => svc::overview(d, account_id, user),
        "businessBooks.connectAccounting" => svc::connect_accounting(d, account_id, user),
        "businessBooks.lines" => (|| {
            let lines = svc::lines(d, account_id, user, range(input)?)?;
            Ok(lines_json("items", &lines))
        })(),
        "businessBooks.testRule" => (|| {
            let matches =
                svc::test_rule(d, account_id, user, range(input)?, text("payeeContains"))?;
            Ok(lines_json("matches", &matches))
        })(),
        "businessBooks.saveRule" => svc::save_rule(
            d,
            account_id,
            user,
            &RuleAsk {
                rule_id: text("ruleId"),
                payee_contains: text("payeeContains"),
                category: text("category"),
                gl_code: opt("glCode"),
            },
        ),
        "businessBooks.codeLines" => (|| {
            let line_ids: Vec<String> = input
                .get("lineIds")
                .as_array()
                .unwrap_or_default()
                .iter()
                .map(|v| v.as_str().unwrap_or_default().to_owned())
                .collect();
            let items = svc::code_lines(
                d,
                account_id,
                user,
                &CodeAsk {
                    range: range(input)?,
                    line_ids: &line_ids,
                    category: opt("category"),
                    gl_code: opt("glCode"),
                },
            )?;
            Ok(lines_json("items", &items))
        })(),
        "businessBooks.exportStatement" => (|| {
            let r = range(input)?;
            svc::export_statement(d, account_id, user, r, text("format"), || {
                let Some(p) = principal else {
                    return Err(Refusal::Other(
                        "a step-up call with no principal".to_owned(),
                    ));
                };
                let binding = statement_binding(user, account_id, text("exportId"), r);
                // Always required (`index.ts`: `mode: 'required'`), whatever `BANK_STEP_UP_MONEY_OUT` says.
                Gate {
                    required: true,
                    approvals: d.w.approvals.as_ref(),
                    store: &SqlUses(d.store),
                    now: d.now,
                }
                .require(&Request {
                    user_id: user,
                    session_id: &p.sid,
                    binding: &binding,
                    approval_id: opt("stepUpApprovalId"),
                    replay: true,
                })
            })
        })(),
        _ => return None,
    })
}
