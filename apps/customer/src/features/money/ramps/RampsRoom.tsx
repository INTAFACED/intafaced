import type { RoomState } from '@intafaced/ui/lit/templates';
import type { ActionSpec } from '../components';
import { t as copyText } from '../copy';
import { BankSettingsRoom } from '../bank-settings/BankSettingsRoom';
import { Panel } from '../bank-settings/parts';
import { railCopy } from '../rail-copy';
import { rampDepthCopy } from '../ramp-depth-copy';
import { OwnerRailRecords } from './RailRecords';
import { RampJourneys } from './RampJourneys';

/**
 * `/bank/ramps`: add money and cash out, each with what it needs, and the person's own cash-in and cash-out records, on
 * its settings template. Its index is the bank's rooms alone: its own links already name its sections ("Add money",
 * "Cash out to a bank account"), and a second link of the same name would make each one ambiguous.
 */
/** Each part of the room reads and refuses on its own, so the room itself is always ready. */
const READY: RoomState = { kind: 'ready' };

export function RampsRoom({ open }: { open: (spec: ActionSpec) => void }) {
  const { t } = railCopy.useCopy();
  const depth = rampDepthCopy.useCopy();
  return (
    <BankSettingsRoom
      room="Ramps"
      title={copyText('nav.ramps')}
      description={t('description')}
      state={READY}
      sectionsLabel={depth.t('sectionsLabel')}
      sections={[]}
      explain={depth.t('explain')}
    >
      <RampJourneys open={open} />
      <Panel id="ramps-history" title={depth.t('historyTitle')} lead={depth.t('historyLead')}>
        <OwnerRailRecords />
      </Panel>
    </BankSettingsRoom>
  );
}
