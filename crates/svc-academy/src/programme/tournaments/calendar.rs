//! The seasonal ladder calendar, without money (`tournaments/season-calendar.ts`): pure window checks for scheduled
//! and live seasons. A calendar never implies a payout.

use service_kit::json::Json;
use service_kit::schema::js_trim;
use service_kit::time::Instant;

use super::ladder::{SeasonRecord, SeasonStatus, TournamentError};
use super::prize::{PrizeDecision, assert_no_prize_attachment, refuse_fund_prize_pool};

/// `SeasonWindow`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeasonWindow {
    pub season_id: String,
    pub status: SeasonStatus,
    pub starts_at: i64,
    pub ends_at: Option<i64>,
    pub open_at: i64,
    /// `open_at` is inside `[starts_at, ends_at)` (no end is open-ended).
    pub in_window: bool,
    /// Scores write only when live and in the window.
    pub score_window_open: bool,
}

impl SeasonWindow {
    /// `seasonCalendarOut`, in its key order.
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("seasonId", Json::str(self.season_id.as_str())),
            ("status", Json::str(self.status.as_str())),
            ("startsAt", Json::str(Instant(self.starts_at).iso())),
            (
                "endsAt",
                self.ends_at
                    .map_or(Json::Null, |ms| Json::str(Instant(ms).iso())),
            ),
            ("openAt", Json::str(Instant(self.open_at).iso())),
            ("inWindow", Json::Bool(self.in_window)),
            ("scoreWindowOpen", Json::Bool(self.score_window_open)),
        ])
    }
}

/// `seasonWindowAt`: a blank id refuses (never invent a season).
pub fn season_window_at(season: &SeasonRecord, at: i64) -> Result<SeasonWindow, TournamentError> {
    if js_trim(&season.id).is_empty() {
        return Err(TournamentError::new(
            "seasonId required for calendar window",
            "academy.season_invalid",
        ));
    }
    assert_no_prize_attachment(&season.to_value())?;
    let after_start = at >= season.starts_at;
    let before_end = season.ends_at.is_none_or(|end| at < end);
    let in_window = after_start && before_end;
    Ok(SeasonWindow {
        season_id: season.id.clone(),
        status: season.status,
        starts_at: season.starts_at,
        ends_at: season.ends_at,
        open_at: at,
        in_window,
        score_window_open: season.status == SeasonStatus::Live && in_window,
    })
}

/// `listScoreWindowOpenSeasons`.
pub fn list_score_window_open_seasons(
    seasons: &[SeasonRecord],
    at: i64,
) -> Result<Vec<SeasonRecord>, TournamentError> {
    let mut out = Vec::new();
    for s in seasons {
        if season_window_at(s, at)?.score_window_open {
            out.push(s.clone());
        }
    }
    Ok(out)
}

/// `listSeasonsInCalendarWindow`.
pub fn list_seasons_in_calendar_window(
    seasons: &[SeasonRecord],
    at: i64,
) -> Result<Vec<SeasonRecord>, TournamentError> {
    let mut out = Vec::new();
    for s in seasons {
        if season_window_at(s, at)?.in_window {
            out.push(s.clone());
        }
    }
    Ok(out)
}

/// `refusePrizeOnSeasonClose`: a calendar end never opens a prize fund.
pub fn refuse_prize_on_season_close(
    season: &SeasonRecord,
) -> Result<PrizeDecision, TournamentError> {
    assert_no_prize_attachment(&season.to_value())?;
    Ok(refuse_fund_prize_pool())
}

/// `scoreWindowOpenCount`.
pub fn score_window_open_count(
    seasons: &[SeasonRecord],
    at: i64,
) -> Result<usize, TournamentError> {
    Ok(list_score_window_open_seasons(seasons, at)?.len())
}

/// `isSeasonCalendarEnded`.
pub fn is_season_calendar_ended(season: &SeasonRecord, at: i64) -> bool {
    season.ends_at.is_some_and(|end| at >= end)
}

