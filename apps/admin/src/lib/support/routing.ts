import type { StaffMemberView } from './staff';
import type { ProcedureOutput } from '@intafaced/contracts/procedure';
import type {
  SUPPORT_DESK_GROUPS_LOG,
  SUPPORT_DESK_ROUTING_SET_MODE,
  SUPPORT_DESK_TICKET_SET_SKILL,
} from '@intafaced/contracts/support-desk-procedures';

/**
 * Who gets which request (SP-routing-01), and the logs the agent directory and the group settings read (SP-agents-01,
 * SP-desk-04), as the console reads and sets them.
 *
 * svc-support routes a request placed in a group whose routing is on: in turn (round robin) or to the least loaded agent,
 * among the people with capacity, the request's skill and an online status. Capacity is blank until a lead sets it, and a
 * blank capacity means the person is never assigned automatically. A request no agent can take waits with
 * `support.no_agent_available`. Everything here is exactly svc-support's answer; a shape that does not read is null.
 */

export const ROUTING_MODES = ['off', 'round_robin', 'load_balanced'] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];
export const NO_AGENT_AVAILABLE = 'support.no_agent_available' as const;
type SupportGroupLog = ProcedureOutput<typeof SUPPORT_DESK_GROUPS_LOG>;
type SupportRoutingSetModeReply = ProcedureOutput<typeof SUPPORT_DESK_ROUTING_SET_MODE>;
type SupportRequiredSkillReply = ProcedureOutput<typeof SUPPORT_DESK_TICKET_SET_SKILL>;
/** The same rule svc-support binds an agent's skills and a request's need with. */
export const SKILL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const SKILLS_MAX = 20;
export const CAPACITY_MAX = 10_000;

const MODE_WORDS: Readonly<Record<RoutingMode, string>> = { off: 'Off', round_robin: 'In turn', load_balanced: 'Least loaded' };

/** A group's routing mode in words. Null means no lead has set one. */
export function modeWords(mode: RoutingMode | null): string {
  return mode === null ? 'Not set' : MODE_WORDS[mode];
}

export interface GroupRoutingRow {
  readonly groupId: string;
  readonly name: string;
  readonly mode: RoutingMode | null;
  readonly cursorUserId: string | null;
  readonly setBy: string | null;
  readonly setAt: string | null;
}

export interface StaffRoutingRow {
  readonly userId: string;
  /** Null is blank: never assigned automatically. */
  readonly capacity: number | null;
  readonly skills: readonly string[];
}

export interface RoutingOverview {
  readonly groups: readonly GroupRoutingRow[];
  /** Only people a lead has set routing for. Someone not listed has a blank capacity and no skills. */
  readonly staff: readonly StaffRoutingRow[];
  readonly sweepSeconds: number | null;
}

export interface TicketRoutingView {
  readonly ticketId: string;
  readonly requiredSkill: string | null;
  readonly state: 'assigned' | 'no_agent' | null;
  readonly code: typeof NO_AGENT_AVAILABLE | null;
  readonly stateAt: string | null;
}

export interface WaitingRow {
  readonly ticketId: string;
  readonly code: typeof NO_AGENT_AVAILABLE;
  readonly since: string | null;
}

export interface AvailabilityLogRow {
  readonly userId: string;
  readonly availability: 'online' | 'busy' | 'offline';
  readonly by: string;
  readonly reason: string | null;
  readonly at: string;
}

export const GROUP_LOG_ACTIONS = ['created', 'renamed', 'member_added', 'member_removed', 'ticket_grouped', 'ticket_ungrouped'] as const;
export type GroupLogAction = (typeof GROUP_LOG_ACTIONS)[number];

export const GROUP_LOG_WORDS: Readonly<Record<GroupLogAction, string>> = {
  created: 'Created',
  renamed: 'Renamed',
  member_added: 'Member added',
  member_removed: 'Member removed',
  ticket_grouped: 'Request placed',
  ticket_ungrouped: 'Request taken out',
};

