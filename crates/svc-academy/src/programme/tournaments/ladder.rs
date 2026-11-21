//! Tournament ladders, Stage-1 without money (`tournaments/ladder.ts`): seasons and standings only, no prize pools, no
//! ledger, no IFC payouts. A score is an integer an operator sets; a rank is derived from (score DESC, updated_at ASC);
//! a frozen season refuses score writes.
//!
//! Numbers keep JavaScript's meaning: a score is an integer, a count or threshold passed in is a JS number (`f64`, so a
//! NaN or an infinity refuses where the TypeScript refuses it), and an average is the float JavaScript computes.

use std::cmp::Ordering;

use service_kit::env::js_number;
use service_kit::json::js_number_string;
use service_kit::schema::{Value, js_trim};

/// `SeasonStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SeasonStatus {
    Scheduled,
    Live,
    Frozen,
    Ended,
}

impl SeasonStatus {
    pub const ALL: [SeasonStatus; 4] = [
        SeasonStatus::Scheduled,
        SeasonStatus::Live,
        SeasonStatus::Frozen,
        SeasonStatus::Ended,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            SeasonStatus::Scheduled => "scheduled",
            SeasonStatus::Live => "live",
            SeasonStatus::Frozen => "frozen",
            SeasonStatus::Ended => "ended",
        }
    }

    pub fn parse(s: &str) -> Option<SeasonStatus> {
        SeasonStatus::ALL.into_iter().find(|v| v.as_str() == s)
    }
}

/// `SeasonRecord`. `extra` holds any field a caller spread into the season shape (always empty from the database): the
/// prize-attachment gate sees it as the TypeScript sees an extra key on the object.
#[derive(Debug, Clone, PartialEq)]
pub struct SeasonRecord {
    pub id: String,
    pub slug: String,
    pub title: String,
    pub status: SeasonStatus,
    pub rules_summary: String,
    /// Milliseconds since the epoch (a JS `Date`).
    pub starts_at: i64,
    pub ends_at: Option<i64>,
    pub extra: Vec<(String, Value)>,
}

impl SeasonRecord {
    /// The record as the object the TypeScript passes around (for the prize-attachment gate).
    pub fn to_value(&self) -> Value {
        let mut fields = vec![
            ("id".to_owned(), Value::String(self.id.clone())),
            ("slug".to_owned(), Value::String(self.slug.clone())),
            ("title".to_owned(), Value::String(self.title.clone())),
            (
                "status".to_owned(),
                Value::String(self.status.as_str().to_owned()),
            ),
            (
                "rulesSummary".to_owned(),
                Value::String(self.rules_summary.clone()),
            ),
            ("startsAt".to_owned(), Value::Date(Some(self.starts_at))),
            (
                "endsAt".to_owned(),
                self.ends_at.map_or(Value::Null, |ms| Value::Date(Some(ms))),
            ),
        ];
        fields.extend(self.extra.iter().cloned());
        Value::Object(fields)
    }
}

/// `StandingRecord`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StandingRecord {
    pub season_id: String,
    pub user_id: String,
    pub score: i64,
    /// Milliseconds since the epoch.
    pub updated_at: i64,
}

/// `RankedStanding`: a standing and its 1-based rank.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RankedStanding {
    pub season_id: String,
    pub user_id: String,
    pub score: i64,
    pub updated_at: i64,
    pub rank: usize,
}

/// `TournamentError`: one of the ladder's codes. The service maps it into an `AcademyError` where the TypeScript does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TournamentError {
    pub message: String,
    pub code: &'static str,
}

impl TournamentError {
    pub fn new(message: impl Into<String>, code: &'static str) -> TournamentError {
        TournamentError {
            message: message.into(),
            code,
        }
    }
}

/// JavaScript's default `sort()` on strings: by UTF-16 code units.
pub fn js_sort(ids: &mut [String]) {
    ids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

/// `new Set(ids)` keeping first appearance, then the default sort.
fn distinct_sorted(ids: impl Iterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if !out.contains(&id) {
            out.push(id);
        }
    }
    js_sort(&mut out);
    out
}

/// `Math.floor(n)` as an index or count: a non-finite or negative number clamps as the callers' guards already did.
fn floor_usize(n: f64) -> usize {
    let f = n.floor();
    if f.is_nan() || f <= 0.0 {
        0
    } else if f >= 9.0e15 {
        usize::MAX
    } else {
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a finite non-negative floor below 2^53"
        )]
        let u = f as u64;
        usize::try_from(u).unwrap_or(usize::MAX)
    }
}

#[expect(
    clippy::cast_precision_loss,
    reason = "scores and counts are below 2^53, as JavaScript numbers"
)]
fn num(n: i64) -> f64 {
    n as f64
}

#[expect(
    clippy::cast_precision_loss,
    reason = "a count is below 2^53, as a JavaScript number"
)]
fn count_f(n: usize) -> f64 {
    n as f64
}

/// `rankStandings`: score DESC, then the earlier update first; 1-based ranks. The sort is stable, as V8's.
pub fn rank_standings(rows: &[StandingRecord]) -> Vec<RankedStanding> {
    let mut sorted = rows.to_vec();
    sorted.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.updated_at.cmp(&b.updated_at))
    });
    sorted
        .into_iter()
        .enumerate()
        .map(|(i, r)| RankedStanding {
            season_id: r.season_id,
            user_id: r.user_id,
            score: r.score,
            updated_at: r.updated_at,
            rank: i + 1,
        })
        .collect()
}

/// `assertSeasonSlug`: trimmed, lower-cased, `^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$`.
pub fn assert_season_slug(slug: &str) -> Result<String, TournamentError> {
    let s = js_trim(slug).to_lowercase();
    let b = s.as_bytes();
    let edge = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    let ok = (3..=64).contains(&b.len())
        && b.first().is_some_and(edge)
        && b.last().is_some_and(edge)
        && b.iter().all(|c| edge(c) || *c == b'-');
    if !ok {
        return Err(TournamentError::new(
            "Season slug must be 3–64 chars, lowercase alphanumeric + hyphen",
            "academy.season_invalid",
        ));
    }
    Ok(s)
}

/// `assertScore`: an integer 0…1e9.
pub fn assert_score(score: f64) -> Result<i64, TournamentError> {
    if score.fract() != 0.0 || !score.is_finite() || !(0.0..=1_000_000_000.0).contains(&score) {
        return Err(TournamentError::new(
            "Score must be an integer 0…1e9",
            "academy.standing_invalid",
        ));
    }
    #[expect(
        clippy::cast_possible_truncation,
        reason = "an integer in 0..=1e9, checked above"
    )]
    Ok(score as i64)
}

/// `assertMayWriteScore`: scores write only while live.
pub fn assert_may_write_score(status: SeasonStatus) -> Result<(), TournamentError> {
    if status != SeasonStatus::Live {
        return Err(TournamentError::new(
            format!(
                "Season is {} — scores only write while live",
                status.as_str()
            ),
            "academy.season_not_live",
        ));
    }
    Ok(())
}

/// `{ offset?, limit? }`: a limit that is absent, null or not a number is `None`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct PageOptions {
    pub offset: Option<f64>,
    pub limit: Option<f64>,
}

impl PageOptions {
    pub fn limit(limit: f64) -> PageOptions {
        PageOptions {
            offset: None,
            limit: Some(limit),
        }
    }

    pub fn at(offset: f64, limit: f64) -> PageOptions {
        PageOptions {
            offset: Some(offset),
            limit: Some(limit),
        }
    }
}

/// A JS `limit` value as the asserts read it: only a number is a number.
pub fn number_of(v: &Value) -> Option<f64> {
    v.as_number()
}

/// `StandingsPage`.
#[derive(Debug, Clone, PartialEq)]
pub struct StandingsPage {
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
    pub standings: Vec<RankedStanding>,
}

