//! The job doors and svc-ops' two reads, as `index.ts` mounts them on its Fastify app beside `/trpc`.
//!
//! Every one is a `POST`, its body read by Fastify's parsers (`rest::read_body`), then signed as a service
//! (`requireService`: `requireInternalJobHmac`, the body always bound, and svc-edge never a job caller), else 401
//! `bank.unauthenticated` before anything else, so the difference between 401 and a job's own switch tells an unsigned
//! caller nothing.
//!
//! - The `/internal/jobs/*` routes ([`JOB_DOORS`]): past the signature each is its slice's (its switch's 503, its body's
//!   400 `bank.validation_failed`, its work, and a `BankError` as 400, [`job_refuse`]). Until that slice is ported it
//!   answers "not ported" (500).
//! - `POST /internal/restore/watermark` (slice `store`): svc-ops alone (any other signed service is 403
//!   `bank.caller_forbidden`), the bank's row-count watermark (`restore_watermark`).
//! - `POST /internal/capital/partner-reserves`: svc-ops alone, then the `card-ops` slice's.

use service_kit::json::Json;
use service_kit::s2s_verify::BodyBind;
use service_kit::schema::Value;
use service_kit::server::{Request, Response};

use super::rest::{fastify_error, read_body, reply};
use super::{BankDoor, Slice};
use crate::errors::BankError;
use crate::restore_watermark::{self, BANK_SCHEMA};

/// One `/internal/jobs/*` route and the slice that owns its work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JobDoor {
    pub path: &'static str,
    pub slice: Slice,
}

const fn job(path: &'static str, slice: Slice) -> JobDoor {
    JobDoor { path, slice }
}

/// Every job route `index.ts` registers, in its order.
pub const JOB_DOORS: [JobDoor; 27] = [
    job("/internal/jobs/run-due-transfers", Slice::Transfers),
    job("/internal/jobs/accrue-interest", Slice::Earn),
    job("/internal/jobs/accrue-loan-interest", Slice::Loans),
    job("/internal/jobs/run-risk-sweep", Slice::Loans),
    job("/internal/jobs/resume-pending-loans", Slice::Loans),
    job("/internal/jobs/recover-loan-repayments", Slice::Loans),
    job("/internal/jobs/resume-pending-earn", Slice::Earn),
    job("/internal/jobs/run-auto-invest", Slice::Automations),
    job("/internal/jobs/payout-sim/verify", Slice::PartnerAccount),
    job("/internal/jobs/payout-sim/paid", Slice::PartnerAccount),
    job("/internal/jobs/payout-sim/failed", Slice::PartnerAccount),
    job("/internal/jobs/payout-sim/cancelled", Slice::PartnerAccount),
    job("/internal/jobs/payout-sim/returned", Slice::PartnerAccount),
    job("/internal/jobs/bill-pay/run-due", Slice::BusinessSpend),
    job("/internal/jobs/bill-pay/returned", Slice::BusinessSpend),
    job("/internal/jobs/payin-sim/paid", Slice::Ramps),
    job("/internal/jobs/payin-sim/returned", Slice::Ramps),
    job("/internal/jobs/card-sim/shipment", Slice::Cards),
    job("/internal/jobs/payroll-sim/credit", Slice::PartnerAccount),
    job("/internal/jobs/payroll-sim/reverse", Slice::PartnerAccount),
    job("/internal/jobs/pay-yourself/run-due", Slice::Automations),
    job("/internal/jobs/redrive-cash-outs", Slice::PartnerAccount),
    job("/internal/jobs/dd-sim/mandate", Slice::Bills),
    job("/internal/jobs/dd-sim/collection", Slice::Bills),
    job("/internal/jobs/run-scheduled-notices", Slice::Automations),
    job("/internal/jobs/run-income-sorter", Slice::Automations),
    job("/internal/jobs/run-due-direct-debits", Slice::Bills),
];

/// svc-ops' reads, signed like the job doors.
pub const RESTORE_WATERMARK: &str = "/internal/restore/watermark";
pub const PARTNER_RESERVES: &str = "/internal/capital/partner-reserves";

/// `sendBankJobRefuse`: a `BankError` from a job's work is 400 with its own message and code.
pub fn job_refuse(e: &BankError) -> Response {
    reply(400, &e.message, e.row.code)
}

fn unauthenticated() -> Response {
    reply(401, "service credentials required", "bank.unauthenticated")
}

