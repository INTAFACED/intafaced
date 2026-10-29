import { TRPCError } from '@trpc/server';
import {
  scopedProcedure,
  supportMacroAppliedSchema,
  supportMacroApplyInputSchema,
  supportMacroListSchema,
  supportMacroSaveInputSchema,
  supportMacroSchema,
  supportSignatureSchema,
  supportSignatureSetInputSchema,
} from '@intafaced/contracts';
import { MacroError, type DeskMacros } from './desk-macros.js';
import { requireSupportOps } from './support-service.js';
import { mapError } from './router.js';
import { userCopy } from './user-copy.js';

/**
 * Macros and signatures (SP-desk-02). Every procedure is the desk's (`support:ops`). `macros` and `macroApply` are any
 * agent's; `macroSave` is a lead's. `signature` and `signatureSet` read and write the caller's own signature only.
 */
export function macroProcedures(macros: DeskMacros) {
  return {
    macros: scopedProcedure('support:ops')
      .output(supportMacroListSchema)
      .query(async ({ ctx }) => {
        requireSupportOps(ctx.principal!);
        return { macros: await macros.list() };
      }),

    macroSave: scopedProcedure('support:ops')
      .input(supportMacroSaveInputSchema)
      .output(supportMacroSchema)
      .mutation(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        try {
          return await macros.save(ctx.principal!.userId, input);
        } catch (err) {
          mapMacro(err);
        }
      }),

    /** The macro filled from this request. Writes nothing; the agent sends the reply themselves. */
    macroApply: scopedProcedure('support:ops')
      .input(supportMacroApplyInputSchema)
      .output(supportMacroAppliedSchema)
      .query(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        try {
          return await macros.apply(ctx.principal!.userId, input);
        } catch (err) {
          mapMacro(err);
        }
      }),

    signature: scopedProcedure('support:ops')
      .output(supportSignatureSchema)
      .query(async ({ ctx }) => {
        requireSupportOps(ctx.principal!);
        return macros.signature(ctx.principal!.userId);
      }),

    signatureSet: scopedProcedure('support:ops')
      .input(supportSignatureSetInputSchema)
      .output(supportSignatureSchema)
      .mutation(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        try {
          return await macros.setSignature(ctx.principal!.userId, input);
        } catch (err) {
          mapMacro(err);
        }
      }),
  };
}

const HTTP: Record<string, TRPCError['code']> = {
  'support.not_lead': 'FORBIDDEN',
  'support.macro_not_found': 'NOT_FOUND',
  'support.macro_revision_stale': 'CONFLICT',
  'support.macro_name_taken': 'CONFLICT',
  'support.macro_placeholder_unknown': 'BAD_REQUEST',
};

/** A macro refusal keeps its own code in the message, as the desk's other refusals do; every other refusal maps as the desk's do. */
function mapMacro(err: unknown): never {
  if (err instanceof MacroError) throw new TRPCError({ code: HTTP[err.code] ?? 'BAD_REQUEST', message: userCopy(err.code), cause: err });
  return mapError(err);
}
