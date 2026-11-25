// volt-room: /blueprint/crew
import { RecordListTemplate } from '@intafaced/ui/lit/templates';
import { t as copyText } from '../copy';
import { moreRoomRoutesCopy } from '../more-room-routes-copy';
import { BlueprintBody } from './BlueprintRoom';

/**
 * `/blueprint/crew` on the record-list template: the crew roster and export alongside the person's Blueprint sections.
 */
export function BlueprintCrewRoom({ path }: { path: string }) {
  const routes = moreRoomRoutesCopy.useCopy();
  return (
    <RecordListTemplate
      title={routes.t('crew')}
      description={copyText('moreroutes.a.profile.you.can.keep.private.share')}
      state={{ kind: 'ready' }}
      list={<BlueprintBody path={path} focusCrew />}
    />
  );
}
