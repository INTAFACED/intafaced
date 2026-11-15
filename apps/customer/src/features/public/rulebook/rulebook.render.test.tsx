import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RulebookView } from './RulebookRoom';
import { rulebookCurrentSchema, rulebookHistorySchema, type Rulebook } from './rulebook-data';

// RC-cex-spot-08 / J-cex-spot-20 #6: the rulebook in force, section by section, with its version and effective time, a
// published future version, and the history. TEST text only.
const TITLES = ['participation', 'matching', 'cancellation', 'settlement', 'liquidation', 'fees', 'market data'];
const sections = (tag: string) => TITLES.map((title) => ({ id: title.replace(' ', '_'), title, body: `TEST ${title} rules for ${tag}.` }));

const published: Rulebook = {
  current: {
    published: true,
    version: 'TEST-v1',
    effectiveAt: '2026-11-06T12:00:00.000Z',
    publishedAt: '2026-11-06T12:00:00.000Z',
    sections: sections('TEST-v1'),
    upcoming: [{ version: 'TEST-v2', effectiveAt: '2026-11-13T12:00:00.000Z' }],
  },
  history: {
    current: 'TEST-v1',
    versions: [
      {
        version: 'TEST-v2',
        status: 'upcoming',
        effectiveAt: '2026-11-13T12:00:00.000Z',
        publishedAt: '2026-11-06T13:00:00.000Z',
        supersedes: 'TEST-v1',
        changedSections: ['fees'],
        sections: sections('TEST-v2'),
      },
      {
        version: 'TEST-v1',
        status: 'current',
        effectiveAt: '2026-11-06T12:00:00.000Z',
        publishedAt: '2026-11-06T12:00:00.000Z',
        supersedes: null,
        changedSections: TITLES.map((t) => t.replace(' ', '_')),
        sections: sections('TEST-v1'),
      },
    ],
  },
};

describe('/rulebook', () => {
  it('shows each section of the version in force with its version and effective time', () => {
    const html = renderToString(<RulebookView load={{ status: 'ready', data: published, asOf: 0 }} />);
    expect(html).toContain('data-rulebook-version="true">TEST-v1<');
    expect(html).toContain('dateTime="2026-11-06T12:00:00.000Z"');
    for (const t of TITLES) expect(html).toContain(`data-section="${t}"`);
    expect(html).toContain('TEST market data rules for TEST-v1.');
    expect(html).toContain('Version TEST-v2 takes effect on');
    expect(html).toContain('data-version="TEST-v2" data-status="upcoming"');
    expect(html).toContain('Changed: fees');
  });

  it('renders a section body as escaped text', () => {
    const data: Rulebook = {
      ...published,
      current: {
        ...published.current,
        sections: [{ id: 'fees', title: 'fees', body: '<script>alert(1)</script>' }],
      } as Rulebook['current'],
    };
    const html = renderToString(<RulebookView load={{ status: 'ready', data, asOf: 0 }} />);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('says no rulebook is published, and shows no rule text, when none is', () => {
    const data: Rulebook = {
      current: { published: false, version: null, rejected: { code: 'matching.rulebook_unpublished' }, upcoming: [] },
      history: { current: null, versions: [] },
    };
    const html = renderToString(<RulebookView load={{ status: 'ready', data, asOf: 0 }} />);
    expect(html).toContain('No trading rulebook is published');
    expect(html).not.toContain('data-section=');
    expect(html).not.toContain('data-rulebook-version');
  });

  it('says the rulebook did not load when the service did not answer', () => {
    const html = renderToString(<RulebookView load={{ status: 'error', retry: () => {} }} />);
    expect(html).toContain('The rulebook did not load');
    expect(html).not.toContain('data-section=');
  });

  it('reads the services’ answers with its schemas', () => {
    expect(rulebookCurrentSchema.safeParse(published.current).success).toBe(true);
    expect(rulebookHistorySchema.safeParse(published.history).success).toBe(true);
    expect(
      rulebookCurrentSchema.safeParse({
        published: false,
        version: null,
        rejected: { code: 'matching.rulebook_unpublished', message: 'x' },
        upcoming: [],
      }).success,
    ).toBe(true);
  });
});
