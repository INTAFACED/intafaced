import { ServiceOffNotice } from '../../shared/service-off';
import { labCopy } from './lab-copy';
import './public-pages.css';

/**
 * /lab and /lab/detail/:id: the Lab's own screen (SP-pages-01). What the Lab holds is an owner decision that has not been
 * recorded, and there is no store of entries, so the page names that reason and lists nothing. It is not the Campaigns room.
 */
export function LabPage({ detail = false }: { detail?: boolean }) {
  const copy = labCopy.useCopy();
  return (
    <div className="pub-page" data-room="lab">
      <header className="pub-heading">
        <h1>{copy.t('title')}</h1>
        <p className="muted">{copy.t('lead')}</p>
      </header>
      <section className="pub-notice" role="status" aria-labelledby="lab-state">
        <h2 id="lab-state">{copy.t(detail ? 'detailTitle' : 'noneTitle')}</h2>
        <p>{copy.t(detail ? 'detailBody' : 'noneBody')}</p>
        <ServiceOffNotice code="owner.decision" action={copy.t('publishAction')} role="note" />
        {detail && (
          <a className="text-link" href="/lab">
            ← {copy.t('back')}
          </a>
        )}
      </section>
      <section className="pub-card" aria-labelledby="lab-elsewhere">
        <h2 id="lab-elsewhere">{copy.t('elsewhereTitle')}</h2>
        <p>{copy.t('elsewhereBody')}</p>
        <a className="text-link" href="/">
          {copy.t('home')} →
        </a>{' '}
        <a className="text-link" href="/help">
          {copy.t('help')} →
        </a>
      </section>
    </div>
  );
}
