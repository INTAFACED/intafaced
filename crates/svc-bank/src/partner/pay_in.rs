//! The TEST partner's USDC pay-in (`pay-yourself/test-pay-in.ts`, J-bank-31): each person gets a TEST address on a
//! loopback TEST chain, and the partner watches its token's transfers to those addresses. A transfer it has seen is
//! credited once, under `bank.pay-in:usdc:<chain>:<tx>:<log>`, after `CONFIRMATIONS` blocks, as one pay-in on the
//! partner's book (`State::receive`); with the person's `payIn: 'held'` it waits. Nothing is posted to our ledger.
//!
//! On only with the TEST partner and all three of `BANK_TEST_PAY_IN_RPC_URL`, `_CHAIN_ID` and `_TOKEN`; the binary
//! polls it once a second, one pass at a time (`main.rs`).

use std::collections::HashMap;
use std::sync::Mutex;

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, parse_amount};
use service_kit::time::Instant;
use sha2::{Digest, Sha256};

use super::{AccountRef, TestPartner};

/// How many blocks a pay-in waits before it is credited (`TEST_PAY_IN_CONFIRMATIONS`). TEST value.
pub const CONFIRMATIONS: u64 = 12;
/// The asset a pay-in credits (`PAY_IN_ASSET`).
pub const ASSET: &str = "USDC";
const TRANSFER_TOPIC: &str = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MAX_CREDITS: usize = 100_000;

/// One pay-in the partner has seen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Kept {
    pub key: String,
    pub user_id: String,
    pub tx_hash: String,
    pub log_index: u64,
    pub amount: Amount,
    pub from: String,
    pub block: u64,
    pub seen_at: Instant,
    pub available_at: Option<Instant>,
    pub move_id: Option<String>,
}

#[derive(Debug, Default)]
struct Watch {
    /// address → person.
    owners: HashMap<String, String>,
    kept: Vec<Kept>,
    at: HashMap<String, usize>,
    from: Option<u64>,
    head: u64,
    rpc_id: u64,
}

/// The rail (`PayInRail`).
pub struct PayInRail {
    pub rpc_url: String,
    pub chain_id: u64,
    pub token: String,
    pub decimals: u32,
    fetch: Box<dyn Fetch>,
    watch: Mutex<Watch>,
}

/// `testPayInAddress`: the last 20 bytes of `sha256("INTAFACED TEST partner pay-in:<user>")`.
pub fn address(user_id: &str) -> String {
    let hex: String = Sha256::digest(format!("INTAFACED TEST partner pay-in:{user_id}").as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("0x{}", hex.get(24..).unwrap_or_default())
}

/// `unitsToAmount`: token units at `decimals` places as an amount.
pub fn units_to_amount(units: u128, decimals: u32) -> Result<Amount, String> {
    let scale = 10u128.checked_pow(decimals).ok_or("too many decimals")?;
    let whole = units / scale;
    let width = usize::try_from(decimals).map_err(|e| e.to_string())?;
    let frac = format!("{:0width$}", units % scale);
    let frac = frac.trim_end_matches('0');
    parse_amount(&if frac.is_empty() {
        whole.to_string()
    } else {
        format!("{whole}.{frac}")
    })
}

/// `BigInt(<hex or decimal>)`.
fn big(text: &str) -> Result<u128, String> {
    match text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        Some("") => Ok(0),
        Some(hex) => u128::from_str_radix(hex, 16).map_err(|e| e.to_string()),
        None => text.parse::<u128>().map_err(|e| e.to_string()),
    }
}

fn str_of<'a>(v: &'a Json, key: &str) -> Result<&'a str, String> {
    match v.get(key) {
        Some(Json::String(s)) => Ok(s),
        _ => Err(format!("TEST chain log has no {key}")),
    }
}

