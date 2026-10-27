/**
 * Request forms per type and ticket fields (SP-tickets-03).
 *
 * Browser safe: nothing here imports Node. A field is one question a request can carry: text, a choice, a checkbox, a
 * date, or a decimal number that is explicitly not money (no currency, never a balance). A choice field may depend on a
 * parent choice: the parent's value names which of its options are allowed. A form is the ordered list of fields for one
 * request type; a field in a form can be shown only when another field holds one value, and then it may be required.
 *
 * There is no field kind for money, an account or an identity copy: the support desk holds no other module's data. How
 * many forms and fields the desk keeps is an owner value with no default (`support.form_cap_unset`,
 * `support.field_cap_unset`). `supportFormValuesProblem` is the one rule the service and the customer form both apply.
 */
import { z } from 'zod';

export const SUPPORT_FORM_CAP_UNSET = 'support.form_cap_unset';
export const SUPPORT_FIELD_CAP_UNSET = 'support.field_cap_unset';
export const SUPPORT_FORM_CAP_REACHED = 'support.form_cap_reached';
export const SUPPORT_FIELD_CAP_REACHED = 'support.field_cap_reached';
export const SUPPORT_FIELD_VALUE_INVALID = 'support.field_value_invalid';
export const SUPPORT_FORM_UNKNOWN = 'support.form_unknown';
export const SUPPORT_FIELD_UNKNOWN = 'support.field_unknown';
export const SUPPORT_FIELD_KIND_UNSUPPORTED = 'support.field_kind_unsupported';
export const SUPPORT_FORM_DEFINITION_INVALID = 'support.form_definition_invalid';
export const SUPPORT_FORM_REVISION_STALE = 'support.form_revision_stale';

export const SUPPORT_FORM_ERROR_CODES = [
  SUPPORT_FORM_CAP_UNSET,
  SUPPORT_FIELD_CAP_UNSET,
  SUPPORT_FORM_CAP_REACHED,
  SUPPORT_FIELD_CAP_REACHED,
  SUPPORT_FIELD_VALUE_INVALID,
  SUPPORT_FORM_UNKNOWN,
  SUPPORT_FIELD_UNKNOWN,
  SUPPORT_FIELD_KIND_UNSUPPORTED,
  SUPPORT_FORM_DEFINITION_INVALID,
  SUPPORT_FORM_REVISION_STALE,
] as const;
export type SupportFormErrorCode = (typeof SUPPORT_FORM_ERROR_CODES)[number];

export const SUPPORT_FIELD_KINDS = ['text', 'choice', 'checkbox', 'date', 'decimal'] as const;
export type SupportFieldKind = (typeof SUPPORT_FIELD_KINDS)[number];

/** Wire bounds on one definition, not owner caps. */
export const SUPPORT_FIELD_LABEL_MAX = 120;
export const SUPPORT_FIELD_OPTIONS_MAX = 50;
export const SUPPORT_FORM_FIELDS_MAX = 50;
export const SUPPORT_FIELD_TEXT_MAX = 2000;
export const SUPPORT_FORM_REASON_MAX = 500;

const slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);
const label = z.string().trim().min(1).max(SUPPORT_FIELD_LABEL_MAX);

export const supportFieldOptionSchema = z.object({ value: slug, label });
export type SupportFieldOption = z.infer<typeof supportFieldOptionSchema>;

/** A dependent field: for each value of the parent choice, which of this field's options are allowed. */
export const supportFieldParentSchema = z.object({
  fieldId: slug,
  allowed: z.record(slug, z.array(slug).max(SUPPORT_FIELD_OPTIONS_MAX)),
});

const fieldBody = {
  id: slug,
  label,
  kind: z.enum(SUPPORT_FIELD_KINDS),
  /** Choice fields only: the values a person can pick. */
  options: z.array(supportFieldOptionSchema).max(SUPPORT_FIELD_OPTIONS_MAX).optional(),
  parent: supportFieldParentSchema.optional(),
  /** A retired field stays readable on the requests that hold it, and no form may use it. */
  retired: z.boolean().optional(),
};

