import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { navigate } from '../../../app/location';
import { useApi } from '../../session/session';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import type { ApiResult } from '../../../shared/api';
import { Button, DataTable, Loading, Panel } from '../../../shared/ui';
import { KNOWN_NETWORKS, networkLabel } from '../blockers';
import type { ChainRef } from '../NetworkPanels';
import { explorerCopy, type ExplorerTranslate } from './copy';
import {
  createExplorerApi,
  isNotFound,
  type ExplorerApi,
  type ExplorerBlocksPage,
  type ExplorerTx,
  type ExplorerTxNetworks,
} from './explorer-api';
import { BlockerNote, NoteRow, refusalWords, short, TxTable, txStatusWords } from './pages';
import { classifyQuery, pathFor, type ExplorerQuery } from './search';

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
  return (
    <>
      <p className="explorer-intachain" data-testid="chain-intachain">
        {network ? t('intachainLine', { network }) : t('intachainLineUnknown')}
      </p>
      <ExplorerSearch api={api} chain={chain} t={t} />
      <LatestBlocks api={api} chain={chain} locale={renderedLocale} t={t} />
      <Panel title={t('latestTxs')}>
        <TxTable api={api} chain={chain} label={t('latestTxs')} emptyWords={t('txsNone', { network: network ?? '' })} t={t} />
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

/** The network this explorer reads first, then every other one it knows and each one the indexer searched. */
function searchedNetworks(chainId: number | null, elsewhere: readonly number[], t: ExplorerTranslate): { chainId: number; name: string }[] {
  const ids: number[] = [];
  for (const id of [chainId, ...Object.keys(KNOWN_NETWORKS).map(Number), ...elsewhere]) if (id !== null && !ids.includes(id)) ids.push(id);
  return ids.map((id) => {
    const label = networkLabel(id);
    return { chainId: id, name: label.known ? label.name : t('networkUnrecognised', { id: String(id) }) };
  });
}

type NetworkAnswer =
  | { chainId: number; name: string; state: 'checking' }
  | { chainId: number; name: string; state: 'found'; tx: ExplorerTx }
  | { chainId: number; name: string; state: 'found_elsewhere'; status: string; height: number | null }
  | { chainId: number; name: string; state: 'not_found' }
  | { chainId: number; name: string; state: 'not_checked'; reason: string };

type ElsewhereAnswer = ExplorerTxNetworks['networks'][number];

/** Why another network's node gave no answer, in words; an unknown code is shown as it came. */
function elsewhereReason(code: string, t: ExplorerTranslate): string {
  if (code === 'indexer.chain_id_mismatch') return t('reasonWrongChain');
  if (code === 'indexer.chain_unreachable') return t('reasonNodeNoAnswer');
  return code;
}

/** One other network's answer, read live by the indexer from that network's node. */
function elsewhereAnswer(network: { chainId: number; name: string }, answer: ElsewhereAnswer, t: ExplorerTranslate): NetworkAnswer {
  if (answer.state === 'not_found') return { ...network, state: 'not_found' };
  if (answer.state === 'not_checked') return { ...network, state: 'not_checked', reason: elsewhereReason(answer.code, t) };
  const status = answer.pending ? t('txPending') : answer.status === 'success' ? t('txSuccess') : t('txReverted');
  return { ...network, state: 'found_elsewhere', status, height: answer.blockHeight };
}

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
  const [elsewhere, setElsewhere] = useState<{ hash: string; attempt: number; result: ApiResult<ExplorerTxNetworks> } | null>(null);
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

  // The other networks the indexer searches do not wait for the configured one: each answers from its own node.
  useEffect(() => {
    if (searched === null) return;
    const controller = new AbortController();
    void api.txNetworks(searched.hash, controller.signal).then((result) => {
      if (!controller.signal.aborted) setElsewhere({ hash: searched.hash, attempt: searched.attempt, result });
    });
    return () => controller.abort();
  }, [api, searched]);

  const current =
    elsewhere && searched && elsewhere.hash === searched.hash && elsewhere.attempt === searched.attempt ? elsewhere.result : null;
  const elsewhereIds = current?.ok ? current.data.networks.map((answer) => answer.chainId) : [];

  const answers: NetworkAnswer[] | null =
    searched === null
      ? null
      : searchedNetworks(chainId, elsewhereIds, t).map((network): NetworkAnswer => {
          if (chain.status === 'loading') return { ...network, state: 'checking' };
          if (network.chainId !== chainId) {
            if (current === null) return { ...network, state: 'checking' };
            if (!current.ok) return { ...network, state: 'not_checked', reason: refusalWords(current, t) };
            const answer = current.data.networks.find((item) => item.chainId === network.chainId);
            if (answer) return elsewhereAnswer(network, answer, t);
            if (chainId === null) return { ...network, state: 'not_checked', reason: t('reasonChainUnknown') };
            return { ...network, state: 'not_checked', reason: t('reasonOtherNetwork', { network: networkLabel(chainId).name }) };
          }
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
            <li key={network.chainId} data-state={network.state === 'found_elsewhere' ? 'found' : network.state}>
              {network.state === 'checking' && t('searchingNetwork', { network: network.name })}
              {network.state === 'found' && (
                <>
                  {t('networkFound', { network: network.name, status: txStatusWords(network.tx, t) })}{' '}
                  <a href={`/chain/tx/${network.tx.hash}`}>{t('openTx')}</a>
                </>
              )}
              {network.state === 'found_elsewhere' &&
                (network.height === null
                  ? t('networkFound', { network: network.name, status: network.status })
                  : t('networkFoundAt', { network: network.name, status: network.status, height: String(network.height) }))}
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
