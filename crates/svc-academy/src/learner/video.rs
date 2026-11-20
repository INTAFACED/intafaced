//! The learner's playback gate (`video/library.ts` `assertAcademyVideoEntitled`): the video library's own. The named video spine, the items a
//! video is attached to and the watch threshold are authoring's reads ([`crate::authoring::video`],
//! [`crate::authoring::tracks`]).

use super::sql::Pool;

use super::sql;
use crate::authoring::storage::Storage;
use crate::authoring::{tracks, video as library};
use crate::errors::Refusal;
use crate::ports::Ports;

/// `getVideoSpineItem(slug)`, or `academy.video_not_found` as `requireSpineItem` words it.
pub fn require_spine_item(slug: &str) -> Result<&'static library::Entry, Refusal> {
    library::require_spine_item(slug, &library::SPINE)
}

/// `VideoTracks.itemVideo`.
pub fn item_video(pool: &Pool, item_slug: &str) -> Result<Option<String>, Refusal> {
    sql::on_pool(pool, |c| tracks::item_video(c, item_slug))
}

/// `VideoTracks.itemsWithVideo(videoSlug)`.
pub fn items_with_video(pool: &Pool, video_slug: &str) -> Result<Vec<String>, Refusal> {
    sql::on_pool(pool, |c| tracks::items_with_video(c, video_slug))
}

/// `assertAcademyVideoEntitled(video, { userId, tier })`: the video library's own gate
/// ([`library::Library::entitle`]): the store configured (`ACADEMY_VIDEO_S3_*`), the stake read when the published
/// minimum is above zero, then the tier and the stake against the owner's gate (`ACADEMY_VIDEO_MIN_TIER`,
/// `ACADEMY_VIDEO_MIN_STAKE`). Blank owner values refuse closed.
pub fn assert_entitled(
    ports: &Ports,
    storage: Option<&Storage>,
    gate: &library::Gate,
    user_id: &str,
    tier: &str,
) -> Result<(), Refusal> {
    library::Library {
        storage,
        gate,
        stake: ports.stake.as_ref(),
    }
    .entitle(&library::Caller { user_id, tier })
    .map(|_| ())
}
