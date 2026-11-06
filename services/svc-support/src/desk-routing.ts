/**
 * Automatic assignment, agent capacity and skills (SP-routing-01).
 *
 * Routing is set per desk group: off, in turn (round robin) or to the least loaded agent. A group with no routing row
 * has no routing set, and nothing is assigned automatically. A candidate is a member of the request's group who is on
 * the desk staff, online (folding in the owner's heartbeat window when it is set), has a capacity the owner set with
 * room under it, and holds the skill the request needs, if any. A blank capacity means the agent is never assigned
 * automatically. When no candidate exists the request stays queued and its routing state names
 * `support.no_agent_available`.
 *
 * One pass for one request runs in one transaction: the request row is locked, read again, assigned through the same
 * update a lead's assign makes, its `assigned` audit row is written and the group's cursor moves on. Two passes racing
 * on one request, or a pass racing a hand claim, lock the same row: the first wins and the other finds the request
 * assigned and does nothing. The cursor is stored, so it survives a restart.
 */
import type { Sql, TransactionSql } from 'postgres';
import type { GroupBook } from './desk-groups.js';
import type { StaffAvailability, StaffBook } from './desk-staff.js';
import { insertTicketEvent } from './store.js';
import { SupportError } from './support-service.js';

export const ROUTING_MODES = ['off', 'round_robin', 'load_balanced'] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export const NO_AGENT_AVAILABLE = 'support.no_agent_available' as const;
/** The actor named on an automatic assignment's audit row. */
export const ROUTING_ACTOR = 'support:routing';
/** Skills are short tags; the same rule binds an agent's skills and a request's need. */
export const SKILL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const SKILLS_MAX = 20;

export interface GroupRouting {
  readonly groupId: string;
  readonly mode: RoutingMode;
  readonly cursorUserId: string | null;
  readonly revision: number;
  readonly setBy: string;
  readonly setAt: string;
}

export interface StaffRouting {
  readonly userId: string;
  /** Null is blank: never assigned automatically. */
  readonly capacity: number | null;
  readonly skills: string[];
}

export interface TicketRouting {
  readonly ticketId: string;
  readonly requiredSkill: string | null;
  readonly state: 'assigned' | 'no_agent' | null;
  readonly stateAt: string | null;
}

export interface Candidate {
  readonly userId: string;
  readonly availability: StaffAvailability;
  readonly lastHeartbeatAt: string | null;
  readonly capacity: number | null;
  readonly skills: readonly string[];
  /** Open and pending requests assigned to this person now. */
  readonly load: number;
}

export type RouteOutcome =
  | {
      readonly status: 'assigned';
      readonly ticketId: string;
      readonly assigneeId: string;
      readonly groupId: string;
      readonly mode: RoutingMode;
    }
  | { readonly status: 'queued'; readonly ticketId: string; readonly groupId: string; readonly code: typeof NO_AGENT_AVAILABLE }
  | {
      readonly status: 'skipped';
      readonly ticketId: string;
      readonly reason: 'not_found' | 'not_queueable' | 'already_assigned' | 'ungrouped' | 'routing_unset' | 'routing_off';
    };

export type RoutingLogAction = 'mode_set' | 'capacity_set' | 'skills_set' | 'required_skill_set';

export interface RoutingLogEntry {
  readonly action: RoutingLogAction;
  readonly subject: string;
  readonly value: string | null;
  readonly by: string;
  readonly at: string;
}

/** True when this person may take a request now: online, fresh within the window, room under a set capacity, the skill. */
export function eligible(c: Candidate, requiredSkill: string | null, nowMs: number, heartbeatWindowSeconds: number | null): boolean {
  if (c.availability !== 'online') return false;
  if (heartbeatWindowSeconds !== null) {
    const beat = c.lastHeartbeatAt ? Date.parse(c.lastHeartbeatAt) : Number.NEGATIVE_INFINITY;
    if (nowMs - beat > heartbeatWindowSeconds * 1000) return false;
  }
  if (c.capacity === null || c.load >= c.capacity) return false;
  if (requiredSkill !== null && !c.skills.includes(requiredSkill)) return false;
  return true;
}

/**
 * The agent the next request goes to, or null. Candidates are taken in user id order. In turn: the first eligible one
 * after the cursor, wrapping round. Least loaded: the lowest load, ties broken in turn from the cursor.
 */
