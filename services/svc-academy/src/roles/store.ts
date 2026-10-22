/**
 * AC-roles-01 — course team role store and the server-side permission query.
 *
 * Assign is keyed `role:<course>:<account>:<role>` (suffixed `:<n>` on a
 * re-activation, n the stored activation count); revoke is keyed
 * `unrole:<course>:<account>:<role>:<n>`. A repeat returns the stored state.
 * Every change appends a role event with actor, approver and reason.
 */
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { AcademyError } from '../errors.js';
import {
  assertNoEscalation,
  assertPermissions,
  BUILTIN_ROLE_PERMISSIONS,
  customRoleId,
  isBuiltinRole,
  type AcademyPermission,
} from './catalog.js';

export const ACADEMY_SCOPE = '*';

export interface CustomRole {
  id: string;
  label: string;
  permissions: AcademyPermission[];
  active: boolean;
}

export interface RoleHolder {
  courseScope: string;
  accountId: string;
  role: string;
  activation: number;
  active: boolean;
}

export interface ChangeMeta {
  actor: string;
  approver: string;
  reason: string;
}

type AssignmentSql = { course_scope: string; account_id: string; role: string; activation: number; revoked_at: Date | null };

const holder = (r: AssignmentSql): RoleHolder => ({
  courseScope: r.course_scope,
  accountId: r.account_id,
  role: r.role,
  activation: r.activation,
  active: r.revoked_at === null,
});

function assertReason(reason: string): string {
  const r = reason.trim();
  if (r === '') throw new AcademyError('a reason is required', 'academy.role_invalid');
  return r;
}

export class AcademyRoleStore {
  /** Owner values; undefined = not set (the call that needs it refuses by name). */
  constructor(
    private readonly sql: Sql,
    private readonly limits: { readonly customRoleLimit?: number | undefined; readonly holdersListLimit?: number | undefined } = {},
  ) {}

  private get customRoleLimit(): number | undefined {
    return this.limits.customRoleLimit;
  }

  /**
   * Gate for every academy.admin.* procedure. Founder pass-through: an account
   * holding no academy role rows at all is a founder session (the founder
   * scope `admin:*` is the outer gate and already checked). An account with
   * any role row is narrowed to the permissions its roles grant on that course.
   */
  async authorize(accountId: string, courseScope: string, permission: AcademyPermission): Promise<void> {
    if ((await this.assignerHeld(this.sql, accountId, courseScope)) === null) return;
    await this.requirePermission(accountId, courseScope, permission);
  }

  async customRoles(): Promise<CustomRole[]> {
    const rows = await this.sql<Array<{ id: string; label: string; permissions: string[]; active: boolean }>>`
      SELECT id, label, permissions, active FROM academy.custom_roles ORDER BY id`;
    return rows.map((r) => ({ id: r.id, label: r.label, permissions: r.permissions as AcademyPermission[], active: r.active }));
  }

  /** Permissions a role grants now. Unknown role refuses; a deactivated custom role grants nothing. */
  private async rolePermissions(sql: Sql, role: string): Promise<{ perms: AcademyPermission[]; active: boolean }> {
    if (isBuiltinRole(role)) return { perms: [...BUILTIN_ROLE_PERMISSIONS[role]], active: true };
    const rows = await sql<Array<{ permissions: string[]; active: boolean }>>`
      SELECT permissions, active FROM academy.custom_roles WHERE id = ${role}`;
    if (!rows[0]) throw new AcademyError(`role ${role} not found`, 'academy.role_not_found');
    return { perms: rows[0].permissions as AcademyPermission[], active: rows[0].active };
  }

  /** Every permission an account holds on a course (its course roles plus academy-wide roles). */
  async permissionsOf(accountId: string, courseScope: string, sql: Sql = this.sql): Promise<Set<AcademyPermission>> {
    const rows = await sql<Array<{ role: string }>>`
      SELECT role FROM academy.role_assignments
      WHERE account_id = ${accountId} AND revoked_at IS NULL AND course_scope IN (${courseScope}, ${ACADEMY_SCOPE})`;
    const out = new Set<AcademyPermission>();
    for (const { role } of rows) {
      // A role row naming a role that no longer resolves grants nothing; any other failure propagates.
      const { perms, active } = await this.rolePermissions(sql, role).catch((err: unknown) => {
        if (err instanceof AcademyError && err.code === 'academy.role_not_found')
          return { perms: [] as AcademyPermission[], active: false };
        throw err;
      });
      if (active) for (const p of perms) out.add(p);
    }
    return out;
  }

