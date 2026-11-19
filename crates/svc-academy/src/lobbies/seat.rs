//! Who may take a seat (`access/room-access.ts`, §XIII "live session lobbies, capacity tiers"): a pure decision over
//! facts the caller already gathered. The gate is checked before the seat count, so an ineligible caller is told to
//! stake or get an invitation, not that the room is full; the host is always admitted to their own room.

use service_kit::money::Amount;
use service_kit::time::Instant;

/// `RoomAccessKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Free,
    Staked,
    Invite,
}

impl Access {
    pub fn parse(s: &str) -> Option<Access> {
        match s {
            "free" => Some(Access::Free),
            "staked" => Some(Access::Staked),
            "invite" => Some(Access::Invite),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Access::Free => "free",
            Access::Staked => "staked",
            Access::Invite => "invite",
        }
    }
}

/// `RoomTerms`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoomTerms {
    pub access: Access,
    /// Only meaningful for `staked`: a threshold, never a balance.
    pub min_stake: Amount,
    pub capacity: i64,
}

/// `SeatRequest`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeatRequest {
    /// Live attendees: joined and not left.
    pub occupancy: i64,
    /// The caller's stake, from svc-token.
    pub stake: Amount,
    /// The caller holds an invitation that has not expired.
    pub invited: bool,
    /// The room's host, always admitted to their own room.
    pub is_host: bool,
}

/// `SeatDecision`: allowed, or the refusal's code and the sentence the caller reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Seat {
    Allowed,
    Refused {
        code: &'static str,
        reason: &'static str,
    },
}

impl Seat {
    pub fn allowed(self) -> bool {
        matches!(self, Seat::Allowed)
    }
}

/// `decideSeat`.
pub fn decide_seat(room: RoomTerms, request: SeatRequest) -> Seat {
    if request.is_host {
        return Seat::Allowed;
    }
    if room.access == Access::Staked && request.stake < room.min_stake {
        return Seat::Refused {
            code: "academy.stake_required",
            reason: "This lobby is open to stakers. Stake to take a seat.",
        };
    }
    if room.access == Access::Invite && !request.invited {
        return Seat::Refused {
            code: "academy.invite_required",
            reason: "This lobby is invite-only.",
        };
    }
    if request.occupancy >= room.capacity {
        return Seat::Refused {
            code: "academy.room_full",
            reason: "This lobby is full.",
        };
    }
    Seat::Allowed
}

/// `inviteIsLive`: a used invitation still admits its holder; expiry is exclusive.
pub fn invite_is_live(invite: Option<Option<Instant>>, now: Instant) -> bool {
    match invite {
        None => false,
        Some(None) => true,
        Some(Some(expires_at)) => expires_at > now,
    }
}

/// `needsStakeCheck`: only a staked room asks svc-token, and never for its host.
pub fn needs_stake_check(access: Access, is_host: bool) -> bool {
    !is_host && access == Access::Staked
}

// ── The L3 cards (`room-access.ts`): status and export lines over a decision. ───────────────────────────────────────

/// `ROOM_ACCESS_KINDS`.
pub const ROOM_ACCESS_KINDS: [&str; 3] = ["free", "staked", "invite"];

/// `isRoomAccessKind`.
pub fn is_room_access_kind(value: &str) -> bool {
    ROOM_ACCESS_KINDS.contains(&value)
}

/// `seatDecisionBoardCard`: allowed, code, refused.
pub fn board_card(decision: Seat) -> (bool, Option<&'static str>, bool) {
    match decision {
        Seat::Allowed => (true, None, false),
        Seat::Refused { code, .. } => (false, Some(code), true),
    }
}

fn bit(b: bool) -> &'static str {
    if b { "1" } else { "0" }
}

/// `seatDecisionStatusLine`.
pub fn status_line(decision: Seat) -> String {
    let (allowed, code, refused) = board_card(decision);
    format!(
        "allowed={} code={} refused={}",
        bit(allowed),
        code.unwrap_or("-"),
        bit(refused)
    )
}

/// `parseSeatDecisionStatusLine`: `^allowed=([01]) code=(\S+) refused=([01])$` after a trim.
pub fn parse_status_line(line: &str) -> Option<(bool, Option<String>, bool)> {
    let rest = service_kit::schema::js_trim(line).strip_prefix("allowed=")?;
    let (a, rest) = rest.split_once(" code=")?;
    let (code, r) = rest.rsplit_once(" refused=")?;
    let flag = |s: &str| match s {
        "1" => Some(true),
        "0" => Some(false),
        _ => None,
    };
    if code.is_empty() || code.chars().any(char::is_whitespace) {
        return None;
    }
    Some((flag(a)?, (code != "-").then(|| code.to_owned()), flag(r)?))
}

/// `seatDecisionStatusLineMatches`.
pub fn status_line_matches(decision: Seat) -> bool {
    let (allowed, code, refused) = board_card(decision);
    parse_status_line(&status_line(decision))
        .is_some_and(|(a, c, r)| a == allowed && c.as_deref() == code && r == refused)
}

/// `seatDecisionStatusLineConsistent`.
pub fn status_line_consistent(line: &str) -> bool {
    match parse_status_line(line) {
        None => false,
        Some((true, code, refused)) => code.is_none() && !refused,
        Some((false, code, refused)) => code.is_some() && refused,
    }
}

/// `seatDecisionExportHeader`.
pub fn export_header() -> &'static str {
    "allowed,code,refused"
}

/// `seatDecisionExportLine`.
pub fn export_line(decision: Seat) -> String {
    let (allowed, code, refused) = board_card(decision);
    format!("{},{},{}", bit(allowed), code.unwrap_or(""), bit(refused))
}

/// `seatDecisionExportText`.
pub fn export_text(decision: Seat) -> String {
    format!("{}\n{}", export_header(), export_line(decision))
}
