import { DataTable } from '../../../shared/ui';
import { displayAmount, formatAmount, parseAmount } from '../../../shared/money';
import type { AsOf, VenueBalance, VenueMarket } from '../../../features/trade/venue-api';
import { TestMark } from '../../../features/trade/venue/VenueKit';
import { venueRiskCopy } from './venue-risk-copy';
import { buyingPower, percentOf } from './venue-risk-logic';

/** The venue's published margin tiers for the contract, or its "not published" (J-derivatives-02 #2). Never a tier of ours. */
export function VenueTiers({ market, venueName, test }: { market: VenueMarket; venueName: string; test: boolean }) {
  const { t } = venueRiskCopy.useCopy();
  const tiers = market.marginTiers?.known ? market.marginTiers.value : null;
  return (
    <section className="dk-panel" aria-label={t('Tiers title', { venue: venueName })} data-testid="venue-tiers">
      <h2 className="dk-tab-title">
        {t('Tiers title', { venue: venueName })} <TestMark test={test} />
      </h2>
      {tiers && tiers.length > 0 ? (
        <>
          <DataTable
            label={t('Tiers table', { symbol: market.symbol })}
            headers={[t('Tier'), t('From notional'), t('Most leverage'), t('Maintenance rate')]}
          >
            {tiers.map((tier, i) => (
              <tr key={tier.fromNotional} data-tier={i + 1}>
                <td>{i + 1}</td>
                <td className="numeric" data-cell="from">
                  {displayAmount(tier.fromNotional)} {market.quoteAsset}
                </td>
                <td className="numeric" data-cell="leverage">
                  {tier.maxLeverageBps / 10_000}x
                </td>
                <td className="numeric" data-cell="maintenance">
                  {percentOf(tier.maintenanceRate)}%
                </td>
              </tr>
            ))}
          </DataTable>
          <p className="muted">{t('Tiers note', { venue: venueName })}</p>
        </>
      ) : (
        <p data-testid="venue-tiers-unpublished">{t('Tiers not published', { venue: venueName })}</p>
      )}
    </section>
  );
}

/**
 * What the venue takes as margin on the contract, each with its haircut where it publishes one, the person's free balance
 * of it as the venue reports it, and the buying power that leaves; every other balance listed as not taken (J-derivatives-02 #3).
 */
export function VenueCollateral({
  market,
  venueName,
  balances,
  test,
}: {
  market: VenueMarket;
  venueName: string;
  balances: AsOf<VenueBalance[]> | null;
  test: boolean;
}) {
  const { t } = venueRiskCopy.useCopy();
  const taken = market.collateral?.known ? market.collateral.value : null;
  const held = balances?.value ?? [];
  const freeOf = (asset: string) => held.find((b) => b.asset === asset)?.free ?? '0';
  const power = taken ? buyingPower(taken, freeOf) : null;
  const others = taken ? held.filter((b) => !taken.some((c) => c.asset === b.asset) && parseAmount(b.total) > 0n) : [];
  return (
    <section className="dk-panel" aria-label={t('Collateral title', { venue: venueName })} data-testid="venue-collateral">
      <h2 className="dk-tab-title">
        {t('Collateral title', { venue: venueName })} <TestMark test={test} />
      </h2>
      {taken ? (
        <>
          <DataTable
            label={t('Collateral table', { venue: venueName, symbol: market.symbol })}
            headers={[t('Asset'), t('Haircut'), t('Free on venue'), t('Counts toward buying power')]}
          >
            {taken.map((c) => {
              const free = freeOf(c.asset);
              return (
                <tr key={c.asset} data-asset={c.asset}>
                  <td>{c.asset}</td>
                  <td className="numeric" data-cell="haircut">
                    {c.haircut.known ? `${percentOf(c.haircut.value)}%` : t('Haircut not published', { venue: venueName })}
                  </td>
                  <td className="numeric" data-cell="free">
                    {displayAmount(free)}
                  </td>
                  <td className="numeric" data-cell="counts">
                    {c.haircut.known
                      ? displayAmount(
                          formatAmount((parseAmount(free) * (parseAmount('1') - parseAmount(c.haircut.value))) / parseAmount('1')),
                        )
                      : t('Haircut not published', { venue: venueName })}
                  </td>
                </tr>
              );
            })}
          </DataTable>
          <p data-testid="venue-buying-power">
            {t('Buying power', { symbol: market.symbol })}:{' '}
            <span className="numeric" data-testid="venue-buying-power-value" data-value={power?.known ? power.value : undefined}>
              {power?.known
                ? t('Buying power value', { amount: displayAmount(power.value), asset: market.quoteAsset })
                : t('Buying power unknown', { venue: venueName, asset: power?.asset ?? '' })}
            </span>
          </p>
          <p className="muted">{t('Buying power note', { venue: venueName })}</p>
          {others.length > 0 ? (
            <>
              <h3>{t('Not taken title', { venue: venueName })}</h3>
              <ul aria-label={t('Not taken title', { venue: venueName })} data-testid="venue-not-taken">
                {others.map((b) => (
                  <li key={b.asset} data-asset={b.asset}>
                    {t('Not taken row', { asset: b.asset, venue: venueName, symbol: market.symbol })}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : (
        <p data-testid="venue-collateral-unpublished">{t('Collateral not published', { venue: venueName, symbol: market.symbol })}</p>
      )}
    </section>
  );
}
