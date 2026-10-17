import { isIbanRef, isIfscRef } from '../withdraw-destination.js';

/**
 * Account shape only. IBAN mod-97 and IFSC structure are standards.
 * A digit string is a shape, not proof the account exists.
 * BIC shape is ISO 9362. A directory hit is a different step.
 */

export type AccountKind = 'iban' | 'ifsc' | 'account_number';

export type AccountClassification = { readonly ok: true; readonly kind: AccountKind; readonly normalized: string } | { readonly ok: false };

export function classifyAccount(raw: string): AccountClassification {
  const compact = raw.replace(/\s+/g, '').toUpperCase();
  if (isIbanRef(compact)) return { ok: true, kind: 'iban', normalized: compact };
  if (isIfscRef(compact)) return { ok: true, kind: 'ifsc', normalized: compact };
  if (/^[0-9]{6,17}$/.test(compact)) return { ok: true, kind: 'account_number', normalized: compact };
  return { ok: false };
}

/** 8 or 11 character BIC. Does not prove the bank exists. */
export function classifyBic(raw: string): { readonly ok: true; readonly normalized: string } | { readonly ok: false } {
  const compact = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(compact)) return { ok: false };
  return { ok: true, normalized: compact };
}
