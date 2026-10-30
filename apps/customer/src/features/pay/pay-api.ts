import { payRefusal } from './copy';
import { z, type ZodType } from 'zod';
import type { ApiClient, ApiResult } from '../../shared/api';
import { parseAmount } from '../../shared/money';
import { createMoneyClient } from '../money/client';
import { createMerchantRefundApi } from './merchant-refund-api';
import * as s from './schemas';
import { shareCopy } from './personal/p2p-share-copy';
import {
  isOwnOffer,
  quoteIsConsistent,
  sameQuoteFigures,
  sameTakeTerms,
  takeRefusalIsDefinite,
  tradeMatchesTake,
  type TakeRequest,
} from './personal/p2p-model';
import {
  createMinimalOriginalJournal,
  type JournalPorts,
  type JournalProblem,
  type JournalStorage,
  type JournalLocks,
} from '../../shared/minimal-original-journal';

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
  /**
   * Money scopes this person may obtain by confirming it's them just before the call (`portal/access/step-up.ts`).
   * They are not held, so they are never offered to API keys; `access()` admits them because the confirmation comes
   * first and the service checks the scope on the call itself.
   */
  confirmable?: readonly ('pay:refund' | 'pay:payout')[];
};

type PayOriginal = { status: 'uncertain'; reference?: string; path?: string; priceId?: string };
function decodePayOriginal(raw: string): PayOriginal {
  if (raw === 'pending' || raw === 'uncertain') return { status: 'uncertain' };
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid Pay original');
  const value = parsed as Record<string, unknown>;
  if (
    value.status !== 'uncertain' ||
    Object.keys(value).some((key) => !['status', 'reference', 'path', 'priceId'].includes(key)) ||
    ('path' in value && !['crypto_invoice', 'card', 'card_mandate'].includes(value.path as string)) ||
    ('priceId' in value && !s.id.safeParse(value.priceId).success) ||
    ('reference' in value && (typeof value.reference !== 'string' || !value.reference || value.reference.length > 200))
  )
    throw new Error('Invalid Pay original');
  return value as PayOriginal;
}

/** Explicit isolated adapters keep non-browser contract tests independent of browser globals.
 * Production always supplies durable storage and native Web Locks, without a fallback.
 */
