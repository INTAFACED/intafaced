//! Assignments on course items and the work learners hand in (`curriculum/assignments.ts`).
//!
//! A hand-in is version n of the learner's work, keyed `submit:<item>:<account>:<n>`; a file is stored in our own
//! object store, keyed by its SHA-256 per learner and item, and its row written only after the bytes are stored.

use postgres::GenericClient;

use crate::db::Store;
use service_kit::json::Json;
use service_kit::schema::js_trim;

use super::gradebook::late_policy_of;
use super::grading::learner_grade_of;
use super::peer::review_steps_of;
use super::release::assert_item_open;
use super::storage::{ObjectBytes, StorageConfig, configured, presign};
use super::{
    begin, canonical_price, cell, due_for, exec, first, int, iso, iso_or_null, ms, one, opt_str,
    query, refuse, sha256_hex, with_client,
};
use crate::errors::Refusal;

/// Hand-ins shown on the learner's page, newest first.
const SUBMISSIONS_SHOWN: i64 = 50;
/// `ACADEMY_ASSIGNMENT_FILE_INLINE_MAX_BYTES`.
pub const INLINE_MAX_BYTES: i64 = 786_432;

/// `FILE_SIGNATURES` (`curriculum/media.ts`): the leading bytes each checked type starts with.
pub fn file_signature(content_type: &str) -> Option<(usize, &'static [u8])> {
    Some(match content_type {
        "video/webm" => (0, &[0x1a, 0x45, 0xdf, 0xa3]),
        "video/mp4" | "video/quicktime" => (4, &[0x66, 0x74, 0x79, 0x70]),
        "application/pdf" => (0, &[0x25, 0x50, 0x44, 0x46, 0x2d]),
        "image/png" => (0, &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/jpeg" => (0, &[0xff, 0xd8, 0xff]),
        "image/gif" => (0, &[0x47, 0x49, 0x46, 0x38]),
        _ => return None,
    })
}

/// `signatureMatches(head, sig)`.
pub fn signature_matches(head: &[u8], (offset, bytes): (usize, &[u8])) -> bool {
    bytes
        .iter()
        .enumerate()
        .all(|(i, b)| head.get(offset + i) == Some(b))
}

/// `Buffer.from(text, 'base64')`: both alphabets, anything else skipped, stopping at the first `=`; trailing bits that
/// make no whole byte are dropped.
pub fn node_base64(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for c in text.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(u8::try_from((acc >> bits) & 0xff).unwrap_or(0));
        }
    }
    out
}

/// The owner's upload values for hand-ins and where files go.
pub struct Files<'a> {
    pub storage: Option<StorageConfig>,
    /// `ACADEMY_UPLOAD_MAX_BYTES`.
    pub max_bytes: Option<i64>,
    /// `ACADEMY_UPLOAD_HANDOUT_TYPES`.
    pub types: Option<Vec<String>>,
    pub bytes: &'a dyn ObjectBytes,
}

impl Files<'_> {
    /// `fileMaxBytes()`.
    fn max(&self) -> Option<i64> {
        self.max_bytes.map(|m| m.min(INLINE_MAX_BYTES))
    }
}

/// `briefColumns`.
const BRIEF_COLUMNS: &str = "i.id::text AS item_id, i.course_id::text AS course_id, i.title, i.kind, a.revision, a.instructions, \
    a.points::text AS points, floor(extract(epoch from a.due_at) * 1000)::int8 AS due_at, a.text_mode, a.file_mode, \
    a.saved_by::text AS saved_by, floor(extract(epoch from a.saved_at) * 1000)::int8 AS saved_at, \
    floor(extract(epoch from a.withdrawn_at) * 1000)::int8 AS withdrawn_at, a.withdraw_reason";

/// A brief row (`BriefRow`, and `LearnerRow` with the course).
pub struct Brief {
    pub item_id: String,
    pub course_id: String,
    pub title: String,
    pub kind: String,
    pub revision: Option<i32>,
    pub instructions: Option<String>,
    pub points: Option<String>,
    pub due_at: Option<i64>,
    pub text_mode: Option<String>,
    pub file_mode: Option<String>,
    pub saved_by: Option<String>,
    pub saved_at: Option<i64>,
    pub withdrawn_at: Option<i64>,
    pub withdraw_reason: Option<String>,
    pub course_slug: String,
    pub course_title: String,
}

