import { ChevronRight } from 'lucide-react';
import { AssetIcon, Button, CardRow, Surface } from '@intafaced/ui/lit';
import { Skeleton } from '@intafaced/ui/lit/templates';
import { useSession } from '../../../features/session/session';
import { assetName, marketsCopy } from './copy';
import { isHiddenPath } from './deps';
import { Pct } from './parts';
import { marketTarget, priceText, type Card, type CardId, type Mode } from './select';

const TITLE = { popular: 'Popular', new: 'New listings', gainers: 'Top gainers' } as const;

/** Popular, New listings and Top gainers: up to three cards in one row (two share it), one under another on a phone. */
export function TopCards({ cards, mode, onSeeAll }: { cards: Card[]; mode: Mode; onSeeAll: (id: CardId) => void }) {
  const copy = marketsCopy.useCopy();
  const { t } = copy;
  const signedIn = Boolean(useSession().session);
  return (
    <CardRow as="section" data-testid="mkt-cards" aria-label={t('Markets')}>
      {cards.map((card) => {
        const title = t(TITLE[card.id]);
        return (
          <Surface key={card.id} material="raised" data-testid="mkt-card" data-card={card.id}>
            <article className="lt-stack">
              <header data-testid="mkt-card__head" className="lt-kv">
                <div>
                  <h2 className="lt-empty-title">{title}</h2>
                  <Button tone="quiet" aria-label={t('See all {title}', { title })} onClick={() => onSeeAll(card.id)}>
                    <ChevronRight size={16} aria-hidden="true" />
                  </Button>
                </div>
              </header>
              {/* One market a row, each a link across its row; the kit's label-and-value rows carry the row's height and line. */}
              <div className="lt-kv" role="list">
                {card.entries.map(({ market, ticker }) => {
                  const target = marketTarget(market, mode, isHiddenPath, signedIn);
                  // Nowhere shown to go (the beta's build without the desk): the row is plain words, never a link the beta drops.
                  const Row = target === null ? 'span' : 'a';
                  return (
                    <div key={market.symbol} role="listitem">
                      <Row data-testid="mkt-card__row" className="lt-row-link" data-span="row" href={target ?? undefined}>
                        <AssetIcon asset={market.base} size="sm" />
                        <span className="lt-lines">
                          <span data-testid="mkt-card__name" title={assetName(market.base, copy) ?? undefined}>
                            {market.base}
                            <span className="lt-muted">/{market.quote}</span>
                          </span>
                        </span>
                        <span data-part="figures">
                          <span className="lt-num" data-money dir="ltr">
                            {priceText(market, ticker?.last)}
                          </span>
                          <Pct value={ticker?.changePct24h} />
                        </span>
                      </Row>
                    </div>
                  );
                })}
              </div>
            </article>
          </Surface>
        );
      })}
    </CardRow>
  );
}

/** Three cards of three rows each, at their final size, while the markets load. */
export function TopCardsSkeleton() {
  return (
    <CardRow as="section" data-testid="mkt-cards" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <Surface key={index} material="raised" data-testid="mkt-card">
          <div data-testid="mkt-card__head">
            <Skeleton shape="figure" />
          </div>
          <Skeleton shape="rows" count={3} />
        </Surface>
      ))}
    </CardRow>
  );
}
