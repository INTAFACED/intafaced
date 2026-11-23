//! AC-roles-01 (J-academy-18): course team roles, custom roles and the one server-side permission check per course
//! (`team/course-team.ts`).
//!
//! The founder scopes stay the outer gate; inside it, a founder who holds no role on a course (and none academy-wide)
//! keeps the founder's full reach there, and one who holds roles may do only what those roles permit. A switched-off
//! custom role keeps its holders' rows and permits nothing. Every role change is proposed by one founder and takes
//! effect only when a different founder confirms it; both check that the role permits nothing they do not hold
//! themselves (`academy.role_escalation`). The number of custom roles is an owner value with no default
//! (`ACADEMY_CUSTOM_ROLE_LIMIT`). No money moves: `refund.request` is a name in a list.

use postgres::GenericClient;
use service_kit::json::Json;
use service_kit::time::Instant;

use super::Db;
use super::{
    academy, at, at_opt, col, first, int, iso, iso_opt, js_trim, ms, rows, serializable, str_opt,
    strs,
};
use crate::db::with_client;
use crate::errors::Refusal;

/// The scope of an academy-wide role. A course's scope is its id.
pub const ACADEMY_SCOPE: &str = "academy";

/// `ACADEMY_PERMISSIONS`, in order.
pub const PERMISSIONS: [&str; 15] = [
    "content.edit",
    "content.publish",
    "content.delete",
    "grade",
    "enrol",
    "reports",
    "certificates",
    "comments",
    "coaching",
    "refund.request",
    "financial.view",
    "discussion.moderate",
    "discussion.endorse",
    "discussion.assign",
    "roles.assign",
];

/// `ACADEMY_BUILTIN_ROLES`, in order.
pub const BUILTIN_ROLES: [&str; 9] = [
    "admin",
    "instructor",
    "author",
    "staff",
    "limited_staff",
    "data_researcher",
    "discussion_admin",
    "moderator",
    "community_ta",
];

/// `ACADEMY_DISCUSSION_ROLES`.
const DISCUSSION_ROLES: [&str; 3] = ["discussion_admin", "moderator", "community_ta"];

/// `ACADEMY_BUILTIN_ROLE_PERMISSIONS`.
pub fn builtin_permissions(role: &str) -> Option<&'static [&'static str]> {
    Some(match role {
        "admin" => &PERMISSIONS,
        "instructor" => &[
            "content.edit",
            "content.publish",
            "content.delete",
            "grade",
            "enrol",
            "reports",
            "certificates",
            "comments",
            "coaching",
            "discussion.moderate",
            "discussion.endorse",
            "discussion.assign",
            "roles.assign",
        ],
        "author" => &[
            "content.edit",
            "content.publish",
            "content.delete",
            "reports",
            "discussion.assign",
        ],
        "staff" => &[
            "content.edit",
            "grade",
            "enrol",
            "reports",
            "comments",
            "coaching",
            "discussion.moderate",
            "discussion.endorse",
        ],
        "limited_staff" | "data_researcher" => &["reports"],
        "discussion_admin" => &[
            "discussion.moderate",
            "discussion.endorse",
            "discussion.assign",
        ],
        "moderator" => &["discussion.moderate", "discussion.endorse"],
        "community_ta" => &["discussion.endorse"],
        _ => return None,
    })
}

fn is_builtin(role: &str) -> bool {
    BUILTIN_ROLES.contains(&role)
}

fn scope_of(course_id: Option<&str>) -> &str {
    course_id.unwrap_or(ACADEMY_SCOPE)
}

/// Who is asking: their account and whether their session may change anything (`admin:write`).
#[derive(Debug, Clone, Copy)]
pub struct Caller<'a> {
    pub user_id: &'a str,
    pub may_write: bool,
}

fn require_reason(reason: &str) -> Result<String, Refusal> {
    let trimmed = js_trim(reason);
    if trimmed.is_empty() {
        return Err(academy(
            "academy.reason_required",
            "academy.reason_required a role change needs a reason",
        ));
    }
    Ok(trimmed.to_owned())
}

/// A role's permissions now.
struct RolePermissions {
    name: String,
    permissions: Vec<String>,
    active: bool,
}

