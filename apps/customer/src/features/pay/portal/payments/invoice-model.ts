import { useCallback, useRef, useState } from 'react';
import { newRequestId } from '../model';
import type { Invoice, InvoiceStatus } from './schemas';

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
export type InvoiceDraft = { assetId: string; amount: string; customerRef: string; description: string };
export type DraftProblems = Partial<Record<keyof InvoiceDraft, 'empty' | 'format' | 'places' | 'zero' | 'long' | 'control'>>;
/** Every problem with a draft, keyed by field. An empty object means it can be reviewed. */
export function draftProblems(draft: InvoiceDraft): DraftProblems {
  const out: DraftProblems = {};
  if (!/^[A-Za-z0-9._-]{1,16}$/.test(draft.assetId.trim())) out.assetId = draft.assetId.trim() === '' ? 'empty' : 'format';
  const amount = amountProblem(draft.amount);
  if (amount) out.amount = amount;
  if (draft.customerRef.trim().length > 200) out.customerRef = 'long';
  else if (CONTROL.test(draft.customerRef)) out.customerRef = 'control';
  if (draft.description.trim().length > 2000) out.description = 'long';
  else if (CONTROL.test(draft.description.replace(/\n/g, ' '))) out.description = 'control';
  return out;
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
export const hostedLinkUrl = (origin: string, token: string) => `${origin}/pay/checkout?token=${encodeURIComponent(token)}`;

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