export function chooseAgent(
  candidates: readonly Candidate[],
  input: {
    mode: 'round_robin' | 'load_balanced';
    cursorUserId: string | null;
    requiredSkill: string | null;
    nowMs: number;
    heartbeatWindowSeconds: number | null;
  },
): Candidate | null {
  const ordered = [...candidates].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  const after = input.cursorUserId === null ? 0 : ordered.findIndex((c) => c.userId > input.cursorUserId!);
  const start = after < 0 ? 0 : after;
  const inTurn = [...ordered.slice(start), ...ordered.slice(0, start)].filter((c) =>
    eligible(c, input.requiredSkill, input.nowMs, input.heartbeatWindowSeconds),
  );
  if (inTurn.length === 0) return null;
  if (input.mode === 'round_robin') return inTurn[0]!;
  const least = Math.min(...inTurn.map((c) => c.load));
  return inTurn.find((c) => c.load === least)!;
}

export interface RoutingBook {
  groupRouting(): Promise<GroupRouting[]>;
  setMode(input: { groupId: string; mode: RoutingMode; by: string; at: string }): Promise<GroupRouting | null>;
  staffRouting(): Promise<StaffRouting[]>;
  setStaffRouting(input: { userId: string; capacity: number | null; skills: string[]; by: string; at: string }): Promise<StaffRouting>;
  ticketRouting(ticketIds: readonly string[]): Promise<TicketRouting[]>;
  setRequiredSkill(input: { ticketId: string; skill: string | null; by: string; at: string }): Promise<TicketRouting>;
  /** Unassigned open or pending requests placed in a group whose routing is on: what a sweep re-selects, by state. */
  routable(groupId?: string): Promise<string[]>;
  route(ticketId: string, at: string, heartbeatWindowSeconds: number | null): Promise<RouteOutcome>;
  log(subject?: string): Promise<RoutingLogEntry[]>;
}

const iso = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

type GroupRoutingRow = {
  group_id: string;
  mode: RoutingMode;
  cursor_user_id: string | null;
  revision: number;
  set_by: string;
  set_at: Date | string;
};
const fromGroupRow = (r: GroupRoutingRow): GroupRouting => ({
  groupId: r.group_id,
  mode: r.mode,
  cursorUserId: r.cursor_user_id,
  revision: r.revision,
  setBy: r.set_by,
  setAt: iso(r.set_at)!,
});

type TicketRoutingRow = {
  ticket_id: string;
  required_skill: string | null;
  state: 'assigned' | 'no_agent' | null;
  state_at: Date | string | null;
};
const fromTicketRow = (r: TicketRoutingRow): TicketRouting => ({
  ticketId: r.ticket_id,
  requiredSkill: r.required_skill,
  state: r.state,
  stateAt: iso(r.state_at),
});

export class SqlRoutingBook implements RoutingBook {
  constructor(private readonly sql: Sql) {}

  async groupRouting(): Promise<GroupRouting[]> {
    const rows = await this.sql<GroupRoutingRow[]>`
      SELECT group_id, mode, cursor_user_id, revision, set_by, set_at FROM support.group_routing ORDER BY group_id ASC
    `;
    return rows.map(fromGroupRow);
  }

  async setMode(input: { groupId: string; mode: RoutingMode; by: string; at: string }): Promise<GroupRouting | null> {
    return this.sql.begin(async (tx) => {
      const group = await tx<{ id: string }[]>`SELECT id FROM support.groups WHERE id = ${input.groupId} FOR UPDATE`;
      if (!group[0]) return null;
      const prior = await tx<GroupRoutingRow[]>`
        SELECT group_id, mode, cursor_user_id, revision, set_by, set_at FROM support.group_routing WHERE group_id = ${input.groupId} FOR UPDATE
      `;
      if (prior[0]?.mode === input.mode) return fromGroupRow(prior[0]);
      const rows = await tx<GroupRoutingRow[]>`
        INSERT INTO support.group_routing (group_id, mode, cursor_user_id, revision, set_by, set_at)
        VALUES (${input.groupId}, ${input.mode}, NULL, 1, ${input.by}, ${input.at})
        ON CONFLICT (group_id) DO UPDATE
          SET mode = EXCLUDED.mode, revision = support.group_routing.revision + 1, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at
        RETURNING group_id, mode, cursor_user_id, revision, set_by, set_at
      `;
      await logIn(tx, { action: 'mode_set', subject: input.groupId, value: input.mode, by: input.by, at: input.at });
      return fromGroupRow(rows[0]!);
    });
  }