/// `Math.min(200, Math.floor(limit))` after a published-limit check, or the refusal.
pub fn published_limit(
    limit: Option<f64>,
    refuse: impl Fn() -> TournamentError,
) -> Result<usize, TournamentError> {
    let Some(l) = limit.filter(|l| l.is_finite()) else {
        return Err(refuse());
    };
    let n = l.floor();
    if n < 1.0 {
        return Err(refuse());
    }
    Ok(floor_usize(n).min(200))
}

/// `assertStandingsPageLimit`.
pub fn assert_standings_page_limit(limit: Option<f64>) -> Result<usize, TournamentError> {
    published_limit(limit, || {
        TournamentError::new(
            "Standings page limit is unset — pass limit (never invent 50)",
            "academy.standings_limit_unset",
        )
    })
}

/// `Math.max(0, Math.floor(options.offset ?? 0))`.
pub fn offset_of(options: PageOptions) -> usize {
    floor_usize(options.offset.unwrap_or(0.0).floor().max(0.0))
}

fn slice_from<T: Clone>(all: &[T], offset: usize, limit: usize) -> Vec<T> {
    all.iter().skip(offset).take(limit).cloned().collect()
}

/// `pageStandings`.
pub fn page_standings(
    rows: &[StandingRecord],
    options: PageOptions,
) -> Result<StandingsPage, TournamentError> {
    let ranked = rank_standings(rows);
    let total = ranked.len();
    let offset = offset_of(options);
    let limit = assert_standings_page_limit(options.limit)?;
    Ok(StandingsPage {
        total,
        offset,
        limit,
        standings: slice_from(&ranked, offset, limit),
    })
}

/// `standingOfUser`.
pub fn standing_of_user(rows: &[StandingRecord], user_id: &str) -> Option<RankedStanding> {
    let id = js_trim(user_id);
    if id.is_empty() {
        return None;
    }
    rank_standings(rows).into_iter().find(|r| r.user_id == id)
}

/// `topNStandings`.
pub fn top_n_standings(rows: &[StandingRecord], n: f64) -> Vec<RankedStanding> {
    let limit = n.floor();
    if limit.is_nan() || limit <= 0.0 {
        return Vec::new();
    }
    rank_standings(rows)
        .into_iter()
        .take(floor_usize(limit))
        .collect()
}

/// `StandingNeighbors`.
#[derive(Debug, Clone, PartialEq)]
pub struct StandingNeighbors {
    pub self_: RankedStanding,
    pub above: Option<RankedStanding>,
    pub below: Option<RankedStanding>,
}

/// `standingNeighbors`.
pub fn standing_neighbors(rows: &[StandingRecord], user_id: &str) -> Option<StandingNeighbors> {
    let ranked = rank_standings(rows);
    let id = js_trim(user_id);
    let idx = ranked.iter().position(|r| r.user_id == id)?;
    Some(StandingNeighbors {
        self_: ranked.get(idx)?.clone(),
        above: idx.checked_sub(1).and_then(|i| ranked.get(i)).cloned(),
        below: ranked.get(idx + 1).cloned(),
    })
}

/// `scoreOfUser`.
pub fn score_of_user(rows: &[StandingRecord], user_id: &str) -> Option<i64> {
    let id = js_trim(user_id);
    if id.is_empty() {
        return None;
    }
    rows.iter().find(|r| r.user_id == id).map(|r| r.score)
}

/// `countStandingsAboveScore`.
pub fn count_standings_above_score(rows: &[StandingRecord], score: f64) -> usize {
    if !score.is_finite() {
        return 0;
    }
    rows.iter().filter(|r| num(r.score) > score).count()
}

/// `standingCount`.
pub fn standing_count(rows: &[StandingRecord]) -> usize {
    rows.len()
}

/// `bottomNStandings`.
pub fn bottom_n_standings(rows: &[StandingRecord], n: f64) -> Vec<RankedStanding> {
    let limit = n.floor();
    if limit.is_nan() || limit <= 0.0 {
        return Vec::new();
    }
    let ranked = rank_standings(rows);
    let skip = ranked.len().saturating_sub(floor_usize(limit));
    ranked.into_iter().skip(skip).collect()
}

/// `medianScore`.
pub fn median_score(rows: &[StandingRecord]) -> Option<f64> {
    if rows.is_empty() {
        return None;
    }
    let mut scores: Vec<i64> = rows.iter().map(|r| r.score).collect();
    scores.sort_unstable();
    let mid = scores.len() / 2;
    if scores.len() % 2 == 1 {
        return scores.get(mid).map(|s| num(*s));
    }
    let (a, b) = (*scores.get(mid - 1)?, *scores.get(mid)?);
    #[expect(
        clippy::float_arithmetic,
        reason = "a median score as JavaScript computes it; scores are not money"
    )]
    Some((num(a) + num(b)) / 2.0)
}

/// `isInTopN`.
pub fn is_in_top_n(rows: &[StandingRecord], user_id: &str, n: f64) -> bool {
    let limit = n.floor();
    if limit.is_nan() || limit <= 0.0 {
        return false;
    }
    standing_of_user(rows, user_id).is_some_and(|s| count_f(s.rank) <= limit)
}

/// `maxScore`.
pub fn max_score(rows: &[StandingRecord]) -> Option<i64> {
    rows.iter().map(|r| r.score).max()
}

/// `minScore`.
pub fn min_score(rows: &[StandingRecord]) -> Option<i64> {
    rows.iter().map(|r| r.score).min()
}

/// `listStandingUserIds`: distinct, sorted.
pub fn list_standing_user_ids(rows: &[StandingRecord]) -> Vec<String> {
    distinct_sorted(rows.iter().map(|r| r.user_id.clone()))
}

/// `averageScore`.
pub fn average_score(rows: &[StandingRecord]) -> Option<f64> {
    if rows.is_empty() {
        return None;
    }
    let sum: i64 = rows.iter().map(|r| r.score).sum();
    #[expect(
        clippy::float_arithmetic,
        reason = "a mean score as JavaScript computes it; scores are not money"
    )]
    Some(num(sum) / count_f(rows.len()))
}

/// `scoreSpread`: max − min, or none for fewer than two rows.
pub fn score_spread(rows: &[StandingRecord]) -> Option<i64> {
    if rows.len() < 2 {
        return None;
    }
    Some(max_score(rows)? - min_score(rows)?)
}

/// `scoreRange`.
pub fn score_range(rows: &[StandingRecord]) -> Option<i64> {
    score_spread(rows)
}

/// `hasStanding`.
pub fn has_standing(rows: &[StandingRecord], user_id: &str) -> bool {
    let id = js_trim(user_id);
    !id.is_empty() && rows.iter().any(|r| r.user_id == id)
}

/// `rankOfUser`.
pub fn rank_of_user(rows: &[StandingRecord], user_id: &str) -> Option<usize> {
    standing_of_user(rows, user_id).map(|s| s.rank)
}

/// `isTopScorer`.
pub fn is_top_scorer(rows: &[StandingRecord], user_id: &str) -> bool {
    rank_of_user(rows, user_id) == Some(1)
}

fn user_at_index(rows: &[StandingRecord], i: usize) -> Option<String> {
    rank_standings(rows).get(i).map(|r| r.user_id.clone())
}

/// `secondPlaceUser`.
pub fn second_place_user(rows: &[StandingRecord]) -> Option<String> {
    user_at_index(rows, 1)
}

/// `thirdPlaceUser`.
pub fn third_place_user(rows: &[StandingRecord]) -> Option<String> {
    user_at_index(rows, 2)
}

/// `lastPlaceUser`.
pub fn last_place_user(rows: &[StandingRecord]) -> Option<String> {
    rank_standings(rows).last().map(|r| r.user_id.clone())
}

/// `firstPlaceUser`.
pub fn first_place_user(rows: &[StandingRecord]) -> Option<String> {
    user_at_index(rows, 0)
}

