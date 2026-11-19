//! `curriculum/media.db.test.ts` (AC-videos-02) against a real Postgres: a course item's video, captions and handouts,
//! owner limits, the signed upload, the read-back check of size, leading bytes and SHA-256, and SRT / WebVTT captions
//! checked line by line.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    reason = "a test: a failure is the point"
)]

mod authoring_kit;

use std::sync::Mutex;

use authoring_kit::{at, at_path, code, equals, is_null, len, matches, s, store, v};
use service_kit::json::Json;
use svc_academy::authoring::courses::{CourseRecords, Limits as OutlineLimits};
use svc_academy::authoring::media::{Back, Limits, Media, ReadBack};
use svc_academy::authoring::storage::Storage;
use svc_academy::db::Store;
use svc_academy::errors::Refusal;

const A: &str = "33333333-3333-4333-8333-333333333333";
const NOW: &str = "2026-10-23T12:00:00.000Z";
const WEBM: [u8; 8] = [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81];
const PNG: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PDF: [u8; 8] = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34];

fn now() -> i64 {
    at(NOW)
}

fn sha(c: char) -> String {
    c.to_string().repeat(64)
}

fn storage() -> Storage {
    Storage {
        endpoint: "http://127.0.0.1:9".into(),
        bucket: "academy-test".into(),
        access_key: "dev-only-key".into(),
        secret_key: "dev-only-secret".into(),
        region: "test-1".into(),
        ttl_seconds: Some(300),
    }
}

fn limits() -> Limits {
    Limits {
        max_bytes: Some(1000),
        video_types: Some(vec!["video/webm".into()]),
        handout_types: Some(vec!["application/pdf".into(), "image/png".into()]),
    }
}

/// A store that holds what the test says, and records every read. An object's SHA-256 is the one its key was issued
/// for (the stored bytes are the declared file) unless the test says otherwise.
struct Objects {
    objects: Vec<(String, u64, Vec<u8>, Option<String>)>,
    reads: Mutex<Vec<String>>,
}

impl Objects {
    fn new(objects: Vec<(String, u64, &[u8], Option<String>)>) -> Objects {
        Objects {
            objects: objects
                .into_iter()
                .map(|(k, t, h, s)| (k, t, h.to_vec(), s))
                .collect(),
            reads: Mutex::new(Vec::new()),
        }
    }
    fn empty() -> Objects {
        Objects::new(Vec::new())
    }
    fn reads(&self) -> usize {
        self.reads.lock().unwrap().len()
    }
}

impl ReadBack for Objects {
    fn read_back(&self, url: &str, _declared: u64) -> Result<Back, Refusal> {
        self.reads.lock().unwrap().push(url.to_owned());
        let path = url::Url::parse(url).unwrap().path().to_owned();
        Ok(
            match self
                .objects
                .iter()
                .find(|(k, ..)| path.ends_with(k.as_str()))
            {
                None => Back {
                    status: 404,
                    bytes: 0,
                    head: Vec::new(),
                    sha256: String::new(),
                },
                Some((k, total, head, sha)) => Back {
                    status: 200,
                    bytes: *total,
                    head: head.clone(),
                    sha256: sha
                        .clone()
                        .unwrap_or_else(|| k.rsplit('/').next().unwrap().to_owned()),
                },
            },
        )
    }
}

fn media<'a>(st: &'a Store, s: &'a Storage, l: &'a Limits, rb: &'a Objects) -> Media<'a> {
    Media {
        pool: st,
        storage: Some(s),
        limits: l,
        read_back: rb,
    }
}

struct Item {
    course_id: String,
    item: String,
    subheader: String,
}

fn lesson_item(st: &Store) -> Item {
    let c = CourseRecords {
        limits: OutlineLimits {
            max_sections: Some(5),
            max_items: Some(5),
        },
    };
    let course = c
        .create(
            st,
            &v(r#"{"slug":"risk-basics","title":"Risk basics","summary":null,"thumbnailUrl":null,"pricing":"free","price":null,"priceAsset":null}"#),
            A,
            now(),
        )
        .unwrap();
    let id = s(&course, "id");
    let detail = c
        .save_outline(
            st,
            &v(&format!(
                r#"{{"courseId":"{id}","revision":1,"sections":[{{"title":"Start here","items":[
                {{"kind":"video","title":"Sizing a position","indent":0,"url":null}},
                {{"kind":"subheader","title":"Part 1","indent":0,"url":null}}]}}]}}"#
            )),
            A,
            now(),
        )
        .unwrap();
    Item {
        course_id: id,
        item: s(&detail, "outline.0.items.0.id"),
        subheader: s(&detail, "outline.0.items.1.id"),
    }
}

