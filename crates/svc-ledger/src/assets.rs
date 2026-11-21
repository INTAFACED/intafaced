//! The one supported asset and network registry (`services/svc-ledger/src/ledger/supported-assets.ts`), on the
//! `assets` rows every balance has a foreign key to, and the append-only `asset_edits` record of who changed them.
//!
//! - [`list`] answers the published rows (precision set), filtered by state or action; [`get`] answers one row, and a
//!   row whose precision the owner has not published refuses `ledger.asset_precision_unset`: it is never read as 18.
//!   Each row is checked against `registryAssetSchema` on the way out; a stored row that does not fit is a fault.
//! - [`operator_list`] answers every row, published or not, so a founder sees what is still blank.
//! - [`apply_edit`] applies one founder edit two founders approved in identity (`ledger.asset_edit`, target
//!   `svc-ledger`, the asset). Identity keeps only the payload hash, so it is recomputed here ([`edit_hash`]) from the
//!   edit that travels with the call, and the approval's version is the row's revision (`0` for a new asset). One
//!   operation id applies once: a retry answers the row that operation produced.
//!
//! Every input is parsed by the schemas `scripts/record-door.mjs` records from `packages/contracts/src/asset-registry.ts`
//! (`door/schemas.json`), so a refusal reads as zod's.

use postgres::IsolationLevel;
use postgres::types::ToSql;
use service_kit::approvals::ConsumeInput;
use service_kit::json::{self, Json};
use service_kit::schema::{self, Issue, Outcome as Parsed, Value, js_trim};
use sha2::{Digest, Sha256};

use crate::approval::{self, Approvals, Refused};
use crate::db::{Store, StoreError, transaction, with_client};
use crate::door::parse;

/// `ASSET_NOT_FOUND`.
pub const NOT_FOUND: &str = "ledger.asset_not_found";
/// `ASSET_PRECISION_UNSET`: the owner has not said; never read as a default.
pub const PRECISION_UNSET: &str = "ledger.asset_precision_unset";
/// `ASSET_PRECISION_INVALID`.
pub const PRECISION_INVALID: &str = "ledger.asset_precision_invalid";
/// `ASSET_DEFAULT_NETWORK_NOT_LISTED`.
pub const DEFAULT_NETWORK_NOT_LISTED: &str = crate::refines::DEFAULT_NETWORK_NOT_LISTED;
/// `ASSET_EDIT_INVALID`.
pub const EDIT_INVALID: &str = "ledger.asset_edit_invalid";
/// `ASSET_LIST_FILTER_INVALID`: a read refusal, distinct from a refused edit.
pub const LIST_FILTER_INVALID: &str = "ledger.asset_list_filter_invalid";
/// `ASSET_EDIT_STALE`: another edit landed after this one was approved. Nothing changed.
pub const EDIT_STALE: &str = "ledger.asset_edit_stale";
/// `ASSET_OPERATION_CONFLICT`: the operation id was already used for another approval or edit. Nothing changed.
pub const OPERATION_CONFLICT: &str = "ledger.asset_operation_conflict";
/// `ASSET_EDIT_ACTION_TYPE`.
pub const ACTION_TYPE: &str = "ledger.asset_edit";
/// `MAX_ASSET_PRECISION`.
const MAX_PRECISION: u32 = 18;

/// Why a registry call did not answer a row.
#[derive(Debug, Clone, PartialEq)]
pub enum Refusal {
    /// A `LedgerError`: its code and own message.
    Coded { code: String, message: String },
    /// A `ZodError` thrown by `registryAssetSchema.parse`: its message, the issues as pretty JSON.
    Zod(String),
    /// The approval was not spent.
    Approval(Refused),
    /// The database refused.
    Store(StoreError),
}

impl Refusal {
    fn coded(code: &str, message: impl Into<String>) -> Refusal {
        Refusal::Coded {
            code: code.to_owned(),
            message: message.into(),
        }
    }
}

impl From<StoreError> for Refusal {
    fn from(e: StoreError) -> Refusal {
        Refusal::Store(e)
    }
}

impl From<Refused> for Refusal {
    fn from(e: Refused) -> Refusal {
        Refusal::Approval(e)
    }
}

/// `issues.map((i) => i.message).join('; ')`.
fn joined(issues: &[Issue]) -> String {
    issues
        .iter()
        .map(Issue::message)
        .collect::<Vec<_>>()
        .join("; ")
}

