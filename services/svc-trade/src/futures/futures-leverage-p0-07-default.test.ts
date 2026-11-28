/**
 * Unit card — production ships DIRECTION §1 10× (D26-P0-07)
 * 1. Promise: blank owner cap stays null and money paths refuse
 * 2. Break: restore any production fallback magnitude
 * 3. Done bar: index passes parsed nullable cap; compose stays empty
 * 4. Class N
 * 5. Paths: initial-margin.ts · env.ts · index.ts · docker-compose.apps.yml · .env.example
 * 6. RED: blank resolves to a number or LEVERAGE_CAP_UNSET disappears
 * 7. Collision: none — restores ADR 2026-08-13 after #1942 overshot
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAmount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { tradeEnvWith } from './testing/doors.js';
import * as initialMarginModule from './initial-margin.js';
import { LEVERAGE_CAP_UNSET, parseConfiguredMaxLeverage, resolveMaxLeverage } from './initial-margin.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const compose = readFileSync(join(root, 'docker-compose.apps.yml'), 'utf8');
const envExample = readFileSync(join(root, '.env.example'), 'utf8');

describe('production refuses an unset owner leverage cap', () => {
  it('initial-margin.ts names the typed refusal and no default magnitude', () => {
    expect(LEVERAGE_CAP_UNSET).toBe('trade.leverage_cap_unset');
    // The module offers no default magnitude to fall back on: no DEFAULT constant, and no export is a bare cap number.
    expect(initialMarginModule).not.toHaveProperty('DEFAULT_MAX_LEVERAGE');
    for (const [name, value] of Object.entries(initialMarginModule)) {
      if (typeof value === 'bigint' && name !== 'LEVERAGE_STEP') expect([parseAmount('10'), parseAmount('20')], name).not.toContain(value);
    }
    // No cap in, no cap out: neither the parser nor the resolver supplies a magnitude of its own.
    expect(parseConfiguredMaxLeverage('')).toBeNull();
    expect(parseConfiguredMaxLeverage('   ')).toBeNull();
    expect(resolveMaxLeverage()).toBeNull();
    expect(resolveMaxLeverage(null)).toBeNull();
    expect(resolveMaxLeverage(0n)).toBeNull();
    // A named cap is kept exactly; a non-positive one refuses boot.
    expect(parseConfiguredMaxLeverage('5')).toBe(parseAmount('5'));
    expect(resolveMaxLeverage(parseAmount('5'))).toBe(parseAmount('5'));
    expect(() => parseConfiguredMaxLeverage('0')).toThrow(/positive decimal or empty/);
    // The open path then refuses with this code and locks nothing: position-service.test.ts
    // ("refuses to OPEN when the listing leverage cap is unset, and locks nothing").
  });

  it('env.ts leaves the owner source empty', () => {
    expect(tradeEnvWith({}, ['TRADE_FUTURES_MAX_LEVERAGE']).TRADE_FUTURES_MAX_LEVERAGE).toBe('');
  });

  it('compose passes through empty rather than pinning a raise', () => {
    expect(compose).toMatch(/TRADE_FUTURES_MAX_LEVERAGE:\s*\$\{TRADE_FUTURES_MAX_LEVERAGE:-\}/);
    expect(compose).not.toMatch(/TRADE_FUTURES_MAX_LEVERAGE:\s*\$\{TRADE_FUTURES_MAX_LEVERAGE:-20/);
  });

  it('.env.example documents the key without assigning a raise', () => {
    expect(envExample).toMatch(/# TRADE_FUTURES_MAX_LEVERAGE=/);
    expect(envExample).not.toMatch(/^TRADE_FUTURES_MAX_LEVERAGE=/m);
  });

  it('live host preserves the nullable parse result', () => {
    // The host parses the env value it loaded; unset stays null all the way (no resolve step adds a number).
    const parsed = parseConfiguredMaxLeverage(tradeEnvWith({}, ['TRADE_FUTURES_MAX_LEVERAGE']).TRADE_FUTURES_MAX_LEVERAGE);
    expect(parsed).toBeNull();
    expect(resolveMaxLeverage(parsed)).toBeNull();
  });
});
