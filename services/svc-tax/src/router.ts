import { TRPCError } from '@trpc/server';
import { mountRecords, type RefusalOf } from '@intafaced/contracts/procedure-mount';
import { TAX_PROCEDURES } from '@intafaced/contracts/tax-procedures';
import { TAX_EXPORT_INCOMPLETE, TAX_JURISDICTION_UNMAPPED, TaxError } from './codes.js';
import type { TaxService } from './tax-service.js';

/** svc-tax's one refusal type, in its wire form: PRECONDITION_FAILED, the code leading the message. Once per service. */
const taxRefusal: RefusalOf = (err) =>
  err instanceof TaxError
    ? { code: err.code, error: new TRPCError({ code: 'PRECONDITION_FAILED', message: `${err.code} — ${err.message}`, cause: err }) }
    : undefined;

/** svc-tax's router, mounted from its records (`@intafaced/contracts/tax-procedures`): this file holds only the handlers. */
export function createTaxRouter(tax: TaxService) {
  return mountRecords(
    TAX_PROCEDURES,
    {
      'tax.health': () => ({ ok: true as const, service: 'svc-tax' as const }),
      /** Self-only profit and loss indicator from the caller's own fills. Read-only; not a tax pack and not jurisdiction-gated. */
      'tax.lotBook': ({ ctx, input }) =>
        tax.lotBook({ userId: ctx.principal!.userId, ...(input?.method === undefined ? {} : { method: input.method }) }),
      /** The indicator over a date range: the cumulative result at each moment, and the change split by coin, market and day. */
      'tax.pnlOverTime': ({ ctx, input }) =>
        tax.pnlOverTime({
          userId: ctx.principal!.userId,
          from: input.from,
          ...(input.to === undefined ? {} : { to: input.to }),
          utcOffsetMinutes: input.utcOffsetMinutes,
        }),
      /** Open lots and disposals that still have no basis. The effect is "unknown share", never a made-up gain. */
      'tax.missingBasis': ({ ctx, input }) =>
        tax.missingBasis({ userId: ctx.principal!.userId, ...(input?.method === undefined ? {} : { method: input.method }) }),
      /** Customer-entered price for a lot with no cost, or a manual position held apart from balances. */
      'tax.basisOverride.set': ({ ctx, input }) => tax.basisOverrideSet({ userId: ctx.principal!.userId, ...input }),
      /** Tombstone. The ledger is unchanged, and the book shows the unknown again. */
      'tax.basisOverride.remove': ({ ctx, input }) => tax.basisOverrideRemove({ userId: ctx.principal!.userId, lotId: input.lotId }),
      /** The caller's own matching method for the account or one coin. Settings only: nothing is posted to the ledger. */
      'tax.setLotMethod': async ({ ctx, input }) => {
        await tax.setLotMethod({ userId: ctx.principal!.userId, assetId: input.assetId, method: input.method });
        return { saved: true as const };
      },
      /** The caller's own method for one UTC day. Settings only. */
      'tax.setDayMethod': async ({ ctx, input }) => {
        await tax.setDayMethod({ userId: ctx.principal!.userId, day: input.day, assetId: input.assetId, method: input.method });
        return { saved: true as const };
      },
      /** The lot one of the caller's own sales draws on first. Checked against the caller's own book. Settings only. */
      'tax.pickSaleLot': async ({ ctx, input }) => {
        await tax.pickSaleLot({ userId: ctx.principal!.userId, saleTxId: input.saleTxId, assetId: input.assetId, lotId: input.lotId });
        return { saved: true as const };
      },
      /** Whether the caller's own deposits, transfers in and withdrawals count in their profit and loss. Settings only. */
      'tax.setIncludeTransfers': async ({ ctx, input }) => {
        await tax.setIncludeTransfers({ userId: ctx.principal!.userId, include: input.include });
        return { saved: true as const };
      },
      'tax.exportPreview': ({ ctx, input }) =>
        tax.exportPreview({ userId: ctx.principal!.userId, region: ctx.region, lotMethod: input.lotMethod, complete: input.complete }),
      'tax.exportPack': ({ ctx, input }) =>
        tax.exportPack({ userId: ctx.principal!.userId, region: ctx.region, lotMethod: input.lotMethod, complete: input.complete }),
    },
    taxRefusal,
  );
}

export type TaxRouter = ReturnType<typeof createTaxRouter>;

/** Grep anchor for the shell golden / Portfolio card. */
export const UNMAPPED_REFUSE = TAX_JURISDICTION_UNMAPPED;
/** Completeness is OWNER map — export door never claims complete. */
export const INCOMPLETE_REFUSE = TAX_EXPORT_INCOMPLETE;
