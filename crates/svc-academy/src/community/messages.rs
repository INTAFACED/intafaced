//! AC-rooms-04: message the course team (`curriculum/course-messages.ts`).
//!
//! One conversation per course and learner; each side's unread marker is on while the other side wrote after it last
//! read, and opening the conversation clears it. Mail copies need an email provider this build has none of, so every
//! answer names `vendor.email`. Message length is an owner value with no default (`ACADEMY_MESSAGE_MAX_CHARS`). A retry
//! with the same client request id from the same side is the same message; a different message under it refuses
//! `academy.request_reused`. No money moves here.

use postgres::{Client, Row};
use service_kit::json::Json;
use service_kit::time::Instant;

use super::Db;
use super::{academy, at, col, exec, first, iso, ms, rows};
use crate::db::with_client;
use crate::errors::Refusal;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sender {
    Learner,
    Staff,
}

impl Sender {
    fn as_str(self) -> &'static str {
        match self {
            Sender::Learner => "learner",
            Sender::Staff => "staff",
        }
    }
}

/// The mail copy of every message: there is no email provider in this build.
pub fn mail_copy() -> Json {
    Json::obj([
        ("state", Json::str("not_connected")),
        ("code", Json::str("vendor.email")),
    ])
}

fn request_key(sender: Sender, client_request_id: &str) -> String {
    format!("{}:{client_request_id}", sender.as_str())
}

struct MessageRow {
    id: String,
    conversation_id: String,
    sender: String,
    sender_id: String,
    body: String,
    sent_at: Instant,
}

fn message_columns(prefix: &str) -> String {
    format!(
        "{p}id::text, {p}conversation_id::text, {p}sender, {p}sender_id::text, {p}body, {}",
        ms(&format!("{prefix}sent_at")),
        p = prefix
    )
}

fn message_row(r: &Row) -> Result<MessageRow, Refusal> {
    Ok(MessageRow {
        id: col(r, 0)?,
        conversation_id: col(r, 1)?,
        sender: col(r, 2)?,
        sender_id: col(r, 3)?,
        body: col(r, 4)?,
        sent_at: at(r, 5)?,
    })
}

fn message_of(m: &MessageRow) -> Json {
    Json::obj([
        ("id", Json::str(m.id.clone())),
        ("from", Json::str(m.sender.clone())),
        ("body", Json::str(m.body.clone())),
        ("sentAt", iso(m.sent_at)),
    ])
}

/// Refuses a message while the owner's length is blank, or over it (in code points, as `[...body].length`).
pub fn check_message_length(body: &str, max_chars: Option<i64>) -> Result<(), Refusal> {
    let Some(max) = max_chars else {
        return Err(academy(
            "academy.message_limit_unset",
            "academy.message_limit_unset",
        ));
    };
    let chars = i64::try_from(body.chars().count()).unwrap_or(i64::MAX);
    if chars > max {
        return Err(academy(
            "academy.message_too_long",
            format!("academy.message_too_long chars={chars} max={max}"),
        ));
    }
    Ok(())
}

struct ConversationRow {
    id: String,
    course_id: String,
    course_slug: String,
    course_title: String,
    learner_id: String,
    last_message_at: Instant,
    unread: bool,
}

/// Conversations with the reader's unread marker: on while the other side wrote after the reader last read.
fn conversations(
    db: &mut Client,
    reader: Sender,
    id: Option<&str>,
    learner_id: Option<&str>,
    limit: i64,
) -> Result<Vec<ConversationRow>, Refusal> {
    let (other, read_at) = match reader {
        Sender::Learner => ("staff", "v.learner_read_at"),
        Sender::Staff => ("learner", "v.staff_read_at"),
    };
    let sql = format!(
        "SELECT v.id::text, v.course_id::text, c.slug AS course_slug, c.title AS course_title, v.learner_id::text, {},
                EXISTS (SELECT 1 FROM academy.course_messages m WHERE m.conversation_id = v.id AND m.sender = $1::text
                         AND ({read_at} IS NULL OR m.sent_at > {read_at})) AS unread
           FROM academy.course_conversations v JOIN academy.courses c ON c.id = v.course_id
          WHERE ($2::text IS NULL OR v.id = $2::text::uuid)
            AND ($3::text IS NULL OR v.learner_id = $3::text::uuid)
          ORDER BY v.last_message_at DESC, v.id
          LIMIT $4::int8",
        ms("v.last_message_at")
    );
    rows(db, &sql, &[&other, &id, &learner_id, &limit])?
        .iter()
        .map(|r| {
            Ok(ConversationRow {
                id: col(r, 0)?,
                course_id: col(r, 1)?,
                course_slug: col(r, 2)?,
                course_title: col(r, 3)?,
                learner_id: col(r, 4)?,
                last_message_at: at(r, 5)?,
                unread: col(r, 6)?,
            })
        })
        .collect()
}

