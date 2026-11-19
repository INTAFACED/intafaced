//! The video tests (AC-videos-01): `video/entitlement.test.ts`, `video/library.test.ts`, `video/player.test.ts`,
//! `video/tracks.test.ts` and `video/item-video.db.test.ts` (against a real Postgres).
//!
//! `item-video.db.test.ts` builds its service over a TEST spine (`test-video` on the markets path); the crate's spine is
//! the shipped one, so the spine check is the dispatch's (`spineVideo`, asserted through the door below) and the stores
//! are called with the TEST slug directly. Watch progress and completions are the learner slice's calls
//! (`setVideoProgress`, `markCurriculumComplete`, `undoCurriculumComplete`) and a quiz is the assessment slice's
//! (`setQuiz`); the rows they leave are written here, and what the outline (this slice's `courseOutline`) shows for
//! them is asserted. Whether a save completes an item, and the playback gate on saving, are those slices' tests.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod authoring_kit;

use authoring_kit::{TestDb, at, code, data, door, equals, iso, matches, message, principal, query, s, store, v};
use service_kit::json::Json;
use service_kit::money::parse_amount;
use svc_academy::authoring::storage::Storage;
use svc_academy::authoring::tracks::{self, Cue, TrackIn};
use svc_academy::authoring::video::{self, Caller, Entry, Gate, Library, Transcript};
use svc_academy::authoring::{outline, release};
use svc_academy::curriculum::spine;
use svc_academy::db::Store;
use svc_academy::errors::Refusal;
use svc_academy::ports::{FixedStake, Ports};
use svc_academy::settings::Settings;

const USER: &str = "11111111-1111-4111-8111-111111111111";
const SLUG: &str = "foundations-risk-first";

fn gate(min_tier: &str, min_stake: &str) -> Gate {
    Gate { min_tier: min_tier.into(), min_stake: min_stake.into() }
}

fn amount(s: &str) -> i128 {
    parse_amount(s).unwrap()
}

// ── video/entitlement.test.ts ───────────────────────────────────────────────────────────────────────────────────────

fn refused(r: Result<(), Refusal>) {
    assert_eq!(code(r), "academy.video_grant_required");
}

#[test]
fn refuses_a_constructor_tier_whatever_the_published_min_tier() {
    for min in ["none", "basic", "full", "institutional"] {
        refused(video::assert_entitled(&gate(min, "1"), "constructor", amount("1")));
    }
}

#[test]
fn refuses_a_caller_below_the_published_min_tier() {
    refused(video::assert_entitled(&gate("basic", "0"), "none", amount("1")));
    refused(video::assert_entitled(&gate("full", "0"), "basic", amount("1")));
    refused(video::assert_entitled(&gate("institutional", "0"), "full", amount("1")));
}

#[test]
fn passes_a_caller_at_or_above_the_published_min_tier_when_the_stake_meets_the_threshold() {
    video::assert_entitled(&gate("none", "1"), "none", amount("1")).unwrap();
    video::assert_entitled(&gate("basic", "1"), "basic", amount("1")).unwrap();
    video::assert_entitled(&gate("full", "1"), "institutional", amount("1")).unwrap();
}

#[test]
fn refuses_a_stake_below_the_published_threshold() {
    refused(video::assert_entitled(&gate("none", "2"), "institutional", amount("1")));
}

#[test]
fn refuses_a_blank_min_tier_and_a_blank_min_stake() {
    refused(video::assert_entitled(&gate("", "1"), "institutional", amount("1")));
    refused(video::assert_entitled(&gate("   ", "1"), "institutional", amount("1")));
    refused(video::assert_entitled(&gate("none", ""), "none", amount("1")));
    refused(video::assert_entitled(&gate("none", "   "), "none", amount("1")));
}

#[test]
fn reads_the_stake_only_when_a_published_minimum_above_zero_could_refuse_it() {
    assert!(gate("basic", "10").needs_stake());
    assert!(!gate("none", "0").needs_stake());
    assert!(!gate("none", "0.000").needs_stake());
    // Unpublished or unparseable: the gate refuses by itself, so the stake source is not asked.
    assert!(!gate("", "").needs_stake());
    assert!(!gate("basic", "lots").needs_stake());
}

