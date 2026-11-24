//! `PayeeService` (`rail-sends/payees.ts`): the recipient book for bank rails (BK-xfer-06, J-bank-04 #2), the bank
//! accounts and aliases a customer sends to.
//!
//! A recipient is saved with a nickname, the country of the account and one rail's form, checked as a send checks it.
//! Saving the same destination again is the same recipient, one live row per `(user, destination)`. Details are never
//! edited: a changed account is a new recipient, so its cooling-off starts again. A new recipient waits the owner's
//! window (`BANK_PAYEE_COOLING_HOURS`), which has no default: blank refuses every send to a saved recipient, inside it
//! refuses with the end time, and zero is a real owner choice. Nothing here holds or posts money.

use postgres::GenericClient;
use service_kit::json::Json;
use service_kit::money::js_trim;
use service_kit::schema::Value;
use service_kit::time::Instant;

use super::forms::{self, Recipient, check_recipient, destination_key, field, mask_recipient};
use crate::errors::Refusal;
use crate::partner::refuse;
use crate::spaces::space::{at, pg, with};

/// `BANK_PAYEE_COOLING_HOURS_ENV`.
pub const BANK_PAYEE_COOLING_HOURS_ENV: &str = "BANK_PAYEE_COOLING_HOURS";

/// The euro-area countries (2026): SEPA from a euro account. A fact of the currency union, not an owner value.
const EURO_AREA: [&str; 21] = [
    "AT", "BE", "BG", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV",
    "MT", "NL", "PT", "SI", "SK",
];

const US_RAILS: [&str; 4] = ["ach", "wire", "instant", "proxy"];
const EURO_RAILS: [&str; 2] = ["sepa", "proxy"];

/// `PAYEE_COUNTRIES`: each country the book takes, in its order, with the rails its forms come from.
pub fn payee_countries() -> Vec<(&'static str, &'static [&'static str])> {
    let mut out: Vec<(&'static str, &'static [&'static str])> = vec![("US", &US_RAILS)];
    out.extend(EURO_AREA.iter().map(|c| (*c, &EURO_RAILS[..])));
    out
}

/// `countries()`.
pub fn countries() -> Json {
    Json::Array(
        payee_countries()
            .into_iter()
            .map(|(country, rails)| {
                Json::obj([
                    ("country", Json::str(country)),
                    (
                        "rails",
                        Json::Array(rails.iter().map(|r| Json::str(*r)).collect()),
                    ),
                ])
            })
            .collect(),
    )
}

/// `PayeeAsk`.
pub struct PayeeAsk<'a> {
    pub nickname: &'a str,
    pub country: &'a str,
    pub rail: &'a str,
    pub recipient: &'a [(String, Value)],
}

/// `PayeeRow`.
#[derive(Debug, Clone)]
pub struct PayeeRow {
    pub id: String,
    pub user_id: String,
    pub nickname: String,
    pub country: String,
    pub rail: String,
    pub recipient: Recipient,
    pub created_at: Instant,
    pub scam_warning_read_at: Option<Instant>,
}

const COLS: &str = "id::text, user_id, nickname, country, rail, recipient::text, \
     floor(extract(epoch from created_at) * 1000)::int8, \
     floor(extract(epoch from scam_warning_read_at) * 1000)::int8";

fn row(r: &postgres::Row) -> Result<PayeeRow, Refusal> {
    let s = |i: usize| -> Result<String, Refusal> { r.try_get::<_, String>(i).map_err(|e| pg(&e)) };
    Ok(PayeeRow {
        id: s(0)?,
        user_id: s(1)?,
        nickname: s(2)?,
        country: s(3)?,
        rail: s(4)?,
        recipient: forms::from_json_text(&s(5)?)?,
        created_at: Instant(r.try_get(6).map_err(|e| pg(&e))?),
        scam_warning_read_at: r
            .try_get::<_, Option<i64>>(7)
            .map_err(|e| pg(&e))?
            .map(Instant),
    })
}

/// What the book's wiring holds: the owner's window, as `compose.ts` hands it in (`undefined` when unset), and the
/// clock, read at each use as `PayeeService`'s `now = () => new Date()` is (after a write, not when the call began).
pub struct Book<'a> {
    pub cooling_hours: Option<&'a str>,
    pub now: fn() -> Instant,
}

/// The largest time a JavaScript `Date` holds (`8.64e15` ms after the epoch).
const DATE_MAX_MS: i128 = 8_640_000_000_000_000;
const HOUR_MS: i128 = 3_600_000;

/// `readPayeeCoolingHours`: the owner's window in whole hours, or none when blank or not a whole number. A window
/// with more digits than any date can hold is kept as `u128::MAX`, which [`Cooling::of`] then reads as unset.
pub fn read_payee_cooling_hours(raw: Option<&str>) -> Option<u128> {
    let t = js_trim(raw.unwrap_or_default());
    if t.is_empty() || !t.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(t.parse::<u128>().unwrap_or(u128::MAX))
}

/// `PayeeView['cooling']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cooling {
    Unset,
    Active(Instant),
    Open(Instant),
}

