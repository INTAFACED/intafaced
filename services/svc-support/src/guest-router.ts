import {
  publicProcedure,
  supportCommentSchema,
  supportGuestCreateInputSchema,
  supportGuestCreateResultSchema,
  supportGuestReplyInputSchema,
  supportGuestThreadInputSchema,
  supportGuestThreadSchema,
  supportGuestVerifyInputSchema,
  supportGuestVerifyResultSchema,
} from '@intafaced/contracts';
import type { GuestRequests } from './guest-requests.js';
import { SupportError } from './support-service.js';

/**
 * The guest path (SP-tickets-01): public calls, no session. `GuestRequests` checks the tokens. The tokens travel in the body of a POST, never in an address. With no guest path wired, every call refuses
 * `vendor.email`.
 */
export function guestProcedures(guests: GuestRequests | undefined, mapError: (err: unknown) => never) {
  const run = async <T>(call: (guests: GuestRequests) => Promise<T>): Promise<T> => {
    try {
      if (!guests) throw new SupportError('a verification email needs an email sender', 'vendor.email');
      return await call(guests);
    } catch (err) {
      mapError(err);
    }
  };
  return {
    guestCreate: publicProcedure
      .input(supportGuestCreateInputSchema)
      .output(supportGuestCreateResultSchema)
      .mutation(({ input }) => run((g) => g.create(input))),
    guestVerify: publicProcedure
      .input(supportGuestVerifyInputSchema)
      .output(supportGuestVerifyResultSchema)
      .mutation(({ input }) => run((g) => g.verify(input))),
    guestThread: publicProcedure
      .input(supportGuestThreadInputSchema)
      .output(supportGuestThreadSchema)
      .mutation(({ input }) => run((g) => g.thread(input))),
    guestReply: publicProcedure
      .input(supportGuestReplyInputSchema)
      .output(supportCommentSchema)
      .mutation(({ input }) => run((g) => g.reply(input))),
  };
}
