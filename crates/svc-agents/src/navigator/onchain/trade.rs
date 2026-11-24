//! `onchain-trade.ts`: the Navigator trading through the session key the person signed. Inside the cap it does not
//! ask; above it the trade is refused before anything is signed; and it never moves money out. This service holds no
//! key: it builds the one session call and hands it to the Navigator's signer.

use service_kit::json::Json;
use service_kit::pg::Pool;

use crate::db::StoreError;
use crate::runtime::RunError;

use super::OnchainDeps;
use super::abi::{self, Spec};
use super::ports::{Chain, LiveGrant, Market, Mined, SendError, SessionCall, Token};
use super::rules::{
    self, ACCOUNT_NOT_YOURS, ACCOUNT_UNPROVEN, MARKET_UNSET, MONEY_OUT_FORBIDDEN, NO_LIVE_KEY,
    RAIL_CRYPTO, REQUEST_ID_REPLAY, Refused, TEST_CHAIN_ID, TRADE_CAP_UNIT, TRADE_OUT_OF_SCOPE,
    TRADE_OVER_CAP, TRADE_UNPARSED, TRADE_UNQUOTED, Units,
};
use super::store::{self, Binding, Order, ReserveInput, Reserved};

/// A refusal by name, or anything else, which the call answers as the TypeScript's thrown error.
#[derive(Debug)]
pub enum Fail {
    No(Refused),
    Run(RunError),
}

impl From<StoreError> for Fail {
    fn from(e: StoreError) -> Fail {
        Fail::Run(RunError::Store(e))
    }
}

fn no(code: &'static str) -> Fail {
    Fail::No(Refused(code))
}

fn chain_failed(e: String) -> Fail {
    Fail::Run(RunError::Other(e))
}

/// The person's live key and what it was read from.
struct Key<'a> {
    binding: Binding,
    grant: LiveGrant,
    chain: &'a dyn Chain,
    market: &'a Market,
    signer: &'a str,
}

/// `liveKey`: the newest binding not asked to be revoked, the same grant live on the chain, on an account a wallet
/// linked to the person owns.
fn live_key<'a>(
    deps: &'a OnchainDeps,
    pool: &Pool,
    user_id: &str,
) -> Result<Option<Key<'a>>, Fail> {
    let Some(signer) = deps.signer.as_deref() else {
        return Err(no(RAIL_CRYPTO));
    };
    let (Some(chain), Some(market)) = (deps.chain.as_deref(), deps.market.as_ref()) else {
        return Err(no(MARKET_UNSET));
    };
    let Some(binding) = store::live_binding(pool, user_id, TEST_CHAIN_ID, signer)? else {
        return Ok(None);
    };
    let Some(grant) = chain
        .grant(&binding.account, signer)
        .map_err(chain_failed)?
    else {
        return Ok(None);
    };
    if !grant.live || grant.spec_hash.to_lowercase() != binding.spec_hash.to_lowercase() {
        return Ok(None);
    }
    let Some(wallets) = deps.linked_wallets.as_deref() else {
        return Err(no(ACCOUNT_UNPROVEN));
    };
    let owner = chain.owner(&binding.account).map_err(chain_failed)?;
    let Some(super::ports::Linked::Usable(linked)) = wallets.read(user_id) else {
        return Err(no(ACCOUNT_UNPROVEN));
    };
    if !linked
        .iter()
        .any(|w| w.address.to_lowercase() == owner.to_lowercase())
    {
        return Err(no(ACCOUNT_NOT_YOURS));
    }
    Ok(Some(Key {
        binding,
        grant,
        chain,
        market,
        signer,
    }))
}

