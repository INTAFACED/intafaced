//! The quiz reads other slices take (`assessment/repository.ts` `publishedSlugs`, `passedSlugs`, `definition`'s pass
//! mark and `grades`): Complete's score rule, the outline, the progress page, the public course page and the
//! certificates all read them from here. The code catalogue (`ASSESSMENT_CATALOG`) is empty, so only `academy.quizzes`
//! counts.

use std::collections::BTreeSet;

use postgres::types::{FromSql, ToSql};
use postgres::{GenericClient, Row};

use crate::db;
use crate::errors::Refusal;

/// `GREATEST(a.hidden_until, q.results_hidden_until) > now`, as `HIDDEN_UNTIL` writes it (`$2` is now).
const HIDDEN_UNTIL: &str = "CASE WHEN GREATEST(a.hidden_until, q.results_hidden_until) > $2::text::timestamptz \
                            THEN GREATEST(a.hidden_until, q.results_hidden_until) END";

fn q(
    c: &mut impl GenericClient,
    sql: &str,
    params: &[&(dyn ToSql + Sync)],
) -> Result<Vec<Row>, Refusal> {
    c.query(sql, params).map_err(|e| db::refusal(&e))
}

fn cell<'a, T: FromSql<'a>>(row: &'a Row, i: usize) -> Result<T, Refusal> {
    row.try_get(i).map_err(|e| db::refusal(&e))
}

fn slugs(rows: &[Row]) -> Result<BTreeSet<String>, Refusal> {
    rows.iter().map(|r| cell(r, 0)).collect()
}

fn iso(at: i64) -> String {
    service_kit::time::Instant(at).iso()
}

/// `publishedSlugs()`.
pub fn published_slugs(c: &mut impl GenericClient) -> Result<BTreeSet<String>, Refusal> {
    slugs(&q(c, "SELECT slug FROM academy.quizzes", &[])?)
}

/// `passedSlugs(userId, now)`: the passed, unvoided assessments whose result shows by `now`.
pub fn passed_slugs(
    c: &mut impl GenericClient,
    user_id: &str,
    now: i64,
) -> Result<BTreeSet<String>, Refusal> {
    slugs(&q(
        c,
        &format!(
            "SELECT DISTINCT a.slug FROM academy.assessment_attempts a \
               LEFT JOIN academy.quizzes q ON q.slug = a.slug \
              WHERE a.user_id = $1::text::uuid AND a.passed = true AND a.voided_at IS NULL AND {HIDDEN_UNTIL} IS NULL"
        ),
        &[&user_id, &iso(now)],
    )?)
}

/// `definition(slug)`, as far as completion reads it: none when no quiz is published, else its pass mark (none unset).
pub fn pass_mark(c: &mut impl GenericClient, slug: &str) -> Result<Option<Option<i32>>, Refusal> {
    q(
        c,
        "SELECT slug, definition, pass_mark, attempt_limit, time_limit_seconds, review_mode FROM academy.quizzes WHERE slug = $1",
        &[&slug],
    )?
    .first()
    .map(|r| cell::<Option<i32>>(r, 2))
    .transpose()
}

/// One `GradeRow`.
pub enum Grade {
    Pending {
        slug: String,
        attempts: i32,
        hidden_until: i64,
    },
    Released {
        slug: String,
        attempts: i32,
        score: i32,
        possible: i32,
        passed: bool,
    },
}

impl Grade {
    pub fn slug(&self) -> &str {
        match self {
            Grade::Pending { slug, .. } | Grade::Released { slug, .. } => slug,
        }
    }
}

/// `grades(userId, now)`: the best attempt per quiz, pending as a whole while any attempt is hidden.
pub fn grades(c: &mut impl GenericClient, user_id: &str, now: i64) -> Result<Vec<Grade>, Refusal> {
    let rows = q(
        c,
        &format!(
            "WITH visible AS ( \
               SELECT a.slug, a.score, a.max_score, a.passed, a.submitted_at, {HIDDEN_UNTIL} AS hidden_until \
                 FROM academy.assessment_attempts a \
                 LEFT JOIN academy.quizzes q ON q.slug = a.slug \
                WHERE a.user_id = $1::text::uuid AND a.voided_at IS NULL \
             ) \
             SELECT slug, score, max_score, passed, attempts, floor(extract(epoch from hidden_until) * 1000)::int8 FROM ( \
               SELECT DISTINCT ON (slug) slug, score, max_score, passed, submitted_at, \
                      COUNT(*) OVER (PARTITION BY slug)::int AS attempts, \
                      MAX(hidden_until) OVER (PARTITION BY slug) AS hidden_until \
                 FROM visible \
                ORDER BY slug, passed DESC, score * 1.0 / NULLIF(max_score, 0) DESC NULLS LAST, submitted_at DESC \
             ) best ORDER BY slug"
        ),
        &[&user_id, &iso(now)],
    )?;
    rows.iter()
        .map(|r| {
            let slug: String = cell(r, 0)?;
            let attempts: i32 = cell(r, 4)?;
            Ok(match cell::<Option<i64>>(r, 5)? {
                Some(hidden_until) => Grade::Pending {
                    slug,
                    attempts,
                    hidden_until,
                },
                None => Grade::Released {
                    slug,
                    attempts,
                    score: cell(r, 1)?,
                    possible: cell(r, 2)?,
                    passed: cell(r, 3)?,
                },
            })
        })
        .collect()
}
