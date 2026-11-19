//! Tournament ladders, Stage-1 without prize money (`services/svc-academy/src/tournaments`, the tournament half of
//! `academy-service.ts`, and `router.ts`'s "Tournament ladders Stage-1"): seasons, standings, the freeze snapshot, the
//! calendar, the honesty policy and the refused prize plane.
//!
//! [`handle`] is the router: each call's handler in the TypeScript's order, with [`crate::programme::method`] right
//! before each `academy.<method>()` call and the approval consumed first on the four dual-control writes. Each answer
//! is built in its output schema's key order. The pure parts are `ladder`, `lifecycle`, `bulk`, `calendar`, `prize`,
//! `policy` and `limits`; the SQL is `service`.

pub mod bulk;
pub mod calendar;
pub mod ladder;
pub mod lifecycle;
pub mod limits;
pub mod policy;
pub mod prize;
pub mod service;

use service_kit::json::{Json, js_number_string};
use service_kit::schema::Value;
use service_kit::time::Instant;

use crate::access::{ApprovalIds, approval_precheck, payload_hash};
use crate::door::Ctx;
use crate::errors::{AcademyError, Refusal};
use crate::ports::ApprovalConsume;
use crate::programme::method;
use crate::slices::Answer;

use bulk::{BulkInput, ScorePatch, bulk_score_status_line, validate_bulk_score_write};
use calendar::season_window_at;
use ladder::{RankedStanding, SeasonRecord, SeasonStatus, StandingRecord};
use prize::{
    PRIZE_POOL_UNSET_CODE, PrizeIntentKind, StartReason, assert_may_start_prize_season,
    decide_prize_intent, decide_prize_pool_start, is_prize_refuse_closed, prize_refuse_status_line,
};
use service::{BulkOutcome, NoSeam, StoredSnapshot, Tournaments, tournament_enabled, unmapped};

fn iso(ms: i64) -> Json {
    Json::str(Instant(ms).iso())
}

/// `seasonOut` (and `.extend({ confirmOperatorId })`).
fn season_json(s: &SeasonRecord, confirm: Option<&str>) -> Json {
    let mut fields = vec![
        ("id".to_owned(), Json::str(s.id.as_str())),
        ("slug".to_owned(), Json::str(s.slug.as_str())),
        ("title".to_owned(), Json::str(s.title.as_str())),
        ("status".to_owned(), Json::str(s.status.as_str())),
        (
            "rulesSummary".to_owned(),
            Json::str(s.rules_summary.as_str()),
        ),
        ("startsAt".to_owned(), iso(s.starts_at)),
        ("endsAt".to_owned(), s.ends_at.map_or(Json::Null, iso)),
    ];
    if let Some(c) = confirm {
        fields.push(("confirmOperatorId".to_owned(), Json::str(c)));
    }
    Json::Object(fields)
}

/// `standingOut`.
fn ranked_json(r: &RankedStanding) -> Json {
    Json::obj([
        ("seasonId", Json::str(r.season_id.as_str())),
        ("userId", Json::str(r.user_id.as_str())),
        ("score", Json::int(r.score)),
        ("updatedAt", iso(r.updated_at)),
        ("rank", Json::int(i64::try_from(r.rank).unwrap_or(i64::MAX))),
    ])
}

/// `standingOut.omit({ rank: true })` (and `.extend({ confirmOperatorId })`).
fn standing_json(r: &StandingRecord, confirm: Option<&str>) -> Json {
    let mut fields = vec![
        ("seasonId".to_owned(), Json::str(r.season_id.as_str())),
        ("userId".to_owned(), Json::str(r.user_id.as_str())),
        ("score".to_owned(), Json::int(r.score)),
        ("updatedAt".to_owned(), iso(r.updated_at)),
    ];
    if let Some(c) = confirm {
        fields.push(("confirmOperatorId".to_owned(), Json::str(c)));
    }
    Json::Object(fields)
}

/// `freezeSnapshot`'s nullable output.
fn snapshot_json(s: Option<&StoredSnapshot>) -> Json {
    let Some(s) = s else {
        return Json::Null;
    };
    Json::obj([
        ("seasonId", Json::str(s.season_id.as_str())),
        ("frozenAt", iso(s.frozen_at)),
        (
            "standings",
            Json::Array(
                s.standings
                    .iter()
                    .map(|r| {
                        Json::obj([
                            ("rank", Json::int(r.rank)),
                            ("userId", Json::str(r.user_id.as_str())),
                            ("score", Json::int(r.score)),
                            ("updatedAt", Json::str(r.updated_at.as_str())),
                        ])
                    })
                    .collect(),
            ),
        ),
    ])
}

fn text<'v>(input: &'v Value, key: &str) -> &'v str {
    input.get(key).as_str().unwrap_or("")
}

fn status_of(input: &Value) -> Option<SeasonStatus> {
    input.get("status").as_str().and_then(SeasonStatus::parse)
}