// ── video/library.test.ts ───────────────────────────────────────────────────────────────────────────────────────────

const NOW: &str = "2026-08-23T12:00:00.000Z";

fn s3() -> Storage {
    Storage {
        endpoint: "http://academy-minio:9000".into(),
        bucket: "academy-video".into(),
        access_key: "academyvideo".into(),
        secret_key: "academyvideo-secret-key".into(),
        region: "us-east-1".into(),
        ttl_seconds: Some(300),
    }
}

fn caller(tier: &str) -> Caller<'_> {
    Caller { user_id: USER, tier }
}

const TEST_SPINE: [Entry; 1] = [Entry {
    slug: SLUG,
    title: "Risk first",
    path: "foundations",
    object_key: "foundations/risk-first.mp4",
    duration_seconds: Some(30),
    thumbnail_url: None,
    language: Some("en"),
    captions_url: Some("captions/risk-first.vtt"),
}];

fn transcripts(slug: &str) -> Option<Transcript> {
    (slug == SLUG).then(|| Transcript { language: "en".into(), text: "TEST transcript.".into() })
}

#[test]
fn list_refuses_unconfigured_when_storage_is_off_and_a_blank_endpoint_is_unconfigured() {
    let g = gate("none", "0");
    let stake = FixedStake(amount("1"));
    assert_eq!(code(Library { storage: None, gate: &g, stake: &stake }.list()), "academy.video_storage_unconfigured");
    let blank = Storage { endpoint: String::new(), ..s3() };
    assert_eq!(code(Library { storage: Some(&blank), gate: &g, stake: &stake }.list()), "academy.video_storage_unconfigured");
}

