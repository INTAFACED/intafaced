import Link from 'next/link';
import { isModuleId } from '@intafaced/config/modules';
import { SERVICE_NOT_FOUND } from '@intafaced/contracts/ops-console-services';
import { ServicePage } from '@/components/service-page';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { loadServicePage } from '@/lib/service-page/server';

/**
 * One module's service page (`/health/:module`, OPS-service-health-01), read as the signed-in founder when the page opens.
 * A name the module registry does not know gets a typed refusal, not a page.
 */
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ module: string }> }) {
  requireModulePage('killswitches');
  const founder = await requireFounderPage();
  const { module } = await params;
  if (!isModuleId(module))
    return (
      <div className="adm-callout" data-tone="danger" role="alert" data-testid="service-not-found">
        <strong>That is not a platform module</strong>
        <p>
          No module is called “{module.slice(0, 40)}”, so it has no service page. Code: {SERVICE_NOT_FOUND}
        </p>
        <p>
          <Link href="/health">Back to module health</Link>
        </p>
      </div>
    );
  return <ServicePage view={await loadServicePage(founder, module, new Date())} />;
}
