import { QUANT_TEMPLATE_LIST_LIMIT_UNSET, QUANT_TEMPLATE_NOT_FOUND, QuantError } from '../errors.js';
import { STUDIO_LIST_LIMIT_CAP } from '../studio/list-limit.js';
import {
  publicJurisdictionProcedure,
  quantTemplateDetailSchema,
  quantTemplateIdSchema,
  quantTemplateListOutputSchema,
  router,
} from '@intafaced/contracts';
import { templateSource } from '../studio/modules.js';
import { z } from 'zod';
import { toTrpc, accountField, type QuantCore } from './core.js';

export function templateRoutes(core: QuantCore) {
  const { templates, accountOf } = core;
  return router({
    list: publicJurisdictionProcedure('quant', 'fiat')
      .input(
        z
          .object({
            limit: z.number().int().min(1).max(STUDIO_LIST_LIMIT_CAP).optional(),
            cursor: quantTemplateIdSchema.optional().nullable(),
            ...accountField,
          })
          .optional(),
      )
      .output(quantTemplateListOutputSchema)
      .query(async ({ input, ctx }) => {
        try {
          accountOf(ctx, input?.accountId);
          if (input?.limit === undefined)
            throw new QuantError(QUANT_TEMPLATE_LIST_LIMIT_UNSET, 'pass limit; a page size is never invented');
          const page = await templates.list({ limit: input.limit, cursor: input.cursor ?? null });
          return { templates: page.templates.map((row) => ({ ...row })), nextCursor: page.nextCursor };
        } catch (err) {
          toTrpc(err);
        }
      }),

    get: publicJurisdictionProcedure('quant', 'fiat')
      .input(z.object({ id: quantTemplateIdSchema, ...accountField }))
      .output(quantTemplateDetailSchema)
      .query(async ({ input, ctx }) => {
        try {
          accountOf(ctx, input.accountId);
          const versions = await templates.get(input.id);
          if (!versions) throw new QuantError(QUANT_TEMPLATE_NOT_FOUND, 'template not found');
          return { id: input.id, versions: versions.map((row) => ({ ...row, source: templateSource(row.rules) })) };
        } catch (err) {
          toTrpc(err);
        }
      }),
  });
}