fn read_brief(r: &postgres::Row, learner: bool) -> Result<Brief, Refusal> {
    Ok(Brief {
        item_id: cell(r, "item_id")?,
        course_id: cell(r, "course_id")?,
        title: cell(r, "title")?,
        kind: cell(r, "kind")?,
        revision: cell(r, "revision")?,
        instructions: cell(r, "instructions")?,
        points: cell(r, "points")?,
        due_at: cell(r, "due_at")?,
        text_mode: cell(r, "text_mode")?,
        file_mode: cell(r, "file_mode")?,
        saved_by: cell(r, "saved_by")?,
        saved_at: cell(r, "saved_at")?,
        withdrawn_at: cell(r, "withdrawn_at")?,
        withdraw_reason: cell(r, "withdraw_reason")?,
        course_slug: if learner {
            cell(r, "course_slug")?
        } else {
            String::new()
        },
        course_title: if learner {
            cell(r, "course_title")?
        } else {
            String::new()
        },
    })
}

/// `briefOf(row)`, as the fields it spreads.
fn brief_fields(b: &Brief) -> Vec<(String, Json)> {
    vec![
        ("instructions".into(), opt_str(b.instructions.clone())),
        (
            "points".into(),
            Json::String(canonical_price(b.points.as_deref().unwrap_or(""))),
        ),
        ("dueAt".into(), iso_or_null(b.due_at)),
        ("text".into(), opt_str(b.text_mode.clone())),
        ("file".into(), opt_str(b.file_mode.clone())),
    ]
}

/// `brief(sql, itemId, lock)`.
fn brief<C: GenericClient>(c: &mut C, item_id: &str, lock: bool) -> Result<Brief, Refusal> {
    let sql = format!(
        "SELECT {BRIEF_COLUMNS} FROM academy.course_items i LEFT JOIN academy.course_assignments a ON a.item_id = i.id \
         WHERE i.id = $1::text::uuid {}",
        if lock { "FOR UPDATE OF i" } else { "" }
    );
    let Some(row) = first(c, &sql, &[&item_id])? else {
        return refuse(
            "no outline item with that id",
            "academy.outline_item_unknown",
        );
    };
    let b = read_brief(&row, false)?;
    if b.kind != "assignment" {
        return refuse(
            format!("a {} is not an assignment", b.kind),
            "academy.assignment_not_found",
        );
    }
    Ok(b)
}

/// `adminIn(sql, itemId)`.
pub fn admin_in<C: GenericClient>(c: &mut C, item_id: &str) -> Result<Json, Refusal> {
    let b = brief(c, item_id, false)?;
    let n: i32 = cell(
        &one(
            c,
            "SELECT count(DISTINCT user_id)::int AS n FROM academy.assignment_submissions WHERE item_id = $1::text::uuid",
            &[&item_id],
        )?,
        "n",
    )?;
    let review = review_steps_of(c, &b.item_id)?;
    Ok(Json::obj([
        ("itemId", Json::str(b.item_id.clone())),
        ("courseId", Json::str(b.course_id.clone())),
        ("title", Json::str(b.title.clone())),
        ("revision", int(i64::from(b.revision.unwrap_or(0)))),
        (
            "brief",
            if b.revision.is_none() {
                Json::Null
            } else {
                Json::Object(brief_fields(&b))
            },
        ),
        ("savedBy", opt_str(b.saved_by.clone())),
        ("savedAt", iso_or_null(b.saved_at)),
        ("withdrawnAt", iso_or_null(b.withdrawn_at)),
        ("withdrawReason", opt_str(b.withdraw_reason.clone())),
        ("learnersHandedIn", int(i64::from(n))),
        ("review", review.unwrap_or(Json::Null)),
    ]))
}

/// `adminView(itemId)`.
pub fn admin_view(pool: &Store, item_id: &str) -> Result<Json, Refusal> {
    with_client(pool, |c| admin_in(c, item_id))
}

/// The brief as the staff calls take it.
pub struct BriefInput<'a> {
    pub instructions: &'a str,
    pub points: &'a str,
    pub due_at: Option<&'a str>,
    pub text: &'a str,
    pub file: &'a str,
}

