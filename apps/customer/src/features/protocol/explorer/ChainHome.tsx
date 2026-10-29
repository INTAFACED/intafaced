import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
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

/** Why the indexer gave no answer, in words. A gateway with no indexer behind it says so instead of a raw code. */
function refusalWords(failure: Failure, t: ExplorerTranslate): string {
  if (isServiceNotConnected(failure.code)) return t('reasonIndexerNotConnected');
  if (failure.code === 'edge.upstream_unavailable') return t('reasonIndexerNoAnswer');
  return failure.message;
}

const short = (hex: string) => `${hex.slice(0, 10)}…${hex.slice(-6)}`;

/** A table row that holds only a note: why the table is empty, or that it is loading. */
function NoteRow({ span, children }: { span: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={span}>{children}</td>
    </tr>
  );
}
function BlockerNote({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div role="status" data-blocker="indexer">
      <EmptyState title={title} />
      {action}
    </div>
  );
}

/**
 * Chain home (D-explorer-07): the explorer search, the latest blocks and transactions on the network the indexer reads,
 * and the INTACHAIN line. Every list comes from the indexer; with no indexer answer the table keeps its columns and says
 * why it is empty. INTACHAIN is never shown as running: the line names its blocker.
 */
export function ChainHome({ chain }: { chain: ChainRef }) {
  const { language } = usePreferences();
  const { t, renderedLocale } = explorerCopy.forLocale(language);
  const transport = useApi();
  const api = useMemo(() => createExplorerApi(transport), [transport]);
  const chainId = chain.status === 'ready' ? chain.chainId : null;
  const network = chainId === null ? null : networkLabel(chainId).name;
  const txHeaders = [t('hdrHash'), t('hdrFrom'), t('hdrTo'), t('hdrStatus')];
  return (
    <>
      <p className="explorer-intachain" data-testid="chain-intachain">
        {network ? t('intachainLine', { network }) : t('intachainLineUnknown')}
      </p>
      <ExplorerSearch api={api} chain={chain} t={t} />
      <LatestBlocks api={api} chain={chain} locale={renderedLocale} t={t} />
      <Panel title={t('latestTxs')}>
        <DataTable label={t('latestTxs')} headers={txHeaders}>
          <NoteRow span={txHeaders.length}>
            <BlockerNote title={t('txsNoList')} />
          </NoteRow>
        </DataTable>
      </Panel>
    </>
  );
}

function LatestBlocks({ api, chain, locale, t }: { api: ExplorerApi; chain: ChainRef; locale: string; t: ExplorerTranslate }) {
  const chainId = chain.status === 'ready' ? chain.chainId : null;
  const blocks = useResource<ExplorerBlocksPage | null>(
    (signal) => (chainId === null ? Promise.resolve({ ok: true, data: null }) : api.latestBlocks(chainId, signal)),
    `explorer:blocks:${chainId ?? 'none'}`,
  );
  const headers = [t('hdrBlock'), t('hdrTime'), t('hdrTxs'), t('hdrGas')];
  const when = (date: Date) => date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const { resource } = blocks;
  let body: ReactNode;
  let asOf: string | null = null;
  if (chain.status === 'failed')
    body = (
      <NoteRow span={headers.length}>
        <BlockerNote title={t('blocksChainUnknown')} />
      </NoteRow>
    );
  else if (chain.status === 'loading' || resource.status === 'loading')
    body = (
      <NoteRow span={headers.length}>
        <Loading label={t('latestBlocks')} />
      </NoteRow>
    );
  else if (resource.status === 'failed')
    body = (
      <NoteRow span={headers.length}>
        <BlockerNote
          title={t('blocksRefused', { reason: refusalWords(resource.failure, t) })}
          action={
            <Button variant="secondary" onClick={blocks.reload}>
              {t('retry')}
            </Button>
          }
        />
      </NoteRow>
    );
  else if (!resource.data || resource.data.rows.length === 0)
    body = (
      <NoteRow span={headers.length}>
        <BlockerNote title={t('blocksNone', { network: networkLabel(chainId).name })} />
      </NoteRow>
    );
  else {
    asOf = resource.data.asOf;
    body = resource.data.rows.map((row) => (
      <tr key={`${row.height}:${row.hash}`}>
        <th scope="row">
          {/* A height opens the canonical block, so a reorged row shows its height and hash without a link to another block. */}
          {row.orphaned ? (
            <>
              {row.height} <span className="badge">{t('blockOrphaned', { reason: row.orphaned.reason })}</span>{' '}
              <span className="muted">{short(row.hash)}</span>
            </>
          ) : (
            <a href={`/chain/blocks/${row.height}`}>{row.height}</a>
          )}
        </th>
        <td>{when(new Date(row.timestamp * 1000))}</td>
        <td className="numeric">{row.txCount}</td>
        <td className="numeric">{row.gasUsed}</td>
      </tr>
    ));
  }
  return (
    <Panel title={t('latestBlocks')}>
      {asOf && <p className="muted">{t('blocksAsOf', { time: when(new Date(asOf)) })}</p>}
      <DataTable label={t('latestBlocks')} headers={headers}>
        {body}
      </DataTable>
    </Panel>
  );
}

