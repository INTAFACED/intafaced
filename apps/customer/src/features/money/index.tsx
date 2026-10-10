import { copy, t as copyText, Text } from './copy';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { AssetChart } from '../trade';
import { usePreferences, savePreferences } from '../../shared/preferences';
import { useSession } from '../session/session';
import { useResource, type Resource } from '../../shared/resource';
import { displayAmount } from '../../shared/money';
import { Button, EmptyState, Failure, Page } from '../../shared/ui';
import { createMoneyClient, type Holding, type MoneyOverview } from './client';
import {
  amount,
  date,
  Continuation,
  MutationDialog,
  ResourceView,
  Section,
  usePageLimit,
  type ActionSpec,
  type BankActionContext,
} from './components';
import { BankRoutes, BankNavigation } from './rooms';
import { RepeatBuy } from './repeat-buy';
import { Withdrawal } from './Withdrawal';
import { withdrawalCopy } from './withdrawal-copy';
import { hierarchyCopy } from './hierarchy-copy';
import { pendingKey, pendingOutcomes, restorePendingOutcomes } from './pending-outcomes';
import './money.css';

const coverage = () => copyText('index.user.ledger.accounts.are.shown.by.asset');
const destinations = () => [
  { href: '/bank/spaces', label: copyText('index.spaces'), description: copyText('index.organize.quantities.within.the.same.ledger') },
  {
    href: '/bank/transfers',
    label: copyText('index.transfers'),
    description: copyText('index.move.available.funds.and.manage.standing.orders'),
  },
  { href: '/bank/earn', label: copyText('index.earn'), description: copyText('index.configured.pools.and.your.positions') },
  { href: '/bank/loans', label: copyText('index.loans'), description: copyText('index.borrowing.collateral.and.loan.health') },
  { href: '/bank/analytics', label: copyText('index.analytics'), description: copyText('index.movement.by.asset.and.date') },
];
function useOverview(limit: number) {
  const { api, userId, mode } = useSession();
  return useResource<MoneyOverview>(async (signal) => {
    if (!userId) return { ok: false, reason: 'unauthorized', message: copyText('index.sign.in.to.see.your.money') };
    if (mode === 'Business')
      return {
        ok: false,
        reason: 'not_supported',
        message: copyText('index.a.verified.company.ledger.owner.and.company'),
      };
    return { ok: true, data: await createMoneyClient(api).overview(userId, limit, signal) };
  }, `${userId}:${mode}:money:${limit}`);
}
export function HoldingPresenter({ holding, hidden = false }: { holding: Holding; hidden?: boolean }) {
  return (
    <a href={`/portfolio/${encodeURIComponent(holding.assetId)}`} className="money-holding">
      <span className="money-asset-mark" aria-hidden="true">
        {holding.assetId.slice(0, 1)}
      </span>
      <span className="money-holding-name">
        <strong>{holding.assetId}</strong>
        <small>{holding.quantity === null ? copyText('index.available.projection.only') : copyText('index.user.ledger.quantity')}</small>
      </span>
      <span className="money-holding-values">
        <strong className="numeric">{hidden ? '••••' : amount(holding.quantity ?? holding.available, holding.assetId)}</strong>
        <small>
          {hidden
            ? copyText('index.amounts.hidden')
            : copyText('index.available.2', { value1: amount(holding.available, holding.assetId) })}
        </small>
      </span>
      <span className="money-chevron" aria-hidden="true">
        ↗
      </span>
    </a>
  );
}
function ValueHero({ bank, hidden, onHide }: { bank: boolean; hidden: boolean; onHide: () => void }) {
  const { displayCurrency: currency } = usePreferences();
  return (
    <div className="money-value">
      <div className="money-value-label">
        <span>
          <Text k="index.total.account.value" />
        </span>
        <Button variant="ghost" onClick={onHide} aria-pressed={hidden}>
          {hidden ? copyText('index.show.amounts') : copyText('index.hide.amounts')}
        </Button>
      </div>
      <div className="money-total">{hidden ? '••••' : copyText('index.unavailable')}</div>
      <p className="muted">
        <Text k="index.valuation.and.complete.holdings.coverage.are.not" />{' '}
        {bank ? copyText('index.your.ledger.quantities.remain.available.below') : copyText('index.amounts.remain.in.their.own.asset')}
      </p>
      <label className="money-currency">
        <Text k="index.display.currency" />{' '}
        <select value={currency} onChange={(event) => savePreferences({ displayCurrency: event.target.value as 'USD' | 'BTC' })}>
          <option value="USD">USD</option>
          <option value="BTC">BTC</option>
        </select>
        <span>
          <Text k="index.no.conversion.or.total.is.supplied" />
        </span>
      </label>
    </div>
  );
}
function HoldingSummary({ asset, overview, hidden }: { asset: string; overview: MoneyOverview; hidden: boolean }) {
  const holding = overview.holdings.find((row) => row.assetId === asset);
  return (
    <>
      <section className="money-holding-summary" aria-label={copyText('index.your.quantity')}>
        <div className="money-value-label">
          <span>{holding?.quantity === null ? copyText('index.available.projection.only') : copyText('index.user.ledger.quantity')}</span>
          <Button variant="ghost" onClick={() => savePreferences({ hideBalances: !hidden })} aria-pressed={hidden}>
            {hidden ? copyText('index.show.amounts') : copyText('index.hide.amounts')}
          </Button>
        </div>
        {holding ? (
          <>
            <div className="money-holding-quantity numeric">{hidden ? '••••' : amount(holding.quantity ?? holding.available, asset)}</div>
            <dl className="money-holding-restrictions">
              <div>
                <dt>
                  <Text k="index.available" />
                </dt>
                <dd className="numeric">{hidden ? '••••' : amount(holding.available, asset)}</dd>
              </div>
              <div>
                <dt>
                  <Text k="index.held.restricted" />
                </dt>
                <dd className="numeric">{hidden ? '••••' : amount(holding.held, asset)}</dd>
              </div>
            </dl>
            <p className="money-caption">
              <Text k="index.exact.quantities.in.this.asset.available.excludes" />
            </p>
          </>
        ) : !overview.balances.ok ? (
          <p className="notice">
            <Text k="availability.asset.unavailable" />
          </p>
        ) : (
          <EmptyState title={copyText('index.no.holding.returned.for.this.asset')}>
            <Text k="index.this.projection.does.not.establish.a.zero" />
          </EmptyState>
        )}
      </section>
    </>
  );
}
function HoldingActionSection({ asset }: { asset: string }) {
  return (
    <Section title={copyText('holding.use.asset', { asset })} description={copyText('holding.task.context', { asset })}>
      <div className="money-action-grid">
        <a className="button button--chrome" href={`/exchange?asset=${encodeURIComponent(asset)}&side=buy`}>
          <Text k="index.buy" /> {asset}
        </a>
        <a className="button button--chrome" href={`/exchange?asset=${encodeURIComponent(asset)}&side=sell`}>
          <Text k="index.sell" /> {asset}
        </a>
      </div>
      <a className="button button--primary money-holding-send" href={`/pay/send?asset=${encodeURIComponent(asset)}`}>
        <Text k="index.send.available" /> {asset} ↗
      </a>
      <p className="money-caption">{copyText('holding.send.source', { asset })}</p>
      <div className="money-holding-secondary">
        <a className="text-link" href={`/trade/convert?asset=${encodeURIComponent(asset)}`}>
          <span>{copyText('holding.convert.asset', { asset })} ↗</span>
        </a>
        <a className="text-link" href={`/portfolio/${encodeURIComponent(asset)}/repeat-buy`}>
          <span>
            <Text k="index.repeat.buy" /> ↗
          </span>
        </a>
        <a className="text-link" href={`/uc/record?asset=${encodeURIComponent(asset)}`}>
          <span>{copyText('holding.asset.activity', { asset })} ↗</span>
        </a>
      </div>
      <p className="money-caption">
        <Text k="holding.pending.unavailable" />
      </p>
    </Section>
  );
}
function HoldingAnalysis({ asset }: { asset: string }) {
  return (
    <Section
      title={copyText('index.price.and.simple.analysis')}
      description={copyText('index.published.live.spot.markets.supply.their.own')}
    >
      <AssetChart asset={asset} />
      <a className="text-link money-holding-advanced" href={`/exchange?asset=${encodeURIComponent(asset)}`}>
        <Text k="index.open.this.asset.in.trade" /> ↗
      </a>
    </Section>
  );
}
function HoldingActions({ asset }: { asset: string }) {
  return (
    <>
      <div className="money-holding-actions">
        <HoldingActionSection asset={asset} />
      </div>
      <a className="text-link" href="/bank/spaces">
        <Text k="index.manage.spaces" />
      </a>
      <p className="money-caption">
        <Text k="holding.space.alias" />
      </p>
    </>
  );
}
function AssetMark({ asset }: { asset: string }) {
  return (
    <span className="money-asset-mark" aria-hidden="true">
      {asset === 'BTC' ? (
        <span className="money-bitcoin-mark">₿</span>
      ) : asset === 'ETH' ? (
        <svg viewBox="0 0 24 32" fill="currentColor">
          <path d="m12 1 10 16-10 6L2 17Zm0 24 10-6-10 12L2 19Z" />
        </svg>
      ) : asset === 'USDT' ? (
        <svg viewBox="0 0 32 32" fill="currentColor">
          <path d="M5 5h22v5h-8v17h-6V10H5Z" />
          <ellipse cx="16" cy="14" rx="13" ry="3" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="m12 3 9 9-9 9-9-9Z" />
          <path d="M7 12h10" />
        </svg>
      )}
    </span>
  );
}
function QuantityHolding({ holding, hidden }: { holding: Holding; hidden: boolean }) {
  return (
    <a href={`/portfolio/${encodeURIComponent(holding.assetId)}`} className="money-holding">
      <AssetMark asset={holding.assetId} />
      <span className="money-holding-name">
        <strong lang="und">{holding.assetId}</strong>
        <small>{holding.quantity === null ? copyText('index.available.projection.only') : copyText('index.user.ledger.quantity')}</small>
      </span>
      <span className="money-holding-values">
        <strong className="numeric" dir="ltr">
          <span className="money-quantity-value">{hidden ? '••••' : displayAmount(holding.quantity ?? holding.available)}</span>
          {!hidden && (
            <span className="money-quantity-unit" lang="und">
              {' '}
              {holding.assetId}
            </span>
          )}
        </strong>
        <dl className="money-quantity-restrictions">
          <div>
            <dt>
              <Text k="index.available" />
            </dt>
            <dd className="numeric" dir="ltr">
              {hidden ? '••••' : amount(holding.available, holding.assetId)}
            </dd>
          </div>
          <div>
            <dt>
              <Text k="index.held.restricted" />
            </dt>
            <dd className="numeric" dir="ltr">
              {hidden ? '••••' : amount(holding.held, holding.assetId)}
            </dd>
          </div>
        </dl>
      </span>
      <span className="money-chevron" aria-hidden="true">
        ↗
      </span>
    </a>
  );
}
function MoneyHome({ resource, reload, hidden }: { resource: Resource<MoneyOverview>; reload: () => void; hidden: boolean }) {
  const { displayCurrency, timeZone } = usePreferences();
  const { t, Copy, languageFor, renderedLocale } = hierarchyCopy.useCopy();
  const timestampLanguage = languageFor('reported');
  const clock = useMemo(
    () =>
      new Intl.DateTimeFormat(timestampLanguage, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short',
        ...(timeZone === 'device' ? {} : { timeZone: timeZone === 'UTC+8' ? 'Etc/GMT-8' : 'UTC' }),
      }),
    [timestampLanguage, timeZone],
  );
  const bankDestinations = [
    { href: '/bank', label: copyText('nav.overview'), description: t('overviewNote') },
    { href: '/bank/spaces', label: copyText('nav.spaces'), description: t('spacesNote') },
    { href: '/bank/transfers', label: copyText('nav.transfers'), description: t('transfersNote') },
    { href: '/bank/earn', label: copyText('nav.earn'), description: t('earnNote') },
    { href: '/bank/loans', label: copyText('nav.loans'), description: t('loansNote') },
    { href: '/bank/analytics', label: copyText('nav.analytics'), description: t('analyticsNote') },
    { href: '/bank/cards', label: copyText('nav.cards'), description: t('cardsNote') },
    { href: '/bank/ramps', label: copyText('nav.ramps'), description: t('rampsNote') },
    { href: '/bank/business', label: t('businessBank'), description: t('businessNote') },
  ];
  return (
    <div className="money-home" lang={renderedLocale}>
      <Page
        eyebrow={copyText('index.your.money')}
        title={copyText('index.money')}
        actions={
          <div className="money-primary-actions">
            <a className="button button--primary" href="/pay/send">
              <Text k="index.send" />
            </a>
            <a className="button button--secondary" href="/pay/receive">
              <Text k="index.receive" />
            </a>
            <a className="button button--secondary" href="/uc/record">
              <Copy k="activity" />
            </a>
          </div>
        }
      >
        <div className="money-value">
          <div className="money-value-copy">
            <div className="money-total">
              <Copy k="combined" />
            </div>
            <p className="muted">
              <Copy k="combinedNote" />
            </p>
          </div>
          <div className="money-value-controls">
            <label className="money-currency">
              <Text k="index.display.currency" />
              <select
                value={displayCurrency}
                onChange={(event) => savePreferences({ displayCurrency: event.target.value as 'USD' | 'BTC' })}
              >
                <option value="USD">USD</option>
                <option value="BTC">BTC</option>
              </select>
            </label>
            <Button variant="ghost" onClick={() => savePreferences({ hideBalances: !hidden })} aria-pressed={hidden}>
              {hidden ? copyText('index.show.amounts') : copyText('index.hide.amounts')}
            </Button>
          </div>
        </div>
        <div className="money-layout">
          <div className="money-overview-lane">
            <Section
              title={t('assets')}
              actions={
                <Button variant="ghost" onClick={reload}>
                  <Text k="index.refresh" />
                </Button>
              }
            >
              <ResourceView resource={resource} reload={reload}>
                {(overview) => (
                  <>
                    {overview.balances.ok &&
                      (Number.isFinite(Date.parse(overview.balances.data.datetime)) ? (
                        <p className="money-response-time">
                          <time dateTime={overview.balances.data.datetime} dir="auto" lang={timestampLanguage}>
                            {t('reported', { time: clock.format(new Date(overview.balances.data.datetime)) })}
                          </time>
                        </p>
                      ) : (
                        <p className="money-response-time">
                          <Copy k="unavailableTime" />
                        </p>
                      ))}
                    {!overview.balances.ok && <Failure result={overview.balances} retry={reload} />}
                    {overview.conflicts.length > 0 && (
                      <p className="notice" role="status">
                        <Text k="index.separate.reads.disagree.for" />
                        {overview.conflicts.join(', ')}
                        <Text k="index.their.available.projection.is.omitted.refresh.to" />
                      </p>
                    )}
                    {overview.holdings.length ? (
                      overview.holdings.map((holding) => <QuantityHolding key={holding.assetId} holding={holding} hidden={hidden} />)
                    ) : overview.balances.ok ? (
                      <EmptyState title={copyText('index.no.user.ledger.accounts.returned')}>
                        <Text k="index.an.empty.projection.is.not.a.complete" />
                      </EmptyState>
                    ) : (
                      <div className="notice" role="status">
                        <h3>
                          <Text k="availability.holdings.unavailable" />
                        </h3>
                        <p>
                          <Text k="availability.refresh.balances" />
                        </p>
                      </div>
                    )}
                  </>
                )}
              </ResourceView>
            </Section>
            <div className="money-coverage">
              <strong>
                <Copy k="coverage" />
              </strong>
              <p>
                <Copy k="coverageNote" />
              </p>
            </div>
          </div>
          <aside className="money-action-lane">
            <Section title={copyText('index.bank')}>
              <nav className="money-destinations" aria-label={copyText('index.bank')}>
                {bankDestinations.map((destination) => (
                  <a className="link-row" href={destination.href} key={destination.href}>
                    <span>
                      <strong>{destination.label}</strong>
                      <small>{destination.description}</small>
                    </span>
                    <span aria-hidden="true">↗</span>
                  </a>
                ))}
              </nav>
            </Section>
            <Section title={t('funding')} description={t('fundingNote')}>
              <div className="money-funding-actions">
                <a className="button button--secondary" href="/uc/recharge">
                  <Text k="index.deposit.unavailable" />
                </a>
                <a className="button button--secondary" href="/uc/withdraw">
                  {withdrawalCopy.t('title')}
                </a>
                <a className="text-link" href="/uc/withdraw/address">
                  <Text k="index.withdrawal.addresses" />
                </a>
              </div>
            </Section>
          </aside>
        </div>
      </Page>
    </div>
  );
}
function MoneyOverviewPage({ bank = false, asset }: { bank?: boolean; asset?: string }) {
  const [limit, setLimit] = usePageLimit();
  const { resource, reload } = useOverview(limit);
  const { hideBalances: hidden } = usePreferences();
  if (asset)
    return (
      <Page
        eyebrow={copyText('index.your.money')}
        title={asset}
        actions={
          <a className="button button--secondary" href="/portfolio">
            {copyText('index.all.holdings')}
          </a>
        }
      >
        <div className="money-layout money-layout--holding">
          <ResourceView resource={resource} reload={reload}>
            {(overview) => (
              <>
                <div className="money-holding-primary">
                  {!overview.balances.ok && <Failure result={overview.balances} retry={reload} />}
                  {overview.conflicts.includes(asset) && (
                    <p className="notice" role="status">
                      <Text k="index.separate.reads.disagree.for" /> {asset}{' '}
                      <Text k="index.their.available.projection.is.omitted.refresh.to" />
                    </p>
                  )}
                  <HoldingSummary asset={asset} overview={overview} hidden={hidden} />
                </div>
                <aside className="money-action-lane">
                  <HoldingActions asset={asset} />
                </aside>
                <div className="money-holding-analysis">
                  <HoldingAnalysis asset={asset} />
                  <p className="notice">{coverage()}</p>
                </div>
              </>
            )}
          </ResourceView>
        </div>
      </Page>
    );
  if (!bank) return <MoneyHome resource={resource} reload={reload} hidden={hidden} />;
  return (
    <Page
      eyebrow={bank ? copyText('index.money.bank') : copyText('index.your.money')}
      title={bank ? copyText('index.bank') : copyText('index.money')}
      actions={
        <a className="button button--secondary" href="/uc/record">
          <Text k="index.money.activity" />
        </a>
      }
    >
      {bank && <BankNavigation current="Overview" />}
      <div className="money-layout">
        <div className="money-overview-lane">
          <>
            <ValueHero bank={bank} hidden={hidden} onHide={() => savePreferences({ hideBalances: !hidden })} />
            <div className="money-availability">
              <div>
                <h3>
                  <Text k="index.available" />
                </h3>
                <p>
                  <Text k="index.spendable.quantities.stay.in.their.asset.primary" />
                </p>
              </div>
              <div>
                <h3>
                  <Text k="index.held.restricted" />
                </h3>
                <p>
                  <Text k="index.order.holds.earn.and.collateral.stay.separate" />
                </p>
              </div>
            </div>
          </>
          <ResourceView resource={resource} reload={reload}>
            {(overview) => (
              <>
                {!overview.balances.ok && <Failure result={overview.balances} retry={reload} />}
                {overview.conflicts.length > 0 && (
                  <p className="notice" role="status">
                    <Text k="index.separate.reads.disagree.for" />
                    {overview.conflicts.join(', ')}
                    <Text k="index.their.available.projection.is.omitted.refresh.to" />
                  </p>
                )}
                <Section
                  title={copyText('index.holdings')}
                  description={
                    overview.balances.ok
                      ? copyText('index.user.ledger.projection.response.time', {
                          value1: date(overview.balances.data.datetime),
                        })
                      : overview.holdings.length
                        ? copyText('index.available.projections.from.bank.held.quantities.are')
                        : copyText('availability.quantities.unavailable')
                  }
                  actions={
                    <Button variant="ghost" onClick={reload}>
                      <Text k="index.refresh" />
                    </Button>
                  }
                >
                  {overview.holdings.length ? (
                    overview.holdings.map((holding) => <HoldingPresenter key={holding.assetId} holding={holding} hidden={hidden} />)
                  ) : overview.balances.ok ? (
                    <EmptyState title={copyText('index.no.user.ledger.accounts.returned')}>
                      <Text k="index.an.empty.projection.is.not.a.complete" />
                    </EmptyState>
                  ) : (
                    <div className="notice" role="status">
                      <h3>
                        <Text k="availability.holdings.unavailable" />
                      </h3>
                      <p>
                        <Text k="availability.refresh.balances" />
                      </p>
                    </div>
                  )}
                </Section>
                <p className="notice">{coverage()}</p>
                {bank && (
                  <Section
                    title={copyText('index.your.spaces')}
                    actions={
                      <a className="text-link" href="/bank/spaces">
                        <Text k="index.manage.spaces" />
                      </a>
                    }
                  >
                    {overview.spaces.ok ? (
                      <>
                        {overview.spaces.data.length ? (
                          overview.spaces.data.map((space) => (
                            <a className="money-space-row" href={`/bank/spaces?space=${encodeURIComponent(space.id)}`} key={space.id}>
                              <div>
                                <strong>{space.name}</strong>
                                <small>
                                  {space.kind === 'primary'
                                    ? copyText('index.primary.already.in.the.user.ledger.projection')
                                    : copyText('index.named.separate.ledger.subaccount')}
                                </small>
                              </div>
                              <div className="numeric">{hidden ? '••••' : amount(space.balance, space.assetId)}</div>
                            </a>
                          ))
                        ) : (
                          <EmptyState title={copyText('index.no.spaces.returned')}>
                            <Text k="index.name.a.space.to.organize.one.asset" />
                          </EmptyState>
                        )}
                        <Continuation
                          count={overview.spaces.data.length}
                          limit={limit}
                          onMore={() => setLimit(Math.min(200, limit + 50))}
                        />
                      </>
                    ) : (
                      <Failure result={overview.spaces} retry={reload} />
                    )}
                  </Section>
                )}
              </>
            )}
          </ResourceView>
          <a className="link-row" href="/uc/record">
            <span>
              <strong>
                <Text k="index.money.activity" />
              </strong>
              <small>
                <Text k="index.schedules.executions.and.ramp.outcomes" />
              </small>
            </span>
            <span>↗</span>
          </a>
        </div>
        <aside className="money-action-lane">
          <>
            <Section title={bank ? copyText('index.organize.your.money') : copyText('index.move.money')}>
              <div className="money-action-grid">
                {bank ? (
                  <>
                    <a className="button button--chrome" href="/bank/spaces#create">
                      <Text k="index.create.space" />
                    </a>
                    <a className="button button--chrome" href="/bank/transfers">
                      <Text k="index.transfer" />
                    </a>
                  </>
                ) : (
                  <>
                    <a className="button button--chrome" href="/pay/send">
                      <Text k="index.send" />
                    </a>
                    <a className="button button--chrome" href="/pay/receive">
                      <Text k="index.receive" />
                    </a>
                  </>
                )}
                <a className="button button--secondary" href="/uc/recharge">
                  <Text k="index.deposit.unavailable" />
                </a>
                <a className="button button--secondary" href="/uc/withdraw">
                  {withdrawalCopy.t('title')}
                </a>
              </div>
              <p className="money-caption">
                <Text k="index.transfers.use.available.funds.locked.spaces.cannot" />
              </p>
            </Section>
            <Section title={bank ? copyText('index.put.money.to.work') : copyText('index.bank')}>
              {destinations().map((destination) => (
                <a className="link-row" href={destination.href} key={destination.href}>
                  <span>
                    {destination.label}
                    <small>{destination.description}</small>
                  </span>
                  <span className="accent">↗</span>
                </a>
              ))}
            </Section>
            <div className="money-capability">
              <h3>
                <Text k="index.cards.cash.rails" />
              </h3>
              <p>
                <Text k="index.issuer.connectivity.must.be.verified.simulated.rails" />
              </p>
              <div className="actions">
                <a className="text-link" href="/bank/cards">
                  <Text k="index.cards" />
                </a>
                <a className="text-link" href="/bank/ramps">
                  <Text k="index.ramps" />
                </a>
              </div>
              <a className="text-link" href="/bank/business">
                <Text k="index.business.bank" />
              </a>
              <p>
                <Text k="index.membership.and.approval.policies.company.balances.remain" />
              </p>
            </div>
            <a className="text-link" href="/uc/withdraw/address">
              <Text k="index.withdrawal.addresses" />
            </a>
          </>
        </aside>
      </div>
    </Page>
  );
}
function CustodyUnavailable({ kind }: { kind: 'Deposit' | 'Withdraw' | 'Withdrawal addresses' }) {
  const labelKeys = {
    Deposit: 'custody.deposit',
    Withdraw: 'custody.withdraw',
    'Withdrawal addresses': 'custody.addresses',
  } as const;
  const labelKey = labelKeys[kind];
  const text =
    kind === 'Deposit'
      ? copyText('index.a.live.deposit.address.or.bank.funding')
      : kind === 'Withdraw'
        ? copyText('index.live.custody.withdrawal.and.delivery.confirmation.are')
        : copyText('index.live.custody.address.listing.and.address.verification');
  return (
    <Page eyebrow={copyText('index.money')} title={<Text k={labelKey} />}>
      <Section title={copyText('index.is.unavailable', { value1: copyText(labelKey) })}>
        <EmptyState title={copyText('index.custody.is.not.connected')}>{text}</EmptyState>
        <div className="actions">
          <a className="button button--secondary" href="/portfolio">
            <Text k="index.back.to.holdings" />
          </a>
          <a className="text-link" href="/bank/ramps">
            <Text k="index.inspect.bank.rail.capabilities" />
          </a>
        </div>
      </Section>
    </Page>
  );
}
export function MoneyRoutes({ path }: { path: string }) {
  const { requestedLocale } = copy.useCopy();
  return (
    <div lang={requestedLocale} style={{ display: 'contents' }}>
      <MoneyRooms path={path} />
    </div>
  );
}
function MoneyRooms({ path }: { path: string }) {
  usePreferences();
  const { api, userId, session } = useSession();
  const token = session?.accessToken ?? null;
  const version = useRef({ api, userId, token, href: location.href, epoch: 0 });
  if (
    version.current.api !== api ||
    version.current.userId !== userId ||
    version.current.token !== token ||
    version.current.href !== location.href
  )
    version.current = { api, userId, token, href: location.href, epoch: version.current.epoch + 1 };
  const context = version.current;
  const mounted = useRef(true);
  type OpenedAction = { key: number; spec: ActionSpec; context: BankActionContext };
  const original = useRef<OpenedAction | null>(null);
  const nextAction = useRef(0);
  const rendering = {};
  const rendered = useRef(rendering);
  rendered.current = rendering;
  const sameContext = () => mounted.current && version.current === context && location.href === context.href && api.canWrite();
  // canWrite here is the API's synchronous client/session identity lease,
  // not a service write permission. Owned reads still use their read contract.
  const sameReadContext = () => mounted.current && version.current === context && location.href === context.href && api.canWrite();
  const pending = pendingOutcomes(userId);
  const [action, setAction] = useState<OpenedAction | null>(null);
  const [revision, setRevision] = useState(0);
  const [, invalidateNavigation] = useState(0);
  function discard() {
    original.current = null;
    setAction(null);
  }
  useLayoutEffect(() => {
    mounted.current = true;
    const departed = () => {
      const previous = version.current;
      if (previous.href === location.href) return;
      // Observe every full-URL departure before React can batch A→B→A.
      version.current = { ...previous, href: location.href, epoch: previous.epoch + 1 };
      original.current = null;
      // Unmount private fields and handlers in this event, before retained
      // native controls can be invoked. Dispatched journal bytes stay intact.
      flushSync(() => {
        setAction(null);
        invalidateNavigation((value) => value + 1);
      });
    };
    window.addEventListener('popstate', departed);
    window.addEventListener('hashchange', departed);
    return () => {
      mounted.current = false;
      original.current = null;
      window.removeEventListener('popstate', departed);
      window.removeEventListener('hashchange', departed);
    };
  }, []);
  useLayoutEffect(() => {
    if (original.current && !original.current.context.current()) discard();
  }, [context]);
  useEffect(() => {
    let live = true;
    if (userId)
      void restorePendingOutcomes(userId)
        .catch(() => {
          // Unreadable or conflicting originals remain a conservative guard.
        })
        .finally(() => {
          if (live && mounted.current && version.current === context) setRevision((value) => value + 1);
        });
    return () => {
      live = false;
    };
  }, [userId, context]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (userId && event.key === pendingKey(userId)) setRevision((value) => value + 1);
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [userId]);
  function open(spec: ActionSpec) {
    if (rendered.current !== rendering || !sameContext() || !userId || original.current) return;
    if (pendingOutcomes(userId).length) {
      document.getElementById('bank-unconfirmed')?.scrollIntoView({ block: 'start' });
      return;
    }
    const opened: OpenedAction = {
      key: ++nextAction.current,
      spec,
      context: { current: () => sameContext() && original.current === opened },
    };
    original.current = opened;
    setAction(opened);
  }
  const pathname = path.split('?')[0]!.replace(/\/$/, '') || '/';
  const match = pathname.match(/^\/(?:portfolio|money\/asset)\/([^/]+)(\/repeat-buy)?$/);
  let content;
  if (pathname === '/bank') content = <MoneyOverviewPage bank />;
  else if (pathname.startsWith('/bank/') || pathname === '/uc/record')
    content = <BankRoutes key={`${pathname}:${revision}:${context.epoch}`} path={pathname} open={open} />;
  else if (pathname === '/uc/recharge') content = <CustodyUnavailable kind="Deposit" />;
  else if (pathname === '/uc/withdraw/address') content = <CustodyUnavailable kind="Withdrawal addresses" />;
  else if (pathname === '/uc/withdraw')
    content = (
      <Withdrawal key={`withdrawal:${context.epoch}`} context={{ current: sameReadContext }} search={new URL(context.href).search} />
    );
  else if (match?.[2])
    content = <RepeatBuy key={`${pathname}:${revision}:${context.epoch}`} asset={decodeURIComponent(match[1]!)} open={open} />;
  else content = <MoneyOverviewPage asset={match ? decodeURIComponent(match[1]!) : undefined} />;
  return (
    <>
      {pending.length > 0 && (
        <div id="bank-unconfirmed" className="page money-pending" role="alert">
          <h2>
            <Text k="index.bank.writes.are.paused.while.an.outcome" />
          </h2>
          <p>
            <Text k="index.refreshing.quantities.cannot.prove.the.outcome.of" />
          </p>
          {pending.map((record, index) => (
            <p className="money-reference" key={`${record.reference}:${index}`}>
              {record.title} · {record.reference === 'unreadable' ? <Text k="pending-outcomes.recovery.required" /> : record.procedure}
              <Text k="index.reference" />
              {record.reference}
              {Object.entries(record.recordRefs).map(([key, value]) => (
                <span key={key}>
                  {' '}
                  · {key}: {value}
                </span>
              ))}
            </p>
          ))}
          <a className="button button--secondary" href="/support">
            <Text k="index.open.support" />
          </a>
        </div>
      )}
      {content}
      {action && action.context.current() && (
        <MutationDialog
          key={action.key}
          spec={action.spec}
          context={action.context}
          onClose={() => {
            if (action.context.current()) discard();
          }}
          onDone={() => {
            if (action.context.current()) setRevision((value) => value + 1);
          }}
          onPendingChange={() => {
            if (action.context.current()) setRevision((value) => value + 1);
          }}
        />
      )}
    </>
  );
}
