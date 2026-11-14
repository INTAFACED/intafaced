import { AgentsFleetDesk } from '@/components/agents-fleet-desk';
import { AgentsOutsideDesk } from '@/components/agents-outside-desk';
import '@/components/desk.css';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';

/**
 * The agent fleet (AG-registry-01, AG-control-02): see and quarantine every agent on the platform. The registry and
 * every switch are svc-agents', read and run as the signed-in founder; the action log is one level down at
 * /more-ops/agents/log. Below it, each person's own outside assistant connection (J-agents-21 #15), read from svc-trade
 * and quarantined through identity and svc-trade.
 */
export const dynamic = 'force-dynamic';

export default async function Page() {
  requireModulePage('more-ops');
  const founder = await requireFounderPage();
  return (
    <>
      <AgentsFleetDesk csrf={founder.session.csrf} />
      <AgentsOutsideDesk csrf={founder.session.csrf} />
      <p className="dk-muted">
        <a href="/more-ops/agents/log">Agent action log</a>
      </p>
    </>
  );
}