function isolatedPorts(storage?: JournalStorage): JournalPorts {
  const values = new Map<string, string>();
  const held = new Set<string>();
  const durable = storage ?? {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  return {
    durable: () => durable,
    locks: () =>
      ({
        request: async (name: string, _options: unknown, work: (lock: unknown) => unknown) => {
          if (held.has(name)) return work(null);
          held.add(name);
          try {
            return await work({ name });
          } finally {
            held.delete(name);
          }
        },
      }) as JournalLocks,
  };
}

/** The durable journal contains original operation references only. Every admission reads
 * it again under a native cross-tab lock. Feature-specific evidence owns exact cleanup.
 */
export function createPayMutationGuard(storage?: JournalStorage, requirePersistence = false, suppliedPorts?: JournalPorts) {
  const ports =
    suppliedPorts ?? (requirePersistence ? { durable: () => storage, locks: () => globalThis.navigator?.locks } : isolatedPorts(storage));
  const journals = new Map<string, ReturnType<typeof createMinimalOriginalJournal<PayOriginal>>>();
  const states = new Map<string, { raw: string; status: 'pending' | 'uncertain'; run: object }>();
  const problems = new Map<string, JournalProblem>();
  const known = new Map<string, { raw: string; current: () => boolean; confirmed: boolean }>();
  const journal = (key: string) => {
    if (!journals.has(key)) journals.set(key, createMinimalOriginalJournal(`pay.unresolved:${key}`, decodePayOriginal, ports));
    return journals.get(key)!;
  };
  function inspect(key: string) {
    const original = journal(key).read();
    if (original.status === 'unreadable') problems.set(key, original.reason);
    else if (original.status === 'empty' && states.has(key)) problems.set(key, 'mismatch');
    return original;
  }
  function status(key: string) {
    const original = inspect(key);
    if (original.status === 'unreadable' || problems.has(key)) return 'uncertain' as const;
    if (original.status === 'present') return states.get(key)?.raw === original.raw ? states.get(key)!.status : ('uncertain' as const);
    return null;
  }
  const unavailable = (key: string, reason: JournalProblem) => {
    problems.set(key, reason);
    return payRefusal(key.endsWith(':send') ? 'recoveryStorageBody' : 'deviceRecoveryStorageIsUnavailableEnableSession', {
      code: 'pay.recovery_journal_unavailable',
      reason: 'not_supported',
    });
  };
  async function restore(key: string) {
    const original = journal(key).read();
    if (original.status === 'unreadable') return unavailable(key, original.reason);
    // Reading a durable original does not require acquiring the dispatch lease.
    // Returning during an in-flight original must still show its readable reference.
    if (original.status === 'present' && original.origin === 'durable') {
      problems.delete(key);
      return { ok: true as const, data: null };
    }
    const result = await journal(key).coordinate(async (lease) => lease.migrateLegacy());
    if (!result.ok && result.reason === 'busy') {
      const returned = journal(key).read();
      if (returned.status === 'empty' && !states.has(key)) {
        // An overlapping restoration has no original to migrate. Review is a
        // read path; run still requires its own native lock before admission.
        problems.delete(key);
        return { ok: true as const, data: null };
      }
    }
    if (!result.ok) return unavailable(key, result.reason);
    if (!result.value.ok) return unavailable(key, result.value.reason);
    problems.delete(key);
    inspect(key);
    return { ok: true as const, data: null };
  }
  async function resolve(key: string, originalRaw: string | null) {
    if (originalRaw === null) return false;
    const result = await journal(key).coordinate(async (lease) => lease.finishExact(originalRaw));
    if (!result.ok || !result.value.ok) {
      problems.set(key, !result.ok ? result.reason : !result.value.ok ? result.value.reason : 'mismatch');
      return false;
    }
    if (states.get(key)?.raw === originalRaw) states.delete(key);
    if (known.get(key)?.raw === originalRaw) known.delete(key);
    problems.delete(key);
    return true;
  }
  async function cleanupKnown(key: string, isCurrent: () => boolean, expectedOriginal: object | null) {
    const original = known.get(key);
    if (!original || original !== expectedOriginal || !original.current() || !isCurrent()) return false;
    const result = await journal(key).coordinate(async (lease) => {
      if (known.get(key) !== original || !original.current() || !isCurrent()) return { ok: false as const, reason: 'inactive' as const };
      // A failed readback may follow a successful removal. Verify fresh empty
      // storage without deleting anything; only this current known proof can release RAM.
      const saved = lease.read();
      if (saved.status === 'empty') return { ok: true as const };
      return lease.finishExact(original.raw);
    });
    if (!result.ok || !result.value.ok) {
      problems.set(key, !result.ok ? result.reason : !result.value.ok ? result.value.reason : 'mismatch');
      return false;
    }
    if (known.get(key) === original) known.delete(key);
    if (states.get(key)?.raw === original.raw) states.delete(key);
    problems.delete(key);
    return true;
  }
  async function run<T>(
    key: string,
    action: () => Promise<ApiResult<T>>,
    reference?: string,
    isCurrent?: () => boolean,
    recoveryCurrent = isCurrent ?? (() => true),
    recovery?: { path?: string; priceId?: string },
  ): Promise<ApiResult<T>> {
    if (isCurrent && !isCurrent()) return sendContextChanged();
    const coordinated = await journal(key).coordinate(async (lease): Promise<ApiResult<T>> => {
      if (isCurrent && !isCurrent()) return sendContextChanged();
      const migrated = lease.migrateLegacy();
      if (!migrated.ok) return unavailable(key, migrated.reason);
      const original = lease.read();
      if (original.status === 'unreadable') return unavailable(key, original.reason);
      if (original.status === 'present' || states.has(key))
        return payRefusal('theOriginalActionHasNotBeenConfirmed', { code: 'pay.operation_unresolved', reason: 'uncertain' });
      const record = JSON.stringify({
        status: 'uncertain',
        ...(reference ? { reference } : {}),
        ...(recovery?.path ? { path: recovery.path } : {}),
        ...(recovery?.priceId ? { priceId: recovery.priceId } : {}),
      });
      const saved = lease.writeExact(null, record);
      if (!saved.ok) return unavailable(key, saved.reason);
      if (isCurrent && !isCurrent()) {
        const discarded = lease.finishExact(record);
        if (!discarded.ok) problems.set(key, discarded.reason);
        return sendContextChanged();
      }
      const run = {};
      states.set(key, { raw: record, status: 'pending', run });
      let result: ApiResult<T>;
      try {
        result = await action();
      } catch {
        result = payRefusal('theConnectionEndedBeforeTheOutcomeWas', { code: 'pay.operation_unresolved', reason: 'uncertain' });
      }
      if (states.get(key)?.run !== run) return sendContextChanged();
      states.set(key, { raw: record, status: 'uncertain', run });
      if (isCurrent && !isCurrent()) return sendContextChanged();
      if (!result.ok && (result.reason === 'uncertain' || result.reason === 'aborted')) return result;
      // A known original reply stays known even when local cleanup fails. Its RAM
      // proof is bound to the originating owner/context and never replays the POST.
      known.set(key, { raw: record, current: recoveryCurrent, confirmed: result.ok });
      const cleared = lease.finishExact(record);
      if (cleared.ok) {
        states.delete(key);
        known.delete(key);
        problems.delete(key);
      } else problems.set(key, cleared.reason);
      return result;
    });
    return coordinated.ok ? coordinated.value : unavailable(key, coordinated.reason);
  }
  async function checkOriginal<T>(
    key: string,
    prove: (original: PayOriginal) => Promise<ApiResult<T>>,
    isCurrent: () => boolean,
  ): Promise<ApiResult<T>> {
    const departed = () =>
      payRefusal('theOriginalActionHasNotBeenConfirmed', {
        code: 'pay.reconciliation_context_changed',
        reason: 'aborted',
      });
    if (!isCurrent()) return departed();
    const result = await journal(key).coordinate(async (lease): Promise<ApiResult<T>> => {
      if (!isCurrent()) return departed();
      const migrated = lease.migrateLegacy();
      if (!migrated.ok) return unavailable(key, migrated.reason);
      const original = lease.read();
      if (original.status === 'unreadable') return unavailable(key, original.reason);
      if (original.status !== 'present')
        return payRefusal('theOriginalActionHasNotBeenConfirmed', { code: 'pay.operation_unresolved', reason: 'uncertain' });
      // Hold this original's admission lease through its feature-owned GET/proof.
      // A paused offer can resume then pause again with identical legacy bytes;
      // an earlier read must never settle that replacement original.
      const confirmed = await prove(original.value);
      if (!isCurrent()) return departed();
      if (!confirmed.ok) return confirmed;
      known.set(key, { raw: original.raw, current: isCurrent, confirmed: true });
      const cleared = lease.finishExact(original.raw);
      if (cleared.ok) {
        states.delete(key);
        known.delete(key);
        problems.delete(key);
      } else problems.set(key, cleared.reason);
      return confirmed;
    });
    if (result.ok) return result.value;
    if (result.reason === 'busy')
      return payRefusal('theOriginalActionHasNotBeenConfirmed', { code: 'pay.reconciliation_in_progress', reason: 'uncertain' });
    return unavailable(key, result.reason);
  }
  return {
    status,
    run,
    resolve,
    restore,
    cleanupKnown,
    checkOriginal,
    problem: (key: string) => {
      inspect(key);
      return problems.get(key) ?? null;
    },
    knownCleanup: (key: string) => {
      const original = known.get(key);
      return Boolean(original?.current());
    },
    knownProof: (key: string): object | null => {
      const original = known.get(key);
      return original?.current() ? original : null;
    },
    knownConfirmed: (key: string) => {
      const original = known.get(key);
      return Boolean(original?.current() && original.confirmed);
    },
    original: (key: string) => {
      const original = inspect(key);
      return original.status === 'present' ? original : null;
    },
    references: (key: string) => {
      const original = inspect(key);
      return original.status === 'present'
        ? [original.value.reference].filter((value): value is string => Boolean(value))
        : original.status === 'unreadable'
          ? (original.originals ?? []).flatMap((entry) => (entry.value.reference ? [entry.value.reference] : []))
          : [];
    },
    reference: (key: string) => {
      const original = inspect(key);
      return original.status === 'present' ? (original.value.reference ?? null) : null;
    },
  };
}
export type PayMutationGuard = ReturnType<typeof createPayMutationGuard>;
let browserGuard: PayMutationGuard | undefined;
export function payMutationGuard() {
  if (!browserGuard)
    browserGuard = createPayMutationGuard(undefined, true, {
      durable: () => globalThis.localStorage,
      legacy: () => globalThis.sessionStorage,
      locks: () => globalThis.navigator?.locks,
    });
  return browserGuard;
}

function sendContextChanged() {
  return payRefusal('theOriginalActionHasNotBeenConfirmed', { code: 'pay.send_context_changed', reason: 'aborted' });
}

/** Only the service's own "no such order" answer. A bare 404 (a route that is not mounted) proves nothing about the order. */
const isTradeAbsent = (result: { code?: string }) => result.code === 'p2p.trade_not_found';

const placedUnderHeld = new WeakSet<object>();
/**
 * True for an order that a resend placed for the first time under the reference held from the earlier attempt, as
 * opposed to one the service already had. The screen tells the two apart in words.
 */
export function wasPlacedUnderHeldReference(trade: object): boolean {
  return placedUnderHeld.has(trade);
}

/** A refusal this module makes itself. The screen picks the words from `code`; this text is only a fallback. */
function takeRefusal(code: string, reason: Extract<ApiResult<never>, { ok: false }>['reason']): Extract<ApiResult<never>, { ok: false }> {
  return { ok: false, reason, message: 'The order was not placed.', code };
}

/** The most paused ads My offers lists (svc-p2p's page maximum); the room says when there may be more. */
export const PAUSED_OFFERS_SHOWN = 200;
/** P-ads-merchant-07: a share token as svc-p2p makes it. */
const SHARE_TOKEN = /^[A-Za-z0-9_-]{32}$/;

/**
 * P-ads-merchant-07: a private ad without a link, or a link that ended or was withdrawn, in plain words rather than the
 * service's own reply.
 */
function shareLinkRefusal<T>(result: ApiResult<T>): ApiResult<T> {
  if (result.ok) return result;
  const key =
    result.code === 'p2p.offer_private'
      ? 'linkPrivate'
      : result.code === 'p2p.share_link_expired'
        ? 'linkExpired'
        : result.code === 'p2p.share_link_revoked'
          ? 'linkRevoked'
          : null;
  return key ? { ...result, message: shareCopy.t(key) } : result;
}

/** P-ads-merchant-06: closed ads My Ads lists, most recently closed first. */
/** P-ads-merchant-08: how many to-do items the console reads at once (svc-p2p's most is 200). */
export const TODOS_SHOWN = 100;
export const CLOSED_OFFERS_SHOWN = 50;

export function createPersonalPayApi(
  api: ApiClient,
  userId: string | null,
  guard = payMutationGuard(),
  p2pCurrent: () => boolean = () => api.canWrite(),
) {
  const signedIn = () => (userId ? null : payRefusal('signInToUseYourOwnPay', { code: 'pay.session_required', reason: 'unauthorized' }));
  // P-ads-merchant-07: the share link each ad was opened by, so its reads, quotes and take reach a private ad.
  const shareTokens = new Map<string, string>();
  const shareOf = (offerId: string) => {
    const token = shareTokens.get(offerId.toLowerCase());
    return token ? { shareToken: token } : {};
  };
  const p2pDeparted = () => payRefusal('p2pViewChanged', { code: 'pay.p2p_view_changed', reason: 'aborted' });
  async function currentTrade(tradeId: string, signal?: AbortSignal) {
    const denied = signedIn();
    if (denied) return denied;
    if (!p2pCurrent()) return p2pDeparted();
    const result = await api.query('p2p', 'trades.get', { tradeId }, s.tradeSchema, { signal });
    if (!p2pCurrent()) return p2pDeparted();
    if (!result.ok) return result;
    if (result.data.id.toLowerCase() !== tradeId.toLowerCase())
      return payRefusal('p2pProjectionMismatch', { code: 'pay.trade_projection_invalid', reason: 'invalid_response' });
    if (result.data.buyerId !== userId && result.data.sellerId !== userId)
      return payRefusal('thisOrderBelongsToAnotherAccount', { code: 'pay.trade_not_owned' });
    return result;
  }
  const sameImmutableTerms = (a: s.Trade, b: s.Trade) =>
    a.id.toLowerCase() === b.id.toLowerCase() &&
    a.offerId.toLowerCase() === b.offerId.toLowerCase() &&
    a.sellerId === b.sellerId &&
    a.buyerId === b.buyerId &&
    a.asset === b.asset &&
    a.fiatCurrency === b.fiatCurrency &&
    a.method === b.method &&
    parseAmount(a.amount) === parseAmount(b.amount) &&
    parseAmount(a.fiatAmount) === parseAmount(b.fiatAmount) &&
    parseAmount(a.price) === parseAmount(b.price) &&
    // Only `trades.get` carries the ad's terms: two readings that both have them must agree.
    (a.terms === undefined || b.terms === undefined || a.terms === b.terms) &&
    // The fee rate is frozen at take too: two readings that both carry it must agree.
    (a.feeBps === undefined || b.feeBps === undefined || a.feeBps === b.feeBps);
  const sameTerms = (a: s.Trade, b: s.Trade) => sameImmutableTerms(a, b) && a.status === b.status && a.deadlineAt === b.deadlineAt;
  async function currentOffer(offerId: string, signal?: AbortSignal) {
    const denied = signedIn();
    if (denied) return denied;
    if (!p2pCurrent()) return p2pDeparted();
    const result = shareLinkRefusal(await api.query('p2p', 'offers.get', { offerId, ...shareOf(offerId) }, s.offerSchema, { signal }));
    if (!p2pCurrent()) return p2pDeparted();
    if (result.ok && result.data.id.toLowerCase() !== offerId.toLowerCase())
      return payRefusal('p2pOfferProjectionMismatch', { code: 'pay.offer_projection_invalid', reason: 'invalid_response' });
    return result;
  }
  const sameOfferTerms = (a: s.Offer, b: s.Offer) =>
    a.id.toLowerCase() === b.id.toLowerCase() &&
    a.makerId === b.makerId &&
    a.side === b.side &&
    a.asset === b.asset &&
    a.fiatCurrency === b.fiatCurrency &&
    a.priceType === b.priceType &&
    parseAmount(a.price) === parseAmount(b.price) &&
    parseAmount(a.minAmount) === parseAmount(b.minAmount) &&
    parseAmount(a.maxAmount) === parseAmount(b.maxAmount) &&
    parseAmount(a.remainingAmount) === parseAmount(b.remainingAmount) &&
    a.status === b.status &&
    a.terms === b.terms &&
    JSON.stringify(a.methods) === JSON.stringify(b.methods);
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
    /** Published limits and fee for this send. Refuses `bank.personal_transfer_terms_unset` while none are published. */
    quote: (input: { assetId: string; amount: string }, signal?: AbortSignal) =>
      signedIn() ? Promise.resolve(signedIn()!) : api.query('bank', 'transfers.quote', input, s.transferQuoteSchema, { signal }),
    async send(input: z.infer<typeof s.sendInput>, isCurrent?: () => boolean, recoveryCurrent?: () => boolean) {
      if (isCurrent && !isCurrent()) return sendContextChanged();
      const denied = signedIn();
      if (denied) return denied;
      const key = `${userId}:send`;
      if (guard.status(key))
        return guard.problem(key)
          ? payRefusal('recoveryStorageBody', { code: 'pay.recovery_journal_unavailable', reason: 'not_supported' })
          : payRefusal('theOriginalActionHasNotBeenConfirmed', { code: 'pay.operation_unresolved', reason: 'uncertain' });
      const parsed = s.sendInput.safeParse(input);
      if (!parsed.success) return payRefusal('invalidSendInput', { code: 'pay.input_invalid', reason: 'error' });
      if (parsed.data.toUserId === userId)
        return payRefusal('chooseAnotherRecipientAccount', { code: 'pay.recipient_self', reason: 'error' });
      const sources = await spaces();
      if (isCurrent && !isCurrent()) return sendContextChanged();
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
        isCurrent,
        recoveryCurrent,
      );
    },
    offers: (input: { asset?: string; fiatCurrency?: string; side?: 'buy' | 'sell'; limit: number }, signal?: AbortSignal) =>
      signedIn() ? Promise.resolve(signedIn()!) : api.query('p2p', 'offers.list', input, z.array(s.offerSchema), { signal }),
    /** One board page, filtered and sorted by the service; `cursor` continues the previous page under the same query. */
    offerPage: (input: s.BoardQuery & { makerId?: string; limit: number; cursor?: string | null }, signal?: AbortSignal) =>
      signedIn() ? Promise.resolve(signedIn()!) : api.query('p2p', 'offers.page', input, s.offerPageSchema, { signal }),
    offer: currentOffer,
    trade: currentTrade,
    /** One page of the order list: `tab` narrows it, `cursor` continues from the previous page's `nextCursor`. */
    orderPage: ({ tab, cursor, limit }: { limit: number; tab?: s.OrderTab; cursor?: string | null }, signal?: AbortSignal) =>
      signedIn()
        ? Promise.resolve(signedIn()!)
        : api.query('p2p', 'trades.page', { limit, ...(tab ? { tab } : {}), ...(cursor ? { cursor } : {}) }, s.orderPageSchema, {
            signal,
          }),
    /** The caller's orders created in [from, to] as the service's CSV; a range or row count over the owner cap refuses. */
    exportOrders: (range: { from: string; to: string }, signal?: AbortSignal) =>
      signedIn()
        ? Promise.resolve(signedIn()!)
        : api.query('p2p', 'trades.export', { ...range, format: 'csv' }, s.orderExportSchema, { signal }),
    /** A receipt for one released order. Each call spends one download of the owner quotas, so it is a write. */
    receipt: (tradeId: string) =>
      signedIn() ? Promise.resolve(signedIn()!) : api.mutate('p2p', 'trades.receipt', { tradeId }, s.orderReceiptSchema),
    /** This order's review by the caller and the visible one about them (svc-p2p `reviews.forTrade`, parties only). */
    orderReviews: (tradeId: string, signal?: AbortSignal) =>
      signedIn() ? Promise.resolve(signedIn()!) : api.query('p2p', 'reviews.forTrade', { tradeId }, s.tradeReviewsSchema, { signal }),
    /** One review per party of a released order; a second leave returns the first, unchanged. A bad one needs an explanation. */
    leaveReview: (input: { tradeId: string; rating: 'good' | 'bad'; comment?: string; explanation?: string }) =>
      signedIn() ? Promise.resolve(signedIn()!) : api.mutate('p2p', 'reviews.leave', input, s.orderReviewSchema),
    /** Rewrite one's own review inside the owner's edit window; a blank window, or one with a reply or a hide, refuses. */
    editReview: (input: { tradeId: string; rating: 'good' | 'bad'; comment?: string; explanation?: string }) =>
      signedIn() ? Promise.resolve(signedIn()!) : api.mutate('p2p', 'reviews.edit', input, s.orderReviewSchema),
    /** One reply from the person a review is about. */
    replyReview: (input: { tradeId: string; text: string }) =>
      signedIn() ? Promise.resolve(signedIn()!) : api.mutate('p2p', 'reviews.reply', input, s.orderReviewSchema),
    health: (signal?: AbortSignal) => api.query('p2p', 'health', undefined, s.p2pHealthSchema, { signal }),
    fiat: (signal?: AbortSignal) => api.query('p2p', 'fiat.list', undefined, z.array(s.fiatSchema), { signal }),
    methods: (signal?: AbortSignal) => api.query('p2p', 'instruments.methods.list', { limit: 200 }, z.array(s.methodSchema), { signal }),
    instruments: (limit: number, signal?: AbortSignal) =>
      api.query('p2p', 'instruments.list', { limit }, z.array(s.instrumentSchema), { signal }),
    async destination(tradeId: string, signal?: AbortSignal, expected?: { method: string; fiatCurrency: string }) {
      const denied = signedIn();
      if (denied) return denied;
      if (!p2pCurrent()) return p2pDeparted();
      const result = await api.query('p2p', 'trades.paymentInstrument', { tradeId }, s.tradeDestinationSchema, { signal });
      if (!p2pCurrent()) return p2pDeparted();
      if (!result.ok) return result;
      if (
        result.data.tradeId.toLowerCase() !== tradeId.toLowerCase() ||
        (expected &&
          (result.data.methodId.toLowerCase() !== expected.method.toLowerCase() || result.data.fiatCurrency !== expected.fiatCurrency))
      )
        return payRefusal('p2pPaymentProjectionMismatch', { code: 'pay.trade_destination_mismatch', reason: 'invalid_response' });
      return result;
    },
    /**
     * What the person can use of one asset right now: the `free` quantity from the same balance read Money shows. An
     * asset the read does not list is held in no quantity, so it is "0". A failed read is returned as the failure.
     */
    availableBalance: async (asset: string, signal?: AbortSignal): Promise<ApiResult<string>> => {
      const denied = signedIn();
      if (denied) return denied;
      const result = await createMoneyClient(api).balances(signal);
      if (!result.ok) return result;
      // The lock draws from the asset exactly as the order names it; another casing is only a fallback.
      const names = Object.keys(result.data.balances);
      const key = names.find((name) => name === asset) ?? names.find((name) => name.toLowerCase() === asset.toLowerCase());
      return { ok: true, data: key === undefined ? '0' : result.data.balances[key]!.free };
    },
    reputation: async (counterparty: string, signal?: AbortSignal) => {
      const denied = signedIn();
      if (denied) return denied;
      if (!p2pCurrent()) return p2pDeparted();
      const result = await api.query('p2p', 'reputation.get', { userId: counterparty }, s.reputationSchema, { signal });
      // The contract has no returned subject ID: association belongs to this
      // exact requested UUID and current owner/URL view, never a guessed field.
      return p2pCurrent() ? result : p2pDeparted();
    },
    /** The signed-in account id (null when signed out). Lets a screen tell "you" from the other side. */
    viewer: userId,
    /**
     * `chat.messages.list`: messages after `cursor`, oldest first. The service marks the thread read for this account
     * when a page ends the thread, so only call it for a thread that is on screen.
     */
    chatMessages(tradeId: string, page: { cursor: string | null; limit: number }, signal?: AbortSignal) {
      const denied = signedIn();
      if (denied) return Promise.resolve(denied);
      if (!p2pCurrent()) return Promise.resolve(p2pDeparted());
      return api.query(
        'p2p',
        'chat.messages.list',
        { tradeId, limit: page.limit, ...(page.cursor ? { cursor: page.cursor } : {}) },
        s.chatPageSchema,
        { signal },
      );
    },
    /**
     * `chat.messages.send`. `clientId` is the idempotency key: the service stores one message per (order, sender,
     * clientId), so sending the same text again under the same clientId can never post twice.
     */
    chatSend(tradeId: string, text: string, clientId: string, signal?: AbortSignal) {
      const denied = signedIn();
      if (denied) return Promise.resolve(denied);
      if (!p2pCurrent()) return Promise.resolve(p2pDeparted());
      return api.mutate('p2p', 'chat.messages.send', { tradeId, text, clientId }, s.chatSentSchema, { signal });
    },
    /** `chat.unread`: messages from the other side that this account has not read, for one order. */
    chatUnread(tradeId: string, signal?: AbortSignal) {
      const denied = signedIn();
      if (denied) return Promise.resolve(denied);
      if (!p2pCurrent()) return Promise.resolve(p2pDeparted());
      return api.query('p2p', 'chat.unread', { tradeId }, s.chatUnreadSchema, { signal });
    },
    /** `contacts.list`: the account ids this account follows and blocks. */
    contacts(signal?: AbortSignal) {
      const denied = signedIn();
      if (denied) return Promise.resolve(denied);
      if (!p2pCurrent()) return Promise.resolve(p2pDeparted());
      return api.query('p2p', 'contacts.list', undefined, s.contactsSchema, { signal });
    },
    /**
     * `contacts.follow | unfollow | block | unblock`. `idempotencyKey` makes a repeat of the same change harmless; the
     * reply is the whole list as the service now holds it.
     */
    setContact(change: 'follow' | 'unfollow' | 'block' | 'unblock', peerId: string, idempotencyKey: string, signal?: AbortSignal) {
      const denied = signedIn();
      if (denied) return Promise.resolve(denied);
      if (!p2pCurrent()) return Promise.resolve(p2pDeparted());
      return api.mutate('p2p', `contacts.${change}`, { peerId, idempotencyKey }, s.contactsSchema, { signal });
    },
    /** `access.eligibility`: what this person needs before taking an ad, check by check. */
    eligibility(signal?: AbortSignal) {
      const denied = signedIn();
      if (denied) return Promise.resolve(denied);
      return api.query('p2p', 'access.eligibility', undefined, s.p2pEligibilitySchema, { signal });
    },
    /** P-ads-merchant-01: the advertiser terms version to accept before posting an ad, and when this person accepted it. */
    advertiserTerms(signal?: AbortSignal) {
      const denied = signedIn();
      if (denied) return Promise.resolve(denied);
      return api.query('p2p', 'merchants.advertiserTerms', undefined, s.p2pRiskNoticeSchema, { signal });
    },
    /** Accept exactly the advertiser terms version shown. Accepting again returns the first acceptance. */
    acceptAdvertiserTerms(version: string) {
      const denied = signedIn();
      if (denied) return Promise.resolve(denied);
      return api.mutate('p2p', 'merchants.acceptAdvertiserTerms', { version }, s.p2pRiskNoticeSchema.extend({ acceptedAt: z.string() }));
    },
    /** P-ads-merchant-01: this person's free balance of a coin, which a new sell ad's total may not exceed. */
    sellBalance(asset: string, signal?: AbortSignal) {
      const denied = signedIn();
      if (denied) return Promise.resolve(denied);
      return api.query('p2p', 'offers.sellBalance', { asset }, s.p2pSellBalanceSchema, { signal });
    },
    /** P-ads-merchant-02: the per-order band this person's verification level allows, which a buy ad's orders must fit. */
    levelLimits(signal?: AbortSignal) {
      const denied = signedIn();
      if (denied) return Promise.resolve(denied);
      return api.query('p2p', 'limits.verification', undefined, s.p2pLevelLimitsSchema, { signal });
    },
    /** P-ads-merchant-12: what posting an ad in this fiat needs, each check with this person's value and the target. */
    postingEligibility(fiatCurrency: string, signal?: AbortSignal) {
      const denied = signedIn();
      if (denied) return Promise.resolve(denied);
      return api.query('p2p', 'merchants.postingEligibility', { fiatCurrency }, s.p2pPostingEligibilitySchema, { signal });
    },
    /**
     * P-ads-merchant-01: post the reviewed ad. `idempotencyKey` is the form's business key, made once per form, so a
     * second press or a retry after a lost reply answers the same ad. `termsVersion` is the version the form showed.
     */
    postOffer(input: s.PostOfferInput, idempotencyKey: string, termsVersion: string) {
      const denied = signedIn();
      if (denied) return Promise.resolve(denied);
      if (!p2pCurrent()) return Promise.resolve(p2pDeparted());
      return api.mutate(
        'p2p',
        'offers.create',
        { ...input, idempotencyKey, advertiserTermsVersion: termsVersion },
        s.offerSchema.refine((offer) => offer.makerId === userId, 'The posted ad is not this account’s'),
      );
    },
    /**
     * P-ads-merchant-06: saves an edit of the person's own ad, only the fields that changed. `idempotencyKey` is made once
     * per edit form, so a second press or a retry is the same edit and counts once against the day's cap. Open orders keep
     * the terms they were taken on.
     */
    updateOffer(offerId: string, changes: s.OfferUpdateInput, idempotencyKey: string) {
      const denied = signedIn();
      if (denied) return Promise.resolve(denied);
      if (!p2pCurrent()) return Promise.resolve(p2pDeparted());
      return api.mutate(
        'p2p',
        'offers.update',
        { offerId, idempotencyKey, ...changes },
        s.offerSchema.refine((offer) => offer.makerId === userId && offer.id === offerId.toLowerCase(), 'The edited ad is not this one'),
      );
    },
    standing: (signal?: AbortSignal) => api.query('p2p', 'merchants.me', undefined, s.p2pStandingSchema.nullable(), { signal }),
    apiAccess: (signal?: AbortSignal) => api.query('p2p', 'merchants.apiAccess', undefined, s.p2pApiAccessSchema, { signal }),
    applyProgramme: () =>
      guard.run(
        `${userId}:p2p-programme`,
        () => api.mutate('p2p', 'merchants.submitApplication', {}, s.p2pStandingSchema),
        undefined,
        p2pCurrent,
      ),
    withdrawProgramme: (reason: string) =>
      guard.run(
        `${userId}:p2p-programme`,
        () => api.mutate('p2p', 'merchants.withdraw', { reason }, s.p2pStandingSchema),
        undefined,
        p2pCurrent,
      ),
    dispute: (tradeId: string, signal?: AbortSignal) => api.query('p2p', 'disputes.get', { tradeId }, s.disputeSchema, { signal }),
    async manageOffer(
      offerId: string,
      action: 'pause' | 'resume' | 'close',
      review?: { expected: s.Offer; current: () => boolean; recoveryCurrent?: () => boolean },
    ) {
      const denied = signedIn();
      if (denied) return denied;
      const current = () => p2pCurrent() && (review?.current() ?? true);
      if (!current()) return p2pDeparted();
      const latest = await currentOffer(offerId);
      if (!current()) return p2pDeparted();
      if (!latest.ok) return latest;
      if (latest.data.makerId !== userId) return payRefusal('onlyTheOfferSMakerCanManage', { code: 'pay.offer_not_owned' });
      if (review && !sameOfferTerms(latest.data, review.expected))
        return payRefusal('p2pOfferTermsChanged', { code: 'pay.offer_terms_changed', reason: 'invalid_response' });
      if (
        latest.data.status === 'closed' ||
        (action === 'pause' && latest.data.status !== 'active') ||
        (action === 'resume' && latest.data.status !== 'paused')
      )
        return payRefusal('p2pOfferTermsChanged', { code: 'pay.offer_action_invalid', reason: 'invalid_response' });
      const expectedStatus = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'closed';
      return guard.run(
        `${userId}:offer:${offerId}`,
        async () => {
          const result = await api.mutate('p2p', `offers.${action}`, { offerId }, s.offerSchema);
          if (
            result.ok &&
            (result.data.id.toLowerCase() !== offerId.toLowerCase() ||
              result.data.makerId !== userId ||
              result.data.status !== expectedStatus)
          )
            return payRefusal('theOriginalOfferActionHasNotBeen', { code: 'pay.offer_original_mismatch', reason: 'uncertain' });
          return result;
        },
        action,
        current,
        () => p2pCurrent() && (review?.recoveryCurrent?.() ?? review?.current() ?? true),
      );
    },
    async manageTrade(
      tradeId: string,
      action: 'markFiatSent' | 'confirmReceived' | 'cancel',
      reason?: string,
      review?: { expected: s.Trade; current: () => boolean },
      /** `confirmReceived` only: identity's single-use confirmation of this release (P-trade-orders-07). */
      stepUpApprovalId?: string,
    ) {
      const denied = signedIn();
      if (denied) return denied;
      const current = () => p2pCurrent() && (review?.current() ?? true);
      if (!current()) return p2pDeparted();
      const latest = await currentTrade(tradeId);
      if (!current()) return p2pDeparted();
      if (!latest.ok) return latest;
      const trade = latest.data;
      if (review && !sameTerms(trade, review.expected))
        return payRefusal('p2pTermsChanged', { code: 'pay.trade_terms_changed', reason: 'invalid_response' });
      if (action === 'markFiatSent' && (trade.buyerId !== userId || trade.status !== 'escrowed'))
        return payRefusal('onlyTheBuyerOfAnEscrowedOrder', { code: 'pay.trade_action_invalid' });
      if (action === 'confirmReceived' && (trade.sellerId !== userId || trade.status !== 'fiat_sent'))
        return payRefusal('releaseRequiresTheSellerToConfirmAn', { code: 'pay.trade_action_invalid' });
      if (action === 'cancel' && !['created', 'escrowed'].includes(trade.status))
        return payRefusal('thisOrderCannotBeCancelledInIts', { code: 'pay.trade_action_invalid' });
      return guard.run(
        `${userId}:trade:${tradeId}`,
        () =>
          api.mutate(
            'p2p',
            `trades.${action}`,
            {
              tradeId,
              ...(action === 'cancel' && reason ? { reason } : {}),
              ...(action === 'confirmReceived' && stepUpApprovalId ? { stepUpApprovalId } : {}),
            },
            s.tradeSchema.refine(
              (result) =>
                sameImmutableTerms(result, trade) &&
                (action === 'markFiatSent'
                  ? result.status === 'fiat_sent'
                  : action === 'confirmReceived'
                    ? result.status === 'released' && result.resolution === 'released'
                    : result.status === 'cancelled' && ['refunded', 'voided'].includes(result.resolution ?? '')),
              'The reply does not match this owner, order, reviewed asset/payment terms and original action.',
            ),
          ),
        action,
        current,
        p2pCurrent,
      );
    },
    async reconcileTrade(tradeId: string) {
      const denied = signedIn();
      if (denied) return denied;
      return guard.checkOriginal(
        `${userId}:trade:${tradeId}`,
        async (original) => {
          const action = original.reference;
          const latest = await api.query('p2p', 'trades.get', { tradeId }, s.tradeSchema);
          if (!latest.ok) return latest;
          const trade = latest.data;
          if (trade.id !== tradeId)
            return payRefusal('theOriginalOrderActionIsStillUnresolved', {
              code: 'pay.trade_original_mismatch',
              reason: 'invalid_response',
            });
          if (trade.buyerId !== userId && trade.sellerId !== userId)
            return payRefusal('thisOrderBelongsToAnotherAccount', { code: 'pay.trade_not_owned' });
          const confirmed =
            action === 'markFiatSent'
              ? ['fiat_sent', 'disputed', 'released', 'cancelled'].includes(trade.status)
              : action === 'confirmReceived'
                ? trade.status === 'released' &&
                  trade.resolution === 'released' &&
                  z.string().datetime({ offset: true }).safeParse(trade.settledAt).success
                : action === 'cancel'
                  ? trade.status === 'cancelled' &&
                    trade.resolution === 'refunded' &&
                    z.string().datetime({ offset: true }).safeParse(trade.settledAt).success
                  : false;
          return confirmed
            ? latest
            : payRefusal('theOriginalOrderActionIsStillUnresolved', { code: 'pay.operation_unresolved', reason: 'uncertain' });
        },
        p2pCurrent,
      );
    },
    async reconcileOffer(offerId: string, frameCurrent: () => boolean = () => true) {
      const denied = signedIn();
      if (denied) return denied;
      return guard.checkOriginal(
        `${userId}:offer:${offerId}`,
        async (original) => {
          const action = original.reference;
          const latest = await currentOffer(offerId);
          if (!latest.ok && latest.code === 'pay.offer_projection_invalid')
            return payRefusal('theOriginalOfferActionHasNotBeen', { code: 'pay.offer_original_mismatch', reason: 'invalid_response' });
          if (!latest.ok) return latest;
          if (latest.data.id.toLowerCase() !== offerId.toLowerCase())
            return payRefusal('theOriginalOfferActionHasNotBeen', { code: 'pay.offer_original_mismatch', reason: 'invalid_response' });
          if (latest.data.makerId !== userId) return payRefusal('onlyTheOfferSMakerCanManage', { code: 'pay.offer_not_owned' });
          const expected = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : action === 'close' ? 'closed' : null;
          return expected && latest.data.status === expected
            ? latest
            : payRefusal('theOriginalOfferActionHasNotBeen', { code: 'pay.operation_unresolved', reason: 'uncertain' });
        },
        () => p2pCurrent() && frameCurrent(),
      );
    },
    /**
     * What taking this offer would cost, before anything is reserved: `trades.quote`. A read. The figures are the
     * service's own; they are shown only when they describe this request and add up, and are never filled in locally.
     */
    async quoteTake(offer: s.Offer, request: TakeRequest, signal?: AbortSignal) {
      const denied = signedIn();
      if (denied) return denied;
      if (isOwnOffer(offer, userId)) return takeRefusal('pay.take_own_offer', 'forbidden');
      if (request.offerId.toLowerCase() !== offer.id.toLowerCase()) return takeRefusal('pay.take_terms_changed', 'invalid_response');
      if (!p2pCurrent()) return p2pDeparted();
      const result = shareLinkRefusal(
        await api.query('p2p', 'trades.quote', { ...request, ...shareOf(offer.id) }, s.takeQuoteSchema, { signal }),
      );
      if (!p2pCurrent()) return p2pDeparted();
      if (!result.ok) return result;
      return quoteIsConsistent(offer, request, result.data) ? result : takeRefusal('pay.take_quote_invalid', 'invalid_response');
    },
    /**
     * Hold the reviewed figures: `trades.lockQuote`. The service keeps this price, fee and amount until the quote ends,
     * and a take that names it places exactly them or refuses before anything is reserved. The reply must describe the
     * same request and add up, like a preview quote.
     */
    async lockQuote(offer: s.Offer, request: TakeRequest, signal?: AbortSignal): Promise<ApiResult<s.TakeQuote>> {
      const denied = signedIn();
      if (denied) return denied;
      if (isOwnOffer(offer, userId)) return takeRefusal('pay.take_own_offer', 'forbidden');
      if (request.offerId.toLowerCase() !== offer.id.toLowerCase()) return takeRefusal('pay.take_terms_changed', 'invalid_response');
      if (!p2pCurrent()) return p2pDeparted();
      // A new quote each time the order is reviewed: the id names this quote, it is not a retry key for a money step.
      let quoteId: string;
      try {
        quoteId = globalThis.crypto.randomUUID();
      } catch {
        return takeRefusal('pay.take_quote_invalid', 'not_supported');
      }
      const result = shareLinkRefusal(
        await api.mutate('p2p', 'trades.lockQuote', { ...request, ...shareOf(offer.id), quoteId }, s.lockedQuoteSchema, { signal }),
      );
      if (!p2pCurrent()) return p2pDeparted();
      if (!result.ok) return result;
      // Count down from the time left the service gave, on this device's clock: a device clock that runs fast or slow
      // must not end the quote early or keep it open late.
      const { expiresAt: _serverEnd, expiresInMs, ...figures } = result.data;
      const held: s.TakeQuote = { ...figures, reservationExpiresAt: new Date(Date.now() + expiresInMs).toISOString() };
      return quoteIsConsistent(offer, request, held) && held.quoteId === quoteId
        ? { ok: true, data: held }
        : takeRefusal('pay.take_quote_invalid', 'invalid_response');
    },
    /**
     * The coin amount a fiat amount buys on this offer, as the service converts it (`trades.quote` with `fiatAmount`,
     * rounded down so the fiat is never more than asked). Only the amount is used: the order is then quoted by it.
     */
    async coinForFiat(offer: s.Offer, input: { fiatAmount: string; method: string }, signal?: AbortSignal): Promise<ApiResult<string>> {
      const denied = signedIn();
      if (denied) return denied;
      if (!p2pCurrent()) return p2pDeparted();
      const result = await api.query(
        'p2p',
        'trades.quote',
        { offerId: offer.id.toLowerCase(), fiatAmount: input.fiatAmount, method: input.method, ...shareOf(offer.id) },
        s.takeQuoteSchema,
        { signal },
      );
      if (!p2pCurrent()) return p2pDeparted();
      if (!result.ok) return result;
      // The reply must price exactly the fiat asked for; anything else is not this conversion.
      return parseAmount(result.data.fiatAmount) === parseAmount(input.fiatAmount)
        ? { ok: true, data: result.data.amount }
        : takeRefusal('pay.take_quote_invalid', 'invalid_response');
    },
    /**
     * Place the order: `trades.take`, which locks the seller's asset in escrow. Money moves, so:
     *  - the order id is chosen here, stored on this device before the request leaves, and sent with it;
     *  - the offer and the quote are read again first and must be what was reviewed;
     *  - a reply that does not describe the reviewed order is not accepted;
     *  - a lost, late or unrecognised reply is "unconfirmed": nothing is retried by itself, the stored id is kept, and
     *    the order can be looked up by that id (`reconcileTake`) or sent again under the same id. A resend looks the
     *    order up first and again after any refusal, and only an order the service says it does not have clears the
     *    stored id; the service itself does not return an existing order for a repeated id.
     */
    async takeOffer(
      offer: s.Offer,
      request: TakeRequest,
      reviewed: { quote: s.TakeQuote; current: () => boolean; recoveryCurrent?: () => boolean; stepUpApprovalId?: string },
    ) {
      const denied = signedIn();
      if (denied) return denied;
      const me = userId!;
      const current = () => p2pCurrent() && reviewed.current();
      if (!current()) return p2pDeparted();
      if (isOwnOffer(offer, me)) return takeRefusal('pay.take_own_offer', 'forbidden');
      if (request.offerId.toLowerCase() !== offer.id.toLowerCase()) return takeRefusal('pay.take_terms_changed', 'invalid_response');
      const key = `${me}:take:${offer.id.toLowerCase()}`;
      const readOrder = async (tradeId: string, against: Pick<TakeRequest, 'amount' | 'method'> | null) => {
        const latest = await api.query('p2p', 'trades.get', { tradeId }, s.tradeSchema);
        if (!latest.ok) return latest;
        return tradeMatchesTake(latest.data, offer, me, against, tradeId) ? latest : takeRefusal('pay.take_unconfirmed', 'uncertain');
      };
      // The same offer, the same figures, still open to this person, right before the money step.
      const preflight = async () => {
        const latest = await currentOffer(offer.id);
        if (!current()) return p2pDeparted();
        if (!latest.ok) return latest;
        if (isOwnOffer(latest.data, me)) return takeRefusal('pay.take_own_offer', 'forbidden');
        if (latest.data.status !== 'active') return takeRefusal('pay.take_offer_unavailable', 'forbidden');
        if (!sameTakeTerms(latest.data, offer)) return takeRefusal('pay.take_terms_changed', 'invalid_response');
        const again = await api.query('p2p', 'trades.quote', { ...request, ...shareOf(offer.id) }, s.takeQuoteSchema);
        if (!current()) return p2pDeparted();
        if (!again.ok) return again;
        if (!quoteIsConsistent(latest.data, request, again.data) || !sameQuoteFigures(again.data, reviewed.quote))
          return takeRefusal('pay.take_quote_changed', 'invalid_response');
        return null;
      };
      const place = async (tradeId: string): Promise<ApiResult<s.Trade>> => {
        const sent = await api.mutate(
          'p2p',
          'trades.take',
          {
            offerId: request.offerId,
            tradeId,
            amount: request.amount,
            method: request.method,
            ...(reviewed.quote.quoteId ? { quoteId: reviewed.quote.quoteId } : {}),
            ...shareOf(offer.id),
            // The fresh confirmation of exactly this review; inside this session's confirmed ten minutes there is none.
            ...(reviewed.stepUpApprovalId ? { stepUpApprovalId: reviewed.stepUpApprovalId } : {}),
          },
          s.tradeSchema,
        );
        if (sent.ok)
          return tradeMatchesTake(sent.data, offer, me, request, tradeId) ? sent : takeRefusal('pay.take_unconfirmed', 'uncertain');
        if (takeRefusalIsDefinite(sent)) return shareLinkRefusal(sent);
        // The order may exist. If the service already has it under this id, that is the answer.
        const found = await readOrder(tradeId, request);
        if (found.ok) return found;
        return { ...sent, reason: 'uncertain', code: sent.code ?? 'pay.take_unconfirmed' };
      };
      if (guard.status(key) === 'uncertain') {
        const held = guard.original(key);
        const heldId = held?.value.reference;
        if (!held || !heldId || !s.id.safeParse(heldId).success)
          return payRefusal('theOriginalActionHasNotBeenConfirmed', { code: 'pay.operation_unresolved', reason: 'uncertain' });
        // An earlier attempt on this offer was never confirmed. The service does not answer a repeated id with the
        // order it already holds: it re-checks the offer and its remaining quantity first, and the earlier attempt may
        // be the very thing that used them up. So a refusal here proves nothing until the order has been looked for
        // again by its id. The whole resend runs under the journal's lease, so two tabs cannot resend at once.
        let proven = false;
        const afterRefusal = async (refusal: Extract<ApiResult<never>, { ok: false }>): Promise<ApiResult<s.Trade>> => {
          if (refusal.reason === 'aborted') return refusal;
          const again = await readOrder(heldId, null);
          if (again.ok) return again;
          if (isTradeAbsent(again)) {
            proven = true;
            return refusal;
          }
          return takeRefusal('pay.take_unconfirmed', 'uncertain');
        };
        const outcome = await guard.checkOriginal<s.Trade>(
          key,
          async () => {
            const existing = await readOrder(heldId, null);
            if (existing.ok) return existing;
            if (!isTradeAbsent(existing)) return takeRefusal('pay.take_unconfirmed', 'uncertain');
            const refused = await preflight();
            if (refused) return afterRefusal(refused);
            const replayed = await place(heldId);
            if (replayed.ok) {
              // The look-up just before proved there was no such order, so this one was placed by this resend.
              placedUnderHeld.add(replayed.data);
              return replayed;
            }
            return takeRefusalIsDefinite(replayed) ? afterRefusal(replayed) : replayed;
          },
          current,
        );
        if (proven) await guard.resolve(key, held.raw);
        return outcome;
      }
      const refused = await preflight();
      if (refused) return refused;
      let tradeId: string;
      try {
        tradeId = globalThis.crypto.randomUUID();
      } catch {
        return payRefusal('deviceRecoveryStorageIsUnavailableEnableSession', {
          code: 'pay.recovery_journal_unavailable',
          reason: 'not_supported',
        });
      }
      return guard.run(key, () => place(tradeId), tradeId, current, reviewed.recoveryCurrent ?? p2pCurrent);
    },
    /** Until when this session's orders need no new confirmation, or null when the next one does. */
    takeStepUpWindow: (signal?: AbortSignal) => api.query('p2p', 'trades.stepUpWindow', undefined, s.takeStepUpWindowSchema, { signal }),
    /** Until when this session's releases need no new confirmation (svc-p2p `trades.releaseStepUpWindow`), or null. */
    releaseStepUpWindow: (signal?: AbortSignal) =>
      api.query('p2p', 'trades.releaseStepUpWindow', undefined, s.takeStepUpWindowSchema, { signal }),
    /** Look up an unconfirmed take by the order id stored before it was sent. Clears the stored id only when found. */
    async reconcileTake(offer: s.Offer, frameCurrent: () => boolean = () => true) {
      const denied = signedIn();
      if (denied) return denied;
      const me = userId!;
      return guard.checkOriginal(
        `${me}:take:${offer.id.toLowerCase()}`,
        async (original) => {
          const tradeId = original.reference;
          if (!tradeId || !s.id.safeParse(tradeId).success) return takeRefusal('pay.take_unconfirmed', 'uncertain');
          const latest = await api.query('p2p', 'trades.get', { tradeId }, s.tradeSchema);
          if (!latest.ok)
            return isTradeAbsent(latest)
              ? takeRefusal('pay.take_not_found', 'uncertain')
              : takeRefusal('pay.take_unconfirmed', 'uncertain');
          return tradeMatchesTake(latest.data, offer, me, null, tradeId) ? latest : takeRefusal('pay.take_unconfirmed', 'uncertain');
        },
        () => p2pCurrent() && frameCurrent(),
      );
    },
    openDispute: (tradeId: string, reason: string) =>
      guard.run(
        `${userId}:dispute:${tradeId}`,
        () => api.mutate('p2p', 'disputes.open', { tradeId, reason }, s.disputeOpenedSchema),
        undefined,
        p2pCurrent,
      ),
    /** P-trade-orders-15: the buyer of a paid order reminds the seller to release. Moves nothing; svc-p2p decides when. */
    remindSeller: (tradeId: string) =>
      guard.run(
        `${userId}:remind:${tradeId}`,
        () => api.mutate('p2p', 'trades.remind', { tradeId }, s.tradeRemindersSchema),
        undefined,
        p2pCurrent,
      ),
    /**
     * P-ads-merchant-19: the seller reports a sensitive remark the buyer wrote in the payment note. Moves nothing; a case
     * opens and the buyer is told. `caseId` is made once per quote, so a lost reply sent again answers the same case.
     */
    async reportSensitiveRemark(tradeId: string, caseId: string, remark: string): Promise<ApiResult<s.RemarkCase>> {
      // No device journal (guard.run would hold the resend back after a lost answer): svc-p2p answers the same case id
      // and quote with the same case, so a resend is the retry.
      const denied = signedIn();
      if (denied) return denied;
      if (!p2pCurrent()) return p2pDeparted();
      return api.mutate('p2p', 'trades.reportSensitiveRemark', { caseId, tradeId, remark }, s.remarkCaseSchema);
    },
    /** P-ads-merchant-19: the person's own remark report on this order, and whether the other party reported them. */
    async remarkCase(tradeId: string, signal?: AbortSignal): Promise<ApiResult<s.RemarkCasesOn>> {
      const denied = signedIn();
      if (denied) return denied;
      if (!p2pCurrent()) return p2pDeparted();
      return api.query('p2p', 'trades.remarkCase', { tradeId }, s.remarkCasesOnSchema, { signal });
    },
    /** P-trade-orders-20: the seller reports what arrived in their bank. Moves nothing; svc-p2p classifies it. */
    reportMismatch: (tradeId: string, kind: s.TradeMismatch['kind'], amountReceived: string) =>
      guard.run(
        `${userId}:mismatch:${tradeId}`,
        () => api.mutate('p2p', 'trades.reportMismatch', { tradeId, kind, amountReceived }, s.tradeMismatchSchema),
        undefined,
        p2pCurrent,
      ),
    /** P-trade-orders-11: the seller has the bank rail check the payment; svc-p2p releases only on an exact match. */
    validatePayment: (tradeId: string, stepUpApprovalId?: string) =>
      guard.run(
        `${userId}:validate:${tradeId}`,
        () =>
          api.mutate(
            'p2p',
            'trades.validatePayment',
            { tradeId, ...(stepUpApprovalId ? { stepUpApprovalId } : {}) },
            s.validatePaymentSchema,
          ),
        undefined,
        p2pCurrent,
      ),
    appendEvidence: (tradeId: string, evidence: string) =>
      guard.run(
        `${userId}:evidence:${tradeId}`,
        () =>
          api.mutate(
            'p2p',
            'disputes.appendEvidence',
            { tradeId, evidence: [evidence] },
            z.object({ disputeId: s.id, tradeId: s.id, evidence: s.disputeSchema.shape.evidence }),
          ),
        undefined,
        p2pCurrent,
      ),
    /**
     * P-ads-merchant-18: save a payment method in the person's own name. No money moves, so there is no recovery
     * journal: the form keeps one id until the save is answered, and a lost answer is settled by reading the person's
     * own list for that id. Found, it was saved; not found, nothing was stored and the same id may be sent again.
     */
    async addInstrument(input: {
      instrumentId: string;
      methodId: string;
      country: string;
      fiatCurrency: string;
      label: string;
      details: Record<string, string>;
      /** The person's confirmation of exactly this change and these details (svc-p2p refuses a change without one). */
      stepUpApprovalId?: string;
    }): Promise<ApiResult<z.infer<typeof s.instrumentSchema>>> {
      const denied = signedIn();
      if (denied) return denied;
      if (!p2pCurrent()) return p2pDeparted();
      const result = await api.mutate('p2p', 'instruments.create', input, s.instrumentSchema);
      if (result.ok || result.reason !== 'uncertain') return result;
      const listed = await api.query('p2p', 'instruments.list', { limit: 200 }, z.array(s.instrumentSchema));
      const stored = listed.ok ? listed.data.find((row) => row.id.toLowerCase() === input.instrumentId.toLowerCase()) : undefined;
      return stored ? { ok: true, data: stored } : result;
    },
    /** P-ads-merchant-18: what removing this method does to the person's ads, read before they confirm. */
    async methodRemovalImpact(instrumentId: string, signal?: AbortSignal): Promise<ApiResult<z.infer<typeof s.methodRemovalImpactSchema>>> {
      const denied = signedIn();
      if (denied) return denied;
      if (!p2pCurrent()) return p2pDeparted();
      return api.query('p2p', 'instruments.removalImpact', { instrumentId }, s.methodRemovalImpactSchema, { signal });
    },
    /** `pauseOfferIds`: the ads the person was shown pausing with this method and agreed to; svc-p2p pauses no other. */
    removeInstrument: (instrumentId: string, stepUpApprovalId?: string, pauseOfferIds: readonly string[] = []) =>
      guard.run(
        `${userId}:instrument:${instrumentId}`,
        () =>
          api.mutate(
            'p2p',
            'instruments.remove',
            {
              instrumentId,
              ...(stepUpApprovalId ? { stepUpApprovalId } : {}),
              ...(pauseOfferIds.length ? { pauseOfferIds: [...pauseOfferIds] } : {}),
            },
            s.instrumentSchema,
          ),
        undefined,
        p2pCurrent,
      ),
    /** P-ads-merchant-08: the person's own active ads, for a bulk action (the board pages them with everyone else's). */
    async activeOffers(signal?: AbortSignal): Promise<ApiResult<s.Offer[]>> {
      const denied = signedIn();
      if (denied) return denied;
      if (!p2pCurrent()) return p2pDeparted();
      return api.query(
        'p2p',
        'offers.mine',
        { status: 'active', limit: PAUSED_OFFERS_SHOWN },
        z.array(s.offerSchema.refine((offer) => offer.makerId === userId, 'An ad in this list is not this account’s')),
        { signal },
      );
    },
    /** The person's own paused ads (the board lists active ads only), newest first. */
    async pausedOffers(signal?: AbortSignal): Promise<ApiResult<s.Offer[]>> {
      const denied = signedIn();
      if (denied) return denied;
      if (!p2pCurrent()) return p2pDeparted();
      return api.query(
        'p2p',
        'offers.mine',
        { status: 'paused', limit: PAUSED_OFFERS_SHOWN },
        z.array(s.offerSchema.refine((offer) => offer.makerId === userId, 'An ad in this list is not this account’s')),
        { signal },
      );
    },
    /**
     * P-ads-merchant-07: this ad was opened by a share link. Its reads, quotes and take send the token from now on, which
     * is how a private ad is reached and how an order is marked as shared. A malformed token is not kept.
     */
    rememberShare(offerId: string, token: string) {
      if (s.id.safeParse(offerId).success && SHARE_TOKEN.test(token)) shareTokens.set(offerId.toLowerCase(), token);
    },
    /** P-ads-merchant-07: make the person's own ad public (on the board) or private (by its links only). */
    setOfferVisibility(offerId: string, visibility: 'public' | 'private') {
      const denied = signedIn();
      if (denied) return Promise.resolve(denied);
      if (!p2pCurrent()) return Promise.resolve(p2pDeparted());
      return api.mutate(
        'p2p',
        'offers.setVisibility',
        { offerId, visibility },
        s.offerSchema.refine((offer) => offer.makerId === userId && offer.visibility === visibility, 'The ad did not change as asked'),
      );
    },
    /** P-ads-merchant-07: the links to the person's own ad, newest first (never their tokens). */
    async shareLinks(offerId: string, signal?: AbortSignal): Promise<ApiResult<s.ShareLink[]>> {
      const denied = signedIn();
      if (denied) return denied;
      if (!p2pCurrent()) return p2pDeparted();
      return api.query('p2p', 'offers.shareLinks.list', { offerId }, z.array(s.shareLinkSchema), { signal });
    },
    /**
     * P-ads-merchant-07: a new link to the person's own ad. The token comes back once and is shown in the link; svc-p2p
     * keeps only its hash, so the link cannot be read again later. `linkId` is made once per press of Make a link.
     */
    createShareLink(offerId: string, linkId: string, seconds?: number) {
      const denied = signedIn();
      if (denied) return Promise.resolve(denied);
      if (!p2pCurrent()) return Promise.resolve(p2pDeparted());
      return api.mutate(
        'p2p',
        'offers.shareLinks.create',
        { offerId, linkId, ...(seconds === undefined ? {} : { seconds }) },
        s.shareLinkSchema.extend({ token: z.string().regex(SHARE_TOKEN) }),
      );
    },
    /** P-ads-merchant-07: withdraw a link at once. */
    revokeShareLink(linkId: string) {
      const denied = signedIn();
      if (denied) return Promise.resolve(denied);
      if (!p2pCurrent()) return Promise.resolve(p2pDeparted());
      return api.mutate('p2p', 'offers.shareLinks.revoke', { linkId }, s.shareLinkSchema);
    },
    /** P-ads-merchant-08: the person's presence: online, offline, or a weekly schedule; and whether their ads are on the board. */
    async presence(signal?: AbortSignal): Promise<ApiResult<s.Presence>> {
      const denied = signedIn();
      if (denied) return denied;
      if (!p2pCurrent()) return p2pDeparted();
      return api.query('p2p', 'merchants.presence', undefined, s.presenceSchema, { signal });
    },
    /** P-ads-merchant-08: sets online, offline or a schedule; a week that is not valid refuses `p2p.schedule_invalid`. */
    setPresence(input: { mode: s.Presence['mode']; timezone?: string; windows?: s.PresenceWindow[] }): Promise<ApiResult<s.Presence>> {
      const denied = signedIn();
      if (denied) return Promise.resolve(denied);
      if (!p2pCurrent()) return Promise.resolve(p2pDeparted());
      return api.mutate('p2p', 'merchants.setPresence', input, s.presenceSchema);
    },
    /** P-ads-merchant-08: the person's open orders that wait on someone, soonest deadline first. */
    async todos(signal?: AbortSignal): Promise<ApiResult<s.TodoItem[]>> {
      const denied = signedIn();
      if (denied) return denied;
      if (!p2pCurrent()) return p2pDeparted();
      const result = await api.query('p2p', 'merchants.todos', { limit: TODOS_SHOWN }, s.todosSchema, { signal });
      return result.ok ? { ok: true, data: result.data.items } : result;
    },
    /**
     * P-ads-merchant-08: pauses, resumes or removes the named ads, each answering for itself. The key names this one
     * request: a retry after a lost reply sends the same key and svc-p2p answers the same results, changing nothing.
     */
    bulkOffers(input: { action: s.BulkOutcome['action']; offerIds: string[]; idempotencyKey: string }): Promise<ApiResult<s.BulkOutcome>> {
      const denied = signedIn();
      if (denied) return Promise.resolve(denied);
      if (!p2pCurrent()) return Promise.resolve(p2pDeparted());
      return api.mutate('p2p', 'offers.bulk', input, s.bulkOutcomeSchema);
    },
    /** P-ads-merchant-06: the person's own closed ads, most recently closed first, each with why it closed. */
    async closedOffers(signal?: AbortSignal): Promise<ApiResult<s.Offer[]>> {
      const denied = signedIn();
      if (denied) return denied;
      if (!p2pCurrent()) return p2pDeparted();
      return api.query(
        'p2p',
        'offers.mine',
        { status: 'closed', limit: CLOSED_OFFERS_SHOWN },
        z.array(
          s.offerSchema.refine(
            (offer) => offer.makerId === userId && offer.status === 'closed',
            'An ad in this list is not this account’s',
          ),
        ),
        { signal },
      );
    },
    /** P-ads-merchant-06: the person's ad edits today against the daily cap; blank cap refuses `p2p.config_unset`. */
    async offerEditQuota(signal?: AbortSignal): Promise<ApiResult<z.infer<typeof s.offerEditQuotaSchema>>> {
      const denied = signedIn();
      if (denied) return denied;
      if (!p2pCurrent()) return p2pDeparted();
      return api.query('p2p', 'offers.editQuota', undefined, s.offerEditQuotaSchema, { signal });
    },
    /**
     * P-ads-merchant-06: posts a closed ad again as a new ad, through every check a new ad passes. svc-p2p derives the new
     * ad's id from the closed one, so pressing twice, or a retry after a lost reply, is the same relist.
     */
    async relistOffer(offerId: string): Promise<ApiResult<s.Offer>> {
      const denied = signedIn();
      if (denied) return denied;
      if (!p2pCurrent()) return p2pDeparted();
      return guard.run(`${userId}:relist:${offerId}`, () => api.mutate('p2p', 'offers.relist', { offerId }, s.offerSchema));
    },
    /**
     * The person's own saved details for one method, masked by svc-p2p (the account holder whole, every other value as its
     * last four). svc-p2p logs every read in the same statement, the owner's included, so this runs only when the person
     * asks to see them.
     */
    async maskedInstrument(instrumentId: string): Promise<ApiResult<z.infer<typeof s.revealedInstrumentSchema>>> {
      const denied = signedIn();
      if (denied) return denied;
      if (!p2pCurrent()) return p2pDeparted();
      return api.mutate('p2p', 'instruments.revealMasked', { instrumentId }, s.revealedInstrumentSchema);
    },
    guard,
  };
}
export type PersonalPayApi = ReturnType<typeof createPersonalPayApi>;

