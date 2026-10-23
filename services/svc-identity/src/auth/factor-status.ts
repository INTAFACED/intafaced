/**
 * Factor status and the Security centre checklist (I-signin-sessions-14). One read of the caller's own `users` row:
 * which sign-in methods are on and the checklist derived from them. No side effects.
 *
 * The floor (ENGINE STP-4) always holds: moving money out and every security change need a second step, whatever the
 * owner sets. An owner policy can only add actions to it; no such setting exists yet, so `policy` is null and the page
 * lists the floor actions alone as required.
 */
import type { Sql } from 'postgres';
import { passkeyKind, type PasskeyKind } from './enroll-passkey.js';

export const SECOND_STEP_FLOOR = ['money_out', 'security_change'] as const;
export type ChecklistKey = 'second_factor' | 'passkey' | 'authenticator' | 'recovery_codes';

export type FactorStatus = {
  password: boolean;
  authenticator: { on: boolean; label: string | null };
  passkeys: { count: number; kinds: Record<PasskeyKind, number> };
  recoveryCodesLeft: number;
  secondStepRequired: { floor: Array<(typeof SECOND_STEP_FLOOR)[number]>; policy: null };
  checklist: Array<{ key: ChecklistKey; done: boolean }>;
};

export class FactorStatusError extends Error {
  constructor(readonly code: 'auth.not_found') {
    super(code);
    this.name = 'FactorStatusError';
  }
}

type Row = {
  password_hash: string | null;
  totp_on: boolean;
  totp_label: string | null;
  webauthn_creds: unknown;
  recovery_code_hashes: unknown;
};

const list = (raw: unknown): unknown[] => (Array.isArray(raw) ? raw : []);

/** The checklist, in the order the page shows it. Recovery codes count only while an authenticator is on. */
export function checklistFor(status: Omit<FactorStatus, 'checklist'>): FactorStatus['checklist'] {
  const passkey = status.passkeys.count > 0;
  return [
    { key: 'second_factor', done: passkey || status.authenticator.on },
    { key: 'passkey', done: passkey },
    { key: 'authenticator', done: status.authenticator.on },
    { key: 'recovery_codes', done: status.authenticator.on && status.recoveryCodesLeft > 0 },
  ];
}

export async function factorStatus(sql: Sql, userId: string): Promise<FactorStatus> {
  const rows = await sql<Row[]>`
    SELECT password_hash, totp_secret IS NOT NULL AS totp_on, totp_label, webauthn_creds, recovery_code_hashes FROM users WHERE id = ${userId}`;
  const row = rows[0];
  if (!row) throw new FactorStatusError('auth.not_found');
  const kinds: Record<PasskeyKind, number> = { platform: 0, cross_device: 0, security_key: 0, unknown: 0 };
  const creds = list(row.webauthn_creds).filter(
    (c): c is { credentialId: string; kind?: PasskeyKind; transports?: string[] } =>
      !!c && typeof c === 'object' && typeof (c as { credentialId?: unknown }).credentialId === 'string',
  );
  for (const cred of creds) {
    // A stored kind outside the four is read from the transports instead, as if none were stored.
    const kind = cred.kind !== undefined && Object.hasOwn(kinds, cred.kind) ? cred.kind : passkeyKind(cred.transports);
    kinds[kind] += 1;
  }
  const on = row.totp_on;
  const base = {
    password: typeof row.password_hash === 'string' && row.password_hash.length > 0,
    authenticator: { on, label: on ? row.totp_label : null },
    passkeys: { count: creds.length, kinds },
    recoveryCodesLeft: on ? list(row.recovery_code_hashes).filter((h) => typeof h === 'string').length : 0,
    secondStepRequired: { floor: [...SECOND_STEP_FLOOR], policy: null },
  };
  return { ...base, checklist: checklistFor(base) };
}
