import type { ReactNode } from 'react';
import { EmptyState } from '../../../shared/ui';

/** A table row that holds only why the table is empty: the indexer reader it waits on. No row is ever invented. */
export function BlockedRow({ span, children }: { span: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={span}>
        <div role="status" data-blocker="indexer">
          <EmptyState title={children} />
        </div>
      </td>
    </tr>
  );
}
