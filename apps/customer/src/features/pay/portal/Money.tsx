import { useResource, type Resource } from '../../../shared/resource';
import { Button, DataTable, EmptyState } from '../../../shared/ui';
import { PaySection } from '../components';
import { AsOf, BackLink, ComingSoon, Facts, Gate, Kpi, KpiGrid, Money as Amount, NotConfigured, SelectField } from './components';
import { useNow, useUrlParam } from './hooks';
import { amountFor, bpsPercent } from './model';
import type { PortalApi } from './api';
import type { ControlProfile, Snapshot } from './schemas';
import { w3cCopy } from './w3c-copy';

export function MerchantMoney({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const snapshot = useResource((signal) => portal.snapshot(merchantId, 'today', signal), `portal:money:${merchantId}`);
  const control = useResource((signal) => portal.control(merchantId, signal), `portal:money-policy:${merchantId}`);
  return (
    <MoneyView
      snapshot={snapshot.resource}
      control={control.resource}
      retry={() => {
        snapshot.reload();
        control.reload();
      }}
    />
  );
}
export function MoneyView({
  snapshot,
  control,
  retry,
}: {
  snapshot: Resource<Snapshot>;
  control: Resource<ControlProfile>;
  retry: () => void;
}) {
  const { t } = w3cCopy.useCopy();
  const [pickedAsset, setAsset] = useUrlParam('asset', '');
  const now = useNow();
  return (
    <div className="stack">
      <BackLink href="/pay/merchant">{t('backMerchant')}</BackLink>
      <div className="pp-actions">
        <Button variant="secondary" onClick={retry}>
          {t('refresh')}
        </Button>
        <a className="text-link" href="/pay/payouts">
          {t('requestPayout')}
        </a>
      </div>
      <Gate resource={snapshot} retry={retry} rows={4}>
        {(data) => {
          const assets = data.balances.map((balance) => balance.assetCode);
          const asset = assets.includes(pickedAsset) ? pickedAsset : assets[0];
          const balance = data.balances.find((row) => row.assetCode === asset);
          const freshness = {
            ...data.freshness,
            lagSeconds:
              data.freshness.lagSeconds === null || !data.freshness.asOf
                ? null
                : Math.max(data.freshness.lagSeconds, Math.floor((now - Date.parse(data.freshness.asOf)) / 1000)),
          };
          return (
            <div className="stack">
              <AsOf freshness={freshness} />
              <p className="muted">{t('balanceSource')}</p>
              {balance && asset ? (
                <>
                  <SelectField label={t('asset')} value={asset} onChange={setAsset} options={assets.map((value) => [value, value])} />
                  <KpiGrid label={t('moneyTitle')}>
                    <Kpi
                      label={t('available')}
                      period={t('currentSnapshot')}
                      value={<Amount value={balance.available} asset={asset} />}
                      href={`/pay/money/activity?asset=${encodeURIComponent(asset)}`}
                    />
                    <Kpi
                      label={t('pendingBalance')}
                      period={t('currentSnapshot')}
                      value={<Amount value={balance.clearing} asset={asset} />}
                      href={`/pay/settlements?asset=${encodeURIComponent(asset)}`}
                    />
                    <Kpi
                      label={t('capturedToday')}
                      period={t('todayUtc')}
                      value={
                        amountFor(data.captured, asset) === null ? '—' : <Amount value={amountFor(data.captured, asset)!} asset={asset} />
                      }
                      href={`/pay/payments?asset=${encodeURIComponent(asset)}`}
                    />
                    <Kpi
                      label={t('refundedToday')}
                      period={t('todayUtc')}
                      value={
                        amountFor(data.refunded, asset) === null ? '—' : <Amount value={amountFor(data.refunded, asset)!} asset={asset} />
                      }
                      href="/pay/refunds"
                    />
                  </KpiGrid>
                  <DataTable label={t('allBalances')} headers={[t('asset'), t('available'), t('pendingBalance')]}>
                    {data.balances.map((row) => (
                      <tr key={row.assetCode}>
                        <td>{row.assetCode}</td>
                        <td>
                          <Amount value={row.available} asset={row.assetCode} />
                        </td>
                        <td>
                          <Amount value={row.clearing} asset={row.assetCode} />
                        </td>
                      </tr>
                    ))}
                  </DataTable>
                </>
              ) : (
                <EmptyState
                  title={t('balanceEmpty')}
                  action={
                    <a className="button button--primary" href="/pay/links/new">
                      {t('linkNew')}
                    </a>
                  }
                >
                  {t('balanceEmptyBody')}
                </EmptyState>
              )}
              <ComingSoon title={t('nextBackend')}>{t('balanceHistoryGap')}</ComingSoon>
            </div>
          );
        }}
      </Gate>
      <PaySection title={t('reserveTitle')}>
        <Gate resource={control} retry={retry} rows={2}>
          {(profile) =>
            profile.reserve === null ? (
              <NotConfigured>{t('reserveNone')}</NotConfigured>
            ) : (
              <Facts
                items={[
                  [
                    t('reserveRate'),
                    profile.reserve.rollingReserveBps === null ? <NotConfigured /> : bpsPercent(profile.reserve.rollingReserveBps),
                  ],
                  [t('reserveDays'), profile.reserve.holdDays === null ? <NotConfigured /> : profile.reserve.holdDays],
                ]}
              />
            )
          }
        </Gate>
        <ComingSoon title={t('nextBackend')}>{t('reserveGap')}</ComingSoon>
      </PaySection>
    </div>
  );
}
export function BalanceActivity() {
  const { t } = w3cCopy.useCopy();
  return (
    <div className="stack">
      <BackLink href="/pay/money">{t('moneyTitle')}</BackLink>
      <ComingSoon title={t('nextBackend')}>{t('activityGap')}</ComingSoon>
      <div className="pp-actions">
        <a className="button button--secondary" href="/pay/payments">
          {t('openPayments')}
        </a>
        <a className="text-link" href="/pay/settlements">
          {t('openSettlements')}
        </a>
        <a className="text-link" href="/pay/reports">
          {t('reportsTitle')}
        </a>
      </div>
    </div>
  );
}