export interface GroupLogRow {
  readonly groupId: string;
  readonly action: GroupLogAction;
  readonly subject: string | null;
  readonly by: string;
  readonly at: string;
}

const isMode = (v: unknown): v is RoutingMode => typeof v === 'string' && (ROUTING_MODES as readonly string[]).includes(v);
const isGroupLogAction = (v: string): v is GroupLogAction => (GROUP_LOG_ACTIONS as readonly string[]).includes(v);

/** `groupsLog`, oldest first. An action this console has no words for is not guessed at: the whole log is unread. */
export function groupLogRows(rows: SupportGroupLog): GroupLogRow[] | null {
  const out: GroupLogRow[] = [];
  for (const row of rows) {
    if (!isGroupLogAction(row.action)) return null;
    out.push({ ...row, action: row.action });
  }
  return out;
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
  | { readonly status: 'skipped'; readonly ticketId: string; readonly reason: string };

export interface SetModeResult {
  readonly routing: { readonly groupId: string; readonly mode: RoutingMode; readonly cursorUserId: string | null };
  readonly routed: readonly RouteOutcome[];
}

/** `routingSetMode`'s answer, as the desk shows it. */
export function setModeResult(reply: SupportRoutingSetModeReply): SetModeResult {
  const { groupId, mode, cursorUserId } = reply.routing;
  return { routing: { groupId, mode, cursorUserId }, routed: reply.routed };
}

export interface RequiredSkillResult {
  readonly requiredSkill: string | null;
  readonly outcome: RouteOutcome;
}

/** `ticketSetRequiredSkill`'s answer, as the desk shows it. */
export function requiredSkillResult(reply: SupportRequiredSkillReply): RequiredSkillResult {
  return { requiredSkill: reply.routing.requiredSkill, outcome: reply.outcome };
}

/** What one routing pass did, in a sentence, from svc-support's answer. */
export function outcomeWords(o: RouteOutcome): string {
  if (o.status === 'assigned') return `it was assigned automatically to ${o.assigneeId}`;
  if (o.status === 'queued') return `no agent is available to take it, so it waits (${o.code})`;
  return `it was not routed (${o.reason})`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export type RoutingActionRequest =
  | { readonly action: 'routing_mode'; readonly groupId: string; readonly mode: RoutingMode }
  | { readonly action: 'staff_routing'; readonly userId: string; readonly capacity: number | null; readonly skills: readonly string[] }
  | { readonly action: 'ticket_skill'; readonly ticketId: string; readonly skill: string | null };

const isCapacityInput = (v: unknown): v is number | null =>
  v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= CAPACITY_MAX);

/** Strict reader for the browser's request. Anything that is not exactly this shape is null and nothing is sent. */
export function readRoutingActionRequest(raw: Record<string, unknown>): RoutingActionRequest | null {
  if (raw.action === 'routing_mode') {
    if (!isUuid(raw.groupId) || !isMode(raw.mode)) return null;
    return { action: 'routing_mode', groupId: raw.groupId, mode: raw.mode };
  }
  if (raw.action === 'staff_routing') {
    if (!isUuid(raw.userId) || !isCapacityInput(raw.capacity)) return null;
    if (!Array.isArray(raw.skills) || raw.skills.length > SKILLS_MAX) return null;
    if (!raw.skills.every((s) => typeof s === 'string' && SKILL_PATTERN.test(s))) return null;
    if (new Set(raw.skills).size !== raw.skills.length) return null;
    return { action: 'staff_routing', userId: raw.userId, capacity: raw.capacity, skills: [...(raw.skills as string[])] };
  }
  if (raw.action === 'ticket_skill') {
    if (!isUuid(raw.ticketId)) return null;
    if (raw.skill !== null && !(typeof raw.skill === 'string' && SKILL_PATTERN.test(raw.skill))) return null;
    return { action: 'ticket_skill', ticketId: raw.ticketId, skill: raw.skill };
  }
  return null;
}

/** A typed capacity: blank is "not set" (null); anything but a whole number from 0 is refused here. */
export function parseCapacity(text: string): { ok: true; value: number | null } | { ok: false; why: string } {
  const t = text.trim();
  if (t === '') return { ok: true, value: null };
  if (!/^\d+$/.test(t) || Number(t) > CAPACITY_MAX)
    return { ok: false, why: `Capacity is a whole number from 0 to ${CAPACITY_MAX}, or blank for not set.` };
  return { ok: true, value: Number(t) };
}

/** Comma-separated skills, lowercased and trimmed, each a short tag. Repeats are kept once. */
export function parseSkills(text: string): { ok: true; value: string[] } | { ok: false; why: string } {
  const tags = [
    ...new Set(
      text
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s !== ''),
    ),
  ];
  const bad = tags.find((s) => !SKILL_PATTERN.test(s));
  if (bad) return { ok: false, why: `A skill is a short tag of letters, digits, - or _ (up to 40). "${bad}" is not.` };
  if (tags.length > SKILLS_MAX) return { ok: false, why: `A person can have at most ${SKILLS_MAX} skills.` };
  return { ok: true, value: tags };
}

