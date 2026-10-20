import { quantDisclosureCurrentSchema } from '@intafaced/contracts/quant-disclosure';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import { Button, Failure, Loading, Panel } from '../../shared/ui';
import { quantDisclosureCopy } from './quant-disclosure-copy';

/**
 * The risk disclosure the owner published, or the plain statement that none is. The acceptance control stays on the page, off,
 * with the reason: an acceptance belongs to one saved strategy version and Studio saves nothing to the service.
 */
export function QuantDisclosure() {
  const api = useApi();
  const { Copy, t, languageFor, directionFor } = quantDisclosureCopy.useCopy();
  const disclosure = useResource(
    (signal) => api.query('quant', 'disclosure.current', undefined, quantDisclosureCurrentSchema, { signal }),
    'quant-disclosure',
  );
  const state = disclosure.resource;
  return (
    <Panel title={t('title')}>
      <div data-testid="quant-disclosure">
        {state.status === 'loading' ? (
          <Loading label={t('loading')} />
        ) : state.status === 'failed' ? (
          <div role="alert">
            <p>{t('readFailed')}</p>
            <Failure result={state.failure} retry={disclosure.reload} />
          </div>
        ) : state.data.published ? (
          <section lang={languageFor('version')} dir={directionFor('version')}>
            <p className="muted">{t('version', { version: String(state.data.version) })}</p>
            <p data-testid="quant-disclosure-text" style={{ whiteSpace: 'pre-wrap' }}>
              {state.data.text}
            </p>
          </section>
        ) : (
          <p role="status" lang={languageFor('notPublished')} dir={directionFor('notPublished')}>
            <Copy k="notPublished" />
          </p>
        )}
        <p className="muted">
          <Copy k="standing" />
        </p>
        <Button type="button" disabled aria-describedby="quant-disclosure-accept-reason" data-testid="quant-disclosure-accept">
          {t('accept')}
        </Button>
        <p className="muted" id="quant-disclosure-accept-reason">
          <Copy k="acceptReason" />
        </p>
      </div>
    </Panel>
  );
}
