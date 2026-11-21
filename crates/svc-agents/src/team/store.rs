//! A business team's agent roles, pool and project limits (`team/store.ts`, `TeamStore`).
//!
//! Who is a member is read from svc-bank, for the business the person names, at every call and never stored, so a
//! grant, allocation or project limit of a person who left stops applying at the next read: their rows stay in the
//! tables but no view or check reads them. Nothing here is a balance and no value moves: a pool is a limit on what
//! members' runs may spend.

use postgres::{GenericClient, IsolationLevel};
use service_kit::json::Json;
use service_kit::money::{Amount, format_amount, parse_amount};
use service_kit::pg::Pool;
use service_kit::schema::js_trim;
use sha2::{Digest, Sha256};

use super::membership::{Member, Membership, TeamMembership};
use super::{TeamError, TeamFail, TeamTx, team_error};
use crate::db::{self, StoreError};

/// `AGENTS_TEAM_ROLES`, in their order.
pub const TEAM_ROLES: [&str; 5] = [
    "creator",
    "runner",
    "approver",
    "log_reader",
    "spend_reader",
];

/// `MANAGERS`: only the business's admins (signing or not) change its team's agent roles and limits.
pub const MANAGERS: [&str; 2] = ["admin", "non_signing_admin"];

/// `Team`: the business's team as svc-bank answered it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamRead {
    pub business_id: String,
    pub my_role: String,
    pub members: Vec<Member>,
}

impl TeamRead {
    pub fn can_manage(&self) -> bool {
        MANAGERS.contains(&self.my_role.as_str())
    }

    fn ids(&self) -> Vec<String> {
        self.members.iter().map(|m| m.user_id.clone()).collect()
    }
}

fn blank(v: Option<&str>) -> bool {
    v.is_none_or(|s| js_trim(s).is_empty())
}

/// `digestOf`: sha-256 hex of the parts, one per line.
pub fn digest_of(parts: &[String]) -> String {
    Sha256::digest(parts.join("\n").as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A numeric column read as text, in scaled units.
pub fn amount_of(text: &str) -> Result<Amount, StoreError> {
    parse_amount(text).map_err(|e| StoreError::new(e, None))
}

/// `canonical`.
fn canonical(text: &str) -> Result<String, StoreError> {
    Ok(format_amount(amount_of(text)?))
}

/// `positiveAmount`: a decimal above zero (or at zero when `zero_ok`), else refused with `code`.
fn positive_amount(raw: &str, code: &'static str, zero_ok: bool) -> Result<Amount, TeamError> {
    let value = parse_amount(js_trim(raw)).map_err(|_| {
        team_error(
            code,
            format!("Amount {} is not a decimal", Json::str(raw).compact()),
        )
    })?;
    if value < 0 || (!zero_ok && value == 0) {
        return Err(team_error(code, "Amount must be above zero"));
    }
    Ok(value)
}

/// `stale`.
pub fn stale() -> TeamError {
    team_error(
        "agents.team_change_stale",
        "The team changed since this was read; read it again",
    )
}

/// `lockBusiness`: one team change (or team hold) at a time per business.
pub fn lock_business(tx: &mut impl GenericClient, business_id: &str) -> Result<(), StoreError> {
    tx.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        &[&format!("agents.team:{business_id}")],
    )?;
    Ok(())
}

/// `readTeam`: the business's team, read from svc-bank; not on it or no such business, and a closed business, refuse
/// by name.
pub fn read_team(
    membership: &dyn TeamMembership,
    user_id: &str,
    business_id: &str,
) -> Result<TeamRead, TeamError> {
    match membership.read(user_id, business_id)? {
        Membership::Team {
            business_id,
            role,
            members,
        } => Ok(TeamRead {
            business_id,
            my_role: role,
            members,
        }),
        Membership::BusinessClosed => Err(team_error(
            "agents.business_closed",
            "The business is not active",
        )),
        Membership::NotMember => Err(team_error(
            "agents.team_not_member",
            "The person is not a member of that business",
        )),
    }
}

/// `TeamStore.assertMember`.
pub fn assert_member(team: &TeamRead, member_user_id: &str) -> Result<(), TeamError> {
    if team.members.iter().any(|m| m.user_id == member_user_id) {
        Ok(())
    } else {
        Err(team_error(
            "agents.role_not_member",
            "That account is not a member of this business",
        ))
    }
}

/// `effectiveRoles`: the team roles a member holds now, allowed and not denied (deny wins), in `TEAM_ROLES` order.
pub fn effective_roles(
    pool: &Pool,
    business_id: &str,
    member_user_id: &str,
) -> Result<Vec<&'static str>, StoreError> {
    let rows = db::with_client(pool, |c| {
        Ok(c.query(
            "SELECT role FROM agents.team_role_grants
              WHERE business_id = $1::text::uuid AND member_user_id = $2::text AND allow AND NOT deny",
            &[&business_id, &member_user_id],
        )?)
    })?;
    let held = rows
        .iter()
        .map(|r| r.try_get::<_, String>(0))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(TEAM_ROLES
        .into_iter()
        .filter(|role| held.iter().any(|h| h == role))
        .collect())
}

