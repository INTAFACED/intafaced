//! Slice `shares` (`PORT.md`): revocable card shares (`shares.create`, `shares.list`, `shares.revoke`) and who opened
//! them (`shares.openers`), as `createShare`, `listShares`, `revokeShare`, `shareOpeners`, `toCardShare` and
//! `toOpener` in `services/svc-blueprint/src/blueprint-service.ts` answer them.
//!
//! - **Blank owner limits refuse closed.** `BLUEPRINT_SHARES_PER_OWNER` (`blueprint.share_limit_unset`) and
//!   `BLUEPRINT_OPENS_LIST_LIMIT` (`blueprint.opens_list_limit_unset`) are checked before any read or write. `0` is a
//!   deliberate cap or empty page, never unset.
//! - **One active share per `(owner, size)`.** Repeating `shares.create` for an active size returns that share; revoking
//!   frees the slot so the size may be shared again.
//! - **Revoke is idempotent and private.** Revoking an already-revoked share returns the stored row; another account's
//!   share is `blueprint.not_found`.
//! - **Openers carry no account id.** Only `crew member` or `signed-in account`, times and count.

use postgres::{GenericClient, Row};
use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::time::Instant;

use crate::card::CARD_NOT_FOUND;
use crate::db::{self, Store, StoreError, query, with_client};
use crate::door::Ctx;
use crate::env::Settings;
use crate::errors::Refusal;
use crate::profile::{checked, internal, text, user_of};

/// `card_shares` columns in `ShareRow`'s order, timestamps as epoch milliseconds as a JS `Date` holds them.
pub(crate) const SHARE_COLUMNS: &str = "id::text AS id, owner_user_id::text AS owner_user_id, size, \
     floor(extract(epoch FROM created_at) * 1000)::bigint AS created_at, \
     floor(extract(epoch FROM revoked_at) * 1000)::bigint AS revoked_at";

fn not_found() -> Refusal {
    Refusal::blueprint("blueprint.not_found", CARD_NOT_FOUND)
        .unwrap_or_else(|| internal("blueprint.not_found is not in the catalogue"))
}

fn share_limit_reached(message: &str) -> Refusal {
    Refusal::blueprint("blueprint.share_limit_reached", message)
        .unwrap_or_else(|| internal("blueprint.share_limit_reached is not in the catalogue"))
}

/// `publishedSharesPerOwner`: blank or negative refuses with `blueprint.share_limit_unset`. `0` is a deliberate cap.
pub fn published_shares_per_owner(value: Option<i64>) -> Result<i64, Refusal> {
    match value {
        Some(n) if n >= 0 => Ok(n),
        _ => Err(Refusal::blueprint(
            "blueprint.share_limit_unset",
            "BLUEPRINT_SHARES_PER_OWNER is unset — owner must publish a share limit (never invent one)",
        )
        .unwrap_or_else(|| internal("blueprint.share_limit_unset is not in the catalogue"))),
    }
}

/// `publishedOpensListLimit`: blank or negative refuses with `blueprint.opens_list_limit_unset`. `0` is an empty page.
pub fn published_opens_list_limit(value: Option<i64>) -> Result<i64, Refusal> {
    match value {
        Some(n) if n >= 0 => Ok(n),
        _ => Err(Refusal::blueprint(
            "blueprint.opens_list_limit_unset",
            "BLUEPRINT_OPENS_LIST_LIMIT is unset — owner must publish an openers list limit (never invent one)",
        )
        .unwrap_or_else(|| internal("blueprint.opens_list_limit_unset is not in the catalogue"))),
    }
}

