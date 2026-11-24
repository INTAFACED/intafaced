//! Which of the person's venue sub-accounts their own agent may act on, and until when (`own/access.ts`, AG-spend-02,
//! J-agents-08 #2). A grant names the sub-accounts exactly and always has an end: it replaces what was live before, in
//! one transaction, and a retry with the same grant key returns what that grant made. An action naming a sub-account is
//! refused when no live access covers it (`agents.access_account_denied`) or when the access covering it has ended
//! (`agents.access_expired`); the main account is not decided here. Access only narrows: nothing here moves value.

use service_kit::json::Json;
use service_kit::pg::Pool;
use service_kit::schema::js_trim;
use service_kit::time::Instant;

use super::evals::in_transaction;
use super::{OwnError, OwnRefusal};
use crate::db;
use crate::runtime::ms;

/// `OWN_AGENT_ACCESS_MAX_DAYS`.
pub const OWN_AGENT_ACCESS_MAX_DAYS: i64 = 365;
/// `OWN_AGENT_SUB_ACCOUNT_PREFIX`.
pub const OWN_AGENT_SUB_ACCOUNT_PREFIX: &str = "sub:";

const DAY_MS: i64 = 86_400_000;

/// `ADDRESS_RE`: `^0x[0-9a-f]{40}$`.
fn is_address(s: &str) -> bool {
    s.len() == 42
        && s.starts_with("0x")
        && s.bytes()
            .skip(2)
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn invalid_expiry() -> OwnRefusal {
    OwnRefusal::with(
        "agents.access_expiry_invalid",
        [("max", OWN_AGENT_ACCESS_MAX_DAYS.to_string())],
    )
}

/// `parseAccessEnd`: the end the person set, in whole days from now; blank is refused, never defaulted.
pub fn parse_access_end(raw: Option<&str>, now: Instant) -> Result<Instant, OwnRefusal> {
    let text = js_trim(raw.unwrap_or(""));
    if text.is_empty() {
        return Err(OwnRefusal::new("agents.access_expiry_unset"));
    }
    if !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid_expiry());
    }
    // `Number(text)` of up to sixteen digits: a value past the bound is refused, however long.
    let days = text.parse::<i64>().unwrap_or(i64::MAX);
    if !(1..=OWN_AGENT_ACCESS_MAX_DAYS).contains(&days) {
        return Err(invalid_expiry());
    }
    Ok(Instant(now.0 + days * DAY_MS))
}

/// `subAccountOf`: the sub-account an action names, or none for the main account.
pub fn sub_account_of(account: &str) -> Option<&str> {
    if account == "main" {
        return None;
    }
    Some(
        account
            .strip_prefix(OWN_AGENT_SUB_ACCOUNT_PREFIX)
            .unwrap_or(account),
    )
}

/// `OwnAgentAccountAccess`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountAccess {
    pub id: String,
    pub venue_id: String,
    pub owner: String,
    pub sub_account: String,
    pub name: String,
    pub granted_at: Instant,
    pub ends_at: Instant,
}

impl AccountAccess {
    /// In `ownAgentAccountAccessSchema`'s order.
    pub fn to_json(&self) -> Json {
        Json::obj([
            ("id", Json::str(self.id.clone())),
            ("venueId", Json::str(self.venue_id.clone())),
            ("owner", Json::str(self.owner.clone())),
            ("subAccount", Json::str(self.sub_account.clone())),
            ("name", Json::str(self.name.clone())),
            ("grantedAt", Json::str(self.granted_at.iso())),
            ("endsAt", Json::str(self.ends_at.iso())),
        ])
    }
}

/// `{ grants }`, as `own.access.*` answers.
pub fn access_json(grants: &[AccountAccess]) -> Json {
    Json::obj([(
        "grants",
        Json::Array(grants.iter().map(AccountAccess::to_json).collect()),
    )])
}

/// `accessGrantKey`.
pub fn access_grant_key(agent_id: &str, grant_key: &str) -> String {
    format!("agents:access:{agent_id}:{grant_key}")
}

