//! Saved activity filters (`saved-filters.ts`, BK-acct-07): a person names a set of `activity.list` filters and reuses
//! it. Self-only. The name is the business key: the same name with the same filter replays, with another filter it
//! refuses `bank.activity_filter_conflict`. The list's page size is required; blank is not a default.

use service_kit::json::{self, Json};
use service_kit::money::js_trim;

use super::records::ms_col;
use super::service::{FeedError, bank};
use crate::db::{Store, StoreError, with_client};

/// `SavedFilter`.
#[derive(Debug, Clone, PartialEq)]
pub struct Saved {
    pub name: String,
    pub filter: Json,
    pub created_at: String,
}

/// The keys of `savedFilterBody` (`activityListInput` without `limit` and `cursor`), in the schema's order.
pub const BODY_KEYS: [&str; 14] = [
    "assetId",
    "kind",
    "direction",
    "from",
    "to",
    "q",
    "minAmount",
    "maxAmount",
    "sort",
    "accountId",
    "year",
    "taxYear",
    "address",
    "hasNote",
];

/// `String(value)` for an array element.
fn js_string(v: &Json) -> String {
    match v {
        Json::String(s) => s.clone(),
        Json::Number(n) => json::js_number_string(*n),
        Json::Bool(b) => b.to_string(),
        Json::Null => "null".to_owned(),
        Json::Array(a) => a.iter().map(js_string).collect::<Vec<_>>().join(","),
        Json::Object(_) => "[object Object]".to_owned(),
    }
}

/// `canonicalFilter`: key order, array order and absent keys do not make two filters different.
pub fn canonical(filter: &Json) -> String {
    let Json::Object(fields) = filter else {
        return "{}".to_owned();
    };
    let mut keys: Vec<&(String, Json)> = fields.iter().collect();
    keys.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    let out: Vec<(String, Json)> = keys
        .into_iter()
        .map(|(k, v)| {
            let v = match v {
                Json::Array(a) => {
                    let mut s: Vec<String> = a.iter().map(js_string).collect();
                    s.sort_by(|x, y| x.encode_utf16().cmp(y.encode_utf16()));
                    Json::Array(s.into_iter().map(Json::String).collect())
                }
                v => v.clone(),
            };
            (k.clone(), v)
        })
        .collect();
    Json::Object(json::js_key_order(out)).compact()
}

/// `savedFilterBody.parse(row.filter)`: the stored filter in the schema's key order. A stored value the schema does
/// not hold (an unknown key, not an object) is the ZodError the TypeScript throws: an opaque failure.
pub fn body(filter: &Json) -> Result<Json, FeedError> {
    let broken = || FeedError::Other(StoreError::new("the saved filter does not parse", None));
    let Json::Object(fields) = filter else {
        return Err(broken());
    };
    if fields.iter().any(|(k, _)| !BODY_KEYS.contains(&k.as_str())) {
        return Err(broken());
    }
    Ok(Json::Object(
        BODY_KEYS
            .iter()
            .filter_map(|k| filter.get(k).map(|v| ((*k).to_owned(), v.clone())))
            .collect(),
    ))
}

fn row(r: &postgres::Row) -> Result<Saved, StoreError> {
    let text: String = r.try_get(1)?;
    Ok(Saved {
        name: r.try_get(0)?,
        filter: json::parse(&text).map_err(|e| StoreError::new(e.message, None))?,
        created_at: service_kit::time::Instant(r.try_get::<_, i64>(2)?).iso(),
    })
}

fn cols() -> String {
    format!("name, filter::text, {}", ms_col("created_at"))
}

