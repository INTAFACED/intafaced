import { AgentsAlertsDesk } from '@/components/agents-alerts-desk';
import '@/components/desk.css';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';

/**
 * The agent alert desk (AG-analytics-02, AG-guardrails-02): alert rules over every agent action, the alerts they fire,
 * and the managed policy baseline with this environment's overrides. Everything is svc-agents', read and run as the
 * signed-in founder.
 */
export const dynamic = 'force-dynamic';

export default async function Page() {
  requireModulePage('more-ops');
  const founder = await requireFounderPage();
  return <AgentsAlertsDesk csrf={founder.session.csrf} />;
}