/// One `card_shares` row as the driver hands it to `ShareRow`.
pub(crate) fn share_row(row: &Row) -> Result<Value, Refusal> {
    let date = |column: &str| -> Result<Value, Refusal> {
        let ms: Option<i64> = row.try_get(column).map_err(StoreError::from)?;
        Ok(ms.map_or(Value::Null, |ms| Value::Date(Some(ms))))
    };
    Ok(Value::Object(vec![
        ("id".to_owned(), text(row, "id")?),
        ("owner_user_id".to_owned(), text(row, "owner_user_id")?),
        ("size".to_owned(), text(row, "size")?),
        ("created_at".to_owned(), date("created_at")?),
        ("revoked_at".to_owned(), date("revoked_at")?),
    ]))
}

/// One `card_opens` projection row as the driver hands it to `OpenerRow`.
pub(crate) fn opener_row(row: &Row) -> Result<Value, Refusal> {
    let first_opened: i64 = row.try_get("first_opened").map_err(StoreError::from)?;
    let last_opened: i64 = row.try_get("last_opened").map_err(StoreError::from)?;
    let open_count: i32 = row.try_get("open_count").map_err(StoreError::from)?;
    Ok(Value::Object(vec![
        ("kind".to_owned(), text(row, "kind")?),
        ("first_opened".to_owned(), Value::Date(Some(first_opened))),
        ("last_opened".to_owned(), Value::Date(Some(last_opened))),
        (
            "open_count".to_owned(),
            Value::Number(f64::from(open_count)),
        ),
    ]))
}

fn share_rows(rows: &[Row]) -> Result<Vec<Value>, Refusal> {
    let raw = rows.iter().map(share_row).collect::<Result<Vec<_>, _>>()?;
    checked("ShareRow", raw)
}

fn iso(value: &Value) -> Json {
    match value {
        Value::Date(Some(ms)) => Json::str(Instant(*ms).iso()),
        _ => Json::Null,
    }
}

/// `toCardShare`: shapes one checked `ShareRow` with its total `open_count` across viewers.
pub(crate) fn to_card_share<C: GenericClient>(
    client: &mut C,
    row: &Value,
) -> Result<Json, Refusal> {
    let id = row
        .get("id")
        .as_str()
        .ok_or_else(|| internal("ShareRow: no id"))?;
    let counts = query(
        client,
        "SELECT COALESCE(SUM(open_count), 0)::int AS n FROM blueprint.card_opens WHERE share_id = $1::text::uuid",
        &[&id],
    )?;
    let open_count: i32 = match counts.first() {
        Some(r) => r.try_get("n").map_err(StoreError::from)?,
        None => 0,
    };
    let (revoked_at, state) = match row.get("revoked_at") {
        Value::Date(Some(ms)) => (Json::str(Instant(*ms).iso()), "revoked"),
        _ => (Json::Null, "active"),
    };
    let json = |key: &str| row.get(key).to_json().unwrap_or(Json::Null);
    Ok(Json::obj([
        ("id", json("id")),
        ("size", json("size")),
        ("createdAt", iso(row.get("created_at"))),
        ("revokedAt", revoked_at),
        ("state", Json::str(state)),
        ("openCount", Json::int(i64::from(open_count))),
    ]))
}

/// `toOpener`: shapes one checked `OpenerRow`. Never carries a viewer id.
pub(crate) fn to_opener(row: &Value) -> Json {
    let json = |key: &str| row.get(key).to_json().unwrap_or(Json::Null);
    Json::obj([
        ("kind", json("kind")),
        ("firstOpened", iso(row.get("first_opened"))),
        ("lastOpened", iso(row.get("last_opened"))),
        ("openCount", json("open_count")),
    ])
}

