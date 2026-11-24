//! Slice `profile` (`PORT.md`): the caller's own Blueprint (`me`), its visibility (`setVisibility`) and its mentor
//! shortlist (`mentors`), as `get`, `setVisibility` and `mentors` in `services/svc-blueprint/src/blueprint-service.ts`
//! answer them. Each acts on the signed principal, never an id from the input.
//!
//! Rows are checked as read, with the TypeScript's own row schemas (`BlueprintRow`, `MentorMatchRow`, recorded in
//! `door/schemas.json`): a row that fails is the zod error the TypeScript throws, never a guess. The record's output
//! schema then shapes what leaves (`door`).

use postgres::Row;
use postgres::types::ToSql;
use service_kit::json::Json;
use service_kit::schema::{self, Value};
use service_kit::time::Instant;

use crate::db::{Store, StoreError};
use crate::door::{Ctx, inputs};
use crate::errors::Refusal;

/// A Blueprint row's columns, in `BlueprintRow`'s order. `user_id` and the uuids are read as text and the enum as its
/// label, as the TypeScript driver returns them; `created_at` as its milliseconds, as a `Date` holds it.
const BLUEPRINT_COLUMNS: &str = "id::text AS id, user_id::text AS user_id, engine_version, profile::text AS profile, \
     card_asset_url, visibility::text AS visibility, mentor_available, \
     floor(extract(epoch FROM created_at) * 1000)::bigint AS created_at";

impl From<StoreError> for Refusal {
    fn from(e: StoreError) -> Refusal {
        Refusal::Other {
            message: e.message,
            code: e.code,
        }
    }
}

/// A failure that is not a refusal (a broken recorded tree, a column that is not JSON): a 500 with its message.
fn internal(message: impl Into<String>) -> Refusal {
    Refusal::Other {
        message: message.into(),
        code: None,
    }
}

/// `ctx.principal.userId` (`userOf` in `router.ts`): every call here is scope-guarded, so the door has already refused a
/// caller without one.
fn user_of(ctx: &Ctx<'_>) -> Result<String, Refusal> {
    ctx.principal.map(|p| p.user_id.clone()).ok_or_else(|| {
        Refusal::Trpc(service_kit::trpc::TrpcError::plain(
            "UNAUTHORIZED",
            "Not signed in",
        ))
    })
}

/// The slice's answers.
pub fn handle(store: &Store, ctx: &Ctx<'_>) -> Result<Option<Json>, Refusal> {
    let user = user_of(ctx)?;
    match ctx.call.path.as_str() {
        "me" => Ok(Some(get(store, &user)?.unwrap_or(Json::Null))),
        "setVisibility" => {
            let visibility = ctx
                .input
                .get("visibility")
                .as_str()
                .ok_or_else(|| internal("setVisibility: no visibility in the checked input"))?
                .to_owned();
            set_visibility(store, &user, &visibility).map(Some)
        }
        "mentors" => mentors(store, &user).map(Some),
        other => Err(internal(format!("{other} is not slice profile's"))),
    }
}

fn query(store: &Store, sql: &str, params: &[&(dyn ToSql + Sync)]) -> Result<Vec<Row>, Refusal> {
    let pool = store.pool()?;
    let mut conn = pool.get().map_err(StoreError::from)?;
    let rows = conn
        .client()
        .map_err(StoreError::from)?
        .query(sql, params)
        .map_err(StoreError::from)?;
    Ok(rows)
}

/// `<Row>.array().parse(rows)`: the rows as the schema returns them, or the `ZodError` it throws.
fn checked(row_schema: &str, rows: Vec<Value>) -> Result<Vec<Value>, Refusal> {
    let part = inputs::rows_part(row_schema).map_err(internal)?;
    match inputs::parse_part(part, Value::Array(rows)).map_err(internal)? {
        Ok(Value::Array(rows)) => Ok(rows),
        Ok(_) => Err(internal(format!("{row_schema}: not an array"))),
        Err(inputs::Refused::Issues(issues)) => Err(internal(schema::message(&issues))),
        Err(inputs::Refused::Thrown(message)) => Err(internal(message)),
    }
}

fn text(row: &Row, column: &str) -> Result<Value, Refusal> {
    let v: Option<String> = row.try_get(column).map_err(StoreError::from)?;
    Ok(v.map_or(Value::Null, Value::String))
}

