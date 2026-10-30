import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { formatUnits } from 'viem';
import { useApi } from '../../session/session';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { Button, DataTable, EmptyState, Loading } from '../../../shared/ui';
import { networkLabel } from '../blockers';
import { TabList } from '../tokens/TabList';
import { AddressTxs } from './AddressTxs';
import { explorerCopy, type ExplorerTranslate } from './copy';
import { nativeAmount } from './decode';
import { createExplorerApi, type ExplorerAddressInternalPage } from './explorer-api';
import { BlockerNote, NoteRow, refusalWords, short, useChainRef } from './parts';
import './explorer.css';

/**
 * The live parts of an address page (D-explorer-03): its kind and balance, the tokens it holds, the value moved to or
 * from it inside transactions, and its balance at a past point. Every figure is the indexer's, read at a block the
 * indexer has stored; with no answer each part keeps its layout and says why. Nothing here moves value.
 */

const NONE = { ok: true as const, data: null };

function useExplorer(address: string) {
  const transport = useApi();
  const api = useMemo(() => createExplorerApi(transport), [transport]);
  const chain = useChainRef(`explorer:address:${address}`);
  return { api, chain, chainId: chain.status === 'ready' ? chain.chainId : null };
}

const network = (chainId: number | null) => (chainId === null ? '' : networkLabel(chainId).name);

/** The address's kind (account or contract) and native balance, as rows of the page's summary. */
export function AddressSummary({ address, labels }: { address: string; labels: { address: string; kind: string; balance: string } }) {
  const { language } = usePreferences();
  const { t } = explorerCopy.forLocale(language);
  const { api, chain, chainId } = useExplorer(address);
  const summary = useResource(
    (signal) => (chainId === null ? Promise.resolve(NONE) : api.addressSummary(chainId, address, signal)),
    `explorer:address-summary:${chainId ?? 'none'}:${address.toLowerCase()}`,
  );
  const { resource } = summary;
  let kind: ReactNode = <Loading label={labels.kind} />;
  let balance: ReactNode = <Loading label={labels.balance} />;
  let note: ReactNode = null;
  if (chain.status === 'failed') {
    kind = balance = '—';
    note = <BlockerNote title={t('blocksChainUnknown')} />;
  } else if (resource.status === 'failed') {
    kind = balance = '—';
    note = (
      <BlockerNote
        title={t('summaryRefused', { reason: refusalWords(resource.failure, t) })}
        action={
          <Button variant="secondary" onClick={summary.reload}>
            {t('retry')}
          </Button>
        }
      />
    );
  } else if (resource.status === 'ready' && resource.data) {
    const data = resource.data;
    if (data.kind === null || data.balance === null || data.asOfHeight === null) {
      kind = balance = '—';
      note = <BlockerNote title={t('summaryNone', { network: network(chainId) })} />;
    } else {
      kind = data.kind === 'contract' ? t('kindContract') : t('kindAccount');
      balance = t('balanceNative', { amount: nativeAmount(data.balance) });
      note = <p className="muted">{t('summaryAsOf', { height: String(data.asOfHeight) })}</p>;
    }
  }
  return (
    <>
      <dl className="protocol-facts">
        <div>
          <dt>{labels.address}</dt>
          <dd>{address}</dd>
        </div>
        <div>
          <dt>{labels.kind}</dt>
          <dd data-testid="address-kind">{kind}</dd>
        </div>
        <div>
          <dt>{labels.balance}</dt>
          <dd data-testid="address-balance">{balance}</dd>
        </div>
      </dl>
      {note}
    </>
  );
}

/** A token amount in the token's own decimals, or its raw base units when the contract did not say. No float. */
function tokenAmount(balance: string, decimals: number | null, t: ExplorerTranslate): string {
  return decimals === null ? t('rawUnitsAlone', { amount: balance }) : formatUnits(BigInt(balance), decimals);
}

