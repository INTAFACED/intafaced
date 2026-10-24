import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { OpsDesk } from '@/components/ops-desk';
import { academySectionDesk } from '@/lib/ops-desk/catalog';
import { loadDesk } from '@/lib/ops-desk/server';

/** The Academy desk's certificates section on its own page: that section's reads alone, through the Academy ops API. */
export default async function Page() {
  requireModulePage('academy-ops');
  const founder = await requireFounderPage();
  return (
    <OpsDesk
      spec={academySectionDesk('certificates')}
      initial={await loadDesk(founder, 'academy', new Date(), ['certificates'])}
      userId={founder.session.userId}
    />
  );
}
