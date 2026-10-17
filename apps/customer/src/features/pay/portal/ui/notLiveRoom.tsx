import { NotLiveCard } from '../chrome/NotLiveCard';
import { reason, type ReasonKey } from '../chrome/copy';
import type { RoomDef } from '../rooms-model';

/**
 * A page whose data source is not live yet. It keeps its place in the menu and its address, names what it is
 * waiting for (`why`, required) and says in one plain sentence what it will do. A package replaces its entry with the real page as the source goes live.
 */
export function notLiveRoom(
  words: () => { title: string; purpose: string; body?: string },
  why: ReasonKey,
  here?: RoomDef['here'],
  needs?: string,
): RoomDef {
  return {
    header: () => {
      const { title, purpose } = words();
      return { title, purpose };
    },
    ...(here ? { here } : {}),
    render: () => (
      <NotLiveCard variant="page" reason={reason(why)} needs={needs}>
        {words().body}
      </NotLiveCard>
    ),
  };
}
