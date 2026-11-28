//! Cash through a coin: the partner's cash leg (`partner/cash-leg.ts`, J-cex-spot-11 #11). The partner that holds a
//! person's cash sells them the venue's quote coin for it and pays that coin into their own venue account; the second
//! leg is the venue order their wallet signs.
//!
//! - Offered only where the partner offers it: it holds the person's cash, it is answering, it has not switched the cash
//!   leg off for them, and it gives a rate for that cash and coin.
//! - One leg per key (`convert-cash:<owner>:<quoteId>`): the cash leaves as one partner move under that key, and the
//!   coin is paid out once under the same key; until then the leg reads `sending` and asking again finishes it.
//! - Every figure is the partner's; INTAFACED's ledger posts nothing for either leg.
//!
//! Only the TEST partner offers one: its rates are a labelled TEST value of the stack (`BANK_TEST_CASH_LEG_RATES`) and
//! its payout is the TEST venue's own deposit control (`BANK_TEST_CASH_LEG_VENUE_URL`). Off the TEST stack nothing is
//! offered and every carry refuses `bank.cash_leg_not_offered`.

use std::collections::HashMap;
use std::sync::Mutex;

use service_kit::http::{Fetch, HttpRequest};
use service_kit::json::{self, Json};
use service_kit::jsregex::Regex;
use service_kit::money::{Amount, Rounding, format_amount, js_trim, mul_rounded, parse_amount};
use service_kit::time::Instant;
use sha2::{Digest, Sha256};

use super::custody::Custody;
use super::{AccountRef, MoveRequest, money_held_by, payouts_account, refuse};
use crate::errors::Refusal;

/// The coin's smallest unit the partner pays in: 6 places, as USDC is.
const COIN_STEP: Amount = Amount::from_scaled(1_000_000_000_000);
/// The most legs the TEST partner keeps (`MAX_LEGS`).
const MAX_LEGS: usize = 50_000;
/// Nothing offered on a deployment with no partner giving a cash leg (`NO_CASH_LEGS`).
pub const NONE_HERE: &str = "no partner offers a cash leg on this deployment";

/// One rate the partner gives: `rate` coins for one unit of `cash`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rate {
    pub cash: String,
    pub coin: String,
    pub rate: Amount,
}

/// The person's own venue account the coin is paid into.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VenueAccount {
    pub venue_id: String,
    pub owner: String,
}

/// What a carry asks (`CashLegAsk`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ask {
    pub key: String,
    pub cash: String,
    pub coin: String,
    pub spend: Amount,
    pub least: Amount,
    pub venue: VenueAccount,
}

/// One leg as the partner keeps it (`CashLeg`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Leg {
    pub key: String,
    pub user_id: String,
    pub cash: String,
    pub coin: String,
    pub paid: Amount,
    pub delivered: Amount,
    pub rate: Amount,
    pub venue: VenueAccount,
    pub delivered_at: Option<Instant>,
    pub move_id: String,
    pub moved_at: Instant,
    pub label: &'static str,
}

/// How the partner pays the coin into a venue account: once per `reference`, whatever else is asked.
pub trait Payout: Send + Sync {
    fn pay(
        &self,
        reference: &str,
        venue: &VenueAccount,
        coin: &str,
        amount: Amount,
    ) -> Result<(), String>;
}

/// The TEST cash leg: its rates, its payout and its own record of each leg, in memory as the rest of its book is.
pub struct CashLegs {
    pub rates: Vec<Rate>,
    pub payout: Box<dyn Payout>,
    legs: Mutex<HashMap<String, Leg>>,
    /// Held for a whole carry, so two carries of one key never both pay and stamp their own delivery time: the
    /// second reads the leg the first stored (#9872).
    carrying: Mutex<()>,
}

