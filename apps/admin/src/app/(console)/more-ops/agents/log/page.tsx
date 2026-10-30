import { AgentsLogDesk } from '@/components/agents-log-desk';
import '@/components/desk.css';
import { readReasons } from '@/lib/agents-log/server';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';

/**
 * The agent action log (AG-audit-01, AG-audit-02): find out why an agent action failed for a customer. The reason list
 * is the owner's, read from svc-agents as the signed-in founder; a blank list is shown as its refusal, and every search
 * then refuses with the same code.
 */
export const dynamic = 'force-dynamic';

export default async function Page() {
  requireModulePage('more-ops');
  const founder = await requireFounderPage();
  const reasons = await readReasons(founder);
  return (
    <AgentsLogDesk
      csrf={founder.session.csrf}
      reasons={reasons.kind === 'ok' ? reasons.reasons : []}
      reasonsRefusal={reasons.kind === 'ok' ? null : reasons.code}
    />
  );
}
