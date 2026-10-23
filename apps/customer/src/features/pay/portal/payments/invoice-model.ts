import { useCallback, useRef, useState } from 'react';
import { MAX_AMOUNT, SCALE } from '@intafaced/money-math';
import { formatAmount, parseAmount } from '../../../../shared/money';
import { newRequestId } from '../model';
import { checkoutAddressFor } from './checkout-address';
import type { Invoice, InvoiceDisplayStatus, InvoiceStatus } from './schemas';

/** Why an amount typed into the invoice form can't be sent, or null when it can. The service rejects the same cases. */
export type AmountProblem = 'empty' | 'format' | 'places' | 'zero';
export function amountProblem(raw: string): AmountProblem | null {
  const value = raw.trim();
  if (value === '') return 'empty';
  if (!/^\d+(\.\d+)?$/.test(value)) return 'format';
  if (/\.\d{19,}$/.test(value)) return 'places';
  if (!/[1-9]/.test(value)) return 'zero';
  return null;
}

const CONTROL = /[\u0000-\u001f\u007f]/;

/** The most lines the service takes on one invoice. */
export const MAX_INVOICE_LINES = 40;
export type LineKind = 'charge' | 'credit';
export type LineDraft = { kind: LineKind; description: string; quantity: string; unitAmount: string };
export const blankLine = (): LineDraft => ({ kind: 'charge', description: '', quantity: '1', unitAmount: '' });

export type InvoiceDraft = {
  assetId: string;
  amount: string;
  customerRef: string;
  customerEmail: string;
  description: string;
  /** A calendar day typed in the date box (YYYY-MM-DD), or empty for no due date. */
  dueDate: string;
  lineItems: LineDraft[];
};
export const blankDraft = (assetId: string): InvoiceDraft => ({
  assetId,
  amount: '',
  customerRef: '',
  customerEmail: '',
  description: '',
  dueDate: '',
  lineItems: [],
});

/** Quantity times unit price, exact at the ledger's 18 decimals. Anything that does not land exactly is a problem, never rounded. */
export type LineProblem = 'description' | 'quantity' | 'unitAmount' | 'places';
export function lineProblem(line: LineDraft): LineProblem | null {
  const description = line.description.trim();
  if (description.length < 1 || description.length > 500 || CONTROL.test(description)) return 'description';
  const quantity = line.quantity.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(quantity) || !/[1-9]/.test(quantity)) return 'quantity';
  const unit = line.unitAmount.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(unit)) return 'unitAmount';
  const product = parseAmount(quantity) * parseAmount(unit);
  if (product % SCALE !== 0n) return 'places';
  if (product / SCALE > MAX_AMOUNT) return 'unitAmount';
  // a free credit takes nothing off the total, so the service refuses it
  if (line.kind === 'credit' && !/[1-9]/.test(unit)) return 'unitAmount';
  return null;
}

/** The signed amount of one good line as an exact decimal string: a credit is negative. Null while the line has a problem. */
export function lineAmount(line: LineDraft): string | null {
  if (lineProblem(line)) return null;
  const magnitude = (parseAmount(line.quantity.trim()) * parseAmount(line.unitAmount.trim())) / SCALE;
  return formatAmount(line.kind === 'credit' ? -magnitude : magnitude);
}

/** The exact total of every line, or null while any line has a problem or there are none. */
export function linesTotal(lines: readonly LineDraft[]): string | null {
  if (lines.length === 0) return null;
  let total = 0n;
  for (const line of lines) {
    const each = lineAmount(line);
    if (each === null) return null;
    total += parseAmount(each);
  }
  return formatAmount(total);
}

/** The amount the invoice will carry: the lines' total when there are lines, else the typed amount. */
export const draftAmount = (draft: InvoiceDraft): string =>
  draft.lineItems.length > 0 ? (linesTotal(draft.lineItems) ?? '') : draft.amount.trim();

export type DraftField = 'assetId' | 'amount' | 'customerRef' | 'customerEmail' | 'description' | 'dueDate' | 'lineItems';
export type DraftProblems = Partial<
  Record<DraftField, 'empty' | 'format' | 'places' | 'zero' | 'long' | 'control' | 'email' | 'past' | 'lines' | 'total' | 'tooManyLines'>