fn not_ported(slice: Slice) -> Response {
    Response {
        status: 500,
        body: Json::obj([(
            "error",
            Json::str(format!(
                "svc-bank in Rust: the {} slice is not ported",
                slice.name()
            )),
        )])
        .compact(),
    }
}

const RUN_DUE_TRANSFERS: &str = "/internal/jobs/run-due-transfers";

/// A thrown error that is no `BankError`: Fastify's 500 with its message.
pub(crate) fn thrown(message: &str) -> Response {
    Response {
        status: 500,
        body: Json::obj([
            ("statusCode", Json::int(500)),
            ("error", Json::str("Internal Server Error")),
            ("message", Json::str(message)),
        ])
        .compact(),
    }
}

/// `POST /internal/jobs/run-due-transfers`: past the signature, 503 `bank.transfers_disabled` when standing orders are
/// off (so the difference between 401 and 503 tells an unsigned caller nothing), else one pass of the owner's batch.
fn run_due_transfers(door: &BankDoor) -> Response {
    let w = &door.transfers;
    if !w.settings.scheduled_transfers {
        return reply(
            503,
            "scheduled transfers are disabled",
            "bank.transfers_disabled",
        );
    }
    #[allow(clippy::cast_precision_loss, reason = "a batch size of at most 10000")]
    let limit = w.settings.batch_size.map(|b| b as f64);
    match door.transfers_deps(|d| {
        crate::transfers::schedules::run_due(
            d,
            limit,
            crate::transfers::calendar::MAX_CATCH_UP_PER_PASS,
        )
    }) {
        Ok(report) => Response {
            status: 200,
            body: report.json().compact(),
        },
        Err(crate::errors::Refusal::Bank(e)) => job_refuse(&e),
        Err(crate::errors::Refusal::Trpc(e)) => thrown(&e.message),
        Err(crate::errors::Refusal::Other(m)) => thrown(&m),
    }
}

const ACCRUE_INTEREST: &str = "/internal/jobs/accrue-interest";
const RESUME_PENDING_EARN: &str = "/internal/jobs/resume-pending-earn";

/// A job's work failed as Fastify answers a throw: a `BankError` with its code (Fastify's 500 carries an error's
/// `code`), anything else with its message alone.
pub(crate) fn thrown_refusal(r: crate::errors::Refusal) -> Response {
    match r {
        crate::errors::Refusal::Bank(e) => {
            fastify_error(500, e.row.code, "Internal Server Error", &e.message)
        }
        crate::errors::Refusal::Trpc(e) => thrown(&e.message),
        crate::errors::Refusal::Other(m) => thrown(&m),
    }
}

/// `POST /internal/jobs/accrue-interest`: past the signature, 503 `bank.interest_accrual_disabled` when the owner
/// turned accrual off, else today's accrual for every pool (`accrueAll`), its rows without `paid`.
fn accrue_interest(door: &BankDoor) -> Response {
    if !door.earn.interest_accrual {
        // Same code string as ops.accrueInterest: alerts key on one name.
        return reply(
            503,
            "interest accrual is disabled",
            "bank.interest_accrual_disabled",
        );
    }
    let now = door.now();
    match door.earn_deps(now, |d| crate::earn::service::accrue_all(d, now)) {
        Ok(report) => Response {
            status: 200,
            body: report.json(false).compact(),
        },
        Err(r) => thrown_refusal(r),
    }
}

/// `bodyLimit`: the body's `limit` when it is a number, else none.
pub(crate) fn body_limit(body: &Value) -> Option<f64> {
    body.get("limit").as_number()
}

/// `POST /internal/jobs/resume-pending-earn`: the body's batch (blank refuses, never 100), then one pass; a `BankError`
/// is `sendBankJobRefuse`'s 400.
fn resume_pending_earn(door: &BankDoor, body: &Value) -> Response {
    let now = door.now();
    match door.earn_deps(now, |d| {
        crate::earn::service::resume_pending(d, body_limit(body))
    }) {
        Ok(rows) => Response {
            status: 200,
            body: Json::Array(
                rows.iter()
                    .map(crate::earn::service::Resumed::json)
                    .collect(),
            )
            .compact(),
        },
        Err(crate::errors::Refusal::Bank(e)) => job_refuse(&e),
        Err(r) => thrown_refusal(r),
    }
}

const CARD_SHIPMENT: &str = "/internal/jobs/card-sim/shipment";

