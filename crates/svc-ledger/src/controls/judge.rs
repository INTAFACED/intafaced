//! How a control judges the book it read (`judge` in `ledger/reconciliation-controls.ts`): each asset's evidence, folded
//! into the run's word. A side that holds no record is a break by name, never a zero (OWNER 288); a run that compared
//! nothing is `NOTHING_TO_COMPARE`, never green; named open items come out of a rail's difference and leave a residual
//! that only exactly 0 passes.
//!
//! The TypeScript's bigint has no width. A sum here that does not fit an `i128` (far past `numeric(38,18)`) is a failed
//! evaluation, which the run stores as ERROR, never a wrapped figure.

use std::cmp::Ordering;

use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};

use super::sources::OpenItem;

/// The stored tolerance (`ToleranceStored`): its default and per-asset figures, as text.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Tolerance {
    pub default: Option<String>,
    pub by_asset: Vec<(String, String)>,
}

impl Tolerance {
    /// A stored tolerance read back from its jsonb, as the TypeScript reads `row.tolerance` (`null` is none).
    pub fn from_json(j: &Json) -> Option<Tolerance> {
        let Json::Object(_) = j else { return None };
        let default = match j.get("default") {
            Some(Json::String(s)) => Some(s.clone()),
            _ => None,
        };
        let by_asset = match j.get("byAsset") {
            Some(Json::Object(o)) => o
                .iter()
                .filter_map(|(k, v)| match v {
                    Json::String(s) => Some((k.clone(), s.clone())),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        Some(Tolerance { default, by_asset })
    }

    /// `toleranceFor(tolerance, assetId)`: the asset's own figure, else the default; none when blank. A stored figure
    /// that does not read fails the evaluation, as `parseAmount` throws.
    pub fn for_asset(this: Option<&Tolerance>, asset_id: &str) -> Result<Option<Amount>, String> {
        let Some(t) = this else { return Ok(None) };
        let raw = t
            .by_asset
            .iter()
            .find(|(k, _)| k == asset_id)
            .map(|(_, v)| v)
            .or(t.default.as_ref());
        match raw {
            None => Ok(None),
            Some(r) if service_kit::schema::js_trim(r).is_empty() => Ok(None),
            Some(r) => parse_amount(r).map(Some),
        }
    }
}

/// One asset's evidence (`AssetEvidence`): `None` is the word `unset`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Evidence {
    pub asset_id: String,
    pub observed: Option<Amount>,
    pub expected: Option<Amount>,
    pub difference: Option<Amount>,
    pub tolerance: Option<Amount>,
    pub reconciling_items: Option<Amount>,
    pub residual: Option<Amount>,
    /// The side that holds no record for this asset.
    pub missing: Option<&'static str>,
}

fn word(v: Option<Amount>) -> Json {
    v.map_or_else(|| Json::str("unset"), |a| Json::str(format_amount(a)))
}

impl Evidence {
    /// As the run stores it.
    pub fn json(&self) -> Json {
        let mut o = vec![
            ("assetId".to_owned(), Json::str(self.asset_id.clone())),
            ("observed".to_owned(), word(self.observed)),
            ("expected".to_owned(), word(self.expected)),
            ("difference".to_owned(), word(self.difference)),
            ("tolerance".to_owned(), word(self.tolerance)),
        ];
        if let Some(r) = self.reconciling_items {
            o.push(("reconcilingItems".to_owned(), Json::str(format_amount(r))));
        }
        if let Some(r) = self.residual {
            o.push(("residual".to_owned(), Json::str(format_amount(r))));
        }
        if let Some(m) = self.missing {
            o.push(("missing".to_owned(), Json::str(m)));
        }
        Json::Object(o)
    }
}

/// A run's word (`RunStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Pass,
    Fail,
    Error,
    Unset,
    NothingToCompare,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Pass => "PASS",
            Status::Fail => "FAIL",
            Status::Error => "ERROR",
            Status::Unset => "UNSET",
            Status::NothingToCompare => "NOTHING_TO_COMPARE",
        }
    }
}

fn overflow() -> String {
    "a reconciliation figure does not fit the ledger's arithmetic".to_owned()
}

fn plus(a: Amount, b: Amount) -> Result<Amount, String> {
    a.checked_add(b).ok_or_else(overflow)
}

fn minus(a: Amount, b: Amount) -> Result<Amount, String> {
    a.checked_sub(b).ok_or_else(overflow)
}

fn abs(a: Amount) -> Result<Amount, String> {
    a.checked_abs().ok_or_else(overflow)
}

