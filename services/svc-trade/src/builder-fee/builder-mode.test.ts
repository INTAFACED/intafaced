import { describe, expect, it } from 'vitest';
import { VenueRefusalError, type UserVenue } from '@intafaced/venue-contracts';
import { TEST_VENUE_MARKETS, TestVenueSimulator, startTestVenueServer } from '@intafaced/venue-sim';
import { HttpUserVenue } from '../venue/http-user-venue.js';
import { partial } from '@intafaced/service-kit/testing';
import { BuilderModeError, checkBuilderModes, parseAlertContact, type BuilderModeAlert, type BuilderModeDeps } from './builder-mode.js';
import { MemoryBuilderModeAlertStore } from './builder-mode-store.js';

// J-ops-console-28: our builder address's mode at each TEST venue, beside the mode the venue requires to accrue builder
// fees, and one alert per episode out of it to the owner's named contact. Every venue here is the TEST simulator.

const BUILDER = '0x116d8f7751e72306d499dd61ae826e46a726c632';
const CONTACT = 'TEST founders on call (oncall@intafaced.test)';
let clock = new Date(Date.UTC(2026, 10, 21, 3));

function world(opts: { contact?: string | null; venues?: number } = {}) {
  const sims = Array.from(
    { length: opts.venues ?? 2 },
    (_, i) =>
      new TestVenueSimulator({ id: `test-venue-${i}`, displayName: `TEST venue ${i}`, clock: () => clock, markets: TEST_VENUE_MARKETS }),
  );
  for (const sim of sims) setMode(sim, 'standard');
  const store = new MemoryBuilderModeAlertStore();
  const opened: BuilderModeAlert[] = [];
  const cleared: BuilderModeAlert[] = [];
  const deps: BuilderModeDeps = {
    doors: sims.map((sim) => ({ venue: async (): Promise<UserVenue> => sim, connectedVenueId: sim.venue.id })),
    builder: BUILDER,
    contact: opts.contact === undefined ? CONTACT : opts.contact,
    store,
    onOpened: (a) => opened.push(a),
    onCleared: (a) => cleared.push(a),
    now: () => clock,
  };
  return { sims, store, opened, cleared, deps };
}
/** The TEST control J-derivatives-29 moves an account's mode by; our builder address is its main account. */
function setMode(sim: TestVenueSimulator, mode: 'standard' | 'unified' | 'portfolio_margin'): void {
  sim.testAccountMode({ venueId: sim.venue.id, owner: BUILDER, subAccount: null }, { mode });
}
const tick = (ms = 1000) => (clock = new Date(clock.getTime() + ms));

