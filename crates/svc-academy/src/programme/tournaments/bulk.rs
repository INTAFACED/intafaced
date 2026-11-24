//! Bulk score write validation, without money (`tournaments/bulk-score.ts`). An operator may stage many score
//! updates; the pure gate refuses an invalid row without inventing a score. The season must be live for any write.

use service_kit::s2s::js_length;
use service_kit::schema::js_trim;

use super::calendar::assert_score_window_open;
use super::ladder::{
    SeasonRecord, SeasonStatus, StandingRecord, assert_may_write_score, assert_score, js_num,
};

/// `ScorePatch`. The score is the JS number the caller sent.
#[derive(Debug, Clone, PartialEq)]
pub struct ScorePatch {
    pub user_id: String,
    pub score: f64,
}

impl ScorePatch {
    pub fn new(user_id: &str, score: f64) -> ScorePatch {
        ScorePatch {
            user_id: user_id.to_owned(),
            score,
        }
    }
}

/// `BulkScoreRefuse['reason']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefuseReason {
    SeasonNotLive,
    Empty,
    InvalidRow,
    DuplicateUser,
}

impl RefuseReason {
    pub fn as_str(self) -> &'static str {
        match self {
            RefuseReason::SeasonNotLive => "season_not_live",
            RefuseReason::Empty => "empty",
            RefuseReason::InvalidRow => "invalid_row",
            RefuseReason::DuplicateUser => "duplicate_user",
        }
    }
}

/// `BulkScoreResult`.
#[derive(Debug, Clone, PartialEq)]
pub enum BulkScoreResult {
    Ok {
        patches: Vec<ScorePatch>,
    },
    Refuse {
        reason: RefuseReason,
        message: String,
        bad_user_id: Option<String>,
    },
}

/// `validateBulkScoreWrite`'s input. With `starts_at` set, the calendar window is enforced as a single write's is.
#[derive(Debug, Clone, PartialEq)]
pub struct BulkInput<'a> {
    pub season_status: SeasonStatus,
    pub season_id: &'a str,
    pub patches: &'a [ScorePatch],
    pub starts_at: Option<i64>,
    pub ends_at: Option<i64>,
    /// `now ?? new Date()`: the caller's clock.
    pub now: i64,
}

impl<'a> BulkInput<'a> {
    /// No calendar bounds.
    pub fn status_only(
        season_status: SeasonStatus,
        season_id: &'a str,
        patches: &'a [ScorePatch],
    ) -> BulkInput<'a> {
        BulkInput {
            season_status,
            season_id,
            patches,
            starts_at: None,
            ends_at: None,
            now: 0,
        }
    }
}

fn refuse(
    reason: RefuseReason,
    message: impl Into<String>,
    bad: Option<String>,
) -> BulkScoreResult {
    BulkScoreResult::Refuse {
        reason,
        message: message.into(),
        bad_user_id: bad,
    }
}

/// `validateBulkScoreWrite`: writes nothing; the caller applies an ok result.
pub fn validate_bulk_score_write(input: &BulkInput<'_>) -> BulkScoreResult {
    if let Err(e) = assert_may_write_score(input.season_status) {
        return refuse(RefuseReason::SeasonNotLive, e.message, None);
    }
    if let Some(starts_at) = input.starts_at {
        let season = SeasonRecord {
            id: input.season_id.to_owned(),
            slug: "bulk-gate".to_owned(),
            title: "bulk-gate".to_owned(),
            status: input.season_status,
            rules_summary: String::new(),
            starts_at,
            ends_at: input.ends_at,
            extra: Vec::new(),
        };
        if let Err(e) = assert_score_window_open(&season, input.now) {
            return refuse(RefuseReason::SeasonNotLive, e.message, None);
        }
    }
    if input.patches.is_empty() {
        return refuse(
            RefuseReason::Empty,
            "No score patches — refuse invent empty bulk write",
            None,
        );
    }
    let mut seen: Vec<&str> = Vec::new();
    let mut out = Vec::new();
    for p in input.patches {
        let user_id = js_trim(&p.user_id);
        if user_id.is_empty() || js_length(user_id) > 64 {
            return refuse(
                RefuseReason::InvalidRow,
                "userId required (1–64)",
                Some(p.user_id.clone()),
            );
        }
        if seen.contains(&user_id) {
            return refuse(
                RefuseReason::DuplicateUser,
                format!("Duplicate userId {user_id}"),
                Some(user_id.to_owned()),
            );
        }
        if let Err(e) = assert_score(p.score) {
            return refuse(
                RefuseReason::InvalidRow,
                e.message,
                Some(user_id.to_owned()),
            );
        }
        seen.push(user_id);
        out.push(ScorePatch::new(user_id, p.score));
    }
    BulkScoreResult::Ok { patches: out }
}