fn rank_index(rank: f64) -> Option<usize> {
    if !rank.is_finite() || rank < 1.0 {
        return None;
    }
    floor_usize(rank).checked_sub(1)
}

/// `scoreAtRank`.
pub fn score_at_rank(rows: &[StandingRecord], rank: f64) -> Option<i64> {
    let i = rank_index(rank)?;
    rank_standings(rows).get(i).map(|r| r.score)
}

/// `userAtRank`.
pub fn user_at_rank(rows: &[StandingRecord], rank: f64) -> Option<String> {
    let i = rank_index(rank)?;
    user_at_index(rows, i)
}

/// `podiumUserIds`.
pub fn podium_user_ids(rows: &[StandingRecord]) -> Vec<String> {
    top_n_standings(rows, 3.0)
        .into_iter()
        .map(|r| r.user_id)
        .collect()
}

/// `isEmptyStandings`.
pub fn is_empty_standings(rows: &[StandingRecord]) -> bool {
    rows.is_empty()
}

/// `hasAnyStanding`.
pub fn has_any_standing(rows: &[StandingRecord]) -> bool {
    !rows.is_empty()
}

/// `bottomUser`.
pub fn bottom_user(rows: &[StandingRecord]) -> Option<String> {
    last_place_user(rows)
}

/// `scoresInRankOrder`.
pub fn scores_in_rank_order(rows: &[StandingRecord]) -> Vec<i64> {
    rank_standings(rows).into_iter().map(|r| r.score).collect()
}

/// `hasPodiumDepth`.
pub fn has_podium_depth(rows: &[StandingRecord], n: f64) -> bool {
    if !n.is_finite() || n < 1.0 {
        return false;
    }
    rank_standings(rows).len() >= floor_usize(n)
}

/// `rankedCount`.
pub fn ranked_count(rows: &[StandingRecord]) -> usize {
    rank_standings(rows).len()
}

/// `averageTopNScore`.
pub fn average_top_n_score(rows: &[StandingRecord], n: f64) -> Option<f64> {
    if !n.is_finite() || n < 1.0 {
        return None;
    }
    let top = top_n_standings(rows, n.floor());
    if top.is_empty() {
        return None;
    }
    let sum: i64 = top.iter().map(|r| r.score).sum();
    #[expect(
        clippy::float_arithmetic,
        reason = "a mean score as JavaScript computes it; scores are not money"
    )]
    Some(num(sum) / count_f(top.len()))
}

/// `isTiedForFirst`.
pub fn is_tied_for_first(rows: &[StandingRecord], user_id: &str) -> bool {
    let Some(max) = max_score(rows) else {
        return false;
    };
    score_of_user(rows, user_id) == Some(max)
}

/// `countAboveScore`.
pub fn count_above_score(rows: &[StandingRecord], score: f64) -> usize {
    count_standings_above_score(rows, score)
}

/// `hasUniqueLeader`.
pub fn has_unique_leader(rows: &[StandingRecord]) -> bool {
    let Some(max) = max_score(rows) else {
        return false;
    };
    rows.iter().filter(|r| r.score == max).count() == 1
}

/// `firstSecondScoreGap`.
pub fn first_second_score_gap(rows: &[StandingRecord]) -> Option<i64> {
    let ranked = rank_standings(rows);
    Some(ranked.first()?.score - ranked.get(1)?.score)
}

/// `tiedForLeadUserIds`.
pub fn tied_for_lead_user_ids(rows: &[StandingRecord]) -> Vec<String> {
    let Some(max) = max_score(rows) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = rows
        .iter()
        .filter(|r| r.score == max)
        .map(|r| r.user_id.clone())
        .collect();
    js_sort(&mut ids);
    ids
}

/// `allScoresEqual`.
pub fn all_scores_equal(rows: &[StandingRecord]) -> bool {
    score_spread(rows) == Some(0)
}

/// `minRankForTopK`.
pub fn min_rank_for_top_k(rows: &[StandingRecord], k: f64) -> Option<usize> {
    if !k.is_finite() || k < 1.0 {
        return None;
    }
    let ranked = rank_standings(rows);
    let k = floor_usize(k);
    if ranked.len() < k {
        return None;
    }
    ranked.get(k - 1).map(|r| r.rank)
}

/// `secondThirdScoreGap`.
pub fn second_third_score_gap(rows: &[StandingRecord]) -> Option<i64> {
    let ranked = rank_standings(rows);
    Some(ranked.get(1)?.score - ranked.get(2)?.score)
}

fn sorted_ids_where(
    rows: &[StandingRecord],
    keep: impl Fn(&StandingRecord) -> bool,
) -> Vec<String> {
    let mut ids: Vec<String> = rows
        .iter()
        .filter(|r| keep(r))
        .map(|r| r.user_id.clone())
        .collect();
    js_sort(&mut ids);
    ids
}

/// `userIdsBelowScore`.
pub fn user_ids_below_score(rows: &[StandingRecord], score: f64) -> Vec<String> {
    sorted_ids_where(rows, |r| num(r.score) < score)
}

/// `userIdsAtOrAboveScore`.
pub fn user_ids_at_or_above_score(rows: &[StandingRecord], score: f64) -> Vec<String> {
    sorted_ids_where(rows, |r| num(r.score) >= score)
}

/// `hasClearLeader`.
pub fn has_clear_leader(rows: &[StandingRecord]) -> bool {
    first_second_score_gap(rows).is_some_and(|g| g > 0)
}

/// `lastTwoScoreGap`.
pub fn last_two_score_gap(rows: &[StandingRecord]) -> Option<i64> {
    let ranked = rank_standings(rows);
    let n = ranked.len();
    if n < 2 {
        return None;
    }
    Some(ranked.get(n - 2)?.score - ranked.get(n - 1)?.score)
}

/// `hasAtLeastStandings`.
pub fn has_at_least_standings(rows: &[StandingRecord], n: f64) -> bool {
    if !n.is_finite() || n < 0.0 {
        return false;
    }
    rows.len() >= floor_usize(n)
}

/// `midRankUser`: rank `ceil(n/2)`.
pub fn mid_rank_user(rows: &[StandingRecord]) -> Option<String> {
    let ranked = rank_standings(rows);
    if ranked.is_empty() {
        return None;
    }
    let i = ranked.len().div_ceil(2) - 1;
    ranked.get(i).map(|r| r.user_id.clone())
}

/// `totalScoreSum`.
pub fn total_score_sum(rows: &[StandingRecord]) -> i64 {
    rows.iter().map(|r| r.score).sum()
}

fn label_i(n: Option<i64>) -> String {
    n.map(|v| v.to_string()).unwrap_or_default()
}

/// `standingCountLabel`.
pub fn standing_count_label(rows: &[StandingRecord]) -> String {
    standing_count(rows).to_string()
}

/// `maxScoreLabel`.
pub fn max_score_label(rows: &[StandingRecord]) -> String {
    label_i(max_score(rows))
}

/// `minScoreLabel`.
pub fn min_score_label(rows: &[StandingRecord]) -> String {
    label_i(min_score(rows))
}

/// `rankedUserIdsJoined`.
pub fn ranked_user_ids_joined(rows: &[StandingRecord]) -> String {
    rank_standings(rows)
        .into_iter()
        .map(|r| r.user_id)
        .collect::<Vec<_>>()
        .join(",")
}

