//! Slice `partner-account`: the person's account at the partner bank and the money that comes in and goes out of it
//! (`PORT.md`): account details and the eligibility statement, linked bank accounts, cash-outs and their partner's
//! job doors, deposit addresses, salary paid in by direct deposit, the bank account's onboarding and closing,
//! recovery claims, and svc-identity's closure check.
//!
//! Each part is its own module, built once from the environment ([`Wiring`]) and handed what the door holds
//! ([`Deps`]).

pub mod account_details;
pub mod bank_account;
pub mod cash_out;
pub mod closure;
pub mod deposits;
pub mod linked_accounts;
pub mod rail_records;
pub mod recovery;
pub mod salary;

use std::collections::BTreeMap;

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::server::Response;
use service_kit::time::Instant;
use service_kit::trpc::TrpcError;

use crate::db::Store;
use crate::door::{Ctx, Slice};
use crate::errors::to_trpc;

/// What the slice holds, built once at start-up from the environment.
pub struct Wiring {
    pub account_details: account_details::Wiring,
    pub salary: salary::Wiring,
    pub linked_accounts: linked_accounts::Wiring,
    pub cash_out: cash_out::Wiring,
    pub deposits: deposits::Wiring,
    pub recovery: recovery::Wiring,
    pub bank_account: bank_account::Wiring,
    pub closure: closure::Wiring,
}

impl Wiring {
    /// Each part from the process environment, refusing to start as the TypeScript does.
    pub fn from_env(env: &BTreeMap<String, String>) -> Result<Wiring, String> {
        Ok(Wiring {
            account_details: account_details::Wiring::from_env(env)?,
            salary: salary::Wiring::from_env(env)?,
            linked_accounts: linked_accounts::Wiring::from_env(env)?,
            cash_out: cash_out::Wiring::from_env(env)?,
            deposits: deposits::Wiring::from_env(env)?,
            recovery: recovery::Wiring::from_env(env)?,
            bank_account: bank_account::Wiring::from_env(env)?,
            closure: closure::Wiring::from_env(env)?,
        })
    }
}

/// What every part reads: the store, slice `partner`'s TEST partner and freeze, this slice's own wiring, the clock.
pub struct Deps<'a> {
    pub store: &'a Store,
    pub partner: &'a crate::partner::router::Wiring,
    pub wiring: &'a Wiring,
    pub now: Instant,
}

fn fresh_reference() -> String {
    service_kit::approvals::random_uuid().unwrap_or_default()
}

/// The answer of one of the slice's calls; `None` for a call outside it.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Option<Json>, TrpcError>> {
    if ctx.call.slice != Slice::PartnerAccount {
        return None;
    }
    let out = account_details::answer(d, ctx)
        .or_else(|| salary::answer(d, ctx))
        .or_else(|| linked_accounts::answer(d, ctx))
        .or_else(|| cash_out::answer(d, ctx))
        .or_else(|| deposits::answer(d, ctx))
        .or_else(|| recovery::answer(d, ctx))
        .or_else(|| bank_account::answer(d, ctx))?;
    Some(out.map(Some).map_err(|r| to_trpc(r, fresh_reference)))
}

/// A job door of the slice past its signature; "not ported" for one no part answers yet.
pub fn job(d: &Deps<'_>, path: &str, body: &Value) -> Response {
    salary::job(d, path, body)
        .or_else(|| cash_out::job(d, path, body))
        .unwrap_or_else(|| crate::door::jobs::not_ported(Slice::PartnerAccount))
}

/// `POST /internal/closure-check` past its door checks, with its body already held to `parseClosureCheckBody`.
pub fn closure_check(d: &Deps<'_>, body: &Value) -> Response {
    closure::job(d, "/internal/closure-check", body)
        .unwrap_or_else(|| crate::door::jobs::not_ported(Slice::PartnerAccount))
}

/// A refusal the TypeScript throws as `BankError`, by its declared code.
pub use crate::partner::refuse;
