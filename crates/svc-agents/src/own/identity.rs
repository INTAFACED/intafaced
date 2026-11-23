//! Each own agent's identity (`own/identity.ts`, AG-identity-01, J-agents-03 #5): a token of its own, issued to its
//! owner, scoped to the agent's saved tools, expiring after the owner's set lifetime. Only the token's hash is kept. A
//! call made with the token is refused once it is revoked or expired, or while its owner's account is not active (read
//! from identity at each call, never copied). Nothing here moves value.

use service_kit::json::{self, Json};
use service_kit::pg::Pool;
use service_kit::time::Instant;
use sha2::{Digest, Sha256};

use super::desk::SupportDesk;
use super::evals::in_transaction;
use super::self_freeze::assert_owner_active;
use super::{OwnError, OwnRefusal};
use crate::db;
use crate::runtime::ms;
use crate::self_freeze::SelfFreezeRead;

/// `TOKEN_PREFIX`: every token starts with this, so a leaked one is recognisable as an agent's.
pub const TOKEN_PREFIX: &str = "agt_";
/// `OWN_TOKEN_LIFETIME_MAX_MINUTES`: one year, in minutes.
pub const OWN_TOKEN_LIFETIME_MAX_MINUTES: i64 = 525_600;

/// `hashOf`: the token's sha-256, hex.
fn hash_of(secret: &str) -> String {
    Sha256::digest(secret.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `Buffer.toString('base64url')`: no padding.
fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk.first().copied().unwrap_or(0),
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        let take = chunk.len() + 1;
        for i in 0..take {
            let index = usize::try_from((n >> (18 - 6 * i)) & 63).unwrap_or(0);
            out.push(char::from(ALPHABET.get(index).copied().unwrap_or(b'A')));
        }
    }
    out
}

/// `tokenLifetime`: the owner's token lifetime, in whole minutes; blank refuses and none is invented.
pub fn token_lifetime(minutes: Option<i64>) -> Result<i64, OwnRefusal> {
    match minutes {
        Some(m) if (1..=OWN_TOKEN_LIFETIME_MAX_MINUTES).contains(&m) => Ok(m),
        _ => Err(OwnRefusal::new("agents.identity.lifetime_unset")),
    }
}

/// One `own_agent_tokens` row, as `view` reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub agent_id: String,
    pub owner_id: String,
    pub scopes: Vec<String>,
    pub issued_at: Instant,
    pub expires_at: Instant,
    pub revoked_at: Option<Instant>,
}

impl Token {
    /// `view(row, now)`'s state.
    pub fn state(&self, now: Instant) -> &'static str {
        if self.revoked_at.is_some() {
            "revoked"
        } else if self.expires_at.0 <= now.0 {
            "expired"
        } else {
            "active"
        }
    }

    /// `view(row, now)`, in `ownAgentTokenSchema`'s order.
    pub fn to_json(&self, now: Instant) -> Json {
        Json::obj([
            ("agentId", Json::str(self.agent_id.clone())),
            ("ownerId", Json::str(self.owner_id.clone())),
            (
                "scopes",
                Json::Array(self.scopes.iter().map(|s| Json::str(s.clone())).collect()),
            ),
            ("issuedAt", Json::str(self.issued_at.iso())),
            ("expiresAt", Json::str(self.expires_at.iso())),
            (
                "revokedAt",
                self.revoked_at.map_or(Json::Null, |t| Json::str(t.iso())),
            ),
            ("state", Json::str(self.state(now))),
        ])
    }
}

fn columns() -> String {
    format!(
        "agent_id::text, owner_id, scopes::text, {}, {}, {}",
        ms("issued_at"),
        ms("expires_at"),
        ms("revoked_at")
    )
}

fn token_of(r: &postgres::Row) -> Result<Token, OwnError> {
    let scopes_text: String = r.try_get(2)?;
    let scopes = match json::parse(&scopes_text).map_err(|e| OwnError::Thrown(e.message))? {
        Json::Array(items) => items
            .iter()
            .filter_map(|v| match v {
                Json::String(s) => Some(s.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    let revoked: Option<i64> = r.try_get(5)?;
    Ok(Token {
        agent_id: r.try_get(0)?,
        owner_id: r.try_get(1)?,
        scopes,
        issued_at: Instant(r.try_get(3)?),
        expires_at: Instant(r.try_get(4)?),
        revoked_at: revoked.map(Instant),
    })
}

/// `latest`: the agent's latest token, or none when none was issued. The agent is the caller's (checked by the route).
pub fn latest(pool: &Pool, owner_id: &str, agent_id: &str) -> Result<Option<Token>, OwnError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT {} FROM agents.own_agent_tokens
                  WHERE owner_id = $1::text AND agent_id = $2::text::uuid
                  ORDER BY issued_at DESC, id
                  LIMIT 1",
                columns()
            ),
            &[&owner_id, &agent_id],
        )?)
    })?;
    rows.first().map(token_of).transpose()
}

/// The owner's account and their own freeze, as `issue` and `call` read them.
pub struct Owner<'a> {
    pub accounts: Option<&'a dyn SupportDesk>,
    pub freeze: Option<&'a dyn SelfFreezeRead>,
}

