//! Shared pots (`spaces/shared-pots.ts`, `SharedPotService`): the owner of a named pot invites another person, by
//! handle or email, to see it (`viewer`) or add money to it (`contributor`), for the owner-set invite lifetime and up
//! to the owner-set number of people (blank refuses `bank.joint_unset`). Membership decides who may read the pot and
//! who may call a move; it is never a balance. The owner may link one of their cards to the pot so its holders can
//! freeze it; every change is a line in the pot's log.

use std::collections::BTreeMap;

use postgres::{GenericClient, Row, Transaction};
use service_kit::json::Json;
use service_kit::time::Instant;

use super::ports::{DirError, Directory, Lookup, Lookups};
use super::space::{self, Space, archived, get, in_tx, not_found, own_pot_for_update, pg, with};
use crate::db::Store;
use crate::errors::Refusal;
use crate::partner::refuse;

/// The bank's two values: minutes an invite stays open, people one pot may be shared with.
#[derive(Debug, Clone, Default)]
pub struct Terms {
    /// `BANK_SHARED_POT_INVITE_MINUTES`.
    pub invite_minutes: Option<String>,
    /// `BANK_SHARED_POT_PEOPLE_CAP`.
    pub people_cap: Option<String>,
    /// This deployment's card programme (`cardProgrammeOutput` of its issuer): id and whether it is simulated.
    pub card_programme: (String, bool),
}

fn whole(raw: Option<&str>, digits: usize, max: i64) -> Option<i64> {
    let t = raw.map(service_kit::money::js_trim).unwrap_or_default();
    if t.is_empty()
        || t.len() > digits
        || t.starts_with('0')
        || !t.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    t.parse::<i64>().ok().filter(|n| *n <= max)
}

impl Terms {
    /// `parseInviteMinutes`: 1 to 43200.
    pub fn invite_minutes(&self) -> Option<i64> {
        whole(self.invite_minutes.as_deref(), 5, 43_200)
    }

    /// `parsePeopleCap`: 1 to 50.
    pub fn people_cap(&self) -> Option<i64> {
        whole(self.people_cap.as_deref(), 2, 50)
    }

    fn required(&self) -> Result<(i64, i64), Refusal> {
        match (self.invite_minutes(), self.people_cap()) {
            (Some(m), Some(c)) => Ok((m, c)),
            _ => Err(refuse(
                "bank.joint_unset",
                "The bank has not decided how long an invite lasts or how many people can share a pot, so pots are not shared",
            )),
        }
    }
}

/// The ports shared pots read through.
pub struct Ports<'a> {
    pub directory: &'a dyn Directory,
    pub lookups: &'a Lookups,
    pub terms: &'a Terms,
}

/// The log's actor for a change the bank's operator made.
pub const BANK_ACTOR: &str = "bank";

const INVITE_COLS: &str = "id::text, space_id::text, inviter_user_id, invitee_user_id, role, \
     floor(extract(epoch from created_at) * 1000)::int8, floor(extract(epoch from expires_at) * 1000)::int8, \
     accepted_at IS NOT NULL, declined_at IS NOT NULL, cancelled_at IS NOT NULL, expires_at <= now()";

/// One invite row.
#[derive(Debug, Clone)]
pub struct Invite {
    pub id: String,
    pub space_id: String,
    pub inviter: String,
    pub invitee: String,
    pub role: String,
    pub created_at: Instant,
    pub expires_at: Instant,
    pub accepted: bool,
    pub declined: bool,
    pub cancelled: bool,
    pub expired: bool,
}

impl Invite {
    fn from_row(r: &Row) -> Invite {
        Invite {
            id: r.get(0),
            space_id: r.get(1),
            inviter: r.get(2),
            invitee: r.get(3),
            role: r.get(4),
            created_at: Instant(r.get(5)),
            expires_at: Instant(r.get(6)),
            accepted: r.get(7),
            declined: r.get(8),
            cancelled: r.get(9),
            expired: r.get(10),
        }
    }

    /// `inviteOut`, in the output schema's order.
    pub fn fields(&self) -> Vec<(String, Json)> {
        vec![
            ("inviteId".to_owned(), Json::str(self.id.clone())),
            ("spaceId".to_owned(), Json::str(self.space_id.clone())),
            ("role".to_owned(), Json::str(self.role.clone())),
            ("createdAt".to_owned(), Json::str(self.created_at.iso())),
            ("expiresAt".to_owned(), Json::str(self.expires_at.iso())),
            ("expired".to_owned(), Json::Bool(self.expired)),
        ]
    }
}

/// `personOut`.
pub fn person(id: &str, names: &BTreeMap<String, String>) -> Json {
    Json::obj([
        ("userId", Json::str(id)),
        ("handle", names.get(id).map_or(Json::Null, Json::str)),
    ])
}

fn directory_error(e: DirError) -> Refusal {
    match e {
        DirError::Unset => refuse(
            "bank.business_directory_unset",
            "svc-bank cannot read handles, so shared pots cannot name anyone",
        ),
        DirError::Unavailable => refuse(
            "bank.business_directory_unavailable",
            "svc-identity did not answer for handles; try again",
        ),
    }
}

