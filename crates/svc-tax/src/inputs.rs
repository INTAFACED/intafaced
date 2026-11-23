//! svc-tax's twelve inputs, each checked as its record's zod schema checks it (`packages/contracts/src/tax-procedures.ts`
//! and `tax-lot-book.ts`): a typed input, or zod's issues in zod's order.

use crate::json::Json;
use crate::time::{self, Instant};
use crate::zod::{Ctx, Issue};

/// `LOT_BOOK_METHODS`: what the lot book matches by.
pub const LOT_BOOK_METHODS: [&str; 4] = ["FIFO", "LIFO", "HIFO", "AVERAGE"];
/// `TAX_EXPORT_LOT_METHODS`: an export names one matching rule per sale, so no AVERAGE.
pub const EXPORT_LOT_METHODS: [&str; 3] = ["FIFO", "LIFO", "HIFO"];

const ASSET_ID_PATTERN: &str = "/^[A-Za-z0-9]{1,20}$/";
const UTC_DAY_PATTERN: &str = r"/^\d{4}-\d{2}-\d{2}$/";

fn at(path: &[String], key: &str) -> Vec<String> {
    let mut p = path.to_vec();
    p.push(key.to_owned());
    p
}

fn field<'a>(fields: &'a [(String, Json)], key: &str) -> Option<&'a Json> {
    fields.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

/// `lotAssetIdSchema`: `z.string().regex(/^[A-Za-z0-9]{1,20}$/)`.
fn lot_asset_id(c: &mut Ctx, v: Option<&Json>, path: &[String]) -> Option<String> {
    let s = c.string(v, path)?;
    let ok = (1..=20).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric());
    c.regex(ok, ASSET_ID_PATTERN, path);
    ok.then(|| s.to_owned())
}

/// `.nullable()`: null passes as `None`.
fn nullable<T>(
    c: &mut Ctx,
    v: Option<&Json>,
    path: &[String],
    inner: impl FnOnce(&mut Ctx, Option<&Json>, &[String]) -> Option<T>,
) -> Option<Option<T>> {
    match v {
        Some(Json::Null) => Some(None),
        other => inner(c, other, path).map(Some),
    }
}

/// `utcDaySchema`: `YYYY-MM-DD` that is a real day. Both checks run, as zod runs a refinement after a failed pattern.
fn utc_day(c: &mut Ctx, v: Option<&Json>, path: &[String]) -> Option<String> {
    let s = c.string(v, path)?;
    let b = s.as_bytes();
    let shaped = b.len() == 10
        && b.iter().enumerate().all(|(i, ch)| {
            if i == 4 || i == 7 {
                *ch == b'-'
            } else {
                ch.is_ascii_digit()
            }
        });
    c.regex(shaped, UTC_DAY_PATTERN, path);
    // `!Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && new Date(...).toISOString().startsWith(day)`.
    let real = time::es_date_at_midnight(s).is_some_and(|at| at.iso().starts_with(s));
    c.refine(real, path);
    (shaped && real).then(|| s.to_owned())
}

fn method(c: &mut Ctx, v: Option<&Json>, path: &[String]) -> Option<String> {
    c.one_of(v, &LOT_BOOK_METHODS, path).map(str::to_owned)
}

fn done<T>(c: Ctx, out: Option<T>) -> Result<T, Vec<Issue>> {
    match out {
        Some(v) if c.issues.is_empty() => Ok(v),
        _ => Err(c.issues),
    }
}

/// `tax.lotBook` and `tax.missingBasis`: `{ method?: FIFO|LIFO|HIFO|AVERAGE }`, strict, and the whole input optional.
pub fn lot_book(v: Option<&Json>) -> Result<Option<String>, Vec<Issue>> {
    if v.is_none() {
        return Ok(None);
    }
    let mut c = Ctx::new();
    let root: Vec<String> = Vec::new();
    let Some(fields) = c.object(v, &root) else {
        return Err(c.issues);
    };
    let m = match field(fields, "method") {
        None => Some(None),
        some => method(&mut c, some, &at(&root, "method")).map(Some),
    };
    c.strict(fields, &["method"], &root);
    done(c, m)
}

pub struct PnlInput {
    pub from: Instant,
    pub to: Option<Instant>,
    pub utc_offset_minutes: i64,
}