  async staffRouting(): Promise<StaffRouting[]> {
    const rows = await this.sql<{ user_id: string; capacity: number | null; skills: string[] }[]>`
      SELECT user_id, capacity, skills FROM support.staff_routing ORDER BY user_id ASC
    `;
    return rows.map((r) => ({ userId: r.user_id, capacity: r.capacity, skills: [...r.skills] }));
  }

  async setStaffRouting(input: {
    userId: string;
    capacity: number | null;
    skills: string[];
    by: string;
    at: string;
  }): Promise<StaffRouting> {
    return this.sql.begin(async (tx) => {
      const prior = await tx<{ capacity: number | null; skills: string[] }[]>`
        SELECT capacity, skills FROM support.staff_routing WHERE user_id = ${input.userId} FOR UPDATE
      `;
      const was = prior[0] ?? { capacity: null, skills: [] };
      const skills = [...new Set(input.skills)].sort();
      await tx`
        INSERT INTO support.staff_routing (user_id, capacity, skills, set_by, set_at)
        VALUES (${input.userId}, ${input.capacity}, ${skills}, ${input.by}, ${input.at})
        ON CONFLICT (user_id) DO UPDATE SET capacity = EXCLUDED.capacity, skills = EXCLUDED.skills, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at
      `;
      if (was.capacity !== input.capacity)
        await logIn(tx, {
          action: 'capacity_set',
          subject: input.userId,
          value: input.capacity === null ? null : String(input.capacity),
          by: input.by,
          at: input.at,
        });
      if ([...was.skills].sort().join(',') !== skills.join(','))
        await logIn(tx, { action: 'skills_set', subject: input.userId, value: skills.join(','), by: input.by, at: input.at });
      return { userId: input.userId, capacity: input.capacity, skills };
    });
  }

  async ticketRouting(ticketIds: readonly string[]): Promise<TicketRouting[]> {
    if (ticketIds.length === 0) return [];
    const rows = await this.sql<TicketRoutingRow[]>`
      SELECT ticket_id, required_skill, state, state_at FROM support.ticket_routing WHERE ticket_id IN ${this.sql([...ticketIds])}
    `;
    return rows.map(fromTicketRow);
  }

  async setRequiredSkill(input: { ticketId: string; skill: string | null; by: string; at: string }): Promise<TicketRouting> {
    return this.sql.begin(async (tx) => {
      const prior = await tx<TicketRoutingRow[]>`
        SELECT ticket_id, required_skill, state, state_at FROM support.ticket_routing WHERE ticket_id = ${input.ticketId} FOR UPDATE
      `;
      if (prior[0] && prior[0].required_skill === input.skill) return fromTicketRow(prior[0]);
      if (!prior[0] && input.skill === null) return { ticketId: input.ticketId, requiredSkill: null, state: null, stateAt: null };
      const rows = await tx<TicketRoutingRow[]>`
        INSERT INTO support.ticket_routing (ticket_id, required_skill, set_by, set_at)
        VALUES (${input.ticketId}, ${input.skill}, ${input.by}, ${input.at})
        ON CONFLICT (ticket_id) DO UPDATE SET required_skill = EXCLUDED.required_skill, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at
        RETURNING ticket_id, required_skill, state, state_at
      `;
      await logIn(tx, { action: 'required_skill_set', subject: input.ticketId, value: input.skill, by: input.by, at: input.at });
      return fromTicketRow(rows[0]!);
    });
  }

