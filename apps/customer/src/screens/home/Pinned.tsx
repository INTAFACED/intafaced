import { useMemo, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@intafaced/ui/lit';
import { readPayees } from '../../features/money';
import { commandCopy } from './command-copy';
import { homeCopy } from './copy';
import { isHiddenPath } from './deps';
import { withHidden, type HomeTileId } from './tiles';
import type { HomeLayout } from './tiles-data';

/**
 * Home A's right column, under the next step: the pinned widgets, then "Pin a widget". A widget shows only what Home
 * really reads; one whose source Home does not read yet says so and opens its room, never a made-up figure. A widget
 * whose room this build hides is not drawn, as the action keys drop theirs.
 */
export function PinnedHead() {
  const { t } = commandCopy.useCopy();
  return (
    <div className="hm-pinned-head">
      <span>{t('Pinned')}</span>
      <span>{t('Pinned hint')}</span>
    </div>
  );
}

/** One pinned widget: its title and its body. Unpinning a Home tile is Customise Home's, in Pin a widget. */
export function Widget({
  id,
  title,
  children,
  testId,
}: {
  id: string;
  /** The widget's title; a widget whose body carries its own heading (Recent activity, Learn) passes none. */
  title?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  if (title === undefined)
    return (
      <div className="hm-widget" data-widget={id} data-testid={testId}>
        {children}
      </div>
    );
  return (
    <section className="hm-widget" data-widget={id} data-testid={testId} aria-labelledby={`home-widget-${id}`}>
      <h2 id={`home-widget-${id}`}>{title}</h2>
      {children}
    </section>
  );
}

/** A widget Home has no read for yet: the plain sentence and its room's door. */
function NotRead({ href, room }: { href: string; room: string }) {
  const { t } = commandCopy.useCopy();
  return (
    <div className="hm-widget-body" data-state="not-read">
      <p className="lt-hint">{t('Widget not read')}</p>
      <a className="hm-link" href={href}>
        {t('Widget open {room}', { room })}
      </a>
    </div>
  );
}

const ROOM_WIDGETS = [
  { id: 'agent', title: 'Agent', href: '/agents/approvals', room: 'Room Agents' },
  { id: 'bots', title: 'Bots running', href: '/trade/bots', room: 'Room Bots' },
  { id: 'prediction', title: 'Your prediction', href: '/predict/positions', room: 'Room Predict' },
  { id: 'copy', title: 'Copy trading', href: '/trade/copy', room: 'Room Copy' },
] as const;

/** Agent, Bots running, Your prediction and Copy trading: each in its honest state until Home reads its room. */
export function RoomWidgets() {
  const { t } = commandCopy.useCopy();
  return (
    <>
      {ROOM_WIDGETS.filter((widget) => !isHiddenPath(widget.href)).map((widget) => (
        <Widget key={widget.id} id={widget.id} title={t(widget.title)}>
          <NotRead href={widget.href} room={t(widget.room)} />
        </Widget>
      ))}
    </>
  );
}

/** Send to: the people this person saved on this device (the payee book), each opening Send with them filled in. */
export function SendTo({ userId }: { userId: string | null }) {
  const { t } = commandCopy.useCopy();
  const payees = useMemo(() => (userId ? readPayees(userId).slice(0, 4) : []), [userId]);
  if (isHiddenPath('/pay/send')) return null;
  return (
    <Widget id="send-to" title={t('Send to')} testId="home-send-to">
      <ul className="hm-people">
        <li>
          <a className="hm-person" data-new="" href="/pay/send" aria-label={t('Send to new')}>
            <Plus size={16} aria-hidden="true" />
          </a>
        </li>
        {payees.map((payee) => (
          <li key={payee.userId}>
            <a
              className="hm-person"
              href={`/pay/send?to=${encodeURIComponent(payee.handle)}`}
              aria-label={t('Send to {handle}', { handle: payee.handle })}
              title={payee.handle}
            >
              {payee.handle.slice(0, 1).toUpperCase()}
            </a>
          </li>
        ))}
      </ul>
      {payees.length === 0 ? <p className="lt-hint">{t('Send to none')}</p> : null}
    </Widget>
  );
}

const TILE_NAME = {
  started: 'Tile started',
  work: 'Tile work',
  activity: 'Tile activity',
  markets: 'Tile markets',
  learn: 'Tile learn',
} as const satisfies Partial<Record<HomeTileId, string>>;
const nameOf = (id: HomeTileId) => (id in TILE_NAME ? TILE_NAME[id as keyof typeof TILE_NAME] : undefined);

/** Pin a widget: each Home tile the person hid, one press to pin it back, and Customise Home for the rest. */
export function PinAWidget({ home, hidden, customise }: { home: HomeLayout; hidden: readonly HomeTileId[]; customise: ReactNode }) {
  const { t } = commandCopy.useCopy();
  const words = homeCopy.useCopy();
  const offered = hidden.filter((id) => nameOf(id) !== undefined && !(id === 'learn' && isHiddenPath('/academy')));
  return (
    <section className="hm-pin" data-testid="home-pin" aria-labelledby="home-pin-title">
      <h2 id="home-pin-title">{t('Pin a widget')}</h2>
      <div className="hm-pin-chips">
        {offered.map((id) => (
          <Button
            key={id}
            size="sm"
            tone="secondary"
            onClick={() => void home.save(withHidden(home.layout, id, false))}
            aria-label={t('Pin {tile}', { tile: words.t(nameOf(id)!) })}
          >
            {words.t(nameOf(id)!)}
          </Button>
        ))}
        {customise}
      </div>
    </section>
  );
}
