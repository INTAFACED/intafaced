import type { ReactNode } from 'react';
import { HIDDEN_MASK } from '@intafaced/ui/lit';
import { AGENTS_OWN_LIST } from '@intafaced/contracts/agents-own-procedures';
import { IDENTITY_KYC_STATUS } from '@intafaced/contracts/identity-kyc-procedures';
import { PROTOCOL_VENUE_WALLET_STATUS } from '@intafaced/contracts/protocol-wallet-procedures';
import type { VenueFeeTier, VenueOrder, VenuePosition } from '@intafaced/contracts/trade-venue-door';
import { useSession } from '../../features/session/session';
import { venueApi } from '../../features/trade';
import { authoredRefusal, type ApiResult } from '../../shared/api';
import { useResource, type Resource } from '../../shared/resource';
import { commandCopy } from './command-copy';
import { dec, fmtAmount, fmtUsd, isHiddenPath, str } from './deps';
import { Amount, Ghost, StatusTag } from './volt-parts';

/**
 * Home's rail under Your next step (the family picture, 25 Nov 2026): open positions and orders, the person's agents and
 * their levels, each a plain section under a hairline, each from its owner's own read. A read that fails says so; an
 * empty one says what fills it. No figure is made up.
 */

/** One rail section: its name, the door to its room, then its body. */
function Section({
  id,
  title,
  door,
  children,
}: {
  id: string;
  title: string;
  door?: { href: string; label: string };
  children: ReactNode;
}) {
  return (
    <section className="hm-rail-sec" data-testid={`home-${id}`} aria-labelledby={`home-${id}-title`}>
      <div className="hm-rail-head">
        <h2 id={`home-${id}-title`}>{title}</h2>
        {door && !isHiddenPath(door.href) ? (
          <a className="hm-link" href={door.href}>
            {door.label}
          </a>
        ) : null}
      </div>
      {children}
    </section>
  );
}

const loading = <T,>(resource: Resource<T>) => resource.status === 'loading';

/** The venue accounts the person's connected wallets own (svc-protocol's record), blocked ones left out. */
async function venueOwners(api: ReturnType<typeof useSession>['api'], signal: AbortSignal): Promise<ApiResult<string[]>> {
  const wallets = await api.call(PROTOCOL_VENUE_WALLET_STATUS, undefined, { signal });
  if (!wallets.ok) return wallets;
  return {
    ok: true,
    data: [
      ...new Set(
        wallets.data.connections
          .filter((connection) => connection.status !== 'blocked')
          .map((connection) => connection.address.toLowerCase()),
      ),
    ],
  };
}

type Open = { positions: VenuePosition[]; orders: VenueOrder[]; wallets: number };

/** Open positions and orders on every venue account the person's wallets own; one account the venue doesn't answer fails the read. */
function useOpen(): Resource<Open> {
  const { api, userId } = useSession();
  return useResource(async (signal): Promise<ApiResult<Open>> => {
    if (!userId) return authoredRefusal('aborted', { key: 'beforeDispatch' });
    const owners = await venueOwners(api, signal);
    if (!owners.ok) return owners;
    const venue = venueApi(api);
    const reads = await Promise.all(
      owners.data.map(async (owner) => {
        const [positions, orders] = await Promise.all([venue.positions(owner, signal), venue.openOrders(owner, signal)]);
        return positions.ok && orders.ok ? { positions: positions.data.value, orders: orders.data.value } : null;
      }),
    );
    if (reads.some((read) => read === null)) return authoredRefusal('error', { key: 'loadFailed' });
    return {
      ok: true,
      data: {
        positions: reads.flatMap((read) => read?.positions ?? []),
        orders: reads.flatMap((read) => read?.orders ?? []),
        wallets: owners.data.length,
      },
    };
  }, `home-open:${userId}`).resource;
}

/** The position's value at the venue's mark: size times mark price. */
const valueOf = (position: VenuePosition) => {
  const size = dec(position.size);
  const mark = dec(position.markPrice);
  return size === null || mark === null ? null : str((size * mark) / 10n ** 18n);
};
const times = (bps: number) => `${(bps / 10_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}x`;
/** Basis points as a percent, in decimals: 4.5 bps reads 0.045. */
const percentOfBps = (bps: string) => {
  const value = dec(bps);
  return value === null ? '' : str(value / 100n);
};
const signedUsd = (value: string) => fmtUsd(value, { showPlus: true });

