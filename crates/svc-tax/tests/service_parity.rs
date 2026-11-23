//! Service parity: `tests/fixtures/service-parity/*.jsonl` (a header line, then one scenario a line) holds a seeded corpus of scenarios (a ledger, spaces, a
//! venue, prices, candles, stores, and a list of calls) and what the TypeScript TaxService answered to each call, as its
//! router sends it, or the refusal it gave (`service-parity.record.test.ts`). This builds the same
//! fakes over each scenario, makes the same calls in the same order on the Rust TaxService, and every answer must match
//! byte for byte (a long answer by its SHA-256).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};
use svc_tax::basis::MemoryBasisStore;
use svc_tax::choices::MemoryChoiceStore;
use svc_tax::inputs::{BasisSetInput, DayMethodInput, LotMethodInput, PickInput, PnlInput};
use svc_tax::json::{self, Json};
use svc_tax::money::parse_amount;
use svc_tax::ports::{
    AccountLine, ChoiceStore, CloseSeries, CloseSeriesSource, CostBasisChoices, EngineMethod, Fill,
    FillLeg, InflowLine, Ledger, OwnSpace, OwnSpaces, PriceAt, PriceAtTime, SeriesTimeframe,
    SpaceHistory, SpaceHistoryReader, SpaceLine, TaxBalance, TradeFillReader, TradeFills,
    VenueAccountActivity, VenueActivity, VenueActivitySource, VenueArrival, VenueBalance,
    VenueFill, VenueOwnMove, WithdrawalHold,
};
use svc_tax::tax::{
    Account, Amount, DepositBasisPolicy, Failure, HistoryEntry, LakeStatus, Range, SubAccountLine,
    TaxDeps, TaxError, TaxService,
};
use svc_tax::time::{self, Instant};

pub const GOLDEN_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/service-parity");

/// Every shard in order: (the user the calls are made as, the scenarios). Each shard's header names its place.
pub fn golden() -> (String, Vec<Json>) {
    let mut paths: Vec<_> = std::fs::read_dir(GOLDEN_DIR)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    paths.sort();
    let (mut user, mut scenarios) = (String::new(), Vec::new());
    for (k, path) in paths.iter().enumerate() {
        let text = std::fs::read_to_string(path).unwrap();
        let mut lines = text.lines();
        let header = json::parse(lines.next().unwrap()).unwrap();
        assert_eq!(
            header.get("shard"),
            Some(&Json::Number(k as f64)),
            "{path:?}"
        );
        assert_eq!(
            header.get("of"),
            Some(&Json::Number(paths.len() as f64)),
            "{path:?}"
        );
        user = s(&header, "user");
        scenarios.extend(lines.map(|l| json::parse(l).unwrap()));
    }
    (user, scenarios)
}

fn s(v: &Json, key: &str) -> String {
    match v.get(key) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{key}: {other:?}"),
    }
}

fn opt_s(v: &Json, key: &str) -> Option<String> {
    match v.get(key) {
        Some(Json::String(s)) => Some(s.clone()),
        _ => None,
    }
}

fn b(v: &Json, key: &str) -> bool {
    v.get(key) == Some(&Json::Bool(true))
}

fn arr<'a>(v: &'a Json, key: &str) -> &'a [Json] {
    match v.get(key) {
        Some(Json::Array(a)) => a,
        _ => &[],
    }
}

fn amount(text: &str) -> Amount {
    parse_amount(text).unwrap()
}

fn at(text: &str) -> Instant {
    time::js_date(text).unwrap()
}

fn refused(code: &str, message: &str) -> Failure {
    Failure::Refused(TaxError {
        code: Box::leak(code.to_owned().into_boxed_str()),
        message: message.to_owned(),
    })
}

fn account_line(l: &Json) -> AccountLine {
    AccountLine {
        tx_id: s(l, "txId"),
        posted_at: at(&s(l, "postedAt")),
        asset_id: s(l, "assetId"),
        amount: amount(&s(l, "amount")),
        reason: s(l, "reason"),
        debit: s(l, "direction") == "debit",
    }
}

/// The scenario's ledger, read the way the TypeScript fake reads it.
struct FakeLedger {
    sc: Json,
}

impl Ledger for FakeLedger {
    fn balances(&self, owner_type: &str, owner_id: &str) -> Result<Vec<TaxBalance>, Failure> {
        Ok(arr(&self.sc, "balances")
            .iter()
            .enumerate()
            .map(|(k, row)| TaxBalance {
                account: Account {
                    owner_type: owner_type.to_owned(),
                    owner_id: owner_id.to_owned(),
                    asset_id: s(row, "assetId"),
                    kind: s(row, "kind"),
                },
                purpose: opt_s(row, "purpose"),
                account_id: format!("acc-{k}"),
                amount: amount(&s(row, "amount")),
            })
            .collect())
    }