fn date_of(input: &Value, key: &str) -> Option<i64> {
    match input.get(key) {
        Value::Date(ms) => *ms,
        _ => None,
    }
}

/// `consumeOperatorApproval`: the identity-issued approval for `action`, consumed once; the display-only confirm id.
fn consume(
    ctx: &Ctx<'_>,
    ids: &ApprovalIds,
    action: &str,
    fields: &[(&str, &str)],
) -> Result<String, Refusal> {
    let consumed = ctx.ports.approvals.consume(&ApprovalConsume {
        approval_id: ids.approval_id.clone(),
        operation_id: ids.operation_id.clone(),
        payload_hash: payload_hash(action, fields),
        target_service: "svc-academy",
        target_id: action.to_owned(),
        expected_version: "1",
    })?;
    Ok(consumed.approver_id.unwrap_or(consumed.requester_id))
}

/// The approval ids the door checked, or this call's own check where the door's table does not gate it.
fn approval_ids(ctx: &Ctx<'_>) -> Result<ApprovalIds, Refusal> {
    match &ctx.approval {
        Some(ids) => Ok(ids.clone()),
        None => approval_precheck(ctx.principal, &ctx.input),
    }
}

/// The patches as zod returned them: `{ userId, score }`, each a guid and an integer.
fn patches_of(input: &Value) -> Vec<ScorePatch> {
    input
        .get("patches")
        .as_array()
        .unwrap_or_default()
        .iter()
        .map(|p| {
            ScorePatch::new(
                text(p, "userId"),
                p.get("score").as_number().unwrap_or(f64::NAN),
            )
        })
        .collect()
}

/// `JSON.stringify(input.patches)`.
fn patches_text(patches: &[ScorePatch]) -> String {
    Json::Array(
        patches
            .iter()
            .map(|p| {
                Json::obj([
                    ("userId", Json::str(p.user_id.as_str())),
                    ("score", Json::Number(p.score)),
                ])
            })
            .collect(),
    )
    .compact()
}

/// `tournamentPrizePlane`.
fn prize_plane() -> Answer {
    let mut intents = Vec::new();
    for kind in PrizeIntentKind::ALL {
        let d = decide_prize_intent(kind);
        if !is_prize_refuse_closed(&d) {
            return Err(AcademyError::new(
                "Prize plane must stay refuse-closed",
                "academy.season_invalid",
            )
            .into());
        }
        intents.push(Json::obj([
            ("kind", Json::str(d.kind.as_str())),
            ("status", Json::str("refuse")),
            ("code", Json::str(d.code)),
        ]));
    }
    let blank = decide_prize_pool_start(&Value::Null);
    if blank.code != PRIZE_POOL_UNSET_CODE || blank.reason != StartReason::Unset {
        return Err(AcademyError::new(
            "Blank prize start must stay prize_pool_unset",
            "academy.season_invalid",
        )
        .into());
    }
    Ok(Some(Json::obj([
        ("prizesEnabled", Json::Bool(false)),
        ("ledgerRecipeReady", Json::Bool(false)),
        ("academyHoldsPrizeBalance", Json::Bool(false)),
        ("inventIfc", Json::Bool(false)),
        ("statusLine", Json::str(prize_refuse_status_line())),
        (
            "blankStart",
            Json::obj([
                ("status", Json::str("refuse")),
                ("code", Json::str(PRIZE_POOL_UNSET_CODE)),
                ("reason", Json::str("unset")),
            ]),
        ),
        ("intents", Json::Array(intents)),
    ])))
}

/// `tournamentPrizeIntent`: always the closed refuse, as data.
fn prize_intent(input: &Value) -> Answer {
    let kind = PrizeIntentKind::parse(text(input, "kind")).unwrap_or(PrizeIntentKind::FundPool);
    let d = decide_prize_intent(kind);
    Ok(Some(Json::obj([
        ("ok", Json::Bool(false)),
        ("status", Json::str("refuse")),
        ("code", Json::str(d.code)),
        ("kind", Json::str(d.kind.as_str())),
        ("message", Json::str(d.message)),
        ("academyHoldsPrizeBalance", Json::Bool(false)),
        ("ledgerRecipeReady", Json::Bool(false)),
    ])))
}

