//! `navigator/onchain-routes.ts`, `onchain.ts` and `onchain-trade.ts`: `navigator.onchain.*`, `navigator.ask`,
//! `navigator.orders` and `navigator.trading`. The person is the signed principal, never the body; every row read or
//! written is theirs. This service holds no key, moves no value and touches no ledger: it records what the person
//! prepared, reads the key's state from the chain, and hands the one session call a trade needs to the Navigator's
//! signer.
//!
//! - [`abi`]: the selectors, the event topic and the two calls it builds.
//! - [`rules`]: the chain, the cap, the grant, and how an ask is read.
//! - [`store`]: the bindings and the orders.
//! - [`ports`]: the chain, the signer, identity's linked wallets and freeze, the market.
//! - [`trade`]: the live key, the trading view and a trade.

pub mod abi;
pub mod ports;
pub mod rules;
pub mod store;
pub mod trade;

use service_kit::json::Json;
use service_kit::pg::Pool;
use service_kit::schema::Value;
use service_kit::trpc::TrpcError;

use crate::db::Store;
use crate::door::Ctx;
use crate::runtime::{self, RunError, Runtime};

use super::run::NAVIGATOR_AGENT_ID;
use ports::{Chain, Freeze, LinkedWallets, Market, SelfFreeze, Sender};
use rules::Refused;
use store::{BindInput, RevokeError};
use trade::{Fail, TradeInput};

/// The calls this module answers.
pub const CALLS: [&str; 7] = [
    "navigator.onchain.signer",
    "navigator.onchain.bind",
    "navigator.onchain.revoke",
    "navigator.onchain.binding",
    "navigator.ask",
    "navigator.orders",
    "navigator.trading",
];

/// `NavigatorOnchainDeps`, less the database (the door's store) and the session read (the runtime's).
#[derive(Default)]
pub struct OnchainDeps {
    /// `AGENTS_NAVIGATOR_ONCHAIN_SIGNER`: the signer's public address. None refuses `rail.crypto`.
    pub signer: Option<String>,
    /// `AGENTS_NAVIGATOR_ONCHAIN_SENDER_URL`'s signer. None refuses a trade `rail.crypto`.
    pub sender: Option<Box<dyn Sender>>,
    /// `AGENTS_NAVIGATOR_ONCHAIN_MARKET`. None refuses a trade `agents.navigator_market_unset`.
    pub market: Option<Market>,
    /// The chain reads, on `AGENTS_NAVIGATOR_ONCHAIN_RPC_URL`. None refuses a trade `agents.navigator_market_unset`.
    pub chain: Option<Box<dyn Chain>>,
    /// Identity's linked wallets of a person. None refuses a trade `agents.navigator_account_unproven`.
    pub linked_wallets: Option<Box<dyn LinkedWallets>>,
    /// Identity's read of the owner's own freeze. None refuses a binding and a trade as unread.
    pub self_freeze: Option<Box<dyn SelfFreeze>>,
}

impl OnchainDeps {
    /// Nothing configured.
    pub fn unwired() -> OnchainDeps {
        OnchainDeps::default()
    }
}

/// The refusal's code is the error's message; the cause carries the code.
fn refused(r: &Refused) -> RunError {
    RunError::Trpc(TrpcError::caused(rules::http_code(r.0), r.0, r.0))
}

fn failed(f: Fail) -> RunError {
    match f {
        Fail::No(r) => refused(&r),
        Fail::Run(e) => e,
    }
}

/// `storeOf`: no database refuses `agents.capability_unavailable`.
fn store_of(store: &Store) -> Result<&Pool, RunError> {
    store.pool().map_err(|_| {
        RunError::Trpc(TrpcError::plain(
            "PRECONDITION_FAILED",
            "agents.capability_unavailable",
        ))
    })
}

pub const OWNER_FROZEN_SELF: &str = "agents.identity.owner_frozen_self";
pub const OWNER_FREEZE_UNREAD: &str = "agents.identity.owner_freeze_unread";

/// `selfFreezeGate`: FORBIDDEN while the person's own freeze is on, and when it cannot be read.
fn self_freeze_gate(user_id: &str, freeze: Option<&dyn SelfFreeze>) -> Result<(), RunError> {
    let forbid = |code: &str| RunError::Trpc(TrpcError::caused("FORBIDDEN", code, code));
    match freeze.map(|f| f.read(user_id)) {
        Some(Ok(Freeze::Open)) => Ok(()),
        Some(Ok(Freeze::Frozen { .. })) => Err(forbid(OWNER_FROZEN_SELF)),
        None | Some(Err(_)) => Err(forbid(OWNER_FREEZE_UNREAD)),
    }
}

/// The person's own Navigator session; another person's, another agent's or none read the same: not found.
fn navigator_session(
    pool: &Pool,
    session_id: &str,
    user_id: &str,
) -> Result<runtime::SessionRecord, RunError> {
    match runtime::session(pool, session_id)? {
        Some(s) if s.user_id == user_id && s.agent_id == NAVIGATOR_AGENT_ID => Ok(s),
        _ => Err(RunError::Trpc(TrpcError::plain(
            "NOT_FOUND",
            "agents.refused.session_closed",
        ))),
    }
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).as_str().unwrap_or("")
}