    fn history(&self, account: &Account, _range: Range) -> Result<Vec<HistoryEntry>, Failure> {
        let rows = self
            .sc
            .get("history")
            .map(|h| arr(h, &account.asset_id))
            .unwrap_or(&[]);
        Ok(rows
            .iter()
            .map(|e| HistoryEntry {
                tx_id: s(e, "txId"),
                reason: s(e, "reason"),
                debit: s(e, "direction") == "debit",
                amount: amount(&s(e, "amount")),
                posted_at: at(&s(e, "postedAt")),
            })
            .collect())
    }

    fn trade_fills(&self) -> Option<&dyn TradeFillReader> {
        (self.sc.get("tradeFills") != Some(&Json::Null)).then_some(self as &dyn TradeFillReader)
    }

    fn space_history(&self) -> Option<&dyn SpaceHistoryReader> {
        (self.sc.get("spaceHistory") != Some(&Json::Null))
            .then_some(self as &dyn SpaceHistoryReader)
    }

    fn sub_account_ids(&self, _user_id: &str) -> Option<Result<Vec<String>, Failure>> {
        match self.sc.get("subAccounts") {
            Some(Json::Object(subs)) => Some(Ok(subs.iter().map(|(k, _)| k.clone()).collect())),
            _ => None,
        }
    }

    fn sub_account_activity(
        &self,
        id: &str,
        _range: Range,
    ) -> Option<Result<Vec<SubAccountLine>, Failure>> {
        let subs = self.sc.get("subAccounts")?;
        let opt = |l: &Json, k: &str| opt_s(l, k).map(|t| amount(&t));
        Some(Ok(arr(subs, id)
            .iter()
            .map(|l| SubAccountLine {
                id: s(l, "id"),
                convert: s(l, "kind") == "convert",
                posted_at: at(&s(l, "postedAt")),
                asset_id: s(l, "assetId"),
                qty: amount(&s(l, "qty")),
                fee: opt(l, "fee"),
                maker_rebate: opt(l, "makerRebate"),
                cost_basis: opt(l, "costBasis"),
                proceeds: opt(l, "proceeds"),
            })
            .collect()))
    }
}

impl TradeFillReader for FakeLedger {
    fn trade_fills(&self, _user_id: &str) -> Result<TradeFills, Failure> {
        let t = self.sc.get("tradeFills").unwrap();
        if t == &Json::str("fail") {
            return Err(refused(
                "tax.ledger_history_unavailable",
                "the ledger did not answer",
            ));
        }
        let leg = |v: &Json| FillLeg {
            asset_id: s(v, "assetId"),
            amount: amount(&s(v, "amount")),
        };
        let fills = arr(t, "fills")
            .iter()
            .map(|f| Fill {
                tx_id: s(f, "txId"),
                posted_at: at(&s(f, "postedAt")),
                received: leg(f.get("received").unwrap()),
                paid: match f.get("paid") {
                    Some(Json::Null) | None => None,
                    Some(p) => Some(leg(p)),
                },
                fee: opt_s(f, "fee").map(|x| amount(&x)),
                fee_asset_id: opt_s(f, "feeAssetId"),
            })
            .collect();
        let inflows = t.get("inflows").map(|_| {
            arr(t, "inflows")
                .iter()
                .map(|l| InflowLine {
                    tx_id: s(l, "txId"),
                    posted_at: at(&s(l, "postedAt")),
                    asset_id: s(l, "assetId"),
                    amount: amount(&s(l, "amount")),
                    reason: s(l, "reason"),
                })
                .collect()
        });
        Ok(TradeFills {
            fills,
            truncated: b(t, "truncated"),
            outside_inflows: arr(t, "outsideInflows")
                .iter()
                .map(|x| match x {
                    Json::String(s) => s.clone(),
                    _ => panic!("outsideInflows"),
                })
                .collect(),
            inflows,
            outflows: t
                .get("outflows")
                .map(|_| arr(t, "outflows").iter().map(account_line).collect()),
            withdrawal_holds: t.get("withdrawalHolds").map(|_| {
                arr(t, "withdrawalHolds")
                    .iter()
                    .map(|h| WithdrawalHold {
                        purpose: s(h, "purpose"),
                        lines: arr(h, "lines").iter().map(account_line).collect(),
                    })
                    .collect()
            }),
        })
    }
}