/// `names`: handles for these ids, once each.
fn names(ports: &Ports<'_>, ids: &[String]) -> Result<BTreeMap<String, String>, Refusal> {
    let mut unique: Vec<String> = Vec::new();
    for id in ids {
        if !unique.contains(id) {
            unique.push(id.clone());
        }
    }
    if unique.is_empty() {
        return Ok(BTreeMap::new());
    }
    ports.directory.handles_of(&unique).map_err(directory_error)
}

fn invite_by_id(c: &mut impl GenericClient, id: &str) -> Result<Option<Invite>, Refusal> {
    let rows = c
        .query(
            &format!("SELECT {INVITE_COLS} FROM bank.shared_pot_invites WHERE id = $1::text::uuid"),
            &[&id],
        )
        .map_err(|e| pg(&e))?;
    Ok(rows.first().map(Invite::from_row))
}

/// `roleOf`: the caller's role in a pot, or none.
pub fn role_of(
    c: &mut impl GenericClient,
    space_id: &str,
    user_id: &str,
) -> Result<Option<String>, Refusal> {
    let rows = c
        .query(
            "SELECT role FROM bank.shared_pot_members WHERE space_id = $1::text::uuid AND user_id = $2",
            &[&space_id, &user_id],
        )
        .map_err(|e| pg(&e))?;
    Ok(rows.first().map(|r| r.get(0)))
}

fn invalid(message: &str) -> Refusal {
    refuse("bank.shared_pot_invalid", message)
}

fn log(
    tx: &mut Transaction<'_>,
    space_id: &str,
    actor: &str,
    subject: Option<&str>,
    kind: &str,
    role: Option<&str>,
    card: Option<&str>,
) -> Result<(), Refusal> {
    tx.execute(
        "INSERT INTO bank.shared_pot_activity (space_id, actor_user_id, subject_user_id, kind, role, card_id) \
         VALUES ($1::text::uuid, $2, $3, $4, $5, $6::text::uuid)",
        &[&space_id, &actor, &subject, &kind, &role, &card],
    )
    .map_err(|e| pg(&e))?;
    Ok(())
}

/// `normaliseHandleQuery`: one handle, a leading @ dropped, 3 to 32 of `[a-zA-Z0-9_]`.
fn handle_query(raw: &str) -> Option<String> {
    let t = service_kit::money::js_trim(raw);
    let bare = t.strip_prefix('@').unwrap_or(t);
    ((3..=32).contains(&bare.len()) && bare.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
        .then(|| bare.to_owned())
}

/// `normaliseEmailQuery`: `^[^\s@]+@[^\s@]+\.[^\s@]+$`, at most 320 units.
fn email_query(raw: &str) -> Option<String> {
    let t = service_kit::money::js_trim(raw);
    if t.encode_utf16().count() > 320 {
        return None;
    }
    let plain = |s: &str| {
        !s.is_empty()
            && !s
                .chars()
                .any(|c| c == '@' || service_kit::money::is_js_whitespace(c))
    };
    let (local, domain) = t.split_once('@')?;
    if !plain(local) {
        return None;
    }
    // The regex backtracks: some dot in the domain has a plain part before and after it.
    let ok = domain
        .char_indices()
        .any(|(i, c)| c == '.' && plain(&domain[..i]) && plain(&domain[i + 1..]));
    ok.then(|| t.to_owned())
}

/// What an invite is asked with.
pub struct InviteAsk<'a> {
    pub invite_id: &'a str,
    pub owner: &'a str,
    pub space_id: &'a str,
    pub handle: &'a str,
    pub email: &'a str,
    pub role: &'a str,
}

fn replay_invite(ports: &Ports<'_>, row: &Invite, ask: &InviteAsk<'_>) -> Result<Json, Refusal> {
    if row.inviter != ask.owner || row.space_id != ask.space_id || row.role != ask.role {
        return Err(invalid("This invite id was used for a different invite"));
    }
    let names = names(ports, std::slice::from_ref(&row.invitee))?;
    let mut f = row.fields();
    f.push(("invitee".to_owned(), person(&row.invitee, &names)));
    Ok(Json::Object(f))
}

