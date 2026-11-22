import { useMemo, useState, type ReactNode } from 'react';
import { navigate } from '../../../app/location';
import { useApi } from '../../session';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { Button, Tag } from '@intafaced/ui/lit';
import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import { DataTable, EmptyState, Loading, Panel } from '../volt/parts';
import { networkLabel } from '../blockers';
import type { ChainRef } from '../NetworkPanels';
import { TabList } from '../tokens/TabList';
import { Banner } from '../volt/frame';
import { watchCopy } from '../watch/copy';
import { protocolCopy } from '../copy';
import { explorerCopy, type ExplorerTranslate } from './copy';
import { decodeInput, gwei, nativeAmount } from './decode';
import {
  createExplorerApi,
  isNotFound,
  type ExplorerApi,
  type ExplorerBlockRow,
  type ExplorerTx,
  type ExplorerTxRow,
  type ExplorerTxsPage,
} from './explorer-api';
import { BlockerNote, NoteRow, refusalWords, short, useChainRef } from './parts';

export { BlockerNote, NoteRow, refusalWords, short } from './parts';

function useExplorer() {
  const { language } = usePreferences();
  const { t, renderedLocale } = explorerCopy.forLocale(language);
  const transport = useApi();
  const api = useMemo(() => createExplorerApi(transport), [transport]);
  const when = (date: Date) => date.toLocaleString(renderedLocale, { dateStyle: 'medium', timeStyle: 'short' });
  const clock = (date: Date) => date.toLocaleTimeString(renderedLocale, { timeStyle: 'short' });
  return { t, api, transport, when, clock };
}

/** Exact share used, to two places, with no float: gas used and the limit are whole numbers as decimal strings. */
export function percentOf(used: bigint, limit: bigint): string | null {
  if (limit <= 0n) return null;
  const scaled = (used * 10_000n) / limit;
  return `${scaled / 100n}.${(scaled % 100n).toString().padStart(2, '0')}`;
}

/**
 * The gas tracker: the newest canonical block's base fee in gwei and how full the listed canonical blocks were. Reorged
 * blocks are left out of both, since they are no longer part of the chain.
 */
export function GasTracker({ rows, t }: { rows: readonly ExplorerBlockRow[]; t: ExplorerTranslate }) {
  const canonical = rows.filter((row) => !row.orphaned);
  const newest = canonical[0];
  const used = canonical.reduce((sum, row) => sum + BigInt(row.gasUsed), 0n);
  const limit = canonical.reduce((sum, row) => sum + BigInt(row.gasLimit), 0n);
  const share = percentOf(used, limit);
  return (
    <Panel title={t('gasTracker')} aria-label={t('gasTracker')}>
      {newest ? (
        <dl className="lt-kv">
          <div>
            <dt>{t('gasBaseFee', { height: String(newest.height) })}</dt>
            <dd data-testid="gas-base-fee">
              {newest.baseFeePerGas === null ? t('gasBaseFeeNone') : t('gwei', { amount: gwei(newest.baseFeePerGas) })}
            </dd>
          </div>
          <div>
            <dt>{t('gasUsedShare', { count: canonical.length })}</dt>
            <dd data-testid="gas-used-share">
              {share === null ? t('notReturned') : t('gasUsedOf', { used: used.toString(), limit: limit.toString(), share })}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="lt-hint">{t('gasNoBlocks')}</p>
      )}
    </Panel>
  );
}

/**
 * The blocks list (D-explorer-02): newest first from the indexer, each row marked final or not against the finalized
 * height, a reorged block kept with its badge, the as-of time, and the gas tracker over the same rows.
 */
