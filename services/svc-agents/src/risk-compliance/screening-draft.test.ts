import { describe, expect, it } from 'vitest';
import { parseScreeningList, type ScreeningList } from '@intafaced/config';
import {
  assertProposalOnly,
  draftPresentedAsDecision,
  draftScreeningSupport,
  inventedBlockedTrueList,
  looksLikeClearedAccount,
} from './screening-draft.js';

const listed: ScreeningList = parseScreeningList('ZZ:fixture programme ref', 'test-fixture');

describe('risk-compliance screening drafts', () => {
  it('refuses when screening is unset — not a cleared account', () => {
    const result = draftScreeningSupport({
      subjectId: 'user-1',
      region: 'DE',
      screening: { regions: [], declaration: 'unset', configured: false, source: 'unconfigured' },
    });
    expect(result).toMatchObject({
      status: 'refuse',
      reason: 'screening_unset',
      kind: 'not_a_decision',
      isDecision: false,
      inventedBlockedList: false,
      screeningConfigured: false,
    });
    expect(result).not.toHaveProperty('blocked');
    expect(looksLikeClearedAccount(result)).toBe(false);
    expect(inventedBlockedTrueList(result)).toBe(false);
    assertProposalOnly(result);
  });

  it('refuses reviewed-empty — zero regions is not a green tick', () => {
    const result = draftScreeningSupport({
      subjectId: 'user-1',
      region: 'DE',
      screening: { regions: [], declaration: 'reviewed-empty', configured: true, source: 'counsel-memo-fixture' },
    });
    expect(result.status).toBe('refuse');
    if (result.status !== 'refuse') return;
    expect(result.reason).toBe('screening_empty');
    expect(looksLikeClearedAccount(result)).toBe(false);
  });

  it('refuses when subject or region is missing', () => {
    expect(draftScreeningSupport({ subjectId: 'user-1', screening: listed })).toMatchObject({
      status: 'refuse',
      reason: 'inputs_missing',
    });
    expect(draftScreeningSupport({ region: 'ZZ', screening: listed })).toMatchObject({
      status: 'refuse',
      reason: 'inputs_missing',
    });
    expect(draftScreeningSupport({ screening: listed })).toMatchObject({
      status: 'refuse',
      reason: 'inputs_missing',
    });
  });

  it('refuses when asked to decide or write reviewed_by', () => {
    expect(draftScreeningSupport({ subjectId: 'user-1', region: 'ZZ', screening: listed, asDecision: true })).toMatchObject({
      status: 'refuse',
      reason: 'decision_forbidden',
    });
    expect(draftScreeningSupport({ subjectId: 'user-1', region: 'ZZ', screening: listed, writeReviewedBy: true })).toMatchObject({
      status: 'refuse',
      reason: 'decision_forbidden',
    });
  });

  it('a listed hit is a proposal, never a decision or invented blocked:true list', () => {
    const result = draftScreeningSupport({ subjectId: 'user-1', region: 'ZZ', screening: listed });
    expect(result.status).toBe('draft');
    if (result.status !== 'draft') return;
    expect(result.kind).toBe('proposal');
    expect(result.isDecision).toBe(false);
    expect(result.inventedBlockedList).toBe(false);
    expect(result.listHitCount).toBe(1);
    expect(result.listHits[0]).toMatchObject({ region: 'ZZ', authority: 'screening' });
    expect(result).not.toHaveProperty('blocked');
    expect(result).not.toHaveProperty('cleared');
    expect(result).not.toHaveProperty('reviewed_by');
    assertProposalOnly(result);
  });

  it('a listed miss is still a proposal — not a clearance', () => {
    const result = draftScreeningSupport({ subjectId: 'user-1', region: 'DE', screening: listed });
    expect(result.status).toBe('draft');
    if (result.status !== 'draft') return;
    expect(result.listHitCount).toBe(0);
    expect(result.isDecision).toBe(false);
    expect(looksLikeClearedAccount(result)).toBe(false);
    assertProposalOnly(result);
  });

  it('fails if a draft is presented as a decision', () => {
    const forged = {
      status: 'draft',
      kind: 'decision',
      isDecision: true,
      cleared: true,
    };
    expect(draftPresentedAsDecision(forged)).toBe(true);
    expect(looksLikeClearedAccount(forged)).toBe(true);
    expect(() => assertProposalOnly(forged as never)).toThrow(/presented as a compliance decision/);
  });

  it('fails if empty screening is dressed as allowed/blocked:false', () => {
    const forged = {
      status: 'refuse',
      reason: 'screening_unset',
      screeningConfigured: false,
      screeningDeclaration: 'unset',
      allowed: true,
      blocked: false,
    };
    expect(looksLikeClearedAccount(forged)).toBe(true);
    expect(inventedBlockedTrueList({ blocked: true })).toBe(true);
    expect(inventedBlockedTrueList({ blocked: [{ region: 'XX', blocked: true }] })).toBe(true);
  });

  it('does not invent JURISDICTION_MATRIX blocked:true for a region the shipped matrix does not block', () => {
    const result = draftScreeningSupport({ subjectId: 'user-1', region: 'CA', screening: listed });
    expect(result.status).toBe('draft');
    if (result.status !== 'draft') return;
    expect(result.businessHitCount).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/"blocked"\s*:\s*true/);
  });
});
