//! The pure rules of the Navigator's on-chain calls (`onchain.ts`, `onchain-trade.ts` and `agents-onchain.ts`): which
//! chain it may hold a key on, the cap and the grant a person prepares, which asks are trades or move money out, and
//! how a trade ask is read.

use std::sync::LazyLock;

use service_kit::jsregex::{Regex, is_js_space};

use super::abi::FORBIDDEN_SELECTORS;

/// `NAVIGATOR_ONCHAIN_TEST_CHAIN_ID`.
pub const TEST_CHAIN_ID: i64 = 84_532;
/// `NAVIGATOR_ONCHAIN_MAINNET_CHAIN_IDS`.
pub const MAINNET_CHAIN_IDS: [i64; 1] = [8_453];

/// `NavigatorOnchainError`: a refusal whose code is the message the route answers with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused(pub &'static str);

pub const CAP_UNSET: &str = "agents.session_key_cap_unset";
pub const EXPIRY_UNSET: &str = "agents.session_key_expiry_unset";
pub const SELECTOR_FORBIDDEN: &str = "agents.session_key_selector_forbidden";
pub const CHAIN_UNSUPPORTED: &str = "agents.onchain_chain_unsupported";
pub const BINDING_NOT_FOUND: &str = "agents.onchain_binding_not_found";
pub const REQUEST_ID_REPLAY: &str = "agents.request_id_replay";
pub const MONEY_OUT_FORBIDDEN: &str = "agents.navigator_money_out_forbidden";
pub const TRADE_OVER_CAP: &str = "agents.navigator_trade_over_cap";
pub const NO_LIVE_KEY: &str = "agents.navigator_no_live_key";
pub const TRADE_UNPARSED: &str = "agents.navigator_trade_unparsed";
pub const TRADE_CAP_UNIT: &str = "agents.navigator_trade_cap_unit";
pub const TRADE_OUT_OF_SCOPE: &str = "agents.navigator_trade_out_of_scope";
pub const MARKET_UNSET: &str = "agents.navigator_market_unset";
pub const TRADE_UNQUOTED: &str = "agents.navigator_trade_unquoted";
pub const ACCOUNT_NOT_YOURS: &str = "agents.navigator_account_not_yours";
pub const ACCOUNT_UNPROVEN: &str = "agents.navigator_account_unproven";
pub const RAIL_CRYPTO: &str = "rail.crypto";
pub const AUDIT_EXTERNAL: &str = "audit.external";

/// `HTTP`: the tRPC code each refusal answers with.
pub fn http_code(code: &str) -> &'static str {
    match code {
        CAP_UNSET | EXPIRY_UNSET | CHAIN_UNSUPPORTED | TRADE_UNPARSED | TRADE_CAP_UNIT => {
            "BAD_REQUEST"
        }
        SELECTOR_FORBIDDEN | MONEY_OUT_FORBIDDEN | TRADE_OVER_CAP | TRADE_OUT_OF_SCOPE
        | ACCOUNT_NOT_YOURS => "FORBIDDEN",
        BINDING_NOT_FOUND => "NOT_FOUND",
        REQUEST_ID_REPLAY => "CONFLICT",
        _ => "PRECONDITION_FAILED",
    }
}

/// `navigatorSigner`: the test network is the one chain the Navigator may hold a key on; a mainnet refuses
/// `audit.external`, any other chain is unsupported, and with no signer every chain refuses `rail.crypto`.
pub fn navigator_signer(chain_id: i64, configured: Option<&str>) -> Result<String, Refused> {
    if MAINNET_CHAIN_IDS.contains(&chain_id) {
        return Err(Refused(AUDIT_EXTERNAL));
    }
    if chain_id != TEST_CHAIN_ID {
        return Err(Refused(CHAIN_UNSUPPORTED));
    }
    match configured.filter(|s| !s.is_empty()) {
        Some(s) => Ok(s.to_owned()),
        None => Err(Refused(RAIL_CRYPTO)),
    }
}

