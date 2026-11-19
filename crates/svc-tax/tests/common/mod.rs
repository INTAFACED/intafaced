//! What the ported TypeScript tests share: amounts written as text, the TEST calendar, and figures read back as text.
#![allow(dead_code, reason = "each test file uses its own part")]
#![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]

use svc_tax::money::parse_amount;
use svc_tax::tax::{Amount, format_amount};
use svc_tax::time::{Instant, days_from_civil};

/// `parseAmount`.
pub fn amt(text: &str) -> Amount {
    parse_amount(text).unwrap()
}

/// `formatAmount` of a figure that may be unknown.
pub fn s(v: Option<Amount>) -> Option<String> {
    v.map(format_amount)
}

/// `formatAmount`.
pub fn f(v: Amount) -> String {
    format_amount(v)
}

/// `Date.UTC(year, month - 1, day, hour, minute)`.
pub fn utc(year: i64, month: i64, day: i64, hour: i64, minute: i64) -> Instant {
    Instant(days_from_civil(year, month, day) * 86_400_000 + hour * 3_600_000 + minute * 60_000)
}

/// `new Date(text)` for an ISO text.
pub fn date(text: &str) -> Instant {
    svc_tax::time::js_date(text).unwrap()
}

/// A field of an answer as text: `Some(text)` for a string, `None` for null or absent; anything else is its JSON.
pub fn text(v: &svc_tax::json::Json, key: &str) -> Option<String> {
    match v.get(key) {
        None | Some(svc_tax::json::Json::Null) => None,
        Some(svc_tax::json::Json::String(s)) => Some(s.clone()),
        Some(other) => Some(other.compact()),
    }
}

/// `Some(text.to_owned())`.
pub fn some(text: &str) -> Option<String> {
    Some(text.to_owned())
}

/// `toMatchObject`: every key the expected object names has a matching value (objects compared the same way, arrays
/// element for element at the same length, everything else equal).
pub fn matches(actual: &svc_tax::json::Json, expected: &svc_tax::json::Json) -> bool {
    use svc_tax::json::Json;
    match (actual, expected) {
        (Json::Object(_), Json::Object(want)) => want
            .iter()
            .all(|(k, v)| actual.get(k).is_some_and(|a| matches(a, v))),
        (Json::Array(a), Json::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| matches(x, y))
        }
        _ => actual == expected,
    }
}

/// Asserts `toMatchObject` against expected JSON text.
#[track_caller]
pub fn assert_match(actual: &svc_tax::json::Json, expected: &str) {
    let want = svc_tax::json::parse(expected).unwrap();
    assert!(
        matches(actual, &want),
        "\n  got  {}\n  want {}",
        actual.compact(),
        want.compact()
    );
}

/// Asserts `toEqual` against expected JSON text (key order aside).
#[track_caller]
pub fn assert_json(actual: &svc_tax::json::Json, expected: &str) {
    let want = svc_tax::json::parse(expected).unwrap();
    assert!(
        matches(actual, &want) && matches(&want, actual),
        "\n  got  {}\n  want {}",
        actual.compact(),
        want.compact()
    );
}

/// An array field of an answer.
pub fn list<'a>(v: &'a svc_tax::json::Json, key: &str) -> &'a [svc_tax::json::Json] {
    match v.get(key) {
        Some(svc_tax::json::Json::Array(a)) => a,
        _ => &[],
    }
}

/// The element of an array whose `key` is `value`.
pub fn find<'a>(
    items: &'a [svc_tax::json::Json],
    key: &str,
    value: &str,
) -> Option<&'a svc_tax::json::Json> {
    items
        .iter()
        .find(|x| text(x, key).as_deref() == Some(value))
}

pub mod fake {
    //! The ledger and the other ports as the TypeScript tests fake them: fixed answers, or a failure, per read.
    use std::sync::{Arc, Mutex};

