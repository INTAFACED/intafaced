//! AC-rooms-01: the discussion of a course staff made (`curriculum/discussion.ts`): topics, posts, replies, the
//! accepted answer, follow and like.
//!
//! Every course has a default General topic, which is not a row; staff add course-wide topics with a pin and a
//! position, and pinned topics always come first. Only a learner enrolled in the published course reads or writes its
//! discussion. An anonymous post hides its author from classmates only. A post may carry one image, checked by its
//! leading bytes and kept under the owner's size limit; post length and image size are owner values with no default
//! (`ACADEMY_POST_MAX_CHARS`, `ACADEMY_POST_IMAGE_MAX_BYTES`). A retry with the same client request id answers with the
//! stored post. A post a moderator deleted keeps its row and leaves every learner read. No money moves here.

use postgres::GenericClient;
use service_kit::json::Json;
use service_kit::time::Instant;

use super::Db;
use super::{academy, at, col, first, int, iso, ms, rows, serializable, sha256_hex, str_opt};
use crate::db::with_client;
use crate::errors::Refusal;

/// `ACADEMY_DISCUSSION_GENERAL_TOPIC`.
pub const GENERAL_TOPIC: &str = "general";
const GENERAL_TITLE: &str = "General";
/// `ACADEMY_DISCUSSION_IMAGE_TYPES`, each with its leading bytes (`FILE_SIGNATURES` in `curriculum/media.ts`).
const IMAGE_SIGNATURES: [(&str, &[u8]); 3] = [
    (
        "image/png",
        &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ),
    ("image/jpeg", &[0xff, 0xd8, 0xff]),
    ("image/gif", &[0x47, 0x49, 0x46, 0x38]),
];

/// `DiscussionLimits`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub post_max_chars: Option<i64>,
    pub image_max_bytes: Option<i64>,
}

#[derive(Debug, Clone)]
struct CourseRow {
    id: String,
    slug: String,
    title: String,
}

/// `PostRow`.
#[derive(Debug, Clone)]
pub struct PostRow {
    pub id: String,
    pub course_id: String,
    pub topic_slug: String,
    pub parent_id: Option<String>,
    pub kind: Option<String>,
    pub title: Option<String>,
    pub body: String,
    pub author_id: String,
    pub anonymous: bool,
    pub image_type: Option<String>,
    pub accepted_reply_id: Option<String>,
    pub created_at: Instant,
    pub replies: i32,
    pub likes: i32,
    pub liked: bool,
    pub following: bool,
}

/// `classmateLabel`: a classmate's name within one course, stable for the course, and no account id.
pub fn classmate_label(course_id: &str, user_id: &str) -> String {
    let hex = sha256_hex(&format!("discussion:{course_id}:{user_id}"));
    format!("Learner {}", hex.get(0..6).unwrap_or_default())
}

fn author_of(row: &PostRow, reader_id: &str) -> Json {
    if row.author_id == reader_id {
        return Json::obj([
            ("kind", Json::str("you")),
            ("anonymous", Json::Bool(row.anonymous)),
        ]);
    }
    if row.anonymous {
        return Json::obj([("kind", Json::str("anonymous"))]);
    }
    Json::obj([
        ("kind", Json::str("learner")),
        (
            "label",
            Json::str(classmate_label(&row.course_id, &row.author_id)),
        ),
    ])
}

/// `postView`, in `academyDiscussionPostSchema`'s key order.
pub fn post_view(row: &PostRow, reader_id: &str) -> Json {
    Json::obj([
        ("id", Json::str(row.id.clone())),
        ("topicSlug", Json::str(row.topic_slug.clone())),
        ("kind", str_opt(row.kind.clone())),
        ("title", str_opt(row.title.clone())),
        ("body", Json::str(row.body.clone())),
        ("author", author_of(row, reader_id)),
        ("createdAt", iso(row.created_at)),
        ("replies", int(row.replies)),
        ("likes", int(row.likes)),
        ("liked", Json::Bool(row.liked)),
        ("following", Json::Bool(row.following)),
        ("acceptedReplyId", str_opt(row.accepted_reply_id.clone())),
        ("hasImage", Json::Bool(row.image_type.is_some())),
    ])
}

/// `replyView`, in `academyDiscussionReplySchema`'s key order.
pub fn reply_view(row: &PostRow, reader_id: &str, accepted_id: Option<&str>) -> Json {
    Json::obj([
        ("id", Json::str(row.id.clone())),
        ("body", Json::str(row.body.clone())),
        ("author", author_of(row, reader_id)),
        ("createdAt", iso(row.created_at)),
        ("likes", int(row.likes)),
        ("liked", Json::Bool(row.liked)),
        ("accepted", Json::Bool(Some(row.id.as_str()) == accepted_id)),
    ])
}