export function OpenPositions({ hidden }: { hidden: boolean }) {
  const { t } = commandCopy.useCopy();
  const open = useOpen();
  return (
    <Section id="open" title={t('Open positions and orders')} door={{ href: '/trade/positions', label: t('Open the desk') }}>
      {loading(open) ? (
        <Ghost shape="rows" count={2} />
      ) : open.status === 'failed' ? (
        <p className="lt-hint" data-state="failed">
          {t('Open unread')}
        </p>
      ) : open.data.wallets === 0 ? (
        <p className="lt-hint" data-state="no-wallet">
          {t('Open no wallet')}
        </p>
      ) : open.data.positions.length + open.data.orders.length === 0 ? (
        <p className="lt-hint" data-state="none">
          {t('Open none')}
        </p>
      ) : (
        <ul className="hm-rail-rows">
          {open.data.positions.map((position) => (
            <li key={`p:${position.symbol}:${position.side}`} data-row="position">
              <span className="hm-rail-lines">
                <span>{position.symbol}</span>
                <span className="lt-hint">
                  {t(position.side === 'long' ? 'Long {times}' : 'Short {times}', { times: times(position.leverageBps) })}
                  {' · '}
                  <Amount value={fmtUsd(valueOf(position))} hidden={hidden} />
                </span>
              </span>
              <span className="hm-rail-figure" data-sign={position.unrealisedPnl.startsWith('-') ? 'down' : 'up'}>
                <Amount value={signedUsd(position.unrealisedPnl)} hidden={hidden} />
              </span>
            </li>
          ))}
          {open.data.orders.map((order, index) => (
            <li key={`o:${order.venueOrderId ?? order.venueClientOrderId ?? index}`} data-row="order">
              <span className="hm-rail-lines">
                <span>{order.symbol}</span>
                <span className="lt-hint">
                  {t(order.side === 'buy' ? 'Order buy {amount} at {price}' : 'Order sell {amount} at {price}', {
                    // The eye masks every amount on Home (J-home-ia-01 #2): the order's size as well as its price.
                    amount: hidden ? HIDDEN_MASK : fmtAmount(order.remaining),
                    price: hidden ? HIDDEN_MASK : fmtUsd(order.price),
                  })}
                </span>
              </span>
              <span className="lt-hint">{t('Order open')}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** The person's own agents (svc-agents): how many, and how many are published and can run. */
export function AgentSection() {
  const { t } = commandCopy.useCopy();
  const { api, userId } = useSession();
  const { resource: agents } = useResource((signal) => api.call(AGENTS_OWN_LIST, { limit: 50 }, { signal }), `home-agents:${userId}`);
  return (
    <Section
      id="agent"
      title={t('Agent')}
      door={{ href: '/agents', label: t(agents.status === 'ready' && agents.data.length > 0 ? 'Manage' : 'Set one up') }}
    >
      {loading(agents) ? (
        <Ghost shape="rows" count={1} />
      ) : agents.status === 'failed' ? (
        <p className="lt-hint" data-state="failed">
          {t('Agent unread')}
        </p>
      ) : agents.data.length === 0 ? (
        <p className="lt-hint" data-state="none">
          {t('Agent none')}
        </p>
      ) : (
        <ul className="hm-rail-rows">
          {agents.data.slice(0, 2).map((agent) => (
            <li key={agent.id}>
              <span className="hm-rail-lines">
                <span>{agent.name}</span>
                <span className="lt-hint">{t('Agent version {version}', { version: String(agent.version) })}</span>
              </span>
              <StatusTag
                status={agent.state === 'published' ? 'filled' : 'pending'}
                label={t(agent.state === 'published' ? 'Agent published' : 'Agent draft')}
              />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

const TIER = { none: 'Tier none', basic: 'Tier basic', full: 'Tier full', institutional: 'Tier institutional' } as const;

/** Verification from svc-identity, the fee tier and rates from the venue for the person's first venue account. */
export function LevelsSection({ hidden }: { hidden: boolean }) {
  const { t } = commandCopy.useCopy();
  const { api, userId } = useSession();
  const { resource: kyc } = useResource((signal) => api.call(IDENTITY_KYC_STATUS, { limit: 10 }, { signal }), `home-kyc:${userId}`);
  const { resource: fee } = useResource(async (signal): Promise<ApiResult<VenueFeeTier | null>> => {
    if (!userId) return authoredRefusal('aborted', { key: 'beforeDispatch' });
    const owners = await venueOwners(api, signal);
    if (!owners.ok) return owners;
    const owner = owners.data[0];
    if (!owner) return { ok: true, data: null };
    const read = await venueApi(api).feeTier(owner, signal);
    return read.ok ? { ok: true, data: read.data } : read;
  }, `home-fee-tier:${userId}`);
  const tier = kyc.status === 'ready' ? (kyc.data.tier as keyof typeof TIER) : null;
  const account = fee.status === 'ready' ? (fee.data?.value.account ?? null) : null;
  const taker = account?.perpetual.takerFeeBps;
  const volume = account?.volume;
  return (
    <Section id="levels" title={t('Your levels')} door={{ href: '/fees/my-tier', label: t('Fees') }}>
      <dl className="hm-rail-kv">
        <div>
          <dt>{t('Verification')}</dt>
          <dd>
            {kyc.status === 'loading' ? (
              <Ghost shape="text" count={1} />
            ) : tier && tier in TIER ? (
              <StatusTag status={tier === 'none' ? 'pending' : 'filled'} label={t(TIER[tier])} />
            ) : (
              <span className="lt-hint">{t('Not read')}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>{t('Fee tier')}</dt>
          <dd>
            {fee.status === 'loading' ? (
              <Ghost shape="text" count={1} />
            ) : account?.tierName ? (
              account.tierName
            ) : (
              <span className="lt-hint">{t(fee.status === 'ready' && fee.data === null ? 'Fee tier no wallet' : 'Not read')}</span>
            )}
          </dd>
        </div>
      </dl>
      {account && taker?.known ? (
        <p className="lt-hint" data-testid="home-levels-fee">
          {t('Fee line {taker} {days}', {
            taker: `${percentOfBps(taker.value)}%`,
            days: String(fee.status === 'ready' ? (fee.data?.value.schedule.volumeDays ?? '') : ''),
          })}{' '}
          {volume?.known ? <Amount value={fmtUsd(volume.value)} hidden={hidden} /> : t('Not read')}
        </p>
      ) : null}
    </Section>
  );
}
