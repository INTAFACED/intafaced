import { describe, expect, it } from 'vitest';
import { ageWords, badgeSnippets, checkDefinition, readDefinition, readingFor } from './status-model';

const draft = (over: Partial<Parameters<typeof checkDefinition>[0]> = {}) => ({
  components: [{ id: 'card-network', name: 'Card network', group: '', source: ' TEST card scheme ' }],
  componentCap: '5',
  stalenessSeconds: '',
  uptimeDays: '7',
  reason: 'TEST',
  ...over,
});

describe('status page desk model', () => {
  it('a blank owner value is sent as cleared, never as a number', () => {
    const check = checkDefinition(draft(), 4);
    expect(check).toEqual({
      ok: true,
      body: {
        components: [{ id: 'card-network', name: 'Card network', group: null, source: 'TEST card scheme' }],
        componentCap: 5,
        stalenessSeconds: null,
        uptimeDays: 7,
        expectedRevision: 4,
        reason: 'TEST',
      },
    });
  });

  it('refuses a bad id, a repeated id, an out-of-range value and a missing reason before sending', () => {
    expect(checkDefinition(draft({ components: [{ id: 'Card', name: 'x', group: '', source: '' }] }), 0)).toMatchObject({ ok: false });
    const twice = { id: 'trading', name: 'Trading', group: '', source: '' };
    expect(checkDefinition(draft({ components: [twice, twice] }), 0)).toMatchObject({ ok: false, why: expect.stringContaining('twice') });
    expect(checkDefinition(draft({ uptimeDays: '91' }), 0)).toMatchObject({ ok: false });
    expect(checkDefinition(draft({ componentCap: '2.5' }), 0)).toMatchObject({ ok: false });
    expect(checkDefinition(draft({ reason: '  ' }), 0)).toMatchObject({ ok: false });
  });

  it('enters a reading by hand only for a component with an outside source', () => {
    const at = new Date('2026-10-23T12:00:00.000Z');
    expect(readingFor({ id: 'trading', name: 'Trading', group: null, source: null }, 'degraded', at)).toBeNull();
    expect(readingFor({ id: 'card-network', name: 'Card network', group: null, source: 'TEST card scheme' }, 'degraded', at)).toEqual({
      componentId: 'card-network',
      state: 'degraded',
      observedAt: '2026-10-23T12:00:00.000Z',
      source: 'TEST card scheme',
    });
  });

  it('says how old a reading is from the read time, never negative', () => {
    expect(ageWords('2026-10-23T11:58:00.000Z', '2026-10-23T12:00:00.000Z')).toBe('2 min ago');
    expect(ageWords('2026-10-23T12:00:30.000Z', '2026-10-23T12:00:00.000Z')).toBe('0 s ago');
    expect(ageWords('nonsense', '2026-10-23T12:00:00.000Z')).toBe('at an unknown time');
  });

  it('builds badge links on the public address and escapes the snippet', () => {
    const s = badgeSnippets('https://site.example/', 'card-network', 'Card "network" <x>');
    expect(s.image).toBe('https://site.example/api/notify/status/badge.svg?component=card-network');
    expect(s.page).toBe('https://site.example/status');
    expect(s.html).toBe(
      '<a href="https://site.example/status"><img src="https://site.example/api/notify/status/badge.svg?component=card-network" alt="Card &quot;network&quot; &lt;x> status"></a>',
    );
    expect(badgeSnippets('https://site.example', null, 'Platform').image).toBe('https://site.example/api/notify/status/badge.svg');
  });

  it('reads only the definition shape svc-notify answers', () => {
    const good = {
      components: [],
      componentCap: null,
      stalenessSeconds: null,
      uptimeDays: null,
      challengeBits: null,
      subscribeRatePerHour: null,
      revision: 0,
      updatedAt: null,
      publicOrigin: null,
    };
    expect(readDefinition(good)).toEqual(good);
    expect(readDefinition({ ...good, componentCap: '5' })).toBeNull();
    expect(readDefinition({ ...good, components: [{ id: 'x' }] })).toBeNull();
    expect(readDefinition(null)).toBeNull();
  });
});
