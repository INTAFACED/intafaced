import { payCopy, PayCopy, payRefusal } from './copy';
import { useMemo, useState, type ReactNode } from 'react';
import type { ApiResult } from '../../shared/api';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { displayAmount } from '../../shared/money';
import { Button, DataTable, Field, Page } from '../../shared/ui';
import { createPersonalPayApi, type PersonalPayApi } from './pay-api';
import { PayDetails, PayNotice, PayPagination, PaySection, PayState, ReviewedAction, Status, MutationResult, PayTime } from './components';
import { id, type Offer, type Trade } from './schemas';

export function P2P({ path }: { path: string }) {
  const { api, userId } = useSession();
  const pay = useMemo(() => createPersonalPayApi(api, userId), [api, userId]);
  const params = new URLSearchParams(
    path.includes('?') ? path.slice(path.indexOf('?')) : typeof location === 'undefined' ? '' : location.search,
  );
  const current = path.split('?')[0] ?? '/p2p';
  const tradeId =
    current === '/checkuser'
      ? undefined
      : (params.get('tradeId') ?? (current === '/chat' ? params.get('id') : null) ?? path.match(/^\/p2p\/orders\/([^/?]+)/)?.[1]);
  const showOrders = current === '/uc/order' || current === '/p2p/orders';
  const showMine = current === '/uc/ad' || current === '/p2p/offers';
  const showMethods = current === '/p2p/methods' || params.get('view') === 'methods';
  const showAccess = params.get('view') === 'access';
  const publish = current === '/uc/ad/create' || current === '/uc/ad/update' || current === '/p2p/offers/new';
  const counterparty = params.get('userId') ?? params.get('userid') ?? (current === '/checkuser' ? params.get('id') : null);
  return (
    <Page
      eyebrow={payCopy.t('personalPay')}
      title={
        current === '/chat' || tradeId
          ? payCopy.t('p2pOrder')
          : current === '/checkuser'
            ? payCopy.t('counterparty')
            : publish
              ? payCopy.t('createAnOffer')
              : payCopy.t('personToPerson')
      }
      description={payCopy.t('externalPaymentLedgerEscrowAndARecorded')}
    >
      <nav className="pay-room-tabs" aria-label={payCopy.t('p2pRooms')}>
        <a href="/p2p" aria-current={!showOrders && !showMine && !showMethods && !showAccess && !publish && !tradeId ? 'page' : undefined}>
          <PayCopy k="offers" />
        </a>
        <a href="/uc/order" aria-current={showOrders ? 'page' : undefined}>
          <PayCopy k="yourOrders" />
        </a>
        <a href="/uc/ad" aria-current={showMine ? 'page' : undefined}>
          <PayCopy k="yourOffers" />
        </a>
        <a href="/p2p?view=methods" aria-current={showMethods ? 'page' : undefined}>
          <PayCopy k="paymentMethods" />
        </a>
        <a href="/p2p?view=access" aria-current={showAccess ? 'page' : undefined}>
          <PayCopy k="tradingAccess" />
        </a>
      </nav>
      {current === '/chat' || tradeId ? (
        <OrderDetail pay={pay} tradeId={tradeId ?? ''} userId={userId} />
      ) : current === '/checkuser' ? (
        counterparty && id.safeParse(counterparty).success ? (
          <Counterparty pay={pay} userId={counterparty} />
        ) : (
          <PayNotice title={payCopy.t('chooseACounterparty')}>
            <PayCopy k="openACounterpartyFromAnOfferTo" />
          </PayNotice>
        )
      ) : showOrders ? (
        <OrderList pay={pay} userId={userId} />
      ) : publish ? (
        <PublishAvailability pay={pay} />
      ) : showAccess ? (
        <TradingProgramme pay={pay} userId={userId} />
      ) : showMethods ? (
        <PaymentMethods pay={pay} userId={userId} />
      ) : (
        <OfferBoard pay={pay} userId={userId} mine={showMine} />
      )}
    </Page>
  );
}
function OfferBoard({ pay, userId, mine }: { pay: PersonalPayApi; userId: string | null; mine: boolean }) {
  const [limit, setLimit] = useState(50);
  const [asset, setAsset] = useState('');
  const [fiat, setFiat] = useState('');
  const [side, setSide] = useState('');
  const [filter, setFilter] = useState<{ asset?: string; fiatCurrency?: string; side?: 'buy' | 'sell' }>({});
  const [error, setError] = useState<'fiatCurrencyMustUseItsThreeLetter' | null>(null);
  const [opened, setOpened] = useState<Offer | null>(null);
  const list = useResource((signal) => pay.offers({ ...filter, limit }, signal), `pay:offers:${userId}:${JSON.stringify(filter)}:${limit}`);
  const currencies = useResource((signal) => pay.fiat(signal), 'pay:fiat');
  return (
    <div className="stack">
      <PaySection
        title={mine ? payCopy.t('yourOffers') : payCopy.t('offerBoard')}
        description={mine ? payCopy.t('yourOffersInsideTheLoadedMarketWindow') : payCopy.t('pricesAndRemainingQuantitiesComeFromThe')}
        action={
          <a className="text-link" href="/uc/ad/create">
            <PayCopy k="createOffer" />
          </a>
        }
      >
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
            setOpened(null);
          }}
        >
          <Field label={payCopy.t('asset')} value={asset} onChange={(event) => setAsset(event.target.value.toUpperCase())} maxLength={16} />
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
          <Button type="submit" variant="secondary">
            <PayCopy k="applyFilters" />
          </Button>
        </form>
        {error && (
          <p role="alert" className="error-text">
            {payCopy.t(error)}
          </p>
        )}
        <PayState resource={list.resource} retry={list.reload} empty={payCopy.t('noOffersReturnedForTheseFilters')}>
          {(rows) => {
            const visible = mine ? rows.filter((offer) => offer.makerId === userId) : rows;
            return (
              <>
                {visible.length ? (
                  <DataTable
                    label={payCopy.t('p2pOffers')}
                    headers={[payCopy.t('makerAsset'), payCopy.t('price'), payCopy.t('assetLimits'), payCopy.t('status'), '']}
                  >
                    {visible.map((offer) => (
                      <tr key={offer.id}>
                        <td>
                          <strong>
                            {offer.side === 'sell' ? payCopy.t('selling') : payCopy.t('buying')} {offer.asset}
                          </strong>
                          <small className="pay-cell-note">{offer.makerId}</small>
                        </td>
                        <td className="numeric">
                          {displayAmount(offer.price)} {offer.fiatCurrency}
                          <small className="pay-cell-note">
                            {offer.priceType === 'float' ? payCopy.t('floatingPriceParameter') : payCopy.t('per', { asset: offer.asset })}
                          </small>
                        </td>
                        <td className="numeric">
                          {displayAmount(offer.minAmount)} – {displayAmount(offer.maxAmount)} {offer.asset}
                          <small className="pay-cell-note">
                            {displayAmount(offer.remainingAmount)} <PayCopy k="remaining" />
                          </small>
                        </td>
                        <td>
                          <Status value={offer.status} />
                        </td>
                        <td>
                          <Button variant="ghost" onClick={() => setOpened(offer)}>
                            <PayCopy k="details" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </DataTable>
                ) : (
                  <PayNotice title={payCopy.t('noOwnOffersInThisWindow')}>
                    <PayCopy k="increaseTheWindowOrChooseFiltersTo" />
                  </PayNotice>
                )}
                <PayPagination count={rows.length} limit={limit} setLimit={setLimit} />
              </>
            );
          }}
        </PayState>
      </PaySection>
      {opened && (
        <OfferDetail
          key={opened.id}
          pay={pay}
          offer={opened}
          userId={userId}
          onChanged={() => {
            setOpened(null);
            list.reload();
          }}
        />
      )}
    </div>
  );
}
function OfferDetail({
  pay,
  offer,
  userId,
  onChanged,
}: {
  pay: PersonalPayApi;
  offer: Offer;
  userId: string | null;
  onChanged: () => void;
}) {
  const own = offer.makerId === userId;
  const [reconciled, setReconciled] = useState<ApiResult<Offer> | null>(null);
  const methodIds = offer.methods.flatMap((method) =>
    typeof method === 'string'
      ? [method]
      : method && typeof method === 'object' && 'id' in method && typeof method.id === 'string'
        ? [method.id]
        : [],
  );
  return (
    <PaySection title={`${offer.side === 'sell' ? payCopy.t('sell') : payCopy.t('buy')} ${offer.asset}`}>
      <PayDetails
        values={[
          [payCopy.t('offer'), <span lang="zxx">{offer.id}</span>],
          [payCopy.t('remainingQuantity'), `${displayAmount(offer.remainingAmount)} ${offer.asset}`],
          [
            payCopy.t('agreedPaymentMethods'),
            methodIds.length ? <span lang="zxx">{methodIds.join(', ')}</span> : payCopy.t('noUsableMethodsDeclared'),
          ],
          [payCopy.t('terms'), offer.terms ? <span lang="und">{offer.terms}</span> : payCopy.t('noTermsSupplied')],
        ]}
      />
      {own && pay.guard.status(`${userId}:offer:${offer.id}`) && (
        <div className="stack">
          <PayNotice title={payCopy.t('originalOfferActionIsUnresolved')}>
            <PayCopy k="readThisOfferAgainToVerifyThe" />
          </PayNotice>
          <Button
            variant="secondary"
            onClick={() => {
              void pay.reconcileOffer(offer.id).then((result) => {
                setReconciled(result);
                if (result.ok) onChanged();
              });
            }}
          >
            <PayCopy k="checkOriginalOfferAction" />
          </Button>
          <MutationResult result={reconciled} />
        </div>
      )}
      {own ? (
        <div className="actions">
          {offer.status !== 'closed' && (
            <>
              <ReviewedAction
                title={offer.status === 'active' ? payCopy.t('pauseOffer') : payCopy.t('resumeOffer')}
                description={payCopy.t('theServiceChecksThatYouOwnThis')}
                review={
                  <PayDetails
                    values={[
                      [payCopy.t('offer'), offer.id],
                      [payCopy.t('currentState'), offer.status],
                    ]}
                  />
                }
                perform={() => pay.manageOffer(offer.id, offer.status === 'active' ? 'pause' : 'resume')}
                onConfirmed={onChanged}
                disabled={Boolean(pay.guard.status(`${userId}:offer:${offer.id}`))}
              />
              <ReviewedAction
                title={payCopy.t('closeOffer')}
                description={payCopy.t('closeThisOfferToNewOrdersExisting')}
                perform={() => pay.manageOffer(offer.id, 'close')}
                onConfirmed={onChanged}
                disabled={Boolean(pay.guard.status(`${userId}:offer:${offer.id}`))}
              />
            </>
          )}
        </div>
      ) : (
        <>
          <a className="text-link" href={`/checkuser?userId=${encodeURIComponent(offer.makerId)}`}>
            <PayCopy k="reviewCounterparty" />
          </a>
          <PayNotice title={payCopy.t('newOrderReviewIsUnavailable')}>
            <PayCopy k="anAuthoritativeFeeAndReservationPreviewIs" />
          </PayNotice>
        </>
      )}
    </PaySection>
  );
}
function PublishAvailability({ pay }: { pay: PersonalPayApi }) {
  const health = useResource((signal) => pay.health(signal), 'pay:p2p-health');
  const methods = useResource((signal) => pay.methods(signal), 'pay:registered-methods');
  return (
    <div className="stack">
      <PayNotice title={payCopy.t('offerPublicationIsUnavailable')}>
        <PayCopy k="theP2pServiceRefusesLiveOfferCreation" />
      </PayNotice>
      <PaySection title={payCopy.t('serviceReadiness')}>
        <PayState resource={health.resource} retry={health.reload}>
          {(data) => (
            <PayDetails
              values={[
                [payCopy.t('instrumentEncryption'), data.instrumentKmsConfigured ? payCopy.t('configured') : payCopy.t('notConnected')],
                [payCopy.t('offerLimits'), data.offerLimitsPosture],
                [
                  payCopy.t('moderation'),
                  data.moderation.status === 'configured'
                    ? payCopy.t('configuredLiveReachabilityIsUnprobed')
                    : payCopy.t('noModeratorsConfigured'),
                ],
              ]}
            />
          )}
        </PayState>
      </PaySection>
      <PaySection title={payCopy.t('registeredPaymentMethods')}>
        <PayState resource={methods.resource} retry={methods.reload} empty={payCopy.t('noPaymentMethodsRegistered')}>
          {(rows) => (
            <div>
              {rows.map((method) => (
                <div className="pay-destination" key={`${method.methodId}:${method.country}`}>
                  <span>
                    {method.label}
                    <small>
                      {method.methodId} · {method.country}
                    </small>
                  </span>
                  <Status value={method.enabled ? 'enabled' : 'disabled'} />
                </div>
              ))}
              <PayPagination count={rows.length} limit={200} setLimit={() => {}} />
            </div>
          )}
        </PayState>
      </PaySection>
    </div>
  );
}
function OrderList({ pay, userId }: { pay: PersonalPayApi; userId: string | null }) {
  const [limit, setLimit] = useState(50);
  const list = useResource((signal) => pay.trades(limit, signal), `pay:orders:${userId}:${limit}`);
  return (
    <PaySection
      title={payCopy.t('yourOrders')}
      description={payCopy.t('terminalStatusAndLedgerSettlementTimeStay')}
      action={
        <Button variant="secondary" onClick={list.reload}>
          <PayCopy k="refreshOrders" />
        </Button>
      }
    >
      <PayState resource={list.resource} retry={list.reload} empty={payCopy.t('noP2pOrdersReturned')}>
        {(rows) => (
          <>
            <DataTable
              headers={[
                payCopy.t('order'),
                payCopy.t('you'),
                payCopy.t('assetQuantity'),
                payCopy.t('externalPayment'),
                payCopy.t('status'),
                '',
              ]}
              label={payCopy.t('yourP2pOrders')}
            >
              {rows.map((trade) => (
                <tr key={trade.id}>
                  <td>
                    {trade.id.slice(0, 8)}
                    <small className="pay-cell-note">
                      <PayTime value={trade.createdAt} />
                    </small>
                  </td>
                  <td>{trade.buyerId === userId ? payCopy.t('buy') : payCopy.t('sell')}</td>
                  <td className="numeric">
                    {displayAmount(trade.amount)} {trade.asset}
                  </td>
                  <td className="numeric">
                    {displayAmount(trade.fiatAmount)} {trade.fiatCurrency}
                  </td>
                  <td>
                    <Status value={trade.status} />
                    <small className="pay-cell-note">
                      {trade.settledAt ? payCopy.t('ledgerSettled') : payCopy.t('ledgerSettlementNotConfirmed')}
                    </small>
                  </td>
                  <td>
                    <a className="text-link" href={`/chat?tradeId=${encodeURIComponent(trade.id)}`}>
                      <PayCopy k="open2" />
                    </a>
                  </td>
                </tr>
              ))}
            </DataTable>
            <PayPagination count={rows.length} limit={limit} setLimit={setLimit} />
          </>
        )}
      </PayState>
    </PaySection>
  );
}
function OrderDetail({ pay, tradeId, userId }: { pay: PersonalPayApi; tradeId: string; userId: string | null }) {
  const valid = id.safeParse(tradeId).success;
  const order = useResource(
    (signal) => (valid ? pay.trade(tradeId, signal) : Promise.resolve(payRefusal('openAValidP2pOrderFromYour', { reason: 'error' }))),
    `pay:order:${userId}:${tradeId}`,
  );
  const [destinationRequested, setDestinationRequested] = useState(false);
  const destination = useResource(
    (signal) =>
      destinationRequested
        ? pay.destination(tradeId, signal)
        : Promise.resolve(payRefusal('paymentDetailsAreRevealedOnlyOnYour', { reason: 'not_supported' })),
    `pay:order-destination:${userId}:${tradeId}:${destinationRequested}`,
  );
  return (
    <PayState resource={order.resource} retry={order.reload}>
      {(trade) => (
        <div className="pay-order-grid">
          <div className="stack">
            <PaySection
              title={payCopy.t('orderDetails')}
              action={
                <Button variant="secondary" onClick={order.reload}>
                  <PayCopy k="refreshStatus" />
                </Button>
              }
            >
              <PayDetails
                values={[
                  [payCopy.t('order'), <span lang="zxx">{trade.id}</span>],
                  [payCopy.t('you'), trade.buyerId === userId ? payCopy.t('buyer') : payCopy.t('seller')],
                  [payCopy.t('orderStatus'), <Status value={trade.status} />],
                  [payCopy.t('assetQuantity'), `${displayAmount(trade.amount)} ${trade.asset}`],
                  [payCopy.t('externalPayment'), `${displayAmount(trade.fiatAmount)} ${trade.fiatCurrency}`],
                  [
                    payCopy.t('price'),
                    payCopy.t('per2', { value1: displayAmount(trade.price), fiatCurrency: trade.fiatCurrency, asset: trade.asset }),
                  ],
                  [payCopy.t('paymentMethod'), <span lang="zxx">{trade.method}</span>],
                  [payCopy.t('deadline'), trade.deadlineAt ? <PayTime value={trade.deadlineAt} /> : payCopy.t('notSupplied')],
                  [payCopy.t('ledgerSettlement'), trade.settledAt ? <PayTime value={trade.settledAt} /> : payCopy.t('notConfirmed')],
                ]}
              />
              {['released', 'cancelled'].includes(trade.status) && !trade.settledAt && (
                <PayNotice title={payCopy.t('ledgerSettlementIsNotConfirmed')}>
                  <PayCopy k="theOrderReachedATerminalStateBut" />
                </PayNotice>
              )}
              <OrderActions trade={trade} pay={pay} userId={userId} reload={order.reload} />
            </PaySection>
            <PaySection title={payCopy.t('externalPaymentDestination')} description={payCopy.t('revealingDetailsIsLoggedByTheService')}>
              {destinationRequested ? (
                <PayState resource={destination.resource} retry={destination.reload}>
                  {(data) => (
                    <PayDetails
                      values={[
                        [payCopy.t('destinationLabel'), <span lang="und">{data.label}</span>],
                        [payCopy.t('countryCurrency'), `${data.country} / ${data.fiatCurrency}`],
                        ...Object.entries(data.details).map(([label, value]): [string, ReactNode, string?] => [
                          label,
                          <span lang="und">{value}</span>,
                          'und',
                        ]),
                      ]}
                    />
                  )}
                </PayState>
              ) : (
                <Button
                  variant="secondary"
                  disabled={!['escrowed', 'fiat_sent', 'disputed'].includes(trade.status)}
                  onClick={() => setDestinationRequested(true)}
                >
                  <PayCopy k="revealAgreedPaymentDetails" />
                </Button>
              )}
            </PaySection>
          </div>
          <div className="stack">
            <PaySection title={payCopy.t('orderChat')}>
              <PayNotice title={payCopy.t('messageThreadIsNotConnected')}>
                <PayCopy k="theLegacyChatTransportIsAbsentFrom" />
              </PayNotice>
            </PaySection>
            <OrderDispute trade={trade} pay={pay} reloadOrder={order.reload} />
          </div>
        </div>
      )}
    </PayState>
  );
}
function OrderActions({ trade, pay, userId, reload }: { trade: Trade; pay: PersonalPayApi; userId: string | null; reload: () => void }) {
  const [reason, setReason] = useState('');
  const [reconciled, setReconciled] = useState<ApiResult<Trade> | null>(null);
  const locked = Boolean(pay.guard.status(`${userId}:trade:${trade.id}`));
  return (
    <div className="stack">
      {locked && (
        <PayNotice title={payCopy.t('originalOrderActionIsUnresolved')}>
          <PayCopy k="refreshOrderStatusDoNotRepeatThe" />
          <Button
            variant="secondary"
            onClick={() => {
              void pay.reconcileTrade(trade.id).then((result) => {
                setReconciled(result);
                if (result.ok) reload();
              });
            }}
          >
            <PayCopy k="checkOriginalOrderAction" />
          </Button>
        </PayNotice>
      )}
      <MutationResult result={reconciled} />
      <div className="actions">
        {trade.buyerId === userId && trade.status === 'escrowed' && (
          <ReviewedAction
            title={payCopy.t('markPaymentSent')}
            description={payCopy.t('confirmOnlyAfterSendingTheExternalPayment')}
            review={
              <PayDetails
                values={[
                  [payCopy.t('externalPayment'), `${displayAmount(trade.fiatAmount)} ${trade.fiatCurrency}`],
                  [payCopy.t('order'), <span lang="zxx">{trade.id}</span>],
                ]}
              />
            }
            perform={() => pay.manageTrade(trade.id, 'markFiatSent')}
            onConfirmed={reload}
            disabled={locked}
          />
        )}
        {trade.sellerId === userId && trade.status === 'fiat_sent' && (
          <ReviewedAction
            title={payCopy.t('releaseEscrow')}
            variant="primary"
            description={payCopy.t('confirmOnlyAfterTheExternalPaymentHas')}
            review={
              <PayDetails
                values={[
                  [payCopy.t('release'), `${displayAmount(trade.amount)} ${trade.asset}`],
                  [payCopy.t('paymentToVerify'), `${displayAmount(trade.fiatAmount)} ${trade.fiatCurrency}`],
                ]}
              />
            }
            perform={() => pay.manageTrade(trade.id, 'confirmReceived')}
            onConfirmed={reload}
            disabled={locked}
          />
        )}
      </div>
      {['created', 'escrowed'].includes(trade.status) && (
        <>
          <Field
            label={payCopy.t('cancellationReason')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={200}
          />
          <ReviewedAction
            title={payCopy.t('cancelOrder')}
            description={payCopy.t('theServiceChecksCurrentOrderStateAn')}
            perform={() => pay.manageTrade(trade.id, 'cancel', reason)}
            onConfirmed={reload}
            disabled={locked}
          />
        </>
      )}
    </div>
  );
}
function OrderDispute({ trade, pay, reloadOrder }: { trade: Trade; pay: PersonalPayApi; reloadOrder: () => void }) {
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const dispute = useResource((signal) => pay.dispute(trade.id, signal), `pay:dispute:${trade.id}:${trade.status}`);
  return (
    <PaySection title={payCopy.t('disputeAndEvidence')}>
      <p className="muted">
        <PayCopy k="anUnattendedDisputeEscalatesAndKeepsEscrow" />
      </p>
      {trade.status === 'disputed' ? (
        <PayState resource={dispute.resource} retry={dispute.reload}>
          {(data) => (
            <>
              <PayDetails
                values={[
                  [payCopy.t('reason'), data.reason],
                  [payCopy.t('status'), data.status],
                  [payCopy.t('resolution'), data.resolution ?? payCopy.t('noRuling')],
                  [payCopy.t('rulingNotes'), data.resolutionNotes ?? payCopy.t('noNotes')],
                  [payCopy.t('deadline'), data.deadlineAt],
                  [payCopy.t('escalations'), String(data.escalations)],
                ]}
              />
              {data.evidence.map((item) => (
                <div className="pay-evidence" key={item.seq}>
                  <small className="muted">{item.submittedAt ?? payCopy.t('timeNotRecorded')}</small>
                  <p>{typeof item.item === 'string' ? item.item : JSON.stringify(item.item)}</p>
                </div>
              ))}
              {data.status === 'open' && (
                <>
                  <Field
                    label={payCopy.t('addEvidence')}
                    value={evidence}
                    onChange={(event) => setEvidence(event.target.value)}
                    maxLength={4000}
                  />
                  <ReviewedAction
                    title={payCopy.t('appendEvidence')}
                    description={payCopy.t('evidenceIsAppendedToTheDisputeAnd')}
                    review={<p>{evidence}</p>}
                    perform={() => pay.appendEvidence(trade.id, evidence.trim())}
                    disabled={!evidence.trim()}
                    onConfirmed={() => {
                      setEvidence('');
                      dispute.reload();
                    }}
                  />
                </>
              )}
            </>
          )}
        </PayState>
      ) : ['escrowed', 'fiat_sent'].includes(trade.status) ? (
        <>
          <Field
            label={payCopy.t('describeThePaymentIssue')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={2000}
          />
          <ReviewedAction
            title={payCopy.t('openDispute')}
            description={payCopy.t('theServiceRecordsYourReasonOpensThe')}
            review={<p>{reason}</p>}
            perform={() => pay.openDispute(trade.id, reason.trim())}
            disabled={!reason.trim()}
            onConfirmed={() => {
              reloadOrder();
              dispute.reload();
            }}
          />
        </>
      ) : (
        <p className="muted">
          <PayCopy k="noOpenDisputeActionIsAvailableFor" />
        </p>
      )}
    </PaySection>
  );
}
function PaymentMethods({ pay, userId }: { pay: PersonalPayApi; userId: string | null }) {
  const [limit, setLimit] = useState(50);
  const instruments = useResource((signal) => pay.instruments(limit, signal), `pay:instruments:${userId}:${limit}`);
  return (
    <div className="stack">
      <PayNotice title={payCopy.t('newPaymentDestinationsAreUnavailable')}>
        <PayCopy k="theRequiredInstrumentEncryptionProviderIsAbsent" />
      </PayNotice>
      <PaySection title={payCopy.t('yourPaymentDestinationLabels')}>
        <PayState resource={instruments.resource} retry={instruments.reload} empty={payCopy.t('noPaymentDestinationHeadersReturned')}>
          {(rows) => (
            <>
              <DataTable
                label={payCopy.t('paymentDestinations')}
                headers={[payCopy.t('label'), payCopy.t('method'), payCopy.t('currencyCountry'), payCopy.t('state'), '']}
              >
                {rows.map((instrument) => (
                  <tr key={instrument.id}>
                    <td>{instrument.label || payCopy.t('unlabelledDestination')}</td>
                    <td>{instrument.methodId}</td>
                    <td>
                      {instrument.fiatCurrency} / {instrument.country}
                    </td>
                    <td>
                      <Status value={instrument.status} />
                    </td>
                    <td>
                      {instrument.status === 'active' && (
                        <ReviewedAction
                          title={payCopy.t('removeDestination')}
                          description={payCopy.t('thisRemovesTheDestinationFromFutureTrades')}
                          perform={() => pay.removeInstrument(instrument.id)}
                          onConfirmed={instruments.reload}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </DataTable>
              <PayPagination count={rows.length} limit={limit} setLimit={setLimit} />
            </>
          )}
        </PayState>
      </PaySection>
    </div>
  );
}
function Counterparty({ pay, userId }: { pay: PersonalPayApi; userId: string }) {
  const reputation = useResource((signal) => pay.reputation(userId, signal), `pay:reputation:${userId}`);
  return (
    <PaySection title={payCopy.t('counterpartyRecord')}>
      <p className="pay-account-id">{userId}</p>
      <PayState resource={reputation.resource} retry={reputation.reload}>
        {(data) => (
          <PayDetails
            values={[
              [payCopy.t('tradesRecorded'), String(data.tradesTotal)],
              [payCopy.t('completed'), String(data.completed)],
              [payCopy.t('cancelled'), String(data.cancelled)],
              [payCopy.t('disputed'), String(data.disputed)],
              [
                payCopy.t('programmeStanding'),
                data.merchant === null
                  ? payCopy.t('programmeUnavailable')
                  : data.merchant
                    ? payCopy.t('approvedP2pMerchant')
                    : payCopy.t('notApproved'),
              ],
              [payCopy.t('badges'), data.badges.join(', ') || payCopy.t('noneReturned')],
            ]}
          />
        )}
      </PayState>
    </PaySection>
  );
}
function TradingProgramme({ pay, userId }: { pay: PersonalPayApi; userId: string | null }) {
  const [reason, setReason] = useState('');
  const standing = useResource((signal) => pay.standing(signal), `pay:p2p-standing:${userId}`);
  const access = useResource((signal) => pay.apiAccess(signal), `pay:p2p-api-access:${userId}`);
  function refresh() {
    standing.reload();
    access.reload();
  }
  return (
    <div className="stack">
      <PayNotice title={payCopy.t('p2pTradingStanding')}>
        <PayCopy k="thisProgrammeIsYourPersonalP2pTrading" />
      </PayNotice>
      <PaySection
        title={payCopy.t('yourProgrammeStatus')}
        action={
          <Button variant="secondary" onClick={refresh}>
            <PayCopy k="refreshStanding" />
          </Button>
        }
      >
        <PayState resource={standing.resource} retry={standing.reload}>
          {(data) =>
            data ? (
              <div className="form-stack">
                <PayDetails
                  values={[
                    [payCopy.t('standing'), data.status],
                    [payCopy.t('applicationSubmitted'), data.appliedAt],
                    [payCopy.t('decision'), data.decidedAt ?? payCopy.t('notRecorded')],
                    [payCopy.t('tradesAtApplication'), String(data.appliedTradesTotal)],
                  ]}
                />
                {['applied', 'approved', 'suspended'].includes(data.status) && (
                  <>
                    <Field label={payCopy.t('reasonForLeaving')} value={reason} onChange={(event) => setReason(event.target.value)} />
                    <ReviewedAction
                      title={payCopy.t('leaveP2pProgramme')}
                      description={payCopy.t('withdrawYourPersonalP2pProgrammeMembershipYour')}
                      review={<p>{reason}</p>}
                      perform={() => pay.withdrawProgramme(reason.trim())}
                      onConfirmed={refresh}
                      disabled={!reason.trim()}
                    />
                  </>
                )}
                {['rejected', 'withdrawn'].includes(data.status) && (
                  <ReviewedAction
                    title={payCopy.t('reapplyToP2pProgramme')}
                    description={payCopy.t('submitANewApplicationBasedOnCurrent')}
                    perform={() => pay.applyProgramme()}
                    onConfirmed={refresh}
                  />
                )}
              </div>
            ) : (
              <div className="stack">
                <p className="muted">
                  <PayCopy k="noP2pProgrammeApplicationExistsForThis" />
                </p>
                <ReviewedAction
                  title={payCopy.t('applyToP2pProgramme')}
                  description={payCopy.t('submitAnApplicationOnYourOwnBehalf')}
                  perform={() => pay.applyProgramme()}
                  onConfirmed={refresh}
                />
              </div>
            )
          }
        </PayState>
      </PaySection>
      <PaySection title={payCopy.t('p2pApiEligibility')}>
        <PayState resource={access.resource} retry={access.reload}>
          {(data) => (
            <PayDetails
              values={[
                [
                  payCopy.t('apiStanding'),
                  data.eligible ? payCopy.t('eligibleByCurrentProgrammeStanding') : payCopy.t('notEligibleByCurrentProgrammeStanding'),
                ],
                [payCopy.t('currentCredential'), data.credential],
                [payCopy.t('disputeDecisions'), payCopy.t('interactiveHumanOnly')],
              ]}
            />
          )}
        </PayState>
      </PaySection>
    </div>
  );
}
