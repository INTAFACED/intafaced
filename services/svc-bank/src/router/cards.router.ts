import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { assertSelf } from '../assert-self.js';
import {
  issueCardBinding,
  revealCardBinding,
  revealCardPinBinding,
  setCardLimitsBinding,
  setCardPinBinding,
  unfreezeCardBinding,
  activateCardBinding,
  orderCardBinding,
  updateCardShippingBinding,
} from '../step-up/money-out-fields.js';
import { cardInactive } from '../cards/card-service.js';
import { cardOutput, presentCard } from '../cards/card-view.js';
import { CARD_TIERS, DELIVERY_SPEEDS } from '../cards/card-programme.js';
import type { CardDelivery } from '../cards/card-orders.js';
import { BankError } from '../errors.js';
import { amountString, stepUpApprovalField, refuseCardSecretWithoutStepUp } from './shared.js';
import { guard } from './errors.js';
import type { BankRouterContext } from './context.js';

export function createCardsRouter(c: BankRouterContext) {
  const { bank, stepUpEnforced, requireStepUp } = c;
  /**
   * CARDS (§8.1) — the LEDGER half only.
   *
   * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
   *
   * There is no user-callable `authorize`, `capture` or `reverse`. Those three
   * are the ISSUER speaking, not the user, and they are in `ops` behind
   * `admin:treasury` for the same reason the risk sweep is: a user who can
   * decide their own authorisation is a user who can approve a purchase the
   * ledger would have declined, and a user who can trigger a capture can choose
   * when their own money leaves.
   *
   * On a live rail they do not become user procedures either. They become a
   * signed webhook endpoint owned by the issuer integration — which is
   * `socket.live-issuer`, a card-scheme sponsor and an issuing BIN, and is a
   * contract rather than code.
   *
   * ── EVERY SURFACE SAYS WHAT IT IS ──────────────────────────────────────────
   *
   * `simulated` is on the card output and it is not optional. A screen rendering
   * a card from this router cannot accidentally present it as a real one, and a
   * deployment with no issuer at all cannot get this far: it refuses with
   * `bank.no_card_issuer` before a row is written.
   */

  const shippingAddressInput = z.object({
    name: z.string().trim().min(1).max(120),
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(120),
    region: z.string().trim().max(120).optional(),
    postalCode: z.string().trim().min(1).max(32),
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/),
  });

  const deliveryOutput = z.object({
    cardId: z.string(),
    state: z.enum(['ordered', 'produced', 'shipped', 'delivered']),
    designId: z.string().nullable(),
    designName: z.string().nullable(),
    speed: z.string(),
    estimateDays: z.number().int(),
    orderedAt: z.string(),
    expectedBy: z.string(),
    carrier: z.string().nullable(),
    trackingRef: z.string().nullable(),
    address: z.object({
      name: z.string(),
      line1: z.string(),
      line2: z.string().nullable(),
      city: z.string(),
      region: z.string().nullable(),
      postalCode: z.string(),
      country: z.string(),
    }),
    history: z.array(
      z.object({
        address: z.object({
          name: z.string(),
          line1: z.string(),
          line2: z.string().nullable(),
          city: z.string(),
          region: z.string().nullable(),
          postalCode: z.string(),
          country: z.string(),
        }),
        changedAt: z.string(),
      }),
    ),
  });

  function presentDelivery(d: CardDelivery) {
    const address = (a: CardDelivery['address']) => ({
      name: a.name,
      line1: a.line1,
      line2: a.line2 ?? null,
      city: a.city,
      region: a.region ?? null,
      postalCode: a.postalCode,
      country: a.country,
    });
    return {
      cardId: d.cardId,
      state: d.state,
      designId: d.designId,
      designName: d.designName,
      speed: d.speed,
      estimateDays: d.estimateDays,
      orderedAt: d.orderedAt.toISOString(),
      expectedBy: d.expectedBy.toISOString(),
      carrier: d.carrier,
      trackingRef: d.trackingRef,
      address: address(d.address),
      history: d.history.map((h) => ({ address: address(h.address), changedAt: h.changedAt.toISOString() })),
    };
  }

  function addressFrom(a: z.infer<typeof shippingAddressInput>) {
    return {
      name: a.name,
      line1: a.line1,
      line2: a.line2 ?? null,
      city: a.city,
      region: a.region ?? null,
      postalCode: a.postalCode,
      country: a.country.toUpperCase(),
    };
  }

  function ceilingLoosens(current: bigint | null, next: bigint | null | undefined): boolean {
    if (next === undefined) return false;
    if (next === null) return current !== null;
    if (current === null) return false;
    return next > current;
  }

  function limitField(value: string | null | undefined): string {
    if (value === undefined) return '';
    if (value === null) return 'null';
    return value;
  }

  function shippingToken(address: z.infer<typeof shippingAddressInput> | undefined): string {
    if (!address) return '';
    return JSON.stringify({
      name: address.name.trim(),
      line1: address.line1.trim(),
      line2: address.line2?.trim() ?? '',
      city: address.city.trim(),
      region: address.region?.trim() ?? '',
      postalCode: address.postalCode.trim(),
      country: address.country.trim().toUpperCase(),
    });
  }

  return router({
    /** What this deployment's card programme is — including that it is not one. */
    programme: scopedProcedure('bank:read', { module: 'bank' })
      .output(z.object({ id: z.string(), simulated: z.boolean(), displayName: z.string() }))
      .query(async () => guard(async () => bank.cards.programme())),

    /**
     * Cashback already paid, in one asset, once a non-simulated issuer is connected.
     * card-sim and an unconfigured programme refuse `bank.rewards_issuer_unset`.
     * Nothing here posts a reward or invents a zero for a missing issuer.
     */
    rewards: scopedProcedure('bank:read', { module: 'bank' })
      .output(z.object({ balance: amountString, asset: z.string(), simulated: z.literal(false) }))
      .query(({ ctx }) =>
        guard(async () => {
          const reward = await bank.cards.rewards(ctx.principal.userId);
          return { balance: formatAmount(reward.balance), asset: reward.assetId, simulated: false as const };
        }),
      ),

    list: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z
          .object({
            /**
             * Page size. Optional so omit reaches `bank.cards_list_limit_unset`
             * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
             */
            limit: z.number().int().min(1).max(200).optional(),
          })
          .optional(),
      )
      .output(z.array(cardOutput))
      .query(async ({ ctx, input }) =>
        guard(async () => {
          const rows = await bank.cards.cardsOf(ctx.principal.userId, input?.limit);
          return rows.map((c) => presentCard(c));
        }),
      ),

    /**
     * `cardId` is supplied by the client so a retried request is the same card,
     * not a second one drawing on the same balance (§5).
     */
    issue: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          cardId: z.string().guid(),
          assetId: z.string().min(1).max(16),
          /**
           * What merchants charge this card in. Omitted means the funding asset,
           * which is no conversion — the shape every card had before §18.
           *
           * A card may be issued with a settlement asset nothing can quote; the
           * refusal belongs on the authorisation, where the rate is needed, not
           * on a path that moves no money and could be refused by one transient
           * feed outage.
           */
          settlementAssetId: z.string().min(1).max(16).optional(),
          cashbackBps: z.number().int().min(0).max(10_000).optional(),
          perAuthorizationLimit: amountString,
          cardType: z.enum(['virtual', 'physical']).optional(),
          shippingAddress: shippingAddressInput.optional(),
          stepUpApprovalId: stepUpApprovalField,
        }),
      )
      .output(cardOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          if (stepUpEnforced) {
            await requireStepUp(
              ctx.principal,
              issueCardBinding({
                actor: ctx.principal.userId,
                cardId: input.cardId,
                assetId: input.assetId,
                settlementAssetId: input.settlementAssetId,
                cashbackBps: input.cashbackBps,
                perAuthorizationLimit: input.perAuthorizationLimit,
                cardType: input.cardType ?? 'virtual',
                shippingAddress: input.cardType === 'physical' ? shippingToken(input.shippingAddress) : '',
              }),
              input.stepUpApprovalId,
            );
          }
          const card = await bank.cards.issue({
            cardId: input.cardId,
            userId: ctx.principal.userId,
            assetId: input.assetId,
            ...(input.settlementAssetId === undefined ? {} : { settlementAssetId: input.settlementAssetId }),
            ...(input.cashbackBps === undefined ? {} : { cashbackBps: input.cashbackBps }),
            perAuthorizationLimit: parseAmount(input.perAuthorizationLimit),
            ...(input.cardType === undefined ? {} : { cardType: input.cardType }),
            ...(input.shippingAddress === undefined
              ? {}
              : {
                  shippingAddress: {
                    name: input.shippingAddress.name,
                    line1: input.shippingAddress.line1,
                    line2: input.shippingAddress.line2 ?? null,
                    city: input.shippingAddress.city,
                    region: input.shippingAddress.region ?? null,
                    postalCode: input.shippingAddress.postalCode,
                    country: input.shippingAddress.country,
                  },
                }),
          });
          return presentCard(card);
        }),
      ),

    /**
     * Freeze, unfreeze or close. The gesture a user reaches for first when
     * something is wrong, so it is user surface and not an operator ticket.
     */
    setStatus: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ cardId: z.string().guid(), status: z.enum(['active', 'frozen', 'closed']), stepUpApprovalId: stepUpApprovalField }))
      .output(z.object({ id: z.string(), status: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const card = await bank.cards.card(input.cardId);
          assertSelf(ctx.principal.userId, card.userId);
          // Only UNFREEZING loosens a safeguard. Freeze and close are protective and never prompt; asking
          // for `active` on a card that already is changes nothing. One approval re-applies nothing: no replay.
          if (stepUpEnforced && input.status === 'active' && card.status !== 'active') {
            await requireStepUp(
              ctx.principal,
              unfreezeCardBinding({ actor: ctx.principal.userId, cardId: input.cardId, fromStatus: card.status }),
              input.stepUpApprovalId,
              false,
            );
          }
          const updated = await bank.cards.setStatus(input.cardId, input.status, ctx.principal.userId);
          return { id: updated.id, status: updated.status };
        }),
      ),

    /**
     * Spending ceilings. Step-up only when a ceiling is raised or removed.
     * Tightening does not prompt. `commandId` retries the same change.
     */
    setLimits: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          cardId: z.string().guid(),
          commandId: z.string().guid(),
          perAuthorizationLimit: amountString,
          dailyLimit: amountString.nullable().optional(),
          monthlyLimit: amountString.nullable().optional(),
          cashLimit: amountString.nullable().optional(),
          stepUpApprovalId: stepUpApprovalField,
        }),
      )
      .output(cardOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const card = await bank.cards.card(input.cardId);
          assertSelf(ctx.principal.userId, card.userId);
          const per = parseAmount(input.perAuthorizationLimit);
          const daily = input.dailyLimit === undefined ? undefined : input.dailyLimit === null ? null : parseAmount(input.dailyLimit);
          const monthly =
            input.monthlyLimit === undefined ? undefined : input.monthlyLimit === null ? null : parseAmount(input.monthlyLimit);
          const cash = input.cashLimit === undefined ? undefined : input.cashLimit === null ? null : parseAmount(input.cashLimit);
          const loosens =
            per > card.perAuthorizationLimit ||
            ceilingLoosens(card.dailyLimit, daily) ||
            ceilingLoosens(card.monthlyLimit, monthly) ||
            ceilingLoosens(card.cashLimit, cash);
          if (stepUpEnforced && loosens) {
            await requireStepUp(
              ctx.principal,
              setCardLimitsBinding({
                actor: ctx.principal.userId,
                cardId: input.cardId,
                commandId: input.commandId,
                perAuthorizationLimit: input.perAuthorizationLimit,
                dailyLimit: limitField(input.dailyLimit),
                monthlyLimit: limitField(input.monthlyLimit),
                cashLimit: limitField(input.cashLimit),
              }),
              input.stepUpApprovalId,
            );
          }
          const updated = await bank.cards.setLimits({
            cardId: input.cardId,
            userId: ctx.principal.userId,
            commandId: input.commandId,
            perAuthorizationLimit: per,
            ...(daily === undefined ? {} : { dailyLimit: daily }),
            ...(monthly === undefined ? {} : { monthlyLimit: monthly }),
            ...(cash === undefined ? {} : { cashLimit: cash }),
          });
          return presentCard(updated);
        }),
      ),

    /** Online, contactless, ATM and abroad. `commandId` retries the same four flags. */
    setChannels: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          cardId: z.string().guid(),
          commandId: z.string().guid(),
          online: z.boolean(),
          contactless: z.boolean(),
          atm: z.boolean(),
          abroad: z.boolean(),
        }),
      )
      .output(cardOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const card = await bank.cards.card(input.cardId);
          assertSelf(ctx.principal.userId, card.userId);
          const updated = await bank.cards.setChannels({
            cardId: input.cardId,
            userId: ctx.principal.userId,
            commandId: input.commandId,
            online: input.online,
            contactless: input.contactless,
            atm: input.atm,
            abroad: input.abroad,
          });
          return presentCard(updated);
        }),
      ),

    /**
     * PAN, expiry and CVV from a live issuer. Step-up every time. Not stored.
     * card-sim refuses `bank.card_pan_issuer_unset` before step-up. With step-up
     * not `required`, the call refuses `bank.step_up_unavailable` and the issuer is not called.
     */
    reveal: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ cardId: z.string().guid(), revealId: z.string().guid(), stepUpApprovalId: stepUpApprovalField }))
      .output(z.object({ pan: z.string(), expiry: z.string(), cvv: z.string(), expiresAt: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const card = await bank.cards.card(input.cardId);
          assertSelf(ctx.principal.userId, card.userId);
          bank.cards.assertSecretIssuer('pan', 'revealCredentials');
          if (!stepUpEnforced) refuseCardSecretWithoutStepUp();
          await requireStepUp(
            ctx.principal,
            revealCardBinding({ actor: ctx.principal.userId, cardId: input.cardId, revealId: input.revealId }),
            input.stepUpApprovalId,
            false,
          );
          return bank.cards.reveal({ cardId: input.cardId, userId: ctx.principal.userId, revealId: input.revealId });
        }),
      ),

    pin: router({
      reveal: scopedProcedure('bank:read', { module: 'bank' })
        .input(z.object({ cardId: z.string().guid(), revealId: z.string().guid(), stepUpApprovalId: stepUpApprovalField }))
        .output(z.object({ pin: z.string(), expiresAt: z.string() }))
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            const card = await bank.cards.card(input.cardId);
            assertSelf(ctx.principal.userId, card.userId);
            bank.cards.assertSecretIssuer('pin', 'revealPin');
            if (!stepUpEnforced) refuseCardSecretWithoutStepUp();
            await requireStepUp(
              ctx.principal,
              revealCardPinBinding({ actor: ctx.principal.userId, cardId: input.cardId, revealId: input.revealId }),
              input.stepUpApprovalId,
              false,
            );
            return bank.cards.revealPin({ cardId: input.cardId, userId: ctx.principal.userId, revealId: input.revealId });
          }),
        ),
      set: scopedProcedure('bank:write', { module: 'bank' })
        .input(
          z.object({
            cardId: z.string().guid(),
            commandId: z.string().guid(),
            pin: z.string().min(1).max(64),
            stepUpApprovalId: stepUpApprovalField,
          }),
        )
        .output(z.object({ ok: z.literal(true) }))
        .mutation(async ({ ctx, input }) =>
          guard(async () => {
            const card = await bank.cards.card(input.cardId);
            assertSelf(ctx.principal.userId, card.userId);
            bank.cards.assertPinDigits(input.pin);
            bank.cards.assertSecretIssuer('pin', 'setPin');
            if (!stepUpEnforced) refuseCardSecretWithoutStepUp();
            await requireStepUp(
              ctx.principal,
              setCardPinBinding({ actor: ctx.principal.userId, cardId: input.cardId, commandId: input.commandId }),
              input.stepUpApprovalId,
            );
            return bank.cards.setPin({
              cardId: input.cardId,
              userId: ctx.principal.userId,
              commandId: input.commandId,
              pin: input.pin,
            });
          }),
        ),
    }),

    /** Opaque push-provisioning payload. Refuses until socket.live-issuer can produce one. */
    walletProvision: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          cardId: z.string().guid(),
          provisionId: z.string().guid(),
          wallet: z.enum(['apple', 'google']),
          nonce: z.string().min(1).max(4096),
        }),
      )
      .output(z.object({ payload: z.string(), expiresAt: z.string() }))
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const card = await bank.cards.card(input.cardId);
          assertSelf(ctx.principal.userId, card.userId);
          return bank.cards.walletProvision({
            cardId: input.cardId,
            userId: ctx.principal.userId,
            provisionId: input.provisionId,
            wallet: input.wallet,
            nonce: input.nonce,
          });
        }),
      ),

    /**
     * Close this card and issue another with the same asset, ceilings and channels.
     * `replacementId` is the idempotency key.
     */
    replace: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          cardId: z.string().guid(),
          replacementId: z.string().guid(),
          reason: z.enum(['lost', 'stolen', 'damaged']),
        }),
      )
      .output(cardOutput)
      .mutation(async ({ ctx, input }) =>
        guard(async () => {
          const card = await bank.cards.card(input.cardId);
          assertSelf(ctx.principal.userId, card.userId);
          const replaced = await bank.cards.replace({
            cardId: input.cardId,
            userId: ctx.principal.userId,
            replacementId: input.replacementId,
            reason: input.reason,
          });
          await bank.cardOrders.afterReplace(replaced);
          return presentCard(replaced);
        }),
      ),

    /**
     * Cashback by rank card tier (RC-bank-02, J-bank-13 #7): the caller's tier and its rate, every tier's rate, the asset
     * it is paid in, and what their card spend was paid (each payment a reward record with its ledger transaction).
     */
    cashback: scopedProcedure('bank:read', { module: 'bank' })
      .output(
        z.object({
          tier: z.enum(CARD_TIERS),
          rateBps: z.number().int().nullable(),
          assetId: z.string(),
          rates: z.array(z.object({ tier: z.enum(CARD_TIERS), bps: z.number().int() })),
          paid: amountString,
          unpaid: amountString,
          refused: amountString,
          payments: z.array(
            z.object({
              authorizationId: z.string(),
              cardId: z.string(),
              amount: amountString,
              status: z.string(),
              rejectionCode: z.string().nullable(),
              ledgerTxId: z.string().nullable(),
            }),
          ),
          paying: z.boolean(),
          simulated: z.boolean(),
        }),
      )
      .query(({ ctx }) =>
        guard(async () => {
          const c = await bank.cards.cashbackSummary(ctx.principal.userId);
          return {
            ...c,
            paid: formatAmount(c.paid),
            unpaid: formatAmount(c.unpaid),
            refused: formatAmount(c.refused),
            payments: c.payments.map((p) => ({ ...p, amount: formatAmount(p.amount) })),
          };
        }),
      ),

    // ── Getting a card (J-bank-13; BK-cissue-01 to -04) ─────────────────────

    /** The product list for a country: eligibility with its reason, the count limits, the terms, designs and speeds. */
    catalogue: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          country: z
            .string()
            .trim()
            .regex(/^[A-Za-z]{2}$/),
        }),
      )
      .output(
        z.object({
          programme: z.object({ id: z.string(), simulated: z.boolean(), displayName: z.string() }),
          network: z.string(),
          country: z.string(),
          eligible: z.boolean(),
          reason: z.string().nullable(),
          countries: z.array(z.string()),
          products: z.array(z.object({ type: z.enum(['virtual', 'physical']), held: z.number().int(), limit: z.number().int() })),
          terms: z.object({
            version: z.string(),
            text: z.string(),
            textHash: z.string(),
            acceptance: z.object({ id: z.string(), version: z.string(), acceptedAt: z.string() }).nullable(),
          }),
          designs: z.array(z.object({ id: z.string(), name: z.string() })),
          speeds: z.array(z.object({ speed: z.enum(DELIVERY_SPEEDS), days: z.number().int() })),
          deliveryCountries: z.array(z.string()),
        }),
      )
      .query(({ ctx, input }) =>
        guard(async () => {
          const c = await bank.cardOrders.catalogue(ctx.principal.userId, input.country);
          return {
            ...c,
            terms: {
              ...c.terms,
              acceptance: c.terms.acceptance ? { ...c.terms.acceptance, acceptedAt: c.terms.acceptance.acceptedAt.toISOString() } : null,
            },
          };
        }),
      ),

    /** Accept the cardholder terms shown (`consent:<userId>:<version>`); accepting again returns the first acceptance. */
    acceptTerms: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ termsVersion: z.string().min(1).max(64), textHash: z.string().min(1).max(100) }))
      .output(z.object({ id: z.string(), version: z.string(), acceptedAt: z.string() }))
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const accepted = await bank.cardOrders.acceptTerms(ctx.principal.userId, input);
          return { ...accepted, acceptedAt: accepted.acceptedAt.toISOString() };
        }),
      ),

    /**
     * Order a card: virtual (optionally single-use or n-use) or physical with a design, a delivery speed and an address.
     * `cardId` is the request, so a retry is the same card. Step-up, when the owner's rule is on, binds every term of the
     * order (`bank.step_up.cards.order`).
     */
    order: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          cardId: z.string().guid(),
          country: z
            .string()
            .trim()
            .regex(/^[A-Za-z]{2}$/),
          termsVersion: z.string().min(1).max(64),
          assetId: z.string().min(1).max(16),
          perAuthorizationLimit: amountString,
          cardType: z.enum(['virtual', 'physical']),
          usesAllowed: z.number().int().min(1).max(1000).nullable().optional(),
          designId: z.string().min(1).max(32).optional(),
          deliverySpeed: z.enum(DELIVERY_SPEEDS).optional(),
          shippingAddress: shippingAddressInput.optional(),
          stepUpApprovalId: stepUpApprovalField,
        }),
      )
      .output(cardOutput)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          if (stepUpEnforced) {
            await requireStepUp(
              ctx.principal,
              orderCardBinding({
                actor: ctx.principal.userId,
                cardId: input.cardId,
                assetId: input.assetId,
                perAuthorizationLimit: input.perAuthorizationLimit,
                cardType: input.cardType,
                country: input.country,
                termsVersion: input.termsVersion,
                usesAllowed: input.usesAllowed,
                designId: input.designId,
                deliverySpeed: input.deliverySpeed,
                shippingAddress: input.cardType === 'physical' ? shippingToken(input.shippingAddress) : '',
              }),
              input.stepUpApprovalId,
            );
          }
          if (input.cardType === 'physical' && !input.shippingAddress) {
            throw new BankError('A physical card needs a delivery address', 'bank.card_shipping_address_required');
          }
          const card = await bank.cardOrders.order({
            cardId: input.cardId,
            userId: ctx.principal.userId,
            country: input.country,
            termsVersion: input.termsVersion,
            assetId: input.assetId,
            perAuthorizationLimit: parseAmount(input.perAuthorizationLimit),
            cardType: input.cardType,
            ...(input.usesAllowed === undefined ? {} : { usesAllowed: input.usesAllowed }),
            ...(input.designId === undefined ? {} : { designId: input.designId }),
            ...(input.deliverySpeed === undefined ? {} : { deliverySpeed: input.deliverySpeed }),
            ...(input.shippingAddress === undefined ? {} : { shippingAddress: addressFrom(input.shippingAddress) }),
          });
          return presentCard(card);
        }),
      ),

    /** Captured payments a single-use or n-use card has used. */
    uses: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ cardId: z.string().guid() }))
      .output(z.object({ cardId: z.string(), usesAllowed: z.number().int().nullable(), usesMade: z.number().int() }))
      .query(({ ctx, input }) =>
        guard(async () => {
          const card = await bank.cards.card(input.cardId);
          assertSelf(ctx.principal.userId, card.userId);
          return { cardId: card.id, usesAllowed: card.usesAllowed ?? null, usesMade: await bank.cards.usesMade(card.id) };
        }),
      ),

    /** A physical card's delivery: design, speed, the estimate, state, tracking, the address and its history. */
    delivery: scopedProcedure('bank:read', { module: 'bank' })
      .input(z.object({ cardId: z.string().guid() }))
      .output(deliveryOutput)
      .query(({ ctx, input }) => guard(async () => presentDelivery(await bank.cardOrders.delivery(ctx.principal.userId, input.cardId)))),

    /** Change the delivery address before print (`ship-update:<cardId>:<requestId>`); refused once produced. */
    updateShipping: scopedProcedure('bank:write', { module: 'bank' })
      .input(
        z.object({
          cardId: z.string().guid(),
          requestId: z.string().guid(),
          address: shippingAddressInput,
          stepUpApprovalId: stepUpApprovalField,
        }),
      )
      .output(deliveryOutput)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          // Where a card goes is bound at the order; moving it later needs the same fresh confirmation when the rule is on.
          if (stepUpEnforced) {
            await requireStepUp(
              ctx.principal,
              updateCardShippingBinding({
                actor: ctx.principal.userId,
                cardId: input.cardId,
                requestId: input.requestId,
                shippingAddress: shippingToken(input.address),
              }),
              input.stepUpApprovalId,
            );
          }
          return presentDelivery(
            await bank.cardOrders.updateShipping({
              userId: ctx.principal.userId,
              cardId: input.cardId,
              requestId: input.requestId,
              address: addressFrom(input.address),
            }),
          );
        }),
      ),

    /**
     * Activate a card that arrived (BK-cissue-04). Always behind a fresh step-up: with the owner's step-up rule off this
     * refuses `bank.step_up_unavailable`, as revealing card details does, and the card stays inactive.
     */
    activate: scopedProcedure('bank:write', { module: 'bank' })
      .input(z.object({ cardId: z.string().guid(), stepUpApprovalId: stepUpApprovalField }))
      .output(cardOutput)
      .mutation(({ ctx, input }) =>
        guard(async () => {
          const card = await bank.cards.card(input.cardId);
          assertSelf(ctx.principal.userId, card.userId);
          if (!cardInactive(card)) return presentCard(card);
          if (!stepUpEnforced) {
            throw new BankError(
              'Activating a card needs a fresh confirmation that it is you, and step-up is not switched on in this deployment.',
              'bank.step_up_unavailable',
            );
          }
          await requireStepUp(
            ctx.principal,
            activateCardBinding({ actor: ctx.principal.userId, cardId: input.cardId }),
            input.stepUpApprovalId,
            false,
          );
          return presentCard(await bank.cards.activate({ cardId: input.cardId, userId: ctx.principal.userId }));
        }),
      ),

    /**
     * Every decision taken on this card, approvals and declines alike.
     *
     * The declines are the point. "Why was I declined at the till" is the
     * question a card generates, and a history that only listed successful
     * purchases could not answer it.
     */
    authorizations: scopedProcedure('bank:read', { module: 'bank' })
      .input(
        z.object({
          cardId: z.string().guid(),
          /**
           * Page size. Optional so omit reaches `bank.card_authorizations_list_limit_unset`
           * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
           */
          limit: z.number().int().min(1).max(200).optional(),
        }),
      )
      .output(
        z.array(
          z.object({
            id: z.string(),
            authorizationRef: z.string(),
            /** WHAT MOVED, in the card's funding asset. */
            amount: amountString,
            merchantCategory: z.string().nullable(),
            channel: z.enum(['card-present', 'online', 'contactless', 'atm', 'foreign']),
            decision: z.enum(['approved', 'declined']),
            declineCode: z.string().nullable(),
            status: z.string(),
            decidedAt: z.string(),
            /**
             * WHAT THE MERCHANT CHARGED, and the rate it converted at (§18).
             *
             * NULL where the card is charged in the asset it draws on — nothing
             * was converted, and rendering a rate of 1 would invent a
             * conversion that did not happen. Where it is present, the statement
             * can show the user the price they agreed at the till alongside the
             * units that actually left their balance, which is the pair a
             * converted spend is unreadable without.
             */
            conversion: z
              .object({
                settlementAssetId: z.string(),
                settlementAmount: amountString,
                rate: amountString,
                /** How the rate was derived — `MarkQuality` from the loan book. */
                rateQuality: z.string(),
                rateAsOf: z.string(),
              })
              .nullable(),
          }),
        ),
      )
      .query(async ({ ctx, input }) =>
        guard(async () => {
          // `bank:read` answers "may this principal read bank data". It never
          // answered "whose" — same guard, same reason, as `transfers.executions`.
          const card = await bank.cards.card(input.cardId);
          assertSelf(ctx.principal.userId, card.userId);
          const rows = await bank.cards.authorizationsOf(input.cardId, input.limit);
          return rows.map((a) => ({
            id: a.id,
            authorizationRef: a.authorizationRef,
            amount: formatAmount(a.amount),
            merchantCategory: a.merchantCategory,
            channel: a.channel,
            decision: a.decision,
            declineCode: a.declineCode,
            status: a.status,
            decidedAt: a.decidedAt.toISOString(),
            conversion: a.conversion
              ? {
                  settlementAssetId: a.conversion.settlementAssetId,
                  settlementAmount: formatAmount(a.conversion.settlementAmount),
                  rate: formatAmount(a.conversion.rate),
                  rateQuality: a.conversion.quality,
                  rateAsOf: a.conversion.rateAsOf.toISOString(),
                }
              : null,
          }));
        }),
      ),
  });
}