/// `navigatorTrading`: the cap the person signed and what the Navigator's orders hold against it; a refusal by name
/// reads as no key.
pub fn trading(deps: &OnchainDeps, pool: &Pool, user_id: &str) -> Result<Json, RunError> {
    let none = || Json::obj([("key", Json::Null)]);
    let key = match live_key(deps, pool, user_id) {
        Ok(Some(k)) => k,
        Ok(None) | Err(Fail::No(_)) => return Ok(none()),
        Err(Fail::Run(e)) => return Err(e),
    };
    let held = store::held_wei(
        pool,
        TEST_CHAIN_ID,
        &key.binding.account,
        &key.grant.spec_hash,
    )?;
    let spent = held.saturating_add(key.grant.spent_wei);
    let cap = key.grant.spend_limit_wei;
    let left = cap.saturating_sub(spent);
    let valid_until = i64::try_from(key.grant.valid_until).unwrap_or(i64::MAX);
    Ok(Json::obj([(
        "key",
        Json::obj([
            ("chainId", Json::int(TEST_CHAIN_ID)),
            ("account", Json::str(key.binding.account.clone())),
            ("capWei", Json::str(cap.to_string())),
            // A sum past uint128 is past any cap; the TypeScript's bigint prints it whole, which no key can reach.
            ("spentWei", Json::str(spent.to_string())),
            ("leftWei", Json::str(left.to_string())),
            ("validUntil", Json::int(valid_until)),
        ]),
    )]))
}

fn same_token(words: &str, t: &Token) -> bool {
    let w = words.to_lowercase();
    t.symbol.to_lowercase() == w || t.name.to_lowercase() == w
}

/// One trade ask.
pub struct TradeInput<'a> {
    pub user_id: &'a str,
    pub session_id: &'a str,
    pub request_id: &'a str,
    pub text: &'a str,
}

fn over_cap(parts: [u128; 3], cap: u128) -> bool {
    parts
        .iter()
        .try_fold(0u128, |sum, n| sum.checked_add(*n))
        .is_none_or(|total| total > cap)
}

