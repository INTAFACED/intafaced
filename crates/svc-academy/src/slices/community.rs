//! The community slice: the calls the door table gives `Slice::Community`, answered as `router.ts`,
//! `team/team-router.ts`, `learners/learner-desk-router.ts`, `learners/staff-enrolment-router.ts` and
//! `analytics/analytics-router.ts` answer them: course discussion and its moderation, course messages, the course team
//! and roles, the learner desk, staff enrolment and course email, the reports centre and the console's metrics.
//!
//! Each handler evaluates its arguments as the router does (the caller, `changer`), then calls the service: a refusing
//! service refuses there ([`Db::reach`]); the module then runs the checks the TypeScript makes before its first query
//! and asks for the database only at that query ([`Db::get`]), so a store that is down answers each check as it did.

use service_kit::json::Json;
use service_kit::schema::Value;

use crate::community::analytics::{self, ReportSettings};
use crate::community::staff_enrolment::{self, Limits, UploadRow};
use crate::community::{Db, discussion, learner_desk, messages, metrics, moderation, team};
use crate::community::{academy, setting, setting_str};
use crate::door::Ctx;
use crate::errors::Refusal;
use crate::slices::{Answer, not_ported};

fn text<'a>(input: &'a Value, key: &str) -> &'a str {
    input.get(key).as_str().unwrap_or("")
}

fn text_opt<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).as_str()
}

fn num(input: &Value, key: &str) -> i64 {
    #[expect(
        clippy::cast_possible_truncation,
        reason = "the door's schema let only whole numbers in its bounds through"
    )]
    input.get(key).as_number().map_or(0, |n| n as i64)
}

fn flag(input: &Value, key: &str) -> bool {
    matches!(input.get(key), Value::Bool(true))
}

fn strings(input: &Value, key: &str) -> Vec<String> {
    input
        .get(key)
        .as_array()
        .unwrap_or(&[])
        .iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect()
}

/// `ctx.principal?.scopes.includes('admin:write')`.
fn may_write(ctx: &Ctx<'_>) -> bool {
    ctx.principal
        .is_some_and(|p| p.scopes.iter().any(|s| s == "admin:write"))
}

/// `changer(ctx)` (`learner-desk-router.ts`): the actor of a learner change, refused when the session may only read.
fn changer<'a>(ctx: &'a Ctx<'_>) -> Result<&'a str, Refusal> {
    if !may_write(ctx) {
        return Err(academy(
            "academy.permission_denied",
            "academy.permission_denied this session may read a learner but not change one (admin:write)",
        ));
    }
    Ok(ctx.user_id())
}

/// `LEARNERS_REPORT_DEFAULT`.
const LEARNERS_REPORT_DEFAULT: i64 = 200;
/// `HISTORY` (`staff-enrolment-router.ts`): how many rows a history list shows.
const HISTORY: i64 = 100;

fn discussion_limits(ctx: &Ctx<'_>) -> discussion::Limits {
    discussion::Limits {
        post_max_chars: setting(ctx.settings, "ACADEMY_POST_MAX_CHARS"),
        image_max_bytes: setting(ctx.settings, "ACADEMY_POST_IMAGE_MAX_BYTES"),
    }
}

fn staff_limits(ctx: &Ctx<'_>) -> Limits {
    Limits {
        bulk_enrol_rows: setting(ctx.settings, "ACADEMY_BULK_ENROL_ROWS"),
        inactive_days: setting(ctx.settings, "ACADEMY_BULK_EMAIL_INACTIVE_DAYS"),
        report_retention_hours: setting(ctx.settings, "ACADEMY_REPORT_RETENTION_HOURS"),
        export_rows: setting(ctx.settings, "ACADEMY_LEARNER_EXPORT_ROWS"),
    }
}

