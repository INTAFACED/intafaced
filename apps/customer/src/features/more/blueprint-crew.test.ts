import { describe, expect, it } from 'vitest';
import { crewExportForOwner, crewProjection } from './blueprint-crew-codec';

const owner = '11111111-1111-4111-8111-111111111111';
const peer = '22222222-2222-4222-8222-222222222222';
const crewId = '33333333-3333-4333-8333-333333333333';
const time = '2026-10-10T12:00:00Z';
function exportRecord() {
  return {
    exportedAt: time,
    schemaVersion: 2,
    blueprint: {
      id: crewId,
      userId: owner,
      engineVersion: 'fixture',
      visibility: 'private',
      cardAssetUrl: null,
      createdAt: time,
      profile: {
        decisionStyle: 'analytical',
        riskTemperament: 'measured',
        energyRhythm: 'steady',
        learningMode: 'visual',
        crewRole: 'anchor',
        curriculumPath: 'foundations',
        toneRegister: 'warm',
        guardrails: { maxLeverage: 1, dailyLossPromptPct: 5, confirmBeforeMarketOrder: true, copyTradingVisible: false },
      },
    },
    card: {
      size: 'portrait',
      width: 1080,
      height: 1350,
      svg: '<svg/>',
      shareMode: 'svg',
      raster: { status: 'unavailable', code: 'blueprint.card_renderer_unconfigured', reason: 'Fixture' },
    },
    crew: { id: crewId, name: '', formedAt: time, season: 1, xp: '-9007199254740993', lobbyId: null, capacity: 2 },
    membership: { crewId, userId: owner, role: 'builder', joinedAt: time },
    crewmates: [{ userId: peer, role: 'scout', joinedAt: time }],
    matchRuns: [{ id: crewId, candidates: { privateInput: 'not retained' }, scores: [], placedCrewId: peer, ts: time }],
    mentorMatches: [{ studentId: owner, mentorId: peer, fitScore: 50, status: 'shortlisted' }],
    mentoringOthers: [{ studentId: peer, mentorId: owner, fitScore: 50, status: 'accepted' }],
    shares: [],
    cardsOpened: [],
  };
}
const project = (record: unknown) => crewProjection(crewExportForOwner(owner).parse(record));

