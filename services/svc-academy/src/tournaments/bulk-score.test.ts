import { describe, expect, it } from 'vitest';
import {
  applyBulkScorePatches,
  isBulkScoreOk,
  summarizeBulkScoreResult,
  validateBulkScoreWrite,
  bulkAcceptedCount,
  bulkRefuseReason,
  isBulkScoreRefused,
  bulkAcceptedCountLabel,
  bulkRefuseReasonLabel,
  isBulkScoreEmptyOk,
  bulkScoreBoardCard,
  bulkScoreExportHeader,
  bulkScoreExportLine,
  bulkScoreExportText,
  parseBulkScoreExportLine,
  bulkScoreStatusLine,
  parseBulkScoreStatusLine,
  bulkScoreStatusLineMatches,
  bulkAcceptedInRange,
  bulkAcceptedAtLeast,
  countBulkScoreExportDataLines,
  bulkScoreExportHasHeader,
  bulkScoreExportRoundTripOk,
} from './bulk-score.js';

describe('tournament L3 bulk score (no prizes)', () => {
  it('refuses non-live season and empty patches', () => {
    expect(validateBulkScoreWrite({ seasonStatus: 'frozen', seasonId: 's1', patches: [{ userId: 'u', score: 1 }] }).status).toBe('refuse');
    expect(validateBulkScoreWrite({ seasonStatus: 'live', seasonId: 's1', patches: [] }).status).toBe('refuse');
  });

  it('refuses live season after endsAt when calendar bounds provided', () => {
    const refused = validateBulkScoreWrite({
      seasonStatus: 'live',
      seasonId: 's1',
      startsAt: new Date('2026-08-01T00:00:00.000Z'),
      endsAt: new Date('2026-08-31T00:00:00.000Z'),
      now: new Date('2026-09-01T00:00:00.000Z'),
      patches: [{ userId: 'u', score: 10 }],
    });
    expect(refused).toMatchObject({ status: 'refuse', reason: 'season_not_live' });
    expect(refused.status === 'refuse' && refused.message).toMatch(/calendar window/i);

    const ok = validateBulkScoreWrite({
      seasonStatus: 'live',
      seasonId: 's1',
      startsAt: new Date('2026-08-01T00:00:00.000Z'),
      endsAt: new Date('2026-08-31T00:00:00.000Z'),
      now: new Date('2026-08-15T00:00:00.000Z'),
      patches: [{ userId: 'u', score: 10 }],
    });
    expect(ok.status).toBe('ok');
  });

  it('refuses duplicate user and bad score', () => {
    expect(
      validateBulkScoreWrite({
        seasonStatus: 'live',
        seasonId: 's1',
        patches: [
          { userId: 'u1', score: 1 },
          { userId: 'u1', score: 2 },
        ],
      }),
    ).toMatchObject({ status: 'refuse', reason: 'duplicate_user' });
    expect(validateBulkScoreWrite({ seasonStatus: 'live', seasonId: 's1', patches: [{ userId: 'u1', score: -1 }] })).toMatchObject({
      status: 'refuse',
      reason: 'invalid_row',
    });
  });

  it('applies validated patches without invent scores', () => {
    const v = validateBulkScoreWrite({
      seasonStatus: 'live',
      seasonId: 's1',
      patches: [
        { userId: 'a', score: 10 },
        { userId: 'b', score: 20 },
      ],
    });
    expect(v.status).toBe('ok');
    if (v.status !== 'ok') return;
    const now = new Date('2026-08-05T00:00:00.000Z');
    const rows = applyBulkScorePatches('s1', [], v.patches, now);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.userId === 'b')?.score).toBe(20);
    expect(summarizeBulkScoreResult(v)).toEqual({ accepted: 2, refused: false, reason: null });
    expect(isBulkScoreOk(v)).toBe(true);
    const refused = validateBulkScoreWrite({ seasonStatus: 'frozen', seasonId: 's1', patches: [{ userId: 'u', score: 1 }] });
    expect(summarizeBulkScoreResult(refused)).toEqual({ accepted: 0, refused: true, reason: 'season_not_live' });
    expect(isBulkScoreOk(refused)).toBe(false);
  });

  it('L3 bulkAcceptedCount + bulkRefuseReason without invent', () => {
    const bad = validateBulkScoreWrite({ seasonStatus: 'frozen', seasonId: 's1', patches: [{ userId: 'a', score: 1 }] });
    expect(bulkAcceptedCount(bad)).toBe(0);
    expect(bulkRefuseReason(bad)).not.toBeNull();
    const ok = validateBulkScoreWrite({
      seasonStatus: 'live',
      seasonId: 's1',
      patches: [
        { userId: 'a', score: 1 },
        { userId: 'b', score: 2 },
      ],
    });
    if (ok.status === 'ok') {
      expect(bulkAcceptedCount(ok)).toBe(2);
      expect(bulkRefuseReason(ok)).toBeNull();
    }
  });

  it('L3 wave35 bulk result labels + empty ok', () => {
    const refused = { status: 'refuse' as const, reason: 'season_not_live' as const, message: 'x' };
    expect(isBulkScoreRefused(refused)).toBe(true);
    expect(bulkRefuseReasonLabel(refused)).toBe('season_not_live');
    expect(bulkAcceptedCountLabel(refused)).toBe('0');
    const emptyOk = { status: 'ok' as const, patches: [] as const };
    expect(isBulkScoreEmptyOk(emptyOk)).toBe(true);
    expect(isBulkScoreRefused(emptyOk)).toBe(false);
  });

  it('L3 wave43 bulk score board + export/parse', () => {
    const refused = { status: 'refuse' as const, reason: 'season_not_live' as const, message: 'x' };
    const card = bulkScoreBoardCard(refused);
    expect(card.ok).toBe(false);
    expect(card.reason).toBe('season_not_live');
    expect(bulkScoreExportHeader()).toBe('status,accepted,reason');
    expect(bulkScoreExportLine(refused)).toBe('refuse,0,season_not_live');
    expect(parseBulkScoreExportLine('ok,2,')).toEqual({ status: 'ok', accepted: 2, reason: '' });
    expect(parseBulkScoreExportLine('status,accepted,reason')).toBeNull();
    expect(bulkScoreExportText(refused)).toContain('refuse');
  });
});

