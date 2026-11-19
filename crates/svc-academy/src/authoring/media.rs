//! A course item's video, caption files and handouts (`curriculum/media.ts` `CourseMedia`). An upload is an intent (the
//! declared file against the owner's limits, a signed PUT to our own store), the browser's PUT, and a confirm that reads
//! the stored object back whole (size, SHA-256, first 16 bytes) through [`ReadBack`]. Only a ready file gets a viewing
//! address. Captions are one SRT or WebVTT file per video and language, stored as cues. No money moves here.

use std::io::Read as _;
use std::time::Duration;

use sha2::{Digest, Sha256};

use service_kit::json::{self, Json};
use service_kit::pg::Pool;
use service_kit::schema::Value;

use super::sql::{self, at, first, get, iso_of, ms, query};
use super::storage::{self, Storage};
use super::tracks::{self, Cue};
use super::{nullable, refuse, text};
use crate::errors::{AcademyError, Refusal};

const MEDIA_SHOWN: i64 = 50;
const READ_BACK_BASE_MS: u64 = 60_000;

/// `FILE_SIGNATURES`, in their order.
pub const SIGNATURES: [(&str, usize, &[u8]); 7] = [
    ("video/webm", 0, &[0x1a, 0x45, 0xdf, 0xa3]),
    ("video/mp4", 4, &[0x66, 0x74, 0x79, 0x70]),
    ("video/quicktime", 4, &[0x66, 0x74, 0x79, 0x70]),
    ("application/pdf", 0, &[0x25, 0x50, 0x44, 0x46, 0x2d]),
    ("image/png", 0, &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ("image/jpeg", 0, &[0xff, 0xd8, 0xff]),
    ("image/gif", 0, &[0x47, 0x49, 0x46, 0x38]),
];

fn signature(content_type: &str) -> Option<(usize, &'static [u8])> {
    SIGNATURES.iter().find(|(t, _, _)| *t == content_type).map(|(_, o, b)| (*o, *b))
}

/// `signatureMatches`.
pub fn signature_matches(head: &[u8], offset: usize, bytes: &[u8]) -> bool {
    bytes.iter().enumerate().all(|(i, b)| head.get(offset + i) == Some(b))
}

fn sniff(head: &[u8]) -> Option<&'static str> {
    SIGNATURES.iter().find(|(_, o, b)| signature_matches(head, *o, b)).map(|(t, _, _)| *t)
}

/// What a read-back saw: the status, how many bytes (stopping past the declared size), the first 16 and the SHA-256.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Back {
    pub status: u16,
    pub bytes: u64,
    pub head: Vec<u8>,
    pub sha256: String,
}

/// `ReadBackFn`: the stored object read back whole through a signed GET.
pub trait ReadBack: Send + Sync {
    fn read_back(&self, url: &str, declared: u64) -> Result<Back, Refusal>;
}

/// `readBackOverHttp`: streamed, hashed as it arrives, stopping one chunk past the declared size; a minute plus a second
/// per MiB declared.
pub struct HttpReadBack;

impl ReadBack for HttpReadBack {
    fn read_back(&self, url: &str, declared: u64) -> Result<Back, Refusal> {
        let timeout = READ_BACK_BASE_MS + declared.div_ceil(1_048_576) * 1000;
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_millis(timeout)))
            .build()
            .new_agent();
        let failed = |e: &dyn std::fmt::Display| Refusal::Internal {
            message: format!("fetch failed: {e}"),
            code: None,
        };
        let mut res = agent.get(url).call().map_err(|e| failed(&e))?;
        let status = res.status().as_u16();
        let mut hash = Sha256::new();
        let mut head = Vec::new();
        let mut bytes: u64 = 0;
        if (200..300).contains(&status) {
            let mut reader = res.body_mut().as_reader();
            let mut buf = vec![0u8; 64 * 1024];
            while bytes <= declared {
                let n = reader.read(&mut buf).map_err(|e| failed(&e))?;
                if n == 0 {
                    break;
                }
                let chunk = buf.get(..n).unwrap_or_default();
                if head.len() < 16 {
                    head.extend(chunk.iter().take(16 - head.len()));
                }
                bytes += n as u64;
                hash.update(chunk);
            }
        }
        Ok(Back {
            status,
            bytes,
            head,
            sha256: hash.finalize().iter().map(|x| format!("{x:02x}")).collect(),
        })
    }
}

