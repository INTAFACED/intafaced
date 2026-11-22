import { KeyValue, RefusalBox } from '@intafaced/ui/lit/templates';
import type { Loadable } from '../rooms/ui';
import type { OptionsPolicy } from '../rooms/api';
import { asOfOf } from '../rooms/read';
import { optionsCopy } from './copy';
import { Freshness, kvRow } from './notices';
import { RefusedRegion } from './shared';

export function SettlementTab({ policy }: { policy: Loadable<OptionsPolicy> }) {
  const { t } = optionsCopy.useCopy();
  if (policy.status === 'refused') return <RefusedRegion code={policy.code} />;
  const p = policy.status === 'ready' ? policy.data : null;
  const row = kvRow;
  return (
    <div className="lt-stack">
      <div className="lt-toolbar">
        <h3 className="lt-heading">{t('Settlement and exercise')}</h3>
        <Freshness asOf={asOfOf(policy)} />
      </div>
      <KeyValue
        rows={[
          row(t('Settlement asset'), p ? (p.settlementAssetLawStamped ? t('Published') : t('Not published')) : null),
          row(t('Settlement price source'), p ? (p.settlementFixingConfigured ? t('Set up') : t('Not set up')) : null),
          row(t('Style'), p ? (p.europeanOnly ? t('European: exercised at expiry only') : t('Other')) : null),
          row(t('Collateral'), p ? (p.fullCollateralV1 ? t('Full collateral') : t('Other')) : null),
          row(t('Exercise and expiry runs'), null, t('Jobs hint')),
        ]}
      />
      <p className="lt-hint">{t('Expiry price rule')}</p>
      <p className="lt-hint">{t('Result names')}</p>
      <RefusalBox refusal={{ variant: 'parked', title: t('Exercise history not published'), body: t('Exercise history blocker') }} />
    </div>
  );
}
