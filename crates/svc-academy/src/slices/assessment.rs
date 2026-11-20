//! The assessment slice: the calls the door table gives `Slice::Assessment`, answered as `router.ts`,
//! `curriculum/grade-reports-router.ts` and `learners/learner-desk-router.ts` answer them.
//!
//! Every call goes into `AcademyService`, so a refusing service refuses first ([`enter`]). The two learner-desk changes
//! name their actor (`changer(ctx)`: the session holds `admin:write`) before they call the service, so that check comes
//! first there. Each module takes the store and asks it for the pool only at its first query, so an owner value or an
//! input check the TypeScript makes before its first query answers the same whatever the database does.

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::time::js_date;

use crate::assessment::assignments::{self, BriefInput, Files};
use crate::assessment::grading::{self, GradeInput};
use crate::assessment::peer::{self, StepsInput};
use crate::assessment::{
    analytics, extensions, gradebook, legacy, quizzes, reports, setting_int, storage, trail,
    with_client,
};
use crate::db::Store;
use crate::door::Ctx;
use crate::errors::{AcademyError, Refusal};
use crate::slices::{Answer, not_ported};

/// A call into `AcademyService`: a service that refuses every method refuses here, before anything else runs.
fn enter(ctx: &Ctx<'_>) -> Result<(), Refusal> {
    match ctx.store {
        Store::Refuses(r) => Err(r.clone()),
        _ => Ok(()),
    }
}

/// `changer(ctx)`: the actor of a learner-desk change, refused by name when the session may only read.
fn changer<'a>(ctx: &Ctx<'a>) -> Result<&'a str, Refusal> {
    match ctx.principal {
        Some(p) if p.scopes.iter().any(|s| s == "admin:write") => Ok(p.user_id.as_str()),
        _ => Err(AcademyError::new(
            "academy.permission_denied this session may read a learner but not change one (admin:write)",
            "academy.permission_denied",
        )
        .into()),
    }
}

fn text<'a>(input: &'a Value, key: &str) -> &'a str {
    input.get(key).as_str().unwrap_or("")
}

/// A nullable string field.
fn opt_text<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).as_str()
}

/// An integer field (the schemas hold every one to `.int()`).
fn int(input: &Value, key: &str) -> i64 {
    #[expect(
        clippy::cast_possible_truncation,
        reason = "the schema holds the number to a safe integer"
    )]
    input.get(key).as_number().map_or(0, |n| n as i64)
}

fn json(input: &Value, key: &str) -> Json {
    input.get(key).to_json().unwrap_or(Json::Null)
}

fn list(input: &Value, key: &str) -> Vec<Json> {
    match json(input, key) {
        Json::Array(items) => items,
        _ => Vec::new(),
    }
}

/// `new Date(input.<key>)` of an ISO instant, as epoch milliseconds.
fn instant(input: &Value, key: &str) -> Option<i64> {
    match input.get(key) {
        Value::Date(at) => *at,
        Value::String(s) => js_date(s).map(|i| i.0),
        _ => None,
    }
}

/// An instant the schema already checked, as the `Date` the TypeScript passes on.
fn required_instant(input: &Value, key: &str) -> Result<i64, Refusal> {
    instant(input, key).ok_or_else(|| Refusal::Internal {
        message: "Invalid time value".to_owned(),
        code: None,
    })
}

/// An ISO instant as the text a `$n::text::timestamptz` parameter takes.
fn instant_text(input: &Value, key: &str) -> Option<String> {
    instant(input, key).map(crate::assessment::iso)
}

/// The course files: the owner's upload limits, the object store and its byte port.
fn files<'a>(ctx: &Ctx<'a>) -> Files<'a> {
    let types = match ctx.settings.0.get("ACADEMY_UPLOAD_HANDOUT_TYPES") {
        Some(Json::Array(items)) => Some(
            items
                .iter()
                .filter_map(|t| match t {
                    Json::String(s) => Some(s.clone()),
                    _ => None,
                })
                .collect(),
        ),
        _ => None,
    };
    Files {
        storage: storage::from_settings(ctx.settings),
        max_bytes: setting_int(ctx.settings, "ACADEMY_UPLOAD_MAX_BYTES"),
        types,
        bytes: ctx.ports.object_bytes.as_ref(),
    }
}