/// `parseCashLegRates`: `EUR:USDC:1.08,USD:USDC:1`. `None` when blank; a malformed list refuses to start.
pub fn parse_rates(raw: Option<&str>) -> Result<Option<Vec<Rate>>, String> {
    let Some(raw) = raw.filter(|r| !js_trim(r).is_empty()) else {
        return Ok(None);
    };
    let cash_re = Regex::new("/^[A-Z]{3}$/")?;
    let coin_re = Regex::new("/^[A-Z0-9]{2,16}$/")?;
    let rate_re = Regex::new(r"/^\d+(\.\d{1,18})?$/")?;
    let mut out = Vec::new();
    for part in raw.split(',') {
        let fields: Vec<&str> = js_trim(part).split(':').collect();
        let bad = || {
            format!(
                "BANK_TEST_CASH_LEG_RATES \"{part}\" is not CASH:COIN:RATE (for example EUR:USDC:1.08)"
            )
        };
        let [cash, coin, rate] = fields.as_slice() else {
            return Err(bad());
        };
        if cash.is_empty()
            || coin.is_empty()
            || rate.is_empty()
            || !cash_re.test(cash)
            || !coin_re.test(coin)
            || !rate_re.test(rate)
        {
            return Err(bad());
        }
        let value = parse_amount(rate).map_err(|_| bad())?;
        if value <= Amount::ZERO {
            return Err(format!(
                "BANK_TEST_CASH_LEG_RATES \"{part}\" needs a rate above zero"
            ));
        }
        out.push(Rate {
            cash: (*cash).to_owned(),
            coin: (*coin).to_owned(),
            rate: value,
        });
    }
    Ok(Some(out))
}

/// `testCashLegFor`: both values set, with the TEST partner, on dev or test only; neither set, none. One without the
/// other, or either without the TEST partner or outside dev or test, refuses to start.
pub fn for_stack(
    rates: Option<&str>,
    venue_url: Option<&str>,
    partner: bool,
    app_env: Option<&str>,
    node_env: Option<&str>,
    fetch: Box<dyn Fetch>,
) -> Result<Option<CashLegs>, String> {
    let parsed = parse_rates(rates)?;
    let url = venue_url.map(js_trim).unwrap_or("");
    let (rates, url) = match (parsed, url.is_empty()) {
        (None, true) => return Ok(None),
        (Some(r), false) => (r, url),
        _ => {
            return Err(
                "BANK_TEST_CASH_LEG_RATES and BANK_TEST_CASH_LEG_VENUE_URL are set together or not at all".to_owned(),
            );
        }
    };
    if !partner || !matches!(app_env, Some("dev" | "test")) || node_env == Some("production") {
        return Err(
            "the TEST cash leg runs only with BANK_TEST_PARTNER=test on a dev or test stack"
                .to_owned(),
        );
    }
    let href = url::Url::parse(url).map_err(|e| e.to_string())?.to_string();
    Ok(Some(CashLegs::new(
        rates,
        Box::new(TestVenuePayout {
            base: href.trim_end_matches('/').to_owned(),
            fetch,
        }),
    )))
}

/// The TEST partner pays the coin into the TEST venue by the venue's own deposit control, under a reference made from
/// the leg's key, so a payout asked again is credited once (`testVenuePayout`).
pub struct TestVenuePayout {
    pub base: String,
    pub fetch: Box<dyn Fetch>,
}

impl TestVenuePayout {
    fn call(&self, path: &str, body: Option<Json>) -> Result<Json, String> {
        let res = self
            .fetch
            .fetch(&HttpRequest {
                method: if body.is_some() { "POST" } else { "GET" }.to_owned(),
                url: format!("{}{path}", self.base),
                headers: vec![("content-type".to_owned(), "application/json".to_owned())],
                body: body.map(|b| b.compact()),
                timeout_ms: Some(5_000),
                refuse_redirect: true,
            })
            .map_err(|e| e.message)?;
        if !res.ok() {
            return Err(format!("the TEST venue answered {}", res.status));
        }
        json::parse(&res.body).map_err(|e| e.message)
    }
}

