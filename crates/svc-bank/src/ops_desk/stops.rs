//! The operator's partner stop as the desk reads and changes it (`partner/partner-stops.ts`: `list`, `historyOf`, `set`)
//! and what the stops refused, counted (`partner/partner-refusals.ts`: `recent`). The stop itself, asked before every
//! partner instruction, and the count it writes are slice `partner`'s (`partner::custody::assert_stop_open`).
//!
//! No row means never stopped. A change names the revision it was made against; its history row carries the business
//! key `ops-partner-stop:<partner>:<revision>`, so a retry of the same change replays and a different change on the same
//! revision refuses `bank.ops_revision_conflict`. The second person's approval is consumed after the checks and before
//! the write.

use postgres::{GenericClient, Row};
use service_kit::json::Json;
use service_kit::money::js_trim;
use service_kit::time::Instant;

use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{in_tx, pg, with};

/// `PARTNER_STOP_KINDS`, in their order.
pub const KINDS: [&str; 5] = [
    "bank_move",
    "card_hold",
    "card_capture",
    "card_release",
    "card_refund",
];

/// `normalKinds`: the known kinds among these, in `KINDS`' order, each once.
pub fn normal_kinds(kinds: &[String]) -> Vec<String> {
    KINDS
        .iter()
        .filter(|k| kinds.iter().any(|g| g == *k))
        .map(|k| (*k).to_owned())
        .collect()
}

fn kinds_json(kinds: &[String]) -> Json {
    Json::Array(kinds.iter().map(|k| Json::str(k.clone())).collect())
}

/// `PartnerStopState`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StopState {
    pub partner_id: String,
    /// Sorted; empty when nothing is stopped.
    pub stopped_kinds: Vec<String>,
    /// 0 when the partner has never been stopped.
    pub revision: i64,
    pub reason: Option<String>,
    pub approved_by: Option<String>,
    pub updated_at: Option<Instant>,
}

impl StopState {
    fn fields(&self) -> Vec<(String, Json)> {
        let opt = |s: &Option<String>| s.clone().map_or(Json::Null, Json::str);
        vec![
            ("partnerId".to_owned(), Json::str(self.partner_id.clone())),
            ("stoppedKinds".to_owned(), kinds_json(&self.stopped_kinds)),
            ("revision".to_owned(), Json::int(self.revision)),
            ("reason".to_owned(), opt(&self.reason)),
            ("approvedBy".to_owned(), opt(&self.approved_by)),
            (
                "updatedAt".to_owned(),
                self.updated_at.map_or(Json::Null, |t| Json::str(t.iso())),
            ),
        ]
    }

    /// `stopState`, in its schema's key order.
    pub fn json(&self) -> Json {
        Json::Object(self.fields())
    }

    /// `stopState.extend({ replayed })`.
    pub fn json_replayed(&self, replayed: bool) -> Json {
        let mut f = self.fields();
        f.push(("replayed".to_owned(), Json::Bool(replayed)));
        Json::Object(f)
    }
}

/// `partnerStopChangeKey`.
pub fn change_key(partner_id: &str, revision: i64) -> String {
    format!("ops-partner-stop:{partner_id}:{revision}")
}

const STATE_COLS: &str = "partner_id, stopped_kinds, revision::int8, reason, approved_by, \
     floor(extract(epoch from updated_at) * 1000)::int8";

fn state_of(r: &Row) -> Result<StopState, Refusal> {
    let kinds: Vec<String> = r.try_get(1).map_err(|e| pg(&e))?;
    Ok(StopState {
        partner_id: r.try_get(0).map_err(|e| pg(&e))?,
        stopped_kinds: normal_kinds(&kinds),
        revision: r.try_get(2).map_err(|e| pg(&e))?,
        reason: Some(r.try_get(3).map_err(|e| pg(&e))?),
        approved_by: Some(r.try_get(4).map_err(|e| pg(&e))?),
        updated_at: Some(Instant(r.try_get(5).map_err(|e| pg(&e))?)),
    })
}

/// `list`: every partner ever stopped, by id.
pub fn list(c: &mut impl GenericClient) -> Result<Vec<StopState>, Refusal> {
    c.query(
        &format!("SELECT {STATE_COLS} FROM bank.partner_stops ORDER BY partner_id"),
        &[],
    )
    .map_err(|e| pg(&e))?
    .iter()
    .map(state_of)
    .collect()
}

fn state(c: &mut impl GenericClient, partner_id: &str) -> Result<StopState, Refusal> {
    let rows = c
        .query(
            &format!("SELECT {STATE_COLS} FROM bank.partner_stops WHERE partner_id = $1"),
            &[&partner_id],
        )
        .map_err(|e| pg(&e))?;
    match rows.first() {
        Some(r) => state_of(r),
        None => Ok(StopState {
            partner_id: partner_id.to_owned(),
            stopped_kinds: Vec::new(),
            revision: 0,
            reason: None,
            approved_by: None,
            updated_at: None,
        }),
    }
}

