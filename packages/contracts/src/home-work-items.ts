/**
 * Home work list (HM-dashboard-03): what needs the signed-in person now, built from each owner's own records.
 *
 * A work item is a derived read, never a stored row: it exists while its owner's record says so and is gone when the
 * owner resolves it. Each owning service answers `workItems.list` for the signed principal with only its own kinds.
 * The customer app merges the answers in the owner's order and shows at most the owner's cap.
 *
 * Owner values (decision for this contract, the spec left it to the builder): the margin warning level lives in
 * svc-bank's own settings (svc-bank never reads svc-ops); the item order and the cap live in svc-ops and reach the
 * customer app through the public `home.config` read below, with Home's other owner value, the header search's help
 * result cap (HM-navigation-04). A blank value refuses with its own code.
 *
 * Browser safe: nothing here imports Node.
 */
import { z } from 'zod';

/** The procedure every owning service mounts for its own items (`/api/<module>/trpc/workItems.list`). */
export const WORK_ITEMS_PROCEDURE = 'workItems.list' as const;
/** svc-ops' public read of Home's owner values (`/api/ops/trpc/home.config`). */
export const HOME_CONFIG_PROCEDURE = 'home.config' as const;

/** Refusals of this list. Owner reads keep their own codes. */
export const WORK_LIST_CAP_UNSET = 'home.work_list_cap_unset' as const;
export const WORK_LIST_ORDER_UNSET = 'home.work_list_order_unset' as const;
/** The header search's Help group while the help result cap is blank (HM-navigation-04). */
export const SEARCH_RESULT_CAP_UNSET = 'home.search_result_cap_unset' as const;
/** Home's announcement strip while its notice count is blank (HM-widgets-03): the strip says the count is not set. */
export const NOTICE_STRIP_LIMIT_UNSET = 'home.notice_strip_limit_unset' as const;
/** Returned to the settings desk only: Home shows no margin item and no error while the level is blank. */
export const BANK_MARGIN_WARNING_UNSET = 'bank.margin_warning_unset' as const;

/** Every kind and the one service that may answer it. A kind not listed here is not a work item. */
export const WORK_ITEM_SOURCES = {
  verification: 'identity',
  margin_health: 'bank',
  loan_payment_due: 'bank',
  card_frozen: 'bank',
  payout_waiting: 'pay',
} as const;
export type WorkItemKind = keyof typeof WORK_ITEM_SOURCES;
export type WorkItemSource = (typeof WORK_ITEM_SOURCES)[WorkItemKind];
export const workItemKindSchema = z.enum(Object.keys(WORK_ITEM_SOURCES) as [WorkItemKind, ...WorkItemKind[]]);
const SOURCES = [...new Set(Object.values(WORK_ITEM_SOURCES))] as [WorkItemSource, ...WorkItemSource[]];
export const workItemSourceSchema = z.enum(SOURCES);

/** The customer rooms each owner may link to: its own, never another owner's. */
export const WORK_ITEM_ROOMS: Record<WorkItemSource, readonly string[]> = {
  identity: ['/verification', '/uc/'],
  bank: ['/bank'],
  pay: ['/pay'],
};
const inRoom = (source: WorkItemSource, link: string): boolean =>
  WORK_ITEM_ROOMS[source].some(
    (room) => link === room || link.startsWith(room.endsWith('/') ? room : `${room}/`) || link.startsWith(`${room}?`),
  );

/** Decimal string on the wire, never a JSON number. */
const decimal = z
  .string()
  .max(80)
  .regex(/^\d+(\.\d+)?$/, 'decimal string');

/** A code, not a sentence: lower case words joined by `.` or `_`. */
const code = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z][a-z0-9]*([._][a-z0-9]+)*$/, 'code, not a sentence');

/**
 * A customer room path: one leading slash, no scheme, no `//`, no backslash, no space. The path (before any query) has
 * no `.` or `..` segment and no percent escape, so the owner-room prefix check below cannot be walked out of.
 */
