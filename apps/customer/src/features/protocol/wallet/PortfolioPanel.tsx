import { useMemo, useState, type ReactNode } from 'react';
import type { ProtocolPortfolio } from '@intafaced/contracts/protocol-portfolio';
import { PRICE_SETTINGS_UNSET } from '@intafaced/contracts/protocol-swap';
import { usePreferences } from '../../../shared/preferences';
import { Button, DataTable, EmptyState, Failure, Loading, Page, Panel } from '../../../shared/ui';
import { useApi } from '../../session/session';
import { createProtocolApi } from '../api';
import { portfolioCopy, type PortfolioTranslate } from './portfolio-copy';
import { tokenAmount, usdDisplay } from './portfolio-format';
import { usePolled } from './use-polled';
import { useWallet } from './WalletProvider';

/** How often the portfolio is read again while it is open: a new block can change any figure. */
const READ_EVERY_MS = 3_000;

/** Every convention with its own page under /wallet/conventions/<id>. */
export const CONVENTIONS = ['pnl', 'drawdown', 'prices', 'entry', 'modes'] as const;
/** The ones the profit and loss view links. */
const PNL_CONVENTIONS = ['pnl', 'drawdown', 'prices', 'entry'] as const;
export type Convention = (typeof CONVENTIONS)[number];
export const conventionPath = (id: Convention) => `/wallet/conventions/${id}`;
export const holdingPath = (token: string) => `/wallet/tokens/${token.toLowerCase()}`;

/** The connected wallet's portfolio, read again every few seconds; null with no wallet on this network. */
function usePortfolio() {
  const wallet = useWallet();
  const transport = useApi();
  const api = useMemo(() => createProtocolApi(transport), [transport]);
  const connected = wallet.status === 'connected' && wallet.address && wallet.guard?.ok !== false ? wallet.address : null;
  const read = usePolled(
    (signal) => (connected ? api.portfolio(connected, signal) : Promise.resolve(null)),
    `wallet:portfolio:${connected?.toLowerCase() ?? 'none'}`,
    READ_EVERY_MS,
  );
  return { connected, ...read };
}

function ReadState({
  failure,
  retry,
  t,
}: {
  failure: Parameters<typeof Failure>[0]['result'] | null;
  retry: () => void;
  t: PortfolioTranslate;
}): ReactNode {
  if (!failure) return <Loading />;
  // The owner's price settings unset: no value is stated, and the page says why rather than showing a zero.
  if (failure.code === PRICE_SETTINGS_UNSET)
    return (
      <p role="note" data-blocker="price_feed" data-code={PRICE_SETTINGS_UNSET}>
        {failure.message}
      </p>
    );
  return (
    <>
      <p className="muted">{t('readFailed')}</p>
      <Failure result={failure} retry={retry} />
    </>
  );
}

/**
 * The wallet room's Overview portfolio (D-portfolio-wallet-04, J-dex-protocol-06 #1 #2): the total of every priced
 * holding, the holdings with each token's price or why it has none, and the profit and loss view with its conventions.
 * Read from the chain through svc-protocol; nothing here is a balance INTAFACED holds, and nothing here signs.
 */
