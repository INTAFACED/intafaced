import { assetName, homeCopy } from './copy';
import { IN_PANEL } from './panel';
import {
  Amount,
  coinHref,
  CoinIcon,
  dec,
  decOrNull,
  fmtAmount,
  fmtPct,
  fmtUsd,
  Money,
  Pct,
  ratio,
  Skeleton,
  sub,
  type HomeHolding,
} from './deps';

/** How many holdings the side card lists before it offers "See all". */
const SHOWN = 6;

/** Today's change of one holding as a ratio of what it was worth a day ago; unknown when either figure is. */
function changeRatio(holding: HomeHolding): string | null {
  const value = dec(holding.usdValue);
  const change = dec(holding.usdChange24h);
  if (value === null || change === null) return null;
  const before = sub(value, change);
  return before > 0n ? decOrNull(ratio(change, before)) : null;
}

/**
 * "Your crypto" (taste call T2-A, provisional): each coin the person holds with its icon, amount, value and
 * today's change, from the data layer's holdings. Sits above Popular in the right column.
 */
export function YourCrypto({ holdings, hidden }: { holdings: HomeHolding[]; hidden: boolean }) {
  const copy = homeCopy.useCopy();
  const { t } = copy;
  const crypto = holdings.filter((holding) => holding.class === 'crypto');
  // An account with nothing at all says so in one line; one that holds only cash has no crypto card to show.
  if (holdings.length === 0)
    return (
      <section data-testid="home-yours" className="home-watch home-yours" aria-labelledby="home-yours-title">
        <div data-testid="home-watch__head" className="home-watch__head">
          <h2 id="home-yours-title">{t('Your crypto')}</h2>
        </div>
        <p className="home-side__empty">{t('No coins yet')}</p>
      </section>
    );
  if (crypto.length === 0) return null;
  return (
    <section data-testid="home-yours" className="home-watch home-yours" aria-labelledby="home-yours-title">
      <div data-testid="home-watch__head" className="home-watch__head">
        <h2 id="home-yours-title">{t('Your crypto')}</h2>
      </div>
      <ul className="home-watch__list">
        {crypto.slice(0, SHOWN).map((holding) => {
          const name = assetName(holding.asset, copy);
          const pct = changeRatio(holding);
          return (
            <li key={holding.asset} className="home-watch__item">
              <a data-testid="home-watch__row" className="home-watch__row" href={coinHref(holding.asset, 'simple')}>
                <CoinIcon asset={holding.asset} size={28} />
                <span className="home-watch__name">
                  <span data-testid="home-watch__ticker" className="home-watch__ticker">
                    {name ? `${holding.asset} · ${name}` : holding.asset}
                  </span>
                  <Amount
                    className="home-yours__amount"
                    value={`${fmtAmount(holding.total, { round: 'down' })} ${holding.asset}`}
                    hidden={hidden}
                  />
                </span>
                <span className="home-watch__figures">
                  <Money
                    className="home-watch__price"
                    value={holding.usdValue === null ? null : fmtUsd(holding.usdValue)}
                    hidden={hidden}
                  />
                  <Pct value={pct === null ? null : fmtPct(pct)} className="home-watch__pct" />
                </span>
              </a>
            </li>
          );
        })}
      </ul>
      {crypto.length > SHOWN ? (
        <a className="home-yours__more" href="/money">
          {t('See all')}
        </a>
      ) : null}
    </section>
  );
}

export function YourCryptoSkeleton() {
  return (
    <section data-testid="home-yours" className="home-watch home-yours" aria-hidden="true">
      <div data-testid="home-watch__head" className="home-watch__head">
        <Skeleton width={96} height={20} className={IN_PANEL} />
      </div>
      {[0, 1, 2].map((index) => (
        <div data-testid="home-watch__row" className="home-watch__row home-yours__skeleton" key={index}>
          <Skeleton width={28} height={28} circle className={IN_PANEL} />
          <Skeleton width={96} height={36} className={IN_PANEL} />
          <Skeleton width={72} height={36} className={IN_PANEL} />
        </div>
      ))}
    </section>
  );
}
