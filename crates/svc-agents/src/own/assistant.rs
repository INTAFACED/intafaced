//! Drafting an agent with the assistant (`services/svc-agents/src/own/assistant.ts`; AG-builder-03, J-agents-03 #6).
//! Blank `AGENTS_OWN_ASSISTANT_MODEL`: the owner has not chosen, and drafting refuses `owner.decision`. `test-engine`
//! is the TEST engine, which drafts by rule from the person's words and calls no model. Any other model has no adapter
//! yet and refuses `agents.assistant.engine_unavailable`. A draft is never saved here.

use service_kit::json::Json;
use service_kit::s2s::js_length;
use service_kit::schema::js_trim;

use super::catalog::{DraftInput, INSTRUCTIONS_MAX, NAME_MAX, own_tool, validate_draft};
use super::{OwnError, OwnRefusal};
use service_kit::trpc::TrpcError;

/// The model value that selects the TEST engine.
pub const ASSISTANT_TEST_ENGINE: &str = "test-engine";

/// `assistantEngine`: `None` while the owner has not chosen, `test` or `live`.
pub fn assistant_engine(model: Option<&str>) -> Option<&'static str> {
    let value = js_trim(model.unwrap_or(""));
    if value.is_empty() {
        return None;
    }
    Some(if value == ASSISTANT_TEST_ENGINE {
        "test"
    } else {
        "live"
    })
}

/// Words that lead the TEST engine to a tool. A money tool is here so the validator's refusal of it shows.
const TOOL_WORDS: [(&str, &[&str]); 10] = [
    (
        "support.kb.search",
        &[
            "question",
            "questions",
            "answer",
            "answers",
            "help",
            "faq",
            "article",
            "articles",
        ],
    ),
    (
        "support.ticket.read",
        &["ticket", "tickets", "support", "case", "cases"],
    ),
    ("support.ticket.comment", &["comment", "reply", "respond"]),
    (
        "identity.account.read",
        &["account", "profile", "verification", "kyc"],
    ),
    (
        "trade.markets.list",
        &[
            "order", "orders", "market", "markets", "trade", "trades", "trading",
        ],
    ),
    ("trade.ticker", &["price", "prices", "ticker"]),
    ("trade.quote", &["quote", "quotes"]),
    ("trade.book.top", &["book", "depth", "spread"]),
    (
        "pay.metrics.read",
        &["payment", "payments", "sales", "merchant", "revenue"],
    ),
    (
        "ledger.transfer",
        &["transfer", "withdraw", "withdrawal", "send"],
    ),
];