/// `tax.pnlOverTime`: `{ from, to?, utcOffsetMinutes }`, strict.
pub fn pnl_over_time(v: Option<&Json>) -> Result<PnlInput, Vec<Issue>> {
    let mut c = Ctx::new();
    let root: Vec<String> = Vec::new();
    let Some(fields) = c.object(v, &root) else {
        return Err(c.issues);
    };
    let from_path = at(&root, "from");
    let from = c
        .string(field(fields, "from"), &from_path)
        .and_then(|s| c.datetime(s, &from_path));
    let to = match field(fields, "to") {
        None => Some(None),
        some => {
            let p = at(&root, "to");
            c.string(some, &p).and_then(|s| c.datetime(s, &p)).map(Some)
        }
    };
    let offset = c.int_between(
        field(fields, "utcOffsetMinutes"),
        -840,
        840,
        &at(&root, "utcOffsetMinutes"),
    );
    c.strict(fields, &["from", "to", "utcOffsetMinutes"], &root);
    let out = match (from, to, offset) {
        (Some(from), Some(to), Some(utc_offset_minutes)) => Some(PnlInput {
            from,
            to,
            utc_offset_minutes,
        }),
        _ => None,
    };
    done(c, out)
}

pub struct BasisSetInput {
    pub lot_id: String,
    pub price_per_unit: String,
    pub date: String,
    pub source_note: String,
    pub asset_id: Option<String>,
    pub qty: Option<String>,
}

/// `tax.basisOverride.set`: four strings, an optional asset id and quantity, strict.
pub fn basis_override_set(v: Option<&Json>) -> Result<BasisSetInput, Vec<Issue>> {
    let mut c = Ctx::new();
    let root: Vec<String> = Vec::new();
    let Some(fields) = c.object(v, &root) else {
        return Err(c.issues);
    };
    let req = |c: &mut Ctx, key: &str| {
        c.string(field(fields, key), &at(&root, key))
            .map(str::to_owned)
    };
    let lot_id = req(&mut c, "lotId");
    let price_per_unit = req(&mut c, "pricePerUnit");
    let date = req(&mut c, "date");
    let source_note = req(&mut c, "sourceNote");
    let opt = |c: &mut Ctx, key: &str| match field(fields, key) {
        None => Some(None),
        some => c.string(some, &at(&root, key)).map(|s| Some(s.to_owned())),
    };
    let asset_id = opt(&mut c, "assetId");
    let qty = opt(&mut c, "qty");
    c.strict(
        fields,
        &[
            "lotId",
            "pricePerUnit",
            "date",
            "sourceNote",
            "assetId",
            "qty",
        ],
        &root,
    );
    let out = match (lot_id, price_per_unit, date, source_note, asset_id, qty) {
        (
            Some(lot_id),
            Some(price_per_unit),
            Some(date),
            Some(source_note),
            Some(asset_id),
            Some(qty),
        ) => Some(BasisSetInput {
            lot_id,
            price_per_unit,
            date,
            source_note,
            asset_id,
            qty,
        }),
        _ => None,
    };
    done(c, out)
}

/// `tax.basisOverride.remove`: `{ lotId }`, strict.
pub fn basis_override_remove(v: Option<&Json>) -> Result<String, Vec<Issue>> {
    let mut c = Ctx::new();
    let root: Vec<String> = Vec::new();
    let Some(fields) = c.object(v, &root) else {
        return Err(c.issues);
    };
    let lot_id = c
        .string(field(fields, "lotId"), &at(&root, "lotId"))
        .map(str::to_owned);
    c.strict(fields, &["lotId"], &root);
    done(c, lot_id)
}

pub struct LotMethodInput {
    pub asset_id: Option<String>,
    pub method: Option<String>,
}

/// `tax.setLotMethod`: `{ assetId: id | null, method: method | null }`, strict.
pub fn set_lot_method(v: Option<&Json>) -> Result<LotMethodInput, Vec<Issue>> {
    let mut c = Ctx::new();
    let root: Vec<String> = Vec::new();
    let Some(fields) = c.object(v, &root) else {
        return Err(c.issues);
    };
    let asset_id = nullable(
        &mut c,
        field(fields, "assetId"),
        &at(&root, "assetId"),
        lot_asset_id,
    );
    let m = nullable(
        &mut c,
        field(fields, "method"),
        &at(&root, "method"),
        method,
    );
    c.strict(fields, &["assetId", "method"], &root);
    let out = match (asset_id, m) {
        (Some(asset_id), Some(method)) => Some(LotMethodInput { asset_id, method }),
        _ => None,
    };
    done(c, out)
}

