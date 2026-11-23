//! `research/provenance.ts`: where a Navigator answer about a market got its facts (RC-agents-09). Before the engine,
//! [`prepare_research`] reads each market the ask names from the trade plane itself; a blank uncertainty scale or a
//! market it cannot read refuses before the run row and the engine, so nothing runs and nothing is charged. After the
//! engine answers, [`build_provenance`] checks each sentence of the reply against the sources the service read; the
//! provenance is stored with the reply in the same write. An ask that names no market is not research.

use service_kit::json::Json;
use service_kit::schema::js_trim;

use crate::audit::param;
use crate::runtime::{RunError, denied};

use super::ports::{TradeData, read_live_quote, symbol_to_market_id};
use super::tools::date_parse;

/// `RESEARCH_MAX_MARKETS`.
pub const RESEARCH_MAX_MARKETS: usize = 5;

/// `RESEARCH_ASSUMPTIONS`.
pub const RESEARCH_ASSUMPTIONS: [&str; 2] = ["last_trade_at_observation", "named_markets_only"];

/// What `run.complete` reads research with: the owner's scale (none: unset) and where the market data is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Research {
    pub scale: Option<Vec<String>>,
    pub environment: String,
}

impl Research {
    /// No scale, TEST data.
    pub fn unwired() -> Research {
        Research {
            scale: None,
            environment: "TEST".to_owned(),
        }
    }
}

fn upper_alnum(c: char) -> bool {
    c.is_ascii_uppercase() || c.is_ascii_digit()
}

fn word_or_slash(c: Option<&char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || *c == '/')
}

/// `[A-Z][A-Z0-9]{1,9}` at `at`, greedy: its end, when the whole run of capitals and digits is two to ten long.
fn ticker(c: &[char], at: usize) -> Option<usize> {
    if !c.get(at).is_some_and(char::is_ascii_uppercase) {
        return None;
    }
    let mut end = at;
    while c.get(end).copied().is_some_and(upper_alnum) {
        end += 1;
    }
    (2..=10).contains(&(end - at)).then_some(end)
}

/// `namedMarkets`: the markets `text` names (`BTC/USDT`, not inside a longer word), in order, each once, at most
/// five. `MARKET_IN_TEXT`'s look-behind and look-ahead read as here: no letter, digit or slash on either side.
pub fn named_markets(text: &str) -> Vec<String> {
    let c: Vec<char> = text.chars().collect();
    let mut seen: Vec<String> = Vec::new();
    let mut i = 0;
    while i < c.len() {
        let before_ok = i == 0 || !word_or_slash(c.get(i - 1));
        let found = before_ok
            .then(|| ticker(&c, i))
            .flatten()
            .filter(|slash| c.get(*slash) == Some(&'/'))
            .and_then(|slash| ticker(&c, slash + 1).map(|end| (slash, end)))
            .filter(|(_, end)| !word_or_slash(c.get(*end)));
        match found {
            Some((slash, end)) => {
                let base: String = c.get(i..slash).unwrap_or_default().iter().collect();
                let quote: String = c.get(slash + 1..end).unwrap_or_default().iter().collect();
                let market = format!("{base}/{quote}");
                if !seen.contains(&market) {
                    seen.push(market);
                }
                if seen.len() == RESEARCH_MAX_MARKETS {
                    break;
                }
                i = end;
            }
            None => i += 1,
        }
    }
    seen
}

/// `parseUncertaintyScale`: blank is unset; fewer than two labels, a blank one or a repeat stops the boot.
pub fn parse_uncertainty_scale(raw: Option<&str>) -> Result<Option<Vec<String>>, String> {
    let Some(raw) = raw.filter(|r| !js_trim(r).is_empty()) else {
        return Ok(None);
    };
    let labels: Vec<String> = raw.split(',').map(|l| js_trim(l).to_owned()).collect();
    let distinct = labels
        .iter()
        .enumerate()
        .all(|(i, l)| !labels.iter().take(i).any(|p| p == l));
    if labels.len() < 2 || labels.iter().any(String::is_empty) || !distinct {
        return Err(
            "AGENTS_RESEARCH_UNCERTAINTY_SCALE needs at least two distinct comma-separated labels, lowest first".to_owned(),
        );
    }
    Ok(Some(labels))
}

