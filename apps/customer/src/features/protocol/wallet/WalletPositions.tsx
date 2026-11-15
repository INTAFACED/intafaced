import { useMemo } from 'react';
import { usePreferences } from '../../../shared/preferences';
import { useResource, type Resource } from '../../../shared/resource';
import { EmptyState, Loading } from '../../../shared/ui';
import { useApi } from '../../session/session';
import { createProtocolApi } from '../api';
import { createLiquidityApi } from '../liquidity/liquidity-api';
import { bpsPercent } from '../liquidity/format';
import { positionPath } from '../liquidity/Positions';
import { portfolioCopy, type PortfolioTranslate } from './portfolio-copy';
import { useWallet } from './WalletProvider';

/** The rooms each kind of position links to. */
export const LEND_ROOM = '/dex/lend';
export const VENUE_ROOM = '/dex/venue';

type Item = { key: string; kind: 'pool' | 'lending' | 'venue'; line: string; href: string | null };

const nonZero = (decimal: string) => /[1-9]/.test(decimal);
/** A share of the pool in basis points, from the share counts (bigint), rounded down. */
const shareBps = (shares: string, totalSupply: string) =>
  BigInt(totalSupply) === 0n ? 0 : Number((BigInt(shares) * 10_000n) / BigInt(totalSupply));

/** A source still loading, refused, or read; refused sources are named, never shown as "no position". */
function settle<T>(resource: Resource<T>): { state: 'loading' } | { state: 'failed'; reason: string } | { state: 'ready'; data: T } {
  if (resource.status === 'loading') return { state: 'loading' };
  if (resource.status === 'failed') return { state: 'failed', reason: resource.failure.message };
  return { state: 'ready', data: resource.data };
}

/**
 * The wallet's positions dashboard (D-portfolio-wallet-04, J-dex-protocol-06 #4): its pool shares, its lending collateral
 * and debt, and its trading venue balances, in one list, each linking to its own room. Each is read from its own contract
 * through svc-protocol at the latest block; nothing here is held by INTAFACED, and nothing here signs.
 */
export function WalletPositions() {
  const { language } = usePreferences();
  const { t } = portfolioCopy.forLocale(language);
  const wallet = useWallet();
  const transport = useApi();
  const protocol = useMemo(() => createProtocolApi(transport), [transport]);
  const liquidity = useMemo(() => createLiquidityApi(transport), [transport]);
  const account = wallet.status === 'connected' && wallet.address ? wallet.address : null;
  const none = () => Promise.resolve({ ok: true as const, data: null });
  const key = account?.toLowerCase() ?? 'none';
  const pools = useResource((signal) => (account ? liquidity.positions(account, signal) : none()), `wallet:positions:pools:${key}`);
  const lending = useResource(
    (signal) => (account ? protocol.lendingPosition(account, signal) : none()),
    `wallet:positions:lending:${key}`,
  );
  const venue = useResource((signal) => (account ? protocol.venueBalances(account, signal) : none()), `wallet:positions:venue:${key}`);
  if (!account) return <EmptyState title={t('needsWallet')} />;

  const sources = [
    { kind: 'pool' as const, read: settle(pools.resource) },
    { kind: 'lending' as const, read: settle(lending.resource) },
    { kind: 'venue' as const, read: settle(venue.resource) },
  ];
  if (sources.some((s) => s.read.state === 'loading')) return <Loading label={t('positionsTitle')} />;

  const items: Item[] = [];
  const unread: { kind: Item['kind']; reason: string }[] = [];
  const p = settle(pools.resource);
  if (p.state === 'failed') unread.push({ kind: 'pool', reason: p.reason });
  else if (p.state === 'ready' && p.data)
    for (const row of p.data.positions)
      items.push({
        key: `pool:${row.pool}`,
        kind: 'pool',
        line: t('poolLine', {
          pair: `${row.token0.symbol ?? row.token0.address} / ${row.token1.symbol ?? row.token1.address}`,
          fee: bpsPercent(row.feeBps),
          share: bpsPercent(shareBps(row.shares, row.totalSupply)),
        }),
        href: positionPath(row.pool, account),
      });
  const l = settle(lending.resource);
  if (l.state === 'failed') unread.push({ kind: 'lending', reason: l.reason });
  else if (l.state === 'ready' && l.data && (nonZero(l.data.collateral) || nonZero(l.data.debt)))
    items.push({
      key: `lending:${l.data.market}`,
      kind: 'lending',
      line: t('lendingLine', {
        collateral: l.data.collateral,
        collateralToken: l.data.collateralToken.symbol ?? l.data.collateralToken.address,
        debt: l.data.debt,
        borrowToken: l.data.borrowToken.symbol ?? l.data.borrowToken.address,
      }),
      href: LEND_ROOM,
    });
  const v = settle(venue.resource);
  if (v.state === 'failed') unread.push({ kind: 'venue', reason: v.reason });
  else if (v.state === 'ready' && v.data) {
    const held = v.data.assets.filter((a) => nonZero(a.total));
    if (held.length > 0)
      items.push({
        key: `venue:${v.data.venue}`,
        kind: 'venue',
        line: t('venueLine', { amounts: held.map((a) => `${a.total} ${a.token.symbol ?? a.token.address}`).join(', ') }),
        href: VENUE_ROOM,
      });
  }

  return (
    <>
      <p className="muted">{t('positionsNote')}</p>
      {items.length === 0 && unread.length === 0 ? (
        <EmptyState title={t('positionsEmpty')} />
      ) : (
        <ul aria-label={t('positionsLabel')}>
          {items.map((item) => (
            <PositionItem key={item.key} item={item} t={t} />
          ))}
          {unread.map((u) => (
            <li key={`unread:${u.kind}`} data-position-kind={u.kind}>
              <p role="status">{t('sourceUnread', { kind: kindLabel(u.kind, t), reason: u.reason })}</p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function kindLabel(kind: Item['kind'], t: PortfolioTranslate): string {
  return kind === 'pool' ? t('kindPool') : kind === 'lending' ? t('kindLending') : t('kindVenue');
}

function PositionItem({ item, t }: { item: Item; t: PortfolioTranslate }) {
  const open = item.kind === 'pool' ? t('openPool') : item.kind === 'lending' ? t('openLending') : t('openVenue');
  return (
    <li data-position-kind={item.kind}>
      <strong>{kindLabel(item.kind, t)}</strong> <span>{item.line}</span>{' '}
      {item.href && (
        <a href={item.href} aria-label={`${open}: ${item.line}`}>
          {open}
        </a>
      )}
    </li>
  );
}
