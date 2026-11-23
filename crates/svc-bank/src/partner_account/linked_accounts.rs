//! `linkedAccounts.list/link/remove` (`linked-accounts/`): the customer's own accounts at other banks, to pay in from
//! and to cash out to (`LinkedAccountService`).
//!
//! A linked account is kept as the customer typed it and starts `unverified`; only the banking partner's signed call
//! verifies it (`verify`, reached through the cash-out part's job door). The IBAN is the business key: one active link
//! per customer and IBAN. Removing keeps the row with `removed_at`. Two owner values apply, read from the environment
//! and never invented: `BANK_ADDRESS_BOOK_CAP` (blank refuses `bank.address_book_cap_unset`) and
//! `BANK_OFFRAMP_COOLING_HOURS` (blank lists the account with `bank.offramp_cooling_unset` and no end time). Nothing
//! here moves value or holds an amount.

use std::collections::BTreeMap;

use postgres::IsolationLevel;
use postgres::Row;
use service_kit::json::Json;
use service_kit::money::{is_js_whitespace, js_trim};
use service_kit::schema::Value;
use service_kit::server::Response;
use service_kit::time::Instant;

use super::{Deps, refuse};
use crate::db::{StoreError, transaction, with_client};
use crate::door::Ctx;
use crate::errors::Refusal;

/// `BANK_ADDRESS_BOOK_CAP_ENV` and `BANK_OFFRAMP_COOLING_HOURS_ENV`.
pub const ADDRESS_BOOK_CAP_ENV: &str = "BANK_ADDRESS_BOOK_CAP";
pub const OFFRAMP_COOLING_HOURS_ENV: &str = "BANK_OFFRAMP_COOLING_HOURS";

/// What this part holds: the two owner values, as the environment gave them (`None` when unset).
pub struct Wiring {
    pub address_book_cap: Option<String>,
    pub offramp_cooling_hours: Option<String>,
}

impl Wiring {
    pub fn from_env(env: &BTreeMap<String, String>) -> Result<Wiring, String> {
        Ok(Wiring {
            address_book_cap: env.get(ADDRESS_BOOK_CAP_ENV).cloned(),
            offramp_cooling_hours: env.get(OFFRAMP_COOLING_HOURS_ENV).cloned(),
        })
    }
}

/// One stored account (`Row`), its `created_at` in epoch milliseconds as the driver's `Date` reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub id: String,
    pub label: String,
    pub holder_name: String,
    pub iban: String,
    pub country: String,
    pub state: String,
    pub created_at: Instant,
}

/// `LinkedAccountView`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct View {
    pub account_id: String,
    pub label: String,
    pub holder_name: String,
    pub iban_masked: String,
    pub country: String,
    pub state: String,
    pub usable: bool,
    pub blocker: Option<&'static str>,
    pub linked_at: Instant,
    pub cooling_off_ends_at: Option<Instant>,
}

impl View {
    pub fn json(&self) -> Json {
        let opt = |v: Option<String>| v.map_or(Json::Null, Json::str);
        Json::obj([
            ("accountId", Json::str(&self.account_id)),
            ("label", Json::str(&self.label)),
            ("holderName", Json::str(&self.holder_name)),
            ("ibanMasked", Json::str(&self.iban_masked)),
            ("country", Json::str(&self.country)),
            ("state", Json::str(&self.state)),
            ("usable", Json::Bool(self.usable)),
            ("blocker", opt(self.blocker.map(str::to_owned))),
            (
                "verificationRail",
                if self.state == "verified" {
                    Json::Null
                } else {
                    Json::str("rail.bank")
                },
            ),
            ("linkedAt", Json::str(self.linked_at.iso())),
            (
                "coolingOffEndsAt",
                opt(self.cooling_off_ends_at.map(Instant::iso)),
            ),
        ])
    }
}

/// `COLUMNS`, with `created_at` as the driver's `Date` holds it (whole milliseconds).
pub const COLUMNS: &str = "id::text AS id, label, holder_name, iban, country, state, \
    (floor(extract(epoch FROM created_at) * 1000))::int8 AS created_ms";