/// `assertAccessAllows`: the main account is untouched here; a sub-account needs a row for it whose end is still ahead.
pub fn assert_access_allows(
    rows: &[AccountAccess],
    account: &str,
    now: Instant,
) -> Result<(), OwnRefusal> {
    let Some(sub) = sub_account_of(account) else {
        return Ok(());
    };
    let Some(row) = rows.iter().find(|r| r.sub_account == sub) else {
        return Err(OwnRefusal::with(
            "agents.access_account_denied",
            [("account", account.to_owned())],
        ));
    };
    if row.ends_at.0 <= now.0 {
        return Err(OwnRefusal::with(
            "agents.access_expired",
            [
                ("account", account.to_owned()),
                ("endedAt", row.ends_at.iso()),
            ],
        ));
    }
    Ok(())
}

/// `AccessGrantInput`.
pub struct GrantInput<'a> {
    pub grant_key: &'a str,
    pub venue_id: &'a str,
    pub owner: &'a str,
    /// `(subAccount, name)`, as sent.
    pub sub_accounts: Vec<(&'a str, &'a str)>,
    pub ends_in: Option<&'a str>,
}

/// `read`: the access rows still in force or ended only by time (not replaced), newest grant first.
pub fn read(pool: &Pool, owner_id: &str, agent_id: &str) -> Result<Vec<AccountAccess>, OwnError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT id::text, venue_id, venue_owner, sub_account, name, {}, {}
                   FROM agents.own_agent_account_access
                  WHERE owner_id = $1::text AND agent_id = $2::text::uuid AND ended_at IS NULL
                  ORDER BY granted_at DESC, name, id",
                ms("granted_at"),
                ms("ends_at")
            ),
            &[&owner_id, &agent_id],
        )?)
    })?;
    rows.iter()
        .map(|r| {
            Ok(AccountAccess {
                id: r.try_get(0)?,
                venue_id: r.try_get(1)?,
                owner: r.try_get(2)?,
                sub_account: r.try_get(3)?,
                name: r.try_get(4)?,
                granted_at: Instant(r.try_get(5)?),
                ends_at: Instant(r.try_get(6)?),
            })
        })
        .collect()
}

/// `grant`: grants exactly the sub-accounts chosen, until the end the person set, and ends whatever was live before, in
/// one transaction. A retry with the same grant key returns what that grant made and ends nothing. The caller has
/// already read the agent as the person's own.
pub fn grant(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    input: &GrantInput<'_>,
    now: Instant,
) -> Result<Vec<AccountAccess>, OwnError> {
    let key = access_grant_key(agent_id, input.grant_key);
    let owner = js_trim(input.owner).to_lowercase();
    if !is_address(&owner) {
        return Err(OwnRefusal::with(
            "agents.access_request_invalid",
            [("field", "owner".to_owned())],
        )
        .into());
    }
    let venue_id = js_trim(input.venue_id);
    if venue_id.is_empty() {
        return Err(OwnRefusal::with(
            "agents.access_request_invalid",
            [("field", "venueId".to_owned())],
        )
        .into());
    }
    let subs: Vec<(String, String)> = input
        .sub_accounts
        .iter()
        .map(|(s, n)| (js_trim(s).to_lowercase(), js_trim(n).to_owned()))
        .collect();
    if subs.is_empty() {
        return Err(OwnRefusal::new("agents.access_none_chosen").into());
    }
    let distinct = subs
        .iter()
        .enumerate()
        .all(|(i, (s, _))| !subs.iter().take(i).any(|(t, _)| t == s));
    if subs.iter().any(|(s, _)| !is_address(s)) || !distinct {
        return Err(OwnRefusal::with(
            "agents.access_request_invalid",
            [("field", "subAccounts".to_owned())],
        )
        .into());
    }
    let stored = db::with_client(pool, |c| {
        Ok(c.query(
            "SELECT id FROM agents.own_agent_account_access
              WHERE owner_id = $1::text AND agent_id = $2::text::uuid AND grant_key = $3::text",
            &[&owner_id, &agent_id, &key],
        )?)
    })?;
    if !stored.is_empty() {
        return read(pool, owner_id, agent_id);
    }
    let ends_at = parse_access_end(input.ends_in, now)?;
    let (now_ms, ends_ms) = (now.0.to_string(), ends_at.0.to_string());
    in_transaction(pool, |tx| {
        // One grant at a time per agent: the lock on the agent's row orders two grants sent at once.
        tx.query(
            "SELECT id FROM agents.own_agents WHERE id = $1::text::uuid AND owner_id = $2::text FOR UPDATE",
            &[&agent_id, &owner_id],
        )?;
        let again = tx.query(
            "SELECT id FROM agents.own_agent_account_access WHERE owner_id = $1::text AND grant_key = $2::text LIMIT 1",
            &[&owner_id, &key],
        )?;
        if !again.is_empty() {
            return Ok(Ok(()));
        }
        tx.execute(
            "UPDATE agents.own_agent_account_access
                SET ended_at = timestamptz 'epoch' + $3::text::bigint * interval '1 millisecond'
              WHERE owner_id = $1::text AND agent_id = $2::text::uuid AND ended_at IS NULL",
            &[&owner_id, &agent_id, &now_ms],
        )?;
        for (sub, name) in &subs {
            tx.execute(
                "INSERT INTO agents.own_agent_account_access
                   (agent_id, owner_id, grant_key, venue_id, venue_owner, sub_account, name, granted_at, ends_at)
                 VALUES ($1::text::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text,
                         timestamptz 'epoch' + $8::text::bigint * interval '1 millisecond',
                         timestamptz 'epoch' + $9::text::bigint * interval '1 millisecond')",
                &[
                    &agent_id, &owner_id, &key, &venue_id, &owner, sub, name, &now_ms, &ends_ms,
                ],
            )?;
        }
        Ok(Ok(()))
    })?;
    read(pool, owner_id, agent_id)
}

