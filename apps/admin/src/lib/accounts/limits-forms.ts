import { createHash } from 'node:crypto';
import {
  accountLimitOverrideClearInputSchema,
  accountLimitOverrideSetInputSchema,
  type AccountLimitOverrideClearInput,
  type AccountLimitOverrideSetInput,
} from '@intafaced/contracts';
import { keyUuid } from './details-forms';

/**
 * The limit override forms (J-ops-console-04 #12), read on the server before anything is sent. The request id is the
 * business key of that change, with its reason, on that reading by that founder: the override version and the newest entry
 * in the override history. Every attempt identity stores (a set, a clear, a refusal) adds a history entry, so the next
 * reading is a new request and a refusal never blocks the next try; asked again on the same reading (a lost answer),
 * identity answers with what it stored.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => key in value)
  );
}

/** The reading a change was made on: the override version and the newest history entry (null when there is none). */
function readingOf(raw: unknown): string | null {
  if (!exactKeys(raw, ['version', 'after'])) return null;
  if (typeof raw.version !== 'string' || !/^(?:0|[1-9]\d{0,39})$/.test(raw.version)) return null;
  if (raw.after !== null && (typeof raw.after !== 'string' || !UUID.test(raw.after))) return null;
  return `v${raw.version}:after:${(raw.after as string | null)?.toLowerCase() ?? 'none'}`;
}

function reasonKey(reason: unknown): string {
  return createHash('sha256').update(String(reason).trim()).digest('hex').slice(0, 16);
}

/** A direct set, under the ceiling (above it, the approval packet runs it). */
export function readLimitSetForm(raw: unknown, founderId: string): AccountLimitOverrideSetInput | null {
  if (!exactKeys(raw, ['userId', 'rail', 'assetId', 'perTx', 'rolling24h', 'expiresAt', 'reason', 'basis'])) return null;
  const reading = readingOf(raw.basis);
  if (reading === null || typeof raw.userId !== 'string' || typeof raw.expiresAt !== 'string' || Number.isNaN(Date.parse(raw.expiresAt)))
    return null;
  const userId = raw.userId.toLowerCase();
  const expiresAt = new Date(raw.expiresAt).toISOString();
  const key = [
    founderId.toLowerCase(),
    userId,
    String(raw.rail),
    String(raw.assetId),
    reading,
    String(raw.perTx ?? 'base'),
    String(raw.rolling24h ?? 'base'),
    expiresAt,
    reasonKey(raw.reason),
  ];
  const input = accountLimitOverrideSetInputSchema.safeParse({
    requestId: keyUuid(`console:limit-set:${key.join(':')}`),
    userId,
    rail: raw.rail,
    assetId: raw.assetId,
    perTx: raw.perTx,
    rolling24h: raw.rolling24h,
    expiresAt,
    reason: raw.reason,
    expectedVersion: (raw.basis as { version: string }).version,
  });
  return input.success ? input.data : null;
}

export function readLimitClearForm(raw: unknown, founderId: string): AccountLimitOverrideClearInput | null {
  if (!exactKeys(raw, ['userId', 'rail', 'assetId', 'reason', 'basis'])) return null;
  const reading = readingOf(raw.basis);
  if (reading === null || typeof raw.userId !== 'string') return null;
  const userId = raw.userId.toLowerCase();
  const key = [founderId.toLowerCase(), userId, String(raw.rail), String(raw.assetId), reading, reasonKey(raw.reason)];
  const input = accountLimitOverrideClearInputSchema.safeParse({
    requestId: keyUuid(`console:limit-clear:${key.join(':')}`),
    userId,
    rail: raw.rail,
    assetId: raw.assetId,
    reason: raw.reason,
    expectedVersion: (raw.basis as { version: string }).version,
  });
  return input.success ? input.data : null;
}