const roomLink = z
  .string()
  .min(1)
  .max(512)
  .regex(/^\/(?!\/)[^\\\s]*$/, 'customer room path')
  .refine((link) => {
    const path = link.split(/[?#]/)[0] ?? '';
    return !path.includes('%') && !path.split('/').some((segment) => segment === '.' || segment === '..');
  }, 'customer room path without dot segments or escapes');

/** The fields of one item, before the cross-field rules (extend this, then apply `workItemRules`). */
export const workItemFieldsSchema = z
  .object({
    /** `<kind>:<owner's record id>`, stable for the life of that record, so a re-read keeps the same row. */
    id: z.string().min(1).max(200),
    kind: workItemKindSchema,
    source: workItemSourceSchema,
    /** `action`: only the person can move it on. `warning`: it will get worse if left. `info`: waiting on someone else. */
    severity: z.enum(['action', 'warning', 'info']),
    /** Copy key the customer app words; the owner sends no sentences. */
    titleKey: code,
    link: roomLink,
    /** ISO 8601 time the owner's record says it is due, when it has one. */
    dueAt: z.string().datetime({ offset: true }).optional(),
    /** An amount from the owner's record, as a decimal string with its asset. */
    amount: z.object({ value: decimal, asset: z.string().min(1).max(32) }).optional(),
    /** A ratio from the owner's record (loan-to-value), as a decimal string where 1 is 100%. */
    ratio: decimal.optional(),
    /** The owner's typed reason, when the item is a state the owner put it in (a frozen card's reason code). */
    reasonCode: code.optional(),
  })
  .strict();

/** The rules across fields: the kind's owner answers it, its id starts with its kind, and it links to the owner's room. */
export function workItemRules(item: z.infer<typeof workItemFieldsSchema>, ctx: z.RefinementCtx): void {
  if (WORK_ITEM_SOURCES[item.kind] !== item.source)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source'], message: 'kind answered by a service that does not own it' });
  if (!item.id.startsWith(`${item.kind}:`) || item.id.length === item.kind.length + 1)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['id'], message: 'id is <kind>:<record id>' });
  if (!inRoom(item.source, item.link))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['link'], message: 'link leaves the owner’s own rooms' });
}

export const workItemSchema = workItemFieldsSchema.superRefine(workItemRules);
export type WorkItem = z.infer<typeof workItemSchema>;

/** One owner's answer to `workItems.list`: only its own kinds, for the signed principal. Empty means nothing needs them. */
export const workItemsOutputSchema = z.object({
  items: z
    .array(workItemSchema)
    .max(100)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length, 'one row per item id'),
});
export type WorkItemsOutput = z.infer<typeof workItemsOutputSchema>;

/** Whether an owner's answer holds only that owner's kinds. A consumer drops the whole answer otherwise. */
export function ownsAll(source: WorkItemSource, output: WorkItemsOutput): boolean {
  return output.items.every((item) => item.source === source);
}

/**
 * Home's owner values, as svc-ops' public read answers them. `null` is blank: the customer app refuses the work list
 * with `home.work_list_cap_unset`, keeps the owners' answer order and says the order is not set, or shows the Help
 * group of the header search as not set (`home.search_result_cap_unset`).
 */
export const homeConfigOutputSchema = z.object({
  workListCap: z.number().int().min(1).max(50).nullable(),
  workListOrder: z
    .array(workItemKindSchema)
    .min(1)
    .refine((kinds) => new Set(kinds).size === kinds.length, 'each kind once')
    .nullable(),
  /** How many help articles the header search lists. */
  searchResultCap: z.number().int().min(1).max(20).nullable(),
  /** How many of the latest announcements Home's strip shows (HM-widgets-03). Absent from an older answer reads as blank. */
  noticeStripLimit: z.number().int().min(1).max(10).nullable().default(null),
  revision: z.number().int().nonnegative(),
});
export type HomeConfig = z.infer<typeof homeConfigOutputSchema>;