/// The slice's answers.
pub fn handle(store: &Store, settings: &Settings, ctx: &Ctx<'_>) -> Result<Option<Json>, Refusal> {
    let user = user_of(ctx)?;
    match ctx.call.path.as_str() {
        "shares.create" => {
            let size = ctx
                .input
                .get("size")
                .as_str()
                .ok_or_else(|| internal("shares.create: no size in the checked input"))?;
            create_share(store, settings, &user, size).map(Some)
        }
        "shares.list" => list_shares(store, &user).map(Some),
        "shares.revoke" => {
            let share_id = ctx
                .input
                .get("shareId")
                .as_str()
                .ok_or_else(|| internal("shares.revoke: no shareId in the checked input"))?;
            revoke_share(store, &user, share_id).map(Some)
        }
        "shares.openers" => {
            let share_id = ctx
                .input
                .get("shareId")
                .as_str()
                .ok_or_else(|| internal("shares.openers: no shareId in the checked input"))?;
            share_openers(store, settings, &user, share_id).map(Some)
        }
        other => Err(internal(format!("{other} is not slice shares's"))),
    }
}

/// `createShare`: one active share per `(owner, size)`, bounded by `BLUEPRINT_SHARES_PER_OWNER`.
pub fn create_share(
    store: &Store,
    settings: &Settings,
    user: &str,
    size: &str,
) -> Result<Json, Refusal> {
    let limit = published_shares_per_owner(settings.shares_per_owner)?;
    db::transaction(store, |tx| {
        let owner = query(
            tx,
            "SELECT id::text AS id FROM blueprint.blueprints WHERE user_id = $1::text::uuid FOR UPDATE",
            &[&user],
        )?;
        if owner.is_empty() {
            return Err(not_found());
        }

        let existing = query(
            tx,
            &format!(
                "SELECT {SHARE_COLUMNS} \
                   FROM blueprint.card_shares \
                  WHERE owner_user_id = $1::text::uuid AND size = $2 AND revoked_at IS NULL"
            ),
            &[&user, &size],
        )?;
        let existing = share_rows(&existing)?;
        if let Some(already) = existing.first() {
            return to_card_share(tx, already);
        }

        let active = query(
            tx,
            "SELECT count(*)::int AS n \
               FROM blueprint.card_shares \
              WHERE owner_user_id = $1::text::uuid AND revoked_at IS NULL",
            &[&user],
        )?;
        let active_count: i32 = match active.first() {
            Some(r) => r.try_get("n").map_err(StoreError::from)?,
            None => 0,
        };
        if i64::from(active_count) >= limit {
            return Err(share_limit_reached(
                "No active share slot is left under the published shares-per-owner limit",
            ));
        }

        let inserted = query(
            tx,
            &format!(
                "INSERT INTO blueprint.card_shares (owner_user_id, size) \
                 VALUES ($1::text::uuid, $2) \
                 RETURNING {SHARE_COLUMNS}"
            ),
            &[&user, &size],
        )?;
        let inserted = share_rows(&inserted)?;
        let Some(row) = inserted.first() else {
            return Err(share_limit_reached("The share could not be recorded"));
        };
        to_card_share(tx, row)
    })
}

/// `listShares`: every share the caller owns (active and revoked), newest first, with total open counts.
pub fn list_shares(store: &Store, user: &str) -> Result<Json, Refusal> {
    with_client(store, |c| {
        let rows = query(
            c,
            &format!(
                "SELECT {SHARE_COLUMNS} \
                   FROM blueprint.card_shares \
                  WHERE owner_user_id = $1::text::uuid \
                  ORDER BY created_at DESC, id DESC"
            ),
            &[&user],
        )?;
        let rows = share_rows(&rows)?;
        let mut listed = Vec::with_capacity(rows.len());
        for row in &rows {
            listed.push(to_card_share(c, row)?);
        }
        Ok(Json::Array(listed))
    })
}

