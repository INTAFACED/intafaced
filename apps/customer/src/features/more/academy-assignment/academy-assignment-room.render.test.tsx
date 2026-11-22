import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Server rendering has no browser store to subscribe to, so the preferences hook answers with the stored defaults.
vi.mock('../../../shared/preferences', async (original) => {
  const real = await original<typeof import('../../../shared/preferences')>();
  return { ...real, usePreferences: () => real.currentPreferences() };
});

import { SessionProvider } from '../../session';
import { AcademyAssignmentRoom } from './AcademyAssignmentRoom';

const html = (node: React.ReactNode) => renderToStaticMarkup(<SessionProvider>{node}</SessionProvider>);

describe('the assignment room on the flow template', () => {
  it('keeps the Academy title, its sections as links with Learning open, and refuses an address that is no assignment', () => {
    const out = html(<AcademyAssignmentRoom slug="risk-basics" itemId="not-a-guid" />);
    expect(out).toContain('data-template="flow"');
    expect(out).toMatch(/<h1[^>]*>Academy<\/h1>/);
    expect(out).toContain('Learn, practise and join hosted sessions');
    for (const href of ['/academy/learning', '/academy/certificates', '/academy/rooms', '/academy/videos', '/academy/programmes'])
      expect(out).toContain(`href="${href}"`);
    expect(out).toMatch(/href="\/academy\/learning" class="lt-tab" aria-current="page"/);
    expect(out).toContain('data-academy-assignment="not-a-guid"');
    expect(out).toMatch(/data-testid="assignment-outcome" data-code="academy.assignment_not_found"/);
  });

  it('draws the room loading while the assignment is read', () => {
    const out = html(<AcademyAssignmentRoom slug="risk-basics" itemId="0f8fad5b-d9cb-469f-a165-70867728950e" />);
    expect(out).toContain('data-state="loading"');
  });
});