#[test]
fn the_configured_list_returns_the_named_spine_and_never_a_playback_url() {
    let (sg, g, stake) = (s3(), gate("none", "0"), FixedStake(amount("1")));
    let items = Library { storage: Some(&sg), gate: &g, stake: &stake }.list().unwrap();
    assert!(authoring_kit::len(&items, "") >= 1);
    matches(
        authoring_kit::at_path(&items, "0"),
        &format!(r#"{{"slug":"{SLUG}","captionsPublished":false,"transcriptPublished":false,"captionsUrl":null}}"#),
    );
    assert!(!items.compact().contains("X-Amz-Signature"));
}

#[test]
fn playback_issues_a_signed_expiring_url_after_the_gate_and_the_url_expires() {
    let (sg, g, stake) = (s3(), gate("none", "0"), FixedStake(amount("1")));
    let lib = Library { storage: Some(&sg), gate: &g, stake: &stake };
    let play = lib.playback(SLUG, &caller("none"), at(NOW)).unwrap();
    let url = s(&play, "playbackUrl");
    assert!(url.contains("X-Amz-Signature="));
    assert!(url.contains("X-Amz-Expires=300"));
    assert_eq!(s(&play, "expiresAt"), "2026-08-23T12:05:00.000Z");
    assert!(s(&play, "grant").starts_with("v1."));
    lib.assert_url_granted(&url, at(NOW)).unwrap();
    assert_eq!(code(lib.assert_url_granted(&url, at(NOW) + 301_000)), "academy.video_grant_required");
}

#[test]
fn a_url_without_a_grant_fails_by_name() {
    let (sg, g, stake) = (s3(), gate("none", "0"), FixedStake(amount("1")));
    let lib = Library { storage: Some(&sg), gate: &g, stake: &stake };
    assert_eq!(
        code(lib.assert_url_granted("http://academy-minio:9000/academy-video/foundations/risk-first.mp4", at(NOW))),
        "academy.video_grant_required"
    );
}

#[test]
fn captions_and_transcript_use_the_playback_gate_and_return_a_signed_url() {
    let (sg, stake) = (s3(), FixedStake(amount("1")));
    let blank = gate("", "");
    let refused = Library { storage: Some(&sg), gate: &blank, stake: &stake };
    assert_eq!(code(refused.captions(SLUG, &caller("none"), at(NOW), &TEST_SPINE)), "academy.video_grant_required");
    let g = gate("none", "0");
    let lib = Library { storage: Some(&sg), gate: &g, stake: &stake };
    let captions = lib.captions(SLUG, &caller("none"), at(NOW), &TEST_SPINE).unwrap();
    assert!(s(&captions, "captionsUrl").contains("X-Amz-Signature="));
    assert_ne!(s(&captions, "captionsUrl"), "captions/risk-first.vtt");
    assert!(s(&captions, "grant").starts_with("v1."));
    let transcript = lib.transcript(SLUG, &caller("none"), at(NOW), &TEST_SPINE, &transcripts).unwrap();
    assert!(s(&transcript, "transcriptUrl").contains("X-Amz-Signature="));
    assert_eq!(s(&transcript, "text"), "TEST transcript.");
}

#[test]
fn an_unknown_slug_blank_magnitudes_and_a_tier_or_stake_shortfall_are_not_a_grant() {
    let (sg, stake) = (s3(), FixedStake(amount("1")));
    let play = |g: &Gate, tier: &str, slug: &str| Library { storage: Some(&sg), gate: g, stake: &stake }.playback(slug, &caller(tier), at(NOW));
    assert_eq!(code(play(&gate("none", "0"), "none", "not-a-video")), "academy.video_grant_required");
    assert_eq!(code(play(&gate("", ""), "none", SLUG)), "academy.video_grant_required");
    assert_eq!(code(play(&gate("full", "0"), "none", SLUG)), "academy.video_grant_required");
    assert_eq!(code(play(&gate("none", "10"), "none", SLUG)), "academy.video_grant_required");
}

#[test]
fn a_caller_below_a_published_gate_or_stake_is_refused_captions_and_transcript() {
    let sg = s3();
    for (tier, g, stake) in [
        ("none", gate("full", "0"), amount("1")),
        ("basic", gate("full", "0"), amount("1")),
        ("full", gate("full", "1"), amount("0")),
    ] {
        let st = FixedStake(stake);
        let lib = Library { storage: Some(&sg), gate: &g, stake: &st };
        assert_eq!(code(lib.captions(SLUG, &caller(tier), at(NOW), &TEST_SPINE)), "academy.video_grant_required");
        assert_eq!(code(lib.transcript(SLUG, &caller(tier), at(NOW), &TEST_SPINE, &transcripts)), "academy.video_grant_required");
    }
}

#[test]
fn an_unset_or_zero_ttl_and_an_unset_or_blank_region_refuse_by_name_and_published_values_sign() {
    let (g, stake) = (gate("none", "0"), FixedStake(amount("1")));
    let play = |sg: &Storage| Library { storage: Some(sg), gate: &g, stake: &stake }.playback(SLUG, &caller("none"), at(NOW));
    assert_eq!(code(play(&Storage { ttl_seconds: None, ..s3() })), "academy.video_url_ttl_unset");
    assert_eq!(code(play(&Storage { ttl_seconds: Some(0), ..s3() })), "academy.video_url_ttl_unset");
    let short = play(&Storage { ttl_seconds: Some(120), ..s3() }).unwrap();
    assert!(s(&short, "playbackUrl").contains("X-Amz-Expires=120"));
    assert!(!s(&short, "playbackUrl").contains("X-Amz-Expires=300"));
    assert_eq!(s(&short, "expiresAt"), "2026-08-23T12:02:00.000Z");
    assert_eq!(code(play(&Storage { region: String::new(), ..s3() })), "academy.video_s3_region_unset");
    assert_eq!(code(play(&Storage { region: "   ".into(), ..s3() })), "academy.video_s3_region_unset");
    let eu = play(&Storage { region: "eu-west-1".into(), ..s3() }).unwrap();
    assert!(s(&eu, "playbackUrl").contains("eu-west-1"));
    assert!(!s(&eu, "playbackUrl").contains("us-east-1"));
}

// ── video/player.test.ts ────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn the_shipped_spine_publishes_neither_a_captions_url_nor_a_transcript() {
    let (sg, g, stake) = (s3(), gate("none", "0"), FixedStake(0));
    let lib = Library { storage: Some(&sg), gate: &g, stake: &stake };
    assert_eq!(code(lib.captions(SLUG, &caller("none"), at(NOW), &video::SPINE)), "academy.video_captions_unpublished");
    assert_eq!(
        code(lib.transcript(SLUG, &caller("none"), at(NOW), &video::SPINE, &video::shipped_transcript)),
        "academy.video_transcript_unpublished"
    );
    assert!(video::shipped_transcript(SLUG).is_none());
}