pub fn store_err(e: StoreError) -> Refusal {
    Refusal::Other(e.message)
}

fn account_of(r: &Row) -> Result<Account, StoreError> {
    let s = |i: usize| r.try_get::<_, String>(i).map_err(StoreError::from);
    Ok(Account {
        id: s(0)?,
        label: s(1)?,
        holder_name: s(2)?,
        iban: s(3)?,
        country: s(4)?,
        state: s(5)?,
        created_at: Instant(r.try_get::<_, i64>(6).map_err(StoreError::from)?),
    })
}

fn invalid(message: &str) -> Refusal {
    refuse("bank.linked_account_invalid", message)
}

fn not_found() -> Refusal {
    refuse(
        "bank.linked_account_not_found",
        "No linked bank account with this id",
    )
}

/// `isIbanRef` (`withdraw-destination.ts`): the shape and the mod-97 check.
pub fn is_iban_ref(compact: &str) -> bool {
    let b = compact.as_bytes();
    let (Some(country), Some(check), Some(rest)) = (b.get(..2), b.get(2..4), b.get(4..)) else {
        return false;
    };
    let shape = country.iter().all(u8::is_ascii_uppercase)
        && check.iter().all(u8::is_ascii_digit)
        && rest
            .iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        && !rest.is_empty();
    if !shape || b.len() < 15 || b.len() > 34 {
        return false;
    }
    let mut remainder: u32 = 0;
    for c in rest.iter().chain(country).chain(check) {
        let digits = if c.is_ascii_uppercase() {
            format!("{}", u32::from(*c) - 55)
        } else {
            (*c as char).to_string()
        };
        for d in digits.bytes() {
            remainder = (remainder * 10 + u32::from(d - b'0')) % 97;
        }
    }
    remainder == 1
}

/// `normalizeIban`: without white space, in capitals, when it passes the shape and the mod-97 check.
pub fn normalize_iban(raw: &str) -> Result<String, Refusal> {
    let compact: String = raw
        .chars()
        .filter(|c| !is_js_whitespace(*c))
        .collect::<String>()
        .to_uppercase();
    let b = compact.as_bytes();
    let part =
        |r: std::ops::Range<usize>, ok: fn(&u8) -> bool| b.get(r).is_some_and(|p| p.iter().all(ok));
    let shape = (15..=34).contains(&b.len())
        && part(0..2, u8::is_ascii_uppercase)
        && part(2..4, u8::is_ascii_digit)
        && part(4..b.len(), |c| c.is_ascii_uppercase() || c.is_ascii_digit());
    if !shape || !is_iban_ref(&compact) {
        return Err(invalid(
            "Enter the IBAN as your bank shows it: two letters, two check digits and the account number",
        ));
    }
    Ok(compact)
}

/// `typed`: trimmed, 1 to `max` UTF-16 units, no control character.
fn typed(value: &str, what: &str, max: usize) -> Result<String, Refusal> {
    let trimmed = js_trim(value);
    let n = trimmed.encode_utf16().count();
    if n < 1 || n > max || trimmed.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}') {
        return Err(invalid(&format!(
            "The {what} must be 1 to {max} characters"
        )));
    }
    Ok(trimmed.to_owned())
}

/// `maskIban`.
pub fn mask_iban(iban: &str) -> String {
    let chars: Vec<char> = iban.chars().collect();
    let head: String = chars.iter().take(4).collect();
    let tail: String = chars.iter().skip(chars.len().saturating_sub(4)).collect();
    format!("{head} •••• {tail}")
}

/// `readOfframpCoolingHours`: digits only, else none. Whole hours too many to count read as none: their window passes
/// any date, so it reads as unset either way.
pub fn cooling_hours(raw: Option<&str>) -> Option<i128> {
    let t = js_trim(raw.unwrap_or_default());
    if t.is_empty() || !t.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    t.parse::<i128>().ok()
}

