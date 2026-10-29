import { useState } from 'react';
import type { ApiResult } from '../../../../shared/api';
import { useResource } from '../../../../shared/resource';
import { Button, DataTable } from '@intafaced/ui';
import { Field } from '../../ui-kit';
import { PaySection } from '../../components';
import { useMerchantAccess } from '../access/MerchantAccess';
import { Facts, Gate, NotConfigured, PortalFailure, PortalLoading, SelectField } from '../components';
import { mc as portalCopy } from './copy';
import { buildCsv, downloadText } from '../csv';
import { useReadAt } from '../hooks';
import { isNotLive } from '../refusal';
import { DateTime } from '../ui/DateTime';
import { Freshness } from '../ui/Freshness';
import { formatMoney } from '../ui/format';
import { KpiStrip } from '../ui/Kpi';
import { MoneyText } from '../ui/MoneyText';
import { NamedBlocker, TestBanner } from './common';
import { feeStory, hasAccountFee, percentOfBps } from '../ui/fee-story';
import { bpsPercent, isCalcAmount, pricingAssets } from './model';
import { EffectiveFeeView, useEffectiveFeeRates } from './fee-rate';
import type { PortalApi } from '../api';
import type { ControlProfile, PricingRule, Quote } from '../schemas';
import type { PricingHistory as History, TierFee, TierList, TierSummary } from './schemas';

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
    <div className="stack">
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
              {merchantRead.status === 'failed' && <PortalFailure result={merchantRead.failure} retry={reloadMerchant} />}
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
                      <span className="muted">{merchantRead.status === 'loading' ? '…' : '—'}</span>
                    ),
                  },
                  { label: t('priceAssets'), period: t('mnPeriodNow'), href: '/pay/pricing', value: String(assets.length) },
                  {
                    label: t('priceSince'),
                    period: t('mnPeriodNow'),
                    href: '/pay/pricing',
                    value: profile.updatedAt ? <DateTime value={profile.updatedAt} /> : <span className="muted">{t('notRecorded')}</span>,
                    size: 'text',
                  },
                ]}
              />
              <PaySection
                title={t('pricingNowTitle')}
                description={t('pricingNowBody')}
                action={
                  rules.length > 0 ? (
                    <Button
                      variant="secondary"
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
                        <span className="muted">{t('priceFeeUnavailable')}</span>
                      ) : (
                        <span className="muted">…</span>
                      ),
                    ],
                    [
                      t('effectiveSince'),
                      profile.updatedAt ? <DateTime value={profile.updatedAt} /> : <span className="muted">{t('notRecorded')}</span>,
                    ],
                    [t('reserveTitle'), <ReserveText reserve={profile.reserve} />],
                  ]}
                />
                {rules.length === 0 &&
                  (account && hasAccountFee(account) ? (
                    <div className="pp-callout" role="note">
                      {t('pricingNoSchedule')}
                    </div>
                  ) : (
                    <div className="pp-callout pp-callout--warn" role="note">
                      <NotConfigured /> {t('pricingNotConfiguredBody')}
                    </div>
                  ))}
              </PaySection>

              <PaySection title={t('tierFeesTitle')} description={t('tierFeesBody')}>
                <TierFeeTable tiers={tiers.resource} retry={tiers.reload} feeOnly={feeOnly} />
              </PaySection>

              {rules.map((rule) => (
                <RuleTable key={`${rule.layer}:${rule.scopeId ?? ''}:${rule.assetCode}`} rule={rule} feeOnly={feeOnly} />
              ))}

              <PaySection title={t('priceActualTitle')} description={t('priceActualBody')}>
                <EffectiveFeeView
                  resource={rates.resource}
                  fallback={<p className="muted">{t('rateUnavailable')}</p>}
                  note={t('rateWindow30')}
                />
              </PaySection>

              <FeeCalculator portal={portal} merchantId={merchantId} assets={calcAssets} feeOnly={feeOnly} />

              <PaySection title={t('priceHistoryTitle')} description={t('historyBody')}>
                <HistoryTable history={history.resource} retry={history.reload} />
              </PaySection>
            </>
          );
        }}
      </Gate>
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
  if (tiers.status === 'loading') return <PortalLoading rows={2} />;
  if (tiers.status === 'failed') return <PortalFailure result={tiers.failure} retry={retry} />;
  if (tiers.data.status === 'not_configured') return <p className="muted">{t('tierFeesNone')}</p>;
  const ownTierId = tiers.data.ownTierId;
  const notSet = <NotConfigured>{t('feeNotSet')}</NotConfigured>;
  return (
    <DataTable label={t('tierFeesTitle')} headers={[t('colTier'), t('colAsset'), t('colProcessingFee'), t('colPayoutFee')]}>
      {tiers.data.tiers.flatMap((tier) => {
        const fees: Array<TierFee | null> = tier.fees && tier.fees.length > 0 ? tier.fees : [null];
        const name = tier.id === ownTierId ? t('tierYours', { name: tier.name }) : tier.name;
        const payout = tier.payoutFee?.kind === 'not_charged' ? t('payoutNotCharged') : notSet;
        return fees.map((fee) => (
          <tr key={`${tier.id}:${fee?.assetCode ?? ''}`} data-testid={`tier-fee-${tier.id}-${fee?.assetCode ?? 'none'}`}>
            <th scope="row">{name}</th>
            <td>{fee ? fee.assetCode : <span className="muted">—</span>}</td>
            <td>{fee ? <TierFeeText fee={fee} feeOnly={feeOnly} /> : notSet}</td>
            <td>{payout}</td>
          </tr>
        ));
      })}
    </DataTable>
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
  return <span className="numeric">{parts.join(' · ')}</span>;
}

