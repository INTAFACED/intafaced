import { TRPCError, type Context } from '@intafaced/contracts';
import { IDENTITY_RECIPIENTS_PROCEDURES } from '@intafaced/contracts/identity-recipients-procedures';
import { mountRecords, type RefusalOf } from '@intafaced/contracts/procedure-mount';
import { RECIPIENT_CONFLICT, SavedRecipientError, SavedRecipientService } from './saved-recipients.js';

/** A `SavedRecipientError` leaves as CONFLICT for a reused key on other terms, else BAD_REQUEST, with its own message. */
const recipientRefusal: RefusalOf = (err) =>
  err instanceof SavedRecipientError
    ? {
        code: err.code,
        error: new TRPCError({ code: err.code === RECIPIENT_CONFLICT ? 'CONFLICT' : 'BAD_REQUEST', message: err.message, cause: err }),
      }
    : undefined;

/** The signed-in owner; the record's scope guard has already refused a call without one. */
function ownerOf(ctx: Context): string {
  if (ctx.principal === null || ctx.principal === undefined) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in first' });
  return ctx.principal.userId;
}

/**
 * `recipients.list` / `add` / `remove`, mounted from their records (`@intafaced/contracts/identity-recipients-procedures`).
 * A session without `identity:read` or `identity:write` is refused before SQL.
 */
export function createSavedRecipientsRouter(service: SavedRecipientService) {
  return mountRecords(
    IDENTITY_RECIPIENTS_PROCEDURES,
    {
      'identity.recipients.list': ({ ctx, input }) => service.list(ownerOf(ctx), input.limit),
      'identity.recipients.add': ({ ctx, input }) => service.add(ownerOf(ctx), input.handle, input.label, input.idempotencyKey),
      'identity.recipients.remove': ({ ctx, input }) => service.remove(ownerOf(ctx), input.handle, input.idempotencyKey),
    },
    recipientRefusal,
  );
}
