import { z } from 'zod';
import type { ServiceAuthMode, ServiceSigner } from '@intafaced/contracts';
import { serviceCallSigner } from '@intafaced/contracts/service-auth-http';
import { LEDGER_OPERATOR_REVERSE, type OperatorReverseCall } from '@intafaced/ledger-client/operator-reverse';

/**
 * What one call to svc-ledger's `operatorReverse` door proved:
 * - `posted`: the ledger answered with the reversing transaction under exactly this key, for this original;
 * - `refused`: the ledger named a refusal that proves nothing was booked under this key (`reversedBy` when it named the
 *   first reversal of the original);
 * - `retry`: anything else, the posting freeze and a lost or unreadable reply included. The door books one key once and
 *   answers the same key with the first booking, so sending the same key and body again is always safe.
 */
export type ReverseOutcome =
  | { readonly kind: 'posted'; readonly txId: string }
  | { readonly kind: 'refused'; readonly code: string; readonly reversedBy: string | null }
  | { readonly kind: 'retry'; readonly code: string };

export interface ReversalLedger {
  reverse(call: OperatorReverseCall, expectedKey: string): Promise<ReverseOutcome>;
}

/** Answers the ledger gives before it books anything under the key: the request is settled as refused. */
export const PROVEN_REFUSALS: ReadonlySet<string> = new Set([
  'ledger.tx_not_found',
  'ledger.reversal_already_reversed',
  'ledger.insufficient_funds',
  'ledger.owner_identity_space',
  'ledger.custody_layer_off',
  'ledger.caller_forbidden',
  'ledger.unauthenticated',
]);

/** A send whose reply never came back, or came back in a shape this service does not read. */
export const LEDGER_REPLY_LOST = 'ledger.reply_lost' as const;
export const LEDGER_REPLY_INVALID = 'ledger.reply_invalid' as const;

const TIMEOUT_MS = 15_000;
/** The fields of a refusal body this service reads; anything else in it is ignored. */
const REFUSAL_BODY = z.object({ code: z.string().optional(), reversedBy: z.string().optional() });
const TX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Reads a ledger answer (status and parsed body) into what it proves. Pure, so each case is a test. */
export function reverseOutcomeOf(
  call: OperatorReverseCall,
  expectedKey: string,
  answer: { readonly status: number; readonly body: unknown },
): ReverseOutcome {
  const { status, body } = answer;
  if (status >= 200 && status < 300) {
    const receipt = LEDGER_OPERATOR_REVERSE.output.safeParse(body);
    if (!receipt.success || receipt.data.idempotencyKey !== expectedKey || receipt.data.reverses !== call.originalTxId.toLowerCase())
      return { kind: 'retry', code: LEDGER_REPLY_INVALID };
    return { kind: 'posted', txId: receipt.data.txId };
  }
  const refusal = REFUSAL_BODY.safeParse(body);
  const code = refusal.success ? (refusal.data.code ?? null) : null;
  if (code !== null && PROVEN_REFUSALS.has(code)) {
    const named =
      refusal.success && refusal.data.reversedBy !== undefined && TX_ID.test(refusal.data.reversedBy) ? refusal.data.reversedBy : null;
    return { kind: 'refused', code, reversedBy: code === 'ledger.reversal_already_reversed' ? named : null };
  }
  return { kind: 'retry', code: code ?? `http.${status}` };
}

/**
 * svc-ledger's `operatorReverse` door, signed as `svc-ops`. ONE attempt per call, no transport retry: the desk records every
 * send, and a later send is the same stored key and body. Without a URL or a credential there is no ledger, and every
 * reversal action refuses `ops.reversal_ledger_unconfigured` before anything is written.
 */
export function createReversalLedger(options: {
  ledgerUrl?: string;
  secret?: string;
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
  fetcher?: typeof fetch;
}): ReversalLedger | undefined {
  const credentialed = Boolean(options.secret && options.secret.length >= 32) || options.s2s?.mode === 'keypair';
  let base: string | null = null;
  try {
    const url = new URL(options.ledgerUrl ?? '');
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash)
      base = url.href.replace(/\/$/, '');
  } catch {
    /* Missing transport is explicitly unconfigured. */
  }
  if (base === null || !credentialed) return undefined;
  const sign = serviceCallSigner({ service: 'svc-ops', audience: 'svc-ledger', legacySecret: options.secret ?? '', s2s: options.s2s });
  const target = `${base}${LEDGER_OPERATOR_REVERSE.path}`;
  return {
    async reverse(call, expectedKey) {
      const body = JSON.stringify(LEDGER_OPERATOR_REVERSE.input.parse(call));
      let status: number;
      let parsed: unknown = null;
      try {
        const response = await (options.fetcher ?? fetch)(target, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: {
            'content-type': 'application/json',
            ...sign(body, { method: 'POST', url: new URL(target), contentType: 'application/json' }),
          },
          body,
        });
        status = response.status;
        parsed = await response.json().catch(() => null);
      } catch {
        return { kind: 'retry', code: LEDGER_REPLY_LOST };
      }
      return reverseOutcomeOf(call, expectedKey, { status, body: parsed });
    },
  };
}
