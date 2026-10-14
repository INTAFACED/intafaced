import { Switch } from '@intafaced/ui';
import { PreviewChip, usePreviewSheet } from '../../../preview';
import type { SampleAgent, SampleAgentId, SampleLogEntry } from '../../../preview/fixtures/agents';
import { agentsCopy } from './copy';
import { agentIcons } from './icons';
import { actionsBy } from './model';

/**
 * The fleet: one row per agent with its job in plain words, whether it is on duty, and how much it did in 24 hours.
 * Picking a row only chooses which agent the guardrails panel shows. The on/off switch is an action, so it opens the sheet.
 */
export function Fleet({
  agents,
  day,
  selected,
  onSelect,
}: {
  agents: readonly SampleAgent[];
  day: readonly SampleLogEntry[];
  selected: SampleAgentId;
  onSelect: (id: SampleAgentId) => void;
}) {
  const { t } = agentsCopy.useCopy();
  const sheet = usePreviewSheet();
  return (
    <section className="if-preview__panel ag-fleet" aria-labelledby="ag-fleet-h" data-testid="agents-fleet">
      <div className="if-preview__panel-head">
        <h2 className="if-preview__h2" id="ag-fleet-h">
          {t('Fleet heading')}
        </h2>
        <PreviewChip />
      </div>
      <p className="ag-fine">{t('Fleet line')}</p>
      <ul className="ag-fleet__list" aria-label={t('Fleet label')}>
        {agents.map((agent) => {
          const Icon = agentIcons[agent.id];
          const count = actionsBy(day, agent.id);
          const mode = agent.guardrails.mode;
          return (
            <li key={agent.id} className="ag-agent" data-agent={agent.id} data-state={agent.state} data-selected={selected === agent.id || undefined}>
              <button type="button" className="ag-agent__pick" aria-pressed={selected === agent.id} onClick={() => onSelect(agent.id)}>
                <span className="ag-agent__icon" aria-hidden="true">
                  <Icon size={20} strokeWidth={1.75} />
                </span>
                <span className="ag-agent__text">
                  <span className="ag-agent__name">
                    {agent.name}
                    <span className="ag-agent__state" data-state={agent.state}>
                      {agent.state === 'on' ? t('State on') : agent.state === 'paused' ? t('State paused') : t('State off')}
                    </span>
                  </span>
                  <span className="ag-agent__job">{agent.job}</span>
                  <span className="ag-agent__meta">
                    <span>{agent.canMoveMoney ? t('Can move money') : t('Reads only')}</span>
                    {agent.state !== 'off' ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{mode === 'suggest' ? t('Mode suggest short') : mode === 'ask' ? t('Mode ask short') : t('Mode act short')}</span>
                        <span aria-hidden="true">·</span>
                        <span className="if-num">{count === 1 ? t('One action') : t('Actions count', { count })}</span>
                      </>
                    ) : null}
                  </span>
                </span>
              </button>
              <Switch
                checked={agent.state === 'on'}
                onCheckedChange={() => sheet.open('agents')}
                aria-label={t('Switch label', { name: agent.name })}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
