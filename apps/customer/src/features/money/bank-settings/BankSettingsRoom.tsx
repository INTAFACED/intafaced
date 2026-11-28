import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui/lit';
import { SettingsTemplate, type RoomState } from '@intafaced/ui/lit/templates';
import { uiCopy } from '../../../shared/ui-copy';
import { t as copyText } from '../copy';
import { BankTabs } from '../bank-frame/BankFrame';
import type { bankRooms } from '../bank-frame/bank-rooms';

type BankRoom = (typeof bankRooms)[number];

/**
 * A bank room on the settings template: its title and description, the bank's rooms (the one it sits in marked), a
 * link to each of its sections, its sections and what they mean. A read that failed or is still on its way is the
 * template's state, with Try again in place when trying again can help; otherwise the title row offers the bank's
 * overview (the Ramps rooms never did).
 */
export function BankSettingsRoom({
  room,
  title,
  description,
  state,
  retry,
  sectionsLabel,
  sections,
  index,
  explain,
  children,
}: {
  /** The bank room this one sits in (the bank's navigation lights the route's own). */
  room: BankRoom;
  title: string;
  description: string;
  state: RoomState;
  /** Reads the room again, in place, after a read that failed. */
  retry?: () => void;
  sectionsLabel: string;
  /** The room's sections, each an id on the page and its name. */
  sections: readonly (readonly [string, string])[];
  /** Extra links for the index column, below the sections. */
  index?: ReactNode;
  explain: string;
  children: ReactNode;
}) {
  const ui = uiCopy.useCopy();
  return (
    <SettingsTemplate
      title={title}
      description={description}
      section={<BankTabs />}
      state={state}
      roomAction={
        retry ? (
          <Button tone="secondary" onClick={retry}>
            {ui.t('retry')}
          </Button>
        ) : room !== 'Ramps' ? (
          <a className="lt-button lt-button-secondary" href="/bank">
            {copyText('rooms.bank.overview')}
          </a>
        ) : undefined
      }
      index={
        (state.kind === 'ready' && sections.length > 0) || index ? (
          <>
            {state.kind === 'ready' && sections.length > 0 ? (
              <nav aria-label={sectionsLabel}>
                <ul>
                  {sections.map(([id, name]) => (
                    <li key={id}>
                      <a className="lt-link" href={`#${id}`}>
                        {name}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            ) : null}
            {index}
          </>
        ) : undefined
      }
      sections={state.kind === 'ready' ? children : null}
      explain={<p>{explain}</p>}
    />
  );
}
