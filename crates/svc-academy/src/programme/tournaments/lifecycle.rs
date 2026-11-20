//! The season lifecycle, without money (`tournaments/season-lifecycle.ts`): scheduled → live → frozen → ended. Score
//! writes stay gated to live; a freeze may capture an immutable ranked snapshot for audit, with no money field. A
//! freeze or end edge refuses a prize attachment; ending never invents a pool.

use std::collections::BTreeSet;

use service_kit::schema::{Value, js_trim};

use super::ladder::{
    PageOptions, RankedStanding, SeasonRecord, SeasonStatus, StandingRecord, TournamentError,
    clamp_page_index, clamp_page_size, is_digits, js_num, js_sort, match_fields, offset_of,
    page_count, published_limit, rank_standings, safe_window, token_count, valid_page,
};
use super::prize::assert_no_prize_attachment;

/// `assertSeasonListPageLimit`.
pub fn assert_season_list_page_limit(limit: Option<f64>) -> Result<usize, TournamentError> {
    published_limit(limit, || {
        TournamentError::new(
            "Season list limit is unset — pass limit (never invent all.length)",
            "academy.season_list_limit_unset",
        )
    })
}

/// `ALLOWED`: the legal edges. `frozen → live` is closed: no silent re-rank after a freeze without a new season.
pub fn allowed_next_statuses(status: SeasonStatus) -> &'static [SeasonStatus] {
    match status {
        SeasonStatus::Scheduled => &[SeasonStatus::Live, SeasonStatus::Ended],
        SeasonStatus::Live => &[SeasonStatus::Frozen, SeasonStatus::Ended],
        SeasonStatus::Frozen => &[SeasonStatus::Ended],
        SeasonStatus::Ended => &[],
    }
}

/// `transitionSeason`: an illegal edge refuses; ending invents no prize.
pub fn transition_season(
    season: &SeasonRecord,
    next: SeasonStatus,
) -> Result<SeasonRecord, TournamentError> {
    assert_no_prize_attachment(&season.to_value())?;
    if !allowed_next_statuses(season.status).contains(&next) {
        return Err(TournamentError::new(
            format!(
                "Cannot move season from {} to {}",
                season.status.as_str(),
                next.as_str()
            ),
            "academy.season_invalid",
        ));
    }
    Ok(SeasonRecord {
        status: next,
        ..season.clone()
    })
}

/// `isScoreWritable`.
pub fn is_score_writable(status: SeasonStatus) -> bool {
    status == SeasonStatus::Live
}

/// `assertMayFreeze`.
pub fn assert_may_freeze(status: SeasonStatus) -> Result<(), TournamentError> {
    if status != SeasonStatus::Live {
        return Err(TournamentError::new(
            format!(
                "Cannot freeze snapshot from status {} — season must be live",
                status.as_str()
            ),
            "academy.season_invalid",
        ));
    }
    Ok(())
}

/// `FreezeStandingsSnapshot`: rank and score only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FreezeStandingsSnapshot {
    pub season_id: String,
    pub frozen_at: i64,
    pub standings: Vec<RankedStanding>,
}

impl FreezeStandingsSnapshot {
    /// The snapshot as the object the prize gate sees.
    fn to_value(&self) -> Value {
        let rows = self
            .standings
            .iter()
            .map(|r| {
                Value::Object(vec![
                    ("seasonId".to_owned(), Value::String(r.season_id.clone())),
                    ("userId".to_owned(), Value::String(r.user_id.clone())),
                    ("score".to_owned(), Value::Number(num(r.score))),
                    ("updatedAt".to_owned(), Value::Date(Some(r.updated_at))),
                    ("rank".to_owned(), Value::Number(count_f(r.rank))),
                ])
            })
            .collect();
        Value::Object(vec![
            ("seasonId".to_owned(), Value::String(self.season_id.clone())),
            ("frozenAt".to_owned(), Value::Date(Some(self.frozen_at))),
            ("standings".to_owned(), Value::Array(rows)),
        ])
    }
}

#[expect(clippy::cast_precision_loss, reason = "a score is at most 1e9")]
fn num(n: i64) -> f64 {
    n as f64
}

#[expect(clippy::cast_precision_loss, reason = "a count is below 2^53")]
fn count_f(n: usize) -> f64 {
    n as f64
}

/// `snapshotStandingsAtFreeze`'s input. `extra` holds any other field a caller put on it (the prize gate reads them).
#[derive(Debug, Clone, PartialEq)]
pub struct FreezeInput<'a> {
    pub season_id: &'a str,
    pub status: SeasonStatus,
    pub rows: &'a [StandingRecord],
    pub frozen_at: i64,
    pub extra: Vec<(String, Value)>,
}

/// `snapshotStandingsAtFreeze`: the ranked standings of this season only. An empty board is allowed.
pub fn snapshot_standings_at_freeze(
    input: &FreezeInput<'_>,
) -> Result<FreezeStandingsSnapshot, TournamentError> {
    assert_may_freeze(input.status)?;
    let mut fields = vec![
        (
            "seasonId".to_owned(),
            Value::String(input.season_id.to_owned()),
        ),
        (
            "status".to_owned(),
            Value::String(input.status.as_str().to_owned()),
        ),
        ("frozenAt".to_owned(), Value::Date(Some(input.frozen_at))),
    ];
    fields.extend(input.extra.iter().cloned());
    assert_no_prize_attachment(&Value::Object(fields))?;
    if js_trim(input.season_id).is_empty() {
        return Err(TournamentError::new(
            "seasonId required for freeze snapshot",
            "academy.season_invalid",
        ));
    }
    let for_season: Vec<StandingRecord> = input
        .rows
        .iter()
        .filter(|r| r.season_id == input.season_id)
        .cloned()
        .collect();
    let snapshot = FreezeStandingsSnapshot {
        season_id: input.season_id.to_owned(),
        frozen_at: input.frozen_at,
        standings: rank_standings(&for_season),
    };
    assert_no_prize_attachment(&snapshot.to_value())?;
    Ok(snapshot)
}

/// `freezeSeasonWithSnapshot`: live → frozen in one pure step, with the rank table.
pub fn freeze_season_with_snapshot(
    season: &SeasonRecord,
    rows: &[StandingRecord],
    frozen_at: i64,
) -> Result<(SeasonRecord, FreezeStandingsSnapshot), TournamentError> {
    assert_may_freeze(season.status)?;
    let snapshot = snapshot_standings_at_freeze(&FreezeInput {
        season_id: &season.id,
        status: season.status,
        rows,
        frozen_at,
        extra: Vec::new(),
    })?;
    Ok((transition_season(season, SeasonStatus::Frozen)?, snapshot))
}

/// `SeasonStatusHistogram`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeasonStatusHistogram {
    pub scheduled: usize,
    pub live: usize,
    pub frozen: usize,
    pub ended: usize,
    pub total: usize,
    pub score_writable: usize,
}

/// `countSeasonsByStatus`.
pub fn count_seasons_by_status(seasons: &[SeasonRecord]) -> SeasonStatusHistogram {
    let n = |s| filter_seasons_by_status(seasons, s).len();
    let (scheduled, live, frozen, ended) = (
        n(SeasonStatus::Scheduled),
        n(SeasonStatus::Live),
        n(SeasonStatus::Frozen),
        n(SeasonStatus::Ended),
    );
    SeasonStatusHistogram {
        scheduled,
        live,
        frozen,
        ended,
        total: scheduled + live + frozen + ended,
        score_writable: live,
    }
}

