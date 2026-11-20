//! The certs slice: the calls the door table gives `Slice::Certs`, answered as `router.ts` and `designs-router.ts`
//! answer them.
//!
//! A call that reaches `AcademyService` first meets a refusing service ([`enter`]); the plane reads, the definitions and
//! the paths are then answered from code, whatever the database does. Each other call checks what the TypeScript
//! checks before its first query (an owner value, a placeholder path, an unknown certificate) and only then reads.
//! `certVerify` checks its owner rate, the caller's address and the window before the service; `certPerkIntent` never
//! reaches the service. `revokeCert` and `grantCertException` read the recorded answer before spending the two people's
//! approval.

use service_kit::json::Json;
use service_kit::schema::{Value, js_trim};

use crate::access::{approval_precheck, payload_hash};
use crate::certs::designs::{self, Content};
use crate::certs::service::{Certs, Issue, Pair};
use crate::certs::verify_rate::Take;
use crate::certs::{Owner, catalog, enrolment, perks, producer, xp};
use crate::db::Store;
use crate::door::Ctx;
use crate::errors::{AcademyError, Refusal};
use crate::ports::ApprovalConsume;
use crate::slices::{Answer, not_ported};

/// A call into `AcademyService`: a service that refuses every method refuses here, before anything else runs.
fn enter(ctx: &Ctx<'_>) -> Result<(), Refusal> {
    match ctx.store {
        Store::Refuses(r) => Err(r.clone()),
        _ => Ok(()),
    }
}

fn text<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).as_str()
}

fn academy(message: &str, code: &str) -> Refusal {
    AcademyError::new(message, code).into()
}

/// `consumeApprovalPair`: the operator, two-factor and both ids, then identity's consume; a consume naming no approver
/// is not two people.
fn consume_pair(
    ctx: &Ctx<'_>,
    action: &str,
    fields: &[(&str, &str)],
) -> Result<(String, String), Refusal> {
    let ids = approval_precheck(ctx.principal, &ctx.input)?;
    let consumed = ctx.ports.approvals.consume(&ApprovalConsume {
        approval_id: ids.approval_id,
        operation_id: ids.operation_id,
        payload_hash: payload_hash(action, fields),
        target_service: "svc-academy",
        target_id: action.to_owned(),
        expected_version: "1",
    })?;
    let Some(approver) = consumed.approver_id else {
        return Err(Refusal::DualControl(
            "the approval names no approver; a second person must approve it".to_owned(),
        ));
    };
    Ok((consumed.requester_id, approver))
}

/// The certificate design content of a save's input.
fn content_of(input: &Value) -> Content {
    let s = |k: &str| text(input, k).unwrap_or_default().to_owned();
    let opt = |k: &str| text(input, k).map(str::to_owned);
    let signatories = match input.get("signatories") {
        Value::Array(items) => items
            .iter()
            .map(|v| {
                (
                    v.get("name").as_str().unwrap_or_default().to_owned(),
                    v.get("role").as_str().unwrap_or_default().to_owned(),
                )
            })
            .collect(),
        _ => Vec::new(),
    };
    Content {
        title: s("title"),
        body: s("body"),
        signatories,
        disclaimer: opt("disclaimer"),
        language: s("language"),
        size: s("size"),
        effort_hours: opt("effortHours"),
    }
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "the input schema admits only whole numbers here"
)]
fn whole(input: &Value, key: &str) -> Option<i64> {
    input.get(key).as_number().map(|n| n as i64)
}

/// The progress report and its issue, as `certProgressOut`.
fn progress_json(p: &crate::certs::progress::Report, issue: &Issue) -> Json {
    Json::obj([
        ("userId", Json::str(p.user_id.clone())),
        ("certId", Json::str(p.cert_id.clone())),
        ("title", Json::str(p.title.clone())),
        (
            "requiredCount",
            Json::int(i64::try_from(p.required_count).unwrap_or(0)),
        ),
        (
            "completedCount",
            Json::int(i64::try_from(p.completed_count).unwrap_or(0)),
        ),
        ("ratio", Json::str(p.ratio.clone())),
        (
            "missingItemSlugs",
            Json::Array(
                p.missing_item_slugs
                    .iter()
                    .map(|s| Json::str(s.clone()))
                    .collect(),
            ),
        ),
        ("complete", Json::Bool(p.complete)),
        ("granted", Json::Bool(p.granted)),
        (
            "grantIdempotencyKey",
            p.grant_idempotency_key
                .as_ref()
                .map_or(Json::Null, |k| Json::str(k.clone())),
        ),
        ("issue", issue.json()),
    ])
}