/// `invite`: one active person, by handle or email, to one of the owner's live named pots; the same id again replays.
pub fn invite(
    pool: &Store,
    ports: &Ports<'_>,
    ask: &InviteAsk<'_>,
    now: Instant,
) -> Result<Json, Refusal> {
    let (minutes, cap) = ports.terms.required()?;
    if let Some(row) = with(pool, |c| invite_by_id(c, ask.invite_id))? {
        return replay_invite(ports, &row, ask);
    }
    in_tx(pool, |tx| {
        own_pot_for_update(tx, ask.space_id, ask.owner).map(|_| ())
    })?;
    // `findInvitee`.
    if service_kit::money::js_trim(ask.handle).is_empty()
        == service_kit::money::js_trim(ask.email).is_empty()
    {
        return Err(invalid("Name the person by handle or by email, not both"));
    }
    if !ports.lookups.try_take(ask.owner, now.0) {
        return Err(refuse(
            "bank.business_directory_rate_limited",
            "Too many lookups. Try again in a minute",
        ));
    }
    let missing = || {
        refuse(
            "bank.invitee_not_found",
            "No active account has this handle or email",
        )
    };
    let query = if service_kit::money::js_trim(ask.handle).is_empty() {
        email_query(ask.email).map(Lookup::Email)
    } else {
        handle_query(ask.handle).map(Lookup::Handle)
    };
    let Some(query) = query else {
        return Err(missing());
    };
    let Some((invitee, handle)) = ports
        .directory
        .find_active(&query)
        .map_err(directory_error)?
    else {
        return Err(missing());
    };
    if invitee == ask.owner {
        return Err(invalid("You own this pot; invite someone else"));
    }
    let created = in_tx(pool, |tx| {
        own_pot_for_update(tx, ask.space_id, ask.owner)?;
        let rows = tx
            .query(
                &format!(
                    "INSERT INTO bank.shared_pot_invites (id, space_id, inviter_user_id, invitee_user_id, role, expires_at) \
                     SELECT $1::text::uuid, $2::text::uuid, $3, $4, $5, now() + make_interval(mins => $6::int) \
                     ON CONFLICT (id) DO NOTHING RETURNING {}",
                    INVITE_COLS.replace("expires_at <= now()", "false")
                ),
                &[&ask.invite_id, &ask.space_id, &ask.owner, &invitee, &ask.role, &i32::try_from(minutes).unwrap_or(0)],
            )
            .map_err(|e| pg(&e))?;
        let Some(row) = rows.first().map(Invite::from_row) else {
            return Ok(None);
        };
        let taken = tx
            .query_one(
                "SELECT EXISTS (SELECT 1 FROM bank.shared_pot_members WHERE space_id = $1::text::uuid AND user_id = $2), \
                 EXISTS (SELECT 1 FROM bank.shared_pot_invites WHERE space_id = $1::text::uuid AND invitee_user_id = $2 \
                   AND id <> $3::text::uuid AND accepted_at IS NULL AND declined_at IS NULL AND cancelled_at IS NULL AND expires_at > now()), \
                 ((SELECT count(*) FROM bank.shared_pot_members WHERE space_id = $1::text::uuid) \
                   + (SELECT count(*) FROM bank.shared_pot_invites WHERE space_id = $1::text::uuid AND accepted_at IS NULL \
                      AND declined_at IS NULL AND cancelled_at IS NULL AND expires_at > now()))::int",
                &[&ask.space_id, &invitee, &ask.invite_id],
            )
            .map_err(|e| pg(&e))?;
        if taken.get::<_, bool>(0) {
            return Err(invalid("This person already shares this pot"));
        }
        if taken.get::<_, bool>(1) {
            return Err(invalid(
                "This person already has an open invite to this pot",
            ));
        }
        if i64::from(taken.get::<_, i32>(2)) > cap {
            return Err(refuse(
                "bank.shared_pot_full",
                format!(
                    "This pot is shared with as many people as the bank allows ({cap}), open invites included"
                ),
            ));
        }
        log(
            tx,
            ask.space_id,
            ask.owner,
            Some(&invitee),
            "invited",
            Some(ask.role),
            None,
        )?;
        Ok(Some(row))
    })?;
    let Some(row) = created else {
        let row = with(pool, |c| invite_by_id(c, ask.invite_id))?
            .ok_or_else(|| Refusal::Other("the invite that won the insert is gone".to_owned()))?;
        return replay_invite(ports, &row, ask);
    };
    let mut f = row.fields();
    f.push((
        "invitee".to_owned(),
        Json::obj([
            ("userId", Json::str(invitee)),
            ("handle", Json::str(handle)),
        ]),
    ));
    Ok(Json::Object(f))
}

fn own_invite_for_update(
    tx: &mut Transaction<'_>,
    invite_id: &str,
    user_id: &str,
) -> Result<Invite, Refusal> {
    let rows = tx
        .query(
            &format!(
                "SELECT {INVITE_COLS} FROM bank.shared_pot_invites WHERE id = $1::text::uuid AND invitee_user_id = $2 FOR UPDATE"
            ),
            &[&invite_id, &user_id],
        )
        .map_err(|e| pg(&e))?;
    rows.first()
        .map(Invite::from_row)
        .ok_or_else(|| refuse("bank.invite_not_found", "No invite of yours has this id"))
}