fn own(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

/// A built-in role's fixed list, a custom role's list while it is on (its stored list and switch), else not found.
fn role_permissions<C: GenericClient>(db: &mut C, role: &str) -> Result<RolePermissions, Refusal> {
    if let Some(p) = builtin_permissions(role) {
        return Ok(RolePermissions {
            name: role.to_owned(),
            permissions: own(p),
            active: true,
        });
    }
    let row = match role.strip_prefix("custom:") {
        Some(id) => first(
            db,
            "SELECT id::text, name, permissions, active FROM academy.custom_roles WHERE id = $1::text::uuid",
            &[&id],
        )?,
        None => None,
    };
    let row = row.ok_or_else(|| {
        academy(
            "academy.role_not_found",
            format!("academy.role_not_found role={role}"),
        )
    })?;
    Ok(RolePermissions {
        name: col(&row, 1)?,
        permissions: col(&row, 2)?,
        active: col(&row, 3)?,
    })
}

/// What an account may do on a course.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Permissions {
    pub narrowed: bool,
    pub permissions: Vec<String>,
}

/// Every permission while they hold no role on the course or academy-wide (the founder's reach), otherwise the union
/// of what their roles permit now, in `ACADEMY_PERMISSIONS` order.
pub fn permissions_of<C: GenericClient>(
    db: &mut C,
    account_id: &str,
    course_id: Option<&str>,
) -> Result<Permissions, Refusal> {
    let held = rows(
        db,
        "SELECT scope, role, since FROM academy.team_roles WHERE account_id = $1::text::uuid AND scope IN ($2::text, $3::text)",
        &[&account_id, &scope_of(course_id), &ACADEMY_SCOPE],
    )?;
    let mut roles = Vec::new();
    for r in &held {
        let role: String = col(r, 1)?;
        roles.push(role_permissions(db, &role)?);
    }
    if roles.is_empty() {
        return Ok(Permissions {
            narrowed: false,
            permissions: own(&PERMISSIONS),
        });
    }
    let on: Vec<&String> = roles
        .iter()
        .filter(|r| r.active)
        .flat_map(|r| r.permissions.iter())
        .collect();
    Ok(Permissions {
        narrowed: true,
        permissions: PERMISSIONS
            .iter()
            .filter(|p| on.iter().any(|o| o.as_str() == **p))
            .map(|p| (*p).to_owned())
            .collect(),
    })
}

/// Refuses `academy.permission_denied` unless the caller's roles on the course permit `permission`.
pub fn require<C: GenericClient>(
    db: &mut C,
    account_id: &str,
    course_id: Option<&str>,
    permission: &str,
) -> Result<(), Refusal> {
    let p = permissions_of(db, account_id, course_id)?;
    if !p.permissions.iter().any(|x| x == permission) {
        return Err(academy(
            "academy.permission_denied",
            format!(
                "academy.permission_denied your role on this course does not permit {permission}"
            ),
        ));
    }
    Ok(())
}

/// The course a course item belongs to, for a check on an item-level change.
pub fn course_of_item(pool: &Db<'_>, item_id: &str) -> Result<String, Refusal> {
    with_client(pool.get()?, |db| {
        let row = first(
            db,
            "SELECT course_id::text FROM academy.course_items WHERE id = $1::text::uuid",
            &[&item_id],
        )?
        .ok_or_else(|| {
            academy(
                "academy.outline_item_unknown",
                "no outline item with that id",
            )
        })?;
        col(&row, 0)
    })
}

/// Refuses unless `giver` may give or take `role` on the course: the right to assign, and nothing above their own.
fn assert_may_give<C: GenericClient>(
    db: &mut C,
    giver: &str,
    course_id: Option<&str>,
    role: &str,
) -> Result<(), Refusal> {
    let target = role_permissions(db, role)?;
    let mine = permissions_of(db, giver, course_id)?;
    let above: Vec<&str> = target
        .permissions
        .iter()
        .filter(|p| !mine.permissions.contains(p))
        .map(String::as_str)
        .collect();
    if !above.is_empty() {
        return Err(academy(
            "academy.role_escalation",
            format!(
                "academy.role_escalation {} permits {}, which you do not hold here",
                target.name,
                above.join(", ")
            ),
        ));
    }
    let discussion_role = is_builtin(role) && DISCUSSION_ROLES.contains(&role);
    let has = |p: &str| mine.permissions.iter().any(|x| x == p);
    if !has("roles.assign") && !(discussion_role && has("discussion.assign")) {
        return Err(academy(
            "academy.permission_denied",
            "academy.permission_denied your role here does not give or take roles",
        ));
    }
    Ok(())
}

