//! The lobbies' part of `AcademyService` (`academy-service.ts`, Rooms and Sessions) and of `AcademyCustomerStore`
//! (`learning/customer-store.ts`: the caller's seats, upcoming sessions and calendar), over the same SQL against the
//! `academy` schema.
//!
//! Each method takes its checks in the TypeScript's order: an owner value checked before the first query refuses
//! even when the database is down, and one checked after it does not. Values go out as postgres.js read them:
//! timestamps at millisecond precision (`floor(epoch * 1000)`), numeric as a decimal string scaled to an `Amount`,
//! `count(*)` as text read as a number, jsonb as parsed JSON in JavaScript's key order.

use postgres::types::ToSql;
use postgres::{IsolationLevel, Row};
use service_kit::json::{self, Json};
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::pg::Pool;
use service_kit::schema::Value;
use service_kit::time::Instant;

use crate::db::{self, Store};
use crate::errors::{AcademyError, Refusal};
use crate::lobbies::clients::may_host;
use crate::lobbies::scene::{self, Write};
use crate::lobbies::seat::{self, Access, RoomTerms, Seat, SeatRequest};
use crate::lobbies::{calendar, spine};
use crate::ports::{Ports, StreamCredential};

/// A room (`RoomRecord`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Room {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub kind: String,
    pub access: Access,
    pub min_stake: Amount,
    pub capacity: i64,
    pub host_id: String,
}

/// A session (`SessionRecord`): `scene` is the stored jsonb as read, `scene_fingerprint` that of its readable form.
#[derive(Debug, Clone, PartialEq)]
pub struct Session {
    pub id: String,
    pub room_id: String,
    pub title: String,
    pub host_id: String,
    pub status: String,
    pub starts_at: Instant,
    pub ends_at: Option<Instant>,
    pub stream_provider: Option<String>,
    pub stream_room: Option<String>,
    pub scene: Value,
    pub scene_fingerprint: String,
}

/// `CallerSeat`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallerSeat {
    pub session_id: String,
    pub room_id: String,
    pub role: String,
}

/// `UpcomingSession`: a session the caller is seated in, as the wire carries it.
#[derive(Debug, Clone, PartialEq)]
pub struct Upcoming {
    pub session: Session,
    pub role: String,
}

/// A room to open (`createRoom`'s input, `minStake` already an amount).
#[derive(Debug, Clone, PartialEq)]
pub struct NewRoom {
    pub host_id: String,
    pub slug: String,
    pub name: String,
    pub kind: String,
    pub access: Access,
    pub min_stake: Option<Amount>,
    pub capacity: f64,
}

const ROOM_COLS: &str = "id::text AS id, slug, name, kind::text AS kind, access::text AS access, \
     min_stake::text AS min_stake, capacity, host_id::text AS host_id";

const SESSION_COLS: &str = "id::text AS id, room_id::text AS room_id, title, host_id::text AS host_id, \
     status::text AS status, floor(extract(epoch FROM starts_at) * 1000)::int8 AS starts_ms, \
     floor(extract(epoch FROM ends_at) * 1000)::int8 AS ends_ms, stream_provider, stream_room, scene::text AS scene";

fn broken(message: impl Into<String>) -> Refusal {
    Refusal::Internal {
        message: message.into(),
        code: None,
    }
}

fn get<'a, T: postgres::types::FromSql<'a>>(row: &'a Row, col: &str) -> Result<T, Refusal> {
    row.try_get(col).map_err(|e| broken(e.to_string()))
}

fn to_room(row: &Row) -> Result<Room, Refusal> {
    let access: String = get(row, "access")?;
    let min_stake: String = get(row, "min_stake")?;
    let capacity: i32 = get(row, "capacity")?;
    Ok(Room {
        id: get(row, "id")?,
        slug: get(row, "slug")?,
        name: get(row, "name")?,
        kind: get(row, "kind")?,
        access: Access::parse(&access).ok_or_else(|| broken(format!("room access {access}")))?,
        min_stake: parse_amount(&min_stake).map_err(broken)?,
        capacity: i64::from(capacity),
        host_id: get(row, "host_id")?,
    })
}