/// The calls that need the service's parts, with the database in hand.
fn served(ctx: &Ctx<'_>, certs: &Certs<'_>) -> Answer {
    let input = &ctx.input;
    let user = ctx.user_id();
    let now = ctx.now.0;
    let out = match ctx.call.path {
        "enrollCertPath" => {
            enrolment::enroll_cert_path(certs, user, text(input, "pathSlug").unwrap_or(""), now)?
                .json()
        }
        "grantCert" => certs
            .grant_cert(user, text(input, "certId").unwrap_or(""), false, now)?
            .json(),
        "myCerts" => certs.my_cert_grants(user, input.get("limit").as_number())?,
        "certProgress" => {
            let (p, issue) = certs.cert_progress(user, text(input, "certId").unwrap_or(""), now)?;
            progress_json(&p, &issue)
        }
        "certVerify" => certs.cert_verify(text(input, "publicId").unwrap_or(""))?,
        "setCertHolderName" => certs.set_cert_holder_name(
            user,
            text(input, "grantId"),
            text(input, "publicId"),
            text(input, "holderName"),
            text(input, "clientRequestId").unwrap_or(""),
            now,
        )?,
        "myCompletions" => enrolment::my_completions(
            certs,
            user,
            input.get("limit").as_number(),
            text(input, "cursor"),
        )?,
        "myEnrollments" => Json::Array(
            crate::db::with_client(ctx.service()?, |c| enrolment::my_enrolments(c, user))?
                .iter()
                .map(enrolment::Enrolment::json)
                .collect(),
        ),
        "leaveCertPath" => {
            let row = enrolment::leave_cert_path(
                certs,
                user,
                text(input, "pathSlug").unwrap_or(""),
                text(input, "clientRequestId").unwrap_or(""),
            )?;
            let Some(left) = row.left_at else {
                return Err(academy(
                    "Leave did not record leftAt",
                    "academy.cert_invalid",
                ));
            };
            let Json::Object(mut f) = row.json() else {
                return Err(academy(
                    "Leave did not record leftAt",
                    "academy.cert_invalid",
                ));
            };
            f.push(("leftAt".to_owned(), Json::str(crate::certs::sql::iso(left))));
            Json::Object(f)
        }
        "admin.setCertIssueRule" => certs
            .set_cert_issue_rule(
                text(input, "certId").unwrap_or(""),
                text(input, "mode").unwrap_or(""),
                whole(input, "delayMinutes"),
                text(input, "reason").unwrap_or(""),
                user,
                now,
            )?
            .json(),
        "admin.certIssueRule" => certs
            .cert_issue_rule(text(input, "certId").unwrap_or(""))?
            .map_or(Json::Null, |r| r.json()),
        "admin.revokeCert" => {
            let public_id = text(input, "publicId").unwrap_or("");
            let reason = text(input, "reason").unwrap_or("");
            // A repeat answers the first record, and an unknown code refuses, before the approval is spent.
            if let Some(recorded) = certs.cert_revocation(public_id)? {
                certs.settle_revoked_xp(public_id);
                return Ok(Some(recorded));
            }
            let (proposed, approved) = consume_pair(
                ctx,
                "academy.cert.revoke",
                &[("publicId", public_id), ("reason", reason)],
            )?;
            certs.revoke_cert(
                public_id,
                reason,
                &Pair {
                    proposed_by: &proposed,
                    approved_by: &approved,
                    operator_id: user,
                },
                now,
            )?
        }
        "admin.grantCertException" => {
            let learner = text(input, "userId").unwrap_or("");
            let cert_id = text(input, "certId").unwrap_or("");
            let reason = text(input, "reason").unwrap_or("");
            if let Some(recorded) = certs.cert_exception(learner, cert_id)? {
                return Ok(Some(recorded));
            }
            let (proposed, approved) = consume_pair(
                ctx,
                "academy.cert.exception",
                &[("userId", learner), ("certId", cert_id), ("reason", reason)],
            )?;
            certs.grant_cert_exception(
                learner,
                cert_id,
                reason,
                &Pair {
                    proposed_by: &proposed,
                    approved_by: &approved,
                    operator_id: user,
                },
                now,
            )?
        }
        _ => return designs_call(ctx, certs),
    };
    Ok(Some(out))
}

