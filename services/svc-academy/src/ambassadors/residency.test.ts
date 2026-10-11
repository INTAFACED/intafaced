import { describe, expect, it } from 'vitest';
import { MemoryResidencyDesk, ResidencyError } from './residency.js';
import { ambassadorPayLooksPayable, decidePublicResidencyPayQuote } from './ifc-pay.js';
import { UNPUBLISHED_AMBASSADOR_IFC_PAY_LAW } from './ifc-pay-rate-law.js';

const NOW = new Date('2026-08-05T12:00:00.000Z');

describe('ambassador Stage-2 residency (no pay)', () => {
  it('apply → accept; second open application refused', () => {
    const desk = new MemoryResidencyDesk();
    const a = desk.apply({
      userId: 'u1',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    expect(a.status).toBe('applied');
    expect(() =>
      desk.apply({
        userId: 'u1',
        cohortSlug: 'bali-2026',
        statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
        now: NOW,
      }),
    ).toThrow(ResidencyError);
    const decided = desk.decide({ id: a.id, operatorId: 'op1', decision: 'accepted', note: 'strong host', now: NOW });
    expect(decided.status).toBe('accepted');
    expect(decided.decidedBy).toBe('op1');
  });

  it('decide requires a non-blank operator id and stores it trimmed with its case', () => {
    const desk = new MemoryResidencyDesk();
    const statement = 'I host weekly risk-first lobbies and can commit six hours a week.';
    const applied = desk.apply({
      userId: 'u1',
      cohortSlug: 'bali-2026',
      statement,
      now: NOW,
    });

    for (const operatorId of ['', ' ', '   ', '\t', '\n', ' \t\n ']) {
      for (const decision of ['accepted', 'rejected'] as const) {
        expect(() => desk.decide({ id: applied.id, operatorId, decision, now: NOW })).toThrow(
          expect.objectContaining({ name: 'ResidencyError', code: 'academy.residency_invalid' }),
        );
      }
      const still = desk.listByUser('u1').find((row) => row.id === applied.id);
      expect(still).toMatchObject({ status: 'applied', decidedBy: null, decidedAt: null, decisionNote: null });
    }

    const accepted = desk.decide({
      id: applied.id,
      operatorId: '  OpMix  ',
      decision: 'accepted',
      note: 'strong host',
      now: NOW,
    });
    expect(accepted.status).toBe('accepted');
    expect(accepted.decidedBy).toBe('OpMix');

    const pending = desk.apply({
      userId: 'u2',
      cohortSlug: 'bali-2026',
      statement,
      now: NOW,
    });
    const rejected = desk.decide({
      id: pending.id,
      operatorId: '  ReJectOp  ',
      decision: 'rejected',
      now: NOW,
    });
    expect(rejected.status).toBe('rejected');
    expect(rejected.decidedBy).toBe('ReJectOp');

    expect(() => desk.decide({ id: accepted.id, operatorId: 'OpMix', decision: 'rejected', now: NOW })).toThrow(
      expect.objectContaining({ name: 'ResidencyError', code: 'academy.residency_not_pending' }),
    );
    expect(desk.listByUser('u1').find((row) => row.id === accepted.id)?.decidedBy).toBe('OpMix');
  });

  it('short statement refused', () => {
    const desk = new MemoryResidencyDesk();
    expect(() => desk.apply({ userId: 'u1', cohortSlug: 'xx', statement: 'hi' })).toThrow(ResidencyError);
  });

  it('withdraw while applied; listAccepted after accept', () => {
    const desk = new MemoryResidencyDesk();
    const a = desk.apply({
      userId: 'u1',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
    });
    const w = desk.withdraw({ id: a.id, userId: 'u1' });
    expect(w.status).toBe('withdrawn');
    const b = desk.apply({
      userId: 'u2',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
    });
    desk.decide({ id: b.id, operatorId: 'op', decision: 'accepted' });
    expect(desk.listAccepted('bali-2026')).toHaveLength(1);
  });

  it('L3 cohortSummary counts by status without invent', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.cohortSummary('empty-2026').total).toBe(0);
    const a = desk.apply({
      userId: 'u1',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
    });
    desk.decide({ id: a.id, operatorId: 'op', decision: 'accepted' });
    desk.apply({
      userId: 'u2',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
    });
    const s = desk.cohortSummary('bali-2026');
    expect(s).toMatchObject({ accepted: 1, applied: 1, total: 2, rejected: 0, withdrawn: 0 });
  });

  it('L3 openForUser lists only applied — never invent accept', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.openForUser('u1')).toEqual([]);
    const a = desk.apply({
      userId: 'u1',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
    });
    expect(desk.openForUser('u1').map((r) => r.id)).toEqual([a.id]);
    desk.decide({ id: a.id, operatorId: 'op', decision: 'accepted' });
    expect(desk.openForUser('u1')).toEqual([]);
  });

  it('L3 knownCohortSlugs + openCount without invent cohorts', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.knownCohortSlugs()).toEqual([]);
    expect(desk.openCount()).toBe(0);
    desk.apply({
      userId: 'u1',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
    });
    desk.apply({
      userId: 'u2',
      cohortSlug: 'lisbon-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
    });
    expect(desk.knownCohortSlugs()).toEqual(['bali-2026', 'lisbon-2026']);
    expect(desk.openCount()).toBe(2);
  });

  it('L3 acceptedCount + openApplicationIds without invent', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.acceptedCount()).toBe(0);
    expect(desk.openApplicationIds()).toEqual([]);
    const a = desk.apply({
      userId: 'u1',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
    });
    expect(desk.openApplicationIds()).toEqual([a.id]);
    desk.decide({ id: a.id, operatorId: 'op', decision: 'accepted' });
    expect(desk.acceptedCount()).toBe(1);
    expect(desk.openApplicationIds()).toEqual([]);
  });

  it('L3 rejectedCount + withdrawnCount without invent', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.rejectedCount()).toBe(0);
    expect(desk.withdrawnCount()).toBe(0);
    const a = desk.apply({
      userId: 'u1',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
    });
    desk.decide({ id: a.id, operatorId: 'op', decision: 'rejected' });
    expect(desk.rejectedCount()).toBe(1);
    const b = desk.apply({
      userId: 'u2',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
    });
    desk.withdraw({ id: b.id, userId: 'u2' });
    expect(desk.withdrawnCount()).toBe(1);
  });

  it('L3 rejectedApplicationIds sorted without invent', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.rejectedApplicationIds()).toEqual([]);
    const a = desk.apply({
      userId: 'u1',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
    });
    desk.decide({ id: a.id, operatorId: 'op', decision: 'rejected' });
    expect(desk.rejectedApplicationIds()).toEqual([a.id]);
  });
  it('L3 acceptedApplicationIds without invent', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.acceptedApplicationIds()).toEqual([]);
    const a = desk.apply({
      userId: 'u1',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
    });
    desk.decide({ id: a.id, operatorId: 'op', decision: 'accepted' });
    expect(desk.acceptedApplicationIds()).toEqual([a.id]);
  });

  it('L3 withdrawnApplicationIds without invent', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.withdrawnApplicationIds()).toEqual([]);
    const a = desk.apply({
      userId: 'u1',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
    });
    desk.withdraw({ id: a.id, userId: 'u1' });
    expect(desk.withdrawnApplicationIds()).toEqual([a.id]);
  });

  it('L3 applicationCount without invent', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.applicationCount()).toBe(0);
    desk.apply({
      userId: 'u1',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
    });
    expect(desk.applicationCount()).toBe(1);
  });

  it('L3 hasOpenApplication without invent', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.hasOpenApplication('u1')).toBe(false);
    desk.apply({
      userId: 'u1',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
    });
    expect(desk.hasOpenApplication('u1')).toBe(true);
  });

  it('L3 openApplicationCount without invent', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.openApplicationCount('u1')).toBe(0);
    desk.apply({
      userId: 'u1',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
    });
    expect(desk.openApplicationCount('u1')).toBe(1);
  });

  it('L3 rejectedApplicationCount aliases rejectedCount', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.rejectedApplicationCount()).toBe(0);
  });

  it('L3 acceptedApplicationCount aliases acceptedCount', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.acceptedApplicationCount()).toBe(0);
  });

  it('L3 withdrawnApplicationCount aliases withdrawnCount', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.withdrawnApplicationCount()).toBe(0);
  });

  it('L3 wave25 applied count/ids + open ratio + hasAny', () => {
    const desk = new MemoryResidencyDesk();
    const u = 'u-wave25';
    expect(desk.appliedApplicationCount()).toBe(0);
    expect(desk.appliedApplicationIds()).toEqual([]);
    expect(desk.openApplicationRatio()).toBeNull();
    expect(desk.hasAnyApplication()).toBe(false);
    const app = desk.apply({
      userId: u,
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    expect(desk.appliedApplicationCount()).toBe(1);
    expect(desk.appliedApplicationIds()).toEqual([app.id]);
    expect(desk.openApplicationRatio()).toBe('1.0000');
    expect(desk.hasAnyApplication()).toBe(true);
  });

  it('L3 wave26 open empty + accept/reject ratios + cohorts sorted', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.hasNoOpenApplications()).toBe(true);
    expect(desk.acceptedApplicationRatio()).toBeNull();
    expect(desk.rejectedApplicationRatio()).toBeNull();
    expect(desk.knownCohortSlugsSorted()).toEqual([]);
    const a = desk.apply({
      userId: 'u-w26',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    expect(desk.hasNoOpenApplications()).toBe(false);
    desk.decide({ id: a.id, operatorId: 'op1', decision: 'accepted', now: NOW });
    expect(desk.acceptedApplicationRatio()).toBe('1.0000');
    expect(desk.rejectedApplicationRatio()).toBe('0.0000');
    expect(desk.knownCohortSlugsSorted()).toEqual(['bali-2026']);
  });

  it('L3 wave27 accepted/rejected flags + withdrawn ratio + decided count', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.hasAcceptedApplication()).toBe(false);
    expect(desk.hasRejectedApplication()).toBe(false);
    expect(desk.withdrawnApplicationRatio()).toBeNull();
    expect(desk.decidedApplicationCount()).toBe(0);
    const a = desk.apply({
      userId: 'u-w27',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    desk.decide({ id: a.id, operatorId: 'op1', decision: 'accepted', now: NOW });
    expect(desk.hasAcceptedApplication()).toBe(true);
    expect(desk.decidedApplicationCount()).toBe(1);
    expect(desk.withdrawnApplicationRatio()).toBe('0.0000');
  });

  it('L3 wave28 withdrawn flag + decided ratio + all open + first open', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.hasWithdrawnApplication()).toBe(false);
    expect(desk.decidedApplicationRatio()).toBeNull();
    expect(desk.isAllOpen()).toBe(false);
    expect(desk.firstOpenApplicationId()).toBeNull();
    const a = desk.apply({
      userId: 'u-w28',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    expect(desk.isAllOpen()).toBe(true);
    expect(desk.firstOpenApplicationId()).toBe(a.id);
    desk.withdraw({ id: a.id, userId: 'u-w28' });
    expect(desk.hasWithdrawnApplication()).toBe(true);
    expect(desk.decidedApplicationRatio()).toBe('1.0000');
  });

  it('L3 wave29 all decided + first accepted/rejected + cohort count', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.isAllDecided()).toBe(false);
    expect(desk.firstAcceptedApplicationId()).toBeNull();
    expect(desk.firstRejectedApplicationId()).toBeNull();
    expect(desk.cohortCount()).toBe(0);
    const a = desk.apply({
      userId: 'u-w29a',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    const b = desk.apply({
      userId: 'u-w29b',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    desk.decide({ id: a.id, operatorId: 'op1', decision: 'accepted', now: NOW });
    desk.decide({ id: b.id, operatorId: 'op1', decision: 'rejected', now: NOW });
    expect(desk.isAllDecided()).toBe(true);
    expect(desk.firstAcceptedApplicationId()).toBe(a.id);
    expect(desk.firstRejectedApplicationId()).toBe(b.id);
    expect(desk.cohortCount()).toBe(1);
  });

  it('L3 wave30 last open/accepted + at-least + open-minus-decided', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.lastOpenApplicationId()).toBeNull();
    expect(desk.lastAcceptedApplicationId()).toBeNull();
    expect(desk.hasAtLeastApplications(1)).toBe(false);
    expect(desk.openMinusDecided()).toBe(0);
    const a = desk.apply({
      userId: 'u-w30a',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    const b = desk.apply({
      userId: 'u-w30b',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    expect(desk.hasAtLeastApplications(2)).toBe(true);
    expect(desk.openMinusDecided()).toBe(2);
    expect(desk.lastOpenApplicationId()).toBe(b.id);
    desk.decide({ id: a.id, operatorId: 'op1', decision: 'accepted', now: NOW });
    expect(desk.lastAcceptedApplicationId()).toBe(a.id);
    expect(desk.openMinusDecided()).toBe(0);
  });

  it('L3 wave31 labels + majority open + joined open ids', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.applicationCountLabel()).toBe('0');
    expect(desk.openCountLabel()).toBe('0');
    expect(desk.isMajorityOpenOrTie()).toBe(false);
    expect(desk.openApplicationIdsJoined()).toBe('');
    const a = desk.apply({
      userId: 'u-w31',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    expect(desk.applicationCountLabel()).toBe('1');
    expect(desk.openCountLabel()).toBe('1');
    expect(desk.isMajorityOpenOrTie()).toBe(true);
    expect(desk.openApplicationIdsJoined()).toBe(a.id);
  });

  it('L3 wave32 status id joins + cohorts join', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.acceptedApplicationIdsJoined()).toBe('');
    expect(desk.rejectedApplicationIdsJoined()).toBe('');
    expect(desk.withdrawnApplicationIdsJoined()).toBe('');
    expect(desk.knownCohortsJoined()).toBe('');
    const a = desk.apply({
      userId: 'u-w32a',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    const b = desk.apply({
      userId: 'u-w32b',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    desk.decide({ id: a.id, operatorId: 'op1', decision: 'accepted', now: NOW });
    desk.decide({ id: b.id, operatorId: 'op1', decision: 'rejected', now: NOW });
    expect(desk.acceptedApplicationIdsJoined()).toBe(a.id);
    expect(desk.rejectedApplicationIdsJoined()).toBe(b.id);
    expect(desk.knownCohortsJoined()).toBe('bali-2026');
  });

  it('L3 wave33 residency ratio labels', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.openApplicationRatioLabel()).toBe('');
    expect(desk.acceptedApplicationRatioLabel()).toBe('');
    expect(desk.rejectedApplicationRatioLabel()).toBe('');
    expect(desk.withdrawnApplicationRatioLabel()).toBe('');
    const a = desk.apply({
      userId: 'u-w33',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    expect(desk.openApplicationRatioLabel()).toBe('1.0000');
    desk.decide({ id: a.id, operatorId: 'op1', decision: 'accepted', now: NOW });
    expect(desk.acceptedApplicationRatioLabel()).toBe('1.0000');
    expect(desk.openApplicationRatioLabel()).toBe('0.0000');
  });

  it('L3 wave34 status snapshot + share percent', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.applicationStatusSnapshot().total).toBe(0);
    expect(desk.applicationCountsConsistent()).toBe(true);
    expect(desk.openSharePercent()).toBeNull();
    const a = desk.apply({
      userId: 'u-w34',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    expect(desk.openSharePercent()).toBe(100);
    desk.decide({ id: a.id, operatorId: 'op1', decision: 'accepted', now: NOW });
    expect(desk.applicationCountsConsistent()).toBe(true);
    expect(desk.decidedSharePercent()).toBe(100);
  });

  it('L3 wave36 residency queue headline + status of', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.residencyQueueHeadline().empty).toBe(true);
    expect(desk.applicationStatusOf('x')).toBeNull();
    const a = desk.apply({
      userId: 'u-w36',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    expect(desk.residencyQueueHeadline().open).toBe(1);
    expect(desk.isApplicationOpen(a.id)).toBe(true);
    expect(desk.isApplicationDecided(a.id)).toBe(false);
    desk.decide({ id: a.id, operatorId: 'op1', decision: 'accepted', now: NOW });
    expect(desk.isApplicationDecided(a.id)).toBe(true);
    expect(desk.applicationStatusOf(a.id)).toBe('accepted');
  });

  it('L3 wave37 filter/search apps + cohort open count', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.filterApplicationIdsByStatus('applied')).toEqual([]);
    expect(desk.searchApplicationIds('')).toEqual([]);
    expect(desk.openCountForCohort('bali-2026')).toBe(0);
    const a = desk.apply({
      userId: 'u-w37',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    expect(desk.filterApplicationIdsByStatus('applied')).toEqual([a.id]);
    expect(desk.listApplicationIdsForCohort('bali-2026')).toEqual([a.id]);
    expect(desk.openCountForCohort('bali-2026')).toBe(1);
    expect(desk.searchApplicationIds('res-')).toContain(a.id);
  });

  it('L3 wave38 page application ids + open queue pages', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.pageOpenApplicationIds({ limit: 5 })).toEqual([]);
    expect(desk.openQueuePageCount(5)).toBe(0);
    const a = desk.apply({
      userId: 'u-w38a',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    const b = desk.apply({
      userId: 'u-w38b',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    expect(desk.pageOpenApplicationIds({ offset: 0, limit: 1 })).toHaveLength(1);
    expect(desk.pageAllApplicationIds({ limit: 10 })).toHaveLength(2);
    desk.decide({ id: a.id, operatorId: 'op1', decision: 'accepted', now: NOW });
    expect(desk.pageAcceptedApplicationIds({ limit: 10 })).toEqual([a.id]);
    expect(desk.openQueuePageCount(1)).toBe(1);
  });

  it('L3 wave39 application/cohort diffs', () => {
    const desk = new MemoryResidencyDesk();
    const a = desk.apply({
      userId: 'u-w39',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    expect(desk.applicationIdsOnlyHere([])).toEqual([a.id]);
    expect(desk.openIdsOnlyHere([])).toEqual([a.id]);
    expect(desk.openCountEquals(1)).toBe(true);
    expect(desk.cohortsOnlyHere([])).toEqual(['bali-2026']);
  });

  it('L3 wave40 safe open queue paging', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.safePageOpenApplicationIds(0, 1)).toEqual([]);
    expect(desk.isValidOpenQueuePage(0, 1)).toBe(false);
    desk.apply({
      userId: 'u-w40a',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    desk.apply({
      userId: 'u-w40b',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    expect(desk.safePageOpenApplicationIds(0, 1)).toHaveLength(1);
    expect(desk.clampOpenQueuePageIndex(99, 1)).toBe(1);
    expect(desk.openApplicationIdsAtPage(1, 1)).toHaveLength(1);
    expect(desk.isValidOpenQueuePage(0, 1)).toBe(true);
  });

  it('L3 wave41 residency export', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.residencyExportLines()).toEqual([]);
    expect(desk.residencyExportHeader()).toBe('id,status,cohortSlug');
    const a = desk.apply({
      userId: 'u-w41',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    expect(desk.residencyExportLines()[0]).toContain(a.id);
    expect(desk.residencyExportLineCount()).toBe(2);
    expect(desk.residencyExportText()).toContain('bali-2026');
  });

  it('L3 wave42 residency export parse + round-trip', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.parseResidencyExportLine('id,status,cohortSlug')).toBeNull();
    expect(desk.residencyExportRoundTripOk()).toBe(true);
    const a = desk.apply({
      userId: 'u-w42',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    expect(desk.parseResidencyExportLine(`${a.id},applied,bali-2026`)).toEqual({
      id: a.id,
      status: 'applied',
      cohortSlug: 'bali-2026',
    });
    expect(desk.countResidencyExportDataLines(desk.residencyExportText())).toBe(1);
    expect(desk.residencyExportHasHeader(desk.residencyExportText())).toBe(true);
  });

  it('L3 wave44 residency status lines', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.residencyStatusLineIsEmpty()).toBe(true);
    desk.apply({
      userId: 'u-w44',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    expect(desk.residencyStatusLine()).toContain('open=1');
    expect(desk.residencyStatusLineDetailed()).toContain('accepted=0');
    expect(desk.residencyStatusLineTokenCount()).toBe(5);
  });

  it('L3 wave45 residency status parse + match', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.parseResidencyStatusLine('open=0 decided=0 total=0')).toEqual({ open: 0, decided: 0, total: 0 });
    expect(desk.residencyStatusLineMatchesStore()).toBe(true);
    desk.apply({
      userId: 'u-w45',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    expect(desk.residencyStatusLineMatchesStore()).toBe(true);
    expect(desk.residencyStatusLineDetailedConsistent(desk.residencyStatusLineDetailed())).toBe(true);
  });

  it('L3 wave46 residency thresholds + clamps', () => {
    const desk = new MemoryResidencyDesk();
    expect(desk.openCountInRange(0, 0)).toBe(true);
    expect(desk.openShareAtLeast(1)).toBe(false);
    expect(desk.clampOpenQueuePageSize(5)).toBe(1);
    desk.apply({
      userId: 'u-w46',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    expect(desk.openCountInRange(1, 1)).toBe(true);
    expect(desk.openShareAtLeast(100)).toBe(true);
    expect(desk.clampOpenQueuePageSize(99)).toBe(1);
    expect(desk.applicationDensityExceeds(0)).toBe(true);
  });

  it('accepted residency is not payable while IFC rate authority is unset', () => {
    const desk = new MemoryResidencyDesk();
    const a = desk.apply({
      userId: 'u-pay',
      cohortSlug: 'bali-2026',
      statement: 'I host weekly risk-first lobbies and can commit six hours a week.',
      now: NOW,
    });
    desk.decide({ id: a.id, operatorId: 'op', decision: 'accepted', now: NOW });
    expect(desk.listAccepted('bali-2026')).toHaveLength(1);
    const quote = decidePublicResidencyPayQuote({
      law: UNPUBLISHED_AMBASSADOR_IFC_PAY_LAW,
      residencyStatus: 'accepted',
    });
    expect(quote.status).toBe('refuse');
    expect(quote.code).toBe('academy.ambassador_pay.rates_unset');
    expect(ambassadorPayLooksPayable(quote)).toBe(false);
  });
});