    use svc_tax::ports::{
        CloseSeries, CloseSeriesSource, Ledger, OwnSpace, OwnSpaces, PriceAt, PriceAtTime,
        SeriesTimeframe, SpaceHistory, SpaceHistoryReader, TaxBalance, TradeFillReader, TradeFills,
        VenueActivity, VenueActivitySource,
    };
    use svc_tax::tax::{
        Account, Failure, HistoryEntry, Range, SubAccountLine, TaxDeps, TaxError, TaxService,
    };
    use svc_tax::time::Instant;

    /// One read's fixed answer.
    pub type Answer<T> = Option<Result<T, Failure>>;

    #[derive(Default)]
    pub struct FakeLedger {
        pub balances: Vec<TaxBalance>,
        /// `history`, by the account's coin.
        pub history: Vec<(String, Vec<HistoryEntry>)>,
        /// `None`: the ledger has no fill reader.
        pub fills: Answer<TradeFills>,
        /// `None`: the ledger has no space reader. The answer keeps only the spaces asked for.
        pub space: Answer<SpaceHistory>,
        pub subs: Option<Vec<(String, Vec<SubAccountLine>)>>,
        /// The space ids each space read asked for.
        pub space_asks: Mutex<Vec<Vec<String>>>,
        /// How many times the fills were read.
        pub fill_reads: Mutex<usize>,
    }

    /// A user's balance row on `available` (`accountId` `a-<coin>`).
    pub fn balance(user: &str, asset: &str, amount: &str) -> TaxBalance {
        balance_on(user, asset, amount, "available", None)
    }

    pub fn balance_on(
        user: &str,
        asset: &str,
        amount: &str,
        kind: &str,
        purpose: Option<&str>,
    ) -> TaxBalance {
        TaxBalance {
            account: Account {
                owner_type: "user".to_owned(),
                owner_id: user.to_owned(),
                asset_id: asset.to_owned(),
                kind: kind.to_owned(),
            },
            purpose: purpose.map(str::to_owned),
            account_id: format!("a-{asset}"),
            amount: super::amt(amount),
        }
    }

    pub fn held(user: &str, entries: &[(&str, &str)]) -> Vec<TaxBalance> {
        entries.iter().map(|(a, v)| balance(user, a, v)).collect()
    }

    pub fn fills(fills: Vec<svc_tax::ports::Fill>) -> TradeFills {
        TradeFills {
            fills,
            truncated: false,
            outside_inflows: Vec::new(),
            inflows: None,
            outflows: None,
            withdrawal_holds: None,
        }
    }

    impl Ledger for FakeLedger {
        fn balances(&self, _owner_type: &str, _owner_id: &str) -> Result<Vec<TaxBalance>, Failure> {
            Ok(self.balances.clone())
        }
        fn history(&self, account: &Account, _range: Range) -> Result<Vec<HistoryEntry>, Failure> {
            Ok(self
                .history
                .iter()
                .find(|(a, _)| *a == account.asset_id)
                .map(|(_, h)| h.clone())
                .unwrap_or_default())
        }
        fn trade_fills(&self) -> Option<&dyn TradeFillReader> {
            self.fills.as_ref().map(|_| self as &dyn TradeFillReader)
        }
        fn space_history(&self) -> Option<&dyn SpaceHistoryReader> {
            self.space.as_ref().map(|_| self as &dyn SpaceHistoryReader)
        }
        fn sub_account_ids(&self, _user_id: &str) -> Option<Result<Vec<String>, Failure>> {
            self.subs
                .as_ref()
                .map(|s| Ok(s.iter().map(|(k, _)| k.clone()).collect()))
        }
        fn sub_account_activity(
            &self,
            id: &str,
            _range: Range,
        ) -> Option<Result<Vec<SubAccountLine>, Failure>> {
            let subs = self.subs.as_ref()?;
            Some(Ok(subs
                .iter()
                .find(|(k, _)| k == id)
                .map(|(_, l)| l.clone())
                .unwrap_or_default()))
        }
    }

    impl TradeFillReader for FakeLedger {
        fn trade_fills(&self, _user_id: &str) -> Result<TradeFills, Failure> {
            *self.fill_reads.lock().unwrap() += 1;
            self.fills.clone().unwrap()
        }
    }

