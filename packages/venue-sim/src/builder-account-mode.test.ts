import { describe, expect, it } from 'vitest';
import { decodeVenueWire, encodeVenueWire } from '@intafaced/venue-contracts';
import { TestVenueSimulator } from './simulator.js';
import { TEST_VENUE_MARKETS, answerTestVenue } from './http-server.js';

// J-ops-console-28: the TEST venue reports a builder address's account mode beside the mode it requires to accrue builder
// fees (standard, as the venue it stands for publishes). The per-account switch moves one address out of standard mode
// and back; the venue switch leaves the requirement unpublished; the account's `down` switch takes the read away.

const BUILDER = '0x00000000000000000000000000000000b0110001';
const OTHER = '0x00000000000000000000000000000000b0110002';
const AT = new Date(Date.UTC(2026, 10, 21, 3));

async function call(sim: TestVenueSimulator, path: string, body: unknown) {
  const [status, out] = await answerTestVenue(sim, 'POST', path, JSON.stringify(encodeVenueWire(body)));
  return { status, out: decodeVenueWire<Record<string, unknown>>(out) };
}

describe('the TEST venue builder account mode', () => {
  it('a new address reads standard, required standard, at the venue time', async () => {
    const sim = new TestVenueSimulator({ clock: () => AT, markets: TEST_VENUE_MARKETS });
    const { status, out } = await call(sim, '/builder-account-mode', { builder: BUILDER.toUpperCase().replace('0X', '0x') });
    expect(status).toBe(200);
    expect(out).toEqual({
      venueId: sim.venue.id,
      value: { builder: BUILDER, mode: { known: true, value: 'standard' }, required: { known: true, value: 'standard' } },
      asOf: AT,
      reportedAt: AT,
    });
  });

  it('the account switch moves one address out of standard mode and back, and no other', async () => {
    const sim = new TestVenueSimulator({ clock: () => AT, markets: TEST_VENUE_MARKETS });
    const moved = await call(sim, '/test/account-switches', { owner: BUILDER, accountMode: 'unified' });
    expect(moved.out).toMatchObject({ owner: BUILDER, accountMode: 'unified', label: 'TEST' });
    expect((await call(sim, '/builder-account-mode', { builder: BUILDER })).out.value).toMatchObject({
      mode: { known: true, value: 'unified' },
      required: { known: true, value: 'standard' },
    });
    expect((await call(sim, '/builder-account-mode', { builder: OTHER })).out.value).toMatchObject({ mode: { value: 'standard' } });
    // Another switch on the same account leaves its mode as it is.
    expect((await call(sim, '/test/account-switches', { owner: BUILDER, loseAnswers: 0 })).out).toMatchObject({ accountMode: 'unified' });
    await call(sim, '/test/account-switches', { owner: BUILDER, accountMode: 'portfolio_margin' });
    expect((await call(sim, '/builder-account-mode', { builder: BUILDER })).out.value).toMatchObject({
      mode: { value: 'portfolio_margin' },
    });
    await call(sim, '/test/account-switches', { owner: BUILDER, accountMode: 'standard' });
    expect((await call(sim, '/builder-account-mode', { builder: BUILDER })).out.value).toMatchObject({ mode: { value: 'standard' } });
  });

  it('refuses a mode outside the closed set', async () => {
    const sim = new TestVenueSimulator({ clock: () => AT, markets: TEST_VENUE_MARKETS });
    for (const accountMode of ['Standard', 'cross', 1, null]) {
      const { status, out } = await call(sim, '/test/account-switches', { owner: BUILDER, accountMode });
      expect(status, JSON.stringify(accountMode)).toBe(400);
      expect(String(out.error)).toContain('accountMode is one of');
    }
    expect((await call(sim, '/builder-account-mode', { builder: BUILDER })).out.value).toMatchObject({ mode: { value: 'standard' } });
  });

  it('the venue switch leaves the requirement unpublished, and back', async () => {
    const sim = new TestVenueSimulator({ clock: () => AT, markets: TEST_VENUE_MARKETS });
    expect((await call(sim, '/test/switches', { builderModeRequirementUnpublished: true })).out).toMatchObject({
      builderModeRequirementUnpublished: true,
    });
    expect((await call(sim, '/builder-account-mode', { builder: BUILDER })).out.value).toMatchObject({ required: { known: false } });
    expect((await call(sim, '/test/switches', { builderModeRequirementUnpublished: 'yes' })).status).toBe(400);
    await call(sim, '/test/switches', { builderModeRequirementUnpublished: false });
    expect((await call(sim, '/builder-account-mode', { builder: BUILDER })).out.value).toMatchObject({
      required: { known: true, value: 'standard' },
    });
  });

  it("the address's down switch refuses its mode read venue_down; another address still reads", async () => {
    const sim = new TestVenueSimulator({ clock: () => AT, markets: TEST_VENUE_MARKETS });
    await call(sim, '/test/account-switches', { owner: BUILDER, down: true });
    const down = await call(sim, '/builder-account-mode', { builder: BUILDER });
    expect(down.status).toBe(422);
    expect(down.out).toMatchObject({ refusal: { code: 'venue_down' } });
    expect((await call(sim, '/builder-account-mode', { builder: OTHER })).status).toBe(200);
    await call(sim, '/test/account-switches', { owner: BUILDER, down: false });
    expect((await call(sim, '/builder-account-mode', { builder: BUILDER })).status).toBe(200);
  });
});
