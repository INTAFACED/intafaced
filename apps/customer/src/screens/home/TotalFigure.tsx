import { homeCopy } from './copy';
import type { UiDisplayCurrency } from '@intafaced/contracts/ui-view-preferences';
import { HeroNumber, dec, roundScaled, toFixedString, refusalCopy, useDisplayRate, type HomePortfolio } from './deps';

/** A decimal rounded half-up to `places`, as the string HeroNumber animates. Unknown stays null. */
function rounded(value: string | null, places: number): string | null {
  const parsed = dec(value);
  return parsed === null ? null : toFixedString(roundScaled(parsed, places), places);
}

/** The dollar total for a sentence: a dash, never "$null", when it is unknown or unreadable. */
function dollars(value: string | null): string {
  const cents = rounded(value, 2);
  return cents === null ? '—' : `$${cents}`;
}

/**
 * Home's total in the display unit the person chose (USD or BTC; any other currency has no rate and stays in USD). The BTC figure is the bank's own (`btc.total`), never
 * the dollar total divided here; with no BTC price the dollar total stays and a note says why. Same rule as Money's headline.
 */
export function totalUnit(data: HomePortfolio, displayCurrency: UiDisplayCurrency) {
  const inBtc = displayCurrency === 'BTC' && data.btc != null && data.btc.total !== null;
  // No BTC total for any reason (no BTC price, or the bank did not answer and the total was built on this device): dollars, said so.
  const btcMissing = displayCurrency === 'BTC' && !inBtc;
  return { inBtc, btcMissing };
}

export function TotalFigure({
  data,
  displayCurrency,
  hidden,
  pro,
}: {
  data: HomePortfolio;
  displayCurrency: UiDisplayCurrency;
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

/** The line under the total when it is shown in BTC, when BTC was chosen and has no price, or when the bank has no rate for the
 * chosen currency (it refuses by name and the total stays in USD). */
export function TotalUnitNote({
  data,
  displayCurrency,
  hidden,
  className,
  testId,
}: {
  data: HomePortfolio;
  displayCurrency: UiDisplayCurrency;
  hidden: boolean;
  className: string;
  testId?: string;
}) {
  const { t } = homeCopy.useCopy();
  const { inBtc, btcMissing } = totalUnit(data, displayCurrency);
  // Only a currency other than USD or BTC asks the bank for a rate.
  if (displayCurrency !== 'USD' && displayCurrency !== 'BTC')
    return <RateNote currency={displayCurrency} className={className} testId={testId} />;
  if (inBtc)
    return (
      <p className={className} data-testid={testId} data-total-unit="BTC">
        {/* The dollar figure is a balance too: it stays out of the note while balances are hidden. */}
        {hidden ? t('Shown in BTC hidden') : t('Shown in BTC', { usd: dollars(data.totalUsd) })}
      </p>
    );
  if (btcMissing)
    return (
      <p className={className} data-testid={testId} data-total-unit="USD">
        {t('BTC price missing')}
      </p>
    );
  return null;
}

/** The total stays in USD for a currency the bank was asked about: no rate (refused by name), or it could not be asked. */
function RateNote({ currency, className, testId }: { currency: UiDisplayCurrency; className: string; testId?: string }) {
  const { t } = homeCopy.useCopy();
  const rate = useDisplayRate(currency);
  if (rate.state === 'no_rate') {
    const reference = refusalCopy(rate.code).reference;
    return (
      <p className={className} data-testid={testId} data-total-unit="USD" data-refusal={rate.code}>
        {t('No rate for display currency', { currency })}
        {reference ? ` ${reference}` : null}
      </p>
    );
  }
  if (rate.state === 'unchecked')
    return (
      <p className={className} data-testid={testId} data-total-unit="USD">
        {t('Display currency not checked', { currency })}
      </p>
    );
  return null;
}
