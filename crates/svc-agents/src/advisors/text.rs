//! The advisors' text checks, as their JavaScript patterns read text. Each pattern carries the `i` flag and only ASCII
//! letters, and JavaScript folds no other character onto ASCII, so the text is compared ASCII-lowercased. `\b` and
//! `\w` are ASCII (`[A-Za-z0-9_]`); `\s` is JavaScript's white space. The kit's matcher reads no flags, so each
//! pattern is written out here once, and its test cases are the TypeScript's.

/// `\w`.
fn word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `\s`: JavaScript's WhiteSpace and LineTerminator.
pub fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn lower(text: &str) -> Vec<char> {
    text.chars().map(|c| c.to_ascii_lowercase()).collect()
}

/// Where `pattern` matches `text` from `at`, or none. In `pattern`, `+` is `\s+` and `|` is `[- ]`; every other
/// character is itself.
fn literal_at(text: &[char], at: usize, pattern: &str) -> Option<usize> {
    let mut i = at;
    for p in pattern.chars() {
        match p {
            '+' => {
                let start = i;
                while text.get(i).is_some_and(|c| js_space(*c)) {
                    i += 1;
                }
                if i == start {
                    return None;
                }
            }
            '|' => {
                if !matches!(text.get(i), Some('-' | ' ')) {
                    return None;
                }
                i += 1;
            }
            _ => {
                if text.get(i) != Some(&p) {
                    return None;
                }
                i += 1;
            }
        }
    }
    Some(i)
}

/// `/\b(a|b|...)\b/i`, each alternative starting and ending with a word character: one alternative matches at a word
/// start and ends at a word end.
fn bounded(text: &str, alternatives: &[&str]) -> bool {
    let t = lower(text);
    (0..t.len()).any(|i| {
        let starts = i == 0 || t.get(i - 1).is_none_or(|c| !word(*c));
        starts
            && alternatives.iter().any(|alt| {
                literal_at(&t, i, alt).is_some_and(|end| t.get(end).is_none_or(|c| !word(*c)))
            })
    })
}

/// `grounded-session.ts` `POSITION_ASK`.
pub fn position_ask(ask: &str) -> bool {
    bounded(
        ask,
        &[
            "position",
            "positions",
            "holding",
            "holdings",
            "pnl",
            "unrealised",
            "unrealized",
            "liquidation",
        ],
    )
}

/// `coach-run.ts` `OWN_HOLDINGS_ASK`: `/\bmy\s+(positions?|holdings?|portfolio|pnl|balances?|account|trades?)\b/i`.
pub fn asks_about_own_holdings(question: &str) -> bool {
    bounded(
        question,
        &[
            "my+position",
            "my+positions",
            "my+holding",
            "my+holdings",
            "my+portfolio",
            "my+pnl",
            "my+balance",
            "my+balances",
            "my+account",
            "my+trade",
            "my+trades",
        ],
    )
}

/// `/\d+(\.\d+)?\s*%\s*(a|an|per|each|every)\s*(day|week|month|year)\b/i`.
fn rate_promise(text: &str) -> bool {
    let t = lower(text);
    let spaces = |mut i: usize| {
        while t.get(i).is_some_and(|c| js_space(*c)) {
            i += 1;
        }
        i
    };
    let after_percent = |i: usize| -> bool {
        let i = spaces(i);
        ["a", "an", "per", "each", "every"].iter().any(|per| {
            literal_at(&t, i, per).is_some_and(|j| {
                let j = spaces(j);
                ["day", "week", "month", "year"].iter().any(|unit| {
                    literal_at(&t, j, unit).is_some_and(|end| t.get(end).is_none_or(|c| !word(*c)))
                })
            })
        })
    };
    // From each digit: every split of the number (`\d+` backtracks, the fraction is optional), then `%`.
    (0..t.len()).any(|start| {
        let mut ends = Vec::new();
        let mut i = start;
        while t.get(i).is_some_and(char::is_ascii_digit) {
            i += 1;
            ends.push(i);
            if t.get(i) == Some(&'.') {
                let mut j = i + 1;
                while t.get(j).is_some_and(char::is_ascii_digit) {
                    j += 1;
                    ends.push(j);
                }
            }
        }
        ends.into_iter().any(|end| {
            let p = spaces(end);
            t.get(p) == Some(&'%') && after_percent(p + 1)
        })
    })
}

