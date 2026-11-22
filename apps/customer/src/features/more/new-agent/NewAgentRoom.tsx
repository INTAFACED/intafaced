import { Button } from '@intafaced/ui/lit';
import { FlowTemplate } from '@intafaced/ui/lit/templates';
import { agentBuilderCopy } from '../agent-builder-copy';
import { useAgentPicker } from '../AgentIdentity';
import { AssistantPart } from './AssistantPart';
import { FailureNote, ReadFailure } from './FailureNote';
import { refusalCode, refusalWords, type Failed } from './refusal-words';

/** What a failed create says: the service's refusal in words with its code, or the app's own account of the failure. */
function Answer({ failed }: { failed: Failed }) {
  const { t } = agentBuilderCopy.useCopy();
  const code = refusalCode(failed);
  if (!code) return <FailureNote result={failed} />;
  return (
    <p role="alert">
      {refusalWords(t, code, {}).words} <code lang="zxx">{code}</code>
    </p>
  );
}

/**
 * `/agents/new` ("New agent"), on the flow template: pick a template, which makes a draft, then build it; or ask the
 * drafting assistant for one. Nothing here moves money.
 */
export function NewAgentRoom() {
  const { t } = agentBuilderCopy.useCopy();
  const { catalogue, refused, busy, start } = useAgentPicker();
  return (
    <FlowTemplate
      title={t('newAgent')}
      state={{ kind: 'ready' }}
      step={
        <>
          <section role="region" aria-label={t('templatesTitle')}>
            <h2>{t('templatesTitle')}</h2>
            <p className="lt-hint">{t('templatesIntro')}</p>
            <div className="lt-actions">
              {/* The starter shows once the service says it offers it; "Start blank" is always offered and needs no read. */}
              {catalogue.resource.status === 'ready' &&
              catalogue.resource.data.templates.some((template) => template.id === 'service-starter') ? (
                <Button tone="primary" disabled={busy} onClick={() => void start('service-starter')}>
                  {t('useServiceStarter')}
                </Button>
              ) : null}
              <Button tone="secondary" disabled={busy} onClick={() => void start('blank')}>
                {t('startBlank')}
              </Button>
            </div>
            {catalogue.resource.status === 'failed' ? <ReadFailure result={catalogue.resource.failure} retry={catalogue.reload} /> : null}
            {refused ? <Answer failed={refused} /> : null}
          </section>
          <AssistantPart />
        </>
      }
    />
  );
}