fn course_json(c: &CourseRow) -> Json {
    Json::obj([
        ("courseId", Json::str(c.id.clone())),
        ("slug", Json::str(c.slug.clone())),
        ("title", Json::str(c.title.clone())),
    ])
}

/// `checkDiscussionImage`: the decoded image, or the typed refusal for one the owner's limit or the type check does
/// not allow.
pub fn check_image(
    content_type: &str,
    base64: &str,
    max_bytes: Option<i64>,
) -> Result<Vec<u8>, Refusal> {
    let Some((_, signature)) = IMAGE_SIGNATURES.iter().find(|(t, _)| *t == content_type) else {
        return Err(academy(
            "academy.attachment_type_refused",
            format!("academy.attachment_type_refused {content_type} is not an image a post takes"),
        ));
    };
    let Some(max) = max_bytes else {
        return Err(academy(
            "academy.attachment_limit_unset",
            "academy.attachment_limit_unset",
        ));
    };
    let bytes = super::base64_decode_node(base64);
    if bytes.is_empty() {
        return Err(academy(
            "academy.attachment_type_refused",
            "academy.attachment_type_refused the image is empty",
        ));
    }
    let n = i64::try_from(bytes.len()).unwrap_or(i64::MAX);
    if n > max {
        return Err(academy(
            "academy.attachment_too_large",
            format!("academy.attachment_too_large bytes={n} max={max}"),
        ));
    }
    let head = bytes.get(..bytes.len().min(16)).unwrap_or_default();
    if !signature
        .iter()
        .enumerate()
        .all(|(i, b)| head.get(i) == Some(b))
    {
        return Err(academy(
            "academy.attachment_type_refused",
            format!(
                "academy.attachment_type_refused declared {content_type} but the content is not"
            ),
        ));
    }
    Ok(bytes)
}

/// `checkPostLength`: refuses a post body while the owner's length is blank, or over it (in code points).
pub fn check_post_length(body: &str, max_chars: Option<i64>) -> Result<(), Refusal> {
    let Some(max) = max_chars else {
        return Err(academy(
            "academy.post_limit_unset",
            "academy.post_limit_unset",
        ));
    };
    let chars = i64::try_from(body.chars().count()).unwrap_or(i64::MAX);
    if chars > max {
        return Err(academy(
            "academy.post_too_long",
            format!("academy.post_too_long chars={chars} max={max}"),
        ));
    }
    Ok(())
}

/// The published course at that address, or `academy.course_not_found`.
fn course<C: GenericClient>(db: &mut C, slug: &str) -> Result<CourseRow, Refusal> {
    let row = first(
        db,
        "SELECT id::text, slug, title FROM academy.courses WHERE slug = $1::text AND state = 'published'",
        &[&slug],
    )?
    .ok_or_else(|| academy("academy.course_not_found", format!("academy.course_not_found slug={slug}")))?;
    Ok(CourseRow {
        id: col(&row, 0)?,
        slug: col(&row, 1)?,
        title: col(&row, 2)?,
    })
}

/// Refuses `academy.enrolment_required` unless the reader holds an open enrolment in the course.
fn assert_enrolled<C: GenericClient>(
    db: &mut C,
    course_id: &str,
    user_id: &str,
) -> Result<(), Refusal> {
    let row = first(
        db,
        "SELECT EXISTS (SELECT 1 FROM academy.course_enrolments
           WHERE course_id = $1::text::uuid AND user_id = $2::text::uuid AND left_at IS NULL) AS enrolled",
        &[&course_id, &user_id],
    )?;
    let enrolled = match &row {
        Some(r) => col::<bool>(r, 0)?,
        None => false,
    };
    if !enrolled {
        return Err(academy(
            "academy.enrolment_required",
            "academy.enrolment_required enrol in this course to join its discussion",
        ));
    }
    Ok(())
}

fn enrolled_course<C: GenericClient>(
    db: &mut C,
    slug: &str,
    user_id: &str,
) -> Result<CourseRow, Refusal> {
    let c = course(db, slug)?;
    assert_enrolled(db, &c.id, user_id)?;
    Ok(c)
}

