//! The desk's per-asset pause of new borrow and new supply (`ops/asset-pause.ts`, BK-loan-07): the read and the
//! approved change. `loans.open` and `earn.deposit` read the pause before anything else happens (`earn`'s
//! `assert_supply_open`); repay, top-up, release and withdraw never read it.
//!
//! It is svc-bank's own product pause: it sets neither svc-ledger's posting freeze nor svc-identity's account freeze,
//! and the desk read names all three owners. No row means never paused. A change names the revision it was made against;
//! its history row carries the business key `ops-pause:<asset>:<revision>`, so a retry of the same change replays and a
//! different change on the same revision refuses `bank.ops_revision_conflict`. The second person's approval is consumed
//! after the checks and before the write.

use postgres::{GenericClient, Row};
use service_kit::json::Json;
use service_kit::money::js_trim;
use service_kit::time::Instant;

use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{in_tx, pg, with};

/// `AssetPauseState`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PauseState {
    pub asset_id: String,
    pub borrow_paused: bool,
    pub supply_paused: bool,
    /// 0 when the asset has never been paused.
    pub revision: i64,
    pub reason: Option<String>,
    pub approved_by: Option<String>,
    pub updated_at: Option<Instant>,
}

impl PauseState {
    fn fields(&self) -> Vec<(String, Json)> {
        let opt = |s: &Option<String>| s.clone().map_or(Json::Null, Json::str);
        vec![
            ("assetId".to_owned(), Json::str(self.asset_id.clone())),
            ("borrowPaused".to_owned(), Json::Bool(self.borrow_paused)),
            ("supplyPaused".to_owned(), Json::Bool(self.supply_paused)),
            ("revision".to_owned(), Json::int(self.revision)),
            ("reason".to_owned(), opt(&self.reason)),
            ("approvedBy".to_owned(), opt(&self.approved_by)),
            (
                "updatedAt".to_owned(),
                self.updated_at.map_or(Json::Null, |t| Json::str(t.iso())),
            ),
        ]
    }

    /// `pauseState`, in its schema's key order.
    pub fn json(&self) -> Json {
        Json::Object(self.fields())
    }

    /// `pauseState.extend({ replayed })`.
    pub fn json_replayed(&self, replayed: bool) -> Json {
        let mut f = self.fields();
        f.push(("replayed".to_owned(), Json::Bool(replayed)));
        Json::Object(f)
    }
}

/// `pauseChangeKey`.
pub fn change_key(asset_id: &str, revision: i64) -> String {
    format!("ops-pause:{asset_id}:{revision}")
}

const STATE_COLS: &str = "asset_id, borrow_paused, supply_paused, revision::int8, reason, approved_by, \
     floor(extract(epoch from updated_at) * 1000)::int8";

fn state_of(r: &Row) -> Result<PauseState, Refusal> {
    Ok(PauseState {
        asset_id: r.try_get(0).map_err(|e| pg(&e))?,
        borrow_paused: r.try_get(1).map_err(|e| pg(&e))?,
        supply_paused: r.try_get(2).map_err(|e| pg(&e))?,
        revision: r.try_get(3).map_err(|e| pg(&e))?,
        reason: Some(r.try_get(4).map_err(|e| pg(&e))?),
        approved_by: Some(r.try_get(5).map_err(|e| pg(&e))?),
        updated_at: Some(Instant(r.try_get(6).map_err(|e| pg(&e))?)),
    })
}

/// `list`: every asset ever paused, by id.
pub fn list(c: &mut impl GenericClient) -> Result<Vec<PauseState>, Refusal> {
    c.query(
        &format!("SELECT {STATE_COLS} FROM bank.asset_pauses ORDER BY asset_id"),
        &[],
    )
    .map_err(|e| pg(&e))?
    .iter()
    .map(state_of)
    .collect()
}

fn state(c: &mut impl GenericClient, asset_id: &str) -> Result<PauseState, Refusal> {
    let rows = c
        .query(
            &format!("SELECT {STATE_COLS} FROM bank.asset_pauses WHERE asset_id = $1"),
            &[&asset_id],
        )
        .map_err(|e| pg(&e))?;
    match rows.first() {
        Some(r) => state_of(r),
        None => Ok(PauseState {
            asset_id: asset_id.to_owned(),
            borrow_paused: false,
            supply_paused: false,
            revision: 0,
            reason: None,
            approved_by: None,
            updated_at: None,
        }),
    }
}

