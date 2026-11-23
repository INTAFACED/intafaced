//! Copy-Intel never builds a returns board (D26-P1-A5; \`copy-intel/returns-board-refuse.ts\`): a free-text request
//! that asks for leaders ranked, sorted or listed top-first by a performance measure is refused on the Copy-Intel
//! session's engine call, before any price, hold or engine call, so it charges nothing.
//!
//! The TypeScript's patterns carry the \`iu\` flags; the kit's matcher reads none, so the text is lowercased and the
//! patterns are written in lowercase (they already are). \`\w\` and \`\b\` are ASCII under \`u\` without \`i\`'s Unicode
//! folding, as here. What may differ: a character whose lowercase is not its case fold (the Kelvin sign); none of the
//! patterns' letters is one.

use std::sync::OnceLock;

use service_kit::jsregex::Regex;

/// \`COPY_INTEL_SESSION_AGENT_ID\`.
pub const COPY_INTEL_SESSION_AGENT_ID: &str = "copy-intel";

const LEADERS: &str =
    r"(?:(?:copy\s+)?(?:leaders?|traders?|masters?)|l[ií]deres|l[ií]der|leaders?)";
const LEADERS_PLURAL: &str = r"(?:(?:copy\s+)?(?:leaders|traders|masters)|l[ií]deres)";
const GAP: &str = r"(?:\s+\w+){0,2}?\s+";

/// \`RANKING\`, as the TypeScript joins it.
pub fn ranking_source() -> String {
    [
        format!(r"\b(?:rank|sort|order|clasific\w*|orden(?:a|e|ar)|class(?:e|ez|er)|tri(?:e|ez|er))(?:s|ed|ing)?{GAP}{LEADERS}\b"),
        format!(r"\b(?:ranking|ranked list|ordered list|sorted list|classement)\s+(?:of|de|des){GAP}{LEADERS}\b"),
        format!(r"\b{LEADERS}\s+(?:ranked|sorted|ordered)\b"),
        r"\bleader\s?board\b".to_owned(),
        r"\bleague\s+table\b".to_owned(),
        format!(r"\b(?:top|best|worst|highest|lowest|most)\b[\w\s-]{{0,30}}?\b{LEADERS_PLURAL}\b"),
        format!(r"\b{LEADERS}\b[\w\s:-]{{0,30}}?\b(?:highest|lowest|best|worst|most|top)\b"),
    ]
    .join("|")
}

/// \`PERFORMANCE\`.
pub const PERFORMANCE_SOURCE: &str = r"\b(?:returns?|pnl|p&l|profits?|profitable|roi|win\s?rates?|performance|performing|gains?|rentabilidad|rendimiento|ganancias|rendement|gains)\b";

fn patterns() -> &'static Option<(Regex, Regex)> {
    static P: OnceLock<Option<(Regex, Regex)>> = OnceLock::new();
    P.get_or_init(|| {
        let ranking = Regex::new(&format!("/{}/", ranking_source())).ok()?;
        let performance = Regex::new(&format!("/{PERFORMANCE_SOURCE}/")).ok()?;
        Some((ranking, performance))
    })
}

/// \`asksForReturnsRanking\`: the ranking and the measure in one clause. A pattern the matcher could not read refuses
/// every request rather than letting one through (the tests hold that both are read).
pub fn asks_for_returns_ranking(text: &str) -> bool {
    let Some((ranking, performance)) = patterns() else {
        return true;
    };
    let lower = text.to_lowercase();
    lower
        .split(['.', '!', '?', ';', ',', '\n'])
        .any(|clause| ranking.test(clause) && performance.test(clause))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_patterns_are_read() {
        assert!(patterns().is_some());
    }

    /// The TypeScript's own cases (`returns-board-refuse.test.ts`).
    #[test]
    fn a_ranked_board_is_refused_and_a_question_about_one_leader_runs() {
        for asks in [
            "TEST: rank the leaders by returns",
            "sort leaders by PnL",
            "who are the top 10 leaders by ROI?",
            "show me the best performance leaderboard",
            "order leaders by win rate",
            "which traders have the highest returns?",
            "leaders sorted by profit please",
            "give me a ranking of the leaders by returns",
            "rank the copy leaders by PnL",
            "rank each leader by ROI",
            "which trader is most profitable?",
            "ordered list of leaders by PnL",
            "leaders: highest ROI",
            "clasifica a los líderes por rentabilidad",
            "classe les traders par rendement",
        ] {
            assert!(asks_for_returns_ranking(asks), "{asks}");
        }
        for runs in [
            "show leader L1 stats",
            "what is the drawdown of leader L2?",
            "rank my watchlist alphabetically",
            "returns for leader L3",
            "what is the PnL of my order?",
            "best performance month for leader L1",
            "sort out my returns report",
            "list the leaders I follow",
            "I lost money on my top leaders, what were my returns?",
            "Which leaders have the most followers, and how is performance computed?",
        ] {
            assert!(!asks_for_returns_ranking(runs), "{runs}");
        }
    }
}
