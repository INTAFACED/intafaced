import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LabPage } from './LabPage';

// SP-pages-01: the Lab is its own screen. With no owner decision and no entries it names that reason and lists nothing.
describe('/lab', () => {
  it('names the owner decision and shows no entry and no campaign copy', () => {
    const html = renderToString(<LabPage />);
    expect(html).toContain('data-room="lab"');
    expect(html).toContain('<h1>Lab</h1>');
    expect(html).toContain('No Lab entry is published');
    expect(html).toContain('data-not-connected="owner.decision"');
    expect(html).not.toMatch(/campaign/i);
    expect(html).not.toContain('/uc/promotion');
    expect(html).not.toContain('<li');
  });
  it('a detail address with no published entry says so and links back', () => {
    const html = renderToString(<LabPage detail />);
    expect(html).toContain('This Lab entry is not published');
    expect(html).toContain('href="/lab"');
    expect(html).toContain('data-not-connected="owner.decision"');
  });
});