/// jsonb as postgres.js hands it over: `JSON.parse` of its text.
fn jsonb(text: &str) -> Result<Value, Refusal> {
    json::parse(text)
        .map(|j| Value::from_json(&j))
        .map_err(|e| broken(e.message))
}

fn to_session(row: &Row) -> Result<Session, Refusal> {
    let text: String = get(row, "scene")?;
    let stored = jsonb(&text)?;
    // `SessionRow`'s `scene: z.record(z.string(), z.unknown())`.
    if !matches!(stored, Value::Object(_)) {
        return Err(broken("session scene is not an object"));
    }
    let readable = scene::readable_or_empty(&stored);
    let ends: Option<i64> = get(row, "ends_ms")?;
    Ok(Session {
        id: get(row, "id")?,
        room_id: get(row, "room_id")?,
        title: get(row, "title")?,
        host_id: get(row, "host_id")?,
        status: get(row, "status")?,
        starts_at: Instant(get(row, "starts_ms")?),
        ends_at: ends.map(Instant),
        stream_provider: get(row, "stream_provider")?,
        stream_room: get(row, "stream_room")?,
        scene_fingerprint: scene::fingerprint(&readable),
        scene: stored,
    })
}

fn academy(message: impl Into<String>, code: &str) -> Refusal {
    Refusal::Academy(AcademyError::new(message, code))
}

/// `assertSqlListLimit` (`sql-list-limit.ts`) and `assertCustomerListLimit` (`learning/limits.ts`): a finite number
/// at least 1 once floored, cut to 200.
pub fn list_limit(limit: &Value, code: &str, label: &str) -> Result<i64, Refusal> {
    let unset = || {
        academy(
            format!("{label} list limit is unset — pass limit (never invent the whole table)"),
            code,
        )
    };
    let Value::Number(n) = limit else {
        return Err(unset());
    };
    if !n.is_finite() {
        return Err(unset());
    }
    let n = n.floor();
    if n < 1.0 {
        return Err(unset());
    }
    Ok(if n >= 200.0 { 200 } else { n as i64 })
}

/// `assertPublishedMaxRoomCapacity`: the owner's lobby ceiling, an integer in 1..=100000, or `room_capacity_unset`.
pub fn published_max_room_capacity(max: Option<&Json>) -> Result<i64, Refusal> {
    match max {
        Some(Json::Number(n)) if n.fract() == 0.0 && *n >= 1.0 && *n <= 100_000.0 => Ok(*n as i64),
        _ => Err(academy(
            "Academy max room capacity is unset — set ACADEMY_MAX_ROOM_CAPACITY (never invent a ceiling)",
            "academy.room_capacity_unset",
        )),
    }
}

/// The lobbies over one store and the service's ports.
pub struct Lobbies<'a> {
    pub store: &'a Store,
    pub ports: &'a Ports,
    /// `options.maxRoomCapacity` (`ACADEMY_MAX_ROOM_CAPACITY`).
    pub max_room_capacity: Option<&'a Json>,
    /// `new Date()` for this call.
    pub now: Instant,
}

type Params<'p> = [&'p (dyn ToSql + Sync)];

