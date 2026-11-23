//! A customer's own basis (`basis-override.ts`, and `basis-store.ts`'s in-memory store): a price for
//! a lot with no cost, or a manual position held apart from balances. A blank price is not zero, and a removal is a
//! tombstone: the ledger figure is unchanged and the unknown it replaced shows again.

use service_kit::money::Amount;
use std::sync::Mutex;

use crate::json::Json;
use crate::lot_book::LotBook;
use crate::money::parse_amount;
use crate::ports::{ActiveBasis, BasisKind, BasisRow, BasisStore, BasisWrite};
use crate::tax::{
    Failure, TAX_COST_BASIS_UNAVAILABLE, TAX_LOT_UNDERFLOW, TaxError, format_amount, locale_compare,
};

pub const TAX_BASIS_PRICE_UNSET: &str = "tax.basis_price_unset";
pub const TAX_BASIS_PRICE_INVALID: &str = "tax.basis_price_invalid";
pub const TAX_BASIS_DATE_UNSET: &str = "tax.basis_date_unset";
pub const TAX_BASIS_DATE_INVALID: &str = "tax.basis_date_invalid";
pub const TAX_BASIS_NOTE_UNSET: &str = "tax.basis_note_unset";
pub const TAX_BASIS_LOT_UNKNOWN: &str = "tax.basis_lot_unknown";
pub const TAX_MANUAL_POSITION_INCOMPLETE: &str = "tax.manual_position_incomplete";
pub const TAX_BASIS_OVERRIDE_ABSENT: &str = "tax.basis_override_absent";
pub const UNKNOWN_SHARE: &str = "unknown share";

fn refused(code: &'static str, message: &str) -> Failure {
    Failure::Refused(TaxError {
        code,
        message: message.to_owned(),
    })
}

/// `BasisSetInput` with the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BasisSet<'a> {
    pub user_id: &'a str,
    pub lot_id: &'a str,
    pub price_per_unit: &'a str,
    pub date: &'a str,
    pub source_note: &'a str,
    pub asset_id: Option<&'a str>,
    pub qty: Option<&'a str>,
}

/// `String#trim`'s white space (ECMAScript WhiteSpace and LineTerminator).
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

fn blank(v: Option<&str>) -> bool {
    v.is_none_or(|s| js_trim(s).is_empty())
}

fn manual_token(token: &str) -> bool {
    let b = token.as_bytes();
    (1..=64).contains(&b.len())
        && b.first().is_some_and(u8::is_ascii_alphanumeric)
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// `parseBasisSet`: the canonical row fields. Does not look at the book.
pub fn parse_basis_set(input: &BasisSet<'_>) -> Result<BasisWrite, Failure> {
    let lot_id = js_trim(input.lot_id);
    if lot_id.is_empty() {
        return Err(refused(
            TAX_BASIS_LOT_UNKNOWN,
            "a basis write needs a lot id",
        ));
    }
    if blank(Some(input.price_per_unit)) {
        return Err(refused(
            TAX_BASIS_PRICE_UNSET,
            "a customer basis needs a price per unit; a blank price is not zero",
        ));
    }
    let invalid_price = || {
        refused(
            TAX_BASIS_PRICE_INVALID,
            "price per unit must be a positive decimal string",
        )
    };
    let price = parse_amount(js_trim(input.price_per_unit)).map_err(|_| invalid_price())?;
    if price <= Amount::ZERO {
        return Err(invalid_price());
    }
    if blank(Some(input.date)) {
        return Err(refused(
            TAX_BASIS_DATE_UNSET,
            "a customer basis needs the day the coins were acquired",
        ));
    }
    let at = crate::time::js_date(js_trim(input.date)).ok_or_else(|| {
        refused(
            TAX_BASIS_DATE_INVALID,
            "the acquired day is not a real instant",
        )
    })?;
    if blank(Some(input.source_note)) {
        return Err(refused(
            TAX_BASIS_NOTE_UNSET,
            "a customer basis needs a note of where the price came from",
        ));
    }
    let source_note = js_trim(input.source_note).to_owned();
    if lot_id.starts_with("manual:") {
        let prefix = format!("manual:{}:", input.user_id);
        let token = lot_id.get(prefix.len()..).unwrap_or("");
        if !lot_id.starts_with(&prefix) || !manual_token(token) {
            return Err(refused(
                TAX_BASIS_LOT_UNKNOWN,
                "a manual position id is manual:<your account>:<token>",
            ));
        }
        if blank(input.asset_id) || blank(input.qty) {
            return Err(refused(
                TAX_MANUAL_POSITION_INCOMPLETE,
                "a manual position needs an asset and a quantity, and it is not a balance",
            ));
        }
        let bad_qty = || {
            refused(
                TAX_MANUAL_POSITION_INCOMPLETE,
                "a manual position quantity must be a positive decimal string",
            )
        };
        let qty = parse_amount(js_trim(input.qty.unwrap_or(""))).map_err(|_| bad_qty())?;
        if qty <= Amount::ZERO {
            return Err(bad_qty());
        }
        return Ok(BasisWrite {
            user_id: input.user_id.to_owned(),
            lot_id: lot_id.to_owned(),
            manual: true,
            price_per_unit: format_amount(price),
            acquired_at: at.iso(),
            source_note,
            asset_id: input.asset_id.map(|a| js_trim(a).to_owned()),
            qty: Some(format_amount(qty)),
        });
    }
    if !blank(input.asset_id) || !blank(input.qty) {
        return Err(refused(
            TAX_BASIS_LOT_UNKNOWN,
            "a ledger lot takes its asset and quantity from the book",
        ));
    }
    Ok(BasisWrite {
        user_id: input.user_id.to_owned(),
        lot_id: lot_id.to_owned(),
        manual: false,
        price_per_unit: format_amount(price),
        acquired_at: at.iso(),
        source_note,
        asset_id: None,
        qty: None,
    })
}

/// `MissingBasisItem`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingBasisItem {
    pub lot_id: Option<String>,
    pub asset_id: String,
    pub open: bool,
    pub qty: String,
    pub code: &'static str,
    pub sale_tx_id: Option<String>,
}