fn assert_topic<C: GenericClient>(
    db: &mut C,
    course_id: &str,
    topic_slug: &str,
) -> Result<(), Refusal> {
    if topic_slug == GENERAL_TOPIC {
        return Ok(());
    }
    if first(
        db,
        "SELECT 1 FROM academy.discussion_topics WHERE course_id = $1::text::uuid AND slug = $2::text",
        &[&course_id, &topic_slug],
    )?
    .is_none()
    {
        return Err(academy("academy.topic_not_found", format!("academy.topic_not_found topic={topic_slug}")));
    }
    Ok(())
}

/// Which posts `rows` reads.
pub enum Where<'a> {
    Id(&'a str),
    Parent {
        id: &'a str,
        accepted: Option<&'a str>,
        limit: i64,
    },
    Topic {
        course_id: &'a str,
        slug: &'a str,
        limit: i64,
    },
}

fn post_columns() -> String {
    format!(
        "p.id::text, p.course_id::text, p.topic_slug, p.parent_id::text, p.kind, p.title, p.body, p.author_id::text,
         p.anonymous, p.image_type, p.accepted_reply_id::text, {},
         (SELECT count(*)::int FROM academy.discussion_posts r WHERE r.parent_id = p.id AND r.removed_at IS NULL) AS replies,
         (SELECT count(*)::int FROM academy.discussion_likes l WHERE l.post_id = p.id) AS likes,
         EXISTS (SELECT 1 FROM academy.discussion_likes l WHERE l.post_id = p.id AND l.user_id = $1::text::uuid) AS liked,
         EXISTS (SELECT 1 FROM academy.discussion_follows f WHERE f.post_id = p.id AND f.user_id = $1::text::uuid) AS following",
        ms("p.created_at")
    )
}

fn post_row(r: &postgres::Row) -> Result<PostRow, Refusal> {
    Ok(PostRow {
        id: col(r, 0)?,
        course_id: col(r, 1)?,
        topic_slug: col(r, 2)?,
        parent_id: col(r, 3)?,
        kind: col(r, 4)?,
        title: col(r, 5)?,
        body: col(r, 6)?,
        author_id: col(r, 7)?,
        anonymous: col(r, 8)?,
        image_type: col(r, 9)?,
        accepted_reply_id: col(r, 10)?,
        created_at: at(r, 11)?,
        replies: col(r, 12)?,
        likes: col(r, 13)?,
        liked: col(r, 14)?,
        following: col(r, 15)?,
    })
}

/// The posts still showing that `w` names, as the reader sees them.
pub fn post_rows<C: GenericClient>(
    db: &mut C,
    reader_id: &str,
    w: &Where<'_>,
) -> Result<Vec<PostRow>, Refusal> {
    let cols = post_columns();
    let found = match w {
        Where::Id(id) => rows(
            db,
            &format!(
                "SELECT {cols} FROM academy.discussion_posts p WHERE p.removed_at IS NULL AND p.id = $2::text::uuid
                 ORDER BY p.created_at DESC, p.id"
            ),
            &[&reader_id, id],
        )?,
        Where::Parent { id, accepted, limit } => rows(
            db,
            &format!(
                "SELECT {cols} FROM academy.discussion_posts p WHERE p.removed_at IS NULL AND p.parent_id = $2::text::uuid
                 ORDER BY (p.id = $3::text::uuid) IS TRUE DESC, p.created_at, p.id LIMIT $4::int8"
            ),
            &[&reader_id, id, accepted, limit],
        )?,
        Where::Topic { course_id, slug, limit } => rows(
            db,
            &format!(
                "SELECT {cols} FROM academy.discussion_posts p WHERE p.removed_at IS NULL
                   AND p.parent_id IS NULL AND p.course_id = $2::text::uuid AND p.topic_slug = $3::text
                 ORDER BY p.created_at DESC, p.id LIMIT $4::int8"
            ),
            &[&reader_id, course_id, slug, limit],
        )?,
    };
    found.iter().map(post_row).collect()
}

fn not_found(post_id: &str) -> Refusal {
    academy(
        "academy.post_not_found",
        format!("academy.post_not_found post={post_id}"),
    )
}

/// The post or reply with that id in a course the reader is enrolled in, or `academy.post_not_found`.
fn entry<C: GenericClient>(db: &mut C, post_id: &str, reader_id: &str) -> Result<PostRow, Refusal> {
    let row = post_rows(db, reader_id, &Where::Id(post_id))?
        .into_iter()
        .next()
        .ok_or_else(|| not_found(post_id))?;
    if let Some(parent) = &row.parent_id
        && first(
            db,
            "SELECT 1 FROM academy.discussion_posts WHERE id = $1::text::uuid AND removed_at IS NULL",
            &[parent],
        )?
        .is_none()
        {
            return Err(not_found(post_id));
        }
    if first(
        db,
        "SELECT 1 FROM academy.courses WHERE id = $1::text::uuid AND state = 'published'",
        &[&row.course_id],
    )?
    .is_none()
    {
        return Err(not_found(post_id));
    }
    assert_enrolled(db, &row.course_id, reader_id)?;
    Ok(row)
}

