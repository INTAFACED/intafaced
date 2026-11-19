import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { OpsDesk } from '@/components/ops-desk';
import { academySectionDesk, narrowDesk } from '@/lib/ops-desk/catalog';
import { loadDesk } from '@/lib/ops-desk/server';

/**
 * The Academy desk's grants section on its own page: that section's reads alone, through the Academy ops API. The address
 * may narrow the grant audit to one course or one certificate (`?course=<slug>`, `?certificate=<id>`; `narrowDesk`).
 */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  requireModulePage('academy-ops');
  const founder = await requireFounderPage();
  const filter = await searchParams;
  return (
    <OpsDesk
      spec={narrowDesk(academySectionDesk('grants'), filter)}
      initial={await loadDesk(founder, 'academy', new Date(), ['grants'], filter)}
      userId={founder.session.userId}
    />
  );
}