/// `UploadLimits`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Limits {
    pub max_bytes: Option<i64>,
    pub video_types: Option<Vec<String>>,
    pub handout_types: Option<Vec<String>>,
}

impl Limits {
    fn json(&self) -> Json {
        let list = |l: &Option<Vec<String>>| l.as_ref().map_or(Json::Null, |v| Json::Array(v.iter().map(Json::str).collect()));
        Json::obj([
            ("maxBytes", self.max_bytes.map_or(Json::Null, Json::int)),
            ("videoTypes", list(&self.video_types)),
            ("handoutTypes", list(&self.handout_types)),
        ])
    }

    fn for_kind(&self, kind: &str) -> Result<(i64, &[String]), Refusal> {
        let types = if kind == "video" { &self.video_types } else { &self.handout_types };
        match (self.max_bytes, types) {
            (Some(m), Some(t)) if !t.is_empty() => Ok((m, t)),
            _ => refuse(
                format!("the owner has not set the upload size limit and the accepted {kind} types"),
                "academy.upload_limits_unset",
            ),
        }
    }
}

/// `CourseMedia`'s parts.
pub struct Media<'a> {
    pub pool: &'a Pool,
    pub storage: Option<&'a Storage>,
    pub limits: &'a Limits,
    pub read_back: &'a dyn ReadBack,
}

const COLS: &str = "id::text AS id, item_id::text AS item_id, kind, sha256, file_name, content_type, bytes, object_key, state, refusal";

fn cols() -> String {
    format!("{COLS}, {} AS created_at", ms("created_at"))
}

struct Row {
    id: String,
    kind: String,
    sha256: String,
    file_name: String,
    content_type: String,
    bytes: i64,
    object_key: String,
    state: String,
    refusal: Option<String>,
    created_at: String,
}

fn row_of(r: &postgres::Row) -> Result<Row, Refusal> {
    Ok(Row {
        id: get(r, "id")?,
        kind: get(r, "kind")?,
        sha256: get(r, "sha256")?,
        file_name: get(r, "file_name")?,
        content_type: get(r, "content_type")?,
        bytes: get(r, "bytes")?,
        object_key: get(r, "object_key")?,
        state: get(r, "state")?,
        refusal: get(r, "refusal")?,
        created_at: iso_of(r, "created_at")?,
    })
}

fn require_storage(s: Option<&Storage>) -> Result<&Storage, Refusal> {
    match s {
        Some(s) if s.configured() => Ok(s),
        _ => refuse("Video object storage is not configured", "academy.video_storage_unconfigured"),
    }
}

