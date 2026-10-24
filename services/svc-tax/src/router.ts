import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { publicProcedure, router, scopedProcedure } from '@intafaced/contracts';
import {
  basisOverrideRemoveInputSchema,
  basisOverrideSetInputSchema,
  basisWriteResultSchema,
  lotBookInputSchema,
  lotBookSchema,
  lotChoiceSavedSchema,
  missingBasisSchema,
  pickSaleLotInputSchema,
  setDayMethodInputSchema,
  setLotMethodInputSchema,
} from '@intafaced/contracts/tax-lot-book';
import { TAX_EXPORT_INCOMPLETE, TAX_JURISDICTION_UNMAPPED, TaxError } from './codes.js';
import { LOT_METHODS } from './lots.js';
import type { TaxService } from './tax-service.js';

const lotMethod = z.enum(LOT_METHODS);

const lakeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('absent'),
    code: z.enum(['tax.data_lake_unavailable', 'tax.indexer_unavailable']),
  }),
  z.object({
    status: z.literal('configured'),
    code: z.enum(['tax.data_lake_unprobed', 'tax.indexer_unprobed']),
  }),
]);

const yearLineSchema = z.object({
  kind: z.enum(['fill', 'convert']),
  postedAt: z.string(),
  assetId: z.string(),
  qty: z.string(),
  fee: z.string().nullable(),
  makerRebate: z.string().nullable(),
  costBasis: z.string().nullable(),
  proceeds: z.string().nullable(),
  realized: z.string().nullable(),
});

const subAccountYearSchema = z.object({
  subAccountId: z.string(),
  lines: z.array(yearLineSchema),
  realized: z.string().nullable(),
  residuals: z.array(z.string()),
});

const previewSchema = z.object({
  empty: z.boolean(),
  complete: z.literal(false),
  lotMethod,
  jurisdiction: z.string(),
  lotCount: z.number().int().nonnegative(),
  realized: z.string().nullable(),
  unrealized: z.string().nullable(),
  lake: lakeSchema,
  indexer: lakeSchema,
  residuals: z.array(z.string()),
  subAccountBooks: z.enum(['unwired', 'read']),
  subAccounts: z.array(subAccountYearSchema),
});

const exportInput = z.object({
  lotMethod,
  /** Completeness is OWNER map. `true` is named-refused — never invent jurisdictions. */
  complete: z.boolean().optional(),
});

const packSchema = previewSchema.extend({
  filename: z.string().min(1),
  mime: z.literal('application/json'),
  bodyBase64: z.string().min(1),
});

function mapError(err: unknown): never {
  if (err instanceof TaxError) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `${err.code} — ${err.message}`,
      cause: err,
    });
  }
  throw err;
}

export function createTaxRouter(tax: TaxService) {
  return router({
    health: publicProcedure
      .output(z.object({ ok: z.literal(true), service: z.literal('svc-tax') }))
      .query(() => ({ ok: true as const, service: 'svc-tax' as const })),

    /** Self-only profit and loss indicator from the caller's own fills. Read-only; not a tax pack and not jurisdiction-gated. */
    lotBook: scopedProcedure('tax:read', { module: 'tax', plane: 'fiat' })
      .input(lotBookInputSchema)
      .output(lotBookSchema)
      .query(async ({ ctx, input }) => {
        try {
          return await tax.lotBook({ userId: ctx.principal!.userId, ...(input?.method === undefined ? {} : { method: input.method }) });
        } catch (err) {
          mapError(err);
        }
      }),

    /** Open lots and disposals that still have no basis. The effect is "unknown share", never a made-up gain. */
    missingBasis: scopedProcedure('tax:read', { module: 'tax', plane: 'fiat' })
      .input(lotBookInputSchema)
      .output(missingBasisSchema)
      .query(async ({ ctx, input }) => {
        try {
          return await tax.missingBasis({
            userId: ctx.principal!.userId,
            ...(input?.method === undefined ? {} : { method: input.method }),
          });
        } catch (err) {
          mapError(err);
        }
      }),

    basisOverride: router({
      /** Customer-entered price for a lot with no cost, or a manual position held apart from balances. */
      set: scopedProcedure('tax:write', { module: 'tax', plane: 'fiat' })
        .input(basisOverrideSetInputSchema)
        .output(basisWriteResultSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await tax.basisOverrideSet({ userId: ctx.principal!.userId, ...input });
          } catch (err) {
            mapError(err);
          }
        }),
      /** Tombstone. The ledger is unchanged, and the book shows the unknown again. */
      remove: scopedProcedure('tax:write', { module: 'tax', plane: 'fiat' })
        .input(basisOverrideRemoveInputSchema)
        .output(basisWriteResultSchema)
        .mutation(async ({ ctx, input }) => {
          try {
            return await tax.basisOverrideRemove({ userId: ctx.principal!.userId, lotId: input.lotId });
          } catch (err) {
            mapError(err);
          }
        }),
    }),

    /** The caller's own matching method for the account or one coin. Settings only: nothing is posted to the ledger. */
    setLotMethod: scopedProcedure('tax:write', { module: 'tax', plane: 'fiat' })
      .input(setLotMethodInputSchema)
      .output(lotChoiceSavedSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          await tax.setLotMethod({ userId: ctx.principal!.userId, assetId: input.assetId, method: input.method });
          return { saved: true as const };
        } catch (err) {
          mapError(err);
        }
      }),

    /** The caller's own method for one UTC day. Settings only. */
    setDayMethod: scopedProcedure('tax:write', { module: 'tax', plane: 'fiat' })
      .input(setDayMethodInputSchema)
      .output(lotChoiceSavedSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          await tax.setDayMethod({ userId: ctx.principal!.userId, day: input.day, assetId: input.assetId, method: input.method });
          return { saved: true as const };
        } catch (err) {
          mapError(err);
        }
      }),

    /** The lot one of the caller's own sales draws on first. Checked against the caller's own book. Settings only. */
    pickSaleLot: scopedProcedure('tax:write', { module: 'tax', plane: 'fiat' })
      .input(pickSaleLotInputSchema)
      .output(lotChoiceSavedSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          await tax.pickSaleLot({ userId: ctx.principal!.userId, saleTxId: input.saleTxId, assetId: input.assetId, lotId: input.lotId });
          return { saved: true as const };
        } catch (err) {
          mapError(err);
        }
      }),

    exportPreview: scopedProcedure('tax:read', { module: 'tax', plane: 'fiat' })
      .input(exportInput)
      .output(previewSchema)
      .query(async ({ ctx, input }) => {
        try {
          return await tax.exportPreview({
            userId: ctx.principal!.userId,
            region: ctx.region,
            lotMethod: input.lotMethod,
            complete: input.complete,
          });
        } catch (err) {
          mapError(err);
        }
      }),

    exportPack: scopedProcedure('tax:read', { module: 'tax', plane: 'fiat' })
      .input(exportInput)
      .output(packSchema)
      .mutation(async ({ ctx, input }) => {
        try {
          return await tax.exportPack({
            userId: ctx.principal!.userId,
            region: ctx.region,
            lotMethod: input.lotMethod,
            complete: input.complete,
          });
        } catch (err) {
          mapError(err);
        }
      }),
  });
}

export type TaxRouter = ReturnType<typeof createTaxRouter>;

/** Grep anchor for the shell golden / Portfolio card. */
export const UNMAPPED_REFUSE = TAX_JURISDICTION_UNMAPPED;
/** Completeness is OWNER map — export door never claims complete. */
export const INCOMPLETE_REFUSE = TAX_EXPORT_INCOMPLETE;
