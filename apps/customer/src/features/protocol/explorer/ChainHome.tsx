import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { navigate } from '../../../app/location';
import { useApi } from '../../session/session';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import type { ApiResult } from '../../../shared/api';
import { Button, DataTable, EmptyState, Loading, Panel } from '../../../shared/ui';
import { isServiceNotConnected, KNOWN_NETWORKS, networkLabel } from '../blockers';
import type { ChainRef } from '../NetworkPanels';
import { explorerCopy, type ExplorerTranslate } from './copy';
import { createExplorerApi, isNotFound, type ExplorerApi, type ExplorerBlocksPage, type ExplorerTx } from './explorer-api';
import { classifyQuery, pathFor, type ExplorerQuery } from './search';

type Failure = Extract<ApiResult<unknown>, { ok: false }>;

/** Why the indexer gave no answer, in words. A gateway that has no indexer behind it says so instead of a raw code. */
function refusalWords(failure: Failure, t: ExplorerTranslate): string {
  if (isServiceNotConnected(failure.code)) return t('reasonIndexerNotConnected');
  if (failure.code === 'edge.upstream_unavailable') return t('reasonIndexerNoAnswer');
  return failure.message;
}

const clock = (seconds: number) => new Date(seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const short = (hex: string) => `${hex.slice(0, 10)}…${hex.slice(-6)}`;

/**
 * Chain home (D-explorer-07): the explorer search, the latest blocks and transactions on the network the indexer reads,
 * and the INTACHAIN line. Every list comes from the indexer; with no indexer answer the table keeps its columns and says
 * why it is empty. INTACHAIN is never shown as running: the line names its blocker.
 */
export function ChainHome({ chain }: { chain: ChainRef }) {
  const { language } = usePreferences();
  const { t } = explorerCopy.forLocale(language);
  const transport = useApi();
  const api = useMemo(() => createExplorerApi(transport), [transport]);
  const chainId = chain.status === 'ready' ? chain.chainId : null;
  const network = chainId === null ? null : networkLabel(chainId).name;
  return (
    <>
      <p className="explorer-intachain" data-testid="chain-intachain">
        {network ? t('intachainLine', { network }) : t('intachainLineUnknown')}
      </p>
      <ExplorerSearch api={api} chainId={chainId} chain={chain} t={t} />
      <LatestBlocks api={api} chain={chain} t={t} />
      <Panel title={t('latestTxs')}>
        <DataTable label={t('latestTxs')} headers={[t('hdrHash'), t('hdrFrom'), t('hdrTo'), t('hdrStatus')]}>
          <tr>
            <td colSpan={4}>
              <div role="status" data-blocker="indexer">
                <EmptyState title={t('txsNoList')} />
              </div>
            </td>
          </tr>
        </DataTable>
      </Panel>
    </>
  );
}

function LatestBlocks({ api, chain, t }: { api: ExplorerApi; chain: ChainRef; t: ExplorerTranslate }) {
  const chainId = chain.status === 'ready' ? chain.chainId : null;
  const blocks = useResource<ExplorerBlocksPage | null>(
    (signal) => (chainId === null ? Promise.resolve({ ok: true, data: null }) : api.latestBlocks(chainId, signal)),
    `explorer:blocks:${chainId ?? 'none'}`,
  );
  const headers = [t('hdrBlock'), t('hdrTime'), t('hdrTxs'), t('hdrGas')];
  const note = (title: string) => (
    <tr>
      <td colSpan={headers.length}>
        <div role="status" data-blocker="indexer">
          <EmptyState title={title} />
        </div>
      </td>
    </tr>
  );
  let body;
  let asOf: string | null = null;
  if (chain.status === 'failed') body = note(t('blocksChainUnknown'));
  else if (chain.status === 'loading' || blocks.resource.status === 'loading')
    body = (
      <tr>
        <td colSpan={headers.length}>
          <Loading label={t('latestBlocks')} />
        </td>
      </tr>
    );
  else if (blocks.resource.status === 'failed') body = note(t('blocksRefused', { reason: refusalWords(blocks.resource.failure, t) }));
  else if (!blocks.resource.data || blocks.resource.data.rows.length === 0) body = note(t('blocksNone'));
  else {
    asOf = blocks.resource.data.asOf;
    body = blocks.resource.data.rows.map((row) => (
      <tr key={`${row.height}:${row.hash}`}>
        <th scope="row">
          <a
            href={`/chain/blocks/${row.height}`}
            onClick={(event) => {
              event.preventDefault();
              navigate(`/chain/blocks/${row.height}`);
            }}
          >
            {row.height}
          </a>
          {row.orphaned && <span className="badge">{t('blockOrphaned', { reason: row.orphaned.reason })}</span>}
        </th>
        <td>{clock(row.timestamp)}</td>
        <td className="numeric">{row.txCount}</td>
        <td className="numeric">{row.gasUsed}</td>
      </tr>
    ));
  }
  return (
    <Panel title={t('latestBlocks')}>
      {asOf && <p className="muted">{t('blocksAsOf', { time: new Date(asOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}</p>}
      <DataTable label={t('latestBlocks')} headers={headers}>
        {body}
      </DataTable>
    </Panel>
  );
}

/** Every network this explorer knows, plus the configured one when it is not among them. */
function searchedNetworks(chainId: number | null): { chainId: number; name: string }[] {
  const ids = Object.keys(KNOWN_NETWORKS).map(Number);
  if (chainId !== null && !ids.includes(chainId)) ids.push(chainId);
  return ids.map((id) => ({ chainId: id, name: networkLabel(id).name }));
}

type NetworkAnswer =
  | { chainId: number; name: string; state: 'checking' }
  | { chainId: number; name: string; state: 'found'; tx: ExplorerTx }
  | { chainId: number; name: string; state: 'not_found' }
  | { chainId: number; name: string; state: 'not_checked'; reason: string };

/**
 * One search box for addresses, transactions and blocks. An address or a block opens its page; a transaction hash is looked
 * up on every network this explorer knows, and each network says Found, Not found or why it was not checked. Text that
 * is none of these would be a token name, and there is no token list to search, so the box says so instead of guessing.
 */
function ExplorerSearch({ api, chainId, chain, t }: { api: ExplorerApi; chainId: number | null; chain: ChainRef; t: ExplorerTranslate }) {
  const [text, setText] = useState('');
  const [searched, setSearched] = useState<string | null>(null);
  const [lookup, setLookup] = useState<{ hash: string; chainId: number; result: ApiResult<ExplorerTx> } | null>(null);
  const listId = useId();
  const query = classifyQuery(text);

  // The configured network is asked once the room knows which one it is, so a search sent while it loads is still answered.
  useEffect(() => {
    if (searched === null || chainId === null) return;
    const controller = new AbortController();
    void api.tx(chainId, searched, controller.signal).then((result) => {
      if (!controller.signal.aborted) setLookup({ hash: searched, chainId, result });
    });
    return () => controller.abort();
  }, [api, searched, chainId]);

  const answers: NetworkAnswer[] | null =
    searched === null
      ? null
      : searchedNetworks(chainId).map((network): NetworkAnswer => {
          if (chain.status === 'loading') return { ...network, state: 'checking' };
          if (chainId === null) return { ...network, state: 'not_checked', reason: t('reasonChainUnknown') };
          if (network.chainId !== chainId)
            return { ...network, state: 'not_checked', reason: t('reasonOtherNetwork', { network: networkLabel(chainId).name }) };
          if (!lookup || lookup.hash !== searched || lookup.chainId !== chainId) return { ...network, state: 'checking' };
          const { result } = lookup;
          if (result.ok) return { ...network, state: 'found', tx: result.data };
          if (isNotFound(result.code)) return { ...network, state: 'not_found' };
          return { ...network, state: 'not_checked', reason: refusalWords(result, t) };
        });

  function open() {
    const path = pathFor(query);
    if (path) navigate(path);
    else if (query.kind === 'tx') setSearched(query.value);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    open();
  }

  return (
    <Panel title={t('homeTitle')}>
      <form role="search" className="explorer-search" onSubmit={submit}>
        <input
          type="search"
          aria-label={t('searchLabel')}
          placeholder={t('searchPlaceholder')}
          value={text}
          aria-controls={listId}
          onChange={(event) => {
            setText(event.target.value);
            setSearched(null);
          }}
        />
        <Button type="submit" variant="secondary">
          {t('searchSubmit')}
        </Button>
      </form>
      <SearchResults id={listId} query={query} onPick={open} t={t} />
      {query.kind === 'text' && <p className="muted">{t('textNoTokenSource')}</p>}
      {answers && (
        <ul className="explorer-networks" aria-label={t('networksSearched')}>
          {answers.map((network) => (
            <li key={network.chainId} data-state={network.state}>
              {network.state === 'checking' && t('searchingNetwork', { network: network.name })}
              {network.state === 'found' && (
                <>
                  {t('networkFound', { network: network.name, status: network.tx.status })}{' '}
                  <a
                    href={`/chain/tx/${network.tx.hash}`}
                    onClick={(event) => {
                      event.preventDefault();
                      navigate(`/chain/tx/${network.tx.hash}`);
                    }}
                  >
                    {t('openTx')}
                  </a>
                </>
              )}
              {network.state === 'not_found' && t('networkNotFound', { network: network.name })}
              {network.state === 'not_checked' && t('networkNotChecked', { network: network.name, reason: network.reason })}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** The one result a query of a known shape has. Text has none: there is no token list to search. */
function SearchResults({ id, query, onPick, t }: { id: string; query: ExplorerQuery; onPick: () => void; t: ExplorerTranslate }) {
  if (query.kind === 'empty' || query.kind === 'text') return null;
  const label = query.kind === 'address' ? t('resultAddress') : query.kind === 'tx' ? t('resultTx') : t('resultBlock');
  return (
    <ul id={id} role="listbox" aria-label={t('resultsLabel')} className="explorer-results">
      <li
        role="option"
        aria-selected="false"
        tabIndex={0}
        data-kind={query.kind}
        {...(query.kind === 'address' ? { 'data-address': query.value.toLowerCase() } : {})}
        onClick={onPick}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onPick();
        }}
      >
        <span className="badge">{label}</span> <span className="explorer-results__value">{query.kind === 'tx' ? short(query.value) : query.value}</span>
      </li>
    </ul>
  );
}
