// volt-room: /quant
import { EmptyState } from '@intafaced/ui/lit';
import { DeskTemplate } from '@intafaced/ui/lit/templates';
import { useApi, useSession } from '../session';
import { useResource } from '../../shared/resource';
import { StrategyTable } from './StrategyTable';
import { preservePaperHref } from '../more';
import { algoCopy } from './algo-copy';
import { KitRead } from './kit-parts';
import { QuantRooms } from './QuantRooms';
import { QUANT_QUICK_START } from '@intafaced/contracts/quant-quick-start-procedures';

/**
 * The Algo dev home: every room, the quick start ticked from the account's own stored rows, and its saved strategies.
 * On the desk template: the room switch heads it, the quick start is its main panel and the strategies sit below.
 */
export function AlgoHome({ paper = false }: { paper?: boolean }) {
  const { userId } = useSession();
  const { t } = algoCopy.useCopy();
  return (
    <DeskTemplate
      title={t('title')}
      description={t('description')}
      mode="pro"
      state={{ kind: 'ready' }}
      section={<QuantRooms paper={paper} />}
      instrument={
        <div className="lt-col-main">
          <p className="lt-hint">{t('simulated')}</p>
        </div>
      }
      chart={
        userId ? (
          <QuickStart paper={paper} userId={userId} />
        ) : (
          <section>
            <h2>{t('quickStart')}</h2>
            <EmptyState
              title={t('signedOutTitle')}
              body={t('signedOutBody')}
              action={
                <a className="lt-button lt-button-primary" href={`/login?redirect=${encodeURIComponent('/quant')}`}>
                  {t('signIn')}
                </a>
              }
            />
          </section>
        )
      }
      ticket={null}
      orders={userId ? <Strategies paper={paper} userId={userId} /> : undefined}
    />
  );
}

function QuickStart({ paper, userId }: { paper: boolean; userId: string }) {
  const api = useApi();
  const { t } = algoCopy.useCopy();
  const progress = useResource((signal) => api.call(QUANT_QUICK_START, undefined, { signal }), `quant-quick-start:${userId}`);
  return (
    <section className="lt-col-main">
      <h2>{t('quickStart')}</h2>
      <KitRead resource={progress.resource} retry={progress.reload}>
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
              <ol data-testid="quant-quick-start" className="lt-col-main">
                {steps.map((step) => (
                  <li key={step.href} data-done={step.done}>
                    <strong>{step.title}</strong> · <span>{step.done ? t('stepDone') : t('stepOpen')}</span>
                    <p className="lt-hint">{step.body}</p>
                    <a className="lt-link" href={preservePaperHref(step.href, paper)}>
                      {step.open}
                    </a>
                  </li>
                ))}
              </ol>
              <a className="lt-link" href="/academy">
                {t('learn')}
              </a>
            </>
          );
        }}
      </KitRead>
    </section>
  );
}

function Strategies({ paper, userId }: { paper: boolean; userId: string }) {
  const { t } = algoCopy.useCopy();
  return (
    <section className="lt-col-main">
      <h2>{t('strategies')}</h2>
      <StrategyTable
        label={t('strategies')}
        reloadKey={`home:${userId}`}
        empty={
          <EmptyState
            title={t('strategiesNone')}
            body={t('strategiesNoneBody')}
            action={
              <a className="lt-link" href={preservePaperHref('/quant/studio', paper)}>
                {t('openStudio')}
              </a>
            }
          />
        }
      />
    </section>
  );
}