export function PortfolioPanel({ positions }: { positions?: ReactNode }) {
  const { language } = usePreferences();
  const { t } = portfolioCopy.forLocale(language);
  const { connected, data, failure, reload } = usePortfolio();
  const [view, setView] = useState<'holdings' | 'pnl' | 'positions'>('holdings');
  return (
    <>
      <Panel title={t('portfolioTitle')} aria-label={t('portfolioTitle')} data-portfolio>
        <p className="muted">{t('portfolioNote')}</p>
        {!connected ? (
          <EmptyState title={t('needsWallet')} />
        ) : !data ? (
          <ReadState failure={failure} retry={reload} t={t} />
        ) : (
          <>
            <Totals data={data} t={t} />
            <div className="protocol-actions" role="group" aria-label={t('portfolioTitle')}>
              <Button
                variant={view === 'holdings' ? 'primary' : 'secondary'}
                aria-pressed={view === 'holdings'}
                onClick={() => setView('holdings')}
              >
                {t('holdingsButton')}
              </Button>
              <Button variant={view === 'pnl' ? 'primary' : 'secondary'} aria-pressed={view === 'pnl'} onClick={() => setView('pnl')}>
                {t('pnlButton')}
              </Button>
              <Button
                variant={view === 'positions' ? 'primary' : 'secondary'}
                aria-pressed={view === 'positions'}
                onClick={() => setView('positions')}
              >
                {t('positionsButton')}
              </Button>
            </div>
            <Holdings data={data} t={t} />
          </>
        )}
      </Panel>
      {connected && data && view === 'pnl' && <ProfitAndLoss data={data} t={t} />}
      {connected && view === 'positions' && (
        <Panel title={t('positionsTitle')} aria-label={t('positionsTitle')}>
          {positions}
        </Panel>
      )}
    </>
  );
}

function Totals({ data, t }: { data: ProtocolPortfolio; t: PortfolioTranslate }) {
  return (
    <>
      <dl className="protocol-facts">
        <div>
          <dt>{t('totalLabel')}</dt>
          <dd className="numeric" data-testid="portfolio-total">
            {usdDisplay(data.totalUsd)}
          </dd>
        </div>
        <div>
          <dt>{t('asOf', { block: data.blockNumber })}</dt>
          <dd>
            <time dateTime={data.asOf}>{data.asOf}</time>
          </dd>
        </div>
      </dl>
      {data.unpriced > 0 && (
        <p role="note" data-unpriced={data.unpriced}>
          {t(data.unpriced === 1 ? 'noPriceNote_one' : 'noPriceNote_other', { count: String(data.unpriced) })}
        </p>
      )}
    </>
  );
}

function Holdings({ data, t }: { data: ProtocolPortfolio; t: PortfolioTranslate }) {
  const headers = [t('hdr_token'), t('hdr_balance'), t('hdr_price'), t('hdr_value')];
  return (
    <DataTable label={t('holdingsLabel')} headers={headers}>
      {data.holdings.length === 0 ? (
        <tr>
          <td colSpan={headers.length}>
            <EmptyState title={t('holdingsEmpty')} />
          </td>
        </tr>
      ) : (
        data.holdings.map((row) => (
          <tr key={row.token} data-token={row.token}>
            <td>
              <a href={holdingPath(row.token)}>{row.name}</a> <span className="muted">{row.symbol}</span>
            </td>
            <td className="numeric">{tokenAmount(row.balance, row.decimals)}</td>
            <td className="numeric">{row.usd === null ? t(`noPrice_${row.reason ?? 'no_route'}`) : usdDisplay(row.usd)}</td>
            <td className="numeric">{row.valueUsd === null ? '—' : usdDisplay(row.valueUsd)}</td>
          </tr>
        ))
      )}
    </DataTable>
  );
}