/// Totals per asset, in the order each asset is first seen (a JavaScript `Map`).
pub type Totals = Vec<(String, Amount)>;

/// `sumByAsset(accounts, amounts)`.
pub fn sum_by_asset(
    accounts: &[(String, String)],
    amounts: &dyn Fn(&str) -> Amount,
) -> Result<Totals, String> {
    let mut totals: Totals = Vec::new();
    for (id, asset) in accounts {
        let add = amounts(id);
        match totals.iter_mut().find(|(a, _)| a == asset) {
            Some((_, v)) => *v = plus(*v, add)?,
            None => totals.push((asset.clone(), add)),
        }
    }
    Ok(totals)
}

fn get(t: &Totals, asset: &str) -> Option<Amount> {
    t.iter().find(|(a, _)| a == asset).map(|(_, v)| *v)
}

/// `assetRow(assetId, observed, expected, tolerance, pass)`: a row with no expected side or no tolerance keeps neither
/// figure nor difference.
pub fn asset_row(
    asset_id: &str,
    observed: Amount,
    expected: Option<Amount>,
    tolerance: Option<Amount>,
    judged: bool,
) -> Result<Evidence, String> {
    let row = |expected, difference| Evidence {
        asset_id: asset_id.to_owned(),
        observed: Some(observed),
        expected,
        difference,
        tolerance,
        reconciling_items: None,
        residual: None,
        missing: None,
    };
    match (expected, tolerance, judged) {
        (Some(e), Some(_), true) => Ok(row(Some(e), Some(minus(observed, e)?))),
        _ => Ok(row(None, None)),
    }
}

/// `comparedOf(assets)`: the figures a run compared, both sides known and judged.
pub fn compared_of(assets: &[Evidence]) -> usize {
    assets
        .iter()
        .filter(|a| a.missing.is_none() && a.expected.is_some() && a.difference.is_some())
        .count()
}

/// `withinStored(asset)`.
fn within(a: &Evidence) -> Result<bool, String> {
    match (a.difference, a.tolerance) {
        (Some(d), Some(t)) => Ok(abs(d)? <= t),
        _ => Ok(false),
    }
}

/// `foldAssets(assets, unsetSource)`.
pub fn fold_assets(assets: &[Evidence], unset_source: bool) -> Result<Status, String> {
    if assets.iter().any(|a| a.missing.is_some()) {
        return Ok(Status::Fail);
    }
    if assets.iter().any(|a| a.tolerance.is_none()) {
        return Ok(Status::Error);
    }
    if unset_source || assets.iter().any(|a| a.expected.is_none()) {
        return Ok(Status::Unset);
    }
    for a in assets {
        if a.difference.is_some_and(|d| d != Amount::ZERO) && !within(a)? {
            return Ok(Status::Fail);
        }
    }
    if compared_of(assets) == 0 {
        return Ok(Status::NothingToCompare);
    }
    Ok(Status::Pass)
}

/// `foldResiduals(assets, unsetSource)`: with named items no tolerance applies, and a known residual fails ahead of
/// everything else.
pub fn fold_residuals(assets: &[Evidence], unset_source: bool) -> Status {
    if assets
        .iter()
        .any(|a| a.residual.is_some_and(|r| r != Amount::ZERO))
    {
        return Status::Fail;
    }
    if assets.iter().any(|a| a.tolerance.is_none()) {
        return Status::Error;
    }
    if unset_source
        || assets
            .iter()
            .any(|a| a.expected.is_none() || a.residual.is_none())
    {
        return Status::Unset;
    }
    if compared_of(assets) == 0 {
        return Status::NothingToCompare;
    }
    Status::Pass
}

/// `[...ids].sort()`: UTF-16 code-unit order, which for asset ids is byte order.
fn sorted_ids(a: &Totals, b: &Totals) -> Vec<String> {
    let mut ids: Vec<String> = a.iter().chain(b).map(|(k, _)| k.clone()).collect();
    ids.sort();
    ids.dedup();
    ids
}

