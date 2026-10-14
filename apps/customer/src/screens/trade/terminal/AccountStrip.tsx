/**
 * The one-account strip above the instrument bar (PRO-TERMINAL-PLAN section 2): total value and what is available,
 * from the same portfolio the Money screen reads. Real numbers only: unknown is "—", never a guess, and coins with no
 * price are named as not counted rather than quietly left out of the total.
 */
import { useMemo } from 'react';
import { Money } from '@intafaced/ui';
import { fmtUsd, refusalCopy, usePortfolio } from '../../../data';
import { availableUsd } from './account';
import { terminalCopy } from './copy';
import { Skeleton } from '../desk/deps';

export function AccountStrip() {
  const { t } = terminalCopy.useCopy();
  const portfolio = usePortfolio();
  const available = useMemo(() => (portfolio.status === 'ready' ? availableUsd(portfolio.data) : null), [portfolio]);

  let body;
  if (portfolio.status === 'loading' || portfolio.status === 'empty') {
    body = <Skeleton width={220} height={16} className="bg-field" />;
  } else if (portfolio.status === 'refused') {
    body = (
      <span className="tm-strip-note">{portfolio.code === 'auth.required' ? t('Strip sign in') : refusalCopy(portfolio.code).title}</span>
    );
  } else if (portfolio.status === 'error') {
    body = (
      <>
        <span className="tm-strip-note">{t('Strip error')}</span>
        <button type="button" className="tm-strip-link" onClick={portfolio.retry}>
          {t('Strip retry')}
        </button>
      </>
    );
  } else {
    const missing = portfolio.data.unpriced.length;
    body = (
      <>
        <span className="tm-strip-item">
          <span className="tm-strip-label">{t('Total value')}</span>
          <Money value={fmtUsd(portfolio.data.totalUsd)} className="tm-strip-value" />
        </span>
        <span className="tm-strip-item">
          <span className="tm-strip-label">{t('Available')}</span>
          <Money value={fmtUsd(available?.value ?? null)} className="tm-strip-value" />
        </span>
        {missing > 0 ? (
          <span className="tm-strip-note">
            {missing === 1 ? t('Not counted one', { count: missing }) : t('Not counted many', { count: missing })}
          </span>
        ) : null}
      </>
    );
  }
  return (
    <section className="tm-strip" aria-label={t('Account strip')}>
      {body}
    </section>
  );
}
