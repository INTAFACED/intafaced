// volt-room: /mining/workers/:workerId
import { MonitorTemplate } from '@intafaced/ui/lit/templates';
import { miningCopy } from '../mining-copy';
import { moreRoomRoutesCopy } from '../more-room-routes-copy';
import { preservePaperHref } from '../trade-context';

/**
 * /mining/workers/:workerId on the monitor template: one worker's own page. No read for one worker is wired yet, so the
 * room says so, with a way back to the Mining room; an id the room doesn't use is refused without looking anything up.
 */
export function MiningWorkerRoom({ invalid, paper }: { invalid: boolean; paper: boolean }) {
  const { t } = moreRoomRoutesCopy.useCopy();
  const scope = miningCopy.useCopy().t('scope');
  return (
    <MonitorTemplate
      title={t('worker')}
      description={scope}
      state={{
        kind: 'empty',
        title: t(invalid ? 'badIdTitle' : 'detailTitle'),
        body: t(invalid ? 'badIdBody' : 'detailBody'),
        action: { label: t('open'), href: preservePaperHref('/mining', paper) },
      }}
      figures={[]}
    />
  );
}
