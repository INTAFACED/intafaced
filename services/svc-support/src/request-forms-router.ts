import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  scopedProcedure,
  supportFieldDefineInputSchema,
  supportFieldSchema,
  supportFormDefineInputSchema,
  supportFormSchema,
  supportRequestFormsSchema,
  supportTicketFieldValuesSchema,
} from '@intafaced/contracts';
import { requireLead } from './help-centre-router.js';
import { RequestFormError, type RequestForms } from './request-forms.js';
import { requireSupportOps, type SupportService } from './support-service.js';
import { userCopy } from './user-copy.js';

/**
 * Request forms per type (SP-tickets-03). `requestForms` is what a signed-in person reads to draw the request form.
 * `requestFormsAll`, `defineRequestField` and `defineRequestForm` are the desk's: a support lead writes, as for the help
 * centre settings, until the settings scope `support:admin` exists. `ticketFieldValues` reads a request's answers with
 * the same owner-or-operator rule as `get`.
 */
export function requestFormProcedures(forms: RequestForms, support: Pick<SupportService, 'listStaff' | 'getTicket'>) {
  return {
    requestForms: scopedProcedure('support:read')
      .output(supportRequestFormsSchema)
      .query(() => forms.catalogue()),

    requestFormsAll: scopedProcedure('support:ops')
      .output(supportRequestFormsSchema)
      .query(({ ctx }) => {
        requireSupportOps(ctx.principal!);
        return forms.all();
      }),

    defineRequestField: scopedProcedure('support:ops')
      .input(supportFieldDefineInputSchema)
      .output(supportFieldSchema)
      .mutation(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        await requireLead(support, ctx.principal!.userId);
        try {
          return await forms.defineField(input, ctx.principal!.userId);
        } catch (err) {
          throw mapRequestForm(err);
        }
      }),

    defineRequestForm: scopedProcedure('support:ops')
      .input(supportFormDefineInputSchema)
      .output(supportFormSchema)
      .mutation(async ({ ctx, input }) => {
        requireSupportOps(ctx.principal!);
        await requireLead(support, ctx.principal!.userId);
        try {
          return await forms.defineForm(input, ctx.principal!.userId);
        } catch (err) {
          throw mapRequestForm(err);
        }
      }),

    ticketFieldValues: scopedProcedure('support:read')
      .input(z.object({ ticketId: z.string().guid() }))
      .output(supportTicketFieldValuesSchema.nullable())
      .query(async ({ ctx, input }) => {
        // Visible exactly when the request is: someone else's request reads as not found.
        try {
          await support.getTicket({
            userId: ctx.principal!.userId,
            ticketId: input.ticketId,
            asOperator: ctx.principal!.scopes.includes('support:ops'),
          });
        } catch (err) {
          if ((err as { code?: unknown }).code === 'support.not_found')
            throw new TRPCError({ code: 'NOT_FOUND', message: userCopy('support.not_found'), cause: err });
          throw err;
        }
        return forms.values(input.ticketId);
      }),
  };
}

const HTTP: Record<string, TRPCError['code']> = {
  'support.form_cap_unset': 'PRECONDITION_FAILED',
  'support.field_cap_unset': 'PRECONDITION_FAILED',
  'support.form_cap_reached': 'PRECONDITION_FAILED',
  'support.field_cap_reached': 'PRECONDITION_FAILED',
  'support.form_revision_stale': 'CONFLICT',
  'support.form_unknown': 'BAD_REQUEST',
  'support.field_unknown': 'BAD_REQUEST',
  'support.field_value_invalid': 'BAD_REQUEST',
  'support.field_kind_unsupported': 'BAD_REQUEST',
  'support.form_definition_invalid': 'BAD_REQUEST',
};

/** A form refusal keeps its own code on the wire (`data.cause.code`), so the customer can name it. */
export function mapRequestForm(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof RequestFormError)
    return new TRPCError({ code: HTTP[err.code] ?? 'BAD_REQUEST', message: userCopy(err.code), cause: err });
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'request forms failed', cause: err });
}
