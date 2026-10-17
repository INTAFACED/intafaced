/**
 * Customer refusal and desk text must not carry internal spec ids.
 * Those ids live only in refusal-spec-log.ts, which this scan skips.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CCXT_CAPABILITY_MATRIX, CCXT_REFUSE_ARMS } from './ccxt-capability-matrix.js';
import { COPY_FEE_SHARE_RESIDUAL, COPY_JURISDICTION_RESIDUAL, COPY_LAW_RESIDUAL } from './copy/errors.js';
import { copyLawStatusLine } from './copy/fee-share-law.js';
import { describeCopyPolicy } from './copy/copy-policy.js';
import { PROFIT_SOURCE_UNCONFIGURED } from './futures/profit-source.js';
import { otcDeskLawStatusLine, UNPUBLISHED_OTC_DESK_LAW } from './otc/desk-law.js';
import { OTC_DESK_LAW_RESIDUAL, RFQ_ALLOCATION_RESIDUAL, RFQ_GIVE_UP_RESIDUAL } from './otc/errors.js';
import { OTC_MAKER_ROUTING_RESIDUAL } from './otc/maker-routing.js';
import { OTC_MID_FEED_RESIDUAL } from './otc/mid-feed.js';
import { describeOtcPolicy } from './otc/otc-policy.js';
import { OPEN_POSITION_GATES_NOTE } from './public-rest.js';
import { logRefusalSpec, REFUSAL_SPEC_NOTES, resetRefusalSpecLogForTests } from './refusal-spec-log.js';
import { FEE_SCHEDULE_RESIDUAL } from './spot/fee-schedule.js';
import { FOREX_SETTLEMENT_RESIDUAL, forexSettlementStatus } from './spot/forex-settlement.js';
import { describeOptionsPolicy, OPTIONS_SETTLEMENT_RESIDUAL } from './spot/options-policy.js';

const SRC = dirname(fileURLToPath(import.meta.url));

/** Patterns from the copy job: spec sections, requirement ids, and internal names. */
const FORBIDDEN = /DIRECTION\s*§|DIRECTION:\d+|D26-|TRD-\d+|§|\bNitro\b|\bPhantom\b|P1 GO|PTX-|D-S-\d+|SPEC-|P0-\d+|\bD7\b/;

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) productionFiles(path, out);
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('refusal-spec-log.ts')) out.push(path);
  }
  return out;
}

function stringLiterals(source: string): string[] {
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const withoutLine = withoutBlock.replace(/(^|[^:])\/\/.*$/gm, '$1');
  const found: string[] = [];
  const re = /`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(withoutLine))) found.push(match[0]);
  return found;
}

function walkStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) walkStrings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) walkStrings(item, out);
}

function customerTexts(): string[] {
  const out: string[] = [];
  walkStrings(
    [
      COPY_FEE_SHARE_RESIDUAL,
      COPY_JURISDICTION_RESIDUAL,
      COPY_LAW_RESIDUAL,
      OTC_DESK_LAW_RESIDUAL,
      RFQ_ALLOCATION_RESIDUAL,
      RFQ_GIVE_UP_RESIDUAL,
      OTC_MAKER_ROUTING_RESIDUAL,
      OTC_MID_FEED_RESIDUAL,
      FEE_SCHEDULE_RESIDUAL,
      FOREX_SETTLEMENT_RESIDUAL,
      OPTIONS_SETTLEMENT_RESIDUAL,
      PROFIT_SOURCE_UNCONFIGURED,
      OPEN_POSITION_GATES_NOTE,
      copyLawStatusLine({ published: false }, { published: false }),
      otcDeskLawStatusLine(UNPUBLISHED_OTC_DESK_LAW),
      forexSettlementStatus(),
      describeOptionsPolicy(),
      describeCopyPolicy(),
      describeOtcPolicy(),
      CCXT_REFUSE_ARMS,
      CCXT_CAPABILITY_MATRIX,
    ],
    out,
  );
  return out;
}

describe('customer refusal text', () => {
  it('fails when any production string literal carries an internal id', () => {
    const leaks: string[] = [];
    for (const file of productionFiles(SRC)) {
      for (const literal of stringLiterals(readFileSync(file, 'utf8'))) {
        if (FORBIDDEN.test(literal)) leaks.push(`${file.slice(SRC.length + 1)}: ${literal.slice(0, 180)}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('desk and refusal sentences name the blocker in plain English', () => {
    const texts = customerTexts();
    expect(texts).toContain('Copy trading is not available yet: the leader fee share is not set.');
    expect(texts).toContain('OTC quotes are not available yet: the spread, minimum stake, and counterparty are not set.');
    const leaks = texts.filter((text) => FORBIDDEN.test(text));
    expect(leaks).toEqual([]);
  });

  it('keeps the spec id in the server log and out of the customer sentence', () => {
    resetRefusalSpecLogForTests();
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      logRefusalSpec('trade.copy_fee_share_blank');
      logRefusalSpec('trade.copy_fee_share_blank');
    } finally {
      process.stderr.write = write;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(REFUSAL_SPEC_NOTES['trade.copy_fee_share_blank']);
    expect(lines[0]).toContain('trade.copy_fee_share_blank');
    expect(COPY_FEE_SHARE_RESIDUAL).not.toContain('D26-P0-02');
    expect(COPY_FEE_SHARE_RESIDUAL).not.toContain('§');
  });
});