/// One `blueprints` row as the driver hands it to `BlueprintRow`.
fn blueprint_row(row: &Row) -> Result<Value, Refusal> {
    let profile: String = row.try_get("profile").map_err(StoreError::from)?;
    let profile = service_kit::json::parse(&profile).map_err(|e| internal(e.message))?;
    let mentor_available: bool = row.try_get("mentor_available").map_err(StoreError::from)?;
    let created_at: i64 = row.try_get("created_at").map_err(StoreError::from)?;
    Ok(Value::Object(vec![
        ("id".to_owned(), text(row, "id")?),
        ("user_id".to_owned(), text(row, "user_id")?),
        ("engine_version".to_owned(), text(row, "engine_version")?),
        ("profile".to_owned(), Value::from_json(&profile)),
        ("card_asset_url".to_owned(), text(row, "card_asset_url")?),
        ("visibility".to_owned(), text(row, "visibility")?),
        ("mentor_available".to_owned(), Value::Bool(mentor_available)),
        ("created_at".to_owned(), Value::Date(Some(created_at))),
    ]))
}

/// `toBlueprintRecord`.
fn to_blueprint_record(row: &Value) -> Json {
    let json = |key: &str| row.get(key).to_json().unwrap_or(Json::Null);
    let created_at = match row.get("created_at") {
        Value::Date(Some(ms)) => Json::str(Instant(*ms).iso()),
        _ => Json::Null,
    };
    Json::obj([
        ("id", json("id")),
        ("userId", json("user_id")),
        ("engineVersion", json("engine_version")),
        ("profile", json("profile")),
        ("cardAssetUrl", json("card_asset_url")),
        ("visibility", json("visibility")),
        ("createdAt", created_at),
    ])
}

/// The first Blueprint of `rows`, checked, as its record.
fn first_blueprint(rows: &[Row]) -> Result<Option<Json>, Refusal> {
    let rows = rows.iter().map(blueprint_row).collect::<Result<_, _>>()?;
    Ok(checked("BlueprintRow", rows)?
        .first()
        .map(to_blueprint_record))
}

/// `get`: the caller's Blueprint, or `null` before they have one.
pub fn get(store: &Store, user: &str) -> Result<Option<Json>, Refusal> {
    let rows = query(
        store,
        &format!(
            "SELECT {BLUEPRINT_COLUMNS} FROM blueprint.blueprints WHERE user_id = $1::text::uuid"
        ),
        &[&user],
    )?;
    first_blueprint(&rows)
}

/// `setVisibility`: the caller's own visibility, refused with `blueprint.not_found` before they have a Blueprint.
pub fn set_visibility(store: &Store, user: &str, visibility: &str) -> Result<Json, Refusal> {
    let rows = query(
        store,
        &format!(
            "UPDATE blueprint.blueprints \
                SET visibility = $2::text::blueprint.blueprint_visibility, updated_at = now() \
              WHERE user_id = $1::text::uuid \
             RETURNING {BLUEPRINT_COLUMNS}"
        ),
        &[&user, &visibility],
    )?;
    first_blueprint(&rows)?.ok_or_else(|| {
        Refusal::blueprint(
            "blueprint.not_found",
            "No Blueprint to update — run the Blueprint session first",
        )
        .unwrap_or_else(|| internal("blueprint.not_found is not in the catalogue"))
    })
}

/// `mentors`: the caller's shortlist, best fit first, then by mentor id.
pub fn mentors(store: &Store, user: &str) -> Result<Json, Refusal> {
    let rows = query(
        store,
        "SELECT m.student_id::text AS student_id, m.mentor_id::text AS mentor_id, m.fit_score, \
                m.status::text AS status \
           FROM blueprint.mentor_matches m WHERE m.student_id = $1::text::uuid \
          ORDER BY m.fit_score DESC, m.mentor_id ASC",
        &[&user],
    )?;
    let rows = rows
        .iter()
        .map(|row| {
            let fit_score: i32 = row.try_get("fit_score").map_err(StoreError::from)?;
            Ok(Value::Object(vec![
                ("student_id".to_owned(), text(row, "student_id")?),
                ("mentor_id".to_owned(), text(row, "mentor_id")?),
                ("fit_score".to_owned(), Value::Number(f64::from(fit_score))),
                ("status".to_owned(), text(row, "status")?),
            ]))
        })
        .collect::<Result<Vec<_>, Refusal>>()?;
    // `toMentorMatch`.
    Ok(Json::Array(
        checked("MentorMatchRow", rows)?
            .iter()
            .map(|row| {
                let json = |key: &str| row.get(key).to_json().unwrap_or(Json::Null);
                Json::obj([
                    ("studentId", json("student_id")),
                    ("mentorId", json("mentor_id")),
                    ("fitScore", json("fit_score")),
                    ("status", json("status")),
                ])
            })
            .collect(),
    ))
}
