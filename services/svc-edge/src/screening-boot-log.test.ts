import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { assertScreeningConfigured, parseScreeningList, ScreeningListError, SCREENING_REVIEWED_EMPTY } from '@intafaced/config';
import { logScreeningAtBoot } from './screening-boot-log.js';

/**
 * Edge's screening boot line must carry key names, presence and counts only.
 *
 * The list and its source are the `INTAFACED_SANCTIONS_REGIONS` and
 * `INTAFACED_SANCTIONS_LIST_SOURCE` secrets, and Edge's log reaches public CI
 * job logs. These stand-ins are fake: QZ and XQ are ISO user-assigned codes,
 * and the other strings say TEST. Each case boots the real logging path (the
 * boot guard, then Fastify's logger) and asserts no stand-in appears anywhere.
 */
const REGION_A = 'QZ';
const REGION_B = 'XQ';
const REASON = 'TEST-REASON-7c1e-stand-in';
const SOURCE = 'TEST-SOURCE-4b9d2e-stand-in';
const MALFORMED = 'TEST-REGION-ZZ';

const STAND_INS = [REASON, SOURCE, MALFORMED];
const REGION_CODES = new RegExp(`\\b(${REGION_A}|${REGION_B})\\b`);

function bootLog(env: Record<string, string | undefined>): { lines: Record<string, unknown>[]; raw: string } {
  let raw = '';
  const stream = new Writable({
    write(chunk, _enc, done) {
      raw += String(chunk);
      done();
    },
  });
  const app = Fastify({ logger: { level: 'info', stream } });
  const screening = assertScreeningConfigured(env, []);
  logScreeningAtBoot(app.log, env.APP_ENV ?? 'unset', screening);
  const lines = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { lines, raw };
}

function expectNoStandIn(text: string): void {
  for (const value of STAND_INS) expect(text).not.toContain(value);
  expect(text).not.toMatch(REGION_CODES);
}

describe('Edge screening boot log carries no secret value', () => {
  it('a listed, counsel-grade list: count and presence, no codes, reasons or source', () => {
    const { lines, raw } = bootLog({
      APP_ENV: 'prod',
      INTAFACED_SANCTIONS_REGIONS: `${REGION_A}:${REASON},${REGION_B}`,
      INTAFACED_SANCTIONS_LIST_SOURCE: SOURCE,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ configured: true, declaration: 'listed', moneyGrade: 'counsel', blocked: 2, sourceSet: true });
    expect(lines[0]).not.toHaveProperty('source');
    expect(String(lines[0]!.msg)).toContain('2 region(s) blocked');
    expectNoStandIn(raw);
  });

  it('a listed list with no source says so, still without values', () => {
    const { lines, raw } = bootLog({ APP_ENV: 'test', INTAFACED_SANCTIONS_REGIONS: `${REGION_A},${REGION_B}` });
    expect(lines[0]).toMatchObject({ declaration: 'listed', blocked: 2, sourceSet: false });
    expect(String(lines[0]!.msg)).toContain('no source set');
    expectNoStandIn(raw);
  });

  it('a FIXTURE / TEST LIST is named as one, without the source that marks it', () => {
    const fixtureSource = `test-fixture-${SOURCE}`;
    const { lines, raw } = bootLog({
      APP_ENV: 'test',
      INTAFACED_SANCTIONS_REGIONS: `${REGION_A}:${REASON}`,
      INTAFACED_SANCTIONS_LIST_SOURCE: fixtureSource,
    });
    expect(lines[0]).toMatchObject({ moneyGrade: 'fixture', blocked: 1, sourceSet: true });
    expect(String(lines[0]!.msg)).toContain('FIXTURE / TEST LIST');
    expect(raw).not.toContain(fixtureSource);
    expectNoStandIn(raw);
  });

  it('reviewed and deliberately empty is named as a recorded decision, without its record', () => {
    const { lines, raw } = bootLog({
      APP_ENV: 'prod',
      INTAFACED_SANCTIONS_REGIONS: SCREENING_REVIEWED_EMPTY,
      INTAFACED_SANCTIONS_LIST_SOURCE: SOURCE,
    });
    expect(lines[0]).toMatchObject({ configured: true, declaration: 'reviewed-empty', blocked: 0, sourceSet: true });
    expect(String(lines[0]!.msg)).toContain('DELIBERATELY EMPTY');
    expectNoStandIn(raw);
  });

  it('unconfigured still warns plainly in dev and test', () => {
    const { lines } = bootLog({ APP_ENV: 'test' });
    expect(lines[0]).toMatchObject({ level: 40, configured: false, declaration: 'unset', blocked: 0, sourceSet: false });
    expect(String(lines[0]!.msg)).toContain('NOT CONFIGURED');
  });

  it('the boot refusal for a malformed list names entries by position, never by value', () => {
    let thrown: unknown;
    try {
      parseScreeningList(`${MALFORMED}:${REASON},${REGION_A},${REGION_A}`, SOURCE);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ScreeningListError);
    const message = (thrown as ScreeningListError).message;
    expect(message).toContain('entry 1');
    expect(message).toContain('entry 3 repeats an earlier region');
    expectNoStandIn(message);
  });
});