export type RoutingGate = { readonly ok: true } | { readonly ok: false; readonly why: string };

export const ROUTING_LEAD_ONLY = 'Only a lead can change routing.';

function leadGate(me: StaffMemberView | null, busy: boolean): RoutingGate {
  if (busy) return { ok: false, why: 'A step is already in progress.' };
  if (!me) return { ok: false, why: 'You are not on the support staff list.' };
  if (me.role !== 'lead') return { ok: false, why: ROUTING_LEAD_ONLY };
  return { ok: true };
}

export function modeGate(me: StaffMemberView | null, group: GroupRoutingRow | null, mode: RoutingMode, busy: boolean): RoutingGate {
  const lead = leadGate(me, busy);
  if (!lead.ok) return lead;
  if (!group) return { ok: false, why: 'Pick a group first.' };
  if (group.mode === mode) return { ok: false, why: `Routing is already ${modeWords(mode)}.` };
  return { ok: true };
}

export function staffRoutingGate(
  me: StaffMemberView | null,
  targetId: string,
  capacityText: string,
  skillsText: string,
  current: StaffRoutingRow | null,
  busy: boolean,
): RoutingGate {
  const lead = leadGate(me, busy);
  if (!lead.ok) return lead;
  if (!targetId) return { ok: false, why: 'Pick a person first.' };
  const cap = parseCapacity(capacityText);
  if (!cap.ok) return cap;
  const skills = parseSkills(skillsText);
  if (!skills.ok) return skills;
  const was = current ?? { capacity: null, skills: [] };
  if (cap.value === was.capacity && skills.value.join(',') === [...was.skills].join(','))
    return { ok: false, why: 'That is already their routing.' };
  return { ok: true };
}

export function skillGate(me: StaffMemberView | null, skillText: string, current: TicketRoutingView | null, busy: boolean): RoutingGate {
  const lead = leadGate(me, busy);
  if (!lead.ok) return lead;
  if (!current) return { ok: false, why: 'The request’s routing could not be read.' };
  const t = skillText.trim().toLowerCase();
  if (t !== '' && !SKILL_PATTERN.test(t)) return { ok: false, why: 'A skill is a short tag of letters, digits, - or _ (up to 40).' };
  if ((t === '' ? null : t) === current.requiredSkill)
    return { ok: false, why: t === '' ? 'No skill is needed already.' : `It already needs ${t}.` };
  return { ok: true };
}

/** A request's routing state in words. */
export function ticketStateWords(r: TicketRoutingView): string {
  if (r.state === 'assigned') return 'Assigned automatically';
  if (r.state === 'no_agent') return 'No agent available';
  return 'Not routed';
}
