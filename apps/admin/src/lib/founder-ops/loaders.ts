import 'server-only';
import { isTestData } from '@/components/merchants/test-data-badge';
import { payCall, type PayCallContext, type PayCallResult } from '@/lib/merchants/pay-call';
import {
  loadApprovalQueue,
  type ApprovalQueueData,
  loadDashboard,
  type DashboardData,
  loadTreasury,
  type TreasuryData,
} from '@/lib/merchants/loaders';
import type { FounderScreen } from './screens';

export interface FraudRow {
  id: string;
  merchantId: string;
  paymentId: string | null;
  amount: string;
  assetId: string;
  status: 'open' | 'allowed' | 'declined';
  createdAt: string;
  reasons: { ruleId: string; detail: string }[];
}
export function parseFraud(raw: unknown): FraudRow[] | null {
  if (!Array.isArray(raw) || raw.length > 100) return null;
  const out: FraudRow[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') return null;
    const r = value as Record<string, unknown>;
    if (
      ['id', 'merchantId', 'assetId', 'createdAt'].some((k) => typeof r[k] !== 'string' || !r[k]) ||
      typeof r.amount !== 'string' ||
      !/^\d+(\.\d{1,18})?$/.test(r.amount) ||
      (r.paymentId !== null && typeof r.paymentId !== 'string') ||
      !['open', 'allowed', 'declined'].includes(String(r.status)) ||
      !Number.isFinite(Date.parse(String(r.createdAt))) ||
      !Array.isArray(r.reasons) ||
      !r.reasons.every(
        (v: unknown) =>
          v && typeof v === 'object' && 'ruleId' in v && typeof v.ruleId === 'string' && 'detail' in v && typeof v.detail === 'string',
      )
    )
      return null;
    out.push({
      id: r.id as string,
      merchantId: r.merchantId as string,
      paymentId: r.paymentId,
      amount: r.amount,
      assetId: r.assetId as string,
      status: r.status as FraudRow['status'],
      createdAt: r.createdAt as string,
      reasons: r.reasons as FraudRow['reasons'],
    });
  }
  return out;
}
export interface OpsData {
  readAt: string;
  testData?: boolean;
  userId: string;
  expiresAt: string;
  fraud?: PayCallResult<FraudRow[]>;
  enrolment?: PayCallResult<{ open: boolean }>;
  treasury?: TreasuryData;
  metrics?: DashboardData;
  approvals?: PayCallResult<ApprovalQueueData>;
}
export async function loadOps(ctx: PayCallContext, screen: FounderScreen, merchant?: string, days: 1 | 7 | 30 = 7): Promise<OpsData> {
  const data: OpsData = {
    testData: isTestData(),
    readAt: new Date().toISOString(),
    userId: ctx.session.userId,
    expiresAt: ctx.session.expiresAt,
  };
  if (screen.id === 'F30' || screen.id === 'F31')
    data.fraud = await payCall(
      ctx,
      'fraud.listOpenReviews',
      'GET',
      { limit: 100, ...(merchant ? { merchantId: merchant } : {}) },
      parseFraud,
    );
  if (screen.id === 'F73')
    data.enrolment = await payCall(
      ctx,
      'auth.founderEnrolmentStatus',
      'GET',
      {},
      (raw) => {
        if (!raw || typeof raw !== 'object' || !('open' in raw) || typeof raw.open !== 'boolean') return null;
        return { open: raw.open };
      },
      'identity',
    );
  if (screen.id === 'F02' || screen.id === 'F03' || screen.id === 'F51' || screen.id === 'F61') data.treasury = await loadTreasury(ctx);
  if (screen.id === 'F69' || screen.id === 'F70') data.metrics = await loadDashboard(ctx, new Date(), days);
  if (screen.id === 'F25') data.approvals = await loadApprovalQueue(ctx);
  return data;
}