/// `listScoreWritableSeasons`.
pub fn list_score_writable_seasons(seasons: &[SeasonRecord]) -> Vec<SeasonRecord> {
    seasons
        .iter()
        .filter(|s| is_score_writable(s.status))
        .cloned()
        .collect()
}

/// `filterSeasonsByStatus`.
pub fn filter_seasons_by_status(
    seasons: &[SeasonRecord],
    status: SeasonStatus,
) -> Vec<SeasonRecord> {
    seasons
        .iter()
        .filter(|s| s.status == status)
        .cloned()
        .collect()
}

/// `isSeasonTerminal`.
pub fn is_season_terminal(status: SeasonStatus) -> bool {
    status == SeasonStatus::Ended
}

/// `listSeasonIds`: sorted as JavaScript sorts strings.
pub fn list_season_ids(seasons: &[SeasonRecord]) -> Vec<String> {
    let mut ids: Vec<String> = seasons.iter().map(|s| s.id.clone()).collect();
    js_sort(&mut ids);
    ids
}

/// `listScheduledSeasons`.
pub fn list_scheduled_seasons(seasons: &[SeasonRecord]) -> Vec<SeasonRecord> {
    filter_seasons_by_status(seasons, SeasonStatus::Scheduled)
}

/// `listEndedSeasons`.
pub fn list_ended_seasons(seasons: &[SeasonRecord]) -> Vec<SeasonRecord> {
    filter_seasons_by_status(seasons, SeasonStatus::Ended)
}

/// `listFrozenSeasons`.
pub fn list_frozen_seasons(seasons: &[SeasonRecord]) -> Vec<SeasonRecord> {
    filter_seasons_by_status(seasons, SeasonStatus::Frozen)
}

/// `listLiveSeasons`.
pub fn list_live_seasons(seasons: &[SeasonRecord]) -> Vec<SeasonRecord> {
    filter_seasons_by_status(seasons, SeasonStatus::Live)
}

fn ids_of(seasons: &[SeasonRecord], status: SeasonStatus) -> Vec<String> {
    list_season_ids(&filter_seasons_by_status(seasons, status))
}

/// `listLiveSeasonIds`.
pub fn list_live_season_ids(seasons: &[SeasonRecord]) -> Vec<String> {
    ids_of(seasons, SeasonStatus::Live)
}

/// `listScheduledSeasonIds`.
pub fn list_scheduled_season_ids(seasons: &[SeasonRecord]) -> Vec<String> {
    ids_of(seasons, SeasonStatus::Scheduled)
}

/// `listEndedSeasonIds`.
pub fn list_ended_season_ids(seasons: &[SeasonRecord]) -> Vec<String> {
    ids_of(seasons, SeasonStatus::Ended)
}

/// `listFrozenSeasonIds`.
pub fn list_frozen_season_ids(seasons: &[SeasonRecord]) -> Vec<String> {
    ids_of(seasons, SeasonStatus::Frozen)
}

/// `liveSeasonCount`.
pub fn live_season_count(seasons: &[SeasonRecord]) -> usize {
    filter_seasons_by_status(seasons, SeasonStatus::Live).len()
}

/// `frozenSeasonCount`.
pub fn frozen_season_count(seasons: &[SeasonRecord]) -> usize {
    filter_seasons_by_status(seasons, SeasonStatus::Frozen).len()
}

/// `endedSeasonCount`.
pub fn ended_season_count(seasons: &[SeasonRecord]) -> usize {
    filter_seasons_by_status(seasons, SeasonStatus::Ended).len()
}

/// `scheduledSeasonCount`.
pub fn scheduled_season_count(seasons: &[SeasonRecord]) -> usize {
    filter_seasons_by_status(seasons, SeasonStatus::Scheduled).len()
}

/// `hasLiveSeason`.
pub fn has_live_season(seasons: &[SeasonRecord]) -> bool {
    live_season_count(seasons) > 0
}

/// `hasFrozenSeason`.
pub fn has_frozen_season(seasons: &[SeasonRecord]) -> bool {
    frozen_season_count(seasons) > 0
}

/// `hasEndedSeason`.
pub fn has_ended_season(seasons: &[SeasonRecord]) -> bool {
    ended_season_count(seasons) > 0
}

/// `hasScheduledSeason`.
pub fn has_scheduled_season(seasons: &[SeasonRecord]) -> bool {
    scheduled_season_count(seasons) > 0
}

/// `totalSeasonCount`.
pub fn total_season_count(seasons: &[SeasonRecord]) -> usize {
    seasons.len()
}

/// `hasTerminalSeason`.
pub fn has_terminal_season(seasons: &[SeasonRecord]) -> bool {
    seasons.iter().any(|s| is_season_terminal(s.status))
}

/// `scoreWritableSeasonCount`.
pub fn score_writable_season_count(seasons: &[SeasonRecord]) -> usize {
    list_score_writable_seasons(seasons).len()
}

/// `Number.prototype.toFixed(digits)` for a finite non-negative number: half up on the number's exact decimal value.
pub fn to_fixed(x: f64, digits: usize) -> String {
    // A double's exact decimal expansion has at most 1074 fractional digits.
    let exact = format!("{x:.1100}");
    let Some((whole, frac)) = exact.split_once('.') else {
        return exact;
    };
    let mut kept: Vec<u8> = whole.bytes().chain(frac.bytes().take(digits)).collect();
    if frac.as_bytes().get(digits).is_some_and(|d| *d >= b'5') {
        let mut i = kept.len();
        loop {
            if i == 0 {
                kept.insert(0, b'1');
                break;
            }
            i -= 1;
            match kept.get_mut(i) {
                Some(d) if *d == b'9' => *d = b'0',
                Some(d) => {
                    *d += 1;
                    break;
                }
                None => break,
            }
        }
    }
    let split = kept.len() - digits;
    let (w, f) = kept.split_at(split);
    let (w, f) = (String::from_utf8_lossy(w), String::from_utf8_lossy(f));
    if digits == 0 {
        w.into_owned()
    } else {
        format!("{w}.{f}")
    }
}

fn ratio(part: usize, seasons: &[SeasonRecord]) -> Option<String> {
    if seasons.is_empty() {
        return None;
    }
    #[expect(
        clippy::float_arithmetic,
        reason = "a share of seasons as JavaScript divides it; not money"
    )]
    let r = count_f(part) / count_f(seasons.len());
    Some(to_fixed(r, 4))
}

/// `liveSeasonRatio`.
pub fn live_season_ratio(seasons: &[SeasonRecord]) -> Option<String> {
    ratio(live_season_count(seasons), seasons)
}

/// `isSeasonListEmpty`.
pub fn is_season_list_empty(seasons: &[SeasonRecord]) -> bool {
    seasons.is_empty()
}

/// `frozenSeasonRatio`.
pub fn frozen_season_ratio(seasons: &[SeasonRecord]) -> Option<String> {
    ratio(frozen_season_count(seasons), seasons)
}

/// `endedSeasonRatio`.
pub fn ended_season_ratio(seasons: &[SeasonRecord]) -> Option<String> {
    ratio(ended_season_count(seasons), seasons)
}

