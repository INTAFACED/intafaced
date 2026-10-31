import { useRef, useState, type ReactNode } from 'react';
import { navigate } from '../../../app/location';
import { useResource } from '../../../shared/resource';
import { Button, DataTable, EmptyState, Loading, Panel } from '../../../shared/ui';
import { isServiceNotConnected, networkLabel } from '../blockers';
import { BlockerNote, NoteRow, refusalWords, short, useChainRef } from '../explorer/parts';
import { WatchShell } from '../watch/AddressPage';
import { PriceChart } from './PriceChart';
import { reservesWords } from './PoolsList';
import { useExplorerWords } from './refusal';
import { bpsPercent, pairName, tokenAmount, tokenSymbol } from './format';
import { usePools } from './usePools';
import {
  isFeePolicyUnset,
  isNotAPool,
  isNotFactoryPool,
  type CandleInterval,
  type Pool,
  type PoolCursor,
  type PoolDay,
  type PoolSwapsPage,
  type PoolToken,
} from './pools-api';
import type { PoolsTranslate } from './copy';
import type { ChainRef } from '../NetworkPanels';

/**
 * One pool (D-explorer-05): its contract, tokens, fee and reserves; the last day's volume and price candles; and its
 * trades, newest first, as buys and sells of the first token. An address the published factory did not create reads
 * "not a pool" and keeps the page's layout.
 */
export function PoolPage({ address }: { address: string }) {
  const { t, api, when } = usePools();
  const words = useExplorerWords();
  const chain = useChainRef('pools:pool');
  const chainId = chain.status === 'ready' ? chain.chainId : null;
  const [interval, setWidth] = useState<CandleInterval>('1h');
  const day = useResource(
    (signal) => (chainId === null ? Promise.resolve({ ok: true as const, data: null }) : api.day(chainId, address, interval, signal)),
    `pools:day:${chainId ?? 'none'}:${address}:${interval}`,
  );
  const network = networkLabel(chainId).name;
  const { resource } = day;
  // While another candle width loads, the page keeps what it last read (facts, volume, trades and their place), and only
  // the chart says it is loading.
  const lastRead = useRef<PoolDay | null>(null);
  if (resource.status === 'ready' && resource.data) lastRead.current = resource.data;
  const shown =
    resource.status === 'ready'
      ? resource.data
      : resource.status === 'loading' && lastRead.current?.pool.address === address
        ? lastRead.current
        : null;
  let title = t('poolTitle', { pair: short(address) });
  let body: ReactNode;
  if (chain.status === 'failed') body = <BlockerNote title={t('poolRefused', { reason: refusalWords(chain.failure, words) })} />;
  else if (chain.status === 'loading' || (resource.status === 'loading' && !shown)) body = <Loading label={title} />;
  else if (resource.status === 'failed')
    body = isNotAPool(resource.failure) ? (
      <Panel title={t('notAPoolTitle')}>
        <div role="status" data-code="indexer.not_a_pool">
          <EmptyState title={t('notAPoolTitle')}>{t('notAPool', { address, network })}</EmptyState>
        </div>
      </Panel>
    ) : (
      <Panel title={t('poolFacts')}>
        <BlockerNote
          title={t('poolRefused', { reason: refusalWords(resource.failure, words) })}
          action={
            <Button variant="secondary" onClick={day.reload}>
              {t('retry')}
            </Button>
          }
        />
      </Panel>
    );
  else if (shown) {
    const { pool } = shown;
    const charting = resource.status === 'loading';
    title = t('poolTitle', { pair: pairName(pool.token0, pool.token1, t) });
    const base = tokenSymbol(pool.token0);
    const quote = tokenSymbol(pool.token1);
    body = (
      <>
        <PoolFacts pool={pool} t={t} />
        <FeesPanel key={pool.address} pool={pool.address} indexedFeeBps={pool.feeBps} t={t} />
        <Panel title={t('chartTitle')}>
          <div role="group" aria-label={t('chartWidthGroup')} className="pool-chart-widths">
            {(['5m', '1h'] as const).map((width) => (
              <Button
                key={width}
                variant={width === interval ? 'primary' : 'secondary'}
                aria-pressed={width === interval}
                onClick={() => setWidth(width)}
              >
                {t(width === '5m' ? 'chartWidth5m' : 'chartWidth1h')}
              </Button>
            ))}
          </div>
          {charting ? (
            <Loading label={t('chartTitle')} />
          ) : shown.candles === null ? (
            <p role="status">{t('chartUnread')}</p>
          ) : (
            <PriceChart
              candles={shown.candles}
              window={{
                start: Math.floor(Date.parse(shown.window.since) / 1000),
                seconds: shown.window.seconds,
                width: interval === '5m' ? 300 : 3600,
              }}
              base={base}
              quote={quote}
              width={t(interval === '5m' ? 'chartWidth5m' : 'chartWidth1h')}
              when={when}
              t={t}
            />
          )}
        </Panel>
        <Panel title={t('volumeTitle')}>
          <p data-testid="pool-volume">
            {pool.token1.decimals === null
              ? t('volumeRaw', { amount: shown.volume1, symbol: quote, swaps: shown.swaps })
              : t('volumeDay', { amount: tokenAmount(shown.volume1, pool.token1, t), symbol: quote, swaps: shown.swaps })}
          </p>
          <p className="muted">{t('asOf', { time: when(new Date(shown.asOf)) })}</p>
        </Panel>
        <Panel title={t('tradesTitle')}>
          <Trades chain={chain} pool={pool} t={t} />
        </Panel>
      </>
    );
  }
  return (
    <WatchShell title={title}>
      {body}
      <Button variant="secondary" onClick={() => navigate('/dex/pools')}>
        {t('backToPools')}
      </Button>
    </WatchShell>
  );
}