/// One history row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryRow {
    pub partner_id: String,
    pub revision: i64,
    pub change_key: String,
    pub stopped_kinds: Vec<String>,
    pub reason: String,
    pub approved_by: String,
    pub at: Instant,
}

impl HistoryRow {
    /// `stopState.omit({ updatedAt }).extend({ changeKey, at })`.
    pub fn json(&self) -> Json {
        Json::Object(vec![
            ("partnerId".to_owned(), Json::str(self.partner_id.clone())),
            ("stoppedKinds".to_owned(), kinds_json(&self.stopped_kinds)),
            ("revision".to_owned(), Json::int(self.revision)),
            ("reason".to_owned(), Json::str(self.reason.clone())),
            ("approvedBy".to_owned(), Json::str(self.approved_by.clone())),
            ("changeKey".to_owned(), Json::str(self.change_key.clone())),
            ("at".to_owned(), Json::str(self.at.iso())),
        ])
    }
}

const HISTORY_COLS: &str = "partner_id, revision::int8, change_key, stopped_kinds, reason, approved_by, \
     floor(extract(epoch from created_at) * 1000)::int8";

fn history_of_row(r: &Row) -> Result<HistoryRow, Refusal> {
    let kinds: Vec<String> = r.try_get(3).map_err(|e| pg(&e))?;
    Ok(HistoryRow {
        partner_id: r.try_get(0).map_err(|e| pg(&e))?,
        revision: r.try_get(1).map_err(|e| pg(&e))?,
        change_key: r.try_get(2).map_err(|e| pg(&e))?,
        stopped_kinds: normal_kinds(&kinds),
        reason: r.try_get(4).map_err(|e| pg(&e))?,
        approved_by: r.try_get(5).map_err(|e| pg(&e))?,
        at: Instant(r.try_get(6).map_err(|e| pg(&e))?),
    })
}

/// `historyOf`: a partner's changes, newest first.
pub fn history_of(
    c: &mut impl GenericClient,
    partner_id: &str,
    limit: i64,
) -> Result<Vec<HistoryRow>, Refusal> {
    c.query(
        &format!(
            "SELECT {HISTORY_COLS} FROM bank.partner_stop_history WHERE partner_id = $1 ORDER BY revision DESC LIMIT $2"
        ),
        &[&partner_id, &limit],
    )
    .map_err(|e| pg(&e))?
    .iter()
    .map(history_of_row)
    .collect()
}

fn history_at(
    c: &mut impl GenericClient,
    partner_id: &str,
    revision: i64,
) -> Result<Option<HistoryRow>, Refusal> {
    c.query(
        &format!("SELECT {HISTORY_COLS} FROM bank.partner_stop_history WHERE change_key = $1"),
        &[&change_key(partner_id, revision)],
    )
    .map_err(|e| pg(&e))?
    .first()
    .map(history_of_row)
    .transpose()
}

/// `PartnerStopChange` without its consume.
pub struct Change<'a> {
    pub partner_id: &'a str,
    pub stopped_kinds: &'a [String],
    /// The revision the operator saw. The change becomes revision + 1.
    pub expected_revision: i64,
    pub reason: &'a str,
}

fn conflict(partner_id: &str, expected: i64, actual: i64) -> Refusal {
    refuse(
        "bank.ops_revision_conflict",
        format!(
            "The stop for partner {partner_id} changed underneath this request (expected revision {expected}, found {actual}); read it again"
        ),
    )
}

fn replay(
    prior: &HistoryRow,
    change: &Change<'_>,
    kinds: &[String],
    reason: &str,
) -> Result<StopState, Refusal> {
    if prior.stopped_kinds != kinds || prior.reason != reason {
        return Err(conflict(
            change.partner_id,
            change.expected_revision,
            prior.revision,
        ));
    }
    Ok(StopState {
        partner_id: prior.partner_id.clone(),
        stopped_kinds: prior.stopped_kinds.clone(),
        revision: prior.revision,
        reason: Some(prior.reason.clone()),
        approved_by: Some(prior.approved_by.clone()),
        updated_at: None,
    })
}

/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE: i64 = 9_007_199_254_740_991;

