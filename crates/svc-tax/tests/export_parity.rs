//! Export parity: the year export over a ledger that holds something. `services/svc-tax/src/export-parity.golden.json`
//! holds the ledger (as data) and the pack the TypeScript service made from it (`export-parity.test.ts`); the Rust
//! service reads the same ledger and must make the same pack, byte for byte, its file included.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

use std::sync::Arc;
use svc_tax::json::{self, Json};

use svc_tax::ports::{Ledger, TaxBalance};
use svc_tax::tax::{
    Account, Amount, Failure, HistoryEntry, LakeStatus, Range, SubAccountLine, TaxDeps, TaxService,
};
use svc_tax::time::{self, Instant};

const GOLDEN: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../services/svc-tax/src/export-parity.golden.json"
);

fn s(v: &Json, key: &str) -> String {
    match v.get(key) {
        Some(Json::String(s)) => s.clone(),
        other => panic!("{key}: {other:?}"),
    }
}

/// `parseAmount` for the fixture's decimal strings.
fn amount(text: &str) -> Amount {
    let (neg, digits) = text.strip_prefix('-').map_or((false, text), |d| (true, d));
    let (whole, frac) = digits.split_once('.').unwrap_or((digits, ""));
    let v: Amount = whole.parse::<Amount>().unwrap() * 10i128.pow(18)
        + format!("{frac:0<18}").parse::<Amount>().unwrap();
    if neg { -v } else { v }
}

fn opt_amount(v: &Json, key: &str) -> Option<Amount> {
    match v.get(key) {
        Some(Json::String(t)) => Some(amount(t)),
        _ => None,
    }
}

fn at(text: &str) -> Instant {
    time::zod_datetime(text, false).unwrap()
}

struct Fixture {
    ledger: Json,
    sub_accounts: bool,
}

impl Ledger for Fixture {
    fn balances(&self, _owner_type: &str, user_id: &str) -> Result<Vec<TaxBalance>, Failure> {
        let Some(Json::Array(rows)) = self.ledger.get("balances") else {
            panic!("balances")
        };
        Ok(rows
            .iter()
            .map(|b| TaxBalance {
                purpose: None,
                account_id: String::new(),
                account: Account {
                    owner_type: "user".to_owned(),
                    owner_id: user_id.to_owned(),
                    asset_id: s(b, "assetId"),
                    kind: s(b, "kind"),
                },
                amount: amount(&s(b, "amount")),
            })
            .collect())
    }

    fn history(&self, account: &Account, _range: Range) -> Result<Vec<HistoryEntry>, Failure> {
        let Some(Json::Array(rows)) = self
            .ledger
            .get("history")
            .and_then(|h| h.get(&account.asset_id))
        else {
            return Ok(Vec::new());
        };
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

    fn sub_account_ids(&self, _user_id: &str) -> Option<Result<Vec<String>, Failure>> {
        if !self.sub_accounts {
            return None;
        }
        let Some(Json::Object(subs)) = self.ledger.get("subAccounts") else {
            panic!("subAccounts")
        };
        Some(Ok(subs.iter().map(|(k, _)| k.clone()).collect()))
    }

    fn sub_account_activity(
        &self,
        id: &str,
        _range: Range,
    ) -> Option<Result<Vec<SubAccountLine>, Failure>> {
        if !self.sub_accounts {
            return None;
        }
        let Some(Json::Array(lines)) = self.ledger.get("subAccounts").and_then(|x| x.get(id))
        else {
            return Some(Ok(Vec::new()));
        };
        Some(Ok(lines
            .iter()
            .map(|l| SubAccountLine {
                id: s(l, "id"),
                convert: s(l, "kind") == "convert",
                posted_at: at(&s(l, "postedAt")),
                asset_id: s(l, "assetId"),
                qty: amount(&s(l, "qty")),
                fee: opt_amount(l, "fee"),
                maker_rebate: opt_amount(l, "makerRebate"),
                cost_basis: opt_amount(l, "costBasis"),
                proceeds: opt_amount(l, "proceeds"),
            })
            .collect()))
    }
}

#[test]
fn each_run_makes_the_recorded_pack_byte_for_byte() {
    let golden = json::parse(&std::fs::read_to_string(GOLDEN).unwrap()).unwrap();
    let user = s(&golden, "user");
    let now = at(&s(&golden, "now"));
    let Some(Json::Array(runs)) = golden.get("runs") else {
        panic!("runs")
    };
    assert_eq!(runs.len(), 2);
    for run in runs {
        let sub_accounts = run.get("subAccounts") == Some(&Json::Bool(true));
        let Some(Json::Number(years)) = run.get("historyYears") else {
            panic!("historyYears")
        };
        #[expect(
            clippy::cast_possible_truncation,
            reason = "a small whole number of years"
        )]
        let years = *years as i64;
        let tax = TaxService::new(TaxDeps {
            lake: LakeStatus::lake(None),
            indexer: LakeStatus::indexer(Some("http://indexer")),
            ..TaxDeps::new(
                r#"{"DE":{}}"#,
                Arc::new(Fixture {
                    ledger: golden.get("ledger").unwrap().clone(),
                    sub_accounts,
                }),
                Some(years),
                Box::new(move || now),
            )
        })
        .unwrap();
        let pack = tax
            .export(&user, "de", &s(run, "lotMethod"), None)
            .map_err(|e| format!("{e:?}"))
            .unwrap()
            .pack();
        assert_eq!(pack.compact(), s(run, "pack"), "{}", s(run, "name"));
    }
}
