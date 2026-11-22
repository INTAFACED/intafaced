//! The TEST partner's switches (`partner/test-partner-switches.ts`): the one place a switch is declared, its off value,
//! and the per-person board that keeps them in this process only.
//!
//! The router's input (`testPartnerSwitches.partial()`) is checked by the door's recorded schema before a handler
//! sees it, so a change here holds only values that schema lets through.

use std::collections::{BTreeMap, HashMap};

use service_kit::json::Json;
use service_kit::schema::Value;

/// What a partner may not offer (`PARTNER_FEATURES`), in its declared order.
pub const PARTNER_FEATURES: [&str; 6] = [
    "currencies",
    "spaces",
    "pots",
    "joint",
    "phone_wallet",
    "cash_leg",
];

/// The most people the board keeps switches for (`MAX_PEOPLE`); past it the oldest person's go back to off.
pub const MAX_PEOPLE: usize = 10_000;

/// One person's switches (`TestPartnerSwitches`), each as its declared value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Switches {
    pub not_offered: Vec<String>,
    pub fee: String,
    pub reserve: String,
    pub down: bool,
    pub figures: String,
    pub ramp_quote: String,
    pub ramp_fee: String,
    pub custody: String,
    pub next_reply: String,
    pub card_hold: String,
    pub card_decline: String,
    pub account_details: String,
    pub purchase_holds: String,
    pub purchase_hold: String,
    pub legal_hold: String,
    pub identity_case: String,
    pub bank_rail: String,
    pub holder_name: Option<String>,
    pub pay_in: String,
    pub open_order: Option<String>,
    pub calendar_source: Option<String>,
}

impl Switches {
    /// `SWITCHES_OFF`: what a person has until they set one, and what a restart puts back.
    pub fn off() -> Switches {
        let s = |v: &str| v.to_owned();
        Switches {
            not_offered: Vec::new(),
            fee: s("known"),
            reserve: s("none"),
            down: false,
            figures: s("live"),
            ramp_quote: s("live"),
            ramp_fee: s("known"),
            custody: s("on"),
            next_reply: s("answered"),
            card_hold: s("live"),
            card_decline: s("none"),
            account_details: s("none"),
            purchase_holds: s("reported"),
            purchase_hold: s("live"),
            legal_hold: s("none"),
            identity_case: s("accepted"),
            bank_rail: s("none"),
            holder_name: None,
            pay_in: s("answered"),
            open_order: None,
            calendar_source: None,
        }
    }

    /// `{ ...now, ...change }`: each switch the change names takes its value; `notOffered` once per feature, in the
    /// order first named. The change is the parsed `testPartnerSwitches.partial()` input.
    pub fn with(&self, change: &Value) -> Switches {
        let mut next = self.clone();
        let text = |key: &str, into: &mut String| {
            if let Some(v) = change.get(key).as_str() {
                v.clone_into(into);
            }
        };
        let maybe = |key: &str, into: &mut Option<String>| match change.get(key) {
            Value::Null => *into = None,
            v => {
                if let Some(s) = v.as_str() {
                    *into = Some(s.to_owned());
                }
            }
        };
        if let Some(list) = change.get("notOffered").as_array() {
            let mut seen: Vec<String> = Vec::new();
            for f in list.iter().filter_map(Value::as_str) {
                if !seen.iter().any(|s| s == f) {
                    seen.push(f.to_owned());
                }
            }
            next.not_offered = seen;
        }
        text("fee", &mut next.fee);
        text("reserve", &mut next.reserve);
        if let Value::Bool(b) = change.get("down") {
            next.down = *b;
        }
        text("figures", &mut next.figures);
        text("rampQuote", &mut next.ramp_quote);
        text("rampFee", &mut next.ramp_fee);
        text("custody", &mut next.custody);
        text("nextReply", &mut next.next_reply);
        text("cardHold", &mut next.card_hold);
        text("cardDecline", &mut next.card_decline);
        text("accountDetails", &mut next.account_details);
        text("purchaseHolds", &mut next.purchase_holds);
        text("purchaseHold", &mut next.purchase_hold);
        text("legalHold", &mut next.legal_hold);
        text("identityCase", &mut next.identity_case);
        text("bankRail", &mut next.bank_rail);
        maybe("holderName", &mut next.holder_name);
        text("payIn", &mut next.pay_in);
        maybe("openOrder", &mut next.open_order);
        maybe("calendarSource", &mut next.calendar_source);
        next
    }