/// `testPayInRailFor`: none unless the TEST partner and all three settings are given.
pub fn for_stack(
    partner: bool,
    rpc_url: Option<&str>,
    chain_id: Option<&str>,
    token: Option<&str>,
    fetch: Box<dyn Fetch>,
) -> Result<Option<PayInRail>, String> {
    let trim = |v: Option<&str>| v.map(service_kit::money::js_trim).unwrap_or("").to_owned();
    let (rpc_url, chain_id, token) = (trim(rpc_url), trim(chain_id), trim(token));
    if !partner || rpc_url.is_empty() || chain_id.is_empty() || token.is_empty() {
        return Ok(None);
    }
    let digits = chain_id.bytes().all(|b| b.is_ascii_digit());
    if !digits || chain_id.len() > 10 || chain_id.starts_with('0') {
        return Err("BANK_TEST_PAY_IN_CHAIN_ID must be a chain id".to_owned());
    }
    let chain_id = chain_id.parse::<u64>().map_err(|e| e.to_string())?;
    let url = url::Url::parse(&rpc_url).map_err(|e| e.to_string())?;
    let host = url.host_str().unwrap_or_default();
    if !["127.0.0.1", "localhost", "[::1]", "::1"].contains(&host) {
        return Err(format!(
            "the TEST partner's pay-in watches a loopback TEST chain only, not {rpc_url}"
        ));
    }
    let token = token.to_lowercase();
    let address_ok = token.len() == 42
        && token.starts_with("0x")
        && token
            .bytes()
            .skip(2)
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !address_ok {
        return Err("the TEST pay-in token must be an address".to_owned());
    }
    Ok(Some(PayInRail {
        rpc_url,
        chain_id,
        token,
        decimals: 6,
        fetch,
        watch: Mutex::new(Watch::default()),
    }))
}