  /** The single server-side permission query. Refuses `academy.permission_denied`. */
  async requirePermission(accountId: string, courseScope: string, permission: AcademyPermission): Promise<void> {
    const held = await this.permissionsOf(accountId, courseScope);
    if (!held.has(permission)) {
      throw new AcademyError(`missing permission ${permission} on ${courseScope}`, 'academy.permission_denied');
    }
  }

  /**
   * null when the account holds no active academy role rows at all. Assumption
   * (documented in the PR): only founder sessions reach admin:* procedures today
   * and founders hold no role rows, so zero rows = founder. Once staff sign in
   * to the desk (ops-console staff accounts) this must read the session kind.
   */
  private async assignerHeld(sql: Sql, actor: string, courseScope: string): Promise<Set<AcademyPermission> | null> {
    const any = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM academy.role_assignments WHERE account_id = ${actor} AND revoked_at IS NULL`;
    if ((any[0]?.n ?? 0) === 0) return null;
    return this.permissionsOf(actor, courseScope, sql);
  }

  async createCustomRole(input: { slug: string; label: string; permissions: string[] } & ChangeMeta): Promise<CustomRole> {
    if (this.customRoleLimit === undefined) {
      throw new AcademyError('custom role limit is not set', 'academy.role_limit_unset');
    }
    const id = customRoleId(input.slug);
    const label = input.label.trim();
    if (label === '') throw new AcademyError('label is required', 'academy.role_invalid');
    const perms = assertPermissions(input.permissions);
    const reason = assertReason(input.reason);
    const limit = this.customRoleLimit;
    return transaction(this.sql, async (tx) => {
      const existing = await tx<Array<{ id: string; label: string; permissions: string[]; active: boolean }>>`
        SELECT id, label, permissions, active FROM academy.custom_roles WHERE id = ${id}`;
      if (existing[0]) {
        const e = existing[0];
        return { id: e.id, label: e.label, permissions: e.permissions as AcademyPermission[], active: e.active };
      }
      assertNoEscalation(perms, await this.assignerHeld(tx, input.actor, ACADEMY_SCOPE));
      await tx`SELECT pg_advisory_xact_lock(hashtext('academy.custom_roles'))`;
      const count = await tx<Array<{ n: number }>>`SELECT count(*)::int AS n FROM academy.custom_roles`;
      if ((count[0]?.n ?? 0) >= limit) {
        throw new AcademyError('custom role limit reached', 'academy.role_limit_reached');
      }
      await tx`
        INSERT INTO academy.custom_roles (id, label, permissions, created_by)
        VALUES (${id}, ${label}, ${perms}, ${input.actor})`;
      await tx`
        INSERT INTO academy.role_events (idempotency_key, action, role, actor, approver, reason)
        VALUES (${`rolecreate:${id}`}, 'create', ${id}, ${input.actor}, ${input.approver}, ${reason})`;
      return { id, label, permissions: perms, active: true };
    });
  }

  /** Activate or deactivate a custom role without touching its holders. */
  async setCustomRoleActive(input: { roleId: string; active: boolean } & ChangeMeta): Promise<CustomRole> {
    const reason = assertReason(input.reason);
    return transaction(this.sql, async (tx) => {
      const cur = await tx<Array<{ id: string; label: string; permissions: string[]; active: boolean }>>`
        SELECT id, label, permissions, active FROM academy.custom_roles WHERE id = ${input.roleId} FOR UPDATE`;
      const c = cur[0];
      if (!c) throw new AcademyError(`role ${input.roleId} not found`, 'academy.role_not_found');
      if (c.active === input.active) {
        return { id: c.id, label: c.label, permissions: c.permissions as AcademyPermission[], active: c.active };
      }
      // Activating turns the role's permissions back on for every holder: the actor must hold them.
      if (input.active) assertNoEscalation(c.permissions as AcademyPermission[], await this.assignerHeld(tx, input.actor, ACADEMY_SCOPE));
      const n = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM academy.role_events
        WHERE role = ${input.roleId} AND action IN ('activate', 'deactivate')`;
      const rows = await tx<Array<{ id: string; label: string; permissions: string[]; active: boolean }>>`
        UPDATE academy.custom_roles SET active = ${input.active} WHERE id = ${input.roleId}
        RETURNING id, label, permissions, active`;
      const r = rows[0] as { id: string; label: string; permissions: string[]; active: boolean };
      await tx`
        INSERT INTO academy.role_events (action, idempotency_key, role, actor, approver, reason)
        VALUES (${input.active ? 'activate' : 'deactivate'},
                ${`roleactive:${input.roleId}:${input.active}:${n[0]?.n ?? 0}`}, ${input.roleId}, ${input.actor}, ${input.approver}, ${reason})`;
      return { id: r.id, label: r.label, permissions: r.permissions as AcademyPermission[], active: r.active };
    });
  }

  async assign(input: { courseScope: string; accountId: string; role: string } & ChangeMeta): Promise<RoleHolder> {
    const reason = assertReason(input.reason);
    return transaction(this.sql, async (tx) => {
      const { perms } = await this.rolePermissions(tx, input.role);
      const rows = await tx<AssignmentSql[]>`
        SELECT * FROM academy.role_assignments
        WHERE course_scope = ${input.courseScope} AND account_id = ${input.accountId} AND role = ${input.role}
        FOR UPDATE`;
      const row = rows[0];
      if (row && row.revoked_at === null) return holder(row);
      assertNoEscalation(perms, await this.assignerHeld(tx, input.actor, input.courseScope));
      const base = `role:${input.courseScope}:${input.accountId}:${input.role}`;
      let out: AssignmentSql;
      if (!row) {
        const ins = await tx<AssignmentSql[]>`
          INSERT INTO academy.role_assignments (course_scope, account_id, role, assigned_by)
          VALUES (${input.courseScope}, ${input.accountId}, ${input.role}, ${input.actor}) RETURNING *`;
        out = ins[0] as AssignmentSql;
      } else {
        const upd = await tx<AssignmentSql[]>`
          UPDATE academy.role_assignments SET revoked_at = NULL, activation = activation + 1,
            assigned_by = ${input.actor}, assigned_at = now()
          WHERE course_scope = ${input.courseScope} AND account_id = ${input.accountId} AND role = ${input.role}
          RETURNING *`;
        out = upd[0] as AssignmentSql;
      }
      const key = out.activation === 0 ? base : `${base}:${out.activation}`;
      await tx`
        INSERT INTO academy.role_events (idempotency_key, action, course_scope, account_id, role, actor, approver, reason)
        VALUES (${key}, 'assign', ${input.courseScope}, ${input.accountId}, ${input.role}, ${input.actor}, ${input.approver}, ${reason})`;
      return holder(out);
    });
  }

  async revoke(input: { courseScope: string; accountId: string; role: string } & ChangeMeta): Promise<RoleHolder> {
    const reason = assertReason(input.reason);
    return transaction(this.sql, async (tx) => {
      const rows = await tx<AssignmentSql[]>`
        SELECT * FROM academy.role_assignments
        WHERE course_scope = ${input.courseScope} AND account_id = ${input.accountId} AND role = ${input.role}
        FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new AcademyError('no such role assignment', 'academy.role_not_found');
      if (row.revoked_at !== null) return holder(row);
      const upd = await tx<AssignmentSql[]>`
        UPDATE academy.role_assignments SET revoked_at = now()
        WHERE course_scope = ${input.courseScope} AND account_id = ${input.accountId} AND role = ${input.role}
        RETURNING *`;
      await tx`
        INSERT INTO academy.role_events (idempotency_key, action, course_scope, account_id, role, actor, approver, reason)
        VALUES (${`unrole:${input.courseScope}:${input.accountId}:${input.role}:${row.activation}`}, 'revoke',
                ${input.courseScope}, ${input.accountId}, ${input.role}, ${input.actor}, ${input.approver}, ${reason})`;
      return holder(upd[0] as AssignmentSql);
    });
  }

  async holders(courseScope: string): Promise<RoleHolder[]> {
    const raw = this.limits.holdersListLimit;
    if (raw === undefined || !Number.isInteger(raw) || raw < 1) {
      throw new AcademyError('role holders list limit is unset', 'academy.role_holders_list_limit_unset');
    }
    const limit = Math.min(200, raw);
    const rows = await this.sql<AssignmentSql[]>`
      SELECT * FROM academy.role_assignments WHERE course_scope = ${courseScope}
      ORDER BY account_id, role LIMIT ${limit}`;
    return rows.map(holder);
  }
}
