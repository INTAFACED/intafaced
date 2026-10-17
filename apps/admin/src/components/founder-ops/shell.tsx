import type { ReactNode } from 'react';
import { TestDataBadge } from '@/components/merchants/test-data-badge';
import { PageFinder } from './navigation';
import './screens.css';
export function FounderOpsShell({ children, showBadge = true }: { children: ReactNode; showBadge?: boolean }) {
  return (
    <div className="mp-page">
      {showBadge ? <TestDataBadge /> : null}
      <nav className="fo-section-links" aria-label="Founder operations">
        <a href="/merchants">Overview</a>
        <a href="/merchants/all">Merchants</a>
        <a href="/merchants/live">Monitor</a>
        <a href="/kyb">KYB</a>
        <a href="/screening">Screening</a>
        <a href="/fraud">Fraud</a>
        <a href="/disputes">Disputes</a>
        <a href="/payments">Payments</a>
        <a href="/payouts">Payouts</a>
        <a href="/conversion/orders">Conversion</a>
        <a href="/audit">Audit</a>
        <a href="/b2b-ramp">B2B</a>
        <a href="/simulator">Simulator</a>
        <a href="/system/users">System</a>
        <PageFinder />
      </nav>
      {children}
    </div>
  );
}