/// A number the schema checked as an integer.
fn int(v: &Value, key: &str) -> Option<i64> {
    v.get(key)
        .as_number()
        .filter(|n| n.fract() == 0.0)
        .map(|n| {
            #[allow(
                clippy::cast_possible_truncation,
                reason = "an integer the schema checked"
            )]
            let n = n as i64;
            n
        })
}

fn texts(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .as_array()
        .unwrap_or_default()
        .iter()
        .map(|s| s.as_str().unwrap_or("").to_owned())
        .collect()
}

/// Answers one of [`CALLS`].
pub fn handle(ctx: &Ctx<'_>, store: &Store, rt: &Runtime) -> Result<Json, RunError> {
    let deps = &rt.navigator.onchain;
    let input = &ctx.input;
    let user = ctx.principal.map_or("", |p| p.user_id.as_str());
    let chain_id = int(input, "chainId").unwrap_or(0);
    let signer =
        || rules::navigator_signer(chain_id, deps.signer.as_deref()).map_err(|r| refused(&r));
    match ctx.call.path {
        "navigator.onchain.signer" => {
            let s = signer()?;
            let lower = |a: &str| Json::str(a.to_lowercase());
            Ok(Json::obj([
                ("signer", Json::str(s)),
                ("chainId", Json::int(chain_id)),
                ("network", Json::str("testnet")),
                (
                    "pools",
                    Json::Array(
                        deps.market
                            .as_ref()
                            .map_or_else(Vec::new, |m| m.pools.iter().map(|p| lower(p)).collect()),
                    ),
                ),
                (
                    "router",
                    deps.market
                        .as_ref()
                        .map_or(Json::Null, |m| lower(&m.router)),
                ),
            ]))
        }
        "navigator.onchain.bind" => {
            let s = signer()?;
            self_freeze_gate(user, deps.self_freeze.as_deref())?;
            let selectors = texts(input, "selectors");
            let (cap, until) = rules::prepared_grant(
                input.get("spendLimitWei").as_str(),
                int(input, "validUntil"),
                &selectors,
            )
            .map_err(|r| refused(&r))?;
            let pool = store_of(store)?;
            let b = store::bind(
                pool,
                &BindInput {
                    user_id: user,
                    chain_id,
                    account: text(input, "account"),
                    session_key: &s,
                    spend_limit_wei: cap,
                    valid_until: until,
                    targets: &texts(input, "targets"),
                    selectors: &selectors,
                    spec_hash: text(input, "specHash"),
                },
            )?;
            Ok(b.to_json())
        }
        "navigator.onchain.revoke" => {
            let s = signer()?;
            let pool = store_of(store)?;
            match store::request_revoke(pool, user, chain_id, text(input, "account"), &s) {
                Ok(b) => Ok(b.to_json()),
                Err(RevokeError::Refused(r)) => Err(refused(&r)),
                Err(RevokeError::Store(e)) => Err(RunError::Store(e)),
            }
        }
        "navigator.onchain.binding" => {
            let s = signer()?;
            let pool = store_of(store)?;
            let b = store::binding(pool, user, chain_id, text(input, "account"), &s)?;
            Ok(Json::obj([(
                "binding",
                b.map_or(Json::Null, |b| b.to_json()),
            )]))
        }
        "navigator.ask" => {
            // The store is asked for first: without one there is no session to read either.
            let pool = store_of(store)?;
            let session_id = text(input, "sessionId");
            let session = navigator_session(pool, session_id, user)?;
            if session.status != "open" {
                return Err(RunError::Trpc(TrpcError::plain(
                    "BAD_REQUEST",
                    "agents.refused.session_closed",
                )));
            }
            let asked = text(input, "text");
            if !rules::ask_is_trade(asked) && !rules::ask_moves_money_out(asked) {
                return Ok(Json::obj([("kind", Json::str("none"))]));
            }
            // An order the Navigator would place for the person waits for the lift of their own freeze.
            self_freeze_gate(user, deps.self_freeze.as_deref())?;
            let order = trade::trade(
                deps,
                pool,
                &TradeInput {
                    user_id: user,
                    session_id,
                    request_id: text(input, "requestId"),
                    text: asked,
                },
            )
            .map_err(failed)?;
            Ok(Json::obj([
                ("kind", Json::str("order")),
                ("order", order.to_json()),
            ]))
        }
        "navigator.orders" => {
            let pool = store_of(store)?;
            let session_id = text(input, "sessionId");
            navigator_session(pool, session_id, user)?;
            let orders = store::orders(pool, user, session_id)?;
            Ok(Json::obj([(
                "orders",
                Json::Array(orders.iter().map(store::Order::to_json).collect()),
            )]))
        }
        "navigator.trading" => {
            let pool = store_of(store)?;
            trade::trading(deps, pool, user)
        }
        other => Err(RunError::Other(format!(
            "{other} is not a navigator on-chain call"
        ))),
    }
}
