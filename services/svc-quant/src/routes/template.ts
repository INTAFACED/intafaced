import { QUANT_TEMPLATE_LIST_LIMIT_UNSET, QUANT_TEMPLATE_NOT_FOUND, QuantError } from '../errors.js';
import { router } from '@intafaced/contracts';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { QUANT_TEMPLATE_GET, QUANT_TEMPLATE_LIST } from '@intafaced/contracts/quant-template-procedures';
import { templateSource } from '../studio/modules.js';
import { quantRefusal, toTrpc, type QuantCore } from './core.js';

/** `list` and `get` are mounted from their records (`@intafaced/contracts/quant-template-procedures`). */

export function templateRoutes(core: QuantCore) {
  const { templates, accountOf } = core;
  return router({
    list: mountRecord(
      QUANT_TEMPLATE_LIST,
      async ({ input, ctx }) => {
        try {
          accountOf(ctx, input?.accountId);
          if (input?.limit === undefined)
            throw new QuantError(QUANT_TEMPLATE_LIST_LIMIT_UNSET, 'pass limit; a page size is never invented');
          const page = await templates.list({ limit: input.limit, cursor: input.cursor ?? null });
          return { templates: page.templates.map((row) => ({ ...row })), nextCursor: page.nextCursor };
        } catch (err) {
          toTrpc(err);
        }
      },
      quantRefusal,
    ),

    get: mountRecord(
      QUANT_TEMPLATE_GET,
      async ({ input, ctx }) => {
        try {
          accountOf(ctx, input.accountId);
          const versions = await templates.get(input.id);
          if (!versions) throw new QuantError(QUANT_TEMPLATE_NOT_FOUND, 'template not found');
          return { id: input.id, versions: versions.map((row) => ({ ...row, source: templateSource(row.rules) })) };
        } catch (err) {
          toTrpc(err);
        }
      },
      quantRefusal,
    ),
  });
}
