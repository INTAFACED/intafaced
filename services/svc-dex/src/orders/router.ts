import { TRPCError, publicJurisdictionProcedure, router } from '@intafaced/contracts';
import {
  dexCallsOutputSchema,
  dexDepositInputSchema,
  dexOrderCancelOutputSchema,
  dexOrderCreateInputSchema,
  dexOrderCreateOutputSchema,
  dexOrderEditInputSchema,
  dexOrderEditPreparedSchema,
  dexOrderHistoryOutputSchema,
  dexOrderListInputSchema,
  dexOrderListOutputSchema,
  dexOrderPrepareInputSchema,
  dexOrderPrepareOutputSchema,
  dexOrderRefInputSchema,
  dexOrderUpdateInputSchema,
  dexOrderViewSchema,
  dexOrdersCountInputSchema,
  dexOrdersCountOutputSchema,
  dexSweepInputSchema,
  dexSweepOutputSchema,
  dexVaultInputSchema,
  dexVaultOutputSchema,
  dexWithdrawOutputSchema,
} from '@intafaced/contracts/protocol-dex-orders';
import type { Hex } from 'viem';
import { OrderSessionRefused, type OrderSessions } from '../auth/order-session.js';
import { orderSessionTrpcError } from '../auth/router.js';
import { VaultOrderRefused, vaultCodes } from '../vault/errors.js';
import type { WalletOrders } from '../vault/orders.js';

/** The HTTP shape of a wallet-order refusal, its code leading the message. */
export function vaultTrpcError(err: VaultOrderRefused): TRPCError {
  const code =
    err.code === vaultCodes.notFound
      ? 'NOT_FOUND'
      : err.code === vaultCodes.conflict || err.code === vaultCodes.notEditable || err.code === vaultCodes.notCancellable
        ? 'CONFLICT'
        : err.code === vaultCodes.railCrypto
          ? 'SERVICE_UNAVAILABLE'
          : err.code === vaultCodes.internal
            ? 'INTERNAL_SERVER_ERROR'
            : err.code.endsWith('_unset')
              ? 'PRECONDITION_FAILED'
              : 'BAD_REQUEST';
  return new TRPCError({ code, message: `${err.code} — ${err.message}`, cause: err });
}

async function guarded<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof OrderSessionRefused) throw orderSessionTrpcError(err);
    if (err instanceof VaultOrderRefused) throw vaultTrpcError(err);
    throw err;
  }
}

/**
 * `orders.*`: the person's own wallet orders (D-limit-dca-01 to -04). `count`, `vault`, `deposit` and `withdraw` are
 * public: a count, the vault's own on-chain credit, and unsigned calls only the wallet can send. Every read of an
 * order's terms and every change needs the wallet's order session; the maker is read from its token.
 */
export function walletOrdersRouter(orders: WalletOrders, sessions: OrderSessions) {
  const door = publicJurisdictionProcedure('dex', 'protocol');
  const who = (token: string) => sessions.principal(token);
  return router({
    count: door
      .input(dexOrdersCountInputSchema)
      .output(dexOrdersCountOutputSchema)
      .mutation(({ input }) => ({ wallet: input.wallet, count: orders.countByMaker(input.wallet) })),
    vault: door
      .input(dexVaultInputSchema)
      .output(dexVaultOutputSchema)
      .mutation(({ input }) => guarded(() => orders.vault(input.wallet, input.token))),
    deposit: door
      .input(dexDepositInputSchema)
      .output(dexCallsOutputSchema)
      .mutation(({ input }) => guarded(async () => ({ calls: await orders.depositCalls(input.wallet, input.token, input.amount) }))),
    withdraw: door
      .input(dexVaultInputSchema)
      .output(dexWithdrawOutputSchema)
      .mutation(({ input }) => guarded(() => orders.withdrawCall(input.wallet, input.token))),
    sweep: door
      .input(dexSweepInputSchema)
      .output(dexSweepOutputSchema)
      .mutation(({ input }) => guarded(() => orders.sweep(who(input.accessToken).wallet, input.token))),
    prepare: door
      .input(dexOrderPrepareInputSchema)
      .output(dexOrderPrepareOutputSchema)
      .mutation(({ input }) =>
        guarded(() => {
          const { accessToken, ...rest } = input;
          return orders.prepare(who(accessToken), rest);
        }),
      ),
    create: door
      .input(dexOrderCreateInputSchema)
      .output(dexOrderCreateOutputSchema)
      .mutation(({ input }) =>
        guarded(async () => ({ orders: await orders.create(who(input.accessToken), input.draftId, input.signatures as Hex[]) })),
      ),
    list: door
      .input(dexOrderListInputSchema)
      .output(dexOrderListOutputSchema)
      .mutation(({ input }) => guarded(() => orders.list(who(input.accessToken), input))),
    history: door
      .input(dexOrderRefInputSchema)
      .output(dexOrderHistoryOutputSchema)
      .mutation(({ input }) => guarded(() => orders.history(who(input.accessToken), input.id))),
    prepareEdit: door
      .input(dexOrderEditInputSchema)
      .output(dexOrderEditPreparedSchema)
      .mutation(({ input }) => guarded(() => orders.prepareEdit(who(input.accessToken), input.id, { trigger: input.trigger }))),
    update: door
      .input(dexOrderUpdateInputSchema)
      .output(dexOrderViewSchema)
      .mutation(({ input }) => guarded(() => orders.update(who(input.accessToken), input.draftId, input.signature as Hex))),
    cancel: door
      .input(dexOrderRefInputSchema)
      .output(dexOrderCancelOutputSchema)
      .mutation(({ input }) => guarded(() => orders.cancel(who(input.accessToken), input.id))),
  });
}
