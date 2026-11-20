//! Ambassadors and residencies, stage 1 (`services/svc-academy/src/ambassadors`, their part of `academy-service.ts`
//! and `router.ts`): the badge, appoint, freeze and unfreeze under an identity-issued approval; residency apply,
//! withdraw, the operator queue and decision; the published cohorts. IFC pay and revenue share are Class M: every pay
//! door quotes from the owner's published law or refuses, and none of them reaches the ledger or the database.

pub mod ifc_pay;
pub mod limits;
#[cfg(test)]
mod memory;
pub mod pg;
pub mod programme;
pub mod rate_law;
pub mod residency;

use service_kit::json::Json;
use service_kit::schema::Value;

use self::ifc_pay::{PayKind, PayRefuse, PublicKind};
use self::rate_law::{IfcPayLaw, Law, RateAuthorityRefuse, RevenueShareLaw};
use crate::access::{approval_precheck, payload_hash};
use crate::db;
use crate::door::Ctx;
use crate::errors::Refusal;
use crate::ports::ApprovalConsume;
use crate::programme::method;
use crate::settings::Settings;
use crate::slices::{Answer, not_ported};

/// The settings key of the owner's IFC pay law.
pub const IFC_PAY_LAW_KEY: &str = "ACADEMY_AMBASSADOR_IFC_PAY_LAW_JSON";
/// The settings key of the owner's revenue-share law.
pub const REVENUE_SHARE_LAW_KEY: &str = "ACADEMY_AMBASSADOR_REVENUE_SHARE_LAW_JSON";

/// The two pay laws the router is built with (`index.ts`: `parseAmbassador…LawJson(env.…)`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayLaws {
    pub ifc: IfcPayLaw,
    pub revenue_share: RevenueShareLaw,
}

fn law_text<'a>(settings: &'a Settings, key: &str) -> Option<&'a str> {
    match settings.0.get(key) {
        Some(Json::String(s)) => Some(s.as_str()),
        _ => None,
    }
}

/// Both laws from the settings; a malformed one refuses as the TypeScript's boot fails. The parent can call this at
/// start-up so a bad law stops the service, as `index.ts` does.
pub fn check_laws(settings: &Settings) -> Result<PayLaws, RateAuthorityRefuse> {
    Ok(PayLaws {
        ifc: rate_law::parse_ifc_pay_law_json(law_text(settings, IFC_PAY_LAW_KEY))?,
        revenue_share: rate_law::parse_revenue_share_law_json(law_text(
            settings,
            REVENUE_SHARE_LAW_KEY,
        ))?,
    })
}

fn laws(ctx: &Ctx<'_>) -> Result<PayLaws, Refusal> {
    check_laws(ctx.settings).map_err(|r| Refusal::Precondition {
        message: r.message,
        code: r.code.to_owned(),
    })
}

fn pay_refusal(r: PayRefuse) -> Refusal {
    Refusal::Precondition {
        message: r.message,
        code: r.code.to_owned(),
    }
}

fn text<'a>(ctx: &'a Ctx<'_>, key: &str) -> &'a str {
    ctx.input.get(key).as_str().unwrap_or_default()
}

fn opt_text<'a>(ctx: &'a Ctx<'_>, key: &str) -> Option<&'a str> {
    ctx.input.get(key).as_str()
}

fn opt_bool(ctx: &Ctx<'_>, key: &str) -> Option<bool> {
    match ctx.input.get(key) {
        Value::Bool(b) => Some(*b),
        _ => None,
    }
}

/// `input?.status ? { status } : {}`: only a non-empty value filters.
fn truthy_text<'a>(ctx: &'a Ctx<'_>, key: &str) -> Option<&'a str> {
    opt_text(ctx, key).filter(|s| !s.is_empty())
}

