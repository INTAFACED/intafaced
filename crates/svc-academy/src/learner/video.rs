//! What the learner's video calls read besides their own rows: the named video spine (`video/catalog.ts`), the items
//! a video is attached to (`video/tracks.ts` `VideoTracks`' reads), the owner's watch threshold (`video/player.ts`) and
//! the playback gate (`video/library.ts` `assertAcademyVideoEntitled`, `video/entitlement.ts`).

use service_kit::money::parse_amount;
use super::sql::Pool;

use super::sql::{self, cell, column, first, q};
use crate::errors::{AcademyError, Refusal};
use crate::ports::Ports;

/// `VideoSpineEntry`, the fields the learner calls read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpineVideo {
    pub slug: &'static str,
    pub title: &'static str,
    pub path: &'static str,
    pub duration_seconds: Option<i64>,
}

/// `VIDEO_SPINE`, entry for entry.
pub const VIDEO_SPINE: [SpineVideo; 1] = [SpineVideo {
    slug: "foundations-risk-first",
    title: "Risk first",
    path: "foundations",
    duration_seconds: None,
}];

/// `getVideoSpineItem(slug)`.
pub fn spine_item(slug: &str) -> Option<&'static SpineVideo> {
    VIDEO_SPINE.iter().find(|v| v.slug == slug)
}

/// `academy.video_not_found`, as `requireSpineItem` and the customer store word it.
pub fn not_on_spine(slug: &str) -> Refusal {
    AcademyError::new(
        format!("Video \"{slug}\" is not on the named spine"),
        "academy.video_not_found",
    )
    .into()
}

/// `requireWatchThresholdSeconds`.
pub fn require_threshold(value: Option<i64>) -> Result<i64, Refusal> {
    match value {
        Some(v) if v >= 1 => Ok(v),
        _ => Err(AcademyError::new(
            "academy.watch_threshold_unset",
            "academy.watch_threshold_unset",
        )
        .into()),
    }
}

/// `VideoTracks.itemVideo`.
pub fn item_video(pool: &Pool, item_slug: &str) -> Result<Option<String>, Refusal> {
    sql::on_pool(pool, |c| {
        first(
            c,
            "SELECT video_slug FROM academy.item_videos WHERE item_slug = $1",
            &[&item_slug],
        )?
        .map(|r| cell(&r, 0))
        .transpose()
    })
}

/// `VideoTracks.itemVideos(slugs)`: item → video for the given items.
pub fn item_videos(pool: &Pool, item_slugs: &[String]) -> Result<Vec<(String, String)>, Refusal> {
    if item_slugs.is_empty() {
        return Ok(Vec::new());
    }
    let rows = sql::on_pool(pool, |c| {
        q(
            c,
            "SELECT item_slug, video_slug FROM academy.item_videos WHERE item_slug = ANY($1)",
            &[&item_slugs],
        )
    })?;
    rows.iter()
        .map(|r| Ok((cell(r, 0)?, cell(r, 1)?)))
        .collect()
}

/// `VideoTracks.itemsWithVideo(videoSlug)`.
pub fn items_with_video(pool: &Pool, video_slug: &str) -> Result<Vec<String>, Refusal> {
    let rows = sql::on_pool(pool, |c| {
        q(
            c,
            "SELECT item_slug FROM academy.item_videos WHERE video_slug = $1 ORDER BY item_slug",
            &[&video_slug],
        )
    })?;
    column(&rows)
}

/// `TIER_ORDER`.
fn tier_rank(tier: &str) -> Option<u8> {
    match tier {
        "none" => Some(0),
        "basic" => Some(1),
        "full" => Some(2),
        "institutional" => Some(3),
        _ => None,
    }
}

fn grant_required(message: &str) -> Refusal {
    AcademyError::new(message, "academy.video_grant_required").into()
}

/// `assertAcademyVideoEntitled(video, { userId, tier })`: the store configured, the stake read when the published
/// minimum is above zero, then the tier and the stake against the owner's gate (`ACADEMY_VIDEO_MIN_TIER`,
/// `ACADEMY_VIDEO_MIN_STAKE`). Blank owner values refuse closed.
pub fn assert_entitled(
    ports: &Ports,
    min_tier: &str,
    min_stake: &str,
    user_id: &str,
    tier: &str,
) -> Result<(), Refusal> {
    if !ports.objects.configured() {
        return Err(AcademyError::new(
            "Video object storage is not configured — set ACADEMY_VIDEO_S3_ENDPOINT, bucket, and keys (or leave off)",
            "academy.video_storage_unconfigured",
        )
        .into());
    }
    let min_tier = service_kit::schema::js_trim(min_tier);
    let min_stake = service_kit::schema::js_trim(min_stake);
    let published = !min_tier.is_empty() && !min_stake.is_empty();
    let needs_stake = published && parse_amount(min_stake).is_ok_and(|t| t > 0);
    let stake = if needs_stake {
        ports.stake.stake_of(user_id)?
    } else {
        0
    };
    if !published {
        return Err(grant_required(
            "Video entitlement magnitudes are unset — owner must publish min tier and min stake; no invent",
        ));
    }
    let Some(need) = tier_rank(min_tier) else {
        return Err(grant_required(
            "Video min tier is not a known verification tier",
        ));
    };
    let Some(have) = tier_rank(tier) else {
        return Err(grant_required(
            "Video caller tier is not a known verification tier",
        ));
    };
    if have < need {
        return Err(grant_required(
            "Video playback requires a higher verification tier",
        ));
    }
    let Ok(threshold) = parse_amount(min_stake) else {
        return Err(grant_required("Video min stake is not a decimal amount"));
    };
    if stake < threshold {
        return Err(grant_required(
            "Video playback requires a stake at or above the published threshold",
        ));
    }
    Ok(())
}
