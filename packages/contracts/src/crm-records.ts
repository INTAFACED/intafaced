import { z } from 'zod';

/**
 * CRM custom field definitions, relation definitions, record page layout and global search (OPS-crm-01, first contracts
 * PR), owned by svc-ops. Record write/read envelopes, relation instances and custom field values are the next contracts PR.
 *
 * Extends the enquiry CRM with record types. Contacts hold personal data: field access follows staff roles and every
 * export is audited by the service. Writes are idempotent on a client business key and carry a revision token (the
 * existing CRM pattern), never a clock. Contracts only; the svc-ops migration and router come in their own PRs.
 */

export const OPS_CRM_FIELD_UNIQUE_VIOLATION = 'ops.crm.field_unique_violation' as const;
export const OPS_CRM_FIELD_TYPE_UNSUPPORTED = 'ops.crm.field_type_unsupported' as const;
export const OPS_CRM_RELATION_INVALID = 'ops.crm.relation_invalid' as const;
export const OPS_CRM_SEARCH_TERM_TOO_SHORT = 'ops.crm.search_term_too_short' as const;
export type OpsCrmRecordRefusal =
  | typeof OPS_CRM_FIELD_UNIQUE_VIOLATION
  | typeof OPS_CRM_FIELD_TYPE_UNSUPPORTED
  | typeof OPS_CRM_RELATION_INVALID
  | typeof OPS_CRM_SEARCH_TERM_TOO_SHORT;

export const CRM_RECORD_TYPES = ['contact', 'company', 'deal', 'note', 'task'] as const;
export const crmRecordTypeSchema = z.enum(CRM_RECORD_TYPES);
export type CrmRecordType = z.infer<typeof crmRecordTypeSchema>;

/** Search also covers the existing enquiries. */
export const CRM_SEARCHABLE_TYPES = [...CRM_RECORD_TYPES, 'enquiry'] as const;
export const crmSearchableTypeSchema = z.enum(CRM_SEARCHABLE_TYPES);
export type CrmSearchableType = z.infer<typeof crmSearchableTypeSchema>;

const businessKey = z.string().min(1).max(256);
const revision = z.string().min(1).max(128);
const id = z.string().uuid();
const decimal = z.string().regex(/^(0|[1-9]\d{0,29})(\.\d{1,18})?$/, 'amounts are decimal strings');
/** Custom number fields are not money: they may be negative. Still a decimal string, never a JS number. */
const signedDecimal = z.string().regex(/^-?(0|[1-9]\d{0,29})(\.\d{1,18})?$/, 'numbers are decimal strings');

// ── Custom fields ────────────────────────────────────────────────────────────

export const CRM_FIELD_TYPES = ['text', 'number', 'boolean', 'date', 'select', 'multi_select', 'email', 'url'] as const;
export const crmFieldTypeSchema = z.enum(CRM_FIELD_TYPES);
export type CrmFieldType = z.infer<typeof crmFieldTypeSchema>;

const apiName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'API names are lower-case snake case');

export const crmSelectOptionSchema = z.object({ label: z.string().trim().min(1).max(80), apiValue: apiName }).strict();

/**
 * A custom field definition. `required` is not supported for custom fields (spec), so it is not in the shape. A
 * deactivated field keeps its data and is hidden; re-activating restores it.
 */
export const crmFieldDefinitionInputSchema = z
  .object({
    recordType: crmRecordTypeSchema,
    apiName,
    label: z.string().trim().min(1).max(80),
    type: z.string().min(1).max(32),
    options: z.array(crmSelectOptionSchema).max(200).optional(),
    defaultValue: z.union([z.string().max(2000), z.boolean(), z.array(apiName).max(200)]).nullable(),
    unique: z.boolean(),
    businessKey,
  })
  .strict();
export type CrmFieldDefinitionInput = z.infer<typeof crmFieldDefinitionInputSchema>;

export type CrmFieldCheck = { ok: true } | { ok: false; code: OpsCrmRecordRefusal | 'invalid'; message: string };

/** Validates the type and its options and default. Number defaults are decimal strings, never JS numbers. */
export function checkCrmFieldDefinition(def: CrmFieldDefinitionInput): CrmFieldCheck {
  const type = crmFieldTypeSchema.safeParse(def.type);
  if (!type.success) return { ok: false, code: OPS_CRM_FIELD_TYPE_UNSUPPORTED, message: `type ${def.type} is not supported` };
  const isSelect = type.data === 'select' || type.data === 'multi_select';
  const options = def.options ?? [];
  if (isSelect && options.length === 0) return { ok: false, code: 'invalid', message: 'a select field needs options' };
  if (!isSelect && def.options !== undefined) return { ok: false, code: 'invalid', message: 'only select fields have options' };
  if (new Set(options.map((o) => o.apiValue)).size !== options.length) {
    return { ok: false, code: 'invalid', message: 'option API values must be unique' };
  }
  if (type.data === 'multi_select' && def.unique) return { ok: false, code: 'invalid', message: 'a multi-select cannot be unique' };
  const d = def.defaultValue;
  if (d === null) return { ok: true };
  const values = new Set(options.map((o) => o.apiValue));
  const bad = (m: string): CrmFieldCheck => ({ ok: false, code: 'invalid', message: m });
  switch (type.data) {
    case 'boolean':
      return typeof d === 'boolean' ? { ok: true } : bad('boolean default must be true or false');
    case 'number':
      return typeof d === 'string' && signedDecimal.safeParse(d).success ? { ok: true } : bad('number default must be a decimal string');
    case 'select':
      return typeof d === 'string' && values.has(d) ? { ok: true } : bad('default must be one of the options');
    case 'multi_select':
      return Array.isArray(d) && d.every((v) => values.has(v)) ? { ok: true } : bad('defaults must be options');
    case 'date':
      return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? { ok: true } : bad('date default must be YYYY-MM-DD');
    case 'email':
      return typeof d === 'string' && z.string().email().safeParse(d).success ? { ok: true } : bad('default must be an email address');
    case 'url':
      return typeof d === 'string' && z.string().url().safeParse(d).success ? { ok: true } : bad('default must be a URL');
    default:
      return typeof d === 'string' ? { ok: true } : bad('default must be text');
  }
}

