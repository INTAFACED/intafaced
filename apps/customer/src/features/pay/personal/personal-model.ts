/**
 * Pure rules for the personal Pay rooms: payment links, what this device remembers about payments sent and links made,
 * and the receipt text. No React, no network. Money is a decimal string and a scaled bigint, never a number.
 */
import { dec } from '../../../data/decimal';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLE = /^[a-zA-Z0-9_]{3,32}$/;
const ASSET = /^[A-Z0-9._-]{1,16}$/;
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');

/** A note is plain text up to this long. */
export const NOTE_MAX = 140;

/** Strip control characters and trim. Empty becomes null. */
export function cleanNote(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX).trim();
  return text === '' ? null : text;
}

/** A positive exact amount with at most 18 decimals, as typed. Null when it is not one. */
export function cleanAmount(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(text)) return null;
  const value = dec(text);
  return value !== null && value > 0n ? text : null;
}

// ── Payment links ───────────────────────────────────────────────────────────────────────────────────────────────

/** What a payment link asks Send to fill in. The payer still reviews and confirms every field. */
export interface PaymentRequest {
  /** The payee: a handle (no @) or an Account ID. */
  to: string;
  kind: 'handle' | 'accountId';
  amount: string | null;
  asset: string | null;
  note: string | null;
  /** A signed pay code (PP-send-request-11): when present, the service says who it pays and `to` is not trusted. */
  qr: string | null;
}

/** The characters a signed pay code is made of, with room to spare. Anything else is dropped, never sent. */
const PAY_QR = /^[A-Za-z0-9._-]{1,200}$/;

export function payee(raw: string | null | undefined): { to: string; kind: 'handle' | 'accountId' } | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/^@/, '');
  if (UUID.test(text)) return { to: text.toLowerCase(), kind: 'accountId' };
  return HANDLE.test(text) ? { to: text, kind: 'handle' } : null;
}

/** `/pay/send?to=…` for a payee, with whatever the requester asked for. */
export function requestPath(input: {
  to: string;
  amount?: string | null;
  asset?: string | null;
  note?: string | null;
  qr?: string | null;
}): string {
  const params = new URLSearchParams();
  params.set('to', input.to);
  const amount = cleanAmount(input.amount);
  const asset = (input.asset ?? '').trim().toUpperCase();
  if (asset && ASSET.test(asset)) {
    if (amount) params.set('amount', amount);
    params.set('asset', asset);
  }
  const note = cleanNote(input.note);
  if (note) params.set('note', note);
  // Last, so nothing after it in the link can be mistaken for part of the code.
  const qr = (input.qr ?? '').trim();
  if (PAY_QR.test(qr)) params.set('qr', qr);
  return `/pay/send?${params.toString()}`;
}

/** Read a link's query string. Null when there is no usable payee; bad optional fields are dropped, never guessed. */
export function parseRequestSearch(search: string): PaymentRequest | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  } catch {
    return null;
  }
  const who = payee(params.get('to'));
  if (!who) return null;
  const asset = (params.get('asset') ?? '').trim().toUpperCase();
  const knownAsset = ASSET.test(asset) ? asset : null;
  return {
    ...who,
    // An amount with no asset means nothing (which balance?), so it is dropped.
    amount: knownAsset ? cleanAmount(params.get('amount')) : null,
    asset: knownAsset,
    note: cleanNote(params.get('note')),
    qr: PAY_QR.test(params.get('qr') ?? '') ? params.get('qr') : null,
  };
}

/** A pasted link or path: only this app's own `/pay/send` links count. */
export function parseRequestLink(raw: string, origin: string): PaymentRequest | null {
  const text = raw.trim();
  if (text === '') return null;
  try {
    const url = new URL(text, origin);
    if (url.origin !== new URL(origin).origin) return null;
    if (url.pathname.replace(/\/+$/, '') !== '/pay/send') return null;
    return parseRequestSearch(url.search);
  } catch {
    return null;
  }
}

// ── What this device remembers ──────────────────────────────────────────────────────────────────────────────────

export interface MemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const browserStorage = (): MemoryStorage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

const LIMIT = 100;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 200): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;

function readList<T>(key: string, storage: MemoryStorage | null, read: (row: Record<string, unknown>) => T | null): T[] {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((row) => {
      const item = isRecord(row) ? read(row) : null;
      return item ? [item] : [];
    });
  } catch {
    return [];
  }
}

function writeList(key: string, rows: unknown[], storage: MemoryStorage | null): boolean {
  try {
    if (!storage) return false;
    storage.setItem(key, JSON.stringify(rows.slice(0, LIMIT)));
    return true;
  } catch {
    return false;
  }
}

/** A payment this device confirmed. The note is private to this device: the transfer call carries no note. */
export interface SentEntry {
  transferId: string;
  ledgerTxId: string;
  toUserId: string;
  handle: string | null;
  amount: string;
  asset: string;
  note: string | null;
  at: string;
}

const sentKey = (userId: string) => `intafaced.pay.sent.v1:${userId}`;

