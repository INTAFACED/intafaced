import { describe, expect, it } from 'vitest';
import { ifcFixture } from '../../../preview/fixtures/ifc';

const decimal = /^-?\d+(\.\d+)?$/;
const { balance, stakeOptions, tiers, proposals, notPromises, mining } = ifcFixture.rows;

describe('ifc fixture', () => {
  it('is sample data for ifc, with a plain note', () => {
    expect(ifcFixture.product).toBe('ifc');
    expect(ifcFixture.sample).toBe(true);
    expect(ifcFixture.note.length).toBeGreaterThan(10);
  });

  it('keeps every amount a decimal string', () => {
    for (const value of Object.values(balance)) expect(value).toMatch(decimal);
    for (const option of stakeOptions) expect(option.sampleRewardPer1000).toMatch(decimal);
    for (const tier of tiers) {
      expect(tier.hold).toMatch(decimal);
      expect(tier.discountPct).toMatch(/^\d+$/);
    }
  });

  it('has tiers that rise in both holding and discount', () => {
    const holds = tiers.map((t) => BigInt(t.hold));
    const discounts = tiers.map((t) => BigInt(t.discountPct));
    expect(holds).toEqual([...holds].sort((a, b) => (a < b ? -1 : 1)));
    expect(discounts).toEqual([...discounts].sort((a, b) => (a < b ? -1 : 1)));
    expect(tiers[0]!.hold).toBe('0');
  });

  it('has proposals in every state, and votes that add up to 100', () => {
    for (const status of ['voting', 'passed', 'rejected', 'draft'] as const) expect(proposals.some((p) => p.status === status)).toBe(true);
    for (const proposal of proposals) {
      if (proposal.forPct === null || proposal.againstPct === null) expect(proposal.status).toBe('draft');
      else expect(Number(proposal.forPct) + Number(proposal.againstPct)).toBe(100);
    }
  });

  it('states no price, yield, buyback or burn as fact (claims register C1 to C4)', () => {
    const text = JSON.stringify(ifcFixture.rows);
    expect(text).not.toMatch(/\bAPY\b|\bAPR\b|real yield|revenue share|burn|halving|emission|TGE|listing|upside|holders/i);
    expect(text).not.toMatch(/H200|B200|GPU/i);
    expect(notPromises.some((line) => /not a promise|not promise/i.test(line))).toBe(true);
    expect(notPromises.some((line) => /buyback/i.test(line) && /not a promise/i.test(line))).toBe(true);
    // The only reward figures are labelled samples, never a dollar value.
    expect(text).not.toMatch(/\$/);
  });

  it('shows mining as in build, with no numbers', () => {
    expect(mining.detail).toMatch(/in build/i);
    expect(mining.detail).not.toMatch(/\d/);
  });
});
