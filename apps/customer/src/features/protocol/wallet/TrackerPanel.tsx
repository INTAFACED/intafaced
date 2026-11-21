import { useMemo, useState, type FormEvent } from 'react';
import type { ProtocolPortfolio } from '@intafaced/contracts/protocol-portfolio';
import { createApiClient } from '../../../shared/api';
import { usePreferences } from '../../../shared/preferences';
import { Button, DataTable, EmptyState, Field, Panel } from '../../../shared/ui';
import { createProtocolApi } from '../api';
import { portfolioCopy, type PortfolioTranslate } from './portfolio-copy';
import { ADDRESS_TEXT, tokenAmount, usdDisplay } from './portfolio-format';
import { usePolled } from './use-polled';

/** How often a tracked address is read again while it is shown. */
const READ_EVERY_MS = 5_000;
/** The watchlist's key in this browser's own storage. It is never sent anywhere. */
const WATCHLIST_KEY = 'intafaced.wallet.watchlist';
/** The most addresses the watchlist keeps; the oldest goes first. A bound on this browser's storage, not a product limit. */
const WATCHLIST_KEPT = 50;

function readWatchlist(): string[] {
  try {
    const raw = localStorage.getItem(WATCHLIST_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string' && ADDRESS_TEXT.test(entry)) : [];
  } catch {
    return [];
  }
}
function writeWatchlist(list: string[]) {
  try {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));
  } catch {
    /* storage blocked: the watchlist lasts for this page only */
  }
}

/**
 * /wallet/track (D-portfolio-wallet-04, RC-dex-protocol-17, J-dex-protocol-06 #5 #6): any public address's holdings and
 * token history. The read goes through a client of its own that sends no cookie and no authorisation header, so it
 * carries the address and nothing about the person; the watchlist lives in this browser only, with no export.
 */
