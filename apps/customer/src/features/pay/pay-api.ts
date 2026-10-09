import { payRefusal } from './copy';
import { z, type ZodType } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { parseAmount } from '../../shared/money';
import * as s from './schemas';

/** Future session integration seam, not a claim inferred from a JWT mode or merchant KYB.
 * Only supply this from an authoritative verified company membership/merchant association.
 * Current identity has no such read; the application supplies null and refuses Business routes.
 */
export type PayBusinessAuthority = {
  verified: true;
  companyId: string;
  companyName: string;
  userId: string;
  merchantId: string;
  scopes: readonly string[];
};

/** The unresolved journal stores operation identifiers only, never balances or credentials.
 * A pending operation after a reload is uncertain. A read must prove the intended transition
 * before resolve is called. No timed retry or UI dismissal clears it.
 */
export function createPayMutationGuard(storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, requirePersistence = false) {
  const states = new Map<string, 'pending' | 'uncertain'>();
  const references = new Map<string, string>();
  function status(key: string) {
    if (states.has(key)) return states.get(key)!;
    try {
      const saved = storage?.getItem(`pay.unresolved:${key}`);
      if (saved) {
        try {
          const parsed: unknown = JSON.parse(saved);
          if (parsed && typeof parsed === 'object' && 'reference' in parsed && typeof parsed.reference === 'string')
            references.set(key, parsed.reference);
        } catch {
          /* Legacy locks contain only the status word. */
        }
        states.set(key, 'uncertain');
        return 'uncertain' as const;
      }
    } catch {
      /* The in-memory journal remains authoritative for this session. */
    }
    return null;
  }
  function resolve(key: string) {
    states.delete(key);
    references.delete(key);
    try {
      storage?.removeItem(`pay.unresolved:${key}`);
    } catch {
      /* A stale persisted lock refuses closed after reload. */
    }
  }
  async function run<T>(key: string, action: () => Promise<ApiResult<T>>, reference?: string): Promise<ApiResult<T>> {
    if (status(key)) return payRefusal('theOriginalActionHasNotBeenConfirmed', { code: 'pay.operation_unresolved', reason: 'uncertain' });
    try {
      if (requirePersistence && !storage)
        return payRefusal('deviceRecoveryStorageIsUnavailableEnableSession', {
          code: 'pay.recovery_journal_unavailable',
          reason: 'not_supported',
        });
      storage?.setItem(`pay.unresolved:${key}`, JSON.stringify({ status: 'uncertain', ...(reference ? { reference } : {}) }));
    } catch {
      if (requirePersistence)
        return payRefusal('theOriginalActionCouldNotBeRecorded', { code: 'pay.recovery_journal_unavailable', reason: 'not_supported' });
    }
    states.set(key, 'pending');
    if (reference) references.set(key, reference);
    let result: ApiResult<T>;
    try {
      result = await action();
    } catch {
      result = payRefusal('theConnectionEndedBeforeTheOutcomeWas', { code: 'pay.operation_unresolved', reason: 'uncertain' });
    }
    if (!result.ok && (result.reason === 'uncertain' || result.reason === 'aborted')) states.set(key, 'uncertain');
    else resolve(key);
    return result;
  }
  return {
    status,
    run,
    resolve,
    reference: (key: string) => {
      status(key);
      return references.get(key) ?? null;
    },
  };
}
export type PayMutationGuard = ReturnType<typeof createPayMutationGuard>;
let browserGuard: PayMutationGuard | undefined;
export function payMutationGuard() {
  if (!browserGuard) {
    let storage: Storage | undefined;
    try {
      storage = globalThis.sessionStorage;
    } catch {
      /* Read paths remain available. Writes refuse without a recovery journal. */
    }
    browserGuard = createPayMutationGuard(storage, typeof window !== 'undefined');
  }
  return browserGuard;
}

