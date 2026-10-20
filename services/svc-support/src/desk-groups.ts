/**
 * Desk groups and ticket visibility.
 *
 * A group is a named set of staff and a ticket may sit in one group. While no
 * group exists, every support:ops caller sees the whole queue, as before. Once
 * any group exists the rule in `deskCanSee` applies on every operator path.
 * Group state lives only here: tickets in the contract carry no group field.
 */
import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type { StaffRole } from './desk-staff.js';

export interface DeskGroup {
  readonly id: string;
  readonly name: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly memberIds: string[];
}

export type GroupLogAction = 'created' | 'renamed' | 'member_added' | 'member_removed' | 'ticket_grouped' | 'ticket_ungrouped';

export interface GroupLogEntry {
  readonly groupId: string;
  readonly action: GroupLogAction;
  readonly subject: string | null;
  readonly by: string;
  readonly at: string;
}

export interface GroupBook {
  list(): Promise<DeskGroup[]>;
  get(groupId: string): Promise<DeskGroup | null>;
  /** Creates (no id) or renames (id). Null when the id is unknown; throws `support.group_name_taken` on a duplicate name. */
  save(input: { id?: string; name: string; by: string; at: string }): Promise<DeskGroup | null>;
  /** Null when the group is unknown; `duplicate` when already a member. */
  addMember(input: { groupId: string; userId: string; by: string; at: string }): Promise<'added' | 'duplicate' | 'unknown_group'>;
  /** Removing a person who is not a member is a no-op. */
  removeMember(input: { groupId: string; userId: string; by: string; at: string }): Promise<'removed' | 'absent' | 'unknown_group'>;
  groupsOfUser(userId: string): Promise<string[]>;
  groupOfTicket(ticketId: string): Promise<string | null>;
  /** groupId null takes the ticket out of its group. Unknown group is refused. */
  setTicketGroup(input: { ticketId: string; groupId: string | null; by: string; at: string }): Promise<'ok' | 'unknown_group'>;
  /** Ticket ids placed in a group, for list filtering. */
  groupedTickets(): Promise<Map<string, string>>;
}

export class MemoryGroupBook implements GroupBook {
  private readonly groups = new Map<string, { id: string; name: string; createdBy: string; createdAt: string; members: Set<string> }>();
  private readonly tickets = new Map<string, string>();
  readonly log: GroupLogEntry[] = [];

  private view(id: string): DeskGroup | null {
    const g = this.groups.get(id);
    return g ? { id: g.id, name: g.name, createdBy: g.createdBy, createdAt: g.createdAt, memberIds: [...g.members].sort() } : null;
  }

  async list(): Promise<DeskGroup[]> {
    return [...this.groups.values()].sort((a, b) => a.name.localeCompare(b.name)).map((g) => this.view(g.id)!);
  }

  async get(groupId: string): Promise<DeskGroup | null> {
    return this.view(groupId);
  }

  async save(input: { id?: string; name: string; by: string; at: string }): Promise<DeskGroup | null> {
    const taken = [...this.groups.values()].some((g) => g.name === input.name && g.id !== input.id);
    if (taken) throw new Error('support.group_name_taken');
    if (input.id) {
      const g = this.groups.get(input.id);
      if (!g) return null;
      if (g.name !== input.name) {
        g.name = input.name;
        this.log.push({ groupId: g.id, action: 'renamed', subject: input.name, by: input.by, at: input.at });
      }
      return this.view(g.id);
    }
    const id = randomUUID();
    this.groups.set(id, { id, name: input.name, createdBy: input.by, createdAt: input.at, members: new Set() });
    this.log.push({ groupId: id, action: 'created', subject: input.name, by: input.by, at: input.at });
    return this.view(id);
  }

  async addMember(input: { groupId: string; userId: string; by: string; at: string }): Promise<'added' | 'duplicate' | 'unknown_group'> {
    const g = this.groups.get(input.groupId);
    if (!g) return 'unknown_group';
    if (g.members.has(input.userId)) return 'duplicate';
    g.members.add(input.userId);
    this.log.push({ groupId: g.id, action: 'member_added', subject: input.userId, by: input.by, at: input.at });
    return 'added';
  }

  async removeMember(input: { groupId: string; userId: string; by: string; at: string }): Promise<'removed' | 'absent' | 'unknown_group'> {
    const g = this.groups.get(input.groupId);
    if (!g) return 'unknown_group';
    if (!g.members.delete(input.userId)) return 'absent';
    this.log.push({ groupId: g.id, action: 'member_removed', subject: input.userId, by: input.by, at: input.at });
    return 'removed';
  }

  async groupsOfUser(userId: string): Promise<string[]> {
    return [...this.groups.values()].filter((g) => g.members.has(userId)).map((g) => g.id);
  }