impl MissingBasisItem {
    pub fn json(&self) -> Json {
        let opt = |v: &Option<String>| v.as_ref().map_or(Json::Null, |s| Json::str(s.clone()));
        Json::obj([
            ("lotId", opt(&self.lot_id)),
            ("assetId", Json::str(self.asset_id.clone())),
            ("kind", Json::str(self.kind())),
            ("qty", Json::str(self.qty.clone())),
            ("code", Json::str(self.code)),
            ("effect", Json::str(UNKNOWN_SHARE)),
            ("saleTxId", opt(&self.sale_tx_id)),
        ])
    }

    fn kind(&self) -> &'static str {
        if self.open { "open" } else { "disposal" }
    }
}

/// `listMissingBasis`: open lots and disposals whose basis is still null.
pub fn list_missing_basis(book: &LotBook) -> Vec<MissingBasisItem> {
    let mut items = Vec::new();
    for lot in &book.lots {
        if lot.remaining == Amount::ZERO {
            continue;
        }
        if lot.cost_usd.is_some() && lot.remaining_cost_usd.is_some() {
            continue;
        }
        items.push(MissingBasisItem {
            lot_id: Some(lot.id.clone()),
            asset_id: lot.asset_id.clone(),
            open: true,
            qty: format_amount(lot.remaining),
            code: TAX_COST_BASIS_UNAVAILABLE,
            sale_tx_id: None,
        });
    }
    for sale in &book.sales {
        for m in &sale.matches {
            if m.cost_usd.is_some() {
                continue;
            }
            items.push(MissingBasisItem {
                lot_id: Some(m.lot_id.clone()),
                asset_id: sale.asset_id.clone(),
                open: false,
                qty: format_amount(m.qty),
                code: TAX_COST_BASIS_UNAVAILABLE,
                sale_tx_id: Some(sale.tx_id.clone()),
            });
        }
        if sale.unmatched_qty != Amount::ZERO {
            items.push(MissingBasisItem {
                lot_id: None,
                asset_id: sale.asset_id.clone(),
                open: false,
                qty: format_amount(sale.unmatched_qty),
                code: TAX_LOT_UNDERFLOW,
                sale_tx_id: Some(sale.tx_id.clone()),
            });
        }
    }
    items.sort_by(|a, b| {
        locale_compare(a.kind(), b.kind())
            .then_with(|| locale_compare(&a.asset_id, &b.asset_id))
            .then_with(|| {
                locale_compare(
                    a.lot_id.as_deref().unwrap_or(""),
                    b.lot_id.as_deref().unwrap_or(""),
                )
            })
            .then_with(|| {
                locale_compare(
                    a.sale_tx_id.as_deref().unwrap_or(""),
                    b.sale_tx_id.as_deref().unwrap_or(""),
                )
            })
    });
    items
}

/// `BasisResult`, as the router sends it.
pub fn result_json(row: &BasisRow) -> Json {
    Json::obj([
        ("businessKey", Json::str(row.business_key.clone())),
        ("version", Json::int(row.version)),
        ("lotId", Json::str(row.lot_id.clone())),
        ("kind", Json::str(row.kind.name())),
        (
            "basisSource",
            if row.kind == BasisKind::Tombstone {
                Json::Null
            } else {
                Json::str("customer-entered")
            },
        ),
    ])
}

fn business_key(user_id: &str, lot_id: &str, version: i64) -> String {
    format!("basisoverride:{user_id}:{lot_id}:{version}")
}