export function createBusinessPayApi(
  api: ApiClient,
  userId: string | null,
  authority: PayBusinessAuthority | null,
  guard = payMutationGuard(),
  refundPorts?: JournalPorts,
) {
  function access(scope: string) {
    if (!authority || !authority.verified || !authority.companyId || !authority.companyName || authority.userId !== userId || !userId)
      return payRefusal('aVerifiedBusinessAccountAndCompanyMembership', { code: 'pay.business_authority_missing' });
    if (!authority.scopes.includes(scope) && !(authority.confirmable as readonly string[] | undefined)?.includes(scope))
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
  /**
   * `subscription.create` and `merchant.createLink` take `idempotencyKey` on the procedure input.
   * `api.mutate` has no header slot, so this is not an Idempotency-Key header.
   * The journal lock stays `${userId}:subscription-create:${mandateId}`.
   * A new create stores a fresh attempt id on that lock and sends
   * `${lockId}:${attemptId}`. A retry of the same uncertain attempt reuses
   * the stored id. A confirmed outcome or a definite refusal drops it, so the next create
   * on that mandate uses a fresh attempt id. An uncertain or aborted replay
   * keeps the stored id and original path.
   */
  async function mutate<T>(
    procedure: string,
    input: unknown,
    schema: ZodType<T>,
    scope: 'pay:write' | 'pay:refund' | 'pay:payout',
    operation: string,
    reference?: string,
  ): Promise<ApiResult<T>> {
    const denied = access(scope);
    if (denied) return denied;
    const checked = await merchant();
    if (!checked.ok) return checked;
    const lockId = `${userId}:${operation}`;
    const outcome = schema.refine(
      (data) => !data || typeof data !== 'object' || !('merchantId' in data) || data.merchantId === authority!.merchantId,
      'The mutation outcome belongs to another merchant.',
    );
    // Pause, resume, and cancel store the expected status in the journal.
    // subscription.create ignores that argument: its reference is the attempt id below.
    if (procedure !== 'subscription.create' && procedure !== 'merchant.createLink')
      return guard.run(lockId, () => api.mutate('pay', procedure, input, outcome), reference);
    const fields = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    // A replay sends the body the first attempt sent: its charge path and, for a subscription, its catalogue price.
    const sendAttempt = async (attemptId: string, path?: string, priceId?: string): Promise<ApiResult<T>> => {
      const result = await api.mutate(
        'pay',
        procedure,
        { ...fields, ...(path ? { path } : {}), ...(priceId ? { priceId } : {}), idempotencyKey: `${lockId}:${attemptId}` },
        outcome,
      );
      if (!result.ok && ['pay.idempotency_conflict', 'pay.subscription_mandate_open'].includes(result.code ?? ''))
        return {
          ...result,
          message:
            procedure === 'merchant.createLink'
              ? 'A request to create this link is already recorded with different details. Open Payment links to check it.'
              : 'A subscription request for this mandate is already recorded. Open Subscriptions to check it.',
        };
      return result;
    };
    // A lost response leaves the attempt id on the lock. Reuse it. Do not mint
    // a second id for that same uncertain create: the first request may have
    // committed, and a new key would not replay it.
    if (guard.status(lockId) === 'uncertain') {
      const held = guard.original(lockId);
      if (held?.status === 'present') {
        const attemptId = held.value.reference;
        if (!attemptId) {
          return payRefusal('theOriginalActionHasNotBeenConfirmed', { code: 'pay.operation_unresolved', reason: 'uncertain' });
        }
        const replayed = await sendAttempt(attemptId, held.value.path, held.value.priceId);
        // Match the first attempt: a known outcome, including a definite
        // refusal, drops the journal. Uncertain and aborted replies stay held
        // so the same attempt can be retried.
        const heldOpen = !replayed.ok && (replayed.reason === 'uncertain' || replayed.reason === 'aborted');
        if (!heldOpen) await guard.resolve(lockId, held.raw);
        return replayed;
      }
    }
    let attemptId: string;
    try {
      attemptId = globalThis.crypto.randomUUID();
    } catch {
      return payRefusal('deviceRecoveryStorageIsUnavailableEnableSession', {
        code: 'pay.recovery_journal_unavailable',
        reason: 'not_supported',
      });
    }
    // The journal codec rejects a reference longer than 200. Refuse before
    // writing an attempt the next read could not recover.
    if (!attemptId || attemptId.length > 200) {
      return payRefusal('deviceRecoveryStorageIsUnavailableEnableSession', {
        code: 'pay.recovery_journal_unavailable',
        reason: 'not_supported',
      });
    }
    const path = 'path' in fields && typeof fields.path === 'string' ? fields.path : undefined;
    const priceId = 'priceId' in fields && typeof fields.priceId === 'string' ? fields.priceId : undefined;
    return guard.run(lockId, () => sendAttempt(attemptId), attemptId, undefined, undefined, { path, priceId });
  }
  return {
    merchant,
    query,
    mutate,
    refund: createMerchantRefundApi({ api, userId, authority, access, merchant, ports: refundPorts }),
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
