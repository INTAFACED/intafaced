import type { ReactNode } from 'react';
import { requireModulePage } from '@/lib/module-page-guard';
import './trade-ops.css';

/** The desk uses the shared UI kit (Tailwind), scoped to `.if-app` so the older console pages keep their own look. */
export default function TradeOpsLayout({ children }: { children: ReactNode }) {
  requireModulePage('tradeops');
  return <div className="if-app min-h-[calc(100vh-64px)] bg-bg text-fg">{children}</div>;
}