/// `equalAssets(observed, expected, tolerance, missingIsZero, missingLedgerIsZero)`.
pub fn equal_assets(
    observed: &Totals,
    expected: &Totals,
    tolerance: Option<&Tolerance>,
    missing_is_zero: bool,
    missing_ledger_is_zero: bool,
) -> Result<Vec<Evidence>, String> {
    let mut out = Vec::new();
    for id in sorted_ids(observed, expected) {
        let left = get(observed, &id).or(missing_ledger_is_zero.then_some(Amount::ZERO));
        let right = get(expected, &id).or(missing_is_zero.then_some(Amount::ZERO));
        let tol = Tolerance::for_asset(tolerance, &id)?;
        let (Some(l), Some(r)) = (left, right) else {
            out.push(asset_row(
                &id,
                left.unwrap_or(Amount::ZERO),
                None,
                tol,
                false,
            )?);
            continue;
        };
        out.push(asset_row(&id, l, Some(r), tol, true)?);
    }
    Ok(out)
}

/// The stored threshold (`ReconciliationThreshold`, parsed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Threshold {
    pub min: bool,
    pub by_asset: Vec<(String, String)>,
}

/// `thresholdAssets(observed, threshold, tolerance)`.
pub fn threshold_assets(
    observed: &Totals,
    threshold: &Threshold,
    tolerance: Option<&Tolerance>,
) -> Result<Vec<Evidence>, String> {
    let mut ids: Vec<&(String, String)> = threshold.by_asset.iter().collect();
    ids.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out = Vec::new();
    for (id, raw) in ids {
        let bound = parse_amount(raw)?;
        let tol = Tolerance::for_asset(tolerance, id)?;
        let Some(amount) = get(observed, id) else {
            // No account of the set holds this asset: the ledger side is missing, a break by name.
            out.push(Evidence {
                asset_id: id.clone(),
                observed: None,
                expected: Some(bound),
                difference: None,
                tolerance: tol,
                reconciling_items: None,
                residual: None,
                missing: Some("ledger"),
            });
            continue;
        };
        let Some(t) = tol else {
            out.push(asset_row(id, amount, Some(bound), None, false)?);
            continue;
        };
        let pass = if threshold.min {
            plus(amount, t)? >= bound
        } else {
            minus(amount, t)? <= bound
        };
        let outside = if threshold.min {
            amount < bound
        } else {
            amount > bound
        };
        let mut difference = if outside {
            minus(amount, bound)?
        } else {
            Amount::ZERO
        };
        if !pass && difference == Amount::ZERO {
            difference = minus(amount, bound)?;
        }
        out.push(Evidence {
            asset_id: id.clone(),
            observed: Some(amount),
            expected: Some(bound),
            difference: Some(difference),
            tolerance: Some(t),
            reconciling_items: None,
            residual: None,
            missing: None,
        });
    }
    Ok(out)
}

/// The threshold run's word: a missing side fails, an unset tolerance errs, a difference past its tolerance fails.
pub fn fold_threshold(assets: &[Evidence]) -> Result<Status, String> {
    if assets.iter().any(|a| a.missing.is_some()) {
        return Ok(Status::Fail);
    }
    if assets.iter().any(|a| a.tolerance.is_none()) {
        return Ok(Status::Error);
    }
    for a in assets {
        if a.difference.is_some_and(|d| d != Amount::ZERO) && !within(a)? {
            return Ok(Status::Fail);
        }
    }
    if compared_of(assets) == 0 {
        return Ok(Status::NothingToCompare);
    }
    Ok(Status::Pass)
}

/// Each account's drift at the current instant (`Book.drift`): the cached column against every entry the snapshot shows.
pub struct Drift {
    pub cached: Vec<(String, Amount)>,
    pub replayed: Vec<(String, Amount)>,
}

fn of(list: &[(String, Amount)], id: &str) -> Amount {
    list.iter()
        .find(|(k, _)| k == id)
        .map_or(Amount::ZERO, |(_, v)| *v)
}

/// `withDrift(rows, book, tolerance)`: an asset with an account whose cached balance its entries do not explain fails,
/// its row observing the summed size of each account's drift against 0 (two drifts can never cancel).
pub fn with_drift(
    rows: Vec<Evidence>,
    accounts: &[(String, String)],
    drift: Option<&Drift>,
    tolerance: Option<&Tolerance>,
) -> Result<Vec<Evidence>, String> {
    let Some(drift) = drift else { return Ok(rows) };
    let mut drifted: Totals = Vec::new();
    for (id, asset) in accounts {
        let size = abs(minus(of(&drift.cached, id), of(&drift.replayed, id))?)?;
        let tol = Tolerance::for_asset(tolerance, asset)?;
        if tol.is_some_and(|t| size > t) {
            match drifted.iter_mut().find(|(a, _)| a == asset) {
                Some((_, v)) => *v = plus(*v, size)?,
                None => drifted.push((asset.clone(), size)),
            }
        }
    }
    if drifted.is_empty() {
        return Ok(rows);
    }
    let mut out: Vec<Evidence> = rows
        .into_iter()
        .filter(|r| get(&drifted, &r.asset_id).is_none())
        .collect();
    for (asset, size) in &drifted {
        out.push(asset_row(
            asset,
            *size,
            Some(Amount::ZERO),
            Tolerance::for_asset(tolerance, asset)?,
            true,
        )?);
    }
    out.sort_by(|a, b| a.asset_id.cmp(&b.asset_id));
    Ok(out)
}