/// `assertScoreWindowOpen`: the write path's gate, live and inside `[starts_at, ends_at)`.
pub fn assert_score_window_open(season: &SeasonRecord, at: i64) -> Result<(), TournamentError> {
    let w = season_window_at(season, at)?;
    if !w.score_window_open {
        if season.status != SeasonStatus::Live {
            return Err(TournamentError::new(
                format!(
                    "Season is {} — scores only write while live",
                    season.status.as_str()
                ),
                "academy.season_not_live",
            ));
        }
        return Err(TournamentError::new(
            "Season is live but outside the score calendar window — scores refuse after endsAt / before startsAt",
            "academy.season_not_live",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "tests")]
mod tests {
    //! `tournaments/season-calendar.test.ts` and `tournaments/season-calendar-route.test.ts`.
    use super::super::prize::{PRIZE_REFUSE_CODE, PrizeIntentKind};
    use super::*;
    use service_kit::time::js_date;

    fn t(s: &str) -> i64 {
        js_date(s).unwrap().0
    }

    fn season(id: &str, status: SeasonStatus) -> SeasonRecord {
        SeasonRecord {
            id: id.to_owned(),
            slug: "summer-26".to_owned(),
            title: "Summer".to_owned(),
            status,
            rules_summary: "Paper scores only — no prizes".to_owned(),
            starts_at: t("2026-08-01T00:00:00.000Z"),
            ends_at: Some(t("2026-08-31T00:00:00.000Z")),
            extra: Vec::new(),
        }
    }

    #[test]
    fn score_window_open_only_when_live_and_inside() {
        let live = season("s1", SeasonStatus::Live);
        let mid = t("2026-08-15T12:00:00.000Z");
        let w = season_window_at(&live, mid).unwrap();
        assert!(w.in_window && w.score_window_open);
        let before = season_window_at(&live, t("2026-07-01T00:00:00.000Z")).unwrap();
        assert!(!before.in_window && !before.score_window_open);
        let scheduled = season_window_at(&season("s1", SeasonStatus::Scheduled), mid).unwrap();
        assert!(scheduled.in_window && !scheduled.score_window_open);
    }

    #[test]
    fn lists_score_open_seasons_without_invent() {
        let at = t("2026-08-15T00:00:00.000Z");
        let seasons = [
            season("s1", SeasonStatus::Live),
            season("s2", SeasonStatus::Frozen),
        ];
        let open = list_score_window_open_seasons(&seasons, at).unwrap();
        assert_eq!(
            open.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["s1"]
        );
        assert_eq!(score_window_open_count(&seasons, at).unwrap(), 1);
        assert_eq!(
            list_seasons_in_calendar_window(&seasons, at).unwrap().len(),
            2
        );
        assert!(list_score_window_open_seasons(&[], at).unwrap().is_empty());
    }

    #[test]
    fn calendar_end_never_invents_a_prize_fund() {
        let ended = season("s1", SeasonStatus::Ended);
        let d = refuse_prize_on_season_close(&ended).unwrap();
        assert_eq!(d.status, "refuse");
        assert_eq!(d.code, PRIZE_REFUSE_CODE);
        assert_eq!(d.kind, PrizeIntentKind::FundPool);
        assert!(is_season_calendar_ended(
            &ended,
            t("2026-09-01T00:00:00.000Z")
        ));
        assert!(!is_season_calendar_ended(
            &ended,
            t("2026-08-15T00:00:00.000Z")
        ));
    }

    #[test]
    fn refuses_blank_season_id() {
        let e = season_window_at(&season("  ", SeasonStatus::Live), 0).unwrap_err();
        assert_eq!(e.code, "academy.season_invalid");
    }

    #[test]
    fn assert_score_window_open_refuses_live_after_ends_at() {
        let live = season("s1", SeasonStatus::Live);
        let e = assert_score_window_open(&live, t("2026-09-01T00:00:00.000Z")).unwrap_err();
        assert_eq!(e.code, "academy.season_not_live");
        assert!(e.message.to_lowercase().contains("calendar window"));
        assert!(assert_score_window_open(&live, t("2026-08-15T12:00:00.000Z")).is_ok());
    }

    #[test]
    fn assert_score_window_open_refuses_non_live_inside_calendar() {
        let e = assert_score_window_open(
            &season("s1", SeasonStatus::Frozen),
            t("2026-08-15T12:00:00.000Z"),
        )
        .unwrap_err();
        assert!(e.message.to_lowercase().contains("frozen"));
    }

    /// `season-calendar-route.test.ts`: the router's shape.
    #[test]
    fn route_shape_score_window_open_only_when_live_and_in_window() {
        let mk = |status| SeasonRecord {
            id: "11111111-1111-4111-8111-111111111111".to_owned(),
            slug: "s1".to_owned(),
            title: "Season 1".to_owned(),
            status,
            rules_summary: "rules".to_owned(),
            starts_at: t("2026-08-01T00:00:00Z"),
            ends_at: Some(t("2026-09-01T00:00:00Z")),
            extra: Vec::new(),
        };
        let at = t("2026-08-15T12:00:00Z");
        let live = season_window_at(&mk(SeasonStatus::Live), at).unwrap();
        assert!(live.in_window && live.score_window_open);
        let scheduled = season_window_at(&mk(SeasonStatus::Scheduled), at).unwrap();
        assert!(scheduled.in_window && !scheduled.score_window_open);
        assert_eq!(
            live.to_json().compact(),
            "{\"seasonId\":\"11111111-1111-4111-8111-111111111111\",\"status\":\"live\",\"startsAt\":\"2026-08-01T00:00:00.000Z\",\"endsAt\":\"2026-09-01T00:00:00.000Z\",\"openAt\":\"2026-08-15T12:00:00.000Z\",\"inWindow\":true,\"scoreWindowOpen\":true}"
        );
    }
}