/// `set`: the change and whether it replays one already made. `consume` spends the second person's approval and names
/// the approver; it runs only after the reason, the kinds, the replay and the revision are checked.
pub fn set(
    store: &crate::db::Store,
    change: &Change<'_>,
    consume: impl FnOnce() -> Result<String, Refusal>,
) -> Result<(StopState, bool), Refusal> {
    let reason = js_trim(change.reason);
    if reason.encode_utf16().count() < 10 {
        return Err(refuse(
            "bank.ops_reason_too_short",
            "A partner stop change needs a reason of at least 10 characters (bank.ops_reason_too_short)",
        ));
    }
    if change.expected_revision < 0 || change.expected_revision > MAX_SAFE {
        return Err(refuse(
            "bank.validation_failed",
            "expectedRevision must be the revision the desk read (0 for never stopped)",
        ));
    }
    let unknown: Vec<&str> = change
        .stopped_kinds
        .iter()
        .filter(|k| !KINDS.contains(&k.as_str()))
        .map(String::as_str)
        .collect();
    if !unknown.is_empty() {
        return Err(refuse(
            "bank.validation_failed",
            format!("Unknown partner move kind: {}", unknown.join(", ")),
        ));
    }
    let kinds = normal_kinds(change.stopped_kinds);
    let revision = change.expected_revision + 1;
    if let Some(prior) = with(store, |c| history_at(c, change.partner_id, revision))? {
        return replay(&prior, change, &kinds, reason).map(|s| (s, true));
    }
    let current = with(store, |c| state(c, change.partner_id))?;
    if current.revision != change.expected_revision {
        return Err(conflict(
            change.partner_id,
            change.expected_revision,
            current.revision,
        ));
    }
    let approved_by = consume()?;
    let rev32 = i32::try_from(revision).map_err(|e| Refusal::Other(e.to_string()))?;
    in_tx(store, |tx| {
        let locked = tx
            .query(
                "SELECT revision::int8 FROM bank.partner_stops WHERE partner_id = $1 FOR UPDATE",
                &[&change.partner_id],
            )
            .map_err(|e| pg(&e))?;
        let now = match locked.first() {
            Some(r) => r.try_get::<_, i64>(0).map_err(|e| pg(&e))?,
            None => 0,
        };
        if now != change.expected_revision {
            if let Some(raced) = history_at(tx, change.partner_id, revision)? {
                return replay(&raced, change, &kinds, reason).map(|s| (s, true));
            }
            return Err(conflict(change.partner_id, change.expected_revision, now));
        }
        let inserted = tx
            .query(
                "INSERT INTO bank.partner_stop_history \
                   (partner_id, revision, change_key, stopped_kinds, reason, approved_by) \
                 VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING partner_id",
                &[
                    &change.partner_id,
                    &rev32,
                    &change_key(change.partner_id, revision),
                    &kinds,
                    &reason,
                    &approved_by,
                ],
            )
            .map_err(|e| pg(&e))?;
        if inserted.is_empty() {
            // A first-revision race: no row to lock, and the other change won the key.
            if let Some(raced) = history_at(tx, change.partner_id, revision)? {
                return replay(&raced, change, &kinds, reason).map(|s| (s, true));
            }
            return Err(conflict(
                change.partner_id,
                change.expected_revision,
                revision,
            ));
        }
        let rows = tx
            .query(
                &format!(
                    "INSERT INTO bank.partner_stops \
                       (partner_id, stopped_kinds, revision, reason, approved_by, updated_at) \
                     VALUES ($1, $2, $3, $4, $5, now()) \
                     ON CONFLICT (partner_id) DO UPDATE \
                       SET stopped_kinds = EXCLUDED.stopped_kinds, revision = EXCLUDED.revision, \
                           reason = EXCLUDED.reason, approved_by = EXCLUDED.approved_by, \
                           updated_at = EXCLUDED.updated_at \
                     RETURNING {STATE_COLS}"
                ),
                &[&change.partner_id, &kinds, &rev32, &reason, &approved_by],
            )
            .map_err(|e| pg(&e))?;
        let row = rows
            .first()
            .ok_or_else(|| Refusal::Other("the partner stop upsert returned no row".to_owned()))?;
        Ok((state_of(row)?, false))
    })
}

/// `PartnerRefusalCount`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefusalCount {
    /// UTC day, `YYYY-MM-DD`.
    pub day: String,
    pub refused_by: String,
    pub cause: String,
    pub kind: String,
    /// A count, as a decimal string.
    pub count: String,
}

/// `PartnerRefusalCounts.recent`: the last `days` UTC days, newest first, and the first day ever counted.
pub fn recent_refusals(
    c: &mut impl GenericClient,
    days: i32,
) -> Result<(Option<String>, Vec<RefusalCount>), Refusal> {
    let rows = c
        .query(
            "SELECT to_char(day, 'YYYY-MM-DD'), refused_by, cause, kind, count::text \
               FROM bank.partner_refusal_counts \
              WHERE day > (now() AT TIME ZONE 'UTC')::date - $1::int \
              ORDER BY day DESC, refused_by, cause, kind",
            &[&days],
        )
        .map_err(|e| pg(&e))?;
    let counts = rows
        .iter()
        .map(|r| {
            let s = |i: usize| r.try_get::<_, String>(i).map_err(|e| pg(&e));
            Ok(RefusalCount {
                day: s(0)?,
                refused_by: s(1)?,
                cause: s(2)?,
                kind: s(3)?,
                count: s(4)?,
            })
        })
        .collect::<Result<Vec<_>, Refusal>>()?;
    let first = c
        .query(
            "SELECT to_char(min(day), 'YYYY-MM-DD') FROM bank.partner_refusal_counts",
            &[],
        )
        .map_err(|e| pg(&e))?;
    let first_day = match first.first() {
        Some(r) => r.try_get::<_, Option<String>>(0).map_err(|e| pg(&e))?,
        None => None,
    };
    Ok((first_day, counts))
}
