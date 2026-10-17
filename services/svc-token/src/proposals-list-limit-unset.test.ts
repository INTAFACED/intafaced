import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TokenError, assertProposalListLimit } from './token-service.js';
import { userCopy } from './user-copy.js';

/**
 * listProposals page size is refuse-closed when unset.
 *
 * listProposals used `input.limit ?? 50`, so omit invented a 50-row governance
 * page. Blank must refuse. Owner/client may pass 50 explicitly.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('listProposals limit unset refuse', () => {
  it('assertProposalListLimit refuses blank / NaN / 0 — never invents 50', () => {
    expect(() => assertProposalListLimit(undefined)).toThrow(TokenError);
    expect(() => assertProposalListLimit(Number.NaN)).toThrow(TokenError);
    expect(() => assertProposalListLimit(0)).toThrow(TokenError);
    try {
      assertProposalListLimit(undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(TokenError);
      expect((e as TokenError).code).toBe('token.proposal_list_limit_unset');
      expect((e as TokenError).message).toBe('Proposal list limit is unset');
      expect((e as TokenError).message).not.toMatch(/50-row|default 50/i);
      expect(userCopy((e as TokenError).code)).toBe('The proposal list size is not set.');
      expect(userCopy((e as TokenError).code)).not.toMatch(/50/);
    }
  });

  it('accepts owner-published 50 and caps at 200', () => {
    expect(assertProposalListLimit(50)).toBe(50);
    expect(assertProposalListLimit(1)).toBe(1);
    expect(assertProposalListLimit(200)).toBe(200);
    expect(assertProposalListLimit(201)).toBe(200);
  });

  it('listProposals no longer defaults limit to 50', () => {
    const src = readFileSync(join(ROOT, 'services/svc-token/src/token-service.ts'), 'utf8');
    const start = src.indexOf('async listProposals(');
    const end = src.indexOf('async getProposal(', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('assertProposalListLimit');
    expect(fn).not.toMatch(/input\.limit \?\? 50/);
    expect(fn).not.toMatch(/\?\? 50/);
  });

  it('router does not invent 50 when listProposals omits limit', () => {
    const src = readFileSync(join(ROOT, 'services/svc-token/src/router.ts'), 'utf8');
    const start = src.indexOf('listProposals:');
    const end = src.indexOf('getProposal:', start);
    const fn = src.slice(start, end === -1 ? undefined : end);
    expect(fn).toContain('token.listProposals(input)');
    expect(fn).not.toMatch(/input\.limit \?\? 50/);
    expect(fn).not.toMatch(/\?\? 50/);
  });
});
