import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KNOWN_ROOM_CODES, roomRefusal } from './refusals';

const failure = (
  code: string | undefined,
  message = 'DIRECTION §8 / D26-P0-02 leader_share_bps is owner-only',
  reason: 'error' | 'uncertain' = 'error',
) => ({ ok: false as const, reason, message, ...(code ? { code } : {}) });

describe('roomRefusal', () => {
  it('maps every copy and algo code the service throws', () => {
    const service = readFileSync(new URL('../../../../../../services/svc-trade/src/copy/errors.ts', import.meta.url), 'utf8');
    const copyCodes = [...service.matchAll(/'(trade\.copy_[a-z_]+)'/g)].map((m) => m[1]!);
    expect(copyCodes.length).toBeGreaterThan(25);
    for (const code of new Set(copyCodes)) expect(KNOWN_ROOM_CODES, code).toContain(code);
  });
  it('never repeats the service sentence', () => {
    const shown = roomRefusal(failure('trade.copy_jurisdiction_blank'));
    expect(JSON.stringify(shown)).not.toMatch(/DIRECTION|D26-P0|leader_share_bps|owner-only|residual/i);
    const unknown = roomRefusal(failure('trade.some_new_code'));
    expect(JSON.stringify(unknown)).not.toMatch(/DIRECTION|D26-P0|leader_share_bps|owner-only/i);
  });
  it('says a lost reply is unknown, not failed', () => {
    expect(roomRefusal(failure(undefined, 'x', 'uncertain')).title).toMatch(/can’t tell/);
  });
});

describe('screens never print a service sentence', () => {
  it('has no .residual, .statusLine or .message rendered from a service reply', () => {
    const dir = new URL('./', import.meta.url);
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.tsx'))) {
      const text = readFileSync(new URL(file, dir), 'utf8');
      expect(text, file).not.toMatch(/\.(residual|statusLine|residuals)\b/);
      expect(text, file).not.toMatch(/failure\.message|result\.message|\.message\}/);
    }
  });
});
