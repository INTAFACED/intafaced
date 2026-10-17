import { ComingSoonCard } from '../chrome/ComingSoonCard';
import type { RoomDef } from '../rooms-model';

/**
 * A page whose data source is not live yet. It keeps its place in the menu and its address, and says in one plain
 * sentence what it will do. A package replaces its entry with the real page as the source goes live.
 */
export function comingSoonRoom(words: () => { title: string; purpose: string; body?: string }, here?: RoomDef['here']): RoomDef {
  return {
    header: () => {
      const { title, purpose } = words();
      return { title, purpose };
    },
    ...(here ? { here } : {}),
    render: () => <ComingSoonCard variant="page">{words().body}</ComingSoonCard>,
  };
}
