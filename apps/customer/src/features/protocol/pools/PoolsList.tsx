import { useState, type ReactNode } from 'react';
import { useResource } from '../../../shared/resource';
import { Button, DataTable, EmptyState, Loading, Panel } from '../../../shared/ui';
import { networkLabel } from '../blockers';
import { BlockerNote, NoteRow, refusalWords, short, useChainRef } from '../explorer/parts';
import { useExplorerWords } from './refusal';
import { bpsPercent, pairName, tokenAmount, tokenSymbol } from './format';
import { usePools } from './usePools';
import type { Pool, PoolCursor } from './pools-api';
import type { PoolsTranslate } from './copy';

/**
 * The /dex Pools tab (D-explorer-05): every pool the owner's published factory created, newest first, with its fee and
 * its reserves after the latest Sync the indexer stored. A blank factory, a blank page size or an indexer that does not
 * answer each keep the table and say why it is empty.
 */
export function PoolsList() {
  const { t, api } = usePools();
  const words = useExplorerWords();
  const chain = useChainRef('pools:list');
  const chainId = chain.status === 'ready' ? chain.chainId : null;
  const [cursor, setCursor] = useState<PoolCursor | null>(null);
  const pools = useResource(
    (signal) => (chainId === null ? Promise.resolve({ ok: true as const, data: null }) : api.list(chainId, signal, cursor ?? undefined)),
    `pools:list:${chainId ?? 'none'}${cursor ? `:${cursor.height}:${cursor.index}:${cursor.logIndex}` : ''}`,
  );
  const network = networkLabel(chainId).name;
  const headers = [t('hdrPool'), t('hdrContracts'), t('hdrFee'), t('hdrReserves'), t('hdrCreated')];
  const { resource } = pools;
  let body: ReactNode;
  if (chain.status === 'failed')
    body = (
      <NoteRow span={headers.length}>
        <BlockerNote title={t('poolsRefused', { reason: refusalWords(chain.failure, words) })} />
      </NoteRow>
    );
  else if (chain.status === 'loading' || resource.status === 'loading')
    body = (
      <NoteRow span={headers.length}>
        <Loading label={t('poolsTitle')} />
      </NoteRow>
    );
  else if (resource.status === 'failed')
    body = (
      <NoteRow span={headers.length}>
        <BlockerNote
          title={t('poolsRefused', { reason: refusalWords(resource.failure, words) })}
          action={
            <Button variant="secondary" onClick={pools.reload}>
              {t('retry')}
            </Button>
          }
        />
      </NoteRow>
    );
  else if (!resource.data || resource.data.rows.length === 0)
    body = (
      <NoteRow span={headers.length}>
        <EmptyState title={t('poolsEmpty', { network })} />
      </NoteRow>
    );
  else body = resource.data.rows.map((pool) => <PoolRow key={pool.address} pool={pool} />);
  const next = resource.status === 'ready' ? (resource.data?.nextCursor ?? null) : null;
  return (
    <Panel title={t('poolsTitle')}>
      <p className="muted">{t('poolsNote', { network })}</p>
      <p className="muted">{t('symbolsNote')}</p>
      <DataTable label={t('poolsTitle')} headers={headers}>
        {body}
      </DataTable>
      {next !== null && (
        <Button variant="secondary" onClick={() => setCursor(next)}>
          {t('poolsMore')}
        </Button>
      )}
    </Panel>
  );
}

function PoolRow({ pool }: { pool: Pool }) {
  const { t } = usePools();
  return (
    <tr>
      <th scope="row">
        <a href={`/dex/pools/${pool.address}`} title={pool.address}>
          {pairName(pool.token0, pool.token1, t)}
        </a>
      </th>
      <td>
        <code title={pool.token0.address}>{short(pool.token0.address)}</code> /{' '}
        <code title={pool.token1.address}>{short(pool.token1.address)}</code>
      </td>
      <td>{t('feePercent', { percent: bpsPercent(pool.feeBps) })}</td>
      <td>{reservesWords(pool, t)}</td>
      <td>{pool.createdHeight}</td>
    </tr>
  );
}

export function reservesWords(pool: Pool, t: PoolsTranslate): string {
  if (!pool.reserves) return t('reservesNone');
  return t('reservesPair', {
    amount0: tokenAmount(pool.reserves.reserve0, pool.token0, t),
    symbol0: tokenSymbol(pool.token0),
    amount1: tokenAmount(pool.reserves.reserve1, pool.token1, t),
    symbol1: tokenSymbol(pool.token1),
  });
}
