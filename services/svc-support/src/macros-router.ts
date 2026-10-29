import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { scopedProcedure } from '@intafaced/contracts';
import {
  MACRO_BODY_MAX,
  MACRO_NOT_FOUND,
  MACRO_PLACEHOLDERS,
  MACRO_TITLE_MAX,
  MacroError,
  SHORTCODE_MAX,
  SHORTCODE_RULE_UNSET,
  SHORTCODE_TAKEN,
  SIGNATURE_MAX,
  checkMacro,
  checkSignature,
  fillPlaceholders,
  type HandleSource,
  type Macro,
  type MacroBook,
} from './desk-macros.js';
import { requireSupportOps, type SupportService } from './support-service.js';
import { userCopy } from './user-copy.js';

/**
 * SP-desk-02 — macros and signatures, for staff on a `support:ops` session.
 *
 * `macrosList` and `macrosSave` keep the library; only a lead shares a macro with the desk. `macrosApply` fills one
 * macro's placeholders for one request the caller may see and returns the draft: nothing is sent, and the use is
 * recorded once per (request, macro, client request id). `staffSignature` and `staffSetSignature` are the caller's own.
 */

const macroSchema = z.object({
  id: z.string().guid(),
  ownerId: z.string(),
  shared: z.boolean(),
  title: z.string(),
  shortcode: z.string(),
  body: z.string(),
  placeholders: z.array(z.enum(MACRO_PLACEHOLDERS)),
  updatedAt: z.string(),
});

/** The wire copy of a macro: arrays the output schema can own. */
const wire = (m: Macro) => ({ ...m, placeholders: [...m.placeholders] });

function macroError(err: unknown): never {
  if (err instanceof MacroError) {
    const message = err.missingKey ? `${userCopy(err.code)} ${err.missingKey}` : userCopy(err.code);
    if (err.code === MACRO_NOT_FOUND) throw new TRPCError({ code: 'NOT_FOUND', message });
    if (err.code === SHORTCODE_TAKEN) throw new TRPCError({ code: 'CONFLICT', message });
    if (err.code === SHORTCODE_RULE_UNSET) throw new TRPCError({ code: 'PRECONDITION_FAILED', message });
    throw new TRPCError({ code: 'BAD_REQUEST', message });
  }
  throw err;
}

export function macroProcedures(
  book: MacroBook,
  handles: HandleSource,
  support: Pick<SupportService, 'listStaff' | 'getTicket'>,
  shortcodeMin: number | null,
  mapError: (err: unknown) => never,
) {
  async function staffRole(userId: string): Promise<'agent' | 'lead'> {
    const me = (await support.listStaff()).find((member) => member.userId.toLowerCase() === userId.toLowerCase());
    if (!me) throw new TRPCError({ code: 'FORBIDDEN', message: userCopy('support.not_staff') });
    return me.role;
  }

  return {
    macrosList: scopedProcedure('support:ops')
      .output(z.object({ macros: z.array(macroSchema), shortcodeMin: z.number().int().nullable() }))
      .query(async ({ ctx }) => {
        requireSupportOps(ctx.principal!);
        await staffRole(ctx.principal!.userId);
        return { macros: (await book.listVisible(ctx.principal!.userId)).map(wire), shortcodeMin };
      }),

    macrosSave: scopedProcedure('support:ops')
      .input(
        z.object({
          title: z.string().max(MACRO_TITLE_MAX),
          shortcode: z.string().max(SHORTCODE_MAX),
          body: z.string().max(MACRO_BODY_MAX),
          shared: z.boolean(),
        }),
      )
      .output(macroSchema)
      .mutation(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        const role = await staffRole(ctx.principal!.userId);
        if (input.shared && role !== 'lead') throw new TRPCError({ code: 'FORBIDDEN', message: userCopy('support.not_lead') });
        try {
          const save = checkMacro({ ...input, ownerId: ctx.principal!.userId, at: new Date().toISOString() }, shortcodeMin);
          return wire(await book.create(save));
        } catch (err) {
          macroError(err);
        }
      }),

    macrosApply: scopedProcedure('support:ops')
      .input(z.object({ ticketId: z.string().guid(), macroId: z.string().guid(), clientRequestId: z.string().min(8).max(200) }))
      .output(z.object({ macroId: z.string().guid(), ticketId: z.string().guid(), draft: z.string() }))
      .mutation(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        const operatorId = ctx.principal!.userId;
        await staffRole(operatorId);
        let ticket;
        try {
          ticket = await support.getTicket({ userId: operatorId, ticketId: input.ticketId, asOperator: true });
        } catch (err) {
          mapError(err);
        }
        try {
          const macro = await book.get(input.macroId);
          if (!macro || !(macro.shared || macro.ownerId.toLowerCase() === operatorId.toLowerCase())) throw new MacroError(MACRO_NOT_FOUND);
          const [requester, agent] = await Promise.all([
            macro.placeholders.includes('requester.name') ? handles.handleOf(ticket.userId) : null,
            macro.placeholders.includes('agent.name') ? handles.handleOf(operatorId) : null,
          ]);
          const draft = fillPlaceholders(macro.body, { 'requester.name': requester, 'ticket.id': ticket.id, 'agent.name': agent });
          await book.recordUse({
            macroId: macro.id,
            ticketId: ticket.id,
            by: operatorId,
            clientRequestId: input.clientRequestId,
            at: new Date().toISOString(),
          });
          return { macroId: macro.id, ticketId: ticket.id, draft };
        } catch (err) {
          macroError(err);
        }
      }),

    staffSignature: scopedProcedure('support:ops')
      .output(z.object({ signature: z.string().nullable() }))
      .query(async ({ ctx }) => {
        requireSupportOps(ctx.principal!);
        await staffRole(ctx.principal!.userId);
        return { signature: await book.signatureOf(ctx.principal!.userId) };
      }),

    staffSetSignature: scopedProcedure('support:ops')
      .input(
        z.object({
          signature: z
            .string()
            .max(SIGNATURE_MAX * 2)
            .nullable(),
        }),
      )
      .output(z.object({ signature: z.string().nullable() }))
      .mutation(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        await staffRole(ctx.principal!.userId);
        try {
          const signature = checkSignature(input.signature);
          return { signature: await book.setSignature({ userId: ctx.principal!.userId, signature, at: new Date().toISOString() }) };
        } catch (err) {
          macroError(err);
        }
      }),
  };
}