describe('checkBuilderModes', () => {
  it('reads each venue: the mode as the venue reports it with its time, beside the required mode', async () => {
    const { deps, store } = world();
    const check = await checkBuilderModes(deps);
    expect(check.venues).toEqual(
      [0, 1].map((i) => ({
        venueId: `test-venue-${i}`,
        displayName: `TEST venue ${i}`,
        test: true,
        builder: BUILDER,
        mode: { status: 'read', mode: 'standard', asOf: clock },
        required: { status: 'published', mode: 'standard' },
        verdict: 'required_mode',
      })),
    );
    expect(check.alerting).toEqual({ status: 'on', contact: CONTACT });
    expect(store.rows).toEqual([]);
  });

  it('out of the required mode: not_collected, and one alert to the contact however many checks see it', async () => {
    const { deps, sims, store, opened } = world();
    setMode(sims[0]!, 'unified');
    for (let i = 0; i < 5; i++) {
      tick();
      const check = await checkBuilderModes(deps);
      expect(check.venues.map((v) => v.verdict)).toEqual(['not_collected', 'required_mode']);
    }
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      venueId: 'test-venue-0',
      builder: BUILDER,
      modeSeen: 'unified',
      requiredMode: 'standard',
      contact: CONTACT,
      clearedAt: null,
    });
    expect(opened).toHaveLength(1);
  });

  it('concurrent checks open one alert', async () => {
    const { deps, sims, store, opened } = world();
    setMode(sims[1]!, 'portfolio_margin');
    await Promise.all(Array.from({ length: 8 }, () => checkBuilderModes(deps)));
    expect(store.rows.filter((r) => r.venueId === 'test-venue-1')).toHaveLength(1);
    expect(opened).toHaveLength(1);
  });

  it('back in the required mode clears the alert with the time and mode, once; a new episode opens a new one', async () => {
    const { deps, sims, store, cleared } = world();
    setMode(sims[0]!, 'unified');
    await checkBuilderModes(deps);
    setMode(sims[0]!, 'standard');
    const at = tick(5000);
    await checkBuilderModes(deps);
    tick();
    await checkBuilderModes(deps);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ clearedAt: at, clearedMode: 'standard' });
    expect(cleared).toHaveLength(1);
    setMode(sims[0]!, 'unified');
    tick();
    await checkBuilderModes(deps);
    expect(store.rows).toHaveLength(2);
    expect((await store.recent(10)).map((r) => r.clearedAt === null)).toEqual([true, false]);
  });

  it('a mode that cannot be read is unknown, never ok, and neither opens nor clears an alert', async () => {
    const { deps, sims, store } = world();
    setMode(sims[0]!, 'unified');
    await checkBuilderModes(deps);
    setMode(sims[0]!, 'standard');
    sims[0]!.switches.venueDown = true;
    const down = await checkBuilderModes(deps);
    expect(down.venues[0]).toMatchObject({
      mode: { status: 'unknown', code: 'venue_down' },
      required: { status: 'unknown' },
      verdict: 'unknown',
    });
    expect(store.rows[0]!.clearedAt).toBeNull();
    // A venue whose door can't be reached at all, and one whose adapter reads no mode, are unknown rows of their own.
    const unreachable = await checkBuilderModes({
      ...deps,
      doors: [
        {
          venue: () => Promise.reject(new VenueRefusalError({ venueId: 'gone', code: 'venue_down', detail: 'TEST: no answer' })),
          connectedVenueId: null,
        },
        {
          venue: async () => partial<UserVenue>({ venue: sims[1]!.venue }),
          connectedVenueId: 'test-venue-1',
        },
      ],
    });
    expect(unreachable.venues).toMatchObject([
      { venueId: 'unreachable', mode: { status: 'unknown', code: 'venue_down' }, verdict: 'unknown' },
      { venueId: 'test-venue-1', mode: { status: 'unknown', code: 'trade.builder_mode_not_read' }, verdict: 'unknown' },
    ]);
    expect(store.rows).toHaveLength(1);
  });

  it('a mode the venue does not report is unknown', async () => {
    const { deps, sims } = world({ venues: 1 });
    const sim = sims[0]!;
    const notReported = {
      venue: async () =>
        partial<UserVenue>({
          venue: sim.venue,
          builderAccountMode: async () => ({
            venueId: sim.venue.id,
            value: { builder: BUILDER, mode: { known: false }, required: { known: true, value: 'standard' } },
            asOf: clock,
          }),
        }),
      connectedVenueId: sim.venue.id,
    };
    const check = await checkBuilderModes({ ...deps, doors: [notReported] });
    expect(check.venues[0]).toMatchObject({ mode: { status: 'unknown', code: 'trade.builder_mode_not_reported' }, verdict: 'unknown' });
  });

  it('a venue that publishes no required mode reads not_published and opens nothing', async () => {
    const { deps, sims, store } = world({ venues: 1 });
    sims[0]!.switches.builderModeRequirementUnpublished = true;
    setMode(sims[0]!, 'unified');
    const check = await checkBuilderModes(deps);
    expect(check.venues[0]).toMatchObject({
      mode: { status: 'read', mode: 'unified' },
      required: { status: 'not_published' },
      verdict: 'not_published',
    });
    expect(store.rows).toEqual([]);
  });

  it('a blank contact still shows the modes, refuses alerting by name, and records no alert', async () => {
    const { deps, sims, store, opened } = world({ contact: parseAlertContact('   ') });
    setMode(sims[0]!, 'unified');
    const check = await checkBuilderModes(deps);
    expect(check.venues[0]!.verdict).toBe('not_collected');
    expect(check.alerting).toMatchObject({ status: 'refused', code: 'trade.builder_mode_alert_contact_unset' });
    expect(store.rows).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('refuses typed with no venue door or no builder address', async () => {
    const { deps } = world();
    await expect(checkBuilderModes({ ...deps, doors: [] })).rejects.toMatchObject({ code: 'trade.user_venue_off' });
    await expect(checkBuilderModes({ ...deps, builder: null })).rejects.toBeInstanceOf(BuilderModeError);
    await expect(checkBuilderModes({ ...deps, builder: null })).rejects.toMatchObject({ code: 'trade.builder_address_unset' });
  });
});

describe('checkBuilderModes over HTTP to the TEST venue server', () => {
  it('reads the mode and the requirement through the HTTP client, and the down switch reads unknown', async () => {
    const { server, sim, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 });
    try {
      const store = new MemoryBuilderModeAlertStore();
      const deps: BuilderModeDeps = {
        doors: [{ venue: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 }), connectedVenueId: null }],
        builder: BUILDER,
        contact: CONTACT,
        store,
        onOpened: () => {},
        onCleared: () => {},
        now: () => new Date(),
      };
      setMode(sim, 'unified');
      const out = await checkBuilderModes(deps);
      expect(out.venues[0]).toMatchObject({
        venueId: sim.venue.id,
        mode: { status: 'read', mode: 'unified' },
        required: { status: 'published', mode: 'standard' },
        verdict: 'not_collected',
      });
      expect(out.venues[0]!.mode.status === 'read' && out.venues[0]!.mode.asOf instanceof Date).toBe(true);
      expect(store.rows).toHaveLength(1);
      await fetch(`${url}/test/account-switches`, { method: 'POST', body: JSON.stringify({ owner: BUILDER, down: true }) });
      expect((await checkBuilderModes(deps)).venues[0]).toMatchObject({
        mode: { status: 'unknown', code: 'venue_down' },
        verdict: 'unknown',
      });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
