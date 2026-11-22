import { useState, type ReactNode } from 'react';
import type { ApiResult } from '../../../../shared/api';
import { useResource } from '../../../../shared/resource';
import { Button, Checkbox, Field } from '@intafaced/ui/lit';
import { useMerchantAccess } from '../access/MerchantAccess';
import { mc as portalCopy } from './copy';
import { buildCsv, downloadText } from '../csv';
import { useReadAt } from '../hooks';
import { isNotLive } from '../refusal';
import { DateTime } from '../ui/DateTime';
import { formatMoney } from '../ui/format';
import { feeStory, hasAccountFee, percentOfBps } from '../ui/fee-story';
import { Facts, Failure, Freshness, Gate, Grid, KpiStrip, Loading, MoneyText, NotConfigured, Section, SelectField } from '../volt/parts';
import { SettingsRoom } from '../volt/SettingsRoom';
import { NamedBlocker, TestBanner } from './kit-parts';
import { bpsPercent, isCalcAmount, pricingAssets } from './model';
import { rateText, useEffectiveFeeRates } from './fee-rate-read';
import type { EffectiveRate } from './fee-rate-schema';
import type { Resource } from '../../../../shared/resource';
import type { PortalApi } from '../api';
import type { ControlProfile, PricingRule, Quote } from '../schemas';
import type {
  MerchantPricingHistory as History,
  MerchantTierFee as TierFee,
  MerchantTierList as TierList,
  MerchantTierSummary as TierSummary,
} from '@intafaced/contracts/merchant-control';