/// A recorded schema's verdict; a refine that throws is the ledger's own fault.
fn run(name: &str, value: Value) -> Result<Parsed, Refusal> {
    parse(name, value).map_err(|thrown| Refusal::Store(StoreError::new(thrown, None)))
}

/// One `assets` row as the reads select it.
fn columns() -> String {
    format!(
        "id, kind::text, precision, networks::text, default_network_id, allowed_actions, state, revision, {}",
        iso("updated_at")
    )
}

/// `toOperatorRow(row)`: the row in the wire's names, `networks` as stored.
fn operator_row(row: &postgres::Row) -> Result<Json, StoreError> {
    let precision: Option<i32> = row.try_get(2)?;
    let networks: String = row.try_get(3)?;
    let actions: Vec<String> = row.try_get(5)?;
    let default: Option<String> = row.try_get(4)?;
    Ok(Json::Object(vec![
        ("id".to_owned(), Json::str(row.try_get::<_, String>(0)?)),
        ("kind".to_owned(), Json::str(row.try_get::<_, String>(1)?)),
        (
            "precision".to_owned(),
            precision.map_or(Json::Null, |p| Json::int(i64::from(p))),
        ),
        (
            "networks".to_owned(),
            json::parse(&networks)
                .map_err(|e| StoreError::new(format!("assets.networks: {e:?}"), None))?,
        ),
        (
            "defaultNetworkId".to_owned(),
            default.map_or(Json::Null, Json::String),
        ),
        (
            "allowedActions".to_owned(),
            Json::Array(actions.into_iter().map(Json::String).collect()),
        ),
        ("state".to_owned(), Json::str(row.try_get::<_, String>(6)?)),
        (
            "revision".to_owned(),
            Json::int(i64::from(row.try_get::<_, i32>(7)?)),
        ),
        (
            "updatedAt".to_owned(),
            Json::str(row.try_get::<_, String>(8)?),
        ),
    ]))
}

/// `registryAssetSchema.parse(row)`: the row in the wire shape, or the `ZodError` it throws.
fn registry_asset(row: &Json) -> Result<Json, Refusal> {
    match run("registryAsset", Value::from_json(row))? {
        Parsed::Ok(v) => Ok(v.to_json().unwrap_or(Json::Null)),
        Parsed::Issues(issues) => Err(Refusal::Zod(schema::message(&issues))),
    }
}

/// `toRegistryAsset(row)`: a blank precision is the owner's to publish, never a guess.
fn to_registry_asset(row: &Json) -> Result<Json, Refusal> {
    if row.get("precision").is_none_or(|p| *p == Json::Null) {
        let id = match row.get("id") {
            Some(Json::String(s)) => s.as_str(),
            _ => "",
        };
        return Err(Refusal::coded(
            PRECISION_UNSET,
            format!("The owner has not published the precision of {id}"),
        ));
    }
    registry_asset(row)
}

/// `listAssets(sql, input)`: the published rows, by id, filtered by `state` and `action`.
pub fn list(store: &Store, input: Value) -> Result<Vec<Json>, Refusal> {
    let filter = match run("assetsList", input)? {
        Parsed::Ok(v) => v,
        Parsed::Issues(issues) => return Err(Refusal::coded(LIST_FILTER_INVALID, joined(&issues))),
    };
    let (state, action) = (
        filter.get("state").as_str().map(str::to_owned),
        filter.get("action").as_str().map(str::to_owned),
    );
    let rows = with_client(store.pool_unsafe()?, |c| {
        let sql = format!(
            "SELECT {} FROM assets
              WHERE precision IS NOT NULL
                AND ($1::text IS NULL OR state = $1::text)
                AND ($2::text IS NULL OR $2::text = ANY (allowed_actions))
              ORDER BY id",
            columns()
        );
        let rows = c.query(&sql, &[&state, &action])?;
        rows.iter().map(operator_row).collect::<Result<Vec<_>, _>>()
    })?;
    rows.iter().map(to_registry_asset).collect()
}

/// `getAsset(sql, input)`: one row; an input that does not parse is `ledger.asset_not_found` with zod's message.
pub fn get(store: &Store, input: Value) -> Result<Json, Refusal> {
    let asked = match run("assetsGet", input)? {
        Parsed::Ok(v) => v,
        Parsed::Issues(issues) => return Err(Refusal::coded(NOT_FOUND, schema::message(&issues))),
    };
    let id = asked.get("assetId").as_str().unwrap_or_default().to_owned();
    let row = with_client(store.pool_unsafe()?, |c| {
        let sql = format!("SELECT {} FROM assets WHERE id = $1", columns());
        c.query_opt(&sql, &[&id])?
            .as_ref()
            .map(operator_row)
            .transpose()
    })?;
    let Some(row) = row else {
        return Err(Refusal::coded(
            NOT_FOUND,
            format!("No asset {id} is registered"),
        ));
    };
    to_registry_asset(&row)
}

