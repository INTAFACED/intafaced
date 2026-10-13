import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  copyLawResidual,
  copyLawStatusLine,
  parseCopyFeeShareLawJson,
  parseCopyJurisdictionLawJson,
  requirePublishedCopyFeeShareLaw,
  requirePublishedCopyJurisdictionLaw,
  UNPUBLISHED_COPY_FEE_SHARE_LAW,
  UNPUBLISHED_COPY_JURISDICTION_LAW,
} from './fee-share-law.js';
import { COPY_FEE_SHARE_RESIDUAL, COPY_JURISDICTION_RESIDUAL, COPY_LAW_RESIDUAL, CopyError } from './errors.js';

const COPY_DIR = dirname(fileURLToPath(import.meta.url));

function stripTsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('parseCopyFeeShareLawJson', () => {
  it('empty → unpublished (refuse-closed default)', () => {
    expect(parseCopyFeeShareLawJson('')).toEqual(UNPUBLISHED_COPY_FEE_SHARE_LAW);
    expect(parseCopyFeeShareLawJson(null)).toEqual(UNPUBLISHED_COPY_FEE_SHARE_LAW);
    expect(parseCopyFeeShareLawJson('  ')).toEqual(UNPUBLISHED_COPY_FEE_SHARE_LAW);
  });

  it('published false → unpublished', () => {
    expect(parseCopyFeeShareLawJson('{"published":false}')).toEqual(UNPUBLISHED_COPY_FEE_SHARE_LAW);
  });

  it('published true with owner numbers', () => {
    const law = parseCopyFeeShareLawJson(
      JSON.stringify({
        published: true,
        leaderShareBps: 2_500,
        earningsCapPerFollower: '100',
        decayRoundTrips: 10,
        decayShareBps: 500,
      }),
    );
    expect(law.published).toBe(true);
    if (law.published) {
      expect(law.leaderShareBps).toBe(2_500);
      expect(law.earningsCapPerFollower).toBe('100');
      expect(law.decayRoundTrips).toBe(10);
      expect(law.decayShareBps).toBe(500);
    }
  });

  it('refuses an unparsable or negative earnings cap before publish', () => {
    const base = { published: true, leaderShareBps: 2_500, decayRoundTrips: 10, decayShareBps: 500 };
    for (const earningsCapPerFollower of ['12.34.56', '-1']) {
      try {
        parseCopyFeeShareLawJson(JSON.stringify({ ...base, earningsCapPerFollower }));
        expect.unreachable(`should refuse earningsCapPerFollower=${earningsCapPerFollower}`);
      } catch (err) {
        expect(err).toBeInstanceOf(CopyError);
        expect((err as CopyError).code).toBe('trade.copy_fee_share_blank');
        expect((err as CopyError).residual).toBe(COPY_FEE_SHARE_RESIDUAL);
      }
    }
  });

  it('publishes a positive decimal cap as the owner string', () => {
    const law = parseCopyFeeShareLawJson(
      JSON.stringify({
        published: true,
        leaderShareBps: 2_500,
        earningsCapPerFollower: '10.5',
        decayRoundTrips: 10,
        decayShareBps: 500,
      }),
    );
    expect(law.published).toBe(true);
    if (law.published) {
      expect(law.earningsCapPerFollower).toBe('10.5');
      expect(typeof law.earningsCapPerFollower).toBe('string');
    }
  });

  it('publishes the shipped earnings cap with its owner decimals', () => {
    const law = parseCopyFeeShareLawJson(
      JSON.stringify({
        published: true,
        leaderShareBps: 1000,
        earningsCapPerFollower: '1000.00',
        decayRoundTrips: 50,
        decayShareBps: 5000,
      }),
    );
    expect(law.published).toBe(true);
    if (law.published) {
      expect(law.earningsCapPerFollower).toBe('1000.00');
      expect(typeof law.earningsCapPerFollower).toBe('string');
    }
  });

  it('refuses invent — missing leaderShareBps', () => {
    expect(() => parseCopyFeeShareLawJson(JSON.stringify({ published: true, earningsCapPerFollower: '1' }))).toThrow(CopyError);
  });

  it('refuses unset / null / non-integer leaderShareBps — no invented fee-share', () => {
    const bases = { published: true, earningsCapPerFollower: '1' };
    for (const leaderShareBps of [null, '', '2500', 12.5, -1, 10_001]) {
      expect(() => parseCopyFeeShareLawJson(JSON.stringify({ ...bases, leaderShareBps }))).toThrow(CopyError);
    }
  });

  it('blank owner share bps stays refuse-closed — never invents a rate', () => {
    const blanks: unknown[] = [undefined, null, ''];
    for (const leaderShareBps of blanks) {
      const raw = JSON.stringify({ published: true, earningsCapPerFollower: '1', leaderShareBps });
      try {
        parseCopyFeeShareLawJson(raw);
        expect.unreachable(`should refuse blank leaderShareBps=${String(leaderShareBps)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(CopyError);
        expect((err as CopyError).code).toBe('trade.copy_fee_share_blank');
        expect((err as CopyError).residual).toBe(COPY_FEE_SHARE_RESIDUAL);
      }
    }
    expect(() => parseCopyFeeShareLawJson(JSON.stringify({ published: true, earningsCapPerFollower: '1' }))).toThrow(
      expect.objectContaining({ code: 'trade.copy_fee_share_blank', residual: COPY_FEE_SHARE_RESIDUAL }),
    );
  });
});

describe('parseCopyJurisdictionLawJson', () => {
  it('empty → unpublished', () => {
    expect(parseCopyJurisdictionLawJson('')).toEqual(UNPUBLISHED_COPY_JURISDICTION_LAW);
  });

  it('published allowlist uppercases regions', () => {
    const law = parseCopyJurisdictionLawJson(JSON.stringify({ published: true, allowedRegions: ['sg', 'Ae'] }));
    expect(law).toEqual({ published: true, allowedRegions: ['SG', 'AE'] });
  });

  it('refuses invent — missing allowedRegions', () => {
    expect(() => parseCopyJurisdictionLawJson(JSON.stringify({ published: true }))).toThrow(CopyError);
  });

  it('published empty allowlist is valid (serve none — not invent)', () => {
    expect(parseCopyJurisdictionLawJson(JSON.stringify({ published: true, allowedRegions: [] }))).toEqual({
      published: true,
      allowedRegions: [],
    });
  });
});

describe('requirePublished*', () => {
  it('fee-share refuse names DIRECTION §8 / D26-P0-02 residual', () => {
    try {
      requirePublishedCopyFeeShareLaw(UNPUBLISHED_COPY_FEE_SHARE_LAW);
      expect.unreachable('should refuse');
    } catch (err) {
      expect(err).toBeInstanceOf(CopyError);
      expect((err as CopyError).code).toBe('trade.copy_fee_share_blank');
      expect((err as CopyError).residual).toBe(COPY_FEE_SHARE_RESIDUAL);
      expect(COPY_FEE_SHARE_RESIDUAL).toContain('DIRECTION §8');
      expect(COPY_FEE_SHARE_RESIDUAL).toContain('D26-P0-02');
    }
  });

  it('jurisdiction refuse names DIRECTION §8 / D26-P0-15 residual', () => {
    try {
      requirePublishedCopyJurisdictionLaw(UNPUBLISHED_COPY_JURISDICTION_LAW);
      expect.unreachable('should refuse');
    } catch (err) {
      expect(err).toBeInstanceOf(CopyError);
      expect((err as CopyError).code).toBe('trade.copy_jurisdiction_blank');
      expect((err as CopyError).residual).toBe(COPY_JURISDICTION_RESIDUAL);
      expect(COPY_JURISDICTION_RESIDUAL).toContain('D26-P0-15');
    }
  });

  it('status line names both refuse-closed blanks', () => {
    const line = copyLawStatusLine(UNPUBLISHED_COPY_FEE_SHARE_LAW, UNPUBLISHED_COPY_JURISDICTION_LAW);
    expect(line).toContain('feeShare=0');
    expect(line).toContain('jurisdiction=0');
    expect(line).toContain('D26-P0-02');
    expect(line).toContain('D26-P0-15');
    expect(copyLawResidual(UNPUBLISHED_COPY_FEE_SHARE_LAW, UNPUBLISHED_COPY_JURISDICTION_LAW)).toBe(COPY_LAW_RESIDUAL);
  });
});

describe('blank leader_share_bps pin — never invent a default', () => {
  it('unpublished law has no bps field to fall through as a fee-share', () => {
    expect(UNPUBLISHED_COPY_FEE_SHARE_LAW).toEqual({ published: false });
    expect(UNPUBLISHED_COPY_FEE_SHARE_LAW).not.toHaveProperty('leaderShareBps');
    expect(UNPUBLISHED_COPY_FEE_SHARE_LAW).not.toHaveProperty('decayShareBps');
  });

  it('requirePublished refuses unpublished — never returns a default bps', () => {
    try {
      requirePublishedCopyFeeShareLaw(UNPUBLISHED_COPY_FEE_SHARE_LAW);
      expect.unreachable('should refuse');
    } catch (err) {
      expect(err).toBeInstanceOf(CopyError);
      expect((err as CopyError).code).toBe('trade.copy_fee_share_blank');
    }
  });

  it('production copy sources must not default leader_share_bps or ship profit-share', () => {
    const files = readdirSync(COPY_DIR).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const code = stripTsComments(readFileSync(join(COPY_DIR, name), 'utf8'));
      expect(code, name).not.toMatch(/\bDEFAULT_[A-Z0-9_]*BPS\b/);
      expect(code, name).not.toMatch(/leaderShareBps\s*\?\?/);
      expect(code, name).not.toMatch(/leaderShareBps\s*=\s*\d/);
      expect(code, name).not.toMatch(/leader_share_bps\s*[:=]\s*\d/);
      expect(code, name).not.toMatch(/\bprofitShareBps\b/);
      expect(code, name).not.toMatch(/\bprofit_share_bps\b/);
    }
  });

  it('profit-share / P&L-linked copy fees stay banned', () => {
    const src = readFileSync(join(COPY_DIR, 'fee-share.ts'), 'utf8');
    expect(src).toContain('export function refusePnlLinkedCopyFee');
    expect(src).toContain('trade.copy_pnl_fee_forbidden');
    expect(src).toMatch(/P&L-linked copy fees \(performance \/ HWM \/ success\) are forbidden/);
  });
});