/// `researchEnvironment`.
pub fn research_environment(app_env: &str) -> &'static str {
    match app_env {
        "prod" => "live",
        "staging" => "testnet",
        _ => "TEST",
    }
}

/// One source the service read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub id: String,
    pub market: String,
    pub value: String,
    pub observed_at: String,
}

impl Source {
    fn to_json(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("market", Json::str(self.market.clone())),
            ("measure", Json::str("last_price")),
            ("value", Json::str(self.value.clone())),
            ("observedAt", Json::str(self.observed_at.clone())),
        ])
    }
}

/// `ResearchPlan`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub sources: Vec<Source>,
    pub scale: Vec<String>,
    pub environment: String,
    /// The sources as the engine reads them, appended to its system text.
    pub system: String,
}

fn decimal(v: &str) -> bool {
    let (whole, frac) = v.split_once('.').map_or((v, None), |(w, f)| (w, Some(f)));
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    digits(whole) && frac.is_none_or(digits)
}

/// `prepareResearch`: none when the ask names no market; else each market's last price, read by the service.
pub fn prepare_research(
    ask: &str,
    port: Option<&dyn TradeData>,
    research: &Research,
) -> Result<Option<Plan>, RunError> {
    let markets = named_markets(ask);
    if markets.is_empty() {
        return Ok(None);
    }
    let Some(scale) = research.scale.clone() else {
        return Err(RunError::Agent(denied(
            "agents.uncertainty_scale_unset",
            "agents.refused.uncertainty_scale_unset",
            "research answer refused: the uncertainty scale is unset".to_owned(),
            vec![],
        )));
    };
    let mut sources = Vec::new();
    for market in markets {
        let missing = || {
            RunError::Agent(denied(
                "agents.provenance_missing",
                "agents.refused.provenance_missing",
                format!("research answer has no source for {market}: the market could not be read"),
                vec![param("market", market.clone())],
            ))
        };
        let quote = read_live_quote(port, &symbol_to_market_id(&market)).ok_or_else(missing)?;
        let value = quote
            .last
            .clone()
            .filter(|v| decimal(v))
            .ok_or_else(missing)?;
        let observed = date_parse(&quote.as_of).ok_or_else(missing)?;
        sources.push(Source {
            id: format!("S{}", sources.len() + 1),
            market: market.clone(),
            value,
            observed_at: observed.iso(),
        });
    }
    let mut system = vec![
        "Answer only from these sources, read by the platform just now. Cite each sentence with the id of the source it rests on, in brackets, like [S1]. A sentence with no citation is shown to the person as unsupported.".to_owned(),
    ];
    system.extend(sources.iter().map(|s| {
        format!(
            "[{}] {} last traded price {}, observed at {} ({} data).",
            s.id, s.market, s.value, s.observed_at, research.environment
        )
    }));
    Ok(Some(Plan {
        sources,
        scale,
        environment: research.environment.clone(),
        system: system.join("\n"),
    }))
}

fn js_space(c: char) -> bool {
    u16::try_from(u32::from(c)).is_ok_and(service_kit::jsregex::is_js_space)
}

/// `splitClaims`: `reply.split(/(?<=[.!?])\s+|\n+/)`, each trimmed, the blank ones dropped.
pub fn split_claims(reply: &str) -> Vec<String> {
    let c: Vec<char> = reply.chars().collect();
    let mut parts = Vec::new();
    let mut start = 0;
    let mut q = 0;
    while q < c.len() {
        let after_stop = q > 0 && matches!(c.get(q - 1), Some('.' | '!' | '?'));
        let end = if after_stop && c.get(q).copied().is_some_and(js_space) {
            let mut e = q;
            while c.get(e).copied().is_some_and(js_space) {
                e += 1;
            }
            Some(e)
        } else if c.get(q) == Some(&'\n') {
            let mut e = q;
            while c.get(e) == Some(&'\n') {
                e += 1;
            }
            Some(e)
        } else {
            None
        };
        match end {
            Some(e) => {
                parts.push(
                    c.get(start..q)
                        .unwrap_or_default()
                        .iter()
                        .collect::<String>(),
                );
                start = e;
                q = e;
            }
            None => q += 1,
        }
    }
    parts.push(
        c.get(start..)
            .unwrap_or_default()
            .iter()
            .collect::<String>(),
    );
    parts
        .into_iter()
        .map(|p| js_trim(&p).to_owned())
        .filter(|p| !p.is_empty())
        .collect()
}

