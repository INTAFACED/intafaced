import { useState } from 'react';

/**
 * Codes after which the bank may already have acted (the partner's answer was lost, or it could not be asked and the
 * outcome is not known). The same request goes again under the same id, so the bank reads it back by its key.
 */
const OUTCOME_UNKNOWN = new Set(['bank.partner_reply_lost', 'bank.partner_unavailable', 'bank.ledger_outcome_unknown']);

/**
 * Whether the bank gave a definite answer to a request: it did it, or it refused it with a typed bank code that means
 * nothing more will happen under that id. A lost reply, a network failure or an untyped error is not an answer.
 */
export function bankAnswered(out: { ok: true } | { ok: false; code?: string | undefined }): boolean {
  if (out.ok) return true;
  return typeof out.code === 'string' && out.code.startsWith('bank.') && !OUTCOME_UNKNOWN.has(out.code);
}

type Out = { ok: true } | { ok: false; code?: string | undefined };

/** The id the form sends next: the same one until the bank answered this one. */
export function nextHeldId(current: string, out: Out, mint: () => string): string {
  return bankAnswered(out) ? mint() : current;
}

export type HeldId = { readonly id: string; settle: (out: { ok: true } | { ok: false; code?: string | undefined }) => void };

/**
 * One open form's request id: the business key the bank keeps the request under (a payment's partner instruction is
 * `bank.business.payment:<id>`). Pressing again after a lost answer sends the same id, so the bank makes it once; a new
 * id comes only after the bank answered.
 */
export function useHeldId(mint: () => string = () => crypto.randomUUID()): HeldId {
  const [id, setId] = useState(mint);
  return {
    id,
    settle: (out) => setId((current) => nextHeldId(current, out, mint)),
  };
}
