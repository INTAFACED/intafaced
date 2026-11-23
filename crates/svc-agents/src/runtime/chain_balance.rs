//! A wallet's balance of the payment token, as the chain reports it (`services/svc-agents/src/chain-balance.ts`,
//! J-agents-02 #4). One JSON-RPC node, read-only: `eth_chainId` (the node must be the configured chain),
//! `eth_getBlockByNumber('latest')` for the block and its time, then `balanceOf(wallet)`, the token's `decimals()` and
//! its own `symbol()` by `eth_call` at that same block, so the figure, the name it is shown under and its as-of time
//! describe one moment. The balance is scaled from the token's decimals to the fee asset's scale, rounding down, so a
//! figure is never shown as more than the chain holds. Nothing is signed or sent; nothing invents a balance.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::money::Amount;
use service_kit::time::Instant;

use crate::navigator::onchain::abi;

/// The fee asset's scale (`DECIMALS`).
pub const AMOUNT_DECIMALS: u32 = 18;
/// `balanceOf(address)`.
pub const BALANCE_OF: &str = "0x70a08231";
const RPC_TIMEOUT_MS: u64 = 3_000;

/// `PaymentTokenConfig`: all four owner values, or no reader at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaymentToken {
    pub rpc_url: String,
    pub chain_id: i64,
    pub token_address: String,
    pub token_decimals: u32,
}

/// `WalletBalanceReading` without its method (the caller names the wallet it asked for).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalletBalance {
    pub available: Amount,
    pub token: String,
    pub chain_id: i64,
    /// The block number, in decimal.
    pub block: String,
    /// ISO time of the block, from the block itself.
    pub as_of: String,
}

/// `ChainBalancePort`: an `Err` is the reason the wallet is unread (`chain_unreachable`, `chain_mismatch`).
pub trait ChainBalance: Send + Sync {
    fn read(&self, address: &str) -> Result<WalletBalance, &'static str>;
}

/// `toAmountScale`: token units to the ledger's 18 places, rounding down; none when it does not fit.
pub fn to_amount_scale(units: u128, decimals: u32) -> Option<Amount> {
    let scaled = if decimals == AMOUNT_DECIMALS {
        units
    } else if decimals < AMOUNT_DECIMALS {
        units.checked_mul(10u128.checked_pow(AMOUNT_DECIMALS - decimals)?)?
    } else {
        // Past 10^38 nothing of a u128 is left.
        10u128
            .checked_pow(decimals - AMOUNT_DECIMALS)
            .map_or(0, |d| units / d)
    };
    i128::try_from(scaled).ok().map(Amount::from_scaled)
}

/// `createChainBalance` over JSON-RPC: three seconds a request, no retry.
pub struct RpcChainBalance {
    pub config: PaymentToken,
    pub fetch: Arc<dyn Fetch>,
    id: AtomicU64,
}

impl RpcChainBalance {
    pub fn new(config: PaymentToken, fetch: Arc<dyn Fetch>) -> RpcChainBalance {
        RpcChainBalance {
            config,
            fetch,
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
                url: self.config.rpc_url.clone(),
                headers: vec![("content-type".to_owned(), "application/json".to_owned())],
                body: Some(body.compact()),
                timeout_ms: Some(RPC_TIMEOUT_MS),
                refuse_redirect: false,
            })
            .map_err(|e| e.message)?;
        if !res.ok() {
            return Err(format!("HTTP request failed. Status: {}", res.status));
        }
        let v = json::parse(&res.body).map_err(|e| e.message)?;
        if v.get("error").is_some() {
            return Err("RPC error".to_owned());
        }
        v.get("result")
            .cloned()
            .ok_or_else(|| "RPC answer without a result".to_owned())
    }

    fn call(&self, data: String, block: &str) -> Result<String, String> {
        let params = Json::Array(vec![
            Json::obj([
                ("data", Json::str(data)),
                ("to", Json::str(self.config.token_address.to_lowercase())),
            ]),
            Json::str(block),
        ]);
        match self.rpc("eth_call", params)? {
            Json::String(s) if s.len() > 2 => Ok(s),
            _ => Err("the token returned no data".to_owned()),
        }
    }

    fn uint(&self, data: String, block: &str) -> Result<u128, String> {
        let out = self.call(data, block)?;
        abi::words(&out)
            .first()
            .and_then(|w| abi::word_uint(w))
            .ok_or_else(|| "not a uint that fits".to_owned())
    }
}

