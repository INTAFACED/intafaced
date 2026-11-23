import { TOKEN_GOVERNANCE_ROLES } from '@intafaced/contracts/token-procedures';

/**
 * Token governance settings and roles as svc-token answers them (`governance.*`, MC-token-02, J-more-catalogue-10). A blank
 * setting is null, never a default; every figure is a whole number of milliseconds as a decimal string.
 */

/** svc-token's roles, from its records. */
export const GOVERNANCE_ROLES = TOKEN_GOVERNANCE_ROLES;
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

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

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

/** A stored figure as the form's whole hours, or blank when it is not set or not a whole number of hours. */
export function msToHours(ms: string | null): string {
  if (ms === null) return '';
  const n = BigInt(ms);
  return n % HOUR === 0n ? (n / HOUR).toString() : '';
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
