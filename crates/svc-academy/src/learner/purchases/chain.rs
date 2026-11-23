//! J-academy-07 — what the chain says about one course payment or refund, read over plain JSON-RPC from the owner's
//! node (`ACADEMY_PAYMENT_RPC_URL`), as `purchases/chain.ts` reads it. Reads only: this module builds the calldata a
//! wallet signs, but it never signs or sends.
//!
//! A payment is one ERC-20 `transfer(receiver, amount)` of the payment token from the buyer's wallet. It counts only
//! when the chain shows a successful transaction whose token `Transfer` log moves exactly that amount from that wallet
//! to INTAFACED's receiving address, with the confirmations the owner set. Anything else is not that payment.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::money::parse_amount;

use crate::errors::Refusal;
use crate::ports::{Chain, TransferFact, TxFact};

/// The ledger's scale: amounts are 18-decimal fixed point (`packages/ledger-client` money).
const LEDGER_DECIMALS: u32 = 18;

/// keccak256("Transfer(address,address,uint256)").
pub const TRANSFER_TOPIC: &str =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/// `transfer(address,uint256)`.
pub const TRANSFER_SELECTOR: &str = "0xa9059cbb";

/// The code a [`ChainUnreadError`]-like refusal carries: the node could not be read, so the answer is unknown, never
/// "no payment". It never leaves the purchase module: the reconciler leaves the row where it is, and Buy refuses
/// `academy.payments_off` naming it.
pub const CHAIN_UNREAD: &str = "academy.internal.chain_unread";

/// `new ChainUnreadError(message)`.
pub fn unread(message: String) -> Refusal {
    Refusal::Internal {
        message,
        code: Some(CHAIN_UNREAD.to_owned()),
    }
}

/// Whether a refusal is the node being unreadable.
pub fn is_unread(r: &Refusal) -> bool {
    matches!(r, Refusal::Internal { code: Some(c), .. } if c == CHAIN_UNREAD)
}

fn hex_digits(s: &str, n: usize) -> bool {
    s.len() == n
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// `isAddress`: `0x` and 40 hex digits, any case.
pub fn is_address(value: &str) -> bool {
    let v = value.to_lowercase();
    v.strip_prefix("0x").is_some_and(|h| hex_digits(h, 40))
}

/// `isTxHash`: `0x` and 64 lower-case hex digits.
pub fn is_tx_hash(value: &str) -> bool {
    value.strip_prefix("0x").is_some_and(|h| hex_digits(h, 64))
}

/// `word(hex)`: without its `0x`, left-padded to 64.
fn word(hex: &str) -> String {
    let h = hex.strip_prefix("0x").unwrap_or(hex);
    format!("{h:0>64}")
}

fn topic_of(address: &str) -> String {
    format!("0x{}", word(&address.to_lowercase()))
}

fn address_of_topic(topic: &str) -> String {
    let tail: String = topic
        .chars()
        .rev()
        .take(40)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("0x{tail}").to_lowercase()
}

/// `transferCalldata(to, amount)`: what the buyer's wallet is asked to sign, and nothing else.
pub fn transfer_calldata(to: &str, amount: u128) -> Result<String, String> {
    if !is_address(to) {
        return Err("transfer needs a 0x address".to_owned());
    }
    if amount == 0 {
        return Err("transfer needs an amount above zero".to_owned());
    }
    Ok(format!(
        "{TRANSFER_SELECTOR}{}{}",
        word(&to.to_lowercase()),
        word(&format!("{amount:x}"))
    ))
}

/// `toBaseUnits(amount, decimals)`: a decimal string amount in the token's smallest unit, parsed by the ledger's own
/// money parser (18 decimals) and scaled down; more decimals than the token has refuse.
pub fn to_base_units(amount: &str, decimals: i64) -> Result<u128, String> {
    let Some(d) = u32::try_from(decimals)
        .ok()
        .filter(|d| *d <= LEDGER_DECIMALS)
    else {
        return Err(format!("token decimals must be 0 to {LEDGER_DECIMALS}"));
    };
    let scaled = parse_amount(service_kit::schema::js_trim(amount))?;
    let Ok(scaled) = u128::try_from(scaled.scaled()) else {
        return Err(format!("not a decimal amount: {amount}"));
    };
    let step = 10u128.pow(LEDGER_DECIMALS - d);
    if scaled % step != 0 {
        return Err(format!(
            "{amount} has more decimals than the token's {decimals}"
        ));
    }
    Ok(scaled / step)
}

/// `fromBaseUnits(units, decimals)`: the smallest unit as a decimal string with no trailing zeros.
pub fn from_base_units(units: u128, decimals: u32) -> String {
    let scale = 10u128.pow(decimals);
    let whole = units / scale;
    let fraction = format!(
        "{:0>width$}",
        units % scale,
        width = usize::try_from(decimals).unwrap_or(0)
    );
    let fraction = fraction.trim_end_matches('0');
    if fraction.is_empty() {
        whole.to_string()
    } else {
        format!("{whole}.{fraction}")
    }
}

/// `BigInt(text)` for a hex or decimal quantity; a value past `u128` saturates (it can equal no price).
fn big(text: &str) -> Result<u128, Refusal> {
    let bad = || Refusal::Internal {
        message: format!("Cannot convert {text} to a BigInt"),
        code: None,
    };
    let t = text.trim();
    if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        if h.is_empty() || !h.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(bad());
        }
        let h = h.trim_start_matches('0');
        if h.len() > 32 {
            return Ok(u128::MAX);
        }
        return u128::from_str_radix(if h.is_empty() { "0" } else { h }, 16).map_err(|_| bad());
    }
    if t.is_empty() {
        return Ok(0);
    }
    if !t.bytes().all(|c| c.is_ascii_digit()) {
        return Err(bad());
    }
    Ok(t.parse().unwrap_or(u128::MAX))
}

