import type { StaffMemberView } from './staff';

/**
 * Desk groups: which tickets a group of staff can see. A lead makes and renames groups and puts staff in them; everyone on
 * the staff list can read them. Once any group exists, an agent sees the tickets of the groups they belong to, and leads see
 * ungrouped ones too. What a person sees is decided by svc-support; this screen only reads and sets the groups.
 */

export interface DeskGroupView {
  readonly id: string;
  readonly name: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly memberIds: readonly string[];
}

export interface DeskScopeView {
  readonly restricted: boolean;
  readonly groups: readonly { readonly id: string; readonly name: string }[];
  readonly seesAllGroups: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const GROUP_NAME_MAX = 80;
export const KEY_MIN = 8;
export const KEY_MAX = 200;

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const isText = (v: unknown): v is string => typeof v === 'string' && v !== '';
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export function readGroup(raw: unknown): DeskGroupView | null {
  if (!isRecord(raw)) return null;
  const { id, name, createdBy, createdAt, memberIds } = raw;
  if (!isText(id) || !isText(name) || !isText(createdBy)) return null;
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) return null;
  if (!Array.isArray(memberIds) || !memberIds.every(isText)) return null;
  return { id, name, createdBy, createdAt, memberIds: memberIds as string[] };
}

/** Every group must read, or the answer is null, never a shorter list. */
export function readGroups(raw: unknown): DeskGroupView[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DeskGroupView[] = [];
  for (const row of raw) {
    const g = readGroup(row);
    if (!g) return null;
    out.push(g);
  }
  return out;
}

export function readDeskScope(raw: unknown): DeskScopeView | null {
  if (!isRecord(raw)) return null;
  const { restricted, groups, seesAllGroups } = raw;
  if (typeof restricted !== 'boolean' || typeof seesAllGroups !== 'boolean' || !Array.isArray(groups)) return null;
  const out: { id: string; name: string }[] = [];
  for (const g of groups) {
    if (!isRecord(g) || !isText(g.id) || !isText(g.name)) return null;
    out.push({ id: g.id, name: g.name });
  }
  return { restricted, groups: out, seesAllGroups };
}

export type GroupActionRequest =
  | { readonly action: 'group_save'; readonly groupId?: string; readonly name: string; readonly idempotencyKey: string }
  | { readonly action: 'group_member'; readonly op: 'add' | 'remove'; readonly groupId: string; readonly userId: string };

/** Strict reader for the browser's request; anything else is null and nothing is sent. */
export function readGroupActionRequest(raw: Record<string, unknown>): GroupActionRequest | null {
  if (raw.action === 'group_save') {
    if (typeof raw.name !== 'string' || raw.name.trim() === '' || raw.name.trim().length > GROUP_NAME_MAX) return null;
    if (typeof raw.idempotencyKey !== 'string' || raw.idempotencyKey.length < KEY_MIN || raw.idempotencyKey.length > KEY_MAX) return null;
    if (raw.groupId !== undefined && !isUuid(raw.groupId)) return null;
    return {
      action: 'group_save',
      name: raw.name.trim(),
      idempotencyKey: raw.idempotencyKey,
      ...(raw.groupId === undefined ? {} : { groupId: raw.groupId as string }),
    };
  }
  if (raw.action === 'group_member') {
    if ((raw.op !== 'add' && raw.op !== 'remove') || !isUuid(raw.groupId) || !isUuid(raw.userId)) return null;
    return { action: 'group_member', op: raw.op, groupId: raw.groupId, userId: raw.userId };
  }
  return null;
}

export type GroupGate = { readonly ok: true } | { readonly ok: false; readonly why: string };

const LEAD_ONLY = 'Only a lead can make or change groups.';

export function saveGate(
  me: StaffMemberView | null,
  name: string,
  groups: readonly DeskGroupView[],
  editing: string | null,
  busy: boolean,
): GroupGate {
  if (busy) return { ok: false, why: 'A step is already in progress.' };
  if (!me) return { ok: false, why: 'You are not on the support staff list.' };
  if (me.role !== 'lead') return { ok: false, why: LEAD_ONLY };
  const clean = name.trim();
  if (clean === '') return { ok: false, why: 'Give the group a name first.' };
  if (clean.length > GROUP_NAME_MAX) return { ok: false, why: `A group name can be at most ${GROUP_NAME_MAX} characters.` };
  const taken = groups.find((g) => g.name.toLowerCase() === clean.toLowerCase() && g.id !== editing);
  if (taken) return { ok: false, why: 'A group with that name exists.' };
  if (editing && groups.find((g) => g.id === editing)?.name === clean) return { ok: false, why: 'That is already its name.' };
  return { ok: true };
}

export function memberGate(
  me: StaffMemberView | null,
  group: DeskGroupView | null,
  userId: string,
  op: 'add' | 'remove',
  roster: readonly StaffMemberView[],
  busy: boolean,
): GroupGate {
  if (busy) return { ok: false, why: 'A step is already in progress.' };
  if (!me) return { ok: false, why: 'You are not on the support staff list.' };
  if (me.role !== 'lead') return { ok: false, why: LEAD_ONLY };
  if (!group) return { ok: false, why: 'Pick a group first.' };
  if (!userId) return { ok: false, why: 'Pick a person first.' };
  const isMember = group.memberIds.includes(userId);
  if (op === 'add' && !roster.some((m) => m.userId === userId)) return { ok: false, why: 'That person is not on the support staff list.' };
  if (op === 'add' && isMember) return { ok: false, why: 'Already in this group.' };
  if (op === 'remove' && !isMember) return { ok: false, why: 'Not in this group.' };
  return { ok: true };
}

/** One plain sentence for the signed-in person's own scope, as svc-support reports it. */
export function scopeSentence(scope: DeskScopeView): string {
  if (!scope.restricted) return 'No groups are set up, so the whole desk sees every ticket.';
  if (scope.seesAllGroups) return 'Groups are set up, and your role is set to see every group’s tickets.';
  return scope.groups.length === 0
    ? 'Groups are set up and you are in none, so you see the tickets assigned to you (and ungrouped ones if you are a lead).'
    : `Groups are set up. You see the tickets in ${scope.groups.map((g) => g.name).join(', ')} and the ones assigned to you.`;
}
