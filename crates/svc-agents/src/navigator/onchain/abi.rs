//! The few ABI words the Navigator's calls need: the selectors and the event topic (keccak-256 of their signatures, as
//! viem's `toFunctionSelector` and `toEventSelector` print them), the two calls it builds (held byte for byte to viem's
//! `encodeFunctionData` by this file's tests) and the answers it reads. No value is ever encoded here: the session
//! call carries 0.

/// `executeWithSession((address,uint48,uint48,uint128,address[],bytes4[]),address,uint256,bytes)`.
pub const EXECUTE_WITH_SESSION: &str = "0xbd210fed";
/// The router's `swapExactIn(address,address,uint256,uint256,address)` (`ROUTER_SWAP_EXACT_IN`).
pub const SWAP_EXACT_IN: &str = "0x7b32b50e";
pub const QUOTE_EXACT_IN: &str = "0x12be4fe0";
pub const GET_SESSION: &str = "0x8c8e13b9";
pub const IS_SESSION_LIVE: &str = "0xa60e7784";
pub const OWNER: &str = "0x8da5cb5b";
pub const TOKEN0: &str = "0x0dfe1681";
pub const TOKEN1: &str = "0xd21220a7";
pub const SYMBOL: &str = "0x95d89b41";
pub const NAME: &str = "0x06fdde03";
pub const DECIMALS: &str = "0x313ce567";
/// `SessionGranted(address indexed,bytes32,uint48,uint48,uint128,address[],bytes4[])`.
pub const SESSION_GRANTED: &str = "0xaf799c7b981e0459ce6e7dbc52e978c14130be55c2f5c15fce7206e827b8a9ef";

/// `FORBIDDEN_SELECTORS`: transfer, transferFrom, approve, increaseAllowance, permit, setApprovalForAll and both
/// safeTransferFrom: no session key may hold one.
pub const FORBIDDEN_SELECTORS: [&str; 8] = [
    "0xa9059cbb",
    "0x23b872dd",
    "0x095ea7b3",
    "0x39509351",
    "0xd505accf",
    "0xa22cb465",
    "0x42842e0e",
    "0xb88d4fde",
];

fn hex_body(h: &str) -> &str {
    h.strip_prefix("0x").or_else(|| h.strip_prefix("0X")).unwrap_or(h)
}

/// One 32-byte word holding an address (left-padded).
pub fn address_word(a: &str) -> String {
    format!("{:0>64}", hex_body(a).to_lowercase())
}

/// One 32-byte word holding an unsigned integer.
pub fn uint_word(n: u128) -> String {
    format!("{n:064x}")
}

/// A `bytes4` in its word: right-padded.
fn bytes4_word(s: &str) -> String {
    format!("{:0<64}", hex_body(s).to_lowercase())
}

fn len_word(n: usize) -> String {
    uint_word(n as u128)
}

/// `swapExactIn(pool, tokenIn, amountIn, minAmountOut, to)`.
pub fn swap_exact_in(pool: &str, token_in: &str, amount_in: u128, min_out: u128, to: &str) -> String {
    format!(
        "{SWAP_EXACT_IN}{}{}{}{}{}",
        address_word(pool),
        address_word(token_in),
        uint_word(amount_in),
        uint_word(min_out),
        address_word(to)
    )
}

/// The granted spec a session call names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spec {
    pub key: String,
    pub valid_after: u64,
    pub valid_until: u64,
    pub spend_limit_wei: u128,
    pub targets: Vec<String>,
    pub selectors: Vec<String>,
}

/// `executeWithSession(spec, target, 0, data)`: the spec tuple and the inner call are dynamic, so both go by offset.
pub fn execute_with_session(spec: &Spec, target: &str, inner: &str) -> String {
    let nt = spec.targets.len();
    let ns = spec.selectors.len();
    // The tuple: six head words, then each array's length and items.
    let mut tuple = String::new();
    tuple.push_str(&address_word(&spec.key));
    tuple.push_str(&uint_word(u128::from(spec.valid_after)));
    tuple.push_str(&uint_word(u128::from(spec.valid_until)));
    tuple.push_str(&uint_word(spec.spend_limit_wei));
    tuple.push_str(&len_word(6 * 32));
    tuple.push_str(&len_word(6 * 32 + 32 * (1 + nt)));
    tuple.push_str(&len_word(nt));
    for t in &spec.targets {
        tuple.push_str(&address_word(t));
    }
    tuple.push_str(&len_word(ns));
    for s in &spec.selectors {
        tuple.push_str(&bytes4_word(s));
    }
    let data = hex_body(inner).to_lowercase();
    let data_len = data.len() / 2;
    let padded = data_len.div_ceil(32) * 32;
    let mut bytes = len_word(data_len);
    bytes.push_str(&data);
    bytes.push_str(&"0".repeat((padded - data_len) * 2));
    let head = 4 * 32;
    format!(
        "{EXECUTE_WITH_SESSION}{}{}{}{}{tuple}{bytes}",
        len_word(head),
        address_word(target),
        uint_word(0),
        len_word(head + tuple.len() / 2),
    )
}

/// The 32-byte words of a hex answer.
pub fn words(data: &str) -> Vec<&str> {
    let body = hex_body(data);
    (0..body.len() / 64).filter_map(|i| body.get(i * 64..(i + 1) * 64)).collect()
}