/// The published courses the reader is enrolled in, newest enrolment first.
pub fn courses(pool: &Db<'_>, user_id: &str, limit: i64) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let found = rows(
            db,
            "SELECT c.id::text, c.slug, c.title
               FROM academy.course_enrolments e JOIN academy.courses c ON c.id = e.course_id
              WHERE e.user_id = $1::text::uuid AND e.left_at IS NULL AND c.state = 'published'
              ORDER BY e.enrolled_at DESC, c.id
              LIMIT $2::int8",
            &[&user_id, &limit],
        )?;
        let mut out = Vec::new();
        for r in &found {
            out.push(course_json(&CourseRow {
                id: col(r, 0)?,
                slug: col(r, 1)?,
                title: col(r, 2)?,
            }));
        }
        Ok(Json::Array(out))
    })
}

/// The course's topics in order: pinned first, then by position; General sits at position 0 and is never pinned.
pub fn topics(pool: &Db<'_>, user_id: &str, course_slug: &str) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let c = enrolled_course(db, course_slug, user_id)?;
        let topic_rows = rows(
            db,
            &format!(
                "SELECT slug, title, pinned, position, {} FROM academy.discussion_topics WHERE course_id = $1::text::uuid",
                ms("created_at")
            ),
            &[&c.id],
        )?;
        let counts = rows(
            db,
            "SELECT topic_slug, count(*)::int AS posts FROM academy.discussion_posts
              WHERE course_id = $1::text::uuid AND parent_id IS NULL AND removed_at IS NULL GROUP BY topic_slug",
            &[&c.id],
        )?;
        let mut posts_in: Vec<(String, i32)> = Vec::new();
        for r in &counts {
            posts_in.push((col(r, 0)?, col(r, 1)?));
        }
        // (slug, title, pinned, position, general, at)
        let mut topics: Vec<(String, String, bool, i32, bool, i64)> = vec![(
            GENERAL_TOPIC.to_owned(),
            GENERAL_TITLE.to_owned(),
            false,
            0,
            true,
            0,
        )];
        for r in &topic_rows {
            topics.push((
                col(r, 0)?,
                col(r, 1)?,
                col(r, 2)?,
                col(r, 3)?,
                false,
                col(r, 4)?,
            ));
        }
        topics.sort_by(|a, b| {
            b.2.cmp(&a.2)
                .then(a.3.cmp(&b.3))
                .then(b.4.cmp(&a.4))
                .then(a.5.cmp(&b.5))
        });
        let list = topics
            .into_iter()
            .map(|(slug, title, pinned, position, general, _)| {
                let posts = posts_in
                    .iter()
                    .find(|(s, _)| *s == slug)
                    .map_or(0, |(_, n)| *n);
                topic_json(&slug, &title, pinned, i64::from(position), general, posts)
            })
            .collect();
        Ok(Json::obj([
            ("course", course_json(&c)),
            ("topics", Json::Array(list)),
        ]))
    })
}

fn topic_json(
    slug: &str,
    title: &str,
    pinned: bool,
    position: i64,
    general: bool,
    posts: i32,
) -> Json {
    Json::obj([
        ("slug", Json::str(slug)),
        ("title", Json::str(title)),
        ("pinned", Json::Bool(pinned)),
        ("position", Json::int(position)),
        ("general", Json::Bool(general)),
        ("posts", int(posts)),
    ])
}

/// One topic's posts, newest first.
pub fn posts(
    pool: &Db<'_>,
    user_id: &str,
    course_slug: &str,
    topic_slug: &str,
    limit: i64,
) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let c = enrolled_course(db, course_slug, user_id)?;
        assert_topic(db, &c.id, topic_slug)?;
        let found = post_rows(
            db,
            user_id,
            &Where::Topic {
                course_id: &c.id,
                slug: topic_slug,
                limit,
            },
        )?;
        Ok(Json::Array(
            found.iter().map(|r| post_view(r, user_id)).collect(),
        ))
    })
}