/// `applyBulkScorePatches`: a pure merge, in `Map` order (existing rows of the season first, new users after).
pub fn apply_bulk_score_patches(
    season_id: &str,
    existing: &[StandingRecord],
    patches: &[ScorePatch],
    now: i64,
) -> Result<Vec<StandingRecord>, super::ladder::TournamentError> {
    let mut by_user: Vec<StandingRecord> = Vec::new();
    for r in existing.iter().filter(|r| r.season_id == season_id) {
        match by_user.iter_mut().find(|x| x.user_id == r.user_id) {
            Some(slot) => *slot = r.clone(),
            None => by_user.push(r.clone()),
        }
    }
    for p in patches {
        let row = StandingRecord {
            season_id: season_id.to_owned(),
            user_id: p.user_id.clone(),
            score: assert_score(p.score)?,
            updated_at: now,
        };
        match by_user.iter_mut().find(|x| x.user_id == p.user_id) {
            Some(slot) => *slot = row,
            None => by_user.push(row),
        }
    }
    Ok(by_user)
}

/// `BulkScoreSummary`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BulkScoreSummary {
    pub accepted: usize,
    pub refused: bool,
    pub reason: Option<&'static str>,
}

/// `summarizeBulkScoreResult`.
pub fn summarize_bulk_score_result(r: &BulkScoreResult) -> BulkScoreSummary {
    BulkScoreSummary {
        accepted: bulk_accepted_count(r),
        refused: is_bulk_score_refused(r),
        reason: bulk_refuse_reason(r),
    }
}

/// `isBulkScoreOk`.
pub fn is_bulk_score_ok(r: &BulkScoreResult) -> bool {
    matches!(r, BulkScoreResult::Ok { .. })
}

/// `bulkAcceptedCount`.
pub fn bulk_accepted_count(r: &BulkScoreResult) -> usize {
    match r {
        BulkScoreResult::Ok { patches } => patches.len(),
        BulkScoreResult::Refuse { .. } => 0,
    }
}

/// `bulkRefuseReason`.
pub fn bulk_refuse_reason(r: &BulkScoreResult) -> Option<&'static str> {
    match r {
        BulkScoreResult::Ok { .. } => None,
        BulkScoreResult::Refuse { reason, .. } => Some(reason.as_str()),
    }
}

/// `isBulkScoreRefused`.
pub fn is_bulk_score_refused(r: &BulkScoreResult) -> bool {
    !is_bulk_score_ok(r)
}

/// `bulkAcceptedCountLabel`.
pub fn bulk_accepted_count_label(r: &BulkScoreResult) -> String {
    bulk_accepted_count(r).to_string()
}

/// `bulkRefuseReasonLabel`.
pub fn bulk_refuse_reason_label(r: &BulkScoreResult) -> String {
    bulk_refuse_reason(r).unwrap_or_default().to_owned()
}

/// `isBulkScoreEmptyOk`.
pub fn is_bulk_score_empty_ok(r: &BulkScoreResult) -> bool {
    is_bulk_score_ok(r) && bulk_accepted_count(r) == 0
}

/// `bulkScoreBoardCard`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BulkBoardCard {
    pub ok: bool,
    pub accepted: usize,
    pub refused: bool,
    pub reason: Option<&'static str>,
    pub empty_ok: bool,
    pub accepted_label: String,
    pub reason_label: String,
}

pub fn bulk_score_board_card(r: &BulkScoreResult) -> BulkBoardCard {
    BulkBoardCard {
        ok: is_bulk_score_ok(r),
        accepted: bulk_accepted_count(r),
        refused: is_bulk_score_refused(r),
        reason: bulk_refuse_reason(r),
        empty_ok: is_bulk_score_empty_ok(r),
        accepted_label: bulk_accepted_count_label(r),
        reason_label: bulk_refuse_reason_label(r),
    }
}