export function createPersonalPayApi(api: ApiClient, userId: string | null, guard = payMutationGuard()) {
  const signedIn = () => (userId ? null : payRefusal('signInToUseYourOwnPay', { code: 'pay.session_required', reason: 'unauthorized' }));
  async function spaces(signal?: AbortSignal) {
    const denied = signedIn();
    if (denied) return denied;
    const result = await api.query('bank', 'spaces.list', { limit: 200 }, z.array(s.spaceSchema), { signal });
    if (
      result.ok &&
      result.data.some(
        (space) =>
          space.ledgerAccount.assetId !== space.assetId ||
          (space.kind === 'primary'
            ? space.ledgerAccount.ownerType !== 'user' || space.ledgerAccount.ownerId !== userId
            : space.ledgerAccount.ownerType !== 'subaccount' || space.ledgerAccount.ownerId !== space.id),
      )
    )
      return payRefusal('theSourceAccountProjectionDoesNotMatch', { code: 'pay.source_projection_invalid', reason: 'invalid_response' });
    return result;
  }
  return {
    spaces,
    async send(input: z.infer<typeof s.sendInput>) {
      const denied = signedIn();
      if (denied) return denied;
      const parsed = s.sendInput.safeParse(input);
      if (!parsed.success) return payRefusal('invalidSendInput', { code: 'pay.input_invalid', reason: 'error' });
      if (parsed.data.toUserId === userId)
        return payRefusal('chooseAnotherRecipientAccount', { code: 'pay.recipient_self', reason: 'error' });
      const sources = await spaces();
      if (!sources.ok) return sources;
      const source = sources.data.find((space) => space.id === parsed.data.fromSpaceId);
      if (!source) return payRefusal('selectOneOfYourOwnSourceSpaces', { code: 'pay.source_invalid' });
      if (source.lockedUntil && Date.parse(source.lockedUntil) > Date.now())
        return payRefusal('thisSpaceIsLockedChooseAnUnlocked', { code: 'pay.source_locked' });
      if (parseAmount(parsed.data.amount) > parseAmount(source.balance))
        return payRefusal('theAmountExceedsTheSourceSLedger', { code: 'pay.amount_exceeds_balance', reason: 'error' });
      return guard.run(
        `${userId}:send`,
        () =>
          api.mutate(
            'bank',
            'transfers.toUser',
            parsed.data,
            s.sendOutput.refine(
              (data) => parseAmount(data.amount) === parseAmount(parsed.data.amount),
              'The confirmed amount does not match the reviewed amount',
            ),
          ),
        parsed.data.transferId,
      );
    },
    offers: (input: { asset?: string; fiatCurrency?: string; side?: 'buy' | 'sell'; limit: number }, signal?: AbortSignal) =>
      signedIn() ? Promise.resolve(signedIn()!) : api.query('p2p', 'offers.list', input, z.array(s.offerSchema), { signal }),
    offer: (offerId: string, signal?: AbortSignal) => api.query('p2p', 'offers.get', { offerId }, s.offerSchema, { signal }),
    trades: (limit: number, signal?: AbortSignal) =>
      signedIn() ? Promise.resolve(signedIn()!) : api.query('p2p', 'trades.list', { limit }, z.array(s.tradeSchema), { signal }),
    trade: (tradeId: string, signal?: AbortSignal) => api.query('p2p', 'trades.get', { tradeId }, s.tradeSchema, { signal }),
    health: (signal?: AbortSignal) => api.query('p2p', 'health', undefined, s.p2pHealthSchema, { signal }),
    fiat: (signal?: AbortSignal) => api.query('p2p', 'fiat.list', undefined, z.array(s.fiatSchema), { signal }),
    methods: (signal?: AbortSignal) => api.query('p2p', 'instruments.methods.list', { limit: 200 }, z.array(s.methodSchema), { signal }),
    instruments: (limit: number, signal?: AbortSignal) =>
      api.query('p2p', 'instruments.list', { limit }, z.array(s.instrumentSchema), { signal }),
    destination: (tradeId: string, signal?: AbortSignal) =>
      api.query('p2p', 'trades.paymentInstrument', { tradeId }, s.tradeDestinationSchema, { signal }),
    reputation: (counterparty: string, signal?: AbortSignal) =>
      api.query('p2p', 'reputation.get', { userId: counterparty }, s.reputationSchema, { signal }),
    standing: (signal?: AbortSignal) => api.query('p2p', 'merchants.me', undefined, s.p2pStandingSchema.nullable(), { signal }),
    apiAccess: (signal?: AbortSignal) => api.query('p2p', 'merchants.apiAccess', undefined, s.p2pApiAccessSchema, { signal }),
    applyProgramme: () =>
      guard.run(`${userId}:p2p-programme`, () => api.mutate('p2p', 'merchants.submitApplication', {}, s.p2pStandingSchema)),
    withdrawProgramme: (reason: string) =>
      guard.run(`${userId}:p2p-programme`, () => api.mutate('p2p', 'merchants.withdraw', { reason }, s.p2pStandingSchema)),
    dispute: (tradeId: string, signal?: AbortSignal) => api.query('p2p', 'disputes.get', { tradeId }, s.disputeSchema, { signal }),
    async manageOffer(offerId: string, action: 'pause' | 'resume' | 'close') {
      const denied = signedIn();
      if (denied) return denied;
      const latest = await api.query('p2p', 'offers.get', { offerId }, s.offerSchema);
      if (!latest.ok) return latest;
      if (latest.data.makerId !== userId) return payRefusal('onlyTheOfferSMakerCanManage', { code: 'pay.offer_not_owned' });
      return guard.run(`${userId}:offer:${offerId}`, () => api.mutate('p2p', `offers.${action}`, { offerId }, s.offerSchema), action);
    },
    async manageTrade(tradeId: string, action: 'markFiatSent' | 'confirmReceived' | 'cancel', reason?: string) {
      const denied = signedIn();
      if (denied) return denied;
      const latest = await api.query('p2p', 'trades.get', { tradeId }, s.tradeSchema);
      if (!latest.ok) return latest;
      const trade = latest.data;
      if (trade.buyerId !== userId && trade.sellerId !== userId)
        return payRefusal('thisOrderBelongsToAnotherAccount', { code: 'pay.trade_not_owned' });
      if (action === 'markFiatSent' && (trade.buyerId !== userId || trade.status !== 'escrowed'))
        return payRefusal('onlyTheBuyerOfAnEscrowedOrder', { code: 'pay.trade_action_invalid' });
      if (action === 'confirmReceived' && (trade.sellerId !== userId || trade.status !== 'fiat_sent'))
        return payRefusal('releaseRequiresTheSellerToConfirmAn', { code: 'pay.trade_action_invalid' });
      if (action === 'cancel' && !['created', 'escrowed'].includes(trade.status))
        return payRefusal('thisOrderCannotBeCancelledInIts', { code: 'pay.trade_action_invalid' });
      return guard.run(
        `${userId}:trade:${tradeId}`,
        () => api.mutate('p2p', `trades.${action}`, { tradeId, ...(action === 'cancel' && reason ? { reason } : {}) }, s.tradeSchema),
        action,
      );
    },
    async reconcileTrade(tradeId: string) {
      const denied = signedIn();
      if (denied) return denied;
      const key = `${userId}:trade:${tradeId}`;
      const action = guard.reference(key);
      const latest = await api.query('p2p', 'trades.get', { tradeId }, s.tradeSchema);
      if (!latest.ok) return latest;
      const trade = latest.data;
      if (trade.buyerId !== userId && trade.sellerId !== userId)
        return payRefusal('thisOrderBelongsToAnotherAccount', { code: 'pay.trade_not_owned' });
      const confirmed =
        action === 'markFiatSent'
          ? ['fiat_sent', 'disputed', 'released', 'cancelled'].includes(trade.status)
          : action === 'confirmReceived'
            ? trade.status === 'released' && trade.settledAt !== null
            : action === 'cancel'
              ? trade.status === 'cancelled' && trade.settledAt !== null
              : false;
      if (!confirmed)
        return payRefusal('theOriginalOrderActionIsStillUnresolved', { code: 'pay.operation_unresolved', reason: 'uncertain' });
      guard.resolve(key);
      return latest;
    },
    async reconcileOffer(offerId: string) {
      const key = `${userId}:offer:${offerId}`;
      const action = guard.reference(key);
      const latest = await api.query('p2p', 'offers.get', { offerId }, s.offerSchema);
      if (!latest.ok) return latest;
      if (latest.data.makerId !== userId) return payRefusal('onlyTheOfferSMakerCanManage', { code: 'pay.offer_not_owned' });
      const expected = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : action === 'close' ? 'closed' : null;
      if (!expected || latest.data.status !== expected)
        return payRefusal('theOriginalOfferActionHasNotBeen', { code: 'pay.operation_unresolved', reason: 'uncertain' });
      guard.resolve(key);
      return latest;
    },
    openDispute: (tradeId: string, reason: string) =>
      guard.run(`${userId}:dispute:${tradeId}`, () => api.mutate('p2p', 'disputes.open', { tradeId, reason }, s.disputeOpenedSchema)),
    appendEvidence: (tradeId: string, evidence: string) =>
      guard.run(`${userId}:evidence:${tradeId}`, () =>
        api.mutate(
          'p2p',
          'disputes.appendEvidence',
          { tradeId, evidence: [evidence] },
          z.object({ disputeId: s.id, tradeId: s.id, evidence: s.disputeSchema.shape.evidence }),
        ),
      ),
    removeInstrument: (instrumentId: string) =>
      guard.run(`${userId}:instrument:${instrumentId}`, () =>
        api.mutate('p2p', 'instruments.remove', { instrumentId }, s.instrumentSchema),
      ),
    guard,
  };
}
export type PersonalPayApi = ReturnType<typeof createPersonalPayApi>;

