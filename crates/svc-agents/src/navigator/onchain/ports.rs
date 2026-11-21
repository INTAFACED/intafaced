//! What the Navigator's on-chain calls read and hand off: the chain (`NavigatorChain`, over JSON-RPC as viem reads it),
//! its signer (`httpNavigatorSender`), the person's linked wallets and their own freeze (svc-identity), and the market
//! it may trade (`AGENTS_NAVIGATOR_ONCHAIN_MARKET`).

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::s2s::CallSigner;
use service_kit::time::zod_datetime;

use super::abi;
use crate::navigator::ports::encode_uri_component;

/// `LiveGrant`: the key as the chain holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveGrant {
    pub live: bool,
    pub spec_hash: String,
    pub valid_after: u64,
    pub valid_until: u64,
    pub spend_limit_wei: u128,
    pub spent_wei: u128,
    pub targets: Vec<String>,
    pub selectors: Vec<String>,
}

/// One token of a pool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub address: String,
    pub symbol: String,
    pub name: String,
    pub decimals: u32,
}

/// `PoolTokens`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolTokens {
    pub pool: String,
    pub tokens: Vec<Token>,
}

/// A receipt's status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mined {
    Success,
    Reverted,
}

/// `NavigatorChain`. An `Err` is a read that failed: the call answers it as the TypeScript's thrown error.
pub trait Chain: Send + Sync {
    fn grant(&self, account: &str, session_key: &str) -> Result<Option<LiveGrant>, String>;
    fn owner(&self, account: &str) -> Result<String, String>;
    fn pool(&self, pool: &str) -> Result<PoolTokens, String>;
    fn quote(&self, router: &str, pool: &str, token_in: &str, amount_in: u128) -> Result<u128, String>;
    /// The receipt's status, or none when it is not mined within the wait.
    fn receipt(&self, hash: &str) -> Option<Mined>;
}

/// Why the signer gave no hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendError {
    /// `NavigatorSignerRefused`: a 4xx, before anything was sent.
    Refused(u16),
    /// Any other failure: the call may have been broadcast.
    Unknown(String),
}

/// The one session call the signer is handed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionCall {
    pub chain_id: i64,
    pub from: String,
    pub to: String,
    pub data: String,
}

/// `NavigatorSender`.
pub trait Sender: Send + Sync {
    fn send(&self, call: &SessionCall) -> Result<String, SendError>;
}

/// `LinkedWallets`, as identity answers it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Linked {
    Usable(Vec<String>),
    AccountInactive,
}

/// `LinkedWalletsPort`: none when identity could not be asked or read.
pub trait LinkedWallets: Send + Sync {
    fn read(&self, user_id: &str) -> Option<Linked>;
}

/// `SelfFreezeReading`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Freeze {
    Open,
    Frozen { since: Option<String> },
}

/// `OwnSelfFreezeRead`: an `Err` is `SelfFreezeUnavailable`.
pub trait SelfFreeze: Send + Sync {
    fn read(&self, user_id: &str) -> Result<Freeze, String>;
}

/// `NavigatorMarket`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Market {
    pub router: String,
    pub spend_token: String,
    pub pools: Vec<String>,
    pub slippage_bps: u32,
}

fn is_address(s: &str) -> bool {
    s.len() == 42 && s.starts_with("0x") && s.bytes().skip(2).all(|b| b.is_ascii_hexdigit())
}

/// `navigatorMarketSchema.parse(JSON.parse(raw))`: a bad value stops the boot.
pub fn parse_market(raw: &str) -> Result<Market, String> {
    let bad = |why: &str| format!("AGENTS_NAVIGATOR_ONCHAIN_MARKET: {why}");
    let v = json::parse(raw).map_err(|e| bad(&e.message))?;
    let address = |k: &str| match v.get(k) {
        Some(Json::String(s)) if is_address(s) => Ok(s.clone()),
        _ => Err(bad(&format!("{k} must be a 0x address"))),
    };
    let router = address("router")?;
    let spend_token = address("spendToken")?;
    let pools = match v.get("pools") {
        Some(Json::Array(items)) if (1..=16).contains(&items.len()) => items
            .iter()
            .map(|p| match p {
                Json::String(s) if is_address(s) => Ok(s.clone()),
                _ => Err(bad("each pool must be a 0x address")),
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err(bad("pools must list 1 to 16 addresses")),
    };
    let slippage_bps = match v.get("slippageBps") {
        Some(Json::Number(n)) if n.fract() == 0.0 && (1.0..=5_000.0).contains(n) => {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "an integer from 1 to 5000")]
            let n = *n as u32;
            n
        }
        _ => return Err(bad("slippageBps must be an integer from 1 to 5000")),
    };
    Ok(Market {
        router,
        spend_token,
        pools,
        slippage_bps,
    })
}

