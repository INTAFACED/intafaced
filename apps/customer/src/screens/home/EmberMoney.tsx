import { BrandMark } from '@intafaced/ui';
import { homeCopy } from './copy';
import { fmtUsd, Money, Skeleton, type HomePortfolio, type Loadable } from './deps';
import './ember.css';

/**
 * The Ember direction's money object (intafaced issue 9227; drawn only under `data-direction="ember"`, see Home): the
 * account as a stack of two cards, Cash in front and Crypto behind, each a link to its part of Money and each reading
 * its own figure from the same portfolio call as the total. The brand mark sits on the front card as a lit object.
 * Light comes from the cards' edges; nothing here moves.
 */
export function EmberMoney({ portfolio, hidden }: { portfolio: Loadable<HomePortfolio>; hidden: boolean }) {
  const { t } = homeCopy.useCopy();
  if (portfolio.status !== 'ready' && portfolio.status !== 'loading') return null;
  const data = portfolio.status === 'ready' ? portfolio.data : null;
  const cards = [
    { id: 'crypto', label: t('Crypto'), value: data?.cryptoUsd ?? null },
    { id: 'cash', label: t('Cash'), value: data?.cashUsd ?? null },
  ] as const;
  return (
    <section data-testid="home-ember-money" className="home-ember-money" aria-label={t('Your holdings')} aria-busy={!data || undefined}>
      {cards.map((card) => (
        <a key={card.id} className={`home-ember-card home-ember-card--${card.id}`} href={`/money#${card.id}`}>
          {card.id === 'cash' ? (
            <span className="home-ember-card__mark" aria-hidden="true">
              <BrandMark size={28} />
            </span>
          ) : null}
          <span className="home-ember-card__label">{card.label}</span>
          {data ? (
            <Money className="home-ember-card__value" value={fmtUsd(card.value)} hidden={hidden} />
          ) : (
            <Skeleton width={120} height={28} className="home-ember-card__value" />
          )}
        </a>
      ))}
    </section>
  );
}
