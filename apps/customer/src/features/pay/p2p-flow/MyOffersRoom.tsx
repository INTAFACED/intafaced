import { Button, Field } from '@intafaced/ui/lit';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import type { PersonalPayApi } from '../pay-api';
import { payCopy } from '../copy';
import { offerCopy } from '../p2p-offer-copy';
import { shortReference } from '../../../shared/reference';
import { p2pDepth } from '../personal/p2p-depth-copy';
import { isOwnOffer } from '../personal/p2p-model';
import { offerReturn } from '../p2p-return';
import { PAGE, offerMethods, useOffersWorkspace } from '../p2p-offers-state';
import { Amount, Failure, Notice, P2PHead, Section, State, Status } from './parts';
import { BoardPages, OfferPrice, OfferSettlement, OfferSide, StateSince, TraderName, TraderSummary } from './offer-parts';
import { OfferInspector, PausedOffers } from './inspector';
import { MyAdsLifecycle } from './my-ads';
import { BulkAds, MerchantPresence } from './console';

/**
 * My offers (`/uc/ad`, `/p2p/offers`) on the flow template: the person's own ads, with the same filters, pages, paused
 * and closed ads, edit cap, presence, bulk actions and the one-offer inspector as the board's "Your offers" view
 * (`../P2POffers.tsx` with `mine`). The state is that view's own (`useOffersWorkspace`); the chosen offer opens beside
 * the list, in the summary.
 */
