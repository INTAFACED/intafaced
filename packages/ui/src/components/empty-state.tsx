import type { ReactNode } from 'react';
import { StateBlock } from './state-block.js';

/** Empty panel with a caller-owned action (including router links). */
export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div data-slot="empty-state">
      <StateBlock kind="empty" title={title} body={children} />
      {action && <div className="mb-8 flex justify-center">{action}</div>}
    </div>
  );
}