/// The newest `limit` messages, oldest first, and whether older ones were left out.
fn messages(
    db: &mut Client,
    conversation_id: &str,
    limit: i64,
) -> Result<(bool, Vec<MessageRow>), Refusal> {
    let found = rows(
        db,
        &format!(
            "SELECT {} FROM academy.course_messages WHERE conversation_id = $1::text::uuid
              ORDER BY sent_at DESC, id DESC LIMIT $2::int8",
            message_columns("")
        ),
        &[&conversation_id, &(limit + 1)],
    )?;
    let keep = usize::try_from(limit).unwrap_or(usize::MAX);
    let earlier = found.len() > keep;
    let mut list = found
        .iter()
        .take(keep)
        .map(message_row)
        .collect::<Result<Vec<_>, _>>()?;
    list.reverse();
    Ok((earlier, list))
}

enum Same<'a> {
    Conversation(&'a str),
    Course(&'a str),
}

/// The stored message under this side's request id, refusing one that answers a different message.
fn by_request(
    db: &mut Client,
    sender: Sender,
    sender_id: &str,
    client_request_id: &str,
    same: &Same<'_>,
    body: &str,
) -> Result<Option<MessageRow>, Refusal> {
    let row = first(
        db,
        &format!(
            "SELECT {}, c.slug AS course_slug
               FROM academy.course_messages m
               JOIN academy.course_conversations v ON v.id = m.conversation_id
               JOIN academy.courses c ON c.id = v.course_id
              WHERE m.sender_id = $1::text::uuid AND m.client_request_id = $2::text",
            message_columns("m.")
        ),
        &[&sender_id, &request_key(sender, client_request_id)],
    )?;
    let Some(row) = row else {
        return Ok(None);
    };
    let message = message_row(&row)?;
    let slug: String = col(&row, 6)?;
    let same_conversation = match same {
        Same::Conversation(id) => message.conversation_id == *id,
        Same::Course(s) => slug == *s,
    };
    if !same_conversation || message.body != body {
        return Err(academy(
            "academy.request_reused",
            format!("academy.request_reused request={client_request_id} answers another message"),
        ));
    }
    Ok(Some(message))
}

fn undefined() -> Refusal {
    Refusal::Internal {
        message: "Cannot read properties of undefined (reading 'id')".to_owned(),
        code: None,
    }
}

fn insert(
    pool: &Db<'_>,
    conversation_id: &str,
    sender: Sender,
    sender_id: &str,
    body: &str,
    client_request_id: &str,
    now: Instant,
) -> Result<MessageRow, Refusal> {
    let same = Same::Conversation(conversation_id);
    if let Some(stored) = with_client(pool.get()?, |db| {
        by_request(db, sender, sender_id, client_request_id, &same, body)
    })? {
        return Ok(stored);
    }
    super::serializable(pool.get()?, |tx| {
        let inserted = first(
            tx,
            "INSERT INTO academy.course_messages (conversation_id, sender, sender_id, body, client_request_id, sent_at)
             VALUES ($1::text::uuid, $2::text, $3::text::uuid, $4::text, $5::text, $6::text::timestamptz)
             ON CONFLICT (sender_id, client_request_id) DO NOTHING
             RETURNING id",
            &[
                &conversation_id,
                &sender.as_str(),
                &sender_id,
                &body,
                &request_key(sender, client_request_id),
                &now.iso(),
            ],
        )?;
        // Sending never marks the other side's messages read: only opening the conversation does.
        if inserted.is_some() {
            exec(
                tx,
                "UPDATE academy.course_conversations SET last_message_at = GREATEST(last_message_at, $1::text::timestamptz)
                  WHERE id = $2::text::uuid",
                &[&now.iso(), &conversation_id],
            )?;
        }
        Ok(())
    })?;
    with_client(pool.get()?, |db| {
        by_request(db, sender, sender_id, client_request_id, &same, body)
    })?
    .ok_or_else(undefined)
}

/// The learner writes to the course team of a published course they are enrolled in.
pub fn send(
    pool: &Db<'_>,
    max_chars: Option<i64>,
    user_id: &str,
    course_slug: &str,
    body: &str,
    client_request_id: &str,
    now: Instant,
) -> Result<Json, Refusal> {
    let conversation = with_client(pool.get()?, |db| {
        // A retry of a message already stored answers with it, even if the course or the limit changed since.
        if let Some(stored) = by_request(
            db,
            Sender::Learner,
            user_id,
            client_request_id,
            &Same::Course(course_slug),
            body,
        )? {
            return Ok(Err(sent(&stored.conversation_id, &stored)));
        }
        let course = first(
            db,
            "SELECT c.id::text, EXISTS (SELECT 1 FROM academy.course_enrolments e
                      WHERE e.course_id = c.id AND e.user_id = $1::text::uuid AND e.left_at IS NULL) AS enrolled
               FROM academy.courses c WHERE c.slug = $2::text AND c.state = 'published'",
            &[&user_id, &course_slug],
        )?
        .ok_or_else(|| academy("academy.course_not_found", format!("academy.course_not_found slug={course_slug}")))?;
        let course_id: String = col(&course, 0)?;
        if !col::<bool>(&course, 1)? {
            return Err(academy(
                "academy.enrolment_required",
                "academy.enrolment_required enrol in this course to message its course team",
            ));
        }
        check_message_length(body, max_chars)?;
        exec(
            db,
            "INSERT INTO academy.course_conversations (course_id, learner_id, created_at, last_message_at)
             VALUES ($1::text::uuid, $2::text::uuid, $3::text::timestamptz, $3::text::timestamptz)
             ON CONFLICT (course_id, learner_id) DO NOTHING",
            &[&course_id, &user_id, &now.iso()],
        )?;
        let conversation: String = col(
            &first(
                db,
                "SELECT id::text FROM academy.course_conversations WHERE course_id = $1::text::uuid AND learner_id = $2::text::uuid",
                &[&course_id, &user_id],
            )?
            .ok_or_else(undefined)?,
            0,
        )?;
        Ok(Ok(conversation))
    })?;
    match conversation {
        Err(retry) => Ok(retry),
        Ok(conversation) => {
            let row = insert(
                pool,
                &conversation,
                Sender::Learner,
                user_id,
                body,
                client_request_id,
                now,
            )?;
            Ok(sent(&conversation, &row))
        }
    }
}