/// `scheduledSeasonRatio`.
pub fn scheduled_season_ratio(seasons: &[SeasonRecord]) -> Option<String> {
    ratio(scheduled_season_count(seasons), seasons)
}

fn all_are(seasons: &[SeasonRecord], status: SeasonStatus) -> bool {
    !seasons.is_empty() && seasons.iter().all(|s| s.status == status)
}

/// `allSeasonsEnded`.
pub fn all_seasons_ended(seasons: &[SeasonRecord]) -> bool {
    all_are(seasons, SeasonStatus::Ended)
}

/// `openSeasonCount`.
pub fn open_season_count(seasons: &[SeasonRecord]) -> usize {
    seasons
        .iter()
        .filter(|s| !is_season_terminal(s.status))
        .count()
}

/// `hasScoreWritableSeason`.
pub fn has_score_writable_season(seasons: &[SeasonRecord]) -> bool {
    score_writable_season_count(seasons) > 0
}

/// `openSeasonRatio`.
pub fn open_season_ratio(seasons: &[SeasonRecord]) -> Option<String> {
    ratio(open_season_count(seasons), seasons)
}

/// `listScoreWritableSeasonIds`.
pub fn list_score_writable_season_ids(seasons: &[SeasonRecord]) -> Vec<String> {
    list_season_ids(&list_score_writable_seasons(seasons))
}

/// `allSeasonsLive`.
pub fn all_seasons_live(seasons: &[SeasonRecord]) -> bool {
    all_are(seasons, SeasonStatus::Live)
}

/// `allSeasonsScheduled`.
pub fn all_seasons_scheduled(seasons: &[SeasonRecord]) -> bool {
    all_are(seasons, SeasonStatus::Scheduled)
}

/// `allSeasonsFrozen`.
pub fn all_seasons_frozen(seasons: &[SeasonRecord]) -> bool {
    all_are(seasons, SeasonStatus::Frozen)
}

/// `distinctSeasonStatusCount`.
pub fn distinct_season_status_count(seasons: &[SeasonRecord]) -> usize {
    seasons
        .iter()
        .map(|s| s.status.as_str())
        .collect::<BTreeSet<_>>()
        .len()
}

/// `hasAtLeastSeasons`.
pub fn has_at_least_seasons(seasons: &[SeasonRecord], n: f64) -> bool {
    if !n.is_finite() || n < 0.0 {
        return false;
    }
    count_f(seasons.len()) >= n.floor()
}

/// `firstSeasonId`.
pub fn first_season_id(seasons: &[SeasonRecord]) -> Option<String> {
    list_season_ids(seasons).into_iter().next()
}

/// `lastSeasonId`.
pub fn last_season_id(seasons: &[SeasonRecord]) -> Option<String> {
    list_season_ids(seasons).pop()
}

/// `hasMixedSeasonStatuses`.
pub fn has_mixed_season_statuses(seasons: &[SeasonRecord]) -> bool {
    distinct_season_status_count(seasons) >= 2
}

/// `seasonCountLabel`.
pub fn season_count_label(seasons: &[SeasonRecord]) -> String {
    seasons.len().to_string()
}

/// `liveSeasonCountLabel`.
pub fn live_season_count_label(seasons: &[SeasonRecord]) -> String {
    live_season_count(seasons).to_string()
}

/// `seasonIdsJoined`.
pub fn season_ids_joined(seasons: &[SeasonRecord]) -> String {
    list_season_ids(seasons).join(",")
}

/// `liveSeasonIdsJoined`.
pub fn live_season_ids_joined(seasons: &[SeasonRecord]) -> String {
    list_live_season_ids(seasons).join(",")
}

/// `scheduledSeasonIdsJoined`.
pub fn scheduled_season_ids_joined(seasons: &[SeasonRecord]) -> String {
    list_scheduled_season_ids(seasons).join(",")
}

/// `frozenSeasonIdsJoined`.
pub fn frozen_season_ids_joined(seasons: &[SeasonRecord]) -> String {
    list_frozen_season_ids(seasons).join(",")
}

/// `endedSeasonIdsJoined`.
pub fn ended_season_ids_joined(seasons: &[SeasonRecord]) -> String {
    list_ended_season_ids(seasons).join(",")
}

/// `scoreWritableSeasonIdsJoined`.
pub fn score_writable_season_ids_joined(seasons: &[SeasonRecord]) -> String {
    list_score_writable_season_ids(seasons).join(",")
}

/// `liveSeasonRatioLabel`.
pub fn live_season_ratio_label(seasons: &[SeasonRecord]) -> String {
    live_season_ratio(seasons).unwrap_or_default()
}

/// `frozenSeasonRatioLabel`.
pub fn frozen_season_ratio_label(seasons: &[SeasonRecord]) -> String {
    frozen_season_ratio(seasons).unwrap_or_default()
}

/// `endedSeasonRatioLabel`.
pub fn ended_season_ratio_label(seasons: &[SeasonRecord]) -> String {
    ended_season_ratio(seasons).unwrap_or_default()
}

/// `openSeasonRatioLabel`.
pub fn open_season_ratio_label(seasons: &[SeasonRecord]) -> String {
    open_season_ratio(seasons).unwrap_or_default()
}

/// `seasonStatusSnapshot`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeasonStatusSnapshot {
    pub scheduled: usize,
    pub live: usize,
    pub frozen: usize,
    pub ended: usize,
    pub total: usize,
}

pub fn season_status_snapshot(seasons: &[SeasonRecord]) -> SeasonStatusSnapshot {
    SeasonStatusSnapshot {
        scheduled: scheduled_season_count(seasons),
        live: live_season_count(seasons),
        frozen: frozen_season_count(seasons),
        ended: ended_season_count(seasons),
        total: total_season_count(seasons),
    }
}

/// `seasonCountsConsistent`.
pub fn season_counts_consistent(seasons: &[SeasonRecord]) -> bool {
    let s = season_status_snapshot(seasons);
    s.total == s.scheduled + s.live + s.frozen + s.ended
}

/// `seasonOpenEndedPartition`: (open, ended).
pub fn season_open_ended_partition(seasons: &[SeasonRecord]) -> (usize, usize) {
    (open_season_count(seasons), ended_season_count(seasons))
}

/// `seasonWritableSnapshot`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeasonWritableSnapshot {
    pub writable_count: usize,
    pub has_writable: bool,
    pub writable_ids: Vec<String>,
}

pub fn season_writable_snapshot(seasons: &[SeasonRecord]) -> SeasonWritableSnapshot {
    SeasonWritableSnapshot {
        writable_count: score_writable_season_count(seasons),
        has_writable: has_score_writable_season(seasons),
        writable_ids: list_score_writable_season_ids(seasons),
    }
}

/// `seasonBoardHeadline`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeasonBoardHeadline {
    pub total: usize,
    pub live: usize,
    pub scheduled: usize,
    pub frozen: usize,
    pub ended: usize,
    pub open: usize,
    pub empty: bool,
    pub has_writable: bool,
}

pub fn season_board_headline(seasons: &[SeasonRecord]) -> SeasonBoardHeadline {
    SeasonBoardHeadline {
        total: total_season_count(seasons),
        live: live_season_count(seasons),
        scheduled: scheduled_season_count(seasons),
        frozen: frozen_season_count(seasons),
        ended: ended_season_count(seasons),
        open: open_season_count(seasons),
        empty: is_season_list_empty(seasons),
        has_writable: has_score_writable_season(seasons),
    }
}

