import { describe, expect, it } from 'vitest';
import {
  assertProposalOnly,
  envGrowthWarehouse,
  looksLikePublication,
  looksLikeReturnsClaim,
  proposeGrowthCampaign,
} from './campaign-proposal.js';

const live = { configured: true, mayLabelLive: true } as const;

describe('growth campaign proposals — never autonomous publication', () => {
  it('refuses when the warehouse is dark — not a funnel from silence', () => {
    const result = proposeGrowthCampaign({ headline: 'Invite a friend' });
    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'warehouse_dark',
      isPublication: false,
      published: false,
      warehouseConfigured: false,
      warehouseMayLabelLive: false,
    });
    expect(envGrowthWarehouse()).toEqual({ configured: false, mayLabelLive: false });
    assertProposalOnly(result);
  });

  it('refuses a configured warehouse that still may not label cubes live', () => {
    expect(proposeGrowthCampaign({ headline: 'Invite a friend', warehouse: { configured: true, mayLabelLive: false } })).toMatchObject({
      reason: 'warehouse_dark',
    });
  });

  it('refuses autonomous publish even against a live warehouse', () => {
    const result = proposeGrowthCampaign({ headline: 'Invite a friend', publish: true, warehouse: live });
    expect(result).toMatchObject({ status: 'refuse', reason: 'autonomous_publish', published: false });
    expect(looksLikePublication(result)).toBe(false);
  });

  it('refuses returns-ranked / curve-fit / ROI copy', () => {
    expect(looksLikeReturnsClaim('top ROI leaders')).toBe(true);
    expect(proposeGrowthCampaign({ headline: 'returns-ranked board', warehouse: live })).toMatchObject({
      reason: 'returns_claim',
      inventedReturns: false,
    });
    expect(proposeGrowthCampaign({ headline: 'ok', copy: 'curve-fit backtest', warehouse: live })).toMatchObject({
      reason: 'returns_claim',
    });
  });

  it('refuses incentive budgets — owner-only magnitudes', () => {
    expect(proposeGrowthCampaign({ headline: 'Invite a friend', incentiveBudget: '100', warehouse: live })).toMatchObject({
      reason: 'budget_undecided',
      inventedBudget: false,
    });
    expect(proposeGrowthCampaign({ headline: 'Invite a friend', spendAmount: '50', warehouse: live })).toMatchObject({
      reason: 'budget_undecided',
    });
    expect(
      proposeGrowthCampaign({
        headline: 'Invite a friend',
        incentiveBudget: '   ',
        spendAmount: '50',
        warehouse: live,
      }),
    ).toMatchObject({
      reason: 'budget_undecided',
      inventedBudget: false,
    });
  });

  it('a live warehouse yields a proposal, never a publication', () => {
    const result = proposeGrowthCampaign({ headline: 'Invite a friend', warehouse: live });
    expect(result.status).toBe('proposal');
    if (result.status !== 'proposal') return;
    expect(result.kind).toBe('proposal');
    expect(result.isPublication).toBe(false);
    expect(result.published).toBe(false);
    expect(result.headline).toBe('Invite a friend');
    expect(result).not.toHaveProperty('liveAt');
    assertProposalOnly(result);
  });

  it('fails if a proposal is dressed as published / live', () => {
    expect(looksLikePublication({ status: 'published', published: true })).toBe(true);
    expect(looksLikePublication({ status: 'proposal', kind: 'publication', isPublication: true })).toBe(true);
    expect(() =>
      assertProposalOnly({
        status: 'proposal',
        kind: 'publication',
        isPublication: true,
        published: true,
        headline: 'x',
        warehouseConfigured: true,
        warehouseMayLabelLive: true,
        inventedReturns: false,
        inventedBudget: false,
        userMessageKey: 'agents.error.capability_unavailable',
      } as never),
    ).toThrow(/publication/);
  });
});