/// The largest date JavaScript holds, in milliseconds either side of the epoch (`TimeClip`).
const MAX_DATE_MS: i128 = 8_640_000_000_000_000;

/// `viewOf`.
pub fn view_of(row: &Account, hours: Option<i128>, now: Instant) -> View {
    // `new Date(created + hours * MS_PER_HOUR)`: a window too large for a date reads as unset, never open. Whole hours
    // and whole milliseconds, so the sum is exact as JavaScript's is inside a date's range.
    let ends = hours
        .and_then(|h| {
            h.checked_mul(3_600_000)?
                .checked_add(i128::from(row.created_at.0))
        })
        .filter(|e| e.abs() <= MAX_DATE_MS)
        .and_then(|e| i64::try_from(e).ok())
        .map(Instant);
    let blocker = if row.state != "verified" {
        Some("bank.linked_account_unverified")
    } else {
        match ends {
            None => Some("bank.offramp_cooling_unset"),
            Some(e) if e.0 > now.0 => Some("bank.offramp_cooling_active"),
            Some(_) => None,
        }
    };
    View {
        account_id: row.id.clone(),
        label: row.label.clone(),
        holder_name: row.holder_name.clone(),
        iban_masked: mask_iban(&row.iban),
        country: row.country.clone(),
        state: row.state.clone(),
        usable: blocker.is_none(),
        blocker,
        linked_at: row.created_at,
        cooling_off_ends_at: ends,
    }
}

/// `UUID_RE`, case-insensitive.
pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// `linkCap`: the address book's owner cap, which also bounds linked accounts. No number is invented.
fn link_cap(raw: Option<&str>) -> Result<i64, Refusal> {
    let t = js_trim(raw.unwrap_or_default());
    let b = t.as_bytes();
    let ok = (1..=6).contains(&b.len())
        && b.first().is_some_and(|c| (b'1'..=b'9').contains(c))
        && b.iter().all(u8::is_ascii_digit);
    match t.parse::<i64>() {
        Ok(n) if ok => Ok(n),
        _ => Err(refuse(
            "bank.address_book_cap_unset",
            "BANK_ADDRESS_BOOK_CAP is unset or not a positive whole number. Linking an account refuses rather than inventing a limit",
        )),
    }
}

fn hours(d: &Deps<'_>) -> Option<i128> {
    cooling_hours(d.wiring.linked_accounts.offramp_cooling_hours.as_deref())
}

fn query_accounts(
    d: &Deps<'_>,
    sql: &str,
    params: &[&(dyn postgres::types::ToSql + Sync)],
) -> Result<Vec<Account>, Refusal> {
    let pool = d.store.pool().map_err(store_err)?;
    with_client(pool, |c| {
        c.query(sql, params)?.iter().map(account_of).collect()
    })
    .map_err(store_err)
}

/// `list`: every active account, oldest first.
pub fn list(d: &Deps<'_>, user_id: &str) -> Result<Vec<View>, Refusal> {
    let rows = query_accounts(
        d,
        &format!(
            "SELECT {COLUMNS} FROM bank.linked_bank_accounts \
              WHERE user_id = $1 AND removed_at IS NULL ORDER BY created_at ASC, id ASC"
        ),
        &[&user_id],
    )?;
    let h = hours(d);
    Ok(rows.iter().map(|r| view_of(r, h, d.now)).collect())
}