export function TrackerPanel() {
  const { language } = usePreferences();
  const { t } = portfolioCopy.forLocale(language);
  // No token and no cookie: this client knows nothing about who is signed in.
  const api = useMemo(() => createProtocolApi(createApiClient({ credentials: 'omit' })), []);
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [tracked, setTracked] = useState<string | null>(null);
  const [watchlist, setWatchlist] = useState<string[]>(() => readWatchlist());

  const track = (address: string) => {
    setTracked(address);
    const next = [address, ...watchlist.filter((entry) => entry.toLowerCase() !== address.toLowerCase())].slice(0, WATCHLIST_KEPT);
    setWatchlist(next);
    writeWatchlist(next);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const address = text.trim();
    if (!ADDRESS_TEXT.test(address)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    track(address);
  };
  const remove = (address: string) => {
    const next = watchlist.filter((entry) => entry !== address);
    setWatchlist(next);
    writeWatchlist(next);
  };

  return (
    <>
      <Panel title={t('trackerTitle')}>
        <p className="muted">{t('trackerNote')}</p>
        <form aria-label={t('trackerTitle')} onSubmit={submit} className="form-stack" noValidate>
          <Field
            label={t('trackerAddress')}
            hint={t('trackerAddressHint')}
            value={text}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setText(event.target.value)}
            error={invalid ? t('trackerInvalid') : undefined}
          />
          <Button type="submit">{t('trackerButton')}</Button>
        </form>
      </Panel>
      {tracked && <Tracked key={tracked.toLowerCase()} address={tracked} api={api} t={t} />}
      <Panel title={t('watchlistLabel')}>
        {watchlist.length === 0 ? (
          <EmptyState title={t('watchlistEmpty')} />
        ) : (
          <ul aria-label={t('watchlistLabel')} className="protocol-actions">
            {watchlist.map((address) => (
              <li key={address}>
                <Button variant="ghost" className="numeric" onClick={() => track(address)}>
                  {address}
                </Button>{' '}
                <Button variant="secondary" aria-label={t('watchlistRemove', { address })} onClick={() => remove(address)}>
                  ×
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}

function Tracked({ address, api, t }: { address: string; api: ReturnType<typeof createProtocolApi>; t: PortfolioTranslate }) {
  const { data, failure, reload } = usePolled(
    (signal) => api.portfolio(address, signal),
    `wallet:tracked:${address.toLowerCase()}`,
    READ_EVERY_MS,
  );
  const title = t('trackedTitle', { address });
  return (
    <Panel title={title} aria-label={title}>
      {!data ? (
        failure ? (
          <>
            <p className="muted">{t('readFailed')}</p>
            <p role="alert">{failure.message}</p>
            <Button variant="secondary" onClick={reload}>
              {t('trackerButton')}
            </Button>
          </>
        ) : (
          <p role="status">…</p>
        )
      ) : data.holdings.length === 0 && data.transferCount === 0 ? (
        // An address with no history: said in words, never a table of zeros or a $0 value.
        <EmptyState title={t('noHistory')} />
      ) : (
        <TrackedBody data={data} t={t} />
      )}
    </Panel>
  );
}

function TrackedBody({ data, t }: { data: ProtocolPortfolio; t: PortfolioTranslate }) {
  const holdingHeaders = [t('hdr_token'), t('hdr_balance'), t('hdr_price'), t('hdr_value')];
  const historyHeaders = [t('hdr_block'), t('hdr_token'), t('hdr_direction'), t('hdr_amount'), t('hdr_counterparty'), t('hdr_tx')];
  return (
    <>
      <dl className="protocol-facts">
        <div>
          <dt>{t('totalLabel')}</dt>
          <dd className="numeric">{usdDisplay(data.totalUsd)}</dd>
        </div>
        <div>
          <dt>{t('asOf', { block: data.blockNumber })}</dt>
          <dd>
            <time dateTime={data.asOf}>{data.asOf}</time>
          </dd>
        </div>
      </dl>
      {data.unpriced > 0 && (
        <p role="note">{t(data.unpriced === 1 ? 'noPriceNote_one' : 'noPriceNote_other', { count: String(data.unpriced) })}</p>
      )}
      <DataTable label={t('holdingsLabel')} headers={holdingHeaders}>
        {data.holdings.length === 0 ? (
          <tr>
            <td colSpan={holdingHeaders.length}>
              <EmptyState title={t('holdingsEmpty')} />
            </td>
          </tr>
        ) : (
          data.holdings.map((row) => (
            <tr key={row.token}>
              <td>
                {row.name} <span className="muted">{row.symbol}</span>
              </td>
              <td className="numeric">{tokenAmount(row.balance, row.decimals)}</td>
              <td className="numeric">{row.usd === null ? t(`noPrice_${row.reason ?? 'no_route'}`) : usdDisplay(row.usd)}</td>
              <td className="numeric">{row.valueUsd === null ? '—' : usdDisplay(row.valueUsd)}</td>
            </tr>
          ))
        )}
      </DataTable>
      <HistoryTable data={data} headers={historyHeaders} t={t} />
    </>
  );
}

function HistoryTable({ data, headers, t }: { data: ProtocolPortfolio; headers: string[]; t: PortfolioTranslate }) {
  return (
    <section aria-label={t('historyLabel')}>
      <h3>{t('historyLabel')}</h3>
      {data.transferCount > data.transfers.length && (
        <p className="muted">{t('historyNewest', { shown: String(data.transfers.length), count: String(data.transferCount) })}</p>
      )}
      <DataTable label={t('transfersLabel')} headers={headers}>
        {data.transfers.map((row) => (
          <tr key={`${row.tx}:${row.token}:${row.direction}:${row.amount}`}>
            <td className="numeric">
              <a href={`/chain/blocks/${row.block}`}>{row.block}</a>
            </td>
            <td>{row.symbol}</td>
            <td>
              {row.direction === 'in' ? t('dirIn') : t('dirOut')}
              {row.pool && <span className="muted"> · {t('poolTrade')}</span>}
            </td>
            <td className="numeric">{tokenAmount(row.amount, row.decimals)}</td>
            <td className="numeric">
              <a href={`/chain/address/${row.counterparty}`}>{row.counterparty}</a>
            </td>
            <td className="numeric">
              <a href={`/chain/tx/${row.tx}`} title={row.tx}>
                {row.tx.slice(0, 10)}…
              </a>
            </td>
          </tr>
        ))}
      </DataTable>
    </section>
  );
}