/** The tokens the address holds, each from the token's own `balanceOf`, with the count that carry no price. */
export function AddressHoldings({ address }: { address: string }) {
  const { language } = usePreferences();
  const { t } = explorerCopy.forLocale(language);
  const { api, chain, chainId } = useExplorer(address);
  const holdings = useResource(
    (signal) => (chainId === null ? Promise.resolve(NONE) : api.addressHoldings(chainId, address, signal)),
    `explorer:address-holdings:${chainId ?? 'none'}:${address.toLowerCase()}`,
  );
  const headers = [t('hdrToken'), t('hdrBalance'), t('hdrPrice')];
  const { resource } = holdings;
  let body: ReactNode;
  if (chain.status === 'failed')
    body = (
      <NoteRow span={headers.length}>
        <BlockerNote title={t('blocksChainUnknown')} />
      </NoteRow>
    );
  else if (chain.status === 'loading' || resource.status === 'loading')
    body = (
      <NoteRow span={headers.length}>
        <Loading label={t('holdingsTitle')} />
      </NoteRow>
    );
  else if (resource.status === 'failed')
    body = (
      <NoteRow span={headers.length}>
        <BlockerNote
          title={t('holdingsRefused', { reason: refusalWords(resource.failure, t) })}
          action={
            <Button variant="secondary" onClick={holdings.reload}>
              {t('retry')}
            </Button>
          }
        />
      </NoteRow>
    );
  else if (!resource.data || resource.data.rows.length === 0)
    body = (
      <NoteRow span={headers.length}>
        <EmptyState title={t('holdingsNone', { network: network(chainId) })} />
      </NoteRow>
    );
  else
    body = resource.data.rows.map((row) => (
      <tr key={row.token.address} data-token={row.token.address}>
        <th scope="row">
          <a href={`/chain/address/${row.token.address}`} title={row.token.address}>
            {row.token.symbol ?? short(row.token.address)}
          </a>
        </th>
        <td>{row.balance === null ? t('balanceNotToken') : tokenAmount(row.balance, row.token.decimals, t)}</td>
        <td>{t('noPrice')}</td>
      </tr>
    ));
  const page = resource.status === 'ready' ? resource.data : null;
  return (
    <>
      <DataTable label={t('holdingsTitle')} headers={headers}>
        {body}
      </DataTable>
      {page && page.unpriced > 0 && (
        <p className="muted" data-testid="address-unpriced">
          {page.unpriced === 1 ? t('holdingsUnpricedOne') : t('holdingsUnpricedMany', { count: page.unpriced })}
        </p>
      )}
      {page?.more && <p className="muted">{t('holdingsMore')}</p>}
      {page && page.asOfHeight !== null && <p className="muted">{t('summaryAsOf', { height: String(page.asOfHeight) })}</p>}
    </>
  );
}

const TRACE_REASONS: Readonly<Record<string, 'reasonTraceNotRecorded' | 'reasonTraceUnavailable' | 'reasonTraceMalformed'>> = {
  'indexer.trace_not_recorded': 'reasonTraceNotRecorded',
  'indexer.trace_unavailable': 'reasonTraceUnavailable',
  'indexer.trace_malformed': 'reasonTraceMalformed',
};

/** The indexed blocks whose trace was not read, named with their range and why, so a missing move is never silent. */
function TraceGaps({ gaps, t }: { gaps: ExplorerAddressInternalPage['gaps']; t: ExplorerTranslate }) {
  if (gaps.blocks === 0 || gaps.fromHeight === null || gaps.toHeight === null) return null;
  const reasons = gaps.reasons
    .map((code) => {
      const key = TRACE_REASONS[code];
      return key ? t(key) : code;
    })
    .join('; ');
  return (
    <div role="status" data-testid="address-trace-gaps" data-blocker="indexer">
      <EmptyState
        title={
          gaps.blocks === 1
            ? t('traceUnavailableOne', { from: String(gaps.fromHeight), reasons })
            : t('traceUnavailableMany', { blocks: gaps.blocks, from: String(gaps.fromHeight), to: String(gaps.toHeight), reasons })
        }
      />
    </div>
  );
}