/// `scoresInRankOrderJoined`.
pub fn scores_in_rank_order_joined(rows: &[StandingRecord]) -> String {
    scores_in_rank_order(rows)
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

/// `podiumUserIdsJoined`.
pub fn podium_user_ids_joined(rows: &[StandingRecord]) -> String {
    podium_user_ids(rows).join(",")
}

/// `standingUserIdsJoined`.
pub fn standing_user_ids_joined(rows: &[StandingRecord]) -> String {
    list_standing_user_ids(rows).join(",")
}

/// `averageScoreLabel`: `String(average)`.
pub fn average_score_label(rows: &[StandingRecord]) -> String {
    average_score(rows)
        .map(js_number_string)
        .unwrap_or_default()
}

/// `firstPlaceUserLabel`.
pub fn first_place_user_label(rows: &[StandingRecord]) -> String {
    first_place_user(rows).unwrap_or_default()
}

/// `lastPlaceUserLabel`.
pub fn last_place_user_label(rows: &[StandingRecord]) -> String {
    last_place_user(rows).unwrap_or_default()
}

/// `midRankUserLabel`.
pub fn mid_rank_user_label(rows: &[StandingRecord]) -> String {
    mid_rank_user(rows).unwrap_or_default()
}

/// `scoreSpreadLabel`.
pub fn score_spread_label(rows: &[StandingRecord]) -> String {
    label_i(score_spread(rows))
}

/// `scoreExtremumSnapshot`.
#[derive(Debug, Clone, PartialEq)]
pub struct ScoreExtremum {
    pub min: Option<i64>,
    pub max: Option<i64>,
    pub spread: Option<i64>,
    pub average: Option<f64>,
}

pub fn score_extremum_snapshot(rows: &[StandingRecord]) -> ScoreExtremum {
    ScoreExtremum {
        min: min_score(rows),
        max: max_score(rows),
        spread: score_spread(rows),
        average: average_score(rows),
    }
}

/// `podiumSnapshot`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Podium {
    pub first: Option<String>,
    pub second: Option<String>,
    pub third: Option<String>,
}

pub fn podium_snapshot(rows: &[StandingRecord]) -> Podium {
    Podium {
        first: first_place_user(rows),
        second: second_place_user(rows),
        third: third_place_user(rows),
    }
}

/// `scoreExtremumConsistent`.
pub fn score_extremum_consistent(rows: &[StandingRecord]) -> bool {
    let s = score_extremum_snapshot(rows);
    match (s.min, s.max, s.spread) {
        (Some(min), Some(max), Some(spread)) => spread == max - min,
        _ => rows.is_empty(),
    }
}

/// `standingDepthSnapshot`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StandingDepth {
    pub count: usize,
    pub empty: bool,
    pub has_podium3: bool,
}

pub fn standing_depth_snapshot(rows: &[StandingRecord]) -> StandingDepth {
    StandingDepth {
        count: standing_count(rows),
        empty: is_empty_standings(rows),
        has_podium3: has_podium_depth(rows, 3.0),
    }
}

/// `leaderboardHeadline`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaderboardHeadline {
    pub count: usize,
    pub empty: bool,
    pub first: Option<String>,
    pub last: Option<String>,
    pub max: Option<i64>,
    pub min: Option<i64>,
    pub unique_leader: bool,
}

pub fn leaderboard_headline(rows: &[StandingRecord]) -> LeaderboardHeadline {
    LeaderboardHeadline {
        count: standing_count(rows),
        empty: is_empty_standings(rows),
        first: first_place_user(rows),
        last: last_place_user(rows),
        max: max_score(rows),
        min: min_score(rows),
        unique_leader: has_unique_leader(rows),
    }
}

/// `userStandingCard`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserStandingCard {
    pub user_id: String,
    pub present: bool,
    pub rank: Option<usize>,
    pub score: Option<i64>,
    pub is_top: bool,
}

pub fn user_standing_card(rows: &[StandingRecord], user_id: &str) -> UserStandingCard {
    let id = js_trim(user_id);
    UserStandingCard {
        user_id: id.to_owned(),
        present: has_standing(rows, id),
        rank: rank_of_user(rows, id),
        score: score_of_user(rows, id),
        is_top: is_top_scorer(rows, id),
    }
}

/// `topNStandingCards`: user, rank, score.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StandingCard {
    pub user_id: String,
    pub rank: usize,
    pub score: i64,
}

pub fn top_n_standing_cards(rows: &[StandingRecord], n: f64) -> Vec<StandingCard> {
    top_n_standings(rows, n)
        .into_iter()
        .map(|r| StandingCard {
            user_id: r.user_id,
            rank: r.rank,
            score: r.score,
        })
        .collect()
}

/// `userStandingPresent`.
pub fn user_standing_present(rows: &[StandingRecord], user_id: &str) -> bool {
    user_standing_card(rows, user_id).present
}

/// `filterStandingsMinScore`.
pub fn filter_standings_min_score(rows: &[StandingRecord], min: f64) -> Vec<StandingRecord> {
    if !min.is_finite() {
        return Vec::new();
    }
    rows.iter()
        .filter(|r| num(r.score) >= min)
        .cloned()
        .collect()
}

/// `filterStandingsMaxScore`.
pub fn filter_standings_max_score(rows: &[StandingRecord], max: f64) -> Vec<StandingRecord> {
    if !max.is_finite() {
        return Vec::new();
    }
    rows.iter()
        .filter(|r| num(r.score) <= max)
        .cloned()
        .collect()
}

/// `searchStandingUserIds`.
pub fn search_standing_user_ids(rows: &[StandingRecord], needle: &str) -> Vec<String> {
    let n = js_trim(needle);
    if n.is_empty() {
        return Vec::new();
    }
    list_standing_user_ids(rows)
        .into_iter()
        .filter(|id| id.contains(n))
        .collect()
}

/// `countStandingsInScoreRange`.
pub fn count_standings_in_score_range(rows: &[StandingRecord], min: f64, max: f64) -> usize {
    if !min.is_finite() || !max.is_finite() || min > max {
        return 0;
    }
    rows.iter()
        .filter(|r| num(r.score) >= min && num(r.score) <= max)
        .count()
}

/// `pageRankedStandings`.
pub fn page_ranked_standings(
    rows: &[StandingRecord],
    options: PageOptions,
) -> Result<Vec<RankedStanding>, TournamentError> {
    let ranked = rank_standings(rows);
    let offset = offset_of(options);
    let limit = assert_standings_page_limit(options.limit)?;
    Ok(slice_from(&ranked, offset, limit))
}

/// `pageRankedUserIds`.
pub fn page_ranked_user_ids(
    rows: &[StandingRecord],
    options: PageOptions,
) -> Result<Vec<String>, TournamentError> {
    Ok(page_ranked_standings(rows, options)?
        .into_iter()
        .map(|r| r.user_id)
        .collect())
}

/// `Math.ceil(n / Math.floor(pageSize))` for a published page size.
pub fn page_count(n: usize, page_size: f64) -> usize {
    if !page_size.is_finite() || page_size < 1.0 || n == 0 {
        return 0;
    }
    n.div_ceil(floor_usize(page_size).max(1))
}

/// `standingsPageCount`.
pub fn standings_page_count(rows: &[StandingRecord], page_size: f64) -> usize {
    page_count(standing_count(rows), page_size)
}

/// `reverseRankedStandings`.
pub fn reverse_ranked_standings(rows: &[StandingRecord]) -> Vec<RankedStanding> {
    let mut r = rank_standings(rows);
    r.reverse();
    r
}

/// `standingUserIdsOnlyLeft`.
pub fn standing_user_ids_only_left(
    left: &[StandingRecord],
    right: &[StandingRecord],
) -> Vec<String> {
    let r = list_standing_user_ids(right);
    list_standing_user_ids(left)
        .into_iter()
        .filter(|id| !r.contains(id))
        .collect()
}

/// `standingUserIdsInBoth`.
pub fn standing_user_ids_in_both(left: &[StandingRecord], right: &[StandingRecord]) -> Vec<String> {
    let r = list_standing_user_ids(right);
    list_standing_user_ids(left)
        .into_iter()
        .filter(|id| r.contains(id))
        .collect()
}

/// `scoreDeltaForUser`.
pub fn score_delta_for_user(
    left: &[StandingRecord],
    right: &[StandingRecord],
    user_id: &str,
) -> Option<i64> {
    Some(score_of_user(left, user_id)? - score_of_user(right, user_id)?)
}