    /// The switches as the router's output schema lists them, in its order.
    pub fn fields(&self) -> Vec<(String, Json)> {
        let s = |v: &str| Json::str(v);
        let opt = |v: &Option<String>| v.as_deref().map_or(Json::Null, Json::str);
        vec![
            (
                "notOffered".to_owned(),
                Json::Array(self.not_offered.iter().map(Json::str).collect()),
            ),
            ("fee".to_owned(), s(&self.fee)),
            ("reserve".to_owned(), s(&self.reserve)),
            ("down".to_owned(), Json::Bool(self.down)),
            ("figures".to_owned(), s(&self.figures)),
            ("rampQuote".to_owned(), s(&self.ramp_quote)),
            ("rampFee".to_owned(), s(&self.ramp_fee)),
            ("custody".to_owned(), s(&self.custody)),
            ("nextReply".to_owned(), s(&self.next_reply)),
            ("cardHold".to_owned(), s(&self.card_hold)),
            ("cardDecline".to_owned(), s(&self.card_decline)),
            ("accountDetails".to_owned(), s(&self.account_details)),
            ("purchaseHolds".to_owned(), s(&self.purchase_holds)),
            ("purchaseHold".to_owned(), s(&self.purchase_hold)),
            ("legalHold".to_owned(), s(&self.legal_hold)),
            ("identityCase".to_owned(), s(&self.identity_case)),
            ("bankRail".to_owned(), s(&self.bank_rail)),
            ("holderName".to_owned(), opt(&self.holder_name)),
            ("payIn".to_owned(), s(&self.pay_in)),
            ("openOrder".to_owned(), opt(&self.open_order)),
            ("calendarSource".to_owned(), opt(&self.calendar_source)),
        ]
    }
}

/// Each person's switches, in this process only (`testPartnerSwitchBoard`): one journey's switch never reaches
/// another's account. A person set again moves to the newest place, and past `MAX_PEOPLE` the oldest is forgotten.
#[derive(Debug, Default)]
pub struct Board {
    kept: HashMap<String, (u64, Switches)>,
    order: BTreeMap<u64, String>,
    seq: u64,
}

impl Board {
    /// The person's switches, or every switch off.
    pub fn get(&self, user_id: &str) -> Switches {
        self.kept
            .get(user_id)
            .map_or_else(Switches::off, |(_, s)| s.clone())
    }

    /// Reads the person's switches without copying them.
    pub fn read<T>(&self, user_id: &str, f: impl FnOnce(&Switches) -> T) -> T {
        match self.kept.get(user_id) {
            Some((_, s)) => f(s),
            None => f(&Switches::off()),
        }
    }

    /// Sets some switches for one person and returns them all.
    pub fn set(&mut self, user_id: &str, next: Switches) -> Switches {
        if let Some((at, _)) = self.kept.remove(user_id) {
            self.order.remove(&at);
        }
        self.seq = self.seq.saturating_add(1);
        self.order.insert(self.seq, user_id.to_owned());
        self.kept
            .insert(user_id.to_owned(), (self.seq, next.clone()));
        if self.kept.len() > MAX_PEOPLE
            && let Some((_, oldest)) = self.order.pop_first()
        {
            self.kept.remove(&oldest);
        }
        next
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;
    use service_kit::json;

    fn change(text: &str) -> Value {
        Value::from_json(&json::parse(text).unwrap())
    }

    #[test]
    fn a_change_keeps_every_unnamed_switch_and_names_each_feature_once() {
        let now = Switches::off().with(&change(
            r#"{"notOffered":["spaces","pots","spaces"],"down":true,"holderName":"TEST Ada"}"#,
        ));
        assert_eq!(now.not_offered, vec!["spaces", "pots"]);
        assert!(now.down);
        assert_eq!(now.holder_name.as_deref(), Some("TEST Ada"));
        assert_eq!(now.fee, "known");
        let back = now.with(&change(r#"{"holderName":null}"#));
        assert_eq!(back.holder_name, None);
        assert_eq!(back.not_offered, vec!["spaces", "pots"]);
    }

    #[test]
    fn past_the_most_people_the_oldest_goes_back_to_off() {
        let mut board = Board::default();
        let on = Switches::off().with(&change(r#"{"down":true}"#));
        for i in 0..=MAX_PEOPLE {
            board.set(&format!("u{i}"), on.clone());
        }
        assert!(!board.get("u0").down);
        assert!(board.get("u1").down);
        // Set again, a person is the newest and outlives the next one in.
        board.set("u1", on.clone());
        board.set("late", on);
        assert!(board.get("u1").down);
        assert!(!board.get("u2").down);
    }
}
