import type { ReactNode } from 'react';
import { TradeSubNav } from '../TradeSubNav';
import { Page, PageBody, PageHeader } from './ui';

/** The strip every trade room carries, so a pro trader moves between rooms without going back to the menu. */
export function ModeStrip() {
  return <TradeSubNav />;
}

/** Page chrome for a trade room: the mode strip, the title with its status chips, then the room. Dense, full width. */
export function RoomFrame({
  title,
  description,
  meta,
  actions,
  children,
}: {
  title: string;
  description?: string;
  /** Freshness and status chips shown under the title. */
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Page width="full" density="dense" landmark={false}>
      <div className="lt-stack">
        <ModeStrip />
        <PageHeader title={title} description={description} meta={meta} actions={actions} density="dense" />
      </div>
      <PageBody density="dense">{children}</PageBody>
    </Page>
  );
}