export const crmFieldSetActiveInputSchema = z
  .object({ fieldId: id, active: z.boolean(), expectedRevision: revision, businessKey })
  .strict();

// ── Relations ────────────────────────────────────────────────────────────────

/** Many-to-many and multi-object relations are not built (spec). */
export const CRM_RELATION_KINDS = ['one_to_many', 'many_to_one'] as const;
export const crmRelationKindSchema = z.enum(CRM_RELATION_KINDS);

export const crmRelationDefinitionInputSchema = z
  .object({
    kind: z.string().min(1).max(32),
    fromType: crmRecordTypeSchema,
    toType: crmRecordTypeSchema,
    /** Named on both sides. */
    fromLabel: z.string().trim().min(1).max(80),
    toLabel: z.string().trim().min(1).max(80),
    businessKey,
  })
  .strict();
export type CrmRelationDefinitionInput = z.infer<typeof crmRelationDefinitionInputSchema>;

export function checkCrmRelationDefinition(def: CrmRelationDefinitionInput): CrmFieldCheck {
  if (!crmRelationKindSchema.safeParse(def.kind).success) {
    return { ok: false, code: OPS_CRM_RELATION_INVALID, message: `relation kind ${def.kind} is not built` };
  }
  if (def.fromLabel.toLowerCase() === def.toLabel.toLowerCase() && def.fromType === def.toType) {
    return { ok: false, code: OPS_CRM_RELATION_INVALID, message: 'a self relation needs two different side names' };
  }
  return { ok: true };
}

// ── Records ──────────────────────────────────────────────────────────────────

export const crmDealSchema = z
  .object({
    stage: z.string().trim().min(1).max(64),
    /** Decimal string with its currency; null when not known. Never a JS number. */
    size: z.object({ amount: decimal, currency: z.string().regex(/^[A-Z]{3}$/) }).nullable(),
    companyId: id.nullable(),
    expectedClose: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
  })
  .strict();

export const crmRecordTaskSchema = z
  .object({
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    assigneeId: z.string().min(1).max(128).nullable(),
    status: z.enum(['open', 'done']),
  })
  .strict();

// ── Layout ───────────────────────────────────────────────────────────────────

export const CRM_WIDGET_KINDS = ['fields', 'related_records', 'emails', 'calendar', 'timeline', 'tasks', 'notes', 'files'] as const;

export const crmLayoutTabSchema = z
  .object({
    key: apiName,
    title: z.string().trim().min(1).max(60),
    widgets: z.array(z.enum(CRM_WIDGET_KINDS)).min(1).max(CRM_WIDGET_KINDS.length),
    readOnly: z.boolean(),
  })
  .strict();

/** A founder's own layout preference for one record type; it persists for that founder only. */
export const crmLayoutSaveInputSchema = z
  .object({
    recordType: crmRecordTypeSchema,
    mode: z.enum(['tabs', 'single_page']),
    tabs: z
      .array(crmLayoutTabSchema)
      .min(1)
      .max(20)
      .refine((t) => new Set(t.map((x) => x.key)).size === t.length, 'tab keys must be unique'),
    expectedRevision: revision.nullable(),
    businessKey,
  })
  .strict();

// ── Search ───────────────────────────────────────────────────────────────────

/**
 * A blank term is too short. No longer minimum is invented here: a longer one is an owner setting the service may add.
 */
export const CRM_SEARCH_MIN_TERM = 1;

export const crmSearchInputSchema = z
  .object({
    term: z.string().max(200),
    types: z.array(crmSearchableTypeSchema).min(1).max(CRM_SEARCHABLE_TYPES.length).optional(),
    cursor: z.string().min(1).max(512).nullable().optional(),
  })
  .strict();
export type CrmSearchInput = z.infer<typeof crmSearchInputSchema>;

export function checkCrmSearchTerm(term: string): CrmFieldCheck {
  return term.trim().length < CRM_SEARCH_MIN_TERM
    ? { ok: false, code: OPS_CRM_SEARCH_TERM_TOO_SHORT, message: `search needs at least ${CRM_SEARCH_MIN_TERM} characters` }
    : { ok: true };
}

export const crmSearchHitSchema = z
  .object({ type: crmSearchableTypeSchema, recordId: id, title: z.string().max(200), subtitle: z.string().max(200).nullable() })
  .strict();

/** `total` and `nextCursor` come from the service (which owns their consistency), never computed in the browser. */
export const crmSearchOutputSchema = z
  .object({ hits: z.array(crmSearchHitSchema).max(200), total: z.number().int().min(0), nextCursor: z.string().nullable() })
  .strict();
