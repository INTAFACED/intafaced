import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import type { PersonalPayApi } from './pay-api';
import { id, type BoardQuery, type BoardSort, type Offer, type OfferPage } from './schemas';
import { payRefusal } from './copy';
import { useTraders } from './personal/Trader';
import { closeRefusal } from './personal/p2p-my-ads';
import type { myAdsCopy } from './personal/p2p-my-ads-copy';
import { p2pReturn, closeReturnedOffer, consumeMarketArrival } from './p2p-return';

/**
 * The state behind the offer board and My offers (`P2POffers.tsx`, and the flow room's kit view in `p2p-flow/`): the
 * filters, the chosen offer and the focus that returns from it, the board's pages, and one offer's inspector with its
 * recovery of an unresolved action. The views draw it; this holds what happens.
 */

/** Board page size. Every further page continues the service's own keyset, so no row is missed or shown twice. */
export const PAGE = 50;
const FIAT_AMOUNT = /^\d{1,18}(\.\d{1,18})?$/;

/** Only the owner-key/reference names are enumerated. Opaque originals are
 * left intact and the shared journal separately validates every admission. */
function deviceOriginals(userId: string | null): { ids: string[]; failed: boolean } {
  if (!userId) return { ids: [], failed: false };
  try {
    const prefix = `pay.unresolved:${userId}:offer:`;
    const found = new Set<string>();
    for (const storage of [localStorage, sessionStorage]) {
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (!key?.startsWith(prefix)) continue;
        const reference = key.slice(prefix.length);
        if (id.safeParse(reference).success) found.add(reference.toLowerCase());
      }
    }
    return { ids: [...found], failed: false };
  } catch {
    return { ids: [], failed: true };
  }
}

export const offerMethods = (offer: Offer) =>
  offer.methods.flatMap((method) =>
    typeof method === 'string'
      ? [method]
      : method && typeof method === 'object' && 'id' in method && typeof method.id === 'string'
        ? [method.id]
        : [],
  );

export type BoardError = 'fiatCurrencyMustUseItsThreeLetter' | 'invalidId' | 'fiatAmountNeedsCurrency' | 'fiatAmountInvalid';

/** The board's pages under one query: the first page from the read, then "Show more" continues with the cursor. */
export function useBoardPages(
  pay: PersonalPayApi,
  first: OfferPage,
  query: BoardQuery & { makerId?: string },
  traderIds: (rows: Offer[]) => string[],
) {
  const [rows, setRows] = useState<Offer[]>(first.offers);
  const [cursor, setCursor] = useState(first.nextCursor);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  // A reload or new filters unmount these pages: a page still in flight is cancelled and never lands.
  const inflight = useRef<AbortController | null>(null);
  useEffect(() => () => inflight.current?.abort(), []);
  const more = async () => {
    if (!cursor) return;
    inflight.current?.abort();
    const controller = (inflight.current = new AbortController());
    setLoading(true);
    setFailure(null);
    const result = await pay.offerPage({ ...query, limit: PAGE, cursor }, controller.signal);
    if (controller.signal.aborted) return;
    setLoading(false);
    if (!result.ok) return setFailure(result);
    setRows((current) => {
      const seen = new Set(current.map((row) => row.id));
      return [...current, ...result.data.offers.filter((row) => !seen.has(row.id))];
    });
    setCursor(result.data.nextCursor);
  };
  const traders = useTraders(pay, traderIds(rows));
  return { rows, cursor, loading, failure, more, traders };
}

