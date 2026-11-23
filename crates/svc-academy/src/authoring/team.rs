//! The course team check an edit passes first (`team/course-team.ts` `CourseTeam.require` and `courseOfItem`): an
//! account with no role on the course or academy-wide holds every permission (the founder's reach, which the session
//! scopes already gate); otherwise the union of what its active roles permit now.

use postgres::GenericClient;

use super::refuse;
use super::sql::{first, get, query};
use crate::errors::Refusal;

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

/// `ACADEMY_SCOPE`.
pub const ACADEMY_SCOPE: &str = "academy";

/// `ACADEMY_BUILTIN_ROLE_PERMISSIONS`.
pub fn builtin(role: &str) -> Option<&'static [&'static str]> {
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

/// `rolePermissions(db, role)`: what a role permits and whether it is active.
fn role_permissions<C: GenericClient>(
    c: &mut C,
    role: &str,
) -> Result<(Vec<String>, bool), Refusal> {
    if let Some(p) = builtin(role) {
        return Ok((p.iter().map(|s| (*s).to_owned()).collect(), true));
    }
    let row = match role.strip_prefix("custom:") {
        Some(id) => first(
            c,
            "SELECT id::text AS id, name, permissions, active FROM academy.custom_roles WHERE id = $1::text::uuid",
            &[&id],
        )?,
        None => None,
    };
    let Some(row) = row else {
        return refuse(
            format!("academy.role_not_found role={role}"),
            "academy.role_not_found",
        );
    };
    Ok((
        get::<Vec<String>>(&row, "permissions")?,
        get::<bool>(&row, "active")?,
    ))
}

/// `permissionsOf(accountId, courseId)`.
pub fn permissions_of<C: GenericClient>(
    c: &mut C,
    account_id: &str,
    course_id: Option<&str>,
) -> Result<Vec<&'static str>, Refusal> {
    let scope = course_id.unwrap_or(ACADEMY_SCOPE);
    let rows = query(
        c,
        "SELECT scope, role, since FROM academy.team_roles WHERE account_id = $1::text::uuid AND scope IN ($2::text, $3::text)",
        &[&account_id, &scope, &ACADEMY_SCOPE],
    )?;
    if rows.is_empty() {
        return Ok(PERMISSIONS.to_vec());
    }
    let mut on: Vec<String> = Vec::new();
    for r in &rows {
        let role: String = get(r, "role")?;
        let (permissions, active) = role_permissions(c, &role)?;
        if active {
            on.extend(permissions);
        }
    }
    Ok(PERMISSIONS
        .iter()
        .copied()
        .filter(|p| on.iter().any(|o| o == p))
        .collect())
}

/// `CourseTeam.require(accountId, courseId, permission)`.
pub fn require<C: GenericClient>(
    c: &mut C,
    account_id: &str,
    course_id: Option<&str>,
    permission: &str,
) -> Result<(), Refusal> {
    if !permissions_of(c, account_id, course_id)?.contains(&permission) {
        return refuse(
            format!(
                "academy.permission_denied your role on this course does not permit {permission}"
            ),
            "academy.permission_denied",
        );
    }
    Ok(())
}

/// `CourseTeam.courseOfItem(itemId)`.
pub fn course_of_item<C: GenericClient>(c: &mut C, item_id: &str) -> Result<String, Refusal> {
    match first(
        c,
        "SELECT course_id::text AS course_id FROM academy.course_items WHERE id = $1::text::uuid",
        &[&item_id],
    )? {
        Some(r) => get(&r, "course_id"),
        None => refuse(
            "no outline item with that id",
            "academy.outline_item_unknown",
        ),
    }
}
