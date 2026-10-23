/**
 * The maintenance desk (SP-status-03): scheduled maintenance windows on svc-notify's notice board as the founders see
 * them (drafts too), with the state svc-notify derives, the operators' moves and the reminders. Pure and browser safe.
 *
 * A window is published like any notice: the author asks identity for an approval bound to the exact draft (reminder
 * offsets included), a different founder approves it, and the founder who asked publishes it.
 */
import type { Part } from '@/lib/desk/part';
import type { PublishApproval } from './incidents-model';

export const MAINTENANCE_STATES = ['scheduled', 'in_progress', 'verifying', 'completed', 'cancelled'] as const;
export type MaintenanceState = (typeof MAINTENANCE_STATES)[number];
export const MAINTENANCE_TARGETS = ['verifying', 'completed', 'cancelled', 'in_progress'] as const;
export type MaintenanceTarget = (typeof MAINTENANCE_TARGETS)[number];

/** svc-notify's storage bounds for reminders: at most 10, each 1 minute to 30 days before the start. */
export const REMINDERS_MAX = 10;
export const REMINDER_MINUTES_MAX = 43_200;

export interface MaintenanceWindow {
  readonly notice: {
    readonly id: string;
    readonly title: string;
    readonly body: string;
    readonly status: 'draft' | 'published';
    readonly publishedAt: string | null;
    readonly startsAt: string | null;
    readonly endsAt: string | null;
    readonly version: number;
    readonly components: readonly string[];
    readonly reminderOffsets: readonly number[];
    readonly authorId: string;
    readonly createdAt: string;
  };
  readonly state: MaintenanceState | null;
  readonly moves: readonly { readonly state: string; readonly movedBy: string; readonly reason: string; readonly movedAt: string }[];
  readonly reminders: readonly {
    readonly offsetMinutes: number;
    readonly dueAt: string;
    readonly sentAt: string | null;
    readonly skipped: string | null;
  }[];
}

export interface MaintenanceDeskView {
  readonly windows: Part<readonly MaintenanceWindow[]>;
  readonly components: Part<readonly { readonly id: string; readonly name: string }[]>;
  readonly approvals: Part<readonly PublishApproval[]>;
  readonly me: string;
  readonly asOf: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const ints = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => Number.isInteger(x));
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function readNotice(n: unknown): MaintenanceWindow['notice'] | null {
  if (
    !isRecord(n) ||
    typeof n.id !== 'string' ||
    typeof n.title !== 'string' ||
    typeof n.body !== 'string' ||
    (n.status !== 'draft' && n.status !== 'published') ||
    !strOrNull(n.publishedAt) ||
    !strOrNull(n.startsAt) ||
    !strOrNull(n.endsAt) ||
    !Number.isInteger(n.version) ||
    !strings(n.components) ||
    !ints(n.reminderOffsets) ||
    typeof n.authorId !== 'string' ||
    typeof n.createdAt !== 'string'
  )
    return null;
  return {
    id: n.id,
    title: n.title,
    body: n.body,
    status: n.status,
    publishedAt: n.publishedAt,
    startsAt: n.startsAt,
    endsAt: n.endsAt,
    version: n.version as number,
    components: n.components,
    reminderOffsets: n.reminderOffsets,
    authorId: n.authorId,
    createdAt: n.createdAt,
  };
}

/** svc-notify's windows, read whole or not at all. */
export function readWindows(raw: unknown): MaintenanceWindow[] | null {
  if (!Array.isArray(raw)) return null;
  const out: MaintenanceWindow[] = [];
  for (const w of raw) {
    if (!isRecord(w)) return null;
    const notice = readNotice(w.notice);
    const state = w.state;
    if (!notice || !(state === null || (MAINTENANCE_STATES as readonly unknown[]).includes(state))) return null;
    if (!Array.isArray(w.moves) || !Array.isArray(w.reminders)) return null;
    const moves: MaintenanceWindow['moves'][number][] = [];
    for (const m of w.moves) {
      if (
        !isRecord(m) ||
        typeof m.state !== 'string' ||
        typeof m.movedBy !== 'string' ||
        typeof m.reason !== 'string' ||
        typeof m.movedAt !== 'string'
      )
        return null;
      moves.push({ state: m.state, movedBy: m.movedBy, reason: m.reason, movedAt: m.movedAt });
    }
    const reminders: MaintenanceWindow['reminders'][number][] = [];
    for (const r of w.reminders) {
      if (
        !isRecord(r) ||
        !Number.isInteger(r.offsetMinutes) ||
        typeof r.dueAt !== 'string' ||
        !strOrNull(r.sentAt) ||
        !strOrNull(r.skipped)
      )
        return null;
      reminders.push({ offsetMinutes: r.offsetMinutes as number, dueAt: r.dueAt, sentAt: r.sentAt, skipped: r.skipped });
    }
    out.push({ notice, state: state as MaintenanceState | null, moves, reminders });
  }
  return out;
}

/** "30, 10" as reminder offsets in minutes; blank is none. Null when a part is not a whole number in range. */
export function parseOffsets(text: string): number[] | null {
  const parts = text
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length > REMINDERS_MAX) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 1 || n > REMINDER_MINUTES_MAX) return null;
    out.push(n);
  }
  return [...new Set(out)].sort((a, b) => b - a);
}

export interface MaintenanceDraftInput {
  readonly title: string;
  readonly body: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly components: readonly string[];
  readonly reminderOffsets: readonly number[];
}

/** Checked before it leaves the browser; svc-notify checks it again. */
export function checkMaintenanceDraft(input: MaintenanceDraftInput): { ok: true } | { ok: false; why: string } {
  if (input.title.trim() === '' || input.title.trim().length > 200) return { ok: false, why: 'The title is 1 to 200 characters.' };
  if (input.body.trim() === '' || input.body.trim().length > 8000) return { ok: false, why: 'The message is 1 to 8000 characters.' };
  const start = Date.parse(input.startsAt);
  const end = Date.parse(input.endsAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return { ok: false, why: 'Name when the window starts and when it is planned to end.' };
  if (end <= start) return { ok: false, why: 'The planned end is after the start.' };
  return { ok: true };
}