/// The first `n` UTF-16 units of `s` (`String.prototype.slice(0, n)`), never splitting a character.
fn js_prefix(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

/// `/^TEST:\s*/i` removed once from the start.
fn strip_test_prefix(text: &str) -> &str {
    let head = text.get(..5);
    if head.is_some_and(|h| h.eq_ignore_ascii_case("test:")) {
        text[5..].trim_start_matches(|c: char| {
            u16::try_from(u32::from(c)).is_ok_and(service_kit::jsregex::is_js_space)
        })
    } else {
        text
    }
}

fn is_space(c: char) -> bool {
    u16::try_from(u32::from(c)).is_ok_and(service_kit::jsregex::is_js_space)
}

/// `.replace(/\s+\S*$/, '')`: the last run of space and whatever follows it, when the rest holds no space.
fn drop_last_word(s: &str) -> &str {
    // The tail after the last space must have no space; the match starts at the first space of the last space run.
    let Some(last_space) = s.char_indices().rev().find(|(_, c)| is_space(*c)) else {
        return s;
    };
    let mut start = last_space.0;
    for (i, c) in s[..last_space.0].char_indices().rev() {
        if is_space(c) {
            start = i;
        } else {
            break;
        }
    }
    &s[..start]
}

/// `testEngineDraft`: a draft by rule from the person's words.
pub fn test_engine_draft(description: &str) -> Result<Json, OwnRefusal> {
    let text = js_trim(description);
    if text.is_empty() {
        return Err(OwnRefusal::new("agents.assistant.description_blank"));
    }
    let lower = text.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_ascii_lowercase())
        .filter(|w| !w.is_empty())
        .collect();
    let mut tools: Vec<&str> = Vec::new();
    let mut left_out: Vec<Json> = Vec::new();
    for (tool, cues) in TOOL_WORDS {
        if !cues.iter().any(|c| words.contains(c)) || own_tool(tool).is_none() {
            continue;
        }
        match validate_draft(&DraftInput {
            name: "",
            instructions: "",
            tools: vec![tool],
            per_session_cap: None,
        }) {
            Ok(_) => tools.push(tool),
            Err(e) => left_out.push(Json::obj([
                ("tool", Json::str(tool)),
                ("code", Json::str(e.code.clone())),
            ])),
        }
    }
    let full = format!("TEST draft: {}", strip_test_prefix(text));
    let name = if js_length(&full) <= NAME_MAX {
        full.clone()
    } else {
        js_trim(drop_last_word(js_prefix(&full, NAME_MAX + 1))).to_owned()
    };
    let instructions_full = format!("TEST draft from your description. {text}");
    let instructions = js_prefix(&instructions_full, INSTRUCTIONS_MAX);
    let checked = validate_draft(&DraftInput {
        name: &name,
        instructions,
        tools,
        per_session_cap: None,
    })?;
    Ok(Json::obj([
        ("name", Json::str(checked.name)),
        ("instructions", Json::str(checked.instructions)),
        (
            "tools",
            Json::Array(checked.tools.into_iter().map(Json::str).collect()),
        ),
        ("leftOut", Json::Array(left_out)),
        ("engine", Json::str("test")),
    ]))
}

/// `draftAgent`: on the owner's chosen engine. `owner.decision` is `PRECONDITION_FAILED`, a refusal `BAD_REQUEST`.
pub fn draft_agent(engine: Option<&str>, description: &str) -> Result<Json, OwnError> {
    match engine {
        None => Err(OwnError::Trpc(TrpcError::plain(
            "PRECONDITION_FAILED",
            "owner.decision",
        ))),
        Some("live") => Err(OwnRefusal::new("agents.assistant.engine_unavailable").into()),
        Some(_) => Ok(test_engine_draft(description)?),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    #[test]
    fn the_engine_follows_the_owner_s_model() {
        assert_eq!(assistant_engine(None), None);
        assert_eq!(assistant_engine(Some("  ")), None);
        assert_eq!(assistant_engine(Some(" test-engine ")), Some("test"));
        assert_eq!(assistant_engine(Some("m-1")), Some("live"));
    }

    #[test]
    fn the_test_engine_drafts_by_rule_and_lists_what_it_left_out() {
        let d = test_engine_draft("TEST: answer questions and transfer money").unwrap();
        assert_eq!(
            d.get("name").unwrap(),
            &Json::str("TEST draft: answer questions and transfer money")
        );
        assert_eq!(
            d.get("tools").unwrap(),
            &Json::Array(vec![Json::str("support.kb.search")])
        );
        assert_eq!(
            d.get("leftOut").unwrap().compact(),
            r#"[{"tool":"ledger.transfer","code":"agents.own.money_tool"}]"#
        );
        let long = test_engine_draft(
            "a very long description of what this agent should do for me every day of the week",
        )
        .unwrap();
        assert_eq!(
            long.get("name").unwrap(),
            &Json::str("TEST draft: a very long description of what this agent should do")
        );
        assert_eq!(
            test_engine_draft("  ").unwrap_err().code,
            "agents.assistant.description_blank"
        );
    }

    #[test]
    fn the_last_word_goes_with_its_spaces() {
        assert_eq!(drop_last_word("ab  cd"), "ab");
        assert_eq!(drop_last_word("ab cd "), "ab cd");
        assert_eq!(drop_last_word("abcd"), "abcd");
    }
}
