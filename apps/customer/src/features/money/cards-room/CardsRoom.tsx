import type { RoomState } from '@intafaced/ui/lit/templates';
import type { ActionSpec } from '../components';
import { t as copyText } from '../copy';
import { BankSettingsRoom } from '../bank-settings/BankSettingsRoom';
import { cardCopy } from '../card-copy';
import { OwnerCards } from './Cards';

/** Each part of the room reads and refuses on its own, so the room itself is always ready. */
const READY: RoomState = { kind: 'ready' };

/**
 * `/bank/cards`: the person's cards, what each spends from, its controls, decisions and declines, on its settings
 * template. Its index is the bank's rooms alone: its sections are named by what each card holds, and a link of the
 * same name as a card's own heading would make each one ambiguous.
 */
export function CardsRoom({ open }: { open: (spec: ActionSpec) => void }) {
  const { t } = cardCopy.useCopy();
  return (
    <BankSettingsRoom
      room="Cards"
      title={copyText('nav.cards')}
      description={copyText('rooms.issuer.connectivity.and.card.outcomes.are.separate')}
      state={READY}
      sectionsLabel={t('sectionsLabel')}
      sections={[]}
      explain={t('explain')}
    >
      <OwnerCards open={open} />
    </BankSettingsRoom>
  );
}