/// `bulkScoreExportHeader`.
pub fn bulk_score_export_header() -> &'static str {
    "status,accepted,reason"
}

/// `bulkScoreExportLine`.
pub fn bulk_score_export_line(r: &BulkScoreResult) -> String {
    let c = bulk_score_board_card(r);
    format!(
        "{},{},{}",
        if c.ok { "ok" } else { "refuse" },
        c.accepted,
        c.reason.unwrap_or_default()
    )
}

/// `bulkScoreExportText`.
pub fn bulk_score_export_text(r: &BulkScoreResult) -> String {
    [
        bulk_score_export_header().to_owned(),
        bulk_score_export_line(r),
    ]
    .join("\n")
}

/// A parsed `status,accepted,reason` line.
#[derive(Debug, Clone, PartialEq)]
pub struct BulkExportLine {
    pub status: String,
    pub accepted: f64,
    pub reason: String,
}

/// `parseBulkScoreExportLine`.
pub fn parse_bulk_score_export_line(line: &str) -> Option<BulkExportLine> {
    let t = js_trim(line);
    if t.is_empty() || t == bulk_score_export_header() {
        return None;
    }
    let parts: Vec<&str> = t.split(',').collect();
    let (status, accepted) = (js_trim(parts.first()?), js_num(parts.get(1)?));
    let reason = parts.get(2..).unwrap_or_default().join(",");
    if status != "ok" && status != "refuse" {
        return None;
    }
    if !accepted.is_finite() || accepted < 0.0 {
        return None;
    }
    Some(BulkExportLine {
        status: status.to_owned(),
        accepted: accepted.floor(),
        reason: js_trim(&reason).to_owned(),
    })
}

/// `bulkScoreStatusLine`.
pub fn bulk_score_status_line(r: &BulkScoreResult) -> String {
    let c = bulk_score_board_card(r);
    format!(
        "ok={} accepted={} refused={}",
        if c.ok { "1" } else { "0" },
        c.accepted,
        if c.refused { "1" } else { "0" }
    )
}

/// `bulkScoreStatusLineIsEmptyOk`.
pub fn bulk_score_status_line_is_empty_ok(r: &BulkScoreResult) -> bool {
    is_bulk_score_empty_ok(r)
}

/// A parsed status line.
#[derive(Debug, Clone, PartialEq)]
pub struct BulkStatus {
    pub ok: bool,
    pub accepted: f64,
    pub refused: bool,
}

/// `parseBulkScoreStatusLine`: `^ok=([01]) accepted=(\d+) refused=([01])$`.
pub fn parse_bulk_score_status_line(line: &str) -> Option<BulkStatus> {
    let v = super::ladder::match_fields(line, &["ok", "accepted", "refused"])?;
    let [ok, accepted, refused] = v.as_slice() else {
        return None;
    };
    let bit = |s: &str| (s == "0" || s == "1").then_some(s == "1");
    if !super::ladder::is_digits(accepted) {
        return None;
    }
    Some(BulkStatus {
        ok: bit(ok)?,
        accepted: js_num(accepted),
        refused: bit(refused)?,
    })
}

/// `bulkScoreStatusLineMatches`.
pub fn bulk_score_status_line_matches(r: &BulkScoreResult) -> bool {
    let Some(p) = parse_bulk_score_status_line(&bulk_score_status_line(r)) else {
        return false;
    };
    let c = bulk_score_board_card(r);
    #[expect(clippy::cast_precision_loss, reason = "a patch count, at most 500")]
    let accepted = c.accepted as f64;
    p.ok == c.ok && p.accepted == accepted && p.refused == c.refused
}

#[expect(clippy::cast_precision_loss, reason = "a patch count, at most 500")]
fn accepted_f(r: &BulkScoreResult) -> f64 {
    bulk_accepted_count(r) as f64
}

/// `bulkAcceptedInRange`.
pub fn bulk_accepted_in_range(r: &BulkScoreResult, min: f64, max: f64) -> bool {
    if !min.is_finite() || !max.is_finite() || min > max {
        return false;
    }
    let n = accepted_f(r);
    n >= min && n <= max
}