/// `capWei`: one to 39 digits, at most uint128; anything else refuses `agents.session_key_cap_unset`.
pub fn cap_wei(raw: Option<&str>) -> Result<u128, Refused> {
    let text = service_kit::schema::js_trim(raw.unwrap_or(""));
    if text.is_empty() || text.len() > 39 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Refused(CAP_UNSET));
    }
    text.parse::<u128>().map_err(|_| Refused(CAP_UNSET))
}

/// `bindKey`.
pub fn bind_key(chain_id: i64, account: &str, session_key: &str) -> String {
    format!(
        "agents:onchain:navigator:{chain_id}:{}:{}",
        account.to_lowercase(),
        session_key.to_lowercase()
    )
}

/// `preparedGrant`: the cap, the expiry, and no selector that could move tokens out.
pub fn prepared_grant(
    spend_limit_wei: Option<&str>,
    valid_until: Option<i64>,
    selectors: &[String],
) -> Result<(u128, i64), Refused> {
    let cap = cap_wei(spend_limit_wei)?;
    let Some(until) = valid_until.filter(|v| *v != 0) else {
        return Err(Refused(EXPIRY_UNSET));
    };
    if selectors
        .iter()
        .any(|s| FORBIDDEN_SELECTORS.contains(&s.to_lowercase().as_str()))
    {
        return Err(Refused(SELECTOR_FORBIDDEN));
    }
    Ok((cap, until))
}

/// A pattern this file names, written for text whose ASCII letters are lower-cased: that is what the TypeScript's `i`
/// flag does to these patterns, whose letters are all ASCII (outside `u` mode no other character folds to one).
fn rule(literal: &str) -> Option<Regex> {
    Regex::new(literal).ok()
}

static TRADE_RULE: LazyLock<Option<Regex>> =
    LazyLock::new(|| rule(r"/\b(?:swap|buy|sell|trade|order)\b/"));
// `[^]` is written `[\s\S]`: the same set, every code unit.
static MONEY_OUT_RULE: LazyLock<Option<Regex>> = LazyLock::new(|| {
    rule(r"/\bwithdraw(?:al)?\b|\b(?:send|transfer|pay)\b[\s\S]*\b0x[0-9a-f]{40}\b/")
});
static QUESTION: LazyLock<Option<Regex>> = LazyLock::new(|| rule(r"/\?\s*$/"));
static REQUEST_AS_QUESTION: LazyLock<Option<Regex>> =
    LazyLock::new(|| rule(r"/^\s*(?:test:\s*)?(?:please\s+)?(?:can|could|would|will)\s+you\b/"));

fn test(r: &LazyLock<Option<Regex>>, folded: &str) -> bool {
    r.as_ref().is_some_and(|r| r.test(folded))
}

fn is_request(folded: &str) -> bool {
    !test(&QUESTION, folded) || test(&REQUEST_AS_QUESTION, folded)
}

/// `navigatorAskIsTrade`.
pub fn ask_is_trade(text: &str) -> bool {
    let folded = text.to_ascii_lowercase();
    test(&TRADE_RULE, &folded) && is_request(&folded)
}

/// `navigatorAskMovesMoneyOut`.
pub fn ask_moves_money_out(text: &str) -> bool {
    let folded = text.to_ascii_lowercase();
    test(&MONEY_OUT_RULE, &folded) && is_request(&folded)
}

/// What `parseTradeAsk` reads from a trade ask.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TradeAsk {
    pub amount: String,
    pub token_in: String,
    pub token_out: String,
}

fn js_space(c: char) -> bool {
    u16::try_from(u32::from(c)).is_ok_and(is_js_space)
}