/** The board's or My offers' own state: filters from the arrival address, the chosen offer, and the lists' reads. */
export function useOffersWorkspace(pay: PersonalPayApi, userId: string | null, mine: boolean) {
  const arrival = new URL(p2pReturn(location.pathname + location.search + location.hash).href, location.origin);
  // P-ads-merchant-07: an ad opened from a share link carries its token; the ad's reads, quote and take send it.
  const sharedOfferId = new URLSearchParams(location.search).get('offerId');
  const sharedToken = new URLSearchParams(location.search).get('share');
  if (!mine && sharedOfferId && sharedToken) pay.rememberShare(sharedOfferId, sharedToken);
  const initialFilter = {
    ...(arrival.searchParams.get('asset') ? { asset: arrival.searchParams.get('asset')! } : {}),
    ...(arrival.searchParams.get('fiatCurrency') ? { fiatCurrency: arrival.searchParams.get('fiatCurrency')! } : {}),
    ...(arrival.searchParams.get('side') ? { side: arrival.searchParams.get('side') as 'buy' | 'sell' } : {}),
    ...(arrival.searchParams.get('methodId') ? { methodId: arrival.searchParams.get('methodId')! } : {}),
    // An amount means something only in one currency, as on Apply.
    ...(arrival.searchParams.get('fiatCurrency') && FIAT_AMOUNT.test(arrival.searchParams.get('fiatAmount') ?? '')
      ? { fiatAmount: arrival.searchParams.get('fiatAmount')! }
      : {}),
    // The default order is no parameter, as on Apply, so one query has one cache key.
    ...(arrival.searchParams.get('sort') === 'price_desc' ? { sort: 'price_desc' as const } : {}),
  };
  const [asset, setAsset] = useState(initialFilter.asset ?? ''),
    [fiat, setFiat] = useState(initialFilter.fiatCurrency ?? ''),
    [side, setSide] = useState(initialFilter.side ?? ''),
    [method, setMethod] = useState(initialFilter.methodId ?? ''),
    [fiatAmount, setFiatAmount] = useState(initialFilter.fiatAmount ?? ''),
    [sort, setSort] = useState<BoardSort>(initialFilter.sort ?? 'price_asc');
  const [filter, setFilter] = useState<BoardQuery>(initialFilter);
  const [reference, setReference] = useState('');
  // Offers from one person, from a counterparty page; your own offers on "Your offers". Both filtered by the service.
  const makerParam = arrival.searchParams.get('makerId');
  const maker = makerParam && id.safeParse(makerParam).success ? makerParam.toLowerCase() : '';
  const makerId = mine ? (userId ?? undefined) : maker || undefined;
  const [error, setError] = useState<BoardError | null>(null);
  const [selected, setSelected] = useState<{ id: string; serial: number } | null>(() =>
    arrival.searchParams.get('offerId') ? { id: arrival.searchParams.get('offerId')!.toLowerCase(), serial: 0 } : null,
  );
  const lifetime = useRef({ mounted: true, serial: 0, selected: selected as typeof selected });
  const returnTarget = useRef<HTMLElement | null>(null),
    marketHeading = useRef<HTMLDivElement>(null);
  const returning = useRef(false);
  useLayoutEffect(() => {
    lifetime.current.mounted = true;
    if (consumeMarketArrival(userId)) {
      marketHeading.current?.focus({ preventScroll: true });
      marketHeading.current?.scrollIntoView({ block: 'nearest' });
    }
    return () => {
      lifetime.current.mounted = false;
      lifetime.current.selected = null;
      lifetime.current.serial++;
    };
  }, []);
  useLayoutEffect(() => {
    if (!returning.current || selected) return;
    returning.current = false;
    const target = returnTarget.current?.isConnected ? returnTarget.current : marketHeading.current;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  const choose = (offerId: string, target: HTMLElement) => {
    if (!lifetime.current.mounted) return;
    const next = { id: offerId.toLowerCase(), serial: ++lifetime.current.serial };
    lifetime.current.selected = next;
    returnTarget.current = target;
    setSelected(next);
  };
  const close = () => {
    lifetime.current.selected = null;
    lifetime.current.serial++;
    if (new URLSearchParams(location.search).has('offerId')) {
      closeReturnedOffer(userId);
      return;
    }
    returning.current = true;
    setSelected(null);
  };
  const query = { ...filter, ...(makerId ? { makerId } : {}) };
  const list = useResource(
    (signal) => pay.offerPage({ ...query, limit: PAGE }, signal),
    `pay:offer-page:${userId}:${JSON.stringify(query)}`,
  );
  const [pausedRevision, setPausedRevision] = useState(0);
  const currencies = useResource((signal) => pay.fiat(signal), 'pay:fiat');
  const registeredMethods = useResource((signal) => pay.methods(signal), 'pay:registered-methods');
  const originals = deviceOriginals(userId);
  /** The filters form's submit: its checks, then the query it asks for. */
  const applyFilters = () => {
    if (fiat && fiat.length !== 3) {
      setError('fiatCurrencyMustUseItsThreeLetter');
      return;
    }
    const amount = fiatAmount.trim();
    if (amount && !FIAT_AMOUNT.test(amount)) {
      setError('fiatAmountInvalid');
      return;
    }
    // An amount means something only in one currency.
    if (amount && !fiat) {
      setError('fiatAmountNeedsCurrency');
      return;
    }
    setError(null);
    setFilter({
      ...(asset.trim() ? { asset: asset.trim() } : {}),
      ...(fiat ? { fiatCurrency: fiat } : {}),
      ...(side ? { side: side as 'buy' | 'sell' } : {}),
      ...(method ? { methodId: method } : {}),
      ...(amount ? { fiatAmount: amount } : {}),
      ...(sort !== 'price_asc' ? { sort } : {}),
    });
  };
  /** The known-reference form's submit: a valid id opens that offer. */
  const openKnown = (from: HTMLElement) => {
    if (!id.safeParse(reference.trim()).success) {
      setError('invalidId');
      return;
    }
    setError(null);
    choose(reference.trim(), from);
  };
  return {
    asset,
    setAsset,
    fiat,
    setFiat,
    side,
    setSide,
    method,
    setMethod,
    fiatAmount,
    setFiatAmount,
    sort,
    setSort,
    filter,
    setFilter,
    reference,
    setReference,
    maker,
    error,
    selected,
    lifetime,
    marketHeading,
    choose,
    close,
    query,
    list,
    pausedRevision,
    setPausedRevision,
    currencies,
    registeredMethods,
    originals,
    applyFilters,
    openKnown,
  };
}

/** One offer's inspector: its read, the device's guard for an unresolved action, and the check that resolves it. */
export function useOfferInspector({
  pay,
  userId,
  offerId,
  onMarketChange,
  current,
}: {
  pay: PersonalPayApi;
  userId: string | null;
  offerId: string;
  onMarketChange: () => void;
  current: () => boolean;
}) {
  const query = useResource((signal) => pay.offer(offerId, signal), `pay:offer:${userId}:${offerId}`);
  const key = `${userId}:offer:${offerId}`;
  const heading = useRef<HTMLHeadingElement>(null),
    originalHeading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true),
    attempt = useRef<object | null>(null);
  const recordVersion = useRef(0);
  const recordId = recordVersion.current;
  const [, notify] = useState(0);
  const [recovery, setRecovery] = useState<ApiResult<Offer> | null>(null);
  const [actionResult, setActionResult] = useState<ApiResult<Offer> | null>(null);
  const [busy, setBusy] = useState(false);
  const [arrival, setArrival] = useState(0);
  const frameCurrent = () => mounted.current && current();
  const refresh = () => {
    recordVersion.current++;
    query.reload();
  };
  const locked = Boolean(pay.guard.status(key));
  const knownReply = pay.guard.knownCleanup(key);
  useLayoutEffect(() => {
    mounted.current = true;
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'start' });
    void pay.guard.restore(key).then(() => {
      if (frameCurrent()) notify((value) => value + 1);
    });
    return () => {
      mounted.current = false;
      attempt.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    if (arrival && locked && !document.querySelector('[role="dialog"]')) {
      originalHeading.current?.focus({ preventScroll: true });
      originalHeading.current?.scrollIntoView({ block: 'start' });
    }
  }, [arrival]);
  const outcome = (result: ApiResult<Offer>) => {
    if (!frameCurrent() || (!result.ok && result.reason === 'aborted')) return;
    setActionResult(result);
    notify((value) => value + 1);
    if (pay.guard.status(key)) setArrival((value) => value + 1);
    if (result.ok || pay.guard.status(key)) onMarketChange();
    refresh();
  };
  async function checkOriginal() {
    if (attempt.current || !frameCurrent()) return;
    const active = {};
    attempt.current = active;
    setBusy(true);
    const known = pay.guard.knownProof(key);
    if (known) {
      const cleared = await pay.guard.cleanupKnown(key, frameCurrent, known);
      if (!frameCurrent() || attempt.current !== active) return;
      attempt.current = null;
      setBusy(false);
      if (cleared) {
        if (actionResult) setRecovery(actionResult);
        refresh();
      } else
        setRecovery(
          payRefusal('deviceRecoveryStorageIsUnavailableEnableSession', {
            code: 'pay.recovery_journal_unavailable',
            reason: 'not_supported',
          }),
        );
      notify((value) => value + 1);
      return;
    }
    const result = await pay.reconcileOffer(offerId, frameCurrent);
    if (!frameCurrent() || attempt.current !== active) return;
    attempt.current = null;
    setBusy(false);
    setRecovery(result);
    notify((value) => value + 1);
    refresh();
  }
  return {
    query,
    key,
    heading,
    originalHeading,
    recordVersion,
    recordId,
    recovery,
    actionResult,
    busy,
    frameCurrent,
    refresh,
    locked,
    knownReply,
    outcome,
    checkOriginal,
  };
}

/** Pause, resume or close one's own offer; a close refused for open orders says how many, in plain words. */
export async function manageOwnOffer(
  pay: PersonalPayApi,
  offer: Offer,
  action: 'pause' | 'resume' | 'close',
  {
    current,
    reviewCurrent,
    recoveryCurrent,
    outcome,
    t,
  }: {
    current: () => boolean;
    reviewCurrent: () => boolean;
    recoveryCurrent: () => boolean;
    outcome: (result: ApiResult<Offer>) => void;
    t: ReturnType<typeof myAdsCopy.useCopy>['t'];
  },
) {
  // P-ads-merchant-06: a close refused for open orders says how many, in plain words.
  const result = closeRefusal(
    await pay.manageOffer(offer.id, action, {
      expected: offer,
      current: () => current() && reviewCurrent(),
      recoveryCurrent,
    }),
    t,
  );
  outcome(result);
  return result;
}
