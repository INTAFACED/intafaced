import { homeCopy } from './copy';
import { Money, StatusTag, fmtUsd, type HomePortfolio, type Loadable } from './deps';
import { isTestBuild } from '../../shared/test-build';

/**
 * The Lit glass direction's money object (intafaced issue 9227): the money a person holds drawn as two frosted glass
 * cards, crypto behind and cash in front, over the light they sit in. Only drawn with the direction on
 * (`data-direction='lit-glass'`, look.ts); the figures are the same ones Home's holdings rows read, each a link to its
 * place on Money. Static: no motion of its own (glass-stack.css).
 */
export function GlassStack({ portfolio, hidden }: { portfolio: Loadable<HomePortfolio>; hidden: boolean }) {
  const { t } = homeCopy.useCopy();
  if (portfolio.status === 'loading')
    return (
      <div className="lg-stack" aria-hidden="true">
        <div className="lg-stack__light" />
        <div className="lg-card lg-card--back" />
        <div className="lg-card lg-card--front lg-card--waiting" />
      </div>
    );
  if (portfolio.status !== 'ready' || portfolio.data.holdings.length === 0) return null;
  const test = isTestBuild();
  const cards = [
    { id: 'crypto', label: t('Crypto'), value: portfolio.data.cryptoUsd, place: 'back' },
    { id: 'cash', label: t('Cash'), value: portfolio.data.cashUsd, place: 'front' },
  ] as const;
  return (
    <section data-testid="lg-stack" className="lg-stack" aria-label={t('Your holdings')}>
      <div className="lg-stack__light" aria-hidden="true" />
      {cards.map((card) => (
        <a key={card.id} className={`lg-card lg-card--${card.place}`} href={`/money#${card.id}`}>
          <span className="lg-card__top">
            <span className="lg-card__label">{card.label}</span>
            <span className="lg-card__mark" aria-hidden="true" />
          </span>
          <span className="lg-card__foot">
            <Money className="lg-card__value" value={fmtUsd(card.value)} hidden={hidden} />
            {test ? <StatusTag data-status="test" className="lg-card__test" status="pending" label={t('TEST')} /> : null}
          </span>
        </a>
      ))}
    </section>
  );
}
