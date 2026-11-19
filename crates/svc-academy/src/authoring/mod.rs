//! The authoring slice's parts, as the TypeScript service runs them: course records (`curriculum/courses.ts`), lessons
//! (`lessons.ts`), media and captions (`media.ts`), the Learn hub and its featured slot (`learn-hub.ts`,
//! `featured.ts`), programmes (`programme-records.ts`), a course's terms and start (`course-terms.ts`,
//! `course-start.ts`), release and pacing (`course-release.ts`, `course-item-rules.ts`, `release/access.ts`), the video
//! library and its signed object store (`video/*`), the outline a learner reads, and the team check that guards an
//! edit (`team/course-team.ts` `require`). `slices::authoring` answers the calls; every statement is the TypeScript's.

pub mod courses;
pub mod item_rules;
pub mod learn_hub;
pub mod lessons;
pub mod media;
pub mod outline;
pub mod programmes;
pub mod release;
pub mod sql;
pub mod storage;
pub mod team;
pub mod terms;
pub mod tracks;
pub mod video;

use service_kit::json::Json;
use service_kit::schema::Value;

use crate::errors::{AcademyError, Refusal};
use crate::settings::Settings;

/// The owner's values the slice reads, from the loaded environment (`AcademyService` options and the router's video
/// deps, as `index.ts` builds them). `None` is a blank value: nothing is defaulted.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Options {
    pub outline_max_sections: Option<i64>,
    pub outline_max_items: Option<i64>,
    pub lesson_import_max_bytes: Option<i64>,
    pub upload_max_bytes: Option<i64>,
    pub upload_video_types: Option<Vec<String>>,
    pub upload_handout_types: Option<Vec<String>>,
    pub topics_list_limit: Option<i64>,
    pub programme_max_courses: Option<i64>,
    pub video_watch_threshold_seconds: Option<i64>,
    pub video_save_every_seconds: Option<i64>,
    pub storage: Option<storage::Storage>,
    pub gate: video::Gate,
}

fn int_of(s: &Settings, key: &str) -> Option<i64> {
    match s.0.get(key) {
        Some(Json::Number(n)) => format!("{n}").parse().ok(),
        _ => None,
    }
}

fn str_of(s: &Settings, key: &str) -> String {
    match s.0.get(key) {
        Some(Json::String(v)) => v.clone(),
        _ => String::new(),
    }
}

fn list_of(s: &Settings, key: &str) -> Option<Vec<String>> {
    match s.0.get(key) {
        Some(Json::Array(a)) => Some(
            a.iter()
                .filter_map(|v| match v {
                    Json::String(t) => Some(t.clone()),
                    _ => None,
                })
                .collect(),
        ),
        _ => None,
    }
}

impl Options {
    /// From the settings the door holds (the loaded environment; empty in the replay, as the TypeScript's `{}`).
    pub fn from_settings(s: &Settings) -> Options {
        Options {
            outline_max_sections: int_of(s, "ACADEMY_OUTLINE_MAX_SECTIONS"),
            outline_max_items: int_of(s, "ACADEMY_OUTLINE_MAX_ITEMS"),
            lesson_import_max_bytes: int_of(s, "ACADEMY_LESSON_IMPORT_MAX_BYTES"),
            upload_max_bytes: int_of(s, "ACADEMY_UPLOAD_MAX_BYTES"),
            upload_video_types: list_of(s, "ACADEMY_UPLOAD_VIDEO_TYPES"),
            upload_handout_types: list_of(s, "ACADEMY_UPLOAD_HANDOUT_TYPES"),
            topics_list_limit: int_of(s, "ACADEMY_TOPICS_LIST_LIMIT"),
            programme_max_courses: int_of(s, "ACADEMY_PROGRAMME_MAX_COURSES"),
            video_watch_threshold_seconds: int_of(s, "ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS"),
            video_save_every_seconds: int_of(s, "ACADEMY_VIDEO_POSITION_SAVE_SECONDS"),
            storage: storage::Storage::from_env(
                &str_of(s, "ACADEMY_VIDEO_S3_ENDPOINT"),
                &str_of(s, "ACADEMY_VIDEO_S3_BUCKET"),
                &str_of(s, "ACADEMY_VIDEO_S3_ACCESS_KEY"),
                &str_of(s, "ACADEMY_VIDEO_S3_SECRET_KEY"),
                &str_of(s, "ACADEMY_VIDEO_S3_REGION"),
                int_of(s, "ACADEMY_VIDEO_URL_TTL_SECONDS"),
            ),
            gate: video::Gate {
                min_tier: str_of(s, "ACADEMY_VIDEO_MIN_TIER"),
                min_stake: str_of(s, "ACADEMY_VIDEO_MIN_STAKE"),
            },
        }
    }
}

/// `new AcademyError(message, code)` as a refusal.
pub fn refuse<T>(message: impl Into<String>, code: &str) -> Result<T, Refusal> {
    Err(AcademyError::new(message, code).into())
}

/// A string field of the checked input (`""` when absent).
pub fn text<'a>(input: &'a Value, key: &str) -> &'a str {
    input.get(key).as_str().unwrap_or("")
}

/// A nullable string field: `None` for `null` (or absent).
pub fn opt_text<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).as_str()
}

/// An integer field the schema checked (`.int()`).
pub fn int(input: &Value, key: &str) -> i64 {
    opt_int(input, key).unwrap_or(0)
}

pub fn opt_int(input: &Value, key: &str) -> Option<i64> {
    input
        .get(key)
        .as_number()
        .and_then(|n| format!("{n}").parse().ok())
}

/// A nullable string as JSON.
pub fn nullable(v: Option<String>) -> Json {
    v.map_or(Json::Null, Json::String)
}

pub fn nullable_int(v: Option<i64>) -> Json {
    v.map_or(Json::Null, Json::int)
}
