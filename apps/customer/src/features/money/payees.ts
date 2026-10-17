/**
 * People the customer has chosen to pay, kept on this device only until the service keeps a recipient list.
 * A saved entry is a convenience: the person is looked up again by exact handle before any money moves.
 */
export type Payee = { userId: string; handle: string };
export interface PayeeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLE = /^[a-zA-Z0-9_]{3,32}$/;
const LIMIT = 30;
const keyFor = (ownerId: string) => `intafaced.bank.payees.v1:${ownerId}`;

const browserStorage = (): PayeeStorage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function parsePayees(raw: string | null): Payee[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const rows: Payee[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const { userId, handle } = entry as Record<string, unknown>;
      if (typeof userId !== 'string' || typeof handle !== 'string' || !UUID.test(userId) || !HANDLE.test(handle)) continue;
      const id = userId.toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({ userId: id, handle });
    }
    return rows.slice(0, LIMIT);
  } catch {
    return [];
  }
}
export function readPayees(ownerId: string, storage: PayeeStorage | null = browserStorage()): Payee[] {
  try {
    return parsePayees(storage?.getItem(keyFor(ownerId)) ?? null);
  } catch {
    return [];
  }
}
/** Most recently used first; a person never appears twice. Returns the new list even when the device cannot remember. */
export function rememberPayee(ownerId: string, payee: Payee, storage: PayeeStorage | null = browserStorage()): Payee[] {
  const id = payee.userId.toLowerCase();
  if (!UUID.test(id) || !HANDLE.test(payee.handle) || id === ownerId.toLowerCase()) return readPayees(ownerId, storage);
  const next = [{ userId: id, handle: payee.handle }, ...readPayees(ownerId, storage).filter((row) => row.userId !== id)].slice(0, LIMIT);
  try {
    storage?.setItem(keyFor(ownerId), JSON.stringify(next));
  } catch {
    /* the list simply is not kept */
  }
  return next;
}
export function forgetPayee(ownerId: string, userId: string, storage: PayeeStorage | null = browserStorage()): Payee[] {
  const next = readPayees(ownerId, storage).filter((row) => row.userId !== userId.toLowerCase());
  try {
    storage?.setItem(keyFor(ownerId), JSON.stringify(next));
  } catch {
    /* nothing to do */
  }
  return next;
}
/** Handles of people the customer has recently sent to, newest first, from their own activity. */
export function recentHandles(
  items: readonly { kind: string; direction: string; counterparty: { handle: string } | null; postedAt: string }[],
  limit = 6,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of [...items].sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt))) {
    if (item.kind !== 'transfer_out' || !item.counterparty) continue;
    const handle = item.counterparty.handle;
    if (!HANDLE.test(handle) || seen.has(handle.toLowerCase())) continue;
    seen.add(handle.toLowerCase());
    out.push(handle);
    if (out.length >= limit) break;
  }
  return out;
}
/** Filters a saved list by what the customer typed (handle fragment, with or without "@"). */
export function filterPayees(rows: readonly Payee[], query: string): Payee[] {
  const needle = query.trim().replace(/^@/, '').toLowerCase();
  return needle ? rows.filter((row) => row.handle.toLowerCase().includes(needle)) : [...rows];
}

/** True when a handle that was saved for one person now points at someone else. Nothing is paid until the customer says so. */
export function identityChanged(saved: Payee | undefined, resolvedUserId: string): boolean {
  return saved !== undefined && saved.userId.toLowerCase() !== resolvedUserId.toLowerCase();
}