fn assert_course<C: GenericClient>(db: &mut C, course_id: Option<&str>) -> Result<(), Refusal> {
    let Some(id) = course_id else {
        return Ok(());
    };
    if first(
        db,
        "SELECT 1 FROM academy.courses WHERE id = $1::text::uuid",
        &[&id],
    )?
    .is_none()
    {
        return Err(academy(
            "academy.course_not_found",
            format!("academy.course_not_found course={id}"),
        ));
    }
    Ok(())
}

fn change_columns() -> String {
    format!(
        "id::text, scope, kind, account_id::text, role, reason, proposed_by::text, {}, confirmed_by::text, {}",
        ms("proposed_at"),
        ms("confirmed_at")
    )
}

struct ChangeRow {
    id: String,
    scope: String,
    kind: String,
    account_id: String,
    role: String,
    reason: String,
    proposed_by: String,
    proposed_at: Instant,
    confirmed_by: Option<String>,
    confirmed_at: Option<Instant>,
}

fn change_row(r: &postgres::Row) -> Result<ChangeRow, Refusal> {
    Ok(ChangeRow {
        id: col(r, 0)?,
        scope: col(r, 1)?,
        kind: col(r, 2)?,
        account_id: col(r, 3)?,
        role: col(r, 4)?,
        reason: col(r, 5)?,
        proposed_by: col(r, 6)?,
        proposed_at: at(r, 7)?,
        confirmed_by: col(r, 8)?,
        confirmed_at: at_opt(r, 9)?,
    })
}

/// `changeView`: a role that no longer reads (`.catch`) shows its reference as its name.
fn change_view<C: GenericClient>(db: &mut C, row: &ChangeRow) -> Json {
    let name = role_permissions(db, &row.role).map_or_else(|_| row.role.clone(), |r| r.name);
    Json::obj([
        ("id", Json::str(row.id.clone())),
        ("kind", Json::str(row.kind.clone())),
        ("accountId", Json::str(row.account_id.clone())),
        ("role", Json::str(row.role.clone())),
        ("roleName", Json::str(name)),
        ("reason", Json::str(row.reason.clone())),
        ("proposedBy", Json::str(row.proposed_by.clone())),
        ("proposedAt", iso(row.proposed_at)),
        (
            "state",
            Json::str(if row.confirmed_by.is_some() {
                "confirmed"
            } else {
                "pending"
            }),
        ),
        ("confirmedBy", str_opt(row.confirmed_by.clone())),
        ("confirmedAt", iso_opt(row.confirmed_at)),
    ])
}

/// A proposed role change.
pub struct Propose<'a> {
    pub course_id: Option<&'a str>,
    pub account_id: &'a str,
    pub role: &'a str,
    pub kind: &'a str,
    pub reason: &'a str,
    pub request_id: &'a str,
    pub caller: Caller<'a>,
    pub now: Instant,
}

/// One founder proposes giving or taking a role. It waits for a second founder. A retry answers with the same change.
pub fn propose(pool: &Db<'_>, input: &Propose<'_>) -> Result<Json, Refusal> {
    let reason = require_reason(input.reason)?;
    serializable(pool.get()?, |tx| {
        assert_course(tx, input.course_id)?;
        assert_may_give(tx, input.caller.user_id, input.course_id, input.role)?;
        let scope = scope_of(input.course_id);
        let key = format!(
            "{}:{scope}:{}:{}:{}",
            if input.kind == "assign" {
                "role"
            } else {
                "unrole"
            },
            input.account_id,
            input.role,
            input.request_id
        );
        super::exec(
            tx,
            "INSERT INTO academy.team_changes (scope, kind, account_id, role, reason, request_key, proposed_by, proposed_at)
             VALUES ($1::text, $2::text, $3::text::uuid, $4::text, $5::text, $6::text, $7::text::uuid, $8::text::timestamptz)
             ON CONFLICT (request_key) DO NOTHING",
            &[
                &scope,
                &input.kind,
                &input.account_id,
                &input.role,
                &reason,
                &key,
                &input.caller.user_id,
                &input.now.iso(),
            ],
        )?;
        let row = first(
            tx,
            &format!(
                "SELECT {} FROM academy.team_changes WHERE request_key = $1::text",
                change_columns()
            ),
            &[&key],
        )?
        .ok_or_else(undefined)?;
        let row = change_row(&row)?;
        Ok(change_view(tx, &row))
    })
}