/// `listOperatorAssets(sql)`: every row, published or not, by id.
pub fn operator_list(store: &Store) -> Result<Vec<Json>, StoreError> {
    with_client(store.pool_unsafe()?, |c| {
        let sql = format!("SELECT {} FROM assets ORDER BY id", columns());
        let rows = c.query(&sql, &[])?;
        rows.iter().map(operator_row).collect()
    })
}

/// JSON with object keys sorted at every depth (`canonicalJson`).
fn canonical(v: &Json) -> String {
    match v {
        Json::Array(items) => format!(
            "[{}]",
            items.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Json::Object(fields) => {
            let mut sorted: Vec<&(String, Json)> = fields.iter().collect();
            sorted.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            let parts: Vec<String> = sorted
                .iter()
                .map(|(k, v)| format!("{}:{}", Json::str(k.clone()).compact(), canonical(v)))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        other => other.compact(),
    }
}

/// UTF-16 order, as JavaScript's `<` and `sort()` compare strings.
fn js_order(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `assetEditPayloadHash(edit)`: networks (by `networkId`) and actions sorted, since both are sets; each field as its
/// text or its canonical JSON; then `customerStepUpPayloadHash('ledger.asset_edit', fields)`.
pub fn edit_hash(edit: &Json) -> String {
    let Json::Object(fields) = edit else {
        return String::new();
    };
    let text = |j: &Json| match j {
        Json::String(s) => s.clone(),
        _ => String::new(),
    };
    let mut out: Vec<(String, Json)> = fields
        .iter()
        .map(|(key, value)| {
            let value = match (key.as_str(), value) {
                ("networks", Json::Array(list)) => {
                    let mut list = list.clone();
                    list.sort_by(|a, b| {
                        js_order(
                            &a.get("networkId").map(text).unwrap_or_default(),
                            &b.get("networkId").map(text).unwrap_or_default(),
                        )
                    });
                    Json::Array(list)
                }
                ("allowedActions", Json::Array(list)) => {
                    let mut list = list.clone();
                    list.sort_by(|a, b| js_order(&text(a), &text(b)));
                    Json::Array(list)
                }
                _ => value.clone(),
            };
            let field = match value {
                Json::String(s) => s,
                other => canonical(&other),
            };
            (key.clone(), Json::String(field))
        })
        .collect();
    out.sort_by(|a, b| js_order(&a.0, &b.0));
    let payload = Json::Object(vec![
        ("actionType".to_owned(), Json::str(ACTION_TYPE)),
        ("fields".to_owned(), Json::Object(out)),
    ]);
    let digest = Sha256::digest(payload.compact().as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("sha256:{hex}")
}

/// `parseAssetEdit(input)`: a missing, null or blank precision is `ledger.asset_precision_unset` (the owner has not
/// said), a present one out of range is `ledger.asset_precision_invalid`, then the edit's own schema. The refusal's
/// code and message, or the parsed edit.
fn parse_asset_edit(input: &Value) -> Result<Value, (String, String)> {
    if matches!(input, Value::Object(_) | Value::Array(_)) {
        let precision = input.get("precision");
        let blank = match precision {
            Value::Undefined | Value::Null => true,
            Value::String(s) => js_trim(s).is_empty(),
            _ => false,
        };
        if blank {
            return Err((
                PRECISION_UNSET.to_owned(),
                "precision is unset; the owner must set it".to_owned(),
            ));
        }
        let fits = matches!(
            parse("assetPrecision", precision.clone()),
            Ok(Parsed::Ok(_))
        );
        if !fits {
            return Err((
                PRECISION_INVALID.to_owned(),
                format!("precision must be an integer from 0 to {MAX_PRECISION}"),
            ));
        }
    }
    match parse("assetEdit", input.clone()) {
        Ok(Parsed::Ok(edit)) => Ok(edit),
        Ok(Parsed::Issues(issues)) => {
            if issues
                .iter()
                .any(|i| i.message() == DEFAULT_NETWORK_NOT_LISTED)
            {
                return Err((
                    DEFAULT_NETWORK_NOT_LISTED.to_owned(),
                    "default network is not one of the networks".to_owned(),
                ));
            }
            Err((EDIT_INVALID.to_owned(), joined(&issues)))
        }
        Err(thrown) => Err((EDIT_INVALID.to_owned(), thrown)),
    }
}

/// One applied edit, as `asset_edits` holds it.
struct Applied {
    approval_id: String,
    asset_id: String,
    revision: i32,
    edit: Json,
    applied_at: String,
}

/// The call's ids and its parsed edit.
struct Asked {
    approval_id: String,
    operation_id: String,
    edit: Json,
    asset_id: String,
}

/// `asApplied(prior)`: the row exactly as one applied edit left it, whatever has landed since.
fn as_applied(prior: &Applied) -> Result<Json, Refusal> {
    let mut body: Vec<(String, Json)> = match &prior.edit {
        Json::Object(fields) => fields
            .iter()
            .filter(|(k, _)| k != "reason")
            .cloned()
            .collect(),
        _ => Vec::new(),
    };
    body.push(("revision".to_owned(), Json::int(i64::from(prior.revision))));
    body.push(("updatedAt".to_owned(), Json::str(prior.applied_at.clone())));
    registry_asset(&Json::Object(body))
}

/// `answerReplay(prior, input)`: a retry of an applied operation answers the row it produced; another edit under its id
/// refuses.
fn answer_replay(prior: Option<&Applied>, asked: &Asked) -> Result<Option<Json>, Refusal> {
    let Some(prior) = prior else {
        return Ok(None);
    };
    if prior.approval_id != asked.approval_id
        || prior.asset_id != asked.asset_id
        || edit_hash(&prior.edit) != edit_hash(&asked.edit)
    {
        return Err(Refusal::coded(
            OPERATION_CONFLICT,
            format!(
                "Operation {} was already used for another edit",
                asked.operation_id
            ),
        ));
    }
    as_applied(prior).map(Some)
}

/// A timestamp column as `toISOString()` writes the `Date` postgres.js reads it into: UTC, milliseconds.
fn iso(column: &str) -> String {
    format!("to_char({column} AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")
}

fn read_applied(row: &postgres::Row, at: usize) -> Result<Option<Applied>, StoreError> {
    let Some(approval_id) = row.try_get::<_, Option<String>>(at)? else {
        return Ok(None);
    };
    let edit: String = row.try_get(at + 3)?;
    Ok(Some(Applied {
        approval_id,
        asset_id: row.try_get(at + 1)?,
        revision: row.try_get(at + 2)?,
        edit: json::parse(&edit)
            .map_err(|e| StoreError::new(format!("asset_edits.edit: {e:?}"), None))?,
        applied_at: row.try_get(at + 4)?,
    }))
}

/// `replay(sql, input)`.
fn replay(store: &Store, asked: &Asked) -> Result<Option<Json>, Refusal> {
    let prior = with_client(store.pool()?, |c| {
        let sql = format!(
            "SELECT approval_id, asset_id, revision, edit::text, {} FROM asset_edits WHERE operation_id = $1",
            iso("applied_at")
        );
        match c.query_opt(&sql, &[&asked.operation_id])? {
            Some(row) => read_applied(&row, 0),
            None => Ok(None),
        }
    })?;
    answer_replay(prior.as_ref(), asked)
}

/// What one statement saw of the row and of the operation.
struct Seen {
    current: Option<(String, i32)>,
    prior: Option<Applied>,
}

fn stale(id: &str, what: &str) -> StoreError {
    StoreError::new(
        format!("{id} {what} after this edit was approved; approve it again"),
        Some(EDIT_STALE),
    )
}

/// The constraint a unique violation names.
fn unique_violation(e: &StoreError, constraint: &str) -> bool {
    e.code.as_deref() == Some("23505") && e.constraint.as_deref() == Some(constraint)
}

/// `applyAssetEdit(sql, approvals, operatorId, input)`: one approved founder edit, applied once. `operator_id` is the
/// signed-in operator who sends it (attribution); the two who decided are the approval's requester and approver.
pub fn apply_edit(
    store: &Store,
    approvals: &dyn Approvals,
    operator_id: &str,
    input: &Value,
) -> Result<Json, Refusal> {
    let parsed = match run("assetApplyEdit", input.clone())? {
        Parsed::Ok(v) => v,
        Parsed::Issues(issues) => {
            // The edit's own refusal when it is the edit that is wrong: a blank precision is the owner's to set.
            if matches!(input, Value::Object(_) | Value::Array(_))
                && let Err((code, message)) = parse_asset_edit(input.get("edit"))
            {
                return Err(Refusal::Coded { code, message });
            }
            return Err(Refusal::coded(EDIT_INVALID, joined(&issues)));
        }
    };
    let text = |v: &Value| v.as_str().unwrap_or_default().to_owned();
    let edit = parsed.get("edit");
    let asked = Asked {
        approval_id: text(parsed.get("approvalId")),
        operation_id: text(parsed.get("operationId")),
        edit: edit.to_json().unwrap_or(Json::Null),
        asset_id: text(edit.get("id")),
    };
    let id = asked.asset_id.as_str();
    let kind = text(edit.get("kind"));

    // The row and the operation's record in one statement, so one snapshot: they commit together, so a concurrent
    // request for the same operation is seen applied here or not at all. Read apart, this request could miss the
    // record yet see the revision that operation wrote, and ask identity to consume against the wrong one.
    let seen = with_client(store.pool()?, |c| {
        let sql = format!(
            "SELECT a.kind::text, a.revision, e.approval_id, e.asset_id, e.revision, e.edit::text, {}
               FROM (SELECT 1) AS one
               LEFT JOIN assets a ON a.id = $1
               LEFT JOIN asset_edits e ON e.operation_id = $2",
            iso("e.applied_at")
        );
        let row = c.query_one(&sql, &[&id, &asked.operation_id])?;
        let current = match (
            row.try_get::<_, Option<String>>(0)?,
            row.try_get::<_, Option<i32>>(1)?,
        ) {
            (Some(k), Some(r)) => Some((k, r)),
            _ => None,
        };
        Ok(Seen {
            current,
            prior: read_applied(&row, 2)?,
        })
    })?;
    if let Some(replayed) = answer_replay(seen.prior.as_ref(), &asked)? {
        return Ok(replayed);
    }

    // The kind is what every balance in the asset was booked as; an edit does not re-label it.
    if let Some((current_kind, _)) = &seen.current
        && *current_kind != kind
    {
        return Err(Refusal::coded(
            EDIT_INVALID,
            format!("{id} is {current_kind}; an edit cannot change an asset's kind"),
        ));
    }
    let expected = seen.current.as_ref().map_or(0, |(_, r)| *r);

    // `requestId` lets identity tell this retry from someone else's use. Identity does not repeat the founder
    // attestation on a repeated consume, so such a retry refuses here (fails closed); the founders approve again.
    let hash = edit_hash(&asked.edit);
    let version = expected.to_string();
    let consumed = approvals.consume(&ConsumeInput {
        approval_id: &asked.approval_id,
        operation_id: &asked.operation_id,
        payload_hash: &hash,
        target_service: approval::TARGET_SERVICE,
        target_id: id,
        expected_version: &version,
        request_id: Some(&asked.operation_id),
    })?;
    approval::assert_founders(&consumed, ACTION_TYPE, id)?;
    let Some(approver_id) = consumed.approver_id.clone() else {
        return Err(Refusal::coded(EDIT_INVALID, "The approval has no approver"));
    };

    let precision = edit.get("precision").as_number().map(|p| {
        #[expect(
            clippy::cast_possible_truncation,
            reason = "the schema held it to an integer from 0 to 18"
        )]
        let p = p as i32;
        p
    });
    let networks = edit
        .get("networks")
        .to_json()
        .unwrap_or(Json::Array(Vec::new()))
        .compact();
    let default = edit.get("defaultNetworkId").as_str().map(str::to_owned);
    let actions: Vec<String> = edit
        .get("allowedActions")
        .as_array()
        .unwrap_or_default()
        .iter()
        .map(text)
        .collect();
    let state = text(edit.get("state"));
    let edit_json = asked.edit.compact();
    let is_new = seen.current.is_none();

    let written = transaction(store.pool()?, IsolationLevel::ReadCommitted, |tx| {
        let op = &asked.operation_id;
        let applied = |tx: &mut postgres::Transaction<'_>| -> Result<bool, StoreError> {
            Ok(tx
                .query_opt("SELECT 1 FROM asset_edits WHERE operation_id = $1", &[op])?
                .is_some())
        };
        let locked: Option<i32> = tx
            .query_opt(
                "SELECT revision FROM assets WHERE id = $1 FOR UPDATE",
                &[&id],
            )?
            .map(|r| r.try_get(0))
            .transpose()?;
        // A concurrent request for the same operation got here first and applied it: answer as its retry.
        if applied(tx)? {
            return Ok(());
        }
        if locked.unwrap_or(0) != expected || locked.is_none() != is_new {
            return Err(stale(id, "changed"));
        }
        let row: [&(dyn ToSql + Sync); 6] =
            [&id, &precision, &networks, &default, &actions, &state];
        if locked.is_none() {
            // A new asset. The declared-but-unread scale column keeps its default: the registry's precision is the
            // one that is read.
            let inserted = tx.query_opt(
                "INSERT INTO assets (id, kind, precision, networks, default_network_id, allowed_actions, state, revision, updated_at)
                 VALUES ($1, $7::text::asset_kind, $2, $3::text::jsonb, $4, $5::text[], $6, 1, now())
                 ON CONFLICT (id) DO NOTHING
                 RETURNING id",
                &[row[0], row[1], row[2], row[3], row[4], row[5], &kind],
            )?;
            if inserted.is_none() {
                // The conflicting insert committed first. If it was this same operation, answer as its retry.
                if applied(tx)? {
                    return Ok(());
                }
                return Err(stale(id, "was added"));
            }
        } else {
            tx.execute(
                "UPDATE assets
                    SET precision = $2,
                        networks = $3::text::jsonb,
                        default_network_id = $4,
                        allowed_actions = $5::text[],
                        state = $6,
                        revision = revision + 1,
                        updated_at = now()
                  WHERE id = $1",
                &row,
            )?;
        }
        tx.execute(
            "INSERT INTO asset_edits (operation_id, approval_id, asset_id, revision, requester_id, approver_id, operator_id, edit, applied_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb, now())",
            &[
                op,
                &asked.approval_id,
                &id,
                &(expected + 1),
                &consumed.requester_id,
                &approver_id,
                &operator_id,
                &edit_json,
            ],
        )?;
        Ok(())
    });
    if let Err(e) = written {
        // Belt and braces for any other interleaving of the same operation: answer as the replay does.
        if unique_violation(&e, "asset_edits_pkey")
            && let Some(again) = replay(store, &asked)?
        {
            return Ok(again);
        }
        if unique_violation(&e, "asset_edits_asset_revision_uq") {
            return Err(Refusal::Store(stale(id, "changed")));
        }
        return Err(Refusal::Store(e));
    }
    // `applied_at` and the row's `updated_at` are the same transaction's `now()`, so this is the row as written.
    replay(store, &asked)?.ok_or_else(|| {
        Refusal::coded(
            EDIT_STALE,
            format!("{id}: the applied edit could not be read back"),
        )
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test: a failure is the point")]
    use super::*;

    fn usdt() -> Json {
        json::parse(
            r#"{"id":"USDT","kind":"crypto","precision":6,"networks":[{"networkId":"tron","label":"Tron (TRC-20)"},{"networkId":"ethereum","label":"Ethereum (ERC-20)"}],"defaultNetworkId":"ethereum","allowedActions":["deposit","withdraw","trade","transfer"],"state":"active","reason":"TEST: publish USDT"}"#,
        )
        .unwrap()
    }

    #[test]
    fn the_edit_hash_is_the_typescripts_and_ignores_set_order() {
        // `assetEditPayloadHash(...)` from node, on the edit `supported-assets.pg.test.ts` applies and on one with a
        // null default, a contract, a link and text JSON must escape.
        let got = edit_hash(&usdt());
        assert_eq!(
            got,
            "sha256:315739fdb81c2b5ebac014e9e6c99e75b69f59d3581f1572440dea8db579c932"
        );
        let reordered = json::parse(
            r#"{"reason":"TEST: publish USDT","state":"active","allowedActions":["transfer","trade","withdraw","deposit"],"defaultNetworkId":"ethereum","networks":[{"label":"Ethereum (ERC-20)","networkId":"ethereum"},{"networkId":"tron","label":"Tron (TRC-20)"}],"precision":6,"kind":"crypto","id":"USDT"}"#,
        )
        .unwrap();
        assert_eq!(edit_hash(&reordered), got);
        let coin = json::parse(
            r#"{"id":"NEWCOIN","kind":"crypto","precision":4,"networks":[{"networkId":"b","label":"B \"x\"","contract":"0xé","links":[{"url":"https://a.b","label":"E"}]}],"defaultNetworkId":null,"allowedActions":["trade"],"state":"halted","reason":"TEST ü"}"#,
        )
        .unwrap();
        assert_eq!(
            edit_hash(&coin),
            "sha256:39e69e31f5533ec9719ec1665fba0f4d04df1c6e4fe1a1c93a5fbbb6a3fc2add"
        );
    }
}