export function createBusinessPayApi(
  api: ApiClient,
  userId: string | null,
  authority: PayBusinessAuthority | null,
  guard = payMutationGuard(),
) {
  function access(scope: string) {
    if (!authority || !authority.verified || !authority.companyId || !authority.companyName || authority.userId !== userId || !userId)
      return payRefusal('aVerifiedBusinessAccountAndCompanyMembership', { code: 'pay.business_authority_missing' });
    if (!authority.scopes.includes(scope))
      return payRefusal('thisBusinessAccountDoesNotHoldPermission', { code: 'pay.business_permission_missing' }, { scope: scope });
    return null;
  }
  async function merchant(signal?: AbortSignal) {
    const denied = access('pay:read');
    if (denied) return denied;
    const result = await api.query('pay', 'merchant.me', undefined, s.merchantSchema.nullable(), { signal });
    if (!result.ok) return result;
    if (!result.data || result.data.id !== authority!.merchantId || result.data.userId !== userId)
      return payRefusal('theMerchantRecordDoesNotMatchThe', { code: 'pay.business_merchant_mismatch' });
    if (result.data.status !== 'active' || result.data.kybStatus !== 'approved')
      return payRefusal('theMerchantMustBeActiveAndIts', { code: 'pay.business_merchant_inactive' });
    return { ok: true as const, data: result.data };
  }
  async function query<T>(procedure: string, input: unknown, schema: ZodType<T>, signal?: AbortSignal): Promise<ApiResult<T>> {
    const checked = await merchant(signal);
    if (!checked.ok) return checked;
    const result = await api.query('pay', procedure, input, schema, { signal });
    if (result.ok) {
      const rows: unknown[] = Array.isArray(result.data) ? result.data : [result.data];
      if (rows.some((row) => row && typeof row === 'object' && 'merchantId' in row && row.merchantId !== authority!.merchantId))
        return payRefusal('theReturnedRecordBelongsToAnotherMerchant', {
          code: 'pay.merchant_projection_mismatch',
          reason: 'invalid_response',
        });
    }
    return result;
  }
  async function mutate<T>(
    procedure: string,
    input: unknown,
    schema: ZodType<T>,
    scope: 'pay:write' | 'pay:refund' | 'pay:payout',
    operation: string,
  ): Promise<ApiResult<T>> {
    const denied = access(scope);
    if (denied) return denied;
    const checked = await merchant();
    if (!checked.ok) return checked;
    return guard.run(`${userId}:${operation}`, () =>
      api.mutate(
        'pay',
        procedure,
        input,
        schema.refine(
          (data) => !data || typeof data !== 'object' || !('merchantId' in data) || data.merchantId === authority!.merchantId,
          'The mutation outcome belongs to another merchant.',
        ),
      ),
    );
  }
  return {
    merchant,
    query,
    mutate,
    access,
    guard,
    authority,
    async keys(signal?: AbortSignal) {
      const checked = await merchant(signal);
      if (!checked.ok) return checked;
      return api.query('identity', 'apiKeys.list', { limit: 200 }, z.array(s.keySchema), { signal });
    },
    async createSandboxKey(name: string, scopes: string[]) {
      const denied = access('pay:read');
      if (denied) return denied;
      if (
        !name.trim() ||
        !scopes.length ||
        scopes.some((scope) => !authority!.scopes.includes(scope) || !['pay:read', 'pay:write', 'pay:refund'].includes(scope))
      )
        return payRefusal('chooseOnlyPayPermissionsHeldByThis', { code: 'pay.key_permission_invalid' });
      const checked = await merchant();
      if (!checked.ok) return checked;
      return guard.run(`${userId}:sandbox-key-create`, () =>
        api.mutate(
          'identity',
          'apiKeys.create',
          { name, scopes, mode: 'sandbox' },
          z.object({ id: z.string(), key: z.string(), prefix: z.string(), mode: z.literal('sandbox') }),
        ),
      );
    },
    async revokeKey(keyId: string) {
      const checked = await merchant();
      if (!checked.ok) return checked;
      return guard.run(`${userId}:key:${keyId}`, () =>
        api.mutate('identity', 'apiKeys.revoke', { keyId }, z.object({ revoked: z.boolean() })),
      );
    },
    async webhookEndpoints(signal?: AbortSignal) {
      const checked = await merchant(signal);
      if (!checked.ok) return checked;
      const queryString = new URLSearchParams({ merchantId: authority!.merchantId, limit: '200' });
      return api.plain('pay', `/v1/webhook-endpoints?${queryString}`, z.array(s.webhookSchema), { signal });
    },
    async webhookDeliveries(signal?: AbortSignal) {
      const checked = await merchant(signal);
      if (!checked.ok) return checked;
      const queryString = new URLSearchParams({ merchantId: authority!.merchantId, limit: '200' });
      return api.plain('pay', `/v1/webhook-deliveries?${queryString}`, z.array(s.webhookDeliverySchema), { signal });
    },
    async registerWebhook(url: string, idempotencyKey: string) {
      const denied = access('pay:write');
      if (denied) return denied;
      const checked = await merchant();
      if (!checked.ok) return checked;
      const parsed = z
        .string()
        .url()
        .refine((value) => {
          const address = new URL(value);
          return (
            !address.username &&
            !address.password &&
            (address.protocol === 'https:' ||
              (address.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)))
          );
        }, 'Use HTTPS or a localhost development URL with no embedded credentials.')
        .safeParse(url);
      if (!parsed.success) return payRefusal('invalidWebhookUrl', { code: 'pay.webhook_url_invalid', reason: 'error' });
      return guard.run(`${userId}:webhook-create`, () =>
        api.scopedRest('pay', '/v1/webhook-endpoints', s.webhookSchema.extend({ secret: z.string() }), {
          method: 'POST',
          body: { merchantId: authority!.merchantId, url: parsed.data },
          idempotencyKey,
        }),
      );
    },
    async manageWebhook(endpointId: string, action: 'disable' | 'enable', idempotencyKey: string) {
      const denied = access('pay:write');
      if (denied) return denied;
      const checked = await merchant();
      if (!checked.ok) return checked;
      return action === 'disable'
        ? guard.run(`${userId}:webhook:${endpointId}`, () =>
            api.scopedRest('pay', `/v1/webhook-endpoints/${encodeURIComponent(endpointId)}`, z.object({ disabled: z.boolean() }), {
              method: 'DELETE',
              query: { merchantId: authority!.merchantId },
            }),
          )
        : guard.run(`${userId}:webhook:${endpointId}`, () =>
            api.scopedRest('pay', `/v1/webhook-endpoints/${encodeURIComponent(endpointId)}/enable`, s.webhookSchema, {
              method: 'POST',
              query: { merchantId: authority!.merchantId },
              idempotencyKey,
            }),
          );
    },
  };
}
export type BusinessPayApi = ReturnType<typeof createBusinessPayApi>;

