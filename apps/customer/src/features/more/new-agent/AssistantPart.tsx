import { Button, TextArea } from '@intafaced/ui/lit';
import { agentBuilderCopy } from '../agent-builder-copy';
import { useAssistant } from '../AgentIdentity';
import { identityWordsKey } from './assistant-words';
import { FailureNote, ReadFailure } from './FailureNote';
import type { Failed } from './refusal-words';

type Words = ReturnType<typeof agentBuilderCopy.useCopy>['t'];

/** A refused draft or accept: the service's code in words, or the app's own account of the failure. */
function Answer({ failed, t }: { failed: Failed; t: Words }) {
  const key = identityWordsKey(failed.message);
  return key ? (
    <p role="alert">
      {t(key)} <code lang="zxx">{failed.message}</code>
    </p>
  ) : (
    <FailureNote result={failed} />
  );
}

/**
 * The builder's drafting assistant (AG-builder-03; J-agents-03 #6). While the owner has not chosen the model it shows
 * the owner-decision notice and drafts nothing; the rest of the builder works without it. A draft is shown with its
 * tools, which passed the check a save meets, and nothing is saved until the person accepts it.
 */
export function AssistantPart() {
  const { t } = agentBuilderCopy.useCopy();
  const { state, engine, description, setDescription, proposal, setProposal, refused, busy, draft, accept } = useAssistant();

  return (
    <section role="region" aria-label={t('assistantTitle')}>
      <h2>{t('assistantTitle')}</h2>
      {engine === null ? (
        <p role="note">
          {t('assistantBlocked')} <code lang="zxx">owner.decision</code>
        </p>
      ) : engine === 'live' ? (
        <p role="note">{t('assistantLive')}</p>
      ) : engine === 'test' ? (
        <p className="lt-hint">{t('assistantTest')}</p>
      ) : state.resource.status === 'failed' ? (
        <ReadFailure result={state.resource.failure} retry={state.reload} />
      ) : null}
      <TextArea label={t('describeAgent')} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} rows={5} />
      <Button tone="primary" disabled={busy || !engine || !description.trim()} onClick={() => void draft()}>
        {t('draftIt')}
      </Button>
      {proposal ? (
        <section aria-label={t('proposalTitle')}>
          <h3>{t('proposalTitle')}</h3>
          <p className="lt-hint">{t('proposalSaved')}</p>
          <dl>
            <dt>{t('name')}</dt>
            <dd data-testid="proposal-name">{proposal.name}</dd>
            <dt>{t('instructions')}</dt>
            <dd data-testid="proposal-instructions">{proposal.instructions}</dd>
          </dl>
          <ul aria-label={t('toolsTitle')}>
            {proposal.tools.map((tool) => (
              <li key={tool}>
                <code lang="zxx">{tool}</code>
              </li>
            ))}
          </ul>
          {proposal.leftOut.length ? (
            <ul aria-label={t('proposalLeftOut')}>
              {proposal.leftOut.map((row) => (
                <li key={row.tool}>
                  <code lang="zxx">{row.tool}</code> · <code lang="zxx">{row.code}</code>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="lt-actions">
            <Button tone="primary" disabled={busy} onClick={() => void accept(proposal)}>
              {t('acceptDraft')}
            </Button>
            <Button tone="secondary" disabled={busy} onClick={() => setProposal(null)}>
              {t('discardDraft')}
            </Button>
          </div>
        </section>
      ) : null}
      {refused ? <Answer failed={refused} t={t} /> : null}
    </section>
  );
}