pub struct DayMethodInput {
    pub day: String,
    pub asset_id: Option<String>,
    pub method: Option<String>,
}

/// `tax.setDayMethod`: `{ day, assetId: id | null, method: method | null }`, strict.
pub fn set_day_method(v: Option<&Json>) -> Result<DayMethodInput, Vec<Issue>> {
    let mut c = Ctx::new();
    let root: Vec<String> = Vec::new();
    let Some(fields) = c.object(v, &root) else {
        return Err(c.issues);
    };
    let day = utc_day(&mut c, field(fields, "day"), &at(&root, "day"));
    let asset_id = nullable(
        &mut c,
        field(fields, "assetId"),
        &at(&root, "assetId"),
        lot_asset_id,
    );
    let m = nullable(
        &mut c,
        field(fields, "method"),
        &at(&root, "method"),
        method,
    );
    c.strict(fields, &["day", "assetId", "method"], &root);
    let out = match (day, asset_id, m) {
        (Some(day), Some(asset_id), Some(method)) => Some(DayMethodInput {
            day,
            asset_id,
            method,
        }),
        _ => None,
    };
    done(c, out)
}

pub struct PickInput {
    pub sale_tx_id: String,
    pub asset_id: String,
    pub lot_id: Option<String>,
}

/// `tax.pickSaleLot`: `{ saleTxId: 1-200 chars, assetId, lotId: 1-300 chars | null }`, strict.
pub fn pick_sale_lot(v: Option<&Json>) -> Result<PickInput, Vec<Issue>> {
    let mut c = Ctx::new();
    let root: Vec<String> = Vec::new();
    let Some(fields) = c.object(v, &root) else {
        return Err(c.issues);
    };
    let sale_path = at(&root, "saleTxId");
    let sale = c.string(field(fields, "saleTxId"), &sale_path).map(|s| {
        c.length(s, Some(1), Some(200), &sale_path);
        s.to_owned()
    });
    let asset_id = lot_asset_id(&mut c, field(fields, "assetId"), &at(&root, "assetId"));
    let lot = nullable(
        &mut c,
        field(fields, "lotId"),
        &at(&root, "lotId"),
        |c, v, p| {
            c.string(v, p).map(|s| {
                c.length(s, Some(1), Some(300), p);
                s.to_owned()
            })
        },
    );
    c.strict(fields, &["saleTxId", "assetId", "lotId"], &root);
    let out = match (sale, asset_id, lot) {
        (Some(sale_tx_id), Some(asset_id), Some(lot_id)) => Some(PickInput {
            sale_tx_id,
            asset_id,
            lot_id,
        }),
        _ => None,
    };
    done(c, out)
}

/// `tax.setIncludeTransfers`: `{ include: boolean | null }`, strict.
pub fn set_include_transfers(v: Option<&Json>) -> Result<Option<bool>, Vec<Issue>> {
    let mut c = Ctx::new();
    let root: Vec<String> = Vec::new();
    let Some(fields) = c.object(v, &root) else {
        return Err(c.issues);
    };
    let include = nullable(
        &mut c,
        field(fields, "include"),
        &at(&root, "include"),
        |c, v, p| c.boolean(v, p),
    );
    c.strict(fields, &["include"], &root);
    done(c, include)
}

pub struct ExportInput {
    pub lot_method: String,
    pub complete: Option<bool>,
}

/// `tax.exportPreview` and `tax.exportPack`: `{ lotMethod: FIFO|LIFO|HIFO, complete?: boolean }`. Not strict: other keys
/// are dropped, as zod's default object does.
pub fn export(v: Option<&Json>) -> Result<ExportInput, Vec<Issue>> {
    let mut c = Ctx::new();
    let root: Vec<String> = Vec::new();
    let Some(fields) = c.object(v, &root) else {
        return Err(c.issues);
    };
    let lot_method = c
        .one_of(
            field(fields, "lotMethod"),
            &EXPORT_LOT_METHODS,
            &at(&root, "lotMethod"),
        )
        .map(str::to_owned);
    let complete = match field(fields, "complete") {
        None => Some(None),
        some => c.boolean(some, &at(&root, "complete")).map(Some),
    };
    let out = match (lot_method, complete) {
        (Some(lot_method), Some(complete)) => Some(ExportInput {
            lot_method,
            complete,
        }),
        _ => None,
    };
    done(c, out)
}
