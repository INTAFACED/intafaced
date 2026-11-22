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
    job("/internal/jobs/bill-pay/run-due", Slice::Bills),
    job("/internal/jobs/bill-pay/returned", Slice::Bills),
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
fn thrown(message: &str) -> Response {
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
    if let Err(res) = read_body(req) {
        return Some(res);
    }
    let Some(caller) = job_caller(door, req) else {
        return Some(unauthenticated());
    };
    if let Some(j) = job {
        if j.path == RUN_DUE_TRANSFERS {
            return Some(run_due_transfers(door));
        }
        return Some(not_ported(j.slice));
    }
    if caller != "svc-ops" {
        return Some(reply(403, "caller not allowed", "bank.caller_forbidden"));
    }
    if path == PARTNER_RESERVES {
        return Some(not_ported(Slice::CardOps));
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