/// `save(input)`.
pub fn save(
    pool: &Store,
    item_id: &str,
    revision_in: i64,
    input: &BriefInput<'_>,
    operator: &str,
    now: i64,
) -> Result<Json, Refusal> {
    begin(pool, |tx| {
        let row = brief(tx, item_id, true)?;
        let revision = i64::from(row.revision.unwrap_or(0));
        if revision != revision_in {
            return refuse(
                format!("the assignment is at revision {revision}, not {revision_in}"),
                "academy.revision_stale",
            );
        }
        if row.withdrawn_at.is_some() {
            return refuse(
                "a withdrawn assignment is not edited",
                "academy.assignment_closed",
            );
        }
        exec(
            tx,
            "INSERT INTO academy.course_assignments \
               (item_id, revision, instructions, points, due_at, text_mode, file_mode, saved_by, saved_at) \
             VALUES ($1::text::uuid, $2::int4, $3, $4::text::numeric, $5::text::timestamptz, $6, $7, $8::text::uuid, $9::text::timestamptz) \
             ON CONFLICT (item_id) DO UPDATE SET \
               revision = EXCLUDED.revision, instructions = EXCLUDED.instructions, points = EXCLUDED.points, due_at = EXCLUDED.due_at, \
               text_mode = EXCLUDED.text_mode, file_mode = EXCLUDED.file_mode, saved_by = EXCLUDED.saved_by, saved_at = EXCLUDED.saved_at",
            &[
                &row.item_id,
                &i32::try_from(revision + 1).unwrap_or(i32::MAX),
                &input.instructions,
                &input.points,
                &input.due_at,
                &input.text,
                &input.file,
                &operator,
                &iso(now),
            ],
        )?;
        admin_in(tx, &row.item_id)
    })
}

/// `withdraw(input)`.
pub fn withdraw(
    pool: &Store,
    item_id: &str,
    reason: &str,
    operator: &str,
    now: i64,
) -> Result<Json, Refusal> {
    begin(pool, |tx| {
        let row = brief(tx, item_id, true)?;
        if row.revision.is_none() {
            return refuse(
                "the assignment has no brief to withdraw",
                "academy.assignment_not_found",
            );
        }
        exec(
            tx,
            "UPDATE academy.course_assignments SET withdrawn_at = $1::text::timestamptz, withdrawn_by = $2::text::uuid, withdraw_reason = $3 \
             WHERE item_id = $4::text::uuid AND withdrawn_at IS NULL",
            &[&iso(now), &operator, &reason, &row.item_id],
        )?;
        admin_in(tx, &row.item_id)
    })
}

/// `learnerRow(sql, itemId, userId, lock)`: the item, its course and the caller's enrolment, refusing what the learner
/// may not open. `now` is the clock `assertItemOpen` reads.
pub fn learner_row<C: GenericClient>(
    c: &mut C,
    item_id: &str,
    user_id: &str,
    lock: bool,
    now: i64,
) -> Result<Brief, Refusal> {
    let sql = format!(
        "SELECT {BRIEF_COLUMNS}, c.slug AS course_slug, c.title AS course_title, c.state AS course_state, \
           EXISTS (SELECT 1 FROM academy.course_enrolments e \
             WHERE e.course_id = c.id AND e.user_id = $2::text::uuid AND e.left_at IS NULL) AS enrolled \
         FROM academy.course_items i \
         JOIN academy.courses c ON c.id = i.course_id \
         LEFT JOIN academy.course_assignments a ON a.item_id = i.id \
         WHERE i.id = $1::text::uuid {}",
        if lock { "FOR SHARE OF i" } else { "" }
    );
    let row = first(c, &sql, &[&item_id, &user_id])?;
    let open = match &row {
        Some(r) => {
            let b = read_brief(r, true)?;
            let state: String = cell(r, "course_state")?;
            (b.kind == "assignment" && b.revision.is_some() && state == "published")
                .then_some((b, cell::<bool>(r, "enrolled")?))
        }
        None => None,
    };
    let Some((b, enrolled)) = open else {
        return refuse(
            "no assignment is open at that address",
            "academy.assignment_not_found",
        );
    };
    if !enrolled {
        return refuse(
            format!("academy.enrolment_required course={}", b.course_slug),
            "academy.enrolment_required",
        );
    }
    assert_item_open(c, &b.item_id, user_id, now)?;
    Ok(b)
}

fn file_json(id: String, name: String, content_type: String, bytes: i64) -> Json {
    Json::obj([
        ("id", Json::String(id)),
        ("fileName", Json::String(name)),
        ("contentType", Json::String(content_type)),
        ("bytes", int(bytes)),
    ])
}

