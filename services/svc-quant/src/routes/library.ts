import {
  publicJurisdictionProcedure,
  quantAccessRequestInputSchema,
  quantAccessSetInputSchema,
  quantLibraryBrowseInputSchema,
  quantLibraryOptionsSchema,
  quantLibraryPageSchema,
  quantLineageReadSchema,
  quantLineageSchema,
  quantListingCheckInputSchema,
  quantListingCheckSchema,
  quantListingPageSchema,
  quantListingPreviewSchema,
  quantListingPublishInputSchema,
  quantListingSchema,
  quantMyListingsSchema,
  quantReviewInputSchema,
  router,
} from '@intafaced/contracts';
import { z } from 'zod';
import { toTrpc, accountField, type QuantCore } from './core.js';

export function libraryRoutes(core: QuantCore) {
  const { accountOf, library } = core;
  return router({
    options: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ ...accountField }).optional())
      .output(quantLibraryOptionsSchema)
      .query(async ({ input, ctx }) => {
        try {
          accountOf(ctx, input?.accountId);
          return library.options();
        } catch (err) {
          toTrpc(err);
        }
      }),
    check: publicJurisdictionProcedure('quant', 'fiat')
      .input(quantListingCheckInputSchema.extend(accountField))
      .output(quantListingCheckSchema)
      .query(async ({ input, ctx }) => {
        try {
          return await library.check(accountOf(ctx, input.accountId), input);
        } catch (err) {
          toTrpc(err);
        }
      }),
    publish: publicJurisdictionProcedure('quant', 'fiat')
      .input(quantListingPublishInputSchema.extend(accountField))
      .output(quantListingSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          return await library.publish(accountOf(ctx, input.accountId), input);
        } catch (err) {
          toTrpc(err);
        }
      }),
    mine: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ ...accountField }).optional())
      .output(quantMyListingsSchema)
      .query(async ({ input, ctx }) => {
        try {
          return { listings: await library.mine(accountOf(ctx, input?.accountId)) };
        } catch (err) {
          toTrpc(err);
        }
      }),
    browse: publicJurisdictionProcedure('quant', 'fiat')
      .input(quantLibraryBrowseInputSchema.extend(accountField))
      .output(quantLibraryPageSchema)
      .query(async ({ input, ctx }) => {
        try {
          accountOf(ctx, input.accountId);
          return await library.browse({ tag: input.tag ?? null, limit: input.limit, cursor: input.cursor ?? null });
        } catch (err) {
          toTrpc(err);
        }
      }),
    preview: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ listingId: z.string().min(1).max(64), ...accountField }))
      .output(quantListingPreviewSchema)
      .query(async ({ input, ctx }) => {
        try {
          return await library.preview(accountOf(ctx, input.accountId), input.listingId);
        } catch (err) {
          toTrpc(err);
        }
      }),
    get: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ listingId: z.string().min(1).max(64), ...accountField }))
      .output(quantListingPageSchema)
      .query(async ({ input, ctx }) => {
        try {
          return await library.get(accountOf(ctx, input.accountId), input.listingId);
        } catch (err) {
          toTrpc(err);
        }
      }),
    request: publicJurisdictionProcedure('quant', 'fiat')
      .input(quantAccessRequestInputSchema.extend(accountField))
      .output(quantListingPreviewSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          return await library.request(accountOf(ctx, input.accountId), input);
        } catch (err) {
          toTrpc(err);
        }
      }),
    grant: publicJurisdictionProcedure('quant', 'fiat')
      .input(quantAccessSetInputSchema.extend(accountField))
      .output(quantListingSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          return await library.setAccess(accountOf(ctx, input.accountId), input, 'grant');
        } catch (err) {
          toTrpc(err);
        }
      }),
    revoke: publicJurisdictionProcedure('quant', 'fiat')
      .input(quantAccessSetInputSchema.extend(accountField))
      .output(quantListingSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          return await library.setAccess(accountOf(ctx, input.accountId), input, 'revoke');
        } catch (err) {
          toTrpc(err);
        }
      }),
    clone: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ listingId: z.string().min(1).max(64), ...accountField }))
      .output(quantLineageSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          return await library.clone(accountOf(ctx, input.accountId), input.listingId);
        } catch (err) {
          toTrpc(err);
        }
      }),
    lineage: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ strategyId: z.string().min(1).max(128), ...accountField }))
      .output(quantLineageReadSchema)
      .query(async ({ input, ctx }) => {
        try {
          return { lineage: await library.lineage(accountOf(ctx, input.accountId), input.strategyId) };
        } catch (err) {
          toTrpc(err);
        }
      }),
    review: publicJurisdictionProcedure('quant', 'fiat')
      .input(quantReviewInputSchema.extend(accountField))
      .output(quantListingPageSchema)
      .mutation(async ({ input, ctx }) => {
        try {
          return await library.review(accountOf(ctx, input.accountId), input);
        } catch (err) {
          toTrpc(err);
        }
      }),
  });
}