function HistoryTable({ history, retry }: { history: ReturnType<typeof useResource<History>>['resource']; retry: () => void }) {
  const { t } = portalCopy.useCopy();
  if (history.status === 'loading') return <PortalLoading rows={2} />;
  if (history.status === 'failed')
    return isNotLive(history.failure) ? (
      <NamedBlocker title={t('priceHistoryTitle')} why="reasonHistory" needs="merchantControl.pricing.history">
        {t('historyBlocked')}
      </NamedBlocker>
    ) : (
      <PortalFailure result={history.failure} retry={retry} />
    );
  if (history.data.status === 'not_configured') return <p className="muted">{t('historyNone')}</p>;
  return (
    <DataTable
      label={t('priceHistoryTitle')}
      headers={[t('colAsset'), t('historyApplies'), t('historyRate'), t('historyFrom'), t('historyUntil')]}
    >
      {history.data.events.map((e) => (
        <tr key={e.ruleId}>
          <th scope="row">{e.assetCode}</th>
          <td>{t(`layer_${e.layer}` as 'layer_global')}</td>
          <td className="numeric">{e.bands.map((b) => bpsPercent(b.feeBps)).join(' · ')}</td>
          <td>
            <DateTime value={e.createdAt} />
          </td>
          <td>{e.supersededAt ? <DateTime value={e.supersededAt} /> : <span className="muted">{t('historyCurrent')}</span>}</td>
        </tr>
      ))}
    </DataTable>
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
    <PaySection title={t('ruleTitle', { asset: rule.assetCode })} description={t(`layer_${rule.layer}` as 'layer_global')}>
      <DataTable label={t('ruleTitle', { asset: rule.assetCode })} headers={[t('colFromAmount'), t('colFeePct'), t('colFlatFee')]}>
        {rule.bands.map((b) => (
          <tr key={b.fromAmount}>
            <th scope="row">
              <MoneyText value={b.fromAmount} asset={rule.assetCode} />
            </th>
            <td className="numeric">{bpsPercent(b.feeBps)}</td>
            <td>
              {b.flatFee === null ? (
                <span className="muted">{t('noFlatFee')}</span>
              ) : (
                <MoneyText value={b.flatFee} asset={rule.assetCode} />
              )}
            </td>
          </tr>
        ))}
      </DataTable>
      {!feeOnly && (
        <Facts
          items={[
            [t('spreadLabel'), rule.spreadBps === null ? <NotConfigured>{t('spreadNone')}</NotConfigured> : bpsPercent(rule.spreadBps)],
            [t('roundingLabel'), t(rule.roundingBeneficiary === 'platform' ? 'roundingPlatform' : 'roundingMerchant')],
          ]}
        />
      )}
      <p className="muted pp-note">{t('bandsNote')}</p>
    </PaySection>
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
    <PaySection title={t('calcTitle')} description={t('calcBody')}>
      <form
        data-testid="form-stack"
        className="form-stack pp-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div className="pp-filter-row">
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
        <label className="pp-check">
          <input type="checkbox" checked={conversion} onChange={(e) => setConversion(e.target.checked)} disabled={none} />
          <span>{t('calcConversion')}</span>
        </label>
        <div className="pp-actions">
          <Button type="submit" variant="primary" disabled={none || !amountOk || !volumeOk || busy}>
            {busy ? t('calcWorking') : t('calcRun')}
          </Button>
        </div>
        {why && (
          <p className="muted pp-note" role="note">
            {why}
          </p>
        )}
      </form>
      {outcome &&
        (outcome.result.ok ? (
          <div aria-live="polite">
            <h3 className="pp-sub">{t('calcResultFor', { amount: formatMoney(outcome.amount, outcome.asset), asset: outcome.asset })}</h3>
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
            <p className="muted pp-note">{t('calcNote')}</p>
          </div>
        ) : (
          <PortalFailure result={outcome.result} />
        ))}
    </PaySection>
  );
}
