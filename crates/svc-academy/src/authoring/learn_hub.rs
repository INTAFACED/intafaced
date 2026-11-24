//! The Learn hub's featured slot and its topics (`curriculum/learn-hub.ts` `LearnHub`), and the curriculum item a
//! staff member chooses for the slot (`curriculum/featured.ts` `FeaturedSlot.choose`). Every feature and clear is a
//! `featured_events` row with who and why; nothing is promoted automatically.

use crate::db::Store;
use service_kit::json::Json;
use service_kit::schema::{Value, js_trim};

use super::courses::topic_json;
use super::sql::{self, at, first, get, iso, iso_of, ms, opt_int, query};
use super::{nullable, refuse, text};
use crate::curriculum::spine;
use crate::errors::Refusal;

/// `LearnHub.featuredSlot`.
pub fn featured_slot<C: postgres::GenericClient>(c: &mut C) -> Result<Json, Refusal> {
    let row = first(
        c,
        &format!(
            "SELECT f.item_slug, i.id::text AS item_id, i.title, c.id::text AS course_id, c.title AS course_title, \
               c.state AS course_state, i.live_revision, f.reason, f.chosen_by::text AS chosen_by, {} AS chosen_at \
             FROM academy.featured_items f \
             LEFT JOIN academy.course_items i ON i.id = f.course_item_id \
             LEFT JOIN academy.courses c ON c.id = i.course_id \
             WHERE f.slot = 'hub'",
            ms("f.chosen_at")
        ),
        &[],
    )?;
    let empty = || {
        Json::obj([
            ("curriculum", Json::Null),
            ("lesson", Json::Null),
            ("reason", Json::Null),
            ("chosenBy", Json::Null),
            ("chosenAt", Json::Null),
        ])
    };
    let Some(r) = row else {
        return Ok(empty());
    };
    let item_slug: Option<String> = get(&r, "item_slug")?;
    let curriculum = item_slug
        .as_deref()
        .filter(|s| !s.is_empty())
        .and_then(spine::get);
    let item_id: Option<String> = get(&r, "item_id")?;
    let live = opt_int(&r, "live_revision")?;
    let state: Option<String> = get(&r, "course_state")?;
    let lesson_shown = item_id.is_some()
        && live.is_some()
        && matches!(state.as_deref(), Some("draft" | "published"));
    if curriculum.is_none() && !lesson_shown {
        return Ok(empty());
    }
    let lesson = if lesson_shown {
        Json::obj([
            ("itemId", nullable(item_id)),
            ("title", nullable(get(&r, "title")?)),
            ("courseId", nullable(get(&r, "course_id")?)),
            ("courseTitle", nullable(get(&r, "course_title")?)),
            ("courseState", nullable(state)),
            ("liveRevision", live.map_or(Json::Null, Json::int)),
        ])
    } else {
        Json::Null
    };
    Ok(Json::obj([
        (
            "curriculum",
            curriculum.map_or(Json::Null, |i| {
                Json::obj([("slug", Json::str(&i.slug)), ("title", Json::str(&i.title))])
            }),
        ),
        ("lesson", lesson),
        ("reason", Json::String(get(&r, "reason")?)),
        ("chosenBy", Json::String(get(&r, "chosen_by")?)),
        ("chosenAt", Json::String(iso_of(&r, "chosen_at")?)),
    ]))
}

pub fn slot(pool: &Store) -> Result<Json, Refusal> {
    sql::client(pool, featured_slot)
}

/// `LearnHub.featureLesson`: a lesson live to learners in a draft or published course fills the slot.
pub fn feature_lesson(
    pool: &Store,
    input: &Value,
    operator: &str,
    now: i64,
) -> Result<Json, Refusal> {
    let item_id = text(input, "itemId");
    let reason = js_trim(text(input, "reason"));
    sql::begin(pool, |tx| {
        let Some(item) = first(
            tx,
            "SELECT i.kind, i.live_revision, c.state AS course_state \
             FROM academy.course_items i JOIN academy.courses c ON c.id = i.course_id \
             WHERE i.id = $1::text::uuid FOR SHARE OF i, c",
            &[&item_id],
        )?
        else {
            return refuse(
                "no outline item with that id",
                "academy.outline_item_unknown",
            );
        };
        let kind: String = get(&item, "kind")?;
        if kind == "subheader" || kind == "link" {
            return refuse(
                format!("a {kind} holds no lesson"),
                "academy.item_has_no_lesson",
            );
        }
        let state: String = get(&item, "course_state")?;
        if state != "draft" && state != "published" {
            return refuse(
                format!("a {state} course's lessons are not featured"),
                "academy.course_not_editable",
            );
        }
        if opt_int(&item, "live_revision")?.is_none() {
            return refuse(
                "learners see no revision of this lesson, so it is not featured",
                "academy.featured_not_live",
            );
        }
        sql::exec(
            tx,
            "INSERT INTO academy.featured_items (slot, item_slug, course_item_id, reason, chosen_by, chosen_at) \
             VALUES ('hub', NULL, $1::text::uuid, $2::text, $3::text::uuid, $4::text::timestamptz) \
             ON CONFLICT (slot) DO UPDATE SET item_slug = NULL, course_item_id = EXCLUDED.course_item_id, \
               reason = EXCLUDED.reason, chosen_by = EXCLUDED.chosen_by, chosen_at = EXCLUDED.chosen_at",
            &[&item_id, &reason, &operator, &at(now)],
        )?;
        sql::exec(
            tx,
            "INSERT INTO academy.featured_events (slot, action, course_item_id, reason, actor, at) \
             VALUES ('hub', 'featured', $1::text::uuid, $2::text, $3::text::uuid, $4::text::timestamptz)",
            &[&item_id, &reason, &operator, &at(now)],
        )?;
        Ok(())
    })?;
    slot(pool)
}

