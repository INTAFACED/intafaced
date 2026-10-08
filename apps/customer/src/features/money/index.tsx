import { copy, t as copyText, Text } from './copy';
import { useEffect, useState } from 'react';
import { AssetChart } from '../trade';
import { usePreferences, savePreferences } from '../../shared/preferences';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, EmptyState, Failure, Page } from '../../shared/ui';
import { createMoneyClient, type Holding, type MoneyOverview } from './client';
import { amount, Continuation, MutationDialog, ResourceView, Section, usePageLimit, type ActionSpec } from './components';
import { BankRoutes, BankNavigation } from './rooms';
import { RepeatBuy } from './repeat-buy';
import { pendingKey, pendingOutcomes } from './pending-outcomes';
import './money.css';

const coverage = copyText('index.user.ledger.accounts.are.shown.by.asset');
const destinations = [
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
function HoldingDetails({ asset, overview, hidden }: { asset: string; overview: MoneyOverview; hidden: boolean }) {
  const holding = overview.holdings.find((row) => row.assetId === asset);
  return (
    <>
      <Section title={copyText('index.your.quantity')} description={copyText('index.exact.quantities.in.this.asset.available.excludes')}>
        {holding ? (
          <dl className="detail-list">
            <div>
              <dt>
                <Text k="index.user.ledger.quantity" />
              </dt>
              <dd className="numeric">{hidden ? '••••' : amount(holding.quantity, asset)}</dd>
            </div>
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
        ) : !overview.balances.ok ? (
          <p className="notice">
            <Text k="availability.asset.unavailable" />
          </p>
        ) : (
          <EmptyState title={copyText('index.no.holding.returned.for.this.asset')}>
            <Text k="index.this.projection.does.not.establish.a.zero" />
          </EmptyState>
        )}
      </Section>
      <Section
        title={copyText('index.price.and.simple.analysis')}
        description={copyText('index.published.live.spot.markets.supply.their.own')}
      >
        <AssetChart asset={asset} />
        <a className="button button--secondary" href={`/exchange?asset=${encodeURIComponent(asset)}`}>
          <Text k="index.open.this.asset.in.trade" />
        </a>
      </Section>
      <Section title={copyText('index.actions')} description={copyText('index.the.selected.asset.follows.you.into.the')}>
        <div className="money-action-grid">
          <a className="button button--chrome" href={`/exchange?asset=${encodeURIComponent(asset)}&side=buy`}>
            <Text k="index.buy" />
            {asset}
          </a>
          <a className="button button--chrome" href={`/exchange?asset=${encodeURIComponent(asset)}&side=sell`}>
            <Text k="index.sell" />
            {asset}
          </a>
          <a className="button button--secondary" href={`/trade/convert?asset=${encodeURIComponent(asset)}`}>
            <Text k="index.convert" />
          </a>
          <a className="button button--secondary" href={`/portfolio/${encodeURIComponent(asset)}/repeat-buy`}>
            <Text k="index.repeat.buy" />
          </a>
          <a className="button button--secondary" href={`/pay/send?asset=${encodeURIComponent(asset)}`}>
            <Text k="index.send.available" />
            {asset}
          </a>
          <a className="button button--secondary" href={`/uc/record?asset=${encodeURIComponent(asset)}`}>
            <Text k="index.activity" />
          </a>
        </div>
        <p className="money-caption">
          <Text k="index.held.and.restricted.amounts.are.not.available" />
        </p>
      </Section>
    </>
  );
}
function MoneyOverviewPage({ bank = false, asset }: { bank?: boolean; asset?: string }) {
  const [limit, setLimit] = usePageLimit();
  const { resource, reload } = useOverview(limit);
  const { hideBalances: hidden } = usePreferences();
  return (
    <Page
      eyebrow={bank ? copyText('index.money.bank') : copyText('index.your.money')}
      title={asset ?? (bank ? copyText('index.bank') : copyText('index.money'))}
      actions={
        <a className="button button--secondary" href={asset ? '/portfolio' : '/uc/record'}>
          {asset ? copyText('index.all.holdings') : copyText('index.money.activity')}
        </a>
      }
    >
      {bank && <BankNavigation current="Overview" />}
      <div className="money-layout">
        <div className="money-overview-lane">
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
                {asset ? (
                  <HoldingDetails asset={asset} overview={overview} hidden={hidden} />
                ) : (
                  <Section
                    title={copyText('index.holdings')}
                    description={
                      overview.balances.ok
                        ? copyText('index.user.ledger.projection.response.time', {
                            value1: new Date(overview.balances.data.datetime).toLocaleString(),
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
                )}
                <p className="notice">{coverage}</p>
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
                <Text k="index.withdraw.unavailable" />
              </a>
            </div>
            <p className="money-caption">
              <Text k="index.transfers.use.available.funds.locked.spaces.cannot" />
            </p>
          </Section>
          <Section title={bank ? copyText('index.put.money.to.work') : copyText('index.bank')}>
            {destinations.map((destination) => (
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
  copy.useCopy();
  return (
    <div lang="en" style={{ display: 'contents' }}>
      <MoneyRooms path={path} />
    </div>
  );
}
function MoneyRooms({ path }: { path: string }) {
  usePreferences();
  const { userId } = useSession();
  const pending = pendingOutcomes(userId);
  const [action, setAction] = useState<ActionSpec | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (userId && event.key === pendingKey(userId)) setRevision((value) => value + 1);
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [userId]);
  function open(spec: ActionSpec) {
    if (pending.length) {
      document.getElementById('bank-unconfirmed')?.scrollIntoView({ block: 'start' });
      return;
    }
    setAction(spec);
  }
  const pathname = path.split('?')[0]!.replace(/\/$/, '') || '/';
  const match = pathname.match(/^\/(?:portfolio|money\/asset)\/([^/]+)(\/repeat-buy)?$/);
  let content;
  if (pathname === '/bank') content = <MoneyOverviewPage bank />;
  else if (pathname.startsWith('/bank/') || pathname === '/uc/record')
    content = <BankRoutes key={`${pathname}:${revision}`} path={pathname} open={open} />;
  else if (pathname === '/uc/recharge') content = <CustodyUnavailable kind="Deposit" />;
  else if (pathname === '/uc/withdraw/address') content = <CustodyUnavailable kind="Withdrawal addresses" />;
  else if (pathname === '/uc/withdraw') content = <CustodyUnavailable kind="Withdraw" />;
  else if (match?.[2]) content = <RepeatBuy key={`${pathname}:${revision}`} asset={decodeURIComponent(match[1]!)} open={open} />;
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
          {pending.map((record) => (
            <p className="money-reference" key={record.reference}>
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
      {action && (
        <MutationDialog
          key={`${userId}:${action.title}`}
          spec={action}
          onClose={() => setAction(null)}
          onDone={() => setRevision((value) => value + 1)}
          onPendingChange={() => setRevision((value) => value + 1)}
        />
      )}
    </>
  );
}