/// The design and issued-list calls, through the family's guard.
fn designs_call(ctx: &Ctx<'_>, certs: &Certs<'_>) -> Answer {
    let input = &ctx.input;
    let d = certs.designs();
    let user = ctx.user_id();
    let now = ctx.now.0;
    let out = match ctx.call.path {
        "admin.certDesigns" => d.list(),
        "admin.certDesign" => d.design(text(input, "certId").unwrap_or("")),
        "admin.saveCertDesign" => d.save(
            text(input, "certId").unwrap_or(""),
            &content_of(input),
            whole(input, "revision").unwrap_or(0),
            text(input, "reason").unwrap_or(""),
            user,
            now,
        ),
        "admin.activateCertDesign" => d.activate(
            text(input, "certId").unwrap_or(""),
            whole(input, "revision").unwrap_or(0),
            text(input, "reason").unwrap_or(""),
            user,
            now,
        ),
        "admin.deactivateCertDesign" => d.deactivate(
            text(input, "certId").unwrap_or(""),
            text(input, "reason").unwrap_or(""),
            user,
            now,
        ),
        "admin.issuedCerts" => {
            let certificate = text(input, "certificate")
                .map(js_trim)
                .filter(|s| !s.is_empty());
            d.issued(certificate)
        }
        "admin.certExports" => d.exports(),
        "admin.makeCertExport" => d.make_export(whole(input, "n").unwrap_or(0), user, now),
        "admin.certExportFile" => d.export_file(whole(input, "n").unwrap_or(0)),
        _ => return not_ported(ctx),
    };
    designs::guard(out).map(Some)
}

/// `certVerify`'s checks before the service: the owner's rate, the caller's address, the window.
fn verify_gate(ctx: &Ctx<'_>, owner: &Owner) -> Result<(), Refusal> {
    let Some(rate) = owner.verify_rate else {
        return Err(academy(
            "academy.verify_rate_unset",
            "academy.verify_rate_unset",
        ));
    };
    let address = js_trim(ctx.client_address);
    if address.is_empty() {
        return Err(academy(
            "academy.verify_address_unset",
            "academy.verify_address_unset",
        ));
    }
    if ctx.certs.limiter.take(address, rate) == Take::Limited {
        return Err(academy(
            "academy.verify_rate_limited",
            "academy.verify_rate_limited",
        ));
    }
    Ok(())
}

pub fn handle(ctx: &Ctx<'_>) -> Answer {
    let settings = &ctx.settings.0;
    let owner = Owner::from_settings(settings);
    match ctx.call.path {
        // Never reaches the service.
        "certPerkIntent" => {
            let d = perks::decide_invent(text(&ctx.input, "kind").unwrap_or(""));
            let Json::Object(fields) = d.clone() else {
                return Err(academy(
                    "Cert perk invent plane must stay refuse-closed",
                    "academy.cert_invalid",
                ));
            };
            if !perks::is_invent_refuse_closed(&d) {
                return Err(academy(
                    "Cert perk invent plane must stay refuse-closed",
                    "academy.cert_invalid",
                ));
            }
            let mut out = vec![("ok".to_owned(), Json::Bool(false))];
            out.extend(fields);
            return Ok(Some(Json::Object(out)));
        }
        "certVerify" => verify_gate(ctx, &owner)?,
        _ => {}
    }
    enter(ctx)?;
    let publisher = xp::BusPublisher {
        bus: &*ctx.ports.bus,
        producer: producer(settings),
        clock: ctx.certs.clock,
    };
    let certs = Certs {
        store: ctx.store,
        catalog: catalog::production(),
        xp: &publisher,
        host_rights: &*ctx.ports.host_rights,
        sweep_running: owner.sweep_seconds.is_some(),
        issued_rows: owner.issued_rows,
        wall: ctx.certs.clock,
    };
    match ctx.call.path {
        "certDefinitions" => Ok(Some(certs.definitions_json())),
        "certPaths" => Ok(Some(certs.paths_json())),
        "certXpPlane" => Ok(Some(xp::plane_status(&publisher))),
        "certPerkPlane" => Ok(Some(perks::plane_status())),
        _ => served(ctx, &certs),
    }
}