/// `seasonCard`: a missing season has no status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeasonCard {
    pub id: String,
    pub present: bool,
    pub status: Option<SeasonStatus>,
    pub terminal: bool,
    pub writable: bool,
}

pub fn season_card(seasons: &[SeasonRecord], season_id: &str) -> SeasonCard {
    let id = js_trim(season_id).to_owned();
    match seasons.iter().find(|s| s.id == id) {
        None => SeasonCard {
            id,
            present: false,
            status: None,
            terminal: false,
            writable: false,
        },
        Some(row) => SeasonCard {
            id,
            present: true,
            status: Some(row.status),
            terminal: is_season_terminal(row.status),
            writable: is_score_writable(row.status),
        },
    }
}

/// One of `listSeasonCards`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedSeasonCard {
    pub id: String,
    pub status: SeasonStatus,
    pub terminal: bool,
    pub writable: bool,
}

/// `listSeasonCards`: by sorted id; a repeated id shows its first record each time, as `find` does.
pub fn list_season_cards(seasons: &[SeasonRecord]) -> Vec<ListedSeasonCard> {
    list_season_ids(seasons)
        .into_iter()
        .filter_map(|id| {
            let row = seasons.iter().find(|s| s.id == id)?;
            Some(ListedSeasonCard {
                status: row.status,
                terminal: is_season_terminal(row.status),
                writable: is_score_writable(row.status),
                id,
            })
        })
        .collect()
}

/// `seasonPresent`.
pub fn season_present(seasons: &[SeasonRecord], season_id: &str) -> bool {
    season_card(seasons, season_id).present
}

/// `filterSeasonCardsByStatus`.
pub fn filter_season_cards_by_status(
    seasons: &[SeasonRecord],
    status: SeasonStatus,
) -> Vec<ListedSeasonCard> {
    list_season_cards(seasons)
        .into_iter()
        .filter(|c| c.status == status)
        .collect()
}

/// `searchSeasonIds`.
pub fn search_season_ids(seasons: &[SeasonRecord], needle: &str) -> Vec<String> {
    let n = js_trim(needle);
    if n.is_empty() {
        return Vec::new();
    }
    list_season_ids(seasons)
        .into_iter()
        .filter(|id| id.contains(n))
        .collect()
}

/// `listWritableSeasonCards`.
pub fn list_writable_season_cards(seasons: &[SeasonRecord]) -> Vec<ListedSeasonCard> {
    list_season_cards(seasons)
        .into_iter()
        .filter(|c| c.writable)
        .collect()
}

/// `listTerminalSeasonCards`.
pub fn list_terminal_season_cards(seasons: &[SeasonRecord]) -> Vec<ListedSeasonCard> {
    list_season_cards(seasons)
        .into_iter()
        .filter(|c| c.terminal)
        .collect()
}

fn page_ids(all: Vec<String>, options: PageOptions) -> Result<Vec<String>, TournamentError> {
    let o = offset_of(options);
    let limit = assert_season_list_page_limit(options.limit)?;
    Ok(all.into_iter().skip(o).take(limit).collect())
}

/// `pageSeasonIds`: the limit must be published.
pub fn page_season_ids(
    seasons: &[SeasonRecord],
    options: PageOptions,
) -> Result<Vec<String>, TournamentError> {
    page_ids(list_season_ids(seasons), options)
}

/// `pageLiveSeasonIds`.
pub fn page_live_season_ids(
    seasons: &[SeasonRecord],
    options: PageOptions,
) -> Result<Vec<String>, TournamentError> {
    page_ids(list_live_season_ids(seasons), options)
}

/// `seasonListPageCount`.
pub fn season_list_page_count(seasons: &[SeasonRecord], page_size: f64) -> usize {
    page_count(total_season_count(seasons), page_size)
}

/// `reverseSeasonIds`.
pub fn reverse_season_ids(seasons: &[SeasonRecord]) -> Vec<String> {
    let mut ids = list_season_ids(seasons);
    ids.reverse();
    ids
}

/// `seasonIdsOnlyLeft`.
pub fn season_ids_only_left(left: &[SeasonRecord], right: &[SeasonRecord]) -> Vec<String> {
    let r = list_season_ids(right);
    list_season_ids(left)
        .into_iter()
        .filter(|id| !r.contains(id))
        .collect()
}

/// `seasonIdsInBoth`.
pub fn season_ids_in_both(left: &[SeasonRecord], right: &[SeasonRecord]) -> Vec<String> {
    let r = list_season_ids(right);
    list_season_ids(left)
        .into_iter()
        .filter(|id| r.contains(id))
        .collect()
}

/// `liveSeasonCountDelta`.
pub fn live_season_count_delta(left: &[SeasonRecord], right: &[SeasonRecord]) -> i64 {
    let (l, r) = (live_season_count(left), live_season_count(right));
    i64::try_from(l).unwrap_or(i64::MAX) - i64::try_from(r).unwrap_or(i64::MAX)
}

/// `seasonsSameSize`.
pub fn seasons_same_size(left: &[SeasonRecord], right: &[SeasonRecord]) -> bool {
    total_season_count(left) == total_season_count(right)
}

/// `safePageSeasonIds`.
pub fn safe_page_season_ids(seasons: &[SeasonRecord], offset: f64, limit: f64) -> Vec<String> {
    let all = list_season_ids(seasons);
    let Some((o, l)) = safe_window(all.len(), offset, limit) else {
        return Vec::new();
    };
    all.into_iter().skip(o).take(l).collect()
}

/// `clampSeasonPageIndex`.
pub fn clamp_season_page_index(seasons: &[SeasonRecord], page_index: f64, page_size: f64) -> usize {
    clamp_page_index(season_list_page_count(seasons, page_size), page_index)
}

/// `seasonIdsAtPage`.
pub fn season_ids_at_page(
    seasons: &[SeasonRecord],
    page_index: f64,
    page_size: f64,
) -> Vec<String> {
    if !page_size.is_finite() || page_size < 1.0 {
        return Vec::new();
    }
    let idx = clamp_season_page_index(seasons, page_index, page_size);
    let size = page_size.floor();
    #[expect(
        clippy::float_arithmetic,
        reason = "idx * size as JavaScript multiplies two small integers"
    )]
    let offset = count_f(idx) * size;
    safe_page_season_ids(seasons, offset, size)
}

/// `isValidSeasonPage`.
pub fn is_valid_season_page(seasons: &[SeasonRecord], page_index: f64, page_size: f64) -> bool {
    valid_page(season_list_page_count(seasons, page_size), page_index)
}

/// `seasonsExportLines`: `id,status`.
pub fn seasons_export_lines(seasons: &[SeasonRecord]) -> Vec<String> {
    list_season_cards(seasons)
        .into_iter()
        .map(|c| format!("{},{}", c.id, c.status.as_str()))
        .collect()
}

/// `seasonsExportHeader`.
pub fn seasons_export_header() -> &'static str {
    "id,status"
}

/// `seasonsExportText`.
pub fn seasons_export_text(seasons: &[SeasonRecord]) -> String {
    let mut lines = vec![seasons_export_header().to_owned()];
    lines.extend(seasons_export_lines(seasons));
    lines.join("\n")
}

/// `seasonsExportLineCount`.
pub fn seasons_export_line_count(seasons: &[SeasonRecord]) -> usize {
    1 + total_season_count(seasons)
}

