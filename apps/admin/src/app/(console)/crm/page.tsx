import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { CrmApp } from '@/components/crm2/crm-app';
import { parseCrmUrl } from '@/components/crm2/url-state';

export default async function CrmPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  requireModulePage('crm');
  const { session } = await requireFounderPage();
  const params = await searchParams;
  const search = new URLSearchParams(
    Object.entries(params).flatMap(([key, value]) => (typeof value === 'string' ? [[key, value] as [string, string]] : [])),
  );
  return <CrmApp csrf={session.csrf} userId={session.userId} initial={parseCrmUrl(search.toString())} />;
}
