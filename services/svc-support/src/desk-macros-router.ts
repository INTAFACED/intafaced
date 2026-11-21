import { TRPCError } from '@trpc/server';
import { scopedProcedure, supportMacroSaveInputSchema, supportMacroSchema } from '@intafaced/contracts';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import {
  SUPPORT_DESK_MACRO_APPLY,
  SUPPORT_DESK_MACROS,
  SUPPORT_DESK_SIGNATURE,
  SUPPORT_DESK_SIGNATURE_SET,
} from '@intafaced/contracts/support-desk-procedures';
import { MacroError, type DeskMacros } from './desk-macros.js';
import { requireSupportOps } from './support-service.js';
import { mapError } from './router.js';
import { supportRefusal } from './record-refusal.js';
import { userCopy } from './user-copy.js';

/**
 * Macros and signatures (SP-desk-02). Every procedure is the desk's (`support:ops`). `macros` and `macroApply` are any
 * agent's; `macroSave` is a lead's. `signature` and `signatureSet` read and write the caller's own signature only.
 */
export function macroProcedures(macros: DeskMacros) {
  return {
    macros: mountRecord(
      SUPPORT_DESK_MACROS,
      async ({ ctx }) => {
        requireSupportOps(ctx.principal);
        return { macros: await macros.list() };
      },
      supportRefusal,
    ),

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
    macroApply: mountRecord(
      SUPPORT_DESK_MACRO_APPLY,
      async ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        try {
          return await macros.apply(ctx.principal.userId, input);
        } catch (err) {
          throw macroRefusal(err);
        }
      },
      supportRefusal,
    ),

    signature: mountRecord(
      SUPPORT_DESK_SIGNATURE,
      ({ ctx }) => {
        requireSupportOps(ctx.principal);
        return macros.signature(ctx.principal.userId);
      },
      supportRefusal,
    ),

    signatureSet: mountRecord(
      SUPPORT_DESK_SIGNATURE_SET,
      async ({ ctx, input }) => {
        requireSupportOps(ctx.principal);
        try {
          return await macros.setSignature(ctx.principal.userId, input);
        } catch (err) {
          throw macroRefusal(err);
        }
      },
      supportRefusal,
    ),
  };
}

const HTTP: Record<string, TRPCError['code']> = {
  'support.not_lead': 'FORBIDDEN',
  'support.macro_not_found': 'NOT_FOUND',
  'support.macro_revision_stale': 'CONFLICT',
  'support.shortcode_taken': 'CONFLICT',
  'support.shortcode_rule_unset': 'PRECONDITION_FAILED',
  'support.shortcode_too_short': 'BAD_REQUEST',
  'support.macro_placeholder_unknown': 'BAD_REQUEST',
  'support.macro_placeholder_blank': 'BAD_REQUEST',
};

/** A macro refusal in its wire form: its own code in the message and the cause, as the desk's other refusals are. Anything else is left as it is. */
function macroRefusal(err: unknown): unknown {
  return err instanceof MacroError
    ? new TRPCError({ code: HTTP[err.code] ?? 'BAD_REQUEST', message: userCopy(err.code), cause: err })
    : err;
}

/** For a door not mounted from a record: a macro refusal as above, every other refusal as the desk's are. */
function mapMacro(err: unknown): never {
  const refusal = macroRefusal(err);
  if (refusal !== err) throw refusal;
  return mapError(err);
}
