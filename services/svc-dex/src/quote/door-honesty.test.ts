import { describe, expect, it } from 'vitest';
import { BEST_EX_CLAIM_UNSET, copyClaimsBestEx } from '@intafaced/venue-adapter';
import { dexBestExHonesty, dexDoorHonesty, dexHealthHonesty, dexReadyHonesty } from './door-honesty.js';

const UNSET_DETAIL = 'owner best-ex law is unset — refusing rather than claiming best execution';

describe('Q-dex door honesty — internal book is not non-custodial', () => {
  it('when the internal book is on, names it custodial fiat — never AMM, never self-custody', () => {
    const door = dexDoorHonesty({ internalBookEnabled: true, internalBookPriced: true });
    expect(door.serviceHoldsBalances).toBe(false);
    expect(door.internalBook).toEqual({
      enabled: true,
      priced: true,
      custodial: true,
      plane: 'fiat',
      venueKind: 'internal',
      amm: false,
    });
    expect(door.ammVenueWired).toBe(false);
    expect(door.externalVenueWired).toBe(false);
    expect(JSON.stringify(door)).not.toMatch(/"custodial":false/);
  });

  it('when the internal book is off, still does not claim the door is a non-custodial AMM', () => {
    const door = dexDoorHonesty({ internalBookEnabled: false });
    expect(door.internalBook).toEqual({ enabled: false, amm: false });
    expect(door.ammVenueWired).toBe(false);
    expect(door.externalVenueWired).toBe(false);
    expect(JSON.stringify(door)).not.toMatch(/"custodial":false/);
  });

  it('health and ready reuse the same named fields — no custodial:false shortcut', () => {
    const health = dexHealthHonesty({ internalBookEnabled: true });
    const ready = dexReadyHonesty({ internalBookEnabled: true });
    expect(health.ok).toBe(true);
    expect(health.service).toBe('svc-dex');
    expect(ready.ready).toBe(true);
    expect(health.internalBook).toMatchObject({ enabled: true, custodial: true });
    expect(ready.internalBook).toMatchObject({ enabled: true, custodial: true });
    expect(health.externalVenueWired).toBe(false);
    expect(ready.externalVenueWired).toBe(false);
    expect(JSON.stringify(health)).not.toMatch(/"custodial":false/);
    expect(JSON.stringify(ready)).not.toMatch(/"custodial":false/);
  });

  it('empty DEX_EXTERNAL_VENUES is not a live external venue', () => {
    const door = dexDoorHonesty({ internalBookEnabled: true, internalBookPriced: true });
    expect(door.externalVenueWired).toBe(false);
  });
});

describe('Q-dex door honesty — ranking is not certified best execution', () => {
  it('unset owner law → claimed: false on the door (quote/health/ready)', () => {
    const door = dexDoorHonesty({ internalBookEnabled: false });
    expect(door.bestEx).toEqual({ ok: true, claimed: false });
    expect(dexHealthHonesty({ internalBookEnabled: false }).bestEx).toEqual({ ok: true, claimed: false });
    expect(dexReadyHonesty({ internalBookEnabled: false }).bestEx).toEqual({ ok: true, claimed: false });
  });

  it.each([
    ['claim flag', { claim: true }],
    ['kind best-ex', { kind: 'best-ex' }],
    ['copy best execution', { copy: 'This is best execution.' }],
  ] as const)('claiming true without law refuses venue.best_ex_claim_unset (%s)', (_label, input) => {
    const verdict = dexBestExHonesty(input);
    expect(verdict).toEqual({
      ok: false,
      reason: 'best_ex_unset',
      code: BEST_EX_CLAIM_UNSET,
      detail: UNSET_DETAIL,
    });
    const door = dexDoorHonesty({
      internalBookEnabled: true,
      internalBookPriced: true,
      bestExClaim: 'claim' in input ? input.claim : undefined,
      bestExKind: 'kind' in input ? input.kind : undefined,
      bestExCopy: 'copy' in input ? input.copy : undefined,
    });
    expect(door.bestEx).toEqual(verdict);
    expect(door.internalBook).toMatchObject({ enabled: true, custodial: true });
    expect(door.ammVenueWired).toBe(false);
    expect(door.externalVenueWired).toBe(false);
  });

  it('named owner law can seal a claim through this gate only — never invented here', () => {
    expect(dexBestExHonesty({ claim: true, ownerBestExLaw: 'socket.external-best-execution-law' })).toEqual({
      ok: true,
      claimed: true,
      ownerBestExLaw: 'socket.external-best-execution-law',
    });
  });

  it('the door honesty copy does not sell a live quote as certified best execution, for any wiring', () => {
    // Served by index.ts (index-boot.test.ts); the quote door's own answer: internal-book-http.honesty.test.ts.
    const answers: unknown[] = [dexBestExHonesty({ claim: false }), dexBestExHonesty({ claim: true })];
    for (const internalBookEnabled of [true, false]) {
      for (const flag of [true, false]) {
        const wiring = { internalBookEnabled, ammVenueWired: flag, externalVenueWired: !flag };
        answers.push(dexDoorHonesty(wiring), dexHealthHonesty(wiring), dexReadyHonesty(wiring));
      }
    }
    for (const answer of answers) expect(copyClaimsBestEx(JSON.stringify(answer)), JSON.stringify(answer)).toBe(false);
  });
});