/// `requireRole`: refused `agents.team_role_required` unless the member holds `role` now.
pub fn require_role(
    pool: &Pool,
    team: &TeamRead,
    member_user_id: &str,
    role: &str,
) -> Result<(), TeamFail> {
    assert_member(team, member_user_id)?;
    if !effective_roles(pool, &team.business_id, member_user_id)?.contains(&role) {
        return Err(team_error(
            "agents.team_role_required",
            format!("This needs the {role} team role"),
        )
        .into());
    }
    Ok(())
}

/// `TeamStore`.
pub struct TeamStore<'a> {
    pub pool: &'a Pool,
    pub membership: &'a dyn TeamMembership,
    /// `AGENTS_FEE_ASSET_ID`; blank is unset.
    pub fee_asset_id: Option<&'a str>,
}

/// `setGrant`'s input.
pub struct GrantInput<'a> {
    pub actor_user_id: &'a str,
    pub business_id: &'a str,
    pub member_user_id: &'a str,
    pub role: &'a str,
    pub allow: bool,
    pub deny: bool,
    pub revision: i64,
}

/// `setPool`'s input; an allocation's amount is absent or null when unset.
pub struct PoolInput<'a> {
    pub actor_user_id: &'a str,
    pub business_id: &'a str,
    pub limit: Option<&'a str>,
    pub allocations: Vec<(&'a str, Option<&'a str>)>,
    pub revision: i64,
}

/// `createProject`'s input.
pub struct ProjectInput<'a> {
    pub actor_user_id: &'a str,
    pub business_id: &'a str,
    pub name: Option<&'a str>,
    pub limit: Option<&'a str>,
    pub member_user_ids: Vec<&'a str>,
    pub seq: i64,
}

fn grant_json(role: &str, allow: bool, deny: bool, version: i64) -> Json {
    Json::obj([
        ("role", Json::str(role)),
        ("allow", Json::Bool(allow)),
        ("deny", Json::Bool(deny)),
        ("version", Json::int(version)),
    ])
}

fn pool_json(asset_id: &str, limit: &str, allocated: &str, version: i64) -> Json {
    Json::obj([
        ("assetId", Json::str(asset_id)),
        ("limit", Json::str(limit)),
        ("allocated", Json::str(allocated)),
        ("version", Json::int(version)),
    ])
}

fn project_json(id: &str, name: &str, asset_id: &str, limit: &str, members: &[String]) -> Json {
    Json::obj([
        ("id", Json::str(id)),
        ("name", Json::str(name)),
        ("assetId", Json::str(asset_id)),
        ("limit", Json::str(limit)),
        (
            "memberUserIds",
            Json::Array(members.iter().map(|m| Json::str(m.clone())).collect()),
        ),
    ])
}

fn strings(ids: &[String]) -> Json {
    Json::Array(ids.iter().map(|s| Json::str(s.clone())).collect())
}