impl Cooling {
    /// `cooling(hours, addedAt, now)`. A window past what a date can hold is not a window anyone published: it reads
    /// as unset, never as a crash.
    pub fn of(hours: Option<u128>, added_at: Instant, now: Instant) -> Cooling {
        let Some(hours) = hours.and_then(|h| i128::try_from(h).ok()) else {
            return Cooling::Unset;
        };
        let ends = hours
            .checked_mul(HOUR_MS)
            .and_then(|ms| ms.checked_add(i128::from(added_at.0)))
            .filter(|ms| ms.abs() <= DATE_MAX_MS)
            .and_then(|ms| i64::try_from(ms).ok());
        match ends {
            None => Cooling::Unset,
            Some(ends) if ends > now.0 => Cooling::Active(Instant(ends)),
            Some(ends) => Cooling::Open(Instant(ends)),
        }
    }

    fn json(self) -> Json {
        let (state, ends) = match self {
            Cooling::Unset => ("unset", None),
            Cooling::Active(e) => ("active", Some(e)),
            Cooling::Open(e) => ("open", Some(e)),
        };
        Json::obj([
            ("state", Json::str(state)),
            ("endsAt", ends.map_or(Json::Null, |e| Json::str(e.iso()))),
        ])
    }
}

/// The nickname, the country and the recipient as an entry keeps them.
struct Entry {
    nickname: String,
    country: String,
    recipient: Recipient,
}

