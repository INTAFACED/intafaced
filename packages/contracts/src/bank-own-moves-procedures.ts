import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { ownMoveMessageSchema, ownMoveViewSchema } from './bank-trading-account-reads.js';
import { amountString } from './bank-earn-procedures.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `ownMoves.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/** svc-bank's own-move answer, the one schema its callers read too. */
export const ownMoveView = ownMoveViewSchema;

/**
 * `bank.ownMoves.*` (J-derivatives-25 #2 #3, BK-ownmove-01): moves between the person's own spending money at the partner
 * bank and their own trading account at the venue. `toWallet` asks the partner to send an amount from the person's main
 * balance to their own wallet, once under the move's id, after a fresh second factor; `recordDeposit` keeps the wallet's
 * own signed deposit to the venue for that move. Nothing here posts to the ledger.
 */
export const moveId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'a lower-case uuid');

export const asset = z.string().regex(/^[A-Z0-9]{2,16}$/);

export const wallet = z.string().regex(/^0x[0-9a-f]{40}$/, 'a lower-case EVM address');

export const BANK_OWN_MOVES_LIST = defineProcedure({
  ...base,
  name: 'bank.ownMoves.list',
  kind: 'query',
  path: 'ownMoves.list',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ limit: z.number().int().min(1).max(100) }).strict(),
  output: z.array(ownMoveView),
  samples: [
    { verdict: 'accept', input: { limit: 1 } },
    { verdict: 'refuse', input: 42 },
  ],
});

/** The exact message the wallet signs for one move: it proves the wallet is the person's and names the move. */
export const BANK_OWN_MOVES_MESSAGE = defineProcedure({
  ...base,
  name: 'bank.ownMoves.message',
  kind: 'query',
  path: 'ownMoves.message',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ moveId, assetId: asset, amount: amountString, wallet }).strict(),
  output: ownMoveMessageSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        moveId: '11111111-1111-4111-8111-111111111111',
        assetId: 'USDC',
        amount: '1',
        wallet: '0x1111111111111111111111111111111111111111',
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});

/** Spending to trading, leg two: the wallet's own signed deposit to the venue for this move, recorded once. */
export const BANK_OWN_MOVES_RECORD_DEPOSIT = defineProcedure({
  ...base,
  name: 'bank.ownMoves.recordDeposit',
  kind: 'mutation',
  path: 'ownMoves.recordDeposit',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z.object({ moveId, depositTx: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict(),
  output: ownMoveView,
  samples: [
    // A whole input: the replay's own sample is refused by every caller, so this one is written by hand.
    { verdict: 'accept', input: { moveId: '00000000-0000-4000-8000-000000000001', depositTx: `0x${'a'.repeat(64)}` } },
    { verdict: 'refuse', input: 42 },
  ],
});
