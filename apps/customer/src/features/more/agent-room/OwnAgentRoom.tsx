// volt-room: /agents/:agentId
import { CatalogueTemplate } from '@intafaced/ui/lit/templates';
import { OwnAgentPage, useOwnAgentTitle } from './own-agent';

/**
 * /agents/<id> on the kit: one of the person's own agents, its pages in the catalogue's item slot. The title is the
 * agent's name (or that it has none), following each save, as the old page's title did.
 */
export function OwnAgentRoom({ id }: { id: string }) {
  const title = useOwnAgentTitle(id);
  return <CatalogueTemplate title={title} state={{ kind: 'ready' }} items={null} item={<OwnAgentPage key={id} id={id} />} />;
}