/// `standingsSameSize`.
pub fn standings_same_size(left: &[StandingRecord], right: &[StandingRecord]) -> bool {
    standing_count(left) == standing_count(right)
}

/// `Math.max(0, Math.min(len, floor(offset)))` and the same for the limit: a clamped page.
pub fn safe_window(len: usize, offset: f64, limit: f64) -> Option<(usize, usize)> {
    if !offset.is_finite() || !limit.is_finite() {
        return None;
    }
    let o = floor_usize(offset).min(len);
    let l = floor_usize(limit).min(len - o);
    Some((o, l))
}

/// `safePageRankedStandings`.
pub fn safe_page_ranked_standings(
    rows: &[StandingRecord],
    offset: f64,
    limit: f64,
) -> Vec<RankedStanding> {
    let ranked = rank_standings(rows);
    let Some((o, l)) = safe_window(ranked.len(), offset, limit) else {
        return Vec::new();
    };
    slice_from(&ranked, o, l)
}

/// The clamped page index for `pages` pages.
pub fn clamp_page_index(pages: usize, page_index: f64) -> usize {
    if pages == 0 || !page_index.is_finite() {
        return 0;
    }
    floor_usize(page_index).min(pages - 1)
}

/// `clampStandingsPageIndex`.
pub fn clamp_standings_page_index(
    rows: &[StandingRecord],
    page_index: f64,
    page_size: f64,
) -> usize {
    clamp_page_index(standings_page_count(rows, page_size), page_index)
}

/// `rankedStandingsAtPage`.
pub fn ranked_standings_at_page(
    rows: &[StandingRecord],
    page_index: f64,
    page_size: f64,
) -> Vec<RankedStanding> {
    if !page_size.is_finite() || page_size < 1.0 {
        return Vec::new();
    }
    let idx = clamp_standings_page_index(rows, page_index, page_size);
    let size = floor_usize(page_size);
    let ranked = rank_standings(rows);
    let o = idx.saturating_mul(size).min(ranked.len());
    let l = size.min(ranked.len() - o);
    slice_from(&ranked, o, l)
}

/// Whether `page_index` names one of `pages` pages.
pub fn valid_page(pages: usize, page_index: f64) -> bool {
    if pages == 0 || !page_index.is_finite() {
        return false;
    }
    let i = page_index.floor();
    i >= 0.0 && i < count_f(pages)
}

/// `isValidStandingsPage`.
pub fn is_valid_standings_page(rows: &[StandingRecord], page_index: f64, page_size: f64) -> bool {
    valid_page(standings_page_count(rows, page_size), page_index)
}

/// `standingsExportLines`: `rank,userId,score`.
pub fn standings_export_lines(rows: &[StandingRecord]) -> Vec<String> {
    rank_standings(rows)
        .into_iter()
        .map(|r| format!("{},{},{}", r.rank, r.user_id, r.score))
        .collect()
}

/// `standingsExportHeader`.
pub fn standings_export_header() -> &'static str {
    "rank,userId,score"
}

/// `standingsExportText`.
pub fn standings_export_text(rows: &[StandingRecord]) -> String {
    let mut lines = vec![standings_export_header().to_owned()];
    lines.extend(standings_export_lines(rows));
    lines.join("\n")
}

/// `standingsExportLineCount`.
pub fn standings_export_line_count(rows: &[StandingRecord]) -> usize {
    1 + standing_count(rows)
}

/// A parsed `rank,userId,score` line.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportedStanding {
    pub rank: f64,
    pub user_id: String,
    pub score: f64,
}

/// `parseStandingsExportLine`.
pub fn parse_standings_export_line(line: &str) -> Option<ExportedStanding> {
    let t = js_trim(line);
    if t.is_empty() || t == standings_export_header() {
        return None;
    }
    let parts: Vec<&str> = t.split(',').collect();
    let [rank, user, score] = parts.as_slice() else {
        return None;
    };
    let rank = js_number(rank).unwrap_or(f64::NAN);
    let user_id = js_trim(user);
    let score = js_number(score).unwrap_or(f64::NAN);
    if user_id.is_empty() || !rank.is_finite() || !score.is_finite() || rank < 1.0 {
        return None;
    }
    Some(ExportedStanding {
        rank: rank.floor(),
        user_id: user_id.to_owned(),
        score,
    })
}

/// `countStandingsExportDataLines`.
pub fn count_standings_export_data_lines(text: &str) -> usize {
    text.split('\n')
        .filter(|l| parse_standings_export_line(l).is_some())
        .count()
}

/// `standingsExportHasHeader`.
pub fn standings_export_has_header(text: &str) -> bool {
    js_trim(text.split('\n').next().unwrap_or("")) == standings_export_header()
}

/// `standingsExportRoundTripOk`.
pub fn standings_export_round_trip_ok(rows: &[StandingRecord]) -> bool {
    standings_export_line_count(rows)
        == 1 + count_standings_export_data_lines(&standings_export_text(rows))
}

fn or_dash<T: ToString>(v: Option<T>) -> String {
    v.map_or_else(|| "-".to_owned(), |x| x.to_string())
}

/// `leaderboardStatusLine`.
pub fn leaderboard_status_line(rows: &[StandingRecord]) -> String {
    let h = leaderboard_headline(rows);
    format!(
        "count={} first={} max={}",
        h.count,
        or_dash(h.first),
        or_dash(h.max)
    )
}

/// `leaderboardStatusLineIsEmpty`.
pub fn leaderboard_status_line_is_empty(rows: &[StandingRecord]) -> bool {
    leaderboard_status_line(rows).starts_with("count=0")
}

/// `leaderboardStatusLineDetailed`.
pub fn leaderboard_status_line_detailed(rows: &[StandingRecord]) -> String {
    let h = leaderboard_headline(rows);
    format!(
        "count={} first={} last={} min={} max={} unique={}",
        h.count,
        or_dash(h.first),
        or_dash(h.last),
        or_dash(h.min),
        or_dash(h.max),
        if h.unique_leader { "1" } else { "0" }
    )
}

/// `.split(/\s+/).filter(Boolean).length`.
pub fn token_count(line: &str) -> usize {
    line.split(char::is_whitespace)
        .filter(|t| !t.is_empty())
        .count()
}

/// `leaderboardStatusLineTokenCount`.
pub fn leaderboard_status_line_token_count(rows: &[StandingRecord]) -> usize {
    token_count(&leaderboard_status_line_detailed(rows))
}

/// `key=value` fields separated by single spaces, matched in order: each value is `\S+` (or what `value_ok` allows).
pub fn match_fields<'a>(line: &'a str, keys: &[&str]) -> Option<Vec<&'a str>> {
    let t = js_trim(line);
    let parts: Vec<&str> = t.split(' ').collect();
    if parts.len() != keys.len() {
        return None;
    }
    let mut out = Vec::new();
    for (part, key) in parts.iter().zip(keys) {
        let v = part.strip_prefix(key)?.strip_prefix('=')?;
        if v.is_empty() || v.chars().any(char::is_whitespace) {
            return None;
        }
        out.push(v);
    }
    Some(out)
}

/// `\d+`.
pub fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `Number(s)`, NaN as `f64::NAN`.
pub fn js_num(s: &str) -> f64 {
    js_number(s).unwrap_or(f64::NAN)
}

/// A parsed `count=N first=X max=Y`.
#[derive(Debug, Clone, PartialEq)]
pub struct LeaderboardLine {
    pub count: f64,
    pub first: Option<String>,
    pub max: Option<f64>,
}

/// `parseLeaderboardStatusLine`.
pub fn parse_leaderboard_status_line(line: &str) -> Option<LeaderboardLine> {
    let v = match_fields(line, &["count", "first", "max"])?;
    let [count, first, max] = v.as_slice() else {
        return None;
    };
    if !is_digits(count) {
        return None;
    }
    let count = js_num(count);
    let first = (*first != "-").then(|| (*first).to_owned());
    let max = (*max != "-").then(|| js_num(max));
    if !count.is_finite() || max.is_some_and(|m| !m.is_finite()) {
        return None;
    }
    Some(LeaderboardLine { count, first, max })
}