/// `revokeShare`: revokes the caller's share; idempotent on an already-revoked share; another account's share is not found.
pub fn revoke_share(store: &Store, user: &str, share_id: &str) -> Result<Json, Refusal> {
    db::transaction(store, |tx| {
        let updated = query(
            tx,
            &format!(
                "UPDATE blueprint.card_shares \
                    SET revoked_at = now() \
                  WHERE id = $1::text::uuid AND owner_user_id = $2::text::uuid AND revoked_at IS NULL \
                 RETURNING {SHARE_COLUMNS}"
            ),
            &[&share_id, &user],
        )?;
        let updated = share_rows(&updated)?;
        if let Some(fresh) = updated.first() {
            return to_card_share(tx, fresh);
        }

        let stored = query(
            tx,
            &format!(
                "SELECT {SHARE_COLUMNS} \
                   FROM blueprint.card_shares \
                  WHERE id = $1::text::uuid AND owner_user_id = $2::text::uuid"
            ),
            &[&share_id, &user],
        )?;
        let stored = share_rows(&stored)?;
        let Some(row) = stored.first() else {
            return Err(not_found());
        };
        to_card_share(tx, row)
    })
}

/// `shareOpeners`: opener rows for the caller's own share, newest first, bounded by `BLUEPRINT_OPENS_LIST_LIMIT`.
pub fn share_openers(
    store: &Store,
    settings: &Settings,
    user: &str,
    share_id: &str,
) -> Result<Json, Refusal> {
    let limit = published_opens_list_limit(settings.opens_list_limit)?;
    with_client(store, |c| {
        let owned = query(
            c,
            "SELECT id::text AS id \
               FROM blueprint.card_shares \
              WHERE id = $1::text::uuid AND owner_user_id = $2::text::uuid",
            &[&share_id, &user],
        )?;
        if owned.is_empty() {
            return Err(not_found());
        }
        if limit == 0 {
            return Ok(Json::Array(Vec::new()));
        }
        let rows = query(
            c,
            "SELECT CASE \
                      WHEN EXISTS ( \
                        SELECT 1 \
                          FROM blueprint.crew_members viewer \
                          JOIN blueprint.crew_members owner_member ON owner_member.crew_id = viewer.crew_id \
                         WHERE viewer.user_id = o.viewer_user_id \
                           AND owner_member.user_id = $2::text::uuid \
                      ) THEN 'crew member' \
                      ELSE 'signed-in account' \
                    END AS kind, \
                    floor(extract(epoch FROM o.first_opened) * 1000)::bigint AS first_opened, \
                    floor(extract(epoch FROM o.last_opened) * 1000)::bigint AS last_opened, \
                    o.open_count \
               FROM blueprint.card_opens o \
               JOIN blueprint.card_shares s ON s.id = o.share_id \
              WHERE s.id = $1::text::uuid AND s.owner_user_id = $2::text::uuid \
              ORDER BY o.last_opened DESC, o.first_opened DESC \
              LIMIT $3",
            &[&share_id, &user, &limit],
        )?;
        let raw = rows.iter().map(opener_row).collect::<Result<Vec<_>, _>>()?;
        let rows = checked("OpenerRow", raw)?;
        Ok(Json::Array(rows.iter().map(to_opener).collect()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn published_limits_refuse_unset_and_negative_and_accept_zero() {
        assert_eq!(published_shares_per_owner(Some(0)), Ok(0));
        assert_eq!(published_shares_per_owner(Some(5)), Ok(5));
        for bad in [None, Some(-1)] {
            assert_eq!(
                published_shares_per_owner(bad),
                Err(Refusal::Blueprint {
                    code: "blueprint.share_limit_unset",
                    message: "BLUEPRINT_SHARES_PER_OWNER is unset — owner must publish a share limit (never invent one)".to_owned(),
                })
            );
        }

        assert_eq!(published_opens_list_limit(Some(0)), Ok(0));
        assert_eq!(published_opens_list_limit(Some(20)), Ok(20));
        for bad in [None, Some(-1)] {
            assert_eq!(
                published_opens_list_limit(bad),
                Err(Refusal::Blueprint {
                    code: "blueprint.opens_list_limit_unset",
                    message: "BLUEPRINT_OPENS_LIST_LIMIT is unset — owner must publish an openers list limit (never invent one)".to_owned(),
                })
            );
        }
    }
}
