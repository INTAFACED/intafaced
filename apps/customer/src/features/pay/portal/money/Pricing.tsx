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
import type { PricingHistory as History } from './schemas';

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
  const tierName = tierData?.status === 'configured' ? (tierData.tiers.find((x) => x.id === tierData.ownTierId)?.name ?? null) : null;
  return (
    <div className="stack">
      <TestBanner />
      <Gate resource={control.resource} retry={control.reload} rows={4}>
        {(profile) => {
          const rules = profile.pricing ?? [];
          const assets = pricingAssets(profile.pricing);
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

              <FeeCalculator portal={portal} merchantId={merchantId} assets={assets} feeOnly={feeOnly} />

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
