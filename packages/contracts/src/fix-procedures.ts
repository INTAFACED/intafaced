import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';

/**
 * svc-fix's whole call surface from other services, one record per call: its HTTP listener's two signed doors
 * (`/health` is a probe nothing calls through a client). svc-fix is Java and serves both from `FixAcceptorMain`; its
 * `src/wire-replay.golden.json` holds what it answers today. The callers (svc-edge's adapter status read, svc-trade's
 * drop-copy hitch) take the route, the input and the reply's shape from here, never a copy of their own.
 * Every refusal is `{ ok: false, error: { code, message } }` with the status named here.
 */

const text = z.string().min(1);
const count = z.number().int().min(0);

const fixSessionSchema = z.object({
  role: z.enum(['order-entry', 'drop-copy']),
  beginString: text,
  senderCompId: text,
  targetCompId: text,
  state: text,
  accountId: text.nullable(),
  /** Null when the FIX engine could not read its store. */
  nextSenderSeq: count.nullable(),
  nextTargetSeq: count.nullable(),
});

/** svc-fix's FIX sessions and CompID to account map, read by the founder console through svc-edge (J-cex-spot-20 #3). */
export const FIX_ADAPTER_STATUS = defineProcedure({
  name: 'fix.adapterStatus',
  service: 'svc-fix',
  transport: 'http',
  method: 'GET',
  path: '/internal/status',
  /** Signed with svc-fix's own status read key (`FIX_STATUS_READ_SECRET`), or svc-edge's S2S key. */
  access: { caller: 'service', callers: ['svc-edge'] },
  refusals: {
    unauthenticated: 'UNAUTHORIZED',
    forbidden: 'FORBIDDEN',
    fix_status_unconfigured: 'SERVICE_UNAVAILABLE',
  },
  input: NO_INPUT,
  /** Only these fields are read; anything else svc-fix might add is dropped by the parse. */
  output: z.object({
    sessions: z.array(fixSessionSchema),
    compIdMapSet: z.boolean(),
    compIdMap: z.array(z.object({ compId: text, accountId: text })),
    asOf: text,
  }),
  samples: [{ verdict: 'accept' }, { verdict: 'refuse', input: { x: 1 } }],
});

/** The decimal-string law of svc-fix's `DropCopyFill.parse`: money never crosses as a JSON number. */
const decimal = z.string().regex(/^\d+(\.\d{1,18})?$/);

/** The sources a house fill can prove (a user API key, a convert settle, a liquidation); never ui, ws, fix, algo or broker. */
export const DROP_COPY_SOURCES = ['rest', 'rfq', 'liquidation'] as const;

/** One house fill svc-trade hitches to svc-fix's drop-copy sessions. Evidence only: it moves no money. */
export const FIX_DROP_COPY_FILL = defineProcedure({
  name: 'fix.dropCopyFill',
  service: 'svc-fix',
  transport: 'http',
  method: 'POST',
  path: '/internal/drop-copy/fills',
  access: { caller: 'service', callers: ['svc-trade'] },
  refusals: {
    unauthenticated: 'UNAUTHORIZED',
    forbidden: 'FORBIDDEN',
    dropcopy_execution_missing: 'BAD_REQUEST',
    dropcopy_source_missing: 'BAD_REQUEST',
    dropcopy_price_missing: 'BAD_REQUEST',
    invalid_decimal: 'BAD_REQUEST',
  },
  input: z.object({
    fillId: z.string(),
    orderId: z.string(),
    userId: z.string(),
    marketId: z.string(),
    side: z.string(),
    price: decimal,
    qty: decimal,
    quoteAmount: decimal,
    feeAsset: text,
    feeAmount: decimal,
    ts: z.string(),
    source: z.enum(DROP_COPY_SOURCES),
    sequence: z.number().int().optional(),
  }),
  output: z.object({ ok: z.literal(true), delivered: count, included: z.array(z.string()) }),
  samples: [
    {
      verdict: 'accept',
      input: {
        fillId: 'fill-7',
        orderId: 'ord-1',
        userId: 'user-1',
        marketId: 'BTC/USDT',
        side: 'buy',
        price: '100.25',
        qty: '1.50',
        quoteAmount: '150.375',
        feeAsset: 'USDT',
        feeAmount: '0.15',
        ts: '2026-09-18T00:00:00Z',
        source: 'rest',
        sequence: 11,
      },
    },
    {
      verdict: 'refuse',
      input: {
        fillId: 'fill-7',
        orderId: 'ord-1',
        userId: 'user-1',
        marketId: 'BTC/USDT',
        side: 'buy',
        price: 100.25,
        qty: '1.50',
        quoteAmount: '150.375',
        feeAsset: 'USDT',
        feeAmount: '0.15',
        ts: '2026-09-18T00:00:00Z',
        source: 'rest',
      },
    },
    {
      verdict: 'refuse',
      input: {
        fillId: 'fill-7',
        orderId: 'ord-1',
        userId: 'user-1',
        marketId: 'BTC/USDT',
        side: 'buy',
        price: '100.25',
        qty: '1.50',
        quoteAmount: '150.375',
        feeAsset: 'USDT',
        feeAmount: '0.15',
        ts: '2026-09-18T00:00:00Z',
        source: 'ui',
      },
    },
  ],
});
