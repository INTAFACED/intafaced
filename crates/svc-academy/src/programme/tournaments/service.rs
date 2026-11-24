//! The tournament half of `AcademyService` (`academy-service.ts`, "Tournament ladders Stage-1"): seasons, standings
//! and the freeze snapshot, in SQL. No prize money: nothing here reaches the ledger.
//!
//! Every write that can race a freeze runs in one read-committed transaction that first locks the season row
//! (`SELECT … FOR UPDATE`) and re-checks it under the lock, as the TypeScript does; the transaction is retried on a
//! serialization failure or deadlock as `transaction()` (`packages/db/src/connection.ts`) retries it. A [`Seam`] names
//! each point inside those transactions where a crash or a pause matters, so the tests can stop a transaction there.

use std::thread;
use std::time::Duration;

use postgres::{GenericClient, IsolationLevel, Row, Transaction};
use service_kit::json::{self, Json};
use service_kit::time::Instant;

use super::bulk::{BulkInput, BulkScoreResult, ScorePatch, validate_bulk_score_write};
use super::calendar::assert_score_window_open;
use super::ladder::{
    RankedStanding, SeasonRecord, SeasonStatus, StandingRecord, TournamentError,
    assert_may_write_score, assert_score, assert_season_slug, rank_standings,
};
use super::lifecycle::{FreezeStandingsSnapshot, freeze_season_with_snapshot, transition_season};
use super::limits::{season_standings_limit, seasons_list_limit};
use super::prize::assert_no_prize_attachment;
use crate::db::{self, SERIALIZATION_FAILURE, Store};
use crate::errors::{AcademyError, Refusal};
use crate::settings::Settings;
use service_kit::s2s::js_length;
use service_kit::schema::{Value, js_trim};
use service_kit::trpc::TrpcError;

/// `deadlock_detected`.
const DEADLOCK_DETECTED: &str = "40P01";
/// `transaction()`'s `maxAttempts`.
const MAX_ATTEMPTS: u32 = 5;

/// A point inside a tournament transaction where a crash or a pause matters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Point {
    /// Freeze: the season row is locked and still live.
    FreezeLocked,
    /// Freeze: the standings are read under the lock.
    FreezeStandingsRead,
    /// Freeze: the snapshot row is written.
    FreezeSnapshotWritten,
    /// Freeze: the status is flipped to frozen; the commit is next.
    FreezeStatusFlipped,
    /// One standing: the season row is locked and re-checked.
    StandingLocked,
    /// One standing: the upsert is written; the commit is next.
    StandingWritten,
    /// Bulk: the season row is locked and the patches re-checked.
    BulkLocked,
    /// Bulk: the patch at this index is written.
    BulkPatchWritten(usize),
}

/// What runs at each [`Point`]: nothing in the service; a test pauses or fails there.
pub trait Seam: Sync {
    fn at(&self, _point: Point) -> Result<(), Refusal> {
        Ok(())
    }
}

/// The service's seam: every point passes.
pub struct NoSeam;

impl Seam for NoSeam {}

/// The tournament service over one store.
pub struct Tournaments<'a> {
    pub store: &'a Store,
    /// `options.tournamentEnabled`: only an explicit `false` disables.
    pub enabled: bool,
    pub seam: &'a dyn Seam,
    /// `new Date()`: the clock a write's calendar gate and a freeze's time read.
    pub now: Instant,
}

/// `options.tournamentEnabled`, from the settings `env.ts` parsed (`ACADEMY_TOURNAMENT_ENABLED`, default on).
pub fn tournament_enabled(settings: &Settings) -> bool {
    !matches!(
        settings.0.get("ACADEMY_TOURNAMENT_ENABLED"),
        Some(Json::Bool(false))
    )
}

/// `mapTournamentErr`: a ladder refusal as the Academy's own.
pub fn map_tournament_err(e: TournamentError) -> Refusal {
    Refusal::Academy(AcademyError::new(e.message, e.code))
}