impl Media<'_> {
    /// `viewUrl`: a ready file's short-lived address; null while storage or its URL lifetime is not set.
    fn view_url(&self, key: &str, now: i64) -> Result<Option<String>, Refusal> {
        let Some(s) = self.storage.filter(|s| s.configured()) else {
            return Ok(None);
        };
        match storage::sign_get(s, key, now) {
            Ok(i) => Ok(Some(i.url)),
            Err(Refusal::Academy(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn media_json(&self, r: &Row, now: i64) -> Result<Json, Refusal> {
        let url = if r.state == "ready" { self.view_url(&r.object_key, now)? } else { None };
        Ok(Json::obj([
            ("id", Json::str(&r.id)),
            ("kind", Json::str(&r.kind)),
            ("fileName", Json::str(&r.file_name)),
            ("contentType", Json::str(&r.content_type)),
            ("bytes", Json::int(r.bytes)),
            ("state", Json::str(&r.state)),
            ("refusal", nullable(r.refusal.clone())),
            ("createdAt", Json::str(&r.created_at)),
            ("url", nullable(url)),
        ]))
    }

    /// `item(itemId)`.
    fn item(&self, item_id: &str) -> Result<(String, String), Refusal> {
        let Some(r) = sql::client(self.pool, |c| {
            first(
                c,
                "SELECT id::text AS id, course_id::text AS course_id, kind FROM academy.course_items WHERE id = $1::text::uuid",
                &[&item_id],
            )
        })?
        else {
            return refuse("no outline item with that id", "academy.outline_item_unknown");
        };
        let kind: String = get(&r, "kind")?;
        if kind == "subheader" || kind == "link" {
            return refuse(format!("a {kind} holds no files"), "academy.item_has_no_lesson");
        }
        Ok((get(&r, "id")?, get(&r, "course_id")?))
    }

    fn current_video(&self, item_id: &str) -> Result<Option<String>, Refusal> {
        sql::client(self.pool, |c| {
            first(
                c,
                "SELECT id::text AS id FROM academy.course_media WHERE item_id = $1::text::uuid AND kind = 'video' AND state = 'ready' \
                 ORDER BY confirmed_at DESC, id LIMIT 1",
                &[&item_id],
            )
        })?
        .map(|r| get(&r, "id"))
        .transpose()
    }

    /// `itemMedia`.
    pub fn item_media(&self, item_id: &str, now: i64) -> Result<Json, Refusal> {
        self.item(item_id)?;
        let video = self.current_video(item_id)?;
        let rows = sql::client(self.pool, |c| {
            query(
                c,
                &format!(
                    "SELECT {} FROM academy.course_media WHERE item_id = $1::text::uuid ORDER BY created_at DESC, id LIMIT $2::int8",
                    cols()
                ),
                &[&item_id, &MEDIA_SHOWN],
            )
        })?;
        let captions = match &video {
            None => Vec::new(),
            Some(v) => sql::client(self.pool, |c| {
                query(
                    c,
                    "SELECT language, label, format, cues::text AS cues FROM academy.course_item_captions WHERE media_id = $1::text::uuid ORDER BY language",
                    &[v],
                )
            })?,
        };
        let media = rows
            .iter()
            .map(|r| row_of(r).and_then(|m| self.media_json(&m, now)))
            .collect::<Result<Vec<_>, _>>()?;
        let captions = captions
            .iter()
            .map(|c| {
                let cues = json::parse(&get::<String>(c, "cues")?).map_err(|e| Refusal::Internal {
                    message: e.message,
                    code: None,
                })?;
                let list = match &cues {
                    Json::Array(a) => a.clone(),
                    _ => Vec::new(),
                };
                let first = list
                    .first()
                    .and_then(|c| c.get("text"))
                    .and_then(|t| match t {
                        Json::String(s) => Some(s.clone()),
                        _ => None,
                    })
                    .unwrap_or_default();
                Ok(Json::obj([
                    ("language", Json::String(get(c, "language")?)),
                    ("label", Json::String(get(c, "label")?)),
                    ("format", Json::String(get(c, "format")?)),
                    ("cues", Json::int(i64::try_from(list.len()).unwrap_or(0))),
                    ("firstCue", Json::String(first)),
                ]))
            })
            .collect::<Result<Vec<_>, Refusal>>()?;
        Ok(Json::obj([
            ("itemId", Json::str(item_id)),
            ("videoId", nullable(video)),
            ("limits", self.limits.json()),
            ("media", Json::Array(media)),
            ("captions", Json::Array(captions)),
        ]))
    }

    /// `intent`: the owner's limits and the checkable types before the item is read.
    pub fn intent(&self, input: &Value, operator: &str, now: i64) -> Result<Json, Refusal> {
        let kind = text(input, "kind");
        let content_type = text(input, "contentType");
        let bytes = super::int(input, "bytes");
        let (max, types) = self.limits.for_kind(kind)?;
        if bytes > max {
            return refuse(format!("the file is {bytes} bytes; the limit is {max}"), "academy.upload_too_large");
        }
        if !types.iter().any(|t| t == content_type) {
            return refuse(format!("{content_type} is not an accepted {kind} type"), "academy.upload_type_refused");
        }
        if signature(content_type).is_none() {
            return refuse(format!("the content of {content_type} files cannot be checked"), "academy.upload_type_refused");
        }
        let (item, course) = self.item(text(input, "itemId"))?;
        let sha = text(input, "sha256");
        let key = format!("courses/{course}/items/{item}/{kind}/{sha}");
        let file_name = text(input, "fileName");
        let row = sql::client(self.pool, |c| {
            first(
                c,
                &format!(
                    "INSERT INTO academy.course_media \
                       (item_id, kind, sha256, file_name, content_type, bytes, object_key, state, created_by, created_at) \
                     VALUES ($1::text::uuid, $2::text, $3::text, $4::text, $5::text, $6::int8, $7::text, 'pending', $8::text::uuid, $9::text::timestamptz) \
                     ON CONFLICT (item_id, kind, sha256) DO UPDATE SET \
                       file_name = CASE WHEN academy.course_media.state = 'ready' THEN academy.course_media.file_name ELSE excluded.file_name END, \
                       content_type = CASE WHEN academy.course_media.state = 'ready' THEN academy.course_media.content_type ELSE excluded.content_type END, \
                       bytes = CASE WHEN academy.course_media.state = 'ready' THEN academy.course_media.bytes ELSE excluded.bytes END, \
                       refusal = NULL, \
                       state = CASE WHEN academy.course_media.state = 'ready' THEN 'ready' ELSE 'pending' END \
                     RETURNING {}",
                    cols()
                ),
                &[&item, &kind, &sha, &file_name, &content_type, &bytes, &key, &operator, &at(now)],
            )
        })?
        .ok_or_else(|| Refusal::Internal {
            message: "the upload row was not returned".to_owned(),
            code: None,
        })?;
        let row = row_of(&row)?;
        if row.state == "ready" {
            return Ok(Json::obj([("media", self.media_json(&row, now)?), ("uploadUrl", Json::Null)]));
        }
        let (url, _) = storage::sign_put(require_storage(self.storage)?, &key, now)?;
        Ok(Json::obj([("media", self.media_json(&row, now)?), ("uploadUrl", Json::String(url))]))
    }

    /// `confirm`.
    pub fn confirm(&self, media_id: &str, now: i64) -> Result<Json, Refusal> {
        let Some(r) = sql::client(self.pool, |c| {
            first(c, &format!("SELECT {} FROM academy.course_media WHERE id = $1::text::uuid", cols()), &[&media_id])
        })?
        else {
            return refuse("no upload with that id", "academy.media_not_found");
        };
        let row = row_of(&r)?;
        if row.state == "ready" {
            return self.media_json(&row, now);
        }
        if row.state == "refused" {
            let why = row.refusal.clone().unwrap_or_else(|| "the stored file was refused".to_owned());
            return Err(AcademyError::new(why, "academy.file_type_mismatch").into());
        }
        let issued = storage::sign_get(require_storage(self.storage)?, &row.object_key, now)?;
        let declared = row.bytes;
        let back = self.read_back.read_back(&issued.url, u64::try_from(declared).unwrap_or(0))?;
        if back.status != 200 {
            return refuse("the file has not reached storage; send it again", "academy.upload_incomplete");
        }
        let got = i64::try_from(back.bytes).unwrap_or(i64::MAX);
        if got != declared || back.sha256 != row.sha256 {
            let message = if got != declared {
                let held = if got > declared { "more than".to_owned() } else { got.to_string() };
                format!("storage holds {held} bytes; {declared} were declared")
            } else {
                "the stored bytes are not the file that was declared; send it again".to_owned()
            };
            return refuse(message, "academy.upload_incomplete");
        }
        let same = "id = $1::text::uuid AND state = 'pending' AND content_type = $2::text AND bytes = $3::int8";
        let matches = signature(&row.content_type).is_some_and(|(o, b)| signature_matches(&back.head, o, b));
        if !matches {
            let seen = sniff(&back.head).unwrap_or("not a type we recognise");
            let refusal = format!("the file was declared {} but its content is {seen}", row.content_type);
            sql::client(self.pool, |c| {
                sql::exec(
                    c,
                    &format!(
                        "UPDATE academy.course_media SET state = 'refused', refusal = $4::text, confirmed_at = $5::text::timestamptz WHERE {same}"
                    ),
                    &[&row.id, &row.content_type, &declared, &refusal, &at(now)],
                )
            })?;
            return refuse(refusal, "academy.file_type_mismatch");
        }
        let ready = sql::client(self.pool, |c| {
            first(
                c,
                &format!(
                    "UPDATE academy.course_media SET state = 'ready', refusal = NULL, confirmed_at = $4::text::timestamptz WHERE {same} RETURNING {}",
                    cols()
                ),
                &[&row.id, &row.content_type, &declared, &at(now)],
            )
        })?;
        let Some(ready) = ready else {
            return refuse("the upload changed while it was checked; check it again", "academy.upload_incomplete");
        };
        self.media_json(&row_of(&ready)?, now)
    }

    /// `setCaptions`: a malformed line comes back with nothing stored.
    pub fn set_captions(&self, input: &Value, operator: &str, now: i64) -> Result<Json, Refusal> {
        let item_id = text(input, "itemId");
        self.item(item_id)?;
        let Some(video) = self.current_video(item_id)? else {
            return refuse("upload and confirm a video before its captions", "academy.item_video_missing");
        };
        let format = text(input, "format");
        let source = text(input, "text");
        let parsed = if format == "srt" { tracks::parse_srt(source) } else { tracks::parse_vtt(source) };
        let cues: Vec<Cue> = match parsed {
            Ok(c) => c,
            Err(Refusal::Academy(e)) if e.code == "academy.captions_invalid" => {
                let problem = e.message.strip_prefix("academy.captions_invalid").map_or(e.message.as_str(), str::trim_start);
                return Ok(Json::obj([
                    ("outcome", Json::str("invalid")),
                    ("problem", Json::str(problem)),
                    ("media", self.item_media(item_id, now)?),
                ]));
            }
            Err(e) => return Err(e),
        };
        let cues_json = Json::Array(
            cues.iter()
                .map(|c| {
                    Json::obj([
                        ("startMs", Json::int(c.start_ms)),
                        ("endMs", Json::int(c.end_ms)),
                        ("text", Json::str(&c.text)),
                    ])
                })
                .collect(),
        )
        .compact();
        let language = text(input, "language");
        let label = text(input, "label");
        sql::client(self.pool, |c| {
            sql::exec(
                c,
                "INSERT INTO academy.course_item_captions (item_id, media_id, language, label, format, source, cues, set_by, set_at) \
                 VALUES ($1::text::uuid, $2::text::uuid, $3::text, $4::text, $5::text, $6::text, $7::text::jsonb, $8::text::uuid, $9::text::timestamptz) \
                 ON CONFLICT (media_id, language) DO UPDATE SET label = excluded.label, format = excluded.format, \
                   source = excluded.source, cues = excluded.cues, set_by = excluded.set_by, set_at = excluded.set_at",
                &[&item_id, &video, &language, &label, &format, &source, &cues_json, &operator, &at(now)],
            )
        })?;
        Ok(Json::obj([("outcome", Json::str("saved")), ("media", self.item_media(item_id, now)?)]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leading_bytes_name_their_type() {
        assert!(signature_matches(&[0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70], 4, &[0x66, 0x74, 0x79, 0x70]));
        assert_eq!(sniff(&[0x25, 0x50, 0x44, 0x46, 0x2d]), Some("application/pdf"));
        assert_eq!(sniff(&[1, 2, 3]), None);
    }
}