/** The indexer's status in words. A transaction from a reorged block or one replaced by another is never plain Success. */
export function txStatusWords(tx: ExplorerTx, t: ExplorerTranslate): string {
  if (tx.orphaned) return t('txOrphaned', { reason: tx.orphaned.reason });
  if (tx.status === 'replaced') return tx.replacingHash ? t('txReplacedBy', { hash: short(tx.replacingHash) }) : t('txReplaced');
  return t(TX_STATUS[tx.status]);
}
const TX_STATUS = {
  success: 'txSuccess',
  failed: 'txReverted',
  pending: 'txPending',
  dropped: 'txDropped',
} as const;

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
function ExplorerSearch({ api, chain, t }: { api: ExplorerApi; chain: ChainRef; t: ExplorerTranslate }) {
  const chainId = chain.status === 'ready' ? chain.chainId : null;
  const [text, setText] = useState('');
  // Each search is its own attempt, so searching the same hash again asks the indexer again.
  const [searched, setSearched] = useState<{ hash: string; attempt: number } | null>(null);
  const [lookup, setLookup] = useState<{ hash: string; attempt: number; chainId: number; result: ApiResult<ExplorerTx> } | null>(null);
  // Never reset, so an answer for an earlier search can never be read as the answer for a later one.
  const attempts = useRef(0);
  const listId = useId();
  const query = classifyQuery(text);

  // The configured network is asked once the room knows which one it is, so a search sent while it loads is still answered.
  useEffect(() => {
    if (searched === null || chainId === null) return;
    const controller = new AbortController();
    void api.tx(chainId, searched.hash, controller.signal).then((result) => {
      if (!controller.signal.aborted) setLookup({ hash: searched.hash, attempt: searched.attempt, chainId, result });
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
          if (!lookup || lookup.hash !== searched.hash || lookup.attempt !== searched.attempt || lookup.chainId !== chainId)
            return { ...network, state: 'checking' };
          const { result } = lookup;
          if (result.ok) return { ...network, state: 'found', tx: result.data };
          if (isNotFound(result.code)) return { ...network, state: 'not_found' };
          return { ...network, state: 'not_checked', reason: refusalWords(result, t) };
        });

  function open() {
    const path = pathFor(query);
    if (path) navigate(path);
    else if (query.kind === 'tx') {
      attempts.current += 1;
      setSearched({ hash: query.value, attempt: attempts.current });
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    open();
  }
  const hasResults = query.kind !== 'empty' && query.kind !== 'text';

  return (
    <Panel title={t('homeTitle')}>
      <form role="search" className="explorer-search" onSubmit={submit}>
        <input
          type="search"
          aria-label={t('searchLabel')}
          placeholder={t('searchPlaceholder')}
          value={text}
          {...(hasResults ? { 'aria-controls': listId } : {})}
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
                  {t('networkFound', { network: network.name, status: txStatusWords(network.tx, t) })}{' '}
                  <a href={`/chain/tx/${network.tx.hash}`}>{t('openTx')}</a>
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
        <span className="badge">{label}</span>{' '}
        <span className="explorer-results__value">{query.kind === 'tx' ? short(query.value) : query.value}</span>
      </li>
    </ul>
  );
}
