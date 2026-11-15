/**
 * AC-roles-01 (J-academy-18): course team roles, custom roles and the one server-side permission check per course.
 *
 * Roles narrow a founder session. The founder scopes (`admin:read`, `admin:write` with module academy) stay the outer gate;
 * inside it, a founder who holds no role on a course (and none academy-wide) keeps the founder's full reach there, and one
 * who holds roles may do only what those roles permit. A switched-off custom role keeps its holders' rows and permits
 * nothing. Every role change is proposed by one founder and takes effect only when a different founder confirms it; both
 * check that the role permits nothing they do not hold themselves (`academy.role_escalation`). The number of custom roles
 * is an owner value with no default: blank refuses `academy.role_limit_unset`. No money moves: `refund.request` is a name
 * in a list, and no code here calls a ledger.
 */
import type { Sql, TransactionSql } from 'postgres';
import {
  ACADEMY_BUILTIN_ROLE_PERMISSIONS,
  ACADEMY_BUILTIN_ROLES,
  ACADEMY_DISCUSSION_ROLES,
  ACADEMY_PERMISSIONS,
  type AcademyBuiltinRole,
  type AcademyCourseTeam,
  type AcademyPermission,
  type AcademyProposeTeamChangeInput,
  type AcademyRole,
  type AcademyRoles,
  type AcademySaveCustomRoleInput,
  type AcademyTeamChange,
} from '@intafaced/contracts';
import { transaction } from '@intafaced/db';
import { AcademyError } from '../errors.js';

type Db = Sql | TransactionSql;

/** The scope of an academy-wide role. A course's scope is its id. */
export const ACADEMY_SCOPE = 'academy';
const scopeOf = (courseId: string | null) => courseId ?? ACADEMY_SCOPE;

type CustomRow = { id: string; name: string; permissions: string[]; active: boolean };
type ChangeRow = {
  id: string;
  scope: string;
  kind: 'assign' | 'revoke';
  account_id: string;
  role: string;
  reason: string;
  proposed_by: string;
  proposed_at: Date;
  confirmed_by: string | null;
  confirmed_at: Date | null;
};

const isBuiltin = (role: string): role is AcademyBuiltinRole => (ACADEMY_BUILTIN_ROLES as readonly string[]).includes(role);
const customId = (role: string) => (role.startsWith('custom:') ? role.slice('custom:'.length) : null);

/** Who is asking: their account and whether their session may change anything (`admin:write`). */
export type Caller = { userId: string; mayWrite: boolean };

function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) throw new AcademyError('academy.reason_required a role change needs a reason', 'academy.reason_required');
  return trimmed;
}

export class CourseTeam {
  constructor(
    private readonly sql: Sql,
    private readonly customRoleLimit: number | null,
  ) {}

  /** A role's permissions now: a built-in role's fixed list, a custom role's list while it is on, otherwise none. */
  private async rolePermissions(db: Db, role: string): Promise<{ name: string; permissions: AcademyPermission[]; active: boolean }> {
    if (isBuiltin(role)) return { name: role, permissions: [...ACADEMY_BUILTIN_ROLE_PERMISSIONS[role]], active: true };
    const id = customId(role);
    const [row] = id ? await db<CustomRow[]>`SELECT id, name, permissions, active FROM academy.custom_roles WHERE id = ${id}` : [];
    if (!row) throw new AcademyError(`academy.role_not_found role=${role}`, 'academy.role_not_found');
    return { name: row.name, permissions: row.permissions as AcademyPermission[], active: row.active };
  }

  /** The roles an account holds on a course (and academy-wide), with what each permits now. */
  private async held(db: Db, accountId: string, courseId: string | null) {
    const rows = await db<{ scope: string; role: string; since: Date }[]>`
      SELECT scope, role, since FROM academy.team_roles
       WHERE account_id = ${accountId} AND scope IN (${scopeOf(courseId)}, ${ACADEMY_SCOPE})
    `;
    return Promise.all(rows.map(async (r) => ({ ...r, ...(await this.rolePermissions(db, r.role)) })));
  }