#[test]
fn an_unknown_slug_is_not_found_and_a_blank_track_is_unpublished() {
    let (sg, g, stake) = (s3(), gate("none", "0"), FixedStake(0));
    let lib = Library { storage: Some(&sg), gate: &g, stake: &stake };
    let c = caller("none");
    assert_eq!(code(lib.captions("not-a-video", &c, at(NOW), &video::SPINE)), "academy.video_not_found");
    assert_eq!(code(lib.transcript("not-a-video", &c, at(NOW), &video::SPINE, &transcripts)), "academy.video_not_found");
    let blank_language = |slug: &str| (slug == SLUG).then(|| Transcript { language: " ".into(), text: "TEST".into() });
    assert_eq!(code(lib.transcript(SLUG, &c, at(NOW), &TEST_SPINE, &blank_language)), "academy.video_transcript_unpublished");
    let blank_url = [Entry { captions_url: Some("  "), ..TEST_SPINE[0].clone() }];
    assert_eq!(code(lib.captions(SLUG, &c, at(NOW), &blank_url)), "academy.video_captions_unpublished");
}

#[test]
fn a_published_test_track_is_returned_with_no_invented_language() {
    let (sg, g, stake) = (s3(), gate("none", "0"), FixedStake(0));
    let lib = Library { storage: Some(&sg), gate: &g, stake: &stake };
    let c = caller("none");
    let with = [Entry { captions_url: Some("https://example.test/captions.vtt"), ..TEST_SPINE[0].clone() }];
    let read = lib.captions(SLUG, &c, at(NOW), &with).unwrap();
    assert_eq!(s(&read, "slug"), SLUG);
    assert_eq!(s(&read, "language"), "en");
    let without = [Entry { language: None, ..with[0].clone() }];
    assert!(authoring_kit::is_null(&lib.captions(SLUG, &c, at(NOW), &without).unwrap(), "language"));
    let player = |slug: &str| (slug == SLUG).then(|| Transcript { language: "en".into(), text: "TEST transcript. Not owner content.".into() });
    assert_eq!(s(&lib.transcript(SLUG, &c, at(NOW), &TEST_SPINE, &player).unwrap(), "text"), "TEST transcript. Not owner content.");
}

#[test]
fn a_blank_watch_threshold_refuses_including_zero_and_a_fraction() {
    assert_eq!(code(video::require_watch_threshold(None)), "academy.watch_threshold_unset");
    assert_eq!(code(video::require_watch_threshold(Some(0))), "academy.watch_threshold_unset");
    // A fraction is not an integer setting: `ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS=1.5` reads as unset.
    let settings = Settings(Json::Object(vec![("ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS".to_owned(), Json::Number(1.5))]));
    let options = svc_academy::authoring::Options::from_settings(&settings);
    assert_eq!(code(video::require_watch_threshold(options.video_watch_threshold_seconds)), "academy.watch_threshold_unset");
}

#[test]
fn watched_uses_the_stored_position_and_does_not_lower_the_threshold_to_the_duration() {
    assert!(!video::decide_watched(None, Some(15)).unwrap());
    assert!(video::decide_watched(Some(15), Some(15)).unwrap());
    assert!(!video::decide_watched(Some(30), Some(40)).unwrap());
}