impl Lobbies<'_> {
    /// A method is entered: a service that refuses every method (the replay's) refuses here, before any check.
    pub fn enter(&self) -> Result<(), Refusal> {
        match self.store {
            Store::Refuses(r) => Err(r.clone()),
            _ => Ok(()),
        }
    }

    fn pool(&self) -> Result<&Pool, Refusal> {
        self.store.pool()
    }

    fn query(&self, sql: &str, params: &Params<'_>) -> Result<Vec<Row>, Refusal> {
        db::with_client(self.pool()?, |c| {
            c.query(sql, params).map_err(|e| db::refusal(&e))
        })
    }

    fn execute(&self, sql: &str, params: &Params<'_>) -> Result<u64, Refusal> {
        db::with_client(self.pool()?, |c| {
            c.execute(sql, params).map_err(|e| db::refusal(&e))
        })
    }

    // ── Rooms ─────────────────────────────────────────────────────────────────────────────────────────────────────

    /// `createRoom`: host rights first, then the owner's ceiling, then the stake gate's threshold, then the insert.
    pub fn create_room(&self, input: &NewRoom) -> Result<Room, Refusal> {
        self.enter()?;
        self.assert_may_host(&input.host_id)?;
        let max = published_max_room_capacity(self.max_room_capacity)?;
        if input.capacity > max as f64 {
            return Err(academy(
                format!("A lobby cannot seat more than {max} — presence fans out over the gateway"),
                "academy.room_full",
            ));
        }
        let min_stake = if input.access == Access::Staked {
            input.min_stake.unwrap_or(Amount::ZERO)
        } else {
            Amount::ZERO
        };
        if input.access == Access::Staked && min_stake <= Amount::ZERO {
            return Err(academy(
                "A staked lobby needs a stake threshold above zero",
                "academy.stake_required",
            ));
        }
        let capacity = input.capacity as i32;
        let rows = self.query(
            &format!(
                "INSERT INTO academy.rooms (slug, name, kind, access, min_stake, capacity, host_id)
                 VALUES ($1, $2, $3::text::academy.room_kind, $4::text::academy.room_access, $5::text::numeric, $6, $7::text::uuid)
                 RETURNING {ROOM_COLS}"
            ),
            &[
                &input.slug,
                &input.name,
                &input.kind,
                &input.access.name(),
                &format_amount(min_stake),
                &capacity,
                &input.host_id,
            ],
        )?;
        to_room(
            rows.first()
                .ok_or_else(|| broken("Cannot read properties of undefined (reading 'id')"))?,
        )
    }

    pub fn room(&self, room_id: &str) -> Result<Room, Refusal> {
        self.enter()?;
        let rows = self.query(
            &format!("SELECT {ROOM_COLS} FROM academy.rooms WHERE id = $1::text::uuid"),
            &[&room_id],
        )?;
        match rows.first() {
            Some(row) => to_room(row),
            None => Err(academy(
                format!("Room {room_id} not found"),
                "academy.room_not_found",
            )),
        }
    }

    /// `listRooms`: the limit is checked before the query.
    pub fn list_rooms(&self, kind: Option<&str>, limit: &Value) -> Result<Vec<Room>, Refusal> {
        self.enter()?;
        let limit = list_limit(limit, "academy.rooms_list_limit_unset", "Rooms")?;
        let rows = match kind {
            Some(kind) => self.query(
                &format!(
                    "SELECT {ROOM_COLS} FROM academy.rooms WHERE kind = $1::text::academy.room_kind ORDER BY name ASC LIMIT $2"
                ),
                &[&kind, &limit],
            )?,
            None => self.query(
                &format!("SELECT {ROOM_COLS} FROM academy.rooms ORDER BY kind ASC, name ASC LIMIT $1"),
                &[&limit],
            )?,
        };
        rows.iter().map(to_room).collect()
    }

    /// `invite`: the host's call; a repeat replaces the expiry.
    pub fn invite(
        &self,
        room_id: &str,
        host_id: &str,
        user_id: &str,
        expires_at: Option<Instant>,
    ) -> Result<(), Refusal> {
        self.enter()?;
        let room = self.room(room_id)?;
        assert_host(&room.host_id, host_id, "room")?;
        let expires = expires_at.map(Instant::iso);
        self.execute(
            "INSERT INTO academy.room_invites (room_id, user_id, invited_by, expires_at)
             VALUES ($1::text::uuid, $2::text::uuid, $3::text::uuid, $4::text::timestamptz)
             ON CONFLICT (room_id, user_id) DO UPDATE SET expires_at = EXCLUDED.expires_at",
            &[&room_id, &user_id, &host_id, &expires],
        )?;
        Ok(())
    }

    /// `pinLesson`: the host's call, a catalogue lesson only; a repeat keeps its first place.
    pub fn pin_lesson(&self, room_id: &str, host_id: &str, item_slug: &str) -> Result<(), Refusal> {
        self.enter()?;
        let room = self.room(room_id)?;
        assert_host(&room.host_id, host_id, "room")?;
        if !spine::has_slug(item_slug) {
            return Err(academy(
                format!("There is no lesson \"{item_slug}\" to pin"),
                "academy.curriculum_not_found",
            ));
        }
        self.execute(
            "INSERT INTO academy.room_pinned_lessons (room_id, item_slug, position, pinned_by)
             SELECT $1::text::uuid, $2,
                    COALESCE((SELECT MAX(position) + 1 FROM academy.room_pinned_lessons WHERE room_id = $3::text::uuid), 0),
                    $4::text::uuid
             ON CONFLICT (room_id, item_slug) DO NOTHING",
            &[&room_id, &item_slug, &room_id, &host_id],
        )?;
        Ok(())
    }

    /// `unpinLesson`: the host's call; unpinning one not pinned changes nothing.
    pub fn unpin_lesson(
        &self,
        room_id: &str,
        host_id: &str,
        item_slug: &str,
    ) -> Result<(), Refusal> {
        self.enter()?;
        let room = self.room(room_id)?;
        assert_host(&room.host_id, host_id, "room")?;
        self.execute(
            "DELETE FROM academy.room_pinned_lessons WHERE room_id = $1::text::uuid AND item_slug = $2",
            &[&room_id, &item_slug],
        )?;
        Ok(())
    }

    /// `pinnedLessons`: in the order pinned, paged by the spine's size; a pin whose lesson left the catalogue is not
    /// shown.
    pub fn pinned_lessons(&self, room_id: &str) -> Result<Vec<&'static spine::Summary>, Refusal> {
        self.enter()?;
        let size = i64::try_from(spine::size()).unwrap_or(i64::MAX);
        let rows = self.query(
            "SELECT item_slug FROM academy.room_pinned_lessons WHERE room_id = $1::text::uuid
              ORDER BY position ASC, pinned_at ASC
              LIMIT $2",
            &[&room_id, &size],
        )?;
        let mut out = Vec::new();
        for row in &rows {
            let slug: String = get(row, "item_slug")?;
            if let Some(item) = spine::summary(&slug) {
                out.push(item);
            }
        }
        Ok(out)
    }

    // ── Sessions ──────────────────────────────────────────────────────────────────────────────────────────────────

    pub fn schedule_session(
        &self,
        room_id: &str,
        host_id: &str,
        title: &str,
        starts_at: Instant,
    ) -> Result<Session, Refusal> {
        self.enter()?;
        let room = self.room(room_id)?;
        assert_host(&room.host_id, host_id, "room")?;
        let rows = self.query(
            &format!(
                "INSERT INTO academy.sessions (room_id, title, host_id, starts_at)
                 VALUES ($1::text::uuid, $2, $3::text::uuid, $4::text::timestamptz)
                 RETURNING {SESSION_COLS}"
            ),
            &[&room_id, &title, &host_id, &starts_at.iso()],
        )?;
        to_session(
            rows.first()
                .ok_or_else(|| broken("Cannot read properties of undefined (reading 'scene')"))?,
        )
    }

    pub fn session(&self, session_id: &str) -> Result<Session, Refusal> {
        self.enter()?;
        let rows = self.query(
            &format!("SELECT {SESSION_COLS} FROM academy.sessions WHERE id = $1::text::uuid"),
            &[&session_id],
        )?;
        match rows.first() {
            Some(row) => to_session(row),
            None => Err(academy(
                format!("Session {session_id} not found"),
                "academy.session_not_found",
            )),
        }
    }

    /// `listSessions({ roomId, limit })`: the limit is checked before the query.
    pub fn list_sessions(
        &self,
        room_id: Option<&str>,
        limit: &Value,
    ) -> Result<Vec<Session>, Refusal> {
        self.enter()?;
        let limit = list_limit(limit, "academy.sessions_list_limit_unset", "Sessions")?;
        let status: Option<&str> = None;
        let rows = self.query(
            &format!(
                "SELECT {SESSION_COLS} FROM academy.sessions
                  WHERE ($1::text::uuid IS NULL OR room_id = $2::text::uuid)
                    AND ($3::text IS NULL OR status::text = $4)
                  ORDER BY starts_at ASC
                  LIMIT $5"
            ),
            &[&room_id, &room_id, &status, &status, &limit],
        )?;
        rows.iter().map(to_session).collect()
    }

    /// `startSession`: the stream room is opened before the conditional update; a call that loses the update did not
    /// start the session, closes the room it opened unless the stored live session keeps that same room, and refuses.
    pub fn start_session(&self, session_id: &str, host_id: &str) -> Result<Session, Refusal> {
        self.enter()?;
        let session = self.session(session_id)?;
        assert_host(&session.host_id, host_id, "session")?;
        if session.status != "scheduled" {
            return Err(academy(
                format!("A {} session cannot be started", session.status),
                "academy.session_not_live",
            ));
        }
        let stream = &self.ports.stream;
        let stream_room = if stream.constructed() {
            Some(stream.open_room(&session.id)?)
        } else {
            None
        };
        // `streamRoom ? this.stream.id : null`: an empty room name is no room.
        let opened = stream_room.as_deref().filter(|r| !r.is_empty());
        let provider = opened.map(|_| stream.id().to_owned());
        let rows = self.query(
            &format!(
                "UPDATE academy.sessions
                    SET status = 'live', stream_provider = $1, stream_room = $2, updated_at = now()
                  WHERE id = $3::text::uuid AND status = 'scheduled'
                 RETURNING {SESSION_COLS}"
            ),
            &[&provider, &stream_room, &session.id],
        )?;
        match rows.first() {
            Some(row) => to_session(row),
            None => {
                let current = self.session(&session.id)?;
                if let Some(room) = opened
                    && (current.status != "live" || current.stream_room.as_deref() != Some(room))
                {
                    stream.close_room(room)?;
                }
                Err(academy(
                    format!("A {} session cannot be started", current.status),
                    "academy.session_not_live",
                ))
            }
        }
    }

    /// `endSession`: the terminal state and every live seat's leaving are written in one transaction before the
    /// provider's room is deleted; a retry re-drives the delete without changing the terminal state.
    pub fn end_session(
        &self,
        session_id: &str,
        host_id: &str,
        now: Instant,
    ) -> Result<Session, Refusal> {
        self.enter()?;
        let session = self.session(session_id)?;
        assert_host(&session.host_id, host_id, "session")?;
        let at = now.iso();
        db::transaction_retrying(self.pool()?, IsolationLevel::Serializable, |tx| {
            let ended = tx
                .query(
                    &format!(
                        "UPDATE academy.sessions SET status = 'ended', ends_at = $1::text::timestamptz, updated_at = now()
                          WHERE id = $2::text::uuid AND status IN ('scheduled', 'live')
                         RETURNING {SESSION_COLS}"
                    ),
                    &[&at, &session.id],
                )
                .map_err(|e| db::refusal(&e))?;
            if let Some(row) = ended.first() {
                to_session(row)?;
                tx.execute(
                    "UPDATE academy.session_attendees SET left_at = $1::text::timestamptz
                      WHERE session_id = $2::text::uuid AND left_at IS NULL",
                    &[&at, &session.id],
                )
                .map_err(|e| db::refusal(&e))?;
            }
            Ok(())
        })?;
        let terminal = self.session(&session.id)?;
        if let Some(room) = terminal.stream_room.as_deref().filter(|r| !r.is_empty()) {
            self.ports.stream.close_room(room)?;
        }
        Ok(terminal)
    }

    /// `occupancy`: live attendees, a `COUNT(*)`.
    pub fn occupancy(&self, session_id: &str) -> Result<i64, Refusal> {
        self.enter()?;
        let rows = self.query(OCCUPANCY, &[&session_id])?;
        count(rows.first())
    }

    /// `join`: the stake and the invitation are read before the lock; under the session row's lock the session is
    /// checked live again, the seats counted and the seat decided, then granted.
    pub fn join(&self, session_id: &str, user_id: &str) -> Result<&'static str, Refusal> {
        self.enter()?;
        let now = self.now;
        let session = self.session(session_id)?;
        if session.status != "live" {
            return Err(academy(
                "That session is not live",
                "academy.session_not_live",
            ));
        }
        let room = self.room(&session.room_id)?;
        let is_host = room.host_id == user_id || session.host_id == user_id;
        let stake = if seat::needs_stake_check(room.access, is_host) {
            self.ports.stake.stake_of(user_id)?
        } else {
            Amount::ZERO
        };
        let invited = if room.access == Access::Invite && !is_host {
            seat::invite_is_live(self.live_invite(&room.id, user_id)?, now)
        } else {
            false
        };
        let role = if is_host { "host" } else { "attendee" };
        let at = now.iso();
        let decision = db::transaction_retrying(
            self.pool()?,
            IsolationLevel::ReadCommitted,
            |tx| {
                let locked = tx
                .query(
                    "SELECT status::text AS status FROM academy.sessions WHERE id = $1::text::uuid FOR UPDATE",
                    &[&session.id],
                )
                .map_err(|e| db::refusal(&e))?;
                let status: Option<String> = match locked.first() {
                    Some(row) => Some(get(row, "status")?),
                    None => None,
                };
                if status.as_deref() != Some("live") {
                    return Err(academy(
                        "That session is not live",
                        "academy.session_not_live",
                    ));
                }
                let counted = tx
                    .query(OCCUPANCY, &[&session.id])
                    .map_err(|e| db::refusal(&e))?;
                let occupancy = count(counted.first())?;
                let seat = seat::decide_seat(
                    RoomTerms {
                        access: room.access,
                        min_stake: room.min_stake,
                        capacity: room.capacity,
                    },
                    SeatRequest {
                        occupancy,
                        stake,
                        invited,
                        is_host,
                    },
                );
                if !seat.allowed() {
                    return Ok(seat);
                }
                tx.execute(
                "INSERT INTO academy.session_attendees (session_id, user_id, role, joined_at)
                 VALUES ($1::text::uuid, $2::text::uuid, $3::text::academy.attendee_role, $4::text::timestamptz)
                 ON CONFLICT (session_id, user_id) DO UPDATE SET left_at = NULL, role = EXCLUDED.role",
                &[&session.id, &user_id, &role, &at],
            )
            .map_err(|e| db::refusal(&e))?;
                if room.access == Access::Invite && !is_host {
                    tx.execute(
                    "UPDATE academy.room_invites SET used_at = COALESCE(used_at, $1::text::timestamptz)
                      WHERE room_id = $2::text::uuid AND user_id = $3::text::uuid",
                    &[&at, &room.id, &user_id],
                )
                .map_err(|e| db::refusal(&e))?;
                }
                Ok(seat)
            },
        )?;
        match decision {
            Seat::Allowed => Ok(role),
            Seat::Refused { code, reason } => Err(academy(reason, code)),
        }
    }

    /// `leave`.
    pub fn leave(&self, session_id: &str, user_id: &str) -> Result<(), Refusal> {
        self.enter()?;
        self.execute(
            "UPDATE academy.session_attendees SET left_at = $1::text::timestamptz
              WHERE session_id = $2::text::uuid AND user_id = $3::text::uuid AND left_at IS NULL",
            &[&self.now.iso(), &session_id, &user_id],
        )?;
        Ok(())
    }

    /// `streamCredential`: only for a live session carrying a stream, only to a caller seated in it.
    pub fn stream_credential(
        &self,
        session_id: &str,
        user_id: &str,
    ) -> Result<StreamCredential, Refusal> {
        self.enter()?;
        let session = self.session(session_id)?;
        let stream_room = match (&session.status[..], &session.stream_room) {
            ("live", Some(room)) if !room.is_empty() => room.clone(),
            _ => {
                return Err(academy(
                    "That session is not carrying a stream",
                    "academy.stream_unavailable",
                ));
            }
        };
        let rows = self.query(
            "SELECT role::text AS role FROM academy.session_attendees
              WHERE session_id = $1::text::uuid AND user_id = $2::text::uuid AND left_at IS NULL",
            &[&session.id, &user_id],
        )?;
        let role: String = match rows.first() {
            Some(row) => get(row, "role")?,
            None => {
                return Err(academy(
                    "Take a seat in the lobby first",
                    "academy.session_not_live",
                ));
            }
        };
        self.ports
            .stream
            .credential(&session.id, &stream_room, user_id, &role)
    }

    /// `updateScene`: the host writes the whole scene, held to the concurrent-edit policy; an unreadable stored scene
    /// counts as the empty one.
    pub fn update_scene(
        &self,
        session_id: &str,
        host_id: &str,
        next: &Value,
        expected: Option<&str>,
    ) -> Result<Session, Refusal> {
        self.enter()?;
        let session = self.session(session_id)?;
        assert_host(&session.host_id, host_id, "session")?;
        let current = scene::readable_or_empty(&session.scene);
        let (written, fingerprint) = match scene::decide_host_scene_write(&current, next, expected)
        {
            Write::Ok { scene, fingerprint } => (scene, fingerprint),
            Write::Conflict { message, .. } => {
                return Err(academy(message, "academy.scene_conflict"));
            }
            Write::PresenceCollision { message } => {
                return Err(academy(message, "academy.scene_presence_collision"));
            }
            Write::Refused { message, .. } => {
                return Err(academy(message, "academy.scene_invalid"));
            }
        };
        let rows = self.query(
            &format!(
                "UPDATE academy.sessions SET scene = $1::text::jsonb, updated_at = now() WHERE id = $2::text::uuid
                 RETURNING {SESSION_COLS}"
            ),
            &[&scene::stringify(&written), &session.id],
        )?;
        let mut stored = to_session(
            rows.first()
                .ok_or_else(|| broken("Cannot read properties of undefined (reading 'scene')"))?,
        )?;
        stored.scene_fingerprint = fingerprint;
        Ok(stored)
    }

    // ── The caller's seats (`AcademyCustomerStore`) ───────────────────────────────────────────────────────────────

    /// `callerLiveSeats`: newest seat first.
    pub fn caller_live_seats(&self, user_id: &str) -> Result<Vec<CallerSeat>, Refusal> {
        self.enter()?;
        let rows = self.query(
            "SELECT a.session_id::text AS session_id, s.room_id::text AS room_id, a.role::text AS role
               FROM academy.session_attendees a
               JOIN academy.sessions s ON s.id = a.session_id
              WHERE a.user_id = $1::text::uuid AND a.left_at IS NULL
              ORDER BY a.joined_at DESC",
            &[&user_id],
        )?;
        rows.iter()
            .map(|r| {
                Ok(CallerSeat {
                    session_id: get(r, "session_id")?,
                    room_id: get(r, "room_id")?,
                    role: get(r, "role")?,
                })
            })
            .collect()
    }

    /// `myUpcomingSessions`: the limit is checked before the query.
    pub fn my_upcoming_sessions(
        &self,
        user_id: &str,
        limit: &Value,
    ) -> Result<Vec<Upcoming>, Refusal> {
        self.enter()?;
        let limit = list_limit(
            limit,
            "academy.my_upcoming_sessions_list_limit_unset",
            "Upcoming sessions",
        )?;
        let rows = self.query(
            "SELECT s.id::text AS id, s.room_id::text AS room_id, s.title, s.host_id::text AS host_id,
                    s.status::text AS status, floor(extract(epoch FROM s.starts_at) * 1000)::int8 AS starts_ms,
                    floor(extract(epoch FROM s.ends_at) * 1000)::int8 AS ends_ms, s.stream_provider,
                    s.scene::text AS scene, a.role::text AS role
               FROM academy.sessions s
               JOIN academy.session_attendees a
                 ON a.session_id = s.id AND a.user_id = $1::text::uuid AND a.left_at IS NULL
              WHERE s.status IN ('scheduled', 'live')
              ORDER BY s.starts_at ASC, s.id ASC
              LIMIT $2",
            &[&user_id, &limit],
        )?;
        rows.iter()
            .map(|r| {
                // `sceneOf`: no row check; a scene that is not an object goes out as `{}`.
                let text: String = get(r, "scene")?;
                let raw = jsonb(&text)?;
                let readable = scene::readable_or_empty(&raw);
                let ends: Option<i64> = get(r, "ends_ms")?;
                Ok(Upcoming {
                    session: Session {
                        id: get(r, "id")?,
                        room_id: get(r, "room_id")?,
                        title: get(r, "title")?,
                        host_id: get(r, "host_id")?,
                        status: get(r, "status")?,
                        starts_at: Instant(get(r, "starts_ms")?),
                        ends_at: ends.map(Instant),
                        stream_provider: get(r, "stream_provider")?,
                        stream_room: None,
                        scene_fingerprint: scene::fingerprint(&readable),
                        scene: match raw {
                            Value::Object(_) | Value::Array(_) => raw,
                            _ => Value::Object(Vec::new()),
                        },
                    },
                    role: get(r, "role")?,
                })
            })
            .collect()
    }

    /// `sessionCalendar`: only for a session the caller is seated in.
    pub fn session_calendar(&self, user_id: &str, session_id: &str) -> Result<String, Refusal> {
        self.enter()?;
        let rows = self.query(
            "SELECT s.id::text AS id, s.title, floor(extract(epoch FROM s.starts_at) * 1000)::int8 AS starts_ms,
                    floor(extract(epoch FROM s.ends_at) * 1000)::int8 AS ends_ms
               FROM academy.sessions s
               JOIN academy.session_attendees a
                 ON a.session_id = s.id AND a.user_id = $1::text::uuid AND a.left_at IS NULL
              WHERE s.id = $2::text::uuid",
            &[&user_id, &session_id],
        )?;
        let Some(row) = rows.first() else {
            return Err(academy("Session not found", "academy.session_not_found"));
        };
        let id: String = get(row, "id")?;
        let title: String = get(row, "title")?;
        let ends: Option<i64> = get(row, "ends_ms")?;
        Ok(calendar::session_calendar_text(
            &id,
            &title,
            Instant(get(row, "starts_ms")?),
            ends.map(Instant),
            self.now,
        ))
    }

    // ── Helpers ───────────────────────────────────────────────────────────────────────────────────────────────────

    fn live_invite(
        &self,
        room_id: &str,
        user_id: &str,
    ) -> Result<Option<Option<Instant>>, Refusal> {
        let rows = self.query(
            "SELECT floor(extract(epoch FROM expires_at) * 1000)::int8 AS expires_ms FROM academy.room_invites
              WHERE room_id = $1::text::uuid AND user_id = $2::text::uuid",
            &[&room_id, &user_id],
        )?;
        match rows.first() {
            None => Ok(None),
            Some(row) => {
                let ms: Option<i64> = get(row, "expires_ms")?;
                Ok(Some(ms.map(Instant)))
            }
        }
    }

    /// `assertMayHost`: asked once, on `createRoom`; an unreadable perk table refuses (the port fails closed).
    fn assert_may_host(&self, user_id: &str) -> Result<(), Refusal> {
        let perks = self.ports.host_rights.perks_of(user_id)?;
        if may_host(&perks) {
            Ok(())
        } else {
            Err(academy(
                "Hosting a lobby is a rank perk — your rank does not carry lobby host rights yet (§4.1)",
                "academy.host_rights_required",
            ))
        }
    }
}

const OCCUPANCY: &str = "SELECT COUNT(*)::text AS count FROM academy.session_attendees \
     WHERE session_id = $1::text::uuid AND left_at IS NULL";

/// `Number(rows[0]?.count ?? '0')`.
fn count(row: Option<&Row>) -> Result<i64, Refusal> {
    let Some(row) = row else { return Ok(0) };
    let text: String = get(row, "count")?;
    text.parse().map_err(|_| broken(format!("count {text}")))
}

/// `assertHost`.
pub fn assert_host(owner_id: &str, caller_id: &str, what: &str) -> Result<(), Refusal> {
    if owner_id == caller_id {
        Ok(())
    } else {
        Err(academy(
            format!("You do not host this {what}"),
            "academy.not_host",
        ))
    }
}
