import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ok, refused } from '@/lib/trade-ops/outcome';
import { RULEBOOK_SECTIONS, parseRulebookCheck, parseRulebookHistory, parseRulebookPublish } from '@/lib/trade-ops/rulebook-model';
import { RulebookRoom } from './rulebook-room';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

// RC-cex-spot-08 / J-cex-spot-20 #6: the version in force, its history and the form for a new version. TEST text only.
const sections = RULEBOOK_SECTIONS.map((s) => ({ id: s.id, title: s.title, body: `TEST ${s.title}.` }));
const history = {
  current: 'TEST-v1',
  versions: [
    {
      version: 'TEST-v2',
      status: 'upcoming' as const,
      effectiveAt: '2026-11-13T12:00:00.000Z',
      publishedAt: '2026-11-06T13:00:00.000Z',
      supersedes: 'TEST-v1',
      changedSections: ['fees'],
      sections,
    },
    {
      version: 'TEST-v1',
      status: 'current' as const,
      effectiveAt: '2026-11-06T12:00:00.000Z',
      publishedAt: '2026-11-06T12:00:00.000Z',
      supersedes: null,
      changedSections: RULEBOOK_SECTIONS.map((s) => s.id),
      sections,
    },
  ],
};

describe('rulebook room', () => {
  it('shows the version in force, every version, and a field for each fixed section', () => {
    const html = renderToStaticMarkup(<RulebookRoom initial={{ history: ok(history), asOf: '2026-11-06T12:00:00.000Z' }} />);
    expect(html).toContain('data-room="rulebook"');
    expect(html).toMatch(/data-current-version="(?:true)?">TEST-v1</);
    expect(html).toContain('data-version="TEST-v2" data-status="upcoming"');
    expect(html).toContain('Replaces TEST-v1; changed: fees');
    expect(html).toContain('aria-label="Publish a rulebook version"');
    for (const s of RULEBOOK_SECTIONS) expect(html).toContain(`Section: ${s.title}`);
    expect(html).toContain('Propose version');
    // Nothing is filed until svc-matching accepts the draft and identity files the request.
    expect(html).not.toContain('data-filed');
  });

  it('says no version is in force when none is, and shows a refused read as refused', () => {
    const none = renderToStaticMarkup(<RulebookRoom initial={{ history: ok({ current: null, versions: [] }), asOf: '' }} />);
    expect(none).toContain('No version is in force');
    expect(none).not.toContain('data-current-version');
    const down = renderToStaticMarkup(
      <RulebookRoom initial={{ history: refused('trade.rulebook_unavailable', 'not readable', 503), asOf: '' }} />,
    );
    expect(down).toContain('trade.rulebook_unavailable');
  });

  it('reads svc-matching’s answers: an accepted check, its own refusal code, and a publish', () => {
    expect(parseRulebookHistory(history)).toEqual(history);
    expect(parseRulebookHistory({ current: null })).toBeNull();
    expect(
      parseRulebookCheck({
        accepted: true,
        version: 'TEST-v1',
        digest: 'sha256:a',
        actionType: 'matching.rulebook_publish',
        targetId: 'rulebook_publish:TEST-v1',
        payloadHash: 'sha256:b',
      }),
    ).toMatchObject({ accepted: true, data: { targetId: 'rulebook_publish:TEST-v1', payloadHash: 'sha256:b' } });
    expect(
      parseRulebookCheck({ accepted: false, rejected: { code: 'matching.rulebook_section_unset', message: 'the fees section is blank' } }),
    ).toEqual({
      accepted: false,
      code: 'matching.rulebook_section_unset',
      message: 'the fees section is blank',
    });
    expect(parseRulebookPublish({ accepted: true, version: 'TEST-v1', alreadyPublished: false })).toEqual({
      accepted: true,
      data: { version: 'TEST-v1', alreadyPublished: false },
    });
  });
});
