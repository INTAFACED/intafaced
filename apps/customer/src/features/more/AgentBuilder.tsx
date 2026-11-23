import { useRef, useState } from 'react';
import { useApi } from '../session';
import { useResource } from '../../shared/resource';
import { Button, Failure, Panel } from '../../shared/ui';
import { navigate } from '../../app/location';
import { Read } from './common';
import { agentBuilderCopy } from './agent-builder-copy';
import { AGENTS_OWN_CATALOGUE, AGENTS_OWN_CREATE } from '@intafaced/contracts/agents-own-procedures';
import { AssistantPanel } from './AgentIdentity';
import { Refusal, refusalCode, type Failed } from './agent-room/own-agent';

/**
 * One of the person's own agents (/agents/<id>) is drawn on the kit in `agent-room/`; these names stay here for the
 * routes, the Agents room and the tests that reach them through this file.
 */
export { OwnAgentPage, PaymentMethod, Refusal, ownAgentId } from './agent-room/own-agent';

/** What a failed write says: the service's refusal in words, or the app's own account of a write it could not confirm. */
function Answer({ failed }: { failed: Failed }) {
  const code = refusalCode(failed);
  return code ? <Refusal code={code} /> : <Failure result={failed} />;
}

/** /agents/new: pick a template, which makes a draft, then build it. Nothing here moves money. */
export function NewAgent() {
  const api = useApi();
  const { t } = agentBuilderCopy.useCopy();
  const [refused, setRefused] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);
  // The templates the service offers (AG-catalogue-02): a template it does not offer has no button.
  const catalogue = useResource((signal) => api.call(AGENTS_OWN_CATALOGUE, undefined, { signal }), 'own-catalogue');
  // This visit's key for each template: pressing again after an answer that never arrived returns the draft the first
  // press made, rather than a second one. Each visit to the picker is a new draft.
  const visit = useRef(`picker:${crypto.randomUUID()}`);
  async function start(template: string) {
    setBusy(true);
    setRefused(null);
    const res = await api.call(AGENTS_OWN_CREATE, { template, createKey: `${visit.current}:${template}` });
    setBusy(false);
    if (res.ok) navigate(`/agents/${res.data.id}`, true);
    else setRefused(res);
  }
  return (
    <div className="more-grid">
      <Panel title={t('templatesTitle')} role="region" aria-label={t('templatesTitle')}>
        <p className="lt-muted">{t('templatesIntro')}</p>
        <div className="depth-card-actions">
          {/* The starter shows once the service says it offers it; "Start blank" is always offered and needs no read. */}
          {catalogue.resource.status === 'ready' &&
          catalogue.resource.data.templates.some((template) => template.id === 'service-starter') ? (
            <Button disabled={busy} onClick={() => void start('service-starter')}>
              {t('useServiceStarter')}
            </Button>
          ) : null}
          <Button variant="secondary" disabled={busy} onClick={() => void start('blank')}>
            {t('startBlank')}
          </Button>
        </div>
        {catalogue.resource.status === 'failed' ? (
          <Read resource={catalogue.resource} retry={catalogue.reload}>
            {() => null}
          </Read>
        ) : null}
        {refused ? <Answer failed={refused} /> : null}
      </Panel>
      <AssistantPanel />
    </div>
  );
}
