import {
  founderApprovalQueueSchema,
  founderControlAuditListSchema,
  founderLimitRequestListSchema,
  founderDisputeListSchema,
  founderLiveSummarySchema,
  founderMerchantSectionSchema,
  founderPayoutListSchema,
  founderRecentMerchantsSchema,
  founderRiskSummarySchema,
  payHaltPendingClearListSchema,
} from '@intafaced/contracts';
import { describe, expect, it } from 'vitest';
import { asNotePage } from '@/lib/founder-ops/notes';
import { asTier } from '@/lib/merchants/control-model';
import {
  ALL_SECTIONS,
  approvalsFixture,
  auditFixture,
  limitRequestsFixture,
  tiersFixture,
  disputesFixture,
  liveFixture,
  notesFixture,
  payoutsFixture,
  pendingClearsFixture,
  recentFixture,
  riskFixture,
  sectionFixture,
} from './founder-read-fixtures';

describe('TEST DATA fixtures match the contract', () => {
  it.each(ALL_SECTIONS)('section %s parses with the contract schema', (section) => {
    const parsed = founderMerchantSectionSchema.safeParse(sectionFixture(section));
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    expect(parsed.success && parsed.data.section).toBe(section);
  });
  it.each([
    ['recent merchants', founderRecentMerchantsSchema, recentFixture],
    ['payout list', founderPayoutListSchema, payoutsFixture],
    ['dispute list', founderDisputeListSchema, disputesFixture],
    ['live summary', founderLiveSummarySchema, liveFixture],
    ['risk summary', founderRiskSummarySchema, riskFixture],
    ['pending clears', payHaltPendingClearListSchema, pendingClearsFixture],
    ['founder approvals queue', founderApprovalQueueSchema, approvalsFixture],
    ['limit requests', founderLimitRequestListSchema, limitRequestsFixture],
    ['control audit', founderControlAuditListSchema, auditFixture],
  ] as const)('%s parses with the contract schema', (_name, schema, fixture) => {
    const parsed = schema.safeParse(fixture);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
  });
  it('tiers parse with the console reader and carry a merchant count (shape from the service view)', () => {
    for (const tier of tiersFixture) expect(asTier(tier)?.id).toBe(tier.id);
    expect(asTier(tiersFixture[0])?.merchants).toBe(12);
  });
  it('operator notes parse with the console parser', () => {
    expect(asNotePage(notesFixture)?.items).toHaveLength(2);
  });
  it('money in the fixtures is a decimal string beyond float precision, never a number', () => {
    const page = sectionFixture('payments') as { items: Array<{ amount: unknown }> };
    expect(typeof page.items[0]!.amount).toBe('string');
    expect(page.items[0]!.amount).toBe('9007199254740993.000000000000000001');
  });
});
