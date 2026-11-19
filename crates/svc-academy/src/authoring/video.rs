//! The stored video library (`video/catalog.ts`, `library.ts`, `entitlement.ts`, `player.ts`): the named spine of
//! videos, the tier and stake gate, signed playback, captions and transcript grants, and the player's settings. Blank
//! storage refuses `academy.video_storage_unconfigured` before anything else; blank gate values refuse closed.

use service_kit::json::Json;
use service_kit::money::{Amount, parse_amount};
use service_kit::schema::js_trim;

use super::refuse;
use super::storage::{self, Storage};
use crate::errors::Refusal;
use crate::ports::Stake;

/// `VideoSpineEntry`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub slug: &'static str,
    pub title: &'static str,
    pub path: &'static str,
    pub object_key: &'static str,
    pub duration_seconds: Option<i64>,
    pub thumbnail_url: Option<&'static str>,
    pub language: Option<&'static str>,
    pub captions_url: Option<&'static str>,
}

/// `VIDEO_SPINE`.
pub const SPINE: [Entry; 1] = [Entry {
    slug: "foundations-risk-first",
    title: "Risk first",
    path: "foundations",
    object_key: "foundations/risk-first.mp4",
    duration_seconds: None,
    thumbnail_url: None,
    language: None,
    captions_url: None,
}];

/// `getVideoSpineItem`.
pub fn get(slug: &str) -> Option<&'static Entry> {
    SPINE.iter().find(|e| e.slug == slug)
}

/// A published transcript (`PublishedTranscript`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transcript {
    pub language: String,
    pub text: String,
}

/// `VIDEO_TRANSCRIPTS`: the shipped spine has none.
pub fn shipped_transcript(_slug: &str) -> Option<Transcript> {
    None
}

fn filled(s: Option<&str>) -> bool {
    s.is_some_and(|v| !js_trim(v).is_empty())
}

/// `transcriptFor`.
pub fn transcript_for(row: Option<&Transcript>) -> Option<Transcript> {
    let r = row?;
    if !filled(Some(&r.language)) || !filled(Some(&r.text)) {
        return None;
    }
    Some(Transcript {
        language: js_trim(&r.language).to_owned(),
        text: r.text.clone(),
    })
}

/// `requireSpineItem`.
pub fn require_spine_item<'a>(slug: &str, spine: &'a [Entry]) -> Result<&'a Entry, Refusal> {
    match spine.iter().find(|e| e.slug == slug) {
        Some(e) => Ok(e),
        None => refuse(
            format!("Video \"{slug}\" is not on the named spine"),
            "academy.video_not_found",
        ),
    }
}

/// `requireWatchThresholdSeconds`.
pub fn require_watch_threshold(v: Option<i64>) -> Result<i64, Refusal> {
    match v {
        Some(t) if t >= 1 => Ok(t),
        _ => refuse(
            "academy.watch_threshold_unset",
            "academy.watch_threshold_unset",
        ),
    }
}

/// `decideWatched`: whether a stored position meets the threshold.
pub fn decide_watched(position: Option<i64>, threshold: Option<i64>) -> Result<bool, Refusal> {
    let t = require_watch_threshold(threshold)?;
    Ok(position.is_some_and(|p| p >= t))
}

/// `VideoGateConfig`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Gate {
    pub min_tier: String,
    pub min_stake: String,
}

const TIERS: [(&str, u8); 4] = [("none", 0), ("basic", 1), ("full", 2), ("institutional", 3)];

fn tier_rank(t: &str) -> Option<u8> {
    TIERS.iter().find(|(n, _)| *n == t).map(|(_, r)| *r)
}

impl Gate {
    /// `isVideoGatePublished`.
    pub fn published(&self) -> bool {
        !js_trim(&self.min_tier).is_empty() && !js_trim(&self.min_stake).is_empty()
    }

    /// `videoGateNeedsStake`.
    pub fn needs_stake(&self) -> bool {
        self.published() && parse_amount(js_trim(&self.min_stake)).is_ok_and(|a| a > 0)
    }
}

fn gate_refuse<T>(message: &str) -> Result<T, Refusal> {
    refuse(message, "academy.video_grant_required")
}