    impl SpaceHistoryReader for FakeLedger {
        fn space_history(&self, space_ids: &[String]) -> Result<SpaceHistory, Failure> {
            self.space_asks.lock().unwrap().push(space_ids.to_vec());
            let mut h = self.space.clone().unwrap()?;
            h.lines.retain(|l| space_ids.contains(&l.space_id));
            Ok(h)
        }
    }

    type PriceFn = dyn Fn(&str, Instant) -> Result<Option<PriceAt>, Failure> + Send + Sync;

    /// A price source from a function.
    pub struct Prices(pub Box<PriceFn>);

    impl PriceAtTime for Prices {
        fn price_at(&self, asset_id: &str, at: Instant) -> Result<Option<PriceAt>, Failure> {
            (self.0)(asset_id, at)
        }
    }

    pub fn prices(
        f: impl Fn(&str, Instant) -> Result<Option<PriceAt>, Failure> + Send + Sync + 'static,
    ) -> Arc<dyn PriceAtTime> {
        Arc::new(Prices(Box::new(f)))
    }

    /// A price on the minute candle of `at`.
    pub fn minute_price(price: &str, market: &str, at: Instant) -> PriceAt {
        PriceAt {
            price: super::amt(price),
            market: market.to_owned(),
            timeframe: "1m",
            candle_at: Instant(at.0.div_euclid(60_000) * 60_000),
        }
    }

    type CloseFn = dyn Fn(&str, SeriesTimeframe, Instant, Instant) -> Result<Option<CloseSeries>, Failure>
        + Send
        + Sync;

    pub struct Closes(pub Box<CloseFn>);

    impl CloseSeriesSource for Closes {
        fn closes(
            &self,
            asset_id: &str,
            timeframe: SeriesTimeframe,
            from: Instant,
            to: Instant,
        ) -> Result<Option<CloseSeries>, Failure> {
            (self.0)(asset_id, timeframe, from, to)
        }
    }

    pub fn closes(
        f: impl Fn(&str, SeriesTimeframe, Instant, Instant) -> Result<Option<CloseSeries>, Failure>
        + Send
        + Sync
        + 'static,
    ) -> Arc<dyn CloseSeriesSource> {
        Arc::new(Closes(Box::new(f)))
    }

    /// The customer's own spaces, or `None` for `{ state: 'unavailable' }`.
    pub struct Spaces(pub Option<Vec<OwnSpace>>);

    impl OwnSpaces for Spaces {
        fn list(&self, _user_id: &str) -> Option<Vec<OwnSpace>> {
            self.0.clone()
        }
    }

    pub fn space(id: &str, asset: &str, name: &str) -> OwnSpace {
        OwnSpace {
            space_id: id.to_owned(),
            asset_id: asset.to_owned(),
            name: name.to_owned(),
            archived: false,
        }
    }

    pub fn spaces(list: Option<Vec<OwnSpace>>) -> Arc<dyn OwnSpaces> {
        Arc::new(Spaces(list))
    }

    pub struct Venue(pub VenueActivity);

    impl VenueActivitySource for Venue {
        fn read(&self, _user_id: &str) -> VenueActivity {
            self.0.clone()
        }
    }

    pub fn venue(activity: VenueActivity) -> Arc<dyn VenueActivitySource> {
        Arc::new(Venue(activity))
    }

    /// `new TaxService({ mapRaw, reads, lake absent, indexer absent, now })`, then each test sets what else it needs.
    pub fn deps(ledger: Arc<FakeLedger>, now: Instant) -> TaxDeps {
        TaxDeps::new("", ledger, None, Box::new(move || now))
    }

    pub fn service(deps: TaxDeps) -> TaxService {
        TaxService::new(deps).unwrap()
    }

    /// The refusal a call ended in.
    #[track_caller]
    pub fn refused<T: std::fmt::Debug>(r: Result<T, Failure>) -> TaxError {
        match r {
            Err(Failure::Refused(e)) => e,
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    pub fn internal(message: &str) -> Failure {
        Failure::Internal(message.to_owned())
    }
}