const CLEAR: &str = "WITH gone AS (DELETE FROM academy.featured_items WHERE slot = 'hub' RETURNING item_slug, course_item_id) \
     INSERT INTO academy.featured_events (slot, action, item_slug, course_item_id, reason, actor, at) \
     SELECT 'hub', 'cleared', item_slug, course_item_id, $1::text, $2::text::uuid, $3::text::timestamptz FROM gone";

/// `LearnHub.clearFeatured`.
pub fn clear_featured(
    pool: &Store,
    input: &Value,
    operator: &str,
    now: i64,
) -> Result<Json, Refusal> {
    let reason = js_trim(text(input, "reason"));
    sql::client(pool, |c| {
        sql::exec(c, CLEAR, &[&reason, &operator, &at(now)])
    })?;
    slot(pool)
}

/// `FeaturedSlot.choose`: the reason first; `itemSlug: null` clears the slot, a slug must be on the spine.
pub fn set_featured(
    pool: &Store,
    input: &Value,
    operator: &str,
    now: i64,
) -> Result<Json, Refusal> {
    let reason = js_trim(text(input, "reason"));
    if reason.is_empty() {
        return refuse("academy.reason_required", "academy.reason_required");
    }
    let Some(raw) = input.get("itemSlug").as_str() else {
        sql::client(pool, |c| {
            sql::exec(c, CLEAR, &[&reason, &operator, &at(now)])
        })?;
        return Ok(Json::obj([
            ("itemSlug", Json::Null),
            ("reason", Json::Null),
            ("chosenAt", Json::Null),
        ]));
    };
    let item = super::release::require_slug(raw)?;
    sql::begin(pool, |tx| {
        sql::exec(
            tx,
            "INSERT INTO academy.featured_items (slot, item_slug, reason, chosen_by, chosen_at) \
             VALUES ('hub', $1::text, $2::text, $3::text::uuid, $4::text::timestamptz) \
             ON CONFLICT (slot) DO UPDATE SET item_slug = EXCLUDED.item_slug, course_item_id = NULL, \
               reason = EXCLUDED.reason, chosen_by = EXCLUDED.chosen_by, chosen_at = EXCLUDED.chosen_at",
            &[&item, &reason, &operator, &at(now)],
        )?;
        sql::exec(
            tx,
            "INSERT INTO academy.featured_events (slot, action, item_slug, reason, actor, at) \
             VALUES ('hub', 'featured', $1::text, $2::text, $3::text::uuid, $4::text::timestamptz)",
            &[&item, &reason, &operator, &at(now)],
        )?;
        Ok(())
    })?;
    Ok(Json::obj([
        ("itemSlug", Json::str(&item)),
        ("reason", Json::str(reason)),
        ("chosenAt", Json::String(iso(now))),
    ]))
}

/// `LearnHub.topics`: the owner's limit before anything is read.
pub fn topics(pool: &Store, limit: Option<i64>) -> Result<Json, Refusal> {
    let Some(limit) = limit else {
        return refuse(
            "the owner has not set how many topics a list shows",
            "academy.topics_list_limit_unset",
        );
    };
    let rows = sql::client(pool, |c| {
        query(
            c,
            &format!(
                "SELECT id::text AS id, slug, name, {} AS created_at FROM academy.topics ORDER BY created_at DESC, slug LIMIT $1::int8",
                ms("created_at")
            ),
            &[&limit],
        )
    })?;
    Ok(Json::obj([
        (
            "topics",
            Json::Array(rows.iter().map(topic_json).collect::<Result<_, _>>()?),
        ),
        ("limit", Json::int(limit)),
    ]))
}

/// `LearnHub.createTopic`: keyed by its address; a repeat with the same name answers with it.
pub fn create_topic(
    pool: &Store,
    input: &Value,
    operator: &str,
    now: i64,
) -> Result<Json, Refusal> {
    let slug = text(input, "slug");
    spine::assert_slug_not_reserved(slug)?;
    let name = js_trim(text(input, "name"));
    let cols = format!(
        "id::text AS id, slug, name, {} AS created_at",
        ms("created_at")
    );
    let created = sql::client(pool, |c| {
        first(
            c,
            &format!(
                "INSERT INTO academy.topics (slug, name, created_by, created_at) \
                 VALUES ($1::text, $2::text, $3::text::uuid, $4::text::timestamptz) ON CONFLICT (slug) DO NOTHING RETURNING {cols}"
            ),
            &[&slug, &name, &operator, &at(now)],
        )
    })?;
    if let Some(r) = created {
        return topic_json(&r);
    }
    let held = sql::client(pool, |c| {
        first(
            c,
            &format!("SELECT {cols} FROM academy.topics WHERE slug = $1::text"),
            &[&slug],
        )
    })?;
    if let Some(h) = held
        && get::<String>(&h, "name")? == name
    {
        return topic_json(&h);
    }
    refuse(
        format!("a topic already has the address \"{slug}\""),
        "academy.topic_slug_taken",
    )
}
