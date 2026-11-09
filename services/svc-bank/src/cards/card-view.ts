/**
 * The one view of a card that leaves svc-bank: the owner's `cards.*` procedures and the console's `ops.customerCards` build
 * their output from this schema and this presenter, so the two cannot drift. Nothing secret is in it: `panTail` is four digits,
 * never a card number, and the issuer reference, security code and PIN never leave. The operator view drops `shippingAddress`.
 *
 * `simulated` is on the card output and it is not optional: a screen rendering a card cannot present it as a real one.
 */
import { formatAmount } from '@intafaced/ledger-client';
import { z } from 'zod';
import { amountString } from '../router/shared.js';
import { cardInactive, type CardRecord } from './card-service.js';

export const cardOutput = z.object({
  id: z.string(),
  /** Which balance the card draws on. Every posting against it is in this asset. */
  assetId: z.string(),
  /**
   * What merchants charge this card in (§18).
   *
   * Equal to `assetId` means no conversion happens and no rate is consulted.
   * Different means every authorisation is quoted at the authorisation moment
   * — and refuses by name where no rate can be got, which on a fiat settlement
   * asset is every time, because this platform has no FX source.
   */
  settlementAssetId: z.string(),
  /** The programme id, which is also the ledger rail label. */
  issuer: z.string(),
  /** TRUE MEANS THERE IS NO CARD. Never omitted, never defaulted. */
  simulated: z.boolean(),
  /** Four digits. Not a card number and not part of one. */
  panTail: z.string(),
  /** `inactive`: issued but not activated yet (BK-cissue-04); it declines every authorisation until it is. */
  status: z.enum(['active', 'inactive', 'frozen', 'closed']),
  cashbackBps: z.number().int(),
  perAuthorizationLimit: amountString,
  dailyLimit: amountString.nullable(),
  monthlyLimit: amountString.nullable(),
  cashLimit: amountString.nullable(),
  online: z.boolean(),
  contactless: z.boolean(),
  atm: z.boolean(),
  abroad: z.boolean(),
  cardType: z.enum(['virtual', 'physical']),
  shippingAddress: z
    .object({
      name: z.string(),
      line1: z.string(),
      line2: z.string().nullable(),
      city: z.string(),
      region: z.string().nullable(),
      postalCode: z.string(),
      country: z.string(),
    })
    .nullable(),
  /** Single-use (1) or n-use: captured payments before it closes itself. NULL is no limit. */
  usesAllowed: z.number().int().nullable(),
  designId: z.string().nullable(),
  deliverySpeed: z.string().nullable(),
  replacesCardId: z.string().nullable(),
  replacedByCardId: z.string().nullable(),
});

export type CardView = z.infer<typeof cardOutput>;

export function presentCard(c: CardRecord): CardView {
  return {
    id: c.id,
    assetId: c.assetId,
    settlementAssetId: c.settlementAssetId,
    issuer: c.issuer,
    simulated: c.simulated,
    panTail: c.panTail,
    status: presentStatus(c),
    cashbackBps: c.cashbackBps,
    perAuthorizationLimit: formatAmount(c.perAuthorizationLimit),
    dailyLimit: c.dailyLimit == null ? null : formatAmount(c.dailyLimit),
    monthlyLimit: c.monthlyLimit == null ? null : formatAmount(c.monthlyLimit),
    cashLimit: c.cashLimit == null ? null : formatAmount(c.cashLimit),
    online: c.online ?? true,
    contactless: c.contactless ?? true,
    atm: c.atm ?? true,
    abroad: c.abroad ?? true,
    cardType: c.cardType ?? 'virtual',
    shippingAddress: c.shippingAddress ?? null,
    usesAllowed: c.usesAllowed ?? null,
    designId: c.designId ?? null,
    deliverySpeed: c.deliverySpeed ?? null,
    replacesCardId: c.replacesCardId ?? null,
    replacedByCardId: c.replacedByCardId ?? null,
  };
}

export function presentStatus(c: CardRecord): 'active' | 'inactive' | 'frozen' | 'closed' {
  return c.status === 'active' && cardInactive(c) ? 'inactive' : c.status;
}
