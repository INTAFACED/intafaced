import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CardSandboxAdapter } from './card-sandbox.js';
import { RailRegistry } from './registry.js';
import {
  PublicCheckoutUnavailable,
  SandboxRailRefusal,
  assertRailMayAcceptPublicPayment,
  assertRailMayMoveValue,
  selectPublicCheckoutRail,
  shouldRegisterCardSandbox,
} from './posture.js';

/**
 * pay.gateway card / issuer residual — Class X refuse pin.
 *
 * Phase A IN: existing `card-sandbox` + live-only posture refuse.
 * Does NOT invent an issuer, live acquirer, or card-live adapter.
 * Crypto invoice-and-watch is a different pin. Tracker stays not-done.
 */

const SECRET = 'card-class-x-refuse-secret-at-least-32-chars';
const RAILS_DIR = dirname(fileURLToPath(import.meta.url));

const cardSandbox = () => new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });

describe('card gateway stays Class X refuse — no invented issuer', () => {
  it('card-sandbox is sandbox forever — no live flag, no invented issuer id', () => {
    const adapter = cardSandbox();
    expect(adapter.id).toBe('card-sandbox');
    expect(adapter.mode).toBe('sandbox');
    expect(Object.keys(adapter)).not.toContain('live');
    expect(adapter.id).not.toMatch(/issuer|live-acquirer|card-live/i);
  });

  it('staging/prod omit card-sandbox by default (Class X acquiring stays a socket)', () => {
    expect(shouldRegisterCardSandbox({ APP_ENV: 'staging' })).toBe(false);
    expect(shouldRegisterCardSandbox({ APP_ENV: 'prod' })).toBe(false);
  });

  it('live-only value movement refuses card-sandbox — NOTHING WAS ATTEMPTED', () => {
    expect(() => assertRailMayMoveValue(cardSandbox(), 'payout', 'live-only')).toThrow(SandboxRailRefusal);
    expect(() => assertRailMayMoveValue(cardSandbox(), 'refund', 'live-only')).toThrow(SandboxRailRefusal);
    expect(() => assertRailMayAcceptPublicPayment(cardSandbox(), 'live-only')).toThrow(PublicCheckoutUnavailable);
  });

  it('live-only public checkout refuses rather than inventing a card issuer', () => {
    const rails = new RailRegistry([cardSandbox()]);
    expect(() => selectPublicCheckoutRail(rails, ['card-sandbox'], 'live-only')).toThrow(PublicCheckoutUnavailable);
  });

  it('rails layer has no invented live card / issuer adapter file', async () => {
    const names = readdirSync(RAILS_DIR).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'));
    expect(names).not.toContain('card-live.ts');
    expect(names).not.toContain('card-issuer.ts');
    expect(names).not.toContain('issuer.ts');
    expect(names.filter((n) => /issuer|card-live|live-acquirer/i.test(n))).toEqual([]);

    // The rails entry hands out the sandbox card rail and no live card, issuer or acquirer adapter.
    const rails = await import('./index.js');
    expect(rails.CardSandboxAdapter).toBe(CardSandboxAdapter);
    expect(Object.keys(rails).filter((name) => /card-?live|issuer|live-?acquirer/i.test(name))).toEqual([]);
  });
});
