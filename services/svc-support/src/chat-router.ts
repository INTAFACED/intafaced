import { z } from 'zod';
import { requireScope, type Principal } from '@intafaced/auth';
import {
  publicProcedure,
  scopedProcedure,
  supportChatAcceptInputSchema,
  supportChatAvailabilitySchema,
  supportChatDeskPollInputSchema,
  supportChatDeskPollSchema,
  supportChatDeskSessionSchema,
  supportChatEmailResultSchema,
  supportChatEnquiriesInputSchema,
  supportChatEnquirySchema,
  supportChatIdentityTokenSchema,
  supportChatInboxInputSchema,
  supportChatMessageSchema,
  supportChatOpenInputSchema,
  supportChatOpenResultSchema,
  supportChatPollInputSchema,
  supportChatPollSchema,
  supportChatReplyInputSchema,
  supportChatSendInputSchema,
  supportChatSessionInputSchema,
  supportChatSessionSchema,
  supportRequestSourceInputSchema,
  supportRequestSourceSchema,
} from '@intafaced/contracts';
import type { SupportChat } from './chat.js';
import { requireSupportOps, SupportError } from './support-service.js';

/**
 * Live chat (SP-chat-01). The customer doors are public, so a guest can chat: a signed principal counts only when it may
 * write support requests (`support:write`), and a session is then its own. Access tokens and keys travel in a POST body,
 * never in an address, so the customer's reads are mutations. The desk doors need `support:ops`.
 */
export function chatProcedures(chat: SupportChat | undefined, mapError: (err: unknown) => never) {
  const run = async <T>(call: (chat: SupportChat) => Promise<T>): Promise<T> => {
    try {
      if (!chat) throw new SupportError('chat is not wired in this process', 'support.chat_unwired');
      return await call(chat);
    } catch (err) {
      mapError(err);
    }
  };
  /** The signed account a customer door acts for, or null for a guest. A principal without `support:write` is refused. */
  const accountOf = (principal: Principal | null | undefined): string | null => {
    if (!principal) return null;
    requireScope(principal, 'support:write');
    return principal.userId;
  };
  return {
    chatAvailability: publicProcedure.output(supportChatAvailabilitySchema).query(() => run((c) => c.availability())),

    /** A claim naming the caller's own account, for a page that embeds the chat. */
    chatIdentityToken: scopedProcedure('support:write')
      .output(supportChatIdentityTokenSchema)
      .mutation(({ ctx }) => run(async (c) => c.identityToken(ctx.principal!.userId))),

    chatOpen: publicProcedure
      .input(supportChatOpenInputSchema)
      .output(supportChatOpenResultSchema)
      .mutation(({ ctx, input }) => run((c) => c.open(accountOf(ctx.principal), input))),

    chatSend: publicProcedure
      .input(supportChatSendInputSchema)
      .output(supportChatMessageSchema)
      .mutation(({ ctx, input }) => run((c) => c.send({ userId: accountOf(ctx.principal), accessToken: input.accessToken }, input))),

    chatPoll: publicProcedure
      .input(supportChatPollInputSchema)
      .output(supportChatPollSchema)
      .mutation(({ ctx, input }) => run((c) => c.poll({ userId: accountOf(ctx.principal), accessToken: input.accessToken }, input))),

    chatClose: publicProcedure
      .input(supportChatSessionInputSchema)
      .output(supportChatSessionSchema)
      .mutation(({ ctx, input }) =>
        run((c) => c.close({ userId: accountOf(ctx.principal), accessToken: input.accessToken }, input.sessionId)),
      ),

    chatContinueByEmail: publicProcedure
      .input(supportChatSessionInputSchema)
      .output(supportChatEmailResultSchema)
      .mutation(({ ctx, input }) =>
        run((c) => c.continueByEmail({ userId: accountOf(ctx.principal), accessToken: input.accessToken }, input.sessionId)),
      ),

    // The desk ---------------------------------------------------------------------------------------------------

    chatInbox: scopedProcedure('support:ops')
      .input(supportChatInboxInputSchema)
      .output(z.array(supportChatDeskSessionSchema))
      .query(({ ctx, input }) =>
        run(async (c) => {
          requireSupportOps(ctx.principal!);
          return c.inbox(input.limit);
        }),
      ),

    chatAccept: scopedProcedure('support:ops')
      .input(supportChatAcceptInputSchema)
      .output(supportChatDeskSessionSchema)
      .mutation(({ ctx, input }) =>
        run(async (c) => {
          requireSupportOps(ctx.principal!);
          return c.accept(ctx.principal!.userId, input.sessionId);
        }),
      ),

    chatReply: scopedProcedure('support:ops')
      .input(supportChatReplyInputSchema)
      .output(supportChatMessageSchema)
      .mutation(({ ctx, input }) =>
        run(async (c) => {
          requireSupportOps(ctx.principal!);
          return c.reply(ctx.principal!.userId, input);
        }),
      ),

    chatDeskPoll: scopedProcedure('support:ops')
      .input(supportChatDeskPollInputSchema)
      .output(supportChatDeskPollSchema)
      .query(({ ctx, input }) =>
        run(async (c) => {
          requireSupportOps(ctx.principal!);
          return c.deskPoll(input);
        }),
      ),

    chatDeskClose: scopedProcedure('support:ops')
      .input(supportChatAcceptInputSchema)
      .output(supportChatDeskSessionSchema)
      .mutation(({ ctx, input }) =>
        run(async (c) => {
          requireSupportOps(ctx.principal!);
          return c.deskClose(ctx.principal!.userId, input.sessionId);
        }),
      ),

    chatEnquiries: scopedProcedure('support:ops')
      .input(supportChatEnquiriesInputSchema)
      .output(z.array(supportChatEnquirySchema))
      .query(({ ctx, input }) =>
        run(async (c) => {
          requireSupportOps(ctx.principal!);
          return c.enquiries(input.sessionId, input.limit);
        }),
      ),

    /** Where a request came from: the chat, its transcript and the profile type identity answered. Null for any other. */
    requestSource: scopedProcedure('support:ops')
      .input(supportRequestSourceInputSchema)
      .output(supportRequestSourceSchema.nullable())
      .query(({ ctx, input }) =>
        run(async (c) => {
          requireSupportOps(ctx.principal!);
          return c.requestSource(input.ticketId);
        }),
      ),
  };
}
