//! The learner slice: the calls the door table gives `Slice::Learner`, answered as `router.ts` and
//! `learners/learner-desk-router.ts` answer them: the learner path and its enrolment, My learning and progress, the
//! planner, the video position, Complete and Undo, the courses staff made on the learner side (catalogue, page,
//! private links, enrolment), course purchases and their staff refund, and the learner desk's access records.
//!
//! Each call first meets a service that refuses every method ([`enter`]), except where the TypeScript checks something
//! before it calls the service (`videoProgress.watched` checks the video is on the spine; a learner-desk change checks
//! the session may change a learner). The checks a method makes before its first query run before the store is asked:
//! the learner modules take the store and reach it at their first statement.

use service_kit::json::Json;
use service_kit::schema::Value;

use crate::db::Store;
use crate::door::Ctx;
use crate::errors::{AcademyError, Refusal};
use crate::learner::desk::Desk;
use crate::learner::learners::CourseLearners;
use crate::learner::planner::Planner;
use crate::learner::preview::CoursePreview;
use crate::learner::purchases::{CoursePurchases, Deps};
use crate::learner::service::{Learning, Options, Settle};
use crate::learner::store::Store as Customer;
use crate::learner::video;
use crate::slices::{Answer, not_ported};

/// A call into `AcademyService`: a service that refuses every method refuses here, before anything else runs.
fn enter(ctx: &Ctx<'_>) -> Result<(), Refusal> {
    match ctx.store {
        Store::Refuses(r) => Err(r.clone()),
        _ => Ok(()),
    }
}

fn text<'a>(input: &'a Value, key: &str) -> &'a str {
    input.get(key).as_str().unwrap_or("")
}

fn opt_text<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).as_str()
}

fn number(input: &Value, key: &str) -> Option<f64> {
    input.get(key).as_number()
}

fn flag(input: &Value, key: &str) -> bool {
    input.get(key).truthy()
}

/// A whole-number owner value from the loaded settings, or none while blank.
#[expect(
    clippy::cast_possible_truncation,
    reason = "the environment schema admits only whole numbers in range"
)]
pub fn setting_int(ctx: &Ctx<'_>, key: &str) -> Option<i64> {
    match ctx.settings.0.get(key) {
        Some(Json::Number(n)) if n.is_finite() && n.fract() == 0.0 => Some(*n as i64),
        _ => None,
    }
}

/// `new Date(text)` in epoch milliseconds, for an input the schema already checked as an instant.
fn instant(text: &str) -> Option<i64> {
    service_kit::time::js_date(text).map(|t| t.0)
}

/// `mayChange(ctx)`: the session holds `admin:write`.
fn may_change(ctx: &Ctx<'_>) -> bool {
    ctx.principal
        .is_some_and(|p| p.scopes.iter().any(|s| s == "admin:write"))
}

/// `changer(ctx)`: who changes a learner, or `academy.permission_denied` for a session that may only read.
fn changer<'a>(ctx: &'a Ctx<'_>) -> Result<&'a str, Refusal> {
    if !may_change(ctx) {
        return Err(AcademyError::new(
            "academy.permission_denied this session may read a learner but not change one (admin:write)",
            "academy.permission_denied",
        )
        .into());
    }
    Ok(ctx.user_id())
}

fn tier<'a>(ctx: &'a Ctx<'_>) -> &'a str {
    ctx.principal.map_or("", |p| p.tier.as_str())
}

fn change(user_id: &str, done: &str) -> Json {
    Json::obj([("userId", Json::str(user_id)), ("done", Json::str(done))])
}

