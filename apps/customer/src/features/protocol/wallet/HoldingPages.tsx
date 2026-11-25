// volt-room: /wallet/tokens/:token
import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import { usePreferences } from '../../../shared/preferences';
import { EmptyState, Panel } from '../volt/parts';
import { portfolioCopy } from './portfolio-copy';
import { tokenAmount, usdDisplay } from './portfolio-format';
import { conventionPath } from './portfolio-paths';
import { ReadState, usePortfolio } from './PortfolioPanel';

/**
 * /wallet/tokens/<address> (J-dex-protocol-06 #3): one token the wallet holds, with its entry price, the price at the
 * block each amount of it arrived, saying so. One record's own page on the record-list template.
 */
export function HoldingPage({ token }: { token: string }) {
  const { language } = usePreferences();
  const { t } = portfolioCopy.forLocale(language);
  const { connected, data, failure, reload } = usePortfolio();
  const row = data?.holdings.find((entry) => entry.token.toLowerCase() === token.toLowerCase()) ?? null;
  const detail = (
    <>
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
          <dl className="lt-kv">
            <div>
              <dt>{t('entryLabel')}</dt>
              <dd className="lt-num" data-testid="entry-price">
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
              <dd className="lt-num">
                {tokenAmount(row.balance, row.decimals)} {row.symbol}
              </dd>
            </div>
            <div>
              <dt>{t('tokenPrice')}</dt>
              <dd className="lt-num">{row.usd === null ? t(`noPrice_${row.reason ?? 'no_route'}`) : usdDisplay(row.usd)}</dd>
            </div>
            <div>
              <dt>{t('tokenValue')}</dt>
              <dd className="lt-num">{row.valueUsd === null ? '—' : usdDisplay(row.valueUsd)}</dd>
            </div>
          </dl>
          <p className="lt-muted">
            <a href={conventionPath('entry')}>{t('conv_entry')}</a>
          </p>
        </Panel>
      )}
    </>
  );
  return (
    <RecordListTemplate
      title={row?.name ?? token}
      description={t('portfolioNote')}
      state={{ kind: 'ready' }}
      detailOnly
      list={null}
      detail={detail}
    />
  );
}
