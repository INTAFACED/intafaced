import { redirect } from 'next/navigation';
import { requireModulePage } from '@/lib/module-page-guard';
import { requireMerchantsFounder } from '@/lib/merchants/page-gate';

export const dynamic = 'force-dynamic';

export default async function RegistriesIndexPage() {
  requireModulePage('merchants');
  await requireMerchantsFounder();
  redirect('/merchants/registries/venues');
}