/** `/pay/pricing`: what INTAFACED charges this account, read-only, with a calculator that uses the same engine as live payments. */
export function Pricing({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const { t } = portalCopy.useCopy();
  const { access, merchant: merchantRead, reloadMerchant } = useMerchantAccess();
  const account = merchantRead.status === 'ready' ? merchantRead.data : null;
  const control = useResource((s) => portal.control(merchantId, s), `money:control:${merchantId}`);
  const tiers = useResource((s) => portal.tiersList(merchantId, s), `money:tiers:${merchantId}`);
  const history = useResource((s) => portal.pricingHistory(merchantId, s), `money:pricing-history:${merchantId}`);
  const rates = useEffectiveFeeRates(portal, merchantId);
  const readAt = useReadAt(control.resource.status === 'ready', control.resource);
  // Viewers and developers see the fee that was charged and nothing about the spread or which rule produced it.
  const feeOnly = access.status === 'ready' && access.pricingVisibility === 'fee_only';
  const tierData = tiers.resource.status === 'ready' ? tiers.resource.data : null;
  const ownTier = tierData?.status === 'configured' ? (tierData.tiers.find((x) => x.id === tierData.ownTierId) ?? null) : null;
  const tierName = ownTier?.name ?? null;
  return (
    <>
      <TestBanner />
      <Gate resource={control.resource} retry={control.reload} rows={4}>
        {(profile) => {
          const rules = profile.pricing ?? [];
          const assets = pricingAssets(profile.pricing);
          // The calculator also offers the assets the merchant's own tier names (its fees and its caps), so a tier with no
          // fee for an asset asks the engine and shows the engine's refusal instead of a quiet blank.
          const calcAssets = calculatorAssets(assets, ownTier);
          return (
            <>
              {/* The account's own rate comes from a separate read. If it fails the page says so and can ask again; it never stays on "…". */}
              {merchantRead.status === 'failed' && <Failure result={merchantRead.failure} retry={reloadMerchant} />}
              <Freshness asOf={readAt} />
              <KpiStrip
                label={t('priceTiles')}
                tiles={[
                  {
                    label: t('colTier'),
                    period: t('mnPeriodNow'),
                    href: '/pay/limits',
                    value: tierName ?? <NotConfigured>{t('tierNotAssigned')}</NotConfigured>,
                  },
                  {
                    label: t('priceRate'),
                    period: t('mnPeriodNow'),
                    href: '/pay/pricing',
                    // The rate is the account's own. With none set the tile says so; a price list never stands in for it.
                    value: account ? (
                      hasAccountFee(account) ? (
                        percentOfBps(account.feeBps!)
                      ) : (
                        <NotConfigured />
                      )
                    ) : (
                      <span>{merchantRead.status === 'loading' ? '…' : '—'}</span>
                    ),
                  },
                  { label: t('priceAssets'), period: t('mnPeriodNow'), href: '/pay/pricing', value: String(assets.length) },
                  {
                    label: t('priceSince'),
                    period: t('mnPeriodNow'),
                    href: '/pay/pricing',
                    value: profile.updatedAt ? <DateTime value={profile.updatedAt} /> : <span>{t('notRecorded')}</span>,
                    size: 'text',
                  },
                ]}
              />
              <Section
                id={SECTION.now}
                title={t('pricingNowTitle')}
                description={t('pricingNowBody')}
                action={
                  rules.length > 0 ? (
                    <Button
                      tone="secondary"
                      onClick={() =>
                        downloadText(
                          'pricing-schedule.csv',
                          buildCsv(
                            [
                              'asset',
                              'applies_from',
                              'from_amount',
                              'fee_bps',
                              'flat_fee',
                              ...(feeOnly ? [] : ['conversion_spread_bps']),
                              'rounding_goes_to',
                            ],
                            rules.flatMap((r) =>
                              r.bands.map((b) => [
                                r.assetCode,
                                r.layer,
                                b.fromAmount,
                                b.feeBps,
                                b.flatFee ?? '',
                                ...(feeOnly ? [] : [r.spreadBps ?? '']),
                                r.roundingBeneficiary,
                              ]),
                            ),
                            { generatedAt: new Date().toISOString(), asOf: readAt ?? '' },
                          ),
                        )
                      }
                    >
                      {t('downloadSchedule')}
                    </Button>
                  ) : undefined
                }
              >
                <Facts
                  items={[
                    [t('colTier'), tierName ?? <NotConfigured>{t('tierNotAssigned')}</NotConfigured>],
                    // The fee taken at settlement is the account's own rate: the same sentence as on Overview.
                    [
                      t('priceAccountFee'),
                      account ? (
                        feeStory(account)
                      ) : merchantRead.status !== 'loading' ? (
                        <span>{t('priceFeeUnavailable')}</span>
                      ) : (
                        <span>…</span>
                      ),
                    ],
                    [t('effectiveSince'), profile.updatedAt ? <DateTime value={profile.updatedAt} /> : <span>{t('notRecorded')}</span>],
                    [t('reserveTitle'), <ReserveText reserve={profile.reserve} />],
                  ]}
                />
                {rules.length === 0 &&
                  (account && hasAccountFee(account) ? (
                    <p className="lt-hint" role="note">
                      {t('pricingNoSchedule')}
                    </p>
                  ) : (
                    <p className="lt-hint" role="note">
                      <NotConfigured /> {t('pricingNotConfiguredBody')}
                    </p>
                  ))}
              </Section>

              <Section id={SECTION.tiers} title={t('tierFeesTitle')} description={t('tierFeesBody')}>
                <TierFeeTable tiers={tiers.resource} retry={tiers.reload} feeOnly={feeOnly} />
              </Section>

              {rules.map((rule) => (
                <RuleTable key={`${rule.layer}:${rule.scopeId ?? ''}:${rule.assetCode}`} rule={rule} feeOnly={feeOnly} />
              ))}

              <Section id={SECTION.actual} title={t('priceActualTitle')} description={t('priceActualBody')}>
                <EffectiveRates
                  resource={rates.resource}
                  fallback={<p className="lt-hint">{t('rateUnavailable')}</p>}
                  note={t('rateWindow30')}
                />
              </Section>

              <FeeCalculator portal={portal} merchantId={merchantId} assets={calcAssets} feeOnly={feeOnly} />

              <Section id={SECTION.history} title={t('priceHistoryTitle')} description={t('historyBody')}>
                <HistoryTable history={history.resource} retry={history.reload} />
              </Section>
            </>
          );
        }}
      </Gate>
    </>
  );
}

/**
 * Where the page's index links to. "What you actually paid" stays out of the index: its words are found by the text of
 * the section that holds them (`money.pw.mjs`), and the index is a section too.
 */
const SECTION = {
  now: 'pricing-now',
  tiers: 'pricing-tiers',
  actual: 'pricing-actual',
  calc: 'pricing-calculator',
  history: 'pricing-history',
};

/** `/pay/pricing` on the settings template: the index of its parts, what it means, and the page for the account. */
export function PricingRoom({ portal }: { portal: PortalApi }) {
  const { t } = portalCopy.useCopy();
  return (
    <SettingsRoom
      sections={[
        { id: SECTION.now, label: t('pricingNowTitle') },
        { id: SECTION.tiers, label: t('tierFeesTitle') },
        { id: SECTION.calc, label: t('calcTitle') },
        { id: SECTION.history, label: t('priceHistoryTitle') },
      ]}
      explain={<p>{t('pricingExplain')}</p>}
    >
      {({ merchantId }) => <Pricing portal={portal} merchantId={merchantId} />}
    </SettingsRoom>
  );
}

/** The rates over the last 30 days, one line per asset, or `fallback` while the service does not send them (`EffectiveFeeView` in `./fee-rate`). */
function EffectiveRates({ resource, fallback, note }: { resource: Resource<EffectiveRate[] | null>; fallback: ReactNode; note: string }) {
  const { t } = portalCopy.useCopy();
  if (resource.status === 'loading') return <Loading rows={1} />;
  if (resource.status === 'failed' || resource.data === null) return <>{fallback}</>;
  return (
    <div>
      {resource.data.length === 0 ? (
        <p className="lt-hint">{t('rateNone')}</p>
      ) : (
        <ul aria-label={t('rateListLabel')}>
          {resource.data.map((r) => (
            <li key={r.assetCode}>
              <strong>{rateText(t, r)}</strong> <span lang="zxx">{r.assetCode}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="lt-hint">{note}</p>
    </div>
  );
}

/** The assets the calculator offers: the priced ones, plus every asset the merchant's own tier names. Sorted, no repeats. */
export function calculatorAssets(priced: readonly string[], ownTier: TierSummary | null): string[] {
  const named = [
    ...(ownTier?.fees ?? []).map((fee) => fee.assetCode),
    ...(ownTier?.caps ?? []).flatMap((cap) => ('assetCode' in cap ? [cap.assetCode] : [])),
  ];
  return [...new Set([...priced, ...named])].sort();
}

/**
 * The tier fee table: one row per tier and asset, with the processing fee and the payout fee the tier publishes. A tier
 * with no fee of its own, or no published payout fee, reads "Not set"; only a published `not_charged` reads "Not charged".
 */
export function TierFeeTable({
  tiers,
  retry,
  feeOnly = false,
}: {
  tiers: ReturnType<typeof useResource<TierList>>['resource'];
  retry: () => void;
  feeOnly?: boolean;
}) {
  const { t } = portalCopy.useCopy();
  if (tiers.status === 'loading') return <Loading rows={2} />;
  if (tiers.status === 'failed') return <Failure result={tiers.failure} retry={retry} />;
  if (tiers.data.status === 'not_configured') return <p className="lt-hint">{t('tierFeesNone')}</p>;
  const ownTierId = tiers.data.ownTierId;
  const notSet = <NotConfigured>{t('feeNotSet')}</NotConfigured>;
  return (
    <Grid label={t('tierFeesTitle')} headers={[t('colTier'), t('colAsset'), t('colProcessingFee'), t('colPayoutFee')]}>
      {tiers.data.tiers.flatMap((tier) => {
        const fees: Array<TierFee | null> = tier.fees && tier.fees.length > 0 ? tier.fees : [null];
        const name = tier.id === ownTierId ? t('tierYours', { name: tier.name }) : tier.name;
        const payout = tier.payoutFee?.kind === 'not_charged' ? t('payoutNotCharged') : notSet;
        return fees.map((fee) => (
          <tr key={`${tier.id}:${fee?.assetCode ?? ''}`} data-testid={`tier-fee-${tier.id}-${fee?.assetCode ?? 'none'}`}>
            <th scope="row">{name}</th>
            <td data-label={t('colAsset')}>{fee ? fee.assetCode : <span>—</span>}</td>
            <td data-label={t('colProcessingFee')}>{fee ? <TierFeeText fee={fee} feeOnly={feeOnly} /> : notSet}</td>
            <td data-label={t('colPayoutFee')}>{payout}</td>
          </tr>
        ));
      })}
    </Grid>
  );
}

/**
 * "2.50% from 0.00 USDT · 1.50% + 0.30 USDT from 10,000.00 USDT · minimum 0.50 USDT", and the conversion spread when the
 * tier has one and the role sees it. One band from zero drops its "from".
 */
function TierFeeText({ fee, feeOnly }: { fee: TierFee; feeOnly: boolean }) {
  const { t } = portalCopy.useCopy();
  const money = (value: string) => formatMoney(value, fee.assetCode) + ` ${fee.assetCode}`;
  const one = fee.bands.length === 1 && /^0(\.0+)?$/.test(fee.bands[0]!.fromAmount);
  const parts = fee.bands.map((band) => {
    const rate = band.flatFee ? t('tierFeeFlat', { pct: bpsPercent(band.feeBps), flat: money(band.flatFee) }) : bpsPercent(band.feeBps);
    return one ? rate : t('feeBandFrom', { fee: rate, from: money(band.fromAmount) });
  });
  if (fee.minFee) parts.push(t('feeMin', { amount: money(fee.minFee) }));
  if (fee.maxFee) parts.push(t('feeMax', { amount: money(fee.maxFee) }));
  // A conversion adds the tier's spread; roles that see the fee only are not shown it (as on the price list).
  if (!feeOnly && fee.spreadBps != null) parts.push(t('tierFeeSpread', { pct: bpsPercent(fee.spreadBps) }));
  return <span>{parts.join(' · ')}</span>;
}

function HistoryTable({ history, retry }: { history: ReturnType<typeof useResource<History>>['resource']; retry: () => void }) {
  const { t } = portalCopy.useCopy();
  if (history.status === 'loading') return <Loading rows={2} />;
  if (history.status === 'failed')
    return isNotLive(history.failure) ? (
      <NamedBlocker title={t('priceHistoryTitle')} why="reasonHistory" needs="merchantControl.pricing.history">
        {t('historyBlocked')}
      </NamedBlocker>
    ) : (
      <Failure result={history.failure} retry={retry} />
    );
  if (history.data.status === 'not_configured') return <p className="lt-hint">{t('historyNone')}</p>;
  return (
    <Grid
      label={t('priceHistoryTitle')}
      headers={[t('colAsset'), t('historyApplies'), t('historyRate'), t('historyFrom'), t('historyUntil')]}
    >
      {history.data.events.map((e) => (
        <tr key={e.ruleId}>
          <th scope="row">{e.assetCode}</th>
          <td data-label={t('historyApplies')}>{t(`layer_${e.layer}` as 'layer_global')}</td>
          <td data-label={t('historyRate')}>{e.bands.map((b) => bpsPercent(b.feeBps)).join(' · ')}</td>
          <td data-label={t('historyFrom')}>
            <DateTime value={e.createdAt} />
          </td>
          <td data-label={t('historyUntil')}>
            {e.supersededAt ? <DateTime value={e.supersededAt} /> : <span>{t('historyCurrent')}</span>}
          </td>
        </tr>
      ))}
    </Grid>
  );
}

function ReserveText({ reserve }: { reserve: ControlProfile['reserve'] }) {
  const { t } = portalCopy.useCopy();
  if (!reserve || reserve.rollingReserveBps === null) return <NotConfigured>{t('reserveNoneShort')}</NotConfigured>;
  return (
    <>
      {t('reserveSet', { pct: bpsPercent(reserve.rollingReserveBps) })}{' '}
      {reserve.holdDays === null ? t('reserveDaysNone') : t('reserveDays', { days: reserve.holdDays })}
    </>
  );
}

function RuleTable({ rule, feeOnly }: { rule: PricingRule; feeOnly: boolean }) {
  const { t } = portalCopy.useCopy();
  return (
    <Section title={t('ruleTitle', { asset: rule.assetCode })} description={t(`layer_${rule.layer}` as 'layer_global')}>
      <Grid label={t('ruleTitle', { asset: rule.assetCode })} headers={[t('colFromAmount'), t('colFeePct'), t('colFlatFee')]}>
        {rule.bands.map((b) => (
          <tr key={b.fromAmount}>
            <th scope="row">
              <MoneyText value={b.fromAmount} asset={rule.assetCode} />
            </th>
            <td data-label={t('colFeePct')}>{bpsPercent(b.feeBps)}</td>
            <td data-label={t('colFlatFee')}>
              {b.flatFee === null ? <span>{t('noFlatFee')}</span> : <MoneyText value={b.flatFee} asset={rule.assetCode} />}
            </td>
          </tr>
        ))}
      </Grid>
      {!feeOnly && (
        <Facts
          items={[
            [t('spreadLabel'), rule.spreadBps === null ? <NotConfigured>{t('spreadNone')}</NotConfigured> : bpsPercent(rule.spreadBps)],
            [t('roundingLabel'), t(rule.roundingBeneficiary === 'platform' ? 'roundingPlatform' : 'roundingMerchant')],
          ]}
        />
      )}
      <p className="lt-hint">{t('bandsNote')}</p>
    </Section>
  );
}

export function FeeCalculator({
  portal,
  merchantId,
  assets,
  feeOnly = false,
}: {
  portal: PortalApi;
  merchantId: string;
  assets: string[];
  feeOnly?: boolean;
}) {
  const { t } = portalCopy.useCopy();
  const [asset, setAsset] = useState(assets[0] ?? '');
  const [amount, setAmount] = useState('');
  const [volume, setVolume] = useState('');
  const [conversion, setConversion] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ asset: string; amount: string; result: ApiResult<Quote> } | null>(null);
  const chosen = assets.includes(asset) ? asset : (assets[0] ?? '');
  const amountOk = isCalcAmount(amount);
  const volumeOk = volume.trim() === '' || /^\d+(\.\d{1,18})?$/.test(volume.trim());
  const none = assets.length === 0;
  const why = none ? t('calcNoPricing') : !amountOk && amount !== '' ? t('calcAmountInvalid') : !volumeOk ? t('calcVolumeInvalid') : null;
  async function run() {
    if (busy || none || !amountOk || !volumeOk) return;
    setBusy(true);
    try {
      const result = await portal.pricingPreview({
        merchantId,
        assetCode: chosen,
        amount: amount.trim(),
        ...(volume.trim() ? { monthlyVolume: volume.trim() } : {}),
        ...(conversion ? { conversion: true } : {}),
      });
      setOutcome({ asset: chosen, amount: amount.trim(), result });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section id={SECTION.calc} title={t('calcTitle')} description={t('calcBody')}>
      <form
        data-testid="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div>
          <SelectField
            label={t('colAsset')}
            value={chosen}
            onChange={setAsset}
            options={assets.length ? assets.map((a) => [a, a] as const) : [['', t('calcNoAssets')]]}
            disabled={none}
          />
          <Field
            label={`${t('calcAmount')} *`}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={none}
            hint={t('calcAmountHint')}
            error={amount !== '' && !amountOk ? t('calcAmountInvalid') : undefined}
          />
          <Field
            label={t('calcVolume')}
            inputMode="decimal"
            value={volume}
            onChange={(e) => setVolume(e.target.value)}
            disabled={none}
            hint={t('calcVolumeHint')}
            error={!volumeOk ? t('calcVolumeInvalid') : undefined}
          />
        </div>
        <Checkbox checked={conversion} onCheckedChange={setConversion} disabled={none}>
          {t('calcConversion')}
        </Checkbox>
        <div className="lt-actions">
          <Button type="submit" tone="primary" disabled={none || !amountOk || !volumeOk || busy}>
            {busy ? t('calcWorking') : t('calcRun')}
          </Button>
        </div>
        {why && (
          <p className="lt-hint" role="note">
            {why}
          </p>
        )}
      </form>
      {outcome &&
        (outcome.result.ok ? (
          <div aria-live="polite">
            <h3>{t('calcResultFor', { amount: formatMoney(outcome.amount, outcome.asset), asset: outcome.asset })}</h3>
            <Facts
              items={[
                [t('calcFee'), <MoneyText value={outcome.result.data.fee} asset={outcome.asset} />],
                ...(!feeOnly && outcome.result.data.spread !== null
                  ? ([[t('spreadLabel'), <MoneyText value={outcome.result.data.spread} asset={outcome.asset} />]] as const)
                  : []),
                [t('calcNet'), <MoneyText value={outcome.result.data.net} asset={outcome.asset} />],
                ...(feeOnly
                  ? []
                  : ([
                      [t('calcApplied'), t(`layer_${outcome.result.data.appliedLayer}` as 'layer_global')],
                      [t('calcBand'), <MoneyText value={outcome.result.data.bandFrom} asset={outcome.asset} />],
                      [t('calcMonthSoFar'), <MoneyText value={outcome.result.data.monthlyVolumeBefore} asset={outcome.asset} />],
                      [
                        t('roundingLabel'),
                        t(outcome.result.data.roundingBeneficiary === 'platform' ? 'roundingPlatform' : 'roundingMerchant'),
                      ],
                    ] as const)),
              ]}
            />
            <p className="lt-hint">{t('calcNote')}</p>
          </div>
        ) : (
          <Failure result={outcome.result} />
        ))}
    </Section>
  );
}