/// `declare(itemId, over)` with the fields replaced (`"bytes":1001`).
fn declare(item: &str, over: &[(&str, Json)]) -> service_kit::schema::Value {
    let mut fields: Vec<(String, Json)> = vec![
        ("itemId".into(), Json::str(item)),
        ("kind".into(), Json::str("video")),
        ("fileName".into(), Json::str("sizing.webm")),
        ("contentType".into(), Json::str("video/webm")),
        ("bytes".into(), Json::int(800)),
        ("sha256".into(), Json::String(sha('a'))),
    ];
    for (k, val) in over {
        match fields.iter_mut().find(|(f, _)| f == k) {
            Some(slot) => slot.1 = val.clone(),
            None => fields.push(((*k).to_owned(), val.clone())),
        }
    }
    v(&Json::Object(fields).compact())
}

fn confirm(m: &Media<'_>, id: &str, t: i64) -> Result<Json, Refusal> {
    m.confirm(id, t)
}

/// `rejects.toMatchObject({ code, message })`.
fn both(r: Result<Json, Refusal>) -> (String, String) {
    match r {
        Err(Refusal::Academy(e)) => (e.code, e.message),
        other => panic!("{other:?}"),
    }
}

fn count(db: &authoring_kit::TestDb) -> String {
    db.texts("SELECT count(*)::text FROM academy.course_media")[0].clone()
}

#[test]
fn blank_owner_limits_refuse_by_name_and_the_item_still_reads_with_the_limits_shown_as_not_set() {
    let Some((_db, st)) = store() else { return };
    let it = lesson_item(&st);
    let sg = storage();
    let rb = Objects::empty();
    for l in [
        Limits {
            max_bytes: None,
            video_types: Some(vec!["video/webm".into()]),
            handout_types: Some(vec!["application/pdf".into()]),
        },
        Limits {
            max_bytes: Some(1000),
            video_types: None,
            handout_types: Some(vec!["application/pdf".into()]),
        },
    ] {
        assert_eq!(
            code(media(&st, &sg, &l, &rb).intent(&declare(&it.item, &[]), A, now())),
            "academy.upload_limits_unset"
        );
    }
    let no_handouts = Limits {
        max_bytes: Some(1000),
        video_types: Some(vec!["video/webm".into()]),
        handout_types: None,
    };
    assert_eq!(
        code(media(&st, &sg, &no_handouts, &rb).intent(
            &declare(
                &it.item,
                &[
                    ("kind", Json::str("handout")),
                    ("contentType", Json::str("application/pdf"))
                ]
            ),
            A,
            now()
        )),
        "academy.upload_limits_unset"
    );
    let blank = Limits {
        max_bytes: None,
        video_types: None,
        handout_types: None,
    };
    let read = media(&st, &sg, &blank, &rb)
        .item_media(&it.item, now())
        .unwrap();
    equals(
        &read,
        &format!(
            r#"{{"itemId":"{}","videoId":null,"limits":{{"maxBytes":null,"videoTypes":null,"handoutTypes":null}},"media":[],"captions":[]}}"#,
            it.item
        ),
    );
}

#[test]
fn over_the_size_or_of_a_type_not_accepted_refuses_before_any_row_or_address_a_subheader_holds_no_files()
 {
    let Some((db, st)) = store() else { return };
    let it = lesson_item(&st);
    let (sg, l, rb) = (storage(), limits(), Objects::empty());
    let m = media(&st, &sg, &l, &rb);
    assert_eq!(
        code(m.intent(&declare(&it.item, &[("bytes", Json::int(1001))]), A, now())),
        "academy.upload_too_large"
    );
    assert_eq!(
        code(m.intent(
            &declare(&it.item, &[("contentType", Json::str("video/mp4"))]),
            A,
            now()
        )),
        "academy.upload_type_refused"
    );
    // An accepted type whose content svc-academy cannot check is never taken.
    let plain = Limits {
        handout_types: Some(vec!["text/plain".into()]),
        ..limits()
    };
    assert_eq!(
        code(media(&st, &sg, &plain, &rb).intent(
            &declare(
                &it.item,
                &[
                    ("kind", Json::str("handout")),
                    ("contentType", Json::str("text/plain"))
                ]
            ),
            A,
            now()
        )),
        "academy.upload_type_refused"
    );
    assert_eq!(
        code(m.intent(&declare(&it.subheader, &[]), A, now())),
        "academy.item_has_no_lesson"
    );
    assert_eq!(count(&db), "0");
}

