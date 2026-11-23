//! The business slice (`PORT.md`): a company account with its team and dual control (`business/business-service.ts`,
//! `business-policy.ts`, `router/business.router.ts`, the operator's queue `ops/business-approvals.ts` and svc-agents'
//! team read `agents/team-membership.ts`).
//!
//! - [`policy`]: the roles, what each may do, the separation of duties and the public policy board;
//! - [`service`]: accounts, members, transfers under and over the spend threshold, the checker's decision, payroll,
//!   account controls that need a second administrator, the history and the operator's queue;
//! - [`router`]: the calls; [`team`]: `POST /internal/agents/team-membership`.
//!
//! Money moves only through svc-ledger's recipe door: an under-threshold transfer is the transfers slice's own move
//! (`bankTransfer`, key space `own`, keyed by the client's id), an over-threshold one is held
//! (`businessApprovalHold`, `bank.business.hold:<id>`) until a different checker settles it
//! (`businessApprovalSettle`, `bank.business.settle:<id>`) or it is rejected or cancelled
//! (`businessApprovalRelease`, `bank.business.release:<id>`), and a payroll is one post
//! (`businessPayroll`, `bank.business.payroll:<id>`). With the custodial layer off (`LEDGER_CUSTODY_LAYER`, the launch
//! decision) each refuses `bank.no_partner_bank` before svc-ledger is asked, as `custodyGuardedLedger` does.

pub mod policy;
pub mod router;
pub mod service;
pub mod team;