/// `coach-run.ts` `asksForAdvice`: any of `ADVICE_ASK`.
pub fn asks_for_advice(question: &str) -> bool {
    bounded(
        question,
        &[
            "promise",
            "promised",
            "guarantee",
            "guaranteed",
            "guarantees",
        ],
    ) || rate_promise(question)
        || bounded(
            question,
            &[
                "should+i+buy",
                "should+i+sell",
                "should+i+short",
                "should+i+long",
                "should+i+hold",
            ],
        )
        || bounded(
            question,
            &[
                "what+should+i+buy",
                "what+should+i+sell",
                "what+should+i+trade",
                "what+to+buy",
                "what+to+sell",
                "what+to+trade",
            ],
        )
        || bounded(
            question,
            &["buy+signal", "buy+signals", "sell+signal", "sell+signals"],
        )
}

/// `campaign-proposal.ts` `RETURNS_CLAIM`:
/// `/\b(roi|apy|apr|p&l|pnl|returns?-ranked|guaranteed returns?|profit[- ]share|curve[- ]fit|backtested returns?)\b/i`.
pub fn returns_claim(text: &str) -> bool {
    // A literal space is one space: written here as `[- ]`'s space alone.
    let t = lower(text);
    let alts: [&str; 15] = [
        "roi",
        "apy",
        "apr",
        "p&l",
        "pnl",
        "returns-ranked",
        "return-ranked",
        "guaranteed returns",
        "guaranteed return",
        "profit|share",
        "curve|fit",
        "backtested returns",
        "backtested return",
        "profit share",
        "curve fit",
    ];
    (0..t.len()).any(|i| {
        let starts = i == 0 || t.get(i - 1).is_none_or(|c| !word(*c));
        starts
            && alts.iter().any(|alt| {
                let exact = alt.replace(' ', "\u{0}");
                literal_spaced(&t, i, &exact)
                    .is_some_and(|end| t.get(end).is_none_or(|c| !word(*c)))
            })
    })
}

/// `literal_at`, with `\u{0}` for exactly one space.
fn literal_spaced(text: &[char], at: usize, pattern: &str) -> Option<usize> {
    let mut i = at;
    for p in pattern.split('\u{0}').enumerate() {
        if p.0 > 0 {
            if text.get(i) != Some(&' ') {
                return None;
            }
            i += 1;
        }
        i = literal_at(text, i, p.1)?;
    }
    Some(i)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advice_asks_are_the_patterns_and_nothing_else() {
        for yes in [
            "Can you GUARANTEE a profit?",
            "make 5% a month",
            "10.5 %per week?",
            "3%anday",
            "should I buy BTC now",
            "Should  i\tsell",
            "what should i trade",
            "What to buy?",
            "any buy signals",
            "sell signal please",
        ] {
            assert!(asks_for_advice(yes), "{yes}");
        }
        for no in [
            "why does position size matter more than entry?",
            "promises_kept",
            "5% of my day",
            "should we buy",
            "buy-signal",
            "a 5%-a-day rule",
            "what is a stop",
            "3% a days",
        ] {
            assert!(!asks_for_advice(no), "{no}");
        }
    }

    #[test]
    fn own_holdings_and_position_asks() {
        assert!(asks_about_own_holdings("Explain MY  Portfolio"));
        assert!(asks_about_own_holdings("is my trade ok"));
        assert!(!asks_about_own_holdings("is my trader ok"));
        assert!(!asks_about_own_holdings("mypnl"));
        assert!(position_ask("my Positions"));
        assert!(position_ask("unrealized pnl"));
        assert!(!position_ask("positional play"));
    }

    #[test]
    fn returns_claims() {
        for yes in [
            "Top ROI",
            "p&l board",
            "returns-ranked list",
            "guaranteed return",
            "profit-share",
            "Curve fit",
            "backtested returns",
            "APY!",
        ] {
            assert!(returns_claim(yes), "{yes}");
        }
        for no in [
            "aproi",
            "profit  share",
            "guaranteed  returns",
            "returnsranked",
            "a fair launch",
        ] {
            assert!(!returns_claim(no), "{no}");
        }
    }
}