/// The chain over JSON-RPC (`viemNavigatorChain`): ten seconds a request, thirty for a receipt.
pub struct RpcChain {
    pub url: String,
    pub fetch: Arc<dyn Fetch>,
    pub receipt_timeout_ms: u64,
    pub poll_ms: u64,
    id: AtomicU64,
}

impl RpcChain {
    pub fn new(url: &str, fetch: Arc<dyn Fetch>) -> RpcChain {
        RpcChain {
            url: url.to_owned(),
            fetch,
            receipt_timeout_ms: 30_000,
            poll_ms: 4_000,
            id: AtomicU64::new(0),
        }
    }

    fn rpc(&self, method: &str, params: Json) -> Result<Json, String> {
        let id = self.id.fetch_add(1, Ordering::Relaxed);
        let body = Json::obj([
            ("jsonrpc", Json::str("2.0")),
            ("id", Json::int(i64::try_from(id).unwrap_or(0))),
            ("method", Json::str(method)),
            ("params", params),
        ]);
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "POST".to_owned(),
                url: self.url.clone(),
                headers: vec![("content-type".to_owned(), "application/json".to_owned())],
                body: Some(body.compact()),
                timeout_ms: Some(10_000),
                refuse_redirect: false,
            })
            .map_err(|e| e.message)?;
        if !res.ok() {
            return Err(format!("HTTP request failed. Status: {}", res.status));
        }
        let v = json::parse(&res.body).map_err(|e| e.message)?;
        if let Some(err) = v.get("error") {
            let msg = match err.get("message") {
                Some(Json::String(s)) => s.clone(),
                _ => "RPC error".to_owned(),
            };
            return Err(msg);
        }
        v.get("result").cloned().ok_or_else(|| "RPC answer without a result".to_owned())
    }

    fn call(&self, to: &str, data: String) -> Result<String, String> {
        let params = Json::Array(vec![
            Json::obj([("data", Json::str(data)), ("to", Json::str(to.to_lowercase()))]),
            Json::str("latest"),
        ]);
        match self.rpc("eth_call", params)? {
            Json::String(s) if s.len() > 2 => Ok(s),
            _ => Err(format!("The contract at {to} returned no data (\"0x\")")),
        }
    }

    fn word(&self, to: &str, data: String) -> Result<String, String> {
        let out = self.call(to, data)?;
        abi::words(&out)
            .first()
            .map(|w| (*w).to_owned())
            .ok_or_else(|| format!("The contract at {to} returned too little data"))
    }

    fn address(&self, to: &str, selector: &str) -> Result<String, String> {
        let w = self.word(to, selector.to_owned())?;
        abi::word_address(&w).ok_or_else(|| "not an address".to_owned())
    }

    fn token(&self, address: &str) -> Result<Token, String> {
        let text = |sel: &str| -> Result<String, String> {
            abi::decode_string(&self.call(address, sel.to_owned())?).ok_or_else(|| "not a string".to_owned())
        };
        let decimals = abi::word_uint(&self.word(address, abi::DECIMALS.to_owned())?)
            .and_then(|n| u32::try_from(n).ok())
            .filter(|n| *n <= 255)
            .ok_or_else(|| "decimals is not a uint8".to_owned())?;
        Ok(Token {
            address: address.to_lowercase(),
            symbol: text(abi::SYMBOL)?,
            name: text(abi::NAME)?,
            decimals,
        })
    }
}

