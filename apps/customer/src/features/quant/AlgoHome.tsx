import { quantQuickStartOutputSchema } from '@intafaced/contracts/quant-algo';
import { useApi, useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { EmptyState, Panel } from '../../shared/ui';
import { StrategyTable } from './StrategyTable';
import { Read } from '../more/common';
import { preservePaperHref } from '../more/trade-context';
import { algoCopy } from './algo-copy';
import { QuantRooms } from './QuantRooms';
import './algo.css';

/** The Algo dev home: every room, the quick start ticked from the account's own stored rows, and its saved strategies. */
export function AlgoHome({ paper = false }: { paper?: boolean }) {
  const { userId } = useSession();
  const { t } = algoCopy.useCopy();
  return (
    <div className="more-grid">
      <QuantRooms active="home" paper={paper} />
      <p className="more-badge">{t('simulated')}</p>
      {userId ? (
        <SignedIn paper={paper} userId={userId} />
      ) : (
        <Panel title={t('quickStart')}>
          <EmptyState
            title={t('signedOutTitle')}
            action={
              <a className="button" href={`/login?redirect=${encodeURIComponent('/quant')}`}>
                {t('signIn')}
              </a>
            }
          >
            {t('signedOutBody')}
          </EmptyState>
        </Panel>
      )}
    </div>
  );
}

function SignedIn({ paper, userId }: { paper: boolean; userId: string }) {
  const api = useApi();
  const { t } = algoCopy.useCopy();
  const progress = useResource(
    (signal) => api.query('quant', 'quickStart', undefined, quantQuickStartOutputSchema, { signal }),
    `quant-quick-start:${userId}`,
  );
  return (
    <div className="more-columns">
      <Panel title={t('quickStart')}>
        <Read resource={progress.resource} retry={progress.reload}>
          {(p) => {
            const steps = [
              { done: p.strategy, title: t('stepStrategy'), body: t('stepStrategyBody'), href: '/quant/studio', open: t('openStudio') },
              { done: p.backtest, title: t('stepBacktest'), body: t('stepBacktestBody'), href: '/quant/backtest', open: t('openBacktest') },
              { done: p.paperRun, title: t('stepPaper'), body: t('stepPaperBody'), href: '/quant/sandbox', open: t('openSandbox') },
            ];
            return (
              <>
                <p role="status" data-testid="quant-quick-start-count">
                  {t('quickStartCount', { done: steps.filter((s) => s.done).length })}
                </p>
                <ol data-testid="quant-quick-start" className="quant-quick-start">
                  {steps.map((step) => (
                    <li key={step.href} data-done={step.done}>
                      <strong>{step.title}</strong> · <span>{step.done ? t('stepDone') : t('stepOpen')}</span>
                      <p className="muted">{step.body}</p>
                      <a className="text-link" href={preservePaperHref(step.href, paper)}>
                        {step.open}
                      </a>
                    </li>
                  ))}
                </ol>
                <a className="text-link" href="/academy">
                  {t('learn')}
                </a>
              </>
            );
          }}
        </Read>
      </Panel>
      <Panel title={t('strategies')}>
        <StrategyTable
          label={t('strategies')}
          reloadKey={`home:${userId}`}
          empty={
            <EmptyState
              title={t('strategiesNone')}
              action={
                <a className="text-link" href={preservePaperHref('/quant/studio', paper)}>
                  {t('openStudio')}
                </a>
              }
            >
              {t('strategiesNoneBody')}
            </EmptyState>
          }
        />
      </Panel>
    </div>
  );
}
