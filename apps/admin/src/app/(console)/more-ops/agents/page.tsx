import { AgentsFleetDesk } from '@/components/agents-fleet-desk';
import '@/components/desk.css';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';

/**
 * The agent fleet (AG-registry-01, AG-control-02): see and quarantine every agent on the platform. The registry and
 * every switch are svc-agents', read and run as the signed-in founder; the action log is one level down at
 * /more-ops/agents/log.
 */
export const dynamic = 'force-dynamic';

export default async function Page() {
  requireModulePage('more-ops');
  const founder = await requireFounderPage();
  return (
    <>
      <AgentsFleetDesk csrf={founder.session.csrf} />
      <p className="dk-muted">
        <a href="/more-ops/agents/log">Agent action log</a>
      </p>
    </>
  );
}