pub fn handle(ctx: &Ctx<'_>) -> Answer {
    let input = &ctx.input;
    let store = ctx.store;
    let now = ctx.now.0;
    let user = ctx.user_id();
    let item = text(input, "itemId");
    let lease = || setting_int(ctx.settings, "ACADEMY_GRADER_LEASE_SECONDS");

    // The learner desk names its actor before it reaches the service.
    let actor = match ctx.call.path {
        "admin.voidQuizAttempt" | "admin.grantLearnerExtension" => Some(changer(ctx)?),
        _ => None,
    };
    enter(ctx)?;

    let out = match ctx.call.path {
        // ── Course quizzes and surveys (`curriculum/course-quizzes.ts`) ──
        "admin.courseQuiz" => quizzes::admin_view(store, item)?,
        "admin.saveCourseQuiz" => {
            quizzes::save(store, &input.to_json().unwrap_or(Json::Null), user, now)?
        }
        "admin.setCourseQuizState" => quizzes::set_state(
            store,
            item,
            text(input, "state"),
            text(input, "reason"),
            user,
            now,
        )?,
        "admin.courseQuizReviews" => quizzes::reviews(store, item)?,
        "admin.scoreCourseQuizEssays" => quizzes::score_essays(
            store,
            item,
            text(input, "attemptId"),
            &json(input, "points"),
            user,
            now,
        )?,
        "courseQuiz" => quizzes::learner_view(store, item, user, now)?,
        "startCourseQuiz" => quizzes::start(
            store,
            item,
            user,
            opt_text(input, "accessCode"),
            ctx.quiz_client_address.as_deref(),
            now,
        )?,
        "courseQuizAttempt" => quizzes::current(store, item, user, now)?,
        "answerCourseQuiz" => quizzes::answer(
            store,
            text(input, "attemptId"),
            user,
            text(input, "questionId"),
            &json(input, "answer"),
            now,
        )?,
        "finishCourseQuiz" => quizzes::finish(store, text(input, "attemptId"), user, now)?,
        "submitCourseSurvey" => quizzes::submit_survey(
            store,
            item,
            user,
            text(input, "clientToken"),
            &json(input, "answers"),
            now,
        )?,

        // ── The score trail and analytics (`course-quiz-trail.ts`, `course-quiz-analytics.ts`) ──
        "admin.courseQuizAttempts" => trail::attempts(store, item)?,
        "admin.fixCourseQuizKey" => {
            trail::fix_key(
                store,
                item,
                int(input, "revision"),
                &list(input, "questions"),
                text(input, "reason"),
                user,
                now,
            )?;
            quizzes::admin_view(store, item)?
        }
        "admin.rescoreCourseQuiz" => trail::rescore(store, item, text(input, "reason"), user, now)?,
        "admin.curveCourseQuiz" => trail::curve(
            store,
            setting_int(ctx.settings, "ACADEMY_BULK_FILE_MAX_BYTES"),
            item,
            text(input, "fileName"),
            text(input, "csv"),
            matches!(input.get("dryRun"), Value::Bool(true)),
            text(input, "reason"),
            user,
            now,
        )?,
        "admin.overrideCourseQuizScore" => trail::override_score(
            store,
            item,
            text(input, "attemptId"),
            text(input, "questionId"),
            int(input, "points"),
            int(input, "n"),
            opt_text(input, "comment"),
            text(input, "reason"),
            user,
            now,
        )?,
        "admin.courseQuizAnalytics" => analytics::analytics(store, item)?,
        "admin.courseQuizAnswers" => analytics::answers(store, item)?,

        // ── Assignments, hand-ins, grading and review (`course-assignments.ts`, `assignment-grading.ts`, `peer-reviews.ts`) ──
        "admin.assignment" => assignments::admin_view(store, item)?,
        "admin.saveAssignment" => {
            let due = instant_text(input, "dueAt");
            assignments::save(
                store,
                item,
                int(input, "revision"),
                &BriefInput {
                    instructions: text(input, "instructions"),
                    points: text(input, "points"),
                    due_at: due.as_deref(),
                    text: text(input, "text"),
                    file: text(input, "file"),
                },
                user,
                now,
            )?
        }
        "admin.withdrawAssignment" => {
            assignments::withdraw(store, item, text(input, "reason"), user, now)?
        }
        "assignment" => assignments::learner_view(store, &files(ctx), item, user, now)?,
        "uploadAssignmentFile" => assignments::upload_file(
            store,
            &files(ctx),
            item,
            text(input, "fileName"),
            text(input, "contentType"),
            text(input, "contentBase64"),
            user,
            now,
        )?,
        "submitAssignment" => assignments::submit(
            store,
            &files(ctx),
            item,
            int(input, "version"),
            opt_text(input, "text"),
            opt_text(input, "fileId"),
            user,
            now,
        )?,
        "admin.gradingQueue" => grading::queue(store, lease(), item, user, now)?,
        "admin.openGrading" => {
            grading::open(store, lease(), item, text(input, "submissionId"), user, now)?
        }
        "admin.gradeSubmission" => grading::grade(
            store,
            lease(),
            &GradeInput {
                item_id: item,
                submission_id: text(input, "submissionId"),
                n: int(input, "n"),
                score: text(input, "score"),
                comment: opt_text(input, "comment"),
                reason: opt_text(input, "reason"),
            },
            user,
            now,
        )?,
        "admin.bulkGrade" => grading::bulk_grade(
            store,
            lease(),
            item,
            text(input, "fileName"),
            text(input, "csv"),
            user,
            now,
        )?,
        "markFeedbackRead" => {
            grading::mark_read(
                store,
                item,
                int(input, "version"),
                int(input, "n"),
                user,
                now,
            )?;
            assignments::learner_view(store, &files(ctx), item, user, now)?
        }
        "admin.saveReviewSteps" => {
            let criteria = list(input, "criteria");
            peer::save(
                store,
                &StepsInput {
                    item_id: item,
                    revision: int(input, "revision"),
                    peer: matches!(input.get("peer"), Value::Bool(true)),
                    peer_count: input
                        .get("peerCount")
                        .as_number()
                        .map(|_| int(input, "peerCount")),
                    self_review: matches!(input.get("self"), Value::Bool(true)),
                    criteria: &criteria,
                },
                user,
                now,
            )?;
            assignments::admin_view(store, item)?
        }
        "peerReview" => peer::state(store, item, user, now)?,
        "peerReviewFile" => {
            let config = storage::from_settings(ctx.settings);
            peer::file(
                store,
                config.as_ref(),
                ctx.ports.object_bytes.as_ref(),
                item,
                text(input, "taskId"),
                user,
                now,
            )?
        }
        "submitPeerReview" => {
            let marks: Vec<String> = list(input, "marks")
                .into_iter()
                .filter_map(|m| match m {
                    Json::String(s) => Some(s),
                    _ => None,
                })
                .collect();
            peer::submit(store, item, text(input, "taskId"), &marks, user, now)?
        }

        // ── Due dates (`course-item-rules.ts`, `release/access.ts`, `learners/learner-desk.ts`) ──
        "admin.grantCourseExtension" => extensions::grant_course_extension(
            store,
            text(input, "courseId"),
            item,
            text(input, "userId"),
            required_instant(input, "dueAt")?,
            text(input, "reason"),
            user,
            now,
        )?,
        "admin.grantItemExtension" => extensions::grant_item_extension(
            store,
            text(input, "userId"),
            text(input, "itemSlug"),
            text(input, "reason"),
            required_instant(input, "extendedUntil")?,
            text(input, "clientRequestId"),
            user,
            now,
        )?,
        "admin.grantLearnerExtension" => {
            let granted = extensions::grant_item_extension(
                store,
                text(input, "userId"),
                text(input, "itemSlug"),
                text(input, "reason"),
                required_instant(input, "until")?,
                text(input, "key"),
                actor.unwrap_or(user),
                now,
            )?;
            let revision = granted
                .get("revision")
                .map_or_else(|| "undefined".to_owned(), Json::compact);
            Json::obj([
                ("userId", Json::str(text(input, "userId"))),
                (
                    "done",
                    Json::String(format!(
                        "due date moved for the learner (revision {revision})"
                    )),
                ),
            ])
        }
        "admin.voidQuizAttempt" => {
            extensions::void_attempt(
                store,
                text(input, "userId"),
                text(input, "attemptId"),
                text(input, "reason"),
                actor.unwrap_or(user),
                now,
            )?;
            Json::obj([
                ("userId", Json::str(text(input, "userId"))),
                ("done", Json::str("quiz attempt voided")),
            ])
        }

        // ── The gradebook and its reports (`course-gradebook.ts`, `grade-reports.ts`) ──
        "admin.courseGradebook" => {
            let course = text(input, "courseId");
            // AC-roles-01: reading progress needs `reports` on this course.
            with_client(store, |c| extensions::require_reports(c, user, course))?;
            gradebook::view(store, course)?
        }
        "admin.saveGradingPolicy" => gradebook::save_policy(
            store,
            text(input, "courseId"),
            int(input, "revision"),
            &list(input, "types"),
            text(input, "reason"),
            user,
            now,
        )?,
        "admin.saveLatePolicy" => {
            let policy = input.get("policy");
            let policy = match policy {
                Value::Object(_) => {
                    Some((text(policy, "graceHours"), text(policy, "deductionPerDay")))
                }
                _ => None,
            };
            gradebook::save_late_policy(
                store,
                text(input, "courseId"),
                int(input, "revision"),
                policy,
                text(input, "reason"),
                user,
                now,
            )?
        }
        "admin.courseGradeReports" => reports::list(store, text(input, "courseId"))?,
        "admin.makeGradeReport" => reports::make(
            store,
            setting_int(ctx.settings, "ACADEMY_GRADE_REPORT_ROWS"),
            text(input, "courseId"),
            int(input, "n"),
            user,
            now,
        )?,
        "admin.gradeReportFile" => reports::file(store, text(input, "courseId"), int(input, "n"))?,

        // ── The code-catalogue quizzes on curriculum items (`assessment/repository.ts`) ──
        "assessment.get" => legacy::get(store, legacy::CATALOG, text(input, "slug"))?,
        "assessment.start" => {
            legacy::start(store, legacy::CATALOG, user, text(input, "slug"), now)?
        }
        "assessment.current" => legacy::current(store, user, text(input, "slug"), now)?,
        "assessment.answer" => legacy::answer(
            store,
            user,
            text(input, "attemptId"),
            text(input, "questionId"),
            text(input, "choiceId"),
            now,
        )?,
        "assessment.finish" => legacy::finish(store, user, text(input, "attemptId"), now)?,
        "assessment.review" => legacy::review(store, user, text(input, "attemptId"), now)?,
        "assessment.submit" => {
            let answers: Vec<(String, String)> = match input.get("answers") {
                Value::Array(items) => items
                    .iter()
                    .map(|a| {
                        (
                            text(a, "questionId").to_owned(),
                            text(a, "choiceId").to_owned(),
                        )
                    })
                    .collect(),
                _ => Vec::new(),
            };
            legacy::submit(
                store,
                legacy::CATALOG,
                user,
                text(input, "slug"),
                &answers,
                text(input, "clientAttemptId"),
                now,
            )?
        }
        "assessment.attempts" => {
            legacy::attempts(store, legacy::CATALOG, user, text(input, "slug"), now)?
        }
        "admin.setQuiz" => {
            let quiz = input.get("quiz").to_json();
            legacy::set_quiz(
                store,
                legacy::CATALOG,
                text(input, "slug"),
                quiz.as_ref(),
                text(input, "reason"),
                user,
                now,
            )?
        }
        _ => return not_ported(ctx),
    };
    Ok(Some(out))
}