/** Value moved to or from the address inside transactions, newest first, one row per move. */
export function AddressInternal({ address }: { address: string }) {
  const { language } = usePreferences();
  const { t, renderedLocale } = explorerCopy.forLocale(language);
  const { api, chain, chainId } = useExplorer(address);
  const [cursor, setCursor] = useState<ExplorerAddressInternalPage['nextCursor']>(null);
  const internal = useResource(
    (signal) => (chainId === null ? Promise.resolve(NONE) : api.addressInternal(chainId, address, signal, cursor)),
    `explorer:address-internal:${chainId ?? 'none'}:${address.toLowerCase()}${cursor ? `:${cursor.height}:${cursor.index}:${cursor.hash}` : ''}`,
  );
  const headers = [t('hdrHash'), t('hdrBlock'), t('hdrTime'), t('hdrKind'), t('hdrFrom'), t('hdrTo'), t('hdrMove')];
  const { resource } = internal;
  const when = (seconds: number) => new Date(seconds * 1000).toLocaleString(renderedLocale, { dateStyle: 'medium', timeStyle: 'short' });
  const kindWords = { call: t('moveCall'), create: t('moveCreate'), selfdestruct: t('moveSelfdestruct') } as const;
  let body: ReactNode;
  if (chain.status === 'failed')
    body = (
      <NoteRow span={headers.length}>
        <BlockerNote title={t('txsChainUnknown')} />
      </NoteRow>
    );
  else if (chain.status === 'loading' || resource.status === 'loading')
    body = (
      <NoteRow span={headers.length}>
        <Loading label={t('tabInternal')} />
      </NoteRow>
    );
  else if (resource.status === 'failed')
    body = (
      <NoteRow span={headers.length}>
        <BlockerNote
          title={t('internalRefused', { reason: refusalWords(resource.failure, t) })}
          action={
            <Button variant="secondary" onClick={internal.reload}>
              {t('retry')}
            </Button>
          }
        />
      </NoteRow>
    );
  else if (!resource.data || resource.data.rows.length === 0)
    body = (
      <NoteRow span={headers.length}>
        <EmptyState title={t('internalNone', { network: network(chainId) })} />
      </NoteRow>
    );
  else
    body = resource.data.rows.flatMap((row) =>
      row.calls.map((call) => (
        <tr key={`${row.hash}:${call.path}`} data-tx={row.hash} data-path={call.path}>
          <th scope="row">
            <a href={`/chain/tx/${row.hash}`} title={row.hash}>
              {short(row.hash)}
            </a>
          </th>
          <td>
            <a href={`/chain/blocks/${row.blockHeight}`}>{row.blockHeight}</a>
          </td>
          <td>{when(row.timestamp)}</td>
          <td>{kindWords[call.kind]}</td>
          <td data-address={call.from}>
            <a href={`/chain/address/${call.from}`}>{short(call.from)}</a>
          </td>
          <td data-address={call.to}>
            <a href={`/chain/address/${call.to}`}>{short(call.to)}</a>
          </td>
          <td data-testid="internal-value">{nativeAmount(call.value)}</td>
        </tr>
      )),
    );
  const page = resource.status === 'ready' ? resource.data : null;
  return (
    <>
      {page && <TraceGaps gaps={page.gaps} t={t} />}
      <DataTable label={t('tabInternal')} headers={headers}>
        {body}
      </DataTable>
      {page && page.asOfHeight !== null && <p className="muted">{t('addressTxsAsOf', { height: String(page.asOfHeight) })}</p>}
      {page?.nextCursor && (
        <Button variant="secondary" onClick={() => setCursor(page.nextCursor)}>
          {t('moreTxs')}
        </Button>
      )}
    </>
  );
}

