//! The authoring slice: the calls the door table gives `Slice::Authoring`, answered as `router.ts` answers them.
//!
//! The video library calls (`videos`, `publicVideos`, `videoCaptions`, `videoTranscript`, `videoPlayback`) never reach
//! `AcademyService`: they answer from storage, the tier and stake gate and the spine, whatever the database does.
//! `videoPlayer` entitles the caller first, then asks the service. Every other call goes through the service, so it first
//! meets a refusing service ([`enter`]); a call the router checks with `academy.team` checks it next; then each module
//! checks what the TypeScript checks before its first query.

use service_kit::json::Json;
use service_kit::schema::{Value, js_trim};

use crate::authoring::courses::{CourseRecords, Limits};
use crate::authoring::lessons::Lessons;
use crate::authoring::media::{self, HttpReadBack, Media};
use crate::authoring::video::{self, Caller, Library};
use crate::authoring::{
    Options, int, item_rules, learn_hub, outline, programmes, refuse, release, sql, team, terms,
    text, tracks,
};
use crate::curriculum::spine;
use crate::db::Store;
use crate::door::Ctx;
use crate::errors::Refusal;
use crate::slices::{Answer, not_ported};

/// A call into `AcademyService`: a service that refuses every method refuses here, before anything else runs.
fn enter(ctx: &Ctx<'_>) -> Result<(), Refusal> {
    match ctx.store {
        Store::Refuses(r) => Err(r.clone()),
        _ => Ok(()),
    }
}

/// `academy.team.require(userId, courseId, permission)`.
fn require(ctx: &Ctx<'_>, course_id: &str, permission: &str) -> Result<(), Refusal> {
    sql::client(ctx.store, |c| {
        team::require(c, ctx.user_id(), Some(course_id), permission)
    })
}

/// `academy.team.require(userId, await academy.team.courseOfItem(itemId), permission)`.
fn require_item(ctx: &Ctx<'_>, permission: &str) -> Result<(), Refusal> {
    let item_id = text(&ctx.input, "itemId");
    let course_id = sql::client(ctx.store, |c| team::course_of_item(c, item_id))?;
    require(ctx, &course_id, permission)
}

/// `this.spineVideo(slug)`.
fn spine_video(slug: &str) -> Result<&'static video::Entry, Refusal> {
    video::require_spine_item(slug, &video::SPINE)
}

fn reason_of(input: &Value) -> Result<&str, Refusal> {
    let reason = js_trim(text(input, "reason"));
    if reason.is_empty() {
        return refuse("A reason is required", "academy.reason_required");
    }
    Ok(reason)
}

/// `hasCurriculumSlug(itemSlug.trim())`.
fn curriculum_slug(raw: &str) -> Result<&str, Refusal> {
    let slug = js_trim(raw);
    if spine::get(slug).is_none() {
        return refuse("Unknown curriculum item", "academy.curriculum_not_found");
    }
    Ok(slug)
}

fn video_calls(ctx: &Ctx<'_>, o: &Options) -> Option<Answer> {
    let input = &ctx.input;
    let lib = Library {
        storage: o.storage.as_ref(),
        gate: &o.gate,
        stake: ctx.ports.stake.as_ref(),
    };
    let caller = Caller {
        user_id: ctx.user_id(),
        tier: ctx.principal.map_or("", |p| p.tier.as_str()),
    };
    let now = ctx.now.0;
    let slug = text(input, "slug");
    let out = match ctx.call.path {
        "videos" => lib.list(),
        "publicVideos" => lib.public_list(),
        "videoCaptions" => lib.captions(slug, &caller, now, &video::SPINE),
        "videoTranscript" => lib.transcript(
            slug,
            &caller,
            now,
            &video::SPINE,
            &video::shipped_transcript,
        ),
        "videoPlayback" => (|| {
            if let Some(url) = input.get("url").as_str().filter(|u| !u.is_empty()) {
                lib.assert_url_granted(url, now)?;
            }
            lib.playback(slug, &caller, now)
        })(),
        "videoPlayer" => (|| {
            lib.entitle(&caller)?;
            enter(ctx)?;
            let v = spine_video(slug)?;
            let tracks = tracks::tracks(ctx.store, v.slug)?;
            Ok(Json::obj([
                ("slug", Json::str(v.slug)),
                ("title", Json::str(v.title)),
                (
                    "renditions",
                    Json::Array(vec![Json::obj([("id", Json::str("original"))])]),
                ),
                (
                    "tracks",
                    Json::Array(tracks.iter().map(tracks::Track::json).collect()),
                ),
                (
                    "saveEverySeconds",
                    o.video_save_every_seconds.map_or(Json::Null, Json::int),
                ),
                (
                    "watchThresholdSeconds",
                    o.video_watch_threshold_seconds
                        .map_or(Json::Null, Json::int),
                ),
            ]))
        })(),
        _ => return None,
    };
    Some(out.map(Some))
}

