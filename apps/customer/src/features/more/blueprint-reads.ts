import { BLUEPRINT_CARD, BLUEPRINT_EXPORT, BLUEPRINT_ME, BLUEPRINT_MENTORS } from '@intafaced/contracts/blueprint-procedures';
import type { ProcedureOutput } from '@intafaced/contracts/procedure';
import { useApi, useSession } from '../session';
import { useResource } from '../../shared/resource';

/**
 * The Blueprint room's reads and its two downloads, shared by the room on the kit (`blueprint-room/BlueprintRoom.tsx`,
 * /blueprint) and the old view the /blueprint/crew section still draws (`Blueprint.tsx`).
 */
export const VISIBILITIES = ['private', 'crew', 'public'] as const;
export const CARD_SIZES = ['portrait', 'landscape'] as const;
export type CardSize = (typeof CARD_SIZES)[number];
export const isCardSize = (value: string): value is CardSize => (CARD_SIZES as readonly string[]).includes(value);
export const isVisibility = (value: string): value is (typeof VISIBILITIES)[number] => (VISIBILITIES as readonly string[]).includes(value);

/** The file the export button saves: the reply as the room has always saved it, without the share rows it never kept. */
export function downloaded({ shares: _shares, cardsOpened: _cardsOpened, ...kept }: ProcedureOutput<typeof BLUEPRINT_EXPORT>) {
  return kept;
}
export function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The person's own Blueprint, their mentor shortlist and their share card at the chosen size, each read for this account only. */
export function useBlueprintReads(size: CardSize) {
  const api = useApi(),
    { userId } = useSession();
  const me = useResource(
      (signal) => api.call(BLUEPRINT_ME, undefined, { signal, accept: (row) => !row || row.userId === userId }),
      `blueprint:${userId}`,
    ),
    mentors = useResource(
      (signal) => api.call(BLUEPRINT_MENTORS, undefined, { signal, accept: (rows) => rows.every((row) => row.studentId === userId) }),
      `mentors:${userId}`,
    ),
    share = useResource((signal) => api.call(BLUEPRINT_CARD, { size }, { signal }), `card:${userId}:${size}`);
  const reload = () => {
    me.reload();
    mentors.reload();
    share.reload();
  };
  return { me, mentors, share, reload };
}
