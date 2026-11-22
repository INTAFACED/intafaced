import { ReadingTemplate, ServiceOffNotice } from '@intafaced/ui/lit/templates';
import { serviceOffCopy } from '../../shared/service-off';
import { labCopy } from './lab-copy';

/**
 * /lab and /lab/detail/:id: the Lab's own screen (SP-pages-01), on the reading template. What the Lab holds is an owner
 * decision that has not been recorded, and there is no store of entries, so the page names that reason and lists nothing.
 * It is not the Campaigns room.
 */
export function LabPage({ detail = false }: { detail?: boolean }) {
  const copy = labCopy.useCopy();
  const off = serviceOffCopy.useCopy();
  const action = copy.t('publishAction');
  return (
    <div data-room="lab">
      <ReadingTemplate
        title={copy.t('title')}
        description={copy.t('lead')}
        state={{ kind: 'ready' }}
        body={
          <section role="status" aria-labelledby="lab-state">
            <h2 id="lab-state">{copy.t(detail ? 'detailTitle' : 'noneTitle')}</h2>
            <p>{copy.t(detail ? 'detailBody' : 'noneBody')}</p>
            <ServiceOffNotice
              code="owner.decision"
              sentence={off.t('sentence', { action, dependency: off.t('owner.decision') })}
              role="note"
            />
            {detail && (
              <a className="lt-link lt-link-alone" href="/lab">
                <span className="lt-arrow lt-arrow-back" aria-hidden="true" /> {copy.t('back')}
              </a>
            )}
          </section>
        }
        related={
          <section aria-labelledby="lab-elsewhere">
            <h2 id="lab-elsewhere">{copy.t('elsewhereTitle')}</h2>
            <p>{copy.t('elsewhereBody')}</p>
            <p className="lt-actions">
              <a className="lt-link lt-link-alone" href="/">
                {copy.t('home')} <span className="lt-arrow lt-arrow-go" aria-hidden="true" />
              </a>
              <a className="lt-link lt-link-alone" href="/help">
                {copy.t('help')} <span className="lt-arrow lt-arrow-go" aria-hidden="true" />
              </a>
            </p>
          </section>
        }
      />
    </div>
  );
}