export function createCheckoutApi(api: ApiClient, guard = payMutationGuard()) {
  return {
    resolve: (token: string, signal?: AbortSignal) => api.query('pay', 'resolveLink', { token }, s.resolvedLinkSchema, { signal }),
    status: (sessionToken: string, signal?: AbortSignal) =>
      api.query('pay', 'checkout.status', { sessionToken }, s.checkoutSchema, { signal }),
    async open(
      link: z.infer<typeof s.resolvedLinkSchema>,
      token: string,
      input: { geoCountry: string; method: string; amount?: string; assetId?: string },
    ) {
      const parsed = z
        .object({
          token: z.string().min(8).max(200),
          geoCountry: z.string().length(2),
          method: z.enum(['card', 'crypto']),
          amount: s.positiveAmount.optional(),
          assetId: s.asset.optional(),
        })
        .safeParse({
          token,
          geoCountry: input.geoCountry,
          method: input.method,
          ...(link.amount === null ? { amount: input.amount } : {}),
          ...(link.currency === null ? { assetId: input.assetId } : {}),
        });
      if (!parsed.success || (link.amount === null && !parsed.data?.amount) || (link.currency === null && !parsed.data?.assetId))
        return payRefusal('enterTheRequiredCountryPaymentMethodAmount', { code: 'pay.checkout_input_invalid', reason: 'error' });
      return guard.run('checkout:open', () =>
        api.mutate('pay', 'checkout.open', parsed.data, z.object({ sessionToken: z.string().min(8).max(200), session: s.checkoutSchema })),
      );
    },
    guard,
  };
}