/// `leaderboardStatusLineMatches`.
pub fn leaderboard_status_line_matches(rows: &[StandingRecord]) -> bool {
    let Some(p) = parse_leaderboard_status_line(&leaderboard_status_line(rows)) else {
        return false;
    };
    let h = leaderboard_headline(rows);
    p.count == count_f(h.count) && p.first == h.first && p.max == h.max.map(num)
}

/// A parsed detailed leaderboard line.
#[derive(Debug, Clone, PartialEq)]
pub struct LeaderboardDetail {
    pub count: f64,
    pub first: Option<String>,
    pub last: Option<String>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub unique: bool,
}

/// `parseLeaderboardStatusLineDetailed`.
pub fn parse_leaderboard_status_line_detailed(line: &str) -> Option<LeaderboardDetail> {
    let v = match_fields(line, &["count", "first", "last", "min", "max", "unique"])?;
    let [count, first, last, min, max, unique] = v.as_slice() else {
        return None;
    };
    if !is_digits(count) || !(*unique == "0" || *unique == "1") {
        return None;
    }
    let num_or_none = |s: &str| (s != "-").then(|| js_num(s));
    let (min, max) = (num_or_none(min), num_or_none(max));
    if min.is_some_and(|m| !m.is_finite()) || max.is_some_and(|m| !m.is_finite()) {
        return None;
    }
    Some(LeaderboardDetail {
        count: js_num(count),
        first: (*first != "-").then(|| (*first).to_owned()),
        last: (*last != "-").then(|| (*last).to_owned()),
        min,
        max,
        unique: *unique == "1",
    })
}

/// `leaderboardStatusLineDetailedConsistent`.
pub fn leaderboard_status_line_detailed_consistent(line: &str) -> bool {
    let Some(p) = parse_leaderboard_status_line_detailed(line) else {
        return false;
    };
    if p.count == 0.0 {
        return p.min.is_none() && p.max.is_none() && p.first.is_none();
    }
    match (p.min, p.max) {
        (Some(min), Some(max)) => min <= max,
        _ => false,
    }
}

/// `standingCountInRange`.
pub fn standing_count_in_range(rows: &[StandingRecord], min: f64, max: f64) -> bool {
    if !min.is_finite() || !max.is_finite() || min > max {
        return false;
    }
    let n = count_f(standing_count(rows));
    n >= min && n <= max
}

/// `maxScoreAtLeast`.
pub fn max_score_at_least(rows: &[StandingRecord], threshold: f64) -> bool {
    threshold.is_finite() && max_score(rows).is_some_and(|m| num(m) >= threshold)
}

/// `Math.max(1, Math.min(max(1, total), floor(pageSize)))`.
pub fn clamp_page_size(total: usize, page_size: f64) -> usize {
    if !page_size.is_finite() {
        return 1;
    }
    let total = total.max(1);
    if page_size.floor() < 1.0 {
        return 1;
    }
    floor_usize(page_size).min(total).max(1)
}

/// `clampStandingsPageSize`.
pub fn clamp_standings_page_size(rows: &[StandingRecord], page_size: f64) -> usize {
    clamp_page_size(standing_count(rows), page_size)
}

/// `scoreSpreadAtMost`.
pub fn score_spread_at_most(rows: &[StandingRecord], threshold: f64) -> bool {
    threshold.is_finite() && score_spread(rows).is_some_and(|s| num(s) <= threshold)
}

/// Orders two JS numbers the way a comparator returning `a - b` would.
pub fn cmp_f64(a: f64, b: f64) -> Ordering {
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "tests")]
mod tests {
    //! `tournaments/ladder.test.ts`, assertion for assertion.
    use super::*;
    use service_kit::time::js_date;

    fn row(user: &str, score: i64, t: &str) -> StandingRecord {
        StandingRecord {
            season_id: "s".to_owned(),
            user_id: user.to_owned(),
            score,
            updated_at: js_date(t).unwrap().0,
        }
    }

    fn abc() -> Vec<StandingRecord> {
        vec![
            row("a", 10, "2026-08-01T12:00:00Z"),
            row("b", 20, "2026-08-01T13:00:00Z"),
            row("c", 15, "2026-08-01T11:00:00Z"),
        ]
    }

    fn ab(a: i64, b: i64) -> Vec<StandingRecord> {
        vec![
            row("a", a, "2026-08-01T12:00:00Z"),
            row("b", b, "2026-08-01T13:00:00Z"),
        ]
    }

    fn abc3(a: i64, b: i64, c: i64) -> Vec<StandingRecord> {
        vec![
            row("a", a, "2026-08-01T12:00:00Z"),
            row("b", b, "2026-08-01T13:00:00Z"),
            row("c", c, "2026-08-01T11:00:00Z"),
        ]
    }

    fn ids(r: &[RankedStanding]) -> Vec<&str> {
        r.iter().map(|x| x.user_id.as_str()).collect()
    }

    #[test]
    fn rank_standings_orders_by_score_desc_then_earlier_update_first() {
        let ranked = rank_standings(&abc3(10, 20, 20));
        assert_eq!(ids(&ranked), ["c", "b", "a"]);
        assert_eq!(ranked.iter().map(|r| r.rank).collect::<Vec<_>>(), [1, 2, 3]);
    }

    #[test]
    fn validators() {
        assert_eq!(assert_season_slug("Summer-2026").unwrap(), "summer-2026");
        assert!(assert_season_slug("x").is_err());
        assert!(assert_score(-1.0).is_err());
        assert!(assert_may_write_score(SeasonStatus::Frozen).is_err());
        assert!(assert_may_write_score(SeasonStatus::Live).is_ok());
    }

    #[test]
    fn page_standings_does_not_invent_rows_past_total() {
        let rows = abc();
        let page = page_standings(&rows, PageOptions::at(1.0, 1.0)).unwrap();
        assert_eq!(page.total, 3);
        assert_eq!(page.standings.len(), 1);
        assert_eq!(page.standings[0].user_id, "c");
        assert!(
            page_standings(&rows, PageOptions::at(50.0, 10.0))
                .unwrap()
                .standings
                .is_empty()
        );
    }

    #[test]
    fn page_standings_refuses_blank_limit() {
        let rows = ab(10, 20);
        for o in [
            PageOptions::default(),
            PageOptions {
                offset: Some(0.0),
                limit: None,
            },
            PageOptions::limit(f64::NAN),
            PageOptions::limit(0.0),
        ] {
            assert!(page_standings(&rows, o).is_err());
        }
        let e = page_standings(&rows, PageOptions::default()).unwrap_err();
        assert_eq!(e.code, "academy.standings_limit_unset");
        assert!(!e.message.contains("50-row") && !e.message.to_lowercase().contains("default 50"));
    }

    #[test]
    fn page_standings_accepts_owner_published_50() {
        let rows: Vec<_> = (0..60)
            .map(|i| row(&format!("u{i}"), 60 - i, "2026-08-01T12:00:00Z"))
            .collect();
        let page = page_standings(&rows, PageOptions::limit(50.0)).unwrap();
        assert_eq!(page.limit, 50);
        assert_eq!(page.standings.len(), 50);
    }

    #[test]
    fn standing_of_user_and_top_n() {
        let rows = ab(10, 20);
        assert_eq!(standing_of_user(&rows, "b").unwrap().rank, 1);
        assert!(standing_of_user(&rows, "missing").is_none());
        assert!(standing_of_user(&rows, "  ").is_none());
        assert_eq!(ids(&top_n_standings(&rows, 1.0)), ["b"]);
        assert!(top_n_standings(&rows, 0.0).is_empty());
    }

