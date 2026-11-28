import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { moveId, ownMoveView } from './bank-own-moves-procedures.js';
import { amountString, asset, stepUpApprovalField, wallet } from './bank-call-schemas.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `ownMoves.*`, one record per call: svc-bank mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

/** Spending to trading, leg one: the partner sends `amount` from the main balance to the person's own wallet, once. */
export const BANK_OWN_MOVES_TO_WALLET = defineProcedure({
  ...base,
  name: 'bank.ownMoves.toWallet',
  kind: 'mutation',
  path: 'ownMoves.toWallet',
  access: { caller: 'scope', scope: 'bank:write', module: 'bank' },
  refusals: {},
  input: z
    .object({
      moveId,
      assetId: asset,
      amount: amountString,
      wallet,
      walletSignature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
      stepUpApprovalId: stepUpApprovalField,
    })
    .strict(),
  output: ownMoveView,
  samples: [
    // A whole input: the replay's own sample is refused by every caller, so this one is written by hand.
    {
      verdict: 'accept',
      input: {
        moveId: '00000000-0000-4000-8000-000000000001',
        assetId: 'USDC',
        amount: '10',
        wallet: `0x${'a'.repeat(40)}`,
        walletSignature: `0x${'b'.repeat(130)}`,
      },
    },
    { verdict: 'refuse', input: 42 },
  ],
});