#[test]
fn captions_and_transcript_refuse_through_the_door_when_storage_is_unconfigured() {
    let Some((db, _st)) = store() else { return };
    let d = door(&db, Settings::empty(), Ports::unwired());
    let h = principal(USER, &["academy:read", "academy:write"], "none");
    for (path, slug) in [("videoCaptions", SLUG), ("videoTranscript", SLUG), ("videoCaptions", "missing")] {
        let answer = query(&d, &h, path, Some(&Json::obj([("slug", Json::str(slug))])));
        assert_eq!(answer.0, 412, "{}", answer.1.compact());
        assert!(answer.1.compact().contains("academy.video_storage_unconfigured"), "{}", answer.1.compact());
    }
}

// ── video/tracks.test.ts ────────────────────────────────────────────────────────────────────────────────────────────

fn cue(start_ms: i64, end_ms: i64, text: &str) -> Cue {
    Cue { start_ms, end_ms, text: text.into() }
}

#[test]
fn parse_vtt_reads_cues_with_hours_identifiers_settings_and_a_bom_skipping_note_and_style_in_start_order() {
    let vtt = "\u{feff}WEBVTT - TEST\r\n\r\nSTYLE\r\n::cue { color: red }\r\n\r\nb\r\n01:00:01.000 --> 01:00:02.000 line:0\r\nTEST later\r\ntwo lines\r\n\r\nNOTE skip me\r\n\r\n00:00.250 --> 00:01.000\r\nTEST first\r\n";
    assert_eq!(tracks::parse_vtt(vtt).unwrap(), [cue(250, 1000, "TEST first"), cue(3_601_000, 3_602_000, "TEST later\ntwo lines")]);
}

#[test]
fn parse_vtt_skips_header_lines_up_to_the_first_blank_line_and_a_header_alone_has_no_cues() {
    assert_eq!(
        tracks::parse_vtt("WEBVTT\nKind: captions\nLanguage: en\n\n00:00.000 --> 00:01.000\nTEST <i>one</i>\n").unwrap(),
        [cue(0, 1000, "TEST <i>one</i>")]
    );
    assert_eq!(tracks::parse_vtt("WEBVTT\n").unwrap(), []);
}

#[test]
fn parse_vtt_refuses_each_broken_file_with_captions_invalid() {
    for vtt in [
        "TEST\n\n00:00.000 --> 00:01.000\nx",
        "WEBVTTX\n",
        "WEBVTT\n\nhello\nworld",
        "WEBVTT\n\n0:0.0 --> 00:01.000\nx",
        "WEBVTT\n\n00:01.000 --> 00:01.000\nx",
        "WEBVTT\n00:00.000 --> 00:01.000\nx",
    ] {
        assert_eq!(code(tracks::parse_vtt(vtt)), "academy.captions_invalid", "{vtt:?}");
    }
}