  /**
   * What an account may do on a course: every permission while they hold no role there or academy-wide (the founder's
   * reach, which the session scopes already gate), otherwise the union of what their roles permit now.
   */
  async permissionsOf(
    accountId: string,
    courseId: string | null,
    db: Db = this.sql,
  ): Promise<{ narrowed: boolean; permissions: AcademyPermission[] }> {
    const held = await this.held(db, accountId, courseId);
    if (held.length === 0) return { narrowed: false, permissions: [...ACADEMY_PERMISSIONS] };
    const on = new Set<AcademyPermission>();
    for (const role of held) if (role.active) for (const p of role.permissions) on.add(p);
    return { narrowed: true, permissions: ACADEMY_PERMISSIONS.filter((p) => on.has(p)) };
  }

  /** Refuses `academy.permission_denied` unless the caller's roles on the course permit `permission`. */
  async require(accountId: string, courseId: string | null, permission: AcademyPermission, db: Db = this.sql): Promise<void> {
    const { permissions } = await this.permissionsOf(accountId, courseId, db);
    if (!permissions.includes(permission))
      throw new AcademyError(
        `academy.permission_denied your role on this course does not permit ${permission}`,
        'academy.permission_denied',
      );
  }

  /** The course a course item belongs to, for a check on an item-level change; `academy.item_not_found` when none. */
  async courseOfItem(itemId: string): Promise<string> {
    const [row] = await this.sql<{ course_id: string }[]>`SELECT course_id FROM academy.course_items WHERE id = ${itemId}`;
    if (!row) throw new AcademyError('no outline item with that id', 'academy.outline_item_unknown');
    return row.course_id;
  }

  /** Refuses unless `giver` may give or take `role` on the course: the right to assign, and nothing above their own. */
  private async assertMayGive(db: Db, giver: string, courseId: string | null, role: string): Promise<AcademyPermission[]> {
    const target = await this.rolePermissions(db, role);
    const { permissions } = await this.permissionsOf(giver, courseId, db);
    const above = target.permissions.filter((p) => !permissions.includes(p));
    if (above.length > 0)
      throw new AcademyError(
        `academy.role_escalation ${target.name} permits ${above.join(', ')}, which you do not hold here`,
        'academy.role_escalation',
      );
    const discussionRole = isBuiltin(role) && ACADEMY_DISCUSSION_ROLES.includes(role);
    if (!permissions.includes('roles.assign') && !(discussionRole && permissions.includes('discussion.assign')))
      throw new AcademyError('academy.permission_denied your role here does not give or take roles', 'academy.permission_denied');
    return target.permissions;
  }

  private async assertCourse(db: Db, courseId: string | null): Promise<void> {
    if (courseId === null) return;
    const [row] = await db`SELECT 1 FROM academy.courses WHERE id = ${courseId}`;
    if (!row) throw new AcademyError(`academy.course_not_found course=${courseId}`, 'academy.course_not_found');
  }

  private async changeView(db: Db, row: ChangeRow): Promise<AcademyTeamChange> {
    const role = await this.rolePermissions(db, row.role).catch(() => ({ name: row.role }));
    return {
      id: row.id,
      kind: row.kind,
      accountId: row.account_id,
      role: row.role,
      roleName: role.name,
      reason: row.reason,
      proposedBy: row.proposed_by,
      proposedAt: row.proposed_at,
      state: row.confirmed_by ? 'confirmed' : 'pending',
      confirmedBy: row.confirmed_by,
      confirmedAt: row.confirmed_at,
    };
  }

  /** One founder proposes giving or taking a role. It waits for a second founder. A retry answers with the same change. */
  async propose(input: AcademyProposeTeamChangeInput & { caller: Caller; now: Date }): Promise<AcademyTeamChange> {
    const reason = requireReason(input.reason);
    return transaction(this.sql, async (tx) => {
      await this.assertCourse(tx, input.courseId);
      await this.assertMayGive(tx, input.caller.userId, input.courseId, input.role);
      const key = `${input.kind === 'assign' ? 'role' : 'unrole'}:${scopeOf(input.courseId)}:${input.accountId}:${input.role}:${input.requestId}`;
      await tx`
        INSERT INTO academy.team_changes (scope, kind, account_id, role, reason, request_key, proposed_by, proposed_at)
        VALUES (${scopeOf(input.courseId)}, ${input.kind}, ${input.accountId}, ${input.role}, ${reason}, ${key},
                ${input.caller.userId}, ${input.now})
        ON CONFLICT (request_key) DO NOTHING
      `;
      const [row] = await tx<ChangeRow[]>`SELECT * FROM academy.team_changes WHERE request_key = ${key}`;
      return this.changeView(tx, row!);
    });
  }