>;
/** Every problem with a draft, keyed by field. An empty object means it can be reviewed. */
export function draftProblems(draft: InvoiceDraft, today: string = localDay(new Date())): DraftProblems {
  const out: DraftProblems = {};
  if (!/^[A-Za-z0-9._-]{1,16}$/.test(draft.assetId.trim())) out.assetId = draft.assetId.trim() === '' ? 'empty' : 'format';
  if (draft.lineItems.length > 0) {
    if (draft.lineItems.length > MAX_INVOICE_LINES) out.lineItems = 'tooManyLines';
    else if (draft.lineItems.some((line) => lineProblem(line))) out.lineItems = 'lines';
    else if (parseAmount(linesTotal(draft.lineItems) ?? '0') <= 0n) out.lineItems = 'total';
  } else {
    const amount = amountProblem(draft.amount);
    if (amount) out.amount = amount;
  }
  if (draft.customerRef.trim().length > 200) out.customerRef = 'long';
  else if (CONTROL.test(draft.customerRef)) out.customerRef = 'control';
  const email = draft.customerEmail.trim();
  if (email && (email.length > 254 || CONTROL.test(email) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) out.customerEmail = 'email';
  if (draft.description.trim().length > 2000) out.description = 'long';
  else if (CONTROL.test(draft.description.replace(/\n/g, ' '))) out.description = 'control';
  if (draft.dueDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.dueDate) || Number.isNaN(Date.parse(`${draft.dueDate}T00:00:00Z`))) out.dueDate = 'format';
    else if (draft.dueDate < today) out.dueDate = 'past';
  }
  return out;
}

/** Today as the person's own calendar day (YYYY-MM-DD), the day the due-date box counts from. */
export function localDay(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The moment a typed due day ends, in the person's own time zone, as the timestamp the service takes. */
export function dueAtOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 23, 59, 59, 0).toISOString();
}

/** Sent and past its due date: the one status the service does not store. */
export function isOverdue(invoice: Pick<Invoice, 'status' | 'dueAt'>, now: number = Date.now()): boolean {
  return invoice.status === 'sent' && invoice.dueAt !== null && Date.parse(invoice.dueAt) < now;
}
export function displayStatus(invoice: Pick<Invoice, 'status' | 'dueAt'>, now: number = Date.now()): InvoiceDisplayStatus {
  return isOverdue(invoice, now) ? 'overdue' : invoice.status;
}

/** What an invoice is called in a list: who it is for, else what it is for, else a short reference. Never a bare id as the name. */
export function invoiceName(invoice: Pick<Invoice, 'id' | 'customerRef' | 'description'>, fallback: (short: string) => string): string {
  return invoice.customerRef?.trim() || invoice.description?.trim() || fallback(invoice.id.split('-')[0]!.slice(0, 8));
}

export type InvoiceAction = 'send' | 'reissue' | 'void' | 'markPaid';
/** Which actions the invoice's status allows. These are the same rules the service enforces, so a button never offers a refused step. */
export function allowedActions(status: InvoiceStatus): readonly InvoiceAction[] {
  if (status === 'draft') return ['send', 'markPaid', 'void'];
  if (status === 'sent') return ['reissue', 'markPaid', 'void'];
  return [];
}

export type TimelineKey = 'created' | 'sent' | 'paid' | 'voided';
/** The invoice's own timestamps, oldest first. A time the invoice does not have is left out, never guessed. */
export function invoiceEvents(invoice: Invoice): Array<{ at: string; key: TimelineKey }> {
  const events: Array<{ at: string; key: TimelineKey }> = [{ at: invoice.createdAt, key: 'created' }];
  if (invoice.sentAt) events.push({ at: invoice.sentAt, key: 'sent' });
  if (invoice.paidAt) events.push({ at: invoice.paidAt, key: 'paid' });
  if (invoice.voidedAt) events.push({ at: invoice.voidedAt, key: 'voided' });
  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** The address a customer opens to pay. It exists only for the one call that minted the token. */
export const hostedLinkUrl = checkoutAddressFor;

/** Payments that could settle an invoice: paid, in the same asset, for exactly its amount. The service checks the same three things. */
export function matchingPayments<T extends { status: string; assetId: string; amount: string }>(
  invoice: Pick<Invoice, 'assetId' | 'amount'>,
  payments: readonly T[],
): T[] {
  return payments.filter(
    (p) => (p.status === 'captured' || p.status === 'settled') && p.assetId === invoice.assetId && sameAmount(p.amount, invoice.amount),
  );
}
const trimZeros = (v: string) => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);
export const sameAmount = (a: string, b: string) => trimZeros(a) === trimZeros(b);

/**
 * One request id per intended action, kept for the tab. If the answer is lost (a dropped connection, a reload), the
 * same click sends the same id and the service replays the first outcome instead of doing the thing twice. After
 * a confirmed outcome call `renew`, so the next real action gets a fresh id.
 */
