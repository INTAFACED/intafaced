import { router, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { z } from 'zod';
import type { FounderAuthority } from '../founder-authority.js';
import { founderProcedure, type FounderContext } from '../namespaces/founder-procedure.js';
import { custodyToTrpcError } from './errors.js';
import {
  accountKeyInputSchema,
  accountViewSchema,
  entityCreateInputSchema,
  entityListInputSchema,
  entityViewSchema,
  ownerLookupSchema,
  vaultCreateInputSchema,
  vaultListInputSchema,
  vaultReconciliationInputSchema,
  vaultRenameInputSchema,
  vaultViewSchema,
  vaultVisibilityInputSchema,
  walletAddInputSchema,
  walletGetInputSchema,
  walletListInputSchema,
  walletLookupInputSchema,
  walletTypeViewSchema,
  walletViewSchema,
} from './schemas.js';
import { createCustodyApprovalRouters } from './approvals/router.js';
import { CustodyApprovalService, type TaskExecutor } from './approvals/service.js';
import { createCustodyStuckRouters } from './stuck/router.js';
import { CustodyStuckService, type DroppedReverser, type NonceChain, type TxReplacer, type WithdrawalCanceller } from './stuck/service.js';
import { createCustodyTxRouters } from './tx/router.js';
import { CustodyTxService, type TxChainReader } from './tx/service.js';
import { createCustodyFeesRouters } from './fees/router.js';
import { createCustodySweepRouters } from './sweeps/router.js';
import { CustodySweepService, type SweepBroadcaster } from './sweeps/service.js';
import { CustodyFeesService, type FeeEstimator } from './fees/service.js';
import { CustodyService } from './service.js';
import { createCustodyUtxoRouters } from './utxo/router.js';
import { CustodyUtxoService, type UtxoNode } from './utxo/service.js';

/** What a mount supplies besides the founder authority. */
export type CustodyMountDeps = Omit<CustodyRouterDeps, 'founderAuthority'>;

export interface CustodyRouterDeps {
  readonly founderAuthority: FounderAuthority;
  readonly sql: Sql;
  /** The chain fee estimator (W-custody-ops-10). Omitted: `fees.estimate` and `fees.check` refuse. */
  readonly feeEstimator?: FeeEstimator;
  /** The UTXO node (W-custody-ops-13). Omitted: `utxo.list`, `utxo.due` and `utxo.consolidate` refuse `rail.crypto`. */
  readonly utxoNode?: UtxoNode;
  /** The sweep broadcaster (W-custody-ops-05). Omitted: `sweeps.execute` refuses `rail.crypto` and the intent row stays. */
  readonly sweepBroadcaster?: SweepBroadcaster;
  /** The chain reader for block height and hash (W-custody-ops-11). Omitted: `tx.get` shows `unwired`. */
  readonly chainReader?: TxChainReader;
  /** W-custody-ops-12 ports. Omitted: boost/replace/drop refuse `rail.crypto`, and cancel and reverse say they are not connected. */
  readonly txReplacer?: TxReplacer;
  readonly nonceChain?: NonceChain;
  readonly withdrawalCanceller?: WithdrawalCanceller;
  readonly droppedReverser?: DroppedReverser;
  /** W-custody-ops-06: runs an approved custody transaction (W-custody-ops-09) and applies approved config changes, per scope. Omitted: those tasks are refused at submit. */
  readonly transactionExecutor?: TaskExecutor;
  readonly configAppliers?: ConstructorParameters<typeof CustodyApprovalService>[0]['configAppliers'];
}

function actorOf(ctx: unknown): string {
  const id = (ctx as Partial<FounderContext>).founderUserId;
  if (typeof id !== 'string' || id.trim() === '') throw new TRPCError({ code: 'FORBIDDEN', message: 'operator.denied' });
  return id;
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw custodyToTrpcError(error);
  }
}

/**
 * `founderAdmin.custody.*`: the custody account model (W-custody-ops-01). Founder-only: every procedure is built from
 * `founderProcedure`. Mounted INSIDE the founderAdmin router (see namespaces/founder-admin.ts). It holds no balance.
 */
