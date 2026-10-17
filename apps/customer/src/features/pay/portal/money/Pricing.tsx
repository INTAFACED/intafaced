import { useState } from 'react';
import type { ApiResult } from '../../../../shared/api';
import { portalAmount } from '../presentation';
import { useResource, type Resource } from '../../../../shared/resource';
import { Button, DataTable, Field } from '@intafaced/ui';
import { PayTime, PaySection } from '../../components';
import { ComingSoon, Facts, Gate, Money, NotConfigured, PortalFailure, ReadAt, SelectField } from '../components';
import { portalCopy } from './copy';
import { buildCsv, downloadText } from '../csv';
import { useReadAt } from '../hooks';
import { bpsPercent, isCalcAmount, pricingAssets } from './model';
import type { PortalApi } from '../api';
import type { ControlProfile, PricingRule, Quote } from '../schemas';

/** `/pay/pricing`: what INTAFACED charges this account, read-only, with a calculator that uses the same engine as live payments. */
export function Pricing({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const control = useResource((s) => portal.control(merchantId, s), `portal:control:${merchantId}`);
  const readAt = useReadAt(control.resource.status === 'ready', control.resource);
  return <PricingView portal={portal} merchantId={merchantId} control={control.resource} readAt={readAt} retry={control.reload} />;
}

export function PricingView({
  portal,
  merchantId,
  control,
  readAt,
  retry,
}: {
  portal: PortalApi;
  merchantId: string;
  control: Resource<ControlProfile>;
  readAt: string | null;
  retry: () => void;
}) {
  const { t } = portalCopy.useCopy();
  return (
    <div className="stack">
      <Gate resource={control} retry={retry} rows={4}>
        {(profile) => {
          const rules = profile.pricing ?? [];
          const assets = pricingAssets(profile.pricing);
          return (
            <>
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
                            ['asset', 'applies_from', 'from_amount', 'fee_bps', 'flat_fee', 'conversion_spread_bps', 'rounding_goes_to'],
                            rules.flatMap((r) =>
                              r.bands.map((b) => [
                                r.assetCode,
                                r.layer,
                                b.fromAmount,
                                b.feeBps,
                                b.flatFee ?? '',
                                r.spreadBps ?? '',
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
                <ReadAt at={readAt} />
                <Facts
                  items={[
                    [
                      t('colTier'),
                      profile.tierId ? (
                        <span className="pp-mono">{profile.tierId}</span>
                      ) : (
                        <NotConfigured>{t('tierNotAssigned')}</NotConfigured>
                      ),
                    ],
                    [
                      t('effectiveSince'),
                      profile.updatedAt ? <PayTime value={profile.updatedAt} /> : <span className="muted">{t('notRecorded')}</span>,
                    ],
                    [t('versionLabel'), <span className="pp-mono">{profile.version}</span>],
                    [t('reserveTitle'), <ReserveText reserve={profile.reserve} />],
                  ]}
                />
                {rules.length === 0 && (
                  <div className="pp-callout pp-callout--warn" role="note">
                    <NotConfigured /> {t('pricingNotConfiguredBody')}
                  </div>
                )}
              </PaySection>

              {rules.map((rule) => (
                <RuleTable key={`${rule.layer}:${rule.scopeId ?? ''}:${rule.assetCode}`} rule={rule} />
              ))}

              <FeeCalculator portal={portal} merchantId={merchantId} assets={assets} />

              <ComingSoon title={t('pricingHistorySoonTitle')}>{t('pricingHistorySoonBody')}</ComingSoon>
            </>
          );
        }}
      </Gate>
    </div>
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

function RuleTable({ rule }: { rule: PricingRule }) {
  const { t } = portalCopy.useCopy();
  return (
    <PaySection title={t('ruleTitle', { asset: rule.assetCode })} description={t(`layer_${rule.layer}` as 'layer_global')}>
      <DataTable label={t('ruleTitle', { asset: rule.assetCode })} headers={[t('colFromAmount'), t('colFeePct'), t('colFlatFee')]}>
        {rule.bands.map((b) => (
          <tr key={b.fromAmount}>
            <th scope="row">
              <Money value={b.fromAmount} asset={rule.assetCode} />
            </th>
            <td className="numeric">
              {bpsPercent(b.feeBps)} <span className="pp-unit">{`(${b.feeBps} bps)`}</span>
            </td>
            <td>
              {b.flatFee === null ? <span className="muted">{t('noFlatFee')}</span> : <Money value={b.flatFee} asset={rule.assetCode} />}
            </td>
          </tr>
        ))}
      </DataTable>
      <Facts
        items={[
          [
            t('spreadLabel'),
            rule.spreadBps === null ? (
              <NotConfigured>{t('spreadNone')}</NotConfigured>
            ) : (
              `${bpsPercent(rule.spreadBps)} (${rule.spreadBps} bps)`
            ),
          ],
          [t('roundingLabel'), t(rule.roundingBeneficiary === 'platform' ? 'roundingPlatform' : 'roundingMerchant')],
        ]}
      />
      <p className="muted pp-note">{t('bandsNote')}</p>
    </PaySection>
  );
}

export function FeeCalculator({ portal, merchantId, assets }: { portal: PortalApi; merchantId: string; assets: string[] }) {
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
            <h3 className="pp-sub">{t('calcResultFor', { amount: portalAmount(outcome.amount, outcome.asset), asset: outcome.asset })}</h3>
            <Facts
              items={[
                [t('calcFee'), <Money value={outcome.result.data.fee} asset={outcome.asset} />],
                ...(outcome.result.data.spread !== null
                  ? ([[t('spreadLabel'), <Money value={outcome.result.data.spread} asset={outcome.asset} />]] as const)
                  : []),
                [t('calcNet'), <Money value={outcome.result.data.net} asset={outcome.asset} />],
                [t('calcApplied'), t(`layer_${outcome.result.data.appliedLayer}` as 'layer_global')],
                [t('calcBand'), <Money value={outcome.result.data.bandFrom} asset={outcome.asset} />],
                [t('calcMonthSoFar'), <Money value={outcome.result.data.monthlyVolumeBefore} asset={outcome.asset} />],
                [t('roundingLabel'), t(outcome.result.data.roundingBeneficiary === 'platform' ? 'roundingPlatform' : 'roundingMerchant')],
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
