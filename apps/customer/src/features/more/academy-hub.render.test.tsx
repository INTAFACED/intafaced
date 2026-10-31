import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SessionProvider } from '../session/session';
import { FeaturedLessonCard } from './AcademyHub';

const html = (node: React.ReactNode) => renderToStaticMarkup(<SessionProvider>{node}</SessionProvider>);

describe('the Learn hub featured lesson (AC-articles-01)', () => {
  it('names the lesson and its course, and opens the course page only while the course is published', () => {
    const open = html(<FeaturedLessonCard lesson={{ title: 'Position size', courseTitle: 'Risk basics', courseSlug: 'risk-basics' }} />);
    expect(open).toContain('Position size');
    expect(open).toContain('A lesson from the course Risk basics.');
    expect(open).toMatch(/<a [^>]*href="\/academy\/learning\/course\/risk-basics"[^>]*><span[^>]*>Open the course<\/span><\/a>/);

    const draft = html(<FeaturedLessonCard lesson={{ title: 'Position size', courseTitle: 'Risk basics', courseSlug: null }} />);
    expect(draft).toContain('A lesson from the course Risk basics.');
    expect(draft).toContain('Its course is a draft, closed to learners, so there is no course page to open.');
    expect(draft).not.toContain('<a ');
  });
});