/// `viewOf(sql, row, userId)`.
fn view_of<C: GenericClient>(
    c: &mut C,
    files: &Files<'_>,
    b: &Brief,
    user_id: &str,
) -> Result<Json, Refusal> {
    let rows = query(
        c,
        &format!(
            "SELECT s.version, s.state, s.text, {} AS submitted_at, f.id::text AS file_id, f.file_name, f.content_type, f.bytes::int8 AS bytes \
             FROM academy.assignment_submissions s LEFT JOIN academy.assignment_files f ON f.id = s.file_id \
             WHERE s.item_id = $1::text::uuid AND s.user_id = $2::text::uuid ORDER BY s.version DESC LIMIT $3::int8",
            ms("s.submitted_at")
        ),
        &[&b.item_id, &user_id, &SUBMISSIONS_SHOWN],
    )?;
    let extension = first(
        c,
        &format!(
            "SELECT {} AS due_at, reason FROM academy.course_item_extensions WHERE item_id = $1::text::uuid AND user_id = $2::text::uuid",
            ms("due_at")
        ),
        &[&b.item_id, &user_id],
    )?;
    let extended: Option<(i64, String)> = extension
        .map(|e| Ok::<_, Refusal>((cell(&e, "due_at")?, cell(&e, "reason")?)))
        .transpose()?;
    let due = due_for(b.due_at, extended.as_ref().map(|e| e.0));
    let late_policy = late_policy_of(c, &b.course_id)?;
    let submissions = rows
        .iter()
        .map(|s| {
            let submitted: i64 = cell(s, "submitted_at")?;
            let file_id: Option<String> = cell(s, "file_id")?;
            let file = match file_id {
                None => Json::Null,
                Some(id) => file_json(
                    id,
                    cell(s, "file_name")?,
                    cell(s, "content_type")?,
                    cell(s, "bytes")?,
                ),
            };
            Ok(Json::obj([
                ("version", int(i64::from(cell::<i32>(s, "version")?))),
                ("state", Json::String(cell(s, "state")?)),
                ("text", opt_str(cell(s, "text")?)),
                ("file", file),
                ("submittedAt", Json::String(iso(submitted))),
                ("late", Json::Bool(due.is_some_and(|d| submitted > d))),
            ]))
        })
        .collect::<Result<Vec<_>, Refusal>>()?;
    let next_version = rows
        .first()
        .map(|r| cell::<i32>(r, "version"))
        .transpose()?
        .map_or(0, i64::from)
        + 1;
    let grade = learner_grade_of(c, &b.item_id, user_id)?;
    let mut out: Vec<(String, Json)> = vec![
        ("itemId".into(), Json::str(b.item_id.clone())),
        ("courseSlug".into(), Json::str(b.course_slug.clone())),
        ("courseTitle".into(), Json::str(b.course_title.clone())),
        ("title".into(), Json::str(b.title.clone())),
    ];
    out.extend(brief_fields(b));
    out.extend([
        (
            "latePolicy".to_owned(),
            late_policy.map_or(Json::Null, |(g, d)| {
                Json::obj([
                    ("graceHours", Json::String(g)),
                    ("deductionPerDay", Json::String(d)),
                ])
            }),
        ),
        (
            "fileLimits".to_owned(),
            Json::obj([
                ("maxBytes", files.max().map_or(Json::Null, int)),
                (
                    "types",
                    files.types.as_ref().map_or(Json::Null, |t| {
                        Json::Array(t.iter().cloned().map(Json::String).collect())
                    }),
                ),
            ]),
        ),
        ("withdrawnAt".to_owned(), iso_or_null(b.withdrawn_at)),
        ("submissions".to_owned(), Json::Array(submissions)),
        ("grade".to_owned(), grade.unwrap_or(Json::Null)),
        ("nextVersion".to_owned(), int(next_version)),
        (
            "extension".to_owned(),
            extended.map_or(Json::Null, |(at, reason)| {
                Json::obj([
                    ("dueAt", Json::String(iso(at))),
                    ("reason", Json::String(reason)),
                ])
            }),
        ),
    ]);
    Ok(Json::Object(out))
}