export function MyOffersRoom({ pay, userId }: { pay: PersonalPayApi; userId: string | null }) {
  const { Copy, t, languageFor, directionFor } = offerCopy.useCopy();
  const {
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
  } = useOffersWorkspace(pay, userId, true);
  const changed = () => {
    list.reload();
    setPausedRevision((n) => n + 1);
  };
  return (
    <FlowTemplate
      title={payCopy.t('personToPerson')}
      state={{ kind: 'ready' }}
      step={
        <div lang={languageFor('current')} dir={directionFor('current')}>
          <P2PHead current="/uc/ad" />
          <div tabIndex={-1} ref={marketHeading} aria-label={payCopy.t('p2pOffers')}>
            <Section
              title={payCopy.t('yourOffers')}
              description={t('ownerWindow')}
              action={
                <a className="lt-link" href="/uc/ad/create">
                  {payCopy.t('createOffer')}
                </a>
              }
            >
              {originals.failed && (
                <Notice title={payCopy.t('recoveryStorageTitle')}>
                  <Copy k="originalStorage" />{' '}
                  <a className="lt-link" href="/support">
                    {payCopy.t('contactSupport')}
                  </a>
                </Notice>
              )}
              {originals.ids.length > 0 && (
                <section aria-label={t('originals')}>
                  <h3>
                    <Copy k="originals" />
                  </h3>
                  {originals.ids.map((ref) => (
                    <Button key={ref} tone="quiet" onClick={(event) => choose(ref, event.currentTarget)}>
                      <span lang="zxx">{ref}</span>
                    </Button>
                  ))}
                </section>
              )}
              {maker ? (
                <p>
                  <span lang="zxx">{p2pDepth.t('makerNotice', { maker: shortReference(maker) })}</span>
                  <a className="lt-link" href={location.pathname}>
                    {p2pDepth.t('makerClear')}
                  </a>
                </p>
              ) : null}
              <details>
                <summary>
                  <Copy k="filters" />
                </summary>
                <form
                  data-testid="pay-filters"
                  onSubmit={(event) => {
                    event.preventDefault();
                    applyFilters();
                  }}
                >
                  <Field
                    label={payCopy.t('asset')}
                    value={asset}
                    onChange={(event) => setAsset(event.target.value.toUpperCase())}
                    maxLength={16}
                  />
                  <label className="lt-field">
                    {payCopy.t('fiatCurrency')}
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
                  <label className="lt-field">
                    {payCopy.t('makerSide')}
                    <select value={side} onChange={(event) => setSide(event.target.value)}>
                      <option value="">{payCopy.t('buyAndSell')}</option>
                      <option value="sell">{payCopy.t('sellingAsset')}</option>
                      <option value="buy">{payCopy.t('buyingAsset')}</option>
                    </select>
                  </label>
                  <label className="lt-field">
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
                  <Field
                    label={t('fiatAmount')}
                    value={fiatAmount}
                    inputMode="decimal"
                    onChange={(event) => setFiatAmount(event.target.value)}
                    maxLength={40}
                  />
                  <label className="lt-field">
                    {t('sort')}
                    <select value={sort} onChange={(event) => setSort(event.target.value === 'price_desc' ? 'price_desc' : 'price_asc')}>
                      <option value="price_asc">{t('sortPriceAsc')}</option>
                      <option value="price_desc">{t('sortPriceDesc')}</option>
                    </select>
                  </label>
                  <Button type="submit">{payCopy.t('applyFilters')}</Button>
                </form>
                {currencies.resource.status === 'failed' && <Failure result={currencies.resource.failure} retry={currencies.reload} />}
              </details>
              {error && (
                <p role="alert">
                  {error === 'invalidId' || error === 'fiatAmountNeedsCurrency' || error === 'fiatAmountInvalid'
                    ? t(error)
                    : payCopy.t(error)}
                </p>
              )}
              <State resource={list.resource} retry={list.reload} empty={payCopy.t('noOffersReturnedForTheseFilters')}>
                {(first) => (
                  <BoardPages pay={pay} first={first} query={query} traderIds={() => []}>
                    {(visible, traders) => (
                      <>
                        {visible.length ? (
                          <ul aria-label={payCopy.t('p2pOffers')}>
                            {visible.map((offer) => {
                              const own = isOwnOffer(offer, userId);
                              const record = traders[offer.makerId.toLowerCase()];
                              return (
                                <li
                                  key={offer.id}
                                  data-testid="p2p-offer-row"
                                  // J-p2p-03 #6 finds My offers' row by this class (`li.p2p-offer-row`): it stays until
                                  // that step finds the row by its test id, as the board's step does.
                                  className="p2p-offer-row"
                                  data-offer-id={offer.id}
                                  data-own={own ? 'true' : undefined}
                                >
                                  <div>
                                    <strong>
                                      <OfferSide offer={offer} own={own} />
                                    </strong>
                                    {own ? null : (
                                      <>
                                        <span data-testid="p2p-offer-trader">
                                          <TraderName record={record} />
                                        </span>
                                        <TraderSummary record={record} />
                                      </>
                                    )}
                                    <span className="lt-hint" lang="zxx" data-testid="p2p-offer-methods">
                                      {offerMethods(offer).join(', ') || payCopy.t('noUsableMethodsDeclared')}
                                    </span>
                                    <OfferSettlement offer={offer} label={(methodId) => methodId} />
                                    <Status value={offer.status} />
                                  </div>
                                  <StateSince offer={offer} />
                                  <OfferPrice offer={offer} />
                                  <div>
                                    <span className="lt-hint">
                                      <Copy k="limit" />
                                    </span>
                                    <span data-testid="p2p-offer-limits">
                                      <Amount value={offer.minAmount} unit={offer.asset} label={payCopy.t('assetLimits')} /> –{' '}
                                      <Amount value={offer.maxAmount} unit={offer.asset} label={payCopy.t('assetLimits')} />
                                    </span>
                                    <span className="lt-hint">{payCopy.t('remainingQuantity')}</span>
                                    <Amount value={offer.remainingAmount} unit={offer.asset} label={payCopy.t('remainingQuantity')} />
                                  </div>
                                  <Button onClick={(event) => choose(offer.id, event.currentTarget)}>
                                    <Copy k="inspect" />
                                  </Button>
                                </li>
                              );
                            })}
                          </ul>
                        ) : (
                          <Notice title={payCopy.t('noOwnOffersInThisWindow')}>{payCopy.t('increaseTheWindowOrChooseFiltersTo')}</Notice>
                        )}
                        {filter.fiatAmount ? <p className="lt-hint">{t('fiatAmountFloats')}</p> : null}
                      </>
                    )}
                  </BoardPages>
                )}
              </State>
              <PausedOffers pay={pay} userId={userId} revision={pausedRevision} choose={choose} />
              <MyAdsLifecycle
                pay={pay}
                userId={userId}
                revision={pausedRevision}
                choose={choose}
                onChanged={changed}
                side={(offer) => <OfferSide offer={offer} own />}
              />
              <MerchantPresence pay={pay} userId={userId} onChanged={() => list.reload()} />
              <BulkAds
                pay={pay}
                userId={userId}
                revision={pausedRevision}
                side={(offer) => <OfferSide offer={offer} own />}
                onChanged={changed}
              />
              <p className="lt-hint">
                <Copy k="window" />
              </p>
              <Button tone="quiet" onClick={list.reload}>
                <Copy k="refreshMarket" />
              </Button>
              <details>
                <summary>
                  <Copy k="known" />
                </summary>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    openKnown(event.currentTarget.querySelector('button') ?? event.currentTarget);
                  }}
                >
                  <Field label={t('knownId')} value={reference} onChange={(event) => setReference(event.target.value)} maxLength={36} />
                  <Button type="submit">
                    <Copy k="inspect" />
                  </Button>
                </form>
              </details>
            </Section>
          </div>
        </div>
      }
      summary={
        selected ? (
          <OfferInspector
            key={selected.serial}
            pay={pay}
            userId={userId}
            offerId={selected.id}
            returnTo={offerReturn(selected.id, filter, PAGE)}
            onMarketChange={changed}
            current={() => lifetime.current.mounted && lifetime.current.selected === selected}
            close={() => {
              if (lifetime.current.selected === selected) close();
            }}
          />
        ) : null
      }
    />
  );
}