/// A word read as an unsigned integer that fits 128 bits; none when it does not.
pub fn word_uint(w: &str) -> Option<u128> {
    let (high, low) = w.split_at_checked(32)?;
    if high.bytes().any(|b| b != b'0') {
        return None;
    }
    u128::from_str_radix(low, 16).ok()
}

/// A word read as an address, lower case with its 0x.
pub fn word_address(w: &str) -> Option<String> {
    w.get(24..).map(|a| format!("0x{a}"))
}

fn word_at<'a>(ws: &[&'a str], i: usize) -> Option<&'a str> {
    ws.get(i).copied()
}

fn offset(ws: &[&str], i: usize) -> Option<usize> {
    usize::try_from(word_uint(word_at(ws, i)?)?).ok().filter(|o| o % 32 == 0).map(|o| o / 32)
}

/// A dynamic array of words at the head word `i`.
fn array_at<'a>(ws: &[&'a str], i: usize) -> Option<Vec<&'a str>> {
    let at = offset(ws, i)?;
    let n = usize::try_from(word_uint(word_at(ws, at)?)?).ok()?;
    (0..n).map(|k| word_at(ws, at + 1 + k)).collect()
}

/// A `string` answer (`symbol()`, `name()`).
pub fn decode_string(data: &str) -> Option<String> {
    let body = hex_body(data);
    let ws = words(data);
    let at = offset(&ws, 0)?;
    let n = usize::try_from(word_uint(word_at(&ws, at)?)?).ok()?;
    let start = (at + 1) * 64;
    let hex = body.get(start..start + n * 2)?;
    let bytes: Option<Vec<u8>> = (0..n)
        .map(|k| hex.get(k * 2..k * 2 + 2).and_then(|b| u8::from_str_radix(b, 16).ok()))
        .collect();
    String::from_utf8(bytes?).ok()
}

/// `SessionGranted`'s data: the hash, the window, the cap, the targets and the selectors (lower case).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Granted {
    pub spec_hash: String,
    pub valid_after: u64,
    pub valid_until: u64,
    pub spend_limit_wei: u128,
    pub targets: Vec<String>,
    pub selectors: Vec<String>,
}

pub fn decode_granted(data: &str) -> Option<Granted> {
    let ws = words(data);
    let small = |i: usize| word_uint(word_at(&ws, i)?).and_then(|n| u64::try_from(n).ok());
    Some(Granted {
        spec_hash: format!("0x{}", word_at(&ws, 0)?),
        valid_after: small(1)?,
        valid_until: small(2)?,
        spend_limit_wei: word_uint(word_at(&ws, 3)?)?,
        targets: array_at(&ws, 4)?.into_iter().map(word_address).collect::<Option<_>>()?,
        selectors: array_at(&ws, 5)?
            .into_iter()
            .map(|w| w.get(..8).map(|s| format!("0x{s}")))
            .collect::<Option<_>>()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_string_answer_decodes_and_a_short_one_does_not() {
        let data = format!("0x{}{}{:0<64}", uint_word(32), uint_word(5), "4142434445");
        assert_eq!(decode_string(&data).as_deref(), Some("ABCDE"));
        assert_eq!(decode_string("0x00"), None);
    }

    /// Recorded from viem's `encodeFunctionData` (onchain-trade.ts's ABI) on 2026-11-21.
    const VIEM_SWAP: &str = "0x7b32b50e0000000000000000000000001111111111111111111111111111111111111111000000000000000000000000222222222222222222222222222222222222222200000000000000000000000000000000000000000000000000000000000003e800000000000000000000000000000000000000000000000000000000000003e30000000000000000000000003333333333333333333333333333333333333333";
    const VIEM_EXECUTE: &str = "0xbd210fed00000000000000000000000000000000000000000000000000000000000000800000000000000000000000005555555555555555555555555555555555555555000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002200000000000000000000000004444444444444444444444444444444444444444000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000713fb3000000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000000020000000000000000000000005555555555555555555555555555555555555555000000000000000000000000666666666666666666666666666666666666666600000000000000000000000000000000000000000000000000000000000000037b32b50e0000000000000000000000000000000000000000000000000000000012be4fe000000000000000000000000000000000000000000000000000000000deadbeef0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a47b32b50e0000000000000000000000001111111111111111111111111111111111111111000000000000000000000000222222222222222222222222222222222222222200000000000000000000000000000000000000000000000000000000000003e800000000000000000000000000000000000000000000000000000000000003e3000000000000000000000000333333333333333333333333333333333333333300000000000000000000000000000000000000000000000000000000";

    #[test]
    fn the_session_call_is_encoded_byte_for_byte_as_viem_encodes_it() {
        let a = |c: &str| format!("0x{}", c.repeat(40));
        let swap = swap_exact_in(&a("1"), &a("2"), 1000, 995, &a("3"));
        assert_eq!(swap, VIEM_SWAP);
        let spec = Spec {
            key: a("4"),
            valid_after: 5,
            valid_until: 1_900_000_000,
            spend_limit_wei: 1_000_000_000_000_000_000,
            targets: vec![a("5"), a("6")],
            selectors: vec!["0x7b32b50e".to_owned(), "0x12be4fe0".to_owned(), "0xdeadbeef".to_owned()],
        };
        assert_eq!(execute_with_session(&spec, &a("5"), &swap), VIEM_EXECUTE);
    }

    #[test]
    fn a_word_past_128_bits_is_no_number() {
        assert_eq!(word_uint(&format!("{:0>64}", "1")), Some(1));
        assert_eq!(word_uint(&format!("1{:0>63}", "")), None);
    }
}
