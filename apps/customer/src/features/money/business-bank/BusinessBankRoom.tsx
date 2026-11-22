// volt-room: /bank/business
import type { RoomState } from '@intafaced/ui/lit/templates';
import type { ActionSpec } from '../components';
import { BankSettingsRoom } from '../bank-settings/BankSettingsRoom';
import { businessCopy } from '../business-copy';
import { BusinessSections } from './BusinessAccounts';

/** Each part of the room reads and refuses on its own, so the room itself is always ready. */
const READY: RoomState = { kind: 'ready' };

/**
 * `/bank/business`: set up approval rules, pay with a second person's approval, run payroll, keep the team and decide
 * on waiting payments, on its settings template.
 */
export function BusinessBankRoom({ open }: { open: (spec: ActionSpec) => void }) {
  const { t } = businessCopy.useCopy();
  return (
    <BankSettingsRoom
      room="Business"
      title={t('pageTitle')}
      description={t('lead')}
      state={READY}
      sectionsLabel={t('sectionsLabel')}
      sections={[
        ['business-open', t('openTitle')],
        ['business-accounts', t('accountsTitle')],
      ]}
      explain={t('explain')}
    >
      <BusinessSections open={open} />
    </BankSettingsRoom>
  );
}