/// What `.` refuses: the four line terminators.
fn line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// The word at `at`, ASCII letters in either case (the `i` flag); the end of the word, or none.
fn word(c: &[char], at: usize, w: &str) -> Option<usize> {
    let mut i = at;
    for wc in w.chars() {
        let got = *c.get(i)?;
        if !got.eq_ignore_ascii_case(&wc) {
            return None;
        }
        i += 1;
    }
    Some(i)
}

fn spaces(c: &[char], at: usize) -> usize {
    let mut i = at;
    while c.get(i).copied().is_some_and(js_space) {
        i += 1;
    }
    i
}

fn digits(c: &[char], at: usize) -> usize {
    let mut i = at;
    while c.get(i).is_some_and(char::is_ascii_digit) {
        i += 1;
    }
    i
}

/// `(?:\s+on-chain)?\s*[.!]?\s*$` from `at`: whether it matches at all (it captures nothing).
fn tail(c: &[char], at: usize) -> bool {
    let rest = |from: usize| {
        let i = spaces(c, from);
        if i == c.len() {
            return true;
        }
        matches!(c.get(i), Some('.' | '!')) && spaces(c, i + 1) == c.len()
    };
    let s = spaces(c, at);
    (s > at && word(c, s, "on-chain").is_some_and(rest)) || rest(at)
}

/// `\s+(?:for|into)\s+(.+?)` and the tail, from `at`: the token out, as the backtracking matcher finds it.
fn token_out(c: &[char], at: usize) -> Option<(usize, usize)> {
    let s = spaces(c, at);
    if s == at {
        return None;
    }
    let after = word(c, s, "for").or_else(|| word(c, s, "into"))?;
    let end_spaces = spaces(c, after);
    // `\s+` gives back one space at a time, longest first; `.+?` then takes the fewest characters the tail allows.
    for start in (after + 1..=end_spaces).rev() {
        let mut end = start;
        while let Some(&ch) = c.get(end) {
            if line_end(ch) {
                break;
            }
            end += 1;
            if tail(c, end) {
                return Some((start, end));
            }
        }
    }
    None
}

/// `parseTradeAsk`: "swap <amount> <token> for <token>" (also sell or trade, for or into), after an optional `TEST:`
/// label, matched as `ASK` matches it in JavaScript. Written by hand: the pattern's lazy groups are read here in the
/// order a backtracking matcher tries them.
pub fn parse_trade_ask(text: &str) -> Option<TradeAsk> {
    let c: Vec<char> = text.chars().collect();
    let mut i = spaces(&c, 0);
    if let Some(after) = word(&c, i, "test:") {
        i = spaces(&c, after);
    }
    if let Some(after) = word(&c, i, "please") {
        let s = spaces(&c, after);
        if s > after {
            i = s;
        }
    }
    let verb = word(&c, i, "swap")
        .or_else(|| word(&c, i, "sell"))
        .or_else(|| word(&c, i, "trade"))?;
    let amount_at = spaces(&c, verb);
    if amount_at == verb {
        return None;
    }
    let whole = digits(&c, amount_at);
    if whole == amount_at {
        return None;
    }
    let mut amount_end = whole;
    if c.get(whole) == Some(&'.') {
        let frac = digits(&c, whole + 1);
        if frac > whole + 1 {
            amount_end = frac;
        }
    }
    let in_spaces = spaces(&c, amount_end);
    if in_spaces == amount_end {
        return None;
    }
    let collect = |a: usize, b: usize| c.get(a..b).map(|s| s.iter().collect::<String>());
    for start in (amount_end + 1..=in_spaces).rev() {
        let mut end = start;
        while let Some(&ch) = c.get(end) {
            if line_end(ch) {
                break;
            }
            end += 1;
            if let Some((o_start, o_end)) = token_out(&c, end) {
                let trim = |s: String| service_kit::schema::js_trim(&s).to_owned();
                return Some(TradeAsk {
                    amount: collect(amount_at, amount_end)?,
                    token_in: trim(collect(start, end)?),
                    token_out: trim(collect(o_start, o_end)?),
                });
            }
        }
    }
    None
}

