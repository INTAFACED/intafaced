/**
 * Unit card — open/close positionUpdated must not invent unrealized PnL
 * 1. Promise: publishPositionUpdated hard-nulls unrealizedPnl; no nextFundingTimestamp
 * 2. Break: WS copies extras.unrealizedPnl or formatAmount of mark-entry
 * 3. Done bar: source has unrealizedPnl: null in the publish payload
 * 4. Class N
 * 5. Paths: svc-trade/src/futures/position-service.ts
 * 6. RED: unrealizedPnl: extras?.unrealizedPnl
 * 7. Collision: none — #1931 pins liquidated tick-stores; this pins open/close fan-out
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'position-service.ts'), 'utf8');
const publish = src.match(/private async publishPositionUpdated[\s\S]*?^\s{2}\}/m)?.[0] ?? '';

describe('open/close positionUpdated does not invent unrealized PnL', () => {
  it('extracts publishPositionUpdated', () => {
    expect(publish).toMatch(/private async publishPositionUpdated/);
  });

  it('hard-nulls unrealizedPnl and does not emit nextFundingTimestamp', () => {
    expect(publish).toMatch(/unrealizedPnl:\s*null/);
    expect(publish).not.toMatch(/unrealizedPnl:\s*extras/);
    expect(publish).not.toMatch(/unrealizedPnl:\s*formatAmount/);
    expect(publish).not.toMatch(/nextFundingTimestamp/);
  });
});
