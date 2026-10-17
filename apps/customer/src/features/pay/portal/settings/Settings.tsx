import { Button } from '@intafaced/ui';
import { PayDetails, PaySection } from '../../components';
import { reason } from '../chrome/copy';
import { Arrives, CopyReference, PortalBack } from '../ExtensionTools';
import { extensionCopy as c } from './copy';
import type { MerchantRecord } from '../schemas';

export function SettingsNav() {
  return (
    <nav className="pp-filter-row" aria-label={c.t('settingsNav')}>
      <a className="text-link" href="/pay/settings">
        {c.t('settingsTitle')}
      </a>
      <a className="text-link" href="/pay/settings/team">
        {c.t('teamTitle')}
      </a>
      <a className="text-link" href="/pay/settings/notifications">
        {c.t('notificationSettings')}
      </a>
    </nav>
  );
}
export function Settings({ merchant }: { merchant: MerchantRecord | null }) {
  return (
    <div className="stack">
      <PortalBack />
      <SettingsNav />
      {merchant && (
        <PaySection title={c.t('accountFacts')}>
          <CopyReference value={merchant.id} />
          <PayDetails
            values={[
              [c.t('accountMode'), merchant.mode],
              [c.t('accountStatus'), merchant.status],
            ]}
          />
        </PaySection>
      )}
      <PaySection title={c.t('profileDetails')}>
        <Arrives reason={reason('reasonProfile')}>{c.t('profileGap')}</Arrives>
        <span title={c.t('profileSaveReason')}>
          <Button disabled>{c.t('saveProfile')}</Button>
        </span>
      </PaySection>
      <Arrives reason={reason('reasonHistory')}>{c.t('profileHistoryGap')}</Arrives>
    </div>
  );
}