/// `link`: stored `unverified`; the same IBAN already linked returns that account (`created` false). Links of one
/// customer queue on a per-customer advisory lock in a read-committed transaction, which holds the cap.
pub fn link(
    d: &Deps<'_>,
    user_id: &str,
    label: &str,
    holder_name: &str,
    iban: &str,
) -> Result<(View, bool), Refusal> {
    let iban = normalize_iban(iban)?;
    let label = typed(label, "name for this account", 64)?;
    let holder = typed(holder_name, "account holder's name", 140)?;
    let pool = d.store.pool().map_err(store_err)?;
    let cap_raw = d.wiring.linked_accounts.address_book_cap.clone();
    let fresh = service_kit::approvals::random_uuid().map_err(Refusal::Other)?;
    let out = transaction(pool, IsolationLevel::ReadCommitted, |tx| {
        tx.execute(
            "SELECT pg_advisory_xact_lock(hashtext($1))",
            &[&format!("linked-bank-accounts:{user_id}")],
        )?;
        let same = tx.query(
            &format!(
                "SELECT {COLUMNS} FROM bank.linked_bank_accounts \
                  WHERE user_id = $1 AND iban = $2 AND removed_at IS NULL"
            ),
            &[&user_id, &iban],
        )?;
        if let Some(r) = same.first() {
            return Ok(Ok((account_of(r)?, false)));
        }
        let cap = match link_cap(cap_raw.as_deref()) {
            Ok(c) => c,
            Err(e) => return Ok(Err(e)),
        };
        let n: i32 = tx
            .query_one(
                "SELECT count(*)::int AS n FROM bank.linked_bank_accounts WHERE user_id = $1 AND removed_at IS NULL",
                &[&user_id],
            )?
            .try_get(0)?;
        if i64::from(n) >= cap {
            return Ok(Err(refuse(
                "bank.linked_accounts_full",
                format!("You have linked {cap} bank accounts, the most allowed. Remove one to link another"),
            )));
        }
        let country: String = iban.chars().take(2).collect();
        let r = tx.query_one(
            &format!(
                "INSERT INTO bank.linked_bank_accounts (id, user_id, label, holder_name, iban, country) \
                 VALUES ($1::text::uuid, $2, $3, $4, $5, $6) RETURNING {COLUMNS}"
            ),
            &[&fresh, &user_id, &label, &holder, &iban, &country],
        )?;
        Ok(Ok((account_of(&r)?, true)))
    })
    .map_err(store_err)??;
    Ok((view_of(&out.0, hours(d), d.now), out.1))
}

/// `get`: one active account of this customer; someone else's, a removed one, or none is not found.
pub fn get(d: &Deps<'_>, user_id: &str, account_id: &str) -> Result<View, Refusal> {
    let id = js_trim(account_id);
    if !is_uuid(id) {
        return Err(not_found());
    }
    let rows = query_accounts(
        d,
        &format!(
            "SELECT {COLUMNS} FROM bank.linked_bank_accounts \
              WHERE id = $1::text::uuid AND user_id = $2 AND removed_at IS NULL"
        ),
        &[&id, &user_id],
    )?;
    let row = rows.first().ok_or_else(not_found)?;
    Ok(view_of(row, hours(d), d.now))
}

/// `verify`: the partner proved the account exists and is in the customer's name. Again answers the same.
pub fn verify(d: &Deps<'_>, account_id: &str) -> Result<View, Refusal> {
    let id = js_trim(account_id);
    if !is_uuid(id) {
        return Err(not_found());
    }
    let rows = query_accounts(
        d,
        &format!(
            "UPDATE bank.linked_bank_accounts SET state = 'verified', verified_at = coalesce(verified_at, now()) \
              WHERE id = $1::text::uuid AND removed_at IS NULL RETURNING {COLUMNS}"
        ),
        &[&id],
    )?;
    let row = rows.first().ok_or_else(not_found)?;
    Ok(view_of(row, hours(d), d.now))
}

/// `payoutDetails`: the holder and masked IBAN a payout went to, even if the account was unlinked since.
pub fn payout_details(
    d: &Deps<'_>,
    user_id: &str,
    account_id: &str,
) -> Result<(String, String), Refusal> {
    let pool = d.store.pool().map_err(store_err)?;
    let row = with_client(pool, |c| {
        let rows = c.query(
            "SELECT holder_name, iban FROM bank.linked_bank_accounts WHERE id = $1::text::uuid AND user_id = $2",
            &[&account_id, &user_id],
        )?;
        rows.first()
            .map(|r| {
                Ok::<_, StoreError>((
                    r.try_get::<_, String>(0)?,
                    r.try_get::<_, String>(1)?,
                ))
            })
            .transpose()
    })
    .map_err(store_err)?;
    let (holder, iban) = row.ok_or_else(not_found)?;
    Ok((holder, mask_iban(&iban)))
}