/// `navigatorTrade`: refused by name before anything is signed, or recorded under its business key and sent once.
pub fn trade(deps: &OnchainDeps, pool: &Pool, input: &TradeInput<'_>) -> Result<Order, Fail> {
    if rules::ask_moves_money_out(input.text) {
        return Err(no(MONEY_OUT_FORBIDDEN));
    }
    let order_key = format!(
        "agents:navigator:order:{}:{}",
        input.session_id, input.request_id
    );
    // The same request id is the same order, whatever the cap now says: it was sent once.
    if let Some(earlier) = store::order(pool, input.user_id, &order_key)? {
        if earlier.text != input.text {
            return Err(no(REQUEST_ID_REPLAY));
        }
        return Ok(earlier);
    }
    let Some(sender) = deps.sender.as_deref() else {
        return Err(no(RAIL_CRYPTO));
    };
    let Some(Key {
        binding,
        grant,
        chain,
        market,
        signer,
    }) = live_key(deps, pool, input.user_id)?
    else {
        return Err(no(NO_LIVE_KEY));
    };
    let Some(ask) = rules::parse_trade_ask(input.text) else {
        return Err(no(TRADE_UNPARSED));
    };
    let router = market.router.to_lowercase();
    if !grant.targets.contains(&router) || !grant.selectors.iter().any(|s| s == abi::SWAP_EXACT_IN)
    {
        return Err(no(TRADE_OUT_OF_SCOPE));
    }
    let pools = market
        .pools
        .iter()
        .filter(|p| grant.targets.contains(&p.to_lowercase()))
        .map(|p| chain.pool(p))
        .collect::<Result<Vec<_>, _>>()
        .map_err(chain_failed)?;
    let matched = pools.iter().find_map(|p| {
        let token_in = p.tokens.iter().find(|t| same_token(&ask.token_in, t))?;
        let token_out = p.tokens.iter().find(|t| same_token(&ask.token_out, t))?;
        (token_in.address != token_out.address).then_some((p, token_in, token_out))
    });
    let Some((pool_tokens, token_in, token_out)) = matched else {
        // A pair the market has, but outside the granted targets, is out of scope; a pair it never has is not a trade.
        return Err(no(if market.pools.len() > pools.len() {
            TRADE_OUT_OF_SCOPE
        } else {
            TRADE_UNPARSED
        }));
    };
    if token_in.address != market.spend_token.to_lowercase() {
        return Err(no(TRADE_CAP_UNIT));
    }
    let amount_in = match rules::to_units(&ask.amount, token_in.decimals) {
        Units::Exact(n) if n > 0 => n,
        Units::PastCap => return Err(no(TRADE_OVER_CAP)),
        Units::Exact(_) | Units::Invalid => return Err(no(TRADE_UNPARSED)),
    };

    // Above what is left of the cap: refused before a quote is asked for or anything is built or signed.
    let held_before = store::held_wei(pool, TEST_CHAIN_ID, &binding.account, &grant.spec_hash)?;
    if over_cap(
        [held_before, grant.spent_wei, amount_in],
        grant.spend_limit_wei,
    ) {
        return Err(no(TRADE_OVER_CAP));
    }
    let quoted = chain
        .quote(&router, &pool_tokens.pool, &token_in.address, amount_in)
        .map_err(chain_failed)?;
    let min_out = rules::min_out(quoted, market.slippage_bps);
    if min_out == 0 {
        return Err(no(TRADE_UNQUOTED));
    }

    // The cap is checked again under the grant's lock as the order is written, so two asks at once cannot both fit.
    let reserved = store::reserve_order(
        pool,
        &ReserveInput {
            user_id: input.user_id,
            session_id: input.session_id,
            order_key: &order_key,
            text: input.text,
            chain_id: TEST_CHAIN_ID,
            account: &binding.account,
            session_key: signer,
            spec_hash: &grant.spec_hash,
            pool: &pool_tokens.pool,
            token_in: &token_in.address,
            token_in_symbol: &token_in.symbol,
            token_out: &token_out.address,
            token_out_symbol: &token_out.symbol,
            amount_in_wei: amount_in,
            min_out_wei: min_out,
            cap_wei: grant.spend_limit_wei,
            chain_spent_wei: grant.spent_wei,
        },
    )?;
    match reserved {
        Reserved::OverCap => return Err(no(TRADE_OVER_CAP)),
        Reserved::Existing(o) => {
            if o.text != input.text {
                return Err(no(REQUEST_ID_REPLAY));
            }
            return Ok(o);
        }
        Reserved::Reserved(_) => {}
    }

    let swap = abi::swap_exact_in(
        &pool_tokens.pool,
        &token_in.address,
        amount_in,
        min_out,
        &binding.account,
    );
    let data = abi::execute_with_session(
        &Spec {
            key: signer.to_owned(),
            valid_after: grant.valid_after,
            valid_until: grant.valid_until,
            spend_limit_wei: grant.spend_limit_wei,
            targets: grant.targets.clone(),
            selectors: grant.selectors.clone(),
        },
        &router,
        &swap,
    );
    let sent = sender.send(&SessionCall {
        chain_id: TEST_CHAIN_ID,
        from: signer.to_owned(),
        to: binding.account.clone(),
        data,
    });
    let unchanged = || -> Result<Order, Fail> {
        store::order(pool, input.user_id, &order_key)?
            .ok_or_else(|| Fail::Run(RunError::Other("the reserved order is gone".to_owned())))
    };
    let hash = match sent {
        Ok(h) => h,
        // Only a signer that refused before sending frees the order's part of the cap; any other failure may come
        // after the call was broadcast, so the order stays sending and is never sent again.
        Err(SendError::Refused(_)) => {
            return Ok(store::settle_order(
                pool,
                input.user_id,
                &order_key,
                "failed",
                None,
            )?);
        }
        Err(SendError::Unknown(_)) => return unchanged(),
    };
    store::settle_order(pool, input.user_id, &order_key, "sent", Some(&hash))?;
    match chain.receipt(&hash) {
        None => unchanged(),
        Some(m) => {
            let status = if m == Mined::Success {
                "filled"
            } else {
                "reverted"
            };
            Ok(store::settle_order(
                pool,
                input.user_id,
                &order_key,
                status,
                Some(&hash),
            )?)
        }
    }
}
