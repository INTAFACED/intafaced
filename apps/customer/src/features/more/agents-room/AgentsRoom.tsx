// volt-room: /agents
import { useState } from 'react';
import { CatalogueTemplate } from '@intafaced/ui/lit/templates';
import { agentConnectCopy } from '../agent-connect-copy';
import { t as copyText } from '../copy';
import { AgentSectionTabs, AgentsSections, type AgentTab } from '../Agents';

/**
 * /agents on the kit's catalogue template (issue 9566): the published agents first, then sessions, the action log, the
 * dashboard, usage, the coach, the product boundaries and campaigns, under the room's "Agent sections" row. Each section
 * is a view of this one room, not an address of its own, so the row keeps the open section here.
 */
export function AgentsRoom({ paper = false }: { paper?: boolean }) {
  const [tab, setTab] = useState<AgentTab>('Catalogue');
  return (
    <CatalogueTemplate
      title={copyText('moreroutes.agents')}
      description={copyText('moreroutes.permissions.bounded.engine.sessions.and.your.activity')}
      roomAction={
        <a className="lt-button lt-button-secondary" href="/agents/connect">
          <agentConnectCopy.Copy k="title" />
        </a>
      }
      state={{ kind: 'ready' }}
      filters={<AgentSectionTabs tab={tab} onTab={setTab} />}
      items={<AgentsSections paper={paper} tab={tab} onTab={setTab} />}
    />
  );
}
