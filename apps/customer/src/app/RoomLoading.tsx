import { Skeleton } from '@intafaced/ui/lit/templates';

/**
 * A room on its way: the page's shape in the kit's still placeholders (a figure and its chart beside a list, then a
 * grid of tiles), never a spinner on empty black. The words stay for a screen reader and for the waits that read them.
 */
export function RoomLoading({ label }: { label: string }) {
  return (
    <div className="lt-room room-loading" role="status">
      <span className="room-loading__words">{label}…</span>
      <div className="room-loading__panels">
        <div className="room-loading__panel">
          <Skeleton shape="figure" />
          <Skeleton shape="chart" />
        </div>
        <Skeleton shape="rows" />
      </div>
      <Skeleton shape="grid" />
    </div>
  );
}
