import Link from 'next/link';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { ChangePolicyDesk } from '@/components/change-policy/policy-desk';
import { loadPolicyRows } from '@/lib/staff-admin/staff-server';
import '@/components/desk.css';

/** Approval policy per governed action type (OPS-change-control-01 CR-1), and the two-founder row change (J-ops-console-09 #1). */
export const dynamic = 'force-dynamic';

export default async function ChangePolicyPage() {
  requireModulePage('identity-ops');
  const founder = await requireFounderPage();
  const rows = await loadPolicyRows(founder);
  return (
    <main className="dk-stack" data-testid="change-policy-page">
      <p>
        <Link href="/identity-ops">Identity</Link>
      </p>
      <ChangePolicyDesk initial={rows} userId={founder.session.userId} />
    </main>
  );
}
