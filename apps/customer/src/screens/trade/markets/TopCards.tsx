import type { CSSProperties } from 'react';
import { ChevronRight } from 'lucide-react';
import { useSession } from '../../../features/session/session';
import { assetName, marketsCopy } from './copy';
import { CoinIcon, fmtPct, isHiddenPath, Pct, Skeleton } from './deps';
import { marketTarget, priceText, type Card, type CardId, type Mode } from './select';

const TITLE = { popular: 'Popular', new: 'New listings', gainers: 'Top gainers' } as const;

/** Skeletons inside a panel use the field colour: the kit's own skeleton colour is the panel colour (critic M4). */
const IN_PANEL = 'bg-field';

export function TopCards({ cards, mode, onSeeAll }: { cards: Card[]; mode: Mode; onSeeAll: (id: CardId) => void }) {
  const copy = marketsCopy.useCopy();
  const { t } = copy;
  const signedIn = Boolean(useSession().session);
  return (
    <section
      data-testid="mkt-cards"
      className="mkt-cards"
      aria-label={t('Markets')}
      style={{ '--mkt-card-count': Math.max(1, Math.min(3, cards.length)) } as CSSProperties}
    >
      {cards.map((card) => {
        const title = t(TITLE[card.id]);
        return (
          <article key={card.id} data-testid="mkt-card" className="mkt-card" data-card={card.id}>
            <header data-testid="mkt-card__head" className="mkt-card__head">
              <h2>{title}</h2>
              <button
                type="button"
                className="mkt-card__more"
                aria-label={t('See all {title}', { title })}
                onClick={() => onSeeAll(card.id)}
              >
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </header>
            <ul className="mkt-card__list">
              {card.entries.map(({ market, ticker }) => (
                <li key={market.symbol}>
                  <a data-testid="mkt-card__row" className="mkt-card__row" href={marketTarget(market, mode, isHiddenPath, signedIn)}>
                    <CoinIcon asset={market.base} size={24} />
                    <span data-testid="mkt-card__name" className="mkt-card__name" title={assetName(market.base, copy) ?? undefined}>
                      {market.base}
                      <span className="mkt-muted">/{market.quote}</span>
                    </span>
                    <span className="mkt-card__price" data-money>
                      {priceText(market, ticker?.last)}
                    </span>
                    <Pct value={fmtPct(ticker?.changePct24h)} className="mkt-card__pct" />
                  </a>
                </li>
              ))}
            </ul>
          </article>
        );
      })}
    </section>
  );
}

export function TopCardsSkeleton() {
  return (
    <section data-testid="mkt-cards" className="mkt-cards" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <div key={index} data-testid="mkt-card" className="mkt-card">
          <div data-testid="mkt-card__head" className="mkt-card__head">
            <Skeleton width={96} height={20} className={IN_PANEL} />
          </div>
          <div className="mkt-card__list">
            {[0, 1, 2].map((row) => (
              <div key={row} data-testid="mkt-card__row" className="mkt-card__row">
                <Skeleton width={24} height={24} circle className={IN_PANEL} />
                <Skeleton width={88} height={20} className={IN_PANEL} />
                <span className="mkt-card__price" />
                <Skeleton width={56} height={20} className={IN_PANEL} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
