import { z } from 'zod';
import { router, scopedProcedure } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { CardRecord } from '../cards/card-service.js';
import { assertSelf } from '../assert-self.js';
import {
  issueCardBinding,
  revealCardBinding,
  revealCardPinBinding,
  setCardLimitsBinding,
  setCardPinBinding,
  unfreezeCardBinding,
} from '../step-up/money-out-fields.js';
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
  const cardOutput = z.object({
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
    status: z.enum(['active', 'frozen', 'closed']),
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
  });

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

  function presentCard(c: CardRecord) {
    return {
      id: c.id,
      assetId: c.assetId,
      settlementAssetId: c.settlementAssetId,
      issuer: c.issuer,
      simulated: c.simulated,
      panTail: c.panTail,
      status: c.status,
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
          const updated = await bank.cards.setStatus(input.cardId, input.status);
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
          return presentCard(replaced);
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