/// `remove`: unlink. Removing one already removed answers the same; someone else's, or none, is not found.
pub fn remove(d: &Deps<'_>, user_id: &str, account_id: &str) -> Result<String, Refusal> {
    let id = js_trim(account_id);
    if !is_uuid(id) {
        return Err(not_found());
    }
    let pool = d.store.pool().map_err(store_err)?;
    let removed = with_client(pool, |c| {
        let rows = c.query(
            "UPDATE bank.linked_bank_accounts SET removed_at = coalesce(removed_at, now()) \
              WHERE id = $1::text::uuid AND user_id = $2 RETURNING id::text AS id",
            &[&id, &user_id],
        )?;
        rows.first()
            .map(|r| r.try_get::<_, String>(0).map_err(StoreError::from))
            .transpose()
    })
    .map_err(store_err)?;
    removed.ok_or_else(not_found)
}

fn text(v: &Value, key: &str) -> String {
    v.get(key).as_str().unwrap_or_default().to_owned()
}

/// The answer of one of this part's calls, by its path; `None` for a path outside it.
pub fn answer(d: &Deps<'_>, ctx: &Ctx<'_>) -> Option<Result<Json, Refusal>> {
    let user = ctx
        .principal
        .map(|p| p.user_id.as_str())
        .unwrap_or_default();
    let input = &ctx.input;
    Some(match ctx.call.path {
        "linkedAccounts.list" => list(d, user).map(|accounts| {
            Json::obj([(
                "accounts",
                Json::Array(accounts.iter().map(View::json).collect()),
            )])
        }),
        "linkedAccounts.link" => link(
            d,
            user,
            &text(input, "label"),
            &text(input, "holderName"),
            &text(input, "iban"),
        )
        .map(|(account, created)| {
            Json::obj([
                ("account", account.json()),
                ("created", Json::Bool(created)),
            ])
        }),
        "linkedAccounts.remove" => remove(d, user, &text(input, "accountId"))
            .map(|id| Json::obj([("accountId", Json::str(id)), ("removed", Json::Bool(true))])),
        _ => return None,
    })
}

/// This part has no job door of its own: the partner's verify comes through the cash-out part's.
pub fn job(_d: &Deps<'_>, _path: &str, _body: &Value) -> Option<Response> {
    None
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn normalises_and_masks_an_iban_and_refuses_a_bad_shape() {
        assert_eq!(
            normalize_iban(" nl91 abna 0417 1643 00 ").unwrap(),
            "NL91ABNA0417164300"
        );
        assert_eq!(mask_iban("DE89370400440532013000"), "DE89 •••• 3000");
        assert!(normalize_iban("0x0000000000000000000000000000000000000000").is_err());
        assert!(normalize_iban("GB82WEST12345698765433").is_err());
        assert!(normalize_iban("GB82WEST12345698765432").is_ok());
    }

    #[test]
    fn a_window_too_large_for_a_date_reads_as_unset() {
        let row = Account {
            id: "a".into(),
            label: "l".into(),
            holder_name: "h".into(),
            iban: "GB82WEST12345698765432".into(),
            country: "GB".into(),
            state: "verified".into(),
            created_at: Instant(1_700_000_000_000),
        };
        for h in ["2500000000", "99999999999"] {
            let v = view_of(&row, cooling_hours(Some(h)), Instant(0));
            assert_eq!(v.blocker, Some("bank.offramp_cooling_unset"));
            assert!(v.cooling_off_ends_at.is_none());
        }
        let v = view_of(&row, cooling_hours(Some(" 0 ")), Instant(1_700_000_000_000));
        assert!(v.usable);
        assert_eq!(cooling_hours(Some("-1")), None);
    }
}