/// A post and up to `limit` replies: the accepted answer first, then oldest first. A reply's id opens nothing here.
pub fn thread(pool: &Db<'_>, user_id: &str, post_id: &str, limit: i64) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let post = entry(db, post_id, user_id)?;
        if post.parent_id.is_some() {
            return Err(not_found(post_id));
        }
        let c = first(
            db,
            "SELECT id::text, slug, title FROM academy.courses WHERE id = $1::text::uuid",
            &[&post.course_id],
        )?
        .ok_or_else(|| Refusal::Internal {
            message: "Cannot read properties of undefined (reading 'id')".to_owned(),
            code: None,
        })?;
        let c = CourseRow {
            id: col(&c, 0)?,
            slug: col(&c, 1)?,
            title: col(&c, 2)?,
        };
        let accepted = post.accepted_reply_id.clone();
        let replies = post_rows(
            db,
            user_id,
            &Where::Parent {
                id: &post.id,
                accepted: accepted.as_deref(),
                limit,
            },
        )?;
        Ok(Json::obj([
            ("course", course_json(&c)),
            ("post", post_view(&post, user_id)),
            (
                "replies",
                Json::Array(
                    replies
                        .iter()
                        .map(|r| reply_view(r, user_id, accepted.as_deref()))
                        .collect(),
                ),
            ),
            (
                "canAccept",
                Json::Bool(post.kind.as_deref() == Some("question") && post.author_id == user_id),
            ),
        ]))
    })
}

/// A post's image, or null when it has none.
pub fn image(pool: &Db<'_>, user_id: &str, post_id: &str) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let post = entry(db, post_id, user_id)?;
        let Some(image_type) = post.image_type else {
            return Ok(Json::Null);
        };
        let stored = first(
            db,
            "SELECT image FROM academy.discussion_posts WHERE id = $1::text::uuid",
            &[&post.id],
        )?;
        let bytes: Vec<u8> = match &stored {
            Some(r) => col::<Option<Vec<u8>>>(r, 0)?.unwrap_or_default(),
            None => Vec::new(),
        };
        Ok(Json::obj([
            ("contentType", Json::str(image_type)),
            ("base64", Json::str(super::base64_encode(&bytes))),
        ]))
    })
}

/// What a send under a request id must match to be the same send.
struct Same<'a> {
    parent_id: Option<&'a str>,
    topic_slug: &'a str,
    kind: Option<&'a str>,
    title: Option<&'a str>,
    body: &'a str,
    anonymous: bool,
    image: Option<&'a [u8]>,
}

/// The row an earlier send with this request id stored, or none; a different send under it refuses
/// `academy.request_reused`.
fn by_request<C: GenericClient>(
    db: &mut C,
    user_id: &str,
    client_request_id: &str,
    same: &Same<'_>,
) -> Result<Option<PostRow>, Refusal> {
    let found = first(
        db,
        "SELECT id::text,
                (parent_id IS NOT DISTINCT FROM $1::text::uuid AND topic_slug = $2::text
                 AND kind IS NOT DISTINCT FROM $3::text AND title IS NOT DISTINCT FROM $4::text
                 AND body = $5::text AND anonymous = $6::bool AND image IS NOT DISTINCT FROM $7::bytea) AS same
           FROM academy.discussion_posts WHERE author_id = $8::text::uuid AND client_request_id = $9::text",
        &[
            &same.parent_id,
            &same.topic_slug,
            &same.kind,
            &same.title,
            &same.body,
            &same.anonymous,
            &same.image,
            &user_id,
            &client_request_id,
        ],
    )?;
    let Some(found) = found else {
        return Ok(None);
    };
    let id: String = col(&found, 0)?;
    let is_same: Option<bool> = col(&found, 1)?;
    if is_same != Some(true) {
        return Err(academy(
            "academy.request_reused",
            format!("academy.request_reused request={client_request_id} answers another post"),
        ));
    }
    // The stored post was deleted by a moderator: the retry answers what a read would.
    post_rows(db, user_id, &Where::Id(&id))?
        .into_iter()
        .next()
        .map(Some)
        .ok_or_else(|| not_found(&id))
}

/// A new post's input.
pub struct NewPost<'a> {
    pub course_slug: &'a str,
    pub topic_slug: &'a str,
    pub kind: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    pub anonymous: bool,
    /// `(contentType, base64)`.
    pub image: Option<(&'a str, &'a str)>,
    pub client_request_id: &'a str,
    pub user_id: &'a str,
    pub now: Instant,
}