/// `assertVideoEntitled`.
pub fn assert_entitled(gate: &Gate, tier: &str, stake: Amount) -> Result<(), Refusal> {
    if !gate.published() {
        return gate_refuse(
            "Video entitlement magnitudes are unset — owner must publish min tier and min stake; no invent",
        );
    }
    let Some(need) = tier_rank(js_trim(&gate.min_tier)) else {
        return gate_refuse("Video min tier is not a known verification tier");
    };
    let Some(have) = tier_rank(tier) else {
        return gate_refuse("Video caller tier is not a known verification tier");
    };
    if have < need {
        return gate_refuse("Video playback requires a higher verification tier");
    }
    let Ok(threshold) = parse_amount(js_trim(&gate.min_stake)) else {
        return gate_refuse("Video min stake is not a decimal amount");
    };
    if stake < threshold {
        return gate_refuse("Video playback requires a stake at or above the published threshold");
    }
    Ok(())
}

/// The library's parts (`VideoLibraryDeps`).
pub struct Library<'a> {
    pub storage: Option<&'a Storage>,
    pub gate: &'a Gate,
    pub stake: &'a dyn Stake,
}

/// The caller (`VideoCaller`).
pub struct Caller<'a> {
    pub user_id: &'a str,
    pub tier: &'a str,
}

