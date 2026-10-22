import { homeCopy } from './copy';
import { HeroNumber, dec, roundScaled, toFixedString, type HomePortfolio } from './deps';

/** A decimal rounded half-up to `places`, as the string HeroNumber animates. Unknown stays null. */
function rounded(value: string | null, places: number): string | null {
  const parsed = dec(value);
  return parsed === null ? null : toFixedString(roundScaled(parsed, places), places);
}

/**
 * Home's total in the display unit the person chose (USD or BTC). The BTC figure is the bank's own (`btc.total`), never
 * the dollar total divided here; with no BTC price the dollar total stays and a note says why. Same rule as Money's headline.
 */
export function totalUnit(data: HomePortfolio, displayCurrency: 'USD' | 'BTC') {
  const inBtc = displayCurrency === 'BTC' && data.btc != null && data.btc.total !== null;
  const btcMissing = displayCurrency === 'BTC' && data.source === 'server' && !inBtc;
  return { inBtc, btcMissing };
}

export function TotalFigure({
  data,
  displayCurrency,
  hidden,
  pro,
}: {
  data: HomePortfolio;
  displayCurrency: 'USD' | 'BTC';
  hidden: boolean;
  pro: boolean;
}) {
  const { inBtc } = totalUnit(data, displayCurrency);
  const size = pro ? 'hero-pro' : undefined;
  return inBtc ? (
    <HeroNumber value={rounded(data.btc!.total, 8)} decimals={8} prefix="₿" unit={pro ? 'BTC' : undefined} size={size} hidden={hidden} />
  ) : (
    <HeroNumber value={rounded(data.totalUsd, 2)} decimals={2} prefix="$" unit={pro ? 'USD' : undefined} size={size} hidden={hidden} />
  );
}

/** The line under the total when it is shown in BTC, or when BTC was chosen and has no price. */
export function TotalUnitNote({
  data,
  displayCurrency,
  hidden,
  className,
}: {
  data: HomePortfolio;
  displayCurrency: 'USD' | 'BTC';
  hidden: boolean;
  className: string;
}) {
  const { t } = homeCopy.useCopy();
  const { inBtc, btcMissing } = totalUnit(data, displayCurrency);
  if (inBtc)
    return (
      <p className={className} data-total-unit="BTC">
        {/* The dollar figure is a balance too: it stays out of the note while balances are hidden. */}
        {hidden ? t('Shown in BTC hidden') : t('Shown in BTC', { usd: data.totalUsd ? `$${rounded(data.totalUsd, 2)}` : '—' })}
      </p>
    );
  if (btcMissing)
    return (
      <p className={className} data-total-unit="USD">
        {t('BTC price missing')}
      </p>
    );
  return null;
}