/// `parseSeasonsExportLine`.
pub fn parse_seasons_export_line(line: &str) -> Option<(String, SeasonStatus)> {
    let t = js_trim(line);
    if t.is_empty() || t == seasons_export_header() {
        return None;
    }
    let parts: Vec<&str> = t.split(',').collect();
    let [id, status] = parts.as_slice() else {
        return None;
    };
    let id = js_trim(id);
    if id.is_empty() {
        return None;
    }
    Some((id.to_owned(), SeasonStatus::parse(js_trim(status))?))
}

/// `countSeasonsExportDataLines`.
pub fn count_seasons_export_data_lines(text: &str) -> usize {
    text.split('\n')
        .filter(|l| parse_seasons_export_line(l).is_some())
        .count()
}

/// `seasonsExportHasHeader`.
pub fn seasons_export_has_header(text: &str) -> bool {
    js_trim(text.split('\n').next().unwrap_or("")) == seasons_export_header()
}

/// `seasonsExportRoundTripOk`.
pub fn seasons_export_round_trip_ok(seasons: &[SeasonRecord]) -> bool {
    seasons_export_line_count(seasons)
        == 1 + count_seasons_export_data_lines(&seasons_export_text(seasons))
}

/// `seasonStatusLine`.
pub fn season_status_line(seasons: &[SeasonRecord]) -> String {
    let h = season_board_headline(seasons);
    format!(
        "total={} live={} open={} ended={}",
        h.total, h.live, h.open, h.ended
    )
}

/// `seasonStatusLineIsEmpty`.
pub fn season_status_line_is_empty(seasons: &[SeasonRecord]) -> bool {
    season_status_line(seasons).starts_with("total=0")
}

/// `seasonStatusLineDetailed`.
pub fn season_status_line_detailed(seasons: &[SeasonRecord]) -> String {
    let h = season_board_headline(seasons);
    format!(
        "total={} scheduled={} live={} frozen={} ended={} writable={}",
        h.total,
        h.scheduled,
        h.live,
        h.frozen,
        h.ended,
        if h.has_writable { "1" } else { "0" }
    )
}

/// `seasonStatusLineTokenCount`.
pub fn season_status_line_token_count(seasons: &[SeasonRecord]) -> usize {
    token_count(&season_status_line_detailed(seasons))
}

fn digits(values: &[&str]) -> Option<Vec<f64>> {
    values
        .iter()
        .map(|v| is_digits(v).then(|| js_num(v)))
        .collect()
}

/// `parseSeasonStatusLine`: (total, live, open, ended).
pub fn parse_season_status_line(line: &str) -> Option<[f64; 4]> {
    let v = match_fields(line, &["total", "live", "open", "ended"])?;
    let n = digits(&v)?;
    let [total, live, open, ended] = n.as_slice() else {
        return None;
    };
    Some([*total, *live, *open, *ended])
}

/// `seasonStatusLineMatches`.
pub fn season_status_line_matches(seasons: &[SeasonRecord]) -> bool {
    let Some(p) = parse_season_status_line(&season_status_line(seasons)) else {
        return false;
    };
    let h = season_board_headline(seasons);
    p == [
        count_f(h.total),
        count_f(h.live),
        count_f(h.open),
        count_f(h.ended),
    ]
}

/// A parsed detailed season line.
#[derive(Debug, Clone, PartialEq)]
pub struct SeasonStatusDetail {
    pub total: f64,
    pub scheduled: f64,
    pub live: f64,
    pub frozen: f64,
    pub ended: f64,
    pub writable: bool,
}

/// `parseSeasonStatusLineDetailed`.
pub fn parse_season_status_line_detailed(line: &str) -> Option<SeasonStatusDetail> {
    let v = match_fields(
        line,
        &["total", "scheduled", "live", "frozen", "ended", "writable"],
    )?;
    let [total, scheduled, live, frozen, ended, writable] = v.as_slice() else {
        return None;
    };
    if *writable != "0" && *writable != "1" {
        return None;
    }
    let n = digits(&[total, scheduled, live, frozen, ended])?;
    let [total, scheduled, live, frozen, ended] = n.as_slice() else {
        return None;
    };
    Some(SeasonStatusDetail {
        total: *total,
        scheduled: *scheduled,
        live: *live,
        frozen: *frozen,
        ended: *ended,
        writable: *writable == "1",
    })
}

/// `seasonStatusLineDetailedConsistent`.
pub fn season_status_line_detailed_consistent(line: &str) -> bool {
    let Some(p) = parse_season_status_line_detailed(line) else {
        return false;
    };
    #[expect(
        clippy::float_arithmetic,
        reason = "a sum of counts as JavaScript adds them"
    )]
    let sum = p.scheduled + p.live + p.frozen + p.ended;
    p.total == sum
}

/// `seasonCountInRange`.
pub fn season_count_in_range(seasons: &[SeasonRecord], min: f64, max: f64) -> bool {
    if !min.is_finite() || !max.is_finite() || min > max {
        return false;
    }
    let n = count_f(total_season_count(seasons));
    n >= min && n <= max
}

/// `liveSeasonCountAtLeast`.
pub fn live_season_count_at_least(seasons: &[SeasonRecord], n: f64) -> bool {
    n.is_finite() && count_f(live_season_count(seasons)) >= n
}

/// `clampSeasonPageSize`.
pub fn clamp_season_page_size(seasons: &[SeasonRecord], page_size: f64) -> usize {
    clamp_page_size(total_season_count(seasons), page_size)
}

/// `openSeasonRatioAtLeast`.
pub fn open_season_ratio_at_least(seasons: &[SeasonRecord], threshold: f64) -> bool {
    if !threshold.is_finite() {
        return false;
    }
    open_season_ratio(seasons).is_some_and(|r| js_num(&r) >= threshold)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "tests")]
mod tests {
    //! `tournaments/season-lifecycle.test.ts`, the lifecycle half of `tournaments/wire-lifecycle.test.ts`, and the
    //! season rows of `list-limit-unset.test.ts`.
    use super::super::prize::tests::s;
    use super::*;
    use service_kit::time::js_date;

    fn t(v: &str) -> i64 {
        js_date(v).unwrap().0
    }

    fn base(status: SeasonStatus) -> SeasonRecord {
        SeasonRecord {
            id: "s1".to_owned(),
            slug: "summer-26".to_owned(),
            title: "Summer".to_owned(),
            status,
            rules_summary: "Paper scores only".to_owned(),
            starts_at: t("2026-08-01T00:00:00.000Z"),
            ends_at: None,
            extra: Vec::new(),
        }
    }

    fn with_id(id: &str, status: SeasonStatus) -> SeasonRecord {
        SeasonRecord {
            id: id.to_owned(),
            ..base(status)
        }
    }

    /// The waves' `mk(id, status)`.
    fn mk(id: &str, status: SeasonStatus) -> SeasonRecord {
        SeasonRecord {
            id: id.to_owned(),
            slug: id.to_owned(),
            title: id.to_owned(),
            status,
            rules_summary: "non-money".to_owned(),
            starts_at: t("2026-01-01T00:00:00Z"),
            ends_at: None,
            extra: Vec::new(),
        }
    }

    fn row(user: &str, score: i64, at: &str) -> StandingRecord {
        StandingRecord {
            season_id: "s1".to_owned(),
            user_id: user.to_owned(),
            score,
            updated_at: t(at),
        }
    }

