import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { AuthorizationDetail } from '@/components/card-programme/desk';
import { readAuthorization } from '@/lib/card-programme/read';
import '@/components/desk.css';

/** One card authorisation (J-bank-26 #3): lifecycle, capture variance and the trace of why it was decided. */
export const dynamic = 'force-dynamic';

export default async function AuthorizationPage({ params }: { params: Promise<{ id: string }> }) {
  requireModulePage('bank-ops');
  const founder = await requireFounderPage();
  const { asOf, part } = await readAuthorization(founder, (await params).id);
  return (
    <main className="dk-stack">
      <AuthorizationDetail asOf={asOf} part={part} />
    </main>
  );
}