/// `bulkAcceptedAtLeast`.
pub fn bulk_accepted_at_least(r: &BulkScoreResult, n: f64) -> bool {
    n.is_finite() && accepted_f(r) >= n
}

/// `countBulkScoreExportDataLines`.
pub fn count_bulk_score_export_data_lines(text: &str) -> usize {
    text.split('\n')
        .map(js_trim)
        .filter(|l| !l.is_empty() && *l != bulk_score_export_header())
        .count()
}

/// `bulkScoreExportHasHeader`.
pub fn bulk_score_export_has_header(text: &str) -> bool {
    js_trim(text.split('\n').next().unwrap_or("")) == bulk_score_export_header()
}

/// `bulkScoreExportRoundTripOk`.
pub fn bulk_score_export_round_trip_ok(r: &BulkScoreResult) -> bool {
    let text = bulk_score_export_text(r);
    text.split('\n').filter(|l| !l.is_empty()).count()
        == 1 + count_bulk_score_export_data_lines(&text)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "tests")]
mod tests {
    //! `tournaments/bulk-score.test.ts`, assertion for assertion.
    use super::*;
    use service_kit::time::js_date;

    fn t(s: &str) -> i64 {
        js_date(s).unwrap().0
    }

    fn one(user: &str, score: f64) -> Vec<ScorePatch> {
        vec![ScorePatch::new(user, score)]
    }

    fn refused_not_live() -> BulkScoreResult {
        BulkScoreResult::Refuse {
            reason: RefuseReason::SeasonNotLive,
            message: "x".to_owned(),
            bad_user_id: None,
        }
    }

    #[test]
    fn refuses_non_live_season_and_empty_patches() {
        let p = one("u", 1.0);
        assert!(is_bulk_score_refused(&validate_bulk_score_write(
            &BulkInput::status_only(SeasonStatus::Frozen, "s1", &p)
        )));
        assert!(is_bulk_score_refused(&validate_bulk_score_write(
            &BulkInput::status_only(SeasonStatus::Live, "s1", &[])
        )));
    }

    #[test]
    fn refuses_live_season_after_ends_at_when_calendar_bounds_given() {
        let p = one("u", 10.0);
        let gate = |now: &str| {
            validate_bulk_score_write(&BulkInput {
                season_status: SeasonStatus::Live,
                season_id: "s1",
                patches: &p,
                starts_at: Some(t("2026-08-01T00:00:00.000Z")),
                ends_at: Some(t("2026-08-31T00:00:00.000Z")),
                now: t(now),
            })
        };
        let BulkScoreResult::Refuse {
            reason, message, ..
        } = gate("2026-09-01T00:00:00.000Z")
        else {
            panic!("expected a refusal");
        };
        assert_eq!(reason, RefuseReason::SeasonNotLive);
        assert!(message.to_lowercase().contains("calendar window"));
        assert!(is_bulk_score_ok(&gate("2026-08-15T00:00:00.000Z")));
    }

    #[test]
    fn refuses_duplicate_user_and_bad_score() {
        let dup = vec![ScorePatch::new("u1", 1.0), ScorePatch::new("u1", 2.0)];
        let r = validate_bulk_score_write(&BulkInput::status_only(SeasonStatus::Live, "s1", &dup));
        assert_eq!(bulk_refuse_reason(&r), Some("duplicate_user"));
        let bad = one("u1", -1.0);
        let r = validate_bulk_score_write(&BulkInput::status_only(SeasonStatus::Live, "s1", &bad));
        assert_eq!(bulk_refuse_reason(&r), Some("invalid_row"));
    }

