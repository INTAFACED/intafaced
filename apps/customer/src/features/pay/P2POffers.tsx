import { useLayoutEffect, useRef, useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button } from '@intafaced/ui';
import { Field } from './ui-kit';
import type { PersonalPayApi } from './pay-api';
import { id, type Offer } from './schemas';
import { payCopy, PayCopy, payRefusal } from './copy';
import { offerCopy } from './p2p-offer-copy';
import { shortReference } from '../../shared/reference';
import {
  MutationResult,
  PayAmount,
  PayDetails,
  PayFailure,
  PayNotice,
  PayPagination,
  PaySection,
  PayState,
  ReviewedAction,
  Status,
} from './components';
import './p2p-offer.css';
import { OfferTabs, TakeOfferPanel } from './personal/P2PDepth';
import { TraderName, TraderSummary, useTraders } from './personal/Trader';
import { filterOffers, isOwnOffer } from './personal/p2p-model';
import { p2pDepth } from './personal/p2p-depth-copy';
import { CounterpartyLink, offerReturn, p2pReturn, closeReturnedOffer, consumeMarketArrival, type P2PReturn } from './p2p-return';

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
function OfferLimits({ offer }: { offer: Offer }) {
  return (
    <span className="p2p-offer-range">
      <PayAmount value={offer.minAmount} unit={offer.asset} label={payCopy.t('assetLimits')} />
      <span>–</span>
      <PayAmount value={offer.maxAmount} unit={offer.asset} label={payCopy.t('assetLimits')} />
    </span>
  );
}
function OfferPrice({ offer }: { offer: Offer }) {
  const { Copy, t } = offerCopy.useCopy();
  return (
    <div className="p2p-offer-price">
      {offer.priceType === 'float' ? (
        <>
          <span className="muted">
            <Copy k="referenceFactor" />
          </span>
          <PayAmount value={offer.price} unit={t('multiplier')} label={t('referenceFactor')} />
          <span className="muted">
            <Copy k="unresolvedPrice" params={{ fiat: offer.fiatCurrency, asset: offer.asset }} />
          </span>
        </>
      ) : (
        <>
          <PayAmount value={offer.price} unit={`${offer.fiatCurrency} / ${offer.asset}`} label={payCopy.t('price')} />
          <span className="muted">{t('fixed')}</span>
        </>
      )}
    </div>
  );
}
/** The side from the reader's own seat: what they would do on a stranger's offer, or what they are doing on their own. */
function OfferSide({ offer, own }: { offer: Offer; own: boolean }) {
  const { t } = p2pDepth.useCopy();
  const key = own ? (offer.side === 'sell' ? 'ownSell' : 'ownBuy') : offer.side === 'sell' ? 'sideBuyFrom' : 'sideSellTo';
  return <>{t(key, { asset: offer.asset })}</>;
}
export function P2POffers({ pay, userId, mine }: { pay: PersonalPayApi; userId: string | null; mine: boolean }) {
  const { Copy, t, languageFor, directionFor } = offerCopy.useCopy();
  const arrival = new URL(p2pReturn(location.pathname + location.search + location.hash).href, location.origin);
  const initialFilter = {
    ...(arrival.searchParams.get('asset') ? { asset: arrival.searchParams.get('asset')! } : {}),
    ...(arrival.searchParams.get('fiatCurrency') ? { fiatCurrency: arrival.searchParams.get('fiatCurrency')! } : {}),
    ...(arrival.searchParams.get('side') ? { side: arrival.searchParams.get('side') as 'buy' | 'sell' } : {}),
  };
  const [limit, setLimit] = useState(arrival.searchParams.get('limit') === '200' ? 200 : 50);
  const [asset, setAsset] = useState(initialFilter.asset ?? ''),
    [fiat, setFiat] = useState(initialFilter.fiatCurrency ?? ''),
    [side, setSide] = useState(initialFilter.side ?? '');
  const [filter, setFilter] = useState<{ asset?: string; fiatCurrency?: string; side?: 'buy' | 'sell' }>(initialFilter);
  const [reference, setReference] = useState('');
  const [method, setMethod] = useState('');
  // Offers from one person, from a counterparty page. The service has no maker filter, so the window is narrowed here.
  const makerParam = arrival.searchParams.get('makerId');
  const maker = makerParam && id.safeParse(makerParam).success ? makerParam.toLowerCase() : '';
  const [error, setError] = useState<'fiatCurrencyMustUseItsThreeLetter' | 'invalidId' | null>(null);
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
  const list = useResource((signal) => pay.offers({ ...filter, limit }, signal), `pay:offers:${userId}:${JSON.stringify(filter)}:${limit}`);
  const currencies = useResource((signal) => pay.fiat(signal), 'pay:fiat');
  const registeredMethods = useResource((signal) => pay.methods(signal), 'pay:registered-methods');
  const originals = deviceOriginals(userId);
  const traders = useTraders(
    pay,
    mine || list.resource.status !== 'ready'
      ? []
      : list.resource.data.filter((offer) => !isOwnOffer(offer, userId)).map((offer) => offer.makerId),
  );
  return (
    <div className={`p2p-offer-workspace${selected ? ' has-selection' : ''}`} lang={languageFor('current')} dir={directionFor('current')}>
      <div className="p2p-offer-market" tabIndex={-1} ref={marketHeading} aria-label={payCopy.t('p2pOffers')}>
        <PaySection
          title={mine ? payCopy.t('yourOffers') : payCopy.t('offerBoard')}
          description={mine ? t('ownerWindow') : undefined}
          action={
            <a className="text-link" href="/uc/ad/create">
              <PayCopy k="createOffer" />
            </a>
          }
        >
          {originals.failed && (
            <PayNotice title={payCopy.t('recoveryStorageTitle')}>
              <Copy k="originalStorage" />{' '}
              <a className="text-link" href="/support">
                {payCopy.t('contactSupport')}
              </a>
            </PayNotice>
          )}
          {originals.ids.length > 0 && (
            <section className="p2p-offer-device" aria-label={t('originals')}>
              <h3>
                <Copy k="originals" />
              </h3>
              {originals.ids.map((ref) => (
                <Button key={ref} variant="ghost" onClick={(event) => choose(ref, event.currentTarget)}>
                  <span lang="zxx">{ref}</span>
                </Button>
              ))}
            </section>
          )}
          {!mine ? (
            <OfferTabs
              side={side as '' | 'buy' | 'sell'}
              onSide={(next) => {
                setSide(next);
                setFilter((previous) => {
                  const { side: _dropped, ...rest } = previous;
                  return next ? { ...rest, side: next } : rest;
                });
              }}
            />
          ) : null}
          {maker ? (
            <p className="p2p-notice-row">
              <span lang="zxx">{p2pDepth.t('makerNotice', { maker: shortReference(maker) })}</span>
              <a className="text-link" href={location.pathname}>
                {p2pDepth.t('makerClear')}
              </a>
            </p>
          ) : null}
          <details className="p2p-offer-filters">
            <summary>
              <Copy k="filters" />
            </summary>
            <form
              className="pay-filters"
              onSubmit={(event) => {
                event.preventDefault();
                if (fiat && fiat.length !== 3) {
                  setError('fiatCurrencyMustUseItsThreeLetter');
                  return;
                }
                setError(null);
                setFilter({
                  ...(asset.trim() ? { asset: asset.trim() } : {}),
                  ...(fiat ? { fiatCurrency: fiat } : {}),
                  ...(side ? { side: side as 'buy' | 'sell' } : {}),
                });
              }}
            >
              <Field
                label={payCopy.t('asset')}
                value={asset}
                onChange={(event) => setAsset(event.target.value.toUpperCase())}
                maxLength={16}
              />
              <label className="field">
                <PayCopy k="fiatCurrency" />
                <select value={fiat} onChange={(event) => setFiat(event.target.value)}>
                  <option value="">{payCopy.t('allReturnedCurrencies')}</option>
                  {currencies.resource.status === 'ready' &&
                    currencies.resource.data.map((currency) => (
                      <option key={currency.code} value={currency.code}>
                        {currency.code} · {currency.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                <PayCopy k="makerSide" />
                <select value={side} onChange={(event) => setSide(event.target.value)}>
                  <option value="">{payCopy.t('buyAndSell')}</option>
                  <option value="sell">{payCopy.t('sellingAsset')}</option>
                  <option value="buy">{payCopy.t('buyingAsset')}</option>
                </select>
              </label>
              <label className="field">
                {p2pDepth.t('filterMethod')}
                <select value={method} onChange={(event) => setMethod(event.target.value)}>
                  <option value="">{p2pDepth.t('anyMethod')}</option>
                  {registeredMethods.resource.status === 'ready' &&
                    [...new Map(registeredMethods.resource.data.map((entry) => [entry.methodId, entry.label])).entries()].map(
                      ([methodId, label]) => (
                        <option key={methodId} value={methodId}>
                          {label}
                        </option>
                      ),
                    )}
                </select>
              </label>
              <Button type="submit" variant="secondary">
                <PayCopy k="applyFilters" />
              </Button>
            </form>
            {currencies.resource.status === 'failed' && <PayFailure result={currencies.resource.failure} retry={currencies.reload} />}
          </details>
          {error && (
            <p role="alert" className="error-text">
              {error === 'invalidId' ? t('invalidId') : payCopy.t(error)}
            </p>
          )}
          <PayState resource={list.resource} retry={list.reload} empty={payCopy.t('noOffersReturnedForTheseFilters')}>
            {(rows) => {
              const visible = filterOffers(mine ? rows.filter((offer) => offer.makerId === userId) : rows, {
                method: method || undefined,
                makerId: maker || undefined,
              });
              return (
                <>
                  {visible.length ? (
                    <ul className="p2p-offer-list" aria-label={payCopy.t('p2pOffers')}>
                      {visible.map((offer) => {
                        const own = isOwnOffer(offer, userId);
                        const record = traders[offer.makerId.toLowerCase()];
                        return (
                          <li key={offer.id} className="p2p-offer-row" data-own={own ? 'true' : undefined}>
                            <div className="p2p-offer-maker">
                              <strong>
                                <OfferSide offer={offer} own={own} />
                              </strong>
                              {own ? (
                                mine ? null : (
                                  <span className="p2p-offer-reference">
                                    <strong>{p2pDepth.t('yourOffer')}</strong>
                                  </span>
                                )
                              ) : (
                                <>
                                  <span className="p2p-offer-reference">
                                    <TraderName record={record} />
                                  </span>
                                  <TraderSummary record={record} />
                                </>
                              )}
                              <span className="muted" lang="zxx">
                                {offerMethods(offer).join(', ') || payCopy.t('noUsableMethodsDeclared')}
                              </span>
                              <Status value={offer.status} />
                            </div>
                            <OfferPrice offer={offer} />
                            <div className="p2p-offer-quantities">
                              <span className="muted">
                                <Copy k="limit" />
                              </span>
                              <span>
                                <PayAmount value={offer.minAmount} unit={offer.asset} label={payCopy.t('assetLimits')} /> –{' '}
                                <PayAmount value={offer.maxAmount} unit={offer.asset} label={payCopy.t('assetLimits')} />
                              </span>
                              <span className="muted">
                                <PayCopy k="remainingQuantity" />
                              </span>
                              <PayAmount value={offer.remainingAmount} unit={offer.asset} label={payCopy.t('remainingQuantity')} />
                            </div>
                            <Button
                              className="p2p-offer-inspect"
                              variant="secondary"
                              onClick={(event) => choose(offer.id, event.currentTarget)}
                            >
                              <Copy k="inspect" />
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : mine ? (
                    <PayNotice title={payCopy.t('noOwnOffersInThisWindow')}>
                      <PayCopy k="increaseTheWindowOrChooseFiltersTo" />
                    </PayNotice>
                  ) : (
                    <PayNotice title={p2pDepth.t('offersNoneBoardTitle')}>{p2pDepth.t('offersNoneBoardBody')}</PayNotice>
                  )}
                  <PayPagination count={visible.length} fetched={rows.length} limit={limit} setLimit={setLimit} />
                </>
              );
            }}
          </PayState>
          <p className="muted">
            <Copy k="window" />
          </p>
          <Button variant="ghost" onClick={list.reload}>
            <Copy k="refreshMarket" />
          </Button>
          <details className="p2p-offer-known">
            <summary>
              <Copy k="known" />
            </summary>
            <form
              className="form-stack"
              onSubmit={(event) => {
                event.preventDefault();
                if (!id.safeParse(reference.trim()).success) {
                  setError('invalidId');
                  return;
                }
                setError(null);
                choose(reference.trim(), event.currentTarget.querySelector('button')!);
              }}
            >
              <Field label={t('knownId')} value={reference} onChange={(event) => setReference(event.target.value)} maxLength={36} />
              <Button type="submit" variant="secondary">
                <Copy k="inspect" />
              </Button>
            </form>
          </details>
        </PaySection>
      </div>
      {selected && (
        <OfferInspector
          key={selected.serial}
          pay={pay}
          userId={userId}
          offerId={selected.id}
          returnTo={offerReturn(selected.id, filter, limit)}
          mine={mine}
          onMarketChange={list.reload}
          current={() => lifetime.current.mounted && lifetime.current.selected === selected}
          close={() => {
            if (lifetime.current.selected === selected) close();
          }}
        />
      )}
    </div>
  );
}
function OfferInspector({
  pay,
  userId,
  offerId,
  returnTo,
  mine,
  onMarketChange,
  current,
  close,
}: {
  pay: PersonalPayApi;
  userId: string | null;
  offerId: string;
  returnTo: P2PReturn;
  mine: boolean;
  onMarketChange: () => void;
  current: () => boolean;
  close: () => void;
}) {
  const { Copy, t } = offerCopy.useCopy();
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
  return (
    <section className="p2p-offer-inspector" aria-label={t('current')}>
      <Button variant="ghost" onClick={close}>
        {t(mine ? 'backOwn' : 'back')}
      </Button>
      <div className="p2p-offer-identity">
        <h2 tabIndex={-1} ref={heading}>
          {t('current')}
        </h2>
        <span className="p2p-offer-reference" lang="zxx" title={offerId}>
          {shortReference(offerId)}
        </span>
      </div>
      {!locked && <MutationResult result={actionResult} title={t('current')} />}
      {locked && (
        <section className="p2p-offer-original" aria-label={knownReply ? t('replyRetained') : payCopy.t('originalOfferActionIsUnresolved')}>
          <h3 tabIndex={-1} ref={originalHeading}>
            {knownReply ? t('replyRetained') : payCopy.t('originalOfferActionIsUnresolved')}
          </h3>
          <p>
            <Copy k={knownReply ? 'replyRetainedBody' : 'originalBody'} />
          </p>
          <p lang="zxx">
            {pay.guard
              .references(key)
              .filter((ref) => ['pause', 'resume', 'close'].includes(ref))
              .join(', ')}
          </p>
          {pay.guard.problem(key) && (
            <PayNotice title={payCopy.t('recoveryStorageTitle')}>
              <PayCopy k="deviceRecoveryStorageIsUnavailableEnableSession" />
            </PayNotice>
          )}
          <MutationResult result={actionResult} title={t('current')} />
          <Button variant="secondary" disabled={busy} onClick={() => void checkOriginal()}>
            {pay.guard.knownCleanup(key) ? payCopy.t('retryLocalCleanup') : payCopy.t('checkOriginalOfferAction')}
          </Button>
          <MutationResult result={recovery} title={t('current')} />
        </section>
      )}
      {query.resource.status === 'failed' && (
        <p className="muted">
          <Copy k="unavailableBody" />
        </p>
      )}
      <PayState resource={query.resource} retry={refresh}>
        {(offer) => (
          <CurrentOffer
            key={`${offer.id}:${recordId}`}
            pay={pay}
            offer={offer}
            returnTo={returnTo}
            userId={userId}
            locked={locked}
            current={() => frameCurrent() && recordVersion.current === recordId}
            recoveryCurrent={frameCurrent}
            outcome={outcome}
          />
        )}
      </PayState>
      <Button variant="ghost" onClick={refresh}>
        <Copy k="refresh" />
      </Button>
    </section>
  );
}
function CurrentOffer({
  pay,
  offer,
  returnTo,
  userId,
  locked,
  current,
  recoveryCurrent,
  outcome,
}: {
  pay: PersonalPayApi;
  offer: Offer;
  returnTo: P2PReturn;
  userId: string | null;
  locked: boolean;
  current: () => boolean;
  recoveryCurrent: () => boolean;
  outcome: (result: ApiResult<Offer>) => void;
}) {
  const { Copy, t } = offerCopy.useCopy();
  const own = isOwnOffer(offer, userId);
  const traders = useTraders(pay, own ? [] : [offer.makerId]);
  const record = traders[offer.makerId.toLowerCase()];
  const review = (
    <div className="p2p-offer-review">
      <OfferPrice offer={offer} />
      <PayDetails
        values={[
          [payCopy.t('offer'), <span lang="zxx">{offer.id}</span>],
          [payCopy.t('makerAsset'), `${p2pDepth.t('yourOffer')} · ${offer.asset}`],
          [payCopy.t('makerSide'), <OfferSide offer={offer} own={own} />],
          [payCopy.t('currentState'), <Status value={offer.status} />],
          [payCopy.t('assetLimits'), <OfferLimits offer={offer} />],
          [
            payCopy.t('remainingQuantity'),
            <PayAmount value={offer.remainingAmount} unit={offer.asset} label={payCopy.t('remainingQuantity')} />,
          ],
          [payCopy.t('agreedPaymentMethods'), <span lang="zxx">{offerMethods(offer).join(', ')}</span>],
          [t('terms'), offer.terms ? <span lang="und">{offer.terms}</span> : payCopy.t('noTermsSupplied')],
        ]}
      />
    </div>
  );
  async function perform(action: 'pause' | 'resume' | 'close', reviewCurrent: () => boolean) {
    const result = await pay.manageOffer(offer.id, action, {
      expected: offer,
      current: () => current() && reviewCurrent(),
      recoveryCurrent,
    });
    outcome(result);
    return result;
  }
  return (
    <div className="p2p-current-offer">
      <div className="p2p-offer-role">
        <strong>
          <OfferSide offer={offer} own={own} />
        </strong>
        {own ? <strong>{p2pDepth.t('yourOffer')}</strong> : null}
        <Status value={offer.status} />
      </div>
      <OfferPrice offer={offer} />
      <PayDetails
        values={[
          [payCopy.t('assetLimits'), <OfferLimits offer={offer} />],
          [
            payCopy.t('remainingQuantity'),
            <PayAmount value={offer.remainingAmount} unit={offer.asset} label={payCopy.t('remainingQuantity')} />,
          ],
          [
            payCopy.t('agreedPaymentMethods'),
            offerMethods(offer).length ? <span lang="zxx">{offerMethods(offer).join(', ')}</span> : payCopy.t('noUsableMethodsDeclared'),
          ],
          [t('terms'), offer.terms ? <span lang="und">{offer.terms}</span> : payCopy.t('noTermsSupplied')],
          own
            ? [p2pDepth.t('yourOffer'), <OfferSide offer={offer} own />]
            : [
                p2pDepth.t('traderLabel'),
                <span className="p2p-offer-maker">
                  <strong>
                    <TraderName record={record} />
                  </strong>
                  <TraderSummary record={record} />
                </span>,
              ],
        ]}
      />
      {own ? (
        offer.status !== 'closed' &&
        !locked && (
          <div className="actions">
            <a className="button button--secondary" href={`/uc/ad/update?offerId=${encodeURIComponent(offer.id)}`}>
              {p2pDepth.t('editOffer')}
            </a>
            <ReviewedAction
              title={offer.status === 'active' ? payCopy.t('pauseOffer') : payCopy.t('resumeOffer')}
              description={payCopy.t('theServiceChecksThatYouOwnThis')}
              review={review}
              perform={(reviewCurrent) => perform(offer.status === 'active' ? 'pause' : 'resume', reviewCurrent)}
            />
            <ReviewedAction
              title={payCopy.t('closeOffer')}
              description={payCopy.t('closeThisOfferToNewOrdersExisting')}
              review={review}
              perform={(reviewCurrent) => perform('close', reviewCurrent)}
            />
          </div>
        )
      ) : (
        <>
          {id.safeParse(offer.makerId).success && (
            <CounterpartyLink userId={offer.makerId} returnTo={returnTo}>
              <PayCopy k="reviewCounterparty" />
            </CounterpartyLink>
          )}
          {offer.status === 'active' ? <TakeOfferPanel offer={offer} pay={pay} userId={userId} /> : null}
        </>
      )}
    </div>
  );
}