impl Chain for RpcChain {
    fn grant(&self, account: &str, session_key: &str) -> Result<Option<LiveGrant>, String> {
        let key_word = abi::address_word(session_key);
        let record = self.call(account, format!("{}{key_word}", abi::GET_SESSION))?;
        let ws = abi::words(&record);
        let (Some(hash), Some(spent)) = (ws.first(), ws.get(3)) else {
            return Err("getSession returned too little data".to_owned());
        };
        if hash.bytes().all(|b| b == b'0') {
            return Ok(None);
        }
        let spec_hash = format!("0x{hash}").to_lowercase();
        let spent_wei = abi::word_uint(spent).ok_or_else(|| "spentWei past uint128".to_owned())?;
        let logs = self.rpc(
            "eth_getLogs",
            Json::Array(vec![Json::obj([
                ("address", Json::str(account.to_lowercase())),
                (
                    "topics",
                    Json::Array(vec![Json::str(abi::SESSION_GRANTED), Json::str(format!("0x{key_word}"))]),
                ),
                ("fromBlock", Json::str("0x0")),
            ])]),
        )?;
        let Json::Array(logs) = logs else {
            return Err("eth_getLogs answered no list".to_owned());
        };
        let granted = logs.iter().rev().find_map(|log| match log.get("data") {
            Some(Json::String(d)) => abi::decode_granted(d).filter(|g| g.spec_hash.to_lowercase() == spec_hash),
            _ => None,
        });
        let Some(g) = granted else {
            return Ok(None);
        };
        let live = self.word(account, format!("{}{key_word}", abi::IS_SESSION_LIVE))?;
        Ok(Some(LiveGrant {
            live: abi::word_uint(&live) == Some(1),
            spec_hash,
            valid_after: g.valid_after,
            valid_until: g.valid_until,
            spend_limit_wei: g.spend_limit_wei,
            spent_wei,
            targets: g.targets.iter().map(|t| t.to_lowercase()).collect(),
            selectors: g.selectors.iter().map(|s| s.to_lowercase()).collect(),
        }))
    }

    fn owner(&self, account: &str) -> Result<String, String> {
        Ok(self.address(account, abi::OWNER)?.to_lowercase())
    }

    fn pool(&self, pool: &str) -> Result<PoolTokens, String> {
        let t0 = self.address(pool, abi::TOKEN0)?;
        let t1 = self.address(pool, abi::TOKEN1)?;
        Ok(PoolTokens {
            pool: pool.to_lowercase(),
            tokens: vec![self.token(&t0)?, self.token(&t1)?],
        })
    }

    fn quote(&self, router: &str, pool: &str, token_in: &str, amount_in: u128) -> Result<u128, String> {
        let w = self.word(
            router,
            format!(
                "{}{}{}{}",
                abi::QUOTE_EXACT_IN,
                abi::address_word(pool),
                abi::address_word(token_in),
                abi::uint_word(amount_in)
            ),
        )?;
        abi::word_uint(&w).ok_or_else(|| "the quote is past uint128".to_owned())
    }

    fn receipt(&self, hash: &str) -> Option<Mined> {
        let started = std::time::Instant::now();
        let limit = Duration::from_millis(self.receipt_timeout_ms);
        loop {
            if let Ok(r) = self.rpc("eth_getTransactionReceipt", Json::Array(vec![Json::str(hash)])) {
                match r.get("status") {
                    Some(Json::String(s)) if s == "0x1" => return Some(Mined::Success),
                    Some(Json::String(s)) if s == "0x0" => return Some(Mined::Reverted),
                    _ => {}
                }
            }
            let left = limit.checked_sub(started.elapsed())?;
            std::thread::sleep(left.min(Duration::from_millis(self.poll_ms)));
            if started.elapsed() >= limit {
                return None;
            }
        }
    }
}

/// `httpNavigatorSender`: POST `{chainId, from, to, data}`, answered `{hash}`.
pub struct HttpSender {
    pub url: String,
    pub fetch: Arc<dyn Fetch>,
}