  async groupOfTicket(ticketId: string): Promise<string | null> {
    return this.tickets.get(ticketId) ?? null;
  }

  async setTicketGroup(input: { ticketId: string; groupId: string | null; by: string; at: string }): Promise<'ok' | 'unknown_group'> {
    if (input.groupId === null) {
      const prior = this.tickets.get(input.ticketId);
      if (prior) {
        this.tickets.delete(input.ticketId);
        this.log.push({ groupId: prior, action: 'ticket_ungrouped', subject: input.ticketId, by: input.by, at: input.at });
      }
      return 'ok';
    }
    if (!this.groups.has(input.groupId)) return 'unknown_group';
    if (this.tickets.get(input.ticketId) !== input.groupId) {
      this.tickets.set(input.ticketId, input.groupId);
      this.log.push({ groupId: input.groupId, action: 'ticket_grouped', subject: input.ticketId, by: input.by, at: input.at });
    }
    return 'ok';
  }

  async groupedTickets(): Promise<Map<string, string>> {
    return new Map(this.tickets);
  }
}

type GroupRow = { id: string; name: string; created_by: string; created_at: Date | string };

const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

export class SqlGroupBook implements GroupBook {
  constructor(private readonly sql: Sql) {}

  private async hydrate(rows: GroupRow[]): Promise<DeskGroup[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const members = await this.sql<{ group_id: string; user_id: string }[]>`
      SELECT group_id, user_id FROM support.group_members WHERE group_id IN ${this.sql(ids)} ORDER BY user_id ASC
    `;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdBy: r.created_by,
      createdAt: iso(r.created_at),
      memberIds: members.filter((m) => m.group_id === r.id).map((m) => m.user_id),
    }));
  }

  async list(): Promise<DeskGroup[]> {
    return this.hydrate(await this.sql<GroupRow[]>`SELECT id, name, created_by, created_at FROM support.groups ORDER BY name ASC`);
  }

  async get(groupId: string): Promise<DeskGroup | null> {
    const rows = await this.sql<GroupRow[]>`SELECT id, name, created_by, created_at FROM support.groups WHERE id = ${groupId}`;
    return (await this.hydrate(rows))[0] ?? null;
  }

  async save(input: { id?: string; name: string; by: string; at: string }): Promise<DeskGroup | null> {
    try {
      return await this.sql.begin(async (tx) => {
        if (input.id) {
          const prior = await tx<GroupRow[]>`SELECT id, name FROM support.groups WHERE id = ${input.id} FOR UPDATE`;
          if (!prior[0]) return null;
          if (prior[0].name !== input.name) {
            await tx`UPDATE support.groups SET name = ${input.name} WHERE id = ${input.id}`;
            await tx`
              INSERT INTO support.group_log (group_id, action, subject, "by", "at")
              VALUES (${input.id}, 'renamed', ${input.name}, ${input.by}, ${input.at})
            `;
          }
          return (await this.getIn(tx, input.id))!;
        }
        const created = await tx<GroupRow[]>`
          INSERT INTO support.groups (name, created_by, created_at) VALUES (${input.name}, ${input.by}, ${input.at})
          RETURNING id, name, created_by, created_at
        `;
        const row = created[0]!;
        await tx`
          INSERT INTO support.group_log (group_id, action, subject, "by", "at")
          VALUES (${row.id}, 'created', ${input.name}, ${input.by}, ${input.at})
        `;
        return { id: row.id, name: row.name, createdBy: row.created_by, createdAt: iso(row.created_at), memberIds: [] };
      });
    } catch (err) {
      if (err instanceof Error && /groups_name_key|unique/i.test(err.message)) throw new Error('support.group_name_taken');
      throw err;
    }
  }

  private async getIn(tx: TransactionSql, groupId: string): Promise<DeskGroup | null> {
    const rows = await tx<GroupRow[]>`SELECT id, name, created_by, created_at FROM support.groups WHERE id = ${groupId}`;
    const row = rows[0];
    if (!row) return null;
    const members = await tx<
      { user_id: string }[]
    >`SELECT user_id FROM support.group_members WHERE group_id = ${groupId} ORDER BY user_id ASC`;
    return {
      id: row.id,
      name: row.name,
      createdBy: row.created_by,
      createdAt: iso(row.created_at),
      memberIds: members.map((m) => m.user_id),
    };
  }

  async addMember(input: { groupId: string; userId: string; by: string; at: string }): Promise<'added' | 'duplicate' | 'unknown_group'> {
    return this.sql.begin(async (tx) => {
      const group = await tx`SELECT 1 FROM support.groups WHERE id = ${input.groupId} FOR SHARE`;
      if (group.length === 0) return 'unknown_group' as const;
      const inserted = await tx`
        INSERT INTO support.group_members (group_id, user_id, added_by, added_at)
        VALUES (${input.groupId}, ${input.userId}, ${input.by}, ${input.at})
        ON CONFLICT (group_id, user_id) DO NOTHING RETURNING user_id
      `;
      if (inserted.length === 0) return 'duplicate' as const;
      await tx`
        INSERT INTO support.group_log (group_id, action, subject, "by", "at")
        VALUES (${input.groupId}, 'member_added', ${input.userId}, ${input.by}, ${input.at})
      `;
      return 'added' as const;
    });
  }

  async removeMember(input: { groupId: string; userId: string; by: string; at: string }): Promise<'removed' | 'absent' | 'unknown_group'> {
    return this.sql.begin(async (tx) => {
      const group = await tx`SELECT 1 FROM support.groups WHERE id = ${input.groupId} FOR SHARE`;
      if (group.length === 0) return 'unknown_group' as const;
      const deleted = await tx`
        DELETE FROM support.group_members WHERE group_id = ${input.groupId} AND user_id = ${input.userId} RETURNING user_id
      `;
      if (deleted.length === 0) return 'absent' as const;
      await tx`
        INSERT INTO support.group_log (group_id, action, subject, "by", "at")
        VALUES (${input.groupId}, 'member_removed', ${input.userId}, ${input.by}, ${input.at})
      `;
      return 'removed' as const;
    });
  }

  async groupsOfUser(userId: string): Promise<string[]> {
    const rows = await this.sql<{ group_id: string }[]>`SELECT group_id FROM support.group_members WHERE user_id = ${userId}`;
    return rows.map((r) => r.group_id);
  }

  async groupOfTicket(ticketId: string): Promise<string | null> {
    const rows = await this.sql<{ group_id: string }[]>`SELECT group_id FROM support.ticket_groups WHERE ticket_id = ${ticketId}`;
    return rows[0]?.group_id ?? null;
  }

  async setTicketGroup(input: { ticketId: string; groupId: string | null; by: string; at: string }): Promise<'ok' | 'unknown_group'> {
    return this.sql.begin(async (tx) => {
      if (input.groupId === null) {
        const removed = await tx<
          { group_id: string }[]
        >`DELETE FROM support.ticket_groups WHERE ticket_id = ${input.ticketId} RETURNING group_id`;
        if (removed[0]) {
          await tx`
            INSERT INTO support.group_log (group_id, action, subject, "by", "at")
            VALUES (${removed[0].group_id}, 'ticket_ungrouped', ${input.ticketId}, ${input.by}, ${input.at})
          `;
        }
        return 'ok' as const;
      }
      const group = await tx`SELECT 1 FROM support.groups WHERE id = ${input.groupId} FOR SHARE`;
      if (group.length === 0) return 'unknown_group' as const;
      const prior = await tx<
        { group_id: string }[]
      >`SELECT group_id FROM support.ticket_groups WHERE ticket_id = ${input.ticketId} FOR UPDATE`;
      if (prior[0]?.group_id === input.groupId) return 'ok' as const;
      await tx`
        INSERT INTO support.ticket_groups (ticket_id, group_id, set_by, set_at)
        VALUES (${input.ticketId}, ${input.groupId}, ${input.by}, ${input.at})
        ON CONFLICT (ticket_id) DO UPDATE SET group_id = EXCLUDED.group_id, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at
      `;
      await tx`
        INSERT INTO support.group_log (group_id, action, subject, "by", "at")
        VALUES (${input.groupId}, 'ticket_grouped', ${input.ticketId}, ${input.by}, ${input.at})
      `;
      return 'ok' as const;
    });
  }

  async groupedTickets(): Promise<Map<string, string>> {
    const rows = await this.sql<{ ticket_id: string; group_id: string }[]>`SELECT ticket_id, group_id FROM support.ticket_groups`;
    return new Map(rows.map((r) => [r.ticket_id, r.group_id]));
  }
}

export interface DeskViewer {
  readonly userId: string;
  readonly role: StaffRole | null;
  readonly groupIds: readonly string[];
}

/**
 * The visibility rule once any group exists. Assigned to you, in one of your
 * groups, or in nobody's group and you are a lead (so a new ticket can reach
 * a group), or the owner has marked your role as all-groups.
 */
export function deskCanSee(
  viewer: DeskViewer,
  ticket: { assigneeId: string | null },
  ticketGroupId: string | null,
  allGroupsRoles: readonly StaffRole[],
): boolean {
  if (ticket.assigneeId === viewer.userId) return true;
  if (viewer.role !== null && allGroupsRoles.includes(viewer.role)) return true;
  if (ticketGroupId === null) return viewer.role === 'lead';
  return viewer.groupIds.includes(ticketGroupId);
}