export function BlocksList({ chain }: { chain: ChainRef }) {
  const { t, api, when, clock } = useExplorer();
  const chainId = chain.status === 'ready' ? chain.chainId : null;
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const blocks = useResource(
    (signal) => (chainId === null ? Promise.resolve({ ok: true as const, data: null }) : api.latestBlocks(chainId, signal, cursor)),
    `explorer:blocks-list:${chainId ?? 'none'}:${cursor ?? 'head'}`,
  );
  const headers = [t('hdrBlock'), t('hdrTime'), t('hdrTxs'), t('hdrGas'), t('hdrFinality')];
  const { resource } = blocks;
  let body: ReactNode;
  let marker: ReactNode = null;
  let rows: readonly ExplorerBlockRow[] = [];
  if (chain.status === 'failed')
    body = (
      <NoteRow span={headers.length}>
        <BlockerNote title={t('blocksChainUnknown')} />
      </NoteRow>
    );
  else if (chain.status === 'loading' || resource.status === 'loading')
    body = (
      <NoteRow span={headers.length}>
        <Loading label={t('blocksTitle')} />
      </NoteRow>
    );
  else if (resource.status === 'failed')
    body = (
      <NoteRow span={headers.length}>
        <BlockerNote
          title={t('blocksRefused', { reason: refusalWords(resource.failure, t) })}
          action={
            <Button tone="secondary" onClick={blocks.reload}>
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
    const { finalizedHeight, asOf } = resource.data;
    rows = resource.data.rows;
    const time = clock(new Date(asOf));
    marker = (
      <p data-testid="blocks-finalized">
        {finalizedHeight === null ? t('notFinalYet', { time }) : t('finalizedAt', { height: String(finalizedHeight), time })}
      </p>
    );
    body = rows.map((row) => (
      <tr key={`${row.height}:${row.hash}`} data-orphaned={row.orphaned ? 'true' : undefined}>
        <th scope="row">
          {row.orphaned ? (
            <>
              {row.height} <Tag>{t('blockOrphaned', { reason: row.orphaned.reason })}</Tag>{' '}
              <span className="lt-hint">{short(row.hash)}</span>
            </>
          ) : (
            <a href={`/chain/blocks/${row.height}`}>{row.height}</a>
          )}
        </th>
        <td>{when(new Date(row.timestamp * 1000))}</td>
        <td className="lt-mono">{row.txCount}</td>
        <td className="lt-mono">{row.gasUsed}</td>
        <td>
          {row.orphaned ? t('rowOffChain') : finalizedHeight !== null && row.height <= finalizedHeight ? t('rowFinal') : t('rowNotFinal')}
        </td>
      </tr>
    ));
  }
  const next = resource.status === 'ready' ? (resource.data?.nextCursor ?? null) : null;
  return (
    <>
      <Panel title={t('blocksTitle')}>
        {marker}
        <DataTable label={t('blocksTitle')} headers={headers}>
          {body}
        </DataTable>
        {next !== null && (
          <Button tone="secondary" onClick={() => setCursor(next)}>
            {t('olderBlocks')}
          </Button>
        )}
      </Panel>
      <GasTracker rows={rows} t={t} />
    </>
  );
}

/** Newest transactions, or one block's, as a table of hash links. Shared by Chain home and the block page. */
export function TxTable({
  api,
  chain,
  label,
  blockHash,
  emptyWords,
  t,
}: {
  api: ExplorerApi;
  chain: ChainRef;
  label: string;
  blockHash?: string;
  emptyWords: string;
  t: ExplorerTranslate;
}) {
  const chainId = chain.status === 'ready' ? chain.chainId : null;
  const [cursor, setCursor] = useState<ExplorerTxsPage['nextCursor']>(null);
  const txs = useResource(
    (signal) => (chainId === null ? Promise.resolve({ ok: true as const, data: null }) : api.latestTxs(chainId, signal, blockHash, cursor)),
    `explorer:txs:${chainId ?? 'none'}:${blockHash ?? 'latest'}${cursor ? `:${cursor.height}:${cursor.index}:${cursor.hash}` : ''}`,
  );
  const headers = txHeaders(t);
  const { resource } = txs;
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
        <Loading label={label} />
      </NoteRow>
    );
  else if (resource.status === 'failed')
    body = (
      <NoteRow span={headers.length}>
        <BlockerNote
          title={t('txsRefused', { reason: refusalWords(resource.failure, t) })}
          action={
            <Button tone="secondary" onClick={txs.reload}>
              {t('retry')}
            </Button>
          }
        />
      </NoteRow>
    );
  else if (!resource.data || resource.data.rows.length === 0)
    body = (
      <NoteRow span={headers.length}>
        <EmptyState title={emptyWords} />
      </NoteRow>
    );
  else body = resource.data.rows.map((row) => <TxRow key={`${row.blockHash}:${row.hash}`} row={row} t={t} />);
  const next = resource.status === 'ready' ? (resource.data?.nextCursor ?? null) : null;
  return (
    <>
      <DataTable label={label} headers={headers}>
        {body}
      </DataTable>
      {next !== null && (
        <Button tone="secondary" onClick={() => setCursor(next)}>
          {t('moreTxs')}
        </Button>
      )}
    </>
  );
}

