import Link from 'next/link';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { RestoreRoom } from '@/components/restore/room';
import { parseRestoreQuery } from '@/lib/restore/model';
import { readRestoreRoom } from '@/lib/restore/read';
import { restoreWritesParked } from '@/lib/restore/treasury';
import '@/components/desk.css';

/**
 * Joint restore desk (OPS-ledger-desk-05): backups, recorded stamps, restore runs, the joint watermark and the ordered steps. Every
 * part is read on its own and fails on its own.
 */
export const dynamic = 'force-dynamic';

export default async function RestorePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  requireModulePage('ledger');
  const founder = await requireFounderPage();
  const { runNo } = parseRestoreQuery(await searchParams);
  const room = await readRestoreRoom(founder, runNo);
  return (
    <main className="dk-stack" data-testid="restore">
      <p>
        <Link href="/ledger">Ledger ops</Link>
      </p>
      <RestoreRoom room={room} runNo={runNo} userId={founder.session.userId} writes={restoreWritesParked(founder)} />
    </main>
  );
}
