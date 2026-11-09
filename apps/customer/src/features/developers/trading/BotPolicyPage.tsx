import { StateBlock } from '@intafaced/ui';
import { useSession } from '../../session/session';
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
    <div className="pub-page" data-testid="developers-bot-policy">
      <header className="pub-heading">
        <h1>{title}</h1>
        <p className="muted">{t('botLead')}</p>
      </header>
      {view.kind === 'loading' ? (
        <StateBlock kind="loading" rows={2} rowHeight={24} label={t('loading')} />
      ) : view.kind === 'failed' ? (
        <StateBlock kind="error" title={t('loadFailed')} onRetry={reload} retryLabel={t('tryAgain')} />
      ) : view.kind === 'unset' ? (
        <section className="pub-notice" role="status" data-testid="developers-bot-policy-state" data-state="unset" data-code={view.code}>
          <p>
            <strong>{t('botUnpublished')}</strong>
          </p>
          <p>{t('botUnpublishedBody')}</p>
        </section>
      ) : (
        <section className="pub-card" data-testid="developers-bot-policy-state" data-state="set">
          <p style={{ whiteSpace: 'pre-line' }}>{view.policy}</p>
        </section>
      )}
      <a className="text-link" href="/developers">
        ← {t('back')}
      </a>
    </div>
  );
}