/// A new question or discussion. A retry with the same client request id answers with the stored post.
pub fn create_post(pool: &Db<'_>, limits: Limits, input: &NewPost<'_>) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let c = enrolled_course(db, input.course_slug, input.user_id)?;
        assert_topic(db, &c.id, input.topic_slug)?;
        check_post_length(input.body, limits.post_max_chars)?;
        let image = match input.image {
            Some((t, b)) => Some(check_image(t, b, limits.image_max_bytes)?),
            None => None,
        };
        let same = Same {
            parent_id: None,
            topic_slug: input.topic_slug,
            kind: Some(input.kind),
            title: Some(input.title),
            body: input.body,
            anonymous: input.anonymous,
            image: image.as_deref(),
        };
        if let Some(stored) = by_request(db, input.user_id, input.client_request_id, &same)? {
            return Ok(post_view(&stored, input.user_id));
        }
        let image_type = input.image.map(|(t, _)| t);
        super::exec(
            db,
            "INSERT INTO academy.discussion_posts
               (course_id, topic_slug, kind, title, body, author_id, anonymous, image_type, image, client_request_id, created_at)
             VALUES ($1::text::uuid, $2::text, $3::text, $4::text, $5::text, $6::text::uuid, $7::bool, $8::text, $9::bytea,
                     $10::text, $11::text::timestamptz)
             ON CONFLICT (author_id, client_request_id) DO NOTHING",
            &[
                &c.id,
                &input.topic_slug,
                &input.kind,
                &input.title,
                &input.body,
                &input.user_id,
                &input.anonymous,
                &image_type,
                &image.as_deref(),
                &input.client_request_id,
                &input.now.iso(),
            ],
        )?;
        let stored =
            by_request(db, input.user_id, input.client_request_id, &same)?.ok_or_else(missing)?;
        Ok(post_view(&stored, input.user_id))
    })
}

fn missing() -> Refusal {
    Refusal::Internal {
        message: "Cannot read properties of null (reading 'id')".to_owned(),
        code: None,
    }
}

/// A reply to a post. Replies nest one level: a reply to a reply refuses `academy.post_not_found`.
#[allow(
    clippy::too_many_arguments,
    reason = "the TypeScript method's input, field for field"
)]
pub fn reply(
    pool: &Db<'_>,
    limits: Limits,
    post_id: &str,
    body: &str,
    anonymous: bool,
    client_request_id: &str,
    user_id: &str,
    now: Instant,
) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let post = entry(db, post_id, user_id)?;
        if post.parent_id.is_some() {
            return Err(not_found(post_id));
        }
        check_post_length(body, limits.post_max_chars)?;
        let same = Same {
            parent_id: Some(&post.id),
            topic_slug: &post.topic_slug,
            kind: None,
            title: None,
            body,
            anonymous,
            image: None,
        };
        let accepted = post.accepted_reply_id.as_deref();
        if let Some(stored) = by_request(db, user_id, client_request_id, &same)? {
            return Ok(reply_view(&stored, user_id, accepted));
        }
        super::exec(
            db,
            "INSERT INTO academy.discussion_posts (course_id, topic_slug, parent_id, body, author_id, anonymous, client_request_id, created_at)
             VALUES ($1::text::uuid, $2::text, $3::text::uuid, $4::text, $5::text::uuid, $6::bool, $7::text, $8::text::timestamptz)
             ON CONFLICT (author_id, client_request_id) DO NOTHING",
            &[
                &post.course_id,
                &post.topic_slug,
                &post.id,
                &body,
                &user_id,
                &anonymous,
                &client_request_id,
                &now.iso(),
            ],
        )?;
        let stored = by_request(db, user_id, client_request_id, &same)?.ok_or_else(missing)?;
        Ok(reply_view(&stored, user_id, accepted))
    })
}

/// The asker marks one reply of their question as accepted; marking another moves the mark.
pub fn accept(
    pool: &Db<'_>,
    user_id: &str,
    post_id: &str,
    reply_id: &str,
) -> Result<Json, Refusal> {
    serializable(pool.get()?, |tx| {
        let post = entry(tx, post_id, user_id)?;
        if post.parent_id.is_some() {
            return Err(not_found(post_id));
        }
        if post.kind.as_deref() != Some("question") || post.author_id != user_id {
            return Err(academy(
                "academy.permission_denied",
                "academy.permission_denied only the asker marks the accepted answer",
            ));
        }
        if first(
            tx,
            "SELECT 1 FROM academy.discussion_posts WHERE id = $1::text::uuid AND parent_id = $2::text::uuid AND removed_at IS NULL",
            &[&reply_id, &post.id],
        )?
        .is_none()
        {
            return Err(academy("academy.post_not_found", format!("academy.post_not_found reply={reply_id}")));
        }
        super::exec(
            tx,
            "UPDATE academy.discussion_posts SET accepted_reply_id = $1::text::uuid WHERE id = $2::text::uuid",
            &[&reply_id, &post.id],
        )?;
        Ok(Json::obj([
            ("postId", Json::str(post.id.clone())),
            ("acceptedReplyId", Json::str(reply_id)),
        ]))
    })
}

