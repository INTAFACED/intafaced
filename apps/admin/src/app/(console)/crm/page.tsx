import { requireFounderPage } from '@/lib/founder-page';
import { CrmWorkspace } from '@/components/crm-workspace';

export default async function CrmPage() {
  const { session } = await requireFounderPage();
  return <CrmWorkspace csrf={session.csrf} />;
}
