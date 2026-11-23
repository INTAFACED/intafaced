//! The business-team slice (`PORT.md`): a business bank team and its approval rules (J-bank-19;
//! `business/business-team.ts`, `router/business-team.router.ts`).
//!
//! - [`service`]: roles, advisors, invites, approval rules, payments, departments and team spend;
//! - [`router`]: the calls, with their step-up bindings on the transfers slice's gate.
//!
//! The business's money is the partner bank's: a payment is one instruction to the partner, sent once under
//! `bank.business.payment:<id>`, through the guarded partner (the operator's stop, then svc-ledger's posting freeze).
//! svc-ledger posts nothing for any of it.

pub mod router;
pub mod service;
