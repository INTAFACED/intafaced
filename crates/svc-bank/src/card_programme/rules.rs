//! The card programme's authorisation rules as pure decisions (`cards/programme/rules.ts`): what one would decline, and
//! the rule in words. A rule declines; it never approves past another check and never moves value. The 3DS decision
//! and the trace an authorisation keeps are read by slice `card-ops`' authorise, ported with it.

use service_kit::json::Json;
use service_kit::money::{Amount, parse_amount};

fn text<'a>(params: &'a Json, key: &str) -> &'a str {
    match params.get(key) {
        Some(Json::String(s)) => s,
        _ => "",
    }
}

/// What a rule reads of one authorisation: its amount in the card's funding asset, its channel and merchant category.
pub struct RuleInput<'a> {
    pub asset_id: &'a str,
    pub amount: Amount,
    pub channel: &'a str,
    pub merchant_category: Option<&'a str>,
}

/// `ruleDeclines`: whether a rule (its parsed params) would decline this authorisation.
pub fn rule_declines(params: &Json, at: &RuleInput<'_>) -> bool {
    match text(params, "kind") {
        "amount_above" => {
            at.asset_id == text(params, "assetId")
                && parse_amount(text(params, "amount")).is_ok_and(|limit| at.amount > limit)
        }
        "merchant_category" => at.merchant_category == Some(text(params, "category")),
        "channel" => at.channel == text(params, "channel"),
        _ => false,
    }
}

/// `ruleWords`: the rule in words, for the desk and the trace.
pub fn rule_words(params: &Json) -> String {
    match text(params, "kind") {
        "amount_above" => format!(
            "declines a payment above {} {}",
            text(params, "amount"),
            text(params, "assetId")
        ),
        "merchant_category" => format!("declines merchant category {}", text(params, "category")),
        _ => format!("declines the {} channel", text(params, "channel")),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;
    use service_kit::json;

    #[test]
    fn each_kind_declines_its_own_and_says_so() {
        let above =
            json::parse(r#"{"kind":"amount_above","assetId":"USDT","amount":"0.5"}"#).unwrap();
        let one = parse_amount("1").unwrap();
        let at = |asset, amount, channel, mc| RuleInput {
            asset_id: asset,
            amount,
            channel,
            merchant_category: mc,
        };
        assert!(rule_declines(
            &above,
            &at("USDT", one, "card-present", None)
        ));
        assert!(!rule_declines(
            &above,
            &at("USDC", one, "card-present", None)
        ));
        assert!(!rule_declines(
            &above,
            &at("USDT", parse_amount("0.5").unwrap(), "online", None)
        ));
        assert_eq!(rule_words(&above), "declines a payment above 0.5 USDT");
        let mc = json::parse(r#"{"kind":"merchant_category","category":"gambling"}"#).unwrap();
        assert!(rule_declines(
            &mc,
            &at("USDT", one, "online", Some("gambling"))
        ));
        assert!(!rule_declines(&mc, &at("USDT", one, "online", None)));
        assert_eq!(rule_words(&mc), "declines merchant category gambling");
        let ch = json::parse(r#"{"kind":"channel","channel":"atm"}"#).unwrap();
        assert!(rule_declines(&ch, &at("USDT", one, "atm", None)));
        assert_eq!(rule_words(&ch), "declines the atm channel");
    }
}