/// `consumeOperatorApproval`: the identity-issued approval for this action and these fields, consumed once, before
/// anything is stored. Answers the approver, or the requester when the approval names none.
fn confirm_operator(
    ctx: &Ctx<'_>,
    action_type: &str,
    fields: &[(&str, &str)],
) -> Result<String, Refusal> {
    let ids = match &ctx.approval {
        Some(ids) => ids.clone(),
        None => approval_precheck(ctx.principal, &ctx.input)?,
    };
    let consumed = ctx.ports.approvals.consume(&ApprovalConsume {
        approval_id: ids.approval_id,
        operation_id: ids.operation_id,
        payload_hash: payload_hash(action_type, fields),
        target_service: "svc-academy",
        target_id: action_type.to_owned(),
        expected_version: "1",
    })?;
    Ok(consumed.approver_id.unwrap_or(consumed.requester_id))
}

/// `{ ...record, confirmOperatorId }`.
fn with_confirm(mut fields: Vec<(String, Json)>, confirm: String) -> Json {
    fields.push(("confirmOperatorId".to_owned(), Json::str(confirm)));
    Json::Object(fields)
}

fn list<T>(items: &[T], to_json: impl Fn(&T) -> Json) -> Json {
    Json::Array(items.iter().map(to_json).collect())
}

