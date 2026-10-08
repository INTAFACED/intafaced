/**
 * Unit card (L01 W6 A2):
 * Promise: dark plane refuses unbilled for every Stage-1 product runSession
 *   (scanner/navigator/support/merchant/copy-intel route tests; residual table).
 * Break: a new agent mount could ship without a dark billedAmount:'0' pin,
 *   or billedAmount:'0.5' could satisfy that pin by matching the '0' prefix.
 * Done bar: each of the five run-session-route test files asserts dark refuse + billedAmount '0'.
 * Paired (D26-P2-01h): metering-public-doors-promise-falsify.test.ts runs the same
 *   five doors via createCaller and pins metering-off never feeCharges.
 * Class: N
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Quoted zero, ended at that digit. A decimal or another digit is a
 * different amount, so billedAmount: '0.5' is not this pin.
 */
const BILLED_ZERO_PIN = /billedAmount:\s*'0(?![.\d])'/;

const DARK_RUN_SESSION_PINS: readonly {
  readonly agentId: string;
  readonly relativeTest: string;
  readonly darkReason: string;
}[] = [
  {
    agentId: 'scanner',
    relativeTest: '../scanner/run-session-route.test.ts',
    darkReason: 'market_plane_dark',
  },
  {
    agentId: 'navigator',
    relativeTest: '../navigator/run-session-route.test.ts',
    darkReason: 'trade_plane_dark',
  },
  {
    agentId: 'support',
    relativeTest: '../support-agent/run-session-route.test.ts',
    darkReason: 'desk_plane_dark',
  },
  {
    agentId: 'merchant',
    relativeTest: '../merchant/run-session-route.test.ts',
    darkReason: 'pay_plane_dark',
  },
  {
    agentId: 'copy-intel',
    relativeTest: '../copy-intel/run-session-route.test.ts',
    darkReason: 'copy_plane_dark',
  },
];

describe('fleet dark-plane refuse is billed zero (matrix pin)', () => {
  it("a billedAmount of '0' is not a billedAmount of '0.5'", () => {
    expect("billedAmount: '0.5'").not.toMatch(BILLED_ZERO_PIN);
    expect("billedAmount: '0'").toMatch(BILLED_ZERO_PIN);
  });

  it('covers every Stage-1 product agent exactly once', () => {
    expect(DARK_RUN_SESSION_PINS.map((p) => p.agentId).sort()).toEqual(
      ['copy-intel', 'merchant', 'navigator', 'scanner', 'support'].sort(),
    );
  });

  it('each runSession route test pins dark refuse + metering.billedAmount 0', () => {
    for (const pin of DARK_RUN_SESSION_PINS) {
      const src = readFileSync(join(HERE, pin.relativeTest), 'utf8');
      expect(src, `${pin.agentId}: missing plane: 'dark'`).toMatch(/plane:\s*'dark'/);
      expect(src, `${pin.agentId}: missing billedAmount: '0'`).toMatch(BILLED_ZERO_PIN);
      expect(src, `${pin.agentId}: missing dark reason ${pin.darkReason}`).toContain(pin.darkReason);
      // Dark refuse blocks must carry billedAmount: '0' (at least one).
      expect(src.match(new RegExp(BILLED_ZERO_PIN.source, 'g'))?.length ?? 0).toBeGreaterThanOrEqual(1);
    }
  });
});