/// The reports centre's owner values (`academy-service.ts`: the row limit is the learner export's).
pub fn report_settings(settings: &crate::settings::Settings) -> ReportSettings {
    ReportSettings {
        page_size: setting(settings, "ACADEMY_REPORT_TASKS_PAGE_SIZE"),
        retention_minutes: setting(settings, "ACADEMY_REPORT_CENTRE_RETENTION_MINUTES"),
        row_limit: setting(settings, "ACADEMY_LEARNER_EXPORT_ROWS"),
        sweep_seconds: setting(settings, "ACADEMY_REPORT_SWEEP_SECONDS"),
    }
}

/// `SERVICE_NAME`, the producer the moderation notices carry.
pub fn producer(settings: &crate::settings::Settings) -> &str {
    setting_str(settings, "SERVICE_NAME").unwrap_or("svc-academy")
}

/// `onModerationNoticeError`: the failure is logged and the notice waits for the next send.
pub fn log_notice_error(err: &str, event_id: &str) {
    eprintln!(
        "{}",
        Json::obj([
            ("level", Json::int(50)),
            ("err", Json::str(err)),
            ("eventId", Json::str(event_id)),
            (
                "msg",
                Json::str("moderation notice publish failed; it waits for the next send")
            ),
        ])
        .compact()
    );
}

/// Production's `schedule`: the export runs on its own thread with its own connection, after the request answered.
fn schedule_export(ctx: &Ctx<'_>) -> impl Fn(String) + use<> {
    let url = ctx.store.pool().ok().map(|p| p.url().to_owned());
    move |id: String| {
        let Some(url) = url.clone() else {
            return;
        };
        std::thread::spawn(move || {
            let own = service_kit::pg::Pool::new(&url, 1);
            if let Err(e) = staff_enrolment::run_export(&own, &id) {
                eprintln!(
                    "{}",
                    Json::obj([
                        ("level", Json::int(50)),
                        ("err", Json::str(format!("{e:?}"))),
                        ("taskId", Json::str(id.clone())),
                        (
                            "msg",
                            Json::str("learner export failed to record its outcome")
                        ),
                    ])
                    .compact()
                );
            }
            own.end();
        });
    }
}

