import type { ReactNode } from 'react';
import { TradeSubNav, type TradeRoom } from '../TradeSubNav';
import { Page, PageBody, PageHeader } from './ui';

export type RoomMode = 'Spot' | 'Margin' | 'Futures' | 'Options' | 'Copy' | 'Bots' | 'Execution' | 'Quote desk';

const ROOM_IDS: Record<RoomMode, TradeRoom> = {
  Spot: 'spot',
  Margin: 'margin',
  Futures: 'futures',
  Options: 'options',
  Copy: 'copy',
  Bots: 'bots',
  Execution: 'execution',
  'Quote desk': 'otc',
};

/** The strip every trade room carries, so a pro trader moves between rooms without going back to the menu. */
export function ModeStrip({ active }: { active: RoomMode }) {
  return <TradeSubNav active={ROOM_IDS[active]} />;
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
