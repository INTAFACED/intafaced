import { router } from '@intafaced/contracts/trpc';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import {
  QUANT_LIBRARY_BROWSE,
  QUANT_LIBRARY_CHECK,
  QUANT_LIBRARY_CLONE,
  QUANT_LIBRARY_GET,
  QUANT_LIBRARY_GRANT,
  QUANT_LIBRARY_LINEAGE,
  QUANT_LIBRARY_MINE,
  QUANT_LIBRARY_OPTIONS,
  QUANT_LIBRARY_PREVIEW,
  QUANT_LIBRARY_PUBLISH,
  QUANT_LIBRARY_REQUEST,
  QUANT_LIBRARY_REVIEW,
  QUANT_LIBRARY_REVOKE,
} from '@intafaced/contracts/quant-library-procedures';
import { quantRefusal, toTrpc, type QuantCore } from './core.js';

/** `quant.library.*`, mounted from its records (`@intafaced/contracts/quant-library-procedures`). */
export function libraryRoutes(core: QuantCore) {
  const { accountOf, library } = core;
  return router({
    options: mountRecord(
      QUANT_LIBRARY_OPTIONS,
      async ({ input, ctx }) => {
        try {
          accountOf(ctx, input?.accountId);
          return library.options();
        } catch (err) {
          toTrpc(err);
        }
      },
      quantRefusal,
    ),
    check: mountRecord(
      QUANT_LIBRARY_CHECK,
      async ({ input, ctx }) => {
        try {
          return await library.check(accountOf(ctx, input.accountId), input);
        } catch (err) {
          toTrpc(err);
        }
      },
      quantRefusal,
    ),
    publish: mountRecord(
      QUANT_LIBRARY_PUBLISH,
      async ({ input, ctx }) => {
        try {
          return await library.publish(accountOf(ctx, input.accountId), input);
        } catch (err) {
          toTrpc(err);
        }
      },
      quantRefusal,
    ),
    mine: mountRecord(
      QUANT_LIBRARY_MINE,
      async ({ input, ctx }) => {
        try {
          return { listings: await library.mine(accountOf(ctx, input?.accountId)) };
        } catch (err) {
          toTrpc(err);
        }
      },
      quantRefusal,
    ),
    browse: mountRecord(
      QUANT_LIBRARY_BROWSE,
      async ({ input, ctx }) => {
        try {
          accountOf(ctx, input.accountId);
          return await library.browse({ tag: input.tag ?? null, limit: input.limit, cursor: input.cursor ?? null });
        } catch (err) {
          toTrpc(err);
        }
      },
      quantRefusal,
    ),
    preview: mountRecord(
      QUANT_LIBRARY_PREVIEW,
      async ({ input, ctx }) => {
        try {
          return await library.preview(accountOf(ctx, input.accountId), input.listingId);
        } catch (err) {
          toTrpc(err);
        }
      },
      quantRefusal,
    ),
    get: mountRecord(
      QUANT_LIBRARY_GET,
      async ({ input, ctx }) => {
        try {
          return await library.get(accountOf(ctx, input.accountId), input.listingId);
        } catch (err) {
          toTrpc(err);
        }
      },
      quantRefusal,
    ),
    request: mountRecord(
      QUANT_LIBRARY_REQUEST,
      async ({ input, ctx }) => {
        try {
          return await library.request(accountOf(ctx, input.accountId), input);
        } catch (err) {
          toTrpc(err);
        }
      },
      quantRefusal,
    ),
    grant: mountRecord(
      QUANT_LIBRARY_GRANT,
      async ({ input, ctx }) => {
        try {
          return await library.setAccess(accountOf(ctx, input.accountId), input, 'grant');
        } catch (err) {
          toTrpc(err);
        }
      },
      quantRefusal,
    ),
    revoke: mountRecord(
      QUANT_LIBRARY_REVOKE,
      async ({ input, ctx }) => {
        try {
          return await library.setAccess(accountOf(ctx, input.accountId), input, 'revoke');
        } catch (err) {
          toTrpc(err);
        }
      },
      quantRefusal,
    ),
    clone: mountRecord(
      QUANT_LIBRARY_CLONE,
      async ({ input, ctx }) => {
        try {
          return await library.clone(accountOf(ctx, input.accountId), input.listingId);
        } catch (err) {
          toTrpc(err);
        }
      },
      quantRefusal,
    ),
    lineage: mountRecord(
      QUANT_LIBRARY_LINEAGE,
      async ({ input, ctx }) => {
        try {
          return { lineage: await library.lineage(accountOf(ctx, input.accountId), input.strategyId) };
        } catch (err) {
          toTrpc(err);
        }
      },
      quantRefusal,
    ),
    review: mountRecord(
      QUANT_LIBRARY_REVIEW,
      async ({ input, ctx }) => {
        try {
          return await library.review(accountOf(ctx, input.accountId), input);
        } catch (err) {
          toTrpc(err);
        }
      },
      quantRefusal,
    ),
  });
}