export const supportFieldSchema = z.object({
  ...fieldBody,
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime(),
});
export type SupportField = z.infer<typeof supportFieldSchema>;

/** Create (expectedRevision 0) or change a field at the revision read. The reason goes on the audit row. */
export const supportFieldDefineInputSchema = z.object({
  ...fieldBody,
  kind: z.string().min(1).max(32),
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(SUPPORT_FORM_REASON_MAX),
});
export type SupportFieldDefineInput = z.infer<typeof supportFieldDefineInputSchema>;

export const supportFormFieldSchema = z.object({
  fieldId: slug,
  required: z.boolean(),
  /** Shown, and so accepted, only while another field of this form holds this value. */
  showWhen: z.object({ fieldId: slug, value: z.union([slug, z.boolean()]) }).optional(),
});
export type SupportFormField = z.infer<typeof supportFormFieldSchema>;

const formBody = {
  id: slug,
  /** The request type a person picks; the form is its questions. */
  name: label,
  fields: z.array(supportFormFieldSchema).min(1).max(SUPPORT_FORM_FIELDS_MAX),
  retired: z.boolean().optional(),
};

export const supportFormSchema = z.object({
  ...formBody,
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime(),
});
export type SupportForm = z.infer<typeof supportFormSchema>;

export const supportFormDefineInputSchema = z.object({
  ...formBody,
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(SUPPORT_FORM_REASON_MAX),
});
export type SupportFormDefineInput = z.infer<typeof supportFormDefineInputSchema>;

/** What a signed-in person reads to draw the request form: the live forms and every field they use. */
export const supportRequestFormsSchema = z.object({
  forms: z.array(supportFormSchema),
  fields: z.array(supportFieldSchema),
});
export type SupportRequestForms = z.infer<typeof supportRequestFormsSchema>;

/** One answer: a slug for a choice, true or false for a checkbox, text otherwise (a decimal is a decimal string). */
export const supportFieldValueSchema = z.union([z.string().max(SUPPORT_FIELD_TEXT_MAX), z.boolean()]);
export type SupportFieldValue = z.infer<typeof supportFieldValueSchema>;

/** The form a request was sent with and its answers, on `support.create`. */
export const supportCreateFormSchema = z.object({
  formId: slug,
  values: z.record(slug, supportFieldValueSchema),
});
export type SupportCreateForm = z.infer<typeof supportCreateFormSchema>;

/** The answers a request carries, with the form revision they were checked against. */
export const supportTicketFieldValuesSchema = z.object({
  ticketId: z.string().guid(),
  formId: z.string(),
  formRevision: z.number().int().positive(),
  values: z.record(z.string(), supportFieldValueSchema),
});
export type SupportTicketFieldValues = z.infer<typeof supportTicketFieldValuesSchema>;