describe('signed-owner crew export projection', () => {
  it('uses membership role and exact signed XP while discarding unrelated owner/card/history data', () => {
    const read = project(exportRecord());
    expect(read.status).toBe('placed');
    if (read.status !== 'placed') throw Error('Expected placement');
    expect(read.members.map((row) => [row.userId, row.role, row.own])).toEqual([
      [owner, 'builder', true],
      [peer, 'scout', false],
    ]);
    expect(read.crew.xp).toBe('-9007199254740993');
    expect(read.crew.name).toBe('');
    expect(read.exportedAt).toBe(time);
    for (const field of ['blueprint', 'card', 'matchRuns', 'mentorMatches', 'mentoringOthers']) expect(read).not.toHaveProperty(field);
    expect(JSON.stringify(read)).not.toContain('privateInput');
  });
  it('permits coherent crew membership without a profile/card and a returned legacy capacity of one', () => {
    const record = { ...exportRecord(), blueprint: null, card: null, crewmates: [], crew: { ...exportRecord().crew, capacity: 1 } };
    const read = project(record);
    expect(read.status).toBe('placed');
    expect(read.profileAvailable).toBe(false);
  });
  it('keeps historical placement/persona separate from a genuinely absent crew/member/roster', () => {
    const read = project({ ...exportRecord(), crew: null, membership: null, crewmates: [] });
    expect(read).toEqual({ status: 'unplaced', profileAvailable: true, exportedAt: time });
  });
  it('accepts typed renderer failures or a valid rendered card without retaining its URL', () => {
    for (const code of ['blueprint.card_renderer_unreachable', 'blueprint.card_renderer_protocol']) {
      expect(
        crewExportForOwner(owner).safeParse({
          ...exportRecord(),
          card: { ...exportRecord().card, raster: { status: 'unavailable', code, reason: 'Fixture' } },
        }).success,
      ).toBe(true);
    }
    const read = project({
      ...exportRecord(),
      card: {
        ...exportRecord().card,
        shareMode: 'png',
        raster: { status: 'rendered', url: 'https://fixture.invalid/private.png', bytes: 1, contentType: 'image/png' },
      },
    });
    expect(JSON.stringify(read)).not.toContain('fixture.invalid');
  });
  const displayedTimes: [string, (row: ReturnType<typeof exportRecord>, value: string) => unknown][] = [
    ['export time', (row, value) => ({ ...row, exportedAt: value })],
    ['membership join time', (row, value) => ({ ...row, membership: { ...row.membership, joinedAt: value } })],
    ['peer join time', (row, value) => ({ ...row, crewmates: [{ ...row.crewmates[0], joinedAt: value }] })],
  ];
  for (const [field, change] of displayedTimes) {
    it(`refuses an impossible offset in ${field} before its date is rendered`, () => {
      expect(crewExportForOwner(owner).safeParse(change(exportRecord(), '2026-10-10T12:00:00+24:00')).success).toBe(false);
    });
    it(`preserves valid positive and negative offsets in ${field}`, () => {
      for (const value of ['2026-10-10T12:00:00+05:30', '2026-10-10T12:00:00-03:45']) {
        expect(crewExportForOwner(owner).safeParse(change(exportRecord(), value)).success).toBe(true);
      }
    });
  }
  const invalid: [string, (row: ReturnType<typeof exportRecord>) => unknown][] = [
    ['older schema', (row) => ({ ...row, schemaVersion: 1 })],
    ['missing complete envelope', (row) => ({ ...row, mentoringOthers: undefined })],
    ['wrong profile owner', (row) => ({ ...row, blueprint: { ...row.blueprint, userId: peer } })],
    ['wrong member owner', (row) => ({ ...row, membership: { ...row.membership, userId: peer } })],
    ['wrong student owner', (row) => ({ ...row, mentorMatches: [{ ...row.mentorMatches[0], studentId: peer }] })],
    ['wrong mentor owner', (row) => ({ ...row, mentoringOthers: [{ ...row.mentoringOthers[0], mentorId: peer }] })],
    ['wrong crew link', (row) => ({ ...row, membership: { ...row.membership, crewId: peer } })],
    ['crew without member', (row) => ({ ...row, membership: null })],
    ['member without crew', (row) => ({ ...row, crew: null })],
    ['roster without placement', (row) => ({ ...row, crew: null, membership: null })],
    ['owner repeated in roster', (row) => ({ ...row, crewmates: [{ ...row.crewmates[0], userId: owner }] })],
    ['duplicate roster', (row) => ({ ...row, crewmates: [row.crewmates[0], row.crewmates[0]], crew: { ...row.crew, capacity: 3 } })],
    ['capacity overflow', (row) => ({ ...row, crew: { ...row.crew, capacity: 1 } })],
    ['fractional XP', (row) => ({ ...row, crew: { ...row.crew, xp: '1.5' } })],
    ['invalid peer time', (row) => ({ ...row, crewmates: [{ ...row.crewmates[0], joinedAt: 'yesterday' }] })],
    ['missing portrait', (row) => ({ ...row, card: null })],
    ['card without profile', (row) => ({ ...row, blueprint: null })],
    ['wrong portrait dimensions', (row) => ({ ...row, card: { ...row.card, width: 1200 } })],
    ['invalid card raster', (row) => ({ ...row, card: { ...row.card, raster: { status: 'rendered', url: 'bad', bytes: 0 } } })],
  ];
  for (const [name, change] of invalid)
    it(`refuses ${name}`, () => expect(crewExportForOwner(owner).safeParse(change(exportRecord())).success).toBe(false));
});
