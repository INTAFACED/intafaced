import { DocPage } from '../DocPage';
import { ReadFailed, ReadLoading } from '../ReadState';
import { useSession } from '../../session';
import { botPolicyView, readBotPolicy } from '../developers-values';
import { useRead } from '../use-read';
import { tradingApiCopy } from './trading-api-copy';

/**
 * /developers/bot-policy (J-cex-spot-15 #3): the owner's bot policy, read from svc-trade. Until it is published the page
 * says so in one line and claims no permission; an outage shows as an outage, never as a policy.
 */
export function BotPolicyPage({ title }: { title: string }) {
  const { t } = tradingApiCopy.useCopy();
  const { api } = useSession();
  const { read, reload } = useRead((signal) => readBotPolicy(api, signal), [api]);
  const view = botPolicyView(read);
  return (
    <DocPage id="bot-policy" title={title} lead={t('botLead')} back={t('back')}>
      {view.kind === 'loading' ? (
        <ReadLoading rows={2} label={t('loading')} />
      ) : view.kind === 'failed' ? (
        <ReadFailed title={t('loadFailed')} onRetry={reload} retryLabel={t('tryAgain')} />
      ) : view.kind === 'unset' ? (
        <section className="lt-hint" role="status" data-testid="developers-bot-policy-state" data-state="unset" data-code={view.code}>
          <p>
            <strong>{t('botUnpublished')}</strong>
          </p>
          <p>{t('botUnpublishedBody')}</p>
        </section>
      ) : (
        <section data-testid="developers-bot-policy-state" data-state="set">
          <p className="lt-pre-line">{view.policy}</p>
        </section>
      )}
    </DocPage>
  );
}