    #[test]
    fn board_helpers() {
        let rows = abc();
        assert!(standing_neighbors(&rows, "missing").is_none());
        let n = standing_neighbors(&rows, "c").unwrap();
        assert_eq!(n.self_.user_id, "c");
        assert_eq!(n.above.unwrap().user_id, "b");
        assert_eq!(n.below.unwrap().user_id, "a");

        assert_eq!(score_of_user(&rows, "b"), Some(20));
        assert_eq!(score_of_user(&rows, "missing"), None);
        assert_eq!(score_of_user(&rows, "  "), None);
        assert_eq!(count_standings_above_score(&rows, 15.0), 1);
        assert_eq!(count_standings_above_score(&[], 0.0), 0);

        assert_eq!(standing_count(&[]), 0);
        assert_eq!(standing_count(&[row("a", 1, "2026-08-01T12:00:00Z")]), 1);

        assert!(bottom_n_standings(&rows, 0.0).is_empty());
        let bot = bottom_n_standings(&rows, 1.0);
        assert_eq!(bot.len(), 1);
        assert_eq!(bot[0].user_id, "a");

        assert!(is_in_top_n(&rows, "b", 1.0));
        assert!(!is_in_top_n(&rows, "a", 1.0));
        assert!(!is_in_top_n(&rows, "missing", 3.0));
        assert!(!is_in_top_n(&rows, "b", 0.0));
        assert_eq!(list_standing_user_ids(&rows), ["a", "b", "c"]);
        assert!(list_standing_user_ids(&[]).is_empty());
    }

    #[test]
    fn stats_without_invent() {
        assert_eq!(median_score(&[]), None);
        assert_eq!(median_score(&abc3(10, 20, 30)), Some(20.0));
        assert_eq!(max_score(&[]), None);
        assert_eq!(min_score(&[]), None);
        let r = abc3(10, 30, 20);
        assert_eq!(max_score(&r), Some(30));
        assert_eq!(min_score(&r), Some(10));
        assert_eq!(average_score(&[]), None);
        assert_eq!(average_score(&ab(10, 20)), Some(15.0));

        assert_eq!(score_spread(&[]), None);
        assert_eq!(score_spread(&[row("a", 10, "2026-08-01T12:00:00Z")]), None);
        let rows = abc();
        assert_eq!(score_spread(&rows), Some(10));
        assert!(has_standing(&rows, "a"));
        assert!(!has_standing(&rows, "missing"));
        assert!(!has_standing(&rows, "  "));
        assert_eq!(score_range(&[]), None);
        assert_eq!(score_range(&ab(10, 30)), Some(20));
    }

    #[test]
    fn places() {
        let rows = ab(10, 20);
        assert_eq!(rank_of_user(&rows, "missing"), None);
        assert_eq!(rank_of_user(&rows, "b"), Some(1));
        assert!(!is_top_scorer(&rows, "missing"));
        assert!(is_top_scorer(&rows, "b"));
        assert!(!is_top_scorer(&rows, "a"));
        assert_eq!(second_place_user(&[]), None);
        assert_eq!(
            second_place_user(&[row("a", 10, "2026-08-01T12:00:00Z")]),
            None
        );
        assert_eq!(second_place_user(&rows).as_deref(), Some("a"));

        assert_eq!(third_place_user(&[]), None);
        assert_eq!(last_place_user(&[]), None);
        let r3 = abc();
        assert_eq!(third_place_user(&r3).as_deref(), Some("a"));
        assert_eq!(last_place_user(&r3).as_deref(), Some("a"));
        assert_eq!(
            third_place_user(&[row("b", 20, "2026-08-01T13:00:00Z")]),
            None
        );

        assert_eq!(first_place_user(&[]), None);
        assert_eq!(first_place_user(&rows).as_deref(), Some("b"));

        assert_eq!(score_at_rank(&[], 1.0), None);
        assert_eq!(score_at_rank(&rows, 1.0), Some(20));
        assert_eq!(score_at_rank(&rows, 2.0), Some(10));
        assert_eq!(score_at_rank(&rows, 3.0), None);
    }

    #[test]
    fn wave25_and_26() {
        assert_eq!(user_at_rank(&[], 1.0), None);
        assert!(podium_user_ids(&[]).is_empty());
        assert!(is_empty_standings(&[]));
        assert!(!has_any_standing(&[]));
        let rows = abc();
        assert_eq!(user_at_rank(&rows, 1.0).as_deref(), Some("b"));
        assert_eq!(user_at_rank(&rows, 2.0).as_deref(), Some("c"));
        assert_eq!(user_at_rank(&rows, 0.0), None);
        assert_eq!(podium_user_ids(&rows), ["b", "c", "a"]);
        assert!(!is_empty_standings(&rows));
        assert!(has_any_standing(&rows));

        assert_eq!(bottom_user(&[]), None);
        assert!(scores_in_rank_order(&[]).is_empty());
        assert!(!has_podium_depth(&[], 1.0));
        assert_eq!(ranked_count(&[]), 0);
        assert_eq!(bottom_user(&rows).as_deref(), Some("a"));
        assert_eq!(scores_in_rank_order(&rows), [20, 15, 10]);
        assert!(has_podium_depth(&rows, 3.0));
        assert!(!has_podium_depth(&rows, 4.0));
        assert_eq!(ranked_count(&rows), 3);
    }

    #[test]
    fn wave27_and_28() {
        assert_eq!(average_top_n_score(&[], 3.0), None);
        assert!(!is_tied_for_first(&[], "a"));
        assert!(!has_unique_leader(&[]));
        let rows = abc3(20, 20, 10);
        assert_eq!(average_top_n_score(&rows, 2.0), Some(20.0));
        assert!(is_tied_for_first(&rows, "a"));
        assert!(!has_unique_leader(&rows));
        assert_eq!(count_above_score(&rows, 10.0), 2);
        assert!(has_unique_leader(&ab(30, 10)));

        assert_eq!(first_second_score_gap(&[]), None);
        assert!(tied_for_lead_user_ids(&[]).is_empty());
        assert!(!all_scores_equal(&[]));
        assert_eq!(min_rank_for_top_k(&[], 1.0), None);
        let rows = abc3(20, 20, 5);
        assert_eq!(first_second_score_gap(&rows), Some(0));
        assert_eq!(tied_for_lead_user_ids(&rows), ["a", "b"]);
        assert!(!all_scores_equal(&rows));
        assert_eq!(min_rank_for_top_k(&rows, 2.0), Some(2));
        assert!(all_scores_equal(&ab(10, 10)));
    }

    #[test]
    fn wave29_and_30() {
        assert_eq!(second_third_score_gap(&[]), None);
        assert!(user_ids_below_score(&[], 10.0).is_empty());
        assert!(!has_clear_leader(&[]));
        let rows = abc3(30, 20, 10);
        assert_eq!(second_third_score_gap(&rows), Some(10));
        assert_eq!(user_ids_below_score(&rows, 25.0), ["b", "c"]);
        assert_eq!(user_ids_at_or_above_score(&rows, 20.0), ["a", "b"]);
        assert!(has_clear_leader(&rows));

        assert_eq!(last_two_score_gap(&[]), None);
        assert!(!has_at_least_standings(&[], 1.0));
        assert_eq!(mid_rank_user(&[]), None);
        assert_eq!(total_score_sum(&[]), 0);
        let rows = abc3(10, 30, 20);
        assert!(has_at_least_standings(&rows, 3.0));
        assert_eq!(total_score_sum(&rows), 60);
        assert_eq!(mid_rank_user(&rows).as_deref(), Some("c"));
        assert_eq!(last_two_score_gap(&rows), Some(10));
    }

