import 'server-only';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { partFrom, type Part } from '@/lib/desk/part';

/**
 * The card fraud risk preview (BK-cops-09, J-bank-12 #5): svc-bank `ops.fraudPreview`, TEST rows only. No fraud engine
 * exists, so nothing here scores or decides a real authorisation.
 */
export interface FraudPreview {
  readonly label: string;
  readonly engine: string;
  readonly blurred: boolean;
  readonly stances: readonly string[];
  readonly automaticBlocking: string;
  readonly rows: readonly { testAuthorisationRef: string; test: boolean; band: string; signals: readonly string[] }[];
}

export function parseFraudPreview(raw: unknown): FraudPreview | null {
  const v = raw as Partial<FraudPreview> | null;
  if (!v || v.label !== 'Preview · sample data' || typeof v.engine !== 'string' || v.blurred !== true) return null;
  if (!Array.isArray(v.stances) || !Array.isArray(v.rows) || typeof v.automaticBlocking !== 'string') return null;
  for (const r of v.rows) {
    if (typeof r?.testAuthorisationRef !== 'string' || r.test !== true || typeof r.band !== 'string' || !Array.isArray(r.signals))
      return null;
  }
  return v as FraudPreview;
}

export async function readFraudPreview(ctx: FounderCallContext): Promise<Part<FraudPreview>> {
  const result = await founderCall(ctx, 'bank', 'ops.fraudPreview', 'GET', undefined, parseFraudPreview);
  return partFrom(result, (d) => d, {
    service: 'svc-bank',
    forbiddenMessage: 'svc-bank did not accept this founder session for the fraud preview. Reading needs admin:read.',
  });
}