pub fn handle(ctx: &Ctx<'_>) -> Answer {
    let input = &ctx.input;
    let now = ctx.now.0;
    let user = ctx.user_id();
    let store = ctx.store;
    // `settleCertificatesNeeding` and `settleProgrammesHolding`, which every completion path calls after it records.
    let certificates_needing = |user_id: &str, slug: &str, at: i64| {
        crate::certs::settle_needing(
            store,
            ctx.ports,
            &ctx.settings.0,
            ctx.certs.clock,
            user_id,
            slug,
            at,
        );
    };
    let programmes_holding = |user_id: &str, slug: &str, at: i64| {
        crate::authoring::programmes::settle_programmes_holding(store, user_id, slug, at);
    };
    let settle = Settle {
        certificates_needing: &certificates_needing,
        programmes_holding: &programmes_holding,
    };
    let video_options = crate::authoring::Options::from_settings(ctx.settings);
    let learning = || Learning {
        pool: store,
        ports: ctx.ports,
        options: Options {
            watch_threshold_seconds: setting_int(ctx, "ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS"),
            video_storage: video_options.storage.as_ref(),
            video_gate: &video_options.gate,
            settle: &settle,
        },
    };
    let purchases = || CoursePurchases {
        pool: store,
        deps: Deps::of(ctx.ports),
    };
    let customer = || Customer { pool: store };
    let preview = || CoursePreview { pool: store };
    let planner = || Planner {
        pool: store,
        todo_limit: setting_int(ctx, "ACADEMY_PLANNER_TODO_LIMIT"),
    };
    let desk = || Desk { pool: store };

    // `requireSpineItem` runs before the service is called.
    if ctx.call.path == "videoProgress.watched" {
        let slug = text(input, "videoSlug");
        video::require_spine_item(slug)?;
        enter(ctx)?;
        let position = customer().video_position(user, slug)?;
        let threshold = crate::authoring::video::require_watch_threshold(setting_int(
            ctx,
            "ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS",
        ))?;
        return Ok(Some(Json::obj([
            ("videoSlug", Json::str(slug)),
            ("positionSeconds", position.map_or(Json::Null, Json::int)),
            ("thresholdSeconds", Json::int(threshold)),
            (
                "watched",
                Json::Bool(position.is_some_and(|p| p >= threshold)),
            ),
        ])));
    }
    // A learner-desk change names its changer before the service is called.
    let operator = match ctx.call.path {
        "admin.markCompleteFor" | "admin.grantAccess" | "admin.reinstateAccess" => {
            // `expiresAt: new Date(..)` is built before `actorId: changer(ctx)`; it cannot fail.
            Some(changer(ctx)?)
        }
        _ => None,
    };
    enter(ctx)?;
    let operator = operator.unwrap_or(user);

    let out = match ctx.call.path {
        // ── The learner path ──
        "courseEnrolment" => learning().course_enrolment(user, text(input, "slug"), now)?,
        "enrolCourse" => {
            learning().enrol_course(user, text(input, "slug"), text(input, "track"), now)?
        }
        "publicCourses" => learning().public_courses()?,
        "publicCourse" => learning().public_course(text(input, "slug"), now)?,
        "myLearning" => learning().my_learning(user, now)?,
        "myAccessGrants" => learning().my_access_grants(user)?,
        "myProgress" => learning().progress_page(user, now)?,
        "learningState" => customer().learning_state(user)?.json(),
        "touchLesson" => customer()
            .touch_lesson(
                user,
                text(input, "slug"),
                number(input, "secondsRead"),
                text(input, "clientRequestId"),
                now,
            )?
            .json(),
        "markCurriculumComplete" => {
            learning().mark_complete(user, tier(ctx), text(input, "itemSlug"), now)?
        }
        "undoCurriculumComplete" => learning().undo_complete(
            user,
            text(input, "itemSlug"),
            text(input, "completedAt"),
            text(input, "clientRequestId"),
            now,
        )?,
        "videoProgress.get" => customer().get_video_progress(user, text(input, "videoSlug"))?,
        "videoProgress.set" => learning().set_video_progress(
            user,
            tier(ctx),
            text(input, "videoSlug"),
            number(input, "positionSeconds").unwrap_or(f64::NAN),
            text(input, "clientRequestId"),
            now,
        )?,

        // ── The planner ──
        "planner.get" => planner().read(user, now)?,
        "planner.addTodo" => {
            planner().add_todo(user, text(input, "clientKey"), text(input, "text"), now)?
        }
        "planner.setTodoDone" => {
            planner().set_todo_done(user, text(input, "todoId"), flag(input, "done"), now)?
        }
        "planner.removeTodo" => planner().remove_todo(user, text(input, "todoId"), now)?,
        "planner.setGoal" => planner().set_goal(
            user,
            number(input, "itemsPerWeek").unwrap_or(f64::NAN),
            flag(input, "reminder"),
            now,
        )?,
        "planner.sendGoalReminder" => planner().send_goal_reminder(user)?,

        // ── Courses staff made, on the learner side ──
        "publicCourseByLink" => preview().by_link(text(input, "slug"), text(input, "key"), now)?,
        "publicAuthoredCourses"
        | "publicAuthoredCourse"
        | "authoredCourse"
        | "authoredCourseEnrolment"
        | "enrolAuthoredCourse"
        | "leaveAuthoredCourse" => {
            let purchases = purchases();
            let learners = CourseLearners {
                pool: store,
                preview: preview(),
                purchases: &purchases,
            };
            match ctx.call.path {
                #[expect(
                    clippy::cast_possible_truncation,
                    reason = "the input schema admits a whole page size"
                )]
                "publicAuthoredCourses" => {
                    learners.published(number(input, "limit").map_or(0, |l| l as i64))?
                }
                "publicAuthoredCourse" => learners.page(text(input, "slug"), None, now)?,
                "authoredCourse" => learners.page(text(input, "slug"), Some(user), now)?,
                "authoredCourseEnrolment" => learners.terms(user, text(input, "slug"))?,
                "enrolAuthoredCourse" => {
                    learners.enrol(user, text(input, "slug"), text(input, "track"), now)?
                }
                _ => learners.leave(user, text(input, "slug"), text(input, "enrolledAt"), now)?,
            }
        }

        // ── Course purchases ──
        "coursePurchase" => purchases().view(user, text(input, "slug"))?,
        "buyCourse" => purchases().buy(user, text(input, "slug"), text(input, "wallet"), now)?,
        "submitCoursePayment" => {
            purchases().submit_payment(user, text(input, "key"), text(input, "txHash"), now)?
        }
        "abandonCoursePurchase" => purchases().abandon(user, text(input, "key"), now)?,
        "admin.coursePurchase" => purchases().staff_read(text(input, "key"))?,
        "admin.refundCoursePurchase" => {
            purchases().refund(text(input, "key"), text(input, "reason"), user, now)?
        }

        // ── Staff: preview and private links ──
        "admin.previewCourse" => preview().preview(text(input, "courseId"), now)?,
        "admin.privateLinks" => preview().links(text(input, "courseId"))?,
        "admin.createPrivateLink" => {
            preview().create_link(text(input, "courseId"), text(input, "reason"), user, now)?
        }
        "admin.revokePrivateLink" => {
            preview().revoke_link(text(input, "linkId"), text(input, "reason"), user, now)?
        }

        // ── Staff: the learner desk, grants and reports ──
        "admin.learnerProgress" => desk().progress(text(input, "userId"), may_change(ctx))?,
        "admin.markCompleteFor" => learning().staff_mark_complete(
            text(input, "userId"),
            text(input, "itemSlug"),
            text(input, "reason"),
            text(input, "key"),
            operator,
            now,
        )?,
        "admin.grantAccess" => {
            let target = text(input, "userId");
            desk().grant_access(
                target,
                text(input, "pathSlug"),
                text(input, "reason"),
                opt_text(input, "expiresAt").and_then(instant),
                operator,
                now,
            )?;
            change(target, "access granted")
        }
        "admin.reinstateAccess" => {
            let target = text(input, "userId");
            #[expect(
                clippy::cast_possible_truncation,
                reason = "the input schema admits a whole event number"
            )]
            let n = number(input, "n").map_or(0, |n| n as i64);
            desk().reinstate(
                target,
                text(input, "grantId"),
                text(input, "reason"),
                opt_text(input, "expiresAt").and_then(instant),
                n,
                operator,
                now,
            )?;
            change(target, "access reinstated")
        }
        "admin.grantAudit" => {
            // The owner's size, or fewer when the caller asks for fewer: never more, and never a default.
            let owner = setting_int(ctx, "ACADEMY_GRANT_AUDIT_PAGE_SIZE");
            #[expect(clippy::cast_precision_loss, reason = "a page size of at most 200")]
            let limit = owner.map(|o| number(input, "limit").map_or(o as f64, |l| l.min(o as f64)));
            customer().grant_audit(
                limit,
                opt_text(input, "cursor"),
                opt_text(input, "course"),
                opt_text(input, "certificate"),
            )?
        }
        "admin.enrolments" => customer().enrolments(text(input, "from"), text(input, "to"))?,
        _ => return not_ported(ctx),
    };
    Ok(Some(out))
}
