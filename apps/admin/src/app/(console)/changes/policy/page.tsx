import Link from 'next/link';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { ChangePolicyRoom } from '@/components/change-policy/room';
import { readChangePolicyRoom } from '@/lib/change-policy/read';
import '@/components/desk.css';

/** Approval policy per governed action type (OPS-change-control-01 CR-1). Read only. */
export const dynamic = 'force-dynamic';

export default async function ChangePolicyPage() {
  requireModulePage('identity-ops');
  const founder = await requireFounderPage();
  const room = await readChangePolicyRoom(founder);
  return (
    <main className="dk-stack" data-testid="change-policy-page">
      <p>
        <Link href="/identity-ops">Identity</Link>
      </p>
      <ChangePolicyRoom asOf={room.asOf} policies={room.policies} />
    </main>
  );
}