/// `learnerView(input)`.
pub fn learner_view(
    pool: &Store,
    files: &Files<'_>,
    item_id: &str,
    user_id: &str,
    now: i64,
) -> Result<Json, Refusal> {
    with_client(pool, |c| {
        let b = learner_row(c, item_id, user_id, false, now)?;
        view_of(c, files, &b, user_id)
    })
}

/// `uploadFile(input)`.
#[expect(
    clippy::too_many_arguments,
    reason = "the call's fields, as the TypeScript takes them"
)]
pub fn upload_file(
    pool: &Store,
    files: &Files<'_>,
    item_id: &str,
    file_name: &str,
    content_type: &str,
    content_base64: &str,
    user_id: &str,
    now: i64,
) -> Result<Json, Refusal> {
    let row = with_client(pool, |c| learner_row(c, item_id, user_id, false, now))?;
    if row.withdrawn_at.is_some() {
        return refuse(
            "staff withdrew this assignment",
            "academy.assignment_closed",
        );
    }
    if row.file_mode.as_deref() == Some("off") {
        return refuse(
            "this assignment takes no file",
            "academy.upload_type_refused",
        );
    }
    let (Some(_), Some(types)) = (
        files.max_bytes,
        files.types.as_ref().filter(|t| !t.is_empty()),
    ) else {
        return refuse(
            "the owner has not set the upload size limit and the accepted file types",
            "academy.upload_limits_unset",
        );
    };
    let max = files.max().unwrap_or(0);
    let bytes = node_base64(content_base64);
    let size = i64::try_from(bytes.len()).unwrap_or(i64::MAX);
    if size == 0 {
        return refuse("the file is empty", "academy.upload_incomplete");
    }
    if size > max {
        return refuse(
            format!("the file is {size} bytes; the limit is {max}"),
            "academy.upload_too_large",
        );
    }
    let signature = file_signature(content_type);
    let Some(signature) = signature.filter(|_| types.iter().any(|t| t == content_type)) else {
        return refuse(
            format!("{content_type} is not an accepted file type"),
            "academy.upload_type_refused",
        );
    };
    if !signature_matches(bytes.get(..16.min(bytes.len())).unwrap_or(&[]), signature) {
        return refuse(
            format!("the file was declared {content_type} but its content is not"),
            "academy.file_type_mismatch",
        );
    }
    let sha = sha256_hex(&bytes);
    let columns = "id::text AS id, file_name, content_type, bytes::int8 AS bytes";
    let read = |r: &postgres::Row| {
        Ok::<_, Refusal>(file_json(
            cell(r, "id")?,
            cell(r, "file_name")?,
            cell(r, "content_type")?,
            cell(r, "bytes")?,
        ))
    };
    let stored = with_client(pool, |c| {
        first(
            c,
            &format!(
                "SELECT {columns} FROM academy.assignment_files WHERE item_id = $1::text::uuid AND user_id = $2::text::uuid AND sha256 = $3"
            ),
            &[&row.item_id, &user_id, &sha],
        )
    })?;
    if let Some(s) = stored {
        return read(&s);
    }
    let Some(storage) = files.storage.as_ref().filter(|s| configured(s)) else {
        return refuse(
            "File storage is not configured",
            "academy.video_storage_unconfigured",
        );
    };
    let object_key = format!(
        "courses/{}/items/{}/submissions/{user_id}/{sha}",
        row.course_id, row.item_id
    );
    let url = presign(storage, "PUT", &object_key, now)?;
    let status = files
        .bytes
        .put(&url, &bytes, content_type)
        .map_err(|e| Refusal::Internal {
            message: e,
            code: None,
        })?;
    if !(200..300).contains(&status) {
        return refuse(
            "the file did not reach storage; send it again",
            "academy.upload_incomplete",
        );
    }
    let created = with_client(pool, |c| {
        first(
            c,
            &format!(
                "INSERT INTO academy.assignment_files (item_id, user_id, sha256, file_name, content_type, bytes, object_key, created_at) \
                 VALUES ($1::text::uuid, $2::text::uuid, $3, $4, $5, $6::int8, $7, $8::text::timestamptz) \
                 ON CONFLICT (item_id, user_id, sha256) DO UPDATE SET sha256 = EXCLUDED.sha256 RETURNING {columns}"
            ),
            &[&row.item_id, &user_id, &sha, &file_name, &content_type, &size, &object_key, &iso(now)],
        )
    })?
    .ok_or_else(|| Refusal::db("the insert returned no row", None))?;
    read(&created)
}