fn block(text: &str) -> Result<u64, Refusal> {
    big(text).map(|n| u64::try_from(n).unwrap_or(u64::MAX))
}

fn str_of<'a>(v: &'a Json, key: &str) -> Result<&'a str, Refusal> {
    match v.get(key) {
        Some(Json::String(s)) => Ok(s),
        _ => Err(Refusal::Internal {
            message: format!("Cannot read properties of the chain's answer ({key})"),
            code: None,
        }),
    }
}

/// `transferOf(log, token)`.
fn transfer_of(log: &Json, token: &str) -> Result<Option<TransferFact>, Refusal> {
    if str_of(log, "address")?.to_lowercase() != token.to_lowercase() {
        return Ok(None);
    }
    let topics: Vec<&str> = match log.get("topics") {
        Some(Json::Array(t)) => t
            .iter()
            .map(|x| match x {
                Json::String(s) => s.as_str(),
                _ => "",
            })
            .collect(),
        _ => Vec::new(),
    };
    let [first, from, to] = topics.as_slice() else {
        return Ok(None);
    };
    if first.to_lowercase() != TRANSFER_TOPIC {
        return Ok(None);
    }
    let data = str_of(log, "data")?;
    Ok(Some(TransferFact {
        tx_hash: str_of(log, "transactionHash")?.to_lowercase(),
        block_number: block(str_of(log, "blockNumber")?)?,
        from: address_of_topic(from),
        to: address_of_topic(to),
        amount: if data == "0x" { 0 } else { big(data)? },
    }))
}

/// `rpcPaymentChain(rpcUrl, fetch, timeoutMs)`: the JSON-RPC reader over one node URL.
pub struct RpcChain {
    pub url: String,
    pub fetch: Arc<dyn Fetch>,
    pub timeout_ms: u64,
    id: AtomicU64,
}

impl RpcChain {
    pub fn new(url: &str, fetch: Arc<dyn Fetch>) -> RpcChain {
        RpcChain {
            url: url.to_owned(),
            fetch,
            timeout_ms: 5_000,
            id: AtomicU64::new(0),
        }
    }

    fn call(&self, method: &str, params: Json) -> Result<Json, Refusal> {
        let id = self.id.fetch_add(1, Ordering::SeqCst) + 1;
        #[expect(clippy::cast_precision_loss, reason = "a request counter")]
        let body = Json::obj([
            ("jsonrpc", Json::str("2.0")),
            ("id", Json::Number(id as f64)),
            ("method", Json::str(method)),
            ("params", params),
        ]);
        let req = HttpRequest {
            method: "POST".to_owned(),
            url: self.url.clone(),
            headers: vec![("content-type".to_owned(), "application/json".to_owned())],
            body: Some(body.compact()),
            timeout_ms: Some(self.timeout_ms),
            refuse_redirect: false,
        };
        let res = self.fetch.fetch(&req).map_err(|e| {
            unread(format!(
                "{method}: the payment node did not answer ({})",
                e.message
            ))
        })?;
        if !res.ok() {
            return Err(unread(format!(
                "{method}: the payment node answered HTTP {}",
                res.status
            )));
        }
        let body = json::parse(&res.body).ok();
        let error = body.as_ref().and_then(|b| b.get("error"));
        let has_error = error.is_some_and(|e| !matches!(e, Json::Null | Json::Bool(false)));
        let result = body.as_ref().and_then(|b| b.get("result"));
        match (body.as_ref(), has_error, result) {
            (Some(Json::Object(_)), false, Some(r)) => Ok(r.clone()),
            _ => {
                let said = error
                    .and_then(|e| e.get("message"))
                    .and_then(|m| match m {
                        Json::String(s) => Some(s.clone()),
                        _ => None,
                    })
                    .unwrap_or_else(|| "no result".to_owned());
                Err(unread(format!("{method}: {said}")))
            }
        }
    }
}