impl Library<'_> {
    /// `listAcademyVideos`.
    pub fn list(&self) -> Result<Json, Refusal> {
        storage::assert_configured(self.storage)?;
        Ok(Json::Array(
            SPINE
                .iter()
                .map(|e| {
                    Json::obj([
                        ("slug", Json::str(e.slug)),
                        ("title", Json::str(e.title)),
                        ("path", Json::str(e.path)),
                        (
                            "durationSeconds",
                            e.duration_seconds.map_or(Json::Null, Json::int),
                        ),
                        (
                            "thumbnailUrl",
                            e.thumbnail_url.map_or(Json::Null, Json::str),
                        ),
                        ("language", e.language.map_or(Json::Null, Json::str)),
                        ("captionsUrl", e.captions_url.map_or(Json::Null, Json::str)),
                        ("captionsPublished", Json::Bool(filled(e.captions_url))),
                        (
                            "transcriptPublished",
                            Json::Bool(
                                transcript_for(shipped_transcript(e.slug).as_ref()).is_some(),
                            ),
                        ),
                    ])
                })
                .collect(),
        ))
    }

    /// The public list: slug, title and path.
    pub fn public_list(&self) -> Result<Json, Refusal> {
        storage::assert_configured(self.storage)?;
        Ok(Json::Array(
            SPINE
                .iter()
                .map(|e| {
                    Json::obj([
                        ("slug", Json::str(e.slug)),
                        ("title", Json::str(e.title)),
                        ("path", Json::str(e.path)),
                    ])
                })
                .collect(),
        ))
    }

    /// `entitle`: storage, then the stake when the gate needs it, then the gate.
    pub fn entitle(&self, caller: &Caller<'_>) -> Result<&Storage, Refusal> {
        let s = storage::assert_configured(self.storage)?;
        let stake = if self.gate.needs_stake() {
            self.stake.stake_of(caller.user_id)?
        } else {
            0
        };
        assert_entitled(self.gate, caller.tier, stake)?;
        Ok(s)
    }

    /// `grantAcademyVideoPlayback`: storage, then the spine, then the gate.
    pub fn playback(&self, slug: &str, caller: &Caller<'_>, now: i64) -> Result<Json, Refusal> {
        let s = storage::assert_configured(self.storage)?;
        let Some(item) = get(slug) else {
            return refuse(
                format!("Video \"{slug}\" is not on the named spine"),
                "academy.video_grant_required",
            );
        };
        let stake = if self.gate.needs_stake() {
            self.stake.stake_of(caller.user_id)?
        } else {
            0
        };
        assert_entitled(self.gate, caller.tier, stake)?;
        let issued = storage::sign_get(s, item.object_key, now)?;
        let bound = format!("{}|{}|{}", caller.user_id, item.slug, item.object_key);
        Ok(Json::obj([
            ("slug", Json::str(item.slug)),
            ("playbackUrl", Json::str(&issued.url)),
            (
                "expiresAt",
                Json::String(super::sql::iso(issued.expires_at)),
            ),
            (
                "grant",
                Json::String(storage::issue_grant(
                    &s.secret_key,
                    &bound,
                    issued.expires_at,
                )),
            ),
        ]))
    }

    /// `grantAcademyVideoCaptions`.
    pub fn captions(
        &self,
        slug: &str,
        caller: &Caller<'_>,
        now: i64,
        spine: &[Entry],
    ) -> Result<Json, Refusal> {
        let s = self.entitle(caller)?;
        let item = require_spine_item(slug, spine)?;
        let Some(url) = item.captions_url.filter(|u| filled(Some(u))) else {
            return refuse(
                "academy.video_captions_unpublished",
                "academy.video_captions_unpublished",
            );
        };
        let url = js_trim(url);
        let language = item.language.filter(|l| filled(Some(l))).map(js_trim);
        let issued = storage::sign_get(s, url, now)?;
        let bound = format!("{}|{}|captions|{url}", caller.user_id, item.slug);
        Ok(Json::obj([
            ("slug", Json::str(item.slug)),
            ("captionsUrl", Json::str(&issued.url)),
            ("language", language.map_or(Json::Null, Json::str)),
            (
                "expiresAt",
                Json::String(super::sql::iso(issued.expires_at)),
            ),
            (
                "grant",
                Json::String(storage::issue_grant(
                    &s.secret_key,
                    &bound,
                    issued.expires_at,
                )),
            ),
        ]))
    }

    /// `grantAcademyVideoTranscript`.
    pub fn transcript(
        &self,
        slug: &str,
        caller: &Caller<'_>,
        now: i64,
        spine: &[Entry],
        transcripts: &dyn Fn(&str) -> Option<Transcript>,
    ) -> Result<Json, Refusal> {
        let s = self.entitle(caller)?;
        let item = require_spine_item(slug, spine)?;
        let Some(t) = transcript_for(transcripts(item.slug).as_ref()) else {
            return refuse(
                "academy.video_transcript_unpublished",
                "academy.video_transcript_unpublished",
            );
        };
        let issued = storage::sign_get(s, &format!("transcripts/{}.txt", item.slug), now)?;
        let bound = format!("{}|{}|transcript|{}", caller.user_id, item.slug, t.language);
        Ok(Json::obj([
            ("slug", Json::str(item.slug)),
            ("language", Json::str(&t.language)),
            ("text", Json::str(&t.text)),
            ("transcriptUrl", Json::str(&issued.url)),
            (
                "expiresAt",
                Json::String(super::sql::iso(issued.expires_at)),
            ),
            (
                "grant",
                Json::String(storage::issue_grant(
                    &s.secret_key,
                    &bound,
                    issued.expires_at,
                )),
            ),
        ]))
    }

    /// `assertAcademyVideoUrlGranted`.
    pub fn assert_url_granted(&self, url: &str, now: i64) -> Result<(), Refusal> {
        let s = storage::assert_configured(self.storage)?;
        if url.is_empty() || !url.contains("X-Amz-Signature=") {
            return refuse("Video URL without grant", "academy.video_grant_required");
        }
        storage::assert_playback_url_granted(s, url, now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::FixedStake;

    fn code<T>(r: Result<T, Refusal>) -> String {
        match r {
            Err(Refusal::Academy(e)) => e.code,
            _ => "ok".to_owned(),
        }
    }

    #[test]
    fn the_gate_refuses_closed_on_blank_values() {
        let blank = Gate::default();
        assert!(!blank.needs_stake());
        assert_eq!(
            code(assert_entitled(&blank, "full", 0)),
            "academy.video_grant_required"
        );
        let g = Gate {
            min_tier: "basic".into(),
            min_stake: "10".into(),
        };
        assert!(g.needs_stake());
        assert_eq!(
            code(assert_entitled(&g, "none", 100_000_000_000_000_000_000)),
            "academy.video_grant_required"
        );
        assert_eq!(
            code(assert_entitled(&g, "basic", 0)),
            "academy.video_grant_required"
        );
        let zero = Gate {
            min_tier: "basic".into(),
            min_stake: "0".into(),
        };
        assert!(!zero.needs_stake());
        assert_eq!(code(assert_entitled(&zero, "basic", 0)), "ok");
    }

    #[test]
    fn no_storage_refuses_before_the_spine() {
        let gate = Gate::default();
        let lib = Library {
            storage: None,
            gate: &gate,
            stake: &FixedStake(0),
        };
        assert_eq!(code(lib.list()), "academy.video_storage_unconfigured");
        assert_eq!(
            code(lib.playback(
                "nope",
                &Caller {
                    user_id: "u",
                    tier: "full"
                },
                0
            )),
            "academy.video_storage_unconfigured"
        );
    }
}
