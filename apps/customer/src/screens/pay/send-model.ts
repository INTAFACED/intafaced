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
  /** The space's name as the bank keeps it ("Main" for the main space), for "From" lines. */
  space: string;
  balance: string;
}

/** Stablecoins come first in the picker (J-pay-01 #3), then the dollar itself, then everything else. */
const STABLECOINS = ['USDT', 'USDC'];
const assetRank = (asset: string): number => (STABLECOINS.includes(asset) ? 0 : asset === 'USD' ? 1 : 2);

export interface SpaceRow {
  id: string;
  assetId: string;
  kind: 'primary' | 'named';
  name: string;
  lockedUntil: string | null;
  balance: string;
}

/**
 * Held assets with something to send: balance above zero and not time-locked. Stablecoins come first, then the dollar,
 * then the rest; within each, a main space before a named one, then by ticker. The first one is what the card starts on.
 * A named space keeps its name so two holdings of one asset can be told apart.
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
        assetRank(a.assetId) - assetRank(b.assetId) ||
        Number(b.kind === 'primary') - Number(a.kind === 'primary') ||
        a.assetId.localeCompare(b.assetId),
    )
    .map((space) => ({
      id: space.id,
      asset: space.assetId,
      name: space.kind === 'named' ? space.name : null,
      space: space.name,
      balance: space.balance,
    }));
}

// ── Look-alike handles (J-pay-01 #2) ────────────────────────────────────────────────────────────────────────────

/** Characters people misread for one another in a handle: each is read as the letter it imitates. */
const MISREAD: Record<string, string> = {
  '0': 'o',
  '1': 'l',
  i: 'l',
  '5': 's',
  '2': 'z',
  '8': 'b',
  '3': 'e',
  '4': 'a',
  '6': 'g',
  '9': 'g',
  '7': 't',
};

/** What a handle looks like at a glance: case, underscores and misread characters (rn for m, vv for w) folded away. */
export function handleSkeleton(handle: string): string {
  return [...handle.toLowerCase().replace(/^@/, '').replace(/_/g, '').replace(/rn/g, 'm').replace(/vv/g, 'w')]
    .map((char) => MISREAD[char] ?? char)
    .join('');
}

/** Edits (insert, delete, change, or swap two neighbours) between two strings, stopping once it passes `cap`. */
function editsWithin(a: string, b: string, cap: number): boolean {
  if (Math.abs(a.length - b.length) > cap) return false;
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = best;
    }
  }
  return rows[a.length]![b.length]! <= cap;
}

/**
 * The saved recipient a handle imitates, or null. The saved handle itself is never a look-alike of itself. A handle is
 * flagged when it reads the same at a glance (`handleSkeleton`), or when it is one typo away from a saved one of five or
 * more characters.
 */
export function lookalikeOf(handle: string, saved: readonly string[]): string | null {
  const typed = handle.replace(/^@/, '').toLowerCase();
  if (saved.some((row) => row.toLowerCase() === typed)) return null;
  const shape = handleSkeleton(typed);
  for (const row of saved) {
    const theirs = row.toLowerCase();
    if (handleSkeleton(theirs) === shape) return row;
    if (typed.length >= 5 && theirs.length >= 5 && editsWithin(typed, theirs, 1)) return row;
  }
  return null;
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
