import { Lock, ShieldCheck } from 'lucide-react';
import { PreviewActionButton } from '../../../preview';
import type { SampleAgent, SampleLogEntry } from '../../../preview/fixtures/agents';
import { agentsCopy } from './copy';
import { waiting } from './model';

/** The Agentic Law in three lines, and four numbers: who is on duty, what happened in 24 hours, what waits for you. */
export function Overview({ agents, day }: { agents: readonly SampleAgent[]; day: readonly SampleLogEntry[] }) {
  const { t } = agentsCopy.useCopy();
  const on = agents.filter((agent) => agent.state === 'on').length;
  const stopped = day.filter((entry) => entry.check === 'blocked').length;
  return (
    <section className="ag-overview" aria-labelledby="ag-overview-h">
      <p className="ag-lede">{t('Lede')}</p>
      <h2 id="ag-overview-h" className="ag-sr">
        {t('Rule heading')}
      </h2>
      <ul className="ag-rules">
        {(['Rule one', 'Rule two', 'Rule three'] as const).map((rule, index) => {
          const Icon = index === 2 ? Lock : ShieldCheck;
          return (
            <li key={rule}>
              <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
              {t(rule)}
            </li>
          );
        })}
      </ul>
      <dl className="ag-stats">
        <div>
          <dt>{t('Stat on duty')}</dt>
          <dd className="if-num">
            {on} <span>{t('Of agents', { total: agents.length })}</span>
          </dd>
        </div>
        <div>
          <dt>{t('Stat actions')}</dt>
          <dd className="if-num">{day.length}</dd>
        </div>
        <div>
          <dt>{t('Stat waiting')}</dt>
          <dd className="if-num" data-tone={waiting(day).length > 0 ? 'warn' : undefined}>
            {waiting(day).length}
          </dd>
        </div>
        <div>
          <dt>{t('Stat stopped')}</dt>
          <dd className="if-num">{stopped}</dd>
        </div>
        <div className="ag-stats__pause">
          <PreviewActionButton product="agents" variant="secondary" size={40}>
            {t('Pause all')}
          </PreviewActionButton>
        </div>
      </dl>
    </section>
  );
}