/// `accept`: the invitee joins with the invite's role; accepting again returns the same membership.
pub fn accept(
    pool: &Store,
    terms: &Terms,
    invite_id: &str,
    user_id: &str,
) -> Result<Json, Refusal> {
    let (_, cap) = terms.required()?;
    in_tx(pool, |tx| {
        let invite = own_invite_for_update(tx, invite_id, user_id)?;
        let answer = || {
            Json::obj([
                ("spaceId", Json::str(invite.space_id.clone())),
                ("role", Json::str(invite.role.clone())),
            ])
        };
        if invite.accepted {
            if role_of(tx, &invite.space_id, user_id)?.is_some() {
                return Ok(answer());
            }
            return Err(refuse(
                "bank.invite_not_found",
                "This invite was used, and you no longer share this pot. Ask the owner for a new invite",
            ));
        }
        if invite.declined {
            return Err(refuse("bank.invite_not_found", "You declined this invite"));
        }
        if invite.cancelled {
            return Err(refuse(
                "bank.invite_not_found",
                "The owner cancelled this invite",
            ));
        }
        tx.execute(
            "SELECT id FROM bank.spaces WHERE id = $1::text::uuid FOR UPDATE",
            &[&invite.space_id],
        )
        .map_err(|e| pg(&e))?;
        let pot = get(tx, &invite.space_id)?;
        if pot.archived_at.is_some() {
            return Err(archived(&pot.name));
        }
        if invite.expired {
            return Err(refuse(
                "bank.invite_expired",
                format!(
                    "This invite ended at {}. Ask the pot's owner for a new one",
                    invite.expires_at.iso()
                ),
            ));
        }
        let people: i32 = tx
            .query_one(
                "SELECT count(*)::int FROM bank.shared_pot_members WHERE space_id = $1::text::uuid",
                &[&invite.space_id],
            )
            .map_err(|e| pg(&e))?
            .get(0);
        if i64::from(people) >= cap {
            return Err(refuse(
                "bank.shared_pot_full",
                format!("This pot is shared with as many people as the bank allows ({cap})"),
            ));
        }
        tx.execute(
            "UPDATE bank.shared_pot_invites SET accepted_at = now() WHERE id = $1::text::uuid",
            &[&invite_id],
        )
        .map_err(|e| pg(&e))?;
        tx.execute(
            "INSERT INTO bank.shared_pot_members (space_id, user_id, role, invite_id) VALUES ($1::text::uuid, $2, $3, $4::text::uuid)",
            &[&invite.space_id, &user_id, &invite.role, &invite_id],
        )
        .map_err(|e| pg(&e))?;
        log(
            tx,
            &invite.space_id,
            user_id,
            None,
            "joined",
            Some(&invite.role),
            None,
        )?;
        Ok(answer())
    })
}

/// `decline`: the invitee says no; declining again changes nothing.
pub fn decline(pool: &Store, invite_id: &str, user_id: &str) -> Result<Json, Refusal> {
    in_tx(pool, |tx| {
        let invite = own_invite_for_update(tx, invite_id, user_id)?;
        let done = Json::obj([("declined", Json::Bool(true))]);
        if invite.declined {
            return Ok(done);
        }
        if invite.accepted {
            return Err(invalid("You accepted this invite; leave the pot instead"));
        }
        if invite.cancelled {
            return Err(refuse(
                "bank.invite_not_found",
                "The owner cancelled this invite",
            ));
        }
        tx.execute(
            "UPDATE bank.shared_pot_invites SET declined_at = now() WHERE id = $1::text::uuid",
            &[&invite_id],
        )
        .map_err(|e| pg(&e))?;
        log(
            tx,
            &invite.space_id,
            user_id,
            None,
            "declined",
            Some(&invite.role),
            None,
        )?;
        Ok(done)
    })
}

/// `cancelInvite`: the owner withdraws an invite not yet answered; cancelling again changes nothing.
pub fn cancel_invite(pool: &Store, invite_id: &str, owner: &str) -> Result<Json, Refusal> {
    in_tx(pool, |tx| {
        let Some(row) = invite_by_id(tx, invite_id)? else {
            return Err(refuse("bank.invite_not_found", "No invite has this id"));
        };
        own_pot_for_update(tx, &row.space_id, owner)?;
        let rows = tx
            .query(
                &format!("SELECT {INVITE_COLS} FROM bank.shared_pot_invites WHERE id = $1::text::uuid FOR UPDATE"),
                &[&invite_id],
            )
            .map_err(|e| pg(&e))?;
        let invite = rows
            .first()
            .map(Invite::from_row)
            .ok_or_else(|| Refusal::Other("the invite is gone".to_owned()))?;
        let done = Json::obj([("cancelled", Json::Bool(true))]);
        if invite.cancelled {
            return Ok(done);
        }
        if invite.accepted || invite.declined {
            return Err(invalid("This invite was already answered"));
        }
        tx.execute(
            "UPDATE bank.shared_pot_invites SET cancelled_at = now() WHERE id = $1::text::uuid",
            &[&invite_id],
        )
        .map_err(|e| pg(&e))?;
        log(
            tx,
            &row.space_id,
            owner,
            Some(&row.invitee),
            "cancelled",
            Some(&row.role),
            None,
        )?;
        Ok(done)
    })
}