/// A ladder refusal no `mapTournamentErr` catches: a plain failure (500) carrying its code.
pub fn unmapped(e: TournamentError) -> Refusal {
    Refusal::Internal {
        message: e.message,
        code: Some(e.code.to_owned()),
    }
}

/// The durable freeze audit: `{ seasonId, frozenAt, standings }` with each row as `freezeSnapshot`'s output reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredSnapshot {
    pub season_id: String,
    pub frozen_at: i64,
    pub standings: Vec<SnapshotRow>,
}

/// One row of a stored snapshot: `{ rank, userId, score, updatedAt }` (`updatedAt` an ISO string).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotRow {
    pub rank: i64,
    pub user_id: String,
    pub score: i64,
    pub updated_at: String,
}

/// `bulkSetStandings`' outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BulkOutcome {
    Ok {
        accepted: usize,
        standings: Vec<StandingRecord>,
    },
    Refused {
        reason: &'static str,
        message: String,
        bad_user_id: Option<String>,
    },
}

const SEASON_COLUMNS: &str = "id::text, slug, title, status::text, rules_summary, \
     floor(extract(epoch from starts_at) * 1000)::int8, floor(extract(epoch from ends_at) * 1000)::int8";
const STANDING_COLUMNS: &str =
    "season_id::text, user_id::text, score, floor(extract(epoch from updated_at) * 1000)::int8";

fn pg(e: &postgres::Error) -> Refusal {
    db::refusal(e)
}

/// A row the database returned in a shape the TypeScript's row schema would refuse.
fn bad_row(what: &str) -> Refusal {
    Refusal::Internal {
        message: format!("academy: a {what} row did not parse"),
        code: None,
    }
}

fn season_of(row: &Row) -> Result<SeasonRecord, Refusal> {
    let status: String = row.try_get(3).map_err(|e| pg(&e))?;
    Ok(SeasonRecord {
        id: row.try_get(0).map_err(|e| pg(&e))?,
        slug: row.try_get(1).map_err(|e| pg(&e))?,
        title: row.try_get(2).map_err(|e| pg(&e))?,
        status: SeasonStatus::parse(&status).ok_or_else(|| bad_row("season"))?,
        rules_summary: row.try_get(4).map_err(|e| pg(&e))?,
        starts_at: row.try_get(5).map_err(|e| pg(&e))?,
        ends_at: row.try_get(6).map_err(|e| pg(&e))?,
        extra: Vec::new(),
    })
}

fn standing_of(row: &Row) -> Result<StandingRecord, Refusal> {
    let score: i32 = row.try_get(2).map_err(|e| pg(&e))?;
    Ok(StandingRecord {
        season_id: row.try_get(0).map_err(|e| pg(&e))?,
        user_id: row.try_get(1).map_err(|e| pg(&e))?,
        score: i64::from(score),
        updated_at: row.try_get(3).map_err(|e| pg(&e))?,
    })
}

fn iso(ms: i64) -> String {
    Instant(ms).iso()
}

fn is_serialization_failure(r: &Refusal) -> bool {
    matches!(r, Refusal::Internal { code: Some(c), .. } if c == SERIALIZATION_FAILURE || c == DEADLOCK_DETECTED)
}

/// `Math.random() * 2 ** attempt * 5` ms: full jitter, from the clock's nanoseconds (the crate has no random source;
/// a jitter needs none stronger).
fn jitter(attempt: u32) -> Duration {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    let cap_ms = 5u64 << attempt.min(16);
    Duration::from_micros(u64::from(nanos) % (cap_ms * 1000))
}