impl PayInRail {
    fn watch(&self) -> std::sync::MutexGuard<'_, Watch> {
        self.watch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn rpc(&self, method: &str, params: Json) -> Result<Json, String> {
        let id = {
            let mut w = self.watch();
            w.rpc_id = w.rpc_id.saturating_add(1);
            w.rpc_id
        };
        let body = Json::obj([
            ("jsonrpc", Json::str("2.0")),
            ("id", Json::int(i64::try_from(id).unwrap_or(i64::MAX))),
            ("method", Json::str(method)),
            ("params", params),
        ]);
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: "POST".to_owned(),
                url: self.rpc_url.clone(),
                headers: vec![("content-type".to_owned(), "application/json".to_owned())],
                body: Some(body.compact()),
                timeout_ms: Some(5_000),
                refuse_redirect: false,
            })
            .map_err(|e| e.message)?;
        let answer = json::parse(&res.body).map_err(|e| e.message)?;
        let error = answer.get("error").filter(|e| !matches!(e, Json::Null));
        if !res.ok() || error.is_some() {
            let why = match error.and_then(|e| e.get("message")) {
                Some(Json::String(m)) => m.clone(),
                _ => res.status.to_string(),
            };
            return Err(format!("TEST chain {method} failed: {why}"));
        }
        Ok(answer.get("result").cloned().unwrap_or(Json::Null))
    }

    /// `route`: the person's TEST pay-in address, watched from now on.
    pub fn route(&self, user_id: &str) -> String {
        let a = address(user_id);
        self.watch().owners.insert(a.clone(), user_id.to_owned());
        a
    }

    /// The person's pay-ins, newest first, and the chain's head.
    pub fn credits(&self, user_id: &str) -> (Vec<Kept>, u64) {
        let w = self.watch();
        (
            w.kept
                .iter()
                .rev()
                .filter(|k| k.user_id == user_id)
                .cloned()
                .collect(),
            w.head,
        )
    }

    /// One pass: read the head, take every new transfer to a watched address, and credit each that is due.
    pub fn poll(&self, partner: &TestPartner, now: impl Fn() -> Instant) -> Result<(), String> {
        let head_json = self.rpc("eth_blockNumber", Json::Array(Vec::new()))?;
        let head_text = match &head_json {
            Json::String(s) => s.clone(),
            Json::Number(n) => json::js_number_string(*n),
            _ => return Err("TEST chain eth_blockNumber gave no number".to_owned()),
        };
        let head = u64::try_from(big(&head_text)?).map_err(|e| e.to_string())?;
        let (from, owners) = {
            let mut w = self.watch();
            w.head = head;
            let from = *w.from.get_or_insert(head.saturating_add(1));
            (from, w.owners.keys().cloned().collect::<Vec<_>>())
        };
        if !owners.is_empty() && head >= from {
            let padded = owners
                .iter()
                .map(|a| {
                    Json::str(format!(
                        "0x{}{}",
                        "0".repeat(24),
                        a.get(2..).unwrap_or_default()
                    ))
                })
                .collect();
            let logs = self.rpc(
                "eth_getLogs",
                Json::Array(vec![Json::obj([
                    ("address", Json::str(&self.token)),
                    (
                        "topics",
                        Json::Array(vec![
                            Json::str(TRANSFER_TOPIC),
                            Json::Null,
                            Json::Array(padded),
                        ]),
                    ),
                    ("fromBlock", Json::str(format!("0x{from:x}"))),
                    ("toBlock", Json::str(format!("0x{head:x}"))),
                ])]),
            )?;
            let Json::Array(logs) = logs else {
                return Err("TEST chain eth_getLogs gave no list".to_owned());
            };
            let mut w = self.watch();
            for log in &logs {
                if matches!(log.get("removed"), Some(Json::Bool(true))) {
                    continue;
                }
                let topics = match log.get("topics") {
                    Some(Json::Array(t)) => t,
                    _ => return Err("TEST chain log has no topics".to_owned()),
                };
                let topic = |i: usize| match topics.get(i) {
                    Some(Json::String(s)) => Some(s.as_str()),
                    _ => None,
                };
                let to_topic = topic(2).ok_or("TEST chain log has no recipient")?;
                let tail = |t: &str| {
                    t.get(t.len().saturating_sub(40)..)
                        .unwrap_or(t)
                        .to_lowercase()
                };
                let to = format!("0x{}", tail(to_topic));
                let Some(user_id) = w.owners.get(&to).cloned() else {
                    continue;
                };
                let units = big(str_of(log, "data")?)?;
                let Some(sender) = topic(1) else { continue };
                if units == 0 {
                    continue;
                }
                let log_index =
                    u64::try_from(big(str_of(log, "logIndex")?)?).map_err(|e| e.to_string())?;
                let tx_hash = str_of(log, "transactionHash")?.to_lowercase();
                let key = format!("bank.pay-in:usdc:{}:{tx_hash}:{log_index}", self.chain_id);
                if w.at.contains_key(&key) || w.kept.len() >= MAX_CREDITS {
                    continue;
                }
                let block =
                    u64::try_from(big(str_of(log, "blockNumber")?)?).map_err(|e| e.to_string())?;
                let k = Kept {
                    key: key.clone(),
                    user_id,
                    tx_hash,
                    log_index,
                    amount: units_to_amount(units, self.decimals)?,
                    from: format!("0x{}", tail(sender)),
                    block,
                    seen_at: now(),
                    available_at: None,
                    move_id: None,
                };
                let at = w.kept.len();
                w.at.insert(key, at);
                w.kept.push(k);
            }
            w.from = Some(head.saturating_add(1));
        }
        // A refusal of one credit (the partner down, an account closing) leaves it pending for the next pass.
        let mut w = self.watch();
        for k in w.kept.iter_mut().filter(|k| k.available_at.is_none()) {
            if partner
                .lock()
                .board
                .read(&k.user_id, |s| s.pay_in == "held")
            {
                continue;
            }
            if head.saturating_sub(k.block).saturating_add(1) < CONFIRMATIONS {
                continue;
            }
            if let Ok(m) = partner.lock().receive(
                &AccountRef::main(&k.user_id, ASSET),
                &k.key,
                k.amount,
                now(),
            ) {
                k.move_id = Some(m.id);
                k.available_at = Some(m.moved_at);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;
    use service_kit::money::format_amount;

    #[test]
    fn units_read_at_the_tokens_places() {
        assert_eq!(format_amount(units_to_amount(1_500_000, 6).unwrap()), "1.5");
        assert_eq!(format_amount(units_to_amount(20_000_000, 6).unwrap()), "20");
        assert_eq!(format_amount(units_to_amount(1, 6).unwrap()), "0.000001");
    }

    #[test]
    fn an_address_is_the_last_twenty_bytes_of_the_persons_hash() {
        let a = address("u1");
        assert_eq!(a.len(), 42);
        assert!(a.starts_with("0x"));
        assert_eq!(address("u1"), a);
        assert_ne!(address("u2"), a);
    }

    #[test]
    fn the_rail_watches_a_loopback_chain_only_and_needs_every_setting() {
        let f = || -> Box<dyn Fetch> { Box::new(service_kit::http::UreqFetch::new()) };
        let token = "0x00000000000000000000000000000000000000AA";
        assert!(
            for_stack(
                false,
                Some("http://127.0.0.1:8545"),
                Some("31337"),
                Some(token),
                f()
            )
            .unwrap()
            .is_none()
        );
        assert!(
            for_stack(true, Some("http://127.0.0.1:8545"), None, Some(token), f())
                .unwrap()
                .is_none()
        );
        let rail = for_stack(
            true,
            Some("http://127.0.0.1:8545"),
            Some("31337"),
            Some(token),
            f(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(rail.token, token.to_lowercase());
        assert!(
            for_stack(
                true,
                Some("http://chain.example:8545"),
                Some("1"),
                Some(token),
                f()
            )
            .is_err()
        );
        assert!(
            for_stack(
                true,
                Some("http://localhost:8545"),
                Some("0"),
                Some(token),
                f()
            )
            .is_err()
        );
        assert!(
            for_stack(
                true,
                Some("http://[::1]:8545"),
                Some("1"),
                Some("0x12"),
                f()
            )
            .is_err()
        );
    }
}
