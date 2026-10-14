/**
 * Pure rules of the Send card (UI-SPEC 5.10). No React, no network. Money is decimal strings and bigint only.
 */
import { dec } from '../../data/decimal';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The interim "Account ID" input (before handles are live): a pasted ID, trimmed. Null when it cannot be an ID. */
export function parseAccountId(raw: string): string | null {
  const id = raw.trim();
  return UUID.test(id) ? id.toLowerCase() : null;
}

/** One of the customer's own bank spaces, as the Send card needs it. `balance` is what the service allows to be sent. */
export interface Source {
  id: string;
  asset: string;
  /** The space's own name, shown only for a named space. */
  name: string | null;
  balance: string;
}

const DOLLAR_COINS = ['USDT', 'USDC', 'USD'];

export interface SpaceRow {
  id: string;
  assetId: string;
  kind: 'primary' | 'named';
  name: string;
  lockedUntil: string | null;
  balance: string;
}

/**
 * Held assets with something to send: balance above zero and not time-locked. The main space of an asset comes first,
 * dollar coins before the rest, then by ticker. The first one is what the card starts on. A named space keeps its name so two holdings of one asset can be told apart.
 */
export function sourcesFrom(spaces: readonly SpaceRow[], nowMs: number): Source[] {
  return spaces
    .filter((space) => {
      const balance = dec(space.balance);
      if (balance === null || balance <= 0n) return false;
      if (space.lockedUntil) {
        const until = Date.parse(space.lockedUntil);
        if (!Number.isFinite(until) || until > nowMs) return false;
      }
      return true;
    })
    .sort(
      (a, b) =>
        Number(b.kind === 'primary') - Number(a.kind === 'primary') ||
        Number(DOLLAR_COINS.includes(b.assetId)) - Number(DOLLAR_COINS.includes(a.assetId)) ||
        a.assetId.localeCompare(b.assetId),
    )
    .map((space) => ({ id: space.id, asset: space.assetId, name: space.kind === 'named' ? space.name : null, balance: space.balance }));
}

export type AmountCheck = { kind: 'empty' } | { kind: 'zero' } | { kind: 'exceeds' } | { kind: 'ok' };

/** Typed amount against the chosen source. Both sides are exact; nothing is rounded to fit. */
export function checkAmount(amount: string, source: Pick<Source, 'balance'> | null): AmountCheck {
  if (amount === '' || amount === '.') return { kind: 'empty' };
  const typed = dec(amount);
  if (typed === null) return { kind: 'empty' };
  if (typed <= 0n) return { kind: 'zero' };
  const have = source ? dec(source.balance) : null;
  if (have === null) return { kind: 'empty' };
  return typed > have ? { kind: 'exceeds' } : { kind: 'ok' };
}

// ── "You haven't sent to them before": device memory until the service keeps recipients (U5) ────────────────────

export interface MemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const browserStorage = (): MemoryStorage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

const memoryKey = (userId: string) => `intafaced.pay.recipients.v1:${userId}`;
const MEMORY_LIMIT = 50;

function readRecipients(userId: string, storage: MemoryStorage | null): string[] | null {
  try {
    const raw = storage?.getItem(memoryKey(userId));
    if (raw === undefined) return null;
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string') ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

/** True when this device has seen a payment to them. A device that cannot remember says "no", so the warning shows. */
export function sentBefore(userId: string, recipientId: string, storage: MemoryStorage | null = browserStorage()): boolean {
  return readRecipients(userId, storage)?.includes(recipientId.toLowerCase()) ?? false;
}

/** Remember a confirmed payment. Failing to remember is harmless: the next payment simply shows the warning again. */
export function rememberRecipient(userId: string, recipientId: string, storage: MemoryStorage | null = browserStorage()): void {
  try {
    const id = recipientId.toLowerCase();
    const known = (readRecipients(userId, storage) ?? []).filter((entry) => entry !== id);
    storage?.setItem(memoryKey(userId), JSON.stringify([id, ...known].slice(0, MEMORY_LIMIT)));
  } catch {
    /* nothing to do */
  }
}