impl Book<'_> {
    fn cooling(&self, added_at: Instant) -> Cooling {
        Cooling::of(
            read_payee_cooling_hours(self.cooling_hours),
            added_at,
            (self.now)(),
        )
    }

    /// `entry`: the nickname, the country, a rail that country takes, and that rail's form.
    fn entry(ask: &PayeeAsk<'_>) -> Result<Entry, Refusal> {
        let nickname = js_trim(ask.nickname).to_owned();
        if !forms::plain_text(&nickname, 60) {
            return Err(forms::invalid("The nickname is 1 to 60 characters"));
        }
        let country = js_trim(ask.country).to_uppercase();
        let all = payee_countries();
        let Some((_, rails)) = all.iter().find(|(c, _)| *c == country) else {
            let names: Vec<&str> = all.iter().map(|(c, _)| *c).collect();
            return Err(forms::invalid(format!(
                "The book takes accounts in {}",
                names.join(", ")
            )));
        };
        if !rails.contains(&ask.rail) {
            return Err(forms::invalid(format!(
                "An account in {country} takes {}",
                rails.join(", ")
            )));
        }
        let recipient = check_recipient(ask.rail, ask.recipient)?;
        if ask.rail == "sepa"
            && field(&recipient, "iban")
                .unwrap_or_default()
                .get(..2)
                .unwrap_or_default()
                != country
        {
            return Err(forms::invalid(format!(
                "The IBAN is not an account in {country}"
            )));
        }
        Ok(Entry {
            nickname,
            country,
            recipient,
        })
    }

    /// `check`: every check saving makes, keeping nothing.
    pub fn check(ask: &PayeeAsk<'_>) -> Result<Json, Refusal> {
        let e = Self::entry(ask)?;
        Ok(Json::obj([
            ("nickname", Json::str(e.nickname)),
            ("country", Json::str(e.country)),
            ("rail", Json::str(ask.rail)),
            (
                "recipient",
                Json::str(mask_recipient(ask.rail, &e.recipient)),
            ),
        ]))
    }

    /// `add`: save a recipient. The same destination again is the same recipient, its cooling-off unchanged.
    pub fn add(
        &self,
        store: &crate::db::Store,
        user_id: &str,
        ask: &PayeeAsk<'_>,
    ) -> Result<Json, Refusal> {
        let e = Self::entry(ask)?;
        let key = destination_key(ask.rail, &e.recipient);
        let recipient = forms::to_json(&e.recipient).compact();
        let row = with(store, |c| {
            let rows = c
                .query(
                    &format!(
                        "INSERT INTO bank.rail_payees (user_id, nickname, country, rail, recipient, destination_key) \
                         VALUES ($1, $2, $3, $4, $5::text::jsonb, $6) \
                         ON CONFLICT (user_id, destination_key) WHERE removed_at IS NULL DO NOTHING \
                         RETURNING {COLS}"
                    ),
                    &[&user_id, &e.nickname, &e.country, &ask.rail, &recipient, &key],
                )
                .map_err(|e| pg(&e))?;
            if let Some(r) = rows.first() {
                return Ok(Some(row(r)?));
            }
            let rows = c
                .query(
                    &format!(
                        "SELECT {COLS} FROM bank.rail_payees \
                          WHERE user_id = $1 AND destination_key = $2 AND removed_at IS NULL"
                    ),
                    &[&user_id, &key],
                )
                .map_err(|e| pg(&e))?;
            rows.first().map(row).transpose()
        })?;
        let Some(row) = row else {
            return Err(refuse(
                "bank.rail_send_conflict",
                "The recipient was not saved",
            ));
        };
        Ok(self.view(&row))
    }

    /// `list`: the customer's saved recipients, newest first.
    pub fn list(
        &self,
        store: &crate::db::Store,
        user_id: &str,
        limit: i64,
    ) -> Result<Json, Refusal> {
        let rows = with(store, |c| {
            c.query(
                &format!(
                    "SELECT {COLS} FROM bank.rail_payees WHERE user_id = $1 AND removed_at IS NULL \
                      ORDER BY created_at DESC, id DESC LIMIT $2"
                ),
                &[&user_id, &limit],
            )
            .map_err(|e| pg(&e))?
            .iter()
            .map(row)
            .collect::<Result<Vec<_>, _>>()
        })?;
        Ok(Json::Array(rows.iter().map(|r| self.view(r)).collect()))
    }

    /// `remove`: one of the customer's recipients, waiting or not. Not found and not yours read the same.
    pub fn remove(
        store: &crate::db::Store,
        user_id: &str,
        payee_id: &str,
    ) -> Result<Json, Refusal> {
        let id = with(store, |c| {
            let rows = c
                .query(
                    "UPDATE bank.rail_payees SET removed_at = now() \
                      WHERE id = $1::text::uuid AND user_id = $2 AND removed_at IS NULL \
                     RETURNING id::text",
                    &[&payee_id, &user_id],
                )
                .map_err(|e| pg(&e))?;
            rows.first()
                .map(|r| r.try_get::<_, String>(0).map_err(|e| pg(&e)))
                .transpose()
        })?;
        let Some(id) = id else {
            return Err(not_found(payee_id));
        };
        Ok(Json::obj([
            ("payeeId", Json::str(id)),
            ("removed", Json::Bool(true)),
        ]))
    }

    /// `readScamWarning`: once; the first read's time stands. Not found, not yours and removed read the same.
    pub fn read_scam_warning(
        &self,
        store: &crate::db::Store,
        user_id: &str,
        payee_id: &str,
    ) -> Result<Json, Refusal> {
        let row = with(store, |c| {
            let rows = c
                .query(
                    &format!(
                        "UPDATE bank.rail_payees SET scam_warning_read_at = COALESCE(scam_warning_read_at, {}) \
                          WHERE id = $1::text::uuid AND user_id = $2 AND removed_at IS NULL \
                         RETURNING {COLS}",
                        at("$3")
                    ),
                    &[&payee_id, &user_id, &(self.now)().0],
                )
                .map_err(|e| pg(&e))?;
            rows.first().map(row).transpose()
        })?;
        row.map(|r| self.view(&r))
            .ok_or_else(|| not_found(payee_id))
    }

    /// `invite`: an invite emails the recipient a link to enter their own details; no email delivery is connected.
    pub fn invite(email: &str) -> Refusal {
        if !forms::is_email(js_trim(email)) {
            return forms::invalid("The email address does not look right");
        }
        refuse(
            "bank.payee_invite_unwired",
            "Inviting a recipient emails them a link, and no email delivery is connected in this build",
        )
    }

    /// `find`: a live saved recipient of this customer. Not found, not yours and removed read the same.
    pub fn find(
        c: &mut impl GenericClient,
        user_id: &str,
        payee_id: &str,
    ) -> Result<PayeeRow, Refusal> {
        let rows = c
            .query(
                &format!(
                    "SELECT {COLS} FROM bank.rail_payees \
                      WHERE id = $1::text::uuid AND user_id = $2 AND removed_at IS NULL"
                ),
                &[&payee_id, &user_id],
            )
            .map_err(|e| pg(&e))?;
        rows.first()
            .map(row)
            .transpose()?
            .ok_or_else(|| not_found(payee_id))
    }

    /// `assertCooled`: the newest recipient this customer saved for the destination (removed or not) sets the window.
    /// A blank window and inside the window each refuse by name; a destination never saved is a one-off send.
    pub fn assert_cooled(
        &self,
        c: &mut impl GenericClient,
        user_id: &str,
        rail: &str,
        recipient: &[(String, String)],
    ) -> Result<(), Refusal> {
        let rows = c
            .query(
                "SELECT floor(extract(epoch from created_at) * 1000)::int8 FROM bank.rail_payees \
                  WHERE user_id = $1 AND destination_key = $2 ORDER BY created_at DESC, id DESC LIMIT 1",
                &[&user_id, &destination_key(rail, recipient)],
            )
            .map_err(|e| pg(&e))?;
        let Some(r) = rows.first() else {
            return Ok(());
        };
        let created = Instant(r.try_get(0).map_err(|e| pg(&e))?);
        match self.cooling(created) {
            Cooling::Unset => Err(refuse(
                "bank.payee_cooling_unset",
                format!(
                    "{BANK_PAYEE_COOLING_HOURS_ENV} is unset: a new recipient's waiting time is not published, so nothing is sent to one"
                ),
            )),
            Cooling::Active(ends) => Err(refuse(
                "bank.payee_cooling_active",
                format!(
                    "This recipient is new: money can go to it from {}",
                    ends.iso()
                ),
            )),
            Cooling::Open(_) => Ok(()),
        }
    }

    fn view(&self, r: &PayeeRow) -> Json {
        Json::obj([
            ("payeeId", Json::str(r.id.clone())),
            ("nickname", Json::str(r.nickname.clone())),
            ("country", Json::str(r.country.clone())),
            ("rail", Json::str(r.rail.clone())),
            (
                "recipient",
                Json::str(mask_recipient(&r.rail, &r.recipient)),
            ),
            ("verification", Json::str("cannot_check")),
            ("verificationRail", Json::str("rail.bank")),
            ("addedAt", Json::str(r.created_at.iso())),
            ("cooling", self.cooling(r.created_at).json()),
            (
                "scamWarning",
                match r.scam_warning_read_at {
                    Some(t) => {
                        Json::obj([("state", Json::str("read")), ("readAt", Json::str(t.iso()))])
                    }
                    None => Json::obj([("state", Json::str("unread")), ("readAt", Json::Null)]),
                },
            ),
        ])
    }
}

fn not_found(payee_id: &str) -> Refusal {
    refuse(
        "bank.payee_not_found",
        format!("Recipient {payee_id} not found"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_no_date_can_hold_reads_unset() {
        let added = Instant(1_700_000_000_000);
        assert_eq!(
            Cooling::of(read_payee_cooling_hours(Some("99999999999")), added, added),
            Cooling::Unset
        );
        assert_eq!(
            Cooling::of(read_payee_cooling_hours(Some(" soon ")), added, added),
            Cooling::Unset
        );
        assert_eq!(
            Cooling::of(read_payee_cooling_hours(Some("0")), added, added),
            Cooling::Open(added)
        );
        assert_eq!(
            Cooling::of(read_payee_cooling_hours(Some(" 24 ")), added, added),
            Cooling::Active(Instant(added.0 + 86_400_000))
        );
    }
}