/** A key's own value only: a field id or option such as `constructor` must never read `Object.prototype`. */
export function supportOwn<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** Whether a form field is shown for these answers: always, or while its controlling field holds the named value. */
export function supportFormFieldShown(field: SupportFormField, values: Readonly<Record<string, SupportFieldValue>>): boolean {
  return field.showWhen === undefined || supportOwn(values, field.showWhen.fieldId) === field.showWhen.value;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A calendar date that exists: `2026-02-30` is refused, not rolled over to March. */
const realDate = (value: string) => {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const DECIMAL = /^-?\d{1,18}(?:\.\d{1,18})?$/;

/** The options of a choice field allowed for these answers: all of them, or the ones its parent's value allows. */
export function supportFieldAllowedOptions(field: SupportField, values: Readonly<Record<string, SupportFieldValue>>): SupportFieldOption[] {
  const options = field.options ?? [];
  if (!field.parent) return options;
  const parentValue = supportOwn(values, field.parent.fieldId);
  const allowed = typeof parentValue === 'string' ? (supportOwn(field.parent.allowed, parentValue) ?? []) : [];
  return options.filter((option) => allowed.includes(option.value));
}

/**
 * Why these answers do not fit the form, or `null` when they do: an answer to a field that is not shown or not on the
 * form, a shown required field left empty, an answer of the wrong kind, or a dependent choice its parent does not allow.
 * `fieldId` names the first field at fault.
 */
export function supportFormValuesProblem(
  form: Pick<SupportForm, 'fields'>,
  fields: readonly SupportField[],
  values: Readonly<Record<string, SupportFieldValue>>,
): { fieldId: string; problem: 'not_on_form' | 'not_shown' | 'required' | 'wrong_kind' | 'not_allowed' } | null {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const onForm = new Set(form.fields.map((entry) => entry.fieldId));
  for (const fieldId of Object.keys(values)) if (!onForm.has(fieldId)) return { fieldId, problem: 'not_on_form' };
  for (const entry of form.fields) {
    const field = byId.get(entry.fieldId);
    if (!field) return { fieldId: entry.fieldId, problem: 'not_on_form' };
    const value = supportOwn(values, entry.fieldId);
    const given = value !== undefined && value !== false && !(typeof value === 'string' && value.trim() === '');
    if (!supportFormFieldShown(entry, values)) {
      if (value !== undefined) return { fieldId: entry.fieldId, problem: 'not_shown' };
      continue;
    }
    if (!given) {
      if (entry.required) return { fieldId: entry.fieldId, problem: 'required' };
      if (value !== undefined && field.kind !== 'checkbox' && typeof value !== 'string')
        return { fieldId: entry.fieldId, problem: 'wrong_kind' };
      continue;
    }
    if (field.kind === 'checkbox') {
      if (typeof value !== 'boolean') return { fieldId: entry.fieldId, problem: 'wrong_kind' };
      continue;
    }
    if (typeof value !== 'string') return { fieldId: entry.fieldId, problem: 'wrong_kind' };
    if (field.kind === 'date' && !realDate(value)) return { fieldId: entry.fieldId, problem: 'wrong_kind' };
    if (field.kind === 'decimal' && !DECIMAL.test(value)) return { fieldId: entry.fieldId, problem: 'wrong_kind' };
    if (field.kind === 'choice') {
      if (!(field.options ?? []).some((option) => option.value === value)) return { fieldId: entry.fieldId, problem: 'wrong_kind' };
      if (!supportFieldAllowedOptions(field, values).some((option) => option.value === value))
        return { fieldId: entry.fieldId, problem: 'not_allowed' };
    }
  }
  return null;
}

/** The answers as kept: text trimmed, blank text dropped. The service keeps this form of what it checked. */
export function supportFormValuesTrimmed(values: Readonly<Record<string, SupportFieldValue>>): Record<string, SupportFieldValue> {
  const out: Record<string, SupportFieldValue> = {};
  for (const [fieldId, value] of Object.entries(values)) {
    if (typeof value !== 'string') out[fieldId] = value;
    else if (value.trim() !== '') out[fieldId] = value.trim();
  }
  return out;
}

/** Why a field definition cannot be stored, or `null` (the kind itself is checked first, as its own refusal). */
export function supportFieldDefinitionProblem(field: Pick<SupportField, 'id' | 'kind' | 'options' | 'parent'>): string | null {
  const values = (field.options ?? []).map((option) => option.value);
  if (field.kind === 'choice' && values.length === 0) return 'a choice needs options';
  if (field.kind !== 'choice' && field.options !== undefined) return 'only a choice has options';
  if (new Set(values).size !== values.length) return 'option values repeat';
  if (field.parent) {
    if (field.kind !== 'choice') return 'only a choice can depend on another field';
    if (field.parent.fieldId === field.id) return 'a field cannot depend on itself';
    for (const children of Object.values(field.parent.allowed))
      if (children.some((child) => !values.includes(child))) return 'an allowed value is not an option';
  }
  return null;
}
