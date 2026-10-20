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
export type StaffAvailability = 'online' | 'busy' | 'offline';
export const STAFF_AVAILABILITIES: readonly StaffAvailability[] = ['online', 'busy', 'offline'];

export interface StaffMember {
  readonly userId: string;
  readonly role: StaffRole;
  readonly appointedBy: string;
  readonly appointedAt: string;
  /** As last set. The service folds in the heartbeat window when it is set. */
  readonly availability: StaffAvailability;
  readonly availabilitySetAt: string | null;
  readonly lastHeartbeatAt: string | null;
}

export interface DeskReplay<T> {
  readonly hit: boolean;
  readonly value?: T;
}

export interface StaffBook {
  list(): Promise<StaffMember[]>;
  get(userId: string): Promise<StaffMember | null>;
  appoint(input: { userId: string; role: StaffRole; by: string; at: string }): Promise<StaffMember>;
  /**
   * Stores the value and appends one log row, unless the stored value is
   * already that value (then nothing is written). A heartbeat is stamped
   * when `heartbeat` is true. Returns null when the user is not staff.
   */
  setAvailability(input: {
    userId: string;
    value: StaffAvailability;
    by: string;
    reason: string | null;
    at: string;
    heartbeat: boolean;
  }): Promise<StaffMember | null>;
  /** Stamps the last heartbeat. Returns null when the user is not staff. */
  heartbeat(userId: string, at: string): Promise<StaffMember | null>;
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
    const prior = this.members.get(input.userId);
    const member: StaffMember = {
      userId: input.userId,
      role: input.role,
      appointedBy: input.by,
      appointedAt: input.at,
      availability: prior?.availability ?? 'offline',
      availabilitySetAt: prior?.availabilitySetAt ?? null,
      lastHeartbeatAt: prior?.lastHeartbeatAt ?? null,
    };
    this.members.set(input.userId, member);
    return member;
  }

  readonly availabilityLog: { userId: string; availability: StaffAvailability; by: string; reason: string | null; at: string }[] = [];

  async setAvailability(input: {
    userId: string;
    value: StaffAvailability;
    by: string;
    reason: string | null;
    at: string;
    heartbeat: boolean;
  }): Promise<StaffMember | null> {
    const prior = this.members.get(input.userId);
    if (!prior) return null;
    const lastHeartbeatAt = input.heartbeat ? input.at : prior.lastHeartbeatAt;
    if (prior.availability === input.value) {
      if (lastHeartbeatAt === prior.lastHeartbeatAt) return prior;
      const same = { ...prior, lastHeartbeatAt };
      this.members.set(input.userId, same);
      return same;
    }
    const next: StaffMember = { ...prior, availability: input.value, availabilitySetAt: input.at, lastHeartbeatAt };
    this.members.set(input.userId, next);
    this.availabilityLog.push({ userId: input.userId, availability: input.value, by: input.by, reason: input.reason, at: input.at });
    return next;
  }

  async heartbeat(userId: string, at: string): Promise<StaffMember | null> {
    const prior = this.members.get(userId);
    if (!prior) return null;
    const next = { ...prior, lastHeartbeatAt: at };
    this.members.set(userId, next);
    return next;
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

type StaffRow = {
  user_id: string;
  role: StaffRole;
  appointed_by: string;
  appointed_at: Date | string;
  availability: StaffAvailability;
  availability_at: Date | string | null;
  last_heartbeat_at: Date | string | null;
};
type CommandRow = { fingerprint: string; result: unknown };

export class SqlStaffBook implements StaffBook {
  constructor(private readonly sql: Sql) {}

  async list(): Promise<StaffMember[]> {
    const rows = await this.sql<StaffRow[]>`
      SELECT user_id, role, appointed_by, appointed_at, availability, availability_at, last_heartbeat_at FROM support.staff ORDER BY user_id ASC
    `;
    return rows.map(fromStaff);
  }

  async get(userId: string): Promise<StaffMember | null> {
    const rows = await this.sql<StaffRow[]>`
      SELECT user_id, role, appointed_by, appointed_at, availability, availability_at, last_heartbeat_at FROM support.staff WHERE user_id = ${userId} LIMIT 1
    `;
    return rows[0] ? fromStaff(rows[0]) : null;
  }

  async appoint(input: { userId: string; role: StaffRole; by: string; at: string }): Promise<StaffMember> {
    const rows = await this.sql<StaffRow[]>`
      INSERT INTO support.staff (user_id, role, appointed_by, appointed_at)
      VALUES (${input.userId}, ${input.role}, ${input.by}, ${input.at})
      ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, appointed_by = EXCLUDED.appointed_by, appointed_at = EXCLUDED.appointed_at
      RETURNING user_id, role, appointed_by, appointed_at, availability, availability_at, last_heartbeat_at
    `;
    return fromStaff(rows[0]!);
  }

  async setAvailability(input: {
    userId: string;
    value: StaffAvailability;
    by: string;
    reason: string | null;
    at: string;
    heartbeat: boolean;
  }): Promise<StaffMember | null> {
    return this.sql.begin(async (tx) => {
      const locked = await tx<StaffRow[]>`
        SELECT ${tx.unsafe(STAFF_COLUMNS)} FROM support.staff WHERE user_id = ${input.userId} FOR UPDATE
      `;
      const prior = locked[0];
      if (!prior) return null;
      if (prior.availability === input.value) {
        if (!input.heartbeat) return fromStaff(prior);
        const stamped = await tx<StaffRow[]>`
          UPDATE support.staff SET last_heartbeat_at = ${input.at} WHERE user_id = ${input.userId}
          RETURNING ${tx.unsafe(STAFF_COLUMNS)}
        `;
        return fromStaff(stamped[0]!);
      }
      const updated = await tx<StaffRow[]>`
        UPDATE support.staff
        SET availability = ${input.value}, availability_at = ${input.at},
            last_heartbeat_at = ${input.heartbeat ? input.at : prior.last_heartbeat_at}
        WHERE user_id = ${input.userId}
        RETURNING ${tx.unsafe(STAFF_COLUMNS)}
      `;
      await tx`
        INSERT INTO support.staff_availability_log (user_id, availability, set_by, reason, set_at)
        VALUES (${input.userId}, ${input.value}, ${input.by}, ${input.reason}, ${input.at})
      `;
      return fromStaff(updated[0]!);
    }) as Promise<StaffMember | null>;
  }

  async heartbeat(userId: string, at: string): Promise<StaffMember | null> {
    const rows = await this.sql<StaffRow[]>`
      UPDATE support.staff SET last_heartbeat_at = ${at} WHERE user_id = ${userId}
      RETURNING ${this.sql.unsafe(STAFF_COLUMNS)}
    `;
    return rows[0] ? fromStaff(rows[0]) : null;
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

const STAFF_COLUMNS = '"user_id", "role", "appointed_by", "appointed_at", "availability", "availability_at", "last_heartbeat_at"';

const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

function fromStaff(row: StaffRow): StaffMember {
  return {
    availability: row.availability,
    availabilitySetAt: row.availability_at === null ? null : iso(row.availability_at),
    lastHeartbeatAt: row.last_heartbeat_at === null ? null : iso(row.last_heartbeat_at),
    userId: row.user_id,
    role: row.role,
    appointedBy: row.appointed_by,
    appointedAt: row.appointed_at instanceof Date ? row.appointed_at.toISOString() : new Date(row.appointed_at).toISOString(),
  };
}
