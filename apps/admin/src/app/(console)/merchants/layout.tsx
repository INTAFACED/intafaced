import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { MerchantsSubnav } from '@/components/merchants/merchants-subnav';
import '@/components/merchants/merchants.css';
import { requireFounderPage } from '@/lib/founder-page';
import { requireModulePage } from '@/lib/module-page-guard';

export const metadata: Metadata = { title: 'Merchants · INTAFACED Operator Console' };

export default async function MerchantsLayout({ children }: { children: ReactNode }) {
  requireModulePage('merchants');
  await requireFounderPage();
  return (
    <div className="mp-page">
      <MerchantsSubnav />
      {children}
    </div>
  );
}