    #[test]
    fn wave31_to_33_labels() {
        assert_eq!(standing_count_label(&[]), "0");
        assert_eq!(max_score_label(&[]), "");
        assert_eq!(min_score_label(&[]), "");
        assert_eq!(ranked_user_ids_joined(&[]), "");
        let rows = ab(10, 20);
        assert_eq!(standing_count_label(&rows), "2");
        assert_eq!(max_score_label(&rows), "20");
        assert_eq!(min_score_label(&rows), "10");
        assert_eq!(ranked_user_ids_joined(&rows), "b,a");

        assert_eq!(scores_in_rank_order_joined(&[]), "");
        assert_eq!(podium_user_ids_joined(&[]), "");
        assert_eq!(standing_user_ids_joined(&[]), "");
        assert_eq!(average_score_label(&[]), "");
        assert_eq!(scores_in_rank_order_joined(&rows), "20,10");
        assert_eq!(podium_user_ids_joined(&rows), "b,a");
        assert_eq!(average_score_label(&rows), "15");

        assert_eq!(first_place_user_label(&[]), "");
        assert_eq!(last_place_user_label(&[]), "");
        assert_eq!(mid_rank_user_label(&[]), "");
        assert_eq!(score_spread_label(&[]), "");
        let rows = ab(10, 30);
        assert_eq!(first_place_user_label(&rows), "b");
        assert_eq!(last_place_user_label(&rows), "a");
        assert_eq!(score_spread_label(&rows), "20");
    }

    #[test]
    fn wave34_and_36_snapshots() {
        assert_eq!(score_extremum_snapshot(&[]).max, None);
        assert_eq!(podium_snapshot(&[]).first, None);
        assert!(score_extremum_consistent(&[]));
        assert!(standing_depth_snapshot(&[]).empty);
        let rows = abc3(10, 30, 20);
        assert_eq!(score_extremum_snapshot(&rows).max, Some(30));
        assert!(score_extremum_consistent(&rows));
        assert_eq!(podium_snapshot(&rows).first.as_deref(), Some("b"));
        assert!(standing_depth_snapshot(&rows).has_podium3);

        assert!(leaderboard_headline(&[]).empty);
        assert!(!user_standing_card(&[], "a").present);
        assert!(top_n_standing_cards(&[], 3.0).is_empty());
        let rows = ab(10, 30);
        assert_eq!(leaderboard_headline(&rows).first.as_deref(), Some("b"));
        assert!(user_standing_card(&rows, "b").is_top);
        assert!(user_standing_present(&rows, "a"));
        assert_eq!(top_n_standing_cards(&rows, 1.0)[0].user_id, "b");
    }

    #[test]
    fn wave37_and_38_filters_and_pages() {
        assert!(filter_standings_min_score(&[], 1.0).is_empty());
        assert!(search_standing_user_ids(&[], "a").is_empty());
        assert_eq!(count_standings_in_score_range(&[], 0.0, 10.0), 0);
        let rows = abc3(10, 30, 20);
        assert_eq!(filter_standings_min_score(&rows, 20.0).len(), 2);
        assert_eq!(filter_standings_max_score(&rows, 20.0).len(), 2);
        assert_eq!(search_standing_user_ids(&rows, "a"), ["a"]);
        assert_eq!(count_standings_in_score_range(&rows, 10.0, 20.0), 2);

        assert!(
            page_ranked_standings(&[], PageOptions::limit(1.0))
                .unwrap()
                .is_empty()
        );
        assert_eq!(standings_page_count(&[], 10.0), 0);
        assert_eq!(
            page_ranked_user_ids(&rows, PageOptions::at(0.0, 2.0)).unwrap(),
            ["b", "c"]
        );
        assert_eq!(standings_page_count(&rows, 2.0), 2);
        assert_eq!(reverse_ranked_standings(&rows)[0].user_id, "a");
    }

    #[test]
    fn page_ranked_standings_refuses_blank_limit_and_accepts_published() {
        let rows = ab(10, 30);
        for o in [
            PageOptions::default(),
            PageOptions {
                offset: Some(0.0),
                limit: None,
            },
            PageOptions::limit(f64::NAN),
            PageOptions::limit(0.0),
        ] {
            assert!(page_ranked_standings(&rows, o).is_err());
        }
        assert!(page_ranked_user_ids(&rows, PageOptions::default()).is_err());
        assert_eq!(
            page_ranked_standings(&rows, PageOptions::default())
                .unwrap_err()
                .code,
            "academy.standings_limit_unset"
        );
        let rows = abc3(10, 30, 20);
        assert_eq!(
            ids(&page_ranked_standings(&rows, PageOptions::limit(2.0)).unwrap()),
            ["b", "c"]
        );
        assert_eq!(
            page_ranked_user_ids(&rows, PageOptions::at(1.0, 1.0)).unwrap(),
            ["c"]
        );
    }

    #[test]
    fn wave39_and_40_diffs_and_safe_paging() {
        let left = ab(10, 30);
        let right = vec![
            row("b", 20, "2026-08-01T13:00:00Z"),
            row("c", 5, "2026-08-01T11:00:00Z"),
        ];
        assert_eq!(standing_user_ids_only_left(&left, &right), ["a"]);
        assert_eq!(standing_user_ids_in_both(&left, &right), ["b"]);
        assert_eq!(score_delta_for_user(&left, &right, "b"), Some(10));
        assert_eq!(score_delta_for_user(&left, &right, "a"), None);
        assert!(standings_same_size(&left, &right));

        assert!(safe_page_ranked_standings(&[], 0.0, 1.0).is_empty());
        assert!(!is_valid_standings_page(&[], 0.0, 1.0));
        let rows = ab(10, 30);
        assert_eq!(safe_page_ranked_standings(&rows, 0.0, 1.0).len(), 1);
        assert_eq!(clamp_standings_page_index(&rows, 99.0, 1.0), 1);
        assert_eq!(ranked_standings_at_page(&rows, 0.0, 1.0)[0].user_id, "b");
        assert!(is_valid_standings_page(&rows, 0.0, 1.0));
    }

    #[test]
    fn wave41_and_42_export() {
        assert!(standings_export_lines(&[]).is_empty());
        assert_eq!(standings_export_header(), "rank,userId,score");
        assert_eq!(standings_export_line_count(&[]), 1);
        let rows = ab(10, 30);
        assert_eq!(standings_export_lines(&rows)[0], "1,b,30");
        assert!(standings_export_text(&rows).contains("userId"));
        assert_eq!(standings_export_line_count(&rows), 3);

        assert_eq!(parse_standings_export_line("rank,userId,score"), None);
        assert_eq!(
            parse_standings_export_line("1,a,10"),
            Some(ExportedStanding {
                rank: 1.0,
                user_id: "a".to_owned(),
                score: 10.0
            })
        );
        assert!(standings_export_round_trip_ok(&[]));
        let text = standings_export_text(&rows);
        assert!(standings_export_has_header(&text));
        assert_eq!(count_standings_export_data_lines(&text), 2);
        assert!(standings_export_round_trip_ok(&rows));
    }

    #[test]
    fn wave44_to_46_status_lines_and_thresholds() {
        assert!(leaderboard_status_line_is_empty(&[]));
        let rows = ab(10, 30);
        assert!(leaderboard_status_line(&rows).contains("count=2"));
        assert!(leaderboard_status_line_detailed(&rows).contains("unique=1"));
        assert!(leaderboard_status_line_token_count(&rows) > 3);

        assert_eq!(
            parse_leaderboard_status_line("count=0 first=- max=-"),
            Some(LeaderboardLine {
                count: 0.0,
                first: None,
                max: None
            })
        );
        assert!(leaderboard_status_line_matches(&[]));
        assert!(leaderboard_status_line_matches(&rows));
        assert!(leaderboard_status_line_detailed_consistent(
            &leaderboard_status_line_detailed(&rows)
        ));

        assert!(standing_count_in_range(&[], 0.0, 0.0));
        assert!(!max_score_at_least(&[], 1.0));
        assert!(standing_count_in_range(&rows, 2.0, 2.0));
        assert!(max_score_at_least(&rows, 30.0));
        assert_eq!(clamp_standings_page_size(&rows, 99.0), 2);
        assert!(score_spread_at_most(&rows, 20.0));
    }
}
