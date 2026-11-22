import { useMemo, useState, type ReactNode } from 'react';
import type { ProtocolPortfolio } from '@intafaced/contracts/protocol-portfolio';
import { PRICE_SETTINGS_UNSET } from '@intafaced/contracts/protocol-swap';
import { usePreferences } from '../../../shared/preferences';
import { Button } from '@intafaced/ui/lit';
import { DataTable, EmptyState, Failure, Loading, Panel } from '../volt/parts';
import { useApi } from '../../session';
import { createProtocolApi } from '../api';
import { portfolioCopy, type PortfolioTranslate } from './portfolio-copy';
import { tokenAmount, usdDisplay } from './portfolio-format';
import { usePolled } from './use-polled';
import { conventionPath } from './portfolio-paths';
import { useWallet } from './WalletProvider';

/** How often the portfolio is read again while it is open: a new block can change any figure. */
const READ_EVERY_MS = 3_000;

/** The ones the profit and loss view links. */
const PNL_CONVENTIONS = ['pnl', 'drawdown', 'prices', 'entry'] as const;
export const holdingPath = (token: string) => `/wallet/tokens/${token.toLowerCase()}`;

/** The connected wallet's portfolio, read again every few seconds; null with no wallet on this network. */
export function usePortfolio() {
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

export function ReadState({
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
      <p className="lt-hint">{t('readFailed')}</p>
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
        <p className="lt-hint">{t('portfolioNote')}</p>
        {!connected ? (
          <EmptyState title={t('needsWallet')} />
        ) : !data ? (
          <ReadState failure={failure} retry={reload} t={t} />
        ) : (
          <>
            <Totals data={data} t={t} />
            <div className="lt-actions" role="group" aria-label={t('portfolioTitle')}>
              <Button
                tone={view === 'holdings' ? 'primary' : 'secondary'}
                aria-pressed={view === 'holdings'}
                onClick={() => setView('holdings')}
              >
                {t('holdingsButton')}
              </Button>
              <Button tone={view === 'pnl' ? 'primary' : 'secondary'} aria-pressed={view === 'pnl'} onClick={() => setView('pnl')}>
                {t('pnlButton')}
              </Button>
              <Button
                tone={view === 'positions' ? 'primary' : 'secondary'}
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
      <dl className="lt-kv">
        <div>
          <dt>{t('totalLabel')}</dt>
          <dd className="lt-mono" data-testid="portfolio-total">
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
              <a href={holdingPath(row.token)}>{row.name}</a> <span className="lt-hint">{row.symbol}</span>
            </td>
            <td className="lt-mono">{tokenAmount(row.balance, row.decimals)}</td>
            <td className="lt-mono">{row.usd === null ? t(`noPrice_${row.reason ?? 'no_route'}`) : usdDisplay(row.usd)}</td>
            <td className="lt-mono">{row.valueUsd === null ? '—' : usdDisplay(row.valueUsd)}</td>
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
        <dl className="lt-kv">
          <div>
            <dt>{t('pnlLabel')}</dt>
            <dd className="lt-mono" data-testid="pnl">
              {usdDisplay(data.pnl.usd)}
            </dd>
          </div>
          <div>
            <dt>{t('drawdownLabel')}</dt>
            <dd className="lt-mono" data-testid="max-drawdown">
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
        <p className="lt-hint" data-testid="pnl-excludes">
          {t('pnlExcludes', {
            deposits: usdDisplay(data.pnl.depositsUsd),
            withdrawals: usdDisplay(data.pnl.withdrawalsUsd),
            block: data.pnl.sinceBlock,
          })}
        </p>
      )}
      <ul aria-label={t('conventionsLabel')} className="lt-actions">
        {PNL_CONVENTIONS.map((id) => (
          <li key={id}>
            <a href={conventionPath(id)}>{t(`conv_${id}`)}</a>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