impl Chain for RpcChain {
    fn block_number(&self) -> Result<u64, Refusal> {
        let r = self.call("eth_blockNumber", Json::Array(Vec::new()))?;
        match r {
            Json::String(s) => block(&s),
            #[expect(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "BigInt(number) of a block"
            )]
            Json::Number(n) if n.fract() == 0.0 && n >= 0.0 => Ok(n as u64),
            other => Err(Refusal::Internal {
                message: format!("Cannot convert {} to a BigInt", other.compact()),
                code: None,
            }),
        }
    }

    fn transaction(&self, tx_hash: &str, token: &str) -> Result<TxFact, Refusal> {
        let receipt = self.call(
            "eth_getTransactionReceipt",
            Json::Array(vec![Json::str(tx_hash)]),
        )?;
        if matches!(receipt, Json::Null) {
            return Ok(TxFact::Unseen);
        }
        let mined = block(str_of(&receipt, "blockNumber")?)?;
        if big(str_of(&receipt, "status")?)? != 1 {
            return Ok(TxFact::Reverted {
                block_number: mined,
            });
        }
        let head = self.block_number()?;
        let logs = match receipt.get("logs") {
            Some(Json::Array(l)) => l.clone(),
            _ => {
                return Err(Refusal::Internal {
                    message: "receipt.logs.map is not a function".to_owned(),
                    code: None,
                });
            }
        };
        let mut transfers = Vec::new();
        for log in &logs {
            if let Some(t) = transfer_of(log, token)? {
                transfers.push(t);
            }
        }
        Ok(TxFact::Mined {
            block_number: mined,
            confirmations: if head >= mined { head - mined + 1 } else { 0 },
            transfers,
        })
    }

    fn transfers(
        &self,
        token: &str,
        from: &str,
        to: &str,
        from_block: u64,
    ) -> Result<Vec<TransferFact>, Refusal> {
        let logs = self.call(
            "eth_getLogs",
            Json::Array(vec![Json::obj([
                ("address", Json::str(token)),
                ("fromBlock", Json::str(format!("0x{from_block:x}"))),
                ("toBlock", Json::str("latest")),
                (
                    "topics",
                    Json::Array(vec![
                        Json::str(TRANSFER_TOPIC),
                        Json::str(topic_of(from)),
                        Json::str(topic_of(to)),
                    ]),
                ),
            ])]),
        )?;
        let Json::Array(logs) = logs else {
            return Err(Refusal::Internal {
                message: "logs.map is not a function".to_owned(),
                code: None,
            });
        };
        let mut out = Vec::new();
        for log in &logs {
            if let Some(t) = transfer_of(log, token)? {
                out.push(t);
            }
        }
        out.sort_by_key(|t| t.block_number);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    //! `purchases/chain.test.ts`: the payment amounts and calldata the buyer's wallet is asked to sign.
    use super::*;

    #[test]
    fn scales_a_decimal_price_to_the_token_unit_exactly_and_back() {
        assert_eq!(to_base_units("2.5", 6).unwrap(), 2_500_000);
        assert_eq!(to_base_units("20", 6).unwrap(), 20_000_000);
        assert_eq!(to_base_units("0.000001", 6).unwrap(), 1);
        assert_eq!(to_base_units("1.5", 18).unwrap(), 1_500_000_000_000_000_000);
        assert_eq!(from_base_units(2_500_000, 6), "2.5");
        assert_eq!(from_base_units(20_000_000, 6), "20");
    }

    #[test]
    fn refuses_a_price_with_more_decimals_than_the_token_or_one_that_is_not_a_decimal() {
        assert!(
            to_base_units("0.0000001", 6)
                .unwrap_err()
                .contains("more decimals")
        );
        assert!(to_base_units("abc", 6).is_err());
        assert!(to_base_units("1", 19).unwrap_err().contains("decimals"));
    }

    #[test]
    fn builds_transfer_to_amount_and_nothing_else() {
        let to = "0x7e57ac4d00000000000000000000000000000007";
        assert_eq!(
            transfer_calldata(to, 2_500_000).unwrap(),
            format!(
                "0xa9059cbb{}{}{:0>64}",
                "0".repeat(24),
                &to[2..],
                format!("{:x}", 2_500_000)
            )
        );
        assert!(transfer_calldata(to, 0).is_err());
        assert!(transfer_calldata("0x12", 1).is_err());
    }
}