/** The address's transactions and its internal transactions, as two tabs. */
export function AddressActivity({ address }: { address: string }) {
  const { language } = usePreferences();
  const { t } = explorerCopy.forLocale(language);
  const [tab, setTab] = useState<'txs' | 'internal'>('txs');
  return (
    <TabList
      label={t('addressTabs')}
      tabs={[
        { id: 'txs', label: t('tabTxs') },
        { id: 'internal', label: t('tabInternal') },
      ]}
      value={tab}
      onChange={setTab}
    >
      {tab === 'txs' ? <AddressTxs key={address} address={address} /> : <AddressInternal key={address} address={address} />}
    </TabList>
  );
}

type PastPoint = { height: number } | { date: string };

/** What the reader typed, as a block height or a UTC date; null when it is neither. */
export function parsePastPoint(text: string): PastPoint | null {
  const value = text.trim();
  if (/^\d{1,15}$/.test(value)) return { height: Number(value) };
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!date) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : { date: value };
}

/** The address's native balance at a past block or at the end of a UTC day, or the indexed range when outside it. */
export function PastBalance({ address }: { address: string }) {
  const { language } = usePreferences();
  const { t, renderedLocale } = explorerCopy.forLocale(language);
  const { api, chain, chainId } = useExplorer(address);
  const [text, setText] = useState('');
  const [point, setPoint] = useState<PastPoint | null>(null);
  const [invalid, setInvalid] = useState(false);
  const key = point === null ? 'none' : 'height' in point ? `h${point.height}` : `d${point.date}`;
  const past = useResource(
    (signal) => (chainId === null || point === null ? Promise.resolve(NONE) : api.balanceAt(chainId, address, point, signal)),
    `explorer:address-balance-at:${chainId ?? 'none'}:${address.toLowerCase()}:${key}`,
  );
  function submit(event: FormEvent) {
    event.preventDefault();
    const next = parsePastPoint(text);
    setInvalid(next === null);
    if (next) setPoint(next);
  }
  const { resource } = past;
  let result: ReactNode = null;
  if (point !== null) {
    if (chain.status === 'failed') result = <BlockerNote title={t('blocksChainUnknown')} />;
    else if (chain.status === 'loading' || resource.status === 'loading') result = <Loading label={t('pastBalance')} />;
    else if (resource.status === 'failed')
      result = (
        <BlockerNote
          title={t('pastBalanceRefused', { reason: refusalWords(resource.failure, t) })}
          action={
            <Button variant="secondary" onClick={past.reload}>
              {t('retry')}
            </Button>
          }
        />
      );
    else if (resource.data?.indexed)
      result = t('pastBalanceAt', {
        amount: nativeAmount(resource.data.balance),
        height: String(resource.data.height),
        time: new Date(resource.data.timestamp * 1000).toLocaleString(renderedLocale, {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: 'UTC',
        }),
      });
    else if (resource.data) {
      const { after, earliestHeight, latestHeight } = resource.data;
      if (earliestHeight === null || latestHeight === null) result = t('pastBalanceNoBlocks', { network: network(chainId) });
      else if (after) result = t('pastBalanceNotIndexedAfter', { height: String(latestHeight) });
      else result = t('pastBalanceNotIndexed', { height: String(earliestHeight) });
    }
  }
  return (
    <form className="protocol-quote" onSubmit={submit} aria-label={t('pastBalance')}>
      <label>
        <span>{t('pastBalanceInput')}</span>
        <input type="text" inputMode="text" value={text} onChange={(event) => setText(event.target.value)} />
      </label>
      <div className="actions">
        <Button type="submit">{t('pastBalanceShow')}</Button>
      </div>
      {invalid && <p role="alert">{t('pastBalanceInvalid')}</p>}
      {!invalid && result !== null && (
        <div role="status" data-testid="address-past-balance">
          {result}
        </div>
      )}
    </form>
  );
}
