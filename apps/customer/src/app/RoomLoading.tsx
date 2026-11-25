import { Skeleton } from '@intafaced/ui';

/**
 * A room on its way: the page's shape in still blocks (a title, a wide panel beside a narrow one, a list), never a
 * spinner on empty black. The words stay for a screen reader and for the waits that read them.
 */
export function RoomLoading({ label }: { label: string }) {
  return (
    <div className="lt-room room-loading" role="status">
      <span className="room-loading__words">{label}…</span>
      <Skeleton width="12rem" height="2.25rem" />
      <div className="room-loading__panels">
        <Skeleton height="18rem" />
        <Skeleton height="18rem" />
      </div>
      <Skeleton height="14rem" />
    </div>
  );
}