fn undefined() -> Refusal {
    Refusal::Internal {
        message: "Cannot read properties of undefined (reading 'role')".to_owned(),
        code: None,
    }
}

/// A different founder confirms a waiting change; it takes effect now. Confirming a confirmed change changes nothing.
pub fn confirm(
    pool: &Db<'_>,
    change_id: &str,
    caller: Caller<'_>,
    now: Instant,
) -> Result<Json, Refusal> {
    serializable(pool.get()?, |tx| {
        let row = first(
            tx,
            &format!(
                "SELECT {} FROM academy.team_changes WHERE id = $1::text::uuid FOR UPDATE",
                change_columns()
            ),
            &[&change_id],
        )?
        .ok_or_else(|| {
            academy(
                "academy.role_not_found",
                format!("academy.role_not_found change={change_id}"),
            )
        })?;
        let row = change_row(&row)?;
        if row.confirmed_by.is_some() {
            return Ok(change_view(tx, &row));
        }
        if row.proposed_by == caller.user_id {
            return Err(academy(
                "academy.second_founder_required",
                "academy.second_founder_required a role change is confirmed by a founder other than the one who proposed it",
            ));
        }
        let course_id = (row.scope != ACADEMY_SCOPE).then_some(row.scope.as_str());
        assert_may_give(tx, caller.user_id, course_id, &row.role)?;
        if row.kind == "assign" {
            super::exec(
                tx,
                "INSERT INTO academy.team_roles (scope, account_id, role, change_id, since)
                 VALUES ($1::text, $2::text::uuid, $3::text, $4::text::uuid, $5::text::timestamptz)
                 ON CONFLICT (scope, account_id, role) DO NOTHING",
                &[&row.scope, &row.account_id, &row.role, &row.id, &now.iso()],
            )?;
        } else {
            super::exec(
                tx,
                "DELETE FROM academy.team_roles WHERE scope = $1::text AND account_id = $2::text::uuid AND role = $3::text",
                &[&row.scope, &row.account_id, &row.role],
            )?;
        }
        let done = first(
            tx,
            &format!(
                "UPDATE academy.team_changes SET confirmed_by = $1::text::uuid, confirmed_at = $2::text::timestamptz
                  WHERE id = $3::text::uuid RETURNING {}",
                change_columns()
            ),
            &[&caller.user_id, &now.iso(), &row.id],
        )?
        .ok_or_else(undefined)?;
        let done = change_row(&done)?;
        Ok(change_view(tx, &done))
    })
}

/// A course's team (or the academy-wide team): holders, every change newest first, and what the caller may do here.
pub fn team(pool: &Db<'_>, course_id: Option<&str>, caller: Caller<'_>) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        assert_course(db, course_id)?;
        let scope = scope_of(course_id);
        let holders = rows(
            db,
            &format!(
                "SELECT account_id::text, role, {} FROM academy.team_roles WHERE scope = $1::text ORDER BY since, account_id, role",
                ms("since")
            ),
            &[&scope],
        )?;
        let changes = rows(
            db,
            &format!(
                "SELECT {} FROM academy.team_changes WHERE scope = $1::text ORDER BY proposed_at DESC, id LIMIT 200",
                change_columns()
            ),
            &[&scope],
        )?;
        let mine = permissions_of(db, caller.user_id, course_id)?;
        let mut holder_list = Vec::new();
        for h in &holders {
            let role: String = col(h, 1)?;
            let r = role_permissions(db, &role)?;
            holder_list.push(Json::obj([
                ("accountId", Json::str(col::<String>(h, 0)?)),
                ("role", Json::str(role)),
                ("roleName", Json::str(r.name)),
                ("active", Json::Bool(r.active)),
                ("since", iso(at(h, 2)?)),
            ]));
        }
        let mut change_list = Vec::new();
        for c in &changes {
            let c = change_row(c)?;
            change_list.push(change_view(db, &c));
        }
        Ok(Json::obj([
            ("courseId", str_opt(course_id.map(str::to_owned))),
            ("holders", Json::Array(holder_list)),
            ("changes", Json::Array(change_list)),
            (
                "yourPermissions",
                strs(if caller.may_write {
                    &mine.permissions
                } else {
                    &[]
                }),
            ),
            ("narrowed", Json::Bool(mine.narrowed)),
        ]))
    })
}

