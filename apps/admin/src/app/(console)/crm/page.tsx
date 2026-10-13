import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { CrmWorkspace } from '@/components/crm-workspace';

export default async function CrmPage() {
  requireModulePage('crm');
  const { session } = await requireFounderPage();
  return <CrmWorkspace csrf={session.csrf} />;
}
