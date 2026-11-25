import type { ReactNode } from 'react';
import { Button, ButtonLink } from '@intafaced/ui/lit';
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

const ROOM_WIDGETS = [
  { id: 'agent', title: 'Agent', href: '/agents/approvals', room: 'Room Agents' },
  { id: 'bots', title: 'Bots running', href: '/trade/bots', room: 'Room Bots' },
  { id: 'prediction', title: 'Your prediction', href: '/predict/positions', room: 'Room Predict' },
  { id: 'copy', title: 'Copy trading', href: '/trade/copy', room: 'Room Copy' },
] as const;

/**
 * Agent, Bots running, Your prediction and Copy trading, which Home does not read: each one row, its name, the honest
 * status and its room's door, never a made-up figure. A row whose room this build hides is not drawn.
 */
export function RoomWidgets() {
  const { t } = commandCopy.useCopy();
  return (
    <>
      {ROOM_WIDGETS.filter((widget) => !isHiddenPath(widget.href)).map((widget) => (
        <section
          key={widget.id}
          className="hm-widget hm-widget-row"
          data-widget={widget.id}
          data-state="not-read"
          aria-labelledby={`home-widget-${widget.id}`}
        >
          <h2 id={`home-widget-${widget.id}`}>{t(widget.title)}</h2>
          <span className="lt-hint">{t('Widget not read')}</span>
          <a className="hm-link" href={widget.href} aria-label={t('Widget open {room}', { room: t(widget.room) })}>
            {t('Open')}
          </a>
        </section>
      ))}
    </>
  );
}

const TILE_NAME = {
  started: 'Tile started',
  work: 'Tile work',
  activity: 'Tile activity',
  markets: 'Tile markets',
} as const satisfies Partial<Record<HomeTileId, string>>;
const nameOf = (id: HomeTileId) => (id in TILE_NAME ? TILE_NAME[id as keyof typeof TILE_NAME] : undefined);

/** Pin a widget: each Home tile the person hid, one press to pin it back; the Academy (Learn's room); Customise Home for the rest. */
export function PinAWidget({ home, hidden, customise }: { home: HomeLayout; hidden: readonly HomeTileId[]; customise: ReactNode }) {
  const { t } = commandCopy.useCopy();
  const words = homeCopy.useCopy();
  const offered = hidden.filter((id) => nameOf(id) !== undefined);
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
        {isHiddenPath('/academy') ? null : (
          <ButtonLink size="sm" tone="secondary" href="/academy">
            {t('Academy')}
          </ButtonLink>
        )}
        {customise}
      </div>
    </section>
  );
}