/// `toUnits`'s answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Units {
    Exact(u128),
    /// A valid amount past what uint128 holds: above any cap a key can carry.
    PastCap,
    Invalid,
}

/// `toUnits(text, decimals)`: an exact decimal in the token's smallest unit, never a float.
pub fn to_units(text: &str, decimals: u32) -> Units {
    let (whole, frac) = text
        .split_once('.')
        .map_or((text, None), |(w, f)| (w, Some(f)));
    let all_digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if whole.is_empty() || whole.len() > 30 || !all_digits(whole) {
        return Units::Invalid;
    }
    let frac = match frac {
        None => "",
        Some(f) if !f.is_empty() && f.len() <= 36 && all_digits(f) => f,
        Some(_) => return Units::Invalid,
    };
    if u32::try_from(frac.len()).map_or(true, |n| n > decimals) {
        return Units::Invalid;
    }
    let Some(scale) = 10u128.checked_pow(decimals) else {
        // Past uint128 unless the amount is zero.
        return if whole.bytes().chain(frac.bytes()).all(|b| b == b'0') {
            Units::Exact(0)
        } else {
            Units::PastCap
        };
    };
    let padded = format!(
        "{frac:0<width$}",
        width = usize::try_from(decimals).unwrap_or(0)
    );
    let (Ok(w), Ok(f)) = (
        whole.parse::<u128>(),
        if padded.is_empty() {
            Ok(0)
        } else {
            padded.parse::<u128>()
        },
    ) else {
        return Units::PastCap;
    };
    match w.checked_mul(scale).and_then(|n| n.checked_add(f)) {
        Some(n) => Units::Exact(n),
        None => Units::PastCap,
    }
}

