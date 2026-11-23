//! `POST /internal/agents/team-membership` (`agents/team-membership.ts`): svc-agents' read of a business team for its
//! team roles and approvals. The door (`door::rest`) has already proved the caller is svc-agents and the body is in
//! shape; this answers from `bank.business_accounts` and `bank.business_members` only, and only to a member. A failed
//! read is 503 `bank.team_membership_unavailable`, never an empty team; a team over the cap is refused whole.

use service_kit::json::Json;
use service_kit::schema::Value;
use service_kit::server::Response;

use super::policy::ROLES;
use crate::db::Store;
use crate::door::rest::reply;
use crate::errors::Refusal;
use crate::spaces::space::{pg, with};

/// `TEAM_MEMBERSHIP_MAX`.
pub const MAX: usize = 200;

/// Why the read gave no answer.
#[derive(Debug)]
pub enum TeamError {
    /// `TeamMembershipIncomplete`: more members than one answer holds.
    Incomplete,
    /// The database failed.
    Failed(Refusal),
}

fn uuid_text(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// `teamMembershipFor`: the team as the asking person may see it; ids compared in lower case.
pub fn read(store: &Store, raw_user: &str, raw_business: &str) -> Result<Json, TeamError> {
    let user = raw_user.to_lowercase();
    let business = raw_business.to_lowercase();
    let rows = with(store, |c| {
        let rows = c
            .query(
                "SELECT a.status, m.user_id, m.role::text, (m.user_id = $1) \
                   FROM bank.business_accounts a \
                   JOIN bank.business_members m ON m.account_id = a.id \
                  WHERE a.id = $2::text::uuid \
                    AND EXISTS (SELECT 1 FROM bank.business_members me WHERE me.account_id = a.id AND me.user_id = $1) \
                  ORDER BY m.created_at, m.user_id \
                  LIMIT 201",
                &[&user, &business],
            )
            .map_err(|e| pg(&e))?;
        rows.iter()
            .map(|r| {
                Ok((
                    r.try_get::<_, String>(0).map_err(|e| pg(&e))?,
                    r.try_get::<_, String>(1).map_err(|e| pg(&e))?,
                    r.try_get::<_, String>(2).map_err(|e| pg(&e))?,
                    r.try_get::<_, bool>(3).map_err(|e| pg(&e))?,
                ))
            })
            .collect::<Result<Vec<_>, Refusal>>()
    })
    .map_err(TeamError::Failed)?;
    if rows.len() > MAX {
        return Err(TeamError::Incomplete);
    }
    let refused =
        |reason: &str| Json::obj([("ok", Json::Bool(false)), ("reason", Json::str(reason))]);
    let Some(me) = rows.iter().find(|r| r.3) else {
        return Ok(refused("not_member"));
    };
    if me.0 != "active" {
        return Ok(refused("business_closed"));
    }
    Ok(Json::obj([
        ("ok", Json::Bool(true)),
        ("businessId", Json::str(business.clone())),
        ("role", Json::str(me.2.clone())),
        (
            "members",
            Json::Array(
                rows.iter()
                    .map(|r| {
                        Json::obj([
                            ("userId", Json::str(r.1.clone())),
                            ("role", Json::str(r.2.clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
    ]))
}

/// `agentsTeamMembershipResponseSchema.safeParse`: the answer as the contract returns it (member ids trimmed), or none
/// when it breaks the contract.
pub fn checked(answer: &Json) -> Option<Json> {
    match answer.get("ok") {
        Some(Json::Bool(false)) => {
            let reason = answer.get("reason")?;
            matches!(reason, Json::String(r) if r == "not_member" || r == "business_closed")
                .then(|| answer.clone())
        }
        Some(Json::Bool(true)) => {
            let Some(Json::String(id)) = answer.get("businessId") else {
                return None;
            };
            let role_ok = |j: Option<&Json>| matches!(j, Some(Json::String(r)) if ROLES.contains(&r.as_str()));
            if !uuid_text(id) || !role_ok(answer.get("role")) {
                return None;
            }
            let Some(Json::Array(members)) = answer.get("members") else {
                return None;
            };
            if members.is_empty() || members.len() > MAX {
                return None;
            }
            let mut out = Vec::new();
            for m in members {
                let Some(Json::String(u)) = m.get("userId") else {
                    return None;
                };
                let u = service_kit::money::js_trim(u);
                if u.is_empty() || u.encode_utf16().count() > 128 || !role_ok(m.get("role")) {
                    return None;
                }
                out.push(Json::obj([
                    ("userId", Json::str(u)),
                    ("role", m.get("role")?.clone()),
                ]));
            }
            Some(Json::obj([
                ("ok", Json::Bool(true)),
                ("businessId", Json::str(id.clone())),
                ("role", answer.get("role")?.clone()),
                ("members", Json::Array(out)),
            ]))
        }
        _ => None,
    }
}

/// The door's answer for a body already in shape.
pub fn answer(store: &Store, body: &Value) -> Response {
    let user = body.get("userId").as_str().unwrap_or_default();
    let business = body.get("businessId").as_str().unwrap_or_default();
    match read(store, user, business) {
        Ok(a) => match checked(&a) {
            Some(ok) => Response {
                status: 200,
                body: ok.compact(),
            },
            None => unavailable(),
        },
        Err(TeamError::Incomplete) => reply(
            503,
            "business team is too large to answer whole",
            "bank.team_membership_incomplete",
        ),
        // Never an empty team and never the database's own words.
        Err(TeamError::Failed(_)) => unavailable(),
    }
}

fn unavailable() -> Response {
    reply(
        503,
        "business team could not be read",
        "bank.team_membership_unavailable",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_the_same_roles_as_svc_bank() {
        assert_eq!(ROLES.len(), 8);
    }

    #[test]
    fn an_answer_that_breaks_the_contract_is_none() {
        let good = Json::obj([
            ("ok", Json::Bool(true)),
            (
                "businessId",
                Json::str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
            ),
            ("role", Json::str("admin")),
            (
                "members",
                Json::Array(vec![Json::obj([
                    ("userId", Json::str(" u1 ")),
                    ("role", Json::str("admin")),
                ])]),
            ),
        ]);
        let c = checked(&good).unwrap_or(Json::Null);
        let Some(Json::Array(members)) = c.get("members") else {
            panic!("no members");
        };
        assert_eq!(
            members.first().and_then(|m| m.get("userId")),
            Some(&Json::str("u1"))
        );
        let bad = Json::obj([
            ("ok", Json::Bool(true)),
            ("businessId", Json::str("x")),
            ("role", Json::str("admin")),
            ("members", Json::Array(vec![])),
        ]);
        assert!(checked(&bad).is_none());
        assert!(
            checked(&Json::obj([
                ("ok", Json::Bool(false)),
                ("reason", Json::str("other"))
            ]))
            .is_none()
        );
    }
}