/// `leave`: a member stops sharing the pot; not a member changes nothing.
pub fn leave(pool: &Store, space_id: &str, user_id: &str) -> Result<Json, Refusal> {
    in_tx(pool, |tx| {
        tx.execute(
            "SELECT id FROM bank.spaces WHERE id = $1::text::uuid FOR UPDATE",
            &[&space_id],
        )
        .map_err(|e| pg(&e))?;
        let gone = tx
            .query(
                "DELETE FROM bank.shared_pot_members WHERE space_id = $1::text::uuid AND user_id = $2 RETURNING role",
                &[&space_id, &user_id],
            )
            .map_err(|e| pg(&e))?;
        if let Some(r) = gone.first() {
            let role: String = r.get(0);
            log(tx, space_id, user_id, None, "left", Some(&role), None)?;
        }
        Ok(Json::obj([("left", Json::Bool(true))]))
    })
}

/// `remove`: the owner stops sharing the pot with one member; not a member changes nothing.
pub fn remove(pool: &Store, space_id: &str, owner: &str, member: &str) -> Result<Json, Refusal> {
    in_tx(pool, |tx| {
        own_pot_for_update(tx, space_id, owner)?;
        let gone = tx
            .query(
                "DELETE FROM bank.shared_pot_members WHERE space_id = $1::text::uuid AND user_id = $2 RETURNING role",
                &[&space_id, &member],
            )
            .map_err(|e| pg(&e))?;
        if let Some(r) = gone.first() {
            let role: String = r.get(0);
            log(
                tx,
                space_id,
                owner,
                Some(member),
                "removed",
                Some(&role),
                None,
            )?;
        }
        Ok(Json::obj([("removed", Json::Bool(true))]))
    })
}

/// A card as a pot's people see it (`cardOut`).
fn card_json(card_id: &str, pan_tail: &str, status: &str, frozen_by: Option<&str>) -> Json {
    let by = frozen_by.filter(|b| matches!(*b, "owner" | "holder" | "operator"));
    Json::obj([
        ("cardId", Json::str(card_id)),
        ("panTail", Json::str(pan_tail)),
        ("status", Json::str(status)),
        ("frozenBy", by.map_or(Json::Null, Json::str)),
    ])
}

fn assert_programme(terms: &Terms, issuer: &str, simulated: bool) -> Result<(), Refusal> {
    let (id, sim) = &terms.card_programme;
    if issuer != id || simulated != *sim {
        return Err(refuse(
            "bank.card_not_active",
            "This card belongs to another card programme, so it cannot be used from a pot",
        ));
    }
    Ok(())
}

fn taken(this_pot: bool) -> Refusal {
    invalid(if this_pot {
        "This pot already has a linked card; unlink it first"
    } else {
        "This card is linked to another pot"
    })
}

/// `linkCard`: the owner links one of their own cards, not closed, to one of their live pots. Moves no money.
pub fn link_card(
    pool: &Store,
    terms: &Terms,
    space_id: &str,
    owner: &str,
    card_id: &str,
) -> Result<Json, Refusal> {
    in_tx(pool, |tx| {
        own_pot_for_update(tx, space_id, owner)?;
        let rows = tx
            .query(
                "SELECT user_id, pan_tail, status::text, frozen_by, issuer, simulated FROM bank.cards WHERE id = $1::text::uuid",
                &[&card_id],
            )
            .map_err(|e| pg(&e))?;
        let Some(card) = rows.first() else {
            return Err(refuse(
                "bank.card_not_found",
                format!("Card {card_id} not found"),
            ));
        };
        if card.get::<_, String>(0) != owner {
            return Err(refuse(
                "bank.card_not_found",
                format!("Card {card_id} not found"),
            ));
        }
        let status: String = card.get(2);
        if status == "closed" {
            return Err(refuse(
                "bank.card_not_active",
                "A closed card cannot be linked",
            ));
        }
        assert_programme(terms, &card.get::<_, String>(4), card.get(5))?;
        let linked = card_json(
            card_id,
            &card.get::<_, String>(1),
            &status,
            card.get::<_, Option<String>>(3).as_deref(),
        );
        let held = tx
            .query(
                "SELECT space_id::text, card_id::text FROM bank.shared_pot_cards WHERE space_id = $1::text::uuid OR card_id = $2::text::uuid",
                &[&space_id, &card_id],
            )
            .map_err(|e| pg(&e))?;
        if let Some(h) = held.first() {
            let (s, c): (String, String) = (h.get(0), h.get(1));
            if s == space_id && c == card_id {
                return Ok(linked);
            }
            return Err(taken(s == space_id));
        }
        // The same card linked to two pots at once: the second meets the one-pot-per-card rule in the database.
        match tx.execute(
            "INSERT INTO bank.shared_pot_cards (space_id, card_id) VALUES ($1::text::uuid, $2::text::uuid)",
            &[&space_id, &card_id],
        ) {
            Ok(_) => {}
            Err(e) if e.code().is_some_and(|c| c.code() == "23505") => return Err(taken(false)),
            Err(e) => return Err(pg(&e)),
        }
        log(
            tx,
            space_id,
            owner,
            None,
            "card_linked",
            None,
            Some(card_id),
        )?;
        Ok(linked)
    })
}

