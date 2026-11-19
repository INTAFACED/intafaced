//! Cost-basis choices (`services/svc-tax/src/choices.ts`): which method a sale uses, most specific first (that coin on
//! that day, every coin on that day, the coin, the account, the product default), and the lot a sale draws on first.
//! The in-memory store is the TypeScript's `createMemoryChoiceStore`, for tests and the parity replay.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::lot_engine::{MethodSource, SaleAt, SaleRule};
use crate::ports::{ChoiceStore, CostBasisChoices, DayChoice, EngineMethod, LotPick};
use crate::tax::{Failure, locale_compare};

/// `NO_CHOICES`.
pub fn no_choices() -> CostBasisChoices {
    CostBasisChoices::default()
}

/// `saleRules`: the rule for each sale under the customer's choices, or one method for every sale when previewing.
pub fn sale_rules(
    choices: &CostBasisChoices,
    fallback: EngineMethod,
    preview: Option<EngineMethod>,
) -> impl Fn(SaleAt<'_>) -> SaleRule + use<> {
    let mut days: HashMap<String, EngineMethod> = HashMap::new();
    for d in &choices.days {
        days.insert(
            format!("{}|{}", d.day, d.asset_id.as_deref().unwrap_or("*")),
            d.method,
        );
    }
    let mut picks: HashMap<String, String> = HashMap::new();
    for p in &choices.picks {
        picks.insert(format!("{}|{}", p.sale_tx_id, p.asset_id), p.lot_id.clone());
    }
    let mut assets: HashMap<String, EngineMethod> = HashMap::new();
    for (a, m) in &choices.asset_methods {
        assets.insert(a.clone(), *m);
    }
    let account = choices.account_method;
    move |sale: SaleAt<'_>| {
        if let Some(method) = preview {
            return SaleRule {
                method,
                lot_id: None,
                source: MethodSource::Preview,
            };
        }
        let iso = sale.posted_at.iso();
        let day = iso.get(0..10).unwrap_or_default();
        let lot_id = picks
            .get(&format!("{}|{}", sale.tx_id, sale.asset_id))
            .cloned();
        let rule = |method, source| SaleRule {
            method,
            lot_id: lot_id.clone(),
            source,
        };
        if let Some(m) = days.get(&format!("{day}|{}", sale.asset_id)) {
            return rule(*m, MethodSource::Day);
        }
        if let Some(m) = days.get(&format!("{day}|*")) {
            return rule(*m, MethodSource::Day);
        }
        if let Some(m) = assets.get(sale.asset_id) {
            return rule(*m, MethodSource::Asset);
        }
        if let Some(m) = account {
            return rule(m, MethodSource::Account);
        }
        rule(fallback, MethodSource::Default)
    }
}

#[derive(Default)]
struct Rows {
    /// `userId|assetId-or-*` → method, in insertion order (a JavaScript `Map`).
    methods: Vec<(String, EngineMethod)>,
    days: Vec<(String, String, DayChoice)>,
    picks: Vec<(String, String, LotPick)>,
    transfers: Vec<(String, bool)>,
}

fn upsert<T>(list: &mut Vec<(String, T)>, key: String, value: T) {
    match list.iter_mut().find(|(k, _)| *k == key) {
        Some((_, v)) => *v = value,
        None => list.push((key, value)),
    }
}

/// `createMemoryChoiceStore`.
#[derive(Default)]
pub struct MemoryChoiceStore {
    rows: Mutex<Rows>,
}

impl MemoryChoiceStore {
    pub fn new() -> MemoryChoiceStore {
        MemoryChoiceStore::default()
    }

    fn rows(&self) -> Result<std::sync::MutexGuard<'_, Rows>, Failure> {
        self.rows
            .lock()
            .map_err(|_| Failure::Internal("the choice store lock is poisoned".to_owned()))
    }
}

impl ChoiceStore for MemoryChoiceStore {
    fn read(&self, user_id: &str) -> Result<CostBasisChoices, Failure> {
        let rows = self.rows()?;
        let mut account_method = None;
        let mut asset_methods: Vec<(String, EngineMethod)> = Vec::new();
        for (key, method) in &rows.methods {
            let mut parts = key.split('|');
            let (Some(owner), Some(asset)) = (parts.next(), parts.next()) else {
                continue;
            };
            if owner != user_id {
                continue;
            }
            if asset == "*" {
                account_method = Some(*method);
            } else {
                upsert(&mut asset_methods, asset.to_owned(), *method);
            }
        }
        let mut days: Vec<DayChoice> = rows
            .days
            .iter()
            .filter(|(_, u, _)| u == user_id)
            .map(|(_, _, d)| d.clone())
            .collect();
        days.sort_by(|a, b| locale_compare(&a.day, &b.day));
        Ok(CostBasisChoices {
            account_method,
            asset_methods,
            days,
            picks: rows
                .picks
                .iter()
                .filter(|(_, u, _)| u == user_id)
                .map(|(_, _, p)| p.clone())
                .collect(),
            include_transfers: rows
                .transfers
                .iter()
                .find(|(u, _)| u == user_id)
                .map(|(_, b)| *b),
        })
    }

    fn set_method(
        &self,
        user_id: &str,
        asset_id: Option<&str>,
        method: Option<EngineMethod>,
    ) -> Result<(), Failure> {
        let mut rows = self.rows()?;
        let key = format!("{user_id}|{}", asset_id.unwrap_or("*"));
        match method {
            None => rows.methods.retain(|(k, _)| *k != key),
            Some(m) => upsert(&mut rows.methods, key, m),
        }
        Ok(())
    }

    fn set_day_method(
        &self,
        user_id: &str,
        day: &str,
        asset_id: Option<&str>,
        method: Option<EngineMethod>,
    ) -> Result<(), Failure> {
        let mut rows = self.rows()?;
        let key = format!("{user_id}|{day}|{}", asset_id.unwrap_or("*"));
        match method {
            None => rows.days.retain(|(k, _, _)| *k != key),
            Some(method) => {
                let row = DayChoice {
                    day: day.to_owned(),
                    asset_id: asset_id.map(str::to_owned),
                    method,
                };
                match rows.days.iter_mut().find(|(k, _, _)| *k == key) {
                    Some(slot) => slot.2 = row,
                    None => rows.days.push((key, user_id.to_owned(), row)),
                }
            }
        }
        Ok(())
    }

    fn set_pick(
        &self,
        user_id: &str,
        sale_tx_id: &str,
        asset_id: &str,
        lot_id: Option<&str>,
    ) -> Result<(), Failure> {
        let mut rows = self.rows()?;
        let key = format!("{user_id}|{sale_tx_id}|{asset_id}");
        match lot_id {
            None => rows.picks.retain(|(k, _, _)| *k != key),
            Some(lot_id) => {
                let row = LotPick {
                    sale_tx_id: sale_tx_id.to_owned(),
                    asset_id: asset_id.to_owned(),
                    lot_id: lot_id.to_owned(),
                };
                match rows.picks.iter_mut().find(|(k, _, _)| *k == key) {
                    Some(slot) => slot.2 = row,
                    None => rows.picks.push((key, user_id.to_owned(), row)),
                }
            }
        }
        Ok(())
    }

    fn set_include_transfers(&self, user_id: &str, include: Option<bool>) -> Result<(), Failure> {
        let mut rows = self.rows()?;
        match include {
            None => rows.transfers.retain(|(u, _)| u != user_id),
            Some(b) => upsert(&mut rows.transfers, user_id.to_owned(), b),
        }
        Ok(())
    }
}