impl Payout for TestVenuePayout {
    fn pay(
        &self,
        reference: &str,
        venue: &VenueAccount,
        coin: &str,
        amount: Amount,
    ) -> Result<(), String> {
        let info = self.call("/venue", None)?;
        let chain = match info.get("chainId") {
            None => "0".to_owned(),
            Some(Json::Number(n)) => json::js_number_string(*n),
            Some(Json::String(s)) => s.clone(),
            Some(_) => {
                return Err("the TEST venue's chainId is neither a number nor a string".to_owned());
            }
        };
        if !matches!(info, Json::Object(_)) {
            return Err("the TEST venue's answer is not an object".to_owned());
        }
        let tx: String = Sha256::digest(reference.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        self.call(
            "/test/deposit",
            Some(Json::obj([
                (
                    "account",
                    Json::obj([
                        ("venueId", Json::str(&venue.venue_id)),
                        ("owner", Json::str(&venue.owner)),
                        ("subAccount", Json::Null),
                    ]),
                ),
                ("asset", Json::str(coin)),
                ("amount", Json::str(format_amount(amount))),
                ("depositRef", Json::str(format!("{chain}:0x{tx}:0"))),
            ])),
        )
        .map(|_| ())
    }
}

fn not_offered(reason: &str) -> Refusal {
    refuse(
        "bank.cash_leg_not_offered",
        format!(
            "The partner does not offer cash through a coin here: {reason}. Nothing was moved."
        ),
    )
}

/// Why nothing is offered to this person, or `None` when the partner offers it.
fn why(custody: &Custody<'_>, custody_layer: &str, user_id: &str) -> Option<&'static str> {
    if money_held_by(custody.partner, user_id, custody_layer) != "partner" {
        return Some("the partner does not hold this person’s cash");
    }
    let sw = custody.partner?.switches(user_id);
    if sw.down {
        return Some("the partner bank is not answering");
    }
    if sw.not_offered.iter().any(|f| f == "cash_leg") {
        return Some("the partner has switched cash through a coin off for this person");
    }
    None
}

/// The offers as the record's output lists them.
pub fn offers(
    legs: Option<&CashLegs>,
    custody: &Custody<'_>,
    custody_layer: &str,
    user_id: &str,
    now: Instant,
) -> Json {
    let wrap = |offers: Vec<Json>, reason: Option<&str>| {
        Json::obj([
            ("offers", Json::Array(offers)),
            ("reason", reason.map_or(Json::Null, Json::str)),
        ])
    };
    let Some(legs) = legs.filter(|_| custody.partner.is_some()) else {
        return wrap(Vec::new(), Some(NONE_HERE));
    };
    if let Some(reason) = why(custody, custody_layer, user_id) {
        return wrap(Vec::new(), Some(reason));
    }
    let Some(bank) = custody.bank_for(user_id) else {
        return wrap(
            Vec::new(),
            Some("the partner does not hold this person’s cash"),
        );
    };
    let list = legs
        .rates
        .iter()
        .map(|r| {
            let balance = bank.balance(&AccountRef::main(user_id, &r.cash), now);
            Json::obj([
                ("cash", Json::str(&r.cash)),
                ("coin", Json::str(&r.coin)),
                ("rate", Json::str(format_amount(r.rate))),
                (
                    "available",
                    balance
                        .amount
                        .map_or(Json::Null, |a| Json::str(format_amount(a))),
                ),
                ("asOf", Json::str(balance.as_of.unwrap_or(now).iso())),
                ("label", Json::str(bank.label())),
                ("test", Json::Bool(true)),
            ])
        })
        .collect();
    wrap(list, None)
}

/// A leg as the record's output lists it (`presentCashLeg`).
pub fn present(leg: &Leg) -> Json {
    Json::obj([
        ("legKey", Json::str(&leg.key)),
        ("cash", Json::str(&leg.cash)),
        ("coin", Json::str(&leg.coin)),
        ("paid", Json::str(format_amount(leg.paid))),
        ("delivered", Json::str(format_amount(leg.delivered))),
        ("rate", Json::str(format_amount(leg.rate))),
        (
            "venue",
            Json::obj([
                ("venueId", Json::str(&leg.venue.venue_id)),
                ("owner", Json::str(&leg.venue.owner)),
            ]),
        ),
        (
            "state",
            Json::str(if leg.delivered_at.is_some() {
                "delivered"
            } else {
                "sending"
            }),
        ),
        ("moveId", Json::str(&leg.move_id)),
        ("movedAt", Json::str(leg.moved_at.iso())),
        (
            "deliveredAt",
            leg.delivered_at.map_or(Json::Null, |d| Json::str(d.iso())),
        ),
        ("label", Json::str(leg.label)),
        ("test", Json::Bool(true)),
    ])
}

impl CashLegs {
    pub fn new(rates: Vec<Rate>, payout: Box<dyn Payout>) -> CashLegs {
        CashLegs {
            rates,
            payout,
            legs: Mutex::new(HashMap::new()),
            carrying: Mutex::new(()),
        }
    }

    fn legs(&self) -> std::sync::MutexGuard<'_, HashMap<String, Leg>> {
        self.legs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// `finish`: pays the coin out under the leg's key until it is delivered.
    fn finish(&self, leg: Leg, now: Instant) -> Result<Leg, Refusal> {
        if leg.delivered_at.is_some() {
            return Ok(leg);
        }
        if self
            .payout
            .pay(&leg.key, &leg.venue, &leg.coin, leg.delivered)
            .is_err()
        {
            return Err(refuse(
                "bank.cash_leg_sending",
                format!(
                    "The partner took {} {} and has not yet paid {} {} into the venue account. Check again: it is paid once.",
                    format_amount(leg.paid),
                    leg.cash,
                    format_amount(leg.delivered),
                    leg.coin
                ),
            ));
        }
        let done = Leg {
            delivered_at: Some(now),
            ..leg
        };
        self.legs().insert(done.key.clone(), done.clone());
        Ok(done)
    }

    /// `carry`: one leg per key, made once and paid out once. Carries run one at a time, so every caller of a key
    /// gets the one stored leg, whatever the clock read when each asked.
    pub fn carry(
        &self,
        custody: &Custody<'_>,
        custody_layer: &str,
        user_id: &str,
        ask: &Ask,
        now: Instant,
    ) -> Result<Leg, Refusal> {
        let _one_at_a_time = self
            .carrying
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.carry_one(custody, custody_layer, user_id, ask, now)
    }

    fn carry_one(
        &self,
        custody: &Custody<'_>,
        custody_layer: &str,
        user_id: &str,
        ask: &Ask,
        now: Instant,
    ) -> Result<Leg, Refusal> {
        let key_re = Regex::new("/^convert-cash:[A-Za-z0-9]{1,64}:[A-Za-z0-9_-]{8,80}$/")
            .map_err(Refusal::Other)?;
        if !key_re.test(&ask.key) {
            return Err(refuse(
                "bank.cash_leg_invalid",
                "A cash leg is named by its convert key.",
            ));
        }
        if ask.spend <= Amount::ZERO || ask.least <= Amount::ZERO {
            return Err(refuse(
                "bank.cash_leg_invalid",
                "A cash leg pays and receives above zero.",
            ));
        }
        let prior = self.legs().get(&ask.key).cloned();
        if let Some(prior) = prior {
            if prior.user_id != user_id
                || prior.cash != ask.cash
                || prior.coin != ask.coin
                || prior.paid != ask.spend
                || prior.venue.venue_id != ask.venue.venue_id
                || prior.venue.owner != ask.venue.owner
            {
                return Err(refuse(
                    "bank.partner_move_conflict",
                    format!(
                        "The partner already holds a different cash leg under {}, so this one was not made.",
                        ask.key
                    ),
                ));
            }
            return self.finish(prior, now);
        }
        if let Some(reason) = why(custody, custody_layer, user_id) {
            return Err(not_offered(reason));
        }
        let Some(rate) = self
            .rates
            .iter()
            .find(|r| r.cash == ask.cash && r.coin == ask.coin)
        else {
            return Err(not_offered(&format!(
                "it gives no rate for {} to {}",
                ask.cash, ask.coin
            )));
        };
        // Whole coin steps only: the count of steps the spend buys, times the step.
        let steps =
            mul_rounded(ask.spend, rate.rate, Rounding::Floor).scaled() / COIN_STEP.scaled();
        let delivered = COIN_STEP.saturating_times(steps);
        if delivered < ask.least {
            return Err(refuse(
                "bank.cash_leg_rate_moved",
                format!(
                    "The partner now gives {} {} for {} {}, less than the {} priced. Nothing was moved; get a new price.",
                    format_amount(delivered),
                    ask.coin,
                    format_amount(ask.spend),
                    ask.cash,
                    format_amount(ask.least)
                ),
            ));
        }
        if self.legs().len() >= MAX_LEGS {
            return Err(super::partner_down());
        }
        let Some(bank) = custody.bank_for(user_id) else {
            return Err(not_offered("the partner does not hold this person’s cash"));
        };
        let moved = bank.move_(
            &MoveRequest {
                key: ask.key.clone(),
                from: AccountRef::main(user_id, &ask.cash),
                to: payouts_account(&ask.cash),
                amount: ask.spend,
                payees: None,
            },
            now,
        )?;
        let leg = Leg {
            key: ask.key.clone(),
            user_id: user_id.to_owned(),
            cash: ask.cash.clone(),
            coin: ask.coin.clone(),
            paid: ask.spend,
            delivered,
            rate: rate.rate,
            venue: VenueAccount {
                venue_id: ask.venue.venue_id.clone(),
                owner: ask.venue.owner.to_lowercase(),
            },
            delivered_at: None,
            move_id: moved.id,
            moved_at: moved.moved_at,
            label: bank.label(),
        };
        self.legs().insert(leg.key.clone(), leg.clone());
        self.finish(leg, now)
    }

    /// `leg`: the leg under `key` when it is this person's.
    pub fn leg(&self, user_id: &str, key: &str) -> Option<Leg> {
        self.legs()
            .get(key)
            .filter(|l| l.user_id == user_id)
            .cloned()
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn rates_read_cash_coin_and_rate_and_refuse_anything_else() {
        assert_eq!(parse_rates(None).unwrap(), None);
        assert_eq!(parse_rates(Some("  ")).unwrap(), None);
        let r = parse_rates(Some("EUR:USDC:1.08, USD:USDC:1"))
            .unwrap()
            .unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!(format_amount(r[0].rate), "1.08");
        assert_eq!(r[1].cash, "USD");
        for bad in [
            "EUR:USDC",
            "EUR:USDC:1:2",
            "eur:USDC:1",
            "EUR:usdc:1",
            "EUR:USDC:-1",
            "EUR:USDC:1.1234567890123456789",
        ] {
            assert!(
                parse_rates(Some(bad))
                    .unwrap_err()
                    .contains("is not CASH:COIN:RATE"),
                "{bad}"
            );
        }
        assert!(
            parse_rates(Some("EUR:USDC:0"))
                .unwrap_err()
                .contains("above zero")
        );
    }

    #[test]
    fn the_leg_is_set_with_its_venue_or_not_at_all_and_only_on_a_test_stack() {
        let f = || -> Box<dyn Fetch> { Box::new(service_kit::http::UreqFetch::new()) };
        let ok = |r, u, p, a| for_stack(r, u, p, a, None, f());
        assert!(ok(None, None, true, Some("test")).unwrap().is_none());
        assert!(
            ok(
                Some("EUR:USDC:1"),
                Some("http://127.0.0.1:9/"),
                true,
                Some("test")
            )
            .unwrap()
            .is_some()
        );
        assert!(ok(Some("EUR:USDC:1"), None, true, Some("test")).is_err());
        assert!(ok(None, Some("http://127.0.0.1:9"), true, Some("test")).is_err());
        assert!(
            ok(
                Some("EUR:USDC:1"),
                Some("http://127.0.0.1:9"),
                false,
                Some("test")
            )
            .is_err()
        );
        assert!(
            ok(
                Some("EUR:USDC:1"),
                Some("http://127.0.0.1:9"),
                true,
                Some("prod")
            )
            .is_err()
        );
    }

    /// A payout that tells the test each time it is asked, and answers only when the test lets it.
    struct Held {
        asked: std::sync::mpsc::Sender<()>,
        answer: Mutex<std::sync::mpsc::Receiver<()>>,
        paid: Mutex<Vec<String>>,
    }

    impl Payout for std::sync::Arc<Held> {
        fn pay(&self, reference: &str, _: &VenueAccount, _: &str, _: Amount) -> Result<(), String> {
            self.asked.send(()).unwrap();
            self.answer.lock().unwrap().recv().unwrap();
            let mut paid = self.paid.lock().unwrap();
            // The venue credits a reference once.
            if !paid.iter().any(|p| p == reference) {
                paid.push(reference.to_owned());
            }
            Ok(())
        }
    }

    #[test]
    fn two_carries_of_one_key_at_once_get_the_one_stored_leg_whatever_the_clock_reads() {
        use std::sync::mpsc::channel;
        use std::time::Duration;
        let (asked_tx, asked) = channel();
        let (let_go, answer) = channel();
        let payout = std::sync::Arc::new(Held {
            asked: asked_tx,
            answer: Mutex::new(answer),
            paid: Mutex::new(Vec::new()),
        });
        let legs = CashLegs::new(Vec::new(), Box::new(payout.clone()));
        let key = "convert-cash:0xabc:quote-0001";
        let venue = VenueAccount {
            venue_id: "venue".to_owned(),
            owner: "0xabc".to_owned(),
        };
        // The cash has left already: the leg is stored, sending, and each carry finishes it.
        let sending = Leg {
            key: key.to_owned(),
            user_id: "u1".to_owned(),
            cash: "EUR".to_owned(),
            coin: "USDC".to_owned(),
            paid: parse_amount("10").unwrap(),
            delivered: parse_amount("10.8").unwrap(),
            rate: parse_amount("1.08").unwrap(),
            venue: venue.clone(),
            delivered_at: None,
            move_id: "m1".to_owned(),
            moved_at: Instant(1_000),
            label: super::super::LABEL,
        };
        legs.legs().insert(key.to_owned(), sending.clone());
        let ask = Ask {
            key: key.to_owned(),
            cash: "EUR".to_owned(),
            coin: "USDC".to_owned(),
            spend: sending.paid,
            least: sending.delivered,
            venue,
        };
        let store = crate::db::Store::Down("no database".to_owned());
        let custody = Custody {
            partner: None,
            freeze: &super::super::custody::NotWired,
            store: &store,
        };
        let (a, b) = std::thread::scope(|s| {
            let first = s.spawn(|| legs.carry(&custody, "off", "u1", &ask, Instant(2_000)));
            // The first carry is paying out, and has not been answered.
            asked.recv_timeout(Duration::from_secs(10)).unwrap();
            // A millisecond later the same key is carried again.
            let second = s.spawn(|| legs.carry(&custody, "off", "u1", &ask, Instant(2_001)));
            // The second may not pay while the first is unanswered; give it the time it would take.
            let second_paid_too = asked.recv_timeout(Duration::from_millis(300)).is_ok();
            let_go.send(()).unwrap();
            if second_paid_too {
                let_go.send(()).unwrap();
            }
            let a = first.join().unwrap().unwrap();
            // A pay the second asks after the first is answered is let go, so a wrong answer fails, never hangs.
            if !second_paid_too && asked.recv_timeout(Duration::from_millis(300)).is_ok() {
                let_go.send(()).unwrap();
            }
            (a, second.join().unwrap().unwrap())
        });
        assert_eq!(a.delivered_at, Some(Instant(2_000)));
        assert_eq!(a, b);
        assert_eq!(legs.leg("u1", key), Some(a));
        assert_eq!(*payout.paid.lock().unwrap(), vec![key.to_owned()]);
    }
}
