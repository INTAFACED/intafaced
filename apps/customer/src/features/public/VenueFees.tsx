import { useMemo } from 'react';
import { useDataEnv, useSource } from '../../data/hooks';
import type { Loadable } from '../../data/types';
import { useResource } from '../../shared/resource';
import {
  bpsToPercent,
  rateShown,
  useOwner,
  useVenueApi,
  useVenueMode,
  venueApi,
  type VenueFeeRates,
  type VenueFeeTier,
  type VenueFeeTiers,
  type VenuePublicFees,
} from '../trade';
import { venueFeesCopy } from './venue-fees-copy';
import { FeesTestMark as TestMark, FeesVenueFrame as VenueFrame, FeesWalletBar as WalletBar } from './venue-fees-kit';

type T = ReturnType<typeof venueFeesCopy.useCopy>['t'];
type Rate = VenueFeeRates['makerFeeBps'];

/** A published rate: "not set" when the venue publishes none, "Zero fee", the venue's rebate, or the percent. */
function RateCell({ rate, t }: { rate: Rate; t: T }) {
  if (!rate.known) return <>{t('notSet')}</>;
  const shown = rateShown(rate.value);
  if (shown.kind === 'zero') return <span data-rate="zero">{t('zeroFee')}</span>;
  if (shown.kind === 'rebate') return <span data-rate="rebate">{t('venueRebate', { pct: shown.value })}</span>;
  return <span data-rate="fee">{t('pct', { pct: shown.value })}</span>;
}