const readSentRow = (row: Record<string, unknown>): SentEntry | null => {
  const transferId = text(row.transferId, 64);
  const ledgerTxId = text(row.ledgerTxId);
  const toUserId = text(row.toUserId, 64);
  const amount = typeof row.amount === 'string' && dec(row.amount) !== null ? row.amount : null;
  const asset = typeof row.asset === 'string' && ASSET.test(row.asset) ? row.asset : null;
  const at = typeof row.at === 'string' && Number.isFinite(Date.parse(row.at)) ? row.at : null;
  if (!transferId || !ledgerTxId || !toUserId || !amount || !asset || !at) return null;
  const handle = typeof row.handle === 'string' && HANDLE.test(row.handle) ? row.handle : null;
  return { transferId, ledgerTxId, toUserId, handle, amount, asset, note: cleanNote(typeof row.note === 'string' ? row.note : null), at };
};

export function readSent(userId: string, storage: MemoryStorage | null = browserStorage()): SentEntry[] {
  return readList(sentKey(userId), storage, readSentRow);
}

/** Remember a confirmed payment, newest first, one row per transfer. Failing to remember is harmless. */
export function recordSent(userId: string, entry: SentEntry, storage: MemoryStorage | null = browserStorage()): boolean {
  const rest = readSent(userId, storage).filter((row) => row.transferId !== entry.transferId);
  return writeList(sentKey(userId), [entry, ...rest], storage);
}

export interface Contact {
  userId: string;
  handle: string | null;
  lastAt: string;
  times: number;
}

/** People this device has paid, most recent first. The newest row decides the handle shown. */
export function contactsFrom(entries: readonly SentEntry[], limit = 6): Contact[] {
  const byUser = new Map<string, Contact>();
  for (const entry of [...entries].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))) {
    const key = entry.toUserId.toLowerCase();
    const seen = byUser.get(key);
    if (seen) {
      seen.times += 1;
      if (!seen.handle && entry.handle) seen.handle = entry.handle;
    } else byUser.set(key, { userId: entry.toUserId, handle: entry.handle, lastAt: entry.at, times: 1 });
  }
  return [...byUser.values()].slice(0, limit);
}

/** A short, safe label for a contact chip. */
export function contactLabel(contact: Pick<Contact, 'userId' | 'handle'>): string {
  return contact.handle ? `@${contact.handle}` : `${contact.userId.slice(0, 8)}…`;
}

/** Plain-text receipt for copying or sharing. */
export function receiptText(
  entry: SentEntry,
  labels: { title: string; to: string; amount: string; when: string; reference: string; note: string },
): string {
  const lines = [
    labels.title,
    `${labels.to}: ${entry.handle ? `@${entry.handle}` : entry.toUserId}`,
    `${labels.amount}: ${entry.amount} ${entry.asset}`,
    `${labels.when}: ${entry.at}`,
    `${labels.reference}: ${entry.ledgerTxId}`,
  ];
  if (entry.note) lines.push(`${labels.note}: ${entry.note}`);
  return lines.join('\n');
}

/** Payment links this device created. The service does not know about them. */
export interface RequestEntry {
  id: string;
  path: string;
  to: string;
  amount: string | null;
  asset: string | null;
  note: string | null;
  at: string;
}

const requestKey = (userId: string) => `intafaced.pay.requests.v1:${userId}`;

const readRequestRow = (row: Record<string, unknown>): RequestEntry | null => {
  const id = text(row.id, 64);
  const path = text(row.path, 600);
  const at = typeof row.at === 'string' && Number.isFinite(Date.parse(row.at)) ? row.at : null;
  if (!id || !path || !at) return null;
  const parsed = parseRequestSearch(path.includes('?') ? path.slice(path.indexOf('?')) : '');
  if (!parsed || !path.startsWith('/pay/send?')) return null;
  return { id, path, to: parsed.to, amount: parsed.amount, asset: parsed.asset, note: parsed.note, at };
};

export const readRequests = (userId: string, storage: MemoryStorage | null = browserStorage()): RequestEntry[] =>
  readList(requestKey(userId), storage, readRequestRow);

export function addRequest(userId: string, entry: RequestEntry, storage: MemoryStorage | null = browserStorage()): boolean {
  return writeList(requestKey(userId), [entry, ...readRequests(userId, storage).filter((row) => row.id !== entry.id)], storage);
}

export function removeRequest(userId: string, id: string, storage: MemoryStorage | null = browserStorage()): boolean {
  return writeList(
    requestKey(userId),
    readRequests(userId, storage).filter((row) => row.id !== id),
    storage,
  );
}

// ── Prefill for the Send card ───────────────────────────────────────────────────────────────────────────────────

export interface Source {
  id: string;
  asset: string;
  balance: string;
}

/**
 * What Send does with a link: the asset that matches one the customer can send, and an amount only when it fits that
 * balance. Anything that does not fit is dropped with a reason, so a typed number never lands on the wrong asset.
 */
export function applyPrefill(
  request: PaymentRequest,
  sources: readonly Source[],
): { sourceId: string | null; amount: string; problem: null | 'assetNotHeld' | 'amountTooLarge' } {
  // An amount without an asset says nothing about which balance it is in, so it is never filled.
  if (!request.asset) return { sourceId: null, amount: '', problem: null };
  const match = sources.find((row) => row.asset === request.asset) ?? null;
  if (!match) return { sourceId: null, amount: '', problem: request.amount ? 'assetNotHeld' : null };
  if (request.amount && !fits(request.amount, match.balance)) return { sourceId: match.id, amount: '', problem: 'amountTooLarge' };
  return { sourceId: match.id, amount: request.amount ?? '', problem: null };
}

function fits(amount: string, balance: string): boolean {
  const a = dec(amount);
  const b = dec(balance);
  return a !== null && b !== null && a <= b;
}
