import { usePreferences } from '../../../shared/preferences';
import { EmptyState, Page, Panel } from '../../../shared/ui';
import { portfolioCopy } from './portfolio-copy';
import { tokenAmount, usdDisplay } from './portfolio-format';
import { CONVENTIONS, conventionPath, type Convention } from './portfolio-paths';
import { ReadState, usePortfolio } from './PortfolioPanel';

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