function txHeaders(t: ExplorerTranslate): string[] {
  return [t('hdrHash'), t('hdrFrom'), t('hdrTo'), t('hdrStatus')];
}

function TxRow({ row, t }: { row: ExplorerTxRow; t: ExplorerTranslate }) {
  const outcome = row.status === 'success' ? t('txSuccess') : t('txReverted');
  return (
    <tr>
      <th scope="row">
        <a href={`/chain/tx/${row.hash}`} title={row.hash}>
          {short(row.hash)}
        </a>
      </th>
      <td>
        <a href={`/chain/address/${row.from}`}>{short(row.from)}</a>
      </td>
      <td>{row.to ? <a href={`/chain/address/${row.to}`}>{short(row.to)}</a> : t('txCreated')}</td>
      <td>{row.orphaned ? t('txOrphaned', { outcome, reason: row.orphaned.reason }) : outcome}</td>
    </tr>
  );
}

function Facts({ label, rows }: { label: string; rows: [string, ReactNode, string?][] }) {
  return (
    <dl className="lt-kv" aria-label={label}>
      {rows.map(([term, value, testId]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd {...(testId ? { 'data-testid': testId } : {})}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ChainWait({ chain, t, label }: { chain: ChainRef; t: ExplorerTranslate; label: string }) {
  if (chain.status === 'failed') return <BlockerNote title={t('blocksChainUnknown')} action={<RetryChain chain={chain} t={t} />} />;
  return <Loading label={label} />;
}
function RetryChain({ chain, t }: { chain: Extract<ChainRef, { status: 'failed' }>; t: ExplorerTranslate }) {
  return (
    <Button tone="secondary" onClick={chain.reload}>
      {t('retry')}
    </Button>
  );
}
function BackToChain({ t }: { t: ExplorerTranslate }) {
  return (
    <Button tone="secondary" onClick={() => navigate('/chain')}>
      {t('backToChain')}
    </Button>
  );
}

/**
 * One record of the explorer (a block, a transaction) on the record-list template's record page, under the parked line.
 */
function ExplorerRecord({
  title,
  description,
  route,
  children,
}: {
  title: string;
  description?: string;
  route?: string;
  children: ReactNode;
}) {
  const { language } = usePreferences();
  return (
    <div lang={watchCopy.forLocale(language).renderedLocale} data-route={route}>
      <RecordListTemplate
        title={title}
        description={description}
        state={{ kind: 'ready' }}
        detailOnly
        list={null}
        detail={
          <>
            <Banner />
            {children}
          </>
        }
      />
    </div>
  );
}

/**
 * A block height or transaction hash that is not one, from the address bar: answered not found without asking the indexer,
 * in the same words the pending pages use, with the way back to /chain.
 */
export function RecordNotFound({ page }: { page: 'blockDetail' | 'txDetail' }) {
  const { language } = usePreferences();
  const { t } = protocolCopy.forLocale(language);
  const title = t(`page_${page}`);
  return (
    <ExplorerRecord title={title} description={t('pendingNote')} route={page}>
      <Panel title={t('pendingNotFoundTitle')}>
        <div data-code="protocol.not_found" role="status">
          <EmptyState title={t('pendingNotFoundBody', { what: t(page === 'blockDetail' ? 'what_block' : 'what_tx') })} />
        </div>
      </Panel>
      <Button tone="secondary" onClick={() => navigate('/chain')}>
        {t('pendingBack', { room: t('roomChain') })}
      </Button>
    </ExplorerRecord>
  );
}

/** One block by height (D-explorer-02): its facts and its transactions; a height the indexer never saw is named missing. */
export function BlockPage({ height }: { height: number }) {
  const { t, api, when } = useExplorer();
  const chain = useChainRef('explorer:block');
  const chainId = chain.status === 'ready' ? chain.chainId : null;
  const block = useResource(
    (signal) => (chainId === null ? Promise.resolve({ ok: true as const, data: null }) : api.block(chainId, { height }, signal)),
    `explorer:block:${chainId ?? 'none'}:${height}`,
  );
  const { resource } = block;
  const network = networkLabel(chainId).name;
  let body: ReactNode;
  if (chain.status !== 'ready') body = <ChainWait chain={chain} t={t} label={t('blockTitle', { height: String(height) })} />;
  else if (resource.status === 'loading') body = <Loading label={t('blockTitle', { height: String(height) })} />;
  else if (resource.status === 'failed')
    body = isNotFound(resource.failure.code) ? (
      <Panel title={t('noSuchBlock')}>
        <div data-code="protocol.not_found" role="status">
          <EmptyState title={t('noSuchBlock')}>{t('noSuchBlockBody', { network, height: String(height) })}</EmptyState>
        </div>
      </Panel>
    ) : (
      <>
        <Panel title={t('blockFacts')}>
          <BlockerNote
            title={t('blockRefused', { reason: refusalWords(resource.failure, t) })}
            action={
              <Button tone="secondary" onClick={block.reload}>
                {t('retry')}
              </Button>
            }
          />
        </Panel>
        <Panel title={t('blockTxs')}>
          <DataTable label={t('blockTxs')} headers={txHeaders(t)}>
            <NoteRow span={txHeaders(t).length}>
              <EmptyState title={t('blockTxsWaiting')} />
            </NoteRow>
          </DataTable>
        </Panel>
      </>
    );
  else if (resource.data) {
    const row = resource.data;
    body = (
      <>
        <Panel title={t('blockFacts')}>
          {row.orphaned && <Tag>{t('blockOrphaned', { reason: row.orphaned.reason })}</Tag>}
          <Facts
            label={t('blockFacts')}
            rows={[
              [t('blockHash'), <code key="hash">{row.hash}</code>],
              [t('blockTime'), when(new Date(row.timestamp * 1000))],
              [t('hdrTxs'), row.txCount],
              [
                t('hdrGas'),
                row.utilisation === null ? row.gasUsed : `${row.gasUsed} (${percentOf(BigInt(row.gasUsed), BigInt(row.gasLimit))}%)`,
              ],
              [t('blockGasLimit'), row.gasLimit],
              [
                t('gasBaseFee', { height: String(row.height) }),
                row.baseFeePerGas === null ? t('gasBaseFeeNone') : t('gwei', { amount: gwei(row.baseFeePerGas) }),
              ],
              [
                t('blockMiner'),
                <a key="miner" href={`/chain/address/${row.miner}`}>
                  {row.miner}
                </a>,
              ],
              [t('blockSize'), t('blockSizeBytes', { size: row.size })],
            ]}
          />
        </Panel>
        <Panel title={t('blockTxs')}>
          <TxTable key={row.hash} api={api} chain={chain} label={t('blockTxs')} blockHash={row.hash} emptyWords={t('blockTxsNone')} t={t} />
        </Panel>
      </>
    );
  }
  return (
    <ExplorerRecord title={t('blockTitle', { height: String(height) })}>
      {body}
      <BackToChain t={t} />
    </ExplorerRecord>
  );
}

/**
 * The indexer's status in words. The indexer marks a transaction `replaced` only when its block was reorged and another
 * transaction took its place, so the replacing hash leads; any other transaction from a reorged block keeps its outcome and
 * says the block was reorged. Nothing reorged or replaced ever reads as plain Success.
 */
export function txStatusWords(tx: ExplorerTx, t: ExplorerTranslate): string {
  if (tx.status === 'replaced') return tx.replacingHash ? t('txReplacedBy', { hash: short(tx.replacingHash) }) : t('txReplaced');
  const outcome = t(TX_STATUS[tx.status]);
  return tx.orphaned ? t('txOrphaned', { outcome, reason: tx.orphaned.reason }) : outcome;
}
const TX_STATUS: Record<ExplorerTx['status'], 'txSuccess' | 'txReverted' | 'txPending' | 'txDropped' | 'txReplaced'> = {
  success: 'txSuccess',
  failed: 'txReverted',
  pending: 'txPending',
  dropped: 'txDropped',
  replaced: 'txReplaced',
};

/** The indexer stores `indexer.trace_unavailable` when the node refused to trace the transaction: worded here, not stored as words. */
function revertReasonWords(reason: string | null, t: ExplorerTranslate): string {
  if (reason === null) return t('noReasonReturned');
  return reason === 'indexer.trace_unavailable' ? t('reasonNotTraced') : reason;
}

type TxTab = 'input' | 'logs';

/**
 * One transaction (D-explorer-03): status, the revert reason or "No reason returned", the input decoded against the
 * interfaces this explorer knows (never an invented name), and its logs. A hash the indexer never saw is "Not found".
 */
export function TxPage({ hash }: { hash: string }) {
  const { t, api } = useExplorer();
  const chain = useChainRef('explorer:tx');
  const chainId = chain.status === 'ready' ? chain.chainId : null;
  const tx = useResource(
    (signal) => (chainId === null ? Promise.resolve({ ok: true as const, data: null }) : api.tx(chainId, hash, signal)),
    `explorer:tx:${chainId ?? 'none'}:${hash}`,
  );
  const { resource } = tx;
  const network = networkLabel(chainId).name;
  let body: ReactNode;
  if (chain.status !== 'ready') body = <ChainWait chain={chain} t={t} label={t('txTitle')} />;
  else if (resource.status === 'loading') body = <Loading label={t('txTitle')} />;
  else if (resource.status === 'failed')
    body = isNotFound(resource.failure.code) ? (
      <Panel title={t('txNotFound')}>
        <div data-code="protocol.not_found" role="status">
          <EmptyState title={t('txNotFound')}>{t('txNotFoundBody', { network })}</EmptyState>
        </div>
      </Panel>
    ) : (
      <Panel title={t('txFacts')}>
        <BlockerNote
          title={t('txRefused', { reason: refusalWords(resource.failure, t) })}
          action={
            <Button tone="secondary" onClick={tx.reload}>
              {t('retry')}
            </Button>
          }
        />
      </Panel>
    );
  else if (resource.data) body = <TxBody tx={resource.data} t={t} />;
  return (
    <ExplorerRecord title={t('txTitle')} description={hash}>
      {body}
      <BackToChain t={t} />
    </ExplorerRecord>
  );
}

function TxBody({ tx, t }: { tx: ExplorerTx; t: ExplorerTranslate }) {
  const [tab, setTab] = useState<TxTab>('input');
  const body = tx.transaction;
  const receipt = tx.receipt;
  const rows: [string, ReactNode, string?][] = [[t('txStatus'), txStatusWords(tx, t), 'tx-status']];
  if (tx.status === 'failed') rows.push([t('txRevertReason'), revertReasonWords(receipt?.revertReason ?? null, t), 'tx-revert-reason']);
  rows.push([t('txHash'), <code key="hash">{tx.hash}</code>]);
  if (body) {
    rows.push(
      [t('txBlock'), body.index ?? t('notReturned')],
      [
        t('txFrom'),
        <a key="from" href={`/chain/address/${body.from}`}>
          {body.from}
        </a>,
      ],
      [
        t('txTo'),
        body.to ? (
          <a key="to" href={`/chain/address/${body.to}`}>
            {body.to}
          </a>
        ) : (
          t('txCreated')
        ),
      ],
      [t('txValue'), nativeAmount(body.value)],
      [t('txNonce'), body.nonce],
      [t('txGasLimit'), body.gasLimit],
      [t('txGasPrice'), body.gasPrice === null ? t('notReturned') : t('gwei', { amount: gwei(body.gasPrice) })],
    );
  }
  if (receipt) {
    rows.push([t('txGasUsed'), receipt.gasConsumed ?? t('notReturned')]);
    if (receipt.createdContract)
      rows.push([
        t('txCreated'),
        <a key="created" href={`/chain/address/${receipt.createdContract}`}>
          {receipt.createdContract}
        </a>,
      ]);
  }
  return (
    <>
      <Panel title={t('txFacts')}>
        <Facts label={t('txFacts')} rows={rows} />
      </Panel>
      <TabList
        label={t('txTabs')}
        tabs={[
          { id: 'input', label: t('tabInput') },
          { id: 'logs', label: t('tabLogs') },
        ]}
        value={tab}
        onChange={setTab}
      >
        {tab === 'input' ? <InputView tx={tx} t={t} /> : <LogsView tx={tx} t={t} />}
      </TabList>
    </>
  );
}

function InputView({ tx, t }: { tx: ExplorerTx; t: ExplorerTranslate }) {
  const body = tx.transaction;
  if (!body) return <p className="lt-hint">{t('notReturned')}</p>;
  const decoded = decodeInput(body.input, body.to);
  return (
    <section aria-label={t('tabInput')}>
      {decoded.kind === 'empty' && <p>{t('inputEmpty')}</p>}
      {decoded.kind === 'creation' && <p>{t('inputCreation')}</p>}
      {decoded.kind === 'unknown' && <p>{t('inputUnknown', { selector: decoded.selector })}</p>}
      {decoded.kind === 'decoded' && (
        <>
          <p>
            {t('inputMethod')}: <code data-testid="tx-input-method">{decoded.method}</code>
          </p>
          <dl className="lt-kv" data-testid="tx-input-args">
            {decoded.args.map((arg) => (
              <div key={arg.name}>
                <dt>
                  {arg.name} <span className="lt-hint">{arg.type}</span>
                </dt>
                <dd>
                  <code>{arg.value}</code>
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {decoded.kind !== 'decoded' && decoded.kind !== 'empty' && (
        <details>
          <summary>{t('inputRaw')}</summary>
          <code className="lt-mono">{body.input}</code>
        </details>
      )}
    </section>
  );
}

function LogsView({ tx, t }: { tx: ExplorerTx; t: ExplorerTranslate }) {
  if (tx.logs.length === 0) return <p className="lt-hint">{t('logsNone')}</p>;
  return (
    <ol>
      {tx.logs.map((log) => (
        <li key={log.logIndex}>
          <h3>{t('logIndex', { index: String(log.logIndex) })}</h3>
          <Facts
            label={t('logIndex', { index: String(log.logIndex) })}
            rows={[
              [
                t('logEmitter'),
                <a key="emitter" href={`/chain/address/${log.address}`}>
                  {log.address}
                </a>,
              ],
              [
                t('logTopics'),
                <ol key="topics">
                  {log.topics.map((topic, i) => (
                    <li key={i}>
                      <code className="lt-mono">{topic}</code>
                    </li>
                  ))}
                </ol>,
              ],
              [
                t('logData'),
                <code key="data" className="lt-mono">
                  {log.data}
                </code>,
              ],
            ]}
          />
        </li>
      ))}
    </ol>
  );
}