/// One history row, newest first in `history_of`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryRow {
    pub asset_id: String,
    pub revision: i64,
    pub change_key: String,
    pub borrow_paused: bool,
    pub supply_paused: bool,
    pub reason: String,
    pub approved_by: String,
    pub at: Instant,
}

impl HistoryRow {
    /// `pauseState.omit({ updatedAt }).extend({ changeKey, at })`.
    pub fn json(&self) -> Json {
        Json::Object(vec![
            ("assetId".to_owned(), Json::str(self.asset_id.clone())),
            ("borrowPaused".to_owned(), Json::Bool(self.borrow_paused)),
            ("supplyPaused".to_owned(), Json::Bool(self.supply_paused)),
            ("revision".to_owned(), Json::int(self.revision)),
            ("reason".to_owned(), Json::str(self.reason.clone())),
            ("approvedBy".to_owned(), Json::str(self.approved_by.clone())),
            ("changeKey".to_owned(), Json::str(self.change_key.clone())),
            ("at".to_owned(), Json::str(self.at.iso())),
        ])
    }
}

const HISTORY_COLS: &str = "asset_id, revision::int8, change_key, borrow_paused, supply_paused, reason, approved_by, \
     floor(extract(epoch from created_at) * 1000)::int8";

fn history_of_row(r: &Row) -> Result<HistoryRow, Refusal> {
    Ok(HistoryRow {
        asset_id: r.try_get(0).map_err(|e| pg(&e))?,
        revision: r.try_get(1).map_err(|e| pg(&e))?,
        change_key: r.try_get(2).map_err(|e| pg(&e))?,
        borrow_paused: r.try_get(3).map_err(|e| pg(&e))?,
        supply_paused: r.try_get(4).map_err(|e| pg(&e))?,
        reason: r.try_get(5).map_err(|e| pg(&e))?,
        approved_by: r.try_get(6).map_err(|e| pg(&e))?,
        at: Instant(r.try_get(7).map_err(|e| pg(&e))?),
    })
}

/// `historyOf`: an asset's changes, newest first.
pub fn history_of(
    c: &mut impl GenericClient,
    asset_id: &str,
    limit: i64,
) -> Result<Vec<HistoryRow>, Refusal> {
    c.query(
        &format!(
            "SELECT {HISTORY_COLS} FROM bank.asset_pause_history WHERE asset_id = $1 ORDER BY revision DESC LIMIT $2"
        ),
        &[&asset_id, &limit],
    )
    .map_err(|e| pg(&e))?
    .iter()
    .map(history_of_row)
    .collect()
}

fn history_at(
    c: &mut impl GenericClient,
    asset_id: &str,
    revision: i64,
) -> Result<Option<HistoryRow>, Refusal> {
    c.query(
        &format!("SELECT {HISTORY_COLS} FROM bank.asset_pause_history WHERE change_key = $1"),
        &[&change_key(asset_id, revision)],
    )
    .map_err(|e| pg(&e))?
    .first()
    .map(history_of_row)
    .transpose()
}

/// `AssetPauseChange` without its consume.
pub struct Change<'a> {
    pub asset_id: &'a str,
    pub borrow_paused: bool,
    pub supply_paused: bool,
    /// The revision the operator saw. The change becomes revision + 1.
    pub expected_revision: i64,
    pub reason: &'a str,
}

fn conflict(asset_id: &str, expected: i64, actual: i64) -> Refusal {
    refuse(
        "bank.ops_revision_conflict",
        format!(
            "Asset {asset_id} pause changed underneath this request (expected revision {expected}, found {actual}); read it again"
        ),
    )
}

/// `replay`: the same change again answers the recorded one; any other on that revision conflicts.
fn replay(prior: &HistoryRow, change: &Change<'_>, reason: &str) -> Result<PauseState, Refusal> {
    if prior.borrow_paused != change.borrow_paused
        || prior.supply_paused != change.supply_paused
        || prior.reason != reason
    {
        return Err(conflict(
            change.asset_id,
            change.expected_revision,
            prior.revision,
        ));
    }
    Ok(PauseState {
        asset_id: prior.asset_id.clone(),
        borrow_paused: prior.borrow_paused,
        supply_paused: prior.supply_paused,
        revision: prior.revision,
        reason: Some(prior.reason.clone()),
        approved_by: Some(prior.approved_by.clone()),
        updated_at: None,
    })
}