export function createCustodyRouter(deps: CustodyRouterDeps) {
  const founder = founderProcedure(deps.founderAuthority);
  const service = new CustodyService({ sql: deps.sql });
  const feeRouters = createCustodyFeesRouters(founder, new CustodyFeesService({ sql: deps.sql, estimator: deps.feeEstimator }), actorOf);
  const utxoRouters = createCustodyUtxoRouters(
    founder,
    new CustodyUtxoService({ sql: deps.sql, node: deps.utxoNode, estimator: deps.feeEstimator }),
    actorOf,
  );
  const sweepRouters = createCustodySweepRouters(
    founder,
    new CustodySweepService({ sql: deps.sql, broadcaster: deps.sweepBroadcaster }),
    actorOf,
  );
  const txRouters = createCustodyTxRouters(founder, new CustodyTxService({ sql: deps.sql, chain: deps.chainReader }), actorOf);
  const stuckRouters = createCustodyStuckRouters(
    founder,
    new CustodyStuckService({
      sql: deps.sql,
      replacer: deps.txReplacer,
      chain: deps.nonceChain,
      canceller: deps.withdrawalCanceller,
      reverser: deps.droppedReverser,
    }),
    actorOf,
  );
  const approvalRouters = createCustodyApprovalRouters(
    founder,
    new CustodyApprovalService({ sql: deps.sql, transactionExecutor: deps.transactionExecutor, configAppliers: deps.configAppliers }),
    actorOf,
  );
  return router({
    ...approvalRouters,
    ...feeRouters,
    ...sweepRouters,
    ...utxoRouters,
    ...txRouters,
    ...stuckRouters,
    walletTypes: router({
      list: founder
        .input(z.object({}).strict().optional())
        .output(z.array(walletTypeViewSchema))
        .query(() => wrap(() => service.walletTypes())),
    }),
    entities: router({
      create: founder
        .input(entityCreateInputSchema)
        .output(entityViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.createEntity(actorOf(ctx), input))),
      list: founder
        .input(entityListInputSchema)
        .output(z.array(entityViewSchema))
        .query(({ input }) => wrap(() => service.listEntities(input))),
    }),
    accounts: router({
      list: founder
        .input(entityListInputSchema)
        .output(z.array(accountViewSchema))
        .query(({ input }) => wrap(() => service.listAccounts(input))),
      get: founder
        .input(accountKeyInputSchema)
        .output(accountViewSchema)
        .query(({ input }) => wrap(() => service.getAccount(input.entityId))),
    }),
    vaults: router({
      create: founder
        .input(vaultCreateInputSchema)
        .output(vaultViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.createVault(actorOf(ctx), input))),
      rename: founder
        .input(vaultRenameInputSchema)
        .output(vaultViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.renameVault(actorOf(ctx), input.vaultId, input.name, input.expectedVersion))),
      setVisibility: founder
        .input(vaultVisibilityInputSchema)
        .output(vaultViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.setVaultHidden(actorOf(ctx), input.vaultId, input.hidden, input.expectedVersion))),
      list: founder
        .input(vaultListInputSchema)
        .output(z.array(vaultViewSchema))
        .query(({ input }) => wrap(() => service.listVaults(input.entityId, input.visibility, input.limit, input.after))),
      reconciliation: founder
        .input(vaultReconciliationInputSchema)
        .output(z.array(vaultViewSchema))
        .query(({ input }) => wrap(() => service.reconciliationVaults(input.limit, input.after))),
    }),
    wallets: router({
      add: founder
        .input(walletAddInputSchema)
        .output(walletViewSchema)
        .mutation(({ ctx, input }) => wrap(() => service.addWallet(actorOf(ctx), input.vaultId, input.networkId, input.assetCode))),
      list: founder
        .input(walletListInputSchema)
        .output(z.array(walletViewSchema))
        .query(({ input }) => wrap(() => service.listWallets(input.vaultId, input.limit, input.after))),
      get: founder
        .input(walletGetInputSchema)
        .output(walletViewSchema)
        .query(({ input }) => wrap(() => service.getWallet(input.walletId))),
      lookupByAddress: founder
        .input(walletLookupInputSchema)
        .output(ownerLookupSchema)
        .query(({ input }) => wrap(() => service.lookupByAddress(input.networkId, input.address))),
    }),
  });
}
export type CustodyRouter = ReturnType<typeof createCustodyRouter>;