fn is_hash(s: &str) -> bool {
    s.len() == 66 && s.starts_with("0x") && s.bytes().skip(2).all(|b| b.is_ascii_hexdigit())
}

impl Sender for HttpSender {
    fn send(&self, call: &SessionCall) -> Result<String, SendError> {
        let body = Json::obj([
            ("chainId", Json::int(call.chain_id)),
            ("from", Json::str(call.from.clone())),
            ("to", Json::str(call.to.clone())),
            ("data", Json::str(call.data.clone())),
        ]);
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "POST".to_owned(),
                url: self.url.clone(),
                headers: vec![("content-type".to_owned(), "application/json".to_owned())],
                body: Some(body.compact()),
                timeout_ms: Some(15_000),
                refuse_redirect: false,
            })
            .map_err(|e| SendError::Unknown(e.message))?;
        if (400..500).contains(&res.status) {
            return Err(SendError::Refused(res.status));
        }
        let parsed = json::parse(&res.body).ok();
        match parsed.as_ref().and_then(|b| b.get("hash")) {
            Some(Json::String(h)) if res.ok() && is_hash(h) => Ok(h.clone()),
            _ => Err(SendError::Unknown(format!("navigator signer answered no hash ({})", res.status))),
        }
    }
}

/// `LINKED_WALLETS_PATH`.
pub const LINKED_WALLETS_PATH: &str = "/internal/linked-wallets";

fn base(url: &str) -> String {
    url.trim_end_matches('/').to_owned()
}

/// `createIdentityLinkedWallets`: POST `{userId}`, signed as svc-agents, three seconds, no redirect.
pub struct LinkedWalletsHttp {
    pub identity_url: String,
    pub signer: CallSigner,
    pub fetch: Arc<dyn Fetch>,
}

impl LinkedWalletsHttp {
    pub fn new(identity_url: &str, signer: CallSigner, fetch: Arc<dyn Fetch>) -> LinkedWalletsHttp {
        LinkedWalletsHttp {
            identity_url: base(identity_url),
            signer,
            fetch,
        }
    }
}

fn keys_are(v: &Json, keys: &[&str]) -> bool {
    matches!(v, Json::Object(fields) if fields.iter().all(|(k, _)| keys.contains(&k.as_str())))
}

/// `linkedWalletsSchema`, strict.
pub fn linked_of(v: &Json) -> Option<Linked> {
    match v.get("state") {
        Some(Json::String(s)) if s == "account_inactive" && keys_are(v, &["state"]) => Some(Linked::AccountInactive),
        Some(Json::String(s)) if s == "usable" && keys_are(v, &["state", "wallets"]) => {
            let Some(Json::Array(ws)) = v.get("wallets") else {
                return None;
            };
            ws.iter()
                .map(|w| {
                    let address = match w.get("address") {
                        Some(Json::String(a))
                            if a.len() == 42
                                && a.starts_with("0x")
                                && a.bytes().skip(2).all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) =>
                        {
                            a.clone()
                        }
                        _ => return None,
                    };
                    match w.get("linkedAt") {
                        Some(Json::String(t)) if keys_are(w, &["address", "linkedAt"]) && zod_datetime(t, false).is_some() => {
                            Some(address)
                        }
                        _ => None,
                    }
                })
                .collect::<Option<Vec<_>>>()
                .map(Linked::Usable)
        }
        _ => None,
    }
}

impl LinkedWallets for LinkedWalletsHttp {
    fn read(&self, user_id: &str) -> Option<Linked> {
        let raw = Json::obj([("userId", Json::str(user_id))]).compact();
        let signed = self.signer.sign(&raw, "POST", LINKED_WALLETS_PATH, "application/json").ok()?;
        let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
        headers.extend(signed);
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "POST".to_owned(),
                url: format!("{}{LINKED_WALLETS_PATH}", self.identity_url),
                headers,
                body: Some(raw),
                timeout_ms: Some(3_000),
                refuse_redirect: true,
            })
            .ok()?;
        if !res.ok() {
            return None;
        }
        linked_of(&json::parse(&res.body).ok()?)
    }
}