pub fn handle(ctx: &Ctx<'_>) -> Answer {
    let o = Options::from_settings(ctx.settings);
    if let Some(answer) = video_calls(ctx, &o) {
        return answer;
    }
    enter(ctx)?;
    let input = &ctx.input;
    let store = ctx.store;
    let op = ctx.user_id();
    let now = ctx.now.0;
    let courses = CourseRecords {
        limits: Limits {
            max_sections: o.outline_max_sections,
            max_items: o.outline_max_items,
        },
    };
    let lessons = Lessons {
        pool: store,
        courses: &courses,
        import_max_bytes: o.lesson_import_max_bytes,
    };
    let limits = media::Limits {
        max_bytes: o.upload_max_bytes,
        video_types: o.upload_video_types.clone(),
        handout_types: o.upload_handout_types.clone(),
    };
    let media = Media {
        pool: store,
        storage: o.storage.as_ref(),
        limits: &limits,
        read_back: &HttpReadBack,
    };
    let course_id = text(input, "courseId");
    let out = match ctx.call.path {
        // Learner calls.
        "courseOutline" => outline::course_outline(
            store,
            op,
            text(input, "itemSlug"),
            now,
            o.video_watch_threshold_seconds,
        )?,
        "itemRelease" => release::item_release(store, op, text(input, "itemSlug"), now)?.json(),
        "itemVideo" => {
            let slug = curriculum_slug(text(input, "itemSlug"))?;
            let video = sql::client(store, |c| tracks::item_video(c, slug))?;
            Json::obj([
                ("itemSlug", Json::str(slug)),
                ("videoSlug", video.map_or(Json::Null, Json::String)),
            ])
        }
        "programme" => programmes::programme(store, op, text(input, "slug"), now)?,
        "programmes" => {
            let mine = matches!(input.get("mine"), Value::Bool(true));
            programmes::programmes(store, op, int(input, "limit"), mine, now)?
        }
        // Courses.
        "admin.courses" => courses.list(store, input)?,
        "admin.course" => courses.get(store, course_id)?,
        "admin.createCourse" => courses.create(store, input, op, now)?,
        "admin.updateCourse" => {
            require(ctx, course_id, "content.edit")?;
            courses.update(store, input, op, now)?
        }
        "admin.setCourseState" => {
            require(ctx, course_id, "content.publish")?;
            courses.set_state(store, input, op, now)?
        }
        "admin.withdrawCoursePrice" => courses.withdraw_price(store, input, op, now)?,
        "admin.saveOutline" => {
            require(ctx, course_id, "content.edit")?;
            courses.save_outline(store, input, op, now)?
        }
        "admin.duplicateCourse" => courses.duplicate(store, input, op, now)?,
        "admin.setCourseTopics" => courses.set_topics(store, input, op, now)?,
        // Lessons.
        "admin.lesson" => lessons.get(text(input, "itemId"))?,
        "admin.saveLesson" => {
            require_item(ctx, "content.edit")?;
            lessons.save(input, op, now)?
        }
        "admin.revertLesson" => {
            require_item(ctx, "content.edit")?;
            lessons.revert(input, op, now)?
        }
        "admin.publishLesson" => {
            require_item(ctx, "content.publish")?;
            lessons.publish(input, op, now)?
        }
        "admin.duplicateItem" => {
            require_item(ctx, "content.edit")?;
            lessons.duplicate(input, op, now)?
        }
        "admin.importLesson" => {
            require_item(ctx, "content.edit")?;
            lessons.import(input, op, now)?
        }
        "admin.withdrawLesson" => lessons.withdraw(input, op, now)?,
        "admin.assistantDraft" => lessons.assistant_draft(input, op, now)?,
        "admin.decideDraft" => lessons.decide_draft(input, op, now)?,
        // Media.
        "admin.itemMedia" => media.item_media(text(input, "itemId"), now)?,
        "admin.mediaUploadIntent" => media.intent(input, op, now)?,
        "admin.confirmMedia" => media.confirm(text(input, "mediaId"), now)?,
        "admin.setItemCaptions" => media.set_captions(input, op, now)?,
        // The learn hub.
        "admin.featuredSlot" => learn_hub::slot(store)?,
        "admin.featureLesson" => learn_hub::feature_lesson(store, input, op, now)?,
        "admin.clearFeatured" => learn_hub::clear_featured(store, input, op, now)?,
        "admin.setFeatured" => learn_hub::set_featured(store, input, op, now)?,
        "admin.topics" => learn_hub::topics(store, o.topics_list_limit)?,
        "admin.createTopic" => learn_hub::create_topic(store, input, op, now)?,
        // Release rules.
        "admin.courseRelease" => release::course_release(store, course_id)?,
        "admin.setSectionRelease" => release::set_section_release(store, input, op, now)?,
        "admin.setCoursePacing" => release::set_pacing(store, input, op, now)?,
        "admin.courseItemRules" => item_rules::admin_view(store, course_id)?,
        "admin.setCourseItemPrerequisites" => item_rules::set_prerequisites(store, input, op, now)?,
        "admin.setItemPrerequisites" => release::set_item_prerequisites(store, input)?,
        "admin.setItemWindow" => release::set_item_window(store, input)?,
        "admin.setCourseStart" => release::set_course_start(store, input, op, now)?,
        // Course terms.
        "admin.setCourseSeatCap" => terms::set_seat_cap(store, input, op, now)?,
        "admin.setCourseEnrolmentWindow" => terms::set_window(store, input, op, now)?,
        "admin.setCourseVisibility" => terms::set_visibility(store, input, op, now)?,
        // Programmes.
        "admin.saveProgramme" => programmes::save(store, input, op, now, o.programme_max_courses)?,
        "admin.programmes" => programmes::admin_list(store, int(input, "limit"))?,
        // Videos on items.
        "admin.setItemVideo" => {
            let item_slug = curriculum_slug(text(input, "itemSlug"))?;
            let reason = reason_of(input)?;
            let video = match input.get("videoSlug").as_str() {
                None => None,
                Some(v) => Some(spine_video(js_trim(v))?.slug),
            };
            tracks::set_item_video(store, item_slug, video, op, reason, now)?;
            Json::obj([
                ("itemSlug", Json::str(item_slug)),
                ("videoSlug", video.map_or(Json::Null, Json::str)),
            ])
        }
        "admin.setVideoTracks" => {
            let v = spine_video(js_trim(text(input, "videoSlug")))?;
            let reason = reason_of(input)?;
            let given = input.get("tracks").as_array().unwrap_or_default();
            let wanted: Vec<tracks::TrackIn<'_>> = given
                .iter()
                .map(|t| tracks::TrackIn {
                    language: text(t, "language"),
                    label: text(t, "label"),
                    vtt: text(t, "vtt"),
                })
                .collect();
            let saved = tracks::set_tracks(store, v.slug, &wanted, op, reason, now)?;
            Json::obj([
                ("videoSlug", Json::str(v.slug)),
                (
                    "tracks",
                    Json::Array(saved.iter().map(tracks::Track::json).collect()),
                ),
            ])
        }
        _ => return not_ported(ctx),
    };
    Ok(Some(out))
}