export function useRequestId(scope: string): { id: string; renew: () => void } {
  const read = () => {
    const key = `portal:request:${scope}`;
    try {
      const saved = sessionStorage.getItem(key);
      if (saved) return saved;
      const made = newRequestId();
      sessionStorage.setItem(key, made);
      return made;
    } catch {
      return newRequestId();
    }
  };
  const [id, setId] = useState(read);
  const at = useRef(scope);
  if (at.current !== scope) {
    at.current = scope;
    setId(read());
  }
  const renew = useCallback(() => {
    const made = newRequestId();
    try {
      sessionStorage.setItem(`portal:request:${scope}`, made);
    } catch {
      /* the id still renews in memory */
    }
    setId(made);
  }, [scope]);
  return { id, renew };
}

/** The body `createInvoice` sends, without its request id: the one canonical form the request id is tied to. */
export function invoiceBody(draft: InvoiceDraft) {
  const hasLines = draft.lineItems.length > 0;
  return {
    assetId: draft.assetId.trim(),
    amount: draftAmount(draft),
    ...(draft.customerRef.trim() ? { customerRef: draft.customerRef.trim() } : {}),
    ...(draft.customerEmail.trim() ? { customerEmail: draft.customerEmail.trim() } : {}),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    ...(draft.dueDate ? { dueAt: dueAtOf(draft.dueDate) } : {}),
    ...(hasLines
      ? {
          lineItems: draft.lineItems.map((line) => ({
            kind: line.kind,
            description: line.description.trim(),
            quantity: line.quantity.trim(),
            unitAmount: line.unitAmount.trim(),
          })),
        }
      : {}),
  };
}

/** A short fingerprint of text (two 53-bit mixes, 26 hex characters). Not secret: it only tells two bodies apart, so the stored key never holds the body. */
export function digestOf(text: string): string {
  const mix = (seed: number) => {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
  };
  return mix(0) + mix(1);
}

type KeyStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
/**
 * The request id stored for a body that was sent. One storage key (`portal:request:<scope>`) holds `{digest, id}` of
 * the last body handed to the service, so after a lost reply and a reload the same body gets the same id back. Only a
 * send writes it; typing and rendering never do, and nothing typed is stored. Keys the earlier format wrote
 * (`<scope>:<the whole draft>`) are removed.
 */
export function storedBodyRequestId(store: KeyStore, scope: string, digest: string): string | null {
  const key = `portal:request:${scope}`;
  for (let i = store.length - 1; i >= 0; i--) {
    const name = store.key(i);
    if (name?.startsWith(`${key}:`)) store.removeItem(name);
  }
  try {
    const saved = JSON.parse(store.getItem(key) ?? 'null') as { digest?: unknown; id?: unknown } | null;
    if (saved && saved.digest === digest && typeof saved.id === 'string' && saved.id) return saved.id;
  } catch {
    /* an unreadable value counts as nothing stored */
  }
  return null;
}

/** Records the id about to be sent for this body. Called just before the request leaves, never on render. */
export function rememberBodyRequestId(store: KeyStore, scope: string, digest: string, id: string): void {
  store.setItem(`portal:request:${scope}`, JSON.stringify({ digest, id }));
}

/**
 * `useRequestId` for a create form. The id for a body is the one stored when that body was last sent, else one minted
 * in memory for that body. `sent` stores it just before the request goes out; `renew` forgets it after a confirmed
 * outcome, so the next form starts fresh.
 */
export function useBodyRequestId(scope: string, body: unknown): { id: string; sent: () => void; renew: () => void } {
  const digest = digestOf(JSON.stringify(body));
  const minted = useRef(new Map<string, string>());
  let stored: string | null = null;
  try {
    stored = storedBodyRequestId(sessionStorage, scope, digest);
  } catch {
    /* storage unreadable: the id lives in memory only */
  }
  let id = stored ?? minted.current.get(digest);
  if (!id) {
    id = newRequestId();
    minted.current.set(digest, id);
  }
  const sent = useCallback(() => {
    try {
      rememberBodyRequestId(sessionStorage, scope, digest, id);
    } catch {
      /* the send still goes out with this id */
    }
  }, [scope, digest, id]);
  const renew = useCallback(() => {
    try {
      sessionStorage.removeItem(`portal:request:${scope}`);
    } catch {
      /* nothing stored to forget */
    }
    minted.current.clear();
  }, [scope]);
  return { id, sent, renew };
}
