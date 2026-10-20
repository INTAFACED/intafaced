import Link from 'next/link';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { CasesRoom } from '@/components/compliance-cases/room';
import { parseRoomQuery } from '@/lib/compliance-cases/model';
import { readCaseRoom } from '@/lib/compliance-cases/read';
import '@/components/desk.css';

/**
 * Compliance case inboxes: the inboxes you belong to, filters, a list counted by svc-ops, a preview, jump to a case by id and the
 * next unassigned case. Every part is read on its own and fails on its own.
 */
export const dynamic = 'force-dynamic';

export default async function ComplianceCasesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  requireModulePage('jurisdiction');
  const founder = await requireFounderPage();
  const q = parseRoomQuery(await searchParams);
  const room = await readCaseRoom(founder, q);
  return (
    <main className="dk-stack" data-testid="compliance-cases">
      <p>
        <Link href="/jurisdiction">Jurisdiction</Link>
      </p>
      <CasesRoom room={room} q={q} />
    </main>
  );
}