/// `unlinkCard`: the owner unlinks the pot's card; none linked changes nothing.
pub fn unlink_card(pool: &Store, space_id: &str, owner: &str) -> Result<Json, Refusal> {
    in_tx(pool, |tx| {
        own_pot_for_update(tx, space_id, owner)?;
        let gone = tx
            .query(
                "DELETE FROM bank.shared_pot_cards WHERE space_id = $1::text::uuid RETURNING card_id::text",
                &[&space_id],
            )
            .map_err(|e| pg(&e))?;
        if let Some(r) = gone.first() {
            let card: String = r.get(0);
            log(
                tx,
                space_id,
                owner,
                None,
                "card_unlinked",
                None,
                Some(&card),
            )?;
        }
        Ok(Json::obj([("unlinked", Json::Bool(true))]))
    })
}

/// `cardToFreeze`: the card a holder of this pot may freeze; a viewer refuses `bank.space_forbidden`.
pub fn card_to_freeze(
    pool: &Store,
    terms: &Terms,
    space_id: &str,
    user_id: &str,
) -> Result<String, Refusal> {
    with(pool, |c| {
        let pot = space::find(c, space_id)?;
        let role = match &pot {
            Some(p) if p.user_id != user_id => role_of(c, space_id, user_id)?,
            _ => None,
        };
        if !pot.is_some_and(|p| p.archived_at.is_none() && (p.user_id == user_id || role.is_some()))
        {
            return Err(not_found(space_id));
        }
        if role.as_deref() == Some("viewer") {
            return Err(refuse(
                "bank.space_forbidden",
                "A viewer of a shared pot can see its card but cannot freeze it",
            ));
        }
        let rows = c
            .query(
                "SELECT pc.card_id::text, c.issuer, c.simulated FROM bank.shared_pot_cards pc JOIN bank.cards c ON c.id = pc.card_id \
                 WHERE pc.space_id = $1::text::uuid",
                &[&space_id],
            )
            .map_err(|e| pg(&e))?;
        let Some(link) = rows.first() else {
            return Err(refuse(
                "bank.card_not_found",
                "No card is linked to this pot",
            ));
        };
        assert_programme(terms, &link.get::<_, String>(1), link.get(2))?;
        Ok(link.get(0))
    })
}

struct Member {
    space_id: String,
    user_id: String,
    role: String,
    joined_at: Instant,
}

fn member_of(r: &Row) -> Member {
    Member {
        space_id: r.get(0),
        user_id: r.get(1),
        role: r.get(2),
        joined_at: Instant(r.get(3)),
    }
}

const MEMBER_COLS: &str =
    "m.space_id::text, m.user_id, m.role, floor(extract(epoch from m.joined_at) * 1000)::int8";