/** The venue's published tiers: each from its volume, with its spot and perpetual maker and taker rates. */
export function TiersTable({ schedule, current, t }: { schedule: VenueFeeTiers; current?: string | null; t: T }) {
  if (!schedule.tiers) return <p data-fees="venue-tiers-blank">{t('tiersNotSet')}</p>;
  return (
    <table className="lt-table" data-fees="venue-tiers">
      <caption>{t('tiersCaption', { days: String(schedule.volumeDays), asset: schedule.volumeAsset })}</caption>
      <thead>
        <tr>
          <th scope="col">{t('colTier')}</th>
          <th scope="col">{t('colFrom', { asset: schedule.volumeAsset })}</th>
          <th scope="col">{t('colSpotMaker')}</th>
          <th scope="col">{t('colSpotTaker')}</th>
          <th scope="col">{t('colPerpMaker')}</th>
          <th scope="col">{t('colPerpTaker')}</th>
        </tr>
      </thead>
      <tbody>
        {schedule.tiers.map((tier) => (
          <tr key={tier.name} data-tier={tier.name} aria-current={current === tier.name ? 'true' : undefined}>
            <th scope="row">
              {tier.name}
              {current === tier.name ? ` (${t('yours')})` : ''}
            </th>
            <td data-align="end" data-cell="from">
              {tier.fromVolume}
            </td>
            <td data-cell="spot-maker">
              <RateCell rate={tier.spot.makerFeeBps} t={t} />
            </td>
            <td data-cell="spot-taker">
              <RateCell rate={tier.spot.takerFeeBps} t={t} />
            </td>
            <td data-cell="perp-maker">
              <RateCell rate={tier.perpetual.makerFeeBps} t={t} />
            </td>
            <td data-cell="perp-taker">
              <RateCell rate={tier.perpetual.takerFeeBps} t={t} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * /fees, the venue part (J-cex-spot-10 #2): every trade is placed on the venue, which charges its own maker and taker fee;
 * our builder fee is added on top and named apart, never above the venue's own cap on it. Every figure is read from the
 * venue now; a blank one reads "not set".
 */
export function VenueFeesView({ load }: { load: Loadable<VenuePublicFees> }) {
  const { t } = venueFeesCopy.useCopy();
  return (
    <section aria-labelledby="fees-venue" data-fees="venue">
      <h2 id="fees-venue">
        {t('venueTitle')} {load.status === 'ready' ? <TestMark test={load.data.value.test} /> : null}
      </h2>
      <p>{t('venueLead')}</p>
      {load.status === 'loading' ? <p role="status">{t('loading')}</p> : null}
      {load.status === 'error' || load.status === 'refused' || load.status === 'empty' ? (
        <p role="alert" data-fees="venue-unread">
          {t('unread')}
        </p>
      ) : null}
      {load.status === 'ready' ? <VenueFeesBody fees={load.data.value} t={t} /> : null}
    </section>
  );
}

function VenueFeesBody({ fees, t }: { fees: VenuePublicFees['value']; t: T }) {
  const caps = (kind: 'spot' | 'perpetual') => [
    ...new Set(
      fees.markets
        .filter((m) => m.kind === kind && m.builderFeeCapBps.known)
        .map((m) => bpsToPercent((m.builderFeeCapBps as { value: string }).value)),
    ),
  ];
  const spotCaps = caps('spot');
  const perpCaps = caps('perpetual');
  return (
    <>
      <p data-testid="fees-venue-name">{t('venueName', { name: fees.venue.displayName })}</p>
      <h3>{t('tiersTitle')}</h3>
      <TiersTable schedule={fees.schedule} t={t} />
      <h3>{t('marketsTitle')}</h3>
      <p data-fees="builder-cap">
        {t('capLine', {
          spot: spotCaps.length ? spotCaps.map((c) => `${c}%`).join(', ') : t('notSet'),
          perp: perpCaps.length ? perpCaps.map((c) => `${c}%`).join(', ') : t('notSet'),
        })}
      </p>
      <table className="lt-table" data-fees="venue-markets">
        <thead>
          <tr>
            <th scope="col">{t('colMarket')}</th>
            <th scope="col">{t('colVenueMaker')}</th>
            <th scope="col">{t('colVenueTaker')}</th>
            <th scope="col">{t('colBuilder')}</th>
            <th scope="col">{t('colCap')}</th>
          </tr>
        </thead>
        <tbody>
          {fees.markets.map((m) => (
            <tr key={m.symbol} data-market={m.symbol}>
              <th scope="row">{m.symbol}</th>
              <td data-cell="venue-maker">
                <RateCell rate={m.makerFeeBps} t={t} />
              </td>
              <td data-cell="venue-taker">
                <RateCell rate={m.takerFeeBps} t={t} />
              </td>
              <td data-cell="builder-fee">
                {m.builderFeeBps.known ? (
                  <>
                    {t('pct', { pct: bpsToPercent(m.builderFeeBps.value) })}
                    {m.kind === 'spot' ? ` ${t('onSell')}` : ''}
                  </>
                ) : (
                  t('notSet')
                )}
              </td>
              <td data-cell="builder-cap">
                {m.builderFeeCapBps.known ? t('pct', { pct: bpsToPercent(m.builderFeeCapBps.value) }) : t('notSet')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function VenueFees() {
  const env = useDataEnv();
  const source = useMemo(
    () => env.poller.source<VenuePublicFees>('venue-public-fees', (signal) => venueApi(env.api).publicFees(signal), { intervalMs: 60_000 }),
    [env],
  );
  return <VenueFeesView load={useSource(source)} />;
}

/**
 * My tier, the venue part (J-cex-spot-10 #6): the tier the venue last placed the person's venue account in, the volume
 * it counted and the rates it charges, read from the venue for the connected wallet, with the published tiers and the
 * next threshold. The venue moves the tier only at its own next update; until then the page shows what it last reported.
 */
export function VenueTier() {
  const mode = useVenueMode();
  if (mode.mode !== 'on') return null;
  return (
    <VenueFrame mode={mode}>
      <VenueTierBody />
    </VenueFrame>
  );
}

function VenueTierBody() {
  const { t } = venueFeesCopy.useCopy();
  const owner = useOwner();
  return (
    <section aria-labelledby="tier-venue" data-tier-page="venue">
      <h2 id="tier-venue">{t('tierTitle')}</h2>
      <p>{t('tierLead')}</p>
      <WalletBar />
      {owner ? <OwnerTier owner={owner} /> : null}
    </section>
  );
}

function OwnerTier({ owner }: { owner: string }) {
  const api = useVenueApi();
  const { resource } = useResource((signal) => api.feeTier(owner, signal), `venue-fee-tier:${owner}`);
  const { resource: fees } = useResource((signal) => api.publicFees(signal), 'venue-public-fees:tier');
  const { t } = venueFeesCopy.useCopy();
  if (resource.status === 'loading') return <p role="status">{t('loading')}</p>;
  if (resource.status !== 'ready') return <p role="alert">{t('unread')}</p>;
  return <VenueTierView tier={resource.data} builder={fees.status === 'ready' ? fees.data.value.markets : null} />;
}

type Discount = NonNullable<NonNullable<VenueFeeTier['value']['account']>['stakingDiscount']>;
type BuilderRows = VenuePublicFees['value']['markets'] | null;

/**
 * The venue's staking discount on its own fee (J-cex-spot-21 #4): the stake it counts, its tier and discount, and each
 * market's venue rates before and after it, as the venue reports them; our builder fee beside them, unchanged.
 */
function StakingDiscountView({ discount, builder, t }: { discount: Discount; builder: BuilderRows; t: T }) {
  const pct = bpsToPercent(String(discount.discountBps));
  return (
    <section data-testid="tier-staking" aria-labelledby="tier-staking-title">
      <h3 id="tier-staking-title">{t('stakingTitle')}</h3>
      <p
        data-testid="tier-staking-line"
        data-tier={discount.tierName ?? ''}
        data-discount={discount.discountBps}
        data-counted={discount.countedStake}
      >
        {discount.tierName
          ? t('stakingLine', { amount: discount.countedStake, asset: discount.asset, tier: discount.tierName, pct })
          : t('stakingNone', { amount: discount.countedStake, asset: discount.asset })}
      </p>
      <p className="lt-hint" data-testid="tier-staking-builder">
        {t('stakingBuilderNote')}
      </p>
      <table className="lt-table" data-fees="staking-markets">
        <thead>
          <tr>
            <th scope="col">{t('colMarket')}</th>
            <th scope="col">{t('colVenueMakerBefore')}</th>
            <th scope="col">{t('colVenueMakerAfter')}</th>
            <th scope="col">{t('colVenueTakerBefore')}</th>
            <th scope="col">{t('colVenueTakerAfter')}</th>
            <th scope="col">{t('colBuilder')}</th>
          </tr>
        </thead>
        <tbody>
          {discount.markets.map((m) => {
            const ours = builder?.find((b) => b.symbol === m.symbol)?.builderFeeBps ?? null;
            const bps = (r: Rate) => (r.known ? r.value : '');
            return (
              <tr key={m.symbol} data-market={m.symbol}>
                <th scope="row">{m.symbol}</th>
                <td data-cell="maker-before" data-value={bps(m.before.makerFeeBps)}>
                  <RateCell rate={m.before.makerFeeBps} t={t} />
                </td>
                <td data-cell="maker-after" data-value={bps(m.after.makerFeeBps)}>
                  <RateCell rate={m.after.makerFeeBps} t={t} />
                </td>
                <td data-cell="taker-before" data-value={bps(m.before.takerFeeBps)}>
                  <RateCell rate={m.before.takerFeeBps} t={t} />
                </td>
                <td data-cell="taker-after" data-value={bps(m.after.takerFeeBps)}>
                  <RateCell rate={m.after.takerFeeBps} t={t} />
                </td>
                <td data-cell="builder-fee" data-value={ours?.known ? ours.value : ''}>
                  {ours === null ? t('loading') : ours.known ? t('pct', { pct: bpsToPercent(ours.value) }) : t('notSet')}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p>
        <a className="lt-link lt-link-alone" href="/trade/staking">
          {t('stakingMore')}
        </a>
      </p>
    </section>
  );
}

export function VenueTierView({ tier, builder = null }: { tier: VenueFeeTier; builder?: BuilderRows }) {
  const { t } = venueFeesCopy.useCopy();
  const a = tier.value.account;
  const tiers = tier.value.schedule.tiers;
  const at = tiers && a?.tierName ? tiers.findIndex((x) => x.name === a.tierName) : -1;
  const next = tiers && at >= 0 ? (tiers[at + 1] ?? null) : null;
  return (
    <div data-testid="venue-tier">
      <TestMark test={tier.test} />
      <dl className="lt-kv">
        <div>
          <dt>{t('yourTier')}</dt>
          <dd data-cell="tier">{a?.tierName ?? t('notReported')}</dd>
        </div>
        <div>
          <dt>{t('volumeCounted', { days: String(tier.value.schedule.volumeDays) })}</dt>
          <dd className="lt-mono" data-cell="volume">
            {a?.volume.known ? `${a.volume.value} ${tier.value.schedule.volumeAsset}` : t('notReported')}
          </dd>
        </div>
        <div>
          <dt>{t('updatedAt')}</dt>
          <dd data-cell="updated">{a?.tierUpdatedAt ? <time dateTime={a.tierUpdatedAt}>{a.tierUpdatedAt}</time> : t('notReported')}</dd>
        </div>
        <div>
          <dt>{t('yourSpotRates')}</dt>
          <dd data-cell="spot-rates">
            <RatesLine rates={a?.spot ?? null} t={t} />
          </dd>
        </div>
        <div>
          <dt>{t('nextThreshold')}</dt>
          <dd data-cell="next">
            {next
              ? t('nextLine', { name: next.name, from: next.fromVolume, asset: tier.value.schedule.volumeAsset })
              : at >= 0
                ? t('topTier')
                : t('notReported')}
          </dd>
        </div>
      </dl>
      <p>
        <small>{t('updateRule')}</small>
      </p>
      <TiersTable schedule={tier.value.schedule} current={a?.tierName ?? null} t={t} />
      {a?.stakingDiscount ? <StakingDiscountView discount={a.stakingDiscount} builder={builder} t={t} /> : null}
    </div>
  );
}

function RatesLine({ rates, t }: { rates: VenueFeeRates | null; t: T }) {
  if (!rates || (!rates.makerFeeBps.known && !rates.takerFeeBps.known)) return <>{t('eachMarket')}</>;
  return (
    <>
      {t('maker')} <RateCell rate={rates.makerFeeBps} t={t} />, {t('taker')} <RateCell rate={rates.takerFeeBps} t={t} />
    </>
  );
}