/// `set`: the change and whether it replays one already made. `consume` spends the second person's approval and names
/// the approver; it runs only after the reason, the replay and the revision are checked.
pub fn set(
    store: &crate::db::Store,
    change: &Change<'_>,
    consume: impl FnOnce() -> Result<String, Refusal>,
) -> Result<(PauseState, bool), Refusal> {
    let reason = js_trim(change.reason);
    if reason.encode_utf16().count() < 10 {
        return Err(refuse(
            "bank.ops_reason_too_short",
            "An asset pause change needs a reason of at least 10 characters (bank.ops_reason_too_short)",
        ));
    }
    if change.expected_revision < 0 || change.expected_revision > MAX_SAFE {
        return Err(refuse(
            "bank.validation_failed",
            "expectedRevision must be the revision the desk read (0 for never paused)",
        ));
    }
    let revision = change.expected_revision + 1;
    let prior = with(store, |c| history_at(c, change.asset_id, revision))?;
    if let Some(prior) = prior {
        return replay(&prior, change, reason).map(|s| (s, true));
    }
    let current = with(store, |c| state(c, change.asset_id))?;
    if current.revision != change.expected_revision {
        return Err(conflict(
            change.asset_id,
            change.expected_revision,
            current.revision,
        ));
    }
    let approved_by = consume()?;
    in_tx(store, |tx| {
        let locked = tx
            .query(
                "SELECT revision::int8 FROM bank.asset_pauses WHERE asset_id = $1 FOR UPDATE",
                &[&change.asset_id],
            )
            .map_err(|e| pg(&e))?;
        let now = match locked.first() {
            Some(r) => r.try_get::<_, i64>(0).map_err(|e| pg(&e))?,
            None => 0,
        };
        if now != change.expected_revision {
            if let Some(raced) = history_at(tx, change.asset_id, revision)? {
                return replay(&raced, change, reason).map(|s| (s, true));
            }
            return Err(conflict(change.asset_id, change.expected_revision, now));
        }
        let inserted = tx
            .query(
                "INSERT INTO bank.asset_pause_history \
                   (asset_id, revision, change_key, borrow_paused, supply_paused, reason, approved_by) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING RETURNING asset_id",
                &[
                    &change.asset_id,
                    &i32::try_from(revision).map_err(|e| Refusal::Other(e.to_string()))?,
                    &change_key(change.asset_id, revision),
                    &change.borrow_paused,
                    &change.supply_paused,
                    &reason,
                    &approved_by,
                ],
            )
            .map_err(|e| pg(&e))?;
        if inserted.is_empty() {
            // A first-revision race: no row to lock, and the other change won the key.
            if let Some(raced) = history_at(tx, change.asset_id, revision)? {
                return replay(&raced, change, reason).map(|s| (s, true));
            }
            return Err(conflict(
                change.asset_id,
                change.expected_revision,
                revision,
            ));
        }
        let rows = tx
            .query(
                &format!(
                    "INSERT INTO bank.asset_pauses \
                       (asset_id, borrow_paused, supply_paused, revision, reason, approved_by, updated_at) \
                     VALUES ($1, $2, $3, $4, $5, $6, now()) \
                     ON CONFLICT (asset_id) DO UPDATE \
                       SET borrow_paused = EXCLUDED.borrow_paused, supply_paused = EXCLUDED.supply_paused, \
                           revision = EXCLUDED.revision, reason = EXCLUDED.reason, \
                           approved_by = EXCLUDED.approved_by, updated_at = EXCLUDED.updated_at \
                     RETURNING {STATE_COLS}"
                ),
                &[
                    &change.asset_id,
                    &change.borrow_paused,
                    &change.supply_paused,
                    &i32::try_from(revision).map_err(|e| Refusal::Other(e.to_string()))?,
                    &reason,
                    &approved_by,
                ],
            )
            .map_err(|e| pg(&e))?;
        let row = rows
            .first()
            .ok_or_else(|| Refusal::Other("the asset pause upsert returned no row".to_owned()))?;
        Ok((state_of(row)?, false))
    })
}

/// `Number.MAX_SAFE_INTEGER`: a revision the TypeScript reads as a safe integer.
const MAX_SAFE: i64 = 9_007_199_254_740_991;