fn sent(conversation_id: &str, m: &MessageRow) -> Json {
    Json::obj([
        ("conversationId", Json::str(conversation_id)),
        ("message", message_of(m)),
        ("mailCopy", mail_copy()),
    ])
}

/// The learner's own conversations, newest first.
pub fn inbox(pool: &Db<'_>, user_id: &str, limit: i64) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let list = conversations(db, Sender::Learner, None, Some(user_id), limit)?;
        Ok(Json::Array(
            list.iter()
                .map(|r| {
                    Json::obj([
                        ("id", Json::str(r.id.clone())),
                        ("courseSlug", Json::str(r.course_slug.clone())),
                        ("courseTitle", Json::str(r.course_title.clone())),
                        ("lastMessageAt", iso(r.last_message_at)),
                        ("unread", Json::Bool(r.unread)),
                    ])
                })
                .collect(),
        ))
    })
}

fn not_found(id: &str) -> Refusal {
    academy(
        "academy.conversation_not_found",
        format!("academy.conversation_not_found id={id}"),
    )
}

/// One of the learner's own conversations; opening it marks it read on their side. Anyone else's is not found.
pub fn open(
    pool: &Db<'_>,
    user_id: &str,
    conversation_id: &str,
    limit: i64,
    now: Instant,
) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let list = conversations(db, Sender::Learner, Some(conversation_id), Some(user_id), 1)?;
        let row = list.first().ok_or_else(|| not_found(conversation_id))?;
        exec(
            db,
            "UPDATE academy.course_conversations SET learner_read_at = GREATEST(COALESCE(learner_read_at, $1::text::timestamptz), $1::text::timestamptz)
              WHERE id = $2::text::uuid",
            &[&now.iso(), &row.id],
        )?;
        let (earlier, list) = messages(db, &row.id, limit)?;
        Ok(Json::obj([
            ("id", Json::str(row.id.clone())),
            ("courseSlug", Json::str(row.course_slug.clone())),
            ("courseTitle", Json::str(row.course_title.clone())),
            ("lastMessageAt", iso(row.last_message_at)),
            ("unread", Json::Bool(false)),
            ("earlier", Json::Bool(earlier)),
            (
                "messages",
                Json::Array(list.iter().map(message_of).collect()),
            ),
        ]))
    })
}

