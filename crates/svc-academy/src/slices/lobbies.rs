//! The lobbies slice: the calls the door table gives `Slice::Lobbies` (rooms, sessions, seats, invitations, pinned
//! lessons, the scene and the stream credential), answered as `router.ts` answers them: the same service calls in
//! the same order, and each answer in its output schema's key order (`roomOut`, `sessionOut`, `curriculumSummaryOut`).

use service_kit::json::Json;
use service_kit::money::{format_amount, parse_amount};
use service_kit::schema::Value;
use service_kit::time::Instant;

use crate::door::Ctx;
use crate::errors::Refusal;
use crate::lobbies::seat::Access;
use crate::lobbies::store::{CallerSeat, Lobbies, NewRoom, Room, Session};
use crate::slices::{Answer, not_ported};

fn lobbies<'a>(ctx: &'a Ctx<'_>) -> Lobbies<'a> {
    Lobbies {
        store: ctx.store,
        ports: ctx.ports,
        max_room_capacity: ctx.settings.0.get("ACADEMY_MAX_ROOM_CAPACITY"),
        now: ctx.now,
    }
}

fn text<'v>(input: &'v Value, key: &str) -> &'v str {
    input.get(key).as_str().unwrap_or("")
}

/// `seatFor(seats, id, kind)`: the caller's role there, or none.
fn seat_for<'s>(seats: &'s [CallerSeat], id: &str, room: bool) -> Option<&'s str> {
    seats
        .iter()
        .find(|s| {
            if room {
                s.room_id == id
            } else {
                s.session_id == id
            }
        })
        .map(|s| s.role.as_str())
}

fn role_json(role: Option<&str>) -> (Json, Json) {
    (
        Json::Bool(role.is_some()),
        role.map_or(Json::Null, Json::str),
    )
}

/// `serialiseRoom` through `roomOut`.
pub fn room_json(room: &Room, role: Option<&str>) -> Json {
    let (seated, role) = role_json(role);
    Json::obj([
        ("id", Json::str(room.id.clone())),
        ("slug", Json::str(room.slug.clone())),
        ("name", Json::str(room.name.clone())),
        ("kind", Json::str(room.kind.clone())),
        ("access", Json::str(room.access.name())),
        ("minStake", Json::str(format_amount(room.min_stake))),
        ("capacity", Json::int(room.capacity)),
        ("hostId", Json::str(room.host_id.clone())),
        ("seated", seated),
        ("role", role),
    ])
}

/// `serialiseSession` through `sessionOut`.
pub fn session_json(session: &Session, role: Option<&str>) -> Json {
    let (seated, role) = role_json(role);
    Json::obj([
        ("id", Json::str(session.id.clone())),
        ("roomId", Json::str(session.room_id.clone())),
        ("title", Json::str(session.title.clone())),
        ("hostId", Json::str(session.host_id.clone())),
        ("status", Json::str(session.status.clone())),
        ("startsAt", Json::str(session.starts_at.iso())),
        (
            "endsAt",
            session.ends_at.map_or(Json::Null, |t| Json::str(t.iso())),
        ),
        (
            "streamProvider",
            session
                .stream_provider
                .clone()
                .map_or(Json::Null, Json::str),
        ),
        ("scene", session.scene.to_json().unwrap_or(Json::Null)),
        (
            "sceneFingerprint",
            Json::str(session.scene_fingerprint.clone()),
        ),
        ("seated", seated),
        ("role", role),
    ])
}

fn date(v: &Value) -> Option<Instant> {
    match v {
        Value::Date(Some(ms)) => Some(Instant(*ms)),
        _ => None,
    }
}

/// A session answer with the caller's seat in it, as `scheduleSession`, `startSession`, `endSession` and
/// `updateScene` read the seats after the write.
fn with_seat(l: &Lobbies<'_>, user: &str, session: &Session) -> Answer {
    let seats = l.caller_live_seats(user)?;
    Ok(Some(session_json(
        session,
        seat_for(&seats, &session.id, false),
    )))
}

