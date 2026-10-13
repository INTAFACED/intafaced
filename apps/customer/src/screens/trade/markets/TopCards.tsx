import { ChevronRight } from 'lucide-react';
import { assetName, marketsCopy } from './copy';
import { CoinIcon, fmtPct, isHiddenPath, Pct, Skeleton } from './deps';
import { marketTarget, priceText, type Card, type CardId, type Mode } from './select';

const TITLE = { popular: 'Popular', new: 'New listings', gainers: 'Top gainers' } as const;

/** Skeletons inside a panel use the field colour: the kit's own skeleton colour is the panel colour (critic M4). */
const IN_PANEL = 'bg-field';

export function TopCards({ cards, mode, onSeeAll }: { cards: Card[]; mode: Mode; onSeeAll: (id: CardId) => void }) {
  const copy = marketsCopy.useCopy();
  const { t } = copy;
  return (
    <section className="mkt-cards" aria-label={t('Markets')}>
      {cards.map((card) => {
        const title = t(TITLE[card.id]);
        return (
          <article key={card.id} className="mkt-card" data-card={card.id}>
            <header className="mkt-card__head">
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
                  <a className="mkt-card__row" href={marketTarget(market, mode, isHiddenPath)}>
                    <CoinIcon asset={market.base} size={24} />
                    <span className="mkt-card__name" title={assetName(market.base, copy) ?? undefined}>
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
    <section className="mkt-cards" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <div key={index} className="mkt-card">
          <div className="mkt-card__head">
            <Skeleton width={96} height={20} className={IN_PANEL} />
          </div>
          <div className="mkt-card__list">
            {[0, 1, 2].map((row) => (
              <div key={row} className="mkt-card__row">
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