impl SpaceHistoryReader for FakeLedger {
    fn space_history(&self, space_ids: &[String]) -> Result<SpaceHistory, Failure> {
        let h = self.sc.get("spaceHistory").unwrap();
        if h == &Json::str("fail") {
            return Err(Failure::Internal("space history down".to_owned()));
        }
        Ok(SpaceHistory {
            lines: arr(h, "lines")
                .iter()
                .filter(|l| space_ids.contains(&s(l, "spaceId")))
                .map(|l| SpaceLine {
                    space_id: s(l, "spaceId"),
                    line: account_line(l),
                })
                .collect(),
            truncated: b(h, "truncated"),
        })
    }
}

struct FakePrices(Json);

impl PriceAtTime for FakePrices {
    fn price_at(&self, asset_id: &str, at_: Instant) -> Result<Option<PriceAt>, Failure> {
        match self.0.get(asset_id) {
            None => Ok(None),
            Some(Json::String(f)) if f == "fail" => {
                Err(Failure::Internal("market data down".to_owned()))
            }
            Some(p) => Ok(Some(PriceAt {
                price: amount(&s(p, "price")),
                market: s(p, "market"),
                timeframe: match s(p, "timeframe").as_str() {
                    "1m" => "1m",
                    "1h" => "1h",
                    _ => "1d",
                },
                candle_at: Instant(at_.0.div_euclid(60_000) * 60_000),
            })),
        }
    }
}

struct FakeCloses(Json);

impl CloseSeriesSource for FakeCloses {
    fn closes(
        &self,
        asset_id: &str,
        timeframe: SeriesTimeframe,
        from: Instant,
        to: Instant,
    ) -> Result<Option<CloseSeries>, Failure> {
        match self.0.get(asset_id) {
            None | Some(Json::Null) => Ok(None),
            Some(Json::String(f)) if f == "fail" => {
                Err(Failure::Internal("candles down".to_owned()))
            }
            Some(c) => {
                let ms = timeframe.ms();
                let (base, step) = (amount(&s(c, "base")), amount(&s(c, "step")));
                let mut candles = Vec::new();
                let mut t = from.0.div_euclid(ms) * ms - ms;
                while t <= to.0 {
                    candles.push((t, base + Amount::from(t.div_euclid(ms) % 13) * step));
                    t += ms;
                }
                Ok(Some(CloseSeries {
                    market: s(c, "market"),
                    candles,
                }))
            }
        }
    }
}

/// The memory store whose reads fail (`choices: 'fail'`).
struct FailingChoices(MemoryChoiceStore);

impl ChoiceStore for FailingChoices {
    fn read(&self, _user_id: &str) -> Result<CostBasisChoices, Failure> {
        Err(Failure::Internal("choices down".to_owned()))
    }
    fn set_method(&self, u: &str, a: Option<&str>, m: Option<EngineMethod>) -> Result<(), Failure> {
        self.0.set_method(u, a, m)
    }
    fn set_day_method(
        &self,
        u: &str,
        d: &str,
        a: Option<&str>,
        m: Option<EngineMethod>,
    ) -> Result<(), Failure> {
        self.0.set_day_method(u, d, a, m)
    }
    fn set_pick(&self, u: &str, t: &str, a: &str, l: Option<&str>) -> Result<(), Failure> {
        self.0.set_pick(u, t, a, l)
    }
    fn set_include_transfers(&self, u: &str, i: Option<bool>) -> Result<(), Failure> {
        self.0.set_include_transfers(u, i)
    }
}

struct FakeSpaces(Json);

impl OwnSpaces for FakeSpaces {
    fn list(&self, _user_id: &str) -> Option<Vec<OwnSpace>> {
        match &self.0 {
            Json::Array(list) => Some(
                list.iter()
                    .map(|x| OwnSpace {
                        space_id: s(x, "spaceId"),
                        asset_id: s(x, "assetId"),
                        name: s(x, "name"),
                        archived: b(x, "archived"),
                    })
                    .collect(),
            ),
            _ => None,
        }
    }
}

struct FakeVenue(Json);

