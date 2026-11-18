import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { formatAmount } from '@intafaced/ledger-client';
import { unwiredApprovalConsumer } from '../action-approval-consume.js';
import { createStepUpGate } from '../step-up/step-up-gate.js';
import type { BankRouterContext } from '../router/context.js';
import { guard } from '../router/errors.js';
import { amountString, stepUpApprovalField } from '../router/shared.js';
import { ownMoveMessage, type OwnMove } from './own-move-service.js';

/**
 * `bank.ownMoves.*` (J-derivatives-25 #2 #3, BK-ownmove-01): moves between the person's own spending money at the partner
 * bank and their own trading account at the venue. `toWallet` asks the partner to send an amount from the person's main
 * balance to their own wallet, once under the move's id, after a fresh second factor; `recordDeposit` keeps the wallet's
 * own signed deposit to the venue for that move. Nothing here posts to the ledger.
 */

const moveId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'a lower-case uuid');
const wallet = z.string().regex(/^0x[0-9a-f]{40}$/, 'a lower-case EVM address');
const asset = z.string().regex(/^[A-Z0-9]{2,16}$/);

export const ownMoveView = z.object({
  id: z.string(),
  direction: z.literal('in'),
  assetId: z.string(),
  amount: z.string(),
  wallet: z.string(),
  status: z.enum(['opening', 'sent']),
  partner: z.string(),
  partnerRef: z.string().nullable(),
  partnerFee: z.string().nullable(),
  deliveryTx: z.string().nullable(),
  depositTx: z.string().nullable(),
  createdAt: z.string(),
  sentAt: z.string().nullable(),
  depositAt: z.string().nullable(),
});

function moveOut(m: OwnMove): z.infer<typeof ownMoveView> {
  return {
    id: m.id,
    direction: m.direction,
    assetId: m.assetId,
    amount: formatAmount(m.amount),
    wallet: m.wallet,
    status: m.status,
    partner: m.partner,
    partnerRef: m.partnerRef,
    partnerFee: m.partnerFee === null ? null : formatAmount(m.partnerFee),
    deliveryTx: m.deliveryTx,
    depositTx: m.depositTx,
    createdAt: m.createdAt.toISOString(),
    sentAt: m.sentAt?.toISOString() ?? null,
    depositAt: m.depositAt?.toISOString() ?? null,
  };
}

export function createOwnMovesRouter(c: BankRouterContext) {
  const { bank } = c;
  // Always required; a router built without one fails closed.
  const gate = c.options.ownMoveStepUp ?? createStepUpGate({ mode: 'required', approvals: unwiredApprovalConsumer() });
  return router({
    /** The exact message the wallet signs for one move: it proves the wallet is the person's and names the move. */
    message: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ moveId, assetId: asset, amount: amountString, wallet }).strict())
      .output(z.object({ message: z.string() }))
      .query(({ input }) => ({ message: ownMoveMessage(input) })),
    /** Spending to trading, leg one: the partner sends `amount` from the main balance to the person's own wallet, once. */
    toWallet: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z
          .object({
            moveId,
            assetId: asset,
            amount: amountString,
            wallet,
            walletSignature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
            stepUpApprovalId: stepUpApprovalField,
          })
          .strict(),
      )
      .output(ownMoveView)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          // A retry of the same move with the same approval replays; the move itself is once per id.
          await gate.require({
            userId: ctx.principal.userId,
            sessionId: ctx.principal.sid,
            actionType: 'bank.step_up.ownMoves.toWallet',
            fields: {
              actor: ctx.principal.userId,
              moveId: input.moveId,
              assetId: input.assetId,
              amount: input.amount,
              wallet: input.wallet,
            },
            operationKey: input.moveId,
            approvalId: input.stepUpApprovalId,
            replay: true,
          });
          return moveOut(await bank.ownMoves.toWallet(ctx.principal.userId, input));
        }),
      ),
    /** Spending to trading, leg two: the wallet's own signed deposit to the venue for this move, recorded once. */
    recordDeposit: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ moveId, depositTx: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).strict())
      .output(ownMoveView)
      .mutation(({ ctx, input }) => guard(async () => moveOut(await bank.ownMoves.recordDeposit(ctx.principal.userId, input)))),
    get: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ moveId }).strict())
      .output(ownMoveView.nullable())
      .query(({ ctx, input }) =>
        guard(async () => {
          const move = await bank.ownMoves.get(ctx.principal.userId, input.moveId);
          return move ? moveOut(move) : null;
        }),
      ),
    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ limit: z.number().int().min(1).max(100) }).strict())
      .output(z.array(ownMoveView))
      .query(({ ctx, input }) => guard(async () => (await bank.ownMoves.list(ctx.principal.userId, input.limit)).map(moveOut))),
  });
}