/// `CITATION`'s ids in `claim`: `[S1]` to `[S999]`.
fn citations(claim: &str) -> Vec<String> {
    let c: Vec<char> = claim.chars().collect();
    let mut out = Vec::new();
    for i in 0..c.len() {
        if c.get(i) != Some(&'[')
            || c.get(i + 1) != Some(&'S')
            || !c.get(i + 2).is_some_and(|d| ('1'..='9').contains(d))
        {
            continue;
        }
        let mut e = i + 3;
        while e < i + 5 && c.get(e).is_some_and(char::is_ascii_digit) {
            e += 1;
        }
        if c.get(e) == Some(&']') {
            out.push(c.get(i + 1..e).unwrap_or_default().iter().collect());
        }
    }
    out
}

/// `buildProvenance`: a sentence is supported only when it cites a source the service read; the level is the scale's
/// label at the share of unsupported sentences, rounded up, and a reply with no sentence is the highest.
pub fn build_provenance(plan: &Plan, reply: &str) -> Json {
    let claims = split_claims(reply);
    let known = |id: &String| plan.sources.iter().any(|s| &s.id == id);
    let unsupported: Vec<&String> = claims
        .iter()
        .filter(|c| !citations(c).iter().any(known))
        .collect();
    let top = plan.scale.len().saturating_sub(1);
    let index = if claims.is_empty() {
        top
    } else {
        (unsupported.len() * top).div_ceil(claims.len())
    };
    let observed_at = plan
        .sources
        .iter()
        .map(|s| s.observed_at.as_str())
        .min()
        .unwrap_or("");
    let count = |n: usize| Json::int(i64::try_from(n).unwrap_or(i64::MAX));
    let texts = |v: &[String]| Json::Array(v.iter().cloned().map(Json::str).collect());
    Json::obj([
        (
            "sources",
            Json::Array(plan.sources.iter().map(Source::to_json).collect()),
        ),
        ("observedAt", Json::str(observed_at)),
        ("environment", Json::str(plan.environment.clone())),
        (
            "assumptions",
            Json::Array(RESEARCH_ASSUMPTIONS.iter().map(|a| Json::str(*a)).collect()),
        ),
        (
            "uncertainty",
            Json::obj([
                (
                    "level",
                    Json::str(plan.scale.get(index).cloned().unwrap_or_default()),
                ),
                ("scale", texts(&plan.scale)),
                ("unsupportedCount", count(unsupported.len())),
                ("claimCount", count(claims.len())),
            ]),
        ),
        (
            "unsupported",
            Json::Array(unsupported.into_iter().cloned().map(Json::str).collect()),
        ),
        ("notAdvice", Json::Bool(true)),
    ])
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::panic,
        reason = "a test: a failure is the point"
    )]
    use std::sync::Mutex;

    use super::*;
    use crate::navigator::ports::PortError;
    use crate::navigator::tools::{Market, Quote};

    // Ported case for case from `research/provenance.test.ts`.

    const OBSERVED: &str = "2026-11-14T08:00:00.000Z";

    fn scale() -> Vec<String> {
        ["TEST low", "TEST medium", "TEST high"]
            .map(str::to_owned)
            .to_vec()
    }

    /// A trade plane that knows the markets in `last` and reads each one's last price at `OBSERVED`.
    struct Port {
        last: Vec<(&'static str, Option<&'static str>)>,
        reads: Mutex<Vec<String>>,
    }

    impl TradeData for Port {
        fn list_markets(&self, _limit: Option<f64>) -> Result<Vec<Market>, PortError> {
            Ok(vec![])
        }
        fn quote(&self, market_id: &str) -> Result<Option<Quote>, PortError> {
            self.reads.lock().unwrap().push(market_id.to_owned());
            let Some((_, last)) = self.last.iter().find(|(m, _)| *m == market_id) else {
                return Err(PortError::Failed("trade unreachable".to_owned()));
            };
            Ok(Some(Quote {
                market_id: market_id.to_owned(),
                last: last.map(str::to_owned),
                as_of: OBSERVED.to_owned(),
                max_age_ms: 60_000.0,
            }))
        }
    }

    fn port(last: &[(&'static str, Option<&'static str>)]) -> Port {
        Port {
            last: last.to_vec(),
            reads: Mutex::new(vec![]),
        }
    }

    fn research(scale: Option<Vec<String>>) -> Research {
        Research {
            scale,
            environment: "TEST".to_owned(),
        }
    }

    fn code(r: Result<Option<Plan>, RunError>) -> (String, Json) {
        match r {
            Err(RunError::Agent(d)) => (
                d.error.code.to_owned(),
                Json::Object(d.params.into_iter().collect()),
            ),
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn named_markets_are_found_once_in_order_at_most_five() {
        assert_eq!(
            named_markets("TEST: what moved BTC/USDT today, and ETH/USDT? Also BTC/USDT again."),
            ["BTC/USDT", "ETH/USDT"]
        );
        for ask in [
            "Where do I place a limit order?",
            "TEST: why was my agent request refused?",
            "buy and/or sell",
            "btc/usdt",
        ] {
            assert!(named_markets(ask).is_empty(), "{ask}");
        }
        let ask = ["A1/B1", "A2/B2", "A3/B3", "A4/B4", "A5/B5", "A6/B6"].join(" ");
        assert_eq!(named_markets(&ask).len(), RESEARCH_MAX_MARKETS);
        // Not inside a longer word or path.
        assert!(named_markets("xBTC/USDT BTC/USDTx BTC/USDT/EUR").is_empty());
    }

    #[test]
    fn the_scale_is_blank_or_two_distinct_labels_and_the_environment_names_where_the_data_is() {
        for raw in [None, Some(""), Some("  ")] {
            assert_eq!(parse_uncertainty_scale(raw), Ok(None));
        }
        assert_eq!(
            parse_uncertainty_scale(Some("TEST low, TEST medium ,TEST high")),
            Ok(Some(scale()))
        );
        for raw in ["only one", "a,,b", "a,a"] {
            assert!(
                parse_uncertainty_scale(Some(raw))
                    .unwrap_err()
                    .contains("at least two distinct")
            );
        }
        assert_eq!(research_environment("dev"), "TEST");
        assert_eq!(research_environment("test"), "TEST");
        assert_eq!(research_environment("staging"), "testnet");
        assert_eq!(research_environment("prod"), "live");
    }

    #[test]
    fn prepare_research_reads_every_named_market_itself_as_numbered_sources() {
        let trade = port(&[("btc-usdt", Some("64000.5")), ("eth-usdt", Some("3100"))]);
        let plan = prepare_research(
            "TEST: BTC/USDT vs ETH/USDT",
            Some(&trade),
            &research(Some(scale())),
        )
        .unwrap()
        .unwrap();
        assert_eq!(*trade.reads.lock().unwrap(), ["btc-usdt", "eth-usdt"]);
        let s = |id: &str, market: &str, value: &str| Source {
            id: id.to_owned(),
            market: market.to_owned(),
            value: value.to_owned(),
            observed_at: OBSERVED.to_owned(),
        };
        assert_eq!(
            plan.sources,
            [s("S1", "BTC/USDT", "64000.5"), s("S2", "ETH/USDT", "3100")]
        );
        assert!(plan.system.contains(
            "[S1] BTC/USDT last traded price 64000.5, observed at 2026-11-14T08:00:00.000Z (TEST data)."
        ));
    }

    #[test]
    fn no_market_named_is_no_research_and_nothing_is_read() {
        let trade = port(&[]);
        assert_eq!(
            prepare_research("Where do I stake?", Some(&trade), &research(None)).unwrap(),
            None
        );
        assert!(trade.reads.lock().unwrap().is_empty());
    }

    #[test]
    fn a_blank_scale_refuses_before_any_read_and_an_unreadable_market_refuses_naming_it() {
        let trade = port(&[("btc-usdt", Some("1"))]);
        assert_eq!(
            code(prepare_research("BTC/USDT", Some(&trade), &research(None))).0,
            "agents.uncertainty_scale_unset"
        );
        assert!(trade.reads.lock().unwrap().is_empty());
        let (none, blank) = (port(&[]), port(&[("btc-usdt", None)]));
        for p in [
            Some(&none as &dyn TradeData),
            Some(&blank as &dyn TradeData),
            None,
        ] {
            let (c, params) = code(prepare_research("BTC/USDT", p, &research(Some(scale()))));
            assert_eq!(c, "agents.provenance_missing");
            assert_eq!(params.get("market"), Some(&Json::str("BTC/USDT")));
        }
        let one = port(&[("btc-usdt", Some("1"))]);
        let (c, params) = code(prepare_research(
            "BTC/USDT and SOL/USDT",
            Some(&one),
            &research(Some(scale())),
        ));
        assert_eq!(c, "agents.provenance_missing");
        assert_eq!(params.get("market"), Some(&Json::str("SOL/USDT")));
    }

    fn plan() -> Plan {
        prepare_research(
            "BTC/USDT",
            Some(&port(&[("btc-usdt", Some("64000"))])),
            &research(Some(scale())),
        )
        .unwrap()
        .unwrap()
    }

    fn uncertainty(p: &Json) -> (String, i64, i64) {
        let u = p.get("uncertainty").unwrap();
        let n = |k: &str| match u.get(k) {
            Some(Json::Number(n)) => {
                #[allow(clippy::cast_possible_truncation, reason = "a small count")]
                let n = *n as i64;
                n
            }
            _ => panic!("{k}"),
        };
        let Some(Json::String(level)) = u.get("level") else {
            panic!("level")
        };
        (level.clone(), n("unsupportedCount"), n("claimCount"))
    }

    #[test]
    fn a_fully_cited_answer_has_nothing_unsupported_and_the_lowest_level() {
        let p = build_provenance(&plan(), "BTC/USDT last traded at 64000 [S1].");
        assert_eq!(p.get("unsupported"), Some(&Json::Array(vec![])));
        assert_eq!(uncertainty(&p), ("TEST low".to_owned(), 0, 1));
        assert_eq!(p.get("observedAt"), Some(&Json::str(OBSERVED)));
        assert_eq!(p.get("environment"), Some(&Json::str("TEST")));
        assert_eq!(
            p.get("assumptions"),
            Some(&Json::Array(vec![
                Json::str("last_trade_at_observation"),
                Json::str("named_markets_only")
            ]))
        );
        assert_eq!(p.get("notAdvice"), Some(&Json::Bool(true)));
    }

    #[test]
    fn an_uncited_sentence_or_one_citing_a_source_never_read_is_unsupported_verbatim() {
        let p = build_provenance(
            &plan(),
            "BTC/USDT is at 64000 [S1]. It will double next week. Volume tripled [S7].",
        );
        assert_eq!(
            p.get("unsupported"),
            Some(&Json::Array(vec![
                Json::str("It will double next week."),
                Json::str("Volume tripled [S7].")
            ]))
        );
        assert_eq!(uncertainty(&p), ("TEST high".to_owned(), 2, 3));
        let half = build_provenance(&plan(), "Price 64000 [S1].\nIt looks strong.");
        assert_eq!(uncertainty(&half), ("TEST medium".to_owned(), 1, 2));
        let empty = build_provenance(&plan(), "   ");
        assert_eq!(uncertainty(&empty), ("TEST high".to_owned(), 0, 0));
        assert!(matches!(empty.get("sources"), Some(Json::Array(s)) if s.len() == 1));
    }

    #[test]
    fn sentences_split_on_end_marks_and_line_breaks() {
        assert_eq!(
            split_claims("One. Two!\nThree? four"),
            ["One.", "Two!", "Three?", "four"]
        );
    }
}