describe('L3 wave47 bulk-score status/export', () => {
  it('status and round-trip on ok result', () => {
    const ok = validateBulkScoreWrite({
      seasonStatus: 'live',
      seasonId: 's1',
      patches: [{ userId: 'u1', score: 10 }],
    });
    expect(ok.status).toBe('ok');
    if (ok.status !== 'ok') return;
    expect(bulkScoreStatusLine(ok)).toMatch(/^ok=1 accepted=\d+ refused=0$/);
    expect(bulkScoreStatusLineMatches(ok)).toBe(true);
    expect(parseBulkScoreStatusLine('nope')).toBeNull();
    const text = bulkScoreExportText(ok);
    expect(bulkScoreExportHasHeader(text)).toBe(true);
    expect(countBulkScoreExportDataLines(text)).toBe(1);
    expect(bulkScoreExportRoundTripOk(ok)).toBe(true);
    expect(bulkAcceptedInRange(ok, 0, 10)).toBe(true);
    expect(bulkAcceptedInRange(ok, 10, 0)).toBe(false);
    expect(bulkAcceptedAtLeast(ok, 1)).toBe(true);
  });

  it('empty ok status', () => {
    // empty patches refuse — use applied empty ok if available via summarize path
    const refused = validateBulkScoreWrite({ seasonStatus: 'live', seasonId: 's1', patches: [] });
    expect(refused.status).toBe('refuse');
    if (refused.status !== 'refuse') return;
    expect(bulkScoreStatusLineMatches(refused)).toBe(true);
    expect(bulkScoreStatusLine(refused)).toContain('refused=1');
  });
});