    fn ids(v: &[SeasonRecord]) -> Vec<&str> {
        v.iter().map(|s| s.id.as_str()).collect()
    }

    use SeasonStatus::{Ended, Frozen, Live, Scheduled};

    #[test]
    fn scheduled_live_frozen_ended() {
        let mut s = base(Scheduled);
        s = transition_season(&s, Live).unwrap();
        assert_eq!(s.status, Live);
        assert!(is_score_writable(s.status));
        s = transition_season(&s, Frozen).unwrap();
        assert!(!is_score_writable(s.status));
        s = transition_season(&s, Ended).unwrap();
        assert_eq!(s.status, Ended);
    }

    #[test]
    fn refuses_scheduled_to_frozen() {
        let e = transition_season(&base(Scheduled), Frozen).unwrap_err();
        assert_eq!(e.code, "academy.season_invalid");
    }

    #[test]
    fn ended_is_terminal() {
        assert!(transition_season(&base(Ended), Live).is_err());
    }

    #[test]
    fn refuses_frozen_to_live() {
        let e = transition_season(&base(Frozen), Live).unwrap_err();
        assert_eq!(e.code, "academy.season_invalid");
        let m = e.message.to_lowercase();
        assert!(m.find("frozen").unwrap() < m.rfind("live").unwrap());
        assert!(!is_score_writable(Frozen));
        assert_eq!(
            transition_season(&base(Frozen), Ended).unwrap().status,
            Ended
        );
    }

    #[test]
    fn wire_lifecycle_edges() {
        let wire = |status| SeasonRecord {
            id: "11111111-1111-1111-1111-111111111111".to_owned(),
            slug: "spring-open".to_owned(),
            title: "Spring Open".to_owned(),
            rules_summary: "Paper ladder only — no prize money on this stage.".to_owned(),
            ..base(status)
        };
        assert!(transition_season(&wire(Ended), Live).is_err());
        assert_eq!(
            transition_season(&wire(Live), Frozen).unwrap().status,
            Frozen
        );
        assert_eq!(
            transition_season(&wire(Frozen), Ended).unwrap().status,
            Ended
        );
        assert_eq!(
            transition_season(&wire(Scheduled), Live).unwrap().status,
            Live
        );
        let mut with_prize = wire(Live);
        with_prize.extra.push(("prizePool".to_owned(), s("1000")));
        assert!(assert_no_prize_attachment(&with_prize.to_value()).is_err());
    }

    #[test]
    fn freeze_snapshot_ranks_standings_with_no_money_fields() {
        let mut rows = vec![
            row("a", 10, "2026-08-01T12:00:00Z"),
            row("b", 50, "2026-08-01T13:00:00Z"),
            row("other-season", 99, "2026-08-01T10:00:00Z"),
        ];
        rows[2].season_id = "other".to_owned();
        let snap = snapshot_standings_at_freeze(&FreezeInput {
            season_id: "s1",
            status: Live,
            rows: &rows,
            frozen_at: t("2026-08-05T00:00:00.000Z"),
            extra: Vec::new(),
        })
        .unwrap();
        let users: Vec<&str> = snap.standings.iter().map(|r| r.user_id.as_str()).collect();
        assert_eq!(users, ["b", "a"]);
        assert_eq!((snap.standings[0].rank, snap.standings[0].score), (1, 50));
        let fields = snap.to_value();
        assert!(!fields.has("prize") && !fields.has("payout"));
        assert!(
            snapshot_standings_at_freeze(&FreezeInput {
                season_id: "s1",
                status: Scheduled,
                rows: &[],
                frozen_at: 0,
                extra: Vec::new(),
            })
            .is_err()
        );
    }

    #[test]
    fn freeze_season_with_snapshot_freezes_and_captures() {
        let (season, snapshot) =
            freeze_season_with_snapshot(&base(Live), &[row("z", 1, "2026-08-01T00:00:00Z")], 0)
                .unwrap();
        assert_eq!(season.status, Frozen);
        assert_eq!(snapshot.standings.len(), 1);
        assert!(!is_score_writable(season.status));
    }

    #[test]
    fn stage3_transition_and_freeze_refuse_prize_attachment() {
        let mut with_prize = base(Live);
        with_prize.extra.push(("prize".to_owned(), s("100.00")));
        assert!(transition_season(&with_prize, Frozen).is_err());
        assert!(
            snapshot_standings_at_freeze(&FreezeInput {
                season_id: "s1",
                status: Live,
                rows: &[],
                frozen_at: 0,
                extra: vec![("prizePool".to_owned(), s("1"))],
            })
            .is_err()
        );
    }

    #[test]
    fn count_seasons_by_status_histogram() {
        assert_eq!(
            count_seasons_by_status(&[]),
            SeasonStatusHistogram {
                scheduled: 0,
                live: 0,
                frozen: 0,
                ended: 0,
                total: 0,
                score_writable: 0
            }
        );
        let h = count_seasons_by_status(&[
            with_id("a", Scheduled),
            with_id("b", Live),
            with_id("c", Live),
            with_id("d", Frozen),
            with_id("e", Ended),
        ]);
        assert_eq!(
            h,
            SeasonStatusHistogram {
                scheduled: 1,
                live: 2,
                frozen: 1,
                ended: 1,
                total: 5,
                score_writable: 2
            }
        );
    }

    #[test]
    fn filters_and_id_lists() {
        let list = list_score_writable_seasons(&[
            with_id("a", Scheduled),
            with_id("b", Live),
            with_id("c", Frozen),
        ]);
        assert_eq!(ids(&list), ["b"]);
        assert!(list_score_writable_seasons(&[]).is_empty());

        assert!(allowed_next_statuses(Ended).is_empty());
        assert!(allowed_next_statuses(Live).contains(&Frozen));
        assert!(allowed_next_statuses(Scheduled).contains(&Live));
        assert_eq!(allowed_next_statuses(Frozen), [Ended]);
        assert!(!allowed_next_statuses(Frozen).contains(&Live));

        let seasons = [with_id("a", Scheduled), with_id("b", Live)];
        assert_eq!(ids(&filter_seasons_by_status(&seasons, Live)), ["b"]);
        assert!(filter_seasons_by_status(&seasons, Ended).is_empty());
        assert!(filter_seasons_by_status(&[], Live).is_empty());

        assert!(is_season_terminal(Ended));
        assert!(!is_season_terminal(Live));
        assert!(list_season_ids(&[]).is_empty());
        assert_eq!(
            list_season_ids(&[with_id("b", Live), with_id("a", Scheduled)]),
            ["a", "b"]
        );

        let seasons = [
            with_id("a", Scheduled),
            with_id("b", Live),
            with_id("c", Ended),
        ];
        assert_eq!(ids(&list_scheduled_seasons(&seasons)), ["a"]);
        assert_eq!(ids(&list_ended_seasons(&seasons)), ["c"]);
        assert!(list_scheduled_seasons(&[]).is_empty());

        let seasons = [
            with_id("a", Live),
            with_id("b", Frozen),
            with_id("c", Ended),
        ];
        assert_eq!(ids(&list_frozen_seasons(&seasons)), ["b"]);
        assert_eq!(list_live_season_ids(&seasons), ["a"]);
        assert!(list_frozen_seasons(&[]).is_empty());

        let seasons = [with_id("a", Live), with_id("b", Scheduled)];
        assert_eq!(ids(&list_live_seasons(&seasons)), ["a"]);
        assert!(list_live_seasons(&[]).is_empty());
        let seasons = [with_id("a", Scheduled), with_id("b", Live)];
        assert_eq!(list_scheduled_season_ids(&seasons), ["a"]);
        assert!(list_scheduled_season_ids(&[]).is_empty());

        let seasons = [with_id("a", Live), with_id("b", Ended), with_id("c", Ended)];
        assert_eq!(list_ended_season_ids(&seasons), ["b", "c"]);
        assert!(list_ended_season_ids(&[]).is_empty());
        let seasons = [with_id("a", Frozen), with_id("b", Live)];
        assert_eq!(list_frozen_season_ids(&seasons), ["a"]);
        assert!(list_frozen_season_ids(&[]).is_empty());
    }