pub fn handle(ctx: &Ctx<'_>) -> Answer {
    let input = &ctx.input;
    let db = Db(ctx.store);
    let me = ctx.user_id();
    let now = ctx.now;
    let caller = team::Caller {
        user_id: me,
        may_write: may_write(ctx),
    };
    let moderator = moderation::Moderator {
        user_id: me,
        may_write: caller.may_write,
    };
    let out = match ctx.call.path {
        // ── Discussion ────────────────────────────────────────────────────────
        "discussionCourses" => {
            db.reach()?;
            discussion::courses(&db, me, num(input, "limit"))?
        }
        "discussionTopics" => {
            db.reach()?;
            discussion::topics(&db, me, text(input, "courseSlug"))?
        }
        "discussionPosts" => {
            db.reach()?;
            discussion::posts(
                &db,
                me,
                text(input, "courseSlug"),
                text(input, "topicSlug"),
                num(input, "limit"),
            )?
        }
        "discussionThread" => {
            db.reach()?;
            discussion::thread(&db, me, text(input, "postId"), num(input, "limit"))?
        }
        "discussionPostImage" => {
            db.reach()?;
            discussion::image(&db, me, text(input, "postId"))?
        }
        "createDiscussionPost" => {
            db.reach()?;
            let image = input.get("image");
            let image = match image {
                Value::Object(_) => Some((text(image, "contentType"), text(image, "base64"))),
                _ => None,
            };
            discussion::create_post(
                &db,
                discussion_limits(ctx),
                &discussion::NewPost {
                    course_slug: text(input, "courseSlug"),
                    topic_slug: text(input, "topicSlug"),
                    kind: text(input, "kind"),
                    title: text(input, "title"),
                    body: text(input, "body"),
                    anonymous: flag(input, "anonymous"),
                    image,
                    client_request_id: text(input, "clientRequestId"),
                    user_id: me,
                    now,
                },
            )?
        }
        "replyDiscussionPost" => {
            db.reach()?;
            discussion::reply(
                &db,
                discussion_limits(ctx),
                text(input, "postId"),
                text(input, "body"),
                flag(input, "anonymous"),
                text(input, "clientRequestId"),
                me,
                now,
            )?
        }
        "acceptDiscussionReply" => {
            db.reach()?;
            discussion::accept(&db, me, text(input, "postId"), text(input, "replyId"))?
        }
        "followDiscussionPost" => {
            db.reach()?;
            discussion::follow(&db, me, text(input, "postId"), flag(input, "on"), now)?
        }
        "likeDiscussionPost" => {
            db.reach()?;
            discussion::like(&db, me, text(input, "postId"), flag(input, "on"), now)?
        }
        "reportDiscussionPost" => {
            db.reach()?;
            moderation::report(&db, me, text(input, "postId"), text(input, "reason"), now)?
        }
        "admin.saveDiscussionTopic" => {
            db.reach()?;
            discussion::save_topic(
                &db,
                &discussion::SaveTopic {
                    course_id: text(input, "courseId"),
                    slug: text(input, "slug"),
                    title: text(input, "title"),
                    pinned: flag(input, "pinned"),
                    position: i32::try_from(num(input, "position")).unwrap_or(0),
                    reason: text(input, "reason"),
                    operator_id: me,
                    now,
                },
            )?
        }
        "admin.discussionThread" => {
            db.reach()?;
            discussion::staff_thread(&db, text(input, "postId"), num(input, "limit"))?
        }

        // ── Moderation ────────────────────────────────────────────────────────
        "admin.moderationQueue" => {
            db.reach()?;
            moderation::queue(
                &db,
                text_opt(input, "courseId"),
                num(input, "limit"),
                moderator,
            )?
        }
        "admin.deleteDiscussionPost" | "admin.bulkDeleteUserPosts" => {
            db.reach()?;
            let outbox = moderation::Outbox {
                bus: ctx.ports.bus.as_ref(),
                producer: producer(ctx.settings),
                log: &log_notice_error,
            };
            if ctx.call.path == "admin.deleteDiscussionPost" {
                moderation::delete_post(
                    &db,
                    &outbox,
                    text(input, "postId"),
                    text(input, "reason"),
                    moderator,
                    now,
                )?
            } else {
                moderation::bulk_delete(
                    &db,
                    &outbox,
                    text(input, "courseId"),
                    text(input, "authorId"),
                    text(input, "reason"),
                    moderator,
                    now,
                )?
            }
        }

        // ── Course messages ───────────────────────────────────────────────────
        "sendCourseMessage" => {
            db.reach()?;
            messages::send(
                &db,
                setting(ctx.settings, "ACADEMY_MESSAGE_MAX_CHARS"),
                me,
                text(input, "courseSlug"),
                text(input, "body"),
                text(input, "clientRequestId"),
                now,
            )?
        }
        "courseConversations" => {
            db.reach()?;
            messages::inbox(&db, me, num(input, "limit"))?
        }
        "openCourseConversation" => {
            db.reach()?;
            messages::open(
                &db,
                me,
                text(input, "conversationId"),
                num(input, "limit"),
                now,
            )?
        }
        "admin.courseInbox" => {
            db.reach()?;
            messages::staff_inbox(&db, num(input, "limit"))?
        }
        "admin.openCourseConversation" => {
            db.reach()?;
            messages::staff_open(&db, text(input, "conversationId"), num(input, "limit"), now)?
        }
        "admin.replyCourseMessage" => {
            db.reach()?;
            messages::staff_reply(
                &db,
                setting(ctx.settings, "ACADEMY_MESSAGE_MAX_CHARS"),
                me,
                text(input, "conversationId"),
                text(input, "body"),
                text(input, "clientRequestId"),
                now,
            )?
        }

        // ── Team and roles ────────────────────────────────────────────────────
        "admin.academyRoles" => {
            db.reach()?;
            team::roles(&db, setting(ctx.settings, "ACADEMY_CUSTOM_ROLE_LIMIT"))?
        }
        "admin.courseTeam" => {
            db.reach()?;
            team::team(&db, text_opt(input, "courseId"), caller)?
        }
        "admin.proposeTeamChange" => {
            db.reach()?;
            team::propose(
                &db,
                &team::Propose {
                    course_id: text_opt(input, "courseId"),
                    account_id: text(input, "accountId"),
                    role: text(input, "role"),
                    kind: text(input, "kind"),
                    reason: text(input, "reason"),
                    request_id: text(input, "requestId"),
                    caller,
                    now,
                },
            )?
        }
        "admin.confirmTeamChange" => {
            db.reach()?;
            team::confirm(&db, text(input, "changeId"), caller, now)?
        }
        "admin.saveCustomRole" => {
            db.reach()?;
            team::save_custom_role(
                &db,
                setting(ctx.settings, "ACADEMY_CUSTOM_ROLE_LIMIT"),
                &team::SaveCustomRole {
                    name: text(input, "name"),
                    permissions: strings(input, "permissions"),
                    reason: text(input, "reason"),
                    request_id: text(input, "requestId"),
                    caller,
                    now,
                },
            )?
        }
        "admin.setCustomRoleActive" => {
            db.reach()?;
            team::set_custom_role_active(
                &db,
                text(input, "roleId"),
                flag(input, "active"),
                text(input, "reason"),
                caller,
                now,
            )?
        }

        // ── Learner desk ──────────────────────────────────────────────────────
        "admin.learner" => {
            db.reach()?;
            learner_desk::page(&db, text(input, "userId"), may_write(ctx), now)?
        }
        "admin.learners" => {
            db.reach()?;
            let limit = match input.get("limit") {
                Value::Number(_) => num(input, "limit"),
                _ => LEARNERS_REPORT_DEFAULT,
            };
            learner_desk::learners(&db, text_opt(input, "tag"), limit)?
        }
        "admin.learnerTags" => {
            db.reach()?;
            learner_desk::tags(&db)?
        }
        "admin.addLearnerNote" => {
            let actor = changer(ctx)?;
            db.reach()?;
            let user = text(input, "userId");
            let n = learner_desk::add_note(
                &db,
                user,
                text(input, "body"),
                text(input, "key"),
                actor,
                now,
            )?;
            Json::obj([
                ("userId", Json::str(user)),
                ("done", Json::str(format!("internal note {n} saved"))),
            ])
        }
        "admin.tagLearners" => {
            let actor = changer(ctx)?;
            db.reach()?;
            let added = learner_desk::tag(
                &db,
                &strings(input, "userIds"),
                text(input, "tag"),
                text(input, "reason"),
                actor,
                now,
            )?;
            Json::obj([("added", Json::int(added))])
        }
        "admin.untagLearner" => {
            let actor = changer(ctx)?;
            db.reach()?;
            let user = text(input, "userId");
            let tag = text(input, "tag");
            let removed = learner_desk::untag(&db, user, tag, text(input, "reason"), actor, now)?;
            Json::obj([
                ("userId", Json::str(user)),
                (
                    "done",
                    Json::str(if removed {
                        format!("tag {tag} removed")
                    } else {
                        format!("the learner did not carry {tag}")
                    }),
                ),
            ])
        }

        // ── Staff enrolment, invitations, course email and learner exports ───
        "admin.staffEnrol" => {
            db.reach()?;
            staff_enrolment::enrol(
                &db,
                text(input, "path"),
                text(input, "userId"),
                text(input, "reason"),
                me,
                "staff",
                now,
            )?
        }
        "admin.staffEnrolments" => {
            db.reach()?;
            staff_enrolment::events(
                &db,
                text_opt(input, "path"),
                text_opt(input, "userId"),
                HISTORY,
            )?
        }
        "admin.bulkEnrol" => {
            db.reach()?;
            let rows: Vec<UploadRow> = input
                .get("rows")
                .as_array()
                .unwrap_or(&[])
                .iter()
                .map(|r| UploadRow {
                    address: text(r, "address").to_owned(),
                    user_id: text_opt(r, "userId").map(str::to_owned),
                })
                .collect();
            staff_enrolment::bulk_enrol(
                &db,
                &staff_limits(ctx),
                text(input, "path"),
                &rows,
                text(input, "reason"),
                me,
                now,
            )?
        }
        "admin.inviteToCourse" => {
            db.reach()?;
            staff_enrolment::invite(
                &db,
                text(input, "path"),
                text(input, "address"),
                text(input, "reason"),
                me,
                now,
            )?
        }
        "admin.courseInvitations" => {
            db.reach()?;
            staff_enrolment::invitations(&db, text_opt(input, "path"), HISTORY)?
        }
        "courseEmails" => {
            db.reach()?;
            staff_enrolment::course_emails(&db, me, text(input, "slug"))?
        }
        "setCourseEmails" => {
            db.reach()?;
            staff_enrolment::set_course_emails(
                &db,
                me,
                text(input, "slug"),
                flag(input, "on"),
                now,
            )?
        }
        "admin.sendBulkEmail" => {
            db.reach()?;
            staff_enrolment::send_bulk_email(
                &db,
                &staff_limits(ctx),
                text(input, "path"),
                text(input, "subject"),
                text(input, "body"),
                text(input, "key"),
                me,
                now,
            )?
        }
        "admin.bulkEmails" => {
            db.reach()?;
            staff_enrolment::bulk_emails(&db, text_opt(input, "path"), HISTORY)?
        }
        "admin.bulkEmail" => {
            db.reach()?;
            staff_enrolment::bulk_email(&db, text(input, "id"))?
        }
        "admin.requestLearnerExport" => {
            db.reach()?;
            let schedule = schedule_export(ctx);
            staff_enrolment::request_learner_export(
                &db,
                &staff_limits(ctx),
                text_opt(input, "tag"),
                text(input, "key"),
                me,
                now,
                &schedule,
            )?
        }
        "admin.reportTasks" => {
            db.reach()?;
            staff_enrolment::reports(&db, HISTORY, now)?
        }
        "admin.reportFile" => {
            db.reach()?;
            staff_enrolment::report_file(&db, text(input, "id"), now)?
        }

        // ── Learner summaries and the reports centre ──────────────────────────
        "admin.learnerSummaries" => {
            db.reach()?;
            analytics::summaries_page(
                &db,
                setting(ctx.settings, "ACADEMY_LEARNER_SUMMARIES_PAGE_SIZE"),
                text_opt(input, "tag"),
                text_opt(input, "after"),
            )?
        }
        "admin.reportCentreTasks" => {
            db.reach()?;
            analytics::list(&db, &report_settings(ctx.settings), me, now)?
        }
        "admin.requestReport" => {
            db.reach()?;
            analytics::request(
                &db,
                &report_settings(ctx.settings),
                me,
                text(input, "kind"),
                text_opt(input, "tag"),
                num(input, "n"),
                now,
            )?
        }
        "admin.abortReport" => {
            db.reach()?;
            analytics::abort(&db, me, text(input, "taskId"), now)?
        }
        "admin.deleteReport" => {
            db.reach()?;
            analytics::delete(&db, me, text(input, "taskId"), now)?
        }
        "admin.reportCentreFile" => {
            db.reach()?;
            analytics::file(&db, text(input, "taskId"), now)?
        }

        // ── The console's metrics ─────────────────────────────────────────────
        "admin.opsMetrics" => {
            db.reach()?;
            metrics::ops_metrics(&db, text(input, "from"), text(input, "to"))?
        }
        "admin.completionsByItem" => {
            db.reach()?;
            metrics::completions_by_item(
                &db,
                text(input, "from"),
                text(input, "to"),
                text_opt(input, "pathSlug"),
            )?
        }
        _ => return not_ported(ctx),
    };
    Ok(Some(out))
}