/// The snapshot's `standings` jsonb, as `freezeSnapshot`'s output schema reads each row; anything else fails output
/// validation, as tRPC's does.
fn snapshot_rows(text: &str) -> Result<Vec<SnapshotRow>, Refusal> {
    let invalid = || {
        Refusal::Trpc(TrpcError::plain(
            "INTERNAL_SERVER_ERROR",
            "Output validation failed",
        ))
    };
    let Ok(Json::Array(rows)) = json::parse(text) else {
        return Err(invalid());
    };
    let int = |v: Option<&Json>| match v {
        Some(Json::Number(n)) if n.fract() == 0.0 && n.is_finite() && n.abs() < 9.0e15 =>
        {
            #[expect(
                clippy::cast_possible_truncation,
                reason = "an integer below 2^53, checked"
            )]
            Some(*n as i64)
        }
        _ => None,
    };
    let string = |v: Option<&Json>| match v {
        Some(Json::String(s)) => Some(s.clone()),
        _ => None,
    };
    rows.iter()
        .map(|r| {
            let rank = int(r.get("rank")).filter(|n| *n > 0).ok_or_else(invalid)?;
            Ok(SnapshotRow {
                rank,
                user_id: string(r.get("userId")).ok_or_else(invalid)?,
                score: int(r.get("score")).ok_or_else(invalid)?,
                updated_at: string(r.get("updatedAt")).ok_or_else(invalid)?,
            })
        })
        .collect()
}