  async routable(groupId?: string): Promise<string[]> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT t.id FROM support.tickets t
      JOIN support.ticket_groups g ON g.ticket_id = t.id
      JOIN support.group_routing r ON r.group_id = g.group_id AND r.mode <> 'off'
      WHERE t.assignee_id IS NULL AND t.status IN ('open', 'pending')
        ${groupId ? this.sql`AND g.group_id = ${groupId}` : this.sql``}
      ORDER BY t.created_at ASC, t.id ASC
    `;
    return rows.map((r) => r.id);
  }

  async route(ticketId: string, at: string, heartbeatWindowSeconds: number | null): Promise<RouteOutcome> {
    return this.sql.begin(async (tx): Promise<RouteOutcome> => {
      const ticket = await tx<{ id: string; status: string; assignee_id: string | null }[]>`
        SELECT id, status, assignee_id FROM support.tickets WHERE id = ${ticketId} FOR UPDATE
      `;
      const row = ticket[0];
      if (!row) return { status: 'skipped', ticketId, reason: 'not_found' };
      if (row.status !== 'open' && row.status !== 'pending') return { status: 'skipped', ticketId, reason: 'not_queueable' };
      if (row.assignee_id !== null) return { status: 'skipped', ticketId, reason: 'already_assigned' };
      const grouped = await tx<{ group_id: string }[]>`SELECT group_id FROM support.ticket_groups WHERE ticket_id = ${ticketId}`;
      const groupId = grouped[0]?.group_id;
      if (!groupId) return { status: 'skipped', ticketId, reason: 'ungrouped' };
      const routing = await tx<GroupRoutingRow[]>`
        SELECT group_id, mode, cursor_user_id, revision, set_by, set_at FROM support.group_routing WHERE group_id = ${groupId} FOR UPDATE
      `;
      const set = routing[0];
      if (!set) return { status: 'skipped', ticketId, reason: 'routing_unset' };
      if (set.mode === 'off') return { status: 'skipped', ticketId, reason: 'routing_off' };
      const need = await tx<
        { required_skill: string | null }[]
      >`SELECT required_skill FROM support.ticket_routing WHERE ticket_id = ${ticketId}`;
      const requiredSkill = need[0]?.required_skill ?? null;
      const candidates = await tx<
        {
          user_id: string;
          availability: StaffAvailability;
          last_heartbeat_at: Date | string | null;
          capacity: number | null;
          skills: string[] | null;
          load: string;
        }[]
      >`
        SELECT s.user_id, s.availability, s.last_heartbeat_at, r.capacity, r.skills,
          (SELECT count(*) FROM support.tickets t WHERE t.assignee_id = s.user_id AND t.status IN ('open', 'pending')) AS load
        FROM support.group_members m
        JOIN support.staff s ON s.user_id = m.user_id
        LEFT JOIN support.staff_routing r ON r.user_id = s.user_id
        WHERE m.group_id = ${groupId}
      `;
      const chosen = chooseAgent(
        candidates.map((c) => ({
          userId: c.user_id,
          availability: c.availability,
          lastHeartbeatAt: iso(c.last_heartbeat_at),
          capacity: c.capacity,
          skills: c.skills ?? [],
          load: Number(c.load),
        })),
        { mode: set.mode, cursorUserId: set.cursor_user_id, requiredSkill, nowMs: Date.parse(at), heartbeatWindowSeconds },
      );
      if (!chosen) {
        await tx`
          INSERT INTO support.ticket_routing (ticket_id, state, state_at) VALUES (${ticketId}, 'no_agent', ${at})
          ON CONFLICT (ticket_id) DO UPDATE SET state = 'no_agent', state_at = EXCLUDED.state_at
        `;
        return { status: 'queued', ticketId, groupId, code: NO_AGENT_AVAILABLE };
      }
      const assigned = await tx<{ status: string }[]>`
        UPDATE support.tickets
        SET assignee_id = ${chosen.userId}, status = CASE WHEN status = 'open' THEN 'pending' ELSE status END, updated_at = now()
        WHERE id = ${ticketId} AND assignee_id IS NULL
        RETURNING status
      `;
      if (!assigned[0]) return { status: 'skipped', ticketId, reason: 'already_assigned' };
      await insertTicketEvent(tx, {
        ticketId,
        kind: 'assigned',
        actorId: ROUTING_ACTOR,
        actorRole: 'operator',
        note: `route:${set.mode}:${chosen.userId}`,
      });
      if (row.status !== assigned[0].status) {
        await insertTicketEvent(tx, {
          ticketId,
          kind: 'status_changed',
          actorId: ROUTING_ACTOR,
          actorRole: 'operator',
          fromStatus: row.status as 'open',
          toStatus: assigned[0].status as 'pending',
        });
      }
      await tx`UPDATE support.group_routing SET cursor_user_id = ${chosen.userId} WHERE group_id = ${groupId}`;
      await tx`
        INSERT INTO support.ticket_routing (ticket_id, state, state_at) VALUES (${ticketId}, 'assigned', ${at})
        ON CONFLICT (ticket_id) DO UPDATE SET state = 'assigned', state_at = EXCLUDED.state_at
      `;
      return { status: 'assigned', ticketId, assigneeId: chosen.userId, groupId, mode: set.mode };
    });
  }

  async log(subject?: string): Promise<RoutingLogEntry[]> {
    const rows = await this.sql<{ action: RoutingLogAction; subject: string; value: string | null; by: string; at: Date | string }[]>`
      SELECT action, subject, value, "by", "at" FROM support.routing_log
      ${subject ? this.sql`WHERE subject = ${subject}` : this.sql``}
      ORDER BY id ASC
    `;
    return rows.map((r) => ({ action: r.action, subject: r.subject, value: r.value, by: r.by, at: iso(r.at)! }));
  }
}

async function logIn(tx: TransactionSql, entry: RoutingLogEntry): Promise<void> {
  await tx`
    INSERT INTO support.routing_log (action, subject, value, "by", "at")
    VALUES (${entry.action}, ${entry.subject}, ${entry.value}, ${entry.by}, ${entry.at})
  `;
}

/** What the desk can see and do about routing. Every write is a lead's, and names who made it. */
export class DeskRouting {
  constructor(
    private readonly book: RoutingBook,
    private readonly staff: StaffBook,
    private readonly groups: GroupBook,
    private readonly desk: { assertDeskVisible(viewerId: string, ticketId: string): Promise<void> },
    /** The owner's heartbeat window (seconds); blank folds nothing in, as the directory does. */
    private readonly heartbeatWindowSeconds: number | null = null,
    /** The owner's sweep interval (seconds); blank means no sweep runs and routing happens on desk actions only. */
    readonly sweepSeconds: number | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async lead(actorId: string): Promise<void> {
    const actor = await this.staff.get(actorId);
    if (!actor) throw new SupportError('only staff can change routing', 'support.not_staff');
    if (actor.role !== 'lead') throw new SupportError('only a lead can change routing', 'support.not_lead');
  }

  private async member(actorId: string): Promise<void> {
    if (!(await this.staff.get(actorId))) throw new SupportError('only staff can read routing', 'support.not_staff');
  }

  /** Every live group with its routing, `mode: null` where none is set. */
  async overview(actorId: string): Promise<{
    groups: {
      groupId: string;
      name: string;
      mode: RoutingMode | null;
      cursorUserId: string | null;
      setBy: string | null;
      setAt: string | null;
    }[];
    staff: StaffRouting[];
    sweepSeconds: number | null;
  }> {
    await this.member(actorId);
    const [groups, routing, staff] = await Promise.all([this.groups.list(), this.book.groupRouting(), this.book.staffRouting()]);
    const byGroup = new Map(routing.map((r) => [r.groupId, r]));
    return {
      groups: groups.map((g) => {
        const r = byGroup.get(g.id);
        return {
          groupId: g.id,
          name: g.name,
          mode: r?.mode ?? null,
          cursorUserId: r?.cursorUserId ?? null,
          setBy: r?.setBy ?? null,
          setAt: r?.setAt ?? null,
        };
      }),
      staff,
      sweepSeconds: this.sweepSeconds,
    };
  }

  /** Set a group's routing; turning it on routes the group's waiting requests at once. */
  async setMode(
    actorId: string,
    input: { groupId: string; mode: RoutingMode },
  ): Promise<{ routing: GroupRouting; routed: RouteOutcome[] }> {
    await this.lead(actorId);
    if (!ROUTING_MODES.includes(input.mode))
      throw new SupportError('routing mode must be off, round_robin or load_balanced', 'support.routing_mode_invalid');
    const routing = await this.book.setMode({ ...input, by: actorId, at: this.now().toISOString() });
    if (!routing) throw new SupportError('that group does not exist', 'support.group_unknown');
    return { routing, routed: routing.mode === 'off' ? [] : await this.routeGroup(input.groupId) };
  }

  /** An agent's capacity (null is blank: never assigned automatically) and skills. */
  async setStaffRouting(actorId: string, input: { userId: string; capacity: number | null; skills: string[] }): Promise<StaffRouting> {
    await this.lead(actorId);
    if (!(await this.staff.get(input.userId))) throw new SupportError('that person is not on the desk staff', 'support.not_staff');
    if (input.capacity !== null && (!Number.isInteger(input.capacity) || input.capacity < 0 || input.capacity > 10_000))
      throw new SupportError('capacity must be a whole number from 0', 'support.capacity_invalid');
    const skills = input.skills.map((s) => s.trim().toLowerCase());
    if (skills.length > SKILLS_MAX || skills.some((s) => !SKILL_PATTERN.test(s)))
      throw new SupportError('a skill is a short tag of letters, digits, - or _', 'support.skill_invalid');
    return this.book.setStaffRouting({ userId: input.userId, capacity: input.capacity, skills, by: actorId, at: this.now().toISOString() });
  }

  /** The skill a request needs, or null for none; then the request is routed again. */
  async setRequiredSkill(
    actorId: string,
    input: { ticketId: string; skill: string | null },
  ): Promise<{ routing: TicketRouting; outcome: RouteOutcome }> {
    await this.lead(actorId);
    await this.desk.assertDeskVisible(actorId, input.ticketId);
    const skill = input.skill === null ? null : input.skill.trim().toLowerCase();
    if (skill !== null && !SKILL_PATTERN.test(skill))
      throw new SupportError('a skill is a short tag of letters, digits, - or _', 'support.skill_invalid');
    await this.book.setRequiredSkill({ ticketId: input.ticketId, skill, by: actorId, at: this.now().toISOString() });
    const outcome = await this.route(input.ticketId);
    return { routing: (await this.book.ticketRouting([input.ticketId]))[0]!, outcome };
  }

  /** One request's routing state, as the desk sees it. */
  async ticketState(
    actorId: string,
    ticketId: string,
  ): Promise<{
    ticketId: string;
    requiredSkill: string | null;
    state: 'assigned' | 'no_agent' | null;
    code: typeof NO_AGENT_AVAILABLE | null;
    stateAt: string | null;
  }> {
    await this.member(actorId);
    await this.desk.assertDeskVisible(actorId, ticketId);
    const row = (await this.book.ticketRouting([ticketId]))[0];
    return {
      ticketId,
      requiredSkill: row?.requiredSkill ?? null,
      state: row?.state ?? null,
      code: row?.state === 'no_agent' ? NO_AGENT_AVAILABLE : null,
      stateAt: row?.stateAt ?? null,
    };
  }

  /** Requests in a routed group still waiting because no agent could take them. */
  async waiting(actorId: string): Promise<{ ticketId: string; code: typeof NO_AGENT_AVAILABLE; since: string | null }[]> {
    await this.member(actorId);
    const ids = await this.book.routable();
    const states = await this.book.ticketRouting(ids);
    const out: { ticketId: string; code: typeof NO_AGENT_AVAILABLE; since: string | null }[] = [];
    for (const s of states) {
      if (s.state !== 'no_agent') continue;
      try {
        await this.desk.assertDeskVisible(actorId, s.ticketId);
        out.push({ ticketId: s.ticketId, code: NO_AGENT_AVAILABLE, since: s.stateAt });
      } catch {
        // Outside the caller's scope: not listed.
      }
    }
    return out;
  }

  /** A routing pass for one request, as the worker runs it. */
  async run(actorId: string, ticketId: string): Promise<RouteOutcome> {
    await this.member(actorId);
    await this.desk.assertDeskVisible(actorId, ticketId);
    return this.route(ticketId);
  }

  async log(actorId: string, subject?: string): Promise<RoutingLogEntry[]> {
    await this.member(actorId);
    return this.book.log(subject);
  }

  /** The worker's pass: one request, one transaction. Used after a desk action and by the sweep. */
  route(ticketId: string): Promise<RouteOutcome> {
    return this.book.route(ticketId, this.now().toISOString(), this.heartbeatWindowSeconds);
  }

  /** Every waiting request in one group (or every routed group), oldest first. */
  async routeGroup(groupId?: string): Promise<RouteOutcome[]> {
    const out: RouteOutcome[] = [];
    for (const id of await this.book.routable(groupId)) out.push(await this.route(id));
    return out;
  }
}