/// A JSON-RPC quantity (`0x`-prefixed hex).
fn quantity(v: &Json) -> Option<u128> {
    match v {
        Json::String(s) => u128::from_str_radix(s.strip_prefix("0x")?, 16).ok(),
        _ => None,
    }
}

/// `/^[A-Za-z0-9.$_-]{1,16}$/`: a name the page can show as it is.
fn showable(token: &str) -> bool {
    (1..=16).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'$' | b'_' | b'-'))
}

impl ChainBalance for RpcChainBalance {
    fn read(&self, address: &str) -> Result<WalletBalance, &'static str> {
        const UNREACHABLE: &str = "chain_unreachable";
        let address = address.to_lowercase();
        let chain_id = self
            .rpc("eth_chainId", Json::Array(vec![]))
            .ok()
            .as_ref()
            .and_then(quantity)
            .and_then(|n| i64::try_from(n).ok())
            .ok_or(UNREACHABLE)?;
        if chain_id != self.config.chain_id {
            return Err("chain_mismatch");
        }
        let block = self
            .rpc(
                "eth_getBlockByNumber",
                Json::Array(vec![Json::str("latest"), Json::Bool(false)]),
            )
            .map_err(|_| UNREACHABLE)?;
        // A pending block has no number: no moment to read at.
        let number = block.get("number").and_then(quantity).ok_or(UNREACHABLE)?;
        let timestamp = block
            .get("timestamp")
            .and_then(quantity)
            .and_then(|t| i64::try_from(t).ok())
            .and_then(|t| t.checked_mul(1000))
            .ok_or(UNREACHABLE)?;
        let at = format!("0x{number:x}");
        let units = self
            .uint(format!("{BALANCE_OF}{}", abi::address_word(&address)), &at)
            .map_err(|_| UNREACHABLE)?;
        let decimals = self
            .uint(abi::DECIMALS.to_owned(), &at)
            .map_err(|_| UNREACHABLE)?;
        let token = self
            .call(abi::SYMBOL.to_owned(), &at)
            .ok()
            .and_then(|out| abi::decode_string(&out))
            .ok_or(UNREACHABLE)?;
        // The token's own decimals, at the same block: a setting that disagrees with the chain would scale every
        // figure wrong and look right, so it refuses instead.
        if decimals != u128::from(self.config.token_decimals) {
            return Err("chain_mismatch");
        }
        if !showable(&token) {
            return Err(UNREACHABLE);
        }
        Ok(WalletBalance {
            available: to_amount_scale(units, self.config.token_decimals).ok_or(UNREACHABLE)?,
            token,
            chain_id,
            block: number.to_string(),
            as_of: Instant(timestamp).iso(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn units_scale_to_eighteen_places_rounding_down() {
        assert_eq!(
            to_amount_scale(1_500_000, 6),
            Some(Amount::from_scaled(1_500_000_000_000_000_000))
        );
        assert_eq!(to_amount_scale(7, 18), Some(Amount::from_scaled(7)));
        assert_eq!(to_amount_scale(1_999, 21), Some(Amount::from_scaled(1)));
        assert_eq!(to_amount_scale(19, 19), Some(Amount::from_scaled(1)));
        assert_eq!(to_amount_scale(9, 19), Some(Amount::ZERO));
        assert_eq!(to_amount_scale(5, 60), Some(Amount::ZERO));
    }

    #[test]
    fn only_a_short_plain_symbol_is_shown() {
        assert!(showable("USDC"));
        assert!(showable("TEST.USD$_-1"));
        assert!(!showable(""));
        assert!(!showable("<b>USDT</b>"));
        assert!(!showable("ABCDEFGHIJKLMNOPQ"));
    }
    // ── createChainBalance (chain-balance.test.ts), over a JSON-RPC node that answers as told ──

    use service_kit::http::{FetchError, HttpResponse};
    use std::sync::Mutex;

    const WALLET: &str = "0x00000000000000000000000000000000000A11CE";
    const TOKEN: &str = "0x000000000000000000000000000000000000d011";

    /// What the node answers; `Err` is a failed request, `None` a pending block.
    #[derive(Clone)]
    struct Answers {
        chain_id: Result<u64, ()>,
        block: Result<Option<u64>, ()>,
        balance: Result<u128, ()>,
        symbol: Result<&'static str, ()>,
        decimals: Result<u128, ()>,
    }

    impl Default for Answers {
        fn default() -> Answers {
            Answers {
                chain_id: Ok(84532),
                block: Ok(Some(1234)),
                balance: Ok(0),
                symbol: Ok("TESTUSD"),
                decimals: Ok(6),
            }
        }
    }

    struct Node {
        answers: Answers,
        asked: Mutex<Vec<(String, Json)>>,
    }

    fn word(n: u128) -> String {
        format!("{n:064x}")
    }

    fn abi_string(s: &str) -> String {
        let hex: String = s.bytes().map(|b| format!("{b:02x}")).collect();
        let padded = format!("{hex:0<width$}", width = hex.len().div_ceil(64).max(1) * 64);
        format!("0x{}{}{padded}", word(32), word(s.len() as u128))
    }

    impl Fetch for Node {
        fn fetch(&self, req: &HttpRequest) -> Result<HttpResponse, FetchError> {
            let body = json::parse(req.body.as_deref().unwrap_or("")).unwrap();
            let method = match body.get("method") {
                Some(Json::String(m)) => m.clone(),
                _ => panic!("no method"),
            };
            let params = body.get("params").cloned().unwrap_or(Json::Null);
            self.asked
                .lock()
                .unwrap()
                .push((method.clone(), params.clone()));
            let a = &self.answers;
            let result: Result<Json, ()> = match method.as_str() {
                "eth_chainId" => a.chain_id.map(|c| Json::str(format!("0x{c:x}"))),
                "eth_getBlockByNumber" => a.block.map(|b| {
                    Json::obj([
                        (
                            "number",
                            b.map_or(Json::Null, |n| Json::str(format!("0x{n:x}"))),
                        ),
                        ("timestamp", Json::str(format!("0x{:x}", 1_762_646_400u64))),
                    ])
                }),
                "eth_call" => {
                    let data = match &params {
                        Json::Array(p) => match p[0].get("data") {
                            Some(Json::String(d)) => d.clone(),
                            _ => panic!("no data"),
                        },
                        _ => panic!("no params"),
                    };
                    if data.starts_with(BALANCE_OF) {
                        a.balance.map(|n| Json::str(format!("0x{}", word(n))))
                    } else if data == abi::DECIMALS {
                        a.decimals.map(|n| Json::str(format!("0x{}", word(n))))
                    } else if data == abi::SYMBOL {
                        a.symbol.map(|s| Json::str(abi_string(s)))
                    } else {
                        panic!("unknown call {data}")
                    }
                }
                other => panic!("unknown method {other}"),
            };
            let body = match result {
                Ok(r) => Json::obj([
                    ("jsonrpc", Json::str("2.0")),
                    ("id", Json::int(1)),
                    ("result", r),
                ]),
                Err(()) => Json::obj([
                    ("jsonrpc", Json::str("2.0")),
                    ("id", Json::int(1)),
                    (
                        "error",
                        Json::obj([
                            ("code", Json::int(-32000)),
                            ("message", Json::str("execution reverted")),
                        ]),
                    ),
                ]),
            };
            Ok(HttpResponse {
                status: 200,
                body: body.compact(),
            })
        }
    }

    fn reader(answers: Answers) -> (RpcChainBalance, Arc<Node>) {
        let node = Arc::new(Node {
            answers,
            asked: Mutex::new(Vec::new()),
        });
        let config = PaymentToken {
            rpc_url: "http://127.0.0.1:9".to_owned(),
            chain_id: 84532,
            token_address: TOKEN.to_owned(),
            token_decimals: 6,
        };
        (
            RpcChainBalance::new(config, node.clone() as Arc<dyn Fetch>),
            node,
        )
    }

    #[test]
    fn reads_balance_of_at_the_latest_block_and_reports_that_block_and_its_time() {
        let (r, node) = reader(Answers {
            balance: Ok(4_000),
            ..Answers::default()
        });
        assert_eq!(
            r.read(WALLET),
            Ok(WalletBalance {
                available: Amount::from_scaled(4_000 * 10i128.pow(12)),
                token: "TESTUSD".to_owned(),
                chain_id: 84532,
                block: "1234".to_owned(),
                as_of: Instant(1_762_646_400_000).iso(),
            })
        );
        let calls: Vec<String> = node
            .asked
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _)| m == "eth_call")
            .map(|(_, p)| p.compact())
            .collect();
        let at = |data: String| {
            Json::Array(vec![
                Json::obj([("data", Json::str(data)), ("to", Json::str(TOKEN))]),
                Json::str("0x4d2"),
            ])
            .compact()
        };
        assert_eq!(
            calls,
            [
                at(format!(
                    "{BALANCE_OF}{}",
                    abi::address_word(&WALLET.to_lowercase())
                )),
                at(abi::DECIMALS.to_owned()),
                at(abi::SYMBOL.to_owned()),
            ]
        );
    }

    #[test]
    fn a_token_whose_decimals_on_the_chain_differ_from_the_setting_refuses_chain_mismatch() {
        let (r, _) = reader(Answers {
            balance: Ok(4_000),
            decimals: Ok(18),
            ..Answers::default()
        });
        assert_eq!(r.read(WALLET), Err("chain_mismatch"));
    }

    #[test]
    fn a_node_for_another_chain_refuses_chain_mismatch_and_reads_no_balance() {
        let (r, node) = reader(Answers {
            chain_id: Ok(1),
            ..Answers::default()
        });
        assert_eq!(r.read(WALLET), Err("chain_mismatch"));
        let asked: Vec<String> = node
            .asked
            .lock()
            .unwrap()
            .iter()
            .map(|(m, _)| m.clone())
            .collect();
        assert_eq!(asked, ["eth_chainId"]);
    }

    #[test]
    fn every_failed_or_unshowable_read_is_chain_unreachable_never_a_figure() {
        let d = Answers::default;
        for (label, answers) in [
            (
                "the node is down",
                Answers {
                    chain_id: Err(()),
                    ..d()
                },
            ),
            (
                "the block read fails",
                Answers {
                    block: Err(()),
                    ..d()
                },
            ),
            (
                "the latest block is pending",
                Answers {
                    block: Ok(None),
                    ..d()
                },
            ),
            (
                "the balance call fails",
                Answers {
                    balance: Err(()),
                    ..d()
                },
            ),
            (
                "the symbol call fails",
                Answers {
                    symbol: Err(()),
                    ..d()
                },
            ),
            (
                "the decimals call fails",
                Answers {
                    decimals: Err(()),
                    ..d()
                },
            ),
            (
                "the symbol is blank",
                Answers {
                    symbol: Ok(""),
                    ..d()
                },
            ),
            (
                "the symbol is markup",
                Answers {
                    symbol: Ok("<b>USDT</b>"),
                    ..d()
                },
            ),
        ] {
            assert_eq!(
                reader(answers).0.read(WALLET),
                Err("chain_unreachable"),
                "{label}"
            );
        }
    }
}
