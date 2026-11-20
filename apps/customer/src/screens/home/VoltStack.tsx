import { BrandMark } from '@intafaced/ui';
import { homeCopy } from './copy';
import { fmtUsd, Money, Skeleton, type HomePortfolio, type Loadable } from './deps';
import './volt.css';

/**
 * The Volt direction's money object (intafaced #9227; only under `data-direction="volt"`): the account as a stack of
 * two cards, cash in front as matte black metal, crypto behind it as the screen's one spark of colour. Each card opens
 * its part of Money. Figures are the portfolio's own (decimal strings, never numbers); nothing on a card is made up.
 */
export function VoltStack({ portfolio, hidden }: { portfolio: Loadable<HomePortfolio>; hidden: boolean }) {
  const { t } = homeCopy.useCopy();
  if (portfolio.status === 'loading')
    return (
      <section className="volt-stack" aria-hidden="true">
        <div className="volt-card volt-card--back" />
        <div className="volt-card volt-card--front">
          <Skeleton width={120} height={28} />
        </div>
      </section>
    );
  if (portfolio.status !== 'ready' || portfolio.data.holdings.length === 0) return null;
  const data = portfolio.data;
  return (
    <section data-testid="volt-stack" className="volt-stack" aria-label={t('Your holdings')}>
      <a className="volt-card volt-card--back" href="/money#crypto">
        <span className="volt-card__label">{t('Crypto')}</span>
        <Money className="volt-card__peek" value={fmtUsd(data.cryptoUsd)} hidden={hidden} />
      </a>
      <a className="volt-card volt-card--front" href="/money#cash">
        <span className="volt-card__top">
          <BrandMark size={24} className="volt-card__mark" />
          <span className="volt-card__label">{t('Cash')}</span>
        </span>
        <Money className="volt-card__figure" value={fmtUsd(data.cashUsd)} hidden={hidden} />
      </a>
    </section>
  );
}
