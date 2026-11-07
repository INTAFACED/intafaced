import { redirect } from 'next/navigation';
import { requireModulePage } from '@/lib/module-page-guard';
import { UUID } from '@/lib/kyc-review/model';

/** The queue's "Open business application" form lands here and goes on to that merchant's application. */
export const dynamic = 'force-dynamic';

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  requireModulePage('identity-ops');
  const raw = (await searchParams).merchantId;
  const id = typeof raw === 'string' ? raw.trim() : '';
  redirect(UUID.test(id) ? `/identity-ops/kyc/business/${id.toLowerCase()}` : '/identity-ops/kyc');
}