    #[test]
    fn counts() {
        assert_eq!(live_season_count(&[]), 0);
        assert_eq!(
            live_season_count(&[with_id("a", Live), with_id("b", Live), with_id("c", Ended)]),
            2
        );
        assert_eq!(frozen_season_count(&[]), 0);
        assert_eq!(
            frozen_season_count(&[with_id("a", Frozen), with_id("b", Live)]),
            1
        );
        let seasons = [with_id("a", Live), with_id("b", Ended), with_id("c", Ended)];
        assert_eq!(ended_season_count(&seasons), 2);
        assert!(has_live_season(&seasons));
        assert!(!has_live_season(&[]));
        assert_eq!(ended_season_count(&[]), 0);
        assert_eq!(scheduled_season_count(&[]), 0);
        assert_eq!(
            scheduled_season_count(&[with_id("a", Scheduled), with_id("b", Live)]),
            1
        );
    }

    #[test]
    fn wave25_presence() {
        assert!(!has_frozen_season(&[]));
        assert!(!has_ended_season(&[]));
        assert!(!has_scheduled_season(&[]));
        assert_eq!(total_season_count(&[]), 0);
        let rows = [mk("s1", Scheduled), mk("s2", Frozen), mk("s3", Ended)];
        assert!(has_frozen_season(&rows));
        assert!(has_ended_season(&rows));
        assert!(has_scheduled_season(&rows));
        assert_eq!(total_season_count(&rows), 3);
    }

    #[test]
    fn wave26_ratios_and_terminal() {
        assert!(is_season_list_empty(&[]));
        assert!(!has_terminal_season(&[]));
        assert_eq!(score_writable_season_count(&[]), 0);
        assert_eq!(live_season_ratio(&[]), None);
        let rows = [mk("s1", Live), mk("s2", Ended), mk("s3", Scheduled)];
        assert!(!is_season_list_empty(&rows));
        assert!(has_terminal_season(&rows));
        assert_eq!(score_writable_season_count(&rows), 1);
        assert_eq!(live_season_ratio(&rows).as_deref(), Some("0.3333"));
    }

    #[test]
    fn wave27_ratios_and_all_ended() {
        assert_eq!(frozen_season_ratio(&[]), None);
        assert!(!all_seasons_ended(&[]));
        let rows = [
            mk("a", Frozen),
            mk("b", Ended),
            mk("c", Scheduled),
            mk("d", Ended),
        ];
        assert_eq!(frozen_season_ratio(&rows).as_deref(), Some("0.2500"));
        assert_eq!(ended_season_ratio(&rows).as_deref(), Some("0.5000"));
        assert_eq!(scheduled_season_ratio(&rows).as_deref(), Some("0.2500"));
        assert!(!all_seasons_ended(&rows));
        assert!(all_seasons_ended(&[mk("x", Ended)]));
    }

    #[test]
    fn wave28_open_and_writable() {
        assert_eq!(open_season_count(&[]), 0);
        assert!(!has_score_writable_season(&[]));
        assert_eq!(open_season_ratio(&[]), None);
        assert!(list_score_writable_season_ids(&[]).is_empty());
        let rows = [mk("a", Live), mk("b", Ended), mk("c", Scheduled)];
        assert_eq!(open_season_count(&rows), 2);
        assert!(has_score_writable_season(&rows));
        assert_eq!(open_season_ratio(&rows).as_deref(), Some("0.6667"));
        assert_eq!(list_score_writable_season_ids(&rows), ["a"]);
    }

    #[test]
    fn wave29_all_status_and_distinct() {
        assert!(!all_seasons_live(&[]));
        assert_eq!(distinct_season_status_count(&[]), 0);
        assert!(all_seasons_live(&[mk("a", Live), mk("b", Live)]));
        assert!(all_seasons_scheduled(&[mk("a", Scheduled)]));
        assert!(all_seasons_frozen(&[mk("a", Frozen)]));
        assert_eq!(
            distinct_season_status_count(&[mk("a", Live), mk("b", Ended), mk("c", Live)]),
            2
        );
    }

    #[test]
    fn wave30_ends_and_mixed() {
        assert!(!has_at_least_seasons(&[], 1.0));
        assert_eq!(first_season_id(&[]), None);
        assert_eq!(last_season_id(&[]), None);
        assert!(!has_mixed_season_statuses(&[]));
        let rows = [mk("z", Live), mk("a", Ended)];
        assert!(has_at_least_seasons(&rows, 2.0));
        assert_eq!(first_season_id(&rows).as_deref(), Some("a"));
        assert_eq!(last_season_id(&rows).as_deref(), Some("z"));
        assert!(has_mixed_season_statuses(&rows));
    }

    #[test]
    fn wave31_to_33_labels_and_joins() {
        assert_eq!(season_count_label(&[]), "0");
        assert_eq!(live_season_count_label(&[]), "0");
        assert_eq!(season_ids_joined(&[]), "");
        assert_eq!(live_season_ids_joined(&[]), "");
        let rows = [mk("b", Live), mk("a", Ended)];
        assert_eq!(season_count_label(&rows), "2");
        assert_eq!(live_season_count_label(&rows), "1");
        assert_eq!(season_ids_joined(&rows), "a,b");
        assert_eq!(live_season_ids_joined(&rows), "b");

        assert_eq!(scheduled_season_ids_joined(&[]), "");
        assert_eq!(frozen_season_ids_joined(&[]), "");
        assert_eq!(ended_season_ids_joined(&[]), "");
        assert_eq!(score_writable_season_ids_joined(&[]), "");
        let rows = [
            mk("s", Scheduled),
            mk("l", Live),
            mk("f", Frozen),
            mk("e", Ended),
        ];
        assert_eq!(scheduled_season_ids_joined(&rows), "s");
        assert_eq!(frozen_season_ids_joined(&rows), "f");
        assert_eq!(ended_season_ids_joined(&rows), "e");
        assert_eq!(score_writable_season_ids_joined(&rows), "l");

        assert_eq!(live_season_ratio_label(&[]), "");
        assert_eq!(frozen_season_ratio_label(&[]), "");
        assert_eq!(ended_season_ratio_label(&[]), "");
        assert_eq!(open_season_ratio_label(&[]), "");
        let rows = [mk("a", Live), mk("b", Ended)];
        assert_eq!(live_season_ratio_label(&rows), "0.5000");
        assert_eq!(ended_season_ratio_label(&rows), "0.5000");
        assert_eq!(open_season_ratio_label(&rows), "0.5000");
    }

