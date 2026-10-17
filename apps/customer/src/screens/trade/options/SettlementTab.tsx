import { EmptyState, KeyValue, type Loadable } from '../rooms/ui';
import type { OptionsPolicy } from '../rooms/api';
import { Freshness } from '../rooms/RoomNotices';
import { asOfOf } from '../rooms/read';
import { optionsCopy } from './copy';
import { RefusedRegion } from './shared';

export function SettlementTab({ policy }: { policy: Loadable<OptionsPolicy> }) {
  const { t } = optionsCopy.useCopy();
  if (policy.status === 'refused') return <RefusedRegion code={policy.code} />;
  const p = policy.status === 'ready' ? policy.data : null;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="m-0 text-md font-medium text-fg">{t('Settlement and exercise')}</h3>
        <Freshness asOf={asOfOf(policy)} />
      </div>
      <KeyValue
        density="dense"
        items={[
          { label: t('Settlement asset'), value: p ? (p.settlementAssetLawStamped ? t('Published') : t('Not published yet')) : null },
          { label: t('Settlement price source'), value: p ? (p.settlementFixingConfigured ? t('Set up') : t('Not set up yet')) : null },
          { label: t('Style'), value: p ? (p.europeanOnly ? t('European: exercised at expiry only') : t('Other')) : null },
          { label: t('Collateral'), value: p ? (p.fullCollateralV1 ? t('Full collateral') : t('Other')) : null },
          { label: t('Exercise and expiry runs'), value: null, hint: t('Jobs hint') },
        ]}
      />
      <p className="m-0 text-sm text-fg-2">{t('Expiry price rule')}</p>
      <p className="m-0 text-sm text-fg-2">{t('Result names')}</p>
      <EmptyState variant="unavailable" size="inline" title={t('Exercise history not published')} reason={t('Exercise history blocker')} />
    </div>
  );
}