impl Tournaments<'_> {
    /// `assertTournamentEnabled`.
    pub fn assert_enabled(&self) -> Result<(), Refusal> {
        if !self.enabled {
            return Err(AcademyError::new(
                "Tournament ladder is disabled",
                "academy.tournament_disabled",
            )
            .into());
        }
        Ok(())
    }

    fn now_ms(&self) -> i64 {
        self.now.0
    }

    /// `transaction(sql, fn, { isolation: 'read committed' })`: retried on a serialization failure or a deadlock.
    fn transaction<T>(
        &self,
        mut f: impl FnMut(&mut Transaction<'_>) -> Result<T, Refusal>,
    ) -> Result<T, Refusal> {
        let pool = self.store.pool()?;
        let mut attempt = 1;
        loop {
            match db::transaction(pool, IsolationLevel::ReadCommitted, &mut f) {
                Err(e) if is_serialization_failure(&e) && attempt < MAX_ATTEMPTS => {
                    thread::sleep(jitter(attempt));
                    attempt += 1;
                }
                out => return out,
            }
        }
    }

    fn select_season(
        c: &mut impl GenericClient,
        season_id: &str,
        lock: bool,
    ) -> Result<Option<SeasonRecord>, Refusal> {
        let q = format!(
            "SELECT {SEASON_COLUMNS} FROM academy.tournament_seasons WHERE id = $1::text::uuid{}",
            if lock { " FOR UPDATE" } else { "" }
        );
        let rows = c.query(&q, &[&season_id]).map_err(|e| pg(&e))?;
        rows.first().map(season_of).transpose()
    }

    fn not_found(season_id: &str) -> Refusal {
        AcademyError::new(
            format!("Season {season_id} not found"),
            "academy.season_not_found",
        )
        .into()
    }

    /// `createSeason`.
    pub fn create_season(
        &self,
        slug: &str,
        title: &str,
        rules_summary: &str,
        starts_at: i64,
        ends_at: Option<i64>,
    ) -> Result<SeasonRecord, Refusal> {
        self.assert_enabled()?;
        let slug = assert_season_slug(slug).map_err(map_tournament_err)?;
        let title = js_trim(title);
        let rules = js_trim(rules_summary);
        if !(3..=160).contains(&js_length(title)) {
            return Err(AcademyError::new(
                "Season title 3–160 characters",
                "academy.season_invalid",
            )
            .into());
        }
        if !(8..=4000).contains(&js_length(rules)) {
            return Err(AcademyError::new(
                "Rules summary 8–4000 characters",
                "academy.season_invalid",
            )
            .into());
        }
        let shape = Value::Object(vec![
            ("slug".to_owned(), Value::String(slug.clone())),
            ("title".to_owned(), Value::String(title.to_owned())),
            ("rulesSummary".to_owned(), Value::String(rules.to_owned())),
            ("startsAt".to_owned(), Value::Date(Some(starts_at))),
            (
                "endsAt".to_owned(),
                ends_at.map_or(Value::Null, |ms| Value::Date(Some(ms))),
            ),
            ("status".to_owned(), Value::String("scheduled".to_owned())),
        ]);
        assert_no_prize_attachment(&shape).map_err(map_tournament_err)?;
        let pool = self.store.pool()?;
        let (starts, ends) = (iso(starts_at), ends_at.map(iso));
        db::with_client(pool, |c| {
            let q = format!(
                "INSERT INTO academy.tournament_seasons (slug, title, status, rules_summary, starts_at, ends_at) \
                 VALUES ($1::text, $2::text, 'scheduled', $3::text, $4::text::timestamptz, $5::text::timestamptz) \
                 RETURNING {SEASON_COLUMNS}"
            );
            let rows = c
                .query(&q, &[&slug, &title, &rules, &starts, &ends])
                .map_err(|e| pg(&e))?;
            rows.first()
                .map(season_of)
                .transpose()?
                .ok_or_else(|| bad_row("season"))
        })
    }

    /// `season`.
    pub fn season(&self, season_id: &str) -> Result<SeasonRecord, Refusal> {
        self.assert_enabled()?;
        let pool = self.store.pool()?;
        db::with_client(pool, |c| Self::select_season(c, season_id, false))?
            .ok_or_else(|| Self::not_found(season_id))
    }

    /// `listSeasons`: newest start first, at most the published limit.
    pub fn list_seasons(
        &self,
        status: Option<SeasonStatus>,
        limit: Option<f64>,
    ) -> Result<Vec<SeasonRecord>, Refusal> {
        self.assert_enabled()?;
        let limit = seasons_list_limit(limit)?;
        let pool = self.store.pool()?;
        db::with_client(pool, |c| {
            let rows = match status {
                Some(s) => c.query(
                    &format!(
                        "SELECT {SEASON_COLUMNS} FROM academy.tournament_seasons \
                         WHERE status = $1::text::academy.season_status ORDER BY starts_at DESC LIMIT $2::int8"
                    ),
                    &[&s.as_str(), &limit],
                ),
                None => c.query(
                    &format!(
                        "SELECT {SEASON_COLUMNS} FROM academy.tournament_seasons ORDER BY starts_at DESC LIMIT $1::int8"
                    ),
                    &[&limit],
                ),
            }
            .map_err(|e| pg(&e))?;
            rows.iter().map(season_of).collect()
        })
    }

    /// `setSeasonStatus`. Live → frozen writes the snapshot and flips the status in one transaction under the season
    /// lock; every other legal edge is one guarded `UPDATE`.
    pub fn set_season_status(
        &self,
        season_id: &str,
        status: SeasonStatus,
    ) -> Result<SeasonRecord, Refusal> {
        self.assert_enabled()?;
        let current = self.season(season_id)?;
        assert_no_prize_attachment(&current.to_value()).map_err(map_tournament_err)?;
        transition_season(&current, status).map_err(map_tournament_err)?;

        if current.status == SeasonStatus::Live && status == SeasonStatus::Frozen {
            return self.transaction(|tx| self.freeze(tx, season_id));
        }

        let pool = self.store.pool()?;
        let row = db::with_client(pool, |c| {
            let q = format!(
                "UPDATE academy.tournament_seasons SET status = $1::text::academy.season_status, updated_at = now() \
                 WHERE id = $2::text::uuid AND status = $3::text::academy.season_status RETURNING {SEASON_COLUMNS}"
            );
            let rows = c
                .query(
                    &q,
                    &[&status.as_str(), &season_id, &current.status.as_str()],
                )
                .map_err(|e| pg(&e))?;
            rows.first().map(season_of).transpose()
        })?;
        row.ok_or_else(|| {
            AcademyError::new(
                format!(
                    "Season {season_id} is no longer {}",
                    current.status.as_str()
                ),
                "academy.season_invalid",
            )
            .into()
        })
    }

    /// The freeze transaction's body: lock, re-check, read the board, write the snapshot, flip the status.
    fn freeze(&self, tx: &mut Transaction<'_>, season_id: &str) -> Result<SeasonRecord, Refusal> {
        let locked =
            Self::select_season(tx, season_id, true)?.ok_or_else(|| Self::not_found(season_id))?;
        assert_no_prize_attachment(&locked.to_value()).map_err(map_tournament_err)?;
        transition_season(&locked, SeasonStatus::Frozen).map_err(map_tournament_err)?;
        if locked.status != SeasonStatus::Live {
            return Err(AcademyError::new(
                format!(
                    "Season {season_id} is {} — cannot freeze (concurrent transition)",
                    locked.status.as_str()
                ),
                "academy.season_invalid",
            )
            .into());
        }
        self.seam.at(Point::FreezeLocked)?;

        let rows = tx
            .query(
                &format!(
                    "SELECT {STANDING_COLUMNS} FROM academy.tournament_standings WHERE season_id = $1::text::uuid"
                ),
                &[&season_id],
            )
            .map_err(|e| pg(&e))?;
        let board: Vec<StandingRecord> = rows.iter().map(standing_of).collect::<Result<_, _>>()?;
        self.seam.at(Point::FreezeStandingsRead)?;

        let (_, snapshot): (SeasonRecord, FreezeStandingsSnapshot) =
            freeze_season_with_snapshot(&locked, &board, self.now_ms())
                .map_err(map_tournament_err)?;
        let standings_json = Json::Array(
            snapshot
                .standings
                .iter()
                .map(|s| {
                    Json::obj([
                        ("rank", Json::int(i64::try_from(s.rank).unwrap_or(i64::MAX))),
                        ("userId", Json::str(s.user_id.as_str())),
                        ("score", Json::int(s.score)),
                        ("updatedAt", Json::str(iso(s.updated_at))),
                    ])
                })
                .collect(),
        )
        .compact();
        tx.execute(
            "INSERT INTO academy.tournament_freeze_snapshots (season_id, frozen_at, standings) \
             VALUES ($1::text::uuid, $2::text::timestamptz, $3::text::jsonb) \
             ON CONFLICT (season_id) DO UPDATE SET frozen_at = EXCLUDED.frozen_at, standings = EXCLUDED.standings",
            &[&season_id, &iso(snapshot.frozen_at), &standings_json],
        )
        .map_err(|e| pg(&e))?;
        self.seam.at(Point::FreezeSnapshotWritten)?;

        let rows = tx
            .query(
                &format!(
                    "UPDATE academy.tournament_seasons SET status = 'frozen', updated_at = now() \
                     WHERE id = $1::text::uuid AND status = 'live' RETURNING {SEASON_COLUMNS}"
                ),
                &[&season_id],
            )
            .map_err(|e| pg(&e))?;
        let frozen = rows.first().map(season_of).transpose()?.ok_or_else(|| {
            Refusal::from(AcademyError::new(
                format!("Season {season_id} left live during freeze (concurrent transition)"),
                "academy.season_invalid",
            ))
        })?;
        self.seam.at(Point::FreezeStatusFlipped)?;
        Ok(frozen)
    }

    /// `freezeSnapshot`: none when the season was never frozen on this path.
    pub fn freeze_snapshot(&self, season_id: &str) -> Result<Option<StoredSnapshot>, Refusal> {
        self.assert_enabled()?;
        self.season(season_id)?;
        let pool = self.store.pool()?;
        let row = db::with_client(pool, |c| {
            let rows = c
                .query(
                    "SELECT season_id::text, floor(extract(epoch from frozen_at) * 1000)::int8, standings::text \
                     FROM academy.tournament_freeze_snapshots WHERE season_id = $1::text::uuid",
                    &[&season_id],
                )
                .map_err(|e| pg(&e))?;
            rows.first()
                .map(|r| -> Result<(String, i64, String), Refusal> {
                    Ok((
                        r.try_get(0).map_err(|e| pg(&e))?,
                        r.try_get(1).map_err(|e| pg(&e))?,
                        r.try_get(2).map_err(|e| pg(&e))?,
                    ))
                })
                .transpose()
        })?;
        let Some((id, frozen_at, standings)) = row else {
            return Ok(None);
        };
        Ok(Some(StoredSnapshot {
            season_id: id,
            frozen_at,
            standings: snapshot_rows(&standings)?,
        }))
    }

    fn upsert_standing(
        tx: &mut Transaction<'_>,
        season_id: &str,
        user_id: &str,
        score: i64,
    ) -> Result<StandingRecord, Refusal> {
        let score = i32::try_from(score).map_err(|_| bad_row("standing"))?;
        let rows = tx
            .query(
                &format!(
                    "INSERT INTO academy.tournament_standings (season_id, user_id, score, updated_at) \
                     VALUES ($1::text::uuid, $2::text::uuid, $3::int4, now()) \
                     ON CONFLICT (season_id, user_id) DO UPDATE SET score = EXCLUDED.score, updated_at = now() \
                     RETURNING {STANDING_COLUMNS}"
                ),
                &[&season_id, &user_id, &score],
            )
            .map_err(|e| pg(&e))?;
        rows.first()
            .map(standing_of)
            .transpose()?
            .ok_or_else(|| bad_row("standing"))
    }

    /// `setStanding`. The read is not the gate: under the season lock the window and status are checked again, so a
    /// freeze that holds the lock makes this wait, then refuse.
    pub fn set_standing(
        &self,
        season_id: &str,
        user_id: &str,
        score: f64,
    ) -> Result<StandingRecord, Refusal> {
        self.assert_enabled()?;
        let season = self.season(season_id)?;
        let now = self.now_ms();
        assert_score_window_open(&season, now).map_err(map_tournament_err)?;
        assert_may_write_score(season.status).map_err(map_tournament_err)?;
        let score = assert_score(score).map_err(map_tournament_err)?;
        self.transaction(|tx| {
            let locked = Self::select_season(tx, season_id, true)?
                .ok_or_else(|| Self::not_found(season_id))?;
            assert_score_window_open(&locked, now).map_err(map_tournament_err)?;
            assert_may_write_score(locked.status).map_err(map_tournament_err)?;
            self.seam.at(Point::StandingLocked)?;
            let row = Self::upsert_standing(tx, season_id, user_id, score)?;
            self.seam.at(Point::StandingWritten)?;
            Ok(row)
        })
    }

    /// `bulkSetStandings`: the pure gate first (with the calendar), then every accepted patch in one transaction under
    /// the season lock, re-gated there, so a freeze cannot interleave a partial board and a crash leaves none.
    pub fn bulk_set_standings(
        &self,
        season_id: &str,
        patches: &[ScorePatch],
    ) -> Result<BulkOutcome, Refusal> {
        self.assert_enabled()?;
        let season = self.season(season_id)?;
        let refused = |r: BulkScoreResult| match r {
            BulkScoreResult::Refuse {
                reason,
                message,
                bad_user_id,
            } => Some(BulkOutcome::Refused {
                reason: reason.as_str(),
                message,
                bad_user_id,
            }),
            BulkScoreResult::Ok { .. } => None,
        };
        let gate = validate_bulk_score_write(&BulkInput {
            season_status: season.status,
            season_id,
            patches,
            starts_at: Some(season.starts_at),
            ends_at: season.ends_at,
            now: self.now_ms(),
        });
        if let Some(out) = refused(gate) {
            return Ok(out);
        }
        let now = self.now_ms();
        self.transaction(|tx| {
            let locked = Self::select_season(tx, season_id, true)?
                .ok_or_else(|| Self::not_found(season_id))?;
            let re_gate = validate_bulk_score_write(&BulkInput {
                season_status: locked.status,
                season_id,
                patches,
                starts_at: Some(locked.starts_at),
                ends_at: locked.ends_at,
                now,
            });
            let accepted = match re_gate {
                BulkScoreResult::Ok { patches } => patches,
                BulkScoreResult::Refuse {
                    reason,
                    message,
                    bad_user_id,
                } => {
                    return Ok(BulkOutcome::Refused {
                        reason: reason.as_str(),
                        message,
                        bad_user_id,
                    });
                }
            };
            self.seam.at(Point::BulkLocked)?;
            let mut standings = Vec::new();
            for (i, p) in accepted.iter().enumerate() {
                let score = assert_score(p.score).map_err(map_tournament_err)?;
                standings.push(Self::upsert_standing(tx, season_id, &p.user_id, score)?);
                self.seam.at(Point::BulkPatchWritten(i))?;
            }
            Ok(BulkOutcome::Ok {
                accepted: standings.len(),
                standings,
            })
        })
    }

    /// `standings`: score DESC, earlier update first, at most the published limit, ranked.
    pub fn standings(
        &self,
        season_id: &str,
        limit: Option<f64>,
    ) -> Result<Vec<RankedStanding>, Refusal> {
        self.assert_enabled()?;
        let limit = season_standings_limit(limit)?;
        self.season(season_id)?;
        let pool = self.store.pool()?;
        let rows = db::with_client(pool, |c| {
            let rows = c
                .query(
                    &format!(
                        "SELECT {STANDING_COLUMNS} FROM academy.tournament_standings WHERE season_id = $1::text::uuid \
                         ORDER BY score DESC, updated_at ASC LIMIT $2::int8"
                    ),
                    &[&season_id, &limit],
                )
                .map_err(|e| pg(&e))?;
            rows.iter().map(standing_of).collect::<Result<Vec<_>, _>>()
        })?;
        Ok(rank_standings(&rows))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "tests")]