/// Routes the area's calls.
pub fn handle(ctx: &Ctx<'_>) -> Answer {
    match ctx.call.path {
        "ambassadorPayPlane" => {
            let l = laws(ctx)?;
            Ok(Some(
                ifc_pay::pay_plane_status(Some(&l.ifc), Some(&l.revenue_share)).to_json(),
            ))
        }
        "ambassadorPayQuote" => {
            let l = laws(ctx)?;
            let quote = if opt_text(ctx, "kind") == Some("revenue_share") {
                ifc_pay::decide_public_pay_quote(
                    PublicKind::RevenueShare,
                    Law::Share(&l.revenue_share),
                    None,
                )
            } else {
                ifc_pay::decide_public_pay_quote(PublicKind::IfcPay, Law::Ifc(&l.ifc), None)
            };
            Ok(Some(quote.to_json()))
        }
        "residencyPayQuote" => {
            let l = laws(ctx)?;
            Ok(Some(
                ifc_pay::decide_public_residency_pay_quote(
                    &l.ifc,
                    opt_text(ctx, "residencyStatus"),
                    None,
                )
                .to_json(),
            ))
        }
        "ambassadorIfcPay" | "ambassadorRevenueShare" => {
            let l = laws(ctx)?;
            let (kind, law) = if ctx.call.path == "ambassadorIfcPay" {
                (PayKind::IfcPay, Law::Ifc(&l.ifc))
            } else {
                (PayKind::RevenueShare, Law::Share(&l.revenue_share))
            };
            let quote = ifc_pay::attempt_pay(&ifc_pay::PayAttempt {
                kind,
                law,
                beneficiary_id: text(ctx, "beneficiaryId"),
                dry_run: opt_bool(ctx, "dryRun").unwrap_or(false),
                residency_status: opt_text(ctx, "residencyStatus"),
                request_law: None,
            })
            .map_err(pay_refusal)?;
            Ok(Some(quote.to_json()))
        }
        "residencyIfcPayQuote" => {
            let l = laws(ctx)?;
            let quote = ifc_pay::attempt_residency_ifc_pay(
                &l.ifc,
                text(ctx, "beneficiaryId"),
                text(ctx, "residencyStatus"),
                opt_bool(ctx, "dryRun"),
            )
            .map_err(pay_refusal)?;
            Ok(Some(quote.to_json()))
        }
        "ambassadorBadge" => {
            method(ctx)?;
            let pool = ctx.service()?;
            let user = text(ctx, "userId");
            let badge = db::with_client(pool, |c| programme::ambassador_badge(c, user))?;
            Ok(Some(badge.to_json()))
        }
        "ambassadors" => {
            method(ctx)?;
            let limit = limits::ambassadors_list_limit(ctx.input.get("limit").as_number())?;
            let pool = ctx.service()?;
            let status = truthy_text(ctx, "status");
            let found = db::with_client(pool, |c| programme::list_ambassadors(c, status, limit))?;
            Ok(Some(list(&found, programme::AmbassadorRecord::to_json)))
        }
        "appointAmbassador" | "unfreezeAmbassador" => {
            let user = text(ctx, "userId");
            let appoint = ctx.call.path == "appointAmbassador";
            let action = if appoint {
                "academy.ambassador.appoint"
            } else {
                "academy.ambassador.unfreeze"
            };
            let confirm = confirm_operator(ctx, action, &[("userId", user)])?;
            method(ctx)?;
            let pool = ctx.service()?;
            let operator = ctx.user_id();
            let record = db::with_client(pool, |c| {
                if appoint {
                    programme::appoint_ambassador(c, user, operator)
                } else {
                    programme::unfreeze_ambassador(c, user, operator)
                }
            })?;
            Ok(Some(with_confirm(record.fields(), confirm)))
        }
        "freezeAmbassador" => {
            let user = text(ctx, "userId");
            let reason = text(ctx, "reason");
            let confirm = confirm_operator(
                ctx,
                "academy.ambassador.freeze",
                &[("userId", user), ("reason", reason)],
            )?;
            method(ctx)?;
            let reason = programme::assert_freeze_reason(reason)?;
            let pool = ctx.service()?;
            let operator = ctx.user_id();
            let record = db::with_client(pool, |c| {
                programme::freeze_checked(c, user, operator, &reason)
            })?;
            Ok(Some(with_confirm(record.fields(), confirm)))
        }
        "applyResidency" => {
            method(ctx)?;
            let (slug, statement) =
                residency::check_application(text(ctx, "cohortSlug"), text(ctx, "statement"))?;
            let pool = ctx.service()?;
            let user = ctx.user_id();
            let r = db::with_client(pool, |c| {
                residency::apply_residency(c, user, &slug, &statement)
            })?;
            Ok(Some(r.to_json()))
        }
        "withdrawResidency" => {
            method(ctx)?;
            let pool = ctx.service()?;
            let (id, user) = (text(ctx, "id"), ctx.user_id());
            let r = db::with_client(pool, |c| residency::withdraw_residency(c, id, user))?;
            Ok(Some(r.to_json()))
        }
        "myResidencies" => {
            method(ctx)?;
            let limit = limits::my_residencies_list_limit(ctx.input.get("limit").as_number())?;
            let pool = ctx.service()?;
            let user = ctx.user_id();
            let found = db::with_client(pool, |c| residency::my_residencies(c, user, limit))?;
            Ok(Some(list(&found, residency::ResidencyApplication::to_json)))
        }
        "openResidencies" => {
            method(ctx)?;
            let limit = limits::open_residencies_list_limit(ctx.input.get("limit").as_number())?;
            let pool = ctx.service()?;
            let slug = truthy_text(ctx, "cohortSlug");
            let found =
                db::with_client(pool, |c| residency::list_open_residencies(c, slug, limit))?;
            Ok(Some(list(&found, residency::ResidencyApplication::to_json)))
        }
        "decideResidency" => {
            let id = text(ctx, "id");
            let decision = text(ctx, "decision");
            let confirm = confirm_operator(
                ctx,
                "academy.residency.decide",
                &[("id", id), ("decision", decision)],
            )?;
            method(ctx)?;
            let pool = ctx.service()?;
            let operator = ctx.user_id();
            let note = opt_text(ctx, "note");
            let r = db::with_client(pool, |c| {
                residency::decide_residency(c, id, operator, decision, note)
            })?;
            Ok(Some(with_confirm(r.fields(), confirm)))
        }
        "residencyCohorts" => {
            method(ctx)?;
            let limit = limits::residency_cohorts_list_limit(ctx.input.get("limit").as_number())?;
            let pool = ctx.service()?;
            let found = db::with_client(pool, |c| residency::residency_cohorts(c, limit))?;
            Ok(Some(list(&found, residency::Cohort::to_json)))
        }
        _ => not_ported(ctx),
    }
}
