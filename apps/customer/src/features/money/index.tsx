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

const coverage =
  'User ledger accounts are shown by asset. Named and archived spaces are outside this projection. Primary space labels are already included. Separate reads do not establish one ledger snapshot.';
const destinations = [
  { href: '/bank/spaces', label: 'Spaces', description: 'Organize quantities within the same ledger' },
  { href: '/bank/transfers', label: 'Transfers', description: 'Move available funds and manage standing orders' },
  { href: '/bank/earn', label: 'Earn', description: 'Configured pools and your positions' },
  { href: '/bank/loans', label: 'Loans', description: 'Borrowing, collateral and loan health' },
  { href: '/bank/analytics', label: 'Analytics', description: 'Movement by asset and date' },
];
function useOverview(limit: number) {
  const { api, userId, mode } = useSession();
  return useResource<MoneyOverview>(async (signal) => {
    if (!userId) return { ok: false, reason: 'unauthorized', message: 'Sign in to see your Money.' };
    if (mode === 'Business')
      return {
        ok: false,
        reason: 'not_supported',
        message:
          'A verified company ledger owner and company balance projection are not connected. Personal quantities cannot be shown as company money.',
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
        <small>{holding.quantity === null ? 'Available projection only' : 'User ledger quantity'}</small>
      </span>
      <span className="money-holding-values">
        <strong className="numeric">{hidden ? '••••' : amount(holding.quantity ?? holding.available, holding.assetId)}</strong>
        <small>{hidden ? 'Amounts hidden' : `${amount(holding.available, holding.assetId)} available`}</small>
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
        <span>Total account value</span>
        <Button variant="ghost" onClick={onHide} aria-pressed={hidden}>
          {hidden ? 'Show amounts' : 'Hide amounts'}
        </Button>
      </div>
      <div className="money-total">{hidden ? '••••' : 'Unavailable'}</div>
      <p className="muted">
        Valuation and complete holdings coverage are not connected.{' '}
        {bank ? 'Your ledger quantities remain available below.' : 'Amounts remain in their own asset.'}
      </p>
      <label className="money-currency">
        Display currency{' '}
        <select value={currency} onChange={(event) => savePreferences({ displayCurrency: event.target.value as 'USD' | 'BTC' })}>
          <option value="USD">USD</option>
          <option value="BTC">BTC</option>
        </select>
        <span>No conversion or total is supplied.</span>
      </label>
    </div>
  );
}
function HoldingDetails({ asset, overview, hidden }: { asset: string; overview: MoneyOverview; hidden: boolean }) {
  const holding = overview.holdings.find((row) => row.assetId === asset);
  return (
    <>
      <Section title="Your quantity" description="Exact quantities in this asset. Available excludes held and restricted accounts.">
        {holding ? (
          <dl className="detail-list">
            <div>
              <dt>User ledger quantity</dt>
              <dd className="numeric">{hidden ? '••••' : amount(holding.quantity, asset)}</dd>
            </div>
            <div>
              <dt>Available</dt>
              <dd className="numeric">{hidden ? '••••' : amount(holding.available, asset)}</dd>
            </div>
            <div>
              <dt>Held & restricted</dt>
              <dd className="numeric">{hidden ? '••••' : amount(holding.held, asset)}</dd>
            </div>
          </dl>
        ) : (
          <EmptyState title="No holding returned for this asset">
            This projection does not establish a zero amount or include every owned account.
          </EmptyState>
        )}
      </Section>
      <Section title="Price and simple analysis" description="Published live spot markets supply their own quote currency and history.">
        <AssetChart asset={asset} />
        <a className="button button--secondary" href={`/exchange?asset=${encodeURIComponent(asset)}`}>
          Open this asset in Trade
        </a>
      </Section>
      <Section title="Actions" description="The selected asset follows you into the review and trading workflow.">
        <div className="money-action-grid">
          <a className="button button--chrome" href={`/exchange?asset=${encodeURIComponent(asset)}&side=buy`}>
            Buy {asset}
          </a>
          <a className="button button--chrome" href={`/exchange?asset=${encodeURIComponent(asset)}&side=sell`}>
            Sell {asset}
          </a>
          <a className="button button--secondary" href={`/trade/convert?asset=${encodeURIComponent(asset)}`}>
            Convert
          </a>
          <a className="button button--secondary" href={`/portfolio/${encodeURIComponent(asset)}/repeat-buy`}>
            Repeat buy
          </a>
          <a className="button button--secondary" href={`/pay/send?asset=${encodeURIComponent(asset)}`}>
            Send available {asset}
          </a>
          <a className="button button--secondary" href={`/uc/record?asset=${encodeURIComponent(asset)}`}>
            Activity
          </a>
        </div>
        <p className="money-caption">Held and restricted amounts are not available to send. Pending-deposit buying is not connected.</p>
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
      eyebrow={bank ? 'Money / Bank' : 'Your money'}
      title={asset ?? (bank ? 'Bank' : 'Money')}
      actions={
        <a className="button button--secondary" href={asset ? '/portfolio' : '/uc/record'}>
          {asset ? 'All holdings' : 'Money activity'}
        </a>
      }
    >
      {bank && <BankNavigation current="Overview" />}
      <div className="money-layout">
        <div className="money-overview-lane">
          <ValueHero bank={bank} hidden={hidden} onHide={() => savePreferences({ hideBalances: !hidden })} />
          <div className="money-availability">
            <div>
              <h3>Available</h3>
              <p>Spendable quantities stay in their asset. Primary space labels the same ledger account.</p>
            </div>
            <div>
              <h3>Held & restricted</h3>
              <p>Order holds, earn and collateral stay separate from available funds. Pending-deposit buying is unavailable.</p>
            </div>
          </div>
          <ResourceView resource={resource} reload={reload}>
            {(overview) => (
              <>
                {!overview.balances.ok && <Failure result={overview.balances} retry={reload} />}
                {overview.conflicts.length > 0 && (
                  <p className="notice" role="status">
                    Separate reads disagree for {overview.conflicts.join(', ')}. Their available projection is omitted; refresh to
                    reconcile.
                  </p>
                )}
                {asset ? (
                  <HoldingDetails asset={asset} overview={overview} hidden={hidden} />
                ) : (
                  <Section
                    title="Holdings"
                    description={
                      overview.balances.ok
                        ? `User ledger projection · response time ${new Date(overview.balances.data.datetime).toLocaleString()}`
                        : 'Available projections from Bank. Held quantities are unavailable.'
                    }
                    actions={
                      <Button variant="ghost" onClick={reload}>
                        Refresh
                      </Button>
                    }
                  >
                    {overview.holdings.length ? (
                      overview.holdings.map((holding) => <HoldingPresenter key={holding.assetId} holding={holding} hidden={hidden} />)
                    ) : (
                      <EmptyState title={overview.balances.ok ? 'No user ledger accounts returned' : 'No available quantities returned'}>
                        An empty projection is not a complete account total.
                      </EmptyState>
                    )}
                  </Section>
                )}
                <p className="notice">{coverage}</p>
                {bank && (
                  <Section
                    title="Your spaces"
                    actions={
                      <a className="text-link" href="/bank/spaces">
                        Manage spaces ↗
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
                                    ? 'Primary · already in the user ledger projection'
                                    : 'Named · separate ledger subaccount'}
                                </small>
                              </div>
                              <div className="numeric">{hidden ? '••••' : amount(space.balance, space.assetId)}</div>
                            </a>
                          ))
                        ) : (
                          <EmptyState title="No spaces returned">
                            Name a space to organize one asset. It stays inside the same ledger.
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
              <strong>Money activity</strong>
              <small>Schedules, executions and ramp outcomes</small>
            </span>
            <span>↗</span>
          </a>
        </div>
        <aside className="money-action-lane">
          <Section title={bank ? 'Organize your money' : 'Move money'}>
            <div className="money-action-grid">
              {bank ? (
                <>
                  <a className="button button--chrome" href="/bank/spaces#create">
                    ＋ Create space
                  </a>
                  <a className="button button--chrome" href="/bank/transfers">
                    ↔ Transfer
                  </a>
                </>
              ) : (
                <>
                  <a className="button button--chrome" href="/pay/send">
                    Send
                  </a>
                  <a className="button button--chrome" href="/pay/receive">
                    Receive
                  </a>
                </>
              )}
              <a className="button button--secondary" href="/uc/recharge">
                Deposit · unavailable
              </a>
              <a className="button button--secondary" href="/uc/withdraw">
                Withdraw · unavailable
              </a>
            </div>
            <p className="money-caption">Transfers use available funds. Locked spaces cannot be debited.</p>
          </Section>
          <Section title={bank ? 'Put money to work' : 'Bank'}>
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
            <h3>Cards & cash rails</h3>
            <p>Issuer connectivity must be verified. Simulated rails cannot become a live card or bank withdrawal.</p>
            <div className="actions">
              <a className="text-link" href="/bank/cards">
                Cards ↗
              </a>
              <a className="text-link" href="/bank/ramps">
                Ramps ↗
              </a>
            </div>
            <a className="text-link" href="/bank/business">
              Business bank ↗
            </a>
            <p>Membership and approval policies. Company balances remain unavailable.</p>
          </div>
          <a className="text-link" href="/uc/withdraw/address">
            Withdrawal addresses ↗
          </a>
        </aside>
      </div>
    </Page>
  );
}
function CustodyUnavailable({ kind }: { kind: 'Deposit' | 'Withdraw' | 'Withdrawal addresses' }) {
  const text =
    kind === 'Deposit'
      ? 'A live deposit address or bank funding instruction is not supplied by the connected customer custody contracts. No address is generated.'
      : kind === 'Withdraw'
        ? 'Live custody withdrawal and delivery confirmation are not connected. Bank ramp records are ledger simulations and cannot deliver funds to a real destination.'
        : 'Live custody address listing and address-verification contracts are not connected. No address is stored here.';
  return (
    <Page eyebrow="Money" title={kind}>
      <Section title={`${kind} is unavailable`}>
        <EmptyState title="Custody is not connected">{text}</EmptyState>
        <div className="actions">
          <a className="button button--secondary" href="/portfolio">
            Back to holdings
          </a>
          <a className="text-link" href="/bank/ramps">
            Inspect Bank rail capabilities ↗
          </a>
        </div>
      </Section>
    </Page>
  );
}
export function MoneyRoutes({ path }: { path: string }) {
  usePreferences();
  const { userId } = useSession();
  const pending = pendingOutcomes(userId);
  const [action, setAction] = useState<ActionSpec | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (userId && event.key === pendingKey(userId)) setRevision((value) => value + 1); };
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
  const match = pathname.match(/^\/portfolio\/([^/]+)(\/repeat-buy)?$/);
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
          <h2>Bank writes are paused while an outcome is unconfirmed.</h2>
          <p>
            Refreshing quantities cannot prove the outcome of an original write. Keep these references and ask Support to reconcile the
            original record.
          </p>
          {pending.map((record) => (
            <p className="money-reference" key={record.reference}>
              {record.title} · {record.procedure} · reference {record.reference}
              {Object.entries(record.recordRefs).map(([key, value]) => (
                <span key={key}>
                  {' '}
                  · {key}: {value}
                </span>
              ))}
            </p>
          ))}
          <a className="button button--secondary" href="/support">
            Open Support
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
