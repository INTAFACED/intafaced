import { parseAmount } from '../../../../shared/money';
import {
  productKeySchema,
  statementDescriptorSchema,
  type ProductCreateInput,
  type ProductImageRules,
  type ProductType,
} from '@intafaced/contracts/merchant-catalog';

/** What the Add a product form holds, as typed. */
export type ProductDraft = {
  name: string;
  type: ProductType;
  unitLabel: string;
  statementDescriptor: string;
  productKey: string;
  /** `datetime-local` text, in the person's own time zone. */
  eventStartsAt: string;
  eventLocation: string;
  imageId: string | null;
};

export const blankProduct = (): ProductDraft => ({
  name: '',
  type: 'physical',
  unitLabel: '',
  statementDescriptor: '',
  productKey: '',
  eventStartsAt: '',
  eventLocation: '',
  imageId: null,
});

export type DraftProblem = 'nameRequired' | 'descriptorInvalid' | 'keyInvalid' | 'eventInvalid';

/** The first thing that keeps the draft from being saved, checked with the service's own rules; null when it can be sent. */
export function draftProblem(draft: ProductDraft): DraftProblem | null {
  if (!draft.name.trim()) return 'nameRequired';
  if (draft.productKey.trim() && !productKeySchema.safeParse(draft.productKey).success) return 'keyInvalid';
  if (draft.statementDescriptor.trim() && !statementDescriptorSchema.safeParse(draft.statementDescriptor).success)
    return 'descriptorInvalid';
  if (draft.type === 'event' && (!eventInstant(draft.eventStartsAt) || !draft.eventLocation.trim())) return 'eventInvalid';
  return null;
}

/** A `datetime-local` value read in the browser's time zone, as an ISO instant; null when it is not a time. */
export function eventInstant(local: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(local)) return null;
  const at = new Date(local);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** The body `merchantCatalog.products.create` takes. Only an event sends its start and place; blank optional fields are left out. */
export function productBody(draft: ProductDraft, requestId: string): ProductCreateInput {
  const optional = (value: string) => (value.trim() ? value.trim() : undefined);
  const startsAt = draft.type === 'event' ? eventInstant(draft.eventStartsAt) : null;
  return {
    requestId,
    name: draft.name.trim(),
    type: draft.type,
    ...(optional(draft.productKey) ? { productKey: draft.productKey.trim() } : {}),
    ...(optional(draft.unitLabel) ? { unitLabel: draft.unitLabel.trim() } : {}),
    ...(optional(draft.statementDescriptor) ? { statementDescriptor: draft.statementDescriptor.trim() } : {}),
    ...(startsAt ? { event: { startsAt, location: draft.eventLocation.trim() } } : {}),
    ...(draft.imageId ? { imageId: draft.imageId } : {}),
  };
}

/** A byte count as people read it: 512 bytes, 500 KB, 3 MB (decimal units, as file managers show them). */
export function sizeText(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1_000_000) return `${trim(bytes / 1000)} KB`;
  return `${trim(bytes / 1_000_000)} MB`;
}
const trim = (n: number) => (Math.round(n * 10) / 10).toString();

export type ImageCheck =
  { ok: true } | { ok: false; reason: 'rulesUnset' } | { ok: false; reason: 'tooLarge' | 'wrongType'; size: number; max: number };

/** The owner's rule applied to a picked file before anything is sent; the service checks the bytes again. */
export function checkImage(file: { size: number; type: string }, rules: ProductImageRules): ImageCheck {
  if (rules.maxBytes === null) return { ok: false, reason: 'rulesUnset' };
  if (!(rules.types as readonly string[]).includes(file.type))
    return { ok: false, reason: 'wrongType', size: file.size, max: rules.maxBytes };
  if (file.size > rules.maxBytes) return { ok: false, reason: 'tooLarge', size: file.size, max: rules.maxBytes };
  return { ok: true };
}

/**
 * An upload's request id, from the file's SHA-256: the first 128 bits, written as a uuid with the version and variant
 * bits of a name-based id. The same file is the same upload, so a retry after a lost answer is a replay, not a copy.
 */
export async function imageRequestId(file: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The Add price form as typed. Amounts stay strings: decimal text on the wire, never a float. */
export interface PriceDraft {
  billing: 'one_time' | 'monthly';
  kind: 'fixed' | 'customer_chosen';
  amount: string;
  minAmount: string;
  maxAmount: string;
  assetId: string;
}

export const blankPrice: PriceDraft = { billing: 'one_time', kind: 'fixed', amount: '', minAmount: '', maxAmount: '', assetId: '' };

const AMOUNT = /^(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/;
const ASSET = /^[A-Z0-9]{1,16}$/;
const positiveAmount = (raw: string) => AMOUNT.test(raw.trim()) && /[1-9]/.test(raw);

/** The first thing the form would refuse, checked before anything is sent; the service checks again. */
export function priceProblem(draft: PriceDraft): 'amountInvalid' | 'boundsInvalid' | 'assetInvalid' | null {
  if (draft.kind === 'fixed') {
    if (!positiveAmount(draft.amount)) return 'amountInvalid';
  } else {
    if (!positiveAmount(draft.minAmount) || !positiveAmount(draft.maxAmount)) return 'boundsInvalid';
    if (parseAmount(draft.maxAmount.trim()) < parseAmount(draft.minAmount.trim())) return 'boundsInvalid';
  }
  if (!ASSET.test(draft.assetId.trim())) return 'assetInvalid';
  return null;
}

/** What Save price sends, without its request id (added per body by the form). A monthly price is always fixed. */
export function priceBody(draft: PriceDraft, productId: string) {
  const kind = draft.billing === 'monthly' ? 'fixed' : draft.kind;
  return {
    productId,
    billing: draft.billing,
    kind,
    assetId: draft.assetId.trim(),
    ...(kind === 'fixed' ? { amount: draft.amount.trim() } : { minAmount: draft.minAmount.trim(), maxAmount: draft.maxAmount.trim() }),
  };
}