fn role_json(
    r#ref: String,
    name: String,
    kind: &str,
    permissions: &[String],
    active: bool,
    holders: i32,
) -> Json {
    Json::obj([
        ("ref", Json::str(r#ref)),
        ("name", Json::str(name)),
        ("kind", Json::str(kind)),
        ("permissions", strs(permissions)),
        ("active", Json::Bool(active)),
        ("holders", int(holders)),
    ])
}

/// Every role with its permissions and how many hold it, the permission list, and the owner's custom role limit.
pub fn roles(pool: &Db<'_>, custom_role_limit: Option<i64>) -> Result<Json, Refusal> {
    with_client(pool.get()?, |db| {
        let counts = rows(
            db,
            "SELECT role, count(*)::int AS holders FROM academy.team_roles GROUP BY role",
            &[],
        )?;
        let mut held: Vec<(String, i32)> = Vec::new();
        for c in &counts {
            held.push((col(c, 0)?, col(c, 1)?));
        }
        let holders_of = |r: &str| held.iter().find(|(x, _)| x == r).map_or(0, |(_, n)| *n);
        let custom = rows(
            db,
            "SELECT id::text, name, permissions, active FROM academy.custom_roles ORDER BY created_at, id",
            &[],
        )?;
        let mut list = Vec::new();
        for name in BUILTIN_ROLES {
            list.push(role_json(
                name.to_owned(),
                name.to_owned(),
                "builtin",
                &own(builtin_permissions(name).unwrap_or_default()),
                true,
                holders_of(name),
            ));
        }
        for r in &custom {
            let id: String = col(r, 0)?;
            let r#ref = format!("custom:{id}");
            let holders = holders_of(&r#ref);
            list.push(role_json(
                r#ref,
                col(r, 1)?,
                "custom",
                &col::<Vec<String>>(r, 2)?,
                col(r, 3)?,
                holders,
            ));
        }
        Ok(Json::obj([
            ("roles", Json::Array(list)),
            ("permissions", strs(&own(&PERMISSIONS))),
            (
                "customRoleLimit",
                custom_role_limit.map_or(Json::Null, Json::int),
            ),
            (
                "customRoles",
                Json::int(i64::try_from(custom.len()).unwrap_or(i64::MAX)),
            ),
        ]))
    })
}

fn custom_view<C: GenericClient>(db: &mut C, row: &postgres::Row) -> Result<Json, Refusal> {
    let id: String = col(row, 0)?;
    let r#ref = format!("custom:{id}");
    let count = first(
        db,
        "SELECT count(*)::int AS n FROM academy.team_roles WHERE role = $1::text",
        &[&r#ref],
    )?;
    let holders: i32 = match &count {
        Some(r) => col(r, 0)?,
        None => 0,
    };
    Ok(role_json(
        r#ref,
        col(row, 1)?,
        "custom",
        &col::<Vec<String>>(row, 2)?,
        col(row, 3)?,
        holders,
    ))
}

/// A new custom role.
pub struct SaveCustomRole<'a> {
    pub name: &'a str,
    pub permissions: Vec<String>,
    pub reason: &'a str,
    pub request_id: &'a str,
    pub caller: Caller<'a>,
    pub now: Instant,
}

/// A new custom role, inside the owner's limit, permitting nothing the founder making it does not hold academy-wide.
pub fn save_custom_role(
    pool: &Db<'_>,
    limit: Option<i64>,
    input: &SaveCustomRole<'_>,
) -> Result<Json, Refusal> {
    let reason = require_reason(input.reason)?;
    let Some(limit) = limit else {
        return Err(academy(
            "academy.role_limit_unset",
            "academy.role_limit_unset the owner has not set how many custom roles there may be",
        ));
    };
    serializable(pool.get()?, |tx| {
        super::exec(
            tx,
            "SELECT pg_advisory_xact_lock(hashtext('academy.custom_roles'))",
            &[],
        )?;
        let key = format!("custom-role:{}:{}", input.caller.user_id, input.request_id);
        if let Some(again) = first(
            tx,
            "SELECT id::text, name, permissions, active FROM academy.custom_roles WHERE request_key = $1::text",
            &[&key],
        )? {
            return custom_view(tx, &again);
        }
        let mine = permissions_of(tx, input.caller.user_id, None)?;
        let above: Vec<&str> = input
            .permissions
            .iter()
            .filter(|p| !mine.permissions.contains(p))
            .map(String::as_str)
            .collect();
        if !above.is_empty() {
            return Err(academy(
                "academy.role_escalation",
                format!(
                    "academy.role_escalation the role permits {}, which you do not hold",
                    above.join(", ")
                ),
            ));
        }
        let count = first(
            tx,
            "SELECT count(*)::int AS n FROM academy.custom_roles",
            &[],
        )?;
        let n: i32 = match &count {
            Some(r) => col(r, 0)?,
            None => 0,
        };
        if i64::from(n) >= limit {
            return Err(academy(
                "academy.role_limit_reached",
                format!("academy.role_limit_reached {n} of {limit} custom roles"),
            ));
        }
        if first(
            tx,
            "SELECT 1 FROM academy.custom_roles WHERE name = $1::text",
            &[&input.name],
        )?
        .is_some()
        {
            return Err(academy(
                "academy.cert_invalid",
                format!("academy.cert_invalid a role named {} exists", input.name),
            ));
        }
        let wanted: Vec<String> = PERMISSIONS
            .iter()
            .filter(|p| input.permissions.iter().any(|x| x == **p))
            .map(|p| (*p).to_owned())
            .collect();
        let row = first(
            tx,
            "INSERT INTO academy.custom_roles (name, permissions, active, request_key, created_by, created_at)
             VALUES ($1::text, $2::text[], true, $3::text, $4::text::uuid, $5::text::timestamptz)
             RETURNING id::text, name, permissions, active",
            &[&input.name, &wanted, &key, &input.caller.user_id, &input.now.iso()],
        )?
        .ok_or_else(undefined)?;
        let id: String = col(&row, 0)?;
        super::exec(
            tx,
            "INSERT INTO academy.custom_role_events (role_id, action, operator_id, reason, recorded_at)
             VALUES ($1::text::uuid, 'created', $2::text::uuid, $3::text, $4::text::timestamptz)",
            &[&id, &input.caller.user_id, &reason, &input.now.iso()],
        )?;
        custom_view(tx, &row)
    })
}

/// Switch a custom role off (holders keep the row, the permissions stop) or on again. A repeat changes nothing.
pub fn set_custom_role_active(
    pool: &Db<'_>,
    role_id: &str,
    active: bool,
    reason: &str,
    caller: Caller<'_>,
    now: Instant,
) -> Result<Json, Refusal> {
    let reason = require_reason(reason)?;
    serializable(pool.get()?, |tx| {
        let row = first(
            tx,
            "SELECT id::text, name, permissions, active FROM academy.custom_roles WHERE id = $1::text::uuid FOR UPDATE",
            &[&role_id],
        )?
        .ok_or_else(|| academy("academy.role_not_found", format!("academy.role_not_found role={role_id}")))?;
        if col::<bool>(&row, 3)? == active {
            return custom_view(tx, &row);
        }
        let id: String = col(&row, 0)?;
        assert_may_give(tx, caller.user_id, None, &format!("custom:{id}"))?;
        let done = first(
            tx,
            "UPDATE academy.custom_roles SET active = $1::bool WHERE id = $2::text::uuid RETURNING id::text, name, permissions, active",
            &[&active, &id],
        )?
        .ok_or_else(undefined)?;
        super::exec(
            tx,
            "INSERT INTO academy.custom_role_events (role_id, action, operator_id, reason, recorded_at)
             VALUES ($1::text::uuid, $2::text, $3::text::uuid, $4::text, $5::text::timestamptz)",
            &[
                &id,
                &if active { "switched_on" } else { "switched_off" },
                &caller.user_id,
                &reason,
                &now.iso(),
            ],
        )?;
        custom_view(tx, &done)
    })
}
