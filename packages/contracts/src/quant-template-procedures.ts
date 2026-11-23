import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { quantTemplateDetailSchema, quantTemplateIdSchema, quantTemplateListOutputSchema } from './quant-algo.js';
import { quantAccountField } from './quant-wire.js';
import { QUANT_STUDIO_LIST_LIMIT_CAP } from './quant-studio-procedures.js';

/**
 * svc-quant's first-party starter templates (AL-editor-03), one record per call: a page of them (`template.list`) and one
 * with every published version (`template.get`). Their numbers are blank; none moves value. svc-quant mounts each from
 * here (`routes/template.ts`); the customer app calls each by its record.
 */

/** Served wherever quant's fiat plane is, with or without a principal; the handler resolves the account itself. */
const ACCESS = { caller: 'jurisdiction', module: 'quant', plane: 'fiat' } as const;
const base = { service: 'svc-quant', module: 'quant', transport: 'trpc', access: ACCESS } as const;

/** No database wired: every read of the template store refuses by name (`templates/open.ts`). */
const NO_DATABASE = {
  'quant.database_url_unset': 'PRECONDITION_FAILED',
  'quant.database_pool_max_unset': 'PRECONDITION_FAILED',
} as const;

/** A page of templates. `limit` is optional so omit reaches `quant.template_list_limit_unset`: a page size is never invented. */
export const QUANT_TEMPLATE_LIST = defineProcedure({
  ...base,
  name: 'quant.template.list',
  kind: 'query',
  path: 'template.list',
  refusals: { ...NO_DATABASE, 'quant.template_list_limit_unset': 'PRECONDITION_FAILED', 'quant.params_invalid': 'BAD_REQUEST' },
  input: z
    .object({
      limit: z.number().int().min(1).max(QUANT_STUDIO_LIST_LIMIT_CAP).optional(),
      cursor: quantTemplateIdSchema.optional().nullable(),
      ...quantAccountField,
    })
    .optional(),
  output: quantTemplateListOutputSchema,
  samples: [
    { verdict: 'accept', input: { limit: 20 } },
    { verdict: 'accept', input: { limit: 20, cursor: 'ma-cross' } },
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: { limit: 0 } },
    { verdict: 'refuse', input: { limit: 20, cursor: 'Not An Id' } },
  ],
});

/** One template with every published version and the source each generates. */
export const QUANT_TEMPLATE_GET = defineProcedure({
  ...base,
  name: 'quant.template.get',
  kind: 'query',
  path: 'template.get',
  refusals: { ...NO_DATABASE, 'quant.template_not_found': 'NOT_FOUND', 'quant.params_invalid': 'BAD_REQUEST' },
  input: z.object({ id: quantTemplateIdSchema, ...quantAccountField }),
  output: quantTemplateDetailSchema,
  samples: [
    { verdict: 'accept', input: { id: 'ma-cross' } },
    { verdict: 'refuse', input: { id: '' } },
  ],
});

export const QUANT_TEMPLATE_PROCEDURES = [QUANT_TEMPLATE_LIST, QUANT_TEMPLATE_GET] as const;
