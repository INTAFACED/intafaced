import { AssetIcon } from '@intafaced/ui/lit';
import { assetName, homeCopy } from './copy';
import { coinHref, dec, decOrNull, fmtAmount, fmtPct, fmtUsd, ratio, sub, type HomeHolding } from './deps';
import { Amount, Ghost, Money, Pct } from './volt-parts';

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
      <section data-testid="home-yours" className="lt-stack" aria-labelledby="home-yours-title">
        <div data-testid="home-watch__head" className="lt-title-row">
          <h2 id="home-yours-title">{t('Your crypto')}</h2>
        </div>
        <p className="lt-hint">{t('No coins yet')}</p>
      </section>
    );
  if (crypto.length === 0) return null;
  return (
    <section data-testid="home-yours" className="lt-stack" aria-labelledby="home-yours-title">
      <div data-testid="home-watch__head" className="lt-title-row">
        <h2 id="home-yours-title">{t('Your crypto')}</h2>
      </div>
      <ul className="lt-rows">
        {crypto.slice(0, SHOWN).map((holding) => {
          const name = assetName(holding.asset, copy);
          const pct = changeRatio(holding);
          return (
            <li key={holding.asset}>
              <a data-testid="home-watch__row" className="lt-row-link" href={coinHref(holding.asset, 'simple')}>
                <AssetIcon asset={holding.asset} />
                <span className="lt-lines">
                  <span data-testid="home-watch__ticker">{name ? `${holding.asset} · ${name}` : holding.asset}</span>
                  <Amount value={`${fmtAmount(holding.total, { round: 'down' })} ${holding.asset}`} hidden={hidden} />
                </span>
                <span className="lt-lines">
                  <Money value={holding.usdValue === null ? null : fmtUsd(holding.usdValue)} hidden={hidden} />
                  <Pct value={pct === null ? null : fmtPct(pct)} />
                </span>
              </a>
            </li>
          );
        })}
      </ul>
      {crypto.length > SHOWN ? (
        <a className="lt-link" href="/money">
          {t('See all')}
        </a>
      ) : null}
    </section>
  );
}

export function YourCryptoSkeleton() {
  return (
    <section data-testid="home-yours" className="lt-stack" aria-hidden="true">
      <div data-testid="home-watch__head">
        <Ghost shape="text" count={1} />
      </div>
      <div data-testid="home-watch__row">
        <Ghost shape="rows" count={3} />
      </div>
    </section>
  );
}
