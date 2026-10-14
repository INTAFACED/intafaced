import { useState } from 'react';
import { SegmentedControl, StatusTag } from '@intafaced/ui';
import type { ScreenProps } from '../../../app/screen-types';
import { fmtAmount, fmtUsd } from '../../../data/format';
import { compareDecimal, dec, str, sub } from '../../../data/decimal';
import { PreviewActionButton, PreviewChip, PreviewScreen } from '../../../preview';
import { cardFixture, type CardStatus } from '../../../preview/fixtures/card';
import './card.css';
import { CardVisual } from './CardVisual';
import { cardCopy } from './copy';
import { barPct } from './format';

const { card, spend, limits, controls, categories, transactions } = cardFixture.rows;
const topCategory = categories.reduce((max, c) => (compareDecimal(c.amount, max.amount) === 1 ? c : max), categories[0]!);

function remaining(): string {
  const left = sub(dec(spend.limit)!, dec(spend.spent)!);
  return str(left);
}

/** Card Preview: a virtual card (brand slot only), spending, limits, freeze and controls, and transactions. Sample data only. */
export default function CardPreview(_props: ScreenProps) {
  const { t } = cardCopy.useCopy();
  const [status, setStatus] = useState<CardStatus>('active');
  const frozen = status === 'frozen';

  return (
    <PreviewScreen product="card">
      <div className="pv-card">
        <div className="pv-card__top-grid">
          <section className="pv-card__panel pv-card__hero" aria-labelledby="pv-card-title">
            <div className="pv-card__panel-head">
              <h2 id="pv-card-title" className="pv-card__h2">
                {t('Your card')} <PreviewChip />
              </h2>
              <div className="pv-card__state">
                <span className="pv-card__label">{t('Sample state')}</span>
                <SegmentedControl
                  aria-label={t('Sample state')}
                  size={32}
                  value={status}
                  onValueChange={(next) => setStatus(next as CardStatus)}
                  items={[
                    { value: 'active', label: t('Active') },
                    { value: 'frozen', label: t('Frozen') },
                  ]}
                />
              </div>
            </div>
            <CardVisual card={card} status={status} />
            <div className="pv-card__actions">
              <PreviewActionButton product="card" variant="primary" size={40}>
                {frozen ? t('Unfreeze') : t('Freeze card')}
              </PreviewActionButton>
              <PreviewActionButton product="card" variant="secondary" size={40}>
                {t('Show details')}
              </PreviewActionButton>
              <PreviewActionButton product="card" variant="secondary" size={40}>
                {t('Add to wallet')}
              </PreviewActionButton>
              <PreviewActionButton product="card" variant="ghost" size={40}>
                {t('Order physical')}
              </PreviewActionButton>
            </div>
            <p className="pv-card__note">
              <span className="pv-card__label">{t('Funded from')}</span> {card.fundedFrom}. {t('Funding note')}
            </p>
          </section>

          <section className="pv-card__panel" aria-labelledby="pv-card-spend">
            <h2 id="pv-card-spend" className="pv-card__h2">
              {t('Spending title')} <PreviewChip />
            </h2>
            <p className="pv-card__big" data-testid="card-spent">
              {fmtUsd(spend.spent)}
            </p>
            <div className="pv-card__bar" role="img" aria-label={t('Of limit', { limit: fmtUsd(spend.limit) })}>
              <span style={{ width: `${barPct(spend.spent, spend.limit)}%` }} />
            </div>
            <p className="pv-card__note">
              {t('Of limit', { limit: fmtUsd(spend.limit) })}. {t('Remaining', { amount: fmtUsd(remaining()) })}.
            </p>
            <h3 className="pv-card__h3">{t('By category')}</h3>
            <ul className="pv-card__cats">
              {categories.map((category, index) => (
                <li key={category.id}>
                  <span className="pv-card__cat-name">
                    <span className="pv-card__swatch" data-i={index} aria-hidden="true" />
                    {category.label}
                  </span>
                  <span className="pv-card__num">{fmtUsd(category.amount)}</span>
                  <span className="pv-card__bar pv-card__bar--thin" aria-hidden="true">
                    <span data-top={category.id === topCategory.id} style={{ width: `${barPct(category.amount, topCategory.amount)}%` }} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="pv-card__two">
          <section className="pv-card__panel" aria-labelledby="pv-card-limits">
            <h2 id="pv-card-limits" className="pv-card__h2">
              {t('Limits title')} <PreviewChip />
            </h2>
            <ul className="pv-card__rows">
              {limits.map((limit) => (
                <li key={limit.id} data-testid="card-limit">
                  <div className="pv-card__row-top">
                    <span className="pv-card__strong">{limit.label}</span>
                    <span className="pv-card__num">
                      {limit.used === null
                        ? t('Limit single', { limit: fmtUsd(limit.limit) })
                        : t('Limit used', { used: fmtUsd(limit.used), limit: fmtUsd(limit.limit) })}
                    </span>
                  </div>
                  {limit.used === null ? null : (
                    <div className="pv-card__bar pv-card__bar--thin" aria-hidden="true">
                      <span style={{ width: `${barPct(limit.used, limit.limit)}%` }} />
                    </div>
                  )}
                  <div className="pv-card__row-top">
                    <span className="pv-card__label">{limit.period}</span>
                    <PreviewActionButton product="card" variant="ghost" size={28}>
                      {t('Change limit')}
                    </PreviewActionButton>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="pv-card__panel" aria-labelledby="pv-card-controls">
            <h2 id="pv-card-controls" className="pv-card__h2">
              {t('Controls title')} <PreviewChip />
            </h2>
            <ul className="pv-card__rows">
              {controls.map((control) => (
                <li key={control.id} className="pv-card__control" data-testid="card-control">
                  <div>
                    <span className="pv-card__strong">{control.label}</span>
                    <span className="pv-card__label">{control.detail}</span>
                  </div>
                  <span className="pv-card__control-state" data-on={control.on}>
                    {control.on ? t('Control on') : t('Control off')}
                  </span>
                  <PreviewActionButton product="card" variant="secondary" size={28}>
                    {control.on ? t('Turn off') : t('Turn on')}
                  </PreviewActionButton>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <section className="pv-card__panel" aria-labelledby="pv-card-tx" data-testid="card-transactions">
          <div className="pv-card__panel-head">
            <h2 id="pv-card-tx" className="pv-card__h2">
              {t('Transactions title')} <PreviewChip />
            </h2>
            <PreviewActionButton product="card" variant="secondary" size={32}>
              {t('Download statement')}
            </PreviewActionButton>
          </div>
          <div className="pv-card__scroll">
            <table className="pv-card__table">
              <thead>
                <tr>
                  <th scope="col">{t('Column merchant')}</th>
                  <th scope="col">{t('Column category')}</th>
                  <th scope="col">{t('Column when')}</th>
                  <th scope="col">{t('Column status')}</th>
                  <th scope="col" className="pv-card__right">
                    {t('Column cashback')}
                  </th>
                  <th scope="col" className="pv-card__right">
                    {t('Column amount')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx) => (
                  <tr key={tx.id}>
                    <th scope="row">{tx.merchant}</th>
                    <td>{tx.category}</td>
                    <td>{tx.when}</td>
                    <td>
                      <StatusTag
                        status={tx.status === 'pending' ? 'pending' : 'filled'}
                        label={tx.status === 'pending' ? t('Pending') : t('Settled')}
                      />
                    </td>
                    <td className="pv-card__right pv-card__num">
                      {tx.cashback === null ? t('No cashback') : `+${fmtAmount(tx.cashback, { places: 2, fixed: true })} IFC`}
                    </td>
                    <td className="pv-card__right pv-card__num">{fmtUsd(tx.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </PreviewScreen>
  );
}