fn venue_account(a: &Json) -> VenueAccountActivity {
    VenueAccountActivity {
        venue_id: s(a, "venueId"),
        owner: s(a, "owner"),
        sub_account: opt_s(a, "subAccount"),
        balances: arr(a, "balances")
            .iter()
            .map(|x| VenueBalance {
                asset: s(x, "asset"),
                total: s(x, "total"),
            })
            .collect(),
        fills: arr(a, "fills")
            .iter()
            .map(|f| VenueFill {
                fill_id: s(f, "fillId"),
                symbol: s(f, "symbol"),
                base: s(f, "base"),
                quote: s(f, "quote"),
                buy: s(f, "side") == "buy",
                price: s(f, "price"),
                amount: s(f, "amount"),
                fee: s(f, "fee"),
                fee_asset: s(f, "feeAsset"),
                filled_at: s(f, "filledAt"),
            })
            .collect(),
        transfers: a.get("transfers").map(|_| {
            arr(a, "transfers")
                .iter()
                .map(|t| VenueOwnMove {
                    move_id: s(t, "moveId"),
                    sub_account: s(t, "subAccount"),
                    into_sub_account: s(t, "direction") == "into_sub_account",
                    asset: s(t, "asset"),
                    amount: s(t, "amount"),
                    settled_at: s(t, "settledAt"),
                })
                .collect()
        }),
        arrivals: a.get("arrivals").map(|_| {
            arr(a, "arrivals")
                .iter()
                .map(|x| VenueArrival {
                    arrival_id: s(x, "arrivalId"),
                    kind: s(x, "kind"),
                    asset: s(x, "asset"),
                    amount: s(x, "amount"),
                    arrived_at: s(x, "arrivedAt"),
                })
                .collect()
        }),
        as_of: s(a, "asOf"),
    }
}

impl VenueActivitySource for FakeVenue {
    fn read(&self, _user_id: &str) -> VenueActivity {
        match &self.0 {
            Json::String(x) if x == "off" => VenueActivity::Off,
            Json::String(_) => VenueActivity::Unavailable,
            v => VenueActivity::Read {
                test: b(v, "test"),
                accounts: arr(v, "accounts").iter().map(venue_account).collect(),
            },
        }
    }
}

fn present(sc: &Json, key: &str) -> Option<Json> {
    match sc.get(key) {
        None | Some(Json::Null) => None,
        Some(v) => Some(v.clone()),
    }
}

/// The Rust service over a scenario, as `service()` builds the TypeScript one.
pub fn service(sc: &Json) -> Result<TaxService, TaxError> {
    let now = at(&s(sc, "now"));
    let mut deps = TaxDeps::new(
        s(sc, "mapRaw"),
        Arc::new(FakeLedger { sc: sc.clone() }),
        match sc.get("historyYears") {
            #[expect(clippy::cast_possible_truncation, reason = "a small whole number")]
            Some(Json::Number(n)) => Some(*n as i64),
            _ => None,
        },
        Box::new(move || now),
    );
    deps.lake = LakeStatus::lake(None);
    deps.indexer = LakeStatus::indexer(Some("configured"));
    deps.deposit_basis = match opt_s(sc, "depositBasis").as_deref() {
        Some("market") => Some(DepositBasisPolicy::Market),
        Some("customer") => Some(DepositBasisPolicy::Customer),
        _ => None,
    };
    deps.prices = present(sc, "prices").map(|p| Arc::new(FakePrices(p)) as Arc<dyn PriceAtTime>);
    deps.closes =
        present(sc, "closes").map(|c| Arc::new(FakeCloses(c)) as Arc<dyn CloseSeriesSource>);
    if b(sc, "basis") {
        deps.basis = Some(Arc::new(MemoryBasisStore::new()));
    }
    deps.choices = match opt_s(sc, "choices").as_deref() {
        Some("ok") => Some(Arc::new(MemoryChoiceStore::new())),
        Some("fail") => Some(Arc::new(FailingChoices(MemoryChoiceStore::new()))),
        _ => None,
    };
    deps.spaces = present(sc, "spaces").map(|x| Arc::new(FakeSpaces(x)) as Arc<dyn OwnSpaces>);
    deps.venue =
        present(sc, "venue").map(|x| Arc::new(FakeVenue(x)) as Arc<dyn VenueActivitySource>);
    TaxService::new(deps)
}

fn nullable(v: &Json, key: &str) -> Option<String> {
    opt_s(v, key)
}