    #[test]
    fn wave34_and_36_snapshots_and_cards() {
        assert!(season_counts_consistent(&[]));
        let rows = [mk("a", Live), mk("b", Ended), mk("c", Scheduled)];
        assert!(season_counts_consistent(&rows));
        assert_eq!(season_status_snapshot(&rows).live, 1);
        assert_eq!(season_open_ended_partition(&rows), (2, 1));
        assert!(season_writable_snapshot(&rows).has_writable);

        assert!(season_board_headline(&[]).empty);
        assert!(!season_card(&[], "x").present);
        assert!(list_season_cards(&[]).is_empty());
        let rows = [mk("a", Live), mk("b", Ended)];
        assert_eq!(season_board_headline(&rows).live, 1);
        assert!(season_card(&rows, "a").writable);
        assert_eq!(list_season_cards(&rows).len(), 2);
        assert!(season_present(&rows, "b"));
    }

    #[test]
    fn wave37_filters_and_search() {
        assert!(filter_season_cards_by_status(&[], Live).is_empty());
        assert!(search_season_ids(&[], "a").is_empty());
        let rows = [mk("alpha-live", Live), mk("beta-ended", Ended)];
        assert_eq!(filter_season_cards_by_status(&rows, Live).len(), 1);
        assert_eq!(search_season_ids(&rows, "alpha"), ["alpha-live"]);
        assert_eq!(list_writable_season_cards(&rows).len(), 1);
        assert_eq!(list_terminal_season_cards(&rows).len(), 1);
    }

    #[test]
    fn wave38_paging() {
        assert!(
            page_season_ids(&[], PageOptions::limit(1.0))
                .unwrap()
                .is_empty()
        );
        assert_eq!(season_list_page_count(&[], 5.0), 0);
        let rows = [mk("a", Live), mk("b", Ended), mk("c", Live)];
        assert_eq!(
            page_season_ids(&rows, PageOptions::at(0.0, 2.0))
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            page_live_season_ids(&rows, PageOptions::limit(10.0)).unwrap(),
            ["a", "c"]
        );
        assert_eq!(season_list_page_count(&rows, 2.0), 2);
        assert_eq!(reverse_season_ids(&rows)[0], "c");
    }

    #[test]
    fn wave39_and_40_diffs_and_safe_paging() {
        let left = [mk("a", Live), mk("b", Ended)];
        let right = [mk("b", Live), mk("c", Scheduled)];
        assert_eq!(season_ids_only_left(&left, &right), ["a"]);
        assert_eq!(season_ids_in_both(&left, &right), ["b"]);
        assert_eq!(live_season_count_delta(&left, &right), 0);
        assert!(seasons_same_size(&left, &right));

        assert!(safe_page_season_ids(&[], 0.0, 1.0).is_empty());
        assert!(!is_valid_season_page(&[], 0.0, 1.0));
        let rows = [mk("a", Live), mk("b", Ended)];
        assert_eq!(safe_page_season_ids(&rows, 0.0, 1.0).len(), 1);
        assert_eq!(clamp_season_page_index(&rows, 99.0, 1.0), 1);
        assert_eq!(season_ids_at_page(&rows, 0.0, 1.0).len(), 1);
        assert!(is_valid_season_page(&rows, 0.0, 1.0));
    }

    #[test]
    fn wave41_and_42_export() {
        assert!(seasons_export_lines(&[]).is_empty());
        assert_eq!(seasons_export_header(), "id,status");
        let rows = [mk("a", Live)];
        assert_eq!(seasons_export_lines(&rows), ["a,live"]);
        assert!(seasons_export_text(&rows).contains("id,status"));
        assert_eq!(seasons_export_line_count(&rows), 2);

        assert_eq!(parse_seasons_export_line("id,status"), None);
        assert_eq!(
            parse_seasons_export_line("a,live"),
            Some(("a".to_owned(), Live))
        );
        let text = seasons_export_text(&rows);
        assert!(seasons_export_has_header(&text));
        assert_eq!(count_seasons_export_data_lines(&text), 1);
        assert!(seasons_export_round_trip_ok(&rows));
    }

    #[test]
    fn wave44_to_46_status_lines_and_thresholds() {
        assert!(season_status_line_is_empty(&[]));
        let rows = [mk("a", Live), mk("b", Ended)];
        assert!(season_status_line(&rows).contains("live=1"));
        assert!(season_status_line_detailed(&rows).contains("writable=1"));
        assert_eq!(season_status_line_token_count(&rows), 6);

        assert_eq!(
            parse_season_status_line("total=0 live=0 open=0 ended=0"),
            Some([0.0, 0.0, 0.0, 0.0])
        );
        assert!(season_status_line_matches(&[]));
        assert!(season_status_line_matches(&rows));
        assert!(season_status_line_detailed_consistent(
            &season_status_line_detailed(&rows)
        ));

        assert!(season_count_in_range(&[], 0.0, 0.0));
        assert!(live_season_count_at_least(&rows, 1.0));
        assert_eq!(clamp_season_page_size(&rows, 99.0), 2);
        assert!(open_season_ratio_at_least(&rows, 0.5));
    }

    /// `list-limit-unset.test.ts`: omit, null, 0, negative and garbage refuse; a published limit slices.
    #[test]
    fn season_page_ids_refuse_unset_limits() {
        let rows = [mk("a", Live), mk("b", Ended), mk("c", Live)];
        let unset = [
            PageOptions::default(),
            PageOptions::default(),
            PageOptions {
                offset: Some(0.0),
                limit: None,
            },
            PageOptions::default(),
            PageOptions::default(),
            PageOptions::limit(f64::NAN),
            PageOptions::limit(f64::INFINITY),
            PageOptions::limit(0.0),
            PageOptions::limit(-1.0),
            PageOptions::default(),
        ];
        for o in unset {
            assert!(page_season_ids(&rows, o).is_err());
            assert!(page_live_season_ids(&rows, o).is_err());
        }
        assert_eq!(
            page_season_ids(&rows, PageOptions::default())
                .unwrap_err()
                .code,
            "academy.season_list_limit_unset"
        );
        assert_eq!(
            page_season_ids(&rows, PageOptions::at(0.0, 2.0))
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            page_live_season_ids(&rows, PageOptions::limit(10.0)).unwrap(),
            ["a", "c"]
        );
    }

    /// `list-limit-unset.test.ts`: the source never pages by `all.length` when the limit is omitted.
    #[test]
    fn source_does_not_invent_all_length() {
        for src in [
            include_str!("lifecycle.rs"),
            include_str!("ladder.rs"),
            include_str!("mod.rs"),
        ] {
            assert!(!src.contains(&["limit.unwrap_or(all", ".len())"].concat()));
        }
    }

    #[test]
    fn to_fixed_rounds_half_up_on_the_exact_value() {
        assert_eq!(to_fixed(1.0 / 3.0, 4), "0.3333");
        assert_eq!(to_fixed(2.0 / 3.0, 4), "0.6667");
        assert_eq!(to_fixed(0.5, 4), "0.5000");
        assert_eq!(to_fixed(1.0, 4), "1.0000");
        // 1/32 = 0.03125 is an exact tie: JavaScript picks the larger.
        assert_eq!(to_fixed(1.0 / 32.0, 4), "0.0313");
        assert_eq!(to_fixed(0.99996, 4), "1.0000");
    }
}