/// `assertAllows`: the gate an action naming an account passes before the rules, refused with its code, or it returns.
pub fn assert_allows(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    account: &str,
    now: Instant,
) -> Result<(), OwnError> {
    if sub_account_of(account).is_none() {
        return Ok(());
    }
    Ok(assert_access_allows(
        &read(pool, owner_id, agent_id)?,
        account,
        now,
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUB_A: &str = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SUB_B: &str = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn code<T>(r: Result<T, OwnRefusal>) -> Option<String> {
        r.err().map(|e| e.code)
    }

    /// `access.test.ts`: "a blank end is refused agents.access_expiry_unset, never defaulted; a non-whole, zero or too
    /// long end is invalid".
    #[test]
    fn a_blank_end_is_unset_and_a_non_whole_zero_or_too_long_end_is_invalid() {
        let now = Instant(1_700_000_000_000);
        for blank in [None, Some(""), Some("  ")] {
            assert_eq!(
                code(parse_access_end(blank, now)).as_deref(),
                Some("agents.access_expiry_unset")
            );
        }
        for bad in ["1.5", "-1", "0", "366", "seven", "99999999999999999999"] {
            assert_eq!(
                code(parse_access_end(Some(bad), now)).as_deref(),
                Some("agents.access_expiry_invalid"),
                "{bad}"
            );
        }
        assert_eq!(
            parse_access_end(Some(" 7 "), now).unwrap().0 - now.0,
            7 * DAY_MS
        );
        assert_eq!(
            parse_access_end(Some("365"), now).unwrap().0 - now.0,
            365 * DAY_MS
        );
    }

    /// `access.test.ts`: "a sub-account with live access is allowed; one not granted is refused; one past its end is
    /// refused; main is not decided here".
    #[test]
    fn a_live_sub_account_passes_an_ungranted_or_ended_one_refuses_and_main_is_not_decided() {
        let now = Instant(1_700_000_000_000);
        let row = |sub: &str, ends: i64| AccountAccess {
            id: String::new(),
            venue_id: String::new(),
            owner: String::new(),
            sub_account: sub.to_owned(),
            name: String::new(),
            granted_at: now,
            ends_at: Instant(ends),
        };
        let rows = [row(SUB_A, now.0 + 1), row(SUB_B, now.0)];
        assert_eq!(
            code(assert_access_allows(&rows, &format!("sub:{SUB_A}"), now)),
            None
        );
        assert_eq!(
            code(assert_access_allows(&rows, &format!("sub:{SUB_B}"), now)).as_deref(),
            Some("agents.access_expired")
        );
        assert_eq!(
            code(assert_access_allows(
                &rows[..1],
                &format!("sub:{SUB_B}"),
                now
            ))
            .as_deref(),
            Some("agents.access_account_denied")
        );
        assert_eq!(code(assert_access_allows(&[], "main", now)), None);
    }
}
