import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { SavedRecipientError, SavedRecipientService } from './saved-recipients.js';

/**
 * `recipients.list` / `add` / `remove`. Names on the wire are handles.
 * A session without `identity:read` or `identity:write` is refused before SQL.
 */
const saved = z.object({
  handle: z.string(),
  label: z.string(),
  addedAt: z.string().datetime(),
});

function mapErr(err: unknown): never {
  if (err instanceof SavedRecipientError) {
    const code = err.code === 'identity.recipient_conflict' ? 'CONFLICT' : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message, cause: err });
  }
  throw err;
}

export function createSavedRecipientsRouter(service: SavedRecipientService) {
  return router({
    recipients: router({
      list: scopedProcedure('identity:read', { module: 'identity' })
        .input(z.object({ limit: z.number().int().min(1).max(100).optional() }))
        .output(z.array(saved))
        .query(async ({ ctx, input }) => {
          try {
            return await service.list(ctx.principal.userId, input.limit);
          } catch (err) {
            mapErr(err);
          }
        }),

      add: scopedProcedure('identity:write', { module: 'identity' })
        .input(
          z.object({
            handle: z.string().min(1).max(64),
            label: z.string().min(1).max(40),
            idempotencyKey: z.string().min(8).max(64),
          }),
        )
        .output(saved)
        .mutation(async ({ ctx, input }) => {
          try {
            return await service.add(ctx.principal.userId, input.handle, input.label, input.idempotencyKey);
          } catch (err) {
            mapErr(err);
          }
        }),

      remove: scopedProcedure('identity:write', { module: 'identity' })
        .input(z.object({ handle: z.string().min(1).max(64), idempotencyKey: z.string().min(8).max(64) }))
        .output(z.object({ removed: z.boolean(), handle: z.string() }))
        .mutation(async ({ ctx, input }) => {
          try {
            return await service.remove(ctx.principal.userId, input.handle, input.idempotencyKey);
          } catch (err) {
            mapErr(err);
          }
        }),
    }),
  });
}
