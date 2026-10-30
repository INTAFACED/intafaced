/**
 * Token governance settings and roles as svc-token answers them (`governance.*`, MC-token-02, J-more-catalogue-10). A blank
 * setting is null, never a default; every figure is a whole number of milliseconds as a decimal string.
 */

export const GOVERNANCE_ROLES = ['controller', 'admin', 'moderator', 'author'] as const;
export type GovernanceRole = (typeof GOVERNANCE_ROLES)[number];

/** What a role may do, in plain words. */
export const ROLE_WORDS: Readonly<Record<GovernanceRole, string>> = {
  controller: 'Controller: may cancel any draft or open proposal',
  admin: 'Admin: may cancel any draft or open proposal',
  moderator: 'Moderator: may cancel any draft or open proposal',
  author: 'Author: writes proposals, cancels none',
};

/** A whole number of milliseconds, as svc-token stores it. */
export const MS = /^(?:0|[1-9][0-9]{0,14})$/;
/** An account id as svc-token keys a role. */
export const ROLE_USER = /^[A-Za-z0-9._:-]{1,128}$/;
const HOUR = 3_600_000n;
/** The longest delay or period svc-token stores: one year, in hours. */
export const MAX_HOURS = 365 * 24;

export interface GovernanceSettings {
  readonly votingDelayMs: string | null;
  readonly votingPeriodMs: string | null;
  readonly revision: number;
}

export interface SettingsMove {
  readonly ordinal: number;
  readonly votingDelayMs: string | null;
  readonly votingPeriodMs: string | null;
  readonly actorId: string;
  readonly approverId: string;
  readonly at: string;
}

export interface RoleRow {
  readonly userId: string;
  /** Null once revoked; the row keeps its revision. */
  readonly role: GovernanceRole | null;
  readonly revision: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const msOrNull = (v: unknown): v is string | null => v === null || (typeof v === 'string' && MS.test(v));
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

export function readSettings(raw: unknown): GovernanceSettings | null {
  if (!isObj(raw) || !msOrNull(raw.votingDelayMs) || !msOrNull(raw.votingPeriodMs) || !whole(raw.revision)) return null;
  return { votingDelayMs: raw.votingDelayMs, votingPeriodMs: raw.votingPeriodMs, revision: raw.revision };
}

export function readSettingsHistory(raw: unknown): SettingsMove[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SettingsMove[] = [];
  for (const m of raw) {
    if (!isObj(m) || !whole(m.ordinal) || !msOrNull(m.votingDelayMs) || !msOrNull(m.votingPeriodMs)) return null;
    if (typeof m.actorId !== 'string' || typeof m.approverId !== 'string' || typeof m.at !== 'string') return null;
    out.push({
      ordinal: m.ordinal,
      votingDelayMs: m.votingDelayMs,
      votingPeriodMs: m.votingPeriodMs,
      actorId: m.actorId,
      approverId: m.approverId,
      at: m.at,
    });
  }
  return out;
}

const isRole = (v: unknown): v is GovernanceRole => typeof v === 'string' && (GOVERNANCE_ROLES as readonly string[]).includes(v);

export function readRoles(raw: unknown): RoleRow[] | null {
  if (!Array.isArray(raw)) return null;
  const out: RoleRow[] = [];
  for (const r of raw) {
    if (!isObj(r) || typeof r.userId !== 'string' || !(r.role === null || isRole(r.role)) || !whole(r.revision)) return null;
    out.push({ userId: r.userId, role: r.role, revision: r.revision });
  }
  return out;
}

export function readRoleResult(raw: unknown): { userId: string; role: GovernanceRole | null; revision: number } | null {
  if (!isObj(raw) || typeof raw.userId !== 'string' || !(raw.role === null || isRole(raw.role)) || !whole(raw.revision)) return null;
  return { userId: raw.userId, role: raw.role, revision: raw.revision };
}

/** A stored figure in plain words: "not set", or hours (and days when whole). */
export function durationWords(ms: string | null): string {
  if (ms === null) return 'not set';
  const n = BigInt(ms);
  if (n === 0n) return '0 hours (no delay)';
  if (n % HOUR !== 0n) return `${ms} ms`;
  const hours = n / HOUR;
  if (hours % 24n === 0n) return `${hours / 24n} ${hours === 24n ? 'day' : 'days'} (${hours} hours)`;
  return `${hours} ${hours === 1n ? 'hour' : 'hours'}`;
}

/**
 * The form's hours as the milliseconds svc-token stores: blank is "not set" (null); anything that is not a whole number
 * of hours within a year is refused here, as svc-token would refuse it. A period of 0 is refused; a delay of 0 is kept.
 */
export function hoursToMs(text: string, what: 'delay' | 'period'): { ok: true; ms: string | null } | { ok: false; why: string } {
  const t = text.trim();
  if (t === '') return { ok: true, ms: null };
  if (!/^(?:0|[1-9][0-9]{0,4})$/.test(t)) return { ok: false, why: `The voting ${what} is a whole number of hours.` };
  const hours = Number(t);
  if (hours > MAX_HOURS) return { ok: false, why: `The voting ${what} is at most ${MAX_HOURS} hours (one year).` };
  if (what === 'period' && hours === 0) return { ok: false, why: 'The voting period is more than 0 hours.' };
  return { ok: true, ms: (BigInt(hours) * HOUR).toString() };
}