#[test]
fn parse_srt_reads_numbered_cues_sorted_and_names_the_first_line_that_breaks_the_shape() {
    assert_eq!(
        tracks::parse_srt("\u{feff}2\r\n00:00:05,000 --> 00:00:06,000\r\nB\r\n\r\n1\r\n00:00:01,000 --> 00:00:02,500\r\nA\r\nA2\r\n").unwrap(),
        [cue(1000, 2500, "A\nA2"), cue(5000, 6000, "B")]
    );
    let why = |srt: &str| message(tracks::parse_srt(srt));
    assert!(why("1\n00:00:01,000 --> 00:00:02,000\nA\n\nx\n").contains(r#"line 5: "x" is not a cue number"#));
    assert!(why("1\n00:00:01.000 --> 00:00:02,000\nA\n").contains(r#"line 2: "00:00:01.000" is not an SRT timestamp"#));
    assert!(why("1\n00:00:03,000 --> 00:00:02,000\nA\n").contains("line 2: a cue ends before it starts"));
    assert!(why("1\n00:00:01,000 --> 00:00:02,000\n").contains("line 2: a cue has no text"));
    assert!(why("1\nno timing\n").contains("line 2: a cue has no timing line"));
    assert!(why("").contains("the file has no cues"));
}

// ── video/item-video.db.test.ts ─────────────────────────────────────────────────────────────────────────────────────

const STAFF: &str = "44444444-4444-4444-8444-444444444444";
const EN: &str = "WEBVTT\n\nNOTE TEST captions\n\n1\n00:00.000 --> 00:02.500\nTEST: the first line\n\n00:02.500 --> 00:05.000 align:start\nTEST: the second line\n";
const ES: &str = "WEBVTT\n\n00:00.000 --> 00:05.000\nTEST: la primera línea\n";

fn markets() -> (String, String) {
    let rows = spine::list(Some("markets"), None);
    (rows[0].slug.clone(), rows[1].slug.clone())
}

fn set_tracks(st: &Store, given: &[(&str, &str, &str)]) -> Result<Vec<tracks::Track>, Refusal> {
    let input: Vec<TrackIn<'_>> = given.iter().map(|(language, label, vtt)| TrackIn { language, label, vtt }).collect();
    tracks::set_tracks(st, "test-video", &input, STAFF, "TEST captions", svc_academy::door::system_now().0)
}

#[test]
fn lists_caption_tracks_as_cues_in_the_order_staff_gave_refuses_a_bad_file_or_a_repeated_language_and_empty_removes_them() {
    let Some((_db, st)) = store() else { return };
    assert!(tracks::tracks(&st, "test-video").unwrap().is_empty());
    set_tracks(&st, &[("en", "TEST English", EN), ("es", "TEST Español", ES)]).unwrap();
    let saved = tracks::tracks(&st, "test-video").unwrap();
    assert_eq!(
        saved.iter().map(|t| (t.language.as_str(), t.label.as_str(), t.cues.len())).collect::<Vec<_>>(),
        [("en", "TEST English", 2), ("es", "TEST Español", 1)]
    );
    assert_eq!(saved[0].cues[1], cue(2500, 5000, "TEST: the second line"));
    for vtt in ["00:00.000 --> 00:01.000\nno header", "WEBVTT\n\n00:02.000 --> 00:01.000\nbackwards", "WEBVTT\n\n00:00.000 --> 00:01.000\n"] {
        assert_eq!(code(set_tracks(&st, &[("en", "x", vtt)])), "academy.captions_invalid");
    }
    assert_eq!(code(set_tracks(&st, &[("en", "a", EN), ("en", "b", EN)])), "academy.captions_invalid");
    assert_eq!(tracks::tracks(&st, "test-video").unwrap().len(), 2);
    set_tracks(&st, &[]).unwrap();
    assert!(tracks::tracks(&st, "test-video").unwrap().is_empty());
}

fn outline_row(st: &Store, item: &str, threshold: Option<i64>) -> Json {
    let o = outline::course_outline(st, USER, item, svc_academy::door::system_now().0, threshold).unwrap();
    authoring_kit::at_path(&o, "items.1").clone()
}

fn watch(db: &TestDb, seconds: i32) {
    db.client()
        .execute(
            "INSERT INTO academy.video_progress (user_id, video_slug, position_seconds, updated_at) VALUES ($1::text::uuid, 'test-video', $2::int4, now()) \
             ON CONFLICT (user_id, video_slug) DO UPDATE SET position_seconds = EXCLUDED.position_seconds",
            &[&USER, &seconds],
        )
        .unwrap();
}

#[test]
fn an_item_with_a_video_follows_the_watch_rule_in_the_outline_and_taking_it_off_returns_the_view_rule() {
    let Some((db, st)) = store() else { return };
    let (_first, item) = markets();
    let t = svc_academy::door::system_now().0;
    assert_eq!(svc_academy::authoring::sql::client(&st, |c| tracks::item_video(c, &item)).unwrap(), None);
    tracks::set_item_video(&st, &item, Some("test-video"), STAFF, "TEST video item", t).unwrap();
    assert_eq!(svc_academy::authoring::sql::client(&st, |c| tracks::item_video(c, &item)).unwrap().as_deref(), Some("test-video"));
    matches(&outline_row(&st, &item, Some(4)), r#"{"rule":"watch","ruleMet":false,"completedAt":null}"#);
    watch(&db, 3);
    matches(&outline_row(&st, &item, Some(4)), r#"{"rule":"watch","ruleMet":false}"#);
    watch(&db, 4);
    matches(&outline_row(&st, &item, Some(4)), r#"{"rule":"watch","ruleMet":true,"completedAt":null}"#);
    // The learner slice's completion of the watched item shows in the outline.
    db.client()
        .execute(
            "INSERT INTO academy.cert_item_completions (user_id, item_slug, completed_at) VALUES ($1::text::uuid, $2::text, $3::text::timestamptz)",
            &[&USER, &item, &iso(t)],
        )
        .unwrap();
    assert_eq!(s(&outline_row(&st, &item, Some(4)), "completedAt"), iso(t));
    // A blank threshold meets nothing.
    matches(&outline_row(&st, &item, None), r#"{"rule":"watch","ruleMet":false}"#);
    // Taking the video off returns the item to the view rule.
    tracks::set_item_video(&st, &item, None, STAFF, "TEST off", t).unwrap();
    matches(&outline_row(&st, &item, Some(4)), r#"{"rule":"view","ruleMet":true}"#);
}

#[test]
fn a_locked_item_shows_its_prerequisite_lock_in_the_outline_with_the_watch_met() {
    let Some((db, st)) = store() else { return };
    let (first, item) = markets();
    let t = svc_academy::door::system_now().0;
    tracks::set_item_video(&st, &item, Some("test-video"), STAFF, "TEST video item", t).unwrap();
    release::set_item_prerequisites(&st, &v(&format!(r#"{{"itemSlug":"{item}","prerequisites":["{first}"]}}"#))).unwrap();
    watch(&db, 10);
    matches(
        &outline_row(&st, &item, Some(4)),
        &format!(r#"{{"state":"locked","lock":"prerequisite","missing":["{first}"],"rule":"watch","ruleMet":true,"completedAt":null}}"#),
    );
}

#[test]
fn an_item_with_a_published_quiz_completes_by_score_even_with_a_video_attached() {
    let Some((db, st)) = store() else { return };
    let (_first, item) = markets();
    let t = svc_academy::door::system_now().0;
    tracks::set_item_video(&st, &item, Some("test-video"), STAFF, "TEST video item", t).unwrap();
    // `setQuiz(...)`: the row the assessment slice leaves.
    db.client()
        .execute(
            "INSERT INTO academy.quizzes (slug, definition, pass_mark, review_mode, reason, set_by, set_at) \
             VALUES ($1::text, '{}'::jsonb, 1, 'answers', 'TEST quiz', $2::text::uuid, now())",
            &[&item, &STAFF],
        )
        .unwrap();
    watch(&db, 9);
    matches(&outline_row(&st, &item, Some(4)), r#"{"rule":"score","ruleMet":false,"completedAt":null}"#);
}

#[test]
fn the_dispatch_refuses_a_video_off_the_spine_and_an_item_off_the_curriculum() {
    let Some((db, _st)) = store() else { return };
    let d = door(&db, Settings::empty(), Ports::unwired());
    let h = principal(USER, &["academy:read"], "none");
    // `itemVideo` checks the slug against the curriculum before any read.
    let answer = query(&d, &h, "itemVideo", Some(&Json::obj([("itemSlug", Json::str("nope"))])));
    assert!(answer.1.compact().contains("academy.curriculum_not_found"), "{}", answer.1.compact());
    let (_f, item) = markets();
    equals(
        &data(&query(&d, &h, "itemVideo", Some(&Json::obj([("itemSlug", Json::str(&item))])))),
        &format!(r#"{{"itemSlug":"{item}","videoSlug":null}}"#),
    );
}