    #[test]
    fn applies_validated_patches_without_invent_scores() {
        let p = vec![ScorePatch::new("a", 10.0), ScorePatch::new("b", 20.0)];
        let v = validate_bulk_score_write(&BulkInput::status_only(SeasonStatus::Live, "s1", &p));
        let BulkScoreResult::Ok { patches } = &v else {
            panic!("expected ok");
        };
        let rows =
            apply_bulk_score_patches("s1", &[], patches, t("2026-08-05T00:00:00.000Z")).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows.iter().find(|r| r.user_id == "b").unwrap().score, 20);
        assert_eq!(
            summarize_bulk_score_result(&v),
            BulkScoreSummary {
                accepted: 2,
                refused: false,
                reason: None
            }
        );
        assert!(is_bulk_score_ok(&v));
        let u = one("u", 1.0);
        let refused =
            validate_bulk_score_write(&BulkInput::status_only(SeasonStatus::Frozen, "s1", &u));
        assert_eq!(
            summarize_bulk_score_result(&refused),
            BulkScoreSummary {
                accepted: 0,
                refused: true,
                reason: Some("season_not_live")
            }
        );
        assert!(!is_bulk_score_ok(&refused));
    }

    #[test]
    fn accepted_count_and_refuse_reason_without_invent() {
        let a = one("a", 1.0);
        let bad =
            validate_bulk_score_write(&BulkInput::status_only(SeasonStatus::Frozen, "s1", &a));
        assert_eq!(bulk_accepted_count(&bad), 0);
        assert!(bulk_refuse_reason(&bad).is_some());
        let p = vec![ScorePatch::new("a", 1.0), ScorePatch::new("b", 2.0)];
        let ok = validate_bulk_score_write(&BulkInput::status_only(SeasonStatus::Live, "s1", &p));
        assert_eq!(bulk_accepted_count(&ok), 2);
        assert_eq!(bulk_refuse_reason(&ok), None);
    }

    #[test]
    fn wave35_labels_and_empty_ok() {
        let refused = refused_not_live();
        assert!(is_bulk_score_refused(&refused));
        assert_eq!(bulk_refuse_reason_label(&refused), "season_not_live");
        assert_eq!(bulk_accepted_count_label(&refused), "0");
        let empty_ok = BulkScoreResult::Ok { patches: vec![] };
        assert!(is_bulk_score_empty_ok(&empty_ok));
        assert!(!is_bulk_score_refused(&empty_ok));
    }

    #[test]
    fn wave43_board_and_export_parse() {
        let refused = refused_not_live();
        let card = bulk_score_board_card(&refused);
        assert!(!card.ok);
        assert_eq!(card.reason, Some("season_not_live"));
        assert_eq!(bulk_score_export_header(), "status,accepted,reason");
        assert_eq!(bulk_score_export_line(&refused), "refuse,0,season_not_live");
        assert_eq!(
            parse_bulk_score_export_line("ok,2,"),
            Some(BulkExportLine {
                status: "ok".to_owned(),
                accepted: 2.0,
                reason: String::new()
            })
        );
        assert_eq!(parse_bulk_score_export_line("status,accepted,reason"), None);
        assert!(bulk_score_export_text(&refused).contains("refuse"));
    }

    #[test]
    fn wave47_status_and_round_trip_on_ok() {
        let p = one("u1", 10.0);
        let ok = validate_bulk_score_write(&BulkInput::status_only(SeasonStatus::Live, "s1", &p));
        assert!(is_bulk_score_ok(&ok));
        let line = bulk_score_status_line(&ok);
        assert!(line.starts_with("ok=1 accepted=") && line.ends_with(" refused=0"));
        assert!(parse_bulk_score_status_line(&line).is_some());
        assert!(bulk_score_status_line_matches(&ok));
        assert_eq!(parse_bulk_score_status_line("nope"), None);
        let text = bulk_score_export_text(&ok);
        assert!(bulk_score_export_has_header(&text));
        assert_eq!(count_bulk_score_export_data_lines(&text), 1);
        assert!(bulk_score_export_round_trip_ok(&ok));
        assert!(bulk_accepted_in_range(&ok, 0.0, 10.0));
        assert!(!bulk_accepted_in_range(&ok, 10.0, 0.0));
        assert!(bulk_accepted_at_least(&ok, 1.0));
    }

    #[test]
    fn wave47_empty_refuse_status() {
        let refused =
            validate_bulk_score_write(&BulkInput::status_only(SeasonStatus::Live, "s1", &[]));
        assert!(is_bulk_score_refused(&refused));
        assert!(bulk_score_status_line_matches(&refused));
        assert!(bulk_score_status_line(&refused).contains("refused=1"));
    }
}