/// `submit(input)`: version `version` of the learner's hand-in.
#[expect(
    clippy::too_many_arguments,
    reason = "the call's fields, as the TypeScript takes them"
)]
pub fn submit(
    pool: &Store,
    files: &Files<'_>,
    item_id: &str,
    version: i64,
    text_in: Option<&str>,
    file_id: Option<&str>,
    user_id: &str,
    now: i64,
) -> Result<Json, Refusal> {
    begin(pool, |tx| {
        let row = learner_row(tx, item_id, user_id, true, now)?;
        let counted = one(
            tx,
            "SELECT coalesce(bool_or(version = $3::int4), false) AS stored, coalesce(max(version), 0)::int + 1 AS next \
             FROM academy.assignment_submissions WHERE item_id = $1::text::uuid AND user_id = $2::text::uuid",
            &[
                &row.item_id,
                &user_id,
                &i32::try_from(version).unwrap_or(i32::MAX),
            ],
        )?;
        if cell::<bool>(&counted, "stored")? {
            return view_of(tx, files, &row, user_id);
        }
        let next = i64::from(cell::<i32>(&counted, "next")?);
        if version != next {
            return refuse(
                format!(
                    "the next hand-in is version {next}, not {version}; read the assignment again"
                ),
                "academy.submission_version_stale",
            );
        }
        if row.withdrawn_at.is_some() {
            return refuse(
                "staff withdrew this assignment",
                "academy.assignment_closed",
            );
        }
        let text = text_in.filter(|t| !js_trim(t).is_empty());
        if text.is_some() && row.text_mode.as_deref() == Some("off") {
            return refuse(
                "this assignment takes no text answer",
                "academy.submission_incomplete",
            );
        }
        if file_id.is_some() && row.file_mode.as_deref() == Some("off") {
            return refuse(
                "this assignment takes no file",
                "academy.submission_incomplete",
            );
        }
        let mut missing = Vec::new();
        if row.text_mode.as_deref() == Some("required") && text.is_none() {
            missing.push("text");
        }
        if row.file_mode.as_deref() == Some("required") && file_id.is_none() {
            missing.push("file");
        }
        if !missing.is_empty() || (text.is_none() && file_id.is_none()) {
            let named = if missing.is_empty() {
                "answer".to_owned()
            } else {
                missing.join(",")
            };
            return refuse(
                format!("academy.submission_incomplete missing={named}"),
                "academy.submission_incomplete",
            );
        }
        if let Some(fid) = file_id
            && first(
                tx,
                "SELECT 1 FROM academy.assignment_files WHERE id = $1::text::uuid AND item_id = $2::text::uuid AND user_id = $3::text::uuid",
                &[&fid, &row.item_id, &user_id],
            )?
            .is_none()
            {
                return refuse("that file was not uploaded for this assignment", "academy.media_not_found");
            }
        exec(
            tx,
            "INSERT INTO academy.assignment_submissions (item_id, user_id, version, state, text, file_id, submitted_at) \
             VALUES ($1::text::uuid, $2::text::uuid, $3::int4, 'submitted', $4, $5::text::uuid, $6::text::timestamptz) \
             ON CONFLICT (item_id, user_id, version) DO NOTHING",
            &[
                &row.item_id,
                &user_id,
                &i32::try_from(version).unwrap_or(i32::MAX),
                &text,
                &file_id,
                &iso(now),
            ],
        )?;
        view_of(tx, files, &row, user_id)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_reads_as_node_does() {
        assert_eq!(node_base64("aGVsbG8="), b"hello");
        assert_eq!(node_base64("aGVs bG8"), b"hello");
        assert_eq!(node_base64("aGVsbG8=junk"), b"hello");
        assert_eq!(node_base64("-_8"), vec![0xfb, 0xff]);
        assert!(node_base64("a").is_empty());
    }

    #[test]
    fn signatures_check_leading_bytes() {
        let pdf = file_signature("application/pdf").unwrap_or((0, &[]));
        assert!(signature_matches(b"%PDF-1.7", pdf));
        assert!(!signature_matches(b"%PD", pdf));
        let mp4 = file_signature("video/mp4").unwrap_or((0, &[]));
        assert!(signature_matches(b"\0\0\0\x18ftypmp42", mp4));
        assert!(file_signature("text/plain").is_none());
    }
}