impl TeamStore<'_> {
    /// `team`: the business's team as the asking person may see it.
    pub fn team(&self, user_id: &str, business_id: &str) -> Result<TeamRead, TeamError> {
        read_team(self.membership, user_id, business_id)
    }

    fn manager(&self, user_id: &str, business_id: &str) -> Result<TeamRead, TeamError> {
        let team = self.team(user_id, business_id)?;
        if !team.can_manage() {
            return Err(team_error(
                "agents.role_admin_only",
                "Only the business owner or an admin changes team roles",
            ));
        }
        Ok(team)
    }

    fn fee_asset(&self) -> Result<String, TeamError> {
        if blank(self.fee_asset_id) {
            return Err(team_error(
                "agents.fee_asset_unset",
                "Agents fee asset is unset",
            ));
        }
        Ok(js_trim(self.fee_asset_id.unwrap_or_default()).to_owned())
    }

    /// `view`.
    pub fn view(&self, user_id: &str, business_id: &str) -> Result<Json, TeamFail> {
        let team = self.team(user_id, business_id)?;
        let ids = strings(&team.ids()).compact();
        let b = team.business_id.as_str();
        let out = db::with_client(self.pool, |c| {
            let grants = c.query(
                "SELECT member_user_id, role, allow, deny, version FROM agents.team_role_grants
                  WHERE business_id = $1::text::uuid
                    AND member_user_id IN (SELECT jsonb_array_elements_text($2::text::jsonb))",
                &[&b, &ids],
            )?;
            let pool = c.query(
                "SELECT asset_id, pool_limit::text, version FROM agents.team_pools WHERE business_id = $1::text::uuid",
                &[&b],
            )?;
            let allocations = if pool.is_empty() {
                Vec::new()
            } else {
                c.query(
                    "SELECT member_user_id, amount::text FROM agents.team_pool_allocations
                      WHERE business_id = $1::text::uuid
                        AND member_user_id IN (SELECT jsonb_array_elements_text($2::text::jsonb))",
                    &[&b, &ids],
                )?
            };
            let projects = c.query(
                "SELECT id::text, name, asset_id, project_limit::text, seq FROM agents.team_projects
                  WHERE business_id = $1::text::uuid ORDER BY seq",
                &[&b],
            )?;
            let project_members = if projects.is_empty() {
                Vec::new()
            } else {
                c.query(
                    "SELECT m.project_id::text, m.member_user_id FROM agents.team_project_members m
                       JOIN agents.team_projects p ON p.id = m.project_id
                      WHERE p.business_id = $1::text::uuid
                        AND m.member_user_id IN (SELECT jsonb_array_elements_text($2::text::jsonb))",
                    &[&b, &ids],
                )?
            };
            let spent = c.query(
                "SELECT t.member_user_id,
                        SUM(CASE WHEN r.status = 'held' THEN r.amount ELSE r.committed_amount END)::text AS total
                   FROM agents.spend_reservations r
                   JOIN agents.team_sessions t ON t.session_id = r.session_id AND t.member_user_id = r.user_id
                  WHERE t.business_id = $1::text::uuid AND r.status IN ('held', 'committed')
                  GROUP BY t.member_user_id",
                &[&b],
            )?;
            Ok((grants, pool, allocations, projects, project_members, spent))
        })?;
        let (grants, pool, allocations, projects, project_members, spent) = out;

        let mut used_of: Vec<(String, Amount)> = Vec::new();
        let mut used: Amount = 0;
        for r in &spent {
            let member: String = r.try_get(0)?;
            let total: String = r.try_get(1)?;
            let amount = amount_of(&total)?;
            used += amount;
            used_of.push((member, amount));
        }
        let mut allocation_of: Vec<(String, String)> = Vec::new();
        let mut allocated: Amount = 0;
        for r in &allocations {
            let member: String = r.try_get(0)?;
            let amount: String = r.try_get(1)?;
            allocated += amount_of(&amount)?;
            allocation_of.push((member, canonical(&amount)?));
        }
        let mut grant_rows: Vec<(String, String, bool, bool, i32)> = Vec::new();
        for r in &grants {
            grant_rows.push((
                r.try_get(0)?,
                r.try_get(1)?,
                r.try_get(2)?,
                r.try_get(3)?,
                r.try_get(4)?,
            ));
        }

        let members: Vec<Json> = team
            .members
            .iter()
            .map(|m| {
                let views: Vec<(&str, bool, bool, i64)> = TEAM_ROLES
                    .iter()
                    .map(|role| {
                        grant_rows
                            .iter()
                            .find(|g| g.0 == m.user_id && g.1 == *role)
                            .map_or((*role, false, false, 0), |g| {
                                (*role, g.2, g.3, i64::from(g.4))
                            })
                    })
                    .collect();
                let effective: Vec<Json> = views
                    .iter()
                    .filter(|v| v.1 && !v.2)
                    .map(|v| Json::str(v.0))
                    .collect();
                Json::obj([
                    ("userId", Json::str(m.user_id.clone())),
                    ("businessRole", Json::str(m.role.clone())),
                    (
                        "grants",
                        Json::Array(
                            views
                                .iter()
                                .map(|v| grant_json(v.0, v.1, v.2, v.3))
                                .collect(),
                        ),
                    ),
                    ("effective", Json::Array(effective)),
                    (
                        "allocation",
                        allocation_of
                            .iter()
                            .find(|a| a.0 == m.user_id)
                            .map_or(Json::Null, |a| Json::str(a.1.clone())),
                    ),
                    (
                        "used",
                        Json::str(format_amount(
                            used_of.iter().find(|u| u.0 == m.user_id).map_or(0, |u| u.1),
                        )),
                    ),
                ])
            })
            .collect();

        let pool_view = match pool.first() {
            None => Json::Null,
            Some(r) => {
                let asset: String = r.try_get(0)?;
                let limit: String = r.try_get(1)?;
                let version: i32 = r.try_get(2)?;
                pool_json(
                    &asset,
                    &canonical(&limit)?,
                    &format_amount(allocated),
                    i64::from(version),
                )
            }
        };
        let mut project_views = Vec::new();
        let mut last_seq: i64 = 0;
        for p in &projects {
            let id: String = p.try_get(0)?;
            let name: String = p.try_get(1)?;
            let asset: String = p.try_get(2)?;
            let limit: String = p.try_get(3)?;
            last_seq = i64::from(p.try_get::<_, i32>(4)?);
            let mut on = Vec::new();
            for pm in &project_members {
                if pm.try_get::<_, String>(0)? == id {
                    on.push(pm.try_get::<_, String>(1)?);
                }
            }
            project_views.push(project_json(&id, &name, &asset, &canonical(&limit)?, &on));
        }

        Ok(Json::obj([
            ("businessId", Json::str(team.business_id.clone())),
            ("myRole", Json::str(team.my_role.clone())),
            ("canManage", Json::Bool(team.can_manage())),
            ("members", Json::Array(members)),
            ("pool", pool_view),
            ("projects", Json::Array(project_views)),
            ("nextProjectSeq", Json::int(last_seq + 1)),
            ("used", Json::str(format_amount(used))),
        ]))
    }

    /// `setGrant`: one member's allow and deny for one role, as change `revision` of that grant
    /// (`agents:role:<business>:<member>:<role>:<revision>`). The same change again is a replay; any other change with
    /// a used or skipped number refuses stale.
    pub fn set_grant(&self, input: &GrantInput<'_>) -> Result<Json, TeamFail> {
        let Some(role) = TEAM_ROLES.into_iter().find(|r| *r == input.role) else {
            return Err(team_error(
                "agents.role_invalid",
                format!("Unknown team role {}", input.role),
            )
            .into());
        };
        let team = self.manager(input.actor_user_id, input.business_id)?;
        assert_member(&team, input.member_user_id)?;
        let b = team.business_id.as_str();
        let key = format!(
            "agents:role:{b}:{}:{role}:{}",
            input.member_user_id, input.revision
        );
        let digest = digest_of(&[input.allow.to_string(), input.deny.to_string()]);
        let revision =
            i32::try_from(input.revision).map_err(|e| TeamFail::Thrown(e.to_string()))?;
        let out = db::transaction_retrying(self.pool, IsolationLevel::Serializable, 5, |tx| {
            lock_business(tx, b)?;
            let rows = tx.query(
                "SELECT allow, deny, version, idempotency_key, digest FROM agents.team_role_grants
                  WHERE business_id = $1::text::uuid AND member_user_id = $2::text AND role = $3::text",
                &[&b, &input.member_user_id, &role],
            )?;
            let current = match rows.first() {
                None => 0,
                Some(r) => {
                    let (allow, deny, version, k, d): (bool, bool, i32, String, String) = (
                        r.try_get(0)?,
                        r.try_get(1)?,
                        r.try_get(2)?,
                        r.try_get(3)?,
                        r.try_get(4)?,
                    );
                    if k == key {
                        if d != digest {
                            return Err(TeamTx::from(stale()));
                        }
                        return Ok((grant_json(role, allow, deny, i64::from(version)), true));
                    }
                    version
                }
            };
            if revision != current + 1 {
                return Err(stale().into());
            }
            tx.execute(
                "INSERT INTO agents.team_role_grants
                   (business_id, member_user_id, role, allow, deny, version, idempotency_key, digest, granted_by)
                 VALUES ($1::text::uuid, $2::text, $3::text, $4, $5, $6, $7::text, $8::text, $9::text)
                 ON CONFLICT (business_id, member_user_id, role) DO UPDATE
                   SET allow = EXCLUDED.allow, deny = EXCLUDED.deny, version = EXCLUDED.version,
                       idempotency_key = EXCLUDED.idempotency_key, digest = EXCLUDED.digest,
                       granted_by = EXCLUDED.granted_by, updated_at = now()",
                &[
                    &b,
                    &input.member_user_id,
                    &role,
                    &input.allow,
                    &input.deny,
                    &revision,
                    &key,
                    &digest,
                    &input.actor_user_id,
                ],
            )?;
            Ok((
                grant_json(role, input.allow, input.deny, input.revision),
                false,
            ))
        })?;
        Ok(Json::obj([
            ("grant", out.0),
            ("replayed", Json::Bool(out.1)),
        ]))
    }

    /// `setPool`: the business pool's limit and every member's allocation, as change `revision`
    /// (`agents:pool:<business>:<n>`). A blank limit refuses; a blank allocation refuses naming each member left blank,
    /// and nothing is saved. The allocations together never pass the limit.
    pub fn set_pool(&self, input: &PoolInput<'_>) -> Result<Json, TeamFail> {
        let team = self.manager(input.actor_user_id, input.business_id)?;
        let asset_id = self.fee_asset()?;
        if blank(input.limit) {
            return Err(team_error(
                "agents.pool_limit_unset",
                "Pool limit is unset — refusing rather than inventing one",
            )
            .into());
        }
        let limit = positive_amount(
            input.limit.unwrap_or_default(),
            "agents.pool_limit_invalid",
            false,
        )?;
        let mut seen: Vec<&str> = Vec::new();
        for (member, _) in &input.allocations {
            assert_member(&team, member)?;
            if seen.contains(member) {
                return Err(team_error(
                    "agents.pool_allocation_invalid",
                    "A member is allocated twice",
                )
                .into());
            }
            seen.push(member);
        }
        let unset: Vec<String> = input
            .allocations
            .iter()
            .filter(|(_, a)| blank(*a))
            .map(|(m, _)| (*m).to_owned())
            .collect();
        if !unset.is_empty() {
            return Ok(Json::obj([
                ("ok", Json::Bool(false)),
                ("code", Json::str("agents.pool_allocation_unset")),
                ("memberUserIds", strings(&unset)),
            ]));
        }
        let mut allocations: Vec<(&str, Amount)> = Vec::new();
        for (member, amount) in &input.allocations {
            let amount = positive_amount(
                amount.unwrap_or_default(),
                "agents.pool_allocation_invalid",
                true,
            )?;
            if amount > limit {
                return Err(team_error(
                    "agents.pool_allocation_invalid",
                    "An allocation is above the pool limit",
                )
                .into());
            }
            allocations.push((member, amount));
        }
        allocations.sort_by(|x, y| x.0.encode_utf16().cmp(y.0.encode_utf16()));
        let allocated: Amount = allocations.iter().map(|a| a.1).sum();
        if allocated > limit {
            return Err(team_error(
                "agents.pool_over_limit",
                "The allocations together pass the pool limit",
            )
            .into());
        }
        let b = team.business_id.as_str();
        let key = format!("agents:pool:{b}:{}", input.revision);
        let mut parts = vec![asset_id.clone(), format_amount(limit)];
        parts.extend(
            allocations
                .iter()
                .map(|(m, a)| format!("{m}={}", format_amount(*a))),
        );
        let digest = digest_of(&parts);
        let revision =
            i32::try_from(input.revision).map_err(|e| TeamFail::Thrown(e.to_string()))?;
        let pool = pool_json(
            &asset_id,
            &format_amount(limit),
            &format_amount(allocated),
            input.revision,
        );
        let replayed = db::transaction_retrying(
            self.pool,
            IsolationLevel::Serializable,
            5,
            |tx| {
                lock_business(tx, b)?;
                let rows = tx.query(
                "SELECT version, idempotency_key, digest FROM agents.team_pools WHERE business_id = $1::text::uuid",
                &[&b],
            )?;
                let mut current = 0;
                if let Some(r) = rows.first() {
                    let (version, k, d): (i32, String, String) =
                        (r.try_get(0)?, r.try_get(1)?, r.try_get(2)?);
                    if k == key {
                        if d != digest {
                            return Err(TeamTx::from(stale()));
                        }
                        return Ok(true);
                    }
                    current = version;
                }
                if revision != current + 1 {
                    return Err(stale().into());
                }
                tx.execute(
                "INSERT INTO agents.team_pools (business_id, asset_id, pool_limit, version, idempotency_key, digest, set_by)
                 VALUES ($1::text::uuid, $2::text, $3::text::numeric, $4, $5::text, $6::text, $7::text)
                 ON CONFLICT (business_id) DO UPDATE
                   SET asset_id = EXCLUDED.asset_id, pool_limit = EXCLUDED.pool_limit, version = EXCLUDED.version,
                       idempotency_key = EXCLUDED.idempotency_key, digest = EXCLUDED.digest, set_by = EXCLUDED.set_by,
                       updated_at = now()",
                &[
                    &b,
                    &asset_id,
                    &format_amount(limit),
                    &revision,
                    &key,
                    &digest,
                    &input.actor_user_id,
                ],
            )?;
                tx.execute(
                    "DELETE FROM agents.team_pool_allocations WHERE business_id = $1::text::uuid",
                    &[&b],
                )?;
                for (member, amount) in &allocations {
                    tx.execute(
                    "INSERT INTO agents.team_pool_allocations (business_id, member_user_id, amount)
                     VALUES ($1::text::uuid, $2::text, $3::text::numeric)",
                    &[&b, member, &format_amount(*amount)],
                )?;
                }
                Ok(false)
            },
        )?;
        Ok(Json::obj([
            ("ok", Json::Bool(true)),
            ("pool", pool),
            ("replayed", Json::Bool(replayed)),
        ]))
    }

    /// `createProject`: the business's project number `seq` (`agents:project:<business>:<seq>`) with a limit for the
    /// members named.
    pub fn create_project(&self, input: &ProjectInput<'_>) -> Result<Json, TeamFail> {
        let team = self.manager(input.actor_user_id, input.business_id)?;
        let asset_id = self.fee_asset()?;
        if blank(input.name) {
            return Err(team_error("agents.project_name_unset", "Project name is unset").into());
        }
        if blank(input.limit) {
            return Err(team_error(
                "agents.project_limit_unset",
                "Project limit is unset — refusing rather than inventing one",
            )
            .into());
        }
        let name = js_trim(input.name.unwrap_or_default()).to_owned();
        let limit = positive_amount(
            input.limit.unwrap_or_default(),
            "agents.project_limit_invalid",
            false,
        )?;
        // `[...new Set(ids)].sort()`: JavaScript sorts by UTF-16 code units.
        let mut members: Vec<String> = Vec::new();
        for m in &input.member_user_ids {
            if !members.iter().any(|x| x == m) {
                members.push((*m).to_owned());
            }
        }
        members.sort_by(|x, y| x.encode_utf16().cmp(y.encode_utf16()));
        for m in &members {
            assert_member(&team, m)?;
        }
        let b = team.business_id.as_str();
        let key = format!("agents:project:{b}:{}", input.seq);
        let mut parts = vec![name.clone(), asset_id.clone(), format_amount(limit)];
        parts.extend(members.iter().cloned());
        let digest = digest_of(&parts);
        let seq = i32::try_from(input.seq).map_err(|e| TeamFail::Thrown(e.to_string()))?;
        let limit_text = format_amount(limit);
        let (id, replayed) = db::transaction_retrying(
            self.pool,
            IsolationLevel::Serializable,
            5,
            |tx| {
                lock_business(tx, b)?;
                let same = tx.query(
                    "SELECT id::text, digest FROM agents.team_projects WHERE idempotency_key = $1::text",
                    &[&key],
                )?;
                if let Some(r) = same.first() {
                    let (id, d): (String, String) = (r.try_get(0)?, r.try_get(1)?);
                    if d != digest {
                        return Err(TeamTx::from(stale()));
                    }
                    return Ok((id, true));
                }
                let last: i32 = tx
                    .query_one(
                        "SELECT COALESCE(MAX(seq), 0)::int FROM agents.team_projects WHERE business_id = $1::text::uuid",
                        &[&b],
                    )?
                    .try_get(0)?;
                if seq != last + 1 {
                    return Err(stale().into());
                }
                let id: String = tx
                    .query_one(
                        "INSERT INTO agents.team_projects
                           (id, business_id, name, asset_id, project_limit, seq, idempotency_key, digest, created_by)
                         VALUES (gen_random_uuid(), $1::text::uuid, $2::text, $3::text, $4::text::numeric, $5, $6::text,
                                 $7::text, $8::text)
                         RETURNING id::text",
                        &[
                            &b,
                            &name,
                            &asset_id,
                            &limit_text,
                            &seq,
                            &key,
                            &digest,
                            &input.actor_user_id,
                        ],
                    )?
                    .try_get(0)?;
                for m in &members {
                    tx.execute(
                        "INSERT INTO agents.team_project_members (project_id, member_user_id)
                         VALUES ($1::text::uuid, $2::text)",
                        &[&id, m],
                    )?;
                }
                Ok((id, false))
            },
        )?;
        Ok(Json::obj([
            (
                "project",
                project_json(&id, &name, &asset_id, &limit_text, &members),
            ),
            ("replayed", Json::Bool(replayed)),
        ]))
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "a test")]
    use super::*;

    #[test]
    fn an_amount_is_a_decimal_above_zero_or_refused_by_its_code() {
        assert_eq!(
            positive_amount(" 10.50 ", "agents.pool_limit_invalid", false).unwrap(),
            parse_amount("10.5").unwrap()
        );
        assert_eq!(
            positive_amount("0", "agents.pool_limit_invalid", false)
                .unwrap_err()
                .code,
            "agents.pool_limit_invalid"
        );
        assert_eq!(
            positive_amount("0", "agents.pool_allocation_invalid", true).unwrap(),
            0
        );
        assert_eq!(
            positive_amount("ten", "agents.project_limit_invalid", false)
                .unwrap_err()
                .message,
            "Amount \"ten\" is not a decimal"
        );
    }

    #[test]
    fn the_digest_is_sha256_hex_of_the_parts_one_per_line() {
        assert_eq!(
            digest_of(&["true".to_owned(), "false".to_owned()]),
            "de69a10a62f053d979ca8ebd39eb5cac5963eec6d9bd03dc7d6cd348425f33d1"
        );
    }
}