pub fn handle(ctx: &Ctx<'_>) -> Answer {
    let l = lobbies(ctx);
    let input = &ctx.input;
    let user = ctx.user_id();
    match ctx.call.path {
        "rooms" => {
            let kind = input.get("kind");
            let kind = kind.truthy().then(|| kind.as_str()).flatten();
            let rooms = l.list_rooms(kind, input.get("limit"))?;
            let seats = l.caller_live_seats(user)?;
            Ok(Some(Json::Array(
                rooms
                    .iter()
                    .map(|r| room_json(r, seat_for(&seats, &r.id, true)))
                    .collect(),
            )))
        }
        "room" => {
            let room_id = text(input, "roomId");
            let seats = l.caller_live_seats(user)?;
            let room = l.room(room_id)?;
            let room = room_json(&room, seat_for(&seats, room_id, true));
            let sessions = l.list_sessions(Some(room_id), input.get("limit"))?;
            let sessions = sessions
                .iter()
                .map(|s| session_json(s, seat_for(&seats, &s.id, false)))
                .collect();
            let pinned = l.pinned_lessons(room_id)?;
            Ok(Some(Json::obj([
                ("room", room),
                ("sessions", Json::Array(sessions)),
                (
                    "pinnedLessons",
                    Json::Array(pinned.iter().map(|p| p.json()).collect()),
                ),
            ])))
        }
        "session" => {
            let session_id = text(input, "sessionId");
            let seats = l.caller_live_seats(user)?;
            let session = l.session(session_id)?;
            let session = session_json(&session, seat_for(&seats, session_id, false));
            let occupancy = l.occupancy(session_id)?;
            Ok(Some(Json::obj([
                ("session", session),
                ("occupancy", Json::int(occupancy)),
            ])))
        }
        "join" => {
            let role = l.join(text(input, "sessionId"), user)?;
            Ok(Some(Json::obj([("role", Json::str(role))])))
        }
        "leave" => {
            l.leave(text(input, "sessionId"), user)?;
            Ok(Some(Json::obj([("ok", Json::Bool(true))])))
        }
        "streamCredential" => {
            let c = l.stream_credential(text(input, "sessionId"), user)?;
            Ok(Some(Json::obj([
                ("url", Json::str(c.url)),
                ("token", Json::str(c.token)),
                ("expiresAt", Json::str(c.expires_at.iso())),
            ])))
        }
        "createRoom" => {
            // `parseAmount(minStake)` runs inside the guard, before the service is asked.
            let min_stake = match input.get("minStake") {
                v if v.truthy() => {
                    Some(parse_amount(v.as_str().unwrap_or("")).map_err(|message| {
                        Refusal::Internal {
                            message,
                            code: None,
                        }
                    })?)
                }
                _ => None,
            };
            let room = l.create_room(&NewRoom {
                host_id: user.to_owned(),
                slug: text(input, "slug").to_owned(),
                name: text(input, "name").to_owned(),
                kind: text(input, "kind").to_owned(),
                access: Access::parse(text(input, "access")).unwrap_or(Access::Free),
                min_stake,
                capacity: input.get("capacity").as_number().unwrap_or(0.0),
            })?;
            Ok(Some(room_json(&room, None)))
        }
        "invite" => {
            l.invite(
                text(input, "roomId"),
                user,
                text(input, "userId"),
                date(input.get("expiresAt")),
            )?;
            Ok(Some(Json::obj([("ok", Json::Bool(true))])))
        }
        "pinLesson" => {
            l.pin_lesson(text(input, "roomId"), user, text(input, "itemSlug"))?;
            Ok(Some(Json::obj([("ok", Json::Bool(true))])))
        }
        "unpinLesson" => {
            l.unpin_lesson(text(input, "roomId"), user, text(input, "itemSlug"))?;
            Ok(Some(Json::obj([("ok", Json::Bool(true))])))
        }
        "scheduleSession" => {
            let starts_at = date(input.get("startsAt")).unwrap_or(Instant(0));
            let session =
                l.schedule_session(text(input, "roomId"), user, text(input, "title"), starts_at)?;
            with_seat(&l, user, &session)
        }
        "startSession" => {
            let session = l.start_session(text(input, "sessionId"), user)?;
            with_seat(&l, user, &session)
        }
        "endSession" => {
            let session = l.end_session(text(input, "sessionId"), user, ctx.now)?;
            with_seat(&l, user, &session)
        }
        "updateScene" => {
            let expected = input.get("expectedFingerprint").as_str();
            let session =
                l.update_scene(text(input, "sessionId"), user, input.get("scene"), expected)?;
            with_seat(&l, user, &session)
        }
        "myUpcomingSessions" => {
            let rows = l.my_upcoming_sessions(user, input.get("limit"))?;
            Ok(Some(Json::Array(
                rows.iter()
                    .map(|u| session_json(&u.session, Some(&u.role)))
                    .collect(),
            )))
        }
        "sessionCalendar" => {
            let calendar = l.session_calendar(user, text(input, "sessionId"))?;
            Ok(Some(Json::obj([("calendar", Json::str(calendar))])))
        }
        _ => not_ported(ctx),
    }
}
