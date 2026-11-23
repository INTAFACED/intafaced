import { parseAmount } from '@intafaced/ledger-client';
import type { BankRoot } from '../bank-root.js';
import type { AutoInvestService } from '../auto-invest/auto-invest-service.js';
import { assertPartnerOffers, moneyHeldBy } from '../partner/test-partner.js';
import { stopGuardedCardHolds, TEST_PARTNER_ID } from '../partner/partner-stops.js';
import { payInCredited } from '../pay-yourself/test-pay-in.js';
import type { PayYourselfServiceOptions } from '../pay-yourself/compose.js';
import type { SharedPotService } from '../spaces/shared-pots.js';
import { CardDisputeService, type DisputeCap } from './card-disputes.js';
import { CardOrderService } from './card-orders.js';
import { CardService, type CardServiceOptions } from './card-service.js';
import { noCardIssuer, type CardIssuerAdapter } from './issuer.js';
import { freezeGuardedCardHolds, testPartnerCardHolds, type PartnerCardHolds } from './partner-card-holds.js';
import { NOTHING_REPORTED } from './partner-terms.js';

/** Cards, their orders and disputes, and the partner's card holds. An area of svc-bank (`area-chain.ts`). */
export interface CardsServices {
  readonly cards: CardService;
  /** J-bank-13: the card room's product list, terms, order and delivery. */
  readonly cardOrders: CardOrderService;
  /** J-bank-27: card disputes worked by support; the partner's provisional credit and loss liability, the owner's cap. */
  readonly cardDisputes: CardDisputeService;
  /** The partner's card holds behind the posting freeze and the partner stop; null with no partner card programme. */
  readonly partnerCardHolds: PartnerCardHolds | null;
}

export interface CardsAreaOptions {
  /**
   * Card wiring: which issuer, if any.
   *
   * Not defaulted to `cardSim()`, and the omission is the same shape as the
   * price source above. The dangerous default here is the plausible one — fall
   * back to the simulator and an environment somebody believes is live starts
   * approving authorisations against a counterparty that does not exist. With no
   * issuer configured every card procedure refuses with `bank.no_card_issuer`,
   * which is the correct posture for a deployment that has not been given a card
   * programme (and none has one: the live rail is `socket.live-issuer`).
   */
  cards?: CardServiceOptions;
  /** The owner's dispute cap per asset (`BANK_CARD_DISPUTE_CAP_JSON`); unset refuses `bank.card_dispute_cap_unset`. */
  cardDisputeCap?: DisputeCap;
}

export function composeCardsArea(
  root: BankRoot,
  made: { readonly autoInvest: AutoInvestService; readonly sharedPots: SharedPotService },
  options: CardsAreaOptions & Pick<PayYourselfServiceOptions, 'payInRail'>,
): CardsServices {
  const { sql, ledger, testPartner } = root;
  // No issuer configured = no card programme, and every card procedure refuses
  // by name rather than simulating one. See `cards/issuer.ts`.
  // WHOSE BOOK HOLDS A PERSON'S CARD MONEY (OWNER 226): the TEST partner's per-person custody switch, else the custody
  // switch. The TEST partner card holds partner-held authorisations, only on the TEST stack (card-sim and the TEST partner
  // both chosen, each refused at boot outside dev/test).
  const cardIssuer = options.cards?.issuer;
  // Every partner card instruction first asks svc-ledger's posting freeze too, as every partner bank move does.
  const unguardedHolds =
    options.cards?.partnerHolds ??
    (testPartner && cardIssuer && cardIssuer.programme.id === 'card-sim' && !cardIssuer.mutationRefuse
      ? testPartnerCardHolds({
          terms: () => (cardIssuer.partnerTerms ? cardIssuer.partnerTerms() : NOTHING_REPORTED),
          switches: (userId) => testPartner.switches(userId),
          // Its provisional dispute credits count in the same spendable figure (the issuer keeps them),
          // and the TEST partner's credited pay-ins (J-bank-31 #4: what the person paid themselves shows on the card).
          credited: (userId, assetId) => testCardCredited(cardIssuer, userId, assetId) + payInCredited(options.payInRail, userId, assetId),
        })
      : null);
  const partnerCardHolds: PartnerCardHolds | null = unguardedHolds
    ? stopGuardedCardHolds(
        freezeGuardedCardHolds(unguardedHolds, root.postingFreeze, root.partnerRefusals.note),
        TEST_PARTNER_ID,
        root.partnerStops,
        root.partnerRefusals.note,
      )
    : null;
  const cards = new CardService(sql, ledger, {
    ...options.cards,
    heldBy: options.cards?.heldBy ?? ((userId) => moneyHeldBy(testPartner, userId, root.custodyLayer)),
    partnerHolds: partnerCardHolds,
    // The TEST partner's own "not offered" switch for phone wallets (J-bank-13 #8); no partner, the issuer alone decides.
    assertWalletOffered:
      options.cards?.assertWalletOffered ??
      (testPartner ? (userId: string) => assertPartnerOffers(testPartner, userId, 'phone_wallet') : null),
    onCaptureSettled: options.cards?.onCaptureSettled ?? ((event) => made.autoInvest.applyRoundUp(event)),
    // A card linked to a shared pot: every change of its status is a line in the pot's log, in the card's transaction.
    onStatusChanged: options.cards?.onStatusChanged ?? ((tx, change) => made.sharedPots.noteCardStatus(tx, change)),
  });
  return {
    cards,
    cardDisputes: new CardDisputeService(sql, {
      issuer: options.cards?.issuer ?? noCardIssuer,
      partnerTerms: () => cards.partnerTerms(),
      simulated: () => cards.programme().simulated,
      cap: options.cardDisputeCap ?? null,
    }),
    cardOrders: new CardOrderService(sql, cards, { terms: options.cards?.programmeTerms ?? null }),
    partnerCardHolds,
  };
}

/** The TEST card partner's provisional credits to one cardholder in one asset, not reversed, as its own book holds them. */
function testCardCredited(issuer: CardIssuerAdapter, userId: string, assetId: string): bigint {
  const book = issuer.testRecord?.(userId);
  if (!book) return 0n;
  return book.credits.filter((c) => c.assetId === assetId && !c.reversed).reduce((sum, c) => sum + parseAmount(c.amount), 0n);
}