/// `activeOf`.
fn active_of(row: &BasisRow) -> Option<ActiveBasis> {
    if row.kind == BasisKind::Tombstone {
        return None;
    }
    let (price, at, note) = (
        row.price_per_unit.clone()?,
        row.acquired_at.clone()?,
        row.source_note.clone()?,
    );
    if row.kind == BasisKind::Manual {
        return Some(ActiveBasis {
            manual: true,
            lot_id: row.lot_id.clone(),
            version: row.version,
            price_per_unit: price,
            acquired_at: at,
            source_note: note,
            asset_id: Some(row.asset_id.clone()?),
            qty: Some(row.qty.clone()?),
        });
    }
    Some(ActiveBasis {
        manual: false,
        lot_id: row.lot_id.clone(),
        version: row.version,
        price_per_unit: price,
        acquired_at: at,
        source_note: note,
        asset_id: None,
        qty: None,
    })
}

/// `createMemoryBasisStore`: append-only versions; the same payload twice is one version.
#[derive(Default)]
pub struct MemoryBasisStore {
    rows: Mutex<Vec<BasisRow>>,
}

impl MemoryBasisStore {
    pub fn new() -> MemoryBasisStore {
        MemoryBasisStore::default()
    }

    fn rows(&self) -> Result<std::sync::MutexGuard<'_, Vec<BasisRow>>, Failure> {
        self.rows
            .lock()
            .map_err(|_| Failure::Internal("the basis store lock is poisoned".to_owned()))
    }
}

fn latest<'a>(rows: &'a [BasisRow], user_id: &str, lot_id: &str) -> Option<&'a BasisRow> {
    let mut found: Option<&BasisRow> = None;
    for row in rows {
        if row.user_id == user_id
            && row.lot_id == lot_id
            && found.is_none_or(|f| row.version > f.version)
        {
            found = Some(row);
        }
    }
    found
}

impl BasisStore for MemoryBasisStore {
    fn list_active(&self, user_id: &str) -> Result<Vec<ActiveBasis>, Failure> {
        let rows = self.rows()?;
        let mut by_lot: Vec<&BasisRow> = Vec::new();
        for row in rows.iter().filter(|r| r.user_id == user_id) {
            match by_lot.iter_mut().find(|r| r.lot_id == row.lot_id) {
                Some(prev) => {
                    if row.version > prev.version {
                        *prev = row;
                    }
                }
                None => by_lot.push(row),
            }
        }
        let mut active: Vec<ActiveBasis> = by_lot.into_iter().filter_map(active_of).collect();
        active.sort_by(|a, b| locale_compare(&a.lot_id, &b.lot_id));
        Ok(active)
    }

    fn save(&self, write: &BasisWrite) -> Result<BasisRow, Failure> {
        let mut rows = self.rows()?;
        let kind = if write.manual {
            BasisKind::Manual
        } else {
            BasisKind::Override
        };
        let prev = latest(&rows, &write.user_id, &write.lot_id);
        if let Some(p) = prev
            && p.kind == kind
            && p.price_per_unit.as_deref() == Some(write.price_per_unit.as_str())
            && p.acquired_at.as_deref() == Some(write.acquired_at.as_str())
            && p.source_note.as_deref() == Some(write.source_note.as_str())
            && p.asset_id == write.asset_id
            && p.qty == write.qty
        {
            return Ok(p.clone());
        }
        let version = prev.map_or(0, |p| p.version) + 1;
        let row = BasisRow {
            user_id: write.user_id.clone(),
            lot_id: write.lot_id.clone(),
            version,
            kind,
            price_per_unit: Some(write.price_per_unit.clone()),
            acquired_at: Some(write.acquired_at.clone()),
            source_note: Some(write.source_note.clone()),
            asset_id: write.asset_id.clone(),
            qty: write.qty.clone(),
            business_key: business_key(&write.user_id, &write.lot_id, version),
        };
        rows.push(row.clone());
        Ok(row)
    }

    fn clear(&self, user_id: &str, lot_id: &str) -> Result<BasisRow, Failure> {
        let mut rows = self.rows()?;
        let Some(prev) = latest(&rows, user_id, lot_id) else {
            return Err(refused(
                TAX_BASIS_OVERRIDE_ABSENT,
                "no customer basis is stored for that lot",
            ));
        };
        if prev.kind == BasisKind::Tombstone {
            return Ok(prev.clone());
        }
        let version = prev.version + 1;
        let row = BasisRow {
            user_id: user_id.to_owned(),
            lot_id: lot_id.to_owned(),
            version,
            kind: BasisKind::Tombstone,
            price_per_unit: None,
            acquired_at: None,
            source_note: None,
            asset_id: None,
            qty: None,
            business_key: business_key(user_id, lot_id, version),
        };
        rows.push(row.clone());
        Ok(row)
    }
}
