import { z } from 'zod';
import { defineProcedure } from '@intafaced/contracts/procedure';

/**
 * svc-ledger's `operatorReverse` door (OPS-ledger-desk-02): svc-ops, once two founders approved a correction on its
 * desk, names a posted transaction and the ledger books its corrective reversal itself, from the stored original, with
 * `operatorReverse` (`recipes/operator-reverse.ts`, held case for case by the Rust ledger's `reversal.rs`). The caller
 * never sends a leg. The booking runs exactly what `/trpc/post` runs past its gate: the custody switch, idempotency,
 * the freeze, the balance checks and the chain.
 *
 * Kept with the ledger's own records (here, not in contracts, so contracts never depends on the money package), as
 * `post-recipe-record.ts` is. svc-ledger checks its input and reply with the schemas
 * `crates/svc-ledger/scripts/record-post-recipe.mjs` writes from this record into its `door/schemas.json`.
 *
 * `ordinal` is the desk's own stored number for the approved correction (a whole number from one, as a decimal string),
 * so a retried approval is the same key, `ops:reversal:<originalTxId>:<ordinal>`, and replays the first booking. One
 * original has one reversal: a second key is refused `ledger.reversal_already_reversed`, whose body also carries
 * `reversedBy`, the first reversing transaction's id.
 */

const UUID = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
const LOWER_UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export const operatorReverseInputSchema = z
  .object({
    /** The posted transaction to reverse. */
    originalTxId: UUID,
    /** The desk's stored ordinal for this correction. */
    ordinal: z.string().regex(/^[1-9][0-9]{0,18}$/),
    /** Why, as the founders approved it. */
    reason: z.string().min(1).max(500).regex(/\S/),
    /** The desk's case reference for the approval. */
    caseRef: z.string().min(1).max(128).regex(/\S/),
  })
  .strict();

export const operatorReverseOutputSchema = z.object({
  /** The reversing transaction. */
  txId: LOWER_UUID,
  idempotencyKey: z.string().regex(/^ops:reversal:[0-9a-f-]{36}:[1-9][0-9]{0,18}$/),
  postedAt: z.string(),
  /** The original, lower-cased. */
  reverses: LOWER_UUID,
});

export type OperatorReverseCall = z.infer<typeof operatorReverseInputSchema>;
export type OperatorReverseReceipt = z.infer<typeof operatorReverseOutputSchema>;

export const OPERATOR_REVERSE_ALREADY_REVERSED = 'ledger.reversal_already_reversed';

export const LEDGER_OPERATOR_REVERSE = defineProcedure({
  name: 'ledger.operatorReverse',
  service: 'svc-ledger',
  transport: 'http',
  method: 'POST',
  path: '/trpc/operatorReverse',
  access: { caller: 'service', callers: ['svc-ops'] },
  /** Plain-HTTP refusals: status and `{ message, code }` from svc-ledger's `httpError`. */
  refusals: {
    'ledger.tx_not_found': 'NOT_FOUND',
    [OPERATOR_REVERSE_ALREADY_REVERSED]: 'CONFLICT',
    'ledger.insufficient_funds': 'BAD_REQUEST',
    'ledger.owner_identity_space': 'BAD_REQUEST',
    'ledger.unauthenticated': 'UNAUTHORIZED',
    'ledger.caller_forbidden': 'FORBIDDEN',
    'ledger.idempotency_conflict': 'CONFLICT',
    'ledger.frozen': 'PRECONDITION_FAILED',
    'ledger.custody_layer_off': 'PRECONDITION_FAILED',
    'ledger.writes_blocked_store_unavailable': 'SERVICE_UNAVAILABLE',
    'ledger.writes_blocked_store_disk_full': 'SERVICE_UNAVAILABLE',
    'ledger.writes_blocked_clock_skew': 'SERVICE_UNAVAILABLE',
  },
  input: operatorReverseInputSchema,
  samples: [
    {
      verdict: 'accept',
      input: { originalTxId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ordinal: '1', reason: 'LOCAL TEST wrong account', caseRef: 'case-1' },
    },
    {
      verdict: 'accept',
      input: { originalTxId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', ordinal: '1234567890123456789', reason: 'x', caseRef: 'c' },
    },
    { verdict: 'refuse', input: { originalTxId: 'not-a-uuid', ordinal: '1', reason: 'r', caseRef: 'c' } },
    { verdict: 'refuse', input: { originalTxId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ordinal: '0', reason: 'r', caseRef: 'c' } },
    { verdict: 'refuse', input: { originalTxId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ordinal: '1.5', reason: 'r', caseRef: 'c' } },
    { verdict: 'refuse', input: { originalTxId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ordinal: '1', reason: '   ', caseRef: 'c' } },
    { verdict: 'refuse', input: { originalTxId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ordinal: '1', reason: 'r', caseRef: '' } },
    {
      verdict: 'refuse',
      input: { originalTxId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ordinal: '1', reason: 'r', caseRef: 'c', entries: [] },
    },
  ],
  output: operatorReverseOutputSchema,
});