  /** A different founder confirms a waiting change; it takes effect now. Confirming a confirmed change changes nothing. */
  async confirm(input: { changeId: string; caller: Caller; now: Date }): Promise<AcademyTeamChange> {
    return transaction(this.sql, async (tx) => {
      const [row] = await tx<ChangeRow[]>`SELECT * FROM academy.team_changes WHERE id = ${input.changeId} FOR UPDATE`;
      if (!row) throw new AcademyError(`academy.role_not_found change=${input.changeId}`, 'academy.role_not_found');
      if (row.confirmed_by) return this.changeView(tx, row);
      if (row.proposed_by === input.caller.userId)
        throw new AcademyError(
          'academy.second_founder_required a role change is confirmed by a founder other than the one who proposed it',
          'academy.second_founder_required',
        );
      const courseId = row.scope === ACADEMY_SCOPE ? null : row.scope;
      await this.assertMayGive(tx, input.caller.userId, courseId, row.role);
      if (row.kind === 'assign')
        await tx`
          INSERT INTO academy.team_roles (scope, account_id, role, change_id, since)
          VALUES (${row.scope}, ${row.account_id}, ${row.role}, ${row.id}, ${input.now})
          ON CONFLICT (scope, account_id, role) DO NOTHING
        `;
      else await tx`DELETE FROM academy.team_roles WHERE scope = ${row.scope} AND account_id = ${row.account_id} AND role = ${row.role}`;
      const [done] = await tx<ChangeRow[]>`
        UPDATE academy.team_changes SET confirmed_by = ${input.caller.userId}, confirmed_at = ${input.now}
         WHERE id = ${row.id} RETURNING *
      `;
      return this.changeView(tx, done!);
    });
  }

  /** A course's team (or the academy-wide team): holders, every change newest first, and what the caller may do here. */
  async team(courseId: string | null, caller: Caller): Promise<AcademyCourseTeam> {
    await this.assertCourse(this.sql, courseId);
    const scope = scopeOf(courseId);
    const holders = await this.sql<{ account_id: string; role: string; since: Date }[]>`
      SELECT account_id, role, since FROM academy.team_roles WHERE scope = ${scope} ORDER BY since, account_id, role
    `;
    const changes = await this.sql<ChangeRow[]>`
      SELECT * FROM academy.team_changes WHERE scope = ${scope} ORDER BY proposed_at DESC, id LIMIT 200
    `;
    const mine = await this.permissionsOf(caller.userId, courseId);
    return {
      courseId,
      holders: await Promise.all(
        holders.map(async (h) => {
          const role = await this.rolePermissions(this.sql, h.role);
          return { accountId: h.account_id, role: h.role, roleName: role.name, active: role.active, since: h.since };
        }),
      ),
      changes: await Promise.all(changes.map((c) => this.changeView(this.sql, c))),
      yourPermissions: caller.mayWrite ? mine.permissions : [],
      narrowed: mine.narrowed,
    };
  }

  /** Every role with its permissions and how many hold it, the permission list, and the owner's custom role limit. */
  async roles(): Promise<AcademyRoles> {
    const counts = await this.sql<{ role: string; holders: number }[]>`
      SELECT role, count(*)::int AS holders FROM academy.team_roles GROUP BY role
    `;
    const holdersOf = (ref: string) => counts.find((c) => c.role === ref)?.holders ?? 0;
    const custom = await this.sql<CustomRow[]>`SELECT id, name, permissions, active FROM academy.custom_roles ORDER BY created_at, id`;
    const roles: AcademyRole[] = [
      ...ACADEMY_BUILTIN_ROLES.map((name) => ({
        ref: name,
        name,
        kind: 'builtin' as const,
        permissions: [...ACADEMY_BUILTIN_ROLE_PERMISSIONS[name]],
        active: true,
        holders: holdersOf(name),
      })),
      ...custom.map((r) => ({
        ref: `custom:${r.id}`,
        name: r.name,
        kind: 'custom' as const,
        permissions: r.permissions as AcademyPermission[],
        active: r.active,
        holders: holdersOf(`custom:${r.id}`),
      })),
    ];
    return { roles, permissions: [...ACADEMY_PERMISSIONS], customRoleLimit: this.customRoleLimit, customRoles: custom.length };
  }

