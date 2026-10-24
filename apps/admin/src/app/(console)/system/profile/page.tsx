import { FounderOpsShell } from '@/components/founder-ops/shell';
import { PreferencesDesk } from '@/components/preferences-desk';
import { loadPreferences } from '@/lib/console-preferences/server';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';

/** Profile and preferences (`/system/profile`, OPS-admin-access-08): the four levels and what is in force for this founder. */
export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  requireModulePage('merchants');
  const founder = await requireFounderPage();
  return (
    <FounderOpsShell showBadge={false}>
      <PreferencesDesk initial={await loadPreferences(founder)} />
    </FounderOpsShell>
  );
}