function TokenLink({ token, t }: { token: PoolToken; t: PoolsTranslate }) {
  return (
    <a href={`/dex/tokens/${token.address}`}>
      {token.name && token.symbol
        ? t('tokenLink', { name: token.name, symbol: token.symbol })
        : t('tokenUnnamed', { address: token.address })}
    </a>
  );
}

function PoolFacts({ pool, t }: { pool: Pool; t: PoolsTranslate }) {
  const rows: [string, ReactNode][] = [
    [
      t('poolAddress'),
      <a key="pool" href={`/chain/address/${pool.address}`}>
        <code>{pool.address}</code>
      </a>,
    ],
    [
      t('poolTokens'),
      <span key="tokens">
        <TokenLink token={pool.token0} t={t} /> · <TokenLink token={pool.token1} t={t} />
      </span>,
    ],
    [t('poolFee'), t('feePercent', { percent: bpsPercent(pool.feeBps) })],
    [t('hdrContracts'), t('symbolsNote')],
    [pool.reserves ? t('poolReservesAt', { height: String(pool.reserves.height) }) : t('hdrReserves'), reservesWords(pool, t)],
    [
      t('poolCreatedAt', { height: String(pool.createdHeight) }),
      <a key="created" href={`/chain/tx/${pool.createdTx}`}>
        {short(pool.createdTx)}
      </a>,
    ],
  ];
  return (
    <Panel title={t('poolFacts')}>
      <dl className="protocol-facts" aria-label={t('poolFacts')}>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

/**
 * Who gets the pool's fees (D-fees-governance-04): the protocol service reads the pool's own fee fields from the chain and
 * lists every share of the swap fee. A protocol fee request moves nothing; with the owner's fee policy blank it is
 * refused by name. Refusals here are the protocol service's, worded as such.
 */
function FeesPanel({ pool, indexedFeeBps, t }: { pool: string; indexedFeeBps: number; t: PoolsTranslate }) {
  const { api } = usePools();
  const fees = useResource((signal) => api.fees(pool, signal), `pools:fees:${pool}`);
  const [request, setRequest] = useState<{ state: 'idle' | 'sending' } | { state: 'answered'; words: string }>({ state: 'idle' });
  const ask = async () => {
    setRequest({ state: 'sending' });
    const answer = await api.requestProtocolFee(pool);
    setRequest({
      state: 'answered',
      words: answer.ok
        ? t('feesRequestAnswered')
        : isFeePolicyUnset(answer)
          ? t('feesRequestPolicyUnset')
          : t('feesRequestRefused', { reason: protocolRefusalWords(answer, t) }),
    });
  };
  const { resource } = fees;
  let read: ReactNode;
  if (resource.status === 'loading') read = <Loading label={t('feesTitle')} />;
  else if (resource.status === 'failed')
    read = (
      <div role="status" data-blocker="protocol">
        <EmptyState
          title={
            isNotFactoryPool(resource.failure)
              ? t('feesNotFactoryPool')
              : t('feesRefused', { reason: protocolRefusalWords(resource.failure, t) })
          }
        />
        <Button variant="secondary" onClick={fees.reload}>
          {t('retry')}
        </Button>
      </div>
    );
  else {
    const data = resource.data;
    read = (
      <>
        <p data-testid="pool-fee">{t('feesSwap', { percent: bpsPercent(data.feeBps) })}</p>
        {data.feeBps !== indexedFeeBps && (
          <p role="status">{t('feesDiffer', { indexed: bpsPercent(indexedFeeBps), read: bpsPercent(data.feeBps) })}</p>
        )}
        <ul aria-label={t('feesSharesLabel')}>
          {data.shares.map((share) => (
            <li key={share.to}>{t('feesShare', { to: t(SHARE_WORDS[share.to]), percent: bpsPercent(share.bps) })}</li>
          ))}
        </ul>
        {!data.thirdShare && <p data-testid="pool-fee-third">{t('feesNoThird')}</p>}
        <p className="muted">{t('feesReadAt', { height: data.blockNumber })}</p>
      </>
    );
  }
  return (
    <Panel title={t('feesTitle')} aria-label={t('feesTitle')}>
      {read}
      <p className="muted">{t('feesRequestNote')}</p>
      <Button variant="secondary" disabled={request.state === 'sending'} onClick={() => void ask()}>
        {t('feesRequest')}
      </Button>
      {request.state === 'answered' && <p role="alert">{request.words}</p>}
    </Panel>
  );
}

const SHARE_WORDS = {
  liquidity_providers: 'shareLiquidityProviders',
  creator: 'shareCreator',
  platform: 'sharePlatform',
  governance: 'shareGovernance',
} as const;

/** A protocol service refusal in words: never the indexer's wording, and never the service's machine code. */
function protocolRefusalWords(failure: { code?: string; message: string }, t: PoolsTranslate): string {
  if (isServiceNotConnected(failure.code)) return t('reasonProtocolNotConnected');
  if (failure.code === 'edge.upstream_unavailable') return t('reasonProtocolNoAnswer');
  const message = failure.message;
  if (failure.code === 'protocol.chain_unreachable' || message.startsWith('protocol.chain_unreachable')) return t('reasonNodeNoAnswer');
  if (failure.code === 'protocol.amm_factory_unset' || message.startsWith('protocol.amm_factory_unset')) return t('reasonFactoryUnset');
  return message.replace(/^[a-z_]+\.[a-z_.]+: /, '');
}

function sideWords(row: PoolSwapsPage['rows'][number], pool: Pool, t: PoolsTranslate): string {
  const symbol = tokenSymbol(pool.token0);
  if (row.side === 'buy') return t('sideBuyDetail', { symbol });
  if (row.side === 'sell') return t('sideSellDetail', { symbol });
  return t('sideBoth');
}

function Trades({ chain, pool, t }: { chain: ChainRef; pool: Pool; t: PoolsTranslate }) {
  const { api, when } = usePools();
  const words = useExplorerWords();
  const chainId = chain.status === 'ready' ? chain.chainId : null;
  const [cursor, setCursor] = useState<PoolCursor | null>(null);
  const swaps = useResource(
    (signal) =>
      chainId === null ? Promise.resolve({ ok: true as const, data: null }) : api.swaps(chainId, pool.address, signal, cursor ?? undefined),
    `pools:swaps:${chainId ?? 'none'}:${pool.address}${cursor ? `:${cursor.height}:${cursor.index}:${cursor.logIndex}` : ''}`,
  );
  const headers = [t('hdrTime'), t('hdrSide'), tokenSymbol(pool.token0), tokenSymbol(pool.token1), t('hdrTx')];
  const { resource } = swaps;
  let body: ReactNode;
  if (resource.status === 'loading')
    body = (
      <NoteRow span={headers.length}>
        <Loading label={t('tradesTitle')} />
      </NoteRow>
    );
  else if (resource.status === 'failed')
    body = (
      <NoteRow span={headers.length}>
        <BlockerNote
          title={t('tradesRefused', { reason: refusalWords(resource.failure, words) })}
          action={
            <Button variant="secondary" onClick={swaps.reload}>
              {t('retry')}
            </Button>
          }
        />
      </NoteRow>
    );
  else if (!resource.data || resource.data.rows.length === 0)
    body = (
      <NoteRow span={headers.length}>
        <EmptyState title={t('tradesEmpty')} />
      </NoteRow>
    );
  else
    body = resource.data.rows.map((row) => (
      <tr key={`${row.hash}:${row.logIndex}`} data-side={row.side}>
        <td>{when(new Date(row.timestamp * 1000))}</td>
        <td>{sideWords(row, pool, t)}</td>
        <td>{t('amountMove', { in: tokenAmount(row.amount0In, pool.token0, t), out: tokenAmount(row.amount0Out, pool.token0, t) })}</td>
        <td>{t('amountMove', { in: tokenAmount(row.amount1In, pool.token1, t), out: tokenAmount(row.amount1Out, pool.token1, t) })}</td>
        <td>
          <a href={`/chain/tx/${row.hash}`} title={row.hash}>
            {short(row.hash)}
          </a>
        </td>
      </tr>
    ));
  const next = resource.status === 'ready' ? (resource.data?.nextCursor ?? null) : null;
  return (
    <>
      <DataTable label={t('tradesTitle')} headers={headers}>
        {body}
      </DataTable>
      {next !== null && (
        <Button variant="secondary" onClick={() => setCursor(next)}>
          {t('tradesMore')}
        </Button>
      )}
    </>
  );
}