/// Follow a post, or stop. Set-style: a repeat changes nothing.
pub fn follow(
    pool: &Db<'_>,
    user_id: &str,
    post_id: &str,
    on: bool,
    now: Instant,
) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let post = entry(db, post_id, user_id)?;
        if post.parent_id.is_some() {
            return Err(not_found(post_id));
        }
        if on {
            super::exec(
                db,
                "INSERT INTO academy.discussion_follows (post_id, user_id, created_at)
                 VALUES ($1::text::uuid, $2::text::uuid, $3::text::timestamptz) ON CONFLICT DO NOTHING",
                &[&post.id, &user_id, &now.iso()],
            )?;
        } else {
            super::exec(
                db,
                "DELETE FROM academy.discussion_follows WHERE post_id = $1::text::uuid AND user_id = $2::text::uuid",
                &[&post.id, &user_id],
            )?;
        }
        Ok(Json::obj([
            ("postId", Json::str(post.id.clone())),
            ("on", Json::Bool(on)),
        ]))
    })
}

/// Like a post or a reply, or take the like back. Set-style: a repeat changes nothing.
pub fn like(
    pool: &Db<'_>,
    user_id: &str,
    post_id: &str,
    on: bool,
    now: Instant,
) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let e = entry(db, post_id, user_id)?;
        if on {
            super::exec(
                db,
                "INSERT INTO academy.discussion_likes (post_id, user_id, created_at)
                 VALUES ($1::text::uuid, $2::text::uuid, $3::text::timestamptz) ON CONFLICT DO NOTHING",
                &[&e.id, &user_id, &now.iso()],
            )?;
        } else {
            super::exec(
                db,
                "DELETE FROM academy.discussion_likes WHERE post_id = $1::text::uuid AND user_id = $2::text::uuid",
                &[&e.id, &user_id],
            )?;
        }
        let count = first(
            db,
            "SELECT count(*)::int AS likes FROM academy.discussion_likes WHERE post_id = $1::text::uuid",
            &[&e.id],
        )?;
        let likes: i32 = match &count {
            Some(r) => col(r, 0)?,
            None => 0,
        };
        Ok(Json::obj([
            ("postId", Json::str(e.id.clone())),
            ("on", Json::Bool(on)),
            ("likes", int(likes)),
        ]))
    })
}

/// A topic staff save.
pub struct SaveTopic<'a> {
    pub course_id: &'a str,
    pub slug: &'a str,
    pub title: &'a str,
    pub pinned: bool,
    pub position: i32,
    pub reason: &'a str,
    pub operator_id: &'a str,
    pub now: Instant,
}

/// Staff: create a topic, or change its title, pin and position, with an event row naming the operator and the reason.
pub fn save_topic(pool: &Db<'_>, input: &SaveTopic<'_>) -> Result<Json, Refusal> {
    serializable(pool.get()?, |tx| {
        if first(
            tx,
            "SELECT 1 FROM academy.courses WHERE id = $1::text::uuid",
            &[&input.course_id],
        )?
        .is_none()
        {
            return Err(academy(
                "academy.course_not_found",
                format!("academy.course_not_found course={}", input.course_id),
            ));
        }
        let now = input.now.iso();
        super::exec(
            tx,
            "INSERT INTO academy.discussion_topics (course_id, slug, title, pinned, position, created_by, created_at, updated_at)
             VALUES ($1::text::uuid, $2::text, $3::text, $4::bool, $5::int4, $6::text::uuid, $7::text::timestamptz, $7::text::timestamptz)
             ON CONFLICT (course_id, slug) DO UPDATE SET
               title = EXCLUDED.title, pinned = EXCLUDED.pinned, position = EXCLUDED.position, updated_at = EXCLUDED.updated_at",
            &[
                &input.course_id,
                &input.slug,
                &input.title,
                &input.pinned,
                &input.position,
                &input.operator_id,
                &now,
            ],
        )?;
        super::exec(
            tx,
            "INSERT INTO academy.discussion_topic_events (course_id, slug, title, pinned, position, operator_id, reason, recorded_at)
             VALUES ($1::text::uuid, $2::text, $3::text, $4::bool, $5::int4, $6::text::uuid, $7::text, $8::text::timestamptz)",
            &[
                &input.course_id,
                &input.slug,
                &input.title,
                &input.pinned,
                &input.position,
                &input.operator_id,
                &input.reason,
                &now,
            ],
        )?;
        let posts = first(
            tx,
            "SELECT count(*)::int AS posts FROM academy.discussion_posts
              WHERE course_id = $1::text::uuid AND topic_slug = $2::text AND parent_id IS NULL AND removed_at IS NULL",
            &[&input.course_id, &input.slug],
        )?;
        let posts: i32 = match &posts {
            Some(r) => col(r, 0)?,
            None => 0,
        };
        Ok(topic_json(
            input.slug,
            input.title,
            input.pinned,
            i64::from(input.position),
            false,
            posts,
        ))
    })
}