/// `createIdentitySelfFreezeRead`: GET `/internal/self-freeze/:userId`, signed, three seconds.
pub struct SelfFreezeHttp {
    pub identity_url: String,
    pub signer: CallSigner,
    pub fetch: Arc<dyn Fetch>,
}

impl SelfFreezeHttp {
    pub fn new(identity_url: &str, signer: CallSigner, fetch: Arc<dyn Fetch>) -> SelfFreezeHttp {
        SelfFreezeHttp {
            identity_url: base(identity_url),
            signer,
            fetch,
        }
    }
}

fn is_guid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// `selfFreezeStateSchema`, strict, for this person.
pub fn freeze_of(v: &Json, user_id: &str) -> Option<Freeze> {
    if !keys_are(v, &["userId", "frozen", "since"]) {
        return None;
    }
    let Some(Json::String(id)) = v.get("userId") else {
        return None;
    };
    let Some(Json::Bool(frozen)) = v.get("frozen") else {
        return None;
    };
    let since = match v.get("since") {
        Some(Json::Null) => None,
        Some(Json::String(t)) if zod_datetime(t, true).is_some() => Some(t.clone()),
        _ => return None,
    };
    if !is_guid(id) || id.to_lowercase() != user_id.to_lowercase() {
        return None;
    }
    Some(if *frozen { Freeze::Frozen { since } } else { Freeze::Open })
}

impl SelfFreeze for SelfFreezeHttp {
    fn read(&self, user_id: &str) -> Result<Freeze, String> {
        let path = format!("/internal/self-freeze/{}", encode_uri_component(user_id));
        let headers = self
            .signer
            .sign("", "GET", &path, "")
            .map_err(|_| "identity did not answer the freeze read".to_owned())?;
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "GET".to_owned(),
                url: format!("{}{path}", self.identity_url),
                headers,
                body: None,
                timeout_ms: Some(3_000),
                refuse_redirect: false,
            })
            .map_err(|_| "identity did not answer the freeze read".to_owned())?;
        if !res.ok() {
            return Err(format!("identity refused the freeze read ({})", res.status));
        }
        json::parse(&res.body)
            .ok()
            .and_then(|v| freeze_of(&v, user_id))
            .ok_or_else(|| "identity answered the freeze read outside its contract".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_market_is_read_strictly_and_a_bad_one_stops_the_boot() {
        let a = format!("0x{}", "1".repeat(40));
        let ok = format!(r#"{{"router":"{a}","spendToken":"{a}","pools":["{a}"],"slippageBps":50}}"#);
        assert_eq!(parse_market(&ok).map(|m| m.slippage_bps), Ok(50));
        assert!(parse_market(&ok.replace("50", "0")).is_err());
        assert!(parse_market(&ok.replace(r#"["0x"#, r#"[]"#)).is_err());
        assert!(parse_market("not json").is_err());
    }

    #[test]
    fn identity_answers_outside_their_contract_read_as_none() {
        let a = format!("0x{}", "a".repeat(40));
        let usable = json::parse(&format!(
            r#"{{"state":"usable","wallets":[{{"address":"{a}","linkedAt":"2026-11-01T00:00:00.000Z"}}]}}"#
        ));
        assert_eq!(usable.ok().as_ref().and_then(linked_of), Some(Linked::Usable(vec![a.clone()])));
        let upper = json::parse(&format!(
            r#"{{"state":"usable","wallets":[{{"address":"{}","linkedAt":"2026-11-01T00:00:00.000Z"}}]}}"#,
            a.to_uppercase().replace("0X", "0x")
        ));
        assert_eq!(upper.ok().as_ref().and_then(linked_of), None);
        let id = "00000000-0000-4000-8000-000000000001";
        let frozen = json::parse(&format!(r#"{{"userId":"{id}","frozen":true,"since":null}}"#));
        assert_eq!(frozen.ok().as_ref().and_then(|v| freeze_of(v, id)), Some(Freeze::Frozen { since: None }));
        let other = json::parse(&format!(r#"{{"userId":"{id}","frozen":false,"since":null,"x":1}}"#));
        assert_eq!(other.ok().as_ref().and_then(|v| freeze_of(v, id)), None);
    }
}
