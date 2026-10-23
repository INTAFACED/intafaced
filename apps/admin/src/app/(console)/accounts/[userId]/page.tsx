import { notFound } from 'next/navigation';
import { CustomerRecord } from '@/components/customer-record';
import { customerId, customerTab, tabPlan } from '@/lib/customer-record/record';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';
import { loadReads } from '@/lib/ops-desk/server';

/**
 * One customer's record (`/accounts/:userId`). Only the open tab is read, as the signed-in founder, when the page opens: each
 * service logs who read which account, so a tab nobody opened is not read. A refresh is a new read; nothing is cached.
 */
export default async function CustomerRecordPage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  requireModulePage('accounts');
  const founder = await requireFounderPage();
  const userId = customerId((await params).userId);
  const tab = customerTab((await searchParams).tab);
  if (userId === null || tab === null) notFound();
  const plan = tabPlan(tab, userId);
  const outcomes = await loadReads(founder, plan.reads);
  return (
    <CustomerRecord
      userId={userId}
      founderId={founder.session.userId}
      tab={tab}
      reads={plan.reads}
      outcomes={outcomes}
      unwired={plan.unwired}
    />
  );
}