/// Staff: a post and its replies with the account behind each, anonymous or not.
pub fn staff_thread(pool: &Db<'_>, post_id: &str, limit: i64) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let cols = format!(
            "id::text, course_id::text, topic_slug, kind, title, body, author_id::text, anonymous, {}",
            ms("created_at")
        );
        let post = first(
            db,
            &format!("SELECT {cols} FROM academy.discussion_posts WHERE id = $1::text::uuid AND parent_id IS NULL"),
            &[&post_id],
        )?
        .ok_or_else(|| not_found(post_id))?;
        let replies = rows(
            db,
            &format!(
                "SELECT {cols} FROM academy.discussion_posts WHERE parent_id = $1::text::uuid ORDER BY created_at, id LIMIT $2::int8"
            ),
            &[&post_id, &limit],
        )?;
        let entry = |r: &postgres::Row| -> Result<Vec<(String, Json)>, Refusal> {
            Ok(vec![
                ("id".to_owned(), Json::str(col::<String>(r, 0)?)),
                ("authorId".to_owned(), Json::str(col::<String>(r, 6)?)),
                ("anonymous".to_owned(), Json::Bool(col(r, 7)?)),
                ("body".to_owned(), Json::str(col::<String>(r, 5)?)),
                ("createdAt".to_owned(), iso(at(r, 8)?)),
            ])
        };
        let mut head = entry(&post)?;
        head.push(("courseId".to_owned(), Json::str(col::<String>(&post, 1)?)));
        head.push(("topicSlug".to_owned(), Json::str(col::<String>(&post, 2)?)));
        head.push(("kind".to_owned(), str_opt(col(&post, 3)?)));
        head.push(("title".to_owned(), str_opt(col(&post, 4)?)));
        let mut list = Vec::new();
        for r in &replies {
            list.push(Json::Object(entry(r)?));
        }
        Ok(Json::obj([
            ("post", Json::Object(head)),
            ("replies", Json::Array(list)),
        ]))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

    fn code(r: Result<impl std::fmt::Debug, Refusal>) -> String {
        match r {
            Err(Refusal::Academy(e)) => e.code,
            other => format!("{other:?}"),
        }
    }

    #[test]
    fn an_image_is_checked_by_type_owner_limit_size_and_leading_bytes() {
        assert_eq!(
            code(check_image("application/pdf", "JVBERi0=", Some(1024))),
            "academy.attachment_type_refused"
        );
        assert_eq!(
            code(check_image("image/svg+xml", "PHN2Zy8+", Some(1024))),
            "academy.attachment_type_refused"
        );
        assert_eq!(
            code(check_image("image/png", PNG, None)),
            "academy.attachment_limit_unset"
        );
        assert_eq!(
            code(check_image("image/png", PNG, Some(10))),
            "academy.attachment_too_large"
        );
        assert_eq!(
            code(check_image("image/png", "JVBERi0xLjQK", Some(1024))),
            "academy.attachment_type_refused"
        );
        assert_eq!(
            code(check_image("image/png", "====", Some(1024))),
            "academy.attachment_type_refused"
        );
        assert_eq!(
            check_image("image/png", PNG, Some(1024))
                .map(|b| b.len())
                .ok(),
            Some(68)
        );
    }

    #[test]
    fn a_post_length_counts_code_points_against_the_owner_value() {
        assert_eq!(
            code(check_post_length("x", None)),
            "academy.post_limit_unset"
        );
        assert_eq!(
            code(check_post_length(&"x".repeat(101), Some(100))),
            "academy.post_too_long"
        );
        assert!(check_post_length(&"\u{1f600}".repeat(100), Some(100)).is_ok());
    }

    #[test]
    fn a_classmate_label_is_stable_and_names_no_account() {
        let label = classmate_label("c", "u");
        assert_eq!(label, classmate_label("c", "u"));
        assert_ne!(label, classmate_label("d", "u"));
        assert!(label.starts_with("Learner ") && label.len() == 14);
    }
}