/// `withItems(assets, items, tolerance)`: the named items come out of each asset's difference; an asset only the items
/// name gets a row of its own, so an item can never go unaccounted.
pub fn with_items(
    assets: Vec<Evidence>,
    items: &[&OpenItem],
    tolerance: Option<&Tolerance>,
) -> Result<Vec<Evidence>, String> {
    let mut sums: Totals = Vec::new();
    for i in items {
        match sums.iter_mut().find(|(a, _)| *a == i.asset_id) {
            Some((_, v)) => *v = plus(*v, i.amount)?,
            None => sums.push((i.asset_id.clone(), i.amount)),
        }
    }
    let mut rows = assets;
    for (asset, _) in &sums {
        if rows.iter().any(|r| r.asset_id == *asset) {
            continue;
        }
        let tol = Tolerance::for_asset(tolerance, asset)?;
        rows.push(asset_row(asset, Amount::ZERO, None, tol, false)?);
    }
    rows.sort_by(|a, b| a.asset_id.cmp(&b.asset_id));
    rows.into_iter()
        .map(|mut r| {
            let sum = get(&sums, &r.asset_id).unwrap_or(Amount::ZERO);
            r.reconciling_items = Some(sum);
            r.residual = match r.difference {
                Some(d) => Some(minus(d, sum)?),
                None => None,
            };
            Ok(r)
        })
        .collect()
}

/// `a.localeCompare(b)` for asset ids (ASCII letters and digits), as ICU's root collation orders them: digits before
/// letters, letters by their case-folded spelling, and on a tie lower case first.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let primary = |s: &str| s.to_ascii_lowercase();
    primary(a).cmp(&primary(b)).then_with(|| {
        for (x, y) in a.bytes().zip(b.bytes()) {
            if x != y {
                // Lower case sorts ahead of upper case at the tertiary level.
                return y.is_ascii_lowercase().cmp(&x.is_ascii_lowercase());
            }
        }
        a.len().cmp(&b.len())
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    fn tol(d: &str) -> Tolerance {
        Tolerance {
            default: Some(d.to_owned()),
            by_asset: Vec::new(),
        }
    }

    #[test]
    fn a_missing_side_fails_ahead_of_everything_and_nothing_compared_is_never_green() {
        assert_eq!(fold_assets(&[], false).unwrap(), Status::NothingToCompare);
        let t = tol("0");
        let rows = equal_assets(
            &vec![("USDT".to_owned(), Amount::from_scaled(5))],
            &vec![("USDT".to_owned(), Amount::from_scaled(5))],
            Some(&t),
            true,
            true,
        )
        .unwrap();
        assert_eq!(fold_assets(&rows, false).unwrap(), Status::Pass);
        let th = Threshold {
            min: false,
            by_asset: vec![("USDC".to_owned(), "1".to_owned())],
        };
        let rows = threshold_assets(&Vec::new(), &th, Some(&t)).unwrap();
        assert_eq!(rows[0].missing, Some("ledger"));
        assert_eq!(fold_threshold(&rows).unwrap(), Status::Fail);
    }

    #[test]
    fn a_threshold_outside_its_bound_names_the_gap() {
        let t = tol("0");
        let min = Threshold {
            min: true,
            by_asset: vec![("USDT".to_owned(), "10".to_owned())],
        };
        let rows = threshold_assets(
            &vec![("USDT".to_owned(), Amount::from_scaled(4))],
            &min,
            Some(&t),
        )
        .unwrap();
        assert_eq!(
            rows[0].difference,
            Some(Amount::from_scaled(4) - Amount::whole(10))
        );
        assert_eq!(fold_threshold(&rows).unwrap(), Status::Fail);
    }

    #[test]
    fn asset_ids_sort_as_locale_compare_does() {
        let mut ids = vec!["aa", "Ab", "AB", "10", "ab", "B"];
        ids.sort_by(|a, b| locale_compare(a, b));
        assert_eq!(ids, vec!["10", "aa", "ab", "Ab", "AB", "B"]);
    }
}