/** J-dex-protocol-06 #2: profit and loss with money in and out left out, the largest fall, and the conventions. */
function ProfitAndLoss({ data, t }: { data: ProtocolPortfolio; t: PortfolioTranslate }) {
  return (
    <Panel title={t('pnlTitle')} aria-label={t('pnlTitle')}>
      {data.pnl === null ? (
        <EmptyState title={t('pnlNone')} />
      ) : (
        <dl className="protocol-facts">
          <div>
            <dt>{t('pnlLabel')}</dt>
            <dd className="numeric" data-testid="pnl">
              {usdDisplay(data.pnl.usd)}
            </dd>
          </div>
          <div>
            <dt>{t('drawdownLabel')}</dt>
            <dd className="numeric" data-testid="max-drawdown">
              {data.drawdown === null
                ? t('drawdownNone')
                : t('drawdownText', {
                    pct: data.drawdown.pct,
                    peak: usdDisplay(data.drawdown.peakUsd),
                    peakBlock: data.drawdown.peakBlock,
                    trough: usdDisplay(data.drawdown.troughUsd),
                    troughBlock: data.drawdown.troughBlock,
                  })}
            </dd>
          </div>
        </dl>
      )}
      {data.pnl && (
        <p className="muted" data-testid="pnl-excludes">
          {t('pnlExcludes', {
            deposits: usdDisplay(data.pnl.depositsUsd),
            withdrawals: usdDisplay(data.pnl.withdrawalsUsd),
            block: data.pnl.sinceBlock,
          })}
        </p>
      )}
      <ul aria-label={t('conventionsLabel')} className="protocol-actions">
        {PNL_CONVENTIONS.map((id) => (
          <li key={id}>
            <a href={conventionPath(id)}>{t(`conv_${id}`)}</a>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/**
 * /wallet/tokens/<address> (J-dex-protocol-06 #3): one token the wallet holds, with its entry price, the price at the
 * block each amount of it arrived, saying so.
 */
export function HoldingPage({ token }: { token: string }) {
  const { language } = usePreferences();
  const { t } = portfolioCopy.forLocale(language);
  const { connected, data, failure, reload } = usePortfolio();
  const row = data?.holdings.find((entry) => entry.token.toLowerCase() === token.toLowerCase()) ?? null;
  return (
    <Page title={row?.name ?? token} description={t('portfolioNote')}>
      <p>
        <a href="/wallet">{t('tokenBack')}</a>
      </p>
      {!connected ? (
        <EmptyState title={t('needsWallet')} />
      ) : !data ? (
        <ReadState failure={failure} retry={reload} t={t} />
      ) : !row ? (
        <EmptyState title={t('tokenMissing')} />
      ) : (
        <Panel title={row.name} aria-label={row.name}>
          <dl className="protocol-facts">
            <div>
              <dt>{t('entryLabel')}</dt>
              <dd className="numeric" data-testid="entry-price">
                {row.entry === null
                  ? t('entryNone')
                  : row.entry.arrivals === 1
                    ? t('entryOne', { price: usdDisplay(row.entry.usd), block: row.entry.lastBlock })
                    : t('entryMany', {
                        price: usdDisplay(row.entry.usd),
                        count: String(row.entry.arrivals),
                        first: row.entry.firstBlock,
                        last: row.entry.lastBlock,
                      })}
                {row.entry && row.entry.unpriced > 0 && <> {t('entryUnpriced', { count: String(row.entry.unpriced) })}</>}
              </dd>
            </div>
            <div>
              <dt>{t('tokenBalance')}</dt>
              <dd className="numeric">
                {tokenAmount(row.balance, row.decimals)} {row.symbol}
              </dd>
            </div>
            <div>
              <dt>{t('tokenPrice')}</dt>
              <dd className="numeric">{row.usd === null ? t(`noPrice_${row.reason ?? 'no_route'}`) : usdDisplay(row.usd)}</dd>
            </div>
            <div>
              <dt>{t('tokenValue')}</dt>
              <dd className="numeric">{row.valueUsd === null ? '—' : usdDisplay(row.valueUsd)}</dd>
            </div>
          </dl>
          <p className="muted">
            <a href={conventionPath('entry')}>{t('conv_entry')}</a>
          </p>
        </Panel>
      )}
    </Page>
  );
}

/** /wallet/conventions/<id>: one convention the portfolio follows, in plain words. */
export function ConventionPage({ id }: { id: string }) {
  const { language } = usePreferences();
  const { t } = portfolioCopy.forLocale(language);
  const known = (CONVENTIONS as readonly string[]).includes(id) ? (id as Convention) : null;
  return (
    <Page title={known ? t(`conv_${known}`) : t('conventionMissing')}>
      {known && <p>{t(`conv_${known}_body`)}</p>}
      <p>
        <a href="/wallet">{t('tokenBack')}</a>
      </p>
    </Page>
  );
}