/// Staff: every conversation, newest first.
pub fn staff_inbox(pool: &Db<'_>, limit: i64) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let list = conversations(db, Sender::Staff, None, None, limit)?;
        Ok(Json::Array(
            list.iter()
                .map(|r| {
                    Json::obj([
                        ("id", Json::str(r.id.clone())),
                        ("courseId", Json::str(r.course_id.clone())),
                        ("courseSlug", Json::str(r.course_slug.clone())),
                        ("courseTitle", Json::str(r.course_title.clone())),
                        ("learnerId", Json::str(r.learner_id.clone())),
                        ("lastMessageAt", iso(r.last_message_at)),
                        ("staffUnread", Json::Bool(r.unread)),
                    ])
                })
                .collect(),
        ))
    })
}

/// Staff: one conversation with the account behind each message; opening it marks it read on the staff side.
pub fn staff_open(
    pool: &Db<'_>,
    conversation_id: &str,
    limit: i64,
    now: Instant,
) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let list = conversations(db, Sender::Staff, Some(conversation_id), None, 1)?;
        let row = list.first().ok_or_else(|| not_found(conversation_id))?;
        exec(
            db,
            "UPDATE academy.course_conversations SET staff_read_at = GREATEST(COALESCE(staff_read_at, $1::text::timestamptz), $1::text::timestamptz)
              WHERE id = $2::text::uuid",
            &[&now.iso(), &row.id],
        )?;
        let (earlier, list) = messages(db, &row.id, limit)?;
        Ok(Json::obj([
            ("id", Json::str(row.id.clone())),
            ("courseId", Json::str(row.course_id.clone())),
            ("courseSlug", Json::str(row.course_slug.clone())),
            ("courseTitle", Json::str(row.course_title.clone())),
            ("learnerId", Json::str(row.learner_id.clone())),
            ("lastMessageAt", iso(row.last_message_at)),
            ("staffUnread", Json::Bool(false)),
            ("earlier", Json::Bool(earlier)),
            (
                "messages",
                Json::Array(
                    list.iter()
                        .map(|m| {
                            Json::obj([
                                ("id", Json::str(m.id.clone())),
                                ("from", Json::str(m.sender.clone())),
                                ("body", Json::str(m.body.clone())),
                                ("sentAt", iso(m.sent_at)),
                                ("senderId", Json::str(m.sender_id.clone())),
                            ])
                        })
                        .collect(),
                ),
            ),
        ]))
    })
}

/// Staff answer a conversation. The learner's marker turns on until they open it.
pub fn staff_reply(
    pool: &Db<'_>,
    max_chars: Option<i64>,
    operator_id: &str,
    conversation_id: &str,
    body: &str,
    client_request_id: &str,
    now: Instant,
) -> Result<Json, Refusal> {
    let id: String = with_client(pool.get()?, |db| {
        let row = first(
            db,
            "SELECT id::text FROM academy.course_conversations WHERE id = $1::text::uuid",
            &[&conversation_id],
        )?
        .ok_or_else(|| not_found(conversation_id))?;
        col(&row, 0)
    })?;
    check_message_length(body, max_chars)?;
    let message = insert(
        pool,
        &id,
        Sender::Staff,
        operator_id,
        body,
        client_request_id,
        now,
    )?;
    Ok(sent(&id, &message))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_limit_refuses_and_length_counts_code_points() {
        assert!(check_message_length("hi", None).is_err());
        assert!(check_message_length("😀😀", Some(2)).is_ok());
        assert!(check_message_length("😀😀😀", Some(2)).is_err());
    }

    #[test]
    fn each_side_keeps_its_own_request_ids() {
        assert_eq!(request_key(Sender::Learner, "r1"), "learner:r1");
        assert_eq!(request_key(Sender::Staff, "r1"), "staff:r1");
    }
}
