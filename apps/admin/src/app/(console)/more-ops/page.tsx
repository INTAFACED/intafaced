import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import Link from 'next/link';
import { OpsDesk } from '@/components/ops-desk';
import { DESKS } from '@/lib/ops-desk/catalog';
import { loadDesk } from '@/lib/ops-desk/server';

/**
 * More modules. The first paint is the owning services' own answers, each with the time it was read; a read that is refused or
 * down says so in words, and what a service cannot give is listed as not available with the reason.
 */
export default async function Page() {
  requireModulePage('more-ops');
  const founder = await requireFounderPage();
  return (
    <>
      <nav aria-label="More modules rooms" className="dk-row">
        <Link href="/more-ops/venue-economics">Venue unit economics</Link>
        <Link href="/more-ops/mining">Mining desk</Link>
        <Link href="/more-ops/predict">Predict desk</Link>
        <Link href="/more-ops/token">Token governance</Link>
        <Link href="/more-ops/campaigns/waves">Waitlist waves</Link>
      </nav>
      <OpsDesk spec={DESKS.more} initial={await loadDesk(founder, 'more')} userId={founder.session.userId} />
    </>
  );
}
