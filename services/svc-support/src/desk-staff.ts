/**
 * Support desk staff and idempotent assignment commands.
 *
 * Roles: `lead` may appoint and assign a ticket to another staff member.
 * `agent` may claim and unclaim only their own ticket. The first appointment
 * may be made by any support:ops caller, and it must be a lead, so the desk
 * is not stuck with nobody who can appoint the next person.
 */
import type { Sql } from 'postgres';

export type StaffRole = 'agent' | 'lead';

export interface StaffMember {
  readonly userId: string;
  readonly role: StaffRole;
  readonly appointedBy: string;
  readonly appointedAt: string;
}

export interface DeskReplay<T> {
  readonly hit: boolean;
  readonly value?: T;
}

export interface StaffBook {
  list(): Promise<StaffMember[]>;
  get(userId: string): Promise<StaffMember | null>;
  appoint(input: { userId: string; role: StaffRole; by: string; at: string }): Promise<StaffMember>;
  /** Same key and fingerprint returns the stored value. A different fingerprint refuses. */
  begin(key: string, fingerprint: string): Promise<'new' | 'replay'>;
  save<T>(key: string, value: T): Promise<void>;
  read<T>(key: string): Promise<T | null>;
}

export class MemoryStaffBook implements StaffBook {
  private readonly members = new Map<string, StaffMember>();
  private readonly commands = new Map<string, { fingerprint: string; value: unknown }>();

  async list(): Promise<StaffMember[]> {
    return [...this.members.values()].sort((a, b) => a.userId.localeCompare(b.userId));
  }

  async get(userId: string): Promise<StaffMember | null> {
    return this.members.get(userId) ?? null;
  }

  async appoint(input: { userId: string; role: StaffRole; by: string; at: string }): Promise<StaffMember> {
    const member: StaffMember = { userId: input.userId, role: input.role, appointedBy: input.by, appointedAt: input.at };
    this.members.set(input.userId, member);
    return member;
  }

  async begin(key: string, fingerprint: string): Promise<'new' | 'replay'> {
    const prior = this.commands.get(key);
    if (!prior) {
      this.commands.set(key, { fingerprint, value: undefined });
      return 'new';
    }
    if (prior.fingerprint !== fingerprint) throw new Error('support.idempotency_conflict');
    return 'replay';
  }

  async save<T>(key: string, value: T): Promise<void> {
    const prior = this.commands.get(key);
    if (!prior) throw new Error('support.idempotency_conflict');
    prior.value = value;
  }

  async read<T>(key: string): Promise<T | null> {
    const prior = this.commands.get(key);
    if (!prior || prior.value === undefined) return null;
    return prior.value as T;
  }
}

type StaffRow = { user_id: string; role: StaffRole; appointed_by: string; appointed_at: Date | string };
type CommandRow = { fingerprint: string; result: unknown };

export class SqlStaffBook implements StaffBook {
  constructor(private readonly sql: Sql) {}

  async list(): Promise<StaffMember[]> {
    const rows = await this.sql<StaffRow[]>`
      SELECT user_id, role, appointed_by, appointed_at FROM support.staff ORDER BY user_id ASC
    `;
    return rows.map(fromStaff);
  }

  async get(userId: string): Promise<StaffMember | null> {
    const rows = await this.sql<StaffRow[]>`
      SELECT user_id, role, appointed_by, appointed_at FROM support.staff WHERE user_id = ${userId} LIMIT 1
    `;
    return rows[0] ? fromStaff(rows[0]) : null;
  }

  async appoint(input: { userId: string; role: StaffRole; by: string; at: string }): Promise<StaffMember> {
    const rows = await this.sql<StaffRow[]>`
      INSERT INTO support.staff (user_id, role, appointed_by, appointed_at)
      VALUES (${input.userId}, ${input.role}, ${input.by}, ${input.at})
      ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, appointed_by = EXCLUDED.appointed_by, appointed_at = EXCLUDED.appointed_at
      RETURNING user_id, role, appointed_by, appointed_at
    `;
    return fromStaff(rows[0]!);
  }

  async begin(key: string, fingerprint: string): Promise<'new' | 'replay'> {
    const inserted = await this.sql<CommandRow[]>`
      INSERT INTO support.desk_commands (idempotency_key, fingerprint)
      VALUES (${key}, ${fingerprint})
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING fingerprint, result
    `;
    if (inserted[0]) return 'new';
    const prior = await this.sql<CommandRow[]>`
      SELECT fingerprint, result FROM support.desk_commands WHERE idempotency_key = ${key}
    `;
    if (!prior[0] || prior[0].fingerprint !== fingerprint) throw new Error('support.idempotency_conflict');
    return 'replay';
  }

  async save<T>(key: string, value: T): Promise<void> {
    await this.sql`
      UPDATE support.desk_commands SET result = ${this.sql.json(value as never)} WHERE idempotency_key = ${key}
    `;
  }

  async read<T>(key: string): Promise<T | null> {
    const rows = await this.sql<CommandRow[]>`
      SELECT fingerprint, result FROM support.desk_commands WHERE idempotency_key = ${key}
    `;
    const value = rows[0]?.result;
    if (value === null || value === undefined) return null;
    return value as T;
  }
}

function fromStaff(row: StaffRow): StaffMember {
  return {
    userId: row.user_id,
    role: row.role,
    appointedBy: row.appointed_by,
    appointedAt: row.appointed_at instanceof Date ? row.appointed_at.toISOString() : new Date(row.appointed_at).toISOString(),
  };
}
