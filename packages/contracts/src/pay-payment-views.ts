import { z } from 'zod';

/**
 * Saved views on the payments list and role-gated viewing of payment details (M-adv-payments-core-01, J-merchant-05
 * step 3): `payment.views.*`, `payment.unmask` and `payment.unmaskReads` on svc-pay.
 *
 * A view is a name, the list's own filters and the columns to show, taken from a fixed allowlist. A private view is its
 * maker's alone; a shared view is seen by the whole team, and only the owner or an admin makes, changes or removes
 * one. Create is idempotent on (person, name): the same name with the same filters and columns answers the view
 * already saved, and the same name with anything else refuses `pay.payment_view_name_taken`.
 *
 * The payments list shows a payer's email (the one on the invoice the payment paid) masked for every role. A role
 * holding `payments.unmask` (owner, admin, finance) can ask for one clear value at a time from an interactive session,
 * giving a reason; each clear value shown writes one audit line (who, which payment, which field, why), which the owner
 * and admins read back. Viewer and developer never get a clear value, and read the rail reference masked everywhere
 * (`payment.list`, `payment.get`; a payments export has no rail reference column for them).
 */

/** The columns a view may show, in the order the list draws them. */
export const PAYMENT_VIEW_COLUMNS = ['payment', 'amount', 'status', 'method', 'created', 'customerEmail', 'railRef'] as const;
export const paymentViewColumnSchema = z.enum(PAYMENT_VIEW_COLUMNS);
export type PaymentViewColumn = z.infer<typeof paymentViewColumnSchema>;

/** What the list shows when no view and no column choice is set. */
export const PAYMENT_VIEW_DEFAULT_COLUMNS: readonly PaymentViewColumn[] = ['payment', 'amount', 'status', 'method', 'created'];

const statusSchema = z.enum(['created', 'authorized', 'captured', 'settled', 'refunded', 'disputed', 'failed']);

/** The list's own filters, as the address holds them. A custom date range is not saved: a view keeps a rolling window. */
export const paymentViewFiltersSchema = z
  .object({
    status: statusSchema.optional(),
    search: z.string().trim().min(1).max(200).optional(),
    assetId: z.string().trim().min(1).max(32).optional(),
    date: z.enum(['today', '7d', '30d']).optional(),
  })
  .strict();
export type PaymentViewFilters = z.infer<typeof paymentViewFiltersSchema>;

export const paymentViewVisibilitySchema = z.enum(['private', 'shared']);

const viewNameSchema = z.string().trim().min(1).max(60);
const viewColumnsSchema = z
  .array(paymentViewColumnSchema)
  .min(1)
  .max(PAYMENT_VIEW_COLUMNS.length)
  .refine((cols) => new Set(cols).size === cols.length, 'a column is named twice');

export const paymentViewSchema = z
  .object({
    id: z.string().guid(),
    name: z.string(),
    visibility: paymentViewVisibilitySchema,
    filters: paymentViewFiltersSchema,
    columns: z.array(paymentViewColumnSchema),
    /** True when the caller made it. */
    mine: z.boolean(),
    /** True when the caller may change or remove it. */
    editable: z.boolean(),
    revision: z.number().int().min(0),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type PaymentView = z.infer<typeof paymentViewSchema>;

/** `payment.views.list`: one page, newest first. */
export const paymentViewListSchema = z.object({ items: z.array(paymentViewSchema), nextCursor: z.string().nullable() }).strict();

export const paymentViewCreateInputSchema = z
  .object({
    name: viewNameSchema,
    visibility: paymentViewVisibilitySchema,
    filters: paymentViewFiltersSchema,
    columns: viewColumnsSchema,
  })
  .strict();

export const paymentViewUpdateInputSchema = z
  .object({
    viewId: z.string().guid(),
    /** The revision the caller read; a stale one refuses `pay.payment_view_stale`. */
    expectedRevision: z.number().int().min(0),
    name: viewNameSchema.optional(),
    filters: paymentViewFiltersSchema.optional(),
    columns: viewColumnsSchema.optional(),
  })
  .strict();

export const paymentViewDeleteInputSchema = z.object({ viewId: z.string().guid() }).strict();
export const paymentViewDeletedSchema = z.object({ deleted: z.literal(true) }).strict();

/**
 * The payment details `payment.unmask` shows in full. The rail reference is not one: the roles that may unmask already
 * read it in full, and viewer and developer read it masked with no way to unmask it.
 */
export const PAYMENT_MASKED_FIELDS = ['customerEmail'] as const;
export const paymentMaskedFieldSchema = z.enum(PAYMENT_MASKED_FIELDS);
export type PaymentMaskedField = z.infer<typeof paymentMaskedFieldSchema>;

/** The shortest reason an unmask accepts, after trimming. svc-pay refuses a shorter one with its typed code
 * (`pay.payment_unmask_reason_required`), and the portal reads the same number, so the two cannot drift apart. */
export const PAYMENT_UNMASK_REASON_MIN = 8;

export const paymentUnmaskInputSchema = z
  .object({
    paymentId: z.string().guid(),
    field: paymentMaskedFieldSchema,
    /** Why the clear value is needed. Kept on the audit line. No minimum here: the service checks
     * `PAYMENT_UNMASK_REASON_MIN` and refuses with its own typed code, which a schema error would not carry. */
    reason: z.string().trim().max(500),
  })
  .strict();

export const paymentUnmaskedSchema = z
  .object({
    paymentId: z.string().guid(),
    field: paymentMaskedFieldSchema,
    /** Null when the payment has no such detail. */
    value: z.string().nullable(),
    auditId: z.string().guid(),
  })
  .strict();

export const paymentUnmaskReadsInputSchema = z
  .object({
    paymentId: z.string().guid().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(300).optional(),
  })
  .strict();

export const paymentUnmaskReadSchema = z
  .object({
    id: z.string().guid(),
    paymentId: z.string().guid(),
    field: paymentMaskedFieldSchema,
    actorId: z.string(),
    actorRole: z.enum(['owner', 'admin', 'finance', 'developer', 'viewer']),
    reason: z.string(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const paymentUnmaskReadPageSchema = z
  .object({ items: z.array(paymentUnmaskReadSchema), nextCursor: z.string().nullable() })
  .strict();

/** What `payment.list` adds to each row: the masked payer email, or null when the payment paid no invoice with one. */
export const paymentListPrivacySchema = z.object({ customerEmail: z.string().nullable() }).strict();