/// `POST /internal/jobs/card-sim/shipment`: the stand-in printer's word (`cardShipmentJobBody`, strict), then
/// `recordShipment`; a body not in shape is 400 `bank.validation_failed`, a `BankError` `sendBankJobRefuse`'s 400.
fn card_shipment(door: &BankDoor, body: &Value) -> Response {
    let Some(shipment) = crate::cards::orders::shipment_body(body) else {
        return reply(400, "body not in shape", "bank.validation_failed");
    };
    match door.cards_deps(door.now(), |d| {
        crate::cards::orders::record_shipment(d, &shipment)
    }) {
        Ok(delivery) => Response {
            status: 200,
            body: delivery.compact(),
        },
        Err(crate::errors::Refusal::Bank(e)) => job_refuse(&e),
        Err(r) => thrown_refusal(r),
    }
}

const ACCRUE_LOAN_INTEREST: &str = "/internal/jobs/accrue-loan-interest";
const RUN_RISK_SWEEP: &str = "/internal/jobs/run-risk-sweep";
const RESUME_PENDING_LOANS: &str = "/internal/jobs/resume-pending-loans";
const RECOVER_LOAN_REPAYMENTS: &str = "/internal/jobs/recover-loan-repayments";

pub(crate) fn ok(body: &Json) -> Response {
    Response {
        status: 200,
        body: body.compact(),
    }
}

/// A job's work that `sendBankJobRefuse` wraps: a `BankError` is its 400, anything else Fastify's 500.
pub(crate) fn job_failed(r: crate::errors::Refusal) -> Response {
    match r {
        crate::errors::Refusal::Bank(e) => job_refuse(&e),
        r => thrown_refusal(r),
    }
}

/// The loans slice's four job doors (`index.ts`), past the signature.
fn loan_job(door: &BankDoor, path: &str, body: &Value) -> Response {
    let now = door.now();
    let w = &door.loans.settings;
    match path {
        ACCRUE_LOAN_INTEREST => {
            if !w.accrual_enabled {
                return reply(
                    503,
                    "loan interest accrual is disabled",
                    "bank.loan_accrual_disabled",
                );
            }
            // Every row without `charged`.
            match door.loans_deps(now, |d| {
                crate::loans::service::accrue_all(d, now, body_limit(body))
            }) {
                Ok(report) => ok(&Json::obj([
                    (
                        "results",
                        Json::Array(
                            report
                                .results
                                .iter()
                                .map(|r| {
                                    Json::obj([
                                        ("loanId", Json::str(r.loan_id.clone())),
                                        (
                                            "days",
                                            Json::int(i64::try_from(r.days).unwrap_or(i64::MAX)),
                                        ),
                                    ])
                                })
                                .collect(),
                        ),
                    ),
                    (
                        "failures",
                        Json::Array(
                            report
                                .failures
                                .iter()
                                .map(|x| {
                                    let mut f = vec![
                                        ("loanId".to_owned(), Json::str(x.loan_id.clone())),
                                        ("reason".to_owned(), Json::str(x.reason.clone())),
                                    ];
                                    if let Some(c) = &x.code {
                                        f.push(("code".to_owned(), Json::str(c.clone())));
                                    }
                                    Json::Object(f)
                                })
                                .collect(),
                        ),
                    ),
                ])),
                Err(r) => job_failed(r),
            }
        }
        RUN_RISK_SWEEP => {
            if !w.risk_sweep_enabled {
                // Same code string as ops.runRiskSweep: alerts key on one name.
                return reply(
                    503,
                    "the loan risk sweep is disabled",
                    "bank.loan_risk_sweep_disabled",
                );
            }
            // Not wrapped: a throw is Fastify's own 500.
            match door.loans_deps(now, |d| {
                crate::loans::sweep::run_risk_sweep(d, now, w.sweep_batch)
            }) {
                Ok(s) => ok(&s.json()),
                Err(r) => thrown_refusal(r),
            }
        }
        RESUME_PENDING_LOANS => match door.loans_deps(now, |d| {
            crate::loans::service::resume_pending(d, body_limit(body))
        }) {
            Ok(rows) => ok(&Json::Array(
                rows.iter()
                    .map(crate::loans::service::Resumed::json)
                    .collect(),
            )),
            Err(r) => job_failed(r),
        },
        RECOVER_LOAN_REPAYMENTS => match door.loans_deps(now, |d| {
            crate::loans::service::recover_repayments(d, body_limit(body))
        }) {
            Ok(rows) => ok(&Json::Array(
                rows.iter()
                    .map(crate::loans::service::Resumed::json)
                    .collect(),
            )),
            Err(r) => job_failed(r),
        },
        _ => not_ported(Slice::Loans),
    }
}