mod tests {
    use super::*;

    #[test]
    fn only_an_explicit_false_disables_the_ladder() {
        assert!(tournament_enabled(&Settings::empty()));
        let off = Settings(Json::Object(vec![(
            "ACADEMY_TOURNAMENT_ENABLED".to_owned(),
            Json::Bool(false),
        )]));
        assert!(!tournament_enabled(&off));
        let on = Settings(Json::Object(vec![(
            "ACADEMY_TOURNAMENT_ENABLED".to_owned(),
            Json::Bool(true),
        )]));
        assert!(tournament_enabled(&on));
    }

    #[test]
    fn a_serialization_failure_or_deadlock_is_retried_and_nothing_else() {
        for code in [SERIALIZATION_FAILURE, DEADLOCK_DETECTED] {
            assert!(is_serialization_failure(&Refusal::Internal {
                message: String::new(),
                code: Some(code.to_owned())
            }));
        }
        assert!(!is_serialization_failure(&Refusal::Internal {
            message: String::new(),
            code: Some("23505".to_owned())
        }));
        assert!(!is_serialization_failure(&Refusal::Academy(
            AcademyError::new("x", "academy.season_invalid")
        )));
        for attempt in 1..MAX_ATTEMPTS {
            assert!(jitter(attempt) < Duration::from_millis(5 << attempt));
        }
    }

    #[test]
    fn a_snapshot_row_outside_the_output_schema_fails_output_validation() {
        let ok = snapshot_rows(
            r#"[{"rank":1,"score":7,"userId":"u","updatedAt":"2026-01-01T00:00:00.000Z"}]"#,
        )
        .unwrap();
        assert_eq!(
            ok,
            vec![SnapshotRow {
                rank: 1,
                user_id: "u".to_owned(),
                score: 7,
                updated_at: "2026-01-01T00:00:00.000Z".to_owned()
            }]
        );
        for bad in [
            r#"[{"rank":0,"score":7,"userId":"u","updatedAt":"x"}]"#,
            r#"[{"rank":1,"score":7.5,"userId":"u","updatedAt":"x"}]"#,
            r#"[{"rank":1,"score":7,"userId":1,"updatedAt":"x"}]"#,
            r#"{"rank":1}"#,
        ] {
            assert!(matches!(snapshot_rows(bad), Err(Refusal::Trpc(_))), "{bad}");
        }
    }
}