/// `quoted * (10000 - slippageBps) / 10000`, exact without overflow: `quoted = a * 10000 + b`.
pub fn min_out(quoted: u128, slippage_bps: u32) -> u128 {
    let keep = u128::from(10_000u32.saturating_sub(slippage_bps));
    let (a, b) = (quoted / 10_000, quoted % 10_000);
    a * keep + b * keep / 10_000
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(a: &str, i: &str, o: &str) -> Option<TradeAsk> {
        Some(TradeAsk {
            amount: a.to_owned(),
            token_in: i.to_owned(),
            token_out: o.to_owned(),
        })
    }

    #[test]
    fn a_trade_ask_is_read_as_the_typescript_reads_it() {
        assert_eq!(
            parse_trade_ask("swap 0.5 WETH for USDC"),
            ask("0.5", "WETH", "USDC")
        );
        assert_eq!(
            parse_trade_ask("TEST: please Sell 1 wrapped ether into test usd on-chain."),
            ask("1", "wrapped ether", "test usd")
        );
        assert_eq!(
            parse_trade_ask("trade 2 a for b for c"),
            ask("2", "a", "b for c")
        );
        assert_eq!(
            parse_trade_ask("swap 1 WETH for USDC on-chain"),
            ask("1", "WETH", "USDC")
        );
        // `.+?` takes a space when nothing else is left: the token out is then blank.
        assert_eq!(parse_trade_ask("swap 1 a for  "), ask("1", "a", ""));
        assert_eq!(parse_trade_ask("buy 1 WETH for USDC"), None);
        assert_eq!(parse_trade_ask("swap 1. a for b"), None);
        assert_eq!(parse_trade_ask("swap 1 a\nb for c"), None);
        assert_eq!(parse_trade_ask("swap 1 a for b\n"), ask("1", "a", "b"));
        assert_eq!(
            parse_trade_ask(" swap  3   x  into  y ! "),
            ask("3", "x", "y")
        );
        assert_eq!(
            parse_trade_ask("swap 1 a for on-chain"),
            ask("1", "a", "on-chain")
        );
        assert_eq!(
            parse_trade_ask("swap 1 a  for b on-chain on-chain"),
            ask("1", "a", "b on-chain")
        );
    }

    #[test]
    fn trades_and_money_out_are_whole_words_and_a_question_is_not_a_request() {
        assert!(ask_is_trade("Swap 1 WETH for USDC"));
        assert!(ask_is_trade("Can you BUY some?"));
        assert!(!ask_is_trade("where do I place a limit order?"));
        assert!(!ask_is_trade("swapping is fun"));
        assert!(ask_moves_money_out("Withdraw everything"));
        assert!(ask_moves_money_out(&format!(
            "send it\nto 0x{}",
            "AB".repeat(20)
        )));
        assert!(!ask_moves_money_out("send it to my friend"));
    }

    #[test]
    fn units_are_exact_and_a_cap_is_at_most_uint128() {
        assert_eq!(to_units("1.5", 18), Units::Exact(1_500_000_000_000_000_000));
        assert_eq!(to_units("1.5", 0), Units::Invalid);
        assert_eq!(to_units("1", 200), Units::PastCap);
        assert_eq!(to_units("0", 200), Units::Exact(0));
        assert_eq!(to_units("1.", 18), Units::Invalid);
        assert_eq!(cap_wei(Some(" 007 ")), Ok(7));
        assert_eq!(cap_wei(Some(&u128::MAX.to_string())), Ok(u128::MAX));
        assert_eq!(
            cap_wei(Some("340282366920938463463374607431768211456")),
            Err(Refused(CAP_UNSET))
        );
        assert_eq!(cap_wei(None), Err(Refused(CAP_UNSET)));
        assert_eq!(
            min_out(u128::MAX, 50),
            u128::MAX / 10_000 * 9_950 + (u128::MAX % 10_000) * 9_950 / 10_000
        );
        assert_eq!(min_out(1_000, 50), 995);
    }

    // Ported case for case from `navigator/onchain.test.ts`.

    const SIGNER: &str = "0x00000000000000000000000000000000005e0019";

    #[test]
    fn the_signer_is_the_configured_address_on_the_test_network_only() {
        assert_eq!(
            navigator_signer(84_532, Some(SIGNER)),
            Ok(SIGNER.to_owned())
        );
        assert_eq!(
            navigator_signer(8_453, Some(SIGNER)),
            Err(Refused(AUDIT_EXTERNAL))
        );
        assert_eq!(navigator_signer(84_532, None), Err(Refused(RAIL_CRYPTO)));
        assert_eq!(
            navigator_signer(84_532, Some("")),
            Err(Refused(RAIL_CRYPTO))
        );
        assert_eq!(
            navigator_signer(1, Some(SIGNER)),
            Err(Refused(CHAIN_UNSUPPORTED))
        );
    }

    #[test]
    fn a_prepared_grant_refuses_a_bad_cap_a_missing_expiry_and_a_forbidden_selector() {
        let swap = vec!["0xabababab".to_owned()];
        for cap in [
            None,
            Some(""),
            Some("  "),
            Some("1.5"),
            Some("-1"),
            Some("one"),
            Some("1e18"),
        ] {
            assert_eq!(
                prepared_grant(cap, Some(2_000_000_000), &swap),
                Err(Refused(CAP_UNSET))
            );
        }
        assert_eq!(
            cap_wei(Some("1000000000000000000")),
            Ok(1_000_000_000_000_000_000)
        );
        assert_eq!(cap_wei(Some("0")), Ok(0));
        assert_eq!(
            prepared_grant(Some("1000"), None, &swap),
            Err(Refused(EXPIRY_UNSET))
        );
        for sel in [
            "0x095ea7b3",
            "0x095EA7B3",
            "0xd505accf",
            "0xa9059cbb",
            "0x23b872dd",
            "0xa22cb465",
        ] {
            let selectors = vec![swap[0].clone(), sel.to_owned()];
            assert_eq!(
                prepared_grant(Some("1000"), Some(1), &selectors),
                Err(Refused(SELECTOR_FORBIDDEN))
            );
        }
        assert_eq!(
            prepared_grant(Some("1000"), Some(2_000_000_000), &swap),
            Ok((1000, 2_000_000_000))
        );
        assert_eq!(
            bind_key(
                84_532,
                "0xABCDEF0000000000000000000000000000000001",
                "0x00000000000000000000000000000000005E0019"
            ),
            "agents:onchain:navigator:84532:0xabcdef0000000000000000000000000000000001:0x00000000000000000000000000000000005e0019"
        );
    }

    #[test]
    fn the_trade_rule_reads_whole_words_and_leaves_questions_to_the_ordinary_run() {
        for ask in [
            "TEST: swap 0.1 TEST Wrapped ETH for TEST Token B",
            "Buy some",
            "SELL it all",
            "trade now",
            "place an order",
            "Can you buy 1 TEST Token A?",
            "TEST: please could you sell it all?",
        ] {
            assert!(ask_is_trade(ask), "{ask}");
        }
        for ask in [
            "what moved today?",
            "swapping words is not swaps",
            "buyer",
            "disorder",
            "tradeoffs",
            "reorder the list",
            "Where do I place a limit order?",
            "TEST: what is a market order?",
            "TEST: and a stop order?",
        ] {
            assert!(!ask_is_trade(ask), "{ask}");
        }
        for ask in [
            "withdraw it".to_owned(),
            format!("TEST: send 1 TESTB to 0x{}", "ab".repeat(20)),
            format!("Pay 0x{} now", "cd".repeat(20)),
            "can you withdraw?".to_owned(),
        ] {
            assert!(ask_moves_money_out(&ask), "{ask}");
        }
        for ask in [
            "send me a summary",
            "how do withdrawals work?",
            "what does it pay?",
            "transfer pricing explained",
        ] {
            assert!(!ask_moves_money_out(ask), "{ask}");
        }
    }

    #[test]
    fn only_swap_amount_token_for_token_parses_and_amounts_stay_exact() {
        assert_eq!(
            parse_trade_ask("TEST: swap 0.1 TEST Wrapped ETH for TEST Token B"),
            ask("0.1", "TEST Wrapped ETH", "TEST Token B")
        );
        assert_eq!(
            parse_trade_ask("sell 2 TESTWETH into TESTB on-chain."),
            ask("2", "TESTWETH", "TESTB")
        );
        for a in [
            "buy some",
            "swap all TESTWETH for TESTB",
            "swap -1 TESTWETH for TESTB",
            "swap 1e3 TESTWETH for TESTB",
        ] {
            assert_eq!(parse_trade_ask(a), None, "{a}");
        }
        assert_eq!(to_units("0.1", 18), Units::Exact(100_000_000_000_000_000));
        assert_eq!(
            to_units("123456789.123456789123456789", 18),
            Units::Exact(123_456_789_123_456_789_123_456_789)
        );
        assert_eq!(to_units("1.0000001", 6), Units::Invalid);
        assert_eq!(to_units("1.", 18), Units::Invalid);
    }

    #[test]
    fn the_module_holds_to_the_floor_no_ledger_no_metering_no_key() {
        let source = [
            include_str!("mod.rs"),
            include_str!("rules.rs"),
            include_str!("store.rs"),
            include_str!("trade.rs"),
            include_str!("ports.rs"),
            include_str!("abi.rs"),
        ]
        .concat();
        for banned in [
            ["crate::", "metering"].concat(),
            ["ledger", "_client"].concat(),
            ["gateway", "."].concat(),
            ["private", "_key"].concat(),
            ["sign", "_transaction"].concat(),
        ] {
            assert!(!source.contains(&banned), "{banned}");
        }
    }
}