/// `issue`: a new token for the lifetime, scoped to the agent's tools, revoking any live one before it. The secret is
/// returned this once and never kept. A frozen, closed or unread owner refuses first, and nothing changes. The owner is
/// read before the write, so a freeze landing in between still leaves a token; its every call reads the owner again.
pub fn issue(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    scopes: &[String],
    lifetime_minutes: Option<i64>,
    owner: &Owner<'_>,
    now: Instant,
) -> Result<(Token, String), OwnError> {
    let minutes = token_lifetime(lifetime_minutes)?;
    assert_owner_active(owner_id, owner.accounts, owner.freeze)?;
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| OwnError::Thrown(e.to_string()))?;
    let secret = format!("{TOKEN_PREFIX}{}", base64url(&bytes));
    let issued_ms = now.0.to_string();
    let expires_ms = (now.0 + minutes * 60_000).to_string();
    let scopes_json = Json::Array(scopes.iter().map(|s| Json::str(s.clone())).collect()).compact();
    let lock = format!("agents.own.token:{agent_id}");
    let hash = hash_of(&secret);
    let token = in_transaction(pool, |tx| {
        tx.execute("SELECT pg_advisory_xact_lock(hashtext($1::text))", &[&lock])?;
        tx.execute(
            "UPDATE agents.own_agent_tokens
                SET revoked_at = timestamptz 'epoch' + $3::text::bigint * interval '1 millisecond', updated_at = now()
              WHERE owner_id = $1::text AND agent_id = $2::text::uuid AND revoked_at IS NULL",
            &[&owner_id, &agent_id, &issued_ms],
        )?;
        let inserted = tx.query(
            &format!(
                "INSERT INTO agents.own_agent_tokens (agent_id, owner_id, token_hash, scopes, issued_at, expires_at)
                 VALUES ($1::text::uuid, $2::text, $3::text, $4::text::jsonb,
                         timestamptz 'epoch' + $5::text::bigint * interval '1 millisecond',
                         timestamptz 'epoch' + $6::text::bigint * interval '1 millisecond')
                 RETURNING {}",
                columns()
            ),
            &[
                &agent_id,
                &owner_id,
                &hash,
                &scopes_json,
                &issued_ms,
                &expires_ms,
            ],
        )?;
        Ok(inserted.first().map_or_else(
            || Err(OwnError::Thrown("no token row".to_owned())),
            token_of,
        ))
    })?;
    Ok((token, secret))
}

/// `{ token, secret }`, as `own.identity.issue` answers.
pub fn issued_json(token: &Token, secret: &str) -> Json {
    Json::obj([
        ("token", token.to_json(token.issued_at)),
        ("secret", Json::str(secret)),
    ])
}

/// `revoke`: revokes the agent's live token; the next call made with it fails. With none live it refuses, and nothing
/// changes.
pub fn revoke(
    pool: &Pool,
    owner_id: &str,
    agent_id: &str,
    now: Instant,
) -> Result<Token, OwnError> {
    // The app's clock, as issue and expiry use, so a token's times never come from two clocks.
    let revoked_ms = now.0.to_string();
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "UPDATE agents.own_agent_tokens
                    SET revoked_at = timestamptz 'epoch' + $3::text::bigint * interval '1 millisecond', updated_at = now()
                  WHERE owner_id = $1::text AND agent_id = $2::text::uuid AND revoked_at IS NULL
                 RETURNING {}",
                columns()
            ),
            &[&owner_id, &agent_id, &revoked_ms],
        )?)
    })?;
    rows.first().map_or_else(
        || Err(OwnRefusal::new("agents.identity.no_live_token").into()),
        token_of,
    )
}

/// `call`: a call the agent makes with its own token, and who it acts as, or the refusal. Unknown, revoked and expired
/// tokens are refused by name; then the owner's account is read from identity, and a frozen, closed or unread owner
/// refuses.
pub fn call(pool: &Pool, secret: &str, owner: &Owner<'_>, now: Instant) -> Result<Json, OwnError> {
    if !secret.starts_with(TOKEN_PREFIX) {
        return Err(OwnRefusal::new("agents.identity.token_unknown").into());
    }
    let hash = hash_of(secret);
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            &format!(
                "SELECT {} FROM agents.own_agent_tokens WHERE token_hash = $1::text",
                columns()
            ),
            &[&hash],
        )?)
    })?;
    let Some(row) = rows.first() else {
        return Err(OwnRefusal::new("agents.identity.token_unknown").into());
    };
    let token = token_of(row)?;
    match token.state(now) {
        "revoked" => return Err(OwnRefusal::new("agents.identity.token_revoked").into()),
        "expired" => return Err(OwnRefusal::new("agents.identity.token_expired").into()),
        _ => {}
    }
    assert_owner_active(&token.owner_id, owner.accounts, owner.freeze)?;
    Ok(Json::obj([
        ("agentId", Json::str(token.agent_id.clone())),
        ("ownerId", Json::str(token.owner_id.clone())),
        (
            "scopes",
            Json::Array(token.scopes.iter().map(|s| Json::str(s.clone())).collect()),
        ),
        ("expiresAt", Json::str(token.expires_at.iso())),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `identity.test.ts`: "blank or out of range refuses; none is invented" (a fraction cannot reach here: the env
    /// reads a whole number or refuses to start).
    #[test]
    fn a_blank_or_out_of_range_lifetime_refuses() {
        for bad in [
            None,
            Some(0),
            Some(-1),
            Some(OWN_TOKEN_LIFETIME_MAX_MINUTES + 1),
        ] {
            assert_eq!(
                token_lifetime(bad).err().map(|r| r.code).as_deref(),
                Some("agents.identity.lifetime_unset")
            );
        }
        assert_eq!(token_lifetime(Some(60)), Ok(60));
    }

    #[test]
    fn base64url_is_nodes_without_padding() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(&[0xfb, 0xff, 0xfe]), "-__-");
        assert_eq!(base64url(&[0u8; 32]).len(), 43);
    }

    #[test]
    fn the_hash_is_sha256_hex() {
        assert_eq!(
            hash_of("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
