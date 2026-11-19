import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TAX_PROCEDURES } from '@intafaced/contracts/tax-procedures';

/**
 * zod's verdict on each svc-tax input, recorded for the Rust service (`crates/svc-tax/tests/input_parity.rs`), which must
 * give the same verdict and, for a refusal, the same message byte for byte. A schema alone does not carry its meaning
 * across two languages (a dropped bound, a reordered issue), so the two are held to the same answers instead.
 *
 * Each case is a record's path and an input as JSON text (`null`: no input). `INPUT_PARITY_WRITE=1` rewrites the golden
 * file: only for a change that is meant to change what an input check says, named in its PR.
 */

const GOLDEN = new URL('./input-parity.golden.json', import.meta.url);

const DAY = (day: unknown) => ({ day, assetId: null, method: null });
const PNL = (from: unknown, utcOffsetMinutes: unknown, to?: unknown) => ({ from, ...(to === undefined ? {} : { to }), utcOffsetMinutes });

const CASES: ReadonlyArray<readonly [string, ReadonlyArray<string | null>]> = [
  ['lotBook', [null, '{}', '{"method":"AVERAGE"}', '{"method":"NEWEST"}', '{"method":null}', 'null', '[]', '"x"', '{"b":1,"2":2,"a":3}']],
  [
    'pnlOverTime',
    [
      ...[
        PNL('2026-01-01T00:00:00Z', 60),
        PNL('2026-01-01T00:00:00+08:00', -840, '2026-02-01T00:00:00.000Z'),
        PNL('2026-01-01T00:00:00.123456789-23:59', 840),
        PNL('2026-01-01T00:00:00Z', 841),
        PNL('2026-01-01T00:00:00Z', -841),
        PNL('2026-01-01T00:00:00Z', 1.5),
        PNL('2026-01-01T00:00:00Z', 900.5),
        PNL('2026-01-01T00:00:00Z', 1e20),
        PNL('2026-01-01T00:00:00Z', -1e20),
        PNL('2026-01-01T00:00:00Z', '60'),
        PNL('2026-01-01', 0),
        PNL('2026-01-01T00:00Z', 0),
        PNL('2026-01-01t00:00:00Z', 0),
        PNL('2026-01-01T00:00:00+0800', 0),
        PNL('2026-01-01T24:00:00Z', 0),
        PNL('2026-02-29T00:00:00Z', 0),
        PNL('2024-02-29T00:00:00Z', 0),
        PNL('1900-02-29T00:00:00Z', 0),
        PNL('2000-02-29T00:00:00Z', 0),
        PNL('2026-04-31T00:00:00Z', 0),
        PNL('2026-01-01T00:00:00Z', 0, 5),
        PNL(7, null),
      ].map((i) => JSON.stringify(i)),
      '{"from":"2026-01-01T00:00:00Z","utcOffsetMinutes":1e400}',
      '{"from":"2026-01-01T00:00:00Z","utcOffsetMinutes":-1e400}',
      '{"from":"2026-01-01T00:00:00Z","utcOffsetMinutes":0,"z":1,"1":2}',
      null,
    ],
  ],
  ['missingBasis', ['{"method":7}', '{"method":"LIFO"}']],
  [
    'basisOverride.set',
    [
      '{"lotId":"l1","pricePerUnit":"1.5","date":"2026-01-01","sourceNote":"n"}',
      '{"lotId":"m1","pricePerUnit":"1.5","date":"2026-01-01","sourceNote":"n","assetId":"BTC","qty":"2"}',
      '{"lotId":1,"pricePerUnit":true,"date":null,"sourceNote":[],"qty":3}',
      '{"lotId":"l1","pricePerUnit":"1.5","date":"2026-01-01"}',
      '{}',
    ],
  ],
  ['basisOverride.remove', ['{"lotId":"l1"}', '{"lotId":""}', '{}', '{"lotId":"l1","extra":1}']],
  [
    'setLotMethod',
    [
      '{"assetId":null,"method":"FIFO"}',
      '{"assetId":"BTC","method":null}',
      '{"assetId":"B-T","method":"X"}',
      '{"assetId":"","method":null}',
      `{"assetId":"${'A'.repeat(20)}","method":null}`,
      `{"assetId":"${'A'.repeat(21)}","method":null}`,
      '{"assetId":"BTÇ","method":null}',
      '{"method":"FIFO"}',
    ],
  ],
  [
    'setDayMethod',
    [
      ...[
        '2026-01-01',
        '2024-02-29',
        '2026-02-29',
        '2026-02-30',
        '2026-04-31',
        '2026-13-01',
        '2026-00-10',
        '2026-01-00',
        '2026-1-01',
        '2026-01',
        '2026',
        '-000001',
        '+010000',
        '',
        '2026-01-01T00:00:00Z',
        '١٢٣٤-٠١-٠١',
      ].map((d) => JSON.stringify(DAY(d))),
      JSON.stringify(DAY(5)),
      '{"day":5,"assetId":[],"method":{}}',
      '{"day":"2026-01-01","assetId":"BTC","method":"LIFO"}',
    ],
  ],
  [
    'pickSaleLot',
    [
      '{"saleTxId":"s1","assetId":"BTC","lotId":null}',
      '{"saleTxId":"","assetId":"BTC","lotId":""}',
      JSON.stringify({ saleTxId: 'x'.repeat(201), assetId: 'BTC', lotId: 'y'.repeat(301) }),
      JSON.stringify({ saleTxId: '😀'.repeat(100), assetId: 'BTC', lotId: null }),
      JSON.stringify({ saleTxId: '😀'.repeat(101), assetId: 'BTC', lotId: null }),
      '{"saleTxId":"s1","assetId":null,"lotId":7}',
    ],
  ],
  ['setIncludeTransfers', ['{"include":true}', '{"include":null}', '{"include":"yes"}', '{}']],
  [
    'exportPreview',
    [
      '{"lotMethod":"HIFO"}',
      '{"lotMethod":"FIFO","complete":true}',
      '{"lotMethod":"AVERAGE"}',
      '{}',
      '{"lotMethod":"FIFO","complete":"x","extra":1}',
    ],
  ],
  ['exportPack', ['{"lotMethod":"LIFO","complete":false}', '[]']],
];

interface Case {
  readonly path: string;
  readonly input: string | null;
  /** `ok`, or the refusal's message: `JSON.stringify(issues, null, 2)`, as tRPC sends it. */
  readonly verdict: string;
}

function verdicts(): Case[] {
  return CASES.flatMap(([path, inputs]) => {
    const record = TAX_PROCEDURES.find((r) => r.path === path);
    if (!record) throw new Error(`no record at ${path}`);
    return inputs.map((input) => {
      const parsed = (record.input as { safeParse(v: unknown): { success: boolean; error?: { message: string } } }).safeParse(
        input === null ? undefined : JSON.parse(input),
      );
      return { path, input, verdict: parsed.success ? 'ok' : parsed.error!.message };
    });
  });
}

describe('input parity: zod verdicts on svc-tax inputs, recorded for the Rust service', () => {
  it('every case gets the recorded verdict', () => {
    const now = verdicts();
    if (process.env.INPUT_PARITY_WRITE === '1') writeFileSync(GOLDEN, `${JSON.stringify(now, null, 2)}\n`);
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Case[];
    expect(now).toEqual(golden);
  });
});
