import type { ResearchProvenance as Provenance } from '@intafaced/contracts/agents-research';
import { usePreferences } from '../../shared/preferences';
import { Details } from './common';
import { researchProvenanceCopy } from './research-provenance-copy';

/**
 * Where a Navigator research answer's facts came from (RC-agents-09; J-agents-10 #4), as svc-agents built it: the
 * sources the platform read itself, the venue's observation time, the data's environment, the assumptions, the
 * uncertainty level on the published scale, and every sentence that cites no source. This only shows it; the service
 * decides every part, and the block is shown whole even when a part is empty.
 */

function observed(at: string, preferences: ReturnType<typeof usePreferences>) {
  return new Intl.DateTimeFormat(preferences.language, {
    dateStyle: 'medium',
    timeStyle: 'medium',
    ...(preferences.timeZone === 'device' ? {} : { timeZone: preferences.timeZone === 'UTC+8' ? 'Asia/Singapore' : 'UTC' }),
  }).format(new Date(at));
}

/** The reply, sentence by sentence as the service read it, with each unsupported sentence marked. */
export function ResearchReply({ text, provenance }: { text: string; provenance: Provenance }) {
  const { t } = researchProvenanceCopy.useCopy();
  const unsupported = new Set(provenance.unsupported);
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    <p data-testid="more-body" className="more-body">
      {sentences.map((sentence, index) => (
        <span key={index}>
          {index > 0 ? ' ' : null}
          <span lang="und">{sentence}</span>
          {unsupported.has(sentence) ? (
            <>
              {' '}
              <mark data-testid="unsupported-claim">{t('unsupportedTag')}</mark>
            </>
          ) : null}
        </span>
      ))}
    </p>
  );
}

export function ResearchProvenance({ provenance }: { provenance: Provenance }) {
  const { t } = researchProvenanceCopy.useCopy();
  const preferences = usePreferences();
  const { uncertainty } = provenance;
  return (
    <section role="region" aria-label={t('title')}>
      <h3>{t('title')}</h3>
      <p>{t('intro')}</p>
      <Details
        items={[
          [
            t('source'),
            <ul>
              {provenance.sources.map((source) => (
                <li key={source.id} data-testid="research-source">
                  {t('sourceLine', { id: source.id, market: source.market, value: source.value })} ·{' '}
                  <time dateTime={source.observedAt}>{observed(source.observedAt, preferences)}</time>
                </li>
              ))}
            </ul>,
          ],
          [
            t('observedAt'),
            <time dateTime={provenance.observedAt} data-testid="research-observed-at">
              {observed(provenance.observedAt, preferences)}
            </time>,
          ],
          [t('environment'), <span data-testid="research-environment">{t(`env_${provenance.environment}`)}</span>],
          [
            t('assumptions'),
            provenance.assumptions.length === 0 ? (
              t('noAssumptions')
            ) : (
              <ul>
                {provenance.assumptions.map((code) => (
                  <li key={code}>{t(`assumption_${code}`)}</li>
                ))}
              </ul>
            ),
          ],
          [
            t('uncertainty'),
            <span data-testid="research-uncertainty">
              {t('uncertaintyLine', {
                level: uncertainty.level,
                scale: uncertainty.scale.join(' · '),
                unsupported: uncertainty.unsupportedCount,
                claims: uncertainty.claimCount,
              })}
            </span>,
          ],
          [
            t('unsupported'),
            provenance.unsupported.length === 0 ? (
              t('noUnsupported')
            ) : (
              <ul>
                {provenance.unsupported.map((claim, index) => (
                  <li key={index} lang="und" data-testid="research-unsupported">
                    {claim}
                  </li>
                ))}
              </ul>
            ),
          ],
        ]}
      />
      <p role="note">{t('notAdvice')}</p>
    </section>
  );
}
