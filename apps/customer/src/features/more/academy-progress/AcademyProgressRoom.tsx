// volt-room: /academy/progress
import { ACADEMY_CERT_DEFINITIONS } from '@intafaced/contracts/academy-learner-procedures';
import { MonitorTemplate } from '@intafaced/ui/lit/templates';
import { useResource } from '../../../shared/resource';
import { useApi, useSession } from '../../session';
import { t as copyText } from '../copy';
import { useKitAcademyAction } from '../academy-reader/academy-action-kit';
import { AcademyAccessGrants } from '../academy-access-grants';
import { definitionsHold } from '../academy-learning-state';
import { AcademyRefusal } from '../academy-refusal';
import { AcademySections } from '../academy-sections';
import { AcademyGrantRecords } from '../AcademyGrantRecords';
import { AcademyCourseProgress, AcademyPlanner } from '../AcademyProgressPage';

/**
 * `/academy/progress` on the monitor template: course progress, grades and the planner (AC-progress-02), then the access
 * records and certificate grant records (AC-order-01), on their own page outside the Academy's five sections. The same
 * reads and words as the old Academy room drew here; a signed-out visitor still gets the public Academy.
 */
export function AcademyProgressRoom() {
  const api = useApi(),
    { userId } = useSession();
  const action = useKitAcademyAction();
  const definitions = useResource(
    (signal) => api.call(ACADEMY_CERT_DEFINITIONS, undefined, { signal, accept: definitionsHold }),
    `cert-defs:${userId}`,
  );
  return (
    <MonitorTemplate
      title={copyText('moreroutes.academy')}
      description={copyText('moreroutes.learn.practise.and.join.hosted.sessions')}
      state={{ kind: 'ready' }}
      figures={[]}
      actions={<AcademySections current={null} />}
      panels={
        <div className="lt-grid">
          <AcademyCourseProgress />
          <AcademyPlanner />
          <AcademyAccessGrants />
          {/* Without the definitions the records still list, by reference; the failure says why the titles are missing. */}
          {definitions.resource.status === 'failed' && <AcademyRefusal failure={definitions.resource.failure} retry={definitions.reload} />}
          <AcademyGrantRecords
            action={action}
            titles={new Map(definitions.resource.status === 'ready' ? definitions.resource.data.map((row) => [row.id, row.title]) : [])}
          />
          {action.feedback}
          {action.dialog}
        </div>
      }
    />
  );
}