/// `overview` with the router's shape: the terms, what the caller shares, what is shared with them (each pot's balance
/// read now), and invites to them not yet answered, each list one page long.
pub fn overview(
    pool: &Store,
    ports: &Ports<'_>,
    money: &space::Money<'_>,
    user_id: &str,
    limit: Option<f64>,
) -> Result<Json, Refusal> {
    let page = space::shared_pots_list_limit(limit)?;
    let (owned_ids, shared_rows, invite_rows, members, open_out, linked, pots) = with(pool, |c| {
        let owned_ids: Vec<String> = c
            .query(
                "SELECT s.id::text FROM bank.spaces s WHERE s.user_id = $1 AND s.kind = 'named' AND s.archived_at IS NULL \
                 AND (EXISTS (SELECT 1 FROM bank.shared_pot_members m WHERE m.space_id = s.id) \
                   OR EXISTS (SELECT 1 FROM bank.shared_pot_cards c WHERE c.space_id = s.id) \
                   OR EXISTS (SELECT 1 FROM bank.shared_pot_invites i WHERE i.space_id = s.id AND i.accepted_at IS NULL \
                      AND i.declined_at IS NULL AND i.cancelled_at IS NULL)) \
                 ORDER BY s.created_at, s.id LIMIT $2",
                &[&user_id, &page],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(|r| r.get(0))
            .collect();
        let shared_rows: Vec<Member> = c
            .query(
                &format!(
                    "SELECT {MEMBER_COLS} FROM bank.shared_pot_members m JOIN bank.spaces s ON s.id = m.space_id \
                     WHERE m.user_id = $1 AND s.archived_at IS NULL ORDER BY m.joined_at, m.space_id LIMIT $2"
                ),
                &[&user_id, &page],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(member_of)
            .collect();
        let invite_rows: Vec<Invite> = c
            .query(
                "SELECT i.id::text, i.space_id::text, i.inviter_user_id, i.invitee_user_id, i.role, \
                 floor(extract(epoch from i.created_at) * 1000)::int8, floor(extract(epoch from i.expires_at) * 1000)::int8, \
                 i.accepted_at IS NOT NULL, i.declined_at IS NOT NULL, i.cancelled_at IS NOT NULL, i.expires_at <= now() \
                 FROM bank.shared_pot_invites i JOIN bank.spaces s ON s.id = i.space_id \
                 WHERE i.invitee_user_id = $1 AND i.accepted_at IS NULL AND i.declined_at IS NULL AND i.cancelled_at IS NULL \
                 AND s.archived_at IS NULL ORDER BY i.created_at DESC, i.id LIMIT $2",
                &[&user_id, &page],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(Invite::from_row)
            .collect();
        let pot_ids: Vec<String> = owned_ids
            .iter()
            .cloned()
            .chain(shared_rows.iter().map(|m| m.space_id.clone()))
            .collect();
        let members: Vec<Member> = if pot_ids.is_empty() {
            Vec::new()
        } else {
            c.query(
                &format!(
                    "SELECT {MEMBER_COLS} FROM bank.shared_pot_members m WHERE m.space_id::text = ANY($1) ORDER BY m.joined_at, m.user_id"
                ),
                &[&pot_ids],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(member_of)
            .collect()
        };
        let open_out: Vec<Invite> = if owned_ids.is_empty() {
            Vec::new()
        } else {
            c.query(
                &format!(
                    "SELECT {INVITE_COLS} FROM (SELECT *, row_number() OVER (PARTITION BY space_id ORDER BY created_at DESC, id) AS n \
                       FROM bank.shared_pot_invites WHERE space_id::text = ANY($1) AND accepted_at IS NULL AND declined_at IS NULL \
                       AND cancelled_at IS NULL) open WHERE n <= $2 ORDER BY created_at DESC, id"
                ),
                &[&owned_ids, &page],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(Invite::from_row)
            .collect()
        };
        let linked: Vec<(String, Json)> = if pot_ids.is_empty() {
            Vec::new()
        } else {
            c.query(
                "SELECT pc.space_id::text, c.id::text, c.pan_tail, c.status::text, c.frozen_by FROM bank.shared_pot_cards pc \
                 JOIN bank.cards c ON c.id = pc.card_id WHERE pc.space_id::text = ANY($1)",
                &[&pot_ids],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(|r| {
                (
                    r.get::<_, String>(0),
                    card_json(&r.get::<_, String>(1), &r.get::<_, String>(2), &r.get::<_, String>(3), r.get::<_, Option<String>>(4).as_deref()),
                )
            })
            .collect()
        };
        let mut ids: Vec<String> = Vec::new();
        for id in pot_ids
            .iter()
            .chain(invite_rows.iter().map(|i| &i.space_id))
        {
            if !ids.contains(id) {
                ids.push(id.clone());
            }
        }
        let mut pots: Vec<Space> = Vec::new();
        for id in &ids {
            pots.push(get(c, id)?);
        }
        Ok((
            owned_ids,
            shared_rows,
            invite_rows,
            members,
            open_out,
            linked,
            pots,
        ))
    })?;
    let pot = |id: &str| {
        pots.iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or_else(|| not_found(id))
    };
    let mut who: Vec<String> = members.iter().map(|m| m.user_id.clone()).collect();
    who.extend(open_out.iter().map(|i| i.invitee.clone()));
    who.extend(invite_rows.iter().map(|i| i.inviter.clone()));
    for r in &shared_rows {
        who.push(pot(&r.space_id)?.user_id);
    }
    let names = names(ports, &who)?;
    let card_of = |id: &str| {
        linked
            .iter()
            .find(|(s, _)| s == id)
            .map_or(Json::Null, |(_, c)| c.clone())
    };
    let members_of = |id: &str| {
        Json::Array(
            members
                .iter()
                .filter(|m| m.space_id == id)
                .map(|m| {
                    Json::obj([
                        ("userId", Json::str(m.user_id.clone())),
                        (
                            "handle",
                            names.get(&m.user_id).map_or(Json::Null, Json::str),
                        ),
                        ("role", Json::str(m.role.clone())),
                        ("joinedAt", Json::str(m.joined_at.iso())),
                    ])
                })
                .collect(),
        )
    };
    let pot_json = |p: &Space| {
        vec![
            ("id".to_owned(), Json::str(p.id.clone())),
            ("name".to_owned(), Json::str(p.name.clone())),
            ("assetId".to_owned(), Json::str(p.asset_id.clone())),
        ]
    };
    let mut owned = Vec::new();
    for id in &owned_ids {
        let p = pot(id)?;
        let invites: Vec<Json> = open_out
            .iter()
            .filter(|i| i.space_id == *id)
            .map(|i| {
                let mut f = i.fields();
                f.push(("invitee".to_owned(), person(&i.invitee, &names)));
                Json::Object(f)
            })
            .collect();
        owned.push(Json::obj([
            ("pot", Json::Object(pot_json(&p))),
            ("card", card_of(id)),
            ("members", members_of(id)),
            ("invites", Json::Array(invites)),
        ]));
    }
    let mut shared = Vec::new();
    for r in &shared_rows {
        let p = pot(&r.space_id)?;
        let mut pj = pot_json(&p);
        pj.push((
            "balance".to_owned(),
            Json::str(service_kit::money::format_amount(money.balance_of(&p)?)),
        ));
        shared.push(Json::obj([
            ("pot", Json::Object(pj)),
            ("card", card_of(&r.space_id)),
            ("owner", person(&p.user_id, &names)),
            ("role", Json::str(r.role.clone())),
            ("members", members_of(&r.space_id)),
        ]));
    }
    let mut invites = Vec::new();
    for i in &invite_rows {
        let p = pot(&i.space_id)?;
        let mut f = i.fields();
        f.push((
            "pot".to_owned(),
            Json::obj([
                ("name", Json::str(p.name.clone())),
                ("assetId", Json::str(p.asset_id.clone())),
            ]),
        ));
        f.push(("owner".to_owned(), person(&i.inviter, &names)));
        invites.push(Json::Object(f));
    }
    let n = |v: Option<i64>| v.map_or(Json::Null, Json::int);
    Ok(Json::obj([
        (
            "terms",
            Json::obj([
                ("inviteMinutes", n(ports.terms.invite_minutes())),
                ("peopleCap", n(ports.terms.people_cap())),
            ]),
        ),
        ("owned", Json::Array(owned)),
        ("shared", Json::Array(shared)),
        ("invites", Json::Array(invites)),
    ]))
}

/// `activity`: the pot's log, newest first, for its owner and its members; anyone else is told it is not found.
pub fn activity(
    pool: &Store,
    ports: &Ports<'_>,
    space_id: &str,
    user_id: &str,
    limit: Option<f64>,
    before: Option<&str>,
) -> Result<Json, Refusal> {
    let page = space::shared_pots_list_limit(limit)?;
    let rows = with(pool, |c| {
        let pot = space::find(c, space_id)?;
        let allowed = match &pot {
            None => false,
            Some(p) => p.user_id == user_id || role_of(c, space_id, user_id)?.is_some(),
        };
        if !allowed {
            return Err(not_found(space_id));
        }
        let sql = format!(
            "SELECT a.id::text, a.kind, a.actor_user_id, a.subject_user_id, a.role, a.card_id::text, c.pan_tail, \
             floor(extract(epoch from a.at) * 1000)::int8 \
             FROM bank.shared_pot_activity a LEFT JOIN bank.cards c ON c.id = a.card_id \
             WHERE a.space_id = $1::text::uuid {} ORDER BY a.id DESC LIMIT $2",
            if before.is_some() {
                "AND a.id < $3::text::bigint"
            } else {
                ""
            }
        );
        let out = match before {
            Some(b) => c.query(&sql, &[&space_id, &page, &b]),
            None => c.query(&sql, &[&space_id, &page]),
        };
        out.map_err(|e| pg(&e))
    })?;
    let mut who = Vec::new();
    for r in &rows {
        who.push(r.get::<_, String>(2));
        if let Some(s) = r.get::<_, Option<String>>(3) {
            who.push(s);
        }
    }
    who.retain(|id| id != BANK_ACTOR);
    let names = names(ports, &who)?;
    Ok(Json::Array(
        rows.iter()
            .map(|r| {
                let card = r.get::<_, Option<String>>(5).map_or(Json::Null, |id| {
                    Json::obj([
                        ("cardId", Json::str(id)),
                        (
                            "panTail",
                            Json::str(r.get::<_, Option<String>>(6).unwrap_or_default()),
                        ),
                    ])
                });
                Json::obj([
                    ("id", Json::str(r.get::<_, String>(0))),
                    ("kind", Json::str(r.get::<_, String>(1))),
                    ("actor", person(&r.get::<_, String>(2), &names)),
                    (
                        "subject",
                        r.get::<_, Option<String>>(3)
                            .map_or(Json::Null, |s| person(&s, &names)),
                    ),
                    (
                        "role",
                        r.get::<_, Option<String>>(4).map_or(Json::Null, Json::str),
                    ),
                    ("card", card),
                    ("at", Json::str(Instant(r.get(7)).iso())),
                ])
            })
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_handle_or_email_is_read_as_the_directory_reads_it() {
        assert_eq!(handle_query(" @ada_1 ").as_deref(), Some("ada_1"));
        assert_eq!(handle_query("ad"), None);
        assert_eq!(handle_query("a-b-c"), None);
        assert_eq!(
            email_query(" ada@example.com ").as_deref(),
            Some("ada@example.com")
        );
        assert_eq!(email_query("ada@example"), None);
        assert_eq!(email_query("a@b@c.d"), None);
        assert_eq!(email_query("ada@.x.com").as_deref(), Some("ada@.x.com"));
    }

    #[test]
    fn the_banks_two_values_are_whole_numbers_in_range_or_none() {
        let t = |m: &str, c: &str| Terms {
            invite_minutes: Some(m.to_owned()),
            people_cap: Some(c.to_owned()),
            card_programme: ("none".to_owned(), true),
        };
        assert_eq!(
            (t("60", "5").invite_minutes(), t("60", "5").people_cap()),
            (Some(60), Some(5))
        );
        assert_eq!(t("43201", "51").invite_minutes(), None);
        assert_eq!(t("43201", "51").people_cap(), None);
        assert_eq!(t("0", "05").invite_minutes(), None);
        assert_eq!(t("0", "05").people_cap(), None);
        assert!(
            matches!(t("", "5").required(), Err(Refusal::Bank(e)) if e.row.code == "bank.joint_unset")
        );
    }
}