  /** A new custom role, inside the owner's limit, permitting nothing the founder making it does not hold academy-wide. */
  async saveCustomRole(input: AcademySaveCustomRoleInput & { caller: Caller; now: Date }): Promise<AcademyRole> {
    const reason = requireReason(input.reason);
    if (this.customRoleLimit === null)
      throw new AcademyError(
        'academy.role_limit_unset the owner has not set how many custom roles there may be',
        'academy.role_limit_unset',
      );
    return transaction(this.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('academy.custom_roles'))`;
      const key = `custom-role:${input.caller.userId}:${input.requestId}`;
      const [again] = await tx<CustomRow[]>`SELECT id, name, permissions, active FROM academy.custom_roles WHERE request_key = ${key}`;
      if (again) return this.customView(tx, again);
      const { permissions } = await this.permissionsOf(input.caller.userId, null, tx);
      const above = input.permissions.filter((p) => !permissions.includes(p));
      if (above.length > 0)
        throw new AcademyError(
          `academy.role_escalation the role permits ${above.join(', ')}, which you do not hold`,
          'academy.role_escalation',
        );
      const [count] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM academy.custom_roles`;
      if (count!.n >= this.customRoleLimit!)
        throw new AcademyError(
          `academy.role_limit_reached ${count!.n} of ${this.customRoleLimit} custom roles`,
          'academy.role_limit_reached',
        );
      const [taken] = await tx`SELECT 1 FROM academy.custom_roles WHERE name = ${input.name}`;
      if (taken) throw new AcademyError(`academy.cert_invalid a role named ${input.name} exists`, 'academy.cert_invalid');
      const wanted = ACADEMY_PERMISSIONS.filter((p) => input.permissions.includes(p));
      const [row] = await tx<CustomRow[]>`
        INSERT INTO academy.custom_roles (name, permissions, active, request_key, created_by, created_at)
        VALUES (${input.name}, ${wanted}, true, ${key}, ${input.caller.userId}, ${input.now})
        RETURNING id, name, permissions, active
      `;
      await tx`
        INSERT INTO academy.custom_role_events (role_id, action, operator_id, reason, recorded_at)
        VALUES (${row!.id}, 'created', ${input.caller.userId}, ${reason}, ${input.now})
      `;
      return this.customView(tx, row!);
    });
  }

  /** Switch a custom role off (holders keep the row, the permissions stop) or on again. A repeat changes nothing. */
  async setCustomRoleActive(input: { roleId: string; active: boolean; reason: string; caller: Caller; now: Date }): Promise<AcademyRole> {
    const reason = requireReason(input.reason);
    return transaction(this.sql, async (tx) => {
      const [row] = await tx<
        CustomRow[]
      >`SELECT id, name, permissions, active FROM academy.custom_roles WHERE id = ${input.roleId} FOR UPDATE`;
      if (!row) throw new AcademyError(`academy.role_not_found role=${input.roleId}`, 'academy.role_not_found');
      if (row.active === input.active) return this.customView(tx, row);
      await this.assertMayGive(tx, input.caller.userId, null, `custom:${row.id}`);
      const [done] = await tx<CustomRow[]>`
        UPDATE academy.custom_roles SET active = ${input.active} WHERE id = ${row.id} RETURNING id, name, permissions, active
      `;
      await tx`
        INSERT INTO academy.custom_role_events (role_id, action, operator_id, reason, recorded_at)
        VALUES (${row.id}, ${input.active ? 'switched_on' : 'switched_off'}, ${input.caller.userId}, ${reason}, ${input.now})
      `;
      return this.customView(tx, done!);
    });
  }

  private async customView(db: Db, row: CustomRow): Promise<AcademyRole> {
    const [count] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM academy.team_roles WHERE role = ${`custom:${row.id}`}`;
    return {
      ref: `custom:${row.id}`,
      name: row.name,
      kind: 'custom',
      permissions: row.permissions as AcademyPermission[],
      active: row.active,
      holders: count!.n,
    };
  }
}