pub fn handle(ctx: &Ctx<'_>) -> Answer {
    let t = Tournaments {
        store: ctx.store,
        enabled: tournament_enabled(ctx.settings),
        seam: &NoSeam,
        now: ctx.now,
    };
    let input = &ctx.input;
    match ctx.call.path {
        "seasons" => {
            method(ctx)?;
            let seasons = t.list_seasons(status_of(input), input.get("limit").as_number())?;
            Ok(Some(Json::Array(
                seasons.iter().map(|s| season_json(s, None)).collect(),
            )))
        }
        "season" => {
            method(ctx)?;
            Ok(Some(season_json(&t.season(text(input, "seasonId"))?, None)))
        }
        "seasonCalendar" => {
            method(ctx)?;
            let season = t.season(text(input, "seasonId"))?;
            let at = date_of(input, "at").unwrap_or(ctx.now.0);
            Ok(Some(
                season_window_at(&season, at).map_err(unmapped)?.to_json(),
            ))
        }
        "tournaments.policy" => Ok(Some(policy::describe_tournament_policy())),
        "standings" => {
            method(ctx)?;
            let rows = t.standings(text(input, "seasonId"), input.get("limit").as_number())?;
            Ok(Some(Json::Array(rows.iter().map(ranked_json).collect())))
        }
        "createSeason" => {
            let ids = approval_ids(ctx)?;
            let (slug, title) = (text(input, "slug"), text(input, "title"));
            let confirm = consume(
                ctx,
                &ids,
                "academy.season.create",
                &[("slug", slug), ("title", title)],
            )?;
            method(ctx)?;
            let record = t.create_season(
                slug,
                title,
                text(input, "rulesSummary"),
                date_of(input, "startsAt").unwrap_or(0),
                date_of(input, "endsAt"),
            )?;
            Ok(Some(season_json(&record, Some(&confirm))))
        }
        "setSeasonStatus" => {
            let ids = approval_ids(ctx)?;
            let (season_id, status) = (text(input, "seasonId"), text(input, "status"));
            let confirm = consume(
                ctx,
                &ids,
                "academy.season.setStatus",
                &[("seasonId", season_id), ("status", status)],
            )?;
            method(ctx)?;
            let status = SeasonStatus::parse(status).ok_or_else(|| {
                Refusal::from(AcademyError::new(
                    format!("Cannot move season to {status}"),
                    "academy.season_invalid",
                ))
            })?;
            let record = t.set_season_status(season_id, status)?;
            Ok(Some(season_json(&record, Some(&confirm))))
        }
        "freezeSnapshot" => {
            method(ctx)?;
            let snapshot = t.freeze_snapshot(text(input, "seasonId"))?;
            Ok(Some(snapshot_json(snapshot.as_ref())))
        }
        "tournamentPrizePlane" => prize_plane(),
        "tournamentPrizeIntent" => prize_intent(input),
        "tournamentPrizeStart" => {
            let e = assert_may_start_prize_season(input.get("prizePool"));
            Err(Refusal::Precondition {
                message: e.message.to_owned(),
                code: e.code.to_owned(),
            })
        }
        "setStanding" => {
            let ids = approval_ids(ctx)?;
            let (season_id, user_id) = (text(input, "seasonId"), text(input, "userId"));
            let score = input.get("score").as_number().unwrap_or(f64::NAN);
            let score_text = js_number_string(score);
            let confirm = consume(
                ctx,
                &ids,
                "academy.standing.set",
                &[
                    ("seasonId", season_id),
                    ("userId", user_id),
                    ("score", &score_text),
                ],
            )?;
            method(ctx)?;
            let record = t.set_standing(season_id, user_id, score)?;
            Ok(Some(standing_json(&record, Some(&confirm))))
        }
        "bulkSetStandings" => {
            let ids = approval_ids(ctx)?;
            let season_id = text(input, "seasonId");
            let patches = patches_of(input);
            let confirm = consume(
                ctx,
                &ids,
                "academy.standing.bulk",
                &[
                    ("seasonId", season_id),
                    ("patches", &patches_text(&patches)),
                ],
            )?;
            method(ctx)?;
            match t.bulk_set_standings(season_id, &patches)? {
                BulkOutcome::Refused {
                    reason,
                    message,
                    bad_user_id,
                } => {
                    let mut fields = vec![
                        ("ok".to_owned(), Json::Bool(false)),
                        ("reason".to_owned(), Json::str(reason)),
                        ("message".to_owned(), Json::str(message)),
                        (
                            "statusLine".to_owned(),
                            Json::str(format!("ok=0 accepted=0 refused=1 reason={reason}")),
                        ),
                    ];
                    if let Some(bad) = bad_user_id {
                        fields.push(("badUserId".to_owned(), Json::str(bad)));
                    }
                    fields.push(("confirmOperatorId".to_owned(), Json::str(confirm)));
                    Ok(Some(Json::Object(fields)))
                }
                BulkOutcome::Ok {
                    accepted,
                    standings,
                } => {
                    let line = bulk_score_status_line(&validate_bulk_score_write(
                        &BulkInput::status_only(SeasonStatus::Live, season_id, &patches),
                    ));
                    Ok(Some(Json::obj([
                        ("ok", Json::Bool(true)),
                        (
                            "accepted",
                            Json::int(i64::try_from(accepted).unwrap_or(i64::MAX)),
                        ),
                        ("statusLine", Json::str(line)),
                        (
                            "standings",
                            Json::Array(standings.iter().map(|s| standing_json(s, None)).collect()),
                        ),
                        ("confirmOperatorId", Json::str(confirm)),
                    ])))
                }
            }
        }
        _ => crate::slices::not_ported(ctx),
    }
}
