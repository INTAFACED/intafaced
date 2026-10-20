import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});
import { findRoom } from '../../app/navigation';
import { ChangelogList, UpcomingView } from './ChangelogPages';
import { StatusView } from './StatusPage';
import { developersRoute } from './developers-model';
import { entrySchema, statusFeedSchema, type ChangelogEntry, type StatusFeed } from './developers-api';

const entry = (over: Partial<ChangelogEntry> & { log?: Partial<NonNullable<ChangelogEntry['changelog']>> | null }): ChangelogEntry => {
  const { log, ...rest } = over;
  return entrySchema.parse({
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'changelog',
    title: 'Test change',
    body: 'Test body',
    status: 'published',
    publishedAt: '2026-10-17T12:00:00.000Z',
    startsAt: null,
    endsAt: null,
    version: 1,
    changelog:
      log === null
        ? null
        : {
            area: 'trading',
            breaking: false,
            endpoints: [],
            scopes: [],
            addedOn: null,
            releaseOn: null,
            before: null,
            after: null,
            migrationNote: null,
            retired: [],
            ...log,
          },
    ...rest,
  });
};

const feed = (over: Partial<StatusFeed> = {}): StatusFeed =>
  statusFeedSchema.parse({
    asOf: '2026-10-17T12:00:00.000Z',
    components: [
      { component: 'api', state: 'unknown', basis: 'no_measurement', since: null },
      { component: 'webhooks', state: 'degraded', basis: 'incident', since: '2026-10-17T10:00:00.000Z' },
      { component: 'console', state: 'unknown', basis: 'no_measurement', since: null },
    ],
    incidents: [],
    maintenance: [],
    history: { basis: 'incident_notices_only', days: [] },
    ...over,
  });

describe('developer status and changelog routes', () => {
  it('reads the three new addresses and keeps unknown sub-paths unknown', () => {
    expect(developersRoute('/developers/status')).toEqual({ kind: 'status' });
    expect(developersRoute('/developers/changelog')).toEqual({ kind: 'changelog' });
    expect(developersRoute('/developers/changelog/upcoming/')).toEqual({ kind: 'upcoming' });
    expect(developersRoute('/developers/status/extra')).toEqual({ kind: 'unknown' });
    for (const path of ['/developers/status', '/developers/changelog', '/developers/changelog/upcoming'])
      expect(findRoom(path)?.area).toBe('public');
  });
});

describe('status page', () => {
  it('reads a component nobody measures as not measured, never as operational, and says why', () => {
    const html = renderToString(<StatusView feed={feed()} />);
    expect(html).toContain('Not measured');
    expect(html).toContain('Nothing in this build checks this component');
    expect(html).not.toMatch(/operational/i);
    expect(html).toContain('Degraded');
    expect(html).toContain('No incident has been published.');
    expect(html).toContain('not an uptime figure');
    expect(html).not.toMatch(/%/);
  });

  it('shows an open incident with its update timeline and the incident minutes by day', () => {
    const html = renderToString(
      <StatusView
        feed={feed({
          incidents: [
            {
              id: 'i1',
              title: 'Test incident',
              impact: 'major',
              components: ['api'],
              openedAt: '2026-10-17T10:00:00.000Z',
              resolvedAt: null,
              updates: [{ id: 'i1', body: 'First update', impact: 'major', publishedAt: '2026-10-17T10:00:00.000Z', resolves: false }],
            },
          ],
          history: {
            basis: 'incident_notices_only',
            days: [{ date: '2026-10-17', components: [{ component: 'api', incidentMinutes: 90, worstImpact: 'major' }] }],
          },
        })}
      />,
    );
    expect(html).toContain('data-incident-state="open"');
    expect(html).toContain('First update');
    expect(html).toContain('90 min');
  });

  it('says a maintenance window with no time reads time not set', () => {
    const html = renderToString(
      <StatusView feed={feed({ maintenance: [{ id: 'm1', title: 'Test window', components: ['api'], startsAt: null, endsAt: null }] })} />,
    );
    expect(html).toContain('time not set');
  });
});

describe('changelog pages', () => {
  it('shows area, the breaking flag, both dates and the example and migration note', () => {
    const html = renderToString(
      <ChangelogList
        entries={[
          entry({
            log: {
              area: 'wallet',
              breaking: true,
              releaseOn: '2026-11-01',
              before: 'GET /old',
              after: 'GET /new',
              migrationNote: 'Call the new path.',
              retired: ['/v1/old'],
            },
          }),
        ]}
      />,
    );
    expect(html).toContain('Wallet');
    expect(html).toContain('data-breaking="true"');
    expect(html).toContain('In effect 2026-11-01');
    expect(html).toContain('Added date not set');
    expect(html).toContain('GET /new');
    expect(html).toContain('Call the new path.');
    expect(html).toContain('/v1/old');
  });

  it('reads an entry with no date as date not set and an old entry with no fields without an area', () => {
    const html = renderToString(
      <ChangelogList
        entries={[entry({ log: { breaking: true, migrationNote: 'n' } }), entry({ log: null, id: '22222222-2222-4222-8222-222222222222' })]}
      />,
    );
    expect(html).toContain('In effect date not set');
    expect(html).toContain('No area');
  });

  it('says so when nothing matches, on the upcoming page too, and lists a retired endpoint with its date', () => {
    expect(renderToString(<ChangelogList entries={[]} />)).toContain('No changelog entry matches.');
    const empty = renderToString(<UpcomingView data={{ upcoming: [], retired: [] }} />);
    expect(empty).toContain('No breaking change with a date is announced.');
    expect(empty).toContain('No endpoint has been retired.');
    const html = renderToString(
      <UpcomingView
        data={{
          upcoming: [],
          retired: [{ endpoint: '/v1/old', entryId: '11111111-1111-4111-8111-111111111111', title: 'Test change', releaseOn: null }],
        }}
      />,
    );
    expect(html).toContain('/v1/old');
    expect(html).toContain('Retired by Test change');
    expect(html).toContain('date not set');
  });
});
