import { useState } from 'react';
import type { ScreenProps } from '../../../app/screen-types';
import { PreviewScreen } from '../../../preview';
import { agentsFixture, type SampleAgentId } from '../../../preview/fixtures/agents';
import './agents.css';
import { ActivityLog } from './ActivityLog';
import { Fleet } from './Fleet';
import { Guardrails } from './Guardrails';
import { NavigatorBar } from './NavigatorBar';
import { Overview } from './Overview';
import { draftOf, lastDay, type Draft } from './model';

/**
 * Agents (Preview): a workforce, not a chatbot. The fleet, a guardrails editor, the activity log and a Navigator command bar. Sample
 * data only, from the agents fixture. Every action opens the shared "nothing was sent" sheet. `?sample=empty` shows an empty log.
 */
export default function AgentsPreview({ search }: ScreenProps) {
  const rows = agentsFixture.rows;
  const empty = new URLSearchParams(search).get('sample') === 'empty';
  const log = empty ? [] : rows.log;
  const day = lastDay(log, rows.asOf);
  const [selected, setSelected] = useState<SampleAgentId>('navigator');
  const [drafts, setDrafts] = useState<Partial<Record<SampleAgentId, Draft>>>({});
  const agent = rows.agents.find((candidate) => candidate.id === selected) ?? rows.agents[0]!;
  const draft = drafts[agent.id] ?? draftOf(agent.guardrails);
  return (
    <PreviewScreen product="agents">
      <div className="if-agents">
        <Overview agents={rows.agents} day={day} />
        <NavigatorBar commands={rows.commands} />
        <div className="ag-layout">
          <Fleet agents={rows.agents} day={day} selected={selected} onSelect={setSelected} />
          <Guardrails
            agent={agent}
            draft={draft}
            temperament={rows.temperament}
            day={day}
            onChange={(next) =>
              setDrafts((current) => {
                const copy = { ...current };
                if (next === null) delete copy[agent.id];
                else copy[agent.id] = next;
                return copy;
              })
            }
          />
        </div>
        <ActivityLog agents={rows.agents} log={log} />
      </div>
    </PreviewScreen>
  );
}
