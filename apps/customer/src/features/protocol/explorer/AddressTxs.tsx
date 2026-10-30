import { useMemo, useState, type ReactNode } from 'react';
import { formatUnits } from 'viem';
import { useApi } from '../../session/session';
import { usePreferences } from '../../../shared/preferences';
import { useResource } from '../../../shared/resource';
import { Button, DataTable, EmptyState, Loading } from '../../../shared/ui';
import { networkLabel } from '../blockers';
import { explorerCopy, type ExplorerTranslate } from './copy';
import { createExplorerApi, type ExplorerAddressTxsPage } from './explorer-api';
import { BlockerNote, NoteRow, refusalWords, short, useChainRef } from './parts';
import './explorer.css';

type AddressTxRow = ExplorerAddressTxsPage['rows'][number];
type Transfer = AddressTxRow['transfers'][number];

/** A transfer's amount in the token's own decimals, or its raw base units when the contract did not say. No float. */
export function transferWords(transfer: Transfer, t: ExplorerTranslate): string {
  const { decimals, symbol, address } = transfer.token;
  const token = symbol ?? short(address);
  const amount = decimals === null ? t('rawUnits', { amount: transfer.amount }) : formatUnits(BigInt(transfer.amount), decimals);
  if (transfer.direction === 'in') return t('transferIn', { amount, token });
  if (transfer.direction === 'out') return t('transferOut', { amount, token });
  return t('transferSelf', { amount, token });
}

/**
 * The transactions an address sent, received, or was a party to as an ERC-20 transfer (D-explorer-03), newest first, in
 * pages of the owner's list limit. Every row is the indexer's; with no answer the table keeps its columns and says why.
 */
export function AddressTxs({ address }: { address: string }) {
  const { language } = usePreferences();
  const { t, renderedLocale } = explorerCopy.forLocale(language);
  const transport = useApi();
  const api = useMemo(() => createExplorerApi(transport), [transport]);
  const chain = useChainRef(`explorer:address:${address}`);
  const chainId = chain.status === 'ready' ? chain.chainId : null;
  const [cursor, setCursor] = useState<ExplorerAddressTxsPage['nextCursor']>(null);
  const txs = useResource(
    (signal) => (chainId === null ? Promise.resolve({ ok: true as const, data: null }) : api.addressTxs(chainId, address, signal, cursor)),
    `explorer:address-txs:${chainId ?? 'none'}:${address.toLowerCase()}${cursor ? `:${cursor.height}:${cursor.index}:${cursor.hash}` : ''}`,
  );
  const headers = [t('hdrHash'), t('hdrBlock'), t('hdrTime'), t('hdrFrom'), t('hdrTo'), t('hdrStatus'), t('hdrTransfers')];
  const { resource } = txs;
  const when = (seconds: number) => new Date(seconds * 1000).toLocaleString(renderedLocale, { dateStyle: 'medium', timeStyle: 'short' });
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
        <Loading label={t('addressTxs')} />
      </NoteRow>
    );
  else if (resource.status === 'failed')
    body = (
      <NoteRow span={headers.length}>
        <BlockerNote
          title={t('txsRefused', { reason: refusalWords(resource.failure, t) })}
          action={
            <Button variant="secondary" onClick={txs.reload}>
              {t('retry')}
            </Button>
          }
        />
      </NoteRow>
    );
  else if (!resource.data || resource.data.rows.length === 0)
    body = (
      <NoteRow span={headers.length}>
        <EmptyState title={t('addressTxsNone', { network: chainId === null ? '' : networkLabel(chainId).name })} />
      </NoteRow>
    );
  else
    body = resource.data.rows.map((row) => (
      <tr key={row.hash} data-tx={row.hash}>
        <th scope="row">
          <a href={`/chain/tx/${row.hash}`} title={row.hash}>
            {short(row.hash)}
          </a>
        </th>
        <td>
          <a href={`/chain/blocks/${row.blockHeight}`}>{row.blockHeight}</a>
        </td>
        <td>{when(row.timestamp)}</td>
        <td>
          <a href={`/chain/address/${row.from}`}>{short(row.from)}</a>
        </td>
        <td>{row.to ? <a href={`/chain/address/${row.to}`}>{short(row.to)}</a> : t('txCreated')}</td>
        <td>{row.status === 'success' ? t('txSuccess') : t('txReverted')}</td>
        <td>
          {row.transfers.map((transfer, i) => (
            <div key={i} data-direction={transfer.direction} data-token={transfer.token.address}>
              {transferWords(transfer, t)}
            </div>
          ))}
        </td>
      </tr>
    ));
  const page = resource.status === 'ready' ? resource.data : null;
  return (
    <>
      <DataTable label={t('addressTxs')} headers={headers}>
        {body}
      </DataTable>
      {page && page.asOfHeight !== null && <p className="muted">{t('addressTxsAsOf', { height: page.asOfHeight })}</p>}
      {page?.nextCursor && (
        <Button variant="secondary" onClick={() => setCursor(page.nextCursor)}>
          {t('moreTxs')}
        </Button>
      )}
    </>
  );
}