/// `requireService`: the signing service, when it may call a job door (`jobCaller`: never svc-edge).
fn job_caller(door: &BankDoor, req: &Request<'_>) -> Option<String> {
    door.service(req, BodyBind::Require)
        .filter(|s| s != "svc-edge")
}

/// The job door or svc-ops read a request is for, answered; `None` when it is for none of them.
pub fn answer(door: &BankDoor, req: &Request<'_>) -> Option<Response> {
    if req.method != "POST" {
        return None;
    }
    let path = req.url.split_once('?').map_or(req.url, |(p, _)| p);
    let ops_read = path == RESTORE_WATERMARK || path == PARTNER_RESERVES;
    let job = JOB_DOORS.iter().find(|d| d.path == path);
    if !ops_read && job.is_none() {
        return None;
    }
    let body = match read_body(req) {
        Ok(b) => b,
        Err(res) => return Some(res),
    };
    let Some(caller) = job_caller(door, req) else {
        return Some(unauthenticated());
    };
    if let Some(j) = job {
        if j.path == RUN_DUE_TRANSFERS {
            return Some(run_due_transfers(door));
        }
        if j.path == ACCRUE_INTEREST {
            return Some(accrue_interest(door));
        }
        if j.path == RESUME_PENDING_EARN {
            return Some(resume_pending_earn(door, &body));
        }
        if j.path == CARD_SHIPMENT {
            return Some(card_shipment(door, &body));
        }
        if j.slice == Slice::Loans {
            return Some(loan_job(door, j.path, &body));
        }
        if j.slice == Slice::Ramps {
            return Some(crate::ramps::onramp::job(door, j.path, &body));
        }
        if j.slice == Slice::Automations {
            return Some(
                door.automations_deps(door.now(), |d| {
                    crate::automations::router::job(d, j.path, &body)
                })
                .unwrap_or_else(|| not_ported(Slice::Automations)),
            );
        }
        if j.slice == Slice::Bills {
            return Some(
                door.bills_deps(door.now(), |d| crate::bills::router::job(d, j.path, &body))
                    .unwrap_or_else(|| not_ported(Slice::Bills)),
            );
        }
        return Some(not_ported(j.slice));
    }
    if caller != "svc-ops" {
        return Some(reply(403, "caller not allowed", "bank.caller_forbidden"));
    }
    if path == PARTNER_RESERVES {
        return Some(crate::card_ops_desk::reserves::door(door));
    }
    Some(
        match restore_watermark::read(door.store(), door.now(), BANK_SCHEMA) {
            Ok(read) => Response {
                status: 200,
                body: read.compact(),
            },
            // A thrown read is Fastify's 500: its message the database's, and its SQLSTATE when the server sent one.
            Err(e) => match e.code.as_deref() {
                Some(code) => fastify_error(500, code, "Internal Server Error", &e.message),
                None => Response {
                    status: 500,
                    body: Json::obj([
                        ("statusCode", Json::int(500)),
                        ("error", Json::str("Internal Server Error")),
                        ("message", Json::str(e.message)),
                    ])
                    .compact(),
                },
            },
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_job_route_is_named_once() {
        let mut paths: Vec<&str> = JOB_DOORS.iter().map(|d| d.path).collect();
        paths.sort_unstable();
        paths.dedup();
        assert_eq!(paths.len(), JOB_DOORS.len());
    }

    /// While the TypeScript service runs, the table is its `index.ts`'s job routes, in its order.
    #[test]
    fn the_table_is_the_job_routes_index_ts_registers() {
        let index = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../services/svc-bank/src/index.ts");
        let Ok(text) = std::fs::read_to_string(index) else {
            return;
        };
        let mut theirs = Vec::new();
        let mut rest = text.as_str();
        while let Some(at) = rest.find("'/internal/") {
            let after = &rest[at + 1..];
            let end = after.find('\'').unwrap_or(after.len());
            theirs.push(&after[..end]);
            rest = &after[end..];
        }
        let jobs: Vec<&str> = theirs
            .iter()
            .copied()
            .filter(|p| p.starts_with("/internal/jobs/"))
            .collect();
        let ours: Vec<&str> = JOB_DOORS.iter().map(|d| d.path).collect();
        assert_eq!(ours, jobs);
        assert!(theirs.contains(&RESTORE_WATERMARK));
        assert!(theirs.contains(&PARTNER_RESERVES));
    }
}