/// One call, as `run()` makes it: the answer as the router sends it, or the refusal.
pub fn call(tax: &TaxService, user: &str, op: &str, i: &Json) -> Json {
    let method = opt_s(i, "method");
    let out: Result<Json, Failure> = match op {
        "lotBook" => tax.lot_book(user, method.as_deref()).map(|b| b.json()),
        "missingBasis" => tax.missing_basis(user, method.as_deref()),
        "pnlOverTime" => {
            let input = PnlInput {
                from: time::zod_datetime(&s(i, "from"), true).unwrap(),
                to: opt_s(i, "to").map(|t| time::zod_datetime(&t, true).unwrap()),
                #[expect(clippy::cast_possible_truncation, reason = "minutes")]
                utc_offset_minutes: match i.get("utcOffsetMinutes") {
                    Some(Json::Number(n)) => *n as i64,
                    _ => panic!("utcOffsetMinutes"),
                },
            };
            tax.pnl_over_time(user, &input)
        }
        "basisOverrideSet" => tax.basis_override_set(
            user,
            &BasisSetInput {
                lot_id: s(i, "lotId"),
                price_per_unit: s(i, "pricePerUnit"),
                date: s(i, "date"),
                source_note: s(i, "sourceNote"),
                asset_id: opt_s(i, "assetId"),
                qty: opt_s(i, "qty"),
            },
        ),
        "basisOverrideRemove" => tax.basis_override_remove(user, &s(i, "lotId")),
        "setLotMethod" => tax.set_lot_method(
            user,
            &LotMethodInput {
                asset_id: nullable(i, "assetId"),
                method: nullable(i, "method"),
            },
        ),
        "setDayMethod" => tax.set_day_method(
            user,
            &DayMethodInput {
                day: s(i, "day"),
                asset_id: nullable(i, "assetId"),
                method: nullable(i, "method"),
            },
        ),
        "pickSaleLot" => tax.pick_sale_lot(
            user,
            &PickInput {
                sale_tx_id: s(i, "saleTxId"),
                asset_id: s(i, "assetId"),
                lot_id: nullable(i, "lotId"),
            },
        ),
        "setIncludeTransfers" => tax.set_include_transfers(
            user,
            match i.get("include") {
                Some(Json::Bool(x)) => Some(*x),
                _ => None,
            },
        ),
        "exportPreview" | "exportPack" => {
            let complete = match i.get("complete") {
                Some(Json::Bool(x)) => Some(*x),
                _ => None,
            };
            tax.export(user, &s(i, "region"), &s(i, "lotMethod"), complete)
                .map(|x| {
                    if op == "exportPack" {
                        x.pack()
                    } else {
                        x.preview()
                    }
                })
        }
        other => panic!("unknown op {other}"),
    };
    match out {
        Ok(answer) => Json::obj([("ok", answer)]),
        Err(Failure::Refused(e)) => Json::obj([(
            "refused",
            Json::obj([
                ("code", Json::str(e.code)),
                ("message", Json::str(e.message)),
            ]),
        )]),
        Err(Failure::Internal(m)) => Json::obj([("internal", Json::str(m))]),
    }
}

/// Whether a Rust result is the recorded one: the same text, or for a long answer the same SHA-256.
pub fn same(expected: &Json, got: &Json) -> bool {
    if let Some(Json::String(hash)) = expected.get("okSha256") {
        let Some(answer) = got.get("ok") else {
            return false;
        };
        let digest = Sha256::digest(answer.compact().as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        return &hex == hash;
    }
    expected.compact() == got.compact()
}

fn short(text: &str) -> String {
    text.chars().take(600).collect()
}

#[test]
fn every_scenario_answers_as_the_typescript_service_did() {
    let (user, scenarios) = golden();
    assert!(scenarios.len() >= 300, "{} scenarios", scenarios.len());
    let mut total = 0;
    let differences: Mutex<Vec<String>> = Mutex::new(Vec::new());
    for sc in &scenarios {
        let name = s(sc, "name");
        let tax = match service(sc) {
            Ok(t) => t,
            Err(e) => {
                total += 1;
                let want = sc.get("constructError").unwrap();
                if s(want, "code") != e.code || s(want, "message") != e.message {
                    differences
                        .lock()
                        .unwrap()
                        .push(format!("{name}: construct {e:?}"));
                }
                continue;
            }
        };
        assert!(
            sc.get("constructError").is_none(),
            "{name}: the TypeScript constructor refused"
        );
        let results = arr(sc, "results");
        for (k, c) in arr(sc, "calls").iter().enumerate() {
            total += 1;
            let op = s(c, "op");
            let got = call(&tax, &user, &op, c.get("input").unwrap());
            if !same(&results[k], &got) {
                differences.lock().unwrap().push(format!(
                    "{name} call {k} {op}\n  want {}\n  got  {}",
                    short(&results[k].compact()),
                    short(&got.compact())
                ));
            }
        }
    }
    let differences = differences.into_inner().unwrap();
    println!(
        "service parity: {total} answers compared, {} different",
        differences.len()
    );
    assert!(
        differences.is_empty(),
        "{} of {total} answers differ; the first:\n{}",
        differences.len(),
        differences
            .iter()
            .take(8)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}