/// `save`.
pub fn save(
    store: &Store,
    user_id: &str,
    name: &str,
    filter: &Json,
) -> Result<(Saved, bool), FeedError> {
    let trimmed = js_trim(name);
    let n = trimmed.encode_utf16().count();
    if n == 0 || n > 60 {
        return Err(bank(
            "bank.activity_filter_name_invalid",
            "A saved filter needs a name of 1 to 60 characters",
        ));
    }
    let canon = canonical(filter);
    if canon == "{}" {
        return Err(bank(
            "bank.activity_filter_empty",
            "A saved filter needs at least one filter",
        ));
    }
    let pool = store.pool()?;
    let inserted = with_client(pool, |c| {
        let rows = c.query(
            &format!(
                "INSERT INTO bank.activity_saved_filters (user_id, name, filter) \
                 VALUES ($1::text::uuid, $2, $3::text::jsonb) \
                 ON CONFLICT (user_id, name) DO NOTHING RETURNING {}",
                cols()
            ),
            &[&user_id, &trimmed, &canon],
        )?;
        rows.first().map(row).transpose()
    })?;
    if let Some(saved) = inserted {
        return Ok((saved, false));
    }
    let existing = with_client(pool, |c| {
        let rows = c.query(
            &format!(
                "SELECT {} FROM bank.activity_saved_filters WHERE user_id = $1::text::uuid AND name = $2",
                cols()
            ),
            &[&user_id, &trimmed],
        )?;
        rows.first().map(row).transpose()
    })?;
    match existing {
        Some(saved) if canonical(&saved.filter) == canon => Ok((saved, true)),
        _ => Err(bank(
            "bank.activity_filter_conflict",
            "A saved filter with that name already holds a different filter",
        )),
    }
}

/// `list`: by name, at most `limit`; no page size refuses.
pub fn list(store: &Store, user_id: &str, limit: Option<i64>) -> Result<Vec<Saved>, FeedError> {
    let Some(limit) = limit else {
        return Err(bank(
            "bank.activity_filter_limit_unset",
            "Saved filter page size is required; blank is not 50",
        ));
    };
    let pool = store.pool()?;
    Ok(with_client(pool, |c| {
        c.query(
            &format!(
                "SELECT {} FROM bank.activity_saved_filters WHERE user_id = $1::text::uuid ORDER BY name ASC LIMIT $2",
                cols()
            ),
            &[&user_id, &limit],
        )?
        .iter()
        .map(row)
        .collect()
    })?)
}

/// `remove`: deleting a name that is not there answers false.
pub fn remove(store: &Store, user_id: &str, name: &str) -> Result<bool, FeedError> {
    let pool = store.pool()?;
    let trimmed = js_trim(name);
    Ok(with_client(pool, |c| {
        Ok(!c
            .query(
                "DELETE FROM bank.activity_saved_filters WHERE user_id = $1::text::uuid AND name = $2 RETURNING name",
                &[&user_id, &trimmed],
            )?
            .is_empty())
    })?)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn canonical_form_ignores_key_order_array_order_and_absent_keys() {
        let a = json::parse(r#"{"kind":["fee","deposit"],"direction":"in"}"#).unwrap();
        let b = json::parse(r#"{"direction":"in","kind":["deposit","fee"]}"#).unwrap();
        assert_eq!(canonical(&a), canonical(&b));
        assert_eq!(
            canonical(&a),
            r#"{"direction":"in","kind":["deposit","fee"]}"#
        );
        let c = json::parse(r#"{"direction":"out"}"#).unwrap();
        assert_ne!(canonical(&a), canonical(&c));
        assert_eq!(canonical(&json::parse("{}").unwrap()), "{}");
    }

    #[test]
    fn the_stored_body_comes_back_in_the_schemas_order_and_an_unknown_key_breaks_it() {
        let stored = json::parse(r#"{"q":"rent","year":2026,"kind":["fee"]}"#).unwrap();
        assert_eq!(
            body(&stored).unwrap().compact(),
            r#"{"kind":["fee"],"q":"rent","year":2026}"#
        );
        assert!(body(&json::parse(r#"{"userId":"x"}"#).unwrap()).is_err());
    }
}
