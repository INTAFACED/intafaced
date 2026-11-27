import { Checkbox } from '@intafaced/ui/lit/templates';
import { venueRiskCopy } from './venue-risk-copy';
import { percentOf, type ProjectedVenueTier } from './venue-risk-logic';

/**
 * The confirm step when adding size crosses a venue margin tier threshold (J-derivatives-02 #6): names the new tier,
 * its maintenance margin rate and its leverage cap beside the account's leverage, and requires an explicit tick before
 * Confirm can sign and send.
 */
export function VenueTierConfirm({
  symbol,
  tier,
  leverageTimes,
  accepted,
  onAccept,
}: {
  symbol: string;
  tier: ProjectedVenueTier;
  leverageTimes: number;
  accepted: boolean;
  onAccept: (checked: boolean) => void;
}) {
  const { t } = venueRiskCopy.useCopy();
  const rate = percentOf(tier.maintenanceRate);
  const maxLeverage = String(tier.maxLeverageBps / 10_000);
  return (
    <section aria-label={t('Tier confirm title')} data-testid="venue-tier-confirm" className="lt-callout lt-stack-tight">
      <h3 className="lt-strong">{t('Tier confirm heading', { tier: String(tier.projected) })}</h3>
      <p>
        {tier.current === null
          ? t('Tier confirm opens', { tier: String(tier.projected) })
          : t('Tier confirm moves', { from: String(tier.current), tier: String(tier.projected) })}
      </p>
      <p>{t('Tier confirm rate', { tier: String(tier.projected), rate, symbol })}</p>
      <p>
        {t('Tier confirm leverage', {
          leverage: String(leverageTimes),
          tier: String(tier.projected),
          maxLeverage,
          symbol,
        })}
      </p>
      <Checkbox
        label={t('Tier confirm accept', { tier: String(tier.projected) })}
        checked={accepted}
        onChange={(event) => onAccept(event.currentTarget.checked)}
      />
    </section>
  );
}
