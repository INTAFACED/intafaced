import type { ReactNode } from 'react';
import { Page, PageBody, PageHeader } from './ui';

export type RoomMode = 'Spot' | 'Margin' | 'Futures' | 'Options' | 'Copy' | 'Bots' | 'Execution' | 'Quote desk';

const MODES: ReadonlyArray<{ mode: RoomMode; href: string }> = [
  { mode: 'Spot', href: '/trade' },
  { mode: 'Margin', href: '/trade/margin' },
  { mode: 'Futures', href: '/trade/futures' },
  { mode: 'Options', href: '/trade/options' },
  { mode: 'Copy', href: '/trade/copy' },
  { mode: 'Bots', href: '/trade/bots' },
  { mode: 'Execution', href: '/execution' },
  { mode: 'Quote desk', href: '/otc' },
];

/** The strip every trade room carries, so a pro trader moves between rooms without going back to the menu (Binance/OKX mode row). */
export function ModeStrip({ active }: { active: RoomMode }) {
  return (
    <nav aria-label="Trading rooms" className="flex flex-wrap gap-x-5 gap-y-1 border-b border-line pb-2 text-sm">
      {MODES.map(({ mode, href }) => (
        <a
          key={mode}
          href={href}
          aria-current={mode === active ? 'page' : undefined}
          className={mode === active ? 'font-medium text-fg' : 'text-fg-2 hover:text-fg'}
        >
          {mode}
        </a>
      ))}
    </nav>
  );
}

/** Page chrome for a trade room: the mode strip, the title with its status chips, then the room. Dense, full width. */
export function RoomFrame({
  mode,
  title,
  description,
  meta,
  actions,
  children,
}: {
  mode: RoomMode;
  title: string;
  description?: string;
  /** Freshness and status chips shown under the title. */
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Page width="full" density="dense" landmark={false}>
      <div className="flex flex-col gap-3">
        <ModeStrip active={mode} />
        <PageHeader title={title} description={description} meta={meta} actions={actions} density="dense" />
      </div>
      <PageBody density="dense">{children}</PageBody>
    </Page>
  );
}