#[test]
fn an_intent_issues_a_signed_put_the_same_file_resumes_its_row_confirm_checks_size_leading_bytes_and_the_file()
 {
    let Some((_db, st)) = store() else { return };
    let it = lesson_item(&st);
    let (sg, l) = (storage(), limits());
    let none = Objects::empty();
    let key = format!(
        "courses/{}/items/{}/video/{}",
        it.course_id,
        it.item,
        sha('a')
    );
    let first = media(&st, &sg, &l, &none)
        .intent(&declare(&it.item, &[]), A, now())
        .unwrap();
    matches(
        &first,
        r#"{"media":{"state":"pending","bytes":800,"url":null}}"#,
    );
    let upload = s(&first, "uploadUrl");
    assert_eq!(
        url::Url::parse(&upload).unwrap().path(),
        format!("/academy-test/{key}")
    );
    assert!(upload.contains("X-Amz-Signature="));
    let again = media(&st, &sg, &l, &none)
        .intent(
            &declare(&it.item, &[("fileName", Json::str("renamed.webm"))]),
            A,
            now(),
        )
        .unwrap();
    let id = s(&first, "media.id");
    assert_eq!(s(&again, "media.id"), id);
    assert_eq!(s(&again, "media.fileName"), "renamed.webm");

    // Nothing stored yet: the row stays pending.
    assert_eq!(
        code(confirm(&media(&st, &sg, &l, &Objects::empty()), &id, now())),
        "academy.upload_incomplete"
    );
    // A partial object: still pending.
    let partial = Objects::new(vec![(key.clone(), 400, &WEBM, None)]);
    assert_eq!(
        code(confirm(&media(&st, &sg, &l, &partial), &id, now())),
        "academy.upload_incomplete"
    );
    // The declared size, but not the declared file: still pending.
    let other = Objects::new(vec![(key.clone(), 800, &WEBM, Some(sha('f')))]);
    assert_eq!(
        both(confirm(&media(&st, &sg, &l, &other), &id, now())),
        (
            "academy.upload_incomplete".to_owned(),
            "the stored bytes are not the file that was declared; send it again".to_owned()
        )
    );

    let whole = Objects::new(vec![(key.clone(), 800, &WEBM, None)]);
    let ready = confirm(&media(&st, &sg, &l, &whole), &id, now()).unwrap();
    matches(&ready, r#"{"state":"ready","refusal":null}"#);
    assert!(s(&ready, "url").contains(&key));
    // A confirmed file answers again without a read, and a new intent for it needs no upload.
    matches(
        &confirm(&media(&st, &sg, &l, &whole), &id, now()).unwrap(),
        r#"{"state":"ready"}"#,
    );
    assert_eq!(whole.reads(), 1);
    assert!(is_null(
        &media(&st, &sg, &l, &none)
            .intent(&declare(&it.item, &[]), A, now())
            .unwrap(),
        "uploadUrl"
    ));
    assert_eq!(
        code(confirm(
            &media(&st, &sg, &l, &none),
            "99999999-9999-4999-8999-999999999999",
            now()
        )),
        "academy.media_not_found"
    );
}

#[test]
fn a_handout_declared_pdf_whose_bytes_are_png_is_refused_with_its_reason_and_never_given_an_address()
 {
    let Some((_db, st)) = store() else { return };
    let it = lesson_item(&st);
    let (sg, l, none) = (storage(), limits(), Objects::empty());
    let handout = |over: &[(&str, Json)]| {
        let mut all = vec![
            ("kind", Json::str("handout")),
            ("contentType", Json::str("application/pdf")),
            ("fileName", Json::str("sheet.pdf")),
            ("bytes", Json::int(300)),
            ("sha256", Json::String(sha('b'))),
        ];
        all.extend(over.iter().cloned());
        declare(&it.item, &all)
    };
    let row = media(&st, &sg, &l, &none)
        .intent(&handout(&[]), A, now())
        .unwrap();
    let id = s(&row, "media.id");
    let key = format!(
        "courses/{}/items/{}/handout/{}",
        it.course_id,
        it.item,
        sha('b')
    );
    let png = Objects::new(vec![(key, 300, &PNG, None)]);
    assert_eq!(
        both(confirm(&media(&st, &sg, &l, &png), &id, now())),
        (
            "academy.file_type_mismatch".to_owned(),
            "the file was declared application/pdf but its content is image/png".to_owned()
        )
    );
    let read = media(&st, &sg, &l, &none)
        .item_media(&it.item, now())
        .unwrap();
    assert_eq!(len(&read, "media"), 1);
    matches(
        at_path(&read, "media.0"),
        &format!(r#"{{"id":"{id}","state":"refused","url":null}}"#),
    );
    assert!(s(&read, "media.0.refusal").contains("image/png"));
    // The same bytes declared as what they are are checked again.
    let redeclared = media(&st, &sg, &l, &none)
        .intent(
            &handout(&[
                ("contentType", Json::str("image/png")),
                ("fileName", Json::str("sheet.png")),
            ]),
            A,
            now(),
        )
        .unwrap();
    matches(
        &redeclared,
        &format!(r#"{{"media":{{"id":"{id}","state":"pending","refusal":null}}}}"#),
    );
    matches(
        &confirm(&media(&st, &sg, &l, &png), &id, now()).unwrap(),
        r#"{"state":"ready"}"#,
    );
    let pdf_key = format!(
        "courses/{}/items/{}/handout/{}",
        it.course_id,
        it.item,
        sha('c')
    );
    let pdf = media(&st, &sg, &l, &none)
        .intent(&handout(&[("sha256", Json::String(sha('c')))]), A, now())
        .unwrap();
    let pdf_store = Objects::new(vec![(pdf_key, 300, &PDF, None)]);
    matches(
        &confirm(
            &media(&st, &sg, &l, &pdf_store),
            &s(&pdf, "media.id"),
            now(),
        )
        .unwrap(),
        r#"{"state":"ready"}"#,
    );
}

#[test]
fn captions_need_a_ready_video_a_malformed_srt_line_is_returned_and_nothing_stored_a_good_file_is_stored_per_language()
 {
    let Some((_db, st)) = store() else { return };
    let it = lesson_item(&st);
    let (sg, l, none) = (storage(), limits(), Objects::empty());
    let m = media(&st, &sg, &l, &none);
    let captions = |language: &str, label: &str, format: &str, text: &str| {
        v(&Json::obj([
            ("itemId", Json::str(&it.item)),
            ("language", Json::str(language)),
            ("label", Json::str(label)),
            ("format", Json::str(format)),
            ("text", Json::str(text)),
        ])
        .compact())
    };
    let good = "1\n00:00:01,000 --> 00:00:04,000\nSize the position first.\n\n2\n00:00:05,000 --> 00:00:07,500\nThen the stop.\n";
    assert_eq!(
        code(m.set_captions(&captions("en", "English", "srt", good), A, now())),
        "academy.item_video_missing"
    );
    let video = m.intent(&declare(&it.item, &[]), A, now()).unwrap();
    let key = format!(
        "courses/{}/items/{}/video/{}",
        it.course_id,
        it.item,
        sha('a')
    );
    let whole = Objects::new(vec![(key, 800, &WEBM, None)]);
    confirm(&media(&st, &sg, &l, &whole), &s(&video, "media.id"), now()).unwrap();

    let bad = "1\n00:00:01,000 --> 00:00:04,000\nSize the position first.\n\n2\n00:00:05.000 --> 00:00:07,500\nThen the stop.\n";
    let refused = m
        .set_captions(&captions("en", "English", "srt", bad), A, now())
        .unwrap();
    matches(
        &refused,
        r#"{"outcome":"invalid","problem":"line 6: \"00:00:05.000\" is not an SRT timestamp"}"#,
    );
    assert_eq!(len(&refused, "media.captions"), 0);

    let saved = m
        .set_captions(&captions("en", "English", "srt", good), A, now())
        .unwrap();
    matches(&saved, r#"{"outcome":"saved"}"#);
    equals(
        at_path(&saved, "media.captions"),
        r#"[{"language":"en","label":"English","format":"srt","cues":2,"firstCue":"Size the position first."}]"#,
    );
    let vtt = m
        .set_captions(
            &captions(
                "de",
                "Deutsch",
                "vtt",
                "WEBVTT\n\n00:01.000 --> 00:02.000\nHallo\n",
            ),
            A,
            now(),
        )
        .unwrap();
    assert_eq!(
        [
            s(&vtt, "media.captions.0.language"),
            s(&vtt, "media.captions.1.language")
        ],
        ["de", "en"]
    );
    assert_eq!(s(&vtt, "media.videoId"), s(&video, "media.id"));

    // A re-cut video becomes the item's video and starts with none of the old timings.
    let recut = m
        .intent(
            &declare(
                &it.item,
                &[
                    ("sha256", Json::String(sha('d'))),
                    ("fileName", Json::str("recut.webm")),
                ],
            ),
            A,
            now(),
        )
        .unwrap();
    let recut_key = format!(
        "courses/{}/items/{}/video/{}",
        it.course_id,
        it.item,
        sha('d')
    );
    let recut_store = Objects::new(vec![(recut_key, 800, &WEBM, None)]);
    confirm(
        &media(&st, &sg, &l, &recut_store),
        &s(&recut, "media.id"),
        now() + 60_000,
    )
    .unwrap();
    let after = m.item_media(&it.item, now()).unwrap();
    assert_eq!(s(&after, "videoId"), s(&recut, "media.id"));
    assert_eq!(len(&after, "captions"), 0);
}
